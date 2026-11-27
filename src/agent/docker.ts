import { existsSync } from "node:fs";
import type {
	ContainerAction,
	DiskUsage,
	ContainerDetail,
	ContainerSummary,
	HostFacts,
	ImageSummary,
	MountSummary,
	NetworkSummary,
	PortBinding,
	Runtime,
	RuntimeEvent,
	Snapshot,
	VolumeSummary,
} from "../shared/protocol.ts";

export interface ContainerStatus {
	name: string;
	service: string | null;
	state: string;
	health: string | null;
	exitCode: number | null;
	restarts: number;
}

export class RuntimeError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Sockets tried in order when CONTAINER_SOCKET is not set. Docker first, then rootful and rootless Podman. */
export function socketCandidates(env: Record<string, string | undefined> = process.env, uid = process.getuid?.() ?? 0): string[] {
	if (env.CONTAINER_SOCKET) return [env.CONTAINER_SOCKET.replace(/^unix:\/\//, "")];
	const list = ["/var/run/docker.sock", "/run/podman/podman.sock"];
	if (env.XDG_RUNTIME_DIR) list.push(`${env.XDG_RUNTIME_DIR}/podman/podman.sock`);
	list.push(`/run/user/${uid}/podman/podman.sock`);
	return [...new Set(list)];
}

export function findSocket(candidates = socketCandidates()): string | null {
	return candidates.find((path) => existsSync(path)) ?? null;
}

/** Splits Docker's multiplexed log stream: 8 byte headers with the stream type and a big endian length. */
export class LogDemuxer {
	private buffer = new Uint8Array(0);
	private readonly decoders = [new TextDecoder(), new TextDecoder(), new TextDecoder()];

	push(chunk: Uint8Array): { stream: "stdout" | "stderr"; text: string }[] {
		const merged = new Uint8Array(this.buffer.length + chunk.length);
		merged.set(this.buffer);
		merged.set(chunk, this.buffer.length);
		const out: { stream: "stdout" | "stderr"; text: string }[] = [];
		let offset = 0;
		while (merged.length - offset >= 8) {
			const kind = merged[offset]!;
			const size = new DataView(merged.buffer, merged.byteOffset + offset + 4, 4).getUint32(0);
			if (merged.length - offset - 8 < size) break;
			const payload = merged.subarray(offset + 8, offset + 8 + size);
			const decoder = this.decoders[kind === 2 ? 2 : 1]!;
			out.push({ stream: kind === 2 ? "stderr" : "stdout", text: decoder.decode(payload, { stream: true }) });
			offset += 8 + size;
		}
		this.buffer = merged.slice(offset);
		return out;
	}
}

/** Turns a byte stream of newline separated JSON objects into objects. */
export class JsonLines {
	private rest = "";
	private readonly decoder = new TextDecoder();

	push(chunk: Uint8Array): unknown[] {
		this.rest += this.decoder.decode(chunk, { stream: true });
		const lines = this.rest.split("\n");
		this.rest = lines.pop() ?? "";
		const out: unknown[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				out.push(JSON.parse(trimmed));
			} catch {}
		}
		return out;
	}
}

type Json = Record<string, any>;

function ports(list: unknown): PortBinding[] {
	if (!Array.isArray(list)) return [];
	return list.map((p: Json) => ({
		privatePort: Number(p.PrivatePort ?? 0),
		publicPort: p.PublicPort ? Number(p.PublicPort) : null,
		ip: typeof p.IP === "string" && p.IP.length > 0 ? p.IP : null,
		type: String(p.Type ?? "tcp"),
	}));
}

/** Inspect output keeps ports as {"80/tcp": [{HostIp, HostPort}]}. */
function inspectPorts(map: unknown): PortBinding[] {
	if (typeof map !== "object" || map === null) return [];
	const out: PortBinding[] = [];
	for (const [key, bindings] of Object.entries(map as Record<string, Json[] | null>)) {
		const [port, type] = key.split("/");
		const privatePort = Number(port);
		if (!Array.isArray(bindings) || bindings.length === 0) {
			out.push({ privatePort, publicPort: null, ip: null, type: type ?? "tcp" });
			continue;
		}
		for (const b of bindings) {
			out.push({ privatePort, publicPort: b.HostPort ? Number(b.HostPort) : null, ip: b.HostIp || null, type: type ?? "tcp" });
		}
	}
	return out;
}

function mounts(list: unknown): MountSummary[] {
	if (!Array.isArray(list)) return [];
	return list.map((m: Json) => ({
		type: String(m.Type ?? "bind"),
		name: typeof m.Name === "string" && m.Name.length > 0 ? m.Name : null,
		source: String(m.Source ?? ""),
		destination: String(m.Destination ?? ""),
		rw: m.RW !== false,
	}));
}

function labels(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
	return out;
}

export function toContainerSummary(c: Json): ContainerSummary {
	const l = labels(c.Labels);
	const names: string[] = Array.isArray(c.Names) ? c.Names : [];
	return {
		id: String(c.Id),
		name: (names[0] ?? String(c.Id).slice(0, 12)).replace(/^\//, ""),
		image: String(c.Image ?? ""),
		imageId: String(c.ImageID ?? ""),
		state: String(c.State ?? "unknown"),
		status: String(c.Status ?? ""),
		created: Number(c.Created ?? 0),
		project: l["com.docker.compose.project"] ?? l["io.podman.compose.project"] ?? null,
		service: l["com.docker.compose.service"] ?? null,
		ports: ports(c.Ports),
		mounts: mounts(c.Mounts),
		labels: l,
		networks: Object.keys(c.NetworkSettings?.Networks ?? {}),
	};
}

export function toContainerDetail(c: Json): ContainerDetail {
	const state: Json = c.State ?? {};
	const env: string[] = Array.isArray(c.Config?.Env) ? c.Config.Env : [];
	const cmd = [...(Array.isArray(c.Config?.Entrypoint) ? c.Config.Entrypoint : []), ...(Array.isArray(c.Config?.Cmd) ? c.Config.Cmd : [])];
	const zero = (value: unknown) => (typeof value === "string" && value.length > 0 && !value.startsWith("0001-01-01") ? value : null);
	return {
		id: String(c.Id),
		name: String(c.Name ?? "").replace(/^\//, ""),
		image: String(c.Config?.Image ?? c.Image ?? ""),
		state: String(state.Status ?? "unknown"),
		startedAt: zero(state.StartedAt),
		finishedAt: zero(state.FinishedAt),
		exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
		health: typeof state.Health?.Status === "string" ? state.Health.Status : null,
		restartCount: Number(c.RestartCount ?? 0),
		restartPolicy: String(c.HostConfig?.RestartPolicy?.Name || "no"),
		command: cmd.join(" "),
		envNames: env.map((e) => e.split("=")[0] ?? "").filter((name) => name.length > 0),
		ports: inspectPorts(c.NetworkSettings?.Ports ?? c.HostConfig?.PortBindings),
		mounts: mounts(c.Mounts),
		labels: labels(c.Config?.Labels),
		networks: Object.keys(c.NetworkSettings?.Networks ?? {}),
	};
}

export class RuntimeClient {
	private apiVersion = "";
	runtime: Runtime = "docker";

	constructor(readonly socket: string) {}

	private url(path: string, query?: Record<string, string | number | boolean>): string {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) params.set(k, String(v));
		const qs = params.size > 0 ? `?${params}` : "";
		return `http://localhost${this.apiVersion ? `/v${this.apiVersion}` : ""}${path}${qs}`;
	}

	async request(method: string, path: string, query?: Record<string, string | number | boolean>, signal?: AbortSignal): Promise<Response> {
		const response = await fetch(this.url(path, query), { method, unix: this.socket, signal } as RequestInit);
		if (response.status >= 400) {
			let message = `${method} ${path} failed with ${response.status}`;
			try {
				const body = (await response.json()) as Json;
				if (typeof body.message === "string") message = body.message;
			} catch {}
			throw new RuntimeError(response.status, message);
		}
		return response;
	}

	async json<T = Json>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
		return (await (await this.request("GET", path, query)).json()) as T;
	}

	/** Reads the API version once, so later calls use the version the engine speaks. */
	async connect(): Promise<{ version: Json; info: Json }> {
		const version = await this.json("/version");
		this.apiVersion = String(version.ApiVersion ?? "");
		const components: Json[] = Array.isArray(version.Components) ? version.Components : [];
		this.runtime = components.some((c) => /podman/i.test(String(c.Name))) ? "podman" : "docker";
		const info = await this.json("/info");
		return { version, info };
	}

	async facts(agentVersion: string): Promise<HostFacts> {
		const { version, info } = await this.connect();
		const security: string[] = Array.isArray(info.SecurityOptions) ? info.SecurityOptions : [];
		const rootless = security.some((s) => s.includes("rootless")) || /\/run\/user\/\d+\//.test(this.socket);
		return {
			hostname: String(info.Name ?? ""),
			os: String(info.OperatingSystem ?? version.Os ?? ""),
			kernel: String(info.KernelVersion ?? version.KernelVersion ?? ""),
			arch: String(info.Architecture ?? version.Arch ?? ""),
			cpus: Number(info.NCPU ?? 0),
			memoryBytes: Number(info.MemTotal ?? 0),
			runtime: this.runtime,
			runtimeVersion: String(version.Version ?? ""),
			apiVersion: this.apiVersion,
			rootless,
			agentVersion,
		};
	}

	async snapshot(): Promise<Snapshot> {
		const [containers, images, volumes, networks] = await Promise.all([
			this.json<Json[]>("/containers/json", { all: true }),
			this.json<Json[]>("/images/json"),
			this.json<Json>("/volumes"),
			this.json<Json[]>("/networks"),
		]);
		return {
			containers: containers.map(toContainerSummary).sort((a, b) => a.name.localeCompare(b.name)),
			images: images.map((i): ImageSummary => ({
				id: String(i.Id),
				tags: Array.isArray(i.RepoTags) ? i.RepoTags.filter((t: string) => t !== "<none>:<none>") : [],
				digests: Array.isArray(i.RepoDigests) ? i.RepoDigests : [],
				size: Number(i.Size ?? 0),
				created: Number(i.Created ?? 0),
			})),
			volumes: (Array.isArray(volumes.Volumes) ? volumes.Volumes : []).map((v: Json): VolumeSummary => ({
				name: String(v.Name),
				driver: String(v.Driver ?? "local"),
				mountpoint: String(v.Mountpoint ?? ""),
				project: labels(v.Labels)["com.docker.compose.project"] ?? null,
			})),
			networks: networks.map((n): NetworkSummary => ({ id: String(n.Id), name: String(n.Name), driver: String(n.Driver ?? ""), scope: String(n.Scope ?? "") })),
			takenAt: Date.now(),
		};
	}

	async inspect(id: string): Promise<ContainerDetail> {
		return toContainerDetail(await this.json(`/containers/${encodeURIComponent(id)}/json`));
	}

	async action(id: string, action: ContainerAction, removeVolumes = false): Promise<void> {
		const ref = encodeURIComponent(id);
		if (action === "remove") {
			await this.request("DELETE", `/containers/${ref}`, { force: true, v: removeVolumes });
			return;
		}
		const query = action === "start" ? undefined : { t: 10 };
		const response = await this.request("POST", `/containers/${ref}/${action}`, query);
		await response.body?.cancel();
	}

	async running(): Promise<{ id: string; name: string }[]> {
		const list = await this.json<Json[]>("/containers/json");
		return list.map((c) => ({ id: String(c.Id), name: String((Array.isArray(c.Names) ? c.Names[0] : null) ?? c.Id).replace(/^\//, "") }));
	}

	/** State, health and restarts of every container of a compose project, for the check after a deploy. */
	async projectStatus(project: string): Promise<ContainerStatus[]> {
		const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`] });
		const list = await this.json<Json[]>("/containers/json", { all: true, filters });
		return Promise.all(
			list.map(async (c): Promise<ContainerStatus> => {
				const detail = await this.json(`/containers/${encodeURIComponent(String(c.Id))}/json`).catch(() => null);
				const l = labels(c.Labels);
				return {
					name: String((Array.isArray(c.Names) ? c.Names[0] : c.Id) ?? c.Id).replace(/^\//, ""),
					service: l["com.docker.compose.service"] ?? null,
					state: String(detail?.State?.Status ?? c.State ?? "unknown"),
					health: typeof detail?.State?.Health?.Status === "string" ? detail.State.Health.Status : null,
					exitCode: typeof detail?.State?.ExitCode === "number" ? detail.State.ExitCode : null,
					restarts: Number(detail?.RestartCount ?? 0),
				};
			}),
		);
	}

	/** Every container of a compose project with its image and mounts, for picking what to back up. */
	async projectMounts(project: string): Promise<{ id: string; name: string; service: string | null; image: string; state: string; mounts: MountSummary[] }[]> {
		const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`] });
		const list = await this.json<Json[]>("/containers/json", { all: true, filters });
		return Promise.all(
			list.map(async (c) => {
				const detail = await this.json(`/containers/${encodeURIComponent(String(c.Id))}/json`).catch(() => null);
				const l = labels(c.Labels);
				return {
					id: String(c.Id),
					name: String((Array.isArray(c.Names) ? c.Names[0] : c.Id) ?? c.Id).replace(/^\//, ""),
					service: l["com.docker.compose.service"] ?? null,
					image: String(detail?.Config?.Image ?? c.Image ?? ""),
					state: String(detail?.State?.Status ?? c.State ?? ""),
					mounts: mounts(detail?.Mounts ?? c.Mounts),
				};
			}),
		);
	}

	/** Where a volume keeps its files. A volume that is gone is created when `create` is set, as a restore needs. */
	async volumeMountpoint(name: string, create = false): Promise<string> {
		try {
			const volume = await this.json(`/volumes/${encodeURIComponent(name)}`);
			return String(volume.Mountpoint);
		} catch (err) {
			if (!create || !(err instanceof RuntimeError) || err.status !== 404) throw err;
			const response = await fetch(this.url("/volumes/create"), {
				method: "POST",
				unix: this.socket,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ Name: name, Labels: {} }),
			} as RequestInit);
			if (!response.ok) throw new RuntimeError(response.status, `Creating volume ${name} failed.`);
			return String(((await response.json()) as Json).Mountpoint);
		}
	}

	/** Labels of one container of a compose project, which say where its files are. */
	async projectLabels(project: string): Promise<Record<string, string> | null> {
		const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`] });
		const list = await this.json<Json[]>("/containers/json", { all: true, filters });
		return list.length > 0 ? labels(list[0]!.Labels) : null;
	}

	/** What the collector needs to find a container's cgroup: its main process and whether it shares the host network. */
	async processInfo(id: string): Promise<{ pid: number; hostNetwork: boolean }> {
		const c = await this.json(`/containers/${encodeURIComponent(id)}/json`);
		return { pid: Number(c.State?.Pid ?? 0), hostNetwork: c.HostConfig?.NetworkMode === "host" };
	}

	async stats(id: string): Promise<Json> {
		return this.json(`/containers/${encodeURIComponent(id)}/stats`, { stream: false, "one-shot": true });
	}

	async diskUsage(): Promise<DiskUsage> {
		const df = await this.json("/system/df");
		const containers: Record<string, number> = {};
		for (const c of Array.isArray(df.Containers) ? df.Containers : []) containers[String(c.Id)] = Number(c.SizeRw ?? 0);
		const volumes: Record<string, number> = {};
		for (const v of Array.isArray(df.Volumes) ? df.Volumes : []) {
			const size = Number(v.UsageData?.Size ?? -1);
			if (size >= 0) volumes[String(v.Name)] = size;
		}
		const images: Json[] = Array.isArray(df.Images) ? df.Images : [];
		const shared = images.reduce((n, i) => n + Number(i.SharedSize ?? 0), 0);
		const total = Number(df.LayersSize ?? images.reduce((n, i) => n + Number(i.Size ?? 0), 0) - Math.max(0, shared));
		const unused = images.filter((i) => Number(i.Containers ?? 0) === 0).reduce((n, i) => n + Number(i.Size ?? 0) - Math.max(0, Number(i.SharedSize ?? 0)), 0);
		const cache: Json[] = Array.isArray(df.BuildCache) ? df.BuildCache : [];
		return {
			takenAt: Date.now(),
			images: total,
			imagesReclaimable: Math.max(0, unused),
			containers,
			volumes,
			buildCache: cache.reduce((n, b) => n + Number(b.Size ?? 0), 0),
		};
	}

	/** Follows a container's log. Calls onText for every chunk until the signal aborts or the container stops. */
	async followLogs(id: string, tail: number, signal: AbortSignal, onText: (text: string) => void): Promise<void> {
		const ref = encodeURIComponent(id);
		const detail = await this.json(`/containers/${ref}/json`);
		const tty = detail.Config?.Tty === true;
		const response = await this.request("GET", `/containers/${ref}/logs`, { follow: true, stdout: true, stderr: true, tail, timestamps: true }, signal);
		if (!response.body) return;
		const demux = new LogDemuxer();
		const decoder = new TextDecoder();
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				if (tty) onText(decoder.decode(chunk, { stream: true }));
				else for (const part of demux.push(chunk)) onText(part.text);
			}
		} catch (err) {
			if (!signal.aborted) throw err;
		}
	}

	/** Streams container, image, volume and network events until the signal aborts. */
	async events(signal: AbortSignal, onEvent: (event: RuntimeEvent) => void): Promise<void> {
		const filters = JSON.stringify({ type: ["container", "image", "volume", "network"] });
		const response = await this.request("GET", "/events", { filters }, signal);
		if (!response.body) return;
		const lines = new JsonLines();
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				for (const raw of lines.push(chunk) as Json[]) {
					onEvent({
						type: String(raw.Type ?? raw.type ?? ""),
						action: String(raw.Action ?? raw.status ?? ""),
						id: String(raw.Actor?.ID ?? raw.id ?? ""),
						name: typeof raw.Actor?.Attributes?.name === "string" ? raw.Actor.Attributes.name : null,
						time: Number(raw.time ?? Math.floor(Date.now() / 1000)),
					});
				}
			}
		} catch (err) {
			if (!signal.aborted) throw err;
		}
	}
}
