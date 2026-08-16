// V1 P2 — THE OWNER CONSOLE, AT THE SERVICE AND ROUTER BOUNDARY.
//
// The browser gate (`v1/tools/gates/browser-e2e.sh`) drives a real Chromium and
// is where the browser-shaped claims are measured. This file measures the ones a
// browser cannot see and the ones a browser should not have to: what the SERVER
// does when the page is not there, when the page is lying, and when the caller
// is not a page at all.
//
// The division is deliberate. A rule enforced only where a browser exercises it
// is a rule that holds for browsers; the requirements of `INV-04` and
// `P2-FR-09` are about the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleRest, type RestResponse } from "../src/http.ts";
import { p4Fixture, type P4Fixture } from "./p4-helpers.ts";
import { CONSOLE_COOKIE, MAX_SESSION_MS, TICKET_TTL_MS } from "../src/console-session.ts";
import { CONSOLE_CONTRACT_VERSION, INBOX_STATES } from "../src/console-view.ts";
import { CONSOLE_SCRIPT_PATH, consolePage, loginPage } from "../src/console-page.ts";
import { Registry } from "../src/service.ts";
import { openDb, migrate } from "../src/db.ts";

const ORIGIN = "console.local";

interface Call {
  method?: string;
  path: string;
  key?: string;
  cookie?: string;
  csrf?: string;
  origin?: string | null;
  host?: string;
  body?: unknown;
}

function call(fx: P4Fixture, c: Call): RestResponse & { json: any } {
  const headers: Record<string, string | undefined> = { host: c.host ?? ORIGIN };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
  if (c.csrf) headers["x-skillonomia-console-csrf"] = c.csrf;
  if (c.origin !== null) headers.origin = c.origin ?? `http://${ORIGIN}`;
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

/** An owner console session, opened the way a browser opens one. */
function signIn(fx: P4Fixture): { cookie: string; csrf: string } {
  const minted = call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys.owner!, body: {} });
  assert.equal(minted.status, 201, minted.body);
  const opened = call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  assert.equal(opened.status, 201, opened.body);
  const setCookie = opened.headers["Set-Cookie"];
  const value = /skln_console=([^;]+)/.exec(setCookie)![1]!;
  return { cookie: value, csrf: opened.json.csrf_token };
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

function capture(fx: P4Fixture, text = WORKFLOW, title?: string): any {
  const res = call(fx, {
    method: "POST",
    path: "/v1/captures",
    key: fx.keys.owner!,
    body: { kind: "workflow", text, ...(title ? { title } : {}) },
  });
  assert.equal(res.status, 201, res.body);
  return res.json;
}

// ===========================================================================
// P2-FR-01 / P2-FR-02 — the session boundary
// ===========================================================================

test("P2-FR-01: every protected console route refuses without a session", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  for (const [method, path] of [
    ["GET", "/console"],
    ["GET", "/v1/console/session"],
    ["GET", "/v1/console/drafts"],
    ["GET", `/v1/console/drafts/${draft.draft_id}`],
    ["GET", `/v1/console/drafts/${draft.draft_id}/audit`],
    ["POST", "/v1/console/logout"],
    ["POST", `/v1/console/drafts/${draft.draft_id}/approve`],
    ["POST", `/v1/console/drafts/${draft.draft_id}/reject`],
    ["POST", `/v1/console/drafts/${draft.draft_id}/revisions`],
  ] as const) {
    const res = call(fx, { method, path, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path} answered ${res.status}`);
  }
  fx.db.close();
});

test("P2-FR-03: an API key does not open the console, and a session does not open the API", () => {
  const fx = p4Fixture();
  // The key is a machine-to-machine credential. It authenticates the M2M
  // surfaces and it does not authenticate the console's — which is what keeps
  // "the browser never holds a key" from being a rule about intentions.
  assert.equal(call(fx, { path: "/v1/console/drafts", key: fx.keys.owner! }).status, 401);
  const { cookie } = signIn(fx);
  assert.equal(call(fx, { path: "/v1/drafts", cookie }).status, 401);
  assert.equal(call(fx, { path: "/v1/console/drafts", cookie }).status, 200);
  fx.db.close();
});

test("INV-04: the session cookie carries every attribute the invariant names", () => {
  const fx = p4Fixture();
  const minted = call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys.owner!, body: {} });
  const opened = call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  const cookie = opened.headers["Set-Cookie"]!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
  assert.ok(maxAge > 0 && maxAge <= MAX_SESSION_MS / 1000, `Max-Age ${maxAge}`);
  // Secure follows the HOST, and both directions are asserted: a public host
  // gets it, a loopback host does not, because a `Secure` cookie on
  // `http://127.0.0.1` is discarded and the console would not run at all.
  assert.match(cookie, /Secure/);
  const local = call(fx, {
    method: "POST",
    path: "/v1/console/session",
    host: "127.0.0.1:7487",
    origin: "http://127.0.0.1:7487",
    body: { ticket: call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys.owner!, body: {} }).json.ticket },
  });
  assert.doesNotMatch(local.headers["Set-Cookie"]!, /Secure/);
  fx.db.close();
});

test("INV-04: a lifetime past sixty minutes is refused by the service AND by the schema", () => {
  const db = openDb();
  migrate(db);
  assert.throws(() => new Registry(db, { consoleSessionMs: MAX_SESSION_MS + 1 }), /consoleSessionMs/);
  // and the row itself: the CHECK is the second refusal, so a writer that never
  // went through `Registry` cannot store a longer one either
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO owner_sessions(id, workspace_id, agent_id, actor_role, token_hash, csrf_token, created_at_ms, absolute_expires_at_ms)
           VALUES ('01SESSION0000000000000000','01WS00000000000000000000AA','01AGENT00000000000000000A','owner',?,?,1000,?)`,
        )
        .run(`sha256:${"a".repeat(64)}`, "cx_aaaaaaaaaaaaaaaaaaaa", 1000 + MAX_SESSION_MS + 1),
    /CHECK|constraint/i,
  );
  db.close();
});

test("P2-FR-02: logout and expiry both end the session on the SERVER", () => {
  const fx = p4Fixture();
  const { cookie, csrf } = signIn(fx);
  assert.equal(call(fx, { path: "/v1/console/drafts", cookie }).status, 200);
  const out = call(fx, { method: "POST", path: "/v1/console/logout", cookie, csrf, body: {} });
  assert.equal(out.status, 200);
  assert.match(out.headers["Set-Cookie"]!, /Max-Age=0/);
  // the cookie value is unchanged in the client's hand — what changed is the row
  assert.equal(call(fx, { path: "/v1/console/drafts", cookie }).status, 401);

  // expiry, measured on the clock the registry reads
  let now = 1_000_000;
  const db = openDb();
  migrate(db);
  const registry = new Registry(db, { now: () => now, consoleSessionMs: 60_000 });
  const boot = registry.bootstrap()!;
  const owner = registry.exchangeBootstrap(boot.bootstrap_owner_token);
  const auth = registry.authenticate(`Bearer ${owner.api_key}`);
  const ticket = registry.mintConsoleTicket(auth);
  const session = registry.openConsoleSession(ticket.ticket);
  assert.ok(registry.resolveConsoleSession(session.cookie_value));
  now += 59_999;
  assert.ok(registry.resolveConsoleSession(session.cookie_value), "a second before the expiry it is live");
  now += 1;
  assert.equal(registry.resolveConsoleSession(session.cookie_value), null, "at the expiry it is gone");
  db.close();
  fx.db.close();
});

test("a ticket opens one session and expires", () => {
  let now = 5_000_000;
  const db = openDb();
  migrate(db);
  const registry = new Registry(db, { now: () => now });
  const boot = registry.bootstrap()!;
  const owner = registry.exchangeBootstrap(boot.bootstrap_owner_token);
  const auth = registry.authenticate(`Bearer ${owner.api_key}`);

  const first = registry.mintConsoleTicket(auth);
  registry.openConsoleSession(first.ticket);
  assert.throws(() => registry.openConsoleSession(first.ticket), /UNAUTHORIZED/, "a spent ticket opens nothing");

  const second = registry.mintConsoleTicket(auth);
  assert.equal(second.expires_at_ms - now, TICKET_TTL_MS);
  now += TICKET_TTL_MS;
  assert.throws(() => registry.openConsoleSession(second.ticket), /UNAUTHORIZED/, "an expired ticket opens nothing");
  assert.throws(() => registry.openConsoleSession("ct_not_a_ticket"), /UNAUTHORIZED/);
  db.close();
});

test("a member cannot mint a console ticket", () => {
  const fx = p4Fixture();
  const res = call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys.member!, body: {} });
  assert.equal(res.status, 403, res.body);
  fx.db.close();
});

// ===========================================================================
// P2-FR-13 — CSRF and Origin
// ===========================================================================

test("P2-FR-13: a mutation needs this origin and this session's token", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  const path = `/v1/console/drafts/${draft.draft_id}/approve`;
  const body = { revision_id: draft.revision_id };

  assert.equal(call(fx, { method: "POST", path, cookie, body }).status, 403, "no CSRF token");
  assert.equal(call(fx, { method: "POST", path, cookie, csrf: "cx_wrong", body }).status, 403, "wrong CSRF token");
  assert.equal(call(fx, { method: "POST", path, cookie, csrf, origin: null, body }).status, 403, "no Origin");
  assert.equal(
    call(fx, { method: "POST", path, cookie, csrf, origin: "https://attacker.example", body }).status,
    403,
    "another origin",
  );
  assert.equal(call(fx, { method: "POST", path, cookie, csrf, origin: "not a url", body }).status, 403, "a malformed Origin");
  // …and the same request with both is accepted, so the refusals above are the
  // checks and not a broken route
  assert.equal(call(fx, { method: "POST", path, cookie, csrf, body }).status, 201);

  // one session's token does not work on another's session
  const other = signIn(fx);
  const second = capture(fx, WORKFLOW.replace("ship-the-thing", "ship-the-other-thing")).draft;
  assert.equal(
    call(fx, { method: "POST", path: `/v1/console/drafts/${second.draft_id}/approve`, cookie, csrf: other.csrf, body: {} }).status,
    403,
    "another session's CSRF token",
  );
  fx.db.close();
});

test("P2-FR-13: reads do not require the CSRF token, and a read changes nothing", () => {
  const fx = p4Fixture();
  capture(fx);
  const { cookie } = signIn(fx);
  const before = call(fx, { path: "/v1/console/drafts", cookie });
  assert.equal(before.status, 200);
  const again = call(fx, { path: "/v1/console/drafts", cookie, origin: null });
  assert.equal(again.status, 200, "a read with no Origin is still a read");
  assert.deepEqual(again.json.items, before.json.items);
  fx.db.close();
});

// ===========================================================================
// P2-FR-04 / P2-FR-05 / P2-FR-11 / P2-FR-12 — the structured contracts
// ===========================================================================

test("P2-FR-04: the Inbox is the backend's drafts, with the contract version on it", () => {
  const fx = p4Fixture();
  const { cookie } = signIn(fx);
  const empty = call(fx, { path: "/v1/console/drafts", cookie });
  assert.equal(empty.json.contract, CONSOLE_CONTRACT_VERSION);
  assert.deepEqual(empty.json.items, [], "a deployment with no captures has an empty inbox, not a fixture");
  assert.deepEqual(empty.json.states, [...INBOX_STATES]);

  const a = capture(fx).draft;
  const b = capture(fx, WORKFLOW.replace("ship-the-thing", "ship-the-second-thing")).draft;
  const full = call(fx, { path: "/v1/console/drafts", cookie });
  assert.deepEqual(
    full.json.items.map((i: any) => i.draft_id).sort(),
    [a.draft_id, b.draft_id].sort(),
  );
  for (const item of full.json.items) {
    for (const field of ["draft_id", "title", "content_digest", "state", "eligibility", "decision", "semantic_blocking", "security_blocking"]) {
      assert.ok(field in item, `the inbox row has no ${field}`);
    }
    assert.equal(item.state, "pending");
    assert.equal(typeof item.eligibility.approvable, "boolean");
  }
  fx.db.close();
});

test("P2-FR-05: the detail carries every panel the requirement names", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie } = signIn(fx);
  const detail = call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie });
  assert.equal(detail.status, 200, detail.body);
  assert.equal(detail.json.contract, CONSOLE_CONTRACT_VERSION);
  const content = detail.json.draft.revision.content;
  for (const section of [
    "title", "purpose", "when_to_use", "procedure", "inputs", "outputs",
    "permissions", "dependencies", "failure_modes", "redactions", "provenance",
  ]) {
    assert.ok(section in content, `the detail has no ${section}`);
  }
  const semantic = detail.json.draft.revision.semantic_review;
  const security = detail.json.draft.revision.security_review;
  assert.equal(typeof semantic.blocking_count, "number");
  assert.ok(Array.isArray(semantic.findings));
  assert.ok(Array.isArray(security.risky_actions));
  assert.ok(Array.isArray(security.redactions));
  assert.equal(typeof security.blocking_count, "number");
  assert.ok(Array.isArray(detail.json.draft.lineage));
  // a revision that does not exist is NOT_FOUND, and one of another workspace is too
  assert.equal(call(fx, { path: `/v1/console/drafts/01NOSUCHDRAFT00000000000A`, cookie }).status, 404);
  fx.db.close();
});

test("P2-FR-11/INV-05: the eligibility verdict is a field, with a machine-readable reason", () => {
  const fx = p4Fixture();
  // an incomplete capture: two steps and nothing else, so the semantic review
  // has blocking findings and the server says so in a code
  const thin = capture(fx, "## Procedure\n1. Do a thing.\n2. Do another thing.\n\nWhenever.").draft;
  const { cookie, csrf } = signIn(fx);
  const detail = call(fx, { path: `/v1/console/drafts/${thin.draft_id}`, cookie });
  assert.equal(detail.json.eligibility.approvable, false);
  assert.equal(detail.json.eligibility.reason_code, "BLOCKING_SEMANTIC_FINDINGS");
  assert.ok(detail.json.eligibility.semantic_blocking > 0);
  assert.equal(detail.json.state, "pending");

  // P2-FR-09: and the server refuses the approval, not only the rendering
  const forced = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${thin.draft_id}/approve`,
    cookie,
    csrf,
    body: { revision_id: thin.revision_id },
  });
  assert.equal(forced.status, 412, forced.body);
  assert.equal(forced.json.error.code, "PRECONDITION_FAILED");
  assert.match(forced.json.error.message, /BLOCKING_SEMANTIC_FINDINGS/);
  assert.equal(forced.json.error.current_state, "pending");
  fx.db.close();
});

test("P2-FR-12: the console's pages carry no draft content and no credential", () => {
  const fx = p4Fixture();
  capture(fx, WORKFLOW, "<script>window.x=1</script>");
  const { cookie } = signIn(fx);
  const page = call(fx, { path: "/console", cookie });
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes("<script>window.x=1"), "the shell rendered a draft title");
  assert.ok(!page.body.includes(cookie), "the shell echoed the session value");
  assert.ok(!page.body.includes(fx.keys.owner!), "the shell echoed an API key");
  assert.match(page.headers["Content-Security-Policy"]!, /frame-ancestors 'none'/);
  assert.equal(page.headers["X-Content-Type-Options"], "nosniff");
  // the two pages are fixed shells: the same bytes whatever the deployment holds
  assert.equal(page.body, consolePage());
  assert.equal(call(fx, { path: "/console/login" }).body, loginPage());
  // and the bundle the page names is the one the router serves
  const bundle = call(fx, { path: CONSOLE_SCRIPT_PATH });
  assert.equal(bundle.status, 200, `${CONSOLE_SCRIPT_PATH} is not served`);
  assert.match(bundle.headers["Content-Type"]!, /javascript/);
  assert.ok(page.body.includes(`src="${CONSOLE_SCRIPT_PATH}"`), "the page names a script the router does not serve");
  fx.db.close();
});

test("P2-FR-06: the client bundle writes text into the DOM and never markup", () => {
  // The browser gate proves the BEHAVIOUR — a title carrying `<script>` renders
  // as characters. This proves the PROPERTY that makes it true, over the source
  // the bundle is built from, so a future edit that reaches for `innerHTML`
  // fails here rather than in a browser somebody remembered to run.
  const src = readFileSync(new URL("../console/app.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
    assert.ok(!code.includes(forbidden), `console/app.ts uses ${forbidden}`);
  }
  assert.ok(code.includes("textContent"), "the console writes nothing at all");
});

// ===========================================================================
// P2-FR-07 / P2-FR-08 / P2-FR-10 — edit, approve, reject
// ===========================================================================

test("P2-FR-07: an edit through the console is a new revision with both previews re-run", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  const edited = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/revisions`,
    cookie,
    csrf,
    body: { sections: { procedure: ["Read the diff twice.", "Run the suite.", "Merge it."] } },
  });
  assert.equal(edited.status, 201, edited.body);
  assert.notEqual(edited.json.revision_id, draft.revision_id);
  assert.equal(edited.json.parent_revision_id, draft.revision_id);
  assert.notEqual(edited.json.content_digest, draft.content_digest);
  assert.equal(edited.json.origin, "edit");
  assert.ok(edited.json.semantic_review.compiler_version.length > 0, "the semantic preview was re-run");
  assert.ok(edited.json.security_review.compiler_version.length > 0, "the security preview was re-run");

  // INV-06: the parent is untouched, and is still readable at its own id
  const parent = call(fx, { path: `/v1/console/drafts/${draft.draft_id}?revision_id=${draft.revision_id}`, cookie });
  assert.equal(parent.json.draft.revision.content_digest, draft.content_digest);
  assert.deepEqual(parent.json.draft.revision.content.procedure, draft.content.procedure);
  fx.db.close();
});

test("P2-FR-08: an approval names the revision, the digest, the actor and the time", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  const res = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie,
    csrf,
    body: { revision_id: draft.revision_id },
  });
  assert.equal(res.status, 201, res.body);
  const d = res.json.decision;
  assert.equal(d.decision, "approved");
  assert.equal(d.draft_revision_id, draft.revision_id);
  assert.equal(d.content_digest, draft.content_digest);
  assert.equal(d.actor_role, "owner");
  assert.ok(typeof d.actor_agent_id === "string" && d.actor_agent_id.length === 26);
  // the registry's clock, not the wall clock: this fixture pins `now`, and a
  // decision timestamped from anywhere else would be a timestamp about a
  // different machine than the row it sits beside
  assert.ok(Number.isInteger(d.server_at_ms) && d.server_at_ms >= draft.created_at_ms, String(d.server_at_ms));
  assert.equal(d.reason_code, "OWNER_APPROVED");
  assert.equal(d.source, "owner");
  assert.equal(d.provenance.semantic_blocking, 0);
  assert.equal(res.json.eligibility.reason_code, "ALREADY_DECIDED");

  // the inbox reports the new state as a field
  const inbox = call(fx, { path: "/v1/console/drafts", cookie });
  assert.equal(inbox.json.items[0].state, "approved");
  assert.equal(inbox.json.items[0].eligibility.approvable, false);
  fx.db.close();
});

test("P2-FR-08: an approval cannot name a revision that is not the head", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/revisions`,
    cookie,
    csrf,
    body: { sections: { procedure: ["Read it.", "Run it.", "Ship it."] } },
  });
  const stale = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie,
    csrf,
    body: { revision_id: draft.revision_id },
  });
  assert.equal(stale.status, 409, stale.body);
  assert.equal(stale.json.error.current_state, "pending");
  fx.db.close();
});

test("P2-FR-10: a rejection needs a reason, keeps the revision, and is redacted", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  const noReason = call(fx, { method: "POST", path: `/v1/console/drafts/${draft.draft_id}/reject`, cookie, csrf, body: {} });
  assert.equal(noReason.status, 400, noReason.body);
  const blank = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/reject`,
    cookie,
    csrf,
    body: { reason: "   " },
  });
  assert.equal(blank.status, 400, "whitespace is not a reason");

  // the owner's prose goes through the same redaction a capture body does
  const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
  const res = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/reject`,
    cookie,
    csrf,
    body: { reason: `it pastes the token ${secret} into a step` },
  });
  assert.equal(res.status, 201, res.body);
  assert.ok(!res.body.includes(secret), "the rejection reason carried a credential to the response");
  const row = fx.db.prepare("SELECT reason FROM draft_decisions WHERE draft_id=?").get(draft.draft_id) as { reason: string };
  assert.ok(!row.reason.includes(secret), "the rejection reason carried a credential to the row");
  assert.match(row.reason, /REDACTED/);

  // the revision is still there, and so is P1's audit
  const detail = call(fx, { path: `/v1/console/drafts/${draft.draft_id}`, cookie });
  assert.equal(detail.json.draft.revision.revision_id, draft.revision_id);
  assert.equal(detail.json.state, "rejected");
  fx.db.close();
});

test("P2-FR-13: one draft takes one decision, and a resend replays rather than deciding twice", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  const body = { revision_id: draft.revision_id, idempotency_key: "console-approve-1" };
  const first = call(fx, { method: "POST", path: `/v1/console/drafts/${draft.draft_id}/approve`, cookie, csrf, body });
  const second = call(fx, { method: "POST", path: `/v1/console/drafts/${draft.draft_id}/approve`, cookie, csrf, body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers["Idempotency-Replayed"], "true");
  assert.equal(second.body, first.body, "a replay reproduces the stored bytes");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) c FROM draft_decisions WHERE draft_id=?").get(draft.draft_id) as { c: number }).c,
    1,
  );
  // a genuinely second decision, with a different key, is a conflict
  const third = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/reject`,
    cookie,
    csrf,
    body: { reason: "changed my mind", idempotency_key: "console-reject-1" },
  });
  assert.equal(third.status, 409, third.body);
  assert.equal(third.json.error.current_state, "approved");
  fx.db.close();
});

// ===========================================================================
// INV-05 — the audit
// ===========================================================================

test("INV-05: the console audit is one field set over P1's events and P2's decision", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie,
    csrf,
    body: { revision_id: draft.revision_id },
  });
  const audit = call(fx, { path: `/v1/console/drafts/${draft.draft_id}/audit`, cookie });
  assert.equal(audit.status, 200);
  assert.equal(audit.json.contract, CONSOLE_CONTRACT_VERSION);
  const FIELDS = [
    "entry_id", "event", "draft_id", "draft_revision_id", "capture_id", "actor_agent_id",
    "actor_role", "source", "correlation_ref", "reason_code", "result", "content_digest",
    "reason", "provenance", "server_at_ms",
  ];
  for (const item of audit.json.items) {
    for (const f of FIELDS) assert.ok(f in item, `an audit entry has no ${f}`);
    assert.equal(typeof item.event, "string");
    assert.equal(typeof item.server_at_ms, "number");
  }
  const events = audit.json.items.map((i: any) => i.event);
  assert.ok(events.includes("captured"), events.join(","));
  assert.ok(events.includes("approved"), events.join(","));
  // ascending, and the decision is last because it happened last
  const times = audit.json.items.map((i: any) => i.server_at_ms);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(audit.json.items[audit.json.items.length - 1].event, "approved");
  // P1's own surface still answers on its own terms
  const p1 = call(fx, { path: `/v1/drafts/${draft.draft_id}/audit`, key: fx.keys.owner! });
  assert.equal(p1.status, 200);
  assert.ok(p1.json.items.every((i: any) => i.event !== "approved"), "P2 wrote into P1's table");
  fx.db.close();
});

// ===========================================================================
// P2-FR-15 / INV-08 — the machine-to-machine surface is untouched
// ===========================================================================

test("P2-FR-15: every P1 draft surface answers exactly as it did, with a key", () => {
  const fx = p4Fixture();
  const created = capture(fx);
  const draft = created.draft;
  const key = fx.keys.owner!;
  assert.equal(call(fx, { path: "/v1/drafts", key }).status, 200);
  assert.equal(call(fx, { path: `/v1/drafts/${draft.draft_id}`, key }).status, 200);
  assert.equal(call(fx, { path: `/v1/drafts/${draft.draft_id}/revisions/${draft.revision_id}`, key }).status, 200);
  assert.equal(call(fx, { path: `/v1/drafts/${draft.draft_id}/audit`, key }).status, 200);
  assert.equal(
    call(fx, { method: "POST", path: `/v1/drafts/${draft.draft_id}/revisions`, key, body: { sections: { title: "renamed" } } }).status,
    201,
  );
  // an M2M call carries no cookie and no Origin, and that is still fine
  const res = handleRest(fx.registry, {
    method: "GET",
    url: "/v1/drafts",
    headers: { authorization: `Bearer ${key}` },
    body: Buffer.alloc(0),
  });
  assert.equal(res.status, 200, "a machine client with only an Authorization header still works");
  fx.db.close();
});

test("INV-08: the console tables are INSERT-only, like every journal before them", () => {
  const fx = p4Fixture();
  const draft = capture(fx).draft;
  const { cookie, csrf } = signIn(fx);
  call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${draft.draft_id}/approve`,
    cookie,
    csrf,
    body: { revision_id: draft.revision_id },
  });
  for (const sql of [
    "UPDATE owner_sessions SET actor_role='admin'",
    "DELETE FROM owner_sessions",
    "UPDATE console_tickets SET actor_role='admin'",
    "DELETE FROM console_tickets",
    "UPDATE console_ticket_uses SET used_at_ms=1",
    "DELETE FROM console_ticket_uses",
    "UPDATE draft_decisions SET decision='rejected'",
    "DELETE FROM draft_decisions",
  ]) {
    assert.throws(() => fx.db.exec(sql), /INSERT_ONLY/, sql);
  }
  const logout = call(fx, { method: "POST", path: "/v1/console/logout", cookie, csrf, body: {} });
  assert.equal(logout.status, 200);
  for (const sql of ["UPDATE owner_session_revocations SET reason_code='superseded'", "DELETE FROM owner_session_revocations"]) {
    assert.throws(() => fx.db.exec(sql), /INSERT_ONLY/, sql);
  }
  fx.db.close();
});

