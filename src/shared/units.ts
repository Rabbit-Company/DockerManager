const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function bytes(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0 B";
	const exp = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
	const n = value / 1024 ** exp;
	return `${n >= 100 || exp === 0 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")} ${UNITS[exp]}`;
}

export function rate(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "no data";
	return `${bytes(value)}/s`;
}

export function percent(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "no data";
	if (value > 0 && value < 0.1) return "<0.1%";
	return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/** CPU in cores as a share of the whole host, the way the host itself is shown. */
export function cpuShare(cores: number | null | undefined, cpus: number | null | undefined): number | null {
	if (typeof cores !== "number" || !Number.isFinite(cores) || !cpus) return null;
	return (cores / cpus) * 100;
}

export function fraction(used: number | null | undefined, total: number | null | undefined): number | null {
	if (typeof used !== "number" || typeof total !== "number" || total <= 0) return null;
	return Math.max(0, Math.min(1, used / total));
}

export type Tone = "ok" | "warn" | "bad";

/** Meters turn amber at 75% and red at 90%. */
export function meterTone(share: number | null): Tone {
	if (share === null) return "ok";
	if (share >= 0.9) return "bad";
	if (share >= 0.75) return "warn";
	return "ok";
}

function niceStep(raw: number): number {
	const exp = Math.floor(Math.log10(raw));
	const base = raw / 10 ** exp;
	const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
	return nice * 10 ** exp;
}

/** Round axis ticks from zero to at least `max`. Byte scales step in whole KB, MB or GB. */
export function ticks(max: number, kind: "number" | "bytes", count = 4): number[] {
	if (!(max > 0)) return [0, 1];
	let unit = 1;
	if (kind === "bytes") unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
	const step = niceStep(max / unit / count) * unit;
	const out: number[] = [];
	for (let v = 0; v < max + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
	return out;
}

export function compactBytes(value: number): string {
	if (value === 0) return "0";
	const exp = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
	const n = value / 1024 ** exp;
	return `${Number.isInteger(n) ? n : n.toFixed(1)} ${UNITS[exp]}`;
}
