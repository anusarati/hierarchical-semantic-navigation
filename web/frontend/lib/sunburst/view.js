const SVG_NS = "http://www.w3.org/2000/svg";

function createSvg(tag) {
	return document.createElementNS(SVG_NS, tag);
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
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

function truncateText(text, maxChars) {
	if (text.length <= maxChars) {
		return text;
	}
	if (maxChars <= 1) {
		return text.slice(0, maxChars);
	}
	return `${text.slice(0, maxChars - 1)}\u2026`;
}

function wrapCenterTitle(text, radius) {
	const maxLines = radius >= 88 ? 4 : 3;
	const maxChars = Math.max(10, Math.floor((radius * 1.65) / 7));
	const words = text.trim().split(/\s+/);
	if (words.length === 0) {
		return [""];
	}

	const lines = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			current = word;
			continue;
		}

		const candidate = `${current} ${word}`;
		if (candidate.length <= maxChars) {
			current = candidate;
			continue;
		}

		lines.push(current);
		current = word;
		if (lines.length === maxLines) {
			break;
		}
	}

	if (lines.length < maxLines && current) {
		lines.push(current);
	}

	if (lines.length > maxLines) {
		lines.length = maxLines;
	}

	if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
		lines[maxLines - 1] = truncateText(lines[maxLines - 1], maxChars);
	}

	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index].length > maxChars) {
			lines[index] = truncateText(lines[index], maxChars);
		}
	}

	return lines;
}

function canRenderArcLabel(angleSpan, arcLength, ringWidth) {
	if (ringWidth < 15) {
		return false;
	}
	if (angleSpan < 0.11) {
		return false;
	}
	return arcLength >= 36;
}

function layoutWeight(value) {
	return Math.log1p(Math.max(0, value));
}

function renderCenter(svg, data, cx, cy, innerRadius, handlers) {
	const defs = createSvg("defs");
	const clipPath = createSvg("clipPath");
	const clipId = `sunburst-center-clip-${Math.random().toString(36).slice(2, 10)}`;
	clipPath.setAttribute("id", clipId);
	const clipCircle = createSvg("circle");
	clipCircle.setAttribute("cx", `${cx}`);
	clipCircle.setAttribute("cy", `${cy}`);
	clipCircle.setAttribute("r", `${Math.max(10, innerRadius - 10)}`);
	clipPath.appendChild(clipCircle);
	defs.appendChild(clipPath);
	svg.appendChild(defs);

	const center = createSvg("g");
	center.setAttribute("class", "sunburst-center");

	const centerDisk = createSvg("circle");
	centerDisk.setAttribute("cx", `${cx}`);
	centerDisk.setAttribute("cy", `${cy}`);
	centerDisk.setAttribute("r", `${Math.max(10, innerRadius - 3)}`);
	centerDisk.setAttribute("class", "sunburst-center-disk");
	centerDisk.setAttribute("tabindex", "0");
	centerDisk.setAttribute("role", "button");
	centerDisk.setAttribute("aria-label", "Sunburst center");
	centerDisk.setAttribute("aria-description", "Click for level details");

	centerDisk.addEventListener("pointerenter", () => {
		handlers.onHover?.(data.center);
	});
	centerDisk.addEventListener("pointerleave", () => {
		handlers.onHoverEnd?.();
	});
	centerDisk.addEventListener("focus", () => {
		handlers.onHover?.(data.center);
	});
	centerDisk.addEventListener("blur", () => {
		handlers.onHoverEnd?.();
	});
	centerDisk.addEventListener("click", (event) => {
		event.stopPropagation();
		handlers.onCenterClick?.();
		handlers.onClick?.(data.center);
	});
	centerDisk.addEventListener("dblclick", (event) => {
		event.stopPropagation();
		handlers.onCenterDoubleClick?.();
	});
	centerDisk.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			handlers.onCenterDoubleClick?.();
		}
	});
	center.appendChild(centerDisk);

	const centerTitle = createSvg("text");
	centerTitle.setAttribute("class", "sunburst-center-label");
	centerTitle.setAttribute("text-anchor", "middle");
	centerTitle.setAttribute("clip-path", `url(#${clipId})`);

	const lines = wrapCenterTitle(data.title, innerRadius - 12);
	const lineHeight = 17;
	const startY = cy - ((lines.length - 1) * lineHeight) / 2;
	for (let index = 0; index < lines.length; index += 1) {
		const tspan = createSvg("tspan");
		tspan.setAttribute("x", `${cx}`);
		tspan.setAttribute("y", `${startY + index * lineHeight}`);
		tspan.textContent = lines[index];
		centerTitle.appendChild(tspan);
	}
	center.appendChild(centerTitle);

	const hint = createSvg("text");
	hint.setAttribute("x", `${cx}`);
	hint.setAttribute("y", `${cy + innerRadius * 0.42}`);
	hint.setAttribute("text-anchor", "middle");
	hint.setAttribute("class", "sunburst-center-hint");
	hint.textContent = "double-click center to go up";
	center.appendChild(hint);

	svg.appendChild(center);
}

function createSectorTitle(node) {
	const parts = [`${node.title}`, `${node.value.toLocaleString()} weighted`];
	if (node.kind === "other") {
		parts.push(`${node.itemCount.toLocaleString()} grouped children`);
	}
	return parts.join(" \u00b7 ");
}

export function renderSunburstChart({ svg, panel, empty, data, handlers = {} }) {
	svg.innerHTML = "";
	svg.onclick = null;
	svg.onmouseleave = null;

	if (!data || !Array.isArray(data.children) || data.children.length === 0) {
		empty.classList.remove("hidden");
		return;
	}
	empty.classList.add("hidden");

	const width = Math.max(300, panel.clientWidth || 800);
	const height = Math.max(260, panel.clientHeight || 600);
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

	const cx = width / 2;
	const cy = height / 2;
	const maxDepth = Math.max(1, data.maxDepth ?? 1);
	const outerRadius = Math.min(width, height) * 0.47;
	const minInner = Math.max(42, outerRadius * 0.16);
	const maxInner = Math.max(minInner, outerRadius - maxDepth * 20);
	const innerRadius = clamp(outerRadius * 0.24, minInner, maxInner);
	const ringWidth = Math.max(12, (outerRadius - innerRadius) / maxDepth);

	const sectorLayer = createSvg("g");
	sectorLayer.setAttribute("class", "sunburst-sector-layer");
	svg.appendChild(sectorLayer);

	const labelLayer = createSvg("g");
	labelLayer.setAttribute("class", "sunburst-label-layer");
	svg.appendChild(labelLayer);

	let selectedSectorPath = null;
	const setSelectedSector = (path) => {
		if (selectedSectorPath === path) {
			return;
		}
		if (selectedSectorPath) {
			selectedSectorPath.classList.remove("selected");
		}
		selectedSectorPath = path;
		if (selectedSectorPath) {
			selectedSectorPath.classList.add("selected");
		}
	};

	let clearHoverTimer = null;
	const cancelHoverClear = () => {
		if (clearHoverTimer !== null) {
			clearTimeout(clearHoverTimer);
			clearHoverTimer = null;
		}
	};
	const scheduleHoverClear = () => {
		cancelHoverClear();
		if (!handlers.onHoverEnd) {
			return;
		}
		clearHoverTimer = setTimeout(() => {
			handlers.onHoverEnd?.();
			clearHoverTimer = null;
		}, 0);
	};

	function attachSectorEvents(path, node) {
		path.setAttribute("tabindex", "0");
		path.setAttribute("role", "button");

		path.addEventListener("pointerenter", () => {
			cancelHoverClear();
			handlers.onHover?.(node);
		});
		path.addEventListener("pointerleave", scheduleHoverClear);
		path.addEventListener("focus", () => {
			cancelHoverClear();
			handlers.onHover?.(node);
		});
		path.addEventListener("blur", scheduleHoverClear);
		path.addEventListener("click", (event) => {
			event.stopPropagation();
			setSelectedSector(path);
			handlers.onClick?.(node);
		});
		path.addEventListener("dblclick", (event) => {
			event.stopPropagation();
			handlers.onDoubleClick?.(node);
		});
		path.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				setSelectedSector(path);
				handlers.onClick?.(node);
			}
			if (event.key === "ArrowRight") {
				event.preventDefault();
				handlers.onDoubleClick?.(node);
			}
		});
	}

	function walk(nodes, depth, startAngle, endAngle, hueBase) {
		if (!nodes || nodes.length === 0) {
			return;
		}
		const weights = nodes.map((node) => layoutWeight(node.value));
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		if (totalWeight <= 0) {
			return;
		}

		let cursor = startAngle;
		for (let index = 0; index < nodes.length; index += 1) {
			const node = nodes[index];
			const slice = ((endAngle - startAngle) * weights[index]) / totalWeight;
			const nodeStart = cursor;
			const nodeEnd = cursor + slice;
			cursor = nodeEnd;

			const inner = innerRadius + (depth - 1) * ringWidth;
			const outer = inner + ringWidth - 2;

			const path = createSvg("path");
			path.setAttribute("d", sectorPath(cx, cy, inner, outer, nodeStart, nodeEnd));

			const hue = (hueBase + ((index * 23) % 360)) % 360;
			const saturation = Math.max(40, 74 - depth * 4);
			const lightness = Math.max(33, 67 - depth * 5);
			path.setAttribute("fill", `hsl(${hue} ${saturation}% ${lightness}%)`);
			path.setAttribute("stroke", "rgba(255,255,255,0.92)");
			path.setAttribute("stroke-width", "1");
			path.setAttribute("class", "sunburst-sector");
			if (node.kind === "other") {
				path.classList.add("is-other");
			}
			attachSectorEvents(path, node);

			const title = createSvg("title");
			title.textContent = createSectorTitle(node);
			path.appendChild(title);
			sectorLayer.appendChild(path);

			const angleSpan = nodeEnd - nodeStart;
			const radius = (inner + outer) / 2;
			const arcLength = angleSpan * radius;
			if (canRenderArcLabel(angleSpan, arcLength, ringWidth)) {
				const mid = (nodeStart + nodeEnd) / 2;
				const labelPos = polarToCartesian(cx, cy, radius, mid);
				const label = createSvg("text");
				label.setAttribute("x", `${labelPos.x}`);
				label.setAttribute("y", `${labelPos.y}`);
				label.setAttribute("class", "sunburst-label");
				label.setAttribute("text-anchor", "middle");
				label.setAttribute("dominant-baseline", "middle");

				let rotation = (mid * 180) / Math.PI - 90;
				if (rotation > 90) {
					rotation -= 180;
				}
				if (rotation < -90) {
					rotation += 180;
				}
				label.setAttribute("transform", `rotate(${rotation} ${labelPos.x} ${labelPos.y})`);

				const maxChars = Math.max(6, Math.floor(arcLength / 7));
				label.textContent = truncateText(node.title, maxChars);
				labelLayer.appendChild(label);
			}

			walk(node.children, depth + 1, nodeStart, nodeEnd, hue + 17);
		}
	}

	walk(data.children, 1, -Math.PI / 2, (Math.PI * 3) / 2, 214);
	renderCenter(svg, data, cx, cy, innerRadius, {
		...handlers,
		onCenterClick: () => {
			setSelectedSector(null);
		},
	});

	svg.onclick = (event) => {
		if (event.target !== svg) {
			return;
		}
		setSelectedSector(null);
		handlers.onBackgroundClick?.();
	};

	svg.onmouseleave = () => {
		handlers.onHoverEnd?.();
	};
}
