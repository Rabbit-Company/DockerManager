import { readdir, readFile, statfs } from "node:fs/promises";
import type { ContainerMetrics, Filesystem, HostMetrics, MetricsSample } from "../shared/protocol.ts";

/** Running totals read from the kernel. Rates are worked out between two readings. */
export interface ContainerCounters {
	cpuUsec: number | null;
	mem: number;
	memLimit: number | null;
	netRx: number | null;
	netTx: number | null;
	blkRead: number | null;
	blkWrite: number | null;
	pids: number | null;
}

export interface HostCounters {
	cpuBusy: number;
	cpuTotal: number;
	cpus: number;
	mem: number;
	memTotal: number;
	load1: number;
	netRx: number;
	netTx: number;
	blkRead: number;
	blkWrite: number;
}

export interface Roots {
	proc: string;
	sys: string;
}

export const SYSTEM_ROOTS: Roots = { proc: "/proc", sys: "/sys" };

async function text(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

function keyValues(source: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of source.split("\n")) {
		const [key, value] = line.trim().split(/\s+/);
		if (key && value !== undefined) out.set(key, Number(value));
	}
	return out;
}

/** The cgroup v2 path of a process, or null on cgroup v1 hosts. */
export function cgroupPath(procCgroup: string): string | null {
	for (const line of procCgroup.split("\n")) if (line.startsWith("0::")) return line.slice(3).trim();
	return null;
}

/** Interfaces that carry traffic already counted on the physical interface, or no traffic at all. */
const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|podman|cni|flannel|cali|vxlan|kube|tun|tap|wg|tailscale|zt)/;

export function parseNetDev(source: string, skipVirtual: boolean): { rx: number; tx: number } {
	let rx = 0;
	let tx = 0;
	for (const line of source.split("\n").slice(2)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const name = line.slice(0, colon).trim();
		if (name === "lo" || (skipVirtual && VIRTUAL_IFACE.test(name))) continue;
		const fields = line
			.slice(colon + 1)
			.trim()
			.split(/\s+/)
			.map(Number);
		rx += fields[0] ?? 0;
		tx += fields[8] ?? 0;
	}
	return { rx, tx };
}

export function parseIoStat(source: string): { read: number; write: number } {
	let read = 0;
	let write = 0;
	for (const line of source.split("\n")) {
		const r = /rbytes=(\d+)/.exec(line);
		const w = /wbytes=(\d+)/.exec(line);
		if (r) read += Number(r[1]);
		if (w) write += Number(w[1]);
	}
	return { read, write };
}

/** Reads a container's counters from its cgroup and network namespace. Null when the files are not readable. */
export async function readCgroupCounters(roots: Roots, pid: number, hostNetwork: boolean): Promise<ContainerCounters | null> {
	const procCgroup = await text(`${roots.proc}/${pid}/cgroup`);
	if (procCgroup === null) return null;
	const relative = cgroupPath(procCgroup);
	if (relative === null) return null;
	const dir = `${roots.sys}/fs/cgroup${relative}`;
	const [cpuStat, memCurrent, memStat, memMax, ioStat, pids, netDev] = await Promise.all([
		text(`${dir}/cpu.stat`),
		text(`${dir}/memory.current`),
		text(`${dir}/memory.stat`),
		text(`${dir}/memory.max`),
		text(`${dir}/io.stat`),
		text(`${dir}/pids.current`),
		hostNetwork ? Promise.resolve(null) : text(`${roots.proc}/${pid}/net/dev`),
	]);
	if (cpuStat === null || memCurrent === null) return null;
	const inactive = memStat ? (keyValues(memStat).get("inactive_file") ?? 0) : 0;
	const io = ioStat ? parseIoStat(ioStat) : null;
	const net = netDev ? parseNetDev(netDev, false) : null;
	const max = memMax?.trim();
	return {
		cpuUsec: keyValues(cpuStat).get("usage_usec") ?? null,
		mem: Math.max(0, Number(memCurrent.trim()) - inactive),
		memLimit: max && max !== "max" ? Number(max) : null,
		netRx: net?.rx ?? null,
		netTx: net?.tx ?? null,
		blkRead: io?.read ?? null,
		blkWrite: io?.write ?? null,
		pids: pids ? Number(pids.trim()) : null,
	};
}

/** The same counters from the engine's stats endpoint, for cgroup v1 hosts. */
export function countersFromStats(stats: Record<string, any>): ContainerCounters {
	const memory = stats.memory_stats ?? {};
	const inactive = Number(memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0);
	let netRx: number | null = null;
	let netTx: number | null = null;
	if (stats.networks && typeof stats.networks === "object") {
		netRx = 0;
		netTx = 0;
		for (const n of Object.values(stats.networks) as Record<string, number>[]) {
			netRx += Number(n.rx_bytes ?? 0);
			netTx += Number(n.tx_bytes ?? 0);
		}
	}
	let blkRead: number | null = null;
	let blkWrite: number | null = null;
	const io = stats.blkio_stats?.io_service_bytes_recursive;
	if (Array.isArray(io)) {
		blkRead = 0;
		blkWrite = 0;
		for (const entry of io) {
			const op = String(entry.op ?? "").toLowerCase();
			if (op === "read") blkRead += Number(entry.value ?? 0);
			if (op === "write") blkWrite += Number(entry.value ?? 0);
		}
	}
	const total = stats.cpu_stats?.cpu_usage?.total_usage;
	return {
		cpuUsec: typeof total === "number" ? total / 1000 : null,
		mem: Math.max(0, Number(memory.usage ?? 0) - inactive),
		memLimit: typeof memory.limit === "number" && memory.limit > 0 ? memory.limit : null,
		netRx,
		netTx,
		blkRead,
		blkWrite,
		pids: typeof stats.pids_stats?.current === "number" ? stats.pids_stats.current : null,
	};
}

const SKIP_DISK = /^(loop|ram|zram|dm-|md|sr|fd|nbd)/;

export async function readHostCounters(roots: Roots): Promise<HostCounters | null> {
	const [stat, meminfo, loadavg, netDev, diskstats, blockDevices] = await Promise.all([
		text(`${roots.proc}/stat`),
		text(`${roots.proc}/meminfo`),
		text(`${roots.proc}/loadavg`),
		text(`${roots.proc}/net/dev`),
		text(`${roots.proc}/diskstats`),
		readdir(`${roots.sys}/block`).catch(() => [] as string[]),
	]);
	if (stat === null || meminfo === null) return null;
	const cpuLine = stat.split("\n").find((l) => l.startsWith("cpu "));
	const cpuFields = (cpuLine ?? "").trim().split(/\s+/).slice(1).map(Number);
	const idle = (cpuFields[3] ?? 0) + (cpuFields[4] ?? 0);
	const cpuTotal = cpuFields.slice(0, 8).reduce((a, b) => a + b, 0);
	const cpus = stat.split("\n").filter((l) => /^cpu\d+ /.test(l)).length || 1;
	const mem = new Map<string, number>();
	for (const line of meminfo.split("\n")) {
		const match = /^(\w+):\s+(\d+)/.exec(line);
		if (match) mem.set(match[1]!, Number(match[2]) * 1024);
	}
	const memTotal = mem.get("MemTotal") ?? 0;
	const memAvailable = mem.get("MemAvailable") ?? mem.get("MemFree") ?? 0;
	const net = netDev ? parseNetDev(netDev, true) : { rx: 0, tx: 0 };
	const disks = new Set(blockDevices.filter((d) => !SKIP_DISK.test(d)));
	let blkRead = 0;
	let blkWrite = 0;
	for (const line of (diskstats ?? "").split("\n")) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10 || !disks.has(f[2]!)) continue;
		blkRead += Number(f[5]) * 512;
		blkWrite += Number(f[9]) * 512;
	}
	return {
		cpuBusy: cpuTotal - idle,
		cpuTotal,
		cpus,
		mem: Math.max(0, memTotal - memAvailable),
		memTotal,
		load1: Number((loadavg ?? "0").split(" ")[0]) || 0,
		netRx: net.rx,
		netTx: net.tx,
		blkRead,
		blkWrite,
	};
}

const REAL_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "bcachefs", "jfs", "reiserfs", "nfs", "nfs4", "cifs", "smb3", "fuseblk"]);
const SKIP_MOUNT = /^\/(proc|sys|dev|run|snap|var\/lib\/(docker|containers))(\/|$)|^\/boot\/efi$/;

/** Filesystems people care about: real ones, once per device, at their shortest mount point. */
export async function readFilesystems(
	roots: Roots,
	stat: (path: string) => Promise<{ blocks: number; bsize: number; bfree: number; bavail: number }> = statfs as never,
): Promise<Filesystem[]> {
	const mounts = await text(`${roots.proc}/mounts`);
	if (mounts === null) return [];
	const byDevice = new Map<string, { mount: string; fstype: string }>();
	for (const line of mounts.split("\n")) {
		const [device, rawMount, fstype] = line.split(" ");
		if (!device || !rawMount || !fstype || !REAL_FS.has(fstype)) continue;
		const mount = rawMount.replace(/\\040/g, " ");
		if (SKIP_MOUNT.test(mount)) continue;
		const known = byDevice.get(device);
		if (!known || mount.length < known.mount.length) byDevice.set(device, { mount, fstype });
	}
	const out: Filesystem[] = [];
	for (const { mount, fstype } of byDevice.values()) {
		try {
			const s = await stat(mount);
			const size = s.blocks * s.bsize;
			if (size === 0) continue;
			out.push({ mount, fstype, size, used: (s.blocks - s.bfree) * s.bsize, avail: s.bavail * s.bsize });
		} catch {}
	}
	return out.sort((a, b) => a.mount.localeCompare(b.mount));
}

function rate(now: number | null, before: number | null | undefined, seconds: number): number | null {
	if (now === null || before === null || before === undefined || seconds <= 0) return null;
	const delta = now - before;
	return delta < 0 ? null : delta / seconds;
}

export interface ContainerReading {
	id: string;
	name: string;
	counters: ContainerCounters;
}

/** Turns two readings in a row into rates. A container seen for the first time, or restarted, gets no rate that round. */
export class RateTracker {
	private host: { at: number; counters: HostCounters } | null = null;
	private containers = new Map<string, { at: number; counters: ContainerCounters }>();

	sample(at: number, interval: number, host: HostCounters | null, filesystems: Filesystem[], readings: ContainerReading[]): MetricsSample {
		let hostMetrics: HostMetrics | null = null;
		if (host) {
			const prev = this.host;
			const seconds = prev ? (at - prev.at) / 1000 : 0;
			const total = prev ? host.cpuTotal - prev.counters.cpuTotal : 0;
			hostMetrics = {
				cpu: prev && total > 0 ? ((host.cpuBusy - prev.counters.cpuBusy) / total) * host.cpus : null,
				cpus: host.cpus,
				mem: host.mem,
				memTotal: host.memTotal,
				load1: host.load1,
				netRx: rate(host.netRx, prev?.counters.netRx, seconds),
				netTx: rate(host.netTx, prev?.counters.netTx, seconds),
				blkRead: rate(host.blkRead, prev?.counters.blkRead, seconds),
				blkWrite: rate(host.blkWrite, prev?.counters.blkWrite, seconds),
				filesystems,
			};
			this.host = { at, counters: host };
		}
		const seen = new Map<string, { at: number; counters: ContainerCounters }>();
		const containers: ContainerMetrics[] = [];
		for (const r of readings) {
			const prev = this.containers.get(r.id);
			seen.set(r.id, { at, counters: r.counters });
			const seconds = prev ? (at - prev.at) / 1000 : 0;
			const cpuUsec = rate(r.counters.cpuUsec, prev?.counters.cpuUsec, seconds);
			containers.push({
				id: r.id,
				name: r.name,
				cpu: cpuUsec === null ? null : cpuUsec / 1_000_000,
				mem: r.counters.mem,
				memLimit: r.counters.memLimit ?? host?.memTotal ?? 0,
				netRx: rate(r.counters.netRx, prev?.counters.netRx, seconds),
				netTx: rate(r.counters.netTx, prev?.counters.netTx, seconds),
				blkRead: rate(r.counters.blkRead, prev?.counters.blkRead, seconds),
				blkWrite: rate(r.counters.blkWrite, prev?.counters.blkWrite, seconds),
				pids: r.counters.pids,
			});
		}
		this.containers = seen;
		return { t: Math.round(at / 1000), interval, host: hostMetrics, containers };
	}
}

/** Keeps samples while the controller is unreachable, oldest dropped first. */
export class SampleBuffer {
	private items: MetricsSample[] = [];

	constructor(readonly max = 720) {}

	push(sample: MetricsSample): void {
		this.items.push(sample);
		if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
	}

	drain(): MetricsSample[] {
		const out = this.items;
		this.items = [];
		return out;
	}

	get size(): number {
		return this.items.length;
	}
}
