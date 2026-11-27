import { expect, test } from "bun:test";
import { bestTag, displayName, interpolate, newerTags, parseImage, releaseNotesUrl, serviceImages, setServiceImage, withTag } from "../src/shared/images.ts";

test("image references are split like Docker splits them", () => {
	expect(parseImage("nginx")).toMatchObject({ registry: "docker.io", repository: "library/nginx", tag: "latest" });
	expect(parseImage("louislam/uptime-kuma:1.23.16")).toMatchObject({ registry: "docker.io", repository: "louislam/uptime-kuma", tag: "1.23.16" });
	expect(parseImage("ghcr.io/org/app:v2")).toMatchObject({ registry: "ghcr.io", repository: "org/app", tag: "v2" });
	expect(parseImage("localhost:5000/app")).toMatchObject({ registry: "localhost:5000", repository: "app", tag: "latest" });
	expect(parseImage(`nginx:1@sha256:${"a".repeat(64)}`)?.digest).toBe(`sha256:${"a".repeat(64)}`);
	for (const bad of ["", "Nginx", "nginx:${TAG}", "a b", "nginx@sha256:short"]) expect(parseImage(bad)).toBeNull();
	expect(displayName(parseImage("nginx:1")!)).toBe("nginx");
	expect(displayName(parseImage("ghcr.io/org/app")!)).toBe("ghcr.io/org/app");
});

test("only tags of the same shape count, pre-releases are skipped", () => {
	const tags = ["1.27.0", "1.27.1", "1.27.10", "1.28.0", "2.0.0", "1.27.1-alpine", "1.29.0-rc1", "1.27", "latest", "1.26.9", "mainline"];
	expect(newerTags("1.27.0", tags)).toEqual([
		{ tag: "2.0.0", level: "major" },
		{ tag: "1.28.0", level: "minor" },
		{ tag: "1.27.10", level: "patch" },
		{ tag: "1.27.1", level: "patch" },
	]);
	expect(newerTags("1.27.0-alpine", ["1.27.1-alpine", "1.27.2", "1.28.0-alpine"]).map((n) => n.tag)).toEqual(["1.28.0-alpine", "1.27.1-alpine"]);
	expect(newerTags("v1.2", ["v1.3", "1.4", "v2.0"]).map((n) => n.tag)).toEqual(["v2.0", "v1.3"]);
	expect(newerTags("2.0.0-rc1", ["2.0.0-rc2"])).toEqual([]);
	expect(newerTags("latest", tags)).toEqual([]);
	const newer = newerTags("1.27.0", tags);
	expect(bestTag(newer, "patch")?.tag).toBe("1.27.10");
	expect(bestTag(newer, "minor")?.tag).toBe("1.28.0");
	expect(bestTag(newer, "major")?.tag).toBe("2.0.0");
});

test("rewriting an image keeps everything else exactly", () => {
	const source = `x-base: &base
  restart: unless-stopped
services:
  web:
    <<: *base
    # pinned on purpose
    image: "nginx:1.27.0" # stable line
    ports: ["8080:80"]
  db:
    image: 'postgres:17.2'
  cache:
    image: redis:7.4.1
`;
	expect(setServiceImage(source, "web", withTag("nginx:1.27.0", "1.27.3"))).toBe(source.replace('"nginx:1.27.0"', '"nginx:1.27.3"'));
	expect(setServiceImage(source, "db", "postgres:17.3")).toBe(source.replace("'postgres:17.2'", "'postgres:17.3'"));
	expect(setServiceImage(source, "cache", "redis:7.4.2")).toBe(source.replace("redis:7.4.1", "redis:7.4.2"));
	expect(() => setServiceImage(source, "missing", "x:1")).toThrow("has no image");
	expect(() => setServiceImage("services:\n  a:\n    image: x:${T}\n", "a", "x:2")).toThrow("uses a variable");
	expect(withTag("localhost:5000/team/app:1.0", "1.1")).toBe("localhost:5000/team/app:1.1");
	expect(withTag("nginx", "1.27")).toBe("nginx:1.27");
});

test("variables in image lines are filled from the stack's .env", () => {
	const env = new Map([["TAG", "1.2.3"]]);
	expect(interpolate("app:${TAG}", env)).toBe("app:1.2.3");
	expect(interpolate("app:$TAG", env)).toBe("app:1.2.3");
	expect(interpolate("app:${OTHER:-9}", env)).toBe("app:9");
	expect(interpolate("app:${OTHER}", env)).toBeNull();
	expect(serviceImages("services:\n  a:\n    image: x:${TAG}\n  b:\n    build: .\n  c:\n    image: y:1\n", env)).toEqual([
		{ service: "a", written: "x:${TAG}", image: "x:1.2.3", editable: false },
		{ service: "c", written: "y:1", image: "y:1", editable: true },
	]);
});

test("release notes come from the source label", () => {
	expect(releaseNotesUrl({ "org.opencontainers.image.source": "https://github.com/nginx/docker-nginx" })).toBe(
		"https://github.com/nginx/docker-nginx/releases",
	);
	expect(releaseNotesUrl({ "org.opencontainers.image.source": "https://gitlab.com/a/b.git" })).toBe("https://gitlab.com/a/b");
	expect(releaseNotesUrl({ "org.opencontainers.image.source": "javascript:alert(1)" })).toBeNull();
	expect(releaseNotesUrl({})).toBeNull();
});
