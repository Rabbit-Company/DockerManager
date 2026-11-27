import { LogTimeFormatter } from "../src/web/log-time.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AgentSession } from "../src/agent/connection.ts";
import { RuntimeClient } from "../src/agent/docker.ts";
import { StackService } from "../src/agent/stacks.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStack, findStack } from "../src/controller/db/stacks.ts";
import { Deployments } from "../src/controller/deployments.ts";
import { fakeCompose } from "./fake-compose.ts";
import { enroll } from "../src/agent/state.ts";
import { createApp, createHub, createStore } from "../src/controller/index.ts";
import { createHost } from "../src/controller/db/hosts.ts";
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

describe("agent and controller over a real socket", () => {
	const fake = new FakeRuntime();
	let server: { port: number; stop(close?: boolean): Promise<void>; publish(t: string, d: string): unknown };
	const store = createStore();
	const hub = createHub((t, d) => server?.publish(t, d), store);
	const deployments = new Deployments(hub);
	const app = createApp(hub, deployments);
	const work = mkdtempSync(join(tmpdir(), "dm-e2e-"));
	const adoptDir = join(work, "shop-src");
	let base = "";
	let session: AgentSession;
	let hostId = 0;
	let running: Promise<void>;

	beforeAll(async () => {
		server = (await app.listen({ port: 0, hostname: "127.0.0.1" })) as unknown as typeof server;
		base = `http://127.0.0.1:${server.port}`;
		const { host, token } = await createHost("e2e");
		hostId = host.id;
		const state = await enroll(base, token, "e2e-box");
		const runtime = new RuntimeClient(fake.socket);
		await runtime.connect();
		mkdirSync(adoptDir, { recursive: true });
		writeFileSync(join(adoptDir, "compose.yml"), "services:\n  web:\n    image: nginx:1.27.0\n  db:\n    image: postgres:17.2\n");
		writeFileSync(join(adoptDir, ".env"), "POSTGRES_PASSWORD=hunter2\n");
		for (const c of fake.containers.filter((c) => c.Labels["com.docker.compose.project"] === "shop")) {
			c.Labels["com.docker.compose.project.working_dir"] = adoptDir;
			c.Labels["com.docker.compose.project.config_files"] = join(adoptDir, "compose.yml");
		}
		const script = fakeCompose(work);
		const stacks = new StackService(
			fake.socket,
			join(work, "stacks"),
			(p) => runtime.projectLabels(p),
			async () => ({ command: ["sh", script], label: "docker compose" }),
		);
		session = new AgentSession(state, runtime, quiet, null, stacks);
		running = session.run();
		await until(() => hub.snapshot(hostId) !== null);
	});

	afterAll(async () => {
		session.close();
		await running;
		await server.stop(true);
		fake.stop();
		rmSync(work, { recursive: true, force: true });
	});

	test("the host reports its facts and containers", () => {
		expect(hub.isOnline(hostId)).toBe(true);
		expect(hub.facts(hostId)).toMatchObject({ hostname: "fake-host", runtime: "docker", cpus: 8 });
		expect(hub.snapshot(hostId)!.containers.map((c) => c.name)).toEqual(["backup-job", "shop-db-1", "shop-web-1"]);
	});

	test("a stop from the web page reaches the engine and the next snapshot shows it", async () => {
		const user = await signIn(app);
		const web = hub.snapshot(hostId)!.containers.find((c) => c.name === "shop-web-1")!;
		const res = await fetch(`${base}/hosts/${hostId}/containers/${web.id}/action`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: user.cookie },
			body: new URLSearchParams({ _csrf: user.csrf, action: "stop", next: `/hosts/${hostId}` }),
		});
		expect(res.status).toBe(303);
		expect(fake.containers.find((c) => c.Id === web.id)!.State).toBe("exited");
		await until(() => hub.snapshot(hostId)!.containers.find((c) => c.id === web.id)!.state === "exited");
		const page = await (await fetch(`${base}/hosts/${hostId}`, { headers: { Cookie: user.cookie } })).text();
		expect(page).toContain("Stopped shop-web-1.");
		expect(page).toContain("shop");
	});

	test("the container page shows details from the agent and no env values", async () => {
		const user = await signIn(app);
		const db = hub.snapshot(hostId)!.containers.find((c) => c.name === "shop-db-1")!;
		const page = await (await fetch(`${base}/hosts/${hostId}/containers/${db.id}`, { headers: { Cookie: user.cookie } })).text();
		expect(page).toContain("SECRET_KEY");
		expect(page).not.toContain("hunter2");
		expect(page).toContain("unless-stopped");
	});

	test("browsers get change notices and log lines over /ws", async () => {
		const user = await signIn(app);
		const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
		const ws = new WebSocket(wsUrl, { headers: { Cookie: user.cookie, Origin: base } } as unknown as string[]);
		const messages: any[] = [];
		ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
		await new Promise((resolve, reject) => {
			ws.addEventListener("open", resolve);
			ws.addEventListener("error", reject);
		});
		ws.send(JSON.stringify({ type: "auth", csrf: user.csrf }));
		await until(() => messages.some((m) => m.type === "auth.ok"));
		ws.send(JSON.stringify({ type: "watch", topics: [`host:${hostId}`] }));
		const db = hub.snapshot(hostId)!.containers.find((c) => c.name === "shop-db-1")!;
		ws.send(JSON.stringify({ type: "logs.open", host: hostId, container: db.id, tail: 25 }));
		await until(() => messages.some((m) => m.type === "logs.end"));
		const text = messages
			.filter((m) => m.type === "logs")
			.map((m) => m.data)
			.join("");
		expect(text).toBe("2026-11-16T13:43:20.534123456Z hello from /shop-db-1 tail=25\n2026-11-16T13:43:20.534123456Z a warning on stderr\n");
		expect(new LogTimeFormatter("UTC").push(text)).toBe("2026-11-16 13:43:20 hello from /shop-db-1 tail=25\n2026-11-16 13:43:20 a warning on stderr\n");

		await hub.request(hostId, "container.action", { id: db.id, action: "stop" });
		await until(() => messages.some((m) => m.type === "changed" && m.topic === `host:${hostId}`));
		ws.close();
	});

	test("logging out closes the browser socket", async () => {
		const user = await signIn(app);
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: user.cookie, Origin: base } } as unknown as string[]);
		const messages: any[] = [];
		ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
		await new Promise((resolve, reject) => {
			ws.addEventListener("open", resolve);
			ws.addEventListener("error", reject);
		});
		ws.send(JSON.stringify({ type: "auth", csrf: user.csrf }));
		await until(() => messages.some((m) => m.type === "auth.ok"));
		const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
		const response = await fetch(`${base}/logout`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: user.cookie },
			body: new URLSearchParams({ _csrf: user.csrf }),
		});
		expect(response.status).toBe(303);
		expect(await closed).toBe(4003);
	});

	test("metrics travel from the agent to the store and back out as a series", async () => {
		const user = await signIn(app);
		const now = Math.floor(Date.now() / 1000);
		const sample = (t: number, cpu: number) => ({
			t,
			interval: 10,
			host: {
				cpu,
				cpus: 8,
				mem: 4e9,
				memTotal: 16e9,
				load1: 1,
				netRx: 100,
				netTx: 50,
				blkRead: 0,
				blkWrite: 0,
				filesystems: [{ mount: "/", fstype: "ext4", size: 100, used: 40, avail: 60 }],
			},
			containers: [{ id: "x", name: "shop-web-1", cpu: cpu / 4, mem: 1e8, memLimit: 1e9, netRx: 1, netTx: 2, blkRead: 3, blkWrite: 4, pids: 5 }],
		});
		expect(session.offerSample(sample(now - 10, 2))).toBe(true);
		expect(session.offerSample(sample(now, 4))).toBe(true);
		await until(() => hub.latest(hostId)?.t === now);
		await store.flush();
		const res = await fetch(`${base}/hosts/${hostId}/metrics.json?range=1h&target=shop-web-1`, { headers: { Cookie: user.cookie } });
		const series = (await res.json()) as { cpu: (number | null)[]; cpus: number; t: number[] };
		expect(series.cpus).toBe(8);
		expect(series.cpu.filter((v) => v !== null)).toEqual([0.5, 1]);
		expect((await fetch(`${base}/hosts/${hostId}/metrics.json?range=2h`, { headers: { Cookie: user.cookie } })).status).toBe(400);
		const zoomed = await fetch(`${base}/hosts/${hostId}/metrics.json?from=${now - 120}&to=${now + 10}&target=shop-web-1`, { headers: { Cookie: user.cookie } });
		const window = (await zoomed.json()) as { step: number; range: string | null; cpu: (number | null)[] };
		expect([window.step, window.range]).toEqual([10, null]);
		expect(window.cpu.filter((v) => v !== null)).toEqual([0.5, 1]);
		for (const bad of [`from=${now}&to=${now + 30}`, `from=${now - 500 * 86_400}&to=${now}`, `from=abc&to=${now}`, `from=${now - 60}`])
			expect((await fetch(`${base}/hosts/${hostId}/metrics.json?${bad}`, { headers: { Cookie: user.cookie } })).status).toBe(400);
		expect((await fetch(`${base}/hosts/${hostId}/metrics.json?range=1h`)).status).toBe(401);
	});

	const form = async (cookie: string, path: string, values: Record<string, string>) =>
		fetch(`${base}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: cookie },
			body: new URLSearchParams(values),
		});

	test("a new stack is saved, checked and deployed through the forms", async () => {
		const user = await signIn(app);
		const compose = 'services:\n  app:\n    image: nginx:1.27\n    ports:\n      - "127.0.0.1:8080:80"\n';
		const bad = await form(user.cookie, `/hosts/${hostId}/stacks`, {
			_csrf: user.csrf,
			name: "blog",
			compose: "services:\n  app:\n    restart: always\n",
			env: "",
			intent: "save",
		});
		expect(bad.status).toBe(400);
		expect(await bad.text()).toContain("needs an image or a build section");

		const taken = await form(user.cookie, `/hosts/${hostId}/stacks`, { _csrf: user.csrf, name: "shop", compose, env: "", intent: "save" });
		expect(await taken.text()).toContain("Adopt it from the Stacks tab instead");

		const checked = await form(user.cookie, `/hosts/${hostId}/stacks`, { _csrf: user.csrf, name: "blog", compose, env: "", intent: "check" });
		expect(await checked.text()).toContain("The host accepts this file");

		const res = await form(user.cookie, `/hosts/${hostId}/stacks`, {
			_csrf: user.csrf,
			name: "blog",
			compose,
			env: "SECRET=x\r\n",
			message: "first",
			intent: "deploy",
		});
		expect(res.status).toBe(303);
		const location = res.headers.get("Location")!;
		expect(location).toMatch(/^\/hosts\/\d+\/stacks\/\d+\/deploys\/\d+$/);
		const stack = (await findStack(hostId, "blog"))!;
		const deployId = Number(location.split("/").pop());
		expect(await deployments.wait(deployId)).toBe(true);
		expect(readFileSync(join(work, "stacks", "blog", "compose.yaml"), "utf8")).toBe(compose);
		expect(readFileSync(join(work, "stacks", "blog", ".env"), "utf8")).toBe("SECRET=x\n");
		const fresh = (await getStack(stack.id))!;
		expect(fresh).toMatchObject({ directory: join(work, "stacks", "blog"), deployedVersion: 1, currentVersion: 1 });
		const output = (await (await fetch(`${base}${location}/output.json`, { headers: { Cookie: user.cookie } })).json()) as { output: string; running: boolean };
		expect(output.running).toBe(false);
		expect(output.output).toContain("up --detach --remove-orphans");
		const page = await (await fetch(`${base}${location}`, { headers: { Cookie: user.cookie } })).text();
		expect(page).toContain("succeeded");

		const saved = await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/save`, {
			_csrf: user.csrf,
			compose: compose.replace("1.27", "1.28"),
			env: "SECRET=x\n",
			intent: "save",
		});
		expect(saved.status).toBe(303);
		const editor = await (await fetch(`${base}/hosts/${hostId}/stacks/${stack.id}`, { headers: { Cookie: user.cookie } })).text();
		expect(editor).toContain("Saved version 2.");
		expect(editor).toContain("changes not deployed");
		const diff = await (await fetch(`${base}/hosts/${hostId}/stacks/${stack.id}/versions/2`, { headers: { Cookie: user.cookie } })).text();
		expect(diff).toContain("image: nginx:1.28");
		expect(diff).not.toContain("SECRET=x");
	});

	test("a failing deploy is recorded with the reason", async () => {
		const user = await signIn(app);
		const res = await form(user.cookie, `/hosts/${hostId}/stacks`, {
			_csrf: user.csrf,
			name: "broken",
			compose: "services:\n  web:\n    image: nginx\n",
			env: "",
			intent: "deploy",
		});
		const id = Number(res.headers.get("Location")!.split("/").pop());
		expect(await deployments.wait(id)).toBe(false);
		const stack = (await findStack(hostId, "broken"))!;
		expect(stack.deployedVersion).toBeNull();
		const page = await (await fetch(`${base}${res.headers.get("Location")}`, { headers: { Cookie: user.cookie } })).text();
		expect(page).toContain("failed");
		expect(page).toContain("service web failed to start");
	});

	test("a running project is adopted with its files and .env", async () => {
		const user = await signIn(app);
		const tab = await (await fetch(`${base}/hosts/${hostId}?tab=stacks`, { headers: { Cookie: user.cookie } })).text();
		expect(tab).toContain("Running projects not managed here");
		const prefill = await (await fetch(`${base}/hosts/${hostId}/stacks/new?adopt=shop`, { headers: { Cookie: user.cookie } })).text();
		expect(prefill).toContain("postgres:17.2");
		expect(prefill).toContain(adoptDir);
		const res = await form(user.cookie, `/hosts/${hostId}/stacks`, {
			_csrf: user.csrf,
			name: "shop",
			adopt: "1",
			directory: adoptDir,
			file: "compose.yml",
			compose: readFileSync(join(adoptDir, "compose.yml"), "utf8"),
			env: "POSTGRES_PASSWORD=hunter2\n",
			intent: "save",
		});
		expect(res.status).toBe(303);
		const stack = (await findStack(hostId, "shop"))!;
		expect(stack).toMatchObject({ adopted: true, directory: adoptDir, file: "compose.yml", deployedVersion: 1 });
		const restart = await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/action`, { _csrf: user.csrf, action: "restart" });
		const id = Number(restart.headers.get("Location")!.split("/").pop());
		expect(await deployments.wait(id)).toBe(true);

		const removed = await form(user.cookie, `/hosts/${hostId}/stacks/${stack.id}/remove`, { _csrf: user.csrf, files: "1" });
		expect(removed.status).toBe(303);
		expect(await getStack(stack.id)).toBeNull();
		expect(readFileSync(join(adoptDir, "compose.yml"), "utf8")).toContain("postgres");
	});

	test("sockets refuse strangers", async () => {
		const status = async (path: string, headers: Record<string, string>) =>
			(
				await fetch(`${base}${path}`, {
					headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
				})
			).status;
		expect(await status(`/api/agent/ws?host=${hostId}`, { Authorization: `Bearer ${hostId}.wrongsecretwrongsecret` })).toBe(401);
		expect(await status("/ws", { Origin: base })).toBe(401);
		const user = await signIn(app);
		expect(await status("/ws", { Origin: "https://evil.test", Cookie: user.cookie })).toBe(403);
		expect(await status("/hosts", { Cookie: user.cookie })).toBe(404);
	});
});
