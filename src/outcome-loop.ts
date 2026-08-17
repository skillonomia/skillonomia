// V1 P5 — THE NORMALISED OUTCOME, AND THE LOOP THAT COMES BACK FROM IT.
//
// P4 ended the chain at `invoked`: a runtime read an exact revision and called
// it. Whether calling it HELPED is a different fact with a different source, and
// this module is where that fact is normalised, persisted and read back.
//
// THE FOUR VALUES, AND WHY THERE IS NO FIFTH (`P5-FR-01`).
//
//   `worked`            the invocation did what the skill exists to do
//   `failed`            it did not, with a structured reason
//   `rolled_back`       a previously approved revision was selected instead, and
//                       a NEW session confirmed it
//   `nothing_reported`  the session ended and nobody said
//
// `nothing_reported` is the honest answer and it is deliberately not a success.
// A loop whose default is "presumably fine" measures its own optimism.
//
// WHAT AN OUTCOME IS NOT. It is not a STAGE. `proposed`, `loaded` and `invoked`
// live in `assignment_observations` and are written by `0016`'s receipts alone;
// nothing here writes into that table, so an owner's confirmation that a skill
// worked can never become the registry's claim that a runtime loaded one
// (`INV-02`, `P4-FR-13`). The two vocabularies stay separate on purpose.
//
// WHERE THE OWNER IS ALLOWED IN, AND HOW NARROWLY. `P5-FR-02` permits `worked`
// on "an explicit owner confirmation that carries its source" as the alternative
// to runtime outcome evidence. That is a real carve-out and it is implemented as
// one: `evidence_class='owner_confirmation'`, `source='owner'`, a required
// `confirmation_source` naming WHERE the owner saw it, and the fact that such a
// row is labelled as an owner's word everywhere it is read. It is never merged
// with runtime evidence and never promoted to a stage.
import { createHash } from "node:crypto";
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";
import { jcsCanonicalize, type JcsValue } from "./jcs.ts";
import {
  loadoutOfSession,
  loadoutEntries,
  receiptsOfEntry,
  type LoadoutEntryRow,
  type SessionRow,
} from "./session-loadout.ts";
import type { EvidenceSource } from "./evidence-principal.ts";

// ------------------------------------------------------------- the vocabulary

/** Exactly the four of `P5-FR-01`, and the CHECK in `0017` is this list. */
export const OUTCOMES = ["worked", "failed", "rolled_back", "nothing_reported"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(v: unknown): v is Outcome {
  return typeof v === "string" && (OUTCOMES as readonly string[]).includes(v);
}

/** What an outcome row RESTS ON. A reader that knows the value and not the class
 *  cannot tell an owner's word from a runtime's receipt, which is the one
 *  distinction `P5-FR-02` turns on. */
export const EVIDENCE_CLASSES = [
  "runtime_receipt",
  "owner_confirmation",
  "session_closed",
  "rollback_confirmation",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** `INV-05`: the versioned marker every answer of this surface carries, so a
 *  client checks the contract before it reads a field. */
export const OUTCOME_CONTRACT_VERSION = "outcome.v1";

/** The two runtime-reportable outcomes. A runtime may report that its work
 *  succeeded or failed; it may not report a rollback (that is an owner action
 *  confirmed by a session) and it may not report `nothing_reported` (that is
 *  what the ABSENCE of its report means). */
export const RUNTIME_REPORTABLE = ["worked", "failed"] as const;

// -------------------------------------------------------------------- rows

export interface OutcomeRow {
  id: string;
  session_id: string;
  loadout_id: string;
  loadout_entry_id: string;
  assignment_id: string;
  draft_id: string;
  draft_revision_id: string;
  content_digest: string;
  outcome: Outcome;
  evidence_class: EvidenceClass;
  outcome_ref: string;
  reason_code: string;
  reason: string;
  source: EvidenceSource | "owner";
  confirmation_source: string | null;
  runtime_session_ref: string | null;
  invocation_ref: string | null;
  invocation_receipt_id: string | null;
  rollback_to_revision_id: string | null;
  rollback_action_event_id: string | null;
  reported_by_agent_id: string;
  outcome_digest: string;
  payload_json: string;
  observed_at_ms: number;
  server_at_ms: number;
}

export interface ConflictRow {
  id: string;
  session_id: string;
  loadout_entry_id: string;
  outcome_ref: string;
  existing_outcome_id: string;
  existing_outcome: Outcome;
  claimed_outcome: Outcome;
  claimed_payload_json: string;
  conflict_digest: string;
  reported_by_agent_id: string;
  source: string;
  observed_at_ms: number;
  server_at_ms: number;
}

export interface RevisionSourceRow {
  id: string;
  draft_id: string;
  draft_revision_id: string;
  parent_revision_id: string;
  origin: "failure" | "feedback";
  source_outcome_id: string;
  source_session_id: string;
  source_receipt_id: string | null;
  observation: string;
  improvement_goal: string;
  goal_kind: "failure_to_worked" | "declared_binary";
  created_by_agent_id: string;
  created_at_ms: number;
  server_at_ms: number;
}

export function outcomesOfEntry(db: Db, entryId: string): OutcomeRow[] {
  return db
    .prepare("SELECT * FROM session_outcomes WHERE loadout_entry_id=? ORDER BY observed_at_ms, id")
    .all(entryId) as OutcomeRow[];
}

export function conflictsOfEntry(db: Db, entryId: string): ConflictRow[] {
  return db
    .prepare("SELECT * FROM outcome_conflicts WHERE loadout_entry_id=? ORDER BY server_at_ms, id")
    .all(entryId) as ConflictRow[];
}

export function outcomesOfSession(db: Db, sessionId: string): OutcomeRow[] {
  return db
    .prepare("SELECT * FROM session_outcomes WHERE session_id=? ORDER BY observed_at_ms, id")
    .all(sessionId) as OutcomeRow[];
}

export function closureOf(db: Db, sessionId: string): { id: string; closed_at_ms: number; reason_code: string; reason: string; source: string } | null {
  const row = db
    .prepare("SELECT id, closed_at_ms, reason_code, reason, source FROM session_closures WHERE session_id=?")
    .get(sessionId) as { id: string; closed_at_ms: number; reason_code: string; reason: string; source: string } | undefined;
  return row ?? null;
}

export function loadOutcome(db: Db, id: unknown): OutcomeRow {
  if (typeof id !== "string" || id.length !== 26) throw new ApiError("NOT_FOUND", "no such outcome");
  const row = db.prepare("SELECT * FROM session_outcomes WHERE id=?").get(id) as OutcomeRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `no outcome ${id}`);
  return row;
}

export function revisionSourceOf(db: Db, revisionId: string): RevisionSourceRow | null {
  const row = db.prepare("SELECT * FROM revision_sources WHERE draft_revision_id=?").get(revisionId) as
    | RevisionSourceRow
    | undefined;
  return row ?? null;
}

// ------------------------------------------------------------ the validation

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ApiError("INVALID_SCHEMA", `${field} must be a string`);
  const t = value.trim();
  if (t.length < 1 || t.length > max) throw new ApiError("INVALID_SCHEMA", `${field} is 1..${max} characters`);
  return t;
}

/** What a RUNTIME or ADAPTER files. */
export interface OutcomeReceiptInput {
  outcome: "worked" | "failed";
  /** the reporter's OWN identifier for this outcome — the replay key of
   *  `P5-FR-06`. Two deliveries of one outcome carry one ref */
  outcome_ref: string;
  /** which invocation this is the outcome of. `P5-FR-02` in the request: an
   *  outcome that names no invocation is not outcome evidence */
  invocation_ref: string;
  runtime_session_ref: string;
  revision_id: string;
  content_digest: string;
  reason_code: string;
  reason: string;
  observed_at_ms: number;
  transcript_excerpt: string | null;
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function validateOutcomeReceipt(body: Record<string, unknown>, nowMs: number): OutcomeReceiptInput {
  const outcome = body.outcome;
  if (outcome !== "worked" && outcome !== "failed") {
    throw new ApiError(
      "INVALID_SCHEMA",
      `a runtime reports one of ${RUNTIME_REPORTABLE.join(", ")}: nothing_reported is what the ABSENCE of a report means, ` +
        "and rolled_back is an owner action a new session confirms",
    );
  }
  // The same rule `validateReceipt` applies for the same reason: a field the
  // server overrides is a field the next reader believes.
  if (body.source !== undefined) {
    throw new ApiError("INVALID_SCHEMA", "an outcome does not declare its source: the server derives it from the reporting principal");
  }
  if (body.evidence_class !== undefined) {
    throw new ApiError("INVALID_SCHEMA", "an outcome does not declare its evidence class: the server derives it from the route and the principal");
  }
  const revisionId = body.revision_id;
  if (typeof revisionId !== "string" || revisionId.length !== 26) {
    throw new ApiError("INVALID_SCHEMA", "revision_id must be a 26-character id");
  }
  const digest = body.content_digest;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new ApiError("INVALID_SCHEMA", "content_digest must be sha256:<64 hex>");
  }
  const reasonCode = bounded(body.reason_code, "reason_code", 64);
  if (!REASON_CODE.test(reasonCode)) {
    throw new ApiError("INVALID_SCHEMA", "reason_code is an UPPER_SNAKE machine-readable code");
  }
  const observedAt = body.observed_at_ms === undefined ? nowMs : body.observed_at_ms;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0) {
    throw new ApiError("INVALID_SCHEMA", "observed_at_ms must be a positive number of milliseconds");
  }
  let excerpt: string | null = null;
  if (body.transcript_excerpt !== undefined && body.transcript_excerpt !== null) {
    excerpt = bounded(body.transcript_excerpt, "transcript_excerpt", 4000);
  }
  return {
    outcome,
    outcome_ref: bounded(body.outcome_ref, "outcome_ref", 200),
    invocation_ref: bounded(body.invocation_ref, "invocation_ref", 200),
    runtime_session_ref: bounded(body.runtime_session_ref, "runtime_session_ref", 200),
    revision_id: revisionId,
    content_digest: digest,
    reason_code: reasonCode,
    reason: bounded(body.reason, "reason", 2000),
    observed_at_ms: observedAt,
    transcript_excerpt: excerpt,
  };
}

/** What an OWNER files: a confirmation carrying its source (`P5-FR-02`). */
export interface OwnerConfirmationInput {
  outcome: "worked" | "failed";
  outcome_ref: string;
  entry_id: string;
  confirmation_source: string;
  reason_code: string;
  reason: string;
  observed_at_ms: number;
}

export function validateOwnerConfirmation(body: Record<string, unknown>, nowMs: number): OwnerConfirmationInput {
  const outcome = body.outcome;
  if (outcome !== "worked" && outcome !== "failed") {
    throw new ApiError(
      "INVALID_SCHEMA",
      "an owner confirms worked or failed: nothing_reported is written by the closure of a session, and rolled_back by the " +
        "session that carried the rolled-back revision",
    );
  }
  if (body.source !== undefined || body.evidence_class !== undefined) {
    throw new ApiError("INVALID_SCHEMA", "an owner confirmation does not declare its source or its evidence class: both are fixed by this route");
  }
  const reasonCode = bounded(body.reason_code, "reason_code", 64);
  if (!REASON_CODE.test(reasonCode)) {
    throw new ApiError("INVALID_SCHEMA", "reason_code is an UPPER_SNAKE machine-readable code");
  }
  const observedAt = body.observed_at_ms === undefined ? nowMs : body.observed_at_ms;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0) {
    throw new ApiError("INVALID_SCHEMA", "observed_at_ms must be a positive number of milliseconds");
  }
  return {
    outcome,
    outcome_ref: bounded(body.outcome_ref, "outcome_ref", 200),
    entry_id: bounded(body.entry_id, "entry_id", 26),
    // `P5-FR-02` verbatim: an owner confirmation CARRIES ITS SOURCE. A
    // confirmation that does not say where the owner saw it is an assertion,
    // and an assertion is what this whole phase exists not to accept.
    confirmation_source: bounded(body.confirmation_source, "confirmation_source", 200),
    reason_code: reasonCode,
    reason: bounded(body.reason, "reason", 2000),
    observed_at_ms: observedAt,
  };
}

// -------------------------------------------------------------- the writing

export interface OutcomeResult {
  outcome_id: string;
  session_id: string;
  loadout_entry_id: string;
  assignment_id: string;
  draft_revision_id: string;
  outcome: Outcome;
  evidence_class: EvidenceClass;
  outcome_digest: string;
  replayed: boolean;
}

function digestOf(payload: unknown): string {
  return `sha256:${createHash("sha256").update(jcsCanonicalize(payload as JcsValue), "utf8").digest("hex")}`;
}

function entryOfRevision(db: Db, loadoutId: string, revisionId: string): LoadoutEntryRow {
  const entry = db
    .prepare("SELECT * FROM session_loadout_entries WHERE loadout_id=? AND draft_revision_id=?")
    .get(loadoutId, revisionId) as LoadoutEntryRow | undefined;
  if (!entry) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "this outcome names a revision that is not in this session's loadout",
      "REVISION_NOT_IN_LOADOUT",
    );
  }
  return entry;
}

function refuseIfClosed(db: Db, sessionId: string): void {
  const closure = closureOf(db, sessionId);
  if (closure) {
    throw new ApiError(
      "CONFLICT",
      "this session is closed: what it did or did not report is already recorded and is not revised afterwards",
      "closed",
    );
  }
}

/**
 * THE REPLAY AND THE CONFLICT, IN ONE PLACE (`P5-FR-06`, `P5-FR-07`).
 *
 * The reporter's own `outcome_ref` is the key. A second delivery under that key
 * either says the same thing — in which case it is the SAME outcome and the
 * stored row is returned untouched — or it says something else, in which case
 * the stored row STAYS and the contradiction becomes its own row with the whole
 * of what was claimed. There is no branch that overwrites.
 */
function replayOrConflict(
  db: Db,
  entry: LoadoutEntryRow,
  session: SessionRow,
  outcomeRef: string,
  claimed: { outcome: Outcome; payload: Record<string, unknown>; digest: string },
  reportedByAgentId: string,
  source: string,
  observedAtMs: number,
  nowMs: number,
): { replay: OutcomeRow } | { conflict: ConflictRow } | null {
  const existing = db
    .prepare("SELECT * FROM session_outcomes WHERE loadout_entry_id=? AND outcome_ref=?")
    .get(entry.id, outcomeRef) as OutcomeRow | undefined;
  if (!existing) return null;
  if (existing.outcome_digest === claimed.digest) return { replay: existing };

  const conflictId = ulid(nowMs);
  const conflictDigest = digestOf({
    existing_outcome_id: existing.id,
    existing_digest: existing.outcome_digest,
    claimed_digest: claimed.digest,
    outcome_ref: outcomeRef,
  });
  db.prepare(
    `INSERT INTO outcome_conflicts(id, session_id, loadout_entry_id, outcome_ref, existing_outcome_id,
       existing_outcome, claimed_outcome, claimed_payload_json, conflict_digest, reported_by_agent_id,
       source, observed_at_ms, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    conflictId,
    session.id,
    entry.id,
    outcomeRef,
    existing.id,
    existing.outcome,
    claimed.outcome,
    JSON.stringify(claimed.payload),
    conflictDigest,
    reportedByAgentId,
    source,
    observedAtMs,
    nowMs,
  );
  return {
    conflict: db.prepare("SELECT * FROM outcome_conflicts WHERE id=?").get(conflictId) as ConflictRow,
  };
}

/** The structured conflict an intake answers with. `INV-05`: it is fields, and
 *  the caller decides from them rather than from a sentence. */
export interface OutcomeConflictView {
  conflict_id: string;
  outcome_ref: string;
  existing_outcome_id: string;
  existing_outcome: Outcome;
  claimed_outcome: Outcome;
  conflict_digest: string;
  observed_at_ms: number;
}

export function conflictView(row: ConflictRow): OutcomeConflictView {
  return {
    conflict_id: row.id,
    outcome_ref: row.outcome_ref,
    existing_outcome_id: row.existing_outcome_id,
    existing_outcome: row.existing_outcome,
    claimed_outcome: row.claimed_outcome,
    conflict_digest: row.conflict_digest,
    observed_at_ms: row.observed_at_ms,
  };
}

function insertOutcome(
  db: Db,
  fields: {
    session_id: string;
    loadout_id: string;
    entry: LoadoutEntryRow;
    outcome: Outcome;
    evidence_class: EvidenceClass;
    outcome_ref: string;
    reason_code: string;
    reason: string;
    source: string;
    confirmation_source: string | null;
    runtime_session_ref: string | null;
    invocation_ref: string | null;
    invocation_receipt_id: string | null;
    rollback_to_revision_id: string | null;
    rollback_action_event_id: string | null;
    reported_by_agent_id: string;
    payload: Record<string, unknown>;
    observed_at_ms: number;
  },
  nowMs: number,
): OutcomeResult {
  const digest = digestOf(fields.payload);
  const id = ulid(nowMs);
  db.prepare(
    `INSERT INTO session_outcomes(id, session_id, loadout_id, loadout_entry_id, assignment_id, draft_id,
       draft_revision_id, content_digest, outcome, evidence_class, outcome_ref, reason_code, reason, source,
       confirmation_source, runtime_session_ref, invocation_ref, invocation_receipt_id,
       rollback_to_revision_id, rollback_action_event_id, reported_by_agent_id, outcome_digest,
       payload_json, observed_at_ms, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    fields.session_id,
    fields.loadout_id,
    fields.entry.id,
    fields.entry.assignment_id,
    fields.entry.draft_id,
    fields.entry.draft_revision_id,
    fields.entry.content_digest,
    fields.outcome,
    fields.evidence_class,
    fields.outcome_ref,
    fields.reason_code,
    fields.reason,
    fields.source,
    fields.confirmation_source,
    fields.runtime_session_ref,
    fields.invocation_ref,
    fields.invocation_receipt_id,
    fields.rollback_to_revision_id,
    fields.rollback_action_event_id,
    fields.reported_by_agent_id,
    digest,
    JSON.stringify(fields.payload),
    fields.observed_at_ms,
    nowMs,
  );
  return {
    outcome_id: id,
    session_id: fields.session_id,
    loadout_entry_id: fields.entry.id,
    assignment_id: fields.entry.assignment_id,
    draft_revision_id: fields.entry.draft_revision_id,
    outcome: fields.outcome,
    evidence_class: fields.evidence_class,
    outcome_digest: digest,
    replayed: false,
  };
}

/**
 * THE RUNTIME'S OUTCOME (`P5-FR-02`, `P5-FR-03`, `P5-FR-06`, `P5-FR-07`).
 *
 * `worked` is refused unless an `invoked` RECEIPT of this exact entry exists and
 * this outcome names its `invocation_ref`. That is the whole of "`worked` can
 * never be derived from `proposed` or `loaded` alone": there is no code path
 * from a stage to an outcome, and the one path that writes `worked` from runtime
 * evidence demands the invocation receipt by id.
 */
export function recordOutcomeReceiptInTx(
  db: Db,
  session: SessionRow,
  reportedByAgentId: string,
  source: EvidenceSource,
  input: OutcomeReceiptInput,
  nowMs: number,
): { result: OutcomeResult } | { conflict: OutcomeConflictView } {
  refuseIfClosed(db, session.id);
  const loadout = loadoutOfSession(db, session.id);
  const entry = entryOfRevision(db, loadout.id, input.revision_id);
  if (entry.content_digest !== input.content_digest) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "this outcome's content digest is not the digest this session's loadout froze for that revision",
      "DIGEST_MISMATCH",
    );
  }

  // The invocation this is the outcome OF, by id. A `worked` with no invocation
  // receipt behind it is refused; a `failed` is refused for the same reason,
  // because an outcome of an invocation that never happened is not an outcome.
  const invoked = receiptsOfEntry(db, entry.id, "invoked").find(
    (r) => r.invocation_ref === input.invocation_ref && r.runtime_session_ref === input.runtime_session_ref,
  );
  if (!invoked) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "no invocation receipt of this session names that invocation_ref and runtime_session_ref: an outcome is the outcome " +
        "of an invocation, and this one has none",
      "NO_INVOCATION_EVIDENCE",
    );
  }

  const payload = {
    outcome: input.outcome,
    evidence_class: "runtime_receipt",
    session_id: session.id,
    loadout_id: loadout.id,
    loadout_entry_id: entry.id,
    assignment_id: entry.assignment_id,
    draft_id: entry.draft_id,
    draft_revision_id: entry.draft_revision_id,
    content_digest: entry.content_digest,
    outcome_ref: input.outcome_ref,
    invocation_ref: input.invocation_ref,
    invocation_receipt_id: invoked.id,
    runtime_session_ref: input.runtime_session_ref,
    runtime_kind: session.runtime_kind,
    runtime_version: session.runtime_version,
    reason_code: input.reason_code,
    reason: input.reason,
    source,
    reported_by_agent_id: reportedByAgentId,
    observed_at_ms: input.observed_at_ms,
    transcript_excerpt: input.transcript_excerpt,
  } as Record<string, unknown>;

  const prior = replayOrConflict(
    db,
    entry,
    session,
    input.outcome_ref,
    { outcome: input.outcome, payload, digest: digestOf(payload) },
    reportedByAgentId,
    source,
    input.observed_at_ms,
    nowMs,
  );
  if (prior && "replay" in prior) {
    return {
      result: {
        outcome_id: prior.replay.id,
        session_id: prior.replay.session_id,
        loadout_entry_id: prior.replay.loadout_entry_id,
        assignment_id: prior.replay.assignment_id,
        draft_revision_id: prior.replay.draft_revision_id,
        outcome: prior.replay.outcome,
        evidence_class: prior.replay.evidence_class,
        outcome_digest: prior.replay.outcome_digest,
        replayed: true,
      },
    };
  }
  if (prior) return { conflict: conflictView(prior.conflict) };

  return {
    result: insertOutcome(
      db,
      {
        session_id: session.id,
        loadout_id: loadout.id,
        entry,
        outcome: input.outcome,
        evidence_class: "runtime_receipt",
        outcome_ref: input.outcome_ref,
        reason_code: input.reason_code,
        reason: input.reason,
        source,
        confirmation_source: null,
        runtime_session_ref: input.runtime_session_ref,
        invocation_ref: input.invocation_ref,
        invocation_receipt_id: invoked.id,
        rollback_to_revision_id: null,
        rollback_action_event_id: null,
        reported_by_agent_id: reportedByAgentId,
        payload,
        observed_at_ms: input.observed_at_ms,
      },
      nowMs,
    ),
  };
}

/**
 * THE OWNER'S CONFIRMATION — the other half of `P5-FR-02`, and it says so about
 * itself in every field a reader sees.
 *
 * It writes `session_outcomes` and NOTHING ELSE. No observation, no stage, no
 * receipt. An owner who confirms a skill worked has not caused the registry to
 * claim a runtime loaded one (`INV-02`, `P4-FR-13`).
 */
export function recordOwnerConfirmationInTx(
  db: Db,
  session: SessionRow,
  ownerAgentId: string,
  input: OwnerConfirmationInput,
  nowMs: number,
): { result: OutcomeResult } | { conflict: OutcomeConflictView } {
  const loadout = loadoutOfSession(db, session.id);
  const entry = loadoutEntries(db, loadout.id).find((e) => e.id === input.entry_id);
  if (!entry) throw new ApiError("NOT_FOUND", "no such entry in this session's loadout");

  const payload = {
    outcome: input.outcome,
    evidence_class: "owner_confirmation",
    session_id: session.id,
    loadout_id: loadout.id,
    loadout_entry_id: entry.id,
    assignment_id: entry.assignment_id,
    draft_id: entry.draft_id,
    draft_revision_id: entry.draft_revision_id,
    content_digest: entry.content_digest,
    outcome_ref: input.outcome_ref,
    confirmation_source: input.confirmation_source,
    reason_code: input.reason_code,
    reason: input.reason,
    source: "owner",
    reported_by_agent_id: ownerAgentId,
    observed_at_ms: input.observed_at_ms,
  } as Record<string, unknown>;

  const prior = replayOrConflict(
    db,
    entry,
    session,
    input.outcome_ref,
    { outcome: input.outcome, payload, digest: digestOf(payload) },
    ownerAgentId,
    "owner",
    input.observed_at_ms,
    nowMs,
  );
  if (prior && "replay" in prior) {
    return {
      result: {
        outcome_id: prior.replay.id,
        session_id: prior.replay.session_id,
        loadout_entry_id: prior.replay.loadout_entry_id,
        assignment_id: prior.replay.assignment_id,
        draft_revision_id: prior.replay.draft_revision_id,
        outcome: prior.replay.outcome,
        evidence_class: prior.replay.evidence_class,
        outcome_digest: prior.replay.outcome_digest,
        replayed: true,
      },
    };
  }
  if (prior) return { conflict: conflictView(prior.conflict) };

  return {
    result: insertOutcome(
      db,
      {
        session_id: session.id,
        loadout_id: loadout.id,
        entry,
        outcome: input.outcome,
        evidence_class: "owner_confirmation",
        outcome_ref: input.outcome_ref,
        reason_code: input.reason_code,
        reason: input.reason,
        source: "owner",
        confirmation_source: input.confirmation_source,
        runtime_session_ref: null,
        invocation_ref: null,
        invocation_receipt_id: null,
        rollback_to_revision_id: null,
        rollback_action_event_id: null,
        reported_by_agent_id: ownerAgentId,
        payload,
        observed_at_ms: input.observed_at_ms,
      },
      nowMs,
    ),
  };
}

/**
 * CLOSING A SESSION (`P5-FR-04`).
 *
 * Every entry with no outcome gets `nothing_reported` — including one that
 * reached `invoked`, because "it was invoked" is not "it worked" and the whole
 * point of the fourth value is that silence is not success. The closure is
 * INSERT-only and idempotent by its `UNIQUE(session_id)`: closing twice is one
 * closure and the second call returns what the first wrote.
 */
export interface ClosureResult {
  closure_id: string;
  session_id: string;
  closed_at_ms: number;
  nothing_reported: string[];
  already_closed: boolean;
}

export function closeSessionInTx(
  db: Db,
  session: SessionRow,
  closedByAgentId: string,
  source: EvidenceSource,
  reason: string,
  nowMs: number,
): ClosureResult {
  const existing = closureOf(db, session.id);
  if (existing) {
    return {
      closure_id: existing.id,
      session_id: session.id,
      closed_at_ms: existing.closed_at_ms,
      nothing_reported: outcomesOfSession(db, session.id)
        .filter((o) => o.outcome === "nothing_reported")
        .map((o) => o.id),
      already_closed: true,
    };
  }
  const loadout = loadoutOfSession(db, session.id);
  const written: string[] = [];
  for (const entry of loadoutEntries(db, loadout.id)) {
    if (outcomesOfEntry(db, entry.id).length > 0) continue;
    const payload = {
      outcome: "nothing_reported",
      evidence_class: "session_closed",
      session_id: session.id,
      loadout_id: loadout.id,
      loadout_entry_id: entry.id,
      assignment_id: entry.assignment_id,
      draft_id: entry.draft_id,
      draft_revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      reason_code: "NO_OUTCOME_RECEIPT",
      reason:
        "the session closed and no outcome was filed for this entry; what it did is not known and is not " +
        "recorded as a success",
      source: "backend",
      closed_by_agent_id: closedByAgentId,
      closed_by_source: source,
      observed_at_ms: nowMs,
    } as Record<string, unknown>;
    const res = insertOutcome(
      db,
      {
        session_id: session.id,
        loadout_id: loadout.id,
        entry,
        outcome: "nothing_reported",
        evidence_class: "session_closed",
        // The ref is the CLOSURE's, not a reporter's: nobody reported this, and
        // a key that pretended otherwise would be replayable by a client.
        outcome_ref: `session-closed:${session.id}`,
        reason_code: "NO_OUTCOME_RECEIPT",
        reason: payload.reason as string,
        // `source` is the BACKEND's: the registry saw the session close with no
        // report. That is its own observation and not the closer's claim.
        source: "backend",
        confirmation_source: null,
        runtime_session_ref: null,
        invocation_ref: null,
        invocation_receipt_id: null,
        rollback_to_revision_id: null,
        rollback_action_event_id: null,
        reported_by_agent_id: closedByAgentId,
        payload,
        observed_at_ms: nowMs,
      },
      nowMs,
    );
    written.push(res.outcome_id);
  }

  const closureId = ulid(nowMs);
  db.prepare(
    `INSERT INTO session_closures(id, session_id, workspace_id, closed_by_agent_id, source, reason_code,
       reason, entries_without_outcome, closed_at_ms, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    closureId,
    session.id,
    session.workspace_id,
    closedByAgentId,
    source,
    "SESSION_CLOSED",
    reason,
    written.length,
    nowMs,
    nowMs,
  );
  return { closure_id: closureId, session_id: session.id, closed_at_ms: nowMs, nothing_reported: written, already_closed: false };
}

/** THE REVISION NUMBER OF A REVISION, WHICH IS THE ONLY THING THAT ORDERS TWO OF
 *  THEM. `draft_revisions.revision` is assigned once, at creation, and the row is
 *  immutable (`INV-06`), so it is the same answer whenever it is asked. */
function revisionNumberOf(db: Db, revisionId: string): number | null {
  const row = db.prepare("SELECT revision FROM draft_revisions WHERE id=?").get(revisionId) as
    | { revision: number }
    | undefined;
  return row ? row.revision : null;
}

/**
 * DID THIS SESSION OPEN AFTER THAT EVENT — STRICTLY, AND INSIDE ONE MILLISECOND.
 *
 * P5 REVIEW-1 finding `P5-R1-002`: the comparison was `session.server_at_ms <
 * event.server_at_ms`, so two operations that landed in the SAME millisecond
 * compared as simultaneous and the earlier one was accepted as the later. A
 * millisecond holds many operations, and the fix is not a wider or narrower
 * comparison on the same value — it is a second component that the tree already
 * mints: `ulid()` is a MONOTONIC generator (`src/ulid.ts`), so two ids minted
 * from one clock reading are issued in ascending order. `agent_sessions.id` and
 * `skill_assignment_events.id` are both minted that way from the operation's own
 * `nowMs`, which makes `(server_at_ms, id)` a strict order over operations and
 * not merely over milliseconds. Nothing here invents a clock or writes one down.
 */
function openedAfter(session: SessionRow, event: { id: string; server_at_ms: number }): boolean {
  if (session.server_at_ms !== event.server_at_ms) return session.server_at_ms > event.server_at_ms;
  return session.id > event.id;
}

/**
 * `rolled_back` (`P5-FR-05`, `P5-FR-13`).
 *
 * It is filed against a NEW session that actually carries the rolled-back
 * revision, and it names the rollback ACTION — the `revision_selected` event P3
 * wrote — and the revision that action selected. Four things are checked and
 * each is a requirement rather than a nicety:
 *
 *   * the event is a selection that went BACKWARD, established from the journal
 *     itself, so an owner who moved FORWARD cannot have that recorded as a
 *     rollback they never performed;
 *   * the entry of THIS session carries the rollback target, so a rollback
 *     nobody loaded cannot be recorded as confirmed;
 *   * the session opened AFTER the rollback action, by a comparison that can
 *     tell two operations of one millisecond apart, so a session that predates
 *     the decision cannot be presented as its confirmation;
 *   * the earlier outcome is not touched — this is a new row, and the view
 *     below shows both.
 *
 * WHY THE JOURNAL AND NOT THE LABEL. P5 REVIEW-1 finding `P5-R1-001`: this
 * function checked that the event was a `revision_selected` and never that the
 * selection went backward, so `direction: "update"` — the provenance P3 writes
 * for a FORWARD move — was accepted as proof of a rollback and a durable
 * `rolled_back` was filed for an owner who had advanced. Both halves of that are
 * closed here, and deliberately without reading `provenance_json.direction`: a
 * label is a claim about the operation, while `skill_assignment_events` ordered
 * by `event_seq` IS the desired-state history, INSERT-only by trigger. The
 * revision in force before the event is the one its immediate predecessor
 * selected, and backward means the target's `revision` number is lower. That is
 * the same fact `selectRevisionInTx` computed when it labelled the event, read
 * back from the rows rather than taken on trust.
 */
export function recordRollbackConfirmationInTx(
  db: Db,
  session: SessionRow,
  reportedByAgentId: string,
  source: EvidenceSource,
  input: { entry_id: string; rollback_action_event_id: string; reason: string; observed_at_ms: number },
  nowMs: number,
): OutcomeResult {
  refuseIfClosed(db, session.id);
  const loadout = loadoutOfSession(db, session.id);
  const entry = loadoutEntries(db, loadout.id).find((e) => e.id === input.entry_id);
  if (!entry) throw new ApiError("NOT_FOUND", "no such entry in this session's loadout");

  const journal = db
    .prepare(
      `SELECT id, event, desired_revision_id, event_seq, server_at_ms
         FROM skill_assignment_events WHERE assignment_id=? ORDER BY event_seq ASC`,
    )
    .all(entry.assignment_id) as Array<{
    id: string;
    event: string;
    desired_revision_id: string;
    event_seq: number;
    server_at_ms: number;
  }>;
  const at = journal.findIndex((e) => e.id === input.rollback_action_event_id);
  if (at < 0) {
    throw new ApiError("NOT_FOUND", "no such lifecycle event on this entry's assignment");
  }
  const event = journal[at]!;
  if (event.event !== "revision_selected") {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "the action a rollback records is a revision selection; this event is not one",
      "NOT_A_ROLLBACK_ACTION",
    );
  }
  const before = journal[at - 1];
  const wasInForce = before ? revisionNumberOf(db, before.desired_revision_id) : null;
  const selected = revisionNumberOf(db, event.desired_revision_id);
  if (wasInForce === null || selected === null || selected >= wasInForce) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "this selection did not go back: the revision it selected is not an earlier one than the revision that " +
        "was in force before it, so it is not a rollback and cannot be confirmed as one",
      "NOT_A_ROLLBACK_ACTION",
    );
  }
  if (event.desired_revision_id !== entry.draft_revision_id) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "this session's entry does not carry the revision that rollback selected, so this session does not confirm it",
      "ROLLBACK_TARGET_NOT_LOADED",
    );
  }
  if (!openedAfter(session, event)) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "this session opened before the rollback was decided, so it is not the new session that confirms it",
      "SESSION_PREDATES_ROLLBACK",
    );
  }

  const payload = {
    outcome: "rolled_back",
    evidence_class: "rollback_confirmation",
    session_id: session.id,
    loadout_id: loadout.id,
    loadout_entry_id: entry.id,
    assignment_id: entry.assignment_id,
    draft_id: entry.draft_id,
    draft_revision_id: entry.draft_revision_id,
    content_digest: entry.content_digest,
    rollback_action_event_id: event.id,
    rollback_to_revision_id: event.desired_revision_id,
    reason_code: "ROLLBACK_CONFIRMED_BY_NEW_SESSION",
    reason: input.reason,
    source,
    reported_by_agent_id: reportedByAgentId,
    observed_at_ms: input.observed_at_ms,
  } as Record<string, unknown>;

  return insertOutcome(
    db,
    {
      session_id: session.id,
      loadout_id: loadout.id,
      entry,
      outcome: "rolled_back",
      evidence_class: "rollback_confirmation",
      outcome_ref: `rollback:${event.id}`,
      reason_code: "ROLLBACK_CONFIRMED_BY_NEW_SESSION",
      reason: input.reason,
      source,
      confirmation_source: null,
      runtime_session_ref: null,
      invocation_ref: null,
      invocation_receipt_id: null,
      rollback_to_revision_id: event.desired_revision_id,
      rollback_action_event_id: event.id,
      reported_by_agent_id: reportedByAgentId,
      payload,
      observed_at_ms: input.observed_at_ms,
    },
    nowMs,
  );
}

// -------------------------------------------------------------- the reading

/** The outcome of one loadout entry, with everything a reader needs to know how
 *  much the answer is worth. `unknown` carries all four `INV-03` fields, exactly
 *  as `entryStages` does — the four outcome VALUES are what gets persisted, and
 *  "nobody has said yet" is an absence rather than a fifth value. */
export interface EntryOutcomeView {
  entry_id: string;
  assignment_id: string;
  draft_id: string;
  draft_revision_id: string;
  revision: number;
  skill_name: string;
  content_digest: string;
  outcome: Outcome | "unknown";
  evidence_class: EvidenceClass | null;
  outcome_id: string | null;
  reason_code: string;
  reason: string;
  source: string;
  observed_at_ms: number;
  /** every outcome filed against this entry, oldest first. A `rolled_back` does
   *  not erase the `failed` before it (`P5-FR-05`) — both are here */
  history: Array<{
    outcome_id: string;
    outcome: Outcome;
    evidence_class: EvidenceClass;
    reason_code: string;
    reason: string;
    source: string;
    confirmation_source: string | null;
    invocation_receipt_id: string | null;
    rollback_to_revision_id: string | null;
    outcome_digest: string;
    observed_at_ms: number;
  }>;
  /** contradicting deliveries, kept as their own evidence (`P5-FR-07`) */
  conflicts: OutcomeConflictView[];
}

export function entryOutcomes(db: Db, session: SessionRow, nowMs: number): EntryOutcomeView[] {
  const loadout = loadoutOfSession(db, session.id);
  return loadoutEntries(db, loadout.id).map((entry) => {
    const rows = outcomesOfEntry(db, entry.id);
    const latest = rows[rows.length - 1];
    return {
      entry_id: entry.id,
      assignment_id: entry.assignment_id,
      draft_id: entry.draft_id,
      draft_revision_id: entry.draft_revision_id,
      revision: entry.revision,
      skill_name: entry.skill_name,
      content_digest: entry.content_digest,
      outcome: latest ? latest.outcome : ("unknown" as const),
      evidence_class: latest ? latest.evidence_class : null,
      outcome_id: latest ? latest.id : null,
      reason_code: latest ? latest.reason_code : "NO_OUTCOME_FILED",
      reason: latest
        ? latest.reason
        : "no outcome has been filed for this entry and the session has not closed; observed_at_ms is the moment of this look",
      source: latest ? latest.source : "backend",
      observed_at_ms: latest ? latest.observed_at_ms : nowMs,
      history: rows.map((r) => ({
        outcome_id: r.id,
        outcome: r.outcome,
        evidence_class: r.evidence_class,
        reason_code: r.reason_code,
        reason: r.reason,
        source: r.source,
        confirmation_source: r.confirmation_source,
        invocation_receipt_id: r.invocation_receipt_id,
        rollback_to_revision_id: r.rollback_to_revision_id,
        outcome_digest: r.outcome_digest,
        observed_at_ms: r.observed_at_ms,
      })),
      conflicts: conflictsOfEntry(db, entry.id).map(conflictView),
    };
  });
}

// -------------------------------------------------------------- the lineage

/**
 * `P5-FR-08`: where a new revision came from, and what it promised.
 *
 * The INSERT lives here rather than in the service for the reason every other
 * journal write in this tree does: `JOURNAL_WRITERS` in `src/journal.ts` names
 * ONE module per journal and a probe walks `src/` to check it. A second writer
 * appearing quietly is exactly what that rule exists to catch.
 */
export function insertRevisionSource(
  db: Db,
  fields: {
    draft_id: string;
    draft_revision_id: string;
    parent_revision_id: string;
    origin: "failure" | "feedback";
    source_outcome_id: string;
    source_session_id: string;
    source_receipt_id: string | null;
    observation: string;
    improvement_goal: string;
    goal_kind: "failure_to_worked" | "declared_binary";
    created_by_agent_id: string;
  },
  nowMs: number,
): string {
  const id = ulid(nowMs);
  db.prepare(
    `INSERT INTO revision_sources(id, draft_id, draft_revision_id, parent_revision_id, origin,
       source_outcome_id, source_session_id, source_receipt_id, observation, improvement_goal,
       goal_kind, created_by_agent_id, created_at_ms, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    fields.draft_id,
    fields.draft_revision_id,
    fields.parent_revision_id,
    fields.origin,
    fields.source_outcome_id,
    fields.source_session_id,
    fields.source_receipt_id,
    fields.observation,
    fields.improvement_goal,
    fields.goal_kind,
    fields.created_by_agent_id,
    nowMs,
    nowMs,
  );
  return id;
}

/** `P5-FR-11`: the comparison row. The VERDICT reaching this function has
 *  already been decided by `decideComparison` from the rows — nothing here takes
 *  one from a caller. */
export function insertComparison(
  db: Db,
  fields: {
    workspace_id: string;
    draft_id: string;
    revision_source_id: string;
    baseline_revision_id: string;
    candidate_revision_id: string;
    baseline_outcome_id: string;
    candidate_outcome_id: string;
    baseline_outcome: Outcome;
    candidate_outcome: Outcome;
    comparable: boolean;
    scenario: Record<string, unknown>;
    improvement_goal: string;
    goal_kind: "failure_to_worked" | "declared_binary";
    verdict: "improved" | "not_improved" | "not_comparable";
    verdict_reason_code: string;
    verdict_reason: string;
    created_by_agent_id: string;
  },
  nowMs: number,
): string {
  const id = ulid(nowMs);
  db.prepare(
    `INSERT INTO revision_comparisons(id, workspace_id, draft_id, revision_source_id, baseline_revision_id,
       candidate_revision_id, baseline_outcome_id, candidate_outcome_id, baseline_outcome, candidate_outcome,
       comparable, scenario_json, improvement_goal, goal_kind, verdict, verdict_reason_code, verdict_reason,
       created_by_agent_id, created_at_ms, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    fields.workspace_id,
    fields.draft_id,
    fields.revision_source_id,
    fields.baseline_revision_id,
    fields.candidate_revision_id,
    fields.baseline_outcome_id,
    fields.candidate_outcome_id,
    fields.baseline_outcome,
    fields.candidate_outcome,
    fields.comparable ? 1 : 0,
    JSON.stringify(fields.scenario),
    fields.improvement_goal,
    fields.goal_kind,
    fields.verdict,
    fields.verdict_reason_code,
    fields.verdict_reason,
    fields.created_by_agent_id,
    nowMs,
    nowMs,
  );
  return id;
}

// ------------------------------------------------------------ the comparison

export interface ComparisonView {
  comparison_id: string;
  draft_id: string;
  revision_source_id: string;
  baseline: { revision_id: string; revision: number; outcome_id: string; outcome: Outcome; reason_code: string; reason: string; session_id: string; agent_id: string; runtime_kind: string; observed_at_ms: number };
  candidate: { revision_id: string; revision: number; outcome_id: string; outcome: Outcome; reason_code: string; reason: string; session_id: string; agent_id: string; runtime_kind: string; observed_at_ms: number };
  comparable: boolean;
  scenario: { agent_id_match: boolean; runtime_kind_match: boolean; lineage_match: boolean; baseline_agent_id: string; candidate_agent_id: string; baseline_runtime_kind: string; candidate_runtime_kind: string };
  improvement_goal: string;
  goal_kind: "failure_to_worked" | "declared_binary";
  verdict: "improved" | "not_improved" | "not_comparable";
  verdict_reason_code: string;
  verdict_reason: string;
  created_at_ms: number;
}

/**
 * `P5-FR-11` and `P5-FR-12`, decided by the backend from rows.
 *
 * A CONFIRMED IMPROVEMENT needs two things and neither is negotiable here:
 *
 *   1. a COMPARABLE SCENARIO — the same skill lineage, the same agent and the
 *      same runtime kind. Two different agents on two different runtimes are two
 *      experiments, not a before and an after;
 *   2. a PROVED TRANSITION — the baseline outcome is `failed` (or the goal was a
 *      binary one stated in advance) and the candidate outcome is `worked`.
 *
 * Anything else is `not_improved` or `not_comparable`, with the reason code
 * saying which of the two conditions was not met. The verdict is COMPUTED, never
 * supplied: a caller that could name the verdict could name any verdict.
 */
export function decideComparison(args: {
  baseline: { outcome: Outcome; agent_id: string; runtime_kind: string; draft_id: string };
  candidate: { outcome: Outcome; agent_id: string; runtime_kind: string; draft_id: string };
  goal_kind: "failure_to_worked" | "declared_binary";
}): { comparable: boolean; verdict: "improved" | "not_improved" | "not_comparable"; reason_code: string; reason: string } {
  const lineage = args.baseline.draft_id === args.candidate.draft_id;
  const agent = args.baseline.agent_id === args.candidate.agent_id;
  const runtime = args.baseline.runtime_kind === args.candidate.runtime_kind;
  const comparable = lineage && agent && runtime;
  if (!comparable) {
    return {
      comparable: false,
      verdict: "not_comparable",
      reason_code: !lineage ? "DIFFERENT_LINEAGE" : !agent ? "DIFFERENT_AGENT" : "DIFFERENT_RUNTIME",
      reason:
        "an improvement is claimed between two runs of the same skill on the same agent and the same runtime kind; " +
        "these two differ, so the comparison is reported and no improvement is confirmed",
    };
  }
  if (args.candidate.outcome !== "worked") {
    return {
      comparable: true,
      verdict: "not_improved",
      reason_code: "CANDIDATE_NOT_WORKED",
      reason: `the new revision's outcome is ${args.candidate.outcome}, and a confirmed improvement requires it to be worked`,
    };
  }
  if (args.goal_kind === "failure_to_worked" && args.baseline.outcome !== "failed") {
    return {
      comparable: true,
      verdict: "not_improved",
      reason_code: "BASELINE_NOT_FAILED",
      reason:
        `the goal stated in advance was a transition from a failure, and the baseline outcome is ${args.baseline.outcome}: ` +
        "there is no failure for this to be an improvement on",
    };
  }
  return {
    comparable: true,
    verdict: "improved",
    reason_code: args.goal_kind === "failure_to_worked" ? "FAILURE_TO_WORKED" : "DECLARED_GOAL_MET",
    reason:
      "the same skill on the same agent and the same runtime kind went from " +
      `${args.baseline.outcome} to worked, which is the binary goal recorded when the new revision was created`,
  };
}
