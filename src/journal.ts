// THE JOURNALS OF THIS REGISTRY, COLUMN BY COLUMN — what each one is allowed
// to hold, and where the set of columns comes from.
//
// WHY THIS FILE EXISTS, WHICH IS NOT THE SAME AS WHAT IT DOES.
//
//   Nine passes of independent review found four channels by which a caller's
//   text reached a journal. Each was found alone, each was closed, and each
//   closing note said the class was closed. The common cause was never the
//   quality of a fix: it was that THE SURFACE WAS NEVER WRITTEN DOWN. A repair
//   aimed at the column somebody pointed at is not evidence about a set nobody
//   has enumerated.
//
//   Twice the opposite worked in this repository. The set of MCP tools was
//   taken FROM THE CODE and the tool findings stopped recurring. The set of
//   shipped documents was taken from `git ls-files` and then from
//   `npm pack --json` and the document findings stopped recurring. What changed
//   was the SOURCE OF THE SET.
//
// SO THE SET COMES FROM THE SCHEMA, AND THE JUDGEMENT COMES FROM HERE.
//
//   A JOURNAL is a table the schema itself marks as one: it carries a
//   `BEFORE UPDATE` trigger raising `INSERT_ONLY`. That is the repository's own
//   definition — `migrations/0008` names `transfers`, `receipt_events` and
//   `assignment_events` as "the rule these live under" — and `journalTablesOf`
//   reads it out of `sqlite_master`, so a journal added by a future migration
//   is in the set the moment it exists and without anybody remembering to add
//   it here. The COLUMNS come from `PRAGMA table_info` for the same reason.
//
//   `JOURNAL_INTAKE` below classifies every one of them. A column present in
//   the schema and absent here is reported by `surveyJournalIntake` and FAILS
//   THE BUILD: the next column somebody adds cannot be filed quietly, which is
//   the property that the four separate discoveries above did not have.
//
// THE FIVE CLASSES, AND WHY `free_text` IS ONE OF THEM.
//
//   `registry_generated` — the caller does not influence the value at all.
//   `bounded_form`       — an enum, an identifier, a number, a boolean: a form
//                          this registry defined and refuses anything outside.
//   `digest`             — stored as `sha256:<64 lowercase hex>`. Equality
//                          survives, which is all a correlation key needs.
//   `declared_limit`     — a caller's text is admitted, ON PURPOSE, and the
//                          limit is STATED in the files this package ships.
//   `free_text`          — a caller's text is admitted and nobody decided that.
//
//   `free_text` is not a resting place. `surveyJournalIntake` returns those
//   columns separately and a probe requires the list to be EMPTY. It exists so
//   that the survey can NAME the defect rather than lack a word for it, and so
//   that the red commit of a round could record what the tree actually held.
//
// WHAT IS DELIVERED, STATED SO THAT NOTHING LARGER IS IMPLIED.
//
//   THIS REGISTRY DOES NOT PUT TEXT INTO ITS JOURNALS, THE FORMS IT ACCEPTS
//   THERE ARE ITS OWN, AND WHERE A CALLER'S TEXT IS STILL ADMITTED THAT IS
//   NAMED AS A LIMIT.
//
//   The larger sentence — that a secret cannot be in a journal — is FALSE under
//   every alphabet and is written nowhere. A bounded alphabet can be made to
//   carry an encoding by somebody who sets out to build one, exactly as the
//   flat list of thirty-two integers an evidence value may be can; a bound on a
//   number bounds a quantity of bits and not their meaning. The property that
//   is enforced is the first sentence, and it is the one worth having: a
//   registry that accumulates transcripts is a registry that holds material
//   nobody meant to give it.
import type { Db } from "./sqlite.ts";

export type JournalIntake =
  | "registry_generated"
  | "bounded_form"
  | "digest"
  | "declared_limit"
  | "free_text";

export interface JournalColumnClass {
  intake: JournalIntake;
  /** what the column holds — and, for `declared_limit`, what the limit IS */
  note: string;
}

/** `<table>.<column>` → what that column is allowed to take, and from whom. */
export const JOURNAL_INTAKE: Record<string, JournalColumnClass> = {
  // ------------------------------------------------------- adoption_receipts
  "adoption_receipts.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "adoption_receipts.adoption_request_id": { intake: "registry_generated", note: "a row of this registry" },
  "adoption_receipts.skill_version_id": { intake: "registry_generated", note: "a row of this registry" },
  "adoption_receipts.adopter_agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "adoption_receipts.created_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ------------------------------------------------------- assignment_events
  "assignment_events.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "assignment_events.assignment_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignment_events.event": { intake: "bounded_form", note: "the eight §5.5 deployment states" },
  "assignment_events.event_seq": { intake: "registry_generated", note: "derived from the head of the chain" },
  "assignment_events.reason": {
    intake: "free_text",
    note: "every writer passes one of this registry's own phrases; nothing refuses another",
  },
  "assignment_events.actor_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "assignment_events.actor_type": { intake: "bounded_form", note: "human|agent|service" },
  "assignment_events.actor_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "assignment_events.grant_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignment_events.grant_action": { intake: "bounded_form", note: "the five [I-8] actions" },
  "assignment_events.activation_target": { intake: "bounded_form", note: "the four native layouts" },
  "assignment_events.native_relpath": {
    intake: "registry_generated",
    note: "composed by the activation adapter from the target and the skill's own slug",
  },
  "assignment_events.managed_copy": { intake: "bounded_form", note: "written|removed|absent|retained" },
  "assignment_events.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "assignment_events.idempotency_key": {
    intake: "registry_generated",
    note: "`<event>:<clock>:<seq>` and `assigned:<id>`, composed here; the caller's own key never reaches this column",
  },

  // ------------------------------------------------------------- assignments
  "assignments.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "assignments.skill_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignments.skill_version_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignments.agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "assignments.recipient_kind": { intake: "bounded_form", note: "local_agent|remote_fleet [B-8]" },
  "assignments.transfer_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignments.assigned_by_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "assignments.assigned_by_type": { intake: "bounded_form", note: "human|agent|service" },
  "assignments.assigned_by_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "assignments.created_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // -------------------------------------------------------- observed_records
  "observed_records.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "observed_records.observation_id": { intake: "registry_generated", note: "the report this record arrived on" },
  "observed_records.agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "observed_records.runtime": { intake: "bounded_form", note: "claude_code|codex" },
  "observed_records.role": { intake: "bounded_form", note: "proposal|call|output" },
  "observed_records.call_id": {
    intake: "free_text",
    note: "the reporter's own id, stored word for word, bounded only in length (1..200)",
  },
  "observed_records.at_ms": { intake: "bounded_form", note: "a positive integer" },
  "observed_records.marker": {
    intake: "bounded_form",
    note: "`SKLN1-` and sixteen Crockford base32 characters — the §5 form, reduced from the record's text by `markersIn`",
  },
  "observed_records.result": { intake: "bounded_form", note: "success|failure|unknown" },
  "observed_records.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "observed_records.evidence": {
    intake: "bounded_form",
    note: "keys are `EVIDENCE_NAMES`, this registry's own four; values are a boolean, a safe integer, a `sha256:` digest, or a flat list of at most 32 of those (`isAdmissibleEvidenceValue`, `src/outcome.ts`)",
  },

  // ----------------------------------------------------------- receipt_events
  "receipt_events.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "receipt_events.adoption_receipt_id": { intake: "registry_generated", note: "a row of this registry" },
  "receipt_events.event": { intake: "bounded_form", note: "the seven §5.3 receipt events" },
  "receipt_events.event_seq": { intake: "registry_generated", note: "derived from the head of the chain" },
  "receipt_events.evidence_json": {
    intake: "free_text",
    note: "the adopter's §5.3 evidence, validated against the version's declared validation_gates and stored as sent",
  },
  "receipt_events.failure_report_json": {
    intake: "free_text",
    note: "the adopter's §5.3 failure report, schema-checked in shape and free in its prose fields",
  },
  "receipt_events.rollback_report_json": {
    intake: "free_text",
    note: "the adopter's §5.3 rollback report, schema-checked in shape and free in its prose fields",
  },
  "receipt_events.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "receipt_events.idempotency_key": {
    intake: "free_text",
    note: "the adopter's own key, stored word for word, bounded only in length (1..128)",
  },
  "receipt_events.environment_json": {
    intake: "free_text",
    note: "the adopter's declared environment, validated against Appendix E.2 and stored as sent",
  },
  "receipt_events.recipient_json": {
    intake: "registry_generated",
    note: "written only under `asRegistry`: the typed kind and the resolved principal's own id [I-6]",
  },

  // ---------------------------------------------------- runtime_observations
  "runtime_observations.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "runtime_observations.agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "runtime_observations.runtime": { intake: "bounded_form", note: "claude_code|codex" },
  "runtime_observations.model": {
    intake: "free_text",
    note: "`String(input.model).slice(0, 200)` — any 200 characters the reporter sends",
  },
  "runtime_observations.session_active": { intake: "bounded_form", note: "a boolean, or NULL for `unknown`" },
  "runtime_observations.last_activity_ms": { intake: "bounded_form", note: "a positive integer, or NULL" },
  "runtime_observations.selection_window": { intake: "bounded_form", note: "live_session|period|all_time" },
  "runtime_observations.window_detail": {
    intake: "free_text",
    note: "any 1..500 characters the reporter sends, published verbatim as the boundary of every cell derived from the report",
  },
  "runtime_observations.proposal_inventory_complete": { intake: "bounded_form", note: "a boolean" },
  "runtime_observations.records_read": { intake: "bounded_form", note: "a non-negative integer" },
  "runtime_observations.reported_by_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "runtime_observations.reported_by_type": { intake: "bounded_form", note: "human|agent|service [I-5]" },
  "runtime_observations.reported_by_role": { intake: "bounded_form", note: "owner|admin|reviewer|member [I-5]" },
  "runtime_observations.grant_id": { intake: "registry_generated", note: "the §6.2 grant this report ran under" },
  "runtime_observations.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "runtime_observations.idempotency_key": {
    intake: "registry_generated",
    note: "`observation:<ULID>`, composed here; the caller's own key never reaches this column",
  },

  // ----------------------------------------------------------------- transfers
  "transfers.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "transfers.skill_version_id": { intake: "registry_generated", note: "a row of this registry" },
  "transfers.sender_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "transfers.sender_type": { intake: "bounded_form", note: "human|agent|service" },
  "transfers.sender_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "transfers.recipient_kind": { intake: "bounded_form", note: "local_agent|remote_fleet [B-8]" },
  "transfers.recipient_ref": {
    intake: "registry_generated",
    note: "the RESOLVED recipient's own id: the caller names a principal, this registry writes the row it found",
  },
  "transfers.grant_id": { intake: "registry_generated", note: "a row of this registry" },
  "transfers.grant_action": { intake: "bounded_form", note: "the five [I-8] actions" },
  "transfers.grantor_agent_id": { intake: "registry_generated", note: "read off the grant row" },
  "transfers.grantor_type": { intake: "bounded_form", note: "human|agent|service" },
  "transfers.grantor_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "transfers.arrival_marker": {
    intake: "registry_generated",
    note: "derived from the skill version's own id [M-1] (`arrivalMarker`, `src/marker.ts`)",
  },
  "transfers.adoption_receipt_id": { intake: "registry_generated", note: "a row of this registry" },
  "transfers.receipt_event_seq": { intake: "registry_generated", note: "derived from the head of the chain" },
  "transfers.created_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ---------------------------------------------------------- transparency_log
  "transparency_log.seq": { intake: "registry_generated", note: "AUTOINCREMENT" },
  "transparency_log.event_kind": {
    intake: "free_text",
    note: "every writer passes one of this registry's own constants; nothing refuses another",
  },
  "transparency_log.subject_id": {
    intake: "free_text",
    note: "a ULID or a `kid` at every writer; the column and the append take any string",
  },
  "transparency_log.payload_hash": { intake: "digest", note: "SHA-256 of the JCS payload" },
  "transparency_log.prev_hash": { intake: "digest", note: "the previous row's hash" },
  "transparency_log.this_hash": { intake: "digest", note: "SHA-256 over the canonical row" },
  "transparency_log.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
};

/**
 * THE MODULES THAT WRITE EACH JOURNAL — declared, so that a new one is noticed.
 *
 * NOT "exactly one writer", because that is not true and this file does not say
 * things that are not true: `adoption_receipts` is written by `src/service.ts`
 * on the adoption path and by `src/transfer.ts` in the transaction that opens a
 * transfer chain, and both write values of this registry's own. What matters
 * for the classification above is that the set of places a column can be filled
 * from is KNOWN: a rule enforced at one boundary is a property of that boundary
 * and not of the journal, and the way that stops being true is a second writer
 * appearing quietly. A probe scans `src/*.ts` for `INSERT INTO <table>` and
 * compares what it finds against this table.
 */
export const JOURNAL_WRITERS: Record<string, readonly string[]> = {
  adoption_receipts: ["src/service.ts", "src/transfer.ts"],
  assignment_events: ["src/assignments.ts"],
  assignments: ["src/assignments.ts"],
  observed_records: ["src/fleet-store.ts"],
  receipt_events: ["src/receipts.ts"],
  runtime_observations: ["src/fleet-store.ts"],
  transfers: ["src/transfer.ts"],
  transparency_log: ["src/tlog.ts"],
};

/**
 * THE JOURNALS, READ OUT OF THE LIVE SCHEMA.
 *
 * A table with a `BEFORE UPDATE` trigger that raises `INSERT_ONLY` is a journal
 * — the schema's own mark, not a list kept here. A migration that adds one puts
 * it in this set without editing this file, which is the point.
 */
export function journalTablesOf(db: Db): string[] {
  const rows = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  const tables = new Set<string>();
  for (const row of rows) {
    if (!/INSERT_ONLY/.test(row.sql)) continue;
    const m = /BEFORE\s+UPDATE\s+ON\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(row.sql);
    if (m) tables.add(m[1]!);
  }
  return [...tables].sort();
}

/** The columns of one table, from `PRAGMA table_info` and from nowhere else. */
export function journalColumnsOf(db: Db, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export interface JournalSurvey {
  /** every `<table>.<column>` of every journal, from the schema */
  columns: string[];
  /** in the schema, absent from `JOURNAL_INTAKE` — a build failure */
  unclassified: string[];
  /** in `JOURNAL_INTAKE`, absent from the schema — a claim about nothing */
  stale: string[];
  /** classified `free_text`: a caller's text, admitted, with nobody's decision */
  freeText: string[];
  /** classified `declared_limit`: a caller's text, admitted, and said so */
  declaredLimits: string[];
}

/**
 * THE SURVEY. Set from the schema, judgement from `JOURNAL_INTAKE`, and the
 * two compared in both directions — a classification that outlives its column
 * is as much a lie as a column nobody classified.
 */
export function surveyJournalIntake(db: Db): JournalSurvey {
  const columns: string[] = [];
  for (const table of journalTablesOf(db)) {
    for (const column of journalColumnsOf(db, table)) columns.push(`${table}.${column}`);
  }
  columns.sort();
  const unclassified = columns.filter((c) => JOURNAL_INTAKE[c] === undefined);
  const known = new Set(columns);
  const stale = Object.keys(JOURNAL_INTAKE)
    .filter((c) => !known.has(c))
    .sort();
  const freeText = columns.filter((c) => JOURNAL_INTAKE[c]?.intake === "free_text");
  const declaredLimits = columns.filter((c) => JOURNAL_INTAKE[c]?.intake === "declared_limit");
  return { columns, unclassified, stale, freeText, declaredLimits };
}

/** The columns whose limit this package states out loud. */
export function declaredLimitColumns(db: Db): string[] {
  return surveyJournalIntake(db).declaredLimits;
}
