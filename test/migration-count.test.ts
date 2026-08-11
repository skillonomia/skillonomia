// The migration counter — the number this registry exists to make countable.
//
// Every fixture below is built through the SURFACES: a request, a handover, an
// attempt, a terminal event with evidence the receipt machine validated. A test
// that wrote the rows it then counts would be asserting its own SQL.
//
// What has to hold, and why each one is here rather than assumed:
//
//   1. the unit is the (version, recipient) PAIR — a recipient re-running the
//      same version is not a second migration, and a receipt that ended in
//      `failed` is not a migration at all;
//   2. the count follows the EVENT. `adoption_requests.requester_context_json`
//      holds the same JSON and is mutable; the test that matters here makes the
//      two sources DISAGREE and shows which one the answer came from;
//   3. a skill that never migrated is a row of zeroes with its window stated,
//      and a migration whose declared runtime could not be read is reported as
//      unknown — never as a runtime, and never as the same thing as "none";
//   4. the window is the boundary the numbers were actually counted over;
//   5. the tool is a READ: it answers identically on both adapters, it changes
//      no row of the database, and it widens no access rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  p4Fixture,
  reviewedVersion,
  adoptThroughSurfaces,
  goodEvidence,
  rest,
  mcp,
  env,
  type P4Fixture,
} from "./p6-helpers.ts";
import { MIGRATION_SOURCE } from "../src/skill-migrations.ts";
import { MCP_TOOLS } from "../src/mcp.ts";

function counts(fx: P4Fixture, key: string, query = ""): any {
  const res = rest(fx, "GET", `/v1/migrations${query}`, key);
  assert.equal(res.status, 200, res.raw);
  return res.body;
}

function rowFor(body: any, slug: string): any {
  const row = body.items.find((i: any) => i.slug === slug);
  assert.ok(row, `${slug} has a row: a counted skill is never a missing one`);
  return row;
}

/**
 * A migration whose `delivered` row carries an environment the counter CANNOT
 * read, with everything else done through the surfaces.
 *
 * The one row written here by hand is the one the surfaces cannot produce:
 * `skill.adopt` validates the descriptor against the Appendix E.2 schema, so a
 * garbled declaration never comes from a current build. It comes from a row an
 * older build wrote, or from a payload that was damaged after the fact — and
 * the counter's fail-closed rule exists precisely for rows it did not write
 * itself. The chain continues through the real surfaces afterwards, so the
 * migration being counted is a genuine one.
 */
function migrationWithUnreadableEnvironment(fx: P4Fixture, v: any, key: string, payload: string, tag: string): void {
  const req = rest(fx, "POST", "/v1/adoptions/requests", key, { skill_version_id: v.versionId });
  assert.equal(req.status, 201, req.raw);
  const receipt = req.body.receipt_id;
  // seq 2: seq 1 is the `requested` event the registry wrote when this chain was
  // opened through the real surface above.
  fx.db
    .prepare(
      `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, environment_json, server_at_ms, idempotency_key)
       VALUES (?,?, 'delivered', 2, ?, ?, ?)`,
    )
    .run(`01DL${tag}`.padEnd(26, "0").slice(0, 26), receipt, payload, Date.now(), `raw-${tag}`);
  assert.equal(rest(fx, "POST", `/v1/receipts/${receipt}/events`, key, { event: "attempted" }).status, 200);
  const done = rest(fx, "POST", `/v1/receipts/${receipt}/events`, key, {
    event: "adopted",
    evidence: goodEvidence(v.manifest),
  });
  assert.equal(done.status, 200, done.raw);
}

/** Every table of the live schema, with its row count — a read must move none. */
function snapshot(fx: P4Fixture): Record<string, number> {
  const tables = (
    fx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (fx.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return out;
}

// ===========================================================================
// 1. What one migration IS
// ===========================================================================

test("a migration is a (version, recipient) pair with a terminal `adopted` receipt: a repeat is not a second one", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "mig-pair");

  adoptThroughSurfaces(fx, v, fx.keys.member);
  let row = rowFor(counts(fx, fx.keys.owner), "mig-pair");
  assert.equal(row.migrations, 1);
  assert.equal(row.distinct_recipients, 1);
  assert.equal(row.distinct_runtimes, 1);
  assert.deepEqual(row.runtimes, ["claude-code"]);
  assert.equal(row.runtimes_unknown, 0);
  assert.equal(row.measurement_state, "migrated");

  // the SAME recipient adopts the SAME version again, through a second request
  // and a second receipt: real traffic, and not a second migration
  adoptThroughSurfaces(fx, v, fx.keys.member);
  row = rowFor(counts(fx, fx.keys.owner), "mig-pair");
  assert.equal(row.migrations, 1, "the pair is the unit — the same recipient running it again does not raise it");
  assert.equal(row.distinct_recipients, 1);

  // a different recipient, declaring a different runtime, is one
  adoptThroughSurfaces(fx, v, fx.keys.reviewer, {
    descriptor: env({ runtime: { id: "codex", version: "1.0.0" } }),
  });
  row = rowFor(counts(fx, fx.keys.owner), "mig-pair");
  assert.equal(row.migrations, 2);
  assert.equal(row.distinct_recipients, 2);
  assert.equal(row.distinct_runtimes, 2);
  assert.deepEqual(row.runtimes, ["claude-code", "codex"]);

  // a receipt whose terminal event is `failed` moved nothing
  adoptThroughSurfaces(fx, v, fx.keys.admin, { terminal: "failed" });
  row = rowFor(counts(fx, fx.keys.owner), "mig-pair");
  assert.equal(row.migrations, 2, "a failed adoption is not a migration");
  assert.equal(row.distinct_recipients, 2, "…and its adopter is not a recipient");
  fx.db.close();
});

// ===========================================================================
// 2. The count comes from the journal — demonstrated where the two sources
//    disagree, because that is the only place the answer can show which one it
//    read. The mutable column was how a release figure was once raised after
//    the fact: an ordinary adopt call on a closed request rewrote the stored
//    descriptor of earlier adoptions, with no event and no error.
// ===========================================================================

test("the counter follows the receipt EVENT, and the mutable request cache cannot move it", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "mig-journal");
  adoptThroughSurfaces(fx, v, fx.keys.member);
  const before = rowFor(counts(fx, fx.keys.owner), "mig-journal");
  assert.deepEqual(before.runtimes, ["claude-code"]);
  assert.equal(before.migrations, 1);

  // Make the two sources disagree: rewrite the cache, leave the journal alone.
  const changed = fx.db
    .prepare("UPDATE adoption_requests SET requester_context_json=?")
    .run(JSON.stringify({ environment_descriptor: { runtime: { id: "probe" } } })).changes;
  assert.ok(changed > 0, "the cache was actually rewritten — otherwise this test proves nothing");

  const cached = fx.db
    .prepare("SELECT requester_context_json AS c FROM adoption_requests WHERE requester_context_json IS NOT NULL")
    .all() as Array<{ c: string }>;
  assert.ok(cached.length > 0, "there is a cache to disagree with");
  for (const r of cached) {
    assert.equal(JSON.parse(r.c).environment_descriptor.runtime.id, "probe", "the cache now says `probe`");
  }
  const evented = fx.db
    .prepare("SELECT environment_json AS e FROM receipt_events WHERE event='delivered' AND environment_json IS NOT NULL")
    .all() as Array<{ e: string }>;
  assert.ok(evented.length > 0, "and there is an event to disagree with it");
  for (const r of evented) {
    assert.equal(JSON.parse(r.e).environment_descriptor.runtime.id, "claude-code", "the events still say `claude-code`");
  }

  const after = rowFor(counts(fx, fx.keys.owner), "mig-journal");
  assert.deepEqual(after.runtimes, ["claude-code"], "the counter followed the event, not the cache");
  assert.ok(!after.runtimes.includes("probe"), "a runtime that executed nothing is in no counter");
  assert.equal(after.migrations, before.migrations, "and the migration count did not move either");
  assert.equal(after.distinct_recipients, before.distinct_recipients);

  // …and the place it DOES read refuses to be moved at all
  assert.throws(
    () => fx.db.prepare("UPDATE receipt_events SET environment_json=? WHERE event='delivered'").run("{}"),
    /INSERT_ONLY/,
    "the declared environment lives in an INSERT-only row",
  );
  assert.throws(
    () => fx.db.prepare("DELETE FROM receipt_events").run(),
    /INSERT_ONLY/,
    "…which cannot be deleted either",
  );
  fx.db.close();
});

// ===========================================================================
// 3. Zero is an answer, and unknown is not zero
// ===========================================================================

test("a skill that never migrated is a stated zero, and an unreadable runtime is unknown rather than none", () => {
  const fx = p4Fixture();
  reviewedVersion(fx, "mig-quiet");
  const unknown = reviewedVersion(fx, "mig-unknown");

  // A real migration whose declared runtime was never recorded: the recipient
  // went straight to `attempted`, so §5.3's auto-ack synthesized the
  // `delivered` row and no environment was ever declared. The registry cannot
  // know the runtime, and must not invent one.
  const req = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: unknown.versionId });
  assert.equal(req.status, 201, req.raw);
  const receipt = req.body.receipt_id;
  assert.equal(rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.member, { event: "attempted" }).status, 200);
  const done = rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.member, {
    event: "adopted",
    evidence: goodEvidence(unknown.manifest),
  });
  assert.equal(done.status, 200, done.raw);
  assert.equal(
    (fx.db.prepare("SELECT environment_json AS e FROM receipt_events WHERE adoption_receipt_id=? AND event='delivered'").get(receipt) as { e: string | null }).e,
    null,
    "the synthesized handover carries no declared environment — that is the state under test",
  );

  // …and the two other shapes an unreadable declaration takes: a payload that
  // does not parse at all, and one that parses but whose runtime id is not a
  // string. Both must land in `runtimes_unknown`, and neither may become a
  // runtime id of its own.
  const garbled = reviewedVersion(fx, "mig-garbled");
  migrationWithUnreadableEnvironment(fx, garbled, fx.keys.reviewer, "{not json", "GARBLED");
  const typeless = reviewedVersion(fx, "mig-typeless");
  migrationWithUnreadableEnvironment(
    fx,
    typeless,
    fx.keys.admin,
    JSON.stringify({ environment_descriptor: { runtime: { id: 42 } } }),
    "TYPELESS",
  );

  const body = counts(fx, fx.keys.owner);
  const quiet = rowFor(body, "mig-quiet");
  assert.equal(quiet.migrations, 0, "a skill with no receipt is a measured zero…");
  assert.equal(quiet.distinct_recipients, 0);
  assert.equal(quiet.distinct_runtimes, 0);
  assert.equal(quiet.runtimes_unknown, 0);
  assert.deepEqual(quiet.runtimes, []);
  assert.equal(quiet.measurement_state, "not_migrated", "…stated as such, not left blank");
  assert.equal(quiet.window, "all time", "…over a stated boundary");
  assert.equal(quiet.source, MIGRATION_SOURCE, "…from a named source");

  const u = rowFor(body, "mig-unknown");
  assert.equal(u.migrations, 1, "the migration happened and is counted");
  assert.equal(u.distinct_recipients, 1);
  assert.equal(u.distinct_runtimes, 0, "fail-closed: an unreadable declaration contributes NO runtime");
  assert.deepEqual(u.runtimes, []);
  assert.equal(u.runtimes_unknown, 1, "and is reported as unknown");
  assert.equal(u.measurement_state, "migrated");

  for (const slug of ["mig-garbled", "mig-typeless"]) {
    const r = rowFor(body, slug);
    assert.equal(r.migrations, 1, `${slug}: the migration itself is untouched`);
    assert.equal(r.distinct_runtimes, 0, `${slug}: an unreadable declaration is no runtime`);
    assert.deepEqual(r.runtimes, [], `${slug}: and no placeholder id was invented for it`);
    assert.equal(r.runtimes_unknown, 1, `${slug}: it is reported as unknown`);
  }
  // no row anywhere claims a runtime that was never declared
  for (const r of body.items) {
    assert.ok(!r.runtimes.includes("unknown"), "`unknown` is a state of the answer, never a runtime id");
  }

  // the two rows must not read the same: "ran nowhere we know of" and "never
  // ran" are different facts, and this is the pair that proves the surface can
  // tell them apart
  assert.notDeepEqual(
    { migrations: u.migrations, unknown: u.runtimes_unknown },
    { migrations: quiet.migrations, unknown: quiet.runtimes_unknown },
    "unknown and none render identically — the three-valued answer collapsed to two",
  );
  fx.db.close();
});

// ===========================================================================
// 4. The window is the boundary the number was counted over
// ===========================================================================

test("the stated window is the one the count used, and a malformed bound is refused on both adapters", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "mig-window");
  adoptThroughSurfaces(fx, v, fx.keys.member);
  const at = (
    fx.db
      .prepare("SELECT server_at_ms AS t FROM receipt_events WHERE event='adopted' ORDER BY event_seq DESC LIMIT 1")
      .get() as { t: number }
  ).t;

  const all = counts(fx, fx.keys.owner);
  assert.equal(all.window, "all time");
  assert.equal(all.window_since_ms, null);
  assert.equal(all.window_until_ms, null);
  assert.equal(rowFor(all, "mig-window").migrations, 1);

  const after = counts(fx, fx.keys.owner, `?since_ms=${at + 1}`);
  const excluded = rowFor(after, "mig-window");
  assert.equal(excluded.migrations, 0, "a migration outside the window is not counted");
  assert.equal(excluded.measurement_state, "not_migrated");
  assert.equal(excluded.window, `from ${at + 1} (ms) to now`, "and the row states the boundary it was counted over");
  assert.equal(after.window_since_ms, at + 1);

  const inside = counts(fx, fx.keys.owner, `?since_ms=${at}&until_ms=${at}`);
  assert.equal(rowFor(inside, "mig-window").migrations, 1, "a window that contains it counts it");
  assert.equal(inside.window, `from ${at} to ${at} (ms)`);

  for (const bad of ["?since_ms=", "?since_ms=abc", "?since_ms=1.5", `?since_ms=${at}&until_ms=${at - 1}`]) {
    const res = rest(fx, "GET", `/v1/migrations${bad}`, fx.keys.owner);
    assert.equal(res.status, 400, `REST accepted ${bad}`);
    assert.equal(res.body.error.code, "INVALID_SCHEMA");
  }
  const viaMcp = mcp(fx, fx.keys.owner, "migration.count", { since_ms: "later" });
  assert.equal(viaMcp.isError, true, "MCP accepted a bound REST refuses");
  assert.equal(viaMcp.data.error.code, "INVALID_SCHEMA");
  fx.db.close();
});

// ===========================================================================
// 5. A read, on both adapters, that widens nothing
// ===========================================================================

test("`migration.count` is advertised as reading, and counting writes no row", () => {
  const tool = MCP_TOOLS.find((t) => t.name === "migration.count") as any;
  assert.ok(tool, "the tool is advertised at all");
  assert.equal(tool.annotations?.readOnlyHint, true, "a client must be able to see that this step only reads");
  assert.equal(tool.annotations?.destructiveHint, false);
  // the reading step is its own name: nothing here also appends a receipt event
  assert.ok(!("event" in tool.inputSchema.properties), "a counting tool that could append an event would be two steps");

  const fx = p4Fixture();
  const v = reviewedVersion(fx, "mig-readonly");
  adoptThroughSurfaces(fx, v, fx.keys.member);

  const before = snapshot(fx);
  assert.ok(Object.keys(before).length >= 15, "the snapshot covers the schema");
  const viaRest = counts(fx, fx.keys.owner);
  const viaMcp = mcp(fx, fx.keys.owner, "migration.count", {});
  assert.equal(viaMcp.isError, false);
  assert.deepEqual(viaMcp.data, viaRest, "the adapters serve one answer (§6)");
  assert.deepEqual(snapshot(fx), before, "counting changed a row of the database");

  // the dashboard is a rendering of the same rows, never a second computation
  const viewed = rest(fx, "GET", "/v1/dashboard/migrations", fx.keys.owner);
  assert.equal(viewed.status, 200, viewed.raw);
  const section = viewed.body.sections.find((s: any) => s.key === "migrations");
  assert.ok(section, "the view has its section");
  // The page renders the API's own rows as CELLS: [I-1] and [I-3] hold on every
  // one of the eleven views, so a figure on a page carries its measurement
  // state, its source and its boundary rather than sitting beside them in a
  // neighbouring column. The ANSWER of each cell is the API's own value.
  const answerOf = (cell: unknown): string => {
    const text = String(cell ?? "");
    const i = text.indexOf(" · ");
    return (i < 0 ? text : text.slice(0, i)).trim();
  };
  assert.equal(section.rows.length, viaRest.items.length, "the page shows the API's own rows");
  section.rows.forEach((row: any, i: number) => {
    const api = viaRest.items[i];
    for (const field of ["migrations", "distinct_recipients", "distinct_runtimes", "runtimes_unknown"]) {
      assert.equal(answerOf(row[field]), String(api[field]), `${field} on the page is the API's own number`);
      assert.match(String(row[field]), /kind: measured_number/, `${field} is published with its method [I-3]`);
    }
    assert.equal(row.slug, api.slug);
    assert.equal(row.measurement_state, api.measurement_state);
    assert.equal(row.source, api.source);
  });
  for (const field of ["migrations", "distinct_recipients", "distinct_runtimes", "runtimes_unknown", "measurement_state", "source", "window"]) {
    assert.ok(section.fields.includes(field), `the view declares ${field}`);
  }
  const html = rest(fx, "GET", "/v1/dashboard/migrations?format=html", fx.keys.owner).raw;
  assert.ok(html.includes("<th>measurement_state</th>"), "no number is published on the page without its state");
  assert.ok(html.includes("<th>source</th>") && html.includes("<th>window</th>"), "…nor without its source and window");
  assert.ok(html.includes(MIGRATION_SOURCE.replace(/&/g, "&amp;")), "the source is on the page, not only in the JSON");
  fx.db.close();
});

test("counting is not a way around visibility: an actor counts exactly the skills it can see", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "mig-acl");
  adoptThroughSurfaces(fx, v, fx.keys.member);

  const outsider = counts(fx, fx.keys.outsider);
  assert.deepEqual(outsider.items, [], "a cross-workspace actor counts nothing at all");
  assert.deepEqual(
    rest(fx, "GET", "/v1/dashboard/migrations", fx.keys.outsider).body.sections[0].rows,
    [],
    "…on the view either",
  );

  // and what an in-workspace actor counts is exactly what surface 5 shows it
  for (const key of [fx.keys.owner, fx.keys.member, fx.keys.reviewer]) {
    const visible = new Set(
      (rest(fx, "GET", "/v1/skills", key).body.items as Array<{ skill_id: string }>).map((i) => i.skill_id),
    );
    const counted = new Set((counts(fx, key).items as Array<{ skill_id: string }>).map((i) => i.skill_id));
    assert.deepEqual([...counted].sort(), [...visible].sort(), "the counted set is the visible set");
  }

  const unauthenticated = rest(fx, "GET", "/v1/migrations", "sk_not_a_key");
  assert.equal(unauthenticated.status, 401, "and it is not a public number");
  fx.db.close();
});
