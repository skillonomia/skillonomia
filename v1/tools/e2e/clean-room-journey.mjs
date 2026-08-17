// THE CLEAN-ROOM OWNER JOURNEY, IN A REAL BROWSER — V1 P6.
//
//   node v1/tools/e2e/clean-room-journey.mjs                  the journey
//   node v1/tools/e2e/clean-room-journey.mjs --manual-owner   the same journey,
//                                                             with an owner who
//                                                             does the forbidden
//                                                             things, so the
//                                                             checker can be seen
//                                                             to refuse one
//
// WHAT THIS IS. `P6-FR-10` through `P6-FR-17` and contract section 3.1 point 6: an
// owner who has nothing but the product completes the whole loop — capture,
// preview, edit, approval, assignment, activation, a session whose stages and
// outcome they read, a new revision applied in a NEW session, and a rollback
// confirmed by another NEW session — WITHOUT hand-writing a manifest, a package,
// a JSON payload, a database row, an API key, signing material, an unpacked
// runtime file or a runtime config edit (`INV-09`).
//
// THE ABSENCE IS THE CLAIM, SO THE RUN MEASURES IT RATHER THAN ASSERTING IT.
// Every act of every actor is written to a JOURNAL — one JSON object per line,
// naming who acted, through what transport, on what surface, what they typed,
// what HTTP their client made, whether any of it carried a credential, and which
// server-confirmed identifier came back. `v1/tools/p6-clean-room-check.ts` reads
// that journal and refuses if a forbidden step appears in it, if an owner act
// reached a transport outside the two an owner has, or if the journey is not
// there in full. A sentence claiming no manifest was written is worth less than
// a record of everything that WAS done and a checker that reads it.
//
// THREE ACTORS, AND THE BOUNDARY BETWEEN THEM IS THE POINT.
//
//   `deployment`  what runs the product: it starts the registry, exchanges the
//                 bootstrap token, provisions the fleet agent and the runtime's
//                 evidence principal, and mints the one-time console ticket the
//                 owner signs in with. THE CREDENTIAL NEVER LEAVES THIS SIDE —
//                 which is `INV-04`'s design and the reason the owner can do the
//                 whole journey without ever holding a key.
//   `owner`       a person with a browser and an agent session, and nothing
//                 else. Two transports, and the checker allows no third:
//                 `agent_session_text` (typing at their agent) and `browser_ui`
//                 (clicking and typing in the Owner Console).
//   `runtime`     the agent's adapter, with its own service credential: it turns
//                 the owner's instruction into a capture, opens sessions, files
//                 `loaded` and `invoked` receipts and reports outcomes.
//
// WHAT IS HARNESS AND WHAT IS PRODUCT, SAID PLAINLY. The instruction recogniser
// — the thing that reads "оформи это как скилл" and calls `POST /v1/captures` —
// is IN THIS FILE, standing in for the agent. This registry has no natural-
// language intake and V1 does not add one; what it has is the capture path, and
// that is what the recogniser calls. So `P6-FR-10` is proved to the extent that
// the journey STARTS at a natural instruction in a session and the owner never
// touches the payload — not to the extent that the registry parsed the sentence.
// `v1/P6-DOGFOOD.md` section 11 states the same limitation where a reader of the
// evidence will find it.
//
// EXIT CODES, the four every gate harness in this tree uses:
//   0  the journey ran          1  it did not       2  REFUSED (subject unreachable)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const REPO = new URL("../../../", import.meta.url).pathname;
const MANUAL = process.argv.includes("--manual-owner");
const PORT = Number(process.env.SKLN_CLEAN_ROOM_PORT ?? (MANUAL ? "7972" : "7973"));
const BASE = `http://127.0.0.1:${PORT}`;
const JOURNAL =
  process.env.SKLN_CLEAN_ROOM_JOURNAL ?? join(tmpdir(), `clean-room-journal${MANUAL ? "-manual" : ""}.jsonl`);
/** WHERE THE PICTURES GO. Contract section 10's P6 evidence list names a
 *  clean-room walkthrough WITH SCREENSHOTS and correlating backend/runtime
 *  receipts; section 9 rules out screenshots no receipt corroborates. So every
 *  image is written beside a manifest that names, for each one, the exact
 *  registry-issued identifiers the state it shows was built from — and beside
 *  the rendered text of that same state, so the correlation is a thing a reader
 *  and a checker can recompute rather than a caption. */
const SHOTS =
  process.env.SKLN_CLEAN_ROOM_SHOTS ?? join(dirname(JOURNAL), MANUAL ? "screenshots-manual" : "screenshots");

let seq = 0;
function record(entry) {
  seq += 1;
  appendFileSync(JOURNAL, `${JSON.stringify({ seq, ...entry })}\n`);
  return entry;
}
function refuse(why) {
  console.error(`REFUSED: ${why}`);
  process.exit(2);
}
const digest = (s) => createHash("sha256").update(String(s)).digest("hex");

/** The workflow the owner is talking about when they say "make this a skill" —
 *  an actual internal procedure, typed as they would say it. */
const PROCEDURE = [
  "# check a release candidate before it is announced",
  "",
  "Use this whenever a release candidate has been cut and nothing has been said about it yet.",
  "",
  "## Purpose",
  "Decide whether a cut candidate is safe to announce, without guessing.",
  "",
  "## Procedure",
  "1. Read the diff against the last tag.",
  "2. Run the suite, and stop if anything is red.",
  "3. Record the content digest of what was built.",
  "",
  "## Inputs",
  "- the candidate tag",
  "",
  "## Outputs",
  "- a candidate that is either announced or held",
  "",
  "## Permissions",
  "- read the repository",
  "",
  "## Dependencies",
  "- git",
  "",
  "## Failure modes",
  "- the suite is red, so nothing is announced",
].join("\n");

const INSTRUCTION = `оформи это как скилл:\n${PROCEDURE}`;

/** THE AGENT'S SIDE OF THE INSTRUCTION, and the honest bound on it. It matches
 *  the two forms of "make this a skill" this deployment supports and hands the
 *  rest of the sentence to the capture path as the plain text it is. It builds
 *  no manifest and asks the owner for no field: everything the draft has, the
 *  compiler derived. */
function recogniseInstruction(text) {
  const m = /^\s*(?:оформи это как скилл|make this a skill)\s*:?\s*\n?([\s\S]+)$/i.exec(text);
  return m ? { recognised: true, body: m[1].trim() } : { recognised: false, body: null };
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

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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
/** A click on a lifecycle command, and the wait for the server's answer — the
 *  result line is cleared first, or the wait returns on the PREVIOUS verdict.
 *  The same helper `console-p3-e2e.mjs` uses, for the same reason. */
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

async function pollOption(page, selector, value, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const values = await page.$$eval(`${selector} option`, (nodes) => nodes.map((n) => n.value)).catch(() => []);
    if (values.includes(value)) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${selector} to offer ${value}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  writeFileSync(JOURNAL, "");
  record({
    actor: "harness",
    act: "journey_begins",
    transport: "none",
    surface: "—",
    description: `clean-room owner journey, manual_owner=${MANUAL}`,
    base: BASE,
  });

  // ================================================== the deployment's side
  const dataDir = mkdtempSync(join(tmpdir(), "skln-clean-room-"));
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
  record({
    actor: "deployment",
    act: "registry_up",
    transport: "process",
    surface: "skillonomia serve",
    description: "a fresh database and an empty registry — no adopted state and no artifact from another gate",
    data_dir_is_fresh: true,
    version: health.version,
  });

  const token = /BOOTSTRAP_OWNER_TOKEN[=: ]+(\S+)/.exec(banner);
  if (!token) {
    console.error(banner);
    refuse("the server printed no bootstrap token");
  }
  const owner = await (await api("/v1/auth/bootstrap", { method: "POST", body: { bootstrap_token: token[1] } })).json();
  const OWNER_KEY = owner.api_key;
  if (typeof OWNER_KEY !== "string" || OWNER_KEY.length < 20) refuse("no owner API key");
  record({
    actor: "deployment",
    act: "owner_key_exchanged",
    transport: "machine_api",
    surface: "POST /v1/auth/bootstrap",
    description: "the deployment holds the registry credential; the owner is never shown it and never sends it",
    credential_stays_server_side: true,
  });

  const idOf = (json) => json.principal?.agent_id ?? json.agent_id ?? json.principal_id ?? json.id;
  const fleetAgent = await asJson(
    await api("/v1/principals", {
      method: "POST",
      key: OWNER_KEY,
      body: { name: `release-agent-${PORT}`, type: "agent", role: "member" },
    }),
  );
  if (fleetAgent.status !== 201) refuse(`the fleet agent was not provisioned: ${fleetAgent.text.slice(0, 200)}`);
  const agentId = idOf(fleetAgent.json);
  const adapter = await asJson(
    await api("/v1/principals", {
      method: "POST",
      key: OWNER_KEY,
      body: { name: `release-adapter-${PORT}`, type: "service", role: "member" },
    }),
  );
  if (adapter.status !== 201) refuse(`the adapter principal was not provisioned: ${adapter.text.slice(0, 200)}`);
  const adapterId = idOf(adapter.json);
  const ADAPTER_KEY = adapter.json.api_key ?? adapter.json.principal?.api_key;
  if (typeof ADAPTER_KEY !== "string" || ADAPTER_KEY.length < 20) refuse("the adapter holds no API key");
  const principalsFile = join(dataDir, "evidence-principals.json");
  const registrations = existsSync(principalsFile) ? JSON.parse(readFileSync(principalsFile, "utf8")) : {};
  registrations[adapterId] = "adapter";
  writeFileSync(principalsFile, JSON.stringify(registrations, null, 2), { mode: 0o600 });
  record({
    actor: "deployment",
    act: "fleet_provisioned",
    transport: "machine_api",
    surface: "POST /v1/principals, and the deployment's evidence-principal registration",
    description: "the agent the owner will assign to, and the runtime adapter that will report what it did",
    backend: { agent_id: agentId, adapter_id: adapterId },
  });

  const ticket = await (await api("/v1/console/tickets", { method: "POST", key: OWNER_KEY, body: {} })).json();
  record({
    actor: "deployment",
    act: "console_ticket_minted",
    transport: "machine_api",
    surface: "POST /v1/console/tickets",
    description:
      "the one-time sign-in the owner is handed. It is not a key: it opens one session, once, within five minutes",
    ticket_sha256: digest(ticket.ticket),
  });

  // ================================================== the browser the owner has
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  // A FIXED VIEWPORT AND SCALE, so two runs of this journey photograph the same
  // page at the same size and a difference between two images is a difference
  // in the product rather than in the window somebody happened to have open.
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const exchanges = [];
  page.on("response", (res) => {
    const url = new URL(res.url());
    const headers = res.request().headers();
    exchanges.push({
      method: res.request().method(),
      path: url.pathname,
      status: res.status(),
      authorization: Boolean(headers.authorization || headers["proxy-authorization"]),
    });
  });
  page.on("pageerror", (e) => record({ actor: "owner", act: "page_error", transport: "browser_ui", surface: "console", description: e.message }));

  /** ONE OWNER ACT. It records what the owner did, every request their browser
   *  made while doing it, and the server-confirmed identifier that came back. */
  async function ownerUI(act, description, fn, extra = {}) {
    const before = exchanges.length;
    let value;
    try {
      value = await fn();
    } finally {
      record({
        actor: "owner",
        act,
        transport: "browser_ui",
        surface: "Owner Console in Chromium",
        description,
        http: exchanges.slice(before),
        ...extra,
        ...(value !== undefined && value !== null && typeof value === "object" && "backend" in value
          ? { backend: value.backend }
          : {}),
      });
    }
    return value;
  }
  function ownerTyped(act, description, text, extra = {}) {
    record({
      actor: "owner",
      act,
      transport: "agent_session_text",
      surface: "the owner's agent session",
      description,
      typed_text: text,
      ...extra,
    });
  }
  function runtimeAct(act, description, extra = {}) {
    record({ actor: "runtime", act, transport: "machine_api", surface: "the runtime adapter's own credential", description, ...extra });
  }

  // ------------------------------------------------------- the screenshots
  //
  // ONE IMAGE IS ONE STATE THE JOURNEY ALREADY ASSERTS, AND IT IS TIED TO THE
  // IDENTIFIERS THAT STATE WAS MADE OF. A picture nobody can resolve against a
  // receipt is worth no more than a sentence saying the screen looked right,
  // which is what contract section 9 refuses. So each capture writes three
  // things and the manifest binds them:
  //
  //   <n>-<name>.png    the pixels, full page, at a fixed viewport
  //   <n>-<name>.txt    the rendered text of exactly that page, at that moment
  //   screenshots.json  for every image: its sha256, the sha256 of its text,
  //                     and every identifier the state carries — each one
  //                     marked `visible_text` when it is literally on the
  //                     screen and `dom` when the page carries it as an
  //                     attribute the picture cannot show. An identifier that
  //                     is neither is a FAILURE here, not a footnote.
  //
  // The identifiers are the REGISTRY'S answers, captured before the page was
  // read — never values scraped off the page and then found on the page again,
  // which would be a tautology with a photograph attached.
  //
  // AND NOTHING SENSITIVE MAY BE IN THE FRAME. The owner never holds a key and
  // the console session cookie is HttpOnly, so this should be true by
  // construction; it is measured anyway, over the rendered text AND over the
  // raw bytes of the PNG, because "should be" is how a credential ships.
  mkdirSync(SHOTS, { recursive: true });
  const shots = [];
  const SECRETS = () => [
    ["owner API key", OWNER_KEY],
    ["adapter API key", ADAPTER_KEY],
    ["bootstrap token", token[1]],
    ["console ticket", ticket.ticket],
  ];
  async function shot(name, requirement, act, description, identifiers) {
    const n = String(shots.length + 1).padStart(2, "0");
    const imageFile = `${n}-${name}.png`;
    const textFile = `${n}-${name}.txt`;
    const png = await page.screenshot({ fullPage: true });
    const text = (await page.innerText("body")) ?? "";
    const html = await page.content();
    writeFileSync(join(SHOTS, imageFile), png);
    writeFileSync(join(SHOTS, textFile), text);

    const shown = [];
    const missing = [];
    for (const [kind, value] of identifiers) {
      if (value === undefined || value === null || String(value).length === 0) {
        missing.push(`${kind} (the registry returned no value for it)`);
        continue;
      }
      const v = String(value);
      const where = text.includes(v) ? "visible_text" : html.includes(v) ? "dom" : "absent";
      if (where === "absent") missing.push(`${kind}=${v}`);
      shown.push({ kind, value: v, where });
    }
    const leaked = SECRETS()
      .filter(([, v]) => typeof v === "string" && v.length > 0)
      .filter(([, v]) => text.includes(v) || html.includes(v) || png.toString("latin1").includes(v))
      .map(([what]) => what);

    const entry = {
      image: imageFile,
      image_sha256: createHash("sha256").update(png).digest("hex"),
      image_bytes: png.length,
      rendered_text: textFile,
      rendered_text_sha256: digest(text),
      requirement,
      act,
      description,
      identifiers: shown,
      identifiers_in_visible_text: shown.filter((s) => s.where === "visible_text").length,
      credentials_checked: SECRETS().filter(([, v]) => typeof v === "string" && v.length > 0).length,
      credential_hits: leaked,
    };
    shots.push(entry);
    record({
      actor: "harness",
      act: "screenshot_captured",
      transport: "none",
      surface: "the Owner Console in Chromium, as the owner saw it",
      description,
      screenshot: entry,
    });
    check(
      `${requirement} the screenshot ${imageFile} resolves against the registry's own identifiers`,
      missing.length === 0 && leaked.length === 0 && entry.identifiers_in_visible_text > 0,
      missing.length > 0
        ? `not on the page: ${missing.join(", ")}`
        : leaked.length > 0
          ? `A CREDENTIAL IS IN THE FRAME: ${leaked.join(", ")}`
          : `${shown.length} identifiers, ${entry.identifiers_in_visible_text} of them read off the screen itself`,
    );
    return entry;
  }
  /** The registry's own answer about a draft revision, read over the console
   *  session the owner already has — so a digest the picture shows is compared
   *  against the server's value rather than against itself. */
  const consoleGet = async (path) => {
    const cookie = (await context.cookies()).find((c) => c.name === "skln_console");
    return (await (await api(path, { headers: { Cookie: `skln_console=${cookie.value}` } })).json());
  };

  // ---- P6-FR-10: the natural instruction, in a session ---------------------
  ownerTyped(
    "natural_instruction",
    "the owner says, in their agent session, that this procedure should become a skill",
    INSTRUCTION,
  );
  const recognised = recogniseInstruction(INSTRUCTION);
  if (!recognised.recognised) refuse("the instruction was not recognised, so the journey has no start");
  const captured = await (
    await api("/v1/captures", { method: "POST", key: ADAPTER_KEY, body: { kind: "workflow", text: recognised.body } })
  ).json();
  if (captured.outcome !== "drafted") {
    refuse(`the capture did not produce a draft: ${JSON.stringify(captured.refusal ?? captured).slice(0, 300)}`);
  }
  const draftId = captured.draft.draft_id;
  const revision1 = captured.draft.revision_id;
  runtimeAct("capture_submitted", "the agent turned the owner's sentence into a capture on the product path", {
    backend: { draft_id: draftId, revision_id: revision1 },
    payload_authored_by: "the capture path, from the owner's plain sentence",
  });
  check("P6-FR-10 a natural instruction in a session produced a draft, with no field asked of the owner", true, draftId);

  // ---- the owner signs in --------------------------------------------------
  await ownerUI(
    "sign_in",
    "the owner pastes the one-time ticket the deployment handed them; no key is theirs to hold",
    async () => {
      await page.goto("/console/login");
      await page.fill("#ticket", ticket.ticket);
      await page.click("#login button[type=submit]");
      await page.waitForURL("**/console");
      await page.waitForSelector("#inbox[data-loaded=true]");
      return { backend: { signed_in: true } };
    },
    { credential_class: "one_time_console_ticket", ticket_sha256: digest(ticket.ticket) },
  );

  // ---- P6-FR-11: the draft and both previews ------------------------------
  const preview = await ownerUI(
    "read_draft_preview",
    "the owner opens the draft and reads the semantic and security previews the registry produced",
    async () => {
      await page.click(`#inbox-rows tr[data-draft-id="${draftId}"] button[data-draft-id]`);
      await page.waitForSelector(`#detail[data-draft-id="${draftId}"]`);
      const text = (await page.textContent("#detail")) ?? "";
      const shownRevision = await page.getAttribute("#detail", "data-revision-id");
      return { backend: { revision_id: shownRevision }, text };
    },
  );
  check(
    "P6-FR-11 the draft the owner reads is the revision the capture created",
    preview.backend.revision_id === revision1,
    String(preview.backend.revision_id),
  );
  check(
    "P6-FR-11 with the semantic preview and the security preview on the screen",
    /Semantic findings \(\d+ blocking\)/.test(preview.text) && /Security findings \(\d+ blocking\)/.test(preview.text),
  );
  await shot(
    "draft-with-previews",
    "P6-FR-11",
    "read_draft_preview",
    "the draft the capture created, with its semantic and security previews, as the owner reads it",
    [
      ["draft_id", draftId],
      ["revision_id", revision1],
      ["content_digest", captured.draft.content_digest],
    ],
  );

  // ---- P6-FR-12: an edit, and the approval of an exact revision ------------
  const edited = await ownerUI(
    "edit_procedure",
    "the owner edits the procedure in the console; the edit becomes a NEW revision, which is what INV-06 requires",
    async () => {
      await page.fill(
        "#edit-procedure",
        "Read the diff against the last tag.\nRun the suite, and stop if anything is red.\nRecord the content digest of what was built, and name it in the release note.",
      );
      await page.click("#save-edit");
      await pollAttribute(page, "#detail", "data-revision-id", (v) => v !== revision1);
      const shown = await page.getAttribute("#detail", "data-revision-id");
      return { backend: { revision_id: shown } };
    },
  );
  const revision2 = edited.backend.revision_id;
  check("P6-FR-12 the edit produced a new revision rather than changing the old one", revision2 !== revision1, String(revision2));

  await ownerUI(
    "approve_revision",
    "the owner approves the exact revision they are looking at",
    async () => {
      await page.click("#approve");
      await pollAttribute(page, "#revision-approval", "data-approved", (v) => v === "true");
      return { backend: { approved_revision_id: revision2 } };
    },
  );
  check("P6-FR-12 the owner approved an exact revision from the page", true, String(revision2));
  const approvedDetail = await consoleGet(`/v1/console/drafts/${draftId}?revision_id=${revision2}`);
  await shot(
    "approved-revision",
    "P6-FR-12",
    "approve_revision",
    "the exact revision the owner approved, and the registry's approval of that revision and no other",
    [
      ["draft_id", draftId],
      ["approved_revision_id", revision2],
      ["approved_content_digest", approvedDetail.revision_approval?.content_digest],
    ],
  );

  // ---- P6-FR-13: assignment and activation --------------------------------
  const assigned = await ownerUI(
    "assign_revision",
    "the owner assigns the approved revision to the agent, from the capability screen",
    async () => {
      await page.click("#refresh-capabilities");
      await page.waitForSelector("#capabilities[data-loaded=true]");
      await page.click(`button[data-capability-id="${draftId}"]`);
      await page.waitForSelector(`#capability[data-capability-id="${draftId}"]`);
      const assignable = await page.$(`#fleet div[data-assignable="true"] button[data-assign-agent-id="${agentId}"]`);
      if (!assignable) throw new Error(`the agent ${agentId} is not assignable on the screen`);
      await page.fill("#lifecycle-reason", "assigned from the console");
      await clickCommand(page, assignable);
      await pollAttribute(page, "#assignments", "data-count", (v) => Number(v) >= 1);
      const id = await page.getAttribute(".assignment", "data-assignment-id");
      return { backend: { assignment_id: id } };
    },
  );
  const assignmentId = assigned.backend.assignment_id;
  if (!assignmentId) refuse("the assignment screen produced no assignment");

  await ownerUI(
    "activate_assignment",
    "the owner activates it; the console says it takes effect in the NEXT session",
    async () => {
      await clickCommand(page, `.assignment button[data-action="activate"]`);
      await pollAttribute(page, ".assignment .desired", "data-desired-state", (v) => v === "active");
      const effective = (await page.textContent("#effective-from")) ?? "";
      return { backend: { assignment_id: assignmentId }, effective };
    },
  );
  const desired = await (
    await api(`/v1/console/assignments/${assignmentId}`, {
      headers: { Cookie: `skln_console=${(await context.cookies()).find((c) => c.name === "skln_console").value}` },
    })
  ).json();
  check(
    "P6-FR-13 the registry holds the assignment active on the revision the owner approved",
    desired.assignment.desired.revision_id === revision2 && desired.assignment.desired.state === "active",
    `${desired.assignment.desired.revision_id} ${desired.assignment.desired.state}`,
  );
  await shot(
    "assignment-and-activation",
    "P6-FR-13",
    "activate_assignment",
    "the assignment the owner made and activated: the desired state the owner asked for, on the revision they approved, beside the observed state evidence has reported",
    [
      ["assignment_id", assignmentId],
      ["agent_id", agentId],
      ["desired_revision_id", desired.assignment.desired.revision_id],
      ["desired_content_digest", desired.assignment.desired.content_digest],
    ],
  );

  // ---- the run, on the machine surface ------------------------------------
  const openSession = async (kind, key) => {
    const res = await asJson(
      await api("/v1/sessions", {
        method: "POST",
        key: ADAPTER_KEY,
        body: { agent_id: agentId, runtime_kind: kind, runtime_version: "clean-room", idempotency_key: key },
      }),
    );
    if (res.status !== 201) refuse(`opening a ${kind} session answered ${res.status}: ${res.text.slice(0, 300)}`);
    runtimeAct("session_opened", `a ${kind} session opened and was handed its loadout`, {
      backend: { session_id: res.json.session_id, revision_id: res.json.entries[0]?.draft_revision_id },
    });
    return res.json;
  };
  const receipt = async (sessionId, stage, entry, refs, key) => {
    const res = await asJson(
      await api(`/v1/sessions/${sessionId}/receipts`, {
        method: "POST",
        key: ADAPTER_KEY,
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
    runtimeAct("receipt_filed", `the runtime reported ${stage}`, {
      backend: { receipt_id: res.json.receipt_id, stage },
    });
    return res.json;
  };
  const fileOutcome = async (sessionId, entry, refs, body) => {
    const res = await asJson(
      await api(`/v1/sessions/${sessionId}/outcomes`, {
        method: "POST",
        key: ADAPTER_KEY,
        body: {
          revision_id: entry.draft_revision_id,
          content_digest: entry.content_digest,
          runtime_session_ref: refs.runtime,
          invocation_ref: refs.invocation,
          ...body,
        },
      }),
    );
    if (res.status !== 201) refuse(`the outcome answered ${res.status}: ${res.text.slice(0, 300)}`);
    runtimeAct("outcome_reported", `the runtime reported the outcome \`${body.outcome}\``, {
      backend: { outcome_id: res.json.outcome_id },
    });
    return res.json;
  };

  const refs1 = { runtime: "rt-clean-room-1", invocation: "call-clean-room-1" };
  const session1 = await openSession("codex", "cr-s1");
  const entry1 = session1.entries[0];
  if (!entry1 || entry1.draft_revision_id !== revision2) refuse("the first session did not carry the approved revision");
  const loaded1 = await receipt(session1.session_id, "loaded", entry1, refs1, "cr-ld-1");
  const invoked1 = await receipt(session1.session_id, "invoked", entry1, refs1, "cr-iv-1");
  const failed = await fileOutcome(session1.session_id, entry1, refs1, {
    outcome: "failed",
    outcome_ref: "outcome-clean-room-1",
    reason_code: "SUITE_RED",
    reason: "the suite was red on the changed package and nothing shipped",
    transcript_excerpt: "step 2: 3 tests red",
  });

  // ---- P6-FR-14: proposed, loaded, invoked and the outcome, with provenance
  const seen = await ownerUI(
    "read_session_stages",
    "the owner opens the session in the console and reads every stage it passed through, and the outcome",
    async () => {
      await page.fill("#session-id", session1.session_id);
      await page.click("#open-session");
      await page.waitForSelector(`#session[data-session-id="${session1.session_id}"]`);
      const stages = await page.getAttribute(".session-entry .stage-chain", "data-stages");
      const rows = await page.$$eval(".session-entry .stage", (nodes) =>
        nodes.map((n) => ({
          stage: n.dataset.stage,
          source: n.dataset.source,
          receipt: n.dataset.receiptId,
          ref: n.dataset.runtimeSessionRef,
          at: n.dataset.atMs,
        })),
      );
      const outcomeCount = Number(await page.getAttribute("#session-outcomes", "data-count"));
      const outcomeSel = `#session-outcomes .outcome[data-outcome-id="${failed.outcome_id}"]`;
      const outcome = {
        word: await page.getAttribute(outcomeSel, "data-outcome"),
        source: await page.getAttribute(outcomeSel, "data-source"),
        evidence: await page.getAttribute(outcomeSel, "data-evidence-class"),
        receipt: await page.getAttribute(outcomeSel, "data-invocation-receipt-id"),
        text: (await page.textContent(outcomeSel)) ?? "",
      };
      return { backend: { session_id: session1.session_id, outcome_id: failed.outcome_id }, stages, rows, outcomeCount, outcome };
    },
  );
  check(
    "P6-FR-14 the owner sees proposed, loaded and invoked for the entry this session carried",
    seen.stages === "proposed,loaded,invoked",
    String(seen.stages),
  );
  check(
    "P6-FR-14 each stage carries its provenance — its source, its receipt and the runtime reference it was reported under",
    seen.rows.length === 3 &&
      seen.rows[0].source === "backend" &&
      seen.rows[1].source === "adapter" &&
      seen.rows[2].receipt === invoked1.receipt_id &&
      seen.rows[2].ref === refs1.runtime &&
      seen.rows.every((r) => Number(r.at) > 0),
    JSON.stringify(seen.rows),
  );
  check(
    "P6-FR-14 and the outcome, as the word the registry filed, with its source, evidence class and the receipt under it",
    seen.outcomeCount === 1 &&
      seen.outcome.word === "failed" &&
      seen.outcome.source === "adapter" &&
      seen.outcome.evidence === "runtime_receipt" &&
      seen.outcome.receipt === invoked1.receipt_id &&
      seen.outcome.text.includes("SUITE_RED"),
    JSON.stringify({ ...seen.outcome, text: undefined }),
  );
  await shot(
    "session-stages-and-outcome",
    "P6-FR-14",
    "read_session_stages",
    "the session the owner opened: proposed, loaded and invoked with the receipt each stage was reported under, and the outcome the runtime filed, with its source, its evidence class and the invocation receipt beneath it",
    [
      ["session_id", session1.session_id],
      ["revision_id", revision2],
      ["loaded_receipt_id", loaded1.receipt_id],
      ["invoked_receipt_id", invoked1.receipt_id],
      ["outcome_id", failed.outcome_id],
      ["runtime_session_ref", refs1.runtime],
      ["invocation_ref", refs1.invocation],
    ],
  );

  // ---- P6-FR-15: a new revision, applied in a NEW session ------------------
  const made = await ownerUI(
    "create_new_revision",
    "the owner states what went wrong and what the next revision must reach, and makes it from the failure",
    async () => {
      await page.click(`button[data-capability-id="${draftId}"]`);
      await page.waitForSelector(`#outcomes[data-capability-id="${draftId}"]`);
      await page.fill(`#observation-${failed.outcome_id}`, "the suite ran the wrong target, so red meant nothing");
      await page.fill(`#goal-${failed.outcome_id}`, "the same scenario reaches worked");
      await page.selectOption(`#origin-${failed.outcome_id}`, "failure");
      await page.fill(
        `#procedure-${failed.outcome_id}`,
        "Read the diff against the last tag.\nRun the suite for the package the diff touched, and stop if anything is red.\nRecord the content digest of what was built, and name it in the release note.",
      );
      await page.evaluate(() => {
        const box = document.getElementById("outcome-result");
        if (box) box.dataset.result = "";
      });
      await page.click(`button.create-revision[data-outcome-id="${failed.outcome_id}"]`);
      await pollAttribute(page, "#outcome-result", "data-result", (v) => v.length > 0);
      const id = await page.getAttribute(".lineage", "data-revision-id");
      return { backend: { revision_id: id } };
    },
  );
  const revision3 = made.backend.revision_id;
  if (!revision3) refuse("the create-revision command left no lineage row");
  check("P6-FR-15 a new revision descends from the failure the owner read", revision3 !== revision2, String(revision3));

  await ownerUI("approve_new_revision", "the owner reviews the new revision and approves it, on the same path", async () => {
    await page.click(`#inbox-rows tr[data-draft-id="${draftId}"] button[data-draft-id]`);
    await page.waitForSelector(`#detail[data-draft-id="${draftId}"]`);
    await pollAttribute(page, "#detail", "data-revision-id", (v) => v === revision3);
    await page.click("#approve");
    await pollAttribute(page, "#revision-approval", "data-approved", (v) => v === "true");
    return { backend: { approved_revision_id: revision3 } };
  });

  await ownerUI("apply_new_revision", "the owner selects the new revision for the next session", async () => {
    await page.click(`button[data-capability-id="${draftId}"]`);
    await pollOption(page, `#revision-${assignmentId}`, revision3);
    await page.selectOption(`#revision-${assignmentId}`, revision3);
    await page.evaluate(() => {
      const box = document.getElementById("lifecycle-result");
      if (box) box.dataset.result = "";
    });
    await page.click(`.assignment button[data-action="select_revision"]`);
    await pollAttribute(page, ".assignment .desired", "data-desired-revision-id", (v) => v === revision3);
    return { backend: { desired_revision_id: revision3 } };
  });

  const refs2 = { runtime: "rt-clean-room-2", invocation: "call-clean-room-2" };
  const session2 = await openSession("claude_code", "cr-s2");
  const entry2 = session2.entries[0];
  if (entry2.draft_revision_id !== revision3) refuse("the NEW session did not carry the newly selected revision");
  const loaded2 = await receipt(session2.session_id, "loaded", entry2, refs2, "cr-ld-2");
  const invoked2 = await receipt(session2.session_id, "invoked", entry2, refs2, "cr-iv-2");
  const worked = await fileOutcome(session2.session_id, entry2, refs2, {
    outcome: "worked",
    outcome_ref: "outcome-clean-room-2",
    reason_code: "SHIPPED",
    reason: "the suite ran the right target, went green, and the digest was recorded",
  });

  const applied = await ownerUI(
    "read_new_session_stages",
    "the owner opens the NEW session and sees that it carried the new revision and used it",
    async () => {
      await page.fill("#session-id", session2.session_id);
      await page.click("#open-session");
      await pollAttribute(page, "#session", "data-session-id", (v) => v === session2.session_id);
      const rev = await page.getAttribute(".session-entry", "data-revision-id");
      const stage = await page.getAttribute(".session-entry", "data-stage");
      const stages = await page.getAttribute(".session-entry .stage-chain", "data-stages");
      return { backend: { session_id: session2.session_id, revision_id: rev, receipt_id: invoked2.receipt_id }, rev, stage, stages };
    },
  );
  check(
    "P6-FR-15 the new revision was applied in a NEW session, and the owner sees it there",
    applied.rev === revision3 && applied.stage === "invoked" && applied.stages === "proposed,loaded,invoked",
    `${applied.rev} ${applied.stage} ${applied.stages}`,
  );
  await shot(
    "new-revision-in-new-session",
    "P6-FR-15",
    "read_new_session_stages",
    "the NEW session, carrying the revision the owner made from the failure and selected — the same three stages, on the new revision",
    [
      ["session_id", session2.session_id],
      ["revision_id", revision3],
      ["loaded_receipt_id", loaded2.receipt_id],
      ["invoked_receipt_id", invoked2.receipt_id],
      ["outcome_id", worked.outcome_id],
      ["runtime_session_ref", refs2.runtime],
    ],
  );

  // ---- P6-FR-16: the rollback, confirmed in another NEW session ------------
  await ownerUI("prepare_rollback", "the owner chooses the earlier approved revision and reads back what it means", async () => {
    await page.click("#refresh-outcomes");
    await page.selectOption(`#rollback-target-${assignmentId}`, revision2);
    await page.click(`button.prepare-rollback[data-assignment-id="${assignmentId}"]`);
    const target = await page.getAttribute(`.rollback-plan[data-assignment-id="${assignmentId}"]`, "data-target-revision-id");
    const text = (await page.textContent(`.rollback-plan[data-assignment-id="${assignmentId}"]`)) ?? "";
    return { backend: { target_revision_id: target }, text };
  });
  const rolled = await ownerUI("confirm_rollback", "the owner confirms the rollback", async () => {
    await page.evaluate(() => {
      const box = document.getElementById("outcome-result");
      if (box) box.dataset.result = "";
    });
    await page.click(`button.confirm-rollback[data-assignment-id="${assignmentId}"]`);
    await pollAttribute(page, "#outcome-result", "data-result", (v) => v.length > 0);
    const result = await page.getAttribute("#outcome-result", "data-result");
    return { backend: { rolled_back_to: revision2 }, result };
  });
  check("P6-FR-16 the registry accepted the rollback the owner confirmed", rolled.result === "applied", String(rolled.result));

  const refs3 = { runtime: "rt-clean-room-3", invocation: "call-clean-room-3" };
  const session3 = await openSession("codex", "cr-s3");
  const entry3 = session3.entries[0];
  if (entry3.draft_revision_id !== revision2) refuse("the session after the rollback did not carry the rollback target");
  const loaded3 = await receipt(session3.session_id, "loaded", entry3, refs3, "cr-ld-3");
  const invoked3 = await receipt(session3.session_id, "invoked", entry3, refs3, "cr-iv-3");

  const confirmedBack = await ownerUI(
    "read_rollback_session",
    "the owner opens the session that opened AFTER the rollback and sees the earlier revision carried and used",
    async () => {
      await page.fill("#session-id", session3.session_id);
      await page.click("#open-session");
      await pollAttribute(page, "#session", "data-session-id", (v) => v === session3.session_id);
      const rev = await page.getAttribute(".session-entry", "data-revision-id");
      const stages = await page.getAttribute(".session-entry .stage-chain", "data-stages");
      return { backend: { session_id: session3.session_id, revision_id: rev }, rev, stages };
    },
  );
  check(
    "P6-FR-16 a NEW session carried the rolled-back-to revision, and the owner sees it",
    confirmedBack.rev === revision2 && confirmedBack.stages === "proposed,loaded,invoked",
    `${confirmedBack.rev} ${confirmedBack.stages}`,
  );
  await shot(
    "rollback-confirmed-in-new-session",
    "P6-FR-16",
    "read_rollback_session",
    "the session that opened AFTER the rollback the owner confirmed, carrying the earlier approved revision and having used it",
    [
      ["session_id", session3.session_id],
      ["rolled_back_to_revision_id", revision2],
      ["loaded_receipt_id", loaded3.receipt_id],
      ["invoked_receipt_id", invoked3.receipt_id],
      ["runtime_session_ref", refs3.runtime],
    ],
  );
  check(
    "INV-06 the revision that was rolled away from is still approved and still there",
    (await (
      await api(`/v1/console/assignments/${assignmentId}`, {
        headers: { Cookie: `skln_console=${(await context.cookies()).find((c) => c.name === "skln_console").value}` },
      })
    ).json()).assignment.approved_revisions.length === 2,
    "the two revisions the owner approved are both still approved",
  );

  // ---- what the browser was never given -----------------------------------
  const storage = await page.evaluate(() => ({
    local: Object.entries(localStorage ?? {}),
    session: Object.entries(sessionStorage ?? {}),
  }));
  const cookies = await context.cookies();
  const cookieNames = cookies.map((c) => `${c.name}:${c.httpOnly ? "httpOnly" : "readable"}`);
  const leaked =
    JSON.stringify(storage).includes(OWNER_KEY) ||
    JSON.stringify(storage).includes(ADAPTER_KEY) ||
    cookies.some((c) => c.value === OWNER_KEY || c.value === ADAPTER_KEY);
  const authorized = exchanges.filter((e) => e.authorization);
  record({
    actor: "harness",
    act: "credential_scan",
    transport: "none",
    surface: "the browser context the owner used",
    description: "what the owner's browser was ever given, measured rather than asserted",
    authorization_headers: authorized.length,
    browser_storage_entries: storage.local.length + storage.session.length,
    credential_in_browser: leaked,
    cookies: cookieNames,
    requests_total: exchanges.length,
  });
  check("INV-04 no request the owner's browser made carried a credential", authorized.length === 0, `${authorized.length}`);
  check("INV-04 no key reached the browser's storage or a readable cookie", leaked === false, cookieNames.join(", "));

  // ---- the manual owner, so the checker can be seen to refuse one ----------
  if (MANUAL) {
    const manualDir = mkdtempSync(join(tmpdir(), "skln-manual-owner-"));
    const manifest = join(manualDir, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({ manifest_version: 1, name: "ship-the-change", entries: [{ path: "SKILL.md", sha256: digest("x") }] }, null, 2),
    );
    record({
      actor: "owner",
      act: "hand_write_manifest",
      transport: "text_editor",
      surface: "a file the owner typed",
      description: "the owner hand-writes a manifest — exactly what INV-09 forbids",
      typed_text: readFileSync(manifest, "utf8"),
      file_write: manifest,
    });
    const withKey = await asJson(await api("/v1/drafts", { key: OWNER_KEY }));
    record({
      actor: "owner",
      act: "handle_api_key",
      transport: "terminal",
      surface: "curl with the registry key",
      description: "the owner holds and sends the API key",
      http: [{ method: "GET", path: "/v1/drafts", status: withKey.status, authorization: true }],
    });
    const config = join(manualDir, "config.toml");
    writeFileSync(config, '[skills]\nload = ["ship-the-change"]\n');
    record({
      actor: "owner",
      act: "edit_runtime_config",
      transport: "text_editor",
      surface: "~/.codex/config.toml",
      description: "the owner edits the runtime's configuration by hand",
      typed_text: readFileSync(config, "utf8"),
      file_write: config,
    });
    console.log();
    console.log("manual owner: three forbidden steps were recorded in the journal, for the checker to refuse");
  }

  const manifest = {
    contract: "skillonomia.v1.clean-room-screenshots.1",
    manual_owner: MANUAL,
    registry_version: health.version,
    journal: JOURNAL,
    directory: SHOTS,
    backend: {
      draft_id: draftId,
      revision_1: revision1,
      revision_2_approved: revision2,
      revision_3_from_failure: revision3,
      assignment_id: assignmentId,
      agent_id: agentId,
      sessions: [session1.session_id, session2.session_id, session3.session_id],
      outcomes: [failed.outcome_id, worked.outcome_id],
    },
    screenshots: shots,
  };
  writeFileSync(join(SHOTS, "screenshots.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  record({
    actor: "harness",
    act: "screenshots_written",
    transport: "none",
    surface: "the evidence directory the gate hands this run",
    description: "every image of this journey, its rendered text and the registry identifiers each one resolves against",
    directory: SHOTS,
    manifest: "screenshots.json",
    manifest_sha256: digest(`${JSON.stringify(manifest, null, 2)}\n`),
    images: shots.length,
  });

  record({
    actor: "harness",
    act: "journey_ends",
    transport: "none",
    surface: "—",
    description: "every act of the journey is above this line",
    checks_run: results.length,
    checks_failed: results.filter((r) => !r.ok).length,
  });

  await browser.close();
  stop();

  const failedChecks = results.filter((r) => !r.ok);
  console.log();
  console.log(`checks: ${results.length}   passed: ${results.length - failedChecks.length}   failed: ${failedChecks.length}`);
  console.log(`journal: ${JOURNAL}`);
  console.log(`screenshots: ${shots.length} in ${SHOTS}`);
  if (failedChecks.length > 0) {
    console.error(`FAILED: ${failedChecks.map((f) => f.name).join("; ")}`);
    process.exit(1);
  }
  if (results.length < 18) refuse(`only ${results.length} checks ran; this journey covers more than that`);
  if (shots.length !== 6) refuse(`${shots.length} screenshots were captured; this journey photographs six states`);
  console.log();
  console.log(
    MANUAL
      ? "PASS  the journey ran, and three forbidden owner steps are in the journal for the checker to find."
      : "PASS  the owner went from a sentence to a rolled-back revision through the product alone.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(/^REFUSED/.test(String(e?.message)) ? 2 : 1);
});
