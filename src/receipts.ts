// §5.3 Adoption Receipt machine — "the key innovation".
//
// ALL appends go through ONE transactional function, `appendReceiptEvent`,
// which inside a single SQLite transaction: (1) replays `idempotency_key`
// duplicates as `noop:true`; (2) checks actor = the receipt's adopter (or the
// registry itself for synthesis); (3) reads the derived state and applies the
// §5.3 transition table; (4) assigns `event_seq = max+1` — `event_seq` is the
// ONLY normative order (HIGH-7: ULID lexicographic order within one ms is NOT
// relied upon anywhere); (5) validates the payload schema per event kind.
//
// Derived state = the event kind of the highest `event_seq` row (`none` when
// empty). Everything the machine refuses converges: `PRECONDITION_FAILED` +
// the CURRENT state, never an error loop (defect #1).
//
// Evidence for `adopted` is validated by `validateEvidenceForVersion()` — the
// SAME function P4's §5.1 verified-gate reads, so "passed registry validation
// at append time" and "validates at gate time" cannot drift apart.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { validatePayload } from "./manifest.ts";
import { validateEvidenceForVersion } from "./verified-gate.ts";
import { ulid } from "./ulid.ts";

export type ReceiptEvent = "delivered" | "attempted" | "adopted" | "failed" | "rolled_back";
export type DerivedState = ReceiptEvent | "none";

export const RECEIPT_EVENTS: readonly ReceiptEvent[] = [
  "delivered",
  "attempted",
  "adopted",
  "failed",
  "rolled_back",
];

/** §5.3: the terminal set is {adopted, failed}; `rolled_back` is POST-terminal. */
export const TERMINAL_EVENTS: readonly ReceiptEvent[] = ["adopted", "failed"];

/**
 * §5.3: the `evidence_json` of the auto-acked `delivered` row, verbatim from
 * the transition table. It is a REGISTRY MARKER, not adopter evidence: it
 * records that no adopter ever reported this `delivered`, so a reader of the
 * chain can tell an auto-ack from a real acknowledgement.
 *
 * It is deliberately NOT run through `validateEvidenceForVersion()`. That
 * function is the Appendix E.2 `evidence-v1` check, which requires
 * `gate_results` — a marker on a `delivered` row has none, and §5.3 requires
 * evidence only on `adopted`. The `synthesized` property exists in
 * `evidence-v1` so the marker's shape is declared in one place, not so the
 * marker can pose as evidence: `{"synthesized":true}` alone fails that schema,
 * which is exactly why an adopter cannot send it in place of gate results.
 */
export const SYNTHESIZED_DELIVERED_EVIDENCE = { synthesized: true } as const;

export interface AppendResult {
  receipt_event: ReceiptEvent;
  event_seq: number;
  /** true when an idempotency_key duplicate replayed an existing append */
  noop?: boolean;
  /** the `delivered` row synthesized under the §5.3 auto-ack rule, if any */
  synthesized?: { receipt_event: "delivered"; event_seq: number };
}

export interface AppendInput {
  receiptId: string;
  /** the acting agent, from AuthContext — never from the payload */
  actorAgentId: string;
  event: ReceiptEvent;
  evidence?: unknown;
  failure_report?: unknown;
  rollback_report?: unknown;
  /**
   * §5.3: the environment the adopter DECLARED, recorded on `delivered` in the
   * same transaction as the event and never afterwards. Set by `skill.adopt`
   * only; it is not an adopter-supplied payload of the receipt surface, and an
   * append that names it for any other event is a programming error, not a
   * request.
   */
  environment?: unknown;
  idempotencyKey: string;
  nowMs: number;
  /** the registry acting for itself (synthesis); skips the adopter check */
  asRegistry?: boolean;
}

interface ReceiptRow {
  id: string;
  adopter_agent_id: string;
  skill_version_id: string;
  manifest_json: string;
  workspace_id: string;
}

/** Derived state of a receipt: the event kind of its highest `event_seq` row. */
export function derivedState(db: Db, receiptId: string): DerivedState {
  const row = db
    .prepare("SELECT event FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq DESC LIMIT 1")
    .get(receiptId) as { event: ReceiptEvent } | undefined;
  return row?.event ?? "none";
}

/**
 * The §5.3 transition table, as data. `append` = write this event;
 * `synthesize_delivered` = write the auto-ack `delivered` first, in the SAME
 * transaction (the battle-tested auto-ack-by-reply semantics the internal
 * code map carries over);
 * anything absent is a converging `PRECONDITION_FAILED` with the current state.
 */
export type TransitionAction = "append" | "synthesize_delivered";

export const RECEIPT_TRANSITIONS: Readonly<Record<DerivedState, Partial<Record<ReceiptEvent, TransitionAction>>>> = {
  none: { delivered: "append", attempted: "synthesize_delivered" },
  delivered: { attempted: "append", failed: "append" },
  attempted: { adopted: "append", failed: "append" },
  adopted: { rolled_back: "append" },
  failed: {},
  rolled_back: {},
};

/** §5.3 payload rules, checked against the Appendix E.2 schemas. */
function validateEventPayload(input: AppendInput, receipt: ReceiptRow, from: DerivedState): void {
  const bad = (m: string): never => {
    throw new ApiError("INVALID_SCHEMA", m);
  };
  if (input.event === "adopted") {
    if (input.evidence === undefined) bad("`adopted` requires evidence produced in the adopter's environment (§5.3)");
    let manifest: any = null;
    try {
      manifest = JSON.parse(receipt.manifest_json);
    } catch {
      manifest = null;
    }
    const val = validateEvidenceForVersion(manifest, input.evidence);
    if (!val.valid) {
      bad(`evidence does not validate against this version's declared validation_gates: ${val.errors.slice(0, 3).join("; ")}`);
    }
    return;
  }
  if (input.event === "failed") {
    if (input.failure_report === undefined) bad("`failed` requires a failure_report (§5.3)");
    const val = validatePayload("failure_report", input.failure_report);
    if (!val.valid) bad(`failure_report: ${val.errors.slice(0, 3).join("; ")}`);
    // §5.3: `failed` before `attempted` is legal, but the report must say so
    if (from === "delivered" && (input.failure_report as any).category !== "pre_execution") {
      bad("a `failed` event before `attempted` requires failure_report.category 'pre_execution' (§5.3)");
    }
    return;
  }
  if (input.event === "rolled_back") {
    if (input.rollback_report === undefined) bad("`rolled_back` requires a rollback_report (§5.3)");
    const val = validatePayload("rollback_report", input.rollback_report);
    if (!val.valid) bad(`rollback_report: ${val.errors.slice(0, 3).join("; ")}`);
    return;
  }
  // `delivered` and `attempted` carry no required payload; a caller that sends
  // one anyway is telling the registry something it must not silently store.
  if (input.evidence !== undefined || input.failure_report !== undefined || input.rollback_report !== undefined) {
    bad(`a \`${input.event}\` event carries no evidence/failure/rollback payload (§5.3)`);
  }
}

function loadReceipt(db: Db, receiptId: string): ReceiptRow | undefined {
  return db
    .prepare(
      `SELECT r.id, r.adopter_agent_id, r.skill_version_id, v.manifest_json, s.workspace_id
         FROM adoption_receipts r
         JOIN skill_versions v ON v.id = r.skill_version_id
         JOIN skills s ON s.id = v.skill_id
        WHERE r.id = ?`,
    )
    .get(receiptId) as ReceiptRow | undefined;
}

function insertEvent(
  db: Db,
  receiptId: string,
  event: ReceiptEvent,
  seq: number,
  input: { evidence?: unknown; failure_report?: unknown; rollback_report?: unknown; environment?: unknown },
  idempotencyKey: string,
  nowMs: number,
): void {
  db.prepare(
    `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, evidence_json,
       failure_report_json, rollback_report_json, environment_json, server_at_ms, idempotency_key)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ulid(nowMs),
    receiptId,
    event,
    seq,
    input.evidence === undefined ? null : JSON.stringify(input.evidence),
    input.failure_report === undefined ? null : JSON.stringify(input.failure_report),
    input.rollback_report === undefined ? null : JSON.stringify(input.rollback_report),
    input.environment === undefined ? null : JSON.stringify(input.environment),
    nowMs, // server_at_ms: the registry clock is the ONLY timing authority
    idempotencyKey,
  );
}

/**
 * The single writer of `receipt_events`. Forged receipts are impossible not
 * because the rows are hard to write, but because this is the only path that
 * writes them and it derives the actor from AuthContext (§8 threat 6).
 */
export function appendReceiptEvent(db: Db, input: AppendInput): AppendResult {
  if (!RECEIPT_EVENTS.includes(input.event)) {
    throw new ApiError("INVALID_SCHEMA", `event must be one of ${RECEIPT_EVENTS.join("|")}`);
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 128) {
    throw new ApiError("INVALID_SCHEMA", "idempotency_key must be a string of 1..128 characters");
  }
  // §5.3: the declared environment is a property of the handover, so it rides
  // on `delivered` and on nothing else. Guarded here rather than trusted,
  // because a descriptor attached to a later event would be a second, mutable
  // place for the same fact — which is the defect this column exists to close.
  if (input.environment !== undefined && input.event !== "delivered") {
    throw new ApiError("INVALID_SCHEMA", "the declared environment is recorded on `delivered` only (§5.3)");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const receipt = loadReceipt(db, input.receiptId);
    if (!receipt) {
      db.exec("ROLLBACK");
      throw new ApiError("NOT_FOUND", "receipt not found");
    }
    // (2) §6: "only the adopter (AuthContext) may append to their receipt" —
    // defect #3 class. Checked before anything is read or written.
    if (!input.asRegistry && receipt.adopter_agent_id !== input.actorAgentId) {
      db.exec("ROLLBACK");
      throw new ApiError("FORBIDDEN", "only the receipt's own adopter may append to it (§6 surface 8)");
    }

    // (1) idempotency replay, scoped to this receipt by D.1's
    // UNIQUE(adoption_receipt_id, idempotency_key)
    const replay = db
      .prepare("SELECT event, event_seq FROM receipt_events WHERE adoption_receipt_id=? AND idempotency_key=?")
      .get(input.receiptId, input.idempotencyKey) as { event: ReceiptEvent; event_seq: number } | undefined;
    if (replay) {
      db.exec("COMMIT");
      return { receipt_event: replay.event, event_seq: replay.event_seq, noop: true };
    }

    // (3) derived state → the §5.3 table
    const from = derivedState(db, input.receiptId);
    const action = RECEIPT_TRANSITIONS[from][input.event];
    if (action === undefined) {
      db.exec("ROLLBACK");
      throw new ApiError(
        "PRECONDITION_FAILED",
        `a \`${input.event}\` event is not legal from derived state \`${from}\` (§5.3)`,
        from,
      );
    }

    // (5) payload validation happens BEFORE any row is written, so a rejected
    // payload cannot consume an event_seq or an idempotency key
    validateEventPayload(input, receipt, from);

    // (4) event_seq = max+1, the ONLY normative order
    const max = db
      .prepare("SELECT COALESCE(MAX(event_seq), 0) AS m FROM receipt_events WHERE adoption_receipt_id=?")
      .get(input.receiptId) as { m: number };
    let seq = max.m + 1;

    let synthesized: AppendResult["synthesized"];
    if (action === "synthesize_delivered") {
      // §5.3: `attempted` from `none` synthesizes `delivered` (seq 1) in the
      // SAME transaction, with the fixed idempotency key and the fixed
      // `evidence_json={"synthesized":true}` marker, and is activity-logged.
      insertEvent(
        db,
        input.receiptId,
        "delivered",
        seq,
        { evidence: SYNTHESIZED_DELIVERED_EVIDENCE },
        `synth-delivered:${input.receiptId}`,
        input.nowMs,
      );
      db.prepare(
        "INSERT INTO activity_log(id, workspace_id, actor_agent_id, action, subject_id, details_json, created_at_ms) VALUES (?,?,?,?,?,?,?)",
      ).run(
        ulid(input.nowMs),
        receipt.workspace_id,
        null, // the registry synthesized it, not an agent
        "receipt.delivered.synthesized",
        input.receiptId,
        JSON.stringify({ reason: "attempted implies delivered (§5.3)", event_seq: seq }),
        input.nowMs,
      );
      synthesized = { receipt_event: "delivered", event_seq: seq };
      seq += 1;
    }

    insertEvent(db, input.receiptId, input.event, seq, input, input.idempotencyKey, input.nowMs);
    db.exec("COMMIT");
    return synthesized
      ? { receipt_event: input.event, event_seq: seq, synthesized }
      : { receipt_event: input.event, event_seq: seq };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed by the branch that threw
    }
    // D.1's UNIQUE(receipt,event) and the partial terminal index are the
    // backstops under concurrency: a lost race is reported as the converging
    // conflict its winner produced, never as a raw SQLITE_CONSTRAINT.
    const msg = String((e as any)?.message ?? e);
    if (!(e instanceof ApiError) && /UNIQUE|constraint/i.test(msg)) {
      const now = derivedState(db, input.receiptId);
      throw new ApiError("PRECONDITION_FAILED", `receipt already carries a \`${input.event}\`-class event (§5.3)`, now);
    }
    throw e;
  }
}

/** §5.3 staleness: derived, never stored (INSERT-only is preserved). */
export const STALENESS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function isStalled(db: Db, receiptId: string, nowMs: number, windowMs = STALENESS_WINDOW_MS): boolean {
  const state = derivedState(db, receiptId);
  if (TERMINAL_EVENTS.includes(state as ReceiptEvent) || state === "rolled_back") return false;
  const last = db
    .prepare("SELECT MAX(server_at_ms) AS t FROM receipt_events WHERE adoption_receipt_id=?")
    .get(receiptId) as { t: number | null };
  const started = last.t ?? (db.prepare("SELECT created_at_ms AS t FROM adoption_receipts WHERE id=?").get(receiptId) as { t: number } | undefined)?.t;
  if (started === undefined) return false;
  return nowMs - started > windowMs;
}
