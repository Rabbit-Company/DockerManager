import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { REMOVE_TABLE, renderRules, TABLE, type FirewallPolicy } from "../shared/firewall.ts";
import type { FirewallBackend, FirewallState, Listener } from "../shared/protocol.ts";

export type Exec = (cmd: string[], stdin?: string) => Promise<{ code: number; output: string }>;

export async function run(cmd: string[], stdin?: string): Promise<{ code: number; output: string }> {
	try {
		const proc = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, output: `${out}${err}`.trim() };
	} catch (err) {
		return { code: 127, output: (err as Error).message };
	}
}

interface Stored {
	confirmed: FirewallPolicy | null;
	pending: { policy: FirewallPolicy; token: string; until: number; previous: FirewallPolicy | null } | null;
	appliedAt: number | null;
	lastError: string | null;
}

const EMPTY: Stored = { confirmed: null, pending: null, appliedAt: null, lastError: null };

/**
 * Keeps the nftables table this program owns in step with the policy. An applied
 * policy is pending until confirmed and reverts on its own when the time runs
 * out, also across an agent restart, because the pending state is on disk.
 */
export class Firewall {
	private state: Stored = { ...EMPTY };
	private timer: ReturnType<typeof setTimeout> | null = null;
	onEvent: ((event: "reverted" | "restored" | "error", detail: string) => void) | null = null;

	constructor(
		private readonly exec: Exec,
		private readonly stateFile: string,
		private readonly now: () => number = Date.now,
	) {}

	private async save(): Promise<void> {
		await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
		await writeFile(this.stateFile, JSON.stringify(this.state), { mode: 0o600 });
	}

	async backend(): Promise<FirewallBackend> {
		const version = await this.exec(["nft", "--version"]);
		if (version.code !== 0) return { nft: false, version: null, permitted: false, tables: [] };
		const list = await this.exec(["nft", "list", "tables"]);
		const tables = list.code === 0 ? [...list.output.matchAll(/^table (\S+ \S+)$/gm)].map((m) => m[1]!).filter((t) => t !== `inet ${TABLE}`) : [];
		return { nft: true, version: /v(\d[\w.]*)/.exec(version.output)?.[1] ?? null, permitted: list.code === 0, tables };
	}

	status(): FirewallState {
		return {
			managed: this.state.confirmed !== null || this.state.pending !== null,
			pendingUntil: this.state.pending?.until ?? null,
			pendingToken: this.state.pending?.token ?? null,
			appliedAt: this.state.appliedAt,
			lastError: this.state.lastError,
			policy: this.state.pending?.policy ?? this.state.confirmed,
		};
	}

	/** Packets matched per rule since the table was last written, keyed by comment such as "line 3", "keep ssh" or "default". */
	async hits(): Promise<Record<string, number>> {
		const out: Record<string, number> = {};
		const r = await this.exec(["nft", "-j", "list", "table", "inet", TABLE]);
		if (r.code !== 0) return out;
		try {
			for (const item of (JSON.parse(r.output) as { nftables?: { rule?: { comment?: string; expr?: { counter?: { packets: number } }[] } }[] }).nftables ??
				[]) {
				const comment = item.rule?.comment;
				const counter = item.rule?.expr?.find((e) => e.counter)?.counter;
				if (comment && counter) out[comment] = (out[comment] ?? 0) + counter.packets;
			}
		} catch {}
		return out;
	}

	/** Replaces the whole table in one transaction, so a refused policy leaves the old rules in place. */
	private async write(policy: FirewallPolicy): Promise<void> {
		const b = await this.backend();
		if (!b.nft) throw new Error("nft is not installed on this host. Install the nftables package.");
		if (!b.permitted) throw new Error("The agent may not change the firewall. It must run as root.");
		const r = await this.exec(["nft", "-f", "-"], renderRules(policy));
		if (r.code !== 0) throw new Error(`nft refused the rules: ${r.output}`);
	}

	private async remove(): Promise<void> {
		const r = await this.exec(["nft", "-f", "-"], REMOVE_TABLE);
		if (r.code !== 0) throw new Error(`nft could not remove the table: ${r.output}`);
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const pending = this.state.pending;
		if (!pending) return;
		this.timer = setTimeout(() => void this.revert(pending.token, true), Math.max(0, pending.until - this.now()));
	}

	/** Applies a policy that reverts unless confirmed within the given seconds. */
	async apply(policy: FirewallPolicy, confirmSeconds: number): Promise<{ token: string; pendingUntil: number }> {
		const previous = this.state.pending ? this.state.pending.previous : this.state.confirmed;
		const token = crypto.randomUUID();
		const until = this.now() + Math.max(10, Math.min(600, confirmSeconds)) * 1000;
		try {
			await this.write(policy);
		} catch (err) {
			this.state.lastError = (err as Error).message;
			await this.save();
			throw err;
		}
		this.state = { ...this.state, pending: { policy, token, until, previous }, appliedAt: this.now(), lastError: null };
		await this.save();
		this.schedule();
		return { token, pendingUntil: until };
	}

	async confirm(token: string): Promise<boolean> {
		const pending = this.state.pending;
		if (!pending || pending.token !== token || pending.until < this.now()) return false;
		this.state = { ...this.state, confirmed: pending.policy, pending: null };
		await this.save();
		this.schedule();
		return true;
	}

	private async restoreRules(policy: FirewallPolicy | null): Promise<void> {
		try {
			if (policy) await this.write(policy);
			else await this.remove();
		} catch (err) {
			this.state.lastError = (err as Error).message;
		}
	}

	/** Goes back to the rules that were confirmed before, by hand or when the time to confirm runs out. */
	async revert(token?: string, timedOut = false): Promise<boolean> {
		const pending = this.state.pending;
		if (!pending || (token !== undefined && pending.token !== token)) return false;
		await this.restoreRules(pending.previous);
		this.state = { ...this.state, confirmed: pending.previous, pending: null };
		await this.save();
		this.schedule();
		if (timedOut) this.onEvent?.("reverted", "The new rules were not confirmed in time, so the previous ones are back.");
		return true;
	}

	async disable(): Promise<void> {
		if (this.state.pending || this.state.confirmed) await this.remove();
		this.state = { ...EMPTY };
		await this.save();
		this.schedule();
	}

	/** On start: finish an expired pending change, then put the confirmed rules back, which a reboot cleared. */
	async start(): Promise<void> {
		if (existsSync(this.stateFile)) {
			try {
				this.state = { ...EMPTY, ...(JSON.parse(await readFile(this.stateFile, "utf8")) as Stored) };
			} catch {
				this.state = { ...EMPTY };
			}
		}
		if (this.state.pending && this.state.pending.until <= this.now()) {
			await this.revert(undefined, true);
			return;
		}
		const active = this.state.pending?.policy ?? this.state.confirmed;
		if (active) await this.restoreRules(active);
		this.schedule();
	}

	/** Puts the table back when something removed it, such as a restart of nftables.service, whose config starts with flush ruleset. */
	async ensure(): Promise<boolean> {
		const active = this.state.pending?.policy ?? this.state.confirmed;
		if (!active) return false;
		if ((await this.exec(["nft", "list", "table", "inet", TABLE])).code === 0) return false;
		await this.restoreRules(active);
		this.onEvent?.("restored", "The firewall table was missing, probably after a restart of nftables or a flush of the ruleset, and is back.");
		return true;
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
}

function hexAddress(hex: string): string {
	if (hex.length === 8) {
		const n = Number.parseInt(hex, 16);
		return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
	}
	const words: string[] = [];
	for (let i = 0; i < 32; i += 8) {
		const w = hex.slice(i, i + 8);
		words.push(w.slice(6, 8) + w.slice(4, 6), w.slice(2, 4) + w.slice(0, 2));
	}
	const groups = words.map((g) => g.replace(/^0+(?=.)/, "").toLowerCase());
	const text = groups.join(":");
	if (text === "0:0:0:0:0:0:0:0") return "::";
	if (text === "0:0:0:0:0:0:0:1") return "::1";
	const mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(text);
	if (mapped) {
		const hi = Number.parseInt(mapped[1]!, 16);
		const lo = Number.parseInt(mapped[2]!, 16);
		return `::ffff:${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
	}
	return text;
}

/** Sockets in LISTEN state (TCP) or unconnected (UDP), with the process that owns them when it can be found. */
export async function readListeners(proc = "/proc"): Promise<Listener[]> {
	const sockets = new Map<string, { protocol: "tcp" | "udp"; address: string; port: number }>();
	for (const [file, protocol] of [
		["tcp", "tcp"],
		["tcp6", "tcp"],
		["udp", "udp"],
		["udp6", "udp"],
	] as const) {
		const text = await readFile(`${proc}/net/${file}`, "utf8").catch(() => "");
		for (const line of text.split("\n").slice(1)) {
			const f = line.trim().split(/\s+/);
			if (f.length < 10) continue;
			const [local, remote, state, , , , , , inode] = f.slice(1);
			const listening = protocol === "tcp" ? state === "0A" : state === "07" && /:0000$/.test(remote!);
			if (!listening || !local) continue;
			const [addr, portHex] = local.split(":");
			sockets.set(inode!, { protocol, address: hexAddress(addr!), port: Number.parseInt(portHex!, 16) });
		}
	}
	const owners = new Map<string, { pid: number; process: string }>();
	const pids = (await readdir(proc).catch(() => [] as string[])).filter((p) => /^\d+$/.test(p));
	for (const pid of pids) {
		const fds = await readdir(`${proc}/${pid}/fd`).catch(() => [] as string[]);
		let name: string | null = null;
		for (const fd of fds) {
			const link = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => "");
			const m = /^socket:\[(\d+)\]$/.exec(link);
			if (!m || !sockets.has(m[1]!) || owners.has(m[1]!)) continue;
			name ??= (await readFile(`${proc}/${pid}/comm`, "utf8").catch(() => "")).trim() || "unknown";
			owners.set(m[1]!, { pid: Number(pid), process: name });
		}
	}
	const seen = new Set<string>();
	const out: Listener[] = [];
	for (const [inode, s] of sockets) {
		const key = `${s.protocol}|${s.address}|${s.port}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const owner = owners.get(inode);
		out.push({ ...s, pid: owner?.pid ?? null, process: owner?.process ?? null });
	}
	return out.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol) || a.address.localeCompare(b.address));
}
