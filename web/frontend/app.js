import { ROOT_TITLE, SEARCH_LIMIT, SENTINEL_ID } from "./lib/constants.js";
import {
	getChildren,
	getNodeDetails,
	getNodePath,
	searchTitles,
} from "./lib/api.js";
import {
	getRefs,
	hideSearchResults,
	renderBreadcrumb,
	renderColumns,
	renderDetails,
	renderSearchResults,
	renderSunburst,
	setStatus,
	setViewMode,
	updateNavButtons,
} from "./lib/ui.js";

const refs = getRefs();
const SUNBURST_MAX_DEPTH = 4;
const SUNBURST_MAX_CHILDREN = 120;
const SUNBURST_MIN_SHARE = 0.006;
const SUNBURST_BRANCH_EXPAND_LIMIT = 28;

const state = {
	pathIds: [],
	historyBack: [],
	historyForward: [],
	renderToken: 0,
	searchToken: 0,
	searchDebounce: null,
	viewMode: "columns",
};

function arraysEqual(a, b) {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

function currentNodeId() {
	return state.pathIds.length > 0 ? state.pathIds[state.pathIds.length - 1] : SENTINEL_ID;
}

function snapshotPath() {
	return [...state.pathIds];
}

function aggregateNodes(items) {
	if (!items.length) {
		return [];
	}
	const total = items.reduce((sum, item) => sum + item.value, 0);
	const kept = [];
	let mergedValue = 0;
	let mergedCount = 0;

	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		const share = total > 0 ? item.value / total : 0;
		if (index < SUNBURST_MAX_CHILDREN && share >= SUNBURST_MIN_SHARE) {
			kept.push(item);
		} else {
			mergedValue += item.value;
			mergedCount += 1;
		}
	}

	if (mergedCount > 0) {
		kept.push({
			id: null,
			title: `Other (${mergedCount.toLocaleString()})`,
			value: Math.max(1, mergedValue),
			children: [],
		});
	}
	return kept;
}

async function buildSunburstNode(nodeId, title, depth, token) {
	const base = {
		id: nodeId,
		title,
		value: 1,
		children: [],
		depth,
	};

	if (depth >= SUNBURST_MAX_DEPTH) {
		return base;
	}

	const rawChildren = await getChildren(nodeId);
	if (token !== state.renderToken || rawChildren.length === 0) {
		return base;
	}

	const weightedChildren = rawChildren.map((child) => ({
		id: child.id,
		title: child.title,
		value: Math.max(1, child.descendant_count + 1),
		hasChildren: child.has_children,
		children: [],
		depth: depth + 1,
	}));

	const compactChildren = aggregateNodes(weightedChildren);
	const expandable = compactChildren.slice(0, SUNBURST_BRANCH_EXPAND_LIMIT);
	for (const child of expandable) {
		if (!child.id || !child.hasChildren || depth + 1 >= SUNBURST_MAX_DEPTH) {
			continue;
		}
		const hydrated = await buildSunburstNode(child.id, child.title, depth + 1, token);
		if (token !== state.renderToken) {
			return base;
		}
		child.children = hydrated.children;
	}

	base.children = compactChildren;
	base.value = Math.max(1, compactChildren.reduce((sum, child) => sum + child.value, 0));
	return base;
}

async function buildColumns(pathIds, token) {
	const columns = [];

	let items = await getChildren(SENTINEL_ID);
	if (token !== state.renderToken) {
		return null;
	}
	columns.push({
		parentId: SENTINEL_ID,
		parentTitle: ROOT_TITLE,
		items,
		selectedId: pathIds[0] ?? null,
	});

	for (let level = 0; level < pathIds.length; level += 1) {
		const parentNodeId = pathIds[level];
		const selectedItem = items.find((item) => item.id === parentNodeId);
		let parentTitle = selectedItem?.title;
		if (!parentTitle) {
			const details = await getNodeDetails(parentNodeId);
			if (token !== state.renderToken) {
				return null;
			}
			parentTitle = details.title;
		}

		items = await getChildren(parentNodeId);
		if (token !== state.renderToken) {
			return null;
		}
		columns.push({
			parentId: parentNodeId,
			parentTitle,
			items,
			selectedId: pathIds[level + 1] ?? null,
		});
	}

	return columns;
}

async function render() {
	const token = ++state.renderToken;
	setStatus("Loading...");

	try {
		const columns = await buildColumns(state.pathIds, token);
		if (!columns || token !== state.renderToken) {
			return;
		}

		renderColumns(columns, (levelIndex, nodeId) => {
			const nextPath = state.pathIds.slice(0, levelIndex).concat(nodeId);
			void setPath(nextPath, { pushHistory: true, clearForward: true });
		});

		const activeId = currentNodeId();
		const [details, path] = await Promise.all([
			getNodeDetails(activeId),
			getNodePath(activeId),
		]);

		if (token !== state.renderToken) {
			return;
		}

		renderDetails(details);
		renderBreadcrumb(path, {
			onRootClick: () => {
				void setPath([], { pushHistory: true, clearForward: true });
			},
			onCrumbClick: (crumbIndex) => {
				void setPath(state.pathIds.slice(0, crumbIndex + 1), {
					pushHistory: true,
					clearForward: true,
				});
			},
		});

		if (state.viewMode === "sunburst") {
			const tree = await buildSunburstNode(activeId, details.title, 0, token);
			if (token !== state.renderToken) {
				return;
			}
			renderSunburst(
				{ title: details.title, children: tree.children, maxDepth: SUNBURST_MAX_DEPTH },
				(nodeId) => {
					void setPath([...state.pathIds, nodeId], { pushHistory: true, clearForward: true });
				},
			);
		}

		updateNavButtons({
			canBack: state.historyBack.length > 0,
			canForward: state.historyForward.length > 0,
			canUp: state.pathIds.length > 0,
		});

		const visibleCount = columns[columns.length - 1]?.items.length ?? 0;
		setStatus(`Ready (${visibleCount.toLocaleString()} items)`);
	} catch (error) {
		console.error(error);
		setStatus("Error loading data.");
	}
}

async function setPath(nextPath, { pushHistory, clearForward }) {
	if (arraysEqual(state.pathIds, nextPath)) {
		return;
	}

	if (pushHistory) {
		state.historyBack.push(snapshotPath());
	}
	if (clearForward) {
		state.historyForward.length = 0;
	}

	state.pathIds = [...nextPath];
	await render();
}

async function goBack() {
	if (state.historyBack.length === 0) {
		return;
	}
	state.historyForward.push(snapshotPath());
	const prevPath = state.historyBack.pop();
	await setPath(prevPath, { pushHistory: false, clearForward: false });
}

async function goForward() {
	if (state.historyForward.length === 0) {
		return;
	}
	state.historyBack.push(snapshotPath());
	const nextPath = state.historyForward.pop();
	await setPath(nextPath, { pushHistory: false, clearForward: false });
}

async function goUp() {
	if (state.pathIds.length === 0) {
		return;
	}
	await setPath(state.pathIds.slice(0, -1), { pushHistory: true, clearForward: true });
}

async function resetView() {
	state.historyBack.length = 0;
	state.historyForward.length = 0;
	state.pathIds = [];
	await render();
}

async function jumpToNode(nodeId) {
	hideSearchResults();
	const path = await getNodePath(nodeId);
	const nextPath = path.map((crumb) => crumb.id);
	await setPath(nextPath, { pushHistory: true, clearForward: true });
}

async function runSearch(query) {
	const token = ++state.searchToken;
	try {
		const results = await searchTitles(query, SEARCH_LIMIT);
		if (token !== state.searchToken || refs.searchInput.value.trim() !== query.trim()) {
			return;
		}
		renderSearchResults(results, (result) => {
			void jumpToNode(result.node_id);
		});
	} catch (error) {
		if (token !== state.searchToken) {
			return;
		}
		console.error(error);
		renderSearchResults([], () => {});
	}
}

function handleSearchInput() {
	const query = refs.searchInput.value.trim();
	if (!query) {
		state.searchToken += 1;
		hideSearchResults();
		return;
	}

	if (state.searchDebounce) {
		clearTimeout(state.searchDebounce);
	}
	state.searchDebounce = setTimeout(() => {
		void runSearch(query);
	}, 180);
}

function bindEvents() {
	refs.backBtn.addEventListener("click", () => {
		void goBack();
	});
	refs.forwardBtn.addEventListener("click", () => {
		void goForward();
	});
	refs.upBtn.addEventListener("click", () => {
		void goUp();
	});
	refs.resetBtn.addEventListener("click", () => {
		void resetView();
	});
	refs.viewColumnsBtn.addEventListener("click", () => {
		if (state.viewMode === "columns") {
			return;
		}
		state.viewMode = "columns";
		setViewMode(state.viewMode);
		void render();
	});
	refs.viewSunburstBtn.addEventListener("click", () => {
		if (state.viewMode === "sunburst") {
			return;
		}
		state.viewMode = "sunburst";
		setViewMode(state.viewMode);
		void render();
	});

	refs.searchInput.addEventListener("input", handleSearchInput);
	refs.searchInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			hideSearchResults();
		}
	});

	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!refs.searchResults.contains(target) && target !== refs.searchInput) {
			hideSearchResults();
		}
	});
}

async function init() {
	bindEvents();
	setViewMode(state.viewMode);
	updateNavButtons({ canBack: false, canForward: false, canUp: false });
	await render();
}

void init();
