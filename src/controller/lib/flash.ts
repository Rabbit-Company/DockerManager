/**
 * One-time notes carried from a form post to the page it redirects to, so a
 * refresh never sends the form again. Kept in memory per session for a few
 * minutes. A new join token passes through here and is never stored in plain text.
 */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 10_000;
const notes = new Map<string, { value: unknown; expires: number }>();

export function setFlash<T>(sessionId: string, value: T): void {
	if (notes.size >= MAX_ENTRIES) {
		const now = Date.now();
		for (const [key, note] of notes) if (note.expires < now) notes.delete(key);
		if (notes.size >= MAX_ENTRIES) notes.clear();
	}
	notes.set(sessionId, { value, expires: Date.now() + TTL_MS });
}

export function takeFlash<T>(sessionId: string): T | null {
	const note = notes.get(sessionId);
	notes.delete(sessionId);
	if (!note || note.expires < Date.now()) return null;
	return note.value as T;
}
