import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "packaging", "install.sh");
const work = mkdtempSync(join(tmpdir(), "dm-install-"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const archive = `dockermanager-linux-${arch}.tar.gz`;
const files = new Map<string, Uint8Array<ArrayBuffer>>();
let server: ReturnType<typeof Bun.serve>;
let tamper = false;

function release(tag: string): void {
	const stage = join(work, `stage-${tag}`);
	mkdirSync(stage, { recursive: true });
	writeFileSync(join(stage, "dockermanager-controller"), `controller ${tag}\n`);
	writeFileSync(join(stage, "agent-linux-x64"), `agent x64 ${tag}\n`);
	writeFileSync(join(stage, "agent-linux-arm64"), `agent arm64 ${tag}\n`);
	writeFileSync(join(stage, "dockermanager-controller.service"), "[Unit]\nDescription=test\n");
	const out = join(work, `${tag}.tar.gz`);
	Bun.spawnSync(["tar", "-czf", out, "-C", stage, "."]);
	const bytes = new Uint8Array(readFileSync(out));
	files.set(`${tag}/${archive}`, bytes);
	const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	files.set(`${tag}/SHA256SUMS`, new TextEncoder().encode(`${sum}  ${archive}\n`));
}

beforeAll(() => {
	release("v1.0.0");
	release("v1.1.0");
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/latest") return Response.redirect(`http://127.0.0.1:${server.port}/tag/${latest}`, 302);
			if (path.startsWith("/tag/")) return new Response("release page");
			const match = /^\/download\/(.+)$/.exec(path);
			const body = match ? files.get(match[1]!) : undefined;
			if (!body) return new Response("missing", { status: 404 });
			if (tamper && path.endsWith(".tar.gz")) return new Response(new Blob([body, new Uint8Array([1])]));
			return new Response(body);
		},
	});
	const bin = join(work, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${join(work, "systemctl.log")}"\n`);
	chmodSync(join(bin, "systemctl"), 0o755);
});

afterAll(() => {
	server.stop(true);
	rmSync(work, { recursive: true, force: true });
});

let latest = "v1.0.0";

async function run(root: string, env: Record<string, string> = {}, args: string[] = []) {
	const proc = Bun.spawn(["sh", script, ...args], {
		env: {
			PATH: `${join(work, "bin")}:${process.env.PATH}`,
			DM_ROOT: root,
			BASE_URL: `http://127.0.0.1:${server.port}`,
			TZ: "Europe/Ljubljana",
			...env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, out, err };
}

test("a fresh install picks the archive for this machine, writes the settings and prints the setup link", async () => {
	const root = join(work, "root-a");
	const r = await run(root, { DOMAIN: "https://docker.example.com/" });
	expect(r.err).toBe("");
	expect(r.code).toBe(0);
	expect(readFileSync(join(root, "usr/local/bin/dockermanager-controller"), "utf8")).toBe("controller v1.0.0\n");
	expect(existsSync(join(root, "opt/dockermanager/agent-linux-x64"))).toBe(true);
	expect(existsSync(join(root, "opt/dockermanager/agent-linux-arm64"))).toBe(true);
	const conf = readFileSync(join(root, "etc/dockermanager/controller.env"), "utf8");
	expect(conf).toContain("DOMAIN=https://docker.example.com\n");
	expect(conf).toContain("BIND_ADDRESS=127.0.0.1\n");
	expect(conf).toContain("TZ=Europe/Ljubljana\n");
	const token = /SETUP_TOKEN=([A-Za-z0-9]{20,})\n/.exec(conf)![1]!;
	expect(r.out).toContain("Downloading DockerManager v1.0.0 for " + arch);
	expect(r.out).toContain("Open      https://docker.example.com/setup");
	expect(r.out).toContain(`Token     ${token}`);
	expect(readFileSync(join(work, "systemctl.log"), "utf8")).toContain("restart dockermanager-controller");
});

test("a plain http address listens on every interface", async () => {
	const root = join(work, "root-b");
	const r = await run(root, { DOMAIN: "http://10.0.0.5:3000" });
	expect(r.code).toBe(0);
	expect(readFileSync(join(root, "etc/dockermanager/controller.env"), "utf8")).toContain("BIND_ADDRESS=0.0.0.0\n");
	expect(r.out).toContain("Put it behind HTTPS");
	expect((await run(join(work, "root-c"), { DOMAIN: "docker.example.com" })).err).toContain("must start with http:// or https://");
});

test("running it again updates to the latest release and keeps the settings", async () => {
	const root = join(work, "root-a");
	const before = readFileSync(join(root, "etc/dockermanager/controller.env"), "utf8");
	latest = "v1.1.0";
	const r = await run(root);
	expect(r.code).toBe(0);
	expect(r.out).toContain("updated to v1.1.0");
	expect(readFileSync(join(root, "usr/local/bin/dockermanager-controller"), "utf8")).toBe("controller v1.1.0\n");
	expect(readFileSync(join(root, "etc/dockermanager/controller.env"), "utf8")).toBe(before);
	expect((await run(join(work, "root-d"), { DOMAIN: "https://a.example.com", VERSION: "v1.0.0" })).out).toContain("DockerManager v1.0.0 is running");
});

test("a download that does not match its checksum changes nothing", async () => {
	const root = join(work, "root-a");
	tamper = true;
	const r = await run(root);
	tamper = false;
	expect(r.code).not.toBe(0);
	expect(r.err).toContain("does not match its checksum");
	expect(readFileSync(join(root, "usr/local/bin/dockermanager-controller"), "utf8")).toBe("controller v1.1.0\n");
});

test("uninstall removes the program and keeps the settings", async () => {
	const root = join(work, "root-a");
	const r = await run(root, {}, ["--uninstall"]);
	expect(r.code).toBe(0);
	expect(existsSync(join(root, "usr/local/bin/dockermanager-controller"))).toBe(false);
	expect(existsSync(join(root, "opt/dockermanager"))).toBe(false);
	expect(existsSync(join(root, "etc/dockermanager/controller.env"))).toBe(true);
});
