#!/usr/bin/env node
// `P0-FR-06` and contract section 9 — every run has a complete record, every
// execution artifact has a run, and every record names the session that really
// produced it under the model contract that session was required to run.
//
//   node --experimental-strip-types --no-warnings v1/tools/p0-evidence-check.ts <evidence/PHASE-dir>
//
// P0 REVIEW-1 finding `P0-R1-003`: evidence/P0/runs.jsonl held 11 records while
// evidence/P0/logs/ held 13 files. Three commands had therefore run with no record
// of who ran them, at which SHA, on which toolchain or with what exit code — and two
// of the three backed executions the builder had explicitly claimed. Nothing in the
// frozen format made that state detectable, because the format checked nothing.
//
// P0 REVIEW-2 finding `P0-R2-001`: all 21 FIX-1 records carried
// `session_id: "fix1-P0-0c453cad"` — a label the builder constructed out of its own
// role and task id, not the provider session that ran the commands. This checker
// accepted it, and accepted a FIX record declaring `codex` / `gpt-5.6-sol` /
// `low`: the exact combination contract section 7 forbids. An identifier a session
// can mint for itself proves nothing about isolation, and a validator that admits
// the forbidden model contract is worse than no validator, because it is cited.
//
// WHAT IS CHECKED
//
//   1. EVERY REQUIRED FIELD IS PRESENT. The list is the one contract section 9 gives, as
//      frozen in `v1/P0-EVIDENCE-FORMAT.md` section 1 — including `tool_versions` and an
//      output reference (`artifact` or `stdout_tail`), the two the first freeze
//      showed in its example and left out of its required list.
//   2. THE VALUES ARE OF THE RIGHT KIND. 40-hex SHAs, never an abbreviation and
//      never `HEAD`. `exit_code` a number. A `fail` or `skipped` verdict carrying
//      `notes`, because contract section 9 forbids hiding either.
//   3. THE IDENTIFIERS ARE REAL, AND THE MODEL CONTRACT IS THE ONE SECTION 7 FIXES.
//      `session_id` must have the shape a provider session id has — a canonical
//      UUID — and must not be a label built out of the record's own task id.
//      `role` decides `provider`, `model` and `reasoning_effort` exactly:
//      BUILD and FIX are claude / opus / high, REVIEW is codex / gpt-5.6-sol / high.
//      Nothing else passes, and the two aliases contract section 7.1 names —
//      `opus-5`, `claude-opus-5-high` — are refused by name so the message says
//      what the record did rather than only that a set did not contain a string.
//      One role holds one (task_id, session_id) pair and no two roles share
//      either: that pair IS the isolation contract section 7.3 requires, so a
//      phase whose FIX reuses its BUILD's session is a finding, not a formatting
//      slip.
//   4. ONE ARTIFACT, ONE RECORD. Every file under logs/ is named by exactly one
//      record, and every record naming a file under logs/ names one that exists.
//      Both directions, because either alone leaves a hole: checking only that
//      records resolve permits an unregistered log, which is exactly `P0-R1-003`.
//   5b. THE THREE RECORDS OF ONE SESSION AGREE. P3 REVIEW-1 finding `P3-R1-003`:
//      the same two build sessions were described three times and the three
//      disagreed — the session ledger left the second one `(pending)` under the
//      first one's role, `evidence/P3/03-session-record.md` named an INTERMEDIATE
//      commit as BUILD-1's output, and `runs.jsonl` named a third value. Every
//      artifact was individually well-formed, so this checker passed, exactly the
//      way each individual checker passed the class of defect `P2-R1-005` closed.
//      So the three are now compared against each other: the phase's rows in the
//      session ledger evidence/SESSIONS.md, each `*session-record*.md` in the
//      phase directory, and the unique role tuple each role holds in runs.jsonl
//      must state the same task id, provider session id, phase base, input SHA
//      and output SHA. A pending or placeholder value, a role bound to another
//      role's identifiers, and an output SHA that is not the one the runs
//      recorded are each a refusal.
//   5. NO `.log` PARKED OUTSIDE logs/, AND NO LEDGER PARKED BESIDE runs.jsonl. A
//      `.log` elsewhere under the phase directory must sit in a directory carrying a
//      README.md that says what it is. Any other `runs*.jsonl` is an ARCHIVED LEDGER:
//      it must carry a `<name>.README.md` sidecar saying why it is there, and every
//      record in it still faces rule 3. Without this pair of rules the checks above
//      are satisfiable by moving an inconvenient record one file sideways.
//
// ARCHIVED LEDGERS ARE EXEMPT FROM THE FIELD SCHEMA AND NEVER FROM IDENTITY.
// evidence/P0/runs-build1-superseded.jsonl holds P0 BUILD-1's records exactly as
// BUILD-1 wrote them, disclosed in logs-build1/README.md. Rewriting a preserved
// ledger so it satisfies a schema invented after it was written would destroy the
// one thing it is kept for — being what that session actually recorded. So the
// schema of section 1 is enforced on the phase's own ledger, and the identity rules,
// which were never a matter of schema version, are enforced everywhere.
//
// It does NOT verify that a recorded exit code is the one the command really
// returned — nothing local can, after the fact. That is what the artifact is for,
// and why an output reference is required rather than optional. It does not verify
// that a well-shaped session id is the session that ran: that is checked against
// the provider's own task ledger, once, when the record is written, and the
// authoritative values are written out in evidence/SESSIONS.md.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const REQUIRED = [
  "phase", "role", "task_id", "session_id", "provider", "model", "reasoning_effort",
  "phase_base_sha", "input_sha", "output_sha", "command", "cwd", "tool_versions",
  "exit_code", "timestamp_utc", "gate_verdict",
] as const;
/** Present in any record, archived ones included: who ran this, under what contract. */
const IDENTITY = ["role", "task_id", "session_id", "provider", "model", "reasoning_effort"] as const;
const VERDICTS = new Set(["pass", "fail", "skipped"]);
const SHA = /^[0-9a-f]{40}$/;
const SHA_FIELDS = ["phase_base_sha", "input_sha", "output_sha", "input_base_sha"] as const;

// --- the model contract, contract section 7 ----------------------------------
const ROLE_FORM = /^(BUILD|FIX|REVIEW)-\d+$/;
const ROLE_CONTRACT: Record<string, { provider: string; model: string; reasoning_effort: string }> = {
  BUILD: { provider: "claude", model: "opus", reasoning_effort: "high" },
  FIX: { provider: "claude", model: "opus", reasoning_effort: "high" },
  REVIEW: { provider: "codex", model: "gpt-5.6-sol", reasoning_effort: "high" },
};
/** Named in contract section 7.1 as forbidden, so refused by name rather than by absence. */
const FORBIDDEN_MODEL_ALIASES = new Set(["opus-5", "claude-opus-5-high"]);

// --- identifier shapes -------------------------------------------------------
// A provider session id is a canonical UUID: claude's are v4 (`794aa03d-a7c0-4f29-…`),
// codex's are v7 (`01a00b6f-dc48-7c31-…`). Both are 8-4-4-4-12 lowercase hex, which is
// the shape checked. A constructed label — `fix1-P0-0c453cad` — is not.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** A Ductor task id is 8 lowercase hex; a full UUID is accepted for the same value written long. */
const TASK_ID = /^[0-9a-f]{8}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const dirArg = process.argv[2];
if (!dirArg) {
  console.error(
    "REFUSED: pass the phase evidence directory, e.g. .../evidence/P0.\n" +
      "A completeness check with no subject reports success having read nothing.",
  );
  process.exit(2);
}
const DIR = resolve(dirArg);
if (!existsSync(DIR) || !statSync(DIR).isDirectory()) {
  console.error(`REFUSED: ${DIR} is not a directory.`);
  process.exit(2);
}
const RUNS = join(DIR, "runs.jsonl");
if (!existsSync(RUNS)) {
  console.error(`REFUSED: ${RUNS} is missing. A phase with artifacts and no run ledger is the state this check exists to catch.`);
  process.exit(2);
}
const PHASE = basename(DIR);
const LOGS = join(DIR, "logs");

/** Artifact paths are written workspace-relative (`evidence/P0/logs/x.log`). Resolve
 *  them against this phase directory so the ledger stays portable between machines. */
function resolveArtifact(a: string): string {
  if (isAbsolute(a)) return a;
  const prefix = `evidence/${PHASE}/`;
  return a.startsWith(prefix) ? join(DIR, a.slice(prefix.length)) : join(DIR, a);
}

const problems: string[] = [];
const claimedLogs = new Map<string, number[]>(); // basename -> record line numbers
/** role -> what the phase's own ledger says that role's session was. Rule 5b. */
const runTuples = new Map<string, { task_id: string; session_id: string; phase_base_sha: string; input_sha: string; output_sha: string; where: string }>();
/** role -> the (task_id, session_id) pairs seen for it, and where. */
const identities = new Map<string, Map<string, string[]>>();
let records = 0;
let archivedRecords = 0;

/** Rule 3. Applies to every record in every ledger, archived ledgers included. */
function checkIdentity(r: Record<string, unknown>, where: string): void {
  for (const f of IDENTITY) {
    if (r[f] === undefined || r[f] === null || r[f] === "") problems.push(`${where}: identity field "${f}" is missing or empty`);
  }
  const role = typeof r.role === "string" ? r.role : "";
  const taskId = typeof r.task_id === "string" ? r.task_id : "";
  const sessionId = typeof r.session_id === "string" ? r.session_id : "";

  // the model contract
  if (role && !ROLE_FORM.test(role)) {
    problems.push(`${where}: role "${role}" is not one of BUILD-<n>, FIX-<n>, REVIEW-<n>. Contract section 8 fixes the roles a phase has.`);
  } else if (role) {
    const kind = role.split("-")[0];
    const want = ROLE_CONTRACT[kind];
    if (typeof r.model === "string" && FORBIDDEN_MODEL_ALIASES.has(r.model)) {
      problems.push(`${where}: role contract: model "${r.model}" is an alias contract section 7.1 forbids by name. The model ID must be exactly "${want.model}".`);
    }
    for (const f of ["provider", "model", "reasoning_effort"] as const) {
      const got = r[f];
      if (typeof got === "string" && FORBIDDEN_MODEL_ALIASES.has(got)) continue; // already reported, above
      if (got !== want[f]) {
        problems.push(
          `${where}: role contract: role "${role}" requires ${f}="${want[f]}", the record declares "${String(got)}". ` +
            `Contract section 7 fixes BUILD and FIX at claude/opus/high and REVIEW at codex/gpt-5.6-sol/high; a session run under any other contract is a section 7 violation, not a typo.`,
        );
      }
    }
  }

  // the identifiers
  if (taskId && !TASK_ID.test(taskId)) {
    problems.push(`${where}: session identity: task_id "${taskId}" is not a Ductor task id (8 lowercase hex, or the same value as a UUID).`);
  }
  if (sessionId) {
    if (!UUID.test(sessionId)) {
      problems.push(
        `${where}: session identity: session_id "${sessionId}" is not a provider session id. ` +
          "A provider session id is a canonical UUID; this is a constructed label, and a label a session mints for itself proves nothing about the isolation contract section 7.3 requires.",
      );
    } else if (sessionId === NIL_UUID) {
      problems.push(`${where}: session identity: session_id is the nil UUID — a placeholder, not a session.`);
    } else if (taskId && sessionId.includes(taskId)) {
      problems.push(`${where}: session identity: session_id "${sessionId}" embeds its own task_id "${taskId}" — that is a label built from the record, not an identifier the provider issued.`);
    }
  }

  if (role) {
    const byPair = identities.get(role) ?? new Map<string, string[]>();
    const pair = `${taskId}/${sessionId}`;
    byPair.set(pair, [...(byPair.get(pair) ?? []), where]);
    identities.set(role, byPair);
  }
}

/** SHA-shaped fields must hold an exact SHA whenever they are present. */
function checkShaShapes(r: Record<string, unknown>, where: string): void {
  for (const f of SHA_FIELDS) {
    const v = r[f];
    if (typeof v === "string" && v !== "" && !SHA.test(v)) {
      problems.push(`${where}: "${f}" is "${v}" — an exact 40-hex SHA is required, never an abbreviation or a ref name`);
    }
  }
}

// --- the phase's own ledger ---------------------------------------------------
readFileSync(RUNS, "utf8").split("\n").forEach((line, i) => {
  const where = `line ${i + 1}`;
  if (!line.trim()) return;
  let r: Record<string, unknown>;
  try { r = JSON.parse(line); } catch (e) { problems.push(`${where}: not valid JSON — ${(e as Error).message}`); return; }
  records++;

  for (const f of REQUIRED) {
    if (r[f] === undefined || r[f] === null || r[f] === "") problems.push(`${where}: required field "${f}" is missing or empty`);
  }
  // `input_base_sha` named one field for two different SHAs — the phase base and the
  // SHA the session actually started from. REVIEW-2 found every FIX-1 record naming
  // the phase base while FIX-1 had in fact started from BUILD-1's commit. Both values
  // are now their own required field, and the ambiguous one is refused rather than
  // ignored, so a record carrying it is unmigrated rather than quietly half-read.
  if (r.input_base_sha !== undefined) {
    problems.push(
      `${where}: "input_base_sha" was split into "phase_base_sha" (the base the phase branched from) and ` +
        '"input_sha" (the SHA this session started from). A record still carrying the old ambiguous field has not been migrated.',
    );
  }
  const tv = r.tool_versions;
  if (tv !== undefined && (typeof tv !== "object" || Array.isArray(tv) || Object.keys(tv as object).length === 0)) {
    problems.push(`${where}: "tool_versions" must be a non-empty object`);
  }
  const artifact = typeof r.artifact === "string" ? r.artifact : "";
  const tail = typeof r.stdout_tail === "string" ? r.stdout_tail.trim() : "";
  if (!artifact && !tail) {
    problems.push(`${where}: no output reference — contract section 9 requires sanitised stdout/stderr or a path to an artifact`);
  }
  if (artifact) {
    const p = resolveArtifact(artifact);
    if (!existsSync(p)) problems.push(`${where}: artifact "${artifact}" does not resolve (looked at ${p})`);
    else if (resolve(p).startsWith(resolve(LOGS) + "/")) {
      const b = relative(LOGS, resolve(p));
      claimedLogs.set(b, [...(claimedLogs.get(b) ?? []), i + 1]);
    }
  }
  checkShaShapes(r, where);
  checkIdentity(r, where);
  if (typeof r.role === "string" && r.role) {
    const tuple = {
      task_id: String(r.task_id ?? ""),
      session_id: String(r.session_id ?? ""),
      phase_base_sha: String(r.phase_base_sha ?? ""),
      input_sha: String(r.input_sha ?? ""),
      output_sha: String(r.output_sha ?? ""),
      where,
    };
    const seen = runTuples.get(r.role);
    if (!seen) runTuples.set(r.role, tuple);
    else {
      for (const f of ["phase_base_sha", "input_sha", "output_sha"] as const) {
        if (seen[f] !== tuple[f]) {
          problems.push(
            `${where}: role "${r.role}" records ${f}="${tuple[f]}" while ${seen.where} records "${seen[f]}". ` +
              "One session has one input and one output; two values for either is a ledger describing two different runs under one role.",
          );
        }
      }
    }
  }
  if (typeof r.exit_code !== "number") problems.push(`${where}: "exit_code" must be a number, not ${typeof r.exit_code}`);
  const v = r.gate_verdict;
  if (typeof v === "string" && !VERDICTS.has(v)) problems.push(`${where}: gate_verdict "${v}" is outside {pass, fail, skipped}`);
  if ((v === "fail" || v === "skipped") && !(typeof r.notes === "string" && r.notes.trim())) {
    problems.push(`${where}: gate_verdict "${v}" with no "notes". Contract section 9 forbids a silent skip or failure.`);
  }
});

// --- archived ledgers ---------------------------------------------------------
const archived: string[] = [];
function findArchivedLedgers(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { findArchivedLedgers(p); continue; }
    if (!/^runs.*\.jsonl$/.test(e.name)) continue;
    if (resolve(p) === resolve(RUNS)) continue;
    archived.push(p);
  }
}
findArchivedLedgers(DIR);

for (const p of archived) {
  const rel = relative(DIR, p);
  if (!existsSync(`${p}.README.md`)) {
    problems.push(
      `${rel}: an archived ledger with no "${basename(p)}.README.md" beside it. ` +
        "A second ledger must say why it exists, or the one-ledger-per-phase rule is satisfiable by renaming a file.",
    );
  }
  readFileSync(p, "utf8").split("\n").forEach((line, i) => {
    const where = `${rel} line ${i + 1}`;
    if (!line.trim()) return;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line); } catch (e) { problems.push(`${where}: not valid JSON — ${(e as Error).message}`); return; }
    archivedRecords++;
    checkIdentity(r, where);
    checkShaShapes(r, where);
    if (r.exit_code !== undefined && typeof r.exit_code !== "number") problems.push(`${where}: "exit_code" must be a number, not ${typeof r.exit_code}`);
    const v = r.gate_verdict;
    if (typeof v === "string" && !VERDICTS.has(v)) problems.push(`${where}: gate_verdict "${v}" is outside {pass, fail, skipped}`);
  });
}

// --- one role, one session ----------------------------------------------------
const pairOwners = new Map<string, string[]>(); // task_id or session_id -> roles
for (const [role, byPair] of identities) {
  if (byPair.size > 1) {
    const shown = [...byPair.entries()].map(([pair, wheres]) => `${pair} (${wheres[0]}${wheres.length > 1 ? ` +${wheres.length - 1} more` : ""})`);
    problems.push(
      `session identity: role "${role}" appears under ${byPair.size} different (task_id, session_id) pairs: ${shown.join("; ")}. ` +
        "Contract section 7.3 gives each session one task id and one session id.",
    );
  }
  for (const pair of byPair.keys()) {
    for (const id of pair.split("/")) {
      if (!id) continue;
      pairOwners.set(id, [...new Set([...(pairOwners.get(id) ?? []), role])]);
    }
  }
}
for (const [id, roles] of pairOwners) {
  if (roles.length > 1) {
    problems.push(
      `session identity: "${id}" is shared by roles ${roles.join(", ")}. ` +
        "Contract section 7.3 forbids continuing a BUILD, FIX or REVIEW in another role's session — separate ids are how that is checked.",
    );
  }
}

// --- one artifact, one record ------------------------------------------------
let logFiles: string[] = [];
if (existsSync(LOGS)) logFiles = readdirSync(LOGS).filter((f) => statSync(join(LOGS, f)).isFile());
for (const f of logFiles) {
  const claims = claimedLogs.get(f);
  if (!claims) problems.push(`logs/${f}: no run record names this artifact — a command ran and left no record of who ran it, at which SHA, or what it returned`);
  else if (claims.length > 1) problems.push(`logs/${f}: named by ${claims.length} records (lines ${claims.join(", ")}). One artifact is the output of one run.`);
}
for (const [f, claims] of claimedLogs) {
  if (!logFiles.includes(f)) problems.push(`logs/${f}: named by record line(s) ${claims.join(", ")} but not present`);
}

// --- no .log parked outside logs/ --------------------------------------------
function stray(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (p !== LOGS) stray(p); continue; }
    if (!e.name.endsWith(".log")) continue;
    if (dir === LOGS) continue;
    if (!existsSync(join(dir, "README.md"))) {
      problems.push(`${relative(DIR, p)}: a .log outside logs/ whose directory carries no README.md saying what it is`);
    }
  }
}
stray(DIR);


// --- 5b. the session ledger, the session records and the runs agree ----------
//
// The close of P3 REVIEW-1 finding `P3-R1-003`. Three files describe the same
// session; until now nothing compared them, so the package could carry a
// `(pending)` identity, a role label the runs contradicted and an output SHA
// naming an intermediate commit, and still be certified.
const LEDGER = process.env.SKLN_SESSION_LEDGER
  ? resolve(process.env.SKLN_SESSION_LEDGER)
  : join(DIR, "..", "SESSIONS.md");

/** `(pending)`, `TBD`, `—`: a value that was going to be filled in. */
const PLACEHOLDER = /^\(?\s*(pending|tbd|todo|to be recorded|unknown|n\/?a|-{1,2}|—|\?)\s*\)?$/i;
/** The provider did not expose it. Permitted for a REVIEW row and nowhere else. */
const NOT_RECORDED = "(not recorded)";

interface LedgerRow {
  phase: string; role: string; task_id: string; session_id: string;
  provider: string; model: string; reasoning: string;
  phase_base_sha: string; input_sha: string; output_sha: string;
  where: string;
}

const cell = (v: string): string => v.replace(/`/g, "").trim();
const sha40 = (v: string): string => (/([0-9a-f]{40})/.exec(v)?.[1] ?? "");
const kind = (role: string): string => role.split("-")[0] ?? "";

const ledgerRows: LedgerRow[] = [];
if (!existsSync(LEDGER)) {
  problems.push(
    `session ledger: ${LEDGER} is missing. v1/P0-EVIDENCE-FORMAT.md section 2 makes it the authoritative record of ` +
      "provider session identities; a phase package whose ledger is absent cannot be cross-checked against anything.",
  );
} else {
  readFileSync(LEDGER, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim().startsWith("|")) return;
    const c = line.split("|").slice(1, -1).map(cell);
    if (c.length < 10) return;
    if (!/^P\d$/.test(c[0]!)) return; // the header and the separator
    if (c[0] !== PHASE) return;
    ledgerRows.push({
      phase: c[0]!, role: c[1]!, task_id: c[2]!, session_id: c[3]!, provider: c[4]!,
      model: c[5]!, reasoning: c[6]!, phase_base_sha: c[7]!, input_sha: c[8]!, output_sha: c[9]!,
      where: `SESSIONS.md line ${i + 1}`,
    });
  });
  if (ledgerRows.length === 0) {
    problems.push(`session ledger: ${LEDGER} carries no row for phase ${PHASE}. A phase with runs and no ledger row has no recorded session.`);
  }
}

for (const row of ledgerRows) {
  const isReview = kind(row.role) === "REVIEW";
  if (!ROLE_FORM.test(row.role)) {
    problems.push(`${row.where}: role "${row.role}" is not one of BUILD-<n>, FIX-<n>, REVIEW-<n>.`);
    continue;
  }
  const want = ROLE_CONTRACT[kind(row.role)]!;
  for (const [field, got] of [["provider", row.provider], ["model", row.model], ["reasoning_effort", row.reasoning]] as const) {
    if (got !== want[field as "provider" | "model" | "reasoning_effort"]) {
      problems.push(`${row.where}: role contract: role "${row.role}" requires ${field}="${want[field as "provider"]}", the ledger says "${got}".`);
    }
  }
  for (const [field, got] of [["task_id", row.task_id], ["session_id", row.session_id], ["phase base SHA", row.phase_base_sha], ["input SHA", row.input_sha], ["output SHA", row.output_sha]] as const) {
    if (PLACEHOLDER.test(got)) {
      problems.push(
        `${row.where}: ${row.role}'s ${field} is "${got}" — a pending value in the authoritative ledger. ` +
          "Contract sections 7.3 and 9 require the real identifiers and the real SHAs of every session to be preserved, and a placeholder is the value that never gets corrected.",
      );
    }
  }
  if (!isReview) {
    if (row.session_id === NOT_RECORDED || !UUID.test(row.session_id)) {
      problems.push(`${row.where}: ${row.role}'s session_id is "${row.session_id}" — a BUILD or FIX session of this contract ran under a provider session whose id is a canonical UUID.`);
    }
    if (!TASK_ID.test(row.task_id)) problems.push(`${row.where}: ${row.role}'s task_id "${row.task_id}" is not a Ductor task id.`);
    for (const [field, got] of [["phase base SHA", row.phase_base_sha], ["input SHA", row.input_sha], ["output SHA", row.output_sha]] as const) {
      if (!sha40(got)) problems.push(`${row.where}: ${row.role}'s ${field} is "${got}" — an exact 40-hex SHA is required of a BUILD or FIX row.`);
    }
  }
}

const ledgerOf = (role: string): LedgerRow | undefined => ledgerRows.find((r) => r.role === role);

// the runs and the ledger
for (const [role, tuple] of runTuples) {
  const row = ledgerOf(role);
  if (!row) {
    problems.push(
      `session ledger: role "${role}" ran ${tuple.where === "" ? "" : ""}in this phase and has no row in ${basename(LEDGER)} for ${PHASE}. ` +
        "The ledger is the authoritative list of this contract's sessions; a session that produced records and appears in no row is unrecorded.",
    );
    continue;
  }
  for (const [field, fromRun, fromLedger] of [
    ["task_id", tuple.task_id, row.task_id],
    ["session_id", tuple.session_id, row.session_id],
    ["phase base SHA", tuple.phase_base_sha, sha40(row.phase_base_sha)],
    ["input SHA", tuple.input_sha, sha40(row.input_sha)],
    ["output SHA", tuple.output_sha, sha40(row.output_sha)],
  ] as const) {
    if (fromLedger !== fromRun) {
      problems.push(
        `session ledger: role "${role}": runs.jsonl records ${field}="${fromRun}" (${tuple.where}) and ${row.where} says "${fromLedger}". ` +
          "The two must be the same fact; a package that disagrees with itself cannot support its own audit claim.",
      );
    }
  }
}

// the session records
const recordFiles = readdirSync(DIR).filter((f) => /session-record.*\.md$/i.test(f)).sort();
for (const file of recordFiles) {
  const text = readFileSync(join(DIR, file), "utf8");
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const c = line.split("|").slice(1, -1).map(cell);
    if (c.length !== 2) continue;
    fields.set(c[0]!.toLowerCase(), c[1]!);
  }
  const declared = fields.get("phase / role") ?? "";
  const roleMatch = /(BUILD|FIX|REVIEW)-\d+/.exec(declared) ?? /(BUILD|FIX|REVIEW)-\d+/.exec(text.split("\n")[0] ?? "");
  if (!roleMatch) {
    problems.push(`${file}: this session record names no role. A record of a session that does not say which session it is cannot be checked against anything.`);
    continue;
  }
  const role = roleMatch[0];
  const row = ledgerOf(role);
  if (!row) {
    problems.push(`${file}: role "${role}" has no row for ${PHASE} in ${basename(LEDGER)}.`);
    continue;
  }
  const run = runTuples.get(role);
  const compare: Array<[string, string | undefined, string]> = [
    ["task_id", fields.get("task_id"), row.task_id],
    ["session_id", fields.get("session_id"), row.session_id],
    ["phase base SHA", fields.get("phase base sha"), sha40(row.phase_base_sha)],
    ["input SHA", fields.get("input sha"), sha40(row.input_sha)],
    ["output SHA", fields.get("output sha"), sha40(row.output_sha)],
  ];
  for (const [field, raw, expected] of compare) {
    if (raw === undefined) continue; // a record that does not restate a value cannot contradict it
    const got = cell(raw);
    if (PLACEHOLDER.test(got)) {
      problems.push(`${file}: ${role}'s ${field} is "${got}" — a pending value in a session record.`);
      continue;
    }
    const deferred = /SESSIONS\.md|see the marker/i.test(got);
    if (deferred) {
      if (field === "output SHA" || field === "input SHA" || field === "phase base SHA") {
        problems.push(
          `${file}: ${role}'s ${field} defers instead of naming a SHA ("${got}"). ` +
            "A record that will not state the commit it produced is the state finding `P3-R1-003` found this package in.",
        );
      }
      continue;
    }
    const wantSha = field.endsWith("SHA");
    const value = wantSha ? sha40(got) : got;
    if (wantSha && !value) {
      problems.push(`${file}: ${role}'s ${field} is "${got}" — an exact 40-hex SHA is required.`);
      continue;
    }
    if (value !== expected) {
      problems.push(
        `${file}: ${role}'s ${field} is "${value}", while ${row.where} says "${expected}". ` +
          "The session ledger is authoritative; a per-session record that names a different value is stale or belongs to another session.",
      );
    }
    if (run && field === "output SHA" && value !== run.output_sha) {
      problems.push(`${file}: ${role}'s output SHA "${value}" is not the output SHA runs.jsonl records for that role ("${run.output_sha}").`);
    }
  }
}

console.log(`phase directory: ${DIR}`);
console.log(`run records:     ${records}`);
console.log(`archived ledgers: ${archived.length}${archived.length ? ` (${archived.map((p) => relative(DIR, p)).join(", ")}), ${archivedRecords} record(s)` : ""}`);
console.log(`files in logs/:  ${logFiles.length}`);
console.log(`records naming a logs/ artifact: ${[...claimedLogs.values()].reduce((a, b) => a + b.length, 0)}`);
console.log(`roles with a distinct (task_id, session_id): ${identities.size}`);
console.log(`session ledger:  ${LEDGER}`);
console.log(`ledger rows for ${PHASE}: ${ledgerRows.length}; session records cross-checked: ${recordFiles.length} (${recordFiles.join(", ") || "none"})`);

if (problems.length) {
  console.error(`\nFAIL  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  "\nPASS  every run record is complete, every identifier is a real session under the model contract of section 7, " +
    "every execution artifact under logs/ has exactly one record, and the session ledger, the session records and the run ledger state the same sessions",
);
