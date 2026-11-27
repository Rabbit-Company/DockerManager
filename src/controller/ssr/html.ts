export class SafeHtml {
	constructor(readonly value: string) {}
	toString(): string {
		return this.value;
	}
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escape(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

type Part = SafeHtml | string | number | boolean | null | undefined | Part[];

function render(part: Part): string {
	if (part === null || part === undefined || part === false || part === true) return "";
	if (part instanceof SafeHtml) return part.value;
	if (Array.isArray(part)) return part.map(render).join("");
	return escape(String(part));
}

export function html(strings: TemplateStringsArray, ...parts: Part[]): SafeHtml {
	let out = strings[0] ?? "";
	for (let i = 0; i < parts.length; i++) out += render(parts[i]) + (strings[i + 1] ?? "");
	return new SafeHtml(out);
}

export function raw(value: string): SafeHtml {
	return new SafeHtml(value);
}
