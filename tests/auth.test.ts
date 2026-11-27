import { describe, expect, test } from "bun:test";
import { generateTOTP, generateTOTPSecret } from "@rabbit-company/totp";
import { sql } from "../src/controller/db/index.ts";
import { findSession } from "../src/controller/db/users.ts";
import { resetSetupCache } from "../src/controller/routes/web/common.ts";
import { cookieFrom, get, post, signIn, testApp } from "./helpers.ts";

describe("first run setup", () => {
	test("needs the setup token and a working code, then signs in", async () => {
		await sql`DELETE FROM users`;
		resetSetupCache();
		const { app } = testApp();
		expect((await get(app, "/")).headers.get("Location")).toBe("/setup");
		const page = await (await get(app, "/setup")).text();
		expect(page).toContain("Setup token");
		const secret = generateTOTPSecret();
		const base = { username: "Admin", password: "a long enough password", secret };

		const wrongToken = await post(app, "/setup", { ...base, setup_token: "nope", code: await generateTOTP(secret) });
		expect(wrongToken.status).toBe(400);
		expect(await wrongToken.text()).toContain("setup token is wrong");

		const wrongCode = await post(app, "/setup", { ...base, setup_token: "test-setup-token", code: "000000" });
		expect(wrongCode.status).toBe(400);

		const shortPassword = await post(app, "/setup", { ...base, password: "short", setup_token: "test-setup-token", code: await generateTOTP(secret) });
		expect(await shortPassword.text()).toContain("at least 12 characters");

		const ok = await post(app, "/setup", { ...base, setup_token: "test-setup-token", code: await generateTOTP(secret) });
		expect(ok.status).toBe(303);
		expect(ok.headers.get("Location")).toBe("/");
		const overview = await get(app, "/", cookieFrom(ok));
		expect(overview.status).toBe(200);
		const html = await overview.text();
		expect(html).toContain("<h1>Datacenter</h1>");
		expect(html).toContain('<span class="user-name">admin</span>');

		const again = await get(app, "/setup");
		expect(again.headers.get("Location")).toBe("/login");
		const [row] = await sql`SELECT username, role FROM users`;
		expect(row).toEqual({ username: "admin", role: "admin" });
	});
});

describe("sign in", () => {
	test("visitors go to the sign in page with a return path", async () => {
		const { app } = testApp();
		await signIn(app);
		const res = await get(app, "/hosts/new");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/login?next=%2Fhosts%2Fnew");
	});

	test("a password alone does not open pages", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		const login = await post(app, "/login", { username: user.username, password: user.password, next: "/" });
		const cookie = cookieFrom(login);
		expect(login.headers.get("Location")).toBe("/login/2fa?next=%2F");
		const res = await get(app, "/", cookie);
		expect(res.headers.get("Location")).toBe("/login/2fa");
	});

	test("wrong passwords and reused codes are refused", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		expect((await post(app, "/login", { username: user.username, password: "wrong password!!", next: "/" })).status).toBe(401);
		const login = await post(app, "/login", { username: user.username, password: user.password, next: "/" });
		const cookie = cookieFrom(login);
		const csrf = (await findSession(decodeURIComponent(cookie.split("=")[1]!)))!.csrf;
		const reused = await post(app, "/login/2fa", { code: user.code, _csrf: csrf, next: "/" }, cookie);
		expect(reused.status).toBe(401);
		expect(await reused.text()).toContain("already used");
	});

	test("forms need the CSRF token and the same origin", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		const missing = await post(app, "/hosts", { name: "x" }, user.cookie);
		expect(missing.status).toBe(403);
		const foreign = await app.handle(
			new Request("http://controller.test/hosts", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.test", Cookie: user.cookie },
				body: new URLSearchParams({ name: "x", _csrf: user.csrf }),
			}),
		);
		expect(foreign.status).toBe(403);
	});

	test("signing out ends the session", async () => {
		const { app } = testApp();
		const user = await signIn(app);
		expect((await post(app, "/logout", { _csrf: user.csrf }, user.cookie)).status).toBe(303);
		expect((await get(app, "/", user.cookie)).headers.get("Location")).toBe("/login");
	});
});

test("a code stays used after the clock moves to the next step", async () => {
	const { matchedStep } = await import("../src/controller/lib/totp.ts");
	const { generateTOTP } = await import("@rabbit-company/totp");
	const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
	const at = Math.floor(Date.now() / 30_000) * 30_000 + 1000;
	const code = await generateTOTP(secret, { timestamp: at });
	const step = Math.floor(at / 30_000);
	expect(await matchedStep(code, secret, at)).toBe(step);
	expect(await matchedStep(code, secret, at + 30_000)).toBe(step);
	expect(await matchedStep(code, secret, at + 60_000)).toBeNull();
	expect(await matchedStep("000000", secret, at)).toBe(code === "000000" ? step : null);
});
