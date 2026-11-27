import { bytes, cpuShare, fraction, percent, rate } from "./units.ts";

export type LiveField = "cpu" | "mem" | "net" | "blk";

export interface LiveValues {
	cpu: number | null;
	cpus: number | null;
	mem: number | null;
	memLimit: number | null;
	netRx: number | null;
	netTx: number | null;
	blkRead: number | null;
	blkWrite: number | null;
}

/** The same text the browser writes when a new sample arrives, used by the server render and by the browser on every sample. */
export function fieldText(field: LiveField, v: LiveValues | null): { text: string; share: number | null } {
	if (v === null) return { text: "no data", share: null };
	switch (field) {
		case "cpu": {
			const share = cpuShare(v.cpu, v.cpus);
			return { text: percent(share), share: share === null ? null : Math.min(1, share / 100) };
		}
		case "mem":
			return { text: v.mem === null ? "no data" : bytes(v.mem), share: fraction(v.mem, v.memLimit) };
		case "net":
			return { text: v.netRx === null && v.netTx === null ? "no data" : `in ${rate(v.netRx)}, out ${rate(v.netTx)}`, share: null };
		case "blk":
			return { text: v.blkRead === null && v.blkWrite === null ? "no data" : `read ${rate(v.blkRead)}, write ${rate(v.blkWrite)}`, share: null };
	}
}
