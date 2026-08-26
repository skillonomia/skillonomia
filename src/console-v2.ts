// THE v1.1 CONSOLE CONTRACT — `console.v2`.
//
// WHAT THIS FILE IS AND IS NOT. It is the wire contract of `/v1/console/*` in
// v1.1: the version string, the closed vocabularies a payload may draw on, the
// shapes of the payloads themselves, and the validators that decide whether a
// request is one of them. It is NOT the Console. Nothing here reads the
// database, evaluates an ACL, computes eligibility or decides an outcome — the
// routes P1 adds call the existing `Registry` service layer for every one of
// those, which is the whole content of INV-01 and the reason a second
// implementation of a decision cannot appear in a browser.
//
// WHY THE VERSION MOVES AT ALL. `console.v1` (`src/console-view.ts`) describes
// the v1.0.0 capture/draft console and keeps describing it, unchanged. v1.1
// adds Proofline dashboards, an approval inbox over three different kinds of
// decision, and lifecycle mutations, and it changes what a `/v1/console/*`
// envelope means: an inbox item is now a PROJECTION over rows rather than a row,
// and its `status` is computed by rules that are stated in the specification and
// not by the order a SQLite query returned. A payload whose meaning changed and
// whose version did not is a payload an older bundle parses confidently and
// wrongly. So the version moves, and a bundle that does not know `console.v2`
// must REFUSE the payload rather than guess which fields it recognises —
// `assertConsoleContract` below is that refusal, exported so the browser bundle
// and the server share one definition of it.
//
// WHY THE VOCABULARIES ARE EXPORTED CONSTANTS AND NOT UNIONS ALONE. Every
// closed set a payload announces — the eleven views, the three kinds, the four
// statuses, the four decision labels — is a RUNTIME array with the type derived
// from it. A union alone cannot be enumerated at run time, and a set only the
// compiler knows about is exactly what drifted from the specification in
// v1.0.0 (`src/errors.ts` carries the same note about the error space, for the
// same reason). A guard test compares each of these against SPEC.md.
import { DASHBOARD_VIEWS, type DashboardView } from "./dashboard.ts";

/**
 * The contract every `/v1/console/*` success and error payload declares.
 *
 * `console.v1` is not retired here and is not renamed: it is the v1.0.0 draft
 * console's contract and stays exactly where it is, so a deployment that has
 * not moved keeps parsing its own payloads. Two versions coexisting is the
 * point of versioning them.
 */
export const CONSOLE_CONTRACT_V2 = "console.v2";

/**
 * The refusal an older bundle owes a payload it was not built for.
 *
 * Stated once, HERE, and imported by both halves. The failure this prevents is
 * specific and has a history in this project: a reader that treats an unknown
 * version as "probably compatible" reads the fields it recognises and silently
 * ignores the ones that changed meaning — so an inbox whose `status` is now a
 * projection gets rendered as though it were still a row, and the operator sees
 * a decision that was never made. Refusing is the honest answer, and the caller
 * is told which version it got.
 */
export function isConsoleV2(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { contract?: unknown }).contract === CONSOLE_CONTRACT_V2
  );
}

/** Throws with the observed version rather than returning false, for the caller
 *  that has nothing sensible to do with a payload it cannot read. */
export function assertConsoleContract(payload: unknown): void {
  if (isConsoleV2(payload)) return;
  const seen =
    typeof payload === "object" && payload !== null
      ? JSON.stringify((payload as { contract?: unknown }).contract ?? null)
      : "no payload";
  throw new Error(
    `this build reads ${CONSOLE_CONTRACT_V2} and the server sent ${seen}. ` +
      `Refusing rather than guessing which fields still mean what they used to.`,
  );
}

// ===========================================================================
// The Proofline views
// ===========================================================================

/**
 * The eleven views a Console session may open.
 *
 * A SLICE of `DASHBOARD_VIEWS`, not a second list — it IS that array. The
 * confirmed v1.0.0 gap was that the data for all eleven existed and the Console
 * showed none of them; a console-side copy of the names would be a second place
 * for a view to fail to appear, which is the defect restated rather than fixed.
 * The ACL and the payload both come from the same `Registry.dashboard()` the
 * bearer and MCP surfaces use, so a Console session can never see a row a
 * bearer token could not.
 */
export const CONSOLE_VIEWS: readonly DashboardView[] = DASHBOARD_VIEWS;

export function isConsoleView(v: unknown): v is DashboardView {
  return typeof v === "string" && (CONSOLE_VIEWS as readonly string[]).includes(v);
}

/**
 * `GET /v1/console/dashboard/{view}`.
 *
 * `sections` is deliberately typed as the dashboard's own serialized section
 * shape rather than restated here: every Cell keeps its value, kind, why,
 * source, window and bounds, and a console-side re-declaration of that shape is
 * a place for a provenance field to be dropped on its way to the operator
 * (P2-FR-02). `views` travels with every payload so the navigation is built
 * from the server's vocabulary and not from a list compiled into the bundle.
 */
export interface ConsoleDashboardEnvelope<TSection = unknown, TNotice = unknown> {
  contract: typeof CONSOLE_CONTRACT_V2;
  view: DashboardView;
  title: string;
  views: readonly DashboardView[];
  sections: TSection[];
  demo_mode: boolean;
  notices: TNotice[];
}

// ===========================================================================
// The Approval Inbox
// ===========================================================================

/**
 * The three kinds of decision an owner is asked for, which are three DIFFERENT
 * questions and are kept apart everywhere.
 *
 * `review` is a reviewer's technical verdict on a version. `publish` is a
 * human's decision to make a version externally adoptable. `adopt_high_risk` is
 * a human's decision about ONE adoption request by ONE adopter. Collapsing any
 * two of them would let an actor who may answer one answer another: a reviewer
 * may record a verdict and may not pass a human gate, and a service principal
 * holding role admin may call and can never satisfy a human gate at all.
 */
export const APPROVAL_KINDS = ["review", "publish", "adopt_high_risk"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** What an item's projection can currently say. `conditional` is a review
 *  verdict and has no counterpart among the human decisions; it is in the set
 *  because a filter control is rendered from the server's vocabulary. */
export const APPROVAL_STATUSES = ["pending", "approved", "denied", "conditional"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** `?status=` — `decided` is the union of the three settled statuses, which is
 *  a filter and not a status: an item is never `decided`. */
export const APPROVAL_STATUS_FILTERS = ["pending", "decided", "all"] as const;
export type ApprovalStatusFilter = (typeof APPROVAL_STATUS_FILTERS)[number];

export const APPROVAL_KIND_FILTERS = [...APPROVAL_KINDS, "all"] as const;
export type ApprovalKindFilter = (typeof APPROVAL_KIND_FILTERS)[number];

/** The statuses `status=decided` selects. Derived from `APPROVAL_STATUSES` by
 *  removing the one that is not a decision, so a status added later is decided
 *  unless somebody says otherwise — which is the safe direction: a new status
 *  wrongly shown in a decided list is visible, one wrongly hidden is not. */
export const DECIDED_STATUSES: readonly ApprovalStatus[] = APPROVAL_STATUSES.filter(
  (s) => s !== "pending",
);

/** Default and maximum page size. The Inbox is a projection over unbounded
 *  history and an operator's browser is not the place to discover that. */
export const INBOX_DEFAULT_LIMIT = 50;
export const INBOX_MAX_LIMIT = 200;

/**
 * What an item is a decision ABOUT, and at what granularity — the field that
 * makes an approval non-reusable rather than a promise that it is.
 *
 * `one_adoption_request` is the load-bearing one: a high-risk approval is bound
 * to an exact `adoption_request_id` and a second request from the same adopter
 * for the same version remains pending. The scope is on the wire so a Console
 * can SAY that before the owner clicks, instead of the owner inferring it.
 */
export const CONSEQUENCE_SCOPES = [
  "one_skill_version_review",
  "one_skill_version_publish_gate",
  "one_adoption_request",
] as const;
export type ConsequenceScope = (typeof CONSEQUENCE_SCOPES)[number];

/** The scope each kind carries. A map rather than a rule, because the three are
 *  not derivable from one another and a rule would invite one to be inferred. */
export const SCOPE_OF_KIND: Readonly<Record<ApprovalKind, ConsequenceScope>> = {
  review: "one_skill_version_review",
  publish: "one_skill_version_publish_gate",
  adopt_high_risk: "one_adoption_request",
};

/**
 * `item_id` — `<kind>:<subject>`, where the subject is the thing the item is one
 * projection OF.
 *
 * `review` and `publish` are one current projection per version, so repeated
 * requests collapse onto the same id rather than accumulating rows an operator
 * has to reconcile. `adopt_high_risk` is one projection per REQUEST, because
 * two requests for one version are two different decisions.
 */
export function inboxItemId(kind: ApprovalKind, subjectId: string): string {
  return `${kind}:${subjectId}`;
}

/** The inverse, total: an id whose kind is not one of the three is not an item
 *  id, and saying so is the whole value of parsing it here rather than at each
 *  call site with a `split(":")`. */
export function parseInboxItemId(id: unknown): { kind: ApprovalKind; subject_id: string } | null {
  if (typeof id !== "string") return null;
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  const kind = id.slice(0, at);
  if (!(APPROVAL_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as ApprovalKind, subject_id: id.slice(at + 1) };
}

/** The server's answer to "may this actor do this", which the frontend renders
 *  and never computes (INV-02). A `reason_code` is mandatory even when allowed,
 *  so a disabled control always has an exact reason to show. */
export interface ConsoleEligibility {
  allowed: boolean;
  reason_code: string;
}

export interface InboxSkillRef {
  skill_id: string;
  skill_version_id: string;
  slug: string;
  semantic_version: string;
  risk_level: string;
}

export interface InboxAdoptionRequestRef {
  adoption_request_id: string;
  adopter_agent_id: string;
  state: string;
}

/** Why a decision is being asked for, sourced. `source` names where the
 *  condition was read from — `signed_manifest` for a risk declaration the author
 *  signed — so an owner can tell a fact of the package from a fact of the
 *  deployment. */
export interface InboxCondition {
  code: string;
  source: string;
  detail: string;
}

export interface InboxConsequence {
  scope: ConsequenceScope;
  reusable: boolean;
  blocks_until_decided: boolean;
}

/** A settled decision, with WHO settled it. `actor_type` is separate from
 *  `actor_role` because the human gate is about the type: a service principal
 *  holding role admin is `type='service'` and can never satisfy it. */
export interface InboxDecision {
  decision: string;
  actor_agent_id: string;
  actor_type: string;
  actor_role: string;
  note: string | null;
  server_at_ms: number;
}

/**
 * One row of the Inbox.
 *
 * The nullability is KIND-SPECIFIC and stated here rather than left to be
 * discovered: `adoption_request` is present only for `adopt_high_risk` and null
 * for the other two; `conditions` is an empty array for `review` and a real
 * list for the other two; `decision` is the latest review, the latest approval
 * or the bound approval respectively, or null while pending.
 */
export interface ConsoleInboxItemV2 {
  item_id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  skill: InboxSkillRef;
  adoption_request: InboxAdoptionRequestRef | null;
  conditions: InboxCondition[];
  eligibility: ConsoleEligibility;
  consequence: InboxConsequence;
  decision: InboxDecision | null;
  /** the maximum timestamp of the rows that entered this projection — the
   *  first half of the stable sort key, and the value a cursor carries */
  updated_at_ms: number;
  server_at_ms: number;
}

export interface ConsoleInboxEnvelope {
  contract: typeof CONSOLE_CONTRACT_V2;
  statuses: readonly ApprovalStatus[];
  kinds: readonly ApprovalKind[];
  items: ConsoleInboxItemV2[];
  /** opaque; `null` when the page is the last one */
  next_cursor: string | null;
}

/**
 * The stable order: `updated_at_ms DESC, item_id ASC`.
 *
 * Exported as a COMPARATOR rather than described in prose, because the property
 * that matters is that a fixture yields one fixed JSON whatever the query plan
 * did — and a comparator can be run against that fixture. The tiebreak on
 * `item_id` is what makes the order total; without it two items written in one
 * millisecond swap places between runs and the fixture is not a fixture.
 */
export function compareInboxItems(a: { updated_at_ms: number; item_id: string }, b: { updated_at_ms: number; item_id: string }): number {
  if (a.updated_at_ms !== b.updated_at_ms) return b.updated_at_ms - a.updated_at_ms;
  return a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0;
}

/** The cursor is that same pair and nothing else, so paging cannot disagree
 *  with ordering. Opaque on the wire; this is the one place that knows it is
 *  not, which is what lets the encoding change without a client noticing. */
export function encodeInboxCursor(item: { updated_at_ms: number; item_id: string }): string {
  return Buffer.from(`${item.updated_at_ms}|${item.item_id}`, "utf8").toString("base64url");
}

export function decodeInboxCursor(cursor: unknown): { updated_at_ms: number; item_id: string } | null {
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const at = decoded.indexOf("|");
  if (at <= 0) return null;
  const ms = Number(decoded.slice(0, at));
  if (!Number.isSafeInteger(ms)) return null;
  const id = decoded.slice(at + 1);
  if (id.length === 0) return null;
  return { updated_at_ms: ms, item_id: id };
}

// ===========================================================================
// The mutations
// ===========================================================================

/** `POST /v1/console/versions/{id}/reviews` */
export interface ConsoleReviewRequest {
  action: "request" | "verdict";
  verdict?: "approve" | "reject" | "conditional";
  note?: string;
  idempotency_key?: string;
}

/** `POST /v1/console/versions/{id}/approvals` */
export interface ConsoleApprovalRequest {
  scope: "publish" | "adopt_high_risk";
  decision: "approved" | "denied";
  /** required for `adopt_high_risk`, FORBIDDEN for `publish` */
  adoption_request_id?: string;
  note?: string;
  idempotency_key?: string;
}

export const REVIEW_ACTIONS = ["request", "verdict"] as const;
export const REVIEW_VERDICTS = ["approve", "reject", "conditional"] as const;
export const APPROVAL_SCOPES = ["publish", "adopt_high_risk"] as const;
export const APPROVAL_DECISIONS = ["approved", "denied"] as const;

/** The one failure a validator returns: the JSON pointer at the member that is
 *  wrong and a stable code, which is the shape v1.1 requires every validation
 *  error category to carry, so the published documentation can anchor one
 *  section per category. */
export interface ContractViolation {
  pointer: string;
  code: string;
  detail: string;
}

const NOTE_MAX = 2000;
const IDEMPOTENCY_KEY_MAX = 128;

function member(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

function checkOptionalText(
  body: unknown,
  name: string,
  max: number,
  out: ContractViolation[],
): void {
  const v = member(body, name);
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || v.length > max) {
    out.push({ pointer: `/${name}`, code: "INVALID_SCHEMA", detail: `${name} must be a string of at most ${max} characters` });
  }
}

/**
 * The review body, checked at the boundary.
 *
 * `action:"verdict"` REQUIRES a verdict and `action:"request"` refuses one —
 * the two are different acts and a body that carries a verdict while asking for
 * a review is ambiguous, not merely redundant. A validator that ignored the
 * extra member would let a caller believe a verdict was recorded.
 */
export function validateConsoleReview(body: unknown): ContractViolation[] {
  const out: ContractViolation[] = [];
  const action = member(body, "action");
  if (!(REVIEW_ACTIONS as readonly unknown[]).includes(action)) {
    out.push({ pointer: "/action", code: "INVALID_SCHEMA", detail: `action must be one of ${REVIEW_ACTIONS.join("|")}` });
  }
  const verdict = member(body, "verdict");
  if (action === "verdict") {
    if (!(REVIEW_VERDICTS as readonly unknown[]).includes(verdict)) {
      out.push({ pointer: "/verdict", code: "INVALID_SCHEMA", detail: `verdict must be one of ${REVIEW_VERDICTS.join("|")}` });
    }
  } else if (verdict !== undefined) {
    out.push({ pointer: "/verdict", code: "INVALID_SCHEMA", detail: "verdict is not permitted when action is `request`" });
  }
  checkOptionalText(body, "note", NOTE_MAX, out);
  checkOptionalText(body, "idempotency_key", IDEMPOTENCY_KEY_MAX, out);
  return out;
}

/**
 * The human-approval body, checked at the boundary.
 *
 * `adoption_request_id` is REQUIRED for `adopt_high_risk` and FORBIDDEN for
 * `publish`, and both halves are enforced. The required half is what binds an
 * approval to one exact request so it cannot be spent on another; the forbidden
 * half is what stops a publish approval from arriving carrying a request id that
 * a later reader would take for a binding it does not have.
 */
export function validateConsoleApproval(body: unknown): ContractViolation[] {
  const out: ContractViolation[] = [];
  const scope = member(body, "scope");
  if (!(APPROVAL_SCOPES as readonly unknown[]).includes(scope)) {
    out.push({ pointer: "/scope", code: "INVALID_SCHEMA", detail: `scope must be one of ${APPROVAL_SCOPES.join("|")}` });
  }
  if (!(APPROVAL_DECISIONS as readonly unknown[]).includes(member(body, "decision"))) {
    out.push({ pointer: "/decision", code: "INVALID_SCHEMA", detail: `decision must be one of ${APPROVAL_DECISIONS.join("|")}` });
  }
  const requestId = member(body, "adoption_request_id");
  if (scope === "adopt_high_risk") {
    if (typeof requestId !== "string" || requestId.length === 0) {
      out.push({
        pointer: "/adoption_request_id",
        code: "INVALID_SCHEMA",
        detail: "adopt_high_risk approval must name the exact adoption request it is bound to",
      });
    }
  } else if (scope === "publish" && requestId !== undefined) {
    out.push({
      pointer: "/adoption_request_id",
      code: "INVALID_SCHEMA",
      detail: "a publish approval is not bound to an adoption request and must not name one",
    });
  }
  checkOptionalText(body, "note", NOTE_MAX, out);
  checkOptionalText(body, "idempotency_key", IDEMPOTENCY_KEY_MAX, out);
  return out;
}

/**
 * The four labels a human decision control may carry, exactly.
 *
 * They are here, in the contract, rather than in a template, because the rule
 * they enforce is a rule about CONSEQUENCE and not about wording: a control
 * reading `Confirm` tells an operator nothing about what is being confirmed,
 * which object it applies to or that a high-risk adoption approval is spent on
 * ONE request. `Confirm`, `OK`, `Yes` and a bare `Submit` are refused for these
 * four actions, and `HUMAN_DECISION_LABELS` is what a test compares the rendered
 * control against.
 */
export const HUMAN_DECISION_LABELS = {
  approve_adoption: "Approve this adoption",
  deny_adoption: "Deny this adoption",
  approve_publication: "Approve publication",
  deny_publication: "Deny publication",
} as const;

export type HumanDecisionAction = keyof typeof HUMAN_DECISION_LABELS;

/** The labels a consequential control may NOT carry. A list, because the
 *  property is negative and a negative property needs something to test. */
export const FORBIDDEN_DECISION_LABELS: readonly string[] = ["Confirm", "OK", "Yes", "Submit"];

// ===========================================================================
// The session
// ===========================================================================

/**
 * The roles a Console ticket and session admit.
 *
 * `reviewer` is in the set and that is the whole of what it buys: a reviewer
 * can open the Console and record a review verdict. It does NOT widen the
 * resource ACL — the route checks the session role first and then calls the
 * same service method with the same `AuthContext` a bearer token would carry —
 * so a reviewer meets `FORBIDDEN` at a human approval, at revoke and at every
 * owner-only operation, and an author or skill owner keeps the self-review
 * prohibition whatever role they hold.
 */
export const CONSOLE_SESSION_ROLES = ["owner", "admin", "reviewer"] as const;
export type ConsoleSessionRole = (typeof CONSOLE_SESSION_ROLES)[number];

export function isConsoleSessionRole(v: unknown): v is ConsoleSessionRole {
  return typeof v === "string" && (CONSOLE_SESSION_ROLES as readonly string[]).includes(v);
}

/** The kinds a reviewer session may ask the Inbox for. Anything else — another
 *  kind, or `all` — is `FORBIDDEN` rather than silently filtered, because a
 *  silently narrowed list reads as "there is nothing to decide". */
export const REVIEWER_VISIBLE_KINDS: readonly ApprovalKindFilter[] = ["review"];
