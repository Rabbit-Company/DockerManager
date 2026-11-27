import { afterAll, expect, test } from "bun:test";
import { Collector } from "../src/agent/collector.ts";
import { RuntimeClient } from "../src/agent/docker.ts";
import { FakeProc } from "./fake-proc.ts";
import { FakeRuntime } from "./fake-runtime.ts";

const fake = new FakeRuntime();
const proc = new FakeProc();
afterAll(() => {
	fake.stop();
	proc.cleanup();
});
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

test("samples cgroups where it can and the stats endpoint where it cannot", async () => {
	const [web, db] = fake.containers;
	fake.pids.set(web!.Id, 101);
	const reading = (usageUsec: number, rx: number) =>
		proc.container(101, `/system.slice/docker-${web!.Id}.scope`, {
			usageUsec,
			memCurrent: 50_000_000,
			inactive: 0,
			max: "268435456",
			rbytes: 0,
			wbytes: 0,
			rx,
			tx: 0,
			pids: 4,
		});
	proc.host({ busy: 0, idle: 0, memTotalKb: 1_000_000, memAvailableKb: 500_000, rx: 0, tx: 0, readSectors: 0, writeSectors: 0 });
	reading(0, 0);
	const runtime = new RuntimeClient(fake.socket);
	await runtime.connect();
	const collector = new Collector(
		runtime,
		() => {},
		() => {},
		quiet,
		{ proc: proc.proc, sys: proc.sys },
		10_000,
	);

	const first = await collector.tick(1_000_000);
	expect(first.containers.map((c) => c.name).sort()).toEqual(["shop-db-1", "shop-web-1"]);
	expect(first.containers.find((c) => c.name === "shop-web-1")).toMatchObject({ cpu: null, mem: 50_000_000, memLimit: 268_435_456, pids: 4 });
	expect(first.containers.find((c) => c.name === "shop-db-1")).toMatchObject({ mem: 64_000_000, memLimit: 512_000_000 });

	reading(5_000_000, 20_000);
	proc.host({ busy: 100, idle: 100, memTotalKb: 1_000_000, memAvailableKb: 500_000, rx: 1000, tx: 0, readSectors: 0, writeSectors: 0 });
	const second = await collector.tick(1_010_000);
	const w = second.containers.find((c) => c.name === "shop-web-1")!;
	expect(w.cpu).toBe(0.5);
	expect(w.netRx).toBe(2000);
	expect(second.host?.cpu).toBe(1);
	expect(second.host?.netRx).toBe(100);
	expect(fake.requests.some((r) => r.includes(`/containers/${db!.Id}/stats`))).toBe(true);
	expect(fake.requests.some((r) => r.includes(`/containers/${web!.Id}/stats`))).toBe(false);
});

test("disk usage reads sizes per container and volume", async () => {
	const runtime = new RuntimeClient(fake.socket);
	await runtime.connect();
	const seen: unknown[] = [];
	const collector = new Collector(
		runtime,
		() => {},
		(d) => seen.push(d),
		quiet,
	);
	const disk = await collector.disk();
	expect(disk).toMatchObject({ images: 195_000_000, imagesReclaimable: 5_000_000, volumes: { shop_data: 42_000_000 }, buildCache: 1000 });
	expect(Object.keys(disk!.containers)).toHaveLength(3);
	expect(seen).toHaveLength(1);
});
