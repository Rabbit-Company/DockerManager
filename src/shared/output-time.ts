const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
	const key = timeZone ?? "";
	let found = formatters.get(key);
	if (!found) {
		const options: Intl.DateTimeFormatOptions = {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		};
		try {
			found = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
		} catch {
			found = new Intl.DateTimeFormat("en-CA", options);
		}
		formatters.set(key, found);
	}
	return found;
}

/** A time like 2026-11-16 14:43:20 in the given or local time zone. */
export function outputTime(date: Date, options: { timeZone?: string } = {}): string {
	const parts: Record<string, string> = {};
	for (const part of formatter(options.timeZone).formatToParts(date)) parts[part.type] = part.value;
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** The time zone this process uses, sent to browsers so logs and job output show the same clock. */
export function localTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
