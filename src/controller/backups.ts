import type { BackupItem, BackupMode, BackupResult, ContainerSummary, Methods } from "../shared/protocol.ts";
import { audit } from "./db/audit.ts";
import {
	backupInUse,
	createBackup,
	createMove,
	createTask,
	createTransfer,
	duePlans,
	finishBackup,
	finishMove,
	finishTask,
	finishTransfer,
	getBackup,
	getDestination,
	getTransfer,
	handOverStack,
	keptBackups,
	markBackupDeleted,
	setMoveBackup,
	setMoveTarget,
	setNextRun,
	setTransferStack,
	type Backup,
	type Plan,
} from "./db/backups.ts";
import { getHost } from "./db/hosts.ts";
import { createStack, findStack, getStack, getVersion, setDeployed, setDirectory, setMovedTo, type Stack, type StackVersion } from "./db/stacks.ts";
import type { Deployments } from "./deployments.ts";
import type { Hub } from "./hub.ts";
import { LiveJobs } from "./jobs.ts";
import { randomToken } from "./lib/crypto.ts";
import { ApiError } from "./lib/errors.ts";
import { logger } from "./lib/logger.ts";
import { nextRun } from "./lib/schedule.ts";

type User = { id: number | null; ip: string | null };

/** Which backups retention keeps: the newest, then the newest of each of the last N days, weeks and months. */
export function keepSet(backups: { id: number; startedAt: string }[], keep: { daily: number; weekly: number; monthly: number }): Set<number> {
	const sorted = [...backups].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id);
	const kept = new Set<number>();
	if (sorted[0]) kept.add(sorted[0].id);
	const bucket = (count: number, key: (d: Date) => string) => {
		const seen = new Set<string>();
		for (const b of sorted) {
			if (seen.size >= count) break;
			const k = key(new Date(b.startedAt));
			if (seen.has(k)) continue;
			seen.add(k);
			kept.add(b.id);
		}
	};
	const day = (d: Date) => d.toISOString().slice(0, 10);
	const week = (d: Date) => {
		const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
		const dow = t.getUTCDay() || 7;
		t.setUTCDate(t.getUTCDate() + 4 - dow);
		const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
		return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7)}`;
	};
	const month = (d: Date) => d.toISOString().slice(0, 7);
	bucket(keep.daily, day);
	bucket(keep.weekly, week);
	bucket(keep.monthly, month);
	return kept;
}

function stamp(d: Date): string {
	return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

const plain = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "x";

export class Backups {
	readonly jobs: LiveJobs;
	/** Called after every backup, for alerts. */
	onFinished: ((run: { stack: Stack; backupId: number; ok: boolean; error: string | null }) => void) | null = null;

	constructor(
		private readonly hub: Hub,
		private readonly deployments: Deployments,
	) {
		this.jobs = new LiveJobs((topic, data) => hub.publish(topic, data));
	}

	/** What the stack's host offers to back up. */
	async items(stack: Stack): Promise<BackupItem[]> {
		return this.hub.request(stack.hostId, "backup.items", { project: stack.name, directory: stack.directory, file: stack.file }, 30_000);
	}

	private async checkTargetVolumes(hostId: number, items: BackupItem[]): Promise<void> {
		const names = items.filter((item) => item.kind === "volume").map((item) => item.id.slice("volume:".length));
		const { existing } = await this.hub.request(hostId, "backup.volume.check", { names }, 30_000);
		if (existing.length > 0) throw new ApiError(409, "volume_exists", `The target already has these volumes: ${existing.join(", ")}.`);
	}

	private checkDatabaseVolumes(items: BackupItem[], containers: ContainerSummary[]): void {
		for (const dump of items.filter((item) => item.kind === "dump")) {
			const service = dump.id.slice("dump:".length);
			const container = containers.find((item) => item.service === service || item.name === service);
			const dataRoot = dump.engine === "postgres" ? "/var/lib/postgresql" : dump.engine === "mysql" ? "/var/lib/mysql" : "/data/db";
			if (
				!container?.mounts.some(
					(mount) =>
						mount.type === "volume" &&
						mount.name &&
						(mount.destination === dataRoot || mount.destination.startsWith(`${dataRoot}/`) || dataRoot.startsWith(`${mount.destination}/`)),
				)
			)
				throw new ApiError(409, "database", `${dump.label} has no named volume at its data path. Its database files cannot be transferred safely.`);
		}
	}

	private async stackJob(hostId: number, params: Omit<Methods["stack.run"]["params"], "stream">, output: (text: string) => void): Promise<string> {
		let finish!: (error: string | null) => void;
		const done = new Promise<void>((resolve, reject) => {
			finish = (error) => (error ? reject(new Error(error)) : resolve());
		});
		const result = await this.hub.runStack(hostId, params, { data: output, end: finish });
		await done;
		return result.directory;
	}

	private async backupJob<M extends "backup.verify" | "backup.restore">(
		hostId: number,
		method: M,
		params: Omit<Methods[M]["params"], "stream">,
		output: (text: string) => void,
	): Promise<void> {
		let finish!: (error: string | null) => void;
		const done = new Promise<void>((resolve, reject) => {
			finish = (error) => (error ? reject(new Error(error)) : resolve());
		});
		await this.hub.runJob(hostId, method, params, { data: output, end: finish });
		await done;
	}

	async move(source: Stack, targetHostId: number, destinationId: number, user: User): Promise<number> {
		const targetHost = await getHost(targetHostId);
		const destination = await getDestination(destinationId);
		if (!targetHost || !targetHost.enrolled || !destination) throw new ApiError(404, "not_found", "The target host or destination is missing.");
		if (source.adopted || source.deployedVersion === null) throw new ApiError(409, "unsupported", "Deploy a managed stack before transferring it.");
		if (source.hostId === targetHostId) throw new ApiError(400, "same_host", "Choose another host.");
		if (!this.hub.isOnline(source.hostId) || !this.hub.isOnline(targetHostId)) throw new ApiError(409, "offline", "Both hosts must be online.");
		const lockKey = `move:${randomToken(12)}`;
		this.deployments.lock(source.id, lockKey);
		let available: BackupItem[];
		let version: StackVersion;
		let wasRunning: boolean;
		let moveId: number;
		try {
			await Promise.all([this.hub.request(source.hostId, "snapshot.refresh", {}), this.hub.request(targetHostId, "snapshot.refresh", {})]);
			const sourceFacts = this.hub.facts(source.hostId);
			const targetFacts = this.hub.facts(targetHostId);
			if (!sourceFacts || !targetFacts || sourceFacts.runtime !== targetFacts.runtime)
				throw new ApiError(409, "runtime", "Both hosts must use the same container runtime.");
			if (await findStack(targetHostId, source.name)) throw new ApiError(409, "exists", "A stack with this name already exists on the target host.");
			if (this.hub.snapshot(targetHostId)?.containers.some((container) => container.project === source.name))
				throw new ApiError(409, "exists", "A project with this name already runs on the target host.");
			const sourceContainers = this.hub.snapshot(source.hostId)?.containers.filter((container) => container.project === source.name);
			if (!sourceContainers || sourceContainers.length === 0) throw new ApiError(409, "missing", "The source stack has no containers to transfer.");
			if (sourceContainers.some((container) => container.mounts.some((mount) => mount.type === "bind")))
				throw new ApiError(
					409,
					"unsupported",
					"Stacks with bind mounted folders cannot be transferred, because their paths would have to be mapped to the new host.",
				);
			wasRunning = sourceContainers.some((container) => container.state === "running");
			available = await this.items(source);
			if (available.some((item) => item.kind === "bind"))
				throw new ApiError(
					409,
					"unsupported",
					"Stacks with bind mounted folders cannot be transferred, because their paths would have to be mapped to the new host.",
				);
			await this.checkTargetVolumes(targetHostId, available);
			this.checkDatabaseVolumes(available, sourceContainers);
			const saved = await getVersion(source.id, source.deployedVersion);
			if (!saved) throw new ApiError(404, "not_found", "The deployed stack version is missing.");
			version = saved;
			await this.hub.request(targetHostId, "backup.test", { destination: destination.config }, 60_000);
			moveId = await createMove(source.id, targetHostId, destinationId, user.id);
		} catch (err) {
			this.deployments.unlock(source.id, lockKey);
			throw err;
		}
		const key = `move:${moveId}`;
		const job = this.jobs.begin(key);
		const run = async () => {
			let stopAttempted = false;
			let targetStartAttempted = false;
			let targetStackId: number | null = null;
			let transferId: number | null = null;
			try {
				if (wasRunning) {
					stopAttempted = true;
					job.append(`Stopping ${source.name} on the source host\n`);
					await this.stackJob(
						source.hostId,
						{ name: source.name, directory: source.directory, file: source.file, compose: "", env: "", action: "stop" },
						job.append,
					);
				}
				await this.hub.request(source.hostId, "snapshot.refresh", {});
				if (this.hub.snapshot(source.hostId)?.containers.some((container) => container.project === source.name && container.state === "running"))
					throw new Error("A source container is still running after the stop command.");
				job.append("Saving stack files and named volumes while the source is stopped\n");
				const items = available.filter((item) => item.kind !== "dump").map((item) => item.id);
				const backupId = await this.start(source, { destinationId, mode: "stop", items, trigger: "manual", lockOwner: lockKey }, user);
				await setMoveBackup(moveId, backupId);
				await this.jobs.wait(`backup:${backupId}`);
				const backup = await getBackup(backupId);
				if (!backup || backup.status !== "ok") throw new Error(`The backup failed: ${backup?.output ?? "no result"}`);
				await this.hub.request(source.hostId, "snapshot.refresh", {});
				if (this.hub.snapshot(source.hostId)?.containers.some((container) => container.project === source.name && container.state === "running"))
					throw new Error("A source container started during the backup. The transfer was stopped before the target started.");
				job.append(`Backup ${backupId} complete. Restoring it on ${targetHost.name}\n`);
				transferId = await this.transfer(backup, targetHostId, user, lockKey);
				await this.jobs.wait(`transfer:${transferId}`);
				const transfer = await getTransfer(transferId);
				targetStackId = transfer?.targetStackId ?? null;
				if (!transfer || transfer.status !== "ok" || !targetStackId) throw new Error(`The restore failed: ${transfer?.output ?? "no result"}`);
				await setMoveTarget(moveId, targetStackId);
				const target = await getStack(targetStackId);
				if (!target) throw new Error("The target stack was removed.");
				job.append("Starting the target and checking container health\n");
				targetStartAttempted = true;
				await this.stackJob(
					targetHostId,
					{ name: target.name, directory: target.directory, file: target.file, compose: version.compose, env: version.env, action: "deploy" },
					job.append,
				);
				await this.hub.request(targetHostId, "snapshot.refresh", {});
				await this.hub.request(source.hostId, "snapshot.refresh", {});
				if (this.hub.snapshot(source.hostId)?.containers.some((container) => container.project === source.name && container.state === "running"))
					throw new Error("A source container restarted during transfer. The target will be stopped.");
				job.append("Removing the stopped source containers while keeping their volumes\n");
				await this.stackJob(
					source.hostId,
					{ name: source.name, directory: source.directory, file: source.file, compose: "", env: "", action: "down" },
					job.append,
				);
				await setDeployed(source.id, null);
				await setMovedTo(source.id, targetStackId);
				const handed = await handOverStack(source.id, targetStackId);
				job.append(
					handed.plan
						? "The backup plan and update settings now belong to the stack on the new host.\n"
						: "The update settings were copied. This stack had no backup plan, so set one up on the new host.\n",
				);
				job.append("Transfer complete. The source volumes and stack files remain available, and the old copy cannot be started by accident.\n");
				await finishMove(moveId, "ok", job.output());
				await audit({ userId: user.id, hostId: targetHostId, action: "stack.move", target: source.name, ok: true, ip: user.ip });
				job.finish(true);
			} catch (err) {
				job.append(`Transfer failed: ${(err as Error).message}\n`);
				let targetStopped = true;
				if (targetStartAttempted && targetStackId !== null) {
					try {
						const target = await getStack(targetStackId);
						if (target)
							await this.stackJob(
								targetHostId,
								{ name: target.name, directory: target.directory, file: target.file, compose: "", env: "", action: "stop" },
								job.append,
							);
						job.append("Stopped the target containers.\n");
					} catch (stopError) {
						targetStopped = false;
						job.append(`Could not stop the target: ${(stopError as Error).message}. The source remains stopped.\n`);
					}
				}
				if (targetStackId !== null) await setDeployed(targetStackId, null).catch(() => {});
				if (stopAttempted && wasRunning && targetStopped) {
					try {
						await this.stackJob(
							source.hostId,
							{ name: source.name, directory: source.directory, file: source.file, compose: version.compose, env: version.env, action: "deploy" },
							job.append,
						);
						job.append("Restarted the source stack.\n");
					} catch (restartError) {
						job.append(`Could not restart the source: ${(restartError as Error).message}. Start it manually.\n`);
					}
				}
				await finishMove(moveId, "failed", job.output());
				await audit({
					userId: user.id,
					hostId: source.hostId,
					action: "stack.move",
					target: source.name,
					ok: false,
					detail: (err as Error).message,
					ip: user.ip,
				});
				job.finish(false);
			} finally {
				if (targetStackId === null && transferId !== null) targetStackId = (await getTransfer(transferId).catch(() => null))?.targetStackId ?? null;
				if (targetStackId !== null) this.deployments.unlock(targetStackId, lockKey);
				this.deployments.unlock(source.id, lockKey);
				this.hub.publish(`host:${source.hostId}`, JSON.stringify({ type: "changed", topic: `host:${source.hostId}` }));
				this.hub.publish(`host:${targetHostId}`, JSON.stringify({ type: "changed", topic: `host:${targetHostId}` }));
			}
		};
		void run();
		return moveId;
	}

	async start(
		stack: Stack,
		options: { destinationId: number; mode: BackupMode; items: string[] | null; trigger: "schedule" | "manual"; plan?: Plan | null; lockOwner?: string },
		user: User,
	): Promise<number> {
		if (!this.hub.isOnline(stack.hostId)) throw new ApiError(409, "offline", "The agent of this host is offline.");
		const destination = await getDestination(options.destinationId);
		if (!destination) throw new ApiError(404, "not_found", "This backup destination does not exist.");
		const host = await getHost(stack.hostId);
		const available = await this.items(stack);
		const chosen = options.items === null ? available : available.filter((i) => options.items!.includes(i.id));
		if (chosen.length === 0) throw new ApiError(400, "nothing", "Nothing to back up. Choose at least one item.");
		const startedAt = new Date();
		const set = `dockermanager/${plain(host?.name ?? "host")}-${stack.hostId}/${plain(stack.name)}/${stamp(startedAt)}-${randomToken(4).replace(/[^A-Za-z0-9]/g, "x")}`;
		const backupId = await createBackup({
			stackId: stack.id,
			stackVersion: stack.deployedVersion,
			destinationId: destination.id,
			setPath: set,
			trigger: options.trigger,
			mode: options.mode,
			userId: user.id,
		});
		const key = `backup:${backupId}`;
		const owned = options.lockOwner !== undefined && this.deployments.busy(stack.id) === options.lockOwner;
		if (!owned)
			try {
				this.deployments.lock(stack.id, key);
			} catch (err) {
				await finishBackup(backupId, "failed", (err as Error).message);
				throw err;
			}
		const job = this.jobs.begin(key);
		job.append(
			`Backing up ${chosen.length} item(s) of ${stack.name} to ${destination.name}, ${options.mode === "stop" ? "with the containers stopped" : "while the containers run"}\n`,
		);
		let ended = false;
		const end = async (error: string | null, result?: unknown) => {
			if (ended) return;
			ended = true;
			if (!owned) this.deployments.unlock(stack.id, key);
			if (error) job.append(`\n${error}\n`);
			const ok = error === null;
			const summary = (result ?? { items: [], bytes: 0 }) as BackupResult;
			await finishBackup(backupId, ok ? "ok" : "failed", job.output(), summary.items ?? [], summary.bytes ?? 0);
			await audit({
				userId: user.id,
				hostId: stack.hostId,
				action: "backup.run",
				target: `${stack.name} to ${destination.name}`,
				ok,
				detail: error,
				ip: user.ip,
			});
			if (ok && options.plan) await this.prune(stack, options.plan).catch((err: Error) => logger.warn(`Retention for ${stack.name} failed: ${err.message}`));
			this.hub.publish(`host:${stack.hostId}`, JSON.stringify({ type: "changed", topic: `host:${stack.hostId}` }));
			job.finish(ok);
			this.onFinished?.({ stack, backupId, ok, error });
		};
		try {
			await this.hub.runJob(
				stack.hostId,
				"backup.run",
				{ destination: destination.config, key: destination.key, set, project: stack.name, directory: stack.directory, items: chosen, mode: options.mode },
				{ data: job.append, end: (error, result) => void end(error, result) },
			);
		} catch (err) {
			await end((err as Error).message);
		}
		return backupId;
	}

	private async task(backup: Backup, kind: "restore" | "verify", items: string[], user: User): Promise<number> {
		const stack = await getStack(backup.stackId);
		if (!stack) throw new ApiError(404, "not_found", "This stack does not exist.");
		if (!this.hub.isOnline(stack.hostId)) throw new ApiError(409, "offline", "The agent of this host is offline.");
		const destination = await getDestination(backup.destinationId);
		if (!destination) throw new ApiError(404, "not_found", "The destination of this backup was removed.");
		const taskId = await createTask(backup.id, kind, items, user.id);
		const key = `task:${taskId}`;
		try {
			this.deployments.lock(stack.id, key);
		} catch (err) {
			await finishTask(taskId, "failed", (err as Error).message);
			throw err;
		}
		const job = this.jobs.begin(key);
		let ended = false;
		const end = async (error: string | null) => {
			if (ended) return;
			ended = true;
			this.deployments.unlock(stack.id, key);
			if (error) job.append(`\n${error}\n`);
			const ok = error === null;
			await finishTask(taskId, ok ? "ok" : "failed", job.output());
			await audit({
				userId: user.id,
				hostId: stack.hostId,
				action: `backup.${kind}`,
				target: `${stack.name} backup ${backup.id}`,
				ok,
				detail: error,
				ip: user.ip,
			});
			this.hub.publish(`host:${stack.hostId}`, JSON.stringify({ type: "changed", topic: `host:${stack.hostId}` }));
			job.finish(ok);
		};
		const target = { destination: destination.config, key: destination.key, set: backup.setPath };
		const sink = { data: job.append, end: (error: string | null) => void end(error) };
		try {
			if (kind === "restore")
				await this.hub.runJob(stack.hostId, "backup.restore", { ...target, project: stack.name, directory: stack.directory, items }, sink);
			else await this.hub.runJob(stack.hostId, "backup.verify", target, sink);
		} catch (err) {
			await end((err as Error).message);
		}
		return taskId;
	}

	restore(backup: Backup, items: string[], user: User): Promise<number> {
		if (backup.status !== "ok" || backup.deletedAt) throw new ApiError(409, "unusable", "Only a complete backup can be restored.");
		const known = new Set(backup.items.map((i) => i.id));
		const chosen = items.filter((i) => known.has(i));
		if (chosen.length === 0) throw new ApiError(400, "nothing", "Choose at least one item to restore.");
		return this.task(backup, "restore", chosen, user);
	}

	verify(backup: Backup, user: User): Promise<number> {
		if (backup.status !== "ok" || backup.deletedAt) throw new ApiError(409, "unusable", "Only a complete backup can be verified.");
		return this.task(backup, "verify", [], user);
	}

	async transfer(backup: Backup, targetHostId: number, user: User, lockOwner?: string): Promise<number> {
		if (backup.status !== "ok" || backup.deletedAt || backup.mode !== "stop" || backup.stackVersion === null)
			throw new ApiError(409, "unusable", 'Use a complete backup of the deployed version, made with "Stop the containers".');
		const source = await getStack(backup.stackId);
		const targetHost = await getHost(targetHostId);
		const destination = await getDestination(backup.destinationId);
		if (!source || !targetHost || !targetHost.enrolled || !destination)
			throw new ApiError(404, "not_found", "The stack, target host or destination is missing.");
		if (source.adopted) throw new ApiError(409, "unsupported", "Adopted stacks cannot be transferred.");
		if (source.hostId === targetHostId) throw new ApiError(400, "same_host", "Choose another host.");
		if (!this.hub.isOnline(source.hostId) || !this.hub.isOnline(targetHostId)) throw new ApiError(409, "offline", "Both hosts must be online.");
		if (source.deployedVersion !== backup.stackVersion)
			throw new ApiError(409, "changed", "The source stack has changed since this backup. Make a new backup.");
		if (await findStack(targetHostId, source.name)) throw new ApiError(409, "exists", "A stack with this name already exists on the target host.");
		if (this.hub.snapshot(targetHostId)?.containers.some((container) => container.project === source.name))
			throw new ApiError(409, "exists", "A project with this name already runs on the target host.");
		await this.hub.request(source.hostId, "snapshot.refresh", {});
		const sourceContainers = this.hub.snapshot(source.hostId)?.containers.filter((container) => container.project === source.name);
		if (!sourceContainers || sourceContainers.length === 0) throw new ApiError(409, "missing", "The source stack has no containers to transfer.");
		if (sourceContainers.some((container) => container.mounts.some((mount) => mount.type === "bind")))
			throw new ApiError(
				409,
				"unsupported",
				"Stacks with bind mounted folders cannot be transferred, because their paths would have to be mapped to the new host.",
			);
		const available = await this.items(source);
		if (available.some((item) => item.kind === "bind"))
			throw new ApiError(
				409,
				"unsupported",
				"Stacks with bind mounted folders cannot be transferred, because their paths would have to be mapped to the new host.",
			);
		this.checkDatabaseVolumes(available, sourceContainers);
		const saved = new Set(backup.items.map((item) => item.id));
		if (!saved.has("files") || available.some((item) => item.kind === "volume" && !saved.has(item.id)))
			throw new ApiError(409, "incomplete", "This backup is missing stack files or a named volume. Make a backup of everything.");
		if (backup.items.some((item) => item.warning)) throw new ApiError(409, "incomplete", "This backup contains files that changed while being read.");
		const version = await getVersion(source.id, backup.stackVersion);
		if (!version) throw new ApiError(404, "not_found", "The stack version saved with this backup is missing.");
		await this.checkTargetVolumes(targetHostId, backup.items);
		const transferId = await createTransfer(backup.id, targetHostId, user.id);
		const key = `transfer:${transferId}`;
		const job = this.jobs.begin(key);
		const run = async () => {
			let target: Stack | null = null;
			try {
				job.append(`Checking backup access from ${targetHost.name}\n`);
				await this.backupJob(targetHostId, "backup.verify", { destination: destination.config, key: destination.key, set: backup.setPath }, job.append);
				target = await createStack({
					hostId: targetHostId,
					name: source.name,
					directory: null,
					file: source.file,
					adopted: false,
					compose: version.compose,
					env: version.env,
					message: `Transferred from ${source.name} backup ${backup.id}`,
					userId: user.id,
					deployed: false,
				});
				await setTransferStack(transferId, target.id);
				this.deployments.lock(target.id, lockOwner ?? key);
				job.append(`Preparing ${source.name} on ${targetHost.name} without starting containers\n`);
				let directory: string | null = null;
				directory = await this.stackJob(
					targetHostId,
					{ name: source.name, directory: null, file: source.file, compose: version.compose, env: version.env, action: "prepare" },
					job.append,
				);
				if (!directory) throw new Error("The target did not return its stack folder.");
				await setDirectory(target.id, directory);
				const volumes = backup.items.filter((item) => item.kind === "volume").map((item) => item.id);
				const targetItems = await this.items({ ...target, directory });
				const targetVolumes = new Set(targetItems.filter((item) => item.kind === "volume").map((item) => item.id));
				if (
					targetItems.some((item) => item.kind === "bind") ||
					volumes.some((id) => !targetVolumes.has(id)) ||
					[...targetVolumes].some((id) => !volumes.includes(id))
				)
					throw new Error("The target mounts differ from the backup. Check named volumes and bind mounts before starting it.");
				if (volumes.length > 0) {
					job.append(`Restoring ${volumes.length} named volume(s)\n`);
					await this.backupJob(
						targetHostId,
						"backup.restore",
						{ destination: destination.config, key: destination.key, set: backup.setPath, project: source.name, directory, items: volumes },
						job.append,
					);
				}
				await setDeployed(target.id, 1);
				await this.hub.request(targetHostId, "snapshot.refresh", {});
				job.append("Transfer complete. The target containers are stopped. Review the stack and start it when ready.\n");
				await finishTransfer(transferId, "ok", job.output());
				await audit({ userId: user.id, hostId: targetHostId, action: "backup.transfer", target: source.name, ok: true, ip: user.ip });
				job.finish(true);
			} catch (err) {
				job.append(`Transfer failed: ${(err as Error).message}\n`);
				await finishTransfer(transferId, "failed", job.output());
				await audit({
					userId: user.id,
					hostId: targetHostId,
					action: "backup.transfer",
					target: source.name,
					ok: false,
					detail: (err as Error).message,
					ip: user.ip,
				});
				job.finish(false);
			} finally {
				if (target && lockOwner === undefined) this.deployments.unlock(target.id, key);
				this.hub.publish(`host:${targetHostId}`, JSON.stringify({ type: "changed", topic: `host:${targetHostId}` }));
			}
		};
		void run();
		return transferId;
	}

	async remove(backup: Backup, user: User): Promise<void> {
		if (await backupInUse(backup.id)) throw new ApiError(409, "busy", "This backup is being transferred. Wait for the transfer to finish.");
		const stack = await getStack(backup.stackId);
		const destination = await getDestination(backup.destinationId);
		if (stack && destination && backup.status !== "running") {
			await this.hub.request(stack.hostId, "backup.delete", { destination: destination.config, set: backup.setPath }, 120_000);
		}
		await markBackupDeleted(backup.id);
		await audit({
			userId: user.id,
			hostId: stack?.hostId ?? null,
			action: "backup.delete",
			target: `${stack?.name ?? "stack"} backup ${backup.id}`,
			ip: user.ip,
		});
	}

	/** Deletes backups retention no longer keeps. Only complete backups at the plan's destination count. */
	async prune(stack: Stack, plan: Plan): Promise<number> {
		const list = await keptBackups(stack.id, plan.destinationId);
		const keep = keepSet(list, { daily: plan.keepDaily, weekly: plan.keepWeekly, monthly: plan.keepMonthly });
		let removed = 0;
		for (const b of list) {
			if (keep.has(b.id)) continue;
			await this.remove(b, { id: null, ip: null });
			removed++;
		}
		return removed;
	}

	/** Starts plans that are due. A host that is offline or busy is tried again on the next tick. */
	async tick(now = new Date()): Promise<number> {
		let started = 0;
		for (const plan of await duePlans(now)) {
			const stack = await getStack(plan.stackId);
			if (!stack) continue;
			if (!this.hub.isOnline(stack.hostId) || this.deployments.busy(stack.id)) continue;
			await setNextRun(stack.id, nextRun(plan.schedule, now));
			try {
				await this.start(stack, { destinationId: plan.destinationId, mode: plan.mode, items: plan.items, trigger: "schedule", plan }, { id: null, ip: null });
				started++;
			} catch (err) {
				logger.warn(`Scheduled backup of ${stack.name} did not start: ${(err as Error).message}`);
			}
		}
		return started;
	}
}
