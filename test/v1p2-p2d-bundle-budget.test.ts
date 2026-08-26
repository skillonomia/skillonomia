// G-P2-17 — THE INITIAL CONSOLE JS BUDGET, AGAINST A BASELINE THAT WAS MEASURED.
//
// THE RULE. the v1.1 Console performance budget gives it a gzip budget relative to v1.0.0:
// the initial JavaScript may exceed the v1.0.0 figure by no more than 250 KiB
// without an owner decision.
//
// AND THE PART THAT IS EASY TO GET WRONG. A budget compared against a figure
// nobody measured proves nothing — it is a number checked against a number, and
// whichever way it comes out the run is green. This project has already made
// that mistake once and caught it, so the baseline here is not a constant
// somebody remembered. It is BUILT, on every run, from the v1.0.0 commit's own
// `console/app.ts`, with the same bundler and the same flags `npm run
// build:console` uses today, and the result is compared against a RECORDED
// measurement in `fixtures/console-bundle-v1.0.0-baseline.json` that carries the
// commit, the source digest, the bundle digest and the gzip size. Either half
// can catch the other: a bundler that started emitting different bytes fails
// against the record, and a record somebody edited fails against the build.
//
// WHAT "INITIAL CONSOLE JS" IS, EXACTLY. `src/console-page.ts` serves one module
// script, `/console/app.js`, and the router answers it from `dist-console/app.js`
// — so the initial JavaScript IS that one bundle, and the test asserts that the
// page still loads exactly one script rather than assuming it.
//
// WHY gzip LEVEL 9 AND NOT THE `gzip` COMMAND. `zlib.gzipSync` at level 9 is
// reproducible from any runtime this suite runs on and needs no external
// process; the command-line tool writes a different header and would give a
// figure that depends on which machine ran it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { CONSOLE_SCRIPT_PATH, consolePage } from "../src/console-page.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RECORD_PATH = join(ROOT, "fixtures/console-bundle-v1.0.0-baseline.json");
const BUNDLE_PATH = join(ROOT, "dist-console/app.js");

/** The v1.1 Console performance budget's headroom, in bytes. */
const BUDGET_BYTES = 250 * 1024;

interface BaselineRecord {
  baseline_commit: string;
  source_path: string;
  source_sha256: string;
  bundle_bytes: number;
  bundle_sha256: string;
  gzip_bytes: number;
}

const record = (): BaselineRecord => JSON.parse(readFileSync(RECORD_PATH, "utf8")) as BaselineRecord;

const gzip = (bytes: Buffer): number => gzipSync(bytes, { level: 9 }).length;

/**
 * The v1.0.0 bundle, BUILT rather than remembered.
 *
 * The source comes out of the baseline commit with `git show`, so no worktree of
 * this repository is disturbed, and the bundle is produced with the flags
 * `package.json` declares today — a baseline built with different flags is a
 * different measurement wearing the same name.
 */
function buildBaseline(rec: BaselineRecord): { source: string; bundle: Buffer } {
  const source = execFileSync("git", ["-C", ROOT, "show", `${rec.baseline_commit}:${rec.source_path}`], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const dir = mkdtempSync(join(tmpdir(), "skln-bundle-baseline-"));
  try {
    const entry = join(dir, "app.ts");
    writeFileSync(entry, source, "utf8");
    execFileSync("bun", ["build", "--target=browser", "--format=esm", "--minify", entry, "--outfile", join(dir, "app.js")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { source, bundle: readFileSync(join(dir, "app.js")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("G-P2-17: the recorded v1.0.0 baseline is what building v1.0.0 produces", () => {
  const rec = record();
  assert.match(rec.baseline_commit, /^[0-9a-f]{40}$/, "the record does not name a full commit id");
  let built: { source: string; bundle: Buffer };
  try {
    built = buildBaseline(rec);
  } catch (e) {
    const err = e as { code?: string; message?: string; stderr?: string };
    assert.fail(
      `the v1.0.0 baseline could not be BUILT (${err.code ?? err.message}: ${String(err.stderr ?? "").slice(0, 200)}). ` +
        "The budget is a comparison against a measured figure; a baseline that cannot be produced makes the comparison " +
        "meaningless, so this is a failure rather than a skip.",
    );
  }
  assert.equal(
    createHash("sha256").update(built!.source, "utf8").digest("hex"),
    rec.source_sha256,
    "the recorded baseline names a source digest the baseline commit does not have",
  );
  assert.equal(built!.bundle.length, rec.bundle_bytes, "the v1.0.0 bundle is not the size the record states");
  assert.equal(createHash("sha256").update(built!.bundle).digest("hex"), rec.bundle_sha256, "the v1.0.0 bundle is not the bytes the record states");

  // THE gzip FIGURE IS COMPARED WITH A TOLERANCE, AND THE REASON IS STATED
  // RATHER THAN HIDDEN. The bundle's BYTES are identical on both runtimes this
  // suite runs on — that equality is asserted exactly, just above, and it is the
  // binding that matters. Their zlib implementations are not the same code, and
  // at level 9 they disagree by a few bytes on the same input, so an exact
  // equality here would make the record true on whichever runtime wrote it and
  // false on the other. Two per cent is wide enough for that disagreement and
  // far too narrow to hide a real growth: the budget itself is measured
  // separately below, with both sides compressed by the SAME runtime, which is
  // an exact comparison and is the one the gate turns on.
  const here = gzip(built!.bundle);
  const drift = Math.abs(here - rec.gzip_bytes) / rec.gzip_bytes;
  assert.ok(
    drift <= 0.02,
    `this runtime compresses the v1.0.0 bundle to ${here} B where the record states ${rec.gzip_bytes} B — ` +
      `${(drift * 100).toFixed(1)}% apart, which is more than a zlib implementation difference`,
  );
  console.log(
    `[G-P2-17] v1.0.0 baseline rebuilt at ${rec.baseline_commit.slice(0, 8)}: ${rec.bundle_bytes} B raw ` +
      `(sha256 ${rec.bundle_sha256.slice(0, 16)}…), ${rec.gzip_bytes} B gzip recorded, ${here} B measured here`,
  );
});

test("G-P2-17: the console page loads exactly one script, so the bundle IS the initial JS", () => {
  const page = consolePage();
  const scripts = [...String(page).matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 1, `the console shell serves ${scripts.length} script tags, so one bundle is no longer the whole of the initial JS`);
  assert.ok(scripts[0]!.includes(`src="${CONSOLE_SCRIPT_PATH}"`), `the one script is not ${CONSOLE_SCRIPT_PATH}`);
  assert.equal(CONSOLE_SCRIPT_PATH, "/console/app.js");
});

test("G-P2-17: initial Console JS stays inside the v1.0.0 gzip budget", () => {
  assert.ok(
    existsSync(BUNDLE_PATH),
    "dist-console/app.js has not been built. `npm test` builds it in `pretest`; run `npm run build:console` first.",
  );
  const rec = record();
  // BOTH SIDES COMPRESSED BY THE SAME RUNTIME, IN THIS PROCESS. Comparing a
  // figure this runtime measured against one another runtime recorded would put
  // a zlib implementation difference inside the budget arithmetic.
  const baseline = gzip(buildBaseline(rec).bundle);
  const current = gzip(readFileSync(BUNDLE_PATH));
  const delta = current - baseline;
  console.log(
    `[G-P2-17] initial Console JS: v1.0.0 ${baseline} B gzip → today ${current} B gzip, ` +
      `delta ${delta} B of the ${BUDGET_BYTES} B allowance (${((delta / BUDGET_BYTES) * 100).toFixed(1)}% used)`,
  );
  assert.ok(
    delta <= BUDGET_BYTES,
    `the initial Console JS is ${delta} B gzip above v1.0.0, and the v1.1 Console performance budget allows ${BUDGET_BYTES} B without an owner decision`,
  );
});
