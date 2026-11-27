import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { cleanText } from "../../shared/validate.ts";
import { APP_NAME } from "../../shared/version.ts";
import type { ChannelConfig, ChannelKind } from "../db/alerts.ts";
import type { Severity } from "./rules.ts";

export const CHANNEL_KINDS: [ChannelKind, string, string][] = [
	["ntfy", "ntfy", "Push notifications to phones and desktops, from ntfy.sh or your own server"],
	["discord", "Discord", "A message in a channel through a webhook"],
	["email", "Email", "Through your SMTP server"],
	["webhook", "Webhook", "JSON to any address, signed with a shared secret"],
];

export interface Notice {
	kind: "firing" | "resolved" | "event" | "test";
	severity: Severity;
	title: string;
	detail: string | null;
	link: string | null;
	rule: string;
	host: string | null;
	at: string;
}

const TIMEOUT_MS = 10_000;

function httpUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString().replace(/\/$/, "") : null;
	} catch {
		return null;
	}
}

const field = (form: FormData, name: string) => {
	const v = form.get(name);
	return typeof v === "string" ? v.trim() : "";
};

/** Reads the channel form. A secret left empty keeps the one stored before. */
export function parseChannel(form: FormData, previous: ChannelConfig | null): { values: Record<string, string>; config?: ChannelConfig; error?: string } {
	const values: Record<string, string> = {};
	for (const k of ["name", "kind", "server", "topic", "smtp_host", "smtp_port", "security", "smtp_user", "from", "to", "url"]) values[k] = field(form, k);
	values.name = cleanText(values.name!);
	if (values.name.length < 1 || values.name.length > 64) return { values, error: "Give the channel a name of 1 to 64 characters." };
	const keep = (name: string, old: string | undefined) => field(form, name) || old || "";
	switch (values.kind) {
		case "ntfy": {
			const server = httpUrl(values.server || "https://ntfy.sh");
			if (!server) return { values, error: "The ntfy server is an address like https://ntfy.sh." };
			if (!/^[\w-]{1,64}$/.test(values.topic!)) return { values, error: "The topic may hold letters, digits, dashes and underscores." };
			return { values, config: { kind: "ntfy", server, topic: values.topic!, token: keep("token", previous?.kind === "ntfy" ? previous.token : undefined) } };
		}
		case "discord": {
			const url = httpUrl(field(form, "discord_url") || (previous?.kind === "discord" ? previous.url : ""));
			if (!url || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url))
				return { values, error: "Paste the webhook address Discord shows under the channel's Integrations." };
			return { values, config: { kind: "discord", url } };
		}
		case "webhook": {
			const url = httpUrl(values.url!);
			if (!url) return { values, error: "Give an http or https address." };
			const secret = keep("secret", previous?.kind === "webhook" ? previous.secret : undefined);
			if (secret.length < 16) return { values, error: "Give a secret of at least 16 characters, so receivers can check the signature." };
			return { values, config: { kind: "webhook", url, secret } };
		}
		case "email": {
			const port = Number(values.smtp_port || "587");
			if (!/^[\w.-]+$/.test(values.smtp_host!)) return { values, error: "Give the SMTP server, such as smtp.example.com." };
			if (!Number.isInteger(port) || port < 1 || port > 65535) return { values, error: "The port is a number like 587." };
			const security = values.security === "tls" || values.security === "none" ? values.security : "starttls";
			const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
			const to = values.to!.split(/[,\s]+/).filter((t) => t.length > 0);
			if (!email.test(values.from!)) return { values, error: "The sender is an email address." };
			if (to.length === 0 || to.length > 20 || !to.every((t) => email.test(t)))
				return { values, error: "Give one or more recipient addresses, separated by commas." };
			const password = keep("smtp_password", previous?.kind === "email" ? previous.password : undefined);
			return { values, config: { kind: "email", host: values.smtp_host!, port, security, username: values.smtp_user!, password, from: values.from!, to } };
		}
		default:
			return { values, error: "Choose a kind of channel." };
	}
}

export function channelValues(config: ChannelConfig | null, name = ""): Record<string, string> {
	const v: Record<string, string> = { name, kind: config?.kind ?? "ntfy", server: "https://ntfy.sh", smtp_port: "587", security: "starttls" };
	if (!config) return v;
	if (config.kind === "ntfy") Object.assign(v, { server: config.server, topic: config.topic });
	if (config.kind === "email")
		Object.assign(v, {
			smtp_host: config.host,
			smtp_port: String(config.port),
			security: config.security,
			smtp_user: config.username,
			from: config.from,
			to: config.to.join(", "),
		});
	if (config.kind === "webhook") v.url = config.url;
	return v;
}

function subject(n: Notice): string {
	const prefix =
		n.kind === "resolved" ? "Resolved" : n.kind === "test" ? "Test" : n.severity === "critical" ? "Alert" : n.severity === "warning" ? "Warning" : "Notice";
	return `[${APP_NAME}] ${prefix}: ${n.title}`;
}

function bodyText(n: Notice): string {
	return [n.detail, n.link ? `Open: ${n.link}` : null, `${n.host ? `Host ${n.host}, ` : ""}${n.at.replace("T", " ").slice(0, 19)} UTC`]
		.filter((l) => l)
		.join("\n\n");
}

/** Sends one notice. Throws with a short reason when the channel refuses it. */
export async function deliver(config: ChannelConfig, n: Notice, fetcher: typeof fetch = fetch): Promise<void> {
	const check = async (response: Response) => {
		if (response.ok) return;
		const text = (await response.text().catch(() => "")).slice(0, 200);
		throw new Error(`The server answered ${response.status}${text ? `: ${text}` : ""}`);
	};
	switch (config.kind) {
		case "ntfy": {
			const headers: Record<string, string> = {
				Title: subject(n),
				Priority: n.kind === "resolved" ? "default" : n.severity === "critical" ? "urgent" : n.severity === "warning" ? "high" : "default",
				Tags: n.kind === "resolved" ? "white_check_mark" : n.severity === "info" ? "information_source" : "warning",
			};
			if (n.link) headers.Click = n.link;
			if (config.token) headers.Authorization = `Bearer ${config.token}`;
			await check(await fetcher(`${config.server}/${config.topic}`, { method: "POST", headers, body: bodyText(n), signal: AbortSignal.timeout(TIMEOUT_MS) }));
			return;
		}
		case "discord": {
			const color = n.kind === "resolved" ? 0x15803d : n.severity === "critical" ? 0xc2261d : n.severity === "warning" ? 0xd97706 : 0x2563eb;
			const embed = { title: subject(n).slice(0, 256), description: bodyText(n).slice(0, 4000), color, url: n.link ?? undefined, timestamp: n.at };
			await check(
				await fetcher(config.url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ username: APP_NAME, embeds: [embed] }),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				}),
			);
			return;
		}
		case "webhook": {
			const body = JSON.stringify({
				event: `alert.${n.kind}`,
				alert: { rule: n.rule, severity: n.severity, title: n.title, detail: n.detail, link: n.link, host: n.host, at: n.at },
			});
			const signature = createHmac("sha256", config.secret).update(body).digest("hex");
			await check(
				await fetcher(config.url, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-DockerManager-Signature": `sha256=${signature}`, "User-Agent": `${APP_NAME} alerts` },
					body,
					signal: AbortSignal.timeout(TIMEOUT_MS),
				}),
			);
			return;
		}
		case "email": {
			const transport = nodemailer.createTransport({
				host: config.host,
				port: config.port,
				secure: config.security === "tls",
				requireTLS: config.security === "starttls",
				ignoreTLS: config.security === "none",
				auth: config.username ? { user: config.username, pass: config.password } : undefined,
				connectionTimeout: TIMEOUT_MS,
				greetingTimeout: TIMEOUT_MS,
				socketTimeout: TIMEOUT_MS,
			});
			try {
				await transport.sendMail({ from: config.from, to: config.to, subject: subject(n), text: bodyText(n) });
			} finally {
				transport.close();
			}
			return;
		}
	}
}
