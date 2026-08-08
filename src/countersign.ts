// §4.3.8 registry countersign — binds manifest_hash to server time in the
// transparency log. This tlog entry, not the author's created_at, is the
// trusted timestamp and the §4.4 step-7 revocation reference point.
//
// Countersigning exists ONLY as part of publication. publishVersion is the
// single writer of both the `published` state and the countersign row, and it
// does the reads AND the writes inside one transaction — no other module can
// reach `published`, and no interleaving can produce two countersigns with
// different reference times.
import type { Db } from "./sqlite.ts";
import { appendTlogInTx, type TlogRow } from "./tlog.ts";
import { isLegalTransition, transitionVersion, type TransitionResult, type VersionState } from "./transitions.ts";
import { publishApprovalSatisfied, requiresHumanApproval } from "./approvals.ts";

export const COUNTERSIGN_EVENT = "countersign";

export interface PublishResult {
  transition: TransitionResult;
  countersign?: TlogRow;
}

export function publishVersion(db: Db, versionId: string, serverAtMs: number = Date.now()): PublishResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    // every read happens under the write lock: no stale-check interleaving
    const row = db
      .prepare(
        `SELECT v.state, v.manifest_hash, v.manifest_json, s.workspace_id
           FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE v.id=?`,
      )
      .get(versionId) as
      | { state: VersionState; manifest_hash: string; manifest_json: string; workspace_id: string }
      | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      return { transition: { ok: false, code: "NOT_FOUND" } };
    }
    const existing = db
      .prepare("SELECT seq FROM transparency_log WHERE event_kind=? AND subject_id=? LIMIT 1")
      .get(COUNTERSIGN_EVENT, row.manifest_hash) as { seq: number } | undefined;

    if (row.state === "published") {
      if (existing) {
        db.exec("COMMIT"); // idempotent republish: already published AND countersigned
        return { transition: { ok: true, noop: true, state: "published" } };
      }
      // published-without-countersign is unreachable by construction; repair it
    } else {
      // §6's converging-conflict rule first: whether the machine ALLOWS this
      // transition is decided before any evidence about the countersign row.
      // The other order answered a retired version (deprecated/superseded/
      // revoked — all of which necessarily carry a countersign, because they
      // are only reachable from `published`) with CONFLICT, where §5.1 and §6
      // both fix PRECONDITION_FAILED for "a transition the machine forbids".
      if (!isLegalTransition(row.state, "published")) {
        db.exec("ROLLBACK");
        return { transition: { ok: false, code: "PRECONDITION_FAILED", current_state: row.state } };
      }
      if (existing) {
        // The transition IS legal (state is `verified`) and a countersign for
        // this manifest_hash exists anyway — `manifest_hash` carries no UNIQUE
        // constraint in D.1, so a second version row can share it with an
        // already-published one. Publishing would fix the §4.4 step-7
        // revocation reference clock from a decision that was never made about
        // THIS version, so it is refused as a genuine conflict.
        db.exec("ROLLBACK");
        return { transition: { ok: false, code: "CONFLICT", current_state: row.state } };
      }
      // §5.1: "`published` additionally requires human approval when §7.3
      // matrix demands it" — enforced at the single publication entry point, in
      // the same transaction as the state change, so no caller can publish
      // first and collect the approval afterwards. The approval is satisfied
      // only by a HUMAN admin/owner of this workspace (§7.3 / §6 ACL matrix);
      // a service identity can never supply it.
      if (!publishApprovalOk(db, versionId, row)) {
        db.exec("ROLLBACK");
        return { transition: { ok: false, code: "APPROVAL_REQUIRED", current_state: row.state } };
      }
      const res = db
        .prepare("UPDATE skill_versions SET state='published' WHERE id=? AND state=?")
        .run(versionId, row.state);
      if (res.changes !== 1) {
        db.exec("ROLLBACK");
        return { transition: { ok: false, code: "CONFLICT", current_state: row.state } };
      }
    }

    const countersign = appendTlogInTx(
      db,
      COUNTERSIGN_EVENT,
      row.manifest_hash,
      { manifest_hash: row.manifest_hash, skill_version_id: versionId },
      serverAtMs,
    );
    db.exec("COMMIT");
    return { transition: { ok: true, noop: false, state: "published" }, countersign };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * §7.3 publish column, evaluated inside the publication transaction. A
 * manifest that cannot be parsed is treated as requiring approval
 * (fail-closed, `requiresHumanApproval`).
 */
function publishApprovalOk(
  db: Db,
  versionId: string,
  row: { manifest_json: string; workspace_id: string },
): boolean {
  let manifest: any = null;
  try {
    manifest = JSON.parse(row.manifest_json);
  } catch {
    manifest = null;
  }
  const adopted = db
    .prepare(
      `SELECT COUNT(*) AS c FROM receipt_events e JOIN adoption_receipts r ON r.id = e.adoption_receipt_id
        WHERE r.skill_version_id = ? AND e.event = 'adopted'`,
    )
    .get(versionId) as { c: number };
  if (!requiresHumanApproval(manifest, { adoptedCount: adopted.c })) return true;
  return publishApprovalSatisfied(db, versionId, row.workspace_id);
}

/** Re-exported for callers that only need the generic (non-publish) transitions. */
export { transitionVersion };
