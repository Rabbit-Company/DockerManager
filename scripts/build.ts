import { chmodSync, copyFileSync, mkdirSync } from "node:fs";

const root = `${import.meta.dir}/..`;
mkdirSync(`${root}/dist`, { recursive: true });

async function bundle(entry: string): Promise<string> {
	const web = await Bun.build({ entrypoints: [`${root}/src/web/${entry}`], target: "browser", format: "esm", minify: true });
	if (!web.success) throw new Error(web.logs.map((l) => l.message).join("\n"));
	return web.outputs[0]!.text();
}

/** The build API takes the browser bundles as values, so their size is not limited like a command line argument. */
async function compile(entry: string, outfile: string, target: string, define: Record<string, string> = {}): Promise<void> {
	const result = await Bun.build({
		entrypoints: [`${root}/${entry}`],
		compile: { target, outfile: `${root}/${outfile}` },
		define,
		minify: true,
		sourcemap: "linked",
	} as Parameters<typeof Bun.build>[0]);
	if (!result.success) throw new Error(`Building ${outfile} failed: ${result.logs.map((l) => l.message).join("\n")}`);
	console.log(`Built ${outfile}`);
}

const client = await bundle("app.ts");
const editor = await bundle("editor.ts");
for (const arch of ["x64", "arm64"]) {
	await compile("src/controller/index.ts", `dist/controller-linux-${arch}`, `bun-linux-${arch}`, {
		CLIENT_BUNDLE: JSON.stringify(client),
		EDITOR_BUNDLE: JSON.stringify(editor),
	});
}
copyFileSync(`${root}/dist/controller-linux-${process.arch === "arm64" ? "arm64" : "x64"}`, `${root}/dist/controller`);
chmodSync(`${root}/dist/controller`, 0o755);
console.log("Built dist/controller");
await compile("src/agent/index.ts", "dist/agent-linux-x64", "bun-linux-x64");
await compile("src/agent/index.ts", "dist/agent-linux-arm64", "bun-linux-arm64");
