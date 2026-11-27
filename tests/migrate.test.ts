import { expect, test } from "bun:test";
import { sql } from "../src/controller/db/index.ts";
import { migrations } from "../src/controller/db/migrate.ts";

test("every migration is applied", async () => {
	const rows: { name: string }[] = await sql`SELECT name FROM migrations ORDER BY name`;
	expect(rows.map((r) => r.name)).toEqual(migrations().map((m) => m.name));
	expect(migrations()).toHaveLength(10);
});
