// Provisioning — the minimal safe path from "an owner exists" to "a principal
// can publish a signed package", over the API and nothing else.
//
// Before this module the only paths into `agents`, `api_keys` and
// `signing_keys` were §9.1's first-start bootstrap (which creates exactly two
// principals and never runs again), `src/seed.ts` (the built-in seed package's
// identity, which holds no API key at all) and direct SQL against the database
// file. §4.4 step 3 resolves a package's `kid`
// against `manifest.author_agent`, so with no way to register a signing key
// through the API there was no way to publish a NEW signed package through the
// API either: every attempt ended at `UNKNOWN_KEY`. The registry was operable
// only by someone with a sqlite3 prompt.
//
// Three operations close that, on both adapters:
//
//   1. an owner/admin creates a principal in their own workspace,
//   2. the principal's API key is issued — shown ONCE, stored only as a hash,
//   3. the principal registers, and revokes, its OWN Ed25519 signing key.
//
// ---------------------------------------------------------------------------
// ACL, derived from §6 rather than chosen
// ---------------------------------------------------------------------------
//
// §6's matrix has no "create a principal" row, exactly as it had no
// `deprecate` row. The closest row is the last one,
// "manage grants/memberships/webhooks", whose columns read: author/skill owner
// "own webhooks", member+ "own webhooks", reviewer "own webhooks", admin/owner
// "yes", X-ws "—". Creating a principal creates an `agents` row AND its
// `workspace_memberships` row, so it IS membership management: **admin/owner
// of the actor's own workspace, and no one else.** Issuing and revoking that
// principal's API key is the same row for the same reason — an API key is what
// a membership is worth in practice.
//
// Two rules that row does not state, added because §2's "actor from
// authentication, never from payload" and §4.3.8's key-to-author binding
// demand them:
//
//   * **No escalation.** The created principal's role may not outrank the
//     creator's, and an admin may not issue or revoke keys for an owner.
//     Otherwise "admin" is indistinguishable from "owner": an admin would mint
//     an owner principal and use it.
//   * **A signing key is registered for the CALLER, never for another agent.**
//     This is the one place where the admin/owner column of that row is
//     deliberately NOT followed. §4.3.8: "a kid is registered to exactly one
//     agent … verification resolves kid to the signing key of the manifest's
//     author_agent … therefore binds the package to a registered author". An
//     admin who could register a key under another principal could sign
//     packages that verify as authored by that principal, and the entire §4.4
//     author binding — the thing that makes a Verified Skill Package
//     attributable — would mean nothing. Registration is self-service and only
//     self-service, for every role including owner.
//
//     REVOCATION is not symmetric and admin/owner do get the row's "yes":
//     revoking a key removes capability and can never forge authorship, and a
//     compromised principal whose API key is also compromised must be
//     stoppable by someone other than the attacker holding it.
//
// ---------------------------------------------------------------------------
// Why the two secret-returning calls take no idempotency_key
// ---------------------------------------------------------------------------
//
// Appendix H's convention is that every mutating call accepts an
// `idempotency_key` and that a replay returns the PERSISTED original response.
// Persisting the response of `principal.create` or `principal.issue_api_key`
// would write the plaintext API key into `idempotency_keys.response_json` and
// leave it there — the exact opposite of "the key is stored only as a hash".
// So those two follow the precedent webhook registration already set (§Appendix
// H auxiliaries: `POST /v1/webhooks` takes no idempotency key either) and are
// not replayable. The three calls that return no secret — signing-key
// registration, signing-key revocation, API-key revocation — take one.
import { createPublicKey } from "node:crypto";
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { mintApiKey, type AuthContext, type Role } from "./auth.ts";
import { appendTlogInTx, type TlogRow } from "./tlog.ts";
import { assertIdentityText, isRefusedText } from "./outcome.ts";
import { ulid } from "./ulid.ts";

export const TLOG_KEY_REGISTERED = "signing_key_registered";
export const TLOG_KEY_REVOKED = "signing_key_revoked";

export type PrincipalType = "human" | "agent" | "service";

const PRINCIPAL_TYPES: readonly string[] = ["human", "agent", "service"];

/** §6's four workspace roles, ordered. A creator may not mint above itself. */
const ROLE_RANK: Readonly<Record<Role, number>> = { member: 1, reviewer: 2, admin: 3, owner: 4 };
const ROLES = Object.keys(ROLE_RANK) as Role[];

/** D.1: `kid NOT GLOB '*[^a-z0-9-]*' AND length BETWEEN 1 AND 64` — the same
 *  charset Appendix F's `tv-key-1` conforms to, restated as a regex so the
 *  surface refuses a bad kid with a message instead of a CHECK violation. */
const KID_RE = /^[a-z0-9-]{1,64}$/;

/** A `manifest_hash` — 64 lowercase hex characters — and therefore a shape a
 *  `kid` may not take. D.1's charset admits it (`[0-9a-f]` ⊂ `[a-z0-9-]`), and
 *  the transparency log gives `signing_key_registered` the SAME `subject_id`
 *  column that `countersign` fills with a manifest hash. A kid of this shape is
 *  one principal writing rows into another namespace's addresses; §4.4 step 6
 *  filters on `event_kind` so that such a row is not inclusion, and this rule
 *  is the other half — the collision is never minted at all. Nothing is lost:
 *  a kid is a label its owner chooses, and 64-hex is the one shape it may not
 *  choose. */
const KID_LOOKS_LIKE_MANIFEST_HASH_RE = /^[0-9a-f]{64}$/;

/** §4.3: registered public keys are unpadded base64url of the raw 32 bytes —
 *  43 characters, which is also D.1's `length(public_key_ed25519)=43`. */
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;

// ------------------------------------------------------------------- shapes

export interface CreatedPrincipal {
  principal_id: string;
  workspace_id: string;
  name: string;
  type: PrincipalType;
  role: Role;
  tool_profile: string | null;
  status: string;
  created_at_ms: number;
  api_key_id: string;
  /** returned EXACTLY ONCE, here; the database keeps only its sha256 */
  api_key: string;
}

export interface IssuedApiKey {
  principal_id: string;
  api_key_id: string;
  created_at_ms: number;
  /** returned EXACTLY ONCE, here */
  api_key: string;
}

export interface RevokedApiKey {
  principal_id: string;
  api_key_id: string;
  revoked_at_ms: number;
  /** true when the key was already revoked — the original time is reported */
  noop?: true;
}

export interface PrincipalView {
  principal_id: string;
  name: string;
  type: string;
  role: Role | null;
  status: string;
  tool_profile: string | null;
  created_at_ms: number;
  active_api_keys: number;
  active_signing_keys: number;
}

export interface RegisteredSigningKey {
  principal_id: string;
  kid: string;
  public_key_ed25519: string;
  created_at_ms: number;
  tlog_seq?: number;
  noop?: true;
}

export interface RevokedSigningKey {
  principal_id: string;
  kid: string;
  revoked_at_ms: number;
  tlog_seq?: number;
  noop?: true;
}

export interface SigningKeyView {
  principal_id: string;
  kid: string;
  public_key_ed25519: string;
  created_at_ms: number;
  revoked_at_ms: number | null;
}

// ------------------------------------------------------------- validation

function str(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ApiError("INVALID_SCHEMA", `${field} must be a string of ${min}..${max} characters`);
  }
  return value;
}

/**
 * A STRING THAT IS GOING INTO A COLUMN THAT DECIDES WHETHER TWO ROWS ARE ONE.
 *
 * `str` answers a type and a length, and for `agents.name` — under
 * `UNIQUE(workspace_id, name)` since work 1 — those were the only questions
 * anybody asked. So `"\ud800"` was created as U+FFFD and `"\ud801"`, a
 * DIFFERENT name, came back `409 CONFLICT` as a duplicate of it; on bun both
 * rows were written and SQLite handed both names back as the empty string. The
 * rule is not restated here: `assertIdentityText` (`src/outcome.ts`) holds it
 * and this boundary translates its refusal into the code the surface publishes.
 *
 * It runs BEFORE the conflict lookup on purpose. Asked afterwards it would
 * decide the name is unacceptable only after the registry had already used it to
 * accuse the caller of duplicating somebody.
 */
function identityStr(value: unknown, field: string, min: number, max: number): string {
  const text = str(value, field, min, max);
  try {
    return assertIdentityText(text, field);
  } catch (e) {
    if (!isRefusedText(e)) throw e;
    throw new ApiError("INVALID_SCHEMA", `${field}: ${e.message}`);
  }
}

function requireAdmin(auth: AuthContext, what: string): void {
  if (auth.role !== "admin" && auth.role !== "owner") {
    throw new ApiError("FORBIDDEN", `${what} requires workspace role admin or owner (§6 manage-memberships row)`);
  }
}

function requireMember(auth: AuthContext, what: string): void {
  if (auth.role === null) throw new ApiError("FORBIDDEN", `${what} requires a workspace membership`);
}

/** No escalation: an actor may not act on, or create, a role above its own. */
function requireRank(auth: AuthContext, target: Role | null, what: string): void {
  const actor = ROLE_RANK[auth.role as Role] ?? 0;
  const wanted = target === null ? 0 : ROLE_RANK[target];
  if (wanted > actor) {
    throw new ApiError("FORBIDDEN", `${what}: role ${target} outranks the caller's role ${auth.role}`);
  }
}

/**
 * A registered public key must be strict unpadded base64url of exactly 32
 * bytes — the encoding §4.3 signs against and D.1's `length(...)=43`.
 *
 * What this CANNOT do is tell a correct key from a wrong one: Ed25519 admits
 * any 32-byte string as a public-key encoding, so `createPublicKey` accepts
 * all of them and there is no "is this really your key" check to make. What
 * protects the §4.3.8 author binding is not this validation — it is that only
 * the principal itself may register a key for itself, and that a package
 * signed by a key other than the registered one fails §4.4 step 4 with
 * `BAD_SIGNATURE`. The `createPublicKey` call below therefore rejects only
 * structurally impossible input, and is kept for exactly that.
 */
function validatePublicKey(value: unknown): string {
  const key = str(value, "public_key_ed25519", 43, 43);
  if (!PUBKEY_RE.test(key) || Buffer.from(key, "base64url").toString("base64url") !== key) {
    throw new ApiError(
      "INVALID_SCHEMA",
      "public_key_ed25519 must be unpadded base64url of the raw 32-byte Ed25519 public key (§4.3)",
    );
  }
  const raw = Buffer.from(key, "base64url");
  if (raw.length !== 32) {
    throw new ApiError("INVALID_SCHEMA", "public_key_ed25519 must decode to exactly 32 bytes");
  }
  try {
    createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new ApiError("INVALID_SCHEMA", "public_key_ed25519 is not a valid Ed25519 public key");
  }
  return key;
}

function validateKid(value: unknown): string {
  const kid = str(value, "kid", 1, 64);
  if (!KID_RE.test(kid)) {
    throw new ApiError("INVALID_SCHEMA", "kid must match [a-z0-9-]{1,64} (§4.3.4 / Appendix D.1)");
  }
  return kid;
}

/**
 * The namespace rule, applied where a kid is MINTED and nowhere else.
 *
 * Lookups — `signing_key.revoke`, `signing_key.list`, §4.4 step 3 — must keep
 * accepting a 64-hex kid, because a deployment that ran an earlier build may
 * hold one, and a credential an operator cannot revoke is a worse outcome than
 * the one this rule prevents.
 */
function requireKidNamespace(kid: string): void {
  if (KID_LOOKS_LIKE_MANIFEST_HASH_RE.test(kid)) {
    throw new ApiError(
      "INVALID_SCHEMA",
      "kid must not be 64 lowercase hex characters: that is the manifest_hash namespace of the §3 transparency log, and a kid may not address rows in it (§4.3.4, §4.4 step 6)",
    );
  }
}

/** Provisioning is auditable: who did what, to whom, and never with what secret. */
function audit(
  db: Db,
  workspaceId: string,
  actorAgentId: string,
  action: string,
  subjectId: string,
  details: Record<string, unknown>,
  nowMs: number,
): void {
  db.prepare(
    "INSERT INTO activity_log(id, workspace_id, actor_agent_id, action, subject_id, details_json, created_at_ms) VALUES (?,?,?,?,?,?,?)",
  ).run(ulid(nowMs), workspaceId, actorAgentId, action, subjectId, JSON.stringify(details), nowMs);
}

// ------------------------------------------------------------- principals

export function createPrincipal(
  db: Db,
  auth: AuthContext,
  input: { name?: unknown; type?: unknown; role?: unknown; tool_profile?: unknown },
  nowMs: number,
): CreatedPrincipal {
  requireAdmin(auth, "creating a principal");
  const name = identityStr(input.name, "name", 1, 120);
  const type = str(input.type, "type", 1, 20) as PrincipalType;
  if (!PRINCIPAL_TYPES.includes(type)) {
    throw new ApiError("INVALID_SCHEMA", `type must be one of ${PRINCIPAL_TYPES.join(", ")}`);
  }
  const role = str(input.role, "role", 1, 20) as Role;
  if (!ROLES.includes(role)) throw new ApiError("INVALID_SCHEMA", `role must be one of ${ROLES.join(", ")}`);
  requireRank(auth, role, "creating a principal");
  const toolProfile = input.tool_profile === undefined || input.tool_profile === null
    ? null
    : str(input.tool_profile, "tool_profile", 1, 200);

  // D.1 UNIQUE(workspace_id,name). Reported as a conflict rather than left to
  // the constraint, so the caller learns the state of what is already there.
  const clash = db
    .prepare("SELECT id, status FROM agents WHERE workspace_id=? AND name=?")
    .get(auth.workspace_id, name) as { id: string; status: string } | undefined;
  if (clash) {
    throw new ApiError("CONFLICT", `a principal named ${name} already exists in this workspace`, clash.status);
  }

  const principalId = ulid(nowMs);
  db.exec("BEGIN IMMEDIATE");
  let issued: { api_key: string; key_id: string };
  try {
    db.prepare(
      "INSERT INTO agents(id, workspace_id, name, type, tool_profile, status, created_at_ms) VALUES (?,?,?,?,?, 'active', ?)",
    ).run(principalId, auth.workspace_id, name, type, toolProfile, nowMs);
    db.prepare(
      "INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)",
    ).run(principalId, auth.workspace_id, role, nowMs);
    issued = mintApiKey(db, principalId, nowMs);
    // the audit record names the KEY ROW, never the secret
    audit(db, auth.workspace_id, auth.agent_id, "principal.create", principalId, {
      name,
      type,
      role,
      api_key_id: issued.key_id,
    }, nowMs);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw e;
  }

  return {
    principal_id: principalId,
    workspace_id: auth.workspace_id,
    name,
    type,
    role,
    tool_profile: toolProfile,
    status: "active",
    created_at_ms: nowMs,
    api_key_id: issued.key_id,
    api_key: issued.api_key,
  };
}

/** The target principal, resolved WITHIN the actor's workspace. A principal of
 *  another workspace is refused as though it did not exist — the same rule
 *  §5.1 applies to a cross-workspace `verified` version. */
function targetPrincipal(db: Db, auth: AuthContext, principalId: unknown): { id: string; status: string; role: Role | null } {
  if (typeof principalId !== "string" || principalId.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "principal_id must be a string");
  }
  const row = db
    .prepare(
      `SELECT a.id, a.status, m.role
         FROM agents a LEFT JOIN workspace_memberships m ON m.agent_id=a.id AND m.workspace_id=a.workspace_id
        WHERE a.id=? AND a.workspace_id=?`,
    )
    .get(principalId, auth.workspace_id) as { id: string; status: string; role: Role | null } | undefined;
  if (!row) throw new ApiError("NOT_FOUND", "principal not found");
  return row;
}

export function issueApiKey(db: Db, auth: AuthContext, principalId: unknown, nowMs: number): IssuedApiKey {
  requireAdmin(auth, "issuing an API key");
  const target = targetPrincipal(db, auth, principalId);
  requireRank(auth, target.role, "issuing an API key");
  if (target.status !== "active") {
    throw new ApiError("PRECONDITION_FAILED", "only an active principal can hold an API key", target.status);
  }
  const issued = mintApiKey(db, target.id, nowMs);
  audit(db, auth.workspace_id, auth.agent_id, "principal.issue_api_key", target.id, { api_key_id: issued.key_id }, nowMs);
  return { principal_id: target.id, api_key_id: issued.key_id, created_at_ms: nowMs, api_key: issued.api_key };
}

export function revokeApiKey(
  db: Db,
  auth: AuthContext,
  principalId: unknown,
  keyId: unknown,
  nowMs: number,
): RevokedApiKey {
  requireMember(auth, "revoking an API key");
  const target = targetPrincipal(db, auth, principalId);
  // an admin/owner of the workspace, or the principal retiring its own key
  if (target.id !== auth.agent_id) {
    requireAdmin(auth, "revoking another principal's API key");
    requireRank(auth, target.role, "revoking an API key");
  }
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "api_key_id must be a string");
  }
  const key = db
    .prepare("SELECT id, revoked_at_ms FROM api_keys WHERE id=? AND agent_id=?")
    .get(keyId, target.id) as { id: string; revoked_at_ms: number | null } | undefined;
  if (!key) throw new ApiError("NOT_FOUND", "api key not found for this principal");
  if (key.revoked_at_ms !== null) {
    // convergent: the caller wanted it revoked and it is
    return { principal_id: target.id, api_key_id: key.id, revoked_at_ms: key.revoked_at_ms, noop: true };
  }
  db.prepare("UPDATE api_keys SET revoked_at_ms=? WHERE id=? AND revoked_at_ms IS NULL").run(nowMs, key.id);
  audit(db, auth.workspace_id, auth.agent_id, "principal.revoke_api_key", target.id, { api_key_id: key.id }, nowMs);
  return { principal_id: target.id, api_key_id: key.id, revoked_at_ms: nowMs };
}

/**
 * The workspace roster for an admin/owner; a member sees exactly its own row.
 * The narrow form is not a courtesy: a principal has to know its own
 * `principal_id` to put it in `manifest.author_agent` (§4.4 step 3), and
 * nothing else on the API tells it.
 */
export function listPrincipals(db: Db, auth: AuthContext): { items: PrincipalView[] } {
  requireMember(auth, "listing principals");
  const scoped = auth.role === "admin" || auth.role === "owner";
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.type, a.status, a.tool_profile, a.created_at_ms, m.role,
              (SELECT COUNT(*) FROM api_keys k WHERE k.agent_id=a.id AND k.revoked_at_ms IS NULL) AS active_api_keys,
              (SELECT COUNT(*) FROM signing_keys s WHERE s.agent_id=a.id AND s.revoked_at_ms IS NULL) AS active_signing_keys
         FROM agents a LEFT JOIN workspace_memberships m ON m.agent_id=a.id AND m.workspace_id=a.workspace_id
        WHERE a.workspace_id=? AND (? OR a.id=?)
        ORDER BY a.created_at_ms, a.id`,
    )
    .all(auth.workspace_id, scoped ? 1 : 0, auth.agent_id) as Array<PrincipalView & { id: string }>;
  // explicit projection: no column of `agents` reaches a response by accident
  return {
    items: rows.map((r) => ({
      principal_id: r.id,
      name: r.name,
      type: r.type,
      role: r.role,
      status: r.status,
      tool_profile: r.tool_profile,
      created_at_ms: r.created_at_ms,
      active_api_keys: r.active_api_keys,
      active_signing_keys: r.active_signing_keys,
    })),
  };
}

// ----------------------------------------------------------- signing keys

export function registerSigningKey(
  db: Db,
  auth: AuthContext,
  input: { kid?: unknown; public_key_ed25519?: unknown },
  nowMs: number,
): RegisteredSigningKey {
  requireMember(auth, "registering a signing key");
  const kid = validateKid(input.kid);
  requireKidNamespace(kid);
  const publicKey = validatePublicKey(input.public_key_ed25519);

  db.exec("BEGIN IMMEDIATE");
  try {
    // D.1 makes `kid` globally UNIQUE, so the lookup is by kid alone and the
    // owning agent is what decides the answer.
    const existing = db
      .prepare("SELECT agent_id, public_key_ed25519, created_at_ms, revoked_at_ms FROM signing_keys WHERE kid=?")
      .get(kid) as
      | { agent_id: string; public_key_ed25519: string; created_at_ms: number; revoked_at_ms: number | null }
      | undefined;
    if (existing) {
      const mine = existing.agent_id === auth.agent_id;
      if (mine && existing.public_key_ed25519 === publicKey && existing.revoked_at_ms === null) {
        db.exec("COMMIT"); // convergent: this exact binding is already registered
        return {
          principal_id: auth.agent_id,
          kid,
          public_key_ed25519: publicKey,
          created_at_ms: existing.created_at_ms,
          noop: true,
        };
      }
      db.exec("ROLLBACK");
      // The message names neither the other agent nor its key: a kid travels
      // in the clear inside every JWS header, its owner does not have to.
      throw new ApiError(
        "CONFLICT",
        mine && existing.revoked_at_ms !== null
          ? `kid ${kid} is registered and revoked; a revoked kid is never re-registered (§4.4 step 7)`
          : `kid ${kid} is already registered to a different key or principal`,
        existing.revoked_at_ms === null ? "active" : "revoked",
      );
    }

    db.prepare(
      "INSERT INTO signing_keys(id, agent_id, kid, public_key_ed25519, created_at_ms) VALUES (?,?,?,?,?)",
    ).run(ulid(nowMs), auth.agent_id, kid, publicKey, nowMs);
    // §4.4 step 3 makes this binding a trust input, and step 7 makes its
    // revocation one. A trust input that lives only in a mutable table is
    // exactly what §3's log exists to prevent, so both events are logged.
    const tlog = appendTlogInTx(
      db,
      TLOG_KEY_REGISTERED,
      kid,
      { kid, agent_id: auth.agent_id, public_key_ed25519: publicKey },
      nowMs,
    );
    audit(db, auth.workspace_id, auth.agent_id, "signing_key.register", auth.agent_id, { kid, tlog_seq: tlog.seq }, nowMs);
    db.exec("COMMIT");
    return {
      principal_id: auth.agent_id,
      kid,
      public_key_ed25519: publicKey,
      created_at_ms: nowMs,
      tlog_seq: tlog.seq,
    };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the successful paths already committed */
    }
    throw e;
  }
}

export function revokeSigningKey(db: Db, auth: AuthContext, kid: unknown, nowMs: number): RevokedSigningKey {
  requireMember(auth, "revoking a signing key");
  const wanted = validateKid(kid);
  const row = db
    .prepare(
      `SELECT s.id, s.agent_id, s.revoked_at_ms, a.workspace_id, m.role
         FROM signing_keys s JOIN agents a ON a.id = s.agent_id
         LEFT JOIN workspace_memberships m ON m.agent_id=a.id AND m.workspace_id=a.workspace_id
        WHERE s.kid=?`,
    )
    .get(wanted) as
    | { id: string; agent_id: string; revoked_at_ms: number | null; workspace_id: string; role: Role | null }
    | undefined;
  // a key of another workspace is refused as though it did not exist
  if (!row || row.workspace_id !== auth.workspace_id) throw new ApiError("NOT_FOUND", "signing key not found");
  if (row.agent_id !== auth.agent_id) {
    requireAdmin(auth, "revoking another principal's signing key");
    requireRank(auth, row.role, "revoking a signing key");
  }
  if (row.revoked_at_ms !== null) {
    // convergent, and deliberately no second tlog row: the revocation time is
    // the §4.4 step-7 comparison point and must not move
    return { principal_id: row.agent_id, kid: wanted, revoked_at_ms: row.revoked_at_ms, noop: true };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const res = db
      .prepare("UPDATE signing_keys SET revoked_at_ms=? WHERE id=? AND revoked_at_ms IS NULL")
      .run(nowMs, row.id);
    if (res.changes !== 1) {
      db.exec("ROLLBACK");
      const now = db.prepare("SELECT revoked_at_ms FROM signing_keys WHERE id=?").get(row.id) as {
        revoked_at_ms: number | null;
      };
      return { principal_id: row.agent_id, kid: wanted, revoked_at_ms: now.revoked_at_ms ?? nowMs, noop: true };
    }
    const tlog = appendTlogInTx(db, TLOG_KEY_REVOKED, wanted, { kid: wanted, agent_id: row.agent_id }, nowMs);
    audit(db, auth.workspace_id, auth.agent_id, "signing_key.revoke", row.agent_id, { kid: wanted, tlog_seq: tlog.seq }, nowMs);
    db.exec("COMMIT");
    return { principal_id: row.agent_id, kid: wanted, revoked_at_ms: nowMs, tlog_seq: tlog.seq };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw e;
  }
}

/** Own keys; an admin/owner sees the workspace's. Public halves only — there
 *  is no private half in this system to leak, but the projection is explicit
 *  so a future column cannot ride out on `SELECT *`. */
export function listSigningKeys(db: Db, auth: AuthContext): { items: SigningKeyView[] } {
  requireMember(auth, "listing signing keys");
  const scoped = auth.role === "admin" || auth.role === "owner";
  const rows = db
    .prepare(
      `SELECT s.agent_id, s.kid, s.public_key_ed25519, s.created_at_ms, s.revoked_at_ms
         FROM signing_keys s JOIN agents a ON a.id = s.agent_id
        WHERE a.workspace_id=? AND (? OR s.agent_id=?)
        ORDER BY s.created_at_ms, s.kid`,
    )
    .all(auth.workspace_id, scoped ? 1 : 0, auth.agent_id) as Array<{
    agent_id: string;
    kid: string;
    public_key_ed25519: string;
    created_at_ms: number;
    revoked_at_ms: number | null;
  }>;
  return {
    items: rows.map((r) => ({
      principal_id: r.agent_id,
      kid: r.kid,
      public_key_ed25519: r.public_key_ed25519,
      created_at_ms: r.created_at_ms,
      revoked_at_ms: r.revoked_at_ms,
    })),
  };
}
