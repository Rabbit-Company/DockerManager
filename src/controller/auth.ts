import { getClientIp } from "@rabbit-company/web-middleware/ip-extract";
import { config } from "./config.ts";
import { findSession, getUser, type Session, type User } from "./db/users.ts";
import { readCookie, SESSION_COOKIE } from "./lib/cookies.ts";
import { safeEqual } from "./lib/crypto.ts";
import { ApiError } from "./lib/errors.ts";
import type { AppContext, AppMiddleware } from "./types.ts";

export const NO_STORE = "private, no-store";

export interface Auth {
	user: User;
	session: Session;
	token: string;
}

const AUTH = Symbol("auth");

export async function sessionFromRequest(req: Request): Promise<Auth | null> {
	const token = readCookie(req, SESSION_COOKIE);
	if (!token) return null;
	const session = await findSession(token);
	const user = session ? await getUser(session.userId) : null;
	return session && user ? { user, session, token } : null;
}

/** Null for visitors and for sessions still waiting on the 2FA code, unless allowMfaPending is set. */
export async function currentAuth(ctx: AppContext, options: { allowMfaPending?: boolean } = {}): Promise<Auth | null> {
	const state = ctx.state as Record<string | symbol, unknown>;
	let auth = state[AUTH] as Auth | null | undefined;
	if (auth === undefined) {
		auth = await sessionFromRequest(ctx.req);
		state[AUTH] = auth;
	}
	if (auth && auth.session.mfaPending && !options.allowMfaPending) return null;
	return auth;
}

function withCookies(headers: Record<string, string>, cookies: string[]): Headers {
	const result = new Headers(headers);
	for (const cookie of cookies) result.append("Set-Cookie", cookie);
	return result;
}

export function page(body: string | { toString(): string }, status = 200, cookies: string[] = []): Response {
	return new Response(String(body), { status, headers: withCookies({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE }, cookies) });
}

export function redirect(location: string, cookies: string[] = []): Response {
	return new Response(null, { status: 303, headers: withCookies({ Location: location, "Cache-Control": NO_STORE }, cookies) });
}

/** Only paths on this site, so `next` cannot send people elsewhere after signing in. */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
	return value;
}

export function loginRedirect(ctx: AppContext): Response {
	const url = new URL(ctx.req.url);
	const next = url.pathname + url.search;
	return redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
}

export async function formData(ctx: AppContext): Promise<FormData> {
	try {
		return await ctx.req.formData();
	} catch {
		throw new ApiError(400, "bad_request", "The form could not be read.");
	}
}

export function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === "string" ? value : "";
}

export function checkCsrf(auth: Auth, form: FormData): void {
	const token = field(form, "_csrf");
	if (!token || !safeEqual(token, auth.session.csrf)) {
		throw new ApiError(403, "csrf", "This form expired. Go back, reload the page and try again.");
	}
}

export function clientIp(ctx: AppContext): string | null {
	return getClientIp(ctx) ?? null;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Turns away writes whose Origin is another site. Agent endpoints authenticate with their own secret. */
export function sameOrigin(): AppMiddleware {
	return async (ctx, next) => {
		if (SAFE.has(ctx.req.method)) return next();
		if (new URL(ctx.req.url).pathname.startsWith("/api/agent/")) return next();
		const origin = ctx.req.headers.get("Origin");
		if (origin === null) {
			const site = ctx.req.headers.get("Sec-Fetch-Site");
			if (site !== null && site !== "same-origin" && site !== "none") throw new ApiError(403, "csrf", "Cross site requests are not allowed.");
			return next();
		}
		let host: string | null = null;
		try {
			host = new URL(origin).host;
		} catch {}
		if (host !== new URL(ctx.req.url).host && origin !== config.server.domain) throw new ApiError(403, "csrf", "Cross site requests are not allowed.");
		return next();
	};
}
