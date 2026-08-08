// §4.4 step 6 — INCLUSION is a countersign, not "any row that mentions the hash".
//
// THE ATTACK this file closes. Step 6 used to ask one question of the log:
// "is there a row whose `subject_id` equals this `manifest_hash`?" — with no
// filter on `event_kind`. §4.4's own table says the nine V1 kinds put three
// different namespaces in that column (a manifest hash, a skill_version_id, a
// kid), and only `countersign` puts a manifest hash there. But nothing ENFORCED
// the disjointness: `kid` is caller-chosen and `[a-z0-9-]{1,64}` contains every
// 64-character lowercase hex string, so an attacker could register a signing
// key whose kid IS the victim package's manifest hash. Registration appends
// `signing_key_registered` with `subject_id = kid`, step 6 accepted that row as
// inclusion, and — with an unrevoked key — step 7 returned `valid` before the
// countersign lookup ever ran. A package the registry never countersigned came
// back `valid`.
//
// Two independent cuts, because either alone still leaves a door:
//   1. step 6 requires `event_kind = countersign` AND `subject_id = <hash>`;
//   2. the kid namespace is closed against the manifest-hash namespace, so the
//      collision cannot be created in the first place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../src/sqlite.ts";
import type { AuthContext } from "../src/auth.ts";
import { ApiError } from "../src/errors.ts";
import { appendTlog, verifyTlog } from "../src/tlog.ts";
import { verifyPackage, COUNTERSIGN_EVENT } from "../src/verify.ts";
import { publishVersion } from "../src/countersign.ts";
import {
  registerSigningKey,
  revokeSigningKey,
  TLOG_KEY_REGISTERED,
  TLOG_KEY_REVOKED,
} from "../src/provision.ts";
import { TLOG_APPROVAL } from "../src/approvals.ts";
import { TLOG_VERIFIED } from "../src/verified-gate.ts";
import { TLOG_ATTESTATION, TLOG_SUPERSEDED, TLOG_REVOKED, TLOG_DEPRECATED } from "../src/service.ts";
import { keyFromSeedHex } from "../src/signing.ts";
import { ulid } from "../src/ulid.ts";
import { tvRegistry, tv01Package, tv01Manifest, root } from "./vectors-helpers.ts";

/** The author principal of the TV fixture, as a member of its own workspace. */
function tvAuth(db: Db): AuthContext {
  const agent_id = tv01Manifest().author_agent as string;
  const ws = db.prepare("SELECT workspace_id AS id FROM agents WHERE id=?").get(agent_id) as { id: string };
  return { agent_id, workspace_id: ws.id, role: "member", tool_profile: null, api_key_id: "test-key" };
}

/** A public key that is not the TV key — the attacker's own, freshly minted. */
function attackerPublicKey(seedByte: number): string {
  return keyFromSeedHex(Buffer.alloc(32, seedByte).toString("hex")).publicKeyB64url;
}

/** Run `fn`, require it to raise an ApiError, and hand the error back. */
function rejects(fn: () => unknown, where: string): ApiError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError, `${where}: expected an ApiError, got ${String(e)}`);
    return e as ApiError;
  }
  throw new assert.AssertionError({ message: `${where}: expected a refusal, the call succeeded` });
}

// ===========================================================================
// 1. The verifier: only a countersign is inclusion.
// ===========================================================================

test("ATTACK: a signing_key_registered row whose subject_id IS the manifest_hash is not inclusion", () => {
  // The registry never countersigned this package: it is `published` in the
  // version table but the log holds no `countersign` row for its hash.
  const { db, mHash } = tvRegistry({ skipCountersign: true });
  assert.equal(verifyPackage(tv01Package(), db).verdict, "NOT_LOGGED", "precondition: nothing in the log yet");

  // The attacker's forged inclusion: exactly the row `signing_key.register`
  // writes for a kid that happens to equal the victim's manifest hash.
  appendTlog(db, TLOG_KEY_REGISTERED, mHash, { kid: mHash, agent_id: "attacker", public_key_ed25519: "x" }, 1_754_000_009_000);
  assert.deepEqual(verifyTlog(db), { ok: true, checked: 1 }, "the forged row is a perfectly well-formed log entry");

  const outcome = verifyPackage(tv01Package(), db);
  assert.equal(
    outcome.verdict,
    "NOT_LOGGED",
    `a package the registry never countersigned must never verify: got ${JSON.stringify(outcome)}`,
  );
});

test("ATTACK: none of the eight non-countersign event kinds satisfies step 6", () => {
  for (const kind of [
    TLOG_KEY_REGISTERED,
    TLOG_KEY_REVOKED,
    TLOG_ATTESTATION,
    TLOG_VERIFIED,
    TLOG_APPROVAL,
    TLOG_SUPERSEDED,
    TLOG_DEPRECATED,
    TLOG_REVOKED,
  ]) {
    const { db, mHash } = tvRegistry({ skipCountersign: true });
    appendTlog(db, kind, mHash, { forged: kind }, 1_754_000_009_000);
    assert.equal(
      verifyPackage(tv01Package(), db).verdict,
      "NOT_LOGGED",
      `event_kind ${kind} with subject_id = manifest_hash must not count as inclusion`,
    );
    db.close();
  }
});

test("ATTACK: a forged row does not rescue a package whose countersign is absent and whose key is revoked", () => {
  const { db, mHash } = tvRegistry({ skipCountersign: true, keyRevokedAtMs: 1_754_000_001_000 });
  appendTlog(db, TLOG_KEY_REGISTERED, mHash, { kid: mHash }, 1_754_000_009_000);
  assert.equal(verifyPackage(tv01Package(), db).verdict, "NOT_LOGGED");
});

test("POSITIVE: a real countersign is the only thing that opens the logged path", () => {
  const { db, versionId, mHash } = tvRegistry({ state: "verified", skipCountersign: true });
  assert.equal(verifyPackage(tv01Package(), db).verdict, "NOT_LOGGED");
  const row = publishVersion(db, versionId, 1_754_000_005_000).countersign!;
  assert.equal(row.event_kind, COUNTERSIGN_EVENT);
  assert.equal(row.subject_id, mHash);
  assert.equal(verifyPackage(tv01Package(), db).verdict, "valid", "an ordinary published package still verifies");
});

test("POSITIVE: a countersign still decides step 7 for a revoked key", () => {
  const after = tvRegistry({ keyRevokedAtMs: 1_754_000_005_000 + 1 });
  assert.equal(verifyPackage(tv01Package(), after.db).verdict, "valid_but_key_since_revoked");
  const before = tvRegistry({ keyRevokedAtMs: 1_754_000_001_000 });
  assert.equal(verifyPackage(tv01Package(), before.db).verdict, "invalid_key_revoked_at_signing");
});

// ===========================================================================
// 2. The registration surface: the kid namespace is closed.
// ===========================================================================

test("ATTACK: signing_key.register refuses a kid that is a 64-character hex string", () => {
  const { db, mHash } = tvRegistry({ skipCountersign: true });
  const auth = tvAuth(db);

  const e = rejects(
    () => registerSigningKey(db, auth, { kid: mHash, public_key_ed25519: attackerPublicKey(0x41) }, 1_754_000_009_000),
    "registering kid = manifest_hash",
  );
  assert.equal(e.code, "INVALID_SCHEMA", "the refusal carries a §6 error code, not a CHECK violation");
  assert.match(e.message, /64/, `the message must say what is wrong: ${e.message}`);

  // nothing was written: no key row, and above all no transparency-log row
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM signing_keys WHERE kid=?").get(mHash) as { c: number }).c,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE subject_id=?").get(mHash) as { c: number }).c,
    0,
  );
  assert.equal(verifyPackage(tv01Package(), db).verdict, "NOT_LOGGED");
});

test("the 64-hex refusal is about the SHAPE, not about any particular package", () => {
  const { db } = tvRegistry({ skipCountersign: true });
  const auth = tvAuth(db);
  for (const kid of ["0".repeat(64), "f".repeat(64), "0123456789abcdef".repeat(4)]) {
    const e = rejects(
      () => registerSigningKey(db, auth, { kid, public_key_ed25519: attackerPublicKey(0x42) }, 1_754_000_009_000),
      kid,
    );
    assert.equal(e.code, "INVALID_SCHEMA", kid);
  }
});

test("ordinary kids still register — the ban is exactly the 64-hex shape and nothing wider", () => {
  const { db } = tvRegistry({ skipCountersign: true });
  const auth = tvAuth(db);
  let seed = 0x50;
  for (const kid of [
    "prod-2026",
    "release-key-1",
    "0".repeat(63), // one character short of a hash
    "0".repeat(63) + "g", // 64 characters, but `g` is not a hex digit
    "deadbeef", // hex, and nowhere near 64 characters
  ]) {
    const out = registerSigningKey(db, auth, { kid, public_key_ed25519: attackerPublicKey(seed++) }, 1_754_000_009_000);
    assert.equal(out.kid, kid, `${kid} is not a manifest hash and must still be registrable`);
  }
});

test("a kid registered BEFORE the namespace rule can still be revoked (the ban is on minting, not on lookup)", () => {
  // A deployment that ran the vulnerable build may hold such a row. Refusing to
  // revoke it would strand the very credential an operator most wants retired.
  const { db, mHash } = tvRegistry({ skipCountersign: true });
  const auth = tvAuth(db);
  db.prepare(
    "INSERT INTO signing_keys(id, agent_id, kid, public_key_ed25519, created_at_ms) VALUES (?,?,?,?,?)",
  ).run(ulid(1_754_000_008_000), auth.agent_id, mHash, attackerPublicKey(0x43), 1_754_000_008_000);

  const out = revokeSigningKey(db, auth, mHash, 1_754_000_009_000);
  assert.equal(out.kid, mHash);
  assert.equal(out.revoked_at_ms, 1_754_000_009_000);
  // …and the `signing_key_revoked` row it just wrote, whose subject_id IS the
  // manifest hash, still does not make the package logged
  assert.equal(
    (db.prepare("SELECT event_kind AS k FROM transparency_log WHERE subject_id=?").get(mHash) as { k: string }).k,
    TLOG_KEY_REVOKED,
  );
  assert.equal(verifyPackage(tv01Package(), db).verdict, "NOT_LOGGED");
});

// ===========================================================================
// 3. The specification says both halves — and says them because the code does.
// ===========================================================================

test("§4.4 step 6 and §6.1 carry the two rules this file enforces", () => {
  const spec = readFileSync(join(root, "SPEC.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(
    spec.includes("**Inclusion is a `countersign` entry and nothing else:**"),
    "§4.4 step 6 must name the event kind — a step that matches on subject_id alone is the vulnerability",
  );
  assert.ok(
    spec.includes("Matching on `subject_id` alone is FORBIDDEN."),
    "§4.4 step 6 must forbid the loose reading explicitly",
  );
  assert.ok(
    spec.includes("**A registered `kid` MUST NOT be 64 lowercase hexadecimal characters**"),
    "§6.1 must close the kid namespace against the manifest-hash shape",
  );
});

// ===========================================================================
// 4. The namespaces, enumerated.
// ===========================================================================

test("the nine V1 event kinds occupy three subject_id namespaces, and only one can hold a manifest hash", () => {
  const HEX64 = /^[0-9a-f]{64}$/;
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  // a skill_version_id is a ULID: 26 Crockford-base32 characters, uppercase.
  // No ULID is a 64-character lowercase hex string — two length classes apart,
  // and the alphabets do not even overlap in case.
  for (let i = 0; i < 64; i += 1) {
    const id = ulid(1_754_000_000_000 + i);
    assert.match(id, ULID, id);
    assert.doesNotMatch(id, HEX64, `a skill_version_id must never look like a manifest_hash: ${id}`);
  }

  // a manifest_hash is 64 lowercase hex characters
  const { db, mHash } = tvRegistry({ skipCountersign: true });
  assert.match(mHash, HEX64);

  // and a kid can no longer be one — which is what closes the last overlap
  const auth = tvAuth(db);
  assert.equal(
    rejects(
      () => registerSigningKey(db, auth, { kid: mHash, public_key_ed25519: attackerPublicKey(0x44) }, 1_754_000_009_000),
      "kid = manifest_hash",
    ).code,
    "INVALID_SCHEMA",
  );
});
