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
import { CONSOLE_CONTRACT_V2 } from "./console-v2.ts";
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
  approvalOfRevision,
  approvedRevisionIds,
  approvedRevisionsOf,
  draftActions,
  type ApprovalEligibility,
  type DecisionRecord,
  type DraftActions,
  type RevisionApproval,
} from "./draft-decision.ts";
import {
  DESIRED_STATES,
  DESIRED_STATE_SOURCE,
  EFFECTIVE_FROM,
  OBSERVED_STATE_SOURCE,
  assignmentDetail,
  assignmentEligibility,
  assignmentsOfWorkspace,
  fleetAgents,
  type AssignmentDetail,
  type AssignmentEligibility,
  type FleetAgent,
} from "./assignment-lifecycle.ts";

/**
 * THE DECISION THAT CLOSES *THIS* REVISION — V1 P3.
 *
 * `eligibilityFrom` refuses a revision whose `decided` argument is non-null.
 * Before P3 that argument was the lineage's decision, which was the same thing:
 * a lineage had one decision and no revision could follow it. `revision_approvals`
 * separates the two, so the argument becomes the decision that closes THE
 * REVISION IN HAND — a rejection, which closes the lineage, or this revision's
 * own approval. A newer revision of an approved lineage is open, which is what
 * makes a second approved revision, and therefore a rollback target, reachable.
 */
function closingDecision(
  decision: DecisionRecord | null,
  revisionApproved: boolean,
): DecisionRecord | null {
  if (decision === null) return null;
  if (decision.decision === "rejected") return decision;
  return revisionApproved ? decision : null;
}

/**
 * THE NAME OF THE v1.0.0 CONSOLE CONTRACT, AND IT KEEPS ITS NAME.
 *
 * A console reads a version and refuses a payload it was not built for, which
 * is what "versioned structured API contracts" means in `INV-05` — a wire
 * format with no version is one nobody can change safely.
 *
 * `console.v1` is what the v1.0.0 draft console announced. v1.1 moves what the
 * `/v1/console/*` SURFACE stamps to `console.v2` (SPEC.md section 6.4), because
 * the surface's meaning changed; it does not rename this constant, retire it or
 * reuse the string for something else, because a version that is renamed is a
 * version an operator can no longer use to tell one build from another. So this
 * stays here as the recorded name of the earlier contract — the value
 * `fixtures/v1.0-compat/lifecycle-responses.json` freezes and a v1.0.0 bundle
 * still refuses anything but — and the payloads below announce the version the
 * surface serves today.
 */
export const CONSOLE_CONTRACT_VERSION = "console.v1";

export interface ConsoleInboxItem extends DraftListItem {
  decision: DecisionRecord | null;
  /** whether the head revision of this lineage carries its own approval — the
   *  field that replaces "the lineage is decided, therefore its head is" */
  head_approved: boolean;
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
  /** the approval of the revision being shown, or null */
  revision_approval: RevisionApproval | null;
  /** every approved revision of the lineage — what an assignment may select
   *  and what a rollback may return to (`P3-FR-05`) */
  approved_revisions: RevisionApproval[];
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
  const approved = approvedRevisionIds(db, auth.workspace_id);
  const items = drafts.items.map((item) => {
    const decision = decisions.get(item.draft_id) ?? null;
    const headApproved = approved.has(item.latest_revision_id);
    return {
      ...item,
      decision,
      head_approved: headApproved,
      // the Inbox row IS the latest revision — `listDrafts` selects the head of
      // each lineage — so `isLatest` is true by construction here
      eligibility: eligibilityFrom(
        item.semantic_blocking,
        item.security_blocking,
        true,
        closingDecision(decision, headApproved),
      ),
      state: stateOf(decision),
    };
  });
  return { contract: CONSOLE_CONTRACT_V2, states: INBOX_STATES, items };
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
  const thisApproval = approvalOfRevision(db, detail.revision.revision_id);
  const eligibility = approvalEligibility(
    detail.revision,
    latest ? latest.revision_id : detail.revision.revision_id,
    closingDecision(decision, thisApproval !== null),
  );
  return {
    contract: CONSOLE_CONTRACT_V2,
    draft: detail,
    decision,
    eligibility,
    actions: draftActions(eligibility, decision),
    state: stateOf(decision),
    revision_approval: thisApproval,
    approved_revisions: approvedRevisionsOf(db, detail.draft_id),
  };
}

// ------------------------------------------- V1 P3: the capability / library
//
// A CAPABILITY IS A LINEAGE THAT HAS AN APPROVED REVISION. The library is the
// list of them, and the detail is that lineage's approved revisions beside the
// assignments made of it. Both are read contracts of the same version, and both
// carry the server's verdicts as FIELDS — `P3-FR-16` says the frontend holds no
// second copy of the transition rules, and the way to mean it is that every
// button on the page is a rendering of an `allowed`/`reason_code` pair computed
// in `src/assignment-lifecycle.ts`.

export interface ConsoleCapabilityItem {
  draft_id: string;
  title: string;
  latest_revision_id: string;
  latest_revision: number;
  approved_revisions: RevisionApproval[];
  /** the newest approved revision — what an assignment gets by default */
  head_approval: RevisionApproval | null;
  assignment_count: number;
  active_assignment_count: number;
}

export interface ConsoleCapabilityLibrary {
  contract: string;
  items: ConsoleCapabilityItem[];
}

export interface ConsoleCapability {
  contract: string;
  draft_id: string;
  title: string;
  approved_revisions: RevisionApproval[];
  head_approval: RevisionApproval | null;
  /** the closed fleet this capability may be assigned into (`P3-FR-01`) */
  fleet: FleetAgent[];
  /** per fleet agent, whether the server would accept an assignment now */
  eligibility: AssignmentEligibility[];
  assignments: AssignmentDetail[];
  /** `INV-07` / `P3-FR-14`, as a field rather than a sentence the page holds */
  effective_from: string;
  desired_state_source: string;
  observed_state_source: string;
  lifecycle_states: readonly string[];
}

export interface ConsoleAssignmentView {
  contract: string;
  assignment: AssignmentDetail;
  effective_from: string;
  desired_state_source: string;
  observed_state_source: string;
}

function titleOfDraft(db: Db, auth: AuthContext, draftId: string): string {
  const found = listDrafts(db, auth).items.find((i) => i.draft_id === draftId);
  return found ? found.title : draftId;
}

export function consoleCapabilities(db: Db, auth: AuthContext, nowMs: number): ConsoleCapabilityLibrary {
  const assignments = assignmentsOfWorkspace(db, auth.workspace_id);
  const items: ConsoleCapabilityItem[] = [];
  for (const item of listDrafts(db, auth).items) {
    const approvals = approvedRevisionsOf(db, item.draft_id);
    if (approvals.length === 0) continue; // not a capability until something is approved
    const mine = assignments.filter((a) => a.draft_id === item.draft_id);
    items.push({
      draft_id: item.draft_id,
      title: item.title,
      latest_revision_id: item.latest_revision_id,
      latest_revision: item.latest_revision,
      approved_revisions: approvals,
      head_approval: approvals[approvals.length - 1] ?? null,
      assignment_count: mine.length,
      active_assignment_count: mine.filter((a) => assignmentDetail(db, a, nowMs).desired.state === "active").length,
    });
  }
  return { contract: CONSOLE_CONTRACT_V2, items };
}

export function consoleCapability(db: Db, auth: AuthContext, draftId: unknown, nowMs: number): ConsoleCapability {
  // `getDraft` is the read that resolves the lineage and refuses one of another
  // workspace — the same access rule every other draft surface goes through.
  const detail = getDraft(db, auth, draftId);
  const approvals = approvedRevisionsOf(db, detail.draft_id);
  const head = approvals[approvals.length - 1] ?? null;
  const fleet = fleetAgents(db, auth);
  const assignments = assignmentsOfWorkspace(db, auth.workspace_id)
    .filter((a) => a.draft_id === detail.draft_id)
    .map((a) => assignmentDetail(db, a, nowMs));
  return {
    contract: CONSOLE_CONTRACT_V2,
    draft_id: detail.draft_id,
    title: titleOfDraft(db, auth, detail.draft_id),
    approved_revisions: approvals,
    head_approval: head,
    fleet,
    eligibility: fleet.map((agent) =>
      assignmentEligibility(
        db,
        auth,
        agent.agent_id,
        head,
        head ? head.draft_revision_id : detail.revision.revision_id,
        detail.draft_id,
      ),
    ),
    assignments,
    effective_from: EFFECTIVE_FROM,
    desired_state_source: DESIRED_STATE_SOURCE,
    observed_state_source: OBSERVED_STATE_SOURCE,
    lifecycle_states: DESIRED_STATES,
  };
}

export function consoleAssignmentView(db: Db, assignment: AssignmentDetail): ConsoleAssignmentView {
  return {
    contract: CONSOLE_CONTRACT_V2,
    assignment,
    effective_from: EFFECTIVE_FROM,
    desired_state_source: DESIRED_STATE_SOURCE,
    observed_state_source: OBSERVED_STATE_SOURCE,
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
  return { contract: CONSOLE_CONTRACT_V2, draft_id: base.draft_id, items };
}
