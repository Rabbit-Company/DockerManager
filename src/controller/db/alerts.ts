import { defaultSetting, isRuleId, RULES, type RuleId, type RuleSetting, type Severity } from "../alerts/rules.ts";
import { decrypt, encrypt } from "../lib/secrets.ts";
import { iso, sql, timestamp } from "./index.ts";

export type ChannelKind = "email" | "ntfy" | "discord" | "webhook";

export type ChannelConfig =
	| { kind: "email"; host: string; port: number; security: "starttls" | "tls" | "none"; username: string; password: string; from: string; to: string[] }
	| { kind: "ntfy"; server: string; topic: string; token: string }
	| { kind: "discord"; url: string }
	| { kind: "webhook"; url: string; secret: string };

export interface Channel {
	id: number;
	name: string;
	kind: ChannelKind;
	enabled: boolean;
	lastSentAt: string | null;
	lastError: string | null;
	createdAt: string;
}

export interface Alert {
	id: number;
	rule: RuleId;
	target: string;
	hostId: number | null;
	severity: Severity;
	title: string;
	detail: string | null;
	link: string | null;
	status: "firing" | "resolved" | "event";
	startedAt: string;
	resolvedAt: string | null;
}

function toChannel(r: any): Channel {
	return {
		id: Number(r.id),
		name: r.name,
		kind: r.kind,
		enabled: Number(r.enabled) === 1,
		lastSentAt: r.last_sent_at ? iso(r.last_sent_at) : null,
		lastError: r.last_error ?? null,
		createdAt: iso(r.created_at),
	};
}

export async function listChannels(): Promise<Channel[]> {
	const rows = await sql`SELECT id, name, kind, enabled, last_sent_at, last_error, created_at FROM alert_channels ORDER BY name`;
	return rows.map(toChannel);
}

export async function getChannel(id: number): Promise<(Channel & { config: ChannelConfig }) | null> {
	const [r] = await sql`SELECT id, name, kind, enabled, last_sent_at, last_error, created_at, config_secret FROM alert_channels WHERE id = ${id}`;
	return r ? { ...toChannel(r), config: JSON.parse(decrypt(r.config_secret)) } : null;
}

export async function enabledChannels(): Promise<(Channel & { config: ChannelConfig })[]> {
	const rows = await sql`SELECT id, name, kind, enabled, last_sent_at, last_error, created_at, config_secret FROM alert_channels WHERE enabled = 1`;
	return rows.map((r: any) => ({ ...toChannel(r), config: JSON.parse(decrypt(r.config_secret)) }));
}

export async function createChannel(name: string, config: ChannelConfig): Promise<number> {
	const [r] =
		await sql`INSERT INTO alert_channels (name, kind, config_secret) VALUES (${name}, ${config.kind}, ${encrypt(JSON.stringify(config))}) RETURNING id`;
	return Number(r.id);
}

export async function updateChannel(id: number, name: string, config: ChannelConfig, enabled: boolean): Promise<void> {
	await sql`UPDATE alert_channels SET name = ${name}, kind = ${config.kind}, config_secret = ${encrypt(JSON.stringify(config))}, enabled = ${enabled ? 1 : 0} WHERE id = ${id}`;
}

export async function deleteChannel(id: number): Promise<void> {
	await sql`DELETE FROM alert_channels WHERE id = ${id}`;
}

export async function recordDelivery(id: number, error: string | null): Promise<void> {
	if (error === null) await sql`UPDATE alert_channels SET last_sent_at = ${timestamp(new Date())}, last_error = NULL WHERE id = ${id}`;
	else await sql`UPDATE alert_channels SET last_error = ${error.slice(0, 500)} WHERE id = ${id}`;
}

export async function ruleSettings(): Promise<Map<RuleId, RuleSetting>> {
	const rows = await sql`SELECT rule, enabled, threshold, minutes, channels FROM alert_rules`;
	const out = new Map<RuleId, RuleSetting>(RULES.map((r) => [r.id, defaultSetting(r.id)]));
	for (const r of rows as any[]) {
		if (!isRuleId(r.rule)) continue;
		let channels: number[] | null = null;
		try {
			channels = r.channels ? (JSON.parse(r.channels) as number[]) : null;
		} catch {}
		out.set(r.rule, {
			enabled: Number(r.enabled) === 1,
			threshold: r.threshold === null ? null : Number(r.threshold),
			minutes: r.minutes === null ? null : Number(r.minutes),
			channels,
		});
	}
	return out;
}

export async function saveRuleSetting(rule: RuleId, s: RuleSetting): Promise<void> {
	const channels = s.channels === null ? null : JSON.stringify(s.channels);
	await sql`
		INSERT INTO alert_rules (rule, enabled, threshold, minutes, channels) VALUES (${rule}, ${s.enabled ? 1 : 0}, ${s.threshold}, ${s.minutes}, ${channels})
		ON CONFLICT (rule) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, minutes = excluded.minutes, channels = excluded.channels`;
}

function toAlert(r: any): Alert {
	return {
		id: Number(r.id),
		rule: r.rule,
		target: r.target,
		hostId: r.host_id === null ? null : Number(r.host_id),
		severity: r.severity,
		title: r.title,
		detail: r.detail ?? null,
		link: r.link ?? null,
		status: r.status,
		startedAt: iso(r.started_at),
		resolvedAt: r.resolved_at ? iso(r.resolved_at) : null,
	};
}

const alertColumns = () => sql`id, rule, target, host_id, severity, title, detail, link, status, started_at, resolved_at`;

export async function firingAlerts(): Promise<Alert[]> {
	const rows = await sql`SELECT ${alertColumns()} FROM alerts WHERE status = 'firing' ORDER BY started_at DESC`;
	return rows.map(toAlert);
}

export async function countFiring(): Promise<number> {
	const [r] = await sql`SELECT COUNT(*) AS n FROM alerts WHERE status = 'firing'`;
	return Number(r.n);
}

export async function recentAlerts(limit = 50): Promise<Alert[]> {
	const rows = await sql`SELECT ${alertColumns()} FROM alerts WHERE status <> 'firing' ORDER BY started_at DESC LIMIT ${limit}`;
	return rows.map(toAlert);
}

/** Opens an alert unless one for the same rule and target is already firing. Returns it when it is new. */
export async function openAlert(a: Omit<Alert, "id" | "status" | "startedAt" | "resolvedAt">): Promise<Alert | null> {
	const rows = await sql`
		INSERT INTO alerts (rule, target, host_id, severity, title, detail, link, status)
		VALUES (${a.rule}, ${a.target}, ${a.hostId}, ${a.severity}, ${a.title}, ${a.detail}, ${a.link}, 'firing')
		ON CONFLICT (rule, target) WHERE status = 'firing' DO NOTHING
		RETURNING ${alertColumns()}`;
	return rows.length > 0 ? toAlert(rows[0]) : null;
}

export async function resolveAlert(id: number): Promise<void> {
	await sql`UPDATE alerts SET status = 'resolved', resolved_at = ${timestamp(new Date())} WHERE id = ${id} AND status = 'firing'`;
}

/** Records an event once per target, such as one update offer. Returns null when it was recorded before. */
export async function recordEvent(a: Omit<Alert, "id" | "status" | "startedAt" | "resolvedAt">, once: boolean): Promise<Alert | null> {
	if (once) {
		const [seen] = await sql`SELECT id FROM alerts WHERE rule = ${a.rule} AND target = ${a.target} AND status = 'event'`;
		if (seen) return null;
	}
	const [r] = await sql`
		INSERT INTO alerts (rule, target, host_id, severity, title, detail, link, status, resolved_at)
		VALUES (${a.rule}, ${a.target}, ${a.hostId}, ${a.severity}, ${a.title}, ${a.detail}, ${a.link}, 'event', ${timestamp(new Date())})
		RETURNING ${alertColumns()}`;
	return toAlert(r);
}

export async function pruneAlerts(days = 90): Promise<void> {
	await sql`DELETE FROM alerts WHERE status <> 'firing' AND started_at < ${timestamp(new Date(Date.now() - days * 86_400_000))}`;
}
