import { logger } from "../lib/logger.ts";
import { connect, disconnect, isPostgres, sql } from "./index.ts";
import postgresInit from "./migrations/postgres/0001_init.sql" with { type: "text" };
import postgresMetrics from "./migrations/postgres/0002_metrics.sql" with { type: "text" };
import postgresStacks from "./migrations/postgres/0003_stacks.sql" with { type: "text" };
import postgresUpdates from "./migrations/postgres/0004_updates.sql" with { type: "text" };
import postgresBackups from "./migrations/postgres/0005_backups.sql" with { type: "text" };
import postgresAlerts from "./migrations/postgres/0006_alerts.sql" with { type: "text" };
import postgresFirewall from "./migrations/postgres/0007_firewall.sql" with { type: "text" };
import postgresSessionCsrf from "./migrations/postgres/0008_session_csrf.sql" with { type: "text" };
import postgresTransfers from "./migrations/postgres/0009_transfers.sql" with { type: "text" };
import postgresStackMoved from "./migrations/postgres/0010_stack_moved.sql" with { type: "text" };
import sqliteInit from "./migrations/sqlite/0001_init.sql" with { type: "text" };
import sqliteMetrics from "./migrations/sqlite/0002_metrics.sql" with { type: "text" };
import sqliteStacks from "./migrations/sqlite/0003_stacks.sql" with { type: "text" };
import sqliteUpdates from "./migrations/sqlite/0004_updates.sql" with { type: "text" };
import sqliteBackups from "./migrations/sqlite/0005_backups.sql" with { type: "text" };
import sqliteAlerts from "./migrations/sqlite/0006_alerts.sql" with { type: "text" };
import sqliteFirewall from "./migrations/sqlite/0007_firewall.sql" with { type: "text" };
import sqliteSessionCsrf from "./migrations/sqlite/0008_session_csrf.sql" with { type: "text" };
import sqliteTransfers from "./migrations/sqlite/0009_transfers.sql" with { type: "text" };
import sqliteStackMoved from "./migrations/sqlite/0010_stack_moved.sql" with { type: "text" };

export interface Migration {
	name: string;
	statements: string[];
}

function statements(source: string): string[] {
	return source
		.split(/;\s*\n/)
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

export function migrations(): Migration[] {
	return [
		{ name: "0001_init", statements: statements(isPostgres ? postgresInit : sqliteInit) },
		{ name: "0002_metrics", statements: statements(isPostgres ? postgresMetrics : sqliteMetrics) },
		{ name: "0003_stacks", statements: statements(isPostgres ? postgresStacks : sqliteStacks) },
		{ name: "0004_updates", statements: statements(isPostgres ? postgresUpdates : sqliteUpdates) },
		{ name: "0005_backups", statements: statements(isPostgres ? postgresBackups : sqliteBackups) },
		{ name: "0006_alerts", statements: statements(isPostgres ? postgresAlerts : sqliteAlerts) },
		{ name: "0007_firewall", statements: statements(isPostgres ? postgresFirewall : sqliteFirewall) },
		{ name: "0008_session_csrf", statements: statements(isPostgres ? postgresSessionCsrf : sqliteSessionCsrf) },
		{ name: "0009_transfers", statements: statements(isPostgres ? postgresTransfers : sqliteTransfers) },
		{ name: "0010_stack_moved", statements: statements(isPostgres ? postgresStackMoved : sqliteStackMoved) },
	];
}

export async function migrate(): Promise<void> {
	await sql.unsafe(
		isPostgres
			? "CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
			: "CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
	);
	const rows: { name: string }[] = await sql`SELECT name FROM migrations`;
	const applied = new Set(rows.map((row) => row.name));
	const pending = migrations().filter((m) => !applied.has(m.name));
	if (pending.length === 0) {
		logger.info("Database schema is up to date");
		return;
	}
	for (const migration of pending) {
		logger.info(`Applying migration ${migration.name}`);
		await sql.begin(async (tx) => {
			for (const statement of migration.statements) await tx.unsafe(statement);
			await tx`INSERT INTO migrations (name) VALUES (${migration.name})`;
		});
	}
	logger.info(`Applied ${pending.length} migration(s)`);
}

if (import.meta.main) {
	await connect();
	await migrate();
	await disconnect();
}
