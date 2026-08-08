// §5.2 Adoption delivery machine — built on the transferable wake-machine
// template of the internal code map (agent-wake.ts: CAS-claim / lease /
// backoff / stale), with the spec's divergence that dead letters are LOUD.
//
// This is the internal worker surface (`delivery.poll/renew/complete/fail`),
// service-authenticated and in-process in the single-binary deployment. It is
// NOT one of the thirteen public surfaces and is not reachable from either adapter.
//
// Every state change is a CAS UPDATE whose WHERE clause carries the guard from
// the §5.2 transition table: 0 rows changed = lost race = the caller must
// re-poll, never a silent overwrite. `pushed` and `dead_letter` are strictly
// terminal — no transition, sweeper or webhook-status change ever leaves them,
// which is why every UPDATE below names the source state explicitly.
import { hostname } from "node:os";
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";

export type RequestState = "pending" | "leased" | "pushed" | "dead_letter" | "approval_pending";
export type DeadLetterReason =
  | "max_attempts"
  | "stale_lease"
  | "endpoint_dead"
  | "approval_denied"
  | "endpoint_missing";

export const LEASE_MS = 10_000;
export const MAX_ATTEMPTS = 5;
export const MAX_BACKOFF_MS = 60_000;
/** §5.2 age-out: a request older than this with no push success is dead-lettered. */
export const AGE_OUT_MS = 10 * 60 * 1000;

/** §5.2 worker identity: a typed string, never a bare host or pid. */
export function workerId(nowMs: number, host: string = hostname(), pid: number = process.pid): string {
  return `worker:${host}:${pid}:${ulid(nowMs)}`;
}

/** §5.2 backoff: `now + min(2^attempt·1s, 60s)`. */
export function backoffMs(attemptCount: number): number {
  return Math.min(2 ** attemptCount * 1000, MAX_BACKOFF_MS);
}

/**
 * What a queued row is a notification ABOUT. `adoption` is a request an adopter
 * made (surface 6); `revocation` is a notice the registry queued because a
 * version the adopter is running was revoked (surface 11). Same machine, same
 * lease/backoff/dead-letter rules, different message — and only the first kind
 * is something `skill.adopt` will act on.
 */
export type NotificationKind = "adoption" | "revocation";

export interface RequestRow {
  id: string;
  skill_version_id: string;
  adopter_agent_id: string;
  notification_kind: NotificationKind;
  state: RequestState;
  dead_letter_reason: DeadLetterReason | null;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  attempt_count: number;
  next_attempt_at_ms: number;
  webhook_id: string | null;
  created_at_ms: number;
}

export function loadRequest(db: Db, id: string): RequestRow | undefined {
  return db.prepare("SELECT * FROM adoption_requests WHERE id=?").get(id) as RequestRow | undefined;
}

// ------------------------------------------------------------------- claim

export interface ClaimedJob {
  request: RequestRow;
  lease_owner: string;
  lease_expires_at_ms: number;
}

/**
 * `delivery.poll` — claim up to `limit` due jobs. The CAS predicate includes
 * the OBSERVED `attempt_count`, so two workers racing on one row produce
 * exactly one winner (D.1 gives no row lock; the predicate is the lock).
 *
 * `approval_pending` is not `pending`: a request awaiting a §7.3 human approval
 * is invisible to this query and can never be claimed (§5.2, "`approval_pending`
 * is a hold, not a delivery state").
 */
export function pollDelivery(db: Db, worker: string, nowMs: number, limit = 10): ClaimedJob[] {
  const due = db
    .prepare(
      `SELECT * FROM adoption_requests
        WHERE state='pending' AND next_attempt_at_ms <= ?
        ORDER BY next_attempt_at_ms, id LIMIT ?`,
    )
    .all(nowMs, limit) as RequestRow[];

  const claimed: ClaimedJob[] = [];
  for (const row of due) {
    const expires = nowMs + LEASE_MS;
    const res = db
      .prepare(
        `UPDATE adoption_requests
            SET state='leased', lease_owner=?, lease_expires_at_ms=?, attempt_count=attempt_count+1
          WHERE id=? AND state='pending' AND next_attempt_at_ms<=? AND attempt_count=?`,
      )
      .run(worker, expires, row.id, nowMs, row.attempt_count);
    if (res.changes !== 1) continue; // lost race — another worker won this row
    claimed.push({
      request: { ...row, state: "leased", lease_owner: worker, lease_expires_at_ms: expires, attempt_count: row.attempt_count + 1 },
      lease_owner: worker,
      lease_expires_at_ms: expires,
    });
  }
  return claimed;
}

/** `delivery.renew` — extend a live lease held by this worker (+10s). */
export function renewLease(db: Db, requestId: string, worker: string, nowMs: number): boolean {
  const res = db
    .prepare(
      `UPDATE adoption_requests SET lease_expires_at_ms=?
        WHERE id=? AND state='leased' AND lease_owner=? AND lease_expires_at_ms>?`,
    )
    .run(nowMs + LEASE_MS, requestId, worker, nowMs);
  return res.changes === 1;
}

/**
 * `delivery.complete` — webhook 2xx. Terminal state is `pushed`, deliberately
 * NOT `delivered`: a 2xx proves the endpoint answered, not that the adopter's
 * runtime holds the package (§5.2). The receipt event `delivered` is written
 * only by the adopter's own `skill.adopt` call.
 *
 * A stale complete from an expired lease owner is rejected — the lease
 * predicate is part of the CAS.
 */
export function completeDelivery(db: Db, requestId: string, worker: string, nowMs: number): void {
  const res = db
    .prepare(
      `UPDATE adoption_requests SET state='pushed', lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE id=? AND state='leased' AND lease_owner=? AND lease_expires_at_ms>?`,
    )
    .run(requestId, worker, nowMs);
  if (res.changes !== 1) throw lostRace(db, requestId, "complete");
}

/**
 * `delivery.fail` — non-2xx or timeout. §5.2 precedence: the max-attempts check
 * runs BEFORE the stale check, so the fifth failure dead-letters rather than
 * being reclaimed.
 */
export function failDelivery(db: Db, requestId: string, worker: string, nowMs: number): { state: RequestState; reason?: DeadLetterReason } {
  const row = db
    .prepare("SELECT attempt_count FROM adoption_requests WHERE id=? AND state='leased' AND lease_owner=? AND lease_expires_at_ms>?")
    .get(requestId, worker, nowMs) as { attempt_count: number } | undefined;
  if (!row) throw lostRace(db, requestId, "fail");

  if (row.attempt_count >= MAX_ATTEMPTS) {
    const res = db
      .prepare(
        `UPDATE adoption_requests
            SET state='dead_letter', dead_letter_reason='max_attempts', lease_owner=NULL, lease_expires_at_ms=NULL
          WHERE id=? AND state='leased' AND lease_owner=? AND lease_expires_at_ms>?`,
      )
      .run(requestId, worker, nowMs);
    if (res.changes !== 1) throw lostRace(db, requestId, "fail");
    return { state: "dead_letter", reason: "max_attempts" };
  }
  const res = db
    .prepare(
      `UPDATE adoption_requests
          SET state='pending', lease_owner=NULL, lease_expires_at_ms=NULL, next_attempt_at_ms=?
        WHERE id=? AND state='leased' AND lease_owner=? AND lease_expires_at_ms>?`,
    )
    .run(nowMs + backoffMs(row.attempt_count), requestId, worker, nowMs);
  if (res.changes !== 1) throw lostRace(db, requestId, "fail");
  return { state: "pending" };
}

function lostRace(db: Db, requestId: string, op: string): ApiError {
  const row = loadRequest(db, requestId);
  if (!row) return new ApiError("NOT_FOUND", "adoption request not found");
  // converging conflict (§6): the caller learns the CURRENT state and re-polls
  return new ApiError("PRECONDITION_FAILED", `delivery.${op} rejected: the lease is not held by this worker`, row.state);
}

// ----------------------------------------------------------------- sweeper

export interface SweepResult {
  reclaimed: string[];
  aged_out: string[];
  endpoint_dead: string[];
}

/**
 * The sweeper, in §5.2's precedence order.
 *
 * 1. **reclaim** an expired lease → `pending`, `attempt_count` UNCHANGED (the
 *    attempt was made; the worker merely died holding it).
 * 2. **age-out** a request older than 10 minutes with no push success →
 *    `dead_letter(stale_lease)`.
 * 3. **endpoint dead** → `dead_letter(endpoint_dead)`, and ONLY from
 *    `pending`/`leased`: the webhook-dead row of the table explicitly excludes
 *    `pushed`, which is terminal (this is the R2 conflict the spec resolved).
 *
 * `approval_pending` is untouched by all three: it is not a delivery state, it
 * is a hold (§5.2), and a hold must not age out into a delivery failure.
 */
export function sweep(db: Db, nowMs: number): SweepResult {
  const out: SweepResult = { reclaimed: [], aged_out: [], endpoint_dead: [] };

  const expired = db
    .prepare("SELECT id FROM adoption_requests WHERE state='leased' AND lease_expires_at_ms < ?")
    .all(nowMs) as Array<{ id: string }>;
  for (const { id } of expired) {
    const res = db
      .prepare(
        `UPDATE adoption_requests SET state='pending', lease_owner=NULL, lease_expires_at_ms=NULL
          WHERE id=? AND state='leased' AND lease_expires_at_ms < ?`,
      )
      .run(id, nowMs);
    if (res.changes === 1) out.reclaimed.push(id);
  }

  const old = db
    .prepare(
      `SELECT id FROM adoption_requests
        WHERE state IN ('pending','leased') AND ? - created_at_ms > ?`,
    )
    .all(nowMs, AGE_OUT_MS) as Array<{ id: string }>;
  for (const { id } of old) {
    const res = db
      .prepare(
        `UPDATE adoption_requests
            SET state='dead_letter', dead_letter_reason='stale_lease', lease_owner=NULL, lease_expires_at_ms=NULL
          WHERE id=? AND state IN ('pending','leased')`,
      )
      .run(id);
    if (res.changes === 1) out.aged_out.push(id);
  }

  const dead = db
    .prepare(
      `SELECT r.id FROM adoption_requests r JOIN webhooks w ON w.id = r.webhook_id
        WHERE r.state IN ('pending','leased') AND w.status='dead'`,
    )
    .all() as Array<{ id: string }>;
  for (const { id } of dead) {
    const res = db
      .prepare(
        `UPDATE adoption_requests
            SET state='dead_letter', dead_letter_reason='endpoint_dead', lease_owner=NULL, lease_expires_at_ms=NULL
          WHERE id=? AND state IN ('pending','leased')`,
      )
      .run(id);
    if (res.changes === 1) out.endpoint_dead.push(id);
  }
  return out;
}

/** Dead letters are LOUD (§5.2 divergence from the snapshot's silent ignore). */
export function deadLetters(db: Db): Array<{
  id: string;
  reason: DeadLetterReason;
  adopter_agent_id: string;
  skill_version_id: string;
  notification_kind: NotificationKind;
}> {
  return db
    .prepare(
      `SELECT id, dead_letter_reason AS reason, adopter_agent_id, skill_version_id, notification_kind
         FROM adoption_requests WHERE state='dead_letter' ORDER BY created_at_ms, id`,
    )
    .all() as Array<{
    id: string;
    reason: DeadLetterReason;
    adopter_agent_id: string;
    skill_version_id: string;
    notification_kind: NotificationKind;
  }>;
}

/**
 * Surface 11's "active adopters are notified through the delivery machine".
 *
 * ACTIVE means: this adopter holds a receipt for this version and has not
 * backed out of it — no `failed` and no `rolled_back` event on the chain. An
 * adopter still at `delivered` or `attempted` counts, because the package is
 * already in its hands; one that failed or rolled back has nothing to withdraw.
 * One notice per adopter, however many receipts it holds.
 *
 * The notices are ordinary rows of the §5.2 machine — same claim, lease,
 * backoff, dead-letter and endpoint-health rules — carrying
 * `notification_kind='revocation'`. An adopter with no selected endpoint gets
 * `dead_letter(endpoint_missing)` exactly as an adoption notification would,
 * which is what makes an unreachable adopter LOUD rather than silently skipped.
 *
 * Caller must already hold the transaction: the notices and the `revoked`
 * state change land together or not at all.
 */
export function enqueueRevocationNoticesInTx(
  db: Db,
  versionId: string,
  nowMs: number,
  selectEndpoint: (adopterAgentId: string) => string | null,
): string[] {
  const adopters = db
    .prepare(
      `SELECT DISTINCT r.adopter_agent_id AS adopter
         FROM adoption_receipts r
        WHERE r.skill_version_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM receipt_events e
             WHERE e.adoption_receipt_id = r.id AND e.event IN ('failed','rolled_back'))
        ORDER BY r.adopter_agent_id`,
    )
    .all(versionId) as Array<{ adopter: string }>;

  const insert = db.prepare(
    `INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, requester_context_json,
       state, attempt_count, next_attempt_at_ms, webhook_id, notification_kind, created_at_ms)
     VALUES (?,?,?,NULL,'pending',0,?,?, 'revocation', ?)`,
  );
  const ids: string[] = [];
  for (const { adopter } of adopters) {
    const id = ulid(nowMs);
    insert.run(id, versionId, adopter, nowMs, selectEndpoint(adopter), nowMs);
    ids.push(id);
  }
  return ids;
}

// ------------------------------------------------------- webhook selection

/**
 * §5.2, the webhook-dead row: a `pending`/`leased` request whose selected
 * endpoint is `dead` becomes `dead_letter(endpoint_dead)`. The sweeper covers
 * the rows nobody holds; a WORKER that discovers it mid-push must apply the
 * same row itself, under the live-owner CAS — otherwise a 2xx that lands after
 * the endpoint died completes the request to `pushed`, which is terminal and
 * can never converge (P5 verdict 2, blocking B1).
 */
export function markEndpointDead(db: Db, requestId: string, worker: string, nowMs: number): void {
  const res = db
    .prepare(
      `UPDATE adoption_requests SET state='dead_letter', dead_letter_reason='endpoint_dead',
              lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE id=? AND state='leased' AND lease_owner=? AND lease_expires_at_ms>?`,
    )
    .run(requestId, worker, nowMs);
  if (res.changes !== 1) throw lostRace(db, requestId, "endpoint_dead");
}

/**
 * §5.2 endpoint selection: AT MOST ONE endpoint per adopter, chosen from those
 * whose status is `active` or `failing` and snapshotted onto the request at
 * creation. No selected endpoint is not a silent no-op — it is
 * `dead_letter(endpoint_missing)`.
 */
export function selectWebhook(db: Db, adopterAgentId: string): string | null {
  const row = db
    .prepare("SELECT id FROM webhooks WHERE agent_id=? AND status IN ('active','failing') ORDER BY updated_at_ms DESC, id LIMIT 1")
    .get(adopterAgentId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Dead-letter a claimed job whose endpoint does not exist.
 *
 * P5 verdict 1, blocking #1: this MUST carry the same live-owner CAS predicate
 * every other worker-driven transition carries. Without it a worker whose lease
 * had already expired and been reclaimed could dead-letter the request another
 * worker now legitimately holds. Every transition a worker causes is guarded by
 * "this lease, still live, still mine".
 */
export function markEndpointMissing(db: Db, requestId: string, worker: string, nowMs: number): void {
  const res = db
    .prepare(
      `UPDATE adoption_requests SET state='dead_letter', dead_letter_reason='endpoint_missing',
              lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE id=? AND state='leased' AND lease_owner=? AND lease_expires_at_ms>?`,
    )
    .run(requestId, worker, nowMs);
  if (res.changes !== 1) throw lostRace(db, requestId, "endpoint_missing");
}

/**
 * §5.2's endpoint-health table — the COMPLETE V1 rule set: a non-2xx or timeout
 * increments `failure_count` and makes the endpoint `failing`; a 2xx resets the
 * count and returns it to `active`; the fifth CONSECUTIVE failure makes it
 * `dead`. Rotation, fan-out and retry-policy tuning are, by owner decision,
 * outside V1 and deliberately absent.
 */
export function recordWebhookResult(db: Db, webhookId: string, ok: boolean, nowMs: number, error?: string): "active" | "failing" | "dead" {
  const row = db.prepare("SELECT status, failure_count FROM webhooks WHERE id=?").get(webhookId) as
    | { status: "active" | "failing" | "dead"; failure_count: number }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND", "webhook not found");

  // P5 verdict 1, blocking #2: `dead` is TERMINAL. §5.2 gives no path out of
  // it — the fifth consecutive failure kills an endpoint, and registering a
  // replacement retires the old one the same way (V1 selects at most ONE). An
  // in-flight 2xx arriving after either event must not resurrect it, or the
  // deployment would briefly hold two live endpoints for one adopter.
  if (row.status === "dead") return "dead";

  if (ok) {
    db.prepare("UPDATE webhooks SET status='active', failure_count=0, last_error=NULL, updated_at_ms=? WHERE id=? AND status<>'dead'").run(
      nowMs,
      webhookId,
    );
    return "active";
  }
  const count = row.failure_count + 1;
  const status = count >= MAX_ATTEMPTS ? "dead" : "failing";
  db.prepare("UPDATE webhooks SET status=?, failure_count=?, last_error=?, updated_at_ms=? WHERE id=? AND status<>'dead'").run(
    status,
    count,
    error ?? null,
    nowMs,
    webhookId,
  );
  return status;
}
