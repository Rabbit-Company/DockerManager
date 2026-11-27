import type { BackupItem } from "../../../shared/protocol.ts";
import { bytes } from "../../../shared/units.ts";
import type { Backup, BackupTask, Destination, JobStatus, Plan, StackMove, Transfer } from "../../db/backups.ts";
import type { Host } from "../../db/hosts.ts";
import type { Stack } from "../../db/stacks.ts";
import { KINDS, type FormValues } from "../../lib/destinations.ts";
import { describeSchedule, SCHEDULE_PRESETS } from "../../lib/schedule.ts";
import { ago, dateTime } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { jobOutputPanel } from "./jobs.ts";

export function statusBadge(status: JobStatus): SafeHtml {
	const tone = status === "ok" ? "ok" : status === "running" ? "warn" : "bad";
	const label = { ok: "succeeded", running: "running", failed: "failed", interrupted: "interrupted" }[status];
	return html`<span class="badge badge-${tone}">${label}</span>`;
}

function took(startedAt: string, finishedAt: string | null): string {
	if (!finishedAt) return "still running";
	const s = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
	return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map(([k, label]) => [k, label]));

export interface PlanRow {
	stack: Stack;
	host: Host | null;
	plan: Plan;
	destination: Destination | null;
	last: Backup | null;
}

export function overviewPage(input: {
	destinations: (Destination & { where: string; usage: { plans: number; backups: number } })[];
	rows: PlanRow[];
}): SafeHtml {
	return html`<section class="group">
			<div class="section-head">
				<h2 class="group-title">Destinations <span class="muted">${input.destinations.length}</span></h2>
				<a class="button primary" href="/backups/destinations/new">Add destination</a>
			</div>
			${
				input.destinations.length === 0
					? html`<section class="empty">
							<h2>No destination yet</h2>
							<p>Backups are encrypted on the host before they leave it, so any S3 provider, NAS or disk can hold them.</p>
							<a class="button primary" href="/backups/destinations/new">Add a destination</a>
						</section>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Name</th>
										<th class="hide-sm">Kind</th>
										<th class="hide-sm">Where</th>
										<th>Used by</th>
									</tr>
								</thead>
								<tbody>
									${input.destinations.map(
										(d) =>
											html`<tr>
												<td><a class="strong" href="/backups/destinations/${d.id}">${d.name}</a></td>
												<td class="hide-sm">${KIND_LABEL[d.kind]}</td>
												<td class="hide-sm mono small wrap">${d.where}</td>
												<td class="small">
													${d.usage.plans} plan${d.usage.plans === 1 ? "" : "s"}, ${d.usage.backups} backup${d.usage.backups === 1 ? "" : "s"}
												</td>
											</tr>`,
									)}
								</tbody>
							</table>
						</div>`
			}
		</section>
		<section class="group">
			<h2 class="group-title">Plans <span class="muted">${input.rows.length}</span></h2>
			${
				input.rows.length === 0
					? html`<p class="empty-inline">No stack is backed up on a schedule yet. Open a stack and its Backups tab to set one up.</p>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Stack</th>
										<th class="hide-sm">Schedule</th>
										<th class="hide-sm">Destination</th>
										<th>Last backup</th>
										<th class="hide-sm">Next</th>
									</tr>
								</thead>
								<tbody>
									${input.rows.map(
										(r) =>
											html`<tr>
												<td>
													<a class="strong" href="/hosts/${r.stack.hostId}/stacks/${r.stack.id}?tab=backups">${r.stack.name}</a>
													<div class="muted small">${r.host?.name ?? ""}</div>
												</td>
												<td class="hide-sm">${r.plan.enabled ? describeSchedule(r.plan.schedule) : html`<span class="muted">paused</span>`}</td>
												<td class="hide-sm">${r.destination?.name ?? html`<span class="muted">removed</span>`}</td>
												<td>
													${
														r.last
															? html`<a href="/hosts/${r.stack.hostId}/stacks/${r.stack.id}/backups/${r.last.id}">${ago(r.last.startedAt)}</a>
																	${statusBadge(r.last.status)}`
															: html`<span class="muted">never</span>`
													}
												</td>
												<td class="hide-sm nowrap">${r.plan.enabled && r.plan.nextRunAt ? dateTime(r.plan.nextRunAt) : ""}</td>
											</tr>`,
									)}
								</tbody>
							</table>
						</div>`
			}
		</section>`;
}

const textField = (name: string, label: string, values: FormValues, extra: { type?: string; placeholder?: string; help?: string; required?: boolean } = {}) =>
	html`<label
		>${label}
		<input
			name="${name}"
			type="${extra.type ?? "text"}"
			value="${extra.type === "password" ? "" : (values[name] ?? "")}"
			placeholder="${extra.placeholder ?? ""}"
			autocomplete="off"
			spellcheck="false"
		/>
		${extra.help ? html`<small>${extra.help}</small>` : ""}</label
	>`;

export function destinationForm(form: {
	action: string;
	csrf: string;
	values: FormValues;
	error?: string | null;
	editing: boolean;
	hosts: Host[];
	testHosts?: boolean;
}): SafeHtml {
	const v = form.values;
	const kind = v.kind ?? "s3";
	const secretHelp = form.editing ? "Leave empty to keep the stored one." : undefined;
	return html`<form method="post" action="${form.action}" class="stack destination-form" data-kind-form>
		<input type="hidden" name="_csrf" value="${form.csrf}" />
		${form.error ? html`<div class="flash flash-error" role="alert">${form.error}</div>` : ""}
		<section class="panel stack">
			${textField("name", "Name", v, { placeholder: "Offsite S3" })}
			<fieldset class="kinds">
				<legend>Kind</legend>
				${KINDS.map(
					([k, label, hint]) =>
						html`<label class="kind-option"
							><input type="radio" name="kind" value="${k}" ${k === kind ? "checked" : ""} data-kind-choice /><span
								><strong>${label}</strong><small>${hint}</small></span
							></label
						>`,
				)}
			</fieldset>
		</section>
		<section class="panel stack" data-kind-fields="s3">
			<h2>S3 compatible storage</h2>
			${textField("endpoint", "Endpoint", v, { placeholder: "https://s3.eu-central-1.amazonaws.com", help: "Leave empty for AWS. For R2 use https://<account>.r2.cloudflarestorage.com." })}
			<div class="field-row">${textField("region", "Region", v, { placeholder: "auto" })} ${textField("bucket", "Bucket", v, { placeholder: "backups" })}</div>
			${textField("prefix", "Folder in the bucket", v, { placeholder: "servers", help: "Optional." })}
			<div class="field-row">
				${textField("access_key", "Access key", v)} ${textField("secret_key", "Secret key", v, { type: "password", help: secretHelp })}
			</div>
		</section>
		<section class="panel stack" data-kind-fields="local">
			<h2>Folder on the host</h2>
			${textField("path", "Folder", v, { placeholder: "/mnt/backups", help: "On the host of each stack. It is created when missing." })}
		</section>
		<section class="panel stack" data-kind-fields="smb">
			<h2>SMB share</h2>
			${textField("share", "Share", v, { placeholder: "//nas.lan/backups", help: "The host needs cifs-utils and the agent must run as root." })}
			<div class="field-row">${textField("smb_user", "Username", v)} ${textField("smb_password", "Password", v, { type: "password", help: secretHelp })}</div>
			<div class="field-row">${textField("domain", "Domain", v, { help: "Optional." })} ${textField("version", "SMB version", v, { placeholder: "3.0" })}</div>
			${textField("subfolder", "Subfolder", v, { help: "Optional." })}
		</section>
		<section class="panel stack" data-kind-fields="nfs">
			<h2>NFS export</h2>
			${textField("export", "Export", v, { placeholder: "nas.lan:/volume1/backups", help: "The host needs nfs-common or nfs-utils and the agent must run as root." })}
			${textField("options", "Mount options", v, { placeholder: "rw,nfsvers=4" })} ${textField("subfolder", "Subfolder", v, { help: "Optional." })}
		</section>
		<section class="panel editor-actions">
			<p class="grow muted small">
				${
					form.editing
						? "The encryption key stays the same, so earlier backups stay readable."
						: "A random encryption key is created with the destination. Save the recovery key it shows next, it is the only way to read these backups without this controller."
				}
			</p>
			<div class="actions"><button class="button primary" type="submit">${form.editing ? "Save" : "Add destination"}</button></div>
		</section>
	</form>`;
}

export function destinationPage(input: {
	destination: Destination;
	form: SafeHtml;
	usage: { plans: number; backups: number };
	hosts: Host[];
	online: Set<number>;
	csrf: string;
	recoveryKey: string | null;
	test: { ok: boolean; text: string } | null;
}): SafeHtml {
	const d = input.destination;
	const online = input.hosts.filter((h) => input.online.has(h.id));
	return html`${
			input.recoveryKey
				? html`<section class="panel recovery" role="status">
						<h2>Recovery key</h2>
						<p>Keep this key somewhere safe and away from the backups, such as a password manager. With it, the backups can be read without this controller:</p>
						<div class="command">
							<pre class="mono" id="recovery-key">${input.recoveryKey}</pre>
							<button class="button small" type="button" data-copy="recovery-key">Copy</button>
						</div>
						<p class="muted small">dockermanager-agent decrypt --key KEY file.tar.gz.dmbak | tar -xz</p>
					</section>`
				: ""
		}
		${input.test ? html`<div class="flash flash-${input.test.ok ? "ok" : "error"}" role="status">${input.test.text}</div>` : ""}
		<div class="columns columns-start">
			<section class="panel stack">
				<h2>Test</h2>
				<p class="muted">Writes, reads and deletes a small file from a host, the way backups will.</p>
				${
					online.length === 0
						? html`<p class="muted">No host is online.</p>`
						: html`<form method="post" action="/backups/destinations/${d.id}/test" class="actions">
								<input type="hidden" name="_csrf" value="${input.csrf}" />
								<select name="host" aria-label="Host to test from">
									${online.map((h) => html`<option value="${h.id}">${h.name}</option>`)}
								</select>
								<button class="button" type="submit">Test from this host</button>
							</form>`
				}
			</section>
			<section class="panel stack">
				<h2>Recovery key</h2>
				<p class="muted">Show it again, for example to store it in a second place. This is recorded in the audit log.</p>
				<form method="post" action="/backups/destinations/${d.id}/key" class="inline">
					<input type="hidden" name="_csrf" value="${input.csrf}" />
					<button class="button" type="submit">Show recovery key</button>
				</form>
			</section>
		</div>
		${input.form}
		<section class="panel narrow stack danger-zone">
			<h2>Remove destination</h2>
			${
				input.usage.plans > 0 || input.usage.backups > 0
					? html`<p class="muted">Used by ${input.usage.plans} plan(s) and ${input.usage.backups} backup(s). Move the plans and delete the backups first.</p>`
					: html`<form method="post" action="/backups/destinations/${d.id}/delete" class="inline">
							<input type="hidden" name="_csrf" value="${input.csrf}" />
							<button class="button danger" type="submit">Remove destination</button>
						</form>`
			}
		</section>`;
}

export function backupsTab(input: {
	stack: Stack;
	plan: Plan | null;
	destinations: Destination[];
	items: BackupItem[] | null;
	itemsError: string | null;
	backups: Backup[];
	csrf: string;
	busy: string | null;
}): SafeHtml {
	const { stack, plan } = input;
	if (input.destinations.length === 0) {
		return html`<section class="empty">
			<h2>Add a backup destination first</h2>
			<p>S3 storage, a folder, an SMB share or an NFS export. Backups are encrypted on the host.</p>
			<a class="button primary" href="/backups/destinations/new">Add destination</a>
		</section>`;
	}
	const schedule = plan?.schedule ?? "0 3 * * *";
	const preset = SCHEDULE_PRESETS.some(([c]) => c === schedule) ? schedule : "custom";
	const chosen = plan?.items ?? null;
	const base = `/hosts/${stack.hostId}/stacks/${stack.id}/backups`;
	return html`<form method="post" action="${base}" class="stack">
			<input type="hidden" name="_csrf" value="${input.csrf}" />
			<div class="columns columns-start">
				<section class="panel stack">
					<h2>What to back up</h2>
					${
						input.items === null
							? html`<p class="muted small">${input.itemsError ?? "The host is offline, so its volumes cannot be listed."}</p>`
							: html`<label class="check"
										><input type="checkbox" name="all_items" value="1" ${chosen === null ? "checked" : ""} /> Everything below, and volumes added later</label
									>
									<ul class="check-list">
										${input.items.map(
											(i) =>
												html`<li>
													<label class="check"
														><input type="checkbox" name="item" value="${i.id}" ${chosen === null || chosen.includes(i.id) ? "checked" : ""} />
														<span>${i.label}${i.path && i.kind !== "files" ? html` <span class="muted small mono wrap">${i.path}</span>` : ""}</span></label
													>
												</li>`,
										)}
									</ul>`
					}
					<fieldset class="kinds">
						<legend>While backing up</legend>
						<label class="kind-option"
							><input type="radio" name="mode" value="stop" ${plan?.mode !== "live" ? "checked" : ""} /><span
								><strong>Stop the containers</strong
								><small>Consistent files, a short downtime. Database dumps run first, while the database is up.</small></span
							></label
						>
						<label class="kind-option"
							><input type="radio" name="mode" value="live" ${plan?.mode === "live" ? "checked" : ""} /><span
								><strong>Keep them running</strong
								><small>No downtime. Files that change during the backup may be inconsistent, so rely on the database dumps.</small></span
							></label
						>
					</fieldset>
				</section>
				<section class="panel stack">
					<h2>Where and when</h2>
					<label
						>Destination
						<select name="destination">
							${input.destinations.map((d) => html`<option value="${d.id}" ${plan?.destinationId === d.id ? "selected" : ""}>${d.name}</option>`)}
						</select></label
					>
					<label
						>Schedule
						<select name="preset">
							${SCHEDULE_PRESETS.map(([c, label]) => html`<option value="${c}" ${preset === c ? "selected" : ""}>${label}</option>`)}
							<option value="custom" ${preset === "custom" ? "selected" : ""}>Custom cron expression</option>
						</select></label
					>
					<label
						>Custom schedule
						<input name="cron" value="${preset === "custom" ? schedule : ""}" placeholder="15 1 * * MON-FRI" spellcheck="false" autocomplete="off" />
						<small>Used when the schedule is Custom. Five fields in the controller's time zone, or @daily and the like.</small></label
					>
					<div class="field-row three">
						<label>Keep daily <input name="keep_daily" type="number" min="0" max="365" value="${plan?.keepDaily ?? 7}" /></label>
						<label>Keep weekly <input name="keep_weekly" type="number" min="0" max="520" value="${plan?.keepWeekly ?? 4}" /></label>
						<label>Keep monthly <input name="keep_monthly" type="number" min="0" max="240" value="${plan?.keepMonthly ?? 6}" /></label>
					</div>
					<label class="check"><input type="checkbox" name="enabled" value="1" ${plan === null || plan.enabled ? "checked" : ""} /> Run on this schedule</label>
					${plan?.enabled && plan.nextRunAt ? html`<p class="muted small">Next backup ${dateTime(plan.nextRunAt)}.</p>` : ""}
				</section>
			</div>
			<div class="actions">
				<button class="button" type="submit" name="intent" value="save">Save plan</button>
				<button class="button primary" type="submit" name="intent" value="run" ${input.busy ? "disabled" : ""}>Back up now</button>
				${input.busy ? html`<span class="muted small">A job of this stack is running.</span>` : ""}
			</div>
		</form>
		<section class="group">
			<h2 class="group-title">Backups <span class="muted">${input.backups.length}</span></h2>
			${
				input.backups.length === 0
					? html`<p class="empty-inline">No backup yet.</p>`
					: html`<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Started</th>
										<th>Result</th>
										<th class="right">Size</th>
										<th class="hide-sm">Items</th>
										<th class="hide-sm">How</th>
									</tr>
								</thead>
								<tbody>
									${input.backups.map(
										(b) =>
											html`<tr>
												<td><a class="strong" href="${base}/${b.id}" title="${dateTime(b.startedAt)}">${ago(b.startedAt)}</a></td>
												<td>${statusBadge(b.status)}</td>
												<td class="right nowrap">${b.status === "ok" ? bytes(b.bytes) : ""}</td>
												<td class="hide-sm">${b.items.length || ""}</td>
												<td class="hide-sm small">
													${b.trigger === "schedule" ? "scheduled" : (b.username ?? "by hand")}, ${b.mode === "stop" ? "stopped" : "live"}
												</td>
											</tr>`,
									)}
								</tbody>
							</table>
						</div>`
			}
		</section>`;
}

export function backupPage(input: {
	stack: Stack;
	backup: Backup;
	destination: Destination | null;
	tasks: BackupTask[];
	transfers: Transfer[];
	live: { output: string; total: number } | null;
	csrf: string;
}): SafeHtml {
	const { stack, backup } = input;
	const base = `/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}`;
	const usable = backup.status === "ok" && !backup.deletedAt;
	return html`<section class="summary cols-4" aria-label="Summary" data-live="backup">
			<div class="summary-item"><span>Result</span>${backup.deletedAt ? html`<span class="badge badge-idle">deleted</span>` : statusBadge(backup.status)}</div>
			<div class="summary-item"><span>Size</span><strong>${backup.status === "ok" ? bytes(backup.bytes) : "none"}</strong></div>
			<div class="summary-item">
				<span>Started</span><strong title="${dateTime(backup.startedAt)}">${ago(backup.startedAt)}</strong
				><span class="muted small">took ${took(backup.startedAt, backup.finishedAt)}</span>
			</div>
			<div class="summary-item">
				<span>Destination</span><strong>${input.destination?.name ?? "removed"}</strong><span class="path">${backup.setPath}</span>
			</div>
		</section>
		${
			usable
				? html`<div class="actions">
						<a class="button primary" href="${base}/restore">Restore</a>
						${backup.mode === "stop" && backup.stackVersion !== null && !stack.adopted ? html`<a class="button" href="${base}/transfer">Transfer to host</a>` : ""}
						<form method="post" action="${base}/verify" class="inline">
							<input type="hidden" name="_csrf" value="${input.csrf}" /><button class="button" type="submit">Verify</button>
						</form>
						<form method="post" action="${base}/delete" class="inline">
							<input type="hidden" name="_csrf" value="${input.csrf}" /><button class="button danger" type="submit">Delete backup</button>
						</form>
					</div>`
				: ""
		}
		${
			backup.items.length > 0
				? html`<div class="table-wrap">
						<table class="table">
							<thead>
								<tr>
									<th>Item</th>
									<th class="right">Stored</th>
									<th class="hide-sm">File</th>
								</tr>
							</thead>
							<tbody>
								${backup.items.map(
									(i) =>
										html`<tr>
											<td>${i.label}${i.warning ? html`<div class="small warn-text">${i.warning}</div>` : ""}</td>
											<td class="right nowrap">${bytes(i.bytes)}</td>
											<td class="hide-sm mono small wrap">${i.file}</td>
										</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: ""
		}
		${
			input.tasks.length > 0
				? html`<section class="panel">
						<h2>Restores and checks</h2>
						<ul class="timeline">
							${input.tasks.map(
								(t) =>
									html`<li>
										<div class="timeline-head">
											<a class="strong" href="${base}/tasks/${t.id}">${t.kind === "restore" ? "Restore" : "Verify"}</a> ${statusBadge(t.status)}
											<span class="muted small">${ago(t.startedAt)}${t.username ? ` by ${t.username}` : ""}</span>
										</div>
									</li>`,
							)}
						</ul>
					</section>`
				: ""
		}
		${
			input.transfers.length > 0
				? html`<section class="panel">
						<h2>Transfers</h2>
						<ul class="timeline">
							${input.transfers.map(
								(t) => html`<li><a class="strong" href="${base}/transfers/${t.id}">Transfer to host ${t.targetHostId}</a> ${statusBadge(t.status)}</li>`,
							)}
						</ul>
					</section>`
				: ""
		}
		${jobOutputPanel({
			key: `backup:${backup.id}`,
			output: input.live?.output ?? backup.output,
			total: input.live?.total ?? backup.output.length,
			running: backup.status === "running",
			back: { href: `/hosts/${stack.hostId}/stacks/${stack.id}?tab=backups`, label: "Back to backups" },
		})}`;
}

export function transferPage(input: { stack: Stack; backup: Backup; hosts: Host[]; csrf: string }): SafeHtml {
	const base = `/hosts/${input.stack.hostId}/stacks/${input.stack.id}/backups/${input.backup.id}`;
	return html`<section class="panel narrow stack">
		<h2>Transfer ${input.stack.name}</h2>
		<p>
			The target host reads this backup, creates the stack without starting its containers, and restores its named volumes. The source stack stays in place.
		</p>
		<p class="muted">
			Use a recent backup made with "Stop the containers". Stop the source before starting the target so both database copies cannot accept writes. Any writes
			made to the source after this backup will not be on the target.
		</p>
		<p class="muted">
			Stacks with bind mounted folders cannot be transferred. Database dumps remain in the backup because the stopped volume copy already contains the database
			files.
		</p>
		<form method="post" action="${base}/transfer" class="stack">
			<input type="hidden" name="_csrf" value="${input.csrf}" />
			<label
				>Target host
				<select name="host" required>
					${input.hosts.map((host) => html`<option value="${host.id}">${host.name}</option>`)}
				</select>
			</label>
			<div class="actions"><button class="button primary" type="submit" ${input.hosts.length === 0 ? "disabled" : ""}>Transfer backup</button></div>
		</form>
		${input.hosts.length === 0 ? html`<p class="muted">Connect another host before transferring.</p>` : ""}
	</section>`;
}

export function transferRunPage(input: {
	stack: Stack;
	backup: Backup;
	transfer: Transfer;
	target: Host | null;
	live: { output: string; total: number } | null;
}): SafeHtml {
	const { stack, backup, transfer } = input;
	const base = `/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}`;
	return html`<section class="summary cols-4">
			<div class="summary-item"><span>Result</span>${statusBadge(transfer.status)}</div>
			<div class="summary-item"><span>Target host</span><strong>${input.target?.name ?? "removed"}</strong></div>
			<div class="summary-item"><span>Started</span><strong>${ago(transfer.startedAt)}</strong></div>
			<div class="summary-item">
				<span>Target stack</span
				>${transfer.targetStackId ? html`<a href="/hosts/${transfer.targetHostId}/stacks/${transfer.targetStackId}">Open stack</a>` : "waiting"}
			</div>
		</section>
		${transfer.status === "ok" ? html`<p class="muted">The target containers are stopped. Review the stack, stop the source, then start the target.</p>` : ""}
		${jobOutputPanel({ key: `transfer:${transfer.id}`, output: input.live?.output ?? transfer.output, total: input.live?.total ?? transfer.output.length, running: transfer.status === "running", back: { href: base, label: "Back to backup" } })}`;
}

export function movePage(input: { stack: Stack; hosts: Host[]; destinations: Destination[]; moves: StackMove[]; csrf: string }): SafeHtml {
	const base = `/hosts/${input.stack.hostId}/stacks/${input.stack.id}`;
	return html`<section class="panel narrow stack">
			<h2>How it works</h2>
			<p>
				DockerManager checks the target, stops the source stack, makes a fresh encrypted backup, restores it on the target, then starts the target and checks
				its health.
			</p>
			<p class="muted">
				After the target starts, DockerManager removes the stopped source containers but keeps their volumes and stack files, and the backup plan moves to the
				new host. If a step fails, it stops any target containers and restarts the source. The backup remains available for recovery.
			</p>
			<p class="muted">
				Named volumes include database files. The source containers are stopped before they are copied. Database dumps are not needed for this transfer.
			</p>
			<form method="post" action="${base}/transfer" class="stack">
				<input type="hidden" name="_csrf" value="${input.csrf}" />
				<label
					>Target host
					<select name="host" required>
						${input.hosts.map((host) => html`<option value="${host.id}">${host.name}</option>`)}
					</select>
				</label>
				<label
					>Backup destination
					<select name="destination" required>
						${input.destinations.map((destination) => html`<option value="${destination.id}">${destination.name}</option>`)}
					</select>
					<small>Both hosts must be able to reach this S3 bucket or shared folder.</small>
				</label>
				<div class="actions">
					<button class="button primary" type="submit" ${input.hosts.length === 0 || input.destinations.length === 0 ? "disabled" : ""}>
						Stop source and transfer
					</button>
				</div>
			</form>
			${input.hosts.length === 0 ? html`<p class="muted">Connect another host before transferring.</p>` : ""}
			${input.destinations.length === 0 ? html`<p class="muted">Add a shared backup destination before transferring.</p>` : ""}
			<p class="muted small">Stacks with bind mounted folders cannot be transferred.</p>
		</section>
		${
			input.moves.length > 0
				? html`<section class="panel narrow">
						<h2>Recent transfers</h2>
						<ul class="timeline">
							${input.moves.map((move) => html`<li><a class="strong" href="${base}/transfers/${move.id}">${ago(move.startedAt)}</a> ${statusBadge(move.status)}</li>`)}
						</ul>
					</section>`
				: ""
		}`;
}

export function moveRunPage(input: { stack: Stack; move: StackMove; target: Host | null; live: { output: string; total: number } | null }): SafeHtml {
	const { stack, move } = input;
	return html`<section class="summary cols-4">
			<div class="summary-item"><span>Result</span>${statusBadge(move.status)}</div>
			<div class="summary-item"><span>Target host</span><strong>${input.target?.name ?? "removed"}</strong></div>
			<div class="summary-item">
				<span>Backup</span>${move.backupId ? html`<a href="/hosts/${stack.hostId}/stacks/${stack.id}/backups/${move.backupId}">Open backup</a>` : "waiting"}
			</div>
			<div class="summary-item">
				<span>Target stack</span>${move.targetStackId ? html`<a href="/hosts/${move.targetHostId}/stacks/${move.targetStackId}">Open stack</a>` : "waiting"}
			</div>
		</section>
		${move.status === "ok" ? html`<p class="muted">The target is running. Source containers were removed, while their volumes and files remain. Check the application and update any DNS or reverse proxy routes.</p>` : ""}
		${move.status === "interrupted" ? html`<p class="muted">The controller stopped during transfer. Check both hosts before starting either stack.</p>` : ""}
		${jobOutputPanel({ key: `move:${move.id}`, output: input.live?.output ?? move.output, total: input.live?.total ?? move.output.length, running: move.status === "running", back: { href: `/hosts/${stack.hostId}/stacks/${stack.id}`, label: "Back to stack" } })}`;
}

export function restorePage(input: { stack: Stack; backup: Backup; csrf: string }): SafeHtml {
	const { stack, backup } = input;
	const restorable = backup.items.filter((i) => i.kind !== "dump");
	const dumps = backup.items.filter((i) => i.kind === "dump");
	return html`<section class="panel narrow stack">
		<p>Restore the backup from <strong>${dateTime(backup.startedAt)}</strong>?</p>
		<p class="muted">
			The containers of ${stack.name} are stopped, the chosen folders are replaced with their state in the backup, and the containers start again. Each folder
			is unpacked next to the old one first and swapped in only when complete.
		</p>
		<form method="post" action="/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}/restore" class="stack">
			<input type="hidden" name="_csrf" value="${input.csrf}" />
			<ul class="check-list">
				${restorable.map(
					(i) =>
						html`<li>
							<label class="check"><input type="checkbox" name="item" value="${i.id}" checked /> <span>${i.label}</span></label>
						</li>`,
				)}
			</ul>
			${dumps.length > 0 ? html`<p class="muted small">${dumps.map((d) => d.label).join(", ")} stay in the backup. Load a dump by hand when you need it, see the README.</p>` : ""}
			<div class="actions">
				<button class="button danger" type="submit">Restore</button>
				<a class="button" href="/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}">Cancel</a>
			</div>
		</form>
	</section>`;
}

export function taskPage(input: { stack: Stack; backup: Backup; task: BackupTask; live: { output: string; total: number } | null }): SafeHtml {
	const { stack, backup, task } = input;
	return html`<section class="summary cols-4" aria-label="Summary" data-live="task">
			<div class="summary-item"><span>Result</span>${statusBadge(task.status)}</div>
			<div class="summary-item"><span>Action</span><strong>${task.kind === "restore" ? "Restore" : "Verify"}</strong></div>
			<div class="summary-item"><span>Started</span><strong>${ago(task.startedAt)}${task.username ? ` by ${task.username}` : ""}</strong></div>
			<div class="summary-item"><span>Took</span><strong>${took(task.startedAt, task.finishedAt)}</strong></div>
		</section>
		${jobOutputPanel({
			key: `task:${task.id}`,
			output: input.live?.output ?? task.output,
			total: input.live?.total ?? task.output.length,
			running: task.status === "running",
			back: { href: `/hosts/${stack.hostId}/stacks/${stack.id}/backups/${backup.id}`, label: "Back to the backup" },
		})}`;
}
