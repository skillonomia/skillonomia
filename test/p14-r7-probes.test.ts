// ROUND 7 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks come from the
// STATEMENT OF THE REQUIREMENT, are committed first, and must FAIL on the code
// as it stands. A probe written after the fix cannot discriminate — it was
// shaped by the answer. Its failure at the red commit is the proof, and that
// failure is recorded in the red commit's own message.
//
// THE DECISION THIS ROUND IS BUILT ON — `outcome` IS NARROWED.
//
//   The owner narrowed what §4's `outcome` column may assert:
//
//     a `yes` on this registry's own authority is available for ONE thing and
//     one thing only — an artifact THIS REGISTRY'S OWN ACTIVATION JOURNAL says
//     THIS REGISTRY PUT THERE. There is no other real `yes` in V-1.
//
//   Everything else is `unknown` with a reason, the principal's `claim` beside
//   it, `assessed_by: principal` and `basis: self_report`.
//
//   That is a CLASS FIX and not a patch, and the probes below are written to
//   show it as one: two of the defects the last review found are not repaired
//   here, they become UNSAYABLE, and the probes that would have caught them now
//   have nothing left to catch because the shape that produced them is gone.
//
// THE FOUR REQUIREMENTS, AS ATTACKS:
//
//   2.1 PROVENANCE COMES FROM THE SOURCE OF THE DATA, NEVER FROM THE BRANCH
//       THAT RAN. `assessOutcome` evaluated a PRINCIPAL's evidence and, when
//       that evaluation said `unknown`, wrapped the answer with `registry(...)`
//       — so a verdict reached by reading an agent's own report went out with
//       `assessed_by: registry`, `basis: registry_observation`. The origin was
//       inferred from which branch executed. It must be MARKED ON THE DATA at
//       intake, before any evaluation, and travel with it to publication; and
//       the pairing of principal data with a registry attribution must become
//       inexpressible, the way `as Cell` became inexpressible in round 5 — by
//       construction, not by a check.
//
//   2.2 "THE REGISTRY OBSERVED IT" IS TIED TO THE ACTIVATION JOURNAL.
//       `registryObservedEvidence` did a LEXICAL containment test on a path and
//       then called `existsSync`, which FOLLOWS SYMBOLIC LINKS. A link inside
//       the root pointing out of it passed. And ANY file anybody dropped under
//       the root produced a `yes`, because nothing connected the artifact to a
//       materialization this registry performed. `realpath` and a second
//       containment test are half the fix; the other half — the load-bearing
//       half — is the binding to the journal.
//
//   2.3 THE CHANNEL OF VALUES CLOSES THE WAY THE CHANNEL OF NAMES DID. Round 6
//       closed the NAMES. A reviewer then stored `sk-live-…` verbatim under the
//       contract's own `stdout`, and a whole transcript goes the same way. A
//       value must be a bounded type or a digest of fixed form; arbitrary text
//       under ANY name, contract-declared ones included, is refused.
//
//   B-4-2 THE CLOSED LIST OF PRESENT-TIME ADVERBS GOES: a sentence with no
//       adverb ("The dashboard has five views.") was exempt for want of a word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import * as outcomeNamespace from "../src/outcome.ts";
import * as activationNamespace from "../src/activation.ts";
import { OUTCOME_CHECK_KINDS, OUTCOME_CHECK_SHAPE, evaluateOutcome } from "../src/outcome.ts";
import { arrivalMarker } from "../src/marker.ts";
import { p4Fixture, reviewedVersion, rest, type P4Fixture } from "./p6-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = new URL("../src/", import.meta.url);

/** Name a thing that does not exist yet WITHOUT taking the file down with a
 *  module error: a missing export must read as one sentence, not twenty. */
function required<T>(mod: Record<string, unknown>, name: string, what: string): T {
  const v = mod[name];
  assert.ok(v !== undefined, `MISSING: \`${name}\` — ${what}`);
  return v as T;
}

const outcome = outcomeNamespace as unknown as Record<string, unknown>;
const activation = activationNamespace as unknown as Record<string, unknown>;

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

interface Assessment {
  value: string;
  reason: string;
  assessed_by: string;
  principal_type: string | null;
  basis: string;
  claim: string | null;
}

/** The two minters and the reader of the mark. Named separately so a build that
 *  has one and not the others fails with the sentence that says which. */
function selfReported(): (v: Record<string, unknown> | null) => unknown {
  return required(
    outcome,
    "selfReported",
    "2.1 requires a principal's values to be MARKED AT INTAKE, before any evaluation: an origin inferred from which branch " +
      "of the assessor ran is not the origin of the data",
  );
}
function registryObserved(): (v: Record<string, unknown>) => unknown {
  return required(
    outcome,
    "registryObserved",
    "2.1 requires the registry's own reading to be marked as the registry's, by the ONE constructor permitted to make such a mark",
  );
}
function originOf(): (v: unknown) => string {
  return required(
    outcome,
    "originOf",
    "2.1 requires the mark to be READABLE BY IDENTITY — the B-2 mechanism — so a cast, a literal or a JSON round-trip cannot wear it",
  );
}
function assessor(): (input: unknown) => Assessment {
  return required(outcome, "assessOutcome", "§4's verdict is published by `assessOutcome`");
}

// ===========================================================================
// 1. THE NARROWING — WHAT MAY STILL PRODUCE A `yes`
// ===========================================================================

const ARTIFACT = ".agents/skills/probe/SKILL.md";

function artifactContract(path: string = ARTIFACT) {
  return {
    check: { kind: "artifact_exists", artifact_path: path },
    evidence: ["artifacts"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
}

/** The journal record 2.2 requires: THIS registry says it placed THIS relative
 *  path under THIS target, and the copy it placed is still the one it wrote. */
function placement(over: Record<string, unknown> = {}) {
  return { target: "codex", native_relpath: ARTIFACT, managed_copy: "written", ...over };
}

function observe(): (site: unknown, contract: unknown, placed: unknown) => unknown {
  return required(
    activation,
    "registryObservedEvidence",
    "2.2 requires the registry's own observation to exist and to take the ACTIVATION JOURNAL's record of the placement",
  );
}

/** A root with the artifact really in it, placed as `materialize` places one. */
function rootWithArtifact(): string {
  const root = temp("skln-r7-root-");
  mkdirSync(join(root, dirname(ARTIFACT)), { recursive: true });
  writeFileSync(join(root, ARTIFACT), "# probe\n");
  return root;
}

test("[NARROWING] the ONLY `yes` left is an artifact the registry's OWN JOURNAL says it placed", () => {
  const assess = assessor();
  const look = observe();
  const root = rootWithArtifact();
  const site = { root, target: "codex" };
  const contract = artifactContract();

  // THE POSITIVE HALF FIRST, because a rule satisfied by a column that is
  // always silent is not a rule. The registry put the file there, its journal
  // says so, and the file is there: this is the one real `yes` V-1 has.
  const yes = assess({ contract, claimed: null, observed: look(site, contract, placement()), principal: { type: "agent" } });
  console.log(`  journalled + present → ${yes.value} (${yes.reason}) by ${yes.assessed_by}/${yes.basis}`);
  assert.equal(yes.value, "yes", "the registry read a file its own journal says it wrote and would not answer for it");
  assert.equal(yes.assessed_by, "registry");
  assert.equal(yes.basis, "registry_observation");

  // …AND EVERY WAY OF REMOVING ONE OF THE THREE CONDITIONS REMOVES THE `yes`.
  // Each row drops exactly one: the root, the journal record, or the identity
  // of the path with the one the journal names.
  const withoutOne: Array<[string, unknown]> = [
    ["no activation root configured at all", look(null, contract, placement())],
    ["no journal record of any placement", look(site, contract, null)],
    ["a journal that placed a DIFFERENT path", look(site, contract, placement({ native_relpath: ".agents/skills/other/SKILL.md" }))],
    ["a journal whose copy was REMOVED", look(site, contract, placement({ managed_copy: "removed" }))],
    ["a journal that never wrote, only retained", look(site, contract, placement({ managed_copy: "retained" }))],
    ["a journal placed under ANOTHER target", look(site, contract, placement({ target: "claude_code_project" }))],
  ];
  const escaped: string[] = [];
  for (const [label, observed] of withoutOne) {
    const got = assess({ contract, claimed: null, observed, principal: { type: "agent" } });
    console.log(`  ${label.padEnd(46)} → ${got.value} (${got.reason}) by ${got.assessed_by}`);
    if (got.value === "yes") escaped.push(`${label} → yes`);
  }
  assert.deepEqual(escaped, [], "a `yes` survived the removal of one of the three things the narrowing requires");
});

test("[NARROWING] no check kind OTHER THAN `artifact_exists` can reach a `yes` on the registry's authority", () => {
  const assess = assessor();
  const mint = registryObserved();
  const escaped: string[] = [];
  // THE SET OF KINDS IS THE CODE'S, not a list written here. A kind added
  // tomorrow is swept without an edit to this file.
  for (const kind of OUTCOME_CHECK_KINDS) {
    if (kind === "artifact_exists") continue;
    const shape = OUTCOME_CHECK_SHAPE[kind]!;
    const parameter: unknown = shape.parameter === "exit_code" ? 0 : `skln-probe-${kind}`;
    const contract = {
      check: { kind, [shape.parameter]: parameter },
      evidence: [...shape.reads],
      unknown: "no evaluated run of this skill was reported, which is not a failure of it",
    };
    // Even values MINTED AS THE REGISTRY'S own must not produce a `yes` for a
    // kind whose subject is a process on somebody else's machine: the registry
    // has no way to have observed an exit code, and the narrowing says so.
    const forged: Record<string, unknown> = {};
    for (const name of shape.reads) forged[name] = name === "exit_code" ? 0 : parameter;
    const got = assess({ contract, claimed: null, observed: mint(forged), principal: { type: "agent" } });
    console.log(`  ${kind.padEnd(16)} minted as the registry's own → ${got.value} (${got.reason})`);
    if (got.value === "yes") escaped.push(`${kind} reached a registry \`yes\``);
  }
  assert.deepEqual(
    escaped,
    [],
    "a check about a process on the addressee's machine produced a `yes` on this registry's authority: the narrowing is not built",
  );
});

// ===========================================================================
// 2.1 — THE MARK IS ON THE DATA, AND `registry(claimed)` IS INEXPRESSIBLE
// ===========================================================================

test("[2.1] crooked values a PRINCIPAL presented are a self-report, never the registry's own answer", () => {
  const assess = assessor();
  const mark = selfReported();
  // THE TWO SHAPES THE REQUIREMENT NAMES. `exit_code: "zero"` is not an integer,
  // so the check cannot read it and the old code answered `unknown` — and
  // attributed that `unknown` TO THE REGISTRY, because the branch that produced
  // it was the branch wrapped in `registry(...)`. `{"command":"false",
  // "exit_code":0}` is a lie the registry cannot detect and must not certify.
  const cases: Array<[string, unknown, Record<string, unknown>]> = [
    [
      `exit_code: "zero"`,
      { check: { kind: "exit_code", exit_code: 0 }, evidence: ["exit_code"], unknown: "nothing was evaluated, which is not a failure of it" },
      { exit_code: "zero" },
    ],
    [
      `command "false" exiting 0`,
      { check: { kind: "command", command: "false" }, evidence: ["command", "exit_code"], unknown: "nothing was evaluated, which is not a failure of it" },
      { command: "false", exit_code: 0 },
    ],
  ];
  for (const [label, contract, values] of cases) {
    const got = assess({ contract, claimed: mark(values), observed: null, principal: { type: "agent" } });
    console.log(`  ${label.padEnd(28)} → ${got.value} (${got.reason})  assessed_by=${got.assessed_by} basis=${got.basis} claim=${got.claim}`);
    assert.equal(got.value, "unknown", "a principal's values produced a verdict");
    assert.equal(got.assessed_by, "principal", "a verdict reached by reading a PRINCIPAL's values was attributed to the registry");
    assert.equal(got.basis, "self_report", "a self-report was published as an observation");
    assert.equal(got.principal_type, "agent", "the verdict does not carry the reporting principal's type [I-5]");
  }
});

/**
 * EVERY REASON THIS MODULE CAN EMIT — read out of its own source, not listed.
 *
 * The universal in 2.1 is "NO path that handled a principal's data publishes
 * `assessed_by: registry`", and a sweep proves a universal only if its subject
 * is the whole set. The set of PATHS through the assessor is not enumerable
 * from outside, but the set of ANSWERS it can produce is: every distinct
 * `reason` the module writes. So the reasons are scraped from `src/outcome.ts`,
 * the sweep must EXCITE every one of them that a contract can reach, and none
 * of them may come out attributed to the registry.
 *
 * A reason added later that the sweep cannot reach fails this probe rather than
 * silently widening what a principal's data can be published as.
 */
function reasonsInSource(): string[] {
  const src = readFileSync(new URL("outcome.ts", SRC_DIR), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/reason:\s*"([a-z0-9_:]+)"/g)) out.add(m[1]!);
  // a templated reason contributes its stable PREFIX; the sweep matches on it
  for (const m of src.matchAll(/reason:\s*`([a-z0-9_]+:)\$\{/g)) out.add(m[1]!);
  return [...out].sort();
}

test("[2.1] NOT ONE reason this module can emit reaches a reader as the registry's, when the data was a principal's", () => {
  const assess = assessor();
  const mark = selfReported();
  const reasons = reasonsInSource();
  assert.ok(reasons.length >= 6, `the reason set was scraped as ${reasons.length} entries: the scrape is broken, not the code`);
  console.log(`[2.1] reasons declared in src/outcome.ts: ${reasons.join(", ")}`);

  // THE SEARCH SPACE, built from the code and not from knowledge of any kind:
  // every declared kind, crossed with values that are right, wrong, of the
  // wrong type, missing, and not an object at all.
  const seen = new Set<string>();
  const escaped: string[] = [];
  let swept = 0;
  for (const kind of OUTCOME_CHECK_KINDS) {
    const shape = OUTCOME_CHECK_SHAPE[kind]!;
    const parameter: unknown = shape.parameter === "exit_code" ? 0 : `skln-probe-${kind}`;
    const contracts: unknown[] = [
      { check: { kind, [shape.parameter]: parameter }, evidence: [...shape.reads], unknown: "nothing was evaluated, which is not a failure of it" },
      { check: { kind, [shape.parameter]: parameter }, evidence: [...shape.reads, "a_name_no_run_presented"], unknown: "nothing was evaluated, which is not a failure of it" },
      { check: { kind: "no_such_kind" }, evidence: ["exit_code"], unknown: "nothing was evaluated, which is not a failure of it" },
    ];
    const candidates: unknown[] = [parameter, [parameter], 0, 1, "skln-probe-matches-nothing", [], "zero", true];
    const bodies: Array<Record<string, unknown> | null> = [null, {}];
    for (const v of candidates) {
      const body: Record<string, unknown> = {};
      for (const name of shape.reads) body[name] = name === "exit_code" && typeof v !== "number" ? v : v;
      bodies.push(body);
      const partial: Record<string, unknown> = { ...body };
      delete partial[shape.evidence];
      bodies.push(partial);
    }
    for (const contract of contracts) {
      for (const body of bodies) {
        const got = assess({ contract, claimed: body === null ? null : mark(body), observed: null, principal: { type: "service" } });
        swept += 1;
        seen.add(got.reason);
        // THE UNIVERSAL. Where the data came from a principal, the answer may
        // not stand on the registry's authority — whatever the reason says.
        if (body !== null && got.assessed_by === "registry") {
          escaped.push(`${kind} · ${JSON.stringify(body).slice(0, 60)} → assessed_by=registry (${got.reason})`);
        }
        if (body !== null && got.value === "yes") escaped.push(`${kind} · a principal's values produced \`yes\``);
      }
    }
  }
  console.log(`[2.1] combinations swept: ${swept}; distinct reasons produced: ${[...seen].sort().join(", ")}`);
  assert.deepEqual(escaped.slice(0, 20), [], "a path that handled a principal's data published the registry's authority");

  // …AND THE SWEEP MUST HAVE REACHED THE WHOLE SET, or it proves nothing about
  // the reasons it never produced. `no_outcome_contract` is the one answer that
  // is structurally out of reach here — it is what the module says when there is
  // NO CONTRACT, and with no contract there is nothing a principal's evidence
  // could have been evaluated against. It is excited separately, below.
  const unreached = reasons.filter((r) => r !== "no_outcome_contract" && ![...seen].some((s) => s === r || s.startsWith(r)));
  assert.deepEqual(unreached, [], "reasons this module can emit that the sweep never produced: the universal covers less than it claims");

  const noContract = assess({ contract: null, claimed: null, observed: null, principal: null });
  console.log(`[2.1] no contract at all → ${noContract.value} (${noContract.reason}) by ${noContract.assessed_by}`);
  assert.equal(noContract.reason, "no_outcome_contract", "the one reason held out of the sweep is not reachable at all");
});

test("[2.1] `registry(claimed)` is INEXPRESSIBLE — the attribution has one source and it is the mark on the data", () => {
  const src = readFileSync(new URL("outcome.ts", SRC_DIR), "utf8");

  // (a) THE ATTRIBUTION IS NOT A PARAMETER ANYWHERE. Round 6's defect was one
  //     helper, `registry(v)`, that any branch could wrap any verdict in. A
  //     helper like that is the whole mechanism of the defect: it makes "this
  //     is the registry's answer" a thing a caller ASSERTS rather than a thing
  //     the data CARRIES.
  assert.equal(
    /\bconst\s+registry\s*=\s*\(/.test(src),
    false,
    "`src/outcome.ts` still holds a helper that stamps the registry's authority onto a verdict handed to it",
  );

  // (b) EVERY `assessed_by` IN THE MODULE IS INSIDE THE ONE CONSTRUCTOR, and
  //     that constructor derives it from the mark. Two occurrences — one per
  //     origin — and no third.
  const stamps = [...src.matchAll(/assessed_by:\s*"(registry|principal)"/g)].map((m) => m[1]!);
  console.log(`  \`assessed_by: "…"\` literals in src/outcome.ts: ${stamps.join(", ") || "(none)"}`);
  assert.deepEqual(
    stamps.sort(),
    ["principal", "registry"],
    "the attribution is written in more than one place, so a second branch can choose it",
  );
  assert.match(src, /originOf\(/, "nothing in the module reads the mark: the attribution cannot be coming from the data");

  // (c) THE REGISTRY'S MARK HAS EXACTLY ONE CALLER IN THE WHOLE OF `src/`, and
  //     the set of files is READ OFF THE DIRECTORY — not a list kept here, so a
  //     module added tomorrow is swept.
  const files = readdirSync(new URL(SRC_DIR), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name)
    .sort();
  assert.ok(files.length > 20, `only ${files.length} source files were discovered: the sweep is broken, not the code`);
  const callers = files.filter((f) => /(?<![A-Za-z])registryObserved\s*\(/.test(readFileSync(new URL(f, SRC_DIR), "utf8")));
  console.log(`  files of src/ swept: ${files.length}; callers of \`registryObserved(\`: ${callers.join(", ") || "(none)"}`);
  assert.deepEqual(
    callers,
    ["activation.ts"],
    "the constructor that mints the registry's own authority is reachable from more than the one place entitled to it",
  );
});

test("[2.1] the mark is by IDENTITY: a cast, a literal, a clone and a JSON round-trip all fail to wear it", () => {
  const assess = assessor();
  const mark = selfReported();
  const read = originOf();
  const values = { exit_code: 0 };
  const marked = mark(values) as Record<string, unknown>;
  assert.equal(read(marked), "principal", "the mark a constructor set is not readable off the object it set it on");

  const forgeries: Array<[string, unknown]> = [
    ["a plain object literal", { exit_code: 0 }],
    ["the very values that were marked", values],
    ["a JSON round-trip of a marked object", JSON.parse(JSON.stringify(marked))],
    ["a structuredClone of a marked object", structuredClone(marked)],
    ["a spread copy of a marked object", { ...marked }],
  ];
  const admitted: string[] = [];
  for (const [label, forged] of forgeries) {
    let answered: string | null = null;
    try {
      answered = read(forged);
    } catch {
      answered = null;
    }
    console.log(`  ${label.padEnd(40)} → ${answered ?? "REFUSED"}`);
    if (answered !== null) admitted.push(`${label} answered \`${answered}\``);
  }
  assert.deepEqual(admitted, [], "an object no constructor marked was given an origin: the mark is read off the value, not its identity");

  // …and the assessor refuses one too, rather than treating it as anybody's.
  assert.throws(
    () => assess({ contract: artifactContract(), claimed: null, observed: { artifacts: [ARTIFACT] }, principal: { type: "agent" } }),
    /.*/,
    "unmarked values were accepted as the registry's own observation",
  );
});

// ===========================================================================
// 2.2 — THE OBSERVATION IS TIED TO THE JOURNAL, AND THE PATH IS RESOLVED
// ===========================================================================

test("[2.2] a symbolic link inside the root that leads OUT of it never yields `yes`", () => {
  const assess = assessor();
  const look = observe();
  const root = temp("skln-r7-symroot-");
  const outside = temp("skln-r7-outside-");

  // The artifact the contract names is REACHABLE — `existsSync` says yes — but
  // the bytes are not under the root: `.agents/skills/probe` is a link out.
  mkdirSync(join(outside, "probe"), { recursive: true });
  writeFileSync(join(outside, "probe", "SKILL.md"), "# planted outside the root\n");
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  symlinkSync(join(outside, "probe"), join(root, ".agents", "skills", "probe"));

  const site = { root, target: "codex" };
  const contract = artifactContract();
  // the journal even AGREES that this path was written — the link is the attack,
  // not a missing record, so this probe cannot pass merely because 2.2's other
  // half refused it
  const got = assess({ contract, claimed: null, observed: look(site, contract, placement()), principal: { type: "agent" } });
  console.log(`  a link inside the root leading out → ${got.value} (${got.reason}) by ${got.assessed_by}/${got.basis}`);
  assert.notEqual(got.value, "yes", "a file OUTSIDE the activation root was published as the registry's own `yes`");
});

test("[2.2] a file ANYBODY dropped under the root, with no journal record, never yields `yes`", () => {
  const assess = assessor();
  const look = observe();
  const root = rootWithArtifact(); // the bytes are really there, under the root
  const site = { root, target: "codex" };
  const contract = artifactContract();

  const got = assess({ contract, claimed: null, observed: look(site, contract, null), principal: { type: "agent" } });
  console.log(`  planted under the root, no journal record → ${got.value} (${got.reason}) by ${got.assessed_by}/${got.basis}`);
  assert.notEqual(got.value, "yes", "a file this registry never placed was published as its own `yes`");

  // …and the same root WITH the journal record does answer `yes`, or the line
  // above is satisfied by a column that is silent whatever happens.
  const withJournal = assess({ contract, claimed: null, observed: look(site, contract, placement()), principal: { type: "agent" } });
  console.log(`  the same bytes, with the journal record   → ${withJournal.value} by ${withJournal.assessed_by}/${withJournal.basis}`);
  assert.equal(withJournal.value, "yes", "the positive half is missing: this rule is satisfied by a column that never speaks");
});

test("[2.2] the registry's `no` is still available — it looked, at a path it placed, and the copy is gone", () => {
  const assess = assessor();
  const look = observe();
  const root = temp("skln-r7-gone-");
  mkdirSync(join(root, dirname(ARTIFACT)), { recursive: true });
  const site = { root, target: "codex" };
  const contract = artifactContract();
  const got = assess({ contract, claimed: null, observed: look(site, contract, placement()), principal: { type: "agent" } });
  console.log(`  journalled but absent → ${got.value} (${got.reason}) by ${got.assessed_by}/${got.basis}`);
  assert.equal(got.value, "no", "a copy this registry placed and can no longer find is not an honest `no`");
  assert.equal(got.basis, "registry_observation");
});

// ===========================================================================
// 2.3 — THE CHANNEL OF VALUES
// ===========================================================================

/** A secret-SHAPED marker and a whole transcript. Neither is a real credential;
 *  both are the shapes a reviewer actually got through the shipped surface. */
const SECRET_VALUE = "sk-live-skln-probe-not-a-real-credential-9f2c4d";
const TRANSCRIPT_VALUE =
  "the assistant said: here is the whole conversation, every turn of it, and the operator replied with the rest of it";

const DECLARED_CONTRACT = {
  check: { kind: "exit_code", exit_code: 0 },
  evidence: ["exit_code", "suite_digest"],
  unknown: "no evaluated run of this skill was reported, which is not a failure of it",
};

interface Fixture {
  fx: P4Fixture;
  marker: string;
  report: (records: unknown[]) => { status: number; raw: string; body: any };
}

function fixture(): Fixture {
  const fx = p4Fixture();
  const version = reviewedVersion(fx, "r7-probe", { manifest: { outcome_contract: DECLARED_CONTRACT } });
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

/** Every byte this database holds in the columns a report can reach. */
function stored(fx: P4Fixture): string {
  const rows = fx.db.prepare("SELECT marker, result, evidence FROM observed_records").all() as Array<{
    marker: string;
    result: string;
    evidence: string | null;
  }>;
  return rows.map((r) => `${r.marker}|${r.result}|${r.evidence ?? ""}`).join("\n");
}

const DIGEST = "sha256:9f2c4d0e1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

test("[2.3] a secret-shaped value and a whole transcript under a CONTRACT-DECLARED name are refused, and nothing is written", () => {
  for (const [label, evidence] of [
    ["a secret-shaped value under `suite_digest`", { exit_code: 0, suite_digest: SECRET_VALUE }],
    ["a transcript under `suite_digest`", { exit_code: 0, suite_digest: TRANSCRIPT_VALUE }],
    ["a transcript under the base name `stdout`", { exit_code: 0, stdout: TRANSCRIPT_VALUE }],
    ["a transcript one element at a time", { exit_code: 0, suite_digest: TRANSCRIPT_VALUE.split(" ") }],
  ] as Array<[string, Record<string, unknown>]>) {
    const { fx, marker, report } = fixture();
    const planted = report([
      { role: "call", call_id: "r7-1", marker, at_ms: 1 },
      { role: "output", call_id: "r7-1", marker, at_ms: 2, result: "success", evidence },
    ]);
    console.log(`  ${label.padEnd(46)} → ${planted.status} ${planted.raw.slice(0, 90)}`);
    assert.notEqual(planted.status, 201, `${label} was accepted: a name is closed and the channel under it is not`);
    assert.match(planted.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal");

    // THE READ THAT MATTERS — the DATABASE, not the status code. A surface that
    // answers 400 and writes anyway is the defect wearing a refusal.
    const kept = stored(fx);
    for (const forbidden of [SECRET_VALUE, TRANSCRIPT_VALUE, "here is the whole conversation"]) {
      assert.equal(kept.includes(forbidden), false, `\`${forbidden.slice(0, 24)}…\` was written to observed_records`);
    }
    assert.equal(planted.raw.includes(SECRET_VALUE), false, "the refusal echoed the value it refused [I-7]");
    fx.db.close();
  }
});

test("[2.3] an integer, a boolean and a digest of fixed form are admitted, and are stored", () => {
  const { fx, marker, report } = fixture();
  const accepted = report([
    { role: "call", call_id: "r7-2", marker, at_ms: 3 },
    { role: "output", call_id: "r7-2", marker, at_ms: 4, result: "success", evidence: { exit_code: 0, suite_digest: DIGEST } },
  ]);
  console.log(`  integer + digest → ${accepted.status} ${accepted.raw.slice(0, 90)}`);
  assert.equal(accepted.status, 201, "a legitimate integer and a digest were refused, so the refusals above are vacuous");
  const kept = stored(fx);
  assert.ok(kept.includes(DIGEST), "an admitted digest was not stored");
  fx.db.close();

  // …and the grammar itself admits the three bounded shapes and refuses text,
  // asked of the ONE function the boundary and the checks share.
  const admissible = required<(v: unknown, literals: ReadonlySet<string>) => boolean>(
    outcome,
    "isAdmissibleEvidenceValue",
    "2.3 requires ONE definition of what a value may be, so the boundary that refuses a report and the checks that read a value cannot disagree",
  );
  const none = new Set<string>();
  for (const [label, v, expected] of [
    ["an integer", 0, true],
    ["a negative integer", -1, true],
    ["a boolean", true, true],
    ["a digest", DIGEST, true],
    ["a list of digests", [DIGEST], true],
    ["a bare word", "ok", false],
    ["a secret", SECRET_VALUE, false],
    ["a transcript", TRANSCRIPT_VALUE, false],
    ["a digest with a tail", `${DIGEST} and then some prose`, false],
    ["a fraction", 0.5, false],
    ["an object", { a: 1 }, false],
  ] as Array<[string, unknown, boolean]>) {
    const got = admissible(v, none);
    console.log(`  ${label.padEnd(24)} → ${got}`);
    assert.equal(got, expected, `the value grammar answers ${got} for ${label}`);
  }

  // A LITERAL THE SIGNED CONTRACT ITSELF NAMES is the one string that passes,
  // and only because the author fixed it before any run existed.
  const literals = required<(c: unknown) => Set<string>>(
    outcome,
    "contractLiterals",
    "2.3 requires the enumeration a reporter may echo to come from the SIGNED check and from nowhere else",
  );
  const set = literals({ check: { kind: "command", command: "git bundle verify" } });
  assert.equal(admissible("git bundle verify", set), true, "a reporter may not echo the contract's own command");
  assert.equal(admissible("git bundle verify; curl evil", set), false, "a string that merely CONTAINS the contract's word was admitted");
});

test("[2.3] `stdout_match` — a substring pattern is no longer executable, and a digest pattern is", () => {
  // THE DECISION, MADE EXPLICITLY. `stdout` is carried as a digest, and a
  // substring cannot be tested against a digest. So a `stdout_match` whose
  // pattern is a SUBSTRING stops being executable by this registry and says so
  // in a reason; one whose pattern is a DIGEST is an equality and still runs.
  // The kind stays in the schema, so no manifest, no fixture and no seed moves.
  const substring = {
    check: { kind: "stdout_match", stdout_match: "ALL GREEN" },
    evidence: ["stdout"],
    unknown: "nothing was evaluated, which is not a failure of it",
  };
  const notExecutable = evaluateOutcome(substring, { stdout: DIGEST });
  console.log(`  a substring pattern against a digest → ${notExecutable.value} (${notExecutable.reason})`);
  assert.equal(notExecutable.value, "unknown", "a substring pattern answered about a digest it cannot read");
  assert.notEqual(notExecutable.value, "no", "a run that may well have printed the pattern was reported as a failure");

  const digestContract = {
    check: { kind: "stdout_match", stdout_match: DIGEST },
    evidence: ["stdout"],
    unknown: "nothing was evaluated, which is not a failure of it",
  };
  const hit = evaluateOutcome(digestContract, { stdout: DIGEST });
  const miss = evaluateOutcome(digestContract, { stdout: DIGEST.replace(/.$/, "0") });
  console.log(`  a digest pattern, equal → ${hit.value}; differing → ${miss.value}`);
  assert.equal(hit.value, "yes", "a digest contract satisfied by an equal digest did not answer");
  assert.equal(miss.value, "no", "a digest contract is not discriminating: everything satisfies it");
});

// ===========================================================================
// B-4-2 — AN ANCHOR TO A CONCRETE COMMIT, OR NO EXEMPTION
// ===========================================================================

test("[B-4-2] the closed list of present-time adverbs is GONE from the guard", async () => {
  const guardSource = readFileSync(new URL("./docs-guard.ts", import.meta.url), "utf8");
  assert.equal(
    /\bcurrently\|right now\|as of today\b/.test(guardSource) || /const\s+PRESENT_TIME\s*=/.test(guardSource),
    false,
    "the guard still decides whether a sentence speaks of now from a closed list of adverbs: a sentence with no adverb walks past it",
  );
});

test("[B-4-2] violations equal plantings across EVERY shipped document — no third bucket, no survivors", async () => {
  const g = await import("./docs-guard.ts");
  const rules = g.documentRules();
  const documents = g.documentSet();
  let planted = 0;
  let caught = 0;
  const survived: string[] = [];
  // THE SET IS THE SHIPPED SET, and every document of it must be clean BEFORE a
  // lie goes in: a guard that already fails on a real document would report
  // catches it did not make.
  for (const [name, text] of documents) {
    assert.deepEqual(g.readDocument(name, text, rules).wrong, [], `${name} fails the guard before any lie is planted`);
    for (const lie of g.LIES) {
      planted += 1;
      if (g.readDocument(name, g.plant(name, text, lie.text), rules).wrong.length > 0) caught += 1;
      else survived.push(`${name}: ${lie.family}`);
    }
  }
  console.log(`[B-4-2] documents: ${documents.length}; plantings: ${planted}; refused: ${caught}`);
  assert.deepEqual(survived.slice(0, 20), [], "planted lies the guard did not refuse");
  assert.equal(caught, planted, "violations must equal plantings");
});

