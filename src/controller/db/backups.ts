import type { BackupMode, BackupResultItem, DestinationConfig } from "../../shared/protocol.ts";
import { decrypt, encrypt } from "../lib/secrets.ts";
import { iso, sql, timestamp } from "./index.ts";

export type JobStatus = "running" | "ok" | "failed" | "interrupted";

export interface Destination {
	id: number;
	name: string;
	kind: DestinationConfig["kind"];
	createdAt: string;
}

export interface Plan {
	stackId: number;
	destinationId: number;
	schedule: string;
	mode: BackupMode;
	/** Chosen item ids, or null for everything the stack has. */
	items: string[] | null;
	keepDaily: number;
	keepWeekly: number;
	keepMonthly: number;
	enabled: boolean;
	nextRunAt: string | null;
}

export interface Backup {
	id: number;
	stackId: number;
	stackVersion: number | null;
	destinationId: number;
	setPath: string;
	status: JobStatus;
	trigger: "schedule" | "manual";
	mode: BackupMode;
	bytes: number;
	items: BackupResultItem[];
	output: string;
	username: string | null;
	startedAt: string;
	finishedAt: string | null;
	deletedAt: string | null;
}

export interface Transfer {
	id: number;
	backupId: number;
	targetHostId: number;
	targetStackId: number | null;
	status: JobStatus;
	output: string;
	username: string | null;
	startedAt: string;
	finishedAt: string | null;
}

export interface StackMove {
	id: number;
	sourceStackId: number;
	targetHostId: number;
	destinationId: number;
	backupId: number | null;
	targetStackId: number | null;
	status: JobStatus;
	output: string;
	startedAt: string;
	finishedAt: string | null;
}

export interface BackupTask {
	id: number;
	backupId: number;
	kind: "restore" | "verify";
	status: JobStatus;
	items: string[];
	output: string;
	username: string | null;
	startedAt: string;
	finishedAt: string | null;
}

const json = <T>(value: unknown, fallback: T): T => {
	if (typeof value !== "string" || value === "") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
};

export async function listDestinations(): Promise<Destination[]> {
	const rows = await sql`SELECT id, name, kind, created_at FROM backup_destinations ORDER BY name`;
	return rows.map((r: any) => ({ id: Number(r.id), name: r.name, kind: r.kind, createdAt: iso(r.created_at) }));
}

export async function getDestination(id: number): Promise<(Destination & { config: DestinationConfig; key: string }) | null> {
	const [r] = await sql`SELECT id, name, kind, config_secret, key_secret, created_at FROM backup_destinations WHERE id = ${id}`;
	if (!r) return null;
	return {
		id: Number(r.id),
		name: r.name,
		kind: r.kind,
		createdAt: iso(r.created_at),
		config: JSON.parse(decrypt(r.config_secret)),
		key: decrypt(r.key_secret),
	};
}

export async function createDestination(name: string, config: DestinationConfig, key: string): Promise<number> {
	const [r] = await sql`
		INSERT INTO backup_destinations (name, kind, config_secret, key_secret)
		VALUES (${name}, ${config.kind}, ${encrypt(JSON.stringify(config))}, ${encrypt(key)})
		RETURNING id`;
	return Number(r.id);
}

/** The key never changes, or older backups could no longer be read. */
export async function updateDestination(id: number, name: string, config: DestinationConfig): Promise<void> {
	await sql`UPDATE backup_destinations SET name = ${name}, kind = ${config.kind}, config_secret = ${encrypt(JSON.stringify(config))} WHERE id = ${id}`;
}

export async function destinationInUse(id: number): Promise<{ plans: number; backups: number }> {
	const [p] = await sql`SELECT COUNT(*) AS n FROM backup_plans WHERE destination_id = ${id}`;
	const [b] = await sql`SELECT COUNT(*) AS n FROM backups WHERE destination_id = ${id} AND deleted_at IS NULL`;
	return { plans: Number(p.n), backups: Number(b.n) };
}

export async function deleteDestination(id: number): Promise<void> {
	await sql`DELETE FROM backups WHERE destination_id = ${id} AND deleted_at IS NOT NULL`;
	await sql`DELETE FROM backup_destinations WHERE id = ${id}`;
}

function toPlan(r: any): Plan {
	return {
		stackId: Number(r.stack_id),
		destinationId: Number(r.destination_id),
		schedule: r.schedule,
		mode: r.mode,
		items: r.items ? json<string[] | null>(r.items, null) : null,
		keepDaily: Number(r.keep_daily),
		keepWeekly: Number(r.keep_weekly),
		keepMonthly: Number(r.keep_monthly),
		enabled: Number(r.enabled) === 1,
		nextRunAt: r.next_run_at ? iso(r.next_run_at) : null,
	};
}

const planColumns = () => sql`stack_id, destination_id, schedule, mode, items, keep_daily, keep_weekly, keep_monthly, enabled, next_run_at`;

export async function getPlan(stackId: number): Promise<Plan | null> {
	const [r] = await sql`SELECT ${planColumns()} FROM backup_plans WHERE stack_id = ${stackId}`;
	return r ? toPlan(r) : null;
}

export async function listPlans(): Promise<Plan[]> {
	const rows = await sql`SELECT ${planColumns()} FROM backup_plans ORDER BY stack_id`;
	return rows.map(toPlan);
}

/** After a transfer: the backup plan follows the stack to its new host, and the update settings are copied. */
export async function handOverStack(fromStackId: number, toStackId: number): Promise<{ plan: boolean }> {
	const moved = await sql`UPDATE backup_plans SET stack_id = ${toStackId} WHERE stack_id = ${fromStackId} RETURNING stack_id`;
	await sql`
		INSERT INTO stack_services (stack_id, service, policy, auto)
		SELECT ${toStackId}, service, policy, auto FROM stack_services WHERE stack_id = ${fromStackId}
		ON CONFLICT (stack_id, service) DO NOTHING`;
	return { plan: moved.length > 0 };
}

export async function duePlans(now: Date): Promise<Plan[]> {
	const rows = await sql`SELECT ${planColumns()} FROM backup_plans WHERE enabled = 1 AND next_run_at <= ${timestamp(now)} ORDER BY next_run_at`;
	return rows.map(toPlan);
}

export async function savePlan(plan: Plan): Promise<void> {
	const items = plan.items === null ? null : JSON.stringify(plan.items);
	const next = plan.nextRunAt ? timestamp(new Date(plan.nextRunAt)) : null;
	await sql`
		INSERT INTO backup_plans (stack_id, destination_id, schedule, mode, items, keep_daily, keep_weekly, keep_monthly, enabled, next_run_at)
		VALUES (${plan.stackId}, ${plan.destinationId}, ${plan.schedule}, ${plan.mode}, ${items}, ${plan.keepDaily}, ${plan.keepWeekly}, ${plan.keepMonthly}, ${plan.enabled ? 1 : 0}, ${next})
		ON CONFLICT (stack_id) DO UPDATE SET destination_id = excluded.destination_id, schedule = excluded.schedule, mode = excluded.mode, items = excluded.items,
			keep_daily = excluded.keep_daily, keep_weekly = excluded.keep_weekly, keep_monthly = excluded.keep_monthly, enabled = excluded.enabled, next_run_at = excluded.next_run_at`;
}

export async function setNextRun(stackId: number, at: Date | null): Promise<void> {
	await sql`UPDATE backup_plans SET next_run_at = ${at ? timestamp(at) : null} WHERE stack_id = ${stackId}`;
}

export async function deletePlan(stackId: number): Promise<void> {
	await sql`DELETE FROM backup_plans WHERE stack_id = ${stackId}`;
}

function toBackup(r: any): Backup {
	return {
		id: Number(r.id),
		stackId: Number(r.stack_id),
		stackVersion: r.stack_version === null ? null : Number(r.stack_version),
		destinationId: Number(r.destination_id),
		setPath: r.set_path,
		status: r.status,
		trigger: r.trigger,
		mode: r.mode,
		bytes: Number(r.bytes),
		items: json<BackupResultItem[]>(r.items, []),
		output: r.output ?? "",
		username: r.username ?? null,
		startedAt: iso(r.started_at),
		finishedAt: r.finished_at ? iso(r.finished_at) : null,
		deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
	};
}

const backupColumns = () =>
	sql`b.id, b.stack_id, b.stack_version, b.destination_id, b.set_path, b.status, b.trigger, b.mode, b.bytes, b.items, b.output, u.username, b.started_at, b.finished_at, b.deleted_at`;

export async function createBackup(input: {
	stackId: number;
	stackVersion: number | null;
	destinationId: number;
	setPath: string;
	trigger: "schedule" | "manual";
	mode: BackupMode;
	userId: number | null;
}): Promise<number> {
	const [r] = await sql`
		INSERT INTO backups (stack_id, stack_version, destination_id, set_path, status, trigger, mode, user_id)
		VALUES (${input.stackId}, ${input.stackVersion}, ${input.destinationId}, ${input.setPath}, 'running', ${input.trigger}, ${input.mode}, ${input.userId})
		RETURNING id`;
	return Number(r.id);
}

export async function finishBackup(
	id: number,
	status: Exclude<JobStatus, "running">,
	output: string,
	items: BackupResultItem[] = [],
	bytes = 0,
): Promise<void> {
	await sql`UPDATE backups SET status = ${status}, output = ${output}, items = ${JSON.stringify(items)}, bytes = ${bytes}, finished_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function markBackupDeleted(id: number): Promise<void> {
	await sql`UPDATE backups SET deleted_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function getBackup(id: number): Promise<Backup | null> {
	const [r] = await sql`SELECT ${backupColumns()} FROM backups b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ${id}`;
	return r ? toBackup(r) : null;
}

export async function listBackups(stackId: number, limit = 50): Promise<Backup[]> {
	const rows = await sql`
		SELECT ${backupColumns()} FROM backups b LEFT JOIN users u ON u.id = b.user_id
		WHERE b.stack_id = ${stackId} AND b.deleted_at IS NULL
		ORDER BY b.id DESC LIMIT ${limit}`;
	return rows.map(toBackup);
}

export async function lastBackups(): Promise<Map<number, Backup>> {
	const rows = await sql`
		SELECT ${backupColumns()} FROM backups b LEFT JOIN users u ON u.id = b.user_id
		WHERE b.id IN (SELECT MAX(id) FROM backups WHERE deleted_at IS NULL GROUP BY stack_id)`;
	return new Map(rows.map((r: any) => [Number(r.stack_id), toBackup(r)]));
}

/** Successful backups at one destination, newest first, for retention. */
export async function keptBackups(stackId: number, destinationId: number): Promise<Backup[]> {
	const rows = await sql`
		SELECT ${backupColumns()} FROM backups b LEFT JOIN users u ON u.id = b.user_id
		WHERE b.stack_id = ${stackId} AND b.destination_id = ${destinationId} AND b.status = 'ok' AND b.deleted_at IS NULL
		ORDER BY b.started_at DESC, b.id DESC`;
	return rows.map(toBackup);
}

export async function createTask(backupId: number, kind: "restore" | "verify", items: string[], userId: number | null): Promise<number> {
	const [r] = await sql`
		INSERT INTO backup_tasks (backup_id, kind, status, items, user_id) VALUES (${backupId}, ${kind}, 'running', ${JSON.stringify(items)}, ${userId})
		RETURNING id`;
	return Number(r.id);
}

export async function finishTask(id: number, status: Exclude<JobStatus, "running">, output: string): Promise<void> {
	await sql`UPDATE backup_tasks SET status = ${status}, output = ${output}, finished_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function getTask(id: number): Promise<BackupTask | null> {
	const [r] = await sql`
		SELECT t.id, t.backup_id, t.kind, t.status, t.items, t.output, u.username, t.started_at, t.finished_at
		FROM backup_tasks t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ${id}`;
	if (!r) return null;
	return {
		id: Number(r.id),
		backupId: Number(r.backup_id),
		kind: r.kind,
		status: r.status,
		items: json<string[]>(r.items, []),
		output: r.output ?? "",
		username: r.username ?? null,
		startedAt: iso(r.started_at),
		finishedAt: r.finished_at ? iso(r.finished_at) : null,
	};
}

export async function listTasks(backupId: number): Promise<BackupTask[]> {
	const rows = await sql`SELECT id FROM backup_tasks WHERE backup_id = ${backupId} ORDER BY id DESC LIMIT 20`;
	return (await Promise.all(rows.map((r: any) => getTask(Number(r.id))))).filter((t): t is BackupTask => t !== null);
}

export async function createTransfer(backupId: number, targetHostId: number, userId: number | null): Promise<number> {
	const [r] =
		await sql`INSERT INTO backup_transfers (backup_id, target_host_id, status, user_id) VALUES (${backupId}, ${targetHostId}, 'running', ${userId}) RETURNING id`;
	return Number(r.id);
}

export async function setTransferStack(id: number, stackId: number): Promise<void> {
	await sql`UPDATE backup_transfers SET target_stack_id = ${stackId} WHERE id = ${id}`;
}

export async function finishTransfer(id: number, status: Exclude<JobStatus, "running">, output: string): Promise<void> {
	await sql`UPDATE backup_transfers SET status = ${status}, output = ${output}, finished_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function getTransfer(id: number): Promise<Transfer | null> {
	const [r] = await sql`
		SELECT t.id, t.backup_id, t.target_host_id, t.target_stack_id, t.status, t.output, u.username, t.started_at, t.finished_at
		FROM backup_transfers t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ${id}`;
	return r
		? {
				id: Number(r.id),
				backupId: Number(r.backup_id),
				targetHostId: Number(r.target_host_id),
				targetStackId: r.target_stack_id === null ? null : Number(r.target_stack_id),
				status: r.status,
				output: r.output ?? "",
				username: r.username ?? null,
				startedAt: iso(r.started_at),
				finishedAt: r.finished_at ? iso(r.finished_at) : null,
			}
		: null;
}

export async function listTransfers(backupId: number): Promise<Transfer[]> {
	const rows = await sql`SELECT id FROM backup_transfers WHERE backup_id = ${backupId} ORDER BY id DESC LIMIT 20`;
	return (await Promise.all(rows.map((r: any) => getTransfer(Number(r.id))))).filter((t): t is Transfer => t !== null);
}

export async function backupInUse(backupId: number): Promise<boolean> {
	const [row] = await sql`
		SELECT id FROM backup_transfers WHERE backup_id = ${backupId} AND status = 'running'
		UNION ALL
		SELECT id FROM stack_moves WHERE backup_id = ${backupId} AND status = 'running'
		LIMIT 1`;
	return row !== undefined;
}

export async function createMove(sourceStackId: number, targetHostId: number, destinationId: number, userId: number | null): Promise<number> {
	const [r] = await sql`
		INSERT INTO stack_moves (source_stack_id, target_host_id, destination_id, status, user_id)
		VALUES (${sourceStackId}, ${targetHostId}, ${destinationId}, 'running', ${userId}) RETURNING id`;
	return Number(r.id);
}

export async function setMoveBackup(id: number, backupId: number): Promise<void> {
	await sql`UPDATE stack_moves SET backup_id = ${backupId} WHERE id = ${id}`;
}

export async function setMoveTarget(id: number, stackId: number): Promise<void> {
	await sql`UPDATE stack_moves SET target_stack_id = ${stackId} WHERE id = ${id}`;
}

export async function finishMove(id: number, status: Exclude<JobStatus, "running">, output: string): Promise<void> {
	await sql`UPDATE stack_moves SET status = ${status}, output = ${output}, finished_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function getMove(id: number): Promise<StackMove | null> {
	const [r] =
		await sql`SELECT id, source_stack_id, target_host_id, destination_id, backup_id, target_stack_id, status, output, started_at, finished_at FROM stack_moves WHERE id = ${id}`;
	return r
		? {
				id: Number(r.id),
				sourceStackId: Number(r.source_stack_id),
				targetHostId: Number(r.target_host_id),
				destinationId: Number(r.destination_id),
				backupId: r.backup_id === null ? null : Number(r.backup_id),
				targetStackId: r.target_stack_id === null ? null : Number(r.target_stack_id),
				status: r.status,
				output: r.output ?? "",
				startedAt: iso(r.started_at),
				finishedAt: r.finished_at ? iso(r.finished_at) : null,
			}
		: null;
}

export async function listMoves(sourceStackId: number): Promise<StackMove[]> {
	const rows = await sql`SELECT id FROM stack_moves WHERE source_stack_id = ${sourceStackId} ORDER BY id DESC LIMIT 20`;
	return (await Promise.all(rows.map((r: any) => getMove(Number(r.id))))).filter((move): move is StackMove => move !== null);
}

export async function interruptRunningBackups(): Promise<number> {
	const now = timestamp(new Date());
	const a = await sql`UPDATE backups SET status = 'interrupted', finished_at = ${now} WHERE status = 'running' RETURNING id`;
	const b = await sql`UPDATE backup_tasks SET status = 'interrupted', finished_at = ${now} WHERE status = 'running' RETURNING id`;
	const c = await sql`UPDATE backup_transfers SET status = 'interrupted', finished_at = ${now} WHERE status = 'running' RETURNING id`;
	const d = await sql`UPDATE stack_moves SET status = 'interrupted', finished_at = ${now} WHERE status = 'running' RETURNING id`;
	return a.length + b.length + c.length + d.length;
}
