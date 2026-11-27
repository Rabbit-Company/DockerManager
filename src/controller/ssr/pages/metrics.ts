import type { ContainerMetrics, DiskUsage, Filesystem, HostMetrics } from "../../../shared/protocol.ts";
import { fieldText, type LiveField, type LiveValues } from "../../../shared/live.ts";
import { bytes, fraction, meterTone, percent } from "../../../shared/units.ts";
import { RANGES, type Range } from "../../db/metrics.ts";
import { html, type SafeHtml } from "../html.ts";

/** A thin bar drawn as SVG, so its width is an attribute and needs no inline style. */
export function meter(share: number | null): SafeHtml {
	const width = share === null ? 0 : Math.round(share * 1000) / 10;
	return html`<svg class="meter meter-${meterTone(share)}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
		<rect class="meter-track" width="100" height="6" rx="3" />
		<rect class="meter-fill" width="${width}" height="6" rx="3" />
	</svg>`;
}

export function hostValues(h: HostMetrics | null | undefined): LiveValues | null {
	if (!h) return null;
	return { cpu: h.cpu, cpus: h.cpus, mem: h.mem, memLimit: h.memTotal, netRx: h.netRx, netTx: h.netTx, blkRead: h.blkRead, blkWrite: h.blkWrite };
}

export function containerValues(c: ContainerMetrics | null | undefined, cpus: number | null): LiveValues | null {
	if (!c) return null;
	return { cpu: c.cpu, cpus, mem: c.mem, memLimit: c.memLimit, netRx: c.netRx, netTx: c.netTx, blkRead: c.blkRead, blkWrite: c.blkWrite };
}

/** A value the browser keeps current. Target is empty for the host itself, else the container name. */
export function live(
	hostId: number,
	target: string,
	field: LiveField,
	values: LiveValues | null,
	options: { meter?: boolean; detail?: string } = {},
): SafeHtml {
	const { text, share } = fieldText(field, values);
	return html`<span class="metric" data-m-host="${hostId}" data-m-target="${target}" data-m-field="${field}"
		><span class="metric-text">${text}</span
		>${options.detail ? html` <span class="metric-detail muted">${options.detail}</span>` : ""}${options.meter ? meter(share) : ""}</span
	>`;
}

function rangeRow(path: string, current: Range): SafeHtml {
	return html`<nav class="ranges" aria-label="Time range">
		${(Object.keys(RANGES) as Range[]).map(
			(r) =>
				html`<a class="range" href="${path}${path.includes("?") ? "&" : "?"}range=${r}" data-range-link="${r}" ${r === current ? html`aria-current="true"` : ""}
					>${r}</a
				>`,
		)}
	</nav>`;
}

const CHARTS = [
	{ key: "cpu", title: "CPU" },
	{ key: "mem", title: "Memory" },
	{ key: "net", title: "Network" },
	{ key: "blk", title: "Disk I/O" },
] as const;

/**
 * Four charts for one host or container. The browser draws them from /hosts/{id}/metrics.json.
 * A container on the host network has no interfaces of its own, so its traffic cannot be told
 * apart from the host's and its network chart says so instead of waiting for samples.
 */
export function chartsPanel(input: {
	hostId: number;
	target: string;
	range: Range;
	path: string;
	cpus: number | null;
	heading: string;
	hostNetwork?: boolean;
}): SafeHtml {
	const emptyNote = (key: string) =>
		key === "net" && input.hostNetwork ? "This container uses the host network, so its traffic is counted in the host's network chart." : "";
	return html`<section
		class="panel charts"
		data-charts
		data-host="${input.hostId}"
		data-target="${input.target}"
		data-range="${input.range}"
		data-cpus="${input.cpus ?? ""}"
	>
		<div class="charts-head">
			<h2>${input.heading}</h2>
			<div class="charts-tools">
				<button type="button" class="button small" data-chart-reset hidden>Reset zoom</button>
				${rangeRow(input.path, input.range)}
			</div>
		</div>
		<p class="charts-hint muted small">Drag across a chart to zoom in, Shift and drag to pan, Ctrl and scroll to zoom, double click to reset.</p>
		<div class="chart-grid">
			${CHARTS.map(
				(c) =>
					html`<figure class="chart" data-chart="${c.key}" data-chart-empty="${emptyNote(c.key)}">
						<figcaption>
							<span class="chart-title">${c.title}</span>
							<span class="chart-caption-end">
								<span class="chart-note muted" data-chart-note></span>
								<button type="button" class="chart-full" data-chart-full aria-pressed="false">Full screen</button>
							</span>
						</figcaption>
						<div class="chart-plot" data-chart-plot><p class="chart-empty muted">Loading...</p></div>
					</figure>`,
			)}
		</div>
		<details class="chart-table" data-chart-table>
			<summary>Show as table</summary>
			<div class="table-wrap"><p class="muted">Loading...</p></div>
		</details>
	</section>`;
}

export function filesystemsPanel(filesystems: Filesystem[]): SafeHtml {
	if (filesystems.length === 0) return html`<p class="muted">No filesystems reported yet.</p>`;
	return html`<ul class="usage-list">
		${filesystems.map((f) => {
			const share = fraction(f.used, f.used + f.avail);
			return html`<li>
				<div class="usage-head">
					<span class="mono small wrap">${f.mount}</span>
					<span class="small"
						><strong>${bytes(f.used)}</strong> <span class="muted">of ${bytes(f.used + f.avail)}, ${percent(share === null ? null : share * 100)}</span></span
					>
				</div>
				${meter(share)}
			</li>`;
		})}
	</ul>`;
}

export function engineDiskPanel(disk: DiskUsage | null): SafeHtml {
	if (!disk) return html`<p class="muted">Sizes are read about once an hour. Nothing reported yet.</p>`;
	const containers = Object.values(disk.containers).reduce((a, b) => a + b, 0);
	const volumes = Object.values(disk.volumes).reduce((a, b) => a + b, 0);
	return html`<dl class="kv">
		<div>
			<dt>Images</dt>
			<dd>${bytes(disk.images)} <span class="muted">${bytes(disk.imagesReclaimable)} unused</span></dd>
		</div>
		<div>
			<dt>Containers</dt>
			<dd>${bytes(containers)} <span class="muted">writable layers</span></dd>
		</div>
		<div>
			<dt>Volumes</dt>
			<dd>${bytes(volumes)}</dd>
		</div>
		<div>
			<dt>Build cache</dt>
			<dd>${bytes(disk.buildCache)}</dd>
		</div>
	</dl>`;
}
