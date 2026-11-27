import { config } from "../config.ts";
import { hashToken, randomToken } from "../lib/crypto.ts";
import { iso, sql, timestamp } from "./index.ts";

export type Role = "admin" | "operator" | "viewer";

export interface User {
	id: number;
	username: string;
	role: Role;
	createdAt: string;
}

export interface Session {
	userId: number;
	csrf: string;
	mfaPending: boolean;
	expiresAt: string;
}

interface UserRow {
	id: number | string;
	username: string;
	role: Role;
	created_at: Date | string;
}

function toUser(row: UserRow): User {
	return { id: Number(row.id), username: row.username, role: row.role, createdAt: iso(row.created_at) };
}

export async function countUsers(): Promise<number> {
	const [row] = await sql`SELECT COUNT(*) AS n FROM users`;
	return Number(row.n);
}

export async function createUser(input: { username: string; passwordHash: string; totpSecret: string; role: Role }): Promise<User> {
	const [row] = await sql`
		INSERT INTO users (username, password_hash, totp_secret, role)
		VALUES (${input.username}, ${input.passwordHash}, ${input.totpSecret}, ${input.role})
		RETURNING id, username, role, created_at`;
	return toUser(row);
}

export async function getUser(id: number): Promise<User | null> {
	const [row] = await sql`SELECT id, username, role, created_at FROM users WHERE id = ${id}`;
	return row ? toUser(row) : null;
}

export async function findLogin(username: string): Promise<{ user: User; passwordHash: string } | null> {
	const [row] = await sql`SELECT id, username, role, created_at, password_hash FROM users WHERE username = ${username}`;
	return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
}

export async function totpSecret(userId: number): Promise<string | null> {
	const [row] = await sql`SELECT totp_secret FROM users WHERE id = ${userId}`;
	return row ? row.totp_secret : null;
}

/** Marks a 30 second step as used. Fails when that step or a later one was already used, so a seen code cannot sign in twice. */
export async function claimTotpStep(userId: number, step: number): Promise<boolean> {
	const rows = await sql`UPDATE users SET totp_last_step = ${step} WHERE id = ${userId} AND totp_last_step < ${step} RETURNING id`;
	return rows.length > 0;
}

const PENDING_MS = 15 * 60_000;

function sessionExpiry(): Date {
	return new Date(Date.now() + config.auth.sessionDays * 86_400_000);
}

/** Starts a session that only allows the 2FA step and expires in 15 minutes unless the code follows. */
export async function createSession(userId: number, meta: { ip: string | null; userAgent: string | null }): Promise<string> {
	const token = randomToken();
	const expires = new Date(Date.now() + PENDING_MS);
	await sql`
		INSERT INTO sessions (id, user_id, csrf, mfa_pending, ip, user_agent, expires_at)
		VALUES (${hashToken(token)}, ${userId}, ${randomToken(24)}, 1, ${meta.ip}, ${meta.userAgent?.slice(0, 300) ?? null}, ${timestamp(expires)})`;
	return token;
}

export async function findSession(token: string): Promise<Session | null> {
	const [row] = await sql`
		SELECT user_id, csrf, mfa_pending, expires_at FROM sessions
		WHERE id = ${hashToken(token)} AND expires_at > ${timestamp(new Date())}`;
	if (!row) return null;
	return { userId: Number(row.user_id), csrf: row.csrf, mfaPending: Number(row.mfa_pending) === 1, expiresAt: iso(row.expires_at) };
}

export async function findSessionByCsrf(csrf: string): Promise<Session | null> {
	const [row] = await sql`
		SELECT user_id, csrf, mfa_pending, expires_at FROM sessions
		WHERE csrf = ${csrf} AND expires_at > ${timestamp(new Date())}`;
	if (!row) return null;
	return { userId: Number(row.user_id), csrf: row.csrf, mfaPending: Number(row.mfa_pending) === 1, expiresAt: iso(row.expires_at) };
}

export async function completeMfa(token: string): Promise<void> {
	await sql`UPDATE sessions SET mfa_pending = 0, expires_at = ${timestamp(sessionExpiry())} WHERE id = ${hashToken(token)}`;
}

export async function deleteSession(token: string): Promise<void> {
	await sql`DELETE FROM sessions WHERE id = ${hashToken(token)}`;
}

export async function deleteExpiredSessions(): Promise<number> {
	const rows = await sql`DELETE FROM sessions WHERE expires_at <= ${timestamp(new Date())} RETURNING id`;
	return rows.length;
}
