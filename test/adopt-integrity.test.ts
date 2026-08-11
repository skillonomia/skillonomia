// The integrity of the DECLARED ENVIRONMENT — who may record one, on which
// row, and what a late caller gets instead.
//
// What the release run found, on live data rather than by reading code:
// `skill.adopt` wrote `adoption_requests.requester_context_json`
// UNCONDITIONALLY and only then tried to append the `delivered` event under a
// key the SERVER chose. A second caller therefore got `noop:true` on the event
// — while its descriptor had already replaced the first caller's — and was
// handed the whole `archive_base64` for an adoption that did not happen. The
// receipt and the environment on one request could belong to two different
// callers, silently.
//
// The consequence that made it a blocker rather than an untidiness: anything
// counting declared runtimes read that mutable column, so an ordinary
// `skill.adopt` carrying an invented `runtime.id`, aimed at requests whose
// chains were long closed, rewrote the record of what had executed — no event,
// no error, no trace.
//
// The fix is architectural and this file is its evidence: the descriptor now
// lives in the INSERT-only `delivered` event, the count is a query over the
// journal, a late caller is refused the way §5.3 refuses a late append, the ONE
// caller entitled to a repeat still gets its bytes back, and the adopter can
// read its own declaration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, reviewedVersion, goodEvidence, NOW, type P4Fixture, type BuiltVersion } from "./p4-helpers.ts";
import { rest, env, ENV } from "./p6-helpers.ts";
import { insertAgent } from "./helpers.ts";
import { ctxFor } from "./p2-helpers.ts";
import { mintApiKey, type AuthContext } from "../src/auth.ts";
import { appendReceiptEvent, derivedState } from "../src/receipts.ts";
import { isApiError } from "../src/errors.ts";

/** A fresh request on `v` for `who`, through surface 6. */
function request(fx: P4Fixture, v: BuiltVersion, who: AuthContext): { requestId: string; receiptId: string } {
  const res = fx.registry.requestAdoption(who, { skill_version_id: v.versionId }).response;
  return { requestId: res.adoption_request_id, receiptId: res.receipt_id };
}

/** The environment recorded on the `delivered` event of a receipt, as stored. */
function declaredOnEvent(fx: P4Fixture, receiptId: string): any {
  const row = fx.db
    .prepare("SELECT environment_json FROM receipt_events WHERE adoption_receipt_id=? AND event='delivered'")
    .get(receiptId) as { environment_json: string | null } | undefined;
  return row?.environment_json == null ? null : JSON.parse(row.environment_json).environment_descriptor;
}

// ---------------------------------------------------------------------------
// 1. The reproduction. On the old behaviour every assertion below was false.
// ---------------------------------------------------------------------------

test("a second caller cannot replace the environment of an adoption it did not make", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-overwrite");
  const { requestId, receiptId } = request(fx, v, fx.member);

  const first = env({ runtime: { id: "claude-code", version: "2.1.224" } });
  const ok = fx.registry.adopt(fx.member, requestId, { environment_descriptor: first }, "session-a-key").response;
  assert.equal(ok.receipt_event, "delivered");
  assert.deepEqual(declaredOnEvent(fx, receiptId), first);

  // the sibling session: same principal (surface 7 admits no one else), its own
  // freshly generated key, its own — different — environment
  const second = env({ runtime: { id: "probe", version: "1.0.0" } });
  let thrown: any = null;
  try {
    fx.registry.adopt(fx.member, requestId, { environment_descriptor: second }, "session-b-key");
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown && isApiError(thrown), "the late caller is refused, not served");
  assert.equal(thrown.code, "PRECONDITION_FAILED");
  assert.equal(thrown.current_state, "delivered", "the refusal names the current state, as §5.3 does");
  assert.ok(!("package" in (thrown ?? {})), "and carries no package");

  // the first caller's declaration is untouched, on the event and in the cache
  assert.deepEqual(declaredOnEvent(fx, receiptId), first);
  const cached = JSON.parse(
    (fx.db.prepare("SELECT requester_context_json AS c FROM adoption_requests WHERE id=?").get(requestId) as { c: string }).c,
  ).environment_descriptor;
  assert.deepEqual(cached, first, "the denormalized copy followed the event and not the last writer");
  assert.equal(derivedState(fx.db, receiptId), "delivered", "one handover, one chain");
  fx.db.close();
});

test("the refusal is the same refusal the receipt surface gives, over REST too", () => {
  // "One API, two relations to one state machine" was itself a defect: /events
  // answered a late caller 412 with a reason, /adopt answered 200, handed over
  // the archive, and hid the refusal in a boolean.
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-rest-symmetry");
  const requested = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  const requestId = requested.body.adoption_request_id;

  const first = rest(fx, "POST", `/v1/adoptions/${requestId}/adopt`, fx.keys.member, {
    environment_descriptor: ENV,
    idempotency_key: "rest-a",
  });
  assert.equal(first.status, 200, first.raw);
  assert.ok(first.body.package.archive_base64.length > 0);
  assert.equal(first.body.noop, undefined, "handover happens once; there is no noop shape any more");

  const late = rest(fx, "POST", `/v1/adoptions/${requestId}/adopt`, fx.keys.member, {
    environment_descriptor: env({ runtime: { id: "probe", version: "1.0.0" } }),
    idempotency_key: "rest-b",
  });
  assert.equal(late.status, 412, late.raw);
  assert.equal(late.body.error.code, "PRECONDITION_FAILED");
  assert.equal(late.body.current_state ?? late.body.error.current_state, "delivered");
  assert.equal(late.raw.includes("archive_base64"), false, "no package reaches a caller whose adoption did not happen");
  fx.db.close();
});

// ---------------------------------------------------------------------------
// 2. The exception that must survive: recoverability for the ONE caller that
//    earned it. A repeat is a match of (principal, key), never of state.
// ---------------------------------------------------------------------------

test("the same principal replaying the same key gets its bytes back, package included", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-replay");
  const { requestId, receiptId } = request(fx, v, fx.member);

  const first = fx.registry.adopt(fx.member, requestId, { environment_descriptor: ENV }, "same-key");
  assert.equal(first.replayed, false);
  const again = fx.registry.adopt(fx.member, requestId, { environment_descriptor: ENV }, "same-key");
  assert.equal(again.replayed, true, "this is the recovery path, not a second adoption");
  assert.equal(again.responseJson, first.responseJson, "byte for byte, so a caller that lost the response can recover it");
  assert.ok(again.response.package.archive_base64.length > 0, "including the package: the request is already spent");

  // over REST, with the header that says so and the same body bytes
  const restFirst = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  const a = rest(fx, "POST", `/v1/adoptions/${restFirst.body.adoption_request_id}/adopt`, fx.keys.member, {
    environment_descriptor: ENV,
    idempotency_key: "recover-me",
  });
  const b = rest(fx, "POST", `/v1/adoptions/${restFirst.body.adoption_request_id}/adopt`, fx.keys.member, {
    environment_descriptor: ENV,
    idempotency_key: "recover-me",
  });
  assert.equal(b.status, 200);
  assert.equal(b.raw, a.raw, "the replayed body is the original bytes");
  assert.equal(b.headers["Idempotency-Replayed"], "true");

  // and the replay wrote nothing: the chain still holds exactly the two rows the
  // first pass wrote — the `requested` event that opened it and one `delivered`
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) c FROM receipt_events WHERE adoption_receipt_id=?").get(receiptId) as { c: number }).c,
    2,
  );
  assert.deepEqual(
    (
      fx.db
        .prepare("SELECT event FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq")
        .all(receiptId) as Array<{ event: string }>
    ).map((r) => r.event),
    ["requested", "delivered"],
  );
  fx.db.close();
});

test("a replay is bounded by the principal, not by the request: another agent's key is not a key here", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-replay-scope");
  const { requestId } = request(fx, v, fx.member);
  fx.registry.adopt(fx.member, requestId, { environment_descriptor: ENV }, "shared-string");

  // the same key STRING from a different principal is a different key: it does
  // not replay, and it does not adopt somebody else's request either
  const other = insertAgent(fx.db, fx.seed.wsA, "integrity-other", "agent", NOW);
  fx.db.prepare("INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)").run(
    other, fx.seed.wsA, "member", NOW,
  );
  const otherCtx = ctxFor(fx.seed, other, fx.seed.wsA, "member");
  mintApiKey(fx.db, other, NOW);
  let thrown: any = null;
  try {
    fx.registry.adopt(otherCtx, requestId, { environment_descriptor: ENV }, "shared-string");
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown && isApiError(thrown));
  assert.equal(thrown.code, "NOT_FOUND", "another agent's request is not acknowledged to exist (Appendix H)");
  fx.db.close();
});

// ---------------------------------------------------------------------------
// 3. The read the adopter needs to check any of this from its own side.
// ---------------------------------------------------------------------------

test("the adopter reads its own declared environment back, in its own event", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-readback");
  const { requestId, receiptId } = request(fx, v, fx.member);
  const declared = env({ runtime: { id: "claude-code", version: "2.1.224" }, model: { id: "claude-opus-5", version: "claude-opus-5" } });
  fx.registry.adopt(fx.member, requestId, { environment_descriptor: declared });

  const view = rest(fx, "GET", `/v1/receipts/${receiptId}`, fx.keys.member);
  assert.equal(view.status, 200, view.raw);
  const delivered = view.body.events.find((e: any) => e.event === "delivered");
  assert.deepEqual(delivered.environment_descriptor, declared, "what was sent is what is readable");

  // every other row carries none, and the field is present rather than absent
  fx.registry.validateOutcome(fx.member, receiptId, { event: "attempted" });
  const after = rest(fx, "GET", `/v1/receipts/${receiptId}`, fx.keys.member);
  const attempted = after.body.events.find((e: any) => e.event === "attempted");
  assert.equal(attempted.environment_descriptor, null);
  fx.db.close();
});

test("a synthesized `delivered` declares nothing, because nobody declared it", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-synth");
  const { receiptId } = request(fx, v, fx.member);
  // §5.3: `attempted` from `none` synthesizes the `delivered` row
  fx.registry.validateOutcome(fx.member, receiptId, { event: "attempted" });
  assert.equal(declaredOnEvent(fx, receiptId), null, "the auto-ack marker is not an adopter declaration");
  fx.db.close();
});

test("no other event may carry a declared environment", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-event-binding");
  const { requestId, receiptId } = request(fx, v, fx.member);
  fx.registry.adopt(fx.member, requestId, { environment_descriptor: ENV });
  // the surface takes no such input; the machine refuses it anyway, so the
  // descriptor cannot acquire a second home by a later change
  assert.throws(
    () =>
      appendReceiptEvent(fx.db, {
        receiptId,
        actorAgentId: fx.member.agent_id,
        event: "attempted",
        environment: { environment_descriptor: ENV },
        idempotencyKey: "smuggle",
        nowMs: NOW,
      }),
    /recorded on `delivered` only/,
  );
  fx.db.close();
});

// ---------------------------------------------------------------------------
// 4. A closed chain stays closed, and the cache column is not the record.
// ---------------------------------------------------------------------------

/** Drive a full adoption (request → adopt → attempted → adopted) as `who`. */
function fullAdoption(fx: P4Fixture, v: BuiltVersion, who: AuthContext, runtimeId: string): string {
  const { requestId, receiptId } = request(fx, v, who);
  fx.registry.adopt(who, requestId, {
    environment_descriptor: env({ runtime: { id: runtimeId, version: "1.0.0" } }),
  });
  fx.registry.validateOutcome(who, receiptId, { event: "attempted" });
  fx.registry.validateOutcome(who, receiptId, { event: "adopted", evidence: goodEvidence(v.manifest) });
  return requestId;
}

/** Every runtime id that was actually DECLARED at a handover, read from the
 *  INSERT-only journal — the only place the declaration lives. */
function declaredRuntimes(fx: P4Fixture): string[] {
  const rows = fx.db
    .prepare("SELECT environment_json AS e FROM receipt_events WHERE event='delivered' AND environment_json IS NOT NULL")
    .all() as { e: string }[];
  return rows
    .map((r) => JSON.parse(r.e).environment_descriptor?.runtime?.id)
    .filter((x: unknown): x is string => typeof x === "string")
    .sort();
}

test("a late adopt on a closed chain is refused, and a write to the cache column declares nothing", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "integrity-journal");
  const runtimes = ["node", "bun", "codex", "claude-code", "docker-ubuntu-24.04"];
  const requests: string[] = [];
  for (const [i, runtimeId] of runtimes.entries()) {
    const id = insertAgent(fx.db, fx.seed.wsA, `integrity-adopter-${i}`, "agent", NOW);
    fx.db.prepare("INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)").run(
      id, fx.seed.wsA, "member", NOW,
    );
    requests.push(fullAdoption(fx, v, ctxFor(fx.seed, id, fx.seed.wsA, "member"), runtimeId));
  }
  const before = declaredRuntimes(fx);
  assert.deepEqual(before, [...runtimes].sort(), "five handovers, five declarations, on the events");

  // The release run's probe, exactly: an ordinary adopt with an invented
  // runtime id on a request whose chain is closed. It is refused…
  const adopterOfFirst = (fx.db.prepare("SELECT adopter_agent_id AS a FROM adoption_requests WHERE id=?").get(requests[0]) as { a: string }).a;
  const probeCtx = ctxFor(fx.seed, adopterOfFirst, fx.seed.wsA, "member");
  assert.throws(
    () =>
      fx.registry.adopt(probeCtx, requests[0], {
        environment_descriptor: env({ runtime: { id: "probe", version: "1.0.0" } }),
      }, "probe-key"),
    (e: any) => isApiError(e) && e.code === "PRECONDITION_FAILED",
  );

  // …and a direct write to the mutable cache column moves nothing, because
  // nothing reads it as the declaration.
  fx.db.prepare("UPDATE adoption_requests SET requester_context_json=?").run(
    JSON.stringify({ environment_descriptor: { runtime: { id: "probe" } } }),
  );
  const after = declaredRuntimes(fx);
  assert.deepEqual(after, before, "the journal did not move when the cache column was tampered with");
  assert.ok(!after.includes("probe"), "a runtime that executed nothing is declared nowhere");
  fx.db.close();
});
