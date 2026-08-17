#!/usr/bin/env node
// P5 DELIVERABLE 8 — THE STAGE/OUTCOME CONSISTENCY VALIDATOR.
//
//   node --experimental-strip-types --no-warnings v1/tools/p5-outcome-consistency-check.ts <database>
//
// WHY THIS EXISTS AND WHAT IT IS NOT. P5 BUILD-1 closed this deliverable by
// narrowing it: the rules live in `migrations/0017`'s CHECK constraints and in
// `src/outcome-loop.ts`, so a validator that re-read the same rows would restate
// them. That is true of the rules a CHECK can express — and a CHECK is ROW-LOCAL.
// It can say that a `worked` names an invocation receipt; it cannot say that the
// receipt it names belongs to the same session and the same entry, that its
// `invocation_ref` is the one the outcome claims, that a `rolled_back` names a
// lifecycle event that really selected the revision it says was rolled back, or
// that a session confirming a rollback opened AFTER the decision. Those are
// JOINS, and the narrowing did not cover them. This harness is the join half,
// and nothing else: fifteen statements over the rows a real run leaves behind.
//
// It is deliberately not an observability platform, a metrics system or a
// framework — P5's OUT list forbids all three. It has no configuration, no
// plugins, no output format and no schedule. It reads a database and exits 0 or 1.
//
// WHAT IT NEVER DOES. It opens the database READ-ONLY and writes nothing, so it
// cannot repair what it finds and cannot be mistaken for a migration. Point it at
// a disposable database or a copy; the runtime gates and the browser gate each
// leave one behind, which is what makes this a check over REAL rows rather than
// over fixtures it made itself.
//
// EXIT CODES, the same as every other harness in this tree:
//   0  every statement held
//   1  a statement did not hold — the rows contradict the phase's claims
//   2  REFUSED — no database to read, or it has no P5 tables
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { openReadOnly } from "../../src/db.ts";
import { jcsCanonicalize, type JcsValue } from "../../src/jcs.ts";

const path = process.argv[2];
if (!path) {
  console.error("REFUSED: name the database to check.");
  console.error("usage: p5-outcome-consistency-check.ts <database>");
  process.exit(2);
}
if (!existsSync(path)) {
  console.error(`REFUSED: ${path} does not exist.`);
  process.exit(2);
}

const db = openReadOnly(path);
const tables = new Set(
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
);
for (const required of ["session_outcomes", "session_closures", "outcome_conflicts", "revision_sources", "revision_comparisons"]) {
  if (!tables.has(required)) {
    console.error(`REFUSED: ${path} has no \`${required}\`; this is not a database migrated past 0017.`);
    process.exit(2);
  }
}

let failures = 0;
const rows = (sql: string): Array<Record<string, unknown>> => db.prepare(sql).all() as Array<Record<string, unknown>>;

/** One statement about the rows. `bad` is what must be EMPTY; whatever is in it
 *  is printed, because a count is not evidence. */
function hold(statement: string, bad: Array<Record<string, unknown>>): void {
  if (bad.length === 0) {
    console.log(`PASS  ${statement}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${statement}  — ${bad.length} row(s)`);
  for (const row of bad.slice(0, 5)) console.log(`      ${JSON.stringify(row)}`);
  if (bad.length > 5) console.log(`      …and ${bad.length - 5} more`);
}

/** The usual form: `offenders` is the query that must return NOTHING. */
function must(statement: string, offenders: string): void {
  hold(statement, rows(offenders));
}

/** The digest the registry takes over a payload, from the registry's own
 *  canonicaliser rather than a second implementation of it. Statement 6 below
 *  re-derives two of these, which is the only thing in this harness SQL cannot
 *  express at all. */
function digestOf(payload: unknown): string {
  return `sha256:${createHash("sha256").update(jcsCanonicalize(payload as JcsValue), "utf8").digest("hex")}`;
}

const counted = rows(
  `SELECT (SELECT count(*) FROM session_outcomes) outcomes,
          (SELECT count(*) FROM session_closures) closures,
          (SELECT count(*) FROM outcome_conflicts) conflicts,
          (SELECT count(*) FROM revision_sources) lineage,
          (SELECT count(*) FROM revision_comparisons) comparisons`,
)[0]!;
console.log(`database: ${path}`);
console.log(
  `rows:     ${counted.outcomes} outcomes · ${counted.closures} closures · ${counted.conflicts} conflicts · ` +
    `${counted.lineage} lineage · ${counted.comparisons} comparisons`,
);
console.log();

// 1. AN OUTCOME IS AN OUTCOME OF ITS OWN SESSION'S ENTRY (`INV-06`). The entry it
//    names must belong to the loadout of the session it names, and its revision
//    and digest must be the entry's — an outcome about other bytes than the ones
//    a runtime was given is an outcome about nothing.
must(
  "every outcome names an entry of its own session's loadout, at that entry's exact revision and digest",
  `SELECT o.id, o.session_id, o.loadout_entry_id
     FROM session_outcomes o
     LEFT JOIN session_loadout_entries e ON e.id = o.loadout_entry_id
     LEFT JOIN session_loadouts l ON l.id = e.loadout_id
    WHERE e.id IS NULL
       OR l.session_id <> o.session_id
       OR o.loadout_id <> e.loadout_id
       OR o.assignment_id <> e.assignment_id
       OR o.draft_revision_id <> e.draft_revision_id
       OR o.content_digest <> e.content_digest`,
);

// 2/3. `P5-FR-02` ACROSS TABLES. A runtime-reported outcome rests on an `invoked`
//    RECEIPT, and that receipt must be the same session's, the same entry's and
//    carry the same invocation and runtime session refs the outcome claims.
must(
  "every runtime-reported outcome rests on an `invoked` receipt of the same session and entry",
  `SELECT o.id, o.invocation_receipt_id, r.stage
     FROM session_outcomes o
     LEFT JOIN runtime_receipts r ON r.id = o.invocation_receipt_id
    WHERE o.evidence_class = 'runtime_receipt'
      AND (r.id IS NULL OR r.stage <> 'invoked' OR r.session_id <> o.session_id OR r.loadout_entry_id <> o.loadout_entry_id)`,
);
must(
  "and the receipt it rests on carries the same invocation_ref and runtime_session_ref the outcome claims",
  `SELECT o.id, o.invocation_ref, r.invocation_ref AS receipt_invocation_ref
     FROM session_outcomes o
     JOIN runtime_receipts r ON r.id = o.invocation_receipt_id
    WHERE o.evidence_class = 'runtime_receipt'
      AND (o.invocation_ref IS NOT r.invocation_ref OR o.runtime_session_ref IS NOT r.runtime_session_ref)`,
);
must(
  "no `worked` exists without either an invocation receipt or an owner confirmation naming where the owner saw it",
  `SELECT o.id, o.evidence_class, o.confirmation_source
     FROM session_outcomes o
    WHERE o.outcome = 'worked'
      AND NOT (o.evidence_class = 'runtime_receipt' AND o.invocation_receipt_id IS NOT NULL)
      AND NOT (o.evidence_class = 'owner_confirmation' AND o.source = 'owner' AND o.confirmation_source IS NOT NULL)`,
);

// 4. `P5-FR-04`: A `nothing_reported` IS WRITTEN BY A CLOSURE, and only for an
//    entry that had nothing else. Its time is the closure's.
must(
  "every `nothing_reported` belongs to a session that really closed, and carries that closure's time",
  `SELECT o.id, o.session_id, o.observed_at_ms, c.closed_at_ms
     FROM session_outcomes o
     LEFT JOIN session_closures c ON c.session_id = o.session_id
    WHERE o.outcome = 'nothing_reported' AND (c.id IS NULL OR o.observed_at_ms <> c.closed_at_ms)`,
);
must(
  "no entry holds a `nothing_reported` beside another outcome — the closure writes one only where nothing was reported",
  `SELECT o.id, o.loadout_entry_id
     FROM session_outcomes o
    WHERE o.outcome = 'nothing_reported'
      AND EXISTS (SELECT 1 FROM session_outcomes x WHERE x.loadout_entry_id = o.loadout_entry_id AND x.id <> o.id)`,
);

// 5. `P5-FR-05`, `P5-FR-13`: A ROLLBACK CONFIRMATION IS ABOUT A ROLLBACK THAT
//    HAPPENED, and it is confirmed by a session that opened AFTER the decision
//    while carrying the target at its exact digest.
must(
  "every `rolled_back` names a lifecycle event that really selected the revision it says was rolled back, for its own assignment",
  `SELECT o.id, o.rollback_action_event_id, o.rollback_to_revision_id
     FROM session_outcomes o
     LEFT JOIN skill_assignment_events ev ON ev.id = o.rollback_action_event_id
    WHERE o.outcome = 'rolled_back'
      AND (ev.id IS NULL
        OR ev.event <> 'revision_selected'
        OR ev.assignment_id <> o.assignment_id
        OR ev.desired_revision_id <> o.rollback_to_revision_id
        OR o.draft_revision_id <> o.rollback_to_revision_id)`,
);
// `P5-R1-001`: and that the selection went BACK. The event's immediate
//    predecessor in the journal — `event_seq` orders it, and the table is
//    INSERT-only by trigger — names the revision that was in force before it, so
//    a rollback is a target whose `revision` number is LOWER than that one's. An
//    `update` filed as a rollback is a false causal record and is refused here
//    without reading the label the event carries.
must(
  "and that selection really went BACK — a lower revision than the one in force before it, read from the journal",
  `SELECT o.id, o.rollback_action_event_id, ev.event_seq,
          target.revision AS selected_revision, before.revision AS revision_in_force_before
     FROM session_outcomes o
     JOIN skill_assignment_events ev ON ev.id = o.rollback_action_event_id
     LEFT JOIN draft_revisions target ON target.id = ev.desired_revision_id
     LEFT JOIN skill_assignment_events prev
            ON prev.assignment_id = ev.assignment_id
           AND prev.event_seq = (SELECT max(p.event_seq) FROM skill_assignment_events p
                                  WHERE p.assignment_id = ev.assignment_id AND p.event_seq < ev.event_seq)
     LEFT JOIN draft_revisions before ON before.id = prev.desired_revision_id
    WHERE o.outcome = 'rolled_back'
      AND (target.revision IS NULL OR before.revision IS NULL OR target.revision >= before.revision)`,
);
// `P5-R1-002`: and that the confirming session opened STRICTLY after the
//    decision. `server_at_ms` alone cannot separate two operations of one
//    millisecond; the monotonic `ulid()` both ids come from can, so the order is
//    over the pair and the session must be the later member of it.
must(
  "and the session that confirmed it opened AFTER that decision, by (server_at_ms, id) and not by the millisecond alone",
  `SELECT o.id, s.server_at_ms AS session_opened_ms, ev.server_at_ms AS decided_ms,
          s.id AS session_id, ev.id AS event_id
     FROM session_outcomes o
     JOIN skill_assignment_events ev ON ev.id = o.rollback_action_event_id
     JOIN agent_sessions s ON s.id = o.session_id
    WHERE o.outcome = 'rolled_back'
      AND NOT (s.server_at_ms > ev.server_at_ms
               OR (s.server_at_ms = ev.server_at_ms AND s.id > ev.id))`,
);

// 6. `P5-FR-07`: A RECORDED CONFLICT IS ABOUT A ROW THAT STANDS, under the same
//    `outcome_ref` and the same entry, and the claim it carries really is a
//    different claim.
//
//    `P5-R2-002`: this statement used to read `claimed_outcome = existing_outcome`
//    as its definition of "does not really contradict it", and that is not what a
//    conflict is here. `src/outcome-loop.ts` compares the WHOLE payload digest, so
//    two claims may agree on the normalised value and disagree on the structured
//    reason or provenance — the same `worked` for two different stated reasons is
//    a genuine disagreement, and the validator refused a database its own product
//    had just written. What makes a conflict real is that the payloads differ, so
//    that is what is checked: the claimed payload is re-digested with the
//    registry's own canonicaliser and must not be the digest of the outcome that
//    stands. The row's own `conflict_digest` is re-derived too, so a planted row
//    cannot carry an arbitrary claim beside a digest that commits to another one.
hold(
  "every recorded conflict names the outcome that stands, under the same outcome_ref and the same entry, and its claimed payload really differs",
  (
    rows(
      `SELECT c.id, c.loadout_entry_id, c.outcome_ref, c.existing_outcome, c.claimed_outcome,
              c.existing_outcome_id, c.claimed_payload_json, c.conflict_digest,
              o.id AS stands_id, o.loadout_entry_id AS stands_entry, o.outcome_ref AS stands_ref,
              o.outcome AS stands_outcome, o.outcome_digest AS stands_digest
         FROM outcome_conflicts c
         LEFT JOIN session_outcomes o ON o.id = c.existing_outcome_id`,
    ) as Array<Record<string, string | null>>
  ).flatMap((c) => {
    const offender = (why: string) => [{ id: c.id, existing_outcome_id: c.existing_outcome_id, why }];
    if (c.stands_id === null) return offender("the outcome it says stands does not exist");
    if (c.stands_entry !== c.loadout_entry_id) return offender("it is filed against another entry than the outcome that stands");
    if (c.stands_ref !== c.outcome_ref) return offender("it is filed under another outcome_ref than the outcome that stands");
    if (c.stands_outcome !== c.existing_outcome) return offender("it misreports what the outcome that stands says");
    let claimedDigest: string;
    try {
      claimedDigest = digestOf(JSON.parse(c.claimed_payload_json!));
    } catch {
      return offender("its claimed payload is not readable JSON");
    }
    if (claimedDigest === c.stands_digest) {
      return offender("its claimed payload is the SAME claim as the outcome that stands, so nothing was contradicted");
    }
    const expected = digestOf({
      existing_outcome_id: c.existing_outcome_id,
      existing_digest: c.stands_digest,
      claimed_digest: claimedDigest,
      outcome_ref: c.outcome_ref,
    });
    if (expected !== c.conflict_digest) return offender("its conflict_digest does not commit to the claim it carries");
    return [];
  }),
);

// 7. `P5-FR-08`: A LINEAGE ROW IS ABOUT A REVISION THAT DESCENDS FROM THE OUTCOME
//    IT NAMES — same lineage, and the parent is the revision that outcome was
//    filed against.
must(
  "every revision made from an outcome names that outcome's own revision as its parent, in the same lineage",
  `SELECT rs.id, rs.parent_revision_id, o.draft_revision_id
     FROM revision_sources rs
     LEFT JOIN session_outcomes o ON o.id = rs.source_outcome_id
    WHERE o.id IS NULL
       OR rs.parent_revision_id <> o.draft_revision_id
       OR rs.draft_id <> o.draft_id
       OR rs.source_session_id <> o.session_id
       OR (rs.origin = 'failure' AND o.outcome <> 'failed')`,
);

// 8. `P5-FR-11`, `P5-FR-12`: A CONFIRMED IMPROVEMENT IS A COMPARABLE SCENARIO AND
//    A GOAL STATED IN ADVANCE. This is the one statement that cannot be a CHECK
//    at all: `comparable` and `verdict` are about the two SESSIONS behind the two
//    outcomes.
must(
  "every comparison judges a candidate that was created from its own baseline outcome",
  `SELECT k.id, k.baseline_outcome_id, rs.source_outcome_id
     FROM revision_comparisons k
     LEFT JOIN revision_sources rs ON rs.id = k.revision_source_id
    WHERE rs.id IS NULL
       OR rs.source_outcome_id <> k.baseline_outcome_id
       OR rs.draft_revision_id <> k.candidate_revision_id`,
);
must(
  "no comparison is marked comparable unless the two runs share the lineage, the agent and the runtime kind",
  `SELECT k.id, bs.agent_id AS baseline_agent, cs.agent_id AS candidate_agent,
          bs.runtime_kind AS baseline_runtime, cs.runtime_kind AS candidate_runtime
     FROM revision_comparisons k
     JOIN session_outcomes bo ON bo.id = k.baseline_outcome_id
     JOIN session_outcomes co ON co.id = k.candidate_outcome_id
     JOIN agent_sessions bs ON bs.id = bo.session_id
     JOIN agent_sessions cs ON cs.id = co.session_id
    WHERE k.comparable = 1
      AND (bs.agent_id <> cs.agent_id OR bs.runtime_kind <> cs.runtime_kind OR bo.draft_id <> co.draft_id)`,
);
must(
  "and no comparison says `improved` unless it is comparable and the candidate really worked",
  `SELECT k.id, k.verdict, k.comparable, k.candidate_outcome
     FROM revision_comparisons k
    WHERE k.verdict = 'improved' AND (k.comparable <> 1 OR k.candidate_outcome <> 'worked')`,
);

// 9. THE STAGE HALF OF "STAGE/OUTCOME CONSISTENCY": NOTHING HERE WROTE A STAGE.
//    P5 files outcomes and closures; the observed STAGE of an entry stays what a
//    `0016` receipt made it (`INV-02`, `P4-FR-13`). An observation whose source is
//    an owner would be this phase having crossed that line.
must(
  "no assignment observation was written by an owner, so no outcome moved an observed stage",
  `SELECT id, source, observed_status FROM assignment_observations WHERE source NOT IN ('backend','adapter','runtime')`,
);

console.log();
if (failures > 0) {
  console.log(`FAIL  ${failures} statement(s) did not hold over these rows.`);
  process.exit(1);
}
console.log("PASS  every stage/outcome consistency statement holds over these rows.");
process.exit(0);
