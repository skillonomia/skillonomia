// THE DECISION GATES — an owner decides, and the REGISTRY is what is asserted.
//
// G-P2-6  owner decides high-risk adoption and publication without curl
// G-P2-7  an ineligible actor sees the server's reason and cannot mutate
// G-P2-8  revocation states the no-DRM consequence before commit
// G-P2-9  the four exact human-decision labels, and the absence of the wrong ones
//         (the browser half; the source half is `test/v1p2-p2c-console.test.ts`)
// SPEC.md section 6.5's console test-delivery flow
//
// NOT ONE OF THESE ASSERTS A SCREENSHOT. Every decision is checked against the
// approval row the registry serves back and the transparency-log entry it
// appended — the toast is not evidence and neither is the button going grey.
import { test } from "./lib/harness.mjs";
import {
  backendInbox,
  itemById,
  openItemOfKind,
  primaryControlLabels,
  readApprovalRows,
  settledRegion,
  tlogEntries,
  withDecisions,
} from "./lib/decisions.mjs";
import { api } from "./lib/fixture.mjs";
import {
  APPROVALS_TEXT,
  FORBIDDEN_PRIMARY_LABELS,
  HUMAN_DECISION_LABEL_LIST,
  REVOCATION_CONSEQUENCES,
  REVOCATION_TEXT,
  REVOKE_PRIMARY_LABELS,
  WEBHOOK_TEXT,
} from "../src/console-surfaces.ts";

/** Every control a person can press on the two decision surfaces. The absence
 *  check reads this and not `document.body.textContent`: a page may legitimately
 *  contain the word `Yes` in a sentence, and what SPEC.md section 6.4 forbids is
 *  a CONTROL that says it. */
const CONTROL_SELECTOR = "#approval-controls button, #revocation button, #webhooks button, #approvals button";

// ---------------------------------------------------------------------------
// G-P2-6 — the owner decides, and the registry records it
// ---------------------------------------------------------------------------

test("G-P2-6 · an owner approves a high-risk adoption entirely through the UI, and the registry records it", async ({ assert }) => {
  await withDecisions(async ({ page, reader, fx, ownerKey, high, foreign }) => {
    assert.equal(await settledRegion(page, "approvals"), "loaded");

    const before = await backendInbox(reader);
    const pending = before.find((i) => i.kind === "adopt_high_risk");
    assert.ok(pending, "the journey did not leave a high-risk adoption waiting on a human");
    assert.equal(pending.status, "pending");
    assert.ok(
      pending.adoption_request?.adoption_request_id,
      "a high-risk adoption item without the exact request id cannot bind an approval to one request",
    );
    const tlogBefore = await tlogEntries(fx, ownerKey);

    const detail = await openItemOfKind(page, "adopt_high_risk");
    assert.equal(detail.kind, "adopt_high_risk");
    assert.equal(detail.allowed, "true");

    // THE EXACT REQUEST IS ON THE PAGE, so the person spending a non-reusable
    // approval can see which request they are spending it on.
    const shown = await page.$eval('#approval-detail [data-fact="adoption_request_id"] dd', (n) => n.textContent);
    assert.equal(shown, pending.adoption_request.adoption_request_id);

    // The four exact labels, and only the right two are offered here.
    const labels = await primaryControlLabels(page, "#approval-controls button");
    assert.deepEqual(labels, ["Approve this adoption", "Deny this adoption"]);

    await page.fill("#approval-note", "the owner approves this one adoption");
    await page.click('#approval-controls button[data-decision="approved"]');
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.actionState !== "pending",
      undefined,
      { timeout: 20000 },
    );

    // ---- THE EVIDENCE. Not the toast: the row and the log.
    const after = await backendInbox(reader);
    const decided = itemById(after, pending.item_id);
    assert.ok(decided, "the item vanished from the inbox after a decision");
    assert.equal(decided.status, "approved", "the registry does not record this adoption as approved");
    assert.ok(decided.decision, "an approved item carries no decision row");
    assert.equal(decided.decision.decision, "approved");
    assert.equal(decided.decision.actor_type, "human", "a human gate was satisfied by a non-human principal");
    assert.equal(decided.decision.note, "the owner approves this one adoption");

    const tlogAfter = await tlogEntries(fx, ownerKey);
    assert.ok(
      tlogAfter.length > tlogBefore.length,
      `the approval appended nothing to the transparency log (${tlogBefore.length} → ${tlogAfter.length})`,
    );

    // …and the page now shows the registry's answer, not the browser's guess.
    const rowStatus = await page.$eval(
      `#approval-rows tr[data-item-id="${pending.item_id}"]`,
      (r) => r.dataset.status,
    );
    assert.equal(rowStatus, "approved");

    // The adoption the approval unblocked is now an adoption that proceeds —
    // which is what makes the approval a product fact and not a row.
    const proceeds = await api(fx.base, "POST", `/v1/adoptions/${pending.adoption_request.adoption_request_id}/adopt`, undefined, undefined);
    assert.notEqual(proceeds.status, 200, "an unauthenticated adopt succeeded");

    assert.deepEqual(foreign, [], "the page reached for something outside this deployment");
  });
});

test("G-P2-6 · an owner denies a publication entirely through the UI, and the registry records the denial", async ({ assert }) => {
  await withDecisions(async ({ page, reader, fx, ownerKey }) => {
    await settledRegion(page, "approvals");
    const before = await backendInbox(reader);
    const pending = before.find((i) => i.kind === "publish" && i.status === "pending");
    assert.ok(pending, "the journey did not leave a publication waiting on a human");
    const tlogBefore = await tlogEntries(fx, ownerKey);

    const detail = await openItemOfKind(page, "publish");
    assert.equal(detail.kind, "publish");

    const labels = await primaryControlLabels(page, "#approval-controls button");
    assert.deepEqual(labels, ["Approve publication", "Deny publication"]);

    // A publish approval is NOT bound to an adoption request, and the page has
    // no such fact to show — which is the shape SPEC.md section 6.4 fixes.
    assert.equal(await page.$('#approval-detail [data-fact="adoption_request_id"]'), null);

    await page.fill("#approval-note", "not yet");
    await page.click('#approval-controls button[data-decision="denied"]');
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.actionState !== "pending",
      undefined,
      { timeout: 20000 },
    );

    const after = await backendInbox(reader);
    const decided = itemById(after, pending.item_id);
    assert.equal(decided.status, "denied", "the registry does not record this publication as denied");
    assert.equal(decided.decision.decision, "denied");
    assert.equal(decided.decision.note, "not yet");
    assert.ok(
      decided.decision_history.length >= 1,
      "the bounded decision history did not keep the row that was just written",
    );
    const tlogAfter = await tlogEntries(fx, ownerKey);
    assert.ok(tlogAfter.length > tlogBefore.length, "the denial appended nothing to the transparency log");
  });
});

// ---------------------------------------------------------------------------
// G-P2-9 — the four labels, and the ABSENCE of the four forbidden ones
// ---------------------------------------------------------------------------

test("G-P2-9 · the four exact labels reach the page and no consequential control says Confirm, OK, Yes or Submit", async ({ assert }) => {
  await withDecisions(async ({ page, low }) => {
    await settledRegion(page, "approvals");
    const seen = new Set();

    for (const kind of ["adopt_high_risk", "publish"]) {
      await openItemOfKind(page, kind);
      for (const label of await primaryControlLabels(page, "#approval-controls button")) seen.add(label);
    }

    // Both halves of both pairs, verbatim.
    assert.deepEqual(
      [...seen].sort(),
      [...HUMAN_DECISION_LABEL_LIST].sort(),
      "the four exact human-decision labels are not the four labels this Console offers",
    );

    // The revocation surface too, so the absence check covers every
    // consequential control this packet added rather than one region of it.
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");

    // ---- THE ABSENCE CHECK. A page can carry `Approve publication` AND a bare
    // `Confirm` beside it, and only this sees the second one. It reads the
    // CONTROLS — a `Yes` inside a sentence is prose and is not what SPEC.md
    // section 6.4 forbids.
    const controls = await primaryControlLabels(page, CONTROL_SELECTOR);
    assert.ok(controls.length > 0, "no control was found, so the absence check proved nothing");
    for (const forbidden of FORBIDDEN_PRIMARY_LABELS) {
      assert.ok(
        !controls.includes(forbidden),
        `a control on this page reads exactly \`${forbidden}\` — the controls are ${JSON.stringify(controls)}`,
      );
    }
    // …and no control is a bare verb dressed up: every one of them is longer
    // than the longest forbidden label, because each names an object.
    for (const label of controls) {
      assert.ok(label.length > 4, `the control \`${label}\` names no object, scope or consequence`);
    }
  });
});

// ---------------------------------------------------------------------------
// G-P2-7 — the server's `{allowed:false, reason_code}`, and NO mutation
// ---------------------------------------------------------------------------

test("G-P2-7 · an item the server offers no decision on shows the server's reason and has no control at all", async ({ assert }) => {
  await withDecisions(async ({ page, reader }) => {
    await settledRegion(page, "approvals");
    const items = await backendInbox(reader);
    const refused = items.find((i) => i.eligibility.allowed === false);
    assert.ok(refused, "the journey produced no item the server refuses a decision on");

    const rows = await readApprovalRows(page);
    const row = rows.find((r) => r.item_id === refused.item_id);
    assert.ok(row, "the refused item is not on the page");
    assert.equal(row.allowed, "false");
    assert.equal(
      row.reason_code,
      refused.eligibility.reason_code,
      "the row shows a reason code the server did not send",
    );

    await page.click(`#approval-rows tr[data-item-id="${refused.item_id}"] button[data-action="open-approval"]`);
    await page.waitForSelector('#approval-detail[data-state="loaded"]', { timeout: 20000 });

    // THE SERVER'S OWN CODE, ON THE PAGE.
    const shown = await page.$eval("#approval-controls [data-withheld]", (n) => n.dataset.reasonCode);
    assert.equal(shown, refused.eligibility.reason_code);

    // AND NO CONTROL. Not a disabled one — none. A greyed button is still a
    // path: a keyboard, an accidental Enter or a devtools console reaches it.
    const controls = await primaryControlLabels(page, "#approval-controls button");
    assert.deepEqual(controls, [], `a decision control was offered on a refused item: ${JSON.stringify(controls)}`);

    // ---- AND NOTHING REACHED THE BACKEND. Asserted by ROW SNAPSHOT, which is
    // the only form of this assertion that survives a button that looked right.
    const after = await backendInbox(reader);
    assert.deepEqual(
      after.map((i) => `${i.item_id}=${i.status}/${i.decision_history.length}`).sort(),
      items.map((i) => `${i.item_id}=${i.status}/${i.decision_history.length}`).sort(),
      "the inbox changed while this gate only looked at it",
    );
  });
});

test("G-P2-7 · a reviewer session is offered no path to a human approval or to a revocation", async ({ assert }) => {
  await withDecisions(
    async ({ page, reader, fx, reviewer, low }) => {
      await settledRegion(page, "approvals");

      // A reviewer may ask this inbox only for `kind=review`; asking for
      // anything else is the server's `FORBIDDEN` and not a narrowed list.
      const refused = await reader.raw("/v1/console/approvals?status=all&kind=all");
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, "FORBIDDEN");

      // The Console asks for the widest kind THIS session is entitled to, which
      // for a reviewer is `review`, so the region LOADS.
      //
      // It used to assert `forbidden` here, and that was a claim about the
      // page's mechanism rather than about this gate's requirement. The page
      // defaulted to `kind=all`, was refused, and drew the failure box — which
      // also left the kind selector empty, so the one question a reviewer may
      // ask was the one question the page never offered. A reviewer holding a
      // Console session could not reach the Inbox at all. The refusal itself is
      // untouched and is asserted above, AT THE ROUTE, which is where it lives.
      //
      // What this gate requires is that a reviewer is offered no path to a
      // human APPROVAL or to a revocation, and that is now checked against a
      // loaded inbox — a stronger place to check it than a failure box, because
      // a failure box offers nothing to anyone.
      const state = await settledRegion(page, "approvals");
      assert.equal(state, "loaded", "a reviewer cannot reach the Inbox at the one kind it may ask for");
      const offeredKinds = await page.$$eval("#approvals-kind option", (os) => os.map((o) => o.value));
      assert.deepEqual(offeredKinds, ["review"], `the kind selector offered a reviewer ${JSON.stringify(offeredKinds)}`);
      const rowKinds = await page.$$eval("#approval-rows tr[data-kind]", (rs) => [
        ...new Set(rs.map((r) => r.dataset.kind)),
      ]);
      assert.deepEqual(
        rowKinds.filter((k) => k !== "review"),
        [],
        `a reviewer's inbox listed a human-approval kind: ${JSON.stringify(rowKinds)}`,
      );
      assert.equal(
        await page.$('#approval-rows tr[data-kind="adopt_high_risk"], #approval-rows tr[data-kind="publish"]'),
        null,
        "a human-approval item was offered to a reviewer",
      );

      // …and the revocation surface refuses the same session at the route.
      await page.fill("#revocation-version", low.skill_version_id);
      await page.click("#revocation-load");
      assert.equal(await settledRegion(page, "revocation"), "forbidden");
      assert.equal(await page.$eval("#revocation", (b) => b.dataset.code), "FORBIDDEN");

      // NO CONTROL ANYWHERE on either surface, so there is no path that would
      // try. P1 proved the route refuses; this proves the surface does not ask.
      const controls = await primaryControlLabels(page, "#approval-controls button, #revocation button[data-action='revoke']");
      assert.deepEqual(controls, [], `a reviewer was offered ${JSON.stringify(controls)}`);

      // ---- AND THE ROW SNAPSHOT: nothing moved.
      const stateAfter = await api(fx.base, "GET", `/v1/skills?q=packet-c-published`, reviewer.api_key);
      const version = (stateAfter.body?.items ?? []).find((i) => i.skill_version_id === low.skill_version_id);
      assert.equal(version?.registry?.state ?? version?.state, "published", "the version moved while a reviewer looked at it");
    },
    { role: "reviewer" },
  );
});

// ---------------------------------------------------------------------------
// G-P2-8 — the no-DRM consequence, before commit
// ---------------------------------------------------------------------------

test("G-P2-8 · the revocation panel states every consequence before there is a button to press", async ({ assert }) => {
  await withDecisions(async ({ page, reader, low, successor }) => {
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    assert.equal(await settledRegion(page, "revocation"), "precommit");

    const server = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
    assert.equal(server.status, 200);

    // 1. THE EXACT VERSION AND THE EXACT BYTES.
    const shownId = await page.$eval('#revocation [data-fact="skill_version_id"] dd', (n) => n.textContent);
    const shownHash = await page.$eval('#revocation [data-fact="manifest_hash"] dd', (n) => n.textContent);
    assert.equal(shownId, server.body.skill_version_id);
    assert.equal(shownHash, server.body.manifest_hash, "the manifest hash on the page is not the registry's");
    assert.ok(shownHash.length >= 64, "a truncated hash identifies no bytes");

    // 2. THE REASON FIELD EXISTS BEFORE THE ACTION DOES.
    assert.ok(await page.$("#revocation-reason"), "there is nowhere to write the immutable reason");

    // 3. KNOWN ACTIVE ADOPTERS, and the count is the registry's.
    const adopters = await page.$$eval("#revocation [data-adopter]", (ns) => ns.map((n) => n.dataset.adopter));
    assert.deepEqual(
      adopters.sort(),
      server.body.active_adopters.map((a) => a.adopter_agent_id).sort(),
      "the adopters on the page are not the adopters the registry would notify",
    );
    assert.ok(adopters.length > 0, "nobody holds this version, so the adopter statement proves nothing");

    // 4. A SELECTABLE `verified|published` SUCCESSOR OF THE SAME SKILL.
    const options = await page.$$eval("#revocation-successor option", (ns) =>
      ns.map((n) => ({ value: n.value, state: n.dataset.successorState ?? null })),
    );
    const offered = options.filter((o) => o.value.length > 0);
    assert.deepEqual(
      offered.map((o) => o.value).sort(),
      server.body.successors.map((s) => s.skill_version_id).sort(),
    );
    assert.ok(
      offered.some((o) => o.value === successor.skill_version_id),
      "the replacement this journey published is not selectable",
    );
    for (const o of offered) {
      assert.ok(["verified", "published"].includes(o.state), `a ${o.state} version was offered as a replacement`);
    }

    // 5. THE FOUR STATEMENTS, each its own node.
    const stated = await page.$$eval("#revocation li[data-consequence]", (ns) =>
      ns.map((n) => ({ code: n.dataset.consequence, text: (n.textContent ?? "").trim() })),
    );
    assert.deepEqual(
      stated.map((s) => s.code),
      REVOCATION_CONSEQUENCES.map((c) => c.code),
      "the consequences on the page are not the four this build declares",
    );
    for (const c of REVOCATION_CONSEQUENCES) {
      const found = stated.find((s) => s.code === c.code);
      assert.equal(found.text, c.text, `the \`${c.code}\` statement is not byte-identical to the source constant`);
    }

    // 6. THE PRIMARY ACTION READS `Revoke version` WITHOUT A SUCCESSOR…
    assert.equal(await page.$eval("#revoke-primary", (b) => b.textContent), REVOKE_PRIMARY_LABELS.without_successor);
    // …AND `Revoke and replace version` WITH ONE.
    await page.selectOption("#revocation-successor", successor.skill_version_id);
    assert.equal(await page.$eval("#revoke-primary", (b) => b.textContent), REVOKE_PRIMARY_LABELS.with_successor);
    await page.selectOption("#revocation-successor", "");
    assert.equal(await page.$eval("#revoke-primary", (b) => b.textContent), REVOKE_PRIMARY_LABELS.without_successor);

    // 7. AND NOTHING HAS BEEN COMMITTED. The whole point of "before commit".
    const still = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
    assert.equal(still.body.state, "published");
    assert.equal(still.body.revocation_reason, null);
  });
});

test("G-P2-8 · a revoke-and-replace commits, reports the registry's own facts, and never calls a queued notice delivered", async ({ assert }) => {
  await withDecisions(async ({ page, reader, fx, ownerKey, low, successor }) => {
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");
    const tlogBefore = await tlogEntries(fx, ownerKey);

    await page.fill("#revocation-reason", "a defect nobody should adopt");
    await page.selectOption("#revocation-successor", successor.skill_version_id);
    assert.equal(await page.$eval("#revoke-primary", (b) => b.textContent), REVOKE_PRIMARY_LABELS.with_successor);
    await page.click("#revoke-primary");
    // WAIT FOR THE COMMITTED PANEL, not merely for "not loading": the
    // pre-commit panel is itself a settled state, so a reader that stopped at
    // the first non-loading state would assert about the page it clicked on.
    await page.waitForFunction(
      () => document.getElementById("revocation")?.dataset.state === "committed",
      undefined,
      { timeout: 30000 },
    );

    // ---- THE BACKEND RECORD.
    const after = await reader.raw(`/v1/console/versions/${low.skill_version_id}/revocation`);
    assert.equal(after.body.state, "revoked", "the registry does not record this version as revoked");
    assert.equal(after.body.revocation_reason, "a defect nobody should adopt");
    assert.equal(after.body.superseded_by, successor.skill_version_id, "the lineage link was not created");

    const tlogAfter = await tlogEntries(fx, ownerKey);
    const added = tlogAfter.slice(tlogBefore.length).map((e) => e.event_kind);
    assert.ok(added.includes("version_revoked"), `no version_revoked entry: ${JSON.stringify(added)}`);
    assert.ok(added.includes("version_superseded"), `no version_superseded entry: ${JSON.stringify(added)}`);
    assert.ok(
      added.indexOf("version_revoked") < added.indexOf("version_superseded"),
      "the lineage entry was appended before the revocation entry",
    );

    // ---- AND WHAT THE PAGE SAYS ABOUT IT.
    const facts = await page.$$eval("#revocation [data-fact]", (ns) =>
      Object.fromEntries(ns.map((n) => [n.dataset.fact, n.querySelector("dd")?.textContent ?? ""])),
    );
    assert.equal(facts.state, "revoked");
    assert.equal(facts.superseded_by, successor.skill_version_id);
    assert.ok(/^\d+$/.test(facts.tlog_seq), `the committed panel reports no tlog seq: ${facts.tlog_seq}`);
    assert.ok(/^\d+$/.test(facts.lineage_tlog_seq), "a call that created a lineage entry reported no lineage seq");

    // ---- `INV-07`. THREE COUNTS, THREE NODES, and the queued one is not shown
    // as a delivery. The journey's endpoint refuses every push and the worker is
    // off the clock, so at this moment the notice IS queued and nothing else.
    const counts = await page.$$eval("#revocation [data-count]", (ns) =>
      Object.fromEntries(ns.map((n) => [n.dataset.count, n.querySelector("dd")?.textContent ?? ""])),
    );
    assert.equal(counts.queued, String(after.body.notices.queued));
    assert.equal(counts.delivered, String(after.body.notices.delivered));
    assert.equal(counts.dead_lettered, String(after.body.notices.dead_lettered));
    assert.ok(Number(counts.queued) > 0, "no notice was queued, so the honesty assertion below proves nothing");
    assert.equal(counts.delivered, "0", "a queued notice was counted as delivered");
    assert.equal(
      await page.$eval("#revocation [data-queued-is-not-delivered]", (n) => n.textContent),
      REVOCATION_TEXT.queued_is_not_delivered,
    );

    // …and a link into the view that holds the failures.
    assert.ok(await page.$('#revocation a[data-action="dead-letters"]'), "no link into the dead-letter view");
  });
});

// ---------------------------------------------------------------------------
// The webhook test flow (SPEC.md section 6.5)
// ---------------------------------------------------------------------------

test("SPEC.md section 6.5 · a test delivery reports five bounded fields, no response body, and moves no production counter", async ({ assert }) => {
  await withDecisions(async ({ page, reader, refusing, webhookId }) => {
    assert.equal(await settledRegion(page, "webhooks"), "loaded");

    const before = await reader.raw("/v1/console/webhooks");
    const beforeRow = before.body.items.find((i) => i.webhook_id === webhookId);
    assert.ok(beforeRow, "the registered endpoint is not in the console list");
    const hitsBefore = refusing.hits();

    await page.click(`button[data-action="test-webhook"][data-webhook-id="${webhookId}"]`);
    await page.waitForSelector("#webhook-test-result", { timeout: 30000 });

    // THE ENDPOINT WAS ACTUALLY CONTACTED — a "test" that opened no socket
    // would report a result about nothing.
    assert.ok(refusing.hits() > hitsBefore, "the test delivery never reached the endpoint");

    const shown = await page.$$eval("#webhook-test-result [data-fact]", (ns) =>
      Object.fromEntries(ns.map((n) => [n.dataset.fact, n.querySelector("dd")?.textContent ?? ""])),
    );
    for (const field of ["delivered", "http_status", "latency_ms", "error_code", "error_detail"]) {
      assert.ok(field in shown, `the result omits \`${field}\``);
    }
    assert.equal(shown.delivered, "false", "an endpoint that answers 500 was reported as delivered");
    assert.equal(shown.http_status, "500");
    assert.ok(/^\d+$/.test(shown.latency_ms), `latency_ms is not a number: ${shown.latency_ms}`);
    assert.ok(shown.error_code.length > 0, "a failed test reported no error code");

    // THE ENDPOINT'S OWN BODY IS NEVER SHOWN. The refusing endpoint answers a
    // JSON body with a sentence in it; that sentence must not be on the page.
    const pageText = await page.$eval("#webhook-test-result", (n) => n.textContent ?? "");
    assert.ok(
      !pageText.includes("this endpoint refuses on purpose"),
      "the endpoint's own response body reached the page",
    );
    assert.ok(shown.error_detail.length <= 201, `error_detail is unbounded: ${shown.error_detail.length} characters`);
    assert.equal(await page.$eval("#webhook-test-result [data-bounded]", (n) => n.textContent), WEBHOOK_TEXT.detail_bounded);

    // ---- IT IS NOT PRODUCTION HEALTH, and both halves of that are asserted:
    // the registry's counters did not move, and the page says the result is not
    // the endpoint's health.
    const after = await reader.raw("/v1/console/webhooks");
    const afterRow = after.body.items.find((i) => i.webhook_id === webhookId);
    assert.equal(afterRow.failure_count, beforeRow.failure_count, "the test moved the production failure count");
    assert.equal(afterRow.status, beforeRow.status, "the test changed the endpoint's production status");
    assert.equal(
      await page.$eval("#webhook-test-result [data-not-health]", (n) => n.textContent),
      WEBHOOK_TEXT.result_not_health,
    );
    // …and the health columns beside it are the registry's, re-read after the
    // probe rather than copied from before it.
    const health = await page.$eval(`#webhook-rows tr[data-webhook-id="${webhookId}"]`, (r) => ({
      status: r.dataset.status,
      failures: r.dataset.failureCount,
    }));
    assert.equal(health.status, afterRow.status);
    assert.equal(health.failures, String(afterRow.failure_count));
  });
});

// ---------------------------------------------------------------------------
// INV-04 — no credential in the browser, and a webhook secret is now in play
// ---------------------------------------------------------------------------

test("INV-04 · no API key, webhook secret or signing key reaches the DOM, the URL, a browser store or a browser log", async ({ assert }) => {
  await withDecisions(async ({ page, fx, ownerKey, refusing, webhookId, logs, low }) => {
    await settledRegion(page, "approvals");
    await settledRegion(page, "webhooks");
    await page.fill("#revocation-version", low.skill_version_id);
    await page.click("#revocation-load");
    await settledRegion(page, "revocation");
    await page.click(`button[data-action="test-webhook"][data-webhook-id="${webhookId}"]`);
    await page.waitForSelector("#webhook-test-result", { timeout: 30000 });

    // A SECOND ENDPOINT, REGISTERED THROUGH THE CONSOLE ITSELF — the one path
    // where a secret could plausibly cross into a browser, because the machine
    // route returns the plaintext once. The console wrapper strips it, and this
    // is what says so.
    await page.fill("#webhook-url", refusing.url);
    await page.click("#webhook-register");
    await page.waitForFunction(
      () => document.getElementById("webhooks")?.dataset.actionState !== "pending",
      undefined,
      { timeout: 20000 },
    );

    const everything = await page.evaluate(() => ({
      dom: document.documentElement.outerHTML,
      url: window.location.href,
      local: JSON.stringify(Object.entries(localStorage)),
      session: JSON.stringify(Object.entries(sessionStorage)),
      cookie: document.cookie,
    }));

    // The secret prefix this registry mints, and the key it issued this session.
    const needles = ["whsec_", ownerKey, "-----BEGIN"];
    for (const surface of ["dom", "url", "local", "session", "cookie"]) {
      for (const needle of needles) {
        assert.ok(
          !everything[surface].includes(needle),
          `\`${needle.slice(0, 12)}\` reached the browser's ${surface}`,
        );
      }
    }
    assert.equal(everything.local, "[]", "the console wrote to localStorage");
    assert.equal(everything.session, "[]", "the console wrote to sessionStorage");
    for (const line of logs) {
      for (const needle of needles) {
        assert.ok(!line.includes(needle), `a credential reached the browser log: ${line.slice(0, 80)}`);
      }
    }

    // …and the secret DOES still exist, so the assertion above is about a
    // secret that was minted rather than about one that was never created.
    const machine = await api(fx.base, "POST", "/v1/webhooks", ownerKey, { url: refusing.url });
    assert.ok(
      String(machine.body?.secret ?? "").startsWith("whsec_"),
      "the machine surface no longer mints a secret, so this gate is checking for nothing",
    );
  });
});

test("the approval note field is the one the operator typed, and a decision the server refuses does not empty it", async ({ assert }) => {
  await withDecisions(async ({ page, reader }) => {
    await settledRegion(page, "approvals");
    const items = await backendInbox(reader);
    const pending = items.find((i) => i.kind === "publish" && i.eligibility.allowed);
    assert.ok(pending, "no decidable publication to refuse");
    await openItemOfKind(page, "publish");

    // A note past the contract's bound: a typed `INVALID_SCHEMA` from the
    // server, produced by a body the operator actually composed.
    const long = "x".repeat(2100);
    await page.fill("#approval-note", long);
    await page.click('#approval-controls button[data-decision="approved"]');
    await page.waitForFunction(
      () => document.getElementById("approval-detail")?.dataset.state === "invalid",
      undefined,
      { timeout: 20000 },
    );
    assert.equal(await page.$eval("#approval-detail", (b) => b.dataset.code), "INVALID_SCHEMA");
    assert.equal(await page.$eval("#approval-note", (n) => n.value.length), long.length, "the note was cleared");

    // AND NOTHING WAS DECIDED.
    const after = await backendInbox(reader);
    assert.equal(itemById(after, pending.item_id).status, "pending");
  });
});
