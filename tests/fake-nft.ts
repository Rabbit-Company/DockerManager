import { TABLE } from "../src/shared/firewall.ts";

/** Stands in for the nft tool: keeps the script that made our table and the other tables. */
export class FakeNft {
	installed = true;
	root = true;
	fail = false;
	table: string | null = null;
	others = ["ip filter", "ip nat", "inet firewalld"];
	scripts: string[] = [];
	packets = 0;

	/** What a restart of nftables.service does to our table. */
	wipe(): void {
		this.table = null;
	}

	exec = async (cmd: string[], stdin?: string): Promise<{ code: number; output: string }> => {
		const args = cmd.slice(1).join(" ");
		if (!this.installed) return { code: 127, output: "nft: not found" };
		if (args === "--version") return { code: 0, output: "nftables v1.1.3 (Commodore Bullmoose #4)" };
		if (!this.root) return { code: 1, output: "Error: Operation not permitted" };
		if (args === "list tables") return { code: 0, output: [...this.others, ...(this.table ? [`inet ${TABLE}`] : [])].map((t) => `table ${t}`).join("\n") };
		if (args === `list table inet ${TABLE}`) return this.table ? { code: 0, output: this.table } : { code: 1, output: "Error: No such file or directory" };
		if (args === `-j list table inet ${TABLE}`) {
			if (!this.table) return { code: 1, output: "Error: No such file or directory" };
			const rules = [...this.table.matchAll(/counter (?:accept|drop) comment "([^"]+)"/g)].map((m) => ({
				rule: { comment: m[1], expr: [{ counter: { packets: this.packets, bytes: 0 } }] },
			}));
			return { code: 0, output: JSON.stringify({ nftables: [{ metainfo: {} }, ...rules] }) };
		}
		if (args === "-f -") {
			if (this.fail) return { code: 1, output: "/dev/stdin:5:3-12: Error: syntax error" };
			const script = stdin ?? "";
			this.scripts.push(script);
			this.table = script.includes(`table inet ${TABLE} {\n`) ? script : null;
			return { code: 0, output: "" };
		}
		return { code: 2, output: `unexpected: ${args}` };
	};
}
