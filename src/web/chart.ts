import { Chart, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip, type ChartDataset, type ChartOptions, type Scale } from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import { outputTime } from "../shared/output-time.ts";
import { compactBytes, ticks } from "../shared/units.ts";

Chart.register(LineController, LineElement, PointElement, LinearScale, Filler, Tooltip, zoomPlugin);

export type ChartKind = "percent" | "bytes" | "rate";

export interface ChartSeries {
	label: string;
	slot: 1 | 2;
	values: (number | null)[];
}

export interface ChartData {
	/** Start of each bucket, in seconds. */
	t: number[];
	/** Width of each bucket in seconds. A zoomed window has finer buckets than the range around it. */
	w: number[];
	/** The whole range the chart can show, which zooming and panning stay within. */
	from: number;
	to: number;
	series: ChartSeries[];
	kind: ChartKind;
	/** Fixed top of the scale, such as 100% or the host's memory. */
	max?: number;
	/** How a value reads in the tooltip and the table. */
	format(value: number | null): string;
	label: string;
}

export interface TimeWindow {
	min: number;
	max: number;
}

export interface ChartEvents {
	/** The visible window moves while a zoom or pan is under way, or settles when done is true. Null after a reset. */
	window(chart: LineChart, window: TimeWindow | null, done: boolean): void;
}

/** The narrowest window zooming reaches, in seconds. */
export const MIN_SPAN = 60;

function axisLabel(kind: ChartKind, v: number): string {
	if (kind === "percent") return `${Number(v.toPrecision(3))}%`;
	return kind === "rate" ? `${compactBytes(v)}/s` : compactBytes(v);
}

const TIME_STEPS = [
	10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 432_000, 604_800, 864_000, 1_209_600, 2_592_000, 7_776_000,
];

/** Ticks on whole minutes, hours and days in the chart's time zone, spaced to leave room for their labels. */
export function timeTicks(from: number, to: number, width: number): { values: number[]; step: number } {
	const room = Math.max(2, Math.floor(width / 72));
	const span = to - from;
	const step = TIME_STEPS.find((s) => span / s <= room) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
	const offset = step >= 3600 ? -zoneOffset(from) : 0;
	const values: number[] = [];
	for (let v = Math.ceil((from - offset) / step) * step + offset; v <= to; v += step) values.push(v);
	return { values, step };
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

const hms = zoneFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const hm = zoneFormat({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const md = zoneFormat({ month: "short", day: "numeric" });

/** Seconds the chart's time zone is ahead of UTC at time t, so ticks land on whole hours and days there. */
function zoneOffset(t: number): number {
	const date = new Date(Math.floor(t) * 1000);
	return (Date.parse(`${outputTime(date, { timeZone: ZONE }).replace(" ", "T")}Z`) - date.getTime()) / 1000;
}

function tickLabel(t: number, step: number): string {
	const date = new Date(t * 1000);
	return (step >= 86_400 ? md : step < 60 ? hms : hm).format(date);
}

/** Like 2026-11-16 14:43, with seconds when steps are under a minute, so rows ten seconds apart do not read alike. */
export function formatTime(t: number, step = 60): string {
	const text = outputTime(new Date(t * 1000), { timeZone: ZONE });
	return step < 60 ? text : text.slice(0, 16);
}

export function lastValue(values: (number | null)[]): number | null {
	for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]!;
	return null;
}

interface Palette {
	series: [string, string];
	grid: string;
	axis: string;
	muted: string;
	text: string;
	surface: string;
	border: string;
}

function palette(): Palette {
	const css = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
	return {
		series: [v("--series-1", "#257de0"), v("--series-2", "#f47230")],
		grid: v("--grid", "#e7ebf0"),
		axis: v("--axis", "#c2c8d0"),
		muted: v("--muted", "#5d6b7c"),
		text: v("--text", "#18202b"),
		surface: v("--surface", "#ffffff"),
		border: v("--border", "#dde3ea"),
	};
}

/** A #rrggbb color with transparency, for the area under a line and the zoom selection. */
function alpha(color: string, amount: number): string {
	const m = /^#([0-9a-f]{6})$/i.exec(color);
	if (!m) return color;
	const n = parseInt(m[1]!, 16);
	return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${amount})`;
}

type Point = { x: number; y: number | null };

/**
 * A line chart over time. Dragging across it zooms into that span, Shift and drag
 * pans, Ctrl and the wheel zooms (the wheel alone in full screen), and two fingers
 * pinch on touch screens. Double click resets. With focus, the arrow keys read the
 * values one bucket at a time.
 */
export class LineChart {
	private chart: Chart<"line", Point[]> | null = null;
	private data: ChartData | null = null;
	private window: TimeWindow | null = null;
	private index: number | null = null;
	private colors = palette();
	private canvas: HTMLCanvasElement | null = null;
	private tickStep = 60;
	private yTicks: number[] = [0, 1];
	private yMax = 1;

	constructor(
		private readonly root: HTMLElement,
		private readonly events: ChartEvents,
	) {
		root.tabIndex = 0;
		root.addEventListener("keydown", (e) => this.key(e));
		root.addEventListener("focus", () => this.show(this.index ?? this.lastIndex()));
		root.addEventListener("blur", () => this.show(null));
		root.addEventListener("dblclick", () => this.events.window(this, null, true));
	}

	/** Called when the theme changes, so lines and labels follow the light or dark colors. */
	restyle(): void {
		this.colors = palette();
		if (this.data) this.render(this.data);
	}

	/** Shows a message in place of the chart, such as when there is no data yet. */
	message(text: string): void {
		this.chart?.destroy();
		this.chart = null;
		this.canvas = null;
		const p = document.createElement("p");
		p.className = "chart-empty muted";
		p.textContent = text;
		this.root.replaceChildren(p);
	}

	/** Moves the visible window, from another chart or a reset, without reporting it back. Redraws unless a render follows. */
	setWindow(window: TimeWindow | null, redraw = true): void {
		this.window = window;
		if (!redraw || !this.chart || !this.data) return;
		this.fitY();
		this.chart.options = this.options();
		this.chart.update("none");
	}

	render(data: ChartData): void {
		this.data = data;
		const datasets = data.series.map((s, k) => this.dataset(s, k, data));
		this.fitY();
		let chart = this.chart;
		if (!chart) {
			this.canvas = document.createElement("canvas");
			this.root.replaceChildren(this.canvas);
			chart = this.chart = new Chart<"line", Point[]>(this.canvas, { type: "line", data: { datasets }, options: this.options() });
		} else {
			chart.data.datasets = datasets;
			chart.options = this.options();
			chart.update("none");
		}
		const last = data.series.map((s) => `${s.label} ${data.format(lastValue(s.values))}`).join(", ");
		this.canvas!.setAttribute("role", "img");
		this.canvas!.setAttribute(
			"aria-label",
			`${data.label}. Latest: ${last}. Use the arrow keys to read values, drag to zoom, Shift and drag to pan, double click to reset.`,
		);
		if (this.index !== null) this.show(Math.min(this.index, data.t.length - 1));
	}

	private dataset(s: ChartSeries, k: number, data: ChartData): ChartDataset<"line", Point[]> {
		const color = this.colors.series[s.slot - 1]!;
		const points: Point[] = data.t.map((t, i) => ({ x: t + data.w[i]! / 2, y: s.values[i] ?? null }));
		/** A value with gaps on both sides has no line to sit on, so it gets a dot. */
		const lone = (i: number) => s.values[i] !== null && (s.values[i - 1] ?? null) === null && (s.values[i + 1] ?? null) === null;
		return {
			label: s.label,
			data: points,
			parsing: false,
			normalized: true,
			borderColor: color,
			backgroundColor: data.series.length === 1 ? alpha(color, 0.16) : color,
			fill: data.series.length === 1 && k === 0 ? "origin" : false,
			borderWidth: 1.75,
			tension: 0,
			spanGaps: false,
			pointRadius: (ctx) => (lone(ctx.dataIndex) ? 2 : 0),
			pointBackgroundColor: color,
			pointHoverRadius: 4,
			pointHoverBorderWidth: 2,
			pointHoverBorderColor: this.colors.surface,
			pointHoverBackgroundColor: color,
		};
	}

	private options(): ChartOptions<"line"> {
		const c = this.colors;
		const data = this.data!;
		const shown = this.visible();
		const fullscreen = () => document.fullscreenElement?.contains(this.root) ?? false;
		const report = (done: boolean) => {
			if (!this.chart) return;
			const x = this.chart.scales.x!;
			this.window = { min: x.min, max: x.max };
			if (done) {
				this.fitY();
				this.chart.options = this.options();
				this.chart.update("none");
			}
			this.events.window(this, this.window, done);
		};
		return {
			responsive: true,
			maintainAspectRatio: false,
			animation: false as const,
			interaction: { mode: "index" as const, intersect: false, axis: "x" as const },
			layout: { padding: { top: 6, right: 4 } },
			scales: {
				x: {
					type: "linear" as const,
					min: shown.min,
					max: shown.max,
					grid: { display: false },
					border: { color: c.axis },
					ticks: {
						color: c.muted,
						font: { size: 11 },
						maxRotation: 0,
						autoSkip: false,
						callback: (value: string | number) => tickLabel(Number(value), this.tickStep),
					},
					afterBuildTicks: (scale: Scale) => {
						const { values, step } = timeTicks(scale.min, scale.max, scale.width || this.root.clientWidth);
						this.tickStep = step;
						scale.ticks = values.map((value) => ({ value }));
					},
				},
				y: {
					type: "linear" as const,
					min: 0,
					max: this.yMax,
					grid: { color: (ctx: { tick?: { value: number } }) => (ctx.tick?.value === 0 ? c.axis : c.grid) },
					border: { display: false },
					ticks: { color: c.muted, font: { size: 11 }, callback: (value: string | number) => axisLabel(data.kind, Number(value)) },
					afterBuildTicks: (scale: Scale) => {
						scale.ticks = this.yTicks.map((value) => ({ value }));
					},
				},
			},
			plugins: {
				legend: { display: false },
				tooltip: {
					backgroundColor: c.surface,
					titleColor: c.text,
					bodyColor: c.text,
					borderColor: c.border,
					borderWidth: 1,
					padding: 8,
					boxPadding: 4,
					usePointStyle: true,
					callbacks: {
						title: (items: { dataIndex: number }[]) => {
							const i = items[0]?.dataIndex;
							return i === undefined ? "" : formatTime(data.t[i]!, data.w[i]!);
						},
						label: (item: { dataIndex: number; datasetIndex: number }) => {
							const s = data.series[item.datasetIndex]!;
							return ` ${data.format(s.values[item.dataIndex] ?? null)} ${s.label}`;
						},
					},
				},
				zoom: {
					limits: { x: { min: data.from, max: data.to, minRange: MIN_SPAN } },
					pan: {
						enabled: true,
						mode: "x" as const,
						modifierKey: "shift" as const,
						onPan: () => report(false),
						onPanComplete: () => report(true),
					},
					zoom: {
						mode: "x" as const,
						drag: { enabled: true, threshold: 6, backgroundColor: alpha(c.series[0], 0.12), borderColor: c.series[0], borderWidth: 1 },
						wheel: { enabled: true, speed: 0.15 },
						pinch: { enabled: true },
						onZoomStart: ({ event }: { event: Event }) =>
							event.type !== "wheel" || fullscreen() || (event as WheelEvent).ctrlKey || (event as WheelEvent).metaKey,
						onZoom: () => report(false),
						onZoomComplete: () => report(true),
					},
				},
			},
		};
	}

	/** The window the chart shows: the zoomed one, or the whole range. */
	private visible(): TimeWindow {
		const data = this.data!;
		return this.window ?? { min: data.from, max: data.to };
	}

	/** Fits the value scale to what is visible, so zooming into a quiet stretch shows its detail. */
	private fitY(): void {
		const data = this.data;
		if (!data) return;
		const { min, max } = this.visible();
		let peak = 0;
		data.t.forEach((t, i) => {
			const x = t + data.w[i]! / 2;
			if (x < min || x > max) return;
			for (const s of data.series) {
				const v = s.values[i];
				if (v !== null && v !== undefined && v > peak) peak = v;
			}
		});
		const top = data.max && data.max > 0 && !this.window ? Math.max(data.max, peak) : peak > 0 ? peak * 1.1 : data.kind === "percent" ? 1 : 1024;
		let values = ticks(top, data.kind === "percent" ? "number" : "bytes");
		let yMax = values[values.length - 1]!;
		if (!this.window && data.max && data.max >= peak) {
			values = values.filter((v) => v <= data.max!);
			yMax = data.max;
		}
		this.yTicks = values;
		this.yMax = yMax;
	}

	private lastIndex(): number | null {
		if (!this.data) return null;
		for (let i = this.data.t.length - 1; i >= 0; i--) if (this.data.series.some((s) => s.values[i] !== null)) return i;
		return null;
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

	/** Puts the tooltip on one bucket, as the pointer would, for keyboard users. */
	private show(index: number | null): void {
		this.index = index;
		const chart = this.chart;
		if (!chart || !this.data) return;
		if (index === null) {
			chart.setActiveElements([]);
			chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
		} else {
			const active = this.data.series
				.map((_, datasetIndex) => ({ datasetIndex, index }))
				.filter((a) => this.data!.series[a.datasetIndex]!.values[index] !== null);
			const meta = chart.getDatasetMeta(0).data[index];
			chart.setActiveElements(active);
			chart.tooltip?.setActiveElements(active, { x: meta?.x ?? 0, y: meta?.y ?? 0 });
		}
		chart.update("none");
	}
}
