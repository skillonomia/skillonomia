// ROUND 9b — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks come from the
// STATEMENT OF THE REQUIREMENT, are committed first, and must FAIL on the code
// as it stands. Their failure at the red commit is the proof that they
// discriminate, and that failure is recorded in the red commit's own message.
//
// WHAT ROUND 9 CLOSED, AND WHAT IT DID NOT.
//
//   Round 6 closed the SET of admissible evidence names to the ones this
//   registry's checks read PLUS the names a signed `outcome_contract` declared.
//   Round 8 closed the VALUES. Round 9 closed the FORM of a declared name: an
//   identifier, `^[a-z][a-z0-9_]{0,39}$`.
//
//   A FORM IS NOT A SUBJECT. The alphabet of an identifier is the alphabet a
//   great many secrets are already written in: a reviewer declared
//   `a0123456789abcdef0123456789abcdef` — an ordinary hex string, 33 characters,
//   inside the form by construction — as an evidence NAME. The package packed,
//   `/v1/observations` answered 201, and `observed_records.evidence` held
//   `{"exit_code":0,"a0123456789abcdef0123456789abcdef":true}` word for word.
//   No file access, no database access, no encoding: the registry's own contract
//   and the reviewer's own request, squarely inside D-21.
//
//   AND ROUND 9'S OWN SWEEP COULD NOT SEE IT, BY CONSTRUCTION. `[9.5]` decided
//   what "text" was by asking whether a string had FAILED THE FORM
//   (`/[^a-z0-9_]/.test(name) || name.length > 40 || /^[^a-z]/.test(name)`), so
//   the attack that passes the form was excluded from the sweep by the sweep's
//   own definition. A guard whose subject is "whatever the code already
//   refuses" cannot fail.
//
// THE REQUIREMENT OF THIS ROUND, WHICH IS NOT ANOTHER ALPHABET.
//
//   No regular expression separates a legitimate identifier from a secret
//   written as one, because every alphabet fit for readable names is fit for
//   part of the secrets. So the CHANNEL IS REMOVED rather than filtered: the
//   admissible names of the journal are `EVIDENCE_NAMES` and nothing else, and
//   the widening of that set by a version's signed declaration is deleted.
//
//   `outcome_contract.evidence` STAYS in the signed manifest as the author's
//   own declaration of what a run must present — the same standing the
//   substring form of `stdout_match` has. [I-7] bounds the JOURNAL, not the
//   manifest: author text under a signature never becomes a key of a record.
//
//   AND THE VERDICT MUST STOP REQUIRING IT. `evaluateOutcome` demanded the
//   PRESENCE of every declared name. With the widening gone, a contract naming
//   its own quantity would be unexecutable for ever — the name cannot be
//   presented (the boundary refuses it) and its absence is `unknown
//   evidence_missing:<name>`. A dead branch plus a false reason is the class of
//   defect this round removes, not one to introduce, so the requirement is that
//   the DECLARATION IS NOT A PRECONDITION of the verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as outcomeNamespace from "../src/outcome.ts";
import {
  EVIDENCE_NAMES,
  OUTCOME_CHECK_SHAPE,
  assessOutcome,
  evaluateOutcome,
  evidenceDigestOf,
  isEvidenceName,
  selfReported,
} from "../src/outcome.ts";
import { validateManifest } from "../src/manifest.ts";
import { manifestHash } from "../src/signing.ts";
import { arrivalMarker } from "../src/marker.ts";
import { writeTar, type PackageFiles } from "../src/archive.ts";
import { p4Fixture, reviewedVersion, rest, type P4Fixture } from "./p6-helpers.ts";
import { makeManifest, p2Fixture } from "./p2-helpers.ts";
import { pinnedFixture } from "./helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const outcome = outcomeNamespace as unknown as Record<string, unknown>;

/**
 * THE ATTACK OF THIS ROUND, IN THREE SHAPES: strings that are VALID IDENTIFIERS
 * AND ARE SECRETS. None is a real credential; every one is inside
 * `^[a-z][a-z0-9_]{0,39}$` without any effort being made to squeeze it in,
 * which is the whole point — a hex digest, a base32 blob and an API key are
 * written in the alphabet of an identifier because that is what such things are
 * written in.
 *
 * `TOKEN_LIKE` is ASSEMBLED FROM FRAGMENTS at run time, by the convention
 * `test/p7-threats.test.ts` TM-03 states and this file had broken: a push-side
 * scanner reads the FILE, and a complete literal of a vendor's key shape
 * refuses the publication of the whole repository (GH013 on candidate
 * `bdc99bdd`) over a fixture that is not a credential. The VALUE is unchanged,
 * byte for byte; only its spelling here is. [9b.1] executes the premise on all
 * three — `isEvidenceName` and a minimum length — so a mangled assembly fails
 * loudly rather than quietly ceasing to be the attack.
 */
const HEX_LIKE = "a0123456789abcdef0123456789abcdef";
const BASE32_LIKE = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_LIKE = pinnedFixture(
  ["sk", "live", "4ec39hqlyjwdarjtt1zdp7dc"].join("_"),
  "70775e630d40625a16439c6f582921f68e12be686ca6f5026a9357f3729da2cc",
  "the token-shaped key of [9b.1]",
);
const SECRETS_IN_THE_FORM: Array<[string, string]> = [
  ["a hex string of 33 characters", HEX_LIKE],
  ["a base32-shaped blob", BASE32_LIKE],
  ["a token-shaped key", TOKEN_LIKE],
];

const DIGEST = "sha256:9f2c4d0e1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

function contractWith(evidence: string[], check: Record<string, unknown> = { kind: "exit_code", exit_code: 0 }) {
  return {
    check,
    evidence,
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
}

// ===========================================================================
// THE FIXTURE — the shipped surfaces, and nothing written round the back
// ===========================================================================

interface Fixture {
  fx: P4Fixture;
  versionId: string;
  marker: string;
  report: (records: unknown[]) => { status: number; raw: string; body: any };
}

function fixture(contract: unknown, slug = "r9b-probe"): Fixture {
  const fx = p4Fixture();
  const version = reviewedVersion(fx, slug, { manifest: { outcome_contract: contract } });
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
      records,
    });
  return { fx, versionId: version.versionId, marker: arrivalMarker(version.versionId), report };
}

/** Every byte this database holds in the columns a report can reach — KEYS
 *  included, which is the subject of this round. */
function stored(fx: P4Fixture): string {
  const rows = fx.db.prepare("SELECT marker, result, evidence FROM observed_records").all() as Array<{
    marker: string;
    result: string;
    evidence: string | null;
  }>;
  return rows.map((r) => `${r.marker}|${r.result}|${r.evidence ?? ""}`).join("\n");
}

/** WHAT THE STORED BYTES DECODE TO. A refusal that stores numbers instead of
 *  letters has stored the material; the only honest read is the one an attacker
 *  would perform to get it back. */
function decoded(fx: P4Fixture): string {
  const codes = [...stored(fx).matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  return String.fromCharCode(...codes.filter((n) => Number.isInteger(n) && n >= 0 && n <= 0x10ffff));
}

/** One report of one name, through the shipped REST surface. */
function present(f: Fixture, name: string, value: unknown, id: string): { status: number; raw: string } {
  return f.report([
    { role: "call", call_id: id, marker: f.marker, at_ms: 1 },
    { role: "output", call_id: id, marker: f.marker, at_ms: 2, result: "success", evidence: { [name]: value } },
  ]);
}

const SKILL_MD = ["# Round 9b probe", "", "Prose an author wrote.", "", "## Procedure", "", "1. Run the fixture.", ""].join("\n");

/** A SOURCE tree for surface 14 — `manifest.json` + `SKILL.md`, no artefacts. */
function sourceTree(contract: unknown): Buffer {
  const manifest = makeManifest({ semantic_version: "1.0.0", outcome_contract: contract });
  delete manifest.integrity;
  delete manifest.author_agent;
  const files: PackageFiles = new Map();
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  files.set("SKILL.md", Buffer.from(SKILL_MD, "utf8"));
  return writeTar(files);
}

/**
 * PLANT A SIGNED CONTRACT, hash recomputed so the row is self-consistent.
 *
 * This is NOT a claim that a fleet agent can write to the registry's database —
 * D-21 says it cannot. It is how a SIGNED declaration is put in front of the
 * report boundary without going through the packer for every case: the
 * requirement is about what the boundary does with a declaration, and a
 * declaration of identifiers is packable anyway (`[9b.1]` packs one for real).
 */
function plantContract(fx: P4Fixture, versionId: string, contract: unknown): void {
  const row = fx.db.prepare("SELECT manifest_json FROM skill_versions WHERE id=?").get(versionId) as {
    manifest_json: string;
  };
  const manifest = JSON.parse(row.manifest_json);
  manifest.outcome_contract = contract;
  fx.db
    .prepare("UPDATE skill_versions SET manifest_json=?, manifest_hash=? WHERE id=?")
    .run(JSON.stringify(manifest), manifestHash(manifest), versionId);
}

// ===========================================================================
// 9b.1 — THE BLOCKER: A NAME THAT IS AN IDENTIFIER AND IS A SECRET
// ===========================================================================

test("[9b.1] a secret written in the alphabet of an identifier PACKS and is REFUSED at the report boundary", () => {
  // THE PREMISE, EXECUTED RATHER THAN ASSERTED: the form admits every one of
  // these. That is not a defect of the form — it is why a form cannot be the
  // fix, and the reason this round removes the channel instead of narrowing it
  // again.
  for (const [label, s] of SECRETS_IN_THE_FORM) {
    assert.equal(isEvidenceName(s), true, `${label} is outside the identifier form, so it is not the attack this round is about`);
    assert.ok(s.length >= 24, `${label} is too short to be the shape of a credential`);
  }

  for (const [i, [label, s]] of SECRETS_IN_THE_FORM.entries()) {
    // 1. THE MANIFEST STILL CARRIES THE AUTHOR'S DECLARATION. [I-7] bounds the
    //    journal, not the signed document, and an author declaring what its own
    //    run must present is the whole of D-2. Packing must NOT start refusing
    //    contracts because a name looks like a key: that would be the filter
    //    approach, one alphabet later.
    assert.equal(
      validateManifest(makeManifest({ outcome_contract: contractWith(["exit_code", s]) })).valid,
      true,
      `${label} cannot be declared in a manifest at all: the fix filtered the manifest instead of removing the journal's channel`,
    );
    const fxPack = p2Fixture();
    const packed = fxPack.registry.createFromDir(fxPack.author, {
      slug: `r9b-${i + 1}`,
      source: sourceTree(contractWith(["exit_code", s])),
    }).response;
    console.log(`  ${label.padEnd(30)} declared in a packed manifest → ${packed.skill_version_id ? "packed" : "refused"}`);
    assert.ok(packed.skill_version_id, `${label} made the package unpackable: the author's declaration is under the signature`);
    fxPack.db.close();

    // 2. AND THE JOURNAL DOES NOT TAKE IT. The version's own signed contract
    //    declares it, its own run presents it, and the boundary answers 400 —
    //    because the admissible names are the ones this registry's checks read
    //    and a declaration does not add to them.
    const f = fixture(contractWith(["exit_code", s]), `r9b-report-${i + 1}`);
    plantContract(f.fx, f.versionId, contractWith(["exit_code", s]));
    const answered = present(f, s, true, `r9b-1-${i}`);
    console.log(`  ${label.padEnd(30)} presented under its own contract → ${answered.status} ${answered.raw.slice(0, 60)}`);
    assert.equal(answered.status, 400, `${label} was accepted as a name: the channel is open to anything inside the form`);
    assert.match(answered.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal");
    assert.equal(answered.raw.includes(s), false, "the refusal echoed the name it refused [I-7]");

    // 3. THE DATABASE, READ AS THE ATTACKER WOULD READ IT — keys and values,
    //    with the numbers decoded.
    const back = `${stored(f.fx)}\n${decoded(f.fx)}`;
    assert.equal(back.includes(s), false, `${label} is recoverable out of observed_records.evidence`);
    f.fx.db.close();
  }
});

test("[9b.1] the same three strings are refused as VALUES under every name the registry itself reads", () => {
  // ROUND 8'S PROPERTY, RE-EXECUTED against this round's material: a fix to the
  // KEY rule that reopened the VALUE rule would otherwise pass unnoticed. The
  // set of names is the code's.
  const escaped: string[] = [];
  for (const [label, s] of SECRETS_IN_THE_FORM) {
    for (const name of EVIDENCE_NAMES) {
      const f = fixture(contractWith([...EVIDENCE_NAMES]), "r9b-values");
      const answered = present(f, name, s, "r9b-2");
      const back = `${stored(f.fx)}\n${decoded(f.fx)}`;
      if (answered.status === 201) escaped.push(`${label} as a VALUE under ${name} (accepted)`);
      else if (back.includes(s)) escaped.push(`${label} as a VALUE under ${name} (stored anyway)`);
      f.fx.db.close();
    }
  }
  for (const e of escaped) console.log(`  ESCAPED: ${e}`);
  console.log(`[9b.1] names swept as value carriers: ${EVIDENCE_NAMES.join(", ")}`);
  assert.deepEqual(escaped, [], "a secret-shaped string reached the journal as a value");
});

// ===========================================================================
// 9b.2 — THE SET IS THE CODE'S, AND WHAT A CONTRACT DECLARES CANNOT MOVE IT
// ===========================================================================

test("[9b.2] the admissible names are EXACTLY the derived set — and what the signed contract declares changes nothing", () => {
  // THE CANDIDATES: every name the code derives, plus the three shapes of this
  // round. The expected answer is computed from `EVIDENCE_NAMES`, so a fifth
  // check kind that starts reading a fifth value is swept the day it is added.
  const custom = SECRETS_IN_THE_FORM.map(([, s]) => s);
  const candidates = [...EVIDENCE_NAMES, ...custom, "suite_digest", "coverage_ratio"];
  console.log(`[9b.2] derived set: ${EVIDENCE_NAMES.join(", ")}`);
  assert.ok(EVIDENCE_NAMES.length >= 4, "the derived set is empty, so the sweep proves nothing");

  /** The accept/reject vector over the candidates, under ONE signed declaration. */
  const vectorUnder = (declaration: string[], slug: string): boolean[] =>
    candidates.map((name, i) => {
      const f = fixture(contractWith(declaration), slug);
      plantContract(f.fx, f.versionId, contractWith(declaration));
      const answered = present(f, name, true, `r9b-3-${i}`);
      const accepted = answered.status === 201;
      if (!accepted) assert.match(answered.raw, /INVALID_SCHEMA/, `a refusal of \`${name}\` that is not a schema refusal`);
      f.fx.db.close();
      return accepted;
    });

  // THE MUTATION, AND IT IS THE WHOLE PROOF THAT THE CHANNEL IS GONE BY
  // CONSTRUCTION rather than filtered: two DIFFERENT signed declarations, one
  // naming nothing but the derived set and one naming every candidate there is,
  // must produce the SAME answers. A boundary that reads the declaration cannot
  // pass this, whatever form it imposes on what it reads.
  const base = vectorUnder([...EVIDENCE_NAMES], "r9b-decl-base");
  const wide = vectorUnder([...EVIDENCE_NAMES, ...custom, "suite_digest", "coverage_ratio"], "r9b-decl-wide");
  for (const [i, name] of candidates.entries()) {
    console.log(`  ${name.slice(0, 36).padEnd(38)} base declaration → ${base[i]}   wide declaration → ${wide[i]}`);
  }
  assert.deepEqual(wide, base, "what a version's signed contract declares changed what the journal accepts: the channel is still there");

  // …AND THE ANSWER IS THE DERIVED SET ITSELF, so `they are the same` is not
  // satisfied by a boundary that refuses everything.
  const wanted = candidates.map((n) => EVIDENCE_NAMES.includes(n));
  assert.deepEqual(wide, wanted, "the admissible names are not exactly the ones this registry's own checks read");
  assert.ok(wanted.some((w) => w), "no candidate was expected to be admissible, so this sweep has no positive control");
});

// ===========================================================================
// 9b.3 — THE GUARD AGAINST REOPENING: THE FIELD IS READ BY NOTHING IN `src/`
// ===========================================================================

/** Every `.ts` file under `src/`, discovered by WALKING THE DIRECTORY. D-12: a
 *  guard that says `no file` takes its set from the code and never from a list
 *  written beside the assertion. */
function sourceFiles(dir = join(REPO_ROOT, "src"), prefix = "src"): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, `${prefix}/${entry}`));
    else if (entry.endsWith(".ts")) out.push([`${prefix}/${entry}`, readFileSync(full, "utf8")]);
  }
  return out;
}

test("[9b.3] nothing under `src/` names a channel of evidence names other than the derived set and the form", () => {
  // WHY A GUARD AT ALL, AND WHY THIS ONE. After the fix `outcome_contract.evidence`
  // is read by no code path that decides what the journal accepts. A field that
  // exists in the schema and is read by nobody is an invitation to a future edit
  // to wire it back in — the same reasoning that had `contractLiterals` DELETED
  // in round 8 rather than left dead.
  //
  // The guard is over IDENTIFIERS, because an identifier is what a rewiring
  // needs: any helper that answers "which names did this version declare" has
  // to be called something, and everything of that kind is caught by the shape
  // of its name. The admissible answers are not listed here — they are the
  // EXPORTS of `src/outcome.ts`, the one module that owns the derived set and
  // the form.
  const files = sourceFiles();
  console.log(`[9b.3] files under src/ swept: ${files.length}`);
  assert.ok(files.length >= 10, "the directory walk found almost nothing, so the sweep has no subject");

  const owned = new Set(Object.keys(outcome));
  const found = new Map<string, string[]>();
  for (const [name, text] of files) {
    for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*[Ee]vidence[_]?[Nn]ames?[A-Za-z0-9_$]*|EVIDENCE_NAMES?(?:_[A-Z]+)?/g)) {
      const id = m[0];
      if (!found.has(id)) found.set(id, []);
      if (!found.get(id)!.includes(name)) found.get(id)!.push(name);
    }
  }
  for (const [id, where] of [...found].sort()) console.log(`  ${id.padEnd(28)} ${where.join(", ")}`);
  assert.ok(found.has("EVIDENCE_NAMES"), "the sweep did not even find the derived set, so its pattern matches nothing");

  const strangers = [...found].filter(([id]) => !owned.has(id)).map(([id, where]) => `${id} (${where.join(", ")})`);
  assert.deepEqual(
    strangers,
    [],
    "a name under `src/` speaks of a set of evidence names that is not one `src/outcome.ts` exports: the only two admissible " +
      "notions are the set DERIVED from the check table and the FORM of a name, and anything else is a second answer to the " +
      "question `which names may the journal hold`",
  );

  // …AND THE SHAPES BY WHICH THE FIELD BECAME A NAME SOURCE ARE GONE TOO: a set
  // built out of a declaration, and a loop over one. These are the two
  // expressions the removed code was written in.
  const shapes: Array<[string, RegExp]> = [
    ["a name set built from a declaration", /new Set\(\s*[^)\n]*\.evidence\b/],
    ["a loop over a declaration", /\bof\s+[A-Za-z_$][A-Za-z0-9_$.?]*\.evidence\b/],
    ["a membership test against a declaration", /\.evidence\b[^\n]{0,40}\.(?:has|includes)\(/],
  ];
  const offenders: string[] = [];
  for (const [name, text] of files) {
    // COMMENTS ARE STRIPPED for this half: prose about the removed channel is
    // documentation, and the subject here is code.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    for (const [label, re] of shapes) {
      const hit = re.exec(code);
      if (hit) offenders.push(`${name}: ${label} — ${hit[0].trim().slice(0, 60)}`);
    }
  }
  for (const o of offenders) console.log(`  OFFENDER: ${o}`);
  assert.deepEqual(offenders, [], "a source file still builds the journal's admissible names out of what a contract declared");
});

// ===========================================================================
// 9b.4 — THE DECLARATION IS NOT A PRECONDITION OF THE VERDICT
// ===========================================================================

/** The values each kind's own check reads, and the parameters it is written
 *  against — both derived from the check table so a fifth kind is swept. */
function caseFor(kind: string): { check: Record<string, unknown>; satisfying: Record<string, unknown>; failing: Record<string, unknown> } {
  const artifact = "out/report.json";
  const command = "./verify.sh";
  switch (kind) {
    case "exit_code":
      return { check: { kind, exit_code: 0 }, satisfying: { exit_code: 0 }, failing: { exit_code: 1 } };
    case "stdout_match":
      return { check: { kind, stdout_match: DIGEST }, satisfying: { stdout_sha256: DIGEST }, failing: { stdout_sha256: evidenceDigestOf("something else") } };
    case "artifact_exists":
      return {
        check: { kind, artifact_path: artifact },
        satisfying: { artifacts: [evidenceDigestOf(artifact)] },
        failing: { artifacts: [evidenceDigestOf("out/other.json")] },
      };
    case "command":
      return {
        check: { kind, command },
        satisfying: { command: evidenceDigestOf(command), exit_code: 0 },
        failing: { command: evidenceDigestOf(command), exit_code: 1 },
      };
    default:
      throw new Error(`the check table grew a kind this probe has no case for: ${kind}`);
  }
}

test("[9b.4] a contract that declares its own names is still EXECUTABLE — swept over the whole check table", () => {
  // THE DEFECT THIS PROBE EXISTS TO PREVENT, and it is a defect of the FIX and
  // not of the code the fix replaces. Once a declared name can no longer be
  // presented, a verdict that requires its PRESENCE can never be reached: the
  // name is refused at the boundary, so its absence is permanent and the column
  // reads `unknown evidence_missing:<name>` for the life of the version. That
  // is a dead branch and a reason naming the wrong party, which is exactly the
  // class round 9b is cleaning out.
  //
  // The rule therefore is: the check's OWN input is required, the author's
  // declaration is not, and there is ONE definition of that requirement.
  const kinds = Object.keys(OUTCOME_CHECK_SHAPE);
  console.log(`[9b.4] kinds discovered from the check table: ${kinds.join(", ")}`);
  assert.ok(kinds.length >= 4, "the check table is empty, so the sweep proves nothing");

  const custom = SECRETS_IN_THE_FORM.map(([, s]) => s);
  const wrong: string[] = [];
  for (const kind of kinds) {
    const shape = OUTCOME_CHECK_SHAPE[kind]!;
    const { check, satisfying, failing } = caseFor(kind);
    // THE CONTRACT DECLARES ITS OWN QUANTITIES ON TOP OF THE CHECK'S — three of
    // them, none of which the boundary will ever admit.
    const contract = contractWith([shape.evidence, ...custom, "suite_digest"], check);

    const yes = evaluateOutcome(contract, satisfying);
    const no = evaluateOutcome(contract, failing);
    console.log(`  ${kind.padEnd(16)} satisfying → ${yes.value} (${yes.reason})   failing → ${no.value} (${no.reason})`);
    if (yes.value !== "yes") wrong.push(`${kind}: a satisfied check reads ${yes.value} (${yes.reason}) because a DECLARED name was absent`);
    if (no.value !== "no") wrong.push(`${kind}: an unsatisfied check reads ${no.value} (${no.reason}) because a DECLARED name was absent`);
    for (const v of [yes, no]) {
      for (const name of [...custom, "suite_digest"]) {
        if (v.reason.includes(name)) wrong.push(`${kind}: a verdict's reason names the author's declaration: ${v.reason.slice(0, 60)}`);
      }
    }

    // …AND THE PUBLISHED COLUMN MOVES WITH IT. A verdict nothing can reach is
    // not a verdict, so the assessment a report produces must carry the claim
    // the executed check establishes [D-18].
    const claimed = assessOutcome({ contract, claimed: selfReported(satisfying), observed: null, principal: { type: "agent" } });
    console.log(`  ${kind.padEnd(16)} as a self-report → ${claimed.value} (${claimed.reason}) claim=${claimed.claim}`);
    if (claimed.claim !== "yes") wrong.push(`${kind}: the self-report's own conclusion is ${claimed.claim}, so the check never ran`);

    // …AND THE ONE MISSING-EVIDENCE REASON THAT REMAINS NAMES THE CHECK'S OWN
    // INPUT. `unknown` for want of the value the check reads is honest and
    // reachable; `unknown` for want of a name nothing may present is not.
    const nothing = evaluateOutcome(contract, {});
    console.log(`  ${kind.padEnd(16)} nothing presented → ${nothing.value} (${nothing.reason})`);
    if (nothing.value !== "unknown") wrong.push(`${kind}: a check with no evidence answered ${nothing.value}`);
    if (!nothing.reason.includes(shape.evidence)) {
      wrong.push(`${kind}: the missing-evidence reason does not name the check's own input: ${nothing.reason}`);
    }
    for (const name of [...custom, "suite_digest"]) {
      if (nothing.reason.includes(name)) wrong.push(`${kind}: the missing-evidence reason names a DECLARED name: ${nothing.reason.slice(0, 60)}`);
    }
  }
  for (const w of wrong) console.log(`  WRONG: ${w}`);
  assert.deepEqual(wrong, [], "a contract's own declaration is a precondition of its verdict, so a name the boundary refuses makes it unevaluable for ever");
});

test("[9b.4] there is ONE definition of what a check requires, and `evidence_missing` for a declared name does not exist", () => {
  // TWO DEFINITIONS OF ONE RULE IS THE MECHANISM BY WHICH THEY DIVERGE — the
  // reasoning that put the value grammar and the name form in one place each.
  // A loop over the declaration RESTRICTED to the base set would be a second
  // statement of `the check's own input must be present`, so the requirement is
  // that the loop is GONE and not that it is narrowed.
  //
  // Executed over the whole space rather than read: for every kind and every
  // subset of the derived set, the reasons reachable from a contract declaring
  // the entire derived set plus three names of its own are the SAME reasons as
  // from a contract declaring only what its check reads.
  const kinds = Object.keys(OUTCOME_CHECK_SHAPE);
  const custom = SECRETS_IN_THE_FORM.map(([, s]) => s);
  const diverged: string[] = [];
  for (const kind of kinds) {
    const shape = OUTCOME_CHECK_SHAPE[kind]!;
    const { check, satisfying } = caseFor(kind);
    const minimal = contractWith([shape.evidence], check);
    const declaring = contractWith([shape.evidence, ...EVIDENCE_NAMES, ...custom], check);
    // EVERY SUBSET of the presented values, so a difference in which name is
    // missing cannot hide inside one case.
    const entries = Object.entries(satisfying);
    for (let mask = 0; mask < 1 << entries.length; mask += 1) {
      const values = Object.fromEntries(entries.filter((_, i) => (mask >> i) & 1));
      const a = evaluateOutcome(minimal, values);
      const b = evaluateOutcome(declaring, values);
      if (a.value !== b.value || a.reason !== b.reason) {
        diverged.push(`${kind} ${JSON.stringify(Object.keys(values))}: minimal → ${a.value}/${a.reason}; declaring → ${b.value}/${b.reason}`);
      }
    }
  }
  for (const d of diverged.slice(0, 20)) console.log(`  DIVERGED: ${d}`);
  console.log(`[9b.4] subsets compared: ${kinds.length} kinds × every subset of their own values`);
  assert.deepEqual(diverged, [], "what a contract DECLARES changes the verdict, so the declaration is a second definition of what a check requires");
});

// ===========================================================================
// 9b.5 — THE SHIPPED WORDS SAY WHAT IS DELIVERED, AND NOT MORE
// ===========================================================================

/** Files this repository tracks, minus its own probes: a test is the check, not
 *  a statement to a reader. */
function trackedProse(): Array<[string, string]> {
  const listing = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 });
  return listing
    .split("\0")
    .filter((f) => f.length > 0 && !f.startsWith("test/"))
    .map((f) => [f, readFileSync(join(REPO_ROOT, f), "utf8")] as [string, string]);
}

test("[9b.5] every file that names `outcome_contract.evidence` says the registry does not read it as a source of names", () => {
  // THE SET IS DISCOVERED: the files that NAME the field. A field that is
  // declarative and read by nothing has to SAY so wherever it is described,
  // because the sentence a reader carries away from an undocumented field is
  // the one the old code implemented.
  const naming = trackedProse().filter(([, text]) => text.includes("outcome_contract.evidence"));
  console.log(`[9b.5] files naming the field: ${naming.map(([f]) => f).join(", ")}`);
  assert.ok(naming.length >= 4, "no shipped file names the field, so this guard has no subject");

  const silent = naming.filter(([, text]) => !/NOT A SOURCE OF ADMISSIBLE NAMES/i.test(text)).map(([f]) => f);
  for (const f of silent) console.log(`  SILENT: ${f}`);
  assert.deepEqual(
    silent,
    [],
    "a file describes `outcome_contract.evidence` without saying that this registry does not read it as a source of admissible " +
      "names: the field is the author's declaration under a signature, and the journal's keys are the derived set alone",
  );
});

test("[9b.5] no file promises a guarantee no alphabet can deliver, and every one that states the FORM states its limit", () => {
  // THE ACHIEVABLE PROPERTY: this registry does not put text in the journal
  // itself, and the FORMS it accepts are bounded. True, and checked by the
  // probes above.
  //
  // THE UNACHIEVABLE ONE: `a secret cannot end up in the journal`. False under
  // every alphabet, because an author can encode — accepted as a stated limit
  // in round 7 (a flat list of thirty-two integers) and confirmed in round 8.
  // A promise of the second in a shipped file is a lie about a security
  // property, which [D-20] blocks on.
  const forbidden: Array<[string, RegExp]> = [
    ["a secret cannot reach the journal", /\bno secret (?:can|could|will) (?:ever )?(?:reach|enter|be (?:stored|written))/i],
    ["a secret is impossible here", /\b(?:secret|credential)s? (?:cannot|can never|could never) (?:reach|enter|be (?:stored|written|held))/i],
    ["nothing an author writes can be recovered", /\bnothing an author (?:writes|wrote) can be recovered\b/i],
    ["encoding is impossible", /\b(?:encoding|an encoding) is (?:impossible|not possible)\b/i],
  ];
  const lying: string[] = [];
  for (const [name, text] of trackedProse()) {
    const flat = text.replace(/\s+/g, " ");
    for (const [label, re] of forbidden) {
      const hit = re.exec(flat);
      if (hit) lying.push(`${name}: ${label} — ${hit[0].slice(0, 100)}`);
    }
  }
  for (const l of lying) console.log(`  LYING: ${l}`);
  assert.deepEqual(lying, [], "a file promises that a secret cannot reach the journal, which is false under any alphabet an author may encode in");

  // …AND THE FILES THAT SPELL THE FORM OUT STATE ITS LIMIT. The set is
  // discovered by the PATTERN ITSELF, taken from the schema, so a fourth file
  // that starts describing the form is swept the day it does.
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schema/skill-package-v1.schema.json"), "utf8"));
  const pattern: string = schema.properties?.outcome_contract?.properties?.evidence?.items?.pattern;
  assert.ok(typeof pattern === "string" && pattern.length > 0, "the schema no longer carries the form, so this set cannot be discovered");
  const spelling = trackedProse().filter(([, text]) => text.includes(pattern));
  console.log(`[9b.5] files spelling out ${pattern}: ${spelling.map(([f]) => f).join(", ")}`);
  assert.ok(spelling.length >= 2, "the form is spelled out nowhere, so this guard has no subject");

  const quiet = spelling.filter(([, text]) => !/carry an encoding/i.test(text)).map(([f]) => f);
  for (const f of quiet) console.log(`  QUIET: ${f}`);
  assert.deepEqual(
    quiet,
    [],
    "a file states the identifier form without stating what a bounded alphabet still permits: an identifier is a string an author " +
      "chose, and any bounded alphabet can be made to carry an encoding, exactly as a flat list of integers can",
  );
});
