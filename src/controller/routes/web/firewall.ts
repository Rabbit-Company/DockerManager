import type { Web } from "@rabbit-company/web";
import { checkPolicy, formatRule } from "../../../shared/firewall.ts";
import { checkCsrf, clientIp, field, formData, page, redirect } from "../../auth.ts";
import { getFirewall } from "../../db/firewall.ts";
import { getHost } from "../../db/hosts.ts";
import type { FirewallInput, FirewallManager } from "../../firewall.ts";
import type { Hub } from "../../hub.ts";
import { ApiError, notFound } from "../../lib/errors.ts";
import type { SafeHtml } from "../../ssr/html.ts";
import { shell } from "../../ssr/layout.ts";
import { firewallTab } from "../../ssr/pages/firewall.ts";
import { hostPage } from "../../ssr/pages/hosts.ts";
import type { AppState } from "../../types.ts";
import { flash, hostView, intParam, popFlash, requireAuth, treeHosts } from "./common.ts";

/** The Firewall tab of a host, with the stored rules or the ones just posted. */
export async function firewallBody(
	hub: Hub,
	manager: FirewallManager,
	hostId: number,
	csrf: string,
	posted?: { values: FirewallInput; errors: string[] },
): Promise<SafeHtml> {
	const stored = await getFirewall(hostId);
	let live = null;
	let liveError: string | null = null;
	if (hub.isOnline(hostId)) {
		try {
			live = await manager.inspect(hostId);
		} catch (err) {
			liveError = `The agent could not read the firewall: ${(err as Error).message}`;
		}
	}
	// After an undo or a failure the stored text is what was tried, so show what is in force instead.
	const active = live && (stored?.status === "reverted" || stored?.status === "failed") ? live.state.policy : undefined;
	const values: FirewallInput = posted?.values ??
		(active !== undefined
			? {
					rules: active ? active.rules.map((r) => formatRule(r) + "\n").join("") : "",
					hostDefault: active?.hostDefault ?? "accept",
					containerDefault: active?.containerDefault ?? "accept",
					sshPort: String(active?.sshPort ?? 22),
				}
			: null) ?? {
			rules: stored?.rules ?? "",
			hostDefault: stored?.hostDefault ?? "accept",
			containerDefault: stored?.containerDefault ?? "accept",
			sshPort: String(stored?.sshPort ?? 22),
		};
	return firewallTab({ hostId, stored, live, liveError, containers: hub.snapshot(hostId)?.containers ?? [], values, errors: posted?.errors ?? [], csrf });
}

export function firewallRoutes(app: Web<AppState>, hub: Hub, manager: FirewallManager): void {
	const load = async (id: string | undefined) => {
		const host = await getHost(intParam(id));
		if (!host) throw notFound("This host does not exist.");
		return host;
	};
	const back = (id: number) => `/hosts/${id}?tab=firewall`;

	app.post("/hosts/:id/firewall", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const host = await load(ctx.params.id);
		const values: FirewallInput = {
			rules: field(form, "rules").slice(0, 64_000),
			hostDefault: field(form, "host_default"),
			containerDefault: field(form, "container_default"),
			sshPort: field(form, "ssh_port"),
		};
		const { errors } = checkPolicy(values);
		if (field(form, "intent") === "apply" && errors.length === 0) {
			try {
				await manager.apply(host.id, values, { id: auth.user.id, ip: clientIp(ctx) });
				return redirect(back(host.id));
			} catch (err) {
				if (!(err instanceof ApiError)) throw err;
				errors.push(err.message);
			}
		}
		const body = await firewallBody(hub, manager, host.id, auth.session.csrf, { values, errors });
		const tree = await treeHosts(hub);
		const content = hostPage(hostView(hub, host), "firewall", auth.session.csrf, { body });
		return page(
			shell(
				{
					title: host.name,
					crumbs: [{ label: "Datacenter", href: "/" }, { label: host.name }],
					watch: [`host:${host.id}`],
					hostId: host.id,
					auth,
					tree,
					flash: popFlash(auth),
				},
				content,
			),
			errors.length > 0 ? 400 : 200,
		);
	});

	for (const [path, action, done] of [
		["keep", "keep", "Kept the new rules."],
		["undo", "undo", "The previous rules are back."],
		["disable", "disable", "Removed all rules of this program. Docker's own rules apply again."],
	] as const) {
		app.post(`/hosts/:id/firewall/${path}`, async (ctx) => {
			const auth = await requireAuth(ctx);
			if (auth instanceof Response) return auth;
			checkCsrf(auth, await formData(ctx));
			const host = await load(ctx.params.id);
			try {
				await manager[action](host.id, { id: auth.user.id, ip: clientIp(ctx) });
				flash(auth, { kind: "ok", text: done });
			} catch (err) {
				flash(auth, { kind: "error", text: (err as Error).message });
			}
			return redirect(back(host.id));
		});
	}
}
