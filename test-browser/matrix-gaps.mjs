// THE §7 CELL THE PHASE SWEEP FOUND UNCOVERED.
//
// HOW IT WAS FOUND. Closing P2 meant walking the §7 matrix cell by cell against
// the gates that exist, rather than against the gate names, and one `R` cell had
// no test behind it: `empty never-had-any` × **Approval Inbox**.
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
import { test, newContext, signIn } from "./lib/harness.mjs";
import { startServer, api, mintTicket, consoleReader } from "./lib/fixture.mjs";
import { settledRegion } from "./lib/decisions.mjs";
import { APPROVALS_TEXT } from "../src/console-surfaces.ts";

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
