// What V1 claims about platforms, and the one check that actually depends on
// one.
//
// The claim is Linux x86_64 and nothing else: CI runs on `ubuntu-latest` only
// and `build:binary` targets `bun-linux-x64`. Before this file that was true
// but unwritten, which is the same shape of problem §1 fixed in the quickstart
// — an unstated scope reads as a universal one.
//
// The substantive part is §4.1b. Its case-insensitive and NFC/NFD collision
// refusals are defined over a package's member names. Read from a `.tar` those
// names come from the archive, so the rule is host-independent and is asserted
// here on every platform. Read from a plain DIRECTORY they come from the host
// filesystem — and on a case-insensitive one (default APFS/HFS+, NTFS) or a
// normalizing one the two colliding members cannot both exist on disk, so there
// is nothing for the rule to refuse and this implementation's behaviour is
// unspecified. That test therefore runs on Linux and SKIPS elsewhere, saying
// why, rather than asserting a portability nobody measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveError, readDirectory, readTar, writeTar, type PackageFiles } from "../src/archive.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/** The one platform V1 is built and tested on. */
const SUPPORTED = "linux";
const ON_SUPPORTED = process.platform === SUPPORTED;

test("the Linux-only scope is stated in every document that would otherwise imply more", () => {
  // README's packaging table, SPEC's implementation profile and the operations
  // guide each describe how to RUN this software. A reader of any one of them
  // must find the scope there, not in the other two.
  assert.match(read("README.md"), /V1 supports Linux x86_64, and claims nothing else/);
  assert.match(read("SPEC.md"), /\*\*Supported platform:\*\* \*\*Linux x86_64, and no other\.\*\*/);
  assert.match(read("docs/OPERATIONS.md"), /^## Platform$/m);

  // and the claim matches what is actually built and exercised
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["build:binary"], /--target=bun-linux-x64/, "the binary target is the claimed platform");
  const ci = read(".github/workflows/ci.yml");
  const runners = [...ci.matchAll(/runs-on:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(runners.length >= 4, "every CI job declares a runner");
  assert.deepEqual(
    [...new Set(runners)],
    ["ubuntu-latest"],
    "CI runs on Linux only — a second runner here would make the README's scope a lie",
  );
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
 * A real skip with a real reason: on an unsupported host the fixture below
 * cannot even be built, so passing it would prove nothing and failing it would
 * blame the implementation for the filesystem.
 *
 * Declared as a test OPTION rather than `t.skip()` inside the body, because
 * Bun's `node:test` shim does not implement `t.skip` (ERR_NOT_IMPLEMENTED) and
 * this suite must behave identically under both runners. Bun prints the title
 * and not the reason, so the platform goes in the title too.
 */
const DIRECTORY_RULE = "§4.1b collision refusals over a directory need a case-sensitive, byte-preserving filesystem";
const SKIP_REASON = ON_SUPPORTED
  ? undefined
  : `skipped on ${process.platform}: this check writes two members that differ only by case and one whose name ` +
    `is not NFC, which a case-insensitive or normalizing filesystem cannot hold. V1 is specified, built and ` +
    `tested on ${SUPPORTED} x86_64 only (README -> Supported platforms); the archive form of the same rule is ` +
    `asserted above and does hold here.`;

test(ON_SUPPORTED ? DIRECTORY_RULE : `${DIRECTORY_RULE} — SKIPPED on ${process.platform}`, { skip: SKIP_REASON }, () => {
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
