// What this project claims about platforms, and the one check that actually
// depends on one.
//
// THE CLAIM HAS MOVED, AND THE MOVE IS THE POINT. It was "Linux x86_64 and
// nothing else": CI ran on `ubuntu-latest` alone and the compiled binary targets
// `bun-linux-x64`. B2 and B3 add a second product path — `@skillonomia/cli` on
// Node — so the scope is now THREE statements and not one, and each is narrower
// than "supported everywhere":
//
//   * the COMPILED BINARY is Linux x86_64 and stays so;
//   * the NPM CLI is qualified on Ubuntu and macOS, by the small user contract
//     of `.github/workflows/platform.yml` — not by this suite's thousand
//     Linux-oriented tests. Windows is DEFERRED BY OWNER;
//   * the CONTAINER IMAGE is qualified on Ubuntu and on no other operating
//     system. `qualify-docker-macos` and `qualify-docker-windows` are DEFERRED
//     BY OWNER and stay in the workflow unrun; on macOS the product path is the
//     npm CLI on ordinary Node.
//
// This file therefore checks that the documents keep those three apart. A
// sentence that puts the CLI and the image under one width is the defect the
// owner named, and the widths differ.
//
// The substantive part below is §4.1b. Its case-insensitive and NFC/NFD
// collision refusals are defined over a package's member names. Read from a
// `.tar` those names come from the archive, so the rule is host-independent and
// is asserted here on every platform. Read from a plain DIRECTORY they come from
// the host filesystem — and a case-insensitive one (default APFS/HFS+, NTFS) or
// a normalizing one cannot hold the two colliding members at all.
//
// THAT SKIP IS NOW A CAPABILITY PROBE AND NOT A PLATFORM NAME. It used to be
// `process.platform === "linux"`, which is a proxy: it skips on a
// case-sensitive APFS volume (which could run the check) and would run on a
// hypothetical case-insensitive Linux filesystem (which could not). The question
// the test actually depends on is "can this filesystem hold these two names",
// and that is a question a filesystem can be ASKED — so it is asked, here, in a
// temporary directory, and the answer is what decides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveError, readDirectory, readTar, writeTar, type PackageFiles } from "../src/archive.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * CAN THIS FILESYSTEM HOLD THE FIXTURE AT ALL? Two members differing only by
 * case, and one name that is not NFC. A filesystem that folds case or
 * normalizes silently merges or rewrites them, and then the directory the test
 * would read is not the directory it wrote.
 *
 * Probed rather than assumed, and the probe cleans up after itself.
 */
function directoryFixturesArePossible(): { ok: boolean; why: string } {
  const dir = mkdtempSync(join(tmpdir(), "sklo-probe-"));
  try {
    writeFileSync(join(dir, "Probe.md"), "a");
    writeFileSync(join(dir, "probe.MD"), "b");
    if (readdirSync(dir).length !== 2 || readFileSync(join(dir, "Probe.md"), "utf8") !== "a") {
      return { ok: false, why: "this filesystem folds case: the two members cannot both exist" };
    }
    const nfd = "café".normalize("NFD");
    writeFileSync(join(dir, nfd), "x");
    if (!readdirSync(dir).includes(nfd)) {
      return { ok: false, why: "this filesystem normalizes names: a non-NFC member cannot be stored as written" };
    }
    return { ok: true, why: "case-sensitive and byte-preserving" };
  } catch (e) {
    return { ok: false, why: `the fixture could not be created: ${String((e as Error).message)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURE = directoryFixturesArePossible();

test("the platform scope is stated in every document that would otherwise imply more", () => {
  // README's packaging table, SPEC's implementation profile and the operations
  // guide each describe how to RUN this software. A reader of any one of them
  // must find the scope there, not in the other two.
  assert.match(read("README.md"), /^### Supported platforms$/m);
  assert.match(read("SPEC.md"), /\*\*Supported platform:\*\* \*\*Linux x86_64, and no other\.\*\*/);
  assert.match(read("docs/OPERATIONS.md"), /^## Platform$/m);

  // The compiled binary's scope has not moved, and the documents may not say it
  // has: this is the artifact `--target=bun-linux-x64` produces.
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["build:binary"], /--target=bun-linux-x64/, "the binary target is the claimed platform");
  assert.match(
    read("README.md"),
    /The compiled binary is Linux x86_64 and claims nothing else/,
    "README states the binary's scope in the words the build supports",
  );

  // The FULL SUITE is a Linux regression gate and stays one: `ci.yml` runs on
  // ubuntu and on nothing else. What runs on the other two platforms is the
  // small user contract in `platform.yml`, and the two files may not be
  // confused for one another.
  const ci = read(".github/workflows/ci.yml");
  const ciRunners = [...ci.matchAll(/runs-on:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(ciRunners.length >= 4, "every CI job declares a runner");
  assert.deepEqual(
    [...new Set(ciRunners)],
    ["ubuntu-latest"],
    "the full regression suite runs on Linux only — the qualification matrix lives in platform.yml",
  );
  const platform = read(".github/workflows/platform.yml");
  for (const runner of ["ubuntu-latest", "macos-14", "windows-latest"]) {
    assert.ok(platform.includes(`runs-on: ${runner}`), `platform.yml declares a job on ${runner}`);
  }

  // WHAT IS DEFERRED HAS TO BE CALLED DEFERRED. The owner deferred Docker on
  // macOS, every Windows job, and with them any container claim outside Linux.
  // The jobs stay in the tree; an unnamed deferral is indistinguishable from a
  // pass, so each of the three places a reader goes has to say the word.
  for (const [where, text] of [
    ["README.md", read("README.md")],
    ["docs/OPERATIONS.md", read("docs/OPERATIONS.md")],
    [".github/workflows/platform.yml", platform],
  ] as const) {
    assert.match(text, /DEFERRED BY OWNER/, `${where} names the deferral rather than leaving it as an absence`);
  }
  // …and the jobs it defers are still declared, not deleted and not replaced.
  for (const job of ["qualify-docker-macos", "qualify-docker-windows", "qualify-windows", "windows-security"]) {
    assert.match(platform, new RegExp(`^  ${job}:$`, "m"), `${job} stays in the tree as an explicit deferral`);
  }
  // The container's width is Linux, and the documents may not widen it.
  for (const doc of ["README.md", "docs/OPERATIONS.md"]) {
    assert.doesNotMatch(
      read(doc),
      /container image (?:and|is)[^.]*qualified on[^.]*(?:macOS|Windows)/i,
      `${doc} must not qualify the container image on macOS or Windows`,
    );
  }
});

test("§4.1b collision refusals over a .tar are host-independent", () => {
  // Member names come from the archive, so nothing here consults a filesystem.
  const entry = (path: string, body: string): PackageFiles => new Map([[path, Buffer.from(body, "utf8")]]);
  const both: PackageFiles = new Map([
    ["Skill.md", Buffer.from("a", "utf8")],
    ["skill.MD", Buffer.from("b", "utf8")],
  ]);
  assert.throws(
    () => readTar(writeTar(both)),
    (e: unknown) => e instanceof ArchiveError && e.code === "MALFORMED_ARCHIVE",
    "a case-insensitive collision is refused in archive form on every platform",
  );
  assert.throws(
    () => readTar(writeTar(entry("café".normalize("NFD"), "x"))),
    (e: unknown) => e instanceof ArchiveError && e.code === "MALFORMED_ARCHIVE",
    "a non-NFC member name is refused in archive form on every platform",
  );
});

/**
 * A real skip with a real reason, and the reason is a MEASUREMENT: the probe
 * above tried to create the fixture and reports what the filesystem did with
 * it. Where it cannot be created, passing this test would prove nothing and
 * failing it would blame the implementation for the host.
 *
 * Declared as a test OPTION rather than `t.skip()` inside the body, because
 * Bun's `node:test` shim does not implement `t.skip` (ERR_NOT_IMPLEMENTED) and
 * this suite must behave identically under both runners. Bun prints the title
 * and not the reason, so the platform goes in the title too.
 */
const DIRECTORY_RULE = "§4.1b collision refusals over a directory need a case-sensitive, byte-preserving filesystem";
const SKIP_REASON = FIXTURE.ok
  ? undefined
  : `skipped on ${process.platform}: ${FIXTURE.why}. This check writes two members that differ only by case and ` +
    `one whose name is not NFC; where the filesystem cannot hold them there is no directory for the rule to read, ` +
    `and the ARCHIVE form of the same rule is asserted above and does hold here. The normative archive contract ` +
    `is never skipped — only this directory-shaped input is.`;

test(FIXTURE.ok ? DIRECTORY_RULE : `${DIRECTORY_RULE} — SKIPPED on ${process.platform}`, { skip: SKIP_REASON }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-plat-"));
  const caseDir = join(dir, "case");
  mkdirSync(caseDir);
  writeFileSync(join(caseDir, "Skill.md"), "a");
  writeFileSync(join(caseDir, "skill.MD"), "b");
  // the premise of the test, checked rather than assumed
  assert.equal(readFileSync(join(caseDir, "Skill.md"), "utf8"), "a", "this filesystem is case-sensitive");
  assert.throws(
    () => readDirectory(caseDir),
    (e: unknown) => e instanceof ArchiveError && e.code === "MALFORMED_ARCHIVE" && /collision/.test(e.message),
    "two members differing only by case are a §4.1b collision",
  );

  const nfdDir = join(dir, "nfd");
  mkdirSync(nfdDir);
  const nfd = "café".normalize("NFD");
  writeFileSync(join(nfdDir, nfd), "x");
  assert.throws(
    () => readDirectory(nfdDir),
    (e: unknown) => e instanceof ArchiveError && e.code === "MALFORMED_ARCHIVE" && /NFC/.test(e.message),
    "a member name this filesystem stored as NFD is not NFC-normalized",
  );
});

test("the capability probe answers about THIS filesystem, and the skip follows the answer", () => {
  // The probe is the thing deciding whether the case above runs, so it has to
  // be checked itself: a probe that always answered "no" would silently retire
  // the directory rule on every host, and a probe that always answered "yes"
  // would fail the suite on macOS for a reason that is not a defect.
  assert.match(FIXTURE.why, /\S/, "the probe always says what it found");
  if (FIXTURE.ok) {
    assert.equal(SKIP_REASON, undefined, "a filesystem that can hold the fixture runs the check");
  } else {
    assert.ok(SKIP_REASON !== undefined && SKIP_REASON.includes(FIXTURE.why), "the skip reason quotes the measurement");
  }
  // and the archive form is unconditional on every host, which is what makes
  // the skip narrow rather than a hole in the §4.1b contract
  assert.throws(
    () => readTar(writeTar(new Map([["a.md", Buffer.from("x")], ["A.MD", Buffer.from("y")]]) as PackageFiles)),
    (e: unknown) => e instanceof ArchiveError,
    "the archive contract is asserted wherever this suite runs",
  );
});
