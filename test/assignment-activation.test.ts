// §5.5 deployment assignments and native activation.
//
// The tests are grouped by the thing each one refuses to let happen:
//
//   1. AN `active` THAT LOOKS LIKE A FACT. The state machine has a state called
//      `active`, and the whole risk of this work is that it is read as a report
//      about a runtime. Group 1 is the most important in the file: a successful
//      activation must NOT produce an observed `active`, the observation column
//      must move when RECORDS move and only then, and a version that can never
//      produce a record must say so with its own reason.
//   2. A WRITE OUTSIDE THE CONFIGURED ROOT. Not asserted — MEASURED, by
//      snapshotting the tree outside the root before and after, with the
//      snapshot itself first shown to detect a planted change.
//   3. AN UNDERCOUNT AT A SYMBOLIC LINK, which is how a shared skill library is
//      normally handed to a fleet.
//   4. A WITHDRAWAL THAT PROMISES MORE THAN A FILE REMOVAL IS.
//   5. A STATE READ FROM A ROW instead of from the journal.
//   6. A PERMISSION MODEL OF ITS OWN, and a tool whose hints lie about what it
//      touches.
//   7. A SECRET, OR AN OPERATOR'S ABSOLUTE PATH, IN A RECORD OR AN ANSWER.
//   8. A NUMBER WITHOUT ITS METHOD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { p4Fixture, reviewedVersion, rest, mcp, type P4Fixture } from "./p6-helpers.ts";
import { serve } from "../src/server.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { TRANSFER_ACTION } from "../src/transfer.ts";
import { arrivalMarker } from "../src/marker.ts";
import { ulid } from "../src/ulid.ts";
import {
  ACTIVATION_TARGETS,
  FixedActivationRoots,
  INSTRUCTIONS_ALREADY_READ,
  NO_ACTIVATION_ROOTS,
  erasureClaim,
  nativeRelativePath,
  skillFilesUnder,
  type ActivationRoots,
  type ActivationSite,
  type ActivationTarget,
} from "../src/activation.ts";
import {
  DEPLOYMENT_STATES,
  DEPLOYMENT_TRANSITIONS,
  appendAssignmentEvent,
  type RuntimeRecordSource,
  type RuntimeRecordWindow,
} from "../src/assignments.ts";

// ===========================================================================
// The harness
// ===========================================================================

const temps: string[] = [];

/** A temporary tree. NOTHING in this file ever names a real runtime path. */
function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "skln-activation-"));
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

/** An activation root the tests can switch OFF, to model a deployment whose
 *  configuration stops naming a place it once wrote to. */
class SwitchableRoots implements ActivationRoots {
  site: ActivationSite | null;
  constructor(site: ActivationSite | null) {
    this.site = site;
  }
  rootFor(): ActivationSite | null {
    return this.site;
  }
}

/** A record source the test fills by hand — the seam the scanner work plugs
 *  into, standing in for it here. */
class RecordBox implements RuntimeRecordSource {
  window: RuntimeRecordWindow | null = { records: [], window: "0 records, supplied by the test harness" };
  recordsFor(): RuntimeRecordWindow | null {
    return this.window;
  }
  set(records: Array<{ role: "call" | "output"; call_id: string | null; text: string }>): void {
    this.window = { records, window: `${records.length} records, supplied by the test harness` };
  }
}

interface Deployed {
  fx: P4Fixture;
  assignmentId: string;
  versionId: string;
  manifest: any;
  slug: string;
}

/** Push one version to the reviewer, so there is a deployment to act on. */
function deploy(
  fx: P4Fixture,
  slug: string,
  opts: { manifest?: Record<string, unknown>; to?: string } = {},
): Deployed {
  const v = reviewedVersion(fx, slug, opts.manifest ? { manifest: opts.manifest } : {});
  const granted = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: fx.member.agent_id,
    action: TRANSFER_ACTION,
    recipient_scope: "local_agent",
  });
  assert.equal(granted.status, 201, granted.raw);
  const pushed = rest(fx, "POST", `/v1/versions/${v.versionId}/transfers`, fx.keys.member, {
    recipient: { kind: "local_agent", ref: opts.to ?? fx.reviewer.agent_id },
  });
  assert.equal(pushed.status, 201, pushed.raw);
  assert.ok(pushed.body.assignment_id, "a push opens a deployment");
  return { fx, assignmentId: pushed.body.assignment_id, versionId: v.versionId, manifest: v.manifest, slug };
}

/** Give one agent one step of the loop, so a deployment call is authorized. */
function allow(fx: P4Fixture, agentId: string, action: string): void {
  const res = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: agentId,
    action,
    recipient_scope: "local_agent",
  });
  assert.equal(res.status, 201, res.raw);
}

function act(fx: P4Fixture, key: string, assignmentId: string, what: "activate" | "pause" | "revoke"): any {
  return rest(fx, "POST", `/v1/assignments/${assignmentId}/${what}`, key, {});
}

function listed(fx: P4Fixture, key: string, assignmentId: string): any {
  const res = rest(fx, "GET", "/v1/assignments", key);
  assert.equal(res.status, 200, res.raw);
  const row = res.body.items.find((i: any) => i.assignment_id === assignmentId);
  assert.ok(row, "the deployment is readable");
  return row;
}

function journal(fx: P4Fixture, assignmentId: string): Array<Record<string, any>> {
  return fx.db
    .prepare("SELECT * FROM assignment_events WHERE assignment_id=? ORDER BY event_seq")
    .all(assignmentId) as Array<Record<string, any>>;
}

/**
 * A recursive fingerprint of a tree, written HERE rather than taken from the
 * module under test.
 *
 * The proof in group 2 is "nothing outside the root changed", and a proof that
 * used the walker being tested would be worth nothing. It records every path
 * with the sha256 of its bytes (and the link target for a symlink), so a
 * changed byte is as visible as a new file.
 */
function fingerprint(dir: string, skip: (abs: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      if (skip(abs)) continue;
      const rel = relative(dir, abs);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        out[rel] = `symlink`;
        continue;
      }
      if (st.isDirectory()) {
        out[rel] = "dir";
        walk(abs);
        continue;
      }
      out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function diffOf(before: Record<string, string>, after: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) changed.push(`${k}: ${before[k] ?? "<absent>"} → ${after[k] ?? "<absent>"}`);
  }
  return changed.sort();
}

/**
 * A manifest that declares no shell — the structurally undemonstrable case.
 *
 * The steps lose their `command`, because §7.1's gate 8 fails a package whose
 * steps carry commands while `runtime.shell` is `["none"]`, and a fixture that
 * never lints clean would test the lint gate rather than the arrival reason.
 */
function noShellManifest(base: any): Record<string, unknown> {
  const steps = (base.procedure.steps as any[]).map((s) => {
    const { command, ...rest } = s;
    return rest;
  });
  return {
    runtime: { ...base.runtime, shell: ["none"] },
    procedure: { ...base.procedure, steps },
  };
}

/** A call/output PAIR carrying a marker AND ONE `call_id` — the only thing
 *  [M-5] counts. Without the shared id these are three unrelated records. */
function pair(marker: string): Array<{ role: "call" | "output"; call_id: string | null; text: string }> {
  return [
    { role: "call", call_id: "k-1", text: `./scripts/skln-arrive.sh` },
    { role: "output", call_id: "k-1", text: `skln-arrival-marker: ${marker}` },
    { role: "call", call_id: "k-1", text: `skln-arrival-marker: ${marker}` },
  ];
}

// ===========================================================================
// 1. THE FACT COLUMN. `active` is an intent, and nothing makes it an observation.
// ===========================================================================

test("a successful activation produces NO observed arrival: the fact column moves only when a marker RECORD does", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const records = new RecordBox();
  const fx = p4Fixture({
    activation: new FixedActivationRoots(root, "claude_code_project"),
    runtimeRecords: records,
  });
  const d = deploy(fx, "act-two-columns");
  allow(fx, fx.member.agent_id, "activate");

  // (a) The activation SUCCEEDS, entirely, through the shipped surface.
  const activated = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(activated.status, 200, activated.raw);
  assert.equal(activated.body.assignment.intent_state, "active", "the registry did put the copy in place");
  assert.equal(activated.body.managed_copy, "written");
  // …and the file really is there, read with the test's own fs call
  const native = join(root, nativeRelativePath("claude_code_project", d.slug));
  assert.ok(existsSync(native), "the managed copy is at the native location");

  // (b) AND THE OBSERVATION IS UNKNOWN. This is the assertion the whole work
  //     exists for: a file on disk is not a run, and nothing may report one.
  assert.equal(activated.body.assignment.observed_arrival, "unknown");
  assert.equal(activated.body.assignment.observed_arrival_reason, "no_paired_record");
  assert.notEqual(
    activated.body.assignment.intent_state,
    activated.body.assignment.observed_arrival,
    "intent and observation are one value",
  );
  assert.equal(activated.body.assignment.intent_state_is, "intent", "the intent column is labelled as one");
  assert.equal(activated.body.assignment.observed_arrival_is, "observation");
  assert.notEqual(
    activated.body.assignment.intent_state_source,
    activated.body.assignment.observed_arrival_source,
    "two columns computed from one source is one column",
  );
  // the observation is three-valued and `no` is not one of the three
  assert.ok(["yes", "unknown"].includes(activated.body.assignment.observed_arrival));

  // (c) THE DISCRIMINATOR, first half. Records that do NOT establish arrival
  //     leave the answer exactly where it was — so the column is not merely
  //     "whatever the last write said".
  const marker = arrivalMarker(d.versionId);
  const seqBefore = journal(fx, d.assignmentId).length;
  for (const [why, given] of [
    ["a call alone", [{ role: "call" as const, call_id: "k-1", text: marker }]],
    ["an output alone", [{ role: "output" as const, call_id: "k-1", text: marker }]],
    ["a pair carrying another version's marker", pair(arrivalMarker("01OTHERVERSIONIDXXXXXXXXXX"))],
    [
      // [M-5]: the two halves exist, they carry THIS marker, and the runtime
      // bound them to different invocations. That is not a pair.
      "a call and an output under DIFFERENT call_ids",
      [
        { role: "call" as const, call_id: "k-1", text: marker },
        { role: "output" as const, call_id: "k-2", text: marker },
      ],
    ],
    [
      "a call and an output the runtime bound to NOTHING",
      [
        { role: "call" as const, call_id: null, text: marker },
        { role: "output" as const, call_id: null, text: marker },
      ],
    ],
    ["records with no marker at all", [{ role: "call" as const, call_id: "k-1", text: "hello" }, { role: "output" as const, call_id: "k-1", text: "world" }]],
  ] as const) {
    records.set(given as any);
    const row = listed(fx, fx.keys.owner, d.assignmentId);
    assert.equal(row.observed_arrival, "unknown", `${why} must not establish arrival`);
    assert.equal(row.intent_state, "active", `${why}: the intent is unchanged`);
  }

  // (d) THE DISCRIMINATOR, second half. A PAIRED call/output carrying THIS
  //     version's marker turns the observation — and nothing else — to `yes`.
  //     If the column were reading the intent, (c) would already have said yes;
  //     if it were constant, this would still say unknown.
  records.set(pair(marker));
  const observed = listed(fx, fx.keys.owner, d.assignmentId);
  assert.equal(observed.observed_arrival, "yes", "a paired record carrying this version's marker IS an arrival");
  assert.equal(observed.observed_arrival_reason, null, "a `yes` carries no unknown-reason");
  assert.equal(observed.intent_state, "active");
  assert.equal(observed.observed_records_read, 3, "the answer states how many records it read");

  // (e) …and NOTHING was written to establish it. The observation is computed at
  //     read time from records; the journal did not move between (c) and (d).
  assert.equal(journal(fx, d.assignmentId).length, seqBefore, "an observation wrote a deployment event");

  // (f) The two columns are independent in the OTHER direction too: pausing the
  //     deployment moves the intent and leaves the observation where it was. An
  //     agent that has run this version has run it, whatever the registry does
  //     to the file afterwards.
  allow(fx, fx.member.agent_id, "revoke");
  const paused = act(fx, fx.keys.member, d.assignmentId, "pause");
  assert.equal(paused.status, 200, paused.raw);
  assert.equal(paused.body.assignment.intent_state, "paused");
  assert.equal(paused.body.assignment.observed_arrival, "yes", "withdrawing a file cannot un-observe a run");
  fx.db.close();
});

test("a version that declares no shell can never demonstrate arrival, and says so with its own reason", () => {
  // The degenerate case, and the one a guard is most likely to get wrong by
  // taking the shape from what it FINDS rather than from what was DECLARED: a
  // `runtime.shell: ["none"]` package ships no arrival step, so a record
  // carrying its marker cannot have come from running it.
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const records = new RecordBox();
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "codex"), runtimeRecords: records });
  const withShell = deploy(fx, "act-has-shell");
  const noShell = deploy(fx, "act-no-shell", { manifest: noShellManifest(withShell.manifest), to: fx.admin.agent_id });
  allow(fx, fx.member.agent_id, "activate");

  assert.equal(act(fx, fx.keys.member, noShell.assignmentId, "activate").status, 200);
  assert.equal(act(fx, fx.keys.member, withShell.assignmentId, "activate").status, 200);

  // BOTH markers are present, as a proper pair, in the same record set.
  records.set([...pair(arrivalMarker(withShell.versionId)), ...pair(arrivalMarker(noShell.versionId))]);

  const shelled = listed(fx, fx.keys.owner, withShell.assignmentId);
  const shell_less = listed(fx, fx.keys.owner, noShell.assignmentId);
  assert.equal(shelled.observed_arrival, "yes", "the version that CAN print its marker is observed");
  assert.equal(shelled.has_executable_step, true);
  assert.equal(shell_less.observed_arrival, "unknown", "the version that cannot print one is never observed");
  assert.equal(shell_less.has_executable_step, false);
  assert.equal(
    shell_less.observed_arrival_reason,
    "no_executable_step",
    "and the reason is the STRUCTURAL one, machine-distinguishable from a search that came up empty",
  );
  assert.notEqual(shell_less.observed_arrival_reason, "no_paired_record");
  // both were activated, so the intent column cannot be what tells them apart
  assert.equal(shelled.intent_state, "active");
  assert.equal(shell_less.intent_state, "active");
  fx.db.close();
});

// ===========================================================================
// 2. THE ROOT IS A PARAMETER, AND NOTHING IS WRITTEN OUTSIDE IT
// ===========================================================================

test("with no activation root configured, activation writes NOTHING and records `queued`", () => {
  const base = tempBase();
  // a tree that looks exactly like the places this work may not touch
  mkdirSync(join(base, "home", ".claude", "skills"), { recursive: true });
  mkdirSync(join(base, "project", ".agents", "skills"), { recursive: true });
  writeFileSync(join(base, "home", ".claude", "skills", "SKILL.md"), "someone else's skill\n");
  const before = fingerprint(base);
  assert.ok(Object.keys(before).length >= 4, `the decoy tree is empty — this proof would prove nothing: ${JSON.stringify(before)}`);

  const fx = p4Fixture({ activation: NO_ACTIVATION_ROOTS });
  const d = deploy(fx, "act-unconfigured");
  allow(fx, fx.member.agent_id, "activate");
  const res = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.assignment.intent_state, "queued", "an unconfigured deployment waits; it does not activate");
  assert.equal(res.body.activation_root_configured, false);
  assert.equal(res.body.assignment.intent_reason, "no_activation_root_configured");
  assert.equal(res.body.managed_copy, "absent", "nothing was placed, so there is no copy");
  assert.notEqual(res.body.assignment.intent_state, "active");

  assert.deepEqual(diffOf(before, fingerprint(base)), [], "the shipped default wrote somewhere");
  // repeating converges rather than piling up events
  const again = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(again.body.noop, true);
  assert.equal(journal(fx, d.assignmentId).length, 2, "the noop appended an event");
  fx.db.close();
});

test("with a root configured, the skill is materialized at <root>/<native location> and is READ from there", () => {
  // Every target, one root each, all under a temporary tree. The assertion is
  // on the exact relative path, read back with the test's own fs call — not
  // through the module that wrote it.
  const expected: Record<ActivationTarget, string> = {
    claude_code_personal: ".claude/skills",
    claude_code_project: ".claude/skills",
    claude_code_plugin: "skills",
    codex: ".agents/skills",
  };
  for (const target of ACTIVATION_TARGETS) {
    const base = tempBase();
    const root = join(base, "root");
    mkdirSync(root);
    const fx = p4Fixture({ activation: new FixedActivationRoots(root, target) });
    const d = deploy(fx, `act-${target.replace(/_/g, "-")}`);
    allow(fx, fx.member.agent_id, "activate");
    const res = act(fx, fx.keys.member, d.assignmentId, "activate");
    assert.equal(res.status, 200, `${target}: ${res.raw}`);

    const rel = `${expected[target]}/${d.slug}/SKILL.md`;
    assert.equal(nativeRelativePath(target, d.slug), rel, `${target}: the native layout`);
    assert.equal(res.body.assignment.native_relpath, rel, `${target}: the journal records the relative path`);
    assert.equal(res.body.assignment.activation_target, target);

    const onDisk = readFileSync(join(root, rel), "utf8");
    assert.match(onDisk, /^# /, `${target}: the entry file is the package's SKILL.md`);
    // the WHOLE package is projected, so the copy carries its own evidence
    assert.ok(existsSync(join(root, expected[target], d.slug, "skill.json")), `${target}: the signed manifest`);
    assert.ok(existsSync(join(root, expected[target], d.slug, "SIGNATURE.jws")), `${target}: the signature`);

    // MUTATION GUARD: without the activation there is no file. Proved by the
    // deployment next to it that was never activated.
    const untouched = deploy(fx, `act-${target.replace(/_/g, "-")}-idle`, { to: fx.admin.agent_id });
    assert.ok(
      !existsSync(join(root, expected[target], untouched.slug)),
      `${target}: a deployment that was never activated left a file`,
    );
    // …and the path stores no root: the journal is relative, by CHECK
    const stored = journal(fx, d.assignmentId).filter((e) => e.native_relpath !== null);
    assert.ok(stored.length > 0, "a placement was recorded");
    for (const e of stored) assert.ok(!String(e.native_relpath).startsWith("/"), "an absolute path reached the journal");
    fx.db.close();
  }
});

test("activation writes nothing outside the root — measured, by fingerprinting everything outside it", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  // A tree that looks like the places a fleet keeps its skills, so that a write
  // escaping the root has somewhere recognisable to land.
  mkdirSync(join(base, "home", ".claude", "skills", "shared"), { recursive: true });
  mkdirSync(join(base, "project", ".agents", "skills", "shared"), { recursive: true });
  mkdirSync(join(base, "elsewhere", "lib"), { recursive: true });
  writeFileSync(join(base, "home", ".claude", "skills", "shared", "SKILL.md"), "decoy A\n");
  writeFileSync(join(base, "project", ".agents", "skills", "shared", "SKILL.md"), "decoy B\n");
  writeFileSync(join(base, "elsewhere", "lib", "note.txt"), "decoy C\n");

  const outside = (): Record<string, string> => fingerprint(base, (abs) => abs === root || abs.startsWith(root + "/"));
  const before = outside();
  assert.ok(
    Object.keys(before).length >= 9,
    `only ${Object.keys(before).length} paths outside the root — an empty snapshot would compare nothing with nothing`,
  );

  // THE SNAPSHOT MUST BE SHOWN TO BITE. A guard that cannot see a change it was
  // built to see proves nothing by staying silent, so a change is planted, seen,
  // and taken away again before the real measurement.
  const planted = join(base, "home", ".claude", "skills", "shared", "PLANTED.md");
  writeFileSync(planted, "planted\n");
  const plantedDiff = diffOf(before, outside());
  assert.equal(plantedDiff.length, 1, `the fingerprint missed a planted file: ${JSON.stringify(plantedDiff)}`);
  assert.match(plantedDiff[0], /PLANTED\.md/, "the fingerprint named the wrong change");
  // and a CHANGED BYTE, not only a new path
  writeFileSync(join(base, "elsewhere", "lib", "note.txt"), "decoy C tampered\n");
  assert.equal(diffOf(before, outside()).length, 2, "the fingerprint missed a changed byte");
  rmSync(planted);
  writeFileSync(join(base, "elsewhere", "lib", "note.txt"), "decoy C\n");
  assert.deepEqual(diffOf(before, outside()), [], "the harness did not restore its own tree");

  // NOW the measurement: a full deployment lifecycle against the root.
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_personal") });
  const d = deploy(fx, "act-nothing-outside");
  allow(fx, fx.member.agent_id, "activate");
  allow(fx, fx.member.agent_id, "revoke");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "pause").status, 200);
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "revoke").status, 200);

  assert.deepEqual(diffOf(before, outside()), [], "activation wrote outside the configured root");
  // and the root itself DID move, so the measurement above is about the
  // boundary and not about a run in which nothing happened at all
  assert.ok(Object.keys(fingerprint(root)).length > 0, "nothing was written inside the root either — the run did nothing");
  fx.db.close();
});

test("a symbolic link that leaves the root stops the activation instead of writing through it", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(base, "outside", "library"), { recursive: true });
  writeFileSync(join(base, "outside", "library", "keep.txt"), "not ours\n");
  // the ordinary way a fleet is handed a shared library — and the ordinary way
  // a write escapes a root that only checks the path lexically
  symlinkSync(join(base, "outside", "library"), join(root, ".claude", "skills"));

  const outside = (): Record<string, string> => fingerprint(join(base, "outside"));
  const before = outside();
  assert.equal(Object.keys(before).length, 2, "the outside tree is what the test built");

  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_personal") });
  const d = deploy(fx, "act-escaping-link");
  allow(fx, fx.member.agent_id, "activate");
  const refused = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(refused.status, 412, refused.raw);
  assert.equal(refused.body.error.code, "PRECONDITION_FAILED");
  assert.match(refused.body.error.message, /outside_root_refused/, "the refusal names the reason");
  assert.equal(refused.body.error.current_state, "failed");

  assert.deepEqual(diffOf(before, outside()), [], "the activation wrote through a link that leaves the root");
  // the failure is RECORDED, and it is not a claim
  const events = journal(fx, d.assignmentId).map((e) => e.event);
  assert.deepEqual(events, ["assigned", "activating", "failed"], "the attempt is in the journal");
  assert.equal(listed(fx, fx.keys.owner, d.assignmentId).intent_state, "failed");
  assert.notEqual(listed(fx, fx.keys.owner, d.assignmentId).intent_state, "active");
  fx.db.close();
});

test("a link planted at the entry's own name is replaced, not written through", () => {
  const base = tempBase();
  const root = join(base, "root");
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "codex") });
  const d = deploy(fx, "act-planted-entry");
  mkdirSync(join(root, ".agents", "skills", d.slug), { recursive: true });
  mkdirSync(join(base, "outside"), { recursive: true });
  const victim = join(base, "outside", "victim.txt");
  writeFileSync(victim, "untouched\n");
  symlinkSync(victim, join(root, ".agents", "skills", d.slug, "SKILL.md"));

  allow(fx, fx.member.agent_id, "activate");
  const res = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(res.status, 200, res.raw);
  assert.equal(readFileSync(victim, "utf8"), "untouched\n", "the write followed a planted link out of the root");
  const entry = join(root, ".agents", "skills", d.slug, "SKILL.md");
  assert.equal(lstatSync(entry).isSymbolicLink(), false, "the entry is still a link");
  assert.match(readFileSync(entry, "utf8"), /^# /, "the managed copy is the package's own bytes");
  fx.db.close();
});

test("no shipped source names a real runtime location, and the default root is nowhere", () => {
  // D-7 read as a property of the code rather than of this test run: the
  // adapter knows LAYOUTS, relative to a root it is given, and knows no home
  // directory, no `~`, and no absolute default.
  for (const file of ["src/activation.ts", "src/assignments.ts", "src/service.ts"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/\bhomedir\b/.test(text), `${file} reads a home directory`);
    assert.ok(!/process\.env\.(HOME|USERPROFILE)/.test(text), `${file} reads HOME`);
    assert.ok(!/["'`]~\//.test(text), `${file} carries a \`~/\` path`);
    assert.ok(!/["'`]\/(home|root|Users)\//.test(text), `${file} carries an absolute user path`);
  }
  assert.equal(NO_ACTIVATION_ROOTS.rootFor("any-agent"), null, "the shipped default names a place");
  // …and the layouts it DOES know are relative, every one of them
  for (const target of ACTIVATION_TARGETS) {
    const rel = nativeRelativePath(target, "some-skill");
    assert.ok(!rel.startsWith("/"), `${target} is absolute`);
    assert.ok(!rel.includes(".."), `${target} traverses`);
  }
  // the root is CONFIGURATION: no route and no tool accepts one
  for (const tool of MCP_TOOLS.filter((t) => t.name.startsWith("assignment."))) {
    const props = Object.keys((tool as any).inputSchema.properties ?? {});
    for (const p of props) {
      assert.ok(!/root|path|dir/i.test(p), `${tool.name} takes a location from its caller: ${p}`);
    }
  }
});

test("the activation root is CONFIGURATION: a deployment names it in the environment, and a bare start names nowhere", () => {
  // D-7 point 1 as a property of the deployment rather than of a constructor
  // argument: pointing this registry at a real runtime directory is a variable
  // an operator writes down, not a code change — and a half-written one is
  // refused rather than half-obeyed.
  const saved = {
    root: process.env.SKILLONOMIA_ACTIVATION_ROOT,
    target: process.env.SKILLONOMIA_ACTIVATION_TARGET,
  };
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const dataDir = join(base, "data");
  const lines: string[] = [];
  const start = (): any =>
    serve({ port: 0, dataDir, workerIntervalMs: 0, installSeedPackage: false, log: (l) => lines.push(l) });
  try {
    // (a) nothing set: the process starts, and says in as many words that it
    //     will write no managed copy anywhere
    delete process.env.SKILLONOMIA_ACTIVATION_ROOT;
    delete process.env.SKILLONOMIA_ACTIVATION_TARGET;
    const bare = start();
    bare.close();
    const offLine = lines.find((l) => l.startsWith("native activation:"));
    assert.ok(offLine, "a start must say whether it can write into a runtime");
    assert.match(offLine, /off/);
    assert.match(offLine, /queued/, "…and what an activation does instead");

    // (b) a root with no target, and a target with no root, are REFUSED. A
    //     half-configured activation must not resolve to a guess about where.
    process.env.SKILLONOMIA_ACTIVATION_ROOT = root;
    assert.throws(start, /SKILLONOMIA_ACTIVATION_TARGET must be one of/, "a root with no layout was accepted");
    delete process.env.SKILLONOMIA_ACTIVATION_ROOT;
    process.env.SKILLONOMIA_ACTIVATION_TARGET = "codex";
    assert.throws(start, /without SKILLONOMIA_ACTIVATION_ROOT/, "a layout with no place was accepted");

    // (c) both set: activation is on, and the start says so
    process.env.SKILLONOMIA_ACTIVATION_ROOT = root;
    lines.length = 0;
    const configured = start();
    configured.close();
    const onLine = lines.find((l) => l.startsWith("native activation:"));
    assert.ok(onLine && /ON/.test(onLine), `a configured start must say so: ${onLine}`);
    assert.match(onLine!, /NOWHERE else/, "…and must state the boundary it writes within");

    // (d) a relative root is refused: nothing here is resolved against a
    //     working directory, and nothing is expanded
    process.env.SKILLONOMIA_ACTIVATION_ROOT = "relative/path";
    assert.throws(start, /absolute/, "a relative root was accepted");
    process.env.SKILLONOMIA_ACTIVATION_ROOT = "~/skills";
    assert.throws(start, /absolute/, "a `~` root was expanded rather than refused");
  } finally {
    if (saved.root === undefined) delete process.env.SKILLONOMIA_ACTIVATION_ROOT;
    else process.env.SKILLONOMIA_ACTIVATION_ROOT = saved.root;
    if (saved.target === undefined) delete process.env.SKILLONOMIA_ACTIVATION_TARGET;
    else process.env.SKILLONOMIA_ACTIVATION_TARGET = saved.target;
  }
  // the two variables are documented with an EMPTY default, so the shipped
  // configuration cannot be read as naming a place
  const ops = readFileSync(new URL("../docs/OPERATIONS.md", import.meta.url), "utf8");
  for (const v of ["SKILLONOMIA_ACTIVATION_ROOT", "SKILLONOMIA_ACTIVATION_TARGET"]) {
    assert.ok(ops.includes(`\`${v}\` | — |`), `OPERATIONS.md must document ${v} with no default`);
  }
});

// ===========================================================================
// 3. THE COUNT FOLLOWS SYMBOLIC LINKS
// ===========================================================================

test("the native inventory follows symbolic links, because that is how a shared library is handed out", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(join(root, "skills", "own"), { recursive: true });
  writeFileSync(join(root, "skills", "own", "SKILL.md"), "# own\n");
  // the shared library, elsewhere on the disk, reached through a link
  mkdirSync(join(base, "shared", "alpha"), { recursive: true });
  mkdirSync(join(base, "shared", "beta"), { recursive: true });
  writeFileSync(join(base, "shared", "alpha", "SKILL.md"), "# alpha\n");
  writeFileSync(join(base, "shared", "beta", "SKILL.md"), "# beta\n");
  symlinkSync(join(base, "shared"), join(root, "library"));

  const counted = skillFilesUnder(root);
  console.log(`[I-4] skill entry files under the root, links followed: ${counted}`);
  assert.equal(counted, 3, "a walk that stops at the link reports 1 and undercounts the library by two");

  // a link that points back at an ancestor terminates the walk rather than the
  // process — otherwise "follow links" would be unusable in the one arrangement
  // it exists for
  symlinkSync(root, join(base, "shared", "loop"));
  assert.equal(skillFilesUnder(root), 3, "a cycle changed the count");

  // and the number reaches the surface with its method attached
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_plugin") });
  deploy(fx, "act-inventory");
  const res = rest(fx, "GET", "/v1/assignments", fx.keys.owner);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.native_inventory.skill_files, 3);
  assert.equal(res.body.native_inventory.measurement_state, "counted");
  assert.match(res.body.native_inventory.source, /symbolic links followed/);
  assert.ok(res.body.native_inventory.window.length > 0, "the count states its boundary");
  fx.db.close();
});

// ===========================================================================
// 4. WITHDRAWAL SAYS WHAT IT DID, AND NEVER MORE THAN THAT
// ===========================================================================

test("revoking removes the managed copy, reports which, and never promises the agent forgets", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_project") });
  const d = deploy(fx, "act-revoke");
  allow(fx, fx.member.agent_id, "activate");
  allow(fx, fx.member.agent_id, "revoke");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);
  const native = join(root, nativeRelativePath("claude_code_project", d.slug));
  assert.ok(existsSync(native), "there is a copy to remove");

  const revoked = act(fx, fx.keys.member, d.assignmentId, "revoke");
  assert.equal(revoked.status, 200, revoked.raw);
  assert.equal(revoked.body.managed_copy, "removed");
  assert.ok(!existsSync(native), "`removed` was reported for a copy that is still there");
  assert.equal(revoked.body.assignment.intent_state, "revoked");
  assert.equal(revoked.body.requires_new_session, true, "the answer must say a new session is required");
  assert.match(revoked.body.session_effect, /NEW SESSION IS REQUIRED/i);

  // THE PROHIBITION, checked on the shipped text.
  assert.equal(erasureClaim(revoked.raw), null, `the revocation answer promises erasure: ${revoked.raw}`);
  assert.equal(erasureClaim(INSTRUCTIONS_ALREADY_READ), null, "the honest sentence trips its own guard");
  for (const tool of MCP_TOOLS) {
    assert.equal(erasureClaim((tool as any).description), null, `the ${tool.name} description promises erasure`);
  }

  // THE DISCRIMINATOR. A guard that never fires is not a guard: the same answer
  // with the sentence replaced by the promise this system may not make must be
  // caught, and the honest DENIAL of that promise must not be.
  const doctored = revoked.raw.replace(
    JSON.stringify(revoked.body.session_effect).slice(1, -1),
    "Revoking erases the instructions the agent has already read.",
  );
  assert.notEqual(doctored, revoked.raw, "the substitution did not take — this test is checking nothing");
  assert.equal(erasureClaim(doctored), "erases_what_was_read", "the guard missed an explicit promise of erasure");
  for (const promise of [
    "the agent forgets the skill once the box is unticked",
    "unticking makes the agent unread the instructions",
    "the agent no longer knows the procedure",
    "the agent immediately stops using it",
    "the agent loses access to the instructions",
  ]) {
    assert.ok(erasureClaim(promise) !== null, `the guard missed: ${promise}`);
  }
  for (const honest of [
    "Revoking does not erase the instructions the agent has already read.",
    "The agent cannot forget what it has read; a new session is required.",
    INSTRUCTIONS_ALREADY_READ,
  ]) {
    assert.equal(erasureClaim(honest), null, `the guard flagged an honest sentence: ${honest}`);
  }
  fx.db.close();
});

test("a withdrawal that cannot reach the copy reports `retained`, and one with nothing to remove reports `absent`", () => {
  // The degenerate case this class of guard fails at: counting the CALL as the
  // removal. Three real situations, three different answers, and only one of
  // them is `removed`.
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const roots = new SwitchableRoots({ root, target: "codex" });
  const fx = p4Fixture({ activation: roots });
  allow(fx, fx.member.agent_id, "activate");
  allow(fx, fx.member.agent_id, "revoke");

  // (a) never activated: there is no copy, and the answer says so
  const idle = deploy(fx, "act-withdraw-idle");
  const absent = act(fx, fx.keys.member, idle.assignmentId, "revoke");
  assert.equal(absent.status, 200, absent.raw);
  assert.equal(absent.body.managed_copy, "absent", "a deployment that was never placed has nothing removed");

  // (b) activated, then the configuration stops naming the root: the copy is
  //     still there and the registry may not say it took it away
  const stranded = deploy(fx, "act-withdraw-stranded", { to: fx.admin.agent_id });
  assert.equal(act(fx, fx.keys.member, stranded.assignmentId, "activate").status, 200);
  const strandedFile = join(root, nativeRelativePath("codex", stranded.slug));
  assert.ok(existsSync(strandedFile));
  roots.site = null;
  const retained = act(fx, fx.keys.member, stranded.assignmentId, "revoke");
  assert.equal(retained.status, 200, retained.raw);
  assert.equal(retained.body.managed_copy, "retained", "an unreachable copy was reported removed");
  assert.notEqual(retained.body.managed_copy, "removed");
  assert.equal(retained.body.assignment.intent_reason, "no_activation_root_configured");
  assert.ok(existsSync(strandedFile), "the harness is wrong: the file really did go");
  assert.equal(retained.body.requires_new_session, true, "a retained copy still needs a new session to matter");

  // (c) activated, root configured: and ONLY here is it `removed`
  roots.site = { root, target: "codex" };
  const real = deploy(fx, "act-withdraw-real", { to: fx.reviewer2.agent_id });
  assert.equal(act(fx, fx.keys.member, real.assignmentId, "activate").status, 200);
  const realFile = join(root, nativeRelativePath("codex", real.slug));
  assert.ok(existsSync(realFile));
  const removed = act(fx, fx.keys.member, real.assignmentId, "revoke");
  assert.equal(removed.body.managed_copy, "removed");
  assert.ok(!existsSync(realFile));

  // the three answers really are three different values
  assert.equal(new Set([absent.body.managed_copy, retained.body.managed_copy, removed.body.managed_copy]).size, 3);
  fx.db.close();
});

test("a second push of the same skill supersedes the standing one, and the earlier decision stays readable", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_project") });
  const v = reviewedVersion(fx, "act-supersede");
  allow(fx, fx.member.agent_id, TRANSFER_ACTION);
  allow(fx, fx.member.agent_id, "activate");
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const pushed = rest(fx, "POST", `/v1/versions/${v.versionId}/transfers`, fx.keys.member, {
      recipient: { kind: "local_agent", ref: fx.reviewer.agent_id },
    });
    assert.equal(pushed.status, 201, pushed.raw);
    ids.push(pushed.body.assignment_id);
    if (i === 0) {
      assert.deepEqual(pushed.body.superseded_assignment_ids, [], "the first push supersedes nothing");
      // …and it is ACTIVATED, so the supersession below has a real file to
      // account for rather than an empty case
      assert.equal(act(fx, fx.keys.member, pushed.body.assignment_id, "activate").status, 200);
      assert.ok(existsSync(join(root, nativeRelativePath("claude_code_project", "act-supersede"))));
    } else assert.deepEqual(pushed.body.superseded_assignment_ids, [ids[i - 1]], "a push supersedes the standing one");
  }

  // THE FILE IS STILL THERE, and the superseded assignment says so. A push
  // touches no filesystem; the successor writes the SAME native location and
  // replaces the copy when IT is activated. Reporting `removed` here would be
  // the registry claiming a file operation it never performed.
  assert.ok(
    existsSync(join(root, nativeRelativePath("claude_code_project", "act-supersede"))),
    "the harness is wrong: the copy went away without anyone removing it",
  );
  const supersededEvent = journal(fx, ids[0]).at(-1)!;
  assert.equal(supersededEvent.event, "revoked");
  assert.equal(supersededEvent.managed_copy, "retained", "a supersession that removed nothing said it removed something");
  assert.notEqual(supersededEvent.managed_copy, "removed");

  // the table is POPULATED before anything is counted over it
  const rows = fx.db.prepare("SELECT COUNT(*) AS c FROM assignments").get() as { c: number };
  const events = fx.db.prepare("SELECT COUNT(*) AS c FROM assignment_events").get() as { c: number };
  console.log(`[supersede] assignments=${rows.c} assignment_events=${events.c}`);
  assert.equal(rows.c, 3, "three pushes, three decisions — none overwritten");
  assert.ok(events.c >= 5, "each supersession left an event of its own");

  const states = ids.map((id) => listed(fx, fx.keys.owner, id).intent_state);
  assert.deepEqual(states, ["revoked", "revoked", "assigned"], "exactly one standing assignment survives");
  for (const id of ids.slice(0, 2)) {
    const last = journal(fx, id).at(-1)!;
    assert.equal(last.event, "revoked");
    assert.match(String(last.reason), /^superseded_by_assignment:/, "the supersession names its successor");
  }
  // the earlier decisions are still there, in full, and cannot be edited away
  assert.throws(() => fx.db.prepare("UPDATE assignments SET agent_id='x'").run(), /INSERT_ONLY/);
  assert.throws(() => fx.db.prepare("DELETE FROM assignments").run(), /INSERT_ONLY/);
  assert.throws(() => fx.db.prepare("UPDATE assignment_events SET event='active'").run(), /INSERT_ONLY/);
  assert.throws(() => fx.db.prepare("DELETE FROM assignment_events").run(), /INSERT_ONLY/);
  fx.db.close();
});

// ===========================================================================
// 5. THE STATE IS THE JOURNAL
// ===========================================================================

test("a deployment state is the last EVENT, and no row holds one", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_project") });

  // (a) there is no state column to read from
  const columns = (fx.db.prepare("PRAGMA table_info(assignments)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!columns.some((c) => /state/i.test(c)), `assignments carries a state column: ${columns.join(",")}`);
  assert.deepEqual(columns, [
    "id",
    "skill_id",
    "skill_version_id",
    "agent_id",
    "recipient_kind",
    "transfer_id",
    "assigned_by_agent_id",
    "assigned_by_type",
    "assigned_by_role",
    "created_at_ms",
  ]);

  // (b) a full lifecycle leaves one event per step, in order
  const d = deploy(fx, "act-lifecycle");
  allow(fx, fx.member.agent_id, "activate");
  allow(fx, fx.member.agent_id, "revoke");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "pause").status, 200);
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);
  // drift: the copy on disk is changed under the registry's feet
  writeFileSync(join(root, nativeRelativePath("claude_code_project", d.slug)), "# tampered\n");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "revoke").status, 200);
  assert.deepEqual(
    journal(fx, d.assignmentId).map((e) => e.event),
    ["assigned", "activating", "active", "paused", "activating", "active", "drifted", "activating", "active", "revoked"],
    "the journal is the record of what happened, step by step",
  );
  assert.deepEqual(
    journal(fx, d.assignmentId).map((e) => e.event_seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(listed(fx, fx.keys.owner, d.assignmentId).intent_state, "revoked");
  // the restored copy really was rewritten after the drift was seen
  assert.equal(
    journal(fx, d.assignmentId).find((e) => e.event === "drifted")!.reason,
    "native_copy_differs",
  );

  // (c) the machine refuses an illegal step, and says where it is
  const late = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(late.status, 412, late.raw);
  assert.equal(late.body.error.code, "PRECONDITION_FAILED");
  assert.equal(late.body.error.current_state, "revoked");
  assert.deepEqual([...DEPLOYMENT_TRANSITIONS.revoked], [], "revoked is terminal");
  assert.deepEqual([...DEPLOYMENT_STATES], [
    "assigned",
    "queued",
    "activating",
    "active",
    "drifted",
    "failed",
    "paused",
    "revoked",
  ]);

  // (d) the schema refuses what the surface refuses: a stored path that is
  //     absolute, or that traverses. The table is populated first, so this is a
  //     constraint being exercised and not an empty set passing.
  const rows = fx.db.prepare("SELECT COUNT(*) AS c FROM assignment_events").get() as { c: number };
  console.log(`[I-6] assignment_events rows before the constraint probes: ${rows.c}`);
  assert.ok(rows.c >= 10, "the journal is populated");
  const insert = (relpath: string | null, event: string): void => {
    fx.db
      .prepare(
        `INSERT INTO assignment_events(id, assignment_id, event, event_seq, actor_agent_id, actor_type, actor_role,
           native_relpath, server_at_ms, idempotency_key) VALUES (?,?,?,?,?, 'agent', 'member', ?, 1, ?)`,
      )
      .run(ulid(Date.now()), d.assignmentId, event, 99, fx.member.agent_id, relpath, `probe-${relpath}-${event}`);
  };
  assert.throws(() => insert("/home/someone/.claude/skills/x/SKILL.md", "active"), /CHECK|constraint/i, "an absolute path");
  assert.throws(() => insert("../../escape/SKILL.md", "active"), /CHECK|constraint/i, "a traversing path");
  assert.throws(() => insert(null, "deployed"), /CHECK|constraint/i, "a state outside the machine");
  fx.db.close();
});

test("`active` is recorded only after the copy has been READ BACK from the native location", () => {
  // The one step that makes `active` mean anything: the registry does not
  // believe its own write. This needs a case where writing SUCCEEDS and reading
  // does not, which is what a write-only file is — an ordinary consequence of a
  // deployment's umask, and exactly the case where "the call returned" is not
  // evidence that a runtime can load anything.
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_project") });
  const d = deploy(fx, "act-read-back");
  allow(fx, fx.member.agent_id, "activate");

  const previous = process.umask(0o477); // new files become write-only
  let res: any;
  try {
    res = act(fx, fx.keys.member, d.assignmentId, "activate");
  } finally {
    process.umask(previous);
  }
  const entry = join(root, nativeRelativePath("claude_code_project", d.slug));
  assert.ok(existsSync(entry), "the harness is wrong: nothing was written, so the read-back is not what failed");
  assert.throws(() => readFileSync(entry), /EACCES|EPERM/, "the harness is wrong: the file is readable after all");

  assert.equal(res.status, 412, res.raw);
  assert.match(res.body.error.message, /read_back_failed/, "the refusal names the step that did not complete");
  assert.equal(res.body.error.current_state, "failed");
  const events = journal(fx, d.assignmentId).map((e) => e.event);
  assert.deepEqual(events, ["assigned", "activating", "failed"], "a write that could not be read back is not an activation");
  assert.ok(!events.includes("active"), "`active` was recorded for a copy nobody could read");
  assert.equal(listed(fx, fx.keys.owner, d.assignmentId).intent_state, "failed");
  fx.db.close();
});

// ===========================================================================
// 6. PERMISSIONS AND HINTS
// ===========================================================================

test("the deployment machine refuses a step no state admits — a jump straight to `active` above all", () => {
  // The surfaces only ever walk legal sequences, so the whitelist itself is
  // exercised here directly. The step that matters is `assigned → active`: if
  // the machine admitted it, a caller could record that a version is running
  // without any activation having been attempted.
  const fx = p4Fixture();
  const d = deploy(fx, "act-machine");
  const actor = { agent_id: fx.member.agent_id, type: "agent" as const, role: "member" as const };
  const head = () => journal(fx, d.assignmentId).at(-1)!.event;
  assert.equal(head(), "assigned");

  const illegal: Array<[string, string]> = [
    ["assigned", "active"],
    ["assigned", "drifted"],
    ["assigned", "failed"],
    ["assigned", "assigned"],
  ];
  for (const [from, to] of illegal) {
    assert.equal(head(), from, "the fixture moved under the probe");
    const threw = (() => {
      try {
        appendAssignmentEvent(fx.db, {
          assignmentId: d.assignmentId,
          event: to as any,
          actor,
          idempotencyKey: `probe-${from}-${to}`,
          nowMs: 1,
        });
        return null;
      } catch (e) {
        return e as any;
      }
    })();
    assert.ok(threw, `\`${from}\` → \`${to}\` was accepted`);
    assert.equal(threw.code, "PRECONDITION_FAILED", `${from} → ${to}`);
    assert.equal(threw.current_state, from, "the refusal reports where the deployment still is");
    assert.equal(journal(fx, d.assignmentId).length, 1, "a refused step appended an event");
  }

  // …and the legal one from the same state is accepted, so the refusals above
  // are about the transition and not about the probe
  appendAssignmentEvent(fx.db, {
    assignmentId: d.assignmentId,
    event: "activating",
    actor,
    idempotencyKey: "probe-legal",
    nowMs: 1,
  });
  assert.equal(head(), "activating");
  // every state is reachable from somewhere, and only `revoked` leads nowhere
  for (const s of DEPLOYMENT_STATES) {
    if (s === "assigned") continue;
    assert.ok(
      DEPLOYMENT_STATES.some((from) => (DEPLOYMENT_TRANSITIONS[from] as readonly string[]).includes(s)),
      `${s} is unreachable`,
    );
  }
  assert.deepEqual([...DEPLOYMENT_TRANSITIONS.revoked], []);
  fx.db.close();
});

test("the deployment steps are authorized by the §6.2 grants and by no permission of their own", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "codex") });
  const d = deploy(fx, "act-grants");

  // no grant at all
  const none = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(none.status, 403, none.raw);
  assert.equal(none.body.error.code, "FORBIDDEN");
  assert.match(none.body.error.message, /`activate`/, "the refusal names the step it wanted");

  // the WRONG step of the same loop, in the same scope
  allow(fx, fx.member.agent_id, "receive");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 403);
  // the revoke grant does not activate…
  allow(fx, fx.member.agent_id, "revoke");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 403);
  // …and the activate grant does not withdraw
  const fx2 = p4Fixture({ activation: new FixedActivationRoots(root, "codex") });
  const d2 = deploy(fx2, "act-grants-2");
  allow(fx2, fx2.member.agent_id, "activate");
  assert.equal(act(fx2, fx2.keys.member, d2.assignmentId, "activate").status, 200);
  const cannotRevoke = act(fx2, fx2.keys.member, d2.assignmentId, "revoke");
  assert.equal(cannotRevoke.status, 403, cannotRevoke.raw);
  assert.match(cannotRevoke.body.error.message, /`revoke`/);
  const cannotPause = act(fx2, fx2.keys.member, d2.assignmentId, "pause");
  assert.equal(cannotPause.status, 403, "pause and revoke exercise the same capability");
  fx2.db.close();

  // …and with the right grant it works, so the refusals above are about the
  // grant and not about the fixture
  allow(fx, fx.member.agent_id, "activate");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);

  // a deployment of another workspace is ABSENT, not forbidden
  const elsewhere = act(fx, fx.keys.outsider, d.assignmentId, "activate");
  assert.equal(elsewhere.status, 404, elsewhere.raw);
  assert.equal(elsewhere.body.error.code, "NOT_FOUND");
  // …and it is not disclosed by the read either
  const outsiderList = rest(fx, "GET", "/v1/assignments", fx.keys.outsider);
  assert.deepEqual(outsiderList.body.items, []);
  // a member reads exactly the deployments addressed to itself
  const reviewerList = rest(fx, "GET", "/v1/assignments", fx.keys.reviewer);
  assert.deepEqual(
    reviewerList.body.items.map((i: any) => i.assignment_id),
    [d.assignmentId],
  );

  // no new role, no new principal type — checked against the live schema
  const enumOf = (table: string, column: string): string[] => {
    const sql = (fx.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }).sql.replace(
      /\s+/g,
      " ",
    );
    const m = new RegExp(`CHECK\\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
    assert.ok(m, `no CHECK enum for ${table}.${column}`);
    return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  };
  for (const [t, c] of [
    ["assignments", "assigned_by_type"],
    ["assignment_events", "actor_type"],
  ] as const) {
    assert.deepEqual(enumOf(t, c), ["human", "agent", "service"], `${t}.${c}`);
  }
  for (const [t, c] of [
    ["assignments", "assigned_by_role"],
    ["assignment_events", "actor_role"],
  ] as const) {
    assert.deepEqual(enumOf(t, c), ["owner", "admin", "reviewer", "member"], `${t}.${c}`);
  }
  fx.db.close();
});

test("the deployment tools are one step each, and their hints tell the truth about what they touch", () => {
  const tools = Object.fromEntries(MCP_TOOLS.filter((t) => t.name.startsWith("assignment.")).map((t) => [t.name, t as any]));
  assert.deepEqual(Object.keys(tools).sort(), [
    "assignment.activate",
    "assignment.list",
    "assignment.pause",
    "assignment.revoke",
  ]);

  for (const name of ["assignment.activate", "assignment.pause", "assignment.revoke"]) {
    const t = tools[name];
    assert.equal(t.annotations.readOnlyHint, false, `${name} writes`);
    // `destructiveHint` and `idempotentHint` are NOT asserted here as
    // literals. Both are statements about BEHAVIOUR, and both are proved in
    // `test/p14-r2-invariants.test.ts` by driving every one of the 36 tools
    // twice and comparing the hint with what the database did — a check over
    // the shipped table rather than a value copied beside four names.
    // THE HONEST HINT, and the difference from every other tool in this
    // registry: these reach a filesystem that is not the registry's.
    assert.equal(t.annotations.openWorldHint, true, `${name} touches a runtime outside this registry and must say so`);
    assert.deepEqual(t.inputSchema.required, ["assignment_id"]);
    // one step: none of them can also report an outcome or move another step
    for (const forbidden of ["event", "evidence", "state", "action"]) {
      assert.ok(!(forbidden in t.inputSchema.properties), `${name} takes \`${forbidden}\` — that is two steps in one tool`);
    }
  }
  const read = tools["assignment.list"];
  assert.equal(read.annotations.readOnlyHint, true, "reading deployments must be callable without an approval prompt");
  assert.equal(read.annotations.openWorldHint, false, "the read touches no runtime");
  assert.deepEqual(Object.keys(read.inputSchema.properties), [], "the read takes no arguments and activates nothing");
  // the read is not a mode of a write
  assert.ok(!("assignment.manage" in tools), "a catch-all deployment tool");
  // and the transfer, which reaches nothing outside the registry, still says so
  const transfer = MCP_TOOLS.find((t) => t.name === "skill.transfer") as any;
  assert.equal(transfer.annotations.openWorldHint, false, "if everything claimed an open world the hint would say nothing");
});

test("the two adapters serve one deployment, and an idempotency_key replays it byte for byte", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_plugin") });
  const d = deploy(fx, "act-adapters");
  allow(fx, fx.member.agent_id, "activate");
  allow(fx, fx.member.agent_id, "revoke");

  const first = rest(fx, "POST", `/v1/assignments/${d.assignmentId}/activate`, fx.keys.member, {
    idempotency_key: "a-1",
  });
  assert.equal(first.status, 200, first.raw);
  const replay = rest(fx, "POST", `/v1/assignments/${d.assignmentId}/activate`, fx.keys.member, {
    idempotency_key: "a-1",
  });
  assert.equal(replay.raw, first.raw, "a replay is the original bytes");
  assert.equal(replay.headers["Idempotency-Replayed"], "true");
  assert.equal(journal(fx, d.assignmentId).length, 3, "the replay ran the activation again");

  // the read answers identically on both adapters (§6: one rule, two adapters)
  const viaRest = rest(fx, "GET", "/v1/assignments", fx.keys.owner);
  const viaMcp = mcp(fx, fx.keys.owner, "assignment.list", {});
  assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.data));
  assert.deepEqual(viaMcp.data, viaRest.body, "the deployment list differs between adapters");

  // …and so does a write
  const revokedMcp = mcp(fx, fx.keys.member, "assignment.revoke", { assignment_id: d.assignmentId });
  assert.equal(revokedMcp.isError, false, JSON.stringify(revokedMcp.data));
  assert.equal(revokedMcp.data.assignment.intent_state, "revoked");
  assert.equal(revokedMcp.data.managed_copy, "removed");
  // a refusal is the same envelope on both, too
  const late = mcp(fx, fx.keys.member, "assignment.activate", { assignment_id: d.assignmentId });
  assert.equal(late.isError, true);
  assert.equal(late.data.error.code, "PRECONDITION_FAILED");
  assert.equal(late.data.error.current_state, "revoked");
  const lateRest = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(lateRest.body.error.message, late.data.error.message, "identical envelope on both adapters");
  fx.db.close();
});

// ===========================================================================
// 7. SECRETS AND PATHS
// ===========================================================================

test("no key and no absolute path reaches a deployment record or a deployment answer", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const fx = p4Fixture({ activation: new FixedActivationRoots(root, "claude_code_personal") });
  const d = deploy(fx, "act-secrets");
  allow(fx, fx.member.agent_id, "activate");
  allow(fx, fx.member.agent_id, "revoke");
  const activated = act(fx, fx.keys.member, d.assignmentId, "activate");
  assert.equal(activated.status, 200, activated.raw);
  const revoked = act(fx, fx.keys.member, d.assignmentId, "revoke");
  const listedAll = rest(fx, "GET", "/v1/assignments", fx.keys.owner);

  const stored = JSON.stringify([
    fx.db.prepare("SELECT * FROM assignments").all(),
    fx.db.prepare("SELECT * FROM assignment_events").all(),
  ]);
  for (const [who, key] of Object.entries(fx.keys)) {
    assert.ok(!stored.includes(key), `a deployment row carries ${who}'s API key`);
    assert.ok(!activated.raw.includes(key), `the activation answer carries ${who}'s API key`);
    assert.ok(!listedAll.raw.includes(key), `the deployment list carries ${who}'s API key`);
  }
  // the operator's directory layout is not the registry's to publish
  for (const [what, text] of [
    ["the journal", stored],
    ["the activation answer", activated.raw],
    ["the revocation answer", revoked.raw],
    ["the deployment list", listedAll.raw],
  ] as const) {
    assert.ok(!text.includes(root), `${what} carries the absolute activation root`);
    assert.ok(!text.includes(base), `${what} carries an absolute path`);
  }
  // even when it fails: the reason is a CODE, and errno strings name paths
  rmSync(root, { recursive: true, force: true });
  const failed = act(fx, fx.keys.member, deploy(fx, "act-secrets-2", { to: fx.admin.agent_id }).assignmentId, "activate");
  assert.equal(failed.status, 412, failed.raw);
  assert.ok(!failed.raw.includes(base), `a failure message carries an absolute path: ${failed.raw}`);
  assert.match(failed.body.error.message, /root_missing/);
  fx.db.close();
});

// ===========================================================================
// 8. EVERY NUMBER CARRIES ITS METHOD
// ===========================================================================

test("every published deployment number states its measurement state, its source and its window", () => {
  const base = tempBase();
  const root = join(base, "root");
  mkdirSync(root);
  const records = new RecordBox();
  const roots = new SwitchableRoots(null);
  const fx = p4Fixture({ activation: roots, runtimeRecords: records });
  const d = deploy(fx, "act-numbers");

  // (a) with no root configured the filesystem number is UNKNOWN, not zero
  const unconfigured = rest(fx, "GET", "/v1/assignments", fx.keys.owner).body;
  assert.equal(unconfigured.native_inventory.skill_files, null);
  assert.equal(unconfigured.native_inventory.measurement_state, "unknown");
  assert.notEqual(unconfigured.native_inventory.skill_files, 0, "`nothing was walked` is not `nothing was found`");
  assert.ok(unconfigured.native_inventory.reason.length > 0, "an unknown says why");
  assert.ok(unconfigured.native_inventory.source.length > 0);
  assert.ok(unconfigured.native_inventory.window.length > 0);

  // (b) the two columns are COUNTED APART. Activate, so the intent count moves
  //     while the observation count does not.
  roots.site = { root, target: "claude_code_project" };
  allow(fx, fx.member.agent_id, "activate");
  allow(fx, fx.member.agent_id, "revoke");
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "activate").status, 200);
  const intentOnly = rest(fx, "GET", "/v1/assignments", fx.keys.owner).body.counts;
  assert.equal(intentOnly.assignments, 1);
  assert.equal(intentOnly.intent_active, 1, "the registry intends one deployment to be active");
  assert.equal(intentOnly.observed_arrival_yes, 0, "…and has observed none");
  assert.equal(intentOnly.observed_arrival_unknown, 1);
  assert.equal(intentOnly.measurement_state, "counted");
  assert.notEqual(intentOnly.intent_source, intentOnly.observation_source, "two counts from one source is one count");
  assert.ok(intentOnly.window.length > 0);

  // records arrive: the observation count moves and the intent count does not
  records.set(pair(arrivalMarker(d.versionId)));
  const both = rest(fx, "GET", "/v1/assignments", fx.keys.owner).body.counts;
  assert.equal(both.intent_active, 1);
  assert.equal(both.observed_arrival_yes, 1);
  assert.equal(both.observed_arrival_unknown, 0);

  // the deployment is withdrawn: the INTENT count falls to zero and the
  // observation stays — the run happened and no file operation unmakes it
  assert.equal(act(fx, fx.keys.member, d.assignmentId, "revoke").status, 200);
  const after = rest(fx, "GET", "/v1/assignments", fx.keys.owner).body.counts;
  assert.equal(after.intent_active, 0, "a revoked deployment is not intended active");
  assert.equal(after.observed_arrival_yes, 1, "an observation followed the intent down");

  // (c) no row of the answer has a blank cell where an answer belongs
  for (const row of rest(fx, "GET", "/v1/assignments", fx.keys.owner).body.items) {
    for (const field of [
      "intent_state",
      "intent_state_is",
      "intent_state_source",
      "observed_arrival",
      "observed_arrival_is",
      "observed_arrival_source",
      "observed_arrival_window",
      "managed_copy",
      "session_effect",
    ]) {
      assert.ok(typeof row[field] === "string" && row[field].length > 0, `${field} is blank`);
    }
    assert.ok(["written", "removed", "absent", "retained", "unknown"].includes(row.managed_copy));
  }
  fx.db.close();
});
