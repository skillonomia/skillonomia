// §5.1 package-lifecycle transition whitelist. The registry core is the ONLY
// writer of skill_versions.state; every change goes through transitionVersion.
import type { Db } from "./sqlite.ts";
import { GATE_NAMES } from "./gates.ts";

export type VersionState =
  | "draft"
  | "linted"
  | "reviewed"
  | "verified"
  | "published"
  | "deprecated"
  | "superseded"
  | "revoked";

// Exactly §5.1:  draft → linted → reviewed → verified → published
//                published → deprecated | superseded | revoked
//                published | deprecated | superseded → revoked      (v1.1)
//
// WHY `deprecated` AND `superseded` GAINED AN OUTGOING EDGE, AND `revoked` DID
// NOT. v1.0.0 called all three tails terminal and meant one thing by it: that a
// retired version does not come back. Two of the three carried a second meaning
// nobody chose — that a version which had been withdrawn from use could never
// afterwards be declared UNSAFE. A skill superseded in March and found to leak a
// credential in May had no surface at all: `revoke` refused the state, and there
// was no path back to `published` to revoke it from. The owner's only options
// were to leave the registry saying "replaced" about bytes that are dangerous,
// or to publish a lie.
//
// So the graph now admits `deprecated → revoked` and `superseded → revoked`.
// This is not a relaxation of terminality; it is the recognition that a
// DISPOSITION and a REPLACEMENT are different facts (INV-06). `revoked` is the
// strongest disposition and every other released state may reach it.
//
// `revoked` KEEPS AN EMPTY ROW, deliberately, and the reason is the same
// invariant read the other way. Attaching a successor to a revoked version is
// NOT a state change: `revoke --successor` leaves `state='revoked'` and writes
// `superseded_by_version_id`, a COLUMN. Giving `revoked` an edge to `superseded`
// would make the registry choose between the two facts again — it would erase
// the revocation to record the replacement — which is exactly the trap §6.3
// exists to close. `migrations/0018` enforces the same thing from below: the
// revocation reason is immutable and required iff the state is `revoked`, so
// leaving `revoked` would have to clear a reason that cannot be cleared.
export const TRANSITION_WHITELIST: Readonly<Record<VersionState, readonly VersionState[]>> = {
  draft: ["linted"],
  linted: ["reviewed"],
  reviewed: ["verified"],
  verified: ["published"],
  published: ["deprecated", "superseded", "revoked"],
  deprecated: ["revoked"],
  superseded: ["revoked"],
  revoked: [],
};

/**
 * The states §5.1 lets a revocation start from — the whitelist read backwards,
 * so the one graph answers both questions and a service method does not restate
 * the edge set as a literal of its own.
 */
export const REVOCABLE_STATES: readonly VersionState[] = (
  Object.keys(TRANSITION_WHITELIST) as VersionState[]
).filter((from) => TRANSITION_WHITELIST[from].includes("revoked"));

/**
 * The surface that reaches each state, so "what may I do next" is DERIVED from
 * the graph above rather than restated by whoever is answering.
 *
 * WHY THIS IS HERE AND NOT IN A CLIENT. The authoring CLI used to answer it from
 * a `switch` of its own, and mapped `draft` to "request a review" — a request
 * that reproducibly returns `412 PRECONDITION_FAILED`, because §5.1 puts `lint`
 * between the two and the review surface refuses any state but `linted`. That is
 * a client re-deriving a decision the server owns (`INV-01`) and getting it
 * wrong. The registry answers now, from the one edge set that decides it, and
 * the client renders the sentence it is given.
 *
 * `draft` has no entry: nothing transitions INTO `draft`, it is where a version
 * is created, and a map that invented a surface for it would be describing a
 * route that does not exist.
 */
const SURFACE_REACHING: Readonly<Partial<Record<VersionState, string>>> = {
  linted: "POST /v1/versions/{skill_version_id}/lint — the eight §7.1 gates run there, and a version that passes them becomes `linted`",
  reviewed: 'POST /v1/versions/{skill_version_id}/reviews with {"action":"request"} — a reviewer who is not the author then records the verdict',
  verified: "POST /v1/versions/{skill_version_id}/verify — §5.1 requires a reported trial adoption first",
  published: "POST /v1/versions/{skill_version_id}/publish",
  deprecated: "POST /v1/versions/{skill_version_id}/deprecate",
  superseded: "POST /v1/versions/{skill_version_id}/supersede",
  revoked: "POST /v1/versions/{skill_version_id}/revoke",
};

/**
 * What a version in this state admits next, in the registry's own words.
 *
 * It names the SURFACE and never promises the caller is entitled to use it:
 * eligibility is the §7.3 matrix's and is decided by the surface when it is
 * called. A state with no outgoing edge says so rather than inventing one.
 */
export function nextActionForState(state: VersionState): string {
  const next = TRANSITION_WHITELIST[state] ?? [];
  const surfaces = next.map((to) => SURFACE_REACHING[to]).filter((s): s is string => s !== undefined);
  if (surfaces.length === 0) {
    return `state \`${state}\` has no onward transition — nothing further is permitted on this version`;
  }
  return surfaces.join("; or ");
}

export function isLegalTransition(from: VersionState, to: VersionState): boolean {
  return (TRANSITION_WHITELIST[from] ?? []).includes(to);
}

export interface TransitionOk {
  ok: true;
  noop: boolean;
  state: VersionState;
}

export interface TransitionErr {
  ok: false;
  code:
    | "PRECONDITION_FAILED"
    | "NOT_FOUND"
    | "CONFLICT"
    | "USE_PUBLISH_VERSION"
    | "USE_VERIFY_VERSION"
    | "USE_REVOKE_VERSION"
    | "GATES_NOT_PASSED"
    /** §6 surface 3: no eligible reviewer has approved this version */
    | "REVIEW_NOT_APPROVED"
    /** §7.3 matrix demands a human approval this version does not have */
    | "APPROVAL_REQUIRED";
  current_state?: VersionState;
}

export type TransitionResult = TransitionOk | TransitionErr;

/**
 * Converging-conflict semantics (§6 error model, snapshot defect #1 regression):
 * requesting the state the row is already in returns {noop:true, state} — never
 * an error loop. Illegal transitions return PRECONDITION_FAILED + current state.
 * The UPDATE is CAS-guarded on the observed state; a lost race re-reads and
 * converges by the same rules.
 */
export function transitionVersion(
  db: Db,
  versionId: string,
  to: VersionState,
): TransitionResult {
  // Publication is inseparable from the countersign log append (§4.3.8), so it
  // has exactly one entry point: publishVersion(). Reaching `published` through
  // the generic transition would produce a published version with no
  // countersign row and no revocation reference time.
  if (to === "published") return { ok: false, code: "USE_PUBLISH_VERSION" };
  // §5.1's `verified` gate is a conjunction over receipts, attestations,
  // compatibility metadata and a CURRENT eight-gate run (conjunct 4) — none of
  // which this function can see. So `verified`, like `published`, has exactly
  // one entry point: verifyVersionTransition() in src/verified-gate.ts, which
  // evaluates the conjunction, transitions and transparency-logs in a single
  // transaction. Leaving a generic path open here would make this exported
  // function itself the bypass the P4 review subject is about.
  if (to === "verified") return { ok: false, code: "USE_VERIFY_VERSION" };
  // The graph above gives `revoked` two more inbound edges, and that is precisely why it
  // needs the same closed door `published` and `verified` have. A revocation is
  // inseparable from four writes that happen in ONE transaction: the mandatory
  // `revocation_reason`, the optional successor link, the `version_revoked`
  // transparency-log append (and the `version_superseded` one after it), and a
  // revocation notice queued for every active adopter. A generic state change
  // performs none of them, and `migrations/0018` would refuse it anyway —
  // `state='revoked'` with no reason breaks the disposition invariant. Refusing
  // here rather than letting the trigger abort is the difference between a typed
  // answer and a SQLITE_CONSTRAINT surfacing as a 500. The one entry point is
  // `Registry.revokeVersion()` (`src/service.ts`).
  if (to === "revoked") return { ok: false, code: "USE_REVOKE_VERSION" };
  // §6 surface 3: "reviewed state requires ≥1 approve". Enforced HERE for the
  // same reason the §7.1 aggregate is: otherwise this exported function reaches
  // `reviewed` — and therefore the whole review conjunct — without a review.
  if (to === "reviewed" && eligibleApproveReviewers(db, versionId).length === 0) {
    const current = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as
      | { state: VersionState }
      | undefined;
    if (!current) return { ok: false, code: "NOT_FOUND" };
    if (current.state === "reviewed") return { ok: true, noop: true, state: "reviewed" };
    return { ok: false, code: "REVIEW_NOT_APPROVED", current_state: current.state };
  }
  // §7.1: "the aggregate blocks state transitions". The gate rule is enforced
  // HERE, not only in the service caller — otherwise this exported function is
  // itself the bypass (P3 verdict 1, blocking #1). Evidence required for
  // `linted`: a completed gate run for this version with zero FAIL.
  if (to === "linted" && !lintGatePassed(db, versionId)) {
    const current = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as
      | { state: VersionState }
      | undefined;
    if (!current) return { ok: false, code: "NOT_FOUND" };
    if (current.state === "linted") return { ok: true, noop: true, state: "linted" };
    return { ok: false, code: "GATES_NOT_PASSED", current_state: current.state };
  }
  return transitionUnchecked(db, versionId, to);
}

/**
 * §7.1 aggregate: the most recent gate run for this version must be COMPLETE —
 * every gate of `GATE_NAMES` reported — and carry no FAIL. Accepting a partial
 * run would let a caller authorize the transition with a single PASS row while
 * the gates that would have failed simply never ran (P3 verdict 2, blocking
 * #1). A run is identified by its `created_at_ms`: the service writes all rows
 * of one run with a single timestamp. Two runs landing in the same millisecond
 * merge, which can only be conservative — a FAIL from either blocks.
 */
export function lintGatePassed(db: Db, versionId: string): boolean {
  const latest = db
    .prepare("SELECT MAX(created_at_ms) AS ms FROM lint_reports WHERE skill_version_id=?")
    .get(versionId) as { ms: number | null } | undefined;
  if (!latest || latest.ms === null) return false; // never linted
  const rows = db
    .prepare("SELECT gate, result FROM lint_reports WHERE skill_version_id=? AND created_at_ms=?")
    .all(versionId, latest.ms) as Array<{ gate: string; result: string }>;
  if (rows.some((r) => r.result === "fail")) return false;
  const reported = new Set(rows.map((r) => r.gate));
  return GATE_NAMES.every((g) => reported.has(g));
}

/**
 * §5.1 + §6 reviewer eligibility, in ONE place: the agents whose `approve`
 * review counts for this version. A reviewer must be an active member of the
 * SKILL's workspace holding role reviewer/admin/owner, and must be neither the
 * version's author nor the skill's owner (§6 ACL matrix: the author/skill-owner
 * column is "never (self-review)"; §5.1: cross-workspace review does not exist
 * in v1). Both the `reviewed` transition guard above and the §5.1 verified-gate
 * attestation conjunct read this list, so the two cannot drift apart.
 */
export function eligibleApproveReviewers(db: Db, versionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT rv.reviewer_agent_id AS reviewer
         FROM reviews rv
         JOIN skill_versions v ON v.id = rv.skill_version_id
         JOIN skills s ON s.id = v.skill_id
         JOIN agents a ON a.id = rv.reviewer_agent_id
         JOIN workspace_memberships m ON m.agent_id = a.id AND m.workspace_id = s.workspace_id
        WHERE rv.skill_version_id = ?
          AND rv.verdict = 'approve'
          AND a.status = 'active'
          AND a.workspace_id = s.workspace_id
          AND m.role IN ('reviewer','admin','owner')
          AND rv.reviewer_agent_id <> v.author_agent_id
          AND rv.reviewer_agent_id <> s.owner_agent_id`,
    )
    .all(versionId) as Array<{ reviewer: string }>;
  return rows.map((r) => r.reviewer);
}

// NOTE: no `published` entry point is exported from this module. Publication
// lives entirely inside publishVersion() (src/countersign.ts), which performs
// the state change and the countersign append in one transaction.

function transitionUnchecked(db: Db, versionId: string, to: VersionState): TransitionResult {
  for (;;) {
    const row = db
      .prepare("SELECT state FROM skill_versions WHERE id=?")
      .get(versionId) as { state: VersionState } | undefined;
    if (!row) return { ok: false, code: "NOT_FOUND" };
    const from = row.state;
    if (from === to) return { ok: true, noop: true, state: from };
    if (!isLegalTransition(from, to)) {
      return { ok: false, code: "PRECONDITION_FAILED", current_state: from };
    }
    const res = db
      .prepare("UPDATE skill_versions SET state=? WHERE id=? AND state=?")
      .run(to, versionId, from);
    if (res.changes === 1) return { ok: true, noop: false, state: to };
    // CAS lost: someone else moved the state — re-read and converge.
  }
}
