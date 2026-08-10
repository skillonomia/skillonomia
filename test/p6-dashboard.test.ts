// P6 — the dashboard. Internal phase plan, P6 row: "dashboard (library,
// evidence, receipts, approvals, dead letters)", review subject "dashboard shows dead
// letters and failing webhooks". Appendix H's `dashboard.view` row fixes what
// has to hold: the five view names, the ACL scoping, `demo_mode`, and `fields`
// naming "the API fields of the numbered surfaces that the section's `rows`
// carry — the dashboard computes nothing of its own and is a rendering, never a
// second source of truth". What sections a view is CUT into is presentation and
// is deliberately not fixed there, so nothing below asserts a ranking or a
// visual opinion. The `migrations` view came later and is not one of the phase
// plan's five: it is the product surface of the migration counter, and its own
// suite (test/migration-count.test.ts) checks what its numbers mean. What the
// generic assertions here still owe it is everything they owe the others —
// the envelope, the rendered fields, and the ACL it must not widen.
//
// So this suite checks exactly that, plus the one thing a read layer can get
// dangerously wrong: it must not widen the ACL of the reads it composes, and it
// must never surface a webhook secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewedVersion, NOW } from "./p4-helpers.ts";
import { makeManifest } from "./p2-helpers.ts";
import { p4Fixture, rest, mcp, adoptThroughSurfaces, rateThroughSurface, env, type P4Fixture, type BuiltVersion } from "./p6-helpers.ts";
import {
  DASHBOARD_VIEWS,
  renderDashboard,
  renderValue,
  escapeHtml,
  type DashboardPayload,
} from "../src/dashboard.ts";
import { MemorySecretStore, runWorkerOnce, type WebhookRequest, type WebhookResponse, type WebhookTransport } from "../src/webhooks.ts";
import { workerId, MAX_ATTEMPTS } from "../src/delivery.ts";

class DeadTransport implements WebhookTransport {
  readonly sent: WebhookRequest[] = [];
  send(req: WebhookRequest): WebhookResponse {
    this.sent.push(req);
    return { status: 500, error: "receiver refused the push" };
  }
}

interface Fixture {
  fx: P4Fixture;
  secrets: MemorySecretStore;
  version: BuiltVersion;
  held: BuiltVersion;
  receiptId: string;
  heldRequestId: string;
  deadRequestId: string;
  webhookId: string;
  secret: string;
}

/**
 * One graph exercising every view, built through the surfaces: a validated
 * adoption + rating, a §7.3 hold with a recorded decision, and a dead-lettered
 * request whose endpoint died under §5.2's endpoint-health rules.
 */
async function fixture(): Promise<Fixture> {
  const secrets = new MemorySecretStore();
  const fx = p4Fixture({ secrets });
  // seedGraph ships one pending request with no endpoint; park it so the
  // worker below only ever touches this test's own job
  fx.db.prepare("UPDATE adoption_requests SET state='pushed' WHERE id=?").run(fx.seed.request);

  const version = reviewedVersion(fx, "dash-adopted");
  const run = adoptThroughSurfaces(fx, version, fx.keys.member);
  rateThroughSurface(fx, version, fx.keys.member, run.receiptId, 5);

  // a high-risk version: its request is HELD for a §7.3 human approval (§5.2)
  const base = makeManifest({});
  const held = reviewedVersion(fx, "dash-held", {
    manifest: {
      scope: { ...base.scope, risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] },
      safety: { ...base.safety, sandbox_requirement: "required" },
    },
  });
  const heldReq = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: held.versionId });
  assert.equal(heldReq.body.state, "approval_pending", heldReq.raw);
  // a SECOND request on the same version, approved, so the decisions table is
  // populated while the hold above stays open
  const otherReq = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.admin, { skill_version_id: held.versionId });
  const approved = rest(fx, "POST", `/v1/versions/${held.versionId}/approvals`, fx.keys.admin, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: otherReq.body.adoption_request_id,
    note: "sandboxed rollout approved",
  });
  assert.equal(approved.status, 201, approved.raw);

  // an endpoint that fails until it is `dead`, and a request that dead-letters
  const registered = rest(fx, "POST", "/v1/webhooks", fx.keys.reviewer, { url: "https://hooks.example/skillonomia" });
  assert.equal(registered.status, 201, registered.raw);
  const deadReq = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.reviewer, { skill_version_id: version.versionId });
  const transport = new DeadTransport();
  const worker = workerId(NOW);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await runWorkerOnce(fx.db, secrets, transport, worker, NOW + i * 120_000);
  }
  return {
    fx,
    secrets,
    version,
    held,
    receiptId: run.receiptId,
    heldRequestId: heldReq.body.adoption_request_id,
    deadRequestId: deadReq.body.adoption_request_id,
    webhookId: registered.body.webhook_id,
    secret: registered.body.secret,
  };
}

function view(fx: P4Fixture, name: string, key: string, query = ""): DashboardPayload {
  const res = rest(fx, "GET", `/v1/dashboard/${name}${query}`, key);
  assert.equal(res.status, 200, res.raw);
  return res.body as DashboardPayload;
}

/**
 * THE ANSWER PART OF A CELL.
 *
 * Every row value of every view is now a CELL — an answer followed by its
 * method — because [I-1] and [I-3] are invariants over all eleven views and the
 * first six used to put raw values into rows: a null rendered as `—`, and a
 * count rendered as a bare figure with no state, source or boundary. The
 * assertions below therefore compare ANSWERS, and the method that travels with
 * each one is swept separately by `auditRenderedHtml`.
 */
function answer(cell: unknown): string {
  const text = String(cell ?? "");
  const i = text.indexOf(" · ");
  return (i < 0 ? text : text.slice(0, i)).trim();
}

function rowsOf(p: DashboardPayload, key: string): Array<Record<string, any>> {
  const s = p.sections.find((x) => x.key === key);
  assert.ok(s, `section ${key} exists`);
  return s!.rows;
}

// ------------------------------------------------------------ the views exist

test("the dashboard is exactly the named views, on both adapters", async () => {
  const f = await fixture();
  // the phase plan's five, the migration counter, then §9's five screens
  const NAMES = [
    "library",
    "evidence",
    "receipts",
    "approvals",
    "dead_letters",
    "migrations",
    "fleet",
    "agent",
    "skill_approval",
    "capability",
    "outcomes",
  ];
  assert.deepEqual([...DASHBOARD_VIEWS], NAMES);
  const index = rest(f.fx, "GET", "/v1/dashboard", f.fx.keys.owner);
  assert.equal(index.status, 200);
  assert.deepEqual(index.body.views, NAMES);
  for (const name of DASHBOARD_VIEWS) {
    const payload = view(f.fx, name, f.fx.keys.owner);
    assert.equal(payload.view, name);
    assert.ok(payload.sections.length >= 1, `${name} has at least one section`);
    const viaMcp = mcp(f.fx, f.fx.keys.owner, "dashboard.view", { view: name });
    assert.equal(viaMcp.isError, false);
    assert.deepEqual(viaMcp.data, payload, `${name}: the adapters serve one payload`);
  }
  const bad = rest(f.fx, "GET", "/v1/dashboard/not-a-view", f.fx.keys.owner);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "INVALID_SCHEMA");
  const noAuth = rest(f.fx, "GET", "/v1/dashboard/library", "sk_not_a_key");
  assert.equal(noAuth.status, 401);
  f.fx.db.close();
});

// --------------------------------------- "render the corresponding API fields"

test("every view RENDERS every declared API field of every row it returns", async () => {
  const f = await fixture();
  for (const name of DASHBOARD_VIEWS) {
    const payload = view(f.fx, name, f.fx.keys.owner);
    const html = renderDashboard(payload);
    let rendered = 0;
    for (const section of payload.sections) {
      for (const field of section.fields) {
        assert.ok(html.includes(`<th>${escapeHtml(field)}</th>`), `${name}/${section.key}: column ${field}`);
      }
      for (const row of section.rows) {
        for (const field of section.fields) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(row, field),
            `${name}/${section.key}: row is missing declared field ${field}`,
          );
          assert.ok(
            html.includes(`<td>${escapeHtml(renderValue(row[field]))}</td>`),
            `${name}/${section.key}: value of ${field} is not on the page`,
          );
          rendered++;
        }
      }
    }
    assert.ok(rendered > 0, `${name} rendered no data at all`);
  }
  f.fx.db.close();
});

test("?format=html serves the same payload as HTML, and MCP can ask for it too", async () => {
  const f = await fixture();
  const res = rest(f.fx, "GET", "/v1/dashboard/library?format=html", f.fx.keys.owner);
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /^text\/html/);
  assert.match(res.raw, /^<!doctype html>/);
  assert.ok(res.raw.includes("dash-adopted"), "the library page names the skill");
  const json = view(f.fx, "library", f.fx.keys.owner);
  assert.equal(res.raw, renderDashboard(json), "the HTML is a rendering of the JSON payload, not a second source");
  const viaMcp = mcp(f.fx, f.fx.keys.owner, "dashboard.view", { view: "library", format: "html" });
  assert.equal(viaMcp.data.html, res.raw);
  f.fx.db.close();
});

// --------------------------------------------------------------- per-view data

test("library: the search item's own fields, Reputation included", async () => {
  const f = await fixture();
  const payload = view(f.fx, "library", f.fx.keys.member);
  const row = rowsOf(payload, "library").find((r) => r.slug === "dash-adopted");
  assert.ok(row, "the adopted version is in the library");
  const item = rest(f.fx, "GET", "/v1/skills?q=dash-adopted", f.fx.keys.member).body.items[0];
  assert.equal(row!.skill_version_id, item.skill_version_id);
  assert.equal(row!.state, item.state);
  assert.equal(answer(row!.adopted_count), String(item.registry.reputation.adopted_count));
  assert.equal(answer(row!.adopted_count), "1");
  assert.equal(answer(row!.avg_rating), "5");
  assert.equal(answer(row!.adoption_attempts), String(item.registry.reputation.adoption_attempts));
  // …and each of those figures carries its method [I-3]
  for (const f of ["adopted_count", "avg_rating", "adoption_attempts", "failed_count", "rolled_back_count"]) {
    assert.match(String(row![f]), /kind: measured_number/, `${f} is published as a number cell`);
  }
  // the view is a read layer: the same search filters narrow it
  const filtered = view(f.fx, "library", f.fx.keys.member, "?q=dash-held");
  assert.deepEqual(
    rowsOf(filtered, "library").map((r) => r.slug),
    ["dash-held"],
  );
  f.fx.db.close();
});

test("evidence: the server-validated gate results behind each adopted receipt", async () => {
  const f = await fixture();
  const rows = rowsOf(view(f.fx, "evidence", f.fx.keys.member, "?q=dash-adopted"), "evidence");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receipt_id, f.receiptId);
  assert.equal(rows[0].adopter_agent_id, f.fx.member.agent_id);
  assert.equal(answer(rows[0].gate_results), "g1=pass");
  assert.equal(answer(rows[0].event_seq), "3", "delivered → attempted → adopted");
  // a version without a validated adoption contributes no evidence row
  assert.deepEqual(rowsOf(view(f.fx, "evidence", f.fx.keys.member, "?q=dash-held"), "evidence"), []);
  f.fx.db.close();
});

test("receipts: the chain in event_seq order, with the delivery request's state", async () => {
  const f = await fixture();
  const rows = rowsOf(view(f.fx, "receipts", f.fx.keys.member), "receipts");
  const row = rows.find((r) => r.receipt_id === f.receiptId);
  assert.ok(row, "the adopter sees their own receipt");
  assert.equal(row!.derived_state, "adopted");
  assert.match(answer(row!.stalled), /^no —/, "[I-1]: a boolean is a sentence, never a bare `false`");
  assert.deepEqual(
    answer(row!.events)
      .split(" | ")
      .map((e) => e.split(": ")[1]!.split(" at ")[0]),
    ["delivered", "attempted", "adopted"],
  );
  const api = rest(f.fx, "GET", `/v1/receipts/${f.receiptId}`, f.fx.keys.member).body;
  assert.equal(row!.derived_state, api.derived_state, "the view shows the receipt-read API's own fields");
  assert.equal(row!.adoption_request_id, api.adoption_request_id);
  f.fx.db.close();
});

test("approvals: the §7.3 hold with its matrix conditions, and the recorded decision", async () => {
  const f = await fixture();
  const payload = view(f.fx, "approvals", f.fx.keys.admin);
  const hold = rowsOf(payload, "holds").find((r) => r.adoption_request_id === f.heldRequestId);
  assert.ok(hold, "the held request is visible to the workspace admin");
  assert.equal(hold!.state, "approval_pending");
  assert.equal(answer(hold!.conditions), "risk_high");
  assert.equal(hold!.slug, "dash-held");

  const decision = rowsOf(payload, "decisions")[0];
  assert.equal(decision.scope, "adopt_high_risk");
  assert.equal(decision.decision, "approved");
  assert.equal(answer(decision.note), "sandboxed rollout approved");
  // [I-5]: WHO, and WHAT KIND OF PRINCIPAL. `approved by the workspace owner in
  // person` and `approved by an agent holding a role` are different facts, and
  // this view used to publish an opaque id that told a reader neither.
  const approver = String(decision.approved_by);
  console.log(`[I-5] approvals/decisions approved_by → ${approver.slice(0, 120)}`);
  assert.match(approver, new RegExp(f.fx.admin.agent_id));
  assert.match(approver, /type: human/);
  assert.match(approver, /role: admin/);
  assert.match(approver, /principal: role_holder \(admin\)/);
  f.fx.db.close();
});

test("dead letters: the loud §5.2 row AND the endpoint health that explains it", async () => {
  const f = await fixture();
  const payload = view(f.fx, "dead_letters", f.fx.keys.reviewer);
  const dl = rowsOf(payload, "dead_letters").find((r) => r.adoption_request_id === f.deadRequestId);
  assert.ok(dl, "the dead-lettered request is visible to its adopter");
  assert.equal(answer(dl!.reason), "max_attempts");
  assert.equal(answer(dl!.attempt_count), String(MAX_ATTEMPTS));
  assert.equal(dl!.slug, "dash-adopted");

  const hook = rowsOf(payload, "webhook_health").find((r) => r.webhook_id === f.webhookId);
  assert.ok(hook, "the endpoint's health is on the same view");
  assert.equal(hook!.status, "dead", "five consecutive failures kill the endpoint (§5.2)");
  assert.equal(answer(hook!.failure_count), String(MAX_ATTEMPTS));
  assert.match(String(hook!.last_error), /receiver refused the push/);
  assert.equal(hook!.url, "https://hooks.example/skillonomia");

  // and the same numbers the webhook API itself serves
  const api = rest(f.fx, "GET", "/v1/webhooks", f.fx.keys.reviewer).body.items[0];
  assert.equal(hook!.status, api.status);
  assert.equal(answer(hook!.failure_count), String(api.failure_count));
  f.fx.db.close();
});

test("a FAILING (not yet dead) endpoint is shown as failing — the health rule is visible mid-way", async () => {
  const f = await fixture();
  const registered = rest(f.fx, "POST", "/v1/webhooks", f.fx.keys.botAdmin, { url: "https://hooks.example/second" });
  rest(f.fx, "POST", "/v1/adoptions/requests", f.fx.keys.botAdmin, { skill_version_id: f.version.versionId });
  const transport = new DeadTransport();
  await runWorkerOnce(f.fx.db, f.secrets, transport, workerId(NOW), NOW);
  const hook = rowsOf(view(f.fx, "dead_letters", f.fx.keys.botAdmin), "webhook_health").find(
    (r) => r.webhook_id === registered.body.webhook_id,
  );
  assert.equal(hook!.status, "failing");
  assert.equal(answer(hook!.failure_count), "1");
  f.fx.db.close();
});

// ------------------------------------------------------------------- the ACLs

test("the dashboard does not widen any ACL it composes", async () => {
  const f = await fixture();
  // a plain member is not party to the reviewer's dead-lettered request
  const memberDl = rowsOf(view(f.fx, "dead_letters", f.fx.keys.member), "dead_letters");
  assert.ok(!memberDl.some((r) => r.adoption_request_id === f.deadRequestId), "another adopter's dead letter is hidden");
  // …and does not see the reviewer's endpoints
  assert.deepEqual(rowsOf(view(f.fx, "dead_letters", f.fx.keys.member), "webhook_health"), []);
  // the workspace admin does (§6: admins manage grants/memberships/webhooks)
  assert.ok(
    rowsOf(view(f.fx, "dead_letters", f.fx.keys.admin), "webhook_health").some((r) => r.webhook_id === f.webhookId),
  );

  // receipts: the reviewer never sees the member's chain
  const reviewerReceipts = rowsOf(view(f.fx, "receipts", f.fx.keys.reviewer), "receipts");
  assert.ok(!reviewerReceipts.some((r) => r.receipt_id === f.receiptId), "another adopter's receipt is hidden");
  assert.ok(rowsOf(view(f.fx, "receipts", f.fx.keys.owner), "receipts").some((r) => r.receipt_id === f.receiptId), "the skill owner reads it");

  // A CROSS-WORKSPACE ACTOR SEES NOTHING OF THIS WORKSPACE.
  //
  // For the six P6 views that is literally no row at all. §9's five screens are
  // scoped to the READER'S OWN workspace and its own principals, so the outsider
  // — a member of wsB — legitimately sees THEMSELVES on the fleet and agent
  // screens, and would see their own versions if they had any. Asserting "no
  // rows" there would assert something false about the product; asserting
  // "nothing of wsA" is both true and the property the ACL is actually for, so
  // that is what is checked, over the JSON AND over the rendered page.
  const P6_VIEWS = ["library", "evidence", "receipts", "approvals", "dead_letters", "migrations"] as const;
  const wsAIdentifiers = [
    ...(f.fx.db.prepare("SELECT id FROM agents WHERE workspace_id=?").all(f.fx.seed.wsA) as Array<{ id: string }>).map(
      (r) => r.id,
    ),
    ...(f.fx.db.prepare("SELECT slug FROM skills WHERE workspace_id=?").all(f.fx.seed.wsA) as Array<{ slug: string }>).map(
      (r) => r.slug,
    ),
    f.receiptId,
    f.deadRequestId,
    f.heldRequestId,
    f.version.versionId,
    f.held.versionId,
  ];
  assert.ok(wsAIdentifiers.length > 8, "the leak sweep must have something to look for");
  for (const name of DASHBOARD_VIEWS) {
    const payload = view(f.fx, name, f.fx.keys.outsider);
    if ((P6_VIEWS as readonly string[]).includes(name)) {
      for (const section of payload.sections) {
        assert.deepEqual(section.rows, [], `${name}/${section.key} leaked to a cross-workspace actor`);
      }
    }
    const raw = rest(f.fx, "GET", `/v1/dashboard/${name}`, f.fx.keys.outsider).raw;
    const html = rest(f.fx, "GET", `/v1/dashboard/${name}?format=html`, f.fx.keys.outsider).raw;
    for (const id of wsAIdentifiers) {
      assert.ok(!raw.includes(id), `${name}: the JSON carries wsA's ${id} to a cross-workspace actor`);
      assert.ok(!html.includes(id), `${name}: the page carries wsA's ${id} to a cross-workspace actor`);
    }
  }
  // …and on the §9 screens the outsider sees exactly one principal: themselves
  const outsiderFleet = rowsOf(view(f.fx, "fleet", f.fx.keys.outsider), "fleet");
  assert.equal(outsiderFleet.length, 1, "a plain member reads one principal: their own");
  assert.ok(String(outsiderFleet[0].agent).includes(f.fx.outsider.agent_id));
  f.fx.db.close();
});

test("no dashboard response or page can carry a webhook secret (Appendix H)", async () => {
  const f = await fixture();
  const hashes = f.fx.db.prepare("SELECT secret_hash, secret_ref FROM webhooks").all() as Array<{
    secret_hash: string;
    secret_ref: string | null;
  }>;
  assert.ok(f.secret.length > 0, "registration returned the plaintext exactly once");
  for (const name of DASHBOARD_VIEWS) {
    for (const key of [f.fx.keys.owner, f.fx.keys.admin, f.fx.keys.reviewer]) {
      const res = rest(f.fx, "GET", `/v1/dashboard/${name}`, key);
      const html = rest(f.fx, "GET", `/v1/dashboard/${name}?format=html`, key).raw;
      for (const blob of [res.raw, html]) {
        assert.ok(!blob.includes(f.secret), `${name}: the plaintext secret is on the page`);
        assert.ok(!blob.includes("secret_ref"), `${name}: the secret ref is on the page`);
        assert.ok(!blob.includes("secret_hash"), `${name}: the secret hash is on the page`);
        for (const h of hashes) {
          assert.ok(!blob.includes(h.secret_hash), `${name}: a secret hash value is on the page`);
          if (h.secret_ref) assert.ok(!blob.includes(h.secret_ref), `${name}: a secret ref value is on the page`);
        }
      }
    }
  }
  f.fx.db.close();
});

test("rendering escapes hostile field values instead of emitting them as markup", async () => {
  const f = await fixture();
  const payload: DashboardPayload = {
    view: "library",
    title: "Library",
    views: DASHBOARD_VIEWS,
    demo_mode: false,
    notices: [],
    sections: [
      {
        key: "library",
        title: "t",
        fields: ["slug"],
        rows: [{ slug: `<script>alert("x")</script>` }],
        empty: "none",
      },
    ],
  };
  const html = renderDashboard(payload);
  assert.ok(!html.includes("<script>"), "no raw markup from data");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(renderValue(null), "—");
  assert.equal(renderValue([]), "—");
  assert.equal(renderValue(["a", "b"]), "a, b");
  assert.equal(renderValue(false), "false");
  f.fx.db.close();
});

test("an empty view is still a rendered view (the P6 acceptance item is the fields, not the rows)", () => {
  const fx = p4Fixture();
  const payload = view(fx, "dead_letters", fx.keys.member);
  for (const section of payload.sections) {
    assert.deepEqual(section.rows, []);
    assert.ok(section.empty.length > 0);
  }
  const html = renderDashboard(payload);
  assert.ok(html.includes("<th>reason</th>"), "the dead-letter columns are declared even when empty");
  assert.ok(html.includes("<th>status</th>"), "so is webhook health");
  assert.ok(html.includes(escapeHtml(payload.sections[0].empty)));
  assert.equal(env().os, "linux");
  fx.db.close();
});

test("the paged views carry the Appendix H cursor, and it walks them", async () => {
  const f = await fixture();
  const page1 = view(f.fx, "library", f.fx.keys.owner, "?limit=1");
  const section = page1.sections[0];
  assert.equal(section.rows.length, 1);
  assert.ok(section.next_cursor, "a paged section returns the cursor to continue with");
  const page2 = view(f.fx, "library", f.fx.keys.owner, `?limit=1&cursor=${encodeURIComponent(section.next_cursor!)}`);
  assert.notEqual(page2.sections[0].rows[0].skill_version_id, section.rows[0].skill_version_id);
  // the unpaged views declare no cursor rather than an unusable one
  const dl = view(f.fx, "dead_letters", f.fx.keys.owner);
  for (const s of dl.sections) assert.equal(s.next_cursor, undefined);
  f.fx.db.close();
});

test("P6 verdict 1: an unrecognised `format` is INVALID_SCHEMA on BOTH adapters, never a silent JSON page", async () => {
  const f = await fixture();
  for (const bad of ["wat", "HTML", "text", "", "html "]) {
    const viaRest = rest(f.fx, "GET", `/v1/dashboard/library?format=${encodeURIComponent(bad)}`, f.fx.keys.member);
    assert.equal(viaRest.status, 400, `REST accepted format=${JSON.stringify(bad)}`);
    assert.equal(viaRest.body.error.code, "INVALID_SCHEMA");
    const viaMcp = mcp(f.fx, f.fx.keys.member, "dashboard.view", { view: "library", format: bad });
    assert.equal(viaMcp.isError, true, `MCP accepted format=${JSON.stringify(bad)}`);
    assert.equal(viaMcp.data.error.code, viaRest.body.error.code, "the adapters give the same code");
    assert.equal(viaMcp.data.error.message, viaRest.body.error.message, "…and the same message");
  }
  // a non-string value is refused identically (MCP is the only adapter that can carry one)
  for (const bad of [1, true, {}, []]) {
    const viaMcp = mcp(f.fx, f.fx.keys.member, "dashboard.view", { view: "library", format: bad });
    assert.equal(viaMcp.isError, true, `MCP accepted format=${JSON.stringify(bad)}`);
    assert.equal(viaMcp.data.error.code, "INVALID_SCHEMA");
  }
  // …and the two RECOGNISED values still work, on both adapters
  const restJson = rest(f.fx, "GET", "/v1/dashboard/library?format=json", f.fx.keys.member);
  assert.equal(restJson.status, 200);
  assert.deepEqual(restJson.body, view(f.fx, "library", f.fx.keys.member));
  assert.deepEqual(
    mcp(f.fx, f.fx.keys.member, "dashboard.view", { view: "library", format: "json" }).data,
    restJson.body,
  );
  const restHtml = rest(f.fx, "GET", "/v1/dashboard/library?format=html", f.fx.keys.member);
  assert.match(restHtml.headers["Content-Type"], /^text\/html/);
  assert.equal(mcp(f.fx, f.fx.keys.member, "dashboard.view", { view: "library", format: "html" }).data.html, restHtml.raw);
  f.fx.db.close();
});
