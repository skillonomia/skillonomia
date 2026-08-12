// §3 / §6 generalized idempotency (defect #4 fix). Every mutating surface
// accepts an optional idempotency_key (string ≤128); the original successful
// response is persisted in idempotency_keys keyed (actor, surface, key), and a
// duplicate replays it byte-identically with no side effect.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { assertIdentityText, isRefusedText } from "./outcome.ts";
import { ulid } from "./ulid.ts";

export interface IdempotentOutcome<T> {
  /** true = this call replayed a persisted response and ran no side effects */
  replayed: boolean;
  response: T;
  /**
   * The exact serialized response. On replay this is the stored bytes of the
   * ORIGINAL call, so an HTTP adapter that writes this string reproduces the
   * original body byte for byte (Appendix H replay rule).
   */
  responseJson: string;
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 128) {
    throw new ApiError("INVALID_SCHEMA", "idempotency_key must be a string of 1..128 characters");
  }
  // A KEY THIS PROCESS CANNOT KEY BY, and the column here holds the key ITSELF
  // rather than a digest of it — so the question is not "can this be reduced to
  // bytes" but "does this survive being stored and read again", which is
  // `assertIdentityText`. `idempotency_keys.key` is an identity column of
  // `src/identity.ts` and this is the boundary that entry names.
  //
  // What it prevents, stated as what each runtime does on the way into SQLite.
  // An UNPAIRED SURROGATE: node encodes it to UTF-8 and replaces the code unit
  // with U+FFFD, so two different keys become one row and the second call — a
  // DIFFERENT request — is answered with the first call's stored response and
  // runs nothing; bun writes the surrogate's raw bytes and reads them back as
  // the empty string, so the key a reader sees is not the key that was sent.
  // U+0000: node reads the column back truncated at it, so a key is not the key
  // it was, and the two runtimes disagree about one request. Neither is a key,
  // and the caller is told so.
  try {
    assertIdentityText(key, "idempotency_key");
  } catch (e) {
    if (!isRefusedText(e)) throw e;
    throw new ApiError(
      "INVALID_SCHEMA",
      `idempotency_key: ${e.message}. A key is stored and compared as sent, so one that does not survive ` +
        "being stored would replay another call's response",
    );
  }
  return key;
}

/**
 * Run `fn` under (actor, surface, key) idempotency. Only SUCCESSFUL responses
 * are persisted: a call that fails leaves the key unconsumed, so the caller
 * may retry the same key and succeed. Handlers are fully synchronous (SQLite
 * is synchronous in both runtimes), so check→execute→persist cannot interleave
 * with another request in this process; the UNIQUE(actor,surface,key)
 * constraint backstops multi-process deployments — a lost insert race
 * converges by replaying the winner's stored response.
 */
export function withIdempotency<T>(
  db: Db,
  actorAgentId: string,
  surface: string,
  key: string | undefined,
  nowMs: number,
  fn: () => T,
): IdempotentOutcome<T> {
  if (key === undefined) {
    const response = fn();
    return { replayed: false, response, responseJson: JSON.stringify(response) };
  }
  validateIdempotencyKey(key);
  const lookup = db.prepare(
    "SELECT response_json FROM idempotency_keys WHERE actor_agent_id=? AND surface=? AND key=?",
  );
  const existing = lookup.get(actorAgentId, surface, key) as { response_json: string } | undefined;
  if (existing) {
    return { replayed: true, response: JSON.parse(existing.response_json) as T, responseJson: existing.response_json };
  }
  const response = fn();
  const responseJson = JSON.stringify(response);
  try {
    db.prepare(
      "INSERT INTO idempotency_keys(id, actor_agent_id, surface, key, response_json, created_at_ms) VALUES (?,?,?,?,?,?)",
    ).run(ulid(nowMs), actorAgentId, surface, key, responseJson, nowMs);
  } catch (e: any) {
    if (!String(e.message ?? e).includes("UNIQUE")) throw e;
    // Multi-process insert race: another process persisted first. Converge on
    // the winner's stored response rather than surfacing an error.
    const winner = lookup.get(actorAgentId, surface, key) as { response_json: string } | undefined;
    if (winner) {
      return { replayed: true, response: JSON.parse(winner.response_json) as T, responseJson: winner.response_json };
    }
    throw e;
  }
  return { replayed: false, response, responseJson };
}
