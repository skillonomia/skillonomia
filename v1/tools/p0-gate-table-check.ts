#!/usr/bin/env node
// `P0-FR-04` — every mandatory gate is PRESENT, and is a RUNNABLE COMMAND or a
// justified N/A.
//
//   node --experimental-strip-types --no-warnings v1/tools/p0-gate-table-check.ts [table.md]
//
// The optional argument names the document to read, so the negative probes in
// `v1/tools/p0-negative-probes.sh` can point this at a deliberately damaged copy of
// the table and watch it refuse. Commands are still resolved against THIS tree.
//
// P0 REVIEW-1 finding `P0-R1-002`: the frozen gate table named its phase-specific
// gates — reversible migration, security regression, browser E2E, actual Codex
// session, actual Claude Code session, dogfood metrics, clean-room owner journey —
// as descriptive labels with no command and no harness behind them. Contract section 9
// requires a real command or a justified minimal deterministic harness, and allows
// `N/A` only for a genuinely absent surface with a concrete reason. Prose is neither.
//
// So this reads the table in `v1/P0-EVIDENCE-FORMAT.md` section 3 and refuses on:
//
//   * a row with no command;
//   * a command that does not RESOLVE — see below for what that means;
//   * a cell holding anything outside the fixed vocabulary;
//   * a row carrying `—` or `cond` with no justification, or with a justification
//     that does not name every phase it applies to.
//
// WHAT "RESOLVES" MEANS, AND WHY IT IS NOT `which`. A gate command is checked for
// the parts of it this repository can actually be asked about:
//
//   * the executable — the first token after any `VAR=value` prefixes — must either
//     be a program on PATH or a path in this tree;
//   * `npm run X` / `bun run X` must name a script that exists in package.json;
//   * every repo-relative path the command names (`.sh`, `.ts`, `.mjs`, `.js`) must
//     exist, and a `.sh` must be executable.
//
// It does NOT run the commands. Running them is what the phase does; this asks
// whether there is anything to run at all. That is a narrower claim than "the gate
// works", and stating the narrower claim is the point — a checker that implied the
// wider one would be the same defect in a new place.
//
// P0 REVIEW-2, non-blocking backlog: everything above validates the rows that ARE
// there and nothing about the rows that should be. REVIEW-2 deleted the security
// regression row from a copy of the table and this checker reported 24/24 commands
// resolving and exited 0 — a gate table that loses a mandatory category passes,
// which makes the check an argument for whatever the table happens to say.
//
// So the set below is PINNED. It is the frozen table as P0 leaves it: every gate
// contract section 9 names as a mandatory category, and the phases in which each
// must carry `✓` rather than `—` or `cond`. A later phase may ADD rows and may
// upgrade a `—` to a `✓`. It may not delete a pinned row, rename one, or downgrade
// a pinned `✓` — any of those fails here, and the only way to change the pinned set
// is to edit this file, which is a tracked, reviewable, deliberate act rather than a
// row quietly going missing from a document.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = process.argv[2] ? resolve(process.argv[2]) : join(REPO, "v1", "P0-EVIDENCE-FORMAT.md");
const PHASES = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"] as const;
const CELLS = new Set(["✓", "—", "cond"]);

/** The pinned mandatory set: gate name exactly as the table's first column writes it,
 *  and the phases whose cell must be `✓`. Sources, per contract section 9's list of
 *  mandatory categories:
 *
 *   * tests, typecheck and build — every phase, so nothing regresses unobserved;
 *   * schema/migration checks — "for schema-changing phases": the disposable-DB check
 *     runs everywhere, the reversible round trip is required from P1 (the first schema
 *     change) onward, and P2 stays `cond` on its own diff;
 *   * security regressions and Registry backwards-compatibility — every phase;
 *   * browser E2E — the Console phases: P2 builds it, P3 drives 409/412 reconciliation
 *     through it, P5 drives the outcome and rollback views, P6 walks it clean-room;
 *   * actual Codex and Claude Code runtime — P4, P5, P6, where contract section 9 states
 *     outright that mocked adapters do not substitute;
 *   * final clean-room journey and dogfood validation — P6;
 *   * the evidence machinery itself — traceability, record completeness, this table,
 *     append-only history and the secret sweep — every phase, since each is what makes
 *     the others' results readable as evidence rather than as claims.
 */
const ALL = [...PHASES];
const REQUIRED_GATES: Array<{ gate: string; ticked: string[] }> = [
  { gate: "install, npm toolchain", ticked: ALL },
  { gate: "install, Bun toolchain", ticked: ALL },
  { gate: "typecheck", ticked: ALL },
  { gate: "unit and integration suite, Node", ticked: ALL },
  { gate: "unit and integration suite, Bun", ticked: ALL },
  { gate: "build, JS entry point", ticked: ALL },
  { gate: "build, single-file binary", ticked: ALL },
  { gate: "migration / schema on a disposable DB", ticked: ALL },
  { gate: "reversible migration round trip", ticked: ["P1", "P3", "P4", "P5", "P6"] },
  { gate: "Registry API / CLI / MCP contract smoke", ticked: ALL },
  { gate: "Registry backwards-compatibility suite", ticked: ALL },
  { gate: "security regression on the threat-model surface", ticked: ALL },
  { gate: "secret-absence sweep of evidence", ticked: ALL },
  { gate: "traceability completeness", ticked: ALL },
  { gate: "evidence-record completeness", ticked: ALL },
  { gate: "gate-table validity", ticked: ALL },
  { gate: "append-only branch history", ticked: ALL },
  { gate: "browser E2E", ticked: ["P2", "P3", "P5", "P6"] },
  { gate: "actual Codex runtime session", ticked: ["P4", "P5", "P6"] },
  { gate: "actual Claude Code runtime session", ticked: ["P4", "P5", "P6"] },
  { gate: "upgrade from a `v0.1.6` copy", ticked: ["P1", "P6"] },
  { gate: "containerised quickstart", ticked: ["P6"] },
  { gate: "high-risk exercise", ticked: ["P6"] },
  { gate: "dogfood ledger metrics", ticked: ["P6"] },
  { gate: "clean-room owner journey", ticked: ["P6"] },
];

if (!existsSync(DOC)) {
  console.error(`REFUSED: ${DOC} is missing. A table check with no table has checked nothing.`);
  process.exit(2);
}
const text = readFileSync(DOC, "utf8");

// ---------------------------------------------------------------------------
// the table
const rows: Array<{ gate: string; command: string; cells: string[] }> = [];
let header = false;
for (const line of text.split("\n")) {
  const t = line.trim();
  if (!t.startsWith("|")) {
    if (header && rows.length) break; // the table ended
    continue;
  }
  const cols = t.slice(1, t.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
  if (cols[0] === "gate" && cols[1] === "command") { header = true; continue; }
  if (!header) continue;
  if (cols.every((c) => /^-+$/.test(c))) continue; // the --- separator
  if (cols.length !== 2 + PHASES.length) continue;
  rows.push({ gate: cols[0], command: cols[1], cells: cols.slice(2) });
}

if (rows.length === 0) {
  console.error("REFUSED: no gate table was parsed out of v1/P0-EVIDENCE-FORMAT.md section 3.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// the justifications: `* **<gate>** — <text naming phases>`
const justif = new Map<string, string>();
for (const m of text.matchAll(/^\*\s+\*\*(.+?)\*\*\s+—\s+([\s\S]*?)(?=\n\*\s+\*\*|\n##|\n$)/gm)) {
  justif.set(m[1].trim(), m[2].replace(/\s+/g, " ").trim());
}

const scripts: Record<string, string> = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts ?? {};

function onPath(bin: string): boolean {
  try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; } catch { return false; }
}

/** Why this command cannot be run, or null when it can. */
function unrunnable(command: string): string | null {
  const raw = command.replace(/^`|`$/g, "").trim();
  if (!raw) return "the cell is empty";
  // strip leading VAR=value assignments
  const tokens = raw.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (tokens.length === 0) return "the command is only environment assignments";
  const head = tokens[0];

  if (head.includes("/")) {
    const p = join(REPO, head);
    if (!existsSync(p)) return `the executable ${head} is not in the tree`;
    if (head.endsWith(".sh")) {
      try { accessSync(p, constants.X_OK); } catch { return `${head} is not executable`; }
    }
  } else if (!onPath(head)) {
    return `${head} is not a program on PATH and not a path in this tree`;
  }

  if ((head === "npm" || head === "bun") && tokens[1] === "run") {
    const name = tokens[2];
    if (!name) return `${head} run with no script name`;
    if (!(name in scripts)) return `package.json has no script "${name}"`;
  }
  if (head === "npm" && tokens[1] === "test" && !("test" in scripts)) return 'package.json has no script "test"';

  for (const tok of tokens.slice(1)) {
    if (!/^[A-Za-z0-9_./-]+\.(sh|ts|mjs|js)$/.test(tok)) continue;
    const p = join(REPO, tok);
    if (!existsSync(p) || !statSync(p).isFile()) return `the command names ${tok}, which is not a file in this tree`;
  }
  return null;
}

// ---------------------------------------------------------------------------
const problems: string[] = [];
let runnable = 0;
let naRows = 0;

for (const row of rows) {
  const why = unrunnable(row.command);
  if (why) problems.push(`gate "${row.gate}": ${why} (command: ${row.command})`);
  else runnable++;

  const bad = row.cells.filter((c) => !CELLS.has(c));
  if (bad.length) problems.push(`gate "${row.gate}": cell value(s) outside the vocabulary: ${bad.join(", ")}`);

  const excused = PHASES.filter((_, i) => row.cells[i] === "—" || row.cells[i] === "cond");
  if (excused.length === 0) continue;
  naRows++;

  const j = justif.get(row.gate);
  if (!j) {
    problems.push(
      `gate "${row.gate}": ${excused.length} phase(s) marked N/A or conditional (${excused.join(", ")}) with no justification. ` +
        "Contract section 9 allows N/A only with a concrete reason.",
    );
    continue;
  }
  const unnamed = excused.filter((p) => !new RegExp(`\\b${p}\\b`).test(j));
  if (unnamed.length) {
    problems.push(`gate "${row.gate}": the justification does not name ${unnamed.join(", ")}.`);
  }
  if (j.length < 80) {
    problems.push(`gate "${row.gate}": the justification is ${j.length} characters. A concrete reason is not a word.`);
  }
}

// ---------------------------------------------------------------------------
// the pinned mandatory set: present, and ticked where the contract requires it
const byGate = new Map(rows.map((r) => [r.gate, r]));
let pinnedPresent = 0;
for (const req of REQUIRED_GATES) {
  const row = byGate.get(req.gate);
  if (!row) {
    problems.push(
      `required gate "${req.gate}" is not in the table. Contract section 9 makes it a mandatory category; ` +
        "a row that stops being written stops being run, and nothing else in this check would notice.",
    );
    continue;
  }
  pinnedPresent++;
  const missing = req.ticked.filter((p) => row.cells[PHASES.indexOf(p as (typeof PHASES)[number])] !== "✓");
  if (missing.length) {
    problems.push(
      `required gate "${req.gate}": ${missing.join(", ")} must be "✓" and ${missing.length > 1 ? "are" : "is"} ` +
        `"${missing.map((p) => row.cells[PHASES.indexOf(p as (typeof PHASES)[number])] ?? "<no cell>").join('", "')}". ` +
        "A mandatory gate downgraded to N/A is a check removed, not a check excused.",
    );
  }
}

console.log(`document:            ${DOC}`);
console.log(`gate rows parsed:    ${rows.length}`);
console.log(`pinned mandatory gates present: ${pinnedPresent}/${REQUIRED_GATES.length}`);
console.log(`commands that resolve: ${runnable}/${rows.length}`);
console.log(`rows with an N/A or conditional cell: ${naRows}`);
console.log(`justification entries: ${justif.size}`);

if (problems.length) {
  console.error(`\nFAIL  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nPASS  every mandatory gate is present and ticked where the contract requires it, every row names a command that resolves, and every N/A or conditional cell is justified");
