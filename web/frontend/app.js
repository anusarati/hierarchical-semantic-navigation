import { ROOT_TITLE, SEARCH_LIMIT, SENTINEL_ID } from "./lib/constants.js";
import {
	getChildren,
	getNodeDetails,
	getNodePath,
	searchTitles,
} from "./lib/api.js";
import {
	buildSunburstTree,
	createVirtualTrailEntry,
	DEFAULT_SUNBURST_CONFIG,
} from "./lib/sunburst/data.js";
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

const state = {
	pathIds: [],
	historyBack: [],
	historyForward: [],
	renderToken: 0,
	searchToken: 0,
	searchDebounce: null,
	viewMode: "columns",
	sunburst: {
		virtualTrail: [],
		pinnedNode: null,
		hoverNode: null,
		detailsToken: 0,
		detailsTimer: null,
	},
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

function resetSunburstSelection() {
	if (state.sunburst.detailsTimer !== null) {
		clearTimeout(state.sunburst.detailsTimer);
		state.sunburst.detailsTimer = null;
	}
	state.sunburst.pinnedNode = null;
	state.sunburst.hoverNode = null;
	state.sunburst.detailsToken += 1;
}

function clearSunburstVirtualTrail() {
	state.sunburst.virtualTrail = [];
	resetSunburstSelection();
}

function virtualBreadcrumbs() {
	return state.sunburst.virtualTrail.map((entry) => ({
		title: entry.title,
	}));
}

function getSunburstRootContext(activeId, details) {
	const trail = state.sunburst.virtualTrail;
	if (trail.length === 0) {
		return {
			kind: "real",
			nodeId: activeId,
			title: details.title,
			pathIds: [...state.pathIds],
		};
	}

	const currentVirtual = trail[trail.length - 1];
	return {
		kind: "other",
		title: currentVirtual.title,
		description: currentVirtual.description,
		pathIds: [...currentVirtual.parentPathIds],
		sourceItems: currentVirtual.sourceItems,
	};
}

function toVirtualDetails(node) {
	return {
		id: SENTINEL_ID,
		str_id: node.key,
		title: node.title,
		intro:
			node.description ||
			"Grouped smaller sectors. Double-click to expand this group in place.",
	};
}

async function resolveSunburstDetails(node, fallbackDetails) {
	if (!node) {
		return fallbackDetails;
	}

	if (node.kind === "other" || node.kind === "other-root") {
		return toVirtualDetails(node);
	}

	if (node.kind === "real") {
		if (node.id === fallbackDetails.id) {
			return fallbackDetails;
		}
		return getNodeDetails(node.id);
	}

	return fallbackDetails;
}

async function updateSunburstDetails(fallbackDetails, renderToken) {
	const target = state.sunburst.hoverNode ?? state.sunburst.pinnedNode;
	const detailsToken = ++state.sunburst.detailsToken;

	if (target && target.kind === "real" && target.id !== fallbackDetails.id) {
		renderDetails({
			id: target.id,
			str_id: String(target.id),
			title: target.title,
			intro: "Loading description...",
		});
	}

	let details = fallbackDetails;
	try {
		details = await resolveSunburstDetails(target, fallbackDetails);
	} catch (error) {
		console.error(error);
	}
	if (renderToken !== state.renderToken || detailsToken !== state.sunburst.detailsToken) {
		return;
	}
	renderDetails(details);
}

function scheduleSunburstDetails(fallbackDetails, renderToken, delayMs = 0) {
	if (state.sunburst.detailsTimer !== null) {
		clearTimeout(state.sunburst.detailsTimer);
		state.sunburst.detailsTimer = null;
	}

	const run = () => {
		state.sunburst.detailsTimer = null;
		void updateSunburstDetails(fallbackDetails, renderToken);
	};

	if (delayMs > 0) {
		state.sunburst.detailsTimer = setTimeout(run, delayMs);
		return;
	}
	run();
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
		let columns = null;
		if (state.viewMode === "columns") {
			columns = await buildColumns(state.pathIds, token);
			if (!columns || token !== state.renderToken) {
				return;
			}

			renderColumns(columns, (levelIndex, nodeId) => {
				const nextPath = state.pathIds.slice(0, levelIndex).concat(nodeId);
				void setPath(nextPath, { pushHistory: true, clearForward: true });
			});
		}

		const activeId = currentNodeId();
		const [details, path] = await Promise.all([
			getNodeDetails(activeId),
			getNodePath(activeId),
		]);

		if (token !== state.renderToken) {
			return;
		}

		renderBreadcrumb(path, {
			onRootClick: () => {
				if (state.pathIds.length === 0) {
					if (state.sunburst.virtualTrail.length === 0) {
						return;
					}
					clearSunburstVirtualTrail();
					void render();
					return;
				}
				void setPath([], { pushHistory: true, clearForward: true });
			},
			onCrumbClick: (crumbIndex) => {
				const nextPath = state.pathIds.slice(0, crumbIndex + 1);
				if (arraysEqual(nextPath, state.pathIds)) {
					if (state.sunburst.virtualTrail.length > 0) {
						clearSunburstVirtualTrail();
						void render();
					}
					return;
				}
				void setPath(nextPath, {
					pushHistory: true,
					clearForward: true,
				});
			},
			virtualTrail: state.viewMode === "sunburst" ? virtualBreadcrumbs() : [],
			onVirtualCrumbClick: (virtualIndex) => {
				state.sunburst.virtualTrail = state.sunburst.virtualTrail.slice(0, virtualIndex + 1);
				resetSunburstSelection();
				void render();
			},
		});

		let sunburstVisibleCount = 0;
		if (state.viewMode === "sunburst") {
			const rootContext = getSunburstRootContext(activeId, details);
			const tree = await buildSunburstTree({
				rootContext,
				getChildren,
				isCurrent: () => token === state.renderToken,
				config: DEFAULT_SUNBURST_CONFIG,
			});
			if (!tree || token !== state.renderToken) {
				return;
			}
			sunburstVisibleCount = tree.children.length;

			state.sunburst.pinnedNode = tree.center;
			state.sunburst.hoverNode = null;
			renderSunburst(tree, {
				onHover: (node) => {
					if (token !== state.renderToken) {
						return;
					}
					state.sunburst.hoverNode = node;
					scheduleSunburstDetails(details, token, 75);
				},
				onHoverEnd: () => {
					if (token !== state.renderToken) {
						return;
					}
					state.sunburst.hoverNode = null;
					scheduleSunburstDetails(details, token);
				},
				onClick: (node) => {
					if (token !== state.renderToken) {
						return;
					}
					state.sunburst.pinnedNode = node;
					state.sunburst.hoverNode = node;
					scheduleSunburstDetails(details, token);
				},
				onBackgroundClick: () => {
					if (token !== state.renderToken) {
						return;
					}
					state.sunburst.pinnedNode = tree.center;
					state.sunburst.hoverNode = null;
					scheduleSunburstDetails(details, token);
				},
				onDoubleClick: (node) => {
					if (token !== state.renderToken) {
						return;
					}
					if (node.kind === "other") {
						const nextEntry = createVirtualTrailEntry(node);
						const currentEntry =
							state.sunburst.virtualTrail[state.sunburst.virtualTrail.length - 1] ?? null;
						if (currentEntry && currentEntry.key === nextEntry.key) {
							return;
						}
						state.sunburst.virtualTrail = [nextEntry];
						resetSunburstSelection();
						void render();
						return;
					}
					if (node.kind === "real") {
						void setPath(node.pathIds, { pushHistory: true, clearForward: true });
					}
				},
				onCenterDoubleClick: () => {
					if (token !== state.renderToken) {
						return;
					}
					if (state.sunburst.virtualTrail.length > 0) {
						state.sunburst.virtualTrail.pop();
						resetSunburstSelection();
						void render();
						return;
					}
					void goUp();
				},
			});
			scheduleSunburstDetails(details, token);
		} else {
			resetSunburstSelection();
			renderDetails(details);
		}

		updateNavButtons({
			canBack: state.historyBack.length > 0,
			canForward: state.historyForward.length > 0,
			canUp: state.pathIds.length > 0,
		});

		let visibleCount = 0;
		if (state.viewMode === "columns") {
			const lastColumn = columns ? columns[columns.length - 1] : null;
			visibleCount = lastColumn?.items.length ?? 0;
		} else {
			visibleCount = sunburstVisibleCount;
		}
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
	clearSunburstVirtualTrail();
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
	clearSunburstVirtualTrail();
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
