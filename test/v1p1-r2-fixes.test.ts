// P1 REVIEW-2 findings, closed — and the same scenarios REVIEW-2's own probe
// file ran, asserting the ANSWER instead of the defect.
//
// The three findings, and what each one turned into here:
//
//   `P1-R2-001` — the caller's `idempotency_key` reached `idempotency_keys.key`
//     VERBATIM on the one surface whose contract is that no raw secret is
//     persisted. The key cannot be redacted, because the key IS the lookup
//     index and a cleaned key would no longer equal the key a retry sends. So
//     the two P1 surfaces store `correlationDigest` of it
//     (`DIGESTED_KEY_SURFACES`) and the sweep below plants credential material
//     in the key as well as in the body.
//
//   `P1-R2-002` — an empty workflow, and a `source_ref` inside the 200-character
//     INPUT bound whose redacted form is outside the 200-character STORED
//     bound, both reached a SQLite `CHECK` and came back as `500 INTERNAL`.
//     Redaction replaces material with a marker and can make a value LONGER, so
//     the bounds are now checked against the CLEANED value, at a real HTTP
//     listener and on the MCP surface here.
//
//   `P1-R2-003` — `captureDraft` committed and `withIdempotency` then inserted
//     the replay row, so a failure between them left a capture with no replay
//     row and the retry compiled a SECOND lineage. The domain write and the
//     replay row are now one transaction.
//
// Every probe that injects a failure does it the way REVIEW-2 did: a `Proxy`
// over the fixture's own database that makes ONE prepared statement throw. The
// negative demonstration each check owes — that it can actually fail — is the
// paired assertion in the same test: the injected run leaves zero rows AND the
// un-injected run leaves the rows, so a check that passed vacuously would fail
// the second half.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { p4Fixture, NOW } from "./p4-helpers.ts";
import { rest, mcp } from "./p6-helpers.ts";
import { Registry } from "../src/service.ts";
import { startServer } from "../src/http.ts";
import { correlationDigest } from "../src/journal.ts";
import { DIGESTED_KEY_SURFACES, storedKeyFor } from "../src/idempotency.ts";
import { capFindings } from "../src/draft.ts";

const PROCEDURE = [
  "## Purpose",
  "Restore staging from a known-good backup.",
  "",
  "## When to use",
  "Whenever staging must be recovered.",
  "",
  "## Procedure",
  "1. Stop staging traffic.",
  "2. Restore the backup.",
].join("\n");

/** Assembled at run time for the reason `test/v1p1-redaction.test.ts` gives:
 *  a push-side scanner cannot tell a fixture from a credential. */
function credential(): string {
  return ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
}

/** Every byte of every column of every table, as text. */
function databaseBytes(db: any): string {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out: string[] = [];
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        out.push(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
      }
    }
  }
  return out.join("\n");
}

/** A real listener, so a `500` would be a `500` on the wire rather than a
 *  thrown error a handler test never sees. */
async function postAtListener(fx: ReturnType<typeof p4Fixture>, body: unknown): Promise<{ status: number; text: string }> {
  const server = await startServer(() => fx.registry, 0);
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/captures`, {
      method: "POST",
      headers: { authorization: `Bearer ${fx.keys.owner!}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A database whose `nth` INSERT naming `table` throws, and nothing else. */
function failNthInsert(db: any, table: string, nth: number): any {
  const realPrepare = db.prepare.bind(db);
  let seen = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        if (/INSERT/i.test(sql) && sql.includes(table)) {
          seen += 1;
          if (seen === nth) {
            return {
              run: () => {
                throw new Error(`simulated ${table} insert ${nth} failure`);
              },
              get: () => undefined,
              all: () => [],
            };
          }
        }
        return realPrepare(sql);
      };
    },
  });
}

const count = (db: any, table: string, where = ""): number =>
  (db.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get() as { c: number }).c;

// ---------------------------------------------------------------------------
// P1-R2-001 — the key of a repeat is not the caller's text
// ---------------------------------------------------------------------------

test("P1-R2-001: a credential planted in the idempotency key reaches no column, no API surface and no audit", () => {
  const fx = p4Fixture();
  const planted = credential();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    text: PROCEDURE,
    idempotency_key: planted,
  });
  assert.equal(created.status, 201, created.raw);
  const draftId = created.body.draft.draft_id;

  // the sweep REVIEW-2 asked for: every column of every table, plus the API,
  // the audit and the MCP surfaces
  const surfaces = [
    created.raw,
    rest(fx, "GET", "/v1/drafts", fx.keys.owner!).raw,
    rest(fx, "GET", `/v1/drafts/${draftId}`, fx.keys.owner!).raw,
    rest(fx, "GET", `/v1/drafts/${draftId}/audit`, fx.keys.owner!).raw,
    JSON.stringify(mcp(fx, fx.keys.owner!, "draft.get", { draft_id: draftId }).data),
    JSON.stringify(mcp(fx, fx.keys.owner!, "draft.audit", { draft_id: draftId }).data),
    databaseBytes(fx.db),
  ];
  for (const [i, surface] of surfaces.entries()) {
    assert.ok(!surface.includes(planted), `surface ${i} carries the planted key`);
    assert.ok(!surface.includes(planted.slice(0, 16)), `surface ${i} carries a fragment of the planted key`);
  }

  // …AND THE SWEEP CAN FAIL: the same search over the request that carried it
  // finds it, so a search that found nothing above found nothing because the
  // value is gone and not because the search is blind.
  assert.ok(JSON.stringify({ idempotency_key: planted }).includes(planted.slice(0, 16)));

  // what the column holds instead is the digest, and it is the digest of THAT
  // key rather than of anything else
  const row = fx.db.prepare("SELECT key FROM idempotency_keys WHERE surface='capture.submit'").get() as { key: string };
  assert.equal(row.key, correlationDigest(planted));
  fx.db.close();
});

test("P1-R2-001: replay still converges — the same key and the same request replay one lineage", () => {
  const fx = p4Fixture();
  const planted = credential();
  const first = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: PROCEDURE, idempotency_key: planted });
  const second = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: PROCEDURE, idempotency_key: planted });
  assert.equal(first.status, 201, first.raw);
  assert.equal(second.status, 201, second.raw);
  assert.equal(second.raw, first.raw, "the replay is not byte-identical to the original answer");
  assert.equal(count(fx.db, "captures"), 1, "the retry captured a second time");
  assert.equal(count(fx.db, "draft_revisions"), 1);
  assert.equal(count(fx.db, "idempotency_keys", "WHERE surface='capture.submit'"), 1);

  // a DIFFERENT key is a different row, so the digest did not collapse two keys
  const other = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: PROCEDURE, idempotency_key: `${planted}-2` });
  assert.equal(other.status, 201, other.raw);
  assert.equal(count(fx.db, "captures"), 2);
  fx.db.close();
});

test("P1-R2-001: an edited draft's key is digested too, and every other surface still stores the caller's own key", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: PROCEDURE });
  const draftId = created.body.draft.draft_id;
  const planted = credential();
  const revised = rest(fx, "POST", `/v1/drafts/${draftId}/revisions`, fx.keys.owner!, {
    sections: { purpose: "A changed purpose." },
    idempotency_key: planted,
  });
  assert.equal(revised.status, 201, revised.raw);
  const row = fx.db.prepare("SELECT key FROM idempotency_keys WHERE surface='draft.revise'").get() as { key: string };
  assert.equal(row.key, correlationDigest(planted));
  assert.ok(!databaseBytes(fx.db).includes(planted));

  // the rule is decided by the SURFACE, which is a constant of this repository,
  // and never by the form of the value — the rule `migrations/0012` withdrew
  assert.deepEqual([...DIGESTED_KEY_SURFACES].sort(), ["capture.submit", "draft.revise"]);
  assert.equal(storedKeyFor("skill.adopt", "k-1"), "k-1", "a P0-era surface still stores the caller's key");
  assert.equal(storedKeyFor("capture.submit", "k-1"), correlationDigest("k-1"));
  fx.db.close();
});

// ---------------------------------------------------------------------------
// P1-R2-002 — a bound checked against the CLEANED value, not the input
// ---------------------------------------------------------------------------

test("P1-R2-002: an empty workflow is a typed refusal at a real listener, not a 500", async () => {
  const fx = p4Fixture();
  const response = await postAtListener(fx, { kind: "workflow", text: "" });
  assert.equal(response.status, 201, response.text);
  const body = JSON.parse(response.text);
  assert.equal(body.outcome, "refused");
  assert.equal(body.refusal.code, "EMPTY_SOURCE");
  assert.equal(body.draft, null);
  // the arrival is recorded and nothing else is
  assert.equal(count(fx.db, "captures"), 1);
  assert.equal(count(fx.db, "draft_revisions"), 0);
  const stored = fx.db.prepare("SELECT redacted_source, outcome FROM captures").get() as {
    redacted_source: string;
    outcome: string;
  };
  assert.equal(stored.outcome, "refused");
  assert.equal(stored.redacted_source, "⟦REFUSED:EMPTY_SOURCE⟧", "the marker, never the content");
  fx.db.close();
});

test("P1-R2-002: the same empty workflow on the MCP surface is the same typed refusal", () => {
  const fx = p4Fixture();
  const answer = mcp(fx, fx.keys.owner!, "capture.submit", { kind: "workflow", text: "" });
  assert.equal(answer.isError, false, JSON.stringify(answer.data));
  assert.equal(answer.data.outcome, "refused");
  assert.equal(answer.data.refusal.code, "EMPTY_SOURCE");
  assert.equal(count(fx.db, "draft_revisions"), 0);
  fx.db.close();
});

test("P1-R2-002: a source_ref inside the input bound whose redacted form is outside the stored bound is LIMIT_EXCEEDED", async () => {
  const fx = p4Fixture();
  const sourceRef = "password=abcd ".repeat(14).trim();
  assert.ok(sourceRef.length <= 200, "the reference is inside the bound the caller was given");
  assert.ok(sourceRef.replace(/password=abcd/g, "password=⟦REDACTED:password⟧").length > 200, "and outside the stored one");

  const response = await postAtListener(fx, { kind: "workflow", text: PROCEDURE, source_ref: sourceRef });
  assert.equal(response.status, 413, response.text);
  assert.match(response.text, /LIMIT_EXCEEDED/);
  assert.match(response.text, /redacted/, "the answer says WHY a value inside the input bound did not fit");
  assert.equal(count(fx.db, "captures"), 0, "a refused request wrote a row");
  assert.equal(count(fx.db, "draft_events"), 0);

  // …and the check can fail: one character shorter and the same request is a
  // draft, so the refusal is about the bound and not about the shape.
  const shorter = await postAtListener(fx, { kind: "workflow", text: PROCEDURE, source_ref: "session-2026-08-16" });
  assert.equal(shorter.status, 201, shorter.text);
  assert.equal(JSON.parse(shorter.text).outcome, "drafted");
  fx.db.close();
});

test("P1-R2-002: the MCP surface answers the expanding reference with the same typed error and writes nothing", () => {
  const fx = p4Fixture();
  const sourceRef = "password=abcd ".repeat(14).trim();
  const answer = mcp(fx, fx.keys.owner!, "capture.submit", { kind: "workflow", text: PROCEDURE, source_ref: sourceRef });
  assert.equal(answer.isError, true, JSON.stringify(answer.data));
  assert.equal(answer.data.error.code, "LIMIT_EXCEEDED", JSON.stringify(answer.data));
  assert.equal(count(fx.db, "captures"), 0);
  fx.db.close();
});

test("P1-R2-002: a native path that redaction expands past the column is refused, not a 500", async () => {
  const fx = p4Fixture();
  // A path inside the 200-character bound whose redacted form is not. The
  // commas matter: a redacted value runs to the next separator, so
  // `password=abcd-password=abcd` is ONE secret and one marker — SHORTER than
  // it arrived — and only separated values expand.
  const path = `skills/${"password=abcd,".repeat(13)}x/SKILL.md`;
  assert.ok(path.length <= 200, `the path is inside the bound the caller was given: ${path.length}`);
  const response = await postAtListener(fx, {
    kind: "native_skill",
    native: { runtime: "claude_code", path, content: "---\nname: x\ndescription: y\n---\n\nbody\n" },
  });
  assert.equal(response.status, 413, response.text);
  assert.match(response.text, /LIMIT_EXCEEDED/);
  assert.equal(count(fx.db, "captures"), 0);
  fx.db.close();
});

test("P1-R2-002: a body redaction expands past the stored bound is a structured refusal, not a 500", async () => {
  const fx = p4Fixture();
  // inside MAX_SOURCE_CHARS (100,000) and outside the 200,000 the column holds
  // once every `password=abcd` becomes `password=⟦REDACTED:password⟧`
  const text = `${PROCEDURE}\n${"password=abcd ".repeat(7_100)}`;
  assert.ok(text.length <= 100_000, `the request is inside the input bound: ${text.length}`);
  const response = await postAtListener(fx, { kind: "workflow", text });
  assert.equal(response.status, 201, response.text.slice(0, 300));
  const body = JSON.parse(response.text);
  assert.equal(body.outcome, "refused");
  assert.equal(body.refusal.code, "SOURCE_TOO_LARGE");
  assert.equal(count(fx.db, "draft_revisions"), 0, "an unstorable source left a draft behind");
  assert.equal(count(fx.db, "captures"), 1, "the arrival is recorded");
  fx.db.close();
});

// ---------------------------------------------------------------------------
// P1-R2-003 — the domain write and the replay row are one mutation
// ---------------------------------------------------------------------------

test("P1-R2-003: a failure persisting the replay row rolls the capture back, and the retry replays one lineage", () => {
  const fx = p4Fixture();
  const realPrepare = fx.db.prepare.bind(fx.db);
  let armed = true;
  const wrapped = new Proxy(fx.db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        if (armed && /INSERT INTO idempotency_keys/i.test(sql)) {
          armed = false;
          return {
            run: () => {
              throw new Error("simulated idempotency response write failure");
            },
            get: () => undefined,
            all: () => [],
          };
        }
        return realPrepare(sql);
      };
    },
  });
  const registry = new Registry(wrapped, { now: () => NOW });
  assert.throws(
    () => registry.capture(fx.owner, { kind: "workflow", text: PROCEDURE }, "r2-003-boundary"),
    /simulated idempotency response write failure/,
  );
  // ALL OR NOTHING: the arrival, its revision and its audit went with the row
  // that failed
  for (const table of ["captures", "draft_revisions", "draft_events"]) {
    assert.equal(count(fx.db, table), 0, `${table} kept a row a failed capture wrote`);
  }
  assert.equal(count(fx.db, "idempotency_keys", "WHERE surface='capture.submit'"), 0);

  // …and the retry with the SAME key produces exactly one lineage, where before
  // it produced a second capture and a second revision
  const retry = registry.capture(fx.owner, { kind: "workflow", text: PROCEDURE }, "r2-003-boundary");
  assert.equal(retry.replayed, false, "the first attempt left a replay row behind after all");
  assert.equal(count(fx.db, "captures"), 1);
  assert.equal(count(fx.db, "draft_revisions"), 1);
  assert.equal(count(fx.db, "draft_events"), 3);
  assert.equal(count(fx.db, "idempotency_keys", "WHERE surface='capture.submit'"), 1);

  // a third call with the same key replays rather than compiling again
  const again = registry.capture(fx.owner, { kind: "workflow", text: PROCEDURE }, "r2-003-boundary");
  assert.equal(again.replayed, true);
  assert.equal(again.responseJson, retry.responseJson);
  assert.equal(count(fx.db, "captures"), 1, "exactly one capture lineage exists");
  fx.db.close();
});

test("P1-R2-003: a failure inside the capture still rolls back, with a key and without one", () => {
  for (const key of [undefined, "r2-003-inner"]) {
    const fx = p4Fixture();
    const registry = new Registry(failNthInsert(fx.db, "draft_events", 2), { now: () => NOW });
    assert.throws(
      () => registry.capture(fx.owner, { kind: "workflow", text: PROCEDURE }, key),
      /simulated draft_events insert 2 failure/,
    );
    for (const table of ["captures", "draft_revisions", "draft_events", "idempotency_keys"]) {
      assert.equal(count(fx.db, table, table === "idempotency_keys" ? "WHERE surface='capture.submit'" : ""), 0);
    }
    // the key was never consumed, so the caller may retry it and succeed
    const ok = new Registry(fx.db, { now: () => NOW }).capture(fx.owner, { kind: "workflow", text: PROCEDURE }, key);
    assert.equal(ok.replayed, false);
    assert.equal(count(fx.db, "captures"), 1);
    fx.db.close();
  }
});

test("P1-R2-003: a revision and its replay row commit or fail together", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: PROCEDURE });
  const draftId = created.body.draft.draft_id;
  const before = count(fx.db, "draft_revisions");

  const registry = new Registry(failNthInsert(fx.db, "idempotency_keys", 1), { now: () => NOW + 1 });
  assert.throws(
    () => registry.reviseDraft(fx.owner, draftId, { sections: { purpose: "A changed purpose." } }, "r2-003-revise"),
    /simulated idempotency_keys insert 1 failure/,
  );
  assert.equal(count(fx.db, "draft_revisions"), before, "a revision survived the failure of its replay row");

  const retry = rest(fx, "POST", `/v1/drafts/${draftId}/revisions`, fx.keys.owner!, {
    sections: { purpose: "A changed purpose." },
    idempotency_key: "r2-003-revise",
  });
  assert.equal(retry.status, 201, retry.raw);
  assert.equal(count(fx.db, "draft_revisions"), before + 1, "the retry did not produce exactly one new revision");
  fx.db.close();
});

test("P1-R2-003: the multi-process UNIQUE race still converges, and leaves no orphan lineage", () => {
  const fx = p4Fixture();
  // The other process's row, written between this call's lookup and its
  // insert: the shape a second process produces, planted with the digest the
  // writer computes so that this process's INSERT hits `UNIQUE`.
  const winner = { outcome: "drafted", capture_id: "01ANOTHERPROCESSWROTETHIS0", note: "the winner's stored answer" };
  const realPrepare = fx.db.prepare.bind(fx.db);
  let armed = true;
  const wrapped = new Proxy(fx.db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        if (armed && /INSERT INTO idempotency_keys/i.test(sql)) {
          armed = false;
          return {
            run: () => {
              throw new Error("UNIQUE constraint failed: idempotency_keys.actor_agent_id, ...");
            },
            get: () => undefined,
            all: () => [],
          };
        }
        return realPrepare(sql);
      };
    },
  });
  fx.db
    .prepare("INSERT INTO idempotency_keys(id, actor_agent_id, surface, key, response_json, created_at_ms) VALUES (?,?,?,?,?,?)")
    .run(
      "01RACEWINNERROWIDENTIFIER0".slice(0, 26),
      fx.owner.agent_id,
      "capture.submit",
      correlationDigest("r2-003-race"),
      JSON.stringify(winner),
      NOW,
    );

  const registry = new Registry(wrapped, { now: () => NOW });
  const out = registry.capture(fx.owner, { kind: "workflow", text: PROCEDURE }, "r2-003-race");
  assert.equal(out.replayed, true, "the loser of the race did not converge on the winner's answer");
  assert.deepEqual(out.response, winner);
  assert.equal(count(fx.db, "captures"), 0, "the loser left its own capture behind");
  assert.equal(count(fx.db, "draft_revisions"), 0);
  fx.db.close();
});

// ---------------------------------------------------------------------------
// REVIEW-2 backlog — the listed window, and the field a finding came from
// ---------------------------------------------------------------------------

test("backlog 1: a destructive command behind two hundred warnings is IN the listed window", () => {
  const fx = p4Fixture();
  const lines = [
    "## Purpose",
    "Install the tools needed for a recovery.",
    "",
    "## When to use",
    "Whenever the recovery environment is rebuilt.",
    "",
    "## Procedure",
  ];
  for (let i = 0; i < 200; i += 1) lines.push(`${i + 1}. npm install pkg${i}`);
  lines.push("201. rm -rf ./recovery-cache");
  const response = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: lines.join("\n") });
  assert.equal(response.status, 201, response.raw.slice(0, 500));
  const security = response.body.draft.security_review;

  // the counts were always true and still are
  assert.equal(security.blocking_count, 1);
  assert.ok(security.risky_actions_total > security.risky_actions.length, "the total still reports what the window cannot");
  assert.equal(security.risky_actions.length, 200);

  // …and the one finding worth acting on is now the first of them
  assert.equal(security.risky_actions[0].code, "destructive_command");
  assert.equal(security.risky_actions[0].severity, "fail");
  assert.equal(
    security.risky_actions.filter((f: { severity: string }) => f.severity === "fail").length,
    1,
    "every blocking finding is listed",
  );
  // within a severity, source order is intact
  const warns = security.risky_actions.filter((f: { severity: string }) => f.severity === "warn");
  assert.deepEqual(
    warns.map((f: { line: number }) => f.line),
    [...warns].sort((a: any, b: any) => a.line - b.line).map((f: any) => f.line),
  );
  fx.db.close();
});

test("backlog 1: the cap orders by rank and leaves an unranked list exactly as it was", () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ i, blocking: i === 299 }));
  const ranked = capFindings(items, (x) => (x.blocking ? 0 : 1));
  assert.equal(ranked.total, 300, "the total is over the whole set");
  assert.equal(ranked.listed.length, 200);
  assert.equal(ranked.listed[0].i, 299, "the ranked item did not reach the window");
  assert.deepEqual(
    ranked.listed.slice(1).map((x) => x.i),
    Array.from({ length: 199 }, (_, i) => i),
    "source order within a rank was not preserved",
  );
  const plain = capFindings(items);
  assert.deepEqual(
    plain.listed.map((x) => x.i),
    Array.from({ length: 200 }, (_, i) => i),
    "a list with no rank was reordered",
  );
});

test("backlog 2: a redaction finding names the field it came from as a structured value", () => {
  const fx = p4Fixture();
  const planted = credential();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    title: `restore ${planted}`,
    source_ref: `session-${planted}`,
    text: `${PROCEDURE}\n3. Use the deploy key ${planted}.`,
  });
  assert.equal(created.status, 201, created.raw);
  const redactions = created.body.draft.content.redactions;
  const byField = new Map<string, number>();
  for (const finding of redactions) byField.set(finding.source_field, (byField.get(finding.source_field) ?? 0) + 1);
  assert.deepEqual([...byField.keys()].sort(), ["source", "source_ref", "title"]);
  // the readable text is still there, and it is display only: the structured
  // field is what a consumer reads (INV-05)
  for (const finding of redactions) {
    assert.equal(typeof finding.source_field, "string");
    assert.ok(finding.reason.length > 0);
    assert.ok(!JSON.stringify(finding).includes(planted.slice(0, 12)), "a finding carries the value it reports");
  }

  const draftId = created.body.draft.draft_id;
  const revised = rest(fx, "POST", `/v1/drafts/${draftId}/revisions`, fx.keys.owner!, {
    sections: { purpose: `Restore staging with ${planted}.` },
  });
  assert.equal(revised.status, 201, revised.raw);
  const added = revised.body.content.redactions.filter((r: any) => r.source_field === "sections.purpose");
  assert.equal(added.length, 1, "an edited section names itself in the structured field");
  assert.match(added[0].reason, /in the edited purpose:/, "the sentence is still there, as display");
  fx.db.close();
});
