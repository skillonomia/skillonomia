// Defect #5 regression: ordering is (created_at_ms, id) everywhere; receipt-event
// order authority is event_seq (HIGH-7), never timestamps or ULID lexicographics.
// R2-review M-1: fixtures are ADVERSARIAL — insertion order, rowid order,
// timestamp order and ULID order all disagree with the normative order, so
// dropping the id tiebreak or substituting timestamp/ULID ordering FAILS here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedGraph } from "./helpers.ts";
import { ulid } from "../src/ulid.ts";

test("(created_at_ms, id): same-ms rows inserted in shuffled id order — tiebreak required", () => {
  const s = seedGraph();
  const sameMs = s.now + 1000;
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) ids.push(ulid(sameMs));
  const sorted = [...ids].sort();

  // deterministic shuffle that provably differs from sorted order
  const shuffled = [...ids].reverse();
  assert.notDeepEqual(shuffled, sorted, "fixture sanity: insertion order must differ from sorted order");

  for (const id of shuffled) {
    s.db.prepare(
      "INSERT INTO activity_log(id, workspace_id, actor_agent_id, action, created_at_ms) VALUES (?,?,?,?,?)",
    ).run(id, s.wsA, s.authorA, "act", sameMs);
  }

  const normative = s.db
    .prepare("SELECT id FROM activity_log WHERE created_at_ms=? ORDER BY created_at_ms, id")
    .all(sameMs) as Array<{ id: string }>;
  assert.deepEqual(normative.map((r) => r.id), sorted, "normative order = ascending id within same ms");

  // counterfactual: ordering WITHOUT the id tiebreak degenerates to insertion
  // (rowid) order, which the fixture guarantees is different
  const noTiebreak = s.db
    .prepare("SELECT id FROM activity_log WHERE created_at_ms=? ORDER BY created_at_ms, rowid")
    .all(sameMs) as Array<{ id: string }>;
  assert.deepEqual(noTiebreak.map((r) => r.id), shuffled, "fixture sanity: rowid order = insertion order");
  assert.notDeepEqual(
    noTiebreak.map((r) => r.id),
    normative.map((r) => r.id),
    "dropping the id tiebreak must change the result on this fixture",
  );
});

test("event_seq is the ONLY receipt order authority: seq disagrees with timestamps, ULIDs and insertion order", () => {
  const s = seedGraph();
  // Anti-correlated fixture:
  //   event_seq:    delivered=1, attempted=2, adopted=3   (normative order)
  //   server_at_ms: delivered=300, attempted=200, adopted=100 (REVERSED)
  //   row id ULID:  delivered gets the LARGEST id, adopted the smallest (REVERSED)
  //   insertion:    attempted, adopted, delivered (scrambled)
  const t0 = s.now + 10_000;
  const idSmall = ulid(t0);
  const idMid = ulid(t0); // monotonic: idSmall < idMid < idLarge
  const idLarge = ulid(t0);
  assert.ok(idSmall < idMid && idMid < idLarge, "fixture sanity: ULIDs strictly increasing");

  const ins = s.db.prepare(
    `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, server_at_ms, idempotency_key)
     VALUES (?,?,?,?,?,?)`,
  );
  ins.run(idMid, s.receipt, "attempted", 2, 200, "k-att");
  ins.run(idSmall, s.receipt, "adopted", 3, 100, "k-ado");
  ins.run(idLarge, s.receipt, "delivered", 1, 300, "k-del");

  const bySeq = (
    s.db.prepare("SELECT event FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq").all(s.receipt) as Array<{ event: string }>
  ).map((r) => r.event);
  const byTime = (
    s.db.prepare("SELECT event FROM receipt_events WHERE adoption_receipt_id=? ORDER BY server_at_ms").all(s.receipt) as Array<{ event: string }>
  ).map((r) => r.event);
  const byUlid = (
    s.db.prepare("SELECT event FROM receipt_events WHERE adoption_receipt_id=? ORDER BY id").all(s.receipt) as Array<{ event: string }>
  ).map((r) => r.event);
  const byInsertion = (
    s.db.prepare("SELECT event FROM receipt_events WHERE adoption_receipt_id=? ORDER BY rowid").all(s.receipt) as Array<{ event: string }>
  ).map((r) => r.event);

  assert.deepEqual(bySeq, ["delivered", "attempted", "adopted"], "event_seq gives the normative order");
  // every prohibited ordering gives a DIFFERENT sequence on this fixture
  assert.deepEqual(byTime, ["adopted", "attempted", "delivered"]);
  assert.deepEqual(byUlid, ["adopted", "attempted", "delivered"]);
  assert.deepEqual(byInsertion, ["attempted", "adopted", "delivered"]);
  assert.notDeepEqual(byTime, bySeq);
  assert.notDeepEqual(byUlid, bySeq);
  assert.notDeepEqual(byInsertion, bySeq);
});

test("duplicate event_seq per receipt rejected (UNIQUE)", () => {
  const s = seedGraph();
  const ins = s.db.prepare(
    `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, server_at_ms, idempotency_key)
     VALUES (?,?,?,?,?,?)`,
  );
  ins.run(ulid(s.now), s.receipt, "delivered", 1, s.now, "k1");
  assert.throws(() => ins.run(ulid(s.now), s.receipt, "attempted", 1, s.now, "k2"), /UNIQUE/);
});
