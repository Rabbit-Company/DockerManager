import { outputTime } from "../shared/output-time.ts";

const MAX_OUTPUT = 512 * 1024;
const CUT_NOTE = "[earlier output was cut]\n";

interface Job {
	output: string;
	/** Characters received so far, including any that were cut, so browsers can tell where a chunk belongs. */
	total: number;
	done: Promise<boolean>;
	resolve(ok: boolean): void;
	lineStart: boolean;
}

export interface JobHandle {
	append(text: string): void;
	output(): string;
	finish(ok: boolean): void;
}

/**
 * Output of running jobs, kept in memory and published to the job's topic,
 * such as `deploy:12` or `backup:3`. Browsers on the job's page append it live.
 */
export class LiveJobs {
	private readonly jobs = new Map<string, Job>();

	constructor(private readonly publish: (topic: string, data: string) => void) {}

	begin(key: string): JobHandle {
		let resolve: (ok: boolean) => void = () => {};
		const job: Job = { output: "", total: 0, done: new Promise((r) => (resolve = r)), resolve: (ok) => resolve(ok), lineStart: true };
		this.jobs.set(key, job);
		return {
			append: (text) => {
				if (text.length === 0) return;
				const prefix = `${outputTime(new Date())} `;
				let stamped = "";
				for (const part of text.split(/(\n|\r)/)) {
					if (part === "\n" || part === "\r") {
						stamped += part;
						job.lineStart = true;
					} else if (part.length > 0) {
						if (job.lineStart) stamped += prefix;
						stamped += part;
						job.lineStart = false;
					}
				}
				this.publish(key, JSON.stringify({ type: "job.output", job: key, offset: job.total, data: stamped }));
				job.total += stamped.length;
				job.output += stamped;
				if (job.output.length > MAX_OUTPUT) job.output = CUT_NOTE + job.output.slice(job.output.length - MAX_OUTPUT + CUT_NOTE.length);
			},
			output: () => job.output,
			finish: (ok) => {
				if (!this.jobs.has(key)) return;
				this.jobs.delete(key);
				this.publish(key, JSON.stringify({ type: "job.end", job: key, ok }));
				this.publish(key, JSON.stringify({ type: "changed", topic: key }));
				job.resolve(ok);
			},
		};
	}

	live(key: string): { output: string; total: number } | null {
		const job = this.jobs.get(key);
		return job ? { output: job.output, total: job.total } : null;
	}

	running(key: string): boolean {
		return this.jobs.has(key);
	}

	wait(key: string): Promise<boolean> {
		return this.jobs.get(key)?.done ?? Promise.resolve(true);
	}
}
