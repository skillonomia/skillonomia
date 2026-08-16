// V1 P1 FIX-1 — the two findings REVIEW-1 raised against the BUILD-1 commit.
//
// `P1-R1-001`: redaction covered the BODY of a capture and not the metadata
// around it. A credential pasted into `title` reached `draft.content.title`
// verbatim, and a credential-shaped native path was interpolated into the
// refusal's `reason`. So the sweep below is over EVERY capture field that can
// reach a draft, a refusal, an API response, the database or the audit — not
// only `text`.
//
// `P1-R1-002`: a bounded capture whose compiled preview overflowed a JSON
// column answered `500 INTERNAL` and left an arrival recorded as `drafted`
// with no revision behind it. So the tests below drive the REAL HTTP listener
// and assert a structured answer, and drive each write boundary to failure and
// assert that nothing survives it.
//
// THE PLANTED MATERIAL IS ASSEMBLED AT RUN TIME, never written as a literal,
// for the reason `test/v1p1-redaction.test.ts` gives: a push-side secret
// scanner matches the blob and cannot tell a fixture from a credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, type P4Fixture } from "./p4-helpers.ts";
import { rest, mcp } from "./p6-helpers.ts";
import { MAX_LISTED_FINDINGS } from "../src/capture.ts";
import { Registry } from "../src/service.ts";
import { startServer } from "../src/http.ts";
import type { AddressInfo } from "node:net";

/** One credential per metadata field, so a leak names which field leaked. */
const PLANTED = {
  /** `title` — a GitHub PAT, the `github-token` pattern of Appendix G.1 */
  title: ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join(""),
  /** `source_ref` — a Google API key, the `google-api-key` pattern of G.1 */
  ref: ["AIza", "SyD9tSrke72PouQ", "MnMXa7eZSW0jkFMBWabc"].join(""),
  /** `native.path` — a Slack token, whose spelling is also a legal directory
   *  name, which is what lets it reach the path branch at all */
  path: ["xoxb-", "0a1b2c3d4e5f", "6g7h8i9j0k1l2m3n"].join(""),
  /** `session.session_ref` — an AWS access key id */
  sessionRef: ["AKIA", "IOSFODNN7", "EXAMPLZ"].join(""),
} as const;

const PROCEDURE = [
  "## Purpose",
  "Bring the staging database back from the nightly dump.",
  "",
  "## When to use",
  "Whenever staging is wedged and the nightly dump is younger than a day.",
  "",
  "## Procedure",
  "1. Take the service out of the load balancer.",
  "2. Restore the nightly dump.",
  "3. Put the service back.",
  "",
  "## Inputs",
  "- the dump file",
].join("\n");

/** Every planted value plus the fragments a partial leak would show up as. */
function fragments(): string[] {
  const out: string[] = [];
  for (const value of Object.values(PLANTED)) {
    out.push(value);
    if (value.length >= 24) out.push(value.slice(0, 16), value.slice(-16));
  }
  return out;
}

/** Every byte of every column of every table, as text. */
function databaseBytes(db: any): string {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const out: string[] = [];
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        out.push(`${table}.${column}: ${Buffer.isBuffer(value) ? value.toString("utf8") : String(value)}`);
      }
    }
  }
  return out.join("\n");
}

/**
 * The sweep, as a function that RETURNS what it found rather than asserting.
 *
 * A sweep that can only pass is not a check, so it is written to be runnable
 * against a surface that does carry the material — which is what the last test
 * in this file does, and why this returns a list instead of calling `assert`.
 */
function sweep(surfaces: Array<{ what: string; text: string }>): string[] {
  const violations: string[] = [];
  for (const fragment of fragments()) {
    for (const surface of surfaces) {
      if (surface.text.includes(fragment)) violations.push(`${surface.what} carries ${fragment.slice(0, 8)}…`);
    }
  }
  return violations;
}

function draftSurfaces(fx: P4Fixture, created: { raw: string }, draftId: string): Array<{ what: string; text: string }> {
  return [
    { what: "the capture response", text: created.raw },
    { what: "GET /v1/drafts", text: rest(fx, "GET", "/v1/drafts", fx.keys.owner!).raw },
    { what: "GET /v1/drafts/:id", text: rest(fx, "GET", `/v1/drafts/${draftId}`, fx.keys.owner!).raw },
    { what: "the draft audit", text: rest(fx, "GET", `/v1/drafts/${draftId}/audit`, fx.keys.owner!).raw },
    { what: "MCP draft.get", text: JSON.stringify(mcp(fx, fx.keys.owner!, "draft.get", { draft_id: draftId }).data) },
    { what: "MCP draft.audit", text: JSON.stringify(mcp(fx, fx.keys.owner!, "draft.audit", { draft_id: draftId }).data) },
    { what: "the database", text: databaseBytes(fx.db) },
  ];
}

// ---------------------------------------------------------------- P1-R1-001

test("P1-R1-001: a credential in `title` reaches neither the draft nor any surface", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    title: `restore ${PLANTED.title}`,
    source_ref: `session-${PLANTED.ref}`,
    text: PROCEDURE, // NO `# ` heading and no frontmatter: the title FALLS BACK
    idempotency_key: "r1-001-title",
  });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.body.outcome, "drafted", created.raw);
  const draftId = created.body.draft.draft_id;

  // the fallback did happen — otherwise this test proves nothing about it
  assert.match(created.body.draft.content.title, /^restore /, "the title is the fallback, not a heading");
  assert.match(created.body.draft.content.title, /⟦REDACTED:/, "…and it went through redaction");

  assert.deepEqual(sweep(draftSurfaces(fx, created, draftId)), []);

  // the replayed idempotent answer is stored bytes, and is swept too
  const replay = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    title: `restore ${PLANTED.title}`,
    source_ref: `session-${PLANTED.ref}`,
    text: PROCEDURE,
    idempotency_key: "r1-001-title",
  });
  assert.equal(replay.status, 201, replay.raw);
  assert.deepEqual(sweep([{ what: "the idempotent replay", text: replay.raw }]), []);
  fx.db.close();
});

test("P1-R1-001: the redaction of `title` is reported as a finding with no value in it", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    title: `restore ${PLANTED.title}`,
    text: PROCEDURE,
  });
  // selected by the STRUCTURED field (INV-05, `P1-R2` backlog item 2), not by a
  // regular expression over the human-readable reason, which is what a consumer
  // had to do before the field existed
  const findings = created.body.draft.content.redactions.filter((r: any) => r.source_field === "title");
  assert.equal(findings.length, 1, "the owner is told the title carried credential material");
  assert.deepEqual(
    Object.keys(findings[0]).sort(),
    ["category", "column", "detector", "line", "reason", "removed_characters", "source_field"],
    "a finding carries no field that could hold the value",
  );
  assert.match(findings[0].reason, /in the capture title:/, "the sentence is still there, as display");
  assert.ok(!JSON.stringify(findings[0]).includes(PLANTED.title.slice(0, 12)));
  fx.db.close();
});

test("P1-R1-001: a credential in a SESSION's title and ref reaches no surface", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "session",
    title: `restore ${PLANTED.title}`,
    session: {
      session_ref: `run-${PLANTED.sessionRef}`,
      turns: [
        { role: "user", text: "how do we restore staging?" },
        { role: "assistant", text: PROCEDURE },
      ],
    },
  });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.body.outcome, "drafted", created.raw);
  assert.deepEqual(sweep(draftSurfaces(fx, created, created.body.draft.draft_id)), []);
  fx.db.close();
});

test("P1-R1-001: a rejected native path is not echoed back raw in the refusal", () => {
  const fx = p4Fixture();
  const path = `skills/${PLANTED.path}/SKILL.md`;
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "native_skill",
    native: { runtime: "codex", path, content: "# something\n\nwith a body\n" },
  });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.body.outcome, "refused", created.raw);
  assert.equal(created.body.refusal.code, "UNSUPPORTED_NATIVE_SOURCE");
  // the refusal still SAYS WHICH PATH, redacted — a refusal that named no path
  // would be a refusal an owner cannot act on
  assert.match(created.body.refusal.reason, /⟦REDACTED:/, "the path is named, with the material removed");
  assert.deepEqual(
    sweep([
      { what: "the refusal response", text: created.raw },
      { what: "the database", text: databaseBytes(fx.db) },
    ]),
    [],
  );
  fx.db.close();
});

test("the sweep can fail: an unredacted value in any surface is reported", () => {
  // The same fragments, against a surface that does carry them. If this
  // returns nothing, every green result above is green for the wrong reason.
  const found = sweep([{ what: "a deliberately unredacted surface", text: `title: restore ${PLANTED.title}` }]);
  assert.ok(found.length >= 1, "the sweep found the planted value it was given");
  assert.match(found[0]!, /a deliberately unredacted surface carries/);
});

// ---------------------------------------------------------------- P1-R1-002

/** A bounded workflow carrying more credential material than the preview
 *  column could ever hold as a list of findings. */
function manySecrets(count: number): string {
  const lines = ["## Purpose", "Rotate every service key.", "", "## When to use", "Whenever the quarterly rotation runs.", "", "## Procedure"];
  for (let i = 0; i < count; i += 1) {
    lines.push(`${i + 1}. Set api_key=k${String(i).padStart(6, "0")}xq`);
  }
  return lines.join("\n");
}

/** A bounded workflow whose COMPILED security preview cannot fit its column:
 *  the permissions it declares are copied into the preview verbatim, and JSON
 *  escaping of the quotes doubles them on the way in. */
function hugePermissions(items: number, width: number): string {
  const lines = ["## Purpose", "Read a great many things.", "", "## When to use", "Whenever the audit runs.", "", "## Procedure", "1. Read them.", "2. Report.", "", "## Permissions"];
  for (let i = 0; i < items; i += 1) lines.push(`- read ${'"'.repeat(width)} ${i}`);
  return lines.join("\n");
}

test("P1-R1-002: a bounded capture with a thousand secrets answers a draft, not a 500", () => {
  const fx = p4Fixture();
  const text = manySecrets(1200);
  assert.ok(text.length < 100_000, "the input is inside the published bound");
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text });
  assert.equal(created.status, 201, created.raw.slice(0, 400));
  assert.equal(created.body.outcome, "drafted", created.raw.slice(0, 400));

  const content = created.body.draft.content;
  assert.equal(content.redactions_total, 1200, "the true count is reported");
  assert.equal(content.redactions.length, MAX_LISTED_FINDINGS, "…and the listed findings are bounded");
  assert.equal(created.body.draft.security_review.redactions_total, 1200);

  // the draft is COMPLETE: a revision exists and the row is the one returned
  const rows = fx.db.prepare("SELECT id FROM draft_revisions").all() as Array<{ id: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, created.body.draft.revision_id);
  fx.db.close();
});

test("P1-R1-002: an unstorable bounded capture ends in a structured refusal and writes no draft", () => {
  const fx = p4Fixture();
  const text = hugePermissions(300, 200);
  assert.ok(text.length < 100_000, `the input is inside the published bound: ${text.length}`);
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text });
  assert.equal(created.status, 201, created.raw.slice(0, 400));
  assert.equal(created.body.outcome, "refused", created.raw.slice(0, 400));
  assert.equal(created.body.refusal.code, "DRAFT_TOO_LARGE");
  assert.ok(created.body.refusal.reason.length > 0);
  assert.equal(created.body.draft, null);

  // the arrival is recorded as refused, and there is no half-written draft
  assert.equal((fx.db.prepare("SELECT COUNT(*) c FROM draft_revisions").get() as any).c, 0);
  const capture = fx.db.prepare("SELECT outcome, reason_code FROM captures").get() as any;
  assert.equal(capture.outcome, "refused");
  assert.equal(capture.reason_code, "DRAFT_TOO_LARGE");
  const events = fx.db.prepare("SELECT event, result FROM draft_events ORDER BY id").all() as Array<any>;
  assert.ok(events.some((e) => e.event === "refused" && e.result === "refused"), "the refusal is in the audit");
  fx.db.close();
});

test("P1-R1-002: an edit too large to store is a 413, not a 500, and appends no revision", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: PROCEDURE });
  const draftId = created.body.draft.draft_id;
  const before = (fx.db.prepare("SELECT COUNT(*) c FROM draft_revisions").get() as any).c;
  const edited = rest(fx, "POST", `/v1/drafts/${draftId}/revisions`, fx.keys.owner!, {
    sections: { permissions: Array.from({ length: 200 }, (_, i) => `read ${'"'.repeat(300)} ${i}`) },
  });
  assert.equal(edited.status, 413, edited.raw.slice(0, 400));
  assert.equal(edited.body.error.code, "LIMIT_EXCEEDED");
  assert.equal((fx.db.prepare("SELECT COUNT(*) c FROM draft_revisions").get() as any).c, before);
  fx.db.close();
});

/**
 * A database that fails on the FIRST statement touching one named table.
 *
 * This is the only way to reach a write boundary that no input can reach — a
 * disk error, a constraint nobody predicted — and the property under test is
 * that reaching it leaves NOTHING, not that it cannot be reached.
 */
function failingAt(db: any, table: string): any {
  const realPrepare = db.prepare.bind(db);
  let armed = true;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        if (armed && sql.includes(table) && /INSERT/i.test(sql)) {
          armed = false;
          return { run: () => { throw new Error(`simulated write failure on ${table}`); }, get: () => undefined, all: () => [] };
        }
        return realPrepare(sql);
      };
    },
  });
}

for (const table of ["captures", "draft_events", "draft_revisions"]) {
  test(`P1-R1-002: a failure writing ${table} leaves zero rows behind`, () => {
    const fx = p4Fixture();
    const wrapped = failingAt(fx.db, table);
    // through `Registry.capture`, which is the one entry point of this surface
    // and the one that owns the transaction (`P1-R2-003`)
    const registry = new Registry(wrapped, { now: () => Date.now() });
    assert.throws(() => registry.capture(fx.owner, { kind: "workflow", text: PROCEDURE }), /simulated write failure/);
    for (const t of ["captures", "draft_events", "draft_revisions"]) {
      assert.equal((fx.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c, 0, `${t} kept a row from a failed capture`);
    }
    fx.db.close();
  });
}

// -------------------------------------------------- at the real HTTP listener

test("P1-R1-002: the real listener answers a structured refusal, never 500 INTERNAL", async () => {
  const fx = p4Fixture();
  const server = await startServer(() => fx.registry, 0);
  const port = (server.address() as AddressInfo).port;
  const post = async (body: unknown): Promise<{ status: number; text: string }> => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/captures`, {
      method: "POST",
      headers: { authorization: `Bearer ${fx.keys.owner!}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  try {
    const oversize = await post({ kind: "workflow", text: hugePermissions(300, 200) });
    assert.notEqual(oversize.status, 500, oversize.text.slice(0, 400));
    assert.equal(oversize.status, 201, oversize.text.slice(0, 400));
    assert.equal(JSON.parse(oversize.text).outcome, "refused");
    assert.equal(JSON.parse(oversize.text).refusal.code, "DRAFT_TOO_LARGE");

    const many = await post({ kind: "workflow", text: manySecrets(1200) });
    assert.notEqual(many.status, 500, many.text.slice(0, 400));
    assert.equal(JSON.parse(many.text).outcome, "drafted");
    assert.deepEqual(sweep([{ what: "the listener's answer", text: many.text }]), []);

    // and the metadata path, over the wire
    const titled = await post({ kind: "workflow", title: `restore ${PLANTED.title}`, text: PROCEDURE });
    assert.equal(titled.status, 201, titled.text.slice(0, 400));
    assert.deepEqual(sweep([{ what: "the listener's answer", text: titled.text }]), []);

    assert.equal((fx.db.prepare("SELECT COUNT(*) c FROM draft_revisions").get() as any).c, 2, "one draft per drafted answer");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fx.db.close();
  }
});
