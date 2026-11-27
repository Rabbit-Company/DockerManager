import { iso, sql, timestamp } from "./index.ts";

export type FirewallStatus = "off" | "pending" | "active" | "reverted" | "failed";

export interface StoredFirewall {
	hostId: number;
	rules: string;
	hostDefault: "accept" | "drop";
	containerDefault: "accept" | "drop";
	sshPort: number;
	status: FirewallStatus;
	detail: string | null;
	pendingToken: string | null;
	pendingUntil: string | null;
	updatedAt: string;
}

export async function getFirewall(hostId: number): Promise<StoredFirewall | null> {
	const [r] = await sql`
		SELECT host_id, rules, host_default, container_default, ssh_port, status, detail, pending_token, pending_until, updated_at
		FROM firewall_policies WHERE host_id = ${hostId}`;
	if (!r) return null;
	return {
		hostId: Number(r.host_id),
		rules: r.rules,
		hostDefault: r.host_default,
		containerDefault: r.container_default,
		sshPort: Number(r.ssh_port),
		status: r.status,
		detail: r.detail ?? null,
		pendingToken: r.pending_token ?? null,
		pendingUntil: r.pending_until ? iso(r.pending_until) : null,
		updatedAt: iso(r.updated_at),
	};
}

export async function saveFirewall(f: Omit<StoredFirewall, "updatedAt">): Promise<void> {
	const until = f.pendingUntil ? timestamp(new Date(f.pendingUntil)) : null;
	await sql`
		INSERT INTO firewall_policies (host_id, rules, host_default, container_default, ssh_port, status, detail, pending_token, pending_until, updated_at)
		VALUES (${f.hostId}, ${f.rules}, ${f.hostDefault}, ${f.containerDefault}, ${f.sshPort}, ${f.status}, ${f.detail}, ${f.pendingToken}, ${until}, ${timestamp(new Date())})
		ON CONFLICT (host_id) DO UPDATE SET rules = excluded.rules, host_default = excluded.host_default, container_default = excluded.container_default,
			ssh_port = excluded.ssh_port, status = excluded.status, detail = excluded.detail, pending_token = excluded.pending_token,
			pending_until = excluded.pending_until, updated_at = excluded.updated_at`;
}

export async function setFirewallStatus(hostId: number, status: FirewallStatus, detail: string | null): Promise<void> {
	await sql`
		UPDATE firewall_policies SET status = ${status}, detail = ${detail}, pending_token = NULL, pending_until = NULL, updated_at = ${timestamp(new Date())}
		WHERE host_id = ${hostId}`;
}
