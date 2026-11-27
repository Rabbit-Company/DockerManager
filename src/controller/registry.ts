import type { ImageRef } from "../shared/images.ts";

export interface Credentials {
	username: string;
	password: string;
}

export class RegistryError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
	}
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
].join(", ");

const MAX_TAG_PAGES = 20;
const TIMEOUT_MS = 15_000;

/** Registries whose token service lives on another, well known origin. */
const KNOWN_AUTH_ORIGINS: Record<string, string> = {
	"lscr.io": "https://ghcr.io",
	"registry.gitlab.com": "https://gitlab.com",
};

/** Reads `Bearer realm="...",service="...",scope="..."` into its parts. */
export function parseChallenge(header: string): { scheme: string; params: Record<string, string> } | null {
	const match = /^(\w+)\s+(.*)$/.exec(header.trim());
	if (!match) return null;
	const params: Record<string, string> = {};
	for (const part of match[2]!.matchAll(/(\w+)="([^"]*)"/g)) params[part[1]!.toLowerCase()] = part[2]!;
	return { scheme: match[1]!.toLowerCase(), params };
}

export function nextLink(header: string | null): string | null {
	if (!header) return null;
	const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(header);
	return match ? match[1]! : null;
}

/**
 * Talks to OCI registries the way docker pull does: an anonymous or
 * authenticated token from the realm the registry names, kept until it expires.
 */
export class RegistryClient {
	private readonly tokens = new Map<string, { token: string; expires: number }>();

	constructor(
		private readonly credentials: (registry: string) => Promise<Credentials | null>,
		private readonly insecure: Set<string> = new Set(),
		private readonly fetcher: typeof fetch = fetch,
		private readonly authRealms: Map<string, string> = new Map(),
	) {}

	private base(registry: string): string {
		const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
		return `${this.insecure.has(registry) ? "http" : "https"}://${host}`;
	}

	/**
	 * Where a token may be fetched. Stored credentials only go to the registry itself, Docker Hub's
	 * auth service, a known pair such as lscr.io and ghcr.io, or an origin configured in
	 * REGISTRY_AUTH_REALMS. Anonymous token requests carry no secret, so any HTTPS origin will do.
	 */
	private authOrigin(registry: string, realm: string, withCredentials: boolean): URL {
		let url: URL;
		try {
			url = new URL(realm);
		} catch {
			throw new RegistryError(`${registry} named an authentication address that is not valid.`);
		}
		const own = new URL(this.base(registry)).origin;
		if (url.username || url.password) throw new RegistryError(`${registry} named an authentication address with a password in it.`);
		if (url.protocol !== "https:" && url.origin !== own) throw new RegistryError(`${registry} requested an authentication origin without HTTPS.`);
		if (!withCredentials) return url;
		const trusted = new Set([own]);
		if (registry === "docker.io") trusted.add("https://auth.docker.io");
		const known = KNOWN_AUTH_ORIGINS[registry];
		if (known) trusted.add(known);
		const extra = this.authRealms.get(registry);
		if (extra) {
			const parsed = new URL(extra);
			if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash)
				throw new RegistryError(`The configured authentication origin for ${registry} is invalid.`);
			trusted.add(parsed.origin);
		}
		if (!trusted.has(url.origin))
			throw new RegistryError(
				`${registry} requested an untrusted authentication origin, ${url.origin}. If it belongs to the registry, add ${registry}=${url.origin} to REGISTRY_AUTH_REALMS.`,
			);
		return url;
	}

	private async token(registry: string, challenge: { scheme: string; params: Record<string, string> }, scope: string): Promise<string> {
		const key = `${registry} ${scope}`;
		const cached = this.tokens.get(key);
		if (cached && cached.expires > Date.now()) return cached.token;
		const realm = challenge.params.realm;
		if (!realm) throw new RegistryError("The registry asked for a token without saying where to get it.");
		const creds = await this.credentials(registry);
		const url = this.authOrigin(registry, realm, creds !== null);
		if (challenge.params.service) url.searchParams.set("service", challenge.params.service);
		url.searchParams.set("scope", scope);
		const headers: Record<string, string> = {};
		if (creds) headers.Authorization = `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
		const response = await this.fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (response.status >= 300 && response.status < 400) throw new RegistryError("The registry authentication service redirected to another address.");
		if (!response.ok)
			throw new RegistryError(
				response.status === 401 ? "The registry refused the stored credentials." : `Getting a registry token failed with ${response.status}.`,
				response.status,
			);
		const body = (await response.json()) as { token?: string; access_token?: string; expires_in?: number };
		const token = body.token ?? body.access_token;
		if (!token) throw new RegistryError("The registry sent no token.");
		this.tokens.set(key, { token, expires: Date.now() + Math.max(30, (body.expires_in ?? 300) - 30) * 1000 });
		return token;
	}

	private async request(ref: ImageRef, path: string, init: { method?: string; accept?: string } = {}): Promise<Response> {
		const base = this.base(ref.registry);
		const url = new URL(path, base);
		if (url.origin !== new URL(base).origin) throw new RegistryError(`${ref.registry} sent a link to another origin.`);
		const scope = `repository:${ref.repository}:pull`;
		const headers: Record<string, string> = {};
		if (init.accept) headers.Accept = init.accept;
		const cached = this.tokens.get(`${ref.registry} ${scope}`);
		if (cached && cached.expires > Date.now()) headers.Authorization = `Bearer ${cached.token}`;
		let response: Response;
		try {
			response = await this.fetcher(url, { method: init.method ?? "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (err) {
			throw new RegistryError(`${ref.registry} could not be reached: ${(err as Error).message}`);
		}
		if (response.status === 401) {
			await response.body?.cancel();
			const challenge = parseChallenge(response.headers.get("WWW-Authenticate") ?? "");
			if (challenge?.scheme === "bearer") {
				headers.Authorization = `Bearer ${await this.token(ref.registry, challenge, scope)}`;
			} else if (challenge?.scheme === "basic") {
				const creds = await this.credentials(ref.registry);
				if (!creds) throw new RegistryError(`${ref.registry} needs a login. Add one under Registries.`, 401);
				headers.Authorization = `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
			} else {
				throw new RegistryError(`${ref.registry} refused the request.`, 401);
			}
			response = await this.fetcher(url, { method: init.method ?? "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
		}
		if (response.status >= 300 && response.status < 400) throw new RegistryError(`${ref.registry} redirected to another address.`, response.status);
		if (response.status === 401 || response.status === 403)
			throw new RegistryError(`${ref.registry} refused access to ${ref.repository}. Add a login under Registries if it is private.`, response.status);
		if (response.status === 404) throw new RegistryError(`${ref.repository}:${ref.tag} does not exist on ${ref.registry}.`, 404);
		if (response.status === 429) throw new RegistryError(`${ref.registry} rate limited the check. It is tried again later.`, 429);
		if (!response.ok) throw new RegistryError(`${ref.registry} answered ${response.status}.`, response.status);
		return response;
	}

	/** The digest the tag points to now. HEAD requests do not count against Docker Hub's pull limit. */
	async digest(ref: ImageRef): Promise<string> {
		const path = `/v2/${ref.repository}/manifests/${ref.tag}`;
		const head = await this.request(ref, path, { method: "HEAD", accept: MANIFEST_TYPES });
		const digest = head.headers.get("Docker-Content-Digest");
		if (digest) return digest;
		const full = await this.request(ref, path, { accept: MANIFEST_TYPES });
		const body = new Uint8Array(await full.arrayBuffer());
		return `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;
	}

	async tags(ref: ImageRef): Promise<string[]> {
		const out: string[] = [];
		let next: string | null = `/v2/${ref.repository}/tags/list?n=1000`;
		for (let page = 0; next && page < MAX_TAG_PAGES; page++) {
			const response = await this.request(ref, next.startsWith("/") || next.startsWith("http") ? next : `/${next}`);
			const body = (await response.json()) as { tags?: string[] | null };
			out.push(...(body.tags ?? []));
			next = nextLink(response.headers.get("Link"));
		}
		return out;
	}
}
