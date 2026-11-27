import { bare, type Flash } from "../layout.ts";
import { html, raw } from "../html.ts";

export function setupPage(input: { secret: string; qr: string; username?: string; error?: string }): string {
	return bare(
		"First run setup",
		html`<h1>Create the admin account</h1>
			<p class="muted">
				This runs once. Every account signs in with a password and a code from an authenticator app, because this controller can run anything on every host.
			</p>
			<form method="post" action="/setup" class="stack">
				<label
					>Setup token
					<input name="setup_token" required autocomplete="off" spellcheck="false" />
					<small>Printed in the controller log on start, or the SETUP_TOKEN setting.</small>
				</label>
				<label>Username <input name="username" required autocomplete="username" value="${input.username ?? ""}" /></label>
				<label>Password <input name="password" type="password" required minlength="12" autocomplete="new-password" /></label>
				<fieldset class="totp-setup">
					<legend>Authenticator app</legend>
					<div class="qr">${raw(input.qr)}</div>
					<div class="stack">
						<p class="muted">Scan the code, or type this key into the app.</p>
						<code class="secret">${input.secret.match(/.{1,4}/g)?.join(" ")}</code>
						<label>Code from the app <input name="code" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9 ]{6,7}" /></label>
					</div>
				</fieldset>
				<input type="hidden" name="secret" value="${input.secret}" />
				<button class="button primary" type="submit">Create account</button>
			</form>`,
		input.error ? { kind: "error", text: input.error } : null,
	);
}

export function loginPage(input: { next: string; username?: string; flash?: Flash | null }): string {
	return bare(
		"Sign in",
		html`<h1>Sign in</h1>
			<form method="post" action="/login" class="stack">
				<input type="hidden" name="next" value="${input.next}" />
				<label>Username <input name="username" required autocomplete="username" autofocus value="${input.username ?? ""}" /></label>
				<label>Password <input name="password" type="password" required autocomplete="current-password" /></label>
				<button class="button primary" type="submit">Continue</button>
			</form>`,
		input.flash,
	);
}

export function totpPage(input: { next: string; csrf: string; flash?: Flash | null }): string {
	return bare(
		"Two factor code",
		html`<h1>Enter your code</h1>
			<p class="muted">Open your authenticator app and enter the 6 digit code.</p>
			<form method="post" action="/login/2fa" class="stack">
				<input type="hidden" name="next" value="${input.next}" />
				<input type="hidden" name="_csrf" value="${input.csrf}" />
				<label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus pattern="[0-9 ]{6,7}" /></label>
				<button class="button primary" type="submit">Sign in</button>
			</form>`,
		input.flash,
	);
}

export function errorPage(status: number, message: string): string {
	return bare(
		`Error ${status}`,
		html`<h1>${status === 404 ? "Not found" : "Something went wrong"}</h1>
			<p>${message}</p>
			<p><a class="button" href="/">Back to the overview</a></p>`,
	);
}
