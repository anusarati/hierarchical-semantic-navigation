import numpy as np
import hnswlib
import networkx as nx
from typing import List
from tqdm import tqdm

METRIC = "cosine"


class HierarchicalGraphBuilder:
    """
    Constructs a layered semantic graph from document embeddings using Cosine similarity.
    """

    def __init__(
        self,
        alpha: float = 0.8,
        m: int = 16,
        ef_construction: int = 200,
        k_neighbors: int = 15,
    ):
        """
        Args:
            alpha: Distance proportion threshold. A node N becomes a child of C if:
                   dist(N, C) <= alpha * dist(C, Parent(C)).
            m: HNSW M parameter (max links per node).
            ef_construction: HNSW ef_construction parameter.
            k_neighbors: Number of neighbors for centrality calculation.
        """
        self.alpha = alpha
        self.m = m
        self.ef_construction = ef_construction
        self.k_neighbors = k_neighbors
        self.sentinel_id = -1

    def build(self, embeddings: np.ndarray, ids: List[str]) -> nx.DiGraph:
        # Enforce float32 for HNSW compatibility
        embeddings = embeddings.astype(np.float32)

        # 1. Compute Centrality
        print("Constructing base index for centrality calculation...")
        centrality_scores = self._compute_centrality(embeddings)

        # Sort indices by centrality (descending)
        sorted_indices = np.argsort(centrality_scores)[::-1]

        # 2. Construct Hierarchy
        print("Constructing hierarchy...")
        graph = self._construct_hierarchy(embeddings, sorted_indices)

        # 3. Annotate graph with original IDs
        mapping = dict(enumerate(ids))
        nx.set_node_attributes(graph, mapping, "doc_id")

        return graph

    def _compute_centrality(self, embeddings: np.ndarray) -> np.ndarray:
        num_elements, dim = embeddings.shape

        # Build index
        p = hnswlib.Index(space=METRIC, dim=dim)
        p.init_index(
            max_elements=num_elements, ef_construction=self.ef_construction, M=self.m
        )
        p.add_items(embeddings, np.arange(num_elements))

        # Query k+1 neighbors (including self)
        labels, _ = p.knn_query(embeddings, k=self.k_neighbors + 1)

        # Build Graph
        G = nx.DiGraph()
        G.add_nodes_from(range(num_elements))

        for i, neighbors in tqdm(enumerate(labels), total=num_elements, desc="  Centrality Graph"):
            for neighbor in neighbors:
                if i != neighbor:
                    G.add_edge(i, int(neighbor))

        # PageRank
        print("  Calculating PageRank...")
        pagerank = nx.pagerank(G, alpha=0.85, tol=1e-4)

        scores = np.zeros(num_elements, dtype=np.float32)
        for i in range(num_elements):
            scores[i] = pagerank.get(i, 0.0)

        return scores

    def _calculate_cosine_distance(self, vec_a: np.ndarray, vec_b: np.ndarray) -> float:
        """
        Explicit Cosine Distance: 1 - CosineSimilarity
        """
        norm_a = np.linalg.norm(vec_a)
        norm_b = np.linalg.norm(vec_b)
        if norm_a == 0 or norm_b == 0:
            return 1.0
        return 1.0 - np.dot(vec_a, vec_b) / (norm_a * norm_b)

    def _construct_hierarchy(
        self, embeddings: np.ndarray, sorted_indices: np.ndarray
    ) -> nx.DiGraph:
        num_elements, dim = embeddings.shape

        G = nx.DiGraph()
        G.add_node(self.sentinel_id, type="sentinel")

        # Incremental HNSW index
        idx = hnswlib.Index(space=METRIC, dim=dim)
        idx.init_index(
            max_elements=num_elements, ef_construction=self.ef_construction, M=self.m
        )
        idx.set_ef(self.ef_construction)

        active_count = 0

        for current_doc_idx in tqdm(sorted_indices, desc="  Hierarchical Insert"):
            current_doc_idx = int(current_doc_idx)
            doc_vec = embeddings[current_doc_idx]

            if active_count == 0:
                self._add_node_to_structure(
                    G, idx, self.sentinel_id, current_doc_idx, doc_vec
                )
                active_count += 1
                continue

            # Find nearest neighbor in partial graph
            nn_labels, nn_dists = idx.knn_query(doc_vec, k=1)
            nn_id = int(nn_labels[0][0])
            nn_dist = float(nn_dists[0][0])

            parent_id = self._find_insertion_parent(
                G, embeddings, doc_vec, nn_id, nn_dist
            )

            self._add_node_to_structure(G, idx, parent_id, current_doc_idx, doc_vec)
            active_count += 1

        return G

    def _find_insertion_parent(
        self,
        G: nx.DiGraph,
        embeddings: np.ndarray,
        doc_vec: np.ndarray,
        candidate_id: int,
        candidate_dist: float,
    ) -> int:
        curr_id = candidate_id
        curr_dist = candidate_dist

        while True:
            # Get parent (optimized)
            parent_id = next(G.predecessors(curr_id), None)

            if parent_id is None:
                # Should only happen if curr_id is sentinel, but sentinel has no predecessors in graph logic usually
                return self.sentinel_id

            if parent_id == self.sentinel_id:
                # Base case for Cosine: Sentinel is "neutral" (dist 1.0)
                parent_dist = 1.0
            else:
                parent_vec = embeddings[parent_id]
                parent_dist = self._calculate_cosine_distance(doc_vec, parent_vec)

            # The Check: Is the node specific enough to belong to curr_id?
            # If curr_dist is small (close) compared to parent_dist, we keep it here.
            if curr_dist <= self.alpha * parent_dist:
                return curr_id

            # If we hit the sentinel and failed the check, we attach to sentinel
            if parent_id == self.sentinel_id:
                return self.sentinel_id

            # Bubble up
            curr_id = parent_id
            curr_dist = parent_dist

    def _add_node_to_structure(
        self,
        G: nx.DiGraph,
        idx: hnswlib.Index,
        parent_id: int,
        doc_id: int,
        doc_vec: np.ndarray,
    ):
        G.add_node(doc_id)
        G.add_edge(parent_id, doc_id)
        idx.add_items([doc_vec], [doc_id])
