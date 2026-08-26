// THE §7 UX STATE MATRIX — the Proofline column, and only the Proofline column.
//
// The matrix's OWN TRIGGER COLUMN is the definition of each test below, and each
// test names the trigger it used. The nine cells marked `R` for `Proofline view`
// each have exactly one test here:
//
//   initial loading        delayed first response; labeled busy state
//   empty never-had-any    zero rows; first valid action shown
//   filtered-to-zero       populated fixture + nonmatching filter; clear-filter action
//   sparse/populated       canonical sparse and populated fixtures
//   partial                unknown dashboard cells; known facts remain visible
//   permission denied      typed FORBIDDEN; no mutation
//   network/server error   injected transport/500; bounded recovery action
//   compact/wide viewport  fixed mobile/desktop viewport; no overlap/horizontal action loss
//   keyboard/focus         complete primary path by keyboard; visible focus
//
// The five cells the matrix marks `N/A` for this column — action loading,
// validation error, disabled, stale/concurrent decision, idempotent replay — HAVE
// NO TEST HERE, on purpose. A Proofline view is a read: there is no mutation to
// be in flight, no body to be invalid, no control the server disables, no
// decision another session can take out from under it and no key to replay.
// Inventing tests for them would be inventing states the specification says are
// unreachable.
import { test, newContext, signIn, settled, navigateTo } from "./lib/harness.mjs";
import { startServer, startRefusingEndpoint, journey, mintTicket, consoleReader, api } from "./lib/fixture.mjs";
import { readCells, readSections, readPartial, readNav, readTextNodes } from "./lib/dom.mjs";
import { CONSOLE_FIRST_VIEW, PROOFLINE_TEXT, parseCell, partialDetail, refusalDetail } from "../src/console-proofline.ts";

// A REGEXP, not a glob: the request under test is
// `http://127.0.0.1:<ephemeral>/v1/console/dashboard/<view>` and a pattern that
// silently matched nothing would make every interception test pass by not
// intercepting anything.
const DASHBOARD_PATTERN = /\/v1\/console\/dashboard\//;

/** Click a navigation link and wait for the region to BE that view. Without the
 *  second half a reader can observe the previous view's finished state. */
async function clickView(page, view) {
  await page.click(`#proofline-nav a[data-view="${view}"]`);
  await page.waitForFunction((v) => document.getElementById("proofline")?.dataset.view === v, view, { timeout: 15000 });
  return settled(page);
}

/** A deployment with the journey's data in it, and a signed-in Console. The
 *  caller gets the page and the raw pieces; every one of them is closed here. */
async function withConsole(body, opts = {}) {
  const refusing = opts.journey === false ? null : await startRefusingEndpoint();
  const fx = await startServer({ env: { ...process.env, SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK: "1" } });
  fx.refusing = refusing;
  let ctx = null;
  try {
    const j = opts.journey === false ? await bootstrapOnly(fx) : await journey(fx);
    const reader = await consoleReader(fx.base, j.ownerKey);
    ctx = await newContext(fx.base, opts);
    if (opts.beforeLogin) await opts.beforeLogin({ fx, context: ctx.context });
    const ticket = await mintTicket(fx.base, j.ownerKey);
    const page = await signIn(ctx.context, fx.base, ticket);
    await body({ fx, j, reader, page, ...ctx });
  } finally {
    if (ctx !== null) await ctx.context.close();
    fx.close();
    if (refusing !== null) refusing.close();
  }
}

async function bootstrapOnly(fx) {
  const r = await api(fx.base, "POST", "/v1/auth/bootstrap", undefined, {
    bootstrap_token: fx.inst.credentials.bootstrap_owner_token,
  });
  return { ownerKey: r.body.api_key };
}

// ---------------------------------------------------------------------------

test("§7 initial loading · TRIGGER: delayed first response; the region is labelled busy", async ({ assert }) => {
  let released = null;
  await withConsole(
    async ({ page }) => {
      // The delay is on the DASHBOARD request only, so the login and the shell
      // are unaffected and what is observed is the first response for a VIEW.
      const seen = await page.evaluate(() => {
        const box = document.getElementById("proofline");
        return { state: box.dataset.state, busy: box.getAttribute("aria-busy") };
      });
      // The page was opened while the request was held, so this is the state a
      // person sees before any value has been read.
      assert.equal(seen.state, "loading", `the region was not busy while the first response was held: ${seen.state}`);
      assert.equal(seen.busy, "true", "the busy state is not announced to assistive technology");
      const text = await readTextNodes(page);
      assert.ok(text.includes(PROOFLINE_TEXT.loading), `the busy label is not the declared one: ${JSON.stringify(text)}`);
      // NOTHING IS CLAIMED WHILE BUSY: no section, no cell, no partial banner.
      assert.deepEqual(await readSections(page), [], "the page drew sections before it had an answer");
      assert.deepEqual(await readCells(page), [], "the page drew cells before it had an answer");

      released();
      await settled(page);
      assert.equal(await page.$eval("#proofline", (b) => b.getAttribute("aria-busy")), "false");
      assert.ok((await readSections(page)).length > 0, "the view never arrived after the response was released");
    },
    {
      journey: false,
      async beforeLogin({ context }) {
        const hold = new Promise((resolve) => {
          released = resolve;
        });
        await context.route(DASHBOARD_PATTERN, async (route) => {
          await hold;
          await route.continue();
        });
      },
    },
  );
});

test("§7 empty never-had-any · TRIGGER: zero rows on a first-run deployment; the view stays navigable", async ({ assert }) => {
  await withConsole(
    async ({ page, reader }) => {
      // A DEPLOYMENT NOBODY HAS USED. Nothing was seeded into a table and nothing
      // was deleted to make it empty: this is the first run, and the rows that do
      // not exist have never existed.
      let emptySections = 0;
      for (const view of ["dead_letters", "receipts", "migrations"]) {
        await navigateTo(page, view);
        const payload = await reader.view(view);
        const sections = await readSections(page);
        for (const s of sections) {
          const served = payload.body.sections.find((x) => x.key === s.key);
          if (served.rows.length !== 0) continue;
          emptySections += 1;
          // THE SERVER'S OWN SENTENCE, not a dash and not "no results".
          assert.equal(s.rows, "empty", `${view}/${s.key} was not marked as an empty table`);
          assert.ok(
            s.text.includes(served.empty),
            `${view}/${s.key} did not say what the server says about being empty: ${JSON.stringify(served.empty)}`,
          );
          assert.ok(
            !s.text.includes(PROOFLINE_TEXT.filtered_to_zero),
            `${view}/${s.key} blamed a filter for a table that has never had a row`,
          );
        }
        // THE FIRST VALID ACTION IS STILL OFFERED: the eleven views are all still
        // one click away, so an operator who lands on an empty view is not stuck
        // on it.
        const nav = await readNav(page);
        assert.equal(nav.length, 11, `${view}: the navigation collapsed on an empty view`);
        assert.equal(nav.find((n) => n.view === view).current, "page", `${view}: the navigation lost its place`);
      }
      assert.ok(emptySections > 0, "no section was empty, so this state was never observed");
    },
    { journey: false },
  );
});

test("§7 filtered-to-zero · TRIGGER: populated view + a filter matching nothing; a clear-filter action", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    await navigateTo(page, CONSOLE_FIRST_VIEW);
    const populated = await readSections(page);
    const before = populated.filter((s) => Number(s.rows) > 0);
    assert.ok(before.length > 0, "the view under test has no rows, so filtering it to zero proves nothing");

    // The filter is typed into the page's own control and sent as the same `?q=`
    // the registry's search takes. Nothing is deleted and no fixture changes.
    await page.fill("#proofline-filter", "zzz-no-skill-has-this-slug-zzz");
    await page.dispatchEvent("#proofline-filter", "change");
    await settled(page);

    const after = await readSections(page);
    const zeroed = after.filter((s) => s.rows === "filtered-to-zero");
    assert.ok(zeroed.length > 0, `no section reported being filtered to zero: ${JSON.stringify(after.map((s) => s.rows))}`);
    for (const s of zeroed) {
      assert.ok(s.text.includes(PROOFLINE_TEXT.filtered_to_zero), `${s.key} did not say the filter, not the registry, emptied it`);
      const clear = s.actions.find((a) => a.action === "clear-filter");
      assert.ok(clear !== undefined, `${s.key} offers no way back`);
      assert.equal(clear.label, PROOFLINE_TEXT.clear_filter, "the clear-filter action is not the declared label");
    }

    // AND THE ACTION WORKS: the rows come back, and they are the server's rows.
    // The wait is for the filtered-to-zero marker to be GONE — a wait on "not
    // loading" alone can observe the filtered render, which is still a finished
    // state.
    await page.click('#proofline section button[data-action="clear-filter"]');
    await page.waitForFunction(
      () => {
        const box = document.getElementById("proofline");
        return (
          box !== null &&
          box.dataset.state === "loaded" &&
          box.querySelector('section[data-rows="filtered-to-zero"]') === null
        );
      },
      undefined,
      { timeout: 15000 },
    );
    const restored = await readSections(page);
    const payload = await reader.view(CONSOLE_FIRST_VIEW);
    for (const s of payload.body.sections) {
      const drawn = restored.find((x) => x.key === s.key);
      assert.ok(drawn !== undefined, `${s.key} did not come back`);
      if (s.rows.length > 0) assert.equal(Number(drawn.rows), s.rows.length, `${s.key} came back with the wrong number of rows`);
    }
  });
});

test("§7 sparse/populated · TRIGGER: the same view on a first-run deployment and after a real adoption", async ({ assert }) => {
  const counts = {};
  const measure = (label, opts) =>
    withConsole(
      async ({ page, reader }) => {
        await navigateTo(page, "receipts");
        const payload = await reader.view("receipts");
        const sections = await readSections(page);
        const cells = await readCells(page);
        counts[label] = {
          rows: payload.body.sections.reduce((n, s) => n + s.rows.length, 0),
          drawn: sections.reduce((n, s) => n + (Number(s.rows) || 0), 0),
          cells: cells.length,
        };
        // BOTH SHAPES RENDER. A sparse view is not a broken view.
        assert.ok(sections.length > 0, `${label}: no section was drawn`);
        assert.equal(counts[label].drawn, counts[label].rows, `${label}: the page drew a different number of rows than the server sent`);
      },
      opts,
    );

  await measure("sparse", { journey: false });
  await measure("populated", {});
  assert.ok(
    counts.populated.rows > counts.sparse.rows,
    `the journey added no row to the view under test: ${JSON.stringify(counts)}`,
  );
  process.stdout.write(`#   sparse ${JSON.stringify(counts.sparse)} · populated ${JSON.stringify(counts.populated)}\n`);
});

test("§7 partial · TRIGGER: unknown dashboard cells; the known facts stay on the page", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    let observed = 0;
    for (const view of ["fleet", "agent", "capability", "outcomes", "library"]) {
      await navigateTo(page, view);
      const payload = await reader.view(view);
      let unknown = 0;
      let total = 0;
      const known = [];
      for (const s of payload.body.sections) {
        s.rows.forEach((row, r) => {
          for (const field of s.fields) {
            const text = row[field];
            if (text === undefined) continue;
            total += 1;
            if (parseCell(text).value === "unknown") unknown += 1;
            else known.push({ key: `${s.key}#${r}/${field}`, text });
          }
        });
      }
      if (unknown === 0) continue;
      observed += 1;

      // THE PARTIAL STATE IS NOT A LOADING STATE. The view is loaded, the banner
      // states what is unknown, and the counts in it are counts of what the
      // server sent.
      assert.equal(await page.$eval("#proofline", (b) => b.dataset.state), "loaded", `${view} is partial and reported itself busy`);
      const banner = await readPartial(page);
      assert.ok(banner !== null, `${view} has ${unknown} unknown values and said nothing about it`);
      assert.equal(banner.unknown, unknown, `${view}: the banner miscounts the unknown values`);
      assert.equal(banner.total, total, `${view}: the banner miscounts the values`);
      assert.equal(banner.heading, PROOFLINE_TEXT.partial_heading);
      assert.equal(banner.detail, partialDetail(unknown, total), `${view}: the banner is not the declared sentence`);

      // …AND THE KNOWN FACTS ARE STILL THERE, each with its own method. This is
      // the whole content of the state: unknown is not a reason to stop showing
      // what was read.
      const rendered = new Map((await readCells(page)).map((c) => [`${c.section}#${c.row}/${c.field}`, c]));
      assert.ok(known.length > 0, `${view}: every value is unknown, so "the known facts remain" has nothing to assert`);
      for (const k of known) {
        const cell = rendered.get(k.key);
        assert.ok(cell !== undefined, `${view}: the known value at ${k.key} is not on the page`);
        assert.equal(cell.rendered, k.text, `${view}: the known value at ${k.key} changed on its way to the page`);
      }
    }
    assert.ok(observed > 0, "no view carried an unknown value, so the partial state was never observed");
  });
});

test("§7 permission denied · RENDERER PROOF ONLY: the Proofline displays a real server FORBIDDEN; this is not an end-to-end refusal", async ({ assert }) => {
  await withConsole(async ({ page, reader, fx, j }) => {
    // WHAT THIS TEST PROVES, AND WHAT IT DOES NOT — narrowed by owner ruling
    // B-1 of 2026-08-26, which is recorded in the P2 evidence.
    //
    // A Proofline view CANNOT return a live `FORBIDDEN` to owner, admin or
    // reviewer: the route-level console ACL admits all three to every view. The
    // §7 `permission denied` cell for the Proofline column is therefore recorded
    // as `N/A — unreachable under current ACL`, which is what the matrix itself
    // provides for.
    //
    // So what follows is RENDERER PROOF and is described as nothing more: it
    // takes a REAL typed `FORBIDDEN` the running server produced, on a console
    // route it genuinely refuses this session, and delivers those exact bytes as
    // the answer to a dashboard request. The envelope, its code, its message and
    // its contract marker are the server's; only the request it answers is the
    // test's. It establishes that the Proofline DISPLAYS a typed server refusal
    // and mutates nothing while doing so.
    //
    // THE END-TO-END REFUSAL IS PROVED ELSEWHERE, against a route that genuinely
    // forbids the action: `test-browser/decision-states.mjs` drives a real
    // reviewer session into a live `403` on the revocation surface in a browser,
    // with no mutation. That test — not this one — is P2's end-to-end refusal.
    const refusals = [];
    for (const probe of [
      // A REAL ANTI-FORGERY REFUSAL. The token is not this session's, so the
      // server's own CSRF check answers a typed `FORBIDDEN` — a refusal this
      // deployment genuinely produces on this route, rather than one arranged by
      // leaving a header off and hoping the omission is still refused.
      {
        path: "/v1/console/versions/nonexistent-version/approvals",
        method: "POST",
        body: { scope: "publish", decision: "approved" },
        csrf: "not-the-token-this-session-holds",
      },
      { path: "/v1/console/versions/nonexistent-version/approvals", method: "POST", body: { scope: "publish", decision: "approved" } },
      { path: "/v1/console/webhooks/nonexistent/test", method: "POST", body: {} },
      { path: "/v1/console/dashboard/library", method: "GET" },
    ]) {
      const r = await reader.raw(probe.path, probe.method, probe.body, { csrf: probe.csrf });
      refusals.push({ probe, status: r.status, code: r.body?.error?.code, text: r.text });
    }
    const real = refusals.find((r) => r.code === "FORBIDDEN");
    assert.ok(
      real !== undefined,
      `no console route answered this session a typed FORBIDDEN, so no real refusal was available: ${JSON.stringify(refusals.map((r) => ({ p: r.probe.path, s: r.status, c: r.code })))}`,
    );

    // WHAT THE BACKEND HELD BEFORE. `no mutation` is asserted against rows, not
    // against the absence of a button.
    const before = await api(fx.base, "GET", "/v1/skills?q=", j.ownerKey);

    await page.route(DASHBOARD_PATTERN, (route) =>
      route.fulfill({ status: real.status, contentType: "application/json", body: real.text }),
    );
    const state = await clickView(page, "evidence");
    assert.equal(state, "forbidden", `a typed FORBIDDEN did not render as a refusal: ${state}`);

    // THE SERVER'S CODE AND THE SERVER'S MESSAGE, IN SUBSTANCE AND VERBATIM.
    const envelope = JSON.parse(real.text).error;
    const text = await readTextNodes(page);
    assert.ok(text.includes(PROOFLINE_TEXT.forbidden_heading), "the refusal was not announced as one");
    assert.ok(
      text.includes(refusalDetail(envelope.code, envelope.message)),
      `the server's own refusal is not on the page: ${JSON.stringify(text)}`,
    );
    // NO RETRY IS OFFERED for a refusal: retrying a FORBIDDEN is the Console
    // suggesting the server did not mean it.
    assert.equal(await page.$$eval('#proofline button[data-action="retry"]', (b) => b.length), 0);

    const after = await api(fx.base, "GET", "/v1/skills?q=", j.ownerKey);
    assert.deepEqual(after.body, before.body, "something in the registry changed while a refusal was on the screen");
  });
});

test("§7 network/server error · TRIGGER: an injected transport failure; a bounded recovery action", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    let fail = true;
    await page.route(DASHBOARD_PATTERN, async (route) => {
      if (!fail) return route.continue();
      // The transport dies. Not a 500 with a body the Console could read — the
      // harder of the two, because there is no envelope to fall back on.
      return route.abort("connectionfailed");
    });
    let state = await clickView(page, "approvals");
    assert.equal(state, "error", `a dead transport did not render as an error: ${state}`);
    const text = await readTextNodes(page);
    assert.ok(text.includes(PROOFLINE_TEXT.error_heading), "the failure was not announced");
    assert.ok(text.includes(PROOFLINE_TEXT.retry), "no bounded recovery action was offered");
    assert.deepEqual(await readCells(page), [], "the page drew cells it never received");

    // BOUNDED RECOVERY: one action, it is the operator's, and it works once the
    // transport does.
    fail = false;
    await page.click('#proofline button[data-action="retry"]');
    state = await settled(page);
    assert.equal(state, "loaded", "the recovery action did not recover the view");
    const payload = await reader.view("approvals");
    assert.equal(await page.$eval("#proofline h2", (h) => h.textContent), payload.body.title);

    // …and the same again for a server 500 carrying no readable envelope.
    let five = true;
    await page.route(DASHBOARD_PATTERN, async (route) => {
      if (!five) return route.continue();
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"contract":"console.v2","error":{"code":"INTERNAL","message":"injected"}}' });
    });
    state = await clickView(page, "migrations");
    assert.equal(state, "error", `an injected 500 did not render as an error: ${state}`);
    assert.ok((await readTextNodes(page)).includes(refusalDetail("INTERNAL", "injected")), "the server's own code and message are not shown");
    five = false;
    await page.click('#proofline button[data-action="retry"]');
    assert.equal(await settled(page), "loaded", "the recovery action did not recover the view after a 500");
  });
});

test("§7 compact/wide viewport · TRIGGER: fixed mobile and desktop viewports; no overlap, no action lost sideways", async ({ assert }) => {
  for (const viewport of [
    { label: "compact", width: 375, height: 720 },
    { label: "wide", width: 1440, height: 900 },
  ]) {
    await withConsole(
      async ({ page }) => {
        for (const view of ["library", "fleet", "dead_letters"]) {
          await navigateTo(page, view);
          // GEOMETRY FROM THE LAYOUT ENGINE, not from a picture of it. Two
          // questions, both answerable as numbers: is any navigation control
          // outside the viewport horizontally, and do two of them overlap.
          const report = await page.evaluate((w) => {
            const boxes = [...document.querySelectorAll("#proofline-nav a, #proofline button, #proofline-filter")].map((n) => {
              const r = n.getBoundingClientRect();
              return { label: n.textContent ?? n.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            });
            const offscreen = boxes.filter((b) => b.right > w + 0.5 || b.left < -0.5);
            const overlaps = [];
            for (let i = 0; i < boxes.length; i += 1) {
              for (let k = i + 1; k < boxes.length; k += 1) {
                const a = boxes[i];
                const b = boxes[k];
                const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (x > 1 && y > 1) overlaps.push([a.label, b.label]);
              }
            }
            return {
              count: boxes.length,
              offscreen,
              overlaps,
              documentWiderThanViewport: document.documentElement.scrollWidth > w + 1,
            };
          }, viewport.width);
          assert.ok(report.count > 0, `${viewport.label}/${view}: no control was measured`);
          assert.deepEqual(report.offscreen, [], `${viewport.label}/${view}: an action is off the side of the viewport`);
          assert.deepEqual(report.overlaps, [], `${viewport.label}/${view}: two controls overlap`);
          assert.equal(report.documentWiderThanViewport, false, `${viewport.label}/${view}: the page itself scrolls sideways`);
        }
      },
      { viewport: { width: viewport.width, height: viewport.height } },
    );
  }
});

test("§7 keyboard/focus · TRIGGER: the primary path completed by keyboard alone, with visible focus", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    // THE PRIMARY PATH OF THIS SURFACE is: reach the navigation, choose a view,
    // open it, and read a value. It is walked here with Tab and Enter and with
    // no click at all.
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.body.focus());
    let target = null;
    for (let i = 0; i < 40 && target === null; i += 1) {
      await page.keyboard.press("Tab");
      const here = await page.evaluate(() => {
        const a = document.activeElement;
        return a === null ? null : { tag: a.tagName, view: a.dataset ? a.dataset.view : undefined, id: a.id };
      });
      if (here && here.view === "outcomes") target = here;
    }
    assert.ok(target !== null, "the outcomes view could not be reached with the Tab key");

    // VISIBLE FOCUS, measured: the focused control's outline is not `none` and
    // has a width. This is a computed style, not an impression of one.
    const focusRing = await page.evaluate(() => {
      const s = window.getComputedStyle(document.activeElement);
      return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
    });
    assert.notEqual(focusRing.style, "none", `the focused control has no outline: ${JSON.stringify(focusRing)}`);
    assert.ok(parseFloat(focusRing.width) > 0, `the focus outline has no width: ${JSON.stringify(focusRing)}`);

    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("proofline")?.dataset.view === "outcomes", undefined, { timeout: 15000 });
    const state = await settled(page);
    assert.equal(state, "loaded", "the keyboard path did not open the view");

    // …and a value is actually readable at the end of the path.
    const payload = await reader.view("outcomes");
    const cells = await readCells(page);
    assert.ok(cells.length > 0, "the view opened by keyboard rendered no value");
    const first = payload.body.sections.flatMap((s) => s.rows.flatMap((row) => s.fields.map((f) => row[f]))).filter(Boolean)[0];
    assert.ok(
      cells.some((c) => c.rendered === first),
      "the value the server sent first is not among the ones the keyboard path put on the page",
    );

    // The filter control is reachable by keyboard too, which is the only other
    // control this surface offers.
    const reachable = await page.evaluate(() =>
      [...document.querySelectorAll("#proofline-nav a, #proofline-filter, #proofline button")].every(
        (n) => n.tabIndex >= 0 || n.tagName === "A" || n.tagName === "BUTTON" || n.tagName === "INPUT",
      ),
    );
    assert.ok(reachable, "a Proofline control cannot be reached from the keyboard");
  });
});
