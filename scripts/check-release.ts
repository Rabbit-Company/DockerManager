import { readFileSync } from "node:fs";
import { VERSION } from "../src/shared/version.ts";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (VERSION !== packageVersion || tag !== `v${VERSION}`) {
	throw new Error(`Release tag ${tag ?? "(missing)"}, package version ${packageVersion} and app version ${VERSION} must match.`);
}
