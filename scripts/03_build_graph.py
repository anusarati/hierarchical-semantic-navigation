import sys
import os
import json
import pickle
import numpy as np
import networkx as nx

# Add project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../")))

from hsn.builder import HierarchicalGraphBuilder

# Configuration
EMBEDDINGS_PATH = "embeddings/wiki.npy"
IDS_PATH = "embeddings/wiki_ids.json"
OUTPUT_GRAPH_PATH = "data/graph.pkl"


def main():
    if not os.path.exists(EMBEDDINGS_PATH) or not os.path.exists(IDS_PATH):
        print(f"Error: Embeddings/IDs not found. Run scripts/02_get_embeddings.py first.")
        sys.exit(1)

    # Ensure output directory exists
    os.makedirs(os.path.dirname(OUTPUT_GRAPH_PATH), exist_ok=True)

    print("Loading embeddings and IDs...")
    embeddings = np.load(EMBEDDINGS_PATH)
    with open(IDS_PATH, "r") as f:
        str_ids = json.load(f)

    print(f"Building hierarchical graph for {len(str_ids)} documents...")
    builder = HierarchicalGraphBuilder()
    graph = builder.build(embeddings, str_ids)

    print(f"Graph built: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges.")

    print(f"Saving graph to {OUTPUT_GRAPH_PATH}...")
    with open(OUTPUT_GRAPH_PATH, "wb") as f:
        pickle.dump(graph, f)
    
    print("Done.")

if __name__ == "__main__":
    main()

