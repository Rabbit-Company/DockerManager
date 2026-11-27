import type { MetricsSample } from "../../shared/protocol.ts";
import { sql, withWriteLock } from "./index.ts";

/** Host rows use an empty target, container rows the container name, which stays the same when compose recreates it. */
export const HOST_TARGET = "";

export interface MetricRow {
	host_id: number;
	target: string;
	ts: number;
	cpu: number | null;
	cpu_max: number | null;
	mem: number | null;
	mem_max: number | null;
	mem_limit: number | null;
	net_rx: number | null;
	net_tx: number | null;
	blk_read: number | null;
	blk_write: number | null;
	pids: number | null;
	samples: number;
}

export interface Retention {
	rawHours: number;
	minuteDays: number;
	hourDays: number;
}

export const DEFAULT_RETENTION: Retention = { rawHours: 24, minuteDays: 14, hourDays: 365 };

const finite = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function rowsFromSample(hostId: number, sample: MetricsSample): MetricRow[] {
	const ts = Math.floor(sample.t);
	const rows: MetricRow[] = [];
	if (sample.host) {
		const h = sample.host;
		rows.push({
			host_id: hostId,
			target: HOST_TARGET,
			ts,
			cpu: finite(h.cpu),
			cpu_max: finite(h.cpu),
			mem: finite(h.mem),
			mem_max: finite(h.mem),
			mem_limit: finite(h.memTotal),
			net_rx: finite(h.netRx),
			net_tx: finite(h.netTx),
			blk_read: finite(h.blkRead),
			blk_write: finite(h.blkWrite),
			pids: null,
			samples: 1,
		});
	}
	const seen = new Set<string>();
	for (const c of sample.containers) {
		if (typeof c.name !== "string" || c.name.length === 0 || c.name.length > 255 || seen.has(c.name)) continue;
		seen.add(c.name);
		rows.push({
			host_id: hostId,
			target: c.name,
			ts,
			cpu: finite(c.cpu),
			cpu_max: finite(c.cpu),
			mem: finite(c.mem),
			mem_max: finite(c.mem),
			mem_limit: finite(c.memLimit),
			net_rx: finite(c.netRx),
			net_tx: finite(c.netTx),
			blk_read: finite(c.blkRead),
			blk_write: finite(c.blkWrite),
			pids: finite(c.pids),
			samples: 1,
		});
	}
	return rows;
}

type Level = "1m" | "1h";
const SIZE: Record<Level, number> = { "1m": 60, "1h": 3600 };
const INSERT_CHUNK = 500;
/** Samples still arriving for the current minute are left for the next run. */
const SETTLE_SECONDS = 20;

function source(level: Level) {
	return level === "1m" ? sql`metrics_raw` : sql`metrics_1m`;
}

function destination(level: Level) {
	return level === "1m" ? sql`metrics_1m` : sql`metrics_1h`;
}

/**
 * Buffers incoming samples and writes them in batches, rolls raw rows up into
 * minutes and minutes into hours, and deletes rows past their retention.
 * Samples that arrive late, such as a replay after a disconnect, mark their
 * buckets dirty so the next rollup computes them again.
 */
export class MetricsStore {
	private queue: MetricRow[] = [];
	private dirty: Record<Level, number> = { "1m": Infinity, "1h": Infinity };
	private done: Record<Level, number> | null = null;
	private flushing: Promise<void> | null = null;

	constructor(readonly retention: Retention = DEFAULT_RETENTION) {}

	add(hostId: number, samples: MetricsSample[]): void {
		for (const sample of samples) this.queue.push(...rowsFromSample(hostId, sample));
	}

	get pending(): number {
		return this.queue.length;
	}

	flush(): Promise<void> {
		if (this.flushing) return this.flushing.then(() => this.flush());
		if (this.queue.length === 0) return Promise.resolve();
		const rows = this.queue;
		this.queue = [];
		this.flushing = this.write(rows).finally(() => (this.flushing = null));
		return this.flushing;
	}

	private async write(rows: MetricRow[]): Promise<void> {
		const done = await this.watermarks();
		let oldest = Infinity;
		for (const row of rows) if (row.ts < oldest) oldest = row.ts;
		await withWriteLock(() =>
			sql.begin(async (tx) => {
				for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
					await tx`INSERT INTO metrics_raw ${sql(rows.slice(i, i + INSERT_CHUNK))} ON CONFLICT DO NOTHING`;
				}
			}),
		);
		if (oldest < done["1m"]) this.dirty["1m"] = Math.min(this.dirty["1m"], oldest);
	}

	private async watermarks(): Promise<Record<Level, number>> {
		if (this.done) return this.done;
		const rows: { level: string; done_until: number | string }[] = await sql`SELECT level, done_until FROM metric_rollups`;
		const done: Record<Level, number> = { "1m": 0, "1h": 0 };
		for (const row of rows) if (row.level === "1m" || row.level === "1h") done[row.level] = Number(row.done_until);
		this.done = done;
		return done;
	}

	private async rollLevel(level: Level, until: number): Promise<void> {
		const done = await this.watermarks();
		const size = SIZE[level];
		const to = Math.floor(until / size) * size;
		const start = Math.min(done[level], this.dirty[level]);
		const from = Math.floor(start / size) * size;
		if (from >= to) return;
		this.dirty[level] = Infinity;
		await withWriteLock(() =>
			sql.begin(async (tx) => {
				await tx`DELETE FROM ${destination(level)} WHERE ts >= ${from} AND ts < ${to}`;
				await tx`
					INSERT INTO ${destination(level)} (host_id, target, ts, cpu, cpu_max, mem, mem_max, mem_limit, net_rx, net_tx, blk_read, blk_write, pids, samples)
					SELECT host_id, target, ts - (ts % ${size}), AVG(cpu), MAX(cpu_max), AVG(mem), MAX(mem_max), MAX(mem_limit),
						AVG(net_rx), AVG(net_tx), AVG(blk_read), AVG(blk_write), MAX(pids), SUM(samples)
					FROM ${source(level)}
					WHERE ts >= ${from} AND ts < ${to}
					GROUP BY host_id, target, 3`;
				await tx`
					INSERT INTO metric_rollups (level, done_until) VALUES (${level}, ${to})
					ON CONFLICT (level) DO UPDATE SET done_until = excluded.done_until`;
			}),
		);
		done[level] = Math.max(done[level], to);
		if (level === "1m") this.dirty["1h"] = Math.min(this.dirty["1h"], from);
	}

	async rollup(now = Math.floor(Date.now() / 1000)): Promise<void> {
		await this.flush();
		await this.rollLevel("1m", now - SETTLE_SECONDS);
		const done = await this.watermarks();
		await this.rollLevel("1h", done["1m"]);
	}

	async prune(now = Math.floor(Date.now() / 1000)): Promise<void> {
		const r = this.retention;
		await withWriteLock(async () => {
			await sql`DELETE FROM metrics_raw WHERE ts < ${now - r.rawHours * 3600}`;
			await sql`DELETE FROM metrics_1m WHERE ts < ${now - r.minuteDays * 86_400}`;
			await sql`DELETE FROM metrics_1h WHERE ts < ${now - r.hourDays * 86_400}`;
		});
	}
}

export const RANGES = {
	"1h": { seconds: 3600, level: "raw", step: 10 },
	"6h": { seconds: 6 * 3600, level: "raw", step: 60 },
	"24h": { seconds: 86_400, level: "1m", step: 300 },
	"7d": { seconds: 7 * 86_400, level: "1m", step: 1800 },
	"30d": { seconds: 30 * 86_400, level: "1h", step: 7200 },
	"1y": { seconds: 365 * 86_400, level: "1h", step: 86_400 },
} as const;

export type Range = keyof typeof RANGES;

export function isRange(value: string | null | undefined): value is Range {
	return typeof value === "string" && Object.hasOwn(RANGES, value);
}

export interface Series {
	range: Range;
	step: number;
	from: number;
	to: number;
	t: number[];
	cpu: (number | null)[];
	cpuMax: (number | null)[];
	mem: (number | null)[];
	memMax: (number | null)[];
	memLimit: (number | null)[];
	netRx: (number | null)[];
	netTx: (number | null)[];
	blkRead: (number | null)[];
	blkWrite: (number | null)[];
	pids: (number | null)[];
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** One point per step across the whole range, with null where nothing was recorded, so gaps show as gaps. */
export async function readSeries(hostId: number, target: string, range: Range, now = Math.floor(Date.now() / 1000)): Promise<Series> {
	const { seconds, level, step } = RANGES[range];
	const to = Math.floor(now / step) * step + step;
	const from = to - Math.ceil(seconds / step) * step;
	const table = level === "raw" ? sql`metrics_raw` : level === "1m" ? sql`metrics_1m` : sql`metrics_1h`;
	const rows: Record<string, unknown>[] = await sql`
		SELECT ts - (ts % ${step}) AS b, AVG(cpu) AS cpu, MAX(cpu_max) AS cpu_max, AVG(mem) AS mem, MAX(mem_max) AS mem_max, MAX(mem_limit) AS mem_limit,
			AVG(net_rx) AS net_rx, AVG(net_tx) AS net_tx, AVG(blk_read) AS blk_read, AVG(blk_write) AS blk_write, MAX(pids) AS pids
		FROM ${table}
		WHERE host_id = ${hostId} AND target = ${target} AND ts >= ${from} AND ts < ${to}
		GROUP BY 1
		ORDER BY 1`;
	const byBucket = new Map(rows.map((r) => [Number(r.b), r]));
	const out: Series = {
		range,
		step,
		from,
		to,
		t: [],
		cpu: [],
		cpuMax: [],
		mem: [],
		memMax: [],
		memLimit: [],
		netRx: [],
		netTx: [],
		blkRead: [],
		blkWrite: [],
		pids: [],
	};
	for (let b = from; b < to; b += step) {
		const r = byBucket.get(b);
		out.t.push(b);
		out.cpu.push(num(r?.cpu));
		out.cpuMax.push(num(r?.cpu_max));
		out.mem.push(num(r?.mem));
		out.memMax.push(num(r?.mem_max));
		out.memLimit.push(num(r?.mem_limit));
		out.netRx.push(num(r?.net_rx));
		out.netTx.push(num(r?.net_tx));
		out.blkRead.push(num(r?.blk_read));
		out.blkWrite.push(num(r?.blk_write));
		out.pids.push(num(r?.pids));
	}
	return out;
}
