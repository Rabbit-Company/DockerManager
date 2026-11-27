import { cpuShare, bytes, percent, rate } from "../shared/units.ts";
import { formatTime, lastValue, LineChart, type ChartData, type TimeWindow } from "./chart.ts";

interface Series {
	range: string | null;
	step: number;
	from: number;
	to: number;
	t: number[];
	cpu: (number | null)[];
	mem: (number | null)[];
	memLimit: (number | null)[];
	netRx: (number | null)[];
	netTx: (number | null)[];
	blkRead: (number | null)[];
	blkWrite: (number | null)[];
	cpus: number | null;
}

/** What the charts draw: the range, with a zoomed window's finer buckets in place of the coarse ones they cover. */
export interface View {
	t: number[];
	w: number[];
	from: number;
	to: number;
	cpu: (number | null)[];
	mem: (number | null)[];
	memLimit: (number | null)[];
	netRx: (number | null)[];
	netTx: (number | null)[];
	blkRead: (number | null)[];
	blkWrite: (number | null)[];
}

export interface LiveSample {
	host: number;
	t: number;
	stats: Record<string, number | null> | null;
	containers: Record<string, Record<string, number | null>>;
}

const LIVE_RANGE = "1h";
const LIVE_SPAN = 3600;
const VALUES = ["cpu", "mem", "memLimit", "netRx", "netTx", "blkRead", "blkWrite"] as const;
/** How long a zoom or pan has to rest before the finer data for it is fetched. */
const DETAIL_DELAY = 300;

type Bucketed = Pick<Series, "t" | "step" | (typeof VALUES)[number]> & { from?: number; to?: number };

/** Merges the range with the finer buckets of a zoomed window. Range buckets that overlap the window are left out. */
export function mergeView(base: Bucketed, detail: Bucketed | null): View {
	const from = base.from ?? base.t[0] ?? 0;
	const to = base.to ?? (base.t[base.t.length - 1] ?? 0) + base.step;
	const view: View = { t: [], w: [], from, to, cpu: [], mem: [], memLimit: [], netRx: [], netTx: [], blkRead: [], blkWrite: [] };
	const push = (source: Bucketed, i: number) => {
		view.t.push(source.t[i]!);
		view.w.push(source.step);
		for (const key of VALUES) view[key].push(source[key][i] ?? null);
	};
	const start = detail?.t[0];
	const end = detail ? (detail.t[detail.t.length - 1] ?? 0) + detail.step : 0;
	let i = 0;
	if (detail && start !== undefined) {
		for (; i < base.t.length && base.t[i]! + base.step <= start; i++) push(base, i);
		for (let j = 0; j < detail.t.length; j++) push(detail, j);
		while (i < base.t.length && base.t[i]! < end) i++;
	}
	for (; i < base.t.length; i++) push(base, i);
	return view;
}

class ChartsPanel {
	private base: Series | null = null;
	private detail: Series | null = null;
	private view: View | null = null;
	private window: TimeWindow | null = null;
	private readonly charts = new Map<string, LineChart>();
	private readonly host: number;
	private readonly target: string;
	private range: string;
	private loading = 0;
	private detailing = 0;
	private detailTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly resetButton: HTMLButtonElement | null;

	constructor(private readonly root: HTMLElement) {
		this.host = Number(root.dataset.host);
		this.target = root.dataset.target ?? "";
		this.range = root.dataset.range ?? LIVE_RANGE;
		this.resetButton = root.querySelector<HTMLButtonElement>("[data-chart-reset]");
		const events = { window: (source: LineChart, window: TimeWindow | null, done: boolean) => this.moved(source, window, done) };
		for (const figure of root.querySelectorAll<HTMLElement>("[data-chart]")) {
			const plot = figure.querySelector<HTMLElement>("[data-chart-plot]")!;
			this.charts.set(figure.dataset.chart!, new LineChart(plot, events));
		}
		root.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			const link = target.closest<HTMLAnchorElement>("[data-range-link]");
			if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
				e.preventDefault();
				this.setRange(link.dataset.rangeLink!, link.href);
				return;
			}
			if (target.closest("[data-chart-reset]")) this.moved(null, null, true);
			const full = target.closest<HTMLButtonElement>("[data-chart-full]");
			if (full) void this.fullscreen(full.closest<HTMLElement>("[data-chart]")!);
		});
		root.querySelector<HTMLDetailsElement>("[data-chart-table]")?.addEventListener("toggle", () => this.table());
		document.addEventListener("fullscreenchange", () => {
			for (const button of root.querySelectorAll<HTMLButtonElement>("[data-chart-full]")) {
				const on = document.fullscreenElement === button.closest("[data-chart]");
				button.setAttribute("aria-pressed", String(on));
				button.textContent = on ? "Exit full screen" : "Full screen";
			}
		});
		matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
			for (const chart of this.charts.values()) chart.restyle();
		});
		void this.load();
	}

	private async fullscreen(figure: HTMLElement): Promise<void> {
		if (document.fullscreenElement === figure) await document.exitFullscreen();
		else await figure.requestFullscreen().catch(() => {});
	}

	private setRange(range: string, href: string): void {
		if (range === this.range) return;
		this.range = range;
		for (const a of this.root.querySelectorAll<HTMLAnchorElement>("[data-range-link]")) {
			if (a.dataset.rangeLink === range) a.setAttribute("aria-current", "true");
			else a.removeAttribute("aria-current");
		}
		history.replaceState(null, "", href);
		this.forget();
		void this.load();
	}

	private url(query: string): string {
		return `/hosts/${this.host}/metrics.json?${query}&target=${encodeURIComponent(this.target)}`;
	}

	private async fetchSeries(query: string): Promise<Series> {
		const response = await fetch(this.url(query), { credentials: "same-origin", headers: { Accept: "application/json" } });
		if (!response.ok) throw new Error(String(response.status));
		return (await response.json()) as Series;
	}

	private async load(): Promise<void> {
		const ticket = ++this.loading;
		this.root.classList.add("is-loading");
		try {
			const data = await this.fetchSeries(`range=${encodeURIComponent(this.range)}`);
			if (ticket !== this.loading) return;
			this.base = data;
			this.draw();
		} catch {
			if (ticket !== this.loading) return;
			for (const chart of this.charts.values()) chart.message("The history could not be loaded. Reload the page to try again.");
		} finally {
			if (ticket === this.loading) this.root.classList.remove("is-loading");
		}
	}

	/** Drops the zoomed window and its finer data. */
	private forget(): void {
		clearTimeout(this.detailTimer);
		this.detailing++;
		this.window = null;
		this.detail = null;
		this.resetButton?.toggleAttribute("hidden", true);
	}

	/** One chart was zoomed or panned: the others follow, and once it rests the finer data for the window is fetched. */
	private moved(source: LineChart | null, window: TimeWindow | null, done: boolean): void {
		if (window === null) {
			this.forget();
			for (const chart of this.charts.values()) chart.setWindow(null);
			this.draw();
			return;
		}
		this.window = window;
		this.resetButton?.toggleAttribute("hidden", false);
		for (const chart of this.charts.values()) if (chart !== source) chart.setWindow(window);
		if (!done) return;
		clearTimeout(this.detailTimer);
		this.detailTimer = setTimeout(() => void this.loadDetail(window), DETAIL_DELAY);
		this.table();
	}

	private async loadDetail(window: TimeWindow): Promise<void> {
		const ticket = ++this.detailing;
		try {
			const data = await this.fetchSeries(`from=${Math.floor(window.min)}&to=${Math.ceil(window.max)}`);
			if (ticket !== this.detailing || !this.base) return;
			if (data.step >= this.base.step) return;
			this.detail = data;
			this.draw();
		} catch {
			// The coarser points stay. A later zoom tries again.
		}
	}

	private cpus(): number | null {
		return this.base?.cpus ?? (Number(this.root.dataset.cpus) || null);
	}

	private specs(v: View): Record<string, ChartData> {
		const cpus = this.cpus();
		const isHost = this.target === "";
		const memLimit = lastValue(v.memLimit);
		const shared = { t: v.t, w: v.w, from: v.from, to: v.to };
		return {
			cpu: {
				...shared,
				kind: "percent",
				max: isHost ? 100 : undefined,
				label: "CPU, share of the host",
				format: percent,
				series: [{ label: "CPU", slot: 1, values: v.cpu.map((c) => cpuShare(c, cpus)) }],
			},
			mem: {
				...shared,
				kind: "bytes",
				max: isHost && memLimit ? memLimit : undefined,
				label: "Memory used",
				format: (value) => (value === null ? "no data" : bytes(value)),
				series: [{ label: "Used", slot: 1, values: v.mem }],
			},
			net: {
				...shared,
				kind: "rate",
				label: "Network traffic",
				format: rate,
				series: [
					{ label: "Received", slot: 1, values: v.netRx },
					{ label: "Sent", slot: 2, values: v.netTx },
				],
			},
			blk: {
				...shared,
				kind: "rate",
				label: "Disk reads and writes",
				format: rate,
				series: [
					{ label: "Read", slot: 1, values: v.blkRead },
					{ label: "Written", slot: 2, values: v.blkWrite },
				],
			},
		};
	}

	private draw(): void {
		if (!this.base) return;
		this.view = mergeView(this.base, this.detail);
		const specs = this.specs(this.view);
		for (const [key, chart] of this.charts) {
			const spec = specs[key]!;
			const figure = this.root.querySelector<HTMLElement>(`[data-chart="${key}"]`)!;
			const note = figure.querySelector<HTMLElement>("[data-chart-note]")!;
			const empty = spec.series.every((s) => s.values.every((v) => v === null));
			note.textContent = empty ? "" : noteFor(key, spec, lastValue(this.view.memLimit));
			legend(figure, spec);
			if (empty) {
				chart.message(
					figure.dataset.chartEmpty || (this.range === LIVE_RANGE ? "No samples yet. They arrive every 10 seconds." : "No data for this range yet."),
				);
				continue;
			}
			chart.setWindow(this.window, false);
			chart.render(spec);
		}
		this.table();
	}

	/** New samples extend the one hour view. Longer ranges are built from rollups and stay as loaded. */
	live(sample: LiveSample): void {
		const d = this.base;
		if (!d || this.range !== LIVE_RANGE || sample.host !== this.host) return;
		const v = this.target === "" ? sample.stats : sample.containers[this.target];
		if (!v) return;
		const bucket = sample.t - (sample.t % d.step);
		const last = d.t[d.t.length - 1] ?? 0;
		if (bucket < last) return;
		const memLimit = this.target === "" ? (v.memTotal ?? null) : (v.memLimit ?? null);
		const row = {
			cpu: v.cpu ?? null,
			mem: v.mem ?? null,
			memLimit,
			netRx: v.netRx ?? null,
			netTx: v.netTx ?? null,
			blkRead: v.blkRead ?? null,
			blkWrite: v.blkWrite ?? null,
		};
		if (bucket === last) {
			for (const k of VALUES) d[k][d[k].length - 1] = row[k];
		} else {
			for (let b = last + d.step; b <= bucket; b += d.step) {
				d.t.push(b);
				for (const k of VALUES) d[k].push(b === bucket ? row[k] : null);
			}
			while (d.t.length > 0 && d.t[0]! < bucket - LIVE_SPAN + d.step) {
				d.t.shift();
				for (const k of VALUES) d[k].shift();
			}
		}
		d.from = d.t[0] ?? d.from;
		d.to = bucket + d.step;
		if (sample.stats?.cpus) d.cpus = sample.stats.cpus;
		if (document.visibilityState === "visible") this.draw();
	}

	/** The rows behind the charts, newest first, limited to the zoomed window when there is one. */
	private table(): void {
		const details = this.root.querySelector<HTMLDetailsElement>("[data-chart-table]");
		const d = this.view;
		if (!details?.open || !d) return;
		const cpus = this.cpus();
		const table = document.createElement("table");
		table.className = "table";
		const head = table.createTHead().insertRow();
		for (const title of ["Time", "CPU", "Memory", "Received", "Sent", "Read", "Written"]) {
			const th = document.createElement("th");
			th.textContent = title;
			if (title !== "Time") th.className = "right";
			head.append(th);
		}
		const body = table.createTBody();
		for (let i = d.t.length - 1; i >= 0; i--) {
			const t = d.t[i]!;
			if (this.window && (t + d.w[i]! <= this.window.min || t >= this.window.max)) continue;
			const cells = [cpuShare(d.cpu[i], cpus), d.mem[i], d.netRx[i], d.netTx[i], d.blkRead[i], d.blkWrite[i]];
			if (cells.every((c) => c === null || c === undefined)) continue;
			const row = body.insertRow();
			const time = row.insertCell();
			time.textContent = formatTime(t, d.w[i]);
			time.className = "nowrap";
			const texts = [percent(cells[0]), cells[1] === null ? "no data" : bytes(cells[1]!), rate(cells[2]), rate(cells[3]), rate(cells[4]), rate(cells[5])];
			for (const text of texts) {
				const cell = row.insertCell();
				cell.textContent = text;
				cell.className = "right nowrap";
			}
		}
		const wrap = details.querySelector(".table-wrap")!;
		wrap.replaceChildren(body.rows.length > 0 ? table : message(this.window ? "No data in the zoomed window." : "No data for this range yet."));
	}
}

function message(text: string): HTMLElement {
	const p = document.createElement("p");
	p.className = "chart-empty muted";
	p.textContent = text;
	return p;
}

function noteFor(key: string, spec: ChartData, memLimit: number | null): string {
	if (key === "cpu") {
		const values = spec.series[0]!.values.filter((v): v is number => v !== null);
		return `now ${percent(lastValue(spec.series[0]!.values))}, peak ${percent(Math.max(...values))}`;
	}
	if (key === "mem") {
		const now = lastValue(spec.series[0]!.values);
		return `now ${now === null ? "no data" : bytes(now)}${memLimit ? ` of ${bytes(memLimit)}` : ""}`;
	}
	return "";
}

/** Two series get a legend with a line key each. One series is named by the chart title. */
function legend(figure: HTMLElement, spec: ChartData): void {
	let box = figure.querySelector<HTMLElement>(".chart-legend");
	if (spec.series.length < 2) {
		box?.remove();
		return;
	}
	if (!box) {
		box = document.createElement("div");
		box.className = "chart-legend";
		figure.querySelector("figcaption")!.after(box);
	}
	box.replaceChildren();
	for (const s of spec.series) {
		const item = document.createElement("span");
		item.className = "chart-legend-item";
		const key = document.createElement("span");
		key.className = `chart-key s${s.slot}`;
		const label = document.createElement("span");
		label.textContent = `${s.label} ${spec.format(lastValue(s.values))}`;
		item.append(key, label);
		box.append(item);
	}
}

export function startCharts(): ((sample: LiveSample) => void) | null {
	const panels = [...document.querySelectorAll<HTMLElement>("[data-charts]")].map((root) => new ChartsPanel(root));
	if (panels.length === 0) return null;
	return (sample) => {
		for (const panel of panels) panel.live(sample);
	};
}
