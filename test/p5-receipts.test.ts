// P5 — §5.3 receipt machine: the transition table, `event_seq` as the only
// order, evidence validation, and the attacks §8 threat 6 names (forged
// receipts, cross-agent appends).
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, reviewedVersion, goodEvidence, NOW, type P4Fixture } from "./p4-helpers.ts";
import {
  appendReceiptEvent,
  derivedState,
  isStalled,
  RECEIPT_TRANSITIONS,
  STALENESS_WINDOW_MS,
  type ReceiptEvent,
} from "../src/receipts.ts";
import { isApiError } from "../src/errors.ts";
import { ulid } from "../src/ulid.ts";
import { correlationDigest } from "../src/journal.ts";

function rejects(fn: () => unknown, code: string, message?: RegExp): any {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (e) {
    if (!isApiError(e)) throw e;
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return e;
  }
}

/** A request + receipt shell for `versionId`, adopted by `adopter`. */
function shell(fx: P4Fixture, versionId: string, adopter = fx.member.agent_id): string {
  const requestId = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
    )
    .run(requestId, versionId, adopter, NOW);
  const receiptId = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
    )
    .run(receiptId, requestId, versionId, adopter, NOW);
  return receiptId;
}

function append(fx: P4Fixture, receiptId: string, event: ReceiptEvent, extra: any = {}, actor = fx.member.agent_id) {
  return appendReceiptEvent(fx.db, {
    receiptId,
    actorAgentId: actor,
    event,
    idempotencyKey: extra.idempotencyKey ?? `k-${event}-${receiptId}`,
    nowMs: NOW,
    ...extra,
  });
}

// ----------------------------------------------------------- the happy chain

test("delivered → attempted → adopted, with event_seq as the only order", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "receipt-chain");
  const r = shell(fx, v.versionId);

  assert.equal(derivedState(fx.db, r), "none");
  assert.equal(append(fx, r, "delivered").event_seq, 1);
  assert.equal(derivedState(fx.db, r), "delivered");
  assert.equal(append(fx, r, "attempted").event_seq, 2);
  const adopted = append(fx, r, "adopted", { evidence: goodEvidence(v.manifest) });
  assert.equal(adopted.event_seq, 3);
  assert.equal(derivedState(fx.db, r), "adopted");

  const seqs = (fx.db.prepare("SELECT event, event_seq FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq").all(r) as any[]).map(
    (e) => `${e.event_seq}:${e.event}`,
  );
  assert.deepEqual(seqs, ["1:delivered", "2:attempted", "3:adopted"]);
  fx.db.close();
});

test("§5.3 auto-ack: `attempted` from `none` synthesizes `delivered` in the SAME transaction", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "auto-ack");
  const r = shell(fx, v.versionId);
  const out = append(fx, r, "attempted");
  assert.equal(out.event_seq, 2);
  assert.deepEqual(out.synthesized, { receipt_event: "delivered", event_seq: 1 });
  const rows = fx.db.prepare("SELECT event, event_seq, idempotency_key FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq").all(r) as any[];
  assert.equal(rows[0].event, "delivered");
  // the key is stored as a digest of itself, the registry's own synthesized key
  // included: it is compared and never read (`src/journal.ts`)
  assert.equal(rows[0].idempotency_key, correlationDigest(`synth-delivered:${r}`));
  const logged = fx.db
    .prepare("SELECT COUNT(*) AS c FROM activity_log WHERE subject_id=? AND action='receipt.delivered.synthesized'")
    .get(r) as any;
  assert.equal(logged.c, 1, "the synthesis is activity-logged");
  fx.db.close();
});

test("§5.3: the synthesized `delivered` row carries evidence_json {\"synthesized\":true}", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "auto-ack-marker");
  const r = shell(fx, v.versionId);
  append(fx, r, "attempted");

  // The assertion reads the PERSISTED row, not the return value of
  // appendReceiptEvent: `AppendResult.synthesized` only reports that a row was
  // written, and reporting it is exactly what the buggy code already did while
  // storing NULL. The §5.3 table makes the stored `evidence_json` normative, so
  // only the stored bytes can prove it.
  const stored = fx.db
    .prepare("SELECT evidence_json FROM receipt_events WHERE adoption_receipt_id=? AND event_seq=1")
    .get(r) as { evidence_json: string | null };
  assert.notEqual(stored.evidence_json, null, "the synthesized `delivered` row must carry evidence_json");
  assert.deepEqual(JSON.parse(stored.evidence_json as string), { synthesized: true });

  // …and the SERIALIZED receipt (the `GET /v1/receipts/{id}` payload) shows the
  // same marker, so a reader of the API can tell an auto-acked `delivered` from
  // one an adopter actually reported.
  const view = fx.registry.readReceipt(fx.member, r);
  const delivered = view.events.find((e) => e.event_seq === 1);
  assert.equal(delivered?.event, "delivered");
  assert.deepEqual(delivered?.evidence, { synthesized: true });

  // A `delivered` the adopter reported itself carries NO marker — the field is
  // what distinguishes the two, so it must not appear on the ordinary path.
  const r2 = shell(fx, v.versionId);
  append(fx, r2, "delivered");
  assert.equal(
    (fx.db.prepare("SELECT evidence_json FROM receipt_events WHERE adoption_receipt_id=? AND event_seq=1").get(r2) as any)
      .evidence_json,
    null,
    "an adopter-reported `delivered` is not marked synthesized",
  );
  fx.db.close();
});

test("the synthesized marker never satisfies the §5.1 evidence conjunct", () => {
  // The marker is the ONLY non-`adopted` row that carries evidence_json, so it
  // is the one row that could make conjunct 1 read a `delivered` as evidence.
  // A receipt stopped at `attempted` must leave the gate shut.
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "marker-is-not-evidence");
  const r = shell(fx, v.versionId);
  append(fx, r, "attempted");
  assert.equal(
    (fx.db.prepare("SELECT evidence_json FROM receipt_events WHERE adoption_receipt_id=? AND event_seq=1").get(r) as any)
      .evidence_json,
    JSON.stringify({ synthesized: true }),
    "precondition: the marker is present",
  );
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.equal(out.checks.find((c) => c.id === "evidence_receipt")?.satisfied, false);
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "reviewed");
  fx.db.close();
});

// ------------------------------------------------------- the transition table

test("every illegal transition converges with PRECONDITION_FAILED + the current state", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "illegal-transitions");
  const EVENTS: ReceiptEvent[] = ["delivered", "attempted", "adopted", "failed", "rolled_back"];
  // reach each derived state through the legal path, then try everything
  const reach: Record<string, (r: string) => void> = {
    none: () => {},
    delivered: (r) => void append(fx, r, "delivered"),
    attempted: (r) => {
      append(fx, r, "delivered");
      append(fx, r, "attempted");
    },
    adopted: (r) => {
      append(fx, r, "delivered");
      append(fx, r, "attempted");
      append(fx, r, "adopted", { evidence: goodEvidence(v.manifest) });
    },
    failed: (r) => {
      append(fx, r, "delivered");
      append(fx, r, "failed", { failure_report: { category: "pre_execution", summary: "rejected on receipt" } });
    },
    rolled_back: (r) => {
      append(fx, r, "delivered");
      append(fx, r, "attempted");
      append(fx, r, "adopted", { evidence: goodEvidence(v.manifest) });
      append(fx, r, "rolled_back", { rollback_report: { reason: "regression", summary: "rolled back after an incident" } });
    },
  };

  for (const [state, build] of Object.entries(reach)) {
    for (const event of EVENTS) {
      const legal = RECEIPT_TRANSITIONS[state as keyof typeof RECEIPT_TRANSITIONS][event] !== undefined;
      if (legal) continue;
      const r = shell(fx, v.versionId);
      build(r);
      assert.equal(derivedState(fx.db, r), state === "none" ? "none" : state, `fixture reached ${state}`);
      const err = rejects(
        () => append(fx, r, event, { idempotencyKey: `illegal-${state}-${event}` }),
        "PRECONDITION_FAILED",
      );
      assert.equal(err.current_state, state, `${state} + ${event} must report the current state`);
      assert.equal(derivedState(fx.db, r), state, "a refused append changes nothing");
    }
  }
  fx.db.close();
});

test("the adopted-vs-failed race: exactly one terminal event survives", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "terminal-race");
  const r = shell(fx, v.versionId);
  append(fx, r, "delivered");
  append(fx, r, "attempted");
  append(fx, r, "adopted", { evidence: goodEvidence(v.manifest) });

  const err = rejects(
    () => append(fx, r, "failed", { failure_report: { category: "other", summary: "a second terminal event" } }),
    "PRECONDITION_FAILED",
  );
  assert.equal(err.current_state, "adopted");
  const terminals = fx.db
    .prepare("SELECT COUNT(*) AS c FROM receipt_events WHERE adoption_receipt_id=? AND event IN ('adopted','failed')")
    .get(r) as any;
  assert.equal(terminals.c, 1, "D.1's partial unique index is the backstop");
  fx.db.close();
});

test("`failed` before `attempted` is legal only as a pre_execution report (§5.3)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "failed-early");
  const early = shell(fx, v.versionId);
  append(fx, early, "delivered");
  rejects(
    () => append(fx, early, "failed", { failure_report: { category: "gate_failed", summary: "wrong category for this point" } }),
    "INVALID_SCHEMA",
    /pre_execution/,
  );
  assert.equal(derivedState(fx.db, early), "delivered");
  assert.equal(
    append(fx, early, "failed", { failure_report: { category: "pre_execution", summary: "package rejected on receipt" } }).event_seq,
    2,
  );
  fx.db.close();
});

// ------------------------------------------------------- payload validation

test("`adopted` requires evidence that validates against the DECLARED validation gates", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "evidence-rules");
  for (const [label, evidence] of [
    ["absent", undefined],
    ["a gate the version does not declare", { gate_results: [{ gate_id: "nope", pass: true, observed: "x" }] }],
    ["a declared gate reported pass:false", { gate_results: [{ gate_id: "g1", pass: false, observed: "x" }] }],
    ["an empty result list", { gate_results: [] }],
    ["the synthesized marker", { synthesized: true }],
  ] as Array<[string, any]>) {
    const r = shell(fx, v.versionId);
    append(fx, r, "delivered");
    append(fx, r, "attempted");
    rejects(() => append(fx, r, "adopted", { evidence, idempotencyKey: `ev-${label}` }), "INVALID_SCHEMA");
    assert.equal(derivedState(fx.db, r), "attempted", `${label}: nothing was written`);
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM receipt_events WHERE adoption_receipt_id=? AND event_seq=3").get(r) as any).c,
      0,
      "a rejected payload consumes no event_seq",
    );
  }
  fx.db.close();
});

test("failure and rollback reports are validated against their E.2 schemas", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "report-schemas");
  const r = shell(fx, v.versionId);
  append(fx, r, "delivered");
  append(fx, r, "attempted");
  rejects(() => append(fx, r, "failed", { failure_report: { category: "made_up", summary: "not an enum member" } }), "INVALID_SCHEMA");
  rejects(() => append(fx, r, "failed", { failure_report: { category: "other", summary: "short" } }), "INVALID_SCHEMA");
  rejects(() => append(fx, r, "failed", {}), "INVALID_SCHEMA", /requires a failure_report/);

  const ok = shell(fx, v.versionId);
  append(fx, ok, "delivered");
  append(fx, ok, "attempted");
  append(fx, ok, "adopted", { evidence: goodEvidence(v.manifest) });
  rejects(() => append(fx, ok, "rolled_back", { rollback_report: { reason: "whatever", summary: "not an enum member" } }), "INVALID_SCHEMA");
  rejects(() => append(fx, ok, "rolled_back", {}), "INVALID_SCHEMA", /requires a rollback_report/);
  fx.db.close();
});

test("a delivered/attempted event carrying a payload is refused rather than silently stored", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "stray-payload");
  const r = shell(fx, v.versionId);
  rejects(() => append(fx, r, "delivered", { evidence: goodEvidence(v.manifest) }), "INVALID_SCHEMA");
  assert.equal(derivedState(fx.db, r), "none");
  fx.db.close();
});

// --------------------------------------------------------------- the attacks

test("§8 threat 6: only the receipt's own adopter may append (defect #3 class)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "cross-agent-append");
  const r = shell(fx, v.versionId, fx.member.agent_id);
  for (const intruder of [fx.author, fx.owner, fx.admin, fx.reviewer, fx.outsider]) {
    rejects(
      () => append(fx, r, "delivered", { idempotencyKey: `x-${intruder.agent_id}` }, intruder.agent_id),
      "FORBIDDEN",
      /own adopter/,
    );
  }
  assert.equal(derivedState(fx.db, r), "none", "no intruder wrote anything");
  assert.equal(append(fx, r, "delivered").event_seq, 1, "the adopter still can");
  fx.db.close();
});

test("receipt_events is INSERT-only: no correction by UPDATE or DELETE (D.1 triggers)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "insert-only-receipts");
  const r = shell(fx, v.versionId);
  append(fx, r, "delivered");
  assert.throws(() => fx.db.prepare("UPDATE receipt_events SET event='adopted' WHERE adoption_receipt_id=?").run(r), /INSERT_ONLY/);
  assert.throws(() => fx.db.prepare("DELETE FROM receipt_events WHERE adoption_receipt_id=?").run(r), /INSERT_ONLY/);
  fx.db.close();
});

test("an idempotency_key duplicate replays the original append as noop, per receipt", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "receipt-idempotency");
  const a = shell(fx, v.versionId);
  const b = shell(fx, v.versionId);
  const first = append(fx, a, "delivered", { idempotencyKey: "same-key" });
  const replay = append(fx, a, "delivered", { idempotencyKey: "same-key" });
  assert.equal(replay.noop, true);
  assert.equal(replay.event_seq, first.event_seq);
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM receipt_events WHERE adoption_receipt_id=?").get(a) as any).c, 1);

  // the SAME key on a different receipt is a different append (D.1 scopes the
  // uniqueness to the receipt)
  assert.equal(append(fx, b, "delivered", { idempotencyKey: "same-key" }).event_seq, 1);
  fx.db.close();
});

test("an unknown receipt is NOT_FOUND, and a bad event name is INVALID_SCHEMA", () => {
  const fx = p4Fixture();
  rejects(() => append(fx, "01AAAAAAAAAAAAAAAAAAAAAAAA", "delivered"), "NOT_FOUND");
  const v = reviewedVersion(fx, "bad-event");
  const r = shell(fx, v.versionId);
  rejects(() => append(fx, r, "shipped" as any), "INVALID_SCHEMA");
  rejects(() => append(fx, r, "delivered", { idempotencyKey: "" }), "INVALID_SCHEMA");
  fx.db.close();
});

// -------------------------------------------------------------- staleness

test("§5.3 staleness is derived, never stored", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "stalled-chain");
  const r = shell(fx, v.versionId);
  append(fx, r, "delivered");
  assert.equal(isStalled(fx.db, r, NOW), false);
  assert.equal(isStalled(fx.db, r, NOW + STALENESS_WINDOW_MS + 1), true);

  append(fx, r, "attempted");
  append(fx, r, "adopted", { evidence: goodEvidence(v.manifest) });
  assert.equal(isStalled(fx.db, r, NOW + STALENESS_WINDOW_MS * 10), false, "a terminal chain never stalls");
  const cols = (fx.db.prepare("PRAGMA table_info(adoption_receipts)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols.includes("stalled"), "nothing is stored — INSERT-only is preserved");
  fx.db.close();
});
