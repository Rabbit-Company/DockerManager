export const PROTOCOL_VERSION = 1;

export type Runtime = "docker" | "podman";

export interface HostFacts {
	hostname: string;
	os: string;
	kernel: string;
	arch: string;
	cpus: number;
	memoryBytes: number;
	runtime: Runtime;
	runtimeVersion: string;
	apiVersion: string;
	rootless: boolean;
	agentVersion: string;
}

export interface PortBinding {
	privatePort: number;
	publicPort: number | null;
	ip: string | null;
	type: string;
}

export interface MountSummary {
	type: string;
	name: string | null;
	source: string;
	destination: string;
	rw: boolean;
}

export interface ContainerSummary {
	id: string;
	name: string;
	image: string;
	imageId: string;
	state: string;
	status: string;
	created: number;
	project: string | null;
	service: string | null;
	ports: PortBinding[];
	mounts: MountSummary[];
	labels: Record<string, string>;
	networks: string[];
}

export interface ImageSummary {
	id: string;
	tags: string[];
	digests: string[];
	size: number;
	created: number;
}

export interface VolumeSummary {
	name: string;
	driver: string;
	mountpoint: string;
	project: string | null;
}

export interface NetworkSummary {
	id: string;
	name: string;
	driver: string;
	scope: string;
}

export interface Snapshot {
	containers: ContainerSummary[];
	images: ImageSummary[];
	volumes: VolumeSummary[];
	networks: NetworkSummary[];
	takenAt: number;
}

export interface ContainerDetail {
	id: string;
	name: string;
	image: string;
	state: string;
	startedAt: string | null;
	finishedAt: string | null;
	exitCode: number | null;
	health: string | null;
	restartCount: number;
	restartPolicy: string;
	command: string;
	envNames: string[];
	ports: PortBinding[];
	mounts: MountSummary[];
	labels: Record<string, string>;
	networks: string[];
}

export interface RuntimeEvent {
	type: string;
	action: string;
	id: string;
	name: string | null;
	time: number;
}

export type ContainerAction = "start" | "stop" | "restart" | "remove";
export const CONTAINER_ACTIONS: readonly ContainerAction[] = ["start", "stop", "restart", "remove"];

export interface StackFilesParams {
	name: string;
	directory: string | null;
	file: string;
	compose: string;
	env: string;
}

export interface FirewallBackend {
	/** The nft tool is installed. */
	nft: boolean;
	version: string | null;
	/** The agent may change the firewall (it runs as root). */
	permitted: boolean;
	/** Tables of other programs, such as "ip filter" or "inet firewalld". */
	tables: string[];
}

export interface FirewallState {
	managed: boolean;
	pendingUntil: number | null;
	pendingToken: string | null;
	appliedAt: number | null;
	lastError: string | null;
	policy: import("./firewall.ts").FirewallPolicy | null;
}

export interface Listener {
	protocol: "tcp" | "udp";
	address: string;
	port: number;
	pid: number | null;
	process: string | null;
}

export type DestinationConfig =
	| { kind: "local"; path: string }
	| { kind: "s3"; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; prefix?: string }
	| { kind: "smb"; share: string; username: string; password: string; domain?: string; version?: string; path?: string }
	| { kind: "nfs"; export: string; options?: string; path?: string };

export type BackupItemKind = "volume" | "bind" | "files" | "dump";
export type DumpEngine = "postgres" | "mysql" | "mongo";

/** Something a backup can hold. Ids are stable, so a plan can remember which items it includes. */
export interface BackupItem {
	id: string;
	kind: BackupItemKind;
	label: string;
	/** Folder on the host for volumes, bind mounts and the stack files. */
	path?: string;
	/** Container to run the dump in. */
	container?: string;
	engine?: DumpEngine;
}

export type BackupMode = "stop" | "live";

export interface BackupResultItem {
	id: string;
	kind: BackupItemKind;
	label: string;
	path?: string;
	file: string;
	bytes: number;
	sha256: string;
	warning?: string;
}

export interface BackupResult {
	items: BackupResultItem[];
	bytes: number;
}

export interface BackupTarget {
	destination: DestinationConfig;
	key: string;
	/** Folder of this backup inside the destination. */
	set: string;
}

/** Commands the controller may ask an agent to run, with their parameters and results. */
export interface Methods {
	"container.action": { params: { id: string; action: ContainerAction; removeVolumes?: boolean }; result: { ok: true } };
	"container.inspect": { params: { id: string }; result: ContainerDetail };
	"logs.open": { params: { stream: string; id: string; tail: number }; result: { ok: true } };
	"logs.close": { params: { stream: string }; result: { ok: true } };
	"snapshot.refresh": { params: Record<string, never>; result: { ok: true } };
	"stack.validate": { params: StackFilesParams; result: { ok: boolean; output: string } };
	"stack.read": { params: { project: string }; result: { directory: string; file: string; compose: string; env: string } };
	"stack.remove": { params: { name: string; directory: string | null }; result: { removed: boolean } };
	"backup.items": { params: { project: string; directory: string | null; file: string }; result: BackupItem[] };
	"backup.volume.check": { params: { names: string[] }; result: { existing: string[] } };
	"backup.run": {
		params: BackupTarget & { stream: string; project: string; directory: string | null; items: BackupItem[]; mode: BackupMode };
		result: { ok: true };
	};
	"backup.restore": { params: BackupTarget & { stream: string; project: string; directory: string | null; items: string[] }; result: { ok: true } };
	"backup.verify": { params: BackupTarget & { stream: string }; result: { ok: true } };
	"backup.delete": { params: Omit<BackupTarget, "key">; result: { ok: true } };
	"backup.test": { params: { destination: DestinationConfig }; result: { ok: true; note: string } };
	"firewall.inspect": {
		params: Record<string, never>;
		result: { backend: FirewallBackend; state: FirewallState; listeners: Listener[]; hits: Record<string, number> };
	};
	"firewall.apply": { params: { policy: import("./firewall.ts").FirewallPolicy; confirmSeconds: number }; result: { token: string; pendingUntil: number } };
	"firewall.confirm": { params: { token: string }; result: { confirmed: boolean } };
	"firewall.disable": { params: Record<string, never>; result: { ok: true } };
	"firewall.revert": { params: { token: string }; result: { reverted: boolean } };
	"stack.run": {
		params: StackFilesParams & {
			stream: string;
			action: "deploy" | "upgrade" | "prepare" | "start" | "stop" | "restart" | "down" | "pull";
			healthTimeout?: number;
		};
		result: { directory: string };
	};
}

export type Method = keyof Methods;

/** Rates are per second over the sample interval. CPU is in cores, so 1.5 means one and a half cores busy. */
export interface ContainerMetrics {
	id: string;
	name: string;
	cpu: number | null;
	mem: number;
	memLimit: number;
	netRx: number | null;
	netTx: number | null;
	blkRead: number | null;
	blkWrite: number | null;
	pids: number | null;
}

export interface Filesystem {
	mount: string;
	fstype: string;
	size: number;
	used: number;
	avail: number;
}

export interface HostMetrics {
	cpu: number | null;
	cpus: number;
	mem: number;
	memTotal: number;
	load1: number;
	netRx: number | null;
	netTx: number | null;
	blkRead: number | null;
	blkWrite: number | null;
	filesystems: Filesystem[];
}

export interface MetricsSample {
	/** Unix time in seconds. */
	t: number;
	interval: number;
	host: HostMetrics | null;
	containers: ContainerMetrics[];
}

/** Sizes from the engine's disk usage report, read about once an hour because it can be slow. */
export interface DiskUsage {
	takenAt: number;
	images: number;
	imagesReclaimable: number;
	containers: Record<string, number>;
	volumes: Record<string, number>;
	buildCache: number;
}

export interface NvmeDrive {
	device: string;
	model: string | null;
	serial: string | null;
	capacityBytes: number | null;
	passed: boolean | null;
	criticalWarning: number | null;
	temperatureC: number | null;
	sparePercent: number | null;
	spareThresholdPercent: number | null;
	usedPercent: number | null;
	mediaErrors: number | null;
	errorLogEntries: number | null;
	powerOnHours: number | null;
	dataWrittenBytes: number | null;
	error: string | null;
}

export interface MdArray {
	device: string;
	level: string;
	state: string;
	raidDisks: number | null;
	degraded: number | null;
	syncAction: string;
	members: string[];
}

export interface StorageReport {
	takenAt: number;
	smartctl: "ok" | "missing" | "error";
	drives: NvmeDrive[];
	arrays: MdArray[];
}

export type AgentMessage =
	| { type: "hello"; protocol: number; facts: HostFacts }
	| { type: "snapshot"; snapshot: Snapshot }
	| { type: "event"; event: RuntimeEvent }
	| { type: "res"; id: number; ok: true; result: unknown }
	| { type: "res"; id: number; ok: false; error: string }
	| { type: "stream"; stream: string; data: string }
	| { type: "stream.end"; stream: string; error?: string; result?: unknown }
	| { type: "metrics"; samples: MetricsSample[] }
	| { type: "disk"; disk: DiskUsage }
	| { type: "storage"; storage: StorageReport }
	| { type: "firewall"; event: "reverted" | "restored" | "error"; detail: string }
	| { type: "ping" };

export type ControllerMessage = { type: "req"; id: number; method: Method; params: unknown } | { type: "pong" } | { type: "welcome"; hostId: number };

const AGENT_TYPES = new Set(["hello", "snapshot", "event", "res", "stream", "stream.end", "metrics", "disk", "storage", "firewall", "ping"]);
const CONTROLLER_TYPES = new Set(["req", "pong", "welcome"]);

function parse(raw: string | Buffer, types: Set<string>): Record<string, unknown> | null {
	let value: unknown;
	try {
		value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const type = (value as Record<string, unknown>).type;
	if (typeof type !== "string" || !types.has(type)) return null;
	return value as Record<string, unknown>;
}

/** Checks the shape of the envelope. Payload fields are trusted only as far as the agent itself is trusted. */
export function parseAgentMessage(raw: string | Buffer): AgentMessage | null {
	const message = parse(raw, AGENT_TYPES);
	if (message === null) return null;
	switch (message.type) {
		case "hello":
			if (typeof message.protocol !== "number" || typeof message.facts !== "object" || message.facts === null) return null;
			break;
		case "snapshot":
			if (typeof message.snapshot !== "object" || message.snapshot === null) return null;
			if (!Array.isArray((message.snapshot as Snapshot).containers)) return null;
			break;
		case "event":
			if (typeof message.event !== "object" || message.event === null) return null;
			break;
		case "res":
			if (typeof message.id !== "number" || typeof message.ok !== "boolean") return null;
			if (message.ok === false && typeof message.error !== "string") return null;
			break;
		case "stream":
			if (typeof message.stream !== "string" || typeof message.data !== "string") return null;
			break;
		case "stream.end":
			if (typeof message.stream !== "string") return null;
			break;
		case "metrics":
			if (!Array.isArray(message.samples) || message.samples.length > 2000) return null;
			if (!message.samples.every((s) => typeof s === "object" && s !== null && typeof s.t === "number" && Array.isArray(s.containers))) return null;
			break;
		case "disk":
			if (typeof message.disk !== "object" || message.disk === null) return null;
			break;
		case "storage":
			if (typeof message.storage !== "object" || message.storage === null) return null;
			if (!Array.isArray((message.storage as StorageReport).drives) || !Array.isArray((message.storage as StorageReport).arrays)) return null;
			break;
	}
	return message as unknown as AgentMessage;
}

export function parseControllerMessage(raw: string | Buffer): ControllerMessage | null {
	const message = parse(raw, CONTROLLER_TYPES);
	if (message === null) return null;
	if (message.type === "req" && (typeof message.id !== "number" || typeof message.method !== "string")) return null;
	if (message.type === "welcome" && typeof message.hostId !== "number") return null;
	return message as unknown as ControllerMessage;
}

/** Messages a signed in browser sends over /ws. */
export type BrowserMessage =
	| { type: "auth"; csrf: string }
	| { type: "watch"; topics: string[] }
	| { type: "logs.open"; host: number; container: string; tail: number }
	| { type: "logs.close"; stream: string };

export function parseBrowserMessage(raw: string | Buffer): BrowserMessage | null {
	const message = parse(raw, new Set(["auth", "watch", "logs.open", "logs.close"]));
	if (message === null) return null;
	if (message.type === "auth") {
		if (typeof message.csrf !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(message.csrf)) return null;
	} else if (message.type === "watch") {
		if (!Array.isArray(message.topics) || message.topics.length > 50 || !message.topics.every((t) => typeof t === "string" && t.length <= 100)) return null;
	} else if (message.type === "logs.open") {
		if (typeof message.host !== "number" || typeof message.container !== "string" || typeof message.tail !== "number") return null;
	} else if (typeof message.stream !== "string") return null;
	return message as unknown as BrowserMessage;
}
