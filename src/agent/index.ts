import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { APP_NAME, VERSION } from "../shared/version.ts";
import { Collector } from "./collector.ts";
import { backoff, AgentSession, type Logger } from "./connection.ts";
import { findSocket, RuntimeClient, socketCandidates } from "./docker.ts";
import { SampleBuffer } from "./metrics.ts";
import { Firewall, run as runCommand } from "./firewall.ts";
import { dirname, join } from "node:path";
import { defaultStacksDir, StackService } from "./stacks.ts";
import { enroll, readState, statePath, writeState } from "./state.ts";
import { StorageMonitor } from "./storage.ts";

const log: Logger = {
	info: (m) => console.log(`[agent] ${m}`),
	warn: (m) => console.warn(`[agent] ${m}`),
	error: (m) => console.error(`[agent] ${m}`),
};

const USAGE = `${APP_NAME} agent ${VERSION}

Usage:
  agent enroll --url <controller> --token <join token>   connect this host to a controller
  agent run                                              run the agent (the default)
  agent decrypt --key <recovery key> <file>              write a backup file decrypted to stdout, a gzip tar or dump
  agent version

Environment:
  AGENT_STATE        state file (default /etc/dockermanager/agent.json as root, ./data/agent.json otherwise)
  STACKS_DIR         where new stacks are written (default /opt/dockermanager/stacks as root, ./data/stacks otherwise)
  CONTAINER_SOCKET   Docker or Podman socket (default: first of ${socketCandidates().join(", ")})`;

async function runtimeClient(): Promise<RuntimeClient> {
	for (let attempt = 0; ; attempt++) {
		const socket = findSocket();
		if (socket) {
			const client = new RuntimeClient(socket);
			try {
				await client.connect();
				log.info(`Using ${client.runtime} at ${socket}`);
				return client;
			} catch (err) {
				log.warn(`${socket} did not answer: ${(err as Error).message}`);
			}
		} else if (attempt === 0) {
			log.warn(`No Docker or Podman socket found. Looked at ${socketCandidates().join(", ")}`);
		}
		await Bun.sleep(10_000);
	}
}

async function run(): Promise<void> {
	const state = readState();
	if (state === null) {
		log.error(`Not enrolled. Run "agent enroll --url <controller> --token <token>" first. State file: ${statePath()}`);
		process.exit(2);
	}
	const runtime = await runtimeClient();
	let session: AgentSession | null = null;
	let stopping = false;
	const buffer = new SampleBuffer();
	const collector = new Collector(
		runtime,
		(sample) => {
			if (!session?.offerSample(sample)) buffer.push(sample);
		},
		(disk) => session?.offerDisk(disk),
		log,
	);
	collector.start();
	const storage = new StorageMonitor((report) => session?.offerStorage(report), log.warn);
	storage.start();
	const stacks = new StackService(
		runtime.socket,
		defaultStacksDir(),
		(project) => runtime.projectLabels(project),
		undefined,
		(project) => runtime.projectStatus(project),
	);
	log.info(`Stacks are kept in ${stacks.stacksDir}`);
	const firewall = new Firewall(runCommand, join(dirname(statePath()), "firewall.json"));
	firewall.onEvent = (event, detail) => {
		log.warn(`Firewall: ${detail}`);
		session?.firewallEvent(event, detail);
	};
	await firewall.start().catch((err: Error) => log.error(`Restoring the firewall failed: ${err.message}`));
	setInterval(() => void firewall.ensure().catch(() => {}), 60_000);
	const stop = () => {
		stopping = true;
		collector.stop();
		storage.stop();
		session?.close();
		setTimeout(() => process.exit(0), 1000).unref();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	for (let attempt = 0; !stopping;) {
		const started = Date.now();
		session = new AgentSession(state, runtime, log, { buffer, lastDisk: () => collector.lastDisk }, stacks, firewall, undefined, () => storage.last);
		await session.run();
		if (stopping) break;
		attempt = Date.now() - started > 60_000 ? 0 : attempt + 1;
		const wait = backoff(attempt);
		log.info(`Disconnected, retrying in ${Math.round(wait / 1000)} s`);
		await Bun.sleep(wait);
	}
}

const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: { url: { type: "string" }, token: { type: "string" }, key: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const command = positionals[0] ?? "run";

if (values.help || command === "help") {
	console.log(USAGE);
} else if (command === "version") {
	console.log(VERSION);
} else if (command === "enroll") {
	if (!values.url || !values.token) {
		console.error(USAGE);
		process.exit(2);
	}
	const state = await enroll(values.url, values.token, hostname());
	writeState(state);
	log.info(`Enrolled as host ${state.hostId}. State saved to ${statePath()}`);
} else if (command === "decrypt") {
	const file = positionals[1];
	if (!values.key || !file) {
		console.error(USAGE);
		process.exit(2);
	}
	const { decryptStream } = await import("./backup/crypto.ts");
	try {
		await Bun.write(Bun.stdout, new Response(Bun.file(file).stream().pipeThrough(decryptStream(values.key))));
	} catch (err) {
		console.error(`[agent] ${(err as Error).message}`);
		process.exit(1);
	}
} else if (command === "run") {
	await run();
} else {
	console.error(USAGE);
	process.exit(2);
}
