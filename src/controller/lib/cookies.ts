import { config } from "../config.ts";

const SECURE = config.server.domain.startsWith("https://");
/** On HTTPS the __Host- prefix makes browsers refuse the cookie unless it is Secure, on Path=/ and without Domain. */
const PREFIX = SECURE ? "__Host-" : "";

export const SESSION_COOKIE = `${PREFIX}dm_session`;

export function readCookie(req: Request, name: string): string | null {
	const header = req.headers.get("Cookie");
	if (header === null) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
		const value = part.slice(separator + 1).trim();
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}
	return null;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
	const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`, "HttpOnly"];
	if (SECURE) parts.push("Secure");
	return parts.join("; ");
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
	return cookie(SESSION_COOKIE, token, maxAgeSeconds);
}

export function clearSessionCookie(): string {
	return cookie(SESSION_COOKIE, "", 0);
}
