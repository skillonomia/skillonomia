// A REVIEWER HAS TO BE ABLE TO REACH THE APPROVAL INBOX IN A BROWSER.
//
// `consoleInboxKindAdmits` refuses `kind=all` for a reviewer session on purpose,
// and its comment says the refusal "leaves the reviewer able to ask the one that
// is". That sentence was not true of the shipped page. The kind selector is
// filled from the Inbox RESPONSE; a reviewer's first load asks `kind=all`,
// which is `FORBIDDEN`, so no envelope arrived, the selector stayed empty, and
// the only control that could have asked the admissible question was never
// drawn. A reviewer could not record a verdict in the Console at all — which is
// the whole of "review decisions are available without curl".
//
// The repair publishes the admissible set on the session, so the page has the
// vocabulary BEFORE it asks. This file holds both halves: the server names the
// set, and it names it by deriving it from the same predicate the route refuses
// with, so the two cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRest, type RestResponse } from "../src/http.ts";
import { readFileSync } from "node:fs";
import { p4Fixture, type P4Fixture } from "./p4-helpers.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import {
  APPROVAL_KIND_FILTERS,
  REVIEWER_VISIBLE_KINDS,
  consoleInboxKindAdmits,
  consoleInboxKindFilters,
  CONSOLE_SESSION_ROLES,
} from "../src/console-v2.ts";

const ORIGIN = "console.local";

function call(fx: P4Fixture, c: { method?: string; path: string; key?: string; cookie?: string; body?: unknown }): RestResponse & { json: any } {
  const headers: Record<string, string | undefined> = { host: ORIGIN, origin: `http://${ORIGIN}` };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
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

function session(fx: P4Fixture, key: string): { cookie: string; opened: any } {
  const minted = call(fx, { method: "POST", path: "/v1/console/tickets", key, body: {} });
  assert.equal(minted.status, 201, minted.body);
  const opened = call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  assert.equal(opened.status, 201, opened.body);
  const cookie = /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"] as string)![1]!;
  return { cookie, opened: opened.json };
}

test("the admissible kind set is derived from the refusal, not restated beside it", () => {
  for (const role of CONSOLE_SESSION_ROLES) {
    const published = consoleInboxKindFilters(role);
    const admitted = APPROVAL_KIND_FILTERS.filter((k) => consoleInboxKindAdmits(role, k));
    assert.deepEqual(published, admitted, `the set published to a ${role} session is the set the route admits`);
    assert.ok(published.length > 0, `a ${role} session is entitled to ask for at least one kind`);
  }
  assert.deepEqual(consoleInboxKindFilters("reviewer"), [...REVIEWER_VISIBLE_KINDS]);
  assert.ok(!consoleInboxKindFilters("reviewer").includes("all"), "the reviewer's set excludes the filter the route refuses");
  assert.ok(consoleInboxKindFilters("owner").includes("all"));
});

test("both session routes publish the set, so a reload has it as well as a sign-in", () => {
  const fx = p4Fixture();
  for (const [who, key] of [["owner", fx.keys.owner!], ["reviewer", fx.keys.reviewer!]] as const) {
    const s = session(fx, key);
    assert.deepEqual(
      s.opened.inbox_kinds,
      consoleInboxKindFilters(s.opened.actor_role),
      `POST /v1/console/session names the ${who}'s admissible kinds`,
    );
    const reloaded = call(fx, { path: "/v1/console/session", cookie: s.cookie });
    assert.equal(reloaded.status, 200, reloaded.body);
    assert.deepEqual(
      reloaded.json.inbox_kinds,
      s.opened.inbox_kinds,
      `GET /v1/console/session names the same set for the ${who} — a reload must not lose the vocabulary`,
    );
  }
});

test("a reviewer session can ask every kind its session named, and is refused the one it did not", () => {
  const fx = p4Fixture();
  const s = session(fx, fx.keys.reviewer!);
  assert.equal(s.opened.actor_role, "reviewer");

  // Every filter the session published ANSWERS. This is the claim that failed:
  // the page had a set it could not act on because it never received one.
  for (const kind of s.opened.inbox_kinds as string[]) {
    const res = call(fx, { path: `/v1/console/approvals?status=all&kind=${kind}`, cookie: s.cookie });
    assert.equal(res.status, 200, `a reviewer asking kind=${kind} was answered ${res.status}: ${res.body}`);
  }
  // …and the refusal it exists to avoid is still a refusal, unweakened.
  const refused = call(fx, { path: "/v1/console/approvals?status=all&kind=all", cookie: s.cookie });
  assert.equal(refused.status, 403, "kind=all is still refused for a reviewer rather than silently narrowed");
  assert.equal(refused.json.error.code, "FORBIDDEN");
});

test("the page takes the selector's vocabulary from the session, before it asks the Inbox", () => {
  // A SOURCE GUARD, because the failure was an ORDER: the control was filled
  // from a response that a reviewer's request never produced. What has to be
  // true is that `boot` reads `inbox_kinds` off the session and fills the
  // selector with it, and that the Inbox renderer prefers that set over the
  // envelope's full vocabulary. Both are one line each and both are the line
  // that was missing.
  const app = readFileSync(new URL("../console/app.ts", import.meta.url), "utf8");
  const boot = app.slice(app.indexOf("async function boot("), app.indexOf("async function bootDecisionSurfaces("));
  assert.ok(boot.length > 0, "boot() is still where the session is read");
  assert.match(boot, /me\.inbox_kinds/, "boot reads the admissible kinds off the session");
  assert.match(boot, /fillFilter\(\s*byId<HTMLSelectElement>\("approvals-kind"\)/, "…and fills the kind selector with them");
  // the session read must come BEFORE the first inbox request in the same function
  assert.ok(
    boot.indexOf("me.inbox_kinds") < boot.indexOf("bootDecisionSurfaces()"),
    "the vocabulary is in hand before the decision surfaces are opened",
  );
  assert.match(
    app,
    /inboxKinds\.length > 0 \? inboxKinds : envelope\.kind_filters/,
    "the renderer prefers the session's set over the envelope's full vocabulary",
  );
});
