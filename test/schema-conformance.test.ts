// P0 review subject: migrations produce a schema identical to Appendix D.1.
// sqlite_master stores CREATE statements verbatim (modulo the IF NOT EXISTS /
// quoting normalizations we don't use), so comparing normalized statement sets
// against migrations/0001_init.sql is a byte-level conformance check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openMigrated } from "../src/db.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ddl = readFileSync(join(root, "migrations", "0001_init.sql"), "utf8");

/** Extract the Appendix D.1 ```sql block verbatim from the public spec. */
function appendixD1(): string {
  const spec = readFileSync(join(root, "SPEC.md"), "utf8").split("\n");
  const start = spec.findIndex((l) => l.startsWith("### D.1 NORMATIVE DDL"));
  const fenceOpen = spec.findIndex((l, i) => i > start && l === "```sql");
  const fenceClose = spec.findIndex((l, i) => i > fenceOpen && l === "```");
  if (start < 0 || fenceOpen < 0 || fenceClose < 0) throw new Error("Appendix D.1 block not found in spec");
  return spec.slice(fenceOpen + 1, fenceClose).join("\n") + "\n";
}

function normalize(sql: string): string {
  // sqlite_master stores CREATE statements verbatim, including embedded
  // comments — strip line comments on BOTH sides, then collapse whitespace.
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/;$/, "")
    .trim();
}

/** Split the DDL file into top-level statements (respecting BEGIN…END; trigger bodies). */
function statements(src: string): string[] {
  const noComments = src
    .split("\n")
    .map((l) => (l.trim().startsWith("--") ? "" : l))
    .join("\n");
  const out: string[] = [];
  let buf = "";
  let inTrigger = false;
  for (const rawLine of noComments.split("\n")) {
    const line = rawLine;
    buf += line + "\n";
    if (/CREATE\s+TRIGGER/i.test(buf) && !inTrigger) inTrigger = true;
    if (inTrigger) {
      // a CASE … END; inside the body must not terminate the trigger.
      // Closers: a bare `END;` line (multi-line trigger) or `…; END;`
      // (one-line trigger: statement semicolon precedes END).
      if (/^END;$/i.test(line.trim()) || /;\s*END;$/i.test(line.trim())) {
        out.push(buf.trim());
        buf = "";
        inTrigger = false;
      }
    } else if (/;\s*$/.test(line.trim())) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.length > 0);
}

test("migrations/0001_init.sql is byte-identical to the spec's Appendix D.1 block", () => {
  assert.equal(ddl, appendixD1(), "migration file must equal Appendix D.1 verbatim");
});

/**
 * The ONLY authorized divergences of the live schema from Appendix D.1:
 *
 *   * the §5.2 delta — `approval_pending` and `approval_denied` (the §7.3
 *     hold), `adoption_requests.webhook_id` and `webhooks.secret_ref` (the
 *     endpoint snapshot and the secret indirection) — applied by
 *     `migrations/0002_p5.sql` and embedded in Appendix D.1b;
 *   * `adoption_requests.notification_kind` (Appendix D.1c, applied by
 *     `migrations/0003_revocation_notice.sql`), without which §6 surface 11's
 *     "active adopters are notified through the delivery machine" has no row
 *     shape to be notified with;
 *   * `receipt_events.environment_json` (Appendix D.1d, applied by
 *     `migrations/0004_declared_environment_on_the_event.sql`), which is where
 *     the environment an adopter declares at handover is recorded, so that
 *     the release gate's runtime conjunct is counted from an INSERT-only row
 *     instead of a rewritable column;
 *   * `signing_keys.secret_ref` and `skill_versions.source_hash` (Appendix
 *     D.1e, applied by `migrations/0005_server_side_packing.sql`) — the
 *     indirection to a system-held private half, which [I-7] keeps out of
 *     SQLite exactly as `webhooks.secret_ref` already does, and the identity of
 *     the SOURCE a version was packed from, which is what
 *     `skill.create_from_dir` converges on now that the §5 arrival marker makes
 *     every packing of one source byte-different;
 *   * the D.1f rebuild of `receipt_events` (applied by
 *     `migrations/0006_transfer_to_a_named_recipient.sql`), which adds the
 *     event kind `transferred` — SQLite cannot alter a CHECK in place, so the
 *     table is rebuilt rather than altered — and the column `recipient_json`,
 *     where §5.4 records the TYPED recipient of a transfer on the INSERT-only
 *     row the migration counter reads.
 *
 * Each entry rewrites a D.1 statement into what the live schema must then be,
 * EXACTLY — so any other change to those five tables, and any change at all to
 * the other fifteen, still fails this test.
 */
const AUTHORIZED_P5_EDITS: ReadonlyArray<{ readonly from: string; readonly to: string }> = [
  // the rebuild quotes the table name (ALTER TABLE … RENAME TO)
  { from: "CREATE TABLE adoption_requests(", to: 'CREATE TABLE "adoption_requests"(' },
  // §2: the request may await a §7.3 human approval
  {
    from: "CHECK(state IN ('pending','leased','pushed','dead_letter'))",
    to: "CHECK(state IN ('pending','leased','pushed','dead_letter','approval_pending'))",
  },
  // §2 adds approval_denied; §3 adds endpoint_missing
  {
    from: "IN ('max_attempts','stale_lease','endpoint_dead'))",
    to: "IN ('max_attempts','stale_lease','endpoint_dead','approval_denied','endpoint_missing'))",
  },
  // §3: the one endpoint selected for this request, snapshotted at creation
  {
    from: "next_attempt_at_ms INTEGER NOT NULL DEFAULT 0, created_at_ms",
    to: "next_attempt_at_ms INTEGER NOT NULL DEFAULT 0, webhook_id TEXT REFERENCES webhooks(id) ON DELETE SET NULL, created_at_ms",
  },
  // §3: secret indirection — the plaintext secret never enters SQLite
  {
    from: "updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>0) );",
    to: "updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>0) , secret_ref TEXT);",
  },
  // D.1c: one row of the §5.2 queue can be an adoption notification or a
  // surface-11 revocation notice, and the adopter has to be able to tell
  {
    from: "webhook_id TEXT REFERENCES webhooks(id) ON DELETE SET NULL, created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0) )",
    to: "webhook_id TEXT REFERENCES webhooks(id) ON DELETE SET NULL, created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0) , notification_kind TEXT NOT NULL DEFAULT 'adoption' CHECK(notification_kind IN ('adoption','revocation')))",
  },
  // D.1d: the environment an adopter declares at handover, on the INSERT-only
  // event that records the handover — because the release gate's runtime
  // conjunct is counted from it and a mutable column made that figure rewritable
  {
    from: "idempotency_key TEXT NOT NULL, UNIQUE(adoption_receipt_id,idempotency_key)",
    to: "idempotency_key TEXT NOT NULL, environment_json TEXT, UNIQUE(adoption_receipt_id,idempotency_key)",
  },
  // D.1e: the handle to a system-held private half. The material is NOT here —
  // this column names where it is kept, outside SQLite, exactly as
  // `webhooks.secret_ref` does for the §5.2 signing secret [I-7]
  {
    from: "public_key_ed25519 TEXT NOT NULL CHECK(length(public_key_ed25519)=43), created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0), revoked_at_ms INTEGER )",
    to: "public_key_ed25519 TEXT NOT NULL CHECK(length(public_key_ed25519)=43), created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0), revoked_at_ms INTEGER , secret_ref TEXT)",
  },
  // D.1e: the identity of the SOURCE this version was packed from — the value
  // `skill.create_from_dir` converges on, because the §5 arrival marker makes
  // the PACKED bytes different on every packing of one unchanged source
  {
    from: "deprecation_at_ms INTEGER, created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0), UNIQUE(skill_id,semantic_version)",
    to: "deprecation_at_ms INTEGER, created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0), source_hash TEXT, UNIQUE(skill_id,semantic_version)",
  },
  // D.1f: the rebuild quotes the table name (ALTER TABLE … RENAME TO), exactly
  // as the D.1b rebuild of `adoption_requests` does
  { from: "CREATE TABLE receipt_events(", to: 'CREATE TABLE "receipt_events"(' },
  // D.1f: `transferred` — a sender's decision, which is not `delivered` because
  // nothing has reached anybody at the moment it is recorded (§5.4)
  {
    from: "CHECK(event IN ('delivered','attempted','adopted','failed','rolled_back'))",
    to: "CHECK(event IN ('delivered','attempted','adopted','failed','rolled_back','transferred'))",
  },
  // D.1f: the typed recipient, on the INSERT-only row the counter reads
  {
    from: "idempotency_key TEXT NOT NULL, environment_json TEXT, UNIQUE(adoption_receipt_id,idempotency_key)",
    to: "idempotency_key TEXT NOT NULL, environment_json TEXT, recipient_json TEXT, UNIQUE(adoption_receipt_id,idempotency_key)",
  },
];

/**
 * The objects the migrations after D.1 ADD, per migration file.
 *
 * Every delta up to D.1e was a column on a table D.1 already had; D.1f was the
 * first to bring tables of its own and D.1g brings two more, so they are listed
 * BY FILE and their DDL is compared against the file that creates them — not
 * merely counted. An object no file names still fails the comparison below, and
 * so does a change to one that is named.
 */
const NEW_OBJECTS: ReadonlyArray<{ file: string; names: readonly string[] }> = [
  {
    file: "0006_transfer_to_a_named_recipient.sql",
    names: ["transfer_grants", "transfers", "idx_transfers_version", "tg_transfers_no_upd", "tg_transfers_no_del"],
  },
  {
    file: "0007_assignment_and_native_activation.sql",
    names: [
      "assignments",
      "idx_assignments_agent",
      "assignment_events",
      "tg_assignments_no_upd",
      "tg_assignments_no_del",
      "tg_aevents_no_upd",
      "tg_aevents_no_del",
    ],
  },
];

const ADDED_OBJECT_COUNT = NEW_OBJECTS.reduce((n, m) => n + m.names.length, 0);

function applyAuthorizedEdits(normalized: string): string {
  let out = normalized;
  for (const { from, to } of AUTHORIZED_P5_EDITS) {
    // the trailing `;` variants: normalize() already stripped it
    const f = from.replace(/;$/, "");
    const t = to.replace(/;$/, "");
    if (out.includes(f)) out = out.split(f).join(t);
  }
  return out;
}

test("live schema is Appendix D.1 plus exactly the Appendix D.1b delta", () => {
  const db = openMigrated();
  const live = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ sql: string }>;
  const liveSet = new Set(live.map((r) => normalize(r.sql)));

  const fileStatements = statements(ddl).filter((s) => /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER)/i.test(s));
  assert.equal(fileStatements.length, 20 + 9 + 10, "20 tables + 9 indexes + 10 triggers in DDL file");

  let edited = 0;
  for (const st of fileStatements) {
    const d1 = normalize(st);
    if (liveSet.has(d1)) continue; // unchanged by P5 — the case for 18 of 20 tables
    const expected = applyAuthorizedEdits(d1);
    assert.notEqual(expected, d1, `live schema diverges from D.1 with no authorized edit: ${st.slice(0, 90)}…`);
    assert.ok(
      liveSet.has(expected),
      `live statement is not D.1 + the authorized edit:\n  expected: ${expected.slice(0, 300)}`,
    );
    edited += 1;
  }
  assert.equal(
    edited,
    5,
    "exactly five tables carry the authorized delta: adoption_requests, webhooks, receipt_events, signing_keys and skill_versions",
  );

  // Everything live that is NOT a D.1 statement must be an object one of the
  // later migrations creates, and must be the statement THAT file creates —
  // byte for byte after the same normalization. This is the "no extra objects"
  // assertion the equality of counts used to make, restated now that the schema
  // has objects D.1 never had.
  const d1Live = new Set(fileStatements.map((st) => applyAuthorizedEdits(normalize(st))));
  const extra = live.map((r) => normalize(r.sql)).filter((sql) => !d1Live.has(sql));
  const expectedExtra: string[] = [];
  for (const { file, names } of NEW_OBJECTS) {
    const fromMigration = new Map(
      statements(readFileSync(join(root, "migrations", file), "utf8"))
        .filter((st) => /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER)/i.test(st))
        .map((st) => {
          const name = /^CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER)\s+"?([A-Za-z0-9_]+)"?/i.exec(st);
          assert.ok(name, `unparsed statement in ${file}: ${st.slice(0, 60)}`);
          return [name[1], normalize(st)] as const;
        }),
    );
    for (const n of names) {
      const sql = fromMigration.get(n);
      assert.ok(sql, `${file} does not create ${n}`);
      expectedExtra.push(sql);
    }
  }
  assert.deepEqual(
    extra.sort(),
    expectedExtra.sort(),
    "the live schema's non-D.1 objects are exactly the ones the later migrations create",
  );
  assert.equal(liveSet.size, fileStatements.length + ADDED_OBJECT_COUNT, "live schema has no extra objects");
});

test("object counts: 24 tables, 16 triggers, 11 indexes; no bookkeeping table", () => {
  const db = openMigrated();
  const count = (type: string) =>
    (db
      .prepare("SELECT count(*) c FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%'")
      .get(type) as { c: number }).c;
  // D.1's 20 + D.1f's `transfer_grants` and `transfers` + D.1g's `assignments`
  // and `assignment_events`; D.1's 10 triggers + the two that keep `transfers`
  // INSERT-only + D.1g's four; D.1's 9 indexes + `idx_transfers_version` +
  // `idx_assignments_agent`. The two `receipt_events` triggers and the partial
  // terminal index are the ORIGINALS re-created verbatim by the D.1f rebuild,
  // not additions — which is why those counts move by exactly the new objects.
  assert.equal(count("table"), 24);
  assert.equal(count("trigger"), 16);
  assert.equal(count("index"), 11);
  const uv = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(
    uv.user_version,
    7,
    "0002 = D.1b approval hold + webhook delta, 0003 = D.1c notification_kind, 0004 = D.1d environment_json, 0005 = D.1e secret_ref + source_hash, 0006 = D.1f transfer grants + transfers + the `transferred` event, 0007 = D.1g assignments + their INSERT-only journal; tracked in user_version",
  );
});

// The P0 freeze holds for everything the amendment does not name: 0001_init.sql
// is untouched, the rebuild loses no data, and referential integrity survives it.
test("the P5 migration is additive: no data lost, no FK broken, 0001_init.sql untouched", () => {
  const db = openMigrated();
  assert.equal(
    (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length,
    0,
    "the adoption_requests rebuild left no dangling reference",
  );
  const cols = (db.prepare("PRAGMA table_info(adoption_requests)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const kept of [
    "id", "skill_version_id", "adopter_agent_id", "requester_context_json", "state",
    "dead_letter_reason", "lease_owner", "lease_expires_at_ms", "attempt_count",
    "next_attempt_at_ms", "created_at_ms",
  ]) {
    assert.ok(cols.includes(kept), `D.1 column ${kept} survived the rebuild`);
  }
  assert.ok(cols.includes("webhook_id"), "D.1b column added");
  assert.ok(cols.includes("notification_kind"), "D.1c column added");
  assert.equal(cols.length, 13, "eleven D.1 columns + webhook_id + notification_kind, nothing else");
  // additive means additive: every pre-existing row is what it always was
  const kinds = db.prepare("SELECT DISTINCT notification_kind FROM adoption_requests").all() as Array<{ notification_kind: string }>;
  assert.ok(kinds.every((k) => k.notification_kind === "adoption" || k.notification_kind === "revocation"));
});

test("foreign keys are ON on every fresh connection", () => {
  const db = openMigrated();
  const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  assert.equal(fk.foreign_keys, 1);
});
