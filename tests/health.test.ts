import { expect, test } from "bun:test";
import type { ContainerStatus } from "../src/agent/docker.ts";
import { completedServices, waitHealthy } from "../src/agent/stacks.ts";

const c = (name: string, over: Partial<ContainerStatus> = {}): ContainerStatus => ({
	name,
	service: name,
	state: "running",
	health: null,
	exitCode: 0,
	restarts: 0,
	...over,
});

function scripted(rounds: ContainerStatus[][]) {
	let i = 0;
	return async () => rounds[Math.min(i++, rounds.length - 1)]!;
}

test("waits for healthchecks to pass", async () => {
	let out = "";
	const compose =
		"services:\n  web:\n    image: nginx\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n  migrate:\n    image: job\n";
	const read = scripted([
		[c("db", { health: "starting" })],
		[c("db", { health: "starting" })],
		[c("db", { health: "healthy" }), c("migrate", { state: "exited", exitCode: 0 })],
	]);
	await waitHealthy(read, "app", 5000, (t) => (out += t), 1, completedServices(compose));
	expect(out).toContain("db running, healthy");
	expect(out).toContain("All containers are up.");
});

test("fails at once on unhealthy, crashed or restarting containers", async () => {
	await expect(waitHealthy(scripted([[c("web")], [c("web", { health: "unhealthy" })]]), "app", 5000, () => {}, 1)).rejects.toThrow("web running, unhealthy");
	await expect(waitHealthy(scripted([[c("web")], [c("web", { state: "exited", exitCode: 1 })]]), "app", 5000, () => {}, 1)).rejects.toThrow(
		"web exited with code 1",
	);
	await expect(waitHealthy(scripted([[c("web")], [c("web", { state: "exited", exitCode: 0 })]]), "app", 5000, () => {}, 1)).rejects.toThrow(
		"web exited with code 0",
	);
	await expect(waitHealthy(scripted([[c("web")], [c("web", { restarts: 1 })]]), "app", 5000, () => {}, 1)).rejects.toThrow("restarted");
	await expect(waitHealthy(scripted([[]]), "app", 5000, () => {}, 1)).rejects.toThrow("No containers");
});

test("gives up after the timeout", async () => {
	await expect(waitHealthy(scripted([[c("db", { health: "starting" })]]), "app", 20, () => {}, 5)).rejects.toThrow(
		"Still waiting after 0 s: db running, starting",
	);
});
