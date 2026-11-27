import { afterAll, describe, expect, test } from "bun:test";
import {
	cgroupPath,
	countersFromStats,
	parseNetDev,
	RateTracker,
	readCgroupCounters,
	readFilesystems,
	readHostCounters,
	SampleBuffer,
} from "../src/agent/metrics.ts";
import { FakeProc } from "./fake-proc.ts";

describe("reading the kernel", () => {
	const fake = new FakeProc();
	afterAll(() => fake.cleanup());
	const roots = { proc: fake.proc, sys: fake.sys };

	test("finds the cgroup v2 path and ignores v1", () => {
		expect(cgroupPath("0::/system.slice/docker-abc.scope\n")).toBe("/system.slice/docker-abc.scope");
		expect(cgroupPath("12:memory:/docker/abc\n11:cpu:/docker/abc\n")).toBeNull();
	});

	test("container counters leave out the page cache and loopback", async () => {
		fake.container(4242, "/system.slice/docker-abc.scope", {
			usageUsec: 5_000_000,
			memCurrent: 300_000_000,
			inactive: 100_000_000,
			max: "max",
			rbytes: 1000,
			wbytes: 2000,
			rx: 3000,
			tx: 4000,
			pids: 7,
		});
		const c = await readCgroupCounters(roots, 4242, false);
		expect(c).toEqual({ cpuUsec: 5_000_000, mem: 200_000_000, memLimit: null, netRx: 3000, netTx: 4000, blkRead: 1000, blkWrite: 2000, pids: 7 });
		expect((await readCgroupCounters(roots, 4242, true))?.netRx).toBeNull();
		expect(await readCgroupCounters(roots, 999, false)).toBeNull();
	});

	test("host counters count physical interfaces and whole disks only", async () => {
		fake.host({ busy: 300, idle: 700, memTotalKb: 1000, memAvailableKb: 250, rx: 10_000, tx: 20_000, readSectors: 10, writeSectors: 20 });
		const h = await readHostCounters(roots);
		expect(h).toMatchObject({
			cpuBusy: 300,
			cpuTotal: 1000,
			cpus: 2,
			mem: 750 * 1024,
			memTotal: 1000 * 1024,
			load1: 0.52,
			netRx: 10_000,
			netTx: 20_000,
			blkRead: 5120,
			blkWrite: 10_240,
		});
	});

	test("filesystems are real, once per device, and skip engine storage", async () => {
		const fs = await readFilesystems(roots, async () => ({ blocks: 100, bsize: 4096, bfree: 40, bavail: 30 }));
		expect(fs.map((f) => f.mount)).toEqual(["/", "/mnt/backup disk"]);
		expect(fs[0]).toEqual({ mount: "/", fstype: "ext4", size: 409_600, used: 245_760, avail: 122_880 });
	});

	test("net dev parsing can keep or drop virtual interfaces", () => {
		const source = "a\nb\n  eth0: 10 0 0 0 0 0 0 0 20\n  veth1: 5 0 0 0 0 0 0 0 5\n    lo: 1 0 0 0 0 0 0 0 1\n";
		expect(parseNetDev(source, true)).toEqual({ rx: 10, tx: 20 });
		expect(parseNetDev(source, false)).toEqual({ rx: 15, tx: 25 });
	});
});

test("stats endpoint counters for cgroup v1 hosts", () => {
	const c = countersFromStats({
		cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 } },
		memory_stats: { usage: 500, limit: 1000, stats: { total_inactive_file: 100 } },
		networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
		blkio_stats: {
			io_service_bytes_recursive: [
				{ op: "Read", value: 7 },
				{ op: "Write", value: 9 },
				{ op: "Total", value: 16 },
			],
		},
		pids_stats: { current: 3 },
	});
	expect(c).toEqual({ cpuUsec: 2_000_000, mem: 400, memLimit: 1000, netRx: 11, netTx: 22, blkRead: 7, blkWrite: 9, pids: 3 });
});

describe("rates", () => {
	const counters = (cpuUsec: number, netRx: number) => ({ cpuUsec, mem: 100, memLimit: null, netRx, netTx: 0, blkRead: 0, blkWrite: 0, pids: 1 });
	const host = (busy: number, total: number, rx: number) => ({
		cpuBusy: busy,
		cpuTotal: total,
		cpus: 4,
		mem: 1,
		memTotal: 8000,
		load1: 0,
		netRx: rx,
		netTx: 0,
		blkRead: 0,
		blkWrite: 0,
	});

	test("the first reading has no rates, the second does", () => {
		const tracker = new RateTracker();
		const first = tracker.sample(0, 10, host(0, 0, 0), [], [{ id: "a", name: "web", counters: counters(0, 0) }]);
		expect(first.host?.cpu).toBeNull();
		expect(first.containers[0]!.cpu).toBeNull();
		expect(first.containers[0]!.memLimit).toBe(8000);
		const second = tracker.sample(10_000, 10, host(50, 100, 5000), [], [{ id: "a", name: "web", counters: counters(15_000_000, 1000) }]);
		expect(second.t).toBe(10);
		expect(second.host?.cpu).toBe(2);
		expect(second.host?.netRx).toBe(500);
		expect(second.containers[0]!.cpu).toBe(1.5);
		expect(second.containers[0]!.netRx).toBe(100);
	});

	test("a restarted container does not report a negative rate", () => {
		const tracker = new RateTracker();
		tracker.sample(0, 10, null, [], [{ id: "a", name: "web", counters: counters(9_000_000, 9000) }]);
		const after = tracker.sample(10_000, 10, null, [], [{ id: "a", name: "web", counters: counters(100, 10) }]);
		expect(after.containers[0]!.cpu).toBeNull();
		expect(after.containers[0]!.netRx).toBeNull();
	});
});

test("the buffer keeps the newest samples", () => {
	const buffer = new SampleBuffer(3);
	for (let t = 1; t <= 5; t++) buffer.push({ t, interval: 10, host: null, containers: [] });
	expect(buffer.drain().map((s) => s.t)).toEqual([3, 4, 5]);
	expect(buffer.size).toBe(0);
});
