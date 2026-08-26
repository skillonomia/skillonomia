// The SHIPPED public vectors are executed as-is: every vectors/<id> directory
// is loaded from disk and run through the real verifier / archive reader, and
// the observed verdict must equal its expected.json. This is what a third-party
// implementer runs against their own implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readDirectory, readPackage, ArchiveError } from "../src/archive.ts";
import { verifyPackage } from "../src/verify.ts";
import { verifyTlog } from "../src/tlog.ts";
import { tvRegistry, root } from "./vectors-helpers.ts";

const VECTORS_DIR = join(root, "vectors");

function registryFor(expected: any) {
  const r = expected.registry ?? {};
  if (r.key_revoked_at_ms === "after_countersign") return tvRegistry({ keyRevokedAtMs: 1_754_000_010_000 }).db;
  if (r.key_revoked_at_ms === "before_countersign") return tvRegistry({ keyRevokedAtMs: 1_754_000_001_000 }).db;
  if (r.version_state === "revoked") {
    return tvRegistry({ state: "revoked", revocationReason: r.revocation_reason ?? "revoked" }).db;
  }
  if (r.version_state === "superseded") return tvRegistry({ state: "superseded", supersededBy: true }).db;
  return tvRegistry().db;
}

const ids = readdirSync(VECTORS_DIR).sort();

test("the published vector suite covers TV-01…TV-12 incl. TV-11a–e", () => {
  for (const required of ["tv-01","tv-02","tv-03","tv-04","tv-05","tv-06","tv-07","tv-08","tv-09","tv-10","tv-11a","tv-11b","tv-11c","tv-11d","tv-11e","tv-12"]) {
    assert.ok(ids.includes(required), `vector ${required} must ship`);
  }
});

for (const id of ids) {
  const dir = join(VECTORS_DIR, id);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));

  test(`shipped vector ${id}: ${expected.description} → ${expected.expected_verdict}`, () => {
    // archive-form vectors: the reader itself must produce the verdict
    for (const archiveName of ["package.tar", "package.tar.gz"]) {
      if (!existsSync(join(dir, archiveName))) continue;
      try {
        readPackage(join(dir, archiveName));
        assert.fail(`${id}: expected ${expected.expected_verdict}, archive parsed cleanly`);
      } catch (e) {
        assert.ok(e instanceof ArchiveError, `${id}: expected ArchiveError, got ${e}`);
        assert.equal((e as ArchiveError).code, expected.expected_verdict);
        return;
      }
    }

    // chain vector: reproduce the tamper and let verify-log detect it
    if (expected.expected_verdict === "CHAIN_BROKEN") {
      const { db } = tvRegistry();
      db.exec("DROP TRIGGER tg_tlog_no_upd");
      db.exec(String(expected.registry.tamper));
      const res = verifyTlog(db);
      assert.equal(res.ok, false, `${id}: chain tamper must be detected`);
      return;
    }

    // package-form vectors: run the real §4.4 verifier
    const files = readDirectory(join(dir, "package"));
    const out = verifyPackage(files, registryFor(expected));
    assert.equal(out.verdict, expected.expected_verdict, `${id} detail: ${out.detail ?? ""}`);
    if (out.verdict === "valid_superseded") assert.ok(out.successor_version_id);
    if (out.verdict === "revoked") assert.equal(out.revocation_reason, expected.registry.revocation_reason);
  });
}
