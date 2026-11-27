/** Random url safe token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** Tokens are stored only as their digest, so a leaked table cannot be used to sign in. */
export function hashToken(token: string): string {
	return new Bun.CryptoHasher("blake2b256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
	const ha = new Bun.CryptoHasher("blake2b256").update(a).digest();
	const hb = new Bun.CryptoHasher("blake2b256").update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
}

export function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	try {
		return await Bun.password.verify(password, stored);
	} catch {
		return false;
	}
}

const DUMMY_HASH = await hashPassword(randomToken());

/** Spends the same time as a real check, so a missing account cannot be told apart by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
	await verifyPassword(password, DUMMY_HASH);
}
