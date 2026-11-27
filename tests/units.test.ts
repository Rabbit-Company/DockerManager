import { expect, test } from "bun:test";
import { fieldText } from "../src/shared/live.ts";
import { compactBytes, cpuShare, meterTone, percent, rate, ticks } from "../src/shared/units.ts";

test("ticks start at zero and reach past the maximum in round steps", () => {
	expect(ticks(100, "number")).toEqual([0, 25, 50, 75, 100]);
	expect(ticks(8.7, "number")).toEqual([0, 2.5, 5, 7.5, 10]);
	expect(ticks(16 * 1024 ** 3, "bytes").map(compactBytes)).toEqual(["0", "5 GB", "10 GB", "15 GB", "20 GB"]);
	expect(ticks(0, "bytes")).toEqual([0, 1]);
});

test("percent, rates and meter tones", () => {
	expect(percent(0.04)).toBe("<0.1%");
	expect(percent(6.83)).toBe("6.8%");
	expect(percent(42.4)).toBe("42%");
	expect(percent(null)).toBe("no data");
	expect(rate(1536)).toBe("1.5 KB/s");
	expect(cpuShare(2, 8)).toBe(25);
	expect([meterTone(0.5), meterTone(0.8), meterTone(0.95)]).toEqual(["ok", "warn", "bad"]);
});

test("live values read the same on the server and in the browser", () => {
	const v = { cpu: 1, cpus: 4, mem: 512 * 1024 ** 2, memLimit: 1024 ** 3, netRx: 2048, netTx: null, blkRead: null, blkWrite: null };
	expect(fieldText("cpu", v)).toEqual({ text: "25%", share: 0.25 });
	expect(fieldText("mem", v)).toEqual({ text: "512 MB", share: 0.5 });
	expect(fieldText("net", v).text).toBe("in 2 KB/s, out no data");
	expect(fieldText("blk", v).text).toBe("no data");
	expect(fieldText("cpu", null).text).toBe("no data");
});
