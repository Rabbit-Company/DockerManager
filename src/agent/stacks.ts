import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";

import type { ContainerStatus } from "./docker.ts";

export type StackAction = "deploy" | "upgrade" | "prepare" | "start" | "stop" | "restart" | "down" | "pull";

export interface StackFiles {
	name: string;
	directory: string | null;
	file: string;
	compose: string;
	env: string;
}

export function defaultStacksDir(env: Record<string, string | undefined> = process.env): string {
	if (env.STACKS_DIR) return resolve(env.STACKS_DIR);
	return process.getuid?.() === 0 ? "/opt/dockermanager/stacks" : resolve("./data/stacks");
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FILE = /^[A-Za-z0-9._-]{1,128}\.ya?ml$/;

/** The folder of a stack. The controller may name one for adopted stacks, it must be absolute and plain. */
export function stackDirectory(stacksDir: string, name: string, directory: string | null): string {
	if (!NAME.test(name)) throw new Error("Bad stack name.");
	if (directory === null) return join(stacksDir, name);
	const trimmed = directory.length > 1 ? directory.replace(/\/+$/, "") : directory;
	if (!isAbsolute(trimmed) || normalize(trimmed) !== trimmed || trimmed.includes("\0")) throw new Error("The stack folder must be an absolute path.");
	if (trimmed === "/") throw new Error("The stack folder cannot be the root folder.");
	return trimmed;
}

export function checkFileName(file: string): string {
	if (!FILE.test(file)) throw new Error("The compose file name must end in .yml or .yaml.");
	return file;
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, content, { mode });
	await chmod(tmp, mode);
	await rename(tmp, path);
}

export async function writeStackFiles(dir: string, file: string, compose: string, env: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o750 });
	await writeAtomic(join(dir, file), compose, 0o640);
	const envPath = join(dir, ".env");
	if (env.length > 0 || existsSync(envPath)) await writeAtomic(envPath, env, 0o600);
}

export interface ComposeTool {
	command: string[];
	label: string;
}

/** Docker Compose v2 first, then Podman's wrapper, then the old standalone docker-compose. */
export async function findCompose(
	socket: string,
	run: (cmd: string[], env: Record<string, string>) => Promise<number> = quietRun,
): Promise<ComposeTool | null> {
	const env = { DOCKER_HOST: `unix://${socket}` };
	const candidates: ComposeTool[] = [
		{ command: ["docker", "compose"], label: "docker compose" },
		{ command: ["podman", "compose"], label: "podman compose" },
		{ command: ["docker-compose"], label: "docker-compose" },
	];
	for (const tool of candidates) {
		try {
			if ((await run([...tool.command, "version"], env)) === 0) return tool;
		} catch {}
	}
	return null;
}

async function quietRun(cmd: string[], env: Record<string, string>): Promise<number> {
	const proc = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
	return proc.exited;
}

/** Runs a command and hands every chunk of stdout and stderr to onOutput, in the order they arrive. */
export async function runStreaming(
	cmd: string[],
	options: { cwd: string; env: Record<string, string>; onOutput: (text: string) => void; signal?: AbortSignal; timeoutMs?: number },
): Promise<number> {
	const proc = Bun.spawn(cmd, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 30 * 60_000);
	options.signal?.addEventListener("abort", () => proc.kill());
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) options.onOutput(decoder.decode(chunk, { stream: true }));
	};
	await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
	const code = await proc.exited;
	clearTimeout(timer);
	return code;
}

export function composeArgs(tool: ComposeTool, name: string, dir: string, file: string, envFile: string | null): string[] {
	const args = [...tool.command, "--project-name", name, "--project-directory", dir, "--file", join(dir, file)];
	if (envFile && existsSync(envFile)) args.push("--env-file", envFile);
	return args;
}

export const ACTION_ARGS: Record<StackAction, string[][]> = {
	deploy: [
		["config", "--quiet"],
		["up", "--detach", "--remove-orphans"],
	],
	upgrade: [["config", "--quiet"], ["pull"], ["up", "--detach", "--remove-orphans"]],
	prepare: [
		["config", "--quiet"],
		["create", "--no-build"],
	],
	start: [["start"]],
	stop: [["stop"]],
	restart: [["restart"]],
	down: [["down", "--remove-orphans"]],
	pull: [["pull"]],
};

/** Checks files with `compose config` in a scratch folder, so nothing on the host changes. */
export async function validateStack(tool: ComposeTool, socket: string, stacksDir: string, files: StackFiles): Promise<{ ok: boolean; output: string }> {
	const scratch = await mkdtemp(join(tmpdir(), "dm-check-"));
	try {
		const target = stackDirectory(stacksDir, files.name, files.directory);
		const file = checkFileName(files.file);
		await writeFile(join(scratch, file), files.compose, { mode: 0o600 });
		await writeFile(join(scratch, ".env"), files.env, { mode: 0o600 });
		const projectDir = existsSync(target) ? target : scratch;
		let output = "";
		const cmd = [
			...tool.command,
			"--project-name",
			files.name,
			"--project-directory",
			projectDir,
			"--file",
			join(scratch, file),
			"--env-file",
			join(scratch, ".env"),
			"config",
			"--quiet",
		];
		const code = await runStreaming(cmd, { cwd: scratch, env: { DOCKER_HOST: `unix://${socket}` }, onOutput: (t) => (output += t), timeoutMs: 60_000 });
		return { ok: code === 0, output: output.trim() };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Reads the files of a project that already runs, found through the labels compose puts on its containers. */
export async function readProjectFiles(labels: Record<string, string>): Promise<{ directory: string; file: string; compose: string; env: string }> {
	const configFiles = (labels["com.docker.compose.project.config_files"] ?? "").split(",").filter((f) => f.length > 0);
	const workingDir = labels["com.docker.compose.project.working_dir"];
	if (!workingDir || configFiles.length === 0)
		throw new Error("This project does not say where its compose file is. Create a stack with the same name instead.");
	if (configFiles.length > 1) throw new Error(`This project uses ${configFiles.length} compose files. Only projects with one compose file can be adopted.`);
	const path = configFiles[0]!;
	if (dirname(path) !== workingDir.replace(/\/+$/, "")) throw new Error("The compose file is not in the project folder, so it cannot be adopted.");
	const read = async (file: string) => {
		try {
			return await readFile(file, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			throw new Error(
				code === "ENOENT" ? `${file} no longer exists on the host.` : code === "EACCES" ? `The agent may not read ${file}.` : `${file} could not be read.`,
			);
		}
	};
	const compose = await read(path);
	const envPath = join(workingDir, ".env");
	const env = existsSync(envPath) ? await read(envPath) : "";
	return { directory: workingDir.replace(/\/+$/, ""), file: basename(path), compose, env };
}

/** Deletes a stack folder, but only one the agent created under its own stacks folder. */
export async function removeStackFolder(stacksDir: string, directory: string): Promise<boolean> {
	const dir = normalize(directory);
	if (dirname(dir) !== normalize(stacksDir)) return false;
	await rm(dir, { recursive: true, force: true });
	return true;
}

export interface RunParams extends StackFiles {
	action: StackAction;
	/** Seconds to wait after up for every container to run and pass its healthcheck. */
	healthTimeout?: number;
}

export type StatusReader = (project: string) => Promise<ContainerStatus[]>;

export function completedServices(compose: string): Set<string> {
	const result = new Set<string>();
	const doc = parseDocument(compose);
	if (doc.errors.length > 0) return result;
	const services = doc.get("services", true);
	if (!isMap(services)) return result;
	for (const service of services.items) {
		if (!isMap(service.value)) continue;
		const dependencies = service.value.get("depends_on", true);
		if (!isMap(dependencies)) continue;
		for (const dependency of dependencies.items) {
			if (!isScalar(dependency.key) || !isMap(dependency.value)) continue;
			const condition = dependency.value.get("condition", true);
			if (isScalar(condition) && condition.value === "service_completed_successfully") result.add(String(dependency.key.value));
		}
	}
	return result;
}

function describe(s: ContainerStatus): string {
	if (s.health) return `${s.name} ${s.state}, ${s.health}`;
	if (s.state === "exited") return `${s.name} exited with code ${s.exitCode ?? "unknown"}`;
	return `${s.name} ${s.state}`;
}

/**
 * Waits until every container of the project runs, with a passing healthcheck
 * where it has one. Fails early when a container is unhealthy, restarts or
 * exits with an error. One shot containers that exit with 0 count as done.
 */
export async function waitHealthy(
	read: StatusReader,
	project: string,
	timeoutMs: number,
	onOutput: (text: string) => void,
	pollMs = 2000,
	allowedCompleted: ReadonlySet<string> = new Set(),
): Promise<void> {
	const started = Date.now();
	const baseline = new Map((await read(project)).map((s) => [s.name, s.restarts]));
	let last = "";
	onOutput(`Waiting up to ${Math.round(timeoutMs / 1000)} s for the containers to run and pass their healthchecks\n`);
	for (;;) {
		const statuses = await read(project);
		if (statuses.length === 0) throw new Error("No containers of this stack are running.");
		const restarted = (s: ContainerStatus) => s.restarts > (baseline.get(s.name) ?? s.restarts);
		const failed = statuses.find(
			(s) =>
				s.health === "unhealthy" ||
				s.state === "dead" ||
				s.state === "restarting" ||
				(s.state === "exited" && (s.exitCode !== 0 || !s.service || !allowedCompleted.has(s.service))) ||
				restarted(s),
		);
		if (failed) throw new Error(`${describe(failed)}${restarted(failed) ? ", restarted" : ""}`);
		const pending = statuses.filter((s) => s.health === "starting" || (s.state !== "running" && s.state !== "exited"));
		const line = statuses.map(describe).join("; ");
		if (line !== last) {
			onOutput(`  ${line}\n`);
			last = line;
		}
		if (pending.length === 0) {
			onOutput("All containers are up.\n");
			return;
		}
		if (Date.now() - started > timeoutMs) throw new Error(`Still waiting after ${Math.round(timeoutMs / 1000)} s: ${pending.map(describe).join("; ")}`);
		await Bun.sleep(pollMs);
	}
}

/** Holds the compose tool and the stacks folder for one agent, and lets one run per stack happen at a time. */
export class StackService {
	private tool: Promise<ComposeTool | null> | null = null;
	private readonly busy = new Set<string>();

	constructor(
		readonly socket: string,
		readonly stacksDir: string,
		private readonly projectLabels: (project: string) => Promise<Record<string, string> | null>,
		private readonly detect: (socket: string) => Promise<ComposeTool | null> = findCompose,
		private readonly status: StatusReader | null = null,
	) {}

	async compose(): Promise<ComposeTool> {
		this.tool ??= this.detect(this.socket);
		const tool = await this.tool;
		if (!tool) {
			this.tool = null;
			throw new Error("Docker Compose is not installed on this host. Install the docker-compose-plugin package, or podman-compose for Podman.");
		}
		return tool;
	}

	async validate(files: StackFiles): Promise<{ ok: boolean; output: string }> {
		return validateStack(await this.compose(), this.socket, this.stacksDir, files);
	}

	/** Checks everything that can fail before any output, so the caller gets a plain error instead of a failed run. */
	async prepare(params: RunParams): Promise<{ tool: ComposeTool; dir: string; file: string }> {
		const tool = await this.compose();
		const dir = stackDirectory(this.stacksDir, params.name, params.directory);
		const file = checkFileName(params.file);
		if (!ACTION_ARGS[params.action]) throw new Error("Unknown stack action.");
		if (params.action === "prepare" && (existsSync(dir) || (await this.projectLabels(params.name))))
			throw new Error("A stack with this name already has files or containers on this host.");
		if (params.action !== "deploy" && params.action !== "upgrade" && params.action !== "prepare" && !existsSync(join(dir, file)))
			throw new Error("This stack has no files on the host yet. Deploy it first.");
		if (this.busy.has(params.name)) throw new Error("This stack is already being changed. Wait for that to finish.");
		return { tool, dir, file };
	}

	async run(params: RunParams, prepared: { tool: ComposeTool; dir: string; file: string }, onOutput: (text: string) => void): Promise<void> {
		const { tool, dir, file } = prepared;
		this.busy.add(params.name);
		try {
			if (params.action === "deploy" || params.action === "upgrade" || params.action === "prepare") {
				await writeStackFiles(dir, file, params.compose, params.env);
				onOutput(`Wrote ${join(dir, file)}${params.env.length > 0 ? " and .env" : ""}\n`);
			}
			for (const args of ACTION_ARGS[params.action]) {
				const cmd = [...composeArgs(tool, params.name, dir, file, join(dir, ".env")), ...args];
				onOutput(`$ ${tool.label} ${args.join(" ")}\n`);
				const code = await runStreaming(cmd, { cwd: dir, env: { DOCKER_HOST: `unix://${this.socket}` }, onOutput });
				if (code !== 0) throw new Error(`${tool.label} ${args[0]} exited with code ${code}`);
			}
			if ((params.action === "deploy" || params.action === "upgrade") && this.status) {
				const seconds = Math.max(5, Math.min(1800, Math.floor(params.healthTimeout ?? 120)));
				await waitHealthy(this.status, params.name, seconds * 1000, onOutput, 2000, completedServices(params.compose));
			}
		} finally {
			this.busy.delete(params.name);
		}
	}

	async read(project: string): Promise<{ directory: string; file: string; compose: string; env: string }> {
		if (!NAME.test(project)) throw new Error("Bad project name.");
		const labels = await this.projectLabels(project);
		if (!labels || labels["com.docker.compose.project"] !== project) throw new Error("No container of this project was found on the host.");
		return readProjectFiles(labels);
	}

	async remove(directory: string | null, name: string): Promise<{ removed: boolean }> {
		const dir = stackDirectory(this.stacksDir, name, directory);
		return { removed: await removeStackFolder(this.stacksDir, dir) };
	}
}
