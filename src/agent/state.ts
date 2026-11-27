import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentState {
	controller: string;
	hostId: number;
	secret: string;
}

export function statePath(env: Record<string, string | undefined> = process.env): string {
	if (env.AGENT_STATE) return env.AGENT_STATE;
	return process.getuid?.() === 0 ? "/etc/dockermanager/agent.json" : "./data/agent.json";
}

export function readState(path = statePath()): AgentState | null {
	if (!existsSync(path)) return null;
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentState>;
	if (typeof value.controller !== "string" || typeof value.hostId !== "number" || typeof value.secret !== "string") {
		throw new Error(`${path} is not a valid agent state file. Enroll the agent again.`);
	}
	return value as AgentState;
}

export function writeState(state: AgentState, path = statePath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(state, null, "\t") + "\n", { mode: 0o600 });
	chmodSync(path, 0o600);
}

export function normalizeController(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("The controller address must start with https:// or http://");
	return parsed.origin;
}

/** Trades a one time join token for the host id and a long lived secret. */
export async function enroll(controller: string, token: string, hostname: string, fetcher: typeof fetch = fetch): Promise<AgentState> {
	const origin = normalizeController(controller);
	const response = await fetcher(`${origin}/api/agent/enroll`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, hostname }),
	});
	const body = (await response.json().catch(() => ({}))) as { hostId?: number; secret?: string; message?: string };
	if (!response.ok || typeof body.hostId !== "number" || typeof body.secret !== "string") {
		throw new Error(body.message ?? `Enrollment failed with status ${response.status}.`);
	}
	return { controller: origin, hostId: body.hostId, secret: body.secret };
}
