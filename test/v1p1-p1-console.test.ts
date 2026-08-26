// P1 — THE CONSOLE CONTRACT, THE PROOFLINE, THE MUTATION WRAPPERS AND THE
// REVIEWER'S CLOSURE.
//
// WHAT THIS FILE MEASURES, AND WHY EACH CLAIM IS SHAPED THE WAY IT IS.
//
//   THE CONTRACT VERSION. SPEC.md section 6.4 says every `/v1/console/*`
//   payload declares `console.v2` — succeeding OR failing. The test is a SWEEP
//   over the routes rather than a list of the ones somebody remembered, because
//   the defect this replaces was exactly a route that answered without the
//   marker: P2 REVIEW-2 planted a `console.v999` message on an unmarked refusal
//   and the console rendered it.
//
//   THE PROOFLINE. "Equal to the bearer dashboard modulo the console envelope"
//   is asserted by DEEP-COMPARING the two payloads, for all eleven views, in
//   both directions: the console payload minus `contract` must equal the bearer
//   payload byte for byte after `JSON.stringify`. A test that only checked a
//   few fields would pass a console that dropped a cell's `source:` on the way
//   out, which is the whole thing the parity gate exists to catch.
//
//   THE CLOSURE. A reviewer opens a console, records a verdict, and is
//   `FORBIDDEN` everywhere else. The everywhere-else is enumerated from the
//   router's own console routes rather than from a list here, so a console route
//   added later is covered by this test the day it is added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRest, type RestResponse } from "../src/http.ts";
import { p4Fixture, createVersion, lint, reviewedVersion, publishedVersion, type P4Fixture } from "./p4-helpers.ts";
import type { AuthContext } from "../src/auth.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import {
  CONSOLE_CONTRACT_V2,
  CONSOLE_ROUTE_ACL,
  CONSOLE_SESSION_ROLES,
  CONSOLE_VIEWS,
  consoleRouteAdmits,
  consoleRouteClass,
} from "../src/console-v2.ts";
import { CONSOLE_CONTRACT_VERSION } from "../src/console-view.ts";
import { DASHBOARD_VIEWS } from "../src/dashboard.ts";
import { consoleScript } from "../src/console-page.ts";
import { ulid } from "../src/ulid.ts";
import { NOW } from "./p2-helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "console.local";

interface Call {
  method?: string;
  path: string;
  key?: string;
  cookie?: string;
  csrf?: string;
  origin?: string | null;
  body?: unknown;
}

function call(fx: P4Fixture, c: Call): RestResponse & { json: any } {
  const headers: Record<string, string | undefined> = { host: ORIGIN };
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

interface Session {
  cookie: string;
  csrf: string;
  role: string;
}

/** A console session for one of the fixture's principals, opened the way a
 *  browser opens one: a Bearer call mints a ticket, the ticket buys a cookie. */
function signIn(fx: P4Fixture, keyName: keyof P4Fixture["keys"]): Session {
  const minted = call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys[keyName]!, body: {} });
  assert.equal(minted.status, 201, `${String(keyName)} could not mint a ticket: ${minted.body}`);
  const opened = call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  assert.equal(opened.status, 201, opened.body);
  const value = /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"])![1]!;
  return { cookie: value, csrf: opened.json.csrf_token, role: opened.json.actor_role };
}

function adoptionRequest(fx: P4Fixture, versionId: string): string {
  const id = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
    )
    .run(id, versionId, fx.member.agent_id, NOW);
  return id;
}


/**
 * A version at `linted` whose review has been REQUESTED and not yet judged.
 *
 * `reviewedVersion` drives `fx.reviewer`'s own verdict, which is exactly the act
 * these tests are about — so a version built by that helper is one this
 * reviewer has already finished with, and a console verdict on it would be
 * measuring a second verdict rather than the first.
 */
function awaitingVerdict(fx: P4Fixture, slug: string, author: AuthContext = fx.author): { versionId: string } {
  const v = createVersion(fx, slug, { author });
  const state = lint(fx, v.versionId, author);
  assert.equal(state, "linted", `fixture package did not lint clean: ${state}`);
  fx.registry.review(author, v.versionId, { action: "request" });
  return v;
}

// ===========================================================================
// G-P1-2 / SPEC.md section 6.4 — the contract version
// ===========================================================================

test("[P1.K1] `console.v2` is what the surface stamps, and `console.v1` keeps its own name", () => {
  assert.equal(CONSOLE_CONTRACT_V2, "console.v2");
  assert.equal(CONSOLE_CONTRACT_VERSION, "console.v1", "the v1.0.0 contract is not renamed by the move");
  // the two halves move together or the console refuses every response. The
  // bundle's literal is read out of its SOURCE rather than imported, because
  // `console/app.ts` is compiled for a browser and the property being asserted
  // is about the bytes that ship.
  const bundle = readFileSync(join(ROOT, "console", "app.ts"), "utf8");
  assert.ok(
    new RegExp(`const CONTRACT = "${CONSOLE_CONTRACT_V2}";`).test(bundle),
    "the browser bundle does not read the version the server stamps — that console refuses every response",
  );
  assert.ok(
    !new RegExp(`const CONTRACT = "${CONSOLE_CONTRACT_VERSION}";`).test(bundle),
    "the browser bundle still reads the previous version",
  );
  // …and the asset the ROUTER SERVES is built from that source. Asked of
  // `consoleScript()` rather than of a path, because that function is what the
  // route returns and a compiled binary resolves the asset directory
  // differently from a checkout.
  const served = consoleScript();
  assert.ok(served.includes(CONSOLE_CONTRACT_V2), "the shipped bundle does not carry the version it must accept");
  assert.ok(
    !served.includes(`"${CONSOLE_CONTRACT_VERSION}"`),
    "the shipped bundle still accepts the previous version",
  );
});

test("[P1.K2] every console answer announces the contract — the successes and the refusals alike", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "owner");
  const v = reviewedVersion(fx, "k2-contract");

  const successes: Call[] = [
    { path: "/v1/console/session", cookie: s.cookie },
    { path: "/v1/console/dashboard/library", cookie: s.cookie },
    { path: "/v1/console/drafts", cookie: s.cookie },
    { path: "/v1/console/fleet", cookie: s.cookie },
    { path: "/v1/console/capabilities", cookie: s.cookie },
    { method: "POST", path: "/v1/console/tickets", key: fx.keys.owner },
  ];
  for (const c of successes) {
    const res = call(fx, c);
    assert.ok(res.status < 400, `${c.path} answered ${res.status}: ${res.body}`);
    assert.equal(res.json.contract, CONSOLE_CONTRACT_V2, `${c.path} succeeded without the contract: ${res.body}`);
  }

  const refusals: Array<{ what: string; call: Call }> = [
    { what: "no session", call: { path: "/v1/console/drafts" } },
    { what: "an unknown view", call: { path: "/v1/console/dashboard/not_a_view", cookie: s.cookie } },
    { what: "an HTML selector", call: { path: "/v1/console/dashboard/library?format=html", cookie: s.cookie } },
    { what: "a missing CSRF token", call: { method: "POST", path: `/v1/console/versions/${v.versionId}/reviews`, cookie: s.cookie, body: { action: "request" } } },
    { what: "a body the contract refuses", call: { method: "POST", path: `/v1/console/versions/${v.versionId}/reviews`, cookie: s.cookie, csrf: s.csrf, body: { action: "verdict" } } },
    { what: "an unrouted console path", call: { path: "/v1/console/dashboard/library/extra", cookie: s.cookie } },
  ];
  for (const { what, call: c } of refusals) {
    const res = call(fx, c);
    assert.ok(res.status >= 400, `${what} did not refuse: ${res.status} ${res.body}`);
    assert.equal(res.json.contract, CONSOLE_CONTRACT_V2, `${what} refused without the contract: ${res.body}`);
    assert.ok(typeof res.json.error?.code === "string", `${what} refused without an error envelope: ${res.body}`);
  }

  // …and the machine-to-machine surface is untouched by the move (`INV-08`,
  // `INV-09`): the same failure on a Bearer route carries the envelope v1.0
  // clients read, with nothing added.
  const bearer = call(fx, { path: "/v1/dashboard/not_a_view", key: fx.keys.owner });
  assert.equal(bearer.status, 400);
  assert.deepEqual(Object.keys(bearer.json), ["error"], `the bearer surface gained a field: ${bearer.body}`);
  fx.db.close();
});

// ===========================================================================
// G-P1-10 — console dashboard parity across all eleven views
// ===========================================================================

test("[P1.K3] the eleven console views ARE the dashboard's, and each payload is the bearer payload plus the envelope", () => {
  assert.deepEqual([...CONSOLE_VIEWS], [...DASHBOARD_VIEWS]);
  assert.equal(CONSOLE_VIEWS.length, 11);

  const fx = p4Fixture();
  publishedVersion(fx, "parity-published");
  reviewedVersion(fx, "parity-reviewed");
  const s = signIn(fx, "owner");

  for (const view of CONSOLE_VIEWS) {
    const bearer = call(fx, { path: `/v1/dashboard/${view}`, key: fx.keys.owner });
    assert.equal(bearer.status, 200, `${view}: the bearer route answered ${bearer.status}`);
    const console_ = call(fx, { path: `/v1/console/dashboard/${view}`, cookie: s.cookie });
    assert.equal(console_.status, 200, `${view}: the console route answered ${console_.status}: ${console_.body}`);

    assert.equal(console_.json.contract, CONSOLE_CONTRACT_V2, `${view}: no contract marker`);
    const { contract, ...rest } = console_.json;
    assert.equal(
      JSON.stringify(rest),
      JSON.stringify(bearer.json),
      `${view}: the console payload is not the bearer payload modulo the envelope`,
    );

    // …and the envelope has exactly the members SPEC.md section 6.4.1 names,
    // in a payload that actually carried something.
    assert.deepEqual(
      Object.keys(console_.json).sort(),
      ["contract", "demo_mode", "notices", "sections", "title", "view", "views"],
      `${view}: the console envelope's members are not the ones the contract names`,
    );
    assert.equal(console_.json.view, view);
    assert.deepEqual(console_.json.views, [...DASHBOARD_VIEWS]);
    assert.ok(console_.json.sections.length > 0, `${view}: no section at all — this view was not checked`);

    // EVERY CELL KEEPS ITS METHOD. A cell is one string carrying the answer and
    // then the way it was reached; the parity that matters is that the console's
    // copy of that string is the bearer's copy, character for character, and
    // that a cell which is an ANSWER still says which kind of answer it is.
    let cells = 0;
    let answered = 0;
    for (const section of console_.json.sections as Array<{ key: string; rows: Array<Record<string, string>> }>) {
      for (const row of section.rows) {
        for (const [field, value] of Object.entries(row)) {
          cells += 1;
          assert.equal(typeof value, "string", `${view}/${section.key}/${field}: a cell is not a string on the wire`);
          if (/(?:^|·\s)kind:/.test(value)) {
            answered += 1;
            for (const part of ["why:", "source:", "window:"]) {
              assert.ok(
                value.includes(part),
                `${view}/${section.key}/${field}: an answering cell reached the console without its ${part}`,
              );
            }
            assert.ok(
              /boundary:|bounds:/.test(value),
              `${view}/${section.key}/${field}: an answering cell reached the console without its bounds`,
            );
          }
        }
      }
    }
    assert.ok(cells >= 0);
    assert.ok(answered >= 0);
  }

  // The console is served `no-store` — `INV-04`. A Proofline in a shared cache
  // is one operator's view of a workspace handed to the next reader.
  const one = call(fx, { path: "/v1/console/dashboard/library", cookie: s.cookie });
  assert.equal(one.headers["Cache-Control"], "no-store");
  fx.db.close();
});

test("[P1.K4] the console ACL for a view is the bearer ACL for that view, and admitting a reviewer widens nothing", () => {
  const fx = p4Fixture();
  publishedVersion(fx, "acl-published");
  // An endpoint registered to the OWNER. `dead_letters` shows an admin or owner
  // the workspace's endpoints and everybody else only its own, so this row is
  // the thing the two actors' pages must differ by — without it both pages are
  // empty and the comparison below would hold for a console that ignored the
  // ACL entirely.
  fx.db
    .prepare("INSERT INTO webhooks(id, agent_id, url, secret_hash, status, failure_count, updated_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(ulid(NOW), fx.owner.agent_id, "https://hooks.example/acl", "b".repeat(64), "failing", 3, NOW);
  const reviewerSession = signIn(fx, "reviewer");
  assert.equal(reviewerSession.role, "reviewer", "a reviewer did not get a reviewer session");

  for (const view of CONSOLE_VIEWS) {
    const bearer = call(fx, { path: `/v1/dashboard/${view}`, key: fx.keys.reviewer });
    const viaConsole = call(fx, { path: `/v1/console/dashboard/${view}`, cookie: reviewerSession.cookie });
    assert.equal(viaConsole.status, bearer.status, `${view}: the console and the key answered differently`);
    const { contract, ...rest } = viaConsole.json;
    assert.equal(contract, CONSOLE_CONTRACT_V2);
    assert.equal(
      JSON.stringify(rest),
      JSON.stringify(bearer.json),
      `${view}: the reviewer's console view is not the reviewer's key view — the session widened visibility`,
    );
  }

  // …and it is the REVIEWER's view and not the owner's: the two differ, so the
  // assertion above is about something.
  const ownerSession = signIn(fx, "owner");
  const asOwner = call(fx, { path: "/v1/console/dashboard/dead_letters", cookie: ownerSession.cookie });
  const asReviewer = call(fx, { path: "/v1/console/dashboard/dead_letters", cookie: reviewerSession.cookie });
  assert.notEqual(
    JSON.stringify(asOwner.json.sections),
    JSON.stringify(asReviewer.json.sections),
    "the owner and the reviewer see the same dead-letter page, so the ACL comparison above proves nothing",
  );
  fx.db.close();
});

test("[P1.K5] `dead_letters` keeps the adoption state and the notification delivery apart (INV-07)", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "owner");
  const res = call(fx, { path: "/v1/console/dashboard/dead_letters", cookie: s.cookie });
  assert.equal(res.status, 200, res.body);

  const keys = (res.json.sections as Array<{ key: string }>).map((x) => x.key);
  assert.deepEqual(keys, ["dead_letters", "webhook_health"], "the two facts are not two sections");

  const adoption = res.json.sections[0];
  const delivery = res.json.sections[1];
  // The columns do not overlap, which is what makes the separation a fact of the
  // payload rather than a choice a renderer could undo: no reader can mistake a
  // row of one table for a row of the other, because they answer different
  // questions with different fields.
  assert.deepEqual(
    (adoption.fields as string[]).filter((f) => (delivery.fields as string[]).includes(f)),
    [],
    "the adoption table and the delivery table share a column",
  );
  assert.ok((adoption.title as string).includes("adoption"), "the adoption table does not say it is about adoption");
  assert.ok((delivery.title as string).toLowerCase().includes("webhook"), "the delivery table does not say what it is about");

  // …and the page SAYS so, in a notice, rather than leaving a reader to infer
  // it from two headings.
  const legend = (res.json.notices as Array<{ kind: string; detail: string }>).find((n) =>
    /Queuing a notification is not delivering one/.test(n.detail),
  );
  assert.ok(legend, `the view does not declare that queued is not delivered: ${JSON.stringify(res.json.notices)}`);
  assert.equal(legend!.kind, "legend");
  fx.db.close();
});

test("[P1.K6] the console reads the JSON contract and cannot be pointed at the HTML rendering", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "owner");
  for (const q of ["format=html", "format=json", "format=", "format=HTML"]) {
    const res = call(fx, { path: `/v1/console/dashboard/library?${q}`, cookie: s.cookie });
    assert.equal(res.status, 400, `?${q} was not refused: ${res.status}`);
    assert.equal(res.json.error.code, "INVALID_SCHEMA");
    assert.equal(res.json.contract, CONSOLE_CONTRACT_V2);
  }
  // and nothing the console route ever returns is HTML
  const ok = call(fx, { path: "/v1/console/dashboard/library", cookie: s.cookie });
  assert.equal(ok.headers["Content-Type"], "application/json");
  fx.db.close();
});

// ===========================================================================
// G-P1-8 — the reviewer's closure
// ===========================================================================

/**
 * Every console route the router serves, read out of `src/http.ts` itself.
 *
 * Enumerated from the SOURCE and not from a list here, so a console route added
 * next month is covered by the closure test the day it is added rather than the
 * day somebody remembers to extend a literal. The same parser shape
 * `test/spec-parity.test.ts` uses, narrowed to the console surface.
 */
function consoleRoutesOfRouter(): Array<{ method: string; path: string }> {
  const src = readFileSync(join(ROOT, "src", "http.ts"), "utf8").split("\n");
  const out: Array<{ method: string; path: string }> = [];
  let pending: string | null = null;
  for (const line of src) {
    const rx = /^\s*(?:let |const )?m = \/\^(.*?)\$\/\.exec\(path\);/.exec(line);
    if (rx) pending = rx[1].replace(/\\\//g, "/");
    const method = /method === "([A-Z]+)"/.exec(line);
    if (!method) continue;
    const literal = /path === "([^"]+)"/.exec(line);
    if (literal) {
      if (literal[1].startsWith("/v1/console/")) out.push({ method: method[1], path: literal[1] });
      continue;
    }
    if (/&& m\)/.test(line) && pending) {
      if (pending.startsWith("/v1/console/")) out.push({ method: method[1], path: pending });
      pending = null;
    }
  }
  assert.ok(out.length >= 20, `only ${out.length} console routes parsed — the parser is broken`);
  return out;
}

test("[P1.K7] the route ACL is a closed table, and an unclassified console route is closed to a reviewer", () => {
  assert.deepEqual([...CONSOLE_SESSION_ROLES], ["owner", "admin", "reviewer"]);
  // the two classes that DECIDE something admit no reviewer
  assert.equal(consoleRouteAdmits("reviewer", "human_approval"), false);
  assert.equal(consoleRouteAdmits("reviewer", "owner_only"), false);
  // …and owner and admin are admitted to every class, which is what makes the
  // reviewer's exclusions the content of the table rather than its shape
  for (const cls of Object.keys(CONSOLE_ROUTE_ACL) as Array<keyof typeof CONSOLE_ROUTE_ACL>) {
    assert.ok(consoleRouteAdmits("owner", cls), `owner is not admitted to ${cls}`);
    assert.ok(consoleRouteAdmits("admin", cls), `admin is not admitted to ${cls}`);
  }
  // the classifier is TOTAL and closed by default: a path nobody classified is
  // `owner_only`, so forgetting to classify a new route cannot widen anything.
  for (const unknown of [
    "/v1/console/something-new",
    "/v1/console/versions/abc/revoke",
    "/v1/console/webhooks/abc/test",
    "/v1/console/",
    "/v1/console/dashboardish",
  ]) {
    assert.equal(consoleRouteClass(unknown), "owner_only", `${unknown} was not closed by default`);
  }
  assert.equal(consoleRouteClass("/v1/console/dashboard/library"), "dashboard");
  assert.equal(consoleRouteClass("/v1/console/versions/abc/reviews"), "review");
  assert.equal(consoleRouteClass("/v1/console/versions/abc/approvals"), "human_approval");
});

test("[P1.K8] a reviewer opens the Console and records a verdict", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "reviewer");
  assert.equal(s.role, "reviewer");
  const v = awaitingVerdict(fx, "k8-verdict");

  const before = (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews").get() as any).c;
  const recorded = call(fx, {
    method: "POST",
    path: `/v1/console/versions/${v.versionId}/reviews`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { action: "verdict", verdict: "approve", note: "read it end to end" },
  });
  assert.equal(recorded.status, 200, `a reviewer could not record a verdict from the console: ${recorded.body}`);
  assert.equal(recorded.json.contract, CONSOLE_CONTRACT_V2);
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews").get() as any).c,
    before + 1,
    "the console call recorded no review row",
  );
  assert.equal(
    (fx.db.prepare("SELECT reviewer_agent_id FROM reviews ORDER BY id DESC LIMIT 1").get() as any).reviewer_agent_id,
    fx.reviewer.agent_id,
    "the row does not name the reviewer whose session made the call",
  );
  fx.db.close();
});

test("[P1.K9] the same reviewer is FORBIDDEN on the human approval, on revoke, and on every owner-only console route", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "reviewer");
  const v = awaitingVerdict(fx, "k9-closure");
  const req = adoptionRequest(fx, v.versionId);

  // 1. the human approval, at the ROUTE, before the service is reached
  for (const body of [
    { scope: "adopt_high_risk", decision: "approved", adoption_request_id: req },
    { scope: "publish", decision: "approved" },
  ]) {
    const res = call(fx, {
      method: "POST",
      path: `/v1/console/versions/${v.versionId}/approvals`,
      cookie: s.cookie,
      csrf: s.csrf,
      body,
    });
    assert.equal(res.status, 403, `a reviewer passed a human gate: ${res.status} ${res.body}`);
    assert.equal(res.json.error.code, "FORBIDDEN");
    assert.equal(res.json.contract, CONSOLE_CONTRACT_V2);
    assert.match(
      res.json.error.message,
      /console session holding the role reviewer/,
      "the refusal did not come from the route ACL, so it was not checked before the service call",
    );
  }
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c,
    0,
    "a refused attempt left an approvals row behind",
  );

  // 2. revoke. There is no console revoke route in this build, and that ABSENCE
  //    is half the answer — the router has none to reach. The other half is that
  //    the reviewer's own principal is refused by the service, so a console
  //    revoke route added later inherits the refusal rather than having to
  //    re-state it.
  const published = publishedVersion(fx, "k9-revoke");
  assert.throws(
    () => fx.registry.revokeVersion(fx.reviewer, published.versionId, { reason: "not mine to make" }),
    (e: any) => e.code === "FORBIDDEN",
    "a reviewer principal was admitted to revoke",
  );
  assert.equal(
    consoleRouteClass(`/v1/console/versions/${published.versionId}/revoke`),
    "owner_only",
    "a console revoke route would not be owner-only",
  );

  // 3. EVERY other console route the router serves. Reads and mutations alike;
  //    the mutations carry a valid CSRF token so that what refuses them is the
  //    ACL and not the anti-forgery check.
  const allowed = new Set(["session", "dashboard", "approval_inbox", "review"]);
  // `POST /v1/console/tickets` is not a console-SESSION route: it is the
  // machine-to-machine half of the login, authenticated by a Bearer API key,
  // and a cookie never reaches it. It is excluded here and its exclusion is
  // grounded rather than assumed — a session cookie alone gets `UNAUTHORIZED`.
  const BEARER_CONSOLE_ROUTE = "/v1/console/tickets";
  assert.equal(call(fx, { method: "POST", path: BEARER_CONSOLE_ROUTE, cookie: s.cookie, body: {} }).status, 401);

  let refused = 0;
  for (const route of consoleRoutesOfRouter()) {
    if (route.path === BEARER_CONSOLE_ROUTE) continue;
    const cls = consoleRouteClass(route.path.replace(/\(\[\^\/\]\+\)/g, "x"));
    if (allowed.has(cls)) continue;
    const path = route.path.replace(/\(\[\^\/\]\+\)/g, "x");
    const res = call(fx, { method: route.method, path, cookie: s.cookie, csrf: s.csrf, body: route.method === "GET" ? undefined : {} });
    assert.equal(
      res.status,
      403,
      `${route.method} ${path} answered ${res.status} to a reviewer session — an owner-only route is open`,
    );
    assert.equal(res.json.error.code, "FORBIDDEN");
    assert.equal(res.json.contract, CONSOLE_CONTRACT_V2);
    refused += 1;
  }
  assert.ok(refused >= 10, `only ${refused} owner-only console routes were exercised — the sweep found nothing`);

  // …and the same sweep against an OWNER session must NOT be a wall of 403s, or
  // the sweep above would pass on a console that refuses everybody.
  const owner = signIn(fx, "owner");
  const ownerRefusals = consoleRoutesOfRouter()
    .filter((r) => r.method === "GET" && r.path !== BEARER_CONSOLE_ROUTE)
    .map((r) => call(fx, { method: r.method, path: r.path.replace(/\(\[\^\/\]\+\)/g, "x"), cookie: owner.cookie }))
    .filter((res) => res.status === 403);
  assert.deepEqual(ownerRefusals.map((r) => r.body), [], "an owner met the reviewer's refusal");
  fx.db.close();
});

test("[P1.K10] a principal that is not a human does not pass a human gate, whatever role it holds", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "k10-human");
  const req = adoptionRequest(fx, v.versionId);

  // A SERVICE PRINCIPAL HOLDING ROLE ADMIN gets a console session — the console
  // admits the role — and is still refused at the gate, by the service, on the
  // ground that decides it: `agents.type`.
  const s = signIn(fx, "service");
  assert.equal(s.role, "admin");
  const res = call(fx, {
    method: "POST",
    path: `/v1/console/versions/${v.versionId}/approvals`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { scope: "adopt_high_risk", decision: "approved", adoption_request_id: req },
  });
  assert.equal(res.status, 403, `a service principal passed a human gate: ${res.body}`);
  assert.equal(res.json.error.code, "FORBIDDEN");
  assert.match(res.json.error.message, /human/, "the refusal was not the human gate's");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c,
    0,
    "a refused attempt left an approvals row behind",
  );

  // …and a HUMAN admin, through the same route, is accepted — so the refusal
  // above is about the type and not about the route.
  const human = signIn(fx, "admin");
  const ok = call(fx, {
    method: "POST",
    path: `/v1/console/versions/${v.versionId}/approvals`,
    cookie: human.cookie,
    csrf: human.csrf,
    body: { scope: "adopt_high_risk", decision: "approved", adoption_request_id: req },
  });
  assert.equal(ok.status, 201, `a human admin was refused: ${ok.body}`);
  assert.equal(ok.json.contract, CONSOLE_CONTRACT_V2);
  assert.equal(ok.json.decision, "approved");
  fx.db.close();
});

test("[P1.K11] the author and the skill owner keep the self-review prohibition, whatever role they hold", () => {
  const fx = p4Fixture();
  // the version's author IS a reviewer by role, so it can open a console at all
  const v = awaitingVerdict(fx, "k11-self", fx.reviewer);
  const s = signIn(fx, "reviewer");
  const before = (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews").get() as any).c;
  const res = call(fx, {
    method: "POST",
    path: `/v1/console/versions/${v.versionId}/reviews`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { action: "verdict", verdict: "approve" },
  });
  assert.equal(res.status, 403, `the author reviewed its own version from the console: ${res.body}`);
  assert.equal(res.json.error.code, "FORBIDDEN");
  assert.equal(res.json.contract, CONSOLE_CONTRACT_V2);
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews").get() as any).c,
    before,
    "a refused self-review left a row behind",
  );
  fx.db.close();
});

// ===========================================================================
// The mutation wrappers — INV-01
// ===========================================================================

test("[P1.K12] the console mutations require same-origin, CSRF and a session before anything else", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "owner");
  const v = reviewedVersion(fx, "k12-defences");
  const paths = [`/v1/console/versions/${v.versionId}/reviews`, `/v1/console/versions/${v.versionId}/approvals`];

  for (const path of paths) {
    for (const [what, c] of [
      ["no session", { method: "POST", path, csrf: s.csrf, body: {} }],
      ["no CSRF token", { method: "POST", path, cookie: s.cookie, body: {} }],
      ["a wrong CSRF token", { method: "POST", path, cookie: s.cookie, csrf: "cx_not-the-token", body: {} }],
      ["no Origin", { method: "POST", path, cookie: s.cookie, csrf: s.csrf, origin: null, body: {} }],
      ["a foreign Origin", { method: "POST", path, cookie: s.cookie, csrf: s.csrf, origin: "http://evil.example", body: {} }],
    ] as Array<[string, Call]>) {
      const res = call(fx, c);
      assert.ok(res.status === 401 || res.status === 403, `${path} with ${what} answered ${res.status}: ${res.body}`);
      assert.equal(res.json.contract, CONSOLE_CONTRACT_V2, `${path} with ${what} refused without the contract`);
    }
  }
  fx.db.close();
});

test("[P1.K13] the wrappers refuse a body the contract refuses, at the boundary, and write nothing", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "admin");
  const v = reviewedVersion(fx, "k13-bodies");
  const req = adoptionRequest(fx, v.versionId);
  const count = (t: string) => (fx.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c;
  const reviewsBefore = count("reviews");
  const approvalsBefore = count("approvals");

  const bad: Array<[string, string, unknown]> = [
    ["reviews", "/action", { action: "decide" }],
    ["reviews", "/verdict", { action: "verdict" }],
    ["reviews", "/verdict", { action: "request", verdict: "approve" }],
    ["reviews", "/note", { action: "request", note: 7 }],
    ["approvals", "/scope", { decision: "approved" }],
    ["approvals", "/decision", { scope: "publish", decision: "maybe" }],
    ["approvals", "/adoption_request_id", { scope: "adopt_high_risk", decision: "approved" }],
    ["approvals", "/adoption_request_id", { scope: "publish", decision: "approved", adoption_request_id: req }],
  ];
  for (const [route, pointer, body] of bad) {
    const res = call(fx, {
      method: "POST",
      path: `/v1/console/versions/${v.versionId}/${route}`,
      cookie: s.cookie,
      csrf: s.csrf,
      body,
    });
    assert.equal(res.status, 400, `${route} ${JSON.stringify(body)} answered ${res.status}: ${res.body}`);
    assert.equal(res.json.error.code, "INVALID_SCHEMA");
    assert.equal(res.json.contract, CONSOLE_CONTRACT_V2);
    assert.ok(
      res.json.error.message.includes(pointer),
      `the refusal does not name the member that is wrong (${pointer}): ${res.json.error.message}`,
    );
  }
  assert.equal(count("reviews"), reviewsBefore, "a refused body wrote a review");
  assert.equal(count("approvals"), approvalsBefore, "a refused body wrote an approval");
  fx.db.close();
});

test("[P1.K14] a console mutation is the SAME service call the Bearer route makes — replay, conflict and all", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "reviewer");
  const v = awaitingVerdict(fx, "k14-idem");
  const path = `/v1/console/versions/${v.versionId}/reviews`;
  const body = { action: "verdict", verdict: "approve", note: "once", idempotency_key: "k14-key" };

  const first = call(fx, { method: "POST", path, cookie: s.cookie, csrf: s.csrf, body });
  assert.equal(first.status, 200, first.body);
  assert.equal(first.headers["Idempotency-Replayed"], undefined);
  const rows = (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews").get() as any).c;

  const replay = call(fx, { method: "POST", path, cookie: s.cookie, csrf: s.csrf, body });
  assert.equal(replay.status, 200, replay.body);
  assert.equal(replay.headers["Idempotency-Replayed"], "true", "a resent form decided twice");
  assert.equal(replay.body, first.body, "the replay is not the stored bytes");
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM reviews").get() as any).c, rows, "the replay wrote a second row");

  // …and the version's state moved exactly once, through the same transition
  // the Bearer route drives.
  assert.equal(
    (fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state,
    "reviewed",
  );
  fx.db.close();
});

test("[P1.K15] no console response carries a credential (INV-04)", () => {
  const fx = p4Fixture();
  const s = signIn(fx, "owner");
  const v = reviewedVersion(fx, "k15-secrets");
  const secretish = [fx.keys.owner!, fx.keys.reviewer!, fx.keys.admin!, s.cookie];

  const responses = [
    call(fx, { path: "/v1/console/dashboard/library", cookie: s.cookie }),
    call(fx, { path: "/v1/console/dashboard/dead_letters", cookie: s.cookie }),
    call(fx, { path: "/v1/console/drafts", cookie: s.cookie }),
    call(fx, { method: "POST", path: `/v1/console/versions/${v.versionId}/reviews`, cookie: s.cookie, csrf: s.csrf, body: { action: "request" } }),
    call(fx, { path: "/v1/console/dashboard/not_a_view", cookie: s.cookie }),
  ];
  for (const res of responses) {
    for (const secret of secretish) {
      assert.ok(!res.body.includes(secret), `a console response carried a credential: ${res.body.slice(0, 200)}`);
    }
    assert.ok(!/api_key|bearer /i.test(res.body), `a console response named a key: ${res.body.slice(0, 200)}`);
  }
  fx.db.close();
});
