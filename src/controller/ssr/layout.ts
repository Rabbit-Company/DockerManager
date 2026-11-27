import type { Auth } from "../auth.ts";
import { APP_NAME, VERSION } from "../../shared/version.ts";
import { assets } from "./assets.ts";
import { firingCount } from "../alerts/state.ts";
import { html, type SafeHtml } from "./html.ts";
import { localTimeZone } from "../../shared/output-time.ts";

export interface Flash {
	kind: "ok" | "error";
	text: string;
}

export interface Crumb {
	label: string;
	href?: string;
}

export interface TreeHost {
	id: number;
	name: string;
	online: boolean;
	enrolled: boolean;
	running: number;
	total: number;
	projects: { name: string; stackId: number | null; containers: { id: string; name: string; state: string }[] }[];
}

export type Section = "alerts" | "updates" | "backups" | "audit";

export interface ShellOptions {
	title: string;
	/** Marks the matching link in the header as the current page. */
	section?: Section;
	auth: Auth;
	tree: TreeHost[];
	flash?: Flash | null;
	watch?: string[];
	hostId?: number;
	containerId?: string;
	crumbs?: Crumb[];
	actions?: SafeHtml;
	/** Loads the code editor, only on pages with a compose editor. */
	editor?: boolean;
	/** Lets the editor add its style element under the page's content security policy. */
	nonce?: string;
}

function head(title: string, editor = false, nonce?: string): SafeHtml {
	return html`<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="color-scheme" content="dark light" />
		<meta name="time-zone" content="${localTimeZone()}" />
		<title>${title} - ${APP_NAME}</title>
		<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
		<link rel="stylesheet" href="${assets.css.path}" />
		<script type="module" src="${assets.js.path}"></script>
		${editor ? html`<script type="module" src="${assets.editor.path}"></script>` : ""} ${nonce ? html`<meta name="style-nonce" content="${nonce}" />` : ""}`;
}

export function dot(tone: "ok" | "warn" | "bad" | "idle", label: string): SafeHtml {
	return html`<span class="dot dot-${tone}" role="img" aria-label="${label}" title="${label}"></span>`;
}

export function treeNav(tree: TreeHost[], hostId?: number, containerId?: string, overview = false): SafeHtml {
	return html`<nav class="tree" data-live="tree" aria-label="Hosts">
		<a class="tree-root${overview ? " current" : ""}" href="/">
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14v4H3zM3 12h14v4H3z" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
			<span>Datacenter</span>
		</a>
		<ul class="tree-hosts">
			${tree.map(
				(host) =>
					html`<li>
						<a class="tree-host${host.id === hostId && containerId === undefined ? " current" : ""}" href="/hosts/${host.id}">
							${host.online ? dot("ok", "Online") : host.enrolled ? dot("bad", "Offline") : dot("idle", "Waiting to join")}
							<span class="tree-name">${host.name}</span>
							<span class="tree-count">${host.online ? `${host.running}/${host.total}` : ""}</span>
						</a>
						${
							host.id === hostId && host.projects.length > 0
								? html`<ul class="tree-projects">
										${host.projects.map(
											(project) =>
												html`<li>
													${
														project.stackId !== null
															? html`<a class="tree-project" href="/hosts/${host.id}/stacks/${project.stackId}">${project.name}</a>`
															: html`<span class="tree-project">${project.name}</span>`
													}
													<ul>
														${project.containers.map(
															(c) =>
																html`<li>
																	<a class="tree-container${c.id === containerId ? " current" : ""}" href="/hosts/${host.id}/containers/${c.id}">
																		${dot(c.state === "running" ? "ok" : c.state === "restarting" ? "warn" : "idle", c.state)}
																		<span class="tree-name">${c.name}</span>
																	</a>
																</li>`,
														)}
													</ul>
												</li>`,
										)}
									</ul>`
								: ""
						}
					</li>`,
			)}
		</ul>
		<a class="tree-add" href="/hosts/new">+ Add host</a>
		<div class="tree-more">${SECTIONS.map(([id, href, label]) => html`<a href="${href}">${icon(ICONS[id])}<span>${label}</span></a>`)}</div>
	</nav>`;
}

const ICONS = {
	alerts: "M10 3a4.5 4.5 0 0 0-4.5 4.5v2.8L4 13.5h12l-1.5-3.2V7.5A4.5 4.5 0 0 0 10 3zM8.3 16a1.8 1.8 0 0 0 3.4 0",
	updates: "M4.5 9.5a5.5 5.5 0 0 1 9.6-3.4l1.4 1.4M15.5 4v3.5H12M15.5 10.5a5.5 5.5 0 0 1-9.6 3.4l-1.4-1.4M4.5 16v-3.5H8",
	backups: "M3.5 4.5h13v3.5h-13zM4.5 8v7.5h11V8M8 11h4",
	audit: "M5.5 3h6.5l3 3v11h-9.5zM8 9.5h5M8 12.5h5M8 15h3",
} as const;

function icon(path: string): SafeHtml {
	return html`<svg viewBox="0 0 20 20" aria-hidden="true">
		<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
	</svg>`;
}

const SECTIONS: [Section, string, string][] = [
	["alerts", "/alerts", "Alerts"],
	["updates", "/updates", "Updates"],
	["backups", "/backups", "Backups"],
	["audit", "/audit", "Audit log"],
];

const ROLE_LABEL = { admin: "Administrator", operator: "Operator", viewer: "Viewer" } as const;

function header(options: ShellOptions): SafeHtml {
	const { auth } = options;
	const firing = firingCount();
	const count = (cls: string) => (firing > 0 ? html`<span class="${cls}" aria-label="${firing} alerts firing">${firing}</span>` : "");
	return html`<header class="top">
		<button class="nav-button" type="button" aria-controls="sidebar" aria-expanded="false" data-nav-toggle>
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.8" /></svg>
			<span class="visually-hidden">Hosts</span>
		</button>
		<a class="brand" href="/">${APP_NAME}</a>
		<span class="conn" data-conn title="Live updates"><span class="conn-dot" aria-hidden="true"></span><span data-conn-text>Live</span></span>
		<nav class="top-nav" aria-label="Sections">
			${SECTIONS.map(
				([id, href, label]) =>
					html`<a href="${href}" ${options.section === id ? html`aria-current="page"` : ""} ${id === "alerts" ? html`data-live="alert-count"` : ""}
						>${icon(ICONS[id])}<span>${label}</span>${id === "alerts" ? count("nav-count") : ""}</a
					>`,
			)}
		</nav>
		<div class="top-end">
			<a class="bell${firing > 0 ? " firing" : ""}" href="/alerts" data-live="alert-bell" title="Alerts"
				>${icon(ICONS.alerts)}<span class="visually-hidden">Alerts</span>${count("bell-count")}</a
			>
			<details class="user-menu" data-menu>
				<summary>
					<span class="avatar" aria-hidden="true">${auth.user.username.slice(0, 1).toUpperCase()}</span>
					<span class="user-name">${auth.user.username}</span>
					<svg class="chevron" viewBox="0 0 20 20" aria-hidden="true">
						<path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
					<span class="visually-hidden">Account</span>
				</summary>
				<div class="menu">
					<div class="menu-head">
						<strong>${auth.user.username}</strong>
						<span class="muted small">${ROLE_LABEL[auth.user.role]}</span>
					</div>
					<form method="post" action="/logout">
						<input type="hidden" name="_csrf" value="${auth.session.csrf}" />
						<button class="menu-item" type="submit">Sign out</button>
					</form>
				</div>
			</details>
		</div>
	</header>`;
}

function crumbs(list: Crumb[]): SafeHtml {
	if (list.length === 0) return html``;
	return html`<ol class="crumbs">
		${list.map((c) => html`<li>${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span aria-current="page">${c.label}</span>`}</li>`)}
	</ol>`;
}

export function flashBox(flash: Flash | null | undefined): SafeHtml {
	if (!flash) return html``;
	return html`<div class="flash flash-${flash.kind}" role="${flash.kind === "error" ? "alert" : "status"}">${flash.text}</div>`;
}

export function shell(options: ShellOptions, content: SafeHtml): string {
	return `<!doctype html>${html`<html lang="en">
		<head>
			${head(options.title, options.editor, options.nonce)}
		</head>
		<body data-watch="${[...new Set([...(options.watch ?? []), "alerts"])].join(" ")}" data-socket-csrf="${options.auth.session.csrf}">
			${header(options)}
			<div class="frame">
				<aside id="sidebar" class="sidebar">
					${treeNav(options.tree, options.hostId, options.containerId, options.hostId === undefined && (options.crumbs ?? []).length === 0)}
				</aside>
				<main class="main">
					<div class="page-head">
						<div>
							${crumbs(options.crumbs ?? [])}
							<h1>${options.title}</h1>
						</div>
						${options.actions ? html`<div class="page-actions">${options.actions}</div>` : ""}
					</div>
					${flashBox(options.flash)} ${content}
				</main>
			</div>
			<footer class="foot">${APP_NAME} ${VERSION}</footer>
		</body>
	</html>`}`;
}

/** Pages without the host tree: setup, sign in and errors. */
export function bare(title: string, content: SafeHtml, flash?: Flash | null): string {
	return `<!doctype html>${html`<html lang="en">
		<head>
			${head(title)}
		</head>
		<body class="bare">
			<main class="card-page">
				<a class="brand brand-large" href="/">${APP_NAME}</a>
				${flashBox(flash)} ${content}
			</main>
		</body>
	</html>`}`;
}
