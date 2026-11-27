import { isMap, isScalar, parseDocument, Scalar } from "yaml";

export interface ImageRef {
	/** As written, without a digest. */
	raw: string;
	registry: string;
	repository: string;
	tag: string;
	digest: string | null;
}

/** Splits an image reference the way Docker does: no dot, colon or localhost in the first part means Docker Hub. */
export function parseImage(value: string): ImageRef | null {
	const raw = value.trim();
	if (raw.length === 0 || raw.length > 512 || /\s|\$/.test(raw)) return null;
	let rest = raw;
	let digest: string | null = null;
	const at = rest.indexOf("@");
	if (at !== -1) {
		digest = rest.slice(at + 1);
		rest = rest.slice(0, at);
		if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return null;
	}
	let registry = "docker.io";
	const slash = rest.indexOf("/");
	if (slash !== -1) {
		const first = rest.slice(0, slash);
		if (first.includes(".") || first.includes(":") || first === "localhost") {
			registry = first;
			rest = rest.slice(slash + 1);
		}
	}
	let tag = "latest";
	const colon = rest.lastIndexOf(":");
	if (colon !== -1) {
		tag = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}
	if (!/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/.test(rest) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return null;
	if (registry === "docker.io" && !rest.includes("/")) rest = `library/${rest}`;
	return { raw: digest ? raw.slice(0, raw.indexOf("@")) : raw, registry, repository: rest, tag, digest };
}

/** The name Docker shows for a repository, without docker.io and library. */
export function displayName(ref: ImageRef): string {
	const repo = ref.registry === "docker.io" ? ref.repository.replace(/^library\//, "") : `${ref.registry}/${ref.repository}`;
	return repo;
}

export interface TagVersion {
	prefix: string;
	numbers: number[];
	suffix: string;
}

const PRERELEASE = /(^|[-._])(rc|beta|alpha|dev|preview|nightly|snapshot|test|pre|canary|edge)\d*([-._]|$)/i;

export function parseTag(tag: string): TagVersion | null {
	const match = /^(v?)(\d+(?:\.\d+){0,3})(.*)$/.exec(tag);
	if (!match) return null;
	return { prefix: match[1]!, numbers: match[2]!.split(".").map(Number), suffix: match[3]! };
}

export type UpdateLevel = "major" | "minor" | "patch";
export type Policy = "off" | "patch" | "minor" | "major";
export const POLICIES: readonly Policy[] = ["off", "patch", "minor", "major"];
export const AUTO_LEVELS: readonly ("off" | "patch" | "minor")[] = ["off", "patch", "minor"];
const RANK: Record<UpdateLevel, number> = { patch: 1, minor: 2, major: 3 };

export function levelAllowed(level: UpdateLevel, policy: Policy | "off" | "patch" | "minor"): boolean {
	if (policy === "off") return false;
	return RANK[level] <= RANK[policy];
}

function compareNumbers(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

export interface NewerTag {
	tag: string;
	level: UpdateLevel;
}

/**
 * Newer tags of the same shape: same prefix, same count of numbers and the same
 * suffix, so 4.5.1-alpine only moves to x.y.z-alpine. Pre-releases count only
 * when the current tag is one. Newest first.
 */
export function newerTags(current: string, tags: Iterable<string>): NewerTag[] {
	const base = parseTag(current);
	if (!base) return [];
	const pre = PRERELEASE.test(base.suffix);
	const out: (NewerTag & { numbers: number[] })[] = [];
	for (const tag of tags) {
		const v = parseTag(tag);
		if (!v || v.prefix !== base.prefix || v.suffix !== base.suffix || v.numbers.length !== base.numbers.length) continue;
		if (!pre && PRERELEASE.test(v.suffix)) continue;
		if (compareNumbers(v.numbers, base.numbers) <= 0) continue;
		const first = v.numbers.findIndex((n, i) => n !== base.numbers[i]);
		out.push({ tag, level: first === 0 ? "major" : first === 1 ? "minor" : "patch", numbers: v.numbers });
	}
	return out.sort((a, b) => compareNumbers(b.numbers, a.numbers)).map(({ tag, level }) => ({ tag, level }));
}

/** The newest tag a policy allows, or null. */
export function bestTag(newer: NewerTag[], policy: Policy | "patch" | "minor"): NewerTag | null {
	return newer.find((n) => levelAllowed(n.level, policy)) ?? null;
}

/** Fills ${VAR}, ${VAR:-default} and $VAR from the stack's .env, enough to know which image a service uses. */
export function interpolate(value: string, env: Map<string, string>): string | null {
	let unresolved = false;
	const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, fallback, bare) => {
		const name = braced ?? bare;
		const v = env.get(name);
		if (v !== undefined && v !== "") return v;
		if (fallback !== undefined) return fallback;
		unresolved = true;
		return "";
	});
	return unresolved ? null : out;
}

export interface ServiceImage {
	service: string;
	/** As written in the file, possibly with variables. */
	written: string;
	/** After variables from .env, or null when one is missing. */
	image: string | null;
	/** Whether the image line can be rewritten, which needs a plain value without variables. */
	editable: boolean;
}

export function serviceImages(compose: string, env: Map<string, string>): ServiceImage[] {
	const doc = parseDocument(compose);
	if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
	const services = doc.contents.get("services", true);
	if (!isMap(services)) return [];
	const out: ServiceImage[] = [];
	for (const pair of services.items) {
		if (!isScalar(pair.key) || !isMap(pair.value)) continue;
		const node = pair.value.get("image", true);
		if (!isScalar(node) || typeof node.value !== "string") continue;
		const written = node.value;
		out.push({
			service: String(pair.key.value),
			written,
			image: written.includes("$") ? interpolate(written, env) : written,
			editable: !written.includes("$"),
		});
	}
	return out;
}

/**
 * Changes the image of one service and nothing else: the source is edited at the
 * value's position, so comments, quotes, anchors and layout stay as they were.
 */
export function setServiceImage(compose: string, service: string, image: string): string {
	const doc = parseDocument(compose);
	if (doc.errors.length > 0) throw new Error("The compose file cannot be read.");
	const node = doc.getIn(["services", service, "image"], true);
	if (!(node instanceof Scalar) || !node.range) throw new Error(`Service ${service} has no image line.`);
	if (typeof node.value === "string" && node.value.includes("$")) throw new Error(`The image of ${service} uses a variable. Change it in the .env file.`);
	if (!/^[A-Za-z0-9._/:@-]+$/.test(image)) throw new Error("That is not an image reference.");
	const [start, end] = node.range;
	const quoted = node.type === Scalar.QUOTE_DOUBLE ? `"${image}"` : node.type === Scalar.QUOTE_SINGLE ? `'${image}'` : image;
	return compose.slice(0, start) + quoted + compose.slice(end);
}

/** The image reference with another tag, keeping the registry and repository as written. */
export function withTag(written: string, tag: string): string {
	const ref = parseImage(written);
	if (!ref) throw new Error("That is not an image reference.");
	const at = written.indexOf("@");
	const base = at === -1 ? written : written.slice(0, at);
	const slash = base.lastIndexOf("/");
	const colon = base.lastIndexOf(":");
	const name = colon > slash ? base.slice(0, colon) : base;
	return `${name}:${tag}`;
}

/** Where release notes usually are, from the OCI source label images carry. */
export function releaseNotesUrl(labels: Record<string, string>): string | null {
	const source = labels["org.opencontainers.image.source"] ?? labels["org.label-schema.vcs-url"];
	if (!source) return null;
	const match = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+/.exec(source.replace(/\.git$/, ""));
	if (!match) return null;
	return match[1] === "github.com" ? `${match[0]}/releases` : match[0];
}
