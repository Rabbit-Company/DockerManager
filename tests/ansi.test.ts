import { expect, test } from "bun:test";
import { AnsiParser, color256, type AnsiSegment } from "../src/web/ansi.ts";

const brief = (segments: AnsiSegment[]) =>
	segments.map(({ text, style }) => {
		const marks = Object.entries(style)
			.filter(([, value]) => value !== null && value !== false)
			.map(([key, value]) => (value === true ? key : `${key}=${value}`));
		return marks.length ? `${text}{${marks.join(",")}}` : text;
	});

test("a colored log line keeps its colors and loses its escape codes", () => {
	const line = "[\x1b[90m2026-11-27 22:48:50\x1b[0m] \x1b[1m\x1b[36mINFO\x1b[0m \x1b[36mHTTP listening on http://0.0.0.0:80\x1b[0m \n";
	expect(brief(new AnsiParser(true).push(line))).toEqual([
		"[",
		"2026-11-27 22:48:50{fg=8}",
		"] ",
		"INFO{fg=6,bold}",
		" ",
		"HTTP listening on http://0.0.0.0:80{fg=6}",
		" \n",
	]);
});

test("an escape code cut by a chunk boundary is held until the rest arrives", () => {
	const parser = new AnsiParser();
	expect(brief(parser.push("plain \x1b"))).toEqual(["plain "]);
	expect(brief(parser.push("[3"))).toEqual([]);
	expect(brief(parser.push("1mred\x1b[0m done"))).toEqual(["red{fg=1}", " done"]);
});

test("styles carry across chunks, and per line parsing starts every line plain", () => {
	const carried = new AnsiParser();
	carried.push("\x1b[32mgreen");
	expect(brief(carried.push(" still\nnext"))).toEqual([" still\nnext{fg=2}"]);
	const perLine = new AnsiParser(true);
	expect(brief(perLine.push("\x1b[32mgreen\nplain"))).toEqual(["green\n{fg=2}", "plain"]);
});

test("256 and true colors, bright colors, backgrounds and resets", () => {
	const parser = new AnsiParser();
	expect(brief(parser.push("\x1b[38;5;196ma\x1b[38;2;1;2;3mb\x1b[38:2::4:5:6mc\x1b[97;41md\x1b[39;49;4me\x1b[24;3;22mf\x1b[mg"))).toEqual([
		"a{fg=#ff0000}",
		"b{fg=#010203}",
		"c{fg=#040506}",
		"d{fg=15,bg=1}",
		"e{underline}",
		"f{italic}",
		"g",
	]);
	expect(color256(3)).toBe(3);
	expect(color256(244)).toBe("#808080");
	expect(color256(300)).toBeNull();
});

test("other control sequences are dropped and the text around them kept", () => {
	const parser = new AnsiParser();
	const text = "\x1b[2K\x1b[1Aclear \x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ title\x1b]0;window\x07 \x1b(Bend\x1b=";
	expect(brief(parser.push(text))).toEqual(["clear link title end"]);
	expect(brief(parser.push("\x1b]0;unfinished title"))).toEqual([]);
	expect(brief(parser.push("\x07after"))).toEqual(["after"]);
});
