// [B-1] SYSTEM SIGNING KEYS — the key the registry creates, keeps and signs
// with, so that the owner never types cryptographic material at a prompt.
//
// The requirement, restated so it can be checked rather than believed:
//
//     "The key and the signature are created and held by the system. The owner
//      never enters cryptographic material on the command line, not once."
//
// Everything below follows from that sentence plus [I-7]:
//
//   * the private half is GENERATED here, from `randomBytes(32)`, and is never
//     an input to any surface — there is no field, header or flag that carries
//     one in, so there is nothing for an owner to type or an attacker to plant;
//   * it is stored in the deployment's `SecretStore`, addressed by a handle.
//     `FsSecretStore` writes mode 0600 inside a 0700 directory; a deployment
//     with a vault supplies its own store and nothing here changes;
//   * SQLite holds the PUBLIC half, the `kid`, and the handle. That is the
//     whole of what [I-7] permits a record to carry: references to handles and
//     scopes, never the material;
//   * the private half is never returned, never logged, never written into a
//     package, never written into the transparency log and never named in an
//     error message. `assertNoPrivateMaterial` below is not documentation of
//     that claim — it is the check, run over the actual bytes of everything
//     `skill.create_from_dir` produces.
//
// WHOSE KEY IT IS. Per principal, not per deployment. §4.4 step 3 resolves a
// package's `kid` against `manifest.author_agent`, and `skill.create`'s defect-2
// rule already forces `author_agent` to equal the authenticated agent. A single
// registry-wide key would make every package's signature attributable to the
// registry rather than to its author, and the §4.3.8 author binding — the thing
// that makes a Verified Skill Package attributable at all — would be worth
// nothing. So each principal gets its own, minted on first use.
import { randomBytes, type KeyObject } from "node:crypto";
import type { Db } from "./sqlite.ts";
import type { SecretStore } from "./webhooks.ts";
import { keyFromSeedHex } from "./signing.ts";
import { appendTlogInTx } from "./tlog.ts";
import { TLOG_KEY_REGISTERED } from "./provision.ts";
import { ulid } from "./ulid.ts";

/** `kid` prefix of a system-held key. A label, never a capability: what makes a
 *  key signable is the `secret_ref` column, which no caller can set. */
export const SYSTEM_KID_PREFIX = "skln-sys-";

/** Handle namespace inside the `SecretStore`, alongside `secretstore://webhook/`. */
export const SYSTEM_SECRET_SCHEME = "secretstore://signing-key/";

export interface SystemSigningKey {
  kid: string;
  /** the handle recorded in `signing_keys.secret_ref` — a reference, not a key */
  secret_ref: string;
  public_key_ed25519: string;
  /** the loaded private key OBJECT. It is deliberately not the seed: a KeyObject
   *  does not stringify into anything, so it cannot be spilled by a template
   *  literal, a `JSON.stringify` or a log line that meant to print its holder. */
  privateKey: KeyObject;
  /** true when this call minted it; false when it was already on file */
  created: boolean;
}

/** §4.3.4 / Appendix D.1 charset: `[a-z0-9-]{1,64}`. A ULID is `[0-9A-Z]{26}`,
 *  so the lowercased form is in charset, and the 35-character result is neither
 *  64 characters nor hex — it can never collide with the transparency log's
 *  `manifest_hash` namespace the way `requireKidNamespace` forbids. */
export function systemKidFor(agentId: string): string {
  return `${SYSTEM_KID_PREFIX}${agentId.toLowerCase()}`;
}

/** Read the seed for a handle, or fail loudly. A row that names a secret the
 *  store cannot produce is a broken deployment, not a reason to mint a second
 *  key: minting one would silently orphan every package the first one signed. */
function loadSeed(secrets: SecretStore, ref: string): string {
  const seedHex = secrets.get(ref);
  if (seedHex === undefined || !/^[0-9a-f]{64}$/.test(seedHex)) {
    // the handle is named, the material is not — there is none to name
    throw new Error(`system signing key: the secret store holds no usable seed at ${ref}`);
  }
  return seedHex;
}

/**
 * The caller's system signing key, minted on first use.
 *
 * Runs in its own transaction and MUST be called before the packing
 * transaction opens — SQLite has no nested `BEGIN IMMEDIATE`, and a key minted
 * inside the packing transaction would be rolled back with a failed pack while
 * its secret file stayed behind.
 *
 * Write order is secret-then-row, deliberately. A crash between the two leaves
 * an unreferenced file in the secret store, which is inert. The reverse order
 * would leave a `signing_keys` row naming a secret that does not exist — a key
 * that cannot sign and cannot be re-minted, because the row already occupies
 * its `kid`.
 */
export function systemSigningKey(
  db: Db,
  secrets: SecretStore,
  agentId: string,
  nowMs: number,
): SystemSigningKey {
  const kid = systemKidFor(agentId);
  const existing = db
    .prepare("SELECT kid, public_key_ed25519, secret_ref, revoked_at_ms FROM signing_keys WHERE kid=?")
    .get(kid) as
    | { kid: string; public_key_ed25519: string; secret_ref: string | null; revoked_at_ms: number | null }
    | undefined;

  if (existing) {
    if (existing.secret_ref === null) {
      // Someone registered this kid through `signing_key.register`, which never
      // sets `secret_ref`. Refusing is the only safe answer: signing would need
      // a private half the registry does not have, and re-minting would let a
      // caller displace a key by claiming its name first.
      throw new Error(`system signing key: kid ${kid} is registered without a system-held private half`);
    }
    if (existing.revoked_at_ms !== null) {
      throw new Error(`system signing key: kid ${kid} is revoked; §4.4 step 7 never re-registers a revoked kid`);
    }
    const { privateKey, publicKeyB64url } = keyFromSeedHex(loadSeed(secrets, existing.secret_ref));
    if (publicKeyB64url !== existing.public_key_ed25519) {
      throw new Error(`system signing key: the stored public half of ${kid} does not match its seed`);
    }
    return {
      kid,
      secret_ref: existing.secret_ref,
      public_key_ed25519: existing.public_key_ed25519,
      privateKey,
      created: false,
    };
  }

  const rowId = ulid(nowMs);
  const secretRef = `${SYSTEM_SECRET_SCHEME}${rowId}`;
  const seedHex = randomBytes(32).toString("hex");
  const { privateKey, publicKeyB64url } = keyFromSeedHex(seedHex);
  secrets.put(secretRef, seedHex);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO signing_keys(id, agent_id, kid, public_key_ed25519, created_at_ms, secret_ref) VALUES (?,?,?,?,?,?)",
    ).run(rowId, agentId, kid, publicKeyB64url, nowMs, secretRef);
    // §4.4 step 3 makes the kid→agent binding a trust input, so it is logged
    // exactly as `signing_key.register` logs one. The payload carries the
    // PUBLIC half and the handle; there is no member for anything else.
    appendTlogInTx(
      db,
      TLOG_KEY_REGISTERED,
      kid,
      { kid, agent_id: agentId, public_key_ed25519: publicKeyB64url, secret_ref: secretRef },
      nowMs,
    );
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw e;
  }

  return { kid, secret_ref: secretRef, public_key_ed25519: publicKeyB64url, privateKey, created: true };
}

/**
 * [I-7], enforced rather than asserted.
 *
 * Every encoding the 32-byte seed could plausibly take on its way out — hex in
 * either case, standard base64, base64url, and the raw bytes themselves — is
 * searched for in every observable output of a packing call: the package bytes,
 * the stored manifest, the response body, the transparency-log payload.
 *
 * The message names the SUBJECT and never the material, because an exception
 * message is itself an observable output and a check that leaked what it caught
 * would be the defect it exists to prevent.
 */
export function assertNoPrivateMaterial(
  seedHex: string,
  subjects: ReadonlyArray<readonly [string, string | Buffer]>,
): void {
  const raw = Buffer.from(seedHex, "hex");
  const needles = [
    seedHex.toLowerCase(),
    seedHex.toUpperCase(),
    raw.toString("base64"),
    raw.toString("base64url"),
  ];
  for (const [where, subject] of subjects) {
    const haystack = Buffer.isBuffer(subject) ? subject : Buffer.from(subject, "utf8");
    for (const needle of needles) {
      if (haystack.includes(needle)) {
        throw new Error(`[I-7] refused: private signing material appeared in ${where}`);
      }
    }
    if (haystack.includes(raw)) {
      throw new Error(`[I-7] refused: private signing material appeared in ${where}`);
    }
  }
}
