// ROUND 6 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks are derived from the
// STATEMENT OF THE REQUIREMENT, committed first, and must FAIL on the code as it
// stands. A probe written after the fix cannot discriminate — it was shaped by
// the answer. Its failure at the red commit is the proof, and that failure is
// recorded in the red commit's own message.
//
// THE THREE REQUIREMENTS OF THIS ROUND, AS ATTACKS:
//
//   [I-7] THE SET OF ADMISSIBLE EVIDENCE NAMES IS THE CONTRACT'S, NOT THE
//         CALLER'S. `evidenceOf` took any name of 1..80 characters and stored
//         the object verbatim, so a reviewer put a secret-shaped marker and an
//         `extra_transcript` field through the shipped `/v1/observations`
//         surface and both landed in `observed_records.evidence` word for word.
//         The admissible set is `OUTCOME_CHECK_SHAPE`'s own reads plus the names
//         the SIGNED manifest's `outcome_contract.evidence` declares; everything
//         else is `INVALID_SCHEMA` and nothing is written. Where the contract
//         CANNOT BE READ — an unknown marker, a manifest that does not verify —
//         only the base names are admissible: fail closed.
//
//   [B-4] THE GUARD'S FILE SET IS THE ONE `npm pack` SHIPS, INCLUDING WHAT
//         `prepack` BUILDS. The guard passed `--ignore-scripts`, so it saw 76
//         files where the packer ships 77: `dist-js/cli.js` is produced by
//         `prepack` and read by nobody.
//
//   [D-2] THE VERDICT CARRIES ITS PROVENANCE [I-3], AND THE REGISTRY DOES NOT
//         CLAIM TO HAVE CHECKED WHAT IT CANNOT REACH [M-7], [D-18]. A pair of
//         values a principal reported about a process on its own machine is a
//         SELF-REPORT and is published as one; an artifact under the root THIS
//         REGISTRY manages is something the registry reads itself, and there a
//         `yes` or a `no` is its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import * as outcomeNamespace from "../src/outcome.ts";
import * as activationNamespace from "../src/activation.ts";
import { OUTCOME_CHECK_KINDS, OUTCOME_CHECK_SHAPE, evaluateOutcome, evidenceDigestOf, registryObserved, selfReported } from "../src/outcome.ts";
import { capabilityColumns } from "../src/fleet.ts";
import { arrivalMarker } from "../src/marker.ts";
import { p4Fixture, reviewedVersion, rest, type P4Fixture } from "./p6-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * What `prepack` builds, read out of `package.json` rather than typed here.
 *
 * `[B-4]` compares a real `npm pack` against one run with `--ignore-scripts`,
 * and the difference between them IS this set. Written as a literal it would be
 * a second declaration of the build recipe that can disagree with the first —
 * which is how a count of `+1` outlived the day `prepack` began building two
 * things. Read from the script chain, it cannot: a build added to `prepack`
 * appears here, and if what it writes does not reach the package the comparison
 * below fails and names the file.
 */
function prepackProducts(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const chained = (scripts.prepack ?? "").split("&&").map((s) => s.trim().replace(/^npm run (-s )?/, ""));
  const out: string[] = [];
  for (const name of chained) {
    const outfile = /--outfile\s+(\S+)/.exec(scripts[name] ?? "");
    assert.ok(outfile, `\`prepack\` chains \`${name}\`, whose script names no --outfile: [B-4] cannot say what it builds`);
    out.push(outfile[1]);
  }
  assert.ok(out.length > 0, "`prepack` builds nothing: the premise of [B-4] is gone");
  return out;
}
const PREPACK_PRODUCTS = prepackProducts();

/** Name a thing that does not exist yet WITHOUT taking the file down with a
 *  module error: a missing export must read as one sentence, not twelve. */
function required<T>(mod: Record<string, unknown>, name: string, what: string): T {
  const v = mod[name];
  assert.ok(v !== undefined, `MISSING: \`${name}\` — ${what}`);
  return v as T;
}

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// [I-7] — THE SET OF NAMES COMES FROM THE CONTRACT
// ===========================================================================

/** The contract a version declares, with two names of its OWN beside the
 *  base ones — so "the contract's names pass" is not the same statement as
 *  "the base names pass". */
// ROUND 7 NARROWED THE VALUES, NOT THE NAMES. [I-7]'s subject here is the set of
// admissible NAMES, and it is unchanged. What changed underneath is what a name
// may CARRY: a boolean, a safe integer, a digest of fixed form, or a literal the
// signed check itself declares. So this contract's own extra name carries a
// digest, and `stdout_match` names the digest it expects — the check is an
// equality, because a substring cannot be tested against a digest.
const R6_DIGEST = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
const R6_SUITE_DIGEST = "sha256:5555555555555555555555555555555555555555555555555555555555555555";

const DECLARED_CONTRACT = {
  check: { kind: "stdout_match", stdout_match: R6_DIGEST },
  evidence: ["stdout_sha256", "suite_name"],
  unknown: "no evaluated run of this skill was reported, which is not a failure of it",
};

/** A name and a value shaped like a secret handle, and a name shaped like the
 *  transcript field [I-7] exists to keep out of this database. Neither is a
 *  real credential; both are the shapes a reviewer actually got through. */
const SECRET_NAME = "skln_probe_handle_9f2c4d";
const SECRET_VALUE = "skln-probe-not-a-real-credential-9f2c4d";
const TRANSCRIPT_NAME = "extra_transcript";
const TRANSCRIPT_VALUE = "the assistant said: here is the whole conversation";

interface I7Fixture {
  fx: P4Fixture;
  marker: string;
  report: (records: unknown[]) => { status: number; raw: string; body: any };
}

function i7Fixture(): I7Fixture {
  const fx = p4Fixture();
  const version = reviewedVersion(fx, "i7-probe", { manifest: { outcome_contract: DECLARED_CONTRACT } });
  assert.equal(
    rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
      agent_id: fx.reporter.agent_id,
      action: "report_outcome",
      recipient_scope: "local_agent",
    }).status,
    201,
    "the probe could not grant itself `report_outcome`",
  );
  const report = (records: unknown[]) =>
    rest(fx, "POST", "/v1/observations", fx.keys.reporter, {
      agent_id: fx.owner.agent_id,
      runtime: "codex",
      window: "all_time",
      records,
    });
  return { fx, marker: arrivalMarker(version.versionId), report };
}

/** Every byte this database holds in the two columns a report can reach. */
function storedEvidence(fx: P4Fixture): string {
  const rows = fx.db.prepare("SELECT marker, result, evidence FROM observed_records").all() as Array<{
    marker: string;
    result: string;
    evidence: string | null;
  }>;
  return rows.map((r) => `${r.marker}|${r.result}|${r.evidence ?? ""}`).join("\n");
}

test("[I-7] a name the contract never declared is refused, and NOTHING of it reaches the database", () => {
  const { fx, marker, report } = i7Fixture();

  const planted = report([
    { role: "call", call_id: "i7-1", marker, at_ms: 1 },
    {
      role: "output",
      call_id: "i7-1",
      marker,
      at_ms: 2,
      result: "success",
      evidence: { stdout_sha256: R6_DIGEST, [SECRET_NAME]: SECRET_VALUE, [TRANSCRIPT_NAME]: TRANSCRIPT_VALUE },
    },
  ]);
  console.log(`  a secret-shaped name + \`${TRANSCRIPT_NAME}\` → ${planted.status} ${planted.raw.slice(0, 120)}`);
  assert.notEqual(planted.status, 201, "a name no contract declared was accepted");
  assert.match(planted.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal");

  // THE READ THAT MATTERS. A status code says what the surface answered; the
  // database says what it KEPT. Round 5 checked the first and the second is
  // where the defect lived.
  const kept = storedEvidence(fx);
  console.log(`  rows in observed_records after the refusal: ${kept.length === 0 ? 0 : kept.split("\n").length}`);
  for (const forbidden of [SECRET_NAME, SECRET_VALUE, TRANSCRIPT_NAME, TRANSCRIPT_VALUE]) {
    assert.equal(kept.includes(forbidden), false, `\`${forbidden}\` was written to observed_records`);
  }

  // …and the refusal itself does not echo what it refused: an error message is
  // logged, and a name a caller chose may be the very thing [I-7] keeps out.
  assert.equal(planted.raw.includes(SECRET_NAME), false, "the refusal echoed the name it refused");
  assert.equal(planted.raw.includes(SECRET_VALUE), false, "the refusal echoed the value it refused");
  fx.db.close();
});

test("[I-7] the names the REGISTRY'S OWN CHECKS read are admitted and stored — and a contract's own declaration is not", () => {
  // WHAT THIS PROBE ASSERTED IN ROUND 6, AND WHY IT IS THE OTHER WAY ROUND NOW.
  //
  // Round 6 closed the name SET to "the base names plus whatever the signed
  // contract declared", and this test was its positive control: the contract's
  // own `suite_name` had to be admitted, or the refusal above would have been
  // satisfied by a boundary that admitted nothing at all.
  //
  // Round 9b removed the second half of that set. A declared name is a string
  // the AUTHOR wrote and it was stored as a KEY, and no form separates a key
  // from a secret written in the same alphabet — a hex string of 33 characters
  // is an identifier. So the positive control moves to the names this registry
  // derives from its own check table, and the declaration joins the refusals.
  const { fx, marker, report } = i7Fixture();
  const accepted = report([
    { role: "call", call_id: "i7-2", marker, at_ms: 3 },
    { role: "output", call_id: "i7-2", marker, at_ms: 4, result: "success", evidence: { stdout_sha256: R6_DIGEST } },
  ]);
  console.log(`  the registry's own \`stdout_sha256\` → ${accepted.status} ${accepted.raw.slice(0, 100)}`);
  assert.equal(accepted.status, 201, "a name this registry's own checks read was refused, so the refusal above is vacuous");
  const kept = storedEvidence(fx);
  assert.ok(kept.includes("stdout_sha256"), "an admitted named value was not stored");
  assert.ok(kept.includes(R6_DIGEST), "an admitted value was not stored");

  // …AND THE CONTRACT'S OWN `suite_name`, WHICH THIS VERY FIXTURE DECLARES IN A
  // SIGNED MANIFEST, IS REFUSED. `outcome_contract.evidence` is the author's
  // declaration of what a run ought to present and is not a source of admissible
  // names for this journal [9b].
  const declared = report([
    { role: "call", call_id: "i7-2b", marker, at_ms: 5 },
    { role: "output", call_id: "i7-2b", marker, at_ms: 6, result: "success", evidence: { suite_name: R6_SUITE_DIGEST } },
  ]);
  console.log(`  the contract's own \`suite_name\`   → ${declared.status} ${declared.raw.slice(0, 100)}`);
  assert.equal(declared.status, 400, "a name the signed contract declared was admitted: the widening is still there");
  assert.match(declared.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal");
  assert.equal(storedEvidence(fx).includes("suite_name"), false, "the refused declaration was written anyway");
  fx.db.close();
});

test("[I-7] where the contract cannot be read, only the base names are admissible — fail closed", () => {
  const { fx, report } = i7Fixture();
  // A WELL-FORMED MARKER OF NO VERSION THIS REGISTRY KNOWS. The record is still
  // written — `observed_records` takes any marker of the right shape — so this
  // is the case where a contract simply cannot be consulted.
  const stranger = arrivalMarker("01K1M83S80ZZZZZZZZZZZZZZZZ");
  const base = report([
    { role: "call", call_id: "i7-3", marker: stranger, at_ms: 5 },
    // FAIL CLOSED APPLIES TO THE VALUES TOO. With no contract to read there is
    // no enumeration of literals, so the base names may still be presented but
    // only as booleans, integers and digests — a path or a command line is a
    // literal, and no signed document here declares one.
    { role: "output", call_id: "i7-3", marker: stranger, at_ms: 6, result: "success", evidence: { exit_code: 0, stdout_sha256: R6_DIGEST, artifacts: [R6_DIGEST] } },
  ]);
  console.log(`  base names under an unknown marker → ${base.status}`);
  assert.equal(base.status, 201, "the four base names must always be admissible");

  // …and a name that ANOTHER version's contract declares is NOT admissible
  // here, because no contract can be read for this marker.
  const borrowed = report([
    { role: "call", call_id: "i7-4", marker: stranger, at_ms: 7 },
    { role: "output", call_id: "i7-4", marker: stranger, at_ms: 8, result: "success", evidence: { stdout_sha256: R6_DIGEST, suite_name: R6_SUITE_DIGEST } },
  ]);
  console.log(`  a contract name under an unknown marker → ${borrowed.status} ${borrowed.raw.slice(0, 100)}`);
  assert.notEqual(borrowed.status, 201, "a name no readable contract declares was accepted under an unknown marker");
  assert.equal(storedEvidence(fx).includes("suite_name"), false, "the fail-closed refusal still wrote the value");
  fx.db.close();
});

test("[I-7] the base set is DERIVED FROM THE CODE — every name the checks read, and no other", () => {
  const names = required<readonly string[]>(
    outcomeNamespace as unknown as Record<string, unknown>,
    "EVIDENCE_NAMES",
    "[I-7] requires the base set of admissible evidence names to be exported and derived from `OUTCOME_CHECK_SHAPE`, not written out as a literal at the boundary",
  );

  // THE SET IS DERIVED BY RUNNING THE CHECKS, not by reading a list. Every kind
  // is executed against a recording proxy, and the union of the names the
  // evaluator actually touches must be exactly the exported set. A kind added
  // later that reads a fifth name fails here rather than silently widening what
  // the boundary accepts.
  const touched = new Set<string>();
  const full: Record<string, unknown> = { exit_code: 0, stdout_sha256: R6_DIGEST, artifacts: [evidenceDigestOf("out/report.json")], command: evidenceDigestOf("true") };
  for (const kind of OUTCOME_CHECK_KINDS) {
    const shape = OUTCOME_CHECK_SHAPE[kind]!;
    const contract = {
      check: {
        kind,
        exit_code: 0,
        // a digest, because a `stdout_match` whose pattern is a substring is
        // no longer executable and would read nothing at all — a check that
        // refuses to run touches no name, and this probe is about the names the
        // checks DO read
        stdout_match: R6_DIGEST,
        artifact_path: "out/report.json",
        command: "true",
      },
      evidence: [shape.evidence],
      unknown: "nothing was evaluated, which is not a failure of it",
    };
    const recorder = new Proxy({ ...full }, {
      get(target, prop, receiver) {
        if (typeof prop === "string") touched.add(prop);
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (typeof prop === "string") touched.add(prop);
        return Reflect.has(target, prop);
      },
    });
    const got = evaluateOutcome(contract, recorder);
    console.log(`  ${String(kind).padEnd(16)} → ${got.value} (${got.reason})`);
  }
  const derived = [...touched].filter((n) => n !== "then").sort();
  console.log(`  names the four checks read: ${derived.join(", ")}`);
  console.log(`  names the boundary admits:  ${[...names].sort().join(", ")}`);
  assert.deepEqual(derived, [...names].sort(), "the admissible base set is not the set the checks read");
});

// ===========================================================================
// [B-4] — THE SUBJECT IS WHAT `npm pack` SHIPS, `prepack` INCLUDED
// ===========================================================================

/**
 * A TREE THE PACKER MAY BUILD IN, and this test's own, built independently of
 * the guard so that "the two agree" is a comparison and not a tautology.
 *
 * Only what git tracks is copied, so there is no `dist-js/` in it: a FRESH tree
 * is exactly the condition under which `--ignore-scripts` and a real pack
 * disagree. `node_modules` is linked rather than copied — `prepack` needs it and
 * nothing writes into it.
 */
function freshTree(): string {
  const dir = temp("skln-r6-pack-");
  const listing = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 });
  for (const rel of listing.split("\0").filter((s) => s.length > 0)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), readFileSync(join(REPO_ROOT, rel)));
  }
  execFileSync("ln", ["-s", join(REPO_ROOT, "node_modules"), join(dir, "node_modules")]);
  return dir;
}

let probeCache: string | null = null;
function probeNpmCache(): string {
  if (probeCache === null) probeCache = temp("skln-r6-npm-cache-");
  return probeCache;
}

/** `npm pack --dry-run --json` in `cwd`, tolerating whatever a lifecycle script
 *  printed before the JSON — which is the whole reason the flag was there. */
function realPack(cwd: string, ignoreScripts: boolean): string[] {
  const args = ["pack", "--dry-run", "--json", ...(ignoreScripts ? ["--ignore-scripts"] : [])];
  // TWO ATTEMPTS, ANNOUNCED. Same reason as the guard's own enumeration: this
  // spawns a packer that runs a build while sixty test files are running, and a
  // lost race is not a fact about the package. A second failure fails the probe.
  let out = "";
  let failure: { stderr?: string; message?: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      out = execFileSync("npm", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1 << 26,
        // a cache of this probe's own: the default one is shared, and two
        // packers racing on it produce an `EEXIST` that is a fact about npm
        env: { ...process.env, npm_config_cache: probeNpmCache() },
      });
      failure = null;
      break;
    } catch (e) {
      failure = e as { stderr?: string; message?: string };
      console.log(`  npm pack attempt ${attempt} failed in ${cwd}: ${String(failure.message).split("\n")[0]} :: ${String(failure.stderr ?? "").split("\n").filter(Boolean).slice(0, 12).join(" / ")}`);
    }
  }
  if (failure !== null) {
    assert.fail(`npm pack failed twice in ${cwd}: ${String(failure.message).slice(0, 200)} :: STDERR ${String(failure.stderr ?? "").slice(0, 600)}`);
  }
  const start = /^\[/m.exec(out);
  assert.ok(start, `\`npm pack --json\` produced no JSON array in ${cwd}`);
  const parsed = JSON.parse(out.slice(start.index)) as Array<{ files?: Array<{ path?: string }> }>;
  return parsed.flatMap((p) => (p.files ?? []).map((f) => String(f.path ?? ""))).filter((p) => p.length > 0).sort();
}

test("[B-4] the guard's file set is the set a REAL pack ships, `prepack`'s product included", async () => {
  const g = await import("./docs-guard.ts");

  // THE FLAG ITSELF. `--ignore-scripts` is the whole defect: it answers "which
  // files does the manifest list" where the question is "which files does a
  // user receive". It is asserted against the guard's own source because the
  // enumeration it produces is INDISTINGUISHABLE from the right one whenever a
  // stale `dist-js/` happens to be lying in the working tree — which is exactly
  // how it survived a round.
  const guardSource = readFileSync(new URL("./docs-guard.ts", import.meta.url), "utf8");
  assert.equal(
    /["']--ignore-scripts["']/.test(guardSource),
    false,
    "the guard enumerates with `--ignore-scripts`: it sees what the manifest lists, not what `npm pack` ships",
  );

  // …and it enumerates SOMEWHERE ELSE. `prepack` writes, and a guard that
  // builds into the working tree breaks the "the tree is clean" check the whole
  // regime rests on.
  const packRoot = required<() => string>(
    g as unknown as Record<string, unknown>,
    "packRoot",
    "[B-4] requires the enumeration to run where a `prepack` write is harmless — a tree of the guard's own, not the repository",
  )();
  console.log(`  the guard packs in: ${packRoot}`);
  assert.notEqual(packRoot.replace(/\/$/, ""), REPO_ROOT.replace(/\/$/, ""), "the guard packs in the working tree");
  const enumerated = g.packedFiles();
  assert.ok(existsSync(join(packRoot, "dist-js", "cli.js")), "`prepack` did not build in the tree the guard packs in");

  // ONE TREE, TWO ENUMERATIONS, IN THE ORDER THAT KEEPS THE SECOND HONEST: the
  // `--ignore-scripts` run first, while the tree is still fresh, and the real
  // one after — which is also the order that runs `bun build` once.
  const tree = freshTree();
  assert.equal(existsSync(join(tree, "dist-js", "cli.js")), false, "the probe's tree is not fresh: it already holds a build");
  const withoutScripts = realPack(tree, true);
  const shipped = realPack(tree, false);
  console.log(`  a real pack on a fresh tree:            ${shipped.length} files`);
  console.log(`  the same tree with --ignore-scripts:    ${withoutScripts.length} files`);
  console.log(`  the guard's own enumeration:            ${enumerated.length} files`);

  // THE DISCRIMINATION, STATED AS A FACT ABOUT THE TWO ENUMERATIONS: the flag
  // the guard passes is exactly the difference between them.
  //
  // NAMED, NOT COUNTED. This used to assert `shipped.length ===
  // withoutScripts.length + 1`, which is the same claim only for as long as
  // `prepack` builds exactly one thing. It built two the moment the Owner
  // Console bundle was added to it, and a probe about WHICH files a user
  // receives then failed with "121 !== 120" — a number, naming neither the file
  // that appeared nor the one that should have. The difference is now read out
  // as a SET and compared against what `prepack` is declared to build, so the
  // next artifact added to that script either shows up here by name or fails
  // here by name.
  const built = PREPACK_PRODUCTS;
  for (const f of built) {
    assert.ok(shipped.includes(f), `a real pack does not ship \`prepack\`'s product ${f}: the premise is wrong`);
    assert.equal(withoutScripts.includes(f), false, `\`--ignore-scripts\` shipped ${f} anyway`);
  }
  const onlyInShipped = shipped.filter((f) => !withoutScripts.includes(f)).sort();
  assert.deepEqual(
    onlyInShipped,
    [...built].sort(),
    "the two enumerations differ by something other than the files `prepack` builds",
  );

  // …AND THE GUARD MUST BE ON THE FIRST SIDE OF THAT DIFFERENCE.
  assert.deepEqual(enumerated, shipped, "the guard enumerates a different package from the one npm ships");

  // …and it must READ what it enumerates. A file in the subject that nothing
  // opens is the round-3 defect with a longer list.
  const documents: Array<[string, string]> = g.documentSet();
  const read = new Map(documents);
  assert.ok(read.has("dist-js/cli.js"), "`dist-js/cli.js` is shipped and the guard does not read it");
  assert.ok((read.get("dist-js/cli.js") ?? "").length > 0, "`dist-js/cli.js` was read as nothing");
  const unread = shipped.filter((f) => !read.has(f));
  assert.deepEqual(unread, [], "files the package ships that the guard does not read");
});

test("[B-4] enumerating the package leaves NO TRACE in the working tree", async () => {
  // The trap in removing `--ignore-scripts`: `prepack` WRITES. A guard that
  // builds into the working tree breaks the "the tree is clean" check the whole
  // regime rests on, and it does it silently — `dist-js/` is ignored, so the
  // damage would be a stale artifact nobody sees rather than a red status.
  const before = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], { encoding: "utf8" });
  const built = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  assert.match(built, /"prepack"/, "the premise is gone: this package no longer builds on pack");
  // the enumeration and the whole read, between the two readings of the status
  const g = await import("./docs-guard.ts");
  assert.ok(g.packedFiles().length > 0);
  assert.ok(g.documentSet().length > 0);
  const after = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], { encoding: "utf8" });
  console.log(`  git status entries before: ${before.trim().split("\n").filter(Boolean).length}, after: ${after.trim().split("\n").filter(Boolean).length}`);
  assert.equal(after, before, "enumerating the package changed the working tree");
});

// ===========================================================================
// [D-2] / [M-6] / [D-18] — THE VERDICT CARRIES ITS PROVENANCE
// ===========================================================================

const REMOTE_CONTRACT = {
  check: { kind: "command", command: "false" },
  evidence: ["command", "exit_code"],
  unknown: "no evaluated run of this skill was reported, which is not a failure of it",
};

interface Assessment {
  value: string;
  reason: string;
  assessed_by: string;
  principal_type: string | null;
  basis: string;
  claim: string | null;
}

function assessor(): (input: unknown) => Assessment {
  return required(
    outcomeNamespace as unknown as Record<string, unknown>,
    "assessOutcome",
    "[D-18] requires the verdict to carry WHO assessed it, the principal's TYPE, and whether it is a self-report or the registry's own observation [I-3]",
  );
}

test("[D-18] a pair of values reported about somebody else's machine is a SELF-REPORT, not a `yes`", () => {
  const assess = assessor();
  const got = assess({
    contract: REMOTE_CONTRACT,
    // ROUND 7: values carry the mark of whoever produced them, set where they
    // are accepted. The verdict's authority is read off that mark and is no
    // longer inferred from which branch of the assessor happened to run.
    // ROUND 8: the value presented for a `command` check is the DIGEST of the
    // command the signed contract names — the command itself is an author's
    // string and is no longer admissible as evidence.
    claimed: selfReported({ command: evidenceDigestOf("false"), exit_code: 0 }),
    observed: null,
    principal: { type: "agent" },
  });
  console.log(`  the digest of \`false\` with exit 0, claimed by an agent → ${got.value} (${got.reason})`);
  console.log(`      assessed_by=${got.assessed_by} principal_type=${got.principal_type} basis=${got.basis} claim=${got.claim}`);

  // THE REGISTRY RAN NOTHING. `false` exits 1 on every machine there is, and the
  // report says 0 — which the registry cannot contradict and must not confirm.
  assert.notEqual(got.value, "yes", "the registry published a `yes` for a process it never ran [M-6], [M-7]");
  assert.equal(got.assessed_by, "principal", "the verdict does not say who assessed it");
  assert.equal(got.principal_type, "agent", "the verdict does not carry the principal's type [I-5]");
  assert.equal(got.basis, "self_report", "a self-report is not named as one");
  assert.equal(got.claim, "yes", "the self-report itself is not published: a claim nobody prints is a claim nobody can dispute");
  assert.ok(got.reason.length > 0, "an answer with no reason [I-3]");

  // [I-1]: still three-valued. Provenance is an attribute BESIDE the value, and
  // never a fourth answer.
  assert.ok(["yes", "no", "unknown"].includes(got.value), "the verdict left the three answers");
});

test("[D-18] an artifact under the root THIS REGISTRY manages is the registry's own `yes` or `no`", () => {
  const assess = assessor();
  const observe = required<(site: unknown, contract: unknown, placed: unknown) => Record<string, unknown> | null>(
    activationNamespace as unknown as Record<string, unknown>,
    "registryObservedEvidence",
    "[D-18] requires the registry to produce evidence of its OWN for the one thing it can check: an artifact under the activation root it manages",
  );

  const root = temp("skln-r6-root-");
  const site = { root, target: "codex" };
  const contract = {
    check: { kind: "artifact_exists", artifact_path: ".agents/skills/probe/SKILL.md" },
    evidence: ["artifacts"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
  // ROUND 7 NARROWED THIS. "A file under a root the registry manages" is not
  // "a file the registry put there", and only the second is something it has
  // standing to certify. So its own reading now requires its OWN JOURNAL's
  // record of the placement, and the round-7 probes exercise what happens when
  // that record is missing, names another path, or the copy was removed.
  const placed = { target: "codex", native_relpath: ".agents/skills/probe/SKILL.md", managed_copy: "written" };

  // NOTHING IS THERE — and the registry LOOKED, so this is a `no` and not an
  // `unknown`: the difference between a walk that found nothing and no walk.
  const absent = assess({ contract, claimed: null, observed: observe(site, contract, placed), principal: { type: "agent" } });
  console.log(`  the artifact absent under the registry's root → ${absent.value} (${absent.reason}) by ${absent.assessed_by}/${absent.basis}`);
  assert.equal(absent.value, "no", "the registry read its own root and would not say what it found");
  assert.equal(absent.assessed_by, "registry");
  assert.equal(absent.basis, "registry_observation");

  // …and now it IS there.
  mkdirSync(join(root, ".agents", "skills", "probe"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "probe", "SKILL.md"), "# probe\n");
  const present = assess({ contract, claimed: null, observed: observe(site, contract, placed), principal: { type: "agent" } });
  console.log(`  the artifact present under the same root     → ${present.value} (${present.reason}) by ${present.assessed_by}/${present.basis}`);
  assert.equal(present.value, "yes", "the registry read the file it manages and did not answer for it");
  assert.equal(present.assessed_by, "registry", "a verdict the registry established was attributed to a principal");
  assert.equal(present.basis, "registry_observation");

  // A PATH THAT LEAVES THE ROOT IS NOT OBSERVABLE, and the registry says so by
  // observing nothing rather than by reading somebody else's disk.
  const outside = {
    check: { kind: "artifact_exists", artifact_path: "../../etc/hostname" },
    evidence: ["artifacts"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
  assert.equal(
    observe(site, outside, { ...placed, native_relpath: "../../etc/hostname" }),
    null,
    "the registry observed a path outside the root it manages",
  );
  assert.equal(observe(null, contract, placed), null, "the registry observed something with no root configured at all");
});

/**
 * A CONTRACT AND A PAIR OF EVIDENCE OBJECTS FOR EVERY DECLARED CHECK KIND,
 * DISCOVERED RATHER THAN LISTED.
 *
 * The particular case D-18 names — `{"command":"false","exit_code":0}` — proves
 * one path. Four rounds of this project were lost to exactly that: a fix
 * bounded by the case its author could write down. So the set of kinds is
 * `OUTCOME_CHECK_SHAPE` itself, the named values are that kind's own `reads`,
 * and the SATISFYING and REFUTING evidence is FOUND by asking the shipped
 * evaluator which combinations it answers `yes` and `no` to. Nothing about any
 * particular kind is written here.
 *
 * A kind added tomorrow is swept without an edit. A kind this search cannot
 * excite FAILS rather than being skipped: an evidence state nothing can reach
 * is a hole in the sweep, not an absence of one.
 */
function excitableKinds(): Array<{ kind: string; contract: any; satisfying: Record<string, unknown>; refuting: Record<string, unknown> }> {
  const out: Array<{ kind: string; contract: any; satisfying: Record<string, unknown>; refuting: Record<string, unknown> }> = [];
  for (const kind of OUTCOME_CHECK_KINDS) {
    const shape = OUTCOME_CHECK_SHAPE[kind]!;
    // the contract's own parameter, typed by the one thing the reader already
    // knows about it: `exit_code` is an integer and the other three are strings
    // 2.3: a `stdout_match` names the DIGEST it expects — a substring pattern is
    // not executable by this registry, so a kind given one could not be excited
    // at all and the sweep below would refuse rather than skip it.
    const parameter: unknown =
      shape.parameter === "exit_code" ? 0 : shape.parameter === "stdout_match" ? R6_DIGEST : `skln-probe-${kind}`;
    const contract = {
      check: { kind, [shape.parameter]: parameter },
      evidence: [...shape.reads],
      unknown: "no evaluated run of this skill was reported, which is not a failure of it",
    };
    // THE CANDIDATE VALUES, built from the contract rather than from knowledge
    // of what any check does: the parameter itself, the parameter in a list,
    // the two integers a status can be, something that matches nothing, and an
    // empty list.
    // …and a SECOND digest, so a kind that reads one has something to be
    // refuted by. Under 2.3 a value that is not a digest is not of a shape the
    // check can read at all, which is `unknown` and not `no` — without this the
    // search space could excite `yes` for `stdout_match` and never `no`.
    // ROUND 8: where the table says a kind compares the DIGEST of its signed
    // parameter, the value a run PRESENTS is that digest and not the parameter.
    // Read off `digest_of` rather than listed, so a kind that starts comparing
    // one is excited the day it is added.
    const presented: unknown[] =
      typeof shape.digest_of === "string" ? [evidenceDigestOf(String(parameter)), [evidenceDigestOf(String(parameter))]] : [];
    const candidates: unknown[] = [parameter, [parameter], ...presented, 0, 1, "skln-probe-matches-nothing", [], R6_SUITE_DIGEST];
    const names = [...shape.reads];
    const combinations: Array<Record<string, unknown>> = [];
    const build = (i: number, acc: Record<string, unknown>): void => {
      if (i === names.length) {
        combinations.push({ ...acc });
        return;
      }
      for (const v of candidates) build(i + 1, { ...acc, [names[i]!]: v });
    };
    build(0, {});
    const satisfying = combinations.find((c) => evaluateOutcome(contract, c).value === "yes");
    const refuting = combinations.find((c) => evaluateOutcome(contract, c).value === "no");
    assert.ok(satisfying, `no evidence in the search space makes a \`${kind}\` check answer \`yes\`: this sweep cannot excite the kind and would skip it`);
    assert.ok(refuting, `no evidence in the search space makes a \`${kind}\` check answer \`no\`: this sweep cannot excite the kind and would skip it`);
    out.push({ kind, contract, satisfying, refuting });
  }
  return out;
}

test("[D-18] NO check kind, of the set the CODE declares, turns a principal's evidence into a verdict", () => {
  const assess = assessor();
  const kinds = excitableKinds();
  assert.deepEqual(kinds.map((k) => k.kind).sort(), [...OUTCOME_CHECK_KINDS].sort(), "the sweep lost a kind between discovery and use");
  console.log(`[D-18] check kinds discovered from OUTCOME_CHECK_SHAPE: ${kinds.map((k) => k.kind).join(", ")}`);

  const escaped: string[] = [];
  let claims = 0;
  let verdicts = 0;
  for (const k of kinds) {
    for (const [label, evidence, conclusion] of [
      ["satisfying", k.satisfying, "yes"],
      ["refuting", k.refuting, "no"],
    ] as Array<[string, Record<string, unknown>, string]>) {
      // ---- PRESENTED BY A PRINCIPAL. There is no path to a verdict.
      for (const type of ["human", "agent", "service"] as const) {
        const claimed = assess({ contract: k.contract, claimed: selfReported(evidence), observed: null, principal: { type } });
        claims += 1;
        if (claimed.value !== "unknown") {
          escaped.push(`${k.kind} · ${label} · claimed by a ${type} → ${claimed.value}: a verdict out of evidence nobody checked`);
        }
        if (claimed.basis !== "self_report") escaped.push(`${k.kind} · ${label} · ${type} → basis ${claimed.basis}`);
        if (claimed.assessed_by !== "principal") escaped.push(`${k.kind} · ${label} · ${type} → assessed_by ${claimed.assessed_by}`);
        if (claimed.principal_type !== type) escaped.push(`${k.kind} · ${label} · ${type} → principal_type ${claimed.principal_type}`);
        if (claimed.claim !== conclusion) escaped.push(`${k.kind} · ${label} · ${type} → claim ${claimed.claim}, expected ${conclusion}`);
      }
      // ---- READ BY THE REGISTRY. Here, and only here, there IS one.
      // ROUND 7's NARROWING ON THIS AXIS. Values the registry produced ITSELF
      // still decide nothing for a kind whose subject is a process on somebody
      // else's machine: `observable` is read off `OUTCOME_CHECK_SHAPE`, so the
      // set of kinds that may answer is the CODE's and not a list written here.
      const observable = OUTCOME_CHECK_SHAPE[k.kind]!.observable;
      const own = assess({ contract: k.contract, claimed: null, observed: registryObserved(evidence), principal: { type: "agent" } });
      const expected = observable ? conclusion : "unknown";
      if (observable) verdicts += 1;
      if (own.value !== expected) escaped.push(`${k.kind} · ${label} · read by the registry → ${own.value} (${own.reason}), expected ${expected}`);
      if (own.basis !== "registry_observation") escaped.push(`${k.kind} · ${label} · registry → basis ${own.basis}`);
      console.log(`  ${k.kind.padEnd(16)} ${label.padEnd(10)} claimed → unknown/${conclusion}   observed → ${own.value}${observable ? "" : "  (not a kind this registry can observe)"}`);
    }
  }
  console.log(`[D-18] principal-presented combinations that produced NO verdict: ${claims}`);
  console.log(`[D-18] registry-read combinations that produced one: ${verdicts}`);
  assert.deepEqual(escaped, [], "evidence a principal presented reached §4's fact column as a verdict");
  assert.equal(claims, OUTCOME_CHECK_KINDS.length * 2 * 3, "the sweep did not cover every kind × both conclusions × every principal type");
  const observableKinds = OUTCOME_CHECK_KINDS.filter((k) => OUTCOME_CHECK_SHAPE[k]!.observable).length;
  console.log(`[D-18] kinds this registry may observe at all: ${observableKinds} of ${OUTCOME_CHECK_KINDS.length} — round 7's narrowing`);
  assert.ok(observableKinds > 0, "no kind is observable at all, so the registry axis proves nothing");
  assert.equal(verdicts, observableKinds * 2, "the registry's own reading must still answer for the kinds it CAN observe, or the sweep proves only that nothing answers");
});

test("[D-18] the assessor that publishes a claim as a verdict is KILLED on the same evidence", async () => {
  // THE MUTATION IS THE OTHER READING OF D-18 §3 — a self-report that reaches
  // the fact column as `yes` so long as it is labelled. [I-2] forbids it in the
  // same words it forbids intent in a fact column, and this is the guard that
  // says so on running code rather than in a comment.
  const dir = temp("skln-r6-mutant-");
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const f of ["outcome.ts"]) {
    const before = readFileSync(join(REPO_ROOT, "src", f), "utf8");
    // THE MUTATION IS THE SAME READING OF D-18 §3 AS BEFORE — a self-report
    // that reaches the fact column as `yes` so long as it is LABELLED — written
    // against the shape the code has after round 7. `stands` is the one
    // expression that decides whether a verdict rests on this registry's
    // authority; the mutant makes every executed check rest on it.
    const from = `    value: stands ? verdict.value : "unknown",`;
    const to = `    value: verdict.value,`;
    assert.equal(before.split(from).length - 1, 1, `the mutation template must occur EXACTLY ONCE in src/${f}`);
    writeFileSync(join(dir, "src", f), before.replace(from, to));
  }
  const mutated = (await import(`${dir}/src/outcome.ts`)) as {
    assessOutcome: (i: unknown) => Assessment;
    selfReported: (v: Record<string, unknown>) => unknown;
  };

  const kinds = excitableKinds();
  // EACH MODULE MARKS WITH ITS OWN CONSTRUCTOR. The mark is membership in a
  // `WeakMap` held in a module's closure, and the mutant is a SECOND instance of
  // the module with a closure of its own — so values marked by the shipped
  // build are correctly foreign to it. That is the mechanism working, not an
  // obstacle to the test, and each side marks its own.
  const shipped = kinds.map((k) => assessor()({ contract: k.contract, claimed: selfReported(k.satisfying), observed: null, principal: { type: "agent" } }));
  const broken = kinds.map((k) =>
    mutated.assessOutcome({ contract: k.contract, claimed: mutated.selfReported(k.satisfying), observed: null, principal: { type: "agent" } }),
  );
  for (const [i, k] of kinds.entries()) {
    console.log(`  ${k.kind.padEnd(16)} shipped → ${shipped[i]!.value}   mutant → ${broken[i]!.value} (labelled ${broken[i]!.basis})`);
  }
  assert.deepEqual(shipped.map((a) => a.value), kinds.map(() => "unknown"), "the shipped build must refuse, or the mutation proves nothing");
  assert.deepEqual(
    broken.map((a) => a.value),
    kinds.map(() => "yes"),
    "THE MUTANT SURVIVED: the labelled-`yes` reading answered `unknown` anyway, so this test discriminates nothing",
  );
  // …and the mutant is exactly what the sweep above refuses
  assert.ok(broken.every((a) => a.basis === "self_report"), "the mutant must still be LABELLED, or it is a different mutation");
});

test("[D-18] every `outcome` column carries its basis — the attribute is a METHOD, not a note about an exception", async () => {
  const fleet = await import("../src/fleet.ts");
  const missing = required<(v: unknown) => string | null>(
    fleet as unknown as Record<string, unknown>,
    "missingVerdictAttribute",
    "[D-18] requires `basis` on EVERY verdict: an attribute that appears only when the answer is doubtful reads as a note about an exception [I-3]",
  );
  const sweep = required<(columns: readonly any[]) => string | null>(
    fleet as unknown as Record<string, unknown>,
    "unverdicted",
    "[D-18] requires the rule to be applicable to a FINISHED answer, not only at construction",
  );

  const CONTRACT = {
    check: { kind: "stdout_match", stdout_match: "ALL GREEN" },
    evidence: ["stdout_sha256"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
  const marker = arrivalMarker("01K1M83S80CCCCCCCCCCCCCCCC");
  const snap = (records: any[], reported: unknown) => ({
    agent_id: "01K1M83S80AAAAAAAAAAAAAAAA",
    runtime: "codex",
    model: null,
    session_active: "unknown",
    last_activity_ms: null,
    window: "all_time",
    window_detail: "the probe's own records, all time",
    proposal_inventory_complete: false,
    reported_by: reported,
    records,
  });
  const rec = (over: any) => ({ agent_id: "01K1M83S80AAAAAAAAAAAAAAAA", runtime: "codex", role: "output", call_id: "c", at_ms: 1, marker, result: "unknown", evidence: null, ...over });
  const base = (over: any) => ({
    runtime: "codex",
    subject: { skill_version_id: "01K1M83S80CCCCCCCCCCCCCCCC", marker, has_executable_step: true },
    registered: { value: "yes", reason: null, window_detail: "a tree built by the probe" },
    intent: null,
    snapshot: null,
    outcome_contract: null,
    ...over,
  });

  // EVERY WAY THE COLUMN CAN BE REACHED, not the doubtful ones only.
  const cases: Array<[string, any]> = [
    ["no contract at all", base({})],
    ["a contract and nothing observed", base({ outcome_contract: CONTRACT })],
    ["a run that presented no evidence", base({ outcome_contract: CONTRACT, snapshot: snap([rec({ role: "call", call_id: "p" }), rec({ call_id: "p" })], { agent_id: "a", type: "agent" }) })],
    ["a self-report that satisfies", base({ outcome_contract: CONTRACT, snapshot: snap([rec({ role: "call", call_id: "q" }), rec({ call_id: "q", evidence: selfReported({ stdout_sha256: R6_DIGEST }) })], { agent_id: "a", type: "service" }) })],
    ["the registry's own reading", base({ outcome_contract: { check: { kind: "artifact_exists", artifact_path: "out/x" }, evidence: ["artifacts"], unknown: "nothing was evaluated" }, observed_evidence: registryObserved({ artifacts: [evidenceDigestOf("out/x")] }) })],
    ["the registry's own reading, negative", base({ outcome_contract: { check: { kind: "artifact_exists", artifact_path: "out/x" }, evidence: ["artifacts"], unknown: "nothing was evaluated" }, observed_evidence: registryObserved({ artifacts: [] }) })],
  ];
  const naked: string[] = [];
  for (const [label, ev] of cases) {
    const columns = capabilityColumns(ev);
    const outcome = columns.find((c: any) => c.column === "outcome")!;
    console.log(`  ${label.padEnd(34)} → ${outcome.value} · basis: ${outcome.assessment?.basis} · assessed_by: ${outcome.assessment?.assessed_by}`);
    if (missing(outcome) !== null) naked.push(`${label}: \`${missing(outcome)}\``);
    if (sweep(columns) !== null) naked.push(`${label}: the sweep found ${sweep(columns)}`);
    if (outcome.assessment?.basis === undefined) naked.push(`${label}: no basis at all`);
  }
  assert.deepEqual(naked, [], "an `outcome` column was published without its provenance [I-3], [D-18]");

  // …and a verdict stripped of its basis is REFUSED by the same rule, or the
  // six passes above are six objects that happened to have a field.
  const stripped = { ...capabilityColumns(base({ outcome_contract: CONTRACT })).find((c: any) => c.column === "outcome")! } as any;
  delete stripped.assessment;
  assert.equal(missing(stripped), "assessment", "a verdict with no assessment was accepted as attributed");
  const wrongBasis = JSON.parse(JSON.stringify(capabilityColumns(base({ outcome_contract: CONTRACT })).find((c: any) => c.column === "outcome")!));
  wrongBasis.assessment.basis = "self_report";
  assert.equal(missing(wrongBasis), "basis", "a verdict whose basis contradicts its `assessed_by` was accepted");
});

test("[D-18] the panel prints a self-report DIFFERENTLY from the registry's own observation", async () => {
  const fleetDashboard = await import("../src/fleet-dashboard.ts");
  const dashboard = await import("../src/dashboard.ts");
  const stateCell = fleetDashboard.stateCell as (c: any) => unknown;

  const base = {
    column: "outcome" as const,
    runtime: "codex" as const,
    reason: "contract_satisfied",
    is: "observation" as const,
    explicit: true,
    reliability: "reliable" as const,
    observability: "contract_only",
    state: "outcome" as const,
    source: "transcript" as const,
    window: "all_time" as const,
    window_detail: "the probe's own records, all time",
  };
  const selfReported = stateCell({
    ...base,
    value: "unknown",
    reason: "self_reported_not_verified_by_the_registry",
    assessment: { assessed_by: "principal", principal_type: "agent", basis: "self_report", claim: "yes" },
  });
  const observed = stateCell({
    ...base,
    value: "yes",
    reason: null,
    source: "filesystem" as const,
    assessment: { assessed_by: "registry", principal_type: null, basis: "registry_observation", claim: null },
  });

  const a = dashboard.cellTextOf(selfReported, "probe/self_report");
  const b = dashboard.cellTextOf(observed, "probe/registry");
  console.log(`  self-report cell : ${a}`);
  console.log(`  observation cell : ${b}`);
  assert.ok(dashboard.isMintedCell(selfReported), "a cell that no constructor made [B-2]");
  assert.ok(dashboard.isMintedCell(observed), "a cell that no constructor made [B-2]");
  assert.notEqual(a, b, "the two read identically: a reader cannot tell a claim from an observation");
  assert.match(a, /self_report/, "the self-report cell does not say it is one");
  assert.match(a, /principal/, "the self-report cell does not name who claimed it");
  assert.match(b, /registry_observation/, "the registry's own observation is not named as one");
});

test("[D-18] the §4 `outcome` column, end to end, publishes the provenance of its verdict", () => {
  const fx = p4Fixture();
  const version = reviewedVersion(fx, "d18-probe", { manifest: { outcome_contract: REMOTE_CONTRACT } });
  const marker = arrivalMarker(version.versionId);
  // `assign` stays with the owner, which drives the transfer below;
  // `report_outcome` goes to the REPORTER, because a credential that commands
  // desired state may neither hold it nor use it (`INV-02`, `P3-R2-001`).
  for (const [agent, action] of [
    [fx.reporter.agent_id, "report_outcome"],
    [fx.owner.agent_id, "assign"],
  ] as const) {
    assert.equal(
      rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
        agent_id: agent,
        action,
        recipient_scope: "local_agent",
      }).status,
      201,
    );
  }
  // THE VERSION HAS TO BE THIS AGENT'S CAPABILITY, or there is no row to carry a
  // column and the probe would pass on an empty table.
  const addressee = fx.reviewer.agent_id;
  const pushed = rest(fx, "POST", `/v1/versions/${version.versionId}/transfers`, fx.keys.owner, {
    recipient: { kind: "local_agent", ref: addressee },
  });
  assert.equal(pushed.status, 201, pushed.raw.slice(0, 200));

  // FILED BY THE OWNER, ABOUT THE ADDRESSEE. The principal whose type the
  // verdict must carry is the one that REPORTED, not the one that ran.
  const filed = rest(fx, "POST", "/v1/observations", fx.keys.reporter, {
    agent_id: addressee,
    runtime: "codex",
    window: "all_time",
    records: [
      { role: "call", call_id: "d18-1", marker, at_ms: 1 },
      { role: "output", call_id: "d18-1", marker, at_ms: 2, result: "success", evidence: { command: evidenceDigestOf("false"), exit_code: 0 } },
    ],
  });
  assert.equal(filed.status, 201, `the probe could not file its observation: ${filed.raw.slice(0, 200)}`);

  const view = rest(fx, "GET", `/v1/fleet/${addressee}/capabilities`, fx.keys.owner);
  assert.equal(view.status, 200, view.raw.slice(0, 200));
  const columns = (view.body.capabilities as any[]).flatMap((c) => c.columns as any[]).filter((c) => c.column === "outcome");
  assert.ok(columns.length > 0, "no `outcome` column was published for this agent");
  const outcome = columns[0];
  console.log(`  /v1/fleet/…/capabilities outcome → ${outcome.value} (${outcome.reason})`);
  console.log(`      assessment: ${JSON.stringify(outcome.assessment)}`);
  assert.ok(outcome.assessment, "the shipped `outcome` column carries no provenance for its verdict [I-3]");
  assert.equal(outcome.assessment.basis, "self_report", "a claim about a process on another machine was published as an observation");
  // `agent`, not `human`: the report is filed by the reporter principal, because
  // an owner or admin credential may not write observed state at all
  // (`INV-02`, `P3-R2-001`). What [I-5] asks of this column is that the TYPE of
  // whoever claimed the result travels with the claim, and it still does.
  assert.equal(outcome.assessment.principal_type, "agent", "the verdict does not carry the reporting principal's type [I-5]");
  assert.notEqual(outcome.value, "yes", "the registry published a `yes` for a process it never ran");
  fx.db.close();
});
