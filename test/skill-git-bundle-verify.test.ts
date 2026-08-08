// `skills/git-bundle-verify`, exercised as a package rather than as a source
// directory: packed and signed the way `npm run pack-skill` does, linted by the
// same eight §7.1 gates the registry runs, and then RUN — on the defective
// bundles that ship inside it.
//
// Why the vectors matter enough to have a test file. "The runbook refuses a bad
// bundle" was previously the author's claim, checked outside the package and
// written down in `evidence`. A claim in `evidence` is worth exactly as much as
// the author, and an adopter has no way to re-check it. With the vectors inside
// the package, the refusals are a property of the thing that was handed over —
// and this file is the repository's copy of the same check.
//
// The last case is the one that keeps the rest honest: it MUTATES the runbook,
// removing one guard at a time, and asserts that the defective bundle then slips
// through. Without it, "seven rows were refused" could be true of a runbook that
// refuses everything, or of assertions that check nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { packSkill, writePackage, lintPacked } from "../tools/pack-skill.ts";
import { GATE_NAMES } from "../src/gates.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "skills", "git-bundle-verify");

/** Any valid author/kid/seed will do: nothing here checks the signature, and
 *  the §4.4 path that does has its own tests. */
const AUTHOR = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SEED_HEX = "a".repeat(64);
const KID = "test-kid";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

/** Pack the source into a fresh directory and return where the package landed. */
function packed(): string {
  const out = tmp("sklo-gbv-pkg-");
  writePackage(packSkill(SRC, { author: AUTHOR, seedHex: SEED_HEX, kid: KID }), out, "git-bundle-verify");
  return join(out, "git-bundle-verify");
}

interface StepRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one runbook step inside the package, the way SKILL.md says to. */
function step(pkg: string, script: string, args: string[], env?: NodeJS.ProcessEnv): StepRun {
  const res = spawnSync("sh", [join("scripts", script), ...args], {
    cwd: pkg,
    encoding: "utf8",
    env: env ?? process.env,
  });
  if (res.error) throw res.error;
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/**
 * A `wc` that pads its count into a column, the way a BSD userland's does, put
 * first on PATH. The runbook's two counted lines — `tracked-files N` and
 * `divergences N` — are declared as EXACT strings by g3 and g4, so a padding
 * `wc` made the package fail a gate it sets for itself. This is the only way to
 * see that from a GNU box, and it is the reason the counts are not `wc -l`.
 */
function paddingWcPath(): string {
  const dir = tmp("sklo-gbv-bsdwc-");
  const shim = join(dir, "wc");
  writeFileSync(shim, "#!/bin/sh\nprintf '%8d\\n' \"$(awk 'END { print NR }')\"\n");
  chmodSync(shim, 0o755);
  return dir;
}

interface MatrixRow {
  bundle: string;
  digest: string;
  /** the step that must refuse it; 0 means the row is the positive control */
  refuseAt: number;
  evidence: string;
}

function matrix(pkg: string): MatrixRow[] {
  return readFileSync(join(pkg, "vectors", "MATRIX.tsv"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => {
      const [bundle, digest, refuseAt, evidence] = l.split("\t");
      return { bundle, digest, refuseAt: Number(refuseAt), evidence };
    });
}

/**
 * Walk one matrix row through the four steps, stopping where it stops.
 * Returns every step's result, in order.
 */
function walk(pkg: string, row: MatrixRow, work: string): StepRun[] {
  const bundle = join("vectors", row.bundle);
  const calls: Array<[string, string[]]> = [
    ["01-checksum.sh", [bundle, row.digest, work]],
    ["02-history.sh", [bundle, work]],
    ["03-clone.sh", [bundle, work]],
    ["04-compare.sh", [work, join("vectors", "reference")]],
  ];
  const runs: StepRun[] = [];
  for (const [script, args] of calls) {
    const r = step(pkg, script, args);
    runs.push(r);
    if (r.code !== 0) break;
  }
  return runs;
}

test("the skill source packs, and all eight §7.1 gates pass with the vectors inside it", () => {
  const r = packSkill(SRC, { author: AUTHOR, seedHex: SEED_HEX, kid: KID });

  // the vectors travel WITH the runbook, or the self-check is not a property of
  // the package at all
  for (const p of [
    "SKILL.md",
    "scripts/01-checksum.sh",
    "vectors/MATRIX.tsv",
    "vectors/README.md",
    "vectors/good.bundle",
    "vectors/corrupt.bundle",
    "vectors/truncated.bundle",
    "vectors/incremental.bundle",
    "vectors/foreign.bundle",
    "vectors/reference/a.txt",
  ]) {
    assert.ok(r.paths.includes(p), `${p} is missing from the package`);
  }

  const report = lintPacked(r, Date.UTC(2026, 7, 8));
  assert.deepEqual(report.map((g) => g.gate).sort(), [...GATE_NAMES].sort(), "a gate did not run");
  // PASS, not "no fail": a gate that degrades to warn is a change worth seeing,
  // and gate 5 in particular is the one the vectors could have disturbed
  for (const g of report) {
    assert.equal(g.result, "pass", `gate ${g.gate}: ${g.result} — ${g.details}`);
  }
});

test("the shipped digests describe the shipped bytes", () => {
  const pkg = packed();
  const sha = (p: string): string =>
    createHash("sha256").update(readFileSync(join(pkg, "vectors", p))).digest("hex");

  for (const line of readFileSync(join(pkg, "vectors", "DIGESTS.sha256"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const [digest, name] = line.split(/\s+/);
    assert.equal(sha(name), digest, `DIGESTS.sha256 disagrees with ${name}`);
  }

  // and the matrix's own digest column: each row either carries the digest of
  // its own bundle, or good.bundle's — the two readings SKILL.md distinguishes
  const good = sha("good.bundle");
  for (const row of matrix(pkg)) {
    const own = sha(row.bundle);
    assert.ok(
      row.digest === own || row.digest === good,
      `MATRIX.tsv row for ${row.bundle} carries a digest that is neither its own nor good.bundle's`,
    );
  }
});

test("the positive control is ACCEPTED — without it, refusing everything would look perfect", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  const row = matrix(pkg).find((r) => r.refuseAt === 0)!;
  assert.equal(row.bundle, "good.bundle");

  const work = join(tmp("sklo-gbv-work-"), "w");
  const runs = walk(pkg, row, work);
  assert.equal(runs.length, 4, "the run stopped early");
  for (const [i, r] of runs.entries()) {
    assert.equal(r.code, 0, `step ${i + 1} exited ${r.code}: ${r.stderr}`);
  }
  assert.equal(runs[0].stdout, "bundle-sha256-ok\n");
  assert.equal(runs[1].stdout, "bundle-history-complete\n");
  assert.match(runs[2].stdout, /^head-commit [0-9a-f]{40}\nhead-tree [0-9a-f]{40}\ntracked-files 2\nclone-ok\n$/);
  assert.equal(runs[3].stdout, "divergences 0\n");

  // both success tokens are on disk after an accepted run, each carrying the
  // same bytes its step printed. They are what the chain is guarded on, so an
  // accepted run has to leave them — a passing gate that writes no token would
  // stop the NEXT step just as a refusal does.
  assert.equal(readFileSync(join(work, "checksum-ok.txt"), "utf8"), "bundle-sha256-ok\n");
  assert.equal(readFileSync(join(work, "history-ok.txt"), "utf8"), "bundle-history-complete\n");
});

test("on the accepted run the two digest files agree, and step 1 leaves its success token", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  const row = matrix(pkg).find((r) => r.refuseAt === 0)!;
  const bundle = join("vectors", row.bundle);
  const work = join(tmp("sklo-gbv-ok-"), "w");

  const r = step(pkg, "01-checksum.sh", [bundle, row.digest, work]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "bundle-sha256-ok\n", "the accepted run prints exactly the one line");

  // measuring before the check must not change what an ACCEPTED run looks like:
  // the two files exist and carry the same digest, because they agree
  const real = createHash("sha256").update(readFileSync(join(pkg, bundle))).digest("hex");
  assert.equal(real, row.digest, "the positive control's matrix digest is not its own");
  assert.equal(readFileSync(join(work, "actual.sha256"), "utf8"), `${real}  ${bundle}\n`);
  assert.equal(readFileSync(join(work, "expected.sha256"), "utf8"), `${row.digest}  ${bundle}\n`);
  // and the token the chain is now guarded on holds the same bytes stdout got
  assert.equal(readFileSync(join(work, "checksum-ok.txt"), "utf8"), "bundle-sha256-ok\n");
});

test("a refused g1 leaves BOTH digests in the work directory — the finding survives the refusal", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  // the real refusing rows, read out of the shipped matrix rather than invented
  // here: both damaged vectors offered under good.bundle's announced digest
  const rows = matrix(pkg).filter((r) => r.refuseAt === 1);
  assert.deepEqual(
    rows.map((r) => r.bundle).sort(),
    ["corrupt.bundle", "truncated.bundle"],
    "MATRIX.tsv no longer carries the two g1 rows this checks",
  );

  for (const [i, row] of rows.entries()) {
    const bundle = join("vectors", row.bundle);
    const work = join(tmp("sklo-gbv-g1-"), `w${i}`);
    const real = createHash("sha256").update(readFileSync(join(pkg, bundle))).digest("hex");
    assert.notEqual(real, row.digest, `${row.bundle}: the row does not actually mismatch`);

    const r = step(pkg, "01-checksum.sh", [bundle, row.digest, work]);
    const where = `${row.bundle} under ${row.digest.slice(0, 8)}…`;

    // the refusal is an exit status and nothing else — MATRIX.tsv records
    // evidence `none` for both rows, and that stays true: g1 knows the bytes
    // differ, never why, so "corrupt" and "truncated" are one case to it
    assert.notEqual(r.code, 0, `${where}: step 1 accepted a wrong digest`);
    assert.equal(r.stdout, "", `${where}: a refused step 1 must print nothing on stdout`);
    assert.equal(r.stderr, "", `${where}: sha256sum --status is silent by contract`);
    assert.equal(row.evidence, "none", `${where}: the matrix promises no console evidence here`);

    // …and the diagnosis is on disk instead: what you asserted, what the file is
    assert.equal(
      readFileSync(join(work, "expected.sha256"), "utf8"),
      `${row.digest}  ${bundle}\n`,
      `${where}: expected.sha256 must hold the digest that was passed in`,
    );
    assert.equal(
      readFileSync(join(work, "actual.sha256"), "utf8"),
      `${real}  ${bundle}\n`,
      `${where}: actual.sha256 must hold the SHA-256 of the bundle actually offered`,
    );
    assert.notEqual(
      readFileSync(join(work, "actual.sha256"), "utf8"),
      readFileSync(join(work, "expected.sha256"), "utf8"),
      `${where}: the two readings must differ — that difference IS the refusal`,
    );

    // the chain does not continue past a refused digest. actual.sha256 now
    // exists after a refusal, so it can no longer be step 2's guard; the token
    // that only a passing check writes is, and step 2 names it when it is absent.
    assert.ok(!existsSync(join(work, "checksum-ok.txt")), `${where}: a refused step 1 must leave no success token`);
    const two = step(pkg, "02-history.sh", [bundle, work]);
    assert.notEqual(two.code, 0, `${where}: step 2 ran after a refused step 1`);
    assert.equal(two.stdout, "", `${where}: step 2 must print nothing when it refuses`);
    assert.match(two.stderr, /checksum-ok\.txt/, `${where}: step 2 must name the missing artifact`);
  }
});

test("every defective vector is refused at the step vectors/MATRIX.tsv names", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  const base = tmp("sklo-gbv-matrix-");
  const rows = matrix(pkg).filter((r) => r.refuseAt !== 0);
  assert.ok(rows.length >= 6, "the matrix lost rows: four defect classes, two of them read two ways");

  // the four classes must all be represented, or "six rows passed" says nothing
  assert.deepEqual(
    [...new Set(rows.map((r) => r.bundle))].sort(),
    ["corrupt.bundle", "foreign.bundle", "incremental.bundle", "truncated.bundle"],
    "a defect class is missing from the matrix",
  );

  for (const [i, row] of rows.entries()) {
    const work = join(base, `w${i}`);
    const runs = walk(pkg, row, work);
    const where = `${row.bundle} (digest ${row.digest.slice(0, 8)}…, expected refusal at step ${row.refuseAt})`;

    // everything BEFORE the named step has to succeed, or the row proves
    // nothing about the step it names
    for (let s = 0; s < row.refuseAt - 1; s += 1) {
      assert.equal(runs[s]?.code, 0, `${where}: step ${s + 1} failed early: ${runs[s]?.stderr}`);
    }
    assert.equal(runs.length, row.refuseAt, `${where}: the run stopped at step ${runs.length}`);
    const last = runs[runs.length - 1];

    assert.notEqual(last.code, 0, `${where}: the step accepted it`);
    if (row.refuseAt === 4) {
      // g4 refuses BOTH ways: the count is the finding and stays on stdout, and
      // the exit status is what a caller composing steps actually reads. It used
      // to refuse by value alone, so this row passed while `walk` — an exit-status
      // caller — saw four successful steps over a foreign repository's bundle.
      assert.match(last.stdout, /^divergences [1-9][0-9]*\n$/, `${where}: expected a non-zero count`);
      assert.match(last.stderr, /divergences-expected\.txt/, `${where}: the refusal must name what it compared`);
    } else {
      assert.equal(last.stdout, "", `${where}: a refused step must print nothing on stdout`);
    }

    switch (row.evidence) {
      case "prerequisites": {
        // the classifier, and the only failure in the set that names what is
        // missing rather than just refusing
        const prereq = readFileSync(join(work, "prerequisites.txt"), "utf8");
        assert.match(prereq, /^-[0-9a-f]{40}/, `${where}: prerequisites.txt does not name the missing commit`);
        assert.match(readFileSync(join(work, "bundle-verify.txt"), "utf8"), /[0-9a-f]{40}/);
        break;
      }
      case "divergences":
        assert.notEqual(readFileSync(join(work, "divergences.txt"), "utf8"), "");
        break;
      case "none":
        break;
      default:
        assert.fail(`${where}: unknown evidence "${row.evidence}"`);
    }
  }
});

test("a refused g2 leaves its evidence but no success token, and step 3 stops before it clones", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  // the real refusing row, read out of the shipped matrix rather than invented
  // here: the incremental bundle under its OWN digest, so step 1 passes and
  // step 2 is what refuses
  const row = matrix(pkg).find((r) => r.refuseAt === 2)!;
  assert.equal(row.bundle, "incremental.bundle", "MATRIX.tsv no longer carries the g2 row this checks");
  const bundle = join("vectors", row.bundle);
  const work = join(tmp("sklo-gbv-g2-"), "w");

  assert.equal(step(pkg, "01-checksum.sh", [bundle, row.digest, work]).code, 0, "step 1 must pass on its own digest");

  const two = step(pkg, "02-history.sh", [bundle, work]);
  assert.notEqual(two.code, 0, "step 2 accepted an incremental bundle");
  assert.equal(two.stdout, "", "a refused step 2 must print nothing on stdout");

  // the DIAGNOSIS survives the refusal, and has to: git's own words about what
  // is missing, and the list that separates "incremental" from "not a bundle"
  assert.match(readFileSync(join(work, "bundle-verify.txt"), "utf8"), /[0-9a-f]{40}/);
  assert.match(readFileSync(join(work, "prerequisites.txt"), "utf8"), /^-[0-9a-f]{40}/);

  // …and the VERDICT does not. bundle-verify.txt is there because a REDIRECT
  // created it before `git bundle verify` had an exit status — which is exactly
  // why it cannot be step 3's guard, and why a separate token exists.
  assert.ok(!existsSync(join(work, "history-ok.txt")), "a refused step 2 must leave no success token");

  const three = step(pkg, "03-clone.sh", [bundle, work]);
  assert.notEqual(three.code, 0, "step 3 ran after a refused step 2");
  assert.equal(three.stdout, "", "step 3 must print nothing when it refuses");
  assert.match(three.stderr, /history-ok\.txt/, "step 3 must name the missing artifact of the step before it");
  // the refusal is BEFORE the clone, not git's own complaint after one: this is
  // the whole difference the token makes, and `git clone` removes its target on
  // failure, so the exit status alone cannot tell the two apart
  assert.doesNotMatch(three.stderr, /prerequisite commits/, "step 3 must refuse before `git clone` runs");
  assert.ok(!existsSync(join(work, "clone")), "nothing may be cloned after a refused step 2");
});

test("git bundle verify accepts damaged bytes — the recorded finding, pinned so it cannot be quietly forgotten", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  // Step 2 passing here is not a bug in the runbook; it is what git does. The
  // manifest says so in the `damaged-packfile-passes-step-2` failure mode, and
  // SKILL.md warns that a procedure ending at `git bundle verify` is weaker
  // than it reads. If a future git starts inflating the packfile, this case
  // fails and the documentation gets corrected rather than silently outliving
  // the fact it describes.
  for (const bundle of ["corrupt.bundle", "truncated.bundle"]) {
    const work = join(tmp("sklo-gbv-damaged-"), "w");
    const own = createHash("sha256").update(readFileSync(join(pkg, "vectors", bundle))).digest("hex");
    assert.equal(step(pkg, "01-checksum.sh", [join("vectors", bundle), own, work]).code, 0);
    const two = step(pkg, "02-history.sh", [join("vectors", bundle), work]);
    assert.equal(two.code, 0, `${bundle}: git bundle verify now refuses damage — update the documentation`);
    assert.match(readFileSync(join(work, "bundle-verify.txt"), "utf8"), /records a complete history/);
  }
});

// --------------------------------------------------------------- mutations

/** Copy the package and delete the matching CODE lines from one script. */
function withoutLine(pkg: string, script: string, ...needles: string[]): string {
  const out = tmp("sklo-gbv-mutant-");
  const dir = join(out, "pkg");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "vectors", "reference"), { recursive: true });
  for (const rel of [
    "scripts/01-checksum.sh", "scripts/02-history.sh", "scripts/03-clone.sh", "scripts/04-compare.sh",
    "vectors/MATRIX.tsv", "vectors/good.bundle", "vectors/corrupt.bundle", "vectors/truncated.bundle",
    "vectors/incremental.bundle", "vectors/foreign.bundle",
    "vectors/reference/a.txt", "vectors/reference/b.txt",
  ]) {
    writeFileSync(join(dir, rel), readFileSync(join(pkg, rel)));
  }
  const path = join(dir, "scripts", script);
  let text = readFileSync(path, "utf8");
  for (const needle of needles) {
    const lines = text.split("\n");
    // comments are prose: dropping one would change nothing and would hide a
    // needle that matched no code at all
    const kept = lines.filter((l) => !l.includes(needle) || l.trimStart().startsWith("#"));
    assert.notEqual(kept.length, lines.length, `no code line contains "${needle}" in ${script}`);
    text = kept.join("\n");
  }
  writeFileSync(path, text);
  return dir;
}

test("the guards are load-bearing: remove one and the vector it catches slips through", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  const good = createHash("sha256").update(readFileSync(join(pkg, "vectors", "good.bundle"))).digest("hex");

  // g1: without the check, a corrupt bundle offered under the ANNOUNCED digest
  // is accepted — which is exactly what matrix row 2 asserts is refused
  {
    const mutant = withoutLine(pkg, "01-checksum.sh", "sha256sum --check");
    const r = step(mutant, "01-checksum.sh", [join("vectors", "corrupt.bundle"), good, join(tmp("sklo-gbv-m1-"), "w")]);
    assert.equal(r.code, 0, "expected the weakened step 1 to accept a wrong digest");
    assert.equal(r.stdout, "bundle-sha256-ok\n");
  }

  // g1's EVIDENCE, which is an ordering and not a command: put the measurement
  // back below the check — the order this package shipped — and the run that
  // needed the measured digest is exactly the run that never writes it. This is
  // the mutation the assertions above would otherwise be vacuous against.
  {
    const mutant = withoutLine(pkg, "01-checksum.sh", 'sha256sum "$1" >');
    const path = join(mutant, "scripts", "01-checksum.sh");
    const check = 'sha256sum --check --strict --status "$3/expected.sha256"';
    writeFileSync(path, readFileSync(path, "utf8").replace(check, `${check}\nsha256sum "$1" > "$3/actual.sha256"`));

    const work = join(tmp("sklo-gbv-m7-"), "w");
    const r = step(mutant, "01-checksum.sh", [join("vectors", "corrupt.bundle"), good, work]);
    assert.notEqual(r.code, 0, "the mutant must still refuse the wrong digest");
    assert.ok(existsSync(join(work, "expected.sha256")), "the asserted digest is written either way");
    assert.ok(
      !existsSync(join(work, "actual.sha256")),
      "expected the pre-fix order to leave the measured digest unwritten — that was the defect",
    );

    // and the shipped order leaves both, for the same vector and the same digest
    const fixed = join(tmp("sklo-gbv-m7b-"), "w");
    assert.notEqual(step(pkg, "01-checksum.sh", [join("vectors", "corrupt.bundle"), good, fixed]).code, 0);
    assert.ok(existsSync(join(fixed, "actual.sha256")), "the shipped step 1 must leave the measured digest");
    assert.ok(existsSync(join(fixed, "expected.sha256")));
  }

  // g0-work-dir: without the rmdir, a populated work directory is accepted, and
  // a later step's failure leaves the PREVIOUS run's artifacts to be read
  {
    const dirty = join(tmp("sklo-gbv-m2-"), "w");
    mkdirSync(dirty, { recursive: true });
    writeFileSync(join(dirty, "divergences.txt"), "");
    const args = [join("vectors", "good.bundle"), good, dirty];
    assert.notEqual(step(pkg, "01-checksum.sh", args).code, 0, "the shipped step 1 must refuse a populated work dir");
    // back to the `mkdir -p` this replaced: drop the rmdir AND the mkdir that
    // re-creates what it removed, or the mutant refuses for the wrong reason
    const mutant = withoutLine(pkg, "01-checksum.sh", 'rmdir "$3"', 'mkdir "$3"');
    assert.equal(step(mutant, "01-checksum.sh", args).code, 0, "expected the weakened step 1 to accept it");
    assert.ok(existsSync(join(dirty, "divergences.txt")), "the stale artifact survived, which is the hazard");
  }

  // g0-git-version: the bound is live, not decoration. Raising the required
  // version is the mutation that can be run on any machine — lowering the
  // installed git cannot.
  {
    const mutant = withoutLine(pkg, "01-checksum.sh", "git version 2.30.0");
    const path = join(mutant, "scripts", "01-checksum.sh");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        'cat "$3/git-required.txt"',
        'printf \'git version 99.0.0\\n\' > "$3/git-required.txt"\ncat "$3/git-required.txt"',
      ),
    );
    const r = step(mutant, "01-checksum.sh", [join("vectors", "good.bundle"), good, join(tmp("sklo-gbv-m3-"), "w")]);
    assert.notEqual(r.code, 0, "a git below the declared minimum must be refused");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /disorder/);
  }

  // g2 carries TWO signals, and each refuses the incremental bundle on its own.
  // That is the point of the pair: the exit status is the refusal, the
  // prerequisite list is the cause, and neither is there for decoration.
  {
    const incremental = createHash("sha256")
      .update(readFileSync(join(pkg, "vectors", "incremental.bundle")))
      .digest("hex");
    for (const dropped of ["git --git-dir=", "cmp "]) {
      const mutant = withoutLine(pkg, "02-history.sh", dropped);
      const work = join(tmp("sklo-gbv-m4-"), "w");
      assert.equal(step(mutant, "01-checksum.sh", [join("vectors", "incremental.bundle"), incremental, work]).code, 0);
      const r = step(mutant, "02-history.sh", [join("vectors", "incremental.bundle"), work]);
      assert.notEqual(r.code, 0, `step 2 without \`${dropped}\` accepted an incremental bundle`);
    }
  }

  // g2's GUARD, and it is load-bearing rather than decorative. `git bundle
  // verify` reads the HEADER, so it accepts a bundle whose packfile is damaged:
  // remove step 2's `cat` on step 1's token and corrupt.bundle, offered under
  // the ANNOUNCED digest — the row MATRIX.tsv says dies at step 1 — passes step
  // 2 as well, printing that it records a complete history.
  {
    const bundle = join("vectors", "corrupt.bundle");
    const mutant = withoutLine(pkg, "02-history.sh", 'cat "$2/checksum-ok.txt"');
    const work = join(tmp("sklo-gbv-m8-"), "w");
    assert.notEqual(step(mutant, "01-checksum.sh", [bundle, good, work]).code, 0, "step 1 must refuse the digest");
    assert.ok(!existsSync(join(work, "checksum-ok.txt")), "a refused step 1 leaves no token — that is the premise");

    const weakened = step(mutant, "02-history.sh", [bundle, work]);
    assert.equal(weakened.code, 0, "expected the unguarded step 2 to accept a bundle step 1 had refused");
    assert.equal(weakened.stdout, "bundle-history-complete\n");
    assert.match(readFileSync(join(work, "bundle-verify.txt"), "utf8"), /records a complete history/);

    // the shipped one refuses BEFORE `git bundle verify` is reached at all —
    // no bundle-verify.txt in the work directory, and the missing token named
    const work2 = join(tmp("sklo-gbv-m8b-"), "w");
    assert.notEqual(step(pkg, "01-checksum.sh", [bundle, good, work2]).code, 0);
    const shipped = step(pkg, "02-history.sh", [bundle, work2]);
    assert.notEqual(shipped.code, 0, "the shipped step 2 must refuse without step 1's token");
    assert.equal(shipped.stdout, "");
    assert.match(shipped.stderr, /checksum-ok\.txt/, "the refusal must name the missing artifact");
    assert.ok(!existsSync(join(work2, "bundle-verify.txt")), "the shipped step 2 must refuse before git bundle verify");
  }

  // g3's GUARD, the same defect class one joint further along. Put it back on
  // bundle-verify.txt — the file the REDIRECT creates before `git bundle verify`
  // has an exit status — and the incremental bundle walks past a REFUSED step 2
  // into `git clone`, which answers on git's own terms about prerequisite
  // commits the operator never named.
  {
    const bundle = join("vectors", "incremental.bundle");
    const incremental = createHash("sha256")
      .update(readFileSync(join(pkg, "vectors", "incremental.bundle")))
      .digest("hex");
    const mutant = withoutLine(pkg, "03-clone.sh", 'cat "$2/history-ok.txt"');
    const path = join(mutant, "scripts", "03-clone.sh");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("set -eu\n", 'set -eu\ncat "$2/bundle-verify.txt" > /dev/null\n'),
    );

    const work = join(tmp("sklo-gbv-m9-"), "w");
    assert.equal(step(mutant, "01-checksum.sh", [bundle, incremental, work]).code, 0);
    assert.notEqual(step(mutant, "02-history.sh", [bundle, work]).code, 0, "step 2 must refuse the increment");
    assert.ok(existsSync(join(work, "bundle-verify.txt")), "the redirect wrote it despite the refusal — the hazard");
    assert.ok(!existsSync(join(work, "history-ok.txt")));

    const weakened = step(mutant, "03-clone.sh", [bundle, work]);
    assert.notEqual(weakened.code, 0, "git refuses the increment on its own terms — no bad bundle is ACCEPTED here");
    assert.doesNotMatch(weakened.stderr, /history-ok\.txt/, "expected the weakened step 3 to get past the guard");
    assert.match(weakened.stderr, /prerequisite commits/, "…and to have actually RUN `git clone`, which is the defect");

    // and the shipped one stops on the token, before the clone
    const shipped = step(pkg, "03-clone.sh", [bundle, work]);
    assert.notEqual(shipped.code, 0);
    assert.equal(shipped.stdout, "");
    assert.match(shipped.stderr, /history-ok\.txt/, "the shipped step 3 must name the missing token");
    assert.doesNotMatch(shipped.stderr, /prerequisite commits/, "…and must never reach `git clone`");
  }

  // g4's refusal: without the comparison, step 4 goes back to reporting a
  // divergent tree by VALUE alone and exiting 0 — the shape this package
  // documented as a trap while shipping it. The foreign bundle is the vector
  // that walks all the way to step 4, so it is the one that shows it.
  {
    const foreign = createHash("sha256")
      .update(readFileSync(join(pkg, "vectors", "foreign.bundle")))
      .digest("hex");
    const mutant = withoutLine(pkg, "04-compare.sh", 'cmp "$1/divergences-expected.txt"');
    const work = join(tmp("sklo-gbv-m6-"), "w");
    const bundle = join("vectors", "foreign.bundle");
    assert.equal(step(mutant, "01-checksum.sh", [bundle, foreign, work]).code, 0);
    assert.equal(step(mutant, "02-history.sh", [bundle, work]).code, 0);
    assert.equal(step(mutant, "03-clone.sh", [bundle, work]).code, 0);

    const weakened = step(mutant, "04-compare.sh", [work, join("vectors", "reference")]);
    assert.equal(weakened.code, 0, "expected the weakened step 4 to accept a foreign bundle");
    assert.match(weakened.stdout, /^divergences [1-9]/, "…while still printing the count nobody read");

    // and the shipped one refuses it, keeping the count
    const shipped = step(pkg, "04-compare.sh", [work, join("vectors", "reference")]);
    assert.notEqual(shipped.code, 0, "the shipped step 4 must refuse by exit status too");
    assert.match(shipped.stdout, /^divergences [1-9]/, "the count must survive the refusal");
  }

  // step 4's early exit: with the guard, the operator is told which artifact of
  // step 3 is missing; without it, git complains about a directory nobody named
  {
    const work = join(tmp("sklo-gbv-m5-"), "w");
    mkdirSync(work, { recursive: true });
    const guarded = step(pkg, "04-compare.sh", [work, join("vectors", "reference")]);
    assert.notEqual(guarded.code, 0);
    assert.match(guarded.stderr, /head-commit\.txt/, "the refusal must name step 3's finding");

    const mutant = withoutLine(pkg, "04-compare.sh", 'cat "$1/head-commit.txt"');
    const bare = step(mutant, "04-compare.sh", [work, join("vectors", "reference")]);
    assert.notEqual(bare.code, 0);
    assert.doesNotMatch(bare.stderr, /head-commit\.txt/, "expected the weakened step 4 to fail on git's terms");
  }
});

test("the counted lines do not depend on which `wc` is installed", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH");
  const pkg = packed();
  const good = createHash("sha256").update(readFileSync(join(pkg, "vectors", "good.bundle"))).digest("hex");
  const env = { ...process.env, PATH: `${paddingWcPath()}:${process.env.PATH ?? ""}` };

  // the shim really does pad, or this test proves nothing
  const probe = spawnSync("sh", ["-c", "printf 'a\\nb\\n' | wc -l"], { env, encoding: "utf8" });
  assert.equal(probe.stdout, "       2\n", "the padding-wc shim is not on PATH");

  const work = join(tmp("sklo-gbv-wc-"), "w");
  const bundle = join("vectors", "good.bundle");
  assert.equal(step(pkg, "01-checksum.sh", [bundle, good, work], env).code, 0);
  assert.equal(step(pkg, "02-history.sh", [bundle, work], env).code, 0);

  // g3 and g4 verbatim: no column padding anywhere in either count
  const three = step(pkg, "03-clone.sh", [bundle, work], env);
  assert.equal(three.code, 0, three.stderr);
  assert.match(three.stdout, /^head-commit [0-9a-f]{40}\nhead-tree [0-9a-f]{40}\ntracked-files 2\nclone-ok\n$/);

  const four = step(pkg, "04-compare.sh", [work, join("vectors", "reference")], env);
  assert.equal(four.code, 0, four.stderr);
  assert.equal(four.stdout, "divergences 0\n");
});

test("runtime.os declares only where the runbook actually runs", () => {
  const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
  const scripts = ["01-checksum.sh", "02-history.sh", "03-clone.sh", "04-compare.sh"]
    .map((f) => readFileSync(join(SRC, "scripts", f), "utf8"))
    .join("\n");

  // Spellings that exist on GNU and nowhere else. A declared `os` is a promise
  // about where the runbook runs, and this is the check that the promise was
  // made against the scripts rather than against a hope: while any of these is
  // in the scripts, `linux` is the only OS the package may claim. Making the
  // claim true would mean choosing a spelling at run time — a conditional — and
  // gate 5 FAILs a conditional as `control-construct`, so there is no version of
  // this package that is both portable and lintable.
  const gnuOnly = [
    "sha256sum",        // BSD/macOS: shasum, different name and check semantics
    "--version-sort",   // BSD sort has neither the long option nor -V
    "sed --quiet",      // BSD sed: -n only
    "--expression=",    // BSD sed: -e only
  ].filter((spelling) => scripts.includes(spelling));

  assert.ok(gnuOnly.length > 0, "no GNU-only spelling found — re-derive what this test guards");
  assert.deepEqual(
    manifest.runtime.os,
    ["linux"],
    `the scripts use GNU-only spellings (${gnuOnly.join(", ")}), so runtime.os cannot claim anything else`,
  );

  // and the prerequisite that carries the reason is not left to be inferred
  assert.ok(
    manifest.scope.prerequisites.some((p: string) => p.includes("GNU") && p.includes("runtime.os")),
    "a prerequisite must say why runtime.os is linux alone",
  );
});
