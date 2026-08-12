// §3 / §6 generalized idempotency (defect #4 fix). Every mutating surface
// accepts an optional idempotency_key (string ≤128); the original successful
// response is persisted in idempotency_keys keyed (actor, surface, key), and a
// duplicate replays it byte-identically with no side effect.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";
import { EVIDENCE_DIGEST } from "./outcome.ts";

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
  return key;
}

/**
 * THE FORM THIS REGISTRY WRITES INTO ITS OWN JOURNALS — `sha256:` and 64
 * lowercase hex.
 *
 * It is `EVIDENCE_DIGEST` itself and not a second spelling of it. Two patterns
 * for one shape would be two answers to one question, and this is the question
 * on which a wrong second answer has already cost a round: the pattern that
 * RECOGNISES a value this registry produced and the pattern that REFUSES a value
 * a caller sent must be the same pattern, or a key could be refused and then not
 * recognised, or recognised and then not refused. The name exists so that a
 * reader at the refusal sees what it is about.
 */
export const STORED_KEY_FORM = EVIDENCE_DIGEST;

/**
 * A KEY OF THE STORED FORM MAY NOT OPEN A RECORD.
 *
 * `receipt_events.idempotency_key` holds `sha256:<hex>` of the caller's key, so
 * a caller's key that IS, letter for letter, of that shape is a string nothing
 * can distinguish from a digest by looking at it. `migrations/0011` tried to and
 * two rows of one receipt collided, leaving an upgrade that could never finish;
 * `0012` removed the guess by hashing everything. This closes the other end: no
 * FURTHER row can be written with a value of that form as its key, so the
 * question stops being askable rather than being answered better.
 *
 * WHAT IS REFUSED AND WHAT IS NOT, exactly. A key of this form is refused when
 * it would create a record. It is NOT refused when it REPEATS one — the lookup
 * runs first, and a repeat writes nothing, introduces no value of any form and
 * is the answer an adopter of an older build was already given. That is the one
 * behaviour a narrowing here would otherwise take away from somebody, and the
 * one it does not need to take: `[12.8]` runs both halves against one key.
 *
 * The refusal is a NARROWING of the accepted alphabet and is classified as one.
 * Every neighbour of the shape — upper-case hex, 63 digits, no prefix, another
 * prefix — is still a perfectly good key, and `[12.7c]` says so with runs.
 */
export function refuseStoredKeyForm(key: string): void {
  if (STORED_KEY_FORM.test(key)) {
    throw new ApiError(
      "INVALID_SCHEMA",
      "idempotency_key may not be of the stored digest form `sha256:<64 lowercase hex>`: that is the form this " +
        "registry writes into its journals, and a key of it could not be told from a digest of one. Choose any " +
        "other string of 1..128 characters. A key of this form that REPEATS a record written before this rule is " +
        "still answered as the repeat it is.",
    );
  }
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
  // Nothing to repeat, so this key is about to become a record: the stored form
  // is refused HERE, after the lookup and before `fn` runs, so that no surface
  // can write one and no repeat of an older one is taken away.
  refuseStoredKeyForm(key);
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
