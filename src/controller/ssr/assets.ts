import styles from "./styles.css" with { type: "text" };

declare const CLIENT_BUNDLE: string | undefined;
declare const EDITOR_BUNDLE: string | undefined;

export interface Asset {
	path: string;
	body: string;
	type: string;
}

function hash(text: string): string {
	return new Bun.CryptoHasher("blake2b256").update(text).digest("hex").slice(0, 12);
}

/** Compiled binaries carry the bundles through --define. A source checkout builds them on start. */
async function bundle(entry: string): Promise<string> {
	const result = await Bun.build({ entrypoints: [`${import.meta.dir}/../../web/${entry}`], target: "browser", format: "esm", minify: true });
	if (!result.success) throw new Error(`Bundling ${entry} failed: ${result.logs.map((l) => l.message).join("\n")}`);
	return await result.outputs[0]!.text();
}

const [script, editor] = await Promise.all([
	typeof CLIENT_BUNDLE === "string" ? CLIENT_BUNDLE : bundle("app.ts"),
	typeof EDITOR_BUNDLE === "string" ? EDITOR_BUNDLE : bundle("editor.ts"),
]);

export const assets = {
	css: { path: `/assets/styles-${hash(styles)}.css`, body: styles, type: "text/css; charset=utf-8" } as Asset,
	js: { path: `/assets/app-${hash(script)}.js`, body: script, type: "text/javascript; charset=utf-8" } as Asset,
	editor: { path: `/assets/editor-${hash(editor)}.js`, body: editor, type: "text/javascript; charset=utf-8" } as Asset,
};

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2563eb"/><path d="M7 18h18l-2.5 6h-13zM9 13h4v4H9zm5 0h4v4h-4zm5 0h4v4h-4zm-5-5h4v4h-4z" fill="#fff"/></svg>`;
