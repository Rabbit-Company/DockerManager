import type { Web } from "@rabbit-company/web";
import { checkCompose, checkStackName, COMPOSE_TEMPLATE, hasErrors, parseEnv } from "../../../shared/compose.ts";
import { checkCsrf, clientIp, field, formData, NO_STORE, page, redirect, type Auth } from "../../auth.ts";
import { audit } from "../../db/audit.ts";
import { getHost, type Host } from "../../db/hosts.ts";
import {
	createStack,
	DEPLOY_ACTIONS,
	deleteStack,
	findStack,
	getDeploy,
	getStack,
	getVersion,
	listDeploys,
	listStacks,
	listVersions,
	saveVersion,
	type DeployAction,
	type Stack,
} from "../../db/stacks.ts";
import type { Deployments } from "../../deployments.ts";
import type { Updates } from "../../updates.ts";
import type { Backups } from "../../backups.ts";
import { getPlan, listBackups, listDestinations } from "../../db/backups.ts";
import { backupsTab } from "../../ssr/pages/backups.ts";
import { stackBackupData } from "./backups.ts";
import { countUpdates, updatesTab } from "../../ssr/pages/updates.ts";
import { AgentOffline, type Hub } from "../../hub.ts";
import { ApiError, notFound } from "../../lib/errors.ts";
import type { SafeHtml } from "../../ssr/html.ts";
import { shell, type Crumb, type Flash } from "../../ssr/layout.ts";
import {
	deployPage,
	editorForm,
	isStackTab,
	projectContainers,
	removeStackPage,
	stackActions,
	stackPage,
	versionPage,
	type EditorInput,
} from "../../ssr/pages/stacks.ts";
import type { AppContext, AppState } from "../../types.ts";
import { randomToken } from "../../lib/crypto.ts";
import { STYLE_NONCE_HEADER } from "../../security.ts";
import { flash, hostView, intParam, popFlash, requireAuth, treeHosts } from "./common.ts";

const MAX_ENV = 64 * 1024;

async function loadHost(ctx: AppContext): Promise<Host> {
	const host = await getHost(intParam(ctx.params.id));
	if (!host) throw notFound("This host does not exist.");
	return host;
}

async function loadStack(ctx: AppContext): Promise<{ host: Host; stack: Stack }> {
	const host = await loadHost(ctx);
	const stack = await getStack(intParam(ctx.params.sid));
	if (!stack || stack.hostId !== host.id) throw notFound("This stack does not exist.");
	return { host, stack };
}

function agentError(err: unknown): string {
	if (err instanceof AgentOffline) return err.message;
	return `The agent reported: ${(err as Error).message}`;
}

/** Line endings from browsers become \n, so versions compare equal whatever the form sent. */
function text(form: FormData, name: string): string {
	return field(form, name).replace(/\r\n?/g, "\n");
}

function checkEnv(env: string): string | null {
	if (env.length > MAX_ENV) return "The environment file is larger than 64 KB.";
	const { errors } = parseEnv(env);
	return errors.length > 0 ? `${errors[0]!.message} Use KEY=value, one per line.` : null;
}

export function stackRoutes(app: Web<AppState>, hub: Hub, deployments: Deployments, updates: Updates, backups: Backups): void {
	async function render(
		auth: Auth,
		options: { title: string; crumbs: Crumb[]; hostId: number; watch?: string[]; actions?: SafeHtml; flash?: Flash | null; editor?: boolean },
		content: SafeHtml,
		status = 200,
	): Promise<Response> {
		const tree = await treeHosts(hub);
		const nonce = options.editor ? randomToken(18) : undefined;
		const response = page(shell({ ...options, auth, tree, nonce, flash: options.flash === undefined ? popFlash(auth) : options.flash }, content), status);
		if (nonce) response.headers.set(STYLE_NONCE_HEADER, nonce);
		return response;
	}

	const hostCrumbs = (host: Host): Crumb[] => [
		{ label: "Datacenter", href: "/" },
		{ label: host.name, href: `/hosts/${host.id}` },
		{ label: "Stacks", href: `/hosts/${host.id}?tab=stacks` },
	];
	const stackCrumbs = (host: Host, stack: Stack): Crumb[] => [...hostCrumbs(host), { label: stack.name, href: `/hosts/${host.id}/stacks/${stack.id}` }];

	async function startAction(auth: Auth, ctx: AppContext, stack: Stack, action: DeployAction): Promise<Response> {
		try {
			const id = await deployments.start(stack, action, { id: auth.user.id, ip: clientIp(ctx) });
			return redirect(`/hosts/${stack.hostId}/stacks/${stack.id}/deploys/${id}`);
		} catch (err) {
			if (err instanceof ApiError && err.status !== 409) throw err;
			flash(auth, { kind: "error", text: (err as Error).message });
			return redirect(`/hosts/${stack.hostId}/stacks/${stack.id}`);
		}
	}

	async function check(
		hostId: number,
		files: { name: string; directory: string | null; file: string; compose: string; env: string },
	): Promise<{ ok: boolean; output: string }> {
		try {
			return await hub.request(hostId, "stack.validate", files, 90_000);
		} catch (err) {
			return { ok: false, output: agentError(err) };
		}
	}

	app.get("/hosts/:id/stacks/new", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const host = await loadHost(ctx);
		const project = new URL(ctx.req.url).searchParams.get("adopt");
		const crumbs = [...hostCrumbs(host), { label: project ? "Adopt" : "New stack" }];
		const input: EditorInput = {
			action: `/hosts/${host.id}/stacks`,
			csrf: auth.session.csrf,
			isNew: true,
			name: "",
			compose: COMPOSE_TEMPLATE,
			env: "",
			message: "",
			issues: [],
		};
		if (project) {
			const name = checkStackName(project);
			if (!name.ok) throw notFound("This project does not exist.");
			try {
				const files = await hub.request(host.id, "stack.read", { project: name.value }, 20_000);
				Object.assign(input, {
					name: name.value,
					compose: files.compose.replace(/\r\n?/g, "\n"),
					env: files.env.replace(/\r\n?/g, "\n"),
					adopt: { directory: files.directory, file: files.file },
				});
				input.issues = checkCompose(input.compose);
			} catch (err) {
				flash(auth, { kind: "error", text: `${name.value} cannot be adopted. ${agentError(err)}` });
				return redirect(`/hosts/${host.id}?tab=stacks`);
			}
		}
		return render(auth, { title: project ? `Adopt ${project}` : "New stack", crumbs, hostId: host.id, editor: true }, editorForm(input));
	});

	app.post("/hosts/:id/stacks", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const host = await loadHost(ctx);
		const adopting = field(form, "adopt") === "1";
		const rawName = field(form, "name");
		const compose = text(form, "compose");
		const env = text(form, "env");
		const message = field(form, "message").trim().slice(0, 200);
		const intent = field(form, "intent");
		const adopt = adopting ? { directory: field(form, "directory"), file: field(form, "file") } : null;
		const input: EditorInput = {
			action: `/hosts/${host.id}/stacks`,
			csrf: auth.session.csrf,
			isNew: true,
			name: rawName,
			compose,
			env,
			message,
			issues: checkCompose(compose),
			adopt,
		};
		const again = (status = 400) =>
			render(
				auth,
				{
					title: adopting ? `Adopt ${rawName}` : "New stack",
					crumbs: [...hostCrumbs(host), { label: adopting ? "Adopt" : "New stack" }],
					hostId: host.id,
					editor: true,
					flash: null,
				},
				editorForm(input),
				status,
			);

		const name = checkStackName(rawName);
		if (!name.ok) {
			input.nameError = name.error;
			return again();
		}
		input.name = name.value;
		if (intent === "check") {
			input.check = await check(host.id, { name: name.value, directory: adopt?.directory ?? null, file: adopt?.file ?? "compose.yaml", compose, env });
			return again(200);
		}
		input.error = checkEnv(env);
		if (input.error || hasErrors(input.issues)) {
			input.error ??= "Fix the errors in the compose file first.";
			return again();
		}
		if (await findStack(host.id, name.value)) {
			input.nameError = "A stack with this name already exists on this host.";
			return again();
		}
		const running = hub.snapshot(host.id)?.containers.some((c) => c.project === name.value) ?? false;
		if (running && !adopting) {
			input.nameError = "A compose project with this name already runs on this host. Adopt it from the Stacks tab instead.";
			return again();
		}
		const stack = await createStack({
			hostId: host.id,
			name: name.value,
			directory: adopt?.directory ?? null,
			file: adopt?.file ?? "compose.yaml",
			adopted: adopting,
			compose,
			env,
			message: message || (adopting ? "Adopted" : "Created"),
			userId: auth.user.id,
			deployed: adopting,
		});
		await audit({ userId: auth.user.id, hostId: host.id, action: adopting ? "stack.adopt" : "stack.create", target: stack.name, ip: clientIp(ctx) });
		if (intent === "deploy") return startAction(auth, ctx, stack, "deploy");
		flash(auth, { kind: "ok", text: adopting ? `Adopted ${stack.name}.` : `Saved ${stack.name}. Deploy it when you are ready.` });
		return redirect(`/hosts/${host.id}/stacks/${stack.id}`);
	});

	app.get("/stacks/:sid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const stack = await getStack(intParam(ctx.params.sid));
		if (!stack) throw notFound("This stack does not exist.");
		return redirect(`/hosts/${stack.hostId}/stacks/${stack.id}`);
	});

	app.get("/hosts/:id/stacks/:sid", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack } = await loadStack(ctx);
		const movedTo = stack.movedTo !== null ? await getStack(stack.movedTo) : null;
		const moved = movedTo ? { stackId: movedTo.id, hostName: (await getHost(movedTo.hostId))?.name ?? "another host" } : null;
		const view = hostView(hub, host);
		const requested = new URL(ctx.req.url).searchParams.get("tab");
		const tab = isStackTab(requested) ? requested : "editor";
		const containers = projectContainers(view, stack.name);
		const [lastDeploy] = await listDeploys(stack.id, 1);
		const serviceUpdates = await updates.forStack(stack);
		const updateCount = serviceUpdates.some((u) => u.checkedAt !== null) ? countUpdates(serviceUpdates) : null;
		let editor: SafeHtml | undefined;
		if (tab === "editor") {
			const version = await getVersion(stack.id, stack.currentVersion);
			if (!version) throw notFound("This stack has no saved version.");
			editor = editorForm({
				action: `/hosts/${host.id}/stacks/${stack.id}/save`,
				csrf: auth.session.csrf,
				isNew: false,
				name: stack.name,
				compose: version.compose,
				env: version.env,
				message: "",
				issues: checkCompose(version.compose),
			});
		}
		return render(
			auth,
			{
				title: stack.name,
				crumbs: hostCrumbs(host),
				hostId: host.id,
				watch: [`host:${host.id}`],
				actions: stackActions(stack, containers, auth.session.csrf, deployments.runningFor(stack.id), deployments.busy(stack.id) !== null),
				editor: tab === "editor",
			},
			stackPage({
				view,
				stack,
				tab,
				csrf: auth.session.csrf,
				containers,
				lastDeploy: lastDeploy ?? null,
				moved,
				editor,
				versions: tab === "history" ? await listVersions(stack.id) : undefined,
				deploys: tab === "history" ? await listDeploys(stack.id, 30) : undefined,
				updateCount,
				backups:
					tab === "backups"
						? backupsTab({
								stack,
								plan: await getPlan(stack.id),
								destinations: await listDestinations(),
								...(await stackBackupData(hub, backups, stack)),
								backups: await listBackups(stack.id),
								csrf: auth.session.csrf,
								busy: deployments.busy(stack.id),
							})
						: undefined,
				updates:
					tab === "updates"
						? updatesTab({
								stack,
								updates: serviceUpdates,
								csrf: auth.session.csrf,
								lastRun: updates.lastRun,
								checking: updates.running,
								busy: deployments.runningFor(stack.id) !== null,
							})
						: undefined,
			}),
		);
	});

	app.post("/hosts/:id/stacks/:sid/save", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const { host, stack } = await loadStack(ctx);
		if (deployments.busy(stack.id)) throw new ApiError(409, "busy", "A job of this stack is running. Wait for it to finish before saving changes.");
		const compose = text(form, "compose");
		const env = text(form, "env");
		const message = field(form, "message").trim().slice(0, 200);
		const intent = field(form, "intent");
		const input: EditorInput = {
			action: `/hosts/${host.id}/stacks/${stack.id}/save`,
			csrf: auth.session.csrf,
			isNew: false,
			name: stack.name,
			compose,
			env,
			message,
			issues: checkCompose(compose),
		};
		const again = async (status = 400) => {
			const view = hostView(hub, host);
			const containers = projectContainers(view, stack.name);
			const [lastDeploy] = await listDeploys(stack.id, 1);
			return render(
				auth,
				{
					title: stack.name,
					crumbs: hostCrumbs(host),
					hostId: host.id,
					watch: [`host:${host.id}`],
					editor: true,
					flash: null,
					actions: stackActions(stack, containers, auth.session.csrf, deployments.runningFor(stack.id), deployments.busy(stack.id) !== null),
				},
				stackPage({ view, stack, tab: "editor", csrf: auth.session.csrf, containers, lastDeploy: lastDeploy ?? null, editor: editorForm(input) }),
				status,
			);
		};
		if (intent === "check") {
			input.check = await check(host.id, { name: stack.name, directory: stack.directory, file: stack.file, compose, env });
			return again(200);
		}
		input.error = checkEnv(env);
		if (input.error || hasErrors(input.issues)) {
			input.error ??= "Fix the errors in the compose file first.";
			return again();
		}
		const number = await saveVersion(stack.id, { compose, env, message: message || null, userId: auth.user.id });
		if (number !== null) await audit({ userId: auth.user.id, hostId: host.id, action: "stack.save", target: `${stack.name} v${number}`, ip: clientIp(ctx) });
		const fresh = (await getStack(stack.id))!;
		if (intent === "deploy") return startAction(auth, ctx, fresh, "deploy");
		flash(auth, { kind: "ok", text: number === null ? "Nothing changed." : `Saved version ${number}.` });
		return redirect(`/hosts/${host.id}/stacks/${stack.id}`);
	});

	app.post("/hosts/:id/stacks/:sid/action", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const { stack } = await loadStack(ctx);
		const action = field(form, "action") as DeployAction;
		if (!DEPLOY_ACTIONS.includes(action)) throw notFound("Unknown action.");
		return startAction(auth, ctx, stack, action);
	});

	app.get("/hosts/:id/stacks/:sid/versions/:n", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack } = await loadStack(ctx);
		const number = intParam(ctx.params.n);
		const version = await getVersion(stack.id, number);
		if (!version) throw notFound("This version does not exist.");
		const previous = number > 1 ? await getVersion(stack.id, number - 1) : null;
		return render(
			auth,
			{
				title: `${stack.name} v${number}`,
				crumbs: [...stackCrumbs(host, stack), { label: "History", href: `/hosts/${host.id}/stacks/${stack.id}?tab=history` }],
				hostId: host.id,
			},
			versionPage(stack, version, previous, auth.session.csrf),
		);
	});

	app.post("/hosts/:id/stacks/:sid/versions/:n/restore", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		checkCsrf(auth, await formData(ctx));
		const { host, stack } = await loadStack(ctx);
		if (deployments.busy(stack.id)) throw new ApiError(409, "busy", "A job of this stack is running. Wait for it to finish before restoring a version.");
		const number = intParam(ctx.params.n);
		const version = await getVersion(stack.id, number);
		if (!version) throw notFound("This version does not exist.");
		const saved = await saveVersion(stack.id, { compose: version.compose, env: version.env, message: `Restored v${number}`, userId: auth.user.id });
		if (saved !== null)
			await audit({ userId: auth.user.id, hostId: host.id, action: "stack.restore", target: `${stack.name} v${number} -> v${saved}`, ip: clientIp(ctx) });
		flash(auth, {
			kind: "ok",
			text: saved === null ? "That version is already the current one." : `Restored version ${number} as version ${saved}. Deploy to apply it.`,
		});
		return redirect(`/hosts/${host.id}/stacks/${stack.id}`);
	});

	app.get("/hosts/:id/stacks/:sid/deploys/:did", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack } = await loadStack(ctx);
		const deploy = await getDeploy(intParam(ctx.params.did));
		if (!deploy || deploy.stackId !== stack.id) throw notFound("This deploy does not exist.");
		const live = deployments.live(deploy.id);
		const output = live?.output ?? deploy.output;
		return render(
			auth,
			{
				title: `${stack.name}: ${deploy.action}`,
				crumbs: [...stackCrumbs(host, stack), { label: "History", href: `/hosts/${host.id}/stacks/${stack.id}?tab=history` }],
				hostId: host.id,
				watch: [`deploy:${deploy.id}`],
			},
			deployPage({ stack, deploy, output, total: live?.total ?? output.length, csrf: auth.session.csrf }),
		);
	});

	app.get("/hosts/:id/stacks/:sid/deploys/:did/output.json", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": NO_STORE } });
		const { stack } = await loadStack(ctx);
		const deploy = await getDeploy(intParam(ctx.params.did));
		if (!deploy || deploy.stackId !== stack.id) throw notFound("This deploy does not exist.");
		const live = deployments.live(deploy.id);
		const output = live?.output ?? deploy.output;
		return Response.json({ output, total: live?.total ?? output.length, running: live !== null }, { headers: { "Cache-Control": NO_STORE } });
	});

	app.get("/hosts/:id/stacks/:sid/remove", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const { host, stack } = await loadStack(ctx);
		return render(
			auth,
			{ title: `Remove ${stack.name}`, crumbs: [...stackCrumbs(host, stack), { label: "Remove" }], hostId: host.id },
			removeStackPage(stack, auth.session.csrf, !stack.adopted && stack.directory !== null),
		);
	});

	app.post("/hosts/:id/stacks/:sid/remove", async (ctx) => {
		const auth = await requireAuth(ctx);
		if (auth instanceof Response) return auth;
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const { host, stack } = await loadStack(ctx);
		if (deployments.busy(stack.id)) {
			flash(auth, { kind: "error", text: "A job of this stack is running. Wait for it to finish before removing it." });
			return redirect(`/hosts/${host.id}/stacks/${stack.id}`);
		}
		if (field(form, "down") === "1" && stack.directory !== null) {
			try {
				const id = await deployments.start(stack, "down", { id: auth.user.id, ip: clientIp(ctx) });
				if (!(await deployments.wait(id))) {
					flash(auth, { kind: "error", text: "Taking the stack down failed, so it was not removed. The output shows why." });
					return redirect(`/hosts/${host.id}/stacks/${stack.id}/deploys/${id}`);
				}
			} catch (err) {
				flash(auth, { kind: "error", text: (err as Error).message });
				return redirect(`/hosts/${host.id}/stacks/${stack.id}?tab=settings`);
			}
		}
		let note = "";
		if (field(form, "files") === "1" && !stack.adopted && stack.directory !== null) {
			try {
				const result = await hub.request(host.id, "stack.remove", { name: stack.name, directory: stack.directory }, 30_000);
				note = result.removed ? " Its folder was deleted." : " Its folder is outside the stacks folder, so it was kept.";
			} catch (err) {
				note = ` Its folder could not be deleted. ${agentError(err)}`;
			}
		}
		await deleteStack(stack.id);
		await audit({ userId: auth.user.id, hostId: host.id, action: "stack.remove", target: stack.name, ip: clientIp(ctx) });
		flash(auth, { kind: "ok", text: `Removed ${stack.name}.${note}` });
		return redirect(`/hosts/${host.id}?tab=stacks`);
	});
}

export async function stackNames(hostId: number): Promise<Map<string, number>> {
	return new Map((await listStacks(hostId)).map((s) => [s.name, s.id]));
}
