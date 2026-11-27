/** A small OCI registry: bearer tokens like Docker Hub, or Basic auth, digests on HEAD and paged tag lists. */
export class FakeRegistry {
	repos = new Map<string, Map<string, string>>();
	requests: string[] = [];
	basic: { username: string; password: string } | null = null;
	headWithoutDigest = false;
	rateLimited = false;
	pageSize = 1000;
	private server: ReturnType<typeof Bun.serve>;

	constructor() {
		this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
	}

	get host(): string {
		return `127.0.0.1:${this.server.port}`;
	}

	set(repo: string, tag: string, digest: string): void {
		if (!this.repos.has(repo)) this.repos.set(repo, new Map());
		this.repos.get(repo)!.set(tag, digest);
	}

	stop(): void {
		this.server.stop(true);
	}

	private handle(req: Request): Response {
		const url = new URL(req.url);
		this.requests.push(`${req.method} ${url.pathname}${url.search}`);
		if (url.pathname === "/token") {
			if (this.basic) {
				const expected = `Basic ${btoa(`${this.basic.username}:${this.basic.password}`)}`;
				if (req.headers.get("Authorization") !== expected) return new Response("no", { status: 401 });
			}
			return Response.json({ token: `tok-${url.searchParams.get("scope")}`, expires_in: 300 });
		}
		const match = /^\/v2\/(.+)\/(manifests|tags)\/(.+)$/.exec(url.pathname);
		if (!match) return new Response("not found", { status: 404 });
		const [, repo, kind, rest] = match;
		const auth = req.headers.get("Authorization") ?? "";
		if (auth !== `Bearer tok-repository:${repo}:pull`) {
			return new Response(null, {
				status: 401,
				headers: { "WWW-Authenticate": `Bearer realm="http://${this.host}/token",service="fake",scope="repository:${repo}:pull"` },
			});
		}
		if (this.rateLimited) return new Response("slow down", { status: 429 });
		const tags = this.repos.get(repo!);
		if (!tags) return Response.json({ errors: [{ code: "NAME_UNKNOWN" }] }, { status: 404 });
		if (kind === "manifests") {
			const digest = tags.get(rest!);
			if (!digest) return new Response(null, { status: 404 });
			const headers: Record<string, string> = { "Content-Type": "application/vnd.oci.image.index.v1+json" };
			if (!this.headWithoutDigest) headers["Docker-Content-Digest"] = digest;
			return new Response(req.method === "HEAD" ? null : `{"manifest":"${digest}"}`, { headers });
		}
		const all = [...tags.keys()];
		const last = url.searchParams.get("last");
		const start = last ? all.indexOf(last) + 1 : 0;
		const page = all.slice(start, start + this.pageSize);
		const headers: Record<string, string> = {};
		if (start + this.pageSize < all.length) headers.Link = `</v2/${repo}/tags/list?n=${this.pageSize}&last=${page[page.length - 1]}>; rel="next"`;
		return Response.json({ name: repo, tags: page }, { headers });
	}
}
