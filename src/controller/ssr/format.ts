import { outputTime } from "../../shared/output-time.ts";
import type { PortBinding } from "../../shared/protocol.ts";

export { bytes } from "../../shared/units.ts";

export function ago(isoOrMs: string | number | null, now = Date.now()): string {
	if (isoOrMs === null) return "never";
	const then = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 36) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 60) return `${days} days ago`;
	return new Date(then).toISOString().slice(0, 10);
}

/** Like 2026-11-16 14:43:20 in the controller's time zone (TZ), the same clock as job output and logs. */
export function dateTime(iso: string | null): string {
	if (iso === null) return "";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : outputTime(date);
}

export function shortId(id: string): string {
	return id.replace(/^sha256:/, "").slice(0, 12);
}

export type Exposure = "public" | "local" | "internal";

export interface PortRow {
	publicPort: number | null;
	privatePort: number;
	type: string;
	addresses: string[];
	exposure: Exposure;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Docker lists 0.0.0.0 and :: as two bindings of one port. This merges them and says who can reach the port. */
export function portRows(ports: PortBinding[]): PortRow[] {
	const rows = new Map<string, PortRow>();
	for (const p of ports) {
		const key = `${p.publicPort ?? "-"}:${p.privatePort}/${p.type}`;
		let row = rows.get(key);
		if (!row) {
			row = { publicPort: p.publicPort, privatePort: p.privatePort, type: p.type, addresses: [], exposure: "internal" };
			rows.set(key, row);
		}
		if (p.publicPort === null) continue;
		const ip = p.ip ?? "0.0.0.0";
		if (!row.addresses.includes(ip)) row.addresses.push(ip);
		const exposure: Exposure = LOOPBACK.has(ip) ? "local" : "public";
		if (row.exposure !== "public") row.exposure = exposure;
	}
	return [...rows.values()].sort((a, b) => (a.publicPort ?? 1e6) - (b.publicPort ?? 1e6) || a.privatePort - b.privatePort);
}

export function stateTone(state: string): "ok" | "warn" | "bad" | "idle" {
	if (state === "running") return "ok";
	if (state === "restarting" || state === "paused" || state === "created" || state === "starting") return "warn";
	if (state === "dead" || state === "unhealthy") return "bad";
	return "idle";
}
