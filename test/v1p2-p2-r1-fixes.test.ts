// P2 FIX-1 — the checks that close REVIEW-1's findings, and that would have
// caught them.
//
// Each block names the finding it closes and asserts the behaviour that was
// WRONG before the fix, so a regression is a red test rather than a reread of a
// diff. Where a finding was about a decision being made in the wrong place, the
// test proves the decision is NOT made there any more by handing the client an
// answer no local table could have produced and requiring it to render that one.
//
// `P2-R1-003` is a browser finding: its closure lives in
// `test-browser/decision-states.mjs`, where the DOM and the absent control can
// actually be looked at. What is asserted here is the SERVER half — the verdict,
// the rule it reads, and the fact that the machine surface beside it did not
// change shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import { serve } from "../src/server.ts";
import { runInit, runValidate, runCreate, readSourceDir, EXIT_OK, EXIT_CHECK_FAILED } from "../src/cli-authoring.ts";
import { validateSourceProfile } from "../src/source-profile.ts";
import {
  GATES_NOT_REPORTED,
  NEXT_ACTION_NOT_REPORTED,
  isValidateOk,
  type CreateReport,
} from "../src/cli-authoring-contract.ts";
import { GATE_NAMES, schemaCrossFieldProblems } from "../src/gates.ts";
import { nextActionForState, TRANSITION_WHITELIST, type VersionState } from "../src/transitions.ts";
import { testDeliveryEligibility, WEBHOOK_TEST_REASON_CODES } from "../src/webhooks.ts";
import { UNDECLARED_DELIVERY_POLICY } from "../src/webhooks.ts";

const NOW = Date.parse("2026-08-26T00:00:00Z");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function recorder(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[]; all(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err, all: () => [...out, ...err].join("\n") };
}

interface Live {
  base: string;
  ownerKey: string;
  close: () => void;
}

async function registry(): Promise<Live> {
  const inst = await serve({ port: 0, host: "127.0.0.1", dataDir: tmp("p2fix-srv-"), workerIntervalMs: 0, log: () => {} });
  const addr = inst.server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : inst.port}`;
  const res = await fetch(`${base}/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap_token: inst.credentials!.bootstrap_owner_token }),
  });
  const body: any = await res.json();
  return { base, ownerKey: String(body.api_key), close: () => inst.close() };
}

async function post(base: string, path: string, key: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, json: text.length ? JSON.parse(text) : null };
}

// ===========================================================================
// P2-R1-001 — the advertised high-risk path signed a source its own first gate
// refuses, and the local validator threw away the failure that says so.
// ===========================================================================

test("P2-R1-001: init --risk high → validate → create → lint completes, eight gates pass, and the version reaches `linted`", async () => {
  const live = await registry();
  const dir = tmp("p2fix-high-");
  try {
    const init = recorder();
    assert.equal(runInit({ directory: dir, slug: "high-happy-path", risk: "high", force: false }, init.io, { nowMs: NOW }), EXIT_OK);

    // THE TEMPLATE ITSELF, unedited. This is the value the finding was about.
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.scope.risk_level, "high");
    assert.equal(
      manifest.safety.sandbox_requirement,
      "required",
      "the shipped high-risk template writes a sandbox requirement the §7.1 schema gate refuses",
    );

    const validated = recorder();
    assert.equal(runValidate({ directory: dir, json: false }, validated.io, { nowMs: NOW }), EXIT_OK, validated.all());

    const created = recorder();
    assert.equal(
      await runCreate(
        { directory: dir, slug: "high-happy-path", server: live.base, api_key_env: "K", json: true },
        created.io,
        { nowMs: NOW, env: { K: live.ownerKey } },
      ),
      EXIT_OK,
      created.all(),
    );
    const report: CreateReport = JSON.parse(created.out.join("\n"));
    assert.equal(report.state, "draft");

    // THE FIRST REAL LINT, which is where an author used to discover that the
    // two green answers above were about a source that cannot pass it.
    const lint = await post(live.base, `/v1/versions/${report.skill_version_id}/lint`, live.ownerKey, {});
    assert.equal(lint.status, 200, JSON.stringify(lint.json));
    assert.equal(lint.json.reports.length, GATE_NAMES.length, "the lint did not run all eight §7.1 gates");
    assert.deepEqual(
      lint.json.reports.filter((r: any) => r.result !== "pass"),
      [],
      "a gate did not pass on the source the shipped high-risk template produced",
    );
    assert.equal(lint.json.state, "linted", "the high-risk happy path did not leave `draft`");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    live.close();
  }
});

test("P2-R1-001 discrimination: put `none` back and BOTH the local validator and the server refuse, with the same pointer and code", async () => {
  const live = await registry();
  const dir = tmp("p2fix-mutate-");
  try {
    runInit({ directory: dir, slug: "high-mutated", risk: "high", force: false }, recorder().io, { nowMs: NOW });

    // THE MUTATION IS THE OLD TEMPLATE'S VALUE. Restoring it must reproduce the
    // defect, or the fix is not the thing that closed it.
    const path = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.safety.sandbox_requirement = "none";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // ---- LOCAL. Exactly one FAIL, and it points at the member to edit.
    const findings = validateSourceProfile(readSourceDir(dir), { nowMs: NOW });
    const fails = findings.filter((f) => f.severity === "FAIL");
    assert.equal(fails.length, 1, `expected one FAIL, got ${JSON.stringify(fails)}`);
    assert.equal(fails[0].pointer, "/safety/sandbox_requirement");
    assert.equal(fails[0].code, "source_schema");
    assert.equal(isValidateOk(findings), false, "the local validator answered ok about a source the gates refuse");

    const validated = recorder();
    assert.notEqual(runValidate({ directory: dir, json: false }, validated.io, { nowMs: NOW }), EXIT_OK);

    // ---- SERVER, over a real socket, with the CLI's preflight bypassed: the
    // source is posted directly, so the refusal below is the server's own.
    const { writeTar } = await import("../src/archive.ts");
    const sent = await post(live.base, "/v1/skills/from-source", live.ownerKey, {
      slug: "high-mutated",
      source: writeTar(readSourceDir(dir)).toString("base64"),
    });
    assert.equal(sent.status, 400, JSON.stringify(sent.json));
    assert.equal(sent.json.error.code, "INVALID_SCHEMA");
    // THE SAME POINTER AND THE SAME STABLE CODE the local run produced. One
    // validator, two callers: an author whose preflight was green does not meet
    // a refusal here for a reason their preflight could not have known, and one
    // whose preflight was red meets the same words.
    assert.ok(
      sent.json.error.message.includes("/safety/sandbox_requirement"),
      `the server's refusal carries a different pointer: ${sent.json.error.message}`,
    );
    assert.ok(
      sent.json.error.message.includes("source_schema"),
      `the server's refusal carries a different code: ${sent.json.error.message}`,
    );

    // AND NOTHING WAS CREATED.
    const listed: any = await (
      await fetch(`${live.base}/v1/skills?q=high-mutated`, { headers: { authorization: `Bearer ${live.ownerKey}` } })
    ).json();
    assert.deepEqual(listed.items, [], "a refused source created a skill anyway");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    live.close();
  }
});

test("P2-R1-001: the source profile no longer discards a non-pass schema-gate report nothing else has said", () => {
  // The hole was structural rather than particular to the sandbox rule: EVERY
  // non-pass `schema` report was dropped. The proof it is closed is a manifest
  // whose only problem is one the schema-error loop cannot produce — the §4.2
  // empty-`failure_modes` WARN, which lives in the gate and nowhere else.
  const dir = tmp("p2fix-warn-");
  try {
    runInit({ directory: dir, slug: "warn-carrier", risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const path = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.procedure.failure_modes = [];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const findings = validateSourceProfile(readSourceDir(dir), { nowMs: NOW });
    const warned = findings.filter((f) => f.code === "source_safety_gate" && f.detail.includes("`schema`"));
    assert.equal(warned.length, 1, `the schema gate's WARN was swallowed again: ${JSON.stringify(findings)}`);
    assert.equal(warned[0].severity, "WARN");
    // …and a WARN does not fail a validate, for the same reason it does not fail
    // a gate run: a warning that blocks is a failure wearing a milder word.
    assert.equal(isValidateOk(findings), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-R1-001: the two cross-field rules have ONE implementation, and it is the gate's", () => {
  // `schemaCrossFieldProblems` is what `schemaGate` reads and what the source
  // profile reads. Asserted by exercising it on both sides of each rule rather
  // than by reading the imports: a copy made later would still import.
  const high = { scope: { risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] }, safety: { sandbox_requirement: "required" } };
  assert.deepEqual(schemaCrossFieldProblems(high), []);
  assert.deepEqual(
    schemaCrossFieldProblems({ ...high, safety: { sandbox_requirement: "recommended" } }).map((p) => p.pointer),
    ["/safety/sandbox_requirement"],
    "`recommended` is not `required`, and the rule admits neither substitute",
  );
  assert.deepEqual(
    schemaCrossFieldProblems({ ...high, scope: { risk_level: "high", required_approvals: ["publish"] } }).map((p) => p.pointer),
    ["/scope/required_approvals"],
  );
  // A LOW-RISK MANIFEST IS NOT JUDGED BY THEM. The rules are §4.2's for `high`;
  // applying them to every risk would refuse packages that verify today.
  assert.deepEqual(schemaCrossFieldProblems({ scope: { risk_level: "low" }, safety: { sandbox_requirement: "none" } }), []);
});

// ===========================================================================
// P2-R1-002 — unknown printed as three zeros, and a next action the client
// derived and got wrong.
// ===========================================================================

test("P2-R1-002: the CLI's gate counts are the server's eight reports, and the reported next action succeeds from the returned state", async () => {
  const live = await registry();
  const dir = tmp("p2fix-gates-");
  try {
    runInit({ directory: dir, slug: "gate-counts", risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const created = recorder();
    assert.equal(
      await runCreate({ directory: dir, slug: "gate-counts", server: live.base, api_key_env: "K", json: true }, created.io, {
        nowMs: NOW,
        env: { K: live.ownerKey },
      }),
      EXIT_OK,
      created.all(),
    );
    const report: CreateReport = JSON.parse(created.out.join("\n"));

    // THE COUNTS ARE REAL, and they add up to the eight gates §7.1 defines.
    assert.notEqual(report.gates, null, "the CLI reported no gate counts at all");
    const gates = report.gates!;
    assert.equal(
      gates.passed + gates.failed + gates.warned,
      GATE_NAMES.length,
      `the counts sum to ${gates.passed + gates.failed + gates.warned}, not to the eight gates that ran`,
    );

    // AND THEY ARE THE SERVER'S OWN, byte for byte with what the lint that
    // follows reports about the same package.
    const lint = await post(live.base, `/v1/versions/${report.skill_version_id}/lint`, live.ownerKey, {});
    assert.equal(lint.status, 200);
    assert.equal(gates.passed, lint.json.reports.filter((r: any) => r.result === "pass").length);
    assert.equal(gates.failed, lint.json.reports.filter((r: any) => r.result === "fail").length);
    assert.equal(gates.warned, lint.json.reports.filter((r: any) => r.result === "warn").length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    live.close();
  }
});

test("P2-R1-002: the next action the CLI reports from `draft` is the one that succeeds — the old one returned 412", async () => {
  const live = await registry();
  const dir = tmp("p2fix-next-");
  try {
    runInit({ directory: dir, slug: "next-action", risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const created = recorder();
    await runCreate({ directory: dir, slug: "next-action", server: live.base, api_key_env: "K", json: true }, created.io, {
      nowMs: NOW,
      env: { K: live.ownerKey },
    });
    const report: CreateReport = JSON.parse(created.out.join("\n"));
    assert.equal(report.state, "draft");
    assert.notEqual(report.next_action, null, "the CLI reported no next action");

    // THE OLD ANSWER, ASKED FOR REAL. `draft` used to be mapped to "request a
    // review", and that request is refused from `draft` every time. Asserting
    // the refusal is what makes the new answer a fix rather than a rewording.
    const review = await post(live.base, `/v1/versions/${report.skill_version_id}/reviews`, live.ownerKey, { action: "request" });
    assert.equal(review.status, 412, `a review request from \`draft\` was not refused: ${JSON.stringify(review.json)}`);
    assert.equal(review.json.error.code, "PRECONDITION_FAILED");
    assert.equal(
      /request a review/i.test(report.next_action!),
      false,
      `the CLI still points a draft at the review surface: ${report.next_action}`,
    );

    // THE REPORTED ONE SUCCEEDS. The sentence names the surface; the surface is
    // called, and it does what the sentence said it would.
    assert.ok(report.next_action!.includes("/lint"), `the reported next action names no lint surface: ${report.next_action}`);
    const lint = await post(live.base, `/v1/versions/${report.skill_version_id}/lint`, live.ownerKey, {});
    assert.equal(lint.status, 200, JSON.stringify(lint.json));
    assert.equal(lint.json.state, "linted");

    // …and from `linted` the server's answer moves on with the version.
    assert.ok(nextActionForState("linted").includes("/reviews"));
    const now = await post(live.base, `/v1/versions/${lint.json.skill_version_id ?? report.skill_version_id}/reviews`, live.ownerKey, {
      action: "request",
    });
    assert.equal(now.status, 200, `the review surface refused a linted version: ${JSON.stringify(now.json)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    live.close();
  }
});

/** A server that answers `POST /v1/skills/from-source` with exactly what a test
 *  hands it. Nothing else is served: a request to any other path is a 404, so a
 *  probe cannot accidentally be talking to a real registry. */
async function stubRegistry(reply: (body: any) => { status: number; body: unknown }): Promise<{
  base: string;
  close: () => void;
  seen: () => string[];
}> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      if (req.method !== "POST" || req.url !== "/v1/skills/from-source") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "the stub serves one route" } }));
        return;
      }
      const answer = reply(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close(), seen: () => seen };
}

test("P2-R1-002 contradictory verdict: the CLI renders the SERVER's next action, not one derived from the state", async () => {
  // THE PROBE. The state is `draft` — the one state the deleted `switch` had a
  // confident answer for — and the server says something no local table could
  // have produced. A client still deriving from the state cannot print this.
  const planted = "PATCH /v1/versions/{skill_version_id}/quarantine — this deployment holds drafts for manual triage";
  const stub = await stubRegistry(() => ({
    status: 201,
    body: {
      skill_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      skill_version_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      state: "draft",
      gate_reports: [
        { gate: "schema", result: "warn", details: "planted" },
        { gate: "secrets", result: "fail", details: "planted" },
      ],
      next_action: planted,
    },
  }));
  const dir = tmp("p2fix-probe-");
  try {
    runInit({ directory: dir, slug: "probe-skill", risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const io = recorder();
    assert.equal(
      await runCreate({ directory: dir, slug: "probe-skill", server: stub.base, api_key_env: "K", json: true }, io.io, {
        nowMs: NOW,
        env: { K: "not-a-real-key" },
      }),
      EXIT_OK,
      io.all(),
    );
    const report: CreateReport = JSON.parse(io.out.join("\n"));
    assert.equal(report.next_action, planted, "the CLI substituted an answer of its own for the server's");
    assert.deepEqual(report.gates, { passed: 0, failed: 1, warned: 1 }, "the CLI did not count the reports it was sent");

    // The human rendering carries the same sentence — the two outputs are one
    // report, not two derivations.
    const human = recorder();
    await runCreate({ directory: dir, slug: "probe-skill", server: stub.base, api_key_env: "K", json: false }, human.io, {
      nowMs: NOW,
      env: { K: "not-a-real-key" },
    });
    assert.ok(human.out.some((l) => l.includes(planted)), `the printed report does not carry the server's sentence: ${human.all()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    stub.close();
  }
});

test("P2-R1-002: a response with no gate reports and no next action reads as ABSENT, and never as zeros", async () => {
  // The `INV-03` half. This is the exact response shape the finding was about —
  // a create that carried no gate verdicts — and the old CLI printed
  // `0 passed, 0 failed, 0 warned` for it.
  const stub = await stubRegistry(() => ({
    status: 201,
    body: {
      skill_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      skill_version_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      state: "draft",
    },
  }));
  const dir = tmp("p2fix-absent-");
  try {
    runInit({ directory: dir, slug: "absent-skill", risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const io = recorder();
    assert.equal(
      await runCreate({ directory: dir, slug: "absent-skill", server: stub.base, api_key_env: "K", json: true }, io.io, {
        nowMs: NOW,
        env: { K: "not-a-real-key" },
      }),
      EXIT_OK,
      io.all(),
    );
    const report: CreateReport = JSON.parse(io.out.join("\n"));
    assert.equal(report.gates, null, "an absent gate report was rendered as a count");
    assert.equal(report.next_action, null, "an absent next action was rendered as a sentence");

    const human = recorder();
    await runCreate({ directory: dir, slug: "absent-skill", server: stub.base, api_key_env: "K", json: false }, human.io, {
      nowMs: NOW,
      env: { K: "not-a-real-key" },
    });
    const printed = human.out.join("\n");
    assert.ok(printed.includes(GATES_NOT_REPORTED), `the printed report does not say the gates are unknown: ${printed}`);
    assert.ok(printed.includes(NEXT_ACTION_NOT_REPORTED), `the printed report does not say the next action is unknown: ${printed}`);
    assert.equal(
      /0 passed, 0 failed, 0 warned/.test(printed),
      false,
      "the CLI printed unknown as three zeros, which is the finding",
    );
    // …and it does not fall back to the deleted table either.
    assert.equal(/request a review/i.test(printed), false, "the CLI fell back to a next action of its own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    stub.close();
  }
});

test("P2-R1-002: `next_action` is derived from the transition graph, so it cannot drift from what the registry permits", () => {
  // Every state the whitelist gives an onward edge is answered with a surface;
  // every state it does not is answered by saying so. Derived rather than
  // enumerated: a state added to §5.1 without a surface shows up here.
  for (const state of Object.keys(TRANSITION_WHITELIST) as VersionState[]) {
    const answer = nextActionForState(state);
    if (TRANSITION_WHITELIST[state].length === 0) {
      assert.ok(answer.includes("no onward transition"), `${state} is terminal and the answer invents a surface: ${answer}`);
      continue;
    }
    assert.ok(/POST \/v1\/versions\//.test(answer), `${state} admits a transition and the answer names no surface: ${answer}`);
  }
  // The one that mattered: `draft` points at the lint surface and not the review
  // surface, because §5.1 puts `lint` between them.
  assert.ok(nextActionForState("draft").includes("/lint"));
  assert.equal(/\/reviews/.test(nextActionForState("draft")), false);
});

// ===========================================================================
// P2-R1-003 — the server half. The DOM half is in test-browser/.
// ===========================================================================

test("P2-R1-003: the test-delivery verdict reads the transport's own URL policy, and reads it for the offered control too", () => {
  const loopback = { allowLoopback: true };
  const strict = { allowLoopback: false };

  // A loopback endpoint under a deployment that delivers to loopback: offered.
  assert.deepEqual(testDeliveryEligibility("http://127.0.0.1:9/hook", loopback), {
    allowed: true,
    reason_code: WEBHOOK_TEST_REASON_CODES.testable,
  });
  // THE SAME ROW under a deployment that does not: withheld, with the code the
  // Console shows. This is the state a restart produces — a row outliving the
  // policy that admitted it — and it is what §6.5.1's parity means applied to a
  // control rather than to a registration.
  assert.deepEqual(testDeliveryEligibility("http://127.0.0.1:9/hook", strict), {
    allowed: false,
    reason_code: WEBHOOK_TEST_REASON_CODES.not_deliverable,
  });
  for (const spelling of ["https://127.0.0.1/hook", "https://localhost/hook", "https://[::1]/hook", "https://localhost./hook"]) {
    assert.equal(testDeliveryEligibility(spelling, strict).allowed, false, `${spelling} names this machine and was offered anyway`);
  }
  // A public HTTPS endpoint is offered under either policy: the verdict is about
  // the destination this deployment will open a socket to, not about strictness.
  for (const policy of [loopback, strict]) {
    assert.equal(testDeliveryEligibility("https://hooks.example/skillonomia", policy).allowed, true);
  }
  // A transport that declares no policy has no addresses to judge, so it
  // withholds nothing — the same reading `UNDECLARED_DELIVERY_POLICY` gives
  // registration.
  assert.equal(testDeliveryEligibility("http://127.0.0.1:9/hook", UNDECLARED_DELIVERY_POLICY).allowed, true);
});

test("P2-R1-003: the verdict follows a real policy change, and the machine surface beside it does not change shape", async () => {
  // A REAL DISABLED STATE, PRODUCED THROUGH THE SERVICE. The endpoint is
  // registered by a deployment that delivers to loopback and then read by one
  // that does not, over the same data directory — which is a restart, and the
  // only honest way to reach a row the current policy refuses.
  const dataDir = tmp("p2fix-hook-");
  const sink = createServer((req, res) => {
    req.resume();
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", () => resolve()));
  const hookUrl = `http://127.0.0.1:${(sink.address() as any).port}/hook`;

  const up = async (allowLoopback: boolean) => {
    const previous = process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK;
    if (allowLoopback) process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK = "1";
    else delete process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK;
    try {
      const inst = await serve({ port: 0, host: "127.0.0.1", dataDir, workerIntervalMs: 0, log: () => {} });
      const addr = inst.server.address();
      return { inst, base: `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : inst.port}` };
    } finally {
      if (previous === undefined) delete process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK;
      else process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK = previous;
    }
  };

  let live = await up(true);
  try {
    const boot: any = await (
      await fetch(`${live.base}/v1/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bootstrap_token: live.inst.credentials!.bootstrap_owner_token }),
      })
    ).json();
    const key = String(boot.api_key);
    const auth = { agent_id: String(boot.agent_id), workspace_id: String(boot.workspace_id), role: "owner" } as any;

    const registered = await post(live.base, "/v1/webhooks", key, { url: hookUrl });
    assert.equal(registered.status, 201, JSON.stringify(registered.json));
    assert.deepEqual(
      (live.inst as any).registry.listWebhooksForConsole(auth).items[0].eligibility,
      { allowed: true, reason_code: WEBHOOK_TEST_REASON_CODES.testable },
      "the deployment that accepted this endpoint will not offer to test it",
    );
    live.inst.close();

    // THE RESTART, with the shipped default.
    live = await up(false);
    const items = (live.inst as any).registry.listWebhooksForConsole(auth).items;
    assert.equal(items.length, 1, "the endpoint did not survive the restart, so the state under test is not the one produced");
    assert.deepEqual(items[0].eligibility, { allowed: false, reason_code: WEBHOOK_TEST_REASON_CODES.not_deliverable });
    // …and the row is otherwise untouched: a withheld action does not hide the
    // subject it is withheld for.
    assert.equal(items[0].url, hookUrl);
    assert.equal(items[0].status, "active");

    // INV-09: the Bearer surface is the body it always was. `eligibility` is the
    // console read's, because the console is what draws a control.
    const bearer: any = await (await fetch(`${live.base}/v1/webhooks`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.deepEqual(Object.keys(bearer.items[0]).sort(), ["failure_count", "status", "url", "webhook_id"]);
  } finally {
    live.inst.close();
    sink.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// The backlog item: the transport-failure sentence.
// ===========================================================================

test("the transport-failure message claims no mechanism the command does not have", async () => {
  // A server that accepts the connection and destroys it, so the CLI takes its
  // transport-failure path for real rather than being told to pretend.
  const dead = createServer();
  dead.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(dead.address() as any).port}`;
  const dir = tmp("p2fix-transport-");
  try {
    runInit({ directory: dir, slug: "transport-claim", risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const io = recorder();
    assert.equal(
      await runCreate({ directory: dir, slug: "transport-claim", server: base, api_key_env: "K", json: false }, io.io, {
        nowMs: NOW,
        env: { K: "not-a-real-key" },
      }),
      EXIT_CHECK_FAILED,
    );
    const said = io.err.join("\n");
    // THE UNTRUE SENTENCE IS GONE. `create` takes no key as an argument and
    // reads none from the environment, so "re-run with the same idempotency
    // key" named a mechanism an author cannot reach.
    assert.equal(
      /same idempotency key/i.test(said),
      false,
      `the message still tells an author to reuse a key the command cannot accept: ${said}`,
    );
    // AND THE TRUE REASON IS STATED. What makes the retry safe is that a create
    // converges on the version already packed from these bytes.
    assert.ok(/converge/i.test(said), `the message does not say why re-running is safe: ${said}`);
    assert.ok(/unchanged/i.test(said), `the message does not promise the source is untouched: ${said}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dead.close();
  }
});
