import type { DiskUsage, MetricsSample } from "../shared/protocol.ts";
import type { Logger } from "./connection.ts";
import type { RuntimeClient } from "./docker.ts";
import {
	countersFromStats,
	RateTracker,
	readCgroupCounters,
	readFilesystems,
	readHostCounters,
	SYSTEM_ROOTS,
	type ContainerCounters,
	type ContainerReading,
	type Roots,
} from "./metrics.ts";

export const METRICS_INTERVAL_MS = 10_000;
const DISK_EVERY_MS = 3_600_000;
const FIRST_DISK_AFTER_MS = 20_000;

interface ProcessEntry {
	pid: number;
	hostNetwork: boolean;
	/** Set when the cgroup files cannot be read, then the stats endpoint is used for this container. */
	useStats: boolean;
}

/** Samples the host and every running container on a fixed interval, connected or not. */
export class Collector {
	private readonly tracker = new RateTracker();
	private readonly processes = new Map<string, ProcessEntry>();
	private timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
	private busy = false;
	lastDisk: DiskUsage | null = null;

	constructor(
		private readonly runtime: RuntimeClient,
		private readonly onSample: (sample: MetricsSample) => void,
		private readonly onDisk: (disk: DiskUsage) => void,
		private readonly log: Logger,
		private readonly roots: Roots = SYSTEM_ROOTS,
		private readonly intervalMs = METRICS_INTERVAL_MS,
	) {}

	start(): void {
		const run = () => {
			if (this.busy) return;
			this.busy = true;
			this.tick()
				.then(this.onSample, (err: Error) => this.log.warn(`Metrics sample failed: ${err.message}`))
				.finally(() => (this.busy = false));
		};
		run();
		this.timers.push(setInterval(run, this.intervalMs));
		this.timers.push(setTimeout(() => void this.disk(), FIRST_DISK_AFTER_MS));
		this.timers.push(setInterval(() => void this.disk(), DISK_EVERY_MS));
	}

	stop(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.timers = [];
	}

	async disk(): Promise<DiskUsage | null> {
		try {
			this.lastDisk = await this.runtime.diskUsage();
			this.onDisk(this.lastDisk);
			return this.lastDisk;
		} catch (err) {
			this.log.warn(`Disk usage failed: ${(err as Error).message}`);
			return null;
		}
	}

	private async entry(id: string, fresh = false): Promise<ProcessEntry | null> {
		let entry = this.processes.get(id);
		if (!entry || fresh) {
			try {
				const info = await this.runtime.processInfo(id);
				entry = { ...info, useStats: entry?.useStats ?? false };
				this.processes.set(id, entry);
			} catch {
				return null;
			}
		}
		return entry;
	}

	private async counters(id: string): Promise<ContainerCounters | null> {
		let entry = await this.entry(id);
		if (!entry) return null;
		if (!entry.useStats && entry.pid > 0) {
			let counters = await readCgroupCounters(this.roots, entry.pid, entry.hostNetwork);
			if (counters === null) {
				entry = await this.entry(id, true);
				if (entry && entry.pid > 0) counters = await readCgroupCounters(this.roots, entry.pid, entry.hostNetwork);
			}
			if (counters !== null) return counters;
			if (entry) entry.useStats = true;
		}
		try {
			return countersFromStats(await this.runtime.stats(id));
		} catch {
			return null;
		}
	}

	async tick(now = Date.now()): Promise<MetricsSample> {
		const running = await this.runtime.running();
		const alive = new Set(running.map((c) => c.id));
		for (const id of this.processes.keys()) if (!alive.has(id)) this.processes.delete(id);
		const [host, filesystems, readings] = await Promise.all([
			readHostCounters(this.roots),
			readFilesystems(this.roots),
			Promise.all(
				running.map(async (c): Promise<ContainerReading | null> => {
					const counters = await this.counters(c.id);
					return counters ? { id: c.id, name: c.name, counters } : null;
				}),
			),
		]);
		return this.tracker.sample(
			now,
			this.intervalMs / 1000,
			host,
			filesystems,
			readings.filter((r): r is ContainerReading => r !== null),
		);
	}
}
