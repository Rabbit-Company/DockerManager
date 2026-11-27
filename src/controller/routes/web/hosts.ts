import type { Web } from "@rabbit-company/web";
import { CONTAINER_ACTIONS, type ContainerAction, type ContainerDetail } from "../../../shared/protocol.ts";
import { checkHostName, isContainerRef } from "../../../shared/validate.ts";
import { checkCsrf, clientIp, field, formData, NO_STORE, page, redirect, safeNext, type Auth } from "../../auth.ts";
import { config } from "../../config.ts";
import { audit, listAudit } from "../../db/audit.ts";
import { HOST_TARGET, isRange, MIN_WINDOW, readSeries, readWindow } from "../../db/metrics.ts";
import { listAllStacks, listStacks, type Stack } from "../../db/stacks.ts";
import { countUpdates } from "../../ssr/pages/updates.ts";
import type { Updates } from "../../updates.ts";
import type { FirewallManager } from "../../firewall.ts";
import { firewallBody } from "./firewall.ts";
import { stacksTab } from "../../ssr/pages/stacks.ts";
import { createHost, deleteHost, getHost, listHosts, renameHost, renewJoinToken, type Host } from "../../db/hosts.ts";
import { AgentOffline, type Hub } from "../../hub.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import { html, type SafeHtml } from "../../ssr/html.ts";
import { shell, type Crumb, type Flash, type Section } from "../../ssr/layout.ts";
import {
	actionButtons,
	auditPage,
	containerPage,
	hostPage,
	isHostTab,
	joinPage,
	newHostPage,
	overviewPage,
	removeContainerPage,
	removeHostPage,
} from "../../ssr/pages/hosts.ts";
import type { AppContext, AppState } from "../../types.ts";
import { flash, hostView, intParam, popFlash, requireAuth, treeHosts } from "./common.ts";

interface JoinFlash extends Flash {
	joinToken?: string;
}

export function joinCommand(token: string, domain = config.server.domain): string {
	return `curl -fsSL ${domain}/install.sh | sudo sh -s -- --token ${token}`;
}

async function render(
	hub: Hub,
	auth: Auth,
	options: {
		title: string;
		section?: Section;
		crumbs?: Crumb[];
		watch?: string[];
		hostId?: number;
		containerId?: string;
		actions?: SafeHtml;
		flash?: Flash | null;
	},
	content: SafeHtml,
	status = 200,
): Promise<Response> {
	const tree = await treeHosts(hub);
	return page(shell({ ...options, auth, tree, flash: options.flash === undefined ? popFlash(auth) : options.flash }, content), status);
}

async function loadHost(ctx: AppContext): Promise<Host> {
	const host = await getHost(intParam(ctx.params.id));
	if (!host) throw notFound("This host does not exist.");
	return host;
}

function containerRef(ctx: AppContext): string {
	const ref = ctx.params.cid ?? "";
	if (!isContainerRef(ref)) throw notFound("This container does not exist.");
	return ref;
}

function failure(err: unknown): string {
	if (err instanceof AgentOffline) return err.message;
	return `The agent reported: ${(err as Error).message}`;
}

export function hostRoutes(app: Web<AppState>, hub: Hub, updates: Updates, firewall: FirewallManager): void {
	async function updateCounts(stacks: Stack[]): Promise<Map<number, number | null>> {
		const out = new Map<number, number | null>();
		for (const stack of stacks) {
			const list = await updates.forStack(stack);
			out.set(stack.id, list.some((u) => u.checkedAt !== null) ? countUpdates(list) : null);
		}
		return out;
	}

	app.get("/", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const hosts = await listHosts();
		const views = hosts.map((h) => hostView(hub, h));
		const available = [...(await updateCounts(await listAllStacks())).values()].reduce<number>((a, b) => a + (b ?? 0), 0);
		const actions = html`<a class="button primary" href="/hosts/new">Add host</a>`;
		return render(hub, auth, { title: "Datacenter", watch: ["hosts", "metrics"], actions }, overviewPage(views, available));
	});

	app.get("/hosts/new", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		return render(hub, auth, { title: "Add host", crumbs: [{ label: "Datacenter", href: "/" }] }, newHostPage(auth.session.csrf));
	});

	app.post("/hosts", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const name = checkHostName(field(form, "name"));
		if (!name.ok) {
			return render(
				hub,
				auth,
				{ title: "Add host", crumbs: [{ label: "Datacenter", href: "/" }] },
				newHostPage(auth.session.csrf, field(form, "name"), name.error),
				400,
			);
		}
		const { host, token } = await createHost(name.value);
		await audit({ userId: auth.user.id, hostId: host.id, action: "host.create", target: host.name, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: `Created ${host.name}. Run the command below on the server.`, joinToken: token } as JoinFlash);
		return redirect(`/hosts/${host.id}/join`);
	});

	app.get("/hosts/:id/join", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const host = await loadHost(ctx);
		const note = popFlash<JoinFlash>(auth);
		const command = note?.joinToken ? joinCommand(note.joinToken) : null;
		return render(
			hub,
			auth,
			{
				title: `Join ${host.name}`,
				crumbs: [{ label: "Datacenter", href: "/" }, { label: host.name, href: `/hosts/${host.id}` }, { label: "Join" }],
				watch: [`host:${host.id}`],
				hostId: host.id,
				flash: note ? { kind: note.kind, text: note.text } : null,
			},
			joinPage({ host, command, minutes: config.agents.joinTokenMinutes, csrf: auth.session.csrf, domain: config.server.domain }),
		);
	});

	app.post("/hosts/:id/join", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const host = await loadHost(ctx);
		const token = await renewJoinToken(host.id);
		if (!token) throw notFound("This host does not exist.");
		await audit({ userId: auth.user.id, hostId: host.id, action: "host.join_token", target: host.name, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: "New join command created.", joinToken: token } as JoinFlash);
		return redirect(`/hosts/${host.id}/join`);
	});

	app.get("/hosts/:id", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const host = await loadHost(ctx);
		const params = new URL(ctx.req.url).searchParams;
		const requested = params.get("tab");
		const tab = isHostTab(requested) ? requested : "containers";
		const range = params.get("range");
		const stacks = await listStacks(host.id);
		return render(
			hub,
			auth,
			{
				title: host.name,
				crumbs: [{ label: "Datacenter", href: "/" }, { label: host.name }],
				watch: [`host:${host.id}`, `metrics:${host.id}`],
				hostId: host.id,
			},
			hostPage(hostView(hub, host), tab, auth.session.csrf, {
				range: isRange(range) ? range : "1h",
				stacks: new Map(stacks.map((s) => [s.name, s.id])),
				body:
					tab === "stacks"
						? stacksTab(hostView(hub, host), stacks, auth.session.csrf, await updateCounts(stacks))
						: tab === "firewall"
							? await firewallBody(hub, firewall, host.id, auth.session.csrf)
							: undefined,
			}),
		);
	});

	app.post("/hosts/:id/rename", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const host = await loadHost(ctx);
		const name = checkHostName(field(form, "name"));
		if (!name.ok) {
			flash(auth, { kind: "error", text: name.error });
			return redirect(`/hosts/${host.id}?tab=settings`);
		}
		if (name.value !== host.name) {
			await renameHost(host.id, name.value);
			await audit({ userId: auth.user.id, hostId: host.id, action: "host.rename", target: `${host.name} -> ${name.value}`, ip: clientIp(ctx) });
		}
		flash(auth, { kind: "ok", text: "Saved." });
		return redirect(`/hosts/${host.id}?tab=settings`);
	});

	app.get("/hosts/:id/remove", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const host = await loadHost(ctx);
		return render(
			hub,
			auth,
			{
				title: `Remove ${host.name}`,
				crumbs: [{ label: "Datacenter", href: "/" }, { label: host.name, href: `/hosts/${host.id}` }, { label: "Remove" }],
				hostId: host.id,
			},
			removeHostPage(host, auth.session.csrf),
		);
	});

	app.post("/hosts/:id/remove", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const host = await loadHost(ctx);
		await audit({ userId: auth.user.id, hostId: host.id, action: "host.remove", target: host.name, ip: clientIp(ctx) });
		await deleteHost(host.id);
		hub.disconnect(host.id);
		flash(auth, { kind: "ok", text: `Removed ${host.name}.` });
		return redirect("/");
	});

	app.get("/hosts/:id/containers/:cid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const host = await loadHost(ctx);
		const ref = containerRef(ctx);
		const summary = hub.snapshot(host.id)?.containers.find((c) => c.id === ref || c.name === ref);
		if (!summary)
			throw notFound(hub.isOnline(host.id) ? "This container no longer exists on the host." : "The agent is offline, so this container cannot be shown.");
		let detail: ContainerDetail | null = null;
		let detailError: string | null = null;
		if (hub.isOnline(host.id)) {
			try {
				detail = await hub.request(host.id, "container.inspect", { id: summary.id }, 10_000);
			} catch (err) {
				detailError = (err as Error).message;
			}
		}
		const path = `/hosts/${host.id}/containers/${summary.id}`;
		const state = detail?.state ?? summary.state;
		const actions = html`${actionButtons(host.id, { id: summary.id, state }, auth.session.csrf, path)}
			<a class="button danger" href="${path}/remove">Remove</a>`;
		return render(
			hub,
			auth,
			{
				title: summary.name,
				crumbs: [{ label: "Datacenter", href: "/" }, { label: host.name, href: `/hosts/${host.id}` }, { label: summary.name }],
				watch: [`host:${host.id}`, `metrics:${host.id}`],
				hostId: host.id,
				containerId: summary.id,
				actions,
			},
			containerPage({
				hostId: host.id,
				online: hub.isOnline(host.id),
				summary,
				detail,
				detailError,
				csrf: auth.session.csrf,
				latest: hub.latest(host.id),
				disk: hub.disk(host.id),
				cpus: hub.latest(host.id)?.host?.cpus ?? (hub.facts(host.id) ?? host.facts)?.cpus ?? null,
				range: (() => {
					const r = new URL(ctx.req.url).searchParams.get("range");
					return isRange(r) ? r : "1h";
				})(),
			}),
		);
	});

	app.post("/hosts/:id/containers/:cid/action", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const host = await loadHost(ctx);
		const ref = containerRef(ctx);
		const action = field(form, "action") as ContainerAction;
		const next = safeNext(field(form, "next"), `/hosts/${host.id}/containers/${ref}`);
		if (!CONTAINER_ACTIONS.includes(action) || action === "remove") throw notFound("Unknown action.");
		const name = hub.snapshot(host.id)?.containers.find((c) => c.id === ref)?.name ?? ref.slice(0, 12);
		try {
			await hub.request(host.id, "container.action", { id: ref, action }, 60_000);
			await audit({ userId: auth.user.id, hostId: host.id, action: `container.${action}`, target: name, ip: clientIp(ctx) });
			const done = { start: "Started", stop: "Stopped", restart: "Restarted" }[action as "start" | "stop" | "restart"];
			flash(auth, { kind: "ok", text: `${done} ${name}.` });
		} catch (err) {
			await audit({
				userId: auth.user.id,
				hostId: host.id,
				action: `container.${action}`,
				target: name,
				ok: false,
				detail: (err as Error).message,
				ip: clientIp(ctx),
			});
			flash(auth, { kind: "error", text: `Could not ${action} ${name}. ${failure(err)}` });
		}
		return redirect(next);
	});

	app.get("/hosts/:id/containers/:cid/remove", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const host = await loadHost(ctx);
		const ref = containerRef(ctx);
		const summary = hub.snapshot(host.id)?.containers.find((c) => c.id === ref);
		if (!summary) throw notFound("This container no longer exists on the host.");
		return render(
			hub,
			auth,
			{
				title: `Remove ${summary.name}`,
				crumbs: [
					{ label: "Datacenter", href: "/" },
					{ label: host.name, href: `/hosts/${host.id}` },
					{ label: summary.name, href: `/hosts/${host.id}/containers/${summary.id}` },
					{ label: "Remove" },
				],
				hostId: host.id,
				containerId: summary.id,
			},
			removeContainerPage(host.id, summary, auth.session.csrf),
		);
	});

	app.post("/hosts/:id/containers/:cid/remove", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const host = await loadHost(ctx);
		const ref = containerRef(ctx);
		const name = hub.snapshot(host.id)?.containers.find((c) => c.id === ref)?.name ?? ref.slice(0, 12);
		try {
			await hub.request(host.id, "container.action", { id: ref, action: "remove", removeVolumes: field(form, "volumes") === "1" }, 60_000);
			await audit({ userId: auth.user.id, hostId: host.id, action: "container.remove", target: name, ip: clientIp(ctx) });
			flash(auth, { kind: "ok", text: `Removed ${name}.` });
			return redirect(`/hosts/${host.id}`);
		} catch (err) {
			await audit({
				userId: auth.user.id,
				hostId: host.id,
				action: "container.remove",
				target: name,
				ok: false,
				detail: (err as Error).message,
				ip: clientIp(ctx),
			});
			flash(auth, { kind: "error", text: `Could not remove ${name}. ${failure(err)}` });
			return redirect(`/hosts/${host.id}/containers/${ref}`);
		}
	});

	app.get("/hosts/:id/metrics.json", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response)
			return Response.json({ error: "unauthorized", message: "Sign in first." }, { status: 401, headers: { "Cache-Control": NO_STORE } });
		const host = await loadHost(ctx);
		const params = new URL(ctx.req.url).searchParams;
		const range = params.get("range");
		const stacks = await listStacks(host.id);
		const target = params.get("target") ?? HOST_TARGET;
		if (target.length > 255) throw badRequest("Unknown target.");
		let series;
		if (params.has("from") || params.has("to")) {
			const from = Number(params.get("from"));
			const to = Number(params.get("to"));
			const now = Math.floor(Date.now() / 1000);
			if (!Number.isInteger(from) || !Number.isInteger(to) || to - from < MIN_WINDOW || from < now - 400 * 86_400 || to > now + 3600)
				throw badRequest("The time window is not valid.");
			series = await readWindow(host.id, target, from, to, config.metrics, now);
		} else {
			if (!isRange(range)) throw badRequest("Unknown range.");
			series = await readSeries(host.id, target, range);
		}
		const cpus = (hub.facts(host.id) ?? host.facts)?.cpus ?? null;
		return Response.json({ ...series, cpus }, { headers: { "Cache-Control": NO_STORE } });
	});

	app.get("/audit", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		return render(
			hub,
			auth,
			{ title: "Audit log", section: "audit", crumbs: [{ label: "Datacenter", href: "/" }, { label: "Audit log" }] },
			auditPage(await listAudit({ limit: 200 })),
		);
	});
}
