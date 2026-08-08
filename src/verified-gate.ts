// §5.1 `verified` gate — the hard, tool-enforced conjunction, plus the ONLY
// entry point that can write state `verified`.
//
// The gate is a conjunction of four conjuncts (§5.1, verbatim):
//
//   ≥1 adoption receipt for THIS skill_version_id whose terminal event is
//   `adopted` and whose evidence_json passed registry validation against this
//   version's declared validation_gates at append time
//   + ≥1 reviewer attestation
//   + complete compatibility metadata
//   + all safety gates passed.
//
// P4 proves this NEGATIVELY (internal phase plan, P4 row): the receipt engine
// is P5, so what
// P4 must show is that the gate cannot be faked or bypassed — every single
// missing conjunct refuses the transition, and no exported function reaches
// `verified` around the check. That is why `transitionVersion` refuses
// `verified` outright (USE_VERIFY_VERSION) exactly as it refuses `published`:
// a generic transition entry point would itself be the bypass (P3 verdict 1,
// blocking #1 — the same lesson).
//
// §5.1's fourth conjunct is what makes that check current: `skill.verify`
// re-runs all eight §7.1 gates in ONE transaction and decides from that
// invocation's complete eight-result set alone — "no stored result from an
// earlier run is consulted". Any current FAIL blocks; WARN does not. Historical
// `lint_reports` rows are audit evidence and never keep a corrected version
// blocked.
import type { Db } from "./sqlite.ts";
import { validatePayload } from "./manifest.ts";
import { GATE_NAMES, runGates, type GateReport } from "./gates.ts";
import type { PackageFiles } from "./archive.ts";
import { appendTlogInTx, type TlogRow } from "./tlog.ts";
import { eligibleApproveReviewers, isLegalTransition, type VersionState } from "./transitions.ts";
import { ulid } from "./ulid.ts";

export const TLOG_VERIFIED = "version_verified";

export type VerifiedConjunct =
  | "evidence_receipt"
  | "reviewer_attestation"
  | "compatibility_metadata"
  | "safety_gates";

export interface ConjunctResult {
  id: VerifiedConjunct;
  satisfied: boolean;
  detail: string;
}

// ------------------------------------------------- conjunct 1: evidence receipt

export interface EvidenceValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Appendix E.2 `evidence-v1`: the registry validates `gate_results[].gate_id`
 * ⊆ the version's declared `validation_gates` AND requires every declared gate
 * present with `pass:true`. This function is the single implementation of that
 * rule; P5's `append_receipt_event` calls the same one, so "validated at
 * append time" and "validated at gate time" cannot drift apart.
 */
export function validateEvidenceForVersion(manifest: any, evidence: unknown): EvidenceValidation {
  const schema = validatePayload("evidence", evidence);
  if (!schema.valid) return { valid: false, errors: schema.errors };

  const declared = manifest?.procedure?.validation_gates;
  if (!Array.isArray(declared) || declared.length === 0) {
    return { valid: false, errors: ["version declares no validation_gates — no evidence can validate against it"] };
  }
  const declaredIds = new Set<string>();
  for (const g of declared) {
    if (typeof g?.gate_id === "string") declaredIds.add(g.gate_id);
  }
  if (declaredIds.size !== declared.length) {
    return { valid: false, errors: ["declared validation_gates carry a malformed or duplicate gate_id"] };
  }

  const results = (evidence as any).gate_results as Array<{ gate_id: string; pass: boolean }>;
  const errors: string[] = [];
  const passed = new Set<string>();
  for (const r of results) {
    if (!declaredIds.has(r.gate_id)) {
      errors.push(`gate_results names ${r.gate_id}, which this version does not declare`);
      continue;
    }
    if (r.pass === true) passed.add(r.gate_id);
  }
  for (const id of declaredIds) {
    if (!passed.has(id)) errors.push(`declared gate ${id} is not present with pass:true`);
  }
  return { valid: errors.length === 0, errors };
}

interface AdoptedReceiptRow {
  receipt_id: string;
  evidence_json: string | null;
}

/**
 * §5.1 conjunct 1. `terminal event` is the receipt's terminal event in the
 * §5.3 sense — the DDL fixes that set as `adopted | failed`
 * (`uq_receipt_terminal … WHERE event IN ('adopted','failed')`), with
 * `rolled_back` explicitly the "sole POST-terminal event". So a receipt
 * qualifies when it carries an `adopted` row whose evidence validates; a
 * `failed` receipt never does.
 */
export function evidenceReceiptConjunct(db: Db, versionId: string, manifest: any): ConjunctResult {
  const rows = db
    .prepare(
      `SELECT r.id AS receipt_id, e.evidence_json AS evidence_json
         FROM adoption_receipts r JOIN receipt_events e ON e.adoption_receipt_id = r.id
        WHERE r.skill_version_id = ? AND e.event = 'adopted'
        ORDER BY e.server_at_ms, e.id`,
    )
    .all(versionId) as AdoptedReceiptRow[];
  if (rows.length === 0) {
    return {
      id: "evidence_receipt",
      satisfied: false,
      detail: "no adoption receipt of this version has a terminal `adopted` event (§5.1)",
    };
  }
  const reasons: string[] = [];
  for (const row of rows) {
    if (row.evidence_json === null) {
      reasons.push(`${row.receipt_id}: adopted without evidence_json`);
      continue;
    }
    let evidence: unknown;
    try {
      evidence = JSON.parse(row.evidence_json);
    } catch {
      reasons.push(`${row.receipt_id}: evidence_json is not JSON`);
      continue;
    }
    const val = validateEvidenceForVersion(manifest, evidence);
    if (val.valid) {
      return {
        id: "evidence_receipt",
        satisfied: true,
        detail: `receipt ${row.receipt_id} carries validated evidence for every declared validation gate`,
      };
    }
    reasons.push(`${row.receipt_id}: ${val.errors.slice(0, 3).join("; ")}`);
  }
  return {
    id: "evidence_receipt",
    satisfied: false,
    detail: `no adopted receipt carries evidence that validates against the declared validation_gates — ${reasons.slice(0, 3).join(" | ")}`,
  };
}

// --------------------------------------------- conjunct 2: reviewer attestation

/**
 * §5.1 conjunct 2, read through §6 surface 3: an `approve` verdict inserts the
 * `reviews` row and the `attestations(kind=reviewer)` row in ONE transaction,
 * so "exactly one source of reviewer truth" means the PAIR. The gate therefore
 * requires both halves from the SAME agent — a lone attestation row (the shape
 * a forger would write) satisfies nothing, and neither does a lone review.
 *
 * Eligibility is re-evaluated at GATE time, not merely at submission time, and
 * comes from `eligibleApproveReviewers` — the one place §5.1's reviewer rules
 * live, shared with the `reviewed` transition guard.
 */
export function reviewerAttestationConjunct(db: Db, versionId: string): ConjunctResult {
  const rows = db
    .prepare(
      "SELECT id, attester_agent_id AS attester, payload_json FROM attestations WHERE skill_version_id=? AND kind='reviewer' ORDER BY created_at_ms, id",
    )
    .all(versionId) as Array<{ id: string; attester: string; payload_json: string | null }>;
  if (rows.length === 0) {
    return { id: "reviewer_attestation", satisfied: false, detail: "no attestations(kind=reviewer) row for this version" };
  }
  const eligible = new Set(eligibleApproveReviewers(db, versionId));
  const reasons: string[] = [];
  for (const row of rows) {
    // P4 verdict 2, blocking F1: the attestation must be THE one written with a
    // specific approve review, not merely a `kind='reviewer'` row belonging to
    // somebody who happens to have approved. §6 surface 3 writes the pair in
    // one transaction ("approve atomically inserts the corresponding
    // attestation"), so the gate follows the pointer that pairing leaves and
    // re-checks that the review it names is an approve OF THIS VERSION BY THIS
    // ATTESTER. A row with no `review_id` — the shape a forger writes — is not
    // a corresponding attestation and satisfies nothing.
    let reviewId: unknown = null;
    try {
      reviewId = row.payload_json === null ? null : JSON.parse(row.payload_json)?.review_id ?? null;
    } catch {
      reviewId = null;
    }
    if (typeof reviewId !== "string" || reviewId.length === 0) {
      reasons.push(`${row.id}: carries no review_id — not the attestation an approve verdict writes (§6 surface 3)`);
      continue;
    }
    const review = db
      .prepare("SELECT skill_version_id, reviewer_agent_id, verdict FROM reviews WHERE id=?")
      .get(reviewId) as { skill_version_id: string; reviewer_agent_id: string; verdict: string } | undefined;
    if (!review) {
      reasons.push(`${row.id}: names review ${reviewId}, which does not exist`);
      continue;
    }
    if (review.skill_version_id !== versionId) {
      reasons.push(`${row.id}: names a review of a different version`);
      continue;
    }
    if (review.reviewer_agent_id !== row.attester) {
      reasons.push(`${row.id}: names a review submitted by ${review.reviewer_agent_id}, not by the attester`);
      continue;
    }
    if (review.verdict !== "approve") {
      reasons.push(`${row.id}: names a ${review.verdict} verdict, not an approve`);
      continue;
    }
    if (!eligible.has(row.attester)) {
      reasons.push(`${row.id}: ${row.attester} is not an eligible reviewer of this version`);
      continue;
    }
    return {
      id: "reviewer_attestation",
      satisfied: true,
      detail: `reviewer ${row.attester} attested (attestation ${row.id}) with the approve review ${reviewId} it was written with`,
    };
  }
  return {
    id: "reviewer_attestation",
    satisfied: false,
    detail:
      `no attestation of this version corresponds to an eligible approve review — ${reasons.slice(0, 3).join(" | ")} ` +
      `(eligible approvers: [${[...eligible].join(", ") || "none"}])`,
  };
}

// ------------------------------------- conjunct 3: complete compatibility metadata

/**
 * §5.1 conjunct 3 read against the §4.2 Runtime group, whose required fields
 * are exactly the compatibility contract the adopter-side match algorithm
 * consumes: `model_compat`, `runtime_compat`, `tool_compat` (matcher lists),
 * `os[]`, `shell[]`. Appendix E already forces them to be PRESENT; "complete"
 * here is the stronger reading the gate needs — present AND non-empty AND with
 * usable `{id, range}` matchers, because an empty matcher list matches nothing
 * and would make every adopter a `mismatch`.
 *
 * `cloud_iam_assumptions` and `mcp_dependencies` are required Runtime fields
 * too, but they are legitimately empty for most packages (TV-01 declares both
 * empty), so presence — not non-emptiness — is what completeness means there.
 */
export function compatibilityConjunct(manifest: any): ConjunctResult {
  const rt = manifest?.runtime;
  if (rt === null || typeof rt !== "object") {
    return { id: "compatibility_metadata", satisfied: false, detail: "manifest declares no runtime group (§4.2)" };
  }
  const missing: string[] = [];
  for (const field of ["model_compat", "runtime_compat", "tool_compat"] as const) {
    const list = rt[field];
    if (!Array.isArray(list) || list.length === 0) {
      missing.push(`${field} is empty`);
      continue;
    }
    for (const m of list) {
      if (typeof m?.id !== "string" || m.id.length === 0 || typeof m?.range !== "string" || m.range.length === 0) {
        missing.push(`${field} carries a matcher without id+range`);
        break;
      }
    }
  }
  for (const field of ["os", "shell"] as const) {
    const list = rt[field];
    if (!Array.isArray(list) || list.length === 0) missing.push(`${field} is empty`);
  }
  for (const field of ["cloud_iam_assumptions", "mcp_dependencies"] as const) {
    if (!Array.isArray(rt[field])) missing.push(`${field} is absent`);
  }
  return missing.length === 0
    ? { id: "compatibility_metadata", satisfied: true, detail: "§4.2 Runtime compatibility group complete" }
    : { id: "compatibility_metadata", satisfied: false, detail: `incomplete compatibility metadata: ${missing.join("; ")}` };
}

// ------------------------------------------- conjunct 4: all safety gates passed

/**
 * §5.1 conjunct 4: the decision comes from THIS invocation's complete
 * eight-result set. A partial run is not a run (the P3 aggregate rule), any
 * FAIL blocks, WARN does not, and no historical row is consulted.
 */
export function safetyGatesConjunct(reports: GateReport[]): ConjunctResult {
  const reported = new Set(reports.map((r) => r.gate));
  const absent = GATE_NAMES.filter((g) => !reported.has(g));
  if (absent.length > 0) {
    return { id: "safety_gates", satisfied: false, detail: `current run is incomplete — no result for ${absent.join(", ")}` };
  }
  const failed = reports.filter((r) => r.result === "fail").map((r) => r.gate);
  return failed.length === 0
    ? { id: "safety_gates", satisfied: true, detail: "current eight-gate run carries no FAIL" }
    : { id: "safety_gates", satisfied: false, detail: `current run FAILs: ${failed.join(", ")}` };
}

// ------------------------------------------------------------- the conjunction

export interface VerifiedGateOutcome {
  ok: boolean;
  checks: ConjunctResult[];
}

/** Evaluate all four conjuncts. Every conjunct is reported, satisfied or not,
 *  so a refusal names exactly which one is missing. */
export function evaluateVerifiedGate(
  db: Db,
  versionId: string,
  manifest: any,
  reports: GateReport[],
): VerifiedGateOutcome {
  const checks = [
    evidenceReceiptConjunct(db, versionId, manifest),
    reviewerAttestationConjunct(db, versionId),
    compatibilityConjunct(manifest),
    safetyGatesConjunct(reports),
  ];
  return { ok: checks.every((c) => c.satisfied), checks };
}

// ------------------------------------------------ the single `verified` writer

export interface VerifyTransitionOutcome {
  /** §4.4.8 verdict vocabulary — the transition form answers in it too */
  verdict: "valid" | "not_verified" | "revoked" | "valid_superseded" | "valid_deprecated";
  state: VersionState;
  checks: ConjunctResult[];
  reports: Array<{ gate: string; result: string; details: string | null }>;
  revocation_reason?: string;
  successor_version_id?: string;
  /** true when the call changed nothing (already verified/published, or refused) */
  noop?: boolean;
  tlog_seq?: number;
}

interface VerifyVersionRow {
  id: string;
  state: VersionState;
  manifest_json: string;
  package_blob_ref: string;
  superseded_by_version_id: string | null;
  revocation_reason: string | null;
}

/**
 * Surface 4 (transition form). Reads the CURRENT state, and for a `reviewed`
 * version re-runs all eight gates and evaluates the §5.1 conjunction, writing
 * the gate run, the state change and the transparency-log entry in ONE
 * transaction — so the verdict and the run it was made from cannot come apart,
 * which is what conjunct 4's "this one invocation" is worth in practice.
 *
 * States other than `reviewed` answer in the §4.4 step-5 vocabulary rather
 * than erroring: `revoked` → `revoked` (this is how revocation reaches
 * `skill.verify` verdicts immediately, §6 surface 11), `superseded` →
 * `valid_superseded`, `deprecated` → `valid_deprecated`, `verified`/
 * `published` → `valid` (converging noop, defect #1), anything else →
 * `not_verified`.
 *
 * `files` is the package blob read BEFORE the transaction (blobs are
 * content-addressed and immutable); the row is re-read under the write lock
 * and the blob ref compared, so a transition can never be decided from a scan
 * of different bytes than the ones the version points at.
 */
export function verifyVersionTransition(
  db: Db,
  versionId: string,
  files: PackageFiles,
  scannedBlobRef: string,
  nowMs: number,
): VerifyTransitionOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT id, state, manifest_json, package_blob_ref, superseded_by_version_id, revocation_reason
           FROM skill_versions WHERE id=?`,
      )
      .get(versionId) as VerifyVersionRow | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      return { verdict: "not_verified", state: "draft", checks: [], reports: [], noop: true };
    }
    if (row.package_blob_ref !== scannedBlobRef) {
      db.exec("ROLLBACK");
      return {
        verdict: "not_verified",
        state: row.state,
        checks: [
          {
            id: "safety_gates",
            satisfied: false,
            detail: "the version's package blob changed while its gates were running — nothing was decided",
          },
        ],
        reports: [],
        noop: true,
      };
    }

    if (row.state !== "reviewed") {
      db.exec("ROLLBACK");
      return nonTransitionVerdict(row);
    }
    // the whitelist is the same one every other transition obeys
    if (!isLegalTransition("reviewed", "verified")) {
      db.exec("ROLLBACK");
      return { verdict: "not_verified", state: row.state, checks: [], reports: [], noop: true };
    }

    let manifest: any = null;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      manifest = null; // an unreadable manifest fails schema and compatibility below
    }

    // §5.1 conjunct 4: this invocation's own complete eight-gate run decides.
    const reports = runGates(manifest, files, { nowMs });
    const insert = db.prepare(
      "INSERT INTO lint_reports(id, skill_version_id, gate, result, details_json, created_at_ms) VALUES (?,?,?,?,?,?)",
    );
    for (const r of reports) {
      insert.run(
        ulid(nowMs),
        versionId,
        r.gate,
        r.result,
        r.details === null ? null : JSON.stringify({ details: r.details, source: "skill.verify" }),
        nowMs,
      );
    }
    const reportsOut = reports.map((r) => ({ gate: r.gate, result: r.result, details: r.details }));

    const gate = evaluateVerifiedGate(db, versionId, manifest, reports);
    if (!gate.ok) {
      // The gate run is audit evidence and is kept; the state is not touched.
      db.exec("COMMIT");
      return { verdict: "not_verified", state: "reviewed", checks: gate.checks, reports: reportsOut, noop: true };
    }

    const res = db
      .prepare("UPDATE skill_versions SET state='verified' WHERE id=? AND state='reviewed'")
      .run(versionId);
    if (res.changes !== 1) {
      // lost a race with a concurrent transition — decide nothing
      db.exec("ROLLBACK");
      const now = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as { state: VersionState };
      return { verdict: "not_verified", state: now.state, checks: gate.checks, reports: reportsOut, noop: true };
    }
    const tlog: TlogRow = appendTlogInTx(
      db,
      TLOG_VERIFIED,
      versionId,
      {
        skill_version_id: versionId,
        state: "verified",
        checks: gate.checks.map((c) => ({ id: c.id, satisfied: c.satisfied })),
        gates: reports.map((r) => ({ gate: r.gate, result: r.result })),
      },
      nowMs,
    );
    db.exec("COMMIT");
    return { verdict: "valid", state: "verified", checks: gate.checks, reports: reportsOut, tlog_seq: tlog.seq };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed
    }
    throw e;
  }
}

/** §4.4 step 5 mapped onto a version that cannot transition right now. */
function nonTransitionVerdict(row: VerifyVersionRow): VerifyTransitionOutcome {
  const base: Omit<VerifyTransitionOutcome, "verdict"> = {
    state: row.state,
    checks: [],
    reports: [],
    noop: true,
  };
  switch (row.state) {
    case "revoked":
      return { ...base, verdict: "revoked", revocation_reason: row.revocation_reason ?? undefined };
    case "superseded":
      return {
        ...base,
        verdict: "valid_superseded",
        successor_version_id: row.superseded_by_version_id ?? undefined,
      };
    case "deprecated":
      return { ...base, verdict: "valid_deprecated" };
    case "verified":
    case "published":
      return { ...base, verdict: "valid" };
    default:
      return { ...base, verdict: "not_verified" };
  }
}
