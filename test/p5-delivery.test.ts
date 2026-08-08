// P5 — §5.2 delivery machine: lease CAS under concurrency, reclaim, stale
// complete, exactly five attempts, loud dead letters, and §5.2's endpoint
// selection and endpoint-health rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, reviewedVersion, NOW, type P4Fixture } from "./p4-helpers.ts";
import {
  pollDelivery,
  renewLease,
  completeDelivery,
  failDelivery,
  sweep,
  deadLetters,
  loadRequest,
  selectWebhook,
  markEndpointMissing,
  recordWebhookResult,
  workerId,
  backoffMs,
  LEASE_MS,
  MAX_ATTEMPTS,
  AGE_OUT_MS,
} from "../src/delivery.ts";
import { isApiError } from "../src/errors.ts";
import { ulid } from "../src/ulid.ts";

/**
 * seedGraph() ships one `pending` adoption_request (the P0 probe graph). Park
 * it so each test's own request is the only claimable job — the machine under
 * test is indifferent to it, but the assertions are about one row.
 */
function fixture(): P4Fixture {
  const fx = p4Fixture();
  fx.db.prepare("UPDATE adoption_requests SET state='pushed' WHERE id=?").run(fx.seed.request);
  return fx;
}

function rejects(fn: () => unknown, code: string): any {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (e) {
    if (!isApiError(e)) throw e;
    assert.equal(e.code, code, e.message);
    return e;
  }
}

function request(fx: P4Fixture, versionId: string, opts: { state?: string; createdAt?: number; webhookId?: string | null } = {}): string {
  const id = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, webhook_id, created_at_ms) VALUES (?,?,?,?,0,0,?,?)",
    )
    .run(id, versionId, fx.member.agent_id, opts.state ?? "pending", opts.webhookId ?? null, opts.createdAt ?? NOW);
  return id;
}

function webhook(fx: P4Fixture, agentId: string, status = "active"): string {
  const id = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO webhooks(id, agent_id, url, secret_hash, status, failure_count, updated_at_ms, secret_ref) VALUES (?,?,?,?,?,0,?,?)",
    )
    .run(id, agentId, "https://adopter.example.com/hook", "f".repeat(64), status, NOW, `secretstore://wh/${id}`);
  return id;
}

// ------------------------------------------------------------- the CAS claim

test("two workers racing one job: exactly one wins", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "claim-race");
  const req = request(fx, v.versionId);
  const w1 = workerId(NOW, "host-a", 111);
  const w2 = workerId(NOW, "host-b", 222);
  assert.match(w1, /^worker:host-a:111:[0-9A-HJKMNP-TV-Z]{26}$/, "§5.2 typed worker identity");

  const a = pollDelivery(fx.db, w1, NOW);
  const b = pollDelivery(fx.db, w2, NOW);
  assert.equal(a.length, 1);
  assert.equal(b.length, 0, "the loser claims nothing");
  const row = loadRequest(fx.db, req)!;
  assert.equal(row.state, "leased");
  assert.equal(row.lease_owner, w1);
  assert.equal(row.attempt_count, 1, "the claim counts the attempt");
  fx.db.close();
});

test("only the lease owner may renew, complete or fail; a stale owner is rejected", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "lease-owner");
  const req = request(fx, v.versionId);
  const mine = workerId(NOW, "h", 1);
  const theirs = workerId(NOW, "h", 2);
  pollDelivery(fx.db, mine, NOW);

  assert.equal(renewLease(fx.db, req, theirs, NOW), false);
  assert.equal(renewLease(fx.db, req, mine, NOW), true);
  rejects(() => completeDelivery(fx.db, req, theirs, NOW), "PRECONDITION_FAILED");
  rejects(() => failDelivery(fx.db, req, theirs, NOW), "PRECONDITION_FAILED");
  assert.equal(loadRequest(fx.db, req)!.state, "leased", "no impostor moved it");

  // and the rightful owner cannot act on an EXPIRED lease either
  const expired = NOW + LEASE_MS * 3;
  assert.equal(renewLease(fx.db, req, mine, expired), false);
  rejects(() => completeDelivery(fx.db, req, mine, expired), "PRECONDITION_FAILED");
  fx.db.close();
});

test("reclaim then re-claim: attempt_count is unchanged by the sweeper, and a stale complete is rejected", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "reclaim");
  const req = request(fx, v.versionId);
  const dead = workerId(NOW, "h", 1);
  const fresh = workerId(NOW, "h", 2);
  pollDelivery(fx.db, dead, NOW);
  assert.equal(loadRequest(fx.db, req)!.attempt_count, 1);

  const later = NOW + LEASE_MS + 1;
  const swept = sweep(fx.db, later);
  assert.deepEqual(swept.reclaimed, [req]);
  const back = loadRequest(fx.db, req)!;
  assert.equal(back.state, "pending");
  assert.equal(back.attempt_count, 1, "the sweeper does not consume an attempt");
  assert.equal(back.lease_owner, null);

  const claimed = pollDelivery(fx.db, fresh, later);
  assert.equal(claimed.length, 1);
  assert.equal(loadRequest(fx.db, req)!.attempt_count, 2);
  // the worker that died still thinks it owns the lease
  rejects(() => completeDelivery(fx.db, req, dead, later), "PRECONDITION_FAILED");
  completeDelivery(fx.db, req, fresh, later);
  assert.equal(loadRequest(fx.db, req)!.state, "pushed");
  fx.db.close();
});

test("exactly five attempts, then dead_letter(max_attempts) — with the §5.2 backoff", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "five-attempts");
  const req = request(fx, v.versionId);
  const w = workerId(NOW, "h", 1);
  let clock = NOW;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const claimed = pollDelivery(fx.db, w, clock);
    assert.equal(claimed.length, 1, `attempt ${attempt} claimable`);
    assert.equal(loadRequest(fx.db, req)!.attempt_count, attempt);
    const out = failDelivery(fx.db, req, w, clock);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(out.state, "pending");
      const row = loadRequest(fx.db, req)!;
      assert.equal(row.next_attempt_at_ms, clock + backoffMs(attempt), "min(2^attempt·1s, 60s)");
      clock = row.next_attempt_at_ms;
    } else {
      assert.deepEqual(out, { state: "dead_letter", reason: "max_attempts" });
    }
  }
  const final = loadRequest(fx.db, req)!;
  assert.equal(final.state, "dead_letter");
  assert.equal(final.attempt_count, MAX_ATTEMPTS);
  assert.equal(pollDelivery(fx.db, w, clock + 1_000_000).length, 0, "a dead letter is never claimed again");
  assert.deepEqual(backoffMs(10), 60_000, "backoff is capped at 60s");
  fx.db.close();
});

test("`pushed` and `dead_letter` are strictly terminal — no sweeper or webhook status leaves them", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "terminal-states");
  const wh = webhook(fx, fx.member.agent_id);
  const pushed = request(fx, v.versionId, { webhookId: wh });
  const w = workerId(NOW, "h", 1);
  pollDelivery(fx.db, w, NOW);
  completeDelivery(fx.db, pushed, w, NOW);

  const dl = request(fx, v.versionId, { state: "dead_letter" });
  fx.db.prepare("UPDATE adoption_requests SET dead_letter_reason='max_attempts' WHERE id=?").run(dl);

  // an endpoint that later dies must not disturb either terminal row
  fx.db.prepare("UPDATE webhooks SET status='dead' WHERE id=?").run(wh);
  const swept = sweep(fx.db, NOW + AGE_OUT_MS * 5);
  assert.equal(swept.endpoint_dead.includes(pushed), false);
  assert.equal(swept.aged_out.includes(pushed), false);
  assert.equal(loadRequest(fx.db, pushed)!.state, "pushed");
  assert.equal(loadRequest(fx.db, dl)!.dead_letter_reason, "max_attempts", "the original reason is not overwritten");
  fx.db.close();
});

test("the sweeper ages out an old request and dead-letters a dead endpoint — loudly", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "sweeper");
  const old = request(fx, v.versionId, { createdAt: NOW - AGE_OUT_MS - 1 });
  const wh = webhook(fx, fx.member.agent_id, "dead");
  const deadEndpoint = request(fx, v.versionId, { webhookId: wh });

  const out = sweep(fx.db, NOW);
  assert.deepEqual(out.aged_out, [old]);
  assert.deepEqual(out.endpoint_dead, [deadEndpoint]);
  assert.equal(loadRequest(fx.db, old)!.dead_letter_reason, "stale_lease");
  assert.equal(loadRequest(fx.db, deadEndpoint)!.dead_letter_reason, "endpoint_dead");

  const letters = deadLetters(fx.db);
  assert.equal(letters.length, 2, "dead letters are surfaced, not silently ignored");
  assert.deepEqual(letters.map((l) => l.reason).sort(), ["endpoint_dead", "stale_lease"]);
  fx.db.close();
});

test("§5.2 hold: an approval_pending request is invisible to the worker and untouched by the sweeper", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "held-request");
  const held = request(fx, v.versionId, { state: "approval_pending", createdAt: NOW - AGE_OUT_MS - 1 });
  assert.equal(pollDelivery(fx.db, workerId(NOW, "h", 1), NOW).length, 0, "no worker may claim a held request");
  const out = sweep(fx.db, NOW);
  assert.equal(out.aged_out.length, 0, "a hold is not a delivery failure and must not age out");
  assert.equal(loadRequest(fx.db, held)!.state, "approval_pending");
  fx.db.close();
});

// -------------------------------------------------- §5.2 webhook handling

test("§5.2: at most one endpoint is selected, and none at all is dead_letter(endpoint_missing)", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "endpoint-selection");
  assert.equal(selectWebhook(fx.db, fx.member.agent_id), null, "no endpoint registered");
  const req = request(fx, v.versionId);
  const w = workerId(NOW, "h", 1);
  pollDelivery(fx.db, w, NOW);
  markEndpointMissing(fx.db, req, w, NOW);
  assert.equal(loadRequest(fx.db, req)!.dead_letter_reason, "endpoint_missing");

  const wh = webhook(fx, fx.member.agent_id);
  assert.equal(selectWebhook(fx.db, fx.member.agent_id), wh);
  webhook(fx, fx.member.agent_id, "dead");
  assert.equal(selectWebhook(fx.db, fx.member.agent_id), wh, "a dead endpoint is never selected");
  fx.db.close();
});

test("§5.2 endpoint health: failing on each miss, dead on the fifth, active again on a 2xx", () => {
  const fx = fixture();
  const wh = webhook(fx, fx.member.agent_id);
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    assert.equal(recordWebhookResult(fx.db, wh, false, NOW, `timeout ${i}`), "failing", `failure ${i}`);
  }
  assert.equal(recordWebhookResult(fx.db, wh, false, NOW, "timeout 5"), "dead", "the fifth consecutive failure");
  assert.equal((fx.db.prepare("SELECT failure_count FROM webhooks WHERE id=?").get(wh) as any).failure_count, MAX_ATTEMPTS);

  // `dead` is terminal (verdict 1, blocking #2), so the recovery rule is
  // exercised on a still-live endpoint
  const live = webhook(fx, fx.author.agent_id);
  recordWebhookResult(fx.db, live, false, NOW);
  assert.equal(recordWebhookResult(fx.db, live, true, NOW), "active");
  const wh2 = live;
  const row = fx.db.prepare("SELECT status, failure_count, last_error FROM webhooks WHERE id=?").get(wh2) as any;
  assert.equal(row.failure_count, 0);
  assert.equal(row.last_error, null);

  // "consecutive" really means consecutive
  recordWebhookResult(fx.db, wh2, false, NOW);
  recordWebhookResult(fx.db, wh2, true, NOW);
  recordWebhookResult(fx.db, wh2, false, NOW);
  assert.equal((fx.db.prepare("SELECT status FROM webhooks WHERE id=?").get(wh2) as any).status, "failing");
  fx.db.close();
});

// P5 verdict 1, blocking #1 — the reviewer's exact reproduction.
test("a worker whose lease was reclaimed cannot dead-letter the job another worker now holds", () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "stale-endpoint-missing");
  const req = request(fx, v.versionId);
  const stale = workerId(NOW, "h", 1);
  const live = workerId(NOW, "h", 2);

  pollDelivery(fx.db, stale, NOW);              // A claims
  const later = NOW + LEASE_MS + 1;
  sweep(fx.db, later);                          // A's lease expires and is reclaimed
  pollDelivery(fx.db, live, later);             // B claims legitimately
  assert.equal(loadRequest(fx.db, req)!.lease_owner, live);

  // A wakes up and tries to finish its work: every transition it attempts must
  // be refused, endpoint_missing included
  rejects(() => markEndpointMissing(fx.db, req, stale, later), "PRECONDITION_FAILED");
  rejects(() => completeDelivery(fx.db, req, stale, later), "PRECONDITION_FAILED");
  rejects(() => failDelivery(fx.db, req, stale, later), "PRECONDITION_FAILED");

  const row = loadRequest(fx.db, req)!;
  assert.equal(row.state, "leased", "B's job is untouched");
  assert.equal(row.lease_owner, live);
  assert.equal(row.dead_letter_reason, null);

  // and B, the live owner, still can
  markEndpointMissing(fx.db, req, live, later);
  assert.equal(loadRequest(fx.db, req)!.dead_letter_reason, "endpoint_missing");
  fx.db.close();
});

// P5 verdict 1, blocking #2 — a retired or exhausted endpoint stays dead.
test("§5.2: `dead` is terminal — a late 2xx never resurrects a retired or exhausted endpoint", () => {
  const fx = fixture();
  const retired = webhook(fx, fx.member.agent_id);
  fx.db.prepare("UPDATE webhooks SET status='dead' WHERE id=?").run(retired); // as registerWebhook retires it
  assert.equal(recordWebhookResult(fx.db, retired, true, NOW), "dead", "an in-flight 2xx does not revive it");
  assert.equal((fx.db.prepare("SELECT status FROM webhooks WHERE id=?").get(retired) as any).status, "dead");

  const exhausted = webhook(fx, fx.reviewer.agent_id);
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) recordWebhookResult(fx.db, exhausted, false, NOW);
  assert.equal((fx.db.prepare("SELECT status FROM webhooks WHERE id=?").get(exhausted) as any).status, "dead");
  assert.equal(recordWebhookResult(fx.db, exhausted, true, NOW), "dead", "nor an endpoint killed by five failures");
  assert.equal((fx.db.prepare("SELECT status, failure_count FROM webhooks WHERE id=?").get(exhausted) as any).failure_count, MAX_ATTEMPTS);

  // …and a still-live endpoint recovers exactly as §5.2's health table says
  const live = webhook(fx, fx.author.agent_id);
  recordWebhookResult(fx.db, live, false, NOW);
  assert.equal(recordWebhookResult(fx.db, live, true, NOW), "active");
  fx.db.close();
});

test("§5.2: the plaintext webhook secret never enters SQLite", () => {
  const fx = fixture();
  const wh = webhook(fx, fx.member.agent_id);
  const row = fx.db.prepare("SELECT secret_hash, secret_ref FROM webhooks WHERE id=?").get(wh) as any;
  assert.equal(row.secret_hash.length, 64, "secret_hash stays a verifier only");
  assert.match(row.secret_ref, /^secretstore:\/\//, "the worker resolves the signing secret through this reference");
  const cols = (fx.db.prepare("PRAGMA table_info(webhooks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols.includes("secret"), "no plaintext-secret column exists at all");
  fx.db.close();
});
