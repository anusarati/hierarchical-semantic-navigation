import { API_BASE, ROOT_TITLE, SEARCH_LIMIT, SENTINEL_ID } from "./constants.js";

const childrenCache = new Map();
const detailsCache = new Map();
const pathCache = new Map();

async function fetchJson(path) {
	const response = await fetch(path);
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`${response.status}: ${body || "request failed"}`);
	}
	return response.json();
}

export async function getChildren(parentId) {
	if (childrenCache.has(parentId)) {
		return childrenCache.get(parentId);
	}

	const endpoint =
		parentId === SENTINEL_ID
			? `${API_BASE}/graph/roots`
			: `${API_BASE}/graph/children/${parentId}`;
	const items = await fetchJson(endpoint);
	childrenCache.set(parentId, items);
	return items;
}

export async function getNodeDetails(nodeId) {
	if (detailsCache.has(nodeId)) {
		return detailsCache.get(nodeId);
	}

	if (nodeId === SENTINEL_ID) {
		const rootDetails = {
			id: SENTINEL_ID,
			str_id: "root",
			title: ROOT_TITLE,
			intro:
				"Top-level semantic clusters. Click a row to drill down into the next level.",
		};
		detailsCache.set(nodeId, rootDetails);
		return rootDetails;
	}

	const data = await fetchJson(`${API_BASE}/node/${nodeId}`);
	detailsCache.set(nodeId, data);
	return data;
}

export async function getNodePath(nodeId) {
	if (nodeId === SENTINEL_ID) {
		return [];
	}
	if (pathCache.has(nodeId)) {
		return pathCache.get(nodeId);
	}

	const data = await fetchJson(`${API_BASE}/graph/path/${nodeId}`);
	const path = Array.isArray(data.path) ? data.path : [];
	pathCache.set(nodeId, path);
	return path;
}

export async function searchTitles(query, limit = SEARCH_LIMIT) {
	const encoded = encodeURIComponent(query.trim());
	if (!encoded) {
		return [];
	}
	return fetchJson(`${API_BASE}/search?q=${encoded}&limit=${limit}`);
}
