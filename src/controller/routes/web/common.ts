import { currentAuth, loginRedirect, redirect, type Auth } from "../../auth.ts";
import { listHosts, type Host } from "../../db/hosts.ts";
import { stackIndex } from "../../db/stacks.ts";
import { countUsers } from "../../db/users.ts";
import type { Hub } from "../../hub.ts";
import { hashToken } from "../../lib/crypto.ts";
import { notFound } from "../../lib/errors.ts";
import { setFlash, takeFlash } from "../../lib/flash.ts";
import type { Flash, TreeHost } from "../../ssr/layout.ts";
import { groupByProject, type HostView } from "../../ssr/pages/hosts.ts";
import type { AppContext } from "../../types.ts";

let usersExist = false;

/** Once an account exists it never goes back to zero through the UI, so the answer is kept after the first yes. */
export async function needsSetup(): Promise<boolean> {
	if (usersExist) return false;
	usersExist = (await countUsers()) > 0;
	return !usersExist;
}

export function markSetupDone(): void {
	usersExist = true;
}

/** A signed in account with its 2FA done, or the response that sends the visitor where they need to go. */
export async function requireAuth(ctx: AppContext): Promise<Auth | Response> {
	if (await needsSetup()) return redirect("/setup");
	const auth = await currentAuth(ctx);
	if (!auth) {
		const pending = await currentAuth(ctx, { allowMfaPending: true });
		return pending ? redirect("/login/2fa") : loginRedirect(ctx);
	}
	return auth;
}

export function flash(auth: Auth, value: Flash): void {
	setFlash(hashToken(auth.token), value);
}

export function popFlash<T = Flash>(auth: Auth): T | null {
	return takeFlash<T>(hashToken(auth.token));
}

export function intParam(value: string | undefined): number {
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n <= 0) throw notFound("This page does not exist.");
	return n;
}

export function hostView(hub: Hub, host: Host): HostView {
	return {
		host,
		online: hub.isOnline(host.id),
		facts: hub.facts(host.id),
		snapshot: hub.snapshot(host.id),
		latest: hub.latest(host.id),
		disk: hub.disk(host.id),
		storage: hub.storage(host.id),
	};
}

export async function treeHosts(hub: Hub, hosts?: Host[]): Promise<TreeHost[]> {
	const list = hosts ?? (await listHosts());
	const stacks = await stackIndex();
	return list.map((host) => {
		const snapshot = hub.snapshot(host.id);
		const containers = snapshot?.containers ?? [];
		return {
			id: host.id,
			name: host.name,
			online: hub.isOnline(host.id),
			enrolled: host.enrolled,
			running: containers.filter((c) => c.state === "running").length,
			total: containers.length,
			projects: groupByProject(containers).map((g) => ({
				name: g.name ?? "Standalone",
				stackId: g.name === null ? null : (stacks.get(host.id)?.get(g.name) ?? null),
				containers: g.containers.map((c) => ({ id: c.id, name: c.service ?? c.name, state: c.state })),
			})),
		};
	});
}

/** For tests that start from an empty users table. */
export function resetSetupCache(): void {
	usersExist = false;
}
