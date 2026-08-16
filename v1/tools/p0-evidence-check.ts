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

console.log(`phase directory: ${DIR}`);
console.log(`run records:     ${records}`);
console.log(`archived ledgers: ${archived.length}${archived.length ? ` (${archived.map((p) => relative(DIR, p)).join(", ")}), ${archivedRecords} record(s)` : ""}`);
console.log(`files in logs/:  ${logFiles.length}`);
console.log(`records naming a logs/ artifact: ${[...claimedLogs.values()].reduce((a, b) => a + b.length, 0)}`);
console.log(`roles with a distinct (task_id, session_id): ${identities.size}`);

if (problems.length) {
  console.error(`\nFAIL  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nPASS  every run record is complete, every identifier is a real session under the model contract of section 7, and every execution artifact under logs/ has exactly one record");
