// THE CONSOLE'S READ CONTRACTS — `P2-FR-04`, `P2-FR-05`, `P2-FR-11`,
// `P2-FR-12`, `INV-05`.
//
// WHAT THIS FILE IS FOR. The console needs three answers: what is in the inbox,
// what one draft says, and what happened to it. Each answer is a versioned DTO
// with a `contract` field, and every product decision the page makes reads a
// FIELD of one of them:
//
//   may this be approved            → `eligibility.approvable`
//   why not                         → `eligibility.reason_code`
//   is it decided, and how          → `decision.decision`
//   is anything blocking            → `semantic_blocking`, `security_blocking`
//
// None of those is a sentence. `INV-05` and `P2-FR-12` forbid the frontend
// parsing human-readable audit strings for a product decision, and the way to
// mean it is to make sure there is no string that would tempt one: every audit
// entry below is columns, and the one prose field an entry can carry (`reason`)
// is displayed and never read.
//
// WHY THE AUDIT IS A UNION AND WHY IT IS DONE HERE. `0013` records the capture,
// the classification, the compilation and each revision; `0014` records the
// decision. Those are two tables because they were added by two phases and the
// second could not alter the first's CHECK constraint without rebuilding a table
// the contract requires to stay additive. A reader wants ONE history, so the
// union is computed on the way out, over a field set both rows already share.
import type { Db } from "./sqlite.ts";
import type { AuthContext } from "./auth.ts";
import {
  draftAudit,
  getDraft,
  listDrafts,
  type DraftAuditEvent,
  type DraftDetail,
  type DraftListItem,
} from "./capture.ts";
import {
  decisionOf,
  decisionsOf,
  eligibilityFrom,
  approvalEligibility,
  draftActions,
  type ApprovalEligibility,
  type DecisionRecord,
  type DraftActions,
} from "./draft-decision.ts";

/** The version of these shapes. A console reads it and refuses a payload it was
 *  not built for, which is what "versioned structured API contracts" means in
 *  `INV-05` — a wire format with no version is one nobody can change safely. */
export const CONSOLE_CONTRACT_VERSION = "console.v1";

export interface ConsoleInboxItem extends DraftListItem {
  decision: DecisionRecord | null;
  eligibility: ApprovalEligibility;
  /** `pending` until an owner decides; then the decision. A field, not a
   *  computation the page performs over other fields. */
  state: "pending" | "approved" | "rejected";
}

export interface ConsoleInbox {
  contract: string;
  /** the states this deployment can return, so a console renders filter
   *  controls from the server's vocabulary rather than from a hard-coded list */
  states: ReadonlyArray<ConsoleInboxItem["state"]>;
  items: ConsoleInboxItem[];
}

export interface ConsoleDraft {
  contract: string;
  draft: DraftDetail;
  decision: DecisionRecord | null;
  eligibility: ApprovalEligibility;
  /** `P2-FR-11` / `P2-R1-003`: whether the server will approve, reject or revise
   *  this draft — three fields the page renders instead of three rules it holds. */
  actions: DraftActions;
  state: ConsoleInboxItem["state"];
}

export interface ConsoleAuditEntry {
  entry_id: string;
  event: string;
  draft_id: string | null;
  draft_revision_id: string | null;
  capture_id: string;
  actor_agent_id: string;
  actor_role: string;
  source: string;
  correlation_ref: string | null;
  reason_code: string | null;
  result: string;
  content_digest: string | null;
  /** displayed, never parsed for a decision (`P2-FR-12`) */
  reason: string | null;
  provenance: unknown;
  server_at_ms: number;
}

export interface ConsoleAudit {
  contract: string;
  draft_id: string;
  items: ConsoleAuditEntry[];
}

export const INBOX_STATES = ["pending", "approved", "rejected"] as const;

function stateOf(decision: DecisionRecord | null): ConsoleInboxItem["state"] {
  return decision === null ? "pending" : decision.decision;
}

/**
 * `P2-FR-04`: the Inbox is the backend's answer. Every row below comes from
 * `listDrafts`, which reads `draft_revisions`; there is no fixture, no seed and
 * no client-side store anywhere in this path. A deployment with no captures
 * returns an empty list, and an empty list is what the console shows.
 */
export function consoleInbox(db: Db, auth: AuthContext): ConsoleInbox {
  const drafts = listDrafts(db, auth);
  const decisions = decisionsOf(db, auth.workspace_id);
  const items = drafts.items.map((item) => {
    const decision = decisions.get(item.draft_id) ?? null;
    return {
      ...item,
      decision,
      // the Inbox row IS the latest revision — `listDrafts` selects the head of
      // each lineage — so `isLatest` is true by construction here
      eligibility: eligibilityFrom(item.semantic_blocking, item.security_blocking, true, decision),
      state: stateOf(decision),
    };
  });
  return { contract: CONSOLE_CONTRACT_VERSION, states: INBOX_STATES, items };
}

/**
 * `P2-FR-05`: one draft, with the extracted sections, the permissions, the
 * dependencies, the failure modes, the redactions and the two structured
 * previews — all of them fields of `DraftDetail`, which `src/capture.ts` already
 * produces and which this function does not re-shape.
 */
export function consoleDraft(db: Db, auth: AuthContext, draftId: unknown, revisionId?: unknown): ConsoleDraft {
  const detail = getDraft(db, auth, draftId, revisionId);
  const latest = detail.lineage[detail.lineage.length - 1];
  const decision = decisionOf(db, detail.draft_id);
  const eligibility = approvalEligibility(
    detail.revision,
    latest ? latest.revision_id : detail.revision.revision_id,
    decision,
  );
  return {
    contract: CONSOLE_CONTRACT_VERSION,
    draft: detail,
    decision,
    eligibility,
    actions: draftActions(eligibility, decision),
    state: stateOf(decision),
  };
}

function fromDraftEvent(e: DraftAuditEvent): ConsoleAuditEntry {
  return {
    entry_id: e.event_id,
    event: e.event,
    draft_id: e.draft_id,
    draft_revision_id: e.draft_revision_id,
    capture_id: e.capture_id,
    actor_agent_id: e.actor_agent_id,
    actor_role: e.actor_role,
    source: e.source,
    correlation_ref: e.correlation_ref,
    reason_code: e.reason_code,
    result: e.result,
    content_digest: e.content_digest,
    reason: null,
    provenance: e.provenance,
    server_at_ms: e.server_at_ms,
  };
}

function fromDecision(d: DecisionRecord): ConsoleAuditEntry {
  return {
    entry_id: d.decision_id,
    event: d.decision, // `approved` or `rejected` — the event type, in its own field
    draft_id: d.draft_id,
    draft_revision_id: d.draft_revision_id,
    capture_id: d.capture_id,
    actor_agent_id: d.actor_agent_id,
    actor_role: d.actor_role,
    source: d.source,
    correlation_ref: null,
    reason_code: d.reason_code,
    result: d.decision,
    content_digest: d.content_digest,
    reason: d.reason,
    provenance: d.provenance,
    server_at_ms: d.server_at_ms,
  };
}

/**
 * The whole history of one draft, oldest first: what P1 recorded and what P2
 * added, in one field set.
 *
 * Ordering is by `server_at_ms` and then by `entry_id`. The ids are ULIDs minted
 * from the same clock, so the tiebreak is the order they were written in — two
 * events in one millisecond do not swap places between two reads of the same
 * data, which is the property a history has to have to be one.
 */
export function consoleAudit(db: Db, auth: AuthContext, draftId: unknown): ConsoleAudit {
  const base = draftAudit(db, auth, draftId);
  const decision = decisionOf(db, base.draft_id);
  const items = base.items.map(fromDraftEvent);
  if (decision) items.push(fromDecision(decision));
  items.sort((a, b) => a.server_at_ms - b.server_at_ms || (a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0));
  return { contract: CONSOLE_CONTRACT_VERSION, draft_id: base.draft_id, items };
}
