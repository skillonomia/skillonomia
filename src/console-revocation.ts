// WHAT REVOKING THIS VERSION WOULD DO — READ BEFORE ANYTHING IS WRITTEN.
//
// WHY THIS EXISTS AT ALL. SPEC.md section 6.4 requires the Console to state the
// consequences of a revocation BEFORE the commit, and every one of those
// statements needs a fact only the registry has: which bytes (the manifest
// hash), who already holds them, and what could replace them. A browser that
// assembled that from three unrelated reads would be a browser deciding what
// "already holds" means, and `INV-01` puts that decision here.
//
// WHAT THIS IS NOT. It is a READ MODEL over rows that already exist, in the
// sense `src/approval-inbox.ts` is one. It writes nothing, it opens no
// transaction, and it does not re-implement the revoke rules: `eligibility`
// below is computed from the SAME state set `src/transitions.ts` exports and the
// SAME actor rule `Registry.revokeVersion` applies, so a version this read calls
// revocable is a version that method accepts, and a version it calls
// unrevocable is one that method refuses. Two rules that both answered "may this
// be revoked" would be two rules that could drift; there is one, and this asks
// it early so the page can show the answer instead of a control that fails.
//
// THE ACTIVE-ADOPTER QUERY IS THE DELIVERY MACHINE'S OWN. `active` means what
// `enqueueRevocationNoticesInTx` means by it in `src/delivery.ts` — an adopter
// holding a receipt with no `failed` and no `rolled_back` event — because the
// number this page shows an owner before they press the button must be the
// number of notices the button actually queues.
import type { Db } from "./sqlite.ts";
import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { CONSOLE_CONTRACT_V2, type ConsoleEligibility } from "./console-v2.ts";
import { REVOCABLE_STATES } from "./transitions.ts";
import { SUCCESSOR_ELIGIBLE_STATES } from "./lifecycle-v11.ts";

/** The reason code a revocable version carries. Mandatory even when allowed,
 *  for the reason `ConsoleEligibility` gives: a control that is offered and a
 *  control that is withheld both have an exact reason. */
export const REVOCABLE_REASON_CODE = "REVOCABLE";

/**
 * Every reason a revocation is not offered, and each is a DIFFERENT fact.
 *
 * `ALREADY_REVOKED` is not `NOT_REVOCABLE_STATE` even though both are states
 * outside the whitelist: the first tells an owner the thing they wanted has
 * already happened, and the second tells them it cannot happen yet. Collapsing
 * them would make a done job look like a broken one.
 */
export const REVOCATION_REASON_CODES = {
  revocable: REVOCABLE_REASON_CODE,
  already_revoked: "ALREADY_REVOKED",
  not_revocable_state: "NOT_REVOCABLE_STATE",
  not_permitted: "NOT_PERMITTED_ACTOR",
} as const;

/** One adopter that already holds these bytes. The agent id and nothing else —
 *  an owner deciding a revocation needs to know WHO, and no other column of the
 *  receipt is any of this page's business. */
export interface RevocationAdopter {
  adopter_agent_id: string;
  receipts: number;
}

/** One version that could replace this one: `verified` or `published`, same
 *  skill, never the version being revoked. */
export interface RevocationSuccessor {
  skill_version_id: string;
  semantic_version: string;
  state: string;
}

/**
 * What became of the notices this revocation queued.
 *
 * THREE SEPARATE COUNTS, AND THE NAMES ARE THE POINT (INV-07). `queued` counts
 * rows the delivery machine still holds — `pending` or `leased` — and it is not
 * evidence that anything arrived. `delivered` counts rows that reached `pushed`,
 * which in `src/delivery.ts` means an endpoint answered 2xx. `dead_lettered`
 * counts rows that ended in `dead_letter`. A single "sent" number covering all
 * three would be the false-delivery claim `INV-07` exists to forbid.
 */
export interface RevocationNoticeCounts {
  queued: number;
  delivered: number;
  dead_lettered: number;
  total: number;
}

/** `GET /v1/console/versions/{version_id}/revocation`. */
export interface ConsoleRevocationContext {
  contract: typeof CONSOLE_CONTRACT_V2;
  skill_version_id: string;
  skill_id: string;
  slug: string;
  semantic_version: string;
  /** the exact bytes this decision is about */
  manifest_hash: string;
  state: string;
  /** the immutable reason, once one exists */
  revocation_reason: string | null;
  superseded_by: string | null;
  active_adopters: RevocationAdopter[];
  successors: RevocationSuccessor[];
  notices: RevocationNoticeCounts;
  eligibility: ConsoleEligibility;
  server_at_ms: number;
}

interface VersionRow {
  id: string;
  skill_id: string;
  semantic_version: string;
  state: string;
  manifest_hash: string;
  revocation_reason: string | null;
  superseded_by_version_id: string | null;
  workspace_id: string;
  slug: string;
  author_agent_id: string;
  owner_agent_id: string;
}

/**
 * The actor half of the revoke ACL, asked without writing.
 *
 * IT IS THE SAME PREDICATE `Registry.revokeVersion` applies — author, skill
 * owner, workspace admin or workspace owner — restated in one place that both
 * can be read against. It is deliberately NOT a second ACL: this one only
 * decides whether to OFFER the control, and the service still decides whether to
 * perform the act, so a disagreement is a control that is offered and then
 * refused, never an act performed that this said no to.
 */
function actorMayRevoke(row: VersionRow, auth: AuthContext): boolean {
  return (
    row.author_agent_id === auth.agent_id ||
    row.owner_agent_id === auth.agent_id ||
    auth.role === "admin" ||
    auth.role === "owner"
  );
}

function eligibilityFor(row: VersionRow, auth: AuthContext): ConsoleEligibility {
  if (!actorMayRevoke(row, auth)) {
    return { allowed: false, reason_code: REVOCATION_REASON_CODES.not_permitted };
  }
  if (row.state === "revoked") {
    return { allowed: false, reason_code: REVOCATION_REASON_CODES.already_revoked };
  }
  if (!(REVOCABLE_STATES as readonly string[]).includes(row.state)) {
    return { allowed: false, reason_code: REVOCATION_REASON_CODES.not_revocable_state };
  }
  return { allowed: true, reason_code: REVOCATION_REASON_CODES.revocable };
}

/**
 * The adopters `enqueueRevocationNoticesInTx` would queue a notice for.
 *
 * THE SAME `WHERE`, and it is copied rather than imported because that function
 * inserts inside a transaction and this one must not. `test/v1p2-p2c-console.
 * test.ts` asserts the two produce the same adopter set on the same data, which
 * is the guarantee an import would have given and a comment would not.
 */
function activeAdopters(db: Db, versionId: string): RevocationAdopter[] {
  return db
    .prepare(
      `SELECT r.adopter_agent_id AS adopter_agent_id, COUNT(*) AS receipts
         FROM adoption_receipts r
        WHERE r.skill_version_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM receipt_events e
             WHERE e.adoption_receipt_id = r.id AND e.event IN ('failed','rolled_back'))
        GROUP BY r.adopter_agent_id
        ORDER BY r.adopter_agent_id`,
    )
    .all(versionId) as RevocationAdopter[];
}

/** The replacements SPEC.md section 5.1b admits: `verified` or `published`, the
 *  same skill, and never this version. */
function successorCandidates(db: Db, row: VersionRow): RevocationSuccessor[] {
  const placeholders = SUCCESSOR_ELIGIBLE_STATES.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id AS skill_version_id, semantic_version, state
         FROM skill_versions
        WHERE skill_id = ? AND id <> ? AND state IN (${placeholders})
        ORDER BY created_at_ms DESC, id ASC`,
    )
    .all(row.skill_id, row.id, ...SUCCESSOR_ELIGIBLE_STATES) as RevocationSuccessor[];
}

/**
 * What the delivery machine has done with this version's revocation notices.
 *
 * Counted by the state column and reported under three names, because the three
 * states mean three different things and one total would mean none of them.
 * `notification_kind='revocation'` is the filter: an adoption notification for
 * the same version is a different fact and is not this panel's business.
 */
function noticeCounts(db: Db, versionId: string): RevocationNoticeCounts {
  const rows = db
    .prepare(
      `SELECT state, COUNT(*) AS n
         FROM adoption_requests
        WHERE skill_version_id = ? AND notification_kind = 'revocation'
        GROUP BY state`,
    )
    .all(versionId) as Array<{ state: string; n: number }>;
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.state, r.n);
  const queued = (by.get("pending") ?? 0) + (by.get("leased") ?? 0);
  const delivered = by.get("pushed") ?? 0;
  const deadLettered = by.get("dead_letter") ?? 0;
  let total = 0;
  for (const n of by.values()) total += n;
  return { queued, delivered, dead_lettered: deadLettered, total };
}

/**
 * `GET /v1/console/versions/{version_id}/revocation`.
 *
 * VISIBILITY FIRST, THEN ELIGIBILITY. A version in another workspace is
 * `NOT_FOUND` and not `FORBIDDEN`, for the reason the rest of this registry
 * gives: a typed refusal that distinguishes "exists but not yours" from "does
 * not exist" is an existence oracle. Within the workspace the answer is always
 * a 200 carrying an eligibility, because a page that cannot read the facts
 * cannot state the consequences, and stating them is the whole requirement.
 */
export function consoleRevocationContext(
  db: Db,
  auth: AuthContext,
  versionId: unknown,
  nowMs: number,
): ConsoleRevocationContext {
  if (typeof versionId !== "string" || versionId.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "skill_version_id must be a string");
  }
  if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
  const row = db
    .prepare(
      `SELECT v.id, v.skill_id, v.semantic_version, v.state, v.manifest_hash, v.revocation_reason,
              v.superseded_by_version_id, s.workspace_id, s.slug, v.author_agent_id, s.owner_agent_id
         FROM skill_versions v JOIN skills s ON s.id = v.skill_id
        WHERE v.id = ?`,
    )
    .get(versionId) as VersionRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", "version not found");
  if (row.workspace_id !== auth.workspace_id) throw new ApiError("NOT_FOUND", "version not found");

  return {
    contract: CONSOLE_CONTRACT_V2,
    skill_version_id: row.id,
    skill_id: row.skill_id,
    slug: row.slug,
    semantic_version: row.semantic_version,
    manifest_hash: row.manifest_hash,
    state: row.state,
    revocation_reason: row.revocation_reason,
    superseded_by: row.superseded_by_version_id,
    active_adopters: activeAdopters(db, row.id),
    successors: successorCandidates(db, row),
    notices: noticeCounts(db, row.id),
    eligibility: eligibilityFor(row, auth),
    server_at_ms: nowMs,
  };
}
