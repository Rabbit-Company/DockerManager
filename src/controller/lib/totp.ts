import { generateTOTP } from "@rabbit-company/totp";
import { safeEqual } from "./crypto.ts";

const STEP_MS = 30_000;

/**
 * The 30 second step a code belongs to, accepting one step of clock drift each
 * way, or null when it matches none. Recording this step, not the current one,
 * keeps a seen code from working again after the clock moves to the next step.
 */
export async function matchedStep(code: string, secret: string, now = Date.now()): Promise<number | null> {
	let found: number | null = null;
	for (const offset of [-1, 0, 1]) {
		const at = now + offset * STEP_MS;
		if (safeEqual(await generateTOTP(secret, { timestamp: at }), code)) found = Math.floor(at / STEP_MS);
	}
	return found;
}
