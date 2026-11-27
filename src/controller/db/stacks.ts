import { decrypt, encrypt } from "../lib/secrets.ts";
import { iso, sql, timestamp, withWriteLock } from "./index.ts";

export interface Stack {
	id: number;
	hostId: number;
	name: string;
	/** Where the files live on the host. Null until the first deploy picks the agent's default folder. */
	directory: string | null;
	file: string;
	adopted: boolean;
	currentVersion: number;
	deployedVersion: number | null;
	/** The stack this one was transferred to. Starting the old copy is refused while this is set. */
	movedTo: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface StackVersion {
	number: number;
	compose: string;
	env: string;
	message: string | null;
	username: string | null;
	createdAt: string;
}

export type DeployAction = "deploy" | "upgrade" | "start" | "stop" | "restart" | "down" | "pull";
export const DEPLOY_ACTIONS: readonly DeployAction[] = ["deploy", "start", "stop", "restart", "down", "pull"];
export type DeployStatus = "running" | "ok" | "failed" | "interrupted";

export interface Deploy {
	id: number;
	stackId: number;
	version: number | null;
	action: DeployAction;
	status: DeployStatus;
	output: string;
	username: string | null;
	startedAt: string;
	finishedAt: string | null;
}

function toStack(row: any): Stack {
	return {
		id: Number(row.id),
		hostId: Number(row.host_id),
		name: row.name,
		directory: row.directory ?? null,
		file: row.file,
		adopted: Number(row.adopted) === 1,
		currentVersion: Number(row.current_version),
		deployedVersion: row.deployed_version === null ? null : Number(row.deployed_version),
		movedTo: row.moved_to === null || row.moved_to === undefined ? null : Number(row.moved_to),
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

const stackColumns = () => sql`id, host_id, name, directory, file, adopted, current_version, deployed_version, moved_to, created_at, updated_at`;

export async function listStacks(hostId: number): Promise<Stack[]> {
	const rows = await sql`SELECT ${stackColumns()} FROM stacks WHERE host_id = ${hostId} ORDER BY name`;
	return rows.map(toStack);
}

export async function stackIndex(): Promise<Map<number, Map<string, number>>> {
	const rows = await sql`SELECT id, host_id, name FROM stacks`;
	const out = new Map<number, Map<string, number>>();
	for (const row of rows as { id: number; host_id: number; name: string }[]) {
		const hostId = Number(row.host_id);
		if (!out.has(hostId)) out.set(hostId, new Map());
		out.get(hostId)!.set(row.name, Number(row.id));
	}
	return out;
}

export async function listAllStacks(): Promise<Stack[]> {
	const rows = await sql`SELECT ${stackColumns()} FROM stacks ORDER BY host_id, name`;
	return rows.map(toStack);
}

export async function getStack(id: number): Promise<Stack | null> {
	const [row] = await sql`SELECT ${stackColumns()} FROM stacks WHERE id = ${id}`;
	return row ? toStack(row) : null;
}

export async function setMovedTo(stackId: number, targetId: number | null): Promise<void> {
	await sql`UPDATE stacks SET moved_to = ${targetId}, updated_at = ${timestamp(new Date())} WHERE id = ${stackId}`;
}

export async function findStack(hostId: number, name: string): Promise<Stack | null> {
	const [row] = await sql`SELECT ${stackColumns()} FROM stacks WHERE host_id = ${hostId} AND name = ${name}`;
	return row ? toStack(row) : null;
}

export async function createStack(input: {
	hostId: number;
	name: string;
	directory: string | null;
	file: string;
	adopted: boolean;
	compose: string;
	env: string;
	message: string | null;
	userId: number | null;
	deployed: boolean;
}): Promise<Stack> {
	return withWriteLock(() =>
		sql.begin(async (tx) => {
			const [row] = await tx`
				INSERT INTO stacks (host_id, name, directory, file, adopted, current_version, deployed_version)
				VALUES (${input.hostId}, ${input.name}, ${input.directory}, ${input.file}, ${input.adopted ? 1 : 0}, 1, ${input.deployed ? 1 : null})
				RETURNING ${stackColumns()}`;
			await tx`
				INSERT INTO stack_versions (stack_id, number, compose, env_secret, message, user_id)
				VALUES (${row.id}, 1, ${input.compose}, ${encrypt(input.env)}, ${input.message}, ${input.userId})`;
			return toStack(row);
		}),
	);
}

/** Stores a new version when the files changed. Returns its number, or null when nothing changed. */
export async function saveVersion(
	stackId: number,
	input: { compose: string; env: string; message: string | null; userId: number | null },
): Promise<number | null> {
	return withWriteLock(() =>
		sql.begin(async (tx) => {
			const [stack] = await tx`SELECT current_version FROM stacks WHERE id = ${stackId}`;
			if (!stack) throw new Error("This stack no longer exists.");
			const current = Number(stack.current_version);
			const [latest] = await tx`SELECT compose, env_secret FROM stack_versions WHERE stack_id = ${stackId} AND number = ${current}`;
			if (latest && latest.compose === input.compose && decrypt(latest.env_secret) === input.env) return null;
			const next = current + 1;
			await tx`
				INSERT INTO stack_versions (stack_id, number, compose, env_secret, message, user_id)
				VALUES (${stackId}, ${next}, ${input.compose}, ${encrypt(input.env)}, ${input.message}, ${input.userId})`;
			await tx`UPDATE stacks SET current_version = ${next}, updated_at = ${timestamp(new Date())} WHERE id = ${stackId}`;
			return next;
		}),
	);
}

export async function getVersion(stackId: number, number: number): Promise<StackVersion | null> {
	const [row] = await sql`
		SELECT v.number, v.compose, v.env_secret, v.message, u.username, v.created_at
		FROM stack_versions v LEFT JOIN users u ON u.id = v.user_id
		WHERE v.stack_id = ${stackId} AND v.number = ${number}`;
	if (!row) return null;
	return {
		number: Number(row.number),
		compose: row.compose,
		env: decrypt(row.env_secret),
		message: row.message ?? null,
		username: row.username ?? null,
		createdAt: iso(row.created_at),
	};
}

export async function listVersions(stackId: number, limit = 50): Promise<Omit<StackVersion, "compose" | "env">[]> {
	const rows = await sql`
		SELECT v.number, v.message, u.username, v.created_at
		FROM stack_versions v LEFT JOIN users u ON u.id = v.user_id
		WHERE v.stack_id = ${stackId}
		ORDER BY v.number DESC
		LIMIT ${limit}`;
	return rows.map((row: any) => ({ number: Number(row.number), message: row.message ?? null, username: row.username ?? null, createdAt: iso(row.created_at) }));
}

export async function setDirectory(stackId: number, directory: string): Promise<void> {
	await sql`UPDATE stacks SET directory = ${directory} WHERE id = ${stackId} AND (directory IS NULL OR directory <> ${directory})`;
}

export async function setDeployed(stackId: number, version: number | null): Promise<void> {
	await sql`UPDATE stacks SET deployed_version = ${version}, updated_at = ${timestamp(new Date())} WHERE id = ${stackId}`;
}

export async function deleteStack(stackId: number): Promise<void> {
	await sql`DELETE FROM stacks WHERE id = ${stackId}`;
}

function toDeploy(row: any): Deploy {
	return {
		id: Number(row.id),
		stackId: Number(row.stack_id),
		version: row.version === null ? null : Number(row.version),
		action: row.action,
		status: row.status,
		output: row.output ?? "",
		username: row.username ?? null,
		startedAt: iso(row.started_at),
		finishedAt: row.finished_at ? iso(row.finished_at) : null,
	};
}

export async function createDeploy(stackId: number, version: number | null, action: DeployAction, userId: number | null): Promise<number> {
	const [row] = await sql`
		INSERT INTO stack_deploys (stack_id, version, action, status, user_id)
		VALUES (${stackId}, ${version}, ${action}, 'running', ${userId})
		RETURNING id`;
	return Number(row.id);
}

export async function finishDeploy(id: number, status: Exclude<DeployStatus, "running">, output: string): Promise<void> {
	await sql`UPDATE stack_deploys SET status = ${status}, output = ${output}, finished_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function getDeploy(id: number): Promise<Deploy | null> {
	const [row] = await sql`
		SELECT d.id, d.stack_id, d.version, d.action, d.status, d.output, u.username, d.started_at, d.finished_at
		FROM stack_deploys d LEFT JOIN users u ON u.id = d.user_id
		WHERE d.id = ${id}`;
	return row ? toDeploy(row) : null;
}

export async function listDeploys(stackId: number, limit = 20): Promise<Deploy[]> {
	const rows = await sql`
		SELECT d.id, d.stack_id, d.version, d.action, d.status, '' AS output, u.username, d.started_at, d.finished_at
		FROM stack_deploys d LEFT JOIN users u ON u.id = d.user_id
		WHERE d.stack_id = ${stackId}
		ORDER BY d.id DESC
		LIMIT ${limit}`;
	return rows.map(toDeploy);
}

/** Deploys left running by a controller that stopped can never finish, so they are closed on start. */
export async function interruptRunningDeploys(): Promise<number> {
	const rows = await sql`
		UPDATE stack_deploys SET status = 'interrupted', finished_at = ${timestamp(new Date())}
		WHERE status = 'running'
		RETURNING id`;
	return rows.length;
}
