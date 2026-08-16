#!/usr/bin/env node
// `P0-FR-06` and contract section 9 — every run has a complete record, and every
// execution artifact has a run.
//
//   node --experimental-strip-types --no-warnings v1/tools/p0-evidence-check.ts <evidence/PHASE-dir>
//
// P0 REVIEW-1 finding `P0-R1-003`: evidence/P0/runs.jsonl held 11 records while
// evidence/P0/logs/ held 13 files. Three commands had therefore run with no record
// of who ran them, at which SHA, on which toolchain or with what exit code — and two
// of the three backed executions the builder had explicitly claimed. Nothing in the
// frozen format made that state detectable, because the format checked nothing.
//
// WHAT IS CHECKED
//
//   1. EVERY REQUIRED FIELD IS PRESENT. The list is the one contract section 9 gives, as
//      frozen in `v1/P0-EVIDENCE-FORMAT.md` section 1 — including `tool_versions` and an
//      output reference (`artifact` or `stdout_tail`), the two the first freeze
//      showed in its example and left out of its required list.
//   2. THE VALUES ARE OF THE RIGHT KIND. 40-hex SHAs, never an abbreviation and
//      never `HEAD`. `model` exactly `opus` or `gpt-5.6-sol`, because contract section 7
//      makes an alias a contract violation rather than a formatting detail.
//      `exit_code` a number. A `fail` or `skipped` verdict carrying `notes`, because
//      contract section 9 forbids hiding either.
//   3. ONE ARTIFACT, ONE RECORD. Every file under logs/ is named by exactly one
//      record, and every record naming a file under logs/ names one that exists.
//      Both directions, because either alone leaves a hole: checking only that
//      records resolve permits an unregistered log, which is exactly the finding.
//   4. NO `.log` PARKED OUTSIDE logs/. A `.log` elsewhere under the phase directory
//      must sit in a directory carrying a README.md that says what it is. Without
//      this, rule 3 is satisfiable by moving an inconvenient artifact sideways.
//
// It does NOT verify that a recorded exit code is the one the command really
// returned — nothing local can, after the fact. That is what the artifact is for,
// and why an output reference is required rather than optional.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const REQUIRED = [
  "phase", "role", "task_id", "session_id", "provider", "model", "reasoning_effort",
  "input_base_sha", "output_sha", "command", "cwd", "tool_versions", "exit_code",
  "timestamp_utc", "gate_verdict",
] as const;
const MODELS = new Set(["opus", "gpt-5.6-sol"]);
const VERDICTS = new Set(["pass", "fail", "skipped"]);
const SHA = /^[0-9a-f]{40}$/;

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
let records = 0;

const lines = readFileSync(RUNS, "utf8").split("\n");
lines.forEach((line, i) => {
  const n = i + 1;
  if (!line.trim()) return;
  let r: Record<string, unknown>;
  try { r = JSON.parse(line); } catch (e) { problems.push(`line ${n}: not valid JSON — ${(e as Error).message}`); return; }
  records++;

  for (const f of REQUIRED) {
    if (r[f] === undefined || r[f] === null || r[f] === "") problems.push(`line ${n}: required field "${f}" is missing or empty`);
  }
  const tv = r.tool_versions;
  if (tv !== undefined && (typeof tv !== "object" || Array.isArray(tv) || Object.keys(tv as object).length === 0)) {
    problems.push(`line ${n}: "tool_versions" must be a non-empty object`);
  }
  const artifact = typeof r.artifact === "string" ? r.artifact : "";
  const tail = typeof r.stdout_tail === "string" ? r.stdout_tail.trim() : "";
  if (!artifact && !tail) {
    problems.push(`line ${n}: no output reference — contract section 9 requires sanitised stdout/stderr or a path to an artifact`);
  }
  if (artifact) {
    const p = resolveArtifact(artifact);
    if (!existsSync(p)) problems.push(`line ${n}: artifact "${artifact}" does not resolve (looked at ${p})`);
    else if (resolve(p).startsWith(resolve(LOGS) + "/")) {
      const b = relative(LOGS, resolve(p));
      claimedLogs.set(b, [...(claimedLogs.get(b) ?? []), n]);
    }
  }
  for (const f of ["input_base_sha", "output_sha"] as const) {
    const v = r[f];
    if (typeof v === "string" && !SHA.test(v)) problems.push(`line ${n}: "${f}" is "${v}" — an exact 40-hex SHA is required, never an abbreviation or a ref name`);
  }
  if (typeof r.model === "string" && !MODELS.has(r.model)) {
    problems.push(`line ${n}: model "${r.model}" is not one contract section 7 fixes (opus, gpt-5.6-sol). An alias is a contract violation.`);
  }
  if (typeof r.exit_code !== "number") problems.push(`line ${n}: "exit_code" must be a number, not ${typeof r.exit_code}`);
  const v = r.gate_verdict;
  if (typeof v === "string" && !VERDICTS.has(v)) problems.push(`line ${n}: gate_verdict "${v}" is outside {pass, fail, skipped}`);
  if ((v === "fail" || v === "skipped") && !(typeof r.notes === "string" && r.notes.trim())) {
    problems.push(`line ${n}: gate_verdict "${v}" with no "notes". Contract section 9 forbids a silent skip or failure.`);
  }
});

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
console.log(`files in logs/:  ${logFiles.length}`);
console.log(`records naming a logs/ artifact: ${[...claimedLogs.values()].reduce((a, b) => a + b.length, 0)}`);

if (problems.length) {
  console.error(`\nFAIL  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nPASS  every run record is complete and every execution artifact under logs/ has exactly one record");
