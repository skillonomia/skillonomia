// ROUND 10 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks come from the
// STATEMENT OF THE REQUIREMENT, are committed first, and must FAIL on the code
// as it stands. Their failure at the red commit is the proof that they
// discriminate, and that failure is recorded in the red commit's own message.
//
// WHY THIS ROUND IS NOT THE FIFTH FIX OF THE SAME BUG.
//
//   Nine passes of independent review found FOUR channels by which a caller's
//   text reached a journal of this registry. Each was found one at a time, each
//   was closed, and each time the closing note said the class was closed.
//
//   The common cause is not that the fixes were wrong. It is that THE SURFACE
//   WAS NEVER ENUMERATED. Every round repaired the column somebody pointed at,
//   and the next round's reviewer pointed at the next one. A repair aimed at
//   one column cannot be evidence about a set nobody has written down.
//
//   Twice in this project the opposite worked. The set of MCP tools was taken
//   FROM THE CODE and the tool blockers stopped coming back. The set of shipped
//   documents was taken from `git ls-files` and then from `npm pack --json` and
//   the document blockers stopped coming back. In both cases what changed was
//   the SOURCE OF THE SET, not the diligence of the reader.
//
// SO THE SUBJECT OF THIS ROUND IS THE SET, AND THE SET COMES FROM THE SCHEMA.
//
//   A JOURNAL of this registry is a table the schema itself marks as one: a
//   table carrying a `BEFORE UPDATE` trigger that raises `INSERT_ONLY`. That
//   is the repository's own definition — `migrations/0008` names `transfers`,
//   `receipt_events` and `assignment_events` as "the rule these live under" —
//   and it is read from `sqlite_master` of a freshly migrated database rather
//   than from a list in a test. EVERY COLUMN of every such table is classified,
//   in a table IN THE SHIPPED CODE, as one of:
//
//     `registry_generated` — the caller does not influence the value;
//     `bounded_form`       — an enum, an identifier, a number or a boolean;
//     `digest`             — stored as `sha256:<64 lowercase hex>`;
//     `declared_limit`     — it accepts a caller's text, AND THAT IS SAID SO,
//                            in the files this package ships, with a probe that
//                            demonstrates the limit rather than hiding it.
//
//   A column that is in the schema and not in that table FAILS THE BUILD. That
//   is the point of the round: the next column somebody adds cannot be filed
//   quietly, and the probe `[10.2]` below adds one to prove the guard bites.
//
// WHAT IS PROMISED, AND WHAT IS NOT.
//
//   Achievable, and therefore stated: THIS REGISTRY DOES NOT PUT TEXT INTO ITS
//   JOURNALS, THE FORMS IT ACCEPTS THERE ARE ITS OWN, AND WHERE A CALLER'S TEXT
//   IS STILL ADMITTED THAT IS NAMED AS A LIMIT.
//
//   Not achievable, and therefore never written: that no secret can be in a
//   journal. Every alphabet fit for readable values is fit for part of the
//   secrets, and a bound on a number is a bound on a quantity of bits and not
//   on their meaning. `[10.10]` refuses the unachievable sentence in the
//   shipped files by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openMigrated } from "../src/db.ts";
import type { Db } from "../src/sqlite.ts";
import {
  JOURNAL_INTAKE,
  JOURNAL_WRITERS,
  declaredLimitColumns,
  journalColumnsOf,
  journalTablesOf,
  surveyJournalIntake,
} from "../src/journal.ts";
import { appendAssignmentEvent } from "../src/assignments.ts";
import { appendTlog } from "../src/tlog.ts";
import { arrivalMarker } from "../src/marker.ts";
import { REPO_ROOT, documentSet } from "./docs-guard.ts";
import { p4Fixture, reviewedVersion, rest, adoptThroughSurfaces, type P4Fixture } from "./p6-helpers.ts";

/** The three columns the owner had already found by hand. The survey has to
 *  find them ITSELF — a survey that has to be told is not a survey. */
const KNOWN_THREE = [
  "observed_records.call_id",
  "runtime_observations.window_detail",
  "runtime_observations.model",
] as const;

/**
 * A STRING NO REGISTRY FORM ADMITS, and one an attacker would actually send.
 *
 * Spaces, punctuation, mixed case and a credential-shaped run: it is text, it
 * is not a number, it is not an identifier, and it is not a digest. Nothing
 * here is a real credential.
 *
 * The credential-shaped run is ASSEMBLED FROM FRAGMENTS at run time, by the
 * convention `test/p7-threats.test.ts` TM-03 states and this file had broken: a
 * push-side scanner reads the FILE, and a complete literal of a vendor's key
 * shape refuses the publication of the whole repository over a fixture that is
 * not a credential. The VALUE is unchanged, byte for byte; only its spelling
 * here is, and `KEY_LIKE` is the same constant the probes below search the
 * journals for, so the search and the planting cannot drift apart.
 */
const KEY_LIKE = ["AKIA", "0123456789", "ABCDEF"].join("");
const TEXT = `op paste: ${KEY_LIKE}/wJalrXUtnFEMI+K7MDENG, ~/home/operator/.aws/credentials`;

// ===========================================================================
// THE FIXTURE — the shipped surfaces, and nothing written round the back
// ===========================================================================

interface Fixture {
  fx: P4Fixture;
  marker: string;
  report: (body: Record<string, unknown>) => { status: number; raw: string; body: any };
}

function fixture(slug = "r10-probe"): Fixture {
  const fx = p4Fixture();
  const version = reviewedVersion(fx, slug);
  assert.equal(
    rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
      agent_id: fx.owner.agent_id,
      action: "report_outcome",
      recipient_scope: "local_agent",
    }).status,
    201,
    "the probe could not grant itself `report_outcome`",
  );
  const report = (body: Record<string, unknown>) =>
    rest(fx, "POST", "/v1/observations", fx.keys.owner, {
      agent_id: fx.owner.agent_id,
      runtime: "codex",
      window: "all_time",
      ...body,
    });
  return { fx, marker: arrivalMarker(version.versionId), report };
}

/**
 * ONE REPORT, IN BOTH SHAPES OF THE BOUNDARY — the one this tree accepts today
 * and the one the requirement asks for.
 *
 * A probe that sends only tomorrow's shape is REFUSED by today's boundary for a
 * reason that has nothing to do with what it is testing, and then passes because
 * nothing was stored. That is a probe that cannot discriminate, and round 9
 * shipped one. Exactly one of these two is accepted in either world, so the
 * assertion afterwards is always about a report that actually landed.
 */
function reportBoth(f: Fixture, body: Record<string, unknown>): void {
  const withDetail = f.report({ window_detail: "the probe's own records, all time", ...body });
  const withoutDetail = f.report({ ...body });
  assert.ok(
    withDetail.status === 201 || withoutDetail.status === 201,
    `neither shape of the report was accepted:\n  with window_detail: ${withDetail.raw}\n  without: ${withoutDetail.raw}`,
  );
}

/** Every byte of every journal of this database, columns and all. A refusal
 *  that stores the material somewhere else has not refused it. */
function journalBytes(db: Db): string {
  const out: string[] = [];
  for (const table of journalTablesOf(db)) {
    const cols = journalColumnsOf(db, table);
    const rows = db.prepare(`SELECT ${cols.join(",")} FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) out.push(cols.map((c) => `${c}=${String(row[c] ?? "")}`).join("|"));
  }
  return out.join("\n");
}

// ===========================================================================
// [10.1] THE SURVEY — every column of every journal, classified, from the schema
// ===========================================================================

test("[10.1] every column of every journal table is classified, and the set comes from the schema", () => {
  const db = openMigrated();
  const tables = journalTablesOf(db);
  assert.ok(
    tables.length >= 8,
    `the journals are the INSERT-only tables of the live schema; found ${tables.length}: ${tables.join(", ")}`,
  );
  // the three the observation column is built on must be among them, and so
  // must the four older ones — this is a floor on the SET, not the set itself
  for (const t of [
    "adoption_receipts",
    "assignment_events",
    "assignments",
    "observed_records",
    "receipt_events",
    "runtime_observations",
    "transfers",
    "transparency_log",
  ]) {
    assert.ok(tables.includes(t), `\`${t}\` is INSERT-only in the schema and must be surveyed`);
  }

  const survey = surveyJournalIntake(db);
  assert.deepEqual(
    survey.unclassified,
    [],
    `these journal columns are in the schema and not in the classification table of \`src/journal.ts\`:\n  ${survey.unclassified.join("\n  ")}`,
  );
  assert.deepEqual(
    survey.stale,
    [],
    `these columns are classified and are not in the schema — a classification that outlives its column is a claim about nothing:\n  ${survey.stale.join("\n  ")}`,
  );
  assert.ok(survey.columns.length >= 80, `the survey covers ${survey.columns.length} columns`);
});

test("[10.1c] no journal column is free text with nobody's decision behind it", () => {
  const db = openMigrated();
  const survey = surveyJournalIntake(db);
  assert.deepEqual(
    survey.freeText,
    [],
    "these journal columns take a caller's text and nobody decided that they should — each must be moved to a " +
      `registry-generated, bounded or digest form, or declared a limit out loud:\n  ${survey.freeText.join("\n  ")}`,
  );
});

test("[10.1b] the survey finds the three known columns BY ITSELF, and none of them is a free-text channel", () => {
  const db = openMigrated();
  const survey = surveyJournalIntake(db);
  for (const key of KNOWN_THREE) {
    assert.ok(survey.columns.includes(key), `the survey did not reach \`${key}\``);
    const entry = JOURNAL_INTAKE[key];
    assert.ok(entry, `\`${key}\` is unclassified`);
    assert.ok(
      entry.intake === "digest" || entry.intake === "bounded_form" || entry.intake === "registry_generated",
      `\`${key}\` is classified \`${entry.intake}\`: the owner's three had to be MOVED out of free text, not documented as one`,
    );
  }
});

// ===========================================================================
// [10.2] THE GUARD'S OWN PROBE — a new column fails the build
// ===========================================================================

test("[10.2] a NEW journal column that takes text fails the guard until it is classified", () => {
  const db = openMigrated();
  const clean = surveyJournalIntake(db);
  assert.deepEqual(clean.unclassified, [], "the guard must start clean, or this probe proves nothing");

  // exactly what a future migration would do, in a scratch database
  db.exec("ALTER TABLE observed_records ADD COLUMN operator_note TEXT");
  const after = surveyJournalIntake(db);
  assert.deepEqual(
    after.unclassified,
    ["observed_records.operator_note"],
    "a column added to a journal must be REPORTED by the survey, not absorbed by it",
  );

  // …and on a table the earlier rounds never looked at
  db.exec("ALTER TABLE transfers ADD COLUMN courier_note TEXT");
  assert.deepEqual(surveyJournalIntake(db).unclassified, [
    "observed_records.operator_note",
    "transfers.courier_note",
  ]);

  // AND THE BUILD IS WHAT FAILS, not merely a list that grew. This is the
  // assertion `[10.1]` makes on the real schema, re-executed here against the
  // scratch one: a guard that reports a column into a variable nobody checks is
  // the guard this round exists to stop shipping.
  assert.throws(
    () => assert.deepEqual(surveyJournalIntake(db).unclassified, []),
    /operator_note/,
    "a column added to a journal must FAIL the assertion the suite runs, not merely appear in a list",
  );
});

// ===========================================================================
// [10.3] `call_id` — A DIGEST, and [M-5] survives it
// ===========================================================================

test("[10.3] a reporter's `call_id` is stored as a digest and never word for word", () => {
  const f = fixture();
  reportBoth(f, {
    records: [
      { role: "call", call_id: TEXT, marker: f.marker, at_ms: 1 },
      { role: "output", call_id: TEXT, marker: f.marker, at_ms: 2 },
    ],
  });

  const bytes = journalBytes(f.fx.db);
  assert.ok(!bytes.includes(TEXT), "the reporter's call id reached a journal word for word");
  assert.ok(!bytes.includes(KEY_LIKE), "part of the reporter's call id reached a journal");
  const ids = f.fx.db.prepare("SELECT DISTINCT call_id FROM observed_records").all() as Array<{ call_id: string }>;
  assert.equal(ids.length, 1, "one id was reported, so one value is stored");
  assert.match(ids[0]!.call_id, /^sha256:[0-9a-f]{64}$/, "a stored call id is a digest of the reporter's own");
});

test("[10.3b] the digest keeps the pair [M-5] finds, and keeps NULL a NULL", () => {
  const f = fixture("r10-pairing");
  reportBoth(f, {
    records: [
      { role: "call", call_id: "call-abc", marker: f.marker, at_ms: 1 },
      { role: "output", call_id: "call-abc", marker: f.marker, at_ms: 2 },
    ],
  });
  const digests = f.fx.db.prepare("SELECT call_id FROM observed_records ORDER BY role").all() as Array<{
    call_id: string | null;
  }>;
  assert.equal(digests.length, 2);
  assert.equal(digests[0]!.call_id, digests[1]!.call_id, "equal ids must remain equal, or [M-5] loses the pair");
  assert.match(digests[0]!.call_id!, /^sha256:[0-9a-f]{64}$/);

  const g = fixture("r10-null");
  reportBoth(g, {
    records: [
      { role: "call", marker: g.marker, at_ms: 1 },
      { role: "output", marker: g.marker, at_ms: 2 },
    ],
  });
  const nulls = g.fx.db.prepare("SELECT call_id FROM observed_records").all() as Array<{ call_id: string | null }>;
  assert.equal(nulls.length, 2);
  for (const r of nulls) {
    assert.equal(r.call_id, null, "a record whose runtime gave no id must stay NULL: a digest of nothing is a pair");
  }
});

test("[10.3d] an id past the bound is REFUSED, not turned into the NULL that means `no id`", () => {
  const f = fixture("r10-long-id");
  const long = "a".repeat(201);
  const withDetail = f.report({
    window_detail: "the probe's own records, all time",
    records: [{ role: "call", call_id: long, marker: f.marker, at_ms: 1 }],
  });
  const withoutDetail = f.report({ records: [{ role: "call", call_id: long, marker: f.marker, at_ms: 1 }] });
  for (const res of [withDetail, withoutDetail]) {
    assert.equal(res.status, 400, `an over-long id was accepted: ${res.raw}`);
  }
  assert.equal(
    (f.fx.db.prepare("SELECT COUNT(*) AS c FROM observed_records").get() as { c: number }).c,
    0,
    "a refused report wrote a record",
  );
});

test("[10.3c] two different ids stay different, so a digest never invents a pair", () => {
  const f = fixture("r10-unpaired");
  reportBoth(f, {
    records: [
      { role: "call", call_id: "a-1", marker: f.marker, at_ms: 1 },
      { role: "output", call_id: "a-2", marker: f.marker, at_ms: 2 },
    ],
  });
  const ids = f.fx.db.prepare("SELECT DISTINCT call_id FROM observed_records").all();
  assert.equal(ids.length, 2, "two ids, two digests");
});

// ===========================================================================
// [10.4] `window_detail` — the registry's own sentence, not the reporter's
// ===========================================================================

test("[10.4] a reporter cannot write a sentence into `runtime_observations.window_detail`", () => {
  const f = fixture("r10-window");
  // both shapes, and the prose rides on both: the point is that no route puts it
  // in the column, not that one particular route was closed
  f.report({ window_detail: TEXT, records: [] });
  f.report({ records: [], window_detail: undefined });
  const stored = f.fx.db.prepare("SELECT window_detail FROM runtime_observations").all() as Array<{
    window_detail: string;
  }>;
  for (const row of stored) {
    assert.ok(!row.window_detail.includes(KEY_LIKE), "the reporter's prose reached the boundary column");
    assert.ok(!row.window_detail.includes(TEXT), `\`window_detail\` held the reporter's text: ${row.window_detail}`);
  }
  assert.ok(!journalBytes(f.fx.db).includes(KEY_LIKE), "the text reached a journal");
});

test("[10.4b] [I-3] survives: the boundary is still stated, and a `period` with no bounds is REFUSED", () => {
  const f = fixture("r10-window-i3");
  reportBoth(f, { records: [] });
  const detail = (
    f.fx.db.prepare("SELECT window_detail FROM runtime_observations").get() as { window_detail: string }
  ).window_detail;
  assert.ok(detail.length > 0, "a report with no boundary is a number with no method [I-3]");
  assert.match(detail, /all_time/, "the boundary names the selection it was taken over");

  const g = fixture("r10-window-refused");
  const bad = rest(g.fx, "POST", "/v1/observations", g.fx.keys.owner, {
    agent_id: g.fx.owner.agent_id,
    runtime: "codex",
    window: "period",
    records: [],
  });
  assert.equal(bad.status, 400, `a \`period\` with no bounds is refused rather than defaulted [I-3]: ${bad.raw}`);

  const h = fixture("r10-window-period");
  const good = rest(h.fx, "POST", "/v1/observations", h.fx.keys.owner, {
    agent_id: h.fx.owner.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1000,
    window_to_ms: 2000,
    records: [],
  });
  assert.equal(good.status, 201, `a \`period\` WITH its bounds is a boundary this registry can state: ${good.raw}`);
  const periodDetail = (
    h.fx.db.prepare("SELECT window_detail FROM runtime_observations").get() as { window_detail: string }
  ).window_detail;
  assert.match(periodDetail, /1000/, "the boundary carries the bounds it was taken over [I-3]");
  assert.match(periodDetail, /2000/, "the boundary carries the bounds it was taken over [I-3]");
});

// ===========================================================================
// [10.5] `model` — a name of a model, and nothing else
// ===========================================================================

test("[10.5] a reporter cannot write a sentence into `runtime_observations.model`", () => {
  const f = fixture("r10-model");
  f.report({ window_detail: "the probe's own records, all time", model: TEXT, records: [] });
  f.report({ model: TEXT, records: [] });
  assert.ok(!journalBytes(f.fx.db).includes(KEY_LIKE), "the reporter's prose reached `model`");
  const rows = f.fx.db.prepare("SELECT model FROM runtime_observations").all() as Array<{ model: string | null }>;
  for (const r of rows) {
    assert.ok(r.model === null || /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,63}$/.test(r.model), `\`model\` held: ${r.model}`);
  }
});

test("[10.5b] an ordinary model name still goes through, or the column is useless", () => {
  const f = fixture("r10-model-ok");
  reportBoth(f, { model: "claude-opus-5", records: [] });
  const models = f.fx.db.prepare("SELECT model FROM runtime_observations").all() as Array<{ model: string | null }>;
  assert.equal(models.length, 1, "one report landed");
  assert.equal(models[0]!.model, "claude-opus-5");
});

// ===========================================================================
// [10.6] THE OTHER JOURNALS — the columns nine rounds never looked at
// ===========================================================================

test("[10.6] an adopter's idempotency key does not reach `receipt_events` word for word", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "r10-idem");
  adoptThroughSurfaces(fx, v, fx.keys.member, { terminal: "none" });
  const receipt = fx.db.prepare("SELECT id FROM adoption_receipts").get() as { id: string };
  const attempted = rest(fx, "POST", `/v1/receipts/${receipt.id}/events`, fx.keys.member, {
    event: "attempted",
    idempotency_key: TEXT,
  });
  assert.equal(attempted.status, 200, attempted.raw);
  const keys = fx.db.prepare("SELECT idempotency_key FROM receipt_events").all() as Array<{
    idempotency_key: string;
  }>;
  assert.ok(keys.length > 0, "the probe wrote no event");
  for (const k of keys) {
    assert.ok(!k.idempotency_key.includes(KEY_LIKE), `\`receipt_events\` held: ${k.idempotency_key}`);
    // EVERY key, the registry's own synthesized ones included: a column that
    // holds one kind of value is a column whose classification is exact
    assert.match(k.idempotency_key, /^sha256:[0-9a-f]{64}$/, `\`receipt_events\` held: ${k.idempotency_key}`);
  }
  // …and the key still replays, which is the whole of what a key is for
  const replay = rest(fx, "POST", `/v1/receipts/${receipt.id}/events`, fx.keys.member, {
    event: "attempted",
    idempotency_key: TEXT,
  });
  assert.equal(replay.status, 200, replay.raw);
  assert.equal(replay.body.noop, true, "a repeated key must replay, digest or no digest");
});

test("[10.6b] the transparency log takes an event kind of this registry's own, and a bounded subject", () => {
  const db = openMigrated();
  assert.throws(
    () => appendTlog(db, TEXT, "01ARZ3NDEKTSV4RRFFQ69G5FAV", { a: 1 }, 1),
    /event_kind|INVALID/i,
    "an event kind is one of this registry's own strings",
  );
  assert.throws(
    () => appendTlog(db, "version_revoked", TEXT, { a: 1 }, 1),
    /subject_id|INVALID/i,
    "a subject is an identifier, never a sentence",
  );
});

test("[10.6c] a deployment event carries a reason of this registry's own", () => {
  const db = openMigrated();
  assert.throws(
    () =>
      appendAssignmentEvent(db, {
        assignmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        event: "assigned",
        actor: { agent_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", type: "agent", role: "member" },
        reason: TEXT,
        idempotencyKey: "probe",
        nowMs: 1,
      }),
    /reason|INVALID/i,
    "`assignment_events.reason` is a reason this registry writes, not a note a caller supplies",
  );
});

// ===========================================================================
// [10.7] THE DECLARED LIMITS — said out loud in the shipped files
// ===========================================================================

test("[10.7] every declared limit is named in the files this package ships", () => {
  const db = openMigrated();
  const limits = declaredLimitColumns(db);
  assert.ok(limits.length > 0, "a survey with no declared limit has either closed everything or looked at nothing");
  const api = readFileSync(join(REPO_ROOT, "docs/API.md"), "utf8");
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  for (const key of limits) {
    const column = key.split(".")[1]!;
    assert.ok(api.includes(column), `\`${key}\` is a stated limit and \`docs/API.md\` does not name it`);
    assert.ok(spec.includes(column), `\`${key}\` is a stated limit and \`SPEC.md\` does not name it`);
    assert.ok(
      (JOURNAL_INTAKE[key]!.note ?? "").length > 40,
      `\`${key}\` is filed as a limit with no statement of what the limit IS`,
    );
  }
});

test("[10.7b] the limit is real and demonstrated, not merely written down", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "r10-limit");
  adoptThroughSurfaces(fx, v, fx.keys.member, { terminal: "none" });
  const receipt = fx.db.prepare("SELECT id FROM adoption_receipts").get() as { id: string };
  rest(fx, "POST", `/v1/receipts/${receipt.id}/events`, fx.keys.member, { event: "attempted" });
  const failed = rest(fx, "POST", `/v1/receipts/${receipt.id}/events`, fx.keys.member, {
    event: "failed",
    failure_report: { category: "gate_failed", summary: TEXT },
  });
  assert.equal(failed.status, 200, failed.raw);
  const stored = fx.db.prepare("SELECT failure_report_json FROM receipt_events WHERE event='failed'").get() as {
    failure_report_json: string;
  };
  assert.ok(
    stored.failure_report_json.includes(TEXT),
    "the §5.3 reports are the DECLARED limit of V-1: if this stopped being true the limit should be withdrawn, not left standing",
  );
  assert.equal(
    JOURNAL_INTAKE["receipt_events.failure_report_json"]!.intake,
    "declared_limit",
    "a column that demonstrably holds a caller's prose is a declared limit, and nothing else",
  );
});

// ===========================================================================
// [10.8] ONE WRITER PER JOURNAL — the boundary is a property of the journal
// ===========================================================================

test("[10.8] the modules that write each journal are the declared ones, and a new writer fails the build", () => {
  const db = openMigrated();
  const files = execFileSync("git", ["ls-files", "src/*.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.length > 0);
  for (const table of journalTablesOf(db)) {
    const writers = files
      .filter((f) => new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "i").test(readFileSync(join(REPO_ROOT, f), "utf8")))
      .sort();
    assert.deepEqual(
      writers,
      [...(JOURNAL_WRITERS[table] ?? [])].sort(),
      `\`${table}\` is written from ${writers.join(", ")}; \`JOURNAL_WRITERS\` in \`src/journal.ts\` declares ` +
        `${(JOURNAL_WRITERS[table] ?? []).join(", ") || "nothing"}. A rule enforced at one boundary is a property of ` +
        "that boundary and not of the journal.",
    );
  }
});

// ===========================================================================
// [10.9] THE SENTENCES THAT WERE NOT TRUE
// ===========================================================================

test("[10.9] no shipped file says the ALPHABET is what closes the channel", () => {
  for (const [rel, text] of documentSet()) {
    assert.ok(
      !/the\s+ALPHABET\s+is\b/i.test(text),
      `${rel} says the alphabet is what closes the channel; the same file says a bounded alphabet can carry an encoding`,
    );
  }
});

test("[10.9b] no shipped file still requires a declared evidence name to be presented", () => {
  for (const [rel, text] of documentSet()) {
    assert.ok(
      !/for the check to be executable/i.test(text),
      `${rel}: a declared name has not been a precondition of the verdict since round 9`,
    );
    assert.ok(
      !/values that MUST be presented/i.test(text),
      `${rel}: \`outcome_contract.evidence\` declares what a run OUGHT to present; nothing requires it`,
    );
  }
});

// ===========================================================================
// [10.10] AND THE NEW SENTENCES DO NOT PROMISE THE UNACHIEVABLE
// ===========================================================================

const UNACHIEVABLE: RegExp[] = [
  /no secret (can|could|will) (ever )?(be|reach|enter)/i,
  /secrets? (can|could) never (be|reach|enter)/i,
  /impossible (for|to put) a secret/i,
  /cannot (hold|contain|carry) a secret/i,
];

test("[10.10] no shipped file promises that a secret cannot be in a journal", () => {
  for (const [rel, text] of documentSet()) {
    for (const pattern of UNACHIEVABLE) {
      assert.ok(!pattern.test(text), `${rel} promises what no alphabet delivers (${pattern})`);
    }
  }
});

test("[10.10b] and the achievable sentence is the one that is written, exception and all", () => {
  const journal = readFileSync(join(REPO_ROOT, "src/journal.ts"), "utf8");
  assert.match(
    journal,
    /puts no caller's text into a journal/i,
    "the deliverable is stated in the shipped file that enforces it",
  );
  assert.match(
    journal,
    /except in the columns this file names as declared limits/i,
    "…and its exception is INSIDE the sentence, not in a footnote a reader drops",
  );
  assert.match(journal, /bounded alphabet/i, "and the limit of that statement is stated beside it");
});
