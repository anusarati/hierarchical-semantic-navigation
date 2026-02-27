import { ROOT_TITLE } from "./constants.js";

const refs = {
	status: document.getElementById("status"),
	backBtn: document.getElementById("back-btn"),
	forwardBtn: document.getElementById("forward-btn"),
	upBtn: document.getElementById("up-btn"),
	resetBtn: document.getElementById("reset-btn"),
	searchInput: document.getElementById("search-input"),
	searchResults: document.getElementById("search-results"),
	breadcrumb: document.getElementById("breadcrumb"),
	levelsPanel: document.getElementById("levels-panel"),
	sunburstPanel: document.getElementById("sunburst-panel"),
	sunburstSvg: document.getElementById("sunburst-svg"),
	sunburstEmpty: document.getElementById("sunburst-empty"),
	viewColumnsBtn: document.getElementById("view-columns-btn"),
	viewSunburstBtn: document.getElementById("view-sunburst-btn"),
	docTitle: document.getElementById("doc-title"),
	docId: document.getElementById("doc-id"),
	docIntro: document.getElementById("doc-intro"),
};

export function getRefs() {
	return refs;
}

export function setStatus(text) {
	refs.status.textContent = text;
}

export function setViewMode(mode) {
	const isColumns = mode === "columns";
	refs.levelsPanel.classList.toggle("hidden", !isColumns);
	refs.sunburstPanel.classList.toggle("hidden", isColumns);
	refs.viewColumnsBtn.classList.toggle("active", isColumns);
	refs.viewSunburstBtn.classList.toggle("active", !isColumns);
}

export function updateNavButtons({ canBack, canForward, canUp }) {
	refs.backBtn.disabled = !canBack;
	refs.forwardBtn.disabled = !canForward;
	refs.upBtn.disabled = !canUp;
}

export function renderBreadcrumb(path, { onRootClick, onCrumbClick }) {
	refs.breadcrumb.innerHTML = "";

	const rootButton = document.createElement("button");
	rootButton.type = "button";
	rootButton.className = `crumb ${path.length === 0 ? "current" : ""}`.trim();
	rootButton.textContent = ROOT_TITLE;
	rootButton.disabled = path.length === 0;
	if (path.length > 0) {
		rootButton.addEventListener("click", onRootClick);
	}
	refs.breadcrumb.appendChild(rootButton);

	path.forEach((crumb, index) => {
		const sep = document.createElement("span");
		sep.className = "crumb-sep";
		sep.textContent = ">";
		refs.breadcrumb.appendChild(sep);

		const button = document.createElement("button");
		button.type = "button";
		const isCurrent = index === path.length - 1;
		button.className = `crumb ${isCurrent ? "current" : ""}`.trim();
		button.textContent = crumb.title;
		button.disabled = isCurrent;
		if (!isCurrent) {
			button.addEventListener("click", () => onCrumbClick(index));
		}
		refs.breadcrumb.appendChild(button);
	});
}

function renderColumnItem(item, isSelected, onSelect) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `level-item ${isSelected ? "selected" : ""}`.trim();

	const title = document.createElement("div");
	title.className = "item-title";
	title.textContent = item.title;
	button.appendChild(title);

	const meta = document.createElement("div");
	meta.className = "item-meta";

	const descendants = document.createElement("span");
	descendants.textContent = `${item.descendant_count.toLocaleString()} descendants`;
	meta.appendChild(descendants);

	const flag = document.createElement("span");
	flag.className = "item-flag";
	flag.textContent = item.has_children ? "Has children" : "Leaf";
	meta.appendChild(flag);
	button.appendChild(meta);

	button.addEventListener("click", onSelect);
	return button;
}

export function renderColumns(columns, onSelect) {
	refs.levelsPanel.innerHTML = "";

	columns.forEach((column, levelIndex) => {
		const columnEl = document.createElement("section");
		columnEl.className = "level-column";

		const header = document.createElement("div");
		header.className = "level-header";

		const title = document.createElement("h3");
		title.className = "level-title";
		title.textContent = column.parentTitle;
		header.appendChild(title);

		const count = document.createElement("span");
		count.className = "level-count";
		count.textContent = `${column.items.length.toLocaleString()} items`;
		header.appendChild(count);

		columnEl.appendChild(header);

		const list = document.createElement("div");
		list.className = "level-list";
		if (column.items.length === 0) {
			const empty = document.createElement("div");
			empty.className = "column-empty";
			empty.textContent = "No children at this level.";
			list.appendChild(empty);
		} else {
			for (const item of column.items) {
				const isSelected = item.id === column.selectedId;
				const row = renderColumnItem(item, isSelected, () => onSelect(levelIndex, item.id));
				list.appendChild(row);
			}
		}

		columnEl.appendChild(list);
		refs.levelsPanel.appendChild(columnEl);

		const selected = list.querySelector(".level-item.selected");
		if (selected) {
			selected.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
	});

	refs.levelsPanel.scrollLeft = refs.levelsPanel.scrollWidth;
}

function polarToCartesian(cx, cy, radius, angle) {
	return {
		x: cx + radius * Math.cos(angle),
		y: cy + radius * Math.sin(angle),
	};
}

function sectorPath(cx, cy, innerR, outerR, startAngle, endAngle) {
	const p0 = polarToCartesian(cx, cy, outerR, startAngle);
	const p1 = polarToCartesian(cx, cy, outerR, endAngle);
	const p2 = polarToCartesian(cx, cy, innerR, endAngle);
	const p3 = polarToCartesian(cx, cy, innerR, startAngle);
	const large = endAngle - startAngle > Math.PI ? 1 : 0;
	return [
		`M ${p0.x} ${p0.y}`,
		`A ${outerR} ${outerR} 0 ${large} 1 ${p1.x} ${p1.y}`,
		`L ${p2.x} ${p2.y}`,
		`A ${innerR} ${innerR} 0 ${large} 0 ${p3.x} ${p3.y}`,
		"Z",
	].join(" ");
}

export function renderSunburst(data, onSelect) {
	refs.sunburstSvg.innerHTML = "";

	if (!data || !Array.isArray(data.children) || data.children.length === 0) {
		refs.sunburstEmpty.classList.remove("hidden");
		return;
	}
	refs.sunburstEmpty.classList.add("hidden");

	const width = refs.sunburstPanel.clientWidth || 800;
	const height = refs.sunburstPanel.clientHeight || 600;
	refs.sunburstSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

	const cx = width / 2;
	const cy = height / 2;
	const maxDepth = Math.max(1, data.maxDepth ?? 1);
	const outerRadius = Math.min(width, height) * 0.46;
	const innerRadius = Math.min(62, outerRadius * 0.22);
	const ringWidth = (outerRadius - innerRadius) / maxDepth;

	const center = document.createElementNS("http://www.w3.org/2000/svg", "g");
	const centerDisk = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	centerDisk.setAttribute("cx", `${cx}`);
	centerDisk.setAttribute("cy", `${cy}`);
	centerDisk.setAttribute("r", `${innerRadius - 4}`);
	centerDisk.setAttribute("fill", "#f8fbff");
	centerDisk.setAttribute("stroke", "#d8e3f4");
	center.appendChild(centerDisk);
	const centerLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
	centerLabel.setAttribute("x", `${cx}`);
	centerLabel.setAttribute("y", `${cy}`);
	centerLabel.setAttribute("text-anchor", "middle");
	centerLabel.setAttribute("dominant-baseline", "middle");
	centerLabel.setAttribute("class", "sunburst-center-label");
	centerLabel.textContent = data.title;
	center.appendChild(centerLabel);
	refs.sunburstSvg.appendChild(center);

	function walk(nodes, depth, startAngle, endAngle, hueBase) {
		if (!nodes || nodes.length === 0) {
			return;
		}
		const total = nodes.reduce((sum, node) => sum + node.value, 0);
		if (total <= 0) {
			return;
		}

		let cursor = startAngle;
		for (let index = 0; index < nodes.length; index += 1) {
			const node = nodes[index];
			const slice = ((endAngle - startAngle) * node.value) / total;
			const nodeStart = cursor;
			const nodeEnd = cursor + slice;
			cursor = nodeEnd;

			const inner = innerRadius + (depth - 1) * ringWidth;
			const outer = inner + ringWidth - 2;
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("d", sectorPath(cx, cy, inner, outer, nodeStart, nodeEnd));
			const hue = (hueBase + ((index * 23) % 360)) % 360;
			const saturation = Math.max(44, 72 - depth * 4);
			const lightness = Math.max(36, 68 - depth * 5);
			path.setAttribute("fill", `hsl(${hue} ${saturation}% ${lightness}%)`);
			path.setAttribute("stroke", "rgba(255,255,255,0.9)");
			path.setAttribute("stroke-width", "1");
			path.setAttribute("class", "sunburst-sector");
			const clickable = Boolean(node.id);
			if (clickable) {
				path.classList.add("clickable");
				path.addEventListener("click", () => onSelect(node.id));
				path.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onSelect(node.id);
					}
				});
				path.setAttribute("tabindex", "0");
			}
			const valueLabel = `${node.title} · ${node.value.toLocaleString()}`;
			path.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title")).textContent = valueLabel;
			refs.sunburstSvg.appendChild(path);

			const arcLength = ((nodeEnd - nodeStart) * (inner + outer)) / 2;
			if (arcLength > 54 && ringWidth > 18) {
				const mid = (nodeStart + nodeEnd) / 2;
				const radius = (inner + outer) / 2;
				const labelPos = polarToCartesian(cx, cy, radius, mid);
				const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
				label.setAttribute("x", `${labelPos.x}`);
				label.setAttribute("y", `${labelPos.y}`);
				label.setAttribute("class", "sunburst-label");
				label.setAttribute("text-anchor", "middle");
				label.setAttribute("dominant-baseline", "middle");
				let rotation = (mid * 180) / Math.PI;
				if (rotation > 90 && rotation < 270) {
					rotation += 180;
				}
				label.setAttribute("transform", `rotate(${rotation} ${labelPos.x} ${labelPos.y})`);
				label.textContent = node.title;
				refs.sunburstSvg.appendChild(label);
			}

			walk(node.children, depth + 1, nodeStart, nodeEnd, hue + 17);
		}
	}

	walk(data.children, 1, -Math.PI / 2, (Math.PI * 3) / 2, 212);
}

export function renderDetails(details) {
	refs.docTitle.textContent = details.title;
	refs.docId.textContent = details.str_id || "root";
	refs.docIntro.textContent = details.intro || "(No content available)";
}

export function hideSearchResults() {
	refs.searchResults.classList.add("hidden");
	refs.searchResults.innerHTML = "";
}

export function renderSearchResults(results, onPick) {
	refs.searchResults.innerHTML = "";

	if (!results.length) {
		const empty = document.createElement("div");
		empty.className = "search-empty";
		empty.textContent = "No matching titles.";
		refs.searchResults.appendChild(empty);
		refs.searchResults.classList.remove("hidden");
		return;
	}

	for (const result of results) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "search-item";

		const title = document.createElement("div");
		title.className = "search-item-title";
		title.textContent = result.title;
		button.appendChild(title);

		const id = document.createElement("div");
		id.className = "search-item-id";
		id.textContent = result.str_id;
		button.appendChild(id);
		button.addEventListener("click", () => onPick(result));
		refs.searchResults.appendChild(button);
	}

	refs.searchResults.classList.remove("hidden");
}
