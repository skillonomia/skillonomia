// P2 foundations: §6/Appendix H error model, §3 idempotency replay,
// per-key token-bucket rate limiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedGraph } from "./helpers.ts";
import { ApiError, HTTP_STATUS, converged, type ErrorCode } from "../src/errors.ts";
import { withIdempotency, validateIdempotencyKey } from "../src/idempotency.ts";
import { RateLimiter } from "../src/ratelimit.ts";

// ---------------------------------------------------------------- error model

const ALL_CODES: ErrorCode[] = [
  "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED",
  "INVALID_SCHEMA", "RATE_LIMITED", "UNKNOWN_KEY", "BAD_SIGNATURE",
  "TAMPERED_CONTENT", "MALFORMED_ARCHIVE", "LIMIT_EXCEEDED",
];

test("every error code has an HTTP status and serializes to the Appendix H envelope", () => {
  for (const code of ALL_CODES) {
    assert.ok(HTTP_STATUS[code] >= 400 && HTTP_STATUS[code] < 500, code);
  }
  const e = new ApiError("FORBIDDEN", "not yours");
  assert.deepEqual(e.toEnvelope(), { error: { code: "FORBIDDEN", message: "FORBIDDEN: not yours" } });
  assert.equal(e.httpStatus, 403);
});

test("PRECONDITION_FAILED and CONFLICT require current_state (converging-conflict rule)", () => {
  assert.throws(() => new ApiError("PRECONDITION_FAILED", "illegal transition"), /current_state/);
  assert.throws(() => new ApiError("CONFLICT", "duplicate"), /current_state/);
  const e = new ApiError("PRECONDITION_FAILED", "illegal transition", "linted");
  assert.equal(e.toEnvelope().error.current_state, "linted");
  const c = new ApiError("CONFLICT", "duplicate semver", "draft");
  assert.equal(c.toEnvelope().error.current_state, "draft");
});

test("converged() carries noop:true + state (defect #1 shape)", () => {
  assert.deepEqual(converged("linted"), { noop: true, state: "linted" });
});

// ---------------------------------------------------------------- idempotency

test("no key: fn runs every time, nothing persisted", () => {
  const { db, adopterA, now } = seedGraph();
  let calls = 0;
  const r1 = withIdempotency(db, adopterA, "skill.create", undefined, now, () => ({ n: ++calls }));
  const r2 = withIdempotency(db, adopterA, "skill.create", undefined, now, () => ({ n: ++calls }));
  assert.equal(r1.replayed, false);
  assert.equal(r2.replayed, false);
  assert.equal(calls, 2);
  const rows = db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get() as { c: number };
  assert.equal(rows.c, 0);
  db.close();
});

test("duplicate (actor,surface,key) replays the stored response byte-identically, no side effect", () => {
  const { db, adopterA, now } = seedGraph();
  let calls = 0;
  const r1 = withIdempotency(db, adopterA, "skill.create", "k-1", now, () => ({ id: "v1", n: ++calls }));
  const r2 = withIdempotency(db, adopterA, "skill.create", "k-1", now, () => ({ id: "v2", n: ++calls }));
  assert.equal(calls, 1, "second call must not run fn");
  assert.equal(r1.replayed, false);
  assert.equal(r2.replayed, true);
  assert.equal(r2.responseJson, r1.responseJson, "replay must be byte-identical");
  assert.deepEqual(r2.response, { id: "v1", n: 1 });
  db.close();
});

test("idempotency is scoped: same key, other actor or other surface, runs fresh", () => {
  const { db, adopterA, adopterB, now } = seedGraph();
  let calls = 0;
  withIdempotency(db, adopterA, "skill.create", "k", now, () => ({ n: ++calls }));
  withIdempotency(db, adopterB, "skill.create", "k", now, () => ({ n: ++calls }));
  withIdempotency(db, adopterA, "skill.lint", "k", now, () => ({ n: ++calls }));
  assert.equal(calls, 3);
  db.close();
});

test("a failed call does not consume the key; the retry can succeed", () => {
  const { db, adopterA, now } = seedGraph();
  assert.throws(
    () =>
      withIdempotency(db, adopterA, "skill.create", "k-f", now, () => {
        throw new ApiError("INVALID_SCHEMA", "bad manifest");
      }),
    /INVALID_SCHEMA/,
  );
  const r = withIdempotency(db, adopterA, "skill.create", "k-f", now, () => ({ ok: true }));
  assert.equal(r.replayed, false);
  assert.deepEqual(r.response, { ok: true });
  db.close();
});

test("idempotency_key must be 1..128 chars", () => {
  assert.throws(() => validateIdempotencyKey(""), /INVALID_SCHEMA/);
  assert.throws(() => validateIdempotencyKey("x".repeat(129)), /INVALID_SCHEMA/);
  assert.throws(() => validateIdempotencyKey(42), /INVALID_SCHEMA/);
  assert.equal(validateIdempotencyKey("x".repeat(128)), "x".repeat(128));
});

// ----------------------------------------------------------------- rate limit

test("token bucket: capacity, then refusal, then refill", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1 });
  const t0 = 1_754_000_000_000;
  assert.equal(limiter.take("key-a", t0), true);
  assert.equal(limiter.take("key-a", t0), true);
  assert.equal(limiter.take("key-a", t0), true);
  assert.equal(limiter.take("key-a", t0), false, "bucket exhausted");
  assert.equal(limiter.take("key-a", t0 + 999), false, "not yet refilled");
  assert.equal(limiter.take("key-a", t0 + 1000), true, "one token refilled");
  assert.equal(limiter.take("key-a", t0 + 1000), false);
});

test("buckets are per key: exhausting one key does not affect another", () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  const t0 = 1_754_000_000_000;
  assert.equal(limiter.take("key-a", t0), true);
  assert.equal(limiter.take("key-a", t0), false);
  assert.equal(limiter.take("key-b", t0), true);
});

test("refill never exceeds capacity", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 10 });
  const t0 = 1_754_000_000_000;
  assert.equal(limiter.take("k", t0), true);
  // an hour later: still only `capacity` tokens available
  assert.equal(limiter.take("k", t0 + 3_600_000), true);
  assert.equal(limiter.take("k", t0 + 3_600_000), true);
  assert.equal(limiter.take("k", t0 + 3_600_000), false);
});
