// §7.3 human-approval matrix — recorded in `approvals`, enforced at API level.
//
// The P4 scope of this module is NEGATIVE/precondition behaviour only: an
// approval cannot be reused, bypassed, or attached to a different request, and
// a missing approval cannot cause delivery or adoption. The delivery machine
// and the adoption surfaces themselves are P5 — this module ships the matrix,
// the recording path with its human gate, and the two satisfaction predicates
// those P5 surfaces will call.
//
// Two invariants carry the whole gate:
//
//   1. The human gate is `agents.type='human'` WITH workspace role admin/owner.
//      A service key — or any non-human agent, however privileged — can never
//      satisfy it (§6 ACL matrix: "human approval (§7.3) … admin/owner,
//      `type=human` only"). It is re-checked by the predicates, so an approval
//      row inserted behind the API does not satisfy the gate either.
//   2. `adopt_high_risk` binds ONE exact `adoption_request_id` (D.1:
//      `UNIQUE(adoption_request_id, scope)` + the CHECK + trigger
//      tg_approval_version_match). It authorizes that adoption and nothing else.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { appendTlogInTx, type TlogRow } from "./tlog.ts";
import { ulid } from "./ulid.ts";

export type ApprovalScope = "publish" | "adopt_high_risk";
export type ApprovalDecision = "approved" | "denied";

export const TLOG_APPROVAL = "approval_recorded";

// ---------------------------------------------------------------- the matrix

/**
 * §7.3 rows as an exported data table — the same shape P3 used for
 * SHELL_SEVERITY / URL_DENYLIST: the spec's matrix made literal, so extending
 * coverage is a data edit rather than a code change.
 *
 * Every predicate reads DECLARED manifest fields only, so the decision is
 * deterministic and offline (§7.1's determinism rule applies to the whole
 * lint/approval surface). Absent field ⇒ condition not met; an UNREADABLE
 * manifest ⇒ approval required (fail-closed, see requiresHumanApproval).
 *
 * The last §7.3 row ("`risk_level: low|medium`, all gates pass → auto") is the
 * residual: it applies exactly when no condition below holds. The column is
 * "any", so one condition is enough.
 */
export interface ApprovalCondition {
  id: string;
  /** the §7.3 row this encodes, verbatim */
  row: string;
  /**
   * WHERE the predicate read its facts, named beside the predicate rather than
   * beside a reader of it.
   *
   * An owner asked to pass a human gate is being told two different kinds of
   * thing: `signed_manifest` is a fact the AUTHOR declared and signed, and
   * `signed_manifest+registry` is one that also depends on what this
   * DEPLOYMENT has since observed. Confusing the two is how an operator comes
   * to believe a package changed when only the registry's counters moved. The
   * field is here, in the table, because a second table mapping id → source
   * would be a second place for that distinction to go stale.
   */
  source: "signed_manifest" | "signed_manifest+registry";
  /** deterministic predicate over the declared manifest + registry counters */
  test: (manifest: any, ctx: ApprovalMatrixContext) => boolean;
}

/** The source of the fail-closed pseudo-condition. It is a fact about the
 *  registry's copy of the package, not about anything the author declared —
 *  the author declared nothing this reader could parse. */
export const UNREADABLE_MANIFEST_CONDITION = "unreadable_manifest";
export const UNREADABLE_MANIFEST_SOURCE = "registry";

/** The source a condition id was read from, total over both the matrix and the
 *  fail-closed pseudo-condition, so a caller never has to guess one. */
export function approvalConditionSource(id: string): string {
  const c = APPROVAL_MATRIX.find((x) => x.id === id);
  return c ? c.source : UNREADABLE_MANIFEST_SOURCE;
}

/** The §7.3 row a condition id encodes, verbatim, or the fail-closed reason. */
export function approvalConditionDetail(id: string): string {
  const c = APPROVAL_MATRIX.find((x) => x.id === id);
  return c
    ? c.row
    : "the registry could not read this version's declared manifest, and §7.3 fails closed: an unreadable package requires a human decision rather than an automatic one";
}

export interface ApprovalMatrixContext {
  /** number of terminal `adopted` receipts already recorded for this version */
  adoptedCount: number;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export const APPROVAL_MATRIX: ReadonlyArray<ApprovalCondition> = [
  {
    id: "risk_high",
    row: "risk_level: high",
    source: "signed_manifest",
    test: (m) => m?.scope?.risk_level === "high",
  },
  {
    id: "prod_credentials_iam",
    row: "steps touch prod access / credentials / cloud-IAM",
    source: "signed_manifest",
    // the declared signal for cloud-IAM/prod reach is §4.2 Runtime
    // `cloud_iam_assumptions` — a required field, empty when there is none
    test: (m) => arr(m?.runtime?.cloud_iam_assumptions).length > 0,
  },
  {
    id: "destructive",
    row: "destructive operations (data deletion, infra teardown)",
    source: "signed_manifest",
    // §4.2 gives no dedicated field; the designated extension point carries the
    // author's declaration (x_ext is the ONLY extension point per §4.2)
    test: (m) => m?.x_ext?.destructive === true,
  },
  {
    id: "network_exfiltration",
    row: "network exfiltration surface (posts data to external URLs)",
    source: "signed_manifest",
    // a non-empty `url_allowlist` IS the declared external-network surface:
    // gate 4 admits no URL outside it, so an empty list means no external
    // endpoint is reachable from the package at all
    test: (m) => arr(m?.safety?.url_allowlist).length > 0,
  },
  // NOTE (P4 verdict 1, blocking #1): there is deliberately NO condition on
  // §4.2's `required_approvals`. The §7.3 table is the complete condition list,
  // and its last row makes `risk_level: low|medium` with all gates passing
  // `auto`. A low-risk package that merely DECLARES `required_approvals` is
  // exactly that automatic case, and adding an unlisted condition kept it out
  // of `published` — over-blocking a scenario the spec admits.
  {
    id: "low_evidence_large_blast_radius",
    row: "low evidence (<3 terminal `adopted` receipts) + large blast radius declared",
    // the ONLY row whose predicate reads a registry counter as well as the
    // signed manifest, and the reason the source is per-row data
    source: "signed_manifest+registry",
    test: (m, ctx) =>
      ctx.adoptedCount < 3 &&
      ["large", "fleet", "org"].includes(String(m?.x_ext?.blast_radius ?? "")),
  },
];

/** Which §7.3 conditions hold for this manifest. Order = table order. */
export function approvalConditions(manifest: any, ctx: ApprovalMatrixContext): string[] {
  if (manifest === null || typeof manifest !== "object") return [UNREADABLE_MANIFEST_CONDITION];
  return APPROVAL_MATRIX.filter((c) => c.test(manifest, ctx)).map((c) => c.id);
}

/**
 * §7.3: does this version need a human approval? Both matrix columns (Publish
 * and Adoption) list the same conditions, so one predicate serves both lanes;
 * the LANE decides which approval scope satisfies it, not whether one is due.
 *
 * Fail-closed: a manifest that cannot be read is treated as requiring approval
 * — the alternative is an unreadable package auto-publishing.
 */
export function requiresHumanApproval(manifest: any, ctx: ApprovalMatrixContext): boolean {
  return approvalConditions(manifest, ctx).length > 0;
}

// ------------------------------------------------- the review-verdict gate

/**
 * WHY A REVIEW GATE LIVES BESIDE THE APPROVAL GATE.
 *
 * A review verdict and a human approval are different acts by different
 * actors, and this module keeps them apart — but they are the two things the
 * Approval Inbox has to publish an `eligibility` for, and an Inbox that
 * computed either of them for itself would be a second answer to "may this
 * actor do this" (`INV-01`). That is not a hypothetical: the Inbox renders a
 * control ENABLED or DISABLED from this verdict, and a control enabled by a
 * projection and refused by the service is a control that lies.
 *
 * So the rule set moves HERE, once, and both readers call it: the review
 * surface raises the refusal it returns, and the Inbox publishes the reason
 * code it names. The ORDER is part of the contract — self-review is checked
 * before role, so an author who also holds `admin` is refused as an author and
 * not admitted as an admin — and the messages are the ones the surface has
 * always raised, because a caller reads them.
 */
export interface ReviewSubject {
  /** the version's author */
  author_agent_id: string;
  /** the owner of the SKILL the version belongs to */
  owner_agent_id: string;
  state: string;
}

export interface ReviewActor {
  agent_id: string;
  role: string | null;
}

export interface ReviewVerdictRefusal {
  code: "FORBIDDEN" | "PRECONDITION_FAILED";
  /** the stable machine reason a disabled control shows */
  reason_code: string;
  message: string;
  /** carried into `ApiError`'s third member where the surface carries one */
  current_state?: string;
}

/** The reason code an eligible actor gets. Shared with the human gate so a
 *  console renders one vocabulary and not two. */
export const ELIGIBLE_REASON_CODE = "APPROVABLE";

/**
 * May this actor record a review verdict on this version RIGHT NOW?
 *
 * `null` means yes. Anything else is the exact refusal, in the exact order the
 * surface has always applied it.
 */
export function reviewVerdictRefusal(subject: ReviewSubject, actor: ReviewActor): ReviewVerdictRefusal | null {
  if (subject.author_agent_id === actor.agent_id) {
    return {
      code: "FORBIDDEN",
      reason_code: "SELF_REVIEW_AUTHOR",
      message: "the version author may not review their own version (self-review, §6 surface 3)",
    };
  }
  if (subject.owner_agent_id === actor.agent_id) {
    return {
      code: "FORBIDDEN",
      reason_code: "SELF_REVIEW_SKILL_OWNER",
      message: "the skill owner may not review their own skill (self-review, §6 ACL matrix)",
    };
  }
  if (actor.role !== "reviewer" && actor.role !== "admin" && actor.role !== "owner") {
    return {
      code: "FORBIDDEN",
      reason_code: "ROLE_MAY_NOT_REVIEW",
      message: "a review verdict requires workspace role reviewer/admin/owner (§5.1)",
    };
  }
  if (subject.state !== "linted" && subject.state !== "reviewed") {
    return {
      code: "PRECONDITION_FAILED",
      reason_code: "STATE_NOT_REVIEWABLE",
      message: "a review verdict applies to a version in state `linted` (or an already `reviewed` one)",
      current_state: subject.state,
    };
  }
  return null;
}

// ------------------------------------------------------------ the human gate

interface ApproverRow {
  id: string;
  type: string;
  workspace_id: string;
  status: string;
  role: string | null;
}

function loadApprover(db: Db, agentId: string): ApproverRow | undefined {
  return db
    .prepare(
      `SELECT a.id, a.type, a.workspace_id, a.status,
              (SELECT role FROM workspace_memberships m
                WHERE m.agent_id=a.id AND m.workspace_id=a.workspace_id) AS role
         FROM agents a WHERE a.id=?`,
    )
    .get(agentId) as ApproverRow | undefined;
}

/**
 * The §7.3 / §6 human gate, evaluated from the DATABASE rather than from a
 * caller-supplied context: `agents.type='human'`, active, holding admin/owner
 * in the workspace that owns the resource. Used both when RECORDING an
 * approval and when CHECKING one, so a row written around the API by a service
 * identity still fails the check.
 */
export function isHumanApprover(db: Db, agentId: string, workspaceId: string): boolean {
  const a = loadApprover(db, agentId);
  if (!a || a.status !== "active") return false;
  if (a.type !== "human") return false;
  if (a.workspace_id !== workspaceId) return false;
  return a.role === "admin" || a.role === "owner";
}

// ---------------------------------------------------------------- recording

export interface RecordApprovalInput {
  skill_version_id: string;
  scope: ApprovalScope;
  decision: ApprovalDecision;
  adoption_request_id?: string | null;
  note?: string | null;
}

export interface ApprovalResponse {
  approval_id: string;
  skill_version_id: string;
  adoption_request_id: string | null;
  scope: ApprovalScope;
  decision: ApprovalDecision;
  /** the §7.3 conditions that made an approval due for this version */
  conditions: string[];
  tlog_seq: number;
  noop?: boolean;
}

export interface ApprovalContext {
  /** the approving agent, from AuthContext — never from the payload */
  approver_agent_id: string;
  /** workspace that owns the version (already resolved and access-checked) */
  workspace_id: string;
  /** declared manifest of the version, or null when unreadable */
  manifest: any;
  adoptedCount: number;
  nowMs: number;
}

/**
 * Record one approval decision. The caller has already resolved the version
 * and checked that the actor may see it; everything §7.3-specific happens here
 * and inside ONE transaction with the transparency-log append.
 */
export function recordApproval(db: Db, input: RecordApprovalInput, ctx: ApprovalContext): ApprovalResponse {
  if (input.scope !== "publish" && input.scope !== "adopt_high_risk") {
    throw new ApiError("INVALID_SCHEMA", "scope must be publish|adopt_high_risk");
  }
  if (input.decision !== "approved" && input.decision !== "denied") {
    throw new ApiError("INVALID_SCHEMA", "decision must be approved|denied");
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    throw new ApiError("INVALID_SCHEMA", "note must be a string");
  }

  // The human gate comes FIRST: a service identity learns nothing else about
  // the request it cannot approve.
  if (!isHumanApprover(db, ctx.approver_agent_id, ctx.workspace_id)) {
    throw new ApiError(
      "FORBIDDEN",
      "§7.3 human approval requires agents.type='human' with workspace role admin/owner",
    );
  }

  const requestId = input.adoption_request_id ?? null;
  if (input.scope === "adopt_high_risk") {
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "adopt_high_risk approval must name its adoption_request_id");
    }
  } else if (requestId !== null) {
    throw new ApiError(
      "INVALID_SCHEMA",
      "a publish approval binds the version only — adoption_request_id must be absent (§7.3)",
    );
  }

  const conditions = approvalConditions(ctx.manifest, { adoptedCount: ctx.adoptedCount });

  db.exec("BEGIN IMMEDIATE");
  try {
    if (requestId !== null) {
      const req = db
        .prepare("SELECT id, skill_version_id FROM adoption_requests WHERE id=?")
        .get(requestId) as { id: string; skill_version_id: string } | undefined;
      if (!req) {
        db.exec("ROLLBACK");
        throw new ApiError("NOT_FOUND", "adoption request not found");
      }
      // Per-adoption binding (§7.3): the approval and its request must name the
      // same version. The DDL trigger backstops this; refusing here gives the
      // caller a typed error instead of a raw SQLITE_CONSTRAINT.
      if (req.skill_version_id !== input.skill_version_id) {
        db.exec("ROLLBACK");
        throw new ApiError(
          "PRECONDITION_FAILED",
          "adoption_request_id belongs to a different skill_version_id — an approval cannot be moved between requests (§7.3)",
          req.skill_version_id,
        );
      }
      // One decision per (request, scope): a replay converges on the recorded
      // decision instead of minting a second authorization (defect #1 shape).
      const existing = db
        .prepare("SELECT id, decision, skill_version_id FROM approvals WHERE adoption_request_id=? AND scope=?")
        .get(requestId, input.scope) as
        | { id: string; decision: ApprovalDecision; skill_version_id: string }
        | undefined;
      if (existing) {
        db.exec("ROLLBACK");
        if (existing.decision === input.decision && existing.skill_version_id === input.skill_version_id) {
          return {
            approval_id: existing.id,
            skill_version_id: existing.skill_version_id,
            adoption_request_id: requestId,
            scope: input.scope,
            decision: existing.decision,
            conditions,
            tlog_seq: -1,
            noop: true,
          };
        }
        throw new ApiError(
          "CONFLICT",
          "this adoption request already carries a §7.3 decision",
          existing.decision,
        );
      }
    }

    const id = ulid(ctx.nowMs);
    db.prepare(
      `INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, note, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.skill_version_id,
      requestId,
      ctx.approver_agent_id,
      input.scope,
      input.decision,
      input.note ?? null,
      ctx.nowMs,
    );
    // §5.2: the decision RELEASES the request in the same transaction — an
    // `approved` decision moves it to `pending`, a `denied` one terminals it as
    // `dead_letter(approval_denied)`. Doing it here is what makes the hold
    // unforgeable: there is no window in which an approval exists and the
    // request is still held, or vice versa. The CAS on `approval_pending`
    // means a request that was never held is not disturbed.
    if (requestId !== null) {
      if (input.decision === "approved") {
        db.prepare("UPDATE adoption_requests SET state='pending' WHERE id=? AND state='approval_pending'").run(requestId);
      } else {
        db.prepare(
          "UPDATE adoption_requests SET state='dead_letter', dead_letter_reason='approval_denied' WHERE id=? AND state='approval_pending'",
        ).run(requestId);
      }
    }

    const tlog = appendTlogInTx(
      db,
      TLOG_APPROVAL,
      input.skill_version_id,
      {
        approval_id: id,
        skill_version_id: input.skill_version_id,
        adoption_request_id: requestId,
        approver_agent_id: ctx.approver_agent_id,
        scope: input.scope,
        decision: input.decision,
        conditions,
      },
      ctx.nowMs,
    );
    db.exec("COMMIT");
    return {
      approval_id: id,
      skill_version_id: input.skill_version_id,
      adoption_request_id: requestId,
      scope: input.scope,
      decision: input.decision,
      conditions,
      tlog_seq: tlog.seq,
    };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed by the branch that threw
    }
    throw e;
  }
}

// ------------------------------------------------------------- satisfaction

interface ApprovalRow {
  approver_agent_id: string;
  decision: ApprovalDecision;
  skill_version_id: string;
}

/**
 * A `publish` approval satisfies §7.3 for this version when it is `approved`
 * AND its approver still passes the human gate of the version's workspace.
 * Re-checking the approver here is what makes a hand-written approvals row
 * useless: the row alone is not the authorization, the human identity is.
 */
export function publishApprovalSatisfied(db: Db, versionId: string, workspaceId: string): boolean {
  const rows = db
    .prepare(
      "SELECT approver_agent_id, decision, skill_version_id FROM approvals WHERE skill_version_id=? AND scope='publish'",
    )
    .all(versionId) as ApprovalRow[];
  return rows.some((r) => r.decision === "approved" && isHumanApprover(db, r.approver_agent_id, workspaceId));
}

/**
 * An `adopt_high_risk` approval satisfies §7.3 for exactly ONE adoption
 * request: the row must name that request, be `approved`, name the request's
 * own version, and its approver must still pass the human gate.
 */
export function adoptionApprovalSatisfied(db: Db, adoptionRequestId: string, workspaceId: string): boolean {
  const row = db
    .prepare(
      `SELECT a.approver_agent_id, a.decision, a.skill_version_id, r.skill_version_id AS request_version
         FROM approvals a JOIN adoption_requests r ON r.id=a.adoption_request_id
        WHERE a.adoption_request_id=? AND a.scope='adopt_high_risk'`,
    )
    .get(adoptionRequestId) as (ApprovalRow & { request_version: string }) | undefined;
  if (!row) return false;
  if (row.decision !== "approved") return false;
  if (row.skill_version_id !== row.request_version) return false;
  return isHumanApprover(db, row.approver_agent_id, workspaceId);
}
