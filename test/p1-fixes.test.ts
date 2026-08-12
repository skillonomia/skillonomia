// Regression suite for the P1 review (verdict 1, BLOCKED on 3b17bc6):
// every blocking/major/minor finding gets a test that fails on the old code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTar, ArchiveError, writeTar, type PackageFiles } from "../src/archive.ts";
import { verifyJws, signManifest, keyFromSeedHex } from "../src/signing.ts";
import { jcsCanonicalize, parseJsonStrict } from "../src/jcs.ts";
import { NotWellFormedText } from "../src/outcome.ts";
import { verifyPackage } from "../src/verify.ts";
import { publishVersion } from "../src/countersign.ts";
import { insertVersion } from "./helpers.ts";
import { ulid } from "../src/ulid.ts";
import {
  tvRegistry, tv01Package, tv01Manifest, rawTarEntry, tarOf, paxEntry, paxRecord,
  TV_SEED_HEX, TV_KID, TV_PUB_B64URL,
} from "./vectors-helpers.ts";

function expectArchiveError(fn: () => unknown, code: "MALFORMED_ARCHIVE" | "LIMIT_EXCEEDED") {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ArchiveError, `expected ArchiveError, got ${e}`);
    assert.equal((e as ArchiveError).code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

// ---- B-1: pax record lengths are BYTES, not JS chars ----

test("B-1: pax records with multi-byte UTF-8 parse at byte offsets (path override applies)", () => {
  const records = Buffer.concat([paxRecord("comment", "значение-с-кириллицей"), paxRecord("path", "renamed.txt")]);
  const tar = tarOf(paxEntry(records), rawTarEntry("ignored-name.txt", Buffer.from("data"), "0"));
  const files = readTar(tar);
  assert.deepEqual([...files.keys()], ["renamed.txt"], "byte-accurate pax parsing must apply the path override");
});

test("B-1: pax path traversal override is rejected even behind multi-byte records", () => {
  const records = Buffer.concat([paxRecord("comment", "многобайтовый-щит"), paxRecord("path", "../evil.sh")]);
  const tar = tarOf(paxEntry(records), rawTarEntry("innocent.txt", Buffer.from("x"), "0"));
  expectArchiveError(() => readTar(tar), "MALFORMED_ARCHIVE");
});

test("B-1: malformed pax record lengths rejected", () => {
  expectArchiveError(() => readTar(tarOf(paxEntry(Buffer.from("9999 path=x\n")), rawTarEntry("a", Buffer.from("x"), "0"))), "MALFORMED_ARCHIVE");
  expectArchiveError(() => readTar(tarOf(paxEntry(Buffer.from("abc path=x\n")), rawTarEntry("a", Buffer.from("x"), "0"))), "MALFORMED_ARCHIVE");
});

// ---- B-3: strict byte-exact JWS parsing ----

test("B-3: padded / non-URL / whitespace JWS serializations rejected", () => {
  const m = tv01Manifest();
  const { privateKey } = keyFromSeedHex(TV_SEED_HEX);
  const { jws } = signManifest(m, privateKey, TV_KID);
  const [p, , sig] = jws.split(".");

  // structural/header defects are caught in parse-only mode (before kid lookup)
  for (const bad of [`${p}==..${sig}`, ` ${jws}`, `${jws}\n`, `${p}.${sig}`, `${p}...${sig}`]) {
    assert.equal(verifyJws(m, bad, undefined).ok, false, `parse-only must reject ${JSON.stringify(bad.slice(0, 16))}…`);
  }

  // signature-encoding defects are judged in the verify branch (M-2 step order:
  // kid resolution must happen first, so parse-only tolerates the sig component)
  for (const bad of [`${p}..${sig}=`, `${p}..${sig.replace(/_/g, "/")}`, `${p}..${sig.slice(0, 40)}`]) {
    const res = verifyJws(m, bad, TV_PUB_B64URL);
    assert.equal(res.ok, false, `verify must reject ${JSON.stringify(bad.slice(-12))}`);
    assert.match(String(res.reason), /signature/);
  }
});

test("M-2: unknown kid + malformed signature → step 3 UNKNOWN_KEY, not BAD_SIGNATURE", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const { privateKey } = keyFromSeedHex(TV_SEED_HEX);
  const { jws } = signManifest(tv01Manifest(), privateKey, "no-such-kid");
  const [p, , sig] = jws.split(".");
  files.set("SIGNATURE.jws", Buffer.from(`${p}..${sig}=`, "utf8")); // unknown kid AND padded sig
  assert.equal(verifyPackage(files, db).verdict, "UNKNOWN_KEY");
});

test("M-1b: registered public key in non-canonical base64 → signature not accepted", () => {
  const m = tv01Manifest();
  const { privateKey } = keyFromSeedHex(TV_SEED_HEX);
  const { jws } = signManifest(m, privateKey, TV_KID);
  const standardB64 = Buffer.from(TV_PUB_B64URL, "base64url").toString("base64"); // padded, +/ alphabet
  const res = verifyJws(m, jws, standardB64);
  assert.equal(res.ok, false);
  assert.match(String(res.reason), /registered public key/);
});

test("B-3: whole-package check — JWS with trailing newline → BAD_SIGNATURE", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  files.set("SIGNATURE.jws", Buffer.concat([files.get("SIGNATURE.jws")!, Buffer.from("\n")]));
  assert.equal(verifyPackage(files, db).verdict, "BAD_SIGNATURE");
});

// ---- B-4: tar strictness ----

test("B-4: bad header checksum → MALFORMED_ARCHIVE", () => {
  const entry = rawTarEntry("a.txt", Buffer.from("x"), "0");
  entry.write("0000000\0", 148); // clobber checksum
  expectArchiveError(() => readTar(tarOf(entry)), "MALFORMED_ARCHIVE");
});

test("B-4: truncated archive without end-of-archive marker → MALFORMED_ARCHIVE", () => {
  const entry = rawTarEntry("a.txt", Buffer.from("x"), "0");
  expectArchiveError(() => readTar(entry), "MALFORMED_ARCHIVE"); // no trailing zero blocks
});

test("B-4: invalid UTF-8 in name → MALFORMED_ARCHIVE", () => {
  const entry = rawTarEntry("aaaa.txt", Buffer.from("x"), "0");
  entry[0] = 0xff; // invalid UTF-8 lead byte in name field
  // rewrite checksum after mutation
  entry.write("        ", 148);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += entry[i];
  entry.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  expectArchiveError(() => readTar(tarOf(entry)), "MALFORMED_ARCHIVE");
});

test("B-4: duplicate and file-colliding directory entries → MALFORMED_ARCHIVE", () => {
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("dir/", Buffer.alloc(0), "5"), rawTarEntry("dir/", Buffer.alloc(0), "5"))),
    "MALFORMED_ARCHIVE",
  );
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("x", Buffer.from("f"), "0"), rawTarEntry("x/", Buffer.alloc(0), "5"))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-4: packer enforces the size profile", () => {
  const big: PackageFiles = new Map([["big.bin", Buffer.alloc(4 * 1024 * 1024 + 1)]]);
  expectArchiveError(() => writeTar(big), "LIMIT_EXCEEDED");
  const many: PackageFiles = new Map();
  for (let i = 0; i < 513; i++) many.set(`f${i}.txt`, Buffer.from("x"));
  expectArchiveError(() => writeTar(many), "LIMIT_EXCEEDED");
});

// ---- B-5: JCS input requirements ----

test("B-5: lone surrogate in string → JCS throws", () => {
  // Round 14: the refusal is `assertWellFormedText`'s (src/outcome.ts), the one
  // definition of the rule, and it is TYPED — which is what lets every adapter
  // answer INVALID_SCHEMA instead of 500. The subject of the probe is unchanged.
  assert.throws(() => jcsCanonicalize({ a: "\ud800" }), NotWellFormedText);
  assert.throws(() => jcsCanonicalize({ a: "\ud800" }), /unpaired surrogate/);
});

test("B-5: duplicate JSON keys rejected (top-level and nested)", () => {
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}'), /duplicate/);
  assert.throws(() => parseJsonStrict('{"o":{"x":1,"x":2}}'), /duplicate/);
  assert.throws(() => parseJsonStrict('{"arr":[{"k":1,"k":1}]}'), /duplicate/);
  assert.deepEqual(parseJsonStrict('{"a":{"b":[1,"s",null,true]}}'), { a: { b: [1, "s", null, true] } });
});

test("B-5: package with duplicate-key skill.json → INVALID_SCHEMA", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const raw = files.get("skill.json")!.toString("utf8");
  files.set("skill.json", Buffer.from(raw.replace('"license":"Apache-2.0"', '"license":"Apache-2.0","license":"MIT"')));
  assert.equal(verifyPackage(files, db).verdict, "INVALID_SCHEMA");
});

// ---- B-6: a log row that is not a countersign is not inclusion ----
//
// These two cases used to assert the opposite — that a non-countersign row
// whose `subject_id` was the manifest hash satisfied §4.4 step 6, giving
// `unverifiable_timing` with a revoked key and `valid` without one. That was
// the vulnerability written down as a guarantee: `kid` is caller-chosen over a
// charset that contains every 64-hex string, so an attacker could mint exactly
// such a row for a package the registry had never countersigned and collect a
// `valid` verdict. Step 6 now requires the `countersign` kind, so both cases
// are `NOT_LOGGED`. See test/tlog-namespace.test.ts for the attack in full.

test("B-6: revoked key + a non-countersign row on the manifest_hash → NOT_LOGGED", () => {
  const { db } = tvRegistry({ nonCountersignRowOnHash: true, keyRevokedAtMs: 1_754_000_001_000 });
  assert.equal(verifyPackage(tv01Package(), db).verdict, "NOT_LOGGED");
});

test("B-6: unrevoked key + a non-countersign row on the manifest_hash → NOT_LOGGED, never valid", () => {
  const { db } = tvRegistry({ nonCountersignRowOnHash: true });
  assert.equal(verifyPackage(tv01Package(), db).verdict, "NOT_LOGGED");
});

// ---- B-2: author/key binding ----

test("B-2: kid registered to a different agent than manifest.author_agent → UNKNOWN_KEY", () => {
  const { db } = tvRegistry({ keyOwnedByOtherAgent: true });
  assert.equal(verifyPackage(tv01Package(), db).verdict, "UNKNOWN_KEY");
});

// ---- M-1: publication couples transition + countersign ----

test("M-1: publishVersion transitions verified→published AND countersigns atomically", () => {
  const { db, versionId, mHash } = tvRegistry({ state: "verified", skipCountersign: true });
  const res = publishVersion(db, versionId, 1_754_000_099_000);
  assert.ok(res.transition.ok && !res.transition.noop);
  assert.ok(res.countersign);
  const row = db
    .prepare("SELECT count(*) c FROM transparency_log WHERE event_kind='countersign' AND subject_id=?")
    .get(mHash) as { c: number };
  assert.equal(row.c, 1);
  // idempotent republish: noop, no duplicate countersign
  const again = publishVersion(db, versionId, 1_754_000_100_000);
  assert.ok(again.transition.ok && again.transition.noop);
  const row2 = db
    .prepare("SELECT count(*) c FROM transparency_log WHERE event_kind='countersign' AND subject_id=?")
    .get(mHash) as { c: number };
  assert.equal(row2.c, 1);
});

test("M-1: publishVersion refuses illegal transitions (draft → published)", () => {
  const { db, versionId } = tvRegistry({ state: "draft", skipCountersign: true });
  const res = publishVersion(db, versionId);
  assert.ok(!res.transition.ok && res.transition.code === "PRECONDITION_FAILED");
});

// ---- M-2: duplicate manifest_hash rows resolve deterministically ----

test("M-2: verifier picks the LATEST (created_at_ms, id) version among duplicates", () => {
  const { db, mHash } = tvRegistry({ state: "published" });
  const skillRow = db.prepare("SELECT skill_id FROM skill_versions LIMIT 1").get() as { skill_id: string };
  const authorRow = db.prepare("SELECT author_agent_id FROM skill_versions LIMIT 1").get() as { author_agent_id: string };
  // later row with the SAME manifest_hash but state revoked
  const later = ulid(1_754_000_200_000);
  db.prepare(
    `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
       manifest_hash, content_hash, package_blob_ref, signature_jws, state, revocation_reason, created_at_ms)
     VALUES (?,?,?,?, '{}', ?, ?, 'blob:d', 'sig', 'revoked', 'dup', ?)`,
  ).run(later, skillRow.skill_id, "1.0.1", authorRow.author_agent_id, mHash, "f".repeat(64), 1_754_000_200_000);
  const out = verifyPackage(tv01Package(), db);
  assert.equal(out.verdict, "revoked", "deterministic: the later duplicate governs");
});

// ---- minor: true NFC/NFD collision pair ----

test("m-1: NFC member + NFD member of the same name → second rejected", () => {
  const nfc = "café.txt".normalize("NFC");
  const nfd = "café.txt".normalize("NFD");
  assert.notEqual(nfc, nfd, "fixture sanity");
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry(nfc, Buffer.from("a"), "0"), rawTarEntry(nfd, Buffer.from("b"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});
