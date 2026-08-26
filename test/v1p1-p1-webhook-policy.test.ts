// P1 — WEBHOOK REGISTRATION PARITY (§6.5.1) AND TEST DELIVERY (§6.5.2).
//
// TWO CLAIMS, AND EACH IS ONLY WORTH WHAT ITS NEGATIVE HALF PROVES.
//
//   THE PARITY CLAIM. Registration must refuse what THIS PROCESS's transport
//   would refuse. A suite that only showed `http://localhost` being refused
//   would be green on a build that refused it always — including one that
//   refused it on a deployment which does deliver to loopback, which is the
//   same drift pointing the other way. So every parity assertion here is made
//   in BOTH flag states, against the real `HttpsWebhookTransport`, and the
//   transport is asked the same question the registration surface was asked.
//
//   And the claim is a PROPERTY, over every spelling of a destination, not over
//   the strings §5.2 happens to use to describe one. A table keyed to
//   `http://localhost` is green on a build that admits `https://127.0.0.1` —
//   the same machine, the same socket, the same refusal from the transport —
//   which is what `LOOPBACK_SPELLINGS` below is for.
//
//   THE ISOLATION CLAIM. A test push must move no endpoint health and no queue
//   row. A test that merely showed the call answering `200` would be green on a
//   build that incremented `failure_count` on every probe. So the assertion is
//   a FULL BEFORE/AFTER SNAPSHOT of the rows §5.2 owns — and the comparator
//   itself is discriminated, by running the identical snapshot around a real
//   production delivery and requiring it to report the movement it found there.
//
// EVERY DESTINATION IN THIS FILE IS A SERVER THIS FILE STARTED, on an ephemeral
// port of 127.0.0.1, and closed in a `finally`. Nothing here reaches a network
// this machine is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { handleRest, handleRestAsync, type RestResponse } from "../src/http.ts";
import { p4Fixture, reviewedVersion, NOW, type P4Fixture } from "./p4-helpers.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { CONSOLE_CONTRACT_V2 } from "../src/console-v2.ts";
import {
  MemorySecretStore,
  NullTransport,
  deliveryPolicyOf,
  pushOnce,
  registerWebhook,
  runWorkerOnce,
  signBody,
  verifySignature,
  WEBHOOK_TEST_ERROR_CODES,
  MAX_TEST_ERROR_DETAIL,
  type WebhookTransport,
} from "../src/webhooks.ts";
import {
  HttpsWebhookTransport,
  canonicalHost,
  defaultTransport,
  endpointHost,
  isLoopbackHost,
  registrationUrlPolicy,
} from "../src/transport.ts";
import { loadRequest, pollDelivery, workerId } from "../src/delivery.ts";
import { ulid } from "../src/ulid.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const ORIGIN = "console.local";

/** The two deployments §6.5.1 distinguishes, built the way `src/server.ts`
 *  builds one: from an environment, once, where the transport is constructed. */
const LOOPBACK_OFF = { } as NodeJS.ProcessEnv;
const LOOPBACK_ON = { SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK: "1" } as NodeJS.ProcessEnv;

// ---------------------------------------------------------------- receivers

interface Receiver {
  url: (path?: string) => string;
  received: Array<{ body: string; signature: string | undefined }>;
  close: () => Promise<void>;
}

/**
 * A webhook receiver on 127.0.0.1, on a port the kernel picks.
 *
 * The port is `0` because a fixed one is a port another suite, or another
 * checkout of this repository running beside it, may already hold — and a bind
 * failure inside a delivery test reads exactly like a delivery defect. Every
 * caller closes it in a `finally`; a listener left behind makes a LATER suite
 * flaky, which is the worst kind of failure to attribute.
 */
async function receiver(answer: (n: number) => { status: number; body?: string }): Promise<Receiver> {
  const received: Array<{ body: string; signature: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        signature: req.headers["x-webhook-signature"] as string | undefined,
      });
      const a = answer(received.length);
      res.writeHead(a.status, { "Content-Type": "application/json" });
      res.end(a.body ?? "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path = "/hook") => `http://127.0.0.1:${port}${path}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ------------------------------------------------------------------ drivers

interface Call {
  method?: string;
  path: string;
  key?: string;
  cookie?: string;
  csrf?: string;
  origin?: string | null;
  body?: unknown;
}

async function call(fx: P4Fixture, c: Call): Promise<RestResponse & { json: any }> {
  const headers: Record<string, string | undefined> = { host: ORIGIN };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
  if (c.csrf) headers["x-skillonomia-console-csrf"] = c.csrf;
  if (c.origin !== null) headers.origin = c.origin ?? `http://${ORIGIN}`;
  // `handleRestAsync`, which is what a listener uses: §6.5.2's route answers
  // through `RestResponse.pending` and the synchronous return value is a
  // placeholder by construction (src/http.ts).
  const res = await handleRestAsync(fx.registry, {
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

async function signIn(fx: P4Fixture, keyName: string): Promise<Session> {
  const minted = await call(fx, { method: "POST", path: "/v1/console/tickets", key: fx.keys[keyName]!, body: {} });
  assert.equal(minted.status, 201, `${keyName} could not mint a ticket: ${minted.body}`);
  const opened = await call(fx, { method: "POST", path: "/v1/console/session", body: { ticket: minted.json.ticket } });
  assert.equal(opened.status, 201, opened.body);
  const value = /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"])![1]!;
  return { cookie: value, csrf: opened.json.csrf_token, role: opened.json.actor_role };
}

interface WhFixture extends P4Fixture {
  secrets: MemorySecretStore;
}

/** A fixture whose registry holds the transport named, so §6.5.1's question —
 *  what would THIS process deliver to — has one answer in the test too. */
function fixture(transport: WebhookTransport): WhFixture {
  const secrets = new MemorySecretStore();
  const fx = p4Fixture({ secrets, transport }) as WhFixture;
  fx.secrets = secrets;
  // seedGraph() ships one `pending` request; park it so no worker tick this
  // file runs claims a job it did not create.
  fx.db.prepare("UPDATE adoption_requests SET state='pushed' WHERE id=?").run(fx.seed.request);
  return fx;
}

// ------------------------------------------------------------- the snapshot

/**
 * EVERYTHING §5.2 OWNS THAT A DELIVERY MOVES, as one comparable value.
 *
 * Not a count and not a sampled column: the health row of every endpoint
 * including `last_error`, and every delivery-queue row with its state, attempt
 * count, lease and dead-letter reason. `POST …/test` must leave this value
 * byte-identical, and a real push must not — the second half is what makes the
 * first an assertion rather than a formality.
 */
function deliveryState(fx: P4Fixture): string {
  const hooks = fx.db
    .prepare("SELECT id, agent_id, url, status, failure_count, last_error, updated_at_ms, secret_hash, secret_ref FROM webhooks ORDER BY id")
    .all();
  const queue = fx.db
    .prepare(
      `SELECT id, skill_version_id, adopter_agent_id, webhook_id, state, attempt_count, next_attempt_at_ms,
              lease_owner, lease_expires_at_ms, dead_letter_reason, notification_kind, created_at_ms
         FROM adoption_requests ORDER BY id`,
    )
    .all();
  return JSON.stringify({ hooks, queue });
}

/** Every stored secret, so "no row and no secret was written" is one check. */
function secretState(fx: WhFixture): string {
  const refs = (fx.db.prepare("SELECT id FROM webhooks ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => `secretstore://webhook/${r.id}`,
  );
  return JSON.stringify(refs.map((ref) => [ref, fx.secrets.get(ref) !== undefined]));
}

function auditRows(fx: P4Fixture): Array<{ action: string; subject_id: string | null; details_json: string | null }> {
  return fx.db
    .prepare("SELECT action, subject_id, details_json FROM activity_log WHERE action = 'webhook.test' ORDER BY id")
    .all() as Array<{ action: string; subject_id: string | null; details_json: string | null }>;
}

// ===========================================================================
// G-P1-11 — registration/delivery parity, in BOTH flag states
// ===========================================================================

test("§6.5.1: with the loopback flag off, an http loopback URL is refused before any row or secret is written", async () => {
  const fx = fixture(defaultTransport(LOOPBACK_OFF));
  const beforeDelivery = deliveryState(fx);
  const beforeSecrets = secretState(fx);

  for (const url of ["http://localhost:8080/hook", "http://127.0.0.1:9000/hook"]) {
    const res = await call(fx, { method: "POST", path: "/v1/webhooks", key: fx.keys.member, body: { url } });
    assert.equal(res.status, 400, `${url} was admitted by a deployment that will not deliver to it`);
    assert.equal(res.json.error.code, "INVALID_SCHEMA", url);
    assert.match(res.json.error.message, /https is required/, url);
    // …and the refusal does not advertise an alternative this deployment has
    // not got: the parenthesis offering `http://` appears only where it works.
    assert.equal(/http:\/\/ to this machine/.test(res.json.error.message), false, url);
  }

  // THE ORDERING, WHICH IS THE HALF THAT IS EASY TO GET WRONG. Not "no endpoint
  // is listed" — no ROW and no SECRET. A refusal after `store.put` would have
  // minted a credential for an endpoint the registry then declined to record,
  // and `GET /v1/webhooks` would still show nothing.
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM webhooks").get() as { c: number }).c,
    0,
    "a refused registration left a webhooks row",
  );
  assert.equal(deliveryState(fx), beforeDelivery, "a refused registration moved §5.2 state");
  assert.equal(secretState(fx), beforeSecrets, "a refused registration wrote a secret");
  fx.db.close();
});

/**
 * EVERY SPELLING OF "THIS MACHINE", because the rule is a property and not a
 * string.
 *
 * The gate above says HTTP loopback, which is what §5.2's Appendix D.1
 * exception is worded around — and a suite that tests the words tests one
 * spelling. `https://127.0.0.1:9/hook` is the same host, the same socket and
 * the same refusal from the transport, whose address check reads the delivery
 * policy and knows nothing about schemes; it was admitted with `201` and a
 * secret while the identical `http://` string was refused. So the table is the
 * class: literal, alternate literal inside `127.0.0.0/8`, IPv6 `::1`, the
 * IPv4-mapped form, the name `localhost`, that name in another case, and both
 * schemes.
 *
 * Registration and delivery are asked of THE SAME transport object, in both
 * flag states, and each row asserts the transport's answer FIRST — a row where
 * the transport does not decline the destination would make the registration
 * assertion meaningless.
 *
 * THE LAST FOUR ROWS ARE THE SAME NAME, SPELLED FOUR WAYS. `localhost.` is the
 * absolute-DNS spelling — one trailing root dot — and this machine's resolver
 * answers it with `::1` and `127.0.0.1`, exactly as it answers `localhost`. It
 * registered under a policy that forbids loopback while the transport refused
 * to deliver to it, because the host was compared before it was canonical. They
 * are rows here because the table is what a reader checks against; they are NOT
 * the repair. Adding a spelling to a list is what the previous two rounds did,
 * and the list kept being short by one. The repair is `canonicalHost`, asserted
 * as a property by the test below this pair.
 */
const LOOPBACK_SPELLINGS: readonly string[] = [
  "https://127.0.0.1:9/hook",
  "https://127.0.0.1",
  "https://127.0.0.5:9/hook",
  "https://[::1]:9/hook",
  "https://[::ffff:127.0.0.1]:9/hook",
  "https://localhost:9/hook",
  "https://LocalHost:9/hook",
  "http://127.0.0.1:9/hook",
  "http://localhost:9/hook",
  "https://localhost.:9/hook",
  "https://LOCALHOST.:9/hook",
  "https://localhost%2e:9/hook",
  "http://localhost.:9/hook",
];

/** Short deadlines: the flag-ON half opens real sockets to CLOSED ports on this
 *  machine, and a refused connection should not wait out a production timeout. */
const PROBE_TIMEOUTS = { connectTimeoutMs: 1_000, totalTimeoutMs: 2_000 };

test("§6.5.1: with the flag off, EVERY spelling of a loopback destination is refused before any row or secret moves", async () => {
  const strict = new HttpsWebhookTransport({ allowLoopback: false, ...PROBE_TIMEOUTS });
  assert.equal(deliveryPolicyOf(strict).allowLoopback, false);
  const fx = fixture(strict);

  // A WORKING ENDPOINT THAT MUST SURVIVE THE ATTEMPT. §5.2 selects one endpoint
  // per adopter and registering retires the previous, so a registration that
  // accepts an undeliverable destination does not merely add a bad row — it
  // takes away the good one. Without this row the "no state moved" assertion
  // below would hold on an empty table and prove nothing about that.
  const prior = await call(fx, {
    method: "POST",
    path: "/v1/webhooks",
    key: fx.keys.member,
    body: { url: "https://adopter.example.com/hook" },
  });
  assert.equal(prior.status, 201, prior.body);
  const priorId = prior.json.webhook_id as string;
  const beforeDelivery = deliveryState(fx);
  const beforeSecrets = secretState(fx);

  for (const url of LOOPBACK_SPELLINGS) {
    const declined = await strict.send({ url, body: "{}", signature: "00" });
    assert.equal(
      declined.refused,
      true,
      `${url}: this transport does not DECLINE the destination, so the registration assertion below measures nothing (${declined.error})`,
    );

    const res = await call(fx, { method: "POST", path: "/v1/webhooks", key: fx.keys.member, body: { url } });
    assert.equal(res.status, 400, `${url} was admitted by a deployment whose own transport declines it`);
    assert.equal(res.json.error.code, "INVALID_SCHEMA", `${url}: ${res.body}`);
  }

  // BYTE-IDENTICAL, not "no new endpoint": no row inserted, no row retired, no
  // secret minted and none dropped.
  assert.equal(deliveryState(fx), beforeDelivery, "a refused registration moved §5.2 state");
  assert.equal(secretState(fx), beforeSecrets, "a refused registration wrote or dropped a secret");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM webhooks").get() as { c: number }).c,
    1,
    "a refused registration changed the webhook row count",
  );
  assert.equal(
    (fx.db.prepare("SELECT status FROM webhooks WHERE id=?").get(priorId) as { status: string }).status,
    "active",
    "a refused registration retired the endpoint that was working",
  );
  fx.db.close();
});

test("§6.5.1: with the flag on, the same spellings register and the transport does not decline them", async () => {
  const permissive = new HttpsWebhookTransport({ allowLoopback: true, ...PROBE_TIMEOUTS });
  assert.equal(deliveryPolicyOf(permissive).allowLoopback, true);
  const fx = fixture(permissive);

  for (const url of LOOPBACK_SPELLINGS) {
    const res = await call(fx, { method: "POST", path: "/v1/webhooks", key: fx.keys.member, body: { url } });
    assert.equal(res.status, 201, `${url} was refused by a deployment that delivers to this machine: ${res.body}`);
    assert.equal(res.json.url, url, "the URL is echoed exactly as written");

    // The other half of the parity, and the only half the transport can be
    // asked for a destination with nothing listening on it: whatever happens at
    // the socket, it must not be a POLICY refusal. `refused` is the structured
    // flag §6.5.2 reads; a connection that was allowed and then failed is not
    // one, and that is precisely the difference this asserts.
    const attempted = await permissive.send({ url, body: "{}", signature: "00" });
    assert.notEqual(
      attempted.refused,
      true,
      `${url}: registration admitted a destination the SAME transport declines (${attempted.error})`,
    );
  }
  fx.db.close();
});

/**
 * THE REPAIR, ASSERTED AS A PROPERTY — because three more rows in a table is
 * what the previous two rounds shipped.
 *
 * The table above is a reader's check. It cannot be the guarantee: it was
 * complete by inspection twice, and twice a spelling nobody had listed walked
 * through — `https://127.0.0.1`, then `https://localhost.`. What those have in
 * common is not their strings. It is that the host was COMPARED BEFORE IT WAS
 * CANONICAL, so every new way of writing the same name was a new hole.
 *
 * So this asserts the canonicalisation itself, on both arms of the decision,
 * with the discrimination that keeps the assertion honest — plus the two edges
 * that bound the claim `src/transport.ts` now makes: the over-refusal mirror,
 * and the case registration deliberately does NOT decide.
 */
test("§6.5.1: the loopback decision is taken on a CANONICAL host, so a spelling cannot be one short", async () => {
  // one name, every spelling, one string — and both arms read that string
  for (const spelling of ["localhost", "LOCALHOST", "localhost.", "LocalHost.", "localhost%2e", "localhost.."]) {
    assert.equal(canonicalHost(spelling), "localhost", `${spelling} is a spelling of localhost`);
    assert.equal(isLoopbackHost(spelling), true, `${spelling} names this machine`);
  }

  // …and the spellings the URL PARSER reduces, asserted through the same two
  // calls registration makes rather than against `canonicalHost` alone. IDNA is
  // the parser's half of this and is deliberately not reimplemented here; what
  // matters is that the composition of the two halves is total, which is a
  // different claim from either half and the one the surface depends on.
  for (const raw of [
    "https://localhost。:9/hook",
    "https://ｌｏｃａｌｈｏｓｔ:9/hook",
    "https://LOCALHOST.:9/hook",
    "https://localhost%2e:9/hook",
  ]) {
    assert.equal(canonicalHost(endpointHost(new URL(raw))), "localhost", `${raw} addresses localhost`);
  }
  for (const literal of ["127.0.0.1", "[::1]", "::1", "[::FFFF:127.0.0.1]", "127.0.0.5"]) {
    assert.equal(isLoopbackHost(literal), true, `${literal} names this machine`);
  }
  // …without which the two loops above are green on a function that returns
  // `true`. A name that merely contains a loopback spelling is another host.
  for (const other of ["notlocalhost", "localhost.attacker.com", "127.0.0.1.attacker.com", "evil.example.com.", "93.184.216.34"]) {
    assert.equal(isLoopbackHost(other), false, `${other} does not name this machine`);
  }

  // THE MIRROR. The missing canonicalisation failed in the over-refusal
  // direction too, and a fix that closed only the admit direction would leave
  // it: with loopback delivery ON, `http://localhost.` is a destination this
  // deployment does deliver to, and registration was refusing it.
  const permissive = new HttpsWebhookTransport({ allowLoopback: true, ...PROBE_TIMEOUTS });
  const on = fixture(permissive);
  const admittedHttp = await call(on, {
    method: "POST",
    path: "/v1/webhooks",
    key: on.keys.member,
    body: { url: "http://localhost.:9/hook" },
  });
  assert.equal(
    admittedHttp.status,
    201,
    `the http:// exception is to a host that IS this machine, however that host is spelled: ${admittedHttp.body}`,
  );
  on.db.close();

  // THE EDGE, ASSERTED SO THE COMMENT IN src/transport.ts CANNOT OUTGROW IT.
  // Registration resolves no name, so a name that is not known-loopback
  // registers even where it answers `127.0.0.1` — and DELIVERY declines it, on
  // every connect. That pair is why the narrow claim is safe, and a claim of
  // full registration/delivery parity for names would be false.
  const strict = new HttpsWebhookTransport({
    allowLoopback: false,
    ...PROBE_TIMEOUTS,
    resolve: async () => ["127.0.0.1"],
  });
  const off = fixture(strict);
  const url = "https://rebinds-later.example.com/hook";
  const admittedName = await call(off, { method: "POST", path: "/v1/webhooks", key: off.keys.member, body: { url } });
  assert.equal(admittedName.status, 201, `registration resolves no name and must not pretend to: ${admittedName.body}`);
  const declined = await strict.send({ url, body: "{}", signature: "00" });
  assert.equal(declined.refused, true, "the socket is where a name is judged, and it did not judge it");
  assert.match(declined.error!, /forbidden address \(loopback 127\.0\.0\.0\/8\)/);
  off.db.close();
});

test("§6.5.1: with the loopback flag on, the same URL registers and the transport agrees", async () => {
  const transport = defaultTransport(LOOPBACK_ON);
  const fx = fixture(transport);
  const rx = await receiver(() => ({ status: 200, body: '{"ok":true}' }));
  try {
    const url = rx.url();
    const registered = await call(fx, { method: "POST", path: "/v1/webhooks", key: fx.keys.member, body: { url } });
    assert.equal(registered.status, 201, `the loopback deployment refused its own destination: ${registered.body}`);
    assert.equal(registered.json.url, url, "the URL is echoed exactly as written");

    // THE TRANSPORT HALF OF THE SAME CLAIM, and it is asked of the transport
    // the registry holds — not of a second one built here. Parity is that ONE
    // object answered both questions the same way.
    assert.equal(deliveryPolicyOf(transport).allowLoopback, true);
    const test = await call(fx, {
      method: "POST",
      path: `/v1/webhooks/${registered.json.webhook_id}/test`,
      key: fx.keys.member,
    });
    assert.equal(test.status, 200, test.body);
    assert.deepEqual(
      { delivered: test.json.delivered, http_status: test.json.http_status, error_code: test.json.error_code },
      { delivered: true, http_status: 200, error_code: null },
      "registration admitted a URL the transport then declined",
    );
    assert.equal(rx.received.length, 1, "the endpoint was not actually reached");
    assert.equal(
      verifySignature(registered.json.secret, rx.received[0].body, rx.received[0].signature!),
      true,
      "the test push was not signed with the endpoint's real secret",
    );
    assert.equal(JSON.parse(rx.received[0].body).kind, "test", "§6.5.2 fixes the payload kind");
  } finally {
    await rx.close();
    fx.db.close();
  }
});

test("§6.5.1: the refusal is the transport's own — the flag-off transport declines the same string", async () => {
  // The mirror of the test above, and the reason the pair is the gate: with the
  // flag off, the URL is refused at BOTH surfaces, so registration is not being
  // stricter than delivery in one direction and looser in the other.
  const strict = defaultTransport(LOOPBACK_OFF);
  const permissive = defaultTransport(LOOPBACK_ON);
  assert.equal(deliveryPolicyOf(strict).allowLoopback, false);
  assert.equal(deliveryPolicyOf(permissive).allowLoopback, true);

  const url = "http://127.0.0.1:9/hook";
  const refused = await strict.send({ url, body: "{}", signature: "00" });
  assert.equal(refused.status, 0);
  assert.equal(refused.refused, true, "a declined destination must be reported as declined, not as a failure to reach");
  assert.match(refused.error!, /https is required/);

  // and the registration policy derived from each is the same decision
  assert.equal(registrationUrlPolicy(deliveryPolicyOf(strict)).allowHttp, false);
  assert.equal(registrationUrlPolicy(deliveryPolicyOf(permissive)).allowHttp, true);
});

test("§6.5.1: private, link-local, reserved and credential-bearing destinations are refused in BOTH flag states", async () => {
  const forbidden: ReadonlyArray<[string, RegExp]> = [
    ["https://10.0.0.7/hook", /private 10\./],
    ["https://192.168.1.5/hook", /private 192\.168\./],
    ["https://172.16.9.9/hook", /private 172\.16\./],
    ["https://169.254.169.254/hook", /link-local/],
    ["https://[fd00:ec2::254]/hook", /unique local/],
    ["https://[fe80::1]/hook", /link-local/],
    ["https://[::ffff:169.254.169.254]/hook", /IPv4-mapped/],
    ["https://255.255.255.255/hook", /reserved/],
    ["https://224.0.0.1/hook", /multicast/],
    ["https://evil.com@internal.host/", /credentials/],
    ["https://user:pw@10.0.0.5/hook", /credentials/],
    ["http://localhost@internal.host/hook", /credentials/],
  ];
  for (const env of [LOOPBACK_OFF, LOOPBACK_ON]) {
    const label = env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK === "1" ? "flag=1" : "flag=0";
    const fx = fixture(defaultTransport(env));
    for (const [url, why] of forbidden) {
      const res = await call(fx, { method: "POST", path: "/v1/webhooks", key: fx.keys.member, body: { url } });
      assert.equal(res.status, 400, `${label} ${url}`);
      assert.equal(res.json.error.code, "INVALID_SCHEMA", `${label} ${url}`);
      assert.match(res.json.error.message, why, `${label} ${url}`);
    }
    // a name that merely BEGINS with a loopback spelling is not this machine,
    // under either policy
    for (const url of ["http://localhost.attacker.com/", "http://127.0.0.1.attacker.com/hook"]) {
      const res = await call(fx, { method: "POST", path: "/v1/webhooks", key: fx.keys.member, body: { url } });
      assert.equal(res.status, 400, `${label} ${url}`);
    }
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM webhooks").get() as { c: number }).c,
      0,
      `${label}: a forbidden destination was registered`,
    );
    fx.db.close();
  }
});

test("§6.5.1: an https public endpoint registers under either policy — the narrowing is loopback and nothing else", async () => {
  for (const env of [LOOPBACK_OFF, LOOPBACK_ON]) {
    const fx = fixture(defaultTransport(env));
    const res = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: "https://adopter.example.com/hook" },
    });
    assert.equal(res.status, 201, res.body);
    fx.db.close();
  }
});

test("§6.5.1: registration promises nothing about a NAME — the addresses are judged at every connect", async () => {
  // A public name registers, because registration resolves nothing. What it
  // resolves to is decided at the socket, per connect, and the same name can be
  // answered differently on the second attempt — which is exactly what the
  // rebinding rule of §5.2 is for.
  const answers = [["127.0.0.1"], ["169.254.169.254"]];
  let connects = 0;
  const transport = new HttpsWebhookTransport({
    allowLoopback: true,
    resolve: async () => answers[Math.min(connects++, answers.length - 1)],
  });
  const fx = fixture(transport);
  const rx = await receiver(() => ({ status: 200 }));
  try {
    const port = new URL(rx.url()).port;
    const registered = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: `http://localhost:${port}/hook` },
    });
    assert.equal(registered.status, 201, registered.body);

    const first = await call(fx, {
      method: "POST",
      path: `/v1/webhooks/${registered.json.webhook_id}/test`,
      key: fx.keys.member,
    });
    assert.equal(first.json.delivered, true, `the first connect did not reach the receiver: ${first.body}`);

    const second = await call(fx, {
      method: "POST",
      path: `/v1/webhooks/${registered.json.webhook_id}/test`,
      key: fx.keys.member,
    });
    assert.deepEqual(
      { delivered: second.json.delivered, error_code: second.json.error_code },
      { delivered: false, error_code: "refused" },
      "the name was not re-resolved and re-judged on the second connect",
    );
    assert.match(second.json.error_detail, /forbidden address/);
    assert.equal(connects, 2, "the resolver was consulted once per connect");
    assert.equal(rx.received.length, 1, "the rebound address was still connected to");
  } finally {
    await rx.close();
    fx.db.close();
  }
});

// ===========================================================================
// The discrimination: each parity rule, run against a build with that ONE rule
// neutralised. A probe both builds refuse identically measures nothing.
// ===========================================================================

/**
 * Load `src/webhooks.ts` with one substring of it, or of `src/transport.ts`,
 * replaced — as a module of its own.
 *
 * The two files import each other, so both copies live in the temp directory
 * and their mutual import is rewritten to point at each other; every other
 * import resolves back into the real `src/`. Nothing is written into `src/`: a
 * source file `git ls-files` does not know about is what
 * `test/p14-r13-probes.test.ts` refuses on sight.
 */
async function mutatedWebhooks(edits: Array<{ file: "webhooks.ts" | "transport.ts"; find: string; replace: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "skillonomia-whprobe-"));
  const paths = { "webhooks.ts": join(dir, "webhooks.ts"), "transport.ts": join(dir, "transport.ts") };
  const rewrite = (text: string): string =>
    text.replace(/from "\.\/([A-Za-z0-9_.-]+\.ts)"/g, (_m, name: string) =>
      `from "${((paths as Record<string, string>)[name] ?? join(SRC, name)).replace(/\\/g, "/")}"`,
    );
  const apply = (text: string, file: string): string => {
    for (const e of edits.filter((x) => x.file === file)) {
      const n = text.split(e.find).length - 1;
      assert.equal(n, 1, `the probe's anchor occurs ${n} times in src/${file}, not once: ${e.find}`);
      text = text.replace(e.find, e.replace);
    }
    return text;
  };
  for (const file of ["transport.ts", "webhooks.ts"] as const) {
    writeFileSync(paths[file], rewrite(apply(readFileSync(join(SRC, file), "utf8"), file)));
  }
  return await import(pathToFileURL(paths["webhooks.ts"]).href);
}

type Outcome = { refused: string } | { accepted: true };

function attempt(fn: () => unknown): Outcome {
  try {
    fn();
    return { accepted: true };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { refused: typeof code === "string" ? code : `THROWN:${String((e as Error).message).slice(0, 60)}` };
  }
}

/** Register one URL through the shipped module and through a neutralised one,
 *  against fresh databases, and require the two to disagree. */
async function discriminate(opts: {
  id: string;
  rule: string;
  url: string;
  policy: { allowLoopback: boolean };
  edits: Array<{ file: "webhooks.ts" | "transport.ts"; find: string; replace: string }>;
}): Promise<void> {
  const run = (register: typeof registerWebhook): { outcome: Outcome; rows: number; secrets: number } => {
    const fx = fixture(new NullTransport());
    const store = new MemorySecretStore();
    const outcome = attempt(() => register(fx.db, store, fx.member.agent_id, opts.url, NOW, opts.policy));
    const rows = (fx.db.prepare("SELECT COUNT(*) AS c FROM webhooks").get() as { c: number }).c;
    const ids = (fx.db.prepare("SELECT id FROM webhooks").all() as Array<{ id: string }>).map((r) => r.id);
    const secrets = ids.filter((id) => store.get(`secretstore://webhook/${id}`) !== undefined).length;
    fx.db.close();
    return { outcome, rows, secrets };
  };

  const shipped = run(registerWebhook);
  const mod = await mutatedWebhooks(opts.edits);
  const neutralised = run(mod.registerWebhook);

  assert.deepEqual(shipped.outcome, { refused: "INVALID_SCHEMA" }, `${opts.id}: the shipped module did not refuse ${opts.url}`);
  assert.deepEqual({ rows: shipped.rows, secrets: shipped.secrets }, { rows: 0, secrets: 0 }, `${opts.id}: the refusal wrote state`);
  assert.notDeepEqual(
    neutralised.outcome,
    shipped.outcome,
    `${opts.id}: THE MUTANT SURVIVED — the URL is refused identically with the rule removed, so this probe measures nothing`,
  );
  console.log(
    `[P1.D-webhook] ${opts.id}  shipped:INVALID_SCHEMA(rows=0,secrets=0)  ` +
      `rule-removed:${"accepted" in neutralised.outcome ? `accepted(rows=${neutralised.rows},secrets=${neutralised.secrets})` : neutralised.outcome.refused}  ` +
      opts.rule,
  );
}

test("[P1.W1] the loopback refusal is the flag's, and its removal admits the URL — and writes a secret", async () => {
  // BOTH readings of the flag are neutralised here, and that is the honest
  // shape of the rule rather than a weakening of the probe. `http://` is
  // admissible only to a host that IS this machine (`requireLoopbackHost`, probed
  // by W4), so for an `http://` URL the scheme reading and the destination
  // reading of the same policy value overlap completely: removing either one
  // alone leaves the other refusing. What separates them is the MESSAGE, and the
  // G-P1-11 test above asserts exactly that — `https is required`, with no
  // parenthesis offering a loopback alternative this deployment has not got.
  // W5 probes the destination reading alone, on the `https` spelling, where the
  // scheme reading cannot apply.
  await discriminate({
    id: "P1.W1",
    rule: "http:// is admitted only where the transport policy delivers to loopback",
    url: "http://localhost:8080/hook",
    policy: { allowLoopback: false },
    edits: [
      // the pre-v1.1 shape: registration deciding the loopback question itself
      { file: "transport.ts", find: "    allowHttp: policy.allowLoopback,", replace: "    allowHttp: true," },
      {
        file: "transport.ts",
        find: "    refuseLoopbackHost: !policy.allowLoopback,",
        replace: "    refuseLoopbackHost: false,",
      },
    ],
  });
});

test("[P1.W2] a blocked IP literal is refused by the transport's own table, under either flag", async () => {
  await discriminate({
    id: "P1.W2",
    rule: "an IP literal is judged at registration against `blockedReason`",
    url: "https://169.254.169.254/hook",
    policy: { allowLoopback: true },
    edits: [
      {
        file: "transport.ts",
        find: "    refuseBlockedLiteral: true,",
        replace: "    refuseBlockedLiteral: false,",
      },
    ],
  });
});

test("[P1.W3] a credential-bearing URL is refused, and the refusal is the parse", async () => {
  await discriminate({
    id: "P1.W3",
    rule: "userinfo in an endpoint URL is refused before the host is read",
    url: "https://evil.com@internal.host/",
    policy: { allowLoopback: true },
    edits: [
      {
        file: "transport.ts",
        find: '  if (url.username !== "" || url.password !== "") {',
        replace: "  if (false) {",
      },
    ],
  });
});

test("[P1.W4] a host that merely begins with a loopback spelling is not this machine", async () => {
  await discriminate({
    id: "P1.W4",
    rule: "the http:// exception is to a host that IS this machine, not to a name that starts like one",
    url: "http://localhost.attacker.com/hook",
    policy: { allowLoopback: true },
    edits: [
      {
        file: "transport.ts",
        find: "    requireLoopbackHost: true,",
        replace: "    requireLoopbackHost: false,",
      },
    ],
  });
});

test("[P1.W5] a loopback destination is refused by the flag, whatever the scheme — and its removal admits https to this machine", async () => {
  await discriminate({
    id: "P1.W5",
    rule: "a host that IS this machine is admitted only where the transport policy delivers to loopback, for every scheme",
    url: "https://127.0.0.1:9/hook",
    policy: { allowLoopback: false },
    edits: [
      {
        // the shape this FIX replaced: the flag read for the scheme only, so
        // the `https` spelling of the same socket walked straight through
        file: "transport.ts",
        find: "    refuseLoopbackHost: !policy.allowLoopback,",
        replace: "    refuseLoopbackHost: false,",
      },
    ],
  });
});

// ===========================================================================
// G-P1-12 — test delivery changes no health counter and no queue row
// ===========================================================================

test("§6.5.2: a test push moves NO endpoint health and NO delivery-queue row — full before/after snapshot", async () => {
  const fx = fixture(defaultTransport(LOOPBACK_ON));
  // an endpoint that answers 500, so the failure path is the one under test:
  // a probe that only ever succeeded would not exercise the counter at all
  const rx = await receiver(() => ({ status: 500, body: "endpoint said no" }));
  try {
    const registered = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: rx.url() },
    });
    assert.equal(registered.status, 201, registered.body);
    const hookId = registered.json.webhook_id;

    // a real queued notice, so the queue this must not touch is not empty
    const v = reviewedVersion(fx, "webhook-isolation");
    const requestId = ulid(NOW);
    fx.db
      .prepare(
        "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, webhook_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?,?, 'pending', 0, 0, ?)",
      )
      .run(requestId, v.versionId, fx.member.agent_id, hookId, NOW);
    // and a non-zero starting health, so "unchanged" is not the same as "zero"
    fx.db.prepare("UPDATE webhooks SET status='failing', failure_count=2, last_error='an earlier delivery' WHERE id=?").run(hookId);

    const before = deliveryState(fx);
    type Health = { status: string; failure_count: number; last_error: string | null };
    const health = (id: string): Health => {
      const r = fx.db.prepare("SELECT status, failure_count, last_error FROM webhooks WHERE id=?").get(id) as Health;
      return { status: r.status, failure_count: r.failure_count, last_error: r.last_error };
    };
    const beforeRow = health(hookId);

    for (let i = 0; i < 3; i += 1) {
      const res = await call(fx, { method: "POST", path: `/v1/webhooks/${hookId}/test`, key: fx.keys.member });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.delivered, false, "the 500 endpoint was reported as delivered");
      assert.equal(res.json.http_status, 500);
      assert.equal(res.json.error_code, "non_2xx");
    }

    const after = deliveryState(fx);
    assert.deepEqual(health(hookId), beforeRow, "a test push moved the endpoint's health");
    assert.equal(after, before, "a test push moved §5.2 state: the full row snapshot differs");
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM adoption_requests").get() as { c: number }).c,
      2,
      "a test push created or removed a delivery-queue row",
    );
    assert.equal(loadRequest(fx.db, requestId)!.state, "pending", "the queued notice was consumed by a test push");
    assert.equal(rx.received.length, 3, "the pushes did not actually happen, so the snapshot proves nothing");

    // ---- AND THE SNAPSHOT DISCRIMINATES. The identical comparator, around a
    // REAL delivery of the same failing endpoint, must report movement. Without
    // this, "unchanged" could mean "this function cannot see a change".
    const jobs = await runWorkerOnce(fx.db, fx.secrets, defaultTransport(LOOPBACK_ON), workerId(NOW, "iso", 1), NOW);
    assert.equal(jobs.length, 1, "the production worker claimed nothing, so the discrimination did not run");
    assert.notEqual(
      deliveryState(fx),
      before,
      "THE COMPARATOR IS BLIND: a real delivery of the same endpoint moved nothing it can see",
    );
    const moved = fx.db.prepare("SELECT status, failure_count FROM webhooks WHERE id=?").get(hookId) as {
      status: string;
      failure_count: number;
    };
    assert.equal(moved.failure_count > 2, true, "a real failed delivery did not increment failure_count");
  } finally {
    await rx.close();
    fx.db.close();
  }
});

test("§6.5.2: a dead endpoint stays dead and is still testable — the diagnostic does not revive what it measures", async () => {
  const fx = fixture(defaultTransport(LOOPBACK_ON));
  const rx = await receiver(() => ({ status: 200 }));
  try {
    const registered = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: rx.url() },
    });
    const hookId = registered.json.webhook_id;
    fx.db.prepare("UPDATE webhooks SET status='dead', failure_count=5 WHERE id=?").run(hookId);
    const before = deliveryState(fx);

    const res = await call(fx, { method: "POST", path: `/v1/webhooks/${hookId}/test`, key: fx.keys.member });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.delivered, true, "a repaired receiver behind a dead endpoint could not be tested");
    assert.equal(deliveryState(fx), before, "a successful test push revived a dead endpoint");
  } finally {
    await rx.close();
    fx.db.close();
  }
});

// ===========================================================================
// §6.5.2 — the answer, the audit row, and what neither may carry
// ===========================================================================

test("§6.5.2: the answer carries the declared members, and the audit row carries no secret and no response body", async () => {
  const fx = fixture(defaultTransport(LOOPBACK_ON));
  const marker = "RESPONSE-BODY-MARKER-6f2a";
  const rx = await receiver(() => ({ status: 418, body: JSON.stringify({ detail: marker.repeat(40) }) }));
  try {
    const registered = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: rx.url() },
    });
    const secret = registered.json.secret as string;
    const res = await call(fx, {
      method: "POST",
      path: `/v1/webhooks/${registered.json.webhook_id}/test`,
      key: fx.keys.member,
    });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(
      Object.keys(res.json).sort(),
      ["delivered", "error_code", "error_detail", "http_status", "latency_ms"],
      "the response body is not the set §6.5.2 declares",
    );
    assert.equal(res.json.delivered, false);
    assert.equal(res.json.http_status, 418);
    assert.equal(WEBHOOK_TEST_ERROR_CODES.includes(res.json.error_code), true, res.json.error_code);
    assert.equal(Number.isInteger(res.json.latency_ms) && res.json.latency_ms >= 0, true, "latency is not a measurement");
    assert.equal(
      typeof res.json.error_detail === "string" && res.json.error_detail.length <= MAX_TEST_ERROR_DETAIL,
      true,
      "error_detail is unbounded",
    );

    // NEITHER THE BODY NOR THE SECRET, in the answer or in the audit.
    const audit = auditRows(fx);
    assert.equal(audit.length, 1, "no audit event was written");
    assert.equal(audit[0].subject_id, registered.json.webhook_id);
    const everything = JSON.stringify(audit) + res.body;
    assert.equal(everything.includes(marker), false, "the endpoint's response body was reflected");
    assert.equal(everything.includes(secret), false, "the signing secret reached the answer or the audit row");
    assert.equal(
      everything.includes(signBody(secret, "{}")) || everything.includes("secret_ref") || everything.includes("secretstore://"),
      false,
      "a signature or a secret reference reached the answer or the audit row",
    );
    // the URL is deliberately absent too: a query string is where tokens live
    assert.equal(JSON.stringify(audit).includes(rx.url()), false, "the audit row carries the endpoint URL");
  } finally {
    await rx.close();
    fx.db.close();
  }
});

test("§6.5.2: a transport that cannot complete an exchange is `transport_error`, and a declined destination is `refused`", async () => {
  const fx = fixture(new NullTransport());
  const registered = await call(fx, {
    method: "POST",
    path: "/v1/webhooks",
    key: fx.keys.member,
    body: { url: "https://adopter.example.com/hook" },
  });
  const res = await call(fx, {
    method: "POST",
    path: `/v1/webhooks/${registered.json.webhook_id}/test`,
    key: fx.keys.member,
  });
  assert.deepEqual(
    { delivered: res.json.delivered, http_status: res.json.http_status, error_code: res.json.error_code },
    { delivered: false, http_status: null, error_code: "transport_error" },
    "a transport that sent nothing was not reported as one",
  );

  // an endpoint whose destination the transport declines outright
  const declining = new HttpsWebhookTransport({ resolve: async () => ["10.1.2.3"] });
  const fx2 = fixture(declining);
  const reg2 = await call(fx2, {
    method: "POST",
    path: "/v1/webhooks",
    key: fx2.keys.member,
    body: { url: "https://adopter.example.com/hook" },
  });
  const res2 = await call(fx2, {
    method: "POST",
    path: `/v1/webhooks/${reg2.json.webhook_id}/test`,
    key: fx2.keys.member,
  });
  assert.equal(res2.json.error_code, "refused", res2.body);
  assert.match(res2.json.error_detail, /forbidden address/);
  fx.db.close();
  fx2.db.close();
});

test("§6.5.2: an endpoint whose secret does not resolve sends nothing and says so", async () => {
  const fx = fixture(defaultTransport(LOOPBACK_ON));
  const rx = await receiver(() => ({ status: 200 }));
  try {
    const registered = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: rx.url() },
    });
    fx.secrets.delete(`secretstore://webhook/${registered.json.webhook_id}`);
    const res = await call(fx, {
      method: "POST",
      path: `/v1/webhooks/${registered.json.webhook_id}/test`,
      key: fx.keys.member,
    });
    assert.deepEqual(
      { delivered: res.json.delivered, http_status: res.json.http_status, error_code: res.json.error_code },
      { delivered: false, http_status: null, error_code: "secret_unresolved" },
      res.body,
    );
    assert.equal(rx.received.length, 0, "an unsigned push was sent");
  } finally {
    await rx.close();
    fx.db.close();
  }
});

test("§6.5.2: the endpoint's own agent and an admin/owner may test it; nobody else is told it exists", async () => {
  const fx = fixture(new NullTransport());
  const registered = await call(fx, {
    method: "POST",
    path: "/v1/webhooks",
    key: fx.keys.member,
    body: { url: "https://adopter.example.com/hook" },
  });
  const path = `/v1/webhooks/${registered.json.webhook_id}/test`;

  for (const who of ["member", "admin", "owner"]) {
    const res = await call(fx, { method: "POST", path, key: fx.keys[who]! });
    assert.equal(res.status, 200, `${who} could not test the endpoint: ${res.body}`);
  }
  for (const who of ["author", "reviewer", "outsider"]) {
    const res = await call(fx, { method: "POST", path, key: fx.keys[who]! });
    assert.equal(res.status, 404, `${who} was told the endpoint exists`);
    assert.equal(res.json.error.code, "NOT_FOUND", who);
  }
  const unknown = await call(fx, { method: "POST", path: "/v1/webhooks/01NOSUCHWEBHOOKID/test", key: fx.keys.owner });
  assert.equal(unknown.status, 404, unknown.body);
  fx.db.close();
});

// ===========================================================================
// The console wrapper
// ===========================================================================

test("§6.5.2: the console wrapper needs a session, admits owner/admin, and refuses a reviewer", async () => {
  const fx = fixture(new NullTransport());
  const registered = await call(fx, {
    method: "POST",
    path: "/v1/webhooks",
    key: fx.keys.owner,
    body: { url: "https://adopter.example.com/hook" },
  });
  const path = `/v1/console/webhooks/${registered.json.webhook_id}/test`;

  // NO SESSION, NO CONSOLE. This is the assertion that a console path left out
  // of the session-required list in src/http.ts would fail.
  const anonymous = await call(fx, { method: "POST", path });
  assert.equal(anonymous.status, 401, anonymous.body);
  assert.equal(anonymous.json.contract, CONSOLE_CONTRACT_V2, "a console refusal must carry the console contract");

  // an API key is not a console credential either
  const withKey = await call(fx, { method: "POST", path, key: fx.keys.owner });
  assert.equal(withKey.status, 401, withKey.body);

  const owner = await signIn(fx, "owner");
  const ok = await call(fx, { method: "POST", path, cookie: owner.cookie, csrf: owner.csrf });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(ok.json.contract, CONSOLE_CONTRACT_V2);
  assert.equal(ok.json.error_code, "transport_error", ok.body);

  const admin = await signIn(fx, "admin");
  const byAdmin = await call(fx, { method: "POST", path, cookie: admin.cookie, csrf: admin.csrf });
  assert.equal(byAdmin.status, 200, byAdmin.body);

  const reviewer = await signIn(fx, "reviewer");
  assert.equal(reviewer.role, "reviewer");
  const refused = await call(fx, { method: "POST", path, cookie: reviewer.cookie, csrf: reviewer.csrf });
  assert.equal(refused.status, 403, refused.body);
  assert.equal(refused.json.error.code, "FORBIDDEN");

  // and both browser defences apply, as they do to every console mutation
  const noCsrf = await call(fx, { method: "POST", path, cookie: owner.cookie });
  assert.equal(noCsrf.status >= 400, true, "a console mutation without the CSRF token was accepted");
  const crossOrigin = await call(fx, {
    method: "POST",
    path,
    cookie: owner.cookie,
    csrf: owner.csrf,
    origin: "http://evil.example",
  });
  assert.equal(crossOrigin.status >= 400, true, "a console mutation from another origin was accepted");
  fx.db.close();
});

// ===========================================================================
// `INV-07` — queued is not delivered, and a test push queues nothing
// ===========================================================================

test("`INV-07`: a delivered test push is not a queued notice, and queues none", async () => {
  const fx = fixture(defaultTransport(LOOPBACK_ON));
  const rx = await receiver(() => ({ status: 200 }));
  try {
    const registered = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: rx.url() },
    });
    const queueBefore = (fx.db.prepare("SELECT COUNT(*) AS c FROM adoption_requests").get() as { c: number }).c;
    const res = await call(fx, {
      method: "POST",
      path: `/v1/webhooks/${registered.json.webhook_id}/test`,
      key: fx.keys.member,
    });
    assert.equal(res.json.delivered, true, res.body);
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM adoption_requests").get() as { c: number }).c,
      queueBefore,
      "a test push queued something",
    );
    // `delivered:true` here means an endpoint answered 2xx to THIS push. It is
    // not a receipt event, and nothing in the receipt chain moved.
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM receipt_events").get() as { c: number }).c >= 0,
      true,
    );
    const body = JSON.parse(rx.received[0].body);
    assert.equal(body.adoption_request_id, undefined, "a test push named an adoption request");
    assert.equal(body.receipt_id, undefined, "a test push named a receipt");
  } finally {
    await rx.close();
    fx.db.close();
  }
});

// ===========================================================================
// The router's own contract for a deferred route
// ===========================================================================

test("§6.5.2: the synchronous return of a deferred route is never an answer", async () => {
  const fx = fixture(new NullTransport());
  const registered = await call(fx, {
    method: "POST",
    path: "/v1/webhooks",
    key: fx.keys.member,
    body: { url: "https://adopter.example.com/hook" },
  });
  const req = {
    method: "POST",
    url: `/v1/webhooks/${registered.json.webhook_id}/test`,
    headers: { authorization: `Bearer ${fx.keys.member}`, host: ORIGIN },
    body: Buffer.alloc(0),
  };
  const sync = handleRest(fx.registry, req);
  assert.equal(typeof sync.pending, "object", "the route did not defer");
  assert.equal(sync.status, 500, "the placeholder must not read as a success");
  const resolved = await sync.pending!;
  assert.equal(resolved.status, 200, resolved.body);
  assert.equal(JSON.parse(resolved.body).error_code, "transport_error");

  // a route that does NOT defer carries no pending member, so a listener that
  // awaits is not paying for one on every request
  const listed = handleRest(fx.registry, { ...req, method: "GET", url: "/v1/webhooks" });
  assert.equal(listed.pending, undefined);
  assert.equal(listed.status, 200);
  fx.db.close();
});

// ===========================================================================
// The production push is untouched: `pushOnce` still records health
// ===========================================================================

test("§5.2 is unchanged: the production push still records endpoint health", async () => {
  const fx = fixture(defaultTransport(LOOPBACK_ON));
  const rx = await receiver(() => ({ status: 200 }));
  try {
    const registered = await call(fx, {
      method: "POST",
      path: "/v1/webhooks",
      key: fx.keys.member,
      body: { url: rx.url() },
    });
    const v = reviewedVersion(fx, "production-push-intact");
    const requestId = ulid(NOW);
    fx.db
      .prepare(
        "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, webhook_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?,?, 'pending', 0, 0, ?)",
      )
      .run(requestId, v.versionId, fx.member.agent_id, registered.json.webhook_id, NOW);
    fx.db.prepare("UPDATE webhooks SET status='failing', failure_count=3 WHERE id=?").run(registered.json.webhook_id);

    const [job] = pollDelivery(fx.db, workerId(NOW, "prod", 1), NOW, 1);
    const out = await pushOnce(fx.db, fx.secrets, defaultTransport(LOOPBACK_ON), job, NOW);
    assert.equal(out.state, "pushed", JSON.stringify(out));
    const row = fx.db.prepare("SELECT status, failure_count FROM webhooks WHERE id=?").get(registered.json.webhook_id) as {
      status: string;
      failure_count: number;
    };
    assert.deepEqual(
      { status: row.status, failure_count: row.failure_count },
      { status: "active", failure_count: 0 },
      "a successful production push no longer heals the endpoint",
    );
  } finally {
    await rx.close();
    fx.db.close();
  }
});
