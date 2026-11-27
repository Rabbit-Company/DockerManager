import { cpuShare, bytes, percent, rate } from "../shared/units.ts";
import { formatTime, lastValue, LineChart, type ChartData } from "./chart.ts";

interface Series {
	range: string;
	step: number;
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

export interface LiveSample {
	host: number;
	t: number;
	stats: Record<string, number | null> | null;
	containers: Record<string, Record<string, number | null>>;
}

const LIVE_RANGE = "1h";
const LIVE_SPAN = 3600;

class ChartsPanel {
	private data: Series | null = null;
	private readonly charts = new Map<string, LineChart>();
	private readonly host: number;
	private readonly target: string;
	private range: string;
	private loading = 0;

	constructor(private readonly root: HTMLElement) {
		this.host = Number(root.dataset.host);
		this.target = root.dataset.target ?? "";
		this.range = root.dataset.range ?? LIVE_RANGE;
		for (const figure of root.querySelectorAll<HTMLElement>("[data-chart]")) {
			const plot = figure.querySelector<HTMLElement>("[data-chart-plot]")!;
			this.charts.set(figure.dataset.chart!, new LineChart(plot));
		}
		root.addEventListener("click", (e) => {
			const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("[data-range-link]");
			if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
			e.preventDefault();
			this.setRange(link.dataset.rangeLink!, link.href);
		});
		root.querySelector<HTMLDetailsElement>("[data-chart-table]")?.addEventListener("toggle", () => this.table());
		let frame = 0;
		new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => this.draw());
		}).observe(root);
		void this.load();
	}

	private setRange(range: string, href: string): void {
		if (range === this.range) return;
		this.range = range;
		for (const a of this.root.querySelectorAll<HTMLAnchorElement>("[data-range-link]")) {
			if (a.dataset.rangeLink === range) a.setAttribute("aria-current", "true");
			else a.removeAttribute("aria-current");
		}
		history.replaceState(null, "", href);
		void this.load();
	}

	private async load(): Promise<void> {
		const ticket = ++this.loading;
		this.root.classList.add("is-loading");
		try {
			const url = `/hosts/${this.host}/metrics.json?range=${encodeURIComponent(this.range)}&target=${encodeURIComponent(this.target)}`;
			const response = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
			if (!response.ok) throw new Error(String(response.status));
			const data = (await response.json()) as Series;
			if (ticket !== this.loading) return;
			this.data = data;
			this.draw();
			this.table();
		} catch {
			if (ticket !== this.loading) return;
			for (const plot of this.root.querySelectorAll<HTMLElement>("[data-chart-plot]"))
				plot.replaceChildren(message("The history could not be loaded. Reload the page to try again."));
		} finally {
			if (ticket === this.loading) this.root.classList.remove("is-loading");
		}
	}

	private cpus(): number | null {
		return this.data?.cpus ?? (Number(this.root.dataset.cpus) || null);
	}

	private specs(): Record<string, ChartData> | null {
		const d = this.data;
		if (!d) return null;
		const cpus = this.cpus();
		const isHost = this.target === "";
		const memLimit = lastValue(d.memLimit);
		return {
			cpu: {
				t: d.t,
				step: d.step,
				kind: "percent",
				max: isHost ? 100 : undefined,
				label: "CPU, share of the host",
				format: percent,
				series: [{ label: "CPU", slot: 1, values: d.cpu.map((c) => cpuShare(c, cpus)) }],
			},
			mem: {
				t: d.t,
				step: d.step,
				kind: "bytes",
				max: isHost && memLimit ? memLimit : undefined,
				label: "Memory used",
				format: (v) => (v === null ? "no data" : bytes(v)),
				series: [{ label: "Used", slot: 1, values: d.mem }],
			},
			net: {
				t: d.t,
				step: d.step,
				kind: "rate",
				label: "Network traffic",
				format: rate,
				series: [
					{ label: "Received", slot: 1, values: d.netRx },
					{ label: "Sent", slot: 2, values: d.netTx },
				],
			},
			blk: {
				t: d.t,
				step: d.step,
				kind: "rate",
				label: "Disk reads and writes",
				format: rate,
				series: [
					{ label: "Read", slot: 1, values: d.blkRead },
					{ label: "Written", slot: 2, values: d.blkWrite },
				],
			},
		};
	}

	private draw(): void {
		const specs = this.specs();
		if (!specs) return;
		for (const [key, chart] of this.charts) {
			const spec = specs[key]!;
			const figure = this.root.querySelector<HTMLElement>(`[data-chart="${key}"]`)!;
			const plot = figure.querySelector<HTMLElement>("[data-chart-plot]")!;
			const note = figure.querySelector<HTMLElement>("[data-chart-note]")!;
			const empty = spec.series.every((s) => s.values.every((v) => v === null));
			note.textContent = empty ? "" : noteFor(key, spec, lastValue(this.data!.memLimit));
			legend(figure, spec);
			if (empty) {
				plot.replaceChildren(message(this.range === LIVE_RANGE ? "No samples yet. They arrive every 10 seconds." : "No data for this range yet."));
				continue;
			}
			chart.render(spec);
		}
	}

	/** New samples extend the one hour view. Longer ranges are built from rollups and stay as loaded. */
	live(sample: LiveSample): void {
		const d = this.data;
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
		const keys = ["cpu", "mem", "memLimit", "netRx", "netTx", "blkRead", "blkWrite"] as const;
		if (bucket === last) {
			for (const k of keys) d[k][d[k].length - 1] = row[k];
		} else {
			for (let b = last + d.step; b <= bucket; b += d.step) {
				d.t.push(b);
				for (const k of keys) d[k].push(b === bucket ? row[k] : null);
			}
			while (d.t.length > 0 && d.t[0]! < bucket - LIVE_SPAN + d.step) {
				d.t.shift();
				for (const k of keys) d[k].shift();
			}
		}
		if (sample.stats?.cpus) d.cpus = sample.stats.cpus;
		if (document.visibilityState === "visible") this.draw();
	}

	private table(): void {
		const details = this.root.querySelector<HTMLDetailsElement>("[data-chart-table]");
		const d = this.data;
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
			const cells = [cpuShare(d.cpu[i], cpus), d.mem[i], d.netRx[i], d.netTx[i], d.blkRead[i], d.blkWrite[i]];
			if (cells.every((c) => c === null || c === undefined)) continue;
			const row = body.insertRow();
			const time = row.insertCell();
			time.textContent = formatTime(d.t[i]!, d.step);
			time.className = "nowrap";
			const texts = [percent(cells[0]), cells[1] === null ? "no data" : bytes(cells[1]), rate(cells[2]), rate(cells[3]), rate(cells[4]), rate(cells[5])];
			for (const text of texts) {
				const cell = row.insertCell();
				cell.textContent = text;
				cell.className = "right nowrap";
			}
		}
		const wrap = details.querySelector(".table-wrap")!;
		wrap.replaceChildren(body.rows.length > 0 ? table : message("No data for this range yet."));
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
