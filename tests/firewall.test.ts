import { afterAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Firewall, readListeners } from "../src/agent/firewall.ts";
import { verdict } from "../src/controller/firewall.ts";
import { checkPolicy, checkSource, covers, parseRules, REMOVE_TABLE, renderRules, type FirewallPolicy } from "../src/shared/firewall.ts";
import { FakeNft } from "./fake-nft.ts";

const root = mkdtempSync(join(tmpdir(), "dm-fw-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("sources are IPv4 or IPv6 addresses or networks", () => {
	expect(checkSource("10.0.0.0/8")).toBe("10.0.0.0/8");
	expect(checkSource("192.168.1.5")).toBe("192.168.1.5");
	expect(checkSource("2001:DB8::/32")).toBe("2001:db8::/32");
	expect(checkSource("::1")).toBe("::1");
	for (const bad of ["300.1.1.1", "10.0.0.0/33", "1.2.3", "2001:db8::/129", "1::2::3", "host.example"]) expect(checkSource(bad)).toBeNull();
});

test("rules are read line by line with clear errors", () => {
	const { rules, errors } = parseRules(
		"# comment\n\nallow tcp 22 from 10.0.0.0/8 to host  # lan\ndeny any 5432,6379\nallow udp 60000-61000 from any to containers\n",
	);
	expect(errors).toEqual([]);
	expect(rules.map((r) => [r.action, r.protocol, r.ports, r.source, r.scope, r.comment, r.line])).toEqual([
		["allow", "tcp", [[22, 22]], "10.0.0.0/8", "host", "lan", 3],
		[
			"deny",
			"any",
			[
				[5432, 5432],
				[6379, 6379],
			],
			null,
			"containers",
			null,
			4,
		],
		["allow", "udp", [[60000, 61000]], null, "containers", null, 5],
	]);
	expect(parseRules("allow tcp 22 from 10.0.0.0/8 to space").errors[0]!.message).toBe('Line 1: "to" is followed by host or containers.');
	expect(covers(rules[1]!, 6379, "tcp")).toBe(true);
	expect(covers(rules[2]!, 60500, "tcp")).toBe(false);
	expect(checkPolicy({ rules: "", hostDefault: "drop", containerDefault: "x", sshPort: "70000" }).errors).toEqual([
		"The SSH port is a number from 1 to 65535, or 0.",
	]);
});

const sample = checkPolicy({
	rules:
		"allow tcp 22 from 10.0.0.0/8 to host\nallow any 53 from 2001:db8::/32 to host\ndeny tcp 80,8000-8100 to containers\nallow udp 51820 from 192.168.1.0/24\n",
	hostDefault: "drop",
	containerDefault: "drop",
	sshPort: "2222",
}).policy!;

test("rendering replaces one table and keeps loopback, replies, SSH and container networks open", () => {
	expect(renderRules(sample).split("\n")).toEqual([
		"table inet dockermanager {}",
		"delete table inet dockermanager",
		"table inet dockermanager {",
		"\tchain input {",
		"\t\ttype filter hook input priority filter; policy accept;",
		'\t\tiifname "lo" accept',
		"\t\tct state established,related accept",
		"\t\tmeta l4proto { icmp, ipv6-icmp } accept",
		'\t\ttcp dport 2222 counter accept comment "keep ssh"',
		'\t\ttcp dport 22 ip saddr 10.0.0.0/8 counter accept comment "line 1"',
		'\t\tmeta l4proto { tcp, udp } th dport 53 ip6 saddr 2001:db8::/32 counter accept comment "line 2"',
		'\t\tiifname "docker*" accept',
		'\t\tiifname "br-*" accept',
		'\t\tiifname "podman*" accept',
		'\t\tiifname "cni-*" accept',
		'\t\tcounter drop comment "default"',
		"\t}",
		"\tchain forward {",
		"\t\ttype filter hook forward priority filter; policy accept;",
		"\t\tct state established,related accept",
		'\t\tmeta l4proto tcp ct original proto-dst { 80, 8000-8100 } ct status dnat counter drop comment "line 3"',
		'\t\tmeta l4proto udp ct original proto-dst 51820 ct status dnat ip saddr 192.168.1.0/24 counter accept comment "line 4"',
		'\t\tct state new ct status dnat counter drop comment "default"',
		"\t}",
		"}",
		"",
	]);
	const open = renderRules(checkPolicy({ rules: "", hostDefault: "accept", containerDefault: "accept", sshPort: "22" }).policy!);
	expect(open).not.toContain("drop");
	expect(open).not.toContain("keep ssh");
});

// Loads the rules into a real kernel, in a network namespace of its own, when the system allows unprivileged namespaces.
const canNamespace = Bun.which("nft") !== null && Bun.which("unshare") !== null && Bun.spawnSync(["unshare", "-rn", "nft", "list", "tables"]).exitCode === 0;
test.skipIf(!canNamespace)("the rendered rules load in nftables, and loading twice replaces them", async () => {
	const file = join(root, "rules.nft");
	await writeFile(file, renderRules(sample));
	await writeFile(join(root, "remove.nft"), REMOVE_TABLE);
	const script = `nft -f ${file} && nft -f ${file} && nft list table inet dockermanager && nft -f ${join(root, "remove.nft")} && nft list tables | wc -l`;
	const proc = Bun.spawnSync(["unshare", "-rn", "sh", "-c", script]);
	const out = proc.stdout.toString();
	expect(`${proc.exitCode} ${proc.stderr.toString()}`).toBe("0 ");
	expect(out.match(/comment "line 3"/g)).toHaveLength(1);
	expect(out).toContain("ct original proto-dst { 80, 8000-8100 }");
	expect(out.trim().endsWith("0")).toBe(true);
});

test("verdicts read like a sentence", () => {
	const { rules } = parseRules("allow tcp 5432 from 10.0.0.0/8\ndeny tcp 5432\ndeny tcp 6379 from 1.2.3.4\n");
	expect(verdict(rules, "containers", 5432, "tcp", "accept")).toEqual({ text: "allowed from 10.0.0.0/8, otherwise blocked", open: "some", lines: [1, 2] });
	expect(verdict(rules, "containers", 6379, "tcp", "accept")).toEqual({ text: "blocked from 1.2.3.4, otherwise open", open: "some", lines: [3] });
	expect(verdict(rules, "containers", 80, "tcp", "drop")).toEqual({ text: "blocked by default", open: "none", lines: [] });
	expect(verdict(rules, "host", 5432, "tcp", "accept").open).toBe("all");
});

describe("the agent's firewall", () => {
	const policy = (text: string): FirewallPolicy => checkPolicy({ rules: text, hostDefault: "accept", containerDefault: "accept", sshPort: "22" }).policy!;
	let clock = 1_000_000;

	test("tells what the host has", async () => {
		const nft = new FakeNft();
		const fw = new Firewall(nft.exec, join(root, "z.json"), () => clock);
		expect(await fw.backend()).toEqual({ nft: true, version: "1.1.3", permitted: true, tables: ["ip filter", "ip nat", "inet firewalld"] });
		nft.root = false;
		expect((await fw.backend()).permitted).toBe(false);
		await expect(fw.apply(policy("deny tcp 5432"), 90)).rejects.toThrow("must run as root");
		nft.installed = false;
		expect(await fw.backend()).toEqual({ nft: false, version: null, permitted: false, tables: [] });
	});

	test("applies, waits for a keep, keeps, and counts matches", async () => {
		const nft = new FakeNft();
		const fw = new Firewall(nft.exec, join(root, "a.json"), () => clock);
		const { token, pendingUntil } = await fw.apply(policy("deny tcp 5432\nallow tcp 80"), 90);
		expect(pendingUntil).toBe(clock + 90_000);
		expect(nft.table).toContain('ct original proto-dst 5432 ct status dnat counter drop comment "line 1"');
		expect(fw.status()).toMatchObject({ managed: true, pendingUntil, pendingToken: token });
		expect(await fw.confirm("wrong")).toBe(false);
		expect(await fw.confirm(token)).toBe(true);
		expect(fw.status()).toMatchObject({ managed: true, pendingUntil: null });
		nft.packets = 7;
		expect(await fw.hits()).toEqual({ "line 1": 7, "line 2": 7 });
		fw.stop();
	});

	test("goes back to the previous rules when not kept, also across a restart", async () => {
		const nft = new FakeNft();
		const file = join(root, "b.json");
		const fw = new Firewall(nft.exec, file, () => clock);
		const first = await fw.apply(policy("deny tcp 5432"), 90);
		await fw.confirm(first.token);
		await fw.apply(policy("deny tcp 1-65535 to host"), 90);
		fw.stop();
		nft.wipe();
		clock += 91_000;
		let event = "";
		const again = new Firewall(nft.exec, file, () => clock);
		again.onEvent = (e) => (event = e);
		await again.start();
		expect(event).toBe("reverted");
		expect(nft.table).toContain("proto-dst 5432");
		expect(nft.table).not.toContain("1-65535");
		expect(again.status()).toMatchObject({ managed: true, pendingUntil: null });
		again.stop();
	});

	test("undoing the very first rules removes the table", async () => {
		const nft = new FakeNft();
		const fw = new Firewall(nft.exec, join(root, "c.json"), () => clock);
		const { token } = await fw.apply(policy("deny tcp 22 to host"), 90);
		expect(await fw.revert(token)).toBe(true);
		expect(nft.table).toBeNull();
		expect(nft.scripts.at(-1)).toBe(REMOVE_TABLE);
		expect(fw.status().managed).toBe(false);
		fw.stop();
	});

	test("rules refused by nft leave the old ones in place", async () => {
		const nft = new FakeNft();
		const fw = new Firewall(nft.exec, join(root, "d.json"), () => clock);
		const ok = await fw.apply(policy("deny tcp 5432"), 90);
		await fw.confirm(ok.token);
		const before = nft.table;
		nft.fail = true;
		await expect(fw.apply(policy("deny tcp 80"), 90)).rejects.toThrow("nft refused the rules");
		expect(nft.table).toBe(before);
		expect(fw.status()).toMatchObject({ pendingUntil: null, lastError: expect.stringContaining("refused") });
		fw.stop();
	});

	test("a missing table comes back, and disabling removes it", async () => {
		const nft = new FakeNft();
		const fw = new Firewall(nft.exec, join(root, "e.json"), () => clock);
		const { token } = await fw.apply(policy("deny tcp 5432\nallow tcp 22 to host"), 90);
		await fw.confirm(token);
		expect(await fw.ensure()).toBe(false);
		nft.wipe();
		expect(await fw.ensure()).toBe(true);
		expect(nft.table).toContain('comment "line 2"');
		await fw.disable();
		expect(nft.table).toBeNull();
		expect(fw.status().managed).toBe(false);
		expect(await fw.ensure()).toBe(false);
		fw.stop();
	});
});

test("listeners come from /proc with their processes", async () => {
	const proc = join(root, "proc");
	mkdirSync(join(proc, "net"), { recursive: true });
	const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
	writeFileSync(
		join(proc, "net", "tcp"),
		head +
			"   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1111 1\n   1: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2222 1\n   2: 0100007F:1538 0200007F:9999 01 00000000:00000000 00:00000000 00000000     0        0 3333 1\n",
	);
	writeFileSync(
		join(proc, "net", "tcp6"),
		head +
			"   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4444 1\n",
	);
	writeFileSync(join(proc, "net", "udp"), head + "   0: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 5555 1\n");
	writeFileSync(join(proc, "net", "udp6"), head);
	mkdirSync(join(proc, "42", "fd"), { recursive: true });
	writeFileSync(join(proc, "42", "comm"), "sshd\n");
	symlinkSync("socket:[1111]", join(proc, "42", "fd", "3"));
	mkdirSync(join(proc, "77", "fd"), { recursive: true });
	writeFileSync(join(proc, "77", "comm"), "nginx\n");
	symlinkSync("socket:[4444]", join(proc, "77", "fd", "6"));
	expect(await readListeners(proc)).toEqual([
		{ protocol: "tcp", address: "0.0.0.0", port: 22, pid: 42, process: "sshd" },
		{ protocol: "udp", address: "0.0.0.0", port: 53, pid: null, process: null },
		{ protocol: "tcp", address: "::", port: 80, pid: 77, process: "nginx" },
		{ protocol: "tcp", address: "127.0.0.1", port: 5432, pid: null, process: null },
	]);
});
