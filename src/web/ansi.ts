/** A color is one of the 16 terminal colors, which the stylesheet themes, or an exact #rrggbb. */
export type AnsiColor = number | string;

export interface AnsiStyle {
	fg: AnsiColor | null;
	bg: AnsiColor | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strike: boolean;
}

export interface AnsiSegment {
	text: string;
	style: AnsiStyle;
}

const PLAIN: AnsiStyle = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
/** A sequence longer than this is not one a program meant, so it is dropped rather than held. */
const MAX_SEQUENCE = 4096;

const KEYS = Object.keys(PLAIN) as (keyof AnsiStyle)[];
const sameStyle = (a: AnsiStyle, b: AnsiStyle) => KEYS.every((key) => a[key] === b[key]);

export function isPlain(style: AnsiStyle): boolean {
	return sameStyle(style, PLAIN);
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;

/** The xterm 256 color table: 16 named colors, a 6x6x6 cube and 24 grays. */
export function color256(n: number): AnsiColor | null {
	if (!Number.isInteger(n) || n < 0 || n > 255) return null;
	if (n < 16) return n;
	if (n < 232) {
		const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		const i = n - 16;
		return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6));
	}
	const gray = 8 + (n - 232) * 10;
	return hex(gray, gray, gray);
}

/**
 * Turns text with terminal escape codes into styled segments. Colors and text
 * styles are kept, every other control sequence (cursor moves, titles, links) is
 * dropped. A sequence cut in two by a chunk boundary is held until the rest arrives.
 * With perLine, every line starts plain, as log lines are separate records and a color
 * left open on one must not tint the next.
 */
export class AnsiParser {
	private style: AnsiStyle = { ...PLAIN };
	private pending = "";

	constructor(private readonly perLine = false) {}

	reset(): void {
		this.style = { ...PLAIN };
		this.pending = "";
	}

	/** Styled text for input. Segments that follow each other differ in style. */
	push(input: string): AnsiSegment[] {
		const text = this.pending + input;
		this.pending = "";
		const out: AnsiSegment[] = [];
		let run = "";
		const emit = () => {
			if (!run) return;
			const last = out[out.length - 1];
			if (last && sameStyle(last.style, this.style)) last.text += run;
			else out.push({ text: run, style: { ...this.style } });
			run = "";
		};
		let i = 0;
		let newline = this.perLine ? text.indexOf("\n") : -1;
		while (i < text.length) {
			const esc = text.indexOf("\x1b", i);
			if (newline !== -1 && newline < i) newline = text.indexOf("\n", i);
			if (newline !== -1 && (esc === -1 || newline < esc)) {
				run += text.slice(i, newline + 1);
				emit();
				this.style = { ...PLAIN };
				i = newline + 1;
				continue;
			}
			if (esc === -1) {
				run += text.slice(i);
				break;
			}
			run += text.slice(i, esc);
			const end = sequenceEnd(text, esc);
			if (end === null) {
				if (text.length - esc <= MAX_SEQUENCE) this.pending = text.slice(esc);
				break;
			}
			const sequence = text.slice(esc, end);
			if (sequence.startsWith("\x1b[") && sequence.endsWith("m")) {
				emit();
				this.sgr(sequence.slice(2, -1));
			}
			i = end;
		}
		emit();
		return out;
	}

	private sgr(body: string): void {
		const params = body === "" ? ["0"] : body.split(";");
		for (let p = 0; p < params.length; p++) {
			const parts = params[p]!.split(":");
			const code = parts[0] === "" ? 0 : Number(parts[0]);
			if (code === 38 || code === 48) {
				let values: number[];
				if (parts.length > 1) values = parts.slice(1).map(Number);
				else {
					const mode = Number(params[p + 1]);
					const count = mode === 5 ? 2 : mode === 2 ? 4 : 1;
					values = params.slice(p + 1, p + 1 + count).map(Number);
					p += count;
				}
				const color = extended(values);
				if (color !== null) this.style[code === 38 ? "fg" : "bg"] = color;
				continue;
			}
			this.apply(code);
		}
	}

	private apply(code: number): void {
		const s = this.style;
		if (code === 0) this.style = { ...PLAIN };
		else if (code === 1) s.bold = true;
		else if (code === 2) s.dim = true;
		else if (code === 3) s.italic = true;
		else if (code === 4) s.underline = true;
		else if (code === 7) s.inverse = true;
		else if (code === 9) s.strike = true;
		else if (code === 22) s.bold = s.dim = false;
		else if (code === 23) s.italic = false;
		else if (code === 24) s.underline = false;
		else if (code === 27) s.inverse = false;
		else if (code === 29) s.strike = false;
		else if (code >= 30 && code <= 37) s.fg = code - 30;
		else if (code === 39) s.fg = null;
		else if (code >= 40 && code <= 47) s.bg = code - 40;
		else if (code === 49) s.bg = null;
		else if (code >= 90 && code <= 97) s.fg = code - 90 + 8;
		else if (code >= 100 && code <= 107) s.bg = code - 100 + 8;
	}
}

/** The color after 38 or 48: 5;n from the 256 table, or 2;r;g;b, also with an empty color space id as in 2::r:g:b. */
function extended(values: number[]): AnsiColor | null {
	if (values[0] === 5) return color256(values[1] ?? NaN);
	if (values[0] === 2) {
		const rgb = values
			.slice(1)
			.filter((v) => !Number.isNaN(v))
			.slice(-3);
		if (rgb.length === 3 && rgb.every((v) => Number.isInteger(v))) return hex(rgb[0]!, rgb[1]!, rgb[2]!);
	}
	return null;
}

/** Where the escape sequence that starts at index start ends, or null when the text stops first. */
function sequenceEnd(text: string, start: number): number | null {
	const kind = text[start + 1];
	if (kind === undefined) return null;
	if (kind === "[") {
		for (let i = start + 2; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c >= 0x40 && c <= 0x7e) return i + 1;
		}
		return null;
	}
	if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
		for (let i = start + 2; i < text.length; i++) {
			if (text[i] === "\x07") return i + 1;
			if (text[i] === "\x1b") {
				if (i + 1 >= text.length) return null;
				if (text[i + 1] === "\\") return i + 2;
			}
		}
		return null;
	}
	if (kind === "(" || kind === ")" || kind === "#") return start + 3 <= text.length ? start + 3 : null;
	return start + 2;
}

/**
 * Text nodes and spans for segments. The 16 named colors are classes, so the
 * stylesheet themes them. Exact colors are set through the style object, which
 * the content security policy allows where a style attribute would be refused.
 */
export function renderSegments(doc: Document, segments: AnsiSegment[]): DocumentFragment {
	const fragment = doc.createDocumentFragment();
	for (const { text, style } of segments) {
		if (isPlain(style)) {
			fragment.append(text);
			continue;
		}
		const span = doc.createElement("span");
		span.textContent = text;
		let fg: AnsiColor | "inverse" | null = style.fg;
		let bg: AnsiColor | "inverse" | null = style.bg;
		if (style.inverse) [fg, bg] = [bg ?? "inverse", fg ?? "inverse"];
		if (typeof fg === "number" || fg === "inverse") span.classList.add(`ansi-fg-${fg}`);
		else if (fg) span.style.color = fg;
		if (typeof bg === "number" || bg === "inverse") span.classList.add(`ansi-bg-${bg}`);
		else if (bg) span.style.backgroundColor = bg;
		if (style.bold) span.classList.add("ansi-bold");
		if (style.dim) span.classList.add("ansi-dim");
		if (style.italic) span.classList.add("ansi-italic");
		if (style.underline || style.strike)
			span.classList.add(style.underline && style.strike ? "ansi-underline-strike" : style.underline ? "ansi-underline" : "ansi-strike");
		fragment.append(span);
	}
	return fragment;
}
