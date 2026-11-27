import { expect, test } from "bun:test";
import { ago, bytes, portRows } from "../src/controller/ssr/format.ts";

test("ports merge IPv4 and IPv6 bindings and tell public from local", () => {
	const rows = portRows([
		{ privatePort: 80, publicPort: 8080, ip: "0.0.0.0", type: "tcp" },
		{ privatePort: 80, publicPort: 8080, ip: "::", type: "tcp" },
		{ privatePort: 5432, publicPort: 5432, ip: "127.0.0.1", type: "tcp" },
		{ privatePort: 443, publicPort: null, ip: null, type: "tcp" },
	]);
	expect(rows).toEqual([
		{ publicPort: 5432, privatePort: 5432, type: "tcp", addresses: ["127.0.0.1"], exposure: "local" },
		{ publicPort: 8080, privatePort: 80, type: "tcp", addresses: ["0.0.0.0", "::"], exposure: "public" },
		{ publicPort: null, privatePort: 443, type: "tcp", addresses: [], exposure: "internal" },
	]);
});

test("bytes and relative times read well", () => {
	expect(bytes(0)).toBe("0 B");
	expect(bytes(1536)).toBe("1.5 KB");
	expect(bytes(16 * 1024 ** 3)).toBe("16 GB");
	const now = Date.parse("2026-11-27T12:00:00Z");
	expect(ago("2026-11-27T11:59:50Z", now)).toBe("just now");
	expect(ago("2026-11-27T11:30:00Z", now)).toBe("30 min ago");
	expect(ago(null, now)).toBe("never");
});
