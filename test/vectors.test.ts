// §4.5 test vectors TV-01…TV-12 (incl. TV-11a–e) — the P1 gate list, complete.
// TV-01 asserts EVERY Appendix F intermediate byte-for-byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jcsCanonicalize, jcsBytes } from "../src/jcs.ts";
import { keyFromSeedHex, signManifest, manifestHash, protectedHeaderBytes, signingInput, b64url } from "../src/signing.ts";
import { validateManifest } from "../src/manifest.ts";
import { readTar, writeTar, gunzipLimited, ArchiveError, computeIntegrity, type PackageFiles } from "../src/archive.ts";
import { verifyPackage } from "../src/verify.ts";
import { appendTlog, verifyTlog } from "../src/tlog.ts";
import { openMigrated } from "../src/db.ts";
import {
  TV_SEED_HEX, TV_KID, TV_PUB_B64URL, TV_SKILL_MD, TV_FIXTURE_SH,
  appendixFJcs, tv01Manifest, tv01Package, tvRegistry, root,
} from "./vectors-helpers.ts";

// ---------- Appendix F byte-level intermediates ----------

test("Appendix F: file hashes of the package members", () => {
  assert.equal(createHash("sha256").update(TV_SKILL_MD, "utf8").digest("hex"),
    "9aa9fcc8c19358ef683f752e3dc2f5462661f3e4770a80b484737d8528cafbbb");
  assert.equal(createHash("sha256").update(TV_FIXTURE_SH, "utf8").digest("hex"),
    "956e69331b9fb00e1d465eda3c6a8ed508163fe90428541e3b6d4c645529b360");
});

test("Appendix F: JCS(M) reproduced byte-for-byte (1889 bytes)", () => {
  const expected = appendixFJcs();
  assert.equal(Buffer.byteLength(expected, "utf8"), 1889, "spec line is 1889 bytes");
  const ours = jcsCanonicalize(tv01Manifest());
  assert.equal(ours, expected);
});

test("Appendix F: deterministic key, manifest_hash, D, P, signing input, signature, JWS", () => {
  const { privateKey, publicKeyB64url } = keyFromSeedHex(TV_SEED_HEX);
  assert.equal(publicKeyB64url, TV_PUB_B64URL);

  const manifest = tv01Manifest();
  assert.equal(manifestHash(manifest), "5498c4f560409b1dbdf78794d5072a36672e54c825dbad6d0f1b89ea5fd794d0");

  const { input, d, p } = signingInput(manifest, TV_KID);
  assert.equal(b64url(d), "VJjE9WBAmx2994eU1QcqNmcuVMgl261tDxuJ6l_XlNA");
  assert.equal(p.toString("ascii"), '{"alg":"EdDSA","kid":"tv-key-1"}');
  assert.equal(p.length, 32);
  assert.equal(b64url(p), "eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0");
  assert.equal(input, "eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0.VJjE9WBAmx2994eU1QcqNmcuVMgl261tDxuJ6l_XlNA");
  assert.equal(input.length, 87);

  const { jws } = signManifest(manifest, privateKey, TV_KID);
  const sigB64 = jws.split("..")[1];
  assert.equal(sigB64, "pOKoUX1sVgwSe65Ml1MpF9VKil_SVUb9D5Y38LkMDNKCfbcZJE1j8zigg7LGiVo7wZgTyHEa2DIgy8BTM3FCAg");
  assert.equal(sigB64.length, 86);
  assert.equal(jws, "eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0..pOKoUX1sVgwSe65Ml1MpF9VKil_SVUb9D5Y38LkMDNKCfbcZJE1j8zigg7LGiVo7wZgTyHEa2DIgy8BTM3FCAg");
  assert.equal(jws.length, 131);
});

test("Appendix F: manifest validates against Appendix E with 0 errors; integrity matches", () => {
  const res = validateManifest(tv01Manifest());
  assert.deepEqual(res.errors, []);
  assert.equal(res.valid, true);
  const integrity = computeIntegrity(tv01Package());
  assert.deepEqual(integrity, tv01Manifest().integrity);
});

// ---------- TV-01 … TV-12 ----------

test("TV-01 valid signed package → valid", () => {
  const { db } = tvRegistry();
  assert.equal(verifyPackage(tv01Package(), db).verdict, "valid");
});

test("TV-02 one byte changed in SKILL.md → TAMPERED_CONTENT", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const tampered = Buffer.from(files.get("SKILL.md")!);
  tampered[0] ^= 0x01;
  files.set("SKILL.md", tampered);
  assert.equal(verifyPackage(files, db).verdict, "TAMPERED_CONTENT");
});

test("TV-03 manifest fields reordered → valid (JCS proof)", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const m = tv01Manifest();
  // rebuild the object with reversed key order and re-serialize non-canonically
  const reordered: Record<string, unknown> = {};
  for (const k of Object.keys(m).reverse()) reordered[k] = m[k];
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(m), "fixture sanity: raw JSON differs");
  assert.equal(manifestHash(reordered as any), manifestHash(m), "JCS reorder-invariance");
  files.set("skill.json", Buffer.from(JSON.stringify(reordered, null, 2), "utf8"));
  assert.equal(verifyPackage(files, db).verdict, "valid");
});

test("TV-04 key revoked AFTER countersign → valid_but_key_since_revoked", () => {
  const { db } = tvRegistry({ keyRevokedAtMs: 1_754_000_010_000 }); // countersign at +5000
  assert.equal(verifyPackage(tv01Package(), db).verdict, "valid_but_key_since_revoked");
});

test("TV-05 key revoked BEFORE countersign → invalid_key_revoked_at_signing", () => {
  const { db } = tvRegistry({ keyRevokedAtMs: 1_754_000_001_000 });
  assert.equal(verifyPackage(tv01Package(), db).verdict, "invalid_key_revoked_at_signing");
});

test("TV-06 unknown kid → UNKNOWN_KEY", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const { privateKey } = keyFromSeedHex(TV_SEED_HEX);
  const { jws } = signManifest(tv01Manifest(), privateKey, "no-such-kid");
  files.set("SIGNATURE.jws", Buffer.from(jws, "utf8"));
  assert.equal(verifyPackage(files, db).verdict, "UNKNOWN_KEY");
});

test("TV-06b wrong key for kid → BAD_SIGNATURE", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const other = keyFromSeedHex("ff".repeat(32));
  const { jws } = signManifest(tv01Manifest(), other.privateKey, TV_KID);
  files.set("SIGNATURE.jws", Buffer.from(jws, "utf8"));
  assert.equal(verifyPackage(files, db).verdict, "BAD_SIGNATURE");
});

test("TV-07 schema-invalid manifest → INVALID_SCHEMA", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const m = tv01Manifest();
  delete m.scope; // required group removed
  files.set("skill.json", Buffer.from(JSON.stringify(m), "utf8"));
  assert.equal(verifyPackage(files, db).verdict, "INVALID_SCHEMA");
});

test("TV-07b unknown extra field → INVALID_SCHEMA (additionalProperties:false; x_ext is the only extension point)", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  const m = tv01Manifest();
  m.totally_unknown_field = 1;
  files.set("skill.json", Buffer.from(JSON.stringify(m), "utf8"));
  assert.equal(verifyPackage(files, db).verdict, "INVALID_SCHEMA");
  const m2 = tv01Manifest();
  m2.x_ext = { anything: true };
  const res = validateManifest(m2);
  assert.equal(res.valid, true, "x_ext must remain allowed");
});

test("TV-08 revoked version → revoked (with reason)", () => {
  const { db } = tvRegistry({ state: "revoked" });
  db.exec("UPDATE skill_versions SET revocation_reason='security issue' WHERE revocation_reason IS NULL");
  const out = verifyPackage(tv01Package(), db);
  assert.equal(out.verdict, "revoked");
  assert.equal(out.revocation_reason, "security issue");
});

test("TV-09 superseded version → valid_superseded with successor attached", () => {
  const { db } = tvRegistry({ state: "superseded", supersededBy: true });
  const out = verifyPackage(tv01Package(), db);
  assert.equal(out.verdict, "valid_superseded");
  assert.ok(out.successor_version_id, "successor id attached");
});

test("TV-09b deprecated → valid_deprecated; unlisted manifest → not_verified; missing countersign → NOT_LOGGED", () => {
  assert.equal(verifyPackage(tv01Package(), tvRegistry({ state: "deprecated" }).db).verdict, "valid_deprecated");
  assert.equal(verifyPackage(tv01Package(), tvRegistry({ state: "reviewed" }).db).verdict, "not_verified");
  assert.equal(verifyPackage(tv01Package(), tvRegistry({ skipCountersign: true }).db).verdict, "NOT_LOGGED");
});

test("TV-10 hash-chain break → detected by verify-log", () => {
  const db = openMigrated();
  appendTlog(db, "countersign", "s1", { a: 1 }, 1_754_000_000_000);
  appendTlog(db, "countersign", "s2", { a: 2 }, 1_754_000_000_001);
  db.exec("DROP TRIGGER tg_tlog_no_upd");
  db.exec("UPDATE transparency_log SET subject_id='forged' WHERE seq=1");
  const res = verifyTlog(db);
  assert.equal(res.ok, false);
  assert.equal(res.failed_seq, 1);
});

// ---------- TV-11a–e adversarial archives, TV-12 bomb ----------

function rawTarEntry(name: string, data: Buffer, typeflag: string, linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header[156] = typeflag.charCodeAt(0);
  header.write(linkname, 157, "utf8");
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = Math.ceil(data.length / 512) * 512 - data.length;
  return Buffer.concat([header, data, Buffer.alloc(pad)]);
}

function tarOf(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

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

test("TV-11a `../` path traversal → MALFORMED_ARCHIVE", () => {
  expectArchiveError(() => readTar(tarOf(rawTarEntry("../evil.sh", Buffer.from("x"), "0"))), "MALFORMED_ARCHIVE");
});

test("TV-11b absolute path → MALFORMED_ARCHIVE", () => {
  expectArchiveError(() => readTar(tarOf(rawTarEntry("/etc/passwd", Buffer.from("x"), "0"))), "MALFORMED_ARCHIVE");
});

test("TV-11c symlink member → MALFORMED_ARCHIVE (hardlink too)", () => {
  expectArchiveError(() => readTar(tarOf(rawTarEntry("link", Buffer.alloc(0), "2", "/etc/passwd"))), "MALFORMED_ARCHIVE");
  expectArchiveError(() => readTar(tarOf(rawTarEntry("hlink", Buffer.alloc(0), "1", "SKILL.md"))), "MALFORMED_ARCHIVE");
});

test("TV-11d duplicate member → MALFORMED_ARCHIVE", () => {
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("SKILL.md", Buffer.from("a"), "0"), rawTarEntry("SKILL.md", Buffer.from("b"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

test("TV-11e case-insensitive and NFC/NFD collisions → MALFORMED_ARCHIVE", () => {
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("Skill.md", Buffer.from("a"), "0"), rawTarEntry("skill.MD", Buffer.from("b"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  const nfd = "café".normalize("NFD");
  expectArchiveError(() => readTar(tarOf(rawTarEntry(nfd, Buffer.from("x"), "0"))), "MALFORMED_ARCHIVE");
});

test("TV-11f backslash and device/fifo entries → MALFORMED_ARCHIVE", () => {
  expectArchiveError(() => readTar(tarOf(rawTarEntry("a\\b", Buffer.from("x"), "0"))), "MALFORMED_ARCHIVE");
  expectArchiveError(() => readTar(tarOf(rawTarEntry("dev", Buffer.alloc(0), "3"))), "MALFORMED_ARCHIVE");
  expectArchiveError(() => readTar(tarOf(rawTarEntry("fifo", Buffer.alloc(0), "6"))), "MALFORMED_ARCHIVE");
});

test("TV-12 decompression bomb → LIMIT_EXCEEDED (ratio and size caps)", () => {
  const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024)); // 32 MiB zeros → tiny gz, ratio ≫ 100
  expectArchiveError(() => gunzipLimited(bomb), "LIMIT_EXCEEDED");
  const overCap = gzipSync(Buffer.alloc(70 * 1024 * 1024)); // > 64 MiB output cap
  expectArchiveError(() => gunzipLimited(overCap), "LIMIT_EXCEEDED");
});

test("limits: >512 files and >4 MiB single file → LIMIT_EXCEEDED", () => {
  const entries: Buffer[] = [];
  for (let i = 0; i < 513; i++) entries.push(rawTarEntry(`f${i}.txt`, Buffer.from("x"), "0"));
  expectArchiveError(() => readTar(tarOf(...entries)), "LIMIT_EXCEEDED");
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("big.bin", Buffer.alloc(4 * 1024 * 1024 + 1), "0"))),
    "LIMIT_EXCEEDED",
  );
});

test("round-trip: conforming packer output re-reads identically (incl. pax-free ustar)", () => {
  const files: PackageFiles = tv01Package();
  const tar = writeTar(files);
  const back = readTar(tar);
  assert.deepEqual([...back.keys()].sort(), [...files.keys()].sort());
  for (const [p, b] of files) assert.ok(back.get(p)!.equals(b), `bytes differ: ${p}`);
});

// ---------- registry-side groups stay OUT of the signed manifest ----------

test("signed manifest carries no registry-side groups (state/superseded_by/receipts/reputation)", () => {
  const m = tv01Manifest();
  for (const k of ["state", "superseded_by", "deprecation_date", "revocation_reason", "receipt_ids", "reviewer_note", "reputation"]) {
    assert.ok(!(k in m), `${k} must not be in signed manifest`);
  }
  // and the schema REJECTS them if smuggled in
  const bad = tv01Manifest();
  bad.state = "published";
  assert.equal(validateManifest(bad).valid, false);
});

test("schema files are byte-identical to the spec's Appendix E blocks", () => {
  const spec = readFileSync(join(root, "SPEC.md"), "utf8");
  const e1 = /## Appendix E\. NORMATIVE JSON Schema.*?```json\n(.*?)\n```/s.exec(spec)![1];
  assert.equal(readFileSync(join(root, "schema", "skill-package-v1.schema.json"), "utf8"), e1 + "\n");
  const re = /\*\*`([a-z-]+-v1\.schema\.json)`\*\*.*?```json\n(.*?)\n```/gs;
  let m2: RegExpExecArray | null;
  let count = 0;
  while ((m2 = re.exec(spec)) !== null) {
    count++;
    assert.equal(readFileSync(join(root, "schema", m2[1]), "utf8"), m2[2] + "\n", m2[1]);
  }
  assert.equal(count, 5, "all five E.2 sub-schemas covered");
});
