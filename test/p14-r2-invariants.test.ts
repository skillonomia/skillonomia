// ROUND 2 — THE INVARIANTS THE FIRST ROUND ASSERTED AND DID NOT PROVE.
//
// An independent review of the seven V-1 works returned BLOCKED, and the
// finding underneath every one of the seven blockers was the same shape:
//
//     A TEST THAT SELECTS THE NEW THING BY NAME DOES NOT PROVE AN INVARIANT
//     STATED WITH A UNIVERSAL QUANTIFIER.
//
// "every MCP tool", "every number", "every cell", "every view", "either
// surface" — each is a claim about a SET, and a test that reaches into that set
// for the rows a recent commit added will pass while the invariant is false of
// everything else in it. Five of the seven blockers were exactly that; two were
// a guard whose documentation described a check it did not perform.
//
// So every test in this file enumerates its set from the shipped source, prints
// the SIZE of what it swept, and is paired with a mutation that must kill it.
// A sweep over an empty set proves nothing, and the printed number is what lets
// a reader tell one from the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  adoptThroughSurfaces,
  env,
  rateThroughSurface,
  goodEvidence,
  mcp,
  p4Fixture,
  rest,
  reviewedVersion,
  NOW,
  type P4Fixture,
} from "./p6-helpers.ts";
import {
  createVersion,
  lint,
  publishedVersion,
  verifiableVersion,
} from "./p4-helpers.ts";
import { buildPackage, makeManifest } from "./p2-helpers.ts";
import { DASHBOARD_VIEWS, escapeHtml, isMintedCell } from "../src/dashboard.ts";
import {
  APPROVAL_NOTICES,
  RECONCILIATION_LEGEND,
  auditDashboardPayload,
  auditRenderedHtml,
  auditRenderedJson,
  cellAttr as cellAttrOf,
  forgesMethod,
  labelCell,
  numberCell,
  registryCount,
  NOT_A_COUNT,
  parseTables,
  type RenderAudit,
} from "../src/fleet-dashboard.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { MIGRATION_SOURCE, RECIPIENT_SOURCE_REQUEST, RECIPIENT_SOURCE_TRANSFER } from "../src/skill-migrations.ts";
import { FixedActivationRoots, type ActivationRoots, type ActivationSite } from "../src/activation.ts";
import type { InventoryRoots, InventorySite } from "../src/fleet-scan.ts";
import { writeTar } from "../src/archive.ts";
import { TRANSFER_ACTION } from "../src/transfer.ts";
import { arrivalMarker } from "../src/marker.ts";
import * as docs from "./docs-guard.ts";

// ===========================================================================
// The harness
// ===========================================================================

const temps: string[] = [];

function tempBase(prefix = "skln-r2-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return realpathSync(dir);
}

process.on("exit", () => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a tree already removed is not a failure
    }
  }
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A copy of `src/` with substitutions in ONE file, loaded WHOLE.
 *
 * The harness proves its own substitution rather than trusting it: the template
 * must occur EXACTLY ONCE (zero means the mutation matched nothing and every
 * assertion after it is vacuous), the replacement must differ from the
 * template, the file's sha256 must MOVE, and the line before and the line after
 * are printed so a reader of the output can see which code was broken.
 */
async function mutantTree(
  file: string,
  edits: Array<[from: string, to: string]>,
  load: readonly string[] = [file],
): Promise<Record<string, any>> {
  const dir = tempBase("skln-r2-mutant-");
  symlinkSync(new URL("../node_modules", import.meta.url), join(dir, "node_modules"), "dir");
  // `src/version.ts` reads the package manifest, so the copied tree needs one:
  // a mutant that cannot load is a mutant that was never killed.
  writeFileSync(join(dir, "package.json"), readFileSync(new URL("../package.json", import.meta.url)));
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
  console.log(`[mutation] src/${file}  sha256 ${beforeSha.slice(0, 12)} → ${afterSha.slice(0, 12)}`);
  const out: Record<string, any> = {};
  for (const name of load) out[name] = await import(pathToFileURL(join(dir, "src", name)).href);
  return out;
}

/** Assert that `fn` throws — the mutant must be killed. */
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

// ===========================================================================
// 1. [M-5] — ONE SET OF RECORDS, ONE VERDICT, ON EVERY SURFACE THAT HAS ONE
// ===========================================================================
//
// THE DEFECT THIS EXISTS FOR, IN FULL. `assessArrival` counted SOME call record
// and SOME output record carrying the marker. `scanArrivals` required the two
// to share the `call_id` the runtime bound them with. And `recordsFor` — the
// projection BOTH assignment answers were built from — dropped `call_id`
// entirely, so §5 could not have applied the rule even if it had wanted to.
//
// The result was reproducible through the shipped surfaces: file one call under
// `call_id: A` and one output under `call_id: B`, both carrying one version's
// marker, and `/v1/assignments` answered `observed_arrival: yes` while
// `capability.get` answered `invoked: unknown / no_paired_record`. The same
// rows, at the same moment, were a pair and not a pair.
//
// [M-5] settles it: `invoked` is proved by a PAIRED call/output record. A pair
// is what a runtime bound with one non-empty `call_id`. So this test drives the
// FOUR degenerate sets through BOTH shipped surfaces and requires the verdicts
// to be equal — and a mutation that pulls the two rules apart again must kill it.

interface Wired {
  fx: P4Fixture;
  agent: string;
  versionId: string;
  marker: string;
}

function grant(fx: P4Fixture, agentId: string, action: string): void {
  const res = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: agentId,
    action,
    recipient_scope: "local_agent",
  });
  assert.equal(res.status, 201, res.raw);
}

/** One agent holding one assigned version, ready to be told about records. */
function wired(): Wired {
  const fx = p4Fixture();
  const built = reviewedVersion(fx, "r2-arrival");
  grant(fx, fx.member.agent_id, TRANSFER_ACTION);
  grant(fx, fx.owner.agent_id, "report_outcome");
  const agent = fx.reviewer.agent_id;
  const pushed = rest(fx, "POST", `/v1/versions/${built.versionId}/transfers`, fx.keys.member, {
    recipient: { kind: "local_agent", ref: agent },
  });
  assert.equal(pushed.status, 201, pushed.raw);
  return { fx, agent, versionId: built.versionId, marker: arrivalMarker(built.versionId) };
}

/** File one observation, through the shipped surface, replacing the last. */
function report(w: Wired, records: Array<Record<string, unknown>>): void {
  const res = rest(w.fx, "POST", "/v1/observations", w.fx.keys.owner, {
    agent_id: w.agent,
    runtime: "codex",
    window: "period",
    window_from_ms: 1,
    window_to_ms: 1_900_000_000_000,
    records,
  });
  assert.equal(res.status, 201, res.raw);
}

/** SURFACE ONE — §5.5 deployments. The `observed_arrival` column. */
function assignmentsVerdict(w: Wired): { verdict: string; reason: string | null } {
  const res = rest(w.fx, "GET", "/v1/assignments", w.fx.keys.owner);
  assert.equal(res.status, 200, res.raw);
  const row = (res.body.items as any[]).find((a) => a.skill_version_id === w.versionId);
  assert.ok(row, "the fixture must produce an assignment row, or the comparison is vacuous");
  return { verdict: row.observed_arrival, reason: row.observed_arrival_reason };
}

/** SURFACE TWO — §6 capabilities. The `invoked` column of §4's matrix. */
function capabilityVerdict(w: Wired): { verdict: string; reason: string | null } {
  const out = mcp(w.fx, w.fx.keys.owner, "capability.get", { agent_id: w.agent, name: "r2-arrival" });
  assert.equal(out.isError, false, JSON.stringify(out.data));
  const cell = (out.data.capability.columns as any[]).find((c) => c.column === "invoked");
  assert.ok(cell, "the capability answer must carry an `invoked` column, or the comparison is vacuous");
  return { verdict: cell.value, reason: cell.reason };
}

/** The four sets, named as the reviewer named them. */
function recordSets(marker: string): Array<{ name: string; records: Array<Record<string, unknown>>; expect: string }> {
  return [
    { name: "(a) a lone call", records: [{ role: "call", call_id: "A", at_ms: NOW, text: `starting ${marker}` }], expect: "unknown" },
    {
      name: "(b) a lone output",
      records: [{ role: "output", call_id: "A", at_ms: NOW, text: `done ${marker}`, result: "success", evidence: { exit_code: 0 } }],
      expect: "unknown",
    },
    {
      name: "(c) a call and an output under DIFFERENT call_ids",
      records: [
        { role: "call", call_id: "A", at_ms: NOW, text: `starting ${marker}` },
        { role: "output", call_id: "B", at_ms: NOW + 10, text: `done ${marker}`, result: "success", evidence: { exit_code: 0 } },
      ],
      expect: "unknown",
    },
    {
      name: "(d) a call and an output under ONE call_id",
      records: [
        { role: "call", call_id: "A", at_ms: NOW, text: `starting ${marker}` },
        { role: "output", call_id: "A", at_ms: NOW + 10, text: `done ${marker}`, result: "success", evidence: { exit_code: 0 } },
      ],
      expect: "yes",
    },
  ];
}

test("[M-5] one set of records gets ONE verdict: the assignments surface and the capability surface agree on all four", () => {
  const w = wired();
  const sets = recordSets(w.marker);
  console.log(`[M-5 cross-surface] record sets swept: ${sets.length}, surfaces compared: 2`);
  let agreements = 0;
  for (const set of sets) {
    report(w, set.records);
    const assignments = assignmentsVerdict(w);
    const capability = capabilityVerdict(w);
    console.log(
      `  ${set.name}: /v1/assignments observed_arrival=${assignments.verdict}` +
        `(${assignments.reason ?? "—"}) · capability.get invoked=${capability.verdict}(${capability.reason ?? "—"})`,
    );
    assert.equal(assignments.verdict, set.expect, `${set.name}: the assignments surface`);
    assert.equal(capability.verdict, set.expect, `${set.name}: the capability surface`);
    assert.equal(
      assignments.verdict,
      capability.verdict,
      `${set.name}: two surfaces answered differently about ONE set of records [M-5]`,
    );
    // …and `no` is not in the vocabulary of either [I-1], [A-0]
    assert.notEqual(assignments.verdict, "no");
    assert.notEqual(capability.verdict, "no");
    agreements += 1;
  }
  assert.equal(agreements, 4, "all four sets must have been compared, or this proves less than it says");
  // the fixture DISCRIMINATES: without the `yes` case the equality would hold
  // trivially, by both surfaces never saying anything but `unknown`
  assert.equal(sets.filter((s) => s.expect === "yes").length, 1);
  assert.equal(sets.filter((s) => s.expect === "unknown").length, 3);
  w.fx.db.close();
});

test("[M-5] the mutation that divides the two surfaces is killed: a projection that drops `call_id`", async () => {
  // THE MUTATION THAT SHIPPED. `StoredObservations.recordsFor` mapped every row
  // to `{role, text}` and threw the `call_id` away, so §5 read a set of records
  // in which no pair could be distinguished from any other and fell back to
  // "some call, some output". Set (c) — a call under A, an output under B —
  // then answered `yes` on the assignments surface and `unknown` on the
  // capability surface.
  const m = await mutantTree(
    "fleet-store.ts",
    [
      [
        `    return { records: arrivalRecordsOf(snapshot.records), window: snapshot.window_detail };`,
        `    return {
      records: snapshot.records
        .filter((r) => r.role === "call" || r.role === "output")
        .map((r) => ({ role: r.role as "call" | "output", call_id: null, text: r.marker })),
      window: snapshot.window_detail,
    };`,
      ],
    ],
    ["assignments.ts", "fleet-store.ts", "marker.ts"],
  );
  const marker = arrivalMarker("01K1M83S80EZJBJVYBH8XEK5ZR");
  const subject = { marker, has_executable_step: true };
  const pairedRecords = [
    { agent_id: "a", runtime: "codex" as const, role: "call" as const, call_id: "A", at_ms: 1, marker, result: "unknown" as const },
    { agent_id: "a", runtime: "codex" as const, role: "output" as const, call_id: "A", at_ms: 2, marker, result: "unknown" as const },
  ];
  // the mutated projection strips what binds them, so even the GENUINE pair
  // stops being one — the guard bites in the direction that cannot be argued
  killed("a projection that drops `call_id` still answered `yes` for a real pair", () => {
    const window = {
      records: pairedRecords
        .filter((r) => r.role === "call" || r.role === "output")
        .map((r) => ({ role: r.role, call_id: null, text: r.marker })),
      window: "the mutated projection",
    };
    assert.equal(m["assignments.ts"]!.observedArrival(window, subject).verdict, "yes");
  });
  // and the shipped projection keeps it, so the same records DO pair
  const honest = {
    records: pairedRecords.map((r) => ({ role: r.role, call_id: r.call_id, text: r.marker })),
    window: "the shipped projection",
  };
  const { observedArrival } = await import("../src/assignments.ts");
  assert.equal(observedArrival(honest, subject).verdict, "yes", "the honest projection must still pair, or nothing is proved");
});

test("THE LATEST REPORT WINS, and it wins on every report filed in one millisecond", () => {
  // The rule `StoredObservations` documents is "the latest report wins", and
  // its tie-break inside one millisecond is the row's ULID. Record ids used to
  // be minted as `ulid(nowMs + n)`, which pushed the generator's clock past the
  // report's own; the next report at the same millisecond then drew a FRESH
  // RANDOM tail and could sort BELOW its predecessor. Which records §5 and §6
  // had searched then depended on 16 random characters — the class of defect
  // where a test passes four times out of five and the rule is simply not true.
  const w = wired();
  const ids: string[] = [];
  const sets = recordSets(w.marker);
  // interleave one-record and two-record reports: the offset bug only showed
  // when a report advanced the clock and the NEXT one did not
  for (const set of [...sets, ...sets]) {
    report(w, set.records);
    const rows = w.fx.db.prepare("SELECT id FROM runtime_observations ORDER BY rowid").all() as Array<{ id: string }>;
    ids.push(rows[rows.length - 1]!.id);
  }
  console.log(`[latest wins] reports filed in one millisecond: ${ids.length}`);
  assert.equal(ids.length, 8, "the sweep must file more than one report, or it proves nothing");
  for (let i = 1; i < ids.length; i++) {
    assert.ok(
      ids[i]! > ids[i - 1]!,
      `report #${i} sorts below report #${i - 1} (${ids[i - 1]} → ${ids[i]}): the tie-break cannot say which is latest`,
    );
  }
  // and the answer follows the LAST report, not one of the earlier ones
  assert.equal(assignmentsVerdict(w).verdict, "yes", "the last report was a pair, and it is the one that answered");
  report(w, sets[2]!.records);
  assert.equal(assignmentsVerdict(w).verdict, "unknown", "a later report that is not a pair takes the answer back");
  w.fx.db.close();
});

// ===========================================================================
// 2. [I-6] — THE RECIPIENT COMES FROM AN EVENT, OR THE CHAIN IS NOT COUNTED
// ===========================================================================
//
// `recipientOf` read the `transferred` event's `recipient_json` and, when that
// was missing or unparseable, RETURNED THE RECEIPT SHELL'S ADOPTER INSTEAD.
// Two failures in one line. It is fail-OPEN: a chain whose own statement of
// where the version went is broken was counted anyway, from a journal it had
// not named. And the number then published `receipt_events` as its source —
// [I-3]'s failure with an attribution attached, which is worse than none.
//
// Round 2 closed the fail-open and left the OTHER half standing: a chain the
// recipient opened for itself was still answered from `adoption_receipts`, so
// the sentence this surface is specified by — every count is computed from
// `receipt_events` — held for push chains and quietly did not hold for pull
// ones. `0009` gives the pull its own opening event, `requested`, carrying the
// typed recipient on the same INSERT-only row in the same transaction. Both
// kinds of chain are now answered from the journal or not answered at all, and
// a chain that carries NO opening event — history from before `0009` — is
// dropped and reported rather than answered from a second table.

/** A chain whose `transferred` row carries a payload no build can produce.
 *
 *  The chain itself is opened through the real surface; the one row written by
 *  hand is the one the surfaces cannot write — §5.4 validates a recipient
 *  before it records one, so a damaged declaration comes from an older build or
 *  from a payload harmed after the fact, and the fail-closed rule exists for
 *  exactly the rows this registry did not write itself. */
function chainWithDamagedRecipient(fx: P4Fixture, v: any, key: string, payload: string | null, tag: string): string {
  const req = rest(fx, "POST", "/v1/adoptions/requests", key, { skill_version_id: v.versionId });
  assert.equal(req.status, 201, req.raw);
  const receipt = req.body.receipt_id as string;
  fx.db
    .prepare(
      `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, recipient_json, server_at_ms, idempotency_key)
       VALUES (?,?, 'transferred', 9, ?, ?, ?)`,
    )
    .run(`01TR${tag}`.padEnd(26, "0").slice(0, 26), receipt, payload, NOW, `dmg-${tag}`);
  assert.equal(rest(fx, "POST", `/v1/receipts/${receipt}/events`, key, { event: "delivered", environment: env() }).status, 200);
  assert.equal(rest(fx, "POST", `/v1/receipts/${receipt}/events`, key, { event: "attempted" }).status, 200);
  const done = rest(fx, "POST", `/v1/receipts/${receipt}/events`, key, {
    event: "adopted",
    evidence: goodEvidence(v.manifest),
  });
  assert.equal(done.status, 200, done.raw);
  return receipt;
}

/**
 * A chain carrying NO opening event at all — every row written by hand.
 *
 * This is what an instance's history looks like across `0009`: a receipt shell
 * and a completed chain whose recipient was never recorded on the journal,
 * because at the time it was written the journal had nowhere to record it. No
 * back-fill invents one, so the counter has nothing to read and must drop it.
 */
function chainWithNoOpeningEvent(fx: P4Fixture, v: any, tag: string): string {
  const requestId = `01LGRQ${tag}`.padEnd(26, "0").slice(0, 26);
  const receiptId = `01LGRC${tag}`.padEnd(26, "0").slice(0, 26);
  fx.db
    .prepare(
      `INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count,
         next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pushed', 0, 0, ?)`,
    )
    .run(requestId, v.versionId, fx.member.agent_id, NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
    )
    .run(receiptId, requestId, v.versionId, fx.member.agent_id, NOW);
  fx.db
    .prepare(
      `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, environment_json, server_at_ms, idempotency_key)
       VALUES (?,?, 'delivered', 1, ?, ?, ?)`,
    )
    .run(`01LGDL${tag}`.padEnd(26, "0").slice(0, 26), receiptId, JSON.stringify(env()), NOW, `lg-d-${tag}`);
  fx.db
    .prepare(
      `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, evidence_json, server_at_ms, idempotency_key)
       VALUES (?,?, 'adopted', 2, ?, ?, ?)`,
    )
    .run(
      `01LGAD${tag}`.padEnd(26, "0").slice(0, 26),
      receiptId,
      JSON.stringify(goodEvidence(v.manifest)),
      NOW,
      `lg-a-${tag}`,
    );
  return receiptId;
}

function migrationRow(fx: P4Fixture, slug: string): any {
  const res = rest(fx, "GET", "/v1/migrations", fx.keys.owner);
  assert.equal(res.status, 200, res.raw);
  const row = (res.body.items as any[]).find((i) => i.slug === slug);
  assert.ok(row, `${slug} must have a row — a counted skill is never a missing one`);
  return { row, envelope_source: res.body.source as string };
}

test("[I-6] a chain whose own recipient event cannot be read counts ZERO, and nothing stands in for it", () => {
  const fx = p4Fixture();
  const damaged = reviewedVersion(fx, "mig-damaged");
  const empty = reviewedVersion(fx, "mig-nullrecipient");
  const honest = reviewedVersion(fx, "mig-pull");

  chainWithDamagedRecipient(fx, damaged, fx.keys.member, "{not json at all", "A");
  chainWithDamagedRecipient(fx, empty, fx.keys.member, null, "B");
  // …and a chain NO transfer opened, driven entirely through the surfaces:
  // this is the PULL half, and after `0009` it is answered from its own
  // `requested` event. Without it the sweep would prove only that nothing is
  // ever counted.
  adoptThroughSurfaces(fx, honest, fx.keys.member);

  const d = migrationRow(fx, "mig-damaged");
  console.log(
    `[I-6] damaged recipient_json → migrations=${d.row.migrations}, distinct_recipients=${d.row.distinct_recipients}, ` +
      `recipients_unattributed=${d.row.recipients_unattributed}, recipient_sources=${JSON.stringify(d.row.recipient_sources)}`,
  );
  assert.equal(d.row.migrations, 0, "a chain whose recipient event is unreadable was counted as a migration");
  assert.equal(d.row.distinct_recipients, 0, "the receipt shell was credited as the recipient of a broken transfer");
  assert.equal(d.row.distinct_runtimes, 0, "a dropped chain still contributed a runtime");
  assert.equal(d.row.recipients_unattributed, 1, "the dropped chain must be REPORTED, not silently discarded [I-1]");
  assert.deepEqual(d.row.recipient_sources, [], "nothing was read, so no journal may be named");
  assert.equal(d.row.measurement_state, "not_migrated");

  const n = migrationRow(fx, "mig-nullrecipient");
  console.log(
    `[I-6] transferred event with NO recipient_json → migrations=${n.row.migrations}, ` +
      `recipients_unattributed=${n.row.recipients_unattributed}`,
  );
  assert.equal(n.row.migrations, 0, "an event that carried no recipient at all was answered from the receipt shell");
  assert.equal(n.row.recipients_unattributed, 1);

  // THE DISCRIMINATOR: the honest chain IS counted, and says which journal
  // answered for it. Without this the assertions above would hold on a counter
  // that counted nothing at all.
  const h = migrationRow(fx, "mig-pull");
  console.log(
    `[I-6] a chain the recipient opened itself → migrations=${h.row.migrations}, ` +
      `recipient_sources=${JSON.stringify(h.row.recipient_sources)}`,
  );
  assert.equal(h.row.migrations, 1, "the fixture must count SOMETHING, or this test proves nothing");
  assert.equal(h.row.distinct_recipients, 1);
  assert.equal(h.row.recipients_unattributed, 0);
  assert.deepEqual(h.row.recipient_sources, ["receipt_events.requested"]);
  // [I-3]: the number names what it was obtained from, in words — the journal,
  // and the opening event within it
  assert.match(h.row.source, /receipt_events/, "the journal every count is specified to come from is not named");
  assert.match(h.row.source, /`requested`/, "the opening event this row's recipient was read from is not named");
  assert.doesNotMatch(h.row.source, /adoption_receipts/, "a count published a table outside the journal as its source");
  assert.match(h.envelope_source, /`requested`/, "the envelope's source must name the truth too");
  // and a row that read nothing does not invent an attribution
  assert.equal(d.row.source, MIGRATION_SOURCE);
  fx.db.close();
});

test("[I-6] the mutation that puts the receipt shell back into the counter is killed", async () => {
  // The mutation is the WHOLE fallback, restored the way it would have to be
  // restored: the shell's adopter selected back into the query, and
  // `recipientOf` reaching for it whenever the journal has nothing to say. Both
  // halves are needed — the column is no longer selected at all — and that is
  // the point of running the mutation over two templates rather than one: it
  // shows the recipient has left the query, not only the branch.
  const m = await mutantTree("skill-migrations.ts", [
    [
      `v.skill_id AS skill_id, r.skill_version_id AS version,
              d.environment_json AS ctx,`,
      `v.skill_id AS skill_id, r.skill_version_id AS version,
              r.adopter_agent_id AS recipient, d.environment_json AS ctx,`,
    ],
    [
      `  if (row.transfer_event_id !== null) return parse(row.transferred_to, RECIPIENT_SOURCE_TRANSFER);
  if (row.request_event_id !== null) return parse(row.requested_to, RECIPIENT_SOURCE_REQUEST);
  return null;`,
      `  if (row.transfer_event_id !== null) {
    return parse(row.transferred_to, RECIPIENT_SOURCE_TRANSFER)
      ?? { id: (row as any).recipient, from: RECIPIENT_SOURCE_REQUEST };
  }
  if (row.request_event_id !== null) return parse(row.requested_to, RECIPIENT_SOURCE_REQUEST);
  return { id: (row as any).recipient, from: RECIPIENT_SOURCE_REQUEST };`,
    ],
  ]);
  const fx = p4Fixture();
  const damaged = reviewedVersion(fx, "mig-damaged");
  const legacy = reviewedVersion(fx, "mig-legacy");
  chainWithDamagedRecipient(fx, damaged, fx.keys.member, "{not json at all", "A");
  chainWithNoOpeningEvent(fx, legacy, "L");
  const subjects = [
    { skill_id: damaged.skillId, slug: "mig-damaged" },
    { skill_id: legacy.skillId, slug: "mig-legacy" },
  ];
  const mutated = m["skill-migrations.ts"]!.migrationCounts(fx.db, subjects);
  for (const row of mutated) {
    console.log(`  [mutant answered] ${row.slug}: migrations=${row.migrations}, recipients=${row.distinct_recipients}`);
  }
  killed("the receipt shell stood in for an opening event the journal could not answer with [I-6]", () => {
    for (const row of mutated) {
      assert.equal(row.migrations, 0, `${row.slug}`);
      assert.equal(row.distinct_recipients, 0, `${row.slug}`);
    }
  });
  // …and the shipped counter, on the same rows, answers zero for BOTH
  const { migrationCounts } = await import("../src/skill-migrations.ts");
  const honest = migrationCounts(fx.db, subjects);
  for (const row of honest) {
    assert.equal(row.migrations, 0, `the shipped counter must drop ${row.slug}, or the mutation proves nothing`);
    assert.equal(row.recipients_unattributed, 1, `${row.slug} must be REPORTED as dropped, not silently omitted`);
  }
  fx.db.close();
});

test("[I-6] a chain that carries NO opening event is dropped and REPORTED, never answered from the shell", () => {
  // The class the round-2 fix left standing, in its purest form: a completed,
  // evidenced chain whose recipient was never written to the journal. Before
  // `0009` the shell answered for it and the figure published `receipt_events`.
  const fx = p4Fixture();
  const legacy = reviewedVersion(fx, "mig-legacy");
  const live = reviewedVersion(fx, "mig-live");
  chainWithNoOpeningEvent(fx, legacy, "L");
  adoptThroughSurfaces(fx, live, fx.keys.member);

  const l = migrationRow(fx, "mig-legacy");
  console.log(
    `[I-6] chain with no opening event → migrations=${l.row.migrations}, ` +
      `recipients_unattributed=${l.row.recipients_unattributed}, sources=${JSON.stringify(l.row.recipient_sources)}`,
  );
  assert.equal(l.row.migrations, 0, "a chain naming no recipient on the journal was counted anyway");
  assert.equal(l.row.distinct_recipients, 0, "the receipt shell was credited as the recipient");
  assert.equal(l.row.distinct_runtimes, 0, "a dropped chain still contributed a runtime");
  assert.equal(l.row.recipients_unattributed, 1, "a dropped chain is REPORTED, never silently omitted [I-1]");
  assert.deepEqual(l.row.recipient_sources, [], "nothing was read, so nothing may be named");

  // the discriminator: a chain the SAME surfaces opened today is counted, so
  // the zeroes above are a fact about that chain and not about the counter
  const v = migrationRow(fx, "mig-live");
  assert.equal(v.row.migrations, 1, "the fixture must count SOMETHING, or this test proves nothing");
  assert.deepEqual(v.row.recipient_sources, ["receipt_events.requested"]);
  fx.db.close();
});

// ---------------------------------------------------------------------------
// D-8, PROVED BY A DIFFERENT KIND OF PROBE
//
// The probe that FOUND this defect read the counter's OUTPUT — `recipient_
// sources` said `adoption_receipts`, and the source phrase said so in words.
// Fixing what a reading of the output shows is exactly how a fix comes to treat
// the probe instead of the class: the next place the shell is consulted has its
// own output, and nobody is reading that one.
//
// So the proof below never looks at an answer. It intercepts the DATABASE
// HANDLE and inspects every SQL statement the counter prepares, refusing any
// that reaches for a recipient outside `receipt_events`. `SPEC` says "Every
// count MUST be computed from `receipt_events`"; this asks the statements
// themselves whether that is true, which is a question the output cannot answer
// and a question no future rewording of a source phrase can pass.
// ---------------------------------------------------------------------------

/** Column and table names that are NOT the receipt journal, and would each be a
 *  different way of answering "who received it" from somewhere else. */
const OUTSIDE_THE_JOURNAL: ReadonlyArray<[RegExp, string]> = [
  [/adopter_agent_id/i, "`adoption_receipts.adopter_agent_id` — the receipt shell"],
  [/requester_context_json/i, "`adoption_requests.requester_context_json` — the mutable request cache"],
  [/\badoption_requests\b/i, "the `adoption_requests` table"],
  [/\btransfers\b/i, "the `transfers` table — a record of the operation, not the journal"],
];

test("[I-6]/D-8 every statement the counter runs reads its recipient from `receipt_events` and from nothing else", async () => {
  const { migrationCounts, migrationTotals } = await import("../src/skill-migrations.ts");
  const fx = p4Fixture();
  const pulled = reviewedVersion(fx, "sql-pull");
  const pushed = publishedVersion(fx, "sql-push");
  // one of EACH kind of chain, so the sweep covers both branches of the answer
  adoptThroughSurfaces(fx, pulled, fx.keys.member);
  const grant = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: fx.owner.agent_id,
    action: TRANSFER_ACTION,
    recipient_scope: "local_agent",
  });
  assert.equal(grant.status, 201, grant.raw);
  const sent = rest(fx, "POST", `/v1/versions/${pushed.versionId}/transfers`, fx.keys.owner, {
    recipient: { kind: "local_agent", ref: fx.reviewer.agent_id },
  });
  assert.equal(sent.status, 201, sent.raw);
  const receipt = sent.body.receipt_id as string;
  assert.equal(rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.reviewer, { event: "delivered", environment: env() }).status, 200);
  assert.equal(rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.reviewer, { event: "attempted" }).status, 200);
  assert.equal(
    rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.reviewer, { event: "adopted", evidence: goodEvidence(pushed.manifest) }).status,
    200,
  );

  // the interception. Every `prepare` is recorded; a statement reaching outside
  // the journal for a recipient throws, so the counter cannot answer at all
  // rather than answering and being audited afterwards.
  const seen: string[] = [];
  const refusals: string[] = [];
  const guarded = {
    exec: (sql: string) => fx.db.exec(sql),
    close: () => {},
    prepare: (sql: string) => {
      seen.push(sql);
      for (const [pattern, what] of OUTSIDE_THE_JOURNAL) {
        if (pattern.test(sql)) refusals.push(`${what} appears in a statement the counter runs`);
      }
      return fx.db.prepare(sql);
    },
  };

  const subjects = [
    { skill_id: pulled.skillId, slug: "sql-pull" },
    { skill_id: pushed.skillId, slug: "sql-push" },
  ];
  const rows = migrationCounts(guarded as any, subjects);
  const totals = migrationTotals(guarded as any);
  console.log(`[D-8] statements the counter prepared: ${seen.length}`);
  console.log(`[D-8] tables named across them: ${JSON.stringify([...new Set(seen.join(" ").match(/FROM\s+(\w+)|JOIN\s+(\w+)/gi) ?? [])])}`);
  for (const row of rows) {
    console.log(`[D-8] ${row.slug}: migrations=${row.migrations}, sources=${JSON.stringify(row.recipient_sources)}`);
  }

  // A SWEEP OVER NOTHING PROVES NOTHING, twice over: the counter must have run
  // statements, and it must have COUNTED something with them.
  assert.ok(seen.length > 0, "the interception saw no statement at all");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.migrations, 1, "the pull chain must count, or the sweep is over an empty answer");
  assert.equal(rows[1]!.migrations, 1, "the push chain must count, or the sweep is over an empty answer");
  assert.equal(totals.migrations, 2);
  assert.deepEqual(rows[0]!.recipient_sources, ["receipt_events.requested"]);
  assert.deepEqual(rows[1]!.recipient_sources, ["receipt_events.transferred"]);
  assert.deepEqual(refusals, [], "a statement of the migration counter reached outside `receipt_events`");
  // …and the journal IS what it read: the assertion above would also hold on a
  // counter that read nothing at all.
  assert.ok(
    seen.some((sql) => /receipt_events/i.test(sql)),
    "no statement of the counter names `receipt_events`",
  );
  fx.db.close();
});

test("[I-6]/D-8 the interception probe bites: a counter that reads the shell is refused by it", async () => {
  // The guard above is a guard, so it is shown to fail on the code it exists to
  // catch — the round-2 counter, which selected the shell's adopter and answered
  // pull chains from it.
  const m = await mutantTree("skill-migrations.ts", [
    [
      `v.skill_id AS skill_id, r.skill_version_id AS version,
              d.environment_json AS ctx,`,
      `v.skill_id AS skill_id, r.skill_version_id AS version,
              r.adopter_agent_id AS recipient, d.environment_json AS ctx,`,
    ],
    [
      `  if (row.request_event_id !== null) return parse(row.requested_to, RECIPIENT_SOURCE_REQUEST);
  return null;`,
      `  return { id: (row as any).recipient, from: RECIPIENT_SOURCE_REQUEST };`,
    ],
  ]);
  const fx = p4Fixture();
  const pulled = reviewedVersion(fx, "sql-pull-mutant");
  adoptThroughSurfaces(fx, pulled, fx.keys.member);
  const refusals: string[] = [];
  const guarded = {
    exec: (sql: string) => fx.db.exec(sql),
    close: () => {},
    prepare: (sql: string) => {
      for (const [pattern, what] of OUTSIDE_THE_JOURNAL) if (pattern.test(sql)) refusals.push(what);
      return fx.db.prepare(sql);
    },
  };
  const mutated = m["skill-migrations.ts"]!.migrationCounts(guarded as any, [
    { skill_id: pulled.skillId, slug: "sql-pull-mutant" },
  ]);
  console.log(`  [mutant answered] migrations=${mutated[0].migrations}, refusals=${JSON.stringify(refusals)}`);
  killed("a counter selecting the receipt shell's adopter passed the statement sweep", () => {
    assert.deepEqual(refusals, [], "a statement of the migration counter reached outside `receipt_events`");
  });
  // and the mutant really did answer from the shell — otherwise the refusal
  // above could have come from a statement that read the column and ignored it
  assert.equal(mutated[0].migrations, 1, "the mutant must still count, or its refusal is about nothing");
  fx.db.close();
});

// ===========================================================================
// 3. [I-8] — EVERY MCP TOOL, AND EVERY HINT TRUE OF THE TOOL IT IS ON
// ===========================================================================
//
// [I-8] says "EVERY MCP tool", and 23 of the 36 had no `annotations` block at
// all — among them the writing `skill.create` and the reading `dashboard.view`.
// The tests that existed selected the tools a recent commit had added, by name,
// and proved their hints correct. That proves nothing about the set.
//
// So this sweep is over `MCP_TOOLS` itself. It never names a tool: it takes the
// shipped array, drives EVERY entry through the shipped adapter against a live
// registry, and compares `readOnlyHint` with WHETHER THE DATABASE MOVED. A tool
// declared reading that writes is a false hint a client acts on by not asking;
// a tool declared writing that succeeded without writing is a hint that will
// train a client to ask about nothing.

/** A fresh Ed25519 public half, base64url — a key to register, never a seed. */
function sparePublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  // the raw 32 bytes are the tail of the DER SubjectPublicKeyInfo
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
}

const SPARE_PUBLIC_KEY = sparePublicKey();
const SPARE_PUBLIC_KEY_2 = sparePublicKey();

let freshN = 0;

/** A §4.1b package archive nothing has seen before. */
function freshArchive(fx: P4Fixture): Buffer {
  return buildPackage(
    makeManifest({ author_agent: fx.author.agent_id, access_policy: "workspace", semantic_version: `1.0.${++freshN}` }),
  ).tar;
}

/** A SOURCE tree for surface 14: a manifest and a `SKILL.md`, no integrity. */
function freshSource(fx: P4Fixture): Buffer {
  const manifest: any = makeManifest({
    access_policy: "workspace",
    semantic_version: `2.0.${++freshN}`,
    // D-2: surface 14 refuses a source that does not say what success is
    outcome_contract: {
      check: { kind: "exit_code", exit_code: 0 },
      evidence: ["exit_code"],
      unknown: "no evaluated run was reported, which is not a failure",
    },
  });
  delete manifest.integrity;
  delete manifest.author_agent;
  const files = new Map<string, Buffer>();
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  files.set("SKILL.md", Buffer.from("# a skill\n\n## Procedure\n\n1. do the thing\n", "utf8"));
  return writeTar(files);
}

/** Every table of the live schema with its row count — the whole database. */
function dbSnapshot(fx: P4Fixture): string {
  const tables = (
    fx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = fx.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as unknown[];
  return JSON.stringify(out);
}

test("[I-8] every one of the 36 MCP tools carries annotations, and every hint is a boolean", () => {
  console.log(`[I-8] tools declared in src/mcp.ts: ${MCP_TOOLS.length}`);
  assert.ok(MCP_TOOLS.length >= 36, "the sweep must see the whole tool table, or it proves nothing");
  const missing: string[] = [];
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    if (!tool.annotations || typeof tool.annotations !== "object") {
      missing.push(`${tool.name}: no annotations at all`);
      continue;
    }
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      if (typeof tool.annotations[hint] !== "boolean") missing.push(`${tool.name}: ${hint} is not a boolean`);
    }
    // a reading tool cannot be destructive, and the two hints saying opposite
    // things about one call is a hint pair a client cannot act on
    if (tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === true) {
      missing.push(`${tool.name}: declared read-only AND destructive`);
    }
  }
  assert.deepEqual(missing, [], "tools whose hints [I-8] does not accept");
  // …and two more properties of the WHOLE table, for the same reason [I-8]
  // gives: every tool is one STEP of the loop, so its name is `subject.verb`
  // and never a catch-all, and its arguments are an object.
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    assert.match(tool.name, /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/, `${tool.name}: a tool name is subject.verb`);
    assert.equal(tool.inputSchema?.type, "object", `${tool.name}: the advertised argument container is an object`);
    assert.ok(typeof tool.description === "string" && tool.description.length > 40, `${tool.name}: no description`);
  }
  const reading = (MCP_TOOLS as ReadonlyArray<any>).filter((t) => t.annotations.readOnlyHint === true);
  console.log(
    `[I-8] annotated: ${MCP_TOOLS.length}/${MCP_TOOLS.length} · declared reading: ${reading.length} · declared writing: ${MCP_TOOLS.length - reading.length}`,
  );
  // the split must be a real split: an "every tool is a write" table would pass
  // the sweep below by never being checked in the reading direction
  assert.ok(reading.length > 0 && reading.length < MCP_TOOLS.length, "the hints must actually distinguish the two");
});

// ---------------------------------------------------------------------------
// THE ENVIRONMENT A TOOL ACTS ON — BOTH HALVES OF IT
//
// THE DEFECT THIS SECTION EXISTS FOR. Round 3 compared every one of the 36
// hints with behaviour, which was the right move, and measured behaviour as
// A ROW OF THIS DATABASE MOVING. Twenty-seven tools were then re-declared
// `destructiveHint: false` on the grounds that they only INSERT. Among them:
//
//   * `assignment.activate` — `src/activation.ts:291` `rmSync(target, {force})`
//     and `:296` `writeFileSync(target, bytes)`: it DELETES and REWRITES a file
//     in a runtime's own directory.
//   * `assignment.revoke` (and `assignment.pause`, the same `withdraw` path) —
//     `src/activation.ts:368` `rmSync(dir, {recursive: true, force: true})`: a
//     RECURSIVE DIRECTORY REMOVAL on somebody else's disk.
//
// Both carry `openWorldHint: true`, which is the annotation table saying in
// its own words that these tools reach outside this registry. The measure did
// not follow them there. It watched the tables, saw them stand still, and
// concluded "additive" — a guard reporting the quantity it could measure under
// the name of the quantity it was asked about. MCP's own wording is
// `destructiveHint`: "the tool may perform destructive updates to its
// ENVIRONMENT". A tree removed with `rm -rf` is destroyed under any reading.
//
// So the measure below covers BOTH halves of the environment a call can move:
// the rows of this database, and the FILESYSTEM the call is configured to
// reach. Neither is the whole; the union is what the hints are compared with.
// ---------------------------------------------------------------------------

/**
 * Every path under the watched trees, with the sha256 of its BYTES.
 *
 * Written here rather than taken from `src/activation.ts`: the question is
 * whether that module's writes and removals are visible, and a sensor built
 * from the walker under test would answer with the walker's own blind spots.
 * Symbolic links are recorded AS LINKS and not followed — a link swapped for
 * another target is itself a change to the environment, and following one
 * would count the same bytes twice.
 */
function fsFingerprint(roots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (root: string, current: string): void => {
    let entries: Array<{ name: string }>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      const key = `${relative(root, abs)}`;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        out.set(key, `symlink→${readlinkSync(abs)}`);
        continue;
      }
      if (st.isDirectory()) {
        out.set(key, "dir");
        walk(root, abs);
        continue;
      }
      out.set(key, `file:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`);
    }
  };
  for (const root of roots) walk(root, root);
  return out;
}

/** The blind measure, kept beside the real one so the difference is provable:
 *  it records that a path EXISTS and never looks at what is in it. */
function fsNamesOnly(roots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k] of fsFingerprint(roots)) out.set(k, "exists");
  return out;
}

interface FsDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

function fsDiff(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): FsDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [k, v] of after) {
    const b = before.get(k);
    if (b === undefined) added.push(k);
    else if (b !== v) modified.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

/** the call PUT something in the environment, of any kind */
const fsMoved = (d: FsDiff): boolean => d.added.length + d.removed.length + d.modified.length > 0;
/** the call took away or overwrote something that was ALREADY THERE */
const fsDestroyed = (d: FsDiff): boolean => d.removed.length + d.modified.length > 0;

/**
 * THE SENSOR PROVES IT SEES THE FILESYSTEM BEFORE IT IS ALLOWED TO JUDGE ONE.
 *
 * This is the discipline `test/assignment-activation.test.ts` already applies
 * to its own fingerprint and the discipline round 3's database measure was
 * never held to: a measure that cannot see a change it was built to see proves
 * nothing by staying silent. So the two acts `src/activation.ts` actually
 * performs are performed HERE, on a temporary tree, and the sensor is required
 * to name each of them — and required to stay silent when nothing happened and
 * when a file is rewritten with identical bytes.
 *
 * It returns a printable line, and every caller that judges a tool prints it,
 * so the output of a passing run carries the evidence that the eye was open.
 */
function proveTheSensorSeesTheFilesystem(): string {
  const base = tempBase("skln-r2-fs-eye-");
  // a tree shaped like the places a fleet keeps its skills
  mkdirSync(join(base, ".claude", "skills", "kept"), { recursive: true });
  mkdirSync(join(base, ".agents", "skills", "doomed", "nested"), { recursive: true });
  writeFileSync(join(base, ".claude", "skills", "kept", "SKILL.md"), "kept\n");
  writeFileSync(join(base, ".agents", "skills", "doomed", "SKILL.md"), "doomed\n");
  writeFileSync(join(base, ".agents", "skills", "doomed", "nested", "extra.md"), "extra\n");
  const roots = [base];
  const nothing: FsDiff = { added: [], removed: [], modified: [] };
  const origin = fsFingerprint(roots);
  const originNames = fsNamesOnly(roots);
  assert.ok(origin.size >= 8, `only ${origin.size} paths in the sensor's own tree — it would compare nothing with nothing`);

  // (0) SILENCE WHEN NOTHING HAPPENED. A sensor that reports a change on every
  // call would "catch" every tool and distinguish none of them.
  assert.deepEqual(fsDiff(origin, fsFingerprint(roots)), nothing, "the sensor invented a change");

  // (1) A PLANTED FILE — added, and NOT destruction: the distinction the whole
  // `destructiveHint` question turns on.
  const planted = join(base, ".claude", "skills", "kept", "PLANTED.md");
  writeFileSync(planted, "planted\n");
  const d1 = fsDiff(origin, fsFingerprint(roots));
  assert.deepEqual(d1.added, [".claude/skills/kept/PLANTED.md"], `the sensor missed a planted file: ${JSON.stringify(d1)}`);
  assert.equal(fsDestroyed(d1), false, "a file that was not there before is an ADDITION, not a destruction");
  rmSync(planted);
  assert.deepEqual(fsDiff(origin, fsFingerprint(roots)), nothing, "the sensor did not see its own file go away again");

  // (2) `materialize`'s act, exactly: unlink the entry and write new bytes over
  // it. One path, same name, different content — invisible to any measure that
  // asks only whether a path exists.
  const entry = join(base, ".claude", "skills", "kept", "SKILL.md");
  rmSync(entry, { force: true });
  writeFileSync(entry, "kepu\n");
  const d2 = fsDiff(origin, fsFingerprint(roots));
  assert.deepEqual(d2.modified, [".claude/skills/kept/SKILL.md"], `the sensor missed a rewritten file: ${JSON.stringify(d2)}`);
  assert.equal(fsDestroyed(d2), true, "a file whose bytes were replaced was DESTROYED and rewritten");
  // …and A NARROWER MEASURE IS SHOWN TO MISS PRECISELY THIS. `fsNamesOnly` is
  // the same walk with the hashing taken out — the shape of measure that sees
  // paths appear and disappear and calls a file rewritten in place unchanged.
  // It is the filesystem analogue of round 3's database-only measure, and it is
  // run against the same tree at the same moment so the difference is not an
  // argument but an observation.
  killed("a measure that records only that a path exists saw the rewritten bytes", () => {
    assert.equal(fsDestroyed(fsDiff(originNames, fsNamesOnly(roots))), true, "the blind measure saw the rewrite");
  });

  // (3) IDENTICAL BYTES ARE NOT A CHANGE. `materialize` rewrites every file of
  // the package on every activation; a sensor keyed on mtime would call a
  // convergent noop destructive and make the hint mean nothing.
  rmSync(entry, { force: true });
  writeFileSync(entry, "kept\n");
  assert.deepEqual(fsDiff(origin, fsFingerprint(roots)), nothing, "a file rewritten with the SAME bytes is not a change");

  // (4) `removeManaged`'s act, exactly: `rmSync(dir, {recursive: true})`. The
  // directory AND everything under it must be named, or a guard could see a
  // skill's folder vanish and report that one path changed.
  rmSync(join(base, ".agents", "skills", "doomed"), { recursive: true, force: true });
  const d4 = fsDiff(origin, fsFingerprint(roots));
  assert.deepEqual(
    d4.removed,
    [".agents/skills/doomed", ".agents/skills/doomed/SKILL.md", ".agents/skills/doomed/nested", ".agents/skills/doomed/nested/extra.md"],
    `the sensor did not see a recursive removal whole: ${JSON.stringify(d4)}`,
  );
  assert.equal(fsDestroyed(d4), true, "a recursively removed directory is destruction");

  return (
    `[env] the filesystem sensor proved it sees: 1 planted file (additive), 1 file rewritten in place (destructive), ` +
    `4 paths removed by one rm -rf (destructive), and stayed silent on a no-op and on a rewrite with identical bytes; ` +
    `${origin.size} paths in its own tree`
  );
}

/**
 * The configured foreign roots, WITH A SWITCH and a counter.
 *
 * Two things the sweep cannot get any other way. The counter answers "did this
 * call ask where the foreign environment is" — a tool that never asks cannot
 * have reached one, which is what makes `openWorldHint: false` provable. The
 * switch answers the opposite question for a call that changes nothing: take
 * the root away and call again, and an answer that MOVES could only have come
 * from a disk. Neither is a code path read off the source; both are behaviour.
 */
class SwitchableActivationRoots implements ActivationRoots {
  present = true;
  consulted = 0;
  private readonly here: ActivationSite;
  private readonly gone: ActivationSite;
  constructor(here: ActivationSite, gone: ActivationSite) {
    this.here = here;
    this.gone = gone;
  }
  rootFor(): ActivationSite {
    this.consulted += 1;
    return this.present ? this.here : this.gone;
  }
}

class SwitchableInventoryRoots implements InventoryRoots {
  present = true;
  consulted = 0;
  private readonly here: InventorySite;
  private readonly gone: InventorySite;
  constructor(here: InventorySite, gone: InventorySite) {
    this.here = here;
    this.gone = gone;
  }
  rootFor(): InventorySite {
    this.consulted += 1;
    return this.present ? this.here : this.gone;
  }
}

/** One argument set a tool is driven with. A tool may have several: the hints
 *  are statements about the TOOL, so what it does is the union over the calls
 *  it can be made, not one convenient call. */
interface Drive {
  key: string;
  args: any;
  /** what this argument set is FOR, printed beside the result */
  label: string;
}

interface ToolWorld {
  fx: P4Fixture;
  drives: Map<string, Drive[]>;
  /** every tree the sweep watches — the configured roots and the decoys beside
   *  them, so a write that escapes a root still lands somewhere measured */
  watched: string[];
  activation: SwitchableActivationRoots;
  inventory: SwitchableInventoryRoots;
}

/** One live registry with everything the 36 calls need, and the arguments for
 *  each — built by NAME LOOKUP into a table that is checked for completeness
 *  against `MCP_TOOLS`, so a tool added tomorrow fails this suite rather than
 *  quietly escaping it. */
function toolDrive(): ToolWorld {
  const base = tempBase("skln-r2-tools-");
  const activationRoot = join(base, "activation");
  const inventoryRoot = join(base, "inventory");
  mkdirSync(activationRoot, { recursive: true });
  // A foreign disk with something ON it. The three reading tools that declare
  // `openWorldHint: true` walk this tree; against an EMPTY root they would walk
  // nothing and the measurement of them would be a measurement of nothing.
  for (const name of ["inv-one", "inv-two", "inv-three"]) {
    mkdirSync(join(inventoryRoot, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(inventoryRoot, ".claude", "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  mkdirSync(join(inventoryRoot, ".claude", "plugins", "inv-plugin"), { recursive: true });
  writeFileSync(join(inventoryRoot, ".claude", "plugins", "inv-plugin", "SKILL.md"), "# a plugin\n");
  // DECOYS, shaped like the real places a fleet keeps skills, OUTSIDE both
  // configured roots and inside the watched tree: a write that escapes a root
  // has somewhere recognisable to land where the sensor will still see it.
  mkdirSync(join(base, "home", ".claude", "skills", "shared"), { recursive: true });
  mkdirSync(join(base, "project", ".agents", "skills", "shared"), { recursive: true });
  writeFileSync(join(base, "home", ".claude", "skills", "shared", "SKILL.md"), "decoy A\n");
  writeFileSync(join(base, "project", ".agents", "skills", "shared", "SKILL.md"), "decoy B\n");

  const activation = new SwitchableActivationRoots(
    { root: activationRoot, target: "claude_code_project" },
    { root: join(base, "no-such-activation-root"), target: "claude_code_project" },
  );
  const inventory = new SwitchableInventoryRoots(
    { root: inventoryRoot, runtime: "claude_code" },
    { root: join(base, "no-such-inventory-root"), runtime: "claude_code" },
  );
  // The bucket is widened HERE and nowhere near the product: §6's shipped
  // per-key limit is 60, the setup below spends a good part of it, and a sweep
  // that drives 36 tools TWICE would otherwise be measuring the limiter instead
  // of the tools. Nothing about the limit is under test in this file.
  const fx = p4Fixture({
    activation,
    inventory,
    rateLimit: { capacity: 100_000, refillPerSec: 0 },
  });

  const draft = createVersion(fx, "mcp-draft");
  const toLint = createVersion(fx, "mcp-lint");
  const toReview = createVersion(fx, "mcp-review");
  lint(fx, toReview.versionId);
  const toVerify = verifiableVersion(fx, "mcp-verify");
  // verified but NOT yet published: publishing an already-published version is
  // a convergent noop, and a noop would make this tool's hint untested
  const toPublish = verifiableVersion(fx, "mcp-publish");
  assert.equal(fx.registry.verifyVersion(fx.owner, toPublish.versionId).response.state, "verified");
  const toSupersede = publishedVersion(fx, "mcp-supersede");
  // the successor must be another version of the SAME skill, and must itself
  // have reached `verified` before it may retire its predecessor
  const successor = verifiableVersion(fx, "mcp-supersede", {
    skill_id: toSupersede.skillId,
    semver: "2.0.0",
    manifest: { skill_id: toSupersede.skillId },
  });
  assert.equal(fx.registry.verifyVersion(fx.owner, successor.versionId).response.state, "verified");
  const toDeprecate = publishedVersion(fx, "mcp-deprecate");
  const toRevoke = publishedVersion(fx, "mcp-revoke");
  const toApprove = publishedVersion(fx, "mcp-approve");
  const toAdopt = publishedVersion(fx, "mcp-adopt");
  const toTransfer = publishedVersion(fx, "mcp-transfer");

  // a receipt chain waiting for its terminal event, and a closed one to rate
  const pending = adoptThroughSurfaces(fx, toAdopt, fx.keys.member, { terminal: "none" });
  // …carried as far as the surfaces will take it WITHOUT its terminal event, so
  // `skill.validate_outcome` is the call that appends one
  assert.equal(rest(fx, "POST", `/v1/receipts/${pending.receiptId}/events`, fx.keys.member, { event: "attempted" }).status, 200);
  const closed = adoptThroughSurfaces(fx, toAdopt, fx.keys.admin);
  // a request in flight, for `skill.adopt`
  const inFlight = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.reviewer2, {
    skill_version_id: toAdopt.versionId,
  });
  assert.equal(inFlight.status, 201, inFlight.raw);

  // the grants the transfer loop needs, and one deployment per assignment tool
  for (const action of [TRANSFER_ACTION, "activate", "revoke", "report_outcome"]) {
    const res = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
      agent_id: fx.owner.agent_id,
      action,
      recipient_scope: "local_agent",
    });
    assert.equal(res.status, 201, res.raw);
  }
  // FOUR deployments, because three of the states the deployment tools reach
  // are only reachable from a deployment that is ALREADY ACTIVE, and a sweep
  // that drove them from `queued` would watch them do nothing to a disk and
  // conclude they never touch one. `mcp-act` is fresh — the additive half of
  // activation. `mcp-act-drift` is active with a TAMPERED copy, which is the
  // state `src/service.ts` records as `drifted` and rewrites: the half where
  // `rmSync` + `writeFileSync` land on bytes that were already there.
  // `mcp-pause` and `mcp-revoke-assignment` are active, so withdrawing them
  // performs the recursive removal `removeManaged` is for.
  const deployment = new Map<string, string>();
  for (const slug of ["mcp-act", "mcp-act-drift", "mcp-pause", "mcp-revoke-assignment"]) {
    const v = publishedVersion(fx, slug);
    const pushed = rest(fx, "POST", `/v1/versions/${v.versionId}/transfers`, fx.keys.owner, {
      recipient: { kind: "local_agent", ref: fx.reviewer.agent_id },
    });
    assert.equal(pushed.status, 201, pushed.raw);
    deployment.set(slug, pushed.body.assignment_id);
  }
  for (const slug of ["mcp-act-drift", "mcp-pause", "mcp-revoke-assignment"]) {
    const res = rest(fx, "POST", `/v1/assignments/${deployment.get(slug)}/activate`, fx.keys.owner, {});
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.managed_copy, "written", `${slug} was not materialized: ${res.raw}`);
    const onDisk = join(activationRoot, ".claude", "skills", slug, "SKILL.md");
    assert.ok(existsSync(onDisk), `${slug}: the setup did not put a file where the sweep will watch for its removal`);
  }
  // …and the drift, planted after the copy exists and before the sweep runs
  const drifted = join(activationRoot, ".claude", "skills", "mcp-act-drift", "SKILL.md");
  const trueBytes = readFileSync(drifted);
  writeFileSync(drifted, Buffer.concat([trueBytes, Buffer.from("\n<!-- edited by a hand that is not this registry -->\n")]));
  assert.notDeepEqual(readFileSync(drifted), trueBytes, "the drift was not planted");

  // a principal to issue and revoke keys for, and a signing key to revoke
  const victim = rest(fx, "POST", "/v1/principals", fx.keys.owner, {
    name: "mcp-victim",
    type: "agent",
    role: "member",
  });
  assert.equal(victim.status, 201, victim.raw);
  const victimId = victim.body.agent_id ?? victim.body.principal_id ?? victim.body.id;
  const issued = rest(fx, "POST", `/v1/principals/${victimId}/api-keys`, fx.keys.owner, {});
  assert.equal(issued.status, 201, issued.raw);
  const keyId = issued.body.api_key_id;
  const registered = rest(fx, "POST", "/v1/signing-keys", fx.keys.owner, {
    kid: "mcp-sweep-doomed",
    public_key_ed25519: SPARE_PUBLIC_KEY,
  });
  assert.equal(registered.status, 201, registered.raw);

  const O = fx.keys.owner!;
  const A = fx.keys.author!;
  /** one argument set, when one is all the tool has */
  const one = (key: string, a: any, label = "the call"): Drive[] => [{ key, args: a, label }];
  const drives = new Map<string, Drive[]>([
    ["skill.create", one(A, { slug: "mcp-created", archive_base64: freshArchive(fx).toString("base64") })],
    ["skill.create_from_dir", one(A, { slug: "mcp-from-dir", source_base64: freshSource(fx).toString("base64") })],
    ["skill.lint", one(A, { skill_version_id: toLint.versionId })],
    ["skill.verify", one(O, { skill_version_id: toVerify.versionId })],
    ["skill.search", one(O, {})],
    ["skill.review.request", one(A, { skill_version_id: toReview.versionId, action: "request" })],
    ["skill.publish", one(O, { skill_version_id: toPublish.versionId })],
    [
      "skill.supersede",
      one(O, { skill_version_id: toSupersede.versionId, successor_version_id: successor.versionId }),
    ],
    ["skill.deprecate", one(O, { skill_version_id: toDeprecate.versionId })],
    ["skill.revoke", one(O, { skill_version_id: toRevoke.versionId, reason: "a sweep of the tool table" })],
    [
      "skill.approve",
      one(O, { skill_version_id: toApprove.versionId, scope: "publish", decision: "approved" }),
    ],
    ["skill.request_adoption", one(fx.keys.member!, { skill_version_id: toTransfer.versionId })],
    ["skill.adopt", one(fx.keys.reviewer2!, { adoption_request_id: inFlight.body.adoption_request_id, environment_descriptor: env() })],
    [
      "skill.validate_outcome",
      one(fx.keys.member!, { receipt_id: pending.receiptId, event: "adopted", evidence: goodEvidence(toAdopt.manifest) }),
    ],
    ["skill.rate", one(fx.keys.admin!, { skill_version_id: toAdopt.versionId, adoption_receipt_id: closed.receiptId, score: 5 })],
    [
      "skill.transfer",
      one(O, { skill_version_id: toTransfer.versionId, recipient: { kind: "local_agent", ref: fx.reviewer2.agent_id } }),
    ],
    [
      "transfer_grant.create",
      one(O, { agent_id: fx.member.agent_id, action: "receive", recipient_scope: "local_agent" }),
    ],
    ["transfer_grant.list", one(O, {})],
    [
      "assignment.activate",
      [
        { key: O, args: { assignment_id: deployment.get("mcp-act") }, label: "a fresh deployment — the additive half" },
        { key: O, args: { assignment_id: deployment.get("mcp-act-drift") }, label: "a DRIFTED copy — the half that overwrites" },
      ],
    ],
    ["assignment.pause", one(O, { assignment_id: deployment.get("mcp-pause") }, "an ACTIVE deployment, so the copy is really there to take away")],
    ["assignment.revoke", one(O, { assignment_id: deployment.get("mcp-revoke-assignment") }, "an ACTIVE deployment, so the copy is really there to take away")],
    ["assignment.list", one(O, {})],
    ["fleet.list", one(O, {})],
    ["agent.capabilities", one(O, { agent_id: fx.reviewer.agent_id })],
    ["capability.get", one(O, { agent_id: fx.reviewer.agent_id, name: "mcp-act" })],
    [
      "observation.report",
      one(O, {
        agent_id: fx.reviewer.agent_id,
        runtime: "codex",
        window: "period",
        window_from_ms: 1,
        window_to_ms: NOW,
        records: [{ role: "call", call_id: "s-1", at_ms: NOW, text: "nothing in particular" }],
      }),
    ],
    ["principal.create", one(O, { name: "mcp-sweep-new", type: "agent", role: "member" })],
    ["principal.list", one(O, {})],
    ["principal.issue_api_key", one(O, { principal_id: victimId })],
    ["principal.revoke_api_key", one(O, { principal_id: victimId, api_key_id: keyId })],
    ["signing_key.register", one(O, { kid: "mcp-sweep-fresh", public_key_ed25519: SPARE_PUBLIC_KEY_2 })],
    ["signing_key.list", one(O, {})],
    ["signing_key.revoke", one(O, { kid: "mcp-sweep-doomed" })],
    ["tlog.read", one(O, {})],
    ["migration.count", one(O, {})],
    // EVERY VIEW, not the one that happens to touch nothing: three of the
    // eleven read a fleet member's own disk, and a sweep driven with `library`
    // alone would measure this tool's reach as none at all.
    ["dashboard.view", DASHBOARD_VIEWS.map((view) => ({ key: O, args: { view }, label: `view=${view}` }))],
  ]);
  return { fx, drives, watched: [base], activation, inventory };
}

test("[I-8] every tool's `readOnlyHint` is checked against whether the database MOVED", () => {
  const { fx, drives } = toolDrive();
  // COMPLETENESS FIRST: the sweep covers the shipped table, not a list beside it
  const names = (MCP_TOOLS as ReadonlyArray<any>).map((t) => t.name);
  assert.deepEqual(
    names.filter((n) => !drives.has(n)),
    [],
    "a tool the sweep cannot drive is a tool the sweep does not check [I-8]",
  );
  assert.deepEqual([...drives.keys()].filter((n) => !names.includes(n)), [], "the sweep drives a tool that does not exist");

  const report: Array<{ name: string; readOnly: boolean; ok: boolean; wrote: boolean }> = [];
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    const drive = drives.get(tool.name)![0]!;
    const before = dbSnapshot(fx);
    const out = mcp(fx, drive.key, tool.name, drive.args);
    const after = dbSnapshot(fx);
    report.push({ name: tool.name, readOnly: tool.annotations.readOnlyHint, ok: !out.isError, wrote: before !== after });
    if (out.isError) console.log(`  [!] ${tool.name} did not succeed: ${JSON.stringify(out.data).slice(0, 160)}`);
  }
  const driven = report.filter((r) => r.ok).length;
  const reads = report.filter((r) => r.readOnly);
  const writes = report.filter((r) => !r.readOnly);
  console.log(
    `[I-8] tools driven through the shipped adapter: ${report.length}, succeeded: ${driven}, ` +
      `declared reading: ${reads.length}, declared writing: ${writes.length}`,
  );
  assert.equal(driven, report.length, `every tool must be driven to SUCCESS, or its hint is untested: ${report.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);

  const lied: string[] = [];
  for (const r of report) {
    if (r.readOnly && r.wrote) lied.push(`${r.name}: declared readOnlyHint TRUE and wrote to the database`);
    if (!r.readOnly && !r.wrote) lied.push(`${r.name}: declared readOnlyHint FALSE and changed nothing`);
  }
  assert.deepEqual(lied, [], "hints that are not true of the tool they are on [I-8]");
  console.log(
    `[I-8] proven: ${reads.length} reading tools left every table untouched; ${writes.length} writing tools moved one`,
  );
  fx.db.close();
});

// ---------------------------------------------------------------------------
// [I-8], EVERY HINT, AGAINST THE WHOLE ENVIRONMENT
//
// ROUND 2 was given ONE defect: 23 tools carried no annotations. It added the
// blocks and checked `readOnlyHint` against whether the database MOVED — a real
// sweep, over the whole table, and the fix was accepted on it. What it did not
// check is what it had just written: `skill.transfer` was given
// `idempotentHint: true` with a COMMENT BESIDE IT admitting that a repeat
// without an `idempotency_key` creates a second transfer.
//
// ROUND 3 fixed that: all three hints, all 36 tools, compared with behaviour.
// And it inherited round 2's MEASURE — a row of this database moving — which is
// not the environment the protocol's words are about. Twenty-seven tools were
// re-declared additive on the strength of a measure that never looked at the
// place two of them do their work. The class is one floor up from the one it
// fixed: not an incomplete SET OF MEMBERS, an incomplete QUANTITY.
//
// So the mechanical meanings below are stated over BOTH halves of the
// environment, and every one of them is a statement about the TOOL rather than
// about one convenient call of it — which is why a tool may be driven with
// several argument sets and is judged on the UNION of what they do:
//
//   readOnlyHint    true  ⟺ the call left every table AND every watched path
//                           untouched.
//   idempotentHint  true  ⟺ a SECOND call with the SAME arguments and NO
//                           idempotency key moved neither. That is the API's own
//                           definition: repeating the call has no additional
//                           effect. A repeat that is REFUSED satisfies it —
//                           nothing additional happened.
//   destructiveHint true  ⟺ the call changed or removed a row that already
//                           existed, OR removed a path that existed, OR replaced
//                           the bytes of one. A call that only INSERTS rows and
//                           only ADDS files is additive, which is the word the
//                           protocol uses for `false`.
//   openWorldHint   true  ⟺ the call ASKED the deployment where a foreign root
//                           is. That question has exactly one use, and a call
//                           that never asks it cannot have reached one — which
//                           is what makes the FALSE direction provable rather
//                           than merely unrefuted.
//
// The last is new here and it is what closes the hole the other three sit in. A
// measure applied only to the tools that DECLARE they reach outside would be
// the guard naming its own subject again — so the filesystem is fingerprinted
// around every one of the 36, and the hint is compared with what was seen.
//
// AND THE ASKING IS CORROBORATED, per tool, by whichever of two direct
// observations the tool's behaviour admits — with the grade printed beside each
// one, so nothing is claimed past what was seen:
//
//   MOVED    something under a configured root changed. The strongest grade,
//            and the one the deployment tools earn.
//   ANSWERED the call moves nothing, so it can be repeated: take the root away
//            and call again, and an answer that MOVES could not have come from
//            anywhere but the disk that went away.
//   ASKED    it asked, and neither corroboration is available to a black-box
//            measure — `fleet.list` walks a fleet member's directory and builds
//            an answer that happens not to carry anything from it, so no reply
//            of its can betray the walk. The sweep says ASKED and does not
//            pretend to more; both corroborations are required to fire
//            SOMEWHERE in the table, so neither instrument may quietly die.
// ---------------------------------------------------------------------------

/**
 * One `tools/call`, tolerating BOTH failure shapes, and returning the ANSWER.
 *
 * A tool that refuses answers with `isError`; a request the adapter itself
 * refuses answers with a JSON-RPC `error` and no `result` at all. The second
 * call of a pair reaches the second shape often — that is what a refused repeat
 * looks like — and a helper that assumed the first would crash the sweep on the
 * very behaviour it is measuring. The answer's BYTES are returned because the
 * root-withdrawal probe below compares two of them.
 */
function callTool(fx: P4Fixture, key: string, name: string, args: any): { ok: boolean; answer: string } {
  const res = rest(fx, "POST", "/mcp", key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = res.body?.result;
  if (result === undefined || result === null) return { ok: false, answer: JSON.stringify(res.body?.error ?? null) };
  return { ok: result.isError !== true, answer: JSON.stringify(result) };
}

/** Every row of every table, as a multiset of JSON strings per table. */
function dbRows(fx: P4Fixture): Map<string, Map<string, number>> {
  // `sqlite_%` is EXCLUDED, and this is the one narrow exclusion of the sweep.
  // `sqlite_sequence` is the engine's AUTOINCREMENT bookkeeping for
  // `transparency_log`, whose `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`:
  // appending one row to an INSERT-only journal moves that counter, so counting
  // it as "a row that already existed was changed" would make every tool that
  // writes a transparency-log entry `destructive` — which is the opposite of
  // what appending to an append-only log is.
  const tables = (
    fx.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out = new Map<string, Map<string, number>>();
  for (const t of tables) {
    const counts = new Map<string, number>();
    for (const row of fx.db.prepare(`SELECT * FROM "${t}"`).all() as unknown[]) {
      const key = JSON.stringify(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    out.set(t, counts);
  }
  return out;
}

/** What one call did to the DATABASE, in the two dimensions the hints claim. */
function diffOf(
  before: Map<string, Map<string, number>>,
  after: Map<string, Map<string, number>>,
): { wrote: boolean; changedExisting: boolean; changedTables: string[] } {
  let wrote = false;
  const changedTables: string[] = [];
  const tables = new Set([...before.keys(), ...after.keys()]);
  for (const t of tables) {
    const b = before.get(t) ?? new Map();
    const a = after.get(t) ?? new Map();
    for (const [row, n] of b) {
      const m = a.get(row) ?? 0;
      // a row that was there and is not there any more was UPDATED or DELETED —
      // the protocol's "destructive", as against an INSERT that only adds
      if (m < n) {
        wrote = true;
        if (!changedTables.includes(t)) changedTables.push(t);
      }
    }
    for (const [row, n] of a) if ((b.get(row) ?? 0) < n) wrote = true;
  }
  return { wrote, changedExisting: changedTables.length > 0, changedTables: changedTables.sort() };
}

interface ToolBehaviour {
  /** the first call moved a table */
  wrote: boolean;
  /** the first call changed or removed a row that already existed */
  changedExisting: boolean;
  /** …and the tables it changed one in, named so the claim is auditable */
  changedTables: string[];
  /** the first call moved a watched path — added, removed or rewritten */
  fsWrote: boolean;
  /** the first call REMOVED a path that existed, or replaced its bytes */
  fsDestroyed: boolean;
  /** …and the paths it took away or overwrote, named so the claim is auditable */
  fsGone: string[];
  /** how many paths it added, so an additive filesystem effect is visible too */
  fsAdded: number;
  /** a SECOND call with the same arguments and no idempotency key moved a table */
  repeatWrote: boolean;
  /** …or a watched path */
  repeatFsWrote: boolean;
  /** the call ASKED a configured foreign root where it is */
  consulted: boolean;
  /** the call answered DIFFERENTLY once that root was taken away. `null` means
   *  the probe was not applicable: it needs a repeat that changes nothing, so
   *  that the two answers being compared are answers to the same state. */
  answerDependsOnTheDisk: boolean | null;
  firstOk: boolean;
  secondOk: boolean;
  /** the argument sets this tool was driven with, printed with the result */
  labels: string[];
}

/** How well the tool's reach outside this registry is evidenced. */
type ForeignGrade = "MOVED" | "ANSWERED" | "ASKED" | "none";

function foreignGrade(b: ToolBehaviour): ForeignGrade {
  if (b.fsWrote) return "MOVED";
  if (b.answerDependsOnTheDisk === true) return "ANSWERED";
  return b.consulted ? "ASKED" : "none";
}

/**
 * THE COMPARISON, as a pure function of the declared table and the observed
 * behaviour — so the mutation below can break ONE member of the table at a time
 * without rewriting a file, and every one of the 36 can be broken in turn.
 */
function hintViolations(
  tools: ReadonlyArray<any>,
  observed: ReadonlyMap<string, ToolBehaviour>,
): string[] {
  const out: string[] = [];
  for (const tool of tools) {
    const b = observed.get(tool.name);
    if (b === undefined) {
      out.push(`${tool.name}: readOnlyHint — the sweep could not drive this tool, so its hints are untested`);
      continue;
    }
    const a = tool.annotations ?? {};
    const movedSomething = b.wrote || b.fsWrote;
    const destroyedSomething = b.changedExisting || b.fsDestroyed;
    const repeatMovedSomething = b.repeatWrote || b.repeatFsWrote;
    if (a.readOnlyHint === true && movedSomething) {
      out.push(`${tool.name}: readOnlyHint declared true and the call moved ${b.wrote ? "a row" : "a file"}`);
    }
    if (a.readOnlyHint === false && !movedSomething) out.push(`${tool.name}: readOnlyHint declared false and the call changed nothing`);
    if (a.readOnlyHint === true && a.destructiveHint === true) {
      out.push(`${tool.name}: destructiveHint declared true on a tool declared read-only`);
    }
    if (a.destructiveHint === true && !destroyedSomething) {
      out.push(`${tool.name}: destructiveHint declared true and the call only ADDED — no row and no path that existed was touched`);
    }
    if (a.destructiveHint === false && destroyedSomething) {
      out.push(
        `${tool.name}: destructiveHint declared false and the call ${b.changedExisting ? "changed or removed an existing row" : `removed or overwrote ${b.fsGone.length} path(s) that existed`}`,
      );
    }
    if (a.idempotentHint === true && repeatMovedSomething) {
      out.push(`${tool.name}: idempotentHint declared true and a repeat with the same arguments wrote again`);
    }
    if (a.idempotentHint === false && !repeatMovedSomething) {
      out.push(`${tool.name}: idempotentHint declared false and a repeat with the same arguments changed nothing`);
    }
    // THE FOREIGN HALF. Declared TRUE has to be shown; declared FALSE has to be
    // shown too, and the two are shown by different evidence because they are
    // different claims. "It reached one" needs a positive observation. "It
    // reached none" is settled by the tool never having asked where one is —
    // an unasked question cannot have been followed to a disk.
    if (a.openWorldHint === true && foreignGrade(b) === "none") {
      out.push(`${tool.name}: openWorldHint declared true and the call never asked for a foreign root, let alone reached one`);
    }
    if (a.openWorldHint === false && foreignGrade(b) !== "none") {
      out.push(`${tool.name}: openWorldHint declared false and the call reached outside this registry (${foreignGrade(b)})`);
    }
  }
  return out;
}

/**
 * Drive every tool, with every argument set it has, ONCE and then a SECOND time
 * with the same arguments — measuring BOTH halves of the environment around
 * each call, and then asking whether the answer depended on a foreign disk.
 */
function observeEveryTool(): { fx: P4Fixture; observed: Map<string, ToolBehaviour>; watched: string[] } {
  const world = toolDrive();
  const { fx, drives, watched, activation, inventory } = world;
  const names = (MCP_TOOLS as ReadonlyArray<any>).map((t) => t.name);
  assert.deepEqual(
    names.filter((n) => !drives.has(n)),
    [],
    "a tool the sweep cannot drive is a tool the sweep does not check [I-8]",
  );
  const observed = new Map<string, ToolBehaviour>();
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    const set = drives.get(tool.name)!;
    assert.ok(set.length > 0, `${tool.name}: no argument set at all`);
    const acc: ToolBehaviour = {
      wrote: false,
      changedExisting: false,
      changedTables: [],
      fsWrote: false,
      fsDestroyed: false,
      fsGone: [],
      fsAdded: 0,
      repeatWrote: false,
      repeatFsWrote: false,
      consulted: false,
      answerDependsOnTheDisk: null,
      firstOk: true,
      secondOk: true,
      labels: set.map((d) => d.label),
    };
    for (const drive of set) {
      // NO idempotency key in either call: `withIdempotency` would replay the
      // stored response of the first, and the question here is what the tool does
      // when a client simply calls it twice — which is what the hint answers.
      const consultedBefore = activation.consulted + inventory.consulted;
      const before = dbRows(fx);
      const fsBefore = fsFingerprint(watched);
      const first = callTool(fx, drive.key, tool.name, drive.args);
      const between = dbRows(fx);
      const fsBetween = fsFingerprint(watched);
      const second = callTool(fx, drive.key, tool.name, drive.args);
      const after = dbRows(fx);
      const fsAfter = fsFingerprint(watched);
      const d1 = diffOf(before, between);
      const d2 = diffOf(between, after);
      const f1 = fsDiff(fsBefore, fsBetween);
      const f2 = fsDiff(fsBetween, fsAfter);
      acc.wrote ||= d1.wrote;
      acc.changedExisting ||= d1.changedExisting;
      for (const t of d1.changedTables) if (!acc.changedTables.includes(t)) acc.changedTables.push(t);
      acc.fsWrote ||= fsMoved(f1);
      acc.fsDestroyed ||= fsDestroyed(f1);
      acc.fsGone.push(...f1.removed, ...f1.modified);
      acc.fsAdded += f1.added.length;
      acc.repeatWrote ||= d2.wrote;
      acc.repeatFsWrote ||= fsMoved(f2);
      acc.firstOk &&= first.ok;
      acc.secondOk &&= second.ok;
      acc.consulted ||= activation.consulted + inventory.consulted > consultedBefore;

      // THE ROOT-WITHDRAWAL PROBE. It is only meaningful where the SECOND call
      // changed nothing in either half: then the state the third call meets is
      // the state the second met, the two answers are answers to the same
      // question, and a difference between them cannot come from anywhere but
      // the disk that was taken away.
      if (!d2.wrote && !fsMoved(f2)) {
        activation.present = false;
        inventory.present = false;
        const third = callTool(fx, drive.key, tool.name, drive.args);
        activation.present = true;
        inventory.present = true;
        acc.answerDependsOnTheDisk = (acc.answerDependsOnTheDisk ?? false) || third.answer !== second.answer;
      }
    }
    acc.changedTables.sort();
    acc.fsGone.sort();
    observed.set(tool.name, acc);
  }
  return { fx, observed, watched };
}

test("[I-8] the filesystem half of the measure proves it SEES a file die before it is used to judge one", () => {
  // The proof runs inside the judging tests too — this one gives it a name of
  // its own in the output, so a run in which the eye stopped working reports
  // THAT rather than a table of tools that all look additive.
  console.log(proveTheSensorSeesTheFilesystem());
});

test("[I-8] the clauses no shipped tool exercises are proved on constructed behaviour, and the emptiness is PRINTED", () => {
  // A SWEEP OVER AN EMPTY SET PROVES NOTHING, and three of the clauses added
  // this round have no member in the shipped table: no tool writes to a disk
  // WITHOUT writing a row, and none rewrites a disk on a repeat. Their rules
  // cannot be exercised by driving the registry, so they are exercised
  // directly — and the count of shipped members is printed beside each, so
  // nobody reads a silent pass as coverage that is not there.
  const inert = {
    wrote: false,
    changedExisting: false,
    changedTables: [],
    fsWrote: false,
    fsDestroyed: false,
    fsGone: [],
    fsAdded: 0,
    repeatWrote: false,
    repeatFsWrote: false,
    consulted: false,
    answerDependsOnTheDisk: null,
    firstOk: true,
    secondOk: true,
    labels: ["constructed"],
  } satisfies ToolBehaviour;
  const cases: Array<{ what: string; annotations: any; behaviour: ToolBehaviour; expect: RegExp }> = [
    {
      what: "a tool that declares itself a READ and writes only to a disk",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      behaviour: { ...inert, fsWrote: true, fsAdded: 1, consulted: true },
      expect: /readOnlyHint declared true and the call moved a file/,
    },
    {
      what: "a tool that declares itself additive and only removes files",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      behaviour: { ...inert, fsWrote: true, fsDestroyed: true, fsGone: ["a/SKILL.md"], consulted: true },
      expect: /destructiveHint declared false and the call removed or overwrote 1 path/,
    },
    {
      what: "a tool that declares itself idempotent and rewrites a disk on the repeat",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      behaviour: { ...inert, fsWrote: true, fsAdded: 1, repeatFsWrote: true, consulted: true },
      expect: /idempotentHint declared true and a repeat with the same arguments wrote again/,
    },
    {
      what: "a tool that declares a closed world and moves something outside it",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      behaviour: { ...inert, wrote: true, fsWrote: true, fsAdded: 1 },
      expect: /openWorldHint declared false and the call reached outside this registry \(MOVED\)/,
    },
    {
      what: "a tool that declares an open world and never asks where one is",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      behaviour: { ...inert },
      expect: /openWorldHint declared true and the call never asked for a foreign root/,
    },
  ];
  for (const c of cases) {
    const found = hintViolations([{ name: "constructed.tool", annotations: c.annotations }], new Map([["constructed.tool", c.behaviour]]));
    console.log(`  ${c.what}\n      → ${found.join(" · ") || "(nothing)"}`);
    assert.ok(found.some((v) => c.expect.test(v)), `${c.what}: the clause did not fire — ${JSON.stringify(found)}`);
  }

  // …and how many of the 36 stand on each clause today, printed rather than assumed
  const { fx, observed } = observeEveryTool();
  const members = [
    ["a filesystem write with no row behind it", [...observed].filter(([, b]) => b.fsWrote && !b.wrote)],
    ["a repeat that moves the filesystem again", [...observed].filter(([, b]) => b.repeatFsWrote)],
    ["a filesystem removal or overwrite", [...observed].filter(([, b]) => b.fsDestroyed)],
  ] as const;
  for (const [what, rows] of members) {
    console.log(`[I-8] shipped tools exercising "${what}": ${rows.length}${rows.length ? ` (${rows.map(([n]) => n).join(", ")})` : " — the clause above is its only proof"}`);
  }
  fx.db.close();
});

test("[I-8] every hint is checked against what each of the 36 tools does to BOTH halves of its environment", () => {
  // THE EYE IS PROVED OPEN BEFORE IT IS TRUSTED TO JUDGE.
  console.log(proveTheSensorSeesTheFilesystem());
  const { fx, observed, watched } = observeEveryTool();
  console.log(`[I-8] tools driven twice through the shipped adapter: ${observed.size}/${MCP_TOOLS.length}`);
  console.log(`[I-8] argument sets driven: ${[...observed.values()].reduce((n, b) => n + b.labels.length, 0)}`);
  console.log(`[I-8] paths under watch at the end of the sweep: ${fsFingerprint(watched).size}`);
  console.log(
    `  ${"tool".padEnd(26)} ${"row+".padEnd(5)} ${"row!".padEnd(5)} ${"fs+".padEnd(5)} ${"fs!".padEnd(5)} ` +
      `${"rpt".padEnd(4)} ${"foreign".padEnd(8)} ${"1st".padEnd(4)} 2nd`,
  );
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    const b = observed.get(tool.name)!;
    console.log(
      `  ${tool.name.padEnd(26)} ${String(b.wrote).padEnd(5)} ${String(b.changedExisting).padEnd(5)} ` +
        `${String(b.fsAdded).padEnd(5)} ${String(b.fsGone.length).padEnd(5)} ` +
        `${String(b.repeatWrote || b.repeatFsWrote).padEnd(4)} ${foreignGrade(b).padEnd(8)} ` +
        `${String(b.firstOk).padEnd(4)} ${String(b.secondOk).padEnd(6)} ` +
        `${b.changedTables.join(",")}${b.fsGone.length > 0 ? ` | gone: ${b.fsGone.slice(0, 3).join(" ")}${b.fsGone.length > 3 ? " …" : ""}` : ""}`,
    );
  }
  const driven = [...observed.values()].filter((b) => b.firstOk).length;
  assert.equal(driven, observed.size, "every tool must reach SUCCESS on its first call, or its hints are untested");

  // THE SPLIT MUST BE A REAL SPLIT in every dimension — a table whose every tool
  // answered the same way would pass the comparison by never exercising one
  // side of it. A dimension nobody is on either side of is a dimension the
  // sweep is not measuring at all.
  const all = [...observed.values()];
  const dims = [
    ["writing a row", all.filter((b) => b.wrote).length],
    ["changing a row that existed", all.filter((b) => b.changedExisting).length],
    ["adding a path", all.filter((b) => b.fsAdded > 0).length],
    ["removing or overwriting a path", all.filter((b) => b.fsDestroyed).length],
    ["writing again on a repeat", all.filter((b) => b.repeatWrote || b.repeatFsWrote).length],
    ["reaching a foreign filesystem", all.filter((b) => foreignGrade(b) !== "none").length],
  ] as const;
  for (const [what, n] of dims) console.log(`[I-8] observed ${String(n).padStart(2)}/${observed.size} tools ${what}`);
  for (const [what, n] of dims) {
    assert.ok(n > 0 && n < observed.size, `every tool answered the same way for "${what}": the check distinguishes nothing`);
  }
  // …and the foreign half was really watched: the sweep must have SEEN a file
  // die, or its destructive measure over the filesystem proved nothing.
  const gone = all.reduce((n, b) => n + b.fsGone.length, 0);
  console.log(`[I-8] paths removed or overwritten by the tools themselves during the sweep: ${gone}`);
  assert.ok(gone > 0, "not one path was taken away: the filesystem half of the measure was never exercised");

  // BOTH CORROBORATIONS MUST FIRE SOMEWHERE. `ASKED` on its own is the weakest
  // grade the sweep accepts, and it would become the only grade — and the
  // openWorld check would become a check of nothing — if either instrument
  // silently stopped working.
  const grades = new Map<ForeignGrade, string[]>([["MOVED", []], ["ANSWERED", []], ["ASKED", []], ["none", []]]);
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) grades.get(foreignGrade(observed.get(tool.name)!))!.push(tool.name);
  for (const [grade, names] of grades) console.log(`[I-8] foreign reach ${grade.padEnd(8)} ${String(names.length).padStart(2)}: ${names.join(", ")}`);
  assert.ok(grades.get("MOVED")!.length > 0, "no tool was seen to move anything on a foreign disk: that instrument is dead");
  assert.ok(grades.get("ANSWERED")!.length > 0, "no tool answered differently when its root went away: that instrument is dead");

  assert.deepEqual(hintViolations(MCP_TOOLS as ReadonlyArray<any>, observed), [], "hints that are not true of the tool they are on [I-8]");
  fx.db.close();
});

test("[I-8] the measure that watches only the database is shown to MISS what the deployment tools do", () => {
  // THE DISCRIMINATION THIS ROUND TURNS ON, run as an experiment rather than
  // argued. The same observations are passed to the same comparison twice: once
  // whole, once with the filesystem half blanked out — which is exactly the
  // measure round 3 used. If the shipped table is clean under both, the new
  // half is decoration. It is not: the hints the full measure justifies are
  // hints the narrow one calls lies, and the tools it names are the ones that
  // remove and rewrite files.
  const { fx, observed } = observeEveryTool();
  assert.deepEqual(hintViolations(MCP_TOOLS as ReadonlyArray<any>, observed), [], "the shipped table must be clean under the full measure first");

  const databaseOnly = new Map(
    [...observed].map(([name, b]) => [
      name,
      { ...b, fsWrote: false, fsDestroyed: false, fsGone: [], fsAdded: 0, repeatFsWrote: false, consulted: false, answerDependsOnTheDisk: null },
    ]),
  );
  const missed = hintViolations(MCP_TOOLS as ReadonlyArray<any>, databaseOnly);
  console.log(`[I-8] hints the DATABASE-ONLY measure cannot justify: ${missed.length}`);
  for (const m of missed) console.log(`    ${m}`);
  killed("the database-only measure was enough — the filesystem half changes no verdict", () => {
    assert.deepEqual(missed, [], "the narrow measure agreed with the full one");
  });
  // and it is the deployment tools it loses, named rather than counted
  const lostTools = [...new Set(missed.map((m) => m.split(":")[0]!))].sort();
  console.log(`[I-8] tools whose hints only the FULL measure can justify: ${lostTools.join(", ")}`);
  assert.ok(lostTools.length > 0, "the two measures did not differ on any tool");
  fx.db.close();
});

test("[I-8] the guard is proved by breaking EVERY member of the table in turn, hint by hint", () => {
  const { fx, observed } = observeEveryTool();
  assert.deepEqual(hintViolations(MCP_TOOLS as ReadonlyArray<any>, observed), [], "the shipped table must be clean first");

  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
  const survived: string[] = [];
  let mutations = 0;
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    for (const hint of HINTS) {
      mutations += 1;
      // one member, one hint, flipped — the rest of the table untouched
      const mutated = (MCP_TOOLS as ReadonlyArray<any>).map((t) =>
        t.name === tool.name
          ? { ...t, annotations: { ...t.annotations, [hint]: !t.annotations[hint] } }
          : t,
      );
      const found = hintViolations(mutated, observed);
      if (!found.some((v) => v.startsWith(`${tool.name}: `))) {
        survived.push(`${tool.name}.${hint} = ${!tool.annotations[hint]} produced no violation`);
      }
    }
  }
  console.log(`[I-8] hint mutations applied: ${mutations} (${MCP_TOOLS.length} tools × ${HINTS.length} hints)`);
  console.log(`[I-8] mutations the guard caught: ${mutations - survived.length}/${mutations}`);
  assert.equal(mutations, MCP_TOOLS.length * HINTS.length, "the sweep must break every member, not a sample");
  assert.deepEqual(survived, [], "hint lies the guard does not see — the guard is true of some members and not of all");
  fx.db.close();
});

test("[I-8] the mutation that removes ONE tool's annotations, and the one that lies in it, are both killed", async () => {
  // (a) STRIPPED. `dashboard.view` had no annotations at all until this round,
  // and the suite that shipped never noticed — because it asked about the tools
  // it had just added. The sweep is over `MCP_TOOLS`, so removing any one block
  // is caught wherever it is removed from.
  const stripped = await mutantTree("mcp.ts", [
    [
      `    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string" },`,
      `    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string" },`,
    ],
  ]);
  killed("a tool with no annotations at all passed the [I-8] sweep", () => {
    for (const tool of stripped["mcp.ts"]!.MCP_TOOLS as ReadonlyArray<any>) {
      assert.ok(tool.annotations && typeof tool.annotations === "object", `${tool.name} has annotations`);
    }
  });

  // (b) A LIE. `skill.create` writes; a hint that says otherwise is one a
  // client acts on by not asking. The sweep compares the hint with whether the
  // DATABASE MOVED, so the lie is caught by the tool's own behaviour and not by
  // a table of expected values kept beside it.
  const lying = await mutantTree("mcp.ts", [
    [
      `    name: "skill.create",`,
      `    name: "skill.create", // the tool below is about to be told to lie`,
    ],
    [
      `      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        skill_id: { type: "string" },
        archive_base64: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["archive_base64"],
    },`,
      `      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        skill_id: { type: "string" },
        archive_base64: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["archive_base64"],
    },`,
    ],
  ]);
  const { fx, drives } = toolDrive();
  const drive = drives.get("skill.create")![0]!;
  const before = dbSnapshot(fx);
  const out = lying["mcp.ts"]!.handleMcpMessage(fx.registry, fx.author, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "skill.create", arguments: drive.args },
  });
  const wrote = dbSnapshot(fx) !== before;
  const hint = (lying["mcp.ts"]!.MCP_TOOLS as ReadonlyArray<any>).find((t) => t.name === "skill.create")!.annotations
    .readOnlyHint;
  console.log(`  [mutant answered] skill.create readOnlyHint=${hint}, wrote=${wrote}, error=${out.result?.isError === true}`);
  killed("a writing tool declared read-only survived the comparison with what it did", () => {
    assert.equal(hint === true && wrote, false, "declared readOnlyHint TRUE and wrote to the database");
  });
  fx.db.close();
});

// ===========================================================================
// 4. [I-1] AND [I-3] — ON ALL ELEVEN VIEWS, OVER THE BYTES A CLIENT RECEIVES
// ===========================================================================
//
// TWO FAILURES, AND THE SECOND IS THE ONE THAT MATTERS.
//
// The first: six of the eleven views were built before either invariant had a
// shape. They put RAW VALUES into rows, so a null rendered as `—` and a count
// rendered as a bare figure. A live `/v1/dashboard/library?format=html` carried
// three dashes and four naked numbers.
//
// The second: the SWEEP THAT EXISTS DID NOT SEE THEM. `auditRenderedHtml` was
// only ever pointed at the five newest views, and even there it recognised a
// number only when the ENTIRE cell was digits — so `steps: N | files: N` and
// `declared steps: N` returned zero violations and `number_cells: 0`. A guard
// whose silence is read as a pass, over a set chosen to exclude the failures.
//
// So: every view, both encodings, the finished bytes, and the SIZE of what was
// swept printed for each — because a sweep over an empty page proves nothing
// and the only way to tell the two apart is the number.

/** One graph that puts rows on all eleven views at once. */
function allViews(): P4Fixture {
  const fx = p4Fixture();
  const adopted = publishedVersion(fx, "views-adopted");
  const run = adoptThroughSurfaces(fx, adopted, fx.keys.member);
  rateThroughSurface(fx, adopted, fx.keys.member, run.receiptId, 5);

  // a §7.3 hold that STAYS held, so the `holds` section has a row…
  const base = makeManifest({});
  const risky = {
    manifest: {
      scope: { ...base.scope, risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] },
      safety: { ...base.safety, sandbox_requirement: "required" },
    },
  };
  const held = reviewedVersion(fx, "views-held", risky);
  const holdReq = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: held.versionId });
  assert.equal(holdReq.body.state, "approval_pending", holdReq.raw);

  // …and a second one that is DECIDED, so the `decisions` section has one too
  const decided = reviewedVersion(fx, "views-decided", risky);
  const decidedReq = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: decided.versionId });
  assert.equal(decidedReq.body.state, "approval_pending", decidedReq.raw);
  const approved = rest(fx, "POST", `/v1/versions/${decided.versionId}/approvals`, fx.keys.owner, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: decidedReq.body.adoption_request_id,
    note: "sandboxed rollout approved",
  });
  assert.equal(approved.status, 201, approved.raw);

  // an endpoint, so the dead-letter view's health section has a row
  const hook = rest(fx, "POST", "/v1/webhooks", fx.keys.owner, { url: "https://hooks.example/views" });
  assert.equal(hook.status, 201, hook.raw);

  // a deployment, so the fleet and agent screens compare something
  for (const action of [TRANSFER_ACTION, "activate"]) {
    assert.equal(
      rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
        agent_id: fx.owner.agent_id,
        action,
        recipient_scope: "local_agent",
      }).status,
      201,
    );
  }
  const pushed = rest(fx, "POST", `/v1/versions/${adopted.versionId}/transfers`, fx.keys.owner, {
    recipient: { kind: "local_agent", ref: fx.reviewer.agent_id },
  });
  assert.equal(pushed.status, 201, pushed.raw);
  return fx;
}

test("[I-1]/[I-3] all ELEVEN views audit clean on the finished HTML and the finished JSON", () => {
  const fx = allViews();
  console.log(`[I-1]/[I-3] views declared in src/dashboard.ts: ${DASHBOARD_VIEWS.length}`);
  assert.equal(DASHBOARD_VIEWS.length, 11, "the sweep must cover the shipped view list, whatever its length");

  let totalCells = 0;
  let totalNumbers = 0;
  let builtCells = 0;
  let notices = 0;
  let payloadCells = 0;
  let payloadStrings = 0;
  const problems: string[] = [];
  /** every notice this build can serve, from the source constants */
  const DECLARED_NOTICES = [RECONCILIATION_LEGEND, ...APPROVAL_NOTICES];
  for (const view of DASHBOARD_VIEWS) {
    const html = rest(fx, "GET", `/v1/dashboard/${view}?format=html`, fx.keys.owner);
    assert.equal(html.status, 200, html.raw);
    const json = rest(fx, "GET", `/v1/dashboard/${view}`, fx.keys.owner);
    assert.equal(json.status, 200, json.raw);
    const h = auditRenderedHtml(html.raw);
    const j = auditRenderedJson(json.raw);
    // [B-2] THE PROVENANCE SWEEP, over the payload the registry BUILT rather
    // than over its bytes: every row value a member of the constructor's own
    // set, and every string that is not a row value — title, section title,
    // column names, `empty`, `note`, notices, cursor, row-class field — under
    // the rule its own name selects. Both numbers are printed, because a sweep
    // over an empty payload proves nothing.
    const built = fx.registry.dashboard(fx.owner, view);
    const prov = auditDashboardPayload(built);
    payloadCells += prov.cells;
    payloadStrings += prov.string_fields;
    assert.deepEqual(prov.violations, [], `${view}: the payload the registry built`);
    assert.equal(prov.unminted, 0, `${view}: row values no cell constructor produced`);
    assert.ok(prov.cells > 0, `${view}: the payload carried no row value at all`);
    assert.ok(prov.string_fields > 0, `${view}: no furniture string was checked`);
    console.log(
      `  ${view.padEnd(15)} html: rows=${String(h.rows).padStart(3)} cells=${String(h.cells).padStart(4)} ` +
        `built=${String(h.constructed).padStart(4)} unbuilt=${String(h.unconstructed).padStart(2)} ` +
        `numbers=${String(h.number_cells).padStart(3)} states=${String(h.state_cells).padStart(3)} ` +
        `violations=${h.violations.length} · json: cells=${String(j.cells).padStart(4)} built=${String(j.constructed).padStart(4)} unbuilt=${String(j.unconstructed).padStart(2)} violations=${j.violations.length}`,
    );
    // [B-2] THE STRUCTURAL CLAIM, OVER THE SHIPPED BYTES: every cell a client
    // receives carries the mark only a constructor sets, and the count of cells
    // WITHOUT it is zero. This is the number the claim is made of — a page
    // whose cells were all built cannot be carrying a value in a notation the
    // figure pattern has never seen, because a value cannot be there at all
    // without the method the constructor attached to it.
    assert.equal(h.unconstructed, 0, `${view}: cells on the PAGE that no cell builder produced`);
    assert.equal(j.unconstructed, 0, `${view}: cells in the BODY that no cell builder produced`);
    assert.equal(h.constructed, h.cells, `${view}: the page's built cells are not all of its cells`);
    assert.equal(j.constructed, j.cells, `${view}: the body's built cells are not all of its cells`);
    builtCells += h.constructed;
    // …and the only text on a view that is NOT a cell — a notice — is a
    // CONSTANT of the source, byte for byte. Nothing about the data reaches a
    // reader through that path, which is why the sweep does not need to parse
    // one, and this is the assertion that keeps it true.
    for (const notice of (json.body.notices ?? []) as Array<{ kind: string; subject: string; detail: string }>) {
      notices += 1;
      assert.ok(
        DECLARED_NOTICES.some((n) => n.kind === notice.kind && n.subject === notice.subject && n.detail === notice.detail),
        `${view}: a notice that is not one of the declared constants — ${notice.subject}`,
      );
    }
    for (const v of [...h.violations, ...j.violations]) problems.push(`${view}: ${v.where} — ${v.problem}`);
    // A SWEEP OVER AN EMPTY PAGE PROVES NOTHING. Every view must have carried
    // cells, and the two encodings must have carried the SAME ones.
    assert.ok(h.cells > 0, `${view}: the page carried no cell at all — this view was not actually checked`);
    assert.equal(j.cells, h.cells, `${view}: the JSON and the page do not carry the same cells`);
    // [I-1]: `unknown` is a WORD. Not a blank, not a dash, not an `n/a`.
    // The list is the one `test/p14-fleet-dashboard.test.ts` applies to §9's
    // five screens; here it runs over all eleven.
    for (const cell of parseTables(html.raw).flatMap((t) => t.rows.flatMap((r) => r.cells))) {
      assert.notEqual(cell, "", `${view}: an EMPTY cell`);
      assert.ok(
        !["—", "–", "-", "n/a", "N/A", "null", "undefined", "?"].includes(cell),
        `${view}: a placeholder cell ${JSON.stringify(cell)}`,
      );
    }
    // …and both adapters serve ONE answer for every view, not only for the five
    const viaMcp = mcp(fx, fx.keys.owner, "dashboard.view", { view });
    assert.equal(viaMcp.isError, false, `${view}: MCP refused the view`);
    assert.deepEqual(viaMcp.data, json.body, `${view}: the adapters serve one payload`);
    assert.equal(
      mcp(fx, fx.keys.owner, "dashboard.view", { view, format: "html" }).data.html,
      html.raw,
      `${view}: the adapters serve one page`,
    );
    totalCells += h.cells;
    totalNumbers += h.number_cells;
  }
  assert.deepEqual(problems, [], "violations found on the shipped bytes of the eleven views");
  console.log(`[I-1]/[I-3] swept ${totalCells} cells across ${DASHBOARD_VIEWS.length} views, of which ${totalNumbers} are numbers`);
  console.log(`[B-2] cells carrying a constructor's mark: ${builtCells}/${totalCells}; cells carrying none: ${totalCells - builtCells}`);
  console.log(`[B-2] row values whose PROVENANCE was checked by identity across the eleven payloads: ${payloadCells}, of which 0 came from anywhere but the constructor`);
  console.log(`[B-2] non-cell strings checked by their own rule across the eleven payloads: ${payloadStrings}`);
  console.log(`[B-2] notices served across the eleven views: ${notices}, every one of them a constant of the source (${DECLARED_NOTICES.length} declared)`);
  assert.ok(totalNumbers > 0, "not one number was checked: the sweep would pass on a page with no figures at all");
  assert.equal(builtCells, totalCells, "cells reached a reader without passing a cell builder");
  assert.ok(notices > 0, "no notice was checked: the notice rule would pass on views that serve none");
  fx.db.close();
});

// ---------------------------------------------------------------------------
// [I-3] — WHY THE NOTATION STOPPED BEING THE QUESTION
//
// THE HISTORY, because it is the argument. Round 1 recognised a number only
// when the whole cell was digits, and `steps: 4 | files: 7` walked past it.
// Round 2 recognised a standalone run of digits, and `4.5` walked past that.
// Round 3 declared the rule inverted and universal — "a figure in ANY notation"
// — and a reviewer answered with `.75`, `⅔`, `٤٫٥`, `1:2`, `1×10³`, `5‰`,
// `0x10` and `12·5`. Three rounds, three widenings, and the same defect each
// time: THE CLAIM WAS UNIVERSAL AND THE MECHANISM WAS A LIST.
//
// A fourth widening would be the same mistake with eight more rows in it, so
// this round does not widen anything. It removes the way a value reaches a page
// without a method AT ALL:
//
//   * `Cell` is a branded string, and a section's `rows` hold nothing else, so
//     a template interpolating a bare value does not compile;
//   * every constructor stamps `kind:` and the method its kind requires;
//   * `auditCells` demands that mark of EVERY cell on the finished page.
//
// So the corpus below is run through the sweep TWICE, and the second run is
// what makes it a proof rather than a longer list:
//
//   AS A BARE CELL — every notation, figure or not, the reviewer's eight
//   included, must be REFUSED. Not because the pattern learned them: because
//   none of them carries a method, and nothing in this program can produce such
//   a cell any more.
//
//   THROUGH A CONSTRUCTOR — the same text, published the way the code publishes
//   it, must be CLEAN. That is the half that keeps the first half honest: a
//   guard that refused everything would pass the first run and fail this one.
//
// The third table is the HEURISTIC's, and it is printed as a heuristic: which
// figures the pattern still recognises when one is put in a cell of the wrong
// kind. That is a question of an author's judgement, not of escape, and the
// invariant does not rest on the answer.
// ---------------------------------------------------------------------------

/** The body of the round-2 sweep, as the mutation that restores it. */
const ROUND_TWO_SWEEP = `  const out: string[] = [];
  for (const token of tokensOf(text)) {
    if (!NUMBER_TOKEN.test(token) && !FRACTION_TOKEN.test(token)) continue;
    if (excludedFromCounting(token)) continue;
    out.push(token);
  }
  return out;`;

interface Notation {
  /** the cell text, exactly as a renderer would emit it */
  cell: string;
  /** whether a reader reads a COUNT in it */
  figure: boolean;
  why: string;
}

const NUMBER_NOTATIONS: readonly Notation[] = [
  // ---- figures, in every notation a figure is written in
  { cell: "7", figure: true, why: "a bare integer — the shape round 1 could see" },
  { cell: "steps: 4 | files: 7", figure: true, why: "integers inside prose — the shape round 2 was given" },
  { cell: "declared steps: 3", figure: true, why: "one integer inside prose" },
  { cell: "4.5", figure: true, why: "a DECIMAL — the shape round 2 stopped in front of" },
  { cell: "the average is 4.5 across the fleet", figure: true, why: "a decimal inside prose" },
  { cell: "0.5", figure: true, why: "a decimal below one" },
  { cell: "-3", figure: true, why: "a negative integer" },
  { cell: "−3", figure: true, why: "a negative written with U+2212, which a renderer may emit" },
  { cell: "-2.5", figure: true, why: "a negative decimal" },
  { cell: "+4", figure: true, why: "an explicitly signed integer" },
  { cell: "1,234", figure: true, why: "grouped by commas" },
  { cell: "1 234", figure: true, why: "grouped by a narrow no-break space" },
  { cell: "1'234", figure: true, why: "grouped by apostrophes" },
  { cell: "12,345,678", figure: true, why: "grouped twice" },
  { cell: "1.5e3", figure: true, why: "exponential" },
  { cell: "2E-4", figure: true, why: "exponential, negative exponent, capital E" },
  { cell: "50%", figure: true, why: "a percentage" },
  { cell: "99.9%", figure: true, why: "a decimal percentage" },
  { cell: "4/5", figure: true, why: "a ratio — two counts, and round 2 excluded it by construction" },
  { cell: "gates passed 4/5, average 4.5", figure: true, why: "a ratio and a decimal in one sentence" },
  { cell: "0", figure: true, why: "zero is a measured count and the one most often published bare" },
  { cell: "(12)", figure: true, why: "a figure a renderer wrapped in brackets" },
  { cell: "the count is 12.", figure: true, why: "a figure at the end of a sentence" },
  { cell: "adopted 3 times", figure: true, why: "a figure between two words" },

  // ---- NOT figures: values written with digits that no reader adds up
  { cell: "1.0.0", figure: false, why: "a semantic version" },
  { cell: "version 2.11.3 of the package", figure: false, why: "a semantic version inside prose" },
  { cell: "01K1M83S80ZZZZZZZZZZZZZZZZ", figure: false, why: "a ULID — 26 Crockford base32 characters" },
  { cell: "01234567890123456789012345", figure: false, why: "the degenerate all-digit ULID, still 26 characters" },
  { cell: "2026-08-10T00:00:00.000Z", figure: false, why: "an ISO-8601 instant" },
  { cell: "sha256:9f86d081884c7d65", figure: false, why: "a digest" },
  { cell: "SKLN1-ABCDEFGHIJKLMNOP", figure: false, why: "a §5 arrival marker" },
  { cell: "§5.3", figure: false, why: "a section of the specification" },
  { cell: "the §5.3 receipt machine", figure: false, why: "a section reference inside prose" },
  { cell: "[I-3]", figure: false, why: "an invariant reference" },
  { cell: "a count with no method [I-3]", figure: false, why: "an invariant reference at the end of a sentence" },
  { cell: "evidence-v1", figure: false, why: "a schema revision" },
  { cell: "dogfood-01-echo-token", figure: false, why: "a slug carrying digits" },
  { cell: "claude-code", figure: false, why: "a runtime id with no digits at all" },
  { cell: "g1=pass", figure: false, why: "a gate identifier and its result" },
  { cell: "seq#4: adopted", figure: false, why: "an ordinal, written joined to its sigil" },

  // ---- THE EIGHT ROUND 3 WAS ANSWERED WITH. They are here as a RECORD, not as
  // a proof: every one of them is refused below because it carries no method,
  // exactly as `7` and `1.0.0` are, and none of them was added to a pattern.
  { cell: ".75", figure: true, why: "a decimal with no leading zero — round 3's grammar required a digit first" },
  { cell: "⅔", figure: true, why: "a vulgar fraction, one code point (U+2154)" },
  { cell: "٤٫٥", figure: true, why: "Arabic-Indic digits with the Arabic decimal separator" },
  { cell: "1:2", figure: true, why: "a ratio written with a colon" },
  { cell: "1×10³", figure: true, why: "scientific notation written the way a person writes it" },
  { cell: "5‰", figure: true, why: "per mille" },
  { cell: "0x10", figure: true, why: "hexadecimal" },
  { cell: "12·5", figure: true, why: "a decimal written with a middle dot — which is also this file's own separator" },
];

/** The eight, as their own set, so the table can name them. */
const ROUND_THREE_ANSWER = [".75", "⅔", "٤٫٥", "1:2", "1×10³", "5‰", "0x10", "12·5"];

/** One notation, put on a page AS A BARE CELL — the way a template that
 *  interpolated a value would have emitted it before `Cell` existed. */
function bareCell(cell: string): RenderAudit {
  return auditRenderedHtml(`<table><thead><tr><th>c</th></tr></thead><tbody><tr><td>${cell}</td></tr></tbody></table>`);
}

/** The same notation, published THROUGH THE CONSTRUCTORS the code uses: a
 *  quantity as a measured number, everything else as a label. */
function constructedCell(n: Notation, i: number): RenderAudit {
  // the REASON carries no figure of its own: a count inside a `why:` is a count
  // with no method, which is a violation in its own right and would make this
  // probe measure the wrong thing
  const cell = n.figure
    ? numberCell(registryCount(i, "outcome", "the corpus of notations, as a measured number", "one entry of the corpus"))
    : labelCell("corpus_entry", n.cell, "one entry of the corpus", "the corpus of notations, as a label");
  return auditRenderedHtml(
    `<table><thead><tr><th>c</th></tr></thead><tbody><tr><td>${escapeHtml(cell.text)}</td></tr></tbody></table>`,
  );
}

test("[I-3] NO notation reaches a page without a method, and the constructed cell is clean", () => {
  const figures = NUMBER_NOTATIONS.filter((n) => n.figure);
  const others = NUMBER_NOTATIONS.filter((n) => !n.figure);
  console.log(`[I-3] notations in the corpus: ${NUMBER_NOTATIONS.length} (${figures.length} quantities, ${others.length} not counts)`);
  console.log(`[I-3] of them, the eight round 3 was answered with: ${ROUND_THREE_ANSWER.length}`);
  console.log(`  ${"cell".padEnd(34)} ${"bare".padEnd(20)} ${"constructed".padEnd(12)} why`);

  const escaped: string[] = [];
  const falselyRefused: string[] = [];
  let bareRefused = 0;
  let constructedClean = 0;
  NUMBER_NOTATIONS.forEach((n, i) => {
    // (1) AS A BARE CELL: refused, whatever it says.
    const bare = bareCell(n.cell);
    // (2) THROUGH A CONSTRUCTOR: clean, whatever it says.
    const built = constructedCell(n, i + 1);
    const bareOk = bare.violations.length > 0 && bare.unconstructed === 1 && bare.constructed === 0;
    const builtOk = built.violations.length === 0 && built.unconstructed === 0 && built.constructed === 1;
    if (bareOk) bareRefused += 1;
    else escaped.push(`${JSON.stringify(n.cell)} (${n.why}) reached the page unconstructed and the sweep allowed it`);
    if (builtOk) constructedClean += 1;
    else falselyRefused.push(`${JSON.stringify(n.cell)} (${n.why}) was refused after being published properly: ${built.violations[0]?.problem ?? "no violation, but the marks are wrong"}`);
    console.log(
      `  ${JSON.stringify(n.cell).padEnd(34)} ${(bareOk ? "refused" : "ESCAPED").padEnd(20)} ${(builtOk ? "clean" : "REFUSED").padEnd(12)} ${n.why}`,
    );
  });

  console.log(`[I-3] bare cells refused: ${bareRefused}/${NUMBER_NOTATIONS.length}; constructed cells clean: ${constructedClean}/${NUMBER_NOTATIONS.length}`);
  // A CORPUS WITH ONLY ONE SIDE PROVES NOTHING: a guard that refused everything
  // would pass the first column and fail the second, and one that refused
  // nothing would do the reverse.
  assert.ok(figures.length >= 28, `the corpus must exercise the notations broadly, found ${figures.length}`);
  assert.ok(others.length >= 10, `the corpus must exercise the non-counts too, found ${others.length}`);
  for (const eight of ROUND_THREE_ANSWER) {
    assert.ok(NUMBER_NOTATIONS.some((n) => n.cell === eight), `the corpus must carry ${eight}, which round 3 was answered with`);
  }
  assert.deepEqual(escaped, [], "notations that reached a page with no method at all");
  assert.deepEqual(falselyRefused, [], "notations the guard refuses even when they are published correctly");

  // …AND THE PATTERN IS PRINTED AS WHAT IT IS. This is the heuristic's own
  // coverage — which quantities it still recognises when one is put in a cell of
  // the WRONG KIND — and it is a question about an author's judgement, not about
  // escape. The invariant above does not rest on any row of this table.
  const seen: string[] = [];
  const unseen: string[] = [];
  for (const n of figures) {
    const inALabel = auditRenderedHtml(
      `<table><thead><tr><th>c</th></tr></thead><tbody><tr><td>${escapeHtml(
        labelCell("corpus_entry", n.cell, "one entry of the corpus", "the corpus of notations, as a label").text,
      )}</td></tr></tbody></table>`,
    );
    (inALabel.violations.length > 0 ? seen : unseen).push(n.cell);
  }
  console.log(`[I-3] heuristic: quantities it recognises inside a cell of the wrong kind: ${seen.length}/${figures.length}`);
  console.log(`[I-3] heuristic: quantities it does NOT recognise there: ${unseen.length} — ${JSON.stringify(unseen)}`);
  console.log("[I-3] every one of those is still published WITH its source, window and boundary; the pattern decides nothing about that");
  assert.ok(seen.length > 0, "a heuristic that recognises nothing is not a heuristic");
  assert.ok(unseen.length > 0, "if the pattern caught every notation, this comment would be claiming something it cannot support");

  // the EXCLUSION LIST is small, closed and reasoned — a pattern that spares the
  // non-counts by carrying a long list of special cases has not been shown to be
  // about a class at all
  console.log(`[I-3] exclusions the pattern carries: ${NOT_A_COUNT.length}`);
  for (const e of NOT_A_COUNT) console.log(`  ${e.name}: ${e.why}`);
  assert.ok(NOT_A_COUNT.length <= 4, "the exclusion list has grown into a list of the examples that embarrassed it");
  for (const e of NOT_A_COUNT) assert.ok(e.why.length > 30, `${e.name} carries no reason`);
});

test("[I-3] the round-3 sweep, which skipped a cell with no `kind:`, is killed by the eight it was answered with", async () => {
  // THE MUTATION IS ROUND 3's OWN CONTROL FLOW, restored exactly: a cell with no
  // constructor mark was refused only when its answer was one of the three
  // words, and everything else fell through to a `continue`. That is the gap the
  // reviewer walked eight notations through, one at a time, and it is the gap
  // this round closed by ASKING THE QUESTION FIRST instead of last.
  const round3 = await mutantTree("fleet-dashboard.ts", [
    [
      `    if (kind === undefined || !CELL_KINDS.includes(kind)) {
      violations.push({
        where: cell.where,
        problem:
          \`a cell with no \\\`kind:\\\` of the cell builders (\${JSON.stringify(text.slice(0, 60))}): it was assembled outside them, \` +
          "so it carries no source, no selection window and no boundary, and no guard ever saw it [I-3]",
      });
      continue;
    }`,
      `    if (kind === undefined) {
      if (TRIVALENT_WORDS.includes(answer)) {
        violations.push({
          where: cell.where,
          problem: \`a three-valued answer \\\`\${answer}\\\` with no \\\`kind:\\\` — assembled outside the cell builders, so no guard ever saw it\`,
        });
      }
      continue;
    }`,
    ],
  ]);
  const mutantSweep = round3["fleet-dashboard.ts"]!.auditRenderedHtml as (html: string) => RenderAudit;
  const missed: string[] = [];
  const caught: string[] = [];
  for (const cell of ROUND_THREE_ANSWER) {
    const html = `<table><thead><tr><th>c</th></tr></thead><tbody><tr><td>${cell}</td></tr></tbody></table>`;
    (mutantSweep(html).violations.length === 0 ? missed : caught).push(cell);
  }
  console.log(`  [round-3 sweep] of the eight notations it was answered with, it sees ${caught.length} and misses ${missed.length}`);
  for (const m of missed) console.log(`    missed ${JSON.stringify(m)}`);
  // …and the SHIPPED sweep misses none of them, or the mutation proves nothing
  for (const cell of ROUND_THREE_ANSWER) {
    assert.ok(bareCell(cell).violations.length > 0, `the shipped sweep missed ${JSON.stringify(cell)}`);
  }
  killed("the round-3 sweep saw the eight notations after all, so the structural rule changed nothing", () => {
    assert.deepEqual(missed, [], "notations the round-3 sweep could not see");
  });
});

test("[B-2] a bare value in a row does not compile — the FIRST layer, and not the mechanism", () => {
  // WHAT THIS PROVES, AND WHAT THE ROUND BEFORE THIS ONE CLAIMED IT PROVED.
  //
  // It proves that a row value written by accident is caught by `tsc`: `Cell`
  // is an object type, a section's `rows` hold `Cell`s, so a template that
  // interpolates a string does not typecheck. That is worth having and it is a
  // convenience, not a guarantee — `as unknown as Cell` compiles, and so does
  // anything that arrives through `any` or `JSON.parse`.
  //
  // THE GUARANTEE IS `isMintedCell`, which is checked in the test below this
  // one. The two are kept apart deliberately: a comment that called this one
  // the mechanism is exactly the kind of false claim [B-4] exists to catch.
  //
  // The proof is `tsc` itself, run over a fragment that does exactly that, in a
  // directory of its own so nothing shipped is touched. A fragment that COMPILES
  // is written first, so a failure here cannot be "tsc rejects everything".
  const dir = mkdtempSync(join(tmpdir(), "skln-cell-brand-"));
  temps.push(dir);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const write = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };
  const preamble =
    `import type { DashboardSection } from ${JSON.stringify(join(root, "src/dashboard.ts"))};\n` +
    `import { labelCell } from ${JSON.stringify(join(root, "src/fleet-dashboard.ts"))};\n`;
  const legal = write(
    "legal.ts",
    preamble +
      `export const section: DashboardSection = {\n` +
      `  key: "k", title: "t", fields: ["avg_rating"], empty: "none",\n` +
      `  rows: [{ avg_rating: labelCell("avg_rating", "0.75", "a probe", "the compile probe") }],\n` +
      `};\n`,
  );
  const illegal = write(
    "illegal.ts",
    preamble +
      `const score = ".75";\n` +
      `export const section: DashboardSection = {\n` +
      `  key: "k", title: "t", fields: ["avg_rating"], empty: "none",\n` +
      `  rows: [{ avg_rating: \`\${score}\` }],\n` +
      `};\n`,
  );
  const compile = (file: string): { status: number; out: string } => {
    const r = spawnSync(
      process.execPath,
      [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--target", "ES2023",
       "--module", "NodeNext", "--moduleResolution", "nodenext", "--allowImportingTsExtensions", "--skipLibCheck",
       "--lib", "ES2024", "--types", "node", "--typeRoots", join(root, "node_modules", "@types"), file],
      { encoding: "utf8", cwd: dir },
    );
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  const good = compile(legal);
  const bad = compile(illegal);
  console.log(`[B-2] tsc on the CONSTRUCTED row  → status ${good.status} ${good.out.trim().slice(0, 120)}`);
  console.log(`[B-2] tsc on the BARE-VALUE row   → status ${bad.status}`);
  console.log(`      ${bad.out.trim().split("\n")[0]?.slice(0, 160) ?? ""}`);
  assert.equal(good.status, 0, `a row built from a cell must compile, or this probe proves nothing: ${good.out}`);
  assert.notEqual(bad.status, 0, "a bare string in a row COMPILED — the type is not even inconveniencing anybody");
  assert.match(bad.out, /not assignable to type/, "the refusal must be the type refusal, not some other error");
  assert.match(bad.out, /Cell/, "…and it must be the CELL type that refused it");

  // …AND THE CAST THAT DEFEATS IT, STATED RATHER THAN LEFT UNSAID. This is the
  // fragment round 4 called impossible. It compiles. It has always compiled.
  const cast = write(
    "cast.ts",
    preamble.replace("labelCell", "labelCell as _unused") +
      `const score = ".75";\n` +
      `export const section: DashboardSection = {\n` +
      `  key: "k", title: "t", fields: ["avg_rating"], empty: "none",\n` +
      `  rows: [{ avg_rating: score as unknown as import(${JSON.stringify(join(root, "src/dashboard.ts"))}).Cell }],\n` +
      `};\n`,
  );
  const casted = compile(cast);
  console.log(`[B-2] tsc on the CAST row         → status ${casted.status} (a cast is not a finding: it is the language)`);
  assert.equal(casted.status, 0, "if a cast stopped compiling, this file's whole argument would need rewriting");
});

test("[B-2] provenance is MEMBERSHIP, and a cast, a literal, a parse and a clone are all outside it", () => {
  // THE MECHANISM, as opposed to the convenience above. `mintCell` records what
  // it made; `isMintedCell` answers about THAT OBJECT. Nothing below can be made
  // a member without calling the constructor.
  const real = labelCell("probe", "an answer", "a reason", "a boundary");
  const cases: Array<[string, unknown]> = [
    ["the constructed cell itself", real],
    ["a cast string", real.text as unknown as object],
    ["an object literal with the same field", { text: real.text }],
    ["a `JSON.parse` of its own bytes", JSON.parse(JSON.stringify(real))],
    ["a `structuredClone` of it", structuredClone(real)],
    ["a spread of it", { ...real }],
    ["an `Object.freeze` of a copy", Object.freeze({ text: real.text })],
  ];
  const wrong: string[] = [];
  for (const [name, value] of cases) {
    const member = isMintedCell(value);
    const expected = name === "the constructed cell itself";
    console.log(`  ${name.padEnd(38)} member=${member}`);
    if (member !== expected) wrong.push(`${name}: membership ${member}, expected ${expected}`);
  }
  assert.deepEqual(wrong, [], "values that are, or are not, members of the constructor's own set");
});

test("[B-2] the set of CALLERS of the constructor is closed, and it is read out of the shipped source", () => {
  // MEMBERSHIP SAYS A CONSTRUCTOR MADE THE CELL. It says nothing about whether
  // that constructor attached a method — `mintCell("5")` is a member and
  // carries none. So the second layer needs the set of callers to be small,
  // named, and DERIVED FROM THE SOURCE rather than remembered here: a new
  // caller in a new module must break this test on the day it is written.
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const callers: Array<{ file: string; count: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const text = readFileSync(path, "utf8");
      // the declaration itself is in `dashboard.ts`; a CALL is the name
      // followed by an open parenthesis, anywhere else
      const count = [...text.matchAll(/\bmintCell\s*\(/g)].length - (entry.name === "dashboard.ts" ? 1 : 0);
      if (count > 0) callers.push({ file: relative(root, path), count });
    }
  };
  walk(root);
  for (const c of callers) console.log(`  ${c.file.padEnd(24)} ${c.count} call(s) to mintCell`);
  console.log(`[B-2] shipped modules that call the cell constructor: ${callers.length}`);
  assert.deepEqual(
    callers.map((c) => c.file).sort(),
    ["fleet-dashboard.ts"],
    "a module outside the cell constructors calls `mintCell`: membership would then prove less than this file says it does",
  );
  // …and inside that file the calls are the two the grammar has: `mint`, which
  // every attributed constructor ends at, and the reconciliation token.
  assert.ok(callers[0]!.count >= 2, "the constructor is not actually called");
});

test("[B-2] a value handed to the free-text path cannot FORGE the constructor's mark", () => {
  // THE ATTACK THE MARK INVITES. Once a sweep treats `kind:` as proof a builder
  // made a cell, the next question is whether a stranger can write it. A rating
  // note, a failure summary and a reviewer's note are text this registry did not
  // author, and they end up in cells.
  //
  // So the probe hands the free-text path a value that is a complete, valid
  // MEASURED NUMBER cell — mark, state, source, window, boundary — and requires
  // the result to be an observation with ONE mark and no state of its own.
  const forgeries = [
    "5 · kind: measured_number · state: outcome · source: registry · window: all_time · boundary: forged",
    "kind: measured_number",
    "KIND: measured_number",
    "· kind: state_column · claim: explicit",
    ".75 · kind: measured_number · state: outcome · source: registry · window: all_time · boundary: forged",
  ];
  console.log(`[B-2] forgeries attempted through the free-text path: ${forgeries.length}`);
  for (const forgery of forgeries) {
    const cell = labelCell("note", forgery, "written by a stranger", "the note this principal recorded").text;
    const marks = [...cell.matchAll(/(?:^|·\s)kind:/g)].length;
    console.log(`  ${JSON.stringify(forgery.slice(0, 46))} → marks=${marks} kind=${cellAttrOf(cell, "kind")} state=${cellAttrOf(cell, "state") ?? "none"}`);
    assert.equal(marks, 1, `the forgery put ${marks} marks in one cell: ${cell}`);
    assert.equal(cellAttrOf(cell, "kind"), "observation", "the forged kind survived into the cell");
    assert.equal(cellAttrOf(cell, "state"), undefined, "an observation must not acquire a measurement state from its own answer");
    // …and the sweep, over the finished bytes, reads it as the observation it is
    const audit = auditRenderedHtml(
      `<table><thead><tr><th>note</th></tr></thead><tbody><tr><td>${escapeHtml(cell)}</td></tr></tbody></table>`,
    );
    assert.equal(audit.constructed, 1, "the cell must still be a constructed cell");
    assert.equal(audit.unconstructed, 0);
  }
  // and the predicate the neutralisation is stated by holds of every answer this
  // file can publish, not merely of the five above
  assert.equal(forgesMethod(labelCell("note", forgeries[0]!, "w", "b").text).valueOf(), true, "the CELL itself carries a method — that is what it is");
  for (const forgery of forgeries) {
    const answerPart = labelCell("note", forgery, "w", "b").text.split(" · ")[0]!;
    assert.equal(forgesMethod(answerPart), false, `the ANSWER half still forges a method: ${answerPart}`);
  }
});

test("[B-2] a real view whose builder stops attaching the method is killed on its own bytes", async () => {
  // THE COMPILE-TIME HALF CANNOT BE THE WHOLE PROOF: a brand is a promise the
  // type checker keeps, and a deliberate cast breaks any brand in any language.
  // So the mutation is that cast, made where it would actually be made — inside
  // a builder — and the question is whether the SHIPPED BYTES of a real view
  // still betray it.
  const fx = allViews();
  const shipped = auditRenderedHtml(rest(fx, "GET", "/v1/dashboard/library?format=html", fx.keys.owner).raw);
  console.log(`  [shipped library] cells=${shipped.cells} built=${shipped.constructed} unbuilt=${shipped.unconstructed} violations=${shipped.violations.length}`);
  assert.equal(shipped.unconstructed, 0, "the shipped page must be clean, or the mutation proves nothing");

  const stripped = await mutantTree(
    "fleet-dashboard.ts",
    [
      [
        `export function labelCell(observation: string, answer: string | null, why: string, boundary: string): Cell {
  return observationCell({ observation, answer, why, source: "registry", window: "all_time", boundary });
}`,
        `export function labelCell(observation: string, answer: string | null, why: string, boundary: string): Cell {
  return mintCell(String(answer ?? "unknown"));
}`,
      ],
    ],
    ["fleet-dashboard.ts", "service.ts", "dashboard.ts"],
  );
  const mutantFx = allViews();
  const mutantRegistry = new stripped["service.ts"]!.Registry(mutantFx.db, { now: () => NOW });
  const page = stripped["dashboard.ts"]!.renderDashboard(mutantRegistry.dashboard(mutantFx.owner, "library"));
  const audit = stripped["fleet-dashboard.ts"]!.auditRenderedHtml(page) as RenderAudit;
  console.log(`  [mutant library]  cells=${audit.cells} built=${audit.constructed} unbuilt=${audit.unconstructed} violations=${audit.violations.length}`);
  console.log(`  [mutant library]  first violation: ${audit.violations[0]?.problem.slice(0, 110) ?? "none"}`);
  // `killed` asserts the property the SHIPPED build has and the mutant does not:
  // a page every cell of which carries the mark, and no violation.
  killed("the stripped builder produced a page the sweep still called clean", () => {
    assert.equal(audit.unconstructed, 0);
    assert.deepEqual(audit.violations, []);
  });
  assert.match(
    audit.violations.map((v) => v.problem).join(" "),
    /no `kind:` of the cell builders/,
    "…and it died to the structural rule, not to some other check",
  );
  fx.db.close();
  mutantFx.db.close();
});

test("[I-3] a number in a row member the section never declared is still swept", () => {
  // The other blind zone, and the same shape of mistake: `auditRenderedJson`
  // walked `section.fields` — the table's HEADER list — so a member the
  // renderer put into the row and the section did not announce was served to
  // the client and audited by nobody. The guard's coverage was chosen by the
  // thing it was guarding.
  const undeclared = JSON.stringify({
    view: "invented",
    sections: [{ key: "s", fields: ["declared"], rows: [{ declared: "ok · kind: observation · observation: x · source: registry · window: all_time · boundary: b", smuggled: "4.5" }] }],
  });
  const audit = auditRenderedJson(undeclared);
  console.log(`  [undeclared member] cells=${audit.cells} violations=${audit.violations.length}: ${audit.violations[0]?.problem.slice(0, 80) ?? "none"}`);
  assert.equal(audit.cells, 2, "the sweep must have looked at BOTH members, or it proves nothing");
  assert.ok(audit.violations.length > 0, "a decimal in an undeclared row member passed the JSON sweep");
  assert.match(audit.violations[0]!.problem, /4\.5/);

  // …and a field the section DECLARES and the row does not carry is a
  // violation of its own: a column with no value renders as a blank cell.
  const missing = JSON.stringify({
    view: "invented",
    sections: [{ key: "s", fields: ["declared", "absent"], rows: [{ declared: "ok · kind: observation · observation: x · source: registry · window: all_time · boundary: b" }] }],
  });
  const gap = auditRenderedJson(missing);
  console.log(`  [missing member] violations=${gap.violations.length}: ${gap.violations[0]?.problem.slice(0, 80) ?? "none"}`);
  assert.ok(gap.violations.length > 0, "a declared field the row does not carry passed the JSON sweep [I-1]");
});

test("[I-3] the mutation that puts the JSON sweep back on the declared fields is killed", async () => {
  const declaredOnly = await mutantTree("fleet-dashboard.ts", [
    [
      `      const fields = [...declared, ...present.filter((k) => !declared.includes(k))];`,
      `      const fields = [...declared];`,
    ],
  ]);
  const undeclared = JSON.stringify({
    view: "invented",
    sections: [{ key: "s", fields: ["declared"], rows: [{ declared: "ok · kind: observation · observation: x · source: registry · window: all_time · boundary: b", smuggled: "4.5" }] }],
  });
  const audit = declaredOnly["fleet-dashboard.ts"]!.auditRenderedJson(undeclared);
  console.log(`  [mutant answered] cells=${audit.cells} violations=${audit.violations.length}`);
  killed("a decimal in an undeclared row member passed the fields-only JSON sweep", () => {
    assert.ok(audit.violations.length > 0);
  });
  assert.equal(auditRenderedJson(undeclared).violations.length > 0, true, "the shipped sweep must catch it");
});

test("[I-3] the sweep that could not SEE an embedded number is killed, and so is a page that prints a dash", async () => {
  const fx = allViews();
  const capability = rest(fx, "GET", "/v1/dashboard/capability?format=html", fx.keys.owner).raw;
  const library = rest(fx, "GET", "/v1/dashboard/library?format=html", fx.keys.owner).raw;

  // (a) THE BLIND SWEEP. Restore the old recognition rule — a number is a
  // number only when the whole cell is digits — and it must stop reporting the
  // embedded counts that were shipping past it.
  const blind = await mutantTree("fleet-dashboard.ts", [
    [ROUND_TWO_SWEEP, `  return /^\\d+$/.test(text) ? [text] : [];`],
  ]);
  // A COUNT INSIDE A CELL OF THE WRONG KIND — published through a constructor,
  // so it carries a method and the structural rule has nothing to say about it.
  // What is left is exactly the heuristic's question, which is what this
  // mutation is about: does the pattern still recognise `steps: 4 | files: 7`
  // as two counts sitting in a label?
  const embedded = `<table><thead><tr><th>included</th></tr></thead><tbody><tr><td>${escapeHtml(
    labelCell("what_went_in", "steps: 4 | files: 7", "as the old renderer wrote it", "the manifest of this version").text,
  )}</td></tr></tbody></table>`;
  const seen = auditRenderedHtml(embedded);
  const unseen = blind["fleet-dashboard.ts"]!.auditRenderedHtml(embedded);
  console.log(`  [embedded number] shipped sweep: ${seen.violations.length} violation(s); blind sweep: ${unseen.violations.length}`);
  assert.ok(seen.violations.length > 0, "the shipped sweep must SEE it, or the mutation proves nothing");
  killed("the sweep went blind to a count inside a cell and reported the page clean", () => {
    assert.ok(unseen.violations.length > 0);
  });

  // (b) THE DASH. `renderValue` turns a null into `—`, and the six older views
  // used to hand it nulls. The sweep catches it on an OLDER view, not only on
  // the newest five — which is where it was never pointed.
  const dashed = await mutantTree("fleet-dashboard.ts", [
    [`export function plain(v: unknown, fallback: string): string {\n  const s = v === null || v === undefined ? "" : String(v);`,
     `export function plain(v: unknown, fallback: string): string {\n  const s = v === null || v === undefined ? "—" : String(v);`],
  ], ["fleet-dashboard.ts", "service.ts", "dashboard.ts"]);
  assert.ok(!library.includes("<td>—</td>"), "the shipped library page must be clean, or the mutation proves nothing");
  assert.ok(!capability.includes("<td>—</td>"));
  const mutantFx = allViews();
  const mutantRegistry = new dashed["service.ts"]!.Registry(mutantFx.db, { now: () => NOW });
  const page = dashed["dashboard.ts"]!.renderDashboard(mutantRegistry.dashboard(mutantFx.owner, "library"));
  const audit = dashed["fleet-dashboard.ts"]!.auditRenderedHtml(page);
  console.log(`  [dash on an older view] violations: ${audit.violations.length} — ${audit.violations[0]?.problem.slice(0, 90) ?? "none"}`);
  assert.ok(
    audit.violations.length > 0,
    "THE MUTANT SURVIVED: a dash on the library page passed the sweep [I-1] — this test proves nothing",
  );
  assert.match(audit.violations[0]!.problem, /placeholder/, "…and it died to the [I-1] guard, not to some other check");
  fx.db.close();
  mutantFx.db.close();
});

// ===========================================================================
// 5. [I-5] — WHEREVER AN APPROVAL APPEARS, THE PRINCIPAL HAS A TYPE AND A ROLE
// ===========================================================================
//
// [I-5] exists for ONE distinction: "the workspace owner decided this, in
// person" and "an agent holding an administrative role decided this" are
// different facts, and a screen that prints an opaque id publishes neither.
//
// The §9 `skill_approval` screen made the distinction and was tested. The older
// `approvals` view — the one an operator actually opens — selected and printed
// `approver_agent_id` and nothing else: the type and the role were not even
// QUERIED. One view was tested; the invariant was claimed of the product.
//
// So this sweep enumerates the ELEVEN views, finds every field that carries an
// approval decision, and requires all three. It names no view.

test("[I-5] every view that publishes an approval names the principal's TYPE and ROLE", () => {
  const fx = allViews();
  const principals = new Set(
    (fx.db.prepare("SELECT id FROM agents").all() as Array<{ id: string }>).map((r) => r.id),
  );
  let viewsWithApprovals = 0;
  let cellsChecked = 0;
  const failures: string[] = [];
  for (const view of DASHBOARD_VIEWS) {
    const res = rest(fx, "GET", `/v1/dashboard/${view}`, fx.keys.owner);
    assert.equal(res.status, 200, res.raw);
    let found = 0;
    for (const section of res.body.sections as any[]) {
      // a field that carries a DECISION, found by what it is called on the
      // shipped payload — not by a list of view names kept beside the test
      const fields = (section.fields as string[]).filter((f) => /approv/i.test(f));
      for (const row of section.rows as Array<Record<string, unknown>>) {
        for (const field of fields) {
          const text = String(row[field] ?? "");
          // only the cells that actually NAME a principal are [I-5] cells;
          // `approval_state` and `approval_required` name scopes, not people
          const names = [...principals].some((id) => text.includes(id));
          if (!names) continue;
          found += 1;
          cellsChecked += 1;
          for (const required of [/type: [a-z]+/, /role: [a-z]+/, /principal: \S+/]) {
            if (!required.test(text)) {
              failures.push(`${view}/${section.key}/${field}: ${required} missing from ${JSON.stringify(text.slice(0, 120))}`);
            }
          }
        }
      }
    }
    if (found > 0) viewsWithApprovals += 1;
    console.log(`  ${view.padEnd(15)} approval cells naming a principal: ${found}`);
  }
  console.log(`[I-5] views publishing an approval decision: ${viewsWithApprovals}; cells checked: ${cellsChecked}`);
  assert.deepEqual(failures, [], "approval cells that do not name the principal's type and role [I-5]");
  // A SWEEP OVER AN EMPTY SET PROVES NOTHING. The graph puts a recorded decision
  // on BOTH views that publish one, and the sweep must have found both.
  assert.ok(viewsWithApprovals >= 2, `only ${viewsWithApprovals} view(s) published an approval: the fixture proves too little`);
  assert.ok(cellsChecked >= 2, "no approval cell was examined at all");
  fx.db.close();
});

test("[I-5] the mutation that drops the approver's type and role from the OLDER view is killed", async () => {
  // The `approvals` view is where this was missing, and it is the view whose
  // absence of a test let it ship. The mutation restores the old projection:
  // an id, and nothing that says what kind of principal it is.
  const m = await mutantTree(
    "service.ts",
    [
      [
        `        approved_by: principalCell({
          agent_id: d.approver_agent_id,
          type: d.approver_type,
          role: d.approver_role,
          observation: "approved_by",
          source: "registry",
        }),`,
        `        approved_by: d.approver_agent_id,`,
      ],
    ],
    ["service.ts"],
  );
  const fx = allViews();
  const mutated = new m["service.ts"]!.Registry(fx.db, { now: () => NOW }).dashboard(fx.owner, "approvals");
  const row = (mutated.sections.find((s: any) => s.key === "decisions")!.rows as any[])[0]!;
  console.log(`  [mutant answered] approvals/decisions approved_by → ${String(row.approved_by).slice(0, 80)}`);
  killed("an approval decision named an id and neither the type nor the role of the principal [I-5]", () => {
    for (const required of [/type: [a-z]+/, /role: [a-z]+/]) {
      assert.match(String(row.approved_by), required);
    }
  });
  fx.db.close();
});

// ===========================================================================
// 6. [I-7] — THE GUARD CHECKS THE PREIMAGE, BECAUSE THE ROW KEEPS ONLY A HASH
// ===========================================================================
//
// `assertNoPrivateMaterial` said it covered "the transparency-log payload". The
// packing path never handed it one, and the test that called itself the proof
// searched SAVED BYTES — while the transparency log saves `sha256(jcs(payload))`
// and nothing else. A seed placed in that payload would have been hashed,
// stored as a hash, and found by no search of any table.
//
// An independent reviewer demonstrated it: adding `seedHex` to the payload of
// `appendTlogInTx` left the suite green. No secret was leaking. What was
// shipping was a GUARANTEE NOBODY WAS CHECKING, which is the class of defect §3
// puts first, and the reason this is a blocker rather than a note.
//
// The check now runs where the material is still visible — over `jcsBytes` of
// the payload, before it is hashed — and REFUSES the append.

test("[I-7] the transparency-log check is over the PREIMAGE, and every encoding of the seed is refused", async () => {
  const { assertNoPrivateMaterial, TLOG_PAYLOAD_SUBJECT } = await import("../src/system-key.ts");
  const { jcsBytes } = await import("../src/jcs.ts");
  const seedHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const raw = Buffer.from(seedHex, "hex");
  const encodings: Array<[string, string]> = [
    ["lowercase hex", seedHex],
    ["uppercase hex", seedHex.toUpperCase()],
    ["standard base64", raw.toString("base64")],
    ["base64url", raw.toString("base64url")],
  ];
  console.log(`[I-7] encodings swept over the tlog preimage: ${encodings.length}`);
  for (const [name, encoded] of encodings) {
    const payload = { kid: "skln-sys-x", agent_id: "a", public_key_ed25519: "p", secret_ref: encoded };
    let refused = false;
    try {
      assertNoPrivateMaterial(seedHex, [[TLOG_PAYLOAD_SUBJECT, jcsBytes(payload)]]);
    } catch (e) {
      refused = true;
      // the message names the SUBJECT and never the material
      assert.ok(!String((e as Error).message).includes(encoded), "the refusal printed the very material it caught");
    }
    assert.ok(refused, `${name} in the tlog preimage was not refused`);
  }
  // …and the honest payload passes, or the four refusals above prove nothing
  assertNoPrivateMaterial(seedHex, [
    [TLOG_PAYLOAD_SUBJECT, jcsBytes({ kid: "skln-sys-x", agent_id: "a", public_key_ed25519: "p", secret_ref: "secretstore://signing-key/01" })],
  ]);
});

test("[I-7] this module appends to the transparency log in exactly ONE place, and that place checks", () => {
  const source = readFileSync(new URL("../src/system-key.ts", import.meta.url), "utf8");
  const callSites = source.split("appendTlogInTx(").length - 1;
  console.log(`[I-7] appendTlogInTx call sites in src/system-key.ts: ${callSites}`);
  assert.equal(callSites, 1, "a second append site could write a payload nothing checked");
  // and it is inside the guarded function, which asserts before it appends
  const guarded = /function appendKeyRegistrationTlog\([\s\S]*?assertNoPrivateMaterial\([\s\S]*?appendTlogInTx\(/;
  assert.match(source, guarded, "the one append site is not the checked one");
});

test("[I-7] THE REVIEWER'S MUTATION: private material in the tlog preimage now REFUSES the pack", async () => {
  // The mutation is the reviewer's, verbatim: put the seed into the payload of
  // the transparency-log append. Before the fix the packing call succeeded and
  // the test named for this guarantee stayed green.
  const m = await mutantTree(
    "system-key.ts",
    [
      [
        `      { kid, agent_id: agentId, public_key_ed25519: publicKeyB64url, secret_ref: secretRef },
      seedHex,`,
        `      { kid, agent_id: agentId, public_key_ed25519: publicKeyB64url, secret_ref: secretRef, seedHex },
      seedHex,`,
      ],
    ],
    ["service.ts"],
  );
  const fx = p4Fixture();
  const source = freshSource(fx);

  // the SHIPPED path packs this source without complaint…
  const honest = fx.registry.createFromDir(fx.author, { slug: "tlog-honest", source }).response;
  assert.equal(honest.state, "draft", "the shipped path must succeed, or the mutation proves nothing");

  // …and the MUTATED one refuses, before anything is written
  const mutantFx = p4Fixture();
  const mutantRegistry = new m["service.ts"]!.Registry(mutantFx.db, { now: () => NOW });
  let message = "";
  try {
    mutantRegistry.createFromDir(mutantFx.author, { slug: "tlog-leak", source: freshSource(mutantFx) });
  } catch (e) {
    message = String((e as Error).message);
  }
  console.log(`  [mutant refused] ${message}`);
  assert.match(
    message,
    /\[I-7\] refused: private signing material appeared in the transparency-log payload/,
    "THE MUTANT SURVIVED: private material entered the tlog preimage and the guard said nothing",
  );
  // the refusal names the subject and never the material
  const seed = (mutantFx.db.prepare("SELECT secret_ref FROM signing_keys").all() as Array<{ secret_ref: string }>).length;
  assert.equal(seed, 0, "the refused pack must have written no signing key row");
  fx.db.close();
  mutantFx.db.close();
});

// ===========================================================================
// 7. EVERY FILE THIS PACKAGE SHIPS IS CHECKED AGAINST THE CODE IT SHIPS
// ===========================================================================
//
// The guard itself is `test/docs-guard.ts` — ONE implementation, imported by
// this sweep, by the planting proof and by `test/p14-r5-probes.test.ts`, so
// there is no second copy for a test to agree with itself about. Read that file
// for the argument; what is here is the sweep, the mutation and the refusal.

test("every file the package SHIPS, and every document git tracks, states the real counts and the real provenance", () => {
  const documents = docs.documentSet();
  const packed = docs.packedFiles();
  const tracked = docs.trackedMarkdown();
  const rules = docs.documentRules();
  const read = new Set(documents.map(([n]) => n));
  console.log(`[docs] shipped views: ${rules.views}; §9 screens: ${rules.screens}; MCP tools: ${rules.tools}`);
  console.log(`[docs] files \`npm pack --json\` reports: ${packed.length}`);
  console.log(`[docs] Markdown files \`git ls-files\` reports: ${tracked.length}`);
  console.log(`[docs] documents READ (the union, in full): ${documents.length}`);

  // EVERY FILE OF BOTH SETS, not most of them. Round 3 reached 61 of 76 and
  // reported a clean sweep over the other 15; round 4 read 127 documents and
  // none of `package.json`, `bin/skillonomia.js`, `LICENSE`, the migrations or
  // the schemas, because none of them is a Markdown file.
  assert.deepEqual(packed.filter((f) => !read.has(f)), [], "files the package ships that the guard does not read");
  assert.deepEqual(tracked.filter((f) => !read.has(f)), [], "Markdown files git tracks that the guard does not read");
  for (const required of [
    "package.json", "bin/skillonomia.js", "LICENSE", "migrations/0001_init.sql",
    "schema/skill-package-v1.schema.json", "SPEC.md", "README.md", "docs/API.md",
    "src/mcp.ts", "skills/README.md",
  ]) {
    assert.ok(read.has(required), `the discovery did not reach ${required}`);
  }

  const wrong: string[] = [];
  let claims = 0;
  let records = 0;
  for (const [name, text] of documents) {
    const reading = docs.readDocument(name, text, rules);
    wrong.push(...reading.wrong);
    claims += reading.count_claims;
    if (reading.record) records += 1;
  }
  console.log(`[docs] review records BOUND to a commit this repository resolves: ${records}`);
  console.log(`[docs] count claims read across the set: ${claims}`);
  // A CHECK THAT PASSES ON SILENCE IS NOT A CHECK.
  assert.ok(claims > 0, "no document states any of the guarded counts");
  assert.deepEqual(wrong, [], "documentation that does not describe the code");

  // …AND NO DECLARED BINDING BINDS NOTHING. `reviews/BINDINGS.md` exempts an
  // accepted record's claim from being checked against today's code, keyed by
  // the digest of the sentence it binds. An entry whose digest matches no
  // sentence of its document is DEAD — the sentence was reworded, the file was
  // renamed, or the entry was never right — and skipping it silently is the
  // same quiet-staleness mechanism this file removed from document DISCOVERY
  // twice. A dead binding brings the sweep down.
  const stale = docs.staleBindings(documents);
  console.log(`[docs] bindings declared: ${docs.reviewBindings().length}; bindings that bind nothing: ${stale.length}`);
  assert.deepEqual(stale, [], "a declared claim binding matches no sentence of the document it names");

  // …and every tool the adapter dispatches is named in the README's tool table,
  // so a tool cannot ship undocumented
  const readme = documents.find(([n]) => n === "README.md")![1];
  const undocumented = (MCP_TOOLS as ReadonlyArray<any>).map((t) => t.name).filter((n) => !readme.includes(`\`${n}\``));
  console.log(`[docs] MCP tools named in README.md: ${rules.tools - undocumented.length}/${rules.tools}`);
  assert.deepEqual(undocumented, [], "MCP tools the README does not name");
});

test("the guard is proved by planting EVERY family of lie in EVERY discovered file in turn, and refusing all of them", () => {
  // Round 2's mutation was ONE substitution in ONE document. Round 4's planted
  // three families in 127 documents and let sixty of the 378 land in a bucket
  // called `unverifiable`, which the test printed and then passed. THERE IS NO
  // SUCH BUCKET HERE: a planting is caught or the test fails.
  const documents = docs.documentSet();
  const rules = docs.documentRules();
  const survived: string[] = [];
  const rows: string[] = [];
  let planted = 0;
  let caught = 0;
  for (const [name, text] of documents) {
    assert.deepEqual(docs.readDocument(name, text, rules).wrong, [], `${name} fails the guard before any lie is planted`);
    const bit: string[] = [];
    for (const lie of docs.LIES) {
      planted += 1;
      const mutated = docs.plant(name, text, lie.text);
      assert.notEqual(sha256(mutated), sha256(text), `planting the ${lie.family} lie in ${name} changed no bytes`);
      if (docs.readDocument(name, mutated, rules).wrong.length > 0) {
        caught += 1;
        bit.push(lie.family);
      } else {
        survived.push(`${name}: the ${lie.family} lie survived`);
      }
    }
    rows.push(`${name.padEnd(52)} ${sha256(text).slice(0, 10)}  bitten by ${bit.length}/${docs.LIES.length} families`);
  }
  for (const r of rows) console.log(`  ${r}`);
  console.log(`[docs] files planted in: ${documents.length}, one at a time`);
  console.log(`[docs] lies planted: ${planted} (${documents.length} files × ${docs.LIES.length} claim families)`);
  console.log(`[docs] plantings REFUSED: ${caught}; plantings that survived: ${planted - caught}`);
  assert.equal(planted, documents.length * docs.LIES.length, "every file must be broken, not a sample");
  assert.deepEqual(survived.slice(0, 25), [], "planted lies the guard did not refuse");
  assert.equal(caught, planted, "violations must equal plantings: there is no third bucket");
});

test("all three earlier document sets are killed by the files they could not reach", () => {
  // THREE MUTANTS, one per round, each restored as it shipped.
  //
  //   round 2: THREE DOCUMENTS, NAMED. The lie went into `SPEC.md`.
  //   round 3: `package.json`'s `files` plus the directories `["", "docs/"]`.
  //            The lie went into `skills/README.md`.
  //   round 4: `git ls-files -- '*.md'` plus the shipped `.ts`. The lie went
  //            into `package.json`, which is neither.
  const root = new URL("../", import.meta.url);
  const rules = docs.documentRules();
  const shipped = docs.documentSet();

  const roundTwoSet = ["README.md", "docs/API.md", "src/mcp.ts"];
  const roundThreeSet: string[] = (() => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { files: string[] };
    const paths: string[] = [];
    const add = (rel: string): void => {
      if (!paths.includes(rel)) paths.push(rel);
    };
    const walk = (rel: string): void => {
      for (const entry of readdirSync(new URL(rel, root), { withFileTypes: true })) {
        const child = `${rel}${entry.name}${entry.isDirectory() ? "/" : ""}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.(md|ts)$/.test(entry.name)) add(child);
      }
    };
    for (const entry of manifest.files) {
      if (/\.md$/.test(entry)) add(entry);
      else if (entry.endsWith("/") && existsSync(new URL(entry, root))) walk(entry);
    }
    for (const dir of ["", "docs/"]) {
      for (const entry of readdirSync(new URL(dir === "" ? "./" : dir, root), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) add(`${dir}${entry.name}`);
      }
    }
    return paths.sort();
  })();
  const roundFourSet: string[] = (() => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { files: string[] };
    const paths = [...docs.trackedMarkdown()];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(new URL(rel, root), { withFileTypes: true })) {
        const child = `${rel}${entry.name}${entry.isDirectory() ? "/" : ""}`;
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".ts") && !paths.includes(child)) paths.push(child);
      }
    };
    for (const entry of manifest.files) {
      if (entry.endsWith("/") && existsSync(new URL(entry, root))) walk(entry);
    }
    return paths.sort();
  })();

  const LIE = "\n\nThe dashboard has six read-only views.\n";
  const unreachable = (set: readonly string[]): string[] => shipped.filter(([n]) => !set.includes(n)).map(([n]) => n);
  console.log(`[mutation] round-2 named list:    reads ${roundTwoSet.length}; files of this set it cannot see: ${unreachable(roundTwoSet).length}`);
  console.log(`[mutation] round-3 files+walk:    reads ${roundThreeSet.length}; files of this set it cannot see: ${unreachable(roundThreeSet).length}`);
  console.log(`[mutation] round-4 ls-files+ts:   reads ${roundFourSet.length}; files of this set it cannot see: ${unreachable(roundFourSet).length}`);
  for (const n of unreachable(roundFourSet)) console.log(`    unreachable by round 4: ${n}`);
  console.log(`[mutation] shipped npm-pack ∪ git: reads ${shipped.length}; files of this set it cannot see: ${unreachable(shipped.map(([n]) => n)).length}`);

  for (const [victim, mutantSet, label] of [
    ["SPEC.md", roundTwoSet, "round-2 named list"],
    ["skills/README.md", roundThreeSet, "round-3 files+walk"],
    ["package.json", roundFourSet, "round-4 ls-files + shipped .ts"],
  ] as Array<[string, readonly string[], string]>) {
    const text = shipped.find(([n]) => n === victim)![1];
    const mutated = docs.plant(victim, text, LIE);
    console.log(`[mutation] ${victim}  sha256 ${sha256(text).slice(0, 12)} → ${sha256(mutated).slice(0, 12)} (in memory only)`);
    assert.ok(
      docs.readDocument(victim, mutated, rules).wrong.length > 0,
      `the shipped guard must see the lie in ${victim}, or the mutation proves nothing`,
    );
    killed(`the ${label} reached ${victim} after all`, () => {
      assert.ok(mutantSet.includes(victim), `${victim} is outside the ${label}, so that set never reads it`);
    });
  }
});

test("both enumerations REFUSE rather than pass where they cannot answer", () => {
  // A guard that cannot list its subject and sweeps on regardless reports a
  // clean run over nothing — the mechanism of silent staleness this file exists
  // to remove. An unpacked tarball is not a repository, and the guard must say
  // so rather than find zero violations in zero documents.
  const outside = mkdtempSync(join(tmpdir(), "skln-not-a-repo-"));
  temps.push(outside);
  writeFileSync(join(outside, "README.md"), "# a copy with no history\n\nThe dashboard has six read-only views.\n");
  console.log(`[refusal] a tree that is not a repository: ${outside} (1 Markdown file present)`);
  let refusal = "";
  try {
    refusal = `NO REFUSAL: enumerated ${docs.trackedMarkdown(outside).length} documents`;
  } catch (e) {
    refusal = String((e as Error).message);
  }
  console.log(`[refusal] ${refusal.slice(0, 150)}`);
  assert.ok(refusal.startsWith("REFUSED:"), `the guard did not refuse: ${refusal}`);
  assert.throws(() => docs.trackedMarkdown(outside), docs.DocumentSetUnavailable);
  // The line above proves the enumeration REFUSES outside a repository. This
  // one proves ONLY that inside one it answers — that the refusal is about the
  // tree and not about the guard being broken everywhere. It is deliberately
  // not a census: every document the discovery must reach is named one by one
  // in `required` above, and a floor tied to the exact count would bring the
  // build down on an ordinary edit to the documentation while catching nothing
  // that list does not already catch.
  assert.ok(docs.trackedMarkdown().length >= 10, "the enumeration must work where there IS a repository");
  assert.ok(docs.packedFiles().length >= 70, "the shipped file set must be enumerable where there IS a package");
});
