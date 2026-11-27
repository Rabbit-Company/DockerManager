import { cpuShare, percent } from "../../shared/units.ts";
import { enabledChannels, firingAlerts, openAlert, recordDelivery, recordEvent, resolveAlert, ruleSettings, type Alert } from "../db/alerts.ts";
import { listHosts, type Host } from "../db/hosts.ts";
import { listAllStacks } from "../db/stacks.ts";
import type { Hub } from "../hub.ts";
import { logger } from "../lib/logger.ts";
import { deliver, type Notice } from "./channels.ts";
import { RULE, type RuleId, type RuleSetting } from "./rules.ts";
import { setFiring } from "./state.ts";

export interface Condition {
	rule: RuleId;
	target: string;
	hostId: number;
	title: string;
	detail: string | null;
	link: string | null;
}

/** Offline hosts are not reported until agents had time to reconnect after the controller started. */
const STARTUP_GRACE_MS = 3 * 60_000;
const IGNORED_EXIT = new Set([0, 137, 143]);
const STORAGE_RULES = new Set<RuleId>(["raid_degraded", "nvme_health", "nvme_wear", "nvme_unavailable"]);
const STORAGE_FRESH_MS = 20 * 60_000;

/** Everything that is wrong right now, before the minutes a rule asks for. Pure, so tests can feed it any state. */
export function conditions(input: {
	hosts: Host[];
	online: (id: number) => boolean;
	hub: Pick<Hub, "snapshot" | "latest"> & Partial<Pick<Hub, "storage">>;
	settings: Map<RuleId, RuleSetting>;
	deployedProjects: Map<number, Set<string>>;
	now: number;
	startedAt: number;
	link: (path: string) => string;
}): Condition[] {
	const out: Condition[] = [];
	const on = (rule: RuleId) => input.settings.get(rule)?.enabled !== false;
	const threshold = (rule: RuleId) => input.settings.get(rule)?.threshold ?? RULE[rule].threshold ?? 0;
	for (const host of input.hosts) {
		if (!host.enrolled) continue;
		const hostLink = input.link(`/hosts/${host.id}`);
		if (!input.online(host.id)) {
			const minutes = input.settings.get("host_offline")?.minutes ?? RULE.host_offline.minutes ?? 2;
			const since = host.lastSeenAt ? Date.parse(host.lastSeenAt) : 0;
			if (on("host_offline") && input.now - input.startedAt > STARTUP_GRACE_MS && input.now - since > minutes * 60_000) {
				out.push({
					rule: "host_offline",
					target: `host:${host.id}`,
					hostId: host.id,
					title: `${host.name} is offline`,
					detail: host.lastSeenAt ? `The agent was last connected at ${host.lastSeenAt.replace("T", " ").slice(0, 19)} UTC.` : "The agent never connected.",
					link: hostLink,
				});
			}
			continue;
		}
		const sample = input.hub.latest(host.id);
		const storage = input.hub.storage?.(host.id);
		if (storage && input.now - storage.takenAt < STORAGE_FRESH_MS) {
			const link = input.link(`/hosts/${host.id}?tab=storage`);
			if (on("nvme_unavailable") && storage.drives.some((drive) => drive.error))
				out.push({
					rule: "nvme_unavailable",
					target: `host:${host.id}`,
					hostId: host.id,
					title: `${host.name}: NVMe health cannot be read`,
					detail: storage.drives
						.filter((drive) => drive.error)
						.map((drive) => `${drive.device}: ${drive.error}`)
						.join(", "),
					link,
				});
			for (const drive of storage.drives) {
				if (drive.error) continue;
				const problems: string[] = [];
				if (drive.passed === false) problems.push("SMART health failed");
				if ((drive.criticalWarning ?? 0) > 0) problems.push(`critical warning ${drive.criticalWarning}`);
				if (drive.sparePercent !== null && drive.spareThresholdPercent !== null && drive.sparePercent <= drive.spareThresholdPercent)
					problems.push(`spare ${drive.sparePercent}% is at or below ${drive.spareThresholdPercent}%`);
				if ((drive.mediaErrors ?? 0) > 0) problems.push(`${drive.mediaErrors} media errors`);
				const target = `nvme:${host.id}:${drive.serial ?? drive.device}`;
				if (on("nvme_health") && problems.length > 0)
					out.push({ rule: "nvme_health", target, hostId: host.id, title: `${host.name}: ${drive.device} needs attention`, detail: problems.join(", "), link });
				if (on("nvme_wear") && drive.usedPercent !== null && drive.usedPercent >= threshold("nvme_wear"))
					out.push({
						rule: "nvme_wear",
						target,
						hostId: host.id,
						title: `${host.name}: ${drive.device} has used ${drive.usedPercent}% of its rated life`,
						detail: drive.model,
						link,
					});
			}
			if (on("raid_degraded"))
				for (const array of storage.arrays)
					if (array.degraded !== null && array.degraded > 0)
						out.push({
							rule: "raid_degraded",
							target: `raid:${host.id}:${array.device}`,
							hostId: host.id,
							title: `${host.name}: ${array.device} is degraded`,
							detail: `${array.degraded} of ${array.raidDisks ?? "unknown"} members missing. ${array.members.join(", ")}`,
							link,
						});
		}
		const h = sample?.host;
		if (h) {
			const cpu = cpuShare(h.cpu, h.cpus);
			if (on("host_cpu") && cpu !== null && cpu >= threshold("host_cpu"))
				out.push({
					rule: "host_cpu",
					target: `host:${host.id}`,
					hostId: host.id,
					title: `${host.name}: CPU at ${percent(cpu)}`,
					detail: `${h.cpus} cores, load ${h.load1}.`,
					link: input.link(`/hosts/${host.id}?tab=metrics`),
				});
			const mem = h.memTotal > 0 ? (h.mem / h.memTotal) * 100 : null;
			if (on("host_memory") && mem !== null && mem >= threshold("host_memory"))
				out.push({
					rule: "host_memory",
					target: `host:${host.id}`,
					hostId: host.id,
					title: `${host.name}: memory at ${percent(mem)}`,
					detail: null,
					link: input.link(`/hosts/${host.id}?tab=metrics`),
				});
			if (on("disk_full")) {
				for (const fs of h.filesystems) {
					const used = fs.used + fs.avail > 0 ? (fs.used / (fs.used + fs.avail)) * 100 : 0;
					if (used >= threshold("disk_full"))
						out.push({
							rule: "disk_full",
							target: `fs:${host.id}:${fs.mount}`,
							hostId: host.id,
							title: `${host.name}: ${fs.mount} is ${percent(used)} full`,
							detail: `${Math.round(fs.avail / 1024 ** 3)} GB free.`,
							link: input.link(`/hosts/${host.id}?tab=metrics`),
						});
				}
			}
			if (on("container_memory")) {
				for (const c of sample!.containers) {
					if (!c.memLimit || c.memLimit >= h.memTotal * 0.99) continue;
					const share = (c.mem / c.memLimit) * 100;
					if (share >= threshold("container_memory"))
						out.push({
							rule: "container_memory",
							target: `container:${host.id}:${c.name}`,
							hostId: host.id,
							title: `${host.name}: ${c.name} uses ${percent(share)} of its memory limit`,
							detail: null,
							link: input.link(`/hosts/${host.id}/containers/${c.id}`),
						});
				}
			}
		}
		const deployed = input.deployedProjects.get(host.id) ?? new Set();
		for (const c of input.hub.snapshot(host.id)?.containers ?? []) {
			const link = input.link(`/hosts/${host.id}/containers/${c.id}`);
			const target = `container:${host.id}:${c.name}`;
			if (on("container_unhealthy") && c.status.includes("(unhealthy)"))
				out.push({ rule: "container_unhealthy", target, hostId: host.id, title: `${host.name}: ${c.name} is unhealthy`, detail: c.status, link });
			if (on("container_restarting") && c.state === "restarting")
				out.push({ rule: "container_restarting", target, hostId: host.id, title: `${host.name}: ${c.name} keeps restarting`, detail: c.status, link });
			const exit = /^Exited \((\d+)\)/.exec(c.status);
			if (on("container_failed") && c.state === "exited" && exit && !IGNORED_EXIT.has(Number(exit[1])) && c.project && deployed.has(c.project)) {
				out.push({ rule: "container_failed", target, hostId: host.id, title: `${host.name}: ${c.name} crashed`, detail: c.status, link });
			}
		}
	}
	return out;
}

export class Alerting {
	private readonly since = new Map<string, number>();
	private running = false;

	constructor(
		private readonly hub: Hub,
		private readonly domain: string,
		private readonly startedAt = Date.now(),
		private readonly fetcher: typeof fetch = fetch,
	) {}

	link(path: string): string {
		return `${this.domain}${path}`;
	}

	/** Opens alerts whose condition held long enough and resolves those whose condition is gone. */
	async evaluate(now = Date.now()): Promise<{ opened: Alert[]; resolved: Alert[] }> {
		if (this.running) return { opened: [], resolved: [] };
		this.running = true;
		try {
			const settings = await ruleSettings();
			const hosts = await listHosts();
			const deployedProjects = new Map<number, Set<string>>();
			for (const s of await listAllStacks()) {
				if (s.deployedVersion === null) continue;
				if (!deployedProjects.has(s.hostId)) deployedProjects.set(s.hostId, new Set());
				deployedProjects.get(s.hostId)!.add(s.name);
			}
			const current = conditions({
				hosts,
				online: (id) => this.hub.isOnline(id),
				hub: this.hub,
				settings,
				deployedProjects,
				now,
				startedAt: this.startedAt,
				link: (p) => this.link(p),
			});
			const seen = new Set<string>();
			const active = new Map<string, Condition>();
			for (const c of current) {
				const key = `${c.rule}|${c.target}`;
				seen.add(key);
				if (!this.since.has(key)) this.since.set(key, now);
				const minutes = settings.get(c.rule)?.minutes ?? RULE[c.rule].minutes ?? 0;
				if (c.rule === "host_offline" || now - this.since.get(key)! >= minutes * 60_000) active.set(key, c);
			}
			for (const key of this.since.keys()) if (!seen.has(key)) this.since.delete(key);

			const opened: Alert[] = [];
			const resolved: Alert[] = [];
			const firing = await firingAlerts();
			const firingKeys = new Set(firing.map((a) => `${a.rule}|${a.target}`));
			for (const [key, c] of active) {
				if (firingKeys.has(key)) continue;
				const alert = await openAlert({
					rule: c.rule,
					target: c.target,
					hostId: c.hostId,
					severity: RULE[c.rule].severity,
					title: c.title,
					detail: c.detail,
					link: c.link,
				});
				if (alert) opened.push(alert);
			}
			const hostIds = new Set(hosts.map((h) => h.id));
			for (const a of firing) {
				if (active.has(`${a.rule}|${a.target}`)) continue;
				const hostGone = a.hostId !== null && !hostIds.has(a.hostId);
				const enabled = settings.get(a.rule)?.enabled !== false;
				const hostKnown = a.hostId === null || a.rule === "host_offline" || this.hub.isOnline(a.hostId);
				if (!hostGone && enabled && !hostKnown) continue;
				if (!hostGone && enabled && a.hostId !== null && STORAGE_RULES.has(a.rule)) {
					const storage = this.hub.storage(a.hostId);
					if (!storage || now - storage.takenAt >= STORAGE_FRESH_MS) continue;
				}
				await resolveAlert(a.id);
				resolved.push({ ...a, status: "resolved", resolvedAt: new Date(now).toISOString() });
			}
			const hostName = new Map(hosts.map((h) => [h.id, h.name]));
			for (const a of opened) await this.notify(a, "firing", settings, hostName.get(a.hostId ?? -1) ?? null);
			for (const a of resolved) await this.notify(a, "resolved", settings, hostName.get(a.hostId ?? -1) ?? null);
			setFiring(firing.length + opened.length - resolved.length);
			if (opened.length + resolved.length > 0) this.hub.publish("alerts", JSON.stringify({ type: "changed", topic: "alerts" }));
			return { opened, resolved };
		} finally {
			this.running = false;
		}
	}

	async deployFinished(run: {
		stack: { id: number; name: string; hostId: number };
		action: string;
		ok: boolean;
		error: string | null;
		deployId: number;
	}): Promise<void> {
		if (run.ok) return;
		const host = (await listHosts()).find((h) => h.id === run.stack.hostId)?.name ?? "host";
		const verb = run.action === "upgrade" ? "Update" : run.action === "deploy" ? "Deploy" : `${run.action[0]!.toUpperCase()}${run.action.slice(1)}`;
		await this.event("deploy_failed", {
			target: `deploy:${run.deployId}`,
			hostId: run.stack.hostId,
			title: `${host}: ${verb} of ${run.stack.name} failed`,
			detail: run.error,
			link: this.link(`/hosts/${run.stack.hostId}/stacks/${run.stack.id}/deploys/${run.deployId}`),
		});
	}

	async backupFinished(run: { stack: { id: number; name: string; hostId: number }; backupId: number; ok: boolean; error: string | null }): Promise<void> {
		if (run.ok) return;
		const host = (await listHosts()).find((h) => h.id === run.stack.hostId)?.name ?? "host";
		await this.event("backup_failed", {
			target: `backup:${run.backupId}`,
			hostId: run.stack.hostId,
			title: `${host}: backup of ${run.stack.name} failed`,
			detail: run.error,
			link: this.link(`/hosts/${run.stack.hostId}/stacks/${run.stack.id}/backups/${run.backupId}`),
		});
	}

	/** One notice per new version a service is offered, never twice for the same one. */
	async updatesChecked(
		offers: { stack: { id: number; name: string; hostId: number }; service: string; current: string; tag: string; level: string }[],
	): Promise<number> {
		let sent = 0;
		for (const o of offers) {
			const alert = await this.event(
				"update_available",
				{
					target: `update:${o.stack.id}:${o.service}:${o.tag}`,
					hostId: o.stack.hostId,
					title: `${o.stack.name}: ${o.service} can update to ${o.tag}`,
					detail: `A ${o.level} release. It runs ${o.current} now.`,
					link: this.link(`/hosts/${o.stack.hostId}/stacks/${o.stack.id}?tab=updates`),
				},
				true,
			);
			if (alert) sent++;
		}
		return sent;
	}

	async firewallReverted(hostId: number, detail: string): Promise<void> {
		const host = (await listHosts()).find((h) => h.id === hostId)?.name ?? "host";
		await this.event("firewall_reverted", {
			target: `firewall:${hostId}:${Date.now()}`,
			hostId,
			title: `${host}: new firewall rules were undone`,
			detail,
			link: this.link(`/hosts/${hostId}?tab=firewall`),
		});
	}

	/** Something that happened once, such as a failed backup. With `once`, the same target is reported only the first time. */
	async event(
		rule: RuleId,
		input: { target: string; hostId: number | null; title: string; detail: string | null; link: string | null },
		once = false,
	): Promise<Alert | null> {
		const settings = await ruleSettings();
		if (settings.get(rule)?.enabled === false) return null;
		const alert = await recordEvent(
			{ rule, target: input.target, hostId: input.hostId, severity: RULE[rule].severity, title: input.title, detail: input.detail, link: input.link },
			once,
		);
		if (!alert) return null;
		const host = input.hostId ? ((await listHosts()).find((h) => h.id === input.hostId)?.name ?? null) : null;
		await this.notify(alert, "event", settings, host);
		this.hub.publish("alerts", JSON.stringify({ type: "changed", topic: "alerts" }));
		return alert;
	}

	private async notify(alert: Alert, kind: "firing" | "resolved" | "event", settings: Map<RuleId, RuleSetting>, host: string | null): Promise<void> {
		const wanted = settings.get(alert.rule)?.channels ?? null;
		const channels = (await enabledChannels()).filter((c) => wanted === null || wanted.includes(c.id));
		const notice: Notice = {
			kind,
			severity: alert.severity,
			title: alert.title,
			detail: alert.detail,
			link: alert.link,
			rule: alert.rule,
			host,
			at: kind === "resolved" ? (alert.resolvedAt ?? new Date().toISOString()) : alert.startedAt,
		};
		await Promise.all(
			channels.map(async (c) => {
				try {
					await deliver(c.config, notice, this.fetcher);
					await recordDelivery(c.id, null);
				} catch (err) {
					const message = (err as Error).message;
					logger.warn(`Alert channel ${c.name} failed: ${message}`);
					await recordDelivery(c.id, message);
				}
			}),
		);
	}
}
