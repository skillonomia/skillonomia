// V1 P4 — IMMUTABLE SESSION LOADOUT AND THE TWO NATIVE ADAPTERS.
//
// One test per binary requirement, driven through the real router against a real
// database, except where the requirement is about the FILESYSTEM — those drive
// `src/runtime-adapter.ts` against a real temporary directory.
//
// What is NOT here: the two ACTUAL runtime sessions (`P4-FR-17`, `P4-FR-18`,
// `P4-FR-19`). Contract section 9 says outright that a mocked adapter test never
// substitutes for one, so this file does not pretend to cover them; they are
// `v1/tools/gates/runtime-codex.sh` and `v1/tools/gates/runtime-claude-code.sh`,
// which drive the real binaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRest, type RestResponse } from "../src/http.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { p4Fixture, evidenceReporter, type P4Fixture } from "./p4-helpers.ts";
import {
  nativeSkillName,
  parseReceiptMarker,
  receiptMarkerLine,
  ADAPTER_VERSION,
} from "../src/session-loadout.ts";
import {
  RUNTIMES,
  credentialShapeIn,
  materializeEntry,
  renderSkillMd,
  sessionHome,
  cleanupSession,
} from "../src/runtime-adapter.ts";
import { ActivationError } from "../src/activation.ts";
import { ulid } from "../src/ulid.ts";
import type { DraftContent } from "../src/draft.ts";

const ORIGIN = "console.local";

interface Call {
  method?: string;
  path: string;
  key?: string;
  cookie?: string;
  csrf?: string;
  body?: unknown;
}

function call(fx: P4Fixture, c: Call): RestResponse & { json: any } {
  const headers: Record<string, string | undefined> = { host: ORIGIN, origin: `http://${ORIGIN}` };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
  if (c.csrf) headers["x-skillonomia-console-csrf"] = c.csrf;
  const res = handleRest(fx.registry, {
    method: c.method ?? "GET",
    url: c.path,
    headers,
    body: c.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(c.body)),
  });
  let json: any = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { ...res, json };
}

function signIn(fx: P4Fixture): { cookie: string; csrf: string } {
  const minted = call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys.owner!, body: {} });
  assert.equal(minted.status, 201, minted.body);
  const opened = call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  assert.equal(opened.status, 201, opened.body);
  return { cookie: /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"])![1]!, csrf: opened.json.csrf_token };
}

function workflow(title: string, step: string): string {
  return [
    `# ${title}`,
    "",
    "Use this whenever a change is ready.",
    "",
    "## Purpose",
    "Ship a reviewed change.",
    "",
    "## Procedure",
    "1. Read the diff.",
    `2. ${step}`,
    "3. Merge it.",
    "",
    "## Inputs",
    "- the branch",
    "",
    "## Outputs",
    "- a merged change",
    "",
    "## Permissions",
    "- write to the repository",
    "",
    "## Dependencies",
    "- git",
    "",
    "## Failure modes",
    "- the suite is red",
  ].join("\n");
}

/** A capture, approved at revision 1. */
function approvedDraft(fx: P4Fixture, s: { cookie: string; csrf: string }, key: string, title = "ship the thing") {
  const captured = call(fx, {
    method: "POST",
    path: "/v1/captures",
    key: fx.keys.owner!,
    body: { kind: "workflow", text: workflow(title, "Run the suite."), idempotency_key: `cap-${key}` },
  });
  assert.equal(captured.status, 201, captured.body);
  const draft = captured.json.draft;
  const approved = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: draft.revision_id, idempotency_key: `app-${key}` },
  });
  assert.equal(approved.status, 201, approved.body);
  return { draft_id: draft.draft_id as string, revision_id: draft.revision_id as string };
}

/** An assignment of that revision to the fixture's reporter agent, ACTIVE. */
function activeAssignment(fx: P4Fixture, s: { cookie: string; csrf: string }, revisionId: string, key: string, agentId?: string): string {
  const created = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: agentId ?? fx.reporter.agent_id, revision_id: revisionId, idempotency_key: `asg-${key}` },
  });
  assert.equal(created.status, 201, created.body);
  const id = created.json.assignment.assignment_id;
  const activated = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/activate`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { idempotency_key: `act-${key}` },
  });
  assert.equal(activated.status, 200, activated.body);
  return id as string;
}

/** The whole cast a loadout test needs: an owner session, an approved and
 *  active assignment, and a registered ADAPTER principal to open sessions with. */
function ready(title = "ship the thing") {
  const fx = p4Fixture();
  const s = signIn(fx);
  const draft = approvedDraft(fx, s, "k1", title);
  const assignmentId = activeAssignment(fx, s, draft.revision_id, "k1");
  const adapter = evidenceReporter(fx, "adapter");
  return { fx, s, draft, assignmentId, adapter };
}

function openSession(fx: P4Fixture, adapterKey: string, agentId: string, kind = "codex", key = "s1") {
  return call(fx, {
    method: "POST",
    path: "/v1/sessions",
    key: adapterKey,
    body: { agent_id: agentId, runtime_kind: kind, runtime_version: "0.146.0", idempotency_key: key },
  });
}

// ===========================================================================
// P4-FR-01 / P4-FR-02 — the snapshot, and everything it must carry
// ===========================================================================

test("P4-FR-01/02: a new session snapshots only the ACTIVE desired assignments, with every identifier the contract names", () => {
  const { fx, s, draft, assignmentId, adapter } = ready();

  // a SECOND lineage, assigned and never activated: desired state `assigned`
  const other = approvedDraft(fx, s, "k2", "second thing");
  const idle = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: fx.reporter.agent_id, revision_id: other.revision_id, idempotency_key: "asg-k2" },
  });
  assert.equal(idle.status, 201, idle.body);

  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  assert.equal(opened.status, 201, opened.body);
  const lo = opened.json;

  assert.equal(lo.entry_count, 1, "only the ACTIVE assignment is in the loadout");
  assert.equal(lo.entries.length, 1);
  const e = lo.entries[0];
  assert.equal(e.assignment_id, assignmentId);
  assert.equal(e.draft_id, draft.draft_id);
  assert.equal(e.draft_revision_id, draft.revision_id);
  assert.equal(e.revision, 1);
  assert.match(e.content_digest, /^sha256:[0-9a-f]{64}$/);

  // every field `P4-FR-02` names, on the snapshot itself
  for (const field of [
    "loadout_id",
    "session_id",
    "agent_id",
    "runtime_kind",
    "runtime_version",
    "adapter_version",
    "loadout_digest",
    "created_at_ms",
  ]) {
    assert.ok(lo[field] !== undefined && lo[field] !== null, `the snapshot must carry ${field}`);
  }
  assert.equal(lo.runtime_kind, "codex");
  assert.equal(lo.runtime_version, "0.146.0");
  assert.equal(lo.adapter_version, ADAPTER_VERSION);
  assert.equal(lo.agent_id, fx.reporter.agent_id);

  // the exclusion is REPORTED, with a machine-readable reason
  const excluded = lo.excluded.find((c: any) => c.draft_id === other.draft_id);
  assert.ok(excluded, "an assignment left out of the loadout must be reported as left out");
  assert.equal(excluded.reason_code, "NOT_ACTIVE");
  assert.equal(excluded.desired_state, "assigned");
});

test("P4-FR-09 first half: building the loadout writes `proposed`, and writes nothing further", () => {
  const { fx, assignmentId, adapter } = ready();
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  assert.equal(opened.status, 201, opened.body);

  const rows = fx.db
    .prepare("SELECT observed_status, source, reason_code, session_ref, draft_revision_id FROM assignment_observations WHERE assignment_id=?")
    .all(assignmentId) as Array<Record<string, string>>;
  assert.equal(rows.length, 1, "one observation, and it is the proposal");
  assert.equal(rows[0]!.observed_status, "proposed");
  assert.equal(rows[0]!.reason_code, "LOADOUT_BUILT");
  assert.equal(rows[0]!.source, "adapter");
  assert.equal(rows[0]!.session_ref, opened.json.session_id);
  assert.equal(rows[0]!.draft_revision_id, opened.json.entries[0].draft_revision_id);

  // and NOTHING claims a load or an invocation
  const later = fx.db
    .prepare("SELECT count(*) c FROM assignment_observations WHERE observed_status IN ('loaded','invoked')")
    .get() as { c: number };
  assert.equal(later.c, 0, "a built loadout is not a loaded one");
  const receipts = fx.db.prepare("SELECT count(*) c FROM runtime_receipts").get() as { c: number };
  assert.equal(receipts.c, 0);
});

// ===========================================================================
// P4-FR-03 — after creation the snapshot does not change
// ===========================================================================

test("P4-FR-03: the snapshot is unchangeable in the DATABASE, not merely unchanged by this build", () => {
  const { fx, adapter } = ready();
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  const loadoutId = opened.json.loadout_id;

  for (const sql of [
    `UPDATE session_loadouts SET entry_count=99 WHERE id='${loadoutId}'`,
    `DELETE FROM session_loadouts WHERE id='${loadoutId}'`,
    `UPDATE session_loadout_entries SET content_digest='sha256:${"0".repeat(64)}' WHERE loadout_id='${loadoutId}'`,
    `DELETE FROM session_loadout_entries WHERE loadout_id='${loadoutId}'`,
    `UPDATE agent_sessions SET agent_id='x' WHERE id='${opened.json.session_id}'`,
  ]) {
    assert.throws(() => fx.db.exec(sql), /INSERT_ONLY/, `the database must refuse: ${sql.slice(0, 40)}`);
  }

  // and the read-back is byte-for-byte what was answered
  const again = call(fx, { method: "GET", path: `/v1/sessions/${opened.json.session_id}/loadout`, key: adapter.key });
  assert.equal(again.status, 200, again.body);
  assert.deepEqual(again.json.loadout.entries, opened.json.entries);
  assert.equal(again.json.loadout.loadout_digest, opened.json.loadout_digest);
});

// ===========================================================================
// P4-FR-04 / P4-FR-16 — what never enters, and what a later command changes
// ===========================================================================

test("P4-FR-04/16: pause and revoke leave the running session alone and empty the NEXT one", () => {
  const { fx, s, assignmentId, adapter } = ready();
  const first = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s1");
  assert.equal(first.json.entry_count, 1);

  const paused = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${assignmentId}/pause`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { idempotency_key: "pa-1" },
  });
  assert.equal(paused.status, 200, paused.body);
  assert.equal(paused.json.effective_from, "next_session");

  // `INV-07`: the session that already started is exactly as it was
  const still = call(fx, { method: "GET", path: `/v1/sessions/${first.json.session_id}/loadout`, key: adapter.key });
  assert.deepEqual(still.json.loadout.entries, first.json.entries, "a running session's loadout is not rewritten");

  // and the NEXT one is built from the new desired state
  const second = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s2");
  assert.equal(second.status, 201, second.body);
  assert.equal(second.json.entry_count, 0, "a paused assignment does not enter a new loadout");
  assert.equal(second.json.excluded[0].reason_code, "NOT_ACTIVE");
  assert.equal(second.json.excluded[0].desired_state, "paused");
  assert.notEqual(second.json.loadout_digest, first.json.loadout_digest);

  const revoked = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${assignmentId}/revoke`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { idempotency_key: "rv-1" },
  });
  assert.equal(revoked.status, 200, revoked.body);
  const third = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s3");
  assert.equal(third.json.entry_count, 0, "a revoked assignment does not enter a new loadout either");
  assert.equal(third.json.excluded[0].desired_state, "revoked");
});

test("P4-FR-04: an unapproved revision reaches neither an assignment nor a loadout", () => {
  const { fx, s, draft, adapter } = ready();
  // A NEWER revision of the same lineage, deliberately left unapproved.
  const edited = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/revisions`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { sections: { procedure: ["Read the diff.", "Run it twice.", "Merge it."] }, idempotency_key: "ed-1" },
  });
  assert.equal(edited.status, 201, edited.body);
  const unapproved = (
    fx.db
      .prepare("SELECT id FROM draft_revisions WHERE draft_id=? ORDER BY revision DESC LIMIT 1")
      .get(draft.draft_id) as { id: string }
  ).id;
  assert.notEqual(unapproved, draft.revision_id, "the edit appended a revision");

  const refusedAssign = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: fx.member.agent_id, revision_id: unapproved, idempotency_key: "asg-bad" },
  });
  assert.equal(refusedAssign.status, 412, refusedAssign.body);

  const refusedSelect = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${(fx.db.prepare("SELECT id FROM skill_assignments LIMIT 1").get() as { id: string }).id}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: unapproved, idempotency_key: "sel-bad" },
  });
  assert.equal(refusedSelect.status, 412, refusedSelect.body);

  // and the loadout the adapter builds still names the APPROVED revision, which
  // is the head of nothing an owner could have pointed it at
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s9");
  assert.equal(opened.status, 201, opened.body);
  assert.equal(opened.json.entries[0].draft_revision_id, draft.revision_id);
});

// ===========================================================================
// P4-FR-13 / INV-02 — who may write observed state, and who may not
// ===========================================================================

test("P4-FR-13: an owner command cannot open a session and cannot substitute for a receipt", () => {
  const { fx, s, adapter } = ready();

  // the owner's own Bearer key, on both intakes
  const ownerOpen = openSession(fx, fx.keys.owner!, fx.reporter.agent_id);
  assert.equal(ownerOpen.status, 403, ownerOpen.body);
  assert.match(ownerOpen.json.error.code, /FORBIDDEN/);

  const opened = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s1");
  const ownerReceipt = call(fx, {
    method: "POST",
    path: `/v1/sessions/${opened.json.session_id}/receipts`,
    key: fx.keys.owner!,
    body: {
      stage: "invoked",
      runtime_session_ref: "made-up",
      revision_id: opened.json.entries[0].draft_revision_id,
      content_digest: opened.json.entries[0].content_digest,
      invocation_ref: "made-up#1",
    },
  });
  assert.equal(ownerReceipt.status, 403, ownerReceipt.body);

  // an admin key is refused on the same ground: this is not a role ladder
  const adminOpen = openSession(fx, fx.keys.admin!, fx.reporter.agent_id, "codex", "s2");
  assert.equal(adminOpen.status, 403, adminOpen.body);

  // and a console SESSION never reaches either route
  const viaConsole = call(fx, { method: "POST", path: "/v1/sessions", cookie: s.cookie, csrf: s.csrf, body: {} });
  assert.equal(viaConsole.status, 401, viaConsole.body);

  // nothing was written by any of it
  const receipts = fx.db.prepare("SELECT count(*) c FROM runtime_receipts").get() as { c: number };
  assert.equal(receipts.c, 0);
  const claims = fx.db
    .prepare("SELECT count(*) c FROM assignment_observations WHERE observed_status IN ('loaded','invoked')")
    .get() as { c: number };
  assert.equal(claims.c, 0);
});

test("P4-FR-13: a receipt does not declare its own source", () => {
  const { fx, adapter } = ready();
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  const e = opened.json.entries[0];
  const declared = call(fx, {
    method: "POST",
    path: `/v1/sessions/${opened.json.session_id}/receipts`,
    key: adapter.key,
    body: {
      stage: "loaded",
      source: "runtime",
      runtime_session_ref: "r-1",
      revision_id: e.draft_revision_id,
      content_digest: e.content_digest,
    },
  });
  assert.equal(declared.status, 400, declared.body);
});

// ===========================================================================
// P4-FR-09 / P4-FR-10 / P4-FR-12 / P4-FR-19 — the receipt, and what it proves
// ===========================================================================

test("P4-FR-10/19: a receipt is refused unless it names a revision of THIS loadout and the digest that loadout froze", () => {
  const { fx, adapter } = ready();
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  const sid = opened.json.session_id;
  const e = opened.json.entries[0];

  // the right revision, the WRONG digest — a receipt that proves a NAME
  const wrongDigest = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sid}/receipts`,
    key: adapter.key,
    body: {
      stage: "loaded",
      runtime_session_ref: "r-1",
      revision_id: e.draft_revision_id,
      content_digest: `sha256:${"a".repeat(64)}`,
    },
  });
  assert.equal(wrongDigest.status, 412, wrongDigest.body);
  assert.ok(
    JSON.stringify(wrongDigest.json).includes("DIGEST_MISMATCH") || /digest/i.test(wrongDigest.json.error.message),
    `the refusal must name the digest mismatch: ${wrongDigest.body}`,
  );

  // a revision this session was never given
  const outside = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sid}/receipts`,
    key: adapter.key,
    body: {
      stage: "loaded",
      runtime_session_ref: "r-1",
      revision_id: TEST_OTHER_REVISION,
      content_digest: e.content_digest,
    },
  });
  assert.equal(outside.status, 412, outside.body);

  // an invocation with no load before it
  const early = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sid}/receipts`,
    key: adapter.key,
    body: {
      stage: "invoked",
      runtime_session_ref: "r-1",
      revision_id: e.draft_revision_id,
      content_digest: e.content_digest,
      invocation_ref: "r-1#1",
    },
  });
  assert.equal(early.status, 412, early.body);

  // an invocation that names no invocation
  const load = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sid}/receipts`,
    key: adapter.key,
    body: { stage: "loaded", runtime_session_ref: "r-1", revision_id: e.draft_revision_id, content_digest: e.content_digest },
  });
  assert.equal(load.status, 201, load.body);
  assert.equal(load.json.observed.status, "loaded");
  const noRef = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sid}/receipts`,
    key: adapter.key,
    body: { stage: "invoked", runtime_session_ref: "r-1", revision_id: e.draft_revision_id, content_digest: e.content_digest },
  });
  assert.equal(noRef.status, 400, noRef.body);

  // and the one that is right
  const invoked = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sid}/receipts`,
    key: adapter.key,
    body: {
      stage: "invoked",
      runtime_session_ref: "r-1",
      revision_id: e.draft_revision_id,
      content_digest: e.content_digest,
      invocation_ref: "r-1#skill",
    },
  });
  assert.equal(invoked.status, 201, invoked.body);
  assert.equal(invoked.json.observed.status, "invoked");
  assert.match(invoked.json.receipt_digest, /^sha256:[0-9a-f]{64}$/);
});

test("P4-FR-12/20: every stage carries a timestamp and provenance, and the chain is READ rather than assembled", () => {
  const { fx, s, adapter } = ready();
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  const sid = opened.json.session_id;
  const e = opened.json.entries[0];
  for (const body of [
    { stage: "loaded", runtime_session_ref: "r-7", revision_id: e.draft_revision_id, content_digest: e.content_digest, observed_at_ms: 1_700_000_000_000 },
    {
      stage: "invoked",
      runtime_session_ref: "r-7",
      revision_id: e.draft_revision_id,
      content_digest: e.content_digest,
      invocation_ref: "r-7#1",
      observed_at_ms: 1_700_000_005_000,
    },
  ]) {
    const filed = call(fx, { method: "POST", path: `/v1/sessions/${sid}/receipts`, key: adapter.key, body });
    assert.equal(filed.status, 201, filed.body);
  }

  const view = call(fx, { method: "GET", path: `/v1/console/sessions/${sid}`, cookie: s.cookie, csrf: s.csrf });
  assert.equal(view.status, 200, view.body);
  const entry = view.json.entries[0];
  assert.equal(entry.stage, "invoked");
  assert.deepEqual(
    entry.chain.map((c: any) => c.stage),
    ["proposed", "loaded", "invoked"],
    "the chain is in stage order",
  );
  for (const link of entry.chain) {
    assert.ok(typeof link.at_ms === "number" && link.at_ms > 0, "every stage has a structured timestamp");
    assert.ok(typeof link.source === "string" && link.source.length > 0, "every stage names its source");
  }
  assert.equal(entry.chain[0].receipt_id, null, "`proposed` is the backend's own act and has no runtime receipt");
  assert.ok(entry.chain[1].receipt_id, "`loaded` names the receipt behind it");
  assert.equal(entry.chain[1].at_ms, 1_700_000_000_000, "the reporter's own clock, not the registry's");
  assert.equal(entry.chain[2].invocation_ref, "r-7#1");
  assert.equal(view.json.receipts.length, 2);
  for (const r of view.json.receipts) {
    assert.match(r.receipt_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(r.content_digest, e.content_digest, "every receipt names the digest the loadout froze");
  }
});

// ===========================================================================
// P4-FR-11 / INV-03 — no receipt is `unknown`, never `loaded`
// ===========================================================================

test("P4-FR-11: with the receipt withheld the entry is `unknown` with all four INV-03 fields", () => {
  const { fx, s, adapter } = ready();
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  const view = call(fx, { method: "GET", path: `/v1/console/sessions/${opened.json.session_id}`, cookie: s.cookie, csrf: s.csrf });
  assert.equal(view.status, 200, view.body);
  const entry = view.json.entries[0];
  assert.equal(entry.stage, "unknown", "a proposed entry nobody confirmed is unknown, not loaded and not a quiet success");
  assert.equal(entry.reason_code, "NO_RUNTIME_RECEIPT");
  assert.ok(entry.reason.length > 20);
  assert.ok(entry.source.length > 0);
  assert.ok(entry.observed_at_ms > 0, "`observed_at_ms` is the moment of the look");
  // and the proposal is still in the chain as the fact it is
  assert.deepEqual(entry.chain.map((c: any) => c.stage), ["proposed"]);
});

// ===========================================================================
// P4-FR-05 / P4-FR-06 / P4-FR-07 / INV-01 — one model, two native mechanisms
// ===========================================================================

test("P4-FR-05/06: the SAME canonical revision renders into each runtime's own native layout", () => {
  const { fx, adapter } = ready();
  const base = mkdtempSync(join(tmpdir(), "skln-p4-"));
  try {
    const codex = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s1");
    const claude = openSession(fx, adapter.key, fx.reporter.agent_id, "claude_code", "s2");
    assert.equal(codex.status, 201, codex.body);
    assert.equal(claude.status, 201, claude.body);

    // ONE canonical model: same skill, same revision, same digest, two sessions
    assert.equal(codex.json.entries[0].draft_revision_id, claude.json.entries[0].draft_revision_id);
    assert.equal(codex.json.entries[0].content_digest, claude.json.entries[0].content_digest);

    const placed: Record<string, string> = {};
    for (const [kind, opened] of [["codex", codex], ["claude_code", claude]] as const) {
      const full = call(fx, { method: "GET", path: `/v1/sessions/${opened.json.session_id}/loadout`, key: adapter.key });
      const home = sessionHome(base, opened.json.session_id, kind);
      const entry = full.json.loadout.entries[0];
      const content = full.json.contents[0].content as DraftContent;
      const m = materializeEntry(home, entry, content);
      placed[kind] = readFileSync(join(home.root, m.relpath), "utf8");
      assert.ok(existsSync(join(home.root, m.relpath)));
      assert.equal(home.home, join(home.root, RUNTIMES[kind].home_subdir));
    }
    // each runtime's OWN layout, under its OWN home
    const codexSession = codex.json.session_id;
    const claudeSession = claude.json.session_id;
    assert.ok(existsSync(join(base, codexSession, ".agents", "skills")), "codex reads <CODEX_HOME>/skills");
    assert.ok(existsSync(join(base, claudeSession, ".claude", "skills")), "claude reads <CLAUDE_CONFIG_DIR>/skills");
    // and the BYTES are the same projection of the same revision
    assert.equal(placed.codex, placed.claude_code);
    assert.match(placed.codex!, /^---\nname: /);
    assert.ok(placed.codex!.includes(receiptMarkerLine(codex.json.entries[0].draft_revision_id, codex.json.entries[0].content_digest)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("P4-FR-07/INV-09: nothing the owner sent is a manifest, a package, a signature or a runtime config", () => {
  // The owner's whole vocabulary in this phase is the P3 console: assign,
  // activate, pause, revoke, select a revision. The adapter surfaces take an
  // agent id, a runtime kind and a version — and the loadout is composed by the
  // registry from its own rows. This asserts the shape of that: the request
  // that produces a materialized native file carries no file, no path and no
  // configuration.
  const { fx, adapter } = ready();
  const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
  assert.equal(opened.status, 201);
  const full = call(fx, { method: "GET", path: `/v1/sessions/${opened.json.session_id}/loadout`, key: adapter.key });
  const content = full.json.contents[0].content as DraftContent;
  const rendered = renderSkillMd(full.json.loadout.entries[0], content);
  // the rendered artifact is composed from the CANONICAL content
  assert.ok(rendered.includes(content.title));
  assert.ok(rendered.includes(content.procedure[0]!));
  assert.ok(!rendered.includes("SIGNATURE"), "no signature is authored, by anybody");
});

// ===========================================================================
// P4-FR-14 — path traversal, unsafe filenames and symlink escape
// ===========================================================================

const TEST_SESSION_ID = ulid(1_700_000_000_000);
const TEST_OTHER_REVISION = ulid(1_700_000_001_000);

const CONTENT: DraftContent = {
  title: "ship the thing",
  purpose: "Ship a reviewed change.",
  when_to_use: "Whenever a change is ready.",
  procedure: ["Read the diff.", "Run the suite.", "Merge it."],
  inputs: ["the branch"],
  outputs: ["a merged change"],
  permissions: ["write to the repository"],
  dependencies: ["git"],
  failure_modes: ["the suite is red"],
  redactions: [],
  redactions_total: 0,
  provenance: {} as DraftContent["provenance"],
};

function entryNamed(name: string) {
  return {
    entry_id: ulid(1_700_000_002_000),
    position: 1,
    assignment_id: ulid(1_700_000_003_000),
    draft_id: ulid(1_700_000_004_000),
    draft_revision_id: ulid(1_700_000_005_000),
    revision: 1,
    skill_name: name,
    content_digest: `sha256:${"b".repeat(64)}`,
  };
}

test("P4-FR-14: a traversing or unsafe native name is refused before anything is written", () => {
  const base = mkdtempSync(join(tmpdir(), "skln-p4-unsafe-"));
  try {
    const home = sessionHome(base, TEST_SESSION_ID, "codex");
    for (const bad of ["../escape", "a/b", "/absolute", "..", ".", "UPPER", "with space", "", "x".repeat(65)]) {
      assert.throws(
        () => materializeEntry(home, entryNamed(bad), CONTENT),
        ActivationError,
        `an unsafe native name must be refused: ${JSON.stringify(bad)}`,
      );
    }
    // and the name DERIVATION never produces one
    for (const title of ["../../etc/passwd", "  ", "///", "Ship: The Thing!!"]) {
      const name = nativeSkillName(title, ulid(1_700_000_007_000));
      assert.match(name, /^[a-z0-9][a-z0-9-]{0,63}$/, `derived from ${JSON.stringify(title)}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("P4-FR-14: a symbolic link planted in the native path cannot make a write land outside the session root", () => {
  const base = mkdtempSync(join(tmpdir(), "skln-p4-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "skln-p4-outside-"));
  try {
    const home = sessionHome(base, TEST_SESSION_ID, "codex");
    // the skills directory itself is a link out of the root
    const skills = join(home.home, "skills");
    mkdirSync(join(outside, "target"), { recursive: true });
    symlinkSync(join(outside, "target"), skills);
    assert.throws(() => materializeEntry(home, entryNamed("linked-skill"), CONTENT), ActivationError);
    assert.equal(existsSync(join(outside, "target", "linked-skill")), false, "nothing was written through the link");

    // and a link planted at the ENTRY FILE's own name is unlinked, not written through
    rmSync(skills);
    mkdirSync(join(skills, "entry-link"), { recursive: true });
    const decoy = join(outside, "decoy.md");
    writeFileSync(decoy, "untouched\n");
    symlinkSync(decoy, join(skills, "entry-link", "SKILL.md"));
    materializeEntry(home, entryNamed("entry-link"), CONTENT);
    assert.equal(readFileSync(decoy, "utf8"), "untouched\n", "the write did not follow the planted link");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ===========================================================================
// P4-FR-15 — no raw secret in a native artifact or a runtime log
// ===========================================================================

test("P4-FR-15: a rendered artifact carrying a credential shape is refused rather than written", () => {
  const base = mkdtempSync(join(tmpdir(), "skln-p4-secret-"));
  try {
    const home = sessionHome(base, TEST_SESSION_ID, "claude_code");
    const poisoned: DraftContent = {
      ...CONTENT,
      procedure: ["Read the diff.", `Export sk_${"A".repeat(24)} before running.`, "Merge it."],
    };
    assert.throws(() => materializeEntry(home, entryNamed("poisoned"), poisoned), /credential/i);
    assert.equal(
      existsSync(join(home.home, "skills", "poisoned", "SKILL.md")),
      false,
      "a refused artifact is not written and then reported: it is not written",
    );
    // the ordinary one goes through, and the scanner is not a mute button
    materializeEntry(home, entryNamed("clean"), CONTENT);
    assert.ok(existsSync(join(home.home, "skills", "clean", "SKILL.md")));
    assert.equal(credentialShapeIn(readFileSync(join(home.home, "skills", "clean", "SKILL.md"), "utf8")), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// P4-FR-08 — the derived artifacts are derived
// ===========================================================================

test("P4-FR-08: deleting every materialized file destroys no canonical data, and the next session rebuilds them", () => {
  const { fx, adapter } = ready();
  const base = mkdtempSync(join(tmpdir(), "skln-p4-cleanup-"));
  try {
    const opened = openSession(fx, adapter.key, fx.reporter.agent_id);
    const sid = opened.json.session_id;
    const full = call(fx, { method: "GET", path: `/v1/sessions/${sid}/loadout`, key: adapter.key });
    const home = sessionHome(base, sid, "codex");
    const m = materializeEntry(home, full.json.loadout.entries[0], full.json.contents[0].content);
    const path = join(home.root, m.relpath);
    assert.ok(existsSync(path));

    assert.equal(cleanupSession(base, sid), "removed");
    assert.equal(existsSync(join(base, sid)), false);
    assert.equal(cleanupSession(base, sid), "absent", "a second cleanup is an ordinary answer, not an error");

    // every canonical row is still there and answers as before
    const again = call(fx, { method: "GET", path: `/v1/sessions/${sid}/loadout`, key: adapter.key });
    assert.equal(again.status, 200, again.body);
    assert.deepEqual(again.json.loadout.entries, full.json.loadout.entries);

    // and the NEXT session rebuilds the same bytes from the same rows
    const next = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s2");
    const nextFull = call(fx, { method: "GET", path: `/v1/sessions/${next.json.session_id}/loadout`, key: adapter.key });
    const nextHome = sessionHome(base, next.json.session_id, "codex");
    const rebuilt = materializeEntry(nextHome, nextFull.json.loadout.entries[0], nextFull.json.contents[0].content);
    assert.equal(rebuilt.artifact_digest, m.artifact_digest, "the same revision renders to the same bytes");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// The receipt marker itself — the mechanism `P4-FR-19` rests on
// ===========================================================================

test("the receipt marker names a revision AND a digest, and a line missing either is not a receipt", () => {
  const rev = ulid(1_700_000_006_000);
  const digest = `sha256:${"c".repeat(64)}`;
  const parsed = parseReceiptMarker(`some words\n${receiptMarkerLine(rev, digest)}\nmore words`);
  assert.deepEqual(parsed, { revision_id: rev, content_digest: digest });
  assert.equal(parseReceiptMarker("I used the ship-the-thing skill."), null, "a NAME is not a receipt");
  assert.equal(parseReceiptMarker(`SKLN-RECEIPT revision=${rev}`), null, "a revision with no digest is not a receipt");
  assert.equal(parseReceiptMarker(`SKLN-RECEIPT digest=${digest}`), null, "a digest with no revision is not a receipt");
});
