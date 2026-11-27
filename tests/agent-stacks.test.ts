import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCompose } from "./fake-compose.ts";
import { findCompose, readProjectFiles, removeStackFolder, stackDirectory, StackService, validateStack, writeStackFiles } from "../src/agent/stacks.ts";

const root = mkdtempSync(join(tmpdir(), "dm-stacks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("stack folders must be plain absolute paths", () => {
	expect(stackDirectory("/opt/s", "shop", null)).toBe("/opt/s/shop");
	expect(stackDirectory("/opt/s", "shop", "/srv/shop/")).toBe("/srv/shop");
	expect(() => stackDirectory("/opt/s", "../x", null)).toThrow();
	expect(() => stackDirectory("/opt/s", "shop", "relative/dir")).toThrow();
	expect(() => stackDirectory("/opt/s", "shop", "/srv/../etc")).toThrow();
	expect(() => stackDirectory("/opt/s", "shop", "/")).toThrow();
});

test("files are written with private modes, .env only when needed", async () => {
	const dir = join(root, "written");
	await writeStackFiles(dir, "compose.yaml", "services: {}\n", "");
	expect(existsSync(join(dir, ".env"))).toBe(false);
	await writeStackFiles(dir, "compose.yaml", "services: {}\n", "A=1\n");
	expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
	expect(statSync(join(dir, "compose.yaml")).mode & 0o777).toBe(0o640);
	await writeStackFiles(dir, "compose.yaml", "services: {}\n", "");
	expect(readFileSync(join(dir, ".env"), "utf8")).toBe("");
});

test("adoption reads one compose file and its .env from the project folder", async () => {
	const dir = join(root, "adopt");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "docker-compose.yml"), "services:\n  a:\n    image: x\n");
	writeFileSync(join(dir, ".env"), "TOKEN=1\n");
	const labels = { "com.docker.compose.project.working_dir": dir, "com.docker.compose.project.config_files": join(dir, "docker-compose.yml") };
	expect(await readProjectFiles(labels)).toEqual({ directory: dir, file: "docker-compose.yml", compose: "services:\n  a:\n    image: x\n", env: "TOKEN=1\n" });
	await expect(readProjectFiles({ ...labels, "com.docker.compose.project.config_files": `${dir}/a.yml,${dir}/b.yml` })).rejects.toThrow("2 compose files");
	await expect(readProjectFiles({ ...labels, "com.docker.compose.project.config_files": "/etc/other.yml" })).rejects.toThrow("not in the project folder");
});

test("only folders inside the stacks folder are deleted", async () => {
	const stacksDir = join(root, "managed");
	mkdirSync(join(stacksDir, "shop"), { recursive: true });
	const outside = join(root, "outside");
	mkdirSync(outside, { recursive: true });
	expect(await removeStackFolder(stacksDir, outside)).toBe(false);
	expect(existsSync(outside)).toBe(true);
	expect(await removeStackFolder(stacksDir, join(stacksDir, "shop"))).toBe(true);
	expect(existsSync(join(stacksDir, "shop"))).toBe(false);
});

describe("running compose", () => {
	const script = fakeCompose(root);
	const service = new StackService(
		"/tmp/none.sock",
		join(root, "stacks"),
		async () => null,
		async () => ({ command: ["sh", script], label: "docker compose" }),
	);
	const files = { name: "shop", directory: null, file: "compose.yaml", compose: "services:\n  web:\n    image: nginx\n", env: "A=1\n" };

	test("a deploy writes the files and runs config, then up", async () => {
		let output = "";
		const prepared = await service.prepare({ ...files, action: "deploy" });
		expect(prepared.dir).toBe(join(root, "stacks", "shop"));
		await service.run({ ...files, action: "deploy" }, prepared, (t) => (output += t));
		expect(readFileSync(join(root, "stacks", "shop", "compose.yaml"), "utf8")).toBe(files.compose);
		expect(output).toContain("$ docker compose config --quiet");
		expect(output).toContain(`compose --project-name shop --project-directory ${join(root, "stacks", "shop")}`);
		expect(output).toContain("up --detach --remove-orphans");
	});

	test("a failing step stops the run with its exit code", async () => {
		const broken = { ...files, name: "broken" };
		const prepared = await service.prepare({ ...broken, action: "deploy" });
		let output = "";
		await expect(service.run({ ...broken, action: "deploy" }, prepared, (t) => (output += t))).rejects.toThrow("docker compose config exited with code 1");
		expect(output).toContain("service web failed to start");
		expect(output).not.toContain("up --detach");
	});

	test("transfer preparation creates stopped containers and refuses an existing folder", async () => {
		const target = { ...files, name: "transfer" };
		const prepared = await service.prepare({ ...target, action: "prepare" });
		let output = "";
		await service.run({ ...target, action: "prepare" }, prepared, (text) => (output += text));
		expect(output).toContain("create --no-build");
		expect(output).not.toContain("up --detach");
		await expect(service.prepare({ ...target, action: "prepare" })).rejects.toThrow("already has files");
	});

	test("other actions need files on the host first", async () => {
		await expect(service.prepare({ ...files, name: "never", action: "stop" })).rejects.toThrow("Deploy it first");
	});

	test("no compose tool gives a clear error", async () => {
		const none = new StackService(
			"/tmp/none.sock",
			root,
			async () => null,
			async () => null,
		);
		await expect(none.prepare({ ...files, action: "deploy" })).rejects.toThrow("Docker Compose is not installed");
	});
});

const realCompose = await findCompose("/tmp/dm-no-such.sock");
describe.skipIf(realCompose === null)("validation with the real docker compose", () => {
	test("good files pass and bad ones come back with the reason", async () => {
		const good = await validateStack(realCompose!, "/tmp/dm-no-such.sock", join(root, "v"), {
			name: "check",
			directory: null,
			file: "compose.yaml",
			compose: "services:\n  web:\n    image: nginx:${TAG}\n",
			env: "TAG=1.27\n",
		});
		expect(good).toEqual({ ok: true, output: "" });
		const bad = await validateStack(realCompose!, "/tmp/dm-no-such.sock", join(root, "v"), {
			name: "check",
			directory: null,
			file: "compose.yaml",
			compose: "services:\n  web:\n    imag: nginx\n",
			env: "",
		});
		expect(bad.ok).toBe(false);
		expect(bad.output.length).toBeGreaterThan(0);
	}, 30_000);
});

test("adoption only reads files of the project asked for", async () => {
	const service = new StackService("/tmp/none.sock", root, async () => ({
		"com.docker.compose.project": "other",
		"com.docker.compose.project.working_dir": "/srv/other",
		"com.docker.compose.project.config_files": "/srv/other/compose.yaml",
	}));
	await expect(service.read("proxy")).rejects.toThrow("No container of this project");
	await expect(
		readProjectFiles({ "com.docker.compose.project.working_dir": "/srv/gone", "com.docker.compose.project.config_files": "/srv/gone/compose.yaml" }),
	).rejects.toThrow("/srv/gone/compose.yaml no longer exists on the host.");
});
