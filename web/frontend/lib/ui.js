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
