import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document, type Node, type Pair, type YAMLMap } from "yaml";

export interface Issue {
	severity: "error" | "warning";
	message: string;
	line: number;
	/** Character offsets in the source, for the editor's underline. */
	from: number;
	to: number;
}

const TOP_LEVEL = new Set(["version", "name", "services", "networks", "volumes", "configs", "secrets", "include", "models"]);
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_LENGTH = 256 * 1024;

export const COMPOSE_TEMPLATE = `services:
  app:
    image: nginx:1.27
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:80"
`;

export function checkStackName(value: string): { ok: true; value: string } | { ok: false; error: string } {
	const name = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name))
		return { ok: false, error: "Use 1 to 63 lowercase letters, digits, dashes or underscores, starting with a letter or digit." };
	return { ok: true, value: name };
}

function keyOf(pair: Pair): string | null {
	return isScalar(pair.key) ? String(pair.key.value) : null;
}

function mapKeys(node: unknown): Set<string> {
	const out = new Set<string>();
	if (isMap(node))
		for (const pair of node.items) {
			const key = keyOf(pair);
			if (key !== null) out.add(key);
		}
	return out;
}

/** A volume source that is a name rather than a path, so it must be declared under volumes. */
function namedVolume(source: string): boolean {
	return source.length > 0 && !/^[./~$]/.test(source) && !source.includes("/") && !/^[A-Za-z]:\\/.test(source);
}

/**
 * Fast checks for the editor and for saving: valid YAML, a services map, and
 * references that point to something. The host runs `compose config` before
 * every deploy, which is the full check.
 */
export function checkCompose(source: string): Issue[] {
	const issues: Issue[] = [];
	const lines = new LineCounter();
	if (source.length > MAX_LENGTH) return [{ severity: "error", message: "The file is larger than 256 KB.", line: 1, from: 0, to: 0 }];
	const doc: Document = parseDocument(source, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
	const at = (node: Node | null | undefined, severity: Issue["severity"], message: string) => {
		const range = node?.range ?? [0, 0];
		issues.push({ severity, message, line: lines.linePos(range[0]).line, from: range[0], to: Math.max(range[0], range[1]) });
	};
	for (const e of doc.errors)
		issues.push({ severity: "error", message: e.message.split("\n")[0]!, line: lines.linePos(e.pos[0]).line, from: e.pos[0], to: e.pos[1] });
	for (const w of doc.warnings)
		issues.push({ severity: "warning", message: w.message.split("\n")[0]!, line: lines.linePos(w.pos[0]).line, from: w.pos[0], to: w.pos[1] });
	if (issues.some((i) => i.severity === "error")) return issues;

	const root = doc.contents;
	if (!isMap(root)) {
		at(root as Node, "error", "A compose file is a map with a services key at the top.");
		return issues;
	}
	for (const pair of root.items) {
		const key = keyOf(pair);
		if (key !== null && !TOP_LEVEL.has(key) && !key.startsWith("x-"))
			at(pair.key as Node, "warning", `Unknown top level key "${key}". Compose ignores it or refuses the file.`);
		if (key === "version") at(pair.key as Node, "warning", "The version key is obsolete and can be removed.");
	}
	const services = root.get("services", true) as Node | undefined;
	if (!isMap(services) || services.items.length === 0) {
		at(services ?? (root as Node), "error", "Add at least one service under services.");
		return issues;
	}
	const declaredVolumes = mapKeys(root.get("volumes", true));
	const declaredNetworks = mapKeys(root.get("networks", true));
	const serviceNames = mapKeys(services);

	for (const pair of (services as YAMLMap).items) {
		const name = keyOf(pair);
		if (name === null) continue;
		if (!SERVICE_NAME.test(name)) at(pair.key as Node, "error", `"${name}" is not a valid service name.`);
		const service = pair.value as Node;
		if (!isMap(service)) {
			at(service ?? (pair.key as Node), "error", `Service "${name}" must be a map.`);
			continue;
		}
		const keys = mapKeys(service);
		if (!keys.has("image") && !keys.has("build") && !keys.has("extends")) at(pair.key as Node, "error", `Service "${name}" needs an image or a build section.`);

		const volumes = service.get("volumes", true);
		if (isSeq(volumes)) {
			for (const item of volumes.items) {
				let source: string | null = null;
				if (isScalar(item) && typeof item.value === "string") source = item.value.split(":")[0] ?? null;
				else if (isMap(item) && item.get("type") === "volume" && typeof item.get("source") === "string") source = item.get("source") as string;
				if (source !== null && namedVolume(source) && !declaredVolumes.has(source)) {
					at(item as Node, "error", `Volume "${source}" is used here but not declared under the top level volumes key.`);
				}
			}
		}

		const networks = service.get("networks", true);
		const used = isSeq(networks) ? networks.items.map((n) => (isScalar(n) ? String(n.value) : "")) : [...mapKeys(networks)];
		for (const network of used) {
			if (network && network !== "default" && !declaredNetworks.has(network))
				at(networks as Node, "error", `Network "${network}" is used here but not declared under the top level networks key.`);
		}

		const depends = service.get("depends_on", true);
		const needs = isSeq(depends) ? depends.items.map((n) => (isScalar(n) ? String(n.value) : "")) : [...mapKeys(depends)];
		for (const other of needs) {
			if (other && !serviceNames.has(other)) at(depends as Node, "error", `Service "${name}" depends on "${other}", which does not exist.`);
		}

		const ports = service.get("ports", true);
		if (isSeq(ports)) {
			for (const item of ports.items) {
				if (
					isScalar(item) &&
					typeof item.value === "string" &&
					!/^(\[?[0-9a-fA-F.:]*\]?:)?(\d+(-\d+)?:)?\d+(-\d+)?(\/(tcp|udp|sctp))?$/.test(item.value) &&
					!item.value.includes("$")
				) {
					at(item as Node, "error", `"${item.value}" is not a port mapping. Use "8080:80", "127.0.0.1:8080:80" or "80".`);
				}
			}
		}
	}
	return issues.sort((a, b) => a.from - b.from);
}

export function hasErrors(issues: Issue[]): boolean {
	return issues.some((i) => i.severity === "error");
}

export interface EnvLine {
	key: string;
	value: string;
}

/** Reads a .env file as compose does: KEY=value lines, comments and blank lines skipped. */
export function parseEnv(source: string): { entries: EnvLine[]; errors: { line: number; message: string }[] } {
	const entries: EnvLine[] = [];
	const errors: { line: number; message: string }[] = [];
	source.split("\n").forEach((raw, i) => {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) return;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(line);
		if (!match) {
			errors.push({ line: i + 1, message: `Line ${i + 1} is not KEY=value.` });
			return;
		}
		entries.push({ key: match[1]!, value: match[2]!.trim() });
	});
	return { entries, errors };
}

/** Which keys a change of the .env file added, removed or changed. Values stay out of it. */
export function envChanges(before: string, after: string): { added: string[]; removed: string[]; changed: string[] } {
	const a = new Map(parseEnv(before).entries.map((e) => [e.key, e.value]));
	const b = new Map(parseEnv(after).entries.map((e) => [e.key, e.value]));
	return {
		added: [...b.keys()].filter((k) => !a.has(k)),
		removed: [...a.keys()].filter((k) => !b.has(k)),
		changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
	};
}
