import { parseEnv } from "../shared/compose.ts";
import {
	bestTag,
	levelAllowed,
	newerTags,
	parseImage,
	parseTag,
	releaseNotesUrl,
	serviceImages,
	setServiceImage,
	withTag,
	type ImageRef,
	type NewerTag,
} from "../shared/images.ts";
import type { Snapshot } from "../shared/protocol.ts";
import { audit } from "./db/audit.ts";
import { getHost, listHosts } from "./db/hosts.ts";
import { getStack, getVersion, listAllStacks, saveVersion, type Stack } from "./db/stacks.ts";
import {
	DEFAULT_SETTING,
	loadDigests,
	loadTags,
	saveDigest,
	saveTags,
	serviceSettings,
	stacksWithAutoUpdates,
	type DigestEntry,
	type ServiceSetting,
	type TagsEntry,
} from "./db/updates.ts";
import type { Deployments } from "./deployments.ts";
import type { Hub } from "./hub.ts";
import { ApiError } from "./lib/errors.ts";
import type { RegistryClient } from "./registry.ts";

export interface ServiceUpdate {
	service: string;
	/** The image as written in the compose file. */
	written: string;
	image: string | null;
	editable: boolean;
	ref: ImageRef | null;
	setting: ServiceSetting;
	/** Newer tags of the same shape, newest first. */
	newer: NewerTag[];
	/** The newest tag the service's policy allows. */
	offer: NewerTag | null;
	/** True when the tag in use points to a newer build than the one running, null when unknown. */
	rebuilt: boolean | null;
	error: string | null;
	checkedAt: string | null;
	notes: string | null;
}

const digestKey = (ref: ImageRef) => `${ref.registry}/${ref.repository}:${ref.tag}`;
const repoKey = (ref: ImageRef) => `${ref.registry}/${ref.repository}`;
const CONCURRENCY = 4;

async function pool<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
			while (next < items.length) await run(items[next++]!);
		}),
	);
}

/** The images a snapshot's running container of a service was created from, as registry digests. */
function localDigests(snapshot: Snapshot | null, project: string, service: string): string[] | null {
	const container = snapshot?.containers.find((c) => c.project === project && c.service === service);
	if (!container) return null;
	const image = snapshot!.images.find((i) => i.id === container.imageId);
	return image ? image.digests : null;
}

export class Updates {
	private digests = new Map<string, DigestEntry>();
	private tags = new Map<string, TagsEntry>();
	private checking: Promise<void> | null = null;
	lastRun: string | null = null;
	/** Called after every registry check, for alerts. */
	onChecked: (() => void) | null = null;

	constructor(
		private readonly registry: RegistryClient,
		private readonly hub: Hub,
		private readonly deployments: Deployments,
		private readonly healthTimeout = 120,
	) {}

	async load(): Promise<void> {
		[this.digests, this.tags] = await Promise.all([loadDigests(), loadTags()]);
		let newest: string | null = null;
		for (const d of this.digests.values()) if (!newest || d.checkedAt > newest) newest = d.checkedAt;
		this.lastRun = newest;
	}

	get running(): boolean {
		return this.checking !== null;
	}

	/** Every image the stacks use and every image a container runs, without duplicates. */
	private async allRefs(): Promise<ImageRef[]> {
		const refs = new Map<string, ImageRef>();
		const add = (value: string | null) => {
			const ref = value ? parseImage(value) : null;
			if (ref && !ref.digest) refs.set(digestKey(ref), ref);
		};
		for (const stack of await listAllStacks()) {
			const version = await getVersion(stack.id, stack.currentVersion);
			if (!version) continue;
			const env = new Map(parseEnv(version.env).entries.map((e) => [e.key, e.value]));
			for (const s of serviceImages(version.compose, env)) add(s.image);
		}
		for (const host of await listHosts()) for (const c of this.hub.snapshot(host.id)?.containers ?? []) add(c.image);
		return [...refs.values()];
	}

	/** Asks registries about the given images, or about all of them. A check already running is joined. */
	check(refs?: ImageRef[]): Promise<void> {
		if (this.checking) return this.checking;
		this.checking = (async () => {
			const list = refs ?? (await this.allRefs());
			const repos = new Map<string, ImageRef>();
			for (const ref of list) if (parseTag(ref.tag)) repos.set(repoKey(ref), ref);
			await pool(list, async (ref) => {
				const entry: DigestEntry = { digest: null, error: null, checkedAt: new Date().toISOString() };
				try {
					entry.digest = await this.registry.digest(ref);
				} catch (err) {
					entry.error = (err as Error).message;
				}
				this.digests.set(digestKey(ref), entry);
				await saveDigest(ref.registry, ref.repository, ref.tag, entry);
			});
			await pool([...repos.values()], async (ref) => {
				const entry: TagsEntry = { tags: [], error: null, checkedAt: new Date().toISOString() };
				try {
					entry.tags = await this.registry.tags(ref);
				} catch (err) {
					entry.error = (err as Error).message;
					entry.tags = this.tags.get(repoKey(ref))?.tags ?? [];
				}
				this.tags.set(repoKey(ref), entry);
				await saveTags(ref.registry, ref.repository, entry);
			});
			this.lastRun = new Date().toISOString();
		})().finally(() => {
			this.checking = null;
			this.onChecked?.();
		});
		return this.checking;
	}

	async checkStack(stack: Stack): Promise<void> {
		const version = await getVersion(stack.id, stack.currentVersion);
		if (!version) return;
		const env = new Map(parseEnv(version.env).entries.map((e) => [e.key, e.value]));
		const refs = serviceImages(version.compose, env)
			.map((s) => (s.image ? parseImage(s.image) : null))
			.filter((r): r is ImageRef => r !== null && !r.digest);
		await this.check(refs);
	}

	/** What each service of a stack could move to, from cached registry answers. Nothing here calls a registry. */
	async forStack(stack: Stack): Promise<ServiceUpdate[]> {
		const version = await getVersion(stack.id, stack.currentVersion);
		if (!version) return [];
		const settings = await serviceSettings(stack.id);
		const env = new Map(parseEnv(version.env).entries.map((e) => [e.key, e.value]));
		const snapshot = this.hub.snapshot(stack.hostId);
		return serviceImages(version.compose, env).map((s): ServiceUpdate => {
			const ref = s.image ? parseImage(s.image) : null;
			const setting = settings.get(s.service) ?? DEFAULT_SETTING;
			const digest = ref ? this.digests.get(digestKey(ref)) : undefined;
			const tags = ref ? this.tags.get(repoKey(ref)) : undefined;
			const newer = ref && !ref.digest && tags ? newerTags(ref.tag, tags.tags) : [];
			const local = localDigests(snapshot, stack.name, s.service);
			const rebuilt = digest?.digest && local && local.length > 0 ? !local.some((d) => d.endsWith(`@${digest.digest}`)) : null;
			const container = snapshot?.containers.find((c) => c.project === stack.name && c.service === s.service);
			return {
				service: s.service,
				written: s.written,
				image: s.image,
				editable: s.editable,
				ref,
				setting,
				newer,
				offer: setting.policy === "off" ? null : bestTag(newer, setting.policy),
				rebuilt: setting.policy === "off" ? null : rebuilt,
				error:
					digest?.error ?? tags?.error ?? (ref === null && s.image ? "This image reference cannot be checked." : ref?.digest ? "Pinned to a digest." : null),
				checkedAt: digest?.checkedAt ?? tags?.checkedAt ?? null,
				notes: container ? releaseNotesUrl(container.labels) : null,
			};
		});
	}

	/**
	 * Moves the chosen services to new tags, or pulls new builds of the same
	 * tags, and deploys. When the containers do not come up healthy, the
	 * version that ran before is saved again and deployed.
	 */
	async upgrade(
		stack: Stack,
		changes: { service: string; tag: string | null }[],
		user: { id: number | null; ip: string | null },
	): Promise<{ deployId: number; done: Promise<{ ok: boolean; rollbackDeployId: number | null }> }> {
		if (changes.length === 0) throw new ApiError(400, "bad_request", "Choose at least one service to update.");
		if (stack.deployedVersion === null) throw new ApiError(409, "not_deployed", "Deploy this stack once before updating it.");
		if (stack.deployedVersion !== stack.currentVersion)
			throw new ApiError(409, "pending_changes", "This stack has saved changes that are not deployed. Deploy them first, so an update only changes images.");
		const before = await getVersion(stack.id, stack.deployedVersion);
		if (!before) throw new ApiError(404, "not_found", "The deployed version is missing.");
		const env = new Map(parseEnv(before.env).entries.map((e) => [e.key, e.value]));
		const images = new Map(serviceImages(before.compose, env).map((s) => [s.service, s]));
		let compose = before.compose;
		const notes: string[] = [];
		for (const change of changes) {
			const current = images.get(change.service);
			if (!current) throw new ApiError(400, "bad_request", `Service ${change.service} has no image.`);
			if (change.tag === null) {
				notes.push(`${change.service} new build`);
				continue;
			}
			if (!current.editable) throw new ApiError(400, "bad_request", `The image of ${change.service} uses a variable. Change it in the .env file.`);
			const next = withTag(current.written, change.tag);
			compose = setServiceImage(compose, change.service, next);
			notes.push(`${change.service} ${parseImage(current.written)?.tag ?? current.written} -> ${change.tag}`);
		}
		const message = `Update ${notes.join(", ")}`;
		const number = compose === before.compose ? null : await saveVersion(stack.id, { compose, env: before.env, message, userId: user.id });
		const fresh = (await getStack(stack.id))!;
		await audit({ userId: user.id, hostId: stack.hostId, action: "stack.update", target: `${stack.name}: ${notes.join(", ")}`, ip: user.ip });
		const deployId = await this.deployments.start(fresh, "upgrade", user, { healthTimeout: this.healthTimeout });
		const done = this.deployments.wait(deployId).then(async (ok) => {
			if (ok || number === null) return { ok, rollbackDeployId: null };
			const back = await saveVersion(stack.id, {
				compose: before.compose,
				env: before.env,
				message: `Rolled back v${number}, the update did not come up healthy`,
				userId: user.id,
			});
			await audit({
				userId: user.id,
				hostId: stack.hostId,
				action: "stack.rollback",
				target: `${stack.name} v${number} -> v${back ?? before.number}`,
				ok: true,
				ip: user.ip,
			});
			const latest = (await getStack(stack.id))!;
			const rollbackDeployId = await this.deployments.start(latest, "deploy", user, { healthTimeout: this.healthTimeout });
			return { ok: false, rollbackDeployId };
		});
		return { deployId, done };
	}

	/** Applies updates the services allow on their own. Stacks with pending edits, running deploys or offline hosts wait. */
	async runAutomatic(): Promise<number> {
		let started = 0;
		for (const stackId of await stacksWithAutoUpdates()) {
			const stack = await getStack(stackId);
			if (!stack || !this.hub.isOnline(stack.hostId) || this.deployments.runningFor(stack.id) !== null) continue;
			if (stack.deployedVersion === null || stack.deployedVersion !== stack.currentVersion) continue;
			const changes = (await this.forStack(stack))
				.filter((u) => u.editable && u.setting.auto !== "off")
				.map((u) => ({ u, pick: bestTag(u.newer, u.setting.auto as "patch" | "minor") }))
				.filter(({ u, pick }) => pick !== null && levelAllowed(pick.level, u.setting.policy))
				.map(({ u, pick }) => ({ service: u.service, tag: pick!.tag }));
			if (changes.length === 0) continue;
			const host = await getHost(stack.hostId);
			if (!host) continue;
			await this.upgrade(stack, changes, { id: null, ip: null });
			started++;
		}
		return started;
	}
}
