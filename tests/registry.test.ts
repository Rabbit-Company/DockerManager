import { afterAll, describe, expect, test } from "bun:test";
import { parseImage } from "../src/shared/images.ts";
import { nextLink, parseChallenge, RegistryClient } from "../src/controller/registry.ts";
import { FakeRegistry } from "./fake-registry.ts";

test("challenges and link headers", () => {
	expect(parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"')).toEqual({
		scheme: "bearer",
		params: { realm: "https://auth.docker.io/token", service: "registry.docker.io", scope: "repository:library/nginx:pull" },
	});
	expect(parseChallenge('Basic realm="x"')?.scheme).toBe("basic");
	expect(nextLink('</v2/a/tags/list?n=2&last=b>; rel="next"')).toBe("/v2/a/tags/list?n=2&last=b");
	expect(nextLink(null)).toBeNull();
});

describe("registry client", () => {
	const registry = new FakeRegistry();
	afterAll(() => registry.stop());
	let creds: { username: string; password: string } | null = null;
	const client = new RegistryClient(async () => creds, new Set([registry.host]));
	const ref = (tag: string) => parseImage(`${registry.host}/library/nginx:${tag}`)!;

	test("gets a token once and reads digests with HEAD", async () => {
		registry.set("library/nginx", "1.27.0", `sha256:${"1".repeat(64)}`);
		expect(await client.digest(ref("1.27.0"))).toBe(`sha256:${"1".repeat(64)}`);
		expect(await client.digest(ref("1.27.0"))).toBe(`sha256:${"1".repeat(64)}`);
		expect(registry.requests.filter((r) => r.startsWith("GET /token"))).toHaveLength(1);
		expect(registry.requests.filter((r) => r.startsWith("GET /v2/"))).toHaveLength(0);
	});

	test("falls back to hashing the manifest when HEAD has no digest", async () => {
		registry.headWithoutDigest = true;
		const body = `{"manifest":"sha256:${"1".repeat(64)}"}`;
		expect(await client.digest(ref("1.27.0"))).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`);
		registry.headWithoutDigest = false;
	});

	test("follows tag pages", async () => {
		registry.pageSize = 2;
		for (const t of ["1.27.1", "1.28.0", "2.0.0", "latest"]) registry.set("library/nginx", t, `sha256:${"2".repeat(64)}`);
		expect(await client.tags(ref("1.27.0"))).toEqual(["1.27.0", "1.27.1", "1.28.0", "2.0.0", "latest"]);
		registry.pageSize = 1000;
	});

	test("errors say what happened", async () => {
		await expect(client.digest(ref("9.9.9"))).rejects.toThrow("does not exist");
		await expect(client.digest(parseImage(`${registry.host}/private/app:1`)!)).rejects.toThrow("does not exist");
		registry.rateLimited = true;
		await expect(client.digest(ref("1.27.0"))).rejects.toThrow("rate limited");
		registry.rateLimited = false;
	});

	test("uses stored credentials for the token", async () => {
		registry.basic = { username: "me", password: "secret" };
		registry.set("team/app", "1.0.0", `sha256:${"3".repeat(64)}`);
		const app = parseImage(`${registry.host}/team/app:1.0.0`)!;
		await expect(client.digest(app)).rejects.toThrow("refused the stored credentials");
		creds = { username: "me", password: "secret" };
		expect(await client.digest(app)).toBe(`sha256:${"3".repeat(64)}`);
		registry.basic = null;
	});

	test("an unreachable registry is reported, not thrown raw", async () => {
		const offline = new RegistryClient(async () => null, new Set(["127.0.0.1:1"]));
		await expect(offline.digest(parseImage("127.0.0.1:1/a/b:1")!)).rejects.toThrow("could not be reached");
	});

	test("does not send credentials to an untrusted token service", async () => {
		const calls: string[] = [];
		const fetcher = (async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="http://127.0.0.1/token"' } });
		}) as unknown as typeof fetch;
		const guarded = new RegistryClient(async () => ({ username: "me", password: "secret" }), new Set(), fetcher);
		await expect(guarded.digest(parseImage("registry.example.com/team/app:1")!)).rejects.toThrow("without HTTPS");
		expect(calls).toHaveLength(1);
		const https = (async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://evil.example.net/token"' } });
		}) as unknown as typeof fetch;
		const other = new RegistryClient(async () => ({ username: "me", password: "secret" }), new Set(), https);
		await expect(other.digest(parseImage("registry.example.com/team/app:1")!)).rejects.toThrow("REGISTRY_AUTH_REALMS");
		expect(calls).toHaveLength(2);
	});

	test("anonymous tokens come from the token service the registry names, such as ghcr.io for lscr.io", async () => {
		const seen: { url: string; auth: string | null }[] = [];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			const auth = new Headers(init?.headers).get("Authorization");
			seen.push({ url: String(url), auth });
			if (String(url).startsWith("https://ghcr.io/token")) return Response.json({ token: "anon" });
			if (auth === "Bearer anon") return new Response(null, { headers: { "Docker-Content-Digest": `sha256:${"b".repeat(64)}` } });
			return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } });
		}) as unknown as typeof fetch;
		const client = new RegistryClient(async () => null, new Set(), fetcher);
		expect(await client.digest(parseImage("lscr.io/linuxserver/nginx:latest")!)).toBe(`sha256:${"b".repeat(64)}`);
		expect(seen.find((s) => s.url.startsWith("https://ghcr.io/token"))?.auth).toBeNull();
		const withLogin = new RegistryClient(async () => ({ username: "me", password: "secret" }), new Set(), fetcher);
		expect(await withLogin.digest(parseImage("lscr.io/linuxserver/nginx:latest")!)).toBe(`sha256:${"b".repeat(64)}`);
	});

	test("does not follow tag links to another origin", async () => {
		let calls = 0;
		const fetcher = (async () => {
			calls++;
			return Response.json({ tags: ["1"] }, { headers: { Link: '<https://other.example.com/tags>; rel="next"' } });
		}) as unknown as typeof fetch;
		const guarded = new RegistryClient(async () => null, new Set(), fetcher);
		await expect(guarded.tags(parseImage("registry.example.com/team/app:1")!)).rejects.toThrow("link to another origin");
		expect(calls).toBe(1);
	});

	test("uses a configured separate token service", async () => {
		let credential: string | null = null;
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).startsWith("https://auth.example.com/")) {
				credential = new Headers(init?.headers).get("Authorization");
				return Response.json({ token: "token" });
			}
			if (new Headers(init?.headers).get("Authorization") === "Bearer token")
				return new Response(null, { headers: { "Docker-Content-Digest": `sha256:${"a".repeat(64)}` } });
			return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example.com/token"' } });
		}) as unknown as typeof fetch;
		const client = new RegistryClient(
			async () => ({ username: "me", password: "secret" }),
			new Set(),
			fetcher,
			new Map([["registry.example.com", "https://auth.example.com"]]),
		);
		expect(await client.digest(parseImage("registry.example.com/team/app:1")!)).toBe(`sha256:${"a".repeat(64)}`);
		expect(credential ?? "").toBe(`Basic ${btoa("me:secret")}`);
	});
});
