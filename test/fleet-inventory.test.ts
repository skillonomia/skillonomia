// §6 PART A — proof of arrival: the fleet inventory, the six states and the
// scanner.
//
// THE CLASS OF DEFECT THIS FILE IS BUILT AGAINST is not "the code is wrong". It
// is A GUARD THAT PROVES SOMETHING OTHER THAN WHAT IT CLAIMS — a check over an
// empty set, a comparison of two values out of three, a fact column that reads
// the intent column, a count taken from what we decided rather than from what
// was seen. Every one of those passes a naive test suite.
//
// So the discipline here is: EVERY assertion that matters is paired with a
// MUTATION of the shipped source that must kill it. The mutation harness
// (`mutant` below) does not take the substitution on trust — it proves the
// template occurs EXACTLY ONCE, prints the line before and after, and compares
// the sha256 of the file's bytes. A mutation that did not take would otherwise
// leave the test asserting against the very code it claims to have broken.
//
// The groups, by what each refuses to let happen:
//
//   1. ONE TABLE OF STATES. §4's matrix is asymmetric — the two runtimes
//      publish DIFFERENT COLUMN SETS — and this file's first job is to keep it
//      that way.
//   2. `unknown` COLLAPSED INTO `no`. The single most damaging thing this work
//      can do is report "nothing was recorded" as "it did not happen" [A-0].
//   3. `invoked` FROM SOMETHING THAT IS NOT A PAIR [M-5], or from another
//      version's marker.
//   4. A NUMBER WITHOUT ITS METHOD [I-3].
//   5. AN UNDERCOUNT AT A SYMBOLIC LINK [I-4], which is how a fleet is
//      ordinarily handed one shared library.
//   6. DEAD WEIGHT COUNTED FROM INTENT [A-5].
//   7. A SCANNER THAT NEEDS THE ADDRESSEE'S FILESYSTEM [M-7].
//   8. A TOOL WHOSE HINTS LIE ABOUT WHAT IT TOUCHES [I-8], and a record's TEXT
//      surviving into a table [I-7].
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { p4Fixture, reviewedVersion, rest, mcp, type P4Fixture } from "./p6-helpers.ts";
import { OUTCOME_CHECK_KINDS, OUTCOME_CHECK_SHAPE, evidenceDigestOf, registryObserved, selfReported } from "../src/outcome.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { serve } from "../src/server.ts";
import { TRANSFER_ACTION } from "../src/transfer.ts";
import { arrivalMarker } from "../src/marker.ts";
import { correlationDigest } from "../src/journal.ts";
import { ulid } from "../src/ulid.ts";
import {
  CAPABILITY_KINDS,
  CAPABILITY_STATES,
  FLEET_RUNTIMES,
  NO_FLEET_OBSERVATIONS,
  capabilityColumns,
  columnsOf,
  countedNumber,
  deadWeightOf,
  explicitLoadedClaim,
  forbiddenNoClaim,
  gapOf,
  matrixCell,
  missingAttribute,
  missingVerdictAttribute,
  unverdicted,
  scanArrivals,
  stateOfColumn,
  syncStatusOf,
  type CapabilityEvidence,
  type FleetObservationSource,
  type ObservedRecord,
  type RegisteredCapability,
  type RuntimeSnapshot,
  type ScanSubject,
  type StateColumn,
} from "../src/fleet.ts";
import {
  FixedInventoryRoots,
  FixedTranscriptRoots,
  NO_INVENTORY_ROOTS,
  TranscriptObservations,
  inventoryUnder,
} from "../src/fleet-scan.ts";

// ===========================================================================
// The harness
// ===========================================================================

const temps: string[] = [];

/** A temporary tree. NOTHING in this file ever names a real runtime path. */
function tempBase(prefix = "skln-fleet-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return realpathSync(dir);
}

process.on("exit", () => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a test that already removed its own tree is not a failure
    }
  }
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A copy of `src/` with ONE substitution applied to ONE file, imported.
 *
 * THE HARNESS PROVES ITS OWN SUBSTITUTION, and that is the whole reason it is
 * written out rather than done with a one-line `replace`:
 *
 *   * the template must occur EXACTLY ONCE — zero means the mutation matched
 *     nothing and the test below is vacuous; more than one means it changed
 *     something the test did not intend;
 *   * the file's sha256 must MOVE — a substitution whose replacement equals its
 *     template is a no-op wearing the word "mutation";
 *   * the line before and the line after are PRINTED, so a reader of the output
 *     can see which code was broken rather than take it on trust.
 *
 * Only `src/marker.ts`, `src/fleet.ts` and `src/fleet-scan.ts` are mutated
 * here, and all three are deliberately shallow: `marker.ts` imports one type,
 * `fleet.ts` imports one module, `fleet-scan.ts` imports two. So the copied
 * graph that gets loaded is small and cannot drift from the shipped one in some
 * third file.
 *
 * `mutantIn` breaks the mutated file APART from the loaded one, because [M-5]'s
 * pairing rule now lives in `src/marker.ts` and is CALLED by `src/fleet.ts`.
 * That is the point of moving it — one rule, one implementation — and a harness
 * that could only mutate the file it loads could no longer break that rule from
 * §6's side and watch §6 answer wrongly.
 */
async function mutantIn(file: string, load: string, edits: Array<[from: string, to: string]>): Promise<any> {
  const dir = tempBase("skln-fleet-mutant-");
  cpSync(new URL("../src", import.meta.url), join(dir, "src"), { recursive: true });
  const path = join(dir, "src", file);
  const before = readFileSync(path, "utf8");
  const beforeSha = sha256(before);
  let text = before;
  for (const [from, to] of edits) {
    const occurrences = text.split(from).length - 1;
    assert.equal(occurrences, 1, `the mutation template must occur EXACTLY ONCE in ${file}, found ${occurrences}`);
    assert.notEqual(from, to, "a substitution whose replacement equals its template changes nothing");
    text = text.replace(from, to);
    console.log(`  before: ${from.split("\n")[0]!.trim()}`);
    console.log(`  after : ${to.split("\n")[0]!.trim()}`);
  }
  const afterSha = sha256(text);
  assert.notEqual(afterSha, beforeSha, `the substitution did not change the bytes of ${file}`);
  writeFileSync(path, text);
  console.log(`[mutation] ${file}  sha256 ${beforeSha.slice(0, 12)} → ${afterSha.slice(0, 12)} (loading ${load})`);
  return await import(pathToFileURL(join(dir, "src", load)).href);
}

/** The ordinary case: mutate a file and load that same file. */
async function mutant(file: string, ...edits: Array<[from: string, to: string]>): Promise<any> {
  return await mutantIn(file, file, edits);
}

/** Assert that `fn` throws or fails an assertion — the mutant must be killed. */
function killed(what: string, fn: () => void): void {
  let survived = false;
  try {
    fn();
    survived = true;
  } catch {
    // the mutant died, which is the point
  }
  assert.equal(survived, false, `THE MUTANT SURVIVED: ${what} — this test proves nothing`);
}

// --------------------------------------------------------------- fixtures

const AGENT = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const V1 = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const V2 = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const M1 = arrivalMarker(V1);
const M2 = arrivalMarker(V2);

function subject(id: string, executable = true): ScanSubject {
  return { skill_version_id: id, marker: arrivalMarker(id), has_executable_step: executable };
}

function record(over: Partial<ObservedRecord> = {}): ObservedRecord {
  return {
    agent_id: AGENT,
    runtime: "codex",
    role: "call",
    call_id: "c-1",
    at_ms: 1_754_000_000_000,
    marker: M1,
    result: "unknown",
    evidence: null,
    ...over,
  };
}

const CONTRACT_DIGEST = "sha256:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
const OTHER_DIGEST = "sha256:bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";

/** A whole contract, so a test that means "this version defines success" says
 *  WHAT success is instead of passing a boolean. */
const CONTRACT = {
  // 2.3: `stdout` is presented as a DIGEST — free text is not a value this
  // journal carries under any name — so a `stdout_match` names the digest it
  // expects and the check is an equality.
  check: { kind: "stdout_match", stdout_match: CONTRACT_DIGEST },
  evidence: ["stdout_sha256"],
  unknown: "no evaluated run of this skill was reported, which is not a failure of it",
};

function snapshot(records: ObservedRecord[], over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agent_id: AGENT,
    runtime: "codex",
    model: null,
    session_active: "unknown",
    last_activity_ms: null,
    window: "all_time",
    window_detail: "records supplied by the test harness, all time",
    proposal_inventory_complete: false,
    records,
    ...over,
  };
}

function evidence(over: Partial<CapabilityEvidence> = {}): CapabilityEvidence {
  return {
    runtime: "codex",
    subject: subject(V1),
    registered: { value: "yes", reason: null, window_detail: "a temporary tree built by the test harness" },
    intent: null,
    snapshot: null,
    outcome_contract: null,
    ...over,
  };
}

function cellOf(columns: readonly StateColumn[], name: string): StateColumn {
  const c = columns.find((x) => x.column === name);
  assert.ok(c, `no \`${name}\` column was published — an ABSENT cell is the one thing [I-1] forbids`);
  return c;
}

// ===========================================================================
// 1. §4'S MATRIX IS ASYMMETRIC, AND IT IS NOT ONE TABLE WITH FLAGS
// ===========================================================================

test("the two runtimes publish DIFFERENT COLUMN SETS — the asymmetry is structural, not a flag", () => {
  const claude = columnsOf("claude_code");
  const codex = columnsOf("codex");
  console.log(`[§4] claude_code columns: ${claude.join(", ")}`);
  console.log(`[§4] codex        columns: ${codex.join(", ")}`);

  // the difference is in the SHAPE of the answer, not in a value inside it
  assert.notDeepEqual([...claude], [...codex], "one column set for both runtimes IS the flag design §4 rules out");
  assert.ok(claude.includes("proposed_now") && claude.includes("proposed_historical"));
  assert.ok(!claude.includes("proposed"), "Claude Code must not also publish an undivided `proposed`");
  assert.ok(codex.includes("proposed"), "Codex publishes one `proposed`");
  assert.ok(
    !codex.includes("proposed_now") && !codex.includes("proposed_historical"),
    "Codex has no live/historical distinction to publish: there is no signal to divide",
  );

  // and every one of the six states appears in both sets, so nothing is silently
  // dropped rather than answered [I-1]
  for (const runtime of FLEET_RUNTIMES) {
    const states = new Set(columnsOf(runtime).map((c) => matrixCell(CAPABILITY_STATES[0], runtime) && c));
    for (const state of CAPABILITY_STATES) {
      const covered = columnsOf(runtime).some((c) => c === state || c.startsWith(`${state}_`));
      assert.ok(covered, `${runtime} publishes no column for the state \`${state}\``);
    }
    assert.ok(states.size > 0);
  }
});

test("§4's matrix says, as DATA, which cells can never answer `no` and which are never claimed", () => {
  // [A-0] and the `loaded` rule are properties of the table rather than of a
  // comment, so a later surface reading the table gets them for free.
  assert.equal(matrixCell("proposed", "codex").can_be_no, false, "[A-0]: Codex `proposed` must never answer `no`");
  assert.equal(matrixCell("loaded", "codex").can_be_no, false);
  assert.equal(matrixCell("loaded", "claude_code").can_be_no, false);
  assert.equal(matrixCell("invoked", "claude_code").can_be_no, false, "[M-5]: absence of a pair is not absence of a run");
  assert.equal(matrixCell("invoked", "codex").can_be_no, false);
  assert.equal(matrixCell("loaded", "claude_code").explicit, false, "`loaded` is reported, never claimed");
  assert.equal(matrixCell("loaded", "codex").explicit, false);

  // …and the cells that CAN say `no` are exactly the ones something establishes
  assert.equal(matrixCell("registered", "claude_code").can_be_no, true, "a walked disk can establish an absence");
  assert.equal(matrixCell("proposed", "claude_code").can_be_no, true, "a live session can enumerate what it was offered");
  assert.equal(matrixCell("outcome", "codex").can_be_no, true, "a contract that ran and failed is a `no`");

  // the observability classes differ where §4 says they differ
  assert.notEqual(
    matrixCell("proposed", "claude_code").observability,
    matrixCell("proposed", "codex").observability,
    "the `proposed` row is where the matrix is asymmetric; equal classes would erase it",
  );
  assert.equal(matrixCell("proposed", "codex").observability, "never_observable");
  assert.equal(matrixCell("proposed", "codex").source, "none");
});

// ===========================================================================
// 2. `unknown` IS NOT `no` — degenerate cases 1 and 7
// ===========================================================================

test("[A-0] DEGENERATE 1: Codex `proposed` and `loaded` are `unknown`, and a mutation to `no` is killed", async () => {
  // The evidence is stacked in favour of a `yes`/`no`: the agent reported a
  // LIVE session, claimed a COMPLETE inventory of what it was offered, and the
  // subject's marker is not in it. On Claude Code that combination is the one
  // honest `no` in the file. On Codex it must STILL be `unknown`, because the
  // runtime emits nothing to enumerate.
  const live = snapshot([], {
    runtime: "codex",
    window: "live_session",
    session_active: "yes",
    proposal_inventory_complete: true,
    window_detail: "a live session, and the agent listed everything it was offered",
  });
  const columns = capabilityColumns(evidence({ runtime: "codex", snapshot: live }));
  const proposed = cellOf(columns, "proposed");
  const loaded = cellOf(columns, "loaded");
  console.log(`[A-0] codex proposed=${proposed.value} (${proposed.reason}) loaded=${loaded.value} (${loaded.reason})`);
  assert.equal(proposed.value, "unknown");
  assert.equal(loaded.value, "unknown");
  assert.notEqual(proposed.value, "no", "[A-0] violated: an absent record was reported as an absent fact");
  assert.equal(proposed.reason, "runtime_emits_no_skill_inventory");
  assert.equal(forbiddenNoClaim(columns), null);

  // …and the SAME evidence on Claude Code does produce the honest `no`, so the
  // assertion above is not passing merely because nothing can ever be `no`
  const claude = capabilityColumns(
    evidence({ runtime: "claude_code", snapshot: { ...live, runtime: "claude_code" } }),
  );
  assert.equal(cellOf(claude, "proposed_now").value, "no", "a complete live inventory on Claude Code establishes `no`");

  // THE MUTATION. Make Codex's `proposed` answer `no` instead of `unknown`.
  const m = await mutant("fleet.ts", [
    `column("proposed", "proposed", runtime, "unknown", "runtime_emits_no_skill_inventory", "runtime", {`,
    `column("proposed", "proposed", runtime, "no", "runtime_emits_no_skill_inventory", "runtime", {`,
  ]);
  const mutated = m.capabilityColumns(evidence({ runtime: "codex", snapshot: live }));
  const mutatedCell = mutated.find((c: StateColumn) => c.column === "proposed");
  // the matrix guard inside `column` catches it even so — which is the point of
  // having the rule in the data — so the mutant's value is still `unknown`, and
  // the test proves the GUARD is what did that rather than the literal
  assert.equal(mutatedCell.value, "unknown", "the matrix guard must convert a forbidden `no` back to `unknown`");
  // now break the guard AS WELL AS the literal, and watch the answer become
  // `no` — which is what proves both are load-bearing rather than one of them
  const m2 = await mutant(
    "fleet.ts",
    [
      `column("proposed", "proposed", runtime, "unknown", "runtime_emits_no_skill_inventory", "runtime", {`,
      `column("proposed", "proposed", runtime, "no", "runtime_emits_no_skill_inventory", "runtime", {`,
    ],
    [
      `const safe: Trivalent = value === "no" && !m.can_be_no ? "unknown" : value;`,
      `const safe: Trivalent = value;`,
    ],
  );
  const unguarded = m2.capabilityColumns(evidence({ runtime: "codex", snapshot: live }));
  killed("[A-0] with the matrix guard removed, Codex `proposed` still refused to say `no`", () => {
    assert.equal(
      unguarded.find((c: StateColumn) => c.column === "proposed").value,
      "unknown",
      "[A-0] violated",
    );
  });
});

test("[A-3] DEGENERATE 7: `proposed_historical` answers `unknown` for a silent transcript, never `no`", async () => {
  // A STORED transcript that enumerated everything it saw. The signal survives
  // in roughly one transcript in fifty, so its silence establishes nothing —
  // and the report's own claim to completeness does not change that, because it
  // enumerates the transcripts and not what the agent was offered.
  const stored = snapshot([], {
    runtime: "claude_code",
    window: "period",
    session_active: "no",
    proposal_inventory_complete: true,
    window_detail: "50 stored transcripts of the last 30 days",
  });
  const columns = capabilityColumns(evidence({ runtime: "claude_code", snapshot: stored }));
  const historical = cellOf(columns, "proposed_historical");
  console.log(`[A-3] proposed_historical=${historical.value} (${historical.reason}) reliability=${historical.reliability}`);
  assert.equal(historical.value, "unknown");
  assert.notEqual(historical.value, "no", "a silent transcript was read as an absent fact");
  assert.equal(historical.reason, "no_transcript_record");
  assert.equal(historical.reliability, "unreliable", "a `yes` here must be marked unreliable");

  // and a transcript that DOES carry the proposal answers `yes`, so the branch
  // is not passing because it always returns `unknown`
  const seen = capabilityColumns(
    evidence({
      runtime: "claude_code",
      snapshot: snapshot([record({ runtime: "claude_code", role: "proposal", marker: M1 })], {
        runtime: "claude_code",
        window: "period",
        window_detail: "50 stored transcripts of the last 30 days",
      }),
    }),
  );
  assert.equal(cellOf(seen, "proposed_historical").value, "yes");
  assert.equal(cellOf(seen, "proposed_historical").reliability, "unreliable");

  // THE MUTATION: report the silence as `no`.
  const m = await mutant("fleet.ts", [`        historic ? "yes" : "unknown",`, `        historic ? "yes" : "no",`]);
  const mutated = m.capabilityColumns(evidence({ runtime: "claude_code", snapshot: stored }));
  killed("`proposed_historical` reported a silent transcript as `no`", () => {
    const cell = mutated.find((c: StateColumn) => c.column === "proposed_historical");
    assert.equal(cell.value, "unknown");
    assert.notEqual(cell.value, "no");
  });
});

test("[A-3] `proposed_now` is separated from `proposed_historical` by the SESSION, not by the record", () => {
  const proposal = record({ runtime: "claude_code", role: "proposal", marker: M1 });

  // the same record, in a live session and in a stored one, lands in DIFFERENT
  // columns — which is what "separated" has to mean
  const liveCols = capabilityColumns(
    evidence({
      runtime: "claude_code",
      snapshot: snapshot([proposal], {
        runtime: "claude_code",
        window: "live_session",
        session_active: "yes",
        window_detail: "the session running now",
      }),
    }),
  );
  assert.equal(cellOf(liveCols, "proposed_now").value, "yes");
  assert.equal(cellOf(liveCols, "proposed_now").window, "live_session");
  assert.equal(
    cellOf(liveCols, "proposed_historical").value,
    "unknown",
    "a live session says nothing about what stored transcripts hold",
  );

  const storedCols = capabilityColumns(
    evidence({
      runtime: "claude_code",
      snapshot: snapshot([proposal], {
        runtime: "claude_code",
        window: "period",
        session_active: "no",
        window_detail: "stored transcripts of the last 30 days",
      }),
    }),
  );
  assert.equal(cellOf(storedCols, "proposed_historical").value, "yes");
  assert.equal(
    cellOf(storedCols, "proposed_now").value,
    "unknown",
    "a stored transcript is not a live session and must not be reported as one",
  );
  assert.equal(cellOf(storedCols, "proposed_now").reason, "no_live_session");

  // a live session that did NOT enumerate is `unknown` with its own reason —
  // three answers, not two
  const vague = capabilityColumns(
    evidence({
      runtime: "claude_code",
      snapshot: snapshot([], {
        runtime: "claude_code",
        window: "live_session",
        session_active: "yes",
        proposal_inventory_complete: false,
        window_detail: "the session running now",
      }),
    }),
  );
  assert.equal(cellOf(vague, "proposed_now").value, "unknown");
  assert.equal(cellOf(vague, "proposed_now").reason, "live_session_did_not_enumerate_what_was_offered");
});

test("`loaded` is never claimed on either runtime, and the guard that says so bites", async () => {
  for (const runtime of FLEET_RUNTIMES) {
    // the strongest possible evidence for `loaded`: a completed paired
    // invocation. It moves `invoked` and must move nothing else.
    const columns = capabilityColumns(
      evidence({
        runtime,
        snapshot: snapshot(
          [record({ runtime, role: "call" }), record({ runtime, role: "output", result: "success" })],
          { runtime },
        ),
      }),
    );
    assert.equal(cellOf(columns, "invoked").value, "yes", `${runtime}: the pair must move \`invoked\``);
    const loaded = cellOf(columns, "loaded");
    assert.equal(loaded.value, "unknown", `${runtime}: an invocation was read as an explicit \`loaded\``);
    assert.equal(loaded.explicit, false);
    assert.equal(explicitLoadedClaim(columns), null);
    console.log(`[§4] ${runtime}: invoked=yes → loaded=${loaded.value} (${loaded.reason}), explicit=${loaded.explicit}`);
  }

  // the guard is applied to shipped answers, so it has to catch a doctored one
  const doctored: StateColumn[] = [
    { ...cellOf(capabilityColumns(evidence()), "loaded"), value: "yes" },
  ];
  assert.ok(explicitLoadedClaim(doctored), "the guard missed a `loaded: yes`");

  // THE MUTATION: publish `loaded` as a column of its own.
  const m = await mutant("fleet.ts", [
    `      "loaded", "claude_code", "not_separable_from_proposed", "none", false, false,`,
    `      "loaded", "claude_code", "not_separable_from_proposed", "none", false, true,`,
  ]);
  const mutated = m.capabilityColumns({ ...evidence({ runtime: "claude_code" }) });
  killed("`loaded` was published as an explicit column and the guard let it through", () => {
    assert.equal(m.explicitLoadedClaim(mutated), null);
  });
});

// ===========================================================================
// 3. `invoked` — degenerate cases 3 and 4
// ===========================================================================

test("[M-5] DEGENERATE 3: a LONE record is not an invocation, and the mutation that accepts one is killed", async () => {
  const subjects = [subject(V1)];

  // a lone call: the agent tried
  const callOnly = scanArrivals([record({ role: "call" })], subjects);
  // a lone output: something quoted a marker
  const outputOnly = scanArrivals([record({ role: "output" })], subjects);
  // a call and an output with DIFFERENT ids: two unrelated things
  const unpaired = scanArrivals(
    [record({ role: "call", call_id: "c-1" }), record({ role: "output", call_id: "c-2" })],
    subjects,
  );
  // a pair whose runtime gave NO id: nothing binds them
  const unbound = scanArrivals(
    [record({ role: "call", call_id: null }), record({ role: "output", call_id: null })],
    subjects,
  );
  // and the pair itself
  const paired = scanArrivals(
    [record({ role: "call", call_id: "c-9" }), record({ role: "output", call_id: "c-9", result: "success" })],
    subjects,
  );
  console.log(
    `[M-5] rows — call only: ${callOnly.length}, output only: ${outputOnly.length}, ` +
      `mismatched ids: ${unpaired.length}, no id: ${unbound.length}, PAIR: ${paired.length}`,
  );
  assert.deepEqual(callOnly, []);
  assert.deepEqual(outputOnly, []);
  assert.deepEqual(unpaired, []);
  assert.deepEqual(unbound, []);
  assert.equal(paired.length, 1, "the fixture must produce a row when the pair IS there, or it proves nothing");
  assert.equal(paired[0]!.call_id, "c-9");
  assert.equal(paired[0]!.result, "success");
  assert.equal(paired[0]!.skill_version_id, V1);

  // and the COLUMN says `unknown` for each of the four, never `no`
  for (const [name, records] of [
    ["call only", [record({ role: "call" })]],
    ["output only", [record({ role: "output" })]],
  ] as const) {
    const columns = capabilityColumns(evidence({ snapshot: snapshot([...records]) }));
    assert.equal(cellOf(columns, "invoked").value, "unknown", `${name} produced an invocation`);
    assert.equal(cellOf(columns, "invoked").reason, "no_paired_record");
  }

  // A call and an output that both carry the marker but were never bound by one
  // `call_id` are two facts about two invocations. §5 and §6 now say so with
  // ONE rule, so the column answers `unknown` WITH A REASON and does not crash
  // in a gap between two implementations of [M-5] — because there is no gap.
  const straddling = capabilityColumns(
    evidence({
      snapshot: snapshot([
        record({ role: "call", call_id: "a-1" }),
        record({ role: "output", call_id: "a-2" }),
      ]),
    }),
  );
  assert.equal(cellOf(straddling, "invoked").value, "unknown", "an unbound call/output pair was read as an invocation");
  assert.equal(cellOf(straddling, "invoked").reason, "no_paired_record");

  // THE MUTATION THAT SHIPPED, PUT BACK. §5's `assessArrival` used to count
  // SOME call and SOME output carrying the marker, with no shared id, while §6
  // required the pair. On exactly the records above that made the assignments
  // surface say `yes` and the capability surface say `unknown` — one set of
  // records, two verdicts, both citing [M-5]. The consistency check in
  // `capabilityColumns` is symmetric now, so it REFUSES rather than publishes.
  const lax = await mutantIn("marker.ts", "fleet.ts", [
    [
      `  for (const pair of matchArrivalPairs(records, viewOfArrivalRecord)) {
    if (pair.marker === subject.marker) return { verdict: "yes", reason: null };
  }`,
      `  let sawCall = false;
  let sawOutput = false;
  for (const r of records) {
    if (!r || typeof r.text !== "string" || !markersIn(r.text).includes(subject.marker)) continue;
    if (r.role === "call") sawCall = true;
    else if (r.role === "output") sawOutput = true;
    if (sawCall && sawOutput) return { verdict: "yes", reason: null };
  }`,
    ],
  ]);
  killed("§5 read an unbound call/output as a pair while §6 did not, and the page published one of the two", () => {
    lax.capabilityColumns(
      evidence({
        snapshot: snapshot([record({ role: "call", call_id: "a-1" }), record({ role: "output", call_id: "a-2" })]),
      }),
    );
  });

  // THE MUTATION: stop requiring the call. It is made in `src/marker.ts`, where
  // the rule now lives, and §6 is loaded on top of it — so a §5 that stopped
  // requiring a pair would carry §6 with it.
  const m = await mutantIn("marker.ts", "fleet.ts", [
    [`    if (call === undefined) continue;`, `    if (false) continue;`],
  ]);
  killed("a lone output was accepted as an invocation [M-5]", () => {
    assert.deepEqual(m.scanArrivals([record({ role: "output" })], subjects), []);
  });

  // …and the same for the id itself: a rule that ignored `call_id` would make
  // the mismatched-id case above a pair again.
  const idBlind = await mutantIn("fleet.ts", "fleet.ts", [
    [
      `      ? { role: r.role, call_id: r.call_id, markers: [r.marker], scope: [r.agent_id, r.runtime] }`,
      `      ? { role: r.role, call_id: "one", markers: [r.marker], scope: [r.agent_id, r.runtime] }`,
    ],
  ]);
  killed("two records the runtime bound to DIFFERENT invocations were read as one pair [M-5]", () => {
    assert.deepEqual(
      idBlind.scanArrivals(
        [record({ role: "call", call_id: "c-1" }), record({ role: "output", call_id: "c-2" })],
        subjects,
      ),
      [],
    );
  });
});

test("[M-5] DEGENERATE 4: a pair carrying ANOTHER version's marker is evidence for THAT version only", async () => {
  const subjects = [subject(V1), subject(V2)];
  // the pair carries V2's marker throughout
  const records = [
    record({ role: "call", call_id: "c-7", marker: M2 }),
    record({ role: "output", call_id: "c-7", marker: M2, result: "success" }),
  ];
  const rows = scanArrivals(records, subjects);
  console.log(`[M-5] a pair carrying ${M2}: rows=${rows.length}, attributed to ${rows.map((r) => r.skill_version_id).join(",")}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.skill_version_id, V2, "the row is attributed to the version whose marker is on the record");
  assert.equal(rows.filter((r) => r.skill_version_id === V1).length, 0, "V1 was credited with V2's run");

  // the column for V1 stays `unknown` on exactly these records
  const v1 = capabilityColumns(evidence({ subject: subject(V1), snapshot: snapshot(records) }));
  assert.equal(cellOf(v1, "invoked").value, "unknown");
  const v2 = capabilityColumns(evidence({ subject: subject(V2), snapshot: snapshot(records) }));
  assert.equal(cellOf(v2, "invoked").value, "yes", "V2 must be `yes`, or the fixture proves nothing");

  // a `["none"]` version can never be demonstrated even by a pair carrying its
  // own marker: it ships nothing that prints one, so the pair is a coincidence
  const noShell = scanArrivals(
    [record({ role: "call", call_id: "c-8" }), record({ role: "output", call_id: "c-8" })],
    [subject(V1, false)],
  );
  assert.deepEqual(noShell, [], "a version with no executable step was credited with a run");
  const noShellColumns = capabilityColumns(
    evidence({
      subject: subject(V1, false),
      snapshot: snapshot([record({ role: "call", call_id: "c-8" }), record({ role: "output", call_id: "c-8" })]),
    }),
  );
  assert.equal(cellOf(noShellColumns, "invoked").value, "unknown");
  assert.equal(
    cellOf(noShellColumns, "invoked").reason,
    "no_executable_step",
    "D-6's two unknowns must stay machine-distinguishable",
  );

  // THE MUTATION: credit whichever subject was asked about first.
  const m = await mutant("fleet.ts", [
    `    const subject = bySubjectMarker.get(pair.marker);`,
    `    const subject = bySubjectMarker.get(pair.marker) ?? subjects[0];`,
  ]);
  killed("a pair carrying another version's marker was credited to the first subject", () => {
    const mutated = m.scanArrivals(
      [record({ role: "call", call_id: "c-7", marker: "SKLN1-ZZZZZZZZZZZZZZZZ" }),
       record({ role: "output", call_id: "c-7", marker: "SKLN1-ZZZZZZZZZZZZZZZZ" })],
      subjects,
    );
    assert.deepEqual(mutated, []);
  });
});

test("[M-6] a run that FINISHED is not a run that succeeded", () => {
  const pair = [
    record({ role: "call", call_id: "c-2" }),
    record({ role: "output", call_id: "c-2", result: "unknown" }),
  ];
  // with a contract, and a completed run nothing evaluated
  const completed = capabilityColumns(evidence({ snapshot: snapshot(pair), outcome_contract: CONTRACT }));
  assert.equal(cellOf(completed, "invoked").value, "yes");
  assert.equal(cellOf(completed, "outcome").value, "unknown", "completion was reported as success [M-6]");
  assert.match(String(cellOf(completed, "outcome").reason), /never_executed/);

  // with no contract at all, `outcome` says which of the two unknowns it is
  const noContract = capabilityColumns(evidence({ snapshot: snapshot(pair), outcome_contract: null }));
  assert.equal(cellOf(noContract, "outcome").value, "unknown");
  assert.equal(cellOf(noContract, "outcome").reason, "no_outcome_contract");

  // A REPORTER'S OWN WORD MOVES NOTHING, in either direction. This is the half
  // that used to be the defect: `result` is filled in by the agent doing the
  // reporting, and §4's column printed it as the verdict.
  for (const declared of ["success", "failure"] as const) {
    const word = capabilityColumns(
      evidence({
        snapshot: snapshot([record({ role: "call", call_id: `w-${declared}` }), record({ role: "output", call_id: `w-${declared}`, result: declared })]),
        outcome_contract: CONTRACT,
      }),
    );
    assert.equal(cellOf(word, "outcome").value, "unknown", `a principal's own \`${declared}\` was published as a verdict`);
  }

  // AND AN EXECUTED CHECK MOVES IT IN BOTH DIRECTIONS, SO THE COLUMN IS LIVE.
  //
  // WHAT MOVES, SINCE D-18, IS THE SELF-REPORT'S OWN CONCLUSION — and this is
  // the requirement change, not a relaxation of this test. `stdout` is a fact
  // about a process on the ADDRESSEE'S machine. This registry ran nothing and
  // read nothing; what it holds is a report. So the contract is executed
  // against that report, its conclusion is published under its own name, and
  // the VERDICT stays `unknown` with a reason saying it was not verified here
  // [M-7]. A `yes` in this column means the registry checked, and after D-18 it
  // means only that.
  const good = capabilityColumns(
    evidence({
      snapshot: snapshot([
        record({ role: "call", call_id: "c-3" }),
        record({ role: "output", call_id: "c-3", result: "unknown", evidence: selfReported({ stdout_sha256: CONTRACT_DIGEST }) }),
      ]),
      outcome_contract: CONTRACT,
      reported_by: { type: "agent" },
    }),
  );
  const goodCell = cellOf(good, "outcome");
  // EVERY ATTRIBUTE, not the one that changed. A verdict half-checked is the
  // same defect as a number half-attributed [I-3].
  assert.equal(goodCell.value, "unknown", "a report about somebody else's machine was published as a verdict");
  assert.equal(goodCell.assessment?.claim, "yes", "the self-report's own conclusion is not published at all");
  assert.equal(goodCell.assessment?.basis, "self_report");
  assert.equal(goodCell.assessment?.assessed_by, "principal");
  assert.equal(goodCell.assessment?.principal_type, "agent", "the verdict lost the kind of principal that claimed it [I-5]");
  assert.ok((goodCell.assessment?.reason ?? "").length > 0, "a verdict with no reason [I-3]");
  assert.equal(goodCell.reason, goodCell.assessment?.reason, "the cell and its assessment give two different reasons");
  const bad = capabilityColumns(
    evidence({
      snapshot: snapshot([
        record({ role: "call", call_id: "c-4" }),
        record({ role: "output", call_id: "c-4", result: "unknown", evidence: selfReported({ stdout_sha256: OTHER_DIGEST }) }),
      ]),
      outcome_contract: CONTRACT,
      reported_by: { type: "service" },
    }),
  );
  const badCell = cellOf(bad, "outcome");
  assert.equal(badCell.value, "unknown");
  assert.equal(badCell.assessment?.claim, "no", "the column does not move for a report that refutes the contract");
  assert.equal(badCell.assessment?.basis, "self_report");
  assert.equal(badCell.assessment?.assessed_by, "principal");
  assert.equal(badCell.assessment?.principal_type, "service", "the type printed is not the type that reported [I-5]");
  assert.notEqual(goodCell.assessment?.claim, badCell.assessment?.claim, "the column is dead: it answers the same either way");

  // …AND THE REGISTRY'S OWN READING IS A REAL `yes` AND A REAL `no`. Without
  // this half the assertions above would be satisfied by a column that never
  // says anything, which is its own way of lying.
  const artifact = {
    check: { kind: "artifact_exists", artifact_path: "out/report.json" },
    evidence: ["artifacts"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  } as const;
  const seen = cellOf(
    capabilityColumns(evidence({ snapshot: snapshot([]), outcome_contract: artifact as never, observed_evidence: registryObserved({ artifacts: [evidenceDigestOf("out/report.json")] }) })),
    "outcome",
  );
  const unseen = cellOf(
    capabilityColumns(evidence({ snapshot: snapshot([]), outcome_contract: artifact as never, observed_evidence: registryObserved({ artifacts: [] }) })),
    "outcome",
  );
  assert.equal(seen.value, "yes", "the registry read its own root and would not answer for it");
  assert.equal(seen.assessment?.basis, "registry_observation", "a verdict the registry established was published as a claim");
  assert.equal(seen.assessment?.assessed_by, "registry");
  assert.equal(seen.assessment?.claim, null, "a reading of this registry's own disk is not somebody's claim");
  assert.equal(seen.source, "filesystem", "a verdict read off a disk was attributed to a transcript [I-3]");
  assert.equal(unseen.value, "no", "a root that WAS walked and did not hold it answers `no`, not `unknown`");
  assert.equal(unseen.assessment?.basis, "registry_observation");
  assert.equal(unseen.assessment?.assessed_by, "registry");
  assert.ok((unseen.assessment?.reason ?? "").length > 0, "a verdict with no reason [I-3]");
});

// ===========================================================================
// 4. [I-3] A NUMBER WITHOUT ITS METHOD — degenerate case 5
// ===========================================================================

test("[I-3] DEGENERATE 5: a value that lost one of its three attributes is refused, and the sweep catches one that got out", async () => {
  const attribution = {
    state: "registered" as const,
    source: "filesystem" as const,
    window: "all_time" as const,
    window_detail: "a temporary tree built by the test harness",
  };
  assert.equal(missingAttribute(attribution), null);
  assert.equal(countedNumber(3, attribution).value, 3);

  // each of the three, dropped in turn, is REFUSED at construction
  for (const dropped of ["state", "source", "window", "window_detail"] as const) {
    const broken: any = { ...attribution };
    delete broken[dropped];
    assert.equal(missingAttribute(broken), dropped, `a value missing \`${dropped}\` was accepted as attributed`);
    assert.throws(() => countedNumber(3, broken), /is missing \[I-3\]/, `\`${dropped}\` was not required`);
  }

  // …and every cell a real answer publishes carries all three
  for (const runtime of FLEET_RUNTIMES) {
    const columns = capabilityColumns(evidence({ runtime, snapshot: snapshot([], { runtime }) }));
    assert.equal(columns.length, columnsOf(runtime).length, "a column was dropped rather than answered [I-1]");
    for (const c of columns) {
      assert.equal(missingAttribute(c), null, `${runtime}/${c.column} lost an attribute`);
    }
  }

  // THE MUTATION: publish a column without its window.
  const m = await mutant("fleet.ts", [
    `    window: win.window,
    window_detail: win.window_detail,
    ...(assessment === undefined ? {} : { assessment }),
  };
  const missing = missingAttribute(col);`,
    `    window: win.window,
    window_detail: win.window_detail,
    ...(assessment === undefined ? {} : { assessment }),
  };
  delete (col as { window_detail?: string }).window_detail;
  const missing = missingAttribute(col);`,
  ]);
  killed("a state column was published with no selection window [I-3]", () => {
    const mutated = m.capabilityColumns(evidence());
    for (const c of mutated) assert.equal(m.missingAttribute(c), null);
  });
});

test("[I-3] a count's STATE comes from the DECLARED column, not from whatever cell was found", async () => {
  // The degenerate shape this guards: a number attributed by reading the first
  // thing in a list. With an EMPTY list there is nothing to read, and a
  // fallback publishes a count of `registered` under the name `invoked`.
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  const fx = p4Fixture({ inventory: new FixedInventoryRoots(root, "codex") });
  // NO deployment and no copy: every column's count is taken over zero cells
  const caps = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities`, fx.keys.owner);
  assert.equal(caps.status, 200, caps.raw);
  assert.deepEqual(caps.body.capabilities, [], "the fixture must be empty, or this proves nothing");
  assert.equal(caps.body.states.length, columnsOf("codex").length);
  for (const [i, column] of columnsOf("codex").entries()) {
    const n = caps.body.states[i];
    assert.equal(n.value, 0);
    assert.equal(
      n.state,
      stateOfColumn(column),
      `the count for \`${column}\` is attributed to the state \`${n.state}\``,
    );
    assert.equal(missingAttribute(n), null);
  }
  console.log(`[I-3] empty-list state counts: ${caps.body.states.map((n: any) => `${n.state}=${n.value}`).join(" ")}`);

  // THE MUTATION: take the state from the first cell found instead.
  const m = await mutant("fleet.ts", [
    `  if (column === "proposed_now" || column === "proposed_historical") return "proposed";
  return column as CapabilityState;`,
    `  return "registered" as CapabilityState;`,
  ]);
  killed("a count took its state from a fallback rather than from its declared column [I-3]", () => {
    for (const column of columnsOf("codex")) {
      assert.equal(m.stateOfColumn(column), column === "proposed_now" || column === "proposed_historical" ? "proposed" : column);
    }
  });
  fx.db.close();
});

// ===========================================================================
// 5. [I-4] THE COUNT FOLLOWS SYMBOLIC LINKS — degenerate case 2
// ===========================================================================

/** A walker that does NOT follow links, written here so the two numbers can be
 *  put side by side. It is the counting this project must not ship. */
function countWithoutFollowing(dir: string): number {
  let found = 0;
  const walk = (current: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // the undercount, in one line
      if (entry.isDirectory()) walk(join(current, entry.name));
    }
    if (entries.some((e) => e.name === "SKILL.md")) found += 1;
  };
  walk(dir);
  return found;
}

test("[I-4] DEGENERATE 2: the inventory follows symbolic links, and the two numbers are printed side by side", async () => {
  const base = tempBase();
  const root = join(base, "root");
  // one skill this fleet member owns
  mkdirSync(join(root, ".claude", "skills", "own"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "own", "SKILL.md"), "# own\n");
  // the SHARED LIBRARY, elsewhere on the disk, reached through a link — the
  // ordinary way a fleet is handed one skill library
  mkdirSync(join(base, "shared", "alpha"), { recursive: true });
  mkdirSync(join(base, "shared", "beta"), { recursive: true });
  mkdirSync(join(base, "shared", "gamma"), { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) {
    writeFileSync(join(base, "shared", name, "SKILL.md"), `# ${name}\n`);
  }
  symlinkSync(join(base, "shared"), join(root, ".claude", "skills", "shared"));

  const followed = inventoryUnder({ root, runtime: "claude_code" }, AGENT).items.filter((i) => i.kind === "skill");
  const notFollowed = countWithoutFollowing(join(root, ".claude", "skills"));
  console.log(`[I-4] skills under the root — links FOLLOWED: ${followed.length}`);
  console.log(`[I-4] skills under the root — links NOT followed: ${notFollowed}`);
  assert.equal(followed.length, 4, "own + the three of the shared library");
  assert.equal(notFollowed, 1, "the non-following walk must undercount, or this comparison shows nothing");
  assert.notEqual(followed.length, notFollowed, "the fixture does not discriminate: build a link that matters");
  assert.deepEqual(followed.map((i) => i.name).sort(), ["alpha", "beta", "gamma", "own"]);

  // a link back at an ancestor ends the walk rather than the process
  symlinkSync(root, join(base, "shared", "loop"));
  const withLoop = inventoryUnder({ root, runtime: "claude_code" }, AGENT).items.filter((i) => i.kind === "skill");
  assert.ok(withLoop.length >= 4, "a cycle must not lose the entries already found");

  // THE MUTATION: stop resolving the child before deciding whether to descend.
  const m = await mutant("fleet-scan.ts", [
    `        // [I-4]: the kind is taken from the RESOLVED path, so a link to a
        // shared library is entered rather than skipped
        childReal = realpathSync(child);
        isDir = lstatSync(childReal).isDirectory();`,
    `        childReal = child;
        isDir = lstatSync(child).isSymbolicLink() ? false : lstatSync(child).isDirectory();`,
  ]);
  killed("the inventory stopped at the symbolic link and undercounted the shared library [I-4]", () => {
    const mutated = m.inventoryUnder({ root, runtime: "claude_code" }, AGENT).items.filter(
      (i: RegisteredCapability) => i.kind === "skill",
    );
    assert.equal(mutated.length, 4);
  });
});

test("[A-2] a kind that cannot be seen from a disk is `unknown` WITH A REASON, never zero", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(join(root, ".claude", "skills", "one"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "one", "SKILL.md"), "# one\n");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));

  const claude = inventoryUnder({ root, runtime: "claude_code" }, AGENT);
  assert.equal(claude.items.filter((i) => i.kind === "skill").length, 1);
  assert.equal(claude.items.filter((i) => i.kind === "mcp_server").length, 2, "declared servers ARE readable");
  assert.equal(claude.undiscoverable.mcp_tool, "requires_a_live_connection");
  assert.equal(claude.undiscoverable.connector, "not_discoverable_from_a_filesystem");
  assert.equal(claude.undiscoverable.skill, undefined, "a kind that WAS walked carries no reason");

  // Codex has no plugin concept and its server declaration is not parsed here:
  // two DIFFERENT reasons, both `unknown`, neither a zero
  const codex = inventoryUnder({ root, runtime: "codex" }, AGENT);
  assert.equal(codex.undiscoverable.plugin, "not_a_concept_of_this_runtime");
  assert.equal(codex.undiscoverable.mcp_server, "not_discoverable_from_a_filesystem");
  console.log(`[A-2] claude undiscoverable: ${JSON.stringify(claude.undiscoverable)}`);
  console.log(`[A-2] codex  undiscoverable: ${JSON.stringify(codex.undiscoverable)}`);
});

// ===========================================================================
// 6. [A-5] DEAD WEIGHT IS MEASURED, NOT RESTATED — degenerate case 6
// ===========================================================================

test("[A-5] DEGENERATE 6: dead weight is counted from OBSERVATION, and the mutation that counts intent is killed", async () => {
  // THREE registered on the disk. TWO of them this registry intends active. ONE
  // of them has a paired record. The intent-derived number and the
  // observation-derived number are therefore DIFFERENT, which is the only way
  // this test can discriminate at all.
  const V3 = "01JDDDDDDDDDDDDDDDDDDDDDDD";
  const registered: RegisteredCapability[] = [V1, V2, V3].map((id) => ({
    agent_id: AGENT,
    runtime: "codex",
    kind: "skill",
    name: `skill-${id.slice(-3)}`,
    skill_version_id: id,
    marker: arrivalMarker(id),
  }));
  const scan = scanArrivals(
    [
      record({ role: "call", call_id: "c-5", marker: arrivalMarker(V1) }),
      record({ role: "output", call_id: "c-5", marker: arrivalMarker(V1), result: "success" }),
    ],
    [subject(V1), subject(V2), subject(V3)],
  );
  const intentActive = [V1, V2];

  const answer = deadWeightOf({
    registered,
    scan,
    intent_active_version_ids: intentActive,
    attribution: {
      registeredWindow: "a temporary tree built by the test harness",
      invokedWindow: "records supplied by the test harness, all time",
      invokedSelection: "all_time",
    },
  });
  const fromIntent = registered.length - intentActive.length;
  console.log(`[A-5] registered=${answer.registered.value} invoked(observed)=${answer.invoked.value} dead=${answer.dead.value}`);
  console.log(`[A-5] the number an INTENT-derived count would have produced: ${fromIntent}`);
  assert.notEqual(answer.dead.value, fromIntent, "the fixture does not discriminate intent from observation");
  assert.equal(answer.dead.value, 2, "three registered, one demonstrated to have run");
  assert.equal(answer.invoked.value, 1);
  assert.equal(answer.intent_active.value, 2, "the OTHER column is published beside it, never merged [I-2]");
  assert.equal(answer.invoked.source, "transcript", "the `used` number is a transcript number and says so");
  assert.equal(answer.intent_active.source, "registry");
  assert.deepEqual(answer.items.map((i) => i.skill_version_id).sort(), [V2, V3].sort());
  for (const item of answer.items) assert.equal(item.reason, "never_invoked");

  // a copy whose version could not be identified is dead weight with its OWN
  // reason rather than silently absent
  const orphan = deadWeightOf({
    registered: [{ agent_id: AGENT, runtime: "codex", kind: "skill", name: "stray", skill_version_id: null, marker: null }],
    scan: [],
    intent_active_version_ids: [],
    attribution: {
      registeredWindow: "a temporary tree built by the test harness",
      invokedWindow: "records supplied by the test harness, all time",
      invokedSelection: "all_time",
    },
  });
  assert.equal(orphan.items[0]!.reason, "no_version_identified");

  // THE MUTATION: take the `used` set from the intent column.
  const m = await mutant("fleet.ts", [
    `  const invoked = invokedVersionIds(input.scan);`,
    `  const invoked = new Set(input.intent_active_version_ids);`,
  ]);
  killed("dead weight was counted from what the registry INTENDED rather than from what was observed [A-5]", () => {
    const mutated = m.deadWeightOf({
      registered,
      scan,
      intent_active_version_ids: intentActive,
      attribution: {
        registeredWindow: "a temporary tree built by the test harness",
        invokedWindow: "records supplied by the test harness, all time",
        invokedSelection: "all_time",
      },
    });
    assert.equal(mutated.dead.value, 2);
  });
});

test("[A-5] the first day's screen: everything registered, nothing demonstrated", () => {
  // the owner's own measurement has this shape — a large registered count
  // against zero observed invocations — so the shape is built and asserted
  // rather than assumed.
  const registered: RegisteredCapability[] = Array.from({ length: 386 }, (_, i) => ({
    agent_id: AGENT,
    runtime: "codex",
    kind: "skill",
    name: `skill-${i}`,
    skill_version_id: ulid(1_754_000_000_000 + i),
    marker: null,
  }));
  const answer = deadWeightOf({
    registered,
    scan: [],
    intent_active_version_ids: [],
    attribution: {
      registeredWindow: "one configured inventory root, all depths, links followed",
      invokedWindow: "no runtime observation has been reported for this agent: no record was searched",
      invokedSelection: "all_time",
    },
  });
  console.log(`[A-5] registered=${answer.registered.value}, invoked=${answer.invoked.value}, dead=${answer.dead.value}`);
  assert.equal(answer.registered.value, 386);
  assert.equal(answer.invoked.value, 0);
  assert.equal(answer.dead.value, 386);
  // and the `dead` number states that it is an absence of EVIDENCE
  assert.match(answer.dead.reason ?? "", /unknown.*not `never used`/i);
});

// ===========================================================================
// 7. [A-4] THE GAP READS THE OBSERVATION COLUMN
// ===========================================================================

test("[A-4] the gap compares the two columns and computes neither from the other", () => {
  const base = {
    agent_id: AGENT,
    skill_id: "01JEEEEEEEEEEEEEEEEEEEEEEE",
    slug: "some-skill",
    skill_version_id: V1,
    intent_state_source: "assignment_events (registry journal, INSERT-only)",
    observed_arrival_reason: "no_paired_record" as string | null,
    observed_arrival_source: "runtime transcript records",
    observed_arrival_window: "no runtime record source is configured",
  };
  const cases: Array<[string, "yes" | "unknown", string]> = [
    ["active", "unknown", "intent_active_arrival_unobserved"],
    ["active", "yes", "intent_active_and_arrival_observed"],
    ["revoked", "yes", "arrival_observed_without_active_intent"],
    ["queued", "unknown", "no_claim_on_either_side"],
  ];
  for (const [intent, observed, expected] of cases) {
    const g = gapOf({ ...base, intent_state: intent, observed_arrival: observed });
    assert.equal(g.gap, expected, `intent=${intent} observed=${observed}`);
    assert.equal(g.intent_state_is, "intent");
    assert.equal(g.observed_arrival_is, "observation");
    assert.equal(g.gap_is, "comparison", "the comparison must never be published as a third fact");
    assert.equal(g.intent_state, intent, "the intent is carried verbatim, not re-derived");
    assert.equal(g.observed_arrival, observed, "the observation is carried verbatim, not re-derived");
  }

  // the one that matters: an `active` intent with no observation must NOT read
  // as agreement
  const common = gapOf({ ...base, intent_state: "active", observed_arrival: "unknown" });
  assert.notEqual(common.gap, "intent_active_and_arrival_observed");
});

test("[A-1] the synchronisation status is a COMPARISON, and an unobserved agent is never `in_sync`", () => {
  assert.equal(syncStatusOf({ observed: false, headStates: ["active"], intentActive: 1, arrivalYes: 0 }).status, "unknown");
  assert.equal(syncStatusOf({ observed: true, headStates: ["active"], intentActive: 1, arrivalYes: 0 }).status, "pending");
  assert.equal(syncStatusOf({ observed: true, headStates: ["active"], intentActive: 1, arrivalYes: 1 }).status, "in_sync");
  assert.equal(syncStatusOf({ observed: true, headStates: ["drifted"], intentActive: 0, arrivalYes: 0 }).status, "drifted");
  assert.equal(syncStatusOf({ observed: true, headStates: ["failed"], intentActive: 1, arrivalYes: 1 }).status, "failed");
  // an agent with nothing intended is `unknown`, not `in_sync`: there is
  // nothing to compare, and "agrees vacuously" is not a report
  assert.equal(syncStatusOf({ observed: true, headStates: [], intentActive: 0, arrivalYes: 0 }).status, "unknown");
});

// ===========================================================================
// 8. [M-7] THE ASSESSMENT NEEDS NO FILESYSTEM, AND NAMES NO REAL DIRECTORY
// ===========================================================================

test("[M-7] the assessment logic imports no filesystem, and the whole pipeline runs from records alone", () => {
  const logic = readFileSync(new URL("../src/fleet.ts", import.meta.url), "utf8");
  assert.ok(!/from "node:fs"/.test(logic), "src/fleet.ts imports node:fs — the addressee has no disk in V-2");
  assert.ok(!/from "node:path"/.test(logic), "src/fleet.ts imports node:path");
  assert.ok(!/readFileSync|readdirSync|realpathSync|existsSync/.test(logic), "src/fleet.ts touches a filesystem");
  // …and it takes no path-shaped parameter either, which is the same rule at
  // the interface rather than at the import
  assert.ok(!/\broot\s*:\s*string/.test(logic), "src/fleet.ts takes a root");

  // THE POSITIVE HALF. Run the matrix, the scanner and the dead-weight slice
  // over records that came from nowhere at all, with no root configured.
  const records = [
    record({ role: "call", call_id: "wire-1" }),
    record({ role: "output", call_id: "wire-1", result: "success", evidence: selfReported({ stdout_sha256: CONTRACT_DIGEST }) }),
  ];
  const columns = capabilityColumns(evidence({ snapshot: snapshot(records), outcome_contract: CONTRACT, reported_by: { type: "agent" } }));
  assert.equal(cellOf(columns, "invoked").value, "yes");
  // …and `outcome` reached its answer from those records too: a self-report,
  // named as one, whose own conclusion is published beside it [D-18]. The
  // point of this test is that the pipeline ran with no disk anywhere near it,
  // and every attribute of the verdict is checked because a verdict that says
  // only half of where it came from is the defect D-18 removed.
  const wire = cellOf(columns, "outcome");
  assert.equal(wire.value, "unknown");
  assert.equal(wire.assessment?.claim, "yes");
  assert.equal(wire.assessment?.basis, "self_report");
  assert.equal(wire.assessment?.assessed_by, "principal");
  assert.equal(wire.assessment?.principal_type, "agent");
  assert.equal(unverdicted(columns), null, "a column published a verdict with no provenance [I-3], [D-18]");
  const rows = scanArrivals(records, [subject(V1)]);
  assert.equal(rows.length, 1, "[A-6]'s tuple came out of a message, not a file");
  assert.deepEqual(Object.keys(rows[0]!).sort(), [
    "agent_id", "at_ms", "call_id", "evidence", "marker", "result", "runtime", "skill_version_id",
  ]);
  assert.equal(NO_FLEET_OBSERVATIONS.snapshotFor("any-agent"), null, "the shipped default observes nothing");
  assert.equal(NO_INVENTORY_ROOTS.rootFor("any-agent"), null, "the shipped default walks nowhere");
});

test("no shipped §6 source names a real runtime location, and no default root exists", () => {
  for (const file of ["src/fleet.ts", "src/fleet-scan.ts", "src/fleet-store.ts"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/\bhomedir\b/.test(text), `${file} reads a home directory`);
    assert.ok(!/process\.env\.(HOME|USERPROFILE)/.test(text), `${file} reads HOME`);
    assert.ok(!/["'`]~\//.test(text), `${file} carries a \`~/\` path`);
    assert.ok(!/["'`]\/(home|root|Users)\//.test(text), `${file} carries an absolute user path`);
  }
  // the layouts it DOES know are relative, and none is absolute
  const scan = readFileSync(new URL("../src/fleet-scan.ts", import.meta.url), "utf8");
  const layouts = [...scan.matchAll(/"(\.[a-z]+\/[a-z._/]+)"/g)].map((m) => m[1]!);
  assert.ok(layouts.length >= 3, "the layout table must be found, or this test checks nothing");
  for (const rel of layouts) {
    assert.ok(!rel.startsWith("/"), `${rel} is absolute`);
    assert.ok(!rel.includes(".."), `${rel} traverses`);
  }
  // and no tool takes a root, a path or a directory from its caller
  for (const tool of MCP_TOOLS.filter((t) => /^(fleet|agent|capability|observation)\./.test(t.name))) {
    for (const p of Object.keys((tool as any).inputSchema.properties ?? {})) {
      assert.ok(!/root|path|dir/i.test(p), `${tool.name} takes a location from its caller: ${p}`);
    }
  }
});

test("[M-7] the two V-1 sources answer the SAME interfaces, and neither is visible above the seam", () => {
  // a transcript directory — the V-1 local read — plugged into §5.5's seam AND
  // §6's, from one implementation
  const base = tempBase();
  const root = join(base, "transcripts");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "session.jsonl"),
    [
      JSON.stringify({ type: "custom_tool_call", call_id: "t-1", at_ms: 1_754_000_000_000, text: `running ${M1}` }),
      JSON.stringify({ type: "custom_tool_call_output", call_id: "t-1", at_ms: 1_754_000_000_500, text: `done ${M1}`, result: "success", evidence: { exit_code: 0 } }),
    ].join("\n") + "\n",
  );
  // roots that know ONE agent, so that `null` — "nothing was searched" — is a
  // reachable answer and not merely a documented one
  const source = new TranscriptObservations({
    rootFor: (id: string) =>
      id === AGENT ? { root, runtime: "codex" as const, window: "period" as const, window_detail: "one session file" } : null,
  });
  // the shipped simplest configuration answers for every agent, by design
  const everyone = new FixedTranscriptRoots({
    root,
    runtime: "codex",
    window: "period",
    window_detail: "one session file",
  });
  assert.ok(everyone.rootFor(), "FixedTranscriptRoots names one place for the whole fleet");
  const snap = source.snapshotFor(AGENT)!;
  assert.ok(snap, "the adapter produced no snapshot");
  assert.equal(snap.records.length, 2);
  // THE TEXT DID NOT SURVIVE: what came back is markers [I-7]
  for (const r of snap.records) {
    assert.equal(r.marker, M1);
    assert.ok(!Object.prototype.hasOwnProperty.call(r, "text"), "a record carried its text past the adapter");
  }
  const rows = scanArrivals(snap.records, [subject(V1)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.result, "success");
  // THE ID DID NOT SURVIVE EITHER: the adapter hands over `sha256:` of it, so a
  // pair is still one pair and the runtime's own string is not carried [M-5], [I-7]
  assert.equal(rows[0]!.call_id, correlationDigest("t-1"));

  // the same object answers §5.5's older seam, unchanged
  const window = source.recordsFor(AGENT)!;
  assert.equal(window.records.length, 2);
  assert.equal(window.window, snap.window_detail);
  assert.equal(source.snapshotFor("some-other-agent"), null, "an unconfigured agent is `null`, not zero records");
});

// ===========================================================================
// 9. THE SURFACES: the answers, the hints, and what is not stored
// ===========================================================================

interface Deployed {
  fx: P4Fixture;
  assignmentId: string;
  versionId: string;
  slug: string;
  marker: string;
}

function deploy(fx: P4Fixture, slug: string): Deployed {
  const v = reviewedVersion(fx, slug);
  const granted = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: fx.member.agent_id,
    action: TRANSFER_ACTION,
    recipient_scope: "local_agent",
  });
  assert.equal(granted.status, 201, granted.raw);
  const pushed = rest(fx, "POST", `/v1/versions/${v.versionId}/transfers`, fx.keys.member, {
    recipient: { kind: "local_agent", ref: fx.reviewer.agent_id },
  });
  assert.equal(pushed.status, 201, pushed.raw);
  return { fx, assignmentId: pushed.body.assignment_id, versionId: v.versionId, slug, marker: arrivalMarker(v.versionId) };
}

function allow(fx: P4Fixture, agentId: string, action: string): void {
  const res = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: agentId,
    action,
    recipient_scope: "local_agent",
  });
  assert.equal(res.status, 201, res.raw);
}

/** Every number-bearing node of an answer, for the [I-3] sweep. */
function attributedNodes(value: unknown, out: any[] = []): any[] {
  if (Array.isArray(value)) {
    for (const v of value) attributedNodes(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.measurement_state !== undefined || o.column !== undefined) out.push(o);
    for (const v of Object.values(o)) attributedNodes(v, out);
  }
  return out;
}

test("the reading surfaces publish both columns, the matrix, and no number without its method", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  const fx = p4Fixture({ inventory: new FixedInventoryRoots(root, "codex") });
  const d = deploy(fx, "fleet-surfaces");

  const fleet = rest(fx, "GET", "/v1/fleet", fx.keys.owner);
  assert.equal(fleet.status, 200, fleet.raw);
  const row = fleet.body.agents.find((a: any) => a.agent_id === fx.reviewer.agent_id);
  assert.ok(row, "the recipient must be in the fleet listing");
  assert.equal(row.session_active, "unknown", "nothing was reported, so nothing is claimed");
  assert.equal(row.model, null);
  assert.equal(row.sync_status, "unknown");
  assert.equal(row.sync_status_is, "comparison");
  assert.ok(row.intent_active && row.observed_arrival_yes, "the two columns must be published beside the comparison");
  assert.equal(row.runtime, "codex", "the configured layout answers when nothing has been observed");
  assert.equal(row.runtime_source, "registry", "…and it is labelled as this registry's own configuration");

  // §4's matrix travels with the answer, and it is asymmetric in it
  const codexProposed = fleet.body.matrix.find((c: any) => c.state === "proposed" && c.runtime === "codex");
  const claudeProposed = fleet.body.matrix.find((c: any) => c.state === "proposed" && c.runtime === "claude_code");
  assert.equal(codexProposed.can_be_no, false);
  assert.equal(claudeProposed.can_be_no, true);
  for (const runtime of FLEET_RUNTIMES) {
    assert.equal(fleet.body.matrix.find((c: any) => c.state === "loaded" && c.runtime === runtime).explicit, false);
  }

  const caps = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities`, fx.keys.owner);
  assert.equal(caps.status, 200, caps.raw);
  assert.deepEqual(caps.body.columns, [...columnsOf("codex")], "the answer publishes THIS runtime's column set");
  const cap = caps.body.capabilities.find((c: any) => c.name === d.slug);
  assert.ok(cap, "the assigned skill must appear even though no copy is on the disk");
  const columns: StateColumn[] = cap.columns;
  assert.equal(cellOf(columns, "registered").value, "no", "the root WAS walked and did not hold it");
  assert.equal(cellOf(columns, "assigned").value, "yes");
  assert.equal(cellOf(columns, "assigned").is, "intent", "[I-2]: the intent column is labelled");
  assert.equal(cellOf(columns, "invoked").value, "unknown");
  assert.equal(cellOf(columns, "invoked").is, "observation");
  assert.equal(explicitLoadedClaim(columns), null);
  assert.equal(forbiddenNoClaim(columns), null);

  // THE SWEEP [I-3]: every number and every cell in the shipped bytes
  for (const answer of [fleet.body, caps.body]) {
    const nodes = attributedNodes(answer);
    assert.ok(nodes.length > 5, "the sweep found nothing to check");
    for (const n of nodes) {
      assert.equal(missingAttribute(n), null, `a published value lost an attribute: ${JSON.stringify(n).slice(0, 160)}`);
    }
  }
  // a kind nothing can see from a disk is `unknown`, never 0
  const tools = caps.body.inventory.find((n: any) => n.reason === "requires_a_live_connection");
  assert.ok(tools, "MCP tools must be reported unknown with their reason");
  assert.equal(tools.value, null);
  assert.equal(tools.measurement_state, "unknown");

  // [A-4] the gap is a visible row
  const gap = caps.body.gap.find((g: any) => g.skill_version_id === d.versionId);
  assert.equal(gap.gap, "no_claim_on_either_side");
  assert.equal(gap.observed_arrival, "unknown");

  // capability.get carries §4's row for this runtime and [A-6]'s tuples
  const one = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities/${d.slug}`, fx.keys.owner);
  assert.equal(one.status, 200, one.raw);
  assert.equal(one.body.matrix.length, CAPABILITY_STATES.length);
  assert.deepEqual(one.body.scan, [], "no record has been reported, so there is no tuple");
  assert.equal(rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities/nope`, fx.keys.owner).status, 404);
  fx.db.close();
});

test("a reported PAIR moves the observation column, and a lone record does not", () => {
  const fx = p4Fixture();
  const d = deploy(fx, "fleet-observed");
  allow(fx, fx.owner.agent_id, "report_outcome");

  const before = rest(fx, "GET", "/v1/assignments", fx.keys.owner);
  const beforeRow = before.body.items.find((i: any) => i.assignment_id === d.assignmentId);
  assert.equal(beforeRow.observed_arrival, "unknown");
  assert.match(beforeRow.observed_arrival_window, /no runtime record source is configured/);

  // a LONE call first: it is evidence of an attempt and not of an arrival
  const lone = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: fx.reviewer.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1_754_000_000_000,
    window_to_ms: 1_754_003_600_000,
    records: [{ role: "call", call_id: "x-1", at_ms: 1_754_000_000_000, text: `starting ${d.marker}` }],
  });
  assert.equal(lone.status, 201, lone.raw);
  const afterLone = rest(fx, "GET", "/v1/assignments", fx.keys.owner).body.items.find(
    (i: any) => i.assignment_id === d.assignmentId,
  );
  assert.equal(afterLone.observed_arrival, "unknown", "[M-5]: a lone call was read as an arrival");
  assert.equal(afterLone.observed_arrival_reason, "no_paired_record");
  assert.equal(afterLone.observed_records_read, 1, "the window must say what was searched");

  // now the PAIR
  const paired = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: fx.reviewer.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1_754_000_000_000,
    window_to_ms: 1_754_003_600_000,
    records: [
      { role: "call", call_id: "x-2", at_ms: 1_754_000_001_000, text: `starting ${d.marker}` },
      { role: "output", call_id: "x-2", at_ms: 1_754_000_002_000, text: `done ${d.marker}`, result: "success", evidence: { exit_code: 0 } },
    ],
  });
  assert.equal(paired.status, 201, paired.raw);
  const afterPair = rest(fx, "GET", "/v1/assignments", fx.keys.owner).body.items.find(
    (i: any) => i.assignment_id === d.assignmentId,
  );
  assert.equal(afterPair.observed_arrival, "yes", "the pair must move the observation column, or the seam is dead");
  assert.equal(afterPair.observed_arrival_reason, null);

  // …and the INTENT column did not move with it [I-2]
  assert.equal(afterPair.intent_state, "assigned");
  assert.equal(afterPair.intent_state_is, "intent");

  // [A-6]'s tuple is readable, with all six members
  const one = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities/${d.slug}`, fx.keys.owner);
  assert.equal(one.status, 200, one.raw);
  assert.equal(one.body.scan.length, 1);
  const tuple = one.body.scan[0];
  console.log(`[A-6] tuple: ${JSON.stringify(tuple)}`);
  assert.equal(tuple.skill_version_id, d.versionId);
  assert.equal(tuple.agent_id, fx.reviewer.agent_id);
  assert.equal(tuple.runtime, "codex");
  assert.equal(tuple.at_ms, 1_754_000_002_000);
  assert.equal(tuple.call_id, correlationDigest("x-2"), "the pairing id is published as the digest that is stored");
  assert.equal(tuple.result, "success");

  // the gap now reads the OTHER way round: observed, with no active intent
  const gap = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities`, fx.keys.owner).body.gap.find(
    (g: any) => g.skill_version_id === d.versionId,
  );
  assert.equal(gap.gap, "arrival_observed_without_active_intent");
  fx.db.close();
});

test("[I-7] a record's TEXT does not reach the database, the answer or a log line", () => {
  const fx = p4Fixture();
  const d = deploy(fx, "fleet-secret");
  allow(fx, fx.owner.agent_id, "report_outcome");
  const SECRET = "sk_live_do_not_store_me_9f2a";
  const PATH = "/home/someone/.claude/skills/private/SKILL.md";

  const res = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: fx.reviewer.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1,
    window_to_ms: 2,
    records: [
      { role: "call", call_id: "s-1", text: `${SECRET} running ${d.marker} from ${PATH}` },
      { role: "output", call_id: "s-1", text: `${SECRET} done ${d.marker}`, result: "success", evidence: { exit_code: 0 } },
    ],
  });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.records_text_stored, false);
  assert.ok(!res.raw.includes(SECRET), "the response echoed the record text");
  assert.ok(!res.raw.includes(PATH), "the response echoed an operator's absolute path");
  assert.equal(res.body.markers_recorded, 2, "the markers DID survive, or nothing was read at all");

  // the whole database, dumped, must not contain either string
  const tables = (fx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"));
  let scanned = 0;
  for (const table of tables) {
    for (const row of fx.db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>) {
      const dumped = JSON.stringify(row);
      scanned += 1;
      assert.ok(!dumped.includes(SECRET), `${table} stored the record text`);
      assert.ok(!dumped.includes(PATH), `${table} stored an absolute path from a record`);
    }
  }
  assert.ok(scanned > 0, "no row was scanned — this check would pass on an empty database");
  // and the table has nowhere to put it: the column does not exist
  const columns = (fx.db.prepare("PRAGMA table_info(observed_records)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!columns.includes("text"), "`observed_records` has a column that could hold a record's text");
  assert.ok(columns.includes("marker"));
  console.log(`[I-7] observed_records columns: ${columns.join(", ")}`);
  fx.db.close();
});

test("[I-8] the hints are true: three reads that touch a foreign disk, and one write that stores", () => {
  const byName = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t as any]));
  for (const name of ["fleet.list", "agent.capabilities", "capability.get"]) {
    const t = byName[name];
    assert.ok(t, `${name} is not advertised`);
    assert.equal(t.annotations.readOnlyHint, true, `${name} must be hinted as a read`);
    // A READ THAT TOUCHES A DISK IS STILL A READ, and the sweep is what says
    // so: `readOnlyHint` is compared with whether the call moved a row OR a
    // watched path, and these three moved neither. Reading a foreign directory
    // is not a write; it is an OPEN WORLD, which is the next line.
    assert.equal(
      t.annotations.openWorldHint,
      true,
      `${name} walks a filesystem that is not this registry's — the same reason assignment.activate carries it`,
    );
  }
  const report = byName["observation.report"];
  assert.equal(report.annotations.readOnlyHint, false, "a call that writes must not be hinted as a read [I-8]");
  // `destructiveHint`/`idempotentHint`: proved behaviourally over all 36 tools
  // in `test/p14-r2-invariants.test.ts`, not asserted as a literal here. The
  // clause covering the `destructiveHint: false` these three carry is
  // `destructiveHint declared true and the call only ADDED`, which fires the
  // moment a shipped `false` is flipped.
  //
  // THE ONE LITERAL THAT IS NOT COMING BACK, and the reason is not tidiness.
  // This test used to assert `report.annotations.destructiveHint === true`. It
  // was WRONG. `recordObservationInTx` runs two INSERTs and nothing else; this
  // call reaches no disk, asks for no foreign root, and removes and overwrites
  // nothing. The behavioural sweep says `false` and the sweep is right, so the
  // literal is recorded here as contradicted rather than restored — an
  // assertion is not owed a place just because it used to have one.
  assert.equal(report.annotations.openWorldHint, false, "the reporter did the reaching; this call stores its account");
  // the divergence is STATED in the description rather than papered over
  assert.match(report.description, /THIS TOOL WRITES/);
  assert.match(report.description, /list it among the READING surfaces/);

  // READ AND WRITE ARE SEPARATE NAMES — over EVERY tool, not the four this test
  // is about. [I-8] says so of the whole table, and a check over four entries
  // proves it of four entries: the very shape of finding that put 23 tools into
  // production with no annotations at all.
  //
  // The rule as it can honestly be stated: a tool advertised as READING may not
  // take an argument that could switch it into writing. `skill.review.request`
  // and `transfer_grant.create` do take an `action`, and both are writes in
  // every branch — the argument chooses WHICH write, never whether to write.
  let swept = 0;
  const switches: string[] = [];
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    swept += 1;
    for (const p of Object.keys(tool.inputSchema?.properties ?? {})) {
      if (!/^(mode|op)$/.test(p)) {
        if (!(p === "action" && tool.annotations?.readOnlyHint === false)) {
          if (/^(mode|action|op)$/.test(p)) switches.push(`${tool.name}: ${p}`);
        }
        continue;
      }
      switches.push(`${tool.name}: ${p}`);
    }
  }
  console.log(`[I-8] tools swept for a read/write mode argument: ${swept}`);
  assert.equal(swept, MCP_TOOLS.length, "the sweep must cover the whole tool table");
  assert.deepEqual(switches, [], "tools that could switch between reading and writing on an argument [I-8]");
});

test("the §6 surfaces enforce the same ACL and the same permission as the rest of the loop", () => {
  const fx = p4Fixture();
  deploy(fx, "fleet-acl");

  // a plain member reads exactly its own row
  const mine = rest(fx, "GET", "/v1/fleet", fx.keys.member);
  assert.equal(mine.status, 200, mine.raw);
  assert.deepEqual(mine.body.agents.map((a: any) => a.agent_id), [fx.member.agent_id]);
  // …and another principal's capabilities are ABSENT, not forbidden
  assert.equal(rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities`, fx.keys.member).status, 404);
  // an agent of another workspace likewise
  assert.equal(rest(fx, "GET", `/v1/fleet/${fx.outsider.agent_id}/capabilities`, fx.keys.owner).status, 404);

  // the write needs the §6.2 `report_outcome` grant and NO new role
  const body = {
    agent_id: fx.reviewer.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1,
    window_to_ms: 2,
    records: [],
  };
  const refused = rest(fx, "POST", "/v1/observations", fx.keys.owner, body);
  assert.equal(refused.status, 403, refused.raw);
  assert.match(refused.body.error.message, /report_outcome/);
  allow(fx, fx.owner.agent_id, "report_outcome");
  assert.equal(rest(fx, "POST", "/v1/observations", fx.keys.owner, body).status, 201);

  // [I-3] a report with no boundary is refused rather than defaulted, and the
  // boundary PHRASE is the registry's own: a reporter that sends one is refused
  // rather than ignored, because a boundary silently dropped would be believed
  const noBounds = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    ...body,
    window_from_ms: undefined,
    window_to_ms: undefined,
  });
  assert.equal(noBounds.status, 400, noBounds.raw);
  assert.match(noBounds.body.error.message, /window_from_ms/);
  const dictated = rest(fx, "POST", "/v1/observations", fx.keys.owner, { ...body, window_detail: "whatever I say" });
  assert.equal(dictated.status, 400, dictated.raw);
  assert.match(dictated.body.error.message, /window_detail/);
  const badRuntime = rest(fx, "POST", "/v1/observations", fx.keys.owner, { ...body, runtime: "emacs" });
  assert.equal(badRuntime.status, 400);
  // a report about an agent of another workspace is ABSENT
  assert.equal(
    rest(fx, "POST", "/v1/observations", fx.keys.owner, { ...body, agent_id: fx.outsider.agent_id }).status,
    404,
  );
  fx.db.close();
});

test("MCP and REST answer identically, and the write replays byte for byte", () => {
  const fx = p4Fixture();
  const d = deploy(fx, "fleet-mcp");
  allow(fx, fx.owner.agent_id, "report_outcome");

  const viaRest = rest(fx, "GET", "/v1/fleet", fx.keys.owner);
  const viaMcp = mcp(fx, fx.keys.owner, "fleet.list", {});
  assert.equal(viaMcp.isError, false);
  assert.deepEqual(viaMcp.data, viaRest.body, "the two adapters must not diverge (§2)");

  const capsRest = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities`, fx.keys.owner);
  const capsMcp = mcp(fx, fx.keys.owner, "agent.capabilities", { agent_id: fx.reviewer.agent_id });
  assert.deepEqual(capsMcp.data, capsRest.body);

  const args = {
    agent_id: fx.reviewer.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1,
    window_to_ms: 2,
    records: [
      { role: "call", call_id: "m-1", text: `run ${d.marker}` },
      { role: "output", call_id: "m-1", text: `ok ${d.marker}`, result: "success", evidence: { exit_code: 0 } },
    ],
    idempotency_key: "obs-1",
  };
  const first = mcp(fx, fx.keys.owner, "observation.report", args);
  assert.equal(first.isError, false);
  const replay = mcp(fx, fx.keys.owner, "observation.report", args);
  assert.deepEqual(replay.data, first.data, "an idempotency key replays the original response");
  const observations = fx.db.prepare("SELECT COUNT(*) AS c FROM runtime_observations").get() as { c: number };
  assert.equal(observations.c, 1, "a replay wrote a second report");

  // and a capability.get over MCP names the tuple
  const one = mcp(fx, fx.keys.owner, "capability.get", { agent_id: fx.reviewer.agent_id, name: d.slug });
  assert.equal(one.data.scan.length, 1);
  assert.equal(one.data.scan[0].call_id, correlationDigest("m-1"));
  fx.db.close();
});

test("a report is INSERT-only: it cannot be edited or withdrawn", () => {
  const fx = p4Fixture();
  const d = deploy(fx, "fleet-insert-only");
  allow(fx, fx.owner.agent_id, "report_outcome");
  const res = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: fx.reviewer.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1,
    window_to_ms: 2,
    records: [{ role: "call", call_id: "i-1", text: `run ${d.marker}` }],
  });
  assert.equal(res.status, 201, res.raw);
  // POPULATED first, then probed: a constraint proven on an empty table is
  // proven against nothing
  const rows = fx.db.prepare("SELECT COUNT(*) AS c FROM observed_records").get() as { c: number };
  assert.equal(rows.c, 1, "the probe below needs a row to act on");
  assert.throws(
    () => fx.db.prepare("UPDATE observed_records SET marker='SKLN1-AAAAAAAAAAAAAAAA'").run(),
    /INSERT_ONLY/,
  );
  assert.throws(() => fx.db.prepare("DELETE FROM observed_records").run(), /INSERT_ONLY/);
  assert.throws(() => fx.db.prepare("UPDATE runtime_observations SET window_detail='x'").run(), /INSERT_ONLY/);
  assert.throws(() => fx.db.prepare("DELETE FROM runtime_observations").run(), /INSERT_ONLY/);
  // and the schema refuses a marker that is not one
  assert.throws(
    () =>
      fx.db
        .prepare(
          "INSERT INTO observed_records(id,observation_id,agent_id,runtime,role,call_id,at_ms,marker,result,server_at_ms) " +
            "SELECT ?,observation_id,agent_id,runtime,role,call_id,at_ms,?,result,server_at_ms FROM observed_records LIMIT 1",
        )
        .run(ulid(1_754_000_000_000), "not-a-marker"),
    /CHECK|constraint/i,
  );
  fx.db.close();
});

test("the inventory root is CONFIGURATION: a deployment names it, and a bare start names nowhere", () => {
  // D-7's rule as a property of the deployment rather than of a constructor
  // argument: pointing this registry at a fleet member's directories is a
  // variable an operator writes down, not a code change — and a half-written
  // one is refused rather than half-obeyed.
  const saved = {
    root: process.env.SKILLONOMIA_INVENTORY_ROOT,
    runtime: process.env.SKILLONOMIA_INVENTORY_RUNTIME,
  };
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const dataDir = join(base, "data");
  const lines: string[] = [];
  const start = (): any =>
    serve({ port: 0, dataDir, workerIntervalMs: 0, installSeedPackage: false, log: (l) => lines.push(l) });
  try {
    // (a) nothing set: the process starts and says in as many words that it
    //     will walk nothing, and what the numbers will therefore be
    delete process.env.SKILLONOMIA_INVENTORY_ROOT;
    delete process.env.SKILLONOMIA_INVENTORY_RUNTIME;
    const bare = start();
    bare.close();
    const offLine = lines.find((l) => l.startsWith("fleet inventory"));
    assert.ok(offLine, "a start must say whether it can read a fleet member's directories");
    assert.match(offLine, /off/);
    assert.match(offLine, /`unknown`, never zero/, "…and what an inventory answers instead");

    // (b) a root with no layout, and a layout with no root, are REFUSED
    process.env.SKILLONOMIA_INVENTORY_ROOT = root;
    assert.throws(start, /SKILLONOMIA_INVENTORY_RUNTIME must be one of/, "a root with no layout was accepted");
    delete process.env.SKILLONOMIA_INVENTORY_ROOT;
    process.env.SKILLONOMIA_INVENTORY_RUNTIME = "codex";
    assert.throws(start, /without SKILLONOMIA_INVENTORY_ROOT/, "a layout with no place was accepted");

    // (c) both set: the inventory is on, and the start says so
    process.env.SKILLONOMIA_INVENTORY_ROOT = root;
    lines.length = 0;
    const configured = start();
    configured.close();
    const onLine = lines.find((l) => l.startsWith("fleet inventory"));
    assert.ok(onLine && /ON/.test(onLine), `a configured start must say so: ${onLine}`);
    assert.match(onLine!, /NOWHERE else/, "…and must state the boundary it reads within");

    // (d) a relative root is refused, and a `~` one is refused rather than
    //     expanded: a place this process derived is a place nobody chose
    process.env.SKILLONOMIA_INVENTORY_ROOT = "relative/path";
    assert.throws(start, /absolute/, "a relative root was accepted");
    process.env.SKILLONOMIA_INVENTORY_ROOT = "~/skills";
    assert.throws(start, /absolute/, "a `~` root was expanded rather than refused");
  } finally {
    if (saved.root === undefined) delete process.env.SKILLONOMIA_INVENTORY_ROOT;
    else process.env.SKILLONOMIA_INVENTORY_ROOT = saved.root;
    if (saved.runtime === undefined) delete process.env.SKILLONOMIA_INVENTORY_RUNTIME;
    else process.env.SKILLONOMIA_INVENTORY_RUNTIME = saved.runtime;
  }
  // the two variables are documented with an EMPTY default, so the shipped
  // configuration cannot be read as naming a place
  const ops = readFileSync(new URL("../docs/OPERATIONS.md", import.meta.url), "utf8");
  for (const v of ["SKILLONOMIA_INVENTORY_ROOT", "SKILLONOMIA_INVENTORY_RUNTIME"]) {
    assert.ok(ops.includes(`\`${v}\` | — |`), `OPERATIONS.md must document ${v} with no default`);
  }
});

test("every capability kind is answered for an agent with no configured root — unknown, never zero", () => {
  const fx = p4Fixture();
  const d = deploy(fx, "fleet-no-root");
  allow(fx, fx.owner.agent_id, "report_outcome");

  // BEFORE anything is known about the runtime, the column set itself is
  // `unknown` — WITH a reason, because which columns exist is a property of the
  // runtime and an unexplained empty table reads as an empty inventory [I-1]
  const blind = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities`, fx.keys.owner);
  assert.equal(blind.status, 200, blind.raw);
  assert.deepEqual(blind.body.columns, []);
  assert.match(blind.body.columns_reason ?? "", /runtime_unknown/);
  assert.equal(blind.body.agent.runtime, null);
  assert.equal(blind.body.agent.runtime_source, "none");

  // a report establishes the RUNTIME without establishing anything about a disk
  const reported = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: fx.reviewer.agent_id,
    runtime: "codex",
    window: "period",
    window_from_ms: 1,
    window_to_ms: 2,
    records: [],
  });
  assert.equal(reported.status, 201, reported.raw);

  const caps = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities`, fx.keys.owner);
  assert.equal(caps.status, 200, caps.raw);
  assert.deepEqual(caps.body.columns, [...columnsOf("codex")]);
  assert.equal(caps.body.columns_reason, null);
  assert.equal(caps.body.inventory.length, CAPABILITY_KINDS.length, "a kind was dropped rather than answered [I-1]");
  for (const n of caps.body.inventory) {
    assert.equal(n.measurement_state, "unknown");
    assert.equal(n.value, null, "an unwalked root reported a count of zero");
    assert.equal(n.reason, "no_inventory_root_configured");
    assert.equal(missingAttribute(n), null);
  }
  // …and the capability that IS assigned reports `registered: unknown`, not `no`
  const cap = caps.body.capabilities.find((c: any) => c.name === d.slug);
  assert.ok(cap, "the assigned skill must be answered even with no disk to look at");
  assert.equal(cellOf(cap.columns, "registered").value, "unknown", "an unwalked disk was reported as an empty one");
  assert.equal(cellOf(cap.columns, "registered").reason, "no_inventory_root_configured");
  assert.equal(caps.body.dead_weight.registered.value, 0, "nothing was found because nothing was walked");
  assert.equal(caps.body.inventory_reason, "no_inventory_root_configured");
  fx.db.close();
});

// ===========================================================================
// 9. [D-2]/[M-6] — THE CONTRACT IS EXECUTED, AND THE REPORTER'S WORD IS NOT
// ===========================================================================
//
// The probes in `test/p14-r5-probes.test.ts` were written before the fix and
// failed on the tree that carried the defect; that is their discrimination
// proof. What is here is the OTHER half the rules of this round demand: NEW
// probes, not the ones that found it, and a sweep over the WHOLE cross product
// rather than over the three cases somebody thought of.

/** Every kind of check the code declares, each with the parameter its own kind
 *  requires and the evidence that satisfies or refutes it. Derived from
 *  `OUTCOME_CHECK_SHAPE`, so a kind added tomorrow fails this test until its
 *  row is written. */
const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const CHECK_CASES: ReadonlyArray<{
  kind: string;
  contract: any;
  satisfying: Record<string, unknown>;
  refuting: Record<string, unknown>;
}> = [
  {
    kind: "exit_code",
    contract: { check: { kind: "exit_code", exit_code: 0 }, evidence: ["exit_code"], unknown: "nothing was evaluated, which is not a failure" },
    satisfying: { exit_code: 0 },
    refuting: { exit_code: 3 },
  },
  {
    // 2.3: `stdout` is carried as a DIGEST, so a `stdout_match` is an equality
    // of digests. A substring pattern is no longer executable by this registry
    // and is exercised as its own case, below.
    kind: "stdout_match",
    contract: { check: { kind: "stdout_match", stdout_match: DIGEST_A }, evidence: ["stdout_sha256"], unknown: "nothing was evaluated, which is not a failure" },
    satisfying: { stdout_sha256: DIGEST_A },
    refuting: { stdout_sha256: DIGEST_B },
  },
  {
    kind: "artifact_exists",
    contract: { check: { kind: "artifact_exists", artifact_path: "out/report.json" }, evidence: ["artifacts"], unknown: "nothing was evaluated, which is not a failure" },
    // THE DIGESTS OF THE PATHS, not the paths: an `artifact_path` is a string
    // an author signed, and round 8 stopped admitting one as a value.
    satisfying: { artifacts: [evidenceDigestOf("out/report.json"), evidenceDigestOf("out/log.txt")] },
    refuting: { artifacts: [evidenceDigestOf("out/log.txt")] },
  },
  {
    kind: "command",
    contract: { check: { kind: "command", command: "./verify.sh" }, evidence: ["command", "exit_code"], unknown: "nothing was evaluated, which is not a failure" },
    satisfying: { command: evidenceDigestOf("./verify.sh"), exit_code: 0 },
    refuting: { command: evidenceDigestOf("./verify.sh"), exit_code: 1 },
  },
];

test("[D-2] over the WHOLE cross product, `outcome` moves only where a check was EXECUTED — and only the registry's own reading is a verdict", () => {
  // THE SET IS THE CROSS PRODUCT, not a sample: every declared check kind ×
  // every word a reporter can write × every state its evidence can be in ×
  // BOTH PROVENANCES. A kind added to `OUTCOME_CHECK_SHAPE` and not to
  // `CHECK_CASES` fails here.
  //
  // THE SECOND AXIS IS D-18. The same evidence means two different things
  // depending on WHO PRODUCED IT: presented by a principal about its own
  // machine it is a self-report, and the verdict stays `unknown` while the
  // report's own conclusion is published under its own name; read by this
  // registry under the root it manages it is an observation, and there `yes`
  // and `no` are the registry's own. Sweeping only the first axis is what let
  // `outcome` print `yes` for a process nobody ran.
  assert.deepEqual(
    CHECK_CASES.map((c) => c.kind).sort(),
    [...OUTCOME_CHECK_KINDS].sort(),
    "a check kind the code declares that this sweep does not exercise",
  );
  const WORDS = ["success", "failure", "unknown"] as const;
  const EVIDENCE: Array<[string, (c: (typeof CHECK_CASES)[number]) => Record<string, unknown> | null]> = [
    ["none at all", () => null],
    ["empty", () => ({})],
    ["for another check", () => ({ some_other_value: 1 })],
    ["satisfying", (c) => c.satisfying],
    ["refuting", (c) => c.refuting],
  ];
  let swept = 0;
  let claimed = 0;
  let observed = 0;
  const wrong: string[] = [];
  for (const c of CHECK_CASES) {
    for (const word of WORDS) {
      for (const [label, build] of EVIDENCE) {
        const presented = build(c);
        const executed = label === "satisfying" || label === "refuting";
        const conclusion = label === "satisfying" ? "yes" : label === "refuting" ? "no" : null;

        // ---- the SELF-REPORT axis: the values came from the addressee
        swept += 1;
        const asClaim = cellOf(
          capabilityColumns(
            evidence({
              snapshot: snapshot([
                record({ role: "call", call_id: `x-${swept}` }),
                record({ role: "output", call_id: `x-${swept}`, result: word, evidence: selfReported(presented) }),
              ]),
              outcome_contract: c.contract,
              reported_by: { type: "agent" },
            }),
          ),
          "outcome",
        );
        if (asClaim.value !== "unknown") {
          wrong.push(`${c.kind} · reporter said \`${word}\` · evidence ${label} · SELF-REPORT → ${asClaim.value}, and a self-report is never a verdict`);
        }
        if ((asClaim.assessment?.claim ?? null) !== conclusion) {
          wrong.push(`${c.kind} · reporter said \`${word}\` · evidence ${label} · SELF-REPORT → claim ${asClaim.assessment?.claim ?? "none"}, expected ${conclusion ?? "none"}`);
        }
        if (executed) {
          claimed += 1;
          if (asClaim.assessment?.basis !== "self_report") wrong.push(`${c.kind} · ${label} · a claim was published as an observation`);
          if (asClaim.assessment?.assessed_by !== "principal") wrong.push(`${c.kind} · ${label} · the claim was attributed to the registry`);
          if (asClaim.assessment?.principal_type !== "agent") wrong.push(`${c.kind} · ${label} · the claim lost the principal's type [I-5]`);
          if ((asClaim.assessment?.reason ?? "").length === 0) wrong.push(`${c.kind} · ${label} · a verdict with no reason [I-3]`);
        }

        // ---- the OBSERVATION axis: the registry produced the same values
        swept += 1;
        const asObservation = cellOf(
          capabilityColumns(
            evidence({
              snapshot: snapshot([
                record({ role: "call", call_id: `o-${swept}` }),
                record({ role: "output", call_id: `o-${swept}`, result: word, evidence: null }),
              ]),
              outcome_contract: c.contract,
              observed_evidence: presented === null ? null : registryObserved(presented),
              reported_by: { type: "agent" },
            }),
          ),
          "outcome",
        );
        // THE NARROWING. Even values this registry produced ITSELF decide
        // nothing for a check whose subject is a process on somebody else's
        // machine. `observable` is read off `OUTCOME_CHECK_SHAPE`, so the set of
        // kinds that may answer is the CODE's and not a list kept here.
        const observable = OUTCOME_CHECK_SHAPE[c.kind]!.observable;
        const expected = observable ? (conclusion ?? "unknown") : "unknown";
        if (asObservation.value !== expected) {
          wrong.push(`${c.kind} · reporter said \`${word}\` · evidence ${label} · OBSERVATION → ${asObservation.value} (${asObservation.reason}), expected ${expected}`);
        }
        if (asObservation.value !== "unknown") {
          observed += 1;
          if (asObservation.assessment?.basis !== "registry_observation") {
            wrong.push(`${c.kind} · ${label} · the registry's own reading was published as a claim`);
          }
          if (asObservation.assessment?.assessed_by !== "registry") {
            wrong.push(`${c.kind} · ${label} · the registry's own reading was attributed to a principal`);
          }
          if (asObservation.assessment?.claim !== null) {
            wrong.push(`${c.kind} · ${label} · a reading of this registry's own disk carried somebody's claim`);
          }
        }
        // EVERY cell of the sweep carries its provenance, not only the ones a
        // check moved: `basis` is the method, not a note about an exception.
        for (const cell of [asClaim, asObservation]) {
          if (missingVerdictAttribute(cell) !== null) {
            wrong.push(`${c.kind} · ${label} · a verdict missing \`${missingVerdictAttribute(cell)}\` [I-3], [D-18]`);
          }
        }
        // an answer that is not `yes` always carries a reason a machine can read
        for (const cell of [asClaim, asObservation]) {
          if (cell.value !== "yes") assert.ok((cell.reason ?? "").length > 0, "an answer with no reason");
        }
      }
    }
  }
  console.log(`[D-2] combinations swept: ${swept} (${CHECK_CASES.length} check kinds × ${WORDS.length} reported words × ${EVIDENCE.length} evidence states × 2 provenances)`);
  console.log(`[D-2] self-reports whose own conclusion was published: ${claimed} — and NONE of them moved the verdict`);
  console.log(`[D-2] verdicts the registry established by its own reading: ${observed}`);
  assert.deepEqual(wrong, [], "the reporter's word, the absence of evidence, or a claim dressed as an observation moved the outcome column");
  assert.equal(claimed, CHECK_CASES.length * WORDS.length * 2, "a self-report's conclusion must be published for the two evidence states that run the check, and only those");
  const observableKinds = CHECK_CASES.filter((c) => OUTCOME_CHECK_SHAPE[c.kind]!.observable).length;
  console.log(`[D-2] check kinds this registry may observe at all: ${observableKinds} of ${CHECK_CASES.length} — the narrowing`);
  assert.equal(
    observed,
    observableKinds * WORDS.length * 2,
    "the registry's own reading must move the column for the OBSERVABLE kinds' two executed states, and for nothing else",
  );
});

test("[D-2] the evaluator that trusts the reporter is killed on the same records", async () => {
  // THE MUTATION IS THE CODE THAT SHIPPED, restored exactly: `outcome` read
  // `paired[last].result`, the field the reporting agent fills in.
  const m = await mutant(
    "fleet.ts",
    [
      `  const outcomeReason = outcome.value === "yes" ? null : outcome.reason;`,
      `  let outcomeReason = outcome.value === "yes" ? null : outcome.reason;
  const last = paired[paired.length - 1];
  if (last !== undefined && ev.outcome_contract) {
    if (last.result === "success") {
      outcome = { ...outcome, value: "yes", assessed_by: "registry", basis: "registry_observation" };
      outcomeReason = null;
    } else if (last.result === "failure") {
      outcome = { ...outcome, value: "no", assessed_by: "registry", basis: "registry_observation" };
      outcomeReason = "contract_not_satisfied";
    }
  }`,
    ],
  );
  const declared = [
    record({ role: "call", call_id: "trust-1" }),
    record({ role: "output", call_id: "trust-1", result: "success" }),
  ];
  const shipped = cellOf(capabilityColumns(evidence({ snapshot: snapshot(declared), outcome_contract: CONTRACT })), "outcome");
  const mutated = m.capabilityColumns(evidence({ snapshot: snapshot(declared), outcome_contract: CONTRACT })).find(
    (c: any) => c.column === "outcome",
  );
  console.log(`  [shipped] a reporter's own \`success\`, no evidence → ${shipped.value} (${shipped.reason})`);
  console.log(`  [mutant ] the same records                        → ${mutated.value} (${mutated.reason ?? "—"})`);
  assert.equal(shipped.value, "unknown", "the shipped build must refuse, or the mutation proves nothing");
  killed("the evaluator that reads `result` answered `unknown` anyway", () => {
    assert.equal(mutated.value, "unknown");
  });
});

test("[D-2] the outcome path does not READ the field a reporter fills in", () => {
  // THE STRUCTURAL HALF, over the source rather than over an answer: whatever
  // the column computes, it must not be computing it from `result`. A future
  // edit that reintroduces the read fails here before any test of behaviour.
  const logic = readFileSync(new URL("../src/fleet.ts", import.meta.url), "utf8");
  const start = logic.indexOf("// ---- outcome:");
  assert.ok(start > 0, "the outcome section of `capabilityColumns` was renamed");
  const section = logic
    .slice(start, logic.indexOf("out.push(column(\"outcome\"", start))
    .replace(/^\s*\/\/.*$/gm, " ");
  console.log(`[D-2] the outcome section of src/fleet.ts, comments removed: ${section.split("\n").filter((l) => l.trim().length > 0).length} lines of code`);
  assert.ok(!/\.result\b/.test(section), "the outcome column reads `result` — the field the REPORTING agent fills in [M-6]");
  // THE ANSWER IS REACHED THROUGH THE ASSESSOR, which is the function that
  // executes the contract AND says on whose authority the answer stands
  // [D-18]. Asserting `evaluateOutcome` here would now be asserting the wrong
  // call: this column may not publish a raw contract verdict, because a
  // verdict with no provenance is the defect D-18 removed.
  assert.match(section, /assessOutcome\(/, "…and it must reach the answer by asking the assessor");
  assert.ok(!/evaluateOutcome\(/.test(section), "the column publishes a contract verdict with no provenance [I-3], [D-18]");
  // …and the evaluator itself never READS it either. The comparison is over
  // the CODE, with the comments removed: `src/outcome.ts` describes the defect
  // it was written against and naming a thing is not reading it.
  const code = readFileSync(new URL("../src/outcome.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  console.log(`[D-2] src/outcome.ts, comments removed: ${code.split("\n").filter((l) => l.trim().length > 0).length} lines of code`);
  assert.ok(!/\bresult\b/.test(code), "src/outcome.ts reads `result`, which is not one of its inputs");
  // …and the assessor does not invent a verdict of its own: it executes the
  // contract, exactly as D-14 required, and then says who the evidence came
  // from — which is the whole of the change D-18 made.
  //
  // SINCE 2.1 THE TWO ARE ONE EXPRESSION, and that is what is asserted here.
  // `assessOutcome` no longer computes a verdict and then decides how to label
  // it: it hands the CONTRACT and the MARKED VALUES to the one publisher, and
  // the publisher executes the contract against the very object it reads the
  // attribution off. A verdict computed from one party's data and published on
  // the other's authority is not refused by a check — it cannot be written.
  assert.match(
    code,
    /function publish\(evidence[\s\S]{0,900}?evaluateOutcome\(contract, evidence\)/,
    "the one publisher does not execute the contract against the values it was handed",
  );
  assert.match(code, /publish\(input\.claimed/, "`assessOutcome` publishes a principal's values by some route other than the one publisher");
  assert.match(code, /publish\(input\.observed/, "`assessOutcome` publishes the registry's own values by some route other than the one publisher");
});
