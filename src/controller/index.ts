import { Web } from "@rabbit-company/web";
import { bodyLimit } from "@rabbit-company/web-middleware/body-limit";
import { ipExtract } from "@rabbit-company/web-middleware/ip-extract";
import { logger as loggerMiddleware } from "@rabbit-company/web-middleware/logger";
import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { APP_NAME, VERSION } from "../shared/version.ts";
import { NO_STORE, sameOrigin } from "./auth.ts";
import { STYLE_NONCE_HEADER } from "./security.ts";
import { config } from "./config.ts";
import { saveFacts, touchHost } from "./db/hosts.ts";
import { connect, disconnect } from "./db/index.ts";
import { migrate } from "./db/migrate.ts";
import { MetricsStore } from "./db/metrics.ts";
import { deleteExpiredSessions } from "./db/users.ts";
import { Deployments } from "./deployments.ts";
import { interruptRunningDeploys } from "./db/stacks.ts";
import { Hub } from "./hub.ts";
import { ApiError } from "./lib/errors.ts";
import { logger } from "./lib/logger.ts";
import { agentRoutes } from "./routes/api/agent.ts";
import { accountRoutes, setupToken } from "./routes/web/account.ts";
import { needsSetup } from "./routes/web/common.ts";
import { hostRoutes } from "./routes/web/hosts.ts";
import { stackRoutes } from "./routes/web/stacks.ts";
import { updateRoutes } from "./routes/web/updates.ts";
import { RegistryClient } from "./registry.ts";
import { registryCredentials } from "./db/updates.ts";
import { Updates } from "./updates.ts";
import { Backups } from "./backups.ts";
import { Alerting } from "./alerts/engine.ts";
import { setFiring } from "./alerts/state.ts";
import { alertRoutes } from "./routes/web/alerts.ts";
import { FirewallManager } from "./firewall.ts";
import { firewallRoutes } from "./routes/web/firewall.ts";
import { countFiring, pruneAlerts } from "./db/alerts.ts";
import { listAllStacks } from "./db/stacks.ts";
import { backupRoutes } from "./routes/web/backups.ts";
import { interruptRunningBackups } from "./db/backups.ts";
import { assets, FAVICON } from "./ssr/assets.ts";
import { errorPage } from "./ssr/pages/account.ts";
import type { AppMiddleware, AppState } from "./types.ts";

const csp = (styleNonce: string | null) =>
	[
		"default-src 'self'",
		"img-src 'self' data:",
		styleNonce && /^[A-Za-z0-9_-]{16,64}$/.test(styleNonce) ? `style-src 'self' 'nonce-${styleNonce}'` : "style-src 'self'",
		"script-src 'self'",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"object-src 'none'",
	].join("; ");

function securityHeaders(): AppMiddleware {
	return async (_ctx, next) => {
		const response = await next();
		if (response instanceof Response && response.status !== 101) {
			try {
				response.headers.set("X-Content-Type-Options", "nosniff");
				response.headers.set("Referrer-Policy", "same-origin");
				const nonce = response.headers.get(STYLE_NONCE_HEADER);
				response.headers.delete(STYLE_NONCE_HEADER);
				if ((response.headers.get("Content-Type") ?? "").startsWith("text/html")) {
					response.headers.set("Content-Security-Policy", csp(nonce));
					response.headers.set("X-Frame-Options", "DENY");
				}
			} catch {}
		}
		return response;
	};
}

function wantsJson(req: Request): boolean {
	return new URL(req.url).pathname.startsWith("/api/") || (req.headers.get("Accept") ?? "").includes("application/json");
}

function errorResponse(err: ApiError, req: Request): Response {
	if (wantsJson(req)) return Response.json({ error: err.code, message: err.message }, { status: err.status, headers: { "Cache-Control": NO_STORE } });
	return new Response(errorPage(err.status, err.message), {
		status: err.status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE },
	});
}

export function createStore(): MetricsStore {
	return new MetricsStore(config.metrics);
}

export function createHub(publish: (topic: string, data: string) => void = () => {}, store: MetricsStore = createStore()): Hub {
	return new Hub(
		{
			publish,
			saveFacts,
			touch: touchHost,
			metrics: (hostId, samples) => store.add(hostId, samples),
			warn: (message) => logger.warn(message),
		},
		config.agents.requestTimeoutMs,
	);
}

/** Lets failed deploys and backups and new update offers raise alerts. */
export function connectAlerts(alerting: Alerting, deployments: Deployments, backups: Backups, updates: Updates): void {
	const failed = (what: string) => (err: Error) => logger.warn(`Alert for ${what} failed: ${err.message}`);
	deployments.onFinished = (run) => void alerting.deployFinished(run).catch(failed("a deploy"));
	backups.onFinished = (run) => void alerting.backupFinished(run).catch(failed("a backup"));
	updates.onChecked = () =>
		void (async () => {
			const offers = [];
			for (const stack of await listAllStacks()) {
				for (const u of await updates.forStack(stack)) {
					if (u.offer && u.editable) offers.push({ stack, service: u.service, current: u.ref?.tag ?? u.written, tag: u.offer.tag, level: u.offer.level });
				}
			}
			await alerting.updatesChecked(offers);
		})().catch(failed("updates"));
}

export function createUpdates(hub: Hub, deployments: Deployments): Updates {
	const registry = new RegistryClient(registryCredentials, new Set(config.updates.insecure), fetch, config.updates.authRealms);
	return new Updates(registry, hub, deployments, config.updates.healthTimeout);
}

export function createApp(
	hub: Hub,
	deployments: Deployments = new Deployments(hub, config.updates.healthTimeout),
	updates: Updates = createUpdates(hub, deployments),
	backups: Backups = new Backups(hub, deployments),
	alerting: Alerting = new Alerting(hub, config.server.domain),
	firewall: FirewallManager = new FirewallManager(hub),
): Web<AppState> {
	firewall.onReverted = (hostId, detail) => void alerting.firewallReverted(hostId, detail).catch(() => {});
	connectAlerts(alerting, deployments, backups, updates);
	const app = new Web<AppState>();
	app.use(ipExtract(config.server.trustProxy));
	app.use(securityHeaders());
	app.use(
		loggerMiddleware<AppState>({ logger, preset: "standard", includeRemoteAddress: true, excludePaths: ["/health", /^\/assets\//, "/ws", "/api/agent/ws"] }),
	);
	app.use(async (ctx, next) => {
		try {
			return await next();
		} catch (err) {
			if (err instanceof ApiError) return errorResponse(err, ctx.req);
			throw err;
		}
	});
	app.use(sameOrigin());
	app.use(bodyLimit<AppState>({ maxSize: "64kb", skip: (ctx) => ctx.req.method === "GET" || ctx.req.method === "HEAD" }));
	const posts = (windowMs: number, max: number) =>
		rateLimit<AppState>({
			windowMs,
			max,
			statusCode: 429,
			message: "Too many attempts. Wait a few minutes and try again.",
			skip: (ctx) => ctx.req.method !== "POST",
		});
	app.use("/login", posts(600_000, 20));
	app.use("/login/2fa", posts(600_000, 10));
	app.use("/setup", posts(600_000, 10));
	app.use("/api/agent/enroll", posts(600_000, 30));

	app.get("/health", () => Response.json({ ok: true, version: VERSION, agents: hub.onlineCount() }, { headers: { "Cache-Control": NO_STORE } }));
	app.get("/favicon.svg", () => new Response(FAVICON, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }));
	for (const asset of [assets.css, assets.js, assets.editor]) {
		app.get(asset.path, () => new Response(asset.body, { headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000, immutable" } }));
	}

	agentRoutes(app, hub);
	accountRoutes(app);
	stackRoutes(app, hub, deployments, updates, backups);
	backupRoutes(app, hub, backups);
	alertRoutes(app, hub, alerting);
	firewallRoutes(app, hub, firewall);
	updateRoutes(app, hub, updates);
	hostRoutes(app, hub, updates, firewall);

	app.onNotFound((ctx) => {
		if (wantsJson(ctx.req)) return ctx.json({ error: "not_found", message: "Unknown endpoint." }, 404);
		return ctx.html(errorPage(404, "This page does not exist."), 404);
	});
	app.onError((err, ctx) => {
		if (err instanceof ApiError) return errorResponse(err, ctx.req);
		logger.error(`Unhandled error: ${err.message}`, { stack: err.stack, url: ctx.req.url });
		if (wantsJson(ctx.req)) return ctx.json({ error: "internal_error", message: "Something went wrong." }, 500);
		return ctx.html(errorPage(500, "Something went wrong on our side."), 500);
	});
	return app;
}

if (import.meta.main) {
	await connect();
	await migrate();
	const interrupted = (await interruptRunningDeploys()) + (await interruptRunningBackups());
	if (interrupted > 0) logger.warn(`Marked ${interrupted} job(s) as interrupted, the controller stopped while they ran`);
	let server: { publish(topic: string, data: string): unknown } | null = null;
	const store = createStore();
	const hub = createHub((topic, data) => server?.publish(topic, data), store);
	const deployments = new Deployments(hub, config.updates.healthTimeout);
	const updates = createUpdates(hub, deployments);
	await updates.load();
	const backups = new Backups(hub, deployments);
	const alerting = new Alerting(hub, config.server.domain);
	setFiring(await countFiring());
	const app = createApp(hub, deployments, updates, backups, alerting);
	server = await app.listen({
		port: config.server.port,
		hostname: config.server.hostname,
		onListen: ({ port, hostname }) => logger.info(`${APP_NAME} ${VERSION} listening on http://${hostname}:${port}, public address ${config.server.domain}`),
	});
	if (await needsSetup()) setupToken();
	const failed = (what: string) => (err: Error) => logger.error(`${what} failed: ${err.message}`);
	const timers = [
		setInterval(() => void deleteExpiredSessions().catch(failed("Session cleanup")), 3_600_000),
		setInterval(() => void store.flush().catch(failed("Writing metrics")), 2000),
		setInterval(() => void store.rollup().catch(failed("Metrics rollup")), 60_000),
		setInterval(() => void store.prune().catch(failed("Metrics cleanup")), 3_600_000),
		setInterval(() => void backups.tick().catch(failed("Scheduled backups")), 60_000),
		setInterval(() => void alerting.evaluate().catch(failed("Alert check")), 30_000),
		setInterval(() => void pruneAlerts().catch(failed("Alert cleanup")), 86_400_000),
		setInterval(() => {
			const due = updates.lastRun === null || Date.now() - Date.parse(updates.lastRun) >= config.updates.checkHours * 3_600_000;
			if (!due || updates.running) return;
			void updates
				.check()
				.then(() => updates.runAutomatic())
				.then((n) => n > 0 && logger.info(`Started ${n} automatic update(s)`))
				.catch(failed("Update check"));
		}, 60_000),
	];

	const shutdown = async (signal: string) => {
		logger.info(`Received ${signal}, shutting down`);
		for (const timer of timers) clearInterval(timer);
		await store.flush().catch(() => {});
		await (server as unknown as { stop(): Promise<void> }).stop();
		await disconnect();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
