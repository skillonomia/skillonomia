// P5 — webhook registration, HMAC signing through `secret_ref`, and the push
// worker that drives the §5.2 machine. §5.2 and Appendix H are the complete V1
// contract: one endpoint per adopter, the plaintext secret never in SQLite and
// shown exactly once, and the health rules that decide active/failing/dead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, reviewedVersion, publishedVersion, verifiableVersion, NOW, type P4Fixture } from "./p4-helpers.ts";
import { adoptThroughSurfaces, env } from "./p6-helpers.ts";
import { handleRest } from "../src/http.ts";
import {
  MemorySecretStore,
  signBody,
  verifySignature,
  runWorkerOnce,
  SIGNATURE_HEADER,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransport,
} from "../src/webhooks.ts";
import { loadRequest, workerId, recordWebhookResult, deadLetters, MAX_ATTEMPTS } from "../src/delivery.ts";
import { isApiError } from "../src/errors.ts";

/** A transport that records what it was asked to send and answers to script. */
class FakeTransport implements WebhookTransport {
  readonly sent: WebhookRequest[] = [];
  private readonly answers: WebhookResponse[];
  constructor(answers: WebhookResponse[]) {
    this.answers = answers;
  }
  send(req: WebhookRequest): WebhookResponse {
    this.sent.push(req);
    return this.answers[Math.min(this.sent.length - 1, this.answers.length - 1)];
  }
}

interface WhFixture extends P4Fixture {
  secrets: MemorySecretStore;
}

function fixture(): WhFixture {
  const secrets = new MemorySecretStore();
  const fx = p4Fixture({ secrets }) as WhFixture;
  fx.secrets = secrets;
  // seedGraph() ships one `pending` request; park it so each test's own job is
  // the only claimable one.
  fx.db.prepare("UPDATE adoption_requests SET state='pushed' WHERE id=?").run(fx.seed.request);
  return fx;
}

function rest(fx: WhFixture, method: string, url: string, key: string, body?: unknown) {
  const res = handleRest(fx.registry, {
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"),
  });
  return { status: res.status, body: JSON.parse(res.body) };
}

function requestRow(fx: WhFixture, versionId: string, webhookId: string | null): string {
  const id = `01WHREQ${Math.random().toString(36).slice(2, 10).toUpperCase()}`.padEnd(26, "0").slice(0, 26);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, webhook_id, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?, ?)",
    )
    .run(id, versionId, fx.member.agent_id, webhookId, NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
    )
    .run(id.replace("REQ", "RCP"), id, versionId, fx.member.agent_id, NOW);
  return id;
}

// -------------------------------------------------------------- registration

test("Appendix H: the secret is shown exactly once and never enters SQLite", () => {
  const fx = fixture();
  const created = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" });
  assert.equal(created.status, 201);
  const secret = created.body.secret;
  assert.match(secret, /^whsec_/);

  // it is nowhere in the database — not in webhooks, not anywhere
  const dump = fx.db.prepare("SELECT * FROM webhooks WHERE id=?").get(created.body.webhook_id) as any;
  assert.equal(Object.values(dump).includes(secret), false, "no column holds the plaintext");
  assert.equal(dump.secret_hash.length, 64);
  assert.match(dump.secret_ref, /^secretstore:\/\//);
  assert.equal(fx.secrets.get(dump.secret_ref), secret, "it lives only in the deployment-local store");

  // and it is never handed out again
  const listed = rest(fx, "GET", "/v1/webhooks", fx.keys.member);
  assert.equal(listed.body.items.length, 1);
  assert.equal(JSON.stringify(listed.body).includes(secret), false, "the list never re-exposes the secret");
  assert.equal(JSON.stringify(listed.body).includes(dump.secret_ref), false, "nor its reference");
  fx.db.close();
});

test("§5.2: V1 keeps at most one live endpoint per adopter, and delete is own-only", () => {
  const fx = fixture();
  const first = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://a.example.com/hook" }).body;
  const second = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://b.example.com/hook" }).body;
  const live = (fx.db.prepare("SELECT id, status FROM webhooks WHERE agent_id=?").all(fx.member.agent_id) as any[]).filter(
    (w) => w.status !== "dead",
  );
  assert.deepEqual(live.map((w) => w.id), [second.webhook_id], "registering a new endpoint retires the old");

  assert.equal(rest(fx, "DELETE", `/v1/webhooks/${second.webhook_id}`, fx.keys.outsider).status, 404, "own only");
  assert.equal(rest(fx, "DELETE", `/v1/webhooks/${second.webhook_id}`, fx.keys.member).status, 200);
  assert.equal(fx.secrets.get(`secretstore://webhook/${second.webhook_id}`), undefined, "the secret is dropped with it");
  assert.equal(first.webhook_id !== second.webhook_id, true);
  fx.db.close();
});

test("a non-https url is refused", () => {
  const fx = fixture();
  for (const url of ["http://evil.example.com/hook", "ftp://x/y", "", 42, undefined]) {
    assert.equal(rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url }).status, 400, String(url));
  }
  assert.equal(rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "http://localhost:8080/hook" }).status, 201);
  fx.db.close();
});

// ---------------------------------------------------------------------------
// Registration parses the URL; it does not match a prefix of the string.
//
// The check was `/^(https:\/\/|http:\/\/localhost|http:\/\/127\.0\.0\.1)/`.
// A prefix of a string is not the host of a URL, and two strings said so:
//
//   * `https://evil.com@internal.host/` — everything before the `@` is
//     USERINFO. The URL addresses `internal.host`; the regex read
//     `https://evil.com` and saw a public host.
//   * `http://localhost.attacker.com/` — a name the attacker controls that
//     merely STARTS with `localhost`.
//
// Neither was exploitable: the transport refuses both when it comes to deliver
// (test/transport.test.ts). That is the point — the registration check was
// reporting a filter it did not have, and it is the only thing that would stand
// there if the transport were ever replaced. Both surfaces now call one
// function, `vetEndpointUrl` in src/transport.ts.
// ---------------------------------------------------------------------------

test("registration refuses a URL whose real host hides behind userinfo", () => {
  const fx = fixture();
  for (const url of [
    "https://evil.com@internal.host/",
    "https://internal.host@10.0.0.5/hook",
    "https://user:pw@internal.host/hook",
    "http://localhost@internal.host/hook",
  ]) {
    const res = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url });
    assert.equal(res.status, 400, url);
    assert.match(res.body.error.message, /credentials/, url);
  }
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM webhooks").get() as { c: number }).c,
    0,
    "nothing was registered",
  );
  fx.db.close();
});

test("registration refuses a name that merely starts with `localhost`", () => {
  const fx = fixture();
  for (const url of [
    "http://localhost.attacker.com/",
    "http://localhost.evil.test:8080/hook",
    "http://127.0.0.1.attacker.com/hook",
    "http://notlocalhost/hook",
  ]) {
    const res = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url });
    assert.equal(res.status, 400, url);
    assert.match(res.body.error.message, /http:\/\/ is permitted only to this machine/, url);
  }
  // …while the hosts that ARE this machine still register, which is what
  // Appendix D.1's `webhooks.url` CHECK admits — a receiver under development
  for (const url of ["http://localhost:8080/hook", "http://127.0.0.1:9000/h"]) {
    assert.equal(rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url }).status, 201, url);
  }

  // Two spellings that name this machine as truly as 127.0.0.1 does and that
  // Appendix D.1's CHECK on `webhooks.url` nonetheless does not admit — it is a
  // prefix test over three literal strings. They must come back as a 400 with a
  // reason, NOT as a SQLite constraint violation surfacing as a 500.
  for (const url of ["http://[::1]:9000/h", "http://127.0.0.5/h"]) {
    const res = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url });
    assert.equal(res.status, 400, url);
    assert.match(res.body.error.message, /Appendix D\.1/, url);
  }
  fx.db.close();
});

test("registration and delivery refuse the same strings, because they run the same rules", async () => {
  const fx = fixture();
  // A literal address cannot change between registration and delivery, so
  // registration judges it with the transport's own table rather than waiting.
  for (const [url, why] of [
    ["https://169.254.169.254/hook", /link-local/],
    ["https://10.0.0.7/hook", /private 10\./],
    ["https://[fd00:ec2::254]/hook", /unique local/],
    ["https://[::ffff:169.254.169.254]/hook", /IPv4-mapped/],
  ] as Array<[string, RegExp]>) {
    const res = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url });
    assert.equal(res.status, 400, url);
    assert.match(res.body.error.message, why, url);
  }

  // and the two decoys, put to the transport, are refused there too — this is
  // the "not exploitable today" half, asserted rather than assumed
  const { HttpsWebhookTransport } = await import("../src/transport.ts");
  const transport = new HttpsWebhookTransport({ resolve: async () => ["93.184.216.34"] });
  const send = (url: string) => transport.send({ url, body: "{}", signature: "00" });
  assert.match((await send("https://evil.com@internal.host/")).error!, /carries credentials/);
  assert.match((await send("http://localhost.attacker.com/")).error!, /https is required/);
  fx.db.close();
});

// ------------------------------------------------------------------ signing

test("§5.2: the push carries an HMAC-SHA256 signature over the exact body bytes", async () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "signed-push");
  const hook = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" }).body;
  const req = requestRow(fx, v.versionId, hook.webhook_id);

  const transport = new FakeTransport([{ status: 200 }]);
  const out = await runWorkerOnce(fx.db, fx.secrets, transport, workerId(NOW, "h", 1), NOW);
  assert.deepEqual(out.map((o) => o.state), ["pushed"]);
  assert.equal(transport.sent.length, 1);

  const sent = transport.sent[0];
  assert.equal(sent.url, "https://adopter.example.com/hook");
  assert.equal(verifySignature(hook.secret, sent.body, sent.signature), true, "the adopter can verify it");
  assert.equal(verifySignature("whsec_wrong", sent.body, sent.signature), false);
  assert.notEqual(signBody(hook.secret, sent.body + " "), sent.signature, "the signature covers the exact bytes");
  assert.equal(SIGNATURE_HEADER, "X-Webhook-Signature");

  const body = JSON.parse(sent.body);
  assert.equal(body.adoption_request_id, req);
  assert.equal(body.skill_version_id, v.versionId);
  assert.equal(JSON.stringify(body).includes(hook.secret), false, "the body never carries the secret");
  assert.equal(loadRequest(fx.db, req)!.state, "pushed");
  fx.db.close();
});

test("a webhook 2xx moves the request to `pushed` — it does NOT write a `delivered` receipt event (§5.2)", async () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "pushed-not-delivered");
  const hook = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" }).body;
  const req = requestRow(fx, v.versionId, hook.webhook_id);
  await runWorkerOnce(fx.db, fx.secrets, new FakeTransport([{ status: 204 }]), workerId(NOW, "h", 1), NOW);
  assert.equal(loadRequest(fx.db, req)!.state, "pushed");
  const events = fx.db
    .prepare("SELECT COUNT(*) AS c FROM receipt_events e JOIN adoption_receipts r ON r.id=e.adoption_receipt_id WHERE r.adoption_request_id=?")
    .get(req) as any;
  assert.equal(events.c, 0, "only the adopter's own skill.adopt call writes `delivered`");
  fx.db.close();
});

// -------------------------------------------------------------- the failures

test("§5.2: repeated failures walk the endpoint active → failing → dead, and the request dead-letters", async () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "failing-endpoint");
  const hook = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" }).body;
  const req = requestRow(fx, v.versionId, hook.webhook_id);
  const transport = new FakeTransport([{ status: 500, error: "server error" }]);
  const w = workerId(NOW, "h", 1);

  let clock = NOW;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const out = await runWorkerOnce(fx.db, fx.secrets, transport, w, clock);
    assert.equal(out.length, 1, `attempt ${attempt} was claimed`);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(out[0].state, "pending");
      assert.equal(out[0].endpoint_status, "failing");
      clock = loadRequest(fx.db, req)!.next_attempt_at_ms;
    } else {
      assert.equal(out[0].state, "dead_letter");
      assert.equal(out[0].reason, "max_attempts");
      assert.equal(out[0].endpoint_status, "dead", "the fifth consecutive failure kills the endpoint");
    }
  }
  assert.equal(loadRequest(fx.db, req)!.state, "dead_letter");
  assert.equal((fx.db.prepare("SELECT status FROM webhooks WHERE id=?").get(hook.webhook_id) as any).status, "dead");
  fx.db.close();
});

// P5 verdict 2, blocking B1 — the reviewer's exact reproduction.
test("§5.2: a 2xx that lands after the endpoint died dead-letters as endpoint_dead, never `pushed`", async () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "endpoint-died-mid-push");
  const hook = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" }).body;
  const req = requestRow(fx, v.versionId, hook.webhook_id);

  // a transport whose callback kills the endpoint (other in-flight deliveries
  // timing out) and only then answers 204
  const transport: WebhookTransport = {
    send(r) {
      transportSent.push(r);
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) recordWebhookResult(fx.db, hook.webhook_id, false, NOW, "concurrent timeout");
      return { status: 204 };
    },
  };
  const transportSent: WebhookRequest[] = [];

  const out = await runWorkerOnce(fx.db, fx.secrets, transport, workerId(NOW, "h", 1), NOW);
  assert.equal(transportSent.length, 1, "the push did go out");
  assert.deepEqual(out, [{ request_id: req, state: "dead_letter", endpoint_status: "dead", reason: "endpoint_dead" }]);
  const row = loadRequest(fx.db, req)!;
  assert.equal(row.state, "dead_letter", "`pushed` is terminal and could never converge to endpoint_dead");
  assert.equal(row.dead_letter_reason, "endpoint_dead");
  fx.db.close();
});

test("§5.2: an endpoint already dead before the push is dead-lettered without sending anything", async () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "endpoint-dead-before-push");
  const hook = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" }).body;
  const req = requestRow(fx, v.versionId, hook.webhook_id);
  fx.db.prepare("UPDATE webhooks SET status='dead' WHERE id=?").run(hook.webhook_id);

  const transport = new FakeTransport([{ status: 200 }]);
  const out = await runWorkerOnce(fx.db, fx.secrets, transport, workerId(NOW, "h", 1), NOW);
  assert.equal(transport.sent.length, 0, "a dead endpoint is not an endpoint to try");
  assert.equal(out[0].reason, "endpoint_dead");
  assert.equal(loadRequest(fx.db, req)!.dead_letter_reason, "endpoint_dead");
  fx.db.close();
});

test("no selected endpoint is dead_letter(endpoint_missing), never a silent no-op", async () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "no-endpoint");
  const req = requestRow(fx, v.versionId, null);
  const transport = new FakeTransport([{ status: 200 }]);
  const out = await runWorkerOnce(fx.db, fx.secrets, transport, workerId(NOW, "h", 1), NOW);
  assert.deepEqual(out, [{ request_id: req, state: "dead_letter", reason: "endpoint_missing" }]);
  assert.equal(transport.sent.length, 0, "nothing was sent anywhere");
  assert.equal(loadRequest(fx.db, req)!.dead_letter_reason, "endpoint_missing");
  fx.db.close();
});

test("an unresolvable secret_ref is a delivery failure, never an unsigned push", async () => {
  const fx = fixture();
  const v = reviewedVersion(fx, "lost-secret");
  const hook = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" }).body;
  const req = requestRow(fx, v.versionId, hook.webhook_id);
  fx.secrets.delete(`secretstore://webhook/${hook.webhook_id}`);

  const transport = new FakeTransport([{ status: 200 }]);
  const out = await runWorkerOnce(fx.db, fx.secrets, transport, workerId(NOW, "h", 1), NOW);
  assert.equal(transport.sent.length, 0, "nothing is sent without a signature");
  assert.equal(out[0].state, "pending", "it is a retryable failure");
  assert.equal(out[0].endpoint_status, "failing");
  assert.equal(loadRequest(fx.db, req)!.attempt_count, 1);
  fx.db.close();
});

test("a webhook cannot be registered without workspace membership", () => {
  const fx = fixture();
  const stranger = { ...fx.member, role: null };
  try {
    fx.registry.registerWebhook(stranger, { url: "https://x.example.com/h" });
    assert.fail("expected FORBIDDEN");
  } catch (e) {
    if (!isApiError(e)) throw e;
    assert.equal(e.code, "FORBIDDEN");
  }
  fx.db.close();
});

// ------------------------------------------- surface 11: revocation notices

// §6 surface 11 and §5.1's tail table promise that revoking a version notifies
// its active adopters "through the delivery machine". revokeVersion() used to
// do only the UPDATE and the tlog append, so the promise was documentation.

test("revoking a version queues a revocation notice per ACTIVE adopter, on the same machine", async () => {
  const fx = fixture();
  const v = publishedVersion(fx, "revocation-notices");

  // three adopters with an endpoint each, in three different receipt states
  const running = adoptThroughSurfaces(fx, v, fx.keys.member); // terminal `adopted`
  const midway = adoptThroughSurfaces(fx, v, fx.keys.reviewer, { terminal: "none" }); // still at `delivered`
  const bailed = adoptThroughSurfaces(fx, v, fx.keys.admin, { terminal: "failed" }); // failed — nothing to withdraw
  assert.ok(running.receiptId && midway.receiptId && bailed.receiptId);
  const hooks = new Map<string, string>();
  for (const who of ["member", "reviewer", "admin"] as const) {
    hooks.set(who, rest(fx, "POST", "/v1/webhooks", fx.keys[who], { url: `https://${who}.example.com/hook` }).body.secret);
  }

  const revoked = rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, { reason: "leaks a token" });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.notified_adopters, 2, "the two adopters still running it — not the one that failed");

  const queued = fx.db
    .prepare(
      "SELECT adopter_agent_id, state, webhook_id FROM adoption_requests WHERE skill_version_id=? AND notification_kind='revocation' ORDER BY adopter_agent_id",
    )
    .all(v.versionId) as Array<{ adopter_agent_id: string; state: string; webhook_id: string | null }>;
  assert.deepEqual(
    queued.map((q) => q.adopter_agent_id).sort(),
    [fx.member.agent_id, fx.reviewer.agent_id].sort(),
  );
  for (const q of queued) {
    assert.equal(q.state, "pending", "an ordinary §5.2 job: claimable, leased, retried, dead-lettered");
    assert.ok(q.webhook_id, "with the adopter's endpoint snapshotted at creation, exactly as surface 6 does");
  }
  // …and no receipt was invented for a notice nobody requested
  const receipts = fx.db
    .prepare(
      "SELECT COUNT(*) AS c FROM adoption_receipts WHERE adoption_request_id IN (SELECT id FROM adoption_requests WHERE notification_kind='revocation')",
    )
    .get() as { c: number };
  assert.equal(receipts.c, 0);

  // the worker delivers them, signed, saying what they are and why. (The
  // adoption requests these adopters made earlier are in the same queue and
  // carry no endpoint — they were created before the webhooks were — so the
  // tick also dead-letters those; the notices are picked out by id.)
  const noticeIds = new Set(
    (fx.db.prepare("SELECT id FROM adoption_requests WHERE notification_kind='revocation'").all() as Array<{
      id: string;
    }>).map((r) => r.id),
  );
  const transport = new FakeTransport([{ status: 200 }]);
  const out = await runWorkerOnce(fx.db, fx.secrets, transport, workerId(NOW, "h", 1), NOW);
  assert.deepEqual(
    out.filter((o) => noticeIds.has(o.request_id)).map((o) => o.state),
    ["pushed", "pushed"],
    "both notices were delivered",
  );
  assert.equal(transport.sent.length, 2, "and nothing else reached a transport — the rest had no endpoint");
  for (const sent of transport.sent) {
    const body = JSON.parse(sent.body);
    assert.equal(body.kind, "revocation");
    assert.equal(body.skill_version_id, v.versionId);
    assert.equal(body.revocation_reason, "leaks a token", "the adopter learns WHY without another round trip");
    assert.equal(body.receipt_id, null);
    // §5.1b: the successor question is ANSWERED rather than left out. This
    // version has no replacement, and a member that is absent would say "this
    // server does not tell you" instead of "there is none".
    assert.ok("successor_version_id" in body);
    assert.ok("successor_semantic_version" in body);
    assert.equal(body.successor_version_id, null);
    assert.equal(body.successor_semantic_version, null);
    // …and where the RECIPIENT can get a verdict of its own. A notice addressed
    // to an adopter names a call an adopter may make: the stateless verification
    // route, open to any authenticated principal, over bytes it already holds.
    assert.equal(body.registry_verification_path, "/v1/verify");
    assert.equal(body.registry_verification_path.includes("{"), false, "an unfilled template is not a path");
    const secret = hooks.get(sent.url.includes("member") ? "member" : "reviewer")!;
    assert.equal(verifySignature(secret, sent.body, sent.signature), true, "signed like every other push");
  }
  fx.db.close();
});

test("a revocation notice that has a replacement to name, names it", async () => {
  // The other half of the successor members: `[P5.notice]` above proves the two
  // are ANSWERED when there is no replacement; this proves they carry one when
  // there is. Both are read at PUSH time, so the link a `revoke --successor`
  // wrote reaches an adopter whose delivery had not yet gone out.
  const fx = fixture();
  const predecessor = publishedVersion(fx, "notice-successor");
  const successor = verifiableVersion(fx, "notice-successor", {
    skill_id: predecessor.skillId,
    semver: "2.0.0",
    manifest: { skill_id: predecessor.skillId },
  });
  fx.registry.verifyVersion(fx.owner, successor.versionId);
  adoptThroughSurfaces(fx, predecessor, fx.keys.member);
  const secret = rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" }).body.secret;

  const out = rest(fx, "POST", `/v1/versions/${predecessor.versionId}/revoke`, fx.keys.owner, {
    reason: "leaks a token",
    successor_version_id: successor.versionId,
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.superseded_by, successor.versionId);
  assert.equal(out.body.notifications_queued, 1);
  assert.equal(out.body.notifications_queued, out.body.notified_adopters);

  const transport = new FakeTransport([{ status: 200 }]);
  await runWorkerOnce(fx.db, fx.secrets, transport, workerId(NOW, "h", 1), NOW);
  const notice = transport.sent.map((r) => JSON.parse(r.body)).find((b) => b.kind === "revocation");
  assert.ok(notice, "the notice was never pushed");
  assert.equal(notice.successor_version_id, successor.versionId);
  assert.equal(notice.successor_semantic_version, "2.0.0", "the adopter is told WHICH version to move to, readably");
  assert.equal(notice.registry_verification_path, "/v1/verify");
  const sent = transport.sent.find((r) => JSON.parse(r.body).kind === "revocation")!;
  assert.equal(verifySignature(secret, sent.body, sent.signature), true, "the wider body is signed like every other");
  fx.db.close();
});

test("a revocation notice is not an adoption request: skill.adopt does not acknowledge it", async () => {
  const fx = fixture();
  const v = publishedVersion(fx, "notice-is-not-a-request");
  adoptThroughSurfaces(fx, v, fx.keys.member);
  rest(fx, "POST", "/v1/webhooks", fx.keys.member, { url: "https://adopter.example.com/hook" });
  rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, { reason: "withdrawn" });

  const notice = fx.db
    .prepare("SELECT id FROM adoption_requests WHERE notification_kind='revocation' LIMIT 1")
    .get() as { id: string };
  const attempt = rest(fx, "POST", `/v1/adoptions/${notice.id}/adopt`, fx.keys.member, {
    environment_descriptor: env(),
  });
  assert.equal(attempt.status, 404, JSON.stringify(attempt.body));
  fx.db.close();
});

test("an adopter with no endpoint is a LOUD dead letter, and the view says which message was lost", async () => {
  const fx = fixture();
  const v = publishedVersion(fx, "revocation-no-endpoint");
  adoptThroughSurfaces(fx, v, fx.keys.member); // adopter registers no webhook
  const revoked = rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, { reason: "gone" });
  assert.equal(revoked.body.notified_adopters, 1);

  await runWorkerOnce(fx.db, fx.secrets, new FakeTransport([{ status: 200 }]), workerId(NOW, "h", 1), NOW);
  const dl = deadLetters(fx.db).filter((d) => d.notification_kind === "revocation");
  assert.equal(dl.length, 1);
  assert.equal(dl[0].reason, "endpoint_missing");

  const view = rest(fx, "GET", "/v1/dashboard/dead_letters", fx.keys.owner).body;
  const section = view.sections.find((s: any) => s.key === "dead_letters");
  assert.ok(section.fields.includes("notification_kind"), "the view declares the field it renders");
  // the reason is a CELL now — an answer with its method — because [I-1] and
  // [I-3] hold on every one of the eleven views, not only on the newest five
  assert.ok(
    section.rows.some(
      (r: any) => String(r.notification_kind).startsWith("revocation ·") && String(r.reason).startsWith("endpoint_missing ·"),
    ),
    "an operator can see WHICH adopter was not told WHAT",
  );
  fx.db.close();
});

test("a convergent re-revoke queues nothing a second time", async () => {
  const fx = fixture();
  const v = publishedVersion(fx, "revoke-twice");
  adoptThroughSurfaces(fx, v, fx.keys.member);
  rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, { reason: "once" });
  // the SAME reason: §5.1b rule 2 makes a repeat carrying a different one a
  // `CONFLICT`, and this test is about the convergent repeat
  const again = rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, { reason: "once" });
  assert.equal(again.body.noop, true);
  assert.equal(again.body.notified_adopters, undefined);
  const count = fx.db
    .prepare("SELECT COUNT(*) AS c FROM adoption_requests WHERE notification_kind='revocation'")
    .get() as { c: number };
  assert.equal(count.c, 1, "one notice per adopter, per revocation");
  fx.db.close();
});
