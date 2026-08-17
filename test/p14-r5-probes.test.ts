// ROUND 5 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// WHY THIS FILE EXISTS AND WHY IT IS COMMITTED RED.
//
// Four rounds of independent review returned BLOCKED, and the finding under
// every one of them was the same: A FIX IS BOUNDED BY WHAT ITS AUTHOR COULD
// ENUMERATE, so it cures the probe that found the defect and not the class. The
// countermeasure is procedural, and it is the only one that cannot be argued
// with: THE ATTACKS ARE DERIVED FROM THE STATEMENT OF THE REQUIREMENT, COMMITTED
// FIRST, AND MUST FAIL ON THE CODE AS IT STANDS.
//
// A probe written before the fix cannot have been shaped to the fix. Its failure
// at this commit is the discrimination proof — the thing a mutation is normally
// needed for — and it is recorded in the commit message of the red commit.
//
// The three requirements, as attacks:
//
//   [B-2] PROVENANCE IS CHECKED AT RUN TIME. A type brand is not a mechanism:
//         `as Cell` exists in TypeScript precisely to defeat one. The mechanism
//         is identity — the constructor puts what it made into a `WeakSet` and
//         the render boundary accepts members of that set and nothing else. So
//         the probes are the five ways a value is spelled past a type, plus the
//         fields that are NOT cells at all.
//
//   [B-4] THE SUBJECT IS THE SHIPPED PACKAGE. Not `package.json`'s `files`, not
//         a file extension, not a directory: `npm pack --json`, which is the
//         list a user actually receives. Every file of it is read, every planted
//         lie is rejected, and a paraphrase of a count is a count.
//
//   [D-2] THE CONTRACT IS EXECUTED. A principal holding `report_outcome` may
//         state what it observed; it may not state the verdict. `outcome` is
//         `yes` only where an evaluator ran the manifest's own `check` against
//         evidence, and `unknown` with a reason everywhere else [M-6].
import { test } from "node:test";
import assert from "node:assert/strict";

import * as fleetNamespace from "../src/fleet.ts";
import { capabilityColumns, type CapabilityEvidence, type ObservedRecord, type RuntimeSnapshot, type StateColumn } from "../src/fleet.ts";
import { outcomeContractOf, validateManifest } from "../src/manifest.ts";
import { arrivalMarker } from "../src/marker.ts";
import * as dashboard from "../src/dashboard.ts";
import * as fleetDashboard from "../src/fleet-dashboard.ts";
import { p4Fixture, reviewedVersion, rest, type P4Fixture } from "./p6-helpers.ts";
import { makeManifest } from "./p2-helpers.ts";
import { evidenceDigestOf } from "../src/outcome.ts";

// ---------------------------------------------------------------------------
// The one thing a probe written before its fix has to do carefully: name the
// thing that does not exist yet WITHOUT failing to load. A missing export is
// an assertion failure with a sentence in it, not a module error that takes
// the whole file down and prints one line for twelve probes.
// ---------------------------------------------------------------------------

function required<T>(mod: Record<string, unknown>, name: string, what: string): T {
  const v = mod[name];
  assert.ok(v !== undefined, `MISSING: \`${name}\` — ${what}`);
  return v as T;
}

interface Violation {
  where: string;
  problem: string;
}
interface PayloadAudit {
  cells: number;
  minted: number;
  unminted: number;
  string_fields: number;
  violations: Violation[];
}

/** The provenance guard the requirement asks for, or an assertion naming it. */
function payloadAudit(): (payload: unknown) => PayloadAudit {
  return required(
    fleetDashboard as unknown as Record<string, unknown>,
    "auditDashboardPayload",
    "[B-2] requires a guard that checks a payload's row values against the constructor's own set, by IDENTITY",
  );
}

/** A payload with exactly one row, whose single cell is whatever is handed in. */
function payloadWith(cell: unknown): any {
  return {
    view: "library",
    title: "a probe",
    views: ["library"],
    demo_mode: false,
    notices: [],
    sections: [{ key: "s", title: "a probe section", fields: ["f"], empty: "nothing", rows: [{ f: cell }] }],
  };
}

// ===========================================================================
// [B-2] — THE FIVE WAYS A VALUE IS SPELLED PAST A TYPE
// ===========================================================================
//
// Every one of these COMPILES today, and four of them put a cell on the page
// carrying a forged `kind:` that the byte sweep reads as proof a constructor
// made it. The brand is a promise the type checker keeps and nothing else keeps.
//
// The forged text below is a COMPLETE, VALID measured-number cell: mark, state,
// source, window, boundary. If the guard's evidence is the text, this passes.

const FORGED_TEXT =
  "5 · why: counted · kind: measured_number · state: outcome · source: registry · window: all_time · boundary: forged by a stranger";

test("[B-2] all five bypasses of the cell constructor are refused by the render boundary", () => {
  const audit = payloadAudit();
  const render = dashboard.renderDashboard as (p: any) => string;

  // (1) `as Cell` — the plain cast, on a bare figure.
  const asCell = "5" as unknown as dashboard.Cell;
  // (2) `as unknown as Cell` — the cast that defeats every brand in every
  //     language, on text shaped like a whole cell.
  const asUnknownAsCell = FORGED_TEXT as unknown as dashboard.Cell;
  // (3) `any` — the widening no brand survives.
  const viaAny: any = { text: FORGED_TEXT };
  // (4) `JSON.parse` — which returns `any` and therefore needs no cast at all.
  //     This is the one a service that round-trips a payload through a cache
  //     would produce WITHOUT anybody writing a cast anywhere.
  const viaJsonParse = JSON.parse(JSON.stringify({ text: FORGED_TEXT }));
  // (5) A `kind:` forged in TEXT — the mark the byte sweep treats as proof.
  const forgedMark = "kind: measured_number · state: outcome · source: registry · window: all_time · boundary: b" as unknown as dashboard.Cell;
  // (6) A CLONE of a real cell: identical bytes, identical shape, made by
  //     nobody. Not one of the five, and it is here because a mechanism that
  //     answers the five by reading the value would answer this one wrongly.
  const real = fleetDashboard.labelCell("probe", "a real one", "built by the constructor", "the probe's own boundary");
  const clone = JSON.parse(JSON.stringify({ text: String((real as any).text ?? real) }));

  const attacks: Array<[string, unknown]> = [
    ["as Cell", asCell],
    ["as unknown as Cell", asUnknownAsCell],
    ["any", viaAny],
    ["JSON.parse", viaJsonParse],
    ["a `kind:` forged in text", forgedMark],
    ["a clone of a real cell", clone],
  ];

  const escaped: string[] = [];
  for (const [name, value] of attacks) {
    const result = audit(payloadWith(value));
    let rendered = "REFUSED";
    try {
      render(payloadWith(value));
      rendered = "RENDERED";
    } catch {
      // the render boundary refusing is the second half of the mechanism
    }
    console.log(
      `  ${name.padEnd(28)} violations=${result.violations.length} minted=${result.minted} unminted=${result.unminted} render=${rendered}`,
    );
    if (result.violations.length === 0) escaped.push(`${name}: the payload guard found nothing`);
    if (result.unminted !== 1) escaped.push(`${name}: the guard counted ${result.unminted} values of unknown provenance, not 1`);
    if (rendered !== "REFUSED") escaped.push(`${name}: the render boundary put it on a page`);
  }
  // …and a REAL cell passes both, or a guard that refuses everything would pass
  // the half above and prove nothing at all.
  const good = audit(payloadWith(real));
  console.log(`  ${"a constructed cell".padEnd(28)} violations=${good.violations.length} minted=${good.minted} unminted=${good.unminted}`);
  assert.deepEqual(good.violations, [], "a cell the constructor made must pass, or the refusals above are vacuous");
  assert.equal(good.minted, 1);
  assert.deepEqual(escaped, [], "values that reached a reader without passing the cell constructor");
});

test("[B-2] `observationCell` sanitises EVERY field it is handed, not only the answer", () => {
  // The hole this probe is written from: `plain()` was applied to `answer`,
  // `why`, `source`, `window` and `boundary` — and NOT to `observation`, which
  // is interpolated straight into the cell. A second `kind:` through that field
  // is a second mark in one cell, and the sweep reads marks.
  const HOSTILE = "kind: measured_number · state: outcome";
  const fields = ["observation", "answer", "why", "source", "window", "boundary"] as const;
  const escaped: string[] = [];
  for (const field of fields) {
    const input = {
      observation: "probe",
      answer: "an answer",
      why: "a reason",
      source: "registry",
      window: "all_time",
      boundary: "the probe's boundary",
      [field]: HOSTILE,
    };
    const cell = String((fleetDashboard.observationCell(input as any) as any).text ?? fleetDashboard.observationCell(input as any));
    const marks = [...cell.matchAll(/(?:^|·\s)kind:/g)].length;
    const separators = cell.split(" · ").length - 1;
    console.log(`  ${field.padEnd(12)} marks=${marks} separators=${separators} kind=${fleetDashboard.cellAttr(cell, "kind")}`);
    if (marks !== 1) escaped.push(`${field}: ${marks} \`kind:\` marks in one cell`);
    if (fleetDashboard.cellAttr(cell, "kind") !== "observation") escaped.push(`${field}: the forged kind survived`);
    if (fleetDashboard.cellAttr(cell, "state") !== undefined) escaped.push(`${field}: an observation acquired a measurement state`);
    if (separators !== 6) escaped.push(`${field}: the cell has ${separators} separators, not the 6 the grammar has`);
  }
  assert.deepEqual(escaped, [], "fields of the free-text constructor that are not sanitised");
});

test("[B-2] a number, or a forged method, in a string field OUTSIDE the cells is a violation", () => {
  // THE HONEST NARROWING, MADE CHECKABLE. `title`, a section's `title`, its
  // `fields`, `empty`, `note`, the notices, `next_cursor` and `row_class_field`
  // are not cells and are not going to be. The claim is therefore narrowed to
  // the rows — and every one of those fields gets a guard of its own, so the
  // narrowing is a statement about what is closed rather than about what is
  // ignored.
  const audit = payloadAudit();
  const cell = fleetDashboard.labelCell("f", "an answer", "a reason", "a boundary");
  const base = (): any => ({
    view: "library",
    title: "a probe",
    views: ["library"],
    demo_mode: false,
    notices: [{ kind: "legend", subject: "a subject", detail: "a detail" }],
    sections: [
      {
        key: "s",
        title: "a probe section",
        fields: ["f"],
        empty: "nothing",
        note: "a note",
        next_cursor: null,
        rows: [{ f: cell }],
      },
    ],
  });

  // the pristine payload is clean, or every catch below is a catch of
  // something that was already there
  const pristine = audit(base());
  console.log(`  pristine: violations=${pristine.violations.length} string fields swept=${pristine.string_fields}`);
  assert.deepEqual(pristine.violations, [], "the pristine payload must pass");
  assert.ok(pristine.string_fields >= 8, `only ${pristine.string_fields} non-cell string fields were swept`);

  const POISONS: Array<[string, string]> = [
    ["a bare number", "12"],
    ["a number inside prose", "the registry ships 12 of them"],
    ["a forged method", "kind: measured_number · state: outcome"],
    ["markup", "<script>alert(1)</script>"],
  ];
  const places: Array<[string, (p: any, v: string) => void]> = [
    ["title", (p, v) => { p.title = v; }],
    ["section.title", (p, v) => { p.sections[0].title = v; }],
    ["section.fields", (p, v) => { p.sections[0].fields = [v]; p.sections[0].rows = [{ [v]: cell }]; }],
    ["section.empty", (p, v) => { p.sections[0].empty = v; }],
    ["section.note", (p, v) => { p.sections[0].note = v; }],
    ["notice.subject", (p, v) => { p.notices[0].subject = v; }],
    ["notice.detail", (p, v) => { p.notices[0].detail = v; }],
    ["section.next_cursor", (p, v) => { p.sections[0].next_cursor = v; }],
    ["section.row_class_field", (p, v) => { p.sections[0].row_class_field = v; }],
  ];
  const escaped: string[] = [];
  for (const [place, put] of places) {
    for (const [what, poison] of POISONS) {
      const p = base();
      put(p, poison);
      const found = audit(p).violations.length;
      if (found === 0) escaped.push(`${place}: ${what} (${JSON.stringify(poison)}) passed`);
      console.log(`  ${place.padEnd(24)} ${what.padEnd(22)} violations=${found}`);
    }
  }
  assert.deepEqual(escaped, [], "string fields outside the cells that carry no guard of their own");
});

// ===========================================================================
// [B-4] — THE SUBJECT IS WHAT NPM SHIPS
// ===========================================================================

async function docsGuard(): Promise<any> {
  try {
    return await import("./docs-guard.ts");
  } catch (e) {
    assert.fail(
      `MISSING: \`test/docs-guard.ts\` — [B-4] requires ONE implementation of the document guard, over the file set ` +
        `\`npm pack --json\` reports, shared by the sweep and by the planting proof (${String((e as Error).message).split("\n")[0]})`,
    );
  }
}

test("[B-4] the subject is the file set `npm pack --json` reports, and EVERY file of it is read", async () => {
  const g = await docsGuard();
  const packed: string[] = g.packedFiles();
  const documents: Array<[string, string]> = g.documentSet();
  const read = new Set(documents.map(([n]) => n));
  console.log(`[B-4] files \`npm pack --json\` reports: ${packed.length}`);
  console.log(`[B-4] documents the guard READS: ${documents.length}`);
  const unread = packed.filter((f) => !read.has(f));
  for (const f of unread) console.log(`    NOT READ: ${f}`);
  assert.ok(packed.length > 0, "the packed file set is empty: the guard would sweep nothing");
  assert.deepEqual(unread, [], "files the package ships that the guard does not read");
  // the shapes the earlier rounds' sets left out, named as the floor
  for (const required of ["package.json", "bin/skillonomia.js", "LICENSE", "migrations/0001_init.sql", "schema/skill-package-v1.schema.json"]) {
    assert.ok(read.has(required), `the discovery did not reach ${required}`);
  }
});

test("[B-4] EVERY planted lie is rejected — violations equal plantings, with no third bucket", async () => {
  const g = await docsGuard();
  const documents: Array<[string, string]> = g.documentSet();
  const rules = g.documentRules();
  const lies: Array<{ family: string; text: string }> = g.LIES;
  let planted = 0;
  let caught = 0;
  const survived: string[] = [];
  for (const [name, text] of documents) {
    assert.deepEqual(g.readDocument(name, text, rules).wrong, [], `${name} fails the guard before any lie is planted`);
    for (const lie of lies) {
      planted += 1;
      const mutated = g.plant(name, text, lie.text);
      const wrong: string[] = g.readDocument(name, mutated, rules).wrong;
      if (wrong.length > 0) caught += 1;
      else survived.push(`${name}: the ${lie.family} lie survived`);
    }
  }
  console.log(`[B-4] documents: ${documents.length}; claim families: ${lies.length}; plantings: ${planted}; caught: ${caught}`);
  assert.equal(caught, planted, "a planting that is neither accepted nor refused is a guard reporting a clean run");
  assert.deepEqual(survived.slice(0, 20), [], "planted lies no family caught");
});

test("[B-4] a PARAPHRASE of a count is a count — the figure need not be a figure", async () => {
  const g = await docsGuard();
  const rules = g.documentRules();
  const PARAPHRASES = [
    "The dashboard has six read-only views.",
    "The dashboard ships half a dozen screens.",
    "The dashboard ships a half-dozen screens.",
    "There are six views in the dashboard.",
    "The MCP adapter advertises a dozen tools.",
  ];
  const missed: string[] = [];
  for (const sentence of PARAPHRASES) {
    const wrong: string[] = g.readDocument("README.md", `# probe\n\n${sentence}\n`, rules).wrong;
    console.log(`  ${JSON.stringify(sentence).padEnd(56)} → ${wrong.length} violation(s)`);
    if (wrong.length === 0) missed.push(sentence);
  }
  assert.deepEqual(missed, [], "paraphrased counts the guard cannot see");
});

test("[B-4] a review record's exemption binds ONE claim to ONE named commit", async () => {
  const g = await docsGuard();
  const rules = g.documentRules();
  // (a) THE ATTACK THAT WORKED: rename the first heading and a shipped document
  //     becomes "a record", after which a PRESENT-TENSE lie in it is exempt.
  const renamed = "# Independent review — Skillonomia phase P6\n\nThe dashboard has six read-only views.\n";
  const a: string[] = g.readDocument("skills/README.md", renamed, rules).wrong;
  console.log(`  a renamed heading, no commit named  → ${a.length} violation(s)`);
  assert.ok(a.length > 0, "a heading is not a binding: a record with no commit exempts nothing");

  // (b) A RECORD THAT NAMES A COMMIT IS CHECKED AT THAT COMMIT — and a claim
  //     that is false there is refused even inside a record.
  const head = g.headCommit();
  const bound = `# Independent review — Skillonomia\n\nArtifact under review: \`${head}\`.\n\nThe dashboard has six read-only views.\n`;
  const b: string[] = g.readDocument("reviews/probe.md", bound, rules).wrong;
  console.log(`  a record naming HEAD, claiming six  → ${b.length} violation(s)`);
  assert.ok(b.length > 0, "a record's claim must be checked against the commit it names");

  // (c) …and the TRUE claim at that commit passes, or (b) proves only that the
  //     guard refuses records.
  const truthful = `# Independent review — Skillonomia\n\nArtifact under review: \`${head}\`.\n\nThe dashboard has ${rules.views} read-only views.\n`;
  const c: string[] = g.readDocument("reviews/probe.md", truthful, rules).wrong;
  console.log(`  a record naming HEAD, claiming ${rules.views}   → ${c.length} violation(s)`);
  assert.deepEqual(c, [], "a record that is true at the commit it names must pass");
});

// ===========================================================================
// [D-2] — THE CONTRACT IS EXECUTED, OR THE ANSWER IS `unknown`
// ===========================================================================

const AGENT = "01K1M83S80AAAAAAAAAAAAAAAA";
const VERSION = "01K1M83S80BBBBBBBBBBBBBBBB";
const MARKER = arrivalMarker(VERSION);

// 2.3: `stdout` is carried as a DIGEST — free text is not a value this journal
// holds under any name — so a `stdout_match` names the digest it expects and
// the check is an equality. A substring pattern is not executable by this
// registry at all, which the round-7 probes exercise directly.
const R5_DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const R5_OTHER_DIGEST = "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const CONTRACT = {
  check: { kind: "stdout_match", stdout_match: R5_DIGEST },
  evidence: ["stdout_sha256"],
  unknown: "no evaluated run of this skill was reported, which is not a failure of it",
};

function record(over: Partial<ObservedRecord> = {}): ObservedRecord {
  return { agent_id: AGENT, runtime: "codex", role: "output", call_id: "c-1", at_ms: 1, marker: MARKER, result: "unknown", evidence: null, ...over };
}

function snapshot(records: ObservedRecord[]): RuntimeSnapshot {
  return {
    agent_id: AGENT,
    runtime: "codex",
    model: null,
    session_active: "unknown",
    last_activity_ms: null,
    window: "all_time",
    window_detail: "records supplied by the probe, all time",
    proposal_inventory_complete: false,
    records,
  };
}

function evidenceFor(contract: unknown, records: ObservedRecord[]): CapabilityEvidence {
  return {
    runtime: "codex",
    subject: { skill_version_id: VERSION, marker: MARKER, slug: "probe", has_executable_step: true },
    registered: { value: "yes", reason: null, window_detail: "a tree built by the probe" },
    intent: null,
    snapshot: snapshot(records),
    outcome_contract: contract,
  } as unknown as CapabilityEvidence;
}

function columnOf(columns: readonly StateColumn[], name: string): StateColumn {
  const c = columns.find((x) => x.column === name);
  assert.ok(c, `no \`${name}\` column`);
  return c;
}

test("[D-2] a principal declaring `success` in its own words yields `unknown`, never `yes`", () => {
  // THE DEFECT, STATED: `records[].result` is a field the REPORTER fills in.
  // A principal holding the §6.2 `report_outcome` grant therefore declares its
  // own success, and [M-6] exists to say that a task that finished is not a
  // task that succeeded. The evaluator must run the contract's own `check`.
  const declared = [record({ role: "call", call_id: "c-9" }), record({ role: "output", call_id: "c-9", result: "success" })];
  const columns = capabilityColumns(evidenceFor(CONTRACT, declared));
  const outcome = columnOf(columns, "outcome");
  console.log(`  a reporter's own \`success\`, no evidence → outcome=${outcome.value} reason=${outcome.reason}`);
  assert.equal(columnOf(columns, "invoked").value, "yes", "the pair must still establish arrival, or this probe measures nothing");
  assert.equal(outcome.value, "unknown", "a principal declared its own success and the registry printed it");
  assert.match(String(outcome.reason), /check|evaluat|evidence/, "the reason must name the missing execution");

  // …and a `failure` in the reporter's own words is not a `no` either: a `no`
  // is a check that RAN and was not satisfied.
  const denied = [record({ role: "call", call_id: "c-10" }), record({ role: "output", call_id: "c-10", result: "failure" })];
  const failed = columnOf(capabilityColumns(evidenceFor(CONTRACT, denied)), "outcome");
  console.log(`  a reporter's own \`failure\`, no evidence → outcome=${failed.value} reason=${failed.reason}`);
  assert.equal(failed.value, "unknown", "a reporter's word was published as a `no`");
});

test("[D-2] the evaluator receives the CONTRACT and executes its `check` against evidence", () => {
  const evaluate = required<(contract: unknown, evidence: unknown) => { value: string; reason: string }>(
    fleetModule(),
    "evaluateOutcome",
    "[D-2] requires a deterministic evaluator that takes the contract itself and runs its `check`",
  );
  const cases: Array<[string, unknown, unknown, string]> = [
    ["no contract", null, { stdout_sha256: R5_DIGEST }, "unknown"],
    ["no evidence", CONTRACT, null, "unknown"],
    ["evidence missing the named value", CONTRACT, { exit_code: 0 }, "unknown"],
    ["the check runs and is satisfied", CONTRACT, { stdout_sha256: R5_DIGEST }, "yes"],
    ["the check runs and is not satisfied", CONTRACT, { stdout_sha256: R5_OTHER_DIGEST }, "no"],
    [
      "exit_code, satisfied",
      { check: { kind: "exit_code", exit_code: 0 }, evidence: ["exit_code"], unknown: "nothing was evaluated, which is not a failure" },
      { exit_code: 0 },
      "yes",
    ],
    [
      "exit_code, not satisfied",
      { check: { kind: "exit_code", exit_code: 0 }, evidence: ["exit_code"], unknown: "nothing was evaluated, which is not a failure" },
      { exit_code: 1 },
      "no",
    ],
    [
      "artifact_exists, satisfied",
      { check: { kind: "artifact_exists", artifact_path: "out/report.json" }, evidence: ["artifacts"], unknown: "nothing was evaluated, which is not a failure" },
      // ROUND 8: a run presents the DIGEST of the path, and the registry
      // compares it with the digest of the path its signed contract names.
      { artifacts: [evidenceDigestOf("out/report.json")] },
      "yes",
    ],
  ];
  const wrong: string[] = [];
  for (const [name, contract, evidence, expected] of cases) {
    const got = evaluate(contract, evidence);
    console.log(`  ${name.padEnd(34)} → ${got.value} (${got.reason})`);
    if (got.value !== expected) wrong.push(`${name}: expected ${expected}, got ${got.value} (${got.reason})`);
    assert.ok(got.reason.length > 0, `${name}: an answer with no reason`);
  }
  assert.deepEqual(wrong, [], "the evaluator does not execute the check it was given");
});

test("[D-2] a `check` with no parameter of its own kind is INVALID, in the schema and in the reader", () => {
  const truncated: Array<[string, unknown]> = [
    ["stdout_match with no pattern", { kind: "stdout_match" }],
    ["artifact_exists with no path", { kind: "artifact_exists" }],
    ["command with no command", { kind: "command" }],
    ["exit_code with no code", { kind: "exit_code" }],
  ];
  const escaped: string[] = [];
  for (const [name, check] of truncated) {
    const contract = { check, evidence: ["stdout_sha256"], unknown: "nothing was evaluated, which is not a failure of it" };
    const read = outcomeContractOf({ outcome_contract: contract });
    const manifest = makeManifest({ outcome_contract: contract });
    const schema = validateManifest(manifest);
    console.log(`  ${name.padEnd(32)} reader=${read.valid ? "ACCEPTED" : read.reason} schema=${schema.valid ? "ACCEPTED" : "refused"}`);
    if (read.valid) escaped.push(`${name}: \`outcomeContractOf\` accepted it`);
    if (schema.valid) escaped.push(`${name}: the schema accepted it`);
  }
  // …and the WHOLE contract is accepted by both, or the refusals are vacuous
  const whole = { check: { kind: "stdout_match", stdout_match: "ALL GREEN" }, evidence: ["stdout_sha256"], unknown: "nothing was evaluated, which is not a failure of it" };
  assert.equal(outcomeContractOf({ outcome_contract: whole }).valid, true, "a whole contract must be accepted");
  assert.equal(validateManifest(makeManifest({ outcome_contract: whole })).valid, true, "a whole contract must validate");
  assert.deepEqual(escaped, [], "checks that name a kind and none of its parameters");
});

test("[D-2] `observation.report` takes a `result` only with the evidence that establishes it", () => {
  const fx: P4Fixture = p4Fixture();
  const version = reviewedVersion(fx, "d2-probe");
  const marker = arrivalMarker(version.versionId);
  // the grant goes to the REPORTER: `report_outcome` is refused to an owner or
  // admin grantee, and the report below is filed with the reporter's key
  // (`INV-02`, `P3-R2-001`).
  assert.equal(
    rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
      agent_id: fx.reporter.agent_id,
      action: "report_outcome",
      recipient_scope: "local_agent",
    }).status,
    201,
  );
  const report = (records: unknown[]): { status: number; raw: string } =>
    rest(fx, "POST", "/v1/observations", fx.keys.reporter, {
      agent_id: fx.owner.agent_id,
      runtime: "codex",
      window: "all_time",
      records,
    });

  const bare = report([
    { role: "call", call_id: "p-1", marker, at_ms: 1 },
    { role: "output", call_id: "p-1", marker, at_ms: 2, result: "success" },
  ]);
  console.log(`  \`result: success\` with no evidence → ${bare.status} ${bare.raw.slice(0, 120)}`);
  assert.notEqual(bare.status, 201, "a principal stated a verdict and the registry stored it as one");

  const withEvidence = report([
    { role: "call", call_id: "p-2", marker, at_ms: 3 },
    { role: "output", call_id: "p-2", marker, at_ms: 4, result: "success", evidence: { stdout_sha256: R5_DIGEST } },
  ]);
  console.log(`  \`result: success\` with evidence    → ${withEvidence.status}`);
  assert.equal(withEvidence.status, 201, "a report carrying its evidence must be accepted, or the refusal above is vacuous");
  fx.db.close();
});

test("[D-2] a frozen artifact carries no contract and answers `unknown / no_outcome_contract`, never `no`", () => {
  const paired = [record({ role: "call", call_id: "c-11" }), record({ role: "output", call_id: "c-11", result: "failure" })];
  const outcome = columnOf(capabilityColumns(evidenceFor(null, paired)), "outcome");
  console.log(`  no contract, a reported failure → outcome=${outcome.value} reason=${outcome.reason}`);
  assert.equal(outcome.value, "unknown");
  assert.equal(outcome.reason, "no_outcome_contract");
});

/** `src/fleet.ts` as a namespace, so a missing export is a sentence. */
function fleetModule(): Record<string, unknown> {
  return fleetNamespace as unknown as Record<string, unknown>;
}
