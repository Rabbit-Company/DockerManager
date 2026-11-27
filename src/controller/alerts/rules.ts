export type Severity = "critical" | "warning" | "info";

export type RuleId =
	| "host_offline"
	| "host_cpu"
	| "host_memory"
	| "disk_full"
	| "raid_degraded"
	| "nvme_health"
	| "nvme_wear"
	| "nvme_unavailable"
	| "container_unhealthy"
	| "container_restarting"
	| "container_failed"
	| "container_memory"
	| "backup_failed"
	| "deploy_failed"
	| "update_available"
	| "firewall_reverted";

export interface RuleDefinition {
	id: RuleId;
	label: string;
	help: string;
	severity: Severity;
	/** Percent, when the rule has one. */
	threshold: number | null;
	/** How long the condition must hold, null for rules that fire on an event. */
	minutes: number | null;
}

export const RULES: RuleDefinition[] = [
	{ id: "host_offline", label: "Host offline", help: "The agent has not been connected for this long.", severity: "critical", threshold: null, minutes: 2 },
	{ id: "host_cpu", label: "Host CPU high", help: "Share of all cores in use.", severity: "warning", threshold: 90, minutes: 10 },
	{ id: "host_memory", label: "Host memory high", help: "Memory in use, without the page cache.", severity: "warning", threshold: 90, minutes: 10 },
	{ id: "disk_full", label: "Filesystem almost full", help: "Space used on any filesystem of a host.", severity: "warning", threshold: 90, minutes: 0 },
	{ id: "raid_degraded", label: "Software RAID degraded", help: "A Linux MD array is missing a member.", severity: "critical", threshold: null, minutes: 0 },
	{
		id: "nvme_health",
		label: "NVMe drive health",
		help: "SMART failure, critical warning, low spare or media errors.",
		severity: "critical",
		threshold: null,
		minutes: 0,
	},
	{ id: "nvme_wear", label: "NVMe life used", help: "The drive has used this share of its rated endurance.", severity: "warning", threshold: 90, minutes: 0 },
	{
		id: "nvme_unavailable",
		label: "NVMe health unavailable",
		help: "The agent cannot read SMART data from one or more drives.",
		severity: "warning",
		threshold: null,
		minutes: 0,
	},
	{ id: "container_unhealthy", label: "Container unhealthy", help: "Its healthcheck fails.", severity: "critical", threshold: null, minutes: 2 },
	{ id: "container_restarting", label: "Container restarting", help: "It keeps crashing and restarting.", severity: "critical", threshold: null, minutes: 1 },
	{
		id: "container_failed",
		label: "Container crashed",
		help: "A container of a deployed stack exited with an error and stays down.",
		severity: "critical",
		threshold: null,
		minutes: 1,
	},
	{
		id: "container_memory",
		label: "Container near its memory limit",
		help: "Only containers with a memory limit.",
		severity: "warning",
		threshold: 95,
		minutes: 5,
	},
	{ id: "backup_failed", label: "Backup failed", help: "Scheduled and manual backups.", severity: "critical", threshold: null, minutes: null },
	{
		id: "deploy_failed",
		label: "Deploy or update failed",
		help: "Including updates that were rolled back.",
		severity: "critical",
		threshold: null,
		minutes: null,
	},
	{
		id: "update_available",
		label: "Image update available",
		help: "Once for each new version a service is offered.",
		severity: "info",
		threshold: null,
		minutes: null,
	},
	{
		id: "firewall_reverted",
		label: "Firewall rules undone",
		help: "New rules were not kept in time and went back.",
		severity: "warning",
		threshold: null,
		minutes: null,
	},
];

export const RULE = Object.fromEntries(RULES.map((r) => [r.id, r])) as Record<RuleId, RuleDefinition>;

export function isRuleId(value: string): value is RuleId {
	return Object.hasOwn(RULE, value);
}

export interface RuleSetting {
	enabled: boolean;
	threshold: number | null;
	minutes: number | null;
	/** Channel ids, or null for every enabled channel. */
	channels: number[] | null;
}

export function defaultSetting(id: RuleId): RuleSetting {
	const r = RULE[id];
	return { enabled: true, threshold: r.threshold, minutes: r.minutes, channels: null };
}
