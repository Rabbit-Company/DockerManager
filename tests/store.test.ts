import { describe, expect, test } from "bun:test";
import type { MetricsSample } from "../src/shared/protocol.ts";
import { sql } from "../src/controller/db/index.ts";
import { createHost } from "../src/controller/db/hosts.ts";
import { HOST_TARGET, MetricsStore, readSeries, readWindow, rowsFromSample, WINDOW_POINTS } from "../src/controller/db/metrics.ts";

function sample(t: number, cpu: number, mem = 100): MetricsSample {
	return {
		t,
		interval: 10,
		host: { cpu: cpu * 2, cpus: 4, mem: mem * 10, memTotal: 8000, load1: 0.1, netRx: 10, netTx: 20, blkRead: null, blkWrite: null, filesystems: [] },
		containers: [{ id: "x", name: "web", cpu, mem, memLimit: 1000, netRx: 1, netTx: 2, blkRead: 3, blkWrite: 4, pids: 5 }],
	};
}

const BASE = 1_800_000_000;

describe("metrics store", () => {
	test("rows keep host and containers apart and drop broken numbers", () => {
		const rows = rowsFromSample(1, {
			...sample(BASE, 1),
			containers: [{ ...sample(BASE, 1).containers[0]!, cpu: Number.NaN }, { ...sample(BASE, 1).containers[0]! }],
		});
		expect(rows.map((r) => r.target)).toEqual([HOST_TARGET, "web"]);
		expect(rows[1]!.cpu).toBeNull();
	});

	test("writes, ignores duplicates, rolls up and reads a series with gaps", async () => {
		const { host } = await createHost("metrics-1");
		const store = new MetricsStore();
		for (let i = 0; i < 12; i++) store.add(host.id, [sample(BASE + i * 10, i < 6 ? 1 : 3)]);
		store.add(host.id, [sample(BASE, 99)]);
		await store.flush();
		const [count] = await sql`SELECT COUNT(*) AS n FROM metrics_raw WHERE host_id = ${host.id} AND target = 'web'`;
		expect(Number(count.n)).toBe(12);

		await store.rollup(BASE + 200);
		const minutes = await sql`SELECT ts, cpu, cpu_max, samples FROM metrics_1m WHERE host_id = ${host.id} AND target = 'web' ORDER BY ts`;
		expect(minutes.map((m: any) => [Number(m.ts) - BASE, Number(m.cpu), Number(m.cpu_max), Number(m.samples)])).toEqual([
			[0, 1, 1, 6],
			[60, 3, 3, 6],
		]);

		const series = await readSeries(host.id, "web", "1h", BASE + 120);
		expect(series.t).toHaveLength(360);
		const at = (ts: number) => series.t.indexOf(ts);
		expect(series.cpu[at(BASE)]).toBe(1);
		expect(series.cpu[at(BASE + 60)]).toBe(3);
		expect(series.cpu[at(BASE - 10)]).toBeNull();
		expect(series.memLimit[at(BASE + 60)]).toBe(1000);

		const hostSeries = await readSeries(host.id, HOST_TARGET, "6h", BASE + 120);
		expect(hostSeries.step).toBe(60);
		expect(hostSeries.cpu[hostSeries.t.indexOf(BASE)]).toBe(2);
	});

	test("a zoomed window reads the finest table that still holds its start", async () => {
		const { host } = await createHost("metrics-window");
		const retention = { rawHours: 24, minuteDays: 14, hourDays: 365 };
		const store = new MetricsStore(retention);
		for (let i = 0; i < 12; i++) store.add(host.id, [sample(BASE + i * 10, i < 6 ? 1 : 3)]);
		await store.flush();
		await store.rollup(BASE + 7200);

		const fine = await readWindow(host.id, "web", BASE - 30, BASE + 150, retention, BASE + 300);
		expect(fine.range).toBeNull();
		expect(fine.step).toBe(10);
		expect(fine.from).toBe(BASE - 30);
		expect(fine.cpu[fine.t.indexOf(BASE + 50)]).toBe(1);
		expect(fine.cpu[fine.t.indexOf(BASE + 60)]).toBe(3);

		const wide = await readWindow(host.id, "web", BASE - 86_400, BASE + 3600, retention, BASE + 7200);
		expect(wide.t.length).toBeLessThanOrEqual(WINDOW_POINTS);
		expect(wide.step % 10).toBe(0);

		const old = await readWindow(host.id, "web", BASE, BASE + 600, retention, BASE + 2 * 86_400);
		expect(old.step).toBe(60);
		expect(old.cpu.slice(0, 2)).toEqual([1, 3]);

		const ancient = await readWindow(host.id, "web", BASE, BASE + 600, retention, BASE + 30 * 86_400);
		expect(ancient.step).toBe(3600);
	});

	test("late samples are rolled up again", async () => {
		const { host } = await createHost("metrics-late");
		const store = new MetricsStore();
		store.add(host.id, [sample(BASE + 3600, 1)]);
		await store.rollup(BASE + 3600 + 300);
		store.add(host.id, [sample(BASE + 3600 + 10, 5)]);
		await store.rollup(BASE + 3600 + 300);
		const [minute] = await sql`SELECT cpu, samples FROM metrics_1m WHERE host_id = ${host.id} AND target = 'web' AND ts = ${BASE + 3600}`;
		expect([Number(minute.cpu), Number(minute.samples)]).toEqual([3, 2]);
	});

	test("hours roll up from minutes and old rows are pruned", async () => {
		const { host } = await createHost("metrics-hours");
		const store = new MetricsStore({ rawHours: 1, minuteDays: 1, hourDays: 2 });
		const start = BASE + 7200;
		for (let m = 0; m < 60; m++) store.add(host.id, [sample(start + m * 60, m < 30 ? 1 : 2)]);
		await store.rollup(start + 3600 + 120);
		const [hour] = await sql`SELECT cpu, cpu_max FROM metrics_1h WHERE host_id = ${host.id} AND target = 'web' AND ts = ${start}`;
		expect([Number(hour.cpu), Number(hour.cpu_max)]).toEqual([1.5, 2]);
		const day = await readSeries(host.id, "web", "30d", start + 3600 * 3);
		expect(day.cpu[day.t.indexOf(start)]).toBe(1.5);

		await store.prune(start + 3 * 86_400);
		const [left] = await sql`SELECT COUNT(*) AS n FROM metrics_raw WHERE host_id = ${host.id}`;
		const [hours] = await sql`SELECT COUNT(*) AS n FROM metrics_1h WHERE host_id = ${host.id}`;
		expect(Number(left.n)).toBe(0);
		expect(Number(hours.n)).toBe(0);
	});
});
