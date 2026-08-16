#!/usr/bin/env node
// `P0-FR-04` — every mandatory gate is a RUNNABLE COMMAND or a justified N/A.
//
//   node --experimental-strip-types --no-warnings v1/tools/p0-gate-table-check.ts
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
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = join(REPO, "v1", "P0-EVIDENCE-FORMAT.md");
const PHASES = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"] as const;
const CELLS = new Set(["✓", "—", "cond"]);

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

console.log(`document:            ${DOC}`);
console.log(`gate rows parsed:    ${rows.length}`);
console.log(`commands that resolve: ${runnable}/${rows.length}`);
console.log(`rows with an N/A or conditional cell: ${naRows}`);
console.log(`justification entries: ${justif.size}`);

if (problems.length) {
  console.error(`\nFAIL  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nPASS  every gate row names a command that resolves, and every N/A or conditional cell is justified");
