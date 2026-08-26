// THE PROOFLINE BROWSER GATES — G-P2-4, G-P2-5, and the §7 rows of G-P2-10 that
// belong to the Proofline column.
//
// WHAT COUNTS AS A RESULT IN THIS FILE. Every assertion resolves against the
// DOM or against a backend record. Nothing here takes a screenshot, and nothing
// here asserts about a colour, a position or a picture. "The page looked right"
// is not a result — it is the failure mode the P2 gate manifest names as the
// likeliest one of this phase, because P2 is the first phase whose deliverable
// is a user interface.
//
// AND THE DATA IS NOT A FIXTURE. `journey()` (test-browser/lib/fixture.mjs)
// drives the shipped REST surface with the shipped credentials: bootstrap
// exchange, search, adoption request, adoption, webhook registration. A row
// seeded into SQLite would prove a table renders; it would not prove the path an
// operator takes reaches the page.
import { test, newContext, signIn, settled, navigateTo } from "./lib/harness.mjs";
import { startServer, startRefusingEndpoint, journey, mintTicket, consoleReader, api } from "./lib/fixture.mjs";
import {
  readCells,
  readSections,
  readNotices,
  readPartial,
  readNav,
  readTextNodes,
  readAnswerMarks,
  readBrowserStores,
} from "./lib/dom.mjs";
import {
  CONSOLE_FIRST_VIEW,
  DELIVERY_CLAIM_WORDS,
  FORBIDDEN_RENDERED_ANSWERS,
  INV03_ANSWERS,
  PROOFLINE_TEXT,
  parseCell,
  partialDetail,
  refusalDetail,
} from "../src/console-proofline.ts";
import { DASHBOARD_VIEWS } from "../src/dashboard.ts";
import { DELIVERY_SEPARATION_LEGEND } from "../src/fleet-dashboard.ts";

/**
 * A deployment, a journey through it, a browser and a real Console login.
 *
 * `withConsole` owns the whole lifecycle and closes every one of them in a
 * `finally`, including on a failing assertion. Every address it hands out is
 * `127.0.0.1` on an ephemeral port.
 */
async function withConsole(body, opts = {}) {
  const refusing = opts.journey === false ? null : await startRefusingEndpoint();
  const fx = await startServer({
    env: { ...process.env, SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK: "1" },
  });
  fx.refusing = refusing;
  let ctx = null;
  try {
    const j = opts.journey === false ? await minimalJourney(fx) : await journey(fx);
    const reader = await consoleReader(fx.base, j.ownerKey);
    ctx = await newContext(fx.base, opts);
    const ticket = await mintTicket(fx.base, j.ownerKey);
    const page = await signIn(ctx.context, fx.base, ticket);
    await body({ fx, j, reader, page, ...ctx });
  } finally {
    if (ctx !== null) await ctx.context.close();
    fx.close();
    if (refusing !== null) refusing.close();
  }
}

/** The owner key and nothing else — the deployment as it is on its first run,
 *  which is what the `empty never-had-any` and `sparse` states are ABOUT. */
async function minimalJourney(fx) {
  const creds = fx.inst.credentials;
  const r = await api(fx.base, "POST", "/v1/auth/bootstrap", undefined, {
    bootstrap_token: creds.bootstrap_owner_token,
  });
  return { ownerKey: r.body.api_key, steps: [{ what: "exchange the bootstrap token", status: r.status, ok: true }] };
}

// ===========================================================================
// G-P2-4 — all eleven views reachable, BY NAVIGATING
// ===========================================================================

test("G-P2-4 · after a real Console login all eleven Proofline views are reached by clicking", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    // The navigation is built from the payload's own `views`, so the list under
    // test is the SERVER's vocabulary and not a list this test typed out. It is
    // then compared to `DASHBOARD_VIEWS` so a view the registry serves and the
    // Console does not offer fails here.
    const first = await reader.view(CONSOLE_FIRST_VIEW);
    assert.equal(first.status, 200, "the reader session could not open the first view");
    const served = first.body.views;
    assert.deepEqual([...served].sort(), [...DASHBOARD_VIEWS].sort(), "the payload's view list is not the registry's");
    assert.equal(served.length, 11, `the registry serves ${served.length} views, not eleven`);

    const nav = await readNav(page);
    assert.deepEqual(nav.map((n) => n.view), [...served], "the navigation the browser drew is not the server's list");

    const reached = [];
    for (const view of served) {
      // A CLICK. Not a fetch, not `goto` — the gate is that the operator gets
      // there by navigating, and a test that asked the route for its JSON would
      // satisfy nothing.
      const state = await navigateTo(page, view);
      assert.equal(state, "loaded", `${view} did not load: state=${state}`);
      const opened = await page.$eval("#proofline", (b) => ({
        view: b.dataset.view,
        title: b.querySelector("h2")?.textContent ?? null,
        sections: b.querySelectorAll("section[data-section-key]").length,
      }));
      assert.equal(opened.view, view);
      // the title is the SERVER's title for that view
      const payload = await reader.view(view);
      assert.equal(opened.title, payload.body.title, `${view} rendered a title the server did not send`);
      assert.ok(opened.sections > 0, `${view} rendered no section at all`);
      // and the address bar names it, so a reload and the back button work
      assert.match(page.url(), new RegExp(`#/proofline/${view}$`), `${view} did not become the page's address`);
      reached.push(view);
    }
    assert.equal(reached.length, 11, `only ${reached.length} views were reached`);
  });
});

// ===========================================================================
// G-P2-5 — provenance survives the render, byte for byte
// ===========================================================================

test("G-P2-5 · every cell keeps value, kind, why, source, window and bounds", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    let comparedCells = 0;
    let withMethod = 0;
    for (const view of DASHBOARD_VIEWS) {
      await navigateTo(page, view);
      const payload = await reader.view(view);
      assert.equal(payload.status, 200, `${view} was not served to the reader session`);

      // THE EXPECTATION IS THE SERVER'S OWN BYTES. Every cell of every row of
      // every section, keyed the way the DOM reader keys them, so a row the
      // browser skipped is a missing key and not a silently shorter list.
      const expected = new Map();
      for (const s of payload.body.sections) {
        s.rows.forEach((row, r) => {
          for (const field of s.fields) {
            if (row[field] === undefined) continue;
            expected.set(`${s.key}#${r}/${field}`, row[field]);
          }
        });
      }

      const rendered = await readCells(page);
      const seen = new Map();
      for (const c of rendered) seen.set(`${c.section}#${c.row}/${c.field}`, c);

      for (const [key, text] of expected) {
        const cell = seen.get(key);
        assert.ok(cell !== undefined, `${view}: the page did not render ${key}`);
        // BYTE FOR BYTE. The DOM reader reassembles the answer and every part of
        // the method from the nodes the renderer created; if a `source:` was
        // dropped or a `boundary:` shortened, these two strings differ.
        assert.equal(cell.rendered, text, `${view}: provenance changed between the server and the page at ${key}`);

        // …and the six the contract names are individually present wherever the
        // server put them, so "the strings match" cannot be true of two equally
        // truncated strings.
        const parsed = parseCell(text);
        assert.equal(cell.value, parsed.value, `${view}: ${key} rendered a different answer`);
        for (const attr of ["kind", "why", "source", "window", "boundary"]) {
          const want = parsed.parts.find((p) => p.key === attr);
          if (want === undefined) continue;
          assert.ok(
            cell.rendered.includes(`${attr}: ${want.text}`),
            `${view}: ${key} lost its ${attr === "boundary" ? "bounds" : attr}`,
          );
          withMethod += 1;
        }
        comparedCells += 1;
      }
      assert.equal(seen.size, expected.size, `${view}: the page rendered ${seen.size} cells and the server sent ${expected.size}`);
    }
    assert.ok(comparedCells > 0, "no cell was compared, so this gate proved nothing");
    assert.ok(withMethod > 0, "no method attribute was compared, so this gate proved nothing");
    process.stdout.write(`#   cells compared against the server's bytes: ${comparedCells}; method attributes checked: ${withMethod}\n`);
  });
});

// ===========================================================================
// INV-03 — unknown, nothing_reported, worked and broke stay four things
// ===========================================================================

test("INV-03 · unknown is never a zero and the four answers are told apart in the DOM", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    // The four marks are read off the STYLESHEET THE SERVER SHIPPED, applied to
    // four probe cells, and compared for distinctness. Not a picture: the
    // computed `content` of each `::before`, which is what a person sees beside
    // the word and what a monochrome screen still shows.
    const marks = await readAnswerMarks(page, [...INV03_ANSWERS]);
    const values = Object.values(marks);
    assert.equal(new Set(values).size, values.length, `two of the four answers carry the same mark: ${JSON.stringify(marks)}`);
    for (const [answer, mark] of Object.entries(marks)) {
      assert.ok(mark !== "none" && mark !== "" && mark !== '""', `${answer} carries no mark of its own: ${mark}`);
    }

    let unknowns = 0;
    let distinctAnswers = new Set();
    for (const view of DASHBOARD_VIEWS) {
      await navigateTo(page, view);
      const payload = await reader.view(view);
      const rendered = await readCells(page);
      const byKey = new Map(rendered.map((c) => [`${c.section}#${c.row}/${c.field}`, c]));
      for (const s of payload.body.sections) {
        s.rows.forEach((row, r) => {
          for (const field of s.fields) {
            const text = row[field];
            if (text === undefined) continue;
            const want = parseCell(text).value;
            const got = byKey.get(`${s.key}#${r}/${field}`);
            distinctAnswers.add(want);
            // NEVER A ZERO, NEVER A DASH, NEVER NOTHING.
            assert.ok(
              !FORBIDDEN_RENDERED_ANSWERS.includes(got.value),
              `${view}: ${s.key}/${field} rendered the answer as ${JSON.stringify(got.value)}`,
            );
            if (want === "unknown") {
              unknowns += 1;
              assert.equal(got.value, "unknown", `${view}: an unknown value did not render as unknown`);
              assert.deepEqual(got.answerClass, ["answer-unknown"], `${view}: an unknown cell carries no class of its own`);
            }
            // the class token IS the answer, so two answers cannot land on one
            assert.deepEqual(
              got.answerClass,
              [`answer-${want.toLowerCase().replace(/[^a-z0-9_]+/g, "-").slice(0, 40)}`.slice(0, 47)],
              `${view}: ${s.key}/${field} carries a class that is not its answer`,
            );
          }
        });
      }
    }
    assert.ok(unknowns > 0, "no unknown value appeared anywhere, so the INV-03 assertion had nothing to bite on");
    process.stdout.write(`#   unknown answers rendered: ${unknowns}; distinct answers across the eleven views: ${distinctAnswers.size}\n`);

    // `worked` and `broke` are two COLUMNS of the outcomes view and they stay two
    // columns: two cells, two values, two methods, never one merged figure.
    await navigateTo(page, "outcomes");
    const outcomes = await reader.view("outcomes");
    const pair = outcomes.body.sections.find((s) => s.fields.includes("worked") && s.fields.includes("broke"));
    assert.ok(pair !== undefined, "the outcomes view no longer carries a worked column beside a broke column");
    const cells = await readCells(page);
    const worked = cells.filter((c) => c.section === pair.key && c.field === "worked");
    const broke = cells.filter((c) => c.section === pair.key && c.field === "broke");
    assert.equal(worked.length, broke.length, "the two columns did not render the same number of rows");
    assert.equal(worked.length, pair.rows.length, "the outcomes rows the server sent are not the rows on the page");
    // TWO COLUMNS, TWO CELLS, TWO HEADINGS. They are not required to SAY
    // different things — two counts of zero are two counts of zero — but they
    // must stay two separately addressable cells under two separate headers, so
    // a reader can never take one number for both facts.
    const headers = await page.$$eval(
      `#proofline section[data-section-key="${pair.key}"] thead th`,
      (ths) => ths.map((t) => t.textContent),
    );
    assert.ok(headers.includes("worked") && headers.includes("broke"), `the two columns lost their headings: ${JSON.stringify(headers)}`);
    assert.notEqual(headers.indexOf("worked"), headers.indexOf("broke"), "worked and broke share one column");
    for (let i = 0; i < worked.length; i += 1) {
      assert.equal(worked[i].rendered, pair.rows[i].worked, "a worked cell is not the server's worked cell");
      assert.equal(broke[i].rendered, pair.rows[i].broke, "a broke cell is not the server's broke cell");
      assert.notEqual(worked[i].field, broke[i].field, "the two facts landed in one cell");
    }
  });
});

// ===========================================================================
// INV-07 — queued is not delivered, and the Console adds no word of its own
// ===========================================================================

test("INV-07 · dead_letters keeps adoption state and notification delivery apart", async ({ assert }) => {
  await withConsole(async ({ page, reader }) => {
    await navigateTo(page, "dead_letters");
    const payload = await reader.view("dead_letters");

    // TWO SECTIONS, TWO FACTS, NEVER MERGED.
    const sections = await readSections(page);
    assert.deepEqual(
      sections.map((s) => s.key),
      payload.body.sections.map((s) => s.key),
      "the page did not draw the server's sections, in the server's order",
    );
    assert.ok(sections.length >= 2, "the two dead-letter facts were drawn as fewer than two sections");
    assert.equal(new Set(sections.map((s) => s.key)).size, sections.length, "two sections share one key");
    for (const s of sections) {
      assert.ok(s.heading !== null && s.heading.length > 0, `${s.key} was drawn with no heading of its own`);
    }

    // THE LEGEND, BYTE FOR BYTE, from the source constant the server serves.
    const notices = await readNotices(page);
    const legend = notices.find((n) => n.heading === `${DELIVERY_SEPARATION_LEGEND.kind}: ${DELIVERY_SEPARATION_LEGEND.subject}`);
    assert.ok(legend !== undefined, `the queued-is-not-delivered legend is not on the page: ${JSON.stringify(notices)}`);
    assert.equal(legend.detail, DELIVERY_SEPARATION_LEGEND.detail, "the legend was reworded on its way to the page");

    // AND THE CONSOLE INVENTS NOTHING. Every text node in the region is either a
    // string the server sent in this payload or a constant declared in
    // `src/console-proofline.ts`. A Console that cannot add a word cannot add
    // the word `delivered`.
    const fromServer = new Set();
    const addServer = (v) => {
      if (typeof v === "string" && v.length > 0) fromServer.add(v);
    };
    addServer(payload.body.title);
    for (const v of payload.body.views) addServer(v);
    for (const n of payload.body.notices) {
      addServer(`${n.kind}: ${n.subject}`);
      addServer(n.detail);
    }
    for (const s of payload.body.sections) {
      addServer(s.title);
      addServer(s.empty);
      addServer(s.note);
      for (const f of s.fields) addServer(f);
      for (const row of s.rows) {
        for (const text of Object.values(row)) {
          const parsed = parseCell(text);
          addServer(parsed.value);
          for (const p of parsed.parts) {
            addServer(p.text);
            if (p.key !== null) addServer(p.key);
          }
        }
      }
    }
    const ours = new Set([...Object.values(PROOFLINE_TEXT), "demo_mode"]);
    const unexplained = [];
    for (const node of await readTextNodes(page)) {
      if (fromServer.has(node) || ours.has(node)) continue;
      unexplained.push(node);
    }
    assert.deepEqual(unexplained, [], "the Console put text on the dead_letters view that came from neither the server nor its declared constants");

    // …and the word this invariant is about is not among the Console's own.
    for (const word of DELIVERY_CLAIM_WORDS) {
      for (const own of ours) {
        assert.ok(
          !own.toLowerCase().includes(word),
          `a constant this Console adds to a dashboard claims an arrival: ${JSON.stringify(own)}`,
        );
      }
    }
  });
});

// ===========================================================================
// INV-04 — no credential reaches the browser
// ===========================================================================

test("INV-04 · no API key, secret or signing key is in the DOM, the URL or a browser store", async ({ assert }) => {
  await withConsole(async ({ page, j, foreign, logs }) => {
    const secrets = [j.ownerKey, j.adopterKey].filter((s) => typeof s === "string" && s.length > 0);
    assert.ok(secrets.length >= 1, "the journey produced no credential to look for, so this gate proves nothing");

    for (const view of DASHBOARD_VIEWS) {
      await navigateTo(page, view);
      const stores = await readBrowserStores(page);
      assert.deepEqual(stores.localStorage, {}, `${view}: localStorage is not empty`);
      assert.deepEqual(stores.sessionStorage, {}, `${view}: sessionStorage is not empty`);
      // the session cookie is HttpOnly, so a page that can read a cookie at all
      // is a page holding one it was not meant to
      assert.equal(stores.cookie, "", `${view}: a cookie is readable from script: ${stores.cookie}`);
      for (const secret of secrets) {
        assert.ok(!stores.html.includes(secret), `${view}: a credential is in the DOM`);
        assert.ok(!stores.url.includes(secret), `${view}: a credential is in the URL`);
      }
      assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(stores.html), `${view}: a private key is in the DOM`);
    }
    for (const line of logs) {
      for (const secret of secrets) assert.ok(!line.includes(secret), `a credential reached a browser log: ${line}`);
    }
    // and nothing off this deployment was ever requested
    assert.deepEqual(foreign, [], "the page tried to reach a host this run did not start");
  });
});
