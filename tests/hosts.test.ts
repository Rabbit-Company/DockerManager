import { describe, expect, test } from "bun:test";
import { sql, timestamp } from "../src/controller/db/index.ts";
import { createHost, enrollHost, getHost, renewJoinToken, verifyAgent } from "../src/controller/db/hosts.ts";
import { hashToken } from "../src/controller/lib/crypto.ts";
import { installScript } from "../src/controller/routes/api/agent.ts";
import { get, ORIGIN, post, signIn, testApp } from "./helpers.ts";

describe("enrollment", () => {
	test("a join token works once", async () => {
		const { host, token } = await createHost("web-1");
		expect(host.joinPending).toBe(true);
		const first = await enrollHost(token, "web-1.example");
		expect(first?.hostId).toBe(host.id);
		expect(await enrollHost(token, "web-1.example")).toBeNull();
		expect(await verifyAgent(host.id, first!.secret)).toBe(true);
		expect(await verifyAgent(host.id, "wrong")).toBe(false);
		const saved = await getHost(host.id);
		expect(saved).toMatchObject({ enrolled: true, joinPending: false, hostname: "web-1.example" });
	});

	test("expired tokens are refused", async () => {
		const { host, token } = await createHost("old");
		await sql`UPDATE hosts SET join_expires_at = ${timestamp(new Date(Date.now() - 1000))} WHERE id = ${host.id}`;
		expect(await enrollHost(token, "old")).toBeNull();
	});

	test("enrolling again replaces the secret", async () => {
		const { host, token } = await createHost("moved");
		const first = await enrollHost(token, "a");
		const second = await enrollHost((await renewJoinToken(host.id))!, "b");
		expect(await verifyAgent(host.id, first!.secret)).toBe(false);
		expect(await verifyAgent(host.id, second!.secret)).toBe(true);
	});

	test("tokens are stored only as digests", async () => {
		const { host, token } = await createHost("hashed");
		const [row] = await sql`SELECT join_token_hash FROM hosts WHERE id = ${host.id}`;
		expect(row.join_token_hash).toBe(hashToken(token));
		expect(JSON.stringify(row)).not.toContain(token);
	});

	test("the enroll endpoint answers in JSON", async () => {
		const { app } = testApp();
		const { token } = await createHost("api");
		const bad = await app.handle(new Request(`${ORIGIN}/api/agent/enroll`, { method: "POST", body: JSON.stringify({ token: "dmj_nope", hostname: "x" }) }));
		expect(bad.status).toBe(401);
		const ok = await app.handle(new Request(`${ORIGIN}/api/agent/enroll`, { method: "POST", body: JSON.stringify({ token, hostname: "api.host" }) }));
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { hostId: number; secret: string };
		expect(typeof body.secret).toBe("string");
	});
});

describe("host pages", () => {
	test("adding a host shows the join command once", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		const created = await post(app, "/hosts", { name: "db-2", _csrf: user.csrf }, user.cookie);
		expect(created.status).toBe(303);
		const location = created.headers.get("Location")!;
		expect(location).toMatch(/^\/hosts\/\d+\/join$/);
		const first = await (await get(app, location, user.cookie)).text();
		expect(first).toMatch(/curl -fsSL http:\/\/controller\.test\/install\.sh \| sudo sh -s -- --token dmj_[A-Za-z0-9_-]+/);
		const second = await (await get(app, location, user.cookie)).text();
		expect(second).not.toContain("--token dmj_");
		expect(second).toContain("Create a new join command");
	});

	test("a bad name keeps the form", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		const res = await post(app, "/hosts", { name: "   ", _csrf: user.csrf }, user.cookie);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Give the host a name");
	});

	test("offline hosts say so, unknown ones are 404", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		const { host, token } = await createHost("sleepy");
		await enrollHost(token, "sleepy");
		const page = await (await get(app, `/hosts/${host.id}`, user.cookie)).text();
		expect(page).toContain("The agent is offline");
		expect((await get(app, "/hosts/999999", user.cookie)).status).toBe(404);
		expect((await get(app, "/hosts/abc", user.cookie)).status).toBe(404);
	});

	test("storage page shows NVMe health and a degraded mirror", async () => {
		const { app, hub } = testApp();
		const user = await signIn(app);
		const { host, token } = await createHost("storage-host");
		await enrollHost(token, "storage-host");
		const socket = { send: () => {}, close: () => {} };
		hub.attach(host.id, socket);
		hub.receive(
			host.id,
			socket,
			JSON.stringify({
				type: "storage",
				storage: {
					takenAt: Date.now(),
					smartctl: "ok",
					drives: [
						{
							device: "/dev/nvme0",
							model: "Example NVMe",
							serial: "SN123",
							capacityBytes: 1_000_000_000_000,
							passed: true,
							criticalWarning: 0,
							temperatureC: 40,
							sparePercent: 95,
							spareThresholdPercent: 10,
							usedPercent: 5,
							mediaErrors: 0,
							errorLogEntries: 0,
							powerOnHours: 100,
							dataWrittenBytes: 1_000_000,
							error: null,
						},
					],
					arrays: [{ device: "/dev/md0", level: "raid1", state: "active", raidDisks: 2, degraded: 1, syncAction: "recover", members: ["nvme0n1p3"] }],
				},
			}),
		);
		const page = await (await get(app, `/hosts/${host.id}?tab=storage`, user.cookie)).text();
		expect(page).toContain("Example NVMe");
		expect(page).toContain("SN123");
		expect(page).toContain("1 missing");
		expect(page).toContain("40 &deg;C");
		hub.detach(host.id, socket);
	});

	test("removing a host is recorded in the audit log", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		const { host } = await createHost("goner");
		expect((await post(app, `/hosts/${host.id}/remove`, { _csrf: user.csrf }, user.cookie)).status).toBe(303);
		expect(await getHost(host.id)).toBeNull();
		const audit = await (await get(app, "/audit", user.cookie)).text();
		expect(audit).toContain("host.remove");
	});

	test("the install script needs a token and installs a service", () => {
		const script = installScript("https://ctl.example");
		expect(script).toContain('URL="https://ctl.example"');
		expect(script).toContain("systemctl enable dockermanager-agent");
		expect(script).toContain("Missing --token");
	});
});
