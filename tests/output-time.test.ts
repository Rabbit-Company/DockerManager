import { expect, test } from "bun:test";
import { LiveJobs } from "../src/controller/jobs.ts";
import { outputTime } from "../src/shared/output-time.ts";
import { dockerTime, LogTimeFormatter } from "../src/web/log-time.ts";

const at = new Date("2026-11-16T13:43:20.534Z");

test("times read 2026-11-16 14:43:20 in the chosen time zone", () => {
	expect(outputTime(at, { timeZone: "Europe/Ljubljana" })).toBe("2026-11-16 14:43:20");
	expect(outputTime(at, { timeZone: "UTC" })).toBe("2026-11-16 13:43:20");
	expect(outputTime(new Date("2026-01-02T00:00:05.007Z"), { timeZone: "UTC" })).toBe("2026-01-02 00:00:05");
	expect(outputTime(at, { timeZone: "Not/AZone" })).toMatch(/^2026-11-16 \d{2}:43:20$/);
});

test("Docker log times with nanoseconds become local times to the second", () => {
	expect(dockerTime("2026-11-16T13:43:20.534123456Z GET / 200")).toEqual({ date: at, rest: "GET / 200" });
	expect(dockerTime("2026-11-16T13:43:20Z started")!.date.toISOString()).toBe("2026-11-16T13:43:20.000Z");
	expect(dockerTime("no time here")).toBeNull();
	const f = new LogTimeFormatter("Europe/Ljubljana");
	expect(f.push("2026-11-16T13:43:20.534123456Z first\n2026-11-16T13:43:21.0")).toBe("2026-11-16 14:43:20 first\n");
	expect(f.push("01Z second line\n")).toBe("2026-11-16 14:43:21 second line\n");
	expect(f.push("2026-11-16T13:43:22.5Z no newline yet")).toBe("");
	expect(f.flush()).toBe("2026-11-16 14:43:22 no newline yet");
});

test("job output gets a time at the start of every line", () => {
	const messages: { offset: number; data: string }[] = [];
	const jobs = new LiveJobs((_topic, message) => {
		const parsed = JSON.parse(message);
		if (parsed.type === "job.output") messages.push(parsed);
	});
	const job = jobs.begin("deploy:1");
	job.append("Pulling web\nPulled");
	job.append(" web\n");
	const lines = job.output().split("\n");
	expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Pulling web$/);
	expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Pulled web$/);
	expect(messages[1]?.offset).toBe(messages[0]!.data.length);
	expect(messages.map((message) => message.data).join("")).toBe(job.output());
	job.finish(true);
});
