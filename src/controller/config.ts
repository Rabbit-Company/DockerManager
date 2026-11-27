import type { IpExtractionPreset } from "@rabbit-company/web-middleware/ip-extract";
import { Levels } from "@rabbit-company/web-middleware/logger";

export type DatabaseDialect = "sqlite" | "postgres";

function str(name: string, fallback: string): string {
	const value = process.env[name];
	if (typeof value !== "string" || value.trim().length === 0) return fallback;
	return value.trim();
}

function int(name: string, fallback: number): number {
	const value = process.env[name];
	if (typeof value !== "string" || value.trim().length === 0) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
	return parsed;
}

function detectDialect(url: string): DatabaseDialect {
	const scheme = url.split(":")[0]?.toLowerCase();
	if (scheme === "sqlite" || scheme === "file") return "sqlite";
	if (scheme === "postgres" || scheme === "postgresql") return "postgres";
	throw new Error(`Unsupported DATABASE_URL scheme "${scheme}". Use sqlite:// or postgres://`);
}

const databaseUrl = str("DATABASE_URL", "sqlite://./data/controller.sqlite");

export const config = {
	server: {
		port: int("PORT", 3000),
		hostname: str("BIND_ADDRESS", "0.0.0.0"),
		/** The address people and agents use, also used in join commands. */
		domain: str("DOMAIN", "http://localhost:3000").replace(/\/+$/, ""),
		trustProxy: str("TRUST_PROXY", "direct") as IpExtractionPreset,
	},
	database: {
		url: databaseUrl,
		dialect: detectDialect(databaseUrl),
		poolSize: int("DATABASE_POOL_SIZE", 10),
		prepare: str("DATABASE_PREPARE", "true") !== "false",
	},
	auth: {
		sessionDays: int("SESSION_DAYS", 14),
		/** Required on the first run setup page. Generated and logged when not set. */
		setupToken: str("SETUP_TOKEN", ""),
	},
	agents: {
		joinTokenMinutes: int("JOIN_TOKEN_MINUTES", 60),
		requestTimeoutMs: int("AGENT_REQUEST_TIMEOUT_MS", 30_000),
		/** Folder with compiled agent binaries served at /downloads/agent-linux-{x64,arm64}. */
		downloads: str("AGENT_DOWNLOADS", "./dist"),
	},
	metrics: {
		rawHours: int("METRICS_RAW_HOURS", 24),
		minuteDays: int("METRICS_MINUTE_DAYS", 14),
		hourDays: int("METRICS_HOUR_DAYS", 365),
	},
	updates: {
		checkHours: int("UPDATE_CHECK_HOURS", 6),
		/** Registries reached over plain HTTP, such as a local registry at 10.0.0.5:5000. */
		insecure: str("REGISTRY_INSECURE", "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
		/** Extra authentication origins, as registry=https://auth.example.com pairs. */
		authRealms: new Map(
			str("REGISTRY_AUTH_REALMS", "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
				.map((s) => {
					const at = s.indexOf("=");
					if (at <= 0) throw new Error(`Bad REGISTRY_AUTH_REALMS entry: ${s}`);
					return [s.slice(0, at), s.slice(at + 1)] as const;
				}),
		),
		/** Seconds a deploy waits for containers to run and pass their healthchecks. */
		healthTimeout: int("HEALTH_TIMEOUT_SECONDS", 120),
	},
	secrets: {
		/** 32 bytes in base64url. When empty, a key is created in the key file on first use. */
		key: str("SECRETS_KEY", ""),
		keyFile: str("SECRETS_KEY_FILE", "./data/secret.key"),
	},
	logging: {
		level: int("LOG_LEVEL", Levels.INFO),
	},
};
