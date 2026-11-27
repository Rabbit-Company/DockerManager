import {
	PROTOCOL_VERSION,
	parseAgentMessage,
	type ControllerMessage,
	type DiskUsage,
	type HostFacts,
	type Method,
	type Methods,
	type MetricsSample,
	type Snapshot,
	type StorageReport,
} from "../shared/protocol.ts";
import { randomToken } from "./lib/crypto.ts";

export interface Socket {
	send(data: string): unknown;
	close(code?: number, reason?: string): void;
}

interface Pending {
	hostId: number;
	ws: Socket;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

interface AgentLink {
	ws: Socket;
	facts: HostFacts | null;
	snapshot: Snapshot | null;
	signature: string;
	latest: MetricsSample | null;
	disk: DiskUsage | null;
	storage: StorageReport | null;
	connectedAt: number;
	lastMessageAt: number;
}

/** Where the output of a stream goes: a browser showing logs, or the controller recording a deploy. */
export interface StreamSink {
	data(text: string): void;
	end(error: string | null, result?: unknown): void;
	/** The browser that may close the stream, if any. */
	owner?: Socket;
}

interface OpenStream {
	hostId: number;
	sink: StreamSink;
}

function browserSink(stream: string, browser: Socket, send: (ws: Socket, message: Record<string, unknown>) => void): StreamSink {
	return {
		owner: browser,
		data: (data) => send(browser, { type: "logs", stream, data }),
		end: (error) => send(browser, { type: "logs.end", stream, error }),
	};
}

export interface HubHooks {
	/** Sends a message to every browser watching a topic. */
	publish(topic: string, data: string): void;
	saveFacts(hostId: number, facts: HostFacts): Promise<void>;
	touch(hostId: number): Promise<void>;
	/** Stores samples, live ones and those replayed after a disconnect. */
	metrics(hostId: number, samples: MetricsSample[]): void;
	warn(message: string): void;
}

/** What browsers get on every sample: rounded numbers, keyed by container name. */
export function liveMetrics(hostId: number, sample: MetricsSample): Record<string, unknown> {
	const round = (v: number | null | undefined, digits = 0) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
	const containers: Record<string, unknown> = {};
	for (const c of sample.containers) {
		containers[c.name] = {
			cpu: round(c.cpu, 4),
			mem: round(c.mem),
			memLimit: round(c.memLimit),
			netRx: round(c.netRx),
			netTx: round(c.netTx),
			blkRead: round(c.blkRead),
			blkWrite: round(c.blkWrite),
		};
	}
	const h = sample.host;
	return {
		type: "metrics",
		host: hostId,
		t: sample.t,
		stats: h
			? {
					cpu: round(h.cpu, 4),
					cpus: h.cpus,
					mem: round(h.mem),
					memTotal: round(h.memTotal),
					load1: round(h.load1, 2),
					netRx: round(h.netRx),
					netTx: round(h.netTx),
					blkRead: round(h.blkRead),
					blkWrite: round(h.blkWrite),
				}
			: null,
		containers,
	};
}

export class AgentOffline extends Error {
	constructor() {
		super("The agent on this host is not connected.");
	}
}

const TOUCH_EVERY_MS = 5 * 60_000;

/** What changes the overview: which containers exist and their state. Status text such as "Up 3 minutes" is left out. */
export function snapshotSignature(snapshot: Snapshot): string {
	return snapshot.containers.map((c) => `${c.id}:${c.state}:${c.name}:${c.image}`).join("|");
}

export class Hub {
	private readonly agents = new Map<number, AgentLink>();
	private readonly pending = new Map<number, Pending>();
	private readonly streams = new Map<string, OpenStream>();
	private nextId = 1;

	constructor(
		private readonly hooks: HubHooks,
		private readonly timeoutMs = 30_000,
	) {}

	/** Called when an agent reports that its firewall changed on its own. */
	onFirewall: ((hostId: number, event: string, detail: string) => void) | null = null;

	publish(topic: string, data: string): void {
		this.hooks.publish(topic, data);
	}

	isOnline(hostId: number): boolean {
		return this.agents.has(hostId);
	}

	facts(hostId: number): HostFacts | null {
		return this.agents.get(hostId)?.facts ?? null;
	}

	snapshot(hostId: number): Snapshot | null {
		return this.agents.get(hostId)?.snapshot ?? null;
	}

	latest(hostId: number): MetricsSample | null {
		return this.agents.get(hostId)?.latest ?? null;
	}

	disk(hostId: number): DiskUsage | null {
		return this.agents.get(hostId)?.disk ?? null;
	}

	storage(hostId: number): StorageReport | null {
		return this.agents.get(hostId)?.storage ?? null;
	}

	connectedAt(hostId: number): number | null {
		return this.agents.get(hostId)?.connectedAt ?? null;
	}

	private changed(hostId: number): void {
		this.hooks.publish("hosts", JSON.stringify({ type: "changed", topic: "hosts" }));
		this.hooks.publish(`host:${hostId}`, JSON.stringify({ type: "changed", topic: `host:${hostId}` }));
	}

	attach(hostId: number, ws: Socket): void {
		const previous = this.agents.get(hostId);
		if (previous) {
			this.rejectPending(hostId, previous.ws);
			previous.ws.close(4002, "replaced by a newer connection");
		}
		const now = Date.now();
		this.agents.set(hostId, {
			ws,
			facts: null,
			snapshot: null,
			signature: "",
			latest: previous?.latest ?? null,
			disk: previous?.disk ?? null,
			storage: previous?.storage ?? null,
			connectedAt: now,
			lastMessageAt: now,
		});
		this.send(ws, { type: "welcome", hostId });
		void this.hooks.touch(hostId).catch(() => {});
		this.changed(hostId);
	}

	detach(hostId: number, ws: Socket): void {
		const link = this.agents.get(hostId);
		if (!link || link.ws !== ws) return;
		this.agents.delete(hostId);
		this.rejectPending(hostId, ws);
		for (const [stream, entry] of this.streams) {
			if (entry.hostId !== hostId) continue;
			this.streams.delete(stream);
			entry.sink.end("The agent disconnected.");
		}
		void this.hooks.touch(hostId).catch(() => {});
		this.changed(hostId);
	}

	private rejectPending(hostId: number, ws: Socket): void {
		for (const [id, entry] of this.pending) {
			if (entry.hostId !== hostId || entry.ws !== ws) continue;
			this.pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(new AgentOffline());
		}
	}

	private send(ws: Socket, message: ControllerMessage | Record<string, unknown>): void {
		try {
			ws.send(JSON.stringify(message));
		} catch {}
	}

	receive(hostId: number, ws: Socket, raw: string | Buffer): void {
		const link = this.agents.get(hostId);
		if (!link || link.ws !== ws) return;
		const message = parseAgentMessage(raw);
		if (message === null) {
			this.hooks.warn(`Host ${hostId} sent a message that could not be read`);
			return;
		}
		const now = Date.now();
		if (now - link.lastMessageAt > TOUCH_EVERY_MS) void this.hooks.touch(hostId).catch(() => {});
		link.lastMessageAt = now;

		switch (message.type) {
			case "ping":
				this.send(ws, { type: "pong" });
				return;
			case "hello":
				if (message.protocol !== PROTOCOL_VERSION) {
					this.hooks.warn(`Host ${hostId} speaks protocol ${message.protocol}, the controller speaks ${PROTOCOL_VERSION}`);
				}
				link.facts = message.facts;
				void this.hooks.saveFacts(hostId, message.facts).catch((err: Error) => this.hooks.warn(`Saving facts failed: ${err.message}`));
				this.changed(hostId);
				return;
			case "snapshot": {
				link.snapshot = message.snapshot;
				const signature = snapshotSignature(message.snapshot);
				if (signature !== link.signature) {
					link.signature = signature;
					this.changed(hostId);
				}
				return;
			}
			case "event":
				return;
			case "metrics": {
				if (message.samples.length === 0) return;
				this.hooks.metrics(hostId, message.samples);
				let newest = message.samples[0]!;
				for (const sample of message.samples) if (sample.t > newest.t) newest = sample;
				if (link.latest && link.latest.t >= newest.t) return;
				link.latest = newest;
				const live = liveMetrics(hostId, newest);
				this.hooks.publish(`metrics:${hostId}`, JSON.stringify(live));
				this.hooks.publish("metrics", JSON.stringify({ type: "metrics", host: hostId, t: newest.t, stats: live.stats, containers: {} }));
				return;
			}
			case "disk":
				link.disk = message.disk;
				return;
			case "storage":
				link.storage = message.storage;
				this.changed(hostId);
				return;
			case "firewall":
				this.onFirewall?.(hostId, message.event, message.detail);
				return;
			case "res": {
				const entry = this.pending.get(message.id);
				if (!entry || entry.hostId !== hostId || entry.ws !== ws) return;
				this.pending.delete(message.id);
				clearTimeout(entry.timer);
				if (message.ok) entry.resolve(message.result);
				else entry.reject(new Error(message.error));
				return;
			}
			case "stream": {
				const entry = this.streams.get(message.stream);
				if (entry && entry.hostId === hostId) entry.sink.data(message.data);
				return;
			}
			case "stream.end": {
				const entry = this.streams.get(message.stream);
				if (!entry || entry.hostId !== hostId) return;
				this.streams.delete(message.stream);
				entry.sink.end(message.error ?? null, message.result);
				return;
			}
		}
	}

	request<M extends Method>(hostId: number, method: M, params: Methods[M]["params"], timeoutMs = this.timeoutMs): Promise<Methods[M]["result"]> {
		const link = this.agents.get(hostId);
		if (!link) return Promise.reject(new AgentOffline());
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("The agent did not answer in time."));
			}, timeoutMs);
			this.pending.set(id, { hostId, ws: link.ws, resolve: resolve as (value: unknown) => void, reject, timer });
			this.send(link.ws, { type: "req", id, method, params });
		});
	}

	async openLogs(hostId: number, container: string, tail: number, browser: Socket): Promise<string> {
		const stream = randomToken(12);
		this.streams.set(stream, { hostId, sink: browserSink(stream, browser, (ws, m) => this.send(ws, m)) });
		try {
			await this.request(hostId, "logs.open", { stream, id: container, tail });
		} catch (err) {
			this.streams.delete(stream);
			throw err;
		}
		return stream;
	}

	/** Starts a job on a host whose output streams back, such as a backup or a restore. */
	async runJob<M extends "backup.run" | "backup.restore" | "backup.verify">(
		hostId: number,
		method: M,
		params: Omit<Methods[M]["params"], "stream">,
		sink: StreamSink,
	): Promise<void> {
		const stream = randomToken(12);
		this.streams.set(stream, { hostId, sink });
		try {
			await this.request(hostId, method, { ...params, stream } as Methods[M]["params"], 60_000);
		} catch (err) {
			this.streams.delete(stream);
			throw err;
		}
	}

	/** Starts a compose run on a host. Output and the end go to the sink, the answer says where the files are. */
	async runStack(hostId: number, params: Omit<Methods["stack.run"]["params"], "stream">, sink: StreamSink): Promise<Methods["stack.run"]["result"]> {
		const stream = randomToken(12);
		this.streams.set(stream, { hostId, sink });
		try {
			return await this.request(hostId, "stack.run", { ...params, stream });
		} catch (err) {
			this.streams.delete(stream);
			throw err;
		}
	}

	closeLogs(stream: string, browser: Socket): void {
		const entry = this.streams.get(stream);
		if (!entry || entry.sink.owner !== browser) return;
		this.streams.delete(stream);
		void this.request(entry.hostId, "logs.close", { stream }).catch(() => {});
	}

	browserClosed(browser: Socket): void {
		for (const [stream, entry] of this.streams) if (entry.sink.owner === browser) this.closeLogs(stream, browser);
	}

	/** Closes the socket of a host that was deleted or enrolled again. */
	disconnect(hostId: number, code = 4001, reason = "host removed"): void {
		this.agents.get(hostId)?.ws.close(code, reason);
	}

	onlineCount(): number {
		return this.agents.size;
	}
}
