import { expect, test } from "bun:test";
import { mergeView } from "../src/web/charts.ts";
import { timeTicks } from "../src/web/chart.ts";

const series = (t0: number, step: number, values: (number | null)[]) => ({
	t: values.map((_, i) => t0 + i * step),
	step,
	cpu: values,
	mem: values,
	memLimit: values.map(() => null),
	netRx: values,
	netTx: values,
	blkRead: values,
	blkWrite: values,
});

test("a zoomed window's finer buckets replace the coarse ones they cover", () => {
	const base = series(0, 60, [1, 2, 3, 4, 5]);
	const detail = series(60, 10, [20, 21, 22, 23, 24, 25, 30, null, 32, 33, 34, 35]);
	const view = mergeView(base, detail);
	expect(view.t).toEqual([0, ...detail.t, 180, 240]);
	expect(view.w).toEqual([60, ...detail.t.map(() => 10), 60, 60]);
	expect(view.cpu).toEqual([1, ...detail.cpu, 4, 5]);
	expect([view.from, view.to]).toEqual([0, 300]);
	expect(mergeView(base, null).cpu).toEqual([1, 2, 3, 4, 5]);
});

test("time ticks fall on whole steps and leave room for their labels", () => {
	const { values, step } = timeTicks(1_800_000_005, 1_800_000_005 + 3600, 600);
	expect(step).toBe(600);
	expect(values.every((v) => v % 600 === 0)).toBe(true);
	expect(timeTicks(0, 60, 600).step).toBe(10);
});
