import {
	CONTAINER_ACTIONS,
	PROTOCOL_VERSION,
	parseControllerMessage,
	type AgentMessage,
	type ContainerAction,
	type DiskUsage,
	type Methods,
	type MetricsSample,
	type StorageReport,
} from "../shared/protocol.ts";
import { isContainerRef } from "../shared/validate.ts";
import { VERSION } from "../shared/version.ts";
import { RuntimeError, type RuntimeClient } from "./docker.ts";
import type { SampleBuffer } from "./metrics.ts";
import { readListeners, type Firewall } from "./firewall.ts";
import { parseRules, formatRule, type FirewallPolicy } from "../shared/firewall.ts";
import type { RunParams, StackAction, StackService } from "./stacks.ts";
import { deleteBackup, listItems, restoreBackup, runBackup, testDestination, verifyBackup, type BackupRuntime } from "./backup/runner.ts";
import type { BackupItem, BackupMode, DestinationConfig, Listener } from "../shared/protocol.ts";
import { hostname } from "node:os";
import type { AgentState } from "./state.ts";

const HEARTBEAT_MS = 15_000;
const DEAD_AFTER_MS = 45_000;
const RESNAPSHOT_MS = 60_000;
const SNAPSHOT_DEBOUNCE_MS = 500;
const LOG_FLUSH_MS = 100;
const MAX_LOG_STREAMS = 20;
const REPLAY_BATCH = 360;
const STREAM_ID = /^[a-zA-Z0-9_-]{8,64}$/;

/** The agent runs only rules it can parse itself, so a policy is checked again here instead of trusted as sent. */
function checkPolicyShape(raw: unknown): FirewallPolicy | null {
	if (typeof raw !== "object" || raw === null) return null;
	const p = raw as Record<string, unknown>;
	if (!Array.isArray(p.rules)) return null;
	const text = (p.rules as Parameters<typeof formatRule>[0][]).map((r) => formatRule({ ...r, comment: null })).join("\n");
	const parsed = parseRules(text);
	if (parsed.errors.length > 0 || parsed.rules.length !== p.rules.length) return null;
	const ssh = Number(p.sshPort);
	if (!Number.isInteger(ssh) || ssh < 0 || ssh > 65535) return null;
	const rules = parsed.rules.map((r, i) => ({ ...r, line: Number((p.rules as { line?: number }[])[i]?.line) || r.line }));
	return {
		rules,
		hostDefault: p.hostDefault === "drop" ? "drop" : "accept",
		containerDefault: p.containerDefault === "drop" ? "drop" : "accept",
		sshPort: ssh,
	};
}

function streamId(value: unknown): string {
	if (typeof value !== "string" || !STREAM_ID.test(value)) throw new Error("Bad stream id.");
	return value;
}

function stackFiles(params: Record<string, unknown>) {
	return {
		name: String(params.name ?? ""),
		directory: typeof params.directory === "string" ? params.directory : null,
		file: String(params.file ?? "compose.yaml"),
		compose: String(params.compose ?? ""),
		env: String(params.env ?? ""),
	};
}

export interface MetricsSource {
	buffer: SampleBuffer;
	lastDisk(): DiskUsage | null;
}

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export function backoff(attempt: number): number {
	const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
	return Math.round(base / 2 + Math.random() * (base / 2));
}

export function agentSocketUrl(controller: string, hostId: number): string {
	const url = new URL(`/api/agent/ws?host=${hostId}`, controller);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

/** One session with the controller. Ends when the socket closes, the caller reconnects. */
export class AgentSession {
	private ws: WebSocket | null = null;
	private readonly logs = new Map<string, AbortController>();
	private events: AbortController | null = null;
	private timers: ReturnType<typeof setInterval>[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPong = Date.now();
	private ready = false;

	constructor(
		private readonly state: AgentState,
		private readonly runtime: RuntimeClient,
		private readonly log: Logger,
		private readonly metrics: MetricsSource | null = null,
		private readonly stacks: StackService | null = null,
		private readonly firewall: Firewall | null = null,
		private readonly listeners: () => Promise<Listener[]> = () => readListeners(),
		private readonly lastStorage: () => StorageReport | null = () => null,
	) {}

	/** Tells the controller when the firewall changed on its own, such as a revert. */
	firewallEvent(event: "reverted" | "restored" | "error", detail: string): void {
		this.send({ type: "firewall", event, detail });
	}

	private requireFirewall(): Firewall {
		if (!this.firewall) throw new Error("This agent does not manage a firewall.");
		return this.firewall;
	}

	/** Sends a sample at once when connected. Returns false so the caller keeps it for later. */
	offerSample(sample: MetricsSample): boolean {
		if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
		this.send({ type: "metrics", samples: [sample] });
		return true;
	}

	offerDisk(disk: DiskUsage): void {
		if (this.ready) this.send({ type: "disk", disk });
	}

	offerStorage(storage: StorageReport): void {
		if (this.ready) this.send({ type: "storage", storage });
	}

	run(): Promise<void> {
		return new Promise((resolve) => {
			const ws = new WebSocket(agentSocketUrl(this.state.controller, this.state.hostId), {
				headers: { Authorization: `Bearer ${this.state.hostId}.${this.state.secret}`, "User-Agent": `dockermanager-agent/${VERSION}` },
			} as unknown as string[]);
			this.ws = ws;
			ws.addEventListener("open", () => void this.opened());
			ws.addEventListener("message", (event) => void this.received(String(event.data)));
			ws.addEventListener("error", () => {});
			ws.addEventListener("close", (event) => {
				this.cleanup();
				if (event.code === 4001) this.log.error("The controller refused this agent. Enroll it again with a new join token.");
				resolve();
			});
		});
	}

	private send(message: AgentMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
	}

	private async opened(): Promise<void> {
		this.log.info(`Connected to ${this.state.controller}`);
		this.lastPong = Date.now();
		try {
			this.send({ type: "hello", protocol: PROTOCOL_VERSION, facts: await this.runtime.facts(VERSION) });
			await this.sendSnapshot();
			if (this.metrics) {
				const replay = this.metrics.buffer.drain();
				for (let i = 0; i < replay.length; i += REPLAY_BATCH) this.send({ type: "metrics", samples: replay.slice(i, i + REPLAY_BATCH) });
				if (replay.length > 0) this.log.info(`Sent ${replay.length} samples collected while disconnected`);
				const disk = this.metrics.lastDisk();
				if (disk) this.send({ type: "disk", disk });
			}
			const storage = this.lastStorage();
			if (storage) this.send({ type: "storage", storage });
			this.ready = true;
		} catch (err) {
			this.log.error(`Could not read the container runtime: ${(err as Error).message}`);
			this.ws?.close(1011, "runtime unavailable");
			return;
		}
		this.timers.push(
			setInterval(() => {
				if (Date.now() - this.lastPong > DEAD_AFTER_MS) {
					this.log.warn("No answer from the controller, reconnecting");
					this.ws?.close(4000, "heartbeat timeout");
					return;
				}
				this.send({ type: "ping" });
			}, HEARTBEAT_MS),
			setInterval(() => void this.sendSnapshot(), RESNAPSHOT_MS),
		);
		void this.followEvents();
	}

	private async followEvents(): Promise<void> {
		while (this.ws?.readyState === WebSocket.OPEN) {
			this.events = new AbortController();
			try {
				await this.runtime.events(this.events.signal, (event) => {
					this.send({ type: "event", event });
					this.scheduleSnapshot();
				});
			} catch (err) {
				if (this.events.signal.aborted) return;
				this.log.warn(`Event stream ended: ${(err as Error).message}`);
			}
			if (this.events.signal.aborted) return;
			await Bun.sleep(2000);
		}
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			void this.sendSnapshot();
		}, SNAPSHOT_DEBOUNCE_MS);
	}

	private async sendSnapshot(): Promise<void> {
		try {
			this.send({ type: "snapshot", snapshot: await this.runtime.snapshot() });
		} catch (err) {
			this.log.warn(`Snapshot failed: ${(err as Error).message}`);
		}
	}

	private async received(raw: string): Promise<void> {
		const message = parseControllerMessage(raw);
		if (message === null) return;
		if (message.type === "pong") {
			this.lastPong = Date.now();
			return;
		}
		if (message.type !== "req") return;
		try {
			const result = await this.handle(message.method, message.params);
			this.send({ type: "res", id: message.id, ok: true, result });
		} catch (err) {
			this.send({ type: "res", id: message.id, ok: false, error: (err as Error).message });
		}
	}

	async handle(method: string, raw: unknown): Promise<unknown> {
		const params = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
		const ref = (value: unknown): string => {
			if (typeof value !== "string" || !isContainerRef(value)) throw new Error("Unknown container.");
			return value;
		};
		switch (method) {
			case "container.action": {
				const action = params.action as ContainerAction;
				if (!CONTAINER_ACTIONS.includes(action)) throw new Error("Unknown action.");
				await this.runtime.action(ref(params.id), action, params.removeVolumes === true);
				this.scheduleSnapshot();
				return { ok: true } satisfies Methods["container.action"]["result"];
			}
			case "container.inspect":
				return await this.runtime.inspect(ref(params.id));
			case "logs.open":
				return this.openLogs(String(params.stream ?? ""), ref(params.id), Number(params.tail ?? 200));
			case "logs.close":
				this.logs.get(String(params.stream ?? ""))?.abort();
				return { ok: true };
			case "snapshot.refresh":
				await this.sendSnapshot();
				return { ok: true };
			case "stack.validate":
				return this.requireStacks().validate(stackFiles(params));
			case "stack.read":
				return this.requireStacks().read(String(params.project ?? ""));
			case "stack.remove":
				return this.requireStacks().remove(typeof params.directory === "string" ? params.directory : null, String(params.name ?? ""));
			case "backup.items": {
				return listItems(
					this.backupRuntime(),
					String(params.project ?? ""),
					typeof params.directory === "string" ? params.directory : null,
					String(params.file ?? "compose.yaml"),
				);
			}
			case "backup.volume.check": {
				const names = params.names;
				if (!Array.isArray(names) || names.length > 500 || names.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(name)))
					throw new Error("Bad volume names.");
				const existing: string[] = [];
				for (const name of names as string[]) {
					try {
						await this.runtime.volumeMountpoint(name);
						existing.push(name);
					} catch (err) {
						if (!(err instanceof RuntimeError) || err.status !== 404) throw err;
					}
				}
				return { existing } satisfies Methods["backup.volume.check"]["result"];
			}
			case "backup.run": {
				const stream = streamId(params.stream);
				const runtime = this.backupRuntime();
				const input = {
					destination: params.destination as DestinationConfig,
					key: String(params.key ?? ""),
					set: String(params.set ?? ""),
					project: String(params.project ?? ""),
					directory: typeof params.directory === "string" ? params.directory : null,
					items: (Array.isArray(params.items) ? params.items : []) as BackupItem[],
					mode: (params.mode === "live" ? "live" : "stop") as BackupMode,
					host: hostname(),
				};
				this.pipe(stream, (push) => runBackup(runtime, input, push));
				return { ok: true };
			}
			case "backup.restore": {
				const stream = streamId(params.stream);
				const runtime = this.backupRuntime();
				const input = {
					destination: params.destination as DestinationConfig,
					key: String(params.key ?? ""),
					set: String(params.set ?? ""),
					project: String(params.project ?? ""),
					directory: typeof params.directory === "string" ? params.directory : null,
					items: (Array.isArray(params.items) ? params.items : []).map(String),
				};
				this.pipe(stream, async (push) => {
					await restoreBackup(runtime, input, push);
					this.scheduleSnapshot();
				});
				return { ok: true };
			}
			case "backup.verify": {
				const stream = streamId(params.stream);
				const input = { destination: params.destination as DestinationConfig, key: String(params.key ?? ""), set: String(params.set ?? "") };
				this.pipe(stream, (push) => verifyBackup(input, push));
				return { ok: true };
			}
			case "backup.delete":
				await deleteBackup({ destination: params.destination as DestinationConfig, set: String(params.set ?? "") });
				return { ok: true };
			case "backup.test":
				return { ok: true, note: await testDestination(params.destination as DestinationConfig) };
			case "firewall.inspect": {
				const firewall = this.requireFirewall();
				const [backend, listeners, hits] = await Promise.all([firewall.backend(), this.listeners(), firewall.hits()]);
				return { backend, state: firewall.status(), listeners, hits };
			}
			case "firewall.apply": {
				const check = checkPolicyShape(params.policy);
				if (!check) throw new Error("The firewall policy could not be read.");
				return this.requireFirewall().apply(check, Number(params.confirmSeconds ?? 90));
			}
			case "firewall.confirm":
				return { confirmed: await this.requireFirewall().confirm(String(params.token ?? "")) };
			case "firewall.revert":
				return { reverted: await this.requireFirewall().revert(String(params.token ?? "")) };
			case "firewall.disable":
				await this.requireFirewall().disable();
				return { ok: true };
			case "stack.run":
				return this.runStack(String(params.stream ?? ""), {
					...stackFiles(params),
					action: String(params.action ?? "") as StackAction,
					healthTimeout: typeof params.healthTimeout === "number" ? params.healthTimeout : undefined,
				});
			default:
				throw new Error(`Unknown method ${method}.`);
		}
	}

	private backupRuntime(): BackupRuntime {
		const runtime = this.runtime;
		const stacks = this.stacks;
		return {
			socket: runtime.socket,
			projectMounts: (project) => runtime.projectMounts(project),
			volumeMountpoint: (name, create) => runtime.volumeMountpoint(name, create),
			action: (id, action) => runtime.action(id, action),
			cli: async () => {
				if (!stacks) return runtime.runtime === "podman" ? "podman" : "docker";
				const tool = await stacks.compose();
				return tool.command[0] === "podman" ? "podman" : "docker";
			},
		};
	}

	private requireStacks(): StackService {
		if (!this.stacks) throw new Error("This agent does not manage stacks.");
		return this.stacks;
	}

	/** Sends a task's output in batches, then a stream.end with its error if it failed. */
	private pipe(stream: string, task: (push: (text: string) => void) => Promise<unknown>, onDone?: () => void): void {
		let pending = "";
		const flush = () => {
			if (pending.length === 0) return;
			this.send({ type: "stream", stream, data: pending });
			pending = "";
		};
		const timer = setInterval(flush, LOG_FLUSH_MS);
		task((text) => {
			pending += text;
			if (pending.length > 64_000) flush();
		})
			.then(
				(result) => (result === undefined ? {} : { result }),
				(err: Error) => ({ error: err.message }),
			)
			.then((end) => {
				clearInterval(timer);
				flush();
				onDone?.();
				this.send({ type: "stream.end", stream, ...end });
			});
	}

	private openLogs(stream: string, id: string, tail: number): { ok: true } {
		if (!STREAM_ID.test(stream)) throw new Error("Bad stream id.");
		if (this.logs.size >= MAX_LOG_STREAMS) throw new Error("Too many open log streams on this host.");
		const controller = new AbortController();
		this.logs.set(stream, controller);
		const lines = Math.max(0, Math.min(5000, Math.floor(tail) || 0));
		this.pipe(
			stream,
			(push) => this.runtime.followLogs(id, lines, controller.signal, push),
			() => this.logs.delete(stream),
		);
		return { ok: true };
	}

	/** Starts a compose run. It keeps going if the connection drops, only its output is lost then. */
	private async runStack(stream: string, params: RunParams): Promise<{ directory: string }> {
		if (!STREAM_ID.test(stream)) throw new Error("Bad stream id.");
		const stacks = this.requireStacks();
		const prepared = await stacks.prepare(params);
		this.pipe(stream, async (push) => {
			await stacks.run(params, prepared, push);
			this.scheduleSnapshot();
		});
		return { directory: prepared.dir };
	}

	private cleanup(): void {
		this.ready = false;
		for (const timer of this.timers) clearInterval(timer);
		this.timers = [];
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = null;
		this.events?.abort();
		for (const controller of this.logs.values()) controller.abort();
		this.logs.clear();
		this.ws = null;
	}

	close(): void {
		this.ws?.close(1000, "agent stopping");
	}
}
