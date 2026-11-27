export type JobMessage = { type: "job.output"; job: string; offset: number; data: string } | { type: "job.end"; job: string; ok: boolean };

const MAX_CHARS = 600_000;

/**
 * Keeps the output of a deploy, backup or restore current. A chunk that does
 * not follow the text shown means one was missed, so the whole output is
 * fetched again.
 */
export function jobOutput(): { message(m: JobMessage): void; opened(): void } | null {
	const pre = document.querySelector<HTMLElement>("[data-job-output]");
	if (!pre) return null;
	const key = pre.dataset.job ?? "";
	let total = Number(pre.dataset.total) || 0;
	let running = pre.dataset.running === "1";
	let fresh = pre.dataset.empty === "1";

	const stickToEnd = () => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
	const append = (text: string) => {
		const follow = stickToEnd();
		if (fresh) {
			pre.textContent = "";
			fresh = false;
		}
		pre.append(text);
		if ((pre.textContent?.length ?? 0) > MAX_CHARS) pre.textContent = pre.textContent!.slice(-MAX_CHARS);
		if (follow) pre.scrollTop = pre.scrollHeight;
	};

	const resync = async () => {
		const response = await fetch(`${location.pathname.replace(/\/$/, "")}/output.json`, { credentials: "same-origin" });
		if (!response.ok) return;
		const body = (await response.json()) as { output: string; total: number; running: boolean };
		pre.textContent = body.output || (body.running ? "Waiting for output..." : "No output.");
		fresh = body.output.length === 0;
		total = body.total;
		running = body.running;
		pre.scrollTop = pre.scrollHeight;
	};

	pre.scrollTop = pre.scrollHeight;
	return {
		opened() {
			if (running) void resync();
		},
		message(m) {
			if (m.job !== key) return;
			if (m.type === "job.end") {
				running = false;
				return;
			}
			if (m.offset + m.data.length <= total) return;
			if (m.offset > total) {
				void resync();
				return;
			}
			append(m.data.slice(total - m.offset));
			total = m.offset + m.data.length;
		},
	};
}
