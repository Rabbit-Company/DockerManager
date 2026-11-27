import { fieldText, type LiveField, type LiveValues } from "../shared/live.ts";
import { meterTone } from "../shared/units.ts";
import type { LiveSample } from "./charts.ts";

function values(sample: LiveSample, target: string): LiveValues | null {
	const cpus = sample.stats?.cpus ?? null;
	const v = target === "" ? sample.stats : sample.containers[target];
	if (!v) return null;
	return {
		cpu: v.cpu ?? null,
		cpus,
		mem: v.mem ?? null,
		memLimit: target === "" ? (v.memTotal ?? null) : (v.memLimit ?? null),
		netRx: v.netRx ?? null,
		netTx: v.netTx ?? null,
		blkRead: v.blkRead ?? null,
		blkWrite: v.blkWrite ?? null,
	};
}

/** Writes the newest numbers into every value on the page that belongs to this host. */
export function updateLiveValues(sample: LiveSample): void {
	for (const node of document.querySelectorAll<HTMLElement>(`[data-m-host="${sample.host}"]`)) {
		const target = node.dataset.mTarget ?? "";
		if (target !== "" && Object.keys(sample.containers).length === 0) continue;
		const v = values(sample, target);
		if (v === null) continue;
		const { text, share } = fieldText(node.dataset.mField as LiveField, v);
		const label = node.querySelector(".metric-text");
		if (label && label.textContent !== text) label.textContent = text;
		const meter = node.querySelector("svg.meter");
		if (meter) {
			meter.setAttribute("class", `meter meter-${meterTone(share)}`);
			meter.querySelector(".meter-fill")?.setAttribute("width", String(share === null ? 0 : Math.round(share * 1000) / 10));
		}
	}
}
