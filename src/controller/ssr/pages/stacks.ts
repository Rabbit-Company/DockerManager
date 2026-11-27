import type { Issue } from "../../../shared/compose.ts";
import { envChanges } from "../../../shared/compose.ts";
import { diffLines, hunks } from "../../../shared/diff.ts";
import type { ContainerSummary } from "../../../shared/protocol.ts";
import type { Deploy, DeployStatus, Stack, StackVersion } from "../../db/stacks.ts";
import { ago, dateTime } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { containerTable, groupByProject, type HostView } from "./hosts.ts";
import { jobOutputPanel } from "./jobs.ts";

export type StackTab = "editor" | "services" | "updates" | "backups" | "history" | "settings";
const TABS: [StackTab, string][] = [
	["editor", "Editor"],
	["services", "Services"],
	["updates", "Updates"],
	["backups", "Backups"],
	["history", "History"],
	["settings", "Settings"],
];

export function isStackTab(value: string | null): value is StackTab {
	return TABS.some(([key]) => key === value);
}

export function projectContainers(view: HostView, name: string): ContainerSummary[] {
	return (view.snapshot?.containers ?? []).filter((c) => c.project === name);
}

export function stackState(stack: Stack, containers: ContainerSummary[], online: boolean): { tone: "ok" | "warn" | "bad" | "idle"; label: string } {
	if (!online) return { tone: "idle", label: "Unknown, agent offline" };
	const running = containers.filter((c) => c.state === "running").length;
	if (containers.length === 0) return { tone: "idle", label: stack.deployedVersion === null ? "Not deployed" : "Down" };
	if (containers.some((c) => c.state === "restarting")) return { tone: "bad", label: "Restarting" };
	if (running === containers.length) return { tone: "ok", label: `Running ${running}/${containers.length}` };
	if (running === 0) return { tone: "idle", label: "Stopped" };
	return { tone: "warn", label: `Running ${running}/${containers.length}` };
}

function stateBadge(state: { tone: string; label: string }): SafeHtml {
	return html`<span class="badge badge-${state.tone}">${state.label}</span>`;
}

function versionNote(stack: Stack): SafeHtml {
	if (stack.deployedVersion === null) return html`<span class="chip">not deployed</span>`;
	if (stack.deployedVersion !== stack.currentVersion)
		return html`<span class="chip chip-warn" title="Version ${stack.deployedVersion} runs on the host">changes not deployed</span>`;
	return html`<span class="chip chip-ok">deployed</span>`;
}

export function deployStatusBadge(status: DeployStatus): SafeHtml {
	const tone = status === "ok" ? "ok" : status === "running" ? "warn" : "bad";
	const label = { ok: "succeeded", running: "running", failed: "failed", interrupted: "interrupted" }[status];
	return html`<span class="badge badge-${tone}">${label}</span>`;
}

const ACTION_LABEL: Record<string, string> = {
	deploy: "Deploy",
	upgrade: "Update",
	start: "Start",
	stop: "Stop",
	restart: "Restart",
	down: "Take down",
	pull: "Pull images",
};

function actionForm(stack: Stack, action: string, label: string, csrf: string, tone = "", small = false): SafeHtml {
	return html`<form class="inline" method="post" action="/hosts/${stack.hostId}/stacks/${stack.id}/action">
		<input type="hidden" name="_csrf" value="${csrf}" />
		<button class="button${small ? " small" : ""}${tone}" type="submit" name="action" value="${action}">${label}</button>
	</form>`;
}

export function stackActions(stack: Stack, containers: ContainerSummary[], csrf: string, busy: number | null, locked = false): SafeHtml {
	if (busy !== null) return html`<a class="button" href="/hosts/${stack.hostId}/stacks/${stack.id}/deploys/${busy}">Running, show output</a>`;
	if (locked) return html`<span class="muted small">A job of this stack is running.</span>`;
	if (stack.movedTo !== null) return html`<a class="button primary" href="/stacks/${stack.movedTo}">Open the new copy</a>`;
	const running = containers.some((c) => c.state === "running");
	return html`${actionForm(stack, "deploy", "Deploy", csrf, " primary")} ${running ? actionForm(stack, "restart", "Restart", csrf) : ""}
	${running ? actionForm(stack, "stop", "Stop", csrf) : containers.length > 0 ? actionForm(stack, "start", "Start", csrf) : ""}
	${!stack.adopted && stack.deployedVersion !== null ? html`<a class="button" href="/hosts/${stack.hostId}/stacks/${stack.id}/transfer">Transfer</a>` : ""}`;
}

export function stacksTab(view: HostView, stacks: Stack[], csrf: string, updateCounts: Map<number, number | null> = new Map()): SafeHtml {
	const managed = new Set(stacks.map((s) => s.name));
	const unmanaged = groupByProject(view.snapshot?.containers ?? []).filter((g) => g.name !== null && !managed.has(g.name));
	return html`<div class="section-head">
			<p class="muted">Compose projects this controller manages. Edit them here and deploy with one click.</p>
			<a class="button primary" href="/hosts/${view.host.id}/stacks/new">New stack</a>
		</div>
		${
			stacks.length === 0
				? html`<section class="empty">
						<h2>No stacks yet</h2>
						<p>Create one from a compose file, or adopt a project that already runs on this host.</p>
					</section>`
				: html`<div class="table-wrap">
						<table class="table">
							<thead>
								<tr>
									<th>Name</th>
									<th>Status</th>
									<th class="hide-sm">Version</th>
									<th class="hide-sm">Updates</th>
									<th class="hide-sm">Folder</th>
									<th class="right"><span class="visually-hidden">Actions</span></th>
								</tr>
							</thead>
							<tbody>
								${stacks.map((stack) => {
									const containers = projectContainers(view, stack.name);
									return html`<tr>
										<td>
											<a class="strong" href="/hosts/${view.host.id}/stacks/${stack.id}">${stack.name}</a
											>${stack.adopted ? html` <span class="chip">adopted</span>` : ""}${stack.movedTo !== null ? html` <span class="chip">transferred</span>` : ""}
										</td>
										<td>${stateBadge(stackState(stack, containers, view.online))}</td>
										<td class="hide-sm nowrap">v${stack.currentVersion} ${versionNote(stack)}</td>
										<td class="hide-sm">
											${(() => {
												const n = updateCounts.get(stack.id);
												return n
													? html`<a class="chip chip-link" href="/hosts/${view.host.id}/stacks/${stack.id}?tab=updates">${n} available</a>`
													: html`<span class="muted small">${n === 0 ? "up to date" : "not checked"}</span>`;
											})()}
										</td>
										<td class="hide-sm mono small wrap">${stack.directory ?? html`<span class="muted">set on first deploy</span>`}</td>
										<td class="right">
											${stack.movedTo !== null ? html`<a class="button small" href="/stacks/${stack.movedTo}">New copy</a>` : actionForm(stack, "deploy", "Deploy", csrf, "", true)}
										</td>
									</tr>`;
								})}
							</tbody>
						</table>
					</div>`
		}
		${
			unmanaged.length > 0
				? html`<section class="group">
						<h2 class="group-title">Running projects not managed here <span class="muted">${unmanaged.length}</span></h2>
						<p class="muted small">Adopting reads the compose file and .env where the project lives, and from then on edits are written back there.</p>
						<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Project</th>
										<th>Containers</th>
										<th class="hide-sm">Folder</th>
										<th class="right"><span class="visually-hidden">Actions</span></th>
									</tr>
								</thead>
								<tbody>
									${unmanaged.map((g) => {
										const labels = g.containers[0]?.labels ?? {};
										const files = (labels["com.docker.compose.project.config_files"] ?? "").split(",").filter((f) => f);
										return html`<tr>
											<td class="strong">${g.name}</td>
											<td>${g.containers.filter((c) => c.state === "running").length}/${g.containers.length} running</td>
											<td class="hide-sm mono small wrap">${labels["com.docker.compose.project.working_dir"] ?? html`<span class="muted">unknown</span>`}</td>
											<td class="right">
												${
													files.length === 1
														? html`<a class="button small" href="/hosts/${view.host.id}/stacks/new?adopt=${encodeURIComponent(g.name!)}">Adopt</a>`
														: html`<span class="muted small">${files.length === 0 ? "no compose file recorded" : `${files.length} compose files`}</span>`
												}
											</td>
										</tr>`;
									})}
								</tbody>
							</table>
						</div>
					</section>`
				: ""
		}`;
}

export interface EditorInput {
	action: string;
	csrf: string;
	isNew: boolean;
	name: string;
	compose: string;
	env: string;
	message: string;
	issues: Issue[];
	error?: string | null;
	check?: { ok: boolean; output: string } | null;
	adopt?: { directory: string; file: string } | null;
	nameError?: string | null;
}

function issueList(issues: Issue[]): SafeHtml {
	if (issues.length === 0) return html``;
	return html`<ul class="issues" data-issues>
		${issues.map(
			(i) =>
				html`<li class="issue issue-${i.severity}">
					<span class="badge badge-${i.severity === "error" ? "bad" : "warn"}">${i.severity === "error" ? "error" : "warning"}</span>
					<span class="mono small">line ${i.line}</span>
					<span>${i.message}</span>
				</li>`,
		)}
	</ul>`;
}

export function editorForm(input: EditorInput): SafeHtml {
	return html`<form method="post" action="${input.action}" class="stack editor-form" data-editor-form>
		<input type="hidden" name="_csrf" value="${input.csrf}" />
		${input.error ? html`<div class="flash flash-error" role="alert">${input.error}</div>` : ""}
		${
			input.isNew
				? html`<section class="panel">
						<label
							>Name
							<input
								name="name"
								required
								maxlength="63"
								value="${input.name}"
								${input.adopt ? "readonly" : ""}
								pattern="[a-z0-9][a-z0-9_-]*"
								autocomplete="off"
								spellcheck="false"
							/>
							<small>${input.nameError ?? "The compose project name. Containers are named after it, so it cannot change later."}</small>
						</label>
						${
							input.adopt
								? html`<input type="hidden" name="adopt" value="1" />
										<input type="hidden" name="directory" value="${input.adopt.directory}" />
										<input type="hidden" name="file" value="${input.adopt.file}" />
										<p class="muted small">
											Files stay in <span class="mono">${input.adopt.directory}/${input.adopt.file}</span> and are written back there on deploy.
										</p>`
								: ""
						}
					</section>`
				: ""
		}
		<section class="panel">
			<div class="editor-head">
				<label for="compose-input">Compose file</label>
				<span class="muted small" data-editor-status
					>${input.issues.length === 0 ? "No problems found" : `${input.issues.length} problem${input.issues.length === 1 ? "" : "s"}`}</span
				>
			</div>
			<textarea id="compose-input" name="compose" class="code" rows="24" spellcheck="false" autocapitalize="off" data-editor="yaml">${input.compose}</textarea>
			${issueList(input.issues)}
		</section>
		<section class="panel">
			<div class="editor-head">
				<label for="env-input">Environment file (.env)</label>
				<span class="muted small">Encrypted on the controller, written next to the compose file with mode 600</span>
			</div>
			<textarea
				id="env-input"
				name="env"
				class="code"
				rows="6"
				spellcheck="false"
				autocapitalize="off"
				data-editor="env"
				placeholder="POSTGRES_PASSWORD=change-me"
			>
${input.env}</textarea>
		</section>
		${
			input.check
				? html`<section class="panel check check-${input.check.ok ? "ok" : "bad"}" role="status">
						<h2>${input.check.ok ? "The host accepts this file" : "The host refused this file"}</h2>
						${input.check.output ? html`<pre class="mono">${input.check.output}</pre>` : html`<p class="muted">docker compose config found no problems.</p>`}
					</section>`
				: ""
		}
		<section class="panel editor-actions">
			<label class="grow"
				><span>What changed <span class="muted small">optional</span></span>
				<input name="message" maxlength="200" value="${input.message}" placeholder="Raise the memory limit" />
			</label>
			<div class="actions">
				<button class="button primary" type="submit" name="intent" value="deploy">Save and deploy</button>
				<button class="button" type="submit" name="intent" value="save">Save</button>
				<button class="button" type="submit" name="intent" value="check" formnovalidate>Check on host</button>
			</div>
		</section>
	</form>`;
}

function stackTabs(stack: Stack, current: StackTab): SafeHtml {
	return html`<nav class="tabs" aria-label="Stack sections">
		${TABS.map(([key, label]) => html`<a href="/hosts/${stack.hostId}/stacks/${stack.id}${key === "editor" ? "" : `?tab=${key}`}" ${key === current ? html`aria-current="page"` : ""}>${label}</a>`)}
	</nav>`;
}

function updatesNote(stack: Stack, count: number | null): SafeHtml {
	if (count === null) return html`<strong class="muted">not checked yet</strong>`;
	if (count === 0) return html`<strong>up to date</strong>`;
	return html`<strong><a href="/hosts/${stack.hostId}/stacks/${stack.id}?tab=updates">${count} available</a></strong>`;
}

export function stackSummary(view: HostView, stack: Stack, containers: ContainerSummary[], lastDeploy: Deploy | null, updates: number | null = null): SafeHtml {
	return html`<section class="summary cols-4" aria-label="Summary">
		<div class="summary-item"><span>Status</span>${stateBadge(stackState(stack, containers, view.online))}</div>
		<div class="summary-item"><span>Version</span><strong>v${stack.currentVersion}</strong>${versionNote(stack)}</div>
		<div class="summary-item">
			<span>Last change</span>
			${
				lastDeploy
					? html`<strong
								><a href="/hosts/${stack.hostId}/stacks/${stack.id}/deploys/${lastDeploy.id}"
									>${ACTION_LABEL[lastDeploy.action]} ${ago(lastDeploy.startedAt)}</a
								></strong
							>${deployStatusBadge(lastDeploy.status)}`
					: html`<strong>never</strong>`
			}
		</div>
		<div class="summary-item"><span>Updates</span>${updatesNote(stack, updates)}</div>
	</section>`;
}

export function stackPage(input: {
	view: HostView;
	stack: Stack;
	tab: StackTab;
	csrf: string;
	containers: ContainerSummary[];
	lastDeploy: Deploy | null;
	editor?: SafeHtml;
	versions?: Omit<StackVersion, "compose" | "env">[];
	deploys?: Deploy[];
	updates?: SafeHtml;
	updateCount?: number | null;
	backups?: SafeHtml;
	/** Set when the stack was transferred: where the new copy is. */
	moved?: { stackId: number; hostName: string } | null;
}): SafeHtml {
	const { view, stack, tab } = input;
	const movedNotice = input.moved
		? html`<div class="flash flash-info" role="status">
				Transferred to ${input.moved.hostName}. <a href="/stacks/${input.moved.stackId}">Open the new copy</a>. This copy stays stopped and its volumes and
				files are kept. Starting it is blocked so two copies never run at once. Remove it here when the old data is no longer needed.
			</div>`
		: "";
	let body: SafeHtml;
	if (tab === "services") {
		body =
			input.containers.length === 0
				? html`<p class="empty-inline">No containers. Deploy the stack to start them.</p>`
				: containerTable(view, input.containers, input.csrf, `/hosts/${stack.hostId}/stacks/${stack.id}?tab=services`);
	} else if (tab === "history") {
		body = historyTab(stack, input.versions ?? [], input.deploys ?? []);
	} else if (tab === "updates") {
		body = input.updates ?? html``;
	} else if (tab === "backups") {
		body = input.backups ?? html``;
	} else if (tab === "settings") {
		body = settingsTab(stack, input.csrf);
	} else {
		body = input.editor ?? html``;
	}
	const live = html`${movedNotice}
		<div data-live="stack">${stackSummary(view, stack, input.containers, input.lastDeploy, input.updateCount ?? null)} ${stackTabs(stack, tab)}</div>`;
	return tab === "editor"
		? html`${live}${body}`
		: html`${live}
				<div data-live="stack-body">${body}</div>`;
}

function historyTab(stack: Stack, versions: Omit<StackVersion, "compose" | "env">[], deploys: Deploy[]): SafeHtml {
	return html`<div class="columns columns-start">
		<section class="panel">
			<h2>Versions</h2>
			<ul class="timeline">
				${versions.map(
					(v) =>
						html`<li>
							<div class="timeline-head">
								<a class="strong" href="/hosts/${stack.hostId}/stacks/${stack.id}/versions/${v.number}">v${v.number}</a>
								${v.number === stack.deployedVersion ? html`<span class="chip chip-ok">deployed</span>` : ""}
								${v.number === stack.currentVersion ? html`<span class="chip">current</span>` : ""}
								<span class="muted small" title="${dateTime(v.createdAt)}">${ago(v.createdAt)}${v.username ? ` by ${v.username}` : ""}</span>
							</div>
							${v.message ? html`<p class="small">${v.message}</p>` : ""}
						</li>`,
				)}
			</ul>
		</section>
		<section class="panel">
			<h2>Deploys and actions</h2>
			${
				deploys.length === 0
					? html`<p class="muted">Nothing has run yet.</p>`
					: html`<ul class="timeline">
							${deploys.map(
								(d) =>
									html`<li>
										<div class="timeline-head">
											<a class="strong" href="/hosts/${stack.hostId}/stacks/${stack.id}/deploys/${d.id}"
												>${ACTION_LABEL[d.action]}${d.version ? ` v${d.version}` : ""}</a
											>
											${deployStatusBadge(d.status)}
											<span class="muted small" title="${dateTime(d.startedAt)}">${ago(d.startedAt)}${d.username ? ` by ${d.username}` : ""}</span>
										</div>
									</li>`,
							)}
						</ul>`
			}
		</section>
	</div>`;
}

function settingsTab(stack: Stack, csrf: string): SafeHtml {
	return html`<section class="panel narrow stack">
			<h2>Files on the host</h2>
			<p class="path">${stack.directory ? `${stack.directory}/${stack.file}` : "Chosen by the agent on the first deploy."}</p>
			${stack.adopted ? html`<p class="muted small">Adopted, so deploys write back to the folder it was started from.</p>` : ""}
		</section>
		<section class="panel narrow stack">
			<h2>Take down</h2>
			<p class="muted">Stops and removes the containers and networks of this stack. Volumes and files stay, so a deploy brings it back.</p>
			<div>${actionForm(stack, "down", "Take down", csrf)}</div>
		</section>
		<section class="panel narrow stack">
			<h2>Pull images</h2>
			<p class="muted">Downloads newer images for the tags in the compose file. Running containers keep their image until the next deploy.</p>
			<div>${actionForm(stack, "pull", "Pull images", csrf)}</div>
		</section>
		<section class="panel narrow stack danger-zone">
			<h2>Remove stack</h2>
			<p class="muted">Stops managing this stack here, with options to take it down and delete its files.</p>
			<div><a class="button danger" href="/hosts/${stack.hostId}/stacks/${stack.id}/remove">Remove stack</a></div>
		</section>`;
}

function diffView(before: string, after: string): SafeHtml {
	const all = diffLines(before, after);
	const parts = hunks(all);
	if (parts.length === 0) return html`<p class="muted">The compose file did not change.</p>`;
	return html`<div class="diff">
		${parts.map(
			(h) =>
				html`<table class="diff-hunk">
					${h.lines.map(
						(l) =>
							html`<tr class="diff-${l.kind}">
								<td class="diff-no">${l.oldNo ?? ""}</td>
								<td class="diff-no">${l.newNo ?? ""}</td>
								<td class="diff-sign">${l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</td>
								<td class="diff-text">${l.text}</td>
							</tr>`,
					)}
				</table>`,
		)}
	</div>`;
}

export function versionPage(stack: Stack, version: StackVersion, previous: StackVersion | null, csrf: string): SafeHtml {
	const env = envChanges(previous?.env ?? "", version.env);
	const envNote = [
		env.added.length ? `added ${env.added.join(", ")}` : "",
		env.removed.length ? `removed ${env.removed.join(", ")}` : "",
		env.changed.length ? `changed ${env.changed.join(", ")}` : "",
	].filter((x) => x);
	return html`<section class="panel">
			<div class="section-head">
				<div>
					<h2>${previous ? `Changes from v${previous.number}` : "First version"}</h2>
					<p class="muted small">
						${dateTime(version.createdAt)}${version.username ? ` by ${version.username}` : ""}${version.message ? `: ${version.message}` : ""}
					</p>
				</div>
				${
					version.number !== stack.currentVersion
						? html`<form method="post" action="/hosts/${stack.hostId}/stacks/${stack.id}/versions/${version.number}/restore" class="inline">
								<input type="hidden" name="_csrf" value="${csrf}" />
								<button class="button" type="submit">Restore this version</button>
							</form>`
						: ""
				}
			</div>
			${diffView(previous?.compose ?? "", version.compose)}
		</section>
		<section class="panel">
			<h2>Environment file</h2>
			<p class="muted">${envNote.length > 0 ? `Keys ${envNote.join(", ")}. Values are not shown.` : "No changes."}</p>
		</section>`;
}

export function deployPage(input: { stack: Stack; deploy: Deploy; output: string; total: number; csrf: string }): SafeHtml {
	const { deploy, stack } = input;
	const seconds = deploy.finishedAt ? Math.max(0, Math.round((Date.parse(deploy.finishedAt) - Date.parse(deploy.startedAt)) / 1000)) : null;
	return html`<section class="summary cols-4" aria-label="Summary" data-live="deploy">
			<div class="summary-item"><span>Result</span>${deployStatusBadge(deploy.status)}</div>
			<div class="summary-item"><span>Action</span><strong>${ACTION_LABEL[deploy.action]}${deploy.version ? ` v${deploy.version}` : ""}</strong></div>
			<div class="summary-item">
				<span>Started</span><strong title="${dateTime(deploy.startedAt)}">${ago(deploy.startedAt)}${deploy.username ? ` by ${deploy.username}` : ""}</strong>
			</div>
			<div class="summary-item"><span>Took</span><strong>${seconds === null ? "still running" : `${seconds} s`}</strong></div>
		</section>
		${jobOutputPanel({ key: `deploy:${deploy.id}`, output: input.output, total: input.total, running: deploy.status === "running", back: { href: `/hosts/${stack.hostId}/stacks/${stack.id}`, label: "Back to the stack" } })}`;
}

export function removeStackPage(stack: Stack, csrf: string, canDeleteFiles: boolean): SafeHtml {
	return html`<section class="panel narrow stack">
		<p>Stop managing <strong>${stack.name}</strong> from here?</p>
		<form method="post" action="/hosts/${stack.hostId}/stacks/${stack.id}/remove" class="stack">
			<input type="hidden" name="_csrf" value="${csrf}" />
			<label class="check"
				><input type="checkbox" name="down" value="1" checked /> Take it down first: stop and remove its containers and networks. Volumes stay.</label
			>
			${
				canDeleteFiles
					? html`<label class="check"><input type="checkbox" name="files" value="1" /> Delete its folder on the host</label>`
					: html`<p class="muted small">Its files on the host stay where they are${stack.adopted ? ", because it was adopted" : ""}.</p>`
			}
			<p class="muted small">The version history is deleted with it.</p>
			<div class="actions">
				<button class="button danger" type="submit">Remove stack</button>
				<a class="button" href="/hosts/${stack.hostId}/stacks/${stack.id}?tab=settings">Cancel</a>
			</div>
		</form>
	</section>`;
}
