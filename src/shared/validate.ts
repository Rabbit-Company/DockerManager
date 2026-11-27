export type Check = { ok: true; value: string } | { ok: false; error: string };

const CONTROL = /[\x00-\x1f\x7f]/g;

export function cleanText(value: string): string {
	return value.replace(CONTROL, "").replace(/\s+/g, " ").trim();
}

export function checkUsername(value: string): Check {
	const name = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(name)) return { ok: false, error: "Use 2 to 32 letters, digits, dots, dashes or underscores." };
	return { ok: true, value: name };
}

export function checkPassword(value: string): Check {
	if (value.length < 12) return { ok: false, error: "Use at least 12 characters." };
	if (value.length > 256) return { ok: false, error: "Use at most 256 characters." };
	return { ok: true, value };
}

export function checkHostName(value: string): Check {
	const name = cleanText(value);
	if (name.length < 1 || name.length > 64) return { ok: false, error: "Give the host a name of 1 to 64 characters." };
	return { ok: true, value: name };
}

export function checkTotpCode(value: string): Check {
	const code = value.replace(/\s+/g, "");
	if (!/^\d{6}$/.test(code)) return { ok: false, error: "Enter the 6 digit code from your app." };
	return { ok: true, value: code };
}

/** Full ids, short ids and names, as Docker and Podman accept them. */
export function isContainerRef(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
}
