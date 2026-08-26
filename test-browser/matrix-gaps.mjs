// THE §7 CELLS `withDecisions` CANNOT REACH.
//
// HOW THE FIRST WAS FOUND. Closing P2 meant walking the §7 matrix cell by cell
// against the gates that exist, rather than against the gate names, and one `R`
// cell had no test behind it: `empty never-had-any` × **Approval Inbox**.
// `test-browser/decision-states.mjs` covers that row for the Webhook column —
// its trigger is a deployment that never registered an endpoint — and the matrix
// marks the cell `R` for the Approval Inbox as well.
//
// WHY IT WAS MISSED, which is the part worth writing down. Every gate in
// `test-browser/decisions.mjs` and `test-browser/decision-states.mjs` runs
// through `withDecisions`, and `withDecisions` always drives the high-risk
// journey so that there is something to decide. An inbox that never had an item
// is therefore unreachable from that harness by construction — not by oversight
// in any one test, but because the fixture every decision gate shares makes the
// state impossible. The state needs a deployment that was bootstrapped and left
// alone, which is what this file builds.
//
// `never-had-any` IS NOT `filtered-to-zero`, and the difference is the whole
// point of the row: one says "nothing has ever happened here and here is what to
// do first", the other says "your filter matched nothing and here is how to
// clear it". A page that answered the first with the second would be telling a
// new operator to undo a filter they never set.
//
// THE SECOND CELL, and REVIEW-1 found this one: `disabled` × **Webhook flow**.
// The matrix marks it `R`, and the server was omitting the contract the row is
// about — the rows of `GET /v1/console/webhooks` carried no `eligibility` at all,
// so the browser had nothing to withhold the test-delivery control on and drew it
// unconditionally. A missing implementation is a gap, not an unreachable state:
// reading it as `N/A` would turn every omitted requirement into `N/A`.
//
// IT BELONGS HERE FOR THE SAME REASON THE FIRST DOES. The verdict this row needs
// is `{allowed:false}` on a real row, and the only honest way to reach one is a
// deployment whose endpoint OUTLIVED the policy that admitted it: `http://` to
// loopback is registerable while `SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK` is set and
// is refused after a restart without it. `withDecisions` starts exactly one
// server, with the flag on, and holds it for the life of the gate — so the state
// is unreachable from that harness by construction, exactly as the empty inbox
// is. This file starts two, over one data directory.
import { test, newContext, signIn } from "./lib/harness.mjs";
import { startServer, api, mintTicket, consoleReader, startRefusingEndpoint, tempDataDir } from "./lib/fixture.mjs";
import { settledRegion } from "./lib/decisions.mjs";
import { APPROVALS_TEXT, webhookTestWithheldDetail } from "../src/console-surfaces.ts";
import { WEBHOOK_TEST_REASON_CODES } from "../src/webhooks.ts";

test("§7 empty never-had-any · TRIGGER: an inbox in a workspace where no approval was ever asked for; the first valid action is offered", async ({ assert }) => {
  // `installSeedPackage: false` is a real deployment's choice, and the only way
  // to reach a workspace where no approval has ever existed: the shipped seed
  // package arrives already decided, so a seeded registry holds an approval row
  // from its first second.
  const fx = await startServer({ allowLoopback: true, installSeedPackage: false });
  let ctx = null;
  try {
    // A DEPLOYMENT THAT WAS BOOTSTRAPPED AND LEFT ALONE. No skill is authored,
    // nothing is published and nothing is adopted, so no approval has ever
    // existed here — which is what the row's trigger asks for and what no other
    // gate in this suite can produce.
    const exchanged = await api(fx.base, "POST", "/v1/auth/bootstrap", undefined, {
      bootstrap_token: fx.inst.credentials.bootstrap_owner_token,
    });
    const ownerKey = exchanged.body?.api_key;
    if (typeof ownerKey !== "string") throw new Error(`no owner key: ${JSON.stringify(exchanged.body)}`);

    // THE BACKEND IS ASKED FIRST, so "empty" is a fact about the registry and
    // not about whether the page managed to draw anything.
    const reader = await consoleReader(fx.base, ownerKey);
    const backend = await reader.raw("/v1/console/approvals?status=all&kind=all");
    assert.equal(backend.status, 200, `the inbox surface answered ${backend.status}`);
    assert.deepEqual(backend.body.items, [], "the bootstrap-only deployment already holds an approval item");

    ctx = await newContext(fx.base);
    const page = await signIn(ctx.context, fx.base, await mintTicket(fx.base, ownerKey));

    assert.equal(await settledRegion(page, "approvals"), "empty", "the inbox did not settle into its empty state");
    assert.equal(await page.$eval("#approvals", (b) => b.dataset.items), "0");

    // IT SAYS SO, in the declared words. A blank region is not an empty state:
    // an operator cannot tell it apart from a region that failed to load.
    const text = await page.$eval("#approvals", (b) => b.textContent ?? "");
    assert.ok(
      text.includes(APPROVALS_TEXT.empty),
      `an inbox that never had an item says nothing about being empty: ${JSON.stringify(text.slice(0, 200))}`,
    );

    // AND IT IS NOT THE FILTERED-TO-ZERO ANSWER. There is no filter set, so a
    // clear-filter action here would be telling the operator to undo something
    // they never did.
    assert.equal(await page.$("#approvals [data-action=\"clear-filter\"]"), null, "an inbox that was never filtered offers a clear-filter action");

    // THE FIRST VALID ACTION IS PRESENT AND ENABLED.
    const action = await page.$eval("#approvals [data-action=\"reload\"]", (b) => ({
      text: b.textContent,
      disabled: b.disabled === true,
    }));
    assert.equal(action.text, APPROVALS_TEXT.empty_action);
    assert.equal(action.disabled, false, "the first valid action on an empty inbox is offered disabled");

    // NOTHING WAS MUTATED BY LOOKING. The registry is still the one that was
    // bootstrapped and left alone.
    const after = await reader.raw("/v1/console/approvals?status=all&kind=all");
    assert.deepEqual(after.body.items, [], "reading an empty inbox created an approval item");
  } finally {
    if (ctx !== null) await ctx.context.close();
    fx.close();
  }
});

// ===========================================================================
// disabled × Webhook flow — server {allowed:false, reason_code}; exact reason
// visible; no control, and no request issued
// ===========================================================================

test("§7 disabled · TRIGGER: an endpoint this deployment will no longer deliver to; the server's own reason and no test-delivery control", async ({ assert }) => {
  // ONE DATA DIRECTORY, TWO DEPLOYMENTS. The row is registered by a process that
  // delivers to loopback and read by a process that does not, which is a
  // restart — and is the only way to hold a row today's policy refuses without
  // writing one into SQLite by hand.
  const dataDir = tempDataDir();
  const receiver = await startRefusingEndpoint();
  let fx = await startServer({ dataDir, allowLoopback: true });
  let ctx = null;
  // `fx.close()` REMOVES THE DATA DIRECTORY, which is right for a gate that owns
  // one and wrong for the first half of a restart. The first deployment is
  // stopped with `inst.close()`; the directory is removed once, at the end.
  const auditRows = () =>
    fx.inst.db
      .prepare("SELECT actor_agent_id, action, subject_id, details_json FROM activity_log WHERE action='webhook.test' ORDER BY id")
      .all();
  try {
    const exchanged = await api(fx.base, "POST", "/v1/auth/bootstrap", undefined, {
      bootstrap_token: fx.inst.credentials.bootstrap_owner_token,
    });
    const ownerKey = exchanged.body?.api_key;
    if (typeof ownerKey !== "string") throw new Error(`no owner key: ${JSON.stringify(exchanged.body)}`);

    const registered = await api(fx.base, "POST", "/v1/webhooks", ownerKey, { url: receiver.url });
    assert.equal(registered.status, 201, `the endpoint did not register: ${JSON.stringify(registered.body)}`);
    const webhookId = registered.body.webhook_id;
    fx.inst.close();

    // THE RESTART, with the shipped default. `startServer` restores the flag it
    // sets, so a deployment started without `allowLoopback` is the ordinary one.
    fx = await startServer({ dataDir });
    const reader = await consoleReader(fx.base, ownerKey);

    // THE BACKEND IS ASKED FIRST, so "refused" is a fact about the registry and
    // not about what the page managed to draw.
    const backend = await reader.raw("/v1/console/webhooks");
    assert.equal(backend.status, 200, `the webhook surface answered ${backend.status}`);
    const row = backend.body.items.find((i) => i.webhook_id === webhookId);
    assert.ok(row, `the endpoint did not survive the restart: ${JSON.stringify(backend.body.items)}`);
    assert.equal(row.eligibility.allowed, false, "the deployment that refuses this destination still offers to test it");
    assert.equal(row.eligibility.reason_code, WEBHOOK_TEST_REASON_CODES.not_deliverable);

    ctx = await newContext(fx.base);
    const page = await signIn(ctx.context, fx.base, await mintTicket(fx.base, ownerKey));
    assert.equal(await settledRegion(page, "webhooks"), "loaded");

    // NO REQUEST MAY BE ISSUED. Counted at the route rather than inferred from
    // the absence of a result panel: a page that sent the request and hid the
    // answer would be indistinguishable from one that sent nothing.
    let testCalls = 0;
    await page.route(/\/v1\/console\/webhooks\/[^/]+\/test$/, async (route) => {
      testCalls += 1;
      await route.continue();
    });
    const auditBefore = auditRows();

    // THE SERVER'S VERDICT, ON THE ROW.
    const dom = await page.$eval(`#webhook-rows tr[data-webhook-id="${webhookId}"]`, (r) => ({
      allowed: r.dataset.allowed,
      reason: r.dataset.reasonCode,
      url: r.children[1]?.textContent,
      status: r.querySelector('[data-health="status"]')?.textContent,
    }));
    assert.equal(dom.allowed, "false", "the row does not carry the server's verdict");
    assert.equal(dom.reason, row.eligibility.reason_code, "the exact reason code the server sent is not the one on the row");

    // THE EXACT REASON IS VISIBLE, in the server's own vocabulary and not in
    // words this page invented for it.
    const withheld = await page.$eval(`#webhook-rows tr[data-webhook-id="${webhookId}"] [data-withheld]`, (n) => ({
      reason: n.dataset.reasonCode,
      text: n.textContent ?? "",
    }));
    assert.equal(withheld.reason, row.eligibility.reason_code);
    assert.equal(withheld.text, webhookTestWithheldDetail(row.eligibility.reason_code));
    assert.ok(withheld.text.includes(WEBHOOK_TEST_REASON_CODES.not_deliverable), "the server's own code is not on the page");

    // AND THERE IS NO CONTROL. Not a greyed one — none.
    assert.equal(
      await page.$(`button[data-action="test-webhook"][data-webhook-id="${webhookId}"]`),
      null,
      "a test-delivery control was offered for an endpoint the server will not deliver to",
    );
    assert.equal((await page.$$('#webhooks button[data-action="test-webhook"]')).length, 0);

    // THE FACTS ARE STILL THERE. A withheld control does not hide the subject it
    // is withheld for — an operator has to be able to see WHICH endpoint this is
    // in order to repair or replace it.
    assert.equal(dom.url, receiver.url);
    assert.equal(dom.status, row.status);
    // NO REQUEST WAS ISSUED, and the endpoint itself was never contacted.
    assert.equal(testCalls, 0, `${testCalls} test-delivery request(s) reached the registry from a page that offers no control`);
    assert.equal(receiver.hits(), 0, "a push left the process for an endpoint no control was offered for");
    const auditAfter = auditRows();

    // BACKEND AND AUDIT ROWS, BEFORE AND AFTER. Reading the page changed neither
    // the endpoint the registry holds nor the registry's record of what was
    // attempted — §6.5.2 writes one `webhook.test` activity row per test, so an
    // empty set on both sides is the statement that no test happened.
    const after = await reader.raw("/v1/console/webhooks");
    assert.deepEqual(after.body.items, backend.body.items, "rendering the withheld control changed the registry's rows");
    assert.deepEqual(auditAfter, auditBefore, "an audit row was written for a test delivery that never happened");
    assert.deepEqual(auditAfter, [], "the restarted deployment already holds a webhook.test audit row");
  } finally {
    if (ctx !== null) await ctx.context.close();
    fx.close();
    receiver.close();
  }
});
