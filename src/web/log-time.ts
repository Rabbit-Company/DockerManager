import { outputTime } from "../shared/output-time.ts";

/** Docker puts an RFC 3339 time with up to nine fraction digits in front of each line when asked for timestamps. */
const DOCKER_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2}) ?(.*)$/s;
const MAX_PENDING = 8192;

export function dockerTime(text: string): { date: Date; rest: string } | null {
	const match = DOCKER_TIME.exec(text);
	if (!match) return null;
	const date = new Date(`${match[1]}.${(match[2] ?? "").slice(0, 3).padEnd(3, "0")}${match[3]}`);
	return Number.isNaN(date.getTime()) ? null : { date, rest: match[4]! };
}

/** Turns Docker's timestamped log lines into local times, also when a line arrives in pieces. */
export class LogTimeFormatter {
	private pending = "";
	private continuing = false;

	constructor(private readonly timeZone?: string) {}

	private line(text: string): string {
		const parsed = dockerTime(text);
		return `${outputTime(parsed?.date ?? new Date(), { timeZone: this.timeZone })} ${parsed?.rest ?? text}`;
	}

	push(text: string): string {
		this.pending += text;
		let out = "";
		let end: number;
		while ((end = this.pending.indexOf("\n")) !== -1) {
			const line = this.pending.slice(0, end);
			out += (this.continuing ? line : this.line(line)) + "\n";
			this.pending = this.pending.slice(end + 1);
			this.continuing = false;
		}
		if (this.pending.length > MAX_PENDING) {
			out += this.continuing ? this.pending : this.line(this.pending);
			this.pending = "";
			this.continuing = true;
		}
		return out;
	}

	flush(): string {
		const out = this.pending ? (this.continuing ? this.pending : this.line(this.pending)) : "";
		this.pending = "";
		this.continuing = false;
		return out;
	}
}
