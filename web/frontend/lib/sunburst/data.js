const DEFAULTS = {
	maxDepth: 4,
	maxChildren: 100,
	minShare: 0.008,
	branchExpandLimit: 14,
	fetchConcurrency: 8,
	maxHydratedNodes: 140,
	maxDepthInOther: 1,
	maxChildrenInOther: 20,
	minShareInOther: 0,
};

export const DEFAULT_SUNBURST_CONFIG = Object.freeze({ ...DEFAULTS });

function cloneWeightedItem(item) {
	return {
		id: item.id,
		title: item.title,
		value: Math.max(1, item.value),
		hasChildren: Boolean(item.hasChildren),
	};
}

function normalizeConfig(config = {}) {
	return {
		maxDepth: Math.max(1, Number(config.maxDepth ?? DEFAULTS.maxDepth)),
		maxChildren: Math.max(1, Number(config.maxChildren ?? DEFAULTS.maxChildren)),
		minShare: Math.max(0, Number(config.minShare ?? DEFAULTS.minShare)),
		branchExpandLimit: Math.max(
			1,
			Number(config.branchExpandLimit ?? DEFAULTS.branchExpandLimit),
		),
		fetchConcurrency: Math.max(
			1,
			Math.floor(Number(config.fetchConcurrency ?? DEFAULTS.fetchConcurrency)),
		),
		maxHydratedNodes: Math.max(
			1,
			Math.floor(Number(config.maxHydratedNodes ?? DEFAULTS.maxHydratedNodes)),
		),
		maxDepthInOther: Math.max(
			1,
			Math.floor(Number(config.maxDepthInOther ?? DEFAULTS.maxDepthInOther)),
		),
		maxChildrenInOther: Math.max(
			1,
			Math.floor(Number(config.maxChildrenInOther ?? DEFAULTS.maxChildrenInOther)),
		),
		minShareInOther: Math.max(
			0,
			Number(config.minShareInOther ?? DEFAULTS.minShareInOther),
		),
	};
}

async function mapLimit(items, limit, mapper) {
	if (!items.length) {
		return;
	}

	const workerCount = Math.min(items.length, Math.max(1, limit));
	let nextIndex = 0;

	async function runWorker() {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) {
				return;
			}
			await mapper(items[index], index);
		}
	}

	const workers = Array.from({ length: workerCount }, () => runWorker());
	await Promise.all(workers);
}

function toWeightedChildren(rawChildren) {
	return rawChildren.map((child) => ({
		id: child.id,
		title: child.title,
		value: Math.max(1, Number(child.descendant_count ?? 0) + 1),
		hasChildren: Boolean(child.has_children),
	}));
}

function pathKey(pathIds) {
	if (!Array.isArray(pathIds) || pathIds.length === 0) {
		return "root";
	}
	return pathIds.join(".");
}

function createRealNode(item, parentPathIds) {
	const pathIds = parentPathIds.concat(item.id);
	return {
		key: `node:${pathKey(pathIds)}`,
		kind: "real",
		id: item.id,
		pathIds,
		title: item.title,
		value: Math.max(1, item.value),
		hasChildren: item.hasChildren,
		children: [],
	};
}

function createOtherDescription({ itemCount, parentTitle }) {
	return [
		`Grouped ${itemCount.toLocaleString()} smaller or overflow children under \"${parentTitle}\".`,
		"Double-click to expand this group.",
	].join(" ");
}

function createOtherNode(overflowItems, parentPathIds, parentTitle, depth) {
	const itemCount = overflowItems.length;
	const value = overflowItems.reduce((sum, item) => sum + item.value, 0);
	const marker = overflowItems[0]?.id ?? "none";
	return {
		key: `other:${pathKey(parentPathIds)}:${depth}:${itemCount}:${marker}`,
		kind: "other",
		title: `Other (${itemCount.toLocaleString()})`,
		value: Math.max(1, value),
		itemCount,
		parentTitle,
		parentPathIds: [...parentPathIds],
		description: createOtherDescription({ itemCount, parentTitle }),
		sourceItems: overflowItems.map(cloneWeightedItem),
		children: [],
	};
}

function compactChildren(items, parentPathIds, parentTitle, depth, config) {
	if (!items.length) {
		return [];
	}

	const sorted = [...items].sort((a, b) => b.value - a.value);
	const total = sorted.reduce((sum, item) => sum + item.value, 0);
	const kept = [];
	const overflow = [];

	for (let index = 0; index < sorted.length; index += 1) {
		const item = sorted[index];
		const share = total > 0 ? item.value / total : 0;
		if (index < config.maxChildren && share >= config.minShare) {
			kept.push(item);
		} else {
			overflow.push(item);
		}
	}

	const compacted = kept.map((item) => createRealNode(item, parentPathIds));
	if (overflow.length > 0) {
		compacted.push(createOtherNode(overflow, parentPathIds, parentTitle, depth));
	}
	return compacted;
}

async function hydrateRealNode(node, depth, getChildren, isCurrent, config, budget) {
	if (!node.hasChildren || depth >= config.maxDepth || !isCurrent()) {
		return;
	}
	if (budget.hydratedNodes >= config.maxHydratedNodes) {
		return;
	}
	budget.hydratedNodes += 1;

	const rawChildren = await getChildren(node.id);
	if (!isCurrent()) {
		return;
	}

	const weightedChildren = toWeightedChildren(rawChildren);
	node.children = compactChildren(weightedChildren, node.pathIds, node.title, depth + 1, config);

	const expandable = node.children
		.slice(0, config.branchExpandLimit)
		.filter((child) => child.kind === "real");
	await mapLimit(expandable, config.fetchConcurrency, async (child) => {
		if (!isCurrent()) {
			return;
		}
		await hydrateRealNode(child, depth + 1, getChildren, isCurrent, config, budget);
	});

	if (!isCurrent()) {
		return;
	}

	if (node.children.length > 0) {
		node.value = Math.max(1, node.children.reduce((sum, child) => sum + child.value, 0));
	}
}

function createCenterDescriptor(rootContext) {
	if (rootContext.kind === "real") {
		return {
			key: `center:${pathKey(rootContext.pathIds)}`,
			kind: "real",
			id: rootContext.nodeId,
			pathIds: [...rootContext.pathIds],
			title: rootContext.title,
		};
	}

	return {
		key: `center:other:${pathKey(rootContext.pathIds)}:${rootContext.sourceItems.length}`,
		kind: "other-root",
		title: rootContext.title,
		description: rootContext.description,
		parentPathIds: [...rootContext.pathIds],
	};
}

function normalizeVirtualSource(sourceItems) {
	return sourceItems.map((item) => ({
		id: item.id,
		title: item.title,
		value: Math.max(1, Number(item.value ?? 1)),
		hasChildren: Boolean(item.hasChildren),
	}));
}

async function buildRootChildren(rootContext, getChildren, isCurrent, config) {
	let weightedChildren = [];
	const budget = { hydratedNodes: 0 };
	const isVirtualOther = rootContext.kind === "other";
	const rootConfig = isVirtualOther
		? {
				...config,
				maxDepth: config.maxDepthInOther,
				maxChildren: config.maxChildrenInOther,
				minShare: config.minShareInOther,
			}
		: config;

	if (rootContext.kind === "real") {
		const rawChildren = await getChildren(rootContext.nodeId);
		if (!isCurrent()) {
			return null;
		}
		weightedChildren = toWeightedChildren(rawChildren);
	} else {
		weightedChildren = normalizeVirtualSource(rootContext.sourceItems);
	}

	const children = compactChildren(
		weightedChildren,
		rootContext.pathIds,
		rootContext.title,
		1,
		rootConfig,
	);
	const expandable = children
		.slice(0, rootConfig.branchExpandLimit)
		.filter((child) => child.kind === "real");
	await mapLimit(expandable, rootConfig.fetchConcurrency, async (child) => {
		if (!isCurrent()) {
			return;
		}
		await hydrateRealNode(child, 1, getChildren, isCurrent, rootConfig, budget);
	});

	if (!isCurrent()) {
		return null;
	}
	return children;
}

export async function buildSunburstTree({ rootContext, getChildren, isCurrent, config }) {
	const normalized = normalizeConfig(config);
	const children = await buildRootChildren(rootContext, getChildren, isCurrent, normalized);
	if (!children || !isCurrent()) {
		return null;
	}

	return {
		title: rootContext.title,
		maxDepth: normalized.maxDepth,
		center: createCenterDescriptor(rootContext),
		children,
	};
}

export function createVirtualTrailEntry(otherNode) {
	if (!otherNode || otherNode.kind !== "other") {
		throw new Error("Expected an 'other' node to create a virtual trail entry.");
	}

	return {
		key: otherNode.key,
		title: otherNode.title,
		description: otherNode.description,
		parentPathIds: [...otherNode.parentPathIds],
		parentTitle: otherNode.parentTitle,
		sourceItems: otherNode.sourceItems.map(cloneWeightedItem),
	};
}
