import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptStream, encryptStream, generateKey } from "../src/agent/backup/crypto.ts";
import {
	deleteBackup,
	detectEngine,
	fileName,
	listItems,
	restoreBackup,
	runBackup,
	testDestination,
	verifyBackup,
	type BackupRuntime,
} from "../src/agent/backup/runner.ts";
import { FileStore, mountCommand, MountedStore, S3Store, safeKey } from "../src/agent/backup/stores.ts";
import type { BackupItem, DestinationConfig } from "../src/shared/protocol.ts";
import { FakeS3 } from "./fake-s3.ts";

const root = mkdtempSync(join(tmpdir(), "dm-backup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bytes = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

describe("encryption", () => {
	test("round trips across chunk borders and refuses changes", async () => {
		const key = generateKey();
		const data = crypto.getRandomValues(new Uint8Array(2 * 1024 * 1024 + 77));
		const sealed = await bytes(new Blob([data]).stream().pipeThrough(encryptStream(key)));
		expect(Buffer.from(sealed.subarray(0, 8)).toString()).toBe("DMBAK001");
		expect(await bytes(new Blob([sealed]).stream().pipeThrough(decryptStream(key)))).toEqual(data);
		const cut = sealed.slice(0, sealed.length - 10);
		await expect(bytes(new Blob([cut]).stream().pipeThrough(decryptStream(key)))).rejects.toThrow("ends early");
		const flipped = sealed.slice();
		flipped[100]! ^= 1;
		await expect(bytes(new Blob([flipped]).stream().pipeThrough(decryptStream(key)))).rejects.toThrow("changed or the key is wrong");
		await expect(bytes(new Blob([sealed]).stream().pipeThrough(decryptStream(generateKey())))).rejects.toThrow("key is wrong");
		await expect(bytes(new Blob([new TextEncoder().encode("hello world, not a backup")]).stream().pipeThrough(decryptStream(key)))).rejects.toThrow(
			"not a backup file",
		);
	});
});

test("helpers", () => {
	expect(detectEngine("postgres:17.2-alpine")).toBe("postgres");
	expect(detectEngine("docker.io/library/mariadb:11.4")).toBe("mysql");
	expect(detectEngine("ghcr.io/x/postgres-exporter:1")).toBeNull();
	expect(fileName({ id: "volume:shop_data", kind: "volume" })).toMatch(/^volume-shop_data-[0-9a-f]{8}\.tar\.gz\.dmbak$/);
	expect(fileName({ id: "files", kind: "files" })).toBe("stack-files.tar.gz.dmbak");
	expect(() => safeKey("../etc/passwd")).toThrow();
	expect(safeKey("/a/b/../c")).toBe("a/c");
	const tmp = "/tmp/x";
	expect(mountCommand({ kind: "nfs", export: "nas:/backups" }, tmp, null)).toEqual(["mount", "-t", "nfs", "-o", "rw,nfsvers=4", "nas:/backups", tmp]);
	expect(mountCommand({ kind: "smb", share: "//nas/backup", username: "u", password: "p" }, tmp, "/c")).toEqual([
		"mount",
		"-t",
		"cifs",
		"-o",
		"credentials=/c,vers=3.0,uid=0,gid=0,file_mode=0600,dir_mode=0700",
		"//nas/backup",
		tmp,
	]);
	expect(() => mountCommand({ kind: "nfs", export: "nas:/x", options: "rw;rm -rf /" }, tmp, null)).toThrow("not allowed");
	expect(() => mountCommand({ kind: "smb", share: "nas/backup", username: "u", password: "p" }, tmp, "/c")).toThrow("//server/share");
});

test("SMB credentials are written to a private file and removed after mounting", async () => {
	const calls: string[][] = [];
	let seen = "";
	const store = new MountedStore({ kind: "smb", share: "//nas/backup", username: "me", password: "s3cret", path: "host1" }, async (cmd) => {
		calls.push(cmd);
		if (cmd[0] === "mount") {
			const file = cmd[4]!.split(",")[0]!.slice("credentials=".length);
			seen = readFileSync(file, "utf8");
		}
		return { code: 0, output: "" };
	});
	await store.open();
	expect(seen).toBe("username=me\npassword=s3cret\n");
	expect(calls[0]!.join(" ")).not.toContain("s3cret");
	const file = calls[0]![4]!.split(",")[0]!.slice("credentials=".length);
	expect(existsSync(file)).toBe(false);
	await store.close();
	expect(calls[1]![0]).toBe("umount");
});

describe("backup and restore with real tar", () => {
	const volume = join(root, "volumes", "shop_data", "_data");
	const bind = join(root, "srv", "shop", "uploads");
	const stackDir = join(root, "srv", "shop");
	const dest = join(root, "dest");
	mkdirSync(join(volume, "sub"), { recursive: true });
	mkdirSync(bind, { recursive: true });
	writeFileSync(join(volume, "db.bin"), crypto.getRandomValues(new Uint8Array(300_000)));
	writeFileSync(join(volume, "sub", "note.txt"), "hello");
	writeFileSync(join(bind, "logo.png"), "png");
	writeFileSync(join(stackDir, "compose.yaml"), "services: {}\n");
	writeFileSync(join(stackDir, ".env"), "SECRET=1\n");
	const dumpCli = join(root, "fake-docker.sh");
	writeFileSync(dumpCli, '#!/bin/sh\nif [ "$2" = "broken-db" ]; then echo "connection refused" >&2; exit 2; fi\necho "-- dump of $2"\n', { mode: 0o755 });

	const actions: string[] = [];
	const state = new Map([["c1", "running"]]);
	const runtime: BackupRuntime = {
		socket: "/tmp/none.sock",
		projectMounts: async () => [
			{
				id: "c1",
				name: "shop-web-1",
				service: "web",
				image: "nginx:1.27",
				state: state.get("c1")!,
				mounts: [
					{ type: "volume", name: "shop_data", source: volume, destination: "/data", rw: true },
					{ type: "bind", name: null, source: bind, destination: "/uploads", rw: true },
					{ type: "bind", name: null, source: "/etc/localtime", destination: "/etc/localtime", rw: false },
				],
			},
			{ id: "c2", name: "shop-db-1", service: "db", image: "postgres:17.2", state: "running", mounts: [] },
		],
		volumeMountpoint: async () => volume,
		action: async (id, action) => {
			actions.push(`${action} ${id}`);
			state.set(id, action === "stop" ? "exited" : "running");
		},
		cli: async () => dumpCli,
	};
	const key = generateKey();
	const destination: DestinationConfig = { kind: "local", path: dest };
	let items: BackupItem[] = [];

	test("items are the stack files, volumes, real folders and databases", async () => {
		items = await listItems(runtime, "shop", stackDir, "compose.yaml");
		expect(items.map((i) => i.id)).toEqual(["files", "volume:shop_data", `bind:${bind}`, "dump:db"]);
		expect(items[3]).toMatchObject({ kind: "dump", container: "shop-db-1", engine: "postgres" });
	});

	test("a stop mode backup dumps first, stops, saves everything encrypted and starts again", async () => {
		let out = "";
		const result = await runBackup(
			runtime,
			{ destination, key, set: "dm/h/shop/1", project: "shop", directory: stackDir, items, mode: "stop", host: "h" },
			(t) => (out += t),
		);
		expect(result.items.map((i) => i.id)).toEqual(["dump:db", "files", "volume:shop_data", `bind:${bind}`]);
		expect(actions).toEqual(["stop c1", "stop c2", "start c1", "start c2"]);
		expect(out.indexOf("Dumping")).toBeLessThan(out.indexOf("Stopping"));
		const files = (await new FileStore(dest).list("dm/h/shop/1")).map((f) => f.key.split("/").pop());
		expect(files).toContain("manifest.json.dmbak");
		const raw = readFileSync(join(dest, "dm/h/shop/1", fileName({ id: "files", kind: "files" })));
		expect(raw.includes(Buffer.from("SECRET=1"))).toBe(false);
		expect(await testDestination(destination)).toContain("Wrote and read");
	});

	test("verify checks every file and notices a change", async () => {
		let out = "";
		await verifyBackup({ destination, key, set: "dm/h/shop/1" }, (t) => (out += t));
		expect(out).toContain("Every file decrypts and matches.");
		const file = join(dest, "dm/h/shop/1", fileName({ id: "volume:shop_data", kind: "volume" }));
		const copy = readFileSync(file);
		const bad = Buffer.from(copy);
		bad[bad.length - 30]! ^= 1;
		writeFileSync(file, bad);
		await expect(verifyBackup({ destination, key, set: "dm/h/shop/1" }, () => {})).rejects.toThrow();
		writeFileSync(file, copy);
	});

	test("restore puts the data back exactly and keeps the dump aside", async () => {
		writeFileSync(join(volume, "sub", "note.txt"), "changed");
		writeFileSync(join(volume, "extra.txt"), "new file");
		rmSync(join(bind, "logo.png"));
		writeFileSync(join(stackDir, ".env"), "SECRET=2\n");
		writeFileSync(join(stackDir, "keep.txt"), "other file");
		actions.length = 0;
		let out = "";
		await restoreBackup(
			runtime,
			{ destination, key, set: "dm/h/shop/1", project: "shop", directory: stackDir, items: items.map((i) => i.id) },
			(t) => (out += t),
		);
		expect(readFileSync(join(volume, "sub", "note.txt"), "utf8")).toBe("hello");
		expect(existsSync(join(volume, "extra.txt"))).toBe(false);
		expect(readFileSync(join(bind, "logo.png"), "utf8")).toBe("png");
		expect(readFileSync(join(stackDir, ".env"), "utf8")).toBe("SECRET=1\n");
		expect(readFileSync(join(stackDir, "keep.txt"), "utf8")).toBe("other file");
		expect(out).toContain("is kept in the backup");
		expect(actions).toEqual(["stop c1", "stop c2", "start c1", "start c2"]);
	});

	test("a failing dump leaves nothing half written and restarts nothing it did not stop", async () => {
		const broken: BackupItem = { id: "dump:db", kind: "dump", label: "dump", container: "broken-db", engine: "postgres" };
		const store = new FileStore(dest);
		let closed = false;
		actions.length = 0;
		await expect(
			runBackup(
				runtime,
				{ destination, key, set: "dm/h/shop/2", project: "shop", directory: stackDir, items: [broken, items[1]!], mode: "stop", host: "h" },
				() => {},
				async () => ({
					writer: (key) => store.writer(key),
					read: (key) => store.read(key),
					list: (prefix) => store.list(prefix),
					remove: (prefix) => store.remove(prefix),
					close: async () => {
						closed = true;
					},
				}),
			),
		).rejects.toThrow("connection refused");
		expect(closed).toBe(true);
		expect(await new FileStore(dest).list("dm/h/shop/2")).toEqual([]);
		expect(actions).toEqual([]);
		await deleteBackup({ destination, set: "dm/h/shop/1" });
		expect(existsSync(join(dest, "dm/h/shop/1"))).toBe(false);
	});
});

describe("S3 through Bun.S3Client", () => {
	const s3 = new FakeS3();
	afterAll(() => s3.stop());
	const config: DestinationConfig = {
		kind: "s3",
		endpoint: s3.endpoint,
		region: "us-east-1",
		bucket: "backups",
		accessKeyId: "ak",
		secretAccessKey: "sk",
		prefix: "team/",
	};

	test("writes, lists, reads and deletes under the prefix", async () => {
		const store = new S3Store(config as Extract<DestinationConfig, { kind: "s3" }>);
		const writer = await store.writer("a/b.bin");
		const big = crypto.getRandomValues(new Uint8Array(20 * 1024 * 1024));
		await writer.write(big);
		await writer.end();
		expect([...s3.objects.keys()]).toEqual(["team/a/b.bin"]);
		expect(await store.list("a")).toEqual([{ key: "a/b.bin", size: big.length }]);
		expect(await bytes(store.read("a/b.bin"))).toEqual(big);
		await store.remove("a");
		expect(s3.objects.size).toBe(0);
		expect(await testDestination(config)).toBe("Wrote, read and deleted a test file.");
	}, 30_000);

	test("a backup to S3 restores and verifies", async () => {
		const dir = join(root, "s3src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "a.txt"), "from s3");
		const runtime: BackupRuntime = {
			socket: "",
			projectMounts: async () => [],
			volumeMountpoint: async () => dir,
			action: async () => {},
			cli: async () => "docker",
		};
		const key = generateKey();
		const item: BackupItem = { id: `bind:${dir}`, kind: "bind", label: "folder", path: dir };
		await runBackup(runtime, { destination: config, key, set: "dm/1", project: "p", directory: null, items: [item], mode: "live", host: "h" }, () => {});
		expect([...s3.objects.keys()].every((k) => k.startsWith("team/dm/1/"))).toBe(true);
		writeFileSync(join(dir, "a.txt"), "changed");
		await restoreBackup(runtime, { destination: config, key, set: "dm/1", project: "p", directory: null, items: [item.id] }, () => {});
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("from s3");
		await verifyBackup({ destination: config, key, set: "dm/1" }, () => {});
	}, 30_000);
});
