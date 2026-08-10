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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

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
import { DASHBOARD_VIEWS } from "../src/dashboard.ts";
import { auditRenderedHtml, auditRenderedJson, parseTables } from "../src/fleet-dashboard.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { MIGRATION_SOURCE } from "../src/skill-migrations.ts";
import { FixedActivationRoots } from "../src/activation.ts";
import { writeTar } from "../src/archive.ts";
import { TRANSFER_ACTION } from "../src/transfer.ts";
import { arrivalMarker } from "../src/marker.ts";

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
    window_detail: "the records this test filed, and nothing else",
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
      records: [{ role: "output", call_id: "A", at_ms: NOW, text: `done ${marker}`, result: "success" }],
      expect: "unknown",
    },
    {
      name: "(c) a call and an output under DIFFERENT call_ids",
      records: [
        { role: "call", call_id: "A", at_ms: NOW, text: `starting ${marker}` },
        { role: "output", call_id: "B", at_ms: NOW + 10, text: `done ${marker}`, result: "success" },
      ],
      expect: "unknown",
    },
    {
      name: "(d) a call and an output under ONE call_id",
      records: [
        { role: "call", call_id: "A", at_ms: NOW, text: `starting ${marker}` },
        { role: "output", call_id: "A", at_ms: NOW + 10, text: `done ${marker}`, result: "success" },
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
// The two kinds of chain are not the same and are not treated the same:
// a chain a TRANSFER opened states its recipient on the `transferred` row and
// is answered from there or not at all; a chain the recipient opened ITSELF
// never had such an event, and its recipient is the INSERT-only receipt shell —
// which the source phrase now says out loud.

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
  // …and a chain NO transfer opened, which is the case the shell legitimately
  // answers. Without it the sweep would prove only that nothing is ever counted.
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
  assert.deepEqual(h.row.recipient_sources, ["adoption_receipts"]);
  // [I-3]: the number names the journal it was obtained from, in words
  assert.match(h.row.source, /adoption_receipts/, "a figure keyed on the receipt shell published only `receipt_events`");
  assert.match(h.row.source, /receipt_events/, "the qualifying event's journal is still named");
  assert.match(h.envelope_source, /adoption_receipts/, "the envelope's source must name the truth too");
  // and a row that read nothing does not invent an attribution
  assert.equal(d.row.source, MIGRATION_SOURCE);
  fx.db.close();
});

test("[I-6] the mutation that restores the fallback is killed", async () => {
  const m = await mutantTree("skill-migrations.ts", [
    [
      `  if (row.transfer_event_id !== null) {
    if (row.transferred_to === null) return null;
    try {
      const id = JSON.parse(row.transferred_to)?.id;
      if (typeof id === "string" && id.length > 0) return { id, from: RECIPIENT_SOURCE_EVENT };
    } catch {`,
      `  if (row.transfer_event_id !== null) {
    if (row.transferred_to === null) return { id: row.recipient, from: RECIPIENT_SOURCE_SHELL };
    try {
      const id = JSON.parse(row.transferred_to)?.id;
      if (typeof id === "string" && id.length > 0) return { id, from: RECIPIENT_SOURCE_EVENT };
    } catch {
      return { id: row.recipient, from: RECIPIENT_SOURCE_SHELL };`,
    ],
  ]);
  const fx = p4Fixture();
  const damaged = reviewedVersion(fx, "mig-damaged");
  chainWithDamagedRecipient(fx, damaged, fx.keys.member, "{not json at all", "A");
  const mutated = m["skill-migrations.ts"]!.migrationCounts(fx.db, [{ skill_id: damaged.skillId, slug: "mig-damaged" }]);
  console.log(`  [mutant answered] migrations=${mutated[0].migrations}, recipients=${mutated[0].distinct_recipients}`);
  killed("the receipt shell stood in for a `transferred` event nobody could read [I-6]", () => {
    assert.equal(mutated[0].migrations, 0);
    assert.equal(mutated[0].distinct_recipients, 0);
  });
  // …and the shipped counter, on the same rows, answers zero
  const { migrationCounts } = await import("../src/skill-migrations.ts");
  const honest = migrationCounts(fx.db, [{ skill_id: damaged.skillId, slug: "mig-damaged" }]);
  assert.equal(honest[0]!.migrations, 0, "the shipped counter must drop it, or the mutation proves nothing");
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
  const manifest: any = makeManifest({ access_policy: "workspace", semantic_version: `2.0.${++freshN}` });
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

/** One live registry with everything the 36 calls need, and the arguments for
 *  each — built by NAME LOOKUP into a table that is checked for completeness
 *  against `MCP_TOOLS`, so a tool added tomorrow fails this suite rather than
 *  quietly escaping it. */
function toolDrive(): { fx: P4Fixture; args: Map<string, { key: string; args: any }> } {
  const base = tempBase("skln-r2-tools-");
  const activationRoot = join(base, "activation");
  mkdirSync(activationRoot, { recursive: true });
  const fx = p4Fixture({ activation: new FixedActivationRoots(activationRoot, "claude_code_project") });

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
  const deployments: string[] = [];
  for (const slug of ["mcp-act", "mcp-pause", "mcp-revoke-assignment"]) {
    const v = publishedVersion(fx, slug);
    const pushed = rest(fx, "POST", `/v1/versions/${v.versionId}/transfers`, fx.keys.owner, {
      recipient: { kind: "local_agent", ref: fx.reviewer.agent_id },
    });
    assert.equal(pushed.status, 201, pushed.raw);
    deployments.push(pushed.body.assignment_id);
  }

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
  const args = new Map<string, { key: string; args: any }>([
    ["skill.create", { key: A, args: { slug: "mcp-created", archive_base64: freshArchive(fx).toString("base64") } }],
    ["skill.create_from_dir", { key: A, args: { slug: "mcp-from-dir", source_base64: freshSource(fx).toString("base64") } }],
    ["skill.lint", { key: A, args: { skill_version_id: toLint.versionId } }],
    ["skill.verify", { key: O, args: { skill_version_id: toVerify.versionId } }],
    ["skill.search", { key: O, args: {} }],
    ["skill.review.request", { key: A, args: { skill_version_id: toReview.versionId, action: "request" } }],
    ["skill.publish", { key: O, args: { skill_version_id: toPublish.versionId } }],
    [
      "skill.supersede",
      { key: O, args: { skill_version_id: toSupersede.versionId, successor_version_id: successor.versionId } },
    ],
    ["skill.deprecate", { key: O, args: { skill_version_id: toDeprecate.versionId } }],
    ["skill.revoke", { key: O, args: { skill_version_id: toRevoke.versionId, reason: "a sweep of the tool table" } }],
    [
      "skill.approve",
      { key: O, args: { skill_version_id: toApprove.versionId, scope: "publish", decision: "approved" } },
    ],
    ["skill.request_adoption", { key: fx.keys.member!, args: { skill_version_id: toTransfer.versionId } }],
    ["skill.adopt", { key: fx.keys.reviewer2!, args: { adoption_request_id: inFlight.body.adoption_request_id, environment_descriptor: env() } }],
    [
      "skill.validate_outcome",
      { key: fx.keys.member!, args: { receipt_id: pending.receiptId, event: "adopted", evidence: goodEvidence(toAdopt.manifest) } },
    ],
    ["skill.rate", { key: fx.keys.admin!, args: { skill_version_id: toAdopt.versionId, adoption_receipt_id: closed.receiptId, score: 5 } }],
    [
      "skill.transfer",
      { key: O, args: { skill_version_id: toTransfer.versionId, recipient: { kind: "local_agent", ref: fx.reviewer2.agent_id } } },
    ],
    [
      "transfer_grant.create",
      { key: O, args: { agent_id: fx.member.agent_id, action: "receive", recipient_scope: "local_agent" } },
    ],
    ["transfer_grant.list", { key: O, args: {} }],
    ["assignment.activate", { key: O, args: { assignment_id: deployments[0] } }],
    ["assignment.pause", { key: O, args: { assignment_id: deployments[1] } }],
    ["assignment.revoke", { key: O, args: { assignment_id: deployments[2] } }],
    ["assignment.list", { key: O, args: {} }],
    ["fleet.list", { key: O, args: {} }],
    ["agent.capabilities", { key: O, args: { agent_id: fx.reviewer.agent_id } }],
    ["capability.get", { key: O, args: { agent_id: fx.reviewer.agent_id, name: "mcp-act" } }],
    [
      "observation.report",
      {
        key: O,
        args: {
          agent_id: fx.reviewer.agent_id,
          runtime: "codex",
          window: "period",
          window_detail: "the tool sweep's own records",
          records: [{ role: "call", call_id: "s-1", at_ms: NOW, text: "nothing in particular" }],
        },
      },
    ],
    ["principal.create", { key: O, args: { name: "mcp-sweep-new", type: "agent", role: "member" } }],
    ["principal.list", { key: O, args: {} }],
    ["principal.issue_api_key", { key: O, args: { principal_id: victimId } }],
    ["principal.revoke_api_key", { key: O, args: { principal_id: victimId, api_key_id: keyId } }],
    ["signing_key.register", { key: O, args: { kid: "mcp-sweep-fresh", public_key_ed25519: SPARE_PUBLIC_KEY_2 } }],
    ["signing_key.list", { key: O, args: {} }],
    ["signing_key.revoke", { key: O, args: { kid: "mcp-sweep-doomed" } }],
    ["tlog.read", { key: O, args: {} }],
    ["migration.count", { key: O, args: {} }],
    ["dashboard.view", { key: O, args: { view: "library" } }],
  ]);
  return { fx, args };
}

test("[I-8] every tool's `readOnlyHint` is checked against whether the database MOVED", () => {
  const { fx, args } = toolDrive();
  // COMPLETENESS FIRST: the sweep covers the shipped table, not a list beside it
  const names = (MCP_TOOLS as ReadonlyArray<any>).map((t) => t.name);
  assert.deepEqual(
    names.filter((n) => !args.has(n)),
    [],
    "a tool the sweep cannot drive is a tool the sweep does not check [I-8]",
  );
  assert.deepEqual([...args.keys()].filter((n) => !names.includes(n)), [], "the sweep drives a tool that does not exist");

  const report: Array<{ name: string; readOnly: boolean; ok: boolean; wrote: boolean }> = [];
  for (const tool of MCP_TOOLS as ReadonlyArray<any>) {
    const drive = args.get(tool.name)!;
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

test("[I-8] the mutation that removes ONE tool's annotations, and the one that lies in it, are both killed", async () => {
  // (a) STRIPPED. `dashboard.view` had no annotations at all until this round,
  // and the suite that shipped never noticed — because it asked about the tools
  // it had just added. The sweep is over `MCP_TOOLS`, so removing any one block
  // is caught wherever it is removed from.
  const stripped = await mutantTree("mcp.ts", [
    [
      `    // [I-8]: a READ. Every view is a rendering of surfaces the caller may
    // already read, under the SAME access rules, and none of them writes: a
    // dashboard that widened visibility or recorded a visit would be a second
    // source of truth rather than a view.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
`,
      ``,
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
      `    // [I-8]: a WRITE. It creates a skill and a draft version and appends to
    // the transparency log. \`idempotentHint\` is true in the sense the API means
    // it: an \`idempotency_key\` replays the original response byte for byte, and
    // the same (workspace, slug) converges on one skill.
    annotations: {
      readOnlyHint: false,`,
      `    annotations: {
      readOnlyHint: true,`,
    ],
  ]);
  const { fx, args } = toolDrive();
  const drive = args.get("skill.create")!;
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
  const problems: string[] = [];
  for (const view of DASHBOARD_VIEWS) {
    const html = rest(fx, "GET", `/v1/dashboard/${view}?format=html`, fx.keys.owner);
    assert.equal(html.status, 200, html.raw);
    const json = rest(fx, "GET", `/v1/dashboard/${view}`, fx.keys.owner);
    assert.equal(json.status, 200, json.raw);
    const h = auditRenderedHtml(html.raw);
    const j = auditRenderedJson(json.raw);
    console.log(
      `  ${view.padEnd(15)} html: rows=${String(h.rows).padStart(3)} cells=${String(h.cells).padStart(4)} ` +
        `numbers=${String(h.number_cells).padStart(3)} states=${String(h.state_cells).padStart(3)} ` +
        `violations=${h.violations.length} · json: cells=${String(j.cells).padStart(4)} violations=${j.violations.length}`,
    );
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
  assert.ok(totalNumbers > 0, "not one number was checked: the sweep would pass on a page with no figures at all");
  fx.db.close();
});

test("[I-3] the sweep that could not SEE an embedded number is killed, and so is a page that prints a dash", async () => {
  const fx = allViews();
  const capability = rest(fx, "GET", "/v1/dashboard/capability?format=html", fx.keys.owner).raw;
  const library = rest(fx, "GET", "/v1/dashboard/library?format=html", fx.keys.owner).raw;

  // (a) THE BLIND SWEEP. Restore the old recognition rule — a number is a
  // number only when the whole cell is digits — and it must stop reporting the
  // embedded counts that were shipping past it.
  const blind = await mutantTree("fleet-dashboard.ts", [
    [
      `  return answer.match(/(?<![\\w.:\\-\\/])\\d+(?![\\w.:\\-\\/])/g) ?? [];`,
      `  return /^\\d+$/.test(answer) ? [answer] : [];`,
    ],
  ]);
  // a page built the way the old renderer built it: a count inside a sentence
  const embedded = `<table><thead><tr><th>included</th></tr></thead><tbody><tr><td>steps: 4 | files: 7</td></tr></tbody></table>`;
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
// 7. THE SHIPPED DOCUMENTATION IS CHECKED AGAINST THE SHIPPED CODE
// ===========================================================================
//
// `README.md` said the dashboard had SIX views. It has eleven. `src/mcp.ts`'s
// own `dashboard.view` description said six as well — a tool telling a client,
// in the payload of `tools/list`, a number that was wrong by five.
//
// A false statement in shipped documentation is the same class of defect as a
// guard that proves something other than what it claims: a reader acts on it,
// and nothing contradicts it. It counts as a blocker, so it is caught by a
// check rather than by a reader.
//
// The numbers below are read FROM THE CODE. Nothing here is a literal that
// would have to be updated in two places — adding a view or a tool changes what
// this test demands, and the documents have to follow.

/** The number a document writes in words or in digits, wherever it says it. */
function documentSays(text: string, subject: RegExp): Set<string> {
  const WORDS: Record<string, string> = {
    five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
    thirteen: "13", twenty: "20", thirty: "30", "thirty-six": "36", "thirty-five": "35",
  };
  const found = new Set<string>();
  for (const m of text.matchAll(subject)) {
    const raw = String(m[1] ?? "").toLowerCase();
    found.add(WORDS[raw] ?? raw);
  }
  return found;
}

test("the shipped documents state the real number of dashboard views and of MCP tools", () => {
  const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const views = DASHBOARD_VIEWS.length;
  const tools = MCP_TOOLS.length;
  console.log(`[docs] shipped views: ${views}; shipped MCP tools: ${tools}`);

  const documents: Array<[string, string]> = [
    ["README.md", read("README.md")],
    ["docs/API.md", read("docs/API.md")],
    ["src/mcp.ts", read("src/mcp.ts")],
  ];
  const wrong: string[] = [];
  let claims = 0;
  for (const [name, text] of documents) {
    // "N views" / "N read-only views" / "one of the N views", in words or digits
    const claimed = documentSays(
      text,
      /\b(five|six|seven|eight|nine|ten|eleven|twelve|thirteen|\d+)\s+(?:read-only\s+)?(?:dashboard\s+)?views?\b/gi,
    );
    for (const c of claimed) {
      claims += 1;
      if (c !== String(views)) wrong.push(`${name}: claims ${c} dashboard views; the code ships ${views}`);
    }
    // every view NAME the document lists must exist, and a document that lists
    // any of them must list them all — a partial list reads as a whole one
    for (const view of DASHBOARD_VIEWS) {
      if (!text.includes(`\`${view}\``) && !text.includes(`**${view}**`)) continue;
      const listedAll = DASHBOARD_VIEWS.every((v) => text.includes(v));
      if (!listedAll) wrong.push(`${name}: names some dashboard views and not all ${views}`);
      break;
    }
  }
  console.log(`[docs] documents checked: ${documents.length}; explicit view-count claims found: ${claims}`);
  assert.ok(claims > 0, "no document states the number of views: the check would pass on silence");
  assert.deepEqual(wrong, [], "shipped documentation that does not describe the shipped code");

  // …and every tool the adapter dispatches is named in the README's tool table,
  // so a tool cannot ship undocumented
  const readme = read("README.md");
  const undocumented = (MCP_TOOLS as ReadonlyArray<any>).map((t) => t.name).filter((n) => !readme.includes(`\`${n}\``));
  console.log(`[docs] MCP tools named in README.md: ${tools - undocumented.length}/${tools}`);
  assert.deepEqual(undocumented, [], "MCP tools the README does not name");
});

test("the documentation guard is killed by a document that overstates or understates", () => {
  // A guard over documents has to be shown to bite, exactly like one over code.
  // The mutation is the defect that shipped: the README saying `six`.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const before = sha256(readme);
  const template = "The dashboard has eleven read-only views";
  const occurrences = readme.split(template).length - 1;
  assert.equal(occurrences, 1, `the mutation template must occur EXACTLY ONCE in README.md, found ${occurrences}`);
  const mutated = readme.replace(template, "The dashboard has six read-only views");
  const after = sha256(mutated);
  assert.notEqual(after, before, "the substitution did not change the bytes of README.md");
  console.log(`  before: ${template}`);
  console.log(`  after : The dashboard has six read-only views`);
  console.log(`[mutation] README.md  sha256 ${before.slice(0, 12)} → ${after.slice(0, 12)} (in memory only)`);
  const claimed = documentSays(
    mutated,
    /\b(five|six|seven|eight|nine|ten|eleven|twelve|thirteen|\d+)\s+(?:read-only\s+)?(?:dashboard\s+)?views?\b/gi,
  );
  killed("a README claiming six views passed the documentation guard", () => {
    for (const c of claimed) assert.equal(c, String(DASHBOARD_VIEWS.length));
  });
});
