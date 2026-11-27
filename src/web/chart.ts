import { outputTime } from "../shared/output-time.ts";
import { compactBytes, ticks } from "../shared/units.ts";

export type ChartKind = "percent" | "bytes" | "rate";

export interface ChartSeries {
	label: string;
	slot: 1 | 2;
	values: (number | null)[];
}

export interface ChartData {
	t: number[];
	step: number;
	series: ChartSeries[];
	kind: ChartKind;
	/** Fixed top of the scale, such as 100% or the host's memory. */
	max?: number;
	/** How a value reads in the tooltip and the table. */
	format(value: number | null): string;
	label: string;
}

const SVG = "http://www.w3.org/2000/svg";
const HEIGHT = 168;
const M = { top: 10, right: 12, bottom: 24, left: 54 };

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG, name);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	parent?.appendChild(node);
	return node;
}

function axisLabel(kind: ChartKind, v: number): string {
	if (kind === "percent") return `${Number(v.toPrecision(3))}%`;
	return kind === "rate" ? `${compactBytes(v)}/s` : compactBytes(v);
}

const TIME_STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 432_000, 604_800, 864_000, 1_209_600, 2_592_000, 7_776_000];

function timeTicks(from: number, to: number, width: number): { values: number[]; daily: boolean } {
	const room = Math.max(3, Math.floor(width / 60));
	const span = to - from;
	const step = TIME_STEPS.find((s) => span / s <= room) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
	const offset = -zoneOffset(from);
	const values: number[] = [];
	for (let v = Math.ceil((from - offset) / step) * step + offset; v <= to; v += step) values.push(v);
	return { values, daily: step >= 86_400 };
}

/** Charts use the controller's time zone, like job output and logs. */
const ZONE = (typeof document !== "undefined" && document.querySelector<HTMLMetaElement>('meta[name="time-zone"]')?.content) || undefined;

function zoneFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: ZONE });
	} catch {
		return new Intl.DateTimeFormat("en-GB", options);
	}
}

const hm = zoneFormat({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const md = zoneFormat({ month: "short", day: "numeric" });

/** Seconds the chart's time zone is ahead of UTC at time t, so ticks land on whole hours and days there. */
function zoneOffset(t: number): number {
	const date = new Date(Math.floor(t) * 1000);
	return (Date.parse(`${outputTime(date, { timeZone: ZONE }).replace(" ", "T")}Z`) - date.getTime()) / 1000;
}

/** Like 2026-11-16 14:43, with seconds when steps are under a minute, so rows ten seconds apart do not read alike. */
export function formatTime(t: number, step = 60): string {
	const text = outputTime(new Date(t * 1000), { timeZone: ZONE });
	return step < 60 ? text : text.slice(0, 16);
}

/** A line chart with one y scale, a crosshair that snaps to the nearest point, and the same readout on keyboard focus. */
export class LineChart {
	private data: ChartData | null = null;
	private svg: SVGSVGElement | null = null;
	private tip: HTMLDivElement;
	private index: number | null = null;
	private x: (t: number) => number = () => 0;
	private y: (v: number) => number = () => 0;
	private hover: SVGGElement | null = null;

	constructor(private readonly root: HTMLElement) {
		root.tabIndex = 0;
		this.tip = document.createElement("div");
		this.tip.className = "chart-tip";
		this.tip.hidden = true;
		root.addEventListener("pointermove", (e) => this.pointer(e));
		root.addEventListener("pointerleave", () => this.show(null));
		root.addEventListener("focus", () => this.show(this.lastIndex()));
		root.addEventListener("blur", () => this.show(null));
		root.addEventListener("keydown", (e) => this.key(e));
	}

	render(data: ChartData): void {
		this.data = data;
		const width = Math.max(200, this.root.clientWidth);
		const plotW = width - M.left - M.right;
		const plotH = HEIGHT - M.top - M.bottom;
		let peak = 0;
		for (const s of data.series) for (const v of s.values) if (v !== null && v > peak) peak = v;
		const top = data.max && data.max > 0 ? Math.max(data.max, peak) : peak > 0 ? peak * 1.1 : data.kind === "percent" ? 1 : 1024;
		const scale = data.kind === "percent" ? "number" : "bytes";
		let yTicks = ticks(top, scale);
		let yMax = yTicks[yTicks.length - 1]!;
		if (data.max && data.max >= peak) {
			yTicks = yTicks.filter((v) => v <= data.max!);
			yMax = data.max;
		}
		const from = data.t[0] ?? 0;
		const to = (data.t[data.t.length - 1] ?? 1) + data.step;
		this.x = (t) => M.left + ((t - from) / (to - from)) * plotW;
		this.y = (v) => M.top + plotH - (v / yMax) * plotH;

		const svg = el("svg", { class: "chart-svg", width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: "img" });
		const last = data.series.map((s) => `${s.label} ${data.format(lastValue(s.values))}`).join(", ");
		svg.setAttribute("aria-label", `${data.label}. Latest: ${last}. Use the arrow keys to read earlier values.`);

		const grid = el("g", { class: "chart-grid" }, svg);
		for (const v of yTicks) {
			const yy = Math.round(this.y(v)) + 0.5;
			el("line", { x1: M.left, x2: width - M.right, y1: yy, y2: yy, class: v === 0 ? "chart-base" : "chart-rule" }, grid);
			const label = el("text", { x: M.left - 8, y: yy + 4, class: "chart-tick", "text-anchor": "end" }, grid);
			label.textContent = axisLabel(data.kind, v);
		}
		const tt = timeTicks(from, to, plotW);
		for (const t of tt.values) {
			const xx = this.x(t);
			if (xx < M.left + 16 || xx > width - M.right - 16) continue;
			const label = el("text", { x: xx, y: HEIGHT - 6, class: "chart-tick", "text-anchor": "middle" }, grid);
			label.textContent = (tt.daily ? md : hm).format(new Date(t * 1000));
		}

		const marks = el("g", { class: "chart-marks" }, svg);
		const single = data.series.length === 1;
		for (const s of data.series) {
			const segments = this.segments(s.values);
			if (single) {
				const base = this.y(0);
				const area = segments
					.map((seg) => `M${seg[0]![0]},${base}L${seg.map(([px, py]) => `${px},${py}`).join("L")}L${seg[seg.length - 1]![0]},${base}Z`)
					.join("");
				if (area) el("path", { d: area, class: `chart-area s${s.slot}` }, marks);
			}
			const line = segments
				.map((seg) => (seg.length === 1 ? `M${seg[0]![0] - 1},${seg[0]![1]}h2` : `M${seg.map(([px, py]) => `${px},${py}`).join("L")}`))
				.join("");
			if (line) el("path", { d: line, class: `chart-line s${s.slot}` }, marks);
		}
		this.hover = el("g", { class: "chart-hover" }, svg);
		this.svg?.remove();
		this.root.replaceChildren(svg, this.tip);
		this.svg = svg;
		if (this.index !== null) this.show(Math.min(this.index, data.t.length - 1));
	}

	private segments(values: (number | null)[]): [number, number][][] {
		const data = this.data!;
		const out: [number, number][][] = [];
		let current: [number, number][] = [];
		values.forEach((v, i) => {
			if (v === null) {
				if (current.length > 0) out.push(current);
				current = [];
				return;
			}
			current.push([Math.round(this.x(data.t[i]! + data.step / 2) * 10) / 10, Math.round(this.y(v) * 10) / 10]);
		});
		if (current.length > 0) out.push(current);
		return out;
	}

	private lastIndex(): number | null {
		if (!this.data) return null;
		for (let i = this.data.t.length - 1; i >= 0; i--) if (this.data.series.some((s) => s.values[i] !== null)) return i;
		return null;
	}

	private pointer(e: PointerEvent): void {
		if (!this.data || this.data.t.length === 0) return;
		const box = this.root.getBoundingClientRect();
		const px = e.clientX - box.left;
		const from = this.data.t[0]!;
		const plotW = box.width - M.left - M.right;
		const t = from + ((px - M.left) / plotW) * (this.data.t[this.data.t.length - 1]! + this.data.step - from) - this.data.step / 2;
		const i = Math.round((t - from) / this.data.step);
		this.show(Math.max(0, Math.min(this.data.t.length - 1, i)));
	}

	private key(e: KeyboardEvent): void {
		if (!this.data) return;
		const n = this.data.t.length;
		const i = this.index ?? this.lastIndex() ?? n - 1;
		const moves: Record<string, number> = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 };
		if (e.key === "Escape") return this.show(null);
		if (!(e.key in moves)) return;
		e.preventDefault();
		this.show(Math.max(0, Math.min(n - 1, moves[e.key]!)));
	}

	private show(index: number | null): void {
		this.index = index;
		const data = this.data;
		if (!this.hover || !data) return;
		this.hover.replaceChildren();
		if (index === null) {
			this.tip.hidden = true;
			return;
		}
		const xx = this.x(data.t[index]! + data.step / 2);
		el("line", { x1: xx, x2: xx, y1: M.top, y2: HEIGHT - M.bottom, class: "chart-cross" }, this.hover);
		for (const s of data.series) {
			const v = s.values[index];
			if (v === null || v === undefined) continue;
			el("circle", { cx: xx, cy: this.y(v), r: 4, class: `chart-dot s${s.slot}` }, this.hover);
		}
		const tip = this.tip;
		tip.replaceChildren();
		const when = document.createElement("div");
		when.className = "chart-tip-time";
		when.textContent = formatTime(data.t[index]!, data.step);
		tip.append(when);
		for (const s of data.series) {
			const row = document.createElement("div");
			row.className = "chart-tip-row";
			const keyMark = document.createElement("span");
			keyMark.className = `chart-key s${s.slot}`;
			const value = document.createElement("strong");
			value.textContent = data.format(s.values[index] ?? null);
			const label = document.createElement("span");
			label.className = "muted";
			label.textContent = s.label;
			row.append(keyMark, value, label);
			tip.append(row);
		}
		tip.hidden = false;
		const width = this.root.clientWidth;
		const tipW = tip.offsetWidth;
		const left = xx + 12 + tipW > width ? xx - 12 - tipW : xx + 12;
		tip.style.left = `${Math.max(0, left)}px`;
		tip.style.top = `${M.top}px`;
	}
}

export function lastValue(values: (number | null)[]): number | null {
	for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]!;
	return null;
}
