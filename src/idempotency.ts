// §3 / §6 generalized idempotency (defect #4 fix). Every mutating surface
// accepts an optional idempotency_key (string ≤128); the original successful
// response is persisted in idempotency_keys keyed (actor, surface, key), and a
// duplicate replays it byte-identically with no side effect.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { correlationDigest } from "./journal.ts";
import { assertIdentityText, isRefusedText } from "./outcome.ts";
import { ulid } from "./ulid.ts";

/**
 * THE SURFACES WHOSE STORED KEY IS A DIGEST OF THE CALLER'S, NOT THE CALLER'S
 * OWN TEXT.
 *
 * `P1-R2-001`. `POST /v1/captures` carries the one thing this phase promises to
 * remove: a workflow somebody pasted out of a terminal, credentials and all.
 * `src/redaction.ts` runs on the body, the title and the reference — and the
 * `idempotency_key` travelled beside them into `idempotency_keys.key`
 * VERBATIM, so a caller who put a token in the key made it durable registry
 * data on the very surface whose contract is that no raw secret is persisted
 * (`P1-FR-08`, threat model T-02).
 *
 * REDACTING THE KEY IS NOT AVAILABLE, and that is the whole difficulty: the key
 * IS the lookup index. A cleaned key would no longer equal the key the retry
 * sends, and the replay convergence the surface advertises would be gone. So
 * the key is replaced by its DIGEST — `correlationDigest`, the primitive this
 * tree already applies to `receipt_events.idempotency_key` and
 * `observed_records.call_id` for exactly this reason: equality survives a hash
 * exactly, and the string does not survive at all.
 *
 * WHY A SET OF SURFACES RATHER THAN A MIGRATION AND A DUAL READ. Both P1
 * surfaces are NEW in this phase. No released build has a `capture.submit` or a
 * `draft.revise` row, because no released build has those surfaces, and
 * `UNIQUE(actor_agent_id, surface, key)` puts each surface in its own
 * comparison domain — a raw key stored by `skill.adopt` cannot be mistaken for
 * a digest stored here. So on these two surfaces EVERY row is a digest, with
 * nothing deciding which: the unconditional rule `migrations/0012` had to
 * arrive at, reached here without a migration because there is no earlier row
 * to convert. Nothing of the released schema or its data changes.
 *
 * WHAT THIS DOES NOT COVER, NAMED RATHER THAN LEFT TO BE FOUND. The other
 * twenty-three surfaces still store the caller's own key, as
 * `src/identity.ts` records and as every build since `0001` has. That is
 * unchanged P0-era behaviour on surfaces that carry no capture content, and
 * changing it is a conversion of rows a released build wrote — a migration with
 * a dual read, which is a different change from this one and is not what
 * `P1-FR-08` asks for.
 */
export const DIGESTED_KEY_SURFACES: ReadonlySet<string> = new Set(["capture.submit", "draft.revise"]);

/** What `idempotency_keys.key` holds for a surface: the caller's key, or the
 *  digest of it. Decided by the SURFACE — a constant of this repository at
 *  every call site — and never by the form of the value, which is the rule
 *  `migrations/0012` had to withdraw. */
export function storedKeyFor(surface: string, key: string): string {
  return DIGESTED_KEY_SURFACES.has(surface) ? correlationDigest(key) : key;
}

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
  // A KEY THIS PROCESS CANNOT KEY BY. On every surface but the two in
  // `DIGESTED_KEY_SURFACES` the column holds the key ITSELF rather than a
  // digest of it — so the question is not "can this be reduced to bytes" but
  // "does this survive being stored and read again", which is
  // `assertIdentityText`. `idempotency_keys.key` is an identity column of
  // `src/identity.ts` and this is the boundary that entry names. The check runs
  // on the CALLER'S string on every surface, digested or not: the 1..128 bound
  // is a statement about what a caller may send, and a digest is 71 characters
  // whatever went into it, so validating after hashing would validate nothing.
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
  const stored = storedKeyFor(surface, key);
  const lookup = db.prepare(
    "SELECT response_json FROM idempotency_keys WHERE actor_agent_id=? AND surface=? AND key=?",
  );
  const existing = lookup.get(actorAgentId, surface, stored) as { response_json: string } | undefined;
  if (existing) {
    return { replayed: true, response: JSON.parse(existing.response_json) as T, responseJson: existing.response_json };
  }
  const response = fn();
  const responseJson = JSON.stringify(response);
  try {
    insertReplayRow(db, actorAgentId, surface, stored, responseJson, nowMs);
  } catch (e: any) {
    if (!String(e.message ?? e).includes("UNIQUE")) throw e;
    // Multi-process insert race: another process persisted first. Converge on
    // the winner's stored response rather than surfacing an error.
    const winner = lookup.get(actorAgentId, surface, stored) as { response_json: string } | undefined;
    if (winner) {
      return { replayed: true, response: JSON.parse(winner.response_json) as T, responseJson: winner.response_json };
    }
    throw e;
  }
  return { replayed: false, response, responseJson };
}

function insertReplayRow(
  db: Db,
  actorAgentId: string,
  surface: string,
  stored: string,
  responseJson: string,
  nowMs: number,
): void {
  db.prepare(
    "INSERT INTO idempotency_keys(id, actor_agent_id, surface, key, response_json, created_at_ms) VALUES (?,?,?,?,?,?)",
  ).run(ulid(nowMs), actorAgentId, surface, stored, responseJson, nowMs);
}

/**
 * The same rule, with the DOMAIN WRITE AND THE REPLAY ROW IN ONE TRANSACTION.
 *
 * `P1-R2-003`. `withIdempotency` above calls a handler that commits its own
 * transaction and only afterwards inserts the replay row. A failure between
 * those two — a full disk, a killed process, an `INSERT` that throws — leaves
 * the capture, its revision and its three audit events committed with NO
 * idempotency row, and the retry that the key exists for then compiles a SECOND
 * lineage instead of replaying the first. The surface advertises convergence
 * and delivered divergence.
 *
 * So the transaction is OPENED HERE and the handler runs inside it: `fnInTx`
 * must not open one of its own (SQLite has no nested `BEGIN`), which is why the
 * capture domain exposes `captureDraftInTx` / `reviseDraftInTx` beside the
 * self-transacting forms the rest of the tree calls. Either both rows commit or
 * neither does.
 *
 * THE MULTI-PROCESS RACE STILL CONVERGES, and it converges more strictly than
 * before: the losing process's UNIQUE failure now rolls back its own domain
 * write as well, so the second process leaves no orphan lineage behind before
 * replaying the winner's stored response.
 */
export function withIdempotencyInTx<T>(
  db: Db,
  actorAgentId: string,
  surface: string,
  key: string | undefined,
  nowMs: number,
  fnInTx: () => T,
): IdempotentOutcome<T> {
  const lookup = db.prepare(
    "SELECT response_json FROM idempotency_keys WHERE actor_agent_id=? AND surface=? AND key=?",
  );
  let stored: string | undefined;
  if (key !== undefined) {
    validateIdempotencyKey(key);
    stored = storedKeyFor(surface, key);
    const existing = lookup.get(actorAgentId, surface, stored) as { response_json: string } | undefined;
    if (existing) {
      return { replayed: true, response: JSON.parse(existing.response_json) as T, responseJson: existing.response_json };
    }
  }

  db.exec("BEGIN IMMEDIATE");
  let response: T;
  let responseJson: string;
  try {
    response = fnInTx();
    responseJson = JSON.stringify(response);
    if (stored !== undefined) insertReplayRow(db, actorAgentId, surface, stored, responseJson, nowMs);
    db.exec("COMMIT");
  } catch (e: any) {
    db.exec("ROLLBACK");
    if (stored === undefined || !String(e.message ?? e).includes("UNIQUE")) throw e;
    const winner = lookup.get(actorAgentId, surface, stored) as { response_json: string } | undefined;
    if (winner) {
      return { replayed: true, response: JSON.parse(winner.response_json) as T, responseJson: winner.response_json };
    }
    throw e;
  }
  return { replayed: false, response, responseJson };
}
