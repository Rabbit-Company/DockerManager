import type { Web } from "@rabbit-company/web";
import { AUTO_LEVELS, POLICIES, type Policy } from "../../../shared/images.ts";
import { checkCsrf, clientIp, field, formData, page, redirect, type Auth } from "../../auth.ts";
import { config } from "../../config.ts";
import { audit } from "../../db/audit.ts";
import { getHost, listHosts } from "../../db/hosts.ts";
import { getStack, listAllStacks, type Stack } from "../../db/stacks.ts";
import { deleteRegistryLogin, listRegistryLogins, saveRegistryLogin, saveServiceSetting } from "../../db/updates.ts";
import type { Hub } from "../../hub.ts";
import { ApiError, notFound } from "../../lib/errors.ts";
import { cleanText } from "../../../shared/validate.ts";
import type { SafeHtml } from "../../ssr/html.ts";
import { shell, type Crumb, type Flash } from "../../ssr/layout.ts";
import { hasUpdate, registriesPage, updatesPage, type UpdateRow } from "../../ssr/pages/updates.ts";
import type { AppContext, AppState } from "../../types.ts";
import type { Updates } from "../../updates.ts";
import { flash, intParam, popFlash, requireAuth, treeHosts } from "./common.ts";

const REGISTRY = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

export function nextRunText(lastRun: string | null, hours: number): string | null {
	if (!lastRun) return "within a minute";
	const due = Date.parse(lastRun) + hours * 3_600_000 - Date.now();
	if (due <= 60_000) return "within a minute";
	const minutes = Math.round(due / 60_000);
	return minutes < 90 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

export function updateRoutes(app: Web<AppState>, hub: Hub, updates: Updates): void {
	async function render(
		auth: Auth,
		options: { title: string; crumbs: Crumb[]; watch?: string[]; flash?: Flash | null; actions?: SafeHtml },
		content: SafeHtml,
		status = 200,
	) {
		const tree = await treeHosts(hub);
		return page(shell({ ...options, section: "updates", auth, tree, flash: options.flash === undefined ? popFlash(auth) : options.flash }, content), status);
	}

	async function loadStack(ctx: AppContext): Promise<Stack> {
		const host = await getHost(intParam(ctx.params.id));
		const stack = await getStack(intParam(ctx.params.sid));
		if (!host || !stack || stack.hostId !== host.id) throw notFound("This stack does not exist.");
		return stack;
	}

	app.post("/hosts/:id/stacks/:sid/updates/check", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const stack = await loadStack(ctx);
		await updates.checkStack(stack);
		flash(auth, { kind: "ok", text: "Checked the registries." });
		return redirect(`/hosts/${stack.hostId}/stacks/${stack.id}?tab=updates`);
	});

	app.post("/hosts/:id/stacks/:sid/updates", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const stack = await loadStack(ctx);
		const back = `/hosts/${stack.hostId}/stacks/${stack.id}?tab=updates`;
		const list = await updates.forStack(stack);
		const intent = field(form, "intent");

		for (const u of list) {
			const policy = field(form, `policy:${u.service}`) as Policy;
			const auto = field(form, `auto:${u.service}`) as "off" | "patch" | "minor";
			const next = { policy: POLICIES.includes(policy) ? policy : u.setting.policy, auto: AUTO_LEVELS.includes(auto) && u.editable ? auto : u.setting.auto };
			if (next.policy !== u.setting.policy || next.auto !== u.setting.auto) await saveServiceSetting(stack.id, u.service, next);
		}
		if (intent === "settings") {
			flash(auth, { kind: "ok", text: "Saved the update settings." });
			return redirect(back);
		}

		let changes: { service: string; tag: string | null }[];
		if (intent === "all") {
			changes = list.filter((u) => hasUpdate(u) && (u.offer === null || u.editable)).map((u) => ({ service: u.service, tag: u.offer?.tag ?? null }));
		} else if (intent.startsWith("update:")) {
			const [, service, tag] = intent.split(":");
			const u = list.find((x) => x.service === service);
			if (!u || !hasUpdate(u)) throw notFound("That update is no longer offered. Reload the page.");
			if (tag && !u.newer.some((n) => n.tag === tag)) throw notFound("That tag is no longer offered. Reload the page.");
			changes = [{ service: u.service, tag: tag || null }];
		} else {
			throw notFound("Unknown action.");
		}
		try {
			const { deployId } = await updates.upgrade(stack, changes, { id: auth.user.id, ip: clientIp(ctx) });
			return redirect(`/hosts/${stack.hostId}/stacks/${stack.id}/deploys/${deployId}`);
		} catch (err) {
			if (!(err instanceof ApiError)) throw err;
			flash(auth, { kind: "error", text: err.message });
			return redirect(back);
		}
	});

	app.get("/updates", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const hosts = new Map((await listHosts()).map((h) => [h.id, h.name]));
		const rows: UpdateRow[] = [];
		const errors: UpdateRow[] = [];
		for (const stack of await listAllStacks()) {
			for (const update of await updates.forStack(stack)) {
				const row = { hostId: stack.hostId, hostName: hosts.get(stack.hostId) ?? "", stack, update };
				if (hasUpdate(update)) rows.push(row);
				else if (update.error && update.setting.policy !== "off") errors.push(row);
			}
		}
		return render(
			auth,
			{ title: "Updates", crumbs: [{ label: "Datacenter", href: "/" }, { label: "Updates" }] },
			updatesPage({
				rows,
				errors,
				csrf: auth.session.csrf,
				lastRun: updates.lastRun,
				checking: updates.running,
				nextRun: nextRunText(updates.lastRun, config.updates.checkHours),
			}),
		);
	});

	app.post("/updates/check", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const started = !updates.running;
		const run = updates.check();
		await Promise.race([run, Bun.sleep(8000)]);
		flash(auth, {
			kind: "ok",
			text: updates.running
				? "Checking the registries. Reload this page in a minute."
				: started
					? "Checked the registries."
					: "A check was already running and is done now.",
		});
		return redirect("/updates");
	});

	app.get("/registries", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		return render(
			auth,
			{ title: "Registry logins", crumbs: [{ label: "Datacenter", href: "/" }, { label: "Updates", href: "/updates" }, { label: "Registries" }] },
			registriesPage(await listRegistryLogins(), auth.session.csrf),
		);
	});

	app.post("/registries", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const registry = field(form, "registry")
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, "")
			.replace(/\/+$/, "");
		const username = cleanText(field(form, "username"));
		const password = field(form, "password");
		const again = (error: string) =>
			listRegistryLogins().then((logins) =>
				render(
					auth,
					{
						title: "Registry logins",
						crumbs: [{ label: "Datacenter", href: "/" }, { label: "Updates", href: "/updates" }, { label: "Registries" }],
						flash: null,
					},
					registriesPage(logins, auth.session.csrf, error, registry, username),
					400,
				),
			);
		const hostLike = registry.includes(".") || registry.includes(":") || registry === "localhost";
		if (!REGISTRY.test(registry) || !hostLike) return again("Give the registry host, such as ghcr.io or registry.example.com:5000.");
		if (username.length === 0 || username.length > 200) return again("Give a username.");
		if (password.length === 0 || password.length > 4096) return again("Give a password or access token.");
		await saveRegistryLogin(registry, username, password);
		await audit({ userId: auth.user.id, action: "registry.save", target: registry, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: `Saved the login for ${registry}.` });
		return redirect("/registries");
	});

	app.post("/registries/:rid/delete", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const registry = await deleteRegistryLogin(intParam(ctx.params.rid));
		if (!registry) throw notFound("This login does not exist.");
		await audit({ userId: auth.user.id, action: "registry.remove", target: registry, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: `Removed the login for ${registry}.` });
		return redirect("/registries");
	});
}
