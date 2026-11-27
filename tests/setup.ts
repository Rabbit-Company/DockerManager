import { afterAll, beforeAll } from "bun:test";

process.env.LOG_LEVEL = "0";
process.env.DOMAIN = "http://controller.test";
process.env.SETUP_TOKEN = "test-setup-token";
process.env.AGENT_REQUEST_TIMEOUT_MS = "2000";
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64url");

let stopPostgres: (() => Promise<void>) | null = null;

if (process.env.TEST_DATABASE === "postgres") {
	const { PGlite } = await import("@electric-sql/pglite");
	const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
	const port = 15_000 + Math.floor(Math.random() * 20_000);
	const db = await PGlite.create();
	const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
	await server.start();
	process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
	process.env.DATABASE_POOL_SIZE = "1";
	process.env.DATABASE_PREPARE = "false";
	stopPostgres = async () => {
		await server.stop();
		await db.close();
	};
} else {
	process.env.DATABASE_URL = "sqlite://:memory:";
}

const { connect, sql } = await import("../src/controller/db/index.ts");
const { migrate } = await import("../src/controller/db/migrate.ts");

beforeAll(async () => {
	await connect();
	await migrate();
});

afterAll(async () => {
	await sql.close({ timeout: 1 });
	await stopPostgres?.();
});
