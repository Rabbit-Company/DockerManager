import { checkPolicy, covers, type FirewallPolicy, type FirewallRule, type FirewallScope } from "../shared/firewall.ts";
import { audit } from "./db/audit.ts";
import { getFirewall, saveFirewall, setFirewallStatus, type StoredFirewall } from "./db/firewall.ts";
import type { Hub } from "./hub.ts";
import { ApiError } from "./lib/errors.ts";

export const CONFIRM_SECONDS = 90;

type User = { id: number | null; ip: string | null };

/** What the rules do to one port, read like a sentence: "allowed from 10.0.0.0/8, otherwise blocked". */
export function verdict(
	rules: FirewallRule[],
	scope: FirewallScope,
	port: number,
	protocol: string,
	fallback: "accept" | "drop",
): { text: string; open: "all" | "some" | "none"; lines: number[] } {
	const parts: string[] = [];
	const lines: number[] = [];
	let allowSome = false;
	let denySome = false;
	let final: "allow" | "deny" | null = null;
	for (const r of rules) {
		if (r.scope !== scope || !covers(r, port, protocol)) continue;
		lines.push(r.line);
		const word = r.action === "allow" ? "allowed" : "blocked";
		if (r.source) {
			parts.push(`${word} from ${r.source}`);
			if (r.action === "allow") allowSome = true;
			else denySome = true;
			continue;
		}
		parts.push(parts.length > 0 ? `otherwise ${word}` : `${word} for everyone`);
		final = r.action;
		break;
	}
	if (final === null) {
		parts.push(`${parts.length > 0 ? "otherwise " : ""}${fallback === "accept" ? "open" : "blocked"}${parts.length > 0 ? "" : " by default"}`);
		final = fallback === "accept" ? "allow" : "deny";
	}
	const open = final === "allow" ? (denySome ? "some" : "all") : allowSome ? "some" : "none";
	return { text: parts.join(", "), open, lines };
}

export interface FirewallInput {
	rules: string;
	hostDefault: string;
	containerDefault: string;
	sshPort: string;
}

export class FirewallManager {
	/** Called when the agent reverted or restored rules on its own, for alerts. */
	onReverted: ((hostId: number, detail: string) => void) | null = null;

	constructor(private readonly hub: Hub) {
		hub.onFirewall = (hostId, event, detail) => void this.agentEvent(hostId, event, detail);
	}

	inspect(hostId: number) {
		return this.hub.request(hostId, "firewall.inspect", {}, 30_000);
	}

	private async agentEvent(hostId: number, event: string, detail: string): Promise<void> {
		if (event === "reverted") {
			await setFirewallStatus(hostId, "reverted", detail);
			await audit({ userId: null, hostId, action: "firewall.revert", detail, ip: null });
			this.onReverted?.(hostId, detail);
		}
		this.hub.publish(`host:${hostId}`, JSON.stringify({ type: "changed", topic: `host:${hostId}` }));
	}

	/** Sends the rules to the agent, which applies them and reverts unless they are kept within the confirm time. */
	async apply(hostId: number, input: FirewallInput, user: User): Promise<{ pendingUntil: number }> {
		const checked = checkPolicy(input);
		if (!checked.policy) throw new ApiError(400, "invalid", checked.errors.join(" "));
		const policy: FirewallPolicy = checked.policy;
		const base: Omit<StoredFirewall, "updatedAt"> = {
			hostId,
			rules: input.rules.replace(/\r\n?/g, "\n"),
			hostDefault: policy.hostDefault,
			containerDefault: policy.containerDefault,
			sshPort: policy.sshPort,
			status: "pending",
			detail: null,
			pendingToken: null,
			pendingUntil: null,
		};
		try {
			const result = await this.hub.request(hostId, "firewall.apply", { policy, confirmSeconds: CONFIRM_SECONDS }, 60_000);
			await saveFirewall({ ...base, pendingToken: result.token, pendingUntil: new Date(result.pendingUntil).toISOString() });
			await audit({ userId: user.id, hostId, action: "firewall.apply", target: `${policy.rules.length} rule(s)`, ip: user.ip });
			return { pendingUntil: result.pendingUntil };
		} catch (err) {
			await saveFirewall({ ...base, status: "failed", detail: (err as Error).message });
			await audit({ userId: user.id, hostId, action: "firewall.apply", ok: false, detail: (err as Error).message, ip: user.ip });
			throw new ApiError(409, "failed", `The rules were not applied. ${(err as Error).message}`);
		}
	}

	async keep(hostId: number, user: User): Promise<void> {
		const stored = await getFirewall(hostId);
		if (!stored?.pendingToken) throw new ApiError(409, "nothing", "There is nothing waiting to be kept.");
		const { confirmed } = await this.hub.request(hostId, "firewall.confirm", { token: stored.pendingToken }, 30_000);
		if (!confirmed) {
			await setFirewallStatus(hostId, "reverted", "The time to keep the rules ran out, so the previous ones are back.");
			throw new ApiError(409, "late", "Too late, the time ran out and the previous rules are back. Apply again.");
		}
		await setFirewallStatus(hostId, "active", null);
		await audit({ userId: user.id, hostId, action: "firewall.keep", ip: user.ip });
	}

	async undo(hostId: number, user: User): Promise<void> {
		const stored = await getFirewall(hostId);
		if (!stored?.pendingToken) throw new ApiError(409, "nothing", "There is nothing waiting to be undone.");
		await this.hub.request(hostId, "firewall.revert", { token: stored.pendingToken }, 30_000);
		await setFirewallStatus(hostId, "reverted", "Undone by hand, the previous rules are back.");
		await audit({ userId: user.id, hostId, action: "firewall.undo", ip: user.ip });
	}

	async disable(hostId: number, user: User): Promise<void> {
		await this.hub.request(hostId, "firewall.disable", {}, 30_000);
		await setFirewallStatus(hostId, "off", null);
		await audit({ userId: user.id, hostId, action: "firewall.disable", ip: user.ip });
	}
}
