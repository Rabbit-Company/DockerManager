import { checkPolicy, formatRule, renderRules, RULES_EXAMPLE, TABLE, type FirewallPolicy } from "../../../shared/firewall.ts";
import type { ContainerSummary, FirewallBackend, FirewallState, Listener } from "../../../shared/protocol.ts";
import type { StoredFirewall } from "../../db/firewall.ts";
import type { FirewallInput } from "../../firewall.ts";
import { verdict } from "../../firewall.ts";
import { portRows } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";

function check(ok: boolean, yes: string, no: string): SafeHtml {
	return html`<li>${ok ? html`<span class="badge badge-ok">yes</span>` : html`<span class="badge badge-warn">no</span>`} <span>${ok ? yes : no}</span></li>`;
}

function openBadge(open: "all" | "some" | "none"): SafeHtml {
	if (open === "all") return html`<span class="chip chip-warn">open</span>`;
	if (open === "some") return html`<span class="chip chip-link">limited</span>`;
	return html`<span class="chip chip-ok">blocked</span>`;
}

function hitTable(policy: FirewallPolicy, hits: Record<string, number>): SafeHtml {
	const rows: [string, number, boolean][] = policy.rules.map((r) => [formatRule({ ...r, comment: null }), hits[`line ${r.line}`] ?? 0, false]);
	if (policy.hostDefault === "drop" && policy.sshPort > 0) rows.unshift([`SSH on port ${policy.sshPort}, kept open`, hits["keep ssh"] ?? 0, true]);
	if (policy.hostDefault === "drop" || policy.containerDefault === "drop") rows.push(["Blocked by default", hits.default ?? 0, true]);
	if (rows.length === 0) return html``;
	return html`<table class="table compact hits">
		<caption class="muted small">
			Packets matched since the rules were applied
		</caption>
		<tbody>
			${rows.map(
				([rule, n, prose]) =>
					html`<tr>
						<td class="${prose ? "prose small" : "mono small wrap"}">${rule}</td>
						<td class="num small">${n.toLocaleString("en")}</td>
					</tr>`,
			)}
		</tbody>
	</table>`;
}

const LOCAL = new Set(["127.0.0.1", "::1"]);

export function firewallTab(input: {
	hostId: number;
	stored: StoredFirewall | null;
	live: { backend: FirewallBackend; state: FirewallState; listeners: Listener[]; hits: Record<string, number> } | null;
	liveError: string | null;
	containers: ContainerSummary[];
	values: FirewallInput;
	errors: string[];
	csrf: string;
}): SafeHtml {
	const base = `/hosts/${input.hostId}/firewall`;
	const pendingUntil =
		input.live?.state.pendingUntil ?? (input.stored?.status === "pending" && input.stored.pendingUntil ? Date.parse(input.stored.pendingUntil) : null);
	const pending = pendingUntil !== null && pendingUntil > Date.now();
	const managed = input.live?.state.managed ?? (input.stored ? input.stored.status === "active" || input.stored.status === "pending" : false);
	const checked = checkPolicy(input.values);
	const policy = checked.policy ?? null;
	const backend = input.live?.backend;

	const published = input.containers.flatMap((c) =>
		portRows(c.ports)
			.filter((r) => r.publicPort !== null)
			.map((r) => ({ container: c.name, port: r.publicPort!, protocol: r.type, exposure: r.exposure })),
	);
	const listeners = (input.live?.listeners ?? []).filter((l) => l.process !== "docker-proxy");

	return html`${
			pending
				? html`<section class="panel pending-panel" role="alert">
						<h2>New rules are active, keep them?</h2>
						<p>
							They are undone in
							<strong data-countdown-until="${pendingUntil}">${Math.max(0, Math.round((pendingUntil! - Date.now()) / 1000))} s</strong> unless you keep them. If
							this page stops loading, wait and the previous rules come back on their own.
						</p>
						<div class="actions">
							<form method="post" action="${base}/keep" class="inline">
								<input type="hidden" name="_csrf" value="${input.csrf}" /><button class="button primary" type="submit">Keep the new rules</button>
							</form>
							<form method="post" action="${base}/undo" class="inline">
								<input type="hidden" name="_csrf" value="${input.csrf}" /><button class="button" type="submit">Undo now</button>
							</form>
						</div>
					</section>`
				: ""
		}
		${input.stored?.status === "reverted" && !pending && input.stored.detail ? html`<div class="flash flash-error" role="status">${input.stored.detail}</div>` : ""}
		${input.stored?.status === "failed" && input.stored.detail ? html`<div class="flash flash-error" role="status">The last change failed: ${input.stored.detail}</div>` : ""}
		<div class="columns columns-start">
			<section class="panel stack">
				<h2>On this host</h2>
				${
					input.live === null
						? html`<p class="muted">${input.liveError ?? "The agent is offline."}</p>`
						: html`<ul class="check-list fw-checks">
									${check(backend!.nft, `nftables ${backend!.version ?? ""} is installed`, "The nft tool is missing. Install the nftables package.")}
									${backend!.nft ? check(backend!.permitted, "The agent may change the firewall", "The agent may not change the firewall. It must run as root.") : ""}
								</ul>
								${
									backend!.tables.length > 0
										? html`<p class="small">Other tables: ${backend!.tables.map((t, i) => html`${i > 0 ? ", " : ""}<span class="mono">${t}</span>`)}</p>`
										: ""
								}`
				}
				<p class="muted small">
					Rules go into a table of their own, ${html`<span class="mono">inet ${TABLE}</span>`}, for IPv4 and IPv6. Tables of Docker, Podman, ufw or firewalld
					stay as they are. Every packet passes each table, so a block here always holds, while an allow here does not open what another table blocks.
				</p>
			</section>
			<section class="panel stack">
				<h2>Status</h2>
				<p>
					${pending ? "Waiting for you to keep the new rules." : managed ? "Managed here and active." : "Not managed. Docker's own rules apply, every published port is open."}
				</p>
				${
					managed && !pending
						? html`<form method="post" action="${base}/disable" class="inline">
								<input type="hidden" name="_csrf" value="${input.csrf}" /><button class="button danger" type="submit">Remove all rules</button>
							</form>`
						: ""
				}
				${managed && input.live?.state.policy ? hitTable(input.live.state.policy, input.live.hits) : ""}
			</section>
		</div>
		<form method="post" action="${base}" class="stack">
			<input type="hidden" name="_csrf" value="${input.csrf}" />
			<section class="panel stack">
				<div class="editor-head">
					<label for="fw-rules">Rules</label>
					<span class="muted small">One per line, first match wins</span>
				</div>
				<textarea id="fw-rules" name="rules" class="code" rows="10" spellcheck="false" placeholder="${RULES_EXAMPLE}">${input.values.rules}</textarea>
				${
					input.errors.length > 0
						? html`<ul class="issues">
								${input.errors.map((e) => html`<li class="issue issue-error"><span class="badge badge-bad">error</span> <span>${e}</span></li>`)}
							</ul>`
						: ""
				}
				<p class="muted small">
					${html`<span class="mono">allow tcp 22 from 10.0.0.0/8 to host</span>`}: action, tcp, udp or any, ports like 80,443 or 8000-8100, then optionally a
					source and host or containers (the default). Container rules use the published port, the one people connect to.
				</p>
				<div class="field-row three fw-fields">
					<label
						>Other traffic to the host
						<select name="host_default">
							<option value="accept" ${input.values.hostDefault !== "drop" ? "selected" : ""}>Leave to the host</option>
							<option value="drop" ${input.values.hostDefault === "drop" ? "selected" : ""}>Block</option>
						</select>
						<small>Block still lets loopback, replies, ping and container networks through.</small></label
					>
					<label
						>Keep SSH open on port
						<input name="ssh_port" type="number" min="0" max="65535" value="${input.values.sshPort}" />
						<small>When blocking other traffic. 0 turns this off.</small></label
					>
					<label
						>Other published ports
						<select name="container_default">
							<option value="accept" ${input.values.containerDefault !== "drop" ? "selected" : ""}>Open</option>
							<option value="drop" ${input.values.containerDefault === "drop" ? "selected" : ""}>Blocked</option>
						</select></label
					>
				</div>
			</section>
			<div class="actions">
				<button class="button" type="submit" name="intent" value="preview">Preview</button>
				<button
					class="button primary"
					type="submit"
					name="intent"
					value="apply"
					${input.live === null || !backend?.nft || !backend.permitted || pending ? "disabled" : ""}
				>
					Apply
				</button>
				<span class="muted small"
					>${pending ? "Keep or undo the new rules before applying others." : "Applied rules undo themselves after 90 seconds unless you keep them."}</span
				>
			</div>
		</form>
		${
			policy
				? html`<section class="group">
							<h2 class="group-title">What these rules do</h2>
							<div class="table-wrap">
								<table class="table">
									<thead>
										<tr>
											<th>Port</th>
											<th>Used by</th>
											<th>Result</th>
										</tr>
									</thead>
									<tbody>
										${published.map((p) => {
											const v = verdict(policy.rules, "containers", p.port, p.protocol, policy.containerDefault);
											const local = p.exposure === "local";
											return html`<tr>
												<td class="mono nowrap">${p.port}/${p.protocol}</td>
												<td>${p.container} <span class="muted small">container</span></td>
												<td>
													${local ? html`<span class="chip chip-ok">local only</span>` : openBadge(v.open)}
													<span class="small">${local ? "bound to 127.0.0.1, not reachable from outside" : v.text}</span>
												</td>
											</tr>`;
										})}
										${listeners.map((l) => {
											const v = verdict(policy.rules, "host", l.port, l.protocol, policy.hostDefault);
											const local = LOCAL.has(l.address);
											const ssh = policy.hostDefault === "drop" && l.protocol === "tcp" && l.port === policy.sshPort;
											return html`<tr>
												<td class="mono nowrap">${l.port}/${l.protocol}</td>
												<td>${l.process ?? "unknown"} <span class="muted small">on ${l.address}</span></td>
												<td>
													${local ? html`<span class="chip chip-ok">local only</span>` : ssh ? openBadge("all") : openBadge(v.open)}
													<span class="small">${local ? "listens on loopback only" : ssh ? "kept open for SSH" : v.text}</span>
												</td>
											</tr>`;
										})}
									</tbody>
								</table>
							</div>
						</section>
						<details class="panel">
							<summary>The nftables rules</summary>
							<pre class="mono small nft-rules">${renderRules(policy)}</pre>
						</details>`
				: ""
		}`;
}
