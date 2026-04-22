import sys
import os
import json
import numpy as np
import networkx as nx
import hnswlib
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from sklearn.decomposition import PCA
import argparse
from tqdm import tqdm

# Add project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../")))

EMBEDDINGS_PATH = "embeddings/wiki.npy"
IDS_PATH = "embeddings/wiki_ids.json"
OUTPUT_IMAGE_PATH = "data/knn_graph.png"

def main():
    parser = argparse.ArgumentParser(description="Visualize the k-NN graph of Wikipedia documents.")
    parser.add_argument("--k-neighbors", type=int, default=15, help="Number of neighbors for k-NN graph.")
    parser.add_argument("--top-nodes", type=int, default=5, help="Number of highest PageRank nodes to start with.")
    parser.add_argument("--hops", type=int, default=2, help="Number of k-NN neighbor hops to include.")
    parser.add_argument("--layout", type=str, choices=["pca", "spring"], default="pca", help="Layout algorithm.")
    args = parser.parse_args()

    if not os.path.exists(EMBEDDINGS_PATH) or not os.path.exists(IDS_PATH):
        print(f"Error: Embeddings/IDs not found. Run scripts/02_get_embeddings.py first.")
        sys.exit(1)

    os.makedirs(os.path.dirname(OUTPUT_IMAGE_PATH), exist_ok=True)

    print("Loading embeddings...")
    embeddings = np.load(EMBEDDINGS_PATH).astype(np.float32)
    with open(IDS_PATH, "r") as f:
        str_ids = json.load(f)

    num_elements, dim = embeddings.shape
    print(f"Loaded {num_elements} embeddings of dimension {dim}.")

    print("Building HNSW index for k-NN graph...")
    p = hnswlib.Index(space="cosine", dim=dim)
    p.init_index(max_elements=num_elements, ef_construction=200, M=16)
    p.add_items(embeddings, np.arange(num_elements))

    print(f"Querying {args.k_neighbors} nearest neighbors...")
    labels, _ = p.knn_query(embeddings, k=args.k_neighbors + 1)

    print("Constructing NetworkX graph...")
    G = nx.DiGraph()
    G.add_nodes_from(range(num_elements))

    edges = []
    for i, neighbors in tqdm(enumerate(labels), total=num_elements, desc="Adding edges"):
        for neighbor in neighbors:
            if i != neighbor:
                G.add_edge(i, int(neighbor))
                edges.append((i, int(neighbor)))

    print("Calculating PageRank...")
    pagerank = nx.pagerank(G, alpha=0.85, tol=1e-4)

    scores = np.zeros(num_elements, dtype=np.float32)
    for i in range(num_elements):
        scores[i] = pagerank.get(i, 0.0)

    # Find the top N nodes by PageRank
    top_n = min(args.top_nodes, num_elements)
    print(f"Finding top {top_n} nodes by PageRank and their neighbors up to {args.hops} hops...")
    start_nodes = np.argsort(scores)[::-1][:top_n]
    
    # Traverse neighbors up to 'hops' levels
    visualized_nodes_set = set(start_nodes)
    current_level = set(start_nodes)
    
    for hop in range(args.hops):
        next_level = set()
        for node in current_level:
            # Add neighbors (successors are the node's k-NN)
            next_level.update(G.successors(node))
            
        next_level.difference_update(visualized_nodes_set)
        visualized_nodes_set.update(next_level)
        current_level = next_level
        print(f"Hop {hop+1}: added {len(next_level)} nodes")
        
    visualized_nodes = np.array(list(visualized_nodes_set))
    print(f"Total nodes to visualize: {len(visualized_nodes)}")

    subgraph = G.subgraph(visualized_nodes)
    edges = list(subgraph.edges())

    plot_embeddings = embeddings[visualized_nodes]
    plot_scores = scores[visualized_nodes]
    
    # Need a mapping from original ID to new index 0..N-1
    id_to_idx = {orig_id: i for i, orig_id in enumerate(visualized_nodes)}
    plot_edges = [(id_to_idx[u], id_to_idx[v]) for u, v in edges]

    num_plot_nodes = len(plot_scores)
    print(f"Computing layout for {num_plot_nodes} nodes using {args.layout}...")
    if args.layout == "pca":
        pca = PCA(n_components=2)
        pos = pca.fit_transform(plot_embeddings)
    elif args.layout == "spring":
        # Create a temporary graph to layout
        layout_G = nx.Graph()
        layout_G.add_nodes_from(range(num_plot_nodes))
        layout_G.add_edges_from(plot_edges)
        pos_dict = nx.spring_layout(layout_G, iterations=50)
        pos = np.array([pos_dict[i] for i in range(num_plot_nodes)])
    
    print("Normalizing node sizes and colors based on PageRank...")
    # Normalize scores for visualization
    if np.max(plot_scores) > np.min(plot_scores):
        norm_scores = (plot_scores - np.min(plot_scores)) / (np.max(plot_scores) - np.min(plot_scores))
    else:
        norm_scores = np.ones_like(plot_scores) * 0.5

    node_sizes = 5 + norm_scores * 200  # Size range: 5 to 205
    colors = plot_scores

    print("Drawing graph...")
    plt.figure(figsize=(24, 12))
    ax = plt.gca()

    # Draw edges
    # We use LineCollection for performance
    lines = [(pos[u], pos[v]) for u, v in plot_edges]
    lc = LineCollection(lines, color="gray", alpha=0.05 if num_plot_nodes > 1000 else 0.2, linewidths=0.5)
    ax.add_collection(lc)

    # Draw nodes
    scatter = ax.scatter(
        pos[:, 0], pos[:, 1],
        s=node_sizes,
        c=colors,
        cmap="viridis",
        alpha=0.8,
        zorder=2
    )

    plt.colorbar(scatter, label="PageRank Score")
    plt.title("Wikipedia Documents k-NN Graph")
    
    # Remove axes
    plt.axis("off")

    print(f"Saving visualization to {OUTPUT_IMAGE_PATH}...")
    plt.savefig(OUTPUT_IMAGE_PATH, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close()

    print("Done!")

if __name__ == "__main__":
    main()
