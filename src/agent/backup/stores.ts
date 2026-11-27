import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";
import type { DestinationConfig } from "../../shared/protocol.ts";

export interface StoreWriter {
	write(chunk: Uint8Array): Promise<void>;
	end(): Promise<void>;
	abort(): Promise<void>;
}

/** Where backup files go. Keys are relative paths like "dockermanager/host/stack/20261127-030000/files.tar.gz.dmbak". */
export interface Store {
	writer(key: string): Promise<StoreWriter>;
	read(key: string): ReadableStream<Uint8Array>;
	list(prefix: string): Promise<{ key: string; size: number }[]>;
	remove(prefix: string): Promise<void>;
	close(): Promise<void>;
}

/** Keys are built by the controller from plain names, this keeps them inside the store. */
export function safeKey(key: string): string {
	const clean = normalize(key).replace(/^\/+/, "");
	if (clean.startsWith("..") || clean.includes("/../") || clean === "." || clean.includes("\0")) throw new Error("Bad backup path.");
	return clean;
}

export class FileStore implements Store {
	constructor(readonly root: string) {}

	private path(key: string): string {
		return join(this.root, safeKey(key));
	}

	async writer(key: string): Promise<StoreWriter> {
		const target = this.path(key);
		const temp = `${target}.partial`;
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		const sink = Bun.file(temp).writer();
		return {
			write: async (chunk) => {
				await sink.write(chunk);
			},
			end: async () => {
				await sink.end();
				await rename(temp, target);
			},
			abort: async () => {
				try {
					await sink.end();
				} catch {}
				await rm(temp, { force: true });
			},
		};
	}

	read(key: string): ReadableStream<Uint8Array> {
		return Bun.file(this.path(key)).stream();
	}

	async list(prefix: string): Promise<{ key: string; size: number }[]> {
		const base = this.path(prefix);
		const out: { key: string; size: number }[] = [];
		const walk = async (dir: string) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const full = join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else if (e.isFile() && !e.name.endsWith(".partial")) out.push({ key: relative(this.root, full), size: (await stat(full)).size });
			}
		};
		await walk(base);
		return out.sort((a, b) => a.key.localeCompare(b.key));
	}

	async remove(prefix: string): Promise<void> {
		const target = this.path(prefix);
		if (normalize(target) === normalize(this.root)) throw new Error("Refusing to delete the whole backup folder.");
		await rm(target, { recursive: true, force: true });
	}

	async close(): Promise<void> {}
}

export class S3Store implements Store {
	private readonly client: Bun.S3Client;

	constructor(
		private readonly config: Extract<DestinationConfig, { kind: "s3" }>,
		client?: Bun.S3Client,
	) {
		this.client =
			client ??
			new Bun.S3Client({
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
				bucket: config.bucket,
				endpoint: config.endpoint || undefined,
				region: config.region || undefined,
			});
	}

	private key(key: string): string {
		const prefix = (this.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
		return prefix ? `${prefix}/${safeKey(key)}` : safeKey(key);
	}

	async writer(key: string): Promise<StoreWriter> {
		const sink = this.client.file(this.key(key)).writer({ partSize: 16 * 1024 * 1024, queueSize: 4, retry: 3 });
		return {
			write: async (chunk) => {
				await sink.write(chunk);
			},
			end: async () => {
				await sink.end();
			},
			abort: async () => {
				try {
					await sink.end(new Error("aborted"));
				} catch {}
			},
		};
	}

	read(key: string): ReadableStream<Uint8Array> {
		return this.client.file(this.key(key)).stream();
	}

	async list(prefix: string): Promise<{ key: string; size: number }[]> {
		const full = this.key(prefix);
		const strip = full.length - safeKey(prefix).length;
		const out: { key: string; size: number }[] = [];
		let continuationToken: string | undefined;
		for (let page = 0; page < 100; page++) {
			const result = await this.client.list({ prefix: full, continuationToken });
			for (const o of result.contents ?? []) out.push({ key: o.key.slice(strip), size: o.size ?? 0 });
			if (!result.isTruncated || !result.nextContinuationToken) break;
			continuationToken = result.nextContinuationToken;
		}
		return out;
	}

	async remove(prefix: string): Promise<void> {
		for (const o of await this.list(prefix)) await this.client.delete(this.key(o.key));
	}

	async close(): Promise<void> {}
}

type Run = (cmd: string[]) => Promise<{ code: number; output: string }>;

async function run(cmd: string[]): Promise<{ code: number; output: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, output: `${out}${err}`.trim() };
}

/** The mount command for a share. SMB credentials go in a file so they never show up in the process list. */
export function mountCommand(config: Extract<DestinationConfig, { kind: "smb" | "nfs" }>, target: string, credentialsFile: string | null): string[] {
	if (config.kind === "nfs") {
		if (!/^[\w.-]+:\/[^\s,]*$/.test(config.export)) throw new Error("An NFS export looks like server:/path.");
		const options = config.options?.trim() || "rw,nfsvers=4";
		if (!/^[\w=.,:-]+$/.test(options)) throw new Error("The NFS options have characters that are not allowed.");
		return ["mount", "-t", "nfs", "-o", options, config.export, target];
	}
	if (!/^\/\/[\w.-]+\/[^\s,]+$/.test(config.share)) throw new Error("An SMB share looks like //server/share.");
	const version = /^[\d.]+$/.test(config.version ?? "") ? config.version : "3.0";
	return ["mount", "-t", "cifs", "-o", `credentials=${credentialsFile},vers=${version},uid=0,gid=0,file_mode=0600,dir_mode=0700`, config.share, target];
}

export class MountedStore implements Store {
	private inner: FileStore | null = null;
	private mountpoint: string | null = null;

	constructor(
		private readonly config: Extract<DestinationConfig, { kind: "smb" | "nfs" }>,
		private readonly exec: Run = run,
	) {}

	async open(): Promise<this> {
		if (process.getuid?.() !== 0 && this.exec === run) throw new Error("Mounting SMB and NFS shares needs the agent to run as root.");
		const dir = await mkdtemp(join(tmpdir(), "dm-mount-"));
		let credentials: string | null = null;
		try {
			if (this.config.kind === "smb") {
				credentials = join(dir, "credentials");
				const lines = [`username=${this.config.username}`, `password=${this.config.password}`];
				if (this.config.domain) lines.push(`domain=${this.config.domain}`);
				await writeFile(credentials, lines.join("\n") + "\n", { mode: 0o600 });
			}
			const target = join(dir, "share");
			await mkdir(target, { mode: 0o700 });
			const result = await this.exec(mountCommand(this.config, target, credentials));
			if (result.code !== 0) throw new Error(`Mounting the share failed: ${result.output || `exit code ${result.code}`}`);
			this.mountpoint = target;
			const sub = (this.config.path ?? "").replace(/^\/+/, "");
			this.inner = new FileStore(sub ? join(target, safeKey(sub)) : target);
			return this;
		} finally {
			if (credentials) await rm(credentials, { force: true });
			if (!this.mountpoint) await rm(dir, { recursive: true, force: true });
		}
	}

	private store(): FileStore {
		if (!this.inner) throw new Error("The share is not mounted.");
		return this.inner;
	}

	writer(key: string) {
		return this.store().writer(key);
	}

	read(key: string) {
		return this.store().read(key);
	}

	list(prefix: string) {
		return this.store().list(prefix);
	}

	remove(prefix: string) {
		return this.store().remove(prefix);
	}

	async close(): Promise<void> {
		if (!this.mountpoint) return;
		const point = this.mountpoint;
		this.mountpoint = null;
		this.inner = null;
		const result = await this.exec(["umount", point]);
		if (result.code === 0) await rm(dirname(point), { recursive: true, force: true });
	}
}

export async function openStore(config: DestinationConfig): Promise<Store> {
	switch (config.kind) {
		case "local":
			if (!config.path.startsWith("/")) throw new Error("A backup folder must be an absolute path.");
			await mkdir(config.path, { recursive: true, mode: 0o700 });
			return new FileStore(config.path);
		case "s3":
			return new S3Store(config);
		case "smb":
		case "nfs":
			return new MountedStore(config).open();
	}
}
