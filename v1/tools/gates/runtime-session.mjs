// THE BODY OF BOTH RUNTIME GATES — the ONE end-to-end scenario, parameterised
// by which runtime it drives.
//
//   node v1/tools/gates/runtime-session.mjs <codex|claude_code> --base-url URL
//        --owner-token TOKEN --data DIR --work DIR
//
// It is a script and not a bash body because the scenario is eight HTTP calls
// with structured answers, and because BOTH gates must drive the SAME steps —
// two hand-written bash bodies would drift, and a drift here is one runtime
// proved and the other assumed.
//
// It refuses (exit 2) rather than simulating when it cannot reach its subject,
// and every claim it makes it asserts.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_REFUSED = 2;

const args = process.argv.slice(2);
const RUNTIME = args[0];
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const BASE = (opt("base-url") ?? "").replace(/\/$/, "");
const OWNER_TOKEN = opt("owner-token") ?? "";
const DATA = opt("data") ?? "";
const WORK = opt("work") ?? "";
const REPO = opt("repo") ?? process.cwd();

if (!["codex", "claude_code"].includes(RUNTIME) || !BASE || !OWNER_TOKEN || !DATA || !WORK) {
  console.error("REFUSED: runtime-session.mjs <codex|claude_code> --base-url URL --owner-token T --data DIR --work DIR");
  process.exit(EXIT_REFUSED);
}

const BINARY = RUNTIME === "codex" ? "codex" : "claude";

let failures = 0;
function ok(cond, what, detail = "") {
  if (cond) console.log(`PASS  ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}
function refuse(why) {
  console.error(`REFUSED: ${why}`);
  console.error("A gate that cannot reach a real runtime refuses. It never falls back to a simulation.");
  process.exit(EXIT_REFUSED);
}

// A RUNTIME SESSION TAKES MINUTES, AND A POOLED CONNECTION DOES NOT.
//
// `fetch` keeps connections alive per origin. A `codex exec` session runs for
// long enough that the registry closes the idle socket underneath the pool, and
// the next call fails with `UND_ERR_SOCKET: other side closed` before it ever
// reaches the server — which reads as a dead registry and is not one. One retry
// on a TRANSPORT failure only: an HTTP status, whatever it is, is an answer and
// is never retried.
async function fetchOnce(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    console.log(`[transport] retrying ${init.method} ${url} after ${String(e?.cause?.code ?? e?.message ?? e)}`);
    return await fetch(url, init);
  }
}

async function api(key, method, path, body) {
  const res = await fetchOnce(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function cli(argv, env = {}) {
  return spawnSync("node", [join(REPO, "bin/skillonomia.js"), ...argv], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------- the subject

const which = spawnSync("sh", ["-c", `command -v ${BINARY}`], { encoding: "utf8" });
if ((which.status ?? 1) !== 0 || !(which.stdout ?? "").trim()) {
  refuse(`the ${RUNTIME} binary (\`${BINARY}\`) is not on PATH — contract section 11 makes missing runtime access a blocker for Leo`);
}
console.log(`runtime binary: ${which.stdout.trim()}`);

// ------------------------------------------------------- 1. the owner's part
//
// Everything up to `activate` is what an OWNER does, through the surfaces P1,
// P2 and P3 shipped. No manifest, no package, no signature, no runtime config.

const SOURCE = [
  "# report the loadout marker",
  "",
  "Use this whenever you are asked to report the canonical revision receipt.",
  "",
  "## Purpose",
  "Report the canonical revision receipt of this skill.",
  "",
  "## Procedure",
  "1. Read the canonical revision receipt section of this file.",
  "2. Print that SKLN-RECEIPT line verbatim, on a line of its own.",
  "3. Say nothing else about it.",
  "",
  "## Inputs",
  "- the request to report the marker",
  "",
  "## Outputs",
  "- the SKLN-RECEIPT line, verbatim",
  "",
  "## Permissions",
  "- read this file",
  "",
  "## Dependencies",
  "- none",
  "",
  "## Failure modes",
  "- the file is unreadable",
].join("\n");

const captured = await api(OWNER_TOKEN, "POST", "/v1/captures", {
  kind: "workflow",
  text: SOURCE,
  idempotency_key: `gate-${RUNTIME}-cap`,
});
ok(captured.status === 201, "the owner captured a workflow", captured.text.slice(0, 200));
if (captured.status !== 201) process.exit(EXIT_FAIL);
const draftId = captured.json.draft.draft_id;
const revisionId = captured.json.draft.revision_id;

// The approval is a console act; the console session is opened the way the
// product opens one — a ticket minted with the owner key, exchanged for a
// session cookie.
const ticket = await api(OWNER_TOKEN, "POST", "/v1/console/tickets", {});
ok(ticket.status === 201, "a console ticket was minted", ticket.text.slice(0, 200));
const openedSession = await fetch(`${BASE}/v1/console/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ ticket: ticket.json.ticket }),
});
const sessionBody = await openedSession.json();
const cookie = /skln_console=([^;]+)/.exec(openedSession.headers.get("set-cookie") ?? "")?.[1] ?? "";
const csrf = sessionBody.csrf_token;
ok(openedSession.status === 201 && cookie.length > 0, "a console session was opened");

async function console_(method, path, body) {
  const res = await fetchOnce(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      cookie: `skln_console=${cookie}`,
      "x-skillonomia-console-csrf": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const approved = await console_("POST", `/v1/console/drafts/${draftId}/approve`, {
  revision_id: revisionId,
  idempotency_key: `gate-${RUNTIME}-app`,
});
ok(approved.status === 201, "the owner approved the revision", approved.text.slice(0, 200));

// The agent the capability is put at. A principal of this workspace, created
// through the shipped provisioning surface.
const agent = await api(OWNER_TOKEN, "POST", "/v1/principals", {
  name: `gate-agent-${RUNTIME}-${Date.now()}`,
  type: "agent",
  role: "member",
});
ok(agent.status === 201, "the fleet agent was provisioned", agent.text.slice(0, 200));
const agentId = agent.json.principal?.agent_id ?? agent.json.agent_id ?? agent.json.principal_id ?? agent.json.id;
ok(typeof agentId === "string" && agentId.length === 26, "the agent has a canonical id", JSON.stringify(agent.json).slice(0, 200));

const assigned = await console_("POST", "/v1/console/assignments", {
  agent_id: agentId,
  revision_id: revisionId,
  idempotency_key: `gate-${RUNTIME}-asg`,
});
ok(assigned.status === 201, "the owner assigned the approved revision", assigned.text.slice(0, 300));
const assignmentId = assigned.json?.assignment?.assignment_id;
const activated = await console_("POST", `/v1/console/assignments/${assignmentId}/activate`, {
  idempotency_key: `gate-${RUNTIME}-act`,
});
ok(activated.status === 200, "the owner activated it", activated.text.slice(0, 200));
ok(activated.json?.effective_from === "next_session", "the command takes effect in the NEXT session (INV-07)");

if (failures > 0) process.exit(EXIT_FAIL);

// -------------------------------------------- 2. the adapter's own credential
//
// `INV-02`: the thing that REPORTS what a runtime did is not the thing that
// COMMANDS what it should do. The adapter gets its own principal, and the
// deployment registers it as an evidence principal — a file in the data
// directory that no owner-reachable surface writes.

const adapterPrincipal = await api(OWNER_TOKEN, "POST", "/v1/principals", {
  name: `gate-adapter-${RUNTIME}-${Date.now()}`,
  type: "service",
  role: "member",
});
ok(adapterPrincipal.status === 201, "the adapter principal was provisioned", adapterPrincipal.text.slice(0, 200));
const adapterAgentId =
  adapterPrincipal.json.principal?.agent_id ?? adapterPrincipal.json.agent_id ?? adapterPrincipal.json.principal_id ?? adapterPrincipal.json.id;
const adapterKey = adapterPrincipal.json.api_key ?? adapterPrincipal.json.principal?.api_key;
ok(typeof adapterKey === "string" && adapterKey.length > 0, "the adapter holds its own API key");

const principalsFile = join(DATA, "evidence-principals.json");
const registrations = existsSync(principalsFile) ? JSON.parse(readFileSync(principalsFile, "utf8")) : {};
registrations[adapterAgentId] = "adapter";
writeFileSync(principalsFile, JSON.stringify(registrations, null, 2), { mode: 0o600 });
console.log(`registered ${adapterAgentId} as an evidence principal of kind \`adapter\``);

// The refusal that makes the registration mean something: the OWNER's key,
// on the intake that writes observed state.
const ownerOpen = await api(OWNER_TOKEN, "POST", "/v1/sessions", {
  agent_id: agentId,
  runtime_kind: RUNTIME,
  runtime_version: "probe",
});
ok(ownerOpen.status === 403, "the OWNER's key cannot open a session (P4-FR-13, INV-02)", `got ${ownerOpen.status}`);

// ------------------------------------------------------ 3. the adapter's part

const materializeBase = join(WORK, "runtime-homes");
const transcripts = join(WORK, "transcripts");
mkdirSync(materializeBase, { recursive: true, mode: 0o700 });
mkdirSync(transcripts, { recursive: true, mode: 0o700 });

const opened = cli(
  [
    "adapter",
    "open",
    "--agent",
    agentId,
    "--runtime",
    RUNTIME,
    "--runtime-version",
    runtimeVersion(),
    "--base",
    materializeBase,
    "--base-url",
    BASE,
    "--key",
    adapterKey,
  ],
);
if ((opened.status ?? 1) !== 0) {
  console.error(opened.stdout);
  console.error(opened.stderr);
  ok(false, "`skillonomia adapter open` materialized the loadout");
  process.exit(EXIT_FAIL);
}
const session = JSON.parse(opened.stdout.trim().split("\n").pop());
ok(session.entries.length === 1, "the loadout has exactly the one active assignment");
const entry = session.entries[0];
console.log(`session ${session.session_id}  loadout ${session.loadout_id}`);
console.log(`entry   ${entry.skill_name}  revision ${entry.draft_revision_id}  digest ${entry.content_digest}`);
ok(entry.draft_revision_id === revisionId, "the loadout entry is the EXACT revision the owner approved");
ok(entry.load_receipt_id !== undefined, "a `loaded` receipt was filed after the read-back");

// The native file is where the runtime looks, and it is inside the session root.
const nativePath = join(materializeBase, session.session_id, entry.relpath);
ok(existsSync(nativePath), `the native entry file exists at ${entry.relpath}`);
const nativeText = readFileSync(nativePath, "utf8");
ok(nativeText.includes(entry.content_digest), "the native artifact states its own content digest");

// -------------------------------- 3b. the runtime's OWN credential, seeded
//
// A session-scoped runtime home is EMPTY, and an empty home is not logged in —
// BUILD-1's negative control was exactly this, and it is the correct default:
// the adapter materialises SKILLS and has no business minting, holding or
// copying a runtime's authentication. Somebody else does that, and here that
// somebody is the harness, from a file the OPERATOR named.
//
// The value is never read, printed or written anywhere but the session home,
// and the session home is outside the evidence package.
const AUTH_SOURCES = {
  codex: (process.env.SKLN_RUNTIME_AUTH_CODEX ?? "").split(":").filter(Boolean),
  claude_code: (process.env.SKLN_RUNTIME_AUTH_CLAUDE ?? "").split(":").filter(Boolean),
};
const authFiles = AUTH_SOURCES[RUNTIME];
if (authFiles.length === 0) {
  refuse(
    `no runtime credential was named for ${RUNTIME}. Set SKLN_RUNTIME_AUTH_${RUNTIME === "codex" ? "CODEX" : "CLAUDE"} ` +
      "to a colon-separated list of files to copy into the session home. A runtime home with no credential fails closed, " +
      "which is honest and is not a pass",
  );
}
for (const src of authFiles) {
  if (!existsSync(src)) refuse(`the named runtime credential file does not exist: ${src}`);
  copyFileSync(src, join(session.home, src.split("/").pop()));
}
console.log(`seeded ${authFiles.length} runtime credential file(s) into the session home (values never read)`);

// ----------------------------------------------- 4. the ACTUAL runtime session

const invoked = cli([
  "adapter",
  "invoke",
  "--session",
  session.session_id,
  "--skill",
  entry.skill_name,
  "--runtime",
  RUNTIME,
  "--home",
  session.home,
  "--workdir",
  WORK,
  "--transcripts",
  transcripts,
  "--base-url",
  BASE,
  "--key",
  adapterKey,
]);
if ((invoked.status ?? 1) !== 0) {
  console.error(invoked.stdout);
  console.error(invoked.stderr);
  ok(false, `an ACTUAL ${RUNTIME} session loaded and invoked the assigned skill (P4-FR-17/18)`);
  process.exit(EXIT_FAIL);
}
const run = JSON.parse(invoked.stdout.trim().split("\n").pop());
console.log(`runtime session ref: ${run.runtime_session_ref}`);
console.log(`echoed revision:     ${run.echoed_revision_id}`);
console.log(`echoed digest:       ${run.echoed_content_digest}`);
ok(true, `an ACTUAL ${RUNTIME} session loaded and invoked the assigned skill (P4-FR-17/18)`);

// `P4-FR-19`: the EXACT REVISION, not the name.
ok(run.echoed_revision_id === revisionId, "the runtime echoed the exact revision id the owner approved (P4-FR-19)");
ok(run.echoed_content_digest === entry.content_digest, "the runtime echoed the exact content digest the loadout froze (P4-FR-19)");
ok(run.observed_status === "invoked", "the observed state moved to `invoked` on that receipt");

// ------------------------------------------------------- 5. the stage chain

const view = await console_("GET", `/v1/console/sessions/${session.session_id}`);
ok(view.status === 200, "the owner can READ the session", view.text.slice(0, 200));
const shown = view.json.entries[0];
const stages = shown.chain.map((c) => c.stage);
console.log(`stage chain: ${stages.join(" -> ")}`);
ok(
  JSON.stringify(stages) === JSON.stringify(["proposed", "loaded", "invoked"]),
  "the chain is proposed -> loaded -> invoked, in order (P4-FR-09/10)",
  stages.join(","),
);
ok(
  shown.chain.every((c) => typeof c.at_ms === "number" && c.at_ms > 0 && typeof c.source === "string" && c.source.length > 0),
  "every stage carries a structured timestamp and a source (P4-FR-12)",
);
ok(shown.chain[0].receipt_id === null, "`proposed` names no runtime receipt: it is the backend's own act");
ok(
  shown.chain[1].receipt_id !== null && shown.chain[2].receipt_id !== null,
  "`loaded` and `invoked` each name the receipt behind them",
);
ok(
  view.json.receipts.every((r) => r.content_digest === entry.content_digest),
  "every receipt names the digest the loadout froze",
);

// ------------------------- 6. the negative control: a receipt withheld
//
// A SECOND session, materialized and never invoked. Its entry must be
// `unknown` with all four `INV-03` fields — never `loaded`, never a silent
// success (`P4-FR-11`).

const second = await api(adapterKey, "POST", "/v1/sessions", {
  agent_id: agentId,
  runtime_kind: RUNTIME,
  runtime_version: "withheld",
});
ok(second.status === 201, "a second session was opened", second.text.slice(0, 200));
const secondView = await console_("GET", `/v1/console/sessions/${second.json.session_id}`);
const withheld = secondView.json.entries[0];
ok(withheld.stage === "unknown", "with the receipt withheld the entry is `unknown` (P4-FR-11)", withheld.stage);
ok(withheld.reason_code === "NO_RUNTIME_RECEIPT", "the unknown carries a machine-readable reason code (INV-03)");
ok(typeof withheld.reason === "string" && withheld.reason.length > 20, "the unknown carries a reason (INV-03)");
ok(typeof withheld.source === "string" && withheld.source.length > 0, "the unknown carries a source (INV-03)");
ok(withheld.observed_at_ms > 0, "the unknown carries the time of the look (INV-03)");

// A receipt that names the right revision with the wrong digest is REFUSED —
// which is what makes the `invoked` above evidence about bytes rather than a
// name.
const forged = await api(adapterKey, "POST", `/v1/sessions/${second.json.session_id}/receipts`, {
  stage: "loaded",
  runtime_session_ref: "forged",
  revision_id: revisionId,
  content_digest: `sha256:${"0".repeat(64)}`,
});
ok(forged.status === 412, "a receipt with the wrong digest is refused (P4-FR-19)", `got ${forged.status}`);

// ------------------------------------- 7. no raw secret in artifact or log

const shapes = [
  /sk_[A-Za-z0-9_-]{16,}/,
  /bt_[A-Za-z0-9_-]{16,}/,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
function sweep(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 4 * 1024 * 1024) {
        const text = readFileSync(p, "utf8");
        for (const re of shapes) if (re.test(text)) hits.push(`${p}: <match suppressed>`);
      }
    }
  };
  walk(dir);
  return hits;
}
const skillsRoot = join(materializeBase, session.session_id, RUNTIME === "codex" ? ".agents" : ".claude", "skills");
const artifactHits = sweep(skillsRoot);
ok(artifactHits.length === 0, "no credential-shaped value in any native artifact (P4-FR-15)", artifactHits.join("; "));
// The claim is about the NATIVE ARTIFACTS the adapter wrote and the runtime
// transcript — not about the credential the operator seeded beside them, which
// is the runtime's own login and was never this system's to place.
console.log(`swept: ${skillsRoot} and ${transcripts}`);
const logHits = sweep(transcripts);
ok(logHits.length === 0, "no credential-shaped value in the runtime transcript (P4-FR-15)", logHits.join("; "));

// -------------------------------------- 8. the derived artifacts are derived

const cleaned = cli(["adapter", "cleanup", "--session", session.session_id, "--base", materializeBase]);
ok((cleaned.status ?? 1) === 0, "`skillonomia adapter cleanup` removed the derived artifacts", cleaned.stderr);
ok(!existsSync(join(materializeBase, session.session_id)), "the session's materialized directory is gone");
const afterCleanup = await console_("GET", `/v1/console/sessions/${session.session_id}`);
ok(afterCleanup.status === 200, "the canonical session still answers after cleanup (P4-FR-08)");
ok(
  afterCleanup.json.entries[0].stage === "invoked",
  "and it still reports the stage the runtime confirmed — deleting files destroys no canonical data",
);

function runtimeVersion() {
  const probe = spawnSync(BINARY, ["--version"], { encoding: "utf8" });
  const text = `${probe.stdout ?? ""} ${probe.stderr ?? ""}`;
  return (/([0-9]+\.[0-9]+\.[0-9]+)/.exec(text)?.[1] ?? "unknown").slice(0, 64);
}

console.log("");
if (failures === 0) {
  console.log(`PASS  the ${RUNTIME} runtime gate: ${stages.join(" -> ")} for revision ${revisionId} digest ${entry.content_digest}`);
  process.exit(EXIT_PASS);
}
console.log(`FAIL  ${failures} assertion(s) failed in the ${RUNTIME} runtime gate`);
process.exit(EXIT_FAIL);
