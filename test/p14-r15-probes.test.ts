// ROUND 15 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks are composed from
// the STATEMENT OF THE REQUIREMENT, committed first, and must FAIL on the code
// as it stands. A probe written after the fix cannot discriminate — it was
// shaped by the answer.
//
// WHY THIS ROUND EXISTS.
//
//   The publication candidate was REFUSED by GitHub push protection (GH013).
//   The scanner recognised a Stripe secret key in this repository's own probes:
//   `sk_live_…` written as a LITERAL, captioned "a token-shaped key inside the
//   form". There is no real credential anywhere in the tree. The [9.5] probe is
//   REQUIRED to present strings that look like secrets and pass the identifier
//   form — that is the attack it exists to run — so the finding is false by
//   construction. It still blocks publication, permanently, and a false
//   positive nobody can clear is indistinguishable from a true one.
//
// THE PROJECT ALREADY SOLVED THIS AND WROTE THE ANSWER DOWN. `test/p7-threats
// .test.ts`, TM-03:
//
//     // The tokens this test leaks are assembled from fragments at run time,
//     // not written as literals: push-side secret scanners match the blob and
//     // would block the push on a red-team fixture.
//     const PAT_TOKEN = ["ghp", "_0123456789", "abcdefghijklmnopqrstuvwxyz"].join("");
//
// That is exactly why the `ghp_` fixtures did NOT block the push: no complete
// literal is in the file. The round-9 and round-10 probes broke the convention
// by writing theirs out. Nothing here is a new technique; this round applies
// the repository's own technique where it was forgotten, and then makes
// forgetting it again fail the build.
//
// THE REQUIREMENT:
//
//   NO FILE THIS REPOSITORY TRACKS MAY CONTAIN A STRING MATCHING A DECLARED
//   SECRET SIGNATURE. A regular expression that DESCRIBES the shape is legal
//   and must pass; a literal that HAS the shape is not.
//
// WHERE THE PATTERN SET COMES FROM — D-12, "the set is taken from the system
// that knows it":
//
//   THE PRODUCT'S OWN TABLE. `SECRET_PATTERNS` is IMPORTED from `src/gates.ts`,
//   not parsed, not copied and not re-typed. The guard therefore cannot drift
//   from the detector this registry ships: adding a pattern there adds it here,
//   and [15.2] then demands a live sample for it before the suite is green
//   again.
//
//   PLUS WHAT THE PUSH-SIDE SCANNER APPLIES AND THE PRODUCT DOES NOT MODEL.
//   Stripe's `sk_live_`/`sk_test_` shape is not in `SECRET_PATTERNS`, and it is
//   the shape that actually stopped the publication. It is declared in a
//   SEPARATE table, `PUSH_SIDE_PATTERNS`, each entry carrying the source of its
//   authority in the entry itself — so nothing here is passed off as part of
//   the product's detector.
//
// WHERE THE FILE SET COMES FROM.
//
//   `git ls-files` — every tracked file, INCLUDING `test/`. Three reasons, and
//   the third is the operative one:
//
//     · `npm pack` does not ship `test/`, and `test/` is where the blocking
//       literals were. A guard over the package set would have been green
//       through the whole incident.
//     · The public tree is PRODUCED FROM the tracked tree by
//       `tools/build-public-mirror.sh`, so every tracked file is a candidate
//       for mirroring; the superset needs no second definition of "public" and
//       cannot fall out of step with that script.
//     · There are no path exemptions at all. A list of exempt paths is the
//       defect this project is named for: it grows by one line every time the
//       guard is inconvenient, and each line is invisible afterwards.
//
// THE DISCRIMINATION THAT MAKES THE GUARD IMPLEMENTABLE. `src/gates.ts` is
// FROZEN and contains all six patterns; `SPEC.md:4030` documents them. Both
// must pass, and both do WITHOUT being named anywhere: plain matching already
// tells the two apart. The text `/\bghp_[A-Za-z0-9]{36}\b/` does not match the
// `github-token` pattern, because what follows `ghp_` there is `[`, and `[` is
// not in `[A-Za-z0-9]`. [15.3] asserts this as a property of every pattern in
// the table rather than trusting it: a pattern for which it stops holding fails
// that probe and demands an answer in the open, instead of an exemption.
//
// THE LIMIT OF THIS GUARD, STATED HERE BECAUSE A COMMENT MAY NOT PROMISE MORE
// THAN THE CODE DOES (D-16 §4, D-20). The set of vendors is unbounded and the
// set of scanners is not published. This guard proves exactly one thing:
//
//     NO TRACKED FILE CONTAINS A STRING MATCHING A PATTERN IN *THIS* TABLE.
//
// It does not prove that the tree holds no secret, and it cannot promise that
// the next push will not be refused by a signature nobody here has seen. When a
// scanner refuses a push on a shape this table lacks, the shape is added to
// `PUSH_SIDE_PATTERNS` with its source, and the tree is brought back into line.
//
// THE PROBES:
//
//   15.1 the table is the product's own set plus separately-sourced additions,
//        and nothing enters it unsourced.
//   15.2 every pattern in the table is LIVE: an assembled sample of each shape
//        is found by the scanner. A pattern with no sample fails.
//   15.3 a regular expression that DESCRIBES a shape is not a string that HAS
//        it — asserted per pattern, so the frozen files pass for a reason.
//   15.4 THE SWEEP: every tracked file, no exemptions. This is the probe that
//        is RED before the fix.
//   15.5 the mutations, run against synthetic file sets so they are permanent:
//        a restored literal fails, a new file carrying a token-shaped string
//        fails, and the real bytes of `src/gates.ts` do not.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SECRET_PATTERNS } from "../src/gates.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// ===========================================================================
// THE TABLE
// ===========================================================================

interface ScannerPattern {
  id: string;
  re: RegExp;
  /** Where this pattern's authority comes from. Read by [15.1]; no entry
   *  without one. */
  source: string;
}

/** The product's own detector, imported rather than restated. */
const PRODUCT_PATTERNS: readonly ScannerPattern[] = SECRET_PATTERNS.map((p) => ({
  id: p.id,
  re: p.re,
  source: "src/gates.ts SECRET_PATTERNS — the detector this registry ships",
}));

/**
 * Shapes a PUSH-SIDE scanner applies that the product does not model. These are
 * NOT part of `SECRET_PATTERNS` and are not presented as such.
 *
 * `stripe-secret-key` is here empirically: GitHub push protection refused the
 * publication candidate `bdc99bdd` with GH013 on exactly this shape, naming
 * `test/p14-r9-probes.test.ts` and `test/p14-r9b-probes.test.ts`. The blocked
 * value carried 24 alphanumerics after the prefix; the length here is widened
 * to sixteen-or-more so that a near-miss variant of the same fixture cannot
 * slip past the guard that the original tripped. Underscores are excluded, as
 * the vendor's own shape excludes them.
 */
const PUSH_SIDE_PATTERNS: readonly ScannerPattern[] = [
  {
    id: "stripe-secret-key",
    re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    source: "empirical: GH013 refused publication candidate bdc99bdd on this shape",
  },
];

const SCANNER: readonly ScannerPattern[] = [...PRODUCT_PATTERNS, ...PUSH_SIDE_PATTERNS];

// ===========================================================================
// THE SCANNER
// ===========================================================================

interface Hit {
  path: string;
  line: number;
  id: string;
}

/**
 * Every match of every pattern in `text`.
 *
 * A finding names the PLACE and the PATTERN and never the matched bytes: a
 * guard that printed them would put the string it exists to keep out into the
 * build log, which is one of the places this repository is read from.
 */
function scan(path: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { id, re } of SCANNER) {
    const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(all)) {
      hits.push({ path, line: text.slice(0, m.index).split("\n").length, id });
    }
  }
  return hits;
}

function scanFiles(files: Array<[string, string]>): Hit[] {
  return files.flatMap(([path, text]) => scan(path, text));
}

function report(hits: Hit[]): string[] {
  return hits.map((h) => `${h.path}:${h.line} [${h.id}]`);
}

/**
 * Every file the repository tracks, read as bytes.
 *
 * `latin1` is a byte-preserving decode: the patterns are ASCII, so a file that
 * is not valid UTF-8 is still scanned rather than skipped, and no decoding can
 * throw part of the tree out of the sweep.
 */
function trackedFiles(): Array<[string, string]> {
  const listing = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return listing
    .split("\0")
    .filter((f) => f.length > 0)
    .map((f) => [f, readFileSync(join(REPO_ROOT, f), "latin1")] as [string, string]);
}

// ===========================================================================
// THE SAMPLES — assembled at run time, by the convention this round enforces
// ===========================================================================

/**
 * One live sample per pattern id, each built from fragments so that this file
 * does not contain the thing it forbids.
 *
 * The keys are compared against the table in [15.2]: a pattern added to
 * `SECRET_PATTERNS` with no sample here FAILS, which is D-16 §3 — a new member
 * of the set is a mandatory mutation, not a silent extension.
 */
const SAMPLES: Record<string, string> = {
  jwt: ["eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJzYW1wbGUifQ", ".", "c2FtcGxlLXNpZ25hdHVyZQ"].join(""),
  "aws-access-key": ["AKIA", "0123456789", "ABCDEF"].join(""),
  "pem-private-key": ["-----BEGIN ", "PRIVATE KEY", "-----"].join(""),
  "github-token": ["ghp", "_0123456789", "abcdefghijklmnopqrstuvwxyz"].join(""),
  "slack-token": ["xox", "b-", "0123456789ab"].join(""),
  "google-api-key": ["AIza", "0123456789", "0123456789", "0123456789", "01234"].join(""),
  "stripe-secret-key": ["sk", "live", "0123456789abcdefghijklmn"].join("_"),
};

// ===========================================================================
// 15.1 — THE TABLE IS DERIVED, AND NOTHING ENTERS IT UNSOURCED
// ===========================================================================

test("[15.1] the pattern set is the product's own table plus separately-declared push-side shapes", () => {
  // The product half is not restated here; it is whatever `src/gates.ts`
  // declares. The floor is a floor and not a list: it proves the import did not
  // come back empty, which is the failure that would make every later probe
  // vacuous. A pattern REMOVED from the product narrows this guard with it —
  // that is the price of taking the set from the system that knows it, and it
  // is the price D-12 chose.
  assert.ok(SECRET_PATTERNS.length >= 6, "the product's detector table came back short, so the derived set is not the product's");
  assert.equal(PRODUCT_PATTERNS.length, SECRET_PATTERNS.length, "the product's table was filtered on its way into the scanner");
  for (const [i, p] of SECRET_PATTERNS.entries()) {
    assert.equal(PRODUCT_PATTERNS[i].id, p.id);
    assert.equal(PRODUCT_PATTERNS[i].re, p.re, "the scanner carries a copy of the pattern instead of the pattern");
  }

  // The push-side half is separate BECAUSE it is not the product's: presenting
  // it as part of `SECRET_PATTERNS` would say this registry detects a shape it
  // does not detect.
  const productIds = new Set(SECRET_PATTERNS.map((p) => p.id));
  for (const p of PUSH_SIDE_PATTERNS) {
    assert.ok(!productIds.has(p.id), `\`${p.id}\` is claimed as push-side but the product declares it`);
  }
  assert.ok(
    PUSH_SIDE_PATTERNS.some((p) => p.id === "stripe-secret-key"),
    "the shape that actually refused the publication is not in the table",
  );
  for (const p of SCANNER) {
    assert.ok(p.source.length > 20, `\`${p.id}\` entered the table without saying where it came from`);
  }
  assert.equal(SCANNER.length, SECRET_PATTERNS.length + PUSH_SIDE_PATTERNS.length);
  console.log(`[15.1] scanning for: ${SCANNER.map((p) => p.id).join(", ")}`);
});

// ===========================================================================
// 15.2 — EVERY PATTERN IS LIVE
// ===========================================================================

test("[15.2] every pattern in the table finds an assembled sample of its own shape", () => {
  // Without this, a green sweep is ambiguous: a tree with nothing in it and a
  // scanner that finds nothing produce the same result.
  assert.deepEqual(
    Object.keys(SAMPLES).sort(),
    SCANNER.map((p) => p.id).sort(),
    "a pattern in the table has no live sample, or a sample names a pattern the table does not carry",
  );

  for (const { id } of SCANNER) {
    const hits = scan(`sample/${id}.txt`, `prelude ${SAMPLES[id]} epilogue\n`);
    assert.ok(
      hits.some((h) => h.id === id),
      `the \`${id}\` pattern did not find a string of its own shape, so a real one would pass too`,
    );
  }
  console.log(`[15.2] live patterns: ${SCANNER.length}/${SCANNER.length}`);
});

// ===========================================================================
// 15.3 — DESCRIBING A SHAPE IS NOT HAVING IT
// ===========================================================================

test("[15.3] a regular expression that describes a secret's shape is not itself one", () => {
  // This is what lets `src/gates.ts` — frozen — and `SPEC.md`'s pattern table
  // pass the sweep without a single exemption. It is asserted, not assumed: the
  // property holds because each pattern's variable part opens with `[`, which
  // that pattern's own alphabet excludes. A future pattern that does not have
  // this property FAILS HERE, in the open, where it has to be answered — rather
  // than quietly acquiring a line in an exemption list.
  const describing: string[] = [];
  for (const { id, re } of SCANNER) {
    const hits = scan(`pattern-source/${id}`, String(re));
    if (hits.length > 0) describing.push(`${id}: its own written form matches ${hits.map((h) => h.id).join(", ")}`);
  }
  assert.deepEqual(
    describing,
    [],
    "a pattern's own written form matches a pattern, so the sweep cannot tell a description of a secret from a secret " +
      "and the files that DOCUMENT the detector cannot pass it honestly",
  );

  // The two files this actually decides, named so a reader can check the claim.
  for (const path of ["src/gates.ts", "SPEC.md"]) {
    const hits = scan(path, readFileSync(join(REPO_ROOT, path), "latin1"));
    assert.deepEqual(report(hits), [], `${path} documents the patterns and must pass the sweep on that ground alone`);
  }
});

// ===========================================================================
// 15.4 — THE SWEEP
// ===========================================================================

test("[15.4] no tracked file contains a string matching a pattern in this table", () => {
  const files = trackedFiles();
  // Non-vacuity: the set is `git ls-files`, so per-file coverage is true by
  // construction; the floor only proves the listing was not empty or truncated.
  assert.ok(files.length >= 100, "the tracked listing came back short, so this sweep covers a tree that is not this one");

  // `npm pack` does not ship `test/`, and the literals that refused the
  // publication were in `test/`. Asserted rather than described, so "not only
  // the package" cannot quietly stop being true.
  const shipped: string[] = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).files;
  assert.ok(!shipped.some((f) => f.startsWith("test")), "`package.json` now ships `test/`, so this probe's premise changed");
  assert.ok(
    files.some(([f]) => f.startsWith("test/")),
    "the sweep reached no test file, and every literal that blocked the publication was in one",
  );

  const hits = report(scanFiles(files));
  for (const h of hits) console.log(`  SHAPED LIKE A SECRET: ${h}`);
  console.log(`[15.4] swept ${files.length} tracked files against ${SCANNER.length} patterns`);
  assert.deepEqual(
    hits,
    [],
    "a tracked file carries a string matching a declared secret signature. It is almost certainly a red-team fixture and " +
      "not a credential — and a push-side scanner cannot tell, so it refuses the publication. Assemble the value from " +
      "fragments at run time, as `test/p7-threats.test.ts` TM-03 does: the value stays byte for byte what it was, the " +
      "assertion is untouched, and only the spelling in the file changes",
  );
});

// ===========================================================================
// 15.5 — THE MUTATIONS
// ===========================================================================

test("[15.5] the sweep is not blind: a restored literal fails, a new file fails, a pattern's source does not", () => {
  // MUTATION 1 — put back a literal of the shape that refused the publication,
  // in the file it was refused in.
  const restored = scanFiles([
    ["test/p14-r9-probes.test.ts", `    ["a token-shaped key inside the form", "${SAMPLES["stripe-secret-key"]}"],\n`],
  ]);
  assert.deepEqual(
    report(restored),
    ["test/p14-r9-probes.test.ts:1 [stripe-secret-key]"],
    "the shape that actually refused the publication passes the sweep",
  );

  // MUTATION 2 — a NEW file, of a kind nobody thought about, carrying a token
  // of every shape in the table. The sweep's set is the tracked listing, so a
  // file is covered by being tracked and by nothing else.
  const invented = scanFiles([
    ["docs/notes-from-the-incident.md", SCANNER.map((p) => `${p.id}: ${SAMPLES[p.id]}`).join("\n")],
  ]);
  assert.deepEqual(
    invented.map((h) => h.id).sort(),
    SCANNER.map((p) => p.id).sort(),
    "a newly added file carrying one token of every shape was not fully caught",
  );

  // MUTATION 3 — the frozen detector itself, byte for byte off the disk. It
  // contains all six patterns WRITTEN OUT and must pass; if it did not, the
  // only ways forward would be to exempt a path or to edit a frozen file.
  const gates = readFileSync(join(REPO_ROOT, "src/gates.ts"), "latin1");
  assert.ok(gates.includes("SECRET_PATTERNS"), "the frozen detector was read from the wrong place");
  assert.deepEqual(report(scan("src/gates.ts", gates)), [], "the detector's own source does not survive the sweep it feeds");
});
