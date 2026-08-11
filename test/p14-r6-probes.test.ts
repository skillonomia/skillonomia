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
import { OUTCOME_CHECK_KINDS, OUTCOME_CHECK_SHAPE, evaluateOutcome } from "../src/outcome.ts";
import { arrivalMarker } from "../src/marker.ts";
import { p4Fixture, reviewedVersion, rest, type P4Fixture } from "./p6-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

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
const DECLARED_CONTRACT = {
  check: { kind: "stdout_match", stdout_match: "ALL GREEN" },
  evidence: ["stdout", "suite_name"],
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
      agent_id: fx.owner.agent_id,
      action: "report_outcome",
      recipient_scope: "local_agent",
    }).status,
    201,
    "the probe could not grant itself `report_outcome`",
  );
  const report = (records: unknown[]) =>
    rest(fx, "POST", "/v1/observations", fx.keys.owner, {
      agent_id: fx.owner.agent_id,
      runtime: "codex",
      window: "all_time",
      window_detail: "the probe's own records, all time",
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
      evidence: { stdout: "ALL GREEN", [SECRET_NAME]: SECRET_VALUE, [TRANSCRIPT_NAME]: TRANSCRIPT_VALUE },
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

test("[I-7] the names the SIGNED contract declares are admitted, and are stored", () => {
  const { fx, marker, report } = i7Fixture();
  const accepted = report([
    { role: "call", call_id: "i7-2", marker, at_ms: 3 },
    {
      role: "output",
      call_id: "i7-2",
      marker,
      at_ms: 4,
      result: "success",
      evidence: { stdout: "the suite says ALL GREEN", suite_name: "unit" },
    },
  ]);
  console.log(`  the contract's own \`suite_name\` → ${accepted.status} ${accepted.raw.slice(0, 100)}`);
  assert.equal(accepted.status, 201, "a name the signed contract declares was refused, so the refusal above is vacuous");
  const kept = storedEvidence(fx);
  assert.ok(kept.includes("suite_name"), "an admitted named value was not stored");
  assert.ok(kept.includes("ALL GREEN"), "an admitted value was not stored");
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
    { role: "output", call_id: "i7-3", marker: stranger, at_ms: 6, result: "success", evidence: { exit_code: 0, stdout: "x", artifacts: ["a"], command: "true" } },
  ]);
  console.log(`  base names under an unknown marker → ${base.status}`);
  assert.equal(base.status, 201, "the four base names must always be admissible");

  // …and a name that ANOTHER version's contract declares is NOT admissible
  // here, because no contract can be read for this marker.
  const borrowed = report([
    { role: "call", call_id: "i7-4", marker: stranger, at_ms: 7 },
    { role: "output", call_id: "i7-4", marker: stranger, at_ms: 8, result: "success", evidence: { stdout: "ALL GREEN", suite_name: "unit" } },
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
  const full: Record<string, unknown> = { exit_code: 0, stdout: "ALL GREEN", artifacts: ["out/report.json"], command: "true" };
  for (const kind of OUTCOME_CHECK_KINDS) {
    const shape = OUTCOME_CHECK_SHAPE[kind]!;
    const contract = {
      check: {
        kind,
        exit_code: 0,
        stdout_match: "ALL GREEN",
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

/** `npm pack --dry-run --json` in `cwd`, tolerating whatever a lifecycle script
 *  printed before the JSON — which is the whole reason the flag was there. */
function realPack(cwd: string, ignoreScripts: boolean): string[] {
  const args = ["pack", "--dry-run", "--json", "--silent", ...(ignoreScripts ? ["--ignore-scripts"] : [])];
  const out = execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
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
    /--ignore-scripts/.test(guardSource),
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
  assert.ok(existsSync(join(packRoot, "dist-js", "cli.js")), "`prepack` did not build in the tree the guard packs in");

  const tree = freshTree();
  assert.equal(existsSync(join(tree, "dist-js", "cli.js")), false, "the probe's tree is not fresh: it already holds a build");

  const shipped = realPack(tree, false);
  const withoutScripts = realPack(freshTree(), true);
  console.log(`  a real pack on a fresh tree:            ${shipped.length} files`);
  console.log(`  the same tree with --ignore-scripts:    ${withoutScripts.length} files`);
  console.log(`  the guard's own enumeration:            ${g.packedFiles().length} files`);

  // THE DISCRIMINATION, STATED AS A FACT ABOUT THE TWO ENUMERATIONS: the flag
  // the guard passes is exactly the difference between them.
  assert.ok(shipped.includes("dist-js/cli.js"), "a real pack does not ship `prepack`'s product: the premise is wrong");
  assert.equal(withoutScripts.includes("dist-js/cli.js"), false, "`--ignore-scripts` shipped a build anyway");
  assert.equal(shipped.length, withoutScripts.length + 1, "the two enumerations differ by something other than the built file");

  // …AND THE GUARD MUST BE ON THE FIRST SIDE OF THAT DIFFERENCE.
  assert.deepEqual(g.packedFiles(), shipped, "the guard enumerates a different package from the one npm ships");

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
    claimed: { command: "false", exit_code: 0 },
    observed: null,
    principal: { type: "agent" },
  });
  console.log(`  {"command":"false","exit_code":0} claimed by an agent → ${got.value} (${got.reason})`);
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
  const observe = required<(site: unknown, contract: unknown) => Record<string, unknown> | null>(
    outcomeNamespace as unknown as Record<string, unknown>,
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

  // NOTHING IS THERE — and the registry LOOKED, so this is a `no` and not an
  // `unknown`: the difference between a walk that found nothing and no walk.
  const absent = assess({ contract, claimed: null, observed: observe(site, contract), principal: { type: "agent" } });
  console.log(`  the artifact absent under the registry's root → ${absent.value} (${absent.reason}) by ${absent.assessed_by}/${absent.basis}`);
  assert.equal(absent.value, "no", "the registry read its own root and would not say what it found");
  assert.equal(absent.assessed_by, "registry");
  assert.equal(absent.basis, "registry_observation");

  // …and now it IS there.
  mkdirSync(join(root, ".agents", "skills", "probe"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "probe", "SKILL.md"), "# probe\n");
  const present = assess({ contract, claimed: null, observed: observe(site, contract), principal: { type: "agent" } });
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
  assert.equal(observe(site, outside), null, "the registry observed a path outside the root it manages");
  assert.equal(observe(null, contract), null, "the registry observed something with no root configured at all");
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
  assert.equal(
    rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
      agent_id: fx.owner.agent_id,
      action: "report_outcome",
      recipient_scope: "local_agent",
    }).status,
    201,
  );
  const filed = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: fx.owner.agent_id,
    runtime: "codex",
    window: "all_time",
    window_detail: "the probe's own records, all time",
    records: [
      { role: "call", call_id: "d18-1", marker, at_ms: 1 },
      { role: "output", call_id: "d18-1", marker, at_ms: 2, result: "success", evidence: { command: "false", exit_code: 0 } },
    ],
  });
  assert.equal(filed.status, 201, `the probe could not file its observation: ${filed.raw.slice(0, 200)}`);

  const view = rest(fx, "GET", `/v1/fleet/${fx.owner.agent_id}/capabilities`, fx.keys.owner);
  assert.equal(view.status, 200, view.raw.slice(0, 200));
  const columns = (view.body.capabilities as any[]).flatMap((c) => c.columns as any[]).filter((c) => c.column === "outcome");
  assert.ok(columns.length > 0, "no `outcome` column was published for this agent");
  const outcome = columns[0];
  console.log(`  /v1/fleet/…/capabilities outcome → ${outcome.value} (${outcome.reason})`);
  console.log(`      assessment: ${JSON.stringify(outcome.assessment)}`);
  assert.ok(outcome.assessment, "the shipped `outcome` column carries no provenance for its verdict [I-3]");
  assert.equal(outcome.assessment.basis, "self_report", "a claim about a process on another machine was published as an observation");
  assert.equal(outcome.assessment.principal_type, "human", "the verdict does not carry the reporting principal's type [I-5]");
  assert.notEqual(outcome.value, "yes", "the registry published a `yes` for a process it never ran");
  fx.db.close();
});
