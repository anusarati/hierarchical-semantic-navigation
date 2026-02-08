const API_BASE = "/api";

// Vis.js Network
let network = null;
const nodes = new vis.DataSet();
const edges = new vis.DataSet();

// State
const expandedNodes = new Set();

const container = document.getElementById("network");
const statusSpan = document.getElementById("status");
const docTitle = document.getElementById("doc-title");
const docIdDisplay = document.getElementById("doc-id");
const docIntro = document.getElementById("doc-intro");

const options = {
	nodes: {
		shape: "dot",
		font: {
			size: 14,
			face: "Arial",
			strokeWidth: 4,
			strokeColor: "#ffffff",
			color: "#333333",
		},
		borderWidth: 2,
		shadow: false,
		scaling: {
			min: 10,
			max: 40,
			label: {
				enabled: true,
				min: 12,
				max: 20,
			},
		},
	},
	edges: {
		width: 1,
		color: { inherit: "from", opacity: 0.3 },
		smooth: {
			type: "continuous",
			roundness: 0,
		},
		arrows: {
			to: { enabled: true, scaleFactor: 0.5 },
		},
	},
	physics: {
		enabled: true,
		solver: "forceAtlas2Based",
		forceAtlas2Based: {
			gravitationalConstant: -80, // Reduced repulsion to allow tighter packing
			centralGravity: 0.005,
			springLength: 80,
			springConstant: 0.1,
			damping: 0.95, // MAXIMUM DAMPING: Stops movement almost immediately
			avoidOverlap: 1, // Strong overlap avoidance for labels
		},
		stabilization: {
			enabled: false,
		},
		maxVelocity: 5, // Strict speed limit
		minVelocity: 0.1,
	},
	interaction: {
		hover: true,
		tooltipDelay: 200,
		zoomView: true,
		dragNodes: true,
	},
	layout: {
		randomSeed: 42,
	},
};

async function init() {
	statusSpan.textContent = "Loading graph roots...";
	try {
		const response = await fetch(`${API_BASE}/graph/roots`);
		if (!response.ok) throw new Error("Failed to fetch roots");
		const rootNodes = await response.json();

		// Root Layout: Global Spiral
		addNodesSpiral(rootNodes, 0, 0, 80);

		const data = { nodes, edges };
		network = new vis.Network(container, data, options);

		network.on("click", (params) => {
			if (params.nodes.length > 0) {
				const nodeId = params.nodes[0];
				fetchNodeDetails(nodeId);
			}
		});

		network.on("doubleClick", (params) => {
			if (params.nodes.length > 0) {
				const nodeId = params.nodes[0];
				expandNode(nodeId);
			}
		});

		statusSpan.textContent = "Ready";
	} catch (err) {
		console.error(err);
		statusSpan.textContent = "Error loading graph.";
		docIntro.textContent = "Error connecting to backend.";
	}
}

function calculateSize(descendantCount) {
	if (descendantCount <= 0) return 15;
	return 15 + Math.log(descendantCount + 1) * 4;
}

/**
 * Generic Spiral Layout
 * @param {Array} nodeList - Nodes to add
 * @param {Number} centerX - X origin
 * @param {Number} centerY - Y origin
 * @param {Number} spread - How loose the spiral is (higher = more space)
 */
function addNodesSpiral(nodeList, centerX, centerY, spread) {
	const newNodes = [];

	// We skip index 0 if it's the parent itself, but here nodeList is just children
	// We add a small offset to radius so they don't spawn INSIDE the center point
	const startRadius = 60;

	nodeList.forEach((node, index) => {
		if (!nodes.get(node.id)) {
			// Golden Angle Spiral
			const angle = index * 2.39996;
			const radius = startRadius + spread * Math.sqrt(index);

			const x = centerX + radius * Math.cos(angle);
			const y = centerY + radius * Math.sin(angle);

			// Style
			let color = "#87CEFA";
			if (node.level === 0) color = "#FF7F50";
			else if (node.descendant_count > 50) color = "#FFA07A";
			else if (node.has_children) color = "#4682B4";

			newNodes.push({
				id: node.id,
				label: truncateLabel(node.label),
				title: `${node.title} (${node.descendant_count} descendants)`,
				size: calculateSize(node.descendant_count),
				color: { background: color, border: "#2B7CE9" },
				x: x,
				y: y,
				data: node,
			});
		}
	});
	nodes.add(newNodes);

	// Do NOT fit() here on expansion, it causes jarring zooms.
	// Only fit if it's the initial load.
	if (network && nodes.length === nodeList.length) {
		network.fit();
	}
}

function truncateLabel(label) {
	if (label.length > 20) {
		return label.substring(0, 18) + "...";
	}
	return label;
}

function addEdges(parentId, children) {
	const newEdges = [];
	children.forEach((child) => {
		const edgeId = `${parentId}-${child.id}`;
		if (!edges.get(edgeId)) {
			newEdges.push({
				id: edgeId,
				from: parentId,
				to: child.id,
			});
		}
	});
	edges.add(newEdges);
}

async function expandNode(nodeId) {
	if (expandedNodes.has(nodeId)) {
		statusSpan.textContent = "Already expanded.";
		return;
	}

	statusSpan.textContent = `Expanding...`;
	try {
		const response = await fetch(`${API_BASE}/graph/children/${nodeId}`);
		if (!response.ok) throw new Error("Failed to fetch children");
		const children = await response.json();

		if (children.length === 0) {
			statusSpan.textContent = "No children found.";
			return;
		}

		// 1. Get Parent Position
		// We must get the CURRENT simulation position, not the initial x/y
		const positions = network.getPositions([nodeId]);
		const parentPos = positions[nodeId];

		// 2. Lock Parent (anchor it so the spiral forms around it)
		nodes.update({ id: nodeId, fixed: true });

		// 3. Add Children in a TIGHT spiral around the parent
		// Spread is smaller (40) than root (80) to keep sub-topics clustered
		addNodesSpiral(children, parentPos.x, parentPos.y, 40);
		addEdges(nodeId, children);

		expandedNodes.add(nodeId);
		statusSpan.textContent = `Ready`;
	} catch (err) {
		console.error(err);
		statusSpan.textContent = "Error expanding node.";
	}
}

async function fetchNodeDetails(nodeId) {
	const node = nodes.get(nodeId);
	if (node) {
		docTitle.textContent = node.data.title;
		docIntro.textContent = "Loading content...";
	}

	try {
		const response = await fetch(`${API_BASE}/node/${nodeId}`);
		if (!response.ok) throw new Error("Failed to fetch details");
		const details = await response.json();

		docTitle.textContent = details.title;
		docIdDisplay.textContent = `ID: ${details.str_id}`;
		docIntro.innerText = details.intro;
	} catch (err) {
		console.error(err);
		docIntro.textContent = "Failed to load document content.";
	}
}

document.getElementById("reset-btn").addEventListener("click", () => {
	nodes.clear();
	edges.clear();
	expandedNodes.clear();
	init();
});

// Start
init();
