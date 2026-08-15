// B4's four Windows checks — the contract, from wherever this suite runs, and
// the checks themselves ONLY on Windows.
//
// The four properties are properties of NTFS, of Windows ACLs and of reparse
// points. They cannot be measured from Linux, and this file does not pretend
// otherwise: on any other host it asserts what `ci/windows-security.ps1` MUST
// BE — four checks, each with its own failure marker, each failing closed — and
// skips the live run with the platform in the reason.
//
// WHY THE CONTRACT IS WORTH ASSERTING AT ALL. The tempting failure mode for a
// security script is the check that quietly reports "not applicable" and is then
// counted in `4/4`. That is not a hypothetical: it is the exact shape of defect
// this repository has fixed twice — a gate with no accepting case, and a delivery
// record that printed instead of asserting. So the structure is checked here:
// every check has a named FAIL marker, no check may exit zero on a path it did
// not complete, and the count is printed only after four results were collected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./docs-guard.ts";

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");
const SCRIPT = read("ci/windows-security.ps1");

/** The four §8 B4 checks and the marker each one fails with. */
const CHECKS: ReadonlyArray<[string, string]> = [
  ["secret ACL", "WINDOWS_SECRET_ACL_FAIL"],
  ["SQLite readOnly", "WINDOWS_SQLITE_READONLY_FAIL"],
  ["junction/reparse escape", "WINDOWS_REPARSE_ESCAPE_FAIL"],
  ["NTFS path/case archive contract", "WINDOWS_ARCHIVE_CONTRACT_FAIL"],
];

test("the four checks exist, each with its own failure marker", () => {
  for (const [what, marker] of CHECKS) {
    assert.ok(SCRIPT.includes(marker), `the ${what} check must fail with ${marker}`);
  }
  assert.match(SCRIPT, /WINDOWS_SECURITY_OK 4\/4/, "the success marker carries the count");
});

test("no check can be counted without having produced a result", () => {
  // The count is not a constant printed at the end of a run: the script collects
  // one result per check and refuses to print `4/4` unless it has four. This is
  // the assertion that a check which returned early cannot be counted.
  assert.match(SCRIPT, /\$Results\[[^\]]+\] =/, "each check records a result");
  assert.match(SCRIPT, /if \(\$Results\.Count -ne 4\)/, "…and the count is checked before the marker is printed");
  assert.match(SCRIPT, /WINDOWS_SECURITY_INCOMPLETE/, "…with its own marker when it is short");

  // A check that could not be PERFORMED fails, and says so rather than skipping.
  assert.match(SCRIPT, /An unperformed check is a failed check/, "the unperformable case is a failure, in writing");
  assert.match(SCRIPT, /the probe process never ran/, "…and the ACL probe names that case explicitly");
  assert.match(SCRIPT, /WINDOWS_SECURITY_UNRUNNABLE/, "…as does a host with no deployment to check");
  assert.doesNotMatch(SCRIPT, /-ErrorAction SilentlyContinue.*Get-Acl/, "the ACL read may not be silenced");
  assert.match(SCRIPT, /\$ErrorActionPreference = 'Stop'/, "an unexpected error ends the run rather than continuing");
});

test("each check exercises the shipped code, not a re-implementation of it", () => {
  // A security check that reasons about its own model of the system proves
  // something about that model. These go through the code that ships.
  assert.match(SCRIPT, /from '\$RootUrl\/src\/sqlite\.ts'/, "the read-only probe opens the handle through src/sqlite.ts");
  assert.match(SCRIPT, /\$RootUrl = 'file:\/\/\/'/, "…imported by a file: URL, which is the specifier Node's resolver accepts on Windows");
  assert.match(SCRIPT, /readonly: true/, "…with the engine-level flag, which is the whole claim");
  assert.match(SCRIPT, /src\/activation\.ts/, "the reparse probe calls the activation code");
  assert.match(SCRIPT, /outside_root_refused/, "…and requires its typed refusal");
  assert.match(SCRIPT, /ci\/mvp-release\.mjs'/, "the archive vectors are imported, not written a second time");
  assert.match(SCRIPT, /'verify'/, "…and run through the CLI a user runs");
});

test("the junction probe checks that the target was not READ, not only that it failed", () => {
  // A refusal that happens after the target has been opened is a refusal that
  // came too late: the bytes already left the root.
  assert.match(SCRIPT, /SKILLONOMIA_B4_TARGET_MARKER/, "the junction target carries a marker");
  assert.match(SCRIPT, /the junction target was READ before the refusal/, "…and reading it is a failure of its own");
  assert.match(SCRIPT, /something was written into \$outside through the junction/, "…as is writing through it");
});

test("the workflow runs it on a Windows runner, and cannot mark it soft", () => {
  const platform = read(".github/workflows/platform.yml");
  assert.match(platform, /^  windows-security:$/m, "platform.yml declares the job");
  assert.match(platform, /pwsh -NoProfile -File ci\/windows-security\.ps1/, "…and runs the script the way §8 B4 states");
  assert.doesNotMatch(platform, /continue-on-error/, "no job in the matrix may fail softly");
});

/**
 * The live run. Four checks that create a local account, open a read-only SQLite
 * handle, build junctions and run the §4.1b vectors on NTFS — none of which
 * exists off Windows. The reason names the platform, and the option form is used
 * rather than `t.skip()` because Bun's `node:test` shim does not implement it.
 */
const LIVE = "ci/windows-security.ps1 reports WINDOWS_SECURITY_OK 4/4";
const SKIP =
  process.platform === "win32"
    ? undefined
    : `skipped on ${process.platform}: every check is about NTFS ACLs, reparse points and the Windows form of an ` +
      "absolute path. There is nothing here to measure, and a green result would be this suite reporting another " +
      "operating system's answer as Windows'. The contract above is asserted on every host; the run itself is " +
      "`windows-security` in .github/workflows/platform.yml.";

test(process.platform === "win32" ? LIVE : `${LIVE} — SKIPPED on ${process.platform}`, { skip: SKIP }, () => {
  const run = spawnSync("pwsh", ["-NoProfile", "-File", join(REPO_ROOT, "ci/windows-security.ps1")], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    timeout: 600_000,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 0, `the checks did not pass:\n${output}`);
  assert.match(output, /WINDOWS_SECURITY_OK 4\/4/, `the marker was not printed:\n${output}`);
});
