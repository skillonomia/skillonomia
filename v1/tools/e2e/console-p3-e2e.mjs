// THE ASSIGNMENT AND LIFECYCLE SCREEN, IN A REAL BROWSER — V1 P3.
//
//   node v1/tools/e2e/console-p3-e2e.mjs                  the run
//   node v1/tools/e2e/console-p3-e2e.mjs --broken-client  the demonstration that
//                                                          its conflict probes
//                                                          can fail
//
// WHAT IS DRIVEN. Chromium, through Playwright, against a real `skillonomia
// serve` with its own temporary data directory and its own SQLite file. The
// capability it drives is a lineage this run captures through `POST /v1/captures`
// and approves TWICE through the console surface, so the screen has a real
// rollback target. Nothing here is a fixture, a stub or a hand-written row
// (contract section 9).
//
// WHAT IT ASSERTS, and the requirement each assertion is owed to:
//
//   1  the capability screen states that a change takes effect in the
//      NEXT session and that the current loadout is unchanged      P3-FR-14, INV-07
//   2  assign, activate and revision selection are driven from the
//      page and land in the registry                               P3-FR-01..05
//   3  desired and observed are two blocks, each naming its source  P3-FR-07, INV-02
//   4  an owner command leaves observed exactly where it was        P3-FR-06, INV-02
//   5  an observed `unknown` is shown with its reason code, its
//      reason and its source — never blank, never as a success      P3-FR-08, INV-03
//   6  a rollback selects an earlier approved revision and deletes
//      nothing                                                     P3-FR-05, INV-06
//   7  A REAL PRECONDITION FAILURE (412): the assignment moves under
//      the page, the page's command is refused, the page REFETCHES
//      canonical state, shows the conflict, and shows no success    P3-FR-11, P3-FR-12
//   8  A REAL CONFLICT (409): one idempotency key, two payloads —
//      the page is refused, refetches, shows the conflict and shows
//      no success                                                   P3-FR-10, P3-FR-12
//   9  neither refusal appended an event to the lifecycle journal   INV-06
//
// THE CONFLICTS ARE THIS SERVER'S OWN. The 412 is produced by moving the
// assignment out from under the rendered page — a second client, which is what a
// second tab is — so the `if_version` the page holds is stale. The 409 is
// produced by re-issuing one command with a different note under the same
// idempotency key, which is exactly the payload-conflict rule `P3-FR-10` names.
// Neither status is faked or intercepted: the run records the statuses the
// browser actually received and refuses to report on them if they are not 412
// and 409.
//
// A PROBE NOBODY HAS SEEN FAIL PROVES NOTHING, which is why `--broken-client`
// exists — the pattern P2 established with `console-error-contract.mjs`. It
// rebuilds the bundle from a copy of `console/app.ts` whose conflict handling is
// undone: no refetch when a command is refused, and the result line written as
// `applied` regardless. Every conflict probe must FAIL against those bytes
// and the controls must still pass, so that what changed between the two runs is
// the page's behaviour and not the harness.
//
// EXIT CODES, the same four every gate harness in this tree uses:
//   0  passed          1  failed          2  REFUSED (could not reach the subject)
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright is a harness dependency, resolved through `require` so that
// `NODE_PATH` is consulted — see the note at the head of `console-e2e.mjs`.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const REPO = new URL("../../../", import.meta.url).pathname;
const BROKEN = process.argv.includes("--broken-client");
const PORT = Number(process.env.SKLN_P3_E2E_PORT ?? (BROKEN ? "7988" : "7989"));
const BASE = `http://127.0.0.1:${PORT}`;
const TRACE = process.env.SKLN_P3_E2E_TRACE ?? join(tmpdir(), "console-p3-e2e-trace.txt");

const results = [];
/** A control: it must pass in BOTH modes. */
function control(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail, kind: "control" });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
/** A conflict probe: it must pass in the normal run and FAIL against the
 *  pre-fix client. Its verdict is recorded and judged at the end. */
const probes = [];
function probe(name, ok, detail = "") {
  probes.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function trace(line) {
  appendFileSync(TRACE, `${line}\n`);
}
function refuse(why) {
  console.error(`REFUSED: ${why}`);
  process.exit(2);
}

/**
 * THE PRE-FIX CLIENT, reconstructed rather than described.
 *
 * `ownerCommand` in `console/app.ts` refetches canonical state after EVERY owner
 * command and then reports the server's answer. The mutation below refetches
 * only when the command succeeded and writes `applied` on the result line
 * whatever happened — which is the false success `P3-FR-12` forbids, built on
 * purpose so the probes can be seen to catch it.
 */
const FIX_TAIL = "  await refreshCapability();\n  reportLifecycle(action, failure);\n";
const BROKEN_TAIL = [
  "  if (failure === null) await refreshCapability();",
  '  const box = document.getElementById("lifecycle-result");',
  "  if (box) {",
  "    box.textContent = `${action}: accepted by the registry`;",
  '    box.dataset.result = "applied";',
  '    box.dataset.code = "";',
  '    box.dataset.currentState = "";',
  "  }",
  "",
].join("\n");

function brokenClientSource() {
  const source = readFileSync(join(REPO, "console/app.ts"), "utf8");
  if (!source.includes(FIX_TAIL)) {
    refuse("console/app.ts does not have the shape this mutation edits; the demonstration cannot be built.");
  }
  const mutated = source.replace(FIX_TAIL, BROKEN_TAIL);
  if (mutated === source) refuse("the mutation did nothing.");
  return mutated;
}

function buildBrokenBundle() {
  const dir = mkdtempSync(join(tmpdir(), "skln-broken-p3-console-"));
  const entry = join(dir, "app.ts");
  const out = join(dir, "app.js");
  writeFileSync(entry, brokenClientSource());
  const built = spawnSync("bun", ["build", "--target=browser", "--format=esm", entry, "--outfile", out], {
    encoding: "utf8",
  });
  if (built.status !== 0) refuse(`the mutated bundle did not build: ${built.stderr ?? built.error}`);
  return readFileSync(out, "utf8");
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

const WORKFLOW = (step) =>
  [
    "# ship-the-change",
    "",
    "Use this whenever a reviewed change is ready to go out.",
    "",
    "## Purpose",
    "Ship a reviewed change without guessing.",
    "",
    "## Procedure",
    "1. Read the diff.",
    `2. ${step}`,
    "3. Merge it and record the digest.",
    "",
    "## Inputs",
    "- the branch",
    "",
    "## Outputs",
    "- a merged change",
    "",
    "## Permissions",
    "- write to the repository",
    "",
    "## Dependencies",
    "- git",
    "",
    "## Failure modes",
    "- the suite is red, so nothing merges",
  ].join("\n");

/**
 * A click on an owner command, and the wait for its answer.
 *
 * The result line is CLEARED first. Without that, the wait below would see the
 * PREVIOUS command's verdict still on the page and return before this command
 * had even been sent — a harness that reports on the answer to a question it did
 * not ask, which is what the first run of this file did.
 */
async function clickCommand(page, target) {
  await page.evaluate(() => {
    const box = document.getElementById("lifecycle-result");
    if (box) {
      box.dataset.result = "";
      box.dataset.code = "";
      box.dataset.currentState = "";
      box.textContent = "";
    }
  });
  if (typeof target === "string") await page.click(target);
  else await target.click();
  await pollAttribute(page, "#lifecycle-result", "data-result", (v) => v.length > 0);
}

/** Wait until an attribute satisfies a predicate. Polled rather than evaluated
 *  in the page, for the Content-Security-Policy reason `console-e2e.mjs` gives. */
async function pollAttribute(page, selector, attribute, predicate, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await page.getAttribute(selector, attribute).catch(() => null);
    if (value !== null && predicate(value)) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${selector}[${attribute}] (last: ${value})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  writeFileSync(TRACE, `# owner console P3 browser E2E trace\n# base=${BASE}\n# broken_client=${BROKEN}\n`);
  const dataDir = mkdtempSync(join(tmpdir(), "skln-p3-e2e-"));
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "src/cli.ts", "serve", "--port", String(PORT), "--data", dataDir],
    { cwd: REPO, env: { ...process.env, SKILLONOMIA_WORKER_MS: "0" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let banner = "";
  child.stdout.on("data", (b) => (banner += b.toString()));
  child.stderr.on("data", (b) => (banner += b.toString()));
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stop);

  // THE VERSION IS ASSERTED, not assumed: another registry holding this port
  // would otherwise be the thing measured.
  const expected = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  let health = null;
  for (let i = 0; i < 150 && health === null; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) health = await res.json();
    } catch {
      /* not up yet */
    }
    if (health === null) await new Promise((r) => setTimeout(r, 100));
  }
  if (health === null) {
    console.error(banner);
    refuse(`nothing answered /health on ${BASE}`);
  }
  if (health.version !== expected) refuse(`${BASE} answers version ${health.version}, not this checkout's ${expected}`);
  trace(`health version=${health.version}`);

  const token = /BOOTSTRAP_OWNER_TOKEN[=: ]+(\S+)/.exec(banner);
  if (!token) {
    console.error(banner);
    refuse("the server printed no bootstrap token");
  }
  const owner = await (await api("/v1/auth/bootstrap", { method: "POST", body: { bootstrap_token: token[1] } })).json();
  const KEY = owner.api_key;
  if (typeof KEY !== "string" || KEY.length < 20) refuse("no owner API key");

  const captured = await (
    await api("/v1/captures", { method: "POST", key: KEY, body: { kind: "workflow", text: WORKFLOW("Run the suite.") } })
  ).json();
  if (captured.outcome !== "drafted") refuse(`the capture did not produce a draft: ${JSON.stringify(captured.refusal)}`);
  const draftId = captured.draft.draft_id;
  const revision1 = captured.draft.revision_id;

  // ---- the browser -------------------------------------------------------
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();

  if (BROKEN) {
    const bundle = buildBrokenBundle();
    await page.route("**/console/app.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: bundle }),
    );
    console.log("client: the PRE-FIX bundle (no refetch on a refused command, and the result line always `applied`)");
  } else {
    console.log("client: dist-console/app.js, as this checkout builds it");
  }
  console.log(`port:   ${PORT}`);
  console.log(`trace:  ${TRACE}`);
  console.log();

  // The exchanges this page really made, in order — what "the console refetched
  // canonical state" is measured against rather than inferred from.
  const exchanges = [];
  page.on("response", (res) => {
    const url = new URL(res.url());
    const line = { method: res.request().method(), path: url.pathname, status: res.status() };
    exchanges.push(line);
    trace(`${line.method} ${line.path} ${line.status}`);
  });
  page.on("pageerror", (e) => trace(`pageerror ${e.message}`));

  const ticket = await (await api("/v1/console/tickets", { method: "POST", key: KEY, body: {} })).json();
  await page.goto("/console/login");
  await page.fill("#ticket", ticket.ticket);
  await page.click("#login button[type=submit]");
  await page.waitForURL("**/console");
  await page.waitForSelector("#inbox[data-loaded=true]");

  const csrf = await page.evaluate(async () => (await (await fetch("/v1/console/session")).json()).csrf_token);
  const cookies = await context.cookies();
  const cookie = cookies.find((c) => c.name === "skln_console");
  if (!cookie) refuse("no session cookie");
  /** A second client of the same owner — which is what a second tab is. The
   *  out-of-band moves below go through it, so the page's rendered version goes
   *  stale exactly as it would with two windows open. */
  const asSecondClient = (path, body, method = "POST") =>
    api(path, {
      method,
      body,
      headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrf },
    });

  // Two approved revisions of one lineage, both through the console surface —
  // the second is what makes a rollback target exist (`P3-FR-05`).
  const approve1 = await asSecondClient(`/v1/console/drafts/${draftId}/approve`, {
    revision_id: revision1,
    idempotency_key: "p3-approve-1",
  });
  if (approve1.status !== 201) refuse(`the first approval answered ${approve1.status}`);
  const revised = await asSecondClient(`/v1/console/drafts/${draftId}/revisions`, {
    sections: { procedure: ["Read the diff.", "Run the suite twice.", "Merge it and record the digest."] },
    idempotency_key: "p3-revise-1",
  });
  if (revised.status !== 201) refuse(`the revise answered ${revised.status}`);
  const revision2 = (await revised.json()).revision_id;
  const approve2 = await asSecondClient(`/v1/console/drafts/${draftId}/approve`, {
    revision_id: revision2,
    idempotency_key: "p3-approve-2",
  });
  if (approve2.status !== 201) refuse(`the second approval answered ${approve2.status}`);

  // ---- 1. the capability screen -----------------------------------------
  await page.reload();
  await page.waitForSelector("#capabilities[data-loaded=true]");
  const libraryRows = Number(await page.getAttribute("#capability-rows", "data-count"));
  control("P3 the capability library shows the backend's capabilities", libraryRows === 1, `${libraryRows} rows`);
  const headApproved = await page.getAttribute(`#inbox-rows tr[data-draft-id="${draftId}"] td[data-head-approved]`, "data-head-approved");
  control(
    "P3 the Inbox shows the HEAD's own approval beside the lineage's state",
    headApproved === "true",
    `data-head-approved=${headApproved}`,
  );

  await page.click(`button[data-capability-id="${draftId}"]`);
  await page.waitForSelector(`#capability[data-capability-id="${draftId}"]`);

  const effectiveFrom = await page.getAttribute("#effective-from", "data-effective-from");
  const effectiveText = (await page.textContent("#effective-from")) ?? "";
  control("P3-FR-14 the page carries the server's effective_from", effectiveFrom === "next_session", String(effectiveFrom));
  control(
    "INV-07 the page states that a change takes effect in the NEXT session and the current loadout is unchanged",
    /NEXT session/.test(effectiveText) && /unchanged/.test(effectiveText),
    JSON.stringify(effectiveText),
  );

  const fleetCount = Number(await page.getAttribute("#fleet", "data-count"));
  control("P3-FR-01 the closed fleet is rendered from the server's list", fleetCount >= 1, `${fleetCount} agents`);

  // ---- 2. assign, from the page -----------------------------------------
  const assignable = await page.$(`#fleet div[data-assignable="true"] button[data-assign-agent-id]`);
  if (!assignable) refuse("no agent was assignable; the screen cannot be driven");
  const agentId = await assignable.getAttribute("data-assign-agent-id");
  await page.fill("#lifecycle-reason", "assigned from the console");
  await clickCommand(page, assignable);
  const assignmentCount = Number(await page.getAttribute("#assignments", "data-count"));
  control("P3-FR-02 the assign control created a canonical assignment", assignmentCount === 1, `${assignmentCount}`);
  const assignmentId = await page.getAttribute(".assignment", "data-assignment-id");
  const serverAssignment = await (
    await api(`/v1/console/assignments/${assignmentId}`, { headers: { Cookie: `skln_console=${cookie.value}` } })
  ).json();
  control(
    "P3-FR-01 the assignment names the head APPROVED revision",
    serverAssignment.assignment.desired.revision_id === revision2,
    String(serverAssignment.assignment.desired.revision_id),
  );

  // ---- 3/5. desired and observed, apart -----------------------------------
  const desiredState = await page.getAttribute(".assignment .desired", "data-desired-state");
  const desiredText = (await page.textContent(".assignment .desired")) ?? "";
  const observedStatus = await page.getAttribute(".assignment .observed", "data-observed-status");
  const observedReason = await page.getAttribute(".assignment .observed", "data-observed-reason-code");
  const observedSource = await page.getAttribute(".assignment .observed", "data-observed-source");
  const observedText = (await page.textContent(".assignment .observed")) ?? "";
  control("P3-FR-07 the desired block is the owner's intent", desiredState === "assigned", String(desiredState));
  control(
    "P3-FR-07 desired and observed are two blocks, and neither carries the other's field",
    (await page.getAttribute(".assignment .desired", "data-observed-status")) === null &&
      (await page.getAttribute(".assignment .observed", "data-desired-state")) === null,
  );
  control(
    "P3-FR-07 the desired block names the source it was read from",
    desiredText.includes("skill_assignment_events"),
    JSON.stringify(desiredText.slice(0, 120)),
  );
  control("P3-FR-08 an unreported assignment is observed `unknown`", observedStatus === "unknown", String(observedStatus));
  control("INV-03 the unknown carries a machine-readable reason code", observedReason === "NO_OBSERVATION", String(observedReason));
  control(
    "INV-03 the unknown carries its source",
    typeof observedSource === "string" && observedSource.includes("assignment_observations"),
    String(observedSource),
  );
  control(
    "INV-03 the reason and the source are on the screen, and the block is not blank",
    observedText.includes("NO_OBSERVATION") && observedText.includes("assignment_observations") && observedText.trim().length > 40,
    JSON.stringify(observedText.slice(0, 160)),
  );
  control(
    "INV-03 an unknown is not shown as a success",
    !/\bloaded\b|\binvoked\b|\bworked\b/.test(observedText),
    JSON.stringify(observedText.slice(0, 160)),
  );

  // ---- 4. an owner command changes desired only ---------------------------
  await clickCommand(page, `.assignment button[data-action="activate"]`);
  await pollAttribute(page, ".assignment .desired", "data-desired-state", (v) => v === "active");
  const observedAfterOwnerCommand = await page.getAttribute(".assignment .observed", "data-observed-status");
  const serverAfterActivate = await (
    await api(`/v1/console/assignments/${assignmentId}`, { headers: { Cookie: `skln_console=${cookie.value}` } })
  ).json();
  control("P3-FR-03 activate moved the DESIRED state", serverAfterActivate.assignment.desired.state === "active");
  control(
    "P3-FR-06 and left the OBSERVED state exactly where it was",
    observedAfterOwnerCommand === "unknown" && serverAfterActivate.assignment.observed.status === "unknown",
    `page=${observedAfterOwnerCommand} server=${serverAfterActivate.assignment.observed.status}`,
  );

  // ---- 6. rollback --------------------------------------------------------
  await page.selectOption(`#revision-${assignmentId}`, revision1);
  await clickCommand(page, `.assignment button[data-action="select_revision"]`);
  await pollAttribute(page, ".assignment .desired", "data-desired-revision-id", (v) => v === revision1);
  const afterRollback = await (
    await api(`/v1/console/assignments/${assignmentId}`, { headers: { Cookie: `skln_console=${cookie.value}` } })
  ).json();
  control(
    "P3-FR-05 the rollback selected the earlier APPROVED revision",
    afterRollback.assignment.desired.revision_id === revision1,
    String(afterRollback.assignment.desired.revision_id),
  );
  control(
    "INV-06 the newer approved revision is still there",
    afterRollback.assignment.approved_revisions.length === 2 &&
      afterRollback.assignment.approved_revisions.some((a) => a.draft_revision_id === revision2),
    `${afterRollback.assignment.approved_revisions.length} approved revisions`,
  );
  const auditBeforeConflicts = await (
    await api(`/v1/console/assignments/${assignmentId}/audit`, { headers: { Cookie: `skln_console=${cookie.value}` } })
  ).json();
  control(
    "P3-FR-13 the journal holds the three owner commands as structured events",
    auditBeforeConflicts.items.length === 3 && auditBeforeConflicts.items.every((i) => i.effective_from === "next_session"),
    `${auditBeforeConflicts.items.length} events`,
  );

  // ---- 7. A REAL PRECONDITION FAILURE ------------------------------------
  //
  // The assignment moves under the rendered page — a second client pauses it —
  // so the `if_version` the page holds is one behind. The click that follows is
  // an ordinary Activate.
  const movedUnderThePage = await asSecondClient(`/v1/console/assignments/${assignmentId}/pause`, {
    idempotency_key: "p3-out-of-band-pause",
    reason: "paused by a second window",
  });
  if (movedUnderThePage.status !== 200) refuse(`the out-of-band pause answered ${movedUnderThePage.status}`);
  const versionRendered = await page.getAttribute(".assignment", "data-entity-version");
  const before412 = exchanges.length;
  await clickCommand(page, `.assignment button[data-action="activate"]`);
  const after412 = exchanges.slice(before412);
  const the412 = after412.find((e) => e.method === "POST" && /\/activate$/.test(e.path));
  const refetchAfter412 = after412.some(
    (e) => e.method === "GET" && e.path === `/v1/console/capabilities/${draftId}` && e.status === 200,
  );
  const result412 = await page.getAttribute("#lifecycle-result", "data-result");
  const code412 = await page.getAttribute("#lifecycle-result", "data-code");
  const state412 = await page.getAttribute("#lifecycle-result", "data-current-state");
  const desiredAfter412 = await page.getAttribute(".assignment .desired", "data-desired-state");
  control(
    "P3-FR-11 the browser really received a 412 from this server",
    the412?.status === 412,
    `status ${the412?.status} (page held version ${versionRendered})`,
  );
  probe("P3-FR-12 (412) the page shows the refusal rather than a success", result412 === "refused" && code412 === "PRECONDITION_FAILED", `result=${result412} code=${code412}`);
  probe("P3-FR-12 (412) the page shows the state the server says it is in", state412 === "paused", String(state412));
  probe("P3-FR-12 (412) the page refetched canonical state after the refusal", refetchAfter412, `${after412.length} exchanges followed the click`);
  probe("P3-FR-12 (412) and what it shows is the canonical state, not the command", desiredAfter412 === "paused", String(desiredAfter412));

  // ---- 8. A REAL CONFLICT -------------------------------------------------
  //
  // One idempotency key, two payloads. The page keys a lifecycle command on the
  // assignment, the action and the version it was issued against, so re-issuing
  // the SAME command at the same version with a DIFFERENT note is one key over
  // two payloads — which is the case `P3-FR-10` answers `409`. The first click
  // is a convergent noop (the assignment is already paused), so the version does
  // not move and the second click collides with the first.
  await page.fill("#lifecycle-reason", "note one");
  await clickCommand(page, `.assignment button[data-action="pause"]`);
  const noopResult = await page.getAttribute("#lifecycle-result", "data-result");
  control("P3-FR-09 a command for the state an assignment is already in is accepted, not doubled", noopResult === "applied", String(noopResult));

  await page.fill("#lifecycle-reason", "note two");
  const before409 = exchanges.length;
  await clickCommand(page, `.assignment button[data-action="pause"]`);
  const after409 = exchanges.slice(before409);
  const the409 = after409.find((e) => e.method === "POST" && /\/pause$/.test(e.path));
  const refetchAfter409 = after409.some(
    (e) => e.method === "GET" && e.path === `/v1/console/capabilities/${draftId}` && e.status === 200,
  );
  const result409 = await page.getAttribute("#lifecycle-result", "data-result");
  const code409 = await page.getAttribute("#lifecycle-result", "data-code");
  const desiredAfter409 = await page.getAttribute(".assignment .desired", "data-desired-state");
  // WHAT THE DEMONSTRATION CANNOT REACH, SAID HERE RATHER THAN QUIETLY RELAXED.
  // The pre-fix client never refetched after the 412, so the version it holds is
  // two behind and this second click is refused as a PRECONDITION rather than as
  // a payload CONFLICT — the injected defect changes which refusal the server
  // gives. The normal run therefore asserts the 409 exactly; the demonstration
  // asserts only that the server really refused the click, which is what its
  // probes are about.
  if (BROKEN) {
    control(
      "the pre-fix client's second command was refused by the server (it cannot reach the 409: it never refetched the version)",
      the409?.status === 409 || the409?.status === 412,
      `status ${the409?.status}`,
    );
  } else {
    control("P3-FR-10 the browser really received a 409 from this server", the409?.status === 409, `status ${the409?.status}`);
  }
  probe("P3-FR-12 (409) the page shows the conflict rather than a success", result409 === "refused" && code409 === "CONFLICT", `result=${result409} code=${code409}`);
  probe("P3-FR-12 (409) the page refetched canonical state after the conflict", refetchAfter409, `${after409.length} exchanges followed the click`);

  // ---- 9. neither refusal wrote anything ---------------------------------
  const auditAfter = await (
    await api(`/v1/console/assignments/${assignmentId}/audit`, { headers: { Cookie: `skln_console=${cookie.value}` } })
  ).json();
  control(
    "INV-06 the two refusals appended nothing to the journal",
    // three owner commands from the page, one out-of-band pause, and no more:
    // the noop appends no event and neither refusal does
    auditAfter.items.length === 4,
    `${auditAfter.items.length} events: ${auditAfter.items.map((i) => i.event).join(", ")}`,
  );
  control(
    "P3-FR-15 every event says the change is for the next session",
    auditAfter.items.every((i) => i.effective_from === "next_session"),
  );
  const finalState = await (
    await api(`/v1/console/assignments/${assignmentId}`, { headers: { Cookie: `skln_console=${cookie.value}` } })
  ).json();
  probe(
    "P3-FR-12 the page and the registry agree at the end",
    finalState.assignment.desired.state === desiredAfter409,
    `registry=${finalState.assignment.desired.state} page=${desiredAfter409}`,
  );

  await browser.close();
  stop();

  // ---- the verdict --------------------------------------------------------
  console.log();
  const failedControls = results.filter((r) => !r.ok);
  if (BROKEN) {
    // The demonstration: every conflict probe must have FAILED, and the controls
    // must still pass — so that what changed between the two runs is the page.
    for (const p of probes) {
      const ok = !p.ok;
      results.push({ name: `the PRE-FIX client fails: ${p.name}`, ok, detail: p.detail, kind: "demonstration" });
      console.log(`${ok ? "ok  " : "FAIL"}  the PRE-FIX client fails: ${p.name}${p.detail ? ` — ${p.detail}` : ""}`);
    }
  } else {
    for (const p of probes) results.push({ ...p, kind: "probe" });
  }
  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(`checks: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  trace(`checks total=${results.length} failed=${failed.length}`);
  if (failed.length > 0) {
    console.log();
    console.log(
      BROKEN
        ? "FAIL  the pre-fix client did not behave as the defect says it does, or a control broke."
        : "FAIL  the P3 console screen does not hold on this surface.",
    );
    console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
    process.exit(1);
  }
  if (!BROKEN && failedControls.length === 0 && results.length < 25) {
    console.error(`REFUSED: only ${results.length} checks ran; this gate covers more than that`);
    process.exit(2);
  }
  console.log();
  console.log(
    BROKEN
      ? "PASS  every conflict probe failed against the pre-fix client, and the controls did not."
      : "PASS  the P3 screen assigns, activates, rolls back, keeps observed apart from desired, and converges on the server's answer at a 409 and a 412.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(/^REFUSED/.test(String(e?.message)) ? 2 : 1);
});
