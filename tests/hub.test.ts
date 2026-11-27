import { describe, expect, test } from "bun:test";
import type { HostFacts, Snapshot } from "../src/shared/protocol.ts";
import { AgentOffline, Hub, type Socket } from "../src/controller/hub.ts";

class FakeSocket implements Socket {
	sent: any[] = [];
	closed: { code?: number; reason?: string } | null = null;
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close(code?: number, reason?: string) {
		this.closed = { code, reason };
	}
}

function makeHub(timeoutMs = 200) {
	const published: [string, string][] = [];
	const saved: HostFacts[] = [];
	const stored: [number, number][] = [];
	const hub = new Hub(
		{
			publish: (t, d) => published.push([t, d]),
			saveFacts: async (_id, f) => void saved.push(f),
			touch: async () => {},
			metrics: (id, samples) => void stored.push([id, samples.length]),
			warn: () => {},
		},
		timeoutMs,
	);
	return { hub, published, saved, stored };
}

const snapshot = (states: string[]): Snapshot => ({
	containers: states.map((state, i) => ({
		id: `c${i}`,
		name: `n${i}`,
		image: "img",
		imageId: "",
		state,
		status: "Up 1 minute",
		created: 0,
		project: null,
		service: null,
		ports: [],
		mounts: [],
		labels: {},
		networks: [],
	})),
	images: [],
	volumes: [],
	networks: [],
	takenAt: 0,
});

describe("hub", () => {
	test("tracks online state and replaces an older connection", () => {
		const { hub } = makeHub();
		const a = new FakeSocket();
		const b = new FakeSocket();
		hub.attach(1, a);
		expect(hub.isOnline(1)).toBe(true);
		expect(a.sent[0]).toEqual({ type: "welcome", hostId: 1 });
		hub.attach(1, b);
		expect(a.closed?.code).toBe(4002);
		hub.detach(1, a);
		expect(hub.isOnline(1)).toBe(true);
		hub.detach(1, b);
		expect(hub.isOnline(1)).toBe(false);
	});

	test("answers pings, stores facts and publishes only real snapshot changes", () => {
		const { hub, published, saved } = makeHub();
		const ws = new FakeSocket();
		hub.attach(2, ws);
		hub.receive(2, ws, JSON.stringify({ type: "ping" }));
		expect(ws.sent.at(-1)).toEqual({ type: "pong" });
		hub.receive(2, ws, JSON.stringify({ type: "hello", protocol: 1, facts: { hostname: "h" } }));
		expect(saved).toHaveLength(1);
		published.length = 0;
		hub.receive(2, ws, JSON.stringify({ type: "snapshot", snapshot: snapshot(["running"]) }));
		expect(published.map(([t]) => t)).toEqual(["hosts", "host:2"]);
		published.length = 0;
		const sameButStatus = snapshot(["running"]);
		sameButStatus.containers[0]!.status = "Up 2 minutes";
		hub.receive(2, ws, JSON.stringify({ type: "snapshot", snapshot: sameButStatus }));
		expect(published).toHaveLength(0);
		hub.receive(2, ws, JSON.stringify({ type: "snapshot", snapshot: snapshot(["exited"]) }));
		expect(published).toHaveLength(2);
		expect(hub.snapshot(2)?.containers[0]?.state).toBe("exited");
	});

	test("matches answers to requests, and times out", async () => {
		const { hub } = makeHub(50);
		const ws = new FakeSocket();
		hub.attach(3, ws);
		const pending = hub.request(3, "container.inspect", { id: "c0" });
		const req = ws.sent.at(-1);
		expect(req).toMatchObject({ type: "req", method: "container.inspect", params: { id: "c0" } });
		hub.receive(3, ws, JSON.stringify({ type: "res", id: req.id, ok: true, result: { id: "c0" } }));
		expect(await pending).toEqual({ id: "c0" } as never);

		const failing = hub.request(3, "container.action", { id: "c0", action: "start" });
		hub.receive(3, ws, JSON.stringify({ type: "res", id: ws.sent.at(-1).id, ok: false, error: "No such container" }));
		await expect(failing).rejects.toThrow("No such container");

		await expect(hub.request(3, "snapshot.refresh", {})).rejects.toThrow("did not answer in time");
		await expect(hub.request(99, "snapshot.refresh", {})).rejects.toBeInstanceOf(AgentOffline);
	});

	test("ignores messages from a socket that was replaced", () => {
		const { hub } = makeHub();
		const old = new FakeSocket();
		const fresh = new FakeSocket();
		hub.attach(4, old);
		hub.attach(4, fresh);
		hub.receive(4, old, JSON.stringify({ type: "snapshot", snapshot: snapshot(["running"]) }));
		expect(hub.snapshot(4)).toBeNull();
	});

	test("only the requested host can answer a request", async () => {
		const { hub } = makeHub();
		const target = new FakeSocket();
		const other = new FakeSocket();
		hub.attach(7, target);
		hub.attach(8, other);
		const pending = hub.request(7, "container.inspect", { id: "c0" });
		const id = target.sent.at(-1).id;
		hub.receive(8, other, JSON.stringify({ type: "res", id, ok: true, result: { id: "forged" } }));
		hub.receive(7, target, JSON.stringify({ type: "res", id, ok: true, result: { id: "c0" } }));
		expect(await pending).toEqual({ id: "c0" } as never);
	});

	test("a disconnected agent cannot answer an old request", async () => {
		const { hub } = makeHub();
		const old = new FakeSocket();
		const fresh = new FakeSocket();
		hub.attach(9, old);
		const pending = hub.request(9, "snapshot.refresh", {});
		hub.attach(9, fresh);
		await expect(pending).rejects.toBeInstanceOf(AgentOffline);
	});

	test("relays log streams to the browser that opened them", async () => {
		const { hub } = makeHub();
		const agent = new FakeSocket();
		const browser = new FakeSocket();
		const other = new FakeSocket();
		hub.attach(5, agent);
		const opening = hub.openLogs(5, "c0", 100, browser);
		const req = agent.sent.at(-1);
		expect(req.method).toBe("logs.open");
		hub.receive(5, agent, JSON.stringify({ type: "res", id: req.id, ok: true, result: { ok: true } }));
		const stream = await opening;
		hub.receive(5, agent, JSON.stringify({ type: "stream", stream, data: "line\n" }));
		expect(browser.sent.at(-1)).toEqual({ type: "logs", stream, data: "line\n" });
		hub.closeLogs(stream, other);
		expect(agent.sent.at(-1).method).toBe("logs.open");
		hub.browserClosed(browser);
		expect(agent.sent.at(-1)).toMatchObject({ method: "logs.close", params: { stream } });
	});

	test("ends open log streams when the agent goes away", async () => {
		const { hub } = makeHub();
		const agent = new FakeSocket();
		const browser = new FakeSocket();
		hub.attach(6, agent);
		const opening = hub.openLogs(6, "c0", 10, browser);
		hub.receive(6, agent, JSON.stringify({ type: "res", id: agent.sent.at(-1).id, ok: true, result: {} }));
		const stream = await opening;
		hub.detach(6, agent);
		expect(browser.sent.at(-1)).toEqual({ type: "logs.end", stream, error: "The agent disconnected." });
	});
});
