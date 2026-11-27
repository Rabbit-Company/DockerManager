import { outputTime } from "../shared/output-time.ts";
import { startCharts, type LiveSample } from "./charts.ts";
import { jobOutput, type JobMessage } from "./job.ts";
import { updateLiveValues } from "./live-metrics.ts";
import { LogTimeFormatter } from "./log-time.ts";

type Incoming =
	| { type: "auth.ok" }
	| ({ type: "metrics" } & LiveSample)
	| JobMessage
	| { type: "changed"; topic: string }
	| { type: "logs.opened"; stream: string }
	| { type: "logs"; stream: string; data: string }
	| { type: "logs.end"; stream: string | null; error: string | null };

const MAX_LOG_CHARS = 400_000;

class Live {
	private ws: WebSocket | null = null;
	private ready = false;
	private attempt = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshing = false;
	private onOpen: (() => void)[] = [];
	readonly handlers: ((message: Incoming) => void)[] = [];

	constructor(private readonly topics: string[]) {}

	start(): void {
		this.ready = false;
		const url = new URL("/ws", location.href);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(url);
		this.ws = ws;
		ws.addEventListener("open", () => {
			ws.send(JSON.stringify({ type: "auth", csrf: document.body.dataset.socketCsrf ?? "" }));
		});
		ws.addEventListener("message", (event) => {
			let message: Incoming;
			try {
				message = JSON.parse(String(event.data)) as Incoming;
			} catch {
				return;
			}
			if (message.type === "auth.ok") {
				this.ready = true;
				this.attempt = 0;
				setConn("live");
				ws.send(JSON.stringify({ type: "watch", topics: this.topics }));
				for (const fn of this.onOpen) fn();
				return;
			}
			if (message.type === "changed") this.scheduleRefresh();
			for (const handler of this.handlers) handler(message);
		});
		ws.addEventListener("close", (event) => {
			this.ws = null;
			this.ready = false;
			setConn("down");
			if (event.code === 4003) return;
			const wait = Math.min(15_000, 500 * 2 ** this.attempt++);
			setTimeout(() => this.start(), wait);
		});
	}

	send(message: unknown): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
	}

	whenOpen(fn: () => void): void {
		this.onOpen.push(fn);
		if (this.ready) fn();
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => void this.refresh(), 400);
	}

	/** Fetches the page again and swaps every element marked data-live, so all rendering stays on the server. */
	private async refresh(): Promise<void> {
		if (this.refreshing) return this.scheduleRefresh();
		this.refreshing = true;
		try {
			const response = await fetch(location.href, { headers: { Accept: "text/html" }, credentials: "same-origin" });
			if (!response.ok || response.redirected) return;
			const doc = new DOMParser().parseFromString(await response.text(), "text/html");
			const active = document.activeElement;
			for (const fresh of doc.querySelectorAll<HTMLElement>("[data-live]")) {
				const current = document.querySelector<HTMLElement>(`[data-live="${CSS.escape(fresh.dataset.live ?? "")}"]`);
				if (!current || current.contains(active)) continue;
				if (current.innerHTML !== fresh.innerHTML) current.replaceWith(document.importNode(fresh, true));
			}
		} catch {
		} finally {
			this.refreshing = false;
		}
	}
}

function setConn(state: "live" | "down"): void {
	const el = document.querySelector<HTMLElement>("[data-conn]");
	if (!el) return;
	el.dataset.state = state;
	const text = el.querySelector<HTMLElement>("[data-conn-text]");
	if (text) text.textContent = state === "live" ? "Live" : "Reconnecting";
}

function logs(live: Live): void {
	const root = document.querySelector<HTMLElement>("[data-logs]");
	if (!root) return;
	const output = root.querySelector<HTMLElement>("[data-logs-output]")!;
	const tailSelect = root.querySelector<HTMLSelectElement>("[data-logs-tail]")!;
	const followButton = root.querySelector<HTMLButtonElement>("[data-logs-follow]")!;
	const host = Number(root.dataset.host);
	const container = root.dataset.container ?? "";
	let stream: string | null = null;
	let follow = true;
	let started = false;
	const timeZone = document.querySelector<HTMLMetaElement>('meta[name="time-zone"]')?.content || undefined;
	let times = new LogTimeFormatter(timeZone);

	const append = (text: string) => {
		const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
		if (!started) {
			output.textContent = "";
			started = true;
		}
		output.append(text);
		if ((output.textContent?.length ?? 0) > MAX_LOG_CHARS) output.textContent = output.textContent!.slice(-MAX_LOG_CHARS / 2);
		if (follow && atBottom) output.scrollTop = output.scrollHeight;
	};

	const open = () => {
		if (stream) live.send({ type: "logs.close", stream });
		stream = null;
		started = false;
		times = new LogTimeFormatter(timeZone);
		output.textContent = "Connecting...";
		live.send({ type: "logs.open", host, container, tail: Number(tailSelect.value) });
	};

	live.handlers.push((message) => {
		if (message.type === "logs.opened") {
			stream = message.stream;
			if (!started) output.textContent = "";
			started = true;
		} else if (message.type === "logs" && message.stream === stream) {
			const text = times.push(message.data);
			if (text) append(text);
		} else if (message.type === "logs.end" && (message.stream === stream || message.stream === null)) {
			const pending = times.flush();
			if (pending) append(pending);
			append(`\n${outputTime(new Date(), { timeZone })} [${message.error ? `log stream ended: ${message.error}` : "log stream ended"}]\n`);
			stream = null;
		}
	});
	live.whenOpen(open);
	tailSelect.addEventListener("change", open);
	followButton.addEventListener("click", () => {
		follow = !follow;
		followButton.setAttribute("aria-pressed", String(follow));
		followButton.textContent = follow ? "Following" : "Paused";
		if (follow) output.scrollTop = output.scrollHeight;
	});
	root.querySelector("[data-logs-clear]")?.addEventListener("click", () => {
		output.textContent = "";
	});
	addEventListener("pagehide", () => {
		if (stream) live.send({ type: "logs.close", stream });
	});
}

function copyButtons(): void {
	document.addEventListener("click", (event) => {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
		if (!button) return;
		const source = document.getElementById(button.dataset.copy ?? "");
		if (!source) return;
		void navigator.clipboard.writeText(source.textContent ?? "").then(() => {
			button.textContent = "Copied";
			setTimeout(() => (button.textContent = "Copy"), 1500);
		});
	});
}

/** Counts down to a time in the page, then reloads it, such as the firewall's time to keep new rules. */
function countdowns(): void {
	const nodes = [...document.querySelectorAll<HTMLElement>("[data-countdown-until]")];
	if (nodes.length === 0) return;
	const tick = () => {
		for (const node of nodes) {
			const left = Math.round((Number(node.dataset.countdownUntil) - Date.now()) / 1000);
			node.textContent = `${Math.max(0, left)} s`;
			if (left < -2) {
				location.reload();
				return;
			}
		}
		setTimeout(tick, 1000);
	};
	tick();
}

function navToggle(): void {
	const button = document.querySelector<HTMLButtonElement>("[data-nav-toggle]");
	if (!button) return;
	button.addEventListener("click", () => {
		const open = document.body.classList.toggle("nav-open");
		button.setAttribute("aria-expanded", String(open));
	});
}

function menus(): void {
	const close = (except?: Element) => {
		for (const menu of document.querySelectorAll<HTMLDetailsElement>("details[data-menu][open]")) if (menu !== except) menu.open = false;
	};
	document.addEventListener("click", (e) => close((e.target as Element).closest("details[data-menu]") ?? undefined));
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		const open = document.querySelector<HTMLDetailsElement>("details[data-menu][open]");
		if (!open) return;
		open.open = false;
		open.querySelector("summary")?.focus();
	});
}

function main(): void {
	copyButtons();
	navToggle();
	menus();
	countdowns();
	const topics = (document.body.dataset.watch ?? "").split(" ").filter((t) => t.length > 0);
	if (topics.length === 0 && !document.querySelector("[data-logs]")) return;
	const live = new Live(topics);
	const charts = startCharts();
	const job = jobOutput();
	if (job) {
		live.whenOpen(() => job.opened());
		live.handlers.push((message) => {
			if (message.type === "job.output" || message.type === "job.end") job.message(message);
		});
	}
	live.handlers.push((message) => {
		if (message.type !== "metrics") return;
		updateLiveValues(message);
		charts?.(message);
	});
	logs(live);
	live.start();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
