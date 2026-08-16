// V1 P3 — THE SECOND LOOK AT WHAT P3 DID TO P2's APPROVAL RULE.
//
// WHAT CHANGED. P2 REVIEW-1's finding `P2-R1-003` was closed by refusing a
// revision after ANY decision: an approved lineage took no further edit. P3
// needed a lineage to be able to carry MORE THAN ONE approved revision, because
// `P3-FR-05`'s rollback selects a PREVIOUSLY APPROVED one and a lineage with a
// single approval has nothing to roll back to. So approval became a fact about a
// REVISION (`revision_approvals`), and the refusal narrowed: only a REJECTION
// closes a lineage now.
//
// THAT NARROWING IS A WEAKENING UNLESS THE PROPERTY IS CARRIED SOMEWHERE ELSE,
// and `v1/P3-ASSIGNMENT-LIFECYCLE.md` §4 says it is carried by the data. This
// file is that claim put to the registry rather than inherited from a paragraph.
// The property, stated so it can fail:
//
//   1. no lineage reports a state its HEAD does not have — the head's own
//      approval is a field, and every surface that could be read as "this thing
//      is approved" carries it;
//   2. an approved revision is not mutated — not by a later edit, not by a
//      second approval, not by an UPDATE;
//   3. history is not rewritten — the first decision stays the first decision,
//      the approval rows stay, and the journal stays;
//   4. and the consequence that makes 1–3 matter: an UNAPPROVED head cannot be
//      assigned, so a lineage whose head nobody approved cannot reach an agent.
//
// Each test below fails if one of those stops holding. The rejection half of
// `P2-R1-003` — a rejected lineage takes no further revision — is asserted here
// too, because "we narrowed it to rejections" is only true while the rejection
// case still refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRest, type RestResponse } from "../src/http.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
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
  return { cookie: /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"]!)![1]!, csrf: opened.json.csrf_token };
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
    "- the suite is red, so nothing merges",
  ].join("\n");
}

/** A captured, approved lineage: revision 1 approved, nothing else. */
function approvedLineage(fx: P4Fixture, s: { cookie: string; csrf: string }, key: string) {
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
  return { draft_id: draft.draft_id as string, revision_id: draft.revision_id as string };
}

/** An edit of that lineage: a NEW head revision, deliberately left unapproved. */
function reviseTo(fx: P4Fixture, s: { cookie: string; csrf: string }, draftId: string, key: string): string {
  const edited = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draftId}/revisions`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: {
      sections: { procedure: ["Read the diff.", "Run the suite twice.", "Merge it."] },
      idempotency_key: `ed-${key}`,
    },
  });
  assert.equal(edited.status, 201, edited.body);
  return edited.json.revision_id as string;
}

// ===========================================================================
// 1. no lineage reports a state its head does not have
// ===========================================================================

test("the narrowed refusal: an approved lineage with a newer head reports that head as unapproved", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const lineage = approvedLineage(fx, s, "n1");
  const head = reviseTo(fx, s, lineage.draft_id, "n1");
  assert.notEqual(head, lineage.revision_id);

  // THE INBOX. `state` is the LINEAGE's first decision — which is `approved` and
  // stays `approved`, because an approval is not undone by an edit — and
  // `head_approved` is the head's own. The finding was a surface that showed the
  // first and let a reader take it for the second; both are here, and they
  // disagree exactly when they should.
  const inbox = call(fx, { path: "/v1/console/drafts", cookie: s.cookie });
  const row = inbox.json.items.find((i: any) => i.draft_id === lineage.draft_id);
  assert.equal(row.state, "approved");
  assert.equal(row.head_approved, false, "the head carries no approval and the Inbox says so");
  assert.equal(row.latest_revision_id, head);

  // THE DETAIL, on the head: no approval of its own, and the server offers to
  // approve it — which is what makes a second approved revision reachable.
  const detail = call(fx, { path: `/v1/console/drafts/${lineage.draft_id}`, cookie: s.cookie });
  assert.equal(detail.json.draft.revision.revision_id, head);
  assert.equal(detail.json.revision_approval, null);
  assert.equal(detail.json.approved_revisions.length, 1);
  assert.equal(detail.json.approved_revisions[0].draft_revision_id, lineage.revision_id);
  assert.equal(detail.json.actions.approve.allowed, true);

  // THE DETAIL, on the approved revision, read explicitly: it still carries its
  // approval, so "approved" is a fact about a revision at every surface.
  const first = call(fx, {
    path: `/v1/console/drafts/${lineage.draft_id}?revision_id=${lineage.revision_id}`,
    cookie: s.cookie,
  });
  assert.equal(first.json.revision_approval.draft_revision_id, lineage.revision_id);

  // THE CAPABILITY: the assignable set is the APPROVED set, and the head is not
  // in it.
  const capability = call(fx, { path: `/v1/console/capabilities/${lineage.draft_id}`, cookie: s.cookie });
  assert.equal(capability.json.approved_revisions.length, 1);
  assert.equal(capability.json.head_approval.draft_revision_id, lineage.revision_id);
  assert.ok(
    !capability.json.approved_revisions.some((a: any) => a.draft_revision_id === head),
    "an unapproved head is not offered as an assignable revision",
  );
  fx.db.close();
});

// ===========================================================================
// 4. the consequence: an unapproved head cannot reach an agent
// ===========================================================================

test("the narrowed refusal: an unapproved head cannot be assigned, and the approved revision can", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const lineage = approvedLineage(fx, s, "n2");
  const head = reviseTo(fx, s, lineage.draft_id, "n2");

  const refused = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: fx.owner.agent_id, revision_id: head, idempotency_key: "as-head" },
  });
  assert.equal(refused.status, 412, refused.body);
  assert.equal(refused.json.error.current_state, "REVISION_NOT_APPROVED");

  const accepted = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: fx.owner.agent_id, revision_id: lineage.revision_id, idempotency_key: "as-approved" },
  });
  assert.equal(accepted.status, 201, accepted.body);
  assert.equal(accepted.json.assignment.desired.revision_id, lineage.revision_id);
  fx.db.close();
});

// ===========================================================================
// 2. an approved revision is not mutated
// ===========================================================================

test("the narrowed refusal: a later edit leaves the approved revision, its approval and its digest exactly as they were", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const lineage = approvedLineage(fx, s, "n3");

  const before = call(fx, {
    path: `/v1/console/drafts/${lineage.draft_id}?revision_id=${lineage.revision_id}`,
    cookie: s.cookie,
  });
  const beforeRevision = before.json.draft.revision;
  const beforeApproval = before.json.revision_approval;
  const beforeDecision = before.json.decision;

  reviseTo(fx, s, lineage.draft_id, "n3");

  const after = call(fx, {
    path: `/v1/console/drafts/${lineage.draft_id}?revision_id=${lineage.revision_id}`,
    cookie: s.cookie,
  });
  assert.deepEqual(after.json.draft.revision, beforeRevision, "the approved revision changed under an edit");
  assert.deepEqual(after.json.revision_approval, beforeApproval, "the approval changed under an edit");
  assert.deepEqual(after.json.decision, beforeDecision, "the lineage's first decision changed under an edit");

  // and the same revision cannot be approved a second time, so the approval row
  // is written once and read forever
  const again = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${lineage.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: lineage.revision_id, idempotency_key: "again" },
  });
  assert.ok(again.status === 409 || again.status === 412, `${again.status}: ${again.body}`);
  fx.db.close();
});

test("the narrowed refusal: the database itself refuses to rewrite an approval, a decision or a revision", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const lineage = approvedLineage(fx, s, "n4");
  const assigned = call(fx, {
    method: "POST",
    path: "/v1/console/assignments",
    cookie: s.cookie,
    csrf: s.csrf,
    body: { agent_id: fx.owner.agent_id, revision_id: lineage.revision_id, idempotency_key: "as-n4" },
  });
  assert.equal(assigned.status, 201, assigned.body);

  // Four tables, four statements a rewrite would need, four refusals. These are
  // the triggers of `0013`, `0014` and `0015` — INSERT-only is what makes
  // "history is not rewritten" a property of the storage rather than of the code
  // that happens to be written above it.
  const statements: Array<[string, string]> = [
    ["revision_approvals", "UPDATE revision_approvals SET content_digest='rewritten'"],
    ["revision_approvals", "DELETE FROM revision_approvals"],
    ["draft_decisions", "UPDATE draft_decisions SET decision='rejected'"],
    ["draft_revisions", "UPDATE draft_revisions SET content_digest='rewritten'"],
    ["skill_assignment_events", "UPDATE skill_assignment_events SET desired_state='revoked'"],
    ["skill_assignment_events", "DELETE FROM skill_assignment_events"],
  ];
  for (const [table, sql] of statements) {
    assert.throws(
      () => fx.db.prepare(sql).run(),
      /INSERT_ONLY/,
      `${table} accepted \`${sql}\``,
    );
  }
  fx.db.close();
});

// ===========================================================================
// 3. history is not rewritten — and the rejection half still refuses
// ===========================================================================

test("the narrowed refusal: a REJECTED lineage still takes no further revision, which is the half P3 did not change", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const captured = call(fx, {
    method: "POST",
    path: "/v1/captures",
    key: fx.keys.owner!,
    body: { kind: "workflow", text: workflow("Run the suite."), idempotency_key: "cap-n5" },
  });
  const draft = captured.json.draft;
  const rejected = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/reject`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { reason: "not a reusable procedure", idempotency_key: "rej-n5" },
  });
  assert.equal(rejected.status, 201, rejected.body);

  const revise = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/revisions`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { sections: { procedure: ["Try again."] }, idempotency_key: "ed-n5" },
  });
  assert.equal(revise.status, 409, revise.body);
  assert.equal(revise.json.error.current_state, "rejected");

  const detail = call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie: s.cookie });
  assert.equal(detail.json.actions.revise.allowed, false);
  assert.equal(detail.json.actions.approve.allowed, false);
  assert.equal(detail.json.actions.reject.allowed, false);
  fx.db.close();
});

test("the narrowed refusal: an approved lineage cannot be rejected afterwards, so a decision is not overwritten", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const lineage = approvedLineage(fx, s, "n6");
  const reject = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${lineage.draft_id}/reject`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { reason: "changed my mind", idempotency_key: "rej-n6" },
  });
  assert.equal(reject.status, 409, reject.body);
  assert.equal(reject.json.error.current_state, "approved");

  const detail = call(fx, {
    path: `/v1/console/drafts/${lineage.draft_id}?revision_id=${lineage.revision_id}`,
    cookie: s.cookie,
  });
  assert.equal(detail.json.decision.decision, "approved");
  assert.equal(detail.json.revision_approval.draft_revision_id, lineage.revision_id);
  fx.db.close();
});
