// THE QUALIFICATION MATRIX, AS A CONTRACT — what each platform job must do, and
// what it is not allowed to be.
//
// B3 runs the same consumer contract on three operating systems from ONE
// tarball. TWO of the three are claimed — Ubuntu x86_64 and macOS arm64;
// Windows x86_64 is DEFERRED BY OWNER, and so is `windows-security`. Both
// Windows jobs stay in the workflow exactly as written and are checked here
// exactly as before: what the owner deferred is the CLAIM that they have proved
// something, and this file asserts wiring, not results.
//
// Every word of the contract has a way of quietly becoming false:
//
//   * three jobs that each PACKED THEIR OWN tarball would be three different
//     artifacts wearing one name, and two of them would need Bun — the very
//     prerequisite B2 removes from the consumer's side;
//   * a job that skipped the demo, or ran it without a budget, would report a
//     platform as qualified on the strength of an install;
//   * a deferred job quietly deleted, weakened or made to pass some other way
//     would turn a decision nobody took into a platform nobody ran;
//   * a `continue-on-error` anywhere would turn a red job into a green matrix.
//
// So the workflow is read for each of those, and the ORCHESTRATOR is executed
// for the ones that are about behaviour rather than text: the subcommand refuses
// a checksum that does not match, and refuses to run without one at all.
//
// WHAT THIS FILE DOES NOT DO is run the matrix. Three operating systems are
// three hosts; a suite on one of them cannot produce the other two, and a test
// that pretended otherwise would be the exact defect the matrix exists to
// catch. What runs here is the contract; what runs there is the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./docs-guard.ts";

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");
const PLATFORM = read(".github/workflows/platform.yml");
const RELEASE_SCRIPT = join(REPO_ROOT, "ci/mvp-release.mjs");

/**
 * The `qualify-*` jobs that run the consumer contract, and their runners. All
 * three are held to the same wiring; only the first two are CLAIMED platforms —
 * `qualify-windows` is deferred by the owner and kept here unchanged.
 */
const QUALIFY: ReadonlyArray<[string, string]> = [
  ["qualify-ubuntu", "ubuntu-latest"],
  ["qualify-macos", "macos-14"],
  ["qualify-windows", "windows-latest"],
];

/**
 * The lines of one job block, from its name to the next job at the same indent,
 * WITH THE COMMENTS REMOVED — what the job runs, not what it says about itself.
 *
 * That distinction has already cost this repository one guard: a workflow that
 * EXPLAINS why it does not publish is not publishing, and a substring search
 * over the whole text is satisfied by the explanation. The comment on the
 * `npm ci --ignore-scripts` step below names `prepack` for a reader's benefit,
 * and a job that actually ran it would look identical to this function.
 */
function jobBlock(name: string): string {
  const lines = PLATFORM.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `platform.yml declares no job \`${name}\``);
  let end = start + 1;
  for (; end < lines.length; end += 1) if (/^  [a-z0-9-]+:$/.test(lines[end])) break;
  return lines
    .slice(start, end)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

test("one tarball is built once, with Bun, and the platform jobs consume it", () => {
  const build = jobBlock("package-build");
  assert.match(build, /runs-on: ubuntu-latest/);
  assert.match(build, /bun-version: "1\.3\.14"/, "the one job that packs is the one job that has Bun");
  assert.match(build, /npm pack --silent/, "it packs");
  assert.match(build, /sha256sum/, "…and records the checksum the other three check");
  assert.match(build, /outputs:\n\s+tarball:/, "the tarball name is an output, not a guess");
  assert.match(build, /sha256: \$\{\{ steps\.pack\.outputs\.sha256 \}\}/, "…and so is the checksum");
});

test("no platform job builds a package, runs prepack, or installs Bun", () => {
  for (const [job] of QUALIFY) {
    const block = jobBlock(job);
    assert.doesNotMatch(block, /setup-bun/, `${job} must not install Bun: that is the prerequisite B2 removes`);
    assert.doesNotMatch(block, /npm pack/, `${job} must not pack its own tarball`);
    assert.doesNotMatch(block, /prepack|build:js/, `${job} must not run the maintainer's build`);
    assert.match(block, /npm ci --ignore-scripts/, `${job} installs the checkout without running lifecycle scripts`);
    assert.match(block, /download-artifact/, `${job} takes the tarball from the artifact`);
  }
});

test("each platform job runs the SAME tarball, checked against the SAME checksum", () => {
  for (const [job, runner] of QUALIFY) {
    const block = jobBlock(job);
    assert.match(block, new RegExp(`runs-on: ${runner}`), `${job} runs on ${runner}`);
    assert.match(block, /needs: package-build/, `${job} waits for the one build`);
    assert.ok(
      block.includes('--package "artifact/${{ needs.package-build.outputs.tarball }}"'),
      `${job} installs the artifact the build produced`,
    );
    assert.ok(
      block.includes('--sha256 "${{ needs.package-build.outputs.sha256 }}"'),
      `${job} checks it against the checksum that build recorded`,
    );
    assert.match(block, /node-version: "22"/, `${job} runs the Node the package declares`);
    assert.match(block, /npm run typecheck/, `${job} typechecks on its own platform`);
  }
});

test("nothing in the matrix is allowed to fail softly", () => {
  assert.doesNotMatch(PLATFORM, /continue-on-error/, "a job that may fail without failing is not a required job");
  assert.doesNotMatch(PLATFORM, /if: always\(\)/, "…and neither is one that reports whatever happened");
  // The Windows security lane is part of the same file and the same rule.
  assert.match(jobBlock("windows-security"), /runs-on: windows-latest/);
  assert.match(jobBlock("windows-security"), /ci\/windows-security\.ps1/);
});

test("the orchestrator refuses a tarball that is not the one the checksum names", () => {
  // Executed. The wiring above is text; THIS is the assertion that the wiring
  // cannot be satisfied by the wrong file.
  const where = mkdtempSync(join(tmpdir(), "sklo-qual-"));
  const impostor = join(where, "not-the-package.tgz");
  writeFileSync(impostor, "not a tarball");

  const wrong = spawnSync(process.execPath, [RELEASE_SCRIPT, "platform", "--package", impostor, "--sha256", "0".repeat(64)], {
    encoding: "utf8",
  });
  assert.equal(wrong.status, 1, "a checksum mismatch fails the job");
  assert.match(wrong.stderr, /hashes to/, "…and the message names both values");

  const noChecksum = spawnSync(process.execPath, [RELEASE_SCRIPT, "platform", "--package", impostor], { encoding: "utf8" });
  assert.equal(noChecksum.status, 2, "running without a checksum at all is a usage error");
  assert.match(noChecksum.stderr, /--sha256/, "…and says what is missing");
});

test("the contract the orchestrator runs is the contract §8 B3 lists", () => {
  // The steps are named in the script, in the order a user meets them. This is
  // a shallow check on purpose: the deep one is that the subcommand ran green on
  // the platforms this project claims — Ubuntu and macOS — which no single host
  // can assert, and which nothing here reports for the deferred Windows lane.
  const script = read("ci/mvp-release.mjs");
  for (const step of [
    "version",           // the installed executable answers
    "serve",             // it starts
    "/health",           // it answers
    "demo",              // the quickstart reaches a terminal receipt
    "restart",           // on the same SQLite file
    "receipt read-back", // from the server, afterwards
  ]) {
    assert.ok(script.includes(step), `ci/mvp-release.mjs names the \`${step}\` step of the qualification contract`);
  }
  assert.match(script, /QUICKSTART_BUDGET_MS = 600_000/, "the §7 budget is 600 s and is enforced, not described");
  assert.match(script, /ARCHIVE_VECTORS/, "the §4.1b vectors are part of the contract");
  assert.match(script, /PLATFORM_QUALIFICATION_OK/, "the job has a marker to look for");
});

test("the §4.1b vectors have ONE definition, and the Windows lane imports it", () => {
  // Two copies of a vector set are two answers to one question. The PowerShell
  // check imports these rather than writing its own, and adds the two forms
  // that only exist on Windows.
  const script = read("ci/mvp-release.mjs");
  assert.match(script, /export const ARCHIVE_VECTORS/, "the vectors are exported");
  assert.match(script, /export function ustar/, "…with the writer that builds them");
  const ps = read("ci/windows-security.ps1");
  assert.match(ps, /import \{ ARCHIVE_VECTORS, ustar \}/, "the Windows checks import the same set");
  assert.match(ps, /windows-absolute/, "…and add the Windows drive-letter form");
  assert.match(ps, /backslash-traversal/, "…and the backslash traversal form");
});
