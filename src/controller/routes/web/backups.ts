import type { Web } from "@rabbit-company/web";
import { generateKey } from "../../../agent/backup/crypto.ts";
import type { BackupItem, BackupMode } from "../../../shared/protocol.ts";
import { checkCsrf, clientIp, field, formData, NO_STORE, page, redirect, type Auth } from "../../auth.ts";
import type { Backups } from "../../backups.ts";
import { audit } from "../../db/audit.ts";
import {
	createDestination,
	deleteDestination,
	destinationInUse,
	getBackup,
	getMove,
	getDestination,
	getPlan,
	getTask,
	getTransfer,
	lastBackups,
	listBackups,
	listDestinations,
	listMoves,
	listPlans,
	listTasks,
	listTransfers,
	savePlan,
	updateDestination,
	type Plan,
} from "../../db/backups.ts";
import { getHost, listHosts, type Host } from "../../db/hosts.ts";
import { getStack, type Stack } from "../../db/stacks.ts";
import type { Hub } from "../../hub.ts";
import { describeDestination, formValues, parseDestination } from "../../lib/destinations.ts";
import { ApiError, notFound } from "../../lib/errors.ts";
import { checkSchedule, nextRun } from "../../lib/schedule.ts";
import type { SafeHtml } from "../../ssr/html.ts";
import { shell, type Crumb, type Flash } from "../../ssr/layout.ts";
import {
	backupPage,
	destinationForm,
	destinationPage,
	movePage,
	moveRunPage,
	overviewPage,
	restorePage,
	taskPage,
	transferPage,
	transferRunPage,
	type PlanRow,
} from "../../ssr/pages/backups.ts";
import type { AppContext, AppState } from "../../types.ts";
import { flash, intParam, popFlash, requireAuth, treeHosts } from "./common.ts";

interface KeyFlash extends Flash {
	recoveryKey?: string;
	test?: { ok: boolean; text: string };
}

const BACKUPS: Crumb = { label: "Backups", href: "/backups" };

export function backupRoutes(app: Web<AppState>, hub: Hub, backups: Backups): void {
	async function render(
		auth: Auth,
		options: { title: string; crumbs: Crumb[]; hostId?: number; watch?: string[]; flash?: Flash | null },
		content: SafeHtml,
		status = 200,
	) {
		const tree = await treeHosts(hub);
		return page(shell({ ...options, section: "backups", auth, tree, flash: options.flash === undefined ? popFlash(auth) : options.flash }, content), status);
	}

	async function loadStack(ctx: AppContext): Promise<{ host: Host; stack: Stack }> {
		const host = await getHost(intParam(ctx.params.id));
		const stack = await getStack(intParam(ctx.params.sid));
		if (!host || !stack || stack.hostId !== host.id) throw notFound("This stack does not exist.");
		return { host, stack };
	}

	async function loadBackup(ctx: AppContext) {
		const { host, stack } = await loadStack(ctx);
		const backup = await getBackup(intParam(ctx.params.bid));
		if (!backup || backup.stackId !== stack.id) throw notFound("This backup does not exist.");
		return { host, stack, backup };
	}

	const stackCrumbs = (host: Host, stack: Stack): Crumb[] => [
		{ label: "Datacenter", href: "/" },
		{ label: host.name, href: `/hosts/${host.id}` },
		{ label: stack.name, href: `/hosts/${host.id}/stacks/${stack.id}` },
		{ label: "Backups", href: `/hosts/${host.id}/stacks/${stack.id}?tab=backups` },
	];

	const failed = (auth: Auth, err: unknown, back: string) => {
		if (!(err instanceof ApiError) && !(err instanceof Error)) throw err;
		flash(auth, { kind: "error", text: (err as Error).message });
		return redirect(back);
	};

	app.get("/hosts/:id/stacks/:sid/transfer", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack } = await loadStack(ctx);
		if (stack.adopted || stack.deployedVersion === null) throw notFound("This stack cannot be transferred.");
		const hosts = (await listHosts()).filter((candidate) => candidate.id !== host.id && candidate.enrolled && hub.isOnline(candidate.id));
		return render(
			auth,
			{ title: `Transfer ${stack.name}`, crumbs: stackCrumbs(host, stack), hostId: host.id },
			movePage({ stack, hosts, destinations: await listDestinations(), moves: await listMoves(stack.id), csrf: auth.session.csrf }),
		);
	});

	app.post("/hosts/:id/stacks/:sid/transfer", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const { stack } = await loadStack(ctx);
		const base = `/hosts/${stack.hostId}/stacks/${stack.id}`;
		const targetHostId = Number(field(form, "host"));
		const destinationId = Number(field(form, "destination"));
		if (!Number.isSafeInteger(targetHostId) || targetHostId <= 0 || !Number.isSafeInteger(destinationId) || destinationId <= 0)
			throw new ApiError(400, "bad_transfer", "Choose a target host and backup destination.");
		try {
			const id = await backups.move(stack, targetHostId, destinationId, { id: auth.user.id, ip: clientIp(ctx) });
			return redirect(`${base}/transfers/${id}`);
		} catch (err) {
			return failed(auth, err, `${base}/transfer`);
		}
	});

	app.get("/hosts/:id/stacks/:sid/transfers/:mid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack } = await loadStack(ctx);
		const move = await getMove(intParam(ctx.params.mid));
		if (!move || move.sourceStackId !== stack.id) throw notFound("This transfer does not exist.");
		return render(
			auth,
			{ title: `Transfer of ${stack.name}`, crumbs: stackCrumbs(host, stack), hostId: host.id, watch: [`move:${move.id}`] },
			moveRunPage({ stack, move, target: await getHost(move.targetHostId), live: backups.jobs.live(`move:${move.id}`) }),
		);
	});

	app.get("/hosts/:id/stacks/:sid/transfers/:mid/output.json", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": NO_STORE } });
		const { stack } = await loadStack(ctx);
		const move = await getMove(intParam(ctx.params.mid));
		if (!move || move.sourceStackId !== stack.id) throw notFound("This transfer does not exist.");
		const live = backups.jobs.live(`move:${move.id}`);
		return Response.json(
			{ output: live?.output ?? move.output, total: live?.total ?? move.output.length, running: live !== null },
			{ headers: { "Cache-Control": NO_STORE } },
		);
	});

	app.get("/backups", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const destinations = await listDestinations();
		const withUsage = await Promise.all(
			destinations.map(async (d) => {
				const full = await getDestination(d.id);
				return { ...d, where: full ? describeDestination(full.config) : "", usage: await destinationInUse(d.id) };
			}),
		);
		const last = await lastBackups();
		const rows: PlanRow[] = [];
		for (const plan of await listPlans()) {
			const stack = await getStack(plan.stackId);
			if (!stack) continue;
			rows.push({
				stack,
				host: await getHost(stack.hostId),
				plan,
				destination: destinations.find((d) => d.id === plan.destinationId) ?? null,
				last: last.get(stack.id) ?? null,
			});
		}
		return render(
			auth,
			{ title: "Backups", crumbs: [{ label: "Datacenter", href: "/" }, { label: "Backups" }] },
			overviewPage({ destinations: withUsage, rows }),
		);
	});

	app.get("/backups/destinations/new", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = destinationForm({
			action: "/backups/destinations",
			csrf: auth.session.csrf,
			values: formValues(null),
			editing: false,
			hosts: await listHosts(),
		});
		return render(auth, { title: "Add destination", crumbs: [{ label: "Datacenter", href: "/" }, BACKUPS, { label: "New destination" }] }, form);
	});

	app.post("/backups/destinations", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const parsed = parseDestination(form, null);
		if (!parsed.config) {
			const content = destinationForm({
				action: "/backups/destinations",
				csrf: auth.session.csrf,
				values: parsed.values,
				error: parsed.error,
				editing: false,
				hosts: await listHosts(),
			});
			return render(
				auth,
				{ title: "Add destination", crumbs: [{ label: "Datacenter", href: "/" }, BACKUPS, { label: "New destination" }], flash: null },
				content,
				400,
			);
		}
		const key = generateKey();
		let id: number;
		try {
			id = await createDestination(parsed.values.name!, parsed.config, key);
		} catch {
			const content = destinationForm({
				action: "/backups/destinations",
				csrf: auth.session.csrf,
				values: parsed.values,
				error: "A destination with this name exists already.",
				editing: false,
				hosts: await listHosts(),
			});
			return render(
				auth,
				{ title: "Add destination", crumbs: [{ label: "Datacenter", href: "/" }, BACKUPS, { label: "New destination" }], flash: null },
				content,
				400,
			);
		}
		await audit({ userId: auth.user.id, action: "backup.destination.create", target: parsed.values.name!, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: "Added the destination. Save the recovery key now.", recoveryKey: key } as KeyFlash);
		return redirect(`/backups/destinations/${id}`);
	});

	async function showDestination(auth: Auth, id: number, extra: { values?: Record<string, string>; error?: string } = {}, status = 200) {
		const destination = await getDestination(id);
		if (!destination) throw notFound("This destination does not exist.");
		const note = popFlash<KeyFlash>(auth);
		const hosts = await listHosts();
		const form = destinationForm({
			action: `/backups/destinations/${id}`,
			csrf: auth.session.csrf,
			values: extra.values ?? formValues(destination.config, destination.name),
			error: extra.error,
			editing: true,
			hosts,
		});
		const content = destinationPage({
			destination,
			form,
			usage: await destinationInUse(id),
			hosts,
			online: new Set(hosts.filter((h) => hub.isOnline(h.id)).map((h) => h.id)),
			csrf: auth.session.csrf,
			recoveryKey: note?.recoveryKey ?? null,
			test: note?.test ?? null,
		});
		const flashNote = note && !note.test ? { kind: note.kind, text: note.text } : null;
		return render(
			auth,
			{ title: destination.name, crumbs: [{ label: "Datacenter", href: "/" }, BACKUPS, { label: destination.name }], flash: flashNote },
			content,
			status,
		);
	}

	app.get("/backups/destinations/:did", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		return showDestination(auth, intParam(ctx.params.did));
	});

	app.post("/backups/destinations/:did", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const id = intParam(ctx.params.did);
		const destination = await getDestination(id);
		if (!destination) throw notFound("This destination does not exist.");
		const parsed = parseDestination(form, destination.config);
		if (!parsed.config) return showDestination(auth, id, { values: parsed.values, error: parsed.error }, 400);
		try {
			await updateDestination(id, parsed.values.name!, parsed.config);
		} catch {
			return showDestination(auth, id, { values: parsed.values, error: "A destination with this name exists already." }, 400);
		}
		await audit({ userId: auth.user.id, action: "backup.destination.update", target: parsed.values.name!, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: "Saved." });
		return redirect(`/backups/destinations/${id}`);
	});

	app.post("/backups/destinations/:did/test", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const id = intParam(ctx.params.did);
		const destination = await getDestination(id);
		if (!destination) throw notFound("This destination does not exist.");
		const hostId = Number(field(form, "host"));
		let test: { ok: boolean; text: string };
		try {
			const result = await hub.request(hostId, "backup.test", { destination: destination.config }, 60_000);
			test = { ok: true, text: result.note };
		} catch (err) {
			test = { ok: false, text: `The test failed: ${(err as Error).message}` };
		}
		flash(auth, { kind: test.ok ? "ok" : "error", text: test.text, test } as KeyFlash);
		return redirect(`/backups/destinations/${id}`);
	});

	app.post("/backups/destinations/:did/key", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const destination = await getDestination(intParam(ctx.params.did));
		if (!destination) throw notFound("This destination does not exist.");
		await audit({ userId: auth.user.id, action: "backup.destination.key", target: destination.name, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: "", recoveryKey: destination.key } as KeyFlash);
		return redirect(`/backups/destinations/${destination.id}`);
	});

	app.post("/backups/destinations/:did/delete", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const destination = await getDestination(intParam(ctx.params.did));
		if (!destination) throw notFound("This destination does not exist.");
		const usage = await destinationInUse(destination.id);
		if (usage.plans > 0 || usage.backups > 0) {
			flash(auth, { kind: "error", text: "This destination is still in use." });
			return redirect(`/backups/destinations/${destination.id}`);
		}
		await deleteDestination(destination.id);
		await audit({ userId: auth.user.id, action: "backup.destination.remove", target: destination.name, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: `Removed ${destination.name}.` });
		return redirect("/backups");
	});

	app.post("/hosts/:id/stacks/:sid/backups", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const { stack } = await loadStack(ctx);
		const back = `/hosts/${stack.hostId}/stacks/${stack.id}?tab=backups`;
		const destinationId = Number(field(form, "destination"));
		if (!(await getDestination(destinationId))) throw notFound("This destination does not exist.");
		const preset = field(form, "preset");
		const schedule = checkSchedule(preset === "custom" ? field(form, "cron") : preset);
		if (!schedule.ok) {
			flash(auth, { kind: "error", text: `The schedule cannot be used. ${schedule.error}` });
			return redirect(back);
		}
		const count = (name: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(field(form, name)) || 0)));
		const mode: BackupMode = field(form, "mode") === "live" ? "live" : "stop";
		const items =
			field(form, "all_items") === "1"
				? null
				: form
						.getAll("item")
						.map(String)
						.filter((s) => s.length > 0 && s.length < 1024);
		const enabled = field(form, "enabled") === "1";
		const plan: Plan = {
			stackId: stack.id,
			destinationId,
			schedule: schedule.value,
			mode,
			items,
			keepDaily: count("keep_daily", 365),
			keepWeekly: count("keep_weekly", 520),
			keepMonthly: count("keep_monthly", 240),
			enabled,
			nextRunAt: enabled ? (nextRun(schedule.value)?.toISOString() ?? null) : null,
		};
		if (plan.keepDaily + plan.keepWeekly + plan.keepMonthly === 0) plan.keepDaily = 1;
		await savePlan(plan);
		await audit({ userId: auth.user.id, hostId: stack.hostId, action: "backup.plan", target: stack.name, ip: clientIp(ctx) });
		if (field(form, "intent") === "run") {
			try {
				const id = await backups.start(stack, { destinationId, mode, items, trigger: "manual", plan }, { id: auth.user.id, ip: clientIp(ctx) });
				return redirect(`/hosts/${stack.hostId}/stacks/${stack.id}/backups/${id}`);
			} catch (err) {
				return failed(auth, err, back);
			}
		}
		flash(auth, { kind: "ok", text: enabled ? "Saved the backup plan." : "Saved. Scheduled backups are paused." });
		return redirect(back);
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack, backup } = await loadBackup(ctx);
		const destination = (await listDestinations()).find((d) => d.id === backup.destinationId) ?? null;
		return render(
			auth,
			{ title: `Backup of ${stack.name}`, crumbs: stackCrumbs(host, stack), hostId: host.id, watch: [`backup:${backup.id}`] },
			backupPage({
				stack,
				backup,
				destination,
				tasks: await listTasks(backup.id),
				transfers: await listTransfers(backup.id),
				live: backups.jobs.live(`backup:${backup.id}`),
				csrf: auth.session.csrf,
			}),
		);
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid/transfer", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack, backup } = await loadBackup(ctx);
		if (backup.status !== "ok" || backup.deletedAt || backup.mode !== "stop" || backup.stackVersion === null || stack.adopted)
			throw notFound("This backup cannot be transferred.");
		const hosts = (await listHosts()).filter((candidate) => candidate.id !== host.id && candidate.enrolled && hub.isOnline(candidate.id));
		return render(
			auth,
			{ title: `Transfer ${stack.name}`, crumbs: stackCrumbs(host, stack), hostId: host.id },
			transferPage({ stack, backup, hosts, csrf: auth.session.csrf }),
		);
	});

	app.post("/hosts/:id/stacks/:sid/backups/:bid/transfer", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const { stack, backup } = await loadBackup(ctx);
		const base = `/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}`;
		const targetHostId = Number(field(form, "host"));
		if (!Number.isSafeInteger(targetHostId) || targetHostId <= 0) throw new ApiError(400, "bad_host", "Choose a target host.");
		try {
			const id = await backups.transfer(backup, targetHostId, { id: auth.user.id, ip: clientIp(ctx) });
			return redirect(`${base}/transfers/${id}`);
		} catch (err) {
			return failed(auth, err, `${base}/transfer`);
		}
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid/transfers/:tid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack, backup } = await loadBackup(ctx);
		const transfer = await getTransfer(intParam(ctx.params.tid));
		if (!transfer || transfer.backupId !== backup.id) throw notFound("This transfer does not exist.");
		return render(
			auth,
			{ title: `Transfer of ${stack.name}`, crumbs: stackCrumbs(host, stack), hostId: host.id, watch: [`transfer:${transfer.id}`] },
			transferRunPage({ stack, backup, transfer, target: await getHost(transfer.targetHostId), live: backups.jobs.live(`transfer:${transfer.id}`) }),
		);
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid/transfers/:tid/output.json", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": NO_STORE } });
		const { backup } = await loadBackup(ctx);
		const transfer = await getTransfer(intParam(ctx.params.tid));
		if (!transfer || transfer.backupId !== backup.id) throw notFound("This transfer does not exist.");
		const live = backups.jobs.live(`transfer:${transfer.id}`);
		return Response.json(
			{ output: live?.output ?? transfer.output, total: live?.total ?? transfer.output.length, running: live !== null },
			{ headers: { "Cache-Control": NO_STORE } },
		);
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid/output.json", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": NO_STORE } });
		const { backup } = await loadBackup(ctx);
		const live = backups.jobs.live(`backup:${backup.id}`);
		return Response.json(
			{ output: live?.output ?? backup.output, total: live?.total ?? backup.output.length, running: live !== null },
			{ headers: { "Cache-Control": NO_STORE } },
		);
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid/restore", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack, backup } = await loadBackup(ctx);
		if (backup.status !== "ok" || backup.deletedAt) throw notFound("Only a complete backup can be restored.");
		return render(
			auth,
			{ title: `Restore ${stack.name}`, crumbs: stackCrumbs(host, stack), hostId: host.id },
			restorePage({ stack, backup, csrf: auth.session.csrf }),
		);
	});

	app.post("/hosts/:id/stacks/:sid/backups/:bid/restore", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const { stack, backup } = await loadBackup(ctx);
		const base = `/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}`;
		try {
			const id = await backups.restore(backup, form.getAll("item").map(String), { id: auth.user.id, ip: clientIp(ctx) });
			return redirect(`${base}/tasks/${id}`);
		} catch (err) {
			return failed(auth, err, base);
		}
	});

	app.post("/hosts/:id/stacks/:sid/backups/:bid/verify", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const { stack, backup } = await loadBackup(ctx);
		const base = `/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}`;
		try {
			const id = await backups.verify(backup, { id: auth.user.id, ip: clientIp(ctx) });
			return redirect(`${base}/tasks/${id}`);
		} catch (err) {
			return failed(auth, err, base);
		}
	});

	app.post("/hosts/:id/stacks/:sid/backups/:bid/delete", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const { stack, backup } = await loadBackup(ctx);
		try {
			await backups.remove(backup, { id: auth.user.id, ip: clientIp(ctx) });
		} catch (err) {
			return failed(auth, err, `/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}`);
		}
		flash(auth, { kind: "ok", text: "Deleted the backup." });
		return redirect(`/hosts/${stack.hostId}/stacks/${stack.id}?tab=backups`);
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid/tasks/:tid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack, backup } = await loadBackup(ctx);
		const task = await getTask(intParam(ctx.params.tid));
		if (!task || task.backupId !== backup.id) throw notFound("This task does not exist.");
		return render(
			auth,
			{
				title: `${task.kind === "restore" ? "Restore" : "Verify"} of ${stack.name}`,
				crumbs: stackCrumbs(host, stack),
				hostId: host.id,
				watch: [`task:${task.id}`],
			},
			taskPage({ stack, backup, task, live: backups.jobs.live(`task:${task.id}`) }),
		);
	});

	app.get("/hosts/:id/stacks/:sid/backups/:bid/tasks/:tid/output.json", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": NO_STORE } });
		const { backup } = await loadBackup(ctx);
		const task = await getTask(intParam(ctx.params.tid));
		if (!task || task.backupId !== backup.id) throw notFound("This task does not exist.");
		const live = backups.jobs.live(`task:${task.id}`);
		return Response.json(
			{ output: live?.output ?? task.output, total: live?.total ?? task.output.length, running: live !== null },
			{ headers: { "Cache-Control": NO_STORE } },
		);
	});
}

export async function stackBackupData(hub: Hub, backups: Backups, stack: Stack): Promise<{ items: BackupItem[] | null; itemsError: string | null }> {
	if (!hub.isOnline(stack.hostId)) return { items: null, itemsError: null };
	try {
		return { items: await backups.items(stack), itemsError: null };
	} catch (err) {
		return { items: null, itemsError: `The volumes of this stack could not be listed: ${(err as Error).message}` };
	}
}
