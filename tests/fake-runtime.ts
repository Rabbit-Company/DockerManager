import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeContainer {
	Id: string;
	Names: string[];
	Image: string;
	ImageID: string;
	State: string;
	Status: string;
	Created: number;
	Labels: Record<string, string>;
	Ports: { PrivatePort: number; PublicPort?: number; IP?: string; Type: string }[];
	Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[];
	NetworkSettings: { Networks: Record<string, unknown> };
}

export function frame(stream: 1 | 2, text: string): Uint8Array {
	const payload = new TextEncoder().encode(text);
	const out = new Uint8Array(8 + payload.length);
	out[0] = stream;
	new DataView(out.buffer).setUint32(4, payload.length);
	out.set(payload, 8);
	return out;
}

export function sampleContainers(): FakeContainer[] {
	const id = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
	return [
		{
			Id: id(1),
			Names: ["/shop-web-1"],
			Image: "nginx:1.27.0",
			ImageID: "sha256:" + "a".repeat(64),
			State: "running",
			Status: "Up 3 hours",
			Created: 1_760_000_000,
			Labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": "web" },
			Ports: [
				{ PrivatePort: 80, PublicPort: 8080, IP: "0.0.0.0", Type: "tcp" },
				{ PrivatePort: 80, PublicPort: 8080, IP: "::", Type: "tcp" },
			],
			Mounts: [{ Type: "volume", Name: "shop_data", Source: "/var/lib/docker/volumes/shop_data/_data", Destination: "/data", RW: true }],
			NetworkSettings: { Networks: { shop_default: {} } },
		},
		{
			Id: id(2),
			Names: ["/shop-db-1"],
			Image: "postgres:17.2",
			ImageID: "sha256:" + "b".repeat(64),
			State: "running",
			Status: "Up 3 hours",
			Created: 1_760_000_000,
			Labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": "db" },
			Ports: [{ PrivatePort: 5432, PublicPort: 5432, IP: "127.0.0.1", Type: "tcp" }],
			Mounts: [],
			NetworkSettings: { Networks: { shop_default: {} } },
		},
		{
			Id: id(3),
			Names: ["/backup-job"],
			Image: "alpine:3.20",
			ImageID: "sha256:" + "c".repeat(64),
			State: "exited",
			Status: "Exited (0) 2 days ago",
			Created: 1_759_000_000,
			Labels: {},
			Ports: [],
			Mounts: [],
			NetworkSettings: { Networks: { bridge: {} } },
		},
	];
}

/** A small Docker Engine API on a unix socket, enough for the agent. */
export class FakeRuntime {
	readonly dir = mkdtempSync(join(tmpdir(), "dm-fake-"));
	readonly socket = join(this.dir, "docker.sock");
	containers = sampleContainers();
	podman = false;
	/** Folders of volumes by name, for backups. */
	volumePaths = new Map<string, string>();
	/** Process ids by container id, for the collector. Containers left out report pid 0. */
	pids = new Map<string, number>();
	requests: string[] = [];
	private events = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private server: ReturnType<typeof Bun.serve>;

	constructor() {
		this.server = Bun.serve({ unix: this.socket, fetch: (req) => this.handle(req) });
	}

	stop(): void {
		for (const c of this.events) {
			try {
				c.close();
			} catch {}
		}
		this.server.stop(true);
		rmSync(this.dir, { recursive: true, force: true });
	}

	private emit(action: string, container: FakeContainer): void {
		const line = new TextEncoder().encode(
			JSON.stringify({ Type: "container", Action: action, Actor: { ID: container.Id, Attributes: { name: container.Names[0]!.slice(1) } }, time: 1 }) + "\n",
		);
		for (const c of this.events) {
			try {
				c.enqueue(line);
			} catch {}
		}
	}

	private find(ref: string): FakeContainer | undefined {
		return this.containers.find((c) => c.Id === ref || c.Id.startsWith(ref) || c.Names[0] === `/${ref}`);
	}

	private handle(req: Request): Response {
		const url = new URL(req.url);
		const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
		this.requests.push(`${req.method} ${path}${url.search}`);
		if (path === "/version") {
			return Response.json({
				Version: this.podman ? "5.3.1" : "27.4.0",
				ApiVersion: "1.45",
				Os: "linux",
				Arch: "amd64",
				KernelVersion: "6.12.0",
				Components: [{ Name: this.podman ? "Podman Engine" : "Engine", Version: "x" }],
			});
		}
		if (path === "/info") {
			return Response.json({
				Name: "fake-host",
				OperatingSystem: "Debian GNU/Linux 13",
				KernelVersion: "6.12.0",
				Architecture: "x86_64",
				NCPU: 8,
				MemTotal: 16 * 1024 ** 3,
				SecurityOptions: ["name=seccomp"],
			});
		}
		if (path === "/containers/json") {
			const all = url.searchParams.get("all") === "true";
			const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[] };
			const matches = (c: FakeContainer) =>
				(filters.label ?? []).every((f) => {
					const [k, v] = f.split("=");
					return c.Labels[k!] === v;
				});
			return Response.json((all ? this.containers : this.containers.filter((c) => c.State === "running")).filter(matches));
		}
		if (path === "/system/df") {
			return Response.json({
				LayersSize: 195_000_000,
				Images: [
					{ Id: "a", Size: 190_000_000, SharedSize: 0, Containers: 1 },
					{ Id: "d", Size: 5_000_000, SharedSize: 0, Containers: 0 },
				],
				Containers: this.containers.map((c, i) => ({ Id: c.Id, SizeRw: (i + 1) * 1000 })),
				Volumes: [{ Name: "shop_data", UsageData: { Size: 42_000_000, RefCount: 1 } }],
				BuildCache: [{ Size: 1000 }],
			});
		}
		if (path === "/images/json") {
			return Response.json([
				{ Id: "sha256:" + "a".repeat(64), RepoTags: ["nginx:1.27.0"], RepoDigests: [], Size: 190_000_000, Created: 1_750_000_000 },
				{ Id: "sha256:" + "d".repeat(64), RepoTags: ["<none>:<none>"], RepoDigests: [], Size: 5_000_000, Created: 1_740_000_000 },
			]);
		}
		const volume = /^\/volumes\/([^/]+)$/.exec(path);
		if (volume && req.method === "GET") {
			const mountpoint = this.volumePaths.get(decodeURIComponent(volume[1]!));
			return mountpoint ? Response.json({ Name: volume[1], Mountpoint: mountpoint }) : Response.json({ message: "no such volume" }, { status: 404 });
		}
		if (path === "/volumes")
			return Response.json({ Volumes: [{ Name: "shop_data", Driver: "local", Mountpoint: "/x", Labels: { "com.docker.compose.project": "shop" } }] });
		if (path === "/networks") return Response.json([{ Id: "n".repeat(64), Name: "shop_default", Driver: "bridge", Scope: "local" }]);
		if (path === "/events") {
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					this.events.add(controller);
				},
				cancel: () => {},
			});
			return new Response(stream);
		}
		const match = /^\/containers\/([^/]+)(?:\/(json|start|stop|restart|logs|stats))?$/.exec(path);
		if (!match) return Response.json({ message: "page not found" }, { status: 404 });
		const container = this.find(decodeURIComponent(match[1]!));
		if (!container) return Response.json({ message: `No such container: ${match[1]}` }, { status: 404 });
		const action = match[2];
		if (req.method === "DELETE" && !action) {
			this.containers = this.containers.filter((c) => c !== container);
			this.emit("destroy", container);
			return new Response(null, { status: 204 });
		}
		if (action === "json") {
			return Response.json({
				Id: container.Id,
				Name: container.Names[0],
				RestartCount: 2,
				Config: {
					Image: container.Image,
					Env: ["PATH=/usr/bin", "SECRET_KEY=hunter2"],
					Cmd: ["nginx", "-g", "daemon off;"],
					Labels: container.Labels,
					Tty: false,
				},
				State: {
					Status: container.State,
					Pid: this.pids.get(container.Id) ?? 0,
					StartedAt: "2026-11-27T08:00:00Z",
					FinishedAt: "0001-01-01T00:00:00Z",
					ExitCode: 0,
				},
				HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "bridge" },
				NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }], "443/tcp": null }, Networks: container.NetworkSettings.Networks },
				Mounts: container.Mounts,
			});
		}
		if (action === "start" || action === "stop" || action === "restart") {
			container.State = action === "stop" ? "exited" : "running";
			container.Status = action === "stop" ? "Exited (0) 1 second ago" : "Up 1 second";
			this.emit(action === "stop" ? "die" : "start", container);
			return new Response(null, { status: 204 });
		}
		if (action === "stats") {
			return Response.json({
				cpu_stats: { cpu_usage: { total_usage: 1_000_000_000 } },
				memory_stats: { usage: 64_000_000, limit: 512_000_000, stats: { inactive_file: 0 } },
				networks: { eth0: { rx_bytes: 100, tx_bytes: 200 } },
				blkio_stats: { io_service_bytes_recursive: [] },
				pids_stats: { current: 2 },
			});
		}
		if (action === "logs") {
			const tail = url.searchParams.get("tail");
			const time = ["1", "true"].includes(url.searchParams.get("timestamps") ?? "") ? "2026-11-16T13:43:20.534123456Z " : "";
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(frame(1, `${time}hello from ${container.Names[0]} tail=${tail}\n`));
					controller.enqueue(frame(2, `${time}a warning on stderr\n`));
					controller.close();
				},
			});
			return new Response(stream);
		}
		return Response.json({ message: "not implemented" }, { status: 501 });
	}
}
