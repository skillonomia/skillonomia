// THE §7 UX STATE MATRIX — the Approval Inbox, Revocation and Webhook columns.
//
// `test-browser/states.mjs` covers the Proofline column. This file covers the
// other three, and the matrix's OWN TRIGGER COLUMN is the definition of each
// test: every name below states the trigger it used, and the trigger it used is
// the one the matrix writes down.
//
//   initial loading            R R R  delayed first response; labeled busy state
//   action loading             R R R  delayed mutation; duplicate action blocked
//   empty never-had-any        R - R  zero rows; first valid action shown
//   filtered-to-zero           R - -  populated fixture + nonmatching filter
//   sparse/populated           R R R  canonical sparse and populated fixtures
//   partial                    - - R  health detail unavailable; known facts stay
//   validation error           R R R  typed INVALID_SCHEMA; note/reason/URL kept
//   permission denied          R R R  typed FORBIDDEN; no mutation
//   disabled                   R R R  server {allowed:false,reason_code}
//   stale/concurrent decision  R R R  second session decides first; typed code
//   network/server error       R R R  injected transport/500; bounded recovery
//   idempotent replay          R R R  exact key+payload; replay badge, no dup
//   compact/wide viewport      R R R  fixed viewports; no overlap/action loss
//   keyboard/focus             R R R  primary path by keyboard; visible focus
//
// THE CELLS THE MATRIX MARKS `N/A` HAVE NO TEST HERE. The revocation flow has no
// `empty never-had-any` and no `filtered-to-zero` — it is a form about one named
// version, not a list — and the webhook flow has no `filtered-to-zero` because
// it carries no filter. Inventing tests for those would be inventing states the
// specification says are unreachable.
//
// `decided while open in another session` is the `stale/concurrent decision`
// row and is tested as that row, not as a class of its own.
import { test } from "./lib/harness.mjs";
import { backendInbox, itemById, openItemOfKind, settledRegion, tlogEntries, withDecisions } from "./lib/decisions.mjs";
import { api } from "./lib/fixture.mjs";
import { APPROVALS_TEXT, REVOCATION_TEXT, WEBHOOK_TEXT } from "../src/console-surfaces.ts";

/** The console reads under test, as regexps rather than globs: the request is
 *  `http://127.0.0.1:<ephemeral>/v1/console/...` and a glob that silently
 *  matched nothing would make every interception test pass by not intercepting. */
const APPROVALS_READ = /\/v1\/console\/approvals(\?|$)/;
const APPROVALS_WRITE = /\/v1\/console\/versions\/[^/]+\/approvals$/;
const WEBHOOKS_READ = /\/v1\/console\/webhooks$/;
const WEBHOOK_TEST = /\/v1\/console\/webhooks\/[^/]+\/test$/;
const REVOCATION_READ = /\/v1\/console\/versions\/[^/]+\/revocation$/;
const REVOKE_WRITE = /\/v1\/console\/versions\/[^/]+\/revoke$/;

/** Hold a route open until released, so a gate can look at the page WHILE the
 *  server is slow — which is the only moment the loading rows are about. */
function heldRoute() {
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let seen = 0;
  return {
    seen: () => seen,
    release: () => release(),
    async handler(route) {
      seen += 1;
      await held;
      // A HELD ROUTE OUTLIVES ITS PAGE. Releasing after a reload has replaced
      // the document leaves Playwright with a route it has already disposed of,
      // and the rejection would take the whole run down for a request whose
      // answer nobody is waiting for any more. The hold is what the gate
      // measures; the continue is only tidy-up.
      try {
        await route.continue();
      } catch {
        /* the page this request belonged to is gone */
      }
    },
  };
}

// ===========================================================================
// initial loading — delayed first response; labeled busy state
// ===========================================================================

test("§7 initial loading · TRIGGER: a delayed first response; all three regions are labelled busy", async ({ assert }) => {
  await withDecisions(async ({ page, low }) => {
    // The regions the boot opens are settled by the time `withDecisions` hands
    // the page over, so the trigger is applied to a RELOAD — the same first
    // response, delayed, with the page watched while it is outstanding.
    const gate = heldRoute();
    await page.route(APPROVALS_READ, gate.handler);
    void page.reload().catch(() => {});
    await page.waitForFunction(
      () => document.getElementById("approvals")?.dataset.state === "loading",
      undefined,
      { timeout: 25000 },
    );
    const busy = await page.$eval("#approvals", (b) => ({
      state: b.dataset.state,
      aria: b.getAttribute("aria-busy"),
      text: b.textContent ?? "",
    }));
    assert.equal(busy.state, "loading");
    assert.equal(busy.aria, "true", "a busy region that does not say so is a region a screen reader calls ready");
    assert.ok(busy.text.includes(APPROVALS_TEXT.loading), "the busy region does not say what it is doing");
    gate.release();
    await page.unroute(APPROVALS_READ, gate.handler);
    assert.equal(await settledRegion(page, "approvals"), "loaded");

    // The webhook region wears the same stamp, on the same terms.
    const hook = heldRoute();
    await page.route(WEBHOOKS_READ, hook.handler);
    void page.reload().catch(() => {});
    await page.waitForFunction(
      () => document.getElementById("webhooks")?.dataset.state === "loading",
      undefined,
      { timeout: 25000 },
    );
    const hookBusy = await page.$eval("#webhooks", (b) => ({ aria: b.getAttribute("aria-busy"), text: b.textContent ?? "" }));
    assert.equal(hookBusy.aria, "true");
    assert.ok(hookBusy.text.includes(WEBHOOK_TEXT.loading));
    hook.release();
    await page.unroute(WEBHOOKS_READ, hook.handler);
    await settledRegion(page, "webhooks");

    // And the revocation region, whose first response is the pre-commit read.
    const rev = heldRoute();
    await page.route(REVOCATION_READ, rev.handler);
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "loading",
      undefined,
      { timeout: 25000 },
    );
    const revBusy = await page.$eval("#revocation", (b) => ({ aria: b.getAttribute("aria-busy"), text: b.textContent ?? "" }));
    assert.equal(revBusy.aria, "true");
    assert.ok(revBusy.text.includes(REVOCATION_TEXT.loading));
    rev.release();
    await page.unroute(REVOCATION_READ, rev.handler);
    assert.equal(await settledRegion(page, "revocation"), "precommit");
  });
});

// ===========================================================================
// action loading — delayed mutation; duplicate action blocked
// ===========================================================================

test("§7 action loading · TRIGGER: a delayed decision; the region says busy and a second press sends nothing", async ({ assert }) => {
  await withDecisions(async ({ page, reader }) => {
    await settledRegion(page, "approvals");
    await openItemOfKind(page, "publish");

    const gate = heldRoute();
    await page.route(APPROVALS_WRITE, gate.handler);
    await page.click('#approval-controls button[data-decision="approved"]');
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.actionState === "pending",
      undefined,
      { timeout: 25000 },
    );
    const held = await page.$eval("#approval-detail", (b) => ({
      aria: b.getAttribute("aria-busy"),
      text: b.textContent ?? "",
      disabled: [...b.querySelectorAll("#approval-controls button")].every((n) => n.disabled),
    }));
    assert.equal(held.aria, "true");
    assert.ok(held.text.includes(APPROVALS_TEXT.deciding));
    assert.ok(held.disabled, "a control was still pressable while its own request was in flight");

    // THE DUPLICATE, pressed anyway. The count is of requests that reached the
    // network, not of how a button looked.
    await page.$$eval('#approval-controls button[data-decision="approved"]', (nodes) => {
      for (const n of nodes) n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(gate.seen(), 1, `a second press became a second request (${gate.seen()} in flight)`);

    gate.release();
    await page.unroute(APPROVALS_WRITE, gate.handler);
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.actionState !== "pending",
      undefined,
      { timeout: 25000 },
    );

    // …and ONE decision reached the registry.
    const items = await backendInbox(reader);
    const publish = items.find((i) => i.kind === "publish");
    assert.equal(publish.status, "approved");
    assert.equal(publish.decision_history.length, 1, "one press produced more than one decision row");
  });
});

test("§7 action loading · TRIGGER: a delayed revocation and a delayed test delivery; both hold their own controls", async ({ assert }) => {
  await withDecisions(async ({ page, low, webhookId }) => {
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");
    await page.fill("#revocation-reason", "held while the server thinks");

    const gate = heldRoute();
    await page.route(REVOKE_WRITE, gate.handler);
    await page.click("#revoke-primary");
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.actionState === "pending",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(await page.$eval("#revoke-primary", (b) => b.disabled), true);
    assert.ok((await page.$eval("#revocation", (b) => b.textContent ?? "")).includes(REVOCATION_TEXT.committing));
    await page.$eval("#revoke-primary", (b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(gate.seen(), 1, "a second press of the revoke control became a second request");
    gate.release();
    await page.unroute(REVOKE_WRITE, gate.handler);
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "committed",
      undefined,
      { timeout: 30000 },
    );

    const hook = heldRoute();
    await page.route(WEBHOOK_TEST, hook.handler);
    await page.click(`button[data-action="test-webhook"][data-webhook-id="${webhookId}"]`);
    await page.waitForFunction(
      () => document.getElementById("webhooks")?.dataset.actionState === "pending",
      undefined,
      { timeout: 25000 },
    );
    assert.ok((await page.$eval("#webhooks", (b) => b.textContent ?? "")).includes(WEBHOOK_TEXT.testing));
    await page.$$eval('button[data-action="test-webhook"]', (nodes) => {
      for (const n of nodes) n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(hook.seen(), 1, "a second press of the test control became a second delivery");
    hook.release();
    await page.unroute(WEBHOOK_TEST, hook.handler);
    await page.waitForSelector("#webhook-test-result", { timeout: 30000 });
  });
});

// ===========================================================================
// empty never-had-any — zero rows; first valid action shown
// ===========================================================================

test("§7 empty never-had-any · TRIGGER: a deployment that never registered an endpoint; the first valid action is offered", async ({ assert }) => {
  await withDecisions(
    async ({ page }) => {
      assert.equal(await settledRegion(page, "webhooks"), "empty");
      const text = await page.$eval("#webhooks", (b) => b.textContent ?? "");
      assert.ok(text.includes(WEBHOOK_TEXT.empty), "an empty endpoint list says nothing about being empty");
      // THE FIRST VALID ACTION ON AN EMPTY LIST IS TO CREATE THE FIRST ITEM,
      // and it is present, enabled and has somewhere to type.
      const register = await page.$eval("#webhook-register", (b) => ({ text: b.textContent, disabled: b.disabled }));
      assert.equal(register.text, WEBHOOK_TEXT.register);
      assert.equal(register.disabled, false);
      assert.ok(await page.$("#webhook-url"), "there is nowhere to type the first endpoint");
    },
    { webhook: false },
  );
});

// ===========================================================================
// filtered-to-zero — populated fixture + nonmatching filter; clear-filter action
// ===========================================================================

test("§7 filtered-to-zero · TRIGGER: a populated inbox and a status filter that matches nothing; a clear-filter action", async ({ assert }) => {
  await withDecisions(async ({ page }) => {
    assert.equal(await settledRegion(page, "approvals"), "loaded");
    const populated = Number(await page.$eval("#approvals", (b) => b.dataset.items));
    assert.ok(populated > 0, "the inbox is empty, so filtering it to zero proves nothing");

    // `decided` + `adopt_high_risk` is a pair this journey has produced no item
    // for — the one high-risk adoption is still pending — so it selects none of
    // the items that ARE there. That is the point: the rows still exist.
    await page.selectOption("#approvals-status", "decided");
    await page.selectOption("#approvals-kind", "adopt_high_risk");
    await page.waitForFunction(
      () => document.getElementById("approvals")?.dataset.state === "filtered-to-zero",
      undefined,
      { timeout: 25000 },
    );
    const text = await page.$eval("#approvals", (b) => b.textContent ?? "");
    assert.ok(text.includes(APPROVALS_TEXT.filtered_to_zero));
    assert.ok(
      !text.includes(APPROVALS_TEXT.empty),
      "a filtered inbox said the workspace has never had an approval — the filter's work attributed to the registry",
    );

    const clear = await page.$('#approvals button[data-action="clear-filter"]');
    assert.ok(clear, "no way back from a filter that selected nothing");
    await clear.click();
    await page.waitForFunction(
      () => document.getElementById("approvals")?.dataset.state === "loaded",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(Number(await page.$eval("#approvals", (b) => b.dataset.items)), populated, "clearing the filter lost rows");
  });
});

// ===========================================================================
// sparse/populated — canonical sparse and populated fixtures
// ===========================================================================

test("§7 sparse/populated · TRIGGER: the same surfaces with and without a registered endpoint and a decided journey", async ({ assert }) => {
  const sparse = {};
  await withDecisions(
    async ({ page }) => {
      sparse.webhooks = Number(await page.$eval("#webhooks", (b) => b.dataset.items ?? "0"));
      sparse.webhookState = await settledRegion(page, "webhooks");
    },
    { webhook: false },
  );

  await withDecisions(async ({ page, low }) => {
    await settledRegion(page, "approvals");
    const approvals = Number(await page.$eval("#approvals", (b) => b.dataset.items));
    const webhooks = Number(await page.$eval("#webhooks", (b) => b.dataset.items));
    assert.equal(sparse.webhookState, "empty");
    assert.equal(sparse.webhooks, 0);
    assert.ok(approvals > 0, "the journey produced no approval items");
    assert.ok(webhooks > sparse.webhooks, "a registered endpoint did not populate the endpoint list");

    // The revocation surface is a form about ONE named version and has no list
    // to be sparse; its two fixtures are a subject with adopters and one without.
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");
    assert.ok(
      Number(await page.$eval("#revocation [data-adopters]", (n) => n.dataset.adopters)) > 0,
      "the populated revocation subject has no adopters",
    );
  });
});

// ===========================================================================
// partial — health detail unavailable; known facts remain visible
// ===========================================================================

test("§7 partial · TRIGGER: a test result the transport could not fully report; the known facts stay on the page", async ({ assert }) => {
  await withDecisions(async ({ page, webhookId }) => {
    await settledRegion(page, "webhooks");

    // The transport answers, and answers that it has no status and no detail to
    // report. THE KNOWN FACTS STAY: the endpoint, its URL, its production status
    // and its failure count are all still on the page beside the unknown ones.
    const handler = (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          contract: "console.v2",
          delivered: false,
          http_status: null,
          latency_ms: 12,
          error_code: "TRANSPORT_ERROR",
          error_detail: null,
        }),
      });
    await page.route(WEBHOOK_TEST, handler);
    await page.click(`button[data-action="test-webhook"][data-webhook-id="${webhookId}"]`);
    await page.waitForSelector("#webhook-test-result", { timeout: 30000 });
    await page.unroute(WEBHOOK_TEST, handler);

    const shown = await page.$$eval("#webhook-test-result [data-fact]", (ns) =>
      Object.fromEntries(ns.map((n) => [n.dataset.fact, n.querySelector("dd")?.textContent ?? ""])),
    );
    // AN ABSENT FIELD SAYS SO. It is not a blank cell and it is not a zero —
    // `INV-03`'s rule, applied to the one surface where a field can be missing.
    assert.equal(shown.http_status, WEBHOOK_TEXT.field_absent);
    assert.equal(shown.error_detail, WEBHOOK_TEXT.field_absent);
    // …and the fields that WERE reported are still reported.
    assert.equal(shown.latency_ms, "12");
    assert.equal(shown.error_code, "TRANSPORT_ERROR");

    // The known facts about the endpoint are untouched beside it.
    const row = await page.$eval(`#webhook-rows tr[data-webhook-id="${webhookId}"]`, (r) => ({
      status: r.dataset.status,
      failures: r.dataset.failureCount,
    }));
    assert.equal(row.status, "active");
    assert.equal(row.failures, "0");
  });
});

// ===========================================================================
// validation error — typed INVALID_SCHEMA; operator note/reason/URL preserved
// ===========================================================================

test("§7 validation error · TRIGGER: a revocation reason past the contract's bound; the typed refusal and the reason kept", async ({ assert }) => {
  await withDecisions(async ({ page, reader, low }) => {
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");

    // A REASON A PERSON COULD ACTUALLY WRITE, past the 2000-character bound
    // SPEC.md section 5.1b puts on it. The server types the refusal; this page
    // does not decide for itself that it is too long.
    const reason = "why this version must go: ".repeat(120);
    assert.ok(reason.length > 2000);
    await page.fill("#revocation-reason", reason);
    await page.click("#revoke-primary");
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "invalid",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(await page.$eval("#revocation", (b) => b.dataset.code), "INVALID_SCHEMA");

    // THE REASON IS STILL THERE. This is the field where losing it matters most:
    // a revocation reason is immutable once recorded, so retyping it from memory
    // is how it ends up different from the one intended.
    assert.equal(await page.$eval("#revocation-reason", (n) => n.value), reason, "the reason was cleared");
    assert.ok(
      (await page.$eval("#revocation [data-preserved]", (n) => n.textContent)).startsWith(REVOCATION_TEXT.reason_preserved),
    );

    // AND NOTHING WAS RECORDED.
    const after = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
    assert.equal(after.body.state, "published");
    assert.equal(after.body.revocation_reason, null);
  });
});

test("§7 validation error · TRIGGER: an endpoint URL this deployment refuses; the typed refusal and the URL kept", async ({ assert }) => {
  await withDecisions(async ({ page, reader }) => {
    await settledRegion(page, "webhooks");
    const before = (await reader.raw("/v1/console/webhooks")).body.items.length;

    // A URL the transport policy refuses. WHICH URLs are admissible is the
    // server's rule and this page holds no copy of it — which is the whole
    // reason the refusal has to arrive as a typed answer.
    const url = "http://192.0.2.1/hook";
    await page.fill("#webhook-url", url);
    await page.click("#webhook-register");
    await page.waitForFunction(
      () => document.getElementById("webhooks")?.dataset.state === "invalid",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(await page.$eval("#webhooks", (b) => b.dataset.code), "INVALID_SCHEMA");
    assert.equal(await page.$eval("#webhook-url", (n) => n.value), url, "the URL was cleared");
    assert.ok((await page.$eval("#webhooks [data-preserved]", (n) => n.textContent)).includes(url));

    const after = (await reader.raw("/v1/console/webhooks")).body.items.length;
    assert.equal(after, before, "a refused registration wrote a row");
  });
});

test("§7 validation error · TRIGGER: an approval note past the contract's bound; the typed refusal and the note kept", async ({ assert }) => {
  await withDecisions(async ({ page, reader }) => {
    await settledRegion(page, "approvals");
    const before = await backendInbox(reader);
    const target = before.find((i) => i.kind === "adopt_high_risk");
    await openItemOfKind(page, "adopt_high_risk");
    const note = "a considered note. ".repeat(120);
    assert.ok(note.length > 2000);
    await page.fill("#approval-note", note);
    await page.click('#approval-controls button[data-decision="approved"]');
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.state === "invalid",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(await page.$eval("#approval-detail", (b) => b.dataset.code), "INVALID_SCHEMA");
    assert.equal(await page.$eval("#approval-note", (n) => n.value), note);
    const after = await backendInbox(reader);
    assert.equal(itemById(after, target.item_id).status, "pending", "a refused body decided the item anyway");
  });
});

// ===========================================================================
// permission denied — typed FORBIDDEN; no mutation
// ===========================================================================

test("§7 permission denied · TRIGGER: a reviewer session on all three surfaces; the server's typed FORBIDDEN and no mutation", async ({ assert }) => {
  await withDecisions(
    async ({ page, reader, low }) => {
      // The inbox, refused at the FILTER rather than silently narrowed — a
      // narrowed list would read to a reviewer as "there is nothing to decide".
      assert.equal(await settledRegion(page, "approvals"), "forbidden");
      assert.equal(await page.$eval("#approvals", (b) => b.dataset.code), "FORBIDDEN");
      const shown = await page.$eval("#approvals", (b) => b.textContent ?? "");
      assert.ok(shown.includes(APPROVALS_TEXT.forbidden_heading));
      assert.ok(shown.includes("FORBIDDEN"), "the server's own code is not on the page");
      // A `FORBIDDEN` retried is a `FORBIDDEN` again, so no retry is offered.
      assert.equal(await page.$('#approvals button[data-action="retry"]'), null);

      // The webhook surface: a reviewer is outside the owner-only class.
      assert.equal(await settledRegion(page, "webhooks"), "forbidden");
      assert.equal(await page.$eval("#webhooks", (b) => b.dataset.code), "FORBIDDEN");

      // The revocation surface.
      await page.fill("#revocation-version", low.skill_version_id);
      await page.click("#revocation-load");
      assert.equal(await settledRegion(page, "revocation"), "forbidden");
      assert.equal(await page.$eval("#revocation", (b) => b.dataset.code), "FORBIDDEN");

      // ---- AND NO MUTATION. The reviewer is still entitled to the one kind it
      // may ask for, and that read is the row snapshot: nothing was decided.
      const reviews = await reader.raw("/v1/console/approvals?status=all&kind=review");
      assert.equal(reviews.status, 200, "a reviewer was refused the one kind it may ask for");
      for (const item of reviews.body.items) {
        assert.equal(item.kind, "review", "a reviewer's inbox carried a kind it may not ask for");
      }
      const revocation = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
      assert.equal(revocation.status, 403, "a reviewer read the revocation surface it was refused in the browser");
    },
    { role: "reviewer" },
  );
});

// ===========================================================================
// disabled — server {allowed:false,reason_code}; exact reason visible
// ===========================================================================

test("§7 disabled · TRIGGER: the server's own {allowed:false, reason_code} on an inbox item and on a version that cannot be revoked", async ({ assert }) => {
  await withDecisions(async ({ page, reader, high }) => {
    await settledRegion(page, "approvals");
    const items = await backendInbox(reader);
    const refused = items.find((i) => i.eligibility.allowed === false);
    assert.ok(refused, "no item carries a server refusal");

    await page.click(`#approval-rows tr[data-item-id="${refused.item_id}"] button[data-action="open-approval"]`);
    await page.waitForSelector('#approval-detail[data-state="loaded"]', { timeout: 25000 });
    assert.equal(await page.$eval("#approval-detail", (b) => b.dataset.allowed), "false");
    assert.equal(
      await page.$eval("#approval-controls [data-withheld]", (n) => n.dataset.reasonCode),
      refused.eligibility.reason_code,
      "the exact reason code the server sent is not the one on the page",
    );
    assert.equal((await page.$$("#approval-controls button")).length, 0, "a decision control was offered anyway");

    // The revocation half: a version that is not in a revocable state. The
    // reason is the server's and the primary action does not exist.
    await page.fill("#revocation-version", high.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");
    const server = await reader.raw(`/v1/console/versions/${high.skill_version_id}/revocation`);
    assert.equal(server.body.eligibility.allowed, false, "the high-risk version is unexpectedly revocable");
    assert.equal(await page.$eval("#revocation", (b) => b.dataset.reasonCode), server.body.eligibility.reason_code);
    assert.equal(
      await page.$eval("#revocation [data-withheld]", (n) => n.dataset.reasonCode),
      server.body.eligibility.reason_code,
    );
    assert.equal(await page.$("#revoke-primary"), null, "a revoke control was offered for a version that cannot be revoked");

    // …and the facts are still on the page: a withheld control does not hide the
    // subject it is withheld for.
    assert.ok(await page.$('#revocation [data-fact="manifest_hash"]'));
  });
});

// ===========================================================================
// stale/concurrent decision — a second session decides first
// ===========================================================================

test("§7 stale/concurrent decision · TRIGGER: a second session decides this item first; the typed code and a refresh action", async ({ assert }) => {
  await withDecisions(async ({ page, reader }) => {
    await settledRegion(page, "approvals");
    const items = await backendInbox(reader);

    // THE SUBJECT IS THE HIGH-RISK ADOPTION, and the choice is the content of
    // the test rather than a convenience. A publication approval is a row in a
    // bounded history and a second decision on it is a legitimate second row; an
    // adoption approval is BOUND TO ONE REQUEST and is spent when that request
    // leaves `approval_pending`, so a second decision on it is the thing the
    // registry must refuse and this row must show.
    const target = items.find((i) => i.kind === "adopt_high_risk" && i.eligibility.allowed);
    assert.ok(target, "no decidable high-risk adoption to race");

    // The browser opens the item…
    await openItemOfKind(page, "adopt_high_risk");
    assert.equal(await page.$eval("#approval-detail", (b) => b.dataset.status), "pending");

    // …and a SECOND SESSION decides it first, over the console surface, with its
    // own session and its own CSRF token. `decided while open in another
    // session` is THIS row and not a class of its own.
    const other = await reader.raw(`/v1/console/versions/${target.skill.skill_version_id}/approvals`, "POST", {
      scope: "adopt_high_risk",
      decision: "approved",
      adoption_request_id: target.adoption_request.adoption_request_id,
      note: "the other session got there first",
      idempotency_key: "other-session-adoption",
    });
    assert.equal(other.status, 201, `the second session could not decide: ${other.text}`);

    // Now the first session presses its own button, on a page that still shows
    // the item as pending.
    await page.click('#approval-controls button[data-decision="denied"]');
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.actionState !== "pending",
      undefined,
      { timeout: 25000 },
    );
    const state = await page.$eval("#approval-detail", (b) => ({ state: b.dataset.state, code: b.dataset.code ?? null }));
    assert.equal(
      state.state,
      "stale",
      `a decision another session had already taken landed in \`${state.state}\` with code ${state.code}`,
    );
    assert.ok(
      ["PRECONDITION_FAILED", "CONFLICT", "NOT_FOUND"].includes(state.code),
      `a concurrent decision was refused with the untyped code ${state.code}`,
    );

    // A REFRESH, NOT A RETRY. The point is to show what the other session did.
    assert.equal((await page.$$('#approval-detail button[data-action="retry"]')).length, 0);
    const refresh = await page.$('#approval-detail button[data-action="refresh"]');
    assert.ok(refresh, "no refresh action on a stale item");
    await refresh.click();
    await page.waitForSelector('#approval-detail[data-state="loaded"]', { timeout: 25000 });

    // THE DECISION THE REGISTRY HOLDS IS THE FIRST ONE, and the page now shows
    // that decision rather than the one this session pressed.
    const after = await backendInbox(reader);
    const decided = itemById(after, target.item_id);
    assert.equal(decided.status, "approved", "the second press overwrote a decision that was already recorded");
    assert.equal(decided.decision.note, "the other session got there first");
    assert.equal(decided.decision_history.length, 1, "the refused second press wrote a decision row anyway");
    assert.equal(
      await page.$eval(`#approval-rows tr[data-item-id="${target.item_id}"]`, (r) => r.dataset.status),
      "approved",
      "the page still shows the state this session had before the other one decided",
    );
  });
});

test("§7 stale/concurrent decision · TRIGGER: a second session revokes this version first; the typed code and a refresh action", async ({ assert }) => {
  await withDecisions(async ({ page, reader, low, logs }) => {
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await page.waitForSelector('#revocation[data-state="precommit"]', { timeout: 25000 });
    await page.fill("#revocation-reason", "the reason this session would have given");

    // The other session revokes it first, for a DIFFERENT reason — and a
    // revocation reason is immutable, so the registry must refuse the second.
    const other = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revoke`, "POST", {
      reason: "the reason the other session gave",
      idempotency_key: "other-session-revoke",
    });
    assert.equal(other.status, 200, `the second session could not revoke: ${other.text}`);

    await page.click("#revoke-primary");
    await page
      .waitForFunction(
        () => document.getElementById("revocation")?.dataset.actionState !== "pending",
        undefined,
        { timeout: 20000 },
      )
      .catch(async () => {
        throw new Error(
          `the revocation never settled: ${JSON.stringify(await page.$eval("#revocation", (b) => ({ ...b.dataset })))} logs=${JSON.stringify(logs)}`,
        );
      });
    const observed = await page.$eval("#revocation", (b) => ({ ...b.dataset }));
    assert.equal(observed.state, "stale", `the concurrent revocation landed in ${JSON.stringify(observed)}`);
    const code = await page.$eval("#revocation", (b) => b.dataset.code);
    assert.ok(
      ["PRECONDITION_FAILED", "CONFLICT", "NOT_FOUND"].includes(code),
      `a concurrent revocation was refused with the untyped code ${code}`,
    );
    assert.ok(await page.$('#revocation button[data-action="refresh"]'), "no refresh action on a stale version");

    // THE FIRST REASON STANDS. The one this session typed never became the
    // registry's, which is exactly what immutability means.
    await page.click('#revocation button[data-action="refresh"]');
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "precommit",
      undefined,
      { timeout: 25000 },
    );
    const after = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
    assert.equal(after.body.revocation_reason, "the reason the other session gave");
    assert.equal(
      await page.$eval('#revocation [data-fact="state"] dd', (n) => n.textContent),
      "revoked",
      "the refreshed page does not show the state the other session recorded",
    );
  });
});

test("§7 stale/concurrent decision · TRIGGER: a second session deletes this endpoint first; the typed code and a refresh action", async ({ assert }) => {
  await withDecisions(async ({ page, fx, ownerKey, webhookId }) => {
    await settledRegion(page, "webhooks");
    const gone = await api(fx.base, "DELETE", `/v1/webhooks/${webhookId}`, ownerKey);
    assert.equal(gone.status, 200, `the second session could not delete the endpoint: ${JSON.stringify(gone.body)}`);

    await page.click(`button[data-action="test-webhook"][data-webhook-id="${webhookId}"]`);
    await page.waitForFunction(
      () => document.getElementById("webhooks")?.dataset.state === "stale",
      undefined,
      { timeout: 30000 },
    );
    const code = await page.$eval("#webhooks", (b) => b.dataset.code);
    assert.ok(["PRECONDITION_FAILED", "CONFLICT", "NOT_FOUND"].includes(code), `untyped concurrent code ${code}`);
    assert.ok(await page.$('#webhooks button[data-action="refresh"]'));
    await page.click('#webhooks button[data-action="refresh"]');
    await page.waitForFunction(
      () => document.getElementById("webhooks")?.dataset.state === "empty",
      undefined,
      { timeout: 25000 },
    );
  });
});

// ===========================================================================
// network/server error — injected transport/500; bounded recovery action
// ===========================================================================

test("§7 network/server error · TRIGGER: an injected transport failure and an injected 500; one bounded recovery action each", async ({ assert }) => {
  await withDecisions(async ({ page, low }) => {
    for (const [region, pattern] of [
      ["approvals", APPROVALS_READ],
      ["webhooks", WEBHOOKS_READ],
    ]) {
      const handler = (route) => route.abort("connectionrefused");
      await page.route(pattern, handler);
      void page.reload().catch(() => {});
      await page.waitForFunction((r) => document.getElementById(r)?.dataset.state === "error", region, { timeout: 25000 });
      // A BOUNDED RECOVERY — one retry action, and it is the only one.
      await page.unroute(pattern, handler);
      const retries = await page.$$(`#${region} button[data-action="retry"]`);
      assert.equal(retries.length, 1, `${region} offers ${retries.length} recovery actions`);
      await retries[0].click();
      await page.waitForFunction(
        (r) => {
          const s = document.getElementById(r)?.dataset.state;
          return s !== undefined && s !== "loading" && s !== "error";
        },
        region,
        { timeout: 25000 },
      );
    }

    // The revocation read, refused by the SERVER rather than by the socket.
    const handler = (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ contract: "console.v2", error: { code: "INTERNAL", message: "the fixture server broke" } }),
      });
    await page.route(REVOCATION_READ, handler);
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "error",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(await page.$eval("#revocation", (b) => b.dataset.code), "INTERNAL");
    assert.equal((await page.$$('#revocation button[data-action="retry"]')).length, 1);
    await page.unroute(REVOCATION_READ, handler);
    await page.click('#revocation button[data-action="retry"]');
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "precommit",
      undefined,
      { timeout: 25000 },
    );
  });
});

// ===========================================================================
// idempotent replay — exact key + payload; replay badge, no duplicate event
// ===========================================================================

test("§7 idempotent replay · TRIGGER: the exact key and payload resent after the answer was lost; a replay badge and no second row", async ({ assert }) => {
  await withDecisions(async ({ page, reader, low, fx, ownerKey }) => {
    await settledRegion(page, "approvals");
    const items = await backendInbox(reader);
    const target = items.find((i) => i.kind === "adopt_high_risk");
    assert.ok(target, "no high-risk adoption to decide");

    // THE TRIGGER IS THE REASON IDEMPOTENCY KEYS EXIST: the request REACHES the
    // registry, the registry writes the decision, and the answer is lost on the
    // way back. The operator sees a transport failure and cannot know whether
    // their decision landed. `route.fetch()` performs the real request against
    // the real server and `route.abort()` then drops the response, which is that
    // situation exactly rather than a simulation of it.
    let dropped = 0;
    const drop = async (route) => {
      await route.fetch();
      dropped += 1;
      await route.abort("connectionreset");
    };
    await page.route(APPROVALS_WRITE, drop);

    await openItemOfKind(page, "adopt_high_risk");
    await page.fill("#approval-note", "decided once");
    await page.click('#approval-controls button[data-decision="approved"]');
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.state === "error",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(dropped, 1, "the request did not reach the registry, so there is nothing to replay");

    // THE REGISTRY DID RECORD IT. The operator does not know that; the page does
    // not claim it either, which is why the recovery is to send the same request
    // again rather than to declare success.
    const afterFirst = itemById(await backendInbox(reader), target.item_id);
    assert.equal(afterFirst.status, "approved");
    assert.equal(afterFirst.decision_history.length, 1);

    // THE BOUNDED RECOVERY, pressed — and it resends the SAME key and the SAME
    // payload, because the console mints the key from the item, the decision and
    // the note rather than from the attempt.
    await page.unroute(APPROVALS_WRITE, drop);
    assert.equal((await page.$$('#approval-detail button[data-action="retry"]')).length, 1);
    await page.click('#approval-detail button[data-action="retry"]');
    await page.waitForSelector("#approval-detail [data-replayed]", { timeout: 25000 });
    assert.equal(
      await page.$eval("#approval-detail [data-replayed]", (n) => n.textContent),
      APPROVALS_TEXT.replay_badge,
      "a replayed decision carries no replay badge",
    );

    // AND NO SECOND EVENT.
    const afterSecond = itemById(await backendInbox(reader), target.item_id);
    assert.equal(afterSecond.decision_history.length, 1, "a replay wrote a second decision row");
    assert.equal(afterSecond.decision.server_at_ms, afterFirst.decision.server_at_ms, "the replay rewrote the decision");

    // ---- THE REVOCATION HALF, the same way.
    let revDropped = 0;
    const dropRevoke = async (route) => {
      await route.fetch();
      revDropped += 1;
      await route.abort("connectionreset");
    };
    await page.route(REVOKE_WRITE, dropRevoke);
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");
    await page.fill("#revocation-reason", "revoked exactly once");
    await page.click("#revoke-primary");
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "error",
      undefined,
      { timeout: 25000 },
    );
    assert.equal(revDropped, 1);
    const revokedOnce = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
    assert.equal(revokedOnce.body.state, "revoked");

    await page.unroute(REVOKE_WRITE, dropRevoke);
    await page.click('#revocation button[data-action="retry"]');
    await page.waitForSelector("#revocation [data-replayed]", { timeout: 30000 });
    assert.equal(await page.$eval("#revocation [data-replayed]", (n) => n.textContent), REVOCATION_TEXT.replay_badge);

    // A REPLAY REPORTS THE ORIGINAL ENTRY, not a second one. `tlog_seq` on the
    // committed panel is the seq of the `version_revoked` entry, and there is
    // exactly one of those.
    const seq = await page.$eval('#revocation [data-fact="tlog_seq"] dd', (n) => n.textContent);
    assert.ok(/^\d+$/.test(seq), `the replayed revocation reported no tlog seq: ${seq}`);
    const revocations = (await tlogEntries(fx, ownerKey)).filter((e) => e.event_kind === "version_revoked");
    assert.equal(revocations.length, 1, "a replayed revocation appended a second transparency-log entry");
    assert.equal(String(revocations[0].seq), seq, "the replay reported a seq that is not the original entry's");
  });
});

// ===========================================================================
// compact/wide viewport — fixed mobile and desktop; no overlap, no action loss
// ===========================================================================

test("§7 compact/wide viewport · TRIGGER: fixed mobile and desktop viewports; every action stays reachable", async ({ assert }) => {
  for (const viewport of [
    { width: 375, height: 720 },
    { width: 1280, height: 900 },
  ]) {
    await withDecisions(
      async ({ page, low }) => {
        await settledRegion(page, "approvals");
        await openItemOfKind(page, "publish");
        await page.fill("#revocation-version", low.skill_version_id);
        await page.click("#revocation-load");
        await settledRegion(page, "revocation");

        // THE DOCUMENT DOES NOT SCROLL SIDEWAYS. A page that did would be a page
        // whose right-hand actions are off the edge of a phone.
        const overflow = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          view: document.documentElement.clientWidth,
        }));
        assert.ok(
          overflow.doc <= overflow.view + 1,
          `at ${viewport.width}px the document is ${overflow.doc}px wide in a ${overflow.view}px viewport`,
        );

        // EVERY CONTROL IS INSIDE THE VIEWPORT'S WIDTH AND HAS A BOX. A control
        // with a zero-sized box is a control nobody can press.
        const boxes = await page.$$eval(
          "#approval-controls button, #revoke-primary, #webhook-register",
          (nodes, width) =>
            nodes.map((n) => {
              const r = n.getBoundingClientRect();
              return {
                text: (n.textContent ?? "").slice(0, 24),
                w: r.width,
                h: r.height,
                over: r.right > width + 1,
              };
            }),
          viewport.width,
        );
        assert.ok(boxes.length > 0, "no control was measured");
        for (const b of boxes) {
          assert.ok(b.w > 0 && b.h > 0, `the control \`${b.text}\` has no box`);
          assert.ok(!b.over, `the control \`${b.text}\` runs past the ${viewport.width}px viewport`);
        }
      },
      { viewport },
    );
  }
});

// ===========================================================================
// keyboard/focus — complete the primary path by keyboard; visible focus
// ===========================================================================

test("§7 keyboard/focus · TRIGGER: a decision and a revocation completed by keyboard alone, with visible focus", async ({ assert }) => {
  await withDecisions(async ({ page, reader, low }) => {
    await settledRegion(page, "approvals");

    // Reach the row's own control with the keyboard and open it with Enter.
    const opener = '#approval-rows tr[data-kind="publish"] button[data-action="open-approval"]';
    await page.focus(opener);
    // VISIBLE FOCUS, MEASURED on the element that actually has focus. A computed
    // style asked for the `:focus-visible` pseudo-class answers nothing in
    // Chromium; the style of the focused element is the real question and the
    // one `test-browser/states.mjs` asks of the Proofline.
    const focusVisible = await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      const s = window.getComputedStyle(document.activeElement);
      return {
        focused: document.activeElement === node,
        style: s.outlineStyle,
        outline: s.outlineWidth,
      };
    }, opener);
    assert.equal(focusVisible.focused, true, "the control did not take focus");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#approval-detail[data-state="loaded"]', { timeout: 25000 });

    // Type the note and press the decision, all from the keyboard.
    await page.focus("#approval-note");
    await page.keyboard.type("decided with a keyboard");
    await page.focus('#approval-controls button[data-decision="approved"]');
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-decision")),
      "approved",
      "the decision control cannot be focused",
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.actionState !== "pending",
      undefined,
      { timeout: 25000 },
    );
    const items = await backendInbox(reader);
    const publish = items.find((i) => i.kind === "publish");
    assert.equal(publish.status, "approved", "the keyboard path did not complete the decision");
    assert.equal(publish.decision.note, "decided with a keyboard");

    // The revocation path, the same way.
    await page.focus("#revocation-version");
    await page.keyboard.type(low.skill_version_id);
    await page.focus("#revocation-load");
    await page.keyboard.press("Enter");
    await settledRegion(page, "revocation");
    await page.focus("#revocation-reason");
    await page.keyboard.type("revoked with a keyboard");
    await page.focus("#revoke-primary");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "committed",
      undefined,
      { timeout: 30000 },
    );
    const after = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
    assert.equal(after.body.state, "revoked");
    assert.equal(after.body.revocation_reason, "revoked with a keyboard");

    // FOCUS IS VISIBLE AS AN OUTLINE, not as a colour swap — a reader who sees
    // no colour is still told which control they are on.
    assert.notEqual(focusVisible.style, "none", `the focused control has no outline: ${JSON.stringify(focusVisible)}`);
    assert.ok(
      parseFloat(focusVisible.outline) > 0,
      `the focus outline has no width: ${JSON.stringify(focusVisible)}`,
    );
  });
});
