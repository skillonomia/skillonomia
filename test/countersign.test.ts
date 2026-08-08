// §4.3.8 countersign: publish writes a tlog entry binding manifest_hash to
// server time; the committed vectors/tv-01 package verifies end-to-end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { publishVersion } from "../src/countersign.ts";
import { verifyTlog } from "../src/tlog.ts";
import { verifyPackage, COUNTERSIGN_EVENT } from "../src/verify.ts";
import { readDirectory } from "../src/archive.ts";
import { tvRegistry, root, appendixFJcs, TV_SKILL_MD, TV_FIXTURE_SH } from "./vectors-helpers.ts";

test("publishVersion appends a chain-valid countersign row bound to manifest_hash + server time", () => {
  const { db, versionId, mHash } = tvRegistry({ state: "verified", skipCountersign: true });
  const t = 1_754_000_042_000;
  const row = publishVersion(db, versionId, t).countersign!;
  assert.equal(row.event_kind, COUNTERSIGN_EVENT);
  assert.equal(row.subject_id, mHash);
  assert.equal(row.server_at_ms, t);
  assert.deepEqual(verifyTlog(db), { ok: true, checked: 1 });
  // verifier now reaches `valid` through this countersign
  assert.equal(verifyPackage(readDirectory(join(root, "vectors", "tv-01", "package")), db).verdict, "valid");
});

test("shipped vectors/tv-01 files match the regenerable byte-exact artifact", () => {
  const dir = join(root, "vectors", "tv-01", "package");
  assert.ok(existsSync(dir), "vectors/tv-01 must be committed");
  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), TV_SKILL_MD);
  assert.equal(readFileSync(join(dir, "fixtures", "tv01.sh"), "utf8"), TV_FIXTURE_SH);
  assert.equal(readFileSync(join(dir, "skill.json"), "utf8"), appendixFJcs());
  const expected = JSON.parse(readFileSync(join(dir, "..", "expected.json"), "utf8"));
  assert.equal(expected.vector, "TV-01");
  assert.equal(expected.expected_verdict, "valid");
  assert.equal(
    readFileSync(join(dir, "SIGNATURE.jws"), "utf8"),
    "eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0..pOKoUX1sVgwSe65Ml1MpF9VKil_SVUb9D5Y38LkMDNKCfbcZJE1j8zigg7LGiVo7wZgTyHEa2DIgy8BTM3FCAg",
  );
});
