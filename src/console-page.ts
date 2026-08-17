// THE TWO PAGES THE CONSOLE SERVES, AND WHY THEY CARRY NO DATA.
//
// `P2-FR-06` requires untrusted draft content to render without executing HTML
// or script. There are two ways to mean that: escape everything on the way into
// a template, or never put draft content into markup at all. This console takes
// the second, because the first is a promise about every future edit of a
// template and the second is a property of the code that does the rendering.
//
// So: THESE PAGES CONTAIN NO DRAFT CONTENT. They are a fixed shell. Every field
// an owner reads arrives later as JSON and is written into the DOM with
// `textContent` (`console/app.ts`), which cannot create an element and cannot
// run a script. A `<script>` in a draft's title is a title that renders as the
// characters `<script>`.
//
// They also contain no credential, no session value and no CSRF token. The CSRF
// token is fetched by the script from `GET /v1/console/session`, over the same
// cookie, and lives in a closure variable — not in the markup, not in
// `localStorage`, not in a cookie (`P2-FR-14`).
//
// The one dynamic value is the bundle's URL. It is a constant of this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { consoleAssetDir } from "./assets.ts";

/** Where the built bundle is served from, and the one place the path is written. */
export const CONSOLE_SCRIPT_PATH = "/console/app.js";

const SHELL_STYLE = `
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:1.5rem;max-width:70rem}
h1{font-size:1.2rem;margin:0 0 1rem}
button{font:inherit;padding:.35rem .7rem}
button[disabled]{opacity:.5}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid #8884;padding:.4rem .5rem;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;word-break:break-word;background:#8881;padding:.5rem;margin:.25rem 0}
.panel{border:1px solid #8884;padding:.75rem;margin:.75rem 0}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.muted{opacity:.7}
.blocking{color:#b00020;font-weight:600}
`;

function shell(title: string, body: string, withScript: boolean): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${SHELL_STYLE}</style>
</head><body>
${body}
${withScript ? `<script type="module" src="${CONSOLE_SCRIPT_PATH}"></script>` : ""}
</body></html>
`;
}

/**
 * The login page. Reachable with no session — it is where a browser without one
 * is sent — and it holds a form with one field: the one-time ticket the owner
 * minted from the CLI.
 *
 * The form posts JSON via the script rather than as a classic form submission,
 * so the ticket never becomes a query string on any path, including the one a
 * browser takes when JavaScript has failed and a form falls back to `GET`. The
 * `method` is `post` and the `action` is the same origin either way.
 */
export function loginPage(): string {
  return shell(
    "Skillonomia — owner console sign-in",
    `<h1>Owner console</h1>
<p class="muted">Mint a one-time ticket on the server, with the owner API key, by calling POST /v1/console/tickets — then paste it here. The ticket is single-use and expires in five minutes. Pasting an API key here does nothing: this field takes a ticket.</p>
<form id="login" method="post" action="/v1/console/session" autocomplete="off">
  <div class="row">
    <label for="ticket">Ticket</label>
    <input id="ticket" name="ticket" type="password" size="52" required>
    <button type="submit">Sign in</button>
  </div>
</form>
<p id="login-error" class="blocking" role="alert"></p>`,
    true,
  );
}

/** The console shell: an inbox region, a detail region, an audit region, the
 *  V1 P3 capability library with its detail, and — V1 P5 — the outcome region
 *  beneath it. All empty. What fills them is JSON over the session cookie.
 *
 *  THE OUTCOME REGION IS SEPARATE FROM THE CAPABILITY REGION, and it is separate
 *  for the reason `INV-02` separates desired from observed: what an owner ASKED
 *  for and what a run REPORTED are two facts, and a page that drew them in one
 *  box would be inviting the next edit to read one out of the other. It is empty
 *  until a capability is open, because an outcome is an outcome OF a lineage.
 *
 *  THE INBOX CARRIES TWO COLUMNS WHERE P2 HAD ONE. `State` is the LINEAGE's
 *  decision and `Head approved` is whether the revision at the head of that
 *  lineage carries an approval of its own. P3 made approval a fact about a
 *  revision, so those two can disagree — an approved lineage whose head is a
 *  newer, unapproved revision is the ordinary case after an edit — and a page
 *  that showed only the first would be showing a lineage state its head does not
 *  have. Both are server fields. */
export function consolePage(): string {
  return shell(
    "Skillonomia — owner console",
    `<div class="row"><h1>Draft inbox</h1><span id="who" class="muted"></span>
<button id="logout" type="button">Log out</button></div>
<div class="row">
  <label for="state-filter">State</label>
  <select id="state-filter"></select>
  <button id="refresh" type="button">Refresh</button>
  <span id="session-note" class="muted"></span>
</div>
<p id="error" class="blocking" role="alert"></p>
<table id="inbox"><thead><tr>
  <th>Title</th><th>State</th><th>Head approved</th><th>Rev</th><th>Semantic</th><th>Security</th><th>Approvable</th><th></th>
</tr></thead><tbody id="inbox-rows"></tbody></table>
<div id="detail" class="panel" hidden></div>
<div id="audit" class="panel" hidden></div>
<div class="row"><h1>Capabilities</h1><button id="refresh-capabilities" type="button">Refresh</button></div>
<table id="capabilities"><thead><tr>
  <th>Capability</th><th>Approved revisions</th><th>Head approval</th><th>Assignments</th><th>Active</th><th></th>
</tr></thead><tbody id="capability-rows"></tbody></table>
<div id="capability" class="panel" hidden></div>
<div class="row"><h1>Outcomes</h1><button id="refresh-outcomes" type="button">Refresh</button></div>
<div id="outcomes" class="panel" hidden></div>`,
    true,
  );
}

/** The built bundle, read from the packaged asset directory. A console that
 *  served a source file would be a console whose production build nothing
 *  proves. */
export function consoleScript(): string {
  return readFileSync(join(consoleAssetDir(), "app.js"), "utf8");
}
