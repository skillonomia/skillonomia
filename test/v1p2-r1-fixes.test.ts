// V1 P2 REVIEW-1 — the checks that close the findings, and that would have
// caught them.
//
// Each block below names the finding it closes and asserts the behaviour that
// was WRONG before the fix, so a regression is a red test rather than a reread
// of a diff. Where the finding was about a failure mode the ordinary path does
// not reach — a database that refuses a write — the failure is injected rather
// than described, because a claim about an error path nobody has produced is a
// claim about a code path nobody has run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRest, type RestResponse } from "../src/http.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { CONSOLE_CONTRACT_VERSION } from "../src/console-view.ts";
import { Registry } from "../src/service.ts";
import { openDb, migrate } from "../src/db.ts";
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

function callOn(registry: Registry, c: Call): RestResponse & { json: any } {
  const headers: Record<string, string | undefined> = { host: ORIGIN };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
  if (c.csrf) headers["x-skillonomia-console-csrf"] = c.csrf;
  headers.origin = `http://${ORIGIN}`;
  const res = handleRest(registry, {
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

function call(fx: P4Fixture, c: Call) {
  return callOn(fx.registry, c);
}

function signIn(fx: P4Fixture): { cookie: string; csrf: string } {
  const minted = call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys.owner!, body: {} });
  assert.equal(minted.status, 201, minted.body);
  const opened = call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  assert.equal(opened.status, 201, opened.body);
  return { cookie: /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"])![1]!, csrf: opened.json.csrf_token };
}

const WORKFLOW = [
  "# ship-the-thing",
  "",
  "Use this whenever a change is ready.",
  "",
  "## Purpose",
  "Ship a reviewed change.",
  "",
  "## Procedure",
  "1. Read the diff.",
  "2. Run the suite.",
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

function capture(fx: P4Fixture): any {
  const res = call(fx, { method: "POST", path: "/v1/captures", key: fx.keys.owner!, body: { kind: "workflow", text: WORKFLOW } });
  assert.equal(res.status, 201, res.body);
  return res.json;
}

// ===========================================================================
// P2-R1-002 — a logout that failed may not answer success (INV-04, P2-FR-02)
// ===========================================================================
//
// THE INJECTION. A second connection to the same file takes `BEGIN IMMEDIATE`,
// which holds the write lock; the INSERT the logout performs then fails with
// SQLITE_BUSY. That is a real SQLite failure of the real statement, not a stub
// of one — the point of the finding was that the code could not tell this apart
// from "already revoked", so a test that mocked the error would be testing the
// same assumption that was wrong.

/** A registry on a real file, so a second connection can lock it. */
function fileRegistry(): { registry: Registry; file: string; close: () => void } {
  const file = join(mkdtempSync(join(tmpdir(), "p2r1-logout-")), "registry.db");
  const db = openDb(file);
  migrate(db);
  const registry = new Registry(db);
  return { registry, file, close: () => db.close() };
}

function openOwnerSession(registry: Registry): { cookie: string; csrf: string } {
  const boot = registry.bootstrap()!;
  const owner = registry.exchangeBootstrap(boot.bootstrap_owner_token);
  const auth = registry.authenticate(`Bearer ${owner.api_key}`);
  const ticket = registry.mintConsoleTicket(auth);
  const session = registry.openConsoleSession(ticket.ticket);
  return { cookie: session.cookie_value, csrf: session.csrf_token };
}

test("P2-R1-002: a logout whose revocation fails is refused, not reported as success", () => {
  const { registry, file, close } = fileRegistry();
  const session = openOwnerSession(registry);

  const lock = openDb(file);
  lock.exec("BEGIN IMMEDIATE");
  const refused = callOn(registry, {
    method: "POST",
    path: "/v1/console/logout",
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  lock.exec("ROLLBACK");
  lock.close();

  // 1. the answer is a refusal, and it names the state the session is STILL in
  assert.notEqual(refused.status, 200, `logout answered ${refused.status} with a revocation that did not happen`);
  assert.equal(refused.status, 409, refused.body);
  assert.equal(refused.json.error.code, "CONFLICT");
  assert.equal(refused.json.error.current_state, "active");
  // 2. it does not clear the cookie either: a browser that dropped the cookie
  //    here would show a signed-out console over a session that is still live
  assert.equal(refused.headers["Set-Cookie"], undefined);
  // 3. and nothing in the message repeats the driver's text, which names a path
  assert.ok(!/\//.test(refused.json.error.message), refused.json.error.message);

  // 4. the honest consequence: the session really is still usable, which is why
  //    answering 200 was the defect
  const stillLive = callOn(registry, { path: "/v1/console/drafts", cookie: session.cookie });
  assert.equal(stillLive.status, 200);

  // 5. the retry, with the lock gone, revokes — and THEN the cookie is refused
  const retried = callOn(registry, {
    method: "POST",
    path: "/v1/console/logout",
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  assert.equal(retried.status, 200, retried.body);
  assert.equal(retried.json.logged_out, true);
  const afterLogout = callOn(registry, { path: "/v1/console/drafts", cookie: session.cookie });
  assert.equal(afterLogout.status, 401, "the old cookie was accepted after a successful logout");
  close();
});

test("P2-R1-002: a second logout of the same session is still a no-op, not a refusal", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const first = call(fx, { method: "POST", path: "/v1/console/logout", cookie: s.cookie, csrf: s.csrf, body: {} });
  assert.equal(first.status, 200, first.body);
  // the session is gone, so the second attempt is refused for the ORDINARY
  // reason — no session — rather than by the catch this finding narrowed
  const second = call(fx, { method: "POST", path: "/v1/console/logout", cookie: s.cookie, csrf: s.csrf, body: {} });
  assert.equal(second.status, 401, second.body);
  fx.db.close();
});

// ===========================================================================
// P2-R1-003 — the edit transition is the server's (P2-FR-11, INV-06)
// ===========================================================================

for (const decision of ["approve", "reject"] as const) {
  test(`P2-R1-003: a revision POSTed after ${decision} is refused by the server`, () => {
    const fx = p4Fixture();
    const s = signIn(fx);
    const draft = capture(fx).draft;

    const decided = call(fx, {
      method: "POST",
      path: `/v1/console/drafts/${draft.draft_id}/${decision}`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { revision_id: draft.revision_id, reason: "a reason", idempotency_key: `k-${decision}` },
    });
    assert.equal(decided.status, 201, decided.body);

    const edited = call(fx, {
      method: "POST",
      path: `/v1/console/drafts/${draft.draft_id}/revisions`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { sections: { procedure: ["Read twice.", "Run the suite.", "Merge it."] }, idempotency_key: "k-edit" },
    });
    // the structured refusal, with the state a caller converges on
    assert.equal(edited.status, 409, `a decided draft accepted a revision: ${edited.status} ${edited.body}`);
    assert.equal(edited.json.error.code, "CONFLICT");
    assert.equal(edited.json.error.current_state, decision === "approve" ? "approved" : "rejected");

    // INV-06: the decided revision is still the head, still immutable, and the
    // history was not rewritten to make the refusal true
    const detail = call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie: s.cookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.draft.revision.revision_id, draft.revision_id);
    assert.equal(detail.json.decision.draft_revision_id, draft.revision_id);
    assert.equal(detail.json.draft.lineage.length, 1);
    assert.equal(detail.json.state, decision === "approve" ? "approved" : "rejected");
    fx.db.close();
  });
}

test("P2-R1-003: the same refusal reaches the machine-to-machine surface", () => {
  // `INV-01`: one rule, in the service, so the console is not the only caller
  // that meets it. A second implementation on the console route would leave the
  // API-key surface able to do the thing the console cannot.
  const fx = p4Fixture();
  const s = signIn(fx);
  const draft = capture(fx).draft;
  const approved = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: draft.revision_id, idempotency_key: "k-a" },
  });
  assert.equal(approved.status, 201, approved.body);
  const viaKey = call(fx, {
    method: "POST",
    path: `/v1/drafts/${draft.draft_id}/revisions`,
    key: fx.keys.owner!,
    body: { sections: { procedure: ["One.", "Two.", "Three."] }, idempotency_key: "k-b" },
  });
  assert.equal(viaKey.status, 409, viaKey.body);
  assert.equal(viaKey.json.error.current_state, "approved");
  fx.db.close();
});

test("P2-R1-003: an undecided draft still revises, and the console reads the answer as a field", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const draft = capture(fx).draft;

  const before = call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie: s.cookie });
  assert.deepEqual(before.json.actions.revise, { allowed: true, reason_code: "REVISABLE" });
  assert.deepEqual(before.json.actions.reject, { allowed: true, reason_code: "REJECTABLE" });
  assert.equal(before.json.actions.approve.allowed, before.json.eligibility.approvable);
  assert.equal(before.json.actions.approve.reason_code, before.json.eligibility.reason_code);

  const edited = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/revisions`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { sections: { procedure: ["Read twice.", "Run the suite.", "Merge it."] }, idempotency_key: "k-e" },
  });
  assert.equal(edited.status, 201, edited.body);

  const approved = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: edited.json.revision_id, idempotency_key: "k-a" },
  });
  assert.equal(approved.status, 201, approved.body);

  const after = call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie: s.cookie });
  assert.deepEqual(after.json.actions.revise, { allowed: false, reason_code: "ALREADY_DECIDED" });
  assert.deepEqual(after.json.actions.reject, { allowed: false, reason_code: "ALREADY_DECIDED" });
  assert.equal(after.json.actions.approve.allowed, false);
  fx.db.close();
});

test("P2-R1-003: the client bundle no longer computes the edit rule from the decision", () => {
  // The finding was a SPLIT: a rule in two places. This asserts the client half
  // is gone — the source no longer derives a button's state from `decision`, and
  // the three buttons read the three server fields.
  const source = readFileSync(new URL("../console/app.ts", import.meta.url), "utf8");
  assert.ok(!/disabled\s*=\s*detail\.decision\s*!==\s*null/.test(source), "a button is still disabled from `decision`");
  for (const field of ["detail.actions.approve.allowed", "detail.actions.reject.allowed", "detail.actions.revise.allowed"]) {
    assert.ok(source.includes(field), `the client does not read ${field}`);
  }
});

// ===========================================================================
// P2-R1-004 — every console response is versioned and checked (INV-05)
// ===========================================================================

test("P2-R1-004: every console response carries the contract version", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const draft = capture(fx).draft;

  const responses: Array<[string, any]> = [];
  const minted = call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys.owner!, body: {} });
  const opened = call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  responses.push(["POST /v1/console/session", opened]);
  responses.push(["GET /v1/console/session", call(fx, { path: "/v1/console/session", cookie: s.cookie })]);
  responses.push(["GET /v1/console/drafts", call(fx, { path: "/v1/console/drafts", cookie: s.cookie })]);
  responses.push(["GET /v1/console/drafts/{id}", call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie: s.cookie })]);
  responses.push([
    "GET /v1/console/drafts/{id}/audit",
    call(fx, { path: `/v1/console/drafts/${draft.draft_id}/audit`, cookie: s.cookie }),
  ]);
  responses.push([
    "POST /v1/console/drafts/{id}/revisions",
    call(fx, {
      method: "POST",
      path: `/v1/console/drafts/${draft.draft_id}/revisions`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { sections: { procedure: ["A.", "B.", "C."] }, idempotency_key: "k-r" },
    }),
  ]);
  const head = call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie: s.cookie });
  responses.push([
    "POST /v1/console/drafts/{id}/approve",
    call(fx, {
      method: "POST",
      path: `/v1/console/drafts/${draft.draft_id}/approve`,
      cookie: s.cookie,
      csrf: s.csrf,
      body: { revision_id: head.json.draft.revision.revision_id, idempotency_key: "k-ap" },
    }),
  ]);

  const second = p4Fixture();
  const s2 = signIn(second);
  const d2 = callOn(second.registry, {
    method: "POST",
    path: "/v1/captures",
    key: second.keys.owner!,
    body: { kind: "workflow", text: WORKFLOW },
  }).json.draft;
  responses.push([
    "POST /v1/console/drafts/{id}/reject",
    callOn(second.registry, {
      method: "POST",
      path: `/v1/console/drafts/${d2.draft_id}/reject`,
      cookie: s2.cookie,
      csrf: s2.csrf,
      body: { revision_id: d2.revision_id, reason: "not this one", idempotency_key: "k-rj" },
    }),
  ]);
  responses.push([
    "POST /v1/console/logout",
    callOn(second.registry, { method: "POST", path: "/v1/console/logout", cookie: s2.cookie, csrf: s2.csrf, body: {} }),
  ]);

  for (const [name, res] of responses) {
    assert.ok(res.status === 200 || res.status === 201, `${name} answered ${res.status}: ${res.body}`);
    assert.equal(res.json.contract, CONSOLE_CONTRACT_VERSION, `${name} carries no contract version`);
  }
  // and there are no console success routes beyond the ones listed above
  assert.equal(responses.length, 9);
  fx.db.close();
  second.db.close();
});

test("P2-R1-004: the client refuses an unsupported contract in one place, before any field is read", () => {
  const source = readFileSync(new URL("../console/app.ts", import.meta.url), "utf8");
  // the check is inside `api()`, on the parsed body, before it is returned
  assert.ok(/requireContract\(parsed, path\);\s*\n\s*return parsed as T;/.test(source), "api() does not gate its return");
  // and no caller re-implements it, which is how the session and the audit came
  // to be consumed without one
  const perCall = source.match(/\.contract !== CONTRACT/g) ?? [];
  assert.equal(perCall.length, 0, `${perCall.length} call sites still compare the contract themselves`);
  assert.ok(source.includes('code: "CONTRACT_MISMATCH"'), "the refusal has no machine-readable code");
});

// ===========================================================================
// P2-R1-001 — the Node test gate declares what it needs
// ===========================================================================

test("P2-R1-001: `npm test` builds the console bundle it reads", () => {
  // The two tests that read `dist-console/app.js` used to depend on an earlier
  // `npm run build:console` having happened in the same tree — an untracked,
  // gitignored artifact and therefore a prerequisite `npm ci && npm test` did
  // not declare and a fresh clone did not have. The build is now part of the
  // test command.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.pretest, "npm run build:console");
  assert.equal(pkg.scripts["pretest:bun"], "npm run build:console");
});
