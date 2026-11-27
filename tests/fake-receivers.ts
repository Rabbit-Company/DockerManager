/** Catches HTTP posts, for ntfy, Discord and webhook channels. */
export class FakeHttp {
	received: { path: string; headers: Record<string, string>; body: string }[] = [];
	status = 200;
	private server: ReturnType<typeof Bun.serve>;

	constructor() {
		this.server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				this.received.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() });
				return new Response(this.status === 200 ? "ok" : "nope", { status: this.status });
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop(): void {
		this.server.stop(true);
	}
}

/** Enough SMTP to accept one message at a time without TLS. */
export class FakeSmtp {
	messages: { from: string; to: string[]; data: string }[] = [];
	private listener: { port: number; stop(force?: boolean): void };

	constructor() {
		const self = this;
		this.listener = Bun.listen<{ buffer: string; data: boolean; from: string; to: string[]; body: string }>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.data = { buffer: "", data: false, from: "", to: [], body: "" };
					socket.write("220 fake ESMTP\r\n");
				},
				data(socket, chunk) {
					const s = socket.data;
					s.buffer += chunk.toString();
					for (;;) {
						if (s.data) {
							const end = s.buffer.indexOf("\r\n.\r\n");
							if (end === -1) return;
							s.body += s.buffer.slice(0, end);
							s.buffer = s.buffer.slice(end + 5);
							self.messages.push({ from: s.from, to: s.to, data: s.body });
							s.data = false;
							s.to = [];
							s.body = "";
							socket.write("250 queued\r\n");
							continue;
						}
						const nl = s.buffer.indexOf("\r\n");
						if (nl === -1) return;
						const line = s.buffer.slice(0, nl);
						s.buffer = s.buffer.slice(nl + 2);
						const cmd = line.slice(0, 4).toUpperCase();
						if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake\r\n250 8BITMIME\r\n");
						else if (cmd === "MAIL") ((s.from = line.slice(10).replace(/[<>]/g, "").split(" ")[0]!), socket.write("250 ok\r\n"));
						else if (cmd === "RCPT") (s.to.push(line.slice(8).replace(/[<>]/g, "")), socket.write("250 ok\r\n"));
						else if (cmd === "DATA") ((s.data = true), socket.write("354 go ahead\r\n"));
						else if (cmd === "QUIT") (socket.write("221 bye\r\n"), socket.end());
						else socket.write("250 ok\r\n");
					}
				},
			},
		});
	}

	get port(): number {
		return this.listener.port;
	}

	stop(): void {
		this.listener.stop(true);
	}
}
