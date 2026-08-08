// §3 transparency-log chain check — the logic behind
// `skillonomia verify-log`. It walks the hash chain and recomputes every link.
//
// As with src/verify-cli.ts, this module decides only the outcome;
// src/cli-commands.ts owns arguments, output format and exit codes.
import { openReadOnly } from "./db.ts";
import { verifyTlog, type VerifyResult } from "./tlog.ts";

/** Walk the chain of the registry database at `dbPath`. */
export function verifyLogAt(dbPath: string): VerifyResult {
  // openReadOnly, not openDb: this is an audit of an existing deployment, so it
  // must neither migrate the file nor write to it at all. `openDb` would set
  // `PRAGMA journal_mode=WAL` — a header rewrite, which both mutates the
  // artifact under audit and fails outright on a snapshot or a 0444 file.
  const db = openReadOnly(dbPath);
  try {
    return verifyTlog(db);
  } finally {
    db.close();
  }
}
