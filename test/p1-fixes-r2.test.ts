// Regression suite for P1 review verdict 2 (BLOCKED on 49fcf22).
// One test per finding; each must fail against the 49fcf22 behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcsCanonicalize, utf8Decode } from "../src/jcs.ts";
import { validateManifest } from "../src/manifest.ts";
import { verifyJws, signManifest, keyFromSeedHex, manifestHash } from "../src/signing.ts";
import { readTar, readDirectory, writeTar, ArchiveError, checkPath, type PackageFiles } from "../src/archive.ts";
import { verifyPackage } from "../src/verify.ts";
import { transitionVersion } from "../src/transitions.ts";
import { publishVersion } from "../src/countersign.ts";
import { verifyTlog } from "../src/tlog.ts";
import {
  tvRegistry, tv01Package, tv01Manifest, rawTarEntry, tarOf, paxEntry, paxRecord,
  TV_SEED_HEX, TV_KID, root,
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

// ---- B-1: canonicalization completeness over the schema-valid domain ----

test("B-1: lone surrogate in a MEMBER NAME is rejected (not only in values)", () => {
  assert.throws(() => jcsCanonicalize({ ["bad\ud800name"]: 1 }), /lone surrogate in member name/);
  assert.throws(() => jcsCanonicalize({ x_ext: { ["\udfff"]: true } }), /lone surrogate in member name/);
});

test("B-1: finite non-integer numbers canonicalize (x_ext may legitimately carry them)", () => {
  assert.equal(jcsCanonicalize({ a: 1.5 }), '{"a":1.5}');
  assert.equal(jcsCanonicalize({ a: -0.25, b: 1e21, c: 5e-7 }), '{"a":-0.25,"b":1e+21,"c":5e-7}');
  assert.throws(() => jcsCanonicalize({ a: NaN as unknown as number }), /non-finite/);
  assert.throws(() => jcsCanonicalize({ a: Infinity as unknown as number }), /non-finite/);
});

test("B-1: a schema-valid manifest carrying fractional x_ext values signs and verifies", () => {
  const m = tv01Manifest();
  m.x_ext = { weight: 0.5, ratio: -1.25 };
  assert.equal(validateManifest(m).valid, true, "schema accepts fractional x_ext");
  const { privateKey } = keyFromSeedHex(TV_SEED_HEX);
  const { jws } = signManifest(m, privateKey, TV_KID);
  assert.equal(verifyJws(m, jws, "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg").ok, true);
  assert.match(manifestHash(m), /^[0-9a-f]{64}$/);
});

// ---- B-2: strict UTF-8 for skill.json ----

test("B-2: invalid UTF-8 in skill.json → INVALID_SCHEMA (never replacement-decoded)", () => {
  assert.throws(() => utf8Decode(Buffer.from([0x7b, 0xff, 0x7d])), /./);
  const { db } = tvRegistry();
  const files = tv01Package();
  const raw = files.get("skill.json")!;
  const broken = Buffer.concat([raw.subarray(0, raw.length - 1), Buffer.from([0xff]), Buffer.from("}")]);
  const out = verifyPackage(new Map(files).set("skill.json", broken), db);
  assert.equal(out.verdict, "INVALID_SCHEMA");
});

// ---- B-3: publication is inseparable from countersigning ----

test("B-3: generic transitionVersion cannot reach `published`", () => {
  const { db, versionId } = tvRegistry({ state: "verified", skipCountersign: true });
  const res = transitionVersion(db, versionId, "published");
  assert.ok(!res.ok && res.code === "USE_PUBLISH_VERSION");
  const state = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as { state: string };
  assert.equal(state.state, "verified", "state must not move");
});

test("B-3: publication is transactional — a failing countersign leaves no published state", () => {
  const { db, versionId } = tvRegistry({ state: "verified", skipCountersign: true });
  db.exec("CREATE TRIGGER block_tlog BEFORE INSERT ON transparency_log BEGIN SELECT RAISE(ABORT,'forced'); END");
  assert.throws(() => publishVersion(db, versionId, 1_754_000_050_000), /forced/);
  const state = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as { state: string };
  assert.equal(state.state, "verified");
  const c = db.prepare("SELECT count(*) c FROM transparency_log").get() as { c: number };
  assert.equal(c.c, 0);
});

test("B-3: a pre-seeded countersign blocks publication (its timestamp would fix the revocation clock)", () => {
  const { db, versionId } = tvRegistry({ state: "verified" }); // fixture countersigns early
  const res = publishVersion(db, versionId, 1_754_000_060_000);
  assert.ok(!res.transition.ok && res.transition.code === "CONFLICT");
  const state = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as { state: string };
  assert.equal(state.state, "verified");
});

test("B-3: published state always has exactly one countersign; chain stays valid", () => {
  const { db, versionId, mHash } = tvRegistry({ state: "verified", skipCountersign: true });
  publishVersion(db, versionId, 1_754_000_070_000);
  publishVersion(db, versionId, 1_754_000_080_000); // idempotent
  const c = db
    .prepare("SELECT count(*) c FROM transparency_log WHERE event_kind='countersign' AND subject_id=?")
    .get(mHash) as { c: number };
  assert.equal(c.c, 1);
  assert.equal(verifyTlog(db).ok, true);
});

// ---- B-4: archive input classes ----

test("B-4: NUL and control characters in a pax path → MALFORMED_ARCHIVE", () => {
  const records = paxRecord("path", "ev\u0000il.txt");
  expectArchiveError(
    () => readTar(tarOf(paxEntry(records), rawTarEntry("innocent.txt", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-4: Windows-absolute paths → MALFORMED_ARCHIVE (a leading tilde is an ordinary name)", () => {
  for (const p of ["C:/Windows/system32/x", "D:evil.txt"]) {
    assert.throws(() => checkPath(p), ArchiveError, p);
  }
  expectArchiveError(() => readTar(tarOf(rawTarEntry("C:/x.txt", Buffer.from("x"), "0"))), "MALFORMED_ARCHIVE");
});

test("B-4: non-ustar (v7) header → MALFORMED_ARCHIVE", () => {
  const entry = rawTarEntry("a.txt", Buffer.from("x"), "0");
  entry.write("\0\0\0\0\0\0", 257); // clear ustar magic
  entry.write("        ", 148);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += entry[i];
  entry.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  expectArchiveError(() => readTar(tarOf(entry)), "MALFORMED_ARCHIVE");
});

test("B-4: packer rejects ill-formed-Unicode and non-NFC paths", () => {
  const bad: PackageFiles = new Map([["a\ud800b.txt", Buffer.from("x")]]);
  assert.throws(() => writeTar(bad), ArchiveError);
  const nfd: PackageFiles = new Map([["café.txt".normalize("NFD"), Buffer.from("x")]]);
  assert.throws(() => writeTar(nfd), ArchiveError);
});

test("B-4: plain-directory reader applies directory collision accounting and path rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-dir-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "a.txt"), "x");
  // sanity: a well-formed directory reads fine
  assert.deepEqual([...readDirectory(dir).keys()], ["sub/a.txt"]);

  const dir2 = mkdtempSync(join(tmpdir(), "sklo-dir2-"));
  mkdirSync(join(dir2, "café".normalize("NFD")), { recursive: true });
  writeFileSync(join(dir2, "café".normalize("NFD"), "f.txt"), "x");
  expectArchiveError(() => readDirectory(dir2), "MALFORMED_ARCHIVE");
});

// ---- minor: vector ids keep the normative lowercase suffix ----

test("m-1: shipped vector ids use the normative lowercase suffixes (TV-11a, not TV-11A)", () => {
  for (const id of ["tv-11a", "tv-11b", "tv-11c", "tv-11d", "tv-11e", "tv-11f"]) {
    const e = JSON.parse(readFileSync(join(root, "vectors", id, "expected.json"), "utf8"));
    assert.equal(e.vector, "TV-" + id.slice(3));
  }
});
