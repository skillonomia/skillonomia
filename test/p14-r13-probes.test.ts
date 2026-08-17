// ROUND 13 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks are composed from
// the STATEMENT OF THE REQUIREMENT, committed first, and must FAIL on the code
// as it stands. A probe written after the fix cannot discriminate — it was
// shaped by the answer.
//
// THE DEFECT, AND IT IS ONE LINE. `evidenceDigestOf` (src/outcome.ts) reduces a
// string to `sha256:` of `update(text, "utf8")`. Both runtimes replace EVERY
// LONE SURROGATE with U+FFFD while encoding a JS string to UTF-8, so two
// strings that are DIFFERENT to JavaScript —
//
//     "\ud800" !== "\ud801"                    → true
//
// — have exactly ONE digest:
//
//     digest("\ud800") === digest("\ud801")    → true
//
// Every column this project reduced to a digest was reduced on the promise that
// "equality survives a hash exactly" (src/journal.ts). For this class of string
// it does not: INEQUALITY does not survive it. Two columns are affected, and
// both are load-bearing —
//
//   `observed_records.call_id`, which binds a call to its output [M-5];
//   `receipt_events.idempotency_key`, which binds a retry to the call it repeats.
//
// WHAT IT IS IN THE PRODUCT, inside D-21's threat model and with nothing but
// the shipped API and the agent's own data: a fleet agent reports a `call` with
// `call_id: "\ud800"` and an `output` with `call_id: "\ud801"`. The call and the
// output DO NOT SHARE AN ID. The report is accepted, the two ids land as one
// digest, the pair rule sees a pair, and `observed_arrival` publishes `yes`.
// [M-5] says a call and an output are a pair only when they share ONE non-empty
// id; the observable behaviour of the product says otherwise, which is D-20's
// blocker.
//
// AND THE SAME COLLAPSE ON THE OTHER COLUMN: two DIFFERENT idempotency keys
// become one, so an adopter's second, different append is answered `noop: true`
// — the registry reports having recorded something it never recorded.
//
// WHAT THE FIX MAY NOT BE. Encoding the same string as `utf16le` distinguishes
// these strings and is FORBIDDEN: digests of `call_id` and `idempotency_key`
// are already stored, the originals are gone, and no migration can recover
// them, so changing the encoding would silently invalidate every digest this
// registry has ever written — a reader would stop finding its own strings.
//
// WHAT THE FIX IS. THE PRIMITIVE REFUSES TO HASH WHAT IT CANNOT HASH
// INJECTIVELY. A string that is not well-formed UTF-16 has no faithful UTF-8
// encoding, so `evidenceDigestOf` throws instead of returning a value that
// silently means two things. It is done IN THE PRIMITIVE — the one point every
// caller goes through — so that no caller can forget, which is the same shape
// as B-2's `mintCell` + `WeakSet`. A boundary turns that refusal into a plain
// `INVALID_SCHEMA` with a reason; it does not RESTATE the rule, because two
// statements of one rule are how they come apart (round 5, round 9b, D-12).
//
// The five probes, in the order the requirement states them:
//
//   13.1 the reviewer's attack, verbatim, through the shipped REST surface;
//   13.2 two different idempotency keys, and the false `noop` they produce;
//   13.3 the UNIVERSAL form — every shape of lone surrogate, refused; every
//        well-formed text, including emoji and correct surrogate pairs, kept;
//   13.4 THE COVERAGE GUARD: the set of callers is taken by WALKING `src/`,
//        never from a list in this file, and every one of them is shown not to
//        reach the hash with such a string. A caller added tomorrow lands in
//        the guard by itself. With the mutation that proves the guard can fail;
//   13.5 Node and Bun, asked the same questions explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { p4Fixture, reviewedVersion, rest, NOW, type P4Fixture } from "./p6-helpers.ts";
import { arrivalMarker } from "../src/marker.ts";
import { correlationDigest } from "../src/journal.ts";
import { requestDigest } from "../src/assignment-lifecycle.ts";
import { evidenceDigestOf, evaluateOutcome } from "../src/outcome.ts";
import { outcomeContractOf } from "../src/manifest.ts";
import { registryObservedEvidence } from "../src/activation.ts";
import { TranscriptObservations } from "../src/fleet-scan.ts";
import { openSqlite } from "../src/sqlite.ts";
import { TRANSFER_ACTION } from "../src/transfer.ts";
import { ulid } from "../src/ulid.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

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

/** The digest computed HERE, from the arithmetic the module is not allowed to
 *  change: a probe that borrowed the module's own function would prove only
 *  that it agrees with itself. */
function rawDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * THE SHAPES OF THE DEFECT, and the probe asks the UNIVERSAL question rather
 * than the particular one. "A lone high surrogate is refused" is a fix for a
 * probe; the class is EVERY string JavaScript admits and UTF-8 cannot carry.
 *
 * Each pair is two strings that are DIFFERENT (`!==`) and share ONE digest
 * under the shipped arithmetic — which every case asserts for itself below, so
 * that a runtime where the collapse did not happen would be reported rather
 * than quietly passing.
 */
const COLLIDING: ReadonlyArray<{ what: string; a: string; b: string }> = [
  { what: "a lone HIGH surrogate", a: "\ud800", b: "\ud801" },
  { what: "a lone LOW surrogate", a: "\udc00", b: "\udc01" },
  { what: "a surrogate in the MIDDLE of an ordinary id", a: "call-\ud800-1", b: "call-\ud801-1" },
  { what: "TWO invalid ones in a row", a: "\ud800\ud800", b: "\ud800\ud801" },
  { what: "a HIGH surrogate followed by an ordinary letter", a: "\ud800x", b: "\ud801x" },
  { what: "a broken pair — high, then a lone low far away", a: "\ud83dA\udc00", b: "\ud83dA\udc01" },
];

/** Every non-well-formed string named above, once. */
const NOT_WELL_FORMED: readonly string[] = [...new Set(COLLIDING.flatMap((c) => [c.a, c.b]))];

/** WELL-FORMED TEXT, WHICH MUST GO ON WORKING. A refusal that also refused
 *  emoji would be a registry no runtime could report to — the fix has to
 *  discriminate, and this is the half that proves it does. */
const WELL_FORMED: readonly string[] = [
  "call_1",
  "tool-call-01JZ8",
  "😀", // U+1F600 — a CORRECT surrogate pair
  "\ud83d\ude80", // a correct pair written as ESCAPES, so the source says which code units
  "приветствие",
  "日本語のテキスト",
  "a\u0000b", // NUL is well-formed, however unusual
  "￿", // a noncharacter is well-formed too: the rule is UTF-16, not taste
];

/** Human-readable code units, for output that can be read in a terminal. */
function units(text: string): string {
  return [...text].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
}

// ===========================================================================
// 13.1 — THE REVIEWER'S ATTACK, VERBATIM
// ===========================================================================

interface Deployed {
  fx: P4Fixture;
  assignmentId: string;
  versionId: string;
  slug: string;
  marker: string;
}

/** A version, reviewed, transferred to `fx.reviewer` — so that `observed_arrival`
 *  is a column with a row to print, exactly as the shipped dashboard shows it. */
function deploy(fx: P4Fixture, slug: string): Deployed {
  const v = reviewedVersion(fx, slug);
  assert.equal(
    rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
      agent_id: fx.member.agent_id,
      action: TRANSFER_ACTION,
      recipient_scope: "local_agent",
    }).status,
    201,
  );
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

/** Every `call_id` this database holds, as stored. */
function storedCallIds(fx: P4Fixture): string[] {
  return (fx.db.prepare("SELECT call_id FROM observed_records ORDER BY id").all() as Array<{ call_id: string | null }>).map(
    (r) => r.call_id ?? "NULL",
  );
}

function assignmentRow(d: Deployed): any {
  return rest(d.fx, "GET", "/v1/assignments", d.fx.keys.owner).body.items.find(
    (i: any) => i.assignment_id === d.assignmentId,
  );
}

test("[13.1] a call and an output that DO NOT share an id are not a pair, and `observed_arrival` does not say `yes`", () => {
  for (const shape of COLLIDING) {
    const fx = p4Fixture();
    const d = deploy(fx, `r13-arrival-${COLLIDING.indexOf(shape)}`);
    allow(fx, fx.reporter.agent_id, "report_outcome");

    // the two ids ARE different strings, and the shipped arithmetic DOES give
    // them one digest — stated here so that the attack below is not merely
    // asserted to be an attack
    assert.notEqual(shape.a, shape.b, `${shape.what}: the two ids are the same string, so this is not the attack`);
    assert.equal(
      rawDigest(shape.a),
      rawDigest(shape.b),
      `${shape.what}: sha256 of the UTF-8 bytes separates these two, so this runtime does not have the defect`,
    );

    const planted = rest(fx, "POST", "/v1/observations", fx.keys.reporter, {
      agent_id: fx.reviewer.agent_id,
      runtime: "codex",
      window: "period",
      window_from_ms: 1_754_000_000_000,
      window_to_ms: 1_754_003_600_000,
      records: [
        { role: "call", call_id: shape.a, at_ms: 1_754_000_001_000, text: `starting ${d.marker}` },
        {
          role: "output",
          call_id: shape.b,
          at_ms: 1_754_000_002_000,
          text: `done ${d.marker}`,
          result: "success",
          evidence: { exit_code: 0 },
        },
      ],
    });
    const row = assignmentRow(d);
    console.log(
      `  ${shape.what.padEnd(46)} call=${units(shape.a).padEnd(16)} output=${units(shape.b).padEnd(16)} → ` +
        `${planted.status} ${planted.raw.slice(0, 40)} | stored=${JSON.stringify(storedCallIds(fx))} | ` +
        `observed_arrival=${row?.observed_arrival} (${row?.observed_arrival_reason})`,
    );

    // THE REQUIREMENT, in the form the requirement states it: the report is
    // refused, or — if some later reading admits it — the column does not say
    // `yes`. Both halves are the same sentence: two ids that differ never make
    // a pair [M-5].
    if (planted.status === 201) {
      assert.notEqual(
        row.observed_arrival,
        "yes",
        `${shape.what}: a call and an output with DIFFERENT ids were published as an arrival [M-5]`,
      );
    } else {
      assert.match(planted.raw, /INVALID_SCHEMA/, "the refusal must be a schema refusal, so the reporter is told why");
      assert.deepEqual(storedCallIds(fx), [], "a refused report left rows behind");
      assert.notEqual(row.observed_arrival, "yes");
    }

    // …AND THE SCANNER TUPLE, which is the other place the pair is published.
    const one = rest(fx, "GET", `/v1/fleet/${fx.reviewer.agent_id}/capabilities/${d.slug}`, fx.keys.owner);
    assert.equal(one.status, 200, one.raw);
    assert.deepEqual(
      one.body.scan,
      [],
      `${shape.what}: [A-6] published a scan tuple for a call and an output that never shared an id`,
    );
    fx.db.close();
  }
});

// ===========================================================================
// 13.2 — TWO DIFFERENT IDEMPOTENCY KEYS, AND THE FALSE `noop`
// ===========================================================================

/** A request + receipt shell, the shape §5.3 appends against. */
function receiptShell(fx: P4Fixture, versionId: string, adopter = fx.member.agent_id): string {
  const requestId = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
    )
    .run(requestId, versionId, adopter, NOW);
  const receiptId = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
    )
    .run(receiptId, requestId, versionId, adopter, NOW);
  return receiptId;
}

test("[13.2] two DIFFERENT idempotency keys are two keys: the second append is not answered `noop`", () => {
  for (const shape of COLLIDING) {
    const fx = p4Fixture();
    const v = reviewedVersion(fx, `r13-key-${COLLIDING.indexOf(shape)}`);
    const receipt = receiptShell(fx, v.versionId);

    const first = rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.member, {
      event: "delivered",
      idempotency_key: shape.a,
    });
    // A SECOND, DIFFERENT APPEND under a SECOND, DIFFERENT key. `attempted` is
    // legal from `delivered`, so the only thing that can make this a `noop` is
    // the registry believing the two keys are one.
    const second = rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.member, {
      event: "attempted",
      idempotency_key: shape.b,
    });
    const events = (
      fx.db
        .prepare("SELECT event, event_seq FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq")
        .all(receipt) as Array<{ event: string; event_seq: number }>
    ).map((e) => `${e.event_seq}:${e.event}`);
    console.log(
      `  ${shape.what.padEnd(46)} first=${first.status} ${String(first.raw).slice(0, 46)} | ` +
        `second=${second.status} ${String(second.raw).slice(0, 46)} | rows=${JSON.stringify(events)}`,
    );

    if (first.status === 200) {
      assert.notEqual(
        second.body?.noop,
        true,
        `${shape.what}: a DIFFERENT key was replayed as a repeat of the first — the adopter is told its append was ` +
          `recorded and nothing was recorded`,
      );
    } else {
      assert.match(String(first.raw), /INVALID_SCHEMA/, "a key this registry cannot key by must be refused, with a reason");
      assert.match(String(second.raw), /INVALID_SCHEMA/);
      assert.deepEqual(events, [], "a refused append left a row behind");
    }
    fx.db.close();
  }
});

/**
 * THE OTHER IDEMPOTENCY COLUMN — `idempotency_keys.key`, which is stored
 * VERBATIM rather than as a digest, and which the round-13 requirement did not
 * name because the collapse there is not the digest's.
 *
 * IT IS THE SAME CLASS ONE LAYER DOWN, and the two runtimes differ, which is
 * why it is written out: a key of `"\ud800"` reaches SQLite as a JS string, and
 *
 *   * NODE encodes it to UTF-8 and replaces the lone surrogate with U+FFFD, so
 *     `"\ud800"` and `"\ud801"` become ONE key and the second call REPLAYS the
 *     first — a different request answered with an earlier response, its own
 *     records never written;
 *   * BUN stores the surrogate's raw bytes and reads them back as the EMPTY
 *     STRING, so the two keys stay apart in the table and come back as nothing
 *     at all.
 *
 * So this probe's `Idempotency-Replayed` half fails on Node and passes on Bun at
 * the red commit, and that is stated rather than hidden. The half that holds in
 * BOTH is the requirement itself: a key this registry cannot key by is refused,
 * with a reason, on either runtime.
 */
test("[13.2] the SURFACE-level idempotency key too: a second, different report is not swallowed", () => {
  for (const shape of COLLIDING) {
    const fx = p4Fixture();
    const d = deploy(fx, `r13-surface-${COLLIDING.indexOf(shape)}`);
    allow(fx, fx.reporter.agent_id, "report_outcome");
    const report = (key: string, callId: string) =>
      rest(fx, "POST", "/v1/observations", fx.keys.reporter, {
        agent_id: fx.reviewer.agent_id,
        runtime: "codex",
        window: "all_time",
        idempotency_key: key,
        records: [
          { role: "call", call_id: callId, at_ms: 1_754_000_001_000, text: `starting ${d.marker}` },
          { role: "output", call_id: callId, at_ms: 1_754_000_002_000, text: `done ${d.marker}` },
        ],
      });
    const first = report(shape.a, "well-formed-1");
    const second = report(shape.b, "well-formed-2");
    const stored = storedCallIds(fx);
    console.log(
      `  ${shape.what.padEnd(46)} first=${first.status} second=${second.status} ` +
        `replayed=${second.headers["Idempotency-Replayed"] ?? "no"} stored=${stored.length}`,
    );
    if (first.status === 201) {
      assert.notEqual(
        second.headers["Idempotency-Replayed"],
        "true",
        `${shape.what}: a second report under a DIFFERENT key was replayed as the first, and its records were dropped`,
      );
      assert.ok(
        stored.includes(correlationDigest("well-formed-2")),
        `${shape.what}: the second report's records never reached the journal`,
      );
    } else {
      assert.match(String(first.raw), /INVALID_SCHEMA/);
      assert.match(String(second.raw), /INVALID_SCHEMA/);
    }
    fx.db.close();
  }
});

// ===========================================================================
// 13.3 — THE UNIVERSAL FORM: the primitive itself
// ===========================================================================

test("[13.3] the primitive REFUSES every string it cannot hash injectively — it does not return a value", () => {
  for (const text of NOT_WELL_FORMED) {
    assert.equal(text.isWellFormed(), false, `${units(text)} is well-formed after all, so it is not part of this class`);
    let outcome = "returned a digest";
    try {
      const got = evidenceDigestOf(text);
      outcome = `returned ${got.slice(0, 22)}…`;
    } catch (e) {
      outcome = `threw ${(e as Error).constructor.name}`;
    }
    console.log(`  evidenceDigestOf(${units(text).padEnd(22)}) → ${outcome}`);
    assert.throws(
      () => evidenceDigestOf(text),
      `evidenceDigestOf(${units(text)}) returned a digest, and it is the SAME digest another string gets`,
    );
    // …AND THE WRAPPER, because `correlationDigest` is what the columns call and
    // a rule that lived in only one of the two would be no rule at all.
    assert.throws(() => correlationDigest(text), `correlationDigest(${units(text)}) returned a digest`);
  }
});

test("[13.3] and it keeps working for text — emoji, correct surrogate pairs, every script", () => {
  const seen = new Map<string, string>();
  for (const text of WELL_FORMED) {
    assert.equal(text.isWellFormed(), true, `${units(text)} is not well-formed, so it belongs in the other table`);
    const got = evidenceDigestOf(text);
    assert.equal(got, rawDigest(text), `the digest of ${units(text)} changed — the formula may not move (round 13 boundary)`);
    assert.equal(correlationDigest(text), got, "the two names must be one function");
    const clash = seen.get(got);
    assert.equal(clash, undefined, `two different texts share one digest: ${units(text)} and ${units(clash ?? "")}`);
    seen.set(got, text);
    console.log(`  ${units(text).padEnd(34)} → ${got.slice(0, 20)}…`);
  }
});

// ===========================================================================
// 13.4 — THE COVERAGE GUARD: every caller, taken by walking `src/`
// ===========================================================================

/**
 * Source with COMMENTS removed and string literals left intact, newline count
 * preserved so a line number still means what it says.
 *
 * It is a scanner and not a regular expression because this file is full of
 * prose that NAMES these functions — `correlationDigest(K)` appears inside a
 * comment in `src/migration-steps.ts` — and a guard that counted those would be
 * registering sentences instead of callers. Template literals are followed into
 * their `${…}` holes, so a call written inside one is a call.
 */
function withoutComments(src: string): string {
  const out: string[] = [];
  // the stack holds the template literals we are inside of, so `${…}` returns
  // to ordinary code and `}` goes back to the template
  const stack: string[] = [];
  let i = 0;
  let mode: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1] ?? "";
    if (mode === "code") {
      if (c === "/" && d === "/") {
        mode = "line";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        mode = "block";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "string";
        quote = c;
        out.push(c);
        i += 1;
        continue;
      }
      if (c === "}" && stack.length > 0) {
        // back into the template literal this hole belongs to
        quote = stack.pop()!;
        mode = "string";
        out.push(c);
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (mode === "line") {
      out.push(c === "\n" ? "\n" : " ");
      if (c === "\n") mode = "code";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out.push("  ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    // inside a string literal
    if (c === "\\") {
      out.push(c, d);
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && d === "{") {
      stack.push(quote);
      mode = "code";
      out.push("${");
      i += 2;
      continue;
    }
    if (c === quote) {
      mode = "code";
      out.push(c);
      i += 1;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

const PRIMITIVES = ["evidenceDigestOf", "correlationDigest"] as const;

interface CallSite {
  file: string;
  symbol: string;
  lines: number[];
}

/** Every `.ts` file under a directory, recursively, sorted. */
function tsFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, base, out);
    else if (entry.name.endsWith(".ts")) out.push(relative(base, full));
  }
  return out;
}

/**
 * WHO CALLS THE PRIMITIVES — computed from the tree, never listed.
 *
 * A DEFINITION IS NOT A CALL, so `export function correlationDigest(` is not
 * counted; everything else that names one of the two and opens a parenthesis
 * is. The result is keyed `<file>::<symbol>` and carries the COUNT, so a
 * second call added tomorrow inside a file that already calls it moves the
 * count and lands in this guard by itself.
 */
function callSites(dir: string): Map<string, CallSite> {
  const found = new Map<string, CallSite>();
  for (const file of tsFiles(dir)) {
    const source = withoutComments(readFileSync(join(dir, file), "utf8"));
    const code = source.split("\n");
    for (const symbol of PRIMITIVES) {
      // A CALL UNDER ANOTHER NAME IS STILL A CALL, and this guard would not see
      // one: `import { correlationDigest as cd }` and then `cd(x)` is a caller
      // no search for the word can find. The alias is refused instead — the
      // narrow rule this guard can actually keep, said out loud rather than
      // left as a hole the next reader assumes is covered. A call through a
      // NAMESPACE (`outcome.evidenceDigestOf(x)`) IS found: the pattern below
      // admits a qualifier before the name.
      assert.equal(
        new RegExp(`\\b${symbol}\\s+as\\s+`).test(source),
        false,
        `${file} imports ${symbol} under another name, and this guard finds callers by name`,
      );
      const re = new RegExp(`(^|[^A-Za-z0-9_$])${symbol}\\s*\\(`);
      const lines: number[] = [];
      code.forEach((line, n) => {
        if (new RegExp(`function\\s+${symbol}\\s*\\(`).test(line)) return; // the definition
        if (re.test(line)) lines.push(n + 1);
      });
      if (lines.length > 0) found.set(`${file}::${symbol}`, { file, symbol, lines });
    }
  }
  return found;
}

/** What a proof of one call site is: a name, and an executable demonstration
 *  that a string the primitive refuses cannot arrive at it. */
interface Proof {
  /** how many calls this file makes to this symbol */
  calls: number;
  /** what stops a non-well-formed string here, in one sentence */
  because: string;
  run: () => void;
}

/** Two ids that are different and share one digest — the shortest form of the
 *  attack, used by the proofs below. */
const A = "\ud800";
const B = "\ud801";

/** A whole `outcome_contract` naming a check parameter that cannot be hashed. */
function contractWithParameter(kind: "command" | "artifact_exists", parameter: string): Record<string, unknown> {
  return {
    check: kind === "command" ? { kind, command: parameter } : { kind, artifact_path: parameter },
    evidence: kind === "command" ? ["command", "exit_code"] : ["artifacts"],
    unknown: "no evaluated run of this skill was reported, which is not a failure of it",
  };
}

const PROOFS: Record<string, Proof> = {
  "journal.ts::evidenceDigestOf": {
    calls: 1,
    because: "`correlationDigest` IS the primitive under another name — it adds nothing and refuses what the primitive refuses",
    run: () => {
      for (const text of NOT_WELL_FORMED) assert.throws(() => correlationDigest(text), `correlationDigest(${units(text)})`);
      assert.equal(correlationDigest("call_1"), evidenceDigestOf("call_1"), "the wrapper stopped being the same function");
    },
  },

  "outcome.ts::evidenceDigestOf": {
    calls: 1,
    because:
      "`comparedDigest` hashes the SIGNED parameter, and the evaluator answers `unknown` with a reason for a parameter it cannot read rather than reaching the hash",
    run: () => {
      for (const kind of ["command", "artifact_exists"] as const) {
        const verdict = evaluateOutcome(contractWithParameter(kind, `${kind}-${A}`), {
          command: rawDigest("x"),
          exit_code: 0,
          artifacts: [rawDigest("x")],
        });
        console.log(`    evaluateOutcome(${kind} with a lone surrogate) → ${verdict.value} (${verdict.reason})`);
        assert.equal(verdict.value, "unknown", "a contract this registry cannot read decided a verdict [I-1], [A-0]");
        assert.ok((verdict.reason ?? "").length > 0, "an `unknown` with no reason is a blank cell");
      }
      // …and a readable contract still DECIDES, in both directions, or the
      // sentence above would be satisfied by an evaluator that answers nothing.
      const good = contractWithParameter("command", "./verify.sh");
      assert.equal(evaluateOutcome(good, { command: rawDigest("./verify.sh"), exit_code: 0 }).value, "yes");
      assert.equal(evaluateOutcome(good, { command: rawDigest("./verify.sh"), exit_code: 1 }).value, "no");
    },
  },

  "activation.ts::evidenceDigestOf": {
    calls: 1,
    because:
      "the only producer of the contract it reads is `outcomeContractOf`, which refuses a check parameter the primitive cannot hash — so the contract it gets is `null` and no path is formed",
    run: () => {
      const bad = outcomeContractOf({ outcome_contract: contractWithParameter("artifact_exists", `.agents/skills/${A}/SKILL.md`) });
      console.log(`    outcomeContractOf(a path with a lone surrogate) → valid=${bad.valid} reason=${bad.reason}`);
      assert.equal(bad.valid, false, "a contract whose parameter cannot be hashed was accepted as a definition of success");
      assert.equal(bad.contract, null);
      const site = { root: temp("skln-r13-root-"), target: "codex" as const, window: "all_time", window_detail: "one root" };
      const placed = { target: "codex" as const, native_relpath: `.agents/skills/${A}/SKILL.md`, managed_copy: "written" as const };
      assert.equal(
        registryObservedEvidence(site as never, bad.contract, placed),
        null,
        "the registry looked for an artifact named by a contract it had refused",
      );
      // and the ordinary contract still produces the registry's own evidence
      const ok = outcomeContractOf({ outcome_contract: contractWithParameter("artifact_exists", "SKILL.md") });
      assert.equal(ok.valid, true, `an ordinary contract was refused too: ${ok.reason}`);
    },
  },

  "fleet-scan.ts::correlationDigest": {
    calls: 1,
    because:
      "a transcript line whose `call_id` this registry cannot key by is not a record — it is dropped, and the scan neither throws nor manufactures a pair",
    run: () => {
      const root = temp("skln-r13-scan-");
      const marker = arrivalMarker(ulid(NOW));
      writeFileSync(
        join(root, "session.jsonl"),
        [
          JSON.stringify({ type: "custom_tool_call", call_id: A, at_ms: 1, text: `starting ${marker}` }),
          JSON.stringify({ type: "custom_tool_call_output", call_id: B, at_ms: 2, text: `done ${marker}`, result: "success" }),
          JSON.stringify({ type: "custom_tool_call", call_id: "ok-1", at_ms: 3, text: `starting ${marker}` }),
          JSON.stringify({ type: "custom_tool_call_output", call_id: "ok-1", at_ms: 4, text: `done ${marker}`, result: "success" }),
        ].join("\n") + "\n",
      );
      const source = new TranscriptObservations({
        rootFor: () => ({ root, runtime: "codex" as const, window: "all_time" as const, window_detail: "one session file" }),
      });
      const snap = source.snapshotFor("any-agent");
      assert.ok(snap, "the adapter produced no snapshot at all");
      const ids = snap.records.map((r) => r.call_id);
      console.log(`    the scanner read ${snap.records.length} records: ${JSON.stringify(ids)}`);
      assert.equal(
        ids.includes(correlationDigest("ok-1")),
        true,
        "the well-formed pair was dropped as well — the scanner must still read what it can read",
      );
      assert.equal(snap.records.length, 2, "a line with an id this registry cannot key by was carried into the journal");
    },
  },

  "migration-steps.ts::correlationDigest": {
    calls: 1,
    because:
      "its input is a string SQLite decoded from the UTF-8 bytes of a column, which is well-formed by construction — and were it ever not, the primitive aborts the migration rather than collapsing two keys",
    run: () => {
      const db = openSqlite(":memory:");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT)");
      const insert = db.prepare("INSERT INTO t(id, k) VALUES (?,?)");
      NOT_WELL_FORMED.forEach((text, n) => insert.run(n, text));
      const back = (db.prepare("SELECT k FROM t ORDER BY id").all() as Array<{ k: string }>).map((r) => r.k);
      console.log(`    ${back.length} non-well-formed strings written to SQLite came back as: ${back.map(units).join(" | ")}`);
      for (const k of back) {
        assert.equal(typeof k, "string");
        assert.equal(k.isWellFormed(), true, "SQLite handed back a string that is not well-formed, so the step CAN meet one");
      }
      db.close();
    },
  },

  "receipts.ts::correlationDigest": {
    calls: 2,
    because:
      "the adopter's key is refused at this boundary with a reason; the registry's own synthesized key is ASCII and a ULID by construction",
    run: () => {
      const fx = p4Fixture();
      const v = reviewedVersion(fx, "r13-receipt-proof");
      const receipt = receiptShell(fx, v.versionId);
      const refused = rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.member, {
        event: "delivered",
        idempotency_key: A,
      });
      console.log(`    an idempotency key of ${units(A)} → ${refused.status} ${String(refused.raw).slice(0, 60)}`);
      assert.notEqual(refused.status, 200, "a key this registry cannot key by was accepted");
      assert.match(String(refused.raw), /INVALID_SCHEMA/);
      // …and the registry's OWN key still hashes: `attempted` from `none`
      // synthesizes `delivered` under `synth-delivered:<ULID>`
      const ok = rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.member, { event: "attempted", idempotency_key: "k-1" });
      assert.equal(ok.status, 200, ok.raw);
      const row = fx.db
        .prepare("SELECT idempotency_key AS k FROM receipt_events WHERE adoption_receipt_id=? AND event_seq=1")
        .get(receipt) as { k: string };
      assert.equal(row.k, correlationDigest(`synth-delivered:${receipt}`), "the synthesized key stopped being computable");
      fx.db.close();
    },
  },

  "idempotency.ts::correlationDigest": {
    calls: 1,
    because:
      "`validateIdempotencyKey` runs `assertIdentityText` on the CALLER'S key before `storedKeyFor` hashes it, so a " +
      "string the primitive would refuse is answered `INVALID_SCHEMA` at the surface and never reaches the digest — " +
      "and on the two surfaces that digest, the stored column holds the digest and the retry still replays",
    run: () => {
      const fx = p4Fixture();
      const procedure = [
        "## Purpose",
        "Restore staging from a known-good backup.",
        "",
        "## When to use",
        "Whenever staging must be recovered.",
        "",
        "## Procedure",
        "1. Stop staging traffic.",
        "2. Restore the backup.",
      ].join("\n");
      const refused = rest(fx, "POST", "/v1/captures", fx.keys.owner, {
        kind: "workflow",
        text: procedure,
        idempotency_key: A,
      });
      console.log(`    a capture idempotency_key of ${units(A)} → ${refused.status} ${String(refused.raw).slice(0, 60)}`);
      assert.notEqual(refused.status, 201, "a key this registry cannot key by was accepted");
      assert.match(String(refused.raw), /INVALID_SCHEMA/);

      const first = rest(fx, "POST", "/v1/captures", fx.keys.owner, {
        kind: "workflow",
        text: procedure,
        idempotency_key: "r13-idempotency-proof",
      });
      assert.equal(first.status, 201, first.raw);
      const stored = fx.db
        .prepare("SELECT key FROM idempotency_keys WHERE surface='capture.submit'")
        .get() as { key: string };
      assert.equal(stored.key, correlationDigest("r13-idempotency-proof"), "the stored key stopped being computable");
      const replay = rest(fx, "POST", "/v1/captures", fx.keys.owner, {
        kind: "workflow",
        text: procedure,
        idempotency_key: "r13-idempotency-proof",
      });
      assert.equal(replay.raw, first.raw, "the retry did not replay the first answer byte for byte");
      fx.db.close();
    },
  },

  "assignment-lifecycle.ts::correlationDigest": {
    calls: 1,
    because:
      "its input is `JSON.stringify` of the payload, and JSON string escaping is injective and well-formed by construction: a lone surrogate leaves it as the six characters `\\ud800`, so the primitive never meets a non-well-formed string here AND two payloads differing only in such a character still differ in the digest",
    run: () => {
      // WHAT THE DIGEST IS FOR HERE: telling a repeat from a different request
      // wearing the same key (`P3-FR-09`, `P3-FR-10`). So the property to prove
      // is that equal payloads are equal digests, unequal payloads are unequal
      // digests, and the caller's text does not survive into the value.
      const one = requestDigest({ agent_id: "A", revision_id: "R", reason: "because" });
      const same = requestDigest({ reason: "because", revision_id: "R", agent_id: "A" });
      const other = requestDigest({ agent_id: "A", revision_id: "R2", reason: "because" });
      assert.equal(one, same, "field order changed the digest, so a retry would be read as a different request");
      assert.notEqual(one, other, "two different requests share one digest");
      assert.equal(one.startsWith("sha256:"), true, one);
      assert.equal(one.includes("because"), false, "the caller's text survived into the stored value");
      // THE ATTACK THIS ROUND IS ABOUT, at this boundary: two payloads that
      // differ only in a character SQLite or a runtime might fold. They must
      // not share a digest, or a caller would replay another caller's response.
      // `JSON.stringify` escapes both to distinct well-formed text, so the
      // primitive is reached with strings it can tell apart and never with one
      // it would refuse.
      const surrogateA = requestDigest({ reason: A });
      const surrogateB = requestDigest({ reason: B });
      assert.notEqual(surrogateA, surrogateB, "two payloads differing by a lone surrogate share one digest");
      for (const text of NOT_WELL_FORMED) {
        assert.equal(JSON.stringify({ reason: text }).isWellFormed(), true, `JSON.stringify left ${units(text)} raw`);
        assert.equal(typeof requestDigest({ reason: text }), "string");
      }
      console.log(
        `    requestDigest is stable under field order and separates ${NOT_WELL_FORMED.length} non-well-formed payloads without meeting one`,
      );
    },
  },

  "service.ts::correlationDigest": {
    calls: 1,
    because: "the reported `call_id` is refused at this boundary with a reason, before anything is reduced or stored",
    run: () => {
      const fx = p4Fixture();
      const d = deploy(fx, "r13-service-proof");
      allow(fx, fx.reporter.agent_id, "report_outcome");
      const refused = rest(fx, "POST", "/v1/observations", fx.keys.reporter, {
        agent_id: fx.reviewer.agent_id,
        runtime: "codex",
        window: "all_time",
        records: [{ role: "call", call_id: A, at_ms: 1, text: `starting ${d.marker}` }],
      });
      console.log(`    a reported call_id of ${units(A)} → ${refused.status} ${String(refused.raw).slice(0, 60)}`);
      assert.notEqual(refused.status, 201, "a call_id this registry cannot key by was accepted");
      assert.match(String(refused.raw), /INVALID_SCHEMA/);
      assert.deepEqual(storedCallIds(fx), [], "a refused report left a row behind");
      fx.db.close();
    },
  },
};

/** What the guard COMPLAINS about, as data, so that the mutation below can show
 *  the guard failing without taking this file's assertions with it. */
function complaints(found: Map<string, CallSite>): string[] {
  const out: string[] = [];
  for (const [key, site] of found) {
    const proof = PROOFS[key];
    if (!proof) {
      out.push(`${key} (line${site.lines.length > 1 ? "s" : ""} ${site.lines.join(", ")}) calls a digest primitive and no proof covers it`);
      continue;
    }
    if (proof.calls !== site.lines.length) {
      out.push(`${key} makes ${site.lines.length} call(s) (lines ${site.lines.join(", ")}), and the proof covers ${proof.calls}`);
    }
  }
  for (const key of Object.keys(PROOFS)) {
    if (!found.has(key)) out.push(`${key} has a proof and no longer calls anything — a proof of nothing`);
  }
  return out;
}

test("[13.4] EVERY caller of the digest primitives is found by walking `src/`, and every one of them is proved", () => {
  // THE WALK AND THE TREE MUST AGREE FIRST. A guard that walks a directory
  // proves nothing about a file the directory does not hold, so the set it
  // walked is compared against the set GIT holds — the rule D-13 set for B-4 —
  // and a source file nobody committed fails here rather than passing unseen.
  const tracked = execFileSync("git", ["ls-files", "*.ts", "*.js"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.length > 0);
  assert.deepEqual(
    tsFiles(SRC_DIR)
      .map((f) => `src/${f}`)
      .sort(),
    tracked.filter((f) => f.startsWith("src/")).sort(),
    "the directory this guard walked is not the `src/` the tree holds",
  );

  // …AND NOTHING OUTSIDE `src/` CALLS THEM. `tools/` and `bin/` are shipped by
  // `npm pack` too, so "we only looked in src/" would be a place the guard
  // silently does not look. Today the answer is none; a call added there
  // tomorrow fails this line instead of going unproved.
  const outside = tracked.filter((f) => !f.startsWith("src/") && !f.startsWith("test/"));
  for (const file of outside) {
    const code = withoutComments(readFileSync(join(REPO_ROOT, file), "utf8"));
    for (const symbol of PRIMITIVES) {
      assert.equal(
        new RegExp(`(^|[^A-Za-z0-9_$])${symbol}\\s*\\(`).test(code),
        false,
        `${file} calls ${symbol} and is outside the set this guard proves`,
      );
    }
  }
  console.log(`  ${outside.length} tracked .ts/.js files outside src/ and test/, none of which calls a digest primitive`);

  const found = callSites(SRC_DIR);
  const total = [...found.values()].reduce((n, s) => n + s.lines.length, 0);
  console.log(`  ${found.size} (file, primitive) pairs, ${total} calls, taken from ${tsFiles(SRC_DIR).length} files under src/`);
  for (const [key, site] of [...found].sort()) console.log(`    ${key.padEnd(44)} line(s) ${site.lines.join(", ")}`);
  assert.ok(found.size > 0, "the walk found no callers at all, so this guard proves nothing");
  assert.deepEqual(complaints(found), [], "a caller of a digest primitive is not covered by a proof");

  for (const [key, proof] of Object.entries(PROOFS)) {
    console.log(`  ${key}: ${proof.because}`);
    proof.run();
  }
});

test("[13.4] the guard can FAIL: a caller added tomorrow lands in it by itself", () => {
  // THE MUTATION IS ON A COPY OF THE WHOLE TREE, so the baseline is the tree
  // the guard above just passed on: a complaint below is the planting and
  // nothing else.
  const copy = join(temp("skln-r13-src-"), "src");
  cpSync(SRC_DIR, copy, { recursive: true });
  assert.deepEqual(complaints(callSites(copy)), [], "the untouched copy does not reproduce the baseline");

  // (a) a NEW FILE that calls one of the primitives — through a NAMESPACE,
  // which is the form a search for the bare word would miss
  const planted = join(copy, "planted.ts");
  writeFileSync(planted, 'import * as outcome from "./outcome.ts";\nexport const x = outcome.evidenceDigestOf("anything at all");\n');
  const newFile = complaints(callSites(copy));
  console.log(`  a new file calling the primitive through a namespace → ${JSON.stringify(newFile)}`);
  assert.deepEqual(
    newFile.filter((c) => c.startsWith("planted.ts::evidenceDigestOf")).length,
    1,
    "a brand-new caller did not land in the guard",
  );

  // (b) a SECOND call inside a file that is ALREADY registered — the case a set
  // of file names, or a set of (file, symbol) pairs, would miss
  rmSync(planted);
  const service = join(copy, "service.ts");
  writeFileSync(service, readFileSync(service, "utf8") + '\nexport const planted = correlationDigest("one more");\n');
  const extraCall = complaints(callSites(copy));
  console.log(`  a second call in an already-registered file → ${JSON.stringify(extraCall)}`);
  assert.equal(extraCall.length, 1, "an extra call inside a registered file did not move the count");
  assert.match(extraCall[0]!, /^service\.ts::correlationDigest makes 2 call/);

  // (c) …and a call written inside a COMMENT is not a caller, or the guard
  // would be registering sentences instead of code
  writeFileSync(service, readFileSync(join(SRC_DIR, "service.ts"), "utf8"));
  writeFileSync(planted, '// export const x = correlationDigest("in a comment");\n/* and correlationDigest( here too */\nexport const y = 1;\n');
  assert.deepEqual(complaints(callSites(copy)), [], "prose that names the primitive was counted as a caller");

  // (d) and a caller hidden behind an ALIAS is refused outright, because this
  // guard finds callers BY NAME and cannot follow a rename
  writeFileSync(planted, 'import { correlationDigest as cd } from "./journal.ts";\nexport const z = cd("hidden");\n');
  assert.throws(
    () => callSites(copy),
    /imports correlationDigest under another name/,
    "an aliased import slipped past the guard, which is a caller it cannot see",
  );
});

// ===========================================================================
// 13.5 — NODE AND BUN, ASKED THE SAME QUESTIONS
// ===========================================================================

test("[13.5] both runtimes: the collapse is real, `isWellFormed` agrees, and the refusal is identical", () => {
  const runtime = typeof (globalThis as any).Bun !== "undefined" ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;
  const rows: string[] = [];
  for (const shape of COLLIDING) {
    const collapses = rawDigest(shape.a) === rawDigest(shape.b);
    const wf = `${shape.a.isWellFormed()}/${shape.b.isWellFormed()}`;
    let refusal = "returned a digest";
    try {
      evidenceDigestOf(shape.a);
    } catch {
      refusal = "threw";
    }
    rows.push(`${shape.what.padEnd(46)} utf8-collapse=${collapses} isWellFormed=${wf} primitive=${refusal}`);
    assert.equal(collapses, true, `${runtime}: ${shape.what} does not collapse here, so the probe would be vacuous`);
    assert.equal(wf, "false/false", `${runtime}: isWellFormed disagrees about ${shape.what}`);
    assert.equal(refusal, "threw", `${runtime}: the primitive returned a digest for ${shape.what}`);
  }
  console.log(`  ${runtime}`);
  for (const r of rows) console.log(`    ${r}`);

  // the same question the other way round: well-formed text is unchanged in
  // both runtimes, digest for digest
  for (const text of WELL_FORMED) {
    assert.equal(evidenceDigestOf(text), rawDigest(text), `${runtime}: the digest of ${units(text)} is runtime-dependent`);
  }
});
