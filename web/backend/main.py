import sys
import os
import json
import pickle
import networkx as nx
from contextlib import asynccontextmanager
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
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
    sentinel_id: int = -1


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    yield


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
    
    str_id = state.id_map.get(node_id)
    if not str_id:
        raise HTTPException(status_code=404, detail="Node content not found")
    
    data = state.doc_data.get(str_id, {"title": str_id, "intro": "(No content available)"})
    
    return NodeDetails(
        id=node_id,
        str_id=str_id,
        title=data["title"],
        intro=data["intro"]
    )


def _get_children(graph: nx.DiGraph, parent_id: int, level: int) -> List[NodeInfo]:
    children = []
    if parent_id in graph:
        for child_id in graph.successors(parent_id):
            str_id = state.id_map.get(child_id, f"Cluster {child_id}")
            doc_info = state.doc_data.get(str_id, {"title": str_id})
            
            has_children = False
            try:
                if next(graph.successors(child_id), None) is not None:
                    has_children = True
            except Exception:
                pass
            
            # Get pre-calculated count, default to 0
            count = state.descendant_counts.get(child_id, 0)

            children.append(NodeInfo(
                id=child_id,
                label=doc_info["title"],
                title=doc_info["title"],
                has_children=has_children,
                level=level,
                descendant_count=count
            ))
            
    # Sort children by size (optional, but nice for UI)
    children.sort(key=lambda x: x.descendant_count, reverse=True)
    return children


app.mount("/", StaticFiles(directory="web/frontend", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("web.backend.main:app", host="0.0.0.0", port=8000, reload=True)

