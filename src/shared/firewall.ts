export type FirewallScope = "host" | "containers";

export interface FirewallRule {
	action: "allow" | "deny";
	protocol: "tcp" | "udp" | "any";
	/** Single ports and ranges, such as [[22, 22], [8000, 8100]]. */
	ports: [number, number][];
	/** CIDR or null for anywhere. */
	source: string | null;
	scope: FirewallScope;
	comment: string | null;
	line: number;
}

export interface FirewallPolicy {
	rules: FirewallRule[];
	/** What happens to traffic to the host that no rule matches. */
	hostDefault: "accept" | "drop";
	/** What happens to new connections to published container ports that no rule matches. */
	containerDefault: "accept" | "drop";
	/** Kept open when the host default is drop, so a mistake cannot lock out SSH. 0 turns this off. */
	sshPort: number;
}

export const TABLE = "dockermanager";

export const RULES_EXAMPLE = `# action protocol ports [from source] [to host|containers] [# note]
allow tcp 22 from 10.0.0.0/8 to host        # SSH from the LAN
deny tcp 5432 to containers                 # keep the database private
allow tcp 80,443 to containers
`;

function ipv4(value: string): boolean {
	const parts = value.split(".");
	return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function ipv6(value: string): boolean {
	if (!/^[0-9a-fA-F:]+$/.test(value) || !value.includes(":")) return false;
	const halves = value.split("::");
	if (halves.length > 2) return false;
	const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
	if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
	return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

export function family(source: string | null): 4 | 6 | null {
	if (source === null) return null;
	return source.includes(":") ? 6 : 4;
}

/** A plain address or a network in CIDR notation, IPv4 or IPv6. */
export function checkSource(value: string): string | null {
	const [address, prefix, ...rest] = value.split("/");
	if (rest.length > 0 || !address) return null;
	const v6 = address.includes(":");
	if (v6 ? !ipv6(address) : !ipv4(address)) return null;
	if (prefix !== undefined) {
		if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (v6 ? 128 : 32)) return null;
		return `${address.toLowerCase()}/${Number(prefix)}`;
	}
	return address.toLowerCase();
}

function parsePorts(text: string): [number, number][] | null {
	const out: [number, number][] = [];
	for (const part of text.split(",")) {
		const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
		if (!m) return null;
		const from = Number(m[1]);
		const to = m[2] ? Number(m[2]) : from;
		if (from < 1 || to > 65535 || from > to) return null;
		out.push([from, to]);
	}
	return out.length > 0 && out.length <= 15 ? out : null;
}

export interface ParseResult {
	rules: FirewallRule[];
	errors: { line: number; message: string }[];
}

/** Reads rules written one per line: action, protocol, ports, then optionally "from" a source and "to" host or containers. */
export function parseRules(text: string): ParseResult {
	const rules: FirewallRule[] = [];
	const errors: { line: number; message: string }[] = [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 500) return { rules, errors: [{ line: 501, message: "Keep it to 500 lines." }] };
	lines.forEach((raw, i) => {
		const line = i + 1;
		const hash = raw.indexOf("#");
		const comment =
			hash === -1
				? null
				: raw
						.slice(hash + 1)
						.trim()
						.slice(0, 120) || null;
		const words = (hash === -1 ? raw : raw.slice(0, hash))
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w);
		if (words.length === 0) return;
		const fail = (message: string) => errors.push({ line, message: `Line ${line}: ${message}` });
		const [action, protocol, ports, ...rest] = words;
		if (action !== "allow" && action !== "deny") return fail(`start with allow or deny, not "${action}".`);
		if (protocol !== "tcp" && protocol !== "udp" && protocol !== "any") return fail("the second word is tcp, udp or any.");
		const parsedPorts = ports === undefined ? null : parsePorts(ports);
		if (!parsedPorts) return fail("give ports like 22, 80,443 or 8000-8100, up to 15 of them.");
		let source: string | null = null;
		let scope: FirewallScope = "containers";
		for (let k = 0; k < rest.length; k += 2) {
			const key = rest[k];
			const value = rest[k + 1];
			if (value === undefined) return fail(`"${key}" needs a value.`);
			if (key === "from") {
				if (value === "any" || value === "anywhere") source = null;
				else {
					source = checkSource(value);
					if (!source) return fail(`"${value}" is not an address or network like 10.0.0.0/8.`);
				}
			} else if (key === "to") {
				if (value === "host") scope = "host";
				else if (value === "containers" || value === "container") scope = "containers";
				else return fail('"to" is followed by host or containers.');
			} else return fail(`"${key}" is not understood. Use from and to.`);
		}
		rules.push({ action, protocol, ports: parsedPorts, source, scope, comment, line });
	});
	return { rules, errors };
}

export function formatPorts(ports: [number, number][]): string {
	return ports.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(",");
}

export function formatRule(r: FirewallRule): string {
	const words = [r.action, r.protocol, formatPorts(r.ports)];
	if (r.source) words.push("from", r.source);
	words.push("to", r.scope);
	return words.join(" ") + (r.comment ? `  # ${r.comment}` : "");
}

/** Does a rule cover this port and protocol? Used to tell people what a rule does to the ports they have. */
export function covers(r: FirewallRule, port: number, protocol: string): boolean {
	if (r.protocol !== "any" && r.protocol !== protocol) return false;
	return r.ports.some(([a, b]) => port >= a && port <= b);
}

function portSet(ports: [number, number][]): string {
	const list = ports.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`));
	return list.length === 1 ? list[0]! : `{ ${list.join(", ")} }`;
}

function sourceMatch(source: string | null): string {
	if (source === null) return "";
	return `${family(source) === 6 ? "ip6" : "ip"} saddr ${source}`;
}

/** Interfaces of container networks: Docker, Podman and CNI bridges. */
const CONTAINER_IFACES = ["docker*", "br-*", "podman*", "cni-*"];

/**
 * The input for `nft -f` that replaces the table this program owns, in one
 * transaction, and nothing else. Each table sees every packet and a drop in any
 * table is final, so these rules hold whatever Docker, Podman, ufw or firewalld
 * do in their own tables. Container rules look at the port a connection was
 * made to before it was translated, and only at translated (published)
 * connections, so traffic between containers is never touched.
 */
export function renderRules(policy: FirewallPolicy): string {
	const input: string[] = ['iifname "lo" accept', "ct state established,related accept", "meta l4proto { icmp, ipv6-icmp } accept"];
	const forward: string[] = ["ct state established,related accept"];
	if (policy.hostDefault === "drop" && policy.sshPort > 0) input.push(`tcp dport ${policy.sshPort} counter accept comment "keep ssh"`);
	for (const r of policy.rules) {
		const verdict = r.action === "allow" ? "accept" : "drop";
		const note = `comment "line ${r.line}"`;
		const ports = portSet(r.ports);
		const proto = r.protocol === "any" ? "{ tcp, udp }" : r.protocol;
		const src = sourceMatch(r.source);
		if (r.scope === "host") {
			const match = r.protocol === "any" ? `meta l4proto ${proto} th dport ${ports}` : `${r.protocol} dport ${ports}`;
			input.push([match, src, "counter", verdict, note].filter((p) => p).join(" "));
		} else {
			forward.push([`meta l4proto ${proto} ct original proto-dst ${ports} ct status dnat`, src, "counter", verdict, note].filter((p) => p).join(" "));
		}
	}
	if (policy.hostDefault === "drop") {
		for (const name of CONTAINER_IFACES) input.push(`iifname "${name}" accept`);
		input.push('counter drop comment "default"');
	}
	if (policy.containerDefault === "drop") forward.push('ct state new ct status dnat counter drop comment "default"');
	const chain = (name: string, hook: string, rules: string[]) =>
		[`\tchain ${name} {`, `\t\ttype filter hook ${hook} priority filter; policy accept;`, ...rules.map((r) => `\t\t${r}`), "\t}"].join("\n");
	return [
		`table inet ${TABLE} {}`,
		`delete table inet ${TABLE}`,
		`table inet ${TABLE} {`,
		chain("input", "input", input),
		chain("forward", "forward", forward),
		"}",
		"",
	].join("\n");
}

/** Removes the table, also when it does not exist. */
export const REMOVE_TABLE = `table inet ${TABLE} {}\ndelete table inet ${TABLE}\n`;

export function checkPolicy(input: { rules: string; hostDefault: string; containerDefault: string; sshPort: string }): {
	policy?: FirewallPolicy;
	errors: string[];
} {
	const parsed = parseRules(input.rules);
	const errors = parsed.errors.map((e) => e.message);
	const ssh = input.sshPort.trim() === "" ? 22 : Number(input.sshPort);
	if (!Number.isInteger(ssh) || ssh < 0 || ssh > 65535) errors.push("The SSH port is a number from 1 to 65535, or 0.");
	if (errors.length > 0) return { errors };
	return {
		errors,
		policy: {
			rules: parsed.rules,
			hostDefault: input.hostDefault === "drop" ? "drop" : "accept",
			containerDefault: input.containerDefault === "drop" ? "drop" : "accept",
			sshPort: ssh,
		},
	};
}
