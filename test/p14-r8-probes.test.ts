// ROUND 8 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks come from the
// STATEMENT OF THE REQUIREMENT, are committed first, and must FAIL on the code
// as it stands. A probe written after the fix cannot discriminate — it was
// shaped by the answer. Its failure at the red commit is the proof, and that
// failure is recorded in the red commit's own message.
//
// THE THREE THINGS ROUND 7 LEFT OPEN, EACH INSIDE THE D-21 THREAT MODEL — the
// adversary is a fleet agent that controls its OWN requests through the shipped
// API and the CONTENT of its own `evidence`, and controls nothing of the
// registry.
//
//   8.1 THE VALUE GRAMMAR IS RECURSIVE, SO THE BOUND IS PER LEVEL AND NOT ON
//       THE VALUE. `isAdmissibleEvidenceValue` calls itself for every element
//       of a list, so `EVIDENCE_LIST_MAX` bounds each LEVEL of a tree and
//       nothing bounds the tree. A reviewer put a transcript and a secret
//       through the shipped `/v1/observations` surface encoded as NESTED
//       ARRAYS OF BYTES under the base name `exit_code`: 201, stored in
//       `observed_records.evidence`, recoverable byte for byte. A closed set of
//       names over a grammar that nests is a transcript store with a vocabulary
//       — the same defect as round 7's, one level of the grammar down.
//
//       THE ANSWER IS A LIST OF SCALARS AND NOT A LIST OF LISTS, and the bound
//       is on the WHOLE VALUE. The probes below therefore ask the universal
//       question — is there ANY depth that is admitted — and not the particular
//       one, because "two is refused" is a fix for a probe and not for a class.
//
//   8.2 A LITERAL THE SIGNED CONTRACT NAMES IS AN AUTHOR-CONTROLLED TEXT
//       CHANNEL. The value grammar admits, as a string, any literal the signed
//       `check` names. The AUTHOR of a skill is a fleet agent too: it puts its
//       text in `check.command` or `check.artifact_path`, signs it, and its own
//       run echoes it back into `observed_records.evidence` word for word. Both
//       were 201 and both were stored.
//
//       THE ANSWER IS A COMPARISON OF DIGESTS. A run presents the DIGEST of the
//       parameter, the registry computes the digest of the SIGNED parameter and
//       compares the two. The check decides exactly what it decided before and
//       the author's words never enter the journal — so the enumeration of
//       admissible literals stops being needed at all, and a permitting set
//       nobody consults is a hole waiting to be re-entered.
//
//   8.3 TWO STATEMENTS ABOUT A SECURITY PROPERTY ARE FALSE IN THE SHIPPED
//       FILES. `src/mcp.ts` tells a user of `observation.report` that free text
//       is refused "under EVERY name"; `migrations/0010` tells a reader that
//       the text of a record "does not reach this schema". Both are shipped by
//       `npm pack` and both are defeated by 8.1 and 8.2. Under D-20 a false
//       statement about a security property is a blocker on its own.
//
//       These probes do not check that a sentence was edited. They EXECUTE the
//       claim: every admissible name, from the code, swept with every shape of
//       text an agent can build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import * as outcomeNamespace from "../src/outcome.ts";
import * as activationNamespace from "../src/activation.ts";
import { EVIDENCE_LIST_MAX, EVIDENCE_NAMES, OUTCOME_CHECK_SHAPE, evaluateOutcome } from "../src/outcome.ts";
import { arrivalMarker } from "../src/marker.ts";
import { validateManifest } from "../src/manifest.ts";
import { p4Fixture, reviewedVersion, rest, type P4Fixture } from "./p6-helpers.ts";
import { makeManifest } from "./p2-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const outcome = outcomeNamespace as unknown as Record<string, unknown>;
const activation = activationNamespace as unknown as Record<string, unknown>;

/** Name a thing that does not exist yet WITHOUT taking the file down with a
 *  module error: a missing export must read as one sentence, not twenty. */
function required<T>(mod: Record<string, unknown>, name: string, what: string): T {
  const v = mod[name];
  assert.ok(v !== undefined, `\`${name}\` is not exported by the module under probe — ${what}`);
  return v as T;
}

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a temporary directory that is already gone is the wanted state */
    }
  }
});

/** THE GRAMMAR, ASKED THE WAY ROUND 8 REQUIRES IT TO BE ASKABLE: a value, and
 *  nothing else. An enumeration parameter IS the second channel 8.2 closes, so
 *  a probe that passed one would be conceding the point it is here to make. */
function grammar(): (value: unknown) => boolean {
  return required(
    outcome,
    "isAdmissibleEvidenceValue",
    "8.1 and 8.2 require ONE definition of what a named value may be, taking the value alone",
  );
}

/** The digest of a signed parameter, computed HERE rather than borrowed from
 *  the module under probe: a check that compares the module's answer with the
 *  module's own arithmetic proves only that it is consistent with itself. */
function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const DIGEST = "sha256:9f2c4d0e1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

/** A secret-SHAPED marker and a whole transcript. Neither is a real credential;
 *  both are the shapes a reviewer actually got through the shipped surface. */
const SECRET_VALUE = "sk-live-skln-r8-not-a-real-credential-4b71ce";
const TRANSCRIPT_VALUE =
  "the operator pasted the deploy key and the assistant repeated it back, and then the whole session went on for another hour";

// ===========================================================================
// 8.1 — NO DEPTH OF NESTING, AND THE BOUND IS ON THE WHOLE VALUE
// ===========================================================================

/** `leaf` wrapped in `depth` arrays. `depth: 0` is the bare scalar. */
function nest(depth: number, leaf: unknown): unknown {
  let v: unknown = leaf;
  for (let i = 0; i < depth; i += 1) v = [v];
  return v;
}

/** How many scalars a value carries, however it is shaped. The bound round 8
 *  requires is on THIS number and not on the width of one level. */
function leaves(value: unknown): number {
  if (!Array.isArray(value)) return 1;
  let n = 0;
  for (const v of value) n += leaves(v);
  return n;
}

/** `total` scalars, arranged as a balanced tree of the given depth. */
function tree(total: number, depth: number): unknown {
  let level: unknown[] = Array.from({ length: total }, (_, i) => i);
  for (let d = 1; d < depth; d += 1) {
    const width = Math.max(1, Math.ceil(level.length / EVIDENCE_LIST_MAX));
    const next: unknown[] = [];
    for (let i = 0; i < level.length; i += width) next.push(level.slice(i, i + width));
    level = next;
  }
  return level;
}

test("[8.1] NO depth of nesting is admitted — the question is asked of EVERY depth, not of one", () => {
  const admissible = grammar();

  // THE UNIVERSAL FORM. `EVIDENCE_LIST_MAX` bounds a level; if the grammar
  // recurses, EVERY depth is admissible and each level may be full, so the
  // value is unbounded. The claim under test is not "two is refused" — it is
  // "one is the greatest depth there is".
  const admitted: number[] = [];
  for (let depth = 0; depth <= 16; depth += 1) {
    const got = admissible(nest(depth, 0));
    if (got) admitted.push(depth);
  }
  console.log(`[8.1] depths of nesting the grammar admits: ${admitted.join(", ") || "(none)"}`);
  assert.deepEqual(
    admitted,
    [0, 1],
    "the grammar admits a depth beyond a flat list of scalars, so the bound is per LEVEL and the value itself is unbounded",
  );

  // …AND FOR EVERY KIND OF LEAF, because a grammar that recurses on integers
  // and not on digests would be refused by the sweep above and still open.
  const nested: string[] = [];
  for (const [label, leaf] of [
    ["an integer", 7],
    ["a boolean", true],
    ["a digest", DIGEST],
  ] as Array<[string, unknown]>) {
    for (let depth = 2; depth <= 8; depth += 1) {
      if (admissible(nest(depth, leaf))) nested.push(`${label} at depth ${depth}`);
    }
  }
  console.log(`[8.1] nested shapes admitted: ${nested.length}`);
  assert.deepEqual(nested, [], "a list of lists was admitted, so a value is a tree and a tree holds a transcript");

  // MIXED SHAPES, which a depth sweep alone would miss: a flat list with ONE
  // nested element is still a tree.
  for (const [label, v] of [
    ["a flat list with one nested element", [0, [1]]],
    ["a list of pairs", [[0, 1], [2, 3]]],
    ["a list holding an empty list", [[]]],
    ["a list holding an object", [{ a: 1 }]],
  ] as Array<[string, unknown]>) {
    console.log(`  ${label.padEnd(38)} → ${admissible(v)}`);
    assert.equal(admissible(v), false, `${label} was admitted`);
  }
});

test("[8.1] the bound is on the WHOLE VALUE — no shape carries more scalars than the list bound", () => {
  const admissible = grammar();

  // THE FLAT CASE, which fixes the number the bound is about.
  assert.equal(admissible(Array.from({ length: EVIDENCE_LIST_MAX }, () => 0)), true, "a full flat list was refused");
  assert.equal(admissible(Array.from({ length: EVIDENCE_LIST_MAX + 1 }, () => 0)), false, "a list one over the bound was admitted");

  // AND THE UNIVERSAL ONE: for every arrangement of more scalars than the
  // bound allows, at every depth, the grammar must refuse. This is what "the
  // bound is on the tree" MEANS, stated as a sweep rather than as a sentence.
  const escaped: string[] = [];
  for (const total of [EVIDENCE_LIST_MAX + 1, 64, 256, 1024]) {
    for (let depth = 1; depth <= 5; depth += 1) {
      const v = tree(total, depth);
      const carried = leaves(v);
      if (admissible(v)) escaped.push(`${carried} scalars arranged at depth ${depth}`);
    }
  }
  for (const e of escaped) console.log(`  ADMITTED: ${e}`);
  assert.deepEqual(escaped, [], "a value carrying more scalars than the bound allows was admitted by being reshaped");
});

// ===========================================================================
// 8.1 — THROUGH THE SHIPPED SURFACE, AND READ BACK OUT OF THE DATABASE
// ===========================================================================

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

function fixture(contract: unknown = DECLARED_CONTRACT, slug = "r8-probe"): Fixture {
  const fx = p4Fixture();
  const version = reviewedVersion(fx, slug, { manifest: { outcome_contract: contract } });
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

/** Every byte this database holds in the columns a report can reach. */
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
 *  would perform to get its transcript back. */
function decoded(fx: P4Fixture): string {
  const codes = [...stored(fx).matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  return String.fromCharCode(...codes.filter((n) => Number.isInteger(n) && n >= 0 && n <= 0x10ffff));
}

/** A text encoded the way the reviewer encoded it: bytes, in chunks, nested. */
function asNestedBytes(text: string, chunk = 8): number[][] {
  const codes = [...text].map((c) => c.codePointAt(0) ?? 0);
  const out: number[][] = [];
  for (let i = 0; i < codes.length; i += chunk) out.push(codes.slice(i, i + chunk));
  return out;
}

test("[8.1] a transcript and a secret encoded as NESTED BYTE ARRAYS are refused, and the DATABASE shows nothing", () => {
  for (const [label, evidence] of [
    ["a transcript as nested bytes under the base name `exit_code`", { exit_code: asNestedBytes(TRANSCRIPT_VALUE) }],
    ["a secret as nested bytes under `exit_code`", { exit_code: asNestedBytes(SECRET_VALUE) }],
    // …and under a name the CONTRACT declared, which since round 9b is refused
    // for the name as well as for the tree — both refusals are the point, and a
    // report that gets past one meets the other.
    ["a secret as nested bytes under the contract's own name", { exit_code: 0, suite_digest: asNestedBytes(SECRET_VALUE) }],
    ["a secret as nested bytes under another base name", { artifacts: asNestedBytes(SECRET_VALUE) }],
    ["a transcript nested three deep", { exit_code: [asNestedBytes(TRANSCRIPT_VALUE, 4)] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const { fx, marker, report } = fixture();
    const planted = report([
      { role: "call", call_id: "r8-1", marker, at_ms: 1 },
      { role: "output", call_id: "r8-1", marker, at_ms: 2, result: "success", evidence },
    ]);
    console.log(`  ${label.padEnd(60)} → ${planted.status} ${planted.raw.slice(0, 70)}`);
    assert.notEqual(planted.status, 201, `${label} was accepted: the bound is per level and a tree is unbounded`);
    assert.match(planted.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal");

    // THE READ THAT MATTERS IS THE DATABASE, AND IT IS READ THE WAY THE
    // ATTACKER WOULD READ IT. Bytes are text; a journal that holds the codes
    // holds the transcript, and a `SELECT` that only looks for letters would
    // report the attack as prevented while the material sat in the column.
    const back = decoded(fx);
    for (const forbidden of [SECRET_VALUE, TRANSCRIPT_VALUE, "the deploy key"]) {
      assert.equal(
        back.includes(forbidden),
        false,
        `\`${forbidden.slice(0, 24)}…\` is recoverable byte for byte out of observed_records.evidence`,
      );
      assert.equal(stored(fx).includes(forbidden), false, `\`${forbidden.slice(0, 24)}…\` was written verbatim`);
    }
    assert.equal(planted.raw.includes(SECRET_VALUE), false, "the refusal echoed the value it refused [I-7]");
    fx.db.close();
  }
});

test("[8.1] a scalar, a digest and a FLAT list of scalars still pass, and are stored", () => {
  const { fx, marker, report } = fixture();
  // THE CARRIER IS A BASE NAME AND NO LONGER THE CONTRACT'S OWN `suite_digest`.
  // Round 9b removed the widening of the name set by a signed declaration, so a
  // declared name is refused HERE — which would make this positive control pass
  // for a reason that has nothing to do with the value grammar it is about.
  const accepted = report([
    { role: "call", call_id: "r8-ok", marker, at_ms: 1 },
    {
      role: "output",
      call_id: "r8-ok",
      marker,
      at_ms: 2,
      result: "success",
      evidence: { exit_code: 0, artifacts: [DIGEST, DIGEST] },
    },
  ]);
  console.log(`  an integer and a flat list of digests → ${accepted.status} ${accepted.raw.slice(0, 70)}`);
  assert.equal(accepted.status, 201, "a legitimate flat list was refused, so every refusal above is vacuous");
  assert.ok(stored(fx).includes(DIGEST), "an admitted digest was not stored");
  fx.db.close();

  const admissible = grammar();
  for (const [label, v, expected] of [
    ["an integer", 0, true],
    ["a negative integer", -1, true],
    ["a boolean", true, true],
    ["a digest", DIGEST, true],
    ["a flat list of digests", [DIGEST, DIGEST], true],
    ["a flat list of integers", [1, 2, 3], true],
    ["the empty list", [], true],
    ["a bare word", "ok", false],
    ["a secret", SECRET_VALUE, false],
    ["a transcript", TRANSCRIPT_VALUE, false],
    ["a digest with a tail", `${DIGEST} and then some prose`, false],
    ["a fraction", 0.5, false],
    ["an object", { a: 1 }, false],
    ["null", null, false],
  ] as Array<[string, unknown, boolean]>) {
    const got = admissible(v);
    console.log(`  ${label.padEnd(26)} → ${got}`);
    assert.equal(got, expected, `the value grammar answers ${got} for ${label}`);
  }
});

// ===========================================================================
// 8.2 — THE ECHO OF A SIGNED LITERAL IS AN AUTHOR-CONTROLLED TEXT CHANNEL
// ===========================================================================

/** The author's text, inside the signature, in the two parameters a check
 *  compares against. Both fit the schema: `command` and `artifact_path` are
 *  strings of up to 400 characters. */
const PROSE_COMMAND = `echo the operator pasted ${SECRET_VALUE} and the run went on`;
const PROSE_PATH = `out/the operator pasted ${SECRET_VALUE} and the run went on.txt`;

function commandContract(command: string) {
  return {
    check: { kind: "command", command },
    evidence: ["command", "exit_code"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
}

function artifactContract(path: string) {
  return {
    check: { kind: "artifact_exists", artifact_path: path },
    evidence: ["artifacts"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
}

test("[8.2] author text in a SIGNED `command` or `artifact_path` cannot reach the journal by echo", () => {
  for (const [label, contract, evidence] of [
    ["a signed `command` of prose, echoed back", commandContract(PROSE_COMMAND), { command: PROSE_COMMAND, exit_code: 0 }],
    ["a signed `artifact_path` of prose, echoed back", artifactContract(PROSE_PATH), { artifacts: [PROSE_PATH] }],
  ] as Array<[string, unknown, Record<string, unknown>]>) {
    const { fx, marker, report } = fixture(contract, "r8-echo");
    const planted = report([
      { role: "call", call_id: "r8-2", marker, at_ms: 1 },
      { role: "output", call_id: "r8-2", marker, at_ms: 2, result: "success", evidence },
    ]);
    console.log(`  ${label.padEnd(48)} → ${planted.status} ${planted.raw.slice(0, 70)}`);
    assert.notEqual(planted.status, 201, `${label} was accepted: an author is a fleet agent and this is its text channel`);
    assert.match(planted.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal");
    const kept = stored(fx);
    assert.equal(kept.includes(SECRET_VALUE), false, "the author's text was written to observed_records.evidence verbatim");
    assert.equal(kept.includes("the operator pasted"), false, "the author's text was written to observed_records.evidence verbatim");
    fx.db.close();
  }
});

test("[8.2] the check still DECIDES, in both directions, on a digest of the signed parameter", () => {
  const digestOf = required<(text: string) => string>(
    outcome,
    "evidenceDigestOf",
    "8.2 requires the registry to compare the digest of a presented value with the digest it computes from the SIGNED parameter, so " +
      "that one function must exist and must be the one both the check and the registry's own reading use",
  );
  assert.equal(digestOf("./verify.sh"), sha256("./verify.sh"), "the module's digest is not the SHA-256 of the parameter's bytes");

  // BOTH HALVES, because a check that always answers `unknown` would satisfy
  // the refusals above while deciding nothing at all.
  const contract = commandContract("./verify.sh");
  const yes = evaluateOutcome(contract, { command: sha256("./verify.sh"), exit_code: 0 });
  const no = evaluateOutcome(contract, { command: sha256("./verify.sh"), exit_code: 1 });
  const other = evaluateOutcome(contract, { command: sha256("./something-else.sh"), exit_code: 0 });
  console.log(`  the contract's command, exit 0 → ${yes.value} (${yes.reason})`);
  console.log(`  the contract's command, exit 1 → ${no.value} (${no.reason})`);
  console.log(`  another command entirely       → ${other.value} (${other.reason})`);
  assert.equal(yes.value, "yes", "a satisfied `command` check no longer decides");
  assert.equal(no.value, "no", "a `command` check that fails no longer decides");
  assert.equal(other.value, "unknown", "the exit code of some OTHER command was accepted as this contract's");

  // …AND THE SAME AT THE SHIPPED BOUNDARY: the digest form is admitted and
  // stored, or the rule above is one no reporter could ever satisfy.
  const { fx, marker, report } = fixture(contract, "r8-digest");
  const accepted = report([
    { role: "call", call_id: "r8-3", marker, at_ms: 1 },
    {
      role: "output",
      call_id: "r8-3",
      marker,
      at_ms: 2,
      result: "success",
      evidence: { command: sha256("./verify.sh"), exit_code: 0 },
    },
  ]);
  console.log(`  the digest of the signed command, through /v1/observations → ${accepted.status} ${accepted.raw.slice(0, 70)}`);
  assert.equal(accepted.status, 201, "the digest form is refused, so a legitimate `command` report is now impossible");
  assert.ok(stored(fx).includes(sha256("./verify.sh")), "the admitted digest was not stored");
  fx.db.close();
});

test("[8.2] the registry's OWN reading of an artifact still decides, in both directions", () => {
  const look = required<(site: unknown, contract: unknown, placed: unknown) => unknown>(
    activation,
    "registryObservedEvidence",
    "the one producer of values marked as this registry's own must keep working under the digest comparison",
  );
  const assess = required<(input: unknown) => { value: string; reason: string; basis: string }>(outcome, "assessOutcome", "§4's verdict");
  const rel = ".agents/skills/probe/SKILL.md";
  const contract = artifactContract(rel);
  const placed = { target: "codex", native_relpath: rel, managed_copy: "written" };

  const there = temp("skln-r8-root-");
  mkdirSync(join(there, dirname(rel)), { recursive: true });
  writeFileSync(join(there, rel), "# probe\n");
  const gone = temp("skln-r8-gone-");
  mkdirSync(join(gone, dirname(rel)), { recursive: true });

  const present = assess({ contract, claimed: null, observed: look({ root: there, target: "codex" }, contract, placed), principal: { type: "agent" } });
  const absent = assess({ contract, claimed: null, observed: look({ root: gone, target: "codex" }, contract, placed), principal: { type: "agent" } });
  console.log(`  the copy is there → ${present.value} (${present.reason}) / ${present.basis}`);
  console.log(`  the copy is gone  → ${absent.value} (${absent.reason}) / ${absent.basis}`);
  assert.equal(present.value, "yes", "the one real `yes` in V-1 stopped being reachable");
  assert.equal(absent.value, "no", "the registry's honest `no` stopped being reachable");
  assert.equal(present.basis, "registry_observation");

  // …AND THE REGISTRY'S OWN VALUES ARE OF THE SAME GRAMMAR IT IMPOSES ON A
  // REPORT. Two grammars — one for the registry and one for everybody else —
  // is how the value channel would reopen the moment a second producer is
  // written, and it would put the path's text back in the journal today.
  const admissible = grammar();
  const own = look({ root: there, target: "codex" }, contract, placed) as Record<string, unknown>;
  console.log(`  the registry's own evidence: ${JSON.stringify(own)}`);
  for (const [name, value] of Object.entries(own)) {
    assert.equal(admissible(value), true, `the registry's own \`${name}\` is a value its own boundary would refuse`);
  }
});

test("[8.2] the enumeration of admissible literals is GONE, not merely unused", () => {
  // A DEAD PERMITTING SET IS A HOLE THAT HAS NOT BEEN WALKED THROUGH YET. Once
  // a check compares digests, no string but a digest is admissible, and a
  // function that still computes "the strings this contract permits" is an
  // argument waiting for a caller.
  assert.equal(outcome.contractLiterals, undefined, "`contractLiterals` still exists: a permitting set nobody consults");
  assert.equal(
    grammar().length,
    1,
    "the value grammar still takes an enumeration parameter, so a caller can still widen it by passing one",
  );

  // …and nothing in `src/` still speaks of one. The set is the DIRECTORY's, so
  // a second module reintroducing the idea fails here rather than in a review.
  const offenders: string[] = [];
  for (const file of readdirSync(join(REPO_ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
    if (/contractLiterals/.test(readFileSync(join(REPO_ROOT, "src", file), "utf8"))) offenders.push(`src/${file}`);
  }
  console.log(`[8.2] files under src/ still naming an enumeration of literals: ${offenders.join(", ") || "(none)"}`);
  assert.deepEqual(offenders, [], "a source file still names the enumeration of admissible literals");
});

// ===========================================================================
// 8.3 — THE TWO STATEMENTS IN THE SHIPPED FILES ARE EXECUTED, NOT READ
// ===========================================================================

/** The files `npm pack` ships that make a claim about this channel. */
const SHIPPED_CLAIMS = ["src/mcp.ts", "migrations/0010_evidence_on_the_observed_record.sql"];
/** …and the specification, which is the document an independent implementation
 *  is built from and must not describe a rule this registry does not have. */
const CLAIM_SURFACES = [...SHIPPED_CLAIMS, "SPEC.md"];

test("[8.3] `free text under EVERY name` is executed over the WHOLE admissible set, taken from the code", () => {
  // THE SET IS THE CODE'S. `EVIDENCE_NAMES` is derived in `src/outcome.ts` from
  // the check table; the contract adds its own. Sweeping a literal list here
  // would be a guard that agrees with itself.
  const declared = ["suite_digest", "coverage"];
  const contract = {
    check: { kind: "exit_code", exit_code: 0 },
    evidence: [...EVIDENCE_NAMES, ...declared],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
  const names = [...new Set([...EVIDENCE_NAMES, ...declared])];
  console.log(`[8.3] admissible names swept: ${names.join(", ")}`);
  assert.ok(names.length >= 4, "the admissible set is empty, so the sweep proves nothing");

  const shapes: Array<[string, unknown]> = [
    ["a bare word", "ok"],
    ["a secret", SECRET_VALUE],
    ["a transcript", TRANSCRIPT_VALUE],
    ["a transcript one word at a time", TRANSCRIPT_VALUE.split(" ")],
    ["a transcript as nested bytes", asNestedBytes(TRANSCRIPT_VALUE)],
    ["a transcript as an object", { text: TRANSCRIPT_VALUE }],
  ];

  const escaped: string[] = [];
  for (const name of names) {
    for (const [label, value] of shapes) {
      const { fx, marker, report } = fixture(contract, "r8-sweep");
      const planted = report([
        { role: "call", call_id: "r8-4", marker, at_ms: 1 },
        { role: "output", call_id: "r8-4", marker, at_ms: 2, result: "success", evidence: { [name]: value } },
      ]);
      const back = `${stored(fx)}\n${decoded(fx)}`;
      if (planted.status === 201) escaped.push(`${name} ← ${label} (accepted)`);
      else if (back.includes(SECRET_VALUE) || back.includes("the operator pasted")) escaped.push(`${name} ← ${label} (stored anyway)`);
      fx.db.close();
    }
  }
  for (const e of escaped) console.log(`  ESCAPED: ${e}`);
  assert.deepEqual(escaped, [], "free text reached the journal under a name, so `under EVERY name` is a false statement in a shipped file");
});

test("[8.3] no shipped file describes a value grammar the code does not have", () => {
  // THE DOCUMENT'S OWN SENTENCES ABOUT WHAT A NAMED VALUE MAY BE, read out of
  // the file and compared with what the boundary enforces. A statement about a
  // security property that the code defeats is a blocker on its own [D-20].
  const found: Array<[string, string]> = [];
  for (const rel of CLAIM_SURFACES) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\s+/g, " ");
    for (const m of text.matchAll(/[^.]*\bnamed value is\b[^.]*\./g)) found.push([rel, m[0].trim()]);
    for (const m of text.matchAll(/[^.]*\bVALUES:[^.]*\./g)) found.push([rel, m[0].trim()]);
  }
  for (const [rel, s] of found) console.log(`  ${rel}: ${s.slice(0, 150)}`);
  for (const rel of CLAIM_SURFACES) {
    assert.ok(found.some(([f]) => f === rel), `${rel} says nothing about what a named value may be, so this guard has no subject there`);
  }

  // A LITERAL THE SIGNED CHECK NAMES IS NO LONGER ONE OF THE THINGS A VALUE MAY
  // BE. Any file still offering one is offering an author-controlled text
  // channel that the boundary refuses.
  const lying = found.filter(([, s]) => /\bliterals?\b/i.test(s)).map(([rel, s]) => `${rel}: ${s.slice(0, 120)}`);
  for (const l of lying) console.log(`  LYING: ${l}`);
  assert.deepEqual(lying, [], "a shipped file still offers `a literal the signed check names` as an admissible value");

  // …AND EVERY ONE OF THEM SAYS THE THING THAT IS TRUE: nesting is refused.
  const silent = found.filter(([, s]) => !/nest/i.test(s)).map(([rel]) => rel);
  console.log(`  passages that do not mention nesting: ${silent.join(", ") || "(none)"}`);
  assert.deepEqual([...new Set(silent)], [], "a passage describing the value grammar does not say that no depth of nesting is admitted");

  // …AND THE NUMBER THEY PRINT IS THE CODE'S. A bound written out in prose is a
  // second copy of `EVIDENCE_LIST_MAX`, free to drift the day it changes; the
  // passage is compared with the constant rather than with a number typed here.
  const wrong = found
    .filter(([, s]) => /\bat most\b/i.test(s) && !s.includes(String(EVIDENCE_LIST_MAX)))
    .map(([rel, s]) => `${rel}: ${s.slice(0, 120)}`);
  for (const w of wrong) console.log(`  DRIFTED: ${w}`);
  assert.deepEqual(wrong, [], "a passage states a bound on a list that is not the bound the code enforces");
});

test("[8.3→9] NO channel into this column is described as open, and the FORM of a name is stated with the bound the schema enforces", () => {
  // THIS PROBE USED TO REQUIRE THE OPPOSITE, and the reversal is the point.
  //
  // Round 8 found a third channel and did not close it: a declared name is a
  // string the AUTHOR wrote, stored in `observed_records.evidence` as a JSON
  // KEY, and the schema bounded it at 20 names of 80 characters — 1600
  // characters of author text by the shipped route. While that was true, a
  // shipped file that described this column's channels and omitted that one was
  // making a false statement about a security property, so this probe DEMANDED
  // the sentence.
  //
  // Round 9 narrowed the FORM: a declared name is an identifier. The sentence
  // this probe used to require is now false in the other direction — it would
  // advertise a way through that no longer exists — so the requirement inverts:
  // no shipped file may describe a channel into this column as open, and every
  // one of them must state the form that closed it, with the bound taken from
  // the schema rather than typed into prose.
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schema/skill-package-v1.schema.json"), "utf8"));
  const declared = schema.properties?.outcome_contract?.properties?.evidence;
  assert.ok(declared, "the schema no longer shapes `outcome_contract.evidence`, so this bound has no source");
  const maxNames: number = declared.maxItems;
  const maxLength: number = declared.items.maxLength;
  const pattern: string = declared.items.pattern;
  console.log(`[8.3→9] a signed contract may declare ${maxNames} names of up to ${maxLength} characters, each matching ${pattern}`);
  assert.ok(typeof pattern === "string" && pattern.length > 0, "the schema puts no FORM on a declared name, so the channel is open");

  // THE BOUND IS REAL AND NOT ASPIRATIONAL — the packing schema refuses every
  // way past it, so what a shipped file states is what an author can spend.
  const contractWith = (evidence: string[]) => ({
    check: { kind: "exit_code", exit_code: 0 },
    evidence,
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  });
  const ok = validateManifest(makeManifest({ outcome_contract: contractWith(["exit_code"]) }));
  const tooMany = validateManifest(makeManifest({ outcome_contract: contractWith(Array.from({ length: maxNames + 1 }, (_, i) => `n${i}`)) }));
  const tooLong = validateManifest(makeManifest({ outcome_contract: contractWith(["exit_code", "n".repeat(maxLength + 1)]) }));
  const prose = validateManifest(makeManifest({ outcome_contract: contractWith(["exit_code", "the operator pasted the key"]) }));
  console.log(`  one name → ${ok.valid};  ${maxNames + 1} names → ${tooMany.valid};  a name of ${maxLength + 1} → ${tooLong.valid};  a sentence → ${prose.valid}`);
  assert.equal(ok.valid, true, "a contract declaring one name was refused, so the refusals below are vacuous");
  assert.equal(tooMany.valid, false, "a contract may declare more names than the schema says, so the bound is not a bound");
  assert.equal(tooLong.valid, false, "a declared name may be longer than the schema says, so the bound is not a bound");
  assert.equal(prose.valid, false, "a declared name may be a sentence, so the name channel is still open");

  // NO SHIPPED FILE SAYS A CHANNEL INTO THIS COLUMN IS OPEN. The phrases are
  // the ones the files used while it was, so the sentence that has to go is
  // found by what it SAYS and not by where it sits.
  const advertising: string[] = [];
  const silent: string[] = [];
  for (const rel of CLAIM_SURFACES) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\s+/g, " ");
    for (const re of [
      /[^.]*\bchannel that is open\b[^.]*\./gi,
      /[^.]*\bstill open\b[^.]*\./gi,
      /[^.]*\bbounded (?:rather than|and not) closed\b[^.]*\./gi,
      /[^.]*\bthis (?:version|registry) does not close\b[^.]*\./gi,
      /[^.]*\bhas not closed\b[^.]*\./gi,
      /[^.]*\b1600\b[^.]*\./g,
    ]) {
      for (const m of text.matchAll(re)) advertising.push(`${rel}: ${m[0].trim().slice(0, 140)}`);
    }
    // …AND EVERY ONE OF THEM STATES THE FORM THAT CLOSED IT, with the schema's
    // own bound, so widening the schema breaks the sentence rather than quietly
    // enlarging what an author may write into a key.
    const statesIt = new RegExp(`\\b${maxLength}\\b`).test(text) && /\bidentifier\b/i.test(text);
    console.log(`  ${rel.padEnd(48)} states the ${maxLength}-character identifier form: ${statesIt}`);
    if (!statesIt) silent.push(rel);
  }
  for (const a of advertising) console.log(`  ADVERTISING: ${a}`);
  assert.deepEqual(
    advertising,
    [],
    "a shipped file still describes a channel into `observed_records.evidence` as open when it is closed: a false statement about " +
      "a security property is the class of defect [D-20] blocks on, and it is one whichever direction it is false in",
  );
  assert.deepEqual(
    silent,
    [],
    "a shipped file describes this column's channels without stating the FORM a declared name must take: the rule that closes the " +
      "name channel is the one a reader most needs stated",
  );
});

test("[8.3] `the text of a record does not reach this schema` is executed against the schema itself", () => {
  // THE MIGRATION'S CLAIM, TESTED WHERE IT IS MADE: after every shape of attack
  // this round knows, the column holds nothing that decodes to the material.
  const claim = readFileSync(join(REPO_ROOT, "migrations/0010_evidence_on_the_observed_record.sql"), "utf8");
  assert.match(claim, /TEXT OF A RECORD DOES NOT REACH THIS SCHEMA/, "the migration no longer makes the claim this probe executes");

  const { fx, marker, report } = fixture(commandContract(PROSE_COMMAND), "r8-schema");
  for (const [i, evidence] of [
    { command: PROSE_COMMAND, exit_code: 0 },
    { exit_code: asNestedBytes(PROSE_COMMAND) },
    { command: TRANSCRIPT_VALUE, exit_code: 0 },
  ].entries()) {
    const planted = report([
      { role: "call", call_id: `r8-5-${i}`, marker, at_ms: 1 },
      { role: "output", call_id: `r8-5-${i}`, marker, at_ms: 2, result: "success", evidence },
    ]);
    console.log(`  attack ${i} → ${planted.status}`);
    assert.notEqual(planted.status, 201, `attack ${i} was accepted`);
  }
  const back = `${stored(fx)}\n${decoded(fx)}`;
  assert.equal(back.includes(SECRET_VALUE), false, "the column holds the secret");
  assert.equal(back.includes("the operator pasted"), false, "the column holds the author's text");
  assert.equal(back.includes("the deploy key"), false, "the column holds the transcript");
  fx.db.close();
});

test("[8.2] EVERY kind whose signed parameter is text compares a DIGEST of it — swept over the table", () => {
  // THE SET IS THE TABLE'S, so a fifth kind that starts comparing an author's
  // string is swept the day it is added rather than the day somebody notices.
  // A field still called `echoes` would name a mechanism this registry no
  // longer has, which is the round-7 defect committed inside the round-7 fix.
  const kinds = Object.entries(OUTCOME_CHECK_SHAPE);
  const stale = kinds.filter(([, s]) => "echoes" in (s as unknown as Record<string, unknown>)).map(([k]) => k);
  console.log(`[8.2] kinds whose table entry still says \`echoes\`: ${stale.join(", ") || "(none)"}`);
  assert.deepEqual(stale, [], "the check table still names an echo, and nothing is echoed any more");

  const admissible = grammar();
  const compared = kinds
    .map(([kind, shape]) => [kind, shape, (shape as unknown as { digest_of?: string | null }).digest_of] as const)
    .filter(([, , param]) => typeof param === "string" && param.length > 0);
  console.log(`[8.2] kinds comparing the digest of a signed parameter: ${compared.map(([k]) => k).join(", ") || "(none)"}`);
  assert.ok(
    compared.length > 0,
    "no kind declares a signed parameter whose DIGEST it compares, so either the table lost the fact or the sweep has no subject",
  );

  const escaped: string[] = [];
  for (const [kind, shape, param] of compared) {
    const literal = param === "artifact_path" ? "out/report.json" : "./verify.sh";
    const contract = {
      check: { kind, [param as string]: literal },
      evidence: [shape.evidence],
      unknown: "no evaluated run of this skill was reported, which is not a failure of it",
    };
    // THE CHANNEL A PRESENTED VALUE GOES INTO, read off `reads`: the one thing
    // this kind reads that is not the process's exit code. Both the scalar and
    // the list form are offered, because which of the two a kind wants is the
    // kind's business and not this probe's.
    const channel = shape.reads.filter((r) => r !== "exit_code")[0] ?? shape.evidence;
    const forms = (v: unknown): Array<Record<string, unknown>> => [
      { exit_code: 0, [channel]: v },
      { exit_code: 0, [channel]: [v] },
    ];
    const onDigest = forms(sha256(literal)).map((e) => evaluateOutcome(contract, e).value);
    const onText = forms(literal).map((e) => evaluateOutcome(contract, e).value);
    console.log(`  ${kind.padEnd(16)} digest → ${onDigest.join("/")}   the text itself → ${onText.join("/")}`);
    if (!onDigest.includes("yes")) escaped.push(`${kind}: the digest of its own signed \`${param}\` decides nothing`);
    if (onText.some((v) => v !== "unknown")) escaped.push(`${kind}: the signed \`${param}\` presented as TEXT still decides`);
    if (admissible(literal)) escaped.push(`${kind}: the boundary still admits the signed \`${param}\` as a value`);
  }
  for (const e of escaped) console.log(`  ESCAPED: ${e}`);
  assert.deepEqual(escaped, [], "a check either stopped deciding or still decides on the author's text");
});
