import { audit } from "./db/audit.ts";
import { createDeploy, finishDeploy, getVersion, setDeployed, setDirectory, type DeployAction, type Stack } from "./db/stacks.ts";
import type { Hub } from "./hub.ts";
import { LiveJobs } from "./jobs.ts";
import { ApiError } from "./lib/errors.ts";

/**
 * Runs compose actions on hosts and records them. Output is kept in memory
 * while a run lasts and published to `deploy:{id}`, then saved with the result.
 * Backups and restores of a stack use the same lock, so they never overlap.
 */
export class Deployments {
	private readonly jobs: LiveJobs;
	private readonly byStack = new Map<number, string>();
	/** Called after every run, for alerts. */
	onFinished: ((run: { stack: Stack; action: DeployAction; ok: boolean; error: string | null; deployId: number }) => void) | null = null;

	constructor(
		private readonly hub: Hub,
		private readonly healthTimeout = 120,
	) {
		this.jobs = new LiveJobs((topic, data) => hub.publish(topic, data));
	}

	/** The running deploy of a stack, or null. A backup or restore holds the lock without a deploy id. */
	runningFor(stackId: number): number | null {
		const key = this.byStack.get(stackId);
		return key?.startsWith("deploy:") ? Number(key.slice(7)) : null;
	}

	busy(stackId: number): string | null {
		return this.byStack.get(stackId) ?? null;
	}

	/** Takes the stack for a job, or says what already holds it. */
	lock(stackId: number, key: string): void {
		const holder = this.byStack.get(stackId);
		if (holder)
			throw new ApiError(
				409,
				"busy",
				holder.startsWith("deploy:")
					? "This stack is already being changed. Wait for that to finish."
					: "A backup or restore of this stack is running. Wait for it to finish.",
			);
		this.byStack.set(stackId, key);
	}

	unlock(stackId: number, key: string): void {
		if (this.byStack.get(stackId) === key) this.byStack.delete(stackId);
	}

	live(deployId: number): { output: string; total: number } | null {
		return this.jobs.live(`deploy:${deployId}`);
	}

	/** Resolves with true when the run succeeded. For tests and for removals that must wait. */
	wait(deployId: number): Promise<boolean> {
		return this.jobs.wait(`deploy:${deployId}`);
	}

	async start(stack: Stack, action: DeployAction, user: { id: number | null; ip: string | null }, options: { healthTimeout?: number } = {}): Promise<number> {
		if (stack.movedTo !== null && action !== "stop" && action !== "down" && action !== "pull")
			throw new ApiError(
				409,
				"moved",
				"This stack was transferred to another host, so this copy stays stopped. Remove it here when the old data is no longer needed.",
			);
		const holder = this.byStack.get(stack.id);
		if (holder) this.lock(stack.id, holder);
		const writes = action === "deploy" || action === "upgrade";
		const version = writes ? await getVersion(stack.id, stack.currentVersion) : null;
		if (writes && !version) throw new ApiError(404, "not_found", "This stack has no saved version.");
		const deployId = await createDeploy(stack.id, version?.number ?? null, action, user.id);
		const key = `deploy:${deployId}`;
		this.lock(stack.id, key);
		const job = this.jobs.begin(key);
		let ended = false;

		const end = async (error: string | null) => {
			if (ended) return;
			ended = true;
			if (error) job.append(`\n${error}\n`);
			const ok = error === null;
			this.unlock(stack.id, key);
			await finishDeploy(deployId, ok ? "ok" : "failed", job.output());
			if (ok && writes && version) await setDeployed(stack.id, version.number);
			await audit({
				userId: user.id,
				hostId: stack.hostId,
				action: `stack.${action}`,
				target: version ? `${stack.name} v${version.number}` : stack.name,
				ok,
				detail: error,
				ip: user.ip,
			});
			this.hub.publish(`host:${stack.hostId}`, JSON.stringify({ type: "changed", topic: `host:${stack.hostId}` }));
			job.finish(ok);
			this.onFinished?.({ stack, action, ok, error, deployId });
		};

		try {
			const result = await this.hub.runStack(
				stack.hostId,
				{
					name: stack.name,
					directory: stack.directory,
					file: stack.file,
					compose: version?.compose ?? "",
					env: version?.env ?? "",
					action,
					healthTimeout: options.healthTimeout ?? this.healthTimeout,
				},
				{ data: job.append, end: (error) => void end(error) },
			);
			await setDirectory(stack.id, result.directory);
		} catch (err) {
			await end((err as Error).message);
		}
		return deployId;
	}
}
