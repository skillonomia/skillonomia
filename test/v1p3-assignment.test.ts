// V1 P3 — ASSIGNMENT AND LIFECYCLE CONTROL.
//
// One test per binary requirement of the phase, driven through the real router
// against a real database. What is asserted is the SERVER'S answer: the console
// holds no rule these tests could not reach through `handleRest`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRest, type RestResponse } from "../src/http.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { CONSOLE_CONTRACT_VERSION } from "../src/console-view.ts";
import { LIFECYCLE_TRANSITIONS, DESIRED_STATES, isLegalLifecycleTransition } from "../src/assignment-lifecycle.ts";
import { readFileSync } from "node:fs";
import { p4Fixture, type P4Fixture } from "./p4-helpers.ts";

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

function workflow(step: string): string {
  return [
    "# ship-the-thing",
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

/** A capture, approved at revision 1. Returns the ids the assignment needs. */
function approvedDraft(fx: P4Fixture, s: { cookie: string; csrf: string }, key = "k1") {
  const captured = call(fx, {
    method: "POST",
    path: "/v1/captures",
    key: fx.keys.owner!,
    body: { kind: "workflow", text: workflow("Run the suite."), idempotency_key: `cap-${key}` },
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
  return { draft_id: draft.draft_id, revision_id: draft.revision_id };
}

/** A SECOND approved revision of the same lineage — what a rollback returns to. */
function secondApprovedRevision(fx: P4Fixture, s: { cookie: string; csrf: string }, draftId: string, key = "k1") {
  const edited = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draftId}/revisions`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { sections: { procedure: ["Read the diff.", "Run the suite twice.", "Merge it."] }, idempotency_key: `ed-${key}` },
  });
  assert.equal(edited.status, 201, edited.body);
  const approved = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draftId}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: edited.json.revision_id, idempotency_key: `app2-${key}` },
  });
  assert.equal(approved.status, 201, approved.body);
  return edited.json.revision_id as string;
}

function assign(fx: P4Fixture, s: { cookie: string; csrf: string }, agentId: string, revisionId: string, key = "as-1") {
  return call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: agentId, revision_id: revisionId, idempotency_key: key },
  });
}

// ===========================================================================
// P3-FR-01 — assignment eligibility
// ===========================================================================

test("P3-FR-01: only an approved revision, and only an agent of the closed fleet", () => {
  const fx = p4Fixture();
  const s = signIn(fx);

  // an UNAPPROVED revision, on a real agent
  const captured = call(fx, {
    method: "POST",
    path: "/v1/captures",
    key: fx.keys.owner!,
    body: { kind: "workflow", text: workflow("Run the suite."), idempotency_key: "cap-u" },
  });
  assert.equal(captured.status, 201, captured.body);
  const unapproved = assign(fx, s, fx.owner.agent_id, captured.json.draft.revision_id, "as-u");
  assert.equal(unapproved.status, 412, unapproved.body);
  assert.equal(unapproved.json.error.current_state, "REVISION_NOT_APPROVED");

  // an APPROVED revision, on an agent that is not in this workspace
  const d = approvedDraft(fx, s);
  const stranger = assign(fx, s, "01ARZ3NDEKTSV4RRFFQ69G5FAV", d.revision_id, "as-s");
  assert.equal(stranger.status, 412, stranger.body);
  assert.equal(stranger.json.error.current_state, "AGENT_NOT_IN_FLEET");

  // and the pair that IS eligible
  const ok = assign(fx, s, fx.owner.agent_id, d.revision_id);
  assert.equal(ok.status, 201, ok.body);
  assert.equal(ok.json.contract, CONSOLE_CONTRACT_VERSION);
  assert.equal(ok.json.assignment.desired.state, "assigned");
  assert.equal(ok.json.assignment.desired.revision_id, d.revision_id);

  // a SECOND assignment of the same lineage at the same agent is refused
  const again = assign(fx, s, fx.owner.agent_id, d.revision_id, "as-2");
  assert.equal(again.status, 412, again.body);
  assert.equal(again.json.error.current_state, "ALREADY_ASSIGNED");
  fx.db.close();
});

test("P3-FR-01: the fleet the console is offered is the ACTIVE agents of this workspace", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const fleet = call(fx, { path: "/v1/console/fleet", cookie: s.cookie });
  assert.equal(fleet.status, 200, fleet.body);
  const ids = fleet.json.agents.map((a: any) => a.agent_id);
  assert.ok(ids.includes(fx.owner.agent_id), "the owner's own agent is not in the fleet");
  for (const a of fleet.json.agents) assert.equal(a.status, "active");
  fx.db.close();
});

// ===========================================================================
// P3-FR-03, P3-FR-04 — the transition table
// ===========================================================================

test("P3-FR-03/04: the lifecycle transition table, exercised cell by cell", () => {
  // The table is data, so the test is a table too: every ALLOWED cell is walked
  // on a real assignment and every FORBIDDEN one is refused with 412 and the
  // state it is still in.
  for (const from of DESIRED_STATES) {
    for (const to of DESIRED_STATES) {
      if (from === to) continue;
      const action = to === "active" ? "activate" : to === "paused" ? "pause" : to === "revoked" ? "revoke" : null;
      if (action === null) continue; // `assigned` is only ever the first event
      const fx = p4Fixture();
      const s = signIn(fx);
      const d = approvedDraft(fx, s);
      const created = assign(fx, s, fx.owner.agent_id, d.revision_id);
      assert.equal(created.status, 201, created.body);
      const id = created.json.assignment.assignment_id;

      // drive the assignment to `from`
      if (from !== "assigned") {
        const path = from === "active" ? "activate" : from === "paused" ? "pause" : "revoke";
        const step = call(fx, {
          method: "POST",
          path: `/v1/console/assignments/${id}/${path}`,
          cookie: s.cookie,
          csrf: s.csrf,
          body: { idempotency_key: `to-${from}` },
        });
        assert.equal(step.status, 200, `could not reach ${from}: ${step.body}`);
      }
      const res = call(fx, {
        method: "POST",
        path: `/v1/console/assignments/${id}/${action}`,
        cookie: s.cookie,
        csrf: s.csrf,
        body: { idempotency_key: `try-${from}-${to}` },
      });
      if (isLegalLifecycleTransition(from, to)) {
        assert.equal(res.status, 200, `${from} → ${to} was refused: ${res.body}`);
        assert.equal(res.json.assignment.desired.state, to);
      } else {
        assert.equal(res.status, 412, `${from} → ${to} was allowed: ${res.body}`);
        assert.equal(res.json.error.current_state, from);
      }
      fx.db.close();
    }
  }
});

test("P3-FR-04: a revoked assignment is not silently reactivated, and a new one may be made", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;
  const revoked = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/revoke`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { reason: "not this agent after all", idempotency_key: "rev-1" },
  });
  assert.equal(revoked.status, 200, revoked.body);
  const reactivated = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/activate`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { idempotency_key: "act-1" },
  });
  assert.equal(reactivated.status, 412, reactivated.body);
  assert.equal(reactivated.json.error.current_state, "revoked");

  // …and the explicit route back is a NEW assignment, which is allowed
  const fresh = assign(fx, s, fx.owner.agent_id, d.revision_id, "as-fresh");
  assert.equal(fresh.status, 201, fresh.body);
  assert.notEqual(fresh.json.assignment.assignment_id, id);
  // the revoked one still exists, with its journal intact
  const audit = call(fx, { path: `/v1/console/assignments/${id}/audit`, cookie: s.cookie });
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.json.items.map((i: any) => i.event), ["assigned", "revoked"]);
  fx.db.close();
});

// ===========================================================================
// P3-FR-06, P3-FR-07, P3-FR-08 — desired is not observed
// ===========================================================================

test("P3-FR-06/07: an owner command changes desired state and writes no observation", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;
  for (const action of ["activate", "pause", "activate"]) {
    const res = call(fx, {
      method: "POST",
      path: `/v1/console/assignments/${id}/${action}`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { idempotency_key: `${action}-${Math.random()}` },
    });
    assert.equal(res.status, 200, res.body);
    // the observed half NEVER moved
    assert.equal(res.json.assignment.observed.status, "unknown");
    assert.equal(res.json.assignment.observed.reason_code, "NO_OBSERVATION");
  }
  const rows = fx.db.prepare("SELECT count(*) c FROM assignment_observations").get() as { c: number };
  assert.equal(rows.c, 0, "an owner command wrote an observation row");
  const view = call(fx, { path: `/v1/console/assignments/${id}`, cookie: s.cookie });
  assert.equal(view.json.assignment.desired.state, "active");
  assert.equal(view.json.assignment.observed.status, "unknown");
  // separate objects, separate sources, and neither computed from the other
  assert.notEqual(view.json.desired_state_source, view.json.observed_state_source);
  fx.db.close();
});

test("P3-FR-08 / INV-03: every observation carries a reason code, a reason, a source and a time", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;

  // the absence of any report is `unknown` WITH all four fields
  const before = call(fx, { path: `/v1/console/assignments/${id}`, cookie: s.cookie });
  const obs = before.json.assignment.observed;
  assert.equal(obs.status, "unknown");
  assert.ok(obs.reason_code.length > 0);
  assert.ok(obs.reason.length > 0);
  assert.ok(obs.source.length > 0);
  assert.equal(obs.agent_id, fx.owner.agent_id);

  // a report missing any required field is refused rather than stored
  for (const missing of ["reason_code", "reason", "source"]) {
    const body: Record<string, unknown> = {
      observed_status: "unknown",
      reason_code: "ADAPTER_SILENT",
      reason: "the adapter answered nothing within the window",
      source: "adapter",
      provenance: { window: "one session" },
    };
    delete body[missing];
    const res = call(fx, {
      method: "POST",
      path: `/v1/assignments/${id}/observations`,
      key: fx.keys.owner!,
      body,
    });
    assert.equal(res.status, 400, `an observation with no ${missing} was accepted: ${res.body}`);
  }
  // `owner` is not a source an observation may claim
  const asOwner = call(fx, {
    method: "POST",
    path: `/v1/assignments/${id}/observations`,
    key: fx.keys.owner!,
    body: {
      observed_status: "loaded",
      reason_code: "OWNER_SAYS_SO",
      reason: "the owner asserts it is loaded",
      source: "owner",
      provenance: {},
    },
  });
  assert.equal(asOwner.status, 400, asOwner.body);

  // a well-formed report DOES move the observed half, and only it
  const reported = call(fx, {
    method: "POST",
    path: `/v1/assignments/${id}/observations`,
    key: fx.keys.owner!,
    body: {
      observed_status: "loaded",
      reason_code: "ADAPTER_CONFIRMED",
      reason: "the adapter reported the revision present in the session loadout",
      source: "adapter",
      session_ref: "session-7",
      revision_id: d.revision_id,
      observed_at_ms: 1754100000000,
      provenance: { adapter: "test-adapter" },
      idempotency_key: "obs-1",
    },
  });
  assert.equal(reported.status, 201, reported.body);
  const after = call(fx, { path: `/v1/console/assignments/${id}`, cookie: s.cookie });
  assert.equal(after.json.assignment.observed.status, "loaded");
  assert.equal(after.json.assignment.observed.session_ref, "session-7");
  assert.equal(after.json.assignment.observed.observed_at_ms, 1754100000000);
  // the DESIRED half did not move because something was observed
  assert.equal(after.json.assignment.desired.state, "assigned");
  fx.db.close();
});

// ===========================================================================
// P3-FR-09, P3-FR-10, P3-FR-11 — idempotency and preconditions
// ===========================================================================

test("P3-FR-09/10: the same key with the same payload replays; with another payload it is 409", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const first = assign(fx, s, fx.owner.agent_id, d.revision_id, "idem-1");
  assert.equal(first.status, 201, first.body);
  const replay = assign(fx, s, fx.owner.agent_id, d.revision_id, "idem-1");
  assert.equal(replay.status, 201, replay.body);
  assert.equal(replay.headers["Idempotency-Replayed"], "true");
  assert.equal(
    replay.json.assignment.assignment_id,
    first.json.assignment.assignment_id,
    "a replay created a second assignment",
  );
  const rows = fx.db.prepare("SELECT count(*) c FROM skill_assignments").get() as { c: number };
  assert.equal(rows.c, 1, "a replay wrote a second row");

  // the same key, a different payload
  const conflicting = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: fx.owner.agent_id, revision_id: d.revision_id, reason: "a different request", idempotency_key: "idem-1" },
  });
  assert.equal(conflicting.status, 409, conflicting.body);
  assert.equal(conflicting.json.error.code, "CONFLICT");
  assert.equal(conflicting.json.error.current_state, "used_with_a_different_payload");
  assert.equal(conflicting.json.contract, CONSOLE_CONTRACT_VERSION, "the refusal left the console's contract boundary");
  fx.db.close();
});

test("P3-FR-11: a stale entity version is 412 with the state to converge on", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const created = assign(fx, s, fx.owner.agent_id, d.revision_id);
  const id = created.json.assignment.assignment_id;
  const stale = created.json.assignment.entity_version;

  const moved = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/activate`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { if_version: stale, idempotency_key: "v-1" },
  });
  assert.equal(moved.status, 200, moved.body);
  assert.equal(moved.json.assignment.entity_version, stale + 1);

  // the second writer still holds the version it read
  const lost = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/pause`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { if_version: stale, idempotency_key: "v-2" },
  });
  assert.equal(lost.status, 412, lost.body);
  assert.equal(lost.json.error.code, "PRECONDITION_FAILED");
  assert.equal(lost.json.error.current_state, "active");
  assert.equal(lost.json.contract, CONSOLE_CONTRACT_VERSION);

  // and the refetch the console performs shows the canonical state
  const refetched = call(fx, { path: `/v1/console/assignments/${id}`, cookie: s.cookie });
  assert.equal(refetched.json.assignment.desired.state, "active");
  assert.equal(refetched.json.assignment.entity_version, stale + 1);
  fx.db.close();
});

// ===========================================================================
// P3-FR-05 — rollback selects a previously approved revision and deletes nothing
// ===========================================================================

test("P3-FR-05 / INV-06: rollback selects an earlier approved revision and deletes nothing", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const second = secondApprovedRevision(fx, s, d.draft_id);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;

  // forward: select the newer approved revision
  const forward = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: second, idempotency_key: "sel-1" },
  });
  assert.equal(forward.status, 200, forward.body);
  assert.equal(forward.json.assignment.desired.revision_id, second);
  assert.equal(forward.json.assignment.desired.reason_code, "OWNER_SELECTED_REVISION");

  // back: the rollback
  const back = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: d.revision_id, reason: "the newer one regressed", idempotency_key: "sel-2" },
  });
  assert.equal(back.status, 200, back.body);
  assert.equal(back.json.assignment.desired.revision_id, d.revision_id);
  assert.equal(back.json.assignment.desired.reason_code, "OWNER_ROLLED_BACK");

  // NOTHING WAS DELETED: both revisions, both approvals, and the whole journal
  const revisions = fx.db.prepare("SELECT count(*) c FROM draft_revisions WHERE draft_id=?").get(d.draft_id) as { c: number };
  assert.equal(revisions.c, 2);
  const approvals = fx.db.prepare("SELECT count(*) c FROM revision_approvals WHERE draft_id=?").get(d.draft_id) as { c: number };
  assert.equal(approvals.c, 2);
  const audit = call(fx, { path: `/v1/console/assignments/${id}/audit`, cookie: s.cookie });
  assert.deepEqual(audit.json.items.map((i: any) => i.event), ["assigned", "revision_selected", "revision_selected"]);
  assert.deepEqual(audit.json.items.map((i: any) => i.event_seq), [1, 2, 3]);
  fx.db.close();
});

test("P3-FR-05: a revision that is not approved cannot be selected", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const edited = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${d.draft_id}/revisions`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { sections: { procedure: ["Read the diff.", "Skip the suite.", "Merge it."] }, idempotency_key: "ed-x" },
  });
  assert.equal(edited.status, 201, edited.body);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;
  const refused = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/revision`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: edited.json.revision_id, idempotency_key: "sel-bad" },
  });
  assert.equal(refused.status, 412, refused.body);
  fx.db.close();
});

// ===========================================================================
// P3-FR-13, P3-FR-14, P3-FR-15 — the audit and the new-session boundary
// ===========================================================================

test("P3-FR-13: every lifecycle mutation is a structured audit event", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;
  for (const action of ["activate", "pause", "revoke"]) {
    const res = call(fx, {
      method: "POST",
      path: `/v1/console/assignments/${id}/${action}`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { reason: `because of ${action}`, idempotency_key: `a-${action}` },
    });
    assert.equal(res.status, 200, res.body);
  }
  const audit = call(fx, { path: `/v1/console/assignments/${id}/audit`, cookie: s.cookie });
  assert.equal(audit.status, 200, audit.body);
  assert.equal(audit.json.contract, CONSOLE_CONTRACT_VERSION);
  assert.deepEqual(audit.json.items.map((i: any) => i.event), ["assigned", "activated", "paused", "revoked"]);
  for (const item of audit.json.items) {
    // INV-05: every field a reader needs is a COLUMN, not a sentence
    for (const field of [
      "entry_id",
      "event",
      "desired_state",
      "desired_revision_id",
      "effective_from",
      "actor_agent_id",
      "actor_role",
      "source",
      "reason_code",
      "content_digest",
      "server_at_ms",
    ]) {
      assert.ok(item[field] !== undefined && item[field] !== null, `${field} is missing from an audit entry`);
    }
    assert.equal(item.effective_from, "next_session");
    assert.equal(item.source, "owner");
    assert.ok(typeof item.provenance === "object" && item.provenance !== null);
  }
  fx.db.close();
});

test("P3-FR-14/15 / INV-07: every command answers `next_session`, and no event is rewritten", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const created = assign(fx, s, fx.owner.agent_id, d.revision_id);
  assert.equal(created.json.effective_from, "next_session");
  assert.equal(created.json.assignment.desired.effective_from, "next_session");
  const id = created.json.assignment.assignment_id;

  const before = fx.db.prepare("SELECT * FROM skill_assignment_events WHERE assignment_id=? ORDER BY event_seq").all(id);
  const activated = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/activate`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { idempotency_key: "n-1" },
  });
  assert.equal(activated.json.effective_from, "next_session");
  const after = fx.db.prepare("SELECT * FROM skill_assignment_events WHERE assignment_id=? ORDER BY event_seq").all(id);
  // the earlier events are byte-for-byte what they were: the journal APPENDS
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 1);
  // and the database itself refuses an update
  assert.throws(
    () => fx.db.prepare("UPDATE skill_assignment_events SET desired_state='revoked' WHERE assignment_id=?").run(id),
    /INSERT_ONLY/,
  );
  fx.db.close();
});

// ===========================================================================
// P3-FR-12, P3-FR-16 — the console renders the rules and holds none
// ===========================================================================

test("P3-FR-16: the transition table and the conflict rules exist once, on the server", () => {
  // The client bundle is searched for the two things `P3-FR-16` forbids it to
  // hold: a transition table of its own, and a decision about what a 409 or a
  // 412 means beyond refetching.
  const source = readFileSyncSafe("console/app.ts");
  for (const state of DESIRED_STATES) {
    // a state NAME may be displayed; a MAP from state to allowed actions may not
    assert.ok(
      !new RegExp(`${state}\\s*:\\s*\\[`).test(source),
      `console/app.ts holds a transition entry for \`${state}\``,
    );
  }
  assert.ok(!/isLegalLifecycleTransition|LIFECYCLE_TRANSITIONS/.test(source), "the client imported the server's table");
  // the server's table is the one thing that decides, and it is data
  assert.deepEqual(Object.keys(LIFECYCLE_TRANSITIONS).sort(), [...DESIRED_STATES].sort());
  assert.deepEqual(LIFECYCLE_TRANSITIONS.revoked, []);
});

test("P3-FR-12: a 409 and a 412 both carry the state and the contract the console refetches on", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;
  const stale = 1;
  call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/activate`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { idempotency_key: "c-1" },
  });
  const precondition = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/pause`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { if_version: stale, idempotency_key: "c-2" },
  });
  assert.equal(precondition.status, 412);
  assert.equal(precondition.json.contract, CONSOLE_CONTRACT_VERSION);
  assert.ok(precondition.json.error.current_state);

  // the key of a SUCCESSFUL call — a call that failed leaves its key unconsumed,
  // which is the released rule and is why the conflict is proved on `c-1`
  const conflict = call(fx, {
    method: "POST",
    path: `/v1/console/assignments/${id}/activate`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { reason: "another payload entirely", idempotency_key: "c-1" },
  });
  assert.equal(conflict.status, 409, conflict.body);
  assert.equal(conflict.json.contract, CONSOLE_CONTRACT_VERSION);
  assert.ok(conflict.json.error.current_state);
  fx.db.close();
});

// ===========================================================================
// P2 compatibility and the protected surface
// ===========================================================================

test("P3: every new console route needs a session, and the observation route needs a key", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const id = assign(fx, s, fx.owner.agent_id, d.revision_id).json.assignment.assignment_id;
  for (const path of [
    "/v1/console/fleet",
    "/v1/console/capabilities",
    `/v1/console/capabilities/${d.draft_id}`,
    `/v1/console/assignments/${id}`,
    `/v1/console/assignments/${id}/audit`,
  ]) {
    const res = call(fx, { path });
    assert.equal(res.status, 401, `${path} answered ${res.status} without a session`);
  }
  // the observed-state intake is NOT reachable with a console session
  const viaSession = call(fx, {
    method: "POST",
    path: `/v1/assignments/${id}/observations`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { observed_status: "loaded", reason_code: "X", reason: "y", source: "adapter", provenance: {} },
  });
  assert.equal(viaSession.status, 401, viaSession.body);
  fx.db.close();
});

test("P3: the capability detail carries the server's verdicts as fields", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const d = approvedDraft(fx, s);
  const cap = call(fx, { path: `/v1/console/capabilities/${d.draft_id}`, cookie: s.cookie });
  assert.equal(cap.status, 200, cap.body);
  assert.equal(cap.json.contract, CONSOLE_CONTRACT_VERSION);
  assert.equal(cap.json.effective_from, "next_session");
  assert.equal(cap.json.approved_revisions.length, 1);
  assert.equal(cap.json.head_approval.draft_revision_id, d.revision_id);
  assert.ok(cap.json.fleet.length > 0);
  assert.equal(cap.json.eligibility.length, cap.json.fleet.length);
  for (const e of cap.json.eligibility) {
    assert.equal(typeof e.assignable, "boolean");
    assert.ok(typeof e.reason_code === "string" && e.reason_code.length > 0);
  }
  const library = call(fx, { path: "/v1/console/capabilities", cookie: s.cookie });
  assert.equal(library.json.items.length, 1);
  assert.equal(library.json.items[0].draft_id, d.draft_id);
  fx.db.close();
});

function readFileSyncSafe(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
