// THE OUTCOME SCREEN AND THE REVISION LOOP, IN A REAL BROWSER — V1 P5.
//
//   node v1/tools/e2e/console-p5-e2e.mjs                  the run
//   node v1/tools/e2e/console-p5-e2e.mjs --broken-client  the demonstration that
//                                                          its probes can fail
//
// WHAT IS DRIVEN. Chromium, through Playwright, against a real `skillonomia
// serve` with its own temporary data directory and its own SQLite file. The
// capability is a lineage this run captures through `POST /v1/captures` and
// approves through the console surface; the runs it reads outcomes from are real
// sessions opened by a real evidence principal, with real `loaded` and `invoked`
// receipts and real outcome receipts filed on the machine surface. There is no
// fixture, no seed and no hand-written row anywhere in it (contract section 9).
//
// WHAT THE OWNER'S PATH IS, IN ORDER, AND THE REQUIREMENT EACH STEP IS OWED TO:
//
//   1  read an outcome WITH ITS PROVENANCE — the word the registry
//      filed, its reason code, its reason, its source, its evidence
//      class, the invocation receipt under it and its time      P5-FR-03, INV-03, INV-05
//   2  see a contradicting redelivery kept as its own evidence   P5-FR-07
//   3  create a NEW REVISION from the failure, with the
//      observation and the goal stated in advance               P5-FR-08
//   4  watch it go through the SAME review and approval          P5-FR-09
//   5  REASSIGN it, effective in the next session               P5-FR-10, INV-07
//   6  see the COMPARISON of old and new, with the registry's
//      verdict — and a second comparison the registry refuses
//      to call an improvement because the scenario differs      P5-FR-11, P5-FR-12
//   7  CONFIRM A ROLLBACK: choose the earlier approved revision,
//      read back what it means, confirm it — and then see the
//      rollback CONFIRMED by a later session that carried it,
//      with the failure before it untouched                     P5-FR-05, P5-FR-13
//   8  see a session that ended with nothing said reported as
//      `nothing_reported`, never as a success                   P5-FR-04, INV-03
//
// A PROBE NOBODY HAS SEEN FAIL PROVES NOTHING, which is why `--broken-client`
// exists — the pattern P2 established and P3 followed. It rebuilds the bundle
// from a copy of `console/app.ts` with THREE changes undone:
//
//   * the refetch-then-report after an owner command, so a refused
//     create-revision is reported as applied;
//   * the rendering of the registry's comparison verdict, replaced by the client
//     computing one from the candidate's outcome — which is precisely the
//     invented confirmed improvement `P5-FR-12` forbids;
//   * the honest rendering of the outcome word, replaced by a client that shows
//     `nothing_reported` as `worked` — the success `P5-FR-04` forbids.
//
// Every probe must FAIL against those bytes and every control must still pass,
// so that what changed between the two runs is the page and not the harness.
//
// EXIT CODES, the same four every gate harness in this tree uses:
//   0  passed          1  failed          2  REFUSED (could not reach the subject)
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const REPO = new URL("../../../", import.meta.url).pathname;
const BROKEN = process.argv.includes("--broken-client");
const PORT = Number(process.env.SKLN_P5_E2E_PORT ?? (BROKEN ? "7986" : "7987"));
const BASE = `http://127.0.0.1:${PORT}`;
const TRACE = process.env.SKLN_P5_E2E_TRACE ?? join(tmpdir(), "console-p5-e2e-trace.txt");

const results = [];
function control(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail, kind: "control" });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
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

// ---------------------------------------------------- the pre-fix client
//
// Three defects, each reconstructed from the code that prevents it rather than
// described in prose. A mutation whose target is not found is a REFUSAL: the
// demonstration must not quietly become a run of the same bundle twice.

const MUTATIONS = [
  {
    name: "the refetch-then-report after an owner command",
    from: "  await refreshCapability();\n  reportOutcome(action, failure);\n",
    to: [
      "  if (failure === null) await refreshCapability();",
      '  const box = document.getElementById("outcome-result");',
      "  if (box) {",
      "    box.textContent = `${action}: accepted by the registry`;",
      '    box.dataset.result = "applied";',
      '    box.dataset.code = "";',
      '    box.dataset.currentState = "";',
      "  }",
      "",
    ].join("\n"),
  },
  {
    name: "the rendering of the registry's comparison verdict",
    from:
      "  const verdictLine = el(\"p\", `verdict: ${c.verdict} — ${label(VERDICT_LABEL, c.verdict)}`);\n" +
      "  verdictLine.dataset.verdict = c.verdict;\n",
    to:
      '  const computed = c.candidate_outcome === "worked" ? "improved" : "not_improved";\n' +
      "  const verdictLine = el(\"p\", `verdict: ${computed} — ${label(VERDICT_LABEL, computed)}`);\n" +
      "  verdictLine.dataset.verdict = computed;\n",
  },
  {
    name: "the honest rendering of the outcome word",
    from: "  const shown = o.outcome;\n",
    to: '  const shown = o.outcome === "nothing_reported" ? "worked" : o.outcome;\n',
  },
];

function brokenClientSource() {
  const source = readFileSync(join(REPO, "console/app.ts"), "utf8");
  let mutated = source;
  for (const m of MUTATIONS) {
    if (!mutated.includes(m.from)) {
      refuse(`console/app.ts does not have the shape the mutation of ${m.name} edits; the demonstration cannot be built.`);
    }
    mutated = mutated.replace(m.from, m.to);
  }
  if (mutated === source) refuse("the mutations did nothing.");
  return mutated;
}

function buildBrokenBundle() {
  const dir = mkdtempSync(join(tmpdir(), "skln-broken-p5-console-"));
  const entry = join(dir, "app.ts");
  const out = join(dir, "app.js");
  writeFileSync(entry, brokenClientSource());
  const built = spawnSync("bun", ["build", "--target=browser", "--format=esm", entry, "--outfile", out], {
    encoding: "utf8",
  });
  if (built.status !== 0) refuse(`the mutated bundle did not build: ${built.stderr ?? built.error}`);
  return readFileSync(out, "utf8");
}

// ----------------------------------------------------------------- plumbing

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

async function asJson(res) {
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const WORKFLOW = [
  "# ship-the-change",
  "",
  "Use this whenever a reviewed change is ready to go out.",
  "",
  "## Purpose",
  "Ship a reviewed change without guessing.",
  "",
  "## Procedure",
  "1. Read the diff.",
  "2. Run the suite.",
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

/** A click on a P5 owner command, and the wait for its answer. The result line
 *  is cleared first, for the reason `console-p3-e2e.mjs` gives: without it the
 *  wait would return on the PREVIOUS command's verdict. */
async function clickOutcomeCommand(page, target) {
  await page.evaluate(() => {
    const box = document.getElementById("outcome-result");
    if (box) {
      box.dataset.result = "";
      box.dataset.code = "";
      box.dataset.currentState = "";
      box.textContent = "";
    }
  });
  if (typeof target === "string") await page.click(target);
  else await target.click();
  await pollAttribute(page, "#outcome-result", "data-result", (v) => v.length > 0);
}

/** Wait until a `<select>` really offers a value. Re-opening a capability
 *  RE-RENDERS a region that is already on the page, so waiting for the region
 *  itself returns instantly on the OLD render — and the option that the refetch
 *  is being waited for is not there yet. This waits for the thing itself. */
async function pollOption(page, selector, value, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const values = await page.$$eval(`${selector} option`, (nodes) => nodes.map((n) => n.value)).catch(() => []);
    if (values.includes(value)) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${selector} to offer ${value} (has: ${values.join(", ")})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
  writeFileSync(TRACE, `# owner console P5 browser E2E trace\n# base=${BASE}\n# broken_client=${BROKEN}\n`);
  const dataDir = mkdtempSync(join(tmpdir(), "skln-p5-e2e-"));
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
    await api("/v1/captures", { method: "POST", key: KEY, body: { kind: "workflow", text: WORKFLOW } })
  ).json();
  if (captured.outcome !== "drafted") refuse(`the capture did not produce a draft: ${JSON.stringify(captured.refusal)}`);
  const draftId = captured.draft.draft_id;
  const revision1 = captured.draft.revision_id;

  // ---- the fleet agent and the adapter's own principal --------------------
  //
  // `INV-02`: the thing that REPORTS what a run did is not the thing that
  // COMMANDS what should run. The adapter gets its own credential and the
  // DEPLOYMENT registers it as an evidence principal — a file in the data
  // directory that no owner-reachable surface writes.
  const idOf = (json) => json.principal?.agent_id ?? json.agent_id ?? json.principal_id ?? json.id;
  const fleetAgent = await asJson(
    await api("/v1/principals", { method: "POST", key: KEY, body: { name: `p5-agent-${PORT}`, type: "agent", role: "member" } }),
  );
  if (fleetAgent.status !== 201) refuse(`the fleet agent was not provisioned: ${fleetAgent.text.slice(0, 200)}`);
  const agentId = idOf(fleetAgent.json);
  const adapter = await asJson(
    await api("/v1/principals", { method: "POST", key: KEY, body: { name: `p5-adapter-${PORT}`, type: "service", role: "member" } }),
  );
  if (adapter.status !== 201) refuse(`the adapter principal was not provisioned: ${adapter.text.slice(0, 200)}`);
  const adapterId = idOf(adapter.json);
  const adapterKey = adapter.json.api_key ?? adapter.json.principal?.api_key;
  if (typeof adapterKey !== "string" || adapterKey.length < 20) refuse("the adapter holds no API key");
  const principalsFile = join(dataDir, "evidence-principals.json");
  const registrations = existsSync(principalsFile) ? JSON.parse(readFileSync(principalsFile, "utf8")) : {};
  registrations[adapterId] = "adapter";
  writeFileSync(principalsFile, JSON.stringify(registrations, null, 2), { mode: 0o600 });

  // ---- the browser -------------------------------------------------------
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();

  if (BROKEN) {
    const bundle = buildBrokenBundle();
    await page.route("**/console/app.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: bundle }),
    );
    console.log("client: the PRE-FIX bundle (no refetch on a refusal, a client-computed verdict, and nothing_reported shown as worked)");
  } else {
    console.log("client: dist-console/app.js, as this checkout builds it");
  }
  console.log(`port:   ${PORT}`);
  console.log(`trace:  ${TRACE}`);
  console.log();

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
  /** A second client of the same owner — what a second tab is. Used for the
   *  setup the owner's PATH does not run through the page. */
  const asOwner = (path, body, method = "POST") =>
    api(path, {
      method,
      body,
      headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrf },
    });
  const readAsOwner = (path) => api(path, { headers: { Cookie: `skln_console=${cookie.value}` } });

  const approved1 = await asOwner(`/v1/console/drafts/${draftId}/approve`, {
    revision_id: revision1,
    idempotency_key: "p5-approve-1",
  });
  if (approved1.status !== 201) refuse(`the first approval answered ${approved1.status}`);
  const assigned = await asJson(
    await asOwner("/v1/console/assignments", { agent_id: agentId, revision_id: revision1, idempotency_key: "p5-asg" }),
  );
  if (assigned.status !== 201) refuse(`the assignment answered ${assigned.status}: ${assigned.text.slice(0, 200)}`);
  const assignmentId = assigned.json.assignment.assignment_id;
  const activated = await asOwner(`/v1/console/assignments/${assignmentId}/activate`, { idempotency_key: "p5-act" });
  if (activated.status !== 200) refuse(`the activation answered ${activated.status}`);

  // ---- the runs, on the machine surface ----------------------------------
  const openSession = async (kind, key) => {
    const res = await asJson(
      await api("/v1/sessions", {
        method: "POST",
        key: adapterKey,
        body: { agent_id: agentId, runtime_kind: kind, runtime_version: "p5-e2e", idempotency_key: key },
      }),
    );
    if (res.status !== 201) refuse(`opening a ${kind} session answered ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  };
  const receipt = async (sessionId, stage, entry, refs, key) => {
    const res = await asJson(
      await api(`/v1/sessions/${sessionId}/receipts`, {
        method: "POST",
        key: adapterKey,
        body: {
          stage,
          runtime_session_ref: refs.runtime,
          revision_id: entry.draft_revision_id,
          content_digest: entry.content_digest,
          ...(stage === "invoked" ? { invocation_ref: refs.invocation } : {}),
          idempotency_key: key,
        },
      }),
    );
    if (res.status !== 201) refuse(`the ${stage} receipt answered ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  };
  const fileOutcome = async (sessionId, entry, refs, body) =>
    asJson(
      await api(`/v1/sessions/${sessionId}/outcomes`, {
        method: "POST",
        key: adapterKey,
        body: {
          revision_id: entry.draft_revision_id,
          content_digest: entry.content_digest,
          runtime_session_ref: refs.runtime,
          invocation_ref: refs.invocation,
          ...body,
        },
      }),
    );

  const refs1 = { runtime: "rt-p5-1", invocation: "call-p5-1" };
  const session1 = await openSession("codex", "p5-s1");
  const entry1 = session1.entries[0];
  if (!entry1 || entry1.draft_revision_id !== revision1) refuse("the first session did not carry the approved revision");
  await receipt(session1.session_id, "loaded", entry1, refs1, "p5-ld-1");
  const invoked1 = await receipt(session1.session_id, "invoked", entry1, refs1, "p5-iv-1");
  const failedFiling = await fileOutcome(session1.session_id, entry1, refs1, {
    outcome: "failed",
    outcome_ref: "outcome-p5-1",
    reason_code: "SUITE_RED",
    reason: "the suite was red and the change did not ship",
    transcript_excerpt: "step 2 failed: 3 tests red",
  });
  if (failedFiling.status !== 201) refuse(`the failed outcome answered ${failedFiling.status}: ${failedFiling.text.slice(0, 300)}`);
  const failedOutcomeId = failedFiling.json.outcome_id;
  // A CONTRADICTING REDELIVERY, on the same `outcome_ref`: refused with a 409,
  // and kept as its own evidence (`P5-FR-07`).
  const contradiction = await fileOutcome(session1.session_id, entry1, refs1, {
    outcome: "worked",
    outcome_ref: "outcome-p5-1",
    reason_code: "ACTUALLY_FINE",
    reason: "a second delivery says the opposite",
  });
  if (contradiction.status !== 409) refuse(`the contradicting redelivery answered ${contradiction.status}, not 409`);

  // ---- 1. the outcome, with its provenance -------------------------------
  await page.reload();
  await page.waitForSelector("#capabilities[data-loaded=true]");
  await page.click(`button[data-capability-id="${draftId}"]`);
  await page.waitForSelector(`#outcomes[data-capability-id="${draftId}"]`);

  const outcomeCount = Number(await page.getAttribute("#outcome-rows", "data-count"));
  control("P5 the outcome region renders the registry's outcomes for this lineage", outcomeCount === 1, `${outcomeCount} rows`);
  const sel = `.outcome[data-outcome-id="${failedOutcomeId}"]`;
  const outcomeWord = await page.getAttribute(sel, "data-outcome");
  const evidenceClass = await page.getAttribute(sel, "data-evidence-class");
  const source = await page.getAttribute(sel, "data-source");
  const reasonCode = await page.getAttribute(sel, "data-reason-code");
  const receiptId = await page.getAttribute(sel, "data-invocation-receipt-id");
  const outcomeText = (await page.textContent(sel)) ?? "";
  control("P5-FR-03 the outcome is the word the registry filed", outcomeWord === "failed", String(outcomeWord));
  control(
    "P5-FR-03 with its machine-readable reason code and its reason on the screen",
    reasonCode === "SUITE_RED" && outcomeText.includes("SUITE_RED") && outcomeText.includes("the suite was red"),
    String(reasonCode),
  );
  control(
    "INV-03 with its source and its evidence class",
    source === "adapter" && evidenceClass === "runtime_receipt" && outcomeText.includes("adapter"),
    `source=${source} evidence=${evidenceClass}`,
  );
  control(
    "P5-FR-02 and the invocation receipt it rests on, which is the receipt this run filed",
    receiptId === invoked1.receipt_id && outcomeText.includes(String(invoked1.receipt_id)),
    `${receiptId} vs ${invoked1.receipt_id}`,
  );
  control(
    "INV-03 the outcome carries a concrete observed time on the screen",
    /observed at: \d{4}-\d{2}-\d{2}T/.test(outcomeText),
    JSON.stringify(outcomeText.slice(-80)),
  );
  const conflictCount = await page.$$eval(`${sel} .conflict`, (n) => n.length).catch(() => 0);
  const conflictText = conflictCount > 0 ? ((await page.textContent(`${sel} .conflict`)) ?? "") : "";
  control(
    "P5-FR-07 the contradicting redelivery is on the screen as its own evidence, and the filed outcome stands",
    conflictCount === 1 && /claimed worked/.test(conflictText) && /failed stands/.test(conflictText),
    JSON.stringify(conflictText.slice(0, 140)),
  );

  // ---- 3. the new revision, from the failure -----------------------------
  await page.fill(`#observation-${failedOutcomeId}`, "the suite was red because step 2 ran the wrong target");
  await page.fill(`#goal-${failedOutcomeId}`, "the same scenario reaches worked");
  await page.selectOption(`#origin-${failedOutcomeId}`, "failure");
  await page.fill(`#procedure-${failedOutcomeId}`, "Read the diff.\nRun the suite for the changed package.\nMerge it and record the digest.");
  await clickOutcomeCommand(page, `button.create-revision[data-outcome-id="${failedOutcomeId}"]`);
  const createResult = await page.getAttribute("#outcome-result", "data-result");
  control("P5-FR-08 the create-revision command was accepted by the registry", createResult === "applied", String(createResult));
  const lineageCount = Number(await page.getAttribute("#lineage", "data-count"));
  const lineageParent = await page.getAttribute(".lineage", "data-parent-revision-id");
  const lineageSource = await page.getAttribute(".lineage", "data-source-outcome-id");
  const lineageText = (await page.textContent(".lineage")) ?? "";
  const revision2 = await page.getAttribute(".lineage", "data-revision-id");
  control("P5-FR-08 the page shows the new revision's lineage", lineageCount === 1, `${lineageCount} rows`);
  control("P5-FR-08 naming the parent revision and the outcome it came from", lineageParent === revision1 && lineageSource === failedOutcomeId);
  control(
    "P5-FR-12 and the goal stated IN ADVANCE, before the new revision ran anywhere",
    lineageText.includes("the same scenario reaches worked") && lineageText.includes("failure_to_worked"),
    JSON.stringify(lineageText.slice(0, 120)),
  );
  if (typeof revision2 !== "string" || revision2.length !== 26) refuse("the new revision has no id on the page");

  // ---- 4. the same review and the same approval --------------------------
  await page.click(`#inbox-rows tr[data-draft-id="${draftId}"] button[data-draft-id]`);
  await page.waitForSelector(`#detail[data-draft-id="${draftId}"]`);
  const detailRevision = await page.getAttribute("#detail", "data-revision-id");
  const approvedBefore = await page.getAttribute("#revision-approval", "data-approved");
  const detailText = (await page.textContent("#detail")) ?? "";
  control("P5-FR-09 the new revision is the head the owner reviews", detailRevision === revision2, String(detailRevision));
  control("P5-FR-09 and it is NOT approved by having been created", approvedBefore === "false", String(approvedBefore));
  control(
    "P5-FR-09 the same semantic and security previews ran on it",
    /Semantic findings \(\d+ blocking\)/.test(detailText) && /Security findings \(\d+ blocking\)/.test(detailText),
  );
  await page.click("#approve");
  await pollAttribute(page, "#revision-approval", "data-approved", (v) => v === "true");
  control("P5-FR-09 the owner approved the exact new revision from the page", true);

  // ---- 5. reassign, effective in the next session ------------------------
  await page.click(`button[data-capability-id="${draftId}"]`);
  await pollOption(page, `#revision-${assignmentId}`, revision2);
  await page.selectOption(`#revision-${assignmentId}`, revision2);
  await page.evaluate(() => {
    const box = document.getElementById("lifecycle-result");
    if (box) box.dataset.result = "";
  });
  await page.click(`.assignment button[data-action="select_revision"]`);
  await pollAttribute(page, ".assignment .desired", "data-desired-revision-id", (v) => v === revision2);
  const afterReassign = await (await readAsOwner(`/v1/console/assignments/${assignmentId}`)).json();
  control(
    "P5-FR-10 the reassignment named the new APPROVED revision in the registry",
    afterReassign.assignment.desired.revision_id === revision2,
    String(afterReassign.assignment.desired.revision_id),
  );
  const outcomeEffective = (await page.textContent("#outcome-effective-from")) ?? "";
  control(
    "INV-07 the outcome region states that a change made here takes effect in the NEXT session",
    /NEXT session/.test(outcomeEffective),
    JSON.stringify(outcomeEffective),
  );

  // ---- the new revision's runs ------------------------------------------
  const refs2 = { runtime: "rt-p5-2", invocation: "call-p5-2" };
  const session2 = await openSession("codex", "p5-s2");
  const entry2 = session2.entries[0];
  if (entry2.draft_revision_id !== revision2) refuse("the new session did not carry the reassigned revision");
  await receipt(session2.session_id, "loaded", entry2, refs2, "p5-ld-2");
  await receipt(session2.session_id, "invoked", entry2, refs2, "p5-iv-2");
  const worked = await fileOutcome(session2.session_id, entry2, refs2, {
    outcome: "worked",
    outcome_ref: "outcome-p5-2",
    reason_code: "SHIPPED",
    reason: "the suite was green and the change shipped",
  });
  if (worked.status !== 201) refuse(`the worked outcome answered ${worked.status}: ${worked.text.slice(0, 300)}`);
  const workedOutcomeId = worked.json.outcome_id;

  // A run of the SAME revision in the OTHER runtime — a different scenario, which
  // is why the registry refuses to call it an improvement (`P5-FR-12`).
  const refs3 = { runtime: "rt-p5-3", invocation: "call-p5-3" };
  const session3 = await openSession("claude_code", "p5-s3");
  const entry3 = session3.entries[0];
  await receipt(session3.session_id, "loaded", entry3, refs3, "p5-ld-3");
  await receipt(session3.session_id, "invoked", entry3, refs3, "p5-iv-3");
  const workedElsewhere = await fileOutcome(session3.session_id, entry3, refs3, {
    outcome: "worked",
    outcome_ref: "outcome-p5-3",
    reason_code: "SHIPPED",
    reason: "it worked in the other runtime, which is not the same scenario",
  });
  if (workedElsewhere.status !== 201) refuse(`the second worked outcome answered ${workedElsewhere.status}`);
  const otherRuntimeOutcomeId = workedElsewhere.json.outcome_id;

  // ---- 6. the comparison -------------------------------------------------
  await page.click("#refresh-outcomes");
  await pollAttribute(page, "#outcome-rows", "data-count", (v) => Number(v) === 3);
  await page.selectOption("#baseline-outcome", failedOutcomeId);
  await page.selectOption("#candidate-outcome", workedOutcomeId);
  await clickOutcomeCommand(page, "#compare");
  const comparisonCount = Number(await page.getAttribute("#comparisons", "data-count"));
  // WHAT THE OWNER SEES, which is the rendered line — not the row's attribute.
  // The pre-fix client below writes the registry's verdict on the row and a
  // computed one in the sentence, and a probe that read the row would have
  // reported a page that was telling the owner something else.
  const verdict = await page.getAttribute(".comparison p[data-verdict]", "data-verdict");
  const comparable = await page.getAttribute(".comparison", "data-comparable");
  const comparisonText = (await page.textContent(".comparison")) ?? "";
  const serverHistory = await (await readAsOwner(`/v1/console/capabilities/${draftId}/outcomes`)).json();
  control("P5-FR-11 the comparison is on the screen", comparisonCount === 1, `${comparisonCount}`);
  control(
    "P5-FR-11 naming the exact old and new revisions and both outcomes",
    comparisonText.includes(revision1) && comparisonText.includes(revision2) && comparisonText.includes("outcome failed") && comparisonText.includes("outcome worked"),
    JSON.stringify(comparisonText.slice(0, 160)),
  );
  control(
    "P5-FR-12 the registry called it an improvement and the page shows the registry's word",
    verdict === "improved" && comparable === "true" && serverHistory.comparisons[0].verdict === "improved",
    `page=${verdict} registry=${serverHistory.comparisons[0]?.verdict}`,
  );

  // The SECOND comparison: the same baseline, a candidate that worked in the
  // OTHER runtime. The registry refuses to call it comparable; a client that
  // computed the verdict from `candidate_outcome` would print `improved`.
  await page.selectOption("#baseline-outcome", failedOutcomeId);
  await page.selectOption("#candidate-outcome", otherRuntimeOutcomeId);
  await clickOutcomeCommand(page, "#compare");
  const verdicts = await page.$$eval(".comparison p[data-verdict]", (nodes) => nodes.map((n) => n.dataset.verdict));
  const registryVerdicts = (await (await readAsOwner(`/v1/console/capabilities/${draftId}/outcomes`)).json()).comparisons.map(
    (c) => c.verdict,
  );
  control(
    "P5-FR-12 the registry's two verdicts are `improved` then `not_comparable`",
    registryVerdicts.length === 2 && registryVerdicts[0] === "improved" && registryVerdicts[1] === "not_comparable",
    registryVerdicts.join(", "),
  );
  probe(
    "P5-FR-12 the page shows the REGISTRY's verdict for a run in another runtime, not one it computed from the outcome",
    verdicts.length === 2 && verdicts[1] === "not_comparable",
    `page=${verdicts.join(", ")} registry=${registryVerdicts.join(", ")}`,
  );
  const secondText = (await page.textContent(".comparison:nth-of-type(2)")) ?? "";
  probe(
    "P5-FR-12 and says why the registry refused to call it one",
    /RUNTIME|runtime/.test(secondText) && !/confirmed improvement/.test(secondText),
    JSON.stringify(secondText.slice(0, 160)),
  );

  // ---- the refusal a P5 command really gets ------------------------------
  //
  // `origin: failure` on an outcome that WORKED is a 412 from this server. The
  // page must show the refusal, refetch canonical state, and show no success.
  await page.fill(`#observation-${workedOutcomeId}`, "a revision from a run that did not fail");
  await page.fill(`#goal-${workedOutcomeId}`, "there is no goal to state: it worked");
  await page.selectOption(`#origin-${workedOutcomeId}`, "failure");
  const beforeRefusal = exchanges.length;
  await clickOutcomeCommand(page, `button.create-revision[data-outcome-id="${workedOutcomeId}"]`);
  const afterRefusal = exchanges.slice(beforeRefusal);
  const the412 = afterRefusal.find((e) => e.method === "POST" && /\/revision$/.test(e.path));
  const refetched = afterRefusal.some(
    (e) => e.method === "GET" && e.path === `/v1/console/capabilities/${draftId}/outcomes` && e.status === 200,
  );
  const refusalResult = await page.getAttribute("#outcome-result", "data-result");
  const refusalCode = await page.getAttribute("#outcome-result", "data-code");
  const refusalState = await page.getAttribute("#outcome-result", "data-current-state");
  const lineageAfterRefusal = Number(await page.getAttribute("#lineage", "data-count"));
  control(
    "P5-FR-08 the browser really received a 412 from this server for a revision from a run that did not fail",
    the412?.status === 412,
    `status ${the412?.status}`,
  );
  probe(
    "the page shows the refusal rather than a success",
    refusalResult === "refused" && refusalCode === "PRECONDITION_FAILED",
    `result=${refusalResult} code=${refusalCode}`,
  );
  probe("the page shows the state the registry named", refusalState === "worked", String(refusalState));
  probe("the page refetched canonical state after the refusal", refetched, `${afterRefusal.length} exchanges followed the click`);
  // A CONTROL, not a probe, and the difference is worth stating: the registry
  // made no revision either way, so this holds against the pre-fix client too.
  // What the pre-fix client gets wrong is what it TELLS the owner, which is what
  // the three probes above measure.
  control("P5-FR-08 no lineage row appeared for a revision that was never made", lineageAfterRefusal === 1, `${lineageAfterRefusal}`);

  // ---- 7. the rollback, confirmed ---------------------------------------
  await page.selectOption(`#rollback-target-${assignmentId}`, revision1);
  await page.click(`button.prepare-rollback[data-assignment-id="${assignmentId}"]`);
  const planTarget = await page.getAttribute(`.rollback-plan[data-assignment-id="${assignmentId}"]`, "data-target-revision-id");
  const planText = (await page.textContent(`.rollback-plan[data-assignment-id="${assignmentId}"]`)) ?? "";
  control("P5-FR-13 the page reads back the rollback before it is confirmed", planTarget === revision1, String(planTarget));
  control(
    "INV-07 and says it takes effect in the NEXT session and is confirmed by a session, not by the click",
    /NEXT session/.test(planText) && /CONFIRMED only when a session/.test(planText),
    JSON.stringify(planText.slice(0, 200)),
  );
  await clickOutcomeCommand(page, `button.confirm-rollback[data-assignment-id="${assignmentId}"]`);
  const rollbackResult = await page.getAttribute("#outcome-result", "data-result");
  control("P5-FR-13 the confirmed rollback was accepted by the registry", rollbackResult === "applied", String(rollbackResult));
  const afterRollback = await (await readAsOwner(`/v1/console/assignments/${assignmentId}`)).json();
  control(
    "P5-FR-13 the registry selected the EARLIER approved revision",
    afterRollback.assignment.desired.revision_id === revision1,
    String(afterRollback.assignment.desired.revision_id),
  );
  control(
    "INV-06 and the newer approved revision is still there",
    afterRollback.assignment.approved_revisions.length === 2,
    `${afterRollback.assignment.approved_revisions.length} approved revisions`,
  );

  // The rollback ACTION event, which is what a later session confirms against.
  const audit = await (await readAsOwner(`/v1/console/assignments/${assignmentId}/audit`)).json();
  const rollbackEvent = [...audit.items]
    .reverse()
    .find((i) => i.event === "revision_selected" && i.desired_revision_id === revision1);
  if (!rollbackEvent) refuse("the rollback left no `revision_selected` event to confirm against");

  const session4 = await openSession("codex", "p5-s4");
  const entry4 = session4.entries[0];
  if (entry4.draft_revision_id !== revision1) refuse("the session after the rollback did not carry the rollback target");
  await receipt(session4.session_id, "loaded", entry4, { runtime: "rt-p5-4", invocation: "call-p5-4" }, "p5-ld-4");
  const confirmed = await asJson(
    await api(`/v1/sessions/${session4.session_id}/rollback-confirmations`, {
      method: "POST",
      key: adapterKey,
      body: { entry_id: entry4.entry_id, rollback_action_event_id: rollbackEvent.entry_id, idempotency_key: "p5-rb" },
    }),
  );
  if (confirmed.status !== 201) refuse(`the rollback confirmation answered ${confirmed.status}: ${confirmed.text.slice(0, 300)}`);

  // ---- 8. a session that ended with nothing said ------------------------
  const session5 = await openSession("codex", "p5-s5");
  const entry5 = session5.entries[0];
  await receipt(session5.session_id, "loaded", entry5, { runtime: "rt-p5-5", invocation: "call-p5-5" }, "p5-ld-5");
  await receipt(session5.session_id, "invoked", entry5, { runtime: "rt-p5-5", invocation: "call-p5-5" }, "p5-iv-5");
  const closed = await asJson(
    await api(`/v1/sessions/${session5.session_id}/close`, {
      method: "POST",
      key: adapterKey,
      body: { reason: "the runtime session ended with nothing reported", idempotency_key: "p5-close" },
    }),
  );
  if (closed.status !== 201) refuse(`the close answered ${closed.status}: ${closed.text.slice(0, 300)}`);

  await page.click("#refresh-outcomes");
  await pollAttribute(page, "#outcome-rows", "data-count", (v) => Number(v) === 5);
  const rollbackShown = await page.$$eval(".rollback-confirmation", (nodes) =>
    nodes.map((n) => ({ target: n.dataset.rollbackToRevisionId, event: n.dataset.rollbackActionEventId, text: n.textContent })),
  );
  control(
    "P5-FR-13 the rollback CONFIRMATION is on the screen, naming the target revision and the lifecycle event",
    rollbackShown.length === 1 && rollbackShown[0].target === revision1 && rollbackShown[0].event === rollbackEvent.entry_id,
    JSON.stringify(rollbackShown[0] ?? null).slice(0, 200),
  );
  const failedStill = await page.getAttribute(`.outcome[data-outcome-id="${failedOutcomeId}"]`, "data-outcome");
  control(
    "P5-FR-05 the failure that came before the rollback is still shown, unchanged",
    failedStill === "failed",
    String(failedStill),
  );
  const registryOutcomes = (await (await readAsOwner(`/v1/console/capabilities/${draftId}/outcomes`)).json()).outcomes;
  const shownOutcomes = await page.$$eval(".outcome", (nodes) => nodes.map((n) => n.dataset.outcome));
  control(
    "P5-FR-01 the registry filed five outcomes in this loop: failed, worked, worked, rolled_back, nothing_reported",
    registryOutcomes.map((o) => o.outcome).join(",") === "failed,worked,worked,rolled_back,nothing_reported",
    registryOutcomes.map((o) => o.outcome).join(","),
  );
  probe(
    "P5-FR-04 / INV-03 the page shows every outcome as the word the registry filed — a closed session with nothing said reads `nothing_reported`, never as a success",
    shownOutcomes.join(",") === registryOutcomes.map((o) => o.outcome).join(","),
    `page=${shownOutcomes.join(",")} registry=${registryOutcomes.map((o) => o.outcome).join(",")}`,
  );
  const nothingText =
    (await page.textContent(`.outcome[data-outcome-id="${registryOutcomes[4].outcome_id}"]`).catch(() => "")) ?? "";
  probe(
    "P5-FR-04 and says in words that it is not a success",
    /not a success/.test(nothingText) && /session_closed|NO_OUTCOME|SESSION_CLOSED/.test(nothingText),
    JSON.stringify(nothingText.slice(0, 200)),
  );

  await browser.close();
  stop();

  // ---- the verdict --------------------------------------------------------
  console.log();
  const failedControls = results.filter((r) => !r.ok);
  if (BROKEN) {
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
        ? "FAIL  the pre-fix client did not behave as the defects say it does, or a control broke."
        : "FAIL  the P5 outcome screen does not hold on this surface.",
    );
    console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
    process.exit(1);
  }
  if (!BROKEN && failedControls.length === 0 && results.length < 30) {
    console.error(`REFUSED: only ${results.length} checks ran; this gate covers more than that`);
    process.exit(2);
  }
  console.log();
  console.log(
    BROKEN
      ? "PASS  every probe failed against the pre-fix client, and the controls did not."
      : "PASS  the P5 screen reads an outcome with its provenance, makes a revision from a failure, sees it approved and reassigned, shows the registry's comparison verdict, and confirms a rollback a later session confirmed.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(/^REFUSED/.test(String(e?.message)) ? 2 : 1);
});
