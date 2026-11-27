import type { Web } from "@rabbit-company/web";
import { toSVG } from "@rabbit-company/qrcode";
import { generateTOTPSecret, generateTOTPURI } from "@rabbit-company/totp";
import { checkPassword, checkTotpCode, checkUsername } from "../../../shared/validate.ts";
import { APP_NAME } from "../../../shared/version.ts";
import { checkCsrf, clientIp, currentAuth, field, formData, page, redirect, safeNext } from "../../auth.ts";
import { config } from "../../config.ts";
import { audit } from "../../db/audit.ts";
import { claimTotpStep, completeMfa, countUsers, createSession, createUser, deleteSession, findLogin, totpSecret } from "../../db/users.ts";
import { clearSessionCookie, sessionCookie } from "../../lib/cookies.ts";
import { burnPasswordCheck, hashPassword, randomToken, safeEqual, verifyPassword } from "../../lib/crypto.ts";
import { logger } from "../../lib/logger.ts";
import { matchedStep } from "../../lib/totp.ts";
import { loginPage, setupPage, totpPage } from "../../ssr/pages/account.ts";
import type { AppState } from "../../types.ts";
import { closeBrowserSession } from "../api/agent.ts";
import { markSetupDone, needsSetup } from "./common.ts";

let generatedSetupToken: string | null = null;

/** The token that guards the first run page, so nobody else on the network can claim the admin account first. */
export function setupToken(): string {
	if (config.auth.setupToken) return config.auth.setupToken;
	if (generatedSetupToken === null) {
		generatedSetupToken = randomToken(18);
		logger.warn(`No account exists yet. Open ${config.server.domain}/setup and use this setup token: ${generatedSetupToken}`);
	}
	return generatedSetupToken;
}

function setupForm(error?: string, username?: string, secret = generateTOTPSecret()): Response {
	const uri = generateTOTPURI({ accountName: username || "admin", issuer: APP_NAME, secret });
	return page(setupPage({ secret, qr: toSVG(uri, { scale: 4 }), username, error }), error ? 400 : 200);
}

export function accountRoutes(app: Web<AppState>): void {
	app.get("/setup", async () => {
		if (!(await needsSetup())) return redirect("/login");
		setupToken();
		return setupForm();
	});

	app.post("/setup", async (ctx) => {
		if (!(await needsSetup())) return redirect("/login");
		const form = await formData(ctx);
		const secret = field(form, "secret");
		const rawName = field(form, "username");
		if (!/^[A-Z2-7]{16,128}$/.test(secret)) return setupForm("The authenticator key was damaged. Scan the new code.", rawName);
		if (!safeEqual(field(form, "setup_token").trim(), setupToken()))
			return setupForm("The setup token is wrong. Copy it from the controller log.", rawName, secret);
		const username = checkUsername(rawName);
		if (!username.ok) return setupForm(username.error, rawName, secret);
		const password = checkPassword(field(form, "password"));
		if (!password.ok) return setupForm(password.error, username.value, secret);
		const code = checkTotpCode(field(form, "code"));
		const step = code.ok ? await matchedStep(code.value, secret) : null;
		if (step === null) {
			return setupForm("That code did not work. Check the time on your phone and try the next code.", username.value, secret);
		}
		if ((await countUsers()) > 0) return redirect("/login");
		const user = await createUser({ username: username.value, passwordHash: await hashPassword(password.value), totpSecret: secret, role: "admin" });
		await claimTotpStep(user.id, step);
		markSetupDone();
		const token = await createSession(user.id, { ip: clientIp(ctx), userAgent: ctx.req.headers.get("User-Agent") });
		await completeMfa(token);
		await audit({ userId: user.id, action: "account.setup", target: user.username, ip: clientIp(ctx) });
		return redirect("/", [sessionCookie(token, config.auth.sessionDays * 86_400)]);
	});

	app.get("/login", async (ctx) => {
		if (await needsSetup()) return redirect("/setup");
		const next = safeNext(new URL(ctx.req.url).searchParams.get("next"));
		if (await currentAuth(ctx)) return redirect(next);
		return page(loginPage({ next }));
	});

	app.post("/login", async (ctx) => {
		const form = await formData(ctx);
		const next = safeNext(field(form, "next"));
		const username = field(form, "username").trim().toLowerCase();
		const password = field(form, "password");
		const login = await findLogin(username);
		if (!login) await burnPasswordCheck(password);
		if (!login || !(await verifyPassword(password, login.passwordHash))) {
			await audit({ userId: login?.user.id ?? null, action: "login.password", target: username.slice(0, 64), ok: false, ip: clientIp(ctx) });
			return page(loginPage({ next, username, flash: { kind: "error", text: "That username and password do not match." } }), 401);
		}
		const token = await createSession(login.user.id, { ip: clientIp(ctx), userAgent: ctx.req.headers.get("User-Agent") });
		return redirect(`/login/2fa?next=${encodeURIComponent(next)}`, [sessionCookie(token, 15 * 60)]);
	});

	app.get("/login/2fa", async (ctx) => {
		const auth = await currentAuth(ctx, { allowMfaPending: true });
		const next = safeNext(new URL(ctx.req.url).searchParams.get("next"));
		if (!auth) return redirect("/login");
		if (!auth.session.mfaPending) return redirect(next);
		return page(totpPage({ next, csrf: auth.session.csrf }));
	});

	app.post("/login/2fa", async (ctx) => {
		const auth = await currentAuth(ctx, { allowMfaPending: true });
		if (!auth) return redirect("/login");
		const form = await formData(ctx);
		checkCsrf(auth, form);
		const next = safeNext(field(form, "next"));
		if (!auth.session.mfaPending) return redirect(next);
		const code = checkTotpCode(field(form, "code"));
		const secret = await totpSecret(auth.user.id);
		const step = code.ok && secret !== null ? await matchedStep(code.value, secret) : null;
		if (step === null) {
			await audit({ userId: auth.user.id, action: "login.totp", ok: false, ip: clientIp(ctx) });
			return page(
				totpPage({ next, csrf: auth.session.csrf, flash: { kind: "error", text: "That code did not work. Check the time on your phone and try again." } }),
				401,
			);
		}
		if (!(await claimTotpStep(auth.user.id, step))) {
			return page(totpPage({ next, csrf: auth.session.csrf, flash: { kind: "error", text: "That code was already used. Wait for the next one." } }), 401);
		}
		await completeMfa(auth.token);
		await audit({ userId: auth.user.id, action: "login", ip: clientIp(ctx) });
		return redirect(next, [sessionCookie(auth.token, config.auth.sessionDays * 86_400)]);
	});

	app.post("/logout", async (ctx) => {
		const auth = await currentAuth(ctx, { allowMfaPending: true });
		if (auth) {
			checkCsrf(auth, await formData(ctx));
			await deleteSession(auth.token);
			closeBrowserSession(auth.session.csrf);
		}
		return redirect("/login", [clearSessionCookie()]);
	});
}
