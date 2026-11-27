import { html, type SafeHtml } from "../html.ts";

/** The live output of a deploy, backup, restore or verify. The browser follows it on the job's topic. */
export function jobOutputPanel(input: { key: string; output: string; total: number; running: boolean; back: { href: string; label: string } }): SafeHtml {
	const empty = input.output.length === 0;
	return html`<section class="panel">
		<div class="logs-head">
			<h2>Output</h2>
			<a class="button small" href="${input.back.href}">${input.back.label}</a>
		</div>
		<pre
			class="log-output"
			data-job-output
			data-job="${input.key}"
			data-total="${input.total}"
			data-running="${input.running ? "1" : "0"}"
			data-empty="${empty ? "1" : "0"}"
			tabindex="0"
		>
${empty ? (input.running ? "Waiting for output..." : "No output.") : input.output}</pre>
	</section>`;
}
