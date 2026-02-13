const API_BASE = '/api';

// Vis.js Network
let network = null;
let nodes = new vis.DataSet();
let edges = new vis.DataSet();

// State
let expandedNodes = new Set();
const nodeLayout = {}; 

const container = document.getElementById('network');
const statusSpan = document.getElementById('status');
const docTitle = document.getElementById('doc-title');
const docIdDisplay = document.getElementById('doc-id');
const docIntro = document.getElementById('doc-intro');

// --- CONSTANTS (SCALED UP 100x) ---
const SCALAR = 100; 

const BASE_ROOT_RADIUS = 300 * SCALAR;     
const DEPTH_STEP = 400 * SCALAR;           
const MAX_NODE_SIZE = 250 * SCALAR;        
const PADDING_FACTOR = 0.9; 

const options = {
    nodes: {
        shape: 'dot',
        font: {
            size: 20 * SCALAR, 
            face: 'Arial',
            color: '#000000',
            strokeWidth: 4 * SCALAR, 
            strokeColor: '#ffffff',
            vadjust: -60 * SCALAR
        },
        borderWidth: 0, 
        shadow: false,
        scaling: {
            min: 10, max: MAX_NODE_SIZE, 
            label: { enabled: false } 
        }
    },
    edges: {
        // CHANGED: Reduced from 3 to 0.5 for performance & clarity
        width: 0.5 * SCALAR, 
        color: { color: '#888888', opacity: 0.3 }, 
        smooth: false, 
        arrows: { to: { enabled: false } }
    },
    physics: { enabled: false }, 
    interaction: {
        dragNodes: false,
        hover: true,
        zoomView: true,
        zoomSpeed: 0.5 
    }
};

// --- MATH HELPERS ---

function getMass(node) {
    return 1 + (node.descendant_count || 0);
}

function getColor(mass) {
    if (mass < 2) return '#a2cffe';      
    if (mass < 20) return '#6ea8fe';     
    if (mass < 100) return '#3b82f6';    
    if (mass < 500) return '#f97316';    
    return '#ef4444';                    
}

function calculateStrictSize(mass, ringRadius, angleSpan) {
    const importanceRadius = (10 + (Math.log(mass) * 15)) * SCALAR;
    const availableArc = ringRadius * angleSpan;
    const geometricMaxRadius = (availableArc * PADDING_FACTOR) / 2;
    return Math.min(importanceRadius, geometricMaxRadius, MAX_NODE_SIZE);
}

// --- SEMANTIC ZOOM ---

let zoomTimeout = null;
function handleZoom() {
    if (!network) return;
    if (zoomTimeout) clearTimeout(zoomTimeout);
    
    zoomTimeout = setTimeout(() => {
        const scale = network.getScale();
        const updates = [];
        
        nodes.forEach(node => {
            const screenRadius = node.size * scale;
            
            // Rule 1: Visibility
            // Always show nodes (allow sub-pixel rendering)
            let hidden = false; 

            // Rule 2: Labels
            // Threshold: > 15px visual size
            let label = undefined;
            if (screenRadius > 15) {
                label = node.data.originalLabel;
            }

            if (node.hidden !== hidden || node.label !== label) {
                updates.push({ id: node.id, hidden: hidden, label: label });
            }
        });

        if (updates.length > 0) nodes.update(updates);
    }, 50);
}

// --- CORE LAYOUT ---

async function init() {
    statusSpan.textContent = 'Loading...';
    nodes.clear();
    edges.clear();
    expandedNodes.clear();
    
    try {
        const res = await fetch(`${API_BASE}/graph/roots`);
        if(!res.ok) throw new Error("Failed");
        const rootNodes = await res.json();

        // 1. Dynamic Root Ring
        const minPerRoot = 20 * SCALAR; 
        const requiredCircumference = rootNodes.length * minPerRoot;
        const requiredRadius = requiredCircumference / (2 * Math.PI);
        const radius = Math.max(BASE_ROOT_RADIUS, requiredRadius);

        const totalMass = rootNodes.reduce((sum, n) => sum + getMass(n), 0);
        
        let currentAngle = 0;
        const newNodes = [];

        rootNodes.forEach(node => {
            const mass = getMass(node);
            const fraction = mass / totalMass;
            const angleSpan = fraction * 2 * Math.PI;

            const startAngle = currentAngle;
            const endAngle = currentAngle + angleSpan;
            
            nodeLayout[node.id] = {
                startAngle, endAngle, angleSpan,
                depthRadius: radius,
                mass
            };

            const midAngle = startAngle + (angleSpan / 2);
            const r_pos = rootNodes.length > 1 ? radius : 0;
            const x = r_pos * Math.cos(midAngle);
            const y = r_pos * Math.sin(midAngle);
            
            const size = r_pos > 0 ? calculateStrictSize(mass, r_pos, angleSpan) : MAX_NODE_SIZE;

            newNodes.push({
                id: node.id,
                label: undefined, 
                title: `${node.title}`,
                size: size,
                color: { background: getColor(mass) }, 
                x: x, y: y,
                data: { ...node, originalLabel: node.label }
            });

            currentAngle += angleSpan;
        });

        nodes.add(newNodes);
        
        const data = { nodes, edges };
        network = new vis.Network(container, data, options);
        
        network.moveTo({ scale: 0.005 }); 
        
        network.on("click", p => { if(p.nodes.length) fetchDetails(p.nodes[0]); });
        network.on("doubleClick", p => { if(p.nodes.length) expandNode(p.nodes[0]); });
        
        network.on("zoom", handleZoom);
        network.on("dragEnd", handleZoom);
        network.on("afterDrawing", () => { network.off("afterDrawing"); handleZoom(); });

        statusSpan.textContent = `Ready (${rootNodes.length} roots)`;
        network.fit(); 

    } catch (e) {
        console.error(e);
        statusSpan.textContent = 'Error.';
    }
}

async function expandNode(parentId) {
    if (expandedNodes.has(parentId)) return;
    
    statusSpan.textContent = 'Expanding...';
    try {
        const res = await fetch(`${API_BASE}/graph/children/${parentId}`);
        if(!res.ok) throw new Error("Failed");
        const children = await res.json();

        if (children.length === 0) {
            statusSpan.textContent = 'No children.';
            return;
        }

        const pLayout = nodeLayout[parentId];
        if (!pLayout) return;

        const totalChildMass = children.reduce((sum, c) => sum + getMass(c), 0);
        
        const newRadius = pLayout.depthRadius + DEPTH_STEP;

        let currentAngle = pLayout.startAngle;
        const newNodes = [];
        const newEdges = [];

        children.forEach(child => {
            const mass = getMass(child);
            const fraction = mass / totalChildMass;
            const angleSpan = fraction * pLayout.angleSpan;

            const startAngle = currentAngle;
            const endAngle = currentAngle + angleSpan;

            nodeLayout[child.id] = {
                startAngle, endAngle, angleSpan,
                depthRadius: newRadius,
                mass
            };

            const midAngle = startAngle + (angleSpan / 2);
            const x = newRadius * Math.cos(midAngle);
            const y = newRadius * Math.sin(midAngle);
            
            const size = calculateStrictSize(mass, newRadius, angleSpan);

            newNodes.push({
                id: child.id,
                label: undefined,
                title: `${child.title}`,
                size: size,
                color: { background: getColor(mass) }, 
                x: x, y: y,
                data: { ...child, originalLabel: child.label }
            });

            newEdges.push({ from: parentId, to: child.id });
            currentAngle += angleSpan;
        });

        nodes.add(newNodes);
        edges.add(newEdges);
        expandedNodes.add(parentId);
        
        statusSpan.textContent = 'Ready';
        handleZoom(); 

    } catch (e) {
        console.error(e);
        statusSpan.textContent = "Error expanding.";
    }
}

async function fetchDetails(nodeId) {
    const n = nodes.get(nodeId);
    if(n) {
        docTitle.textContent = n.data.title;
        docIntro.textContent = "Loading...";
    }
    try {
        const res = await fetch(`${API_BASE}/node/${nodeId}`);
        const data = await res.json();
        docTitle.textContent = data.title;
        docIdDisplay.textContent = data.str_id;
        docIntro.innerText = data.intro;
    } catch(e) {
        docIntro.textContent = "Error loading content.";
    }
}

document.getElementById('reset-btn').addEventListener('click', init);
init();

