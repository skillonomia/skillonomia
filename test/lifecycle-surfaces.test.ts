// The tail of the §5.1 lifecycle as PUBLIC surfaces.
//
// `publishVersion()` (src/countersign.ts) and the `published → deprecated |
// superseded | revoked` rows of the transition whitelist were implemented and
// tested from inside; nothing exposed them. This file drives the whole tail
// through the adapters only — REST and MCP — because that is the level at which
// §6 ("ACL and error model enforced identically on REST and MCP") and
// Appendix H (idempotency replay, the converging-conflict rule) actually bind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  p4Fixture,
  verifiableVersion,
  publishedVersion,
  reviewedVersion,
  createVersion,
  lint,
  NOW,
  type P4Fixture,
} from "./p4-helpers.ts";
import { handleRest, type RestResponse } from "../src/http.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { makeManifest } from "./p2-helpers.ts";
import { COUNTERSIGN_EVENT } from "../src/countersign.ts";
import { TLOG_DEPRECATED, TLOG_SUPERSEDED, TLOG_REVOKED } from "../src/service.ts";
import { TRANSITION_WHITELIST } from "../src/transitions.ts";

function rest(fx: P4Fixture, method: string, url: string, key: string, body?: unknown): RestResponse {
  return handleRest(fx.registry, {
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"),
  });
}

function restJson(fx: P4Fixture, method: string, url: string, key: string, body?: unknown): { status: number; body: any; res: RestResponse } {
  const res = rest(fx, method, url, key, body);
  return { status: res.status, body: JSON.parse(res.body), res };
}

function mcp(fx: P4Fixture, key: string, name: string, args: any): { isError: boolean; data: any; replayed: boolean } {
  const res = restJson(fx, "POST", "/mcp", key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = res.body.result;
  return {
    isError: result.isError === true,
    data: JSON.parse(result.content[0].text),
    replayed: result._meta?.["skillonomia/idempotency-replayed"] === true,
  };
}

function stateOf(fx: P4Fixture, versionId: string): string {
  return (fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as any).state;
}

function countersigns(fx: P4Fixture): number {
  return (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(COUNTERSIGN_EVENT) as any).c;
}

/** §7.3 row 1, with the §7.2 cross-field rule satisfied so it still lints clean. */
function highRiskManifest(): Record<string, unknown> {
  const base = makeManifest({});
  return {
    // gate 1's cross-field rule: `high` forces required_approvals ⊇ both, and
    // sandbox_requirement `required` — otherwise it never lints clean and the
    // §7.3 gate is never the thing under test
    scope: { ...base.scope, risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] },
    safety: { ...base.safety, sandbox_requirement: "required" },
  };
}

// ===================================================== surface 12: skill.publish

test("§5.1 lifecycle end to end: draft → linted → reviewed → verified → published, over REST only", () => {
  const fx = p4Fixture();

  // draft — surface 1
  const v = createVersion(fx, "lifecycle-rest");
  assert.equal(stateOf(fx, v.versionId), "draft");

  // linted — surface 2
  assert.equal(restJson(fx, "POST", `/v1/versions/${v.versionId}/lint`, fx.keys.author, {}).body.state, "linted");

  // reviewed — surface 3 (request, then an eligible reviewer's approve)
  restJson(fx, "POST", `/v1/versions/${v.versionId}/reviews`, fx.keys.author, { action: "request" });
  assert.equal(
    restJson(fx, "POST", `/v1/versions/${v.versionId}/reviews`, fx.keys.reviewer, { action: "verdict", verdict: "approve" })
      .body.state,
    "reviewed",
  );

  // the §5.1 evidence conjunct still needs a trial adoption; the receipt lane
  // is surfaces 6–8, exercised in full by p5-e2e — here it is the fixture's job
  const t = verifiableVersion(fx, "lifecycle-rest-donor");
  assert.notEqual(t.versionId, v.versionId);
  restJson(fx, "POST", `/v1/versions/${t.versionId}/verify`, fx.keys.owner, {});
  assert.equal(stateOf(fx, t.versionId), "verified");

  // published — surface 12. THE step that had no surface before.
  assert.equal(countersigns(fx), 0);
  const pub = restJson(fx, "POST", `/v1/versions/${t.versionId}/publish`, fx.keys.owner, {});
  assert.equal(pub.status, 200);
  assert.equal(pub.body.state, "published");
  assert.equal(pub.body.skill_version_id, t.versionId);
  assert.equal(stateOf(fx, t.versionId), "published");

  // §4.3.8: publication and the countersign are inseparable
  assert.equal(countersigns(fx), 1, "publication appended exactly one countersign");
  const row = fx.db
    .prepare("SELECT seq, subject_id FROM transparency_log WHERE event_kind=?")
    .get(COUNTERSIGN_EVENT) as any;
  assert.equal(row.subject_id, pub.body.manifest_hash, "the countersign is over this version's manifest_hash");
  assert.equal(pub.body.countersign_seq, row.seq);
  fx.db.close();
});

test("skill.publish over MCP produces the identical result and the identical countersign", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "lifecycle-mcp");
  mcp(fx, fx.keys.owner, "skill.verify", { skill_version_id: v.versionId });
  assert.equal(stateOf(fx, v.versionId), "verified");

  const out = mcp(fx, fx.keys.owner, "skill.publish", { skill_version_id: v.versionId });
  assert.equal(out.isError, false, JSON.stringify(out.data));
  assert.equal(out.data.state, "published");
  assert.equal(stateOf(fx, v.versionId), "published");
  assert.equal(countersigns(fx), 1);
  fx.db.close();
});

test("both adapters return the SAME publish payload for the same version", () => {
  // one version per fixture, published through one adapter each: the bodies
  // must agree field for field (§2 — the adapters carry no logic)
  const viaRest = (() => {
    const fx = p4Fixture();
    const v = verifiableVersion(fx, "parity-pub");
    fx.registry.verifyVersion(fx.owner, v.versionId);
    const body = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, {}).body;
    fx.db.close();
    return body;
  })();
  const viaMcp = (() => {
    const fx = p4Fixture();
    const v = verifiableVersion(fx, "parity-pub");
    fx.registry.verifyVersion(fx.owner, v.versionId);
    const data = mcp(fx, fx.keys.owner, "skill.publish", { skill_version_id: v.versionId }).data;
    fx.db.close();
    return data;
  })();
  // the fixture mints a fresh skill_id per run, so manifest_hash and
  // skill_version_id legitimately differ; everything the ADAPTER decides — the
  // field set, the state, the countersign position — must not
  assert.deepEqual(Object.keys(viaRest).sort(), Object.keys(viaMcp).sort());
  assert.deepEqual(Object.keys(viaRest).sort(), [
    "countersign_seq",
    "manifest_hash",
    "skill_version_id",
    "state",
  ]);
  assert.equal(viaRest.state, viaMcp.state);
  assert.equal(viaRest.countersign_seq, viaMcp.countersign_seq);
  assert.match(viaRest.manifest_hash, /^[0-9a-f]{64}$/);
  assert.match(viaMcp.manifest_hash, /^[0-9a-f]{64}$/);
});

// ------------------------------------------------------------------ §7.3 gate

test("§7.3: a high-risk version is FORBIDDEN with current_state until a HUMAN approves, on both adapters", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "pub-high-risk", { manifest: highRiskManifest() });
  fx.registry.verifyVersion(fx.owner, v.versionId);
  assert.equal(stateOf(fx, v.versionId), "verified");

  const refusedRest = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, {});
  assert.equal(refusedRest.status, 403);
  assert.equal(refusedRest.body.error.code, "FORBIDDEN");
  assert.equal(refusedRest.body.error.current_state, "verified", "the refusal reports the state the version is still in");
  assert.match(refusedRest.body.error.message, /risk_high/, "the §7.3 conditions that are due are named");

  const refusedMcp = mcp(fx, fx.keys.owner, "skill.publish", { skill_version_id: v.versionId });
  assert.equal(refusedMcp.isError, true);
  assert.equal(refusedMcp.data.error.code, "FORBIDDEN");
  assert.equal(refusedMcp.data.error.message, refusedRest.body.error.message, "identical envelope on both adapters");
  assert.equal(refusedMcp.data.error.current_state, "verified");

  assert.equal(stateOf(fx, v.versionId), "verified", "a refused publication moves nothing");
  assert.equal(countersigns(fx), 0, "a refused publication countersigns nothing");

  // a privileged NON-human (service key, role admin) cannot supply the approval
  const svcApproval = restJson(fx, "POST", `/v1/versions/${v.versionId}/approvals`, fx.keys.service, {
    scope: "publish",
    decision: "approved",
  });
  assert.equal(svcApproval.status, 403);
  assert.equal(restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, {}).status, 403);

  // the human admin's approval does unblock it — same call, now 200
  assert.equal(
    restJson(fx, "POST", `/v1/versions/${v.versionId}/approvals`, fx.keys.admin, { scope: "publish", decision: "approved" })
      .status,
    201,
  );
  const ok = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, "published");
  assert.equal(countersigns(fx), 1);
  fx.db.close();
});

// ---------------------------------------------------------------- idempotency

test("publish is idempotent: the replay returns the stored bytes with Idempotency-Replayed", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "pub-idem");
  fx.registry.verifyVersion(fx.owner, v.versionId);

  const first = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, { idempotency_key: "pub-1" });
  assert.equal(first.status, 200);
  assert.equal(first.res.headers["Idempotency-Replayed"], undefined);

  const replay = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, { idempotency_key: "pub-1" });
  assert.equal(replay.status, 200);
  assert.equal(replay.res.headers["Idempotency-Replayed"], "true");
  assert.equal(replay.res.body, first.res.body, "byte-identical replay");
  assert.equal(countersigns(fx), 1, "the replay ran no side effect");

  // MCP replays the same stored response and flags it in _meta
  const viaMcp = mcp(fx, fx.keys.owner, "skill.publish", { skill_version_id: v.versionId, idempotency_key: "pub-1" });
  assert.equal(viaMcp.replayed, true);
  assert.deepEqual(viaMcp.data, first.body);

  // a FRESH key on an already-published version is a convergent noop, not an
  // error (§6): no second countersign, `noop:true` in the body
  const again = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, { idempotency_key: "pub-2" });
  assert.equal(again.status, 200);
  assert.equal(again.body.state, "published");
  assert.equal(again.body.noop, true);
  assert.equal(countersigns(fx), 1, "republication countersigns nothing further");

  // …and the key itself is validated exactly as everywhere else
  assert.equal(
    restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.owner, { idempotency_key: 42 }).body.error.code,
    "INVALID_SCHEMA",
  );
  fx.db.close();
});

// ------------------------------------------------------------- wrong state

test("publishing from a state that is not `verified` is PRECONDITION_FAILED + current_state", () => {
  const fx = p4Fixture();

  const draft = createVersion(fx, "pub-from-draft");
  const fromDraft = restJson(fx, "POST", `/v1/versions/${draft.versionId}/publish`, fx.keys.owner, {});
  assert.equal(fromDraft.status, 412);
  assert.equal(fromDraft.body.error.code, "PRECONDITION_FAILED");
  assert.equal(fromDraft.body.error.current_state, "draft");
  assert.equal(stateOf(fx, draft.versionId), "draft");

  const linted = createVersion(fx, "pub-from-linted");
  lint(fx, linted.versionId);
  assert.equal(
    restJson(fx, "POST", `/v1/versions/${linted.versionId}/publish`, fx.keys.owner, {}).body.error.current_state,
    "linted",
  );

  // `reviewed` is the interesting one: everything but the §5.1 conjunction is
  // in place, and publication must STILL refuse — `verified` is not skippable
  const reviewed = reviewedVersion(fx, "pub-from-reviewed");
  const fromReviewed = restJson(fx, "POST", `/v1/versions/${reviewed.versionId}/publish`, fx.keys.owner, {});
  assert.equal(fromReviewed.status, 412);
  assert.equal(fromReviewed.body.error.current_state, "reviewed");
  assert.equal(stateOf(fx, reviewed.versionId), "reviewed");

  assert.equal(countersigns(fx), 0, "no refused publication countersigned anything");

  // and identically over MCP
  const viaMcp = mcp(fx, fx.keys.owner, "skill.publish", { skill_version_id: reviewed.versionId });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.data.error.code, "PRECONDITION_FAILED");
  assert.equal(viaMcp.data.error.current_state, "reviewed");
  fx.db.close();
});

test("a version that does not exist is NOT_FOUND, not a 500", () => {
  const fx = p4Fixture();
  const res = restJson(fx, "POST", "/v1/versions/does-not-exist/publish", fx.keys.owner, {});
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "NOT_FOUND");
  fx.db.close();
});

// ---------------------------------------------------------------------- ACL

test("publication requires admin/owner: author, member and reviewer are FORBIDDEN on both adapters", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "pub-acl");
  fx.registry.verifyVersion(fx.owner, v.versionId);

  for (const who of ["author", "member", "reviewer"] as const) {
    const viaRest = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys[who], {});
    assert.equal(viaRest.status, 403, `${who} over REST`);
    assert.equal(viaRest.body.error.code, "FORBIDDEN");
    const viaMcp = mcp(fx, fx.keys[who], "skill.publish", { skill_version_id: v.versionId });
    assert.equal(viaMcp.isError, true, `${who} over MCP`);
    assert.equal(viaMcp.data.error.code, "FORBIDDEN");
    assert.equal(viaMcp.data.error.message, viaRest.body.error.message);
  }
  assert.equal(stateOf(fx, v.versionId), "verified", "no refused caller moved it");
  assert.equal(countersigns(fx), 0);

  // the author being the one who wrote it changes nothing: §5.1 makes
  // publication the registry's decision, not the author's
  assert.equal(
    (fx.db.prepare("SELECT author_agent_id FROM skill_versions WHERE id=?").get(v.versionId) as any).author_agent_id,
    fx.author.agent_id,
  );

  // a cross-workspace actor is not even told the version exists (§5.1: a
  // `verified` version never crosses a workspace boundary)
  const outsider = restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.outsider, {});
  assert.equal(outsider.status, 404);
  assert.equal(outsider.body.error.code, "NOT_FOUND");

  // …and the two roles §5.1 does admit succeed
  assert.equal(restJson(fx, "POST", `/v1/versions/${v.versionId}/publish`, fx.keys.admin, {}).status, 200);
  fx.db.close();
});

test("publication is refused without authentication at all", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "pub-anon");
  fx.registry.verifyVersion(fx.owner, v.versionId);
  const res = handleRest(fx.registry, {
    method: "POST",
    url: `/v1/versions/${v.versionId}/publish`,
    headers: {},
    body: Buffer.alloc(0),
  });
  assert.equal(res.status, 401);
  assert.equal(stateOf(fx, v.versionId), "verified");
  fx.db.close();
});

// ================================================== the `published →` tail

test("every state §5.1 promises after `published` has a public surface", () => {
  // The whitelist has always listed all three; before surface 13 only two of
  // them were reachable — `deprecated` had no entry point on either adapter,
  // because the generic transition path is exported by neither. This test is
  // what stops a §5.1 promise from silently going unreachable again.
  const tails = TRANSITION_WHITELIST.published;
  assert.deepEqual([...tails].sort(), ["deprecated", "revoked", "superseded"]);

  const fx = p4Fixture();
  const v = publishedVersion(fx, "tail-surfaces");
  const tools = new Set<string>(MCP_TOOLS.map((t) => t.name));
  const routes: Record<string, string> = {
    deprecated: "deprecate",
    superseded: "supersede",
    revoked: "revoke",
  };
  for (const tail of tails) {
    const route = routes[tail];
    assert.ok(tools.has(`skill.${route}`), `MCP advertises skill.${route}`);
    // a REST route exists: it answers something other than "no such route"
    const res = restJson(fx, "POST", `/v1/versions/${v.versionId}/${route}`, fx.keys.owner, {});
    assert.notEqual(res.status, 404, `POST /v1/versions/{id}/${route} is routed`);
  }
  fx.db.close();
});

// ------------------------------------------------------- surface 13: deprecate

test("published → deprecated over REST: state, deprecation_date and the tlog entry", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "dep-rest");
  assert.equal(stateOf(fx, v.versionId), "published");

  const out = restJson(fx, "POST", `/v1/versions/${v.versionId}/deprecate`, fx.keys.owner, {});
  assert.equal(out.status, 200);
  assert.equal(out.body.state, "deprecated");
  assert.equal(out.body.skill_version_id, v.versionId);
  assert.equal(stateOf(fx, v.versionId), "deprecated");

  // §4.2 Lifecycle-registry: the date is stamped by the registry clock, not
  // left null — the registry view promises this field on a deprecated version
  assert.equal(out.body.deprecation_date, new Date(NOW).toISOString());
  assert.equal(
    (fx.db.prepare("SELECT deprecation_at_ms AS ms FROM skill_versions WHERE id=?").get(v.versionId) as any).ms,
    NOW,
  );

  const tlog = fx.db
    .prepare("SELECT seq, subject_id FROM transparency_log WHERE event_kind=?")
    .all(TLOG_DEPRECATED) as any[];
  assert.equal(tlog.length, 1, "the retirement is transparency-logged, as supersede and revoke are");
  assert.equal(tlog[0].subject_id, v.versionId);
  assert.equal(out.body.tlog_seq, tlog[0].seq);
  fx.db.close();
});

test("published → deprecated over MCP, with the same body and the same effect", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "dep-mcp");
  const out = mcp(fx, fx.keys.owner, "skill.deprecate", { skill_version_id: v.versionId });
  assert.equal(out.isError, false, JSON.stringify(out.data));
  assert.equal(out.data.state, "deprecated");
  assert.equal(out.data.deprecation_date, new Date(NOW).toISOString());
  assert.equal(stateOf(fx, v.versionId), "deprecated");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_DEPRECATED) as any).c,
    1,
  );
  fx.db.close();
});

test("a deprecated version reads back with its §5.1 warning and its deprecation_date", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "dep-visible");
  restJson(fx, "POST", `/v1/versions/${v.versionId}/deprecate`, fx.keys.owner, {});

  // §5.1: "visible with warning; adoption warns" — deprecation retires a
  // package, it does not hide it
  const found = restJson(fx, "GET", `/v1/skills?state=deprecated`, fx.keys.member).body.items.find(
    (i: any) => i.skill_version_id === v.versionId,
  );
  assert.ok(found, "a deprecated version is still searchable in-workspace");
  assert.equal(found.registry.state, "deprecated");
  assert.equal(found.registry.deprecation_date, new Date(NOW).toISOString());
  fx.db.close();
});

test("deprecate is idempotent, and re-deprecating converges without re-stamping the date", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "dep-idem");

  const first = restJson(fx, "POST", `/v1/versions/${v.versionId}/deprecate`, fx.keys.owner, {
    idempotency_key: "dep-1",
  });
  assert.equal(first.res.headers["Idempotency-Replayed"], undefined);

  const replay = restJson(fx, "POST", `/v1/versions/${v.versionId}/deprecate`, fx.keys.owner, {
    idempotency_key: "dep-1",
  });
  assert.equal(replay.res.headers["Idempotency-Replayed"], "true");
  assert.equal(replay.res.body, first.res.body, "byte-identical replay");

  // a FRESH key on an already-deprecated version: convergent noop, one tlog row
  const again = restJson(fx, "POST", `/v1/versions/${v.versionId}/deprecate`, fx.keys.owner, {
    idempotency_key: "dep-2",
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.noop, true);
  assert.equal(again.body.deprecation_date, first.body.deprecation_date, "the recorded date is not moved forward");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_DEPRECATED) as any).c,
    1,
    "the noop logged nothing further",
  );
  fx.db.close();
});

test("deprecating from a state that is not `published` is PRECONDITION_FAILED + current_state", () => {
  const fx = p4Fixture();

  const draft = createVersion(fx, "dep-from-draft");
  const fromDraft = restJson(fx, "POST", `/v1/versions/${draft.versionId}/deprecate`, fx.keys.owner, {});
  assert.equal(fromDraft.status, 412);
  assert.equal(fromDraft.body.error.code, "PRECONDITION_FAILED");
  assert.equal(fromDraft.body.error.current_state, "draft");
  assert.equal(stateOf(fx, draft.versionId), "draft");

  // `verified` is the trap: it is one step from published, and §5.1 admits
  // `deprecated` only from `published`
  const verified = verifiableVersion(fx, "dep-from-verified");
  fx.registry.verifyVersion(fx.owner, verified.versionId);
  const fromVerified = restJson(fx, "POST", `/v1/versions/${verified.versionId}/deprecate`, fx.keys.owner, {});
  assert.equal(fromVerified.status, 412);
  assert.equal(fromVerified.body.error.current_state, "verified");
  assert.equal(stateOf(fx, verified.versionId), "verified");

  // a revoked version is terminal — deprecation cannot soften it
  const revoked = publishedVersion(fx, "dep-from-revoked");
  restJson(fx, "POST", `/v1/versions/${revoked.versionId}/revoke`, fx.keys.owner, { reason: "test revocation" });
  const fromRevoked = restJson(fx, "POST", `/v1/versions/${revoked.versionId}/deprecate`, fx.keys.owner, {});
  assert.equal(fromRevoked.status, 412);
  assert.equal(fromRevoked.body.error.current_state, "revoked");
  assert.equal(stateOf(fx, revoked.versionId), "revoked");

  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_DEPRECATED) as any).c,
    0,
    "no refused deprecation logged anything",
  );

  // identically over MCP
  const viaMcp = mcp(fx, fx.keys.owner, "skill.deprecate", { skill_version_id: verified.versionId });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.data.error.code, "PRECONDITION_FAILED");
  assert.equal(viaMcp.data.error.current_state, "verified");
  fx.db.close();
});

test("deprecate ACL: author, skill owner and admin may; a plain member and a reviewer may not", () => {
  const fx = p4Fixture();

  // refusals first, on a version nobody has retired yet
  const v = publishedVersion(fx, "dep-acl");
  for (const who of ["member", "reviewer"] as const) {
    const viaRest = restJson(fx, "POST", `/v1/versions/${v.versionId}/deprecate`, fx.keys[who], {});
    assert.equal(viaRest.status, 403, `${who} over REST`);
    assert.equal(viaRest.body.error.code, "FORBIDDEN");
    const viaMcp = mcp(fx, fx.keys[who], "skill.deprecate", { skill_version_id: v.versionId });
    assert.equal(viaMcp.isError, true, `${who} over MCP`);
    assert.equal(viaMcp.data.error.message, viaRest.body.error.message, "identical envelope on both adapters");
  }
  assert.equal(stateOf(fx, v.versionId), "published", "no refused caller moved it");

  // a cross-workspace actor is not told it exists: the fixture's access_policy
  // is `workspace`, so the version is invisible outside wsA
  const outsider = restJson(fx, "POST", `/v1/versions/${v.versionId}/deprecate`, fx.keys.outsider, {});
  assert.equal(outsider.status, 404);
  assert.equal(outsider.body.error.code, "NOT_FOUND");

  // and the three the derived rule admits each succeed, on their own version
  for (const who of ["author", "owner", "admin"] as const) {
    const own = publishedVersion(fx, `dep-acl-${who}`);
    const res = restJson(fx, "POST", `/v1/versions/${own.versionId}/deprecate`, fx.keys[who], {});
    assert.equal(res.status, 200, `${who}: ${res.res.body}`);
    assert.equal(stateOf(fx, own.versionId), "deprecated");
  }
  fx.db.close();
});

// -------------------------------------- the other two tails, now reachable

test("published → superseded and published → revoked work end to end through the surfaces", () => {
  // Both had surfaces all along, but the only way to a `published` version was
  // to call publishVersion() from inside a test. With surface 12 they are
  // reachable through the API alone — which is what these assert.
  const fx = p4Fixture();

  // supersede: a successor of the SAME skill, itself at least `verified`
  const predecessor = publishedVersion(fx, "tail-supersede");
  const successor = verifiableVersion(fx, "tail-supersede", {
    skill_id: predecessor.skillId,
    semver: "2.0.0",
    manifest: { skill_id: predecessor.skillId },
  });
  restJson(fx, "POST", `/v1/versions/${successor.versionId}/verify`, fx.keys.owner, {});
  assert.equal(stateOf(fx, successor.versionId), "verified");

  const sup = restJson(fx, "POST", `/v1/versions/${predecessor.versionId}/supersede`, fx.keys.owner, {
    successor_version_id: successor.versionId,
  });
  assert.equal(sup.status, 200);
  assert.equal(sup.body.state, "superseded");
  assert.equal(sup.body.superseded_by, successor.versionId);
  assert.equal(stateOf(fx, predecessor.versionId), "superseded");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_SUPERSEDED) as any).c,
    1,
  );

  // revoke, over MCP this time
  const doomed = publishedVersion(fx, "tail-revoke");
  const rev = mcp(fx, fx.keys.owner, "skill.revoke", {
    skill_version_id: doomed.versionId,
    reason: "a dependency turned out to be compromised",
  });
  assert.equal(rev.isError, false, JSON.stringify(rev.data));
  assert.equal(rev.data.state, "revoked");
  assert.equal(stateOf(fx, doomed.versionId), "revoked");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_REVOKED) as any).c,
    1,
  );
  fx.db.close();
});

test("the three tails are mutually exclusive: each is terminal", () => {
  const fx = p4Fixture();
  const dep = publishedVersion(fx, "terminal-dep");
  restJson(fx, "POST", `/v1/versions/${dep.versionId}/deprecate`, fx.keys.owner, {});

  // §5.1 whitelist: deprecated/superseded/revoked lead nowhere
  assert.deepEqual([...TRANSITION_WHITELIST.deprecated], []);
  assert.deepEqual([...TRANSITION_WHITELIST.superseded], []);
  assert.deepEqual([...TRANSITION_WHITELIST.revoked], []);

  // a deprecated version cannot then be revoked or superseded
  const revokeIt = restJson(fx, "POST", `/v1/versions/${dep.versionId}/revoke`, fx.keys.owner, { reason: "too late" });
  assert.equal(revokeIt.status, 412);
  assert.equal(revokeIt.body.error.current_state, "deprecated");
  assert.equal(stateOf(fx, dep.versionId), "deprecated");

  // …nor republished. publishVersion() decides LEGALITY first and only then
  // looks at the countersign row, so a version that was published and has
  // since been retired answers §6's PRECONDITION_FAILED + current_state, like
  // every other forbidden transition. (It used to answer CONFLICT, because the
  // countersign check ran first and a retired version necessarily carries a
  // countersign — the state is only reachable through `published`.)
  const republish = restJson(fx, "POST", `/v1/versions/${dep.versionId}/publish`, fx.keys.owner, {});
  assert.equal(republish.status, 412);
  assert.equal(republish.body.error.code, "PRECONDITION_FAILED");
  assert.equal(republish.body.error.current_state, "deprecated");
  assert.equal(stateOf(fx, dep.versionId), "deprecated", "the refusal moved nothing");
  fx.db.close();
});

// ------------------------------------- the surface inventory cannot go stale

test("the numbered surfaces, SPEC's Appendix H and docs/API.md agree with the code", () => {
  // SPEC said "eleven operations" while the code advertised twelve tools, and
  // nothing noticed. The inventory is now derived from MCP_TOOLS in one place
  // and compared against every document that states it.
  const root = dirname(fileURLToPath(import.meta.url));
  const read = (p: string): string => readFileSync(join(root, "..", p), "utf8");

  // `skill.approve` is deliberately NOT numbered: §7.3 makes approval an
  // API-level enforcement point rather than a step of the skill lifecycle, so
  // it is listed among Appendix H's auxiliaries.
  const numbered = MCP_TOOLS.map((t) => t.name).filter((n) => n.startsWith("skill.") && n !== "skill.approve");
  const spec = read("SPEC.md");

  // Appendix H's contract table: rows `| N | \`skill.x\` | ...`
  const rows = [...spec.matchAll(/^\| (\d+) \| `(skill\.[a-z_.]+)` \| `(?:POST|GET)/gm)].map((m) => ({
    n: Number(m[1]),
    name: m[2],
  }));
  assert.deepEqual(
    rows.map((r) => r.n),
    Array.from({ length: numbered.length }, (_, i) => i + 1),
    "Appendix H numbers its surfaces 1..N with no gap",
  );
  assert.deepEqual(new Set(rows.map((r) => r.name)), new Set(numbered), "Appendix H lists exactly the advertised tools");

  // the prose counts, in every document that states one
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const word = words[numbered.length];
  assert.ok(word, "the count has a spelled-out form");
  assert.ok(spec.includes(`mirror of the same ${word} operations`), `SPEC §2: "${word} operations"`);
  assert.ok(spec.includes(`it is not one of the ${word} public`), `SPEC §5.2: "${word} public surfaces"`);
  assert.ok(
    spec.includes(`## Appendix H. NORMATIVE API / MCP contracts (${numbered.length} surfaces`),
    `Appendix H's heading counts ${numbered.length}`,
  );
  assert.ok(read("docs/API.md").includes(`## The ${word} surfaces`), `docs/API.md: "The ${word} surfaces"`);

  // every numbered surface is documented in docs/API.md with its REST route
  const api = read("docs/API.md");
  for (const name of numbered) {
    assert.ok(api.includes(`\`${name}\``), `docs/API.md documents ${name}`);
  }
});
