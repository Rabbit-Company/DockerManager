import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSmartctl, readStorage } from "../src/agent/storage.ts";

const root = mkdtempSync(join(tmpdir(), "dm-storage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const smart = JSON.stringify({
	model_name: "Example NVMe",
	serial_number: "SN123",
	user_capacity: { bytes: 1_000_000_000_000 },
	smart_status: { passed: true },
	nvme_smart_health_information_log: {
		critical_warning: 0,
		temperature: 42,
		available_spare: 98,
		available_spare_threshold: 10,
		percentage_used: 8,
		media_errors: { value: "0" },
		num_err_log_entries: { value: "2" },
		power_on_hours: { value: "1200" },
		data_units_written: { value: "2000000" },
	},
});

test("reads NVMe health and MD member status", async () => {
	mkdirSync(join(root, "class", "nvme", "nvme0"), { recursive: true });
	const md = join(root, "block", "md0");
	mkdirSync(join(md, "md"), { recursive: true });
	mkdirSync(join(md, "slaves", "nvme0n1p3"), { recursive: true });
	writeFileSync(join(md, "md", "level"), "raid1\n");
	writeFileSync(join(md, "md", "array_state"), "clean\n");
	writeFileSync(join(md, "md", "raid_disks"), "2\n");
	writeFileSync(join(md, "md", "degraded"), "1\n");
	writeFileSync(join(md, "md", "sync_action"), "idle\n");
	const report = await readStorage(root, async () => ({ stdout: smart, stderr: "", code: 8 }));
	expect(report.smartctl).toBe("ok");
	expect(report.drives[0]).toMatchObject({ device: "/dev/nvme0", serial: "SN123", usedPercent: 8, mediaErrors: 0, dataWrittenBytes: 1_024_000_000_000 });
	expect(report.arrays[0]).toMatchObject({ device: "/dev/md0", level: "raid1", raidDisks: 2, degraded: 1, members: ["nvme0n1p3"] });
});

test("reports missing smartctl without treating the drive as healthy", async () => {
	const report = await readStorage(root, async () => {
		throw Object.assign(new Error("not found"), { code: "ENOENT" });
	});
	expect(report.smartctl).toBe("missing");
	expect(report.drives[0]).toMatchObject({ passed: null, error: "Install smartmontools on this host." });
});

test("rejects a SMART result without NVMe health data", () => {
	expect(() => parseSmartctl("/dev/nvme0", "{}")).toThrow("NVMe health data");
	expect(() => parseSmartctl("/dev/nvme0", JSON.stringify({ nvme_smart_health_information_log: { other: 1 } }))).toThrow("NVMe health data");
});
