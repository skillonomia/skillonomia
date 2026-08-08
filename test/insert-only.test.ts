// §3 — the three INSERT-only tables reject every UPDATE and DELETE (6 combos).
import { test } from "node:test";
import { seedGraph, insertReceiptEvent, expectReject } from "./helpers.ts";

function seeded() {
  const s = seedGraph();
  insertReceiptEvent(s.db, s.receipt, "delivered", 1, s.now);
  s.db.prepare(
    "INSERT INTO transparency_log(seq, event_kind, subject_id, payload_hash, prev_hash, this_hash, server_at_ms) VALUES (1,'publish','x',?,?,?,?)",
  ).run("c".repeat(64), "0".repeat(64), "d".repeat(64), s.now);
  return s;
}

const cases: Array<[string, string]> = [
  ["adoption_receipts", "UPDATE adoption_receipts SET created_at_ms=1"],
  ["adoption_receipts", "DELETE FROM adoption_receipts"],
  ["receipt_events", "UPDATE receipt_events SET server_at_ms=1"],
  ["receipt_events", "DELETE FROM receipt_events"],
  ["transparency_log", "UPDATE transparency_log SET subject_id='y'"],
  ["transparency_log", "DELETE FROM transparency_log"],
];

for (const [table, sql] of cases) {
  test(`INSERT-only: "${sql}" → INSERT_ONLY (${table})`, () => {
    const s = seeded();
    expectReject(() => s.db.exec(sql), "INSERT_ONLY");
  });
}

test("mutable table control: adoption_requests UPDATE allowed (lease CAS requires it)", () => {
  const s = seeded();
  s.db.exec("UPDATE adoption_requests SET attempt_count=1");
});
