import os
import json
import pickle
import re
import sqlite3
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import networkx as nx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Configuration
GRAPH_PATH = "data/graph.pkl"
CONTENT_PATH = "wikipedia_intros.jsonl"
ERROR_GRAPH_NOT_LOADED = "Graph not loaded"


class GlobalState:
    graph: Optional[nx.DiGraph] = None
    doc_data: Dict[str, Dict[str, str]] = {}
    id_map: Dict[int, str] = {}  # int_id -> str_id
    descendant_counts: Dict[int, int] = {}  # node_id -> num_descendants
    parent_map: Dict[int, int] = {}  # child_id -> parent_id
    path_cache: Dict[int, List[int]] = {}  # node_id -> [sentinel, ..., node_id]
    sentinel_id: int = -1
    search_conn: Optional[sqlite3.Connection] = None
    search_rows: List[tuple[int, int, str, str, str]] = []
    fts_enabled: bool = False


state = GlobalState()


def _calculate_descendants(graph: nx.DiGraph) -> Dict[int, int]:
    """
    Calculates the number of descendants (subtree size) for each node.
    Assumes the graph is a Forest (each node has <= 1 parent).
    Uses reverse topological sort for O(N) efficiency.
    """
    counts = dict.fromkeys(graph.nodes(), 0)
    
    # Process leaves first, up to roots
    try:
        # topological_sort works for DAGs
        topo_order = list(nx.topological_sort(graph))
        for n in reversed(topo_order):
            count = 0
            for child in graph.successors(n):
                # Add child itself + child's descendants
                count += 1 + counts[child]
            counts[n] = count
    except nx.NetworkXUnfeasible:
        # Fallback if cycles exist (shouldn't happen in this algorithm)
        print("Warning: Graph has cycles, using slower descendant count method.")
        for n in graph.nodes():
            counts[n] = len(nx.descendants(graph, n))
            
    return counts


def _build_parent_map(graph: nx.DiGraph) -> Dict[int, int]:
    parent_map: Dict[int, int] = {}
    for parent_id, child_id in graph.edges():
        parent_map[int(child_id)] = int(parent_id)
    return parent_map


def _get_node_title(node_id: int) -> str:
    if node_id == state.sentinel_id:
        return "All Documents"

    str_id = state.id_map.get(node_id)
    if not str_id:
        return f"Cluster {node_id}"
    return state.doc_data.get(str_id, {}).get("title", str_id)


def _get_path_ids(node_id: int) -> List[int]:
    if node_id in state.path_cache:
        return state.path_cache[node_id]

    if state.graph is None or node_id not in state.graph:
        return []

    path: List[int] = []
    visited: set[int] = set()
    curr_id = node_id

    while curr_id not in visited:
        visited.add(curr_id)
        path.append(curr_id)

        if curr_id == state.sentinel_id:
            break

        parent_id = state.parent_map.get(curr_id)
        if parent_id is None:
            break
        curr_id = parent_id

    path.reverse()
    state.path_cache[node_id] = path
    return path


def _prepare_search_rows() -> List[tuple[int, int, str, str, str]]:
    if state.graph is None:
        return []

    rows: List[tuple[int, int, str, str, str]] = []
    for node_id in state.graph.nodes():
        if node_id == state.sentinel_id:
            continue
        title = _get_node_title(node_id)
        str_id = state.id_map.get(node_id, f"cluster:{node_id}")
        parent_id = state.parent_map.get(node_id, state.sentinel_id)
        rows.append((int(node_id), int(parent_id), title, str_id, title.lower()))
    return rows


def _build_search_index():
    state.fts_enabled = False

    if state.search_conn is not None:
        try:
            state.search_conn.close()
        except Exception:
            pass
        state.search_conn = None

    state.search_rows = _prepare_search_rows()
    if not state.search_rows:
        print("Search index skipped: no rows available.")
        return

    try:
        # FastAPI can serve requests across worker threads in some setups.
        conn = sqlite3.connect(":memory:", check_same_thread=False)
        conn.execute("PRAGMA journal_mode = OFF")
        conn.execute("PRAGMA synchronous = OFF")
        conn.execute(
            "CREATE VIRTUAL TABLE title_search USING fts5(node_id UNINDEXED, parent_id UNINDEXED, title, str_id UNINDEXED)"
        )
        conn.executemany(
            "INSERT INTO title_search(node_id, parent_id, title, str_id) VALUES (?, ?, ?, ?)",
            [(n, p, t, s) for n, p, t, s, _ in state.search_rows],
        )
        state.search_conn = conn
        state.fts_enabled = True
        print(f"Search index built with FTS5 ({len(state.search_rows)} rows).")
    except sqlite3.OperationalError as e:
        print(f"FTS5 unavailable, using fallback title search: {e}")
    except Exception as e:
        print(f"Failed to build search index, using fallback title search: {e}")


def _build_fts_query(query: str) -> str:
    tokens = re.findall(r"[a-zA-Z0-9]+", query.lower())
    if not tokens:
        return ""
    return " ".join(f"{token}*" for token in tokens)


def _fallback_search(query: str, limit: int) -> List["SearchHit"]:
    query_lower = query.lower().strip()
    tokens = [token for token in re.findall(r"[a-zA-Z0-9]+", query_lower) if token]
    if not query_lower or not tokens:
        return []

    matches: List[tuple[float, int, int, str, str]] = []
    for node_id, parent_id, title, str_id, title_lower in state.search_rows:
        if all(token in title_lower for token in tokens):
            if title_lower == query_lower:
                score = 0.0
            elif title_lower.startswith(query_lower):
                score = 1.0
            elif query_lower in title_lower:
                score = 2.0 + (title_lower.find(query_lower) / 1000.0)
            else:
                score = 3.0
            matches.append((score, node_id, parent_id, title, str_id))

    matches.sort(key=lambda row: (row[0], len(row[3]), row[3].lower()))
    return [
        SearchHit(
            node_id=node_id,
            parent_id=parent_id,
            title=title,
            str_id=str_id,
            score=score,
        )
        for score, node_id, parent_id, title, str_id in matches[:limit]
    ]


def load_data():
    print("Loading data...")
    
    # 1. Load Graph
    if os.path.exists(GRAPH_PATH):
        print(f"Loading graph from {GRAPH_PATH}...")
        try:
            with open(GRAPH_PATH, "rb") as f:
                loaded_graph = pickle.load(f)
            
            if isinstance(loaded_graph, nx.DiGraph):
                state.graph = loaded_graph
                state.id_map = nx.get_node_attributes(loaded_graph, "doc_id")
                state.parent_map = _build_parent_map(loaded_graph)
                state.path_cache = {}
                
                # Identify sentinel
                sentinel_nodes = [n for n, attr in loaded_graph.nodes(data=True) if attr.get("type") == "sentinel"]
                state.sentinel_id = sentinel_nodes[0] if sentinel_nodes else -1
                
                print(f"Graph loaded: {loaded_graph.number_of_nodes()} nodes.")
                
                # Pre-calculate subtree sizes
                print("Calculating subtree sizes...")
                state.descendant_counts = _calculate_descendants(loaded_graph)
                print("Subtree sizes calculated.")
                
            else:
                print("Error: Loaded object is not a DiGraph")
                state.graph = None

        except Exception as e:
            print(f"Error loading graph: {e}")
            state.graph = None
    else:
        print(f"Error: Graph file not found at {GRAPH_PATH}. Run scripts/03_build_graph.py first.")

    # 2. Load Content
    if os.path.exists(CONTENT_PATH):
        print(f"Loading content from {CONTENT_PATH}...")
        count = 0
        with open(CONTENT_PATH, "r") as f:
            for line in f:
                if not line.strip():
                    continue
                data = json.loads(line)
                state.doc_data[data["id"]] = {
                    "title": data.get("title", "Untitled"),
                    "intro": data.get("intro", ""),
                }
                count += 1
        print(f"Loaded content for {count} documents.")
    else:
        print("Warning: Content file not found.")

    if state.graph is not None:
        _build_search_index()


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    try:
        yield
    finally:
        if state.search_conn is not None:
            state.search_conn.close()
            state.search_conn = None


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# -- Models --

class NodeInfo(BaseModel):
    id: int
    label: str
    title: str
    has_children: bool
    level: int
    descendant_count: int  # New field


class NodeDetails(BaseModel):
    id: int
    str_id: str
    title: str
    intro: str


class NodeCrumb(BaseModel):
    id: int
    title: str


class PathResponse(BaseModel):
    path: List[NodeCrumb]


class SearchHit(BaseModel):
    node_id: int
    parent_id: int
    title: str
    str_id: str
    score: float


# -- Endpoints --

@app.get("/api/graph/roots", response_model=List[NodeInfo])
async def get_roots():
    if state.graph is None:
        raise HTTPException(status_code=503, detail=ERROR_GRAPH_NOT_LOADED)

    if state.sentinel_id not in state.graph:
        return []

    return _get_children(state.graph, state.sentinel_id, level=0)


@app.get("/api/graph/children/{node_id}", response_model=List[NodeInfo])
async def get_children(node_id: int):
    if state.graph is None:
        raise HTTPException(status_code=503, detail=ERROR_GRAPH_NOT_LOADED)

    return _get_children(state.graph, node_id, level=1)


@app.get("/api/node/{node_id}", response_model=NodeDetails)
async def get_node_details(node_id: int):
    if state.graph is None:
        raise HTTPException(status_code=503, detail=ERROR_GRAPH_NOT_LOADED)

    if node_id == state.sentinel_id:
        return NodeDetails(
            id=state.sentinel_id,
            str_id="__root__",
            title="All Documents",
            intro="Top-level semantic clusters. Click a cluster to drill into its children.",
        )

    str_id = state.id_map.get(node_id)
    if not str_id:
        raise HTTPException(status_code=404, detail="Node content not found")

    data = state.doc_data.get(str_id, {"title": str_id, "intro": "(No content available)"})

    return NodeDetails(
        id=node_id,
        str_id=str_id,
        title=data["title"],
        intro=data["intro"],
    )


@app.get("/api/graph/path/{node_id}", response_model=PathResponse)
async def get_node_path(node_id: int):
    if state.graph is None:
        raise HTTPException(status_code=503, detail=ERROR_GRAPH_NOT_LOADED)

    if node_id not in state.graph:
        raise HTTPException(status_code=404, detail="Node not found")

    path_ids = _get_path_ids(node_id)
    crumbs = [
        NodeCrumb(id=path_id, title=_get_node_title(path_id))
        for path_id in path_ids
        if path_id != state.sentinel_id
    ]
    return PathResponse(path=crumbs)


@app.get("/api/search", response_model=List[SearchHit])
async def search_titles(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=10),
):
    if state.graph is None:
        raise HTTPException(status_code=503, detail=ERROR_GRAPH_NOT_LOADED)

    query = q.strip()
    if not query:
        return []

    if state.fts_enabled and state.search_conn is not None:
        fts_query = _build_fts_query(query)
        if fts_query:
            try:
                rows = state.search_conn.execute(
                    """
                    SELECT
                        CAST(node_id AS INTEGER) AS node_id,
                        CAST(parent_id AS INTEGER) AS parent_id,
                        title,
                        str_id,
                        bm25(title_search) AS score
                    FROM title_search
                    WHERE title_search MATCH ?
                    ORDER BY score
                    LIMIT ?
                    """,
                    (fts_query, limit),
                ).fetchall()
                if rows:
                    return [
                        SearchHit(
                            node_id=int(node_id),
                            parent_id=int(parent_id),
                            title=title,
                            str_id=str_id,
                            score=float(score),
                        )
                        for node_id, parent_id, title, str_id, score in rows
                    ]
            except sqlite3.OperationalError:
                # Bad FTS syntax for unusual user query; use fallback.
                pass

    return _fallback_search(query, limit)


def _get_children(graph: nx.DiGraph, parent_id: int, level: int) -> List[NodeInfo]:
    children = []
    if parent_id in graph:
        for child_id in graph.successors(parent_id):
            str_id = state.id_map.get(child_id, f"Cluster {child_id}")
            doc_info = state.doc_data.get(str_id, {"title": str_id})

            has_children = graph.out_degree(child_id) > 0

            # Get pre-calculated count, default to 0
            count = state.descendant_counts.get(child_id, 0)

            children.append(
                NodeInfo(
                    id=child_id,
                    label=doc_info["title"],
                    title=doc_info["title"],
                    has_children=has_children,
                    level=level,
                    descendant_count=count,
                )
            )

    # Sort children by size (optional, but nice for UI)
    children.sort(key=lambda x: x.descendant_count, reverse=True)
    return children


app.mount("/", StaticFiles(directory="web/frontend", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("web.backend.main:app", host="0.0.0.0", port=8000, reload=True)
