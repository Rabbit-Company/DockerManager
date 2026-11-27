import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { BackupItem, BackupMode, BackupResult, BackupResultItem, DestinationConfig, DumpEngine, MountSummary } from "../../shared/protocol.ts";
import { bytes } from "../../shared/units.ts";
import { decryptStream, encryptStream } from "./crypto.ts";
import { openStore, type Store } from "./stores.ts";

export const MANIFEST = "manifest.json.dmbak";

const gzip = () => new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
const gunzip = () => new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
const FORMAT = 1;

/** What the runner needs from the container runtime, so tests can stand in for it. */
export interface BackupRuntime {
	projectMounts(project: string): Promise<{ id: string; name: string; service: string | null; image: string; state: string; mounts: MountSummary[] }[]>;
	volumeMountpoint(name: string, create?: boolean): Promise<string>;
	action(id: string, action: "start" | "stop"): Promise<void>;
	/** The CLI that runs `exec`, docker or podman. */
	cli(): Promise<string>;
	socket: string;
}

const SYSTEM_PATH = /^\/(proc|sys|dev|run|var\/run|boot|etc|usr|bin|sbin|lib|lib64)(\/|$)|^\/(tmp)?$|^\/tmp\/\.X11-unix|^\/var\/lib\/(docker|containers)(\/|$)/;

export function detectEngine(image: string): DumpEngine | null {
	const name = image.split("@")[0]!.split(":")[0]!.split("/").pop() ?? "";
	if (/^(postgres|postgis|timescaledb|timescaledb-ha|pgvector)$/.test(name)) return "postgres";
	if (/^(mariadb|mysql|percona-server|percona)$/.test(name)) return "mysql";
	if (/^(mongo|mongodb-community-server)$/.test(name)) return "mongo";
	return null;
}

export const DUMP_COMMANDS: Record<DumpEngine, string> = {
	postgres: 'exec pg_dumpall --clean --if-exists -U "${POSTGRES_USER:-postgres}"',
	mysql:
		'P="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"; if command -v mariadb-dump >/dev/null 2>&1; then exec mariadb-dump --all-databases --single-transaction --routines --events -uroot -p"$P"; else exec mysqldump --all-databases --single-transaction --routines --events -uroot -p"$P"; fi',
	mongo:
		'if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then exec mongodump --archive --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin; else exec mongodump --archive --quiet; fi',
};

export function fileName(item: { id: string; kind: string }): string {
	const tail = item.id.slice(item.id.indexOf(":") + 1);
	const readable = tail.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "item";
	const hash = new Bun.CryptoHasher("sha256").update(item.id).digest("hex").slice(0, 8);
	if (item.kind === "files") return "stack-files.tar.gz.dmbak";
	if (item.kind === "dump") return `dump-${readable}.gz.dmbak`;
	return `${item.kind}-${readable}-${hash}.tar.gz.dmbak`;
}

/** The volumes, folders and databases of a compose project that a backup can hold. */
export async function listItems(runtime: BackupRuntime, project: string, directory: string | null, file: string): Promise<BackupItem[]> {
	const items = new Map<string, BackupItem>();
	if (directory) items.set("files", { id: "files", kind: "files", label: `Stack files (${file} and .env)`, path: directory });
	for (const c of await runtime.projectMounts(project)) {
		const engine = detectEngine(c.image);
		if (engine)
			items.set(`dump:${c.service ?? c.name}`, {
				id: `dump:${c.service ?? c.name}`,
				kind: "dump",
				label: `${engine === "mysql" ? "MariaDB or MySQL" : engine === "mongo" ? "MongoDB" : "PostgreSQL"} dump of ${c.service ?? c.name}`,
				container: c.name,
				engine,
			});
		for (const m of c.mounts) {
			if (m.type === "volume" && m.name) {
				items.set(`volume:${m.name}`, { id: `volume:${m.name}`, kind: "volume", label: `Volume ${m.name}`, path: m.source || undefined });
			} else if (m.type === "bind" && m.source && !SYSTEM_PATH.test(normalize(m.source)) && !m.source.endsWith(".sock")) {
				const info = await stat(m.source).catch(() => null);
				if (info?.isDirectory()) items.set(`bind:${m.source}`, { id: `bind:${m.source}`, kind: "bind", label: `Folder ${m.source}`, path: m.source });
			}
		}
	}
	const order = { files: 0, volume: 1, bind: 2, dump: 3 };
	return [...items.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
}

/** Pipes a stream through gzip and encryption into the store, counting bytes and hashing what is stored. */
async function store(store: Store, key: string, source: ReadableStream<Uint8Array>, encryptionKey: string): Promise<{ bytes: number; sha256: string }> {
	const writer = await store.writer(key);
	const hash = new Bun.CryptoHasher("sha256");
	let size = 0;
	try {
		const reader = source.pipeThrough(gzip()).pipeThrough(encryptStream(encryptionKey)).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hash.update(value);
			size += value.length;
			await writer.write(value);
		}
		await writer.end();
	} catch (err) {
		await writer.abort();
		throw err;
	}
	return { bytes: size, sha256: hash.digest("hex") };
}

function spawnOutput(cmd: string[], env: Record<string, string> = {}, cwd?: string) {
	const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const stderr = new Response(proc.stderr).text();
	return { proc, stderr };
}

/** GNU tar exits with 1 when a file changed while it was read, which a live backup can expect. */
async function tarItem(dir: string, names: string[] | null) {
	return spawnOutput(["tar", "--numeric-owner", "-C", dir, "-cf", "-", ...(names ?? ["."])]);
}

export interface RunInput {
	destination: DestinationConfig;
	key: string;
	set: string;
	project: string;
	directory: string | null;
	items: BackupItem[];
	mode: BackupMode;
	host: string;
}

export async function runBackup(
	runtime: BackupRuntime,
	input: RunInput,
	say: (text: string) => void,
	open: (config: DestinationConfig) => Promise<Store> = openStore,
): Promise<BackupResult> {
	const target = await open(input.destination);
	const results: BackupResultItem[] = [];
	const stopped: string[] = [];
	try {
		const dumps = input.items.filter((i) => i.kind === "dump");
		const folders = input.items.filter((i) => i.kind !== "dump");
		for (const item of dumps) {
			if (!item.container || !item.engine) throw new Error(`${item.label} names no container.`);
			say(`Dumping ${item.label}\n`);
			const cli = await runtime.cli();
			const { proc, stderr } = spawnOutput([cli, "exec", item.container, "sh", "-c", DUMP_COMMANDS[item.engine]], {
				DOCKER_HOST: `unix://${runtime.socket}`,
				CONTAINER_HOST: `unix://${runtime.socket}`,
			});
			const file = fileName(item);
			const saved = await store(target, `${input.set}/${file}`, proc.stdout, input.key);
			const code = await proc.exited;
			if (code !== 0) throw new Error(`The dump of ${item.container} failed with exit code ${code}: ${(await stderr).trim().slice(0, 500)}`);
			results.push({ id: item.id, kind: item.kind, label: item.label, file, ...saved });
			say(`  ${bytes(saved.bytes)}\n`);
		}
		if (input.mode === "stop" && folders.length > 0) {
			for (const c of await runtime.projectMounts(input.project)) {
				if (c.state !== "running") continue;
				say(`Stopping ${c.name}\n`);
				await runtime.action(c.id, "stop");
				stopped.push(c.id);
			}
		}
		for (const item of folders) {
			const dir =
				item.kind === "volume" ? await runtime.volumeMountpoint(item.id.slice("volume:".length)) : item.kind === "files" ? input.directory : item.path;
			if (!dir || !existsSync(dir)) throw new Error(`${item.label} has no folder on this host.`);
			say(`Saving ${item.label}\n`);
			const names =
				item.kind === "files"
					? [".env", "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].filter((n) => existsSync(join(dir, n)))
					: null;
			if (names && names.length === 0) throw new Error("The stack files are missing on the host.");
			const { proc, stderr } = await tarItem(dir, names);
			const file = fileName(item);
			const saved = await store(target, `${input.set}/${file}`, proc.stdout, input.key);
			const code = await proc.exited;
			const errors = (await stderr).trim();
			if (code > 1 || (code === 1 && input.mode !== "live")) throw new Error(`tar failed with exit code ${code}: ${errors.slice(0, 500)}`);
			const warning = code === 1 ? "Some files changed while they were read." : undefined;
			results.push({ id: item.id, kind: item.kind, label: item.label, path: item.kind === "volume" ? undefined : dir, file, ...saved, warning });
			say(`  ${bytes(saved.bytes)}${warning ? `, ${warning}` : ""}\n`);
		}
	} catch (err) {
		await target.remove(input.set).catch(() => {});
		await target.close().catch(() => {});
		throw err;
	} finally {
		for (const id of stopped) {
			try {
				await runtime.action(id, "start");
			} catch (err) {
				say(`Could not start ${id.slice(0, 12)} again: ${(err as Error).message}\n`);
			}
		}
		if (stopped.length > 0) say(`Started ${stopped.length} container(s) again\n`);
	}
	const manifest = { format: FORMAT, created: new Date().toISOString(), host: input.host, project: input.project, mode: input.mode, items: results };
	try {
		await store(target, `${input.set}/${MANIFEST}`, new Blob([JSON.stringify(manifest, null, 1)]).stream(), input.key);
	} finally {
		await target.close();
	}
	const total = results.reduce((n, r) => n + r.bytes, 0);
	say(`Backup complete, ${results.length} item(s), ${bytes(total)} stored encrypted\n`);
	return { items: results, bytes: total };
}

async function readManifest(target: Store, set: string, key: string): Promise<{ items: BackupResultItem[]; project: string }> {
	const text = await new Response(target.read(`${set}/${MANIFEST}`).pipeThrough(decryptStream(key)).pipeThrough(gunzip())).text();
	const manifest = JSON.parse(text) as { format: number; items: BackupResultItem[]; project: string };
	if (manifest.format !== FORMAT) throw new Error(`This backup has format ${manifest.format}, which this agent cannot read.`);
	return manifest;
}

/** Decrypts every file and checks it against the hash taken when it was written, without restoring anything. */
export async function verifyBackup(
	input: { destination: DestinationConfig; key: string; set: string },
	say: (text: string) => void,
	open = openStore,
): Promise<void> {
	const target = await open(input.destination);
	try {
		const manifest = await readManifest(target, input.set, input.key);
		for (const item of manifest.items) {
			const hash = new Bun.CryptoHasher("sha256");
			let size = 0;
			const source = target.read(`${input.set}/${item.file}`);
			const tapped = source.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						hash.update(chunk);
						size += chunk.length;
						controller.enqueue(chunk);
					},
				}),
			);
			const reader = tapped.pipeThrough(decryptStream(input.key)).pipeThrough(gunzip()).getReader();
			for (;;) if ((await reader.read()).done) break;
			if (hash.digest("hex") !== item.sha256 || size !== item.bytes) throw new Error(`${item.label} does not match what was written.`);
			say(`${item.label}: ok\n`);
		}
		say("Every file decrypts and matches.\n");
	} finally {
		await target.close();
	}
}

/** Extracts one archive into a staging folder next to the target, then swaps the folders, so a failed restore leaves the data as it was. */
async function extractInto(stream: ReadableStream<Uint8Array>, dir: string): Promise<void> {
	const stamp = Date.now().toString(36);
	const staging = `${dir}.dm-restore-${stamp}`;
	const old = `${dir}.dm-old-${stamp}`;
	await mkdir(staging, { recursive: true });
	try {
		const proc = Bun.spawn(["tar", "--numeric-owner", "-C", staging, "-xpf", "-"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
		const stderr = new Response(proc.stderr).text();
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			proc.stdin.write(value);
			await proc.stdin.flush();
		}
		await proc.stdin.end();
		const code = await proc.exited;
		if (code !== 0) throw new Error(`tar failed with exit code ${code}: ${(await stderr).trim().slice(0, 500)}`);
		if (existsSync(dir)) await rename(dir, old);
		await rename(staging, dir);
		await rm(old, { recursive: true, force: true });
	} catch (err) {
		await rm(staging, { recursive: true, force: true });
		throw err;
	}
}

/** Puts stack files only into place, keeping other files in the stack folder. */
async function extractFiles(stream: ReadableStream<Uint8Array>, dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const proc = Bun.spawn(["tar", "--numeric-owner", "-C", dir, "-xpf", "-"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
	const stderr = new Response(proc.stderr).text();
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		proc.stdin.write(value);
		await proc.stdin.flush();
	}
	await proc.stdin.end();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`tar failed with exit code ${code}: ${(await stderr).trim().slice(0, 500)}`);
}

export async function restoreBackup(
	runtime: BackupRuntime,
	input: { destination: DestinationConfig; key: string; set: string; project: string; directory: string | null; items: string[] },
	say: (text: string) => void,
	open = openStore,
): Promise<void> {
	const target = await open(input.destination);
	const stopped: string[] = [];
	try {
		const manifest = await readManifest(target, input.set, input.key);
		const chosen = manifest.items.filter((i) => input.items.includes(i.id));
		if (chosen.length === 0) throw new Error("None of the chosen items are in this backup.");
		const dumps = chosen.filter((i) => i.kind === "dump");
		const folders = chosen.filter((i) => i.kind !== "dump");
		for (const c of await runtime.projectMounts(input.project)) {
			if (c.state !== "running" || folders.length === 0) continue;
			say(`Stopping ${c.name}\n`);
			await runtime.action(c.id, "stop");
			stopped.push(c.id);
		}
		for (const item of folders) {
			const dir =
				item.kind === "volume" ? await runtime.volumeMountpoint(item.id.slice("volume:".length), true) : item.kind === "files" ? input.directory : item.path;
			if (!dir) throw new Error(`${item.label} has no folder to go to on this host.`);
			say(`Restoring ${item.label} to ${dir}\n`);
			const stream = target.read(`${input.set}/${item.file}`).pipeThrough(decryptStream(input.key)).pipeThrough(gunzip());
			if (item.kind === "files") await extractFiles(stream, dir);
			else await extractInto(stream, dir);
		}
		for (const item of dumps)
			say(`${item.label} is kept in the backup. Load it by hand, see the README, so a restore never replaces a running database by surprise.\n`);
		say("Restore complete.\n");
	} finally {
		for (const id of stopped) {
			try {
				await runtime.action(id, "start");
			} catch (err) {
				say(`Could not start ${id.slice(0, 12)} again: ${(err as Error).message}\n`);
			}
		}
		if (stopped.length > 0) say(`Started ${stopped.length} container(s) again\n`);
		await target.close();
	}
}

export async function deleteBackup(input: { destination: DestinationConfig; set: string }, open = openStore): Promise<void> {
	const target = await open(input.destination);
	try {
		await target.remove(input.set);
	} finally {
		await target.close();
	}
}

/** Writes, reads back and deletes a small file, so a destination is known to work before the first backup. */
export async function testDestination(config: DestinationConfig, open = openStore): Promise<string> {
	const target = await open(config);
	const key = `.dockermanager-test-${Date.now().toString(36)}`;
	try {
		const writer = await target.writer(key);
		await writer.write(new TextEncoder().encode("ok"));
		await writer.end();
		const back = await new Response(target.read(key)).text();
		if (back !== "ok") throw new Error("A test file read back different from what was written.");
		await target.remove(key);
		return config.kind === "local" ? `Wrote and read a test file in ${config.path}.` : "Wrote, read and deleted a test file.";
	} finally {
		await target.close();
	}
}
