// §5.4 transfer, §6.2 grants — the operation whose RECIPIENT has a type.
//
// What each group below is for, and why it is here rather than assumed:
//
//   1. a transfer names its recipient. There is no default, no inference from
//      the caller, and no form of the call that omits it — the untyped internal
//      move is not merely discouraged, it is unreachable through the surface
//      AND unwritable through the schema;
//   2. `remote_fleet` is DECLARED and refuses. The refusal must be
//      distinguishable from a permission refusal, or the model has not in fact
//      separated "you may not" from "this does not exist yet";
//   3. the V-2 ambassador is one row of data. This is the test the whole grant
//      concept was accepted for, and it fails if expressing an ambassador needs
//      a column, an enum member or a branch;
//   4. the action list is closed and a grant for one step does not authorize
//      another;
//   5. a transfer leaves an EVENT, and the migration counter takes the
//      recipient from that event and not from a state row;
//   6. a transfer claims NOTHING about the recipient. Intent and observation are
//      two columns, and the observed one is `unknown`;
//   7. the type of the principal behind a permission is on the record, and stays
//      what it was when the record was written.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  p4Fixture,
  reviewedVersion,
  goodEvidence,
  rest,
  mcp,
  env,
  type P4Fixture,
} from "./p6-helpers.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { GRANT_ACTIONS, RECIPIENT_KINDS, IMPLEMENTED_RECIPIENT_KINDS } from "../src/grants.ts";
import { TRANSFER_ACTION } from "../src/transfer.ts";
import { appendReceiptEvent } from "../src/receipts.ts";
import { arrivalMarker } from "../src/marker.ts";
import { ulid } from "../src/ulid.ts";

/** A reference that is NOT a row of this database — what V-2 will send to. */
const FLEET = "fleet://example-fleet/eu-west-1";

function grant(
  fx: P4Fixture,
  agentId: string,
  scope: string,
  opts: { action?: string; by?: string } = {},
): { status: number; body: any; raw: string } {
  return rest(fx, "POST", "/v1/transfer-grants", opts.by ?? fx.keys.owner, {
    agent_id: agentId,
    action: opts.action ?? TRANSFER_ACTION,
    recipient_scope: scope,
  });
}

function transfer(
  fx: P4Fixture,
  key: string,
  versionId: string,
  recipient: unknown,
  extra: Record<string, unknown> = {},
): { status: number; headers: Record<string, string>; body: any; raw: string } {
  const body: Record<string, unknown> = { ...extra };
  // `undefined` must reach the surface as an ABSENT member, which is the case
  // under test — JSON.stringify drops it, exactly as a real caller would.
  if (recipient !== undefined) body.recipient = recipient;
  return rest(fx, "POST", `/v1/versions/${versionId}/transfers`, key, body);
}

/** Every table of the live schema with its row count. */
function counts(fx: P4Fixture): Record<string, number> {
  const tables = (
    fx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (fx.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return out;
}

/** Which tables gained or lost rows, and by how much. */
function delta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, n] of Object.entries(after)) if (n !== before[t]) out[t] = n - before[t];
  return out;
}

/** The CREATE statement of every live object — the SHAPE of the model. */
function schemaDump(fx: P4Fixture): string {
  return (
    fx.db
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ sql: string }>
  )
    .map((r) => r.sql)
    .join("\n;\n");
}

function migrationRow(fx: P4Fixture, slug: string): any {
  const res = rest(fx, "GET", "/v1/migrations", fx.keys.owner);
  assert.equal(res.status, 200, res.raw);
  const row = res.body.items.find((i: any) => i.slug === slug);
  assert.ok(row, `${slug} has a counted row`);
  return row;
}

/** A version the member may transfer, with the member holding the local grant. */
function ready(fx: P4Fixture, slug: string): { versionId: string; manifest: any } {
  const v = reviewedVersion(fx, slug);
  assert.equal(grant(fx, fx.member.agent_id, "local_agent").status, 201);
  return { versionId: v.versionId, manifest: v.manifest };
}

// ===========================================================================
// 1. The recipient is named, or there is no transfer
// ===========================================================================

test("a transfer without a named recipient is refused, on both adapters, and writes nothing", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-no-recipient");
  const before = counts(fx);

  // Every shape of "no recipient", including the two that look like one.
  const shapes: Array<[string, unknown]> = [
    ["absent", undefined],
    ["null", null],
    ["empty object", {}],
    ["kind only", { kind: "local_agent" }],
    ["ref only", { ref: fx.reviewer.agent_id }],
    ["a bare id — the untyped form this surface replaces", fx.reviewer.agent_id],
    ["an id in an array", [fx.reviewer.agent_id]],
    ["empty ref", { kind: "local_agent", ref: "" }],
    ["a kind outside the closed set", { kind: "same_database", ref: fx.reviewer.agent_id }],
    ["a kind that is not a string", { kind: 1, ref: fx.reviewer.agent_id }],
  ];
  for (const [why, recipient] of shapes) {
    const res = transfer(fx, fx.keys.member, v.versionId, recipient);
    assert.equal(res.status, 400, `${why}: expected INVALID_SCHEMA, got ${res.raw}`);
    assert.equal(res.body.error.code, "INVALID_SCHEMA", why);
  }
  // the absent case says WHY, so a caller cannot read the refusal as a bug
  const absent = transfer(fx, fx.keys.member, v.versionId, undefined);
  assert.match(absent.body.error.message, /no default/i, "the refusal must state that there is no default");

  assert.deepEqual(delta(before, counts(fx)), {}, "a refused transfer wrote a row somewhere");

  // MCP answers identically (§6: one rule, two adapters)
  const viaMcp = mcp(fx, fx.keys.member, "skill.transfer", { skill_version_id: v.versionId });
  assert.equal(viaMcp.isError, true, "MCP accepted a transfer REST refuses");
  assert.equal(viaMcp.data.error.code, "INVALID_SCHEMA");
  assert.deepEqual(delta(before, counts(fx)), {}, "the MCP refusal wrote a row somewhere");

  // and the advertised contract says so before a call is ever made
  const tool = MCP_TOOLS.find((t) => t.name === "skill.transfer") as any;
  assert.ok(tool, "the tool is advertised");
  assert.ok(tool.inputSchema.required.includes("recipient"), "the schema must require a recipient");
  assert.deepEqual(tool.inputSchema.properties.recipient.required, ["kind", "ref"], "…both halves of it");
  assert.deepEqual(tool.inputSchema.properties.recipient.properties.kind.enum, [...RECIPIENT_KINDS]);
  fx.db.close();
});

test("an untyped move is unwritable: the schema refuses a transfer row with no recipient type", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-unwritable");
  const ok = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(ok.status, 201, ok.raw);

  // A row that records a movement without saying what kind of recipient it went
  // to cannot be written even by SQL, which is what makes the surface rule a
  // property of the model rather than of one call site.
  const row = fx.db.prepare("SELECT * FROM transfers").get() as Record<string, unknown>;
  const insert = (over: Record<string, unknown>): void => {
    const merged: Record<string, unknown> = { ...row, ...over, id: ulid(Date.now()) };
    const cols = Object.keys(merged);
    fx.db
      .prepare(`INSERT INTO transfers(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...cols.map((c) => merged[c]));
  };
  assert.throws(() => insert({ recipient_kind: null }), /NOT NULL|constraint/i, "a typeless recipient");
  assert.throws(() => insert({ recipient_ref: null }), /NOT NULL|constraint/i, "an unnamed recipient");
  assert.throws(() => insert({ recipient_kind: "internal" }), /CHECK|constraint/i, "a kind outside the closed set");
  assert.throws(() => insert({ recipient_kind: "" }), /CHECK|constraint/i, "an empty kind");

  // …and sending to oneself — the closest thing to "move it inside the database"
  // the typed surface still admits — is refused by name.
  const self = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.member.agent_id });
  assert.equal(self.status, 400, self.raw);
  assert.match(self.body.error.message, /other than its sender/);

  // every recorded transfer carries a kind from the closed set: no row anywhere
  // is an untyped movement
  const kinds = (fx.db.prepare("SELECT DISTINCT recipient_kind AS k FROM transfers").all() as Array<{ k: string }>).map(
    (r) => r.k,
  );
  assert.ok(kinds.length > 0, "there is a transfer to inspect");
  for (const k of kinds) assert.ok((RECIPIENT_KINDS as readonly string[]).includes(k), `recorded kind ${k}`);
  fx.db.close();
});

// ===========================================================================
// 2. A declared kind that is not implemented refuses, and says which refusal
//    it is
// ===========================================================================

test("`remote_fleet` is declared and refuses as unimplemented — never silently, and never as a permission error", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-remote");
  assert.deepEqual([...IMPLEMENTED_RECIPIENT_KINDS], ["local_agent"], "V-1 implements exactly one kind");
  assert.ok((RECIPIENT_KINDS as readonly string[]).includes("remote_fleet"), "…and declares the other");

  // the member holds `assign` for local_agent only
  const withoutScope = transfer(fx, fx.keys.member, v.versionId, { kind: "remote_fleet", ref: FLEET });
  assert.equal(withoutScope.status, 403, withoutScope.raw);
  assert.equal(withoutScope.body.error.code, "FORBIDDEN", "no grant for that scope is a PERMISSION refusal");

  // now the scope is granted: the permission is satisfied and the TRANSPORT is
  // what is missing. The two answers must not be the same answer.
  assert.equal(grant(fx, fx.member.agent_id, "remote_fleet").status, 201);
  const before = counts(fx);
  const refused = transfer(fx, fx.keys.member, v.versionId, { kind: "remote_fleet", ref: FLEET });
  assert.equal(refused.status, 501, refused.raw);
  assert.equal(refused.body.error.code, "NOT_IMPLEMENTED");
  assert.notEqual(refused.body.error.code, withoutScope.body.error.code, "a missing transport is not a missing grant");
  assert.match(refused.body.error.message, /not implemented in V-1/i);

  // it is a refusal, not a stub that looks like success: nothing was recorded,
  // no queue row, no receipt, no event
  assert.deepEqual(delta(before, counts(fx)), {}, "the unimplemented kind wrote something");
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM transfers").get() as any).c, 0, "no transfer was recorded");

  // and it did not quietly become a local transfer to some default recipient
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM adoption_receipts WHERE skill_version_id=?").get(v.versionId) as any).c,
    0,
  );

  // the same caller, the same version, the implemented kind: 201. So the 501 is
  // about the recipient kind and not about this fixture.
  const local = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(local.status, 201, local.raw);

  // both adapters
  const viaMcp = mcp(fx, fx.keys.member, "skill.transfer", {
    skill_version_id: v.versionId,
    recipient: { kind: "remote_fleet", ref: FLEET },
  });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.data.error.code, "NOT_IMPLEMENTED", "MCP must give the same refusal REST gives");
  fx.db.close();
});

// ===========================================================================
// 3. THE V-2 AMBASSADOR — one row of data
//
// The owner accepted the grant concept on one condition: that the next
// version's ambassador — an agent permitted to assign work into a fleet outside
// this perimeter — is expressible with no change to the model. This test is
// that condition, checked. It fails if the ambassador needs a column, an enum
// member, a table or a branch of its own.
// ===========================================================================

test("the V-2 ambassador is ONE ROW OF DATA: no new column, no new enum member, no new branch", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-ambassador");

  // (a) The shape the ambassador must fit into, pinned. If expressing one ever
  //     required widening the model, one of these three fails first.
  const grantColumns = (
    fx.db.prepare("PRAGMA table_info(transfer_grants)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.deepEqual(
    grantColumns,
    [
      "id",
      "agent_id",
      "action",
      "recipient_scope",
      "granted_by_agent_id",
      "granted_by_type",
      "granted_by_role",
      "created_at_ms",
    ],
    "the ambassador needs a column the grant table does not have",
  );
  assert.deepEqual(
    [...GRANT_ACTIONS],
    ["receive", "assign", "activate", "revoke", "report_outcome"],
    "the ambassador needs an action outside the closed loop",
  );
  assert.deepEqual(
    [...RECIPIENT_KINDS],
    ["local_agent", "remote_fleet"],
    "the ambassador needs a recipient kind the model does not declare",
  );
  // …and the recipient it will name is not required to be a row of this
  // database. A `REFERENCES agents(id)` here, or a ULID-length CHECK, is
  // exactly the schema change V-2 would have to make.
  const transfersDdl = (fx.db.prepare("SELECT sql FROM sqlite_master WHERE name='transfers'").get() as { sql: string })
    .sql.replace(/\s+/g, " ");
  const refColumn = /recipient_ref [^,]*/.exec(transfersDdl);
  assert.ok(refColumn, "transfers has a recipient_ref column");
  assert.ok(!/REFERENCES/i.test(refColumn[0]), `recipient_ref is bound to a local row: ${refColumn[0]}`);
  assert.ok(!/length\(recipient_ref\)=26/.test(refColumn[0]), "recipient_ref is constrained to a local ULID");

  const schemaBefore = schemaDump(fx);
  const before = counts(fx);

  // (b) The ambassador, created through the shipped surface: ONE call, ONE row,
  //     in ONE table, and the schema does not move.
  const issued = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: fx.reviewer.agent_id,
    action: "assign",
    recipient_scope: "remote_fleet",
  });
  assert.equal(issued.status, 201, issued.raw);
  assert.deepEqual(delta(before, counts(fx)), { transfer_grants: 1 }, "an ambassador is one row, in one table");
  assert.equal(schemaDump(fx), schemaBefore, "the schema moved to make room for the ambassador");
  assert.deepEqual(
    { action: issued.body.action, scope: issued.body.recipient_scope, agent: issued.body.agent_id },
    { action: "assign", scope: "remote_fleet", agent: fx.reviewer.agent_id },
    "the row says what it was asked to say",
  );

  // (c) It is a REAL permission, evaluated by the shipped code path: the
  //     ambassador gets past the grant check and is stopped only by the
  //     transport that does not exist yet.
  const ambassador = transfer(fx, fx.keys.reviewer, v.versionId, { kind: "remote_fleet", ref: FLEET });
  assert.equal(ambassador.status, 501, ambassador.raw);
  assert.equal(ambassador.body.error.code, "NOT_IMPLEMENTED");

  // (d) THE DISCRIMINATOR. Without this the 501 above proves nothing: a
  //     `remote_fleet` refused before any lookup would satisfy it just as well.
  //     The member holds `assign` for `local_agent` and NOT for `remote_fleet`,
  //     so it is refused for a different reason — which is only true if the
  //     SCOPE of the grant is what was read.
  const notAmbassador = transfer(fx, fx.keys.member, v.versionId, { kind: "remote_fleet", ref: FLEET });
  assert.equal(notAmbassador.status, 403, notAmbassador.raw);
  assert.equal(notAmbassador.body.error.code, "FORBIDDEN");
  assert.match(notAmbassador.body.error.message, /remote_fleet/, "the refusal names the scope it did not find");

  // …and the member's own local grant still works, so the refusal above is
  // about the scope and not about the member
  assert.equal(
    transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.admin.agent_id }).status,
    201,
  );

  // (e) The row is the ONLY difference between the two principals: give the
  //     member the same row and it gets the ambassador's answer.
  assert.equal(grant(fx, fx.member.agent_id, "remote_fleet").status, 201);
  const nowAmbassador = transfer(fx, fx.keys.member, v.versionId, { kind: "remote_fleet", ref: FLEET });
  assert.equal(nowAmbassador.status, 501, nowAmbassador.raw);
  assert.equal(nowAmbassador.body.error.code, "NOT_IMPLEMENTED");

  // (f) One code path, not two: a `remote_fleet` grant is stored, listed and
  //     shaped exactly like a `local_agent` one. A special case for the
  //     ambassador anywhere in the model would show up as a difference here.
  const listed = rest(fx, "GET", "/v1/transfer-grants", fx.keys.owner);
  assert.equal(listed.status, 200, listed.raw);
  const local = listed.body.items.find((g: any) => g.recipient_scope === "local_agent");
  const remote = listed.body.items.find((g: any) => g.recipient_scope === "remote_fleet");
  assert.ok(local && remote, "both scopes are readable through the one list");
  assert.deepEqual(Object.keys(local).sort(), Object.keys(remote).sort(), "the two scopes are shaped differently");
  assert.deepEqual(Object.keys(local.granted_by).sort(), Object.keys(remote.granted_by).sort());

  // (g) And nothing about the ambassador changed the schema, from the first
  //     assertion of this test to the last.
  assert.equal(schemaDump(fx), schemaBefore, "the schema moved during the ambassador's use");
  fx.db.close();
});

// ===========================================================================
// 4. The grant is a triple, and its action list is closed
// ===========================================================================

test("a grant for one step of the loop does not authorize another, and the action list is closed", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "tr-actions");

  // no grant at all
  const none = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(none.status, 403, none.raw);
  assert.equal(none.body.error.code, "FORBIDDEN");

  // a grant for a DIFFERENT step of the same loop, in the same scope
  assert.equal(grant(fx, fx.member.agent_id, "local_agent", { action: "receive" }).status, 201);
  const wrongAction = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(wrongAction.status, 403, wrongAction.raw);
  assert.match(wrongAction.body.error.message, /`assign`/, "the refusal names the action it wanted");

  // the right one, and only then
  assert.equal(grant(fx, fx.member.agent_id, "local_agent", { action: "assign" }).status, 201);
  assert.equal(
    transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id }).status,
    201,
    "the `assign` grant is what authorizes a transfer",
  );

  // the list is closed at the surface…
  for (const action of ["deploy", "transfer", "ASSIGN", "", "assign "]) {
    const bad = grant(fx, fx.reviewer.agent_id, "local_agent", { action });
    assert.equal(bad.status, 400, `action ${JSON.stringify(action)} was accepted`);
    assert.equal(bad.body.error.code, "INVALID_SCHEMA");
    assert.ok(
      GRANT_ACTIONS.every((a) => bad.body.error.message.includes(a)),
      "the refusal names the whole closed list",
    );
  }
  for (const scope of ["kubernetes", "remote", "", "local_agent "]) {
    const bad = grant(fx, fx.reviewer.agent_id, scope);
    assert.equal(bad.status, 400, `scope ${JSON.stringify(scope)} was accepted`);
    assert.equal(bad.body.error.code, "INVALID_SCHEMA");
  }
  // …and in the schema, so a caller writing SQL cannot widen it either
  const insert = (action: string, scope: string): void => {
    fx.db
      .prepare(
        `INSERT INTO transfer_grants(id, agent_id, action, recipient_scope, granted_by_agent_id,
           granted_by_type, granted_by_role, created_at_ms) VALUES (?,?,?,?,?, 'human', 'owner', 1)`,
      )
      .run(ulid(Date.now()), fx.reviewer.agent_id, action, scope, fx.owner.agent_id);
  };
  assert.throws(() => insert("deploy", "local_agent"), /CHECK|constraint/i, "an action outside the loop");
  assert.throws(() => insert("assign", "kubernetes"), /CHECK|constraint/i, "a scope outside the kinds");

  // and a member cannot grant itself the thing it lacks
  const selfGrant = grant(fx, fx.member.agent_id, "remote_fleet", { by: fx.keys.member });
  assert.equal(selfGrant.status, 403, selfGrant.raw);
  assert.equal(selfGrant.body.error.code, "FORBIDDEN");
  fx.db.close();
});

test("no new workspace role and no new principal type were introduced", () => {
  // D-3, checked against the live schema rather than remembered: the transfer
  // model added a grant and nothing else. A role invented for it would show up
  // here, and so would a fourth principal type.
  const fx = p4Fixture();
  const enumOf = (table: string, column: string): string[] => {
    const sql = (fx.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }).sql.replace(
      /\s+/g,
      " ",
    );
    const m = new RegExp(`CHECK\\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
    assert.ok(m, `no CHECK enum for ${table}.${column}`);
    return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  };
  assert.deepEqual(enumOf("agents", "type"), ["human", "agent", "service"]);
  assert.deepEqual(enumOf("workspace_memberships", "role"), ["owner", "admin", "reviewer", "member"]);
  // the new tables speak the SAME two vocabularies — they do not extend them
  for (const [table, column] of [
    ["transfer_grants", "granted_by_type"],
    ["transfers", "sender_type"],
    ["transfers", "grantor_type"],
  ] as const) {
    assert.deepEqual(enumOf(table, column), ["human", "agent", "service"], `${table}.${column}`);
  }
  for (const [table, column] of [
    ["transfer_grants", "granted_by_role"],
    ["transfers", "sender_role"],
    ["transfers", "grantor_role"],
  ] as const) {
    assert.deepEqual(enumOf(table, column), ["owner", "admin", "reviewer", "member"], `${table}.${column}`);
  }
  fx.db.close();
});

// ===========================================================================
// 5. The transfer leaves an EVENT, and the count reads the recipient from it
// ===========================================================================

test("a transfer writes one `transferred` event carrying the typed recipient, and the counter reads it", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-event");
  const res = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(res.status, 201, res.raw);

  const events = fx.db
    .prepare("SELECT event, event_seq, recipient_json, environment_json FROM receipt_events WHERE adoption_receipt_id=?")
    .all(res.body.receipt_id) as Array<{
    event: string;
    event_seq: number;
    recipient_json: string | null;
    environment_json: string | null;
  }>;
  assert.equal(events.length, 1, "one transfer, one event");
  assert.equal(events[0].event, "transferred", "and it is not `delivered` — nothing reached anybody");
  assert.equal(events[0].event_seq, 1);
  assert.deepEqual(
    JSON.parse(events[0].recipient_json ?? "null"),
    { kind: "local_agent", id: fx.reviewer.agent_id },
    "the recipient is ON the event, typed",
  );
  assert.equal(events[0].environment_json, null, "a transfer declares no environment — nobody has run anything");

  // the transfer row points at the record it left
  const row = fx.db.prepare("SELECT * FROM transfers WHERE id=?").get(res.body.transfer_id) as any;
  assert.equal(row.adoption_receipt_id, res.body.receipt_id);
  assert.equal(row.receipt_event_seq, events[0].event_seq);
  assert.equal(row.arrival_marker, arrivalMarker(v.versionId), "the marker is the one this VERSION derives");

  // the row it left is INSERT-only, on both tables
  assert.throws(
    () => fx.db.prepare("UPDATE receipt_events SET recipient_json='{}' WHERE event='transferred'").run(),
    /INSERT_ONLY/,
  );
  assert.throws(() => fx.db.prepare("UPDATE transfers SET recipient_ref='x'").run(), /INSERT_ONLY/);
  assert.throws(() => fx.db.prepare("DELETE FROM transfers").run(), /INSERT_ONLY/);

  // an adopter cannot write one: not through the surface…
  const bySurface = rest(fx, "POST", `/v1/receipts/${res.body.receipt_id}/events`, fx.keys.reviewer, {
    event: "transferred",
  });
  assert.equal(bySurface.status, 400, bySurface.raw);
  assert.equal(bySurface.body.error.code, "INVALID_SCHEMA");
  // …and not through the receipt machine either, which is the backstop
  assert.throws(
    () =>
      appendReceiptEvent(fx.db, {
        receiptId: res.body.receipt_id,
        actorAgentId: fx.reviewer.agent_id,
        event: "transferred",
        recipient: { kind: "local_agent", id: fx.admin.agent_id },
        idempotencyKey: "forged",
        nowMs: Date.now(),
      }),
    /FORBIDDEN/,
    "the receipt's own adopter must not be able to name a recipient on this row",
  );

  // the recipient completes the chain through the ordinary surfaces, and only
  // THEN is there a migration
  const adopted = rest(fx, "POST", `/v1/adoptions/${res.body.adoption_request_id}/adopt`, fx.keys.reviewer, {
    environment_descriptor: env(),
  });
  assert.equal(adopted.status, 200, adopted.raw);
  assert.equal(rest(fx, "POST", `/v1/receipts/${res.body.receipt_id}/events`, fx.keys.reviewer, { event: "attempted" }).status, 200);
  const done = rest(fx, "POST", `/v1/receipts/${res.body.receipt_id}/events`, fx.keys.reviewer, {
    event: "adopted",
    evidence: goodEvidence(v.manifest),
  });
  assert.equal(done.status, 200, done.raw);

  const counted = migrationRow(fx, "tr-event");
  assert.equal(counted.migrations, 1);
  assert.equal(counted.distinct_recipients, 1);
  assert.equal(counted.measurement_state, "migrated");
  fx.db.close();
});

test("the counted recipient comes from the transfer EVENT, shown where the two sources disagree", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-provenance");
  const res = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(res.status, 201, res.raw);

  // In production the event and the receipt shell agree — the transfer writes
  // both, in one transaction. The disagreement below is therefore built by
  // hand, and that is the point: it is the only way to show WHICH of the two
  // the answer came from. A second chain is opened by the recipient itself, and
  // a `transferred` event naming a DIFFERENT recipient is written onto it.
  const asked = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.admin, { skill_version_id: v.versionId });
  assert.equal(asked.status, 201, asked.raw);
  const receipt = asked.body.receipt_id;
  fx.db
    .prepare(
      `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, recipient_json, server_at_ms, idempotency_key)
       VALUES (?,?, 'transferred', 1, ?, ?, ?)`,
    )
    .run(ulid(Date.now()), receipt, JSON.stringify({ kind: "local_agent", id: fx.reviewer2.agent_id }), Date.now(), "hand-written");

  const shell = fx.db.prepare("SELECT adopter_agent_id AS a FROM adoption_receipts WHERE id=?").get(receipt) as {
    a: string;
  };
  assert.equal(shell.a, fx.admin.agent_id, "the shell says one recipient…");
  assert.notEqual(fx.admin.agent_id, fx.reviewer2.agent_id, "…and the event says another");

  // finish the chain through the surfaces, so what is counted is a real migration
  assert.equal(
    rest(fx, "POST", `/v1/adoptions/${asked.body.adoption_request_id}/adopt`, fx.keys.admin, {
      environment_descriptor: env(),
    }).status,
    200,
  );
  assert.equal(rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.admin, { event: "attempted" }).status, 200);
  assert.equal(
    rest(fx, "POST", `/v1/receipts/${receipt}/events`, fx.keys.admin, {
      event: "adopted",
      evidence: goodEvidence(v.manifest),
    }).status,
    200,
  );
  // …and so is the transferred chain, adopted by its own recipient
  assert.equal(
    rest(fx, "POST", `/v1/adoptions/${res.body.adoption_request_id}/adopt`, fx.keys.reviewer, {
      environment_descriptor: env(),
    }).status,
    200,
  );
  assert.equal(rest(fx, "POST", `/v1/receipts/${res.body.receipt_id}/events`, fx.keys.reviewer, { event: "attempted" }).status, 200);
  assert.equal(
    rest(fx, "POST", `/v1/receipts/${res.body.receipt_id}/events`, fx.keys.reviewer, {
      event: "adopted",
      evidence: goodEvidence(v.manifest),
    }).status,
    200,
  );

  const row = migrationRow(fx, "tr-provenance");
  assert.equal(row.migrations, 2, "two chains reached a terminal `adopted`");
  assert.equal(row.distinct_recipients, 2);

  // the discriminating half: with BOTH chains naming the same event-recipient,
  // the pair count collapses — which can only happen if the event is what is
  // read. Build it: a third chain whose event names the recipient of the first.
  const third = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.reviewer2, { skill_version_id: v.versionId });
  assert.equal(third.status, 201, third.raw);
  fx.db
    .prepare(
      `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, recipient_json, server_at_ms, idempotency_key)
       VALUES (?,?, 'transferred', 1, ?, ?, ?)`,
    )
    .run(
      ulid(Date.now()),
      third.body.receipt_id,
      JSON.stringify({ kind: "local_agent", id: fx.reviewer.agent_id }),
      Date.now(),
      "hand-written-2",
    );
  assert.equal(
    rest(fx, "POST", `/v1/adoptions/${third.body.adoption_request_id}/adopt`, fx.keys.reviewer2, {
      environment_descriptor: env(),
    }).status,
    200,
  );
  assert.equal(rest(fx, "POST", `/v1/receipts/${third.body.receipt_id}/events`, fx.keys.reviewer2, { event: "attempted" }).status, 200);
  assert.equal(
    rest(fx, "POST", `/v1/receipts/${third.body.receipt_id}/events`, fx.keys.reviewer2, {
      event: "adopted",
      evidence: goodEvidence(v.manifest),
    }).status,
    200,
  );

  // THE DISCRIMINATION. Three chains reached a terminal `adopted`. Read from
  // the EVENTS the recipients are {reviewer, reviewer2, reviewer} — two pairs,
  // two recipients. Read from the SHELLS they are {reviewer, admin, reviewer2}
  // — three pairs, three recipients. The two answers differ, and this is the
  // one the counter must give.
  const after = migrationRow(fx, "tr-provenance");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM receipt_events WHERE event='adopted'").get() as any).c,
    3,
    "three chains really did terminate in `adopted`",
  );
  assert.equal(
    after.migrations,
    2,
    "a third chain whose EVENT names an already-counted recipient is the same (version, recipient) pair — 3 here means the shell was read",
  );
  assert.equal(
    after.distinct_recipients,
    2,
    "…and adds no recipient: the shell's adopter was never counted — 3 here means the shell was read",
  );
  fx.db.close();
});

// ===========================================================================
// 6. A transfer is an INTENT. It says nothing about the recipient.
// ===========================================================================

test("a transfer claims nothing about the recipient: intent and observation are two columns", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-intent");
  const res = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(res.status, 201, res.raw);

  assert.equal(res.body.observed_state, "unknown", "nothing was observed at the recipient");
  assert.ok(typeof res.body.intent === "string" && res.body.intent.length > 0, "the intent is stated");
  assert.notEqual(res.body.intent, res.body.observed_state, "intent and observation are not one column");
  assert.ok(res.body.observed_state_source.length > 0, "…and the observation names where it would come from");
  assert.ok(
    !/\bactive\b/i.test(JSON.stringify({ ...res.body, intent: "", observed_state_source: "" })),
    "no field of a transfer's answer says `active`",
  );
  assert.equal(res.body.receipt_event, "transferred", "the event is not `delivered`");

  // the registry's own state: nothing claims delivery, and nothing claims a run
  const view = rest(fx, "GET", `/v1/receipts/${res.body.receipt_id}`, fx.keys.reviewer);
  assert.equal(view.status, 200, view.raw);
  assert.equal(view.body.derived_state, "transferred");
  assert.deepEqual(view.body.events.map((e: any) => e.event), ["transferred"]);
  assert.deepEqual(view.body.events[0].recipient, { kind: "local_agent", id: fx.reviewer.agent_id });
  assert.equal(view.body.events[0].environment_descriptor, null);

  // …and the number that measures movement did not move
  const quiet = migrationRow(fx, "tr-intent");
  assert.equal(quiet.migrations, 0, "an intent is not a migration");
  assert.equal(quiet.distinct_recipients, 0, "…and its recipient is not yet a recipient of anything");
  assert.equal(quiet.measurement_state, "not_migrated");
  assert.equal(quiet.distinct_runtimes, 0);
  assert.deepEqual(quiet.runtimes, [], "a transfer declares no runtime, because nothing ran");

  // the version's reputation is likewise untouched by the intent
  const listed = rest(fx, "GET", "/v1/skills", fx.keys.owner).body.items.find((i: any) => i.slug === "tr-intent");
  assert.ok(listed, "the skill is visible");
  assert.equal(listed.registry.reputation.adopted_count, 0, "a transfer adopted nothing");

  // Now let the recipient actually adopt it. The numbers move — which is what
  // makes the zeroes above a measurement rather than a surface that never
  // counts anything.
  assert.equal(
    rest(fx, "POST", `/v1/adoptions/${res.body.adoption_request_id}/adopt`, fx.keys.reviewer, {
      environment_descriptor: env(),
    }).status,
    200,
  );
  assert.equal(rest(fx, "POST", `/v1/receipts/${res.body.receipt_id}/events`, fx.keys.reviewer, { event: "attempted" }).status, 200);
  assert.equal(
    rest(fx, "POST", `/v1/receipts/${res.body.receipt_id}/events`, fx.keys.reviewer, {
      event: "adopted",
      evidence: goodEvidence(v.manifest),
    }).status,
    200,
  );
  const moved = migrationRow(fx, "tr-intent");
  assert.equal(moved.migrations, 1, "an OBSERVED adoption is a migration");
  assert.equal(moved.distinct_recipients, 1);
  assert.deepEqual(moved.runtimes, ["claude-code"], "…and the runtime is the one the recipient declared");
  fx.db.close();
});

test("a transfer cannot route around a §7.3 approval", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "tr-approval", { manifest: { x_ext: { destructive: true } } });
  assert.equal(grant(fx, fx.member.agent_id, "local_agent").status, 201);

  const res = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.request_state, "approval_pending", "the §7.3 condition holds the request the transfer opened");
  assert.deepEqual(res.body.approval_required, ["destructive"]);

  // the recipient cannot collect the package until a human approves
  const held = rest(fx, "POST", `/v1/adoptions/${res.body.adoption_request_id}/adopt`, fx.keys.reviewer, {
    environment_descriptor: env(),
  });
  assert.equal(held.status, 403, held.raw);
  assert.match(held.body.error.message, /human approval/);

  const approved = rest(fx, "POST", `/v1/versions/${v.versionId}/approvals`, fx.keys.owner, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: res.body.adoption_request_id,
  });
  assert.equal(approved.status, 201, approved.raw);
  assert.equal(
    rest(fx, "POST", `/v1/adoptions/${res.body.adoption_request_id}/adopt`, fx.keys.reviewer, {
      environment_descriptor: env(),
    }).status,
    200,
    "and after the approval the same call succeeds",
  );
  fx.db.close();
});

// ===========================================================================
// 7. The type of the principal behind a permission is on the record
// ===========================================================================

test("every permission a transfer shows names its principal's TYPE, and keeps the one it was issued under", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "tr-principal");

  // Two grants that differ ONLY in who issued them: the human owner, and an
  // agent holding role admin. In a single-owner deployment the second is the
  // common case, and the record must not read like the first.
  const byHuman = grant(fx, fx.member.agent_id, "local_agent", { by: fx.keys.owner });
  assert.equal(byHuman.status, 201, byHuman.raw);
  const byAgent = grant(fx, fx.reviewer.agent_id, "local_agent", { by: fx.keys.botAdmin });
  assert.equal(byAgent.status, 201, byAgent.raw);
  assert.deepEqual(byHuman.body.granted_by, { agent_id: fx.owner.agent_id, type: "human", role: "owner" });
  assert.deepEqual(byAgent.body.granted_by, { agent_id: fx.botAdmin.agent_id, type: "agent", role: "admin" });
  assert.notEqual(byHuman.body.granted_by.type, byAgent.body.granted_by.type, "the two must not read the same");

  const humanSent = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.admin.agent_id });
  assert.equal(humanSent.status, 201, humanSent.raw);
  const agentSent = transfer(fx, fx.keys.reviewer, v.versionId, { kind: "local_agent", ref: fx.admin.agent_id });
  assert.equal(agentSent.status, 201, agentSent.raw);

  // the sender's own type and role are on the answer, not inferred from the id
  assert.deepEqual(humanSent.body.sender, { agent_id: fx.member.agent_id, type: "agent", role: "member" });
  assert.deepEqual(agentSent.body.sender, { agent_id: fx.reviewer.agent_id, type: "agent", role: "reviewer" });
  // …and so is the type of whoever authorized it
  assert.equal(humanSent.body.permission.granted_by.type, "human");
  assert.equal(agentSent.body.permission.granted_by.type, "agent");
  assert.equal(humanSent.body.permission.action, "assign");
  assert.equal(humanSent.body.permission.recipient_scope, "local_agent");

  // The record keeps what was true WHEN it was written. Roles are mutable; the
  // transfer is not, and a reader of yesterday's record must not be shown
  // today's standing.
  fx.db
    .prepare("UPDATE workspace_memberships SET role='member' WHERE agent_id=?")
    .run(fx.botAdmin.agent_id);
  const stored = fx.db.prepare("SELECT * FROM transfers WHERE id=?").get(agentSent.body.transfer_id) as any;
  assert.equal(stored.grantor_role, "admin", "the record still says the role the grant was issued under");
  assert.equal(stored.grantor_type, "agent");
  assert.equal(stored.sender_role, "reviewer");
  assert.equal(stored.sender_type, "agent");
  fx.db.close();
});

// ===========================================================================
// 8. The rest of the contract: secrets, access, adapters, idempotency
// ===========================================================================

test("a transfer carries no secret anywhere — not in the answer, not in the journal", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-secrets");
  const res = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id });
  assert.equal(res.status, 201, res.raw);

  const stored = JSON.stringify([
    fx.db.prepare("SELECT * FROM transfers").all(),
    fx.db.prepare("SELECT * FROM transfer_grants").all(),
    fx.db.prepare("SELECT * FROM receipt_events").all(),
    fx.db.prepare("SELECT * FROM activity_log").all(),
  ]);
  for (const [who, key] of Object.entries(fx.keys)) {
    assert.ok(!res.raw.includes(key), `the answer carries ${who}'s API key`);
    assert.ok(!stored.includes(key), `a stored row carries ${who}'s API key`);
  }
  // the arrival marker IS published, and is public by construction: it names a
  // version and never a caller, a key or a workspace
  assert.equal(res.body.arrival_marker, arrivalMarker(v.versionId));
  assert.ok(!res.body.arrival_marker.includes(fx.member.agent_id));
  assert.ok(!res.body.arrival_marker.includes(fx.seed.wsA));
  fx.db.close();
});

test("a transfer is not a way around visibility, and a recipient elsewhere does not exist", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-acl");
  // the cross-workspace actor cannot see a workspace-scoped version at all
  assert.equal(grant(fx, fx.outsider.agent_id, "local_agent", { by: fx.keys.owner }).status, 404, "…nor be granted here");
  const unseen = transfer(fx, fx.keys.outsider, v.versionId, { kind: "local_agent", ref: fx.member.agent_id });
  assert.equal(unseen.status, 404, unseen.raw);

  // a recipient in another workspace is absent, not forbidden
  const elsewhere = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.outsider.agent_id });
  assert.equal(elsewhere.status, 404, elsewhere.raw);
  assert.equal(elsewhere.body.error.code, "NOT_FOUND");

  // a recipient that is not a principal at all
  const nobody = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" });
  assert.equal(nobody.status, 404, nobody.raw);

  // a disabled recipient is a precondition, not an absence: it exists and cannot receive
  fx.db.prepare("UPDATE agents SET status='disabled' WHERE id=?").run(fx.reviewer2.agent_id);
  const disabled = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer2.agent_id });
  assert.equal(disabled.status, 412, disabled.raw);
  assert.equal(disabled.body.error.current_state, "disabled");
  fx.db.close();
});

test("the two adapters serve one transfer, and an idempotency_key replays it byte for byte", () => {
  const fx = p4Fixture();
  const v = ready(fx, "tr-adapters");

  const first = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id }, {
    idempotency_key: "k-1",
  });
  assert.equal(first.status, 201, first.raw);
  const replay = transfer(fx, fx.keys.member, v.versionId, { kind: "local_agent", ref: fx.reviewer.agent_id }, {
    idempotency_key: "k-1",
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.raw, first.raw, "a replay is the original bytes");
  assert.equal(replay.headers["Idempotency-Replayed"], "true");
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM transfers").get() as any).c, 1, "and it recorded one transfer");

  // over MCP, to a second recipient: the same shape, from the same service
  const viaMcp = mcp(fx, fx.keys.member, "skill.transfer", {
    skill_version_id: v.versionId,
    recipient: { kind: "local_agent", ref: fx.admin.agent_id },
  });
  assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.data));
  assert.deepEqual(Object.keys(viaMcp.data).sort(), Object.keys(first.body).sort(), "one answer, two adapters");
  assert.equal(viaMcp.data.recipient_kind, "local_agent");
  assert.equal(viaMcp.data.recipient_ref, fx.admin.agent_id);
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM transfers").get() as any).c, 2);
  fx.db.close();
});

test("`skill.transfer` is advertised as a WRITE, and the grant tools as a write and a read", () => {
  const write = MCP_TOOLS.find((t) => t.name === "skill.transfer") as any;
  assert.equal(write.annotations.readOnlyHint, false, "a step that appends to the journal is not a read");
  assert.equal(write.annotations.destructiveHint, true);
  assert.equal(write.annotations.openWorldHint, false, "V-1 reaches nothing outside this registry");
  assert.ok(/not implemented in V-1/i.test(write.description), "the hint must not promise the unimplemented kind");
  // one step of the loop: the transfer does not also report an outcome
  assert.ok(!("event" in write.inputSchema.properties), "a transfer that could append an outcome would be two steps");
  assert.ok(!("evidence" in write.inputSchema.properties));

  const create = MCP_TOOLS.find((t) => t.name === "transfer_grant.create") as any;
  const list = MCP_TOOLS.find((t) => t.name === "transfer_grant.list") as any;
  assert.equal(create.annotations.readOnlyHint, false);
  assert.equal(list.annotations.readOnlyHint, true, "reading grants must be callable without an approval prompt");
  assert.equal(list.annotations.destructiveHint, false);
  assert.deepEqual(Object.keys(list.inputSchema.properties), [], "the read takes no arguments and grants nothing");
  assert.deepEqual(create.inputSchema.properties.action.enum, [...GRANT_ACTIONS]);
  assert.deepEqual(create.inputSchema.properties.recipient_scope.enum, [...RECIPIENT_KINDS]);
});

test("grants converge, and a member reads exactly its own", () => {
  const fx = p4Fixture();
  const first = grant(fx, fx.member.agent_id, "local_agent");
  assert.equal(first.status, 201, first.raw);
  assert.ok(!("noop" in first.body), "the first issue is not a convergence");
  const again = grant(fx, fx.member.agent_id, "local_agent");
  assert.equal(again.status, 201);
  assert.equal(again.body.noop, true, "the same triple converges on the recorded grant");
  assert.equal(again.body.grant_id, first.body.grant_id);
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM transfer_grants").get() as any).c, 1);

  grant(fx, fx.reviewer.agent_id, "remote_fleet");
  const asOwner = rest(fx, "GET", "/v1/transfer-grants", fx.keys.owner);
  assert.equal(asOwner.body.items.length, 2, "an admin/owner reads the workspace's");
  const asMember = rest(fx, "GET", "/v1/transfer-grants", fx.keys.member);
  assert.deepEqual(
    asMember.body.items.map((g: any) => g.grant_id),
    [first.body.grant_id],
    "a member reads exactly its own",
  );
  const asOutsider = rest(fx, "GET", "/v1/transfer-grants", fx.keys.outsider);
  assert.deepEqual(asOutsider.body.items, [], "another workspace's grants are not disclosed");
  fx.db.close();
});
