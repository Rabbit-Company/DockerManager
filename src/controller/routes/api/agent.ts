import type { Web } from "@rabbit-company/web";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBrowserMessage } from "../../../shared/protocol.ts";
import { isContainerRef } from "../../../shared/validate.ts";
import { clientIp, NO_STORE, sessionFromRequest } from "../../auth.ts";
import { config } from "../../config.ts";
import { audit } from "../../db/audit.ts";
import { enrollHost, getHost, verifyAgent } from "../../db/hosts.ts";
import { findSessionByCsrf } from "../../db/users.ts";
import type { Hub, Socket } from "../../hub.ts";
import { logger } from "../../lib/logger.ts";
import type { AppContext, AppState } from "../../types.ts";

export interface SocketData extends Record<string, unknown> {
	url: string;
	query: URLSearchParams;
	clientIp?: string;
}

interface BunSocket extends Socket {
	data: SocketData & { kind?: "agent" | "browser"; hostId?: number; topics?: Set<string>; sessionCsrf?: string; sessionTimer?: ReturnType<typeof setInterval> };
	subscribe(topic: string): void;
	unsubscribe(topic: string): void;
}

export const AGENT_SOCKET = "/api/agent/ws";
export const BROWSER_SOCKET = "/ws";

const browserSessions = new Map<string, Set<BunSocket>>();

export function closeBrowserSession(csrf: string): void {
	const sockets = browserSessions.get(csrf);
	browserSessions.delete(csrf);
	for (const socket of sockets ?? []) socket.close(4003, "session ended");
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

/** Reads "Bearer <host id>.<secret>" and checks it belongs to the host named in the address. */
export async function agentFromRequest(req: Request): Promise<number | null> {
	const header = req.headers.get("Authorization") ?? "";
	const match = /^Bearer (\d{1,15})\.([A-Za-z0-9_-]{20,128})$/.exec(header);
	if (!match) return null;
	const hostId = Number(match[1]);
	if (new URL(req.url).searchParams.get("host") !== match[1]) return null;
	return (await verifyAgent(hostId, match[2]!)) ? hostId : null;
}

function sameSite(req: Request): boolean {
	const origin = req.headers.get("Origin");
	if (origin === null) return false;
	try {
		return new URL(origin).host === new URL(req.url).host || origin === config.server.domain;
	} catch {
		return false;
	}
}

export function installScript(domain = config.server.domain): string {
	return `#!/bin/sh
# Installs the agent as a systemd service and connects it to ${domain}
set -eu
URL="${domain}"
TOKEN=""
while [ $# -gt 0 ]; do
	case "$1" in
		--token) TOKEN="$2"; shift 2 ;;
		--url) URL="$2"; shift 2 ;;
		*) echo "Unknown option $1" >&2; exit 2 ;;
	esac
done
[ -n "$TOKEN" ] || { echo "Missing --token" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run this as root" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
case "$(uname -m)" in
	x86_64|amd64) ARCH=x64 ;;
	aarch64|arm64) ARCH=arm64 ;;
	*) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
case "$URL" in https://*) ;; *) echo "Warning: $URL is not HTTPS. Use it only on a trusted network." >&2 ;; esac
BIN=/usr/local/bin/dockermanager-agent
curl -fsSL "$URL/downloads/agent-linux-$ARCH" -o "$BIN.tmp"
chmod 755 "$BIN.tmp"
mv "$BIN.tmp" "$BIN"
"$BIN" enroll --url "$URL" --token "$TOKEN"
cat > /etc/systemd/system/dockermanager-agent.service <<'UNIT'
[Unit]
Description=DockerManager agent
After=network-online.target docker.service podman.socket
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/dockermanager-agent run
Restart=always
RestartSec=5
Environment=AGENT_STATE=/etc/dockermanager/agent.json

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable dockermanager-agent >/dev/null
systemctl restart dockermanager-agent
echo "The agent is running. Check it with: systemctl status dockermanager-agent"
`;
}

export function agentRoutes(app: Web<AppState>, hub: Hub): void {
	/** Upgrades are only allowed on the two socket paths, each with its own check. */
	app.use(async (ctx: AppContext, next) => {
		if (ctx.req.headers.get("upgrade")?.toLowerCase() !== "websocket") return next();
		const path = new URL(ctx.req.url).pathname;
		if (path === AGENT_SOCKET) {
			const hostId = await agentFromRequest(ctx.req);
			if (hostId === null) return json({ error: "unauthorized", message: "Unknown agent. Enroll it again." }, 401);
			return next();
		}
		if (path === BROWSER_SOCKET) {
			if (!sameSite(ctx.req)) return json({ error: "forbidden", message: "Cross site sockets are not allowed." }, 403);
			const auth = await sessionFromRequest(ctx.req);
			if (!auth || auth.session.mfaPending) return json({ error: "unauthorized", message: "Sign in first." }, 401);
			return next();
		}
		return json({ error: "not_found", message: "No socket here." }, 404);
	});

	app.post("/api/agent/enroll", async (ctx) => {
		let body: { token?: unknown; hostname?: unknown };
		try {
			body = (await ctx.req.json()) as typeof body;
		} catch {
			return json({ error: "bad_request", message: "Send JSON with token and hostname." }, 400);
		}
		const token = typeof body.token === "string" ? body.token.trim() : "";
		const hostname = typeof body.hostname === "string" ? body.hostname.replace(/[^\w.-]/g, "").slice(0, 253) : "";
		const result = token.length > 0 && token.length < 200 ? await enrollHost(token, hostname) : null;
		if (!result) {
			await audit({ userId: null, action: "agent.enroll", target: hostname, ok: false, ip: clientIp(ctx) });
			return json({ error: "invalid_token", message: "This join token is unknown, used or expired. Create a new one in the controller." }, 401);
		}
		hub.disconnect(result.hostId, 4002, "enrolled again");
		await audit({ userId: null, hostId: result.hostId, action: "agent.enroll", target: hostname, ip: clientIp(ctx) });
		return json(result);
	});

	app.get(AGENT_SOCKET, () => json({ error: "upgrade_required", message: "Connect with a WebSocket." }, 426));
	app.get(BROWSER_SOCKET, () => json({ error: "upgrade_required", message: "Connect with a WebSocket." }, 426));

	app.get("/install.sh", () => new Response(installScript(), { headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": NO_STORE } }));

	app.get("/downloads/:file", (ctx) => {
		const file = ctx.params.file ?? "";
		if (file !== "agent-linux-x64" && file !== "agent-linux-arm64") return json({ error: "not_found", message: "Unknown download." }, 404);
		const path = join(config.agents.downloads, file);
		if (!existsSync(path)) return json({ error: "not_found", message: `${file} is not built on this controller. Run bun run build.` }, 404);
		return new Response(Bun.file(path), {
			headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": NO_STORE },
		});
	});

	app.websocket<SocketData>({
		idleTimeout: 120,
		maxPayloadLength: 16 * 1024 * 1024,
		open(ws) {
			const socket = ws as unknown as BunSocket;
			if (socket.data.url === AGENT_SOCKET) {
				const hostId = Number(socket.data.query.get("host"));
				socket.data.kind = "agent";
				socket.data.hostId = hostId;
				void getHost(hostId).then((host) => logger.info(`Agent connected: ${host?.name ?? hostId} from ${socket.data.clientIp ?? "unknown"}`));
				hub.attach(hostId, socket);
				return;
			}
			socket.data.kind = "browser";
			socket.data.topics = new Set();
		},
		async message(ws, message) {
			const socket = ws as unknown as BunSocket;
			if (socket.data.kind === "agent") {
				hub.receive(socket.data.hostId!, socket, message as string | Buffer);
				return;
			}
			const msg = parseBrowserMessage(message as string | Buffer);
			if (msg === null) return;
			if (msg.type === "auth") {
				if (socket.data.sessionCsrf) return;
				socket.data.sessionCsrf = msg.csrf;
				let sockets = browserSessions.get(msg.csrf);
				if (!sockets) browserSessions.set(msg.csrf, (sockets = new Set()));
				sockets.add(socket);
				const session = await findSessionByCsrf(msg.csrf);
				if (!browserSessions.get(msg.csrf)?.has(socket)) return;
				if (!session || session.mfaPending) return socket.close(4003, "session ended");
				socket.data.sessionTimer = setInterval(() => {
					void findSessionByCsrf(msg.csrf).then(
						(active) => {
							if (!active || active.mfaPending) socket.close(4003, "session ended");
						},
						() => socket.close(1011, "session check failed"),
					);
				}, 15_000);
				socket.send(JSON.stringify({ type: "auth.ok" }));
				return;
			}
			if (!socket.data.sessionCsrf) return;
			if (msg.type === "watch") {
				const wanted = new Set(
					msg.topics.filter((t) => t === "hosts" || t === "metrics" || t === "alerts" || /^(host|metrics|deploy|backup|task):\d{1,15}$/.test(t)),
				);
				for (const topic of socket.data.topics!) if (!wanted.has(topic)) socket.unsubscribe(topic);
				for (const topic of wanted) socket.subscribe(topic);
				socket.data.topics = wanted;
			} else if (msg.type === "logs.open") {
				if (!isContainerRef(msg.container)) return;
				hub.openLogs(msg.host, msg.container, Math.max(0, Math.min(5000, Math.floor(msg.tail))), socket).then(
					(stream) => socket.send(JSON.stringify({ type: "logs.opened", stream })),
					(err: Error) => socket.send(JSON.stringify({ type: "logs.end", stream: null, error: err.message })),
				);
			} else if (msg.type === "logs.close") {
				hub.closeLogs(msg.stream, socket);
			}
		},
		close(ws) {
			const socket = ws as unknown as BunSocket;
			if (socket.data.kind === "agent") {
				hub.detach(socket.data.hostId!, socket);
				logger.info(`Agent disconnected: host ${socket.data.hostId}`);
			} else {
				if (socket.data.sessionTimer) clearInterval(socket.data.sessionTimer);
				if (socket.data.sessionCsrf) {
					const sockets = browserSessions.get(socket.data.sessionCsrf);
					sockets?.delete(socket);
					if (sockets?.size === 0) browserSessions.delete(socket.data.sessionCsrf);
				}
				hub.browserClosed(socket);
			}
		},
	});
}
