// P4 — the same rules through BOTH adapters. §6 makes these negative tests
// mandatory on REST and MCP alike, and §2 says the adapters carry no
// logic: identical verdicts, identical error envelopes, no route that reaches
// a state around the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, verifiableVersion, reviewedVersion, publishedVersion, createVersion, lint, NOW, type P4Fixture } from "./p4-helpers.ts";
import { handleRest, type RestResponse } from "../src/http.ts";
import { ulid } from "../src/ulid.ts";

function rest(fx: P4Fixture, method: string, url: string, key: string | null, body?: unknown): RestResponse {
  return handleRest(fx.registry, {
    method,
    url,
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"),
  });
}

function restJson(fx: P4Fixture, method: string, url: string, key: string, body?: unknown): { status: number; body: any } {
  const res = rest(fx, method, url, key, body);
  return { status: res.status, body: JSON.parse(res.body) };
}

function mcp(fx: P4Fixture, key: string, name: string, args: any): { isError: boolean; data: any } {
  const res = restJson(fx, "POST", "/mcp", key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = res.body.result;
  return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
}

function stateOf(fx: P4Fixture, id: string): string {
  return (fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(id) as any).state;
}

// ------------------------------------------------------------- surface parity

test("both adapters return the SAME refusal for a version missing a §5.1 conjunct, and neither transitions it", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "parity-refusal");

  const viaRest = restJson(fx, "POST", `/v1/versions/${v.versionId}/verify`, fx.keys.owner, {});
  assert.equal(viaRest.status, 200);
  assert.equal(viaRest.body.verdict, "not_verified");
  assert.equal(viaRest.body.checks.find((c: any) => c.id === "evidence_receipt").satisfied, false);

  const viaMcp = mcp(fx, fx.keys.owner, "skill.verify", { skill_version_id: v.versionId });
  assert.equal(viaMcp.isError, false);
  assert.equal(viaMcp.data.verdict, "not_verified");
  assert.deepEqual(
    viaMcp.data.checks.map((c: any) => [c.id, c.satisfied]),
    viaRest.body.checks.map((c: any) => [c.id, c.satisfied]),
  );
  assert.equal(stateOf(fx, v.versionId), "reviewed", "no adapter path moved it");
  fx.db.close();
});

test("the whole review→verify path works identically over MCP", () => {
  const fx = p4Fixture();
  const v = createVersion(fx, "mcp-happy-path");
  assert.equal(lint(fx, v.versionId), "linted");

  const requested = mcp(fx, fx.keys.author, "skill.review.request", {
    skill_version_id: v.versionId,
    action: "request",
  });
  assert.equal(requested.isError, false);
  assert.ok(requested.data.notified.includes(fx.reviewer.agent_id));

  const approved = mcp(fx, fx.keys.reviewer, "skill.review.request", {
    skill_version_id: v.versionId,
    action: "verdict",
    verdict: "approve",
  });
  assert.equal(approved.data.state, "reviewed");
  assert.ok(approved.data.attestation_id);

  // still no evidence receipt → still refused, over MCP
  assert.equal(mcp(fx, fx.keys.owner, "skill.verify", { skill_version_id: v.versionId }).data.verdict, "not_verified");
  fx.db.close();
});

test("self-review is FORBIDDEN with the same envelope on REST and MCP", () => {
  const fx = p4Fixture();
  const v = createVersion(fx, "parity-self-review");
  lint(fx, v.versionId);

  const viaRest = restJson(fx, "POST", `/v1/versions/${v.versionId}/reviews`, fx.keys.author, {
    action: "verdict",
    verdict: "approve",
  });
  assert.equal(viaRest.status, 403);
  assert.equal(viaRest.body.error.code, "FORBIDDEN");

  const viaMcp = mcp(fx, fx.keys.author, "skill.review.request", {
    skill_version_id: v.versionId,
    action: "verdict",
    verdict: "approve",
  });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.data.error.code, "FORBIDDEN");
  assert.equal(viaMcp.data.error.message, viaRest.body.error.message);
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM attestations WHERE skill_version_id=?").get(v.versionId) as any).c,
    0,
  );
  fx.db.close();
});

test("a service key cannot pass the §7.3 human gate on either adapter (§6 mandatory negative test)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "parity-human-gate");
  const req = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
    )
    .run(req, v.versionId, fx.member.agent_id, NOW);

  const viaRest = restJson(fx, "POST", `/v1/versions/${v.versionId}/approvals`, fx.keys.service, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req,
  });
  assert.equal(viaRest.status, 403);
  assert.equal(viaRest.body.error.code, "FORBIDDEN");

  const viaMcp = mcp(fx, fx.keys.service, "skill.approve", {
    skill_version_id: v.versionId,
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req,
  });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.data.error.code, "FORBIDDEN");
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c, 0);

  // the human admin succeeds on both — over MCP here
  const ok = mcp(fx, fx.keys.admin, "skill.approve", {
    skill_version_id: v.versionId,
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req,
  });
  assert.equal(ok.isError, false);
  assert.equal(ok.data.decision, "approved");
  fx.db.close();
});

test("approval replay across requests is refused on both adapters", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "parity-replay");
  const ins = fx.db.prepare(
    "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
  );
  const reqA = ulid(NOW);
  const reqB = ulid(NOW + 1);
  ins.run(reqA, v.versionId, fx.member.agent_id, NOW);
  ins.run(reqB, v.versionId, fx.reviewer.agent_id, NOW);

  const first = restJson(fx, "POST", `/v1/versions/${v.versionId}/approvals`, fx.keys.admin, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: reqA,
  });
  assert.equal(first.status, 201);

  // the same approval id cannot be pointed at reqB — a NEW decision is needed,
  // and reqB has none
  const rows = fx.db.prepare("SELECT adoption_request_id FROM approvals").all() as Array<{ adoption_request_id: string }>;
  assert.deepEqual(rows.map((r) => r.adoption_request_id), [reqA]);
  const bViaMcp = mcp(fx, fx.keys.member, "skill.approve", {
    skill_version_id: v.versionId,
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: reqB,
  });
  assert.equal(bViaMcp.isError, true, "a non-human member cannot authorize reqB either");
  fx.db.close();
});

test("revoke and supersede are reachable on both adapters and refuse identically", () => {
  const fx = p4Fixture();
  const a = publishedVersion(fx, "parity-revoke");
  const b = publishedVersion(fx, "parity-supersede");
  const successor = verifiableVersion(fx, "parity-supersede", {
    skill_id: b.skillId,
    semver: "2.0.0",
    manifest: { skill_id: b.skillId },
  });
  fx.registry.verifyVersion(fx.owner, successor.versionId);

  // reason is mandatory — same INVALID_SCHEMA on both
  const restNoReason = restJson(fx, "POST", `/v1/versions/${a.versionId}/revoke`, fx.keys.owner, {});
  assert.equal(restNoReason.status, 400);
  const mcpNoReason = mcp(fx, fx.keys.owner, "skill.revoke", { skill_version_id: a.versionId });
  assert.equal(mcpNoReason.isError, true);
  assert.equal(mcpNoReason.data.error.code, "INVALID_SCHEMA");
  assert.equal(stateOf(fx, a.versionId), "published");

  const revoked = mcp(fx, fx.keys.owner, "skill.revoke", { skill_version_id: a.versionId, reason: "over MCP" });
  assert.equal(revoked.data.state, "revoked");

  const superseded = restJson(fx, "POST", `/v1/versions/${b.versionId}/supersede`, fx.keys.owner, {
    successor_version_id: successor.versionId,
  });
  assert.equal(superseded.status, 200);
  assert.equal(superseded.body.state, "superseded");

  // a reviewer may supersede but NOT revoke (§6 ACL matrix)
  const c = publishedVersion(fx, "parity-reviewer-revoke");
  const byReviewer = mcp(fx, fx.keys.reviewer, "skill.revoke", { skill_version_id: c.versionId, reason: "not my call" });
  assert.equal(byReviewer.isError, true);
  assert.equal(byReviewer.data.error.code, "FORBIDDEN");
  fx.db.close();
});

test("surface 4 keeps BOTH forms: the stateless §4.4 check is unchanged and cannot be confused with the transition", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "both-forms");
  const archiveB64 = (fx.registry.blobs.get(
    (fx.db.prepare("SELECT package_blob_ref FROM skill_versions WHERE id=?").get(v.versionId) as any).package_blob_ref,
  ) as Buffer).toString("base64");

  // stateless form: a verdict about the uploaded bytes, no state change
  const stateless = restJson(fx, "POST", "/v1/verify", fx.keys.member, { archive: archiveB64 });
  assert.equal(stateless.status, 200);
  assert.ok(typeof stateless.body.verdict === "string");
  assert.equal(stateOf(fx, v.versionId), "reviewed");

  // both forms named at once is INVALID_SCHEMA, never a silent choice
  const both = mcp(fx, fx.keys.member, "skill.verify", {
    skill_version_id: v.versionId,
    archive_base64: archiveB64,
  });
  assert.equal(both.isError, true);
  assert.equal(both.data.error.code, "INVALID_SCHEMA");

  // the stateless form is not an ACL hole: it never transitions anything
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  assert.equal(mcp(fx, fx.keys.member, "skill.verify", { archive_base64: archiveB64 }).isError, false);
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  fx.db.close();
});

test("the transparency log is readable on both adapters and stays chain-verifiable", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "tlog-read");
  fx.registry.verifyVersion(fx.owner, v.versionId);

  const viaRest = restJson(fx, "GET", "/v1/tlog?limit=50", fx.keys.member);
  assert.equal(viaRest.status, 200);
  assert.ok(viaRest.body.items.length >= 2, "attestation + verified entries");
  const viaMcp = mcp(fx, fx.keys.member, "tlog.read", { limit: 50 });
  assert.deepEqual(
    viaMcp.data.items.map((i: any) => i.seq),
    viaRest.body.items.map((i: any) => i.seq),
  );
  // paging
  const page1 = restJson(fx, "GET", "/v1/tlog?limit=1", fx.keys.member);
  assert.equal(page1.body.items.length, 1);
  const page2 = restJson(fx, "GET", `/v1/tlog?limit=1&cursor=${page1.body.next_cursor}`, fx.keys.member);
  assert.equal(page2.body.items[0].seq, page1.body.items[0].seq + 1);
  fx.db.close();
});

test("every P4 route needs a valid Bearer key", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "authn-required");
  for (const path of [
    `/v1/versions/${v.versionId}/reviews`,
    `/v1/versions/${v.versionId}/verify`,
    `/v1/versions/${v.versionId}/supersede`,
    `/v1/versions/${v.versionId}/revoke`,
    `/v1/versions/${v.versionId}/approvals`,
  ]) {
    assert.equal(rest(fx, "POST", path, null, {}).status, 401, path);
  }
  assert.equal(rest(fx, "GET", "/v1/tlog", null).status, 401);
  fx.db.close();
});

test("idempotent replay is byte-identical on the P4 mutations, on both adapters", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "idempotent-revoke");
  const first = rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, {
    reason: "once",
    idempotency_key: "rev-1",
  });
  const replay = rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, {
    reason: "once",
    idempotency_key: "rev-1",
  });
  assert.equal(replay.body, first.body);
  assert.equal(replay.headers["Idempotency-Replayed"], "true");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind='version_revoked'").get() as any).c,
    1,
    "a replay writes no second tlog entry",
  );
  fx.db.close();
});
