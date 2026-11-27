import { expect, test } from "bun:test";
import { keepSet } from "../src/controller/backups.ts";
import { describeDestination, formValues, parseDestination } from "../src/controller/lib/destinations.ts";
import { checkSchedule, nextRun } from "../src/controller/lib/schedule.ts";

test("retention keeps the newest, then one per day, week and month", () => {
	const at = (iso: string, id: number) => ({ id, startedAt: iso });
	const list = [
		at("2026-11-27T03:00:00Z", 10),
		at("2026-11-27T01:00:00Z", 9),
		at("2026-11-26T03:00:00Z", 8),
		at("2026-11-25T03:00:00Z", 7),
		at("2026-11-18T03:00:00Z", 6),
		at("2026-11-11T03:00:00Z", 5),
		at("2026-10-15T03:00:00Z", 4),
		at("2026-09-15T03:00:00Z", 3),
	];
	expect([...keepSet(list, { daily: 2, weekly: 0, monthly: 0 })].sort((a, b) => a - b)).toEqual([8, 10]);
	expect([...keepSet(list, { daily: 1, weekly: 3, monthly: 0 })].sort((a, b) => a - b)).toEqual([5, 6, 10]);
	expect([...keepSet(list, { daily: 0, weekly: 0, monthly: 3 })].sort((a, b) => a - b)).toEqual([3, 4, 10]);
	expect([...keepSet(list, { daily: 0, weekly: 0, monthly: 0 })]).toEqual([10]);
	expect(keepSet([], { daily: 7, weekly: 4, monthly: 6 }).size).toBe(0);
});

test("schedules use Bun's cron parser", () => {
	expect(checkSchedule(" 0  3 * * * ")).toEqual({ ok: true, value: "0 3 * * *" });
	expect(checkSchedule("@daily").ok).toBe(true);
	expect(checkSchedule("30 2 * * SUN").ok).toBe(true);
	const bad = checkSchedule("every day");
	expect(bad.ok).toBe(false);
	expect(checkSchedule("0 0 30 2 *")).toEqual({ ok: false, error: "This schedule never runs." });
	const next = nextRun("0 3 * * *", new Date(2026, 10, 27, 10, 0))!;
	expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([28, 3, 0]);
});

function form(values: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(values)) f.set(k, v);
	return f;
}

test("destination forms are checked per kind and keep stored secrets", () => {
	const s3 = parseDestination(
		form({
			name: "Offsite",
			kind: "s3",
			endpoint: "https://s3.eu.example.com/",
			region: "",
			bucket: "my-backups",
			prefix: "/servers/",
			access_key: "AK",
			secret_key: "SK",
		}),
		null,
	);
	expect(s3.config).toEqual({
		kind: "s3",
		endpoint: "https://s3.eu.example.com",
		region: "auto",
		bucket: "my-backups",
		prefix: "servers",
		accessKeyId: "AK",
		secretAccessKey: "SK",
	});
	const kept = parseDestination(form({ name: "Offsite", kind: "s3", endpoint: "", bucket: "my-backups", access_key: "AK2", secret_key: "" }), s3.config!);
	expect(kept.config).toMatchObject({ accessKeyId: "AK2", secretAccessKey: "SK" });
	expect(parseDestination(form({ name: "x", kind: "s3", bucket: "bkt", access_key: "a", secret_key: "" }), null).error).toContain("secret key");
	expect(parseDestination(form({ name: "x", kind: "local", path: "relative" }), null).error).toContain("absolute");
	expect(parseDestination(form({ name: "x", kind: "local", path: "/mnt/../etc" }), null).error).toContain("absolute");
	expect(parseDestination(form({ name: "x", kind: "smb", share: "nas/share", smb_user: "u", smb_password: "p" }), null).error).toContain("//server/share");
	expect(parseDestination(form({ name: "x", kind: "nfs", export: "nas:/vol", options: "rw;reboot" }), null).error).toContain("not allowed");
	const smb = parseDestination(
		form({ name: "NAS", kind: "smb", share: "//nas.lan/backup", smb_user: "u", smb_password: "p", subfolder: "/hosts/" }),
		null,
	).config!;
	expect(smb).toMatchObject({ kind: "smb", path: "hosts" });
	expect(formValues(smb, "NAS")).not.toHaveProperty("smb_password");
	expect(describeDestination(s3.config!)).toBe("my-backups/servers at s3.eu.example.com");
});
