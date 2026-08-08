// §3 hash chain: append → verify OK; any tamper (even with triggers dropped)
// breaks the chain (TV-10 class). Includes the byte-precision rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, openMigrated, openReadOnly } from "../src/db.ts";
import { appendTlog, verifyTlog, rowHash, payloadHash, GENESIS_PREV_HASH } from "../src/tlog.ts";
import { jcsCanonicalize } from "../src/jcs.ts";

test("chain of 5 events verifies; genesis prev = 32 zero bytes", () => {
  const db = openMigrated();
  let t = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) {
    appendTlog(db, "publish", `subj-${i}`, { manifest_hash: "ab".repeat(32) }, t++);
  }
  const first = db.prepare("SELECT prev_hash FROM transparency_log WHERE seq=1").get() as any;
  assert.equal(first.prev_hash, GENESIS_PREV_HASH);
  const res = verifyTlog(db);
  assert.deepEqual(res, { ok: true, checked: 5 });
});

test("tampered semantic field breaks the chain even with triggers dropped", () => {
  const db = openMigrated();
  let t = 1_700_000_000_000;
  for (let i = 0; i < 3; i++) appendTlog(db, "publish", `subj-${i}`, { i }, t++);
  db.exec("DROP TRIGGER tg_tlog_no_upd"); // attacker with DDL access
  db.exec("UPDATE transparency_log SET subject_id='forged' WHERE seq=2");
  const res = verifyTlog(db);
  assert.equal(res.ok, false);
  assert.equal(res.failed_seq, 2);
});

test("forged tail (bad prev_hash) detected", () => {
  const db = openMigrated();
  appendTlog(db, "publish", "s", { a: 1 }, 1_700_000_000_000);
  db.prepare(
    "INSERT INTO transparency_log(seq, event_kind, subject_id, payload_hash, prev_hash, this_hash, server_at_ms) VALUES (2,'revoke','s2',?,?,?,?)",
  ).run("e".repeat(64), "f".repeat(64), "9".repeat(64), 1_700_000_000_001);
  const res = verifyTlog(db);
  assert.equal(res.ok, false);
  assert.equal(res.failed_seq, 2);
});

test("JCS canonicalization: key order fixed, exact bytes", () => {
  // keys of the row object sort as: event_kind, payload_hash, seq, server_at_ms, subject_id
  const s = jcsCanonicalize({ seq: 1, event_kind: "publish", subject_id: "x", payload_hash: "ph", server_at_ms: 2 });
  assert.equal(s, '{"event_kind":"publish","payload_hash":"ph","seq":1,"server_at_ms":2,"subject_id":"x"}');
});

test("rowHash is deterministic and prev-sensitive", () => {
  const row = { seq: 1, event_kind: "publish", subject_id: "x", payload_hash: "a".repeat(64), server_at_ms: 7 };
  const h1 = rowHash(GENESIS_PREV_HASH, row);
  const h2 = rowHash(GENESIS_PREV_HASH, row);
  const h3 = rowHash("1".repeat(64), row);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.match(payloadHash({ a: 1 }), /^[0-9a-f]{64}$/);
});

// The `verify-log` SUBCOMMAND, its arguments and its output are covered in
// test/cli.test.ts; this case pins the chain semantics the subcommand reports.
test("verify-log CLI: exit 0 on intact chain, exit 1 on tampered", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-"));
  const dbPath = join(dir, "t.db");
  const db = openMigrated(dbPath);
  appendTlog(db, "publish", "s1", { a: 1 }, 1_700_000_000_000);
  appendTlog(db, "verify", "s1", { b: 2 }, 1_700_000_000_001);
  db.close();

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = join(root, "src", "cli.ts");
  const run = (p: string) => {
    try {
      const out = execFileSync("node", ["--experimental-strip-types", "--no-warnings", cli, "verify-log", p], {
        encoding: "utf8",
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status as number, out: String(e.stderr) };
    }
  };

  const ok = run(dbPath);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /chain intact/);

  const db2 = openMigrated(dbPath);
  db2.exec("DROP TRIGGER tg_tlog_no_upd");
  db2.exec("UPDATE transparency_log SET event_kind='forged' WHERE seq=1");
  db2.close();
  const bad = run(dbPath);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL at seq 1/);
});


// ---------------------------------------------------------------------------
// `verify-log` audits; it does not touch.
//
// The subcommand's claim is that it can be pointed at an existing deployment —
// or at a snapshot of one — and report on the chain. Every open went through
// `openDb`, which issues `PRAGMA journal_mode=WAL`. That is a WRITE, and it has
// two consequences worth separating, because only one of them is loud:
//
//   * On a database that is NOT already in WAL mode, the pragma rewrites the
//     header. A snapshot taken with `sqlite3 .backup` is exactly that: the
//     backup lands in the default DELETE journal mode. So the audit either
//     failed outright (read-only file) or silently converted its own subject
//     (writable file) before reading it.
//   * On a database that IS already in WAL mode — which a live deployment's is,
//     because `serve` set it — the pragma is a no-op and nothing fails. That is
//     why this defect survived: the common case looks fine.
//
// Both are covered below, and the second case is asserted the only way it can
// be: on a WRITABLE file, by hashing it before and after.
// ---------------------------------------------------------------------------

/** A snapshot as `sqlite3 .backup` leaves one: DELETE journal mode, no sidecars. */
function snapshot(dir: string, name = "audit.db"): string {
  const dbPath = join(dir, name);
  const db = openMigrated(dbPath);
  appendTlog(db, "publish", "s1", { a: 1 }, 1_700_000_000_000);
  appendTlog(db, "verify", "s1", { b: 2 }, 1_700_000_000_001);
  db.exec("PRAGMA journal_mode=DELETE;"); // what a backup/restore produces
  db.close();
  return dbPath;
}

function runVerifyLog(dbPath: string): { code: number; out: string } {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = join(root, "src", "cli.ts");
  try {
    return {
      code: 0,
      out: execFileSync("node", ["--experimental-strip-types", "--no-warnings", cli, "verify-log", dbPath], {
        encoding: "utf8",
      }),
    };
  } catch (e: any) {
    return { code: e.status as number, out: `${String(e.stdout)}${String(e.stderr)}` };
  }
}

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

test("verify-log audits a snapshot whose file is not writable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-ro-"));
  const dbPath = snapshot(dir);
  chmodSync(dbPath, 0o444);
  const before = sha(dbPath);
  const filesBefore = readdirSync(dir).sort();

  const res = runVerifyLog(dbPath);
  assert.equal(res.code, 0, `verify-log must audit a read-only snapshot: ${res.out}`);
  assert.match(res.out, /chain intact/);
  assert.equal(sha(dbPath), before, "an audit must not change one byte of what it audits");
  assert.deepEqual(readdirSync(dir).sort(), filesBefore, "and must leave nothing beside it");

  // the SERVING open is what could not do this, which is what makes the change
  // a fix rather than a rename
  assert.throws(
    () => openDb(dbPath),
    /readonly|read-only/i,
    "openDb writes (PRAGMA journal_mode=WAL) and still refuses a 0444 snapshot",
  );
});

test("verify-log does not convert a WRITABLE snapshot's journal mode behind the operator's back", () => {
  // The quiet half of the defect: with the file writable there was no error at
  // all, and the artifact under audit came back a different file.
  const dir = mkdtempSync(join(tmpdir(), "sklo-rw-"));
  const dbPath = snapshot(dir);
  const before = sha(dbPath);
  const filesBefore = readdirSync(dir).sort();

  const res = runVerifyLog(dbPath);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /chain intact/);
  assert.equal(sha(dbPath), before, "the audit rewrote the database header of a file it only had to read");
  assert.deepEqual(readdirSync(dir).sort(), filesBefore);

  // and the mode really was the one `openDb` would have changed
  const check = openReadOnly(dbPath);
  try {
    assert.equal(
      String((check.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase(),
      "delete",
      "the snapshot is still in the journal mode it was taken in",
    );
  } finally {
    check.close();
  }
});

test("verify-log still audits a live deployment's WAL database, without touching it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-wal-"));
  const dbPath = join(dir, "live.db");
  const db = openMigrated(dbPath); // openDb → WAL, as `serve` leaves it
  appendTlog(db, "publish", "s1", { a: 1 }, 1_700_000_000_000);
  db.close();
  const wal = `${dbPath}-wal`;
  const before = sha(dbPath);
  // Bun's `close()` leaves the write-ahead log in place where Node's
  // checkpoints and removes it, so what is beside the database here depends on
  // the runtime. Both are recorded and compared rather than predicted.
  const walBefore = existsSync(wal) ? readFileSync(wal) : null;

  const res = runVerifyLog(dbPath);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /chain intact/);
  assert.equal(sha(dbPath), before, "the database file is untouched");

  // SQLite reads a WAL database through a shared-memory index, so even a
  // read-only connection materialises `-wal` and `-shm` beside it. That is why
  // `openReadOnly` documents that the DIRECTORY must be writable even when the
  // file is not.
  const extra = readdirSync(dir).sort().filter((f) => f !== "live.db");
  assert.ok(
    extra.every((f) => f === "live.db-shm" || f === "live.db-wal"),
    `only SQLite's own WAL sidecars, got ${extra.join(", ")}`,
  );
  // and whatever the log was, the audit did not add to it
  if (walBefore !== null) {
    assert.ok(readFileSync(wal).equals(walBefore), "the audit appended no frames to an existing write-ahead log");
  } else if (existsSync(wal)) {
    assert.equal(statSync(wal).size, 0, "the log the audit had to create for itself stayed empty");
  }
});

test("a read-only handle cannot write, and the refusal comes from SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-ro2-"));
  const dbPath = snapshot(dir, "ro.db");

  // the FILE is writable here on purpose: the refusal must come from how the
  // connection was opened, not from the filesystem happening to say no
  const ro = openReadOnly(dbPath);
  try {
    assert.equal((ro.prepare("SELECT COUNT(*) AS c FROM transparency_log").get() as { c: number }).c, 2, "reads work");
    for (const sql of [
      "INSERT INTO transparency_log(seq, event_kind, subject_id, payload_hash, prev_hash, this_hash, server_at_ms) VALUES (9,'x','y','a','b','c',1)",
      "UPDATE skills SET slug='x'",
      "DELETE FROM transparency_log",
      "CREATE TABLE side(x TEXT)",
      // the exact statement `openDb` issues, refused here
      "PRAGMA journal_mode=WAL",
    ]) {
      assert.throws(() => ro.exec(sql), /readonly|read-only/i, sql);
    }

    // …and the same pragma against a database ALREADY in WAL mode does NOT
    // raise: SQLite answers with the mode in force rather than changing it.
    // That asymmetry is why the fix had to be the OPEN FLAG and not "stop
    // sending that pragma": on a live deployment's file the write is invisible,
    // so no caller would ever have been told it was doing one.
    const walDir = mkdtempSync(join(tmpdir(), "sklo-ro3-"));
    const walPath = join(walDir, "wal.db");
    openMigrated(walPath).close(); // openDb → WAL
    const alreadyWal = openReadOnly(walPath);
    try {
      const before = sha(walPath);
      alreadyWal.exec("PRAGMA journal_mode=WAL");
      assert.equal(sha(walPath), before, "a no-op, and still not a write");
    } finally {
      alreadyWal.close();
    }
  } finally {
    ro.close();
  }

  // nothing landed, and the schema version was not migrated either
  const check = openMigrated(dbPath);
  try {
    assert.equal((check.prepare("SELECT COUNT(*) AS c FROM transparency_log").get() as { c: number }).c, 2);
    assert.equal(
      (check.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='side'").get() as { c: number }).c,
      0,
    );
  } finally {
    check.close();
  }
});
