import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/agent/connection.ts";
import { RuntimeClient } from "../src/agent/docker.ts";
import { StackService } from "../src/agent/stacks.ts";
import { enroll } from "../src/agent/state.ts";
import { Backups } from "../src/controller/backups.ts";
import { getBackup, getPlan, getTask, listBackups } from "../src/controller/db/backups.ts";
import { sql, timestamp } from "../src/controller/db/index.ts";
import { createHost } from "../src/controller/db/hosts.ts";
import { createStack } from "../src/controller/db/stacks.ts";
import { Deployments } from "../src/controller/deployments.ts";
import { createApp, createHub } from "../src/controller/index.ts";
import { fakeCompose } from "./fake-compose.ts";
import { FakeRuntime } from "./fake-runtime.ts";
import { signIn } from "./helpers.ts";

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("Timed out waiting");
		await Bun.sleep(25);
	}
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe("backups through the controller and a real agent session", () => {
	const fake = new FakeRuntime();
	const work = mkdtempSync(join(tmpdir(), "dm-bk-"));
	const volume = join(work, "volumes", "shop_data");
	const stackDir = join(work, "shop");
	const dest = join(work, "dest");
	let server: { port: number; stop(close?: boolean): Promise<void>; publish(t: string, d: string): unknown };
	const hub = createHub((t, d) => server?.publish(t, d));
	const deployments = new Deployments(hub, 5);
	const backups = new Backups(hub, deployments);
	const app = createApp(hub, deployments, undefined, backups);
	let session: AgentSession;
	let running: Promise<void>;
	let hostId = 0;
	let stackId = 0;
	let base = "";
	let user: Awaited<ReturnType<typeof signIn>>;

	beforeAll(async () => {
		mkdirSync(join(volume, "data"), { recursive: true });
		writeFileSync(join(volume, "data", "orders.db"), "orders v1");
		mkdirSync(stackDir, { recursive: true });
		writeFileSync(join(stackDir, "compose.yml"), "services:\n  web:\n    image: nginx\n");
		writeFileSync(join(stackDir, ".env"), "TOKEN=1\n");
		fake.volumePaths.set("shop_data", volume);
		server = (await app.listen({ port: 0, hostname: "127.0.0.1" })) as unknown as typeof server;
		base = `http://127.0.0.1:${server.port}`;
		const { host, token } = await createHost("backup-host");
		hostId = host.id;
		const runtime = new RuntimeClient(fake.socket);
		await runtime.connect();
		const script = fakeCompose(work);
		const stacks = new StackService(
			fake.socket,
			join(work, "stacks"),
			(p) => runtime.projectLabels(p),
			async () => ({ command: ["sh", script], label: "docker compose" }),
		);
		session = new AgentSession(await enroll(base, token, "bk"), runtime, quiet, null, stacks);
		running = session.run();
		await until(() => hub.snapshot(hostId) !== null);
		const stack = await createStack({
			hostId,
			name: "shop",
			directory: stackDir,
			file: "compose.yml",
			adopted: true,
			compose: "services: {}\n",
			env: "",
			message: null,
			userId: null,
			deployed: true,
		});
		stackId = stack.id;
		user = await signIn(app);
	});

	afterAll(async () => {
		session.close();
		await running;
		await server.stop(true);
		fake.stop();
		rmSync(work, { recursive: true, force: true });
	});

	test("agent checks target volumes without creating missing ones", async () => {
		expect(await session.handle("backup.volume.check", { names: ["shop_data", "new_data"] })).toEqual({ existing: ["shop_data"] });
		expect(fake.volumePaths.has("new_data")).toBe(false);
	});

	const post = (path: string, values: Record<string, string | string[]>) => {
		const body = new URLSearchParams();
		body.set("_csrf", user.csrf);
		for (const [k, v] of Object.entries(values)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
		return fetch(`${base}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: user.cookie },
			body,
		});
	};
	const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { Cookie: user.cookie } })).text();
	const id = (res: Response) => Number(res.headers.get("Location")!.split("/").pop());
	let destinationId = 0;
	let recoveryKey = "";

	test("a destination is added, shows its recovery key once and tests from the host", async () => {
		const res = await post("/backups/destinations", { name: "Local disk", kind: "local", path: dest });
		expect(res.status).toBe(303);
		destinationId = id(res);
		const page = await get(`/backups/destinations/${destinationId}`);
		recoveryKey = /id="recovery-key">([A-Za-z0-9_-]{43})</.exec(page)![1]!;
		expect(await get(`/backups/destinations/${destinationId}`)).not.toContain(recoveryKey);
		await post(`/backups/destinations/${destinationId}/test`, { host: String(hostId) });
		expect(await get(`/backups/destinations/${destinationId}`)).toContain(`Wrote and read a test file in ${dest}.`);
	});

	test("the stack lists what it can back up, and a backup runs from the form", async () => {
		const tab = await get(`/hosts/${hostId}/stacks/${stackId}?tab=backups`);
		expect(tab).toContain("Volume shop_data");
		expect(tab).toContain("Stack files (compose.yml and .env)");
		expect(tab).toContain("PostgreSQL dump of db");
		const res = await post(`/hosts/${hostId}/stacks/${stackId}/backups`, {
			destination: String(destinationId),
			preset: "0 3 * * *",
			cron: "",
			item: ["files", "volume:shop_data"],
			mode: "stop",
			keep_daily: "1",
			keep_weekly: "0",
			keep_monthly: "0",
			enabled: "1",
			intent: "run",
		});
		expect(res.status).toBe(303);
		const backupId = id(res);
		expect(await backups.jobs.wait(`backup:${backupId}`)).toBe(true);
		const backup = (await getBackup(backupId))!;
		expect(backup).toMatchObject({ status: "ok", trigger: "manual", mode: "stop" });
		expect(backup.items.map((i) => i.id)).toEqual(["files", "volume:shop_data"]);
		expect(backup.bytes).toBeGreaterThan(0);
		expect(existsSync(join(dest, backup.setPath, "manifest.json.dmbak"))).toBe(true);
		expect(fake.requests.filter((r) => /\/containers\/[0-9a-f]+\/(stop|start)/.test(r)).length).toBe(4);
		const plan = (await getPlan(stackId))!;
		expect(plan).toMatchObject({ schedule: "0 3 * * *", items: ["files", "volume:shop_data"], keepDaily: 1, enabled: true });
		expect(new Date(plan.nextRunAt!).getHours()).toBe(3);
		expect(await get(`/hosts/${hostId}/stacks/${stackId}/backups/${backupId}`)).toContain("Backup complete, 2 item(s)");

		const file = backup.items.find((i) => i.id === "files")!.file;
		const proc = Bun.spawnSync(["sh", "-c", `bun run src/agent/index.ts decrypt --key ${recoveryKey} '${join(dest, backup.setPath, file)}' | tar -tz`], {
			cwd: join(import.meta.dir, ".."),
		});
		expect(`exit ${proc.exitCode}: ${proc.stdout.toString()}${proc.stderr.toString()}`).toContain(".env");
	});

	test("a managed stack shows the transfer form", async () => {
		const managed = await createStack({
			hostId,
			name: "move-page",
			directory: null,
			file: "compose.yaml",
			adopted: false,
			compose: "services:\n  web:\n    image: nginx\n",
			env: "",
			message: null,
			userId: null,
			deployed: true,
		});
		const path = `/hosts/${hostId}/stacks/${managed.id}`;
		expect(await get(path)).toContain(`${path}/transfer`);
		const page = await get(`${path}/transfer`);
		expect(page).toContain("Stop source and transfer");
		expect(page).toContain("Connect another host before transferring");
	});

	test("verify and restore run as tasks", async () => {
		const [backup] = await listBackups(stackId);
		const verify = await post(`/hosts/${hostId}/stacks/${stackId}/backups/${backup!.id}/verify`, {});
		const verifyId = id(verify);
		expect(await backups.jobs.wait(`task:${verifyId}`)).toBe(true);
		expect((await getTask(verifyId))!.output).toContain("Every file decrypts and matches.");

		writeFileSync(join(volume, "data", "orders.db"), "orders v2, wrong");
		writeFileSync(join(volume, "stray.tmp"), "x");
		writeFileSync(join(stackDir, ".env"), "TOKEN=2\n");
		const restore = await post(`/hosts/${hostId}/stacks/${stackId}/backups/${backup!.id}/restore`, { item: ["volume:shop_data", "files"] });
		const restoreId = id(restore);
		expect(await backups.jobs.wait(`task:${restoreId}`)).toBe(true);
		expect(readFileSync(join(volume, "data", "orders.db"), "utf8")).toBe("orders v1");
		expect(existsSync(join(volume, "stray.tmp"))).toBe(false);
		expect(readFileSync(join(stackDir, ".env"), "utf8")).toBe("TOKEN=1\n");
		expect(await get(`/hosts/${hostId}/stacks/${stackId}/backups/${backup!.id}/tasks/${restoreId}`)).toContain("Restore complete.");
	});

	test("a due plan runs on the tick and retention prunes the older backup", async () => {
		const before = await listBackups(stackId);
		await sql`UPDATE backup_plans SET next_run_at = ${timestamp(new Date(Date.now() - 1000))} WHERE stack_id = ${stackId}`;
		expect(await backups.tick()).toBe(1);
		await until(async () => (await listBackups(stackId))[0]!.status !== "running");
		const after = await listBackups(stackId);
		expect(after[0]).toMatchObject({ status: "ok", trigger: "schedule" });
		expect(after.map((b) => b.id)).toEqual([after[0]!.id]);
		const old = (await getBackup(before[0]!.id))!;
		expect(old.deletedAt).not.toBeNull();
		expect(existsSync(join(dest, old.setPath))).toBe(false);
		expect(await backups.tick()).toBe(0);
	});

	test("backups started in the same second get their own folders, so pruning one keeps the other", async () => {
		const [current] = await listBackups(stackId);
		const plan = (await getPlan(stackId))!;
		const stack = { ...(await (await import("../src/controller/db/stacks.ts")).getStack(stackId))! };
		const a = await backups.start(stack, { destinationId, mode: "live", items: ["files"], trigger: "manual", plan: null }, { id: null, ip: null });
		await backups.jobs.wait(`backup:${a}`);
		const b = await backups.start(stack, { destinationId, mode: "live", items: ["files"], trigger: "manual", plan }, { id: null, ip: null });
		await backups.jobs.wait(`backup:${b}`);
		const first = (await getBackup(a))!;
		const second = (await getBackup(b))!;
		expect(first.setPath).not.toBe(second.setPath);
		expect(first.deletedAt).not.toBeNull();
		expect((await getBackup(current!.id))!.deletedAt).not.toBeNull();
		expect(existsSync(join(dest, second.setPath, "manifest.json.dmbak"))).toBe(true);
		const verify = await backups.verify(second, { id: null, ip: null });
		expect(await backups.jobs.wait(`task:${verify}`)).toBe(true);
	});

	test("a destination in use cannot be removed, and the overview lists the plan", async () => {
		await post(`/backups/destinations/${destinationId}/delete`, {});
		expect(await get(`/backups/destinations/${destinationId}`)).toContain("This destination is still in use.");
		const overview = await get("/backups");
		expect(overview).toContain("Every day at 03:00");
		expect(overview).toContain("Local disk");
	});

	test("a failing backup is recorded and leaves nothing behind", async () => {
		fake.volumePaths.delete("shop_data");
		const res = await post(`/hosts/${hostId}/stacks/${stackId}/backups`, {
			destination: String(destinationId),
			preset: "@hourly",
			item: ["volume:shop_data"],
			mode: "live",
			keep_daily: "3",
			intent: "run",
			enabled: "1",
		});
		const backupId = id(res);
		expect(await backups.jobs.wait(`backup:${backupId}`)).toBe(false);
		const backup = (await getBackup(backupId))!;
		expect(backup.status).toBe("failed");
		expect(backup.output).toContain("no such volume");
		expect(existsSync(join(dest, backup.setPath))).toBe(false);
		fake.volumePaths.set("shop_data", volume);
	});
});
