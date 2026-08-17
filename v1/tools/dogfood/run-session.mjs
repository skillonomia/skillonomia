// P6 DOGFOOD, STEP THREE — one REAL runtime session, and the skills it invokes.
//
//   node v1/tools/dogfood/run-session.mjs --base-url URL --state FILE
//        --agent NAME --runtime codex|claude_code --work DIR
//        --skills 01,02,03 [--close] [--label NAME]
//
// It drives the SHIPPED product: `skillonomia adapter open` freezes the loadout
// and materialises it into a session-scoped runtime home, `skillonomia adapter
// invoke` runs the real binary against that home once per named skill, and the
// receipt and the outcome are filed through the adapter's evidence principal.
// The binary is the real one; there is no simulation and no fallback to one.
//
// WHY IT INVOKES SEVERAL SKILLS IN ONE SESSION. A runtime session has a loadout,
// and the loadout of an agent with ten active assignments has ten entries. Real
// use of that session is calling more than one of them. Each call is a separate
// `codex exec` or `claude -p` run against the same frozen home, so each produces
// its own runtime session ref, its own invocation ref and its own receipt.
//
// IT ASSERTS NOTHING ABOUT COUNTS. The counts are `dogfood-metrics`'s job and it
// computes them from the receipts. This file's output is a record of what it
// ran, and every identifier in it came back from the registry.
//
// EXIT: 0 every named skill was invoked and its receipt filed; 1 one was not;
//       2 the harness could not reach its subject.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);
const BASE = (opt("base-url") ?? "").replace(/\/$/, "");
const STATE = opt("state") ?? "";
const AGENT = opt("agent") ?? "";
const RUNTIME = opt("runtime") ?? "";
const WORK = opt("work") ?? "";
const SKILLS = (opt("skills") ?? "").split(",").filter(Boolean);
const LABEL = opt("label") ?? `${AGENT}-${RUNTIME}`;
const REPO = opt("repo") ?? process.cwd();
if (!BASE || !STATE || !AGENT || !["codex", "claude_code"].includes(RUNTIME) || !WORK || SKILLS.length === 0) {
  console.error("usage: run-session.mjs --base-url URL --state FILE --agent NAME --runtime codex|claude_code --work DIR --skills 01,02");
  process.exit(2);
}

const BINARY = RUNTIME === "codex" ? "codex" : "claude";
const which = spawnSync("sh", ["-c", `command -v ${BINARY}`], { encoding: "utf8" });
if ((which.status ?? 1) !== 0 || !(which.stdout ?? "").trim()) {
  console.error(`REFUSED: the ${RUNTIME} binary (\`${BINARY}\`) is not on PATH.`);
  process.exit(2);
}

const state = JSON.parse(readFileSync(STATE, "utf8"));
const agentId = state.agents[AGENT]?.agent_id;
if (agentId === undefined) {
  console.error(`REFUSED: no agent \`${AGENT}\` in ${STATE}`);
  process.exit(2);
}
const adapterKey = state.adapter.api_key;

let failures = 0;
const ok = (cond, what, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures += 1;
};

function cli(argv) {
  return spawnSync("node", [join(REPO, "bin/skillonomia.js"), ...argv], {
    cwd: REPO,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}
function runtimeVersion() {
  const probe = spawnSync(BINARY, ["--version"], { encoding: "utf8" });
  return (/([0-9]+\.[0-9]+\.[0-9]+)/.exec(`${probe.stdout ?? ""} ${probe.stderr ?? ""}`)?.[1] ?? "unknown").slice(0, 64);
}

const homes = join(WORK, "runtime-homes");
const transcripts = join(WORK, "transcripts");
mkdirSync(homes, { recursive: true, mode: 0o700 });
mkdirSync(transcripts, { recursive: true, mode: 0o700 });

const opened = cli([
  "adapter", "open",
  "--agent", agentId,
  "--runtime", RUNTIME,
  "--runtime-version", runtimeVersion(),
  "--base", homes,
  "--base-url", BASE,
  "--key", adapterKey,
]);
if ((opened.status ?? 1) !== 0) {
  console.error(opened.stdout);
  console.error(opened.stderr);
  ok(false, "`skillonomia adapter open` froze the loadout");
  process.exit(1);
}
const session = JSON.parse(opened.stdout.trim().split("\n").pop());
console.log(`session ${session.session_id}  loadout ${session.loadout_id}  agent ${AGENT} (${agentId})  runtime ${RUNTIME}`);
console.log(`loadout entries: ${session.entries.length}`);
for (const e of session.entries) console.log(`  ${e.skill_name}  revision ${e.draft_revision_id}  digest ${e.content_digest}`);

// The runtime's own login, seeded from a file the OPERATOR named. The adapter
// materialises SKILLS; minting or copying a runtime credential was never its
// job, and the value is not read here either.
const authFiles = (RUNTIME === "codex"
  ? (process.env.SKLN_RUNTIME_AUTH_CODEX ?? `${process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`}/auth.json`)
  : (process.env.SKLN_RUNTIME_AUTH_CLAUDE ?? `${process.env.HOME}/.claude/.credentials.json`)
).split(":").filter(Boolean);
for (const src of authFiles) {
  if (!existsSync(src)) {
    console.error(`REFUSED: the named runtime credential file does not exist: ${src}`);
    process.exit(2);
  }
  copyFileSync(src, join(session.home, src.split("/").pop()));
}
console.log(`seeded ${authFiles.length} runtime credential file(s) into the session home (values never read)`);

// The skills are named by their SOURCE NUMBER on the command line and resolved
// against the loadout by revision id, because a skill name is a name and the
// thing that identifies a revision is its id.
const wanted = [];
for (const num of SKILLS) {
  const asg = state.assignments.find((a) => a.agent === AGENT && a.source === num);
  if (asg === undefined) {
    ok(false, `${num}: assigned to ${AGENT}`);
    continue;
  }
  const entry = session.entries.find((e) => e.draft_revision_id === asg.revision_id);
  if (entry === undefined) {
    ok(false, `${num}: in this session's loadout`, `revision ${asg.revision_id}`);
    continue;
  }
  wanted.push({ num, entry });
}
if (failures > 0) process.exit(1);

const invocations = [];
for (const { num, entry } of wanted) {
  const t0 = Date.now();
  const invoked = cli([
    "adapter", "invoke",
    "--session", session.session_id,
    "--skill", entry.skill_name,
    "--runtime", RUNTIME,
    "--home", session.home,
    "--workdir", WORK,
    "--transcripts", transcripts,
    "--base-url", BASE,
    "--key", adapterKey,
  ]);
  const ms = Date.now() - t0;
  if ((invoked.status ?? 1) !== 0) {
    console.error((invoked.stdout ?? "").slice(-2000));
    console.error((invoked.stderr ?? "").slice(-2000));
    ok(false, `${num} ${entry.skill_name}: a real ${RUNTIME} session invoked it`, `${ms}ms`);
    continue;
  }
  const run = JSON.parse(invoked.stdout.trim().split("\n").pop());
  ok(
    run.echoed_revision_id === entry.draft_revision_id && run.echoed_content_digest === entry.content_digest,
    `${num} ${entry.skill_name}: the runtime echoed the EXACT revision and digest (P4-FR-19)  [${ms}ms]`,
    `${run.echoed_revision_id} ${run.echoed_content_digest}`,
  );
  ok(run.observed_status === "invoked", `${num} ${entry.skill_name}: the observed stage moved to invoked`, run.observed_status);
  console.log(`      outcome ${run.outcome} (${run.outcome_id}) evidence ${run.outcome_evidence_class}`);
  invocations.push({
    source: num,
    skill_name: entry.skill_name,
    revision_id: run.echoed_revision_id,
    content_digest: run.echoed_content_digest,
    runtime_session_ref: run.runtime_session_ref,
    invocation_ref: run.invocation_ref,
    receipt_id: run.receipt_id,
    outcome: run.outcome,
    outcome_id: run.outcome_id,
    outcome_evidence_class: run.outcome_evidence_class,
    elapsed_ms: ms,
  });
}

if (has("close")) {
  const closed = cli(["adapter", "close", "--session", session.session_id, "--base-url", BASE, "--key", adapterKey]);
  ok((closed.status ?? 1) === 0, "`skillonomia adapter close` reported the session ended", closed.stderr);
}

const record = {
  label: LABEL,
  agent: AGENT,
  agent_id: agentId,
  runtime_kind: RUNTIME,
  runtime_version: runtimeVersion(),
  session_id: session.session_id,
  loadout_id: session.loadout_id,
  loadout_entries: session.entries.length,
  closed: has("close"),
  invocations,
};
const out = join(WORK, `session-${LABEL}-${session.session_id}.json`);
writeFileSync(out, JSON.stringify(record, null, 2));
console.log("");
console.log(JSON.stringify(record, null, 2));
console.log(`record: ${out}`);
process.exit(failures === 0 ? 0 : 1);
