import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Backup files: "DMBAK001", a 16 byte salt, then frames of a 4 byte length and
 * AES-256-GCM ciphertext with its tag. Every file gets its own key from HKDF
 * over the destination key and the salt. The nonce is the frame number plus a
 * flag on the last frame, so frames cannot be reordered, dropped or cut off
 * without the check failing.
 */
const MAGIC = new TextEncoder().encode("DMBAK001");
const SALT = 16;
const HEADER = MAGIC.length + SALT;
export const CHUNK = 1024 * 1024;
const TAG = 16;

export function generateKey(): string {
	return randomBytes(32).toString("base64url");
}

export function decodeKey(key: string): Buffer {
	const raw = Buffer.from(key, "base64url");
	if (raw.length !== 32) throw new Error("A backup key is 32 bytes in base64url.");
	return raw;
}

function fileKey(master: Buffer, salt: Uint8Array): Buffer {
	return Buffer.from(hkdfSync("sha256", master, salt, "dockermanager backup v1", 32));
}

function nonce(counter: number, last: boolean): Buffer {
	const n = Buffer.alloc(12);
	n.writeBigUInt64BE(BigInt(counter), 0);
	n[11] = last ? 1 : 0;
	return n;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

export function encryptStream(key: string): TransformStream<Uint8Array, Uint8Array> {
	const master = decodeKey(key);
	const salt = randomBytes(SALT);
	const header = concat(MAGIC, salt);
	const k = fileKey(master, salt);
	let counter = 0;
	let buffer: Uint8Array = new Uint8Array(0);
	const seal = (plain: Uint8Array, last: boolean): Uint8Array => {
		const cipher = createCipheriv("aes-256-gcm", k, nonce(counter++, last));
		cipher.setAAD(header);
		const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
		const frame = new Uint8Array(4 + body.length);
		new DataView(frame.buffer).setUint32(0, body.length);
		frame.set(body, 4);
		return frame;
	};
	return new TransformStream({
		start(controller) {
			controller.enqueue(header);
		},
		transform(chunk, controller) {
			buffer = concat(buffer, chunk);
			while (buffer.length > CHUNK) {
				controller.enqueue(seal(buffer.subarray(0, CHUNK), false));
				buffer = buffer.slice(CHUNK);
			}
		},
		flush(controller) {
			controller.enqueue(seal(buffer, true));
		},
	});
}

export class BackupIntegrityError extends Error {}

export function decryptStream(key: string): TransformStream<Uint8Array, Uint8Array> {
	const master = decodeKey(key);
	let buffer: Uint8Array = new Uint8Array(0);
	let header: Uint8Array | null = null;
	let k: Buffer | null = null;
	let counter = 0;
	let held: Uint8Array | null = null;
	const open = (body: Uint8Array, last: boolean): Uint8Array => {
		if (body.length < TAG) throw new BackupIntegrityError("A frame of the backup is too short.");
		const decipher = createDecipheriv("aes-256-gcm", k!, nonce(counter, last));
		decipher.setAAD(header!);
		decipher.setAuthTag(body.subarray(body.length - TAG));
		try {
			const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG)), decipher.final()]);
			counter++;
			return plain;
		} catch {
			throw new BackupIntegrityError(
				last ? "The backup ends early, was changed, or the key is wrong. It cannot be trusted." : "The backup was changed or the key is wrong.",
			);
		}
	};
	return new TransformStream({
		transform(chunk, controller) {
			buffer = concat(buffer, chunk);
			if (!header) {
				if (buffer.length < HEADER) return;
				if (!MAGIC.every((b, i) => buffer[i] === b)) throw new BackupIntegrityError("This is not a backup file of this program.");
				header = buffer.slice(0, HEADER);
				k = fileKey(master, header.subarray(MAGIC.length));
				buffer = buffer.slice(HEADER);
			}
			while (buffer.length >= 4) {
				const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
				if (length > CHUNK + TAG) throw new BackupIntegrityError("A frame of the backup is too long.");
				if (buffer.length < 4 + length) break;
				const body = buffer.slice(4, 4 + length);
				buffer = buffer.slice(4 + length);
				if (held) controller.enqueue(open(held, false));
				held = body;
			}
		},
		flush(controller) {
			if (!header) throw new BackupIntegrityError("This is not a backup file of this program.");
			if (buffer.length > 0 || !held) throw new BackupIntegrityError("The backup ends early or was changed. It cannot be trusted.");
			controller.enqueue(open(held, true));
		},
	});
}
