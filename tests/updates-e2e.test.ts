import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/agent/connection.ts";
import type { ContainerStatus } from "../src/agent/docker.ts";
import { RuntimeClient } from "../src/agent/docker.ts";
import { StackService } from "../src/agent/stacks.ts";
import { enroll } from "../src/agent/state.ts";
import { createApp, createHub } from "../src/controller/index.ts";
import { createHost } from "../src/controller/db/hosts.ts";
import { findStack, getDeploy, getStack, getVersion, listDeploys } from "../src/controller/db/stacks.ts";
import { saveServiceSetting } from "../src/controller/db/updates.ts";
import { Deployments } from "../src/controller/deployments.ts";
import { RegistryClient } from "../src/controller/registry.ts";
import { Updates } from "../src/controller/updates.ts";
import { fakeCompose } from "./fake-compose.ts";
import { FakeRegistry } from "./fake-registry.ts";
import { FakeRuntime } from "./fake-runtime.ts";
import { signIn } from "./helpers.ts";

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("Timed out waiting");
		await Bun.sleep(20);
	}
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const D = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

describe("image updates from check to rollback", () => {
	const fake = new FakeRuntime();
	const registry = new FakeRegistry();
	const work = mkdtempSync(join(tmpdir(), "dm-upd-"));
	let server: { port: number; stop(close?: boolean): Promise<void>; publish(t: string, d: string): unknown };
	const hub = createHub((t, d) => server?.publish(t, d));
	const deployments = new Deployments(hub, 5);
	const updates = new Updates(new RegistryClient(async () => null, new Set([registry.host])), hub, deployments, 5);
	const app = createApp(hub, deployments, updates);
	let session: AgentSession;
	let running: Promise<void>;
	let hostId = 0;
	let base = "";
	const image = (tag: string) => `${registry.host}/library/web:${tag}`;

	/** Containers are healthy unless the compose file asks for 2.0.0, which never passes its healthcheck. */
	const status = async (project: string): Promise<ContainerStatus[]> => {
		const compose = readFileSync(join(work, "stacks", project, "compose.yaml"), "utf8");
		return [
			{ name: `${project}-web-1`, service: "web", state: "running", health: compose.includes(":2.0.0") ? "unhealthy" : "healthy", exitCode: 0, restarts: 0 },
		];
	};

	beforeAll(async () => {
		server = (await app.listen({ port: 0, hostname: "127.0.0.1" })) as unknown as typeof server;
		base = `http://127.0.0.1:${server.port}`;
		const { host, token } = await createHost("updates");
		hostId = host.id;
		const runtime = new RuntimeClient(fake.socket);
		await runtime.connect();
		const script = fakeCompose(work);
		const stacks = new StackService(
			fake.socket,
			join(work, "stacks"),
			(p) => runtime.projectLabels(p),
			async () => ({ command: ["sh", script], label: "docker compose" }),
			status,
		);
		session = new AgentSession(await enroll(base, token, "upd"), runtime, quiet, null, stacks);
		running = session.run();
		await until(() => hub.snapshot(hostId) !== null);
		for (const [tag, n] of [
			["1.0.0", 1],
			["1.0.1", 2],
			["1.1.0", 3],
			["2.0.0", 4],
			["latest", 5],
		] as const)
			registry.set("library/web", tag, D(n));
	});

	afterAll(async () => {
		session.close();
		await running;
		await server.stop(true);
		fake.stop();
		registry.stop();
		rmSync(work, { recursive: true, force: true });
	});

	const form = async (cookie: string, path: string, values: Record<string, string>) =>
		fetch(`${base}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: cookie },
			body: new URLSearchParams(values),
		});

	test("a deployed stack gets offers by policy and updates through the form", async () => {
		const user = await signIn(app);
		const compose = `services:\n  # the app\n  web:\n    image: "${image("1.0.0")}" # pinned\n`;
		const created = await form(user.cookie, `/hosts/${hostId}/stacks`, { _csrf: user.csrf, name: "site", compose, env: "", intent: "deploy" });
		expect(await deployments.wait(Number(created.headers.get("Location")!.split("/").pop()))).toBe(true);
		const stack = (await findStack(hostId, "site"))!;

		await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/updates/check`, { _csrf: user.csrf });
		let list = await updates.forStack(stack);
		expect(list[0]).toMatchObject({ service: "web", setting: { policy: "minor", auto: "off" }, offer: { tag: "1.1.0", level: "minor" }, error: null });
		expect(list[0]!.newer.map((n) => n.tag)).toEqual(["2.0.0", "1.1.0", "1.0.1"]);

		await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/updates`, { _csrf: user.csrf, intent: "settings", "policy:web": "major", "auto:web": "off" });
		expect((await updates.forStack(stack))[0]!.offer).toEqual({ tag: "2.0.0", level: "major" });

		await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/updates`, { _csrf: user.csrf, intent: "settings", "policy:web": "minor", "auto:web": "off" });
		list = await updates.forStack(stack);
		expect(list[0]!.offer).toEqual({ tag: "1.1.0", level: "minor" });
		const tab = await (await fetch(`${base}/hosts/${hostId}/stacks/${stack.id}?tab=updates`, { headers: { Cookie: user.cookie } })).text();
		expect(tab).toContain("Update to 1.1.0");
		expect(tab).toContain("2.0.0 is a major release, outside this policy");

		const res = await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/updates`, {
			_csrf: user.csrf,
			intent: "update:web:1.1.0",
			"policy:web": "minor",
			"auto:web": "off",
		});
		expect(res.status).toBe(303);
		const deployId = Number(res.headers.get("Location")!.split("/").pop());
		expect(await deployments.wait(deployId)).toBe(true);
		const deploy = (await getDeploy(deployId))!;
		expect(deploy.action).toBe("upgrade");
		expect(deploy.output).toContain("$ docker compose pull");
		expect(deploy.output).toContain("All containers are up.");
		const after = (await getStack(stack.id))!;
		expect(after).toMatchObject({ currentVersion: 2, deployedVersion: 2 });
		const written = readFileSync(join(work, "stacks", "site", "compose.yaml"), "utf8");
		expect(written).toBe(compose.replace("1.0.0", "1.1.0"));
		expect((await getVersion(stack.id, 2))!.message).toBe("Update web 1.0.0 -> 1.1.0");
	});

	test("a failed update is rolled back to the version that ran", async () => {
		const stack = (await findStack(hostId, "site"))!;
		await saveServiceSetting(stack.id, "web", { policy: "major", auto: "off" });
		const { deployId, done } = await updates.upgrade(stack, [{ service: "web", tag: "2.0.0" }], { id: null, ip: null });
		const result = await done;
		expect(result.ok).toBe(false);
		expect((await getDeploy(deployId))!.output).toContain("unhealthy");
		await deployments.wait(result.rollbackDeployId!);
		expect((await getDeploy(result.rollbackDeployId!))!.status).toBe("ok");
		const after = (await getStack(stack.id))!;
		expect(after).toMatchObject({ currentVersion: 4, deployedVersion: 4 });
		expect((await getVersion(stack.id, 4))!.compose).toContain(":1.1.0");
		expect((await getVersion(stack.id, 4))!.message).toStartWith("Rolled back v3");
		expect(readFileSync(join(work, "stacks", "site", "compose.yaml"), "utf8")).toContain(":1.1.0");
	});

	test("automatic updates apply only what the service allows", async () => {
		const stack = (await findStack(hostId, "site"))!;
		registry.set("library/web", "1.1.1", D(6));
		await updates.checkStack(stack);
		await saveServiceSetting(stack.id, "web", { policy: "major", auto: "patch" });
		expect(await updates.runAutomatic()).toBe(1);
		await until(() => deployments.runningFor(stack.id) === null);
		const after = (await getStack(stack.id))!;
		expect((await getVersion(stack.id, after.currentVersion))!.compose).toContain(":1.1.1");
		expect(after.deployedVersion).toBe(after.currentVersion);
		const [last] = await listDeploys(stack.id, 1);
		expect(last).toMatchObject({ action: "upgrade", status: "ok", username: null });
		expect(await updates.runAutomatic()).toBe(0);
	});

	test("pending edits block updates, and the overview counts offers", async () => {
		const user = await signIn(app);
		const stack = (await findStack(hostId, "site"))!;
		const current = (await getVersion(stack.id, stack.currentVersion))!;
		await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/save`, { _csrf: user.csrf, compose: current.compose + "# note\n", env: "", intent: "save" });
		const fresh = (await getStack(stack.id))!;
		await expect(updates.upgrade(fresh, [{ service: "web", tag: "2.0.0" }], { id: null, ip: null })).rejects.toThrow("saved changes that are not deployed");
		const overview = await (await fetch(`${base}/`, { headers: { Cookie: user.cookie } })).text();
		expect(overview).toMatch(/Updates<\/span><span class="stat-value">1</);
		const page = await (await fetch(`${base}/updates`, { headers: { Cookie: user.cookie } })).text();
		expect(page).toContain("2.0.0");
	});
});
