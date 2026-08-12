// ROUND 9 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks come from the
// STATEMENT OF THE REQUIREMENT, are committed first, and must FAIL on the code
// as it stands. A probe written after the fix cannot discriminate — it was
// shaped by the answer. Its failure at the red commit is the proof, and that
// failure is recorded in the red commit's own message.
//
// THE ONE CHANNEL ROUND 8 FOUND AND DID NOT CLOSE: THE NAME.
//
//   Round 6 closed the SET of evidence names to the ones a signed contract asks
//   for. Round 8 closed the VALUES to booleans, safe integers and digests, and
//   removed the echo of signed literals. Both of those are about what a name
//   CARRIES. Neither is about what a name IS.
//
//   A name in `outcome_contract.evidence` is a string the AUTHOR wrote. It is
//   stored in `observed_records.evidence` as a JSON KEY, word for word. The
//   schema bounds it at 20 names of 80 characters, and bounds nothing else
//   about it: spaces, punctuation, case and the whole of unicode are inside the
//   form. Under D-21 an author is a fleet agent like any other, so 1600
//   characters of its own text — prose, a pasted credential, a slice of a
//   transcript — go into that column by the shipped route: declare them as
//   names, sign the manifest, have your own run present them.
//
//   THE FIX IS TO NARROW THE FORM, not to store a digest. A digest would make
//   the journal unreadable for the legitimate reason it exists: a human looking
//   at a record must be able to see WHICH quantity was presented. So a name
//   becomes an IDENTIFIER — lowercase letters, digits and underscore, starting
//   with a letter, bounded in length — which is human-readable and is not a
//   place a sentence can be written.
//
//   AND THE RULE GOES IN THE SCHEMA, not only at intake. A contract naming a
//   sentence must not be PACKABLE: the channel is closed at its source. The
//   `/v1/observations` boundary enforces it too, so a contract that reaches the
//   report path by any other route declares nothing this journal will store.
//
// WHAT THESE PROBES DO NOT DO: check that a sentence was edited. They EXECUTE
// the requirement — every character of the printable range at every position,
// the whole admissible name set taken from the code, and the DATABASE read back
// with its numbers decoded, on the keys as well as on the values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as outcomeNamespace from "../src/outcome.ts";
import { EVIDENCE_NAMES } from "../src/outcome.ts";
import { outcomeContractOf, validateManifest } from "../src/manifest.ts";
import { manifestHash } from "../src/signing.ts";
import { arrivalMarker } from "../src/marker.ts";
import { writeTar, type PackageFiles } from "../src/archive.ts";
import { p4Fixture, reviewedVersion, rest, type P4Fixture } from "./p6-helpers.ts";
import { makeManifest, p2Fixture } from "./p2-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const outcome = outcomeNamespace as unknown as Record<string, unknown>;

/** Name a thing that does not exist yet WITHOUT taking the file down with a
 *  module error: a missing export must read as one sentence, not twenty. */
function required<T>(mod: Record<string, unknown>, name: string, what: string): T {
  const v = mod[name];
  assert.ok(v !== undefined, `\`${name}\` is not exported by the module under probe — ${what}`);
  return v as T;
}

/** THE REQUIREMENT'S OWN ALPHABET, written here because a probe that took the
 *  alphabet from the code under test would be asking the code whether it agrees
 *  with itself. Everything else in this file — the bound, the set of admissible
 *  names, the characters swept — is derived. */
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const TAIL = `${LOWER}0123456789_`;

/** A secret-SHAPED marker and a whole transcript — the same two the round-8
 *  probes used, so what is closed here is measured against what was open there.
 *  Neither is a real credential. */
const SECRET_VALUE = "sk-live-skln-r9-not-a-real-credential-4b71ce";
const TRANSCRIPT_VALUE =
  "the operator pasted the deploy key and the assistant repeated it back, and then the whole session went on for another hour";

/**
 * The token-shaped key of [9.5], assembled from fragments at run time rather
 * than written out — the convention `test/p7-threats.test.ts` TM-03 states and
 * this file had broken. A push-side scanner reads the FILE, so a complete
 * literal of this shape refuses the publication of the whole repository
 * (GH013 on candidate `bdc99bdd`) over a fixture that is not a credential.
 *
 * THE VALUE IS UNCHANGED, BYTE FOR BYTE. Only its spelling here is: the probe
 * still presents the same string, still inside `^[a-z][a-z0-9_]{0,39}$`, and
 * [9.5] asserts that form on it before using it, so a mangled assembly fails
 * loudly instead of quietly weakening the attack.
 */
const TOKEN_LIKE = ["sk", "live", "4ec39hqlyjwdarjtt1zdp7dc"].join("_");

const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, "schema/skill-package-v1.schema.json"), "utf8"));
/** The schema's shape for a DECLARED name — the packing-side half of the rule. */
const DECLARED = SCHEMA.properties?.outcome_contract?.properties?.evidence;

function contractWith(evidence: string[]) {
  return {
    check: { kind: "exit_code", exit_code: 0 },
    evidence,
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
}

/** Whether the PACKING schema admits a contract declaring these names. */
function schemaAdmits(evidence: string[]): boolean {
  return validateManifest(makeManifest({ outcome_contract: contractWith(evidence) })).valid;
}

/** Whether the READ path admits it — the function `/v1/observations` reaches
 *  through `signedEvidenceNames` when it asks what a version declared. */
function contractReadAdmits(evidence: string[]): boolean {
  return outcomeContractOf(makeManifest({ outcome_contract: contractWith(evidence) })).valid;
}

// ===========================================================================
// 9.1 — THE FORM HAS ONE DEFINITION, AND BOTH POINTS CARRY THE SAME ONE
// ===========================================================================

test("[9.1] the form of a name is defined ONCE in the code and the schema carries that same form", () => {
  const pattern = required<RegExp>(
    outcome,
    "EVIDENCE_NAME",
    "the form of a declared name must have one definition, or the packing schema and the report boundary will drift apart the way " +
      "the name set and the value grammar did in rounds 5 and 7",
  );
  const max = required<number>(outcome, "EVIDENCE_NAME_MAX", "the length bound belongs with the form, not beside it");
  const isName = required<(name: unknown) => boolean>(outcome, "isEvidenceName", "one predicate, used by both points");

  assert.ok(pattern instanceof RegExp, "`EVIDENCE_NAME` is not a regular expression");
  assert.ok(Number.isSafeInteger(max) && max > 0, "`EVIDENCE_NAME_MAX` is not a length");

  // THE SCHEMA'S COPY IS THE CODE'S COPY. A pattern typed out twice is a rule
  // that will be widened in one place and not the other.
  assert.ok(DECLARED, "the schema no longer shapes `outcome_contract.evidence`");
  console.log(`[9.1] schema pattern: ${DECLARED.items?.pattern}   code pattern: ${pattern.source}`);
  assert.equal(DECLARED.items?.pattern, pattern.source, "the schema's pattern is not the pattern the code enforces");
  assert.equal(DECLARED.items?.maxLength, max, "the schema's length bound is not the bound the code enforces");

  // THE BOUND IS A KEY'S BOUND AND NOT A SENTENCE'S, checked against the code's
  // own longest name rather than against a number typed here.
  const longest = [...EVIDENCE_NAMES].reduce((a, b) => (b.length > a.length ? b : a), "");
  console.log(`[9.1] bound ${max}; the longest name this registry itself reads is \`${longest}\` (${longest.length})`);
  assert.ok(max >= longest.length, "the bound refuses a name this registry's own checks read");
  assert.ok(max <= 64, "a name bounded above 64 characters is a sentence with a length limit, not an identifier");

  // EVERY NAME OF THE BASE SET, from the code and not from a list here.
  const wrong = [...EVIDENCE_NAMES].filter((n) => !isName(n));
  console.log(`[9.1] base names swept: ${EVIDENCE_NAMES.join(", ")}`);
  assert.deepEqual(wrong, [], "a name this registry's own checks read is outside the form it imposes on authors");
  assert.ok(EVIDENCE_NAMES.length >= 4, "the base set is empty, so the sweep proves nothing");
});

// ===========================================================================
// 9.2 — THE UNIVERSAL FORM: EVERY CHARACTER, AT EVERY POSITION, AT BOTH POINTS
// ===========================================================================

test("[9.2] every printable character is asked at every position, and both points answer the same", () => {
  const isName = required<(name: unknown) => boolean>(outcome, "isEvidenceName", "9.2 sweeps one predicate");
  const max = required<number>(outcome, "EVIDENCE_NAME_MAX", "9.2 builds its names from the bound");

  // THE SWEEP IS OVER THE CHARACTER SPACE, not over a list of examples. Every
  // printable ASCII character plus a sample of the rest of unicode, at the
  // first position and at a later one — the two positions the form treats
  // differently.
  const chars: string[] = [];
  for (let c = 0x20; c <= 0x7e; c += 1) chars.push(String.fromCharCode(c));
  for (const u of ["é", "к", "中", "🙂", "​", " ", "\t", "\n"]) chars.push(u);

  const wrong: string[] = [];
  for (const c of chars) {
    for (const [position, name] of [
      ["first", `${c}aa`],
      ["middle", `a${c}a`],
      ["last", `aa${c}`],
    ] as Array<[string, string]>) {
      // THE REQUIREMENT, stated independently of the code: a first character is
      // a lowercase letter; any later one is a lowercase letter, a digit or an
      // underscore.
      const wanted = position === "first" ? LOWER.includes(c) : TAIL.includes(c);
      const got = isName(name);
      if (got !== wanted) wrong.push(`${JSON.stringify(name)} → ${got}, wanted ${wanted}`);
      // …AND THE OTHER POINT ANSWERS THE SAME. A schema that admits what the
      // boundary refuses is a contract that packs and then declares nothing.
      if (schemaAdmits([name]) !== wanted) wrong.push(`${JSON.stringify(name)} → the packing schema disagrees`);
      if (contractReadAdmits([name]) !== wanted) wrong.push(`${JSON.stringify(name)} → the read path disagrees`);
    }
  }
  for (const w of wrong.slice(0, 40)) console.log(`  ${w}`);
  console.log(`[9.2] characters swept: ${chars.length}; disagreements: ${wrong.length}`);
  assert.deepEqual(wrong, [], "a character is admitted or refused against the form, or the two enforcement points disagree");

  // THE LENGTH, TAKEN FROM THE CODE. At the bound it passes, one over it is
  // refused, and both enforcement points agree about where the edge is.
  const atBound = `a${"b".repeat(max - 1)}`;
  const over = `a${"b".repeat(max)}`;
  console.log(`[9.2] a name of ${atBound.length} → ${isName(atBound)}; of ${over.length} → ${isName(over)}`);
  assert.equal(isName(atBound), true, "a name at the bound was refused");
  assert.equal(isName(over), false, "a name over the bound was admitted");
  assert.equal(schemaAdmits([atBound]), true, "the packing schema refuses a name at the bound");
  assert.equal(schemaAdmits([over]), false, "the packing schema admits a name over the bound");
  assert.equal(contractReadAdmits([atBound]), true, "the read path refuses a name at the bound");
  assert.equal(contractReadAdmits([over]), false, "the read path admits a name over the bound");

  // AND THE SHAPES THE REQUIREMENT NAMES, each built rather than typed: with a
  // space, with punctuation, with unicode, with a leading digit, empty, over
  // the bound, upper case. Every one refused at both points; a legitimate
  // identifier admitted at both, or every refusal here is vacuous.
  const forms: Array<[string, string]> = [
    ["with a space", "exit code"],
    ["with punctuation", "exit-code"],
    ["with a full stop", "exit.code"],
    ["with unicode", "выход"],
    ["with an emoji", "exit🙂code"],
    ["with a leading digit", "0exit"],
    ["with a leading underscore", "_exit"],
    ["empty", ""],
    ["over the bound", over],
    ["upper case", "EXIT_CODE"],
    ["mixed case", "exitCode"],
    ["a sentence", TRANSCRIPT_VALUE.slice(0, max)],
    ["a secret", SECRET_VALUE],
  ];
  const escaped: string[] = [];
  for (const [label, name] of forms) {
    const answers = { form: isName(name), packing: schemaAdmits([name]), read: contractReadAdmits([name]) };
    console.log(`  ${label.padEnd(26)} ${JSON.stringify(name).slice(0, 30).padEnd(32)} → ${JSON.stringify(answers)}`);
    if (answers.form || answers.packing || answers.read) escaped.push(`${label}: ${JSON.stringify(answers)}`);
  }
  assert.deepEqual(escaped, [], "a name outside the form was admitted at one of the two points");

  const legitimate = ["exit_code", "suite_digest", "coverage", "integration_suite_exit_code", `a${"b".repeat(max - 1)}`];
  for (const name of legitimate) {
    assert.equal(isName(name), true, `a legitimate identifier \`${name}\` was refused by the form`);
    assert.equal(schemaAdmits([name]), true, `a legitimate identifier \`${name}\` cannot be packed`);
    assert.equal(contractReadAdmits([name]), true, `a legitimate identifier \`${name}\` declares nothing`);
  }
});

// ===========================================================================
// 9.3 — THE PACKING SURFACE ITSELF REFUSES, SO THE CHANNEL IS CLOSED AT SOURCE
// ===========================================================================

const SKILL_MD = ["# Round 9 probe", "", "Prose an author wrote.", "", "## Procedure", "", "1. Run the fixture.", ""].join("\n");

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

test("[9.3] a contract declaring a secret or prose as NAMES cannot be packed at all", () => {
  // THE ATTACK, REPRODUCED BY THE ROUTE THE REQUIREMENT NAMES: the author is a
  // fleet agent [D-21], it declares its text as evidence names, and its own run
  // presents them. The first place that has to say no is the one that produces
  // the package.
  const attacks: Array<[string, string[]]> = [
    ["a sentence and a secret, as the round-8 reviewer wrote them", ["the operator pasted the key ", SECRET_VALUE]],
    ["a whole transcript, one name at a time", TRANSCRIPT_VALUE.split(" ").slice(0, 20)],
    ["one prose name beside three legitimate ones", ["exit_code", "stdout_sha256", "artifacts", "the deploy key was pasted"]],
  ];
  for (const [i, [label, evidence]] of attacks.entries()) {
    const fx = p2Fixture();
    let status = "packed";
    try {
      fx.registry.createFromDir(fx.author, { slug: `r9-${i + 1}`, source: sourceTree(contractWith(evidence)) });
    } catch (e: any) {
      status = String(e?.code ?? e?.name ?? "error");
    }
    console.log(`  ${label.padEnd(58)} → ${status}`);
    assert.equal(status, "INVALID_SCHEMA", `${label} was packable: the channel is open at its source`);
    // …AND NOTHING WAS WRITTEN. A refusal after the transaction would leave the
    // author's text in a manifest row, which is the column's neighbour.
    const rows = fx.db.prepare("SELECT manifest_json FROM skill_versions").all() as Array<{ manifest_json: string }>;
    const written = rows.map((r) => r.manifest_json).join("\n");
    assert.equal(written.includes(SECRET_VALUE), false, "the refused source left the secret in a manifest row");
    assert.equal(written.includes("the operator pasted"), false, "the refused source left the author's prose in a manifest row");
    fx.db.close();
  }

  // THE POSITIVE CONTROL: the same surface, the same tree, identifiers instead
  // of prose. Without this the three refusals above would be satisfied by a
  // surface that packs nothing at all.
  const fx = p2Fixture();
  const out = fx.registry.createFromDir(fx.author, {
    slug: "r9-legitimate",
    source: sourceTree(contractWith(["exit_code", "suite_digest"])),
  }).response;
  console.log(`  a contract of identifiers → ${out.state ?? "created"}`);
  assert.ok(out.skill_version_id, "a contract declaring identifiers could not be packed, so every refusal above is vacuous");
  fx.db.close();
});

// ===========================================================================
// 9.4 — THE BOUNDARY: A CONTRACT THAT ARRIVES ANYWAY DECLARES NOTHING
// ===========================================================================

const DECLARED_CONTRACT = contractWith(["exit_code", "suite_digest"]);

interface Fixture {
  fx: P4Fixture;
  versionId: string;
  marker: string;
  report: (records: unknown[]) => { status: number; raw: string; body: any };
}

function fixture(contract: unknown = DECLARED_CONTRACT, slug = "r9-probe"): Fixture {
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

/**
 * PLANT A SIGNED CONTRACT THE SCHEMA WOULD NOT HAVE PACKED.
 *
 * This is NOT a claim that a fleet agent can write to the registry's database —
 * D-21 says it cannot, and a probe that pretended otherwise would be attacking
 * outside the model. It is how the SECOND enforcement point is exercised at
 * all: the requirement is that the boundary refuses such a contract's names
 * even if one reaches it, so the probe puts one there and reads what the
 * boundary does. The manifest hash is recomputed, so the row is self-consistent
 * and `signedEvidenceNames` reaches the contract rather than failing on the
 * hash for an unrelated reason.
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

/** Every byte this database holds in the columns a report can reach — KEYS
 *  included, which is the whole subject of this round. */
function stored(fx: P4Fixture): string {
  const rows = fx.db.prepare("SELECT marker, result, evidence FROM observed_records").all() as Array<{
    marker: string;
    result: string;
    evidence: string | null;
  }>;
  return rows.map((r) => `${r.marker}|${r.result}|${r.evidence ?? ""}`).join("\n");
}

/** WHAT THE STORED BYTES DECODE TO. A refusal that stores numbers instead of
 *  letters has stored the text; the only honest read is the one the attacker
 *  would perform to get its material back. */
function decoded(fx: P4Fixture): string {
  const codes = [...stored(fx).matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  return String.fromCharCode(...codes.filter((n) => Number.isInteger(n) && n >= 0 && n <= 0x10ffff));
}

test("[9.4] a contract whose names are prose declares NOTHING at the report boundary", () => {
  const prose = ["the operator pasted the key ", SECRET_VALUE, "exit_code"];
  const { fx, versionId, marker, report } = fixture(DECLARED_CONTRACT, "r9-boundary");
  plantContract(fx, versionId, contractWith(prose));

  for (const [label, evidence] of [
    ["the prose name, with an integer under it", { "the operator pasted the key ": 1 }],
    ["the secret-shaped name", { [SECRET_VALUE]: 0 }],
    ["a prose name beside a legitimate one", { exit_code: 0, "the operator pasted the key ": 1 }],
  ] as Array<[string, Record<string, unknown>]>) {
    const planted = report([
      { role: "call", call_id: "r9-4", marker, at_ms: 1 },
      { role: "output", call_id: "r9-4", marker, at_ms: 2, result: "success", evidence },
    ]);
    console.log(`  ${label.padEnd(46)} → ${planted.status} ${planted.raw.slice(0, 60)}`);
    assert.notEqual(planted.status, 201, `${label} was accepted: the boundary reads the author's prose as a name`);
    assert.match(planted.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal");
    assert.equal(planted.raw.includes(SECRET_VALUE), false, "the refusal echoed the name it refused [I-7]");
  }

  // THE DATABASE, READ THE WAY THE ATTACKER WOULD READ IT — and this round the
  // read is over the KEYS as well as the values.
  const back = `${stored(fx)}\n${decoded(fx)}`;
  for (const forbidden of [SECRET_VALUE, "the operator pasted", "the deploy key"]) {
    assert.equal(back.includes(forbidden), false, `\`${forbidden.slice(0, 24)}…\` is recoverable out of observed_records.evidence`);
  }
  fx.db.close();
});

test("[9.4] a contract of IDENTIFIERS declares nothing here either, and D-2's own mechanism is untouched", () => {
  // WHAT THIS ASSERTED AND WHY IT INVERTED. It was the positive control of round
  // 9: a planted contract of identifiers had to keep declaring its names, or the
  // refusals above would have been satisfied by a boundary that stopped reading
  // signed contracts altogether — closing the channel by breaking D-2.
  //
  // Round 9b took the honest way out of that trade: the channel is removed, so
  // there is nothing to keep working. A declared identifier is refused exactly
  // like a declared sentence, which is the point — no form of a declared name is
  // admissible, so no form of it has to be judged.
  const { fx, versionId, marker, report } = fixture(DECLARED_CONTRACT, "r9-still-works");
  plantContract(fx, versionId, contractWith(["exit_code", "coverage_ratio"]));
  const declared = report([
    { role: "call", call_id: "r9-ok", marker, at_ms: 1 },
    { role: "output", call_id: "r9-ok", marker, at_ms: 2, result: "success", evidence: { exit_code: 0, coverage_ratio: 97 } },
  ]);
  console.log(`  a declared identifier through /v1/observations → ${declared.status} ${declared.raw.slice(0, 60)}`);
  assert.equal(declared.status, 400, "a name a signed contract declares is still admissible: the widening survived");
  assert.equal(stored(fx).includes("coverage_ratio"), false, "the declared name was stored despite the refusal");

  // AND THE POSITIVE CONTROL MOVES TO WHERE THE MECHANISM ACTUALLY LIVES. D-2 is
  // that the registry EXECUTES the signed contract's own `check` — the boundary
  // narrowing was never that mechanism. The same planted contract still decides a
  // verdict from the values the check reads, so `nothing is admissible` has not
  // been achieved by making the contract unreadable.
  const accepted = report([
    { role: "call", call_id: "r9-ok2", marker, at_ms: 3 },
    { role: "output", call_id: "r9-ok2", marker, at_ms: 4, result: "success", evidence: { exit_code: 0 } },
  ]);
  console.log(`  the check's own \`exit_code\`                    → ${accepted.status} ${accepted.raw.slice(0, 60)}`);
  assert.equal(accepted.status, 201, "the value the contract's own check reads was refused, so every refusal here is vacuous");
  assert.ok(stored(fx).includes("exit_code"), "the check's own input was not stored");
  const verdict = outcomeContractOf(JSON.parse(
    (fx.db.prepare("SELECT manifest_json FROM skill_versions WHERE id=?").get(versionId) as { manifest_json: string }).manifest_json,
  ));
  assert.equal(verdict.valid, true, "the planted contract stopped being readable, so D-2's mechanism was broken instead of the channel");
  fx.db.close();
});

// ===========================================================================
// 9.5 — THE SWEEP: EVERY ADMISSIBLE NAME, EVERY SHAPE OF TEXT, KEYS AND VALUES
// ===========================================================================

test("[9.5] no string an author declared reaches the journal as a KEY — including the ones the FORM admits", () => {
  // WHAT THIS PROBE USED TO DO, AND WHY IT COULD NOT FAIL.
  //
  // It decided what "text" was by asking whether a string had FAILED THE FORM:
  // `/[^a-z0-9_]/.test(name) || name.length > 40 || /^[^a-z]/.test(name)`. Every
  // string INSIDE the form was therefore excluded from the sweep by the sweep's
  // own definition — and the real attack is inside the form. A reviewer declared
  // `a0123456789abcdef0123456789abcdef`, an ordinary hex string of 33
  // characters, as an evidence NAME: it packed, `/v1/observations` answered 201,
  // and the material came back out of `observed_records.evidence` word for word,
  // with this test green beside it. A guard whose subject is "whatever the code
  // already refuses" is not a guard.
  //
  // SO THE SUBJECT IS NOW EVERY STRING AN AUTHOR DECLARED, form or no form. The
  // journal's keys are `EVIDENCE_NAMES` — derived in `src/outcome.ts` from the
  // check table — and a declaration adds nothing to them, so the expected answer
  // does not depend on how a declared name looks.
  const names = [...EVIDENCE_NAMES];
  console.log(`[9.5] the journal's admissible names: ${names.join(", ")}`);
  assert.ok(names.length >= 4, "the admissible set is empty, so the sweep proves nothing");

  // THE SHAPES OF AUTHOR TEXT, offered as NAMES — prose that the form refuses
  // AND material that the form admits, so the sweep spans both sides of the line
  // the old predicate drew.
  const texts: Array<[string, string]> = [
    ["a secret", SECRET_VALUE],
    ["a transcript", TRANSCRIPT_VALUE],
    ["a fragment of prose", "the operator pasted the key "],
    ["a hex string inside the form", "a0123456789abcdef0123456789abcdef"],
    ["a base32 blob inside the form", "abcdefghijklmnopqrstuvwxyz234567"],
    ["a token-shaped key inside the form", TOKEN_LIKE],
  ];

  const escaped: string[] = [];
  for (const [label, text] of texts) {
    // AS A NAME: declared by the version's own signed contract, presented by its
    // own run — in every deformation, because the requirement is about what the
    // journal accepts and not about which deformation somebody thought of.
    const asNames: Array<[string, string]> = [
      ["as written", text.slice(0, 80)],
      ["with the spaces removed", text.replace(/\s+/g, "_").slice(0, 80)],
      ["upper case", text.slice(0, 80).toUpperCase()],
      ["punctuation only", text.slice(0, 80).replace(/[a-z0-9]/gi, ".")],
      ["with a leading digit", `0${text.slice(0, 60)}`],
      ["as unicode", `т${text.slice(0, 60)}`],
      ["lower case, no punctuation — an identifier", `a${text.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 39)}`],
    ];
    for (const [shape, name] of asNames) {
      const { fx, versionId, marker, report } = fixture(DECLARED_CONTRACT, "r9-sweep");
      plantContract(fx, versionId, contractWith([...names, name]));
      const asName = report([
        { role: "call", call_id: "r9-5", marker, at_ms: 1 },
        { role: "output", call_id: "r9-5", marker, at_ms: 2, result: "success", evidence: { [name]: 1 } },
      ]);
      const back = `${stored(fx)}\n${decoded(fx)}`;
      // THE EXPECTATION NO LONGER ASKS THE CODE WHAT IT REFUSES. A declared name
      // is admissible only if it is one of the journal's own — which none of
      // these is, however it is spelled.
      const admissible = names.includes(name);
      if (!admissible && asName.status === 201) escaped.push(`${label} ${shape}, as a KEY (accepted)`);
      else if (!admissible && back.includes(name.slice(0, 24))) escaped.push(`${label} ${shape}, as a KEY (stored anyway)`);
      fx.db.close();
    }

    // AS A VALUE, under every admissible name: round 8's property, re-executed
    // here because a fix to the key rule that reopened the value rule would
    // otherwise pass unnoticed.
    for (const name of names) {
      const g = fixture(contractWith([...names]), "r9-sweep-v");
      const asValue = g.report([
        { role: "call", call_id: "r9-6", marker: g.marker, at_ms: 1 },
        { role: "output", call_id: "r9-6", marker: g.marker, at_ms: 2, result: "success", evidence: { [name]: text } },
      ]);
      const b = `${stored(g.fx)}\n${decoded(g.fx)}`;
      if (asValue.status === 201) escaped.push(`${label} as a VALUE under ${name} (accepted)`);
      else if (b.includes(text.slice(0, 24))) escaped.push(`${label} as a VALUE under ${name} (stored anyway)`);
      g.fx.db.close();
    }
  }
  for (const e of escaped) console.log(`  ESCAPED: ${e}`);
  assert.deepEqual(escaped, [], "author text reached observed_records.evidence, as a key or as a value");
});
