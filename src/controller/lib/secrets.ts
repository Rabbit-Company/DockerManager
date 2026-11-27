import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { logger } from "./logger.ts";

const VERSION = "v1";

function loadKey(): Buffer {
	if (config.secrets.key) {
		const key = Buffer.from(config.secrets.key, "base64url");
		if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes in base64url. Create one with: openssl rand -base64 32 | tr '+/' '-_' | tr -d =");
		return key;
	}
	const file = config.secrets.keyFile;
	if (existsSync(file)) {
		const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
		if (key.length !== 32) throw new Error(`${file} does not hold a 32 byte key.`);
		return key;
	}
	const key = randomBytes(32);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, key.toString("base64url") + "\n", { mode: 0o600 });
	logger.warn(`Created a new secrets key in ${file}. Back it up with the database, stack .env files cannot be read without it.`);
	return key;
}

let key: Buffer | null = null;

function current(): Buffer {
	key ??= loadKey();
	return key;
}

/** AES-256-GCM with a random nonce, stored as v1.<nonce>.<tag>.<ciphertext>. */
export function encrypt(plain: string): string {
	if (plain === "") return "";
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", current(), nonce);
	const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	return [VERSION, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decrypt(stored: string): string {
	if (stored === "") return "";
	const [version, nonce, tag, body] = stored.split(".");
	if (version !== VERSION || !nonce || !tag || body === undefined) throw new Error("Unknown secret format.");
	const decipher = createDecipheriv("aes-256-gcm", current(), Buffer.from(nonce, "base64url"));
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
