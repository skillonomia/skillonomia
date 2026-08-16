// APPROVE AND REJECT — `P2-FR-08`, `P2-FR-09`, `P2-FR-10`, `INV-05`, `INV-06`.
//
// THE ONE RULE THAT DECIDES THIS FILE: THE ELIGIBILITY IS COMPUTED HERE.
//
//   `P2-FR-11` and `INV-05` say the frontend computes no eligibility, no
//   security result and no state transition. The way to mean that is for the
//   SERVER to answer the question "may this be approved?" as a structured field
//   the page displays, and to refuse the approval itself when the answer is no.
//   Both halves are below: `approvalEligibility` produces the field, and
//   `decideDraftInTx` calls the same function before it writes. A page that
//   disabled its button and a server that trusted it would be one check; this is
//   one check in the one place that cannot be bypassed, and a display of it.
//
//   So the console's button is a RENDERING of `eligibility.approvable`, and a
//   request that ignores the rendering is refused with the same reason code the
//   rendering showed.
//
// WHAT COUNTS AS BLOCKING. `src/draft.ts` already answers that: `SemanticReview`
// and `SecurityReview` each carry a `blocking_count`, computed by the compiler
// when the revision was made and stored WITH the revision. This file reads those
// two numbers and adds nothing to them — a second opinion about what is blocking
// would be a second classifier, and `INV-01` has one.
import type { Db } from "./sqlite.ts";
import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";
import { getDraft, type DraftRevisionView } from "./capture.ts";

export type Decision = "approved" | "rejected";

/** The structured answer to "may this revision be approved?" — one boolean, a
 *  machine-readable reason and the two counts it was computed from. Every field
 *  a console needs to render the state, and no sentence it has to parse. */
export interface ApprovalEligibility {
  approvable: boolean;
  reason_code:
    | "APPROVABLE"
    | "BLOCKING_SEMANTIC_FINDINGS"
    | "BLOCKING_SECURITY_FINDINGS"
    | "ALREADY_DECIDED"
    | "NOT_LATEST_REVISION";
  semantic_blocking: number;
  security_blocking: number;
  /** the decision already on this lineage, when there is one */
  decided: DecisionRecord | null;
}

export interface DecisionRecord {
  decision_id: string;
  draft_id: string;
  draft_revision_id: string;
  capture_id: string;
  decision: Decision;
  actor_agent_id: string;
  actor_role: string;
  source: string;
  reason_code: string;
  reason: string | null;
  content_digest: string;
  provenance: unknown;
  server_at_ms: number;
}

interface DecisionRow {
  id: string;
  draft_id: string;
  draft_revision_id: string;
  capture_id: string;
  decision: Decision;
  actor_agent_id: string;
  actor_role: string;
  source: string;
  reason_code: string;
  reason: string | null;
  content_digest: string;
  provenance_json: string;
  server_at_ms: number;
}

function viewOf(row: DecisionRow): DecisionRecord {
  return {
    decision_id: row.id,
    draft_id: row.draft_id,
    draft_revision_id: row.draft_revision_id,
    capture_id: row.capture_id,
    decision: row.decision,
    actor_agent_id: row.actor_agent_id,
    actor_role: row.actor_role,
    source: row.source,
    reason_code: row.reason_code,
    reason: row.reason,
    content_digest: row.content_digest,
    provenance: JSON.parse(row.provenance_json),
    server_at_ms: row.server_at_ms,
  };
}

/** The decision on a lineage, or null. One row per lineage — `UNIQUE(draft_id)`. */
export function decisionOf(db: Db, draftId: string): DecisionRecord | null {
  const row = db.prepare("SELECT * FROM draft_decisions WHERE draft_id=?").get(draftId) as DecisionRow | undefined;
  return row ? viewOf(row) : null;
}

/** Every decision of a workspace, keyed by lineage — what the Inbox reads so
 *  that listing N drafts is one query rather than N. */
export function decisionsOf(db: Db, workspaceId: string): Map<string, DecisionRecord> {
  const rows = db.prepare("SELECT * FROM draft_decisions WHERE workspace_id=?").all(workspaceId) as DecisionRow[];
  return new Map(rows.map((r) => [r.draft_id, viewOf(r)]));
}

// --------------------------------------------- V1 P3: approval per REVISION
//
// WHY THERE ARE TWO TABLES AND WHY THIS FILE IS THE ONLY PLACE THAT KNOWS IT.
//
// `0014` gave a LINEAGE one decision, `UNIQUE(draft_id)`. `P3-FR-05` and
// `INV-06` need something that table cannot hold: a rollback selects a
// PREVIOUSLY APPROVED REVISION, and a lineage that can carry exactly one
// approval has nothing to roll back to. `0015` adds `revision_approvals`, one
// row per revision, and does not alter `draft_decisions` — rebuilding a
// populated table to widen a UNIQUE is neither additive nor reversible, and the
// first decision an owner took on a lineage is a fact worth keeping as it was.
//
// So the first approval writes BOTH rows and every later one writes only the
// new table. Every reader in the tree goes through the functions below, which
// is the `INV-01` line: two tables, one answer, one module that composes it.

/** An approval of ONE revision: what a rollback may select. */
export interface RevisionApproval {
  approval_id: string;
  draft_id: string;
  draft_revision_id: string;
  capture_id: string;
  revision: number;
  actor_agent_id: string;
  actor_role: string;
  content_digest: string;
  provenance: unknown;
  server_at_ms: number;
}

interface ApprovalRow {
  id: string;
  draft_id: string;
  draft_revision_id: string;
  capture_id: string;
  workspace_id: string;
  revision: number;
  actor_agent_id: string;
  actor_role: string;
  source: string;
  reason_code: string;
  content_digest: string;
  provenance_json: string;
  server_at_ms: number;
}

function approvalOf(row: ApprovalRow): RevisionApproval {
  return {
    approval_id: row.id,
    draft_id: row.draft_id,
    draft_revision_id: row.draft_revision_id,
    capture_id: row.capture_id,
    revision: row.revision,
    actor_agent_id: row.actor_agent_id,
    actor_role: row.actor_role,
    content_digest: row.content_digest,
    provenance: JSON.parse(row.provenance_json),
    server_at_ms: row.server_at_ms,
  };
}

/** Every approved revision of one lineage, oldest first. The rollback targets
 *  (`P3-FR-05`), and the eligible set an assignment may select from. */
export function approvedRevisionsOf(db: Db, draftId: string): RevisionApproval[] {
  const rows = db
    .prepare("SELECT * FROM revision_approvals WHERE draft_id=? ORDER BY revision ASC")
    .all(draftId) as ApprovalRow[];
  return rows.map(approvalOf);
}

/** One revision's approval, or null — the question "may this exact revision be
 *  assigned?" asked of one revision (`P3-FR-01`). */
export function approvalOfRevision(db: Db, revisionId: string): RevisionApproval | null {
  const row = db.prepare("SELECT * FROM revision_approvals WHERE draft_revision_id=?").get(revisionId) as
    | ApprovalRow
    | undefined;
  return row ? approvalOf(row) : null;
}

/** The approved revision ids of a workspace — what the Inbox reads so that
 *  listing N drafts stays one query. */
export function approvedRevisionIds(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .prepare("SELECT draft_revision_id FROM revision_approvals WHERE workspace_id=?")
    .all(workspaceId) as Array<{ draft_revision_id: string }>;
  return new Set(rows.map((r) => r.draft_revision_id));
}

/**
 * `P2-FR-09`, as a value.
 *
 * `revision` is the revision being judged and `latestRevisionId` the head of its
 * lineage. Approving a revision that is no longer the head is refused: an owner
 * who read revision 2, then edited to revision 3, then approved the tab still
 * showing revision 2 would otherwise approve content nobody reviewed. `INV-06`
 * makes both revisions permanent, so the refusal costs nothing but a refetch.
 */
export function approvalEligibility(
  revision: DraftRevisionView,
  latestRevisionId: string,
  decided: DecisionRecord | null,
): ApprovalEligibility {
  return eligibilityFrom(
    revision.semantic_review.blocking_count,
    revision.security_review.blocking_count,
    revision.revision_id === latestRevisionId,
    decided,
  );
}

/**
 * The same rule from the two counts alone, for the Inbox — which reads the
 * counts of every draft in one query and never loads a revision body to decide
 * what a row may offer. One rule, two callers, and the ORDER of the tests is
 * part of it: a decided draft reports `ALREADY_DECIDED` whatever its findings
 * say, because the findings of a decided draft are history.
 */
export function eligibilityFrom(
  semanticBlocking: number,
  securityBlocking: number,
  isLatest: boolean,
  decided: DecisionRecord | null,
): ApprovalEligibility {
  const base = { semantic_blocking: semanticBlocking, security_blocking: securityBlocking, decided };
  if (decided) return { approvable: false, reason_code: "ALREADY_DECIDED", ...base };
  if (!isLatest) return { approvable: false, reason_code: "NOT_LATEST_REVISION", ...base };
  if (semanticBlocking > 0) return { approvable: false, reason_code: "BLOCKING_SEMANTIC_FINDINGS", ...base };
  if (securityBlocking > 0) return { approvable: false, reason_code: "BLOCKING_SECURITY_FINDINGS", ...base };
  return { approvable: true, reason_code: "APPROVABLE", ...base };
}

/** One action, and whether the SERVER will carry it out. `P2-FR-11` says the
 *  frontend computes no state transition; a console that reads these three
 *  booleans is a console that renders a rule instead of holding one. */
export interface ActionEligibility {
  allowed: boolean;
  reason_code: "APPROVABLE" | "REJECTABLE" | "REVISABLE" | ApprovalEligibility["reason_code"];
}

/** The three things an owner can do to a draft from the detail view, each with
 *  the server's answer. */
export interface DraftActions {
  approve: ActionEligibility;
  reject: ActionEligibility;
  revise: ActionEligibility;
}

/**
 * `P2-FR-11`, as a value — P2 REVIEW-1 finding `P2-R1-003`.
 *
 * The console used to disable Save and Reject on `decision !== null`, which made
 * the CLIENT the thing that knew a decided lineage is closed to edits; the server
 * still answered `201` to a direct POST, so a lineage could report `approved`
 * while its head was a revision nobody approved. That is the split `P2-FR-11`
 * forbids, in the direction that matters.
 *
 * So the rule lives here, once. `requireRevisable` below is the enforcement and
 * this is the display of the same fact, both computed from the same decision row.
 */
export function draftActions(eligibility: ApprovalEligibility, decided: DecisionRecord | null): DraftActions {
  const closed: ActionEligibility = { allowed: false, reason_code: "ALREADY_DECIDED" };
  // V1 P3 narrows ONE half of this rule and leaves the other exactly as P2 left
  // it. A REJECTED lineage is closed to everything, as before. An APPROVED one
  // is closed to a second lineage-level DECISION — an approval is not undone by
  // a rejection — but not to a further revision: `P3-FR-05` and `P5` both
  // require a lineage to be able to carry more than one approved revision, and
  // the defect `P2-R1-003` closed was a lineage whose reported state disagreed
  // with its head. That disagreement is what `revision_approvals` removes:
  // approval is now a fact about a revision, `eligibility` above is computed
  // about the revision in hand, and the head's own approval state is a field
  // rather than an inference from the lineage's first decision.
  const rejected = decided !== null && decided.decision === "rejected";
  return {
    approve: { allowed: eligibility.approvable, reason_code: eligibility.reason_code },
    reject: decided ? closed : { allowed: true, reason_code: "REJECTABLE" },
    revise: rejected ? closed : { allowed: true, reason_code: "REVISABLE" },
  };
}

/**
 * The enforcement half: a decided lineage takes no further revision.
 *
 * `INV-06` is preserved by refusing rather than by rewriting — the approved
 * revision stays exactly as it was, every earlier revision stays, and the audit
 * is not touched. The refusal is `CONFLICT` with `current_state` set to the
 * decision, which is the converging-conflict shape Appendix H requires and the
 * same one `decideDraftInTx` already answers a second decision with.
 */
export function requireRevisable(db: Db, draftId: string): void {
  const decided = decisionOf(db, draftId);
  if (decided && decided.decision === "rejected") {
    throw new ApiError(
      "CONFLICT",
      `draft ${draftId} is already rejected; a rejected draft takes no further revision`,
      decided.decision,
    );
  }
}

export interface DecisionResponse {
  draft_id: string;
  decision: DecisionRecord;
  /** the approval of the exact revision this call decided, when it approved
   *  one. `decision` above is the lineage's FIRST decision and stays that. */
  revision_approval?: RevisionApproval | null;
  /** the eligibility AFTER the decision — so a console renders the new state
   *  from the same field it rendered the old one from */
  eligibility: ApprovalEligibility;
}

function reasonText(input: Record<string, unknown>): string | null {
  const raw = input.reason;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ApiError("INVALID_SCHEMA", "reason must be a string");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) throw new ApiError("LIMIT_EXCEEDED", "reason exceeds 2000 characters");
  return trimmed;
}

/**
 * Approve or reject, inside the caller's transaction.
 *
 * WHAT IS WRITTEN AND WHY EACH FIELD IS THERE:
 *
 *   `draft_revision_id` and `content_digest` — `P2-FR-08` requires the exact
 *   revision and its digest, and the digest is copied from the revision row
 *   rather than recomputed, so an approval names what the owner read;
 *   `actor_agent_id` and `actor_role` — the owner, from the `AuthContext` and
 *   never from the payload, which is the rule `src/auth.ts` states;
 *   `server_at_ms` — the registry clock;
 *   `reason` — required for a rejection by the schema, optional for an approval;
 *   `provenance_json` — the structured payload beside the columns, carrying the
 *   two blocking counts the decision was taken against. It is never where a
 *   reader has to go to find one of the columns (`INV-05`).
 *
 * The redaction rule of P1 applies to the reason: it is an owner's prose and it
 * travels to a row and to an audit, so it goes through the same function the
 * body of a capture goes through.
 */
export function decideDraftInTx(
  db: Db,
  auth: AuthContext,
  draftId: unknown,
  decision: Decision,
  input: Record<string, unknown>,
  nowMs: number,
  redactText: (text: string) => string,
): DecisionResponse {
  if (auth.role !== "owner" && auth.role !== "admin") {
    throw new ApiError("FORBIDDEN", "deciding a draft is an owner or admin action");
  }
  // `getDraft` is the read every other surface uses: it resolves the lineage,
  // refuses one of another workspace and answers NOT_FOUND for one that is not
  // there. A second lookup here would be a second access rule.
  const detail = getDraft(db, auth, draftId);
  const revisionId = input.revision_id;
  if (revisionId !== undefined && typeof revisionId !== "string") {
    throw new ApiError("INVALID_SCHEMA", "revision_id must be a string");
  }
  // The caller names the revision it decided on. That is not decoration: it is
  // what makes a stale tab detectable rather than silently approved.
  //
  // `current_state` is on every CONFLICT and PRECONDITION_FAILED because
  // `src/errors.ts` requires it: Appendix H's converging-conflict rule is that a
  // caller is told what the state IS, so a console refetches and shows the truth
  // rather than guessing from a message.
  if (typeof revisionId === "string" && revisionId !== detail.revision.revision_id) {
    throw new ApiError("CONFLICT", "the draft has a newer revision than the one this decision names", "pending");
  }
  const already = decisionOf(db, detail.draft_id);
  // A rejection is terminal for the lineage, and a decided lineage takes no
  // SECOND lineage-level decision — both as P2 left them. What P3 changes is
  // that an approved lineage may approve a LATER revision, which is a fact
  // about a revision and lands in `revision_approvals`.
  if (already && (already.decision === "rejected" || decision === "rejected")) {
    throw new ApiError("CONFLICT", `draft ${detail.draft_id} is already ${already.decision}`, already.decision);
  }
  if (approvalOfRevision(db, detail.revision.revision_id)) {
    throw new ApiError("CONFLICT", `revision ${detail.revision.revision_id} is already approved`, "approved");
  }

  const eligibility = approvalEligibility(detail.revision, detail.revision.revision_id, null);
  if (decision === "approved" && !eligibility.approvable) {
    throw new ApiError("PRECONDITION_FAILED", `draft cannot be approved: ${eligibility.reason_code}`, "pending");
  }
  const raw = reasonText(input);
  if (decision === "rejected" && raw === null) {
    throw new ApiError("INVALID_SCHEMA", "a rejection requires a reason");
  }
  const reason = raw === null ? null : redactText(raw);

  const id = ulid(nowMs);
  const reasonCode = decision === "approved" ? "OWNER_APPROVED" : "OWNER_REJECTED";
  const provenance = {
    decided_from_revision: detail.revision.revision,
    semantic_blocking: eligibility.semantic_blocking,
    security_blocking: eligibility.security_blocking,
    semantic_status: detail.revision.semantic_review.status,
    compiler_version: detail.revision.compiler_version,
  };
  // The FIRST decision of a lineage writes `0014`'s row, and only the first:
  // that table's `UNIQUE(draft_id)` is what makes it the record of the first
  // decision, and it is not altered by this phase.
  if (!already) {
    db.prepare(
      `INSERT INTO draft_decisions(id, draft_id, draft_revision_id, capture_id, workspace_id, decision,
                                   actor_agent_id, actor_role, source, reason_code, reason, content_digest,
                                   provenance_json, server_at_ms)
       VALUES (?,?,?,?,?,?,?,?,'owner',?,?,?,?,?)`,
    ).run(
      id,
      detail.draft_id,
      detail.revision.revision_id,
      detail.revision.capture_id,
      auth.workspace_id,
      decision,
      auth.agent_id,
      auth.role,
      reasonCode,
      reason,
      detail.revision.content_digest,
      JSON.stringify(provenance),
      nowMs,
    );
  }
  // EVERY approval writes the per-revision row, including the first. A rollback
  // target is an approved REVISION (`P3-FR-05`), so the set of them has to be
  // complete in one place — a set that is the union of "the first, over there"
  // and "the rest, over here" is a set two readers assemble differently.
  if (decision === "approved") {
    db.prepare(
      `INSERT INTO revision_approvals(id, draft_id, draft_revision_id, capture_id, workspace_id, revision,
                                      actor_agent_id, actor_role, source, reason_code, content_digest,
                                      provenance_json, server_at_ms)
       VALUES (?,?,?,?,?,?,?,?,'owner',?,?,?,?)`,
    ).run(
      ulid(nowMs),
      detail.draft_id,
      detail.revision.revision_id,
      detail.revision.capture_id,
      auth.workspace_id,
      detail.revision.revision,
      auth.agent_id,
      auth.role,
      reasonCode,
      detail.revision.content_digest,
      JSON.stringify(provenance),
      nowMs,
    );
  }
  // Read back rather than reconstructed: what the response reports is what the
  // row says, so a CHECK this code did not anticipate surfaces as a failure here
  // instead of as an answer that disagrees with the database.
  const record = decisionOf(db, detail.draft_id);
  if (!record) throw new Error("the decision was written and could not be read back");
  return {
    draft_id: detail.draft_id,
    decision: record,
    eligibility: approvalEligibility(detail.revision, detail.revision.revision_id, record),
    /** `P3`: the approval of THIS revision, which is what an assignment names.
     *  `decision` above stays the lineage's first decision, unchanged. */
    revision_approval: decision === "approved" ? approvalOfRevision(db, detail.revision.revision_id) : null,
  };
}
