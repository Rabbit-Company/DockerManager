import { describe, expect, test } from "bun:test";
import { sql } from "../src/controller/db/index.ts";
import { createHost } from "../src/controller/db/hosts.ts";
import {
	createDeploy,
	createStack,
	finishDeploy,
	getDeploy,
	getVersion,
	interruptRunningDeploys,
	listVersions,
	saveVersion,
	stackIndex,
} from "../src/controller/db/stacks.ts";
import { decrypt, encrypt } from "../src/controller/lib/secrets.ts";

test("secrets round trip and refuse tampering", () => {
	const sealed = encrypt("DB_PASSWORD=hunter2\n");
	expect(sealed).not.toContain("hunter2");
	expect(decrypt(sealed)).toBe("DB_PASSWORD=hunter2\n");
	expect(encrypt("")).toBe("");
	const parts = sealed.split(".");
	parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("A") ? "BB" : "AA");
	expect(() => decrypt(parts.join("."))).toThrow();
	expect(encrypt("same")).not.toBe(encrypt("same"));
});

describe("stacks", () => {
	test("versions only grow when something changed, env is stored encrypted", async () => {
		const { host } = await createHost("stack-host");
		const stack = await createStack({
			hostId: host.id,
			name: "shop",
			directory: null,
			file: "compose.yaml",
			adopted: false,
			compose: "services: {}\n",
			env: "SECRET=hunter2\n",
			message: "Created",
			userId: null,
			deployed: false,
		});
		expect(stack).toMatchObject({ name: "shop", currentVersion: 1, deployedVersion: null, adopted: false });
		const [raw] = await sql`SELECT env_secret FROM stack_versions WHERE stack_id = ${stack.id}`;
		expect(raw.env_secret).not.toContain("hunter2");
		expect(await saveVersion(stack.id, { compose: "services: {}\n", env: "SECRET=hunter2\n", message: null, userId: null })).toBeNull();
		expect(await saveVersion(stack.id, { compose: "services: {}\n", env: "SECRET=other\n", message: "rotate", userId: null })).toBe(2);
		expect((await getVersion(stack.id, 2))?.env).toBe("SECRET=other\n");
		expect((await listVersions(stack.id)).map((v) => [v.number, v.message])).toEqual([
			[2, "rotate"],
			[1, "Created"],
		]);
		expect((await stackIndex()).get(host.id)?.get("shop")).toBe(stack.id);
		await expect(
			createStack({
				hostId: host.id,
				name: "shop",
				directory: null,
				file: "compose.yaml",
				adopted: false,
				compose: "",
				env: "",
				message: null,
				userId: null,
				deployed: false,
			}),
		).rejects.toThrow();
	});

	test("deploys left running are marked interrupted", async () => {
		const { host } = await createHost("deploy-host");
		const stack = await createStack({
			hostId: host.id,
			name: "app",
			directory: null,
			file: "compose.yaml",
			adopted: false,
			compose: "x",
			env: "",
			message: null,
			userId: null,
			deployed: false,
		});
		const done = await createDeploy(stack.id, 1, "deploy", null);
		await finishDeploy(done, "ok", "all good");
		const stuck = await createDeploy(stack.id, 1, "deploy", null);
		expect(await interruptRunningDeploys()).toBeGreaterThanOrEqual(1);
		expect((await getDeploy(stuck))?.status).toBe("interrupted");
		expect(await getDeploy(done)).toMatchObject({ status: "ok", output: "all good" });
	});
});
