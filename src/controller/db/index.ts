import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { logger } from "../lib/logger.ts";

export const dialect = config.database.dialect;
export const isPostgres = dialect === "postgres";

function sqliteFilename(url: string): string {
	return url.replace(/^(sqlite|file):\/\//, "");
}

if (!isPostgres) {
	const filename = sqliteFilename(config.database.url);
	if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
}

export const sql: SQL = isPostgres
	? new SQL(config.database.url, { max: config.database.poolSize, prepare: config.database.prepare })
	: new SQL(config.database.url);

export async function connect(): Promise<SQL> {
	if (isPostgres) {
		await sql.connect();
	} else {
		await sql`PRAGMA journal_mode = WAL`;
		await sql`PRAGMA foreign_keys = ON`;
		await sql`PRAGMA busy_timeout = 5000`;
		await sql`PRAGMA synchronous = NORMAL`;
	}
	logger.info(`Connected to ${isPostgres ? "PostgreSQL" : "SQLite"}`);
	return sql;
}

export async function disconnect(): Promise<void> {
	await sql.close({ timeout: 5 });
	logger.info("Database connection closed");
}

/** Timestamps come back as Date from PostgreSQL and as ISO text from SQLite. */
export function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A timestamp parameter both dialects compare correctly against their own column type. */
export function timestamp(value: Date): Date | string {
	return isPostgres ? value : value.toISOString();
}

export function isoDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * SQLite has one connection, so transactions from concurrent tasks in the
 * same process must not interleave. PostgreSQL gives each its own connection.
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
	if (isPostgres) return fn();
	const run = writeQueue.then(fn, fn);
	writeQueue = run.catch(() => undefined);
	return run;
}
