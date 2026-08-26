// P1 — THE LIFECYCLE OF §5.1b, RUN RATHER THAN DESCRIBED.
//
// WHAT THIS FILE HAS TO PROVE.
//
//   §5.1b says a disposition and a replacement are two facts about one version,
//   that either may be recorded first, and that both orders converge. A test
//   suite that only drives the happy path proves the first half of one order.
//   So every claim here is asserted as a STATE — the row, the transparency log,
//   the notice queue and the idempotency table read back after the call — and
//   the two orders are run against each other and compared.
//
//   THE ATOMICITY CLAIM IS THE ONE THAT CANNOT BE ASSERTED BY SUCCEEDING. "One
//   transaction" is a statement about what happens when something goes wrong,
//   and a call that completes says nothing about it. `[P1.L9]` therefore injects
//   a failure BETWEEN the domain write and the idempotency insert and compares a
//   full row-and-count snapshot taken before the call with one taken after: no
//   state change, no lineage column, no transparency-log entry, no queued
//   notice, no idempotency row. That is the gate this packet turns on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { p4Fixture, publishedVersion, verifiableVersion, NOW, type P4Fixture } from "./p4-helpers.ts";
import { isApiError } from "../src/errors.ts";
import { TLOG_REVOKED, TLOG_SUPERSEDED } from "../src/service.ts";
import { LIFECYCLE_TLOG_ORDER, revokeRequestDigest } from "../src/lifecycle-v11.ts";
import { verifyTlog } from "../src/tlog.ts";
import type { Stmt } from "../src/sqlite.ts";
import { ulid } from "../src/ulid.ts";

function rejects(fn: () => unknown, code: string, message?: RegExp): unknown {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (e) {
    if (!isApiError(e)) throw e;
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return e;
  }
}

function row(fx: P4Fixture, id: string): any {
  return fx.db.prepare("SELECT * FROM skill_versions WHERE id=?").get(id);
}

/** The transparency-log entries about one version, in chain order. */
function tlogOf(fx: P4Fixture, id: string): Array<{ seq: number; event_kind: string }> {
  return fx.db
    .prepare("SELECT seq, event_kind FROM transparency_log WHERE subject_id=? ORDER BY seq")
    .all(id) as Array<{ seq: number; event_kind: string }>;
}

function noticeCount(fx: P4Fixture, id: string): number {
  return (
    fx.db
      .prepare("SELECT COUNT(*) AS c FROM adoption_requests WHERE skill_version_id=? AND notification_kind='revocation'")
      .get(id) as { c: number }
  ).c;
}

/** A published predecessor and a verified successor of the same skill. */
function pair(fx: P4Fixture, slug: string) {
  const predecessor = publishedVersion(fx, slug);
  const successor = verifiableVersion(fx, slug, {
    skill_id: predecessor.skillId,
    semver: "2.0.0",
    manifest: { skill_id: predecessor.skillId },
  });
  fx.registry.verifyVersion(fx.owner, successor.versionId);
  return { predecessor, successor };
}

// ===========================================================================
// G-P1-4 — the semantics of §5.1b
// ===========================================================================

test("[P1.L1] P1-FR-01: revoke, then attach the successor, and the revocation is not given up to do it", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "revoke-then-attach");

  const first = fx.registry.revokeVersion(fx.owner, predecessor.versionId, { reason: "leaks a token" }).response;
  assert.equal(first.state, "revoked");
  assert.equal(first.superseded_by, null, "a revocation that named no successor says so, rather than staying silent");
  assert.equal(first.lineage_tlog_seq, undefined, "no link was created, so no lineage entry was appended");

  const second = fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
    reason: "leaks a token",
    successor_version_id: successor.versionId,
  }).response;
  // The disposition did not move and was not repeated; the pointer was written.
  assert.equal(second.state, "revoked");
  assert.equal(second.reason, "leaks a token");
  assert.equal(second.superseded_by, successor.versionId);
  assert.equal(second.tlog_seq, undefined, "this call revoked nothing, so it appended no `version_revoked` entry");
  assert.ok(typeof second.lineage_tlog_seq === "number", "…but it DID create the link, and says which entry that was");
  assert.equal(second.noop, undefined, "a call that wrote a column is not a call that changed nothing");
  assert.equal(second.notifications_queued, undefined, "no second revocation, no second notice count");
  assert.equal(second.notified_adopters, undefined);

  const after = row(fx, predecessor.versionId);
  assert.equal(after.state, "revoked");
  assert.equal(after.revocation_reason, "leaks a token");
  assert.equal(after.superseded_by_version_id, successor.versionId);
  assert.equal(row(fx, successor.versionId).supersedes_version_id, predecessor.versionId, "both halves of the pair");
  assert.equal(row(fx, successor.versionId).state, "verified", "linking does not move the successor");

  assert.deepEqual(
    tlogOf(fx, predecessor.versionId).map((e) => e.event_kind).filter((k) => k === TLOG_REVOKED || k === TLOG_SUPERSEDED),
    [TLOG_REVOKED, TLOG_SUPERSEDED],
  );
  assert.equal(verifyTlog(fx.db).ok, true);
  fx.db.close();
});

test("[P1.L2] P1-FR-02: supersede, then revoke, and the link survives the revocation", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "supersede-then-revoke");

  fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: successor.versionId });
  assert.equal(row(fx, predecessor.versionId).state, "superseded");

  const out = fx.registry.revokeVersion(fx.owner, predecessor.versionId, { reason: "leaks a token" }).response;
  assert.equal(out.state, "revoked");
  assert.equal(out.superseded_by, successor.versionId, "the existing link is PRESERVED across the move");
  assert.equal(out.lineage_tlog_seq, undefined, "this call created no link, so it appended no second entry");
  assert.ok(typeof out.tlog_seq === "number");

  const after = row(fx, predecessor.versionId);
  assert.equal(after.state, "revoked");
  assert.equal(after.superseded_by_version_id, successor.versionId);
  assert.equal(verifyTlog(fx.db).ok, true);
  fx.db.close();
});

test("[P1.L3] AC-06: both orders converge on the same row, and on the same two log entries", () => {
  const fx = p4Fixture();
  const a = pair(fx, "converge-a");
  const b = pair(fx, "converge-b");

  // order 1: revoke, then attach
  fx.registry.revokeVersion(fx.owner, a.predecessor.versionId, { reason: "same reason" });
  fx.registry.revokeVersion(fx.owner, a.predecessor.versionId, {
    reason: "same reason",
    successor_version_id: a.successor.versionId,
  });
  // order 2: supersede, then revoke
  fx.registry.supersedeVersion(fx.owner, b.predecessor.versionId, { successor_version_id: b.successor.versionId });
  fx.registry.revokeVersion(fx.owner, b.predecessor.versionId, { reason: "same reason" });

  const shape = (id: string, successorId: string): unknown => {
    const r = row(fx, id);
    return {
      state: r.state,
      revocation_reason: r.revocation_reason,
      superseded_by: r.superseded_by_version_id === successorId ? "<the successor>" : r.superseded_by_version_id,
      successor_side: row(fx, successorId).supersedes_version_id === id ? "<this version>" : "unlinked",
    };
  };
  assert.deepEqual(
    shape(a.predecessor.versionId, a.successor.versionId),
    shape(b.predecessor.versionId, b.successor.versionId),
    "the two orders leave different rows",
  );
  // Each order wrote exactly one entry of each kind — no order writes an extra.
  for (const id of [a.predecessor.versionId, b.predecessor.versionId]) {
    const kinds = tlogOf(fx, id)
      .map((e) => e.event_kind)
      .filter((k) => k === TLOG_REVOKED || k === TLOG_SUPERSEDED);
    assert.equal(kinds.filter((k) => k === TLOG_REVOKED).length, 1);
    assert.equal(kinds.filter((k) => k === TLOG_SUPERSEDED).length, 1);
  }
  fx.db.close();
});

test("[P1.L4] P1-FR-04: a conflicting reason and a conflicting successor are each refused, and change nothing", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "conflicts");
  const other = verifiableVersion(fx, "conflicts", {
    skill_id: predecessor.skillId,
    semver: "3.0.0",
    manifest: { skill_id: predecessor.skillId },
  });
  fx.registry.verifyVersion(fx.owner, other.versionId);

  fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
    reason: "leaks a token",
    successor_version_id: successor.versionId,
  });
  const before = row(fx, predecessor.versionId);
  const logBefore = tlogOf(fx, predecessor.versionId).length;

  // a different reason on an already-revoked version
  rejects(
    () => fx.registry.revokeVersion(fx.owner, predecessor.versionId, { reason: "a better wording" }),
    "CONFLICT",
    /immutable/,
  );
  // a different successor
  rejects(
    () =>
      fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
        reason: "leaks a token",
        successor_version_id: other.versionId,
      }),
    "CONFLICT",
    /different successor/,
  );
  // …and the same refusal through surface 10
  rejects(
    () => fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: other.versionId }),
    "CONFLICT",
    /different successor/,
  );

  assert.deepEqual(row(fx, predecessor.versionId), before, "a refused lifecycle call left the row changed");
  assert.equal(tlogOf(fx, predecessor.versionId).length, logBefore, "a refused call appended to the log");
  assert.equal(row(fx, other.versionId).supersedes_version_id, null, "a refused call linked the loser");
  fx.db.close();
});

test("[P1.L5] a repeat carrying the identical reason and link is a convergent noop: no second event, no second notice", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "convergent-repeat");

  const first = fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
    reason: "leaks a token",
    successor_version_id: successor.versionId,
  }).response;
  assert.equal(first.noop, undefined);
  const logAfterFirst = tlogOf(fx, predecessor.versionId).length;
  const noticesAfterFirst = noticeCount(fx, predecessor.versionId);

  const again = fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
    reason: "leaks a token",
    successor_version_id: successor.versionId,
  }).response;
  assert.equal(again.noop, true);
  assert.equal(again.state, "revoked");
  assert.equal(again.reason, "leaks a token");
  assert.equal(again.superseded_by, successor.versionId);
  assert.equal(again.tlog_seq, undefined);
  assert.equal(again.lineage_tlog_seq, undefined);
  // Neither queue-count field appears on a call that queued nothing. Reporting
  // the first call's figure here would be this response inventing a delivery.
  assert.equal(again.notifications_queued, undefined);
  assert.equal(again.notified_adopters, undefined);

  assert.equal(tlogOf(fx, predecessor.versionId).length, logAfterFirst);
  assert.equal(noticeCount(fx, predecessor.versionId), noticesAfterFirst);

  // …and the same convergence on surface 10, which also queues nothing
  const sup = fx.registry
    .supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: successor.versionId })
    .response;
  assert.equal(sup.noop, true);
  assert.equal(sup.state, "revoked", "converging on surface 10 does not soften the disposition");
  assert.equal(sup.superseded_by, successor.versionId);
  assert.equal(tlogOf(fx, predecessor.versionId).length, logAfterFirst);
  fx.db.close();
});

test("[P1.L6] the two entries are appended in the fixed order, revoke first and lineage second", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "fixed-order");

  const out = fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
    reason: "leaks a token",
    successor_version_id: successor.versionId,
  }).response;

  const entries = tlogOf(fx, predecessor.versionId).filter(
    (e) => e.event_kind === TLOG_REVOKED || e.event_kind === TLOG_SUPERSEDED,
  );
  assert.deepEqual(entries.map((e) => e.event_kind), [...LIFECYCLE_TLOG_ORDER]);
  // The order is a property of the SEQ, not of the array this test read: the
  // revocation's seq is strictly lower, so a verifier reading the chain offline
  // reaches it first without comparing two same-millisecond timestamps.
  assert.ok(entries[0].seq < entries[1].seq);
  assert.equal(out.tlog_seq, entries[0].seq, "`tlog_seq` is the revocation's, always");
  assert.equal(out.lineage_tlog_seq, entries[1].seq);
  assert.equal(verifyTlog(fx.db).ok, true, "the hash chain verifies after both appends");
  fx.db.close();
});

test("[P1.L7] §5.1b: every released state may be revoked, and each keeps what it had", () => {
  const fx = p4Fixture();

  // from `published`
  const p = publishedVersion(fx, "revocable-published");
  assert.equal(fx.registry.revokeVersion(fx.owner, p.versionId, { reason: "r" }).response.state, "revoked");

  // from `deprecated` — the date stamped by the deprecation survives
  const d = publishedVersion(fx, "revocable-deprecated");
  fx.registry.deprecateVersion(fx.owner, d.versionId);
  const fromDeprecated = fx.registry.revokeVersion(fx.owner, d.versionId, { reason: "r" }).response;
  assert.equal(fromDeprecated.state, "revoked");
  assert.equal(row(fx, d.versionId).deprecation_at_ms, NOW, "the revocation erased the deprecation date");

  // from `superseded` — the link survives
  const s = pair(fx, "revocable-superseded");
  fx.registry.supersedeVersion(fx.owner, s.predecessor.versionId, { successor_version_id: s.successor.versionId });
  const fromSuperseded = fx.registry.revokeVersion(fx.owner, s.predecessor.versionId, { reason: "r" }).response;
  assert.equal(fromSuperseded.state, "revoked");
  assert.equal(fromSuperseded.superseded_by, s.successor.versionId);

  // and from nowhere earlier: a version that never reached `published` has no
  // adopter to warn and nothing to withdraw
  const draft = verifiableVersion(fx, "revocable-verified", {});
  fx.registry.verifyVersion(fx.owner, draft.versionId);
  rejects(() => fx.registry.revokeVersion(fx.owner, draft.versionId, { reason: "r" }), "PRECONDITION_FAILED");
  assert.equal(row(fx, draft.versionId).state, "verified");
  fx.db.close();
});

test("[P1.L8] the response shape of §5.1b, member by member", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "response-shape");

  const fresh = fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
    reason: "leaks a token",
    successor_version_id: successor.versionId,
  }).response;
  assert.deepEqual(Object.keys(fresh).sort(), [
    "lineage_tlog_seq",
    "notifications_queued",
    "notified_adopters",
    "reason",
    "skill_version_id",
    "state",
    "superseded_by",
    "tlog_seq",
  ]);
  assert.equal(fresh.notifications_queued, fresh.notified_adopters, "one count, two names, one meaning");

  // A version with no successor still ANSWERS the successor question.
  const alone = publishedVersion(fx, "response-shape-alone");
  const noSuccessor = fx.registry.revokeVersion(fx.owner, alone.versionId, { reason: "r" }).response;
  assert.ok("superseded_by" in noSuccessor);
  assert.equal(noSuccessor.superseded_by, null);
  assert.equal(noSuccessor.lineage_tlog_seq, undefined);
  fx.db.close();
});

// ===========================================================================
// G-P1-5 — atomicity under an injected fault (P1-FR-03, AC-07)
// ===========================================================================

/**
 * Everything a revocation-with-successor writes, read back as one value.
 *
 * FULL ROWS, not counts of them. A snapshot that counted rows would be blind to
 * a revocation that committed its state change and rolled back only its log
 * entry — which is the shape of partial write this gate exists to detect.
 */
function fullSnapshot(fx: P4Fixture, ids: string[]): string {
  const q = (sql: string, params: unknown[] = []): unknown => fx.db.prepare(sql).all(...params);
  return JSON.stringify({
    versions: ids.map((id) => row(fx, id)),
    tlog: q("SELECT seq, event_kind, subject_id, payload_hash, prev_hash, this_hash FROM transparency_log ORDER BY seq"),
    notices: q(
      "SELECT id, skill_version_id, adopter_agent_id, state, notification_kind FROM adoption_requests ORDER BY id",
    ),
    idempotency: q("SELECT id, actor_agent_id, surface, key, response_json FROM idempotency_keys ORDER BY id"),
    digests: q("SELECT idempotency_key_id, request_digest FROM idempotency_request_digests ORDER BY idempotency_key_id"),
  });
}

/**
 * Break the ONE write that lands between the domain write and the commit.
 *
 * WHY HERE AND NOT ANYWHERE ELSE. `withIdempotencyInTx` runs the lifecycle
 * writer, serializes its answer and inserts the replay row, all inside one
 * `BEGIN IMMEDIATE`. The dangerous window is the last of those three: by then
 * the state, both lineage columns, both log entries and every notice are
 * written and uncommitted. A failure there is what "a full disk, a killed
 * process, an INSERT that throws" means in `src/idempotency.ts`, and if the
 * transaction were not real it is the failure that would leave a revoked version
 * whose retry compiles a SECOND revocation instead of replaying the first.
 */
function breakingIdempotencyInsert<T>(fx: P4Fixture, body: () => T): () => T {
  return () => {
    const real = fx.db.prepare.bind(fx.db);
    (fx.db as any).prepare = (sql: string): Stmt => {
      const st = real(sql);
      if (!sql.includes("INSERT INTO idempotency_keys")) return st;
      return {
        get: (...p: unknown[]) => st.get(...p),
        all: (...p: unknown[]) => st.all(...p),
        run: () => {
          throw new Error("injected: the replay row could not be written");
        },
      };
    };
    try {
      return body();
    } finally {
      (fx.db as any).prepare = real;
    }
  };
}

test("[P1.L9] P1-FR-03 / AC-07: a fault before the idempotency insert leaves NOTHING behind", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "atomic-revoke");
  // an adopter, so the call has a notice to queue and the snapshot has
  // something to be missing
  const requestId = ulid(NOW);
  fx.db
    .prepare(
      `INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, requester_context_json,
         state, attempt_count, next_attempt_at_ms, webhook_id, notification_kind, created_at_ms)
       VALUES (?,?,?,NULL,'pushed',0,?,NULL,'adoption',?)`,
    )
    .run(requestId, predecessor.versionId, fx.member.agent_id, NOW, NOW);
  fx.db
    .prepare(
      `INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms)
       VALUES (?,?,?,?,?)`,
    )
    .run(ulid(NOW), requestId, predecessor.versionId, fx.member.agent_id, NOW);

  const ids = [predecessor.versionId, successor.versionId];
  const before = fullSnapshot(fx, ids);

  let threw: unknown;
  try {
    breakingIdempotencyInsert(fx, () =>
      fx.registry.revokeVersion(
        fx.owner,
        predecessor.versionId,
        { reason: "leaks a token", successor_version_id: successor.versionId },
        "the-key-that-never-landed",
      ),
    )();
    assert.fail("the injected fault did not reach the caller");
  } catch (e) {
    threw = e;
  }
  assert.match(String((threw as Error).message), /injected/);

  const after = fullSnapshot(fx, ids);
  assert.equal(after, before, "the failed revocation left a partial write behind");
  // …and each half of that, named, so a failure here says WHICH one leaked
  assert.equal(row(fx, predecessor.versionId).state, "published", "the state moved");
  assert.equal(row(fx, predecessor.versionId).revocation_reason, null, "the reason was written");
  assert.equal(row(fx, predecessor.versionId).superseded_by_version_id, null, "the lineage column was written");
  assert.equal(row(fx, successor.versionId).supersedes_version_id, null, "the successor's half was written");
  assert.deepEqual(tlogOf(fx, predecessor.versionId).map((e) => e.event_kind).filter((k) => k === TLOG_REVOKED), []);
  assert.deepEqual(tlogOf(fx, predecessor.versionId).map((e) => e.event_kind).filter((k) => k === TLOG_SUPERSEDED), []);
  assert.equal(noticeCount(fx, predecessor.versionId), 0, "a notice was queued for a revocation that did not happen");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE surface='skill.revoke'").get() as { c: number }).c,
    0,
  );
  assert.equal(verifyTlog(fx.db).ok, true, "the chain did not survive the rollback");

  // THE RETRY IS THE POINT. The key was never consumed, so the same key with the
  // same payload now performs the revocation rather than replaying an answer to
  // a call that did not happen.
  const retry = fx.registry.revokeVersion(
    fx.owner,
    predecessor.versionId,
    { reason: "leaks a token", successor_version_id: successor.versionId },
    "the-key-that-never-landed",
  );
  assert.equal(retry.replayed, false);
  assert.equal(retry.response.state, "revoked");
  assert.equal(retry.response.superseded_by, successor.versionId);
  fx.db.close();
});

test("[P1.L10] the same fault on surface 10 also leaves nothing behind", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "atomic-supersede");
  const ids = [predecessor.versionId, successor.versionId];
  const before = fullSnapshot(fx, ids);

  assert.throws(
    breakingIdempotencyInsert(fx, () =>
      fx.registry.supersedeVersion(
        fx.owner,
        predecessor.versionId,
        { successor_version_id: successor.versionId },
        "supersede-key",
      ),
    ),
    /injected/,
  );
  assert.equal(fullSnapshot(fx, ids), before);
  assert.equal(row(fx, predecessor.versionId).state, "published");
  assert.equal(row(fx, successor.versionId).supersedes_version_id, null);
  fx.db.close();
});

// ===========================================================================
// G-P1-6 — idempotency: replay, digest conflict, legacy rows, no nesting
// ===========================================================================

test("[P1.L11] same key + same digest replays byte-identically and runs nothing", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "replay");

  const first = fx.registry.revokeVersion(
    fx.owner,
    predecessor.versionId,
    { reason: "leaks a token", successor_version_id: successor.versionId },
    "k1",
  );
  assert.equal(first.replayed, false);
  const logAfter = tlogOf(fx, predecessor.versionId).length;
  const notices = noticeCount(fx, predecessor.versionId);

  const replay = fx.registry.revokeVersion(
    fx.owner,
    predecessor.versionId,
    { reason: "leaks a token", successor_version_id: successor.versionId },
    "k1",
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.responseJson, first.responseJson, "the replay is not the stored bytes of the original");
  assert.equal(tlogOf(fx, predecessor.versionId).length, logAfter, "the replay appended to the log");
  assert.equal(noticeCount(fx, predecessor.versionId), notices, "the replay queued a notice");
  fx.db.close();
});

test("[P1.L12] same key + a different digest is CONFLICT, raised before any domain mutation", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "digest-conflict");
  const victim = publishedVersion(fx, "digest-conflict-victim");

  fx.registry.revokeVersion(fx.owner, predecessor.versionId, { reason: "leaks a token" }, "k2");
  const before = fullSnapshot(fx, [predecessor.versionId, successor.versionId, victim.versionId]);

  // the same key, a different reason
  rejects(
    () => fx.registry.revokeVersion(fx.owner, predecessor.versionId, { reason: "another reason" }, "k2"),
    "CONFLICT",
    /different payload/,
  );
  // the same key, the same reason, a successor the first call did not name
  rejects(
    () =>
      fx.registry.revokeVersion(
        fx.owner,
        predecessor.versionId,
        { reason: "leaks a token", successor_version_id: successor.versionId },
        "k2",
      ),
    "CONFLICT",
    /different payload/,
  );
  // the same key pointed at a DIFFERENT VERSION: the digest covers the subject,
  // so this is a different request and is refused rather than replayed — and
  // the version it named is untouched, which is what "before any domain
  // mutation" has to mean.
  rejects(
    () => fx.registry.revokeVersion(fx.owner, victim.versionId, { reason: "leaks a token" }, "k2"),
    "CONFLICT",
    /different payload/,
  );
  assert.equal(
    fullSnapshot(fx, [predecessor.versionId, successor.versionId, victim.versionId]),
    before,
    "a digest conflict mutated something",
  );
  assert.equal(row(fx, victim.versionId).state, "published");
  fx.db.close();
});

test("[P1.L13] an ABSENT successor and an explicit null are one request, and one key", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "absent-is-null");
  assert.equal(
    revokeRequestDigest({ version_id: v.versionId, reason: "r" }),
    revokeRequestDigest({ version_id: v.versionId, reason: "r", successor_version_id: null }),
  );
  const first = fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "r" }, "k3");
  const second = fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "r", successor_version_id: null }, "k3");
  assert.equal(second.replayed, true);
  assert.equal(second.responseJson, first.responseJson);
  fx.db.close();
});

test("[P1.L14] a legacy v1.0 idempotency row carrying no digest keeps v1.0 replay behaviour", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "legacy-row");

  // A row exactly as a v1.0.0 build wrote it: in `idempotency_keys`, with NO
  // partner row in `idempotency_request_digests`, because that table did not
  // exist when it was written.
  const legacyBody = JSON.stringify({ skill_version_id: v.versionId, state: "revoked", reason: "written by v1.0.0" });
  fx.db
    .prepare(
      "INSERT INTO idempotency_keys(id, actor_agent_id, surface, key, response_json, created_at_ms) VALUES (?,?,?,?,?,?)",
    )
    .run(ulid(NOW), fx.owner.agent_id, "skill.revoke", "legacy-key", legacyBody, NOW);
  assert.equal(
    (
      fx.db.prepare("SELECT COUNT(*) AS c FROM idempotency_request_digests").get() as { c: number }
    ).c,
    0,
    "the fixture is not a legacy row if it carries a digest",
  );

  // NULL means "recorded before payloads were fingerprinted", never "the
  // payload was empty". Reading it as a mismatch would turn every pre-existing
  // key of a released deployment into a `409` on its first retry.
  const out = fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "anything at all" }, "legacy-key");
  assert.equal(out.replayed, true);
  assert.equal(out.responseJson, legacyBody);
  assert.equal(row(fx, v.versionId).state, "published", "the legacy replay ran the handler");
  fx.db.close();
});

test("[P1.L15] the lifecycle writers open no transaction of their own — one outer BEGIN IMMEDIATE", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "one-begin");

  const seen: string[] = [];
  const realExec = fx.db.exec.bind(fx.db);
  (fx.db as any).exec = (sql: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) seen.push(sql.trim().toUpperCase());
    return realExec(sql);
  };
  try {
    fx.registry.revokeVersion(
      fx.owner,
      predecessor.versionId,
      { reason: "leaks a token", successor_version_id: successor.versionId },
      "one-begin-key",
    );
  } finally {
    (fx.db as any).exec = realExec;
  }
  // ONE `BEGIN IMMEDIATE` and one `COMMIT`. A nested `BEGIN` is not merely
  // redundant in SQLite — it throws, and a writer that opened its own would have
  // to be called OUTSIDE the wrapper, which is the arrangement `[P1.L9]` shows
  // loses the domain write on a fault.
  assert.deepEqual(seen, ["BEGIN IMMEDIATE", "COMMIT"]);
  fx.db.close();
});

test("[P1.L16] a refused revoke consumes no key, so the corrected call may reuse it", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "unconsumed-key");
  // refused by ACL — a reviewer may not revoke
  rejects(() => fx.registry.revokeVersion(fx.reviewer, v.versionId, { reason: "not my call" }, "k4"), "FORBIDDEN");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE key='k4'").get() as { c: number }).c,
    0,
    "a failed call consumed the key, so the retry can never succeed",
  );
  const ok = fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "policy" }, "k4");
  assert.equal(ok.replayed, false);
  assert.equal(ok.response.state, "revoked");
  fx.db.close();
});
