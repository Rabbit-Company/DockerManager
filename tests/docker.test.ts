import { afterAll, describe, expect, test } from "bun:test";
import { JsonLines, LogDemuxer, RuntimeClient, socketCandidates, toContainerSummary } from "../src/agent/docker.ts";
import { FakeRuntime, frame, sampleContainers } from "./fake-runtime.ts";

describe("log demuxer", () => {
	test("splits frames, also across chunk borders", () => {
		const demux = new LogDemuxer();
		const bytes = new Uint8Array([...frame(1, "out line\n"), ...frame(2, "err line\n")]);
		const first = demux.push(bytes.subarray(0, 5));
		const second = demux.push(bytes.subarray(5, 20));
		const third = demux.push(bytes.subarray(20));
		expect(first).toEqual([]);
		expect([...second, ...third]).toEqual([
			{ stream: "stdout", text: "out line\n" },
			{ stream: "stderr", text: "err line\n" },
		]);
	});

	test("keeps multi byte characters that are split between frames", () => {
		const demux = new LogDemuxer();
		const bytes = new TextEncoder().encode(`caf${String.fromCharCode(0xe9)}`);
		const a = new Uint8Array(8 + 4);
		a[0] = 1;
		new DataView(a.buffer).setUint32(4, 4);
		a.set(bytes.subarray(0, 4), 8);
		const b = new Uint8Array(8 + 1);
		b[0] = 1;
		new DataView(b.buffer).setUint32(4, 1);
		b.set(bytes.subarray(4), 8);
		const text = [...demux.push(a), ...demux.push(b)].map((p) => p.text).join("");
		expect(text).toBe(`caf${String.fromCharCode(0xe9)}`);
	});
});

test("json lines parse whole objects only", () => {
	const lines = new JsonLines();
	const enc = new TextEncoder();
	expect(lines.push(enc.encode('{"a":1}\n{"b"'))).toEqual([{ a: 1 }]);
	expect(lines.push(enc.encode(":2}\n\nnot json\n"))).toEqual([{ b: 2 }]);
});

test("socket candidates put Docker first and respect CONTAINER_SOCKET", () => {
	expect(socketCandidates({}, 1000)).toEqual(["/var/run/docker.sock", "/run/podman/podman.sock", "/run/user/1000/podman/podman.sock"]);
	expect(socketCandidates({ CONTAINER_SOCKET: "unix:///tmp/x.sock" }, 0)).toEqual(["/tmp/x.sock"]);
});

test("container summaries read compose labels and names", () => {
	const summary = toContainerSummary(sampleContainers()[0]!);
	expect(summary.name).toBe("shop-web-1");
	expect(summary.project).toBe("shop");
	expect(summary.service).toBe("web");
	expect(summary.ports).toHaveLength(2);
	expect(summary.networks).toEqual(["shop_default"]);
});

describe("runtime client against a fake engine", () => {
	const fake = new FakeRuntime();
	afterAll(() => fake.stop());

	test("reads facts and uses the engine's API version", async () => {
		const client = new RuntimeClient(fake.socket);
		const facts = await client.facts("0.1.0");
		expect(facts).toMatchObject({ hostname: "fake-host", runtime: "docker", runtimeVersion: "27.4.0", apiVersion: "1.45", cpus: 8, rootless: false });
		await client.snapshot();
		expect(fake.requests.some((r) => r.startsWith("GET /containers/json?all=true"))).toBe(true);
	});

	test("detects Podman", async () => {
		fake.podman = true;
		const client = new RuntimeClient(fake.socket);
		expect((await client.facts("0.1.0")).runtime).toBe("podman");
		fake.podman = false;
	});

	test("snapshot drops untagged image names", async () => {
		const client = new RuntimeClient(fake.socket);
		await client.connect();
		const snap = await client.snapshot();
		expect(snap.containers.map((c) => c.name)).toEqual(["backup-job", "shop-db-1", "shop-web-1"]);
		expect(snap.images[1]!.tags).toEqual([]);
		expect(snap.volumes[0]!.project).toBe("shop");
	});

	test("inspect keeps env names and drops values", async () => {
		const client = new RuntimeClient(fake.socket);
		await client.connect();
		const detail = await client.inspect("shop-web-1");
		expect(detail.envNames).toEqual(["PATH", "SECRET_KEY"]);
		expect(JSON.stringify(detail)).not.toContain("hunter2");
		expect(detail.finishedAt).toBeNull();
		expect(detail.restartPolicy).toBe("unless-stopped");
		expect(detail.ports).toEqual([
			{ privatePort: 80, publicPort: 8080, ip: "0.0.0.0", type: "tcp" },
			{ privatePort: 443, publicPort: null, ip: null, type: "tcp" },
		]);
	});

	test("actions change state and errors carry the engine message", async () => {
		const client = new RuntimeClient(fake.socket);
		await client.connect();
		await client.action("shop-web-1", "stop");
		expect(fake.containers[0]!.State).toBe("exited");
		await client.action("shop-web-1", "start");
		expect(fake.containers[0]!.State).toBe("running");
		await expect(client.action("missing", "start")).rejects.toThrow("No such container: missing");
	});

	test("follows logs through the demuxer, with Docker's time on every line", async () => {
		const client = new RuntimeClient(fake.socket);
		await client.connect();
		let text = "";
		await client.followLogs("shop-db-1", 50, new AbortController().signal, (t) => (text += t));
		expect(text).toBe("2026-11-16T13:43:20.534123456Z hello from /shop-db-1 tail=50\n2026-11-16T13:43:20.534123456Z a warning on stderr\n");
	});
});
