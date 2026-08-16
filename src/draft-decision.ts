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

export interface DecisionResponse {
  draft_id: string;
  decision: DecisionRecord;
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
  if (already) {
    throw new ApiError("CONFLICT", `draft ${detail.draft_id} is already ${already.decision}`, already.decision);
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
  // Read back rather than reconstructed: what the response reports is what the
  // row says, so a CHECK this code did not anticipate surfaces as a failure here
  // instead of as an answer that disagrees with the database.
  const record = decisionOf(db, detail.draft_id);
  if (!record) throw new Error("the decision was written and could not be read back");
  return {
    draft_id: detail.draft_id,
    decision: record,
    eligibility: approvalEligibility(detail.revision, detail.revision.revision_id, record),
  };
}
