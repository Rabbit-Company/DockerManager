import { CHANNEL_KINDS } from "../../alerts/channels.ts";
import { RULES, type RuleId, type RuleSetting, type Severity } from "../../alerts/rules.ts";
import type { Alert, Channel } from "../../db/alerts.ts";
import { ago, dateTime } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";

export function severityBadge(severity: Severity): SafeHtml {
	const tone = severity === "critical" ? "bad" : severity === "warning" ? "warn" : "idle";
	return html`<span class="badge badge-${tone}">${severity}</span>`;
}

const KIND_LABEL = Object.fromEntries(CHANNEL_KINDS.map(([k, l]) => [k, l]));

function alertRow(a: Alert, showEnd: boolean): SafeHtml {
	return html`<tr>
		<td>${a.status === "resolved" ? html`<span class="badge badge-ok">resolved</span>` : severityBadge(a.severity)}</td>
		<td>
			${a.link ? html`<a class="strong" href="${a.link.replace(/^https?:\/\/[^/]+/, "")}">${a.title}</a>` : html`<span class="strong">${a.title}</span>`}
			${a.detail ? html`<div class="muted small wrap">${a.detail}</div>` : ""}
		</td>
		<td class="nowrap small" title="${dateTime(a.startedAt)}">${ago(a.startedAt)}</td>
		${showEnd ? html`<td class="hide-sm nowrap small">${a.status === "resolved" && a.resolvedAt ? `after ${duration(a.startedAt, a.resolvedAt)}` : a.status === "event" ? "event" : ""}</td>` : ""}
	</tr>`;
}

function duration(from: string, to: string): string {
	const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
	if (s < 120) return `${s} s`;
	if (s < 7200) return `${Math.round(s / 60)} min`;
	if (s < 172_800) return `${Math.round(s / 3600)} h`;
	return `${Math.round(s / 86_400)} days`;
}

export function alertsPage(input: { firing: Alert[]; recent: Alert[]; channels: Channel[]; settings: Map<RuleId, RuleSetting>; csrf: string }): SafeHtml {
	return html`<section class="group" data-live="alerts-firing">
			<h2 class="group-title">Firing now <span class="muted">${input.firing.length}</span></h2>
			${
				input.firing.length === 0
					? html`<p class="empty-inline">Nothing is wrong right now.</p>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Severity</th>
										<th>Alert</th>
										<th>Since</th>
									</tr>
								</thead>
								<tbody>
									${input.firing.map((a) => alertRow(a, false))}
								</tbody>
							</table>
						</div>`
			}
		</section>
		<section class="group">
			<div class="section-head">
				<h2 class="group-title">Channels <span class="muted">${input.channels.length}</span></h2>
				<a class="button primary" href="/alerts/channels/new">Add channel</a>
			</div>
			${
				input.channels.length === 0
					? html`<section class="empty">
							<h2>No channel yet</h2>
							<p>Alerts show up on this page either way. Add ntfy, Discord, email or a webhook to hear about them anywhere.</p>
							<a class="button primary" href="/alerts/channels/new">Add a channel</a>
						</section>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Name</th>
										<th class="hide-sm">Kind</th>
										<th>Last delivery</th>
									</tr>
								</thead>
								<tbody>
									${input.channels.map(
										(c) =>
											html`<tr>
												<td><a class="strong" href="/alerts/channels/${c.id}">${c.name}</a>${c.enabled ? "" : html` <span class="chip">paused</span>`}</td>
												<td class="hide-sm">${KIND_LABEL[c.kind]}</td>
												<td class="small">
													${
														c.lastError
															? html`<span class="badge badge-bad">failed</span> <span class="muted wrap">${c.lastError}</span>`
															: c.lastSentAt
																? html`<span class="badge badge-ok">sent</span> <span class="muted">${ago(c.lastSentAt)}</span>`
																: html`<span class="muted">nothing sent yet</span>`
													}
												</td>
											</tr>`,
									)}
								</tbody>
							</table>
						</div>`
			}
		</section>
		<section class="group">
			<h2 class="group-title">Rules</h2>
			<form method="post" action="/alerts/rules" class="stack">
				<input type="hidden" name="_csrf" value="${input.csrf}" />
				<div class="table-wrap">
					<table class="table rules">
						<thead>
							<tr>
								<th>Rule</th>
								<th>Above</th>
								<th>For</th>
								<th>Send to</th>
							</tr>
						</thead>
						<tbody>
							${RULES.map((r) => {
								const s = input.settings.get(r.id)!;
								return html`<tr>
									<td>
										<label class="check"
											><input type="checkbox" name="enabled:${r.id}" value="1" ${s.enabled ? "checked" : ""} />
											<span
												><span class="strong">${r.label}</span> ${severityBadge(r.severity)}<span class="muted small rule-help">${r.help}</span></span
											></label
										>
									</td>
									<td class="rule-threshold">
										${
											r.threshold !== null
												? html`<span class="unit-input"
														><input
															name="threshold:${r.id}"
															type="number"
															min="1"
															max="100"
															value="${s.threshold ?? r.threshold}"
															aria-label="${r.label} threshold"
														/><span class="muted">%</span></span
													>`
												: ""
										}
									</td>
									<td class="rule-minutes">
										${
											r.minutes !== null
												? html`<span class="unit-input"
														><input
															name="minutes:${r.id}"
															type="number"
															min="0"
															max="1440"
															value="${s.minutes ?? r.minutes}"
															aria-label="${r.label} minutes"
														/><span class="muted">min</span></span
													>`
												: html`<span class="muted small">once</span>`
										}
									</td>
									<td>
										${
											input.channels.length === 0
												? html`<span class="muted small">this page</span>`
												: html`<div class="channel-picks">
														${input.channels.map(
															(c) =>
																html`<label class="check small"
																	><input
																		type="checkbox"
																		name="channel:${r.id}"
																		value="${c.id}"
																		${s.channels === null || s.channels.includes(c.id) ? "checked" : ""}
																	/>
																	${c.name}</label
																>`,
														)}
													</div>`
										}
									</td>
								</tr>`;
							})}
						</tbody>
					</table>
				</div>
				<div><button class="button" type="submit">Save rules</button></div>
			</form>
		</section>
		<section class="group" data-live="alerts-history">
			<h2 class="group-title">History</h2>
			${
				input.recent.length === 0
					? html`<p class="empty-inline">No alerts yet.</p>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Result</th>
										<th>Alert</th>
										<th>Started</th>
										<th class="hide-sm">Lasted</th>
									</tr>
								</thead>
								<tbody>
									${input.recent.map((a) => alertRow(a, true))}
								</tbody>
							</table>
						</div>`
			}
		</section>`;
}

export function channelForm(form: {
	action: string;
	csrf: string;
	values: Record<string, string>;
	error?: string | null;
	editing: boolean;
	enabled?: boolean;
}): SafeHtml {
	const v = form.values;
	const kind = v.kind ?? "ntfy";
	const keep = form.editing ? "Leave empty to keep the stored one." : "";
	const text = (name: string, label: string, extra: { type?: string; placeholder?: string; help?: string } = {}) =>
		html`<label
			>${label}
			<input
				name="${name}"
				type="${extra.type ?? "text"}"
				value="${extra.type === "password" ? "" : (v[name] ?? "")}"
				placeholder="${extra.placeholder ?? ""}"
				autocomplete="off"
				spellcheck="false"
			/>
			${extra.help ? html`<small>${extra.help}</small>` : ""}</label
		>`;
	return html`<form method="post" action="${form.action}" class="stack destination-form">
		<input type="hidden" name="_csrf" value="${form.csrf}" />
		${form.error ? html`<div class="flash flash-error" role="alert">${form.error}</div>` : ""}
		<section class="panel stack">
			${text("name", "Name", { placeholder: "Phone" })}
			<fieldset class="kinds">
				<legend>Kind</legend>
				${CHANNEL_KINDS.map(
					([k, label, hint]) =>
						html`<label class="kind-option"
							><input type="radio" name="kind" value="${k}" ${k === kind ? "checked" : ""} /><span><strong>${label}</strong><small>${hint}</small></span></label
						>`,
				)}
			</fieldset>
			${form.editing ? html`<label class="check"><input type="checkbox" name="enabled" value="1" ${form.enabled ? "checked" : ""} /> Send alerts to this channel</label>` : ""}
		</section>
		<section class="panel stack" data-kind-fields="ntfy">
			<h2>ntfy</h2>
			${text("server", "Server", { placeholder: "https://ntfy.sh" })}
			${text("topic", "Topic", { placeholder: "my-servers-x7k2", help: "On ntfy.sh anyone who knows a topic can read it, so pick one that is hard to guess or use an access token." })}
			${text("token", "Access token", { type: "password", help: keep || "Optional." })}
		</section>
		<section class="panel stack" data-kind-fields="discord">
			<h2>Discord</h2>
			${text("discord_url", "Webhook address", { type: "password", placeholder: "https://discord.com/api/webhooks/...", help: keep || "Channel settings, Integrations, Webhooks, Copy Webhook URL." })}
		</section>
		<section class="panel stack" data-kind-fields="email">
			<h2>Email</h2>
			<div class="field-row">${text("smtp_host", "SMTP server", { placeholder: "smtp.example.com" })} ${text("smtp_port", "Port", { placeholder: "587" })}</div>
			<label
				>Security
				<select name="security">
					${[
						["starttls", "STARTTLS, usually port 587"],
						["tls", "TLS, usually port 465"],
						["none", "None, only inside a trusted network"],
					].map(([value, label]) => html`<option value="${value}" ${v.security === value ? "selected" : ""}>${label}</option>`)}
				</select></label
			>
			<div class="field-row">${text("smtp_user", "Username")} ${text("smtp_password", "Password", { type: "password", help: keep })}</div>
			<div class="field-row">
				${text("from", "From", { placeholder: "alerts@example.com" })} ${text("to", "To", { placeholder: "me@example.com, team@example.com" })}
			</div>
		</section>
		<section class="panel stack" data-kind-fields="webhook">
			<h2>Webhook</h2>
			${text("url", "Address", { placeholder: "https://hooks.example.com/docker" })}
			${text("secret", "Signing secret", { type: "password", help: keep || "Each request carries X-DockerManager-Signature: sha256=<HMAC of the body with this secret>." })}
		</section>
		<div class="actions"><button class="button primary" type="submit">${form.editing ? "Save" : "Add channel"}</button></div>
	</form>`;
}

export function channelPage(input: { channel: Channel; form: SafeHtml; csrf: string }): SafeHtml {
	const c = input.channel;
	return html`<div class="columns columns-start">
			<section class="panel stack">
				<h2>Test</h2>
				<p class="muted">Sends a test alert now.</p>
				${c.lastError ? html`<p class="small"><span class="badge badge-bad">last delivery failed</span> <span class="wrap">${c.lastError}</span></p>` : ""}
				${c.lastSentAt && !c.lastError ? html`<p class="small muted">Last delivered ${ago(c.lastSentAt)}.</p>` : ""}
				<form method="post" action="/alerts/channels/${c.id}/test" class="inline">
					<input type="hidden" name="_csrf" value="${input.csrf}" /><button class="button" type="submit">Send a test</button>
				</form>
			</section>
			<section class="panel stack danger-zone">
				<h2>Remove channel</h2>
				<p class="muted">Rules that send to it keep sending to the other channels.</p>
				<form method="post" action="/alerts/channels/${c.id}/delete" class="inline">
					<input type="hidden" name="_csrf" value="${input.csrf}" /><button class="button danger" type="submit">Remove channel</button>
				</form>
			</section>
		</div>
		${input.form}`;
}
