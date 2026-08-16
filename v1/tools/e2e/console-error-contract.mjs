// THE VERSIONED-CONTRACT BOUNDARY, ON THE ANSWERS THAT FAIL — `P2-R2-001`.
//
//   node v1/tools/e2e/console-error-contract.mjs                  the probes
//   node v1/tools/e2e/console-error-contract.mjs --broken-client  the demonstration
//                                                                 that they can fail
//
// WHAT THE FINDING WAS. `console/app.ts` refuses a response that does not
// announce `console.v1` before it reads a field of it (`INV-05`). That held for
// the answers a console route SUCCEEDS with. On a `400`, a `409` or a `412` the
// browser read `error.code`, `error.message` and `error.current_state` FIRST and
// checked the version afterwards — and `src/http.ts` did not put a version on a
// refusal at all. P2 REVIEW-2 rewrote one rejection error to announce
// `console.v999` with a planted message and the console rendered the planted
// message.
//
// WHAT IS DRIVEN HERE. Chromium, through Playwright, against a real
// `skillonomia serve` with its own temporary database, on drafts this run creates
// through `POST /v1/captures`. Three REAL refusals of this server, each produced
// by a real console request:
//
//   400  INVALID_SCHEMA      a rejection submitted with no reason
//   409  CONFLICT            a second decision on a draft already decided
//   412  PRECONDITION_FAILED an approval of a draft with a blocking finding
//
// Each of the three is put to the page three ways:
//
//   control   the server's own answer, untouched — it must carry `console.v1`,
//             and the page must render the refusal, because a boundary that
//             refuses everything is not a boundary either
//   missing   the `contract` field deleted
//   foreign   the `contract` field set to `console.v999`
//
// The two mutated forms also carry a planted `code`, `message` and
// `current_state`. The assertion is the finding, inverted: nothing planted
// reaches the screen — not in the error box, not anywhere on the page — and what
// the owner is shown is `CONTRACT_MISMATCH`.
//
// A PROBE NOBODY HAS SEEN FAIL PROVES NOTHING, which is why `--broken-client`
// exists. It rebuilds the bundle from a copy of `console/app.ts` with the fix
// UNDONE — the version check moved back below the failure branch, which is
// exactly where REVIEW-2 found it — serves those bytes to the page, and requires
// that all six mutated probes FAIL and the three controls still pass. If the
// pre-fix client renders the plant, the probes measure the boundary; if it does
// not, they measure nothing and this mode exits non-zero.
//
// EXIT CODES, the same four every gate harness in this tree uses:
//   0  passed          1  failed          2  REFUSED (could not reach the subject)
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright is a harness dependency, resolved through `require` so that
// `NODE_PATH` is consulted — see the note at the head of `console-e2e.mjs`.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const REPO = new URL("../../../", import.meta.url).pathname;
const BROKEN = process.argv.includes("--broken-client");
const PORT = Number(process.env.SKLN_ERROR_CONTRACT_PORT ?? (BROKEN ? "7991" : "7992"));
const BASE = `http://127.0.0.1:${PORT}`;

/** The plant. Every one of these strings is a field of a payload whose version
 *  the console does not know, so none of them may reach the screen. */
const PLANT = {
  code: "FOREIGN_ERROR_CODE_WAS_CONSUMED",
  message: "FOREIGN_ERROR_PAYLOAD_WAS_CONSUMED",
  current_state: "FOREIGN_CURRENT_STATE_WAS_CONSUMED",
};
const FOREIGN_CONTRACT = "console.v999";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function refuse(why) {
  console.error(`REFUSED: ${why}`);
  process.exit(2);
}

/** The pre-fix client, reconstructed rather than described: the one
 *  `requireContract` call moved from the top of `api()` back to the bottom. */
function brokenClientSource() {
  const source = readFileSync(join(REPO, "console/app.ts"), "utf8");
  const CALL = "  requireContract(parsed, path);\n";
  const RETURN = "  return parsed as T;\n";
  if (!source.includes(CALL) || !source.includes(RETURN)) {
    refuse("console/app.ts does not have the shape this mutation edits; the demonstration cannot be built.");
  }
  const without = source.replace(CALL, "");
  if (without === source) refuse("the version check was not removed; the mutation did nothing.");
  const moved = without.replace(RETURN, `${CALL}${RETURN}`);
  if (moved === without) refuse("the version check was not reinserted; the mutation did nothing.");
  return moved;
}

function buildBrokenBundle() {
  const dir = mkdtempSync(join(tmpdir(), "skln-broken-console-"));
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

/** The incomplete capture is the one `console-e2e.mjs` uses for the same purpose:
 *  a procedure with no purpose, inputs, outputs, permissions, dependencies or
 *  failure modes, which P1's compiler files as blocking and which the decision
 *  rule therefore refuses to approve. */
const THIN = "## Procedure\n1. Do the first thing.\n2. Then the second thing.\n\nWhenever something is missing.";

const WORKFLOW = (name, complete) =>
  complete
  ? [
    `# ${name}`,
    "",
    "Use this whenever an error contract is under review.",
    "",
    "## Purpose",
    "Produce a structured refusal from the console surface.",
    "",
    "## Procedure",
    "1. Ask for something the server refuses.",
    "2. Read the refusal.",
    "3. Check what the page did with it.",
    "",
    "## Inputs",
    "- the refusal",
    "",
    "## Outputs",
    "- what the page showed",
    "",
    "## Permissions",
    "- read the console",
    "",
    "## Dependencies",
    "- a browser",
    "",
    "## Failure modes",
    "- the page renders a payload it cannot read",
  ].join("\n")
  : THIN;

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "skln-error-contract-"));
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
  if (health === null) refuse(`nothing answered /health on ${BASE}`);
  if (health.version !== expected) refuse(`${BASE} answers version ${health.version}, not this checkout's ${expected}`);

  const token = /BOOTSTRAP_OWNER_TOKEN[=: ]+(\S+)/.exec(banner);
  if (!token) refuse("the server printed no bootstrap token");
  const owner = await (await api("/v1/auth/bootstrap", { method: "POST", body: { bootstrap_token: token[1] } })).json();
  const KEY = owner.api_key;
  if (typeof KEY !== "string" || KEY.length < 20) refuse("no owner API key");

  // Three drafts: one that stays pending (the page acts on it), one that will be
  // decided (its second decision is the 409), one incomplete (its approval is
  // the 412).
  const make = async (name, complete) =>
    (await (await api("/v1/captures", { method: "POST", key: KEY, body: { kind: "workflow", title: name, text: WORKFLOW(name, complete) } })).json())
      .draft;
  const pending = await make("error-contract-pending", true);
  const decided = await make("error-contract-decided", true);
  const thin = await make("error-contract-thin", false);
  for (const [name, d] of [["pending", pending], ["decided", decided], ["thin", thin]]) {
    if (!d?.draft_id) refuse(`the ${name} draft was not created`);
  }

  const ticket = await (await api("/v1/console/tickets", { method: "POST", key: KEY, body: {} })).json();

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ baseURL: BASE });

  if (BROKEN) {
    const bundle = buildBrokenBundle();
    await page.route("**/console/app.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: bundle }),
    );
    console.log("client: the PRE-FIX bundle (the version check moved back below the failure branch)");
  } else {
    console.log("client: dist-console/app.js, as this checkout builds it");
  }
  console.log(`port:   ${PORT}`);
  console.log();

  await page.goto("/console/login");
  await page.fill("#ticket", ticket.ticket);
  await page.click("#login button");
  await page.waitForURL("**/console");
  await page.waitForSelector("#inbox[data-loaded=true]");

  const csrf = await page.evaluate(async () => (await (await fetch("/v1/console/session")).json()).csrf_token);
  const cookies = await page.context().cookies();
  const cookie = cookies.find((c) => c.name === "skln_console");
  if (!cookie) refuse("no session cookie");
  const asConsole = (path, body) =>
    api(path, {
      method: "POST",
      body,
      headers: { Origin: BASE, Cookie: `skln_console=${cookie.value}`, "X-Skillonomia-Console-CSRF": csrf },
    });

  // The 409's precondition: a draft that has already been decided.
  const detail = await (await api(`/v1/drafts/${decided.draft_id}`, { key: KEY })).json();
  const approved = await asConsole(`/v1/console/drafts/${decided.draft_id}/approve`, {
    revision_id: detail.revision.revision_id,
    idempotency_key: "error-contract-approve",
  });
  if (approved.status !== 201) refuse(`the 409 precondition failed: approve answered ${approved.status}`);

  // The 412's precondition, asserted the same way: the incomplete draft really
  // is refused, and the refusal really is `PRECONDITION_FAILED`. A probe that
  // drove a 201 believing it was driving a 412 would report on nothing, which is
  // what an earlier run of this file did.
  const blocked = await asConsole(`/v1/console/drafts/${thin.draft_id}/approve`, { revision_id: thin.revision_id });
  if (blocked.status !== 412) refuse(`the 412 precondition failed: approving the incomplete draft answered ${blocked.status}`);

  // THE THREE REFUSALS. Each is a real request this server really refuses; the
  // page's own reject click is the carrier, and the route handler swaps in the
  // request whose refusal is wanted. `route.fetch` performs it from the browser,
  // so the cookie, the Origin and the CSRF header are the page's own.
  const REFUSALS = [
    {
      status: 400,
      code: "INVALID_SCHEMA",
      what: "a rejection with no reason",
      fetchOptions: () => ({}), // the reject the page itself submitted, blank
    },
    {
      status: 409,
      code: "CONFLICT",
      what: "a second decision on a decided draft",
      fetchOptions: () => ({
        url: `${BASE}/v1/console/drafts/${decided.draft_id}/approve`,
        postData: JSON.stringify({ revision_id: detail.revision.revision_id }),
      }),
    },
    {
      status: 412,
      code: "PRECONDITION_FAILED",
      what: "an approval of a draft with a blocking finding",
      fetchOptions: () => ({
        url: `${BASE}/v1/console/drafts/${thin.draft_id}/approve`,
        postData: JSON.stringify({ revision_id: thin.revision_id }),
      }),
    },
  ];

  /** One run: open the pending draft, arm the interception, click Reject with an
   *  empty reason, and report what the page ended up showing. */
  async function run(refusal, mutate) {
    await page.click(`button[data-draft-id="${pending.draft_id}"]`);
    await page.waitForSelector(`#detail[data-draft-id="${pending.draft_id}"]`);
    let upstream = null;
    const handler = async (route) => {
      const response = await route.fetch(refusal.fetchOptions());
      const body = await response.json();
      upstream = { status: response.status(), body };
      const served = mutate ? mutate(structuredClone(body)) : body;
      await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(served) });
    };
    await page.route("**/v1/console/drafts/*/reject", handler);
    await page.fill("#reason", "");
    await page.click("#reject");
    // the click's tail is: request → refetch of the draft and the inbox → the
    // error box written last. Waiting for a non-empty box waits for all of it.
    for (let i = 0; i < 150; i += 1) {
      const text = (await page.textContent("#error")) ?? "";
      if (text.trim().length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.unroute("**/v1/console/drafts/*/reject", handler);
    const visible = (await page.textContent("#error")) ?? "";
    const wholePage = await page.evaluate(() => document.body.innerText);
    return { upstream, visible, wholePage };
  }

  const mutatedOutcomes = [];
  for (const refusal of REFUSALS) {
    // -- control: the server's own answer, untouched -----------------------
    const control = await run(refusal, null);
    record(
      `${refusal.status} the refusal driven is this server's own ${refusal.code}`,
      control.upstream?.status === refusal.status && control.upstream?.body?.error?.code === refusal.code,
      `${control.upstream?.status} ${control.upstream?.body?.error?.code} — ${refusal.what}`,
    );
    record(
      `${refusal.status} the console surface announces its contract ON THE REFUSAL`,
      control.upstream?.body?.contract === "console.v1",
      `contract=${JSON.stringify(control.upstream?.body?.contract ?? null)}`,
    );
    record(
      `${refusal.status} a properly versioned refusal is still shown to the owner`,
      control.visible.includes(refusal.code),
      JSON.stringify(control.visible),
    );

    // -- missing and foreign ------------------------------------------------
    const mutations = [
      [
        "no version at all",
        (body) => {
          delete body.contract;
          body.error = { ...body.error, ...PLANT };
          return body;
        },
      ],
      [
        `a foreign version (${FOREIGN_CONTRACT})`,
        (body) => ({ ...body, contract: FOREIGN_CONTRACT, error: { ...body.error, ...PLANT } }),
      ],
    ];
    for (const [label, mutate] of mutations) {
      const out = await run(refusal, mutate);
      const planted = Object.values(PLANT).filter((v) => out.wholePage.includes(v));
      const consumed = planted.length > 0;
      const refused = out.visible.includes("CONTRACT_MISMATCH");
      mutatedOutcomes.push({ status: refusal.status, label, consumed, refused, visible: out.visible });
      if (!BROKEN) {
        record(
          `${refusal.status} with ${label}: nothing of the payload reaches the page`,
          !consumed,
          consumed ? `rendered: ${planted.join(", ")}` : JSON.stringify(out.visible),
        );
        record(`${refusal.status} with ${label}: the owner is shown CONTRACT_MISMATCH`, refused, JSON.stringify(out.visible));
      }
    }
  }

  // THE DEMONSTRATION. On the pre-fix client every mutated case must be
  // consumed — that is the finding — and the controls must still pass, so that
  // what changed between the two runs is the boundary and not the harness.
  if (BROKEN) {
    for (const o of mutatedOutcomes) {
      record(
        `${o.status} with ${o.label}: the PRE-FIX client consumes it (the probe can fail)`,
        o.consumed && !o.refused,
        JSON.stringify(o.visible),
      );
    }
  }

  await browser.close();
  stop();

  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(`checks: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log();
    console.log(BROKEN ? "FAIL  the pre-fix client did not behave as the finding says it does." : "FAIL  the versioned-contract boundary does not hold on refusals.");
    process.exit(1);
  }
  console.log();
  console.log(
    BROKEN
      ? "PASS  every mutated probe failed against the pre-fix client, and the controls did not."
      : "PASS  every refusal announces console.v1, and a refusal that does not is refused before a field of it is read.",
  );
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
