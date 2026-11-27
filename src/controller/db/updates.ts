import type { Policy } from "../../shared/images.ts";
import { decrypt, encrypt } from "../lib/secrets.ts";
import { iso, sql, timestamp } from "./index.ts";

export interface RegistryLogin {
	id: number;
	registry: string;
	username: string;
	createdAt: string;
}

export async function listRegistryLogins(): Promise<RegistryLogin[]> {
	const rows = await sql`SELECT id, registry, username, created_at FROM registry_credentials ORDER BY registry`;
	return rows.map((r: any) => ({ id: Number(r.id), registry: r.registry, username: r.username, createdAt: iso(r.created_at) }));
}

export async function registryCredentials(registry: string): Promise<{ username: string; password: string } | null> {
	const [row] = await sql`SELECT username, secret FROM registry_credentials WHERE registry = ${registry}`;
	return row ? { username: row.username, password: decrypt(row.secret) } : null;
}

export async function saveRegistryLogin(registry: string, username: string, password: string): Promise<void> {
	await sql`
		INSERT INTO registry_credentials (registry, username, secret) VALUES (${registry}, ${username}, ${encrypt(password)})
		ON CONFLICT (registry) DO UPDATE SET username = excluded.username, secret = excluded.secret`;
}

export async function deleteRegistryLogin(id: number): Promise<string | null> {
	const rows = await sql`DELETE FROM registry_credentials WHERE id = ${id} RETURNING registry`;
	return rows.length > 0 ? rows[0].registry : null;
}

export interface DigestEntry {
	digest: string | null;
	error: string | null;
	checkedAt: string;
}

export interface TagsEntry {
	tags: string[];
	error: string | null;
	checkedAt: string;
}

export async function loadDigests(): Promise<Map<string, DigestEntry>> {
	const rows = await sql`SELECT registry, repository, tag, digest, error, checked_at FROM image_digests`;
	return new Map(
		rows.map((r: any) => [`${r.registry}/${r.repository}:${r.tag}`, { digest: r.digest ?? null, error: r.error ?? null, checkedAt: iso(r.checked_at) }]),
	);
}

export async function loadTags(): Promise<Map<string, TagsEntry>> {
	const rows = await sql`SELECT registry, repository, tags, error, checked_at FROM image_tags`;
	return new Map(
		rows.map((r: any) => [
			`${r.registry}/${r.repository}`,
			{ tags: r.tags ? String(r.tags).split("\n") : [], error: r.error ?? null, checkedAt: iso(r.checked_at) },
		]),
	);
}

export async function saveDigest(registry: string, repository: string, tag: string, entry: DigestEntry): Promise<void> {
	await sql`
		INSERT INTO image_digests (registry, repository, tag, digest, error, checked_at)
		VALUES (${registry}, ${repository}, ${tag}, ${entry.digest}, ${entry.error}, ${timestamp(new Date(entry.checkedAt))})
		ON CONFLICT (registry, repository, tag) DO UPDATE SET digest = excluded.digest, error = excluded.error, checked_at = excluded.checked_at`;
}

export async function saveTags(registry: string, repository: string, entry: TagsEntry): Promise<void> {
	await sql`
		INSERT INTO image_tags (registry, repository, tags, error, checked_at)
		VALUES (${registry}, ${repository}, ${entry.tags.join("\n")}, ${entry.error}, ${timestamp(new Date(entry.checkedAt))})
		ON CONFLICT (registry, repository) DO UPDATE SET tags = excluded.tags, error = excluded.error, checked_at = excluded.checked_at`;
}

export interface ServiceSetting {
	policy: Policy;
	auto: "off" | "patch" | "minor";
}

export const DEFAULT_SETTING: ServiceSetting = { policy: "minor", auto: "off" };

export async function serviceSettings(stackId: number): Promise<Map<string, ServiceSetting>> {
	const rows = await sql`SELECT service, policy, auto FROM stack_services WHERE stack_id = ${stackId}`;
	return new Map(rows.map((r: any) => [r.service, { policy: r.policy, auto: r.auto }]));
}

export async function saveServiceSetting(stackId: number, service: string, setting: ServiceSetting): Promise<void> {
	await sql`
		INSERT INTO stack_services (stack_id, service, policy, auto) VALUES (${stackId}, ${service}, ${setting.policy}, ${setting.auto})
		ON CONFLICT (stack_id, service) DO UPDATE SET policy = excluded.policy, auto = excluded.auto`;
}

/** Stacks where some service updates on its own. */
export async function stacksWithAutoUpdates(): Promise<number[]> {
	const rows = await sql`SELECT DISTINCT stack_id FROM stack_services WHERE auto <> 'off'`;
	return rows.map((r: any) => Number(r.stack_id));
}
