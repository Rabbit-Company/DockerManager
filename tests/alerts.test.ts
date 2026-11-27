import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { channelValues, deliver, parseChannel, type Notice } from "../src/controller/alerts/channels.ts";
import { Alerting, conditions } from "../src/controller/alerts/engine.ts";
import { defaultSetting, RULES, type RuleId } from "../src/controller/alerts/rules.ts";
import { firingCount } from "../src/controller/alerts/state.ts";
import { createChannel, firingAlerts, openAlert, recentAlerts, saveRuleSetting } from "../src/controller/db/alerts.ts";
import { sql, timestamp } from "../src/controller/db/index.ts";
import { createHost, enrollHost, getHost } from "../src/controller/db/hosts.ts";
import { createStack } from "../src/controller/db/stacks.ts";
import { Hub, type Socket } from "../src/controller/hub.ts";
import type { ContainerSummary, MetricsSample, NvmeDrive, Snapshot, StorageReport } from "../src/shared/protocol.ts";
import { FakeHttp, FakeSmtp } from "./fake-receivers.ts";

const settings = new Map(RULES.map((r) => [r.id, defaultSetting(r.id)]));
const container = (name: string, over: Partial<ContainerSummary> = {}): ContainerSummary => ({
	id: `${name}-id`,
	name,
	image: "x",
	imageId: "",
	state: "running",
	status: "Up 1 hour",
	created: 0,
	project: "shop",
	service: name,
	ports: [],
	mounts: [],
	labels: {},
	networks: [],
	...over,
});
const sample = (over: Partial<NonNullable<MetricsSample["host"]>> = {}, containers: MetricsSample["containers"] = []): MetricsSample => ({
	t: 1,
	interval: 10,
	host: {
		cpu: 1,
		cpus: 4,
		mem: 1e9,
		memTotal: 8e9,
		load1: 0.5,
		netRx: 0,
		netTx: 0,
		blkRead: 0,
		blkWrite: 0,
		filesystems: [{ mount: "/", fstype: "ext4", size: 100, used: 50, avail: 50 }],
		...over,
	},
	containers,
});

describe("conditions", () => {
	const host = {
		id: 1,
		name: "web-1",
		hostname: null,
		facts: null,
		enrolled: true,
		joinPending: false,
		enrolledAt: null,
		lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
		createdAt: "",
	};
	const base = {
		hosts: [host],
		settings,
		deployedProjects: new Map([[1, new Set(["shop"])]]),
		now: Date.now(),
		startedAt: Date.now() - 3_600_000,
		link: (p: string) => `https://ctl${p}`,
	};
	const rules = (list: { rule: RuleId; target: string }[]) => list.map((c) => `${c.rule} ${c.target}`).sort();

	test("a healthy host has nothing wrong", () => {
		expect(
			conditions({ ...base, online: () => true, hub: { snapshot: () => ({ containers: [container("web")] }) as Snapshot, latest: () => sample() } }),
		).toEqual([]);
	});

	test("thresholds, health, restarts and crashes of deployed stacks", () => {
		const snap = {
			containers: [
				container("web", { status: "Up 2 minutes (unhealthy)" }),
				container("db", { state: "restarting", status: "Restarting (1) 3 seconds ago" }),
				container("job", { state: "exited", status: "Exited (2) 1 minute ago" }),
				container("stopped", { state: "exited", status: "Exited (143) 1 minute ago" }),
				container("other", { state: "exited", status: "Exited (1) 1 minute ago", project: "not-managed" }),
			],
		} as Snapshot;
		const latest = sample({ cpu: 3.8, mem: 7.6e9, filesystems: [{ mount: "/", fstype: "ext4", size: 100, used: 95, avail: 5 }] }, [
			{ id: "c1", name: "cache", cpu: 0, mem: 980, memLimit: 1000, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, pids: 1 },
			{ id: "c2", name: "free", cpu: 0, mem: 7.9e9, memLimit: 8e9, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, pids: 1 },
		]);
		const found = conditions({ ...base, online: () => true, hub: { snapshot: () => snap, latest: () => latest } });
		expect(rules(found)).toEqual(
			[
				"container_failed container:1:job",
				"container_memory container:1:cache",
				"container_restarting container:1:db",
				"container_unhealthy container:1:web",
				"disk_full fs:1:/",
				"host_cpu host:1",
				"host_memory host:1",
			].sort(),
		);
		expect(found.find((c) => c.rule === "host_cpu")!.title).toBe("web-1: CPU at 95%");
		const off = new Map(settings);
		off.set("host_cpu", { ...defaultSetting("host_cpu"), enabled: false });
		off.set("disk_full", { ...defaultSetting("disk_full"), threshold: 99 });
		expect(rules(conditions({ ...base, settings: off, online: () => true, hub: { snapshot: () => snap, latest: () => latest } }))).not.toContain(
			"host_cpu host:1",
		);
		expect(rules(conditions({ ...base, settings: off, online: () => true, hub: { snapshot: () => snap, latest: () => latest } }))).not.toContain(
			"disk_full fs:1:/",
		);
	});

	test("offline hosts wait for the grace period after a controller start", () => {
		const offline = { ...base, online: () => false, hub: { snapshot: () => null, latest: () => null } };
		expect(rules(conditions(offline))).toEqual(["host_offline host:1"]);
		expect(conditions({ ...offline, startedAt: Date.now() - 60_000 })).toEqual([]);
		expect(conditions({ ...offline, hosts: [{ ...host, lastSeenAt: new Date().toISOString() }] })).toEqual([]);
	});

	test("alerts on degraded mirrors and NVMe health", () => {
		const drive: NvmeDrive = {
			device: "/dev/nvme0",
			model: "Example NVMe",
			serial: "SN123",
			capacityBytes: 1_000_000_000_000,
			passed: true,
			criticalWarning: 0,
			temperatureC: 40,
			sparePercent: 9,
			spareThresholdPercent: 10,
			usedPercent: 95,
			mediaErrors: 1,
			errorLogEntries: 1,
			powerOnHours: 1000,
			dataWrittenBytes: 1000,
			error: null,
		};
		const storage: StorageReport = {
			takenAt: base.now,
			smartctl: "ok",
			drives: [drive],
			arrays: [{ device: "/dev/md0", level: "raid1", state: "clean", raidDisks: 2, degraded: 1, syncAction: "idle", members: ["nvme0n1p3"] }],
		};
		const hub = { snapshot: () => null, latest: () => sample(), storage: () => storage };
		const found = conditions({ ...base, online: () => true, hub });
		expect(rules(found)).toEqual(["nvme_health nvme:1:SN123", "nvme_wear nvme:1:SN123", "raid_degraded raid:1:/dev/md0"]);
		expect(found.find((c) => c.rule === "nvme_health")?.detail).toContain("media errors");
		expect(conditions({ ...base, now: base.now + 21 * 60_000, online: () => true, hub })).toEqual([]);
		const unavailable = { ...storage, drives: [{ ...drive, error: "Install smartmontools on this host." }] };
		expect(rules(conditions({ ...base, online: () => true, hub: { ...hub, storage: () => unavailable } }))).toContain("nvme_unavailable host:1");
	});
});

describe("channels", () => {
	const http = new FakeHttp();
	const smtp = new FakeSmtp();
	afterAll(() => {
		http.stop();
		smtp.stop();
	});
	const notice: Notice = {
		kind: "firing",
		severity: "critical",
		title: "web-1 is offline",
		detail: "Gone.",
		link: "https://ctl/hosts/1",
		rule: "host_offline",
		host: "web-1",
		at: "2026-11-27T12:00:00.000Z",
	};

	test("ntfy gets a title, priority, tags and a click link", async () => {
		await deliver({ kind: "ntfy", server: http.url, topic: "servers", token: "tk" }, notice);
		const r = http.received.at(-1)!;
		expect(r.path).toBe("/servers");
		expect(r.headers).toMatchObject({
			title: "[DockerManager] Alert: web-1 is offline",
			priority: "urgent",
			tags: "warning",
			click: "https://ctl/hosts/1",
			authorization: "Bearer tk",
		});
		expect(r.body).toContain("Gone.");
		await deliver({ kind: "ntfy", server: http.url, topic: "servers", token: "" }, { ...notice, kind: "resolved" });
		expect(http.received.at(-1)!.headers).toMatchObject({ priority: "default", tags: "white_check_mark", title: "[DockerManager] Resolved: web-1 is offline" });
	});

	test("webhooks are signed with HMAC-SHA256 of the body", async () => {
		await deliver({ kind: "webhook", url: `${http.url}/hook`, secret: "a-long-shared-secret" }, notice);
		const r = http.received.at(-1)!;
		expect(r.headers["x-dockermanager-signature"]).toBe(`sha256=${createHmac("sha256", "a-long-shared-secret").update(r.body).digest("hex")}`);
		expect(JSON.parse(r.body)).toMatchObject({ event: "alert.firing", alert: { rule: "host_offline", severity: "critical", host: "web-1" } });
	});

	test("Discord gets an embed, and refusals become errors", async () => {
		await deliver({ kind: "discord", url: `${http.url}/api/webhooks/1/x` }, notice);
		expect(JSON.parse(http.received.at(-1)!.body).embeds[0]).toMatchObject({
			title: "[DockerManager] Alert: web-1 is offline",
			color: 0xc2261d,
			url: "https://ctl/hosts/1",
		});
		http.status = 401;
		await expect(deliver({ kind: "discord", url: `${http.url}/api/webhooks/1/x` }, notice)).rejects.toThrow("The server answered 401: nope");
		http.status = 200;
	});

	test("email goes out through SMTP", async () => {
		await deliver(
			{
				kind: "email",
				host: "127.0.0.1",
				port: smtp.port,
				security: "none",
				username: "",
				password: "",
				from: "alerts@example.com",
				to: ["me@example.com", "team@example.com"],
			},
			notice,
		);
		const m = smtp.messages.at(-1)!;
		expect(m.from).toBe("alerts@example.com");
		expect(m.to).toEqual(["me@example.com", "team@example.com"]);
		expect(m.data).toContain("Subject: [DockerManager] Alert: web-1 is offline");
		expect(m.data).toContain("https://ctl/hosts/1");
	});

	test("forms are checked per kind and keep secrets", () => {
		const f = (v: Record<string, string>) => {
			const form = new FormData();
			for (const [k, x] of Object.entries(v)) form.set(k, x);
			return form;
		};
		expect(parseChannel(f({ name: "Phone", kind: "ntfy", server: "", topic: "my-servers" }), null).config).toEqual({
			kind: "ntfy",
			server: "https://ntfy.sh",
			topic: "my-servers",
			token: "",
		});
		expect(parseChannel(f({ name: "x", kind: "ntfy", topic: "bad topic" }), null).error).toContain("topic");
		expect(parseChannel(f({ name: "x", kind: "discord", discord_url: "https://evil.example/api/webhooks/1" }), null).error).toContain("webhook address");
		expect(parseChannel(f({ name: "x", kind: "webhook", url: "https://h", secret: "short" }), null).error).toContain("16 characters");
		const hook = parseChannel(f({ name: "x", kind: "webhook", url: "https://h.example/a", secret: "" }), {
			kind: "webhook",
			url: "https://old",
			secret: "kept-secret-123456",
		});
		expect(hook.config).toEqual({ kind: "webhook", url: "https://h.example/a", secret: "kept-secret-123456" });
		expect(parseChannel(f({ name: "x", kind: "email", smtp_host: "smtp.x.com", smtp_port: "587", from: "a@b.co", to: "c@d.co, nope" }), null).error).toContain(
			"recipient",
		);
		const mail = parseChannel(
			f({
				name: "x",
				kind: "email",
				smtp_host: "smtp.x.com",
				smtp_port: "465",
				security: "tls",
				smtp_user: "u",
				smtp_password: "p",
				from: "a@b.co",
				to: "c@d.co e@f.co",
			}),
			null,
		).config;
		expect(mail).toMatchObject({ port: 465, security: "tls", to: ["c@d.co", "e@f.co"] });
		expect(channelValues(mail!, "x")).not.toHaveProperty("smtp_password");
	});
});

class FakeSocket implements Socket {
	send() {}
	close() {}
}

describe("the engine", () => {
	const http = new FakeHttp();
	afterAll(() => http.stop());
	const published: string[] = [];
	const hub = new Hub({ publish: (t) => published.push(t), saveFacts: async () => {}, touch: async () => {}, metrics: () => {}, warn: () => {} });
	const alerting = new Alerting(hub, "https://ctl", Date.now() - 3_600_000);

	test("conditions fire after their minutes, notify, and resolve", async () => {
		await sql`DELETE FROM alerts`;
		await sql`DELETE FROM alert_channels`;
		const channel = await createChannel("hook", { kind: "webhook", url: `${http.url}/hook`, secret: "a-long-shared-secret" });
		const { host, token } = await createHost("engine-host");
		await enrollHost(token, "engine");
		await sql`UPDATE hosts SET last_seen_at = ${timestamp(new Date())} WHERE id = ${host.id}`;
		await createStack({
			hostId: host.id,
			name: "shop",
			directory: null,
			file: "compose.yaml",
			adopted: false,
			compose: "x",
			env: "",
			message: null,
			userId: null,
			deployed: true,
		});
		const ws = new FakeSocket();
		hub.attach(host.id, ws);
		const snap = (status: string): string =>
			JSON.stringify({ type: "snapshot", snapshot: { containers: [container("web", { status })], images: [], volumes: [], networks: [], takenAt: 0 } });
		hub.receive(host.id, ws, snap("Up 5 minutes (unhealthy)"));

		const mine = <T extends { hostId: number | null }>(list: T[]) => list.filter((a) => a.hostId === host.id);
		const t0 = Date.now();
		expect(mine((await alerting.evaluate(t0)).opened)).toEqual([]);
		const later = await alerting.evaluate(t0 + 2 * 60_000 + 1000);
		expect(mine(later.opened).map((a) => a.title)).toEqual(["engine-host: web is unhealthy"]);
		expect(firingCount()).toBeGreaterThanOrEqual(1);
		expect(http.received.some((r) => JSON.parse(r.body).alert?.title === "engine-host: web is unhealthy")).toBe(true);
		expect(mine((await alerting.evaluate(t0 + 3 * 60_000)).opened)).toEqual([]);

		hub.detach(host.id, ws);
		const away = await alerting.evaluate(t0 + 4 * 60_000);
		expect(mine(away.resolved)).toEqual([]);
		expect(mine(away.opened).map((a) => a.rule)).toEqual(["host_offline"]);
		const ws2 = new FakeSocket();
		hub.attach(host.id, ws2);
		hub.receive(host.id, ws2, snap("Up 6 minutes (healthy)"));
		const healed = await alerting.evaluate(t0 + 5 * 60_000);
		expect(
			mine(healed.resolved)
				.map((a) => a.rule)
				.sort(),
		).toEqual(["container_unhealthy", "host_offline"]);
		expect(http.received.some((r) => JSON.parse(r.body).event === "alert.resolved")).toBe(true);
		expect(mine(await firingAlerts())).toEqual([]);
		expect(published).toContain("alerts");
		expect((await recentAlerts())[0]!.status).toBe("resolved");
		void channel;
	});

	test("rules send only to their channels, and a disabled rule resolves its alerts", async () => {
		await sql`DELETE FROM alerts`;
		const quiet = await createChannel("quiet", { kind: "ntfy", server: http.url, topic: "quiet", token: "" });
		const before = http.received.length;
		await saveRuleSetting("backup_failed", { enabled: true, threshold: null, minutes: null, channels: [quiet] });
		await alerting.backupFinished({
			stack: { id: 9, name: "shop", hostId: Number((await sql`SELECT id FROM hosts WHERE name = 'engine-host'`)[0].id) },
			backupId: 4,
			ok: false,
			error: "disk full",
		});
		const sent = http.received.slice(before);
		expect(sent.map((r) => r.path)).toEqual(["/quiet"]);
		expect(sent[0]!.headers.title).toBe("[DockerManager] Alert: engine-host: backup of shop failed");
		await alerting.backupFinished({ stack: { id: 9, name: "shop", hostId: 1 }, backupId: 5, ok: true, error: null });
		expect(http.received.length).toBe(before + 1);
	});

	test("storage alerts resolve only after a fresh healthy report", async () => {
		await sql`DELETE FROM alerts`;
		const { host, token } = await createHost("storage-alert-host");
		await enrollHost(token, "storage-alert-host");
		const storageHub = new Hub({ publish: () => {}, saveFacts: async () => {}, touch: async () => {}, metrics: () => {}, warn: () => {} });
		const ws = new FakeSocket();
		storageHub.attach(host.id, ws);
		const t0 = Date.now();
		const report: StorageReport = {
			takenAt: t0,
			smartctl: "ok",
			drives: [],
			arrays: [{ device: "/dev/md0", level: "raid1", state: "clean", raidDisks: 2, degraded: 1, syncAction: "idle", members: ["nvme0n1p3"] }],
		};
		storageHub.receive(host.id, ws, JSON.stringify({ type: "storage", storage: report }));
		await openAlert({
			rule: "raid_degraded",
			target: `raid:${host.id}:/dev/md0`,
			hostId: host.id,
			severity: "critical",
			title: "Mirror degraded",
			detail: null,
			link: null,
		});
		const storageAlerting = new Alerting(storageHub, "https://ctl", t0 - 3_600_000);
		const stale = await storageAlerting.evaluate(t0 + 21 * 60_000);
		expect(stale.resolved.some((a) => a.hostId === host.id)).toBe(false);
		storageHub.receive(
			host.id,
			ws,
			JSON.stringify({ type: "storage", storage: { ...report, takenAt: t0 + 21 * 60_000, arrays: [{ ...report.arrays[0], degraded: 0 }] } }),
		);
		const healthy = await storageAlerting.evaluate(t0 + 21 * 60_000);
		expect(healthy.resolved.map((a) => a.rule)).toContain("raid_degraded");
		storageHub.detach(host.id, ws);
	});

	test("update offers are announced once", async () => {
		const stack = { id: 3, name: "blog", hostId: 1 };
		const offer = { stack, service: "web", current: "1.0.0", tag: "1.1.0", level: "minor" };
		expect(await alerting.updatesChecked([offer])).toBe(1);
		expect(await alerting.updatesChecked([offer])).toBe(0);
		expect(await alerting.updatesChecked([{ ...offer, tag: "1.2.0" }])).toBe(1);
		await saveRuleSetting("update_available", { enabled: false, threshold: null, minutes: null, channels: null });
		expect(await alerting.updatesChecked([{ ...offer, tag: "1.3.0" }])).toBe(0);
	});
});
