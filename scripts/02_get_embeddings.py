import argparse
import asyncio
import json
import os
import sys
import glob
import re
from itertools import islice
from typing import List, Optional

import httpx
import numpy as np
from numpy.lib.format import open_memmap
from openai import AsyncOpenAI, APIError, RateLimitError, InternalServerError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from tqdm.asyncio import tqdm

# Configuration Defaults
DEFAULT_INPUT = "wikipedia_intros.jsonl"
DEFAULT_OUTPUT_PREFIX = "embeddings/wiki"
FAILURE_LOG = "embedding_failures.jsonl"
MODEL = "Qwen/Qwen3-Embedding-8B"
MAX_CONCURRENT_REQUESTS = 200
BATCH_SIZE = 1024

def parse_args():
    parser = argparse.ArgumentParser(description="Generate embeddings using DeepInfra")
    parser.add_argument("--input", default=DEFAULT_INPUT, help="Input JSONL file")
    parser.add_argument("--output", default=DEFAULT_OUTPUT_PREFIX, help="Output prefix for .npy and .json files")
    parser.add_argument("--skip-merge", action="store_true", help="Skip merging files at the end")
    return parser.parse_args()

args = parse_args()

API_KEY = os.getenv("DEEPINFRA_TOKEN")
if not API_KEY:
    print("Error: DEEPINFRA_TOKEN environment variable is not set.", file=sys.stderr)
    sys.exit(1)

# Configure limits to keep connections warm
# We allow more connections than the semaphore to account for handshake overhead
limits = httpx.Limits(
    max_connections=MAX_CONCURRENT_REQUESTS + 50, 
    max_keepalive_connections=MAX_CONCURRENT_REQUESTS + 50
)
http_client = httpx.AsyncClient(limits=limits)

client = AsyncOpenAI(
    api_key=API_KEY,
    base_url="https://api.deepinfra.com/v1/openai",
    http_client=http_client
)

def chunked_iterable(iterable, size):
    it = iter(iterable)
    while True:
        chunk = list(islice(it, size))
        if not chunk:
            break
        yield chunk

# Retry on both Network issues AND API errors (429, 5xx)
@retry(
    retry=retry_if_exception_type((
        httpx.RequestError, 
        httpx.ConnectError, 
        httpx.TimeoutException,
        RateLimitError, 
        InternalServerError,
        APIError
    )),
    wait=wait_exponential(multiplier=1, min=2, max=20),
    stop=stop_after_attempt(5)
)
async def _api_call(texts: List[str], semaphore: asyncio.Semaphore):
    async with semaphore:
        response = await client.embeddings.create(
            model=MODEL,
            input=texts,
            encoding_format="float"
        )
        return [data.embedding for data in response.data], response.usage.prompt_tokens

async def recursive_fetch_safe(texts: List[str], ids: List[str], semaphore: asyncio.Semaphore, depth: int = 0) -> tuple[List[List[float]], int]:
    """
    Recursively attempts to fetch embeddings.
    If a batch fails, splits it in half and tries again in PARALLEL.
    Returns (embeddings_list, total_tokens)
    """
    try:
        return await _api_call(texts, semaphore)
    except Exception as e:
        # If we are down to a single item and it still fails, it's a bad input.
        if len(texts) <= 1:
            error_msg = f"ID: {ids[0]} | Error: {e}"
            print(f"\n[Error] {error_msg}", file=sys.stderr)
            
            # Log to failure file
            try:
                with open(FAILURE_LOG, "a", encoding="utf-8") as f:
                    entry = {
                        "id": ids[0],
                        "error": str(e),
                        "text_preview": texts[0][:500],
                        "text_len": len(texts[0])
                    }
                    f.write(json.dumps(entry) + "\n")
            except Exception as log_e:
                print(f"Failed to write to log: {log_e}", file=sys.stderr)

            # Return a zero vector
            return [ [0.0] * 4096 ], 0
        
        # Otherwise, split and conquer
        mid = len(texts) // 2
        
        l_texts = texts[:mid]
        l_ids = ids[:mid]
        
        r_texts = texts[mid:]
        r_ids = ids[mid:]
        
        if depth > 0:
            print(f"  > Split depth {depth}: {len(texts)} -> {len(l_texts)} + {len(r_texts)}", file=sys.stderr)

        # Run both halves in PARALLEL
        results = await asyncio.gather(
            recursive_fetch_safe(l_texts, l_ids, semaphore, depth + 1),
            recursive_fetch_safe(r_texts, r_ids, semaphore, depth + 1)
        )
        
        l_res, l_tok = results[0]
        r_res, r_tok = results[1]
        
        return l_res + r_res, l_tok + r_tok

async def fetch_embeddings(raw_lines: List[str], batch_index: int, output_prefix: str, semaphore: asyncio.Semaphore):
    # OPTIMIZATION: Parse JSON here
    batch_data = [json.loads(line) for line in raw_lines]
    
    texts = [doc['intro'] for doc in batch_data]
    ids = [doc['id'] for doc in batch_data]
    sanitized_texts = [t if t.strip() else " " for t in texts]

    try:
        # Pass semaphore down, don't hold it here
        embeddings, tokens = await recursive_fetch_safe(sanitized_texts, ids, semaphore)
        
        # Save files
        npy_filename = f"{output_prefix}_{batch_index}.npy"
        meta_filename = f"{output_prefix}_{batch_index}_meta.json"
        
        np.save(npy_filename, np.array(embeddings, dtype=np.float32))
        
        # Save IDs and Token Usage
        with open(meta_filename, 'w') as f:
            json.dump({"ids": ids, "usage": tokens}, f)
            
        return tokens

    except Exception as e:
        print(f"Batch {batch_index} failed FATALLY: {e}", file=sys.stderr)
        raise e

def merge_results(output_prefix: str):
    """
    Merges all partial .npy and _meta.json files into a single
    {output_prefix}.npy and {output_prefix}_ids.json.
    Also reports total token usage.
    """
    print("Merging results...")
    
    dir_path = os.path.dirname(output_prefix) or "."
    base_name = os.path.basename(output_prefix)
    
    pattern = re.compile(rf"^{re.escape(base_name)}_(\d+)\.npy$")
    
    files_map = {}
    
    for filename in os.listdir(dir_path):
        match = pattern.match(filename)
        if match:
            idx = int(match.group(1))
            files_map[idx] = os.path.join(dir_path, filename)
            
    if not files_map:
        print("No partial files found to merge.")
        return

    sorted_indices = sorted(files_map.keys())
    
    # Check for gaps
    if sorted_indices[-1] != len(sorted_indices) - 1:
        print(f"Warning: Found {len(sorted_indices)} batches but max index is {sorted_indices[-1]}. There may be gaps.")

    first_arr = np.load(files_map[sorted_indices[0]])
    embedding_dim = first_arr.shape[1]
    dtype = first_arr.dtype
    
    total_rows = 0
    file_shapes = {}
    
    print("Calculating total size...")
    for idx in tqdm(sorted_indices):
        fpath = files_map[idx]
        shape = np.load(fpath, mmap_mode='r').shape
        file_shapes[idx] = shape[0]
        total_rows += shape[0]
        
    print(f"Total embeddings: {total_rows}, Dimension: {embedding_dim}")
    
    final_npy_path = f"{output_prefix}.npy"
    final_ids_path = f"{output_prefix}_ids.json"
    
    merged_arr = open_memmap(final_npy_path, mode='w+', dtype=dtype, shape=(total_rows, embedding_dim))
    
    all_ids = []
    total_tokens = 0
    
    current_row = 0
    print("Writing to merged file...")
    for idx in tqdm(sorted_indices):
        # Merge NPY
        fpath = files_map[idx]
        rows = file_shapes[idx]
        part_arr = np.load(fpath)
        merged_arr[current_row : current_row + rows] = part_arr
        current_row += rows
        
        # Merge Meta
        meta_fpath = fpath.replace(".npy", "_meta.json")
        old_ids_fpath = fpath.replace(".npy", "_ids.json")
        
        if os.path.exists(meta_fpath):
            with open(meta_fpath, 'r') as f:
                data = json.load(f)
                all_ids.extend(data['ids'])
                total_tokens += data.get('usage', 0)
        elif os.path.exists(old_ids_fpath):
            with open(old_ids_fpath, 'r') as f:
                data = json.load(f)
                if isinstance(data, list):
                    all_ids.extend(data)
                elif isinstance(data, dict):
                    all_ids.extend(data['ids'])
                    total_tokens += data.get('usage', 0)
    
    del merged_arr
    
    with open(final_ids_path, 'w') as f:
        json.dump(all_ids, f)
        
    print(f"Merge complete.")
    print(f"Data: {final_npy_path}")
    print(f"IDs:  {final_ids_path}")
    print(f"Total Tokens Used: {total_tokens:,}")


async def main():
    if not os.path.exists(args.input):
        print(f"Error: Input file '{args.input}' not found.", file=sys.stderr)
        return

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # Resume Logic
    existing_indices = set()
    dir_path = os.path.dirname(args.output) or "."
    base_name = os.path.basename(args.output)
    
    if os.path.exists(dir_path):
        for filename in os.listdir(dir_path):
            if filename.startswith(base_name) and filename.endswith(".npy"):
                try:
                    name_no_ext = os.path.splitext(filename)[0]
                    parts = name_no_ext.rsplit('_', 1)
                    if len(parts) == 2 and parts[1].isdigit():
                        existing_indices.add(int(parts[1]))
                except ValueError:
                    pass

    print(f"Found {len(existing_indices)} completed batches. Resuming...")

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
    
    def line_generator():
        with open(args.input, 'r', encoding='utf-8') as f_in:
            for line in f_in:
                if line.strip():
                    yield line

    batch_iter = chunked_iterable(line_generator(), BATCH_SIZE)
    active_tasks = set()
    
    session_tokens = 0
    pbar = tqdm(desc="Embedding Batches", unit="batch")

    for i, batch in enumerate(batch_iter):
        if i in existing_indices:
            continue

        task = asyncio.create_task(fetch_embeddings(batch, i, args.output, semaphore))
        active_tasks.add(task)
        task.add_done_callback(active_tasks.discard)

        # Buffer control:
        # Increase buffer to allow tasks to be 'active' (waiting on semaphore)
        # while split tasks take up slots.
        if len(active_tasks) >= MAX_CONCURRENT_REQUESTS * 2:
            _done, _pending = await asyncio.wait(active_tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in _done:
                try:
                    tokens = await t
                    session_tokens += tokens
                    pbar.update(1)
                    pbar.set_postfix({"tokens": f"{session_tokens:,}"})
                except Exception:
                    pass

    # Wait for remaining
    if active_tasks:
        for t in asyncio.as_completed(active_tasks):
            try:
                tokens = await t
                session_tokens += tokens
                pbar.update(1)
                pbar.set_postfix({"tokens": f"{session_tokens:,}"})
            except Exception:
                pass
    
    pbar.close()
    await http_client.aclose()
    
    print(f"\nSession Tokens Used: {session_tokens:,}")
    
    if not args.skip_merge:
        print("\nStarting merge...")
        merge_results(args.output)
    
    print("\nDone.")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nProcess interrupted.")

