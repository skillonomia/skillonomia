// V1 P5 — OUTCOMES AND THE REVISION LOOP, END TO END.
//
// One test per binary requirement, driven through the REAL router against a real
// database. The two integration tests at the foot walk the whole loop for each
// runtime kind — capture, approve, assign, open, load, invoke, outcome, new
// revision, approve, reassign, new session, compare, roll back — and they are
// SYNTHETIC in exactly one respect, stated here rather than left to be inferred:
// the runtime receipts are filed by a registered evidence principal in this
// process instead of by a real `codex` or `claude` binary. Contract section 10
// permits that for P5's automated tests and only there. The REAL runtime runs
// are `v1/tools/gates/runtime-codex.sh` and
// `v1/tools/gates/runtime-claude-code.sh`, which drive the actual binaries and
// file their outcomes from the runtimes' own output; neither this file nor those
// gates is dogfood, which is P6's job and cannot be manufactured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRest, type RestResponse } from "../src/http.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { p4Fixture, evidenceReporter, NOW, type P4Fixture } from "./p4-helpers.ts";
import { OUTCOMES, decideComparison } from "../src/outcome-loop.ts";

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

/** A clock that moves one second every time it is read. The frozen `NOW` every
 *  other suite uses cannot tell a session opened BEFORE a rollback from one
 *  opened after it, and `P5-FR-13` is exactly that distinction. */
function ticking(): () => number {
  let t = NOW;
  return () => (t += 1000);
}

function ready(title = "ship the thing", clock?: () => number) {
  const fx = p4Fixture(clock ? { clock } : {});
  const s = signIn(fx);
  const draft = approvedDraft(fx, s, "k1", title);
  const assignmentId = activeAssignment(fx, s, draft.revision_id, "k1");
  const adapter = evidenceReporter(fx, "adapter");
  return { fx, s, draft, assignmentId, adapter };
}

function openSession(fx: P4Fixture, adapterKey: string, agentId: string, kind = "codex", key = "s1") {
  const opened = call(fx, {
    method: "POST",
    path: "/v1/sessions",
    key: adapterKey,
    body: { agent_id: agentId, runtime_kind: kind, runtime_version: "0.146.0", idempotency_key: key },
  });
  assert.equal(opened.status, 201, opened.body);
  return opened.json;
}

/** `loaded` then `invoked`, exactly as P4 requires them, and nothing more. */
function loadAndInvoke(
  fx: P4Fixture,
  adapterKey: string,
  sessionId: string,
  entry: { draft_revision_id: string; content_digest: string },
  key: string,
  refs = { runtime: "rt-session-1", invocation: "call-1" },
) {
  const loaded = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sessionId}/receipts`,
    key: adapterKey,
    body: {
      stage: "loaded",
      runtime_session_ref: refs.runtime,
      revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      idempotency_key: `ld-${key}`,
    },
  });
  assert.equal(loaded.status, 201, loaded.body);
  const invoked = call(fx, {
    method: "POST",
    path: `/v1/sessions/${sessionId}/receipts`,
    key: adapterKey,
    body: {
      stage: "invoked",
      runtime_session_ref: refs.runtime,
      revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      invocation_ref: refs.invocation,
      idempotency_key: `iv-${key}`,
    },
  });
  assert.equal(invoked.status, 201, invoked.body);
  return { loaded: loaded.json, invoked: invoked.json };
}

function fileOutcome(
  fx: P4Fixture,
  adapterKey: string,
  sessionId: string,
  entry: { draft_revision_id: string; content_digest: string },
  body: Record<string, unknown>,
) {
  return call(fx, {
    method: "POST",
    path: `/v1/sessions/${sessionId}/outcomes`,
    key: adapterKey,
    body: {
      revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      runtime_session_ref: "rt-session-1",
      invocation_ref: "call-1",
      ...body,
    },
  });
}

function sessionView(fx: P4Fixture, s: { cookie: string; csrf: string }, sessionId: string) {
  const res = call(fx, { path: `/v1/console/sessions/${sessionId}`, cookie: s.cookie, csrf: s.csrf });
  assert.equal(res.status, 200, res.body);
  return res.json;
}

// ===========================================================================
// P5-FR-01 — exactly four normalised outcomes
// ===========================================================================

test("P5-FR-01: the vocabulary is exactly four values, in the code and in the database", () => {
  assert.deepEqual([...OUTCOMES], ["worked", "failed", "rolled_back", "nothing_reported"]);

  const { fx, adapter, draft } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "v");

  // a fifth value is refused by the request validator before anything is written
  const bogus = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "probably_fine",
    outcome_ref: "o-1",
    reason_code: "X_Y",
    reason: "an invented outcome",
  });
  assert.equal(bogus.status, 400, bogus.body);

  // …and by the database, if anything ever got past the validator
  assert.throws(
    () =>
      fx.db
        .prepare(
          `INSERT INTO session_outcomes(id, session_id, loadout_id, loadout_entry_id, assignment_id, draft_id,
             draft_revision_id, content_digest, outcome, evidence_class, outcome_ref, reason_code, reason, source,
             reported_by_agent_id, outcome_digest, payload_json, observed_at_ms, server_at_ms)
           VALUES ('01J000000000000000000000X',?,?,?,?,?,?,?,'probably_fine','runtime_receipt','x','X_Y','x','runtime',?,?,'{}',1,1)`,
        )
        .run(
          lo.session_id,
          lo.loadout_id,
          entry.entry_id,
          entry.assignment_id,
          draft.draft_id,
          entry.draft_revision_id,
          entry.content_digest,
          fx.reporter.agent_id,
          `sha256:${"0".repeat(64)}`,
        ),
    /CHECK|constraint/i,
    "the outcome vocabulary is a CHECK, not a convention",
  );
});

// ===========================================================================
// P5-FR-02 — `worked` is never derived from `proposed` or `loaded`
// ===========================================================================

test("P5-FR-02: an entry that is only loaded cannot become worked, and a proposed one cannot either", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];

  // PROPOSED only: no receipt at all
  let refused = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "worked",
    outcome_ref: "o-1",
    reason_code: "IT_HELPED",
    reason: "the change shipped",
  });
  assert.equal(refused.status, 412, refused.body);
  assert.equal(refused.json.error.current_state, "NO_INVOCATION_EVIDENCE");

  // LOADED only: the runtime read it and never called it
  const loaded = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo.session_id}/receipts`,
    key: adapter.key,
    body: {
      stage: "loaded",
      runtime_session_ref: "rt-session-1",
      revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      idempotency_key: "ld-only",
    },
  });
  assert.equal(loaded.status, 201, loaded.body);

  refused = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "worked",
    outcome_ref: "o-2",
    reason_code: "IT_HELPED",
    reason: "the change shipped",
  });
  assert.equal(refused.status, 412, refused.body);
  assert.equal(refused.json.error.current_state, "NO_INVOCATION_EVIDENCE");

  // and nothing was written by either refusal
  assert.equal((fx.db.prepare("SELECT count(*) c FROM session_outcomes").get() as { c: number }).c, 0);

  // the view reports the STAGE it reached and `unknown` for the outcome —
  // never `worked`, and never a blank the reader has to interpret
  const view = sessionView(fx, s, lo.session_id);
  assert.equal(view.entries[0].stage, "loaded");
  assert.equal(view.outcomes[0].outcome, "unknown");
  for (const field of ["reason_code", "reason", "source", "observed_at_ms"]) {
    assert.ok(view.outcomes[0][field] !== undefined && view.outcomes[0][field] !== null, `an unknown carries ${field}`);
  }

  // an invocation whose refs do NOT match the receipt is refused for the same reason
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "m", { runtime: "rt-session-1", invocation: "call-1" });
  const mismatched = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo.session_id}/outcomes`,
    key: adapter.key,
    body: {
      outcome: "worked",
      outcome_ref: "o-3",
      revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      runtime_session_ref: "rt-session-1",
      invocation_ref: "a-call-nobody-filed",
      reason_code: "IT_HELPED",
      reason: "the change shipped",
    },
  });
  assert.equal(mismatched.status, 412, mismatched.body);
});

test("P5-FR-02: an owner confirmation is the other way to worked, and it says so in every field", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];

  // a confirmation with no source is refused: `P5-FR-02` says "carries its source"
  const sourceless = call(fx, {
    method: "POST",
    path: "/v1/console/outcomes",
    cookie: s.cookie,
    csrf: s.csrf,
    body: {
      session_id: lo.session_id,
      entry_id: entry.entry_id,
      outcome: "worked",
      outcome_ref: "own-1",
      reason_code: "OWNER_SAW_IT",
      reason: "I watched it run",
      idempotency_key: "oc-0",
    },
  });
  assert.equal(sourceless.status, 400, sourceless.body);

  const confirmed = call(fx, {
    method: "POST",
    path: "/v1/console/outcomes",
    cookie: s.cookie,
    csrf: s.csrf,
    body: {
      session_id: lo.session_id,
      entry_id: entry.entry_id,
      outcome: "worked",
      outcome_ref: "own-1",
      confirmation_source: "the owner watched the run in the terminal",
      reason_code: "OWNER_SAW_IT",
      reason: "the change shipped and the owner saw it",
      idempotency_key: "oc-1",
    },
  });
  assert.equal(confirmed.status, 201, confirmed.body);
  assert.equal(confirmed.json.outcome, "worked");
  assert.equal(confirmed.json.evidence_class, "owner_confirmation");

  const row = fx.db.prepare("SELECT * FROM session_outcomes WHERE id=?").get(confirmed.json.outcome_id) as any;
  assert.equal(row.source, "owner");
  assert.equal(row.confirmation_source, "the owner watched the run in the terminal");
  assert.equal(row.invocation_receipt_id, null);

  // `INV-02` and `P4-FR-13`: the owner's word did NOT become a stage.
  const view = sessionView(fx, s, lo.session_id);
  assert.equal(view.entries[0].stage, "unknown", "an owner confirmation is not a runtime load");
  assert.equal(view.outcomes[0].outcome, "worked");
  assert.equal(view.outcomes[0].evidence_class, "owner_confirmation");
  assert.equal(
    (fx.db.prepare("SELECT count(*) c FROM assignment_observations WHERE source='owner'").get() as { c: number }).c,
    0,
    "no observation carries an owner source, on any surface",
  );
  assert.equal((fx.db.prepare("SELECT count(*) c FROM runtime_receipts").get() as { c: number }).c, 0);
});

// ===========================================================================
// P5-FR-03 — `failed` carries a structured reason and provenance
// ===========================================================================

test("P5-FR-03: a failure carries a machine-readable reason, a reason and the receipt it rests on", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  const { invoked } = loadAndInvoke(fx, adapter.key, lo.session_id, entry, "f");

  const noCode = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "failed",
    outcome_ref: "o-1",
    reason_code: "not upper snake",
    reason: "it broke",
  });
  assert.equal(noCode.status, 400, noCode.body);

  const failed = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "failed",
    outcome_ref: "o-1",
    reason_code: "STEP_2_WRONG_BRANCH",
    reason: "the procedure merged into the wrong branch",
    transcript_excerpt: "merged into main instead of the release branch",
  });
  assert.equal(failed.status, 201, failed.body);

  const row = fx.db.prepare("SELECT * FROM session_outcomes WHERE id=?").get(failed.json.outcome_id) as any;
  assert.equal(row.reason_code, "STEP_2_WRONG_BRANCH");
  assert.equal(row.source, "adapter");
  assert.equal(row.invocation_receipt_id, invoked.receipt_id, "the failure names the invocation it is the outcome of");
  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.runtime_kind, "codex");
  assert.equal(payload.transcript_excerpt, "merged into main instead of the release branch");

  const view = sessionView(fx, s, lo.session_id);
  assert.equal(view.outcomes[0].outcome, "failed");
  assert.equal(view.outcomes[0].history.length, 1);
});

// ===========================================================================
// P5-FR-04 — a session that ends with no report is `nothing_reported`
// ===========================================================================

test("P5-FR-04: closing a session with nothing reported yields nothing_reported, even for an INVOKED entry", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "n");

  const closed = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo.session_id}/close`,
    key: adapter.key,
    body: { reason: "the runtime exited", idempotency_key: "cl-1" },
  });
  assert.equal(closed.status, 201, closed.body);
  assert.equal(closed.json.nothing_reported.length, 1);
  assert.equal(closed.json.already_closed, false);

  const view = sessionView(fx, s, lo.session_id);
  assert.equal(view.entries[0].stage, "invoked", "the stage is what the receipts made it");
  assert.equal(view.outcomes[0].outcome, "nothing_reported", "and an invoked entry with no report is NOT a success");
  assert.equal(view.outcomes[0].evidence_class, "session_closed");
  assert.equal(view.outcomes[0].source, "backend");
  assert.ok(view.closure && view.closure.closed_at_ms > 0);

  // closing twice is one closure
  const again = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo.session_id}/close`,
    key: adapter.key,
    body: { reason: "the runtime exited", idempotency_key: "cl-2" },
  });
  assert.equal(again.status, 201, again.body);
  assert.equal(again.json.already_closed, true);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM session_closures").get() as { c: number }).c, 1);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM session_outcomes").get() as { c: number }).c, 1);

  // and a late outcome is refused rather than rewriting what was recorded
  const late = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "worked",
    outcome_ref: "o-late",
    reason_code: "LATE",
    reason: "it worked after all",
  });
  assert.equal(late.status, 409, late.body);
});

test("P5-FR-04: an entry that DID report keeps its outcome when the session closes", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "k");
  const filed = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "worked",
    outcome_ref: "o-1",
    reason_code: "SHIPPED",
    reason: "the change shipped",
  });
  assert.equal(filed.status, 201, filed.body);

  const closed = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo.session_id}/close`,
    key: adapter.key,
    body: { idempotency_key: "cl-1" },
  });
  assert.equal(closed.status, 201, closed.body);
  assert.deepEqual(closed.json.nothing_reported, []);
  const view = sessionView(fx, s, lo.session_id);
  assert.equal(view.outcomes[0].outcome, "worked");
});

// ===========================================================================
// P5-FR-06 / P5-FR-07 — replay and conflict
// ===========================================================================

test("P5-FR-06: redelivering one outcome is idempotent — one row, the same digest, replayed:true", () => {
  const { fx, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "r");

  const body = {
    outcome: "worked",
    outcome_ref: "runtime-outcome-7",
    reason_code: "SHIPPED",
    reason: "the change shipped",
    observed_at_ms: 1_700_000_000_000,
  };
  const first = fileOutcome(fx, adapter.key, lo.session_id, entry, body);
  assert.equal(first.status, 201, first.body);
  assert.equal(first.json.replayed, false);

  // the SAME delivery again, with no idempotency key at all: the replay key is
  // the reporter's own `outcome_ref`, which is what a redelivery carries
  const second = fileOutcome(fx, adapter.key, lo.session_id, entry, body);
  assert.equal(second.status, 201, second.body);
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.outcome_id, first.json.outcome_id);
  assert.equal(second.json.outcome_digest, first.json.outcome_digest);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM session_outcomes").get() as { c: number }).c, 1);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM outcome_conflicts").get() as { c: number }).c, 0);
});

test("P5-FR-07: a conflicting redelivery does not overwrite — the first stands and the conflict is its own evidence", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "c");

  const first = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "failed",
    outcome_ref: "runtime-outcome-9",
    reason_code: "WRONG_BRANCH",
    reason: "it merged into the wrong branch",
    observed_at_ms: 1_700_000_000_000,
  });
  assert.equal(first.status, 201, first.body);

  const contradicting = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "worked",
    outcome_ref: "runtime-outcome-9",
    reason_code: "SHIPPED",
    reason: "actually it was fine",
    observed_at_ms: 1_700_000_000_000,
  });
  assert.equal(contradicting.status, 409, contradicting.body);
  const conflict = JSON.parse(contradicting.json.error.current_state);
  assert.equal(conflict.existing_outcome, "failed");
  assert.equal(conflict.claimed_outcome, "worked");
  assert.equal(conflict.existing_outcome_id, first.json.outcome_id);
  assert.match(conflict.conflict_digest, /^sha256:[0-9a-f]{64}$/);

  // the predecessor is untouched, and the contradiction is a row of its own
  const stored = fx.db.prepare("SELECT * FROM session_outcomes WHERE id=?").get(first.json.outcome_id) as any;
  assert.equal(stored.outcome, "failed");
  assert.equal(stored.outcome_digest, first.json.outcome_digest);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM session_outcomes").get() as { c: number }).c, 1);
  const rows = fx.db.prepare("SELECT * FROM outcome_conflicts").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].claimed_payload_json).reason_code, "SHIPPED");

  // and the owner SEES it, in structured fields
  const view = sessionView(fx, s, lo.session_id);
  assert.equal(view.outcomes[0].outcome, "failed");
  assert.equal(view.outcomes[0].conflicts.length, 1);
  assert.equal(view.outcomes[0].conflicts[0].claimed_outcome, "worked");
});

// ===========================================================================
// P5-FR-08 / P5-FR-09 — a failure becomes a new revision, reviewed like any other
// ===========================================================================

function failedOutcome(title = "ship the thing", clock?: () => number) {
  const { fx, s, draft, assignmentId, adapter } = ready(title, clock);
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  const { invoked } = loadAndInvoke(fx, adapter.key, lo.session_id, entry, "x");
  const failed = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "failed",
    outcome_ref: "o-fail-1",
    reason_code: "STEP_2_WRONG_BRANCH",
    reason: "the procedure merged into the wrong branch",
  });
  assert.equal(failed.status, 201, failed.body);
  return { fx, s, draft, assignmentId, adapter, lo, entry, invoked, outcomeId: failed.json.outcome_id as string };
}

function revisionFromFailure(
  fx: P4Fixture,
  s: { cookie: string; csrf: string },
  outcomeId: string,
  key = "rev-1",
  goal = "the same scenario reports worked instead of failing on step 2",
) {
  return call(fx, {
    method: "POST",
    path: `/v1/console/outcomes/${outcomeId}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: {
      origin: "failure",
      observation: "step 2 merged into the wrong branch",
      improvement_goal: goal,
      goal_kind: "failure_to_worked",
      revision: { text: workflow("ship the thing", "Run the suite, then check the branch is the release branch.") },
      idempotency_key: key,
    },
  });
}

test("P5-FR-08/09: a failure creates a new draft revision carrying its parent and its source receipt, and it faces the same review", () => {
  const { fx, s, draft, outcomeId, invoked, entry } = failedOutcome();

  const created = revisionFromFailure(fx, s, outcomeId);
  assert.equal(created.status, 201, created.body);
  assert.equal(created.json.parent_revision_id, entry.draft_revision_id);
  assert.equal(created.json.source_outcome_id, outcomeId);
  assert.equal(created.json.source_receipt_id, invoked.receipt_id, "the lineage names the receipt behind the failure");
  assert.equal(created.json.origin, "failure");
  assert.equal(created.json.revision.revision, 2, "a new revision, never an edit of the old one");
  assert.notEqual(created.json.revision.revision_id, entry.draft_revision_id);

  // `INV-06`: the parent revision is byte-identical to what it was
  const parent = fx.db.prepare("SELECT * FROM draft_revisions WHERE id=?").get(entry.draft_revision_id) as any;
  assert.equal(parent.content_digest, entry.content_digest);

  // `P5-FR-09`: the SAME previews ran, and the new revision is NOT approved
  assert.ok(created.json.revision.semantic_review, "the semantic preview ran on the new revision");
  assert.ok(created.json.revision.security_review, "the security preview ran on the new revision");
  assert.equal(
    (fx.db.prepare("SELECT count(*) c FROM revision_approvals WHERE draft_revision_id=?").get(created.json.revision.revision_id) as { c: number }).c,
    0,
    "a revision from a failure is not approved by being created",
  );

  // …and it cannot be assigned until an owner approves it, which is P3's rule
  // applying unchanged to a revision this phase produced
  const premature = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: fx.reporter.agent_id, revision_id: created.json.revision.revision_id, idempotency_key: "asg-early" },
  });
  assert.equal(premature.status, 412, premature.body);

  const approved = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: created.json.revision.revision_id, idempotency_key: "app-2" },
  });
  assert.equal(approved.status, 201, approved.body);
});

test("P5-FR-08: a revision `from a failure` is refused when the outcome is not one", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "w");
  const worked = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "worked",
    outcome_ref: "o-1",
    reason_code: "SHIPPED",
    reason: "the change shipped",
  });
  assert.equal(worked.status, 201, worked.body);

  const refused = revisionFromFailure(fx, s, worked.json.outcome_id);
  assert.equal(refused.status, 412, refused.body);
  assert.equal(refused.json.error.current_state, "worked");
});

// ===========================================================================
// P5-FR-10 / P5-FR-11 / P5-FR-12 — reassign, new session, comparison
// ===========================================================================

test("P5-FR-10/11/12: approve → reassign → new session → the comparison the backend computes", () => {
  const { fx, s, draft, assignmentId, adapter, lo, entry, outcomeId } = failedOutcome();

  const created = revisionFromFailure(fx, s, outcomeId);
  assert.equal(created.status, 201, created.body);
  const v2 = created.json.revision.revision_id as string;

  const approved = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: v2, idempotency_key: "app-2" },
  });
  assert.equal(approved.status, 201, approved.body);

  // `P5-FR-10`: the reassignment applies to the NEXT session
  const selected = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${assignmentId}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: v2, reason: "the fix for step 2", idempotency_key: "sel-2" },
  });
  assert.equal(selected.status, 200, selected.body);
  assert.equal(selected.json.effective_from, "next_session");

  // the RUNNING session is byte-for-byte what it was
  const stillFirst = sessionView(fx, s, lo.session_id);
  assert.equal(stillFirst.loadout.entries[0].draft_revision_id, entry.draft_revision_id);
  assert.equal(stillFirst.loadout.loadout_digest, lo.loadout_digest);

  // the NEXT session carries the new revision
  const lo2 = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s2");
  const entry2 = lo2.entries[0];
  assert.equal(entry2.draft_revision_id, v2);
  assert.equal(entry2.revision, 2);
  loadAndInvoke(fx, adapter.key, lo2.session_id, entry2, "y", { runtime: "rt-session-2", invocation: "call-2" });
  const worked = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo2.session_id}/outcomes`,
    key: adapter.key,
    body: {
      outcome: "worked",
      outcome_ref: "o-work-1",
      revision_id: entry2.draft_revision_id,
      content_digest: entry2.content_digest,
      runtime_session_ref: "rt-session-2",
      invocation_ref: "call-2",
      reason_code: "MERGED_TO_RELEASE",
      reason: "it checked the branch and merged into the release branch",
    },
  });
  assert.equal(worked.status, 201, worked.body);

  // `P5-FR-11`: the comparison names both exact revisions, the original
  // observation and the new outcome
  const compared = call(fx, {
    method: "POST",
    path: "/v1/console/comparisons",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { baseline_outcome_id: outcomeId, candidate_outcome_id: worked.json.outcome_id, idempotency_key: "cmp-1" },
  });
  assert.equal(compared.status, 201, compared.body);
  const c = compared.json;
  assert.equal(c.baseline.revision_id, entry.draft_revision_id);
  assert.equal(c.baseline.revision, 1);
  assert.equal(c.baseline.outcome, "failed");
  assert.equal(c.baseline.reason_code, "STEP_2_WRONG_BRANCH");
  assert.equal(c.candidate.revision_id, v2);
  assert.equal(c.candidate.revision, 2);
  assert.equal(c.candidate.outcome, "worked");
  assert.equal(c.comparable, true);
  assert.equal(c.verdict, "improved");
  assert.equal(c.verdict_reason_code, "FAILURE_TO_WORKED");
  assert.equal(c.improvement_goal, "the same scenario reports worked instead of failing on step 2");

  // the history view carries all of it, in columns
  const history = call(fx, {
    path: `/v1/console/capabilities/${draft.draft_id}/outcomes`,
    cookie: s.cookie,
    csrf: s.csrf,
  });
  assert.equal(history.status, 200, history.body);
  assert.equal(history.json.outcomes.length, 2);
  assert.equal(history.json.lineage.length, 1);
  assert.equal(history.json.comparisons.length, 1);
  assert.equal(history.json.comparisons[0].verdict, "improved");
  assert.equal(history.json.lineage[0].observation, "step 2 merged into the wrong branch");
});

test("P5-FR-12: an improvement needs a comparable scenario and a proved transition — the verdict is computed, never supplied", () => {
  // the four shapes, decided from rows alone
  const base = { outcome: "failed" as const, agent_id: "A", runtime_kind: "codex", draft_id: "D" };
  assert.equal(decideComparison({ baseline: base, candidate: { ...base, outcome: "worked" }, goal_kind: "failure_to_worked" }).verdict, "improved");
  assert.equal(decideComparison({ baseline: base, candidate: { ...base, outcome: "failed" }, goal_kind: "failure_to_worked" }).verdict, "not_improved");
  assert.equal(
    decideComparison({ baseline: base, candidate: { ...base, outcome: "worked", agent_id: "B" }, goal_kind: "failure_to_worked" }).verdict,
    "not_comparable",
  );
  assert.equal(
    decideComparison({ baseline: base, candidate: { ...base, outcome: "worked", runtime_kind: "claude_code" }, goal_kind: "failure_to_worked" }).verdict,
    "not_comparable",
  );
  assert.equal(
    decideComparison({ baseline: { ...base, outcome: "nothing_reported" }, candidate: { ...base, outcome: "worked" }, goal_kind: "failure_to_worked" }).verdict,
    "not_improved",
    "there is no failure for this to be an improvement on",
  );

  // and a caller cannot name one: a comparison against a candidate with no
  // lineage row — no goal stated in advance — is refused outright
  const { fx, s, adapter, outcomeId } = failedOutcome();
  const lo2 = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s2");
  const entry2 = lo2.entries[0];
  loadAndInvoke(fx, adapter.key, lo2.session_id, entry2, "z", { runtime: "rt-2", invocation: "call-2" });
  const same = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo2.session_id}/outcomes`,
    key: adapter.key,
    body: {
      outcome: "worked",
      outcome_ref: "o-2",
      revision_id: entry2.draft_revision_id,
      content_digest: entry2.content_digest,
      runtime_session_ref: "rt-2",
      invocation_ref: "call-2",
      reason_code: "SHIPPED",
      reason: "it worked this time",
    },
  });
  assert.equal(same.status, 201, same.body);
  const refused = call(fx, {
    method: "POST",
    path: "/v1/console/comparisons",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { baseline_outcome_id: outcomeId, candidate_outcome_id: same.json.outcome_id, idempotency_key: "cmp-x" },
  });
  assert.equal(refused.status, 412, refused.body);
  assert.equal(refused.json.error.current_state, "NO_REVISION_SOURCE");
});

// ===========================================================================
// P5-FR-05 / P5-FR-13 — rollback, confirmed by a NEW session, history intact
// ===========================================================================

test("P5-FR-05/13: a rollback selects a previously approved revision and is confirmed by a NEW session at that exact version", () => {
  const { fx, s, draft, assignmentId, adapter, lo, entry, outcomeId } = failedOutcome("ship the thing", ticking());
  const v1 = entry.draft_revision_id as string;

  const created = revisionFromFailure(fx, s, outcomeId);
  const v2 = created.json.revision.revision_id as string;
  call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: v2, idempotency_key: "app-2" },
  });
  const toV2 = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${assignmentId}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: v2, idempotency_key: "sel-2" },
  });
  assert.equal(toV2.status, 200, toV2.body);

  // the second session runs v2 and it fails too
  const lo2 = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s2");
  const entry2 = lo2.entries[0];
  assert.equal(entry2.draft_revision_id, v2);
  loadAndInvoke(fx, adapter.key, lo2.session_id, entry2, "q", { runtime: "rt-2", invocation: "call-2" });
  const failedAgain = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo2.session_id}/outcomes`,
    key: adapter.key,
    body: {
      outcome: "failed",
      outcome_ref: "o-fail-2",
      revision_id: v2,
      content_digest: entry2.content_digest,
      runtime_session_ref: "rt-2",
      invocation_ref: "call-2",
      reason_code: "WORSE",
      reason: "the new step broke the ordinary case",
    },
  });
  assert.equal(failedAgain.status, 201, failedAgain.body);

  // ROLL BACK to v1 — a previously approved revision, and nothing is deleted
  const rolled = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${assignmentId}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: v1, reason: "v2 is worse", idempotency_key: "sel-back" },
  });
  assert.equal(rolled.status, 200, rolled.body);
  assert.equal(rolled.json.effective_from, "next_session");
  const rollbackEvent = rolled.json.event_id ?? rolled.json.assignment?.desired?.event_id;
  const eventRow = fx.db
    .prepare("SELECT id FROM skill_assignment_events WHERE assignment_id=? AND event='revision_selected' AND desired_revision_id=? ORDER BY event_seq DESC LIMIT 1")
    .get(assignmentId, v1) as { id: string };
  assert.ok(eventRow, "the rollback is a lifecycle event of its own");
  if (rollbackEvent) assert.equal(rollbackEvent, eventRow.id);

  // both revisions still exist and both approvals stand
  assert.equal((fx.db.prepare("SELECT count(*) c FROM draft_revisions WHERE draft_id=?").get(draft.draft_id) as { c: number }).c, 2);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM revision_approvals WHERE draft_id=?").get(draft.draft_id) as { c: number }).c, 2);

  // a NEW session carries v1 at its exact version, and confirms the rollback
  const lo3 = openSession(fx, adapter.key, fx.reporter.agent_id, "codex", "s3");
  const entry3 = lo3.entries[0];
  assert.equal(entry3.draft_revision_id, v1);
  assert.equal(entry3.content_digest, entry.content_digest, "the exact bytes v1 always had");

  const confirmed = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo3.session_id}/rollback-confirmations`,
    key: adapter.key,
    body: { entry_id: entry3.entry_id, rollback_action_event_id: eventRow.id, idempotency_key: "rb-1" },
  });
  assert.equal(confirmed.status, 201, confirmed.body);
  assert.equal(confirmed.json.outcome, "rolled_back");
  const row = fx.db.prepare("SELECT * FROM session_outcomes WHERE id=?").get(confirmed.json.outcome_id) as any;
  assert.equal(row.rollback_to_revision_id, v1);
  assert.equal(row.rollback_action_event_id, eventRow.id);

  // `P5-FR-05`: the outcome that came before is NOT rewritten
  const before = fx.db.prepare("SELECT * FROM session_outcomes WHERE id=?").get(failedAgain.json.outcome_id) as any;
  assert.equal(before.outcome, "failed");
  assert.equal(before.reason_code, "WORSE");
  const history = call(fx, {
    path: `/v1/console/capabilities/${draft.draft_id}/outcomes`,
    cookie: s.cookie,
    csrf: s.csrf,
  });
  assert.deepEqual(
    history.json.outcomes.map((o: any) => o.outcome),
    ["failed", "failed", "rolled_back"],
    "every outcome is still there, in the order it happened",
  );

  // …and a rollback cannot be confirmed by the session that PREDATES it
  const backwards = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo.session_id}/rollback-confirmations`,
    key: adapter.key,
    body: { entry_id: entry.entry_id, rollback_action_event_id: eventRow.id, idempotency_key: "rb-2" },
  });
  assert.equal(backwards.status, 412, backwards.body);
  assert.equal(backwards.json.error.current_state, "SESSION_PREDATES_ROLLBACK");
});

// ===========================================================================
// P5-FR-14 — the owner surface is structured contracts
// ===========================================================================

test("P5-FR-14: every outcome answer announces its contract version before a field is read", () => {
  const { fx, s, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "v14");
  const filed = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "worked",
    outcome_ref: "o-1",
    reason_code: "SHIPPED",
    reason: "the change shipped",
  });
  assert.equal(filed.json.contract, "outcome.v1");

  const view = sessionView(fx, s, lo.session_id);
  assert.equal(view.contract, "console.v1");
  const history = call(fx, { path: `/v1/console/capabilities/${lo.entries[0].draft_id}/outcomes`, cookie: s.cookie, csrf: s.csrf });
  assert.equal(history.json.contract, "console.v1");
});

// ===========================================================================
// INV-02 / P4-FR-13 — the boundary P3 and P4 built is not widened by P5
// ===========================================================================

test("INV-02: an owner or admin credential cannot file an outcome, close a session or confirm a rollback", () => {
  const { fx, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "b");

  for (const key of [fx.keys.owner!, fx.keys.admin!]) {
    for (const path of [
      `/v1/sessions/${lo.session_id}/outcomes`,
      `/v1/sessions/${lo.session_id}/close`,
      `/v1/sessions/${lo.session_id}/rollback-confirmations`,
    ]) {
      const res = call(fx, { method: "POST", path, key, body: { not: "even read" } });
      assert.equal(res.status, 403, `${path} with an owner or admin key: ${res.body}`);
    }
  }
  // a member with no evidence registration is refused too
  const res = call(fx, {
    method: "POST",
    path: `/v1/sessions/${lo.session_id}/outcomes`,
    key: fx.keys.member!,
    body: { outcome: "worked", outcome_ref: "o", reason_code: "X_Y", reason: "x", revision_id: entry.draft_revision_id, content_digest: entry.content_digest, runtime_session_ref: "r", invocation_ref: "call-1" },
  });
  assert.equal(res.status, 403, res.body);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM session_outcomes").get() as { c: number }).c, 0);
  assert.equal((fx.db.prepare("SELECT count(*) c FROM session_closures").get() as { c: number }).c, 0);
});

test("INV-06: every table this phase adds is INSERT-only in the database", () => {
  const { fx, adapter } = ready();
  const lo = openSession(fx, adapter.key, fx.reporter.agent_id);
  const entry = lo.entries[0];
  loadAndInvoke(fx, adapter.key, lo.session_id, entry, "i");
  const filed = fileOutcome(fx, adapter.key, lo.session_id, entry, {
    outcome: "failed",
    outcome_ref: "o-1",
    reason_code: "BROKE",
    reason: "it broke",
  });
  assert.equal(filed.status, 201, filed.body);
  call(fx, { method: "POST", path: `/v1/sessions/${lo.session_id}/close`, key: adapter.key, body: { idempotency_key: "cl" } });

  for (const sql of [
    "UPDATE session_outcomes SET outcome='worked'",
    "DELETE FROM session_outcomes",
    "UPDATE session_closures SET reason='x'",
    "DELETE FROM session_closures",
  ]) {
    assert.throws(() => fx.db.prepare(sql).run(), /INSERT_ONLY/, sql);
  }
  const still = fx.db.prepare("SELECT outcome FROM session_outcomes WHERE id=?").get(filed.json.outcome_id) as any;
  assert.equal(still.outcome, "failed");
});

// ===========================================================================
// P5-FR-15 — the whole loop, once per runtime kind
// ===========================================================================

for (const runtime of ["codex", "claude_code"] as const) {
  test(`P5-FR-15: the full loop runs end to end on ${runtime} (SYNTHETIC receipts — the real runs are the two runtime gates)`, () => {
    const fx = p4Fixture();
    const s = signIn(fx);
    const adapter = evidenceReporter(fx, "adapter");
    const draft = approvedDraft(fx, s, `loop-${runtime}`, `close the loop on ${runtime.replace("_", " ")}`);
    const assignmentId = activeAssignment(fx, s, draft.revision_id, `loop-${runtime}`);

    // 1. a session, and the revision it froze
    const lo1 = openSession(fx, adapter.key, fx.reporter.agent_id, runtime, `l1-${runtime}`);
    const e1 = lo1.entries[0];
    assert.equal(lo1.runtime_kind, runtime);
    assert.equal(e1.draft_revision_id, draft.revision_id);

    // 2. loaded, invoked — and it FAILED
    loadAndInvoke(fx, adapter.key, lo1.session_id, e1, `l1-${runtime}`, { runtime: `${runtime}-rt-1`, invocation: "call-1" });
    const failed = call(fx, {
      method: "POST",
      path: `/v1/sessions/${lo1.session_id}/outcomes`,
      key: adapter.key,
      body: {
        outcome: "failed",
        outcome_ref: `${runtime}-o-1`,
        revision_id: e1.draft_revision_id,
        content_digest: e1.content_digest,
        runtime_session_ref: `${runtime}-rt-1`,
        invocation_ref: "call-1",
        reason_code: "STEP_2_WRONG_BRANCH",
        reason: "it merged into the wrong branch",
      },
    });
    assert.equal(failed.status, 201, failed.body);
    call(fx, { method: "POST", path: `/v1/sessions/${lo1.session_id}/close`, key: adapter.key, body: { idempotency_key: `cl1-${runtime}` } });

    // 3. the failure becomes a new revision, with the goal stated in advance
    const created = revisionFromFailure(fx, s, failed.json.outcome_id, `rev-${runtime}`);
    assert.equal(created.status, 201, created.body);
    const v2 = created.json.revision.revision_id as string;

    // 4. the same review and the same approval
    const approved = call(fx, {
      method: "POST",
      path: `/v1/console/drafts/${draft.draft_id}/approve`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { revision_id: v2, idempotency_key: `app2-${runtime}` },
    });
    assert.equal(approved.status, 201, approved.body);

    // 5. reassigned, effective from the next session
    const selected = call(fx, {
      method: "POST",
      path: `/v1/console/assignments/${assignmentId}/revision`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { revision_id: v2, idempotency_key: `sel2-${runtime}` },
    });
    assert.equal(selected.status, 200, selected.body);

    // 6. a NEW session on the SAME runtime, and this time it worked
    const lo2 = openSession(fx, adapter.key, fx.reporter.agent_id, runtime, `l2-${runtime}`);
    const e2 = lo2.entries[0];
    assert.equal(e2.draft_revision_id, v2);
    loadAndInvoke(fx, adapter.key, lo2.session_id, e2, `l2-${runtime}`, { runtime: `${runtime}-rt-2`, invocation: "call-2" });
    const worked = call(fx, {
      method: "POST",
      path: `/v1/sessions/${lo2.session_id}/outcomes`,
      key: adapter.key,
      body: {
        outcome: "worked",
        outcome_ref: `${runtime}-o-2`,
        revision_id: e2.draft_revision_id,
        content_digest: e2.content_digest,
        runtime_session_ref: `${runtime}-rt-2`,
        invocation_ref: "call-2",
        reason_code: "MERGED_TO_RELEASE",
        reason: "it checked the branch first",
      },
    });
    assert.equal(worked.status, 201, worked.body);

    // 7. the comparison confirms the improvement
    const compared = call(fx, {
      method: "POST",
      path: "/v1/console/comparisons",
      cookie: s.cookie,
      csrf: s.csrf,
      body: { baseline_outcome_id: failed.json.outcome_id, candidate_outcome_id: worked.json.outcome_id, idempotency_key: `cmp-${runtime}` },
    });
    assert.equal(compared.status, 201, compared.body);
    assert.equal(compared.json.verdict, "improved");
    assert.equal(compared.json.comparable, true);

    // 8. and a rollback to v1, confirmed by a third session at the exact version
    const back = call(fx, {
      method: "POST",
      path: `/v1/console/assignments/${assignmentId}/revision`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { revision_id: draft.revision_id, idempotency_key: `selb-${runtime}` },
    });
    assert.equal(back.status, 200, back.body);
    const event = fx.db
      .prepare("SELECT id FROM skill_assignment_events WHERE assignment_id=? AND event='revision_selected' AND desired_revision_id=? ORDER BY event_seq DESC LIMIT 1")
      .get(assignmentId, draft.revision_id) as { id: string };
    const lo3 = openSession(fx, adapter.key, fx.reporter.agent_id, runtime, `l3-${runtime}`);
    const e3 = lo3.entries[0];
    assert.equal(e3.draft_revision_id, draft.revision_id);
    const rolledBack = call(fx, {
      method: "POST",
      path: `/v1/sessions/${lo3.session_id}/rollback-confirmations`,
      key: adapter.key,
      body: { entry_id: e3.entry_id, rollback_action_event_id: event.id, idempotency_key: `rb-${runtime}` },
    });
    assert.equal(rolledBack.status, 201, rolledBack.body);
    assert.equal(rolledBack.json.outcome, "rolled_back");

    // the whole loop, read back from the canonical rows
    const history = call(fx, {
      path: `/v1/console/capabilities/${draft.draft_id}/outcomes`,
      cookie: s.cookie,
      csrf: s.csrf,
    });
    assert.deepEqual(
      history.json.outcomes.map((o: any) => o.outcome),
      ["failed", "worked", "rolled_back"],
    );
    assert.equal(history.json.comparisons[0].verdict, "improved");
    assert.equal(history.json.lineage[0].parent_revision_id, draft.revision_id);
  });
}
