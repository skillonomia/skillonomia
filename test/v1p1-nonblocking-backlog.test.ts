import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET_SCAN = join(REPO_ROOT, "v1", "tools", "p0-secret-scan.sh");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "skillonomia-v11-backlog-"));
}

test("the secret sweep scans binary bytes and catches every Console credential prefix after a word byte", () => {
  const dir = tempDir();
  try {
    const credentials = [
      ["console-ticket.bin", ["ct", "ticket0123456789"].join("_")],
      ["console-session.sqlite", ["cs", "session012345678"].join("_")],
      ["csrf-token.bin", ["cx", "csrf012345678901"].join("_")],
    ] as const;

    for (const [name, credential] of credentials) {
      const header = name.endsWith(".sqlite") ? Buffer.from("SQLite format 3\0", "ascii") : Buffer.from([0, 1, 2, 0]);
      // The `A` is deliberately adjacent to the prefix. A scanner using a word
      // boundary before the prefix would miss this even after binary handling
      // was repaired.
      writeFileSync(join(dir, name), Buffer.concat([header, Buffer.from(`A${credential}\n`, "ascii")]));
    }

    // This is the exact old binary policy, exercised against the new console
    // shapes: GNU grep classifies every fixture above as binary and prints no
    // match. The assertion makes the regression's RED premise deterministic.
    const old = spawnSync("grep", ["-rIEno", "c[tsx]_[A-Za-z0-9_-]{16,}", dir], { encoding: "utf8" });
    assert.equal(old.status, 1, `the old -I behavior unexpectedly found a credential: ${old.stdout}`);

    const scanned = spawnSync("bash", [SECRET_SCAN, dir], { encoding: "utf8" });
    assert.equal(scanned.status, 1, `binary Console credentials passed the sweep:\n${scanned.stdout}\n${scanned.stderr}`);
    for (const [name, credential] of credentials) {
      assert.match(scanned.stdout, new RegExp(`${name.replace(".", "\\.")}:1: <match suppressed>`));
      assert.ok(!scanned.stdout.includes(credential), `the report disclosed the matched value from ${name}`);
      assert.ok(!scanned.stderr.includes(credential), `stderr disclosed the matched value from ${name}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the byte-preserving secret sweep still excuses an exactly pinned fixture", () => {
  const dir = tempDir();
  try {
    const pinned = ["sk", "live", "4ec39hqlyjwdarjtt1zdp7dc"].join("_");
    writeFileSync(join(dir, "fixture.bin"), Buffer.concat([Buffer.from([0]), Buffer.from(pinned, "ascii")]));
    const output = execFileSync("bash", [SECRET_SCAN, dir], { encoding: "utf8" });
    assert.match(output, /excused: 1 match\(es\)/);
    assert.match(output, /PASS  no credential-shaped value/);
    assert.ok(!output.includes(pinned), "the pinned fixture value was copied into the scan report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
