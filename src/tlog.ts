// §3 transparency log — hash-chained INSERT-only event log.
// row_canonical = JCS({seq, event_kind, subject_id, payload_hash, server_at_ms})
// this_hash = SHA-256( prev_hash_raw32 ‖ SHA-256(row_canonical_utf8) ), hex lower.
// Genesis prev_hash = 32 zero bytes.
import { createHash } from "node:crypto";
import type { Db } from "./sqlite.ts";
import { jcsBytes, type JcsValue } from "./jcs.ts";

export const GENESIS_PREV_HASH = "0".repeat(64);

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

export function payloadHash(payload: JcsValue): string {
  return sha256(jcsBytes(payload)).toString("hex");
}

export function rowHash(
  prevHashHex: string,
  row: { seq: number; event_kind: string; subject_id: string; payload_hash: string; server_at_ms: number },
): string {
  const canonical = jcsBytes({
    seq: row.seq,
    event_kind: row.event_kind,
    subject_id: row.subject_id,
    payload_hash: row.payload_hash,
    server_at_ms: row.server_at_ms,
  });
  const prevRaw = Buffer.from(prevHashHex, "hex");
  if (prevRaw.length !== 32) throw new Error("prev_hash must be 32 bytes hex");
  return sha256(Buffer.concat([prevRaw, sha256(canonical)])).toString("hex");
}

export interface TlogRow {
  seq: number;
  event_kind: string;
  subject_id: string;
  payload_hash: string;
  prev_hash: string;
  this_hash: string;
  server_at_ms: number;
}

/** Append one event WITHOUT opening a transaction — caller must already hold one. */
export function appendTlogInTx(
  db: Db,
  event_kind: string,
  subject_id: string,
  payload: JcsValue,
  serverAtMs: number,
): TlogRow {
  const last = db
    .prepare("SELECT seq, this_hash FROM transparency_log ORDER BY seq DESC LIMIT 1")
    .get() as { seq: number; this_hash: string } | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prev_hash = last?.this_hash ?? GENESIS_PREV_HASH;
  const payload_hash = payloadHash(payload);
  const this_hash = rowHash(prev_hash, { seq, event_kind, subject_id, payload_hash, server_at_ms: serverAtMs });
  db.prepare(
    `INSERT INTO transparency_log(seq, event_kind, subject_id, payload_hash, prev_hash, this_hash, server_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(seq, event_kind, subject_id, payload_hash, prev_hash, this_hash, serverAtMs);
  return { seq, event_kind, subject_id, payload_hash, prev_hash, this_hash, server_at_ms: serverAtMs };
}

/** Append one event; server_at_ms is the registry clock (server timing authority). */
export function appendTlog(
  db: Db,
  event_kind: string,
  subject_id: string,
  payload: JcsValue,
  serverAtMs: number = Date.now(),
): TlogRow {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = appendTlogInTx(db, event_kind, subject_id, payload, serverAtMs);
    db.exec("COMMIT");
    return row;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  failed_seq?: number;
  reason?: string;
}

/** Walk the whole chain and recompute every link. */
export function verifyTlog(db: Db): VerifyResult {
  const rows = db
    .prepare("SELECT * FROM transparency_log ORDER BY seq ASC")
    .all() as unknown as TlogRow[];
  let prev = GENESIS_PREV_HASH;
  let expectedSeq = 0;
  for (const row of rows) {
    expectedSeq += 1;
    if (row.seq !== expectedSeq) {
      return { ok: false, checked: expectedSeq - 1, failed_seq: row.seq, reason: `gap: expected seq ${expectedSeq}, found ${row.seq}` };
    }
    if (row.prev_hash !== prev) {
      return { ok: false, checked: expectedSeq - 1, failed_seq: row.seq, reason: "prev_hash mismatch" };
    }
    const recomputed = rowHash(prev, row);
    if (recomputed !== row.this_hash) {
      return { ok: false, checked: expectedSeq - 1, failed_seq: row.seq, reason: "this_hash mismatch" };
    }
    prev = row.this_hash;
  }
  return { ok: true, checked: rows.length };
}
