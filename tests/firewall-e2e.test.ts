import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/agent/connection.ts";
import { RuntimeClient } from "../src/agent/docker.ts";
import { Firewall } from "../src/agent/firewall.ts";
import { enroll } from "../src/agent/state.ts";
import { defaultSetting } from "../src/controller/alerts/rules.ts";
import { recentAlerts, saveRuleSetting } from "../src/controller/db/alerts.ts";
import { getFirewall } from "../src/controller/db/firewall.ts";
import { createHost } from "../src/controller/db/hosts.ts";
import { createApp, createHub } from "../src/controller/index.ts";
import { FakeNft } from "./fake-nft.ts";
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

describe("firewall rules through the controller and a real agent session", () => {
	const fake = new FakeRuntime();
	const work = mkdtempSync(join(tmpdir(), "dm-fw-e2e-"));
	const nft = new FakeNft();
	const firewall = new Firewall(nft.exec, join(work, "firewall.json"));
	let server: { port: number; stop(close?: boolean): Promise<void>; publish(t: string, d: string): unknown };
	const hub = createHub((t, d) => server?.publish(t, d));
	const app = createApp(hub);
	let session: AgentSession;
	let running: Promise<void>;
	let hostId = 0;
	let base = "";
	let user: Awaited<ReturnType<typeof signIn>>;

	beforeAll(async () => {
		server = (await app.listen({ port: 0, hostname: "127.0.0.1" })) as unknown as typeof server;
		base = `http://127.0.0.1:${server.port}`;
		const { host, token } = await createHost("fw-host");
		hostId = host.id;
		const runtime = new RuntimeClient(fake.socket);
		await runtime.connect();
		const listeners = async () => [
			{ protocol: "tcp" as const, address: "0.0.0.0", port: 22, pid: 1, process: "sshd" },
			{ protocol: "tcp" as const, address: "127.0.0.1", port: 5432, pid: 2, process: "postgres" },
		];
		session = new AgentSession(await enroll(base, token, "fw"), runtime, quiet, null, null, firewall, listeners);
		firewall.onEvent = (event, detail) => session.firewallEvent(event, detail);
		running = session.run();
		await until(() => hub.snapshot(hostId) !== null);
		user = await signIn(app);
		await saveRuleSetting("firewall_reverted", defaultSetting("firewall_reverted"));
	}, 20_000);

	afterAll(async () => {
		firewall.stop();
		session.close();
		await running;
		await server.stop(true);
		fake.stop();
		rmSync(work, { recursive: true, force: true });
	});

	const post = (path: string, values: Record<string, string>) =>
		fetch(`${base}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: user.cookie },
			body: new URLSearchParams({ _csrf: user.csrf, ...values }),
		});
	const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { Cookie: user.cookie } })).text();
	const rules = { rules: "allow tcp 22 from 10.0.0.0/8 to host\ndeny tcp 5432\n", host_default: "drop", container_default: "accept", ssh_port: "22" };

	test("the tab shows what the host supports and what the rules would do", async () => {
		const page = await get(`/hosts/${hostId}?tab=firewall`);
		expect(page).toContain("nftables 1.1.3 is installed");
		expect(page).toContain("inet firewalld");
		expect(page).toContain("Not managed.");
		const preview = await (await post(`/hosts/${hostId}/firewall`, { ...rules, intent: "preview" })).text();
		expect(preview).toContain("What these rules do");
		expect(preview).toContain("kept open for SSH");
		expect(preview).toContain("listens on loopback only");
		expect(preview).toContain("counter drop comment &quot;default&quot;");
		expect(nft.scripts).toHaveLength(0);
		const bad = await (await post(`/hosts/${hostId}/firewall`, { ...rules, rules: "allow tcp 22 from nowhere", intent: "apply" })).text();
		expect(bad).toContain("Line 1: &quot;nowhere&quot; is not an address");
		expect(nft.scripts).toHaveLength(0);
	});

	test("applied rules wait to be kept, and keeping makes them active", async () => {
		const res = await post(`/hosts/${hostId}/firewall`, { ...rules, intent: "apply" });
		expect(res.status).toBe(303);
		expect(nft.table).toContain("tcp dport 22 ip saddr 10.0.0.0/8");
		expect((await getFirewall(hostId))!.status).toBe("pending");
		expect(await get(`/hosts/${hostId}?tab=firewall`)).toContain("New rules are active, keep them?");
		expect((await post(`/hosts/${hostId}/firewall/keep`, {})).status).toBe(303);
		expect((await getFirewall(hostId))!).toMatchObject({ status: "active", rules: rules.rules, hostDefault: "drop" });
		expect(firewall.status()).toMatchObject({ managed: true, pendingUntil: null });
		expect(await get(`/hosts/${hostId}?tab=firewall`)).toContain("Managed here and active.");
	});

	test("undo goes back to the kept rules without an alert", async () => {
		const before = nft.scripts.length;
		await post(`/hosts/${hostId}/firewall`, { ...rules, rules: "deny tcp 1-65535 to host\n", intent: "apply" });
		expect((await post(`/hosts/${hostId}/firewall/undo`, {})).status).toBe(303);
		expect((await getFirewall(hostId))!.status).toBe("reverted");
		expect(nft.table).toContain("proto-dst 5432");
		expect(nft.scripts.length).toBe(before + 2);
		expect(firewall.status().policy!.rules).toHaveLength(2);
		await Bun.sleep(100);
		expect((await recentAlerts()).some((a) => a.hostId === hostId)).toBe(false);
	});

	test("rules not kept in time come back on the agent, and the controller records it and alerts", async () => {
		await post(`/hosts/${hostId}/firewall`, { ...rules, rules: "deny tcp 1-65535 to host\n", intent: "apply" });
		const token = firewall.status().pendingToken!;
		await firewall.revert(token, true);
		await until(async () => (await getFirewall(hostId))!.status === "reverted");
		await until(async () => (await recentAlerts()).some((a) => a.hostId === hostId));
		const alert = (await recentAlerts()).find((a) => a.hostId === hostId)!;
		expect(alert.title).toBe("fw-host: new firewall rules were undone");
		const page = await get(`/hosts/${hostId}?tab=firewall`);
		expect(page).toContain("The new rules were not confirmed in time");
		expect(page).toContain("allow tcp 22 from 10.0.0.0/8 to host\ndeny tcp 5432 to containers\n</textarea>");
		expect(page).toContain("tcp dport 22 ip saddr 10.0.0.0/8 counter accept");
		expect(page).toContain("Packets matched since the rules were applied");
		expect((await post(`/hosts/${hostId}/firewall/keep`, {})).status).toBe(303);
		expect(await get(`/hosts/${hostId}?tab=firewall`)).toContain("There is nothing waiting to be kept.");
	});

	test("removing all rules takes the chains away", async () => {
		expect((await post(`/hosts/${hostId}/firewall/disable`, {})).status).toBe(303);
		expect(nft.table).toBeNull();
		expect((await getFirewall(hostId))!.status).toBe("off");
		expect(firewall.status().managed).toBe(false);
	});
});
