import type { ContainerDetail, ContainerSummary, DiskUsage, HostFacts, MetricsSample, Snapshot, StorageReport } from "../../../shared/protocol.ts";
import type { AuditEntry } from "../../db/audit.ts";
import type { Host } from "../../db/hosts.ts";
import { ago, bytes, dateTime, portRows, shortId, stateTone, type PortRow } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { dot } from "../layout.ts";
import type { Range } from "../../db/metrics.ts";
import { chartsPanel, containerValues, engineDiskPanel, filesystemsPanel, hostValues, live } from "./metrics.ts";

export interface HostView {
	host: Host;
	online: boolean;
	facts: HostFacts | null;
	snapshot: Snapshot | null;
	latest: MetricsSample | null;
	disk: DiskUsage | null;
	storage: StorageReport | null;
}

function cpusOf(view: HostView): number | null {
	return view.latest?.host?.cpus ?? (view.facts ?? view.host.facts)?.cpus ?? null;
}

export function stateBadge(state: string): SafeHtml {
	return html`<span class="badge badge-${stateTone(state)}">${state}</span>`;
}

function hostStatus(view: HostView): SafeHtml {
	if (!view.host.enrolled) return html`<span class="badge badge-warn">Waiting to join</span>`;
	return view.online ? html`<span class="badge badge-ok">Online</span>` : html`<span class="badge badge-bad">Offline</span>`;
}

function exposureChip(row: PortRow): SafeHtml {
	if (row.publicPort === null) return html`<span class="chip">not published</span>`;
	if (row.exposure === "local") return html`<span class="chip chip-ok" title="Only reachable from this host">local</span>`;
	return html`<span class="chip chip-warn" title="Reachable from every network this host is on">public</span>`;
}

function portsCell(container: ContainerSummary): SafeHtml {
	const rows = portRows(container.ports).filter((r) => r.publicPort !== null);
	if (rows.length === 0) return html`<span class="muted">none</span>`;
	return html`<ul class="ports">
		${rows.map((r) => html`<li><span class="mono">${r.publicPort}->${r.privatePort}/${r.type}</span>${r.exposure === "public" ? html` <span class="chip chip-warn">public</span>` : ""}</li>`)}
	</ul>`;
}

export function actionButtons(hostId: number, container: { id: string; state: string }, csrf: string, next: string, compact = false): SafeHtml {
	const running = container.state === "running" || container.state === "restarting";
	const button = (action: string, label: string, tone = "") =>
		html`<button class="button${compact ? " small" : ""}${tone}" type="submit" name="action" value="${action}">${label}</button>`;
	return html`<form class="actions" method="post" action="/hosts/${hostId}/containers/${container.id}/action">
		<input type="hidden" name="_csrf" value="${csrf}" />
		<input type="hidden" name="next" value="${next}" />
		${running ? [button("stop", "Stop"), button("restart", "Restart")] : button("start", "Start", " primary")}
	</form>`;
}

function runningCount(snapshot: Snapshot | null): { running: number; total: number } {
	const containers = snapshot?.containers ?? [];
	return { running: containers.filter((c) => c.state === "running").length, total: containers.length };
}

function publicPorts(snapshot: Snapshot | null): number {
	return (snapshot?.containers ?? []).reduce((n, c) => n + portRows(c.ports).filter((r) => r.exposure === "public").length, 0);
}

export function overviewPage(views: HostView[], updates = 0): SafeHtml {
	const online = views.filter((v) => v.online).length;
	const totals = views.reduce(
		(acc, v) => {
			const c = runningCount(v.snapshot);
			acc.running += c.running;
			acc.total += c.total;
			acc.images += v.snapshot?.images.length ?? 0;
			acc.volumes += v.snapshot?.volumes.length ?? 0;
			acc.public += publicPorts(v.snapshot);
			return acc;
		},
		{ running: 0, total: 0, images: 0, volumes: 0, public: 0 },
	);
	if (views.length === 0) {
		return html`<section class="empty">
			<h2>No hosts yet</h2>
			<p>Add a server or VM, run one command on it, and it shows up here with all its containers.</p>
			<a class="button primary" href="/hosts/new">Add the first host</a>
		</section>`;
	}
	return html`<div data-live="overview">
		<section class="stats" aria-label="Totals">
			<div class="stat">
				<span class="stat-label">Hosts online</span><span class="stat-value">${online}<small>/${views.length}</small></span>
			</div>
			<div class="stat">
				<span class="stat-label">Containers up</span><span class="stat-value">${totals.running}<small>/${totals.total}</small></span>
			</div>
			<div class="stat"><span class="stat-label">Images</span><span class="stat-value">${totals.images}</span></div>
			<div class="stat"><span class="stat-label">Volumes</span><span class="stat-value">${totals.volumes}</span></div>
			<div class="stat${totals.public > 0 ? " stat-warn" : ""}">
				<span class="stat-label">Public ports</span><span class="stat-value">${totals.public}</span>
			</div>
			<a class="stat stat-link${updates > 0 ? " stat-accent" : ""}" href="/updates">
				<span class="stat-label">Updates</span><span class="stat-value">${updates}</span>
			</a>
		</section>
		<section class="host-grid" aria-label="Hosts">
			${views.map((v) => {
				const c = runningCount(v.snapshot);
				const facts = v.facts ?? v.host.facts;
				return html`<a class="host-card" href="/hosts/${v.host.id}">
					<div class="host-card-head">
						<h2>${v.host.name}</h2>
						${hostStatus(v)}
					</div>
					${
						facts
							? html`<dl class="facts">
									<div>
										<dt>System</dt>
										<dd>${facts.os}</dd>
									</div>
									<div>
										<dt>Runtime</dt>
										<dd>${facts.runtime === "podman" ? "Podman" : "Docker"} ${facts.runtimeVersion}${facts.rootless ? " rootless" : ""}</dd>
									</div>
									${
										v.online
											? html`<div>
														<dt>CPU</dt>
														<dd>${live(v.host.id, "", "cpu", hostValues(v.latest?.host), { meter: true, detail: `of ${facts.cpus} CPU` })}</dd>
													</div>
													<div>
														<dt>Memory</dt>
														<dd>${live(v.host.id, "", "mem", hostValues(v.latest?.host), { meter: true, detail: `of ${bytes(facts.memoryBytes)}` })}</dd>
													</div>`
											: html`<div>
													<dt>Resources</dt>
													<dd>${facts.cpus} CPU, ${bytes(facts.memoryBytes)}</dd>
												</div>`
									}
									<div>
										<dt>Containers</dt>
										<dd>${v.online ? `${c.running} running of ${c.total}` : "unknown while offline"}</dd>
									</div>
								</dl>`
							: html`<p class="muted">${v.host.enrolled ? "No facts reported yet." : "Run the join command on this host."}</p>`
					}
					<p class="host-card-foot muted">${v.online ? "Connected" : v.host.lastSeenAt ? `Last seen ${ago(v.host.lastSeenAt)}` : "Never connected"}</p>
				</a>`;
			})}
		</section>
	</div>`;
}

export function newHostPage(csrf: string, name = "", error?: string): SafeHtml {
	return html`<section class="panel narrow">
		<form method="post" action="/hosts" class="stack">
			<input type="hidden" name="_csrf" value="${csrf}" />
			<label
				>Name
				<input name="name" required maxlength="64" value="${name}" autofocus placeholder="web-1" />
				<small>${error ?? "How the host appears here. Its real hostname is reported by the agent."}</small>
			</label>
			<button class="button primary" type="submit">Create join command</button>
		</form>
	</section>`;
}

export function joinPage(input: { host: Host; command: string | null; minutes: number; csrf: string; domain: string }): SafeHtml {
	const { host } = input;
	return html`<section class="panel" data-live="join">
		${
			host.enrolled
				? html`<p>
						This host joined ${ago(host.enrolledAt)}. A new join command lets you move the agent to a reinstalled machine. The current agent keeps working until
						the new one joins.
					</p>`
				: html`<p>
						Run this on the server as root. It installs the agent as a system service, which connects out to this controller, so the host needs no open port.
					</p>`
		}
		${
			input.command
				? html`<div class="command">
							<pre class="mono" id="join-command">${input.command}</pre>
							<button class="button small" type="button" data-copy="join-command">Copy</button>
						</div>
						<p class="muted">The token works once and expires in ${input.minutes} minutes. It is not shown again after you leave this page.</p>
						<details>
							<summary>Run the agent from a source checkout instead</summary>
							<pre class="mono">
bun run agent enroll --url ${input.domain} --token ${input.command.match(/--token (\S+)/)?.[1] ?? ""}
bun run agent</pre>
						</details>`
				: html`<form method="post" action="/hosts/${host.id}/join" class="inline">
						<input type="hidden" name="_csrf" value="${input.csrf}" />
						<button class="button primary" type="submit">${host.enrolled || host.joinPending ? "Create a new join command" : "Create join command"}</button>
					</form>`
		}
		${!host.enrolled ? html`<p class="muted" data-waiting>Waiting for the agent to connect. This page updates on its own.</p>` : ""}
	</section>`;
}

const TABS = [
	["containers", "Containers"],
	["stacks", "Stacks"],
	["metrics", "Metrics"],
	["storage", "Storage"],
	["images", "Images"],
	["volumes", "Volumes"],
	["networks", "Networks"],
	["firewall", "Firewall"],
	["settings", "Settings"],
] as const;

export type HostTab = (typeof TABS)[number][0];

export function isHostTab(value: string | null): value is HostTab {
	return TABS.some(([key]) => key === value);
}

function tabs(hostId: number, current: HostTab): SafeHtml {
	return html`<nav class="tabs" aria-label="Host sections">
		${TABS.map(([key, label]) => html`<a href="/hosts/${hostId}${key === "containers" ? "" : `?tab=${key}`}" ${key === current ? html`aria-current="page"` : ""}>${label}</a>`)}
	</nav>`;
}

function factsPanel(view: HostView): SafeHtml {
	const facts = view.facts ?? view.host.facts;
	const c = runningCount(view.snapshot);
	return html`<section class="summary cols-4" aria-label="Summary">
		<div class="summary-item"><span>Status</span>${hostStatus(view)}</div>
		<div class="summary-item"><span>Hostname</span><strong>${facts?.hostname ?? view.host.hostname ?? "unknown"}</strong></div>
		<div class="summary-item">
			<span>System</span><strong>${facts?.os ?? "unknown"}</strong>${facts ? html`<span class="muted small">kernel ${facts.kernel}, ${facts.arch}</span>` : ""}
		</div>
		<div class="summary-item">
			<span>Runtime</span
			><strong
				>${facts ? `${facts.runtime === "podman" ? "Podman" : "Docker"} ${facts.runtimeVersion}${facts.rootless ? ", rootless" : ""}` : "unknown"}</strong
			>
		</div>
		${
			view.online
				? html`<div class="summary-item summary-metric">
							<span>CPU</span
							><strong>${live(view.host.id, "", "cpu", hostValues(view.latest?.host), { meter: true, detail: facts ? `of ${facts.cpus} CPU` : "" })}</strong>
						</div>
						<div class="summary-item summary-metric">
							<span>Memory</span
							><strong
								>${live(view.host.id, "", "mem", hostValues(view.latest?.host), { meter: true, detail: facts ? `of ${bytes(facts.memoryBytes)}` : "" })}</strong
							>
						</div>`
				: html`<div class="summary-item"><span>Resources</span><strong>${facts ? `${facts.cpus} CPU, ${bytes(facts.memoryBytes)}` : "unknown"}</strong></div>
						<div class="summary-item"><span>Last seen</span><strong>${view.host.lastSeenAt ? ago(view.host.lastSeenAt) : "never"}</strong></div>`
		}
		<div class="summary-item"><span>Containers</span><strong>${view.online ? `${c.running} running of ${c.total}` : "unknown"}</strong></div>
		<div class="summary-item"><span>Agent</span><strong>${facts?.agentVersion ?? "unknown"}</strong></div>
	</section>`;
}

/** Compose projects first, by name, then containers that belong to none. */
export function groupByProject(containers: ContainerSummary[]): { name: string | null; containers: ContainerSummary[] }[] {
	const groups = new Map<string | null, ContainerSummary[]>();
	for (const c of containers) {
		const list = groups.get(c.project) ?? [];
		list.push(c);
		groups.set(c.project, list);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
		.map(([name, list]) => ({ name, containers: list.sort((x, y) => (x.service ?? x.name).localeCompare(y.service ?? y.name)) }));
}

/** The containers of one compose project or of none, with live CPU and memory and the actions. */
export function containerTable(view: HostView, containers: ContainerSummary[], csrf: string, next: string): SafeHtml {
	const byName = new Map((view.latest?.containers ?? []).map((m) => [m.name, m]));
	return html`<div class="table-wrap">
		<table class="table containers">
			<colgroup>
				<col class="col-name" />
				<col class="col-state" />
				<col class="col-ports" />
				<col class="col-cpu" />
				<col class="col-mem" />
				<col class="col-actions" />
			</colgroup>
			<thead>
				<tr>
					<th>Name</th>
					<th class="hide-sm">State</th>
					<th class="hide-sm">Ports</th>
					<th class="hide-sm">CPU</th>
					<th class="hide-sm">Memory</th>
					<th class="right"><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				${containers.map(
					(c) =>
						html`<tr>
							<td>
								<a class="strong wrap" href="/hosts/${view.host.id}/containers/${c.id}">${c.name}</a>
								<div class="muted small mono wrap hide-sm">${c.image}</div>
								<div class="muted small show-sm">${dot(stateTone(c.state), c.state)}${c.status}</div>
							</td>
							<td class="hide-sm">
								${stateBadge(c.state)}
								<div class="muted small">${c.status}</div>
							</td>
							<td class="hide-sm">${portsCell(c)}</td>
							<td class="hide-sm">
								${c.state === "running" ? live(view.host.id, c.name, "cpu", containerValues(byName.get(c.name), cpusOf(view)), { meter: true }) : html`<span class="muted">none</span>`}
							</td>
							<td class="hide-sm">
								${c.state === "running" ? live(view.host.id, c.name, "mem", containerValues(byName.get(c.name), cpusOf(view)), { meter: true }) : html`<span class="muted">none</span>`}
							</td>
							<td class="right">${actionButtons(view.host.id, c, csrf, next, true)}</td>
						</tr>`,
				)}
			</tbody>
		</table>
	</div>`;
}

function containersTab(view: HostView, csrf: string, stacks: Map<string, number>): SafeHtml {
	const snapshot = view.snapshot;
	if (!snapshot) return offlineNote(view);
	if (snapshot.containers.length === 0) return html`<p class="empty-inline">No containers on this host yet.</p>`;
	return html`${groupByProject(snapshot.containers).map((group) => {
		const stackId = group.name === null ? undefined : stacks.get(group.name);
		return html`<section class="group">
			<h2 class="group-title">
				${group.name ?? "Standalone containers"} <span class="muted">${group.containers.length}</span>
				${stackId !== undefined ? html`<a class="chip chip-link" href="/hosts/${view.host.id}/stacks/${stackId}">Stack</a>` : ""}
			</h2>
			${containerTable(view, group.containers, csrf, `/hosts/${view.host.id}`)}
		</section>`;
	})}`;
}

function offlineNote(view: HostView): SafeHtml {
	if (!view.host.enrolled) {
		return html`<section class="empty">
			<h2>This host has not joined yet</h2>
			<p>Create a join command and run it on the server.</p>
			<a class="button primary" href="/hosts/${view.host.id}/join">Join command</a>
		</section>`;
	}
	return html`<section class="empty">
		<h2>The agent is offline</h2>
		<p>
			${view.host.lastSeenAt ? `Last seen ${ago(view.host.lastSeenAt)}.` : "It never connected."} Check that the service runs on the host with
			<code>systemctl status dockermanager-agent</code>.
		</p>
	</section>`;
}

function imagesTab(view: HostView): SafeHtml {
	if (!view.snapshot) return offlineNote(view);
	const used = new Set(view.snapshot.containers.map((c) => c.imageId));
	const images = [...view.snapshot.images].sort((a, b) => b.created - a.created);
	return html`<div class="table-wrap">
		<table class="table">
			<thead>
				<tr>
					<th>Tags</th>
					<th>Id</th>
					<th class="right">Size</th>
					<th class="hide-sm">Created</th>
					<th class="hide-sm">Used</th>
				</tr>
			</thead>
			<tbody>
				${images.map(
					(i) =>
						html`<tr>
							<td class="mono small wrap">${i.tags.length > 0 ? i.tags.join(", ") : html`<span class="muted">untagged</span>`}</td>
							<td class="mono small">${shortId(i.id)}</td>
							<td class="right nowrap">${bytes(i.size)}</td>
							<td class="hide-sm nowrap">${ago(i.created * 1000)}</td>
							<td class="hide-sm">${used.has(i.id) ? html`<span class="chip chip-ok">in use</span>` : html`<span class="chip">unused</span>`}</td>
						</tr>`,
				)}
			</tbody>
		</table>
	</div>`;
}

function volumesTab(view: HostView): SafeHtml {
	if (!view.snapshot) return offlineNote(view);
	const users = new Map<string, string[]>();
	for (const c of view.snapshot.containers) for (const m of c.mounts) if (m.name) users.set(m.name, [...(users.get(m.name) ?? []), c.name]);
	return html`<div class="table-wrap">
		<table class="table">
			<thead>
				<tr>
					<th>Name</th>
					<th class="hide-sm">Project</th>
					<th>Used by</th>
					<th class="right">Size</th>
					<th class="hide-sm">Driver</th>
				</tr>
			</thead>
			<tbody>
				${view.snapshot.volumes.map(
					(v) =>
						html`<tr>
							<td class="mono small wrap">${v.name}</td>
							<td class="hide-sm">${v.project ?? html`<span class="muted">none</span>`}</td>
							<td>${users.get(v.name)?.join(", ") ?? html`<span class="muted">nothing</span>`}</td>
							<td class="right nowrap">
								${view.disk && v.name in view.disk.volumes ? bytes(view.disk.volumes[v.name]!) : html`<span class="muted">unknown</span>`}
							</td>
							<td class="hide-sm">${v.driver}</td>
						</tr>`,
				)}
			</tbody>
		</table>
	</div>`;
}

function networksTab(view: HostView): SafeHtml {
	if (!view.snapshot) return offlineNote(view);
	return html`<div class="table-wrap">
		<table class="table">
			<thead>
				<tr>
					<th>Name</th>
					<th>Driver</th>
					<th class="hide-sm">Scope</th>
					<th class="hide-sm">Id</th>
				</tr>
			</thead>
			<tbody>
				${view.snapshot.networks.map(
					(n) =>
						html`<tr>
							<td>${n.name}</td>
							<td>${n.driver}</td>
							<td class="hide-sm">${n.scope}</td>
							<td class="hide-sm mono small">${shortId(n.id)}</td>
						</tr>`,
				)}
			</tbody>
		</table>
	</div>`;
}

function settingsTab(view: HostView, csrf: string): SafeHtml {
	return html`<section class="panel narrow stack">
			<form method="post" action="/hosts/${view.host.id}/rename" class="stack">
				<input type="hidden" name="_csrf" value="${csrf}" />
				<label>Name <input name="name" required maxlength="64" value="${view.host.name}" /></label>
				<div><button class="button" type="submit">Rename</button></div>
			</form>
		</section>
		<section class="panel narrow stack">
			<h2>Join command</h2>
			<p class="muted">Reinstalled the server or lost the agent state file? Create a new join command and run it there.</p>
			<div><a class="button" href="/hosts/${view.host.id}/join">Join command</a></div>
		</section>
		<section class="panel narrow stack danger-zone">
			<h2>Remove host</h2>
			<p class="muted">The agent is disconnected and can no longer sign in. Containers on the server keep running.</p>
			<div><a class="button danger" href="/hosts/${view.host.id}/remove">Remove host</a></div>
		</section>`;
}

function storagePanels(view: HostView): SafeHtml {
	return html`<div class="columns">
		<section class="panel">
			<h2>Filesystems</h2>
			${filesystemsPanel(view.latest?.host?.filesystems ?? [])}
		</section>
		<section class="panel">
			<h2>${(view.facts ?? view.host.facts)?.runtime === "podman" ? "Podman" : "Docker"} storage</h2>
			${engineDiskPanel(view.disk)}
		</section>
	</div>`;
}

function storageTab(view: HostView): SafeHtml {
	const report = view.storage;
	if (!report)
		return html`<section class="panel">
			<h2>Physical storage</h2>
			<p class="muted">Waiting for the agent to report NVMe and RAID health.</p>
		</section>`;
	return html`<div class="stack">
		<p class="muted small">Checked ${ago(new Date(report.takenAt).toISOString())}${view.online ? "" : ", before the agent went offline"}.</p>
		<section class="panel">
			<h2>NVMe drives</h2>
			${report.smartctl === "missing" ? html`<p class="muted">Install smartmontools on this host to read NVMe health.</p>` : ""}
			${
				report.drives.length === 0
					? html`<p class="muted">No NVMe controllers found.</p>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Drive</th>
										<th>Health</th>
										<th>Life used</th>
										<th>Spare</th>
										<th>Temperature</th>
										<th>Media errors</th>
										<th>Written</th>
									</tr>
								</thead>
								<tbody>
									${report.drives.map((drive) => {
										const bad =
											drive.passed === false ||
											(drive.criticalWarning ?? 0) > 0 ||
											(drive.mediaErrors ?? 0) > 0 ||
											(drive.sparePercent !== null && drive.spareThresholdPercent !== null && drive.sparePercent <= drive.spareThresholdPercent);
										const worn = (drive.usedPercent ?? 0) >= 90;
										const label = drive.error ? "unavailable" : bad ? "check drive" : worn ? "replace soon" : "healthy";
										const tone = drive.error ? "idle" : bad ? "bad" : worn ? "warn" : "ok";
										return html`<tr>
											<td>
												<strong>${drive.device}</strong>
												<div class="muted small">${drive.model ?? "unknown model"}${drive.capacityBytes === null ? "" : `, ${bytes(drive.capacityBytes)}`}</div>
												<div class="muted small mono">${drive.serial ?? ""}</div>
											</td>
											<td><span class="badge badge-${tone}">${label}</span>${drive.error ? html`<div class="muted small">${drive.error}</div>` : ""}</td>
											<td>${drive.usedPercent === null ? "unknown" : `${drive.usedPercent}%`}</td>
											<td>${drive.sparePercent === null ? "unknown" : `${drive.sparePercent}%`}</td>
											<td>${drive.temperatureC === null ? "unknown" : html`${drive.temperatureC} &deg;C`}</td>
											<td>
												${drive.mediaErrors ?? "unknown"}
												<div class="muted small">${drive.errorLogEntries ?? "unknown"} log entries</div>
											</td>
											<td>
												${drive.dataWrittenBytes === null ? "unknown" : bytes(drive.dataWrittenBytes)}
												<div class="muted small">${drive.powerOnHours ?? "unknown"} hours on</div>
											</td>
										</tr>`;
									})}
								</tbody>
							</table>
						</div>`
			}
		</section>
		<section class="panel">
			<h2>Software RAID</h2>
			${
				report.arrays.length === 0
					? html`<p class="muted">No Linux MD arrays found.</p>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Array</th>
										<th>Level</th>
										<th>Members</th>
										<th>Status</th>
									</tr>
								</thead>
								<tbody>
									${report.arrays.map((array) => {
										const missing = array.degraded;
										const label = missing === null ? "unknown" : missing > 0 ? `${missing} missing` : "healthy";
										const tone = missing === null ? "idle" : missing > 0 ? "bad" : "ok";
										const members = array.raidDisks === null || missing === null ? "unknown" : `${array.raidDisks - missing} of ${array.raidDisks} drives`;
										return html`<tr>
											<td class="mono">${array.device}</td>
											<td>${array.level}</td>
											<td>${array.members.join(", ") || "unknown"}</td>
											<td>
												<span class="badge badge-${tone}">${label}</span>
												<div class="muted small">
													${members}, ${array.state}${array.syncAction && array.syncAction !== "idle" ? `, ${array.syncAction}` : ""}
												</div>
											</td>
										</tr>`;
									})}
								</tbody>
							</table>
						</div>`
			}
		</section>
	</div>`;
}

export function hostPage(view: HostView, tab: HostTab, csrf: string, options: { range?: Range; stacks?: Map<string, number>; body?: SafeHtml } = {}): SafeHtml {
	const range = options.range ?? "1h";
	const stacks = options.stacks ?? new Map<string, number>();
	if (tab === "firewall") {
		return html`<div data-live="host">${factsPanel(view)} ${tabs(view.host.id, tab)}</div>
			<div class="stack">${options.body ?? html``}</div>`;
	}
	if (tab === "metrics") {
		const top = html`<div data-live="host">${factsPanel(view)} ${tabs(view.host.id, tab)}</div>`;
		if (!view.online && view.latest === null)
			return html`${top}
				<div data-live="host-body">${offlineNote(view)}</div>
				${chartsPanel({ hostId: view.host.id, target: "", range, path: `/hosts/${view.host.id}?tab=metrics`, cpus: cpusOf(view), heading: "History" })}`;
		return html`${top}
			<div data-live="host-body">${storagePanels(view)}</div>
			${chartsPanel({ hostId: view.host.id, target: "", range, path: `/hosts/${view.host.id}?tab=metrics`, cpus: cpusOf(view), heading: "History" })}`;
	}
	const body =
		tab === "storage"
			? storageTab(view)
			: tab === "images"
				? imagesTab(view)
				: tab === "volumes"
					? volumesTab(view)
					: tab === "networks"
						? networksTab(view)
						: tab === "settings"
							? settingsTab(view, csrf)
							: tab === "stacks"
								? (options.body ?? html``)
								: containersTab(view, csrf, stacks);
	return html`<div data-live="host">${factsPanel(view)} ${tabs(view.host.id, tab)}</div>
		<div data-live="host-body">${body}</div>`;
}

export function removeHostPage(host: Host, csrf: string): SafeHtml {
	return html`<section class="panel narrow stack">
		<p>Remove <strong>${host.name}</strong> from the controller? The agent loses its access at once. Nothing changes on the server itself.</p>
		<form method="post" action="/hosts/${host.id}/remove" class="actions">
			<input type="hidden" name="_csrf" value="${csrf}" />
			<button class="button danger" type="submit">Remove host</button>
			<a class="button" href="/hosts/${host.id}?tab=settings">Cancel</a>
		</form>
	</section>`;
}

function kv(rows: ([string, SafeHtml | string | number | null] | false)[]): SafeHtml {
	return html`<dl class="kv">
		${rows
			.filter((row) => row !== false)
			.map(
				([k, v]) =>
					html`<div>
						<dt>${k}</dt>
						<dd>${v === null || v === "" ? html`<span class="muted">none</span>` : v}</dd>
					</div>`,
			)}
	</dl>`;
}

export function containerPage(input: {
	hostId: number;
	online: boolean;
	summary: ContainerSummary;
	detail: ContainerDetail | null;
	detailError: string | null;
	csrf: string;
	latest: MetricsSample | null;
	disk: DiskUsage | null;
	cpus: number | null;
	range: Range;
}): SafeHtml {
	const { summary, detail } = input;
	const metric = containerValues(
		input.latest?.containers.find((c) => c.name === summary.name),
		input.cpus,
	);
	const running = (detail?.state ?? summary.state) === "running";
	const writable = input.disk?.containers[summary.id];
	const ports = portRows(detail?.ports ?? summary.ports);
	const mounts = detail?.mounts ?? summary.mounts;
	const labels = Object.entries(detail?.labels ?? summary.labels).sort(([a], [b]) => a.localeCompare(b));
	return html`<div data-live="container">
			<section class="summary cols-4" aria-label="Summary">
				<div class="summary-item"><span>State</span>${stateBadge(detail?.state ?? summary.state)}</div>
				<div class="summary-item"><span>Health</span><strong>${detail?.health ?? "no healthcheck"}</strong></div>
				<div class="summary-item"><span>Started</span><strong>${detail?.startedAt ? ago(detail.startedAt) : summary.status}</strong></div>
				<div class="summary-item"><span>Restarts</span><strong>${detail?.restartCount ?? "unknown"}</strong></div>
				<div class="summary-item summary-metric">
					<span>CPU</span
					><strong
						>${running ? live(input.hostId, summary.name, "cpu", metric, { meter: true, detail: input.cpus ? `of ${input.cpus} CPU` : "" }) : "not running"}</strong
					>
				</div>
				<div class="summary-item summary-metric">
					<span>Memory</span
					><strong
						>${
							running
								? live(input.hostId, summary.name, "mem", metric, { meter: true, detail: metric?.memLimit ? `of ${bytes(metric.memLimit)}` : "" })
								: "not running"
						}</strong
					>
				</div>
				<div class="summary-item"><span>Network</span><strong>${running ? live(input.hostId, summary.name, "net", metric) : "not running"}</strong></div>
				<div class="summary-item">
					<span>Disk</span
					><strong>${writable === undefined ? "not measured yet" : `${bytes(writable)} written`}</strong
					>${running ? html`<span class="small">${live(input.hostId, summary.name, "blk", metric)}</span>` : ""}
				</div>
			</section>
			${input.detailError ? html`<div class="flash flash-error" role="alert">Details could not be read: ${input.detailError}</div>` : ""}
			${!input.online ? html`<div class="flash flash-error" role="alert">The agent is offline. This is the last known state.</div>` : ""}
			<div class="columns">
				<section class="panel">
					<h2>Container</h2>
					${kv([
						["Image", html`<span class="mono small wrap">${detail?.image ?? summary.image}</span>`],
						["Id", html`<span class="mono small">${shortId(summary.id)}</span>`],
						["Command", detail?.command ? html`<span class="mono small wrap">${detail.command}</span>` : null],
						["Compose project", summary.project],
						["Service", summary.service],
						["Restart policy", detail?.restartPolicy ?? null],
						["Networks", (detail?.networks ?? summary.networks).join(", ")],
						detail !== null && detail.state !== "running" && ["Exit code", detail.exitCode],
						detail?.finishedAt != null && detail.state !== "running" && ["Finished", dateTime(detail.finishedAt)],
					])}
				</section>
				<section class="panel">
					<h2>Ports</h2>
					${
						ports.length === 0
							? html`<p class="muted">No ports.</p>`
							: html`<ul class="port-list">
									${ports.map(
										(r) =>
											html`<li>
												<span class="mono"
													>${r.publicPort === null ? `${r.privatePort}/${r.type}` : `${r.addresses.join(", ")}:${r.publicPort} -> ${r.privatePort}/${r.type}`}</span
												>
												${exposureChip(r)}
											</li>`,
									)}
								</ul>`
					}
					<h2>Mounts</h2>
					${
						mounts.length === 0
							? html`<p class="muted">No mounts.</p>`
							: html`<ul class="mount-list">
									${mounts.map(
										(m) =>
											html`<li>
												<span class="chip">${m.type}</span>
												<span class="mono small wrap">${m.name ?? m.source} -> ${m.destination}</span>
												${m.name && input.disk && m.name in input.disk.volumes ? html`<span class="chip">${bytes(input.disk.volumes[m.name]!)}</span>` : ""}
												${m.rw ? "" : html`<span class="chip">read only</span>`}
											</li>`,
									)}
								</ul>`
					}
				</section>
			</div>
			<div class="columns columns-start">
				<section class="panel">
					<h2>Environment</h2>
					${
						detail === null
							? html`<p class="muted">Not available.</p>`
							: detail.envNames.length === 0
								? html`<p class="muted">No variables.</p>`
								: html`<p class="muted small">Names only. Values can hold secrets and are never sent to the controller.</p>
										<ul class="tags">
											${detail.envNames.map((n) => html`<li class="mono small">${n}</li>`)}
										</ul>`
					}
				</section>
				<section class="panel">
					<details>
						<summary>
							<h2>Labels <span class="muted">${labels.length}</span></h2>
						</summary>
						${kv(labels.map(([k, v]) => [k, html`<span class="mono small wrap">${v}</span>`]))}
					</details>
				</section>
			</div>
		</div>
		${chartsPanel({ hostId: input.hostId, target: summary.name, range: input.range, path: `/hosts/${input.hostId}/containers/${summary.id}`, cpus: input.cpus, heading: "Metrics", hostNetwork: summary.networks.includes("host") })}
		<section class="panel logs" data-logs data-host="${input.hostId}" data-container="${summary.id}">
			<div class="logs-head">
				<h2>Logs</h2>
				<div class="actions">
					<label class="inline-label"
						>Lines
						<select data-logs-tail>
							<option value="100">100</option>
							<option value="500" selected>500</option>
							<option value="2000">2000</option>
						</select>
					</label>
					<button class="button small" type="button" data-logs-follow aria-pressed="true">Following</button>
					<button class="button small" type="button" data-logs-clear>Clear</button>
				</div>
			</div>
			<pre class="log-output" data-logs-output tabindex="0" aria-live="off">${input.online ? "Connecting..." : "The agent is offline."}</pre>
		</section>`;
}

export function removeContainerPage(hostId: number, container: ContainerSummary, csrf: string): SafeHtml {
	const named = container.mounts.filter((m) => m.type === "volume");
	return html`<section class="panel narrow stack">
		<p>Remove <strong>${container.name}</strong>? A running container is stopped first.</p>
		${container.project ? html`<p class="muted">It belongs to the compose project ${container.project}. Running compose up again creates it again.</p>` : ""}
		<form method="post" action="/hosts/${hostId}/containers/${container.id}/remove" class="stack">
			<input type="hidden" name="_csrf" value="${csrf}" />
			${
				named.length > 0
					? html`<label class="check"><input type="checkbox" name="volumes" value="1" /> Also remove its anonymous volumes. Named volumes always stay.</label>`
					: ""
			}
			<div class="actions">
				<button class="button danger" type="submit">Remove container</button>
				<a class="button" href="/hosts/${hostId}/containers/${container.id}">Cancel</a>
			</div>
		</form>
	</section>`;
}

export function auditPage(entries: AuditEntry[]): SafeHtml {
	if (entries.length === 0) return html`<p class="empty-inline">Nothing recorded yet.</p>`;
	return html`<div class="table-wrap">
		<table class="table">
			<thead>
				<tr>
					<th>When</th>
					<th>Who</th>
					<th>Action</th>
					<th class="hide-sm">Host</th>
					<th class="hide-sm">Target</th>
					<th>Result</th>
				</tr>
			</thead>
			<tbody>
				${entries.map(
					(e) =>
						html`<tr>
							<td class="nowrap" title="${dateTime(e.createdAt)}">${ago(e.createdAt)}</td>
							<td>${e.username ?? html`<span class="muted">system</span>`}</td>
							<td class="mono small">${e.action}</td>
							<td class="hide-sm">${e.hostId !== null ? html`<a href="/hosts/${e.hostId}">${e.hostName ?? `#${e.hostId}`}</a>` : ""}</td>
							<td class="hide-sm mono small wrap">${e.target ?? ""}</td>
							<td>${e.ok ? html`<span class="badge badge-ok">ok</span>` : html`<span class="badge badge-bad" title="${e.detail ?? ""}">failed</span>`}</td>
						</tr>`,
				)}
			</tbody>
		</table>
	</div>`;
}
