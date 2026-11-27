import { AUTO_LEVELS, levelAllowed, POLICIES, type NewerTag } from "../../../shared/images.ts";
import type { Stack } from "../../db/stacks.ts";
import type { RegistryLogin } from "../../db/updates.ts";
import type { ServiceUpdate } from "../../updates.ts";
import { ago, dateTime } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";

export function hasUpdate(u: ServiceUpdate): boolean {
	return u.offer !== null || u.rebuilt === true;
}

export function countUpdates(list: ServiceUpdate[]): number {
	return list.filter(hasUpdate).length;
}

function levelChip(level: NewerTag["level"]): SafeHtml {
	const tone = level === "major" ? "chip-warn" : level === "minor" ? "chip-link" : "chip-ok";
	return html`<span class="chip ${tone}">${level}</span>`;
}

const POLICY_LABEL: Record<string, string> = { off: "Do not check", patch: "Patch releases", minor: "Minor releases", major: "All releases" };
const AUTO_LABEL: Record<string, string> = { off: "Ask first", patch: "Patch on its own", minor: "Minor on its own" };

function available(u: ServiceUpdate): SafeHtml {
	if (u.setting.policy === "off") return html`<span class="muted">not checked</span>`;
	const parts: SafeHtml[] = [];
	if (u.offer) parts.push(html`<span class="update-offer"><span class="mono">${u.offer.tag}</span> ${levelChip(u.offer.level)}</span>`);
	if (u.rebuilt === true)
		parts.push(
			html`<span class="update-offer"><span class="chip chip-link">new build</span> <span class="muted small">of ${u.ref?.tag ?? "this tag"}</span></span>`,
		);
	const outside = u.newer.find((n) => !levelAllowed(n.level, u.setting.policy));
	if (outside) parts.push(html`<span class="muted small">${outside.tag} is a ${outside.level} release, outside this policy</span>`);
	if (parts.length === 0) {
		if (u.error) return html`<span class="muted small">${u.error}</span>`;
		if (!u.checkedAt) return html`<span class="muted">not checked yet</span>`;
		return html`<span class="muted">up to date</span>`;
	}
	return html`<div class="update-cell">${parts}</div>`;
}

export function updatesTab(input: {
	stack: Stack;
	updates: ServiceUpdate[];
	csrf: string;
	lastRun: string | null;
	checking: boolean;
	busy: boolean;
}): SafeHtml {
	const { stack, updates } = input;
	const offers = updates.filter((u) => hasUpdate(u) && (u.offer === null || u.editable));
	const pending = stack.deployedVersion !== null && stack.deployedVersion !== stack.currentVersion;
	const base = `/hosts/${stack.hostId}/stacks/${stack.id}/updates`;
	return html`<div class="section-head">
			<p class="muted">
				${input.checking ? "Checking registries now." : input.lastRun ? html`Registries checked <span title="${dateTime(input.lastRun)}">${ago(input.lastRun)}</span>.` : "Registries were not checked yet."}
				An update saves a new version with the new tag, pulls, deploys and rolls back when the containers do not come up healthy.
			</p>
			<form method="post" action="${base}/check" class="inline">
				<input type="hidden" name="_csrf" value="${input.csrf}" />
				<button class="button" type="submit">Check now</button>
			</form>
		</div>
		${pending ? html`<div class="flash flash-error" role="status">This stack has saved changes that are not deployed. Deploy them before updating images.</div>` : ""}
		${
			updates.length === 0
				? html`<p class="empty-inline">No service of this stack names an image.</p>`
				: html`<form method="post" action="${base}" class="stack">
						<input type="hidden" name="_csrf" value="${input.csrf}" />
						<div class="table-wrap">
							<table class="table updates">
								<thead>
									<tr>
										<th>Service</th>
										<th class="hide-sm">Image</th>
										<th>Available</th>
										<th class="hide-sm">Check for</th>
										<th class="hide-sm">Apply</th>
										<th class="right"><span class="visually-hidden">Actions</span></th>
									</tr>
								</thead>
								<tbody>
									${updates.map(
										(u) =>
											html`<tr>
												<td class="strong">${u.service}</td>
												<td class="mono small wrap hide-sm">
													${u.written}${u.notes ? html`<div><a class="small" href="${u.notes}" rel="noopener noreferrer" target="_blank">Release notes</a></div>` : ""}
												</td>
												<td>${available(u)}</td>
												<td class="hide-sm">
													<select name="policy:${u.service}" aria-label="Check ${u.service} for">
														${POLICIES.map((p) => html`<option value="${p}" ${p === u.setting.policy ? "selected" : ""}>${POLICY_LABEL[p]}</option>`)}
													</select>
												</td>
												<td class="hide-sm">
													<select name="auto:${u.service}" aria-label="Apply updates of ${u.service}" ${u.editable ? "" : "disabled"}>
														${AUTO_LEVELS.map((a) => html`<option value="${a}" ${a === u.setting.auto ? "selected" : ""}>${AUTO_LABEL[a]}</option>`)}
													</select>
												</td>
												<td class="right">
													${
														hasUpdate(u) && !input.busy && !pending && (u.offer === null || u.editable)
															? html`<button class="button small primary" type="submit" name="intent" value="update:${u.service}:${u.offer?.tag ?? ""}">
																	${u.offer ? `Update to ${u.offer.tag}` : "Pull new build"}
																</button>`
															: !u.editable && u.offer
																? html`<span class="muted small">set in .env</span>`
																: ""
													}
												</td>
											</tr>`,
									)}
								</tbody>
							</table>
						</div>
						<div class="actions">
							<button class="button" type="submit" name="intent" value="settings">Save settings</button>
							${offers.length > 1 && !input.busy && !pending ? html`<button class="button primary" type="submit" name="intent" value="all">Update all ${offers.length}</button>` : ""}
						</div>
					</form>`
		}`;
}

export interface UpdateRow {
	hostId: number;
	hostName: string;
	stack: Stack;
	update: ServiceUpdate;
}

export function updatesPage(input: {
	rows: UpdateRow[];
	errors: UpdateRow[];
	csrf: string;
	lastRun: string | null;
	checking: boolean;
	nextRun: string | null;
}): SafeHtml {
	return html`<div class="section-head">
			<p class="muted">
				${input.checking ? "Checking registries now. This page updates when it is done." : input.lastRun ? html`Checked ${ago(input.lastRun)}.` : "Not checked yet."}
				${input.nextRun && !input.checking ? html`Next check ${input.nextRun}.` : ""}
			</p>
			<div class="actions">
				<a class="button" href="/registries">Registry logins</a>
				<form method="post" action="/updates/check" class="inline">
					<input type="hidden" name="_csrf" value="${input.csrf}" />
					<button class="button primary" type="submit" ${input.checking ? "disabled" : ""}>Check now</button>
				</form>
			</div>
		</div>
		${
			input.rows.length === 0
				? html`<section class="empty">
						<h2>Everything is up to date</h2>
						<p>Images of stacks are checked every few hours. Updates show up here and on each stack.</p>
					</section>`
				: html`<div class="table-wrap">
						<table class="table">
							<thead>
								<tr>
									<th>Stack</th>
									<th>Service</th>
									<th class="hide-sm">Image</th>
									<th>Available</th>
								</tr>
							</thead>
							<tbody>
								${input.rows.map(
									(r) =>
										html`<tr>
											<td>
												<a class="strong" href="/hosts/${r.hostId}/stacks/${r.stack.id}?tab=updates">${r.stack.name}</a>
												<div class="muted small">${r.hostName}</div>
											</td>
											<td>${r.update.service}</td>
											<td class="hide-sm mono small wrap">${r.update.written}</td>
											<td>${available(r.update)}</td>
										</tr>`,
								)}
							</tbody>
						</table>
					</div>`
		}
		${
			input.errors.length > 0
				? html`<section class="group">
						<h2 class="group-title">Images that could not be checked <span class="muted">${input.errors.length}</span></h2>
						<div class="table-wrap">
							<table class="table">
								<tbody>
									${input.errors.map(
										(r) =>
											html`<tr>
												<td>
													<a href="/hosts/${r.hostId}/stacks/${r.stack.id}?tab=updates">${r.stack.name}</a> <span class="muted small">${r.update.service}</span>
												</td>
												<td class="mono small wrap">${r.update.written}</td>
												<td class="small">${r.update.error}</td>
											</tr>`,
									)}
								</tbody>
							</table>
						</div>
					</section>`
				: ""
		}`;
}

export function registriesPage(logins: RegistryLogin[], csrf: string, error?: string, registry = "", username = ""): SafeHtml {
	return html`<section class="panel narrow stack">
			<h2>Add a login</h2>
			<p class="muted">For private images. Docker Hub works without one, a login only raises its rate limit. The password or token is stored encrypted.</p>
			${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ""}
			<form method="post" action="/registries" class="stack">
				<input type="hidden" name="_csrf" value="${csrf}" />
				<label
					>Registry <input name="registry" required value="${registry}" placeholder="ghcr.io" autocomplete="off" spellcheck="false" /><small
						>Use docker.io for Docker Hub.</small
					></label
				>
				<label>Username <input name="username" required value="${username}" autocomplete="off" /></label>
				<label>Password or access token <input name="password" type="password" required autocomplete="new-password" /></label>
				<div><button class="button primary" type="submit">Save login</button></div>
			</form>
		</section>
		${
			logins.length > 0
				? html`<div class="table-wrap narrow">
						<table class="table">
							<thead>
								<tr>
									<th>Registry</th>
									<th>Username</th>
									<th class="right"><span class="visually-hidden">Actions</span></th>
								</tr>
							</thead>
							<tbody>
								${logins.map(
									(l) =>
										html`<tr>
											<td class="mono">${l.registry}</td>
											<td>${l.username}</td>
											<td class="right">
												<form method="post" action="/registries/${l.id}/delete" class="inline">
													<input type="hidden" name="_csrf" value="${csrf}" />
													<button class="button small danger" type="submit">Remove</button>
												</form>
											</td>
										</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: ""
		}`;
}
