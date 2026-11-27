import { generateTOTP, generateTOTPSecret } from "@rabbit-company/totp";
import { createApp, createHub } from "../src/controller/index.ts";
import { hashPassword } from "../src/controller/lib/crypto.ts";
import { createUser, findSession } from "../src/controller/db/users.ts";
import { markSetupDone } from "../src/controller/routes/web/common.ts";

export const ORIGIN = "http://controller.test";
let counter = 0;

export function testApp(publish?: (topic: string, data: string) => void) {
	const hub = createHub(publish);
	return { hub, app: createApp(hub) };
}

export function cookieFrom(response: Response): string {
	const header = response.headers.getSetCookie().find((c) => c.startsWith("dm_session="));
	if (!header) throw new Error("No session cookie in the response");
	return header.split(";")[0]!;
}

export function form(values: Record<string, string>): URLSearchParams {
	return new URLSearchParams(values);
}

export async function post(app: ReturnType<typeof createApp>, path: string, values: Record<string, string>, cookie?: string): Promise<Response> {
	return app.handle(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
			body: form(values),
		}),
	);
}

export async function get(app: ReturnType<typeof createApp>, path: string, cookie?: string): Promise<Response> {
	return app.handle(new Request(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {} }));
}

export interface SignedIn {
	cookie: string;
	csrf: string;
	username: string;
	password: string;
	secret: string;
	/** The code used for the second factor, for replay tests. */
	code: string;
}

/** Creates an account and signs it in through the real forms. */
export async function signIn(app: ReturnType<typeof createApp>): Promise<SignedIn> {
	const username = `user${++counter}x${Math.floor(Math.random() * 1e6)}`;
	const password = "correct horse battery staple";
	const secret = generateTOTPSecret();
	await createUser({ username, passwordHash: await hashPassword(password), totpSecret: secret, role: "admin" });
	markSetupDone();
	const login = await post(app, "/login", { username, password, next: "/" });
	if (login.status !== 303) throw new Error(`Login failed with ${login.status}`);
	const cookie = cookieFrom(login);
	const token = decodeURIComponent(cookie.split("=")[1]!);
	const csrf = (await findSession(token))!.csrf;
	const code = await generateTOTP(secret);
	const done = await post(app, "/login/2fa", { code, _csrf: csrf, next: "/" }, cookie);
	if (done.status !== 303) throw new Error(`2FA failed with ${done.status}`);
	return { cookie, csrf, username, password, secret, code };
}
