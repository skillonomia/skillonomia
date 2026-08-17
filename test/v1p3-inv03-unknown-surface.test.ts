// V1 P3 — `INV-03` ON EVERY UNKNOWN AN OWNER CAN SEE (`P3-FR-08`).
//
// P3 REVIEW-2 finding `P3-R2-002`: `GET /v1/fleet` published
// `session_active: "unknown"` with no reason code and no `observed_at`, and
// `GET /v1/fleet/:agent/capabilities` published `measurement_state: "unknown"`
// cells with no code, no time, and a machine token — `no_inventory_root_configured`
// — sitting in the field a human-readable reason belongs in.
//
// The sweep below walks the two payloads the finding names and fails on any
// `unknown` missing any of the invariant's four fields, or carrying a code
// where a sentence belongs. It walks the SHIPPED ANSWER rather than the
// constructors: a check that only ran at construction would be satisfied by a
// surface that assembled its own object literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRest, type RestResponse } from "../src/http.ts";
import { p4Fixture, type P4Fixture } from "./p4-helpers.ts";
import { capabilityColumns, missingUnknownField, isReasonCode, unknownReasonProse } from "../src/fleet.ts";

function rest(fx: P4Fixture, method: string, path: string, key: string, body?: unknown): RestResponse & { body: any; raw: string } {
  const res = handleRest(fx.registry, {
    method,
    url: path,
    headers: { authorization: `Bearer ${key}` },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  });
  let parsed: any = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  return { ...res, body: parsed, raw: res.body };
}

/** One `unknown` an owner can see, named by where it was found. */
interface FoundUnknown {
  where: string;
  account: unknown;
}

/**
 * EVERY UNKNOWN IN A SHIPPED PAYLOAD, and where the four fields must be found.
 *
 * Four shapes carry an observed `unknown` on these two surfaces: a measured
 * number, a state column, and the agent row's `session_active` and
 * `sync_status`, whose accounts sit beside them because the statuses themselves
 * are single words in a closed vocabulary.
 */
export function unknownsIn(value: unknown, where = "$", out: FoundUnknown[] = []): FoundUnknown[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => unknownsIn(v, `${where}[${i}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.measurement_state === "unknown") out.push({ where: `${where}.measured`, account: o });
    if (o.column !== undefined && o.value === "unknown") out.push({ where: `${where}.column(${String(o.column)})`, account: o });
    if (o.session_active === "unknown") out.push({ where: `${where}.session_active`, account: o.session_active_account });
    if (o.sync_status === "unknown") out.push({ where: `${where}.sync_status`, account: o.sync_status_account });
    for (const [k, v] of Object.entries(o)) unknownsIn(v, `${where}.${k}`, out);
  }
  return out;
}

/** The violations of `INV-03` in a payload, as sentences. Empty is the pass. */
export function inv03Violations(payload: unknown, label: string): string[] {
  const bad: string[] = [];
  for (const found of unknownsIn(payload, label)) {
    const missing = missingUnknownField(found.account);
    if (missing !== null) bad.push(`${found.where}: \`${missing}\``);
  }
  return bad;
}

test("every unknown `GET /v1/fleet` and the capability detail publish carries INV-03's four fields", () => {
  const fx = p4Fixture();
  try {
    const fleet = rest(fx, "GET", "/v1/fleet", fx.keys.owner);
    assert.equal(fleet.status, 200, fleet.raw);
    const row = fleet.body.agents.find((a: any) => a.agent_id === fx.author.agent_id);
    assert.ok(row, "the author must appear in the fleet listing");
    assert.equal(row.session_active, "unknown", "the fixture reports nothing, so nothing is claimed");

    // the finding's own two symptoms, named
    assert.ok(isReasonCode(row.session_active_account.reason_code), "an unknown session with no machine code");
    assert.ok(Number.isInteger(row.session_active_account.observed_at_ms), "an unknown session with no time of observation");
    assert.ok(row.session_active_account.reason.includes(" "), "a code where the sentence belongs");

    assert.deepEqual(inv03Violations(fleet.body, "GET /v1/fleet"), []);

    const caps = rest(fx, "GET", `/v1/fleet/${fx.author.agent_id}/capabilities`, fx.keys.owner);
    assert.equal(caps.status, 200, caps.raw);
    const unwalked = caps.body.inventory.find((n: any) => n.measurement_state === "unknown");
    assert.ok(unwalked, "an unwalked root must answer `unknown` for every kind");
    assert.equal(unwalked.reason_code, "no_inventory_root_configured");
    assert.equal(unwalked.reason, unknownReasonProse("no_inventory_root_configured"));
    assert.ok(Number.isInteger(unwalked.observed_at_ms));
    assert.deepEqual(inv03Violations(caps.body, "GET /v1/fleet/:agent/capabilities"), []);
    assert.ok(unknownsIn(caps.body).length >= 6, "the sweep found nothing to check, so it proved nothing");
  } finally {
    fx.db.close();
  }
});

test("a state column published with the time of the look carries the four fields on every unknown cell", () => {
  // The capability columns of §4, built the way the fleet surface builds them:
  // with the moment of the look. Every cell an unreported agent produces is
  // `unknown`, which is the whole set this invariant governs.
  const cells = capabilityColumns({
    runtime: "codex",
    subject: { skill_version_id: "v", marker: "m", has_executable_step: true },
    registered: { value: "unknown", reason: "no_inventory_root_configured", window_detail: "no directory was walked" },
    intent: null,
    snapshot: null,
    outcome_contract: null,
    observed_at_ms: 1_700_000_000_000,
  });
  const unknowns = unknownsIn(cells).filter((f) => f.where.includes(".column("));
  assert.ok(unknowns.length >= 4, "the column set produced no unknown cell, so this proves nothing");
  assert.deepEqual(inv03Violations(cells, "columns"), []);
  for (const c of unknowns) {
    const o = c.account as any;
    assert.ok(isReasonCode(o.reason_code), `${c.where} published no machine code`);
    assert.notEqual(o.reason, o.reason_code, `${c.where} published its code twice`);
    assert.equal(o.observed_at_ms, 1_700_000_000_000, `${c.where} lost the time of the look`);
  }
});

test("the sweep fails on a payload whose unknown lost a field or kept a code where prose belongs", () => {
  const fx = p4Fixture();
  try {
    const caps = rest(fx, "GET", `/v1/fleet/${fx.author.agent_id}/capabilities`, fx.keys.owner);
    assert.equal(caps.status, 200, caps.raw);
    assert.deepEqual(inv03Violations(caps.body, "clean"), [], "the real answer must pass before a doctored one is asked to fail");

    // A CHECK THAT CANNOT FAIL IS NOT A CHECK. Each doctoring below removes
    // exactly one of the invariant's guarantees from a real payload.
    const droppedCode = JSON.parse(JSON.stringify(caps.body));
    droppedCode.inventory[0].reason_code = null;
    assert.deepEqual(inv03Violations(droppedCode, "d"), ["d.inventory[0].measured: `reason_code`"]);

    const droppedTime = JSON.parse(JSON.stringify(caps.body));
    droppedTime.inventory[0].observed_at_ms = null;
    assert.deepEqual(inv03Violations(droppedTime, "d"), ["d.inventory[0].measured: `observed_at_ms`"]);

    const codeAsProse = JSON.parse(JSON.stringify(caps.body));
    codeAsProse.inventory[0].reason = "no_inventory_root_configured";
    assert.deepEqual(inv03Violations(codeAsProse, "d"), ["d.inventory[0].measured: `reason`"]);

    const noAccount = JSON.parse(JSON.stringify(caps.body));
    noAccount.agent.session_active_account = null;
    assert.deepEqual(inv03Violations(noAccount, "d"), ["d.agent.session_active: `reason_code`"]);
  } finally {
    fx.db.close();
  }
});

test("a code with no registered sentence is refused rather than published", () => {
  assert.throws(() => unknownReasonProse("a_code_nobody_wrote_a_sentence_for"), /no sentence is registered/);
  assert.equal(
    unknownReasonProse("evidence_missing:stdout_so_the_check_was_never_executed").includes("`stdout`"),
    true,
    "the one qualified form must name the evidence key the contract asked for",
  );
});
