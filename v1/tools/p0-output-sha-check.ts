#!/usr/bin/env node
// A PHASE THAT CLOSES AT TWO DIFFERENT COMMITS HAS NOT CLOSED.
//
//   node --experimental-strip-types --no-warnings v1/tools/p0-output-sha-check.ts <evidence/PHASE-dir> [--repo <path>]
//
// WHY THIS EXISTS. Three times in this contract a phase's closure artifacts have
// described an EARLIER commit than the one handed to review. P2 REVIEW-1 finding
// `P2-R1-005` is the third: `01-refs-tags-and-base.txt` and `03-session-record.md`
// ended at `8450df72…` and listed six commits, while the gate summary and the run
// ledger named `2e6a6988…` and a seventh existed. Every one of those artifacts was
// individually well-formed. `p0-evidence-check.ts` passed, because a record with a
// 40-hex `output_sha` is a complete record whatever the hex says, and nothing
// compared one artifact against another.
//
// Regenerating the stale files closes the instance. It does not close the class:
// the next phase regenerates in a different order and the same hole reopens. So
// this is the check, and it is deliberately small.
//
// WHAT IT CHECKS
//
//   1. THE LEDGER DECLARES ONE OUTPUT SHA. `runs.jsonl`'s LAST record — the closing
//      run, which the frozen order makes `p0-evidence-check.ts` — carries the SHA
//      the phase closes at. That value is the phase's declared output.
//   2. EVERY TOP-LEVEL ARTIFACT DECLARES THE SAME ONE. Each `*.md` and `*.txt`
//      directly under the phase directory must carry exactly one line of the form
//
//          OUTPUT_SHA: <40 lowercase hex>
//
//      and it must equal (1). A marker is required rather than sniffed out of prose
//      because a checker that guessed which of the SHAs in a `git log` was the
//      output SHA would be guessing, and because a required marker cannot be
//      satisfied by an artifact that simply has nothing to say.
//   3. NO ARTIFACT MAY OPT OUT BY DROPPING ITS MARKER. Zero markers in a file is a
//      refusal, exactly like a wrong one. That is the rule that makes this hold
//      under the pressure that produced the finding — the pressure to make a check
//      pass at the end of a long session.
//   4. OPTIONALLY, THE DECLARED SHA IS THE REPOSITORY'S HEAD. `--repo <path>` turns
//      internal agreement into agreement with the tree. Without it this asserts only
//      that the package agrees with itself, which is the narrower claim and is
//      stated as such.
//
// WHAT IT DOES NOT CHECK. That the SHA is the right one to have closed at, that the
// artifacts describe what they claim to describe, or that a run really happened.
// Those are what `p0-evidence-check.ts`, `p0-append-only-check.sh` and the artifacts
// themselves are for. This answers one question: do the closure artifacts of this
// phase name the same commit?
//
// EXIT CODES
//   0  every artifact agrees
//   1  they do not — the finding, in whatever form it has taken this time
//   2  REFUSED — there is no subject to check
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const MARKER = /^[ \t]*(?:[-*>#]+[ \t]*)?OUTPUT_SHA:[ \t]*([0-9a-fA-F]+)[ \t]*$/gm;

const argv = process.argv.slice(2);
const dirArg = argv.find((a) => !a.startsWith("--")) ?? "";
const repoIdx = argv.indexOf("--repo");
const repoArg = repoIdx >= 0 ? argv[repoIdx + 1] : undefined;

function refuse(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

if (!dirArg) {
  refuse(
    "pass the phase evidence directory, e.g. .../evidence/P2.\n" +
      "An agreement check with no subject reports agreement having compared nothing.",
  );
}
const DIR = resolve(dirArg);
if (!existsSync(DIR) || !statSync(DIR).isDirectory()) refuse(`${DIR} is not a directory.`);
const RUNS = join(DIR, "runs.jsonl");
if (!existsSync(RUNS)) refuse(`${RUNS} is missing; the phase's declared output SHA is read from its last record.`);

const PHASE = basename(DIR);
const problems: string[] = [];

// --- 1. the declared output SHA ---------------------------------------------
const records = readFileSync(RUNS, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);
if (records.length === 0) refuse(`${RUNS} holds no records.`);

let last: Record<string, unknown>;
try {
  last = JSON.parse(records[records.length - 1]!) as Record<string, unknown>;
} catch (e) {
  refuse(`the last record of ${RUNS} is not JSON: ${String(e)}`);
}
const declared = last.output_sha;
if (typeof declared !== "string" || !SHA.test(declared)) {
  console.error(`FAIL  ${PHASE}: the closing run record carries output_sha=${JSON.stringify(declared)}, which is not a 40-hex SHA.`);
  process.exit(1);
}

// Every OTHER record's output_sha is reported too. A phase whose ledger holds two
// different output SHAs is not automatically wrong — a FIX session's directory
// legitimately holds the BUILD's runs as well — so this is a listing, and the
// artifacts are what must agree with the closing value.
const ledgerShas = new Set<string>();
for (const line of records) {
  try {
    const r = JSON.parse(line) as Record<string, unknown>;
    if (typeof r.output_sha === "string") ledgerShas.add(r.output_sha);
  } catch {
    /* p0-evidence-check.ts is what refuses an unparseable record */
  }
}

// --- 2 & 3. every top-level artifact declares it -----------------------------
const artifacts = readdirSync(DIR)
  .filter((name) => name.endsWith(".md") || name.endsWith(".txt"))
  .sort();
if (artifacts.length === 0) refuse(`${DIR} holds no .md or .txt artifact to compare.`);

const rows: Array<{ file: string; found: string[] }> = [];
for (const name of artifacts) {
  const text = readFileSync(join(DIR, name), "utf8");
  const found: string[] = [];
  for (const m of text.matchAll(MARKER)) found.push(m[1]!.toLowerCase());
  rows.push({ file: name, found });
  if (found.length === 0) {
    problems.push(`${name}: no OUTPUT_SHA marker. Every closure artifact must name the commit it describes.`);
    continue;
  }
  if (found.length > 1) {
    problems.push(`${name}: ${found.length} OUTPUT_SHA markers (${found.join(", ")}); exactly one is allowed.`);
    continue;
  }
  const got = found[0]!;
  if (!SHA.test(got)) {
    problems.push(`${name}: OUTPUT_SHA ${got} is not a 40-hex SHA.`);
    continue;
  }
  if (got !== declared) {
    problems.push(`${name}: OUTPUT_SHA ${got} disagrees with the ledger's closing output_sha ${declared}.`);
  }
}

// --- 4. optionally, agreement with the tree ----------------------------------
let head: string | null = null;
if (repoArg) {
  const repo = resolve(repoArg);
  try {
    head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) {
    refuse(`cannot read HEAD of ${repo}: ${String(e)}`);
  }
  if (head !== declared) {
    problems.push(`the repository at ${repo} is at ${head}, and this evidence package closes at ${declared}.`);
  }
}

// --- the report ---------------------------------------------------------------
console.log(`phase:            ${PHASE}`);
console.log(`directory:        ${DIR}`);
console.log(`declared output:  ${declared}   (last record of runs.jsonl)`);
console.log(`ledger output(s): ${[...ledgerShas].join(", ")}`);
if (head) console.log(`repository HEAD:  ${head}`);
console.log(`artifacts:        ${artifacts.length}`);
console.log();
for (const r of rows) {
  const mark = r.found.length === 1 && r.found[0] === declared ? "ok  " : "FAIL";
  console.log(`  ${mark}  ${r.file.padEnd(34)} ${r.found.length === 0 ? "(no marker)" : r.found.join(", ")}`);
}
console.log();

if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  console.error();
  console.error(
    `FAIL  ${problems.length} artifact disagreement(s) in ${PHASE}. ` +
      "An evidence package whose artifacts name different commits describes no single state of the tree.",
  );
  process.exit(1);
}
console.log(`PASS  every closure artifact in ${PHASE} names ${declared}${head ? ", and so does the repository" : ""}`);
