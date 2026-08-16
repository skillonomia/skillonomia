// V1 P2 REVIEW-2 — the checks that close `P2-R2-001`, and that would have caught it.
//
// THE FINDING. The console's versioned-contract boundary (`INV-05`) held for the
// answers a console route succeeds with and was absent on the ones it fails
// with: `src/http.ts` emitted a bare `{"error":{…}}` for a `400`, a `409` and a
// `412`, and `console/app.ts` read `code`, `message` and `current_state` out of
// it BEFORE checking the version. REVIEW-2 rewrote a rejection error to announce
// `console.v999` with a planted message and the console rendered the plant.
//
// WHAT IS ASSERTED HERE, and what is asserted elsewhere:
//
//   * the SERVER half — every refusal of the console surface carries the marker,
//     at every status the surface produces — is below.
//   * the BOUNDARY against `INV-08` — the machine-to-machine error envelope is
//     unchanged, byte for byte, at the same codes — is below.
//   * the CLIENT half — the check is one call and it stands ahead of the status
//     branch and the envelope — is a source property in
//     `test/v1p2-r1-fixes.test.ts`, where the rest of the `api()` properties are.
//   * the BEHAVIOUR in a real browser — the plant reaches no pixel and the owner
//     is shown `CONTRACT_MISMATCH` — is `v1/tools/e2e/console-error-contract.mjs`,
//     which also runs itself against a rebuilt pre-fix bundle and requires the
//     probes to fail there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRest, type RestResponse } from "../src/http.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { CONSOLE_CONTRACT_VERSION } from "../src/console-view.ts";
import { ERROR_CODES } from "../src/errors.ts";
import { Registry } from "../src/service.ts";
import { p4Fixture, type P4Fixture } from "./p4-helpers.ts";

const ORIGIN = "console.local";

interface Call {
  method?: string;
  path: string;
  key?: string;
  cookie?: string;
  csrf?: string;
  body?: unknown;
  origin?: string;
}

function callOn(registry: Registry, c: Call): RestResponse & { json: any } {
  const headers: Record<string, string | undefined> = { host: ORIGIN };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
  if (c.csrf) headers["x-skillonomia-console-csrf"] = c.csrf;
  headers.origin = c.origin ?? `http://${ORIGIN}`;
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
  "# close-the-contract",
  "",
  "Use this whenever a refusal has to be read.",
  "",
  "## Purpose",
  "Produce a structured refusal.",
  "",
  "## Procedure",
  "1. Ask for something refused.",
  "2. Read the refusal.",
  "3. Check its version.",
  "",
  "## Inputs",
  "- the request",
  "",
  "## Outputs",
  "- the refusal",
  "",
  "## Permissions",
  "- read the console",
  "",
  "## Dependencies",
  "- none",
  "",
  "## Failure modes",
  "- the page reads a payload it cannot read",
].join("\n");

/** A capture whose compiled draft carries blocking findings — the precondition
 *  of the `412`. The same text `v1/tools/e2e/console-e2e.mjs` uses. */
const THIN = "## Procedure\n1. Do the first thing.\n2. Then the second thing.\n\nWhenever something is missing.";

function capture(fx: P4Fixture, text = WORKFLOW): any {
  const res = call(fx, { method: "POST", path: "/v1/captures", key: fx.keys.owner!, body: { kind: "workflow", text } });
  assert.equal(res.status, 201, res.body);
  return res.json.draft;
}

// ===========================================================================
// P2-R2-001 — every refusal of the console surface announces its contract
// ===========================================================================

test("P2-R2-001: the console surface's 400, 409 and 412 all carry the contract version", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const pending = capture(fx);
  const thin = capture(fx, THIN);

  // 400 — a rejection with no reason
  const blank = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${pending.draft_id}/reject`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: pending.revision_id, idempotency_key: "r2-blank" },
  });
  // 412 — an approval of a draft with a blocking finding
  const blocked = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${thin.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: thin.revision_id, idempotency_key: "r2-blocked" },
  });
  // 409 — a second decision on a draft already decided
  const first = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${pending.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: pending.revision_id, idempotency_key: "r2-approve" },
  });
  assert.equal(first.status, 201, first.body);
  const again = call(fx, {
    method: "POST",
    path: `/v1/console/drafts/${pending.draft_id}/approve`,
    cookie: s.cookie,
    csrf: s.csrf,
    body: { revision_id: pending.revision_id, idempotency_key: "r2-approve-again" },
  });

  const refusals: Array<[string, number, string, any]> = [
    ["reject with no reason", 400, "INVALID_SCHEMA", blank],
    ["approve a blocked draft", 412, "PRECONDITION_FAILED", blocked],
    ["decide a decided draft", 409, "CONFLICT", again],
  ];
  for (const [what, status, code, res] of refusals) {
    assert.equal(res.status, status, `${what}: ${res.body}`);
    assert.equal(res.json.error.code, code, res.body);
    // the field the finding was about
    assert.equal(res.json.contract, CONSOLE_CONTRACT_VERSION, `${what} answered without a contract version: ${res.body}`);
    // and the envelope beside it is untouched — the marker is ADDITIVE
    assert.equal(typeof res.json.error.message, "string");
  }
  // the converging-conflict field survives the addition, because a console that
  // cannot read `current_state` cannot converge
  assert.equal(again.json.error.current_state, "approved", again.body);
  assert.equal(blocked.json.error.current_state, "pending", blocked.body);
  fx.db.close();
});

test("P2-R2-001: the refusals of every console route carry it, not only the decision routes", () => {
  const fx = p4Fixture();
  const s = signIn(fx);
  const draft = capture(fx);

  const refused: Array<[string, any]> = [
    // 401 — no session, on each protected shape
    ["GET inbox, no session", call(fx, { path: "/v1/console/drafts" })],
    ["GET detail, no session", call(fx, { path: `/v1/console/drafts/${draft.draft_id}` })],
    ["GET audit, no session", call(fx, { path: `/v1/console/drafts/${draft.draft_id}/audit` })],
    ["GET session, no session", call(fx, { path: "/v1/console/session" })],
    ["POST logout, no session", call(fx, { method: "POST", path: "/v1/console/logout", body: {} })],
    // 403 — CSRF and Origin, the two mutation defences
    [
      "POST with no CSRF token",
      call(fx, {
        method: "POST",
        path: `/v1/console/drafts/${draft.draft_id}/reject`,
        cookie: s.cookie,
        body: { reason: "no" },
      }),
    ],
    [
      "POST from another origin",
      call(fx, {
        method: "POST",
        path: `/v1/console/drafts/${draft.draft_id}/reject`,
        cookie: s.cookie,
        csrf: s.csrf,
        origin: "http://elsewhere.example",
        body: { reason: "no" },
      }),
    ],
    // 400 — a body that is not JSON at all is refused before any route runs
    ["POST an unparseable body", callOn(fx.registry, { method: "POST", path: "/v1/console/session", body: undefined })],
    // 404 — a path under the surface that no route serves
    ["GET a console route that does not exist", call(fx, { path: "/v1/console/drafts/x/y/z", cookie: s.cookie })],
    // 401 — the ticket exchange with a ticket that is not one
    ["POST session with a bad ticket", call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: "nope" } })],
    // the machine-to-machine half of the console login, refused for want of a key
    ["POST tickets with no key", call(fx, { method: "POST", path: "/v1/console/tickets", body: {} })],
  ];

  for (const [what, res] of refused) {
    assert.ok(res.status >= 400, `${what} was not a refusal: ${res.status}`);
    assert.equal(res.json?.contract, CONSOLE_CONTRACT_VERSION, `${what} answered ${res.status} without a contract version: ${res.body}`);
    assert.equal(typeof res.json?.error?.code, "string", `${what}: ${res.body}`);
  }
  fx.db.close();
});

// ===========================================================================
// INV-08 — and the boundary the marker is scoped by
// ===========================================================================

test("INV-08: the machine-to-machine error envelope is unchanged", () => {
  const fx = p4Fixture();
  const draft = capture(fx);

  // The same failures, on the surface released clients call. Each must answer
  // the envelope `SPEC.md` §6 fixes and NOTHING beside it.
  const m2m: Array<[string, any]> = [
    ["no credential", call(fx, { path: "/v1/skills" })],
    ["an unknown key", call(fx, { path: "/v1/skills", key: "sk_not_a_key" })],
    ["a draft that does not exist", call(fx, { path: "/v1/drafts/nope", key: fx.keys.owner! })],
    ["a route that does not exist", call(fx, { path: "/v1/nope", key: fx.keys.owner! })],
    [
      "a malformed capture",
      call(fx, { method: "POST", path: "/v1/captures", key: fx.keys.owner!, body: { kind: "workflow" } }),
    ],
    [
      "a revision of a draft, malformed",
      call(fx, {
        method: "POST",
        path: `/v1/drafts/${draft.draft_id}/revisions`,
        key: fx.keys.owner!,
        body: { sections: "not an object" },
      }),
    ],
  ];
  for (const [what, res] of m2m) {
    assert.ok(res.status >= 400, `${what} was not a refusal: ${res.status}`);
    assert.deepEqual(
      Object.keys(res.json).sort(),
      ["error"],
      `${what} answered with a field beside \`error\`: ${res.body}`,
    );
    const envelopeKeys = Object.keys(res.json.error).sort();
    for (const k of envelopeKeys) {
      assert.ok(["code", "message", "current_state"].includes(k), `${what} added \`${k}\` to the envelope`);
    }
    assert.ok((ERROR_CODES as readonly string[]).includes(res.json.error.code), `${what}: ${res.body}`);
  }
  fx.db.close();
});

test("INV-08: the marker follows the request path — one failure, two surfaces", () => {
  const fx = p4Fixture();
  // THE BOUNDARY, SHOWN RATHER THAN DESCRIBED. The same two failures are
  // produced on the console surface and on the machine-to-machine one, and the
  // only difference in the answers is the marker: the console gets it, the
  // surface `v0.1.6` clients call does not.
  const garbage = (path: string) =>
    handleRest(fx.registry, {
      method: "POST",
      url: path,
      headers: { host: ORIGIN, origin: `http://${ORIGIN}`, authorization: `Bearer ${fx.keys.owner!}` },
      body: Buffer.from("this is not json"),
    });
  const missing = (path: string) =>
    handleRest(fx.registry, {
      method: "GET",
      url: path,
      headers: { host: ORIGIN, authorization: `Bearer ${fx.keys.owner!}` },
      body: Buffer.alloc(0),
    });

  const pairs: Array<[string, RestResponse, RestResponse]> = [
    ["a body that is not JSON", garbage("/v1/console/session"), garbage("/v1/captures")],
    ["a route that does not exist", missing("/v1/console/nope"), missing("/v1/nope")],
  ];
  for (const [what, consoleSide, m2mSide] of pairs) {
    const c = JSON.parse(consoleSide.body);
    const m = JSON.parse(m2mSide.body);
    assert.equal(c.contract, CONSOLE_CONTRACT_VERSION, `${what} on the console surface carried no marker: ${consoleSide.body}`);
    assert.deepEqual(Object.keys(m).sort(), ["error"], `${what} on the M2M surface gained a field: ${m2mSide.body}`);
    assert.equal(typeof c.error.code, "string");
    assert.equal(typeof m.error.code, "string");
    assert.ok((ERROR_CODES as readonly string[]).includes(c.error.code), consoleSide.body);
    assert.ok((ERROR_CODES as readonly string[]).includes(m.error.code), m2mSide.body);
  }
  fx.db.close();
});
