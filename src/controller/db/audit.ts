import { iso, sql } from "./index.ts";

export interface AuditEntry {
	id: number;
	username: string | null;
	hostId: number | null;
	hostName: string | null;
	action: string;
	target: string | null;
	ok: boolean;
	detail: string | null;
	ip: string | null;
	createdAt: string;
}

export async function audit(entry: {
	userId: number | null;
	hostId?: number | null;
	action: string;
	target?: string | null;
	ok?: boolean;
	detail?: string | null;
	ip?: string | null;
}): Promise<void> {
	await sql`
		INSERT INTO audit_log (user_id, host_id, action, target, ok, detail, ip)
		VALUES (${entry.userId}, ${entry.hostId ?? null}, ${entry.action}, ${entry.target ?? null}, ${entry.ok === false ? 0 : 1},
			${entry.detail?.slice(0, 1000) ?? null}, ${entry.ip ?? null})`;
}

export async function listAudit(options: { hostId?: number; limit?: number } = {}): Promise<AuditEntry[]> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
	const filter = options.hostId === undefined ? sql`` : sql`WHERE a.host_id = ${options.hostId}`;
	const rows = await sql`
		SELECT a.id, u.username, a.host_id, h.name AS host_name, a.action, a.target, a.ok, a.detail, a.ip, a.created_at
		FROM audit_log a
		LEFT JOIN users u ON u.id = a.user_id
		LEFT JOIN hosts h ON h.id = a.host_id
		${filter}
		ORDER BY a.created_at DESC, a.id DESC
		LIMIT ${limit}`;
	return rows.map((row: any) => ({
		id: Number(row.id),
		username: row.username ?? null,
		hostId: row.host_id === null ? null : Number(row.host_id),
		hostName: row.host_name ?? null,
		action: row.action,
		target: row.target ?? null,
		ok: Number(row.ok) === 1,
		detail: row.detail ?? null,
		ip: row.ip ?? null,
		createdAt: iso(row.created_at),
	}));
}
