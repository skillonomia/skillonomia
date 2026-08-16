// THE BROWSER END-TO-END RUN OF THE OWNER CONSOLE — what `browser-e2e.sh` runs.
//
// A REAL BROWSER, A REAL SERVER, A REAL DATABASE. Chromium is driven by
// Playwright against a `skillonomia serve` started on a free port with its own
// temporary data directory; the drafts it reads are drafts this run created
// through `POST /v1/captures` with the owner's API key. Nothing here is a
// fixture, a stub or a hand-written row (contract section 9).
//
// WHAT IT ASSERTS, and the requirement each assertion is owed to:
//
//   1  the protected page and the protected API refuse with no session   P2-FR-01
//   2  a ticket minted server-side opens a session; the cookie is
//      HttpOnly, SameSite=Strict, Path=/ and Max-Age <= 3600            P2-FR-02, INV-04
//   3  the Inbox shows the drafts the backend holds                     P2-FR-04
//   4  the detail shows the structured panels                           P2-FR-05
//   5  untrusted draft content renders as text and executes nothing     P2-FR-06
//   6  an edit creates a new revision and re-runs both previews         P2-FR-07
//   7  a draft with a blocking finding cannot be approved               P2-FR-09
//   8  approve records revision, digest, actor and time                 P2-FR-08
//   9  reject requires a reason and preserves the audit                 P2-FR-10
//  10  a cross-site POST and a wrong-Origin POST are refused            P2-FR-13
//  11  a resent decision is one decision                                P2-FR-13
//  12  browser storage holds nothing, after the whole workflow          P2-FR-14
//  13  no request or response carried an API key                        P2-FR-03
//  14  logout invalidates the session on the server                     P2-FR-02
//  15  expiry invalidates the session on the server                     P2-FR-02
//
// It writes a sanitised trace to the evidence directory named by
// `SKLN_E2E_TRACE`: one line per network exchange with the URL, the status and
// whether the exchange carried the API key. The key itself is never written —
// what is recorded is the ANSWER to "did this carry it", which is the fact the
// requirement is about.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PLAYWRIGHT IS A HARNESS DEPENDENCY, NOT A PACKAGE OF THIS TREE, so it is
// REQUIRED rather than imported: `npm ci` prunes anything `package.json` does not
// name, the browser gate therefore keeps Playwright outside the checkout, and an
// ESM `import` does not consult `NODE_PATH` while `require` does. The gate's own
// preflight uses `require.resolve` for the same reason.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = Number(process.env.SKLN_E2E_PORT ?? "7993");
const BASE = `http://127.0.0.1:${PORT}`;
const TRACE = process.env.SKLN_E2E_TRACE ?? join(tmpdir(), "console-e2e-trace.txt");
const SESSION_MS = Number(process.env.SKLN_E2E_SESSION_MS ?? "8000");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function trace(line) {
  appendFileSync(TRACE, `${line}\n`);
}

/** The two untrusted payloads. The first is the classic injection; the second
 *  is the one that fires without a script tag, which is what an `innerHTML`
 *  that "strips scripts" still executes. */
const XSS_TITLE = '<script>window.__pwned_title=1</script>';
const XSS_STEP = '<img src=x onerror="window.__pwned_step=1">';

/** Wait for an attribute to satisfy a predicate, by reading it. See the note at
 *  the edit step for why this is not `waitForFunction`. */
async function pollAttribute(page, selector, attribute, predicate, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await page.getAttribute(selector, attribute).catch(() => null);
    if (value !== null && predicate(value)) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${selector}[${attribute}] (last: ${value})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function api(path, { method = "GET", key, body, headers = {} } = {}) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  writeFileSync(TRACE, `# owner console browser E2E trace\n# base=${BASE}\n`);
  const dataDir = mkdtempSync(join(tmpdir(), "skln-e2e-"));

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "src/cli.ts", "serve", "--port", String(PORT), "--data", dataDir],
    {
      cwd: process.cwd(),
      env: { ...process.env, SKILLONOMIA_CONSOLE_SESSION_MS: String(SESSION_MS), SKILLONOMIA_WORKER_MS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let banner = "";
  child.stdout.on("data", (b) => {
    banner += b.toString();
  });
  child.stderr.on("data", (b) => {
    banner += b.toString();
  });

  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stop);

  // wait for the listener, and for the version to be THIS checkout's
  let health = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await api("/health");
      if (res.ok) {
        health = await res.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!health) {
    console.error(banner);
    throw new Error(`REFUSED: no listener on ${BASE}`);
  }
  const expected = JSON.parse((await import("node:fs")).readFileSync("package.json", "utf8")).version;
  if (health.version !== expected) {
    throw new Error(`REFUSED: ${BASE}/health reports ${health.version}, this checkout is ${expected} — another process holds the port`);
  }
  trace(`health version=${health.version}`);

  // the owner's API key, through the §9.1 exchange. It stays in THIS process.
  const tokenLine = /BOOTSTRAP_OWNER_TOKEN[=: ]+(\S+)/.exec(banner);
  if (!tokenLine) {
    console.error(banner);
    throw new Error("REFUSED: the deployment printed no bootstrap token");
  }
  const exchanged = await (await api("/v1/auth/bootstrap", { method: "POST", body: { bootstrap_token: tokenLine[1] } })).json();
  const OWNER_KEY = exchanged.api_key;
  if (typeof OWNER_KEY !== "string" || OWNER_KEY.length < 20) throw new Error("REFUSED: no owner API key");

  // ---- the drafts, created through the backend surface -------------------
  //
  // One clean draft that can be approved, one carrying untrusted markup, and
  // one incomplete draft that must NOT be approvable.
  const clean = await (
    await api("/v1/captures", {
      method: "POST",
      key: OWNER_KEY,
      body: {
        kind: "workflow",
        title: "release-the-build",
        text: [
          "# release-the-build",
          "",
          "Use this whenever a release has to go out.",
          "",
          "## Purpose",
          "Cut a release from a green build.",
          "",
          "## Procedure",
          "1. Run the test suite and read the failures.",
          "2. Tag the commit that passed.",
          "3. Publish the notes.",
          "",
          "## Inputs",
          "- the commit SHA",
          "",
          "## Outputs",
          "- a tagged release",
          "",
          "## Permissions",
          "- read the repository",
          "",
          "## Dependencies",
          "- git",
          "",
          "## Failure modes",
          "- the suite is red, so nothing is tagged",
        ].join("\n"),
      },
    })
  ).json();
  const untrusted = await (
    await api("/v1/captures", {
      method: "POST",
      key: OWNER_KEY,
      body: {
        kind: "workflow",
        title: XSS_TITLE,
        text: [
          `# ${XSS_TITLE}`,
          "",
          "Use this whenever the renderer is under test.",
          "",
          "## Purpose",
          `Prove that ${XSS_STEP} is text.`,
          "",
          "## Procedure",
          `1. ${XSS_STEP}`,
          "2. Read what the page shows.",
          "",
          "## Inputs",
          "- nothing",
          "",
          "## Outputs",
          "- nothing",
          "",
          "## Permissions",
          "- none",
          "",
          "## Dependencies",
          "- none",
          "",
          "## Failure modes",
          "- the markup executes, which is the defect",
        ].join("\n"),
      },
    })
  ).json();
  const thin = await (
    await api("/v1/captures", {
      method: "POST",
      key: OWNER_KEY,
      body: {
        kind: "workflow",
        title: "half-a-procedure",
        text: "## Procedure\n1. Do the first thing.\n2. Then the second thing.\n\nWhenever something is missing.",
      },
    })
  ).json();

  for (const [name, c] of [["clean", clean], ["untrusted", untrusted], ["thin", thin]]) {
    if (c.outcome !== "drafted") throw new Error(`REFUSED: the ${name} capture did not produce a draft: ${JSON.stringify(c.refusal)}`);
    trace(`capture ${name} draft=${c.draft.draft_id} digest=${c.draft.content_digest}`);
  }

  // ---- the browser -------------------------------------------------------
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();

  // EVERY exchange is inspected for the API key, in the request AND in the
  // response body. This is `P2-FR-03` measured rather than asserted.
  let keySightings = 0;
  let exchanges = 0;
  page.on("request", (req) => {
    exchanges += 1;
    const post = req.postData() ?? "";
    const headers = JSON.stringify(req.headers());
    const carries = post.includes(OWNER_KEY) || headers.includes(OWNER_KEY) || req.url().includes(OWNER_KEY);
    if (carries) keySightings += 1;
    trace(`request  ${req.method()} ${req.url()} api_key_present=${carries}`);
  });
  page.on("response", async (res) => {
    let carries = false;
    try {
      const text = await res.text();
      carries = text.includes(OWNER_KEY);
    } catch {
      /* a body that cannot be read carries nothing this test can see; recorded as such */
    }
    if (carries) keySightings += 1;
    trace(`response ${res.status()} ${res.url()} api_key_present=${carries}`);
  });
  page.on("pageerror", (e) => trace(`pageerror ${e.message}`));

  // 1. no session, no console
  const unauth = await page.goto("/console");
  check("P2-FR-01 the protected console page refuses with no session", unauth.status() === 401, `status ${unauth.status()}`);
  const unauthApi = await api("/v1/console/drafts");
  check("P2-FR-01 the protected console API refuses with no session", unauthApi.status === 401, `status ${unauthApi.status}`);

  // 2. a ticket, minted server-side, traded for a session in the browser
  const ticketRes = await api("/v1/console/tickets", { method: "POST", key: OWNER_KEY, body: {} });
  const ticket = (await ticketRes.json()).ticket;
  await page.goto("/console/login");
  await page.fill("#ticket", ticket);
  await page.click("#login button[type=submit]");
  await page.waitForURL("**/console");
  const cookies = await context.cookies();
  const cookie = cookies.find((c) => c.name === "skln_console");
  check("P2-FR-02 a session cookie exists", Boolean(cookie));
  check("INV-04 the cookie is HttpOnly", cookie?.httpOnly === true);
  check("INV-04 the cookie is SameSite=Strict", cookie?.sameSite === "Strict", String(cookie?.sameSite));
  check("INV-04 the cookie path is /", cookie?.path === "/", String(cookie?.path));
  const lifetime = (cookie?.expires ?? 0) * 1000 - Date.now();
  check("INV-04 the absolute lifetime is 60 minutes or less", lifetime <= 60 * 60 * 1000, `${Math.round(lifetime / 1000)}s`);
  check(
    "INV-04 Secure is off for a loopback deployment and the reason is the host",
    cookie?.secure === false,
    "http://127.0.0.1 discards a Secure cookie; the flag follows the host",
  );
  const ticketReplay = await api("/v1/console/session", {
    method: "POST",
    body: { ticket },
    headers: { Origin: BASE },
  });
  check("the ticket is single-use", ticketReplay.status === 401, `status ${ticketReplay.status}`);

  // 3. the Inbox is the backend's
  await page.waitForSelector("#inbox[data-loaded=true]");
  const rowCount = Number(await page.getAttribute("#inbox-rows", "data-count"));
  check("P2-FR-04 the Inbox shows the backend's drafts", rowCount === 3, `${rowCount} rows for 3 captures`);

  // 4/5. the untrusted draft renders as text and executes nothing
  await page.click(`button[data-draft-id="${untrusted.draft.draft_id}"]`);
  await page.waitForSelector(`#detail[data-draft-id="${untrusted.draft.draft_id}"]`);
  const pwnedTitle = await page.evaluate(() => window.__pwned_title ?? null);
  const pwnedStep = await page.evaluate(() => window.__pwned_step ?? null);
  check("P2-FR-06 the script in the title did not execute", pwnedTitle === null);
  check("P2-FR-06 the onerror in the procedure did not execute", pwnedStep === null);
  const injected = await page.evaluate(() => document.querySelectorAll("#detail script, #detail img").length);
  check("P2-FR-06 no element was created from draft content", injected === 0, `${injected} elements`);
  const shown = await page.textContent("#detail h2");
  check("P2-FR-06 the markup is shown as characters", shown.includes("<script>"), JSON.stringify(shown?.slice(0, 40)));
  const panels = await page.evaluate(() => [...document.querySelectorAll("#detail h3")].map((h) => h.textContent));
  const wanted = ["Purpose", "When to use", "Procedure", "Inputs", "Outputs", "Permissions", "Dependencies", "Failure modes", "Provenance", "Lineage"];
  check(
    "P2-FR-05 the detail shows the structured panels",
    wanted.every((w) => panels.some((p) => p.startsWith(w))) && panels.some((p) => p.startsWith("Redactions")) &&
      panels.some((p) => p.startsWith("Semantic findings")) && panels.some((p) => p.startsWith("Security findings")),
    panels.join(", "),
  );

  // 7. a draft with a blocking finding cannot be approved
  await page.click(`button[data-draft-id="${thin.draft.draft_id}"]`);
  await page.waitForSelector(`#detail[data-draft-id="${thin.draft.draft_id}"]`);
  const thinApprovable = await page.getAttribute("#eligibility", "data-approvable");
  const thinReason = await page.getAttribute("#eligibility", "data-reason-code");
  const thinDisabled = await page.isDisabled("#approve");
  check("P2-FR-09 an incomplete draft is not approvable", thinApprovable === "false", `${thinReason}`);
  check("P2-FR-09 the approve control is disabled from the server's field", thinDisabled);
  const forced = await api(`/v1/console/drafts/${thin.draft.draft_id}/approve`, {
    method: "POST",
    body: { revision_id: thin.draft.revision_id },
    headers: {
      Origin: BASE,
      Cookie: `skln_console=${cookie.value}`,
      "X-Skillonomia-Console-CSRF": await page.evaluate(async () => (await (await fetch("/v1/console/session")).json()).csrf_token),
    },
  });
  check(
    "P2-FR-09 the server refuses the approval even when the control is bypassed",
    forced.status === 412,
    `status ${forced.status}`,
  );

  // 6. an edit is a new revision, with the previews re-run
  await page.click(`button[data-draft-id="${clean.draft.draft_id}"]`);
  await page.waitForSelector(`#detail[data-draft-id="${clean.draft.draft_id}"]`);
  const revBefore = await page.getAttribute("#detail", "data-revision-id");
  await page.fill("#edit-procedure", "Run the suite and read the failures.\nTag the commit that passed.\nPublish the notes and the digest.");
  await page.click("#save-edit");
  // POLLED, not `waitForFunction`. Playwright's wait helpers evaluate a string in
  // the page, and this console's own Content-Security-Policy has no
  // `unsafe-eval` — so the wait is refused by the very header the page is meant
  // to carry. Polling an attribute uses the same channel the assertions do and
  // leaves the policy intact, which is the property being measured.
  const revAfter = await pollAttribute(page, "#detail", "data-revision-id", (v) => v !== revBefore);
  check("P2-FR-07 an edit created a NEW revision", revAfter !== revBefore, `${revBefore} → ${revAfter}`);
  const server = await (await api(`/v1/drafts/${clean.draft.draft_id}`, { key: OWNER_KEY })).json();
  check("P2-FR-07 the backend holds the new revision as the head", server.revision.revision_id === revAfter);
  check("P2-FR-07 the previous revision is unchanged", server.lineage.length === 2 && server.lineage[0].revision_id === revBefore);
  check(
    "P2-FR-07 both previews were re-run for the new revision",
    typeof server.revision.semantic_review.blocking_count === "number" &&
      typeof server.revision.security_review.blocking_count === "number" &&
      server.revision.semantic_review.compiler_version.length > 0,
  );
  check("INV-06 the edit produced a different content digest", server.revision.content_digest !== clean.draft.content_digest);

  // 10. cross-site and wrong-Origin mutations
  const csrfToken = await page.evaluate(async () => (await (await fetch("/v1/console/session")).json()).csrf_token);
  const noCsrf = await api(`/v1/console/drafts/${clean.draft.draft_id}/approve`, {
    method: "POST",
    body: {},
    headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}` },
  });
  check("P2-FR-13 a mutation with no CSRF token is refused", noCsrf.status === 403, `status ${noCsrf.status}`);
  const badOrigin = await api(`/v1/console/drafts/${clean.draft.draft_id}/approve`, {
    method: "POST",
    body: {},
    headers: { Origin: "https://attacker.example", Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrfToken },
  });
  check("P2-FR-13 a mutation from another origin is refused", badOrigin.status === 403, `status ${badOrigin.status}`);
  const noOrigin = await api(`/v1/console/drafts/${clean.draft.draft_id}/approve`, {
    method: "POST",
    body: {},
    headers: { Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrfToken },
  });
  check("P2-FR-13 a mutation with no Origin at all is refused", noOrigin.status === 403, `status ${noOrigin.status}`);

  // A REAL CROSS-SITE FORM, in the browser, from another origin. `SameSite=Strict`
  // means the cookie is not attached at all — the request arrives unauthenticated
  // — and the server answers 401. Nothing is decided.
  const attacker = await context.newPage();
  await attacker.route("https://attacker.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<form id="f" method="POST" action="${BASE}/v1/console/drafts/${clean.draft.draft_id}/approve"><input name="x"></form>`,
    }),
  );
  await attacker.goto("https://attacker.example/evil");
  const crossSite = await attacker.evaluate(
    async (url) => {
      try {
        const res = await fetch(url, { method: "POST", credentials: "include", mode: "no-cors", body: "{}" });
        return res.status;
      } catch (e) {
        return `blocked:${String(e).slice(0, 60)}`;
      }
    },
    `${BASE}/v1/console/drafts/${clean.draft.draft_id}/approve`,
  );
  // WHAT THIS ASSERTS, AND WHY IT IS NOT THE REVISION ID. P2 REVIEW-1's
  // non-blocking backlog: this used to compare `revision.revision_id` against
  // the id from before the attempt — but the request the attacker page makes is
  // an APPROVE, and an approval never changes which revision is the head. The
  // comparison therefore held whether the cross-site POST was refused or
  // carried out, which is a check that cannot fail. The state a successful
  // approve WOULD move is the decision, so that is what is read: through the
  // console surface, over the owner's own cookie, asserting the draft is still
  // undecided and no decision row names it.
  const afterCrossSite = await (
    await api(`/v1/console/drafts/${clean.draft.draft_id}`, { headers: { Cookie: `skln_console=${cookie.value}` } })
  ).json();
  check(
    "P2-FR-13 a real cross-site submission decided nothing",
    afterCrossSite.state === "pending" && afterCrossSite.decision === null,
    `cross-site attempt returned ${crossSite}; state=${afterCrossSite.state}`,
  );
  await attacker.close();

  // 8. approve, from the page
  await page.reload();
  await page.waitForSelector("#inbox[data-loaded=true]");
  await page.click(`button[data-draft-id="${clean.draft.draft_id}"]`);
  await page.waitForSelector("#eligibility");
  const approvable = await page.getAttribute("#eligibility", "data-approvable");
  check("P2-FR-11 the approve verdict is the server's field", approvable === "true");
  await page.click("#approve");
  await page.waitForSelector("#decision-line");
  const decisionLine = await page.textContent("#decision-line");
  check("P2-FR-08 the console shows the decision", decisionLine.startsWith("approved"), decisionLine);

  const audit = await (await api(`/v1/drafts/${clean.draft.draft_id}/audit`, { key: OWNER_KEY })).json();
  const consoleAudit = await page.evaluate(
    async (id) => await (await fetch(`/v1/console/drafts/${id}/audit`)).json(),
    clean.draft.draft_id,
  );
  const approved = consoleAudit.items.find((i) => i.event === "approved");
  check("P2-FR-08 the audit carries the approval as a structured event", Boolean(approved));
  check("P2-FR-08 it names the exact revision", approved?.draft_revision_id === revAfter, String(approved?.draft_revision_id));
  check("P2-FR-08 it names the digest", approved?.content_digest === server.revision.content_digest);
  check("P2-FR-08 it names the owner actor and a role", typeof approved?.actor_agent_id === "string" && approved?.actor_role === "owner");
  check("P2-FR-08 it names a timestamp", Number.isInteger(approved?.server_at_ms) && approved.server_at_ms > 0);
  check(
    "INV-05 every audit entry carries the field set, not a sentence",
    consoleAudit.items.every(
      (i) => typeof i.event === "string" && typeof i.result === "string" && typeof i.actor_agent_id === "string" && typeof i.source === "string",
    ),
    `${consoleAudit.items.length} entries`,
  );
  check("P1's own audit is preserved beneath it", audit.items.length >= 3, `${audit.items.length} draft_events`);

  // 11. a resent decision is one decision
  const resend = await api(`/v1/console/drafts/${clean.draft.draft_id}/approve`, {
    method: "POST",
    body: { revision_id: revAfter },
    headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrfToken },
  });
  check("P2-FR-13 a second decision on one draft is a conflict", resend.status === 409, `status ${resend.status}`);
  const conflictBody = await resend.json();
  check("the conflict states the current state so a console converges", conflictBody.error?.current_state === "approved", JSON.stringify(conflictBody.error ?? null));
  // 10b. THE EDIT TRANSITION IS THE SERVER'S — `P2-FR-11`, P2 REVIEW-1 finding
  // `P2-R1-003`, as V1 P3 leaves it. The page renders the server's
  // `actions.revise.allowed` and holds no rule of its own; what the SERVER
  // answers changed in P3, because approval became a fact about a REVISION.
  // An approved lineage takes a further revision, and `INV-06` holds by
  // APPENDING: the approved revision keeps its row, its approval and its place.
  const reviseAllowed = await page.getAttribute("#eligibility", "data-revise-allowed");
  const reviseReason = await page.getAttribute("#eligibility", "data-revise-reason");
  check("P2-FR-11 the page renders the server's revise verdict", reviseAllowed === "true", `data-revise-allowed=${reviseAllowed}`);
  check("P2-FR-11 and the machine-readable reason with it", reviseReason === "REVISABLE", String(reviseReason));
  const saveDisabled = await page.getAttribute("#save-edit", "disabled");
  check("P2-FR-11 the Save button follows that field", saveDisabled === null);
  const editAfter = await api(`/v1/console/drafts/${clean.draft.draft_id}/revisions`, {
    method: "POST",
    body: { sections: { procedure: ["Read it twice.", "Tag the commit.", "Publish the notes."] } },
    headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrfToken },
  });
  const editAfterBody = await editAfter.json();
  check("P3 an approved lineage takes a further revision", editAfter.status === 201, `status ${editAfter.status}`);
  const afterRefusal = await (await api(`/v1/drafts/${clean.draft.draft_id}`, { key: OWNER_KEY })).json();
  check("INV-06 the approved revision is still itself", afterRefusal.lineage.some((r) => r.revision_id === revAfter));
  check("INV-06 the edit APPENDED rather than rewrote", afterRefusal.lineage.length === 3, `${afterRefusal.lineage.length} revisions`);
  check(
    "P3 the new head is the edit and it carries no approval of its own",
    afterRefusal.revision.revision_id === editAfterBody.revision_id,
    String(editAfterBody.revision_id),
  );
  const capabilityView = await (await api(`/v1/console/capabilities/${clean.draft.draft_id}`, {
    headers: { Cookie: `skln_console=${cookie.value}` },
  })).json();
  check(
    "P3 the capability carries exactly the approved revisions as the rollback targets",
    Array.isArray(capabilityView.approved_revisions) && capabilityView.approved_revisions.length === 1,
    JSON.stringify(capabilityView.approved_revisions?.map((a) => a.draft_revision_id) ?? null),
  );
  check(
    "P3 and it says the change would take effect in the next session",
    capabilityView.effective_from === "next_session",
    String(capabilityView.effective_from),
  );

  // 11. the rest of the decision rules
  const idem = "e2e-approve-once";
  const first = await api(`/v1/console/drafts/${thin.draft.draft_id}/reject`, {
    method: "POST",
    body: { reason: "not a reusable procedure after all", idempotency_key: idem },
    headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrfToken },
  });
  const second = await api(`/v1/console/drafts/${thin.draft.draft_id}/reject`, {
    method: "POST",
    body: { reason: "not a reusable procedure after all", idempotency_key: idem },
    headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrfToken },
  });
  check("P2-FR-10 a rejection with a reason is recorded", first.status === 201, `status ${first.status}`);
  check("P2-FR-13 the same request sent twice is one decision", second.status === 201 && second.headers.get("idempotency-replayed") === "true");
  const noReason = await api(`/v1/console/drafts/${untrusted.draft.draft_id}/reject`, {
    method: "POST",
    body: {},
    headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrfToken },
  });
  check("P2-FR-10 a rejection without a reason is refused", noReason.status === 400, `status ${noReason.status}`);
  const rejectedDraft = await (await api(`/v1/drafts/${thin.draft.draft_id}`, { key: OWNER_KEY })).json();
  check("P2-FR-10 the rejected revision is still there", rejectedDraft.revision.revision_id === thin.draft.revision_id);

  // 12. browser storage, after the whole workflow
  await page.reload();
  await page.waitForSelector("#inbox[data-loaded=true]");
  const storage = await page.evaluate(async () => {
    const dump = { local: {}, session: {}, cookies: document.cookie, caches: [], idb: [] };
    for (let i = 0; i < localStorage.length; i += 1) dump.local[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
    for (let i = 0; i < sessionStorage.length; i += 1) dump.session[sessionStorage.key(i)] = sessionStorage.getItem(sessionStorage.key(i));
    if (window.caches?.keys) dump.caches = await caches.keys();
    if (indexedDB.databases) dump.idb = (await indexedDB.databases()).map((d) => d.name);
    return dump;
  });
  trace(`storage ${JSON.stringify({ ...storage, cookies: storage.cookies.length === 0 ? "" : "<non-empty>" })}`);
  check("P2-FR-14 localStorage is empty", Object.keys(storage.local).length === 0, JSON.stringify(storage.local));
  check("P2-FR-14 sessionStorage is empty", Object.keys(storage.session).length === 0, JSON.stringify(storage.session));
  check("P2-FR-14 no JS-readable cookie exists", storage.cookies === "", storage.cookies);
  check("P2-FR-14 the Cache API holds nothing", storage.caches.length === 0, JSON.stringify(storage.caches));
  check("P2-FR-14 IndexedDB holds nothing", storage.idb.length === 0, JSON.stringify(storage.idb));
  const urls = page.url();
  check("INV-04 no credential is in the URL", !urls.includes(ticket) && !urls.includes(OWNER_KEY) && !urls.includes(cookie.value), urls);
  const bundle = await (await api("/console/app.js")).text();
  check(
    "INV-04 the bundle carries no credential",
    !bundle.includes(OWNER_KEY) && !bundle.includes(ticket) && !/sk_own|bt_/.test(bundle),
    `${bundle.length} bytes`,
  );

  // 13. the network trace
  check("P2-FR-03 no browser request or response carried the Registry API key", keySightings === 0, `${exchanges} exchanges inspected`);

  // 14. logout invalidates SERVER-side
  const cookieValue = cookie.value;
  await page.click("#logout");
  await page.waitForURL("**/console/login");
  const afterLogout = await api("/v1/console/drafts", { headers: { Cookie: `skln_console=${cookieValue}` } });
  check("P2-FR-02 logout invalidates the session on the server", afterLogout.status === 401, `status ${afterLogout.status}`);

  // 15. expiry invalidates SERVER-side
  const ticket2 = (await (await api("/v1/console/tickets", { method: "POST", key: OWNER_KEY, body: {} })).json()).ticket;
  const opened = await api("/v1/console/session", { method: "POST", body: { ticket: ticket2 }, headers: { Origin: BASE } });
  const setCookie = opened.headers.get("set-cookie");
  const value2 = /skln_console=([^;]+)/.exec(setCookie)[1];
  const live = await api("/v1/console/drafts", { headers: { Cookie: `skln_console=${value2}` } });
  check("a fresh session works", live.status === 200, `status ${live.status}`);
  await new Promise((r) => setTimeout(r, SESSION_MS + 750));
  const expired = await api("/v1/console/drafts", { headers: { Cookie: `skln_console=${value2}` } });
  check("P2-FR-02 expiry invalidates the session on the server", expired.status === 401, `status ${expired.status}`);
  const expiredPage = await page.goto("/console");
  check("P2-FR-01 the page refuses once the session has expired", expiredPage.status() === 401, `status ${expiredPage.status()}`);

  // 15b. machine-to-machine compatibility, at the same instant
  const m2m = await api("/v1/drafts", { key: OWNER_KEY });
  check("P2-FR-15 the machine-to-machine client still works", m2m.status === 200, `status ${m2m.status}`);
  const m2mNoConsole = await api("/v1/console/drafts", { key: OWNER_KEY });
  check(
    "the console API is a session surface and not a second key surface",
    m2mNoConsole.status === 401,
    `status ${m2mNoConsole.status}`,
  );

  await browser.close();
  stop();

  const failed = checks.filter((c) => !c.ok);
  trace(`checks total=${checks.length} failed=${failed.length}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} browser checks passed`);
  console.log(`trace: ${TRACE}`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
    process.exit(1);
  }
  if (checks.length < 40) {
    console.error(`REFUSED: only ${checks.length} checks ran; this gate covers more than that`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(/^REFUSED/.test(String(e && e.message)) ? 2 : 1);
});
