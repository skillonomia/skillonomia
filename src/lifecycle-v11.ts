// THE v1.1 LIFECYCLE CONTRACT — disposition, lineage, and the digests that make
// a repeat of either one convergent.
//
// WHAT THIS FILE IS. The vocabularies and computations §5.1b needs, in one
// place, so that the migration, the service layer P1 writes, the Console v2 DTOs
// and the CLI all read one definition. It holds NO service logic: nothing here
// opens a transaction, resolves a principal, writes a row or decides an ACL. It
// answers three kinds of question — which states admit which fact, what a
// request digest IS, and what the response shape is — and each answer is a value
// or a pure function, which is what makes this contract executable rather than
// prose.
//
// WHY THE STATE SETS ARE DERIVED AND NOT TYPED OUT. `REVOCABLE_STATES` lives in
// `src/transitions.ts` and is computed from the whitelist; the two sets here are
// computed from the eight-state union the same way. A second hand-written list
// of states is a second place for the graph to be true, and this project has
// twice found a document and a constant agreeing with each other while both
// were narrower than the rule they named.
import { createHash } from "node:crypto";
import { jcsCanonicalize, type JcsValue } from "./jcs.ts";
import type { VersionState } from "./transitions.ts";

/**
 * The states a version may hold `superseded_by_version_id` in (§5.1b rule 3).
 *
 * A version that never reached `published` has nothing to replace: naming a
 * successor for a draft would assert that somebody's adoption is being migrated
 * away from bytes no adopter ever received. The four that qualify are exactly
 * the released states — `published` and its three tails.
 */
export const LINEAGE_LINKABLE_STATES: readonly VersionState[] = [
  "published",
  "deprecated",
  "superseded",
  "revoked",
];

export function isLineageLinkableState(state: unknown): state is VersionState {
  return typeof state === "string" && (LINEAGE_LINKABLE_STATES as readonly string[]).includes(state);
}

/**
 * The states a version must be in to BECOME a successor (§5.1b rule 5).
 *
 * Checked at link creation and not afterwards. A successor that is itself
 * deprecated or revoked later does not freeze its predecessor's disposition —
 * re-asking the question on every subsequent write is what would refuse the
 * `superseded → revoked` edge §5.1 exists to admit, and `migrations/0018`
 * guards the check on the pointer having just changed for exactly that reason.
 */
export const SUCCESSOR_ELIGIBLE_STATES: readonly VersionState[] = ["verified", "published"];

export function isSuccessorEligibleState(state: unknown): state is VersionState {
  return typeof state === "string" && (SUCCESSOR_ELIGIBLE_STATES as readonly string[]).includes(state);
}

/** §5.1b: the reason is a non-empty string of at most this many characters, and
 *  it is stored and signed verbatim — not trimmed, not normalised, not
 *  rewritten after the boundary accepted it, because the string in
 *  `skill_versions.revocation_reason` and the string in the transparency-log
 *  payload have to be the same string. */
export const REVOCATION_REASON_MAX = 2000;

/**
 * The additive request body of `POST /v1/versions/{id}/revoke`.
 *
 * `reason` and `idempotency_key` are v1.0.0's, unchanged and still required and
 * optional respectively. `successor_version_id` is the one addition, and it is
 * OPTIONAL: every v1.0.0 client that sends `{reason}` alone keeps working and
 * keeps meaning what it meant (INV-09).
 */
export interface RevokeInputV11 {
  reason: string;
  successor_version_id?: string | null;
  idempotency_key?: string;
}

/**
 * The additive response.
 *
 * WHAT IS PRESERVED, exactly: `skill_version_id`, `state`, `reason`, the
 * optional `tlog_seq`, the optional `notified_adopters` and the optional `noop`
 * are v1.0.0's fields with v1.0.0's meanings. `notified_adopters` in particular
 * still counts NOTICES QUEUED and is still not proof that anything was
 * delivered.
 *
 * WHAT IS ADDED, and what each addition is careful not to claim:
 *
 *   - `superseded_by` is always present and is `string | null`. Always, because
 *     "absent" and "no successor" would otherwise be indistinguishable to a
 *     client that cannot tell an old server from a version with no replacement.
 *   - `notifications_queued` is present on a fresh revoke and equals
 *     `notified_adopters`. It is the honest NAME for what the older field
 *     counts, added beside it rather than instead of it. On a convergent noop
 *     both queue-count fields keep v1.0.0's optionality and neither one invents
 *     a historical delivery figure for a call that queued nothing.
 *   - `lineage_tlog_seq` is present ONLY when THIS call created the
 *     `version_superseded` entry. `tlog_seq` always means the seq of
 *     `version_revoked`, which is why the second one needs its own name rather
 *     than a rule about ordering that a reader has to remember.
 */
export interface RevokeResponseV11 {
  skill_version_id: string;
  state: "revoked";
  reason: string | null;
  superseded_by: string | null;
  notifications_queued?: number;
  notified_adopters?: number;
  tlog_seq?: number;
  lineage_tlog_seq?: number;
  noop?: boolean;
}

/** The order the two transparency-log entries are appended in, when both are
 *  appended. Fixed, and fixed HERE, because a verifier reading the chain offline
 *  must be able to say which entry belongs to which half of one call without a
 *  timestamp comparison that a same-millisecond pair would lose. */
export const LIFECYCLE_TLOG_ORDER = ["version_revoked", "version_superseded"] as const;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The idempotency digest of a revoke — SHA-256 over the JCS form of the EXACT
 * ACCEPTED request.
 *
 * "Exact accepted" is the load-bearing phrase and the reason this is a function
 * rather than a sentence. The digest is taken over the reason AS ACCEPTED at the
 * boundary — not trimmed, not case-folded, not shortened — because a digest over
 * a normalised value would make two different accepted reasons one key, and the
 * second caller would get the first caller's response for a revocation it did
 * not ask for. `successor_version_id` is normalised in exactly one respect: an
 * absent successor and an explicit `null` are THE SAME REQUEST, so both become
 * `null` here. That is a normalisation of ABSENCE, not of a value.
 *
 * Same key + same digest replays byte for byte with no new events and no new
 * notices. Same key + a different digest is `CONFLICT` before any domain
 * mutation. A legacy row that carries no digest keeps v1.0 replay behaviour and
 * must not be read as a mismatch — that rule lives in `src/idempotency.ts`,
 * which is where the row is compared.
 */
export function revokeRequestDigest(input: {
  version_id: string;
  reason: string;
  successor_version_id?: string | null;
}): string {
  const canonical: JcsValue = {
    version_id: input.version_id,
    reason: input.reason,
    successor_version_id: input.successor_version_id ?? null,
  } as unknown as JcsValue;
  return sha256Hex(jcsCanonicalize(canonical));
}

/**
 * The idempotency digest of a supersede: the ordered pair and nothing else.
 *
 * The pair is ordered — predecessor first — because `supersede(A,B)` and
 * `supersede(B,A)` are different calls with different outcomes, and a digest
 * that lost the order would let one replay as the other.
 */
export function supersedeRequestDigest(input: {
  predecessor_version_id: string;
  successor_version_id: string;
}): string {
  const canonical: JcsValue = {
    predecessor_version_id: input.predecessor_version_id,
    successor_version_id: input.successor_version_id,
  } as unknown as JcsValue;
  return sha256Hex(jcsCanonicalize(canonical));
}

/**
 * What a revocation notice carries, beyond what a v1.0.0 notice carried.
 *
 * `successor_version_id` and `successor_semantic_version` are `null` when there
 * is no replacement, and are NOT omitted, for the same reason `superseded_by` is
 * always present in the response: an adopter reading a notice has to be able to
 * tell "no replacement" from "this server does not say".
 *
 * `registry_verification_path` is a PATH, not a promise. It says where the
 * adopter can ask the registry what it now thinks of these bytes. It does not
 * say the bytes have been removed, cannot run, or have stopped verifying — none
 * of which is true, and the notice does not imply any of them.
 */
export interface RevocationNoticeV11 {
  kind: "revocation";
  skill_version_id: string;
  revocation_reason: string;
  successor_version_id: string | null;
  successor_semantic_version: string | null;
  registry_verification_path: string;
}

/** The path that answer lives at. One constant, so the notice, the docs and the
 *  Console cannot name three different places. */
export const REGISTRY_VERIFICATION_PATH = "/v1/versions/{skill_version_id}/verify";
