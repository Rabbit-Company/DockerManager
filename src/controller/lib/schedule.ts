export const SCHEDULE_PRESETS: [string, string][] = [
	["0 3 * * *", "Every day at 03:00"],
	["0 */6 * * *", "Every 6 hours"],
	["@hourly", "Every hour"],
	["30 2 * * SUN", "Every Sunday at 02:30"],
	["0 4 1 * *", "On the 1st of every month at 04:00"],
];

/** The next time a cron expression fires after `after`, in the controller's time zone, or null when it never does. */
export function nextRun(expression: string, after: Date | number = Date.now()): Date | null {
	return Bun.cron.parse(expression, after);
}

export function checkSchedule(expression: string): { ok: true; value: string } | { ok: false; error: string } {
	const value = expression.trim().replace(/\s+/g, " ");
	if (value.length === 0 || value.length > 100) return { ok: false, error: "Give a schedule." };
	try {
		if (nextRun(value) === null) return { ok: false, error: "This schedule never runs." };
	} catch (err) {
		return { ok: false, error: `${(err as Error).message.replace(/\.$/, "")}. Use five fields: minute, hour, day of month, month and day of week.` };
	}
	return { ok: true, value };
}

export function describeSchedule(expression: string): string {
	return SCHEDULE_PRESETS.find(([cron]) => cron === expression)?.[1] ?? expression;
}
