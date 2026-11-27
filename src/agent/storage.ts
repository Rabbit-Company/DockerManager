import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MdArray, NvmeDrive, StorageReport } from "../shared/protocol.ts";

type SmartResult = { stdout: string; stderr: string; code: number };
export type SmartRunner = (device: string) => Promise<SmartResult>;

export async function runSmartctl(device: string): Promise<SmartResult> {
	const proc = Bun.spawn(["smartctl", "-j", "-H", "-A", "-i", device], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const timer = setTimeout(() => proc.kill(), 15_000);
	try {
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, code };
	} finally {
		clearTimeout(timer);
	}
}

function number(value: unknown): number | null {
	const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>).value : value;
	const result = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw)) ? Number(raw) : NaN;
	return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseSmartctl(device: string, text: string): NvmeDrive {
	const data = object(JSON.parse(text));
	const health = object(data.nvme_smart_health_information_log);
	if (["critical_warning", "available_spare", "percentage_used", "media_errors"].every((key) => number(health[key]) === null))
		throw new Error("NVMe health data was not returned.");
	const capacity = object(data.user_capacity);
	const status = object(data.smart_status);
	const units = number(health.data_units_written);
	const written = units === null ? null : units * 512_000;
	return {
		device,
		model: typeof data.model_name === "string" ? data.model_name : typeof data.model_number === "string" ? data.model_number : null,
		serial: typeof data.serial_number === "string" ? data.serial_number : null,
		capacityBytes: number(capacity.bytes),
		passed: typeof status.passed === "boolean" ? status.passed : null,
		criticalWarning: number(health.critical_warning),
		temperatureC: number(health.temperature),
		sparePercent: number(health.available_spare),
		spareThresholdPercent: number(health.available_spare_threshold),
		usedPercent: number(health.percentage_used),
		mediaErrors: number(health.media_errors),
		errorLogEntries: number(health.num_err_log_entries),
		powerOnHours: number(health.power_on_hours),
		dataWrittenBytes: written !== null && Number.isSafeInteger(written) ? written : null,
		error: null,
	};
}

function unreadable(device: string, error: string): NvmeDrive {
	return {
		device,
		model: null,
		serial: null,
		capacityBytes: null,
		passed: null,
		criticalWarning: null,
		temperatureC: null,
		sparePercent: null,
		spareThresholdPercent: null,
		usedPercent: null,
		mediaErrors: null,
		errorLogEntries: null,
		powerOnHours: null,
		dataWrittenBytes: null,
		error,
	};
}

async function names(path: string): Promise<string[]> {
	return readdir(path).catch(() => []);
}

async function value(path: string): Promise<string> {
	return (await readFile(path, "utf8").catch(() => "")).trim();
}

async function arrays(root: string): Promise<MdArray[]> {
	const result: MdArray[] = [];
	for (const device of (await names(join(root, "block"))).filter((name) => /^md\d+$/.test(name)).sort()) {
		const path = join(root, "block", device);
		const level = await value(join(path, "md", "level"));
		if (!level) continue;
		result.push({
			device: `/dev/${device}`,
			level,
			state: await value(join(path, "md", "array_state")),
			raidDisks: number(await value(join(path, "md", "raid_disks"))),
			degraded: number(await value(join(path, "md", "degraded"))),
			syncAction: await value(join(path, "md", "sync_action")),
			members: (await names(join(path, "slaves"))).sort(),
		});
	}
	return result;
}

export async function readStorage(root = "/sys", run: SmartRunner = runSmartctl): Promise<StorageReport> {
	const devices = (await names(join(root, "class", "nvme"))).filter((name) => /^nvme\d+$/.test(name)).sort();
	const drives: NvmeDrive[] = [];
	let smartctl: StorageReport["smartctl"] = "ok";
	for (const name of devices) {
		const device = `/dev/${name}`;
		try {
			const result = await run(device);
			drives.push(parseSmartctl(device, result.stdout));
		} catch (err) {
			const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
			smartctl = missing ? "missing" : "error";
			drives.push(unreadable(device, missing ? "Install smartmontools on this host." : (err as Error).message.slice(0, 200)));
		}
	}
	return { takenAt: Date.now(), smartctl, drives, arrays: await arrays(root) };
}

export class StorageMonitor {
	last: StorageReport | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private busy = false;

	constructor(
		private readonly onReport: (report: StorageReport) => void,
		private readonly onError: (message: string) => void,
		private readonly read: () => Promise<StorageReport> = readStorage,
	) {}

	start(): void {
		void this.tick();
		this.timer = setInterval(() => void this.tick(), 5 * 60_000);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async tick(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			this.last = await this.read();
			this.onReport(this.last);
		} catch (err) {
			this.onError(`Storage check failed: ${(err as Error).message}`);
		} finally {
			this.busy = false;
		}
	}
}
