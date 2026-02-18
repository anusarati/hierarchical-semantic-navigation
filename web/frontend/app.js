const API_BASE = "/api";
const SENTINEL_ID = -1;

const LAYER_MAX_ITEMS = 80;
const TOP_REAL_ITEMS = 40;
const BUCKET_TARGET_SIZE = 30;
const SEARCH_LIMIT = 10;

const CENTER_VIS_ID = "center-node";
const ROOT_TITLE = "All Documents";

const CENTER_SIZE = 88;
const CHILD_SIZE_MIN = 26;
const CHILD_SIZE_MAX = 72;
const BUCKET_SIZE_MIN = 30;
const BUCKET_SIZE_MAX = 68;
const BASE_RING_RADIUS = 360;
const RING_PADDING = 24;

const nodeSet = new vis.DataSet();
const edgeSet = new vis.DataSet();
let network = null;

const container = document.getElementById("network");
const statusSpan = document.getElementById("status");
const docTitle = document.getElementById("doc-title");
const docIdDisplay = document.getElementById("doc-id");
const docIntro = document.getElementById("doc-intro");
const hoverTitle = document.getElementById("hover-title");
const hoverIntro = document.getElementById("hover-intro");

const breadcrumbEl = document.getElementById("breadcrumb");
const backBtn = document.getElementById("back-btn");
const forwardBtn = document.getElementById("forward-btn");
const upBtn = document.getElementById("up-btn");
const resetBtn = document.getElementById("reset-btn");

const searchInput = document.getElementById("search-input");
const searchResultsEl = document.getElementById("search-results");

const networkOptions = {
	nodes: {
		shape: "dot",
		borderWidth: 0,
		shadow: false,
		font: {
			face: "Arial",
			color: "#111827",
			strokeColor: "#ffffff",
			strokeWidth: 2,
			size: 18,
			align: "center",
			multi: true,
		},
	},
	edges: {
		color: { color: "#a6b3c5", opacity: 0.28 },
		width: 0.9,
		smooth: false,
		arrows: { to: { enabled: false } },
	},
	physics: { enabled: false },
	interaction: {
		dragNodes: false,
		dragView: true,
		hover: true,
		zoomView: true,
		zoomSpeed: 0.45,
	},
};

const childrenCache = new Map();
const detailsCache = new Map();
const pathCache = new Map();

let currentCenterId = SENTINEL_ID;
let activeBucketContext = null;
let currentPath = [];
let currentLayerItems = [];
let highlightedNodeId = null;

const historyBack = [];
const historyForward = [];

let searchDebounce = null;
let searchResults = [];
let searchRequestToken = 0;
let hoverToken = 0;
let renderToken = 0;
let didDragView = false;
let isViewDragging = false;

function setStatus(text) {
	statusSpan.textContent = text;
}

function clipText(text, maxLength = 360) {
	if (!text) {
		return "";
	}
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function wrapLabel(text, charsPerLine = 16) {
	if (!text) {
		return "";
	}
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return text;
	}

	const lines = [];
	let line = "";

	const pushLongToken = (token) => {
		let idx = 0;
		while (idx < token.length) {
			lines.push(token.slice(idx, idx + charsPerLine));
			idx += charsPerLine;
		}
	};

	for (const word of words) {
		if (word.length > charsPerLine) {
			if (line) {
				lines.push(line);
				line = "";
			}
			pushLongToken(word);
			continue;
		}

		if (!line) {
			line = word;
			continue;
		}

		if (line.length + 1 + word.length <= charsPerLine) {
			line = `${line} ${word}`;
		} else {
			lines.push(line);
			line = word;
		}
	}

	if (line) {
		lines.push(line);
	}

	return lines.join("\n");
}

function getWrappedLabelSpec(rawLabel, nodeSize, isCenter = false) {
	const minFont = isCenter ? 10 : 8;
	const maxFont = isCenter ? 24 : 18;
	const widthFactor = isCenter ? 1.55 : 1.9;
	const heightFactor = isCenter ? 1.25 : 1.12;
	const maxChars = isCenter ? 24 : 30;
	const minChars = 8;

	let fontSize = Math.min(maxFont, Math.max(minFont, nodeSize * (isCenter ? 0.23 : 0.2)));
	let wrapped = rawLabel || "";
	let lineCount = 1;

	for (let i = 0; i < 3; i += 1) {
		const maxTextWidth = Math.max(36, nodeSize * widthFactor);
		const charsPerLine = Math.max(
			minChars,
			Math.min(maxChars, Math.floor(maxTextWidth / Math.max(1, fontSize * 0.56))),
		);
		wrapped = wrapLabel(rawLabel, charsPerLine);
		lineCount = Math.max(1, wrapped.split("\n").length);

		const maxTextHeight = Math.max(26, nodeSize * heightFactor);
		const neededHeight = lineCount * fontSize * 1.15;
		if (neededHeight <= maxTextHeight) {
			break;
		}

		fontSize = Math.max(minFont, fontSize * (maxTextHeight / neededHeight));
	}

	// Dot labels are anchored below the node; move the full multiline block up into center.
	const vadjust = -(nodeSize + 6) - ((lineCount - 1) * fontSize * 0.52);
	return { wrapped, lineCount, fontSize, vadjust };
}

function getMass(item) {
	return 1 + (item.descendant_count || 0);
}

function getNodeColor(item) {
	const mass = getMass(item);
	if (item.kind === "bucket") {
		return "#9ca3af";
	}
	if (mass < 3) {
		return "#93c5fd";
	}
	if (mass < 20) {
		return "#60a5fa";
	}
	if (mass < 120) {
		return "#3b82f6";
	}
	if (mass < 600) {
		return "#2563eb";
	}
	if (mass < 1500) {
		return "#f59e0b";
	}
	return "#ef4444";
}

function getCenterTitleForLabel() {
	if (currentCenterId === SENTINEL_ID) {
		return ROOT_TITLE;
	}
	if (currentPath.length > 0) {
		return currentPath[currentPath.length - 1].title;
	}
	return `Node ${currentCenterId}`;
}

function formatBucketLabel(start, endExclusive) {
	return `More (${start + 1}-${endExclusive})`;
}

function bucketVisId(parentId, start, endExclusive) {
	return `bucket:${parentId}:${start}:${endExclusive}`;
}

function cloneBucketContext(context) {
	if (!context) {
		return null;
	}
	return {
		parentId: context.parentId,
		start: context.start,
		end: context.end,
		label: context.label,
		bucketId: context.bucketId,
	};
}

function snapshotState() {
	return {
		centerId: currentCenterId,
		bucket: cloneBucketContext(activeBucketContext),
		highlightedNodeId,
	};
}

async function apiGetJson(path) {
	const response = await fetch(path);
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`${response.status}: ${body || "request failed"}`);
	}
	return response.json();
}

async function fetchChildren(parentId) {
	if (childrenCache.has(parentId)) {
		return childrenCache.get(parentId);
	}
	const endpoint =
		parentId === SENTINEL_ID
			? `${API_BASE}/graph/roots`
			: `${API_BASE}/graph/children/${parentId}`;
	const data = await apiGetJson(endpoint);
	childrenCache.set(parentId, data);
	return data;
}

async function fetchNodeDetails(nodeId) {
	if (detailsCache.has(nodeId)) {
		return detailsCache.get(nodeId);
	}
	const data = await apiGetJson(`${API_BASE}/node/${nodeId}`);
	detailsCache.set(nodeId, data);
	return data;
}

async function fetchPath(nodeId) {
	if (nodeId === SENTINEL_ID) {
		return [];
	}
	if (pathCache.has(nodeId)) {
		return pathCache.get(nodeId);
	}
	const data = await apiGetJson(`${API_BASE}/graph/path/${nodeId}`);
	pathCache.set(nodeId, data.path || []);
	return data.path || [];
}

async function showDescriptionForNode(nodeId) {
	if (nodeId === SENTINEL_ID) {
		docTitle.textContent = ROOT_TITLE;
		docIdDisplay.textContent = "root";
		docIntro.textContent =
			"Top-level semantic clusters. Double-click a node to recursively drill into its children.";
		return;
	}

	try {
		const detail = await fetchNodeDetails(nodeId);
		docTitle.textContent = detail.title;
		docIdDisplay.textContent = detail.str_id;
		docIntro.textContent = detail.intro || "(No content available)";
	} catch (_error) {
		docTitle.textContent = `Node ${nodeId}`;
		docIdDisplay.textContent = `id:${nodeId}`;
		docIntro.textContent = "Failed to load node details.";
	}
}

function ensureNetwork() {
	if (network) {
		return;
	}
	network = new vis.Network(
		container,
		{ nodes: nodeSet, edges: edgeSet },
		networkOptions,
	);

	network.on("click", async (params) => {
		if (didDragView) {
			didDragView = false;
			return;
		}
		if (!params.nodes.length) {
			await showDescriptionForNode(currentCenterId);
			return;
		}
		const clicked = nodeSet.get(params.nodes[0]);
		if (!clicked || !clicked.data) {
			return;
		}
		const data = clicked.data;
		if (data.kind === "real") {
			await showDescriptionForNode(data.realId);
			return;
		}
		if (data.kind === "bucket") {
			docTitle.textContent = data.label;
			docIdDisplay.textContent = `bucket:${data.start + 1}-${data.end}`;
			docIntro.textContent =
				"Bucketed subset. Double-click to open this group of children.";
			return;
		}
		await showDescriptionForNode(currentCenterId);
	});

	network.on("doubleClick", async (params) => {
		if (didDragView) {
			didDragView = false;
			return;
		}
		if (!params.nodes.length) {
			return;
		}
		const clicked = nodeSet.get(params.nodes[0]);
		if (!clicked || !clicked.data) {
			return;
		}
		const data = clicked.data;
		if (data.kind === "real") {
			await navigateTo(data.realId, null, {
				pushHistory: true,
				clearForward: true,
				highlight: null,
			});
			return;
		}
		if (data.kind === "bucket") {
			await navigateTo(
				currentCenterId,
				{
					parentId: currentCenterId,
					start: data.start,
					end: data.end,
					label: data.label,
					bucketId: data.bucketId,
				},
				{
					pushHistory: true,
					clearForward: true,
					highlight: null,
				},
			);
		}
	});

	network.on("hoverNode", async (params) => {
		const hovered = nodeSet.get(params.node);
		if (!hovered || !hovered.data) {
			return;
		}
		hoverToken += 1;
		const token = hoverToken;
		const data = hovered.data;
		if (data.kind === "real") {
			try {
				const detail = await fetchNodeDetails(data.realId);
				if (token !== hoverToken) {
					return;
				}
				hoverTitle.textContent = detail.title;
				hoverIntro.textContent = clipText(detail.intro || "(No preview available)");
			} catch (_error) {
				if (token !== hoverToken) {
					return;
				}
				hoverTitle.textContent = "Preview unavailable";
				hoverIntro.textContent = "Could not load preview for this node.";
			}
			return;
		}
		if (data.kind === "bucket") {
			hoverTitle.textContent = data.label;
			hoverIntro.textContent = `Contains ${data.count} children. Click to drill into this subset.`;
			return;
		}
		hoverTitle.textContent = "Hover a child node for a preview.";
		hoverIntro.textContent =
			"The sidebar above always shows the current focus node. Preview text appears here.";
	});

	network.on("blurNode", () => {
		hoverToken += 1;
		hoverTitle.textContent = "Hover a child node for a preview.";
		hoverIntro.textContent =
			"The sidebar above always shows the current focus node. Preview text appears here.";
	});

	network.on("zoom", updateLabelVisibility);
	network.on("animationFinished", updateLabelVisibility);
	network.on("dragStart", (params) => {
		isViewDragging = true;
	});
	network.on("dragEnd", () => {
		if (isViewDragging) {
			didDragView = true;
		}
		isViewDragging = false;
		updateLabelVisibility();
	});
}

function normalizeSize(value, minValue, maxValue, minSize, maxSize) {
	if (maxValue <= minValue) {
		return (minSize + maxSize) / 2;
	}
	const ratio = (value - minValue) / (maxValue - minValue);
	return minSize + ratio * (maxSize - minSize);
}

function buildBucketEntry(parentId, start, endExclusive, subset) {
	const bucketMass = subset.reduce((sum, item) => sum + getMass(item), 0);
	return {
		kind: "bucket",
		parentId,
		start,
		end: endExclusive,
		count: subset.length,
		label: formatBucketLabel(start, endExclusive),
		bucketId: bucketVisId(parentId, start, endExclusive),
		descendant_count: bucketMass,
	};
}

function toRealEntry(item) {
	const fullLabel = item.label || item.title;
	return {
		kind: "real",
		id: item.id,
		label: fullLabel,
		fullLabel,
		title: item.title,
		has_children: item.has_children,
		descendant_count: item.descendant_count || 0,
	};
}

function buildLayerEntries(parentId, children) {
	if (children.length <= LAYER_MAX_ITEMS) {
		return children.map(toRealEntry);
	}

	const topReal = children.slice(0, TOP_REAL_ITEMS).map(toRealEntry);
	const remaining = children.slice(topReal.length);
	if (remaining.length === 0) {
		return topReal;
	}

	const maxBucketSlots = Math.max(1, LAYER_MAX_ITEMS - topReal.length);
	const minBucketsForLayerCap = Math.ceil(remaining.length / LAYER_MAX_ITEMS);
	const preferredBuckets = Math.ceil(remaining.length / BUCKET_TARGET_SIZE);
	let bucketCount = Math.max(1, minBucketsForLayerCap, preferredBuckets);
	bucketCount = Math.min(bucketCount, maxBucketSlots, remaining.length);

	const bucketSize = Math.ceil(remaining.length / bucketCount);
	const buckets = [];

	for (let i = 0; i < bucketCount; i += 1) {
		const start = topReal.length + i * bucketSize;
		if (start >= children.length) {
			break;
		}
		const endExclusive = Math.min(children.length, start + bucketSize);
		const subset = children.slice(start, endExclusive);
		buckets.push(buildBucketEntry(parentId, start, endExclusive, subset));
	}

	return [...topReal, ...buckets];
}

function getBucketForChild(parentId, children, childId) {
	if (children.length <= LAYER_MAX_ITEMS) {
		return null;
	}

	const childIndex = children.findIndex((item) => item.id === childId);
	if (childIndex === -1 || childIndex < TOP_REAL_ITEMS) {
		return null;
	}

	const entries = buildLayerEntries(parentId, children);
	for (const entry of entries) {
		if (entry.kind !== "bucket") {
			continue;
		}
		if (childIndex >= entry.start && childIndex < entry.end) {
			return {
				parentId,
				start: entry.start,
				end: entry.end,
				label: entry.label,
				bucketId: entry.bucketId,
			};
		}
	}
	return null;
}

function buildEntriesForCurrentView(children) {
	if (
		activeBucketContext &&
		activeBucketContext.parentId === currentCenterId &&
		activeBucketContext.start >= 0
	) {
		return children
			.slice(activeBucketContext.start, activeBucketContext.end)
			.map(toRealEntry);
	}
	return buildLayerEntries(currentCenterId, children);
}

function renderBreadcrumb() {
	breadcrumbEl.innerHTML = "";

	const createSeparator = () => {
		const sep = document.createElement("span");
		sep.className = "crumb-sep";
		sep.textContent = ">";
		return sep;
	};

	const createCrumb = (label, isCurrent, onClick, extraClass = "") => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `crumb ${isCurrent ? "current" : ""} ${extraClass}`.trim();
		button.textContent = label;
		if (onClick) {
			button.addEventListener("click", onClick);
		} else {
			button.disabled = true;
		}
		return button;
	};

	const isRootCurrent = currentCenterId === SENTINEL_ID && !activeBucketContext;
	breadcrumbEl.appendChild(
		createCrumb(ROOT_TITLE, isRootCurrent, isRootCurrent ? null : () => {
			void navigateTo(SENTINEL_ID, null, {
				pushHistory: true,
				clearForward: true,
				highlight: null,
			});
		}),
	);

	for (let i = 0; i < currentPath.length; i += 1) {
		const crumb = currentPath[i];
		const isLast = i === currentPath.length - 1;
		const isCurrent = isLast && !activeBucketContext;
		breadcrumbEl.appendChild(createSeparator());
		breadcrumbEl.appendChild(
			createCrumb(crumb.title, isCurrent, isCurrent ? null : () => {
				void navigateTo(crumb.id, null, {
					pushHistory: true,
					clearForward: true,
					highlight: null,
				});
			}),
		);
	}

	if (activeBucketContext) {
		breadcrumbEl.appendChild(createSeparator());
		breadcrumbEl.appendChild(
			createCrumb(activeBucketContext.label, true, null, "bucket"),
		);
	}
}

function updateNavButtons() {
	backBtn.disabled = historyBack.length === 0;
	forwardBtn.disabled = historyForward.length === 0;
	upBtn.disabled = currentCenterId === SENTINEL_ID && !activeBucketContext;
}

async function renderCenterDetails() {
	await showDescriptionForNode(currentCenterId);
}

function updateLabelVisibility() {
	if (!network) {
		return;
	}
	const scale = network.getScale();
	const updates = [];

	nodeSet.forEach((node) => {
		const data = node.data || {};
		const baseLabel = data.baseLabel || "";
		const lineCount = data.lineCount || (baseLabel ? baseLabel.split("\n").length : 1);
		const renderedFontPx = (node.font?.size || 12) * scale;
		const pixelDiameter = (node.size || 0) * scale * 2;

		let nextLabel = baseLabel;
		if (data.kind === "center") {
			if (renderedFontPx < 6.0 || pixelDiameter < 14) {
				nextLabel = undefined;
			}
		} else {
			const minFontPx = 5.2 + Math.min(1.8, lineCount * 0.22);
			const minDiameter = 9 + Math.min(14, lineCount * 3);
			if (renderedFontPx < minFontPx || pixelDiameter < minDiameter) {
				nextLabel = undefined;
			}
		}

		if (node.label !== nextLabel) {
			updates.push({ id: node.id, label: nextLabel });
		}
	});

	if (updates.length > 0) {
		nodeSet.update(updates);
	}
}

function drawLayer(entries) {
	nodeSet.clear();
	edgeSet.clear();

	const masses = entries.map((entry) => Math.log1p(getMass(entry)));
	const minMass = masses.length ? Math.min(...masses) : 0;
	const maxMass = masses.length ? Math.max(...masses) : 1;

	const centerRawLabel = getCenterTitleForLabel();
	const centerSpec = getWrappedLabelSpec(centerRawLabel, CENTER_SIZE, true);
	nodeSet.add({
		id: CENTER_VIS_ID,
		label: undefined,
		title: centerRawLabel,
		size: CENTER_SIZE,
		color: { background: "#ef4444", border: "#b91c1c" },
		borderWidth: 3,
		x: 0,
		y: 0,
		font: {
			face: "Arial",
			size: centerSpec.fontSize,
			strokeWidth: 2,
			vadjust: centerSpec.vadjust,
			align: "center",
			multi: true,
		},
		data: {
			kind: "center",
			baseLabel: centerSpec.wrapped,
			lineCount: centerSpec.lineCount,
		},
	});

	const maxNodeSize = entries.reduce((maxValue, entry, index) => {
		const logMass = masses[index] || 0;
		const size =
			entry.kind === "bucket"
				? normalizeSize(
						logMass,
						minMass,
						maxMass,
						BUCKET_SIZE_MIN,
						BUCKET_SIZE_MAX,
					)
				: normalizeSize(
						logMass,
						minMass,
						maxMass,
						CHILD_SIZE_MIN,
						CHILD_SIZE_MAX,
					);
		return Math.max(maxValue, size);
	}, CHILD_SIZE_MAX);

	const requiredCircumference =
		entries.length > 0 ? entries.length * (maxNodeSize * 2 + RING_PADDING) : 0;
	const ringRadius =
		entries.length > 1
			? Math.max(BASE_RING_RADIUS, requiredCircumference / (2 * Math.PI))
			: BASE_RING_RADIUS;

	entries.forEach((entry, index) => {
		const angle =
			entries.length === 1
				? -Math.PI / 2
				: -Math.PI / 2 + (index / entries.length) * 2 * Math.PI;
		const x = ringRadius * Math.cos(angle);
		const y = ringRadius * Math.sin(angle);
		const logMass = masses[index] || 0;

		const size =
			entry.kind === "bucket"
				? normalizeSize(
						logMass,
						minMass,
						maxMass,
						BUCKET_SIZE_MIN,
						BUCKET_SIZE_MAX,
					)
				: normalizeSize(
						logMass,
						minMass,
						maxMass,
						CHILD_SIZE_MIN,
						CHILD_SIZE_MAX,
					);

		const nodeId = entry.kind === "bucket" ? entry.bucketId : entry.id;
		const isHighlighted =
			entry.kind === "real" && highlightedNodeId !== null && entry.id === highlightedNodeId;

		const rawLabel =
			entry.kind === "bucket" ? entry.label : (entry.fullLabel || entry.label);
		const labelSpec = getWrappedLabelSpec(rawLabel, size, false);
		const nodeData =
			entry.kind === "bucket"
				? {
						kind: "bucket",
						start: entry.start,
						end: entry.end,
						count: entry.count,
						label: entry.label,
						bucketId: entry.bucketId,
						baseLabel: labelSpec.wrapped,
						lineCount: labelSpec.lineCount,
					}
				: {
						kind: "real",
						realId: entry.id,
						baseLabel: labelSpec.wrapped,
						lineCount: labelSpec.lineCount,
					};

		nodeSet.add({
			id: nodeId,
			label: undefined,
			title:
				entry.kind === "bucket"
					? `${entry.label} (${entry.count})`
					: entry.fullLabel || rawLabel,
			size,
			x,
			y,
			color: {
				background: getNodeColor(entry),
				border: isHighlighted ? "#16a34a" : "#1e293b",
			},
			borderWidth: isHighlighted ? 4 : entry.kind === "bucket" ? 2 : 1,
			font: {
				face: "Arial",
				size: labelSpec.fontSize,
				strokeWidth: 2,
				vadjust: labelSpec.vadjust,
				align: "center",
				multi: true,
			},
			data: nodeData,
		});

		edgeSet.add({
			from: CENTER_VIS_ID,
			to: nodeId,
			dashes: entry.kind === "bucket",
			color:
				entry.kind === "bucket"
					? "rgba(156, 163, 175, 0.38)"
					: "rgba(148, 163, 184, 0.26)",
			width: entry.kind === "bucket" ? 1.0 : 0.8,
		});
	});

	if (network) {
		network.fit({ animation: false });
	}
	setTimeout(updateLabelVisibility, 40);
}

async function renderCurrentLayer(token) {
	setStatus("Loading layer...");
	try {
		const children = await fetchChildren(currentCenterId);
		if (token !== renderToken) {
			return;
		}

		currentPath = await fetchPath(currentCenterId);
		if (token !== renderToken) {
			return;
		}

		currentLayerItems = buildEntriesForCurrentView(children);
		renderBreadcrumb();
		updateNavButtons();
		drawLayer(currentLayerItems);
		await renderCenterDetails();
		if (token !== renderToken) {
			return;
		}

		const contextLabel = activeBucketContext
			? ` | ${activeBucketContext.label}`
			: "";
		setStatus(`Ready (${currentLayerItems.length} items${contextLabel})`);

			// Avoid camera auto-focus loops; highlight is represented by node border only.
		} catch (error) {
		console.error(error);
		setStatus("Error loading layer.");
	}
}

async function navigateTo(
	centerId,
	bucketContext,
	{ pushHistory = true, clearForward = true, highlight = null } = {},
) {
	if (pushHistory) {
		historyBack.push(snapshotState());
	}
	if (clearForward) {
		historyForward.length = 0;
	}

	currentCenterId = centerId;
	activeBucketContext = cloneBucketContext(bucketContext);
	highlightedNodeId = highlight;

	renderToken += 1;
	const token = renderToken;
	await renderCurrentLayer(token);
}

async function goBack() {
	if (historyBack.length === 0) {
		return;
	}
	const prev = historyBack.pop();
	historyForward.push(snapshotState());
	await navigateTo(prev.centerId, prev.bucket, {
		pushHistory: false,
		clearForward: false,
		highlight: prev.highlightedNodeId,
	});
}

async function goForward() {
	if (historyForward.length === 0) {
		return;
	}
	const next = historyForward.pop();
	historyBack.push(snapshotState());
	await navigateTo(next.centerId, next.bucket, {
		pushHistory: false,
		clearForward: false,
		highlight: next.highlightedNodeId,
	});
}

async function goUp() {
	if (activeBucketContext) {
		await navigateTo(currentCenterId, null, {
			pushHistory: true,
			clearForward: true,
			highlight: null,
		});
		return;
	}
	if (currentCenterId === SENTINEL_ID) {
		return;
	}
	const oldCenter = currentCenterId;
	const path = await fetchPath(currentCenterId);
	const parentId = path.length > 1 ? path[path.length - 2].id : SENTINEL_ID;
	await navigateTo(parentId, null, {
		pushHistory: true,
		clearForward: true,
		highlight: oldCenter,
	});
}

async function resetView() {
	historyBack.length = 0;
	historyForward.length = 0;
	highlightedNodeId = null;
	activeBucketContext = null;
	currentCenterId = SENTINEL_ID;
	renderToken += 1;
	await renderCurrentLayer(renderToken);
}

function hideSearchResults() {
	searchResultsEl.classList.add("hidden");
	searchResultsEl.innerHTML = "";
	searchResults = [];
}

function renderSearchResults(items) {
	searchResultsEl.innerHTML = "";
	if (!items || items.length === 0) {
		const empty = document.createElement("div");
		empty.className = "search-empty";
		empty.textContent = "No matching titles.";
		searchResultsEl.appendChild(empty);
		searchResultsEl.classList.remove("hidden");
		return;
	}

	for (const hit of items) {
		const itemBtn = document.createElement("button");
		itemBtn.type = "button";
		itemBtn.className = "search-item";
		const titleEl = document.createElement("div");
		titleEl.className = "search-item-title";
		titleEl.textContent = hit.title;

		const idEl = document.createElement("div");
		idEl.className = "search-item-id";
		idEl.textContent = hit.str_id;

		itemBtn.appendChild(titleEl);
		itemBtn.appendChild(idEl);
		itemBtn.addEventListener("click", () => {
			void jumpToSearchHit(hit);
		});
		searchResultsEl.appendChild(itemBtn);
	}
	searchResultsEl.classList.remove("hidden");
}

async function runSearch(query) {
	const token = ++searchRequestToken;
	try {
		const encoded = encodeURIComponent(query);
		const items = await apiGetJson(
			`${API_BASE}/search?q=${encoded}&limit=${SEARCH_LIMIT}`,
		);
		if (token !== searchRequestToken || searchInput.value.trim() !== query) {
			return;
		}
		searchResults = items;
		renderSearchResults(items);
	} catch (error) {
		if (token !== searchRequestToken || searchInput.value.trim() !== query) {
			return;
		}
		console.error(error);
		searchResultsEl.innerHTML = '<div class="search-empty">Search failed.</div>';
		searchResultsEl.classList.remove("hidden");
	}
}

function onSearchInput() {
	const query = searchInput.value.trim();
	if (!query) {
		searchRequestToken += 1;
		hideSearchResults();
		return;
	}

	if (searchDebounce) {
		clearTimeout(searchDebounce);
	}
	searchDebounce = setTimeout(() => {
		void runSearch(query);
	}, 180);
}

async function jumpToSearchHit(hit) {
	hideSearchResults();
	const parentId =
		typeof hit.parent_id === "number" ? hit.parent_id : SENTINEL_ID;

	setStatus("Jumping to result...");
	const children = await fetchChildren(parentId);
	const bucket = getBucketForChild(parentId, children, hit.node_id);
	await navigateTo(parentId, bucket, {
		pushHistory: true,
		clearForward: true,
		highlight: hit.node_id,
	});
}

function bindUi() {
	backBtn.addEventListener("click", () => {
		void goBack();
	});
	forwardBtn.addEventListener("click", () => {
		void goForward();
	});
	upBtn.addEventListener("click", () => {
		void goUp();
	});
	resetBtn.addEventListener("click", () => {
		void resetView();
	});

	searchInput.addEventListener("input", onSearchInput);
	searchInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			hideSearchResults();
		}
		if (event.key === "Enter" && searchResults.length > 0) {
			event.preventDefault();
			void jumpToSearchHit(searchResults[0]);
		}
	});

	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!searchResultsEl.contains(target) && target !== searchInput) {
			hideSearchResults();
		}
	});
}

async function init() {
	ensureNetwork();
	bindUi();
	updateNavButtons();
	await resetView();
}

void init();
