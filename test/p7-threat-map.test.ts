// P7 — the red-team acceptance suite is closed at one test per §8 row: exactly
// ten, TM-01 through TM-10. The count is DERIVED from the committed spec's own
// §8 table rather than written down here, so the map cannot silently drift from
// the threat model it claims to cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetRoot } from "../src/assets.ts";

/** The §8 table rows of SPEC.md, in order, as `[number, threat]`. */
function threatRows(): Array<[number, string]> {
  const spec = readFileSync(join(assetRoot(), "SPEC.md"), "utf8").split("\n");
  const start = spec.findIndex((l) => l.startsWith("## 8. Threat Model"));
  assert.ok(start > 0, "§8 is in the spec");
  const rows: Array<[number, string]> = [];
  for (let i = start; i < spec.length; i++) {
    if (i > start && spec[i].startsWith("## ")) break;
    const m = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/.exec(spec[i]);
    if (m) rows.push([Number(m[1]), m[2]]);
  }
  return rows;
}

function threatSuite(): string[] {
  const src = readFileSync(join(assetRoot(), "test", "p7-threats.test.ts"), "utf8");
  return [...src.matchAll(/^test\("(TM-\d+)[^"]*"/gm)].map((m) => m[1]);
}

test("§8 has exactly ten rows, and the suite has exactly ten TM tests — one per row, in order", () => {
  const rows = threatRows();
  assert.equal(rows.length, 10, "§8 is a Top-10 table");
  assert.deepEqual(
    rows.map(([n]) => n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );

  const tests = threatSuite();
  assert.deepEqual(
    tests,
    ["TM-01", "TM-02", "TM-03", "TM-04", "TM-05", "TM-06", "TM-07", "TM-08", "TM-09", "TM-10"],
    "exactly ten tests, one per §8 row, named and ordered by it — no eleventh category",
  );
  assert.equal(tests.length, rows.length, "one executable red-team test per §8 row");
});

test("each TM test names the §8 row it covers, so the mapping is readable in the file itself", () => {
  const src = readFileSync(join(assetRoot(), "test", "p7-threats.test.ts"), "utf8");
  const rows = threatRows();
  for (const [n, threat] of rows) {
    const tag = `TM-${String(n).padStart(2, "0")}`;
    const marker = `// §8 row ${n} —`;
    assert.ok(src.includes(marker), `${tag} declares which §8 row it covers`);
    // the first significant word of the row's threat text appears in that block,
    // so a renumbered table cannot go unnoticed
    const word = threat.split(/[\s/,]+/).find((w) => w.length > 5) ?? threat;
    const block = src.slice(src.indexOf(marker), src.indexOf(marker) + 600);
    assert.ok(
      block.toLowerCase().includes(word.toLowerCase()),
      `${tag}'s block mentions "${word}" from the §8 row it claims`,
    );
  }
});
