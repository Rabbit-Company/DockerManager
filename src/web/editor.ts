import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { checkCompose, parseEnv } from "../shared/compose.ts";

const highlight = HighlightStyle.define([
	{ tag: [tags.propertyName, tags.definition(tags.propertyName)], class: "tok-key" },
	{ tag: [tags.string, tags.special(tags.string)], class: "tok-string" },
	{ tag: [tags.number, tags.bool, tags.null], class: "tok-literal" },
	{ tag: [tags.comment, tags.lineComment], class: "tok-comment" },
	{ tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], class: "tok-punct" },
	{ tag: [tags.labelName, tags.meta, tags.typeName], class: "tok-meta" },
]);

/** Colours come from the stylesheet, so the editor follows the light and dark theme like the rest of the page. */
const theme = EditorView.theme({
	"&": { backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "13px" },
	"&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "0" },
	".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55", overflow: "auto" },
	".cm-content": { caretColor: "var(--text)", padding: "8px 0" },
	".cm-gutters": {
		backgroundColor: "var(--surface-2)",
		color: "var(--muted)",
		border: "none",
		borderRight: "1px solid var(--border)",
		borderRadius: "8px 0 0 8px",
	},
	".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
	".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)", color: "var(--text)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
		backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
	},
	".cm-cursor": { borderLeftColor: "var(--text)" },
	".cm-tooltip": { backgroundColor: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "6px" },
	".cm-diagnostic": { padding: "4px 8px", fontFamily: "system-ui, sans-serif", fontSize: "13px" },
	".cm-diagnostic-error": { borderLeftColor: "var(--bad)" },
	".cm-diagnostic-warning": { borderLeftColor: "var(--warn)" },
	".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--bad)", textUnderlineOffset: "3px" },
	".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)", textUnderlineOffset: "3px" },
});

function composeLint(status: HTMLElement | null): Extension {
	return linter(
		(view) => {
			const issues = checkCompose(view.state.doc.toString());
			if (status) status.textContent = issues.length === 0 ? "No problems found" : `${issues.length} problem${issues.length === 1 ? "" : "s"}`;
			const max = view.state.doc.length;
			return issues.map((i): Diagnostic => ({
				from: Math.min(i.from, max),
				to: Math.min(Math.max(i.to, i.from), max),
				severity: i.severity,
				message: i.message,
			}));
		},
		{ delay: 300 },
	);
}

const envLint = linter((view) => {
	const doc = view.state.doc;
	return parseEnv(doc.toString()).errors.map((e): Diagnostic => {
		const line = doc.line(Math.min(e.line, doc.lines));
		return { from: line.from, to: line.to, severity: "error", message: "Use KEY=value, one per line." };
	});
});

function mount(textarea: HTMLTextAreaElement, kind: "yaml" | "env", onChange: () => void): EditorView {
	const status = textarea.closest(".panel")?.querySelector<HTMLElement>("[data-editor-status]") ?? null;
	const extensions: Extension[] = [
		lineNumbers(),
		highlightActiveLineGutter(),
		history(),
		drawSelection(),
		indentOnInput(),
		bracketMatching(),
		highlightActiveLine(),
		syntaxHighlighting(highlight),
		keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
		EditorState.tabSize.of(2),
		theme,
		EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')?.content ?? ""),
		EditorView.contentAttributes.of({ "aria-label": textarea.labels?.[0]?.textContent?.trim() ?? kind, spellcheck: "false", autocapitalize: "off" }),
		EditorView.updateListener.of((u) => {
			if (u.docChanged) onChange();
		}),
	];
	if (kind === "yaml") extensions.push(yaml(), foldGutter(), lintGutter(), composeLint(status));
	else extensions.push(envLint);
	const view = new EditorView({ doc: textarea.value, extensions });
	view.dom.classList.add(kind === "yaml" ? "editor-yaml" : "editor-env");
	textarea.hidden = true;
	textarea.after(view.dom);
	return view;
}

function main(): void {
	const form = document.querySelector<HTMLFormElement>("[data-editor-form]");
	if (!form) return;
	let dirty = false;
	let submitting = false;
	const views: [HTMLTextAreaElement, EditorView][] = [];
	for (const textarea of form.querySelectorAll<HTMLTextAreaElement>("textarea[data-editor]")) {
		views.push([textarea, mount(textarea, textarea.dataset.editor === "env" ? "env" : "yaml", () => (dirty = true))]);
	}
	form.querySelector<HTMLElement>("[data-issues]")?.setAttribute("hidden", "");
	form.addEventListener("submit", () => {
		submitting = true;
		for (const [textarea, view] of views) textarea.value = view.state.doc.toString();
	});
	addEventListener("beforeunload", (e) => {
		if (dirty && !submitting) e.preventDefault();
	});
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
