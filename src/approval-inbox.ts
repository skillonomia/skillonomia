// THE APPROVAL INBOX — a READ-MODEL over rows this registry already has.
//
// WHAT THIS FILE IS NOT, FIRST, BECAUSE IT IS THE PROPERTY THE WHOLE PACKET
// TURNS ON. It is not a decision engine. It does not decide whether a §7.3
// human gate is satisfied, whether an actor may record a review verdict,
// whether a condition applies to a package, or what an approval authorizes.
// Every one of those is already answered exactly once — `isHumanApprover`,
// `reviewVerdictRefusal`, `approvalConditions`, `publishApprovalSatisfied` in
// `src/approvals.ts` — and this module CALLS them. A second copy of any of them
// would be an Inbox that shows an owner a control the service will refuse, or
// hides one the service would have allowed, and `INV-01` exists for exactly
// that failure.
//
// WHAT IT DOES DO: it turns three unrelated row shapes — review activity and
// `reviews`, `approvals` at `publish` scope, and `adoption_requests` with the
// approval bound to each — into one ordered list of items an owner can work
// through, and it does so DETERMINISTICALLY.
//
// WHY DETERMINISM IS THE GATE AND NOT A NICETY. The three status computations
// below are stated as rules over the rows, and the rules are applied in this
// module — they are never read off the order a `SELECT` returned. That is not
// pedantry: several suites in this tree write a whole run of rows carrying ONE
// timestamp, so "the latest row" is genuinely ambiguous by time alone, and
// SQLite is free to return equal-keyed rows in whatever order a query plan
// happens to produce. Every comparison here is therefore on the pair
// `(created_at_ms, id)`, every ordering is `updated_at_ms DESC, item_id ASC`,
// and the fixture test drives the same projection against a database whose rows
// were INSERTED in the opposite order and against a connection running with
// `PRAGMA reverse_unordered_selects=ON`, and byte-compares the three answers.
//
// WHAT AN ITEM IS ONE OF. `review` and `publish` are one CURRENT projection per
// version — repeated review requests collapse onto the same item rather than
// accumulating rows an operator has to reconcile — and `adopt_high_risk` is one
// projection per REQUEST, because two requests for one version are two
// different decisions and an approval is spent on exactly one of them.
import type { Db } from "./sqlite.ts";
import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";
import {
  approvalConditionDetail,
  approvalConditionSource,
  approvalConditions,
  ELIGIBLE_REASON_CODE,
  isHumanApprover,
  publishApprovalSatisfied,
  requiresHumanApproval,
  reviewVerdictRefusal,
} from "./approvals.ts";
import {
  APPROVAL_KIND_FILTERS,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  APPROVAL_STATUS_FILTERS,
  CONSEQUENCE_OF_KIND,
  CONSOLE_CONTRACT_V2,
  DECIDED_STATUSES,
  INBOX_DECISION_HISTORY_MAX,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  compareInboxItems,
  decodeInboxCursor,
  encodeInboxCursor,
  inboxItemId,
  type ApprovalKind,
  type ApprovalKindFilter,
  type ApprovalStatus,
  type ApprovalStatusFilter,
  type ConsoleInboxEnvelope,
  type ConsoleInboxItemV2,
  type InboxCondition,
  type InboxDecision,
} from "./console-v2.ts";

// ===========================================================================
// The request
// ===========================================================================

export interface InboxQuery {
  status?: unknown;
  kind?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

interface ParsedQuery {
  status: ApprovalStatusFilter;
  kind: ApprovalKindFilter;
  limit: number;
  cursor: { updated_at_ms: number; item_id: string } | null;
}

/**
 * The query string, parsed and REFUSED rather than coerced.
 *
 * An unrecognised `status` or `kind` is `INVALID_SCHEMA` and not a silent
 * fallback to `all`: a caller that misspelled a filter and received a list is a
 * caller reading a different question's answer. The defaults apply only when the
 * member is ABSENT.
 */
export function parseInboxQuery(q: InboxQuery): ParsedQuery {
  const status = q.status === undefined || q.status === null || q.status === "" ? "all" : q.status;
  if (!(APPROVAL_STATUS_FILTERS as readonly unknown[]).includes(status)) {
    throw new ApiError("INVALID_SCHEMA", `status must be one of ${APPROVAL_STATUS_FILTERS.join("|")}`);
  }
  const kind = q.kind === undefined || q.kind === null || q.kind === "" ? "all" : q.kind;
  if (!(APPROVAL_KIND_FILTERS as readonly unknown[]).includes(kind)) {
    throw new ApiError("INVALID_SCHEMA", `kind must be one of ${APPROVAL_KIND_FILTERS.join("|")}`);
  }
  let limit = INBOX_DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== null && q.limit !== "") {
    const n = Number(q.limit);
    if (!Number.isSafeInteger(n) || n < 1 || n > INBOX_MAX_LIMIT) {
      throw new ApiError("INVALID_SCHEMA", `limit must be an integer between 1 and ${INBOX_MAX_LIMIT}`);
    }
    limit = n;
  }
  let cursor: ParsedQuery["cursor"] = null;
  if (q.cursor !== undefined && q.cursor !== null && q.cursor !== "") {
    cursor = decodeInboxCursor(q.cursor);
    if (!cursor) throw new ApiError("INVALID_SCHEMA", "cursor is not one this registry issued");
  }
  return { status: status as ApprovalStatusFilter, kind: kind as ApprovalKindFilter, limit, cursor };
}

/** Which statuses a `?status=` filter selects. `decided` is a FILTER and never
 *  a status: no item is ever `decided`. */
function selectedStatuses(filter: ApprovalStatusFilter): readonly ApprovalStatus[] {
  if (filter === "pending") return ["pending"];
  if (filter === "decided") return DECIDED_STATUSES;
  return APPROVAL_STATUSES;
}

// ===========================================================================
// The rows, and the one comparison that orders them
// ===========================================================================

/** The total order on rows: `(created_at_ms, id)`, ascending. The tiebreak on
 *  `id` is not decoration — this tree writes whole runs of rows sharing one
 *  timestamp, and without it "the latest row" is whatever the plan returned. */
function laterOf<T extends { created_at_ms: number; id: string }>(a: T | null, b: T): T {
  if (a === null) return b;
  if (b.created_at_ms !== a.created_at_ms) return b.created_at_ms > a.created_at_ms ? b : a;
  return b.id > a.id ? b : a;
}

function byRowKey(a: { created_at_ms: number; id: string }, b: { created_at_ms: number; id: string }): number {
  if (a.created_at_ms !== b.created_at_ms) return a.created_at_ms - b.created_at_ms;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface VersionRow {
  id: string;
  skill_id: string;
  semantic_version: string;
  state: string;
  manifest_json: string;
  author_agent_id: string;
  slug: string;
  workspace_id: string;
  owner_agent_id: string;
}

interface ReviewRow {
  id: string;
  skill_version_id: string;
  reviewer_agent_id: string;
  verdict: string;
  note: string | null;
  created_at_ms: number;
}

interface ActivityRow {
  id: string;
  subject_id: string;
  created_at_ms: number;
}

interface ApprovalRow {
  id: string;
  skill_version_id: string;
  adoption_request_id: string | null;
  approver_agent_id: string;
  scope: string;
  decision: string;
  note: string | null;
  created_at_ms: number;
}

interface RequestRow {
  id: string;
  skill_version_id: string;
  adopter_agent_id: string;
  state: string;
  dead_letter_reason: string | null;
  created_at_ms: number;
}

interface ActorRow {
  id: string;
  type: string;
  role: string | null;
}

/**
 * WHO settled a decision, as the two SEPARATE facts a human gate turns on.
 *
 * `actor_type` is not `actor_role` and neither is derived from the other: the
 * §7.3 gate is `agents.type='human'` AND role admin/owner, so a service
 * principal holding `admin` is `{type:"service", role:"admin"}` and can never
 * satisfy it. Collapsing the pair into one "actor" string is how a reader comes
 * to believe a privileged role is a human.
 *
 * `unknown` is used when the deployment has no membership row for the actor in
 * the version's workspace, and it is deliberately NOT the empty string and not
 * `member`: `INV-03` — an absent fact is `unknown` and is never rendered as a
 * zero or as a default value somebody might read as a measurement.
 */
function actorsOf(db: Db, workspaceId: string, ids: readonly string[]): Map<string, ActorRow> {
  const out = new Map<string, ActorRow>();
  if (ids.length === 0) return out;
  const stmt = db.prepare(
    `SELECT a.id, a.type,
            (SELECT role FROM workspace_memberships m WHERE m.agent_id=a.id AND m.workspace_id=?) AS role
       FROM agents a WHERE a.id=?`,
  );
  for (const id of ids) {
    const row = stmt.get(workspaceId, id) as ActorRow | undefined;
    out.set(id, row ?? { id, type: "unknown", role: null });
  }
  return out;
}

function decisionOf(
  decision: string,
  actorId: string,
  note: string | null,
  atMs: number,
  actors: Map<string, ActorRow>,
): InboxDecision {
  const a = actors.get(actorId);
  return {
    decision,
    actor_agent_id: actorId,
    actor_type: a?.type ?? "unknown",
    actor_role: a?.role ?? "unknown",
    note,
    server_at_ms: atMs,
  };
}

/** Bounded from the RECENT end, then returned oldest-first. */
function boundedHistory(all: InboxDecision[]): InboxDecision[] {
  return all.length <= INBOX_DECISION_HISTORY_MAX ? all : all.slice(all.length - INBOX_DECISION_HISTORY_MAX);
}

// ===========================================================================
// Conditions
// ===========================================================================

function manifestOf(v: VersionRow): any {
  try {
    return JSON.parse(v.manifest_json);
  } catch {
    return null;
  }
}

/**
 * The §7.3 conditions, sourced. The IDS and the ORDER are `approvalConditions`'
 * — the same call `skill.publish`, `skill.approve` and `skill.request_adoption`
 * make — and this only attaches each id's declared source and row text so the
 * owner reads WHY without the console having to know the matrix.
 */
function conditionsOf(manifest: any, adoptedCount: number): InboxCondition[] {
  return approvalConditions(manifest, { adoptedCount }).map((code) => ({
    code,
    source: approvalConditionSource(code),
    detail: approvalConditionDetail(code),
  }));
}

/** The declared risk level, or `unknown` when the manifest does not say — which
 *  is a different fact from `low` and stays a different one (`INV-03`). */
function riskLevelOf(manifest: any): string {
  const declared = manifest?.scope?.risk_level;
  return typeof declared === "string" && declared.length > 0 ? declared : "unknown";
}

// ===========================================================================
// The projection
// ===========================================================================

/**
 * Build the whole projection for a workspace, unfiltered and unordered.
 *
 * Exported so a test can run it directly — the determinism claim is about THIS
 * function, and a test that could only reach it through a router would be
 * measuring the router too.
 */
export function projectInbox(db: Db, auth: AuthContext, nowMs: number): ConsoleInboxItemV2[] {
  const workspaceId = auth.workspace_id;

  // Every version of the caller's own workspace. Same-workspace is the whole
  // scope of the Inbox (§6.4 route ACL): a decision is taken by the workspace
  // that owns the skill, and no cross-workspace approval exists in v1.
  const versions = db
    .prepare(
      `SELECT v.id, v.skill_id, v.semantic_version, v.state, v.manifest_json, v.author_agent_id,
              s.slug, s.workspace_id, s.owner_agent_id
         FROM skill_versions v JOIN skills s ON s.id = v.skill_id
        WHERE s.workspace_id = ?`,
    )
    .all(workspaceId) as VersionRow[];
  if (versions.length === 0) return [];

  const byVersion = new Map<string, VersionRow>();
  for (const v of versions) byVersion.set(v.id, v);

  const adoptedCounts = new Map<string, number>();
  const adoptedStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM receipt_events e JOIN adoption_receipts r ON r.id = e.adoption_receipt_id
      WHERE r.skill_version_id = ? AND e.event = 'adopted'`,
  );
  const adoptedCountOf = (versionId: string): number => {
    const seen = adoptedCounts.get(versionId);
    if (seen !== undefined) return seen;
    const c = (adoptedStmt.get(versionId) as { c: number }).c;
    adoptedCounts.set(versionId, c);
    return c;
  };

  const reviews = db
    .prepare(
      `SELECT r.id, r.skill_version_id, r.reviewer_agent_id, r.verdict, r.note, r.created_at_ms
         FROM reviews r JOIN skill_versions v ON v.id = r.skill_version_id
         JOIN skills s ON s.id = v.skill_id WHERE s.workspace_id = ?`,
    )
    .all(workspaceId) as ReviewRow[];

  // A review REQUEST leaves an `activity_log` row and nothing else — surface 3
  // records the notification and does not move the version — so that row is
  // what "the request is newer than the review" is measured against.
  const requests = db
    .prepare(
      `SELECT id, subject_id, created_at_ms FROM activity_log
        WHERE workspace_id = ? AND action = 'skill.review.request'`,
    )
    .all(workspaceId) as ActivityRow[];

  const approvals = db
    .prepare(
      `SELECT a.id, a.skill_version_id, a.adoption_request_id, a.approver_agent_id, a.scope,
              a.decision, a.note, a.created_at_ms
         FROM approvals a JOIN skill_versions v ON v.id = a.skill_version_id
         JOIN skills s ON s.id = v.skill_id WHERE s.workspace_id = ?`,
    )
    .all(workspaceId) as ApprovalRow[];

  const adoptionRequests = db
    .prepare(
      `SELECT ar.id, ar.skill_version_id, ar.adopter_agent_id, ar.state, ar.dead_letter_reason, ar.created_at_ms
         FROM adoption_requests ar JOIN skill_versions v ON v.id = ar.skill_version_id
         JOIN skills s ON s.id = v.skill_id WHERE s.workspace_id = ?`,
    )
    .all(workspaceId) as RequestRow[];

  const actorIds = new Set<string>();
  for (const r of reviews) actorIds.add(r.reviewer_agent_id);
  for (const a of approvals) actorIds.add(a.approver_agent_id);
  const actors = actorsOf(db, workspaceId, [...actorIds].sort());

  const skillRefOf = (v: VersionRow) => ({
    skill_id: v.skill_id,
    skill_version_id: v.id,
    slug: v.slug,
    semantic_version: v.semantic_version,
    risk_level: riskLevelOf(manifestOf(v)),
  });

  const items: ConsoleInboxItemV2[] = [];

  // ---------------------------------------------------------------- review
  //
  // Latest request activity and latest review row, each by `(created_at_ms,
  // id)`. Request newer than review ⇒ `pending`; otherwise the verdict maps
  // `approve→approved`, `reject→denied`, `conditional→conditional`. Repeated
  // requests collapse into this same item — that is what makes it ONE current
  // projection per version rather than a row per act.
  const reviewsByVersion = new Map<string, ReviewRow[]>();
  for (const r of reviews) {
    const list = reviewsByVersion.get(r.skill_version_id);
    if (list) list.push(r);
    else reviewsByVersion.set(r.skill_version_id, [r]);
  }
  const requestsByVersion = new Map<string, ActivityRow[]>();
  for (const a of requests) {
    if (!byVersion.has(a.subject_id)) continue;
    const list = requestsByVersion.get(a.subject_id);
    if (list) list.push(a);
    else requestsByVersion.set(a.subject_id, [a]);
  }

  const reviewSubjects = new Set<string>([...reviewsByVersion.keys(), ...requestsByVersion.keys()]);
  for (const versionId of [...reviewSubjects].sort()) {
    const v = byVersion.get(versionId)!;
    const versionReviews = (reviewsByVersion.get(versionId) ?? []).slice().sort(byRowKey);
    const versionRequests = (requestsByVersion.get(versionId) ?? []).slice().sort(byRowKey);
    let latestReview: ReviewRow | null = null;
    for (const r of versionReviews) latestReview = laterOf(latestReview, r);
    let latestRequest: ActivityRow | null = null;
    for (const a of versionRequests) latestRequest = laterOf(latestRequest, a);

    let status: ApprovalStatus;
    if (latestReview === null) {
      status = "pending";
    } else if (latestRequest !== null && byRowKey(latestReview, latestRequest) < 0) {
      // the request is strictly newer than the review — the version is waiting
      // on a verdict again, and the old verdict is not that verdict
      status = "pending";
    } else if (latestReview.verdict === "approve") {
      status = "approved";
    } else if (latestReview.verdict === "reject") {
      status = "denied";
    } else {
      status = "conditional";
    }

    const refusal = reviewVerdictRefusal(v, auth);
    const history = boundedHistory(
      versionReviews.map((r) =>
        decisionOf(r.verdict, r.reviewer_agent_id, r.note, r.created_at_ms, actors),
      ),
    );
    const stamps = [
      ...versionReviews.map((r) => r.created_at_ms),
      ...versionRequests.map((a) => a.created_at_ms),
    ];
    items.push({
      item_id: inboxItemId("review", versionId),
      kind: "review",
      status,
      skill: skillRefOf(v),
      adoption_request: null,
      // `[]` for `review` and it is not an omission: a review verdict is a
      // technical judgement of the package, not an answer to a §7.3 condition,
      // and listing the conditions here would invite a reviewer to read a
      // human gate as something a verdict discharges.
      conditions: [],
      eligibility: {
        allowed: refusal === null,
        reason_code: refusal === null ? ELIGIBLE_REASON_CODE : refusal.reason_code,
      },
      consequence: CONSEQUENCE_OF_KIND.review,
      decision: latestReview === null
        ? null
        : decisionOf(
            latestReview.verdict,
            latestReview.reviewer_agent_id,
            latestReview.note,
            latestReview.created_at_ms,
            actors,
          ),
      decision_history: history,
      updated_at_ms: Math.max(...stamps),
      server_at_ms: nowMs,
    });
  }

  // --------------------------------------------------------------- publish
  //
  // `approved` when an EFFECTIVE human `approved` row exists — effective is
  // `publishApprovalSatisfied`, the same predicate the publish gate itself
  // calls, so a row whose approver has since stopped passing the human gate
  // stops opening the Inbox's status exactly when it stops opening the gate.
  // Otherwise `denied` if any `denied` row exists, otherwise `pending`. A
  // denial is read from the ROW and not re-validated against the approver's
  // present standing: a refusal that was recorded stays recorded, which is the
  // fail-closed direction.
  const publishByVersion = new Map<string, ApprovalRow[]>();
  for (const a of approvals) {
    if (a.scope !== "publish") continue;
    const list = publishByVersion.get(a.skill_version_id);
    if (list) list.push(a);
    else publishByVersion.set(a.skill_version_id, [a]);
  }

  // A version with no approval row is in the Inbox only while its publish gate
  // is genuinely ahead of it: it declares a §7.3 condition and has not yet been
  // published or left the line. `requiresHumanApproval` is the same predicate
  // `skill.publish` fails closed on.
  const OPEN_TO_PUBLICATION = new Set(["draft", "linted", "reviewed", "verified"]);
  const publishSubjects = new Set<string>(publishByVersion.keys());
  for (const v of versions) {
    if (publishSubjects.has(v.id)) continue;
    if (!OPEN_TO_PUBLICATION.has(v.state)) continue;
    if (requiresHumanApproval(manifestOf(v), { adoptedCount: adoptedCountOf(v.id) })) {
      publishSubjects.add(v.id);
    }
  }

  const humanGate = isHumanApprover(db, auth.agent_id, workspaceId);
  for (const versionId of [...publishSubjects].sort()) {
    const v = byVersion.get(versionId)!;
    const rows = (publishByVersion.get(versionId) ?? []).slice().sort(byRowKey);
    let status: ApprovalStatus;
    if (publishApprovalSatisfied(db, versionId, workspaceId)) status = "approved";
    else if (rows.some((r) => r.decision === "denied")) status = "denied";
    else status = "pending";

    let latest: ApprovalRow | null = null;
    for (const r of rows) latest = laterOf(latest, r);

    const conditions = conditionsOf(manifestOf(v), adoptedCountOf(versionId));
    items.push({
      item_id: inboxItemId("publish", versionId),
      kind: "publish",
      status,
      skill: skillRefOf(v),
      adoption_request: null,
      conditions,
      eligibility: eligibilityForHumanGate(humanGate, status),
      consequence: CONSEQUENCE_OF_KIND.publish,
      decision: latest === null
        ? null
        : decisionOf(latest.decision, latest.approver_agent_id, latest.note, latest.created_at_ms, actors),
      decision_history: boundedHistory(
        rows.map((r) => decisionOf(r.decision, r.approver_agent_id, r.note, r.created_at_ms, actors)),
      ),
      // the rows entering the projection are the approval rows; a version whose
      // gate is merely ahead of it has none, and the version's own creation is
      // the only timestamp there is to sort it by
      updated_at_ms: rows.length === 0 ? versionCreatedAt(db, versionId) : Math.max(...rows.map((r) => r.created_at_ms)),
      server_at_ms: nowMs,
    });
  }

  // ------------------------------------------------------- adopt_high_risk
  //
  // `pending` while the request state is `approval_pending`; otherwise the
  // EXACTLY bound approval yields `approved|denied`; and a
  // `dead_letter(approval_denied)` is always `denied`, which is the backstop
  // for a request whose decision row is not reachable.
  const approvalByRequest = new Map<string, ApprovalRow>();
  for (const a of approvals) {
    if (a.scope !== "adopt_high_risk" || a.adoption_request_id === null) continue;
    // `UNIQUE(adoption_request_id, scope)` makes this at most one row; the
    // tiebreak is here anyway so a database that somehow held two would still
    // project one fixed answer rather than a plan-dependent one.
    approvalByRequest.set(
      a.adoption_request_id,
      laterOf(approvalByRequest.get(a.adoption_request_id) ?? null, a),
    );
  }

  const adoptionSubjects = adoptionRequests
    .filter(
      (r) =>
        r.state === "approval_pending" ||
        approvalByRequest.has(r.id) ||
        (r.state === "dead_letter" && r.dead_letter_reason === "approval_denied"),
    )
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const r of adoptionSubjects) {
    const v = byVersion.get(r.skill_version_id)!;
    const bound = approvalByRequest.get(r.id) ?? null;
    let status: ApprovalStatus;
    if (r.state === "approval_pending") status = "pending";
    else if (bound !== null) status = bound.decision === "approved" ? "approved" : "denied";
    else status = "denied";

    items.push({
      item_id: inboxItemId("adopt_high_risk", r.id),
      kind: "adopt_high_risk",
      status,
      skill: skillRefOf(v),
      adoption_request: {
        adoption_request_id: r.id,
        adopter_agent_id: r.adopter_agent_id,
        state: r.state,
      },
      conditions: conditionsOf(manifestOf(v), adoptedCountOf(v.id)),
      eligibility: eligibilityForHumanGate(humanGate, status),
      consequence: CONSEQUENCE_OF_KIND.adopt_high_risk,
      decision:
        bound === null
          ? null
          : decisionOf(bound.decision, bound.approver_agent_id, bound.note, bound.created_at_ms, actors),
      decision_history:
        bound === null
          ? []
          : [decisionOf(bound.decision, bound.approver_agent_id, bound.note, bound.created_at_ms, actors)],
      updated_at_ms: bound === null ? r.created_at_ms : Math.max(r.created_at_ms, bound.created_at_ms),
      server_at_ms: nowMs,
    });
  }

  return items;
}

/**
 * The human gate's answer, published as the two facts a control needs.
 *
 * `humanGate` is `isHumanApprover`'s verdict and nothing else — this function
 * does not re-derive it, and there is deliberately no branch here on the
 * caller's role: a reviewer, a service principal and a non-human admin all fail
 * `isHumanApprover` for the same reason and get the same code, because the gate
 * is one condition and not three.
 */
function eligibilityForHumanGate(humanGate: boolean, status: ApprovalStatus): { allowed: boolean; reason_code: string } {
  if (!humanGate) {
    return {
      allowed: false,
      reason_code: "NOT_HUMAN_APPROVER",
    };
  }
  if (status !== "pending") return { allowed: false, reason_code: "ALREADY_DECIDED" };
  return { allowed: true, reason_code: ELIGIBLE_REASON_CODE };
}

function versionCreatedAt(db: Db, versionId: string): number {
  const row = db.prepare("SELECT created_at_ms FROM skill_versions WHERE id=?").get(versionId) as
    | { created_at_ms: number }
    | undefined;
  return row?.created_at_ms ?? 0;
}

// ===========================================================================
// The envelope
// ===========================================================================

/**
 * `GET /v1/console/approvals`.
 *
 * Filter, then order, then page — in that order, so a `limit` counts the items
 * the caller ASKED for and not the ones the projection happened to build first.
 */
export function consoleApprovalInbox(
  db: Db,
  auth: AuthContext,
  query: InboxQuery,
  nowMs: number,
): ConsoleInboxEnvelope {
  if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
  const q = parseInboxQuery(query);
  const wanted = new Set<string>(selectedStatuses(q.status));
  const kinds: readonly ApprovalKind[] =
    q.kind === "all" ? APPROVAL_KINDS : [q.kind as ApprovalKind];
  const kindSet = new Set<string>(kinds);

  const all = projectInbox(db, auth, nowMs)
    .filter((i) => kindSet.has(i.kind) && wanted.has(i.status))
    .sort(compareInboxItems);

  let page = all;
  if (q.cursor) {
    const after = q.cursor;
    page = page.filter((i) => compareInboxItems(i, { updated_at_ms: after.updated_at_ms, item_id: after.item_id }) > 0);
  }
  const items = page.slice(0, q.limit);
  const next = page.length > q.limit ? encodeInboxCursor(items[items.length - 1]!) : null;

  return {
    contract: CONSOLE_CONTRACT_V2,
    statuses: APPROVAL_STATUSES,
    kinds: APPROVAL_KINDS,
    status_filters: APPROVAL_STATUS_FILTERS,
    kind_filters: APPROVAL_KIND_FILTERS,
    items,
    next_cursor: next,
  };
}
