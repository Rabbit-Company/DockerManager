import type { HostFacts } from "../../shared/protocol.ts";
import { config } from "../config.ts";
import { hashToken, randomToken, safeEqual } from "../lib/crypto.ts";
import { iso, sql, timestamp } from "./index.ts";

export interface Host {
	id: number;
	name: string;
	hostname: string | null;
	facts: HostFacts | null;
	enrolled: boolean;
	joinPending: boolean;
	enrolledAt: string | null;
	lastSeenAt: string | null;
	createdAt: string;
}

function toHost(row: any): Host {
	let facts: HostFacts | null = null;
	if (typeof row.facts === "string") {
		try {
			facts = JSON.parse(row.facts) as HostFacts;
		} catch {}
	}
	const now = Date.now();
	return {
		id: Number(row.id),
		name: row.name,
		hostname: row.hostname ?? null,
		facts,
		enrolled: row.secret_hash !== null,
		joinPending: row.join_token_hash !== null && row.join_expires_at !== null && new Date(row.join_expires_at).getTime() > now,
		enrolledAt: row.enrolled_at ? iso(row.enrolled_at) : null,
		lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null,
		createdAt: iso(row.created_at),
	};
}

const columns = () => sql`id, name, hostname, facts, secret_hash, join_token_hash, join_expires_at, enrolled_at, last_seen_at, created_at`;

export async function listHosts(): Promise<Host[]> {
	const rows = await sql`SELECT ${columns()} FROM hosts ORDER BY name, id`;
	return rows.map(toHost);
}

export async function getHost(id: number): Promise<Host | null> {
	const [row] = await sql`SELECT ${columns()} FROM hosts WHERE id = ${id}`;
	return row ? toHost(row) : null;
}

function joinExpiry(): Date {
	return new Date(Date.now() + config.agents.joinTokenMinutes * 60_000);
}

export async function createHost(name: string): Promise<{ host: Host; token: string }> {
	const token = `dmj_${randomToken()}`;
	const [row] = await sql`
		INSERT INTO hosts (name, join_token_hash, join_expires_at)
		VALUES (${name}, ${hashToken(token)}, ${timestamp(joinExpiry())})
		RETURNING ${columns()}`;
	return { host: toHost(row), token };
}

/** A new join token for an existing host. The current secret keeps working until the agent enrolls again. */
export async function renewJoinToken(id: number): Promise<string | null> {
	const token = `dmj_${randomToken()}`;
	const rows = await sql`UPDATE hosts SET join_token_hash = ${hashToken(token)}, join_expires_at = ${timestamp(joinExpiry())} WHERE id = ${id} RETURNING id`;
	return rows.length > 0 ? token : null;
}

/** Spends a join token once and hands out a new agent secret. */
export async function enrollHost(token: string, hostname: string): Promise<{ hostId: number; secret: string } | null> {
	const secret = randomToken();
	const now = new Date();
	const rows = await sql`
		UPDATE hosts SET join_token_hash = NULL, join_expires_at = NULL, secret_hash = ${hashToken(secret)},
			hostname = ${hostname.slice(0, 253)}, enrolled_at = ${timestamp(now)}
		WHERE join_token_hash = ${hashToken(token)} AND join_expires_at > ${timestamp(now)}
		RETURNING id`;
	if (rows.length === 0) return null;
	return { hostId: Number(rows[0].id), secret };
}

export async function verifyAgent(hostId: number, secret: string): Promise<boolean> {
	const [row] = await sql`SELECT secret_hash FROM hosts WHERE id = ${hostId}`;
	if (!row || row.secret_hash === null) return false;
	return safeEqual(hashToken(secret), row.secret_hash);
}

export async function saveFacts(id: number, facts: HostFacts): Promise<void> {
	await sql`UPDATE hosts SET facts = ${JSON.stringify(facts)}, hostname = ${facts.hostname.slice(0, 253)}, last_seen_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function touchHost(id: number): Promise<void> {
	await sql`UPDATE hosts SET last_seen_at = ${timestamp(new Date())} WHERE id = ${id}`;
}

export async function renameHost(id: number, name: string): Promise<void> {
	await sql`UPDATE hosts SET name = ${name} WHERE id = ${id}`;
}

export async function deleteHost(id: number): Promise<void> {
	await sql`DELETE FROM hosts WHERE id = ${id}`;
}
