import { expect, test } from "bun:test";
import { Backups } from "../src/controller/backups.ts";
import {
	createBackup,
	createDestination,
	createMove,
	finishBackup,
	finishMove,
	getBackup,
	getMove,
	getPlan,
	savePlan,
	setMoveBackup,
} from "../src/controller/db/backups.ts";
import { saveServiceSetting, serviceSettings } from "../src/controller/db/updates.ts";
import { createHost, enrollHost } from "../src/controller/db/hosts.ts";
import { createStack, getStack } from "../src/controller/db/stacks.ts";
import { Deployments } from "../src/controller/deployments.ts";
import type { Hub } from "../src/controller/hub.ts";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
	const end = Date.now() + 5000;
	for (;;) {
		const value = await read();
		if (ready(value)) return value;
		if (Date.now() > end) throw new Error("Transfer did not finish.");
		await Bun.sleep(10);
	}
}

async function setup(
	options: {
		failTargetStart?: boolean;
		failSourceDown?: boolean;
		databaseVolume?: boolean;
		sourceBindMount?: boolean;
		sourceRestartsDuringBackup?: boolean;
		targetVolumeMismatch?: boolean;
		targetVolumeExists?: boolean;
	} = {},
) {
	const name = `transfer_${Math.random().toString(36).slice(2, 10)}`;
	const sourceHost = await createHost(`${name}-source`);
	const targetHost = await createHost(`${name}-target`);
	await enrollHost(sourceHost.token, `${name}-source`);
	await enrollHost(targetHost.token, `${name}-target`);
	const source = await createStack({
		hostId: sourceHost.host.id,
		name,
		directory: `/tmp/${name}`,
		file: "compose.yaml",
		adopted: false,
		compose: "services:\n  web:\n    image: nginx\n    volumes:\n      - data:/data\nvolumes:\n  data:\n",
		env: "TOKEN=example\n",
		message: null,
		userId: null,
		deployed: true,
	});
	const destinationId = await createDestination(`${name}-store`, { kind: "local", path: "/tmp/shared" }, "test-key");
	const events: string[] = [];
	const states = new Map([
		[sourceHost.host.id, "running"],
		[targetHost.host.id, "none"],
	]);
	const items = [
		{ id: "files", kind: "files", label: "Stack files" },
		{ id: `volume:${name}_data`, kind: "volume", label: "Volume data" },
		{ id: "dump:db", kind: "dump", label: "Database dump", engine: "postgres" },
	];
	const hub = {
		isOnline: () => true,
		facts: () => ({ runtime: "docker" }),
		snapshot: (hostId: number) => ({
			containers:
				hostId === sourceHost.host.id
					? [
							{
								project: name,
								service: "db",
								name: `${name}-db-1`,
								state: states.get(hostId),
								mounts: [
									...(options.databaseVolume === false ? [] : [{ type: "volume", name: `${name}_data`, destination: "/var/lib/postgresql/data" }]),
									...(options.sourceBindMount ? [{ type: "bind", source: "/etc/project", destination: "/config" }] : []),
								],
							},
						]
					: [],
		}),
		request: async (hostId: number, method: string) => {
			if (method === "backup.items")
				return hostId === targetHost.host.id && options.targetVolumeMismatch ? [items[0], { ...items[1], id: "volume:unexpected" }] : items;
			if (method === "backup.volume.check") return { existing: hostId === targetHost.host.id && options.targetVolumeExists ? [`${name}_data`] : [] };
			return { ok: true, note: "ok" };
		},
		runStack: async (hostId: number, params: { action: string }, sink: { end(error: string | null): void }) => {
			const side = hostId === sourceHost.host.id ? "source" : "target";
			events.push(`${side}:${params.action}`);
			if (side === "target" && params.action === "deploy" && options.failTargetStart) sink.end("Target health check failed");
			else if (side === "source" && params.action === "down" && options.failSourceDown) sink.end("Source cleanup failed");
			else {
				if (params.action === "stop") states.set(hostId, "exited");
				if (params.action === "down") states.set(hostId, "none");
				if (params.action === "deploy") states.set(hostId, "running");
				sink.end(null);
			}
			return { directory: `/tmp/${name}-target` };
		},
		runJob: async (_hostId: number, method: string, _params: unknown, sink: { end(error: string | null, result?: unknown): void }) => {
			events.push(method);
			if (method === "backup.run") {
				if (options.sourceRestartsDuringBackup) states.set(sourceHost.host.id, "running");
				sink.end(null, {
					items: items.slice(0, 2).map((item) => ({ ...item, file: `${item.id}.dmbak`, bytes: 10, sha256: "hash" })),
					bytes: 20,
				});
			} else sink.end(null);
		},
		publish: () => {},
	} as unknown as Hub;
	const deployments = new Deployments(hub);
	const backups = new Backups(hub, deployments);
	return { backups, deployments, source, sourceHostId: sourceHost.host.id, targetHostId: targetHost.host.id, destinationId, events, states };
}

test("a transfer stops the source, copies volumes and starts the target", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup();
	const id = await backups.move(source, targetHostId, destinationId, { id: null, ip: null });
	const move = await until(
		() => getMove(id),
		(value) => value !== null && value.status !== "running",
	);
	expect(move?.status).toBe("ok");
	expect(move?.backupId).toBeNumber();
	expect(move?.targetStackId).toBeNumber();
	expect(events).toEqual(["source:stop", "backup.run", "backup.verify", "target:prepare", "backup.restore", "target:deploy", "source:down"]);
	expect(states.get(source.hostId)).toBe("none");
	expect(states.get(targetHostId)).toBe("running");
	expect((await getStack(source.id))?.deployedVersion).toBeNull();
});

test("after a transfer the backup plan follows the stack and the old copy cannot start", async () => {
	const { backups, deployments, source, targetHostId, destinationId } = await setup();
	await savePlan({
		stackId: source.id,
		destinationId,
		schedule: "0 3 * * *",
		mode: "stop",
		items: null,
		keepDaily: 7,
		keepWeekly: 4,
		keepMonthly: 6,
		enabled: true,
		nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
	});
	await saveServiceSetting(source.id, "web", { policy: "patch", auto: "patch" });
	const id = await backups.move(source, targetHostId, destinationId, { id: null, ip: null });
	const move = await until(
		() => getMove(id),
		(value) => value !== null && value.status !== "running",
	);
	expect(move?.status).toBe("ok");
	const targetId = move!.targetStackId!;
	expect(await getPlan(source.id)).toBeNull();
	expect(await getPlan(targetId)).toMatchObject({ schedule: "0 3 * * *", keepDaily: 7, enabled: true });
	expect((await serviceSettings(targetId)).get("web")).toEqual({ policy: "patch", auto: "patch" });
	expect(move?.output).toContain("The backup plan and update settings now belong to the stack on the new host.");
	const old = (await getStack(source.id))!;
	expect(old.movedTo).toBe(targetId);
	for (const action of ["deploy", "start", "restart"] as const)
		await expect(deployments.start(old, action, { id: null, ip: null })).rejects.toThrow("transferred to another host");
	await expect(backups.move(old, targetHostId, destinationId, { id: null, ip: null })).rejects.toThrow("Deploy a managed stack");
});

test("a failed target start stops the target and restarts the source", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup({ failTargetStart: true });
	const id = await backups.move(source, targetHostId, destinationId, { id: null, ip: null });
	const move = await until(
		() => getMove(id),
		(value) => value !== null && value.status !== "running",
	);
	expect(move?.status).toBe("failed");
	expect(events.slice(-3)).toEqual(["target:deploy", "target:stop", "source:deploy"]);
	expect(states.get(source.hostId)).toBe("running");
	expect(states.get(targetHostId)).toBe("exited");
});

test("a failed source cleanup stops the target and restarts the source", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup({ failSourceDown: true });
	const id = await backups.move(source, targetHostId, destinationId, { id: null, ip: null });
	const move = await until(
		() => getMove(id),
		(value) => value !== null && value.status !== "running",
	);
	expect(move?.status).toBe("failed");
	expect(events.slice(-4)).toEqual(["target:deploy", "source:down", "target:stop", "source:deploy"]);
	expect(states.get(source.hostId)).toBe("running");
	expect(states.get(targetHostId)).toBe("exited");
});

test("a database without a named volume is refused before stopping the source", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup({ databaseVolume: false });
	await expect(backups.move(source, targetHostId, destinationId, { id: null, ip: null })).rejects.toThrow("no named volume at its data path");
	expect(events).toEqual([]);
	expect(states.get(source.hostId)).toBe("running");
});

test("a completed backup cannot transfer a database stored outside named volumes", async () => {
	const { backups, source, targetHostId, destinationId, events } = await setup({ databaseVolume: false });
	const backupId = await createBackup({
		stackId: source.id,
		stackVersion: 1,
		destinationId,
		setPath: `test/${source.name}`,
		trigger: "manual",
		mode: "stop",
		userId: null,
	});
	await finishBackup(backupId, "ok", "complete", [{ id: "files", kind: "files", label: "Stack files", file: "files.dmbak", bytes: 10, sha256: "hash" }]);
	await expect(backups.transfer((await getBackup(backupId))!, targetHostId, { id: null, ip: null })).rejects.toThrow("no named volume at its data path");
	expect(events).toEqual([]);
});

test("a target volume collision is refused before stopping the source", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup({ targetVolumeExists: true });
	await expect(backups.move(source, targetHostId, destinationId, { id: null, ip: null })).rejects.toThrow("target already has these volumes");
	expect(events).toEqual([]);
	expect(states.get(source.hostId)).toBe("running");
});

test("a bind mount is refused before stopping the source", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup({ sourceBindMount: true });
	await expect(backups.move(source, targetHostId, destinationId, { id: null, ip: null })).rejects.toThrow("bind mounted folders cannot be transferred");
	expect(events).toEqual([]);
	expect(states.get(source.hostId)).toBe("running");
});

test("a source restart during backup stops the transfer before starting the target", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup({ sourceRestartsDuringBackup: true });
	const id = await backups.move(source, targetHostId, destinationId, { id: null, ip: null });
	const move = await until(
		() => getMove(id),
		(value) => value !== null && value.status !== "running",
	);
	expect(move?.status).toBe("failed");
	expect(events).not.toContain("target:deploy");
	expect(states.get(source.hostId)).toBe("running");
});

test("a target volume mismatch prevents restore and restarts the source", async () => {
	const { backups, source, targetHostId, destinationId, events, states } = await setup({ targetVolumeMismatch: true });
	const id = await backups.move(source, targetHostId, destinationId, { id: null, ip: null });
	const move = await until(
		() => getMove(id),
		(value) => value !== null && value.status !== "running",
	);
	expect(move?.status).toBe("failed");
	expect(events).toContain("target:prepare");
	expect(events).not.toContain("backup.restore");
	expect(events.at(-1)).toBe("source:deploy");
	expect(states.get(source.hostId)).toBe("running");
});

test("a backup cannot be deleted during a transfer", async () => {
	const { backups, source, targetHostId, destinationId } = await setup();
	const backupId = await createBackup({
		stackId: source.id,
		stackVersion: 1,
		destinationId,
		setPath: `test/${source.name}`,
		trigger: "manual",
		mode: "stop",
		userId: null,
	});
	await finishBackup(backupId, "ok", "complete");
	const moveId = await createMove(source.id, targetHostId, destinationId, null);
	await setMoveBackup(moveId, backupId);
	await expect(backups.remove((await getBackup(backupId))!, { id: null, ip: null })).rejects.toThrow("being transferred");
	await finishMove(moveId, "failed", "test complete");
});
