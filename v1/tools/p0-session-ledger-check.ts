#!/usr/bin/env node
// THE WHOLE LEDGER, P0 THROUGH P6 — THE IDENTITY OF EVERY SESSION THIS CONTRACT RAN.
//
//   node --experimental-strip-types --no-warnings v1/tools/p0-session-ledger-check.ts <evidence-dir>
//
// WHY THIS EXISTS, AND WHY THE CHECK THAT ALREADY EXISTED DID NOT CATCH IT.
// P6 REVIEW-1 finding `P6-R1-002`: six completed review sessions carried
// `(not recorded)` where contract section 7.3 requires a provider session id, and
// they carried it through five phases. `v1/tools/p0-evidence-check.ts` passed every
// time, and correctly by its own terms: it is pointed at ONE phase directory and
// reads only the ledger rows of that phase, so a P1 row with a hole in it is
// invisible while P6 is being certified. FINAL DONE condition 1 is a claim about
// P0–P6 together, and nothing read the ledger that way.
//
// So this reads the ledger as one document and asks three things of it.
//
//   1. NO PLACEHOLDER IN AN IDENTITY CELL. `task_id` is a Ductor task id and
//      `session_id` is a canonical provider UUID, in EVERY row, with no exception
//      for a role, a phase or an outcome. `(not recorded)`, `(pending)`, `(refused
//      by provider)`, `TBD`, `—`: each is a value somebody meant to come back to,
//      and the six that survived five phases are what a permitted placeholder
//      costs. A refused launch is not an exception to this — it is a session the
//      provider opened and then declined to finish, so it HAS an id, and recording
//      the refusal without it makes a run that happened look like a run that did
//      not.
//
//   2. NO IDENTITY TWICE. Contract section 7.3 forbids continuing a BUILD, FIX or
//      REVIEW in another session's provider context, and separate `(task_id,
//      session_id)` pairs are how that is checkable. Across the WHOLE ledger,
//      therefore: a task id belongs to one row and a session id belongs to one row.
//      A duplicate is either two sessions filed as one or one session filed twice,
//      and both destroy the isolation claim.
//
//   3. THE ROWS AND THE PHASE PACKAGES STATE THE SAME SESSIONS. Wherever a phase
//      directory carries a run ledger or a session record, the identity in it must
//      be the identity in the ledger row for that `(phase, role)`, and the identity
//      in it must appear in the ledger at all. A run recorded under a session the
//      ledger has never heard of is the same defect from the other side.
//
// WHAT THIS DOES NOT DO, said plainly so the division of labour is legible. It does
// not check SHAs, artifacts, gate verdicts, the completeness of a phase package or
// the agreement of its closure markers: `v1/tools/p0-evidence-check.ts` and
// `v1/tools/p0-output-sha-check.ts` own those, per phase, and a second implementation
// of them here is how two checkers drift into disagreeing. This owns exactly one
// property — WHO RAN WHAT — and owns it across every phase at once.
//
// TWO TABLES, READ BY THEIR HEADERS. The ledger's main table has one row per
// `(phase, role)`: the session that produced that step. Launches the provider
// refused before they produced anything are a second table, because a `(phase,
// role)` names one session in the main table and a second row there would make every
// per-phase cross-check ambiguous — the rule `p0-evidence-check.ts` enforces after
// P3 REVIEW-2 finding `P3-R2-003`. Both tables face rules 1 and 2 identically; only
// the main table is required to be unique per `(phase, role)` and only its rows are
// cross-checked against the phase packages, because a refused launch produced no
// package to check against.
//
// EXIT CODES
//   0  every session in the ledger has a real, unique identity, and the phase
//      packages agree about it
//   1  they do not
//   2  REFUSED — there is no ledger to read
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROLE_FORM = /^(BUILD|FIX|REVIEW)-\d+[a-z]?$/;
const ROLE_CONTRACT: Record<string, { provider: string; model: string; reasoning: string }> = {
  BUILD: { provider: "claude", model: "opus", reasoning: "high" },
  FIX: { provider: "claude", model: "opus", reasoning: "high" },
  REVIEW: { provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
};
const FORBIDDEN_MODEL_ALIASES = new Set(["opus-5", "claude-opus-5-high"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const TASK_ID = /^[0-9a-f]{8}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUND_CAP: Record<string, number> = { REVIEW: 2, FIX: 2 };
const PHASES = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];

function refuse(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

const dirArg = process.argv[2];
if (!dirArg) {
  refuse(
    "pass the evidence directory that holds SESSIONS.md, e.g. .../evidence.\n" +
      "A ledger check with no subject reports a clean ledger having read none of it.",
  );
}
const EVIDENCE = resolve(dirArg);
if (!existsSync(EVIDENCE) || !statSync(EVIDENCE).isDirectory()) refuse(`${EVIDENCE} is not a directory.`);
const LEDGER = join(EVIDENCE, "SESSIONS.md");
if (!existsSync(LEDGER)) refuse(`${LEDGER} is missing; it is the authoritative record of this contract's sessions.`);

const problems: string[] = [];
const notes: string[] = [];

// --- reading the tables -------------------------------------------------------
//
// A table is claimed by its HEADER: the row that names `task_id` and `session_id`.
// Cells are then addressed BY NAME rather than by position, so a column added to
// either table later does not silently shift what this file believes it is reading.

interface Row {
  kind: "session" | "refused";
  line: number;
  cells: Record<string, string>;
}

const cell = (v: string): string => v.replace(/`/g, "").trim();
const split = (line: string): string[] => line.split("|").slice(1, -1).map(cell);

const rows: Row[] = [];
let header: string[] | null = null;
let headerKind: Row["kind"] = "session";
readFileSync(LEDGER, "utf8")
  .split("\n")
  .forEach((line, i) => {
    if (!line.trim().startsWith("|")) {
      header = null;
      return;
    }
    const c = split(line);
    if (c.includes("task_id") && c.includes("session_id")) {
      header = c;
      // A table whose header names an OUTCOME column and no output SHA is the
      // refused-launch table: those launches produced no commit and no review, so
      // there is no SHA for them to name and inventing one would be the fabrication
      // the identity rules exist to prevent.
      headerKind = c.includes("output SHA") ? "session" : "refused";
      return;
    }
    if (header === null) return;
    if (c.every((x) => /^-*:?-*$/.test(x))) return; // the separator
    if (!/^P\d$/.test(c[0] ?? "")) return;
    const named: Record<string, string> = {};
    header.forEach((name, idx) => {
      named[name] = c[idx] ?? "";
    });
    rows.push({ kind: headerKind, line: i + 1, cells: named });
  });

if (rows.length === 0) {
  refuse(`no session row was parsed out of ${LEDGER}. A ledger this check cannot read is a ledger it cannot certify.`);
}

// --- rule 1: the model contract and the identity cells ------------------------

const PLACEHOLDER_HINT =
  "Contract sections 7.3 and 9 require the real task id and the real provider session id of EVERY session to be " +
  "preserved in evidence. A parenthetical is a value somebody meant to come back to, and P6-R1-002 is what happens " +
  "when nothing refuses one.";

for (const row of rows) {
  const where = `SESSIONS.md line ${row.line}`;
  const phase = row.cells.phase ?? "";
  const role = row.cells.role ?? "";
  const taskId = row.cells.task_id ?? "";
  const sessionId = row.cells.session_id ?? "";

  if (!ROLE_FORM.test(role)) {
    problems.push(`${where}: role "${role}" is not one of BUILD-<n>, FIX-<n>, REVIEW-<n>, optionally with a continuation letter.`);
    continue;
  }
  const want = ROLE_CONTRACT[role.split("-")[0]!]!;
  if (FORBIDDEN_MODEL_ALIASES.has(row.cells.model ?? "")) {
    problems.push(`${where}: ${phase} ${role} declares model "${row.cells.model}", an alias contract section 7.1 forbids by name.`);
  } else {
    for (const [field, got, expected] of [
      ["provider", row.cells.provider ?? "", want.provider],
      ["model", row.cells.model ?? "", want.model],
      ["reasoning_effort", row.cells.reasoning ?? "", want.reasoning],
    ] as const) {
      if (got !== expected) {
        problems.push(`${where}: ${phase} ${role} requires ${field}="${expected}" and the ledger says "${got}".`);
      }
    }
  }

  if (!TASK_ID.test(taskId)) {
    problems.push(
      `${where}: ${phase} ${role}'s task_id is "${taskId}", which is not a Ductor task id (8 lowercase hex, or the ` +
        `same value written as a UUID). ${PLACEHOLDER_HINT}`,
    );
  }
  if (!UUID.test(sessionId)) {
    problems.push(
      `${where}: ${phase} ${role}'s session_id is "${sessionId}", which is not a provider session id. ${PLACEHOLDER_HINT}`,
    );
  } else if (sessionId === NIL_UUID) {
    problems.push(`${where}: ${phase} ${role}'s session_id is the nil UUID — a placeholder wearing the right shape.`);
  } else if (TASK_ID.test(taskId) && sessionId.includes(taskId)) {
    problems.push(
      `${where}: ${phase} ${role}'s session_id "${sessionId}" embeds its own task_id "${taskId}" — that is a label ` +
        "built out of the record rather than an identifier the provider issued.",
    );
  }
}

// --- rule 2: no identity twice, anywhere in the ledger ------------------------

for (const field of ["task_id", "session_id"] as const) {
  const seen = new Map<string, Row[]>();
  for (const row of rows) {
    const v = row.cells[field] ?? "";
    if (!v) continue;
    seen.set(v, [...(seen.get(v) ?? []), row]);
  }
  for (const [value, where] of seen) {
    if (where.length > 1) {
      problems.push(
        `session identity: ${field} "${value}" is claimed by ${where.length} rows — ` +
          where.map((r) => `${r.cells.phase} ${r.cells.role} (line ${r.line})`).join(", ") +
          ". Contract section 7.3 gives each session its own task id and its own session id; a value in two rows is " +
          "either two sessions filed as one or one session filed twice.",
      );
    }
  }
}

// one row per (phase, role) in the SESSION table
const byPhaseRole = new Map<string, Row[]>();
for (const row of rows.filter((r) => r.kind === "session")) {
  const key = `${row.cells.phase} ${row.cells.role}`;
  byPhaseRole.set(key, [...(byPhaseRole.get(key) ?? []), row]);
}
for (const [key, where] of byPhaseRole) {
  if (where.length > 1) {
    problems.push(
      `session ledger: "${key}" has ${where.length} rows in the session table (lines ${where.map((r) => r.line).join(", ")}). ` +
        "A (phase, role) names ONE session; a launch that produced nothing belongs in the refused-launch table, " +
        "where it is still recorded and still identified, without making every per-phase cross-check ambiguous.",
    );
  }
}

// the round cap, contract section 8 point 6
for (const row of rows.filter((r) => r.kind === "session")) {
  const m = /^(BUILD|FIX|REVIEW)-(\d+)[a-z]?$/.exec(row.cells.role ?? "");
  if (!m) continue;
  const cap = ROUND_CAP[m[1]!];
  if (cap !== undefined && Number(m[2]) > cap) {
    problems.push(
      `SESSIONS.md line ${row.line}: ${row.cells.phase} "${row.cells.role}" is round ${m[2]} of ${m[1]}, and contract ` +
        `section 8 point 6 caps a phase at ${cap}.`,
    );
  }
}

// every phase of this contract has at least one session
for (const phase of PHASES) {
  if (!rows.some((r) => r.cells.phase === phase && r.kind === "session")) {
    problems.push(
      `session ledger: ${phase} has no row in the session table. FINAL DONE condition 1 is a claim about P0 through ` +
        "P6 together, and a phase with no recorded session cannot support it.",
    );
  }
}

// --- rule 3: the phase packages state the same sessions -----------------------

const ledgerOf = (phase: string, role: string): Row | undefined => {
  const found = byPhaseRole.get(`${phase} ${role}`);
  return found && found.length === 1 ? found[0] : undefined;
};
const allPairs = new Set(rows.map((r) => `${r.cells.task_id}/${r.cells.session_id}`));

let crossChecked = 0;
let ledgersRead = 0;
let recordsRead = 0;

function compare(where: string, phase: string, role: string, taskId: string, sessionId: string): void {
  const row = ledgerOf(phase, role);
  if (!row) {
    problems.push(
      `${where}: ${phase} ${role} appears in the phase package and has no single row in the session table of ` +
        "SESSIONS.md. The ledger is the authoritative list of this contract's sessions.",
    );
    return;
  }
  crossChecked += 1;
  for (const [field, fromPackage, fromLedger] of [
    ["task_id", taskId, row.cells.task_id ?? ""],
    ["session_id", sessionId, row.cells.session_id ?? ""],
  ] as const) {
    if (fromPackage && fromPackage !== fromLedger) {
      problems.push(
        `${where}: ${phase} ${role} records ${field}="${fromPackage}" and SESSIONS.md line ${row.line} says ` +
          `"${fromLedger}". The two must be the same fact.`,
      );
    }
  }
  if (taskId && sessionId && !allPairs.has(`${taskId}/${sessionId}`)) {
    problems.push(
      `${where}: ${phase} ${role} was run under (${taskId}, ${sessionId}), a pair no ledger row carries. ` +
        "A session that produced evidence and appears in no row is an unrecorded session.",
    );
  }
}

for (const phase of PHASES) {
  const dir = join(EVIDENCE, phase);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    notes.push(`${phase}: no phase directory under ${EVIDENCE}; nothing to cross-check`);
    continue;
  }
  const before = crossChecked;

  // every run ledger of the phase, the archived ones included: an archived ledger
  // is exempt from the field schema and never from identity.
  const ledgers: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^runs.*\.jsonl$/.test(e.name)) ledgers.push(p);
    }
  };
  walk(dir);
  for (const p of ledgers.sort()) {
    ledgersRead += 1;
    readFileSync(p, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line.trim()) return;
        let r: Record<string, unknown>;
        try {
          r = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // p0-evidence-check.ts is what refuses an unparseable record
        }
        compare(
          `${phase}/${p.slice(dir.length + 1)} line ${i + 1}`,
          String(r.phase ?? phase),
          String(r.role ?? ""),
          String(r.task_id ?? ""),
          String(r.session_id ?? ""),
        );
      });
  }

  // every session record of the phase
  for (const file of readdirSync(dir).filter((f) => /session-record.*\.md$/i.test(f)).sort()) {
    recordsRead += 1;
    const text = readFileSync(join(dir, file), "utf8");
    const fields = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const c = split(line);
      if (c.length !== 2) continue;
      fields.set(c[0]!.toLowerCase(), c[1]!);
    }
    const declared = fields.get("phase / role") ?? text.split("\n")[0] ?? "";
    const roleMatch = /(BUILD|FIX|REVIEW)-\d+[a-z]?/.exec(declared);
    if (!roleMatch) {
      problems.push(`${phase}/${file}: this session record names no role, so it can be cross-checked against nothing.`);
      continue;
    }
    compare(
      `${phase}/${file}`,
      phase,
      roleMatch[0],
      cell(fields.get("task_id") ?? ""),
      cell(fields.get("session_id") ?? ""),
    );
  }

  if (crossChecked === before) {
    problems.push(
      `${phase}: the phase directory exists and nothing in it named a session. A cross-check that reads nothing ` +
        "reports agreement it did not establish.",
    );
  }
  notes.push(`${phase}: ${crossChecked - before} package statement(s) cross-checked against the ledger`);
}

// --- the report ---------------------------------------------------------------

const sessionRows = rows.filter((r) => r.kind === "session");
const refusedRows = rows.filter((r) => r.kind === "refused");
console.log(`ledger:            ${LEDGER}`);
console.log(`session rows:      ${sessionRows.length} over ${new Set(sessionRows.map((r) => r.cells.phase)).size} phases`);
console.log(`refused launches:  ${refusedRows.length}`);
console.log(`distinct task ids: ${new Set(rows.map((r) => r.cells.task_id)).size}`);
console.log(`distinct session ids: ${new Set(rows.map((r) => r.cells.session_id)).size}`);
console.log(`run ledgers read:  ${ledgersRead}   session records read: ${recordsRead}`);
console.log(`package statements cross-checked: ${crossChecked}`);
console.log();
for (const n of notes) console.log(`note  ${n}`);
console.log();

if (problems.length > 0) {
  console.error(`FAIL  ${problems.length} problem(s) in the session ledger:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `PASS  every one of the ${rows.length} sessions this contract ran carries a real Ductor task id and a real provider ` +
    "session id, no identifier is claimed twice, and every run ledger and session record in every phase package names " +
    "the same session the ledger does.",
);
