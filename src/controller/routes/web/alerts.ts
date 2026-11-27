import type { Web } from "@rabbit-company/web";
import { channelValues, deliver, parseChannel } from "../../alerts/channels.ts";
import type { Alerting } from "../../alerts/engine.ts";
import { RULES, type RuleSetting } from "../../alerts/rules.ts";
import { checkCsrf, clientIp, field, formData, page, redirect, type Auth } from "../../auth.ts";
import { audit } from "../../db/audit.ts";
import {
	createChannel,
	deleteChannel,
	firingAlerts,
	getChannel,
	listChannels,
	recentAlerts,
	recordDelivery,
	ruleSettings,
	saveRuleSetting,
	updateChannel,
} from "../../db/alerts.ts";
import type { Hub } from "../../hub.ts";
import { notFound } from "../../lib/errors.ts";
import type { SafeHtml } from "../../ssr/html.ts";
import { shell, type Crumb, type Flash } from "../../ssr/layout.ts";
import { alertsPage, channelForm, channelPage } from "../../ssr/pages/alerts.ts";
import type { AppState } from "../../types.ts";
import { flash, intParam, popFlash, requireAuth, treeHosts } from "./common.ts";

const ALERTS: Crumb = { label: "Alerts", href: "/alerts" };

export function alertRoutes(app: Web<AppState>, hub: Hub, alerting: Alerting): void {
	async function render(auth: Auth, options: { title: string; crumbs: Crumb[]; watch?: string[]; flash?: Flash | null }, content: SafeHtml, status = 200) {
		const tree = await treeHosts(hub);
		return page(shell({ ...options, section: "alerts", auth, tree, flash: options.flash === undefined ? popFlash(auth) : options.flash }, content), status);
	}

	app.get("/alerts", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const content = alertsPage({
			firing: await firingAlerts(),
			recent: await recentAlerts(),
			channels: await listChannels(),
			settings: await ruleSettings(),
			csrf: auth.session.csrf,
		});
		return render(auth, { title: "Alerts", crumbs: [{ label: "Datacenter", href: "/" }, { label: "Alerts" }], watch: ["alerts"] }, content);
	});

	app.post("/alerts/rules", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const channelIds = new Set((await listChannels()).map((c) => c.id));
		for (const r of RULES) {
			const number = (name: string, min: number, max: number, fallback: number | null) => {
				const raw = field(form, `${name}:${r.id}`);
				const n = Number(raw);
				return raw === "" || !Number.isFinite(n) ? fallback : Math.max(min, Math.min(max, Math.round(n)));
			};
			const picked = form
				.getAll(`channel:${r.id}`)
				.map(Number)
				.filter((id) => channelIds.has(id));
			const setting: RuleSetting = {
				enabled: field(form, `enabled:${r.id}`) === "1",
				threshold: r.threshold === null ? null : number("threshold", 1, 100, r.threshold),
				minutes: r.minutes === null ? null : number("minutes", 0, 1440, r.minutes),
				channels: picked.length === channelIds.size ? null : picked,
			};
			await saveRuleSetting(r.id, setting);
		}
		await audit({ userId: auth.user.id, action: "alerts.rules", ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: "Saved the rules." });
		return redirect("/alerts");
	});

	app.get("/alerts/channels/new", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		return render(
			auth,
			{ title: "Add channel", crumbs: [{ label: "Datacenter", href: "/" }, ALERTS, { label: "New channel" }] },
			channelForm({ action: "/alerts/channels", csrf: auth.session.csrf, values: channelValues(null), editing: false }),
		);
	});

	app.post("/alerts/channels", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const parsed = parseChannel(form, null);
		const again = (error: string) =>
			render(
				auth,
				{ title: "Add channel", crumbs: [{ label: "Datacenter", href: "/" }, ALERTS, { label: "New channel" }], flash: null },
				channelForm({ action: "/alerts/channels", csrf: auth.session.csrf, values: parsed.values, error, editing: false }),
				400,
			);
		if (!parsed.config) return again(parsed.error!);
		let id: number;
		try {
			id = await createChannel(parsed.values.name!, parsed.config);
		} catch {
			return again("A channel with this name exists already.");
		}
		await audit({ userId: auth.user.id, action: "alerts.channel.create", target: parsed.values.name!, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: "Added the channel. Send a test to see that it works." });
		return redirect(`/alerts/channels/${id}`);
	});

	async function showChannel(auth: Auth, id: number, extra: { values?: Record<string, string>; error?: string } = {}, status = 200) {
		const channel = await getChannel(id);
		if (!channel) throw notFound("This channel does not exist.");
		const form = channelForm({
			action: `/alerts/channels/${id}`,
			csrf: auth.session.csrf,
			values: extra.values ?? channelValues(channel.config, channel.name),
			error: extra.error,
			editing: true,
			enabled: channel.enabled,
		});
		return render(
			auth,
			{ title: channel.name, crumbs: [{ label: "Datacenter", href: "/" }, ALERTS, { label: channel.name }], flash: extra.error ? null : undefined },
			channelPage({ channel, form, csrf: auth.session.csrf }),
			status,
		);
	}

	app.get("/alerts/channels/:cid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		return showChannel(auth, intParam(ctx.params.cid));
	});

	app.post("/alerts/channels/:cid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const id = intParam(ctx.params.cid);
		const channel = await getChannel(id);
		if (!channel) throw notFound("This channel does not exist.");
		const parsed = parseChannel(form, channel.config);
		if (!parsed.config) return showChannel(auth, id, { values: parsed.values, error: parsed.error }, 400);
		try {
			await updateChannel(id, parsed.values.name!, parsed.config, field(form, "enabled") === "1");
		} catch {
			return showChannel(auth, id, { values: parsed.values, error: "A channel with this name exists already." }, 400);
		}
		await audit({ userId: auth.user.id, action: "alerts.channel.update", target: parsed.values.name!, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: "Saved." });
		return redirect(`/alerts/channels/${id}`);
	});

	app.post("/alerts/channels/:cid/test", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const channel = await getChannel(intParam(ctx.params.cid));
		if (!channel) throw notFound("This channel does not exist.");
		try {
			await deliver(channel.config, {
				kind: "test",
				severity: "info",
				title: "Alerts reach this channel",
				detail: `Sent by ${auth.user.username} from the channel settings.`,
				link: alerting.link("/alerts"),
				rule: "test",
				host: null,
				at: new Date().toISOString(),
			});
			await recordDelivery(channel.id, null);
			flash(auth, { kind: "ok", text: "Sent a test alert." });
		} catch (err) {
			await recordDelivery(channel.id, (err as Error).message);
			flash(auth, { kind: "error", text: `The test failed: ${(err as Error).message}` });
		}
		return redirect(`/alerts/channels/${channel.id}`);
	});

	app.post("/alerts/channels/:cid/delete", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const channel = await getChannel(intParam(ctx.params.cid));
		if (!channel) throw notFound("This channel does not exist.");
		await deleteChannel(channel.id);
		await audit({ userId: auth.user.id, action: "alerts.channel.remove", target: channel.name, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: `Removed ${channel.name}.` });
		return redirect("/alerts");
	});
}
