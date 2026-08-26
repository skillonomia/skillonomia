// G-P2-11 — THE ACCESSIBILITY SCAN, AND THE KEYBOARD PATH THAT STARTS AT SIGN-IN.
//
// WHAT IS ALREADY PROVED ELSEWHERE, so that this file adds evidence rather than
// repeats it. `test-browser/states.mjs` completes the Proofline's primary path
// by keyboard and fixes a mobile and a desktop viewport over it;
// `test-browser/decision-states.mjs` does the same for the approval, revocation
// and webhook surfaces, including a decision and a revocation carried out from
// the keyboard alone. Those are the matrix's own `keyboard/focus` and
// `compact/wide viewport` cells and they are not re-run here.
//
// WHAT IS NOT PROVED ANYWHERE ELSE, and is therefore this file's subject:
//
//   1. AN ACTUAL ACCESSIBILITY SCAN. A page can be reachable by keyboard and
//      still be unusable — an input with no accessible name, a control whose
//      contrast a person cannot read, a region with no role. `@axe-core/playwright`
//      is in the control install for this, and it is run over the sign-in page
//      and over the owner console with its decision surfaces open.
//   2. THE SIGN-IN PAGE ITSELF. Every keyboard gate in this suite begins AFTER
//      `signIn`, which fills the ticket field programmatically. So the first
//      screen an owner ever touches — the one that stands between them and the
//      console — has never been driven from the keyboard. It is driven here,
//      from the first Tab to the redirect.
//   3. NO ACTION LOST SIDEWAYS ON THE SIGN-IN PAGE, at the same fixed mobile
//      and desktop viewports the other two files use.
//
// A MISSING SCANNER IS A FAILURE. The harness loads `@axe-core/playwright`
// optionally, because a missing scanner is not a missing browser. Here it is
// required: a run that skipped the scan and reported the gate green would be
// reporting a scan that did not happen.
import { test, newContext, settled } from "./lib/harness.mjs";
import { withDecisions, settledRegion } from "./lib/decisions.mjs";
import { mintTicket } from "./lib/fixture.mjs";

/** The scan's own bar: `serious` and `critical` are the two axe severities that
 *  describe a barrier rather than a preference. */
const BLOCKING = new Set(["serious", "critical"]);

/** `@axe-core/playwright` ships as CommonJS and has been published with the
 *  builder on `default` and on a named export in different versions. Reading
 *  both is one line; guessing wrong is a gate that cannot start. */
function builderFrom(axe) {
  const B = axe?.AxeBuilder ?? axe?.default?.AxeBuilder ?? axe?.default;
  if (typeof B !== "function") {
    throw new Error(
      "the accessibility scanner did not load from the control install. G-P2-11 is a scan; a run that " +
        "skipped it is not a pass. Install `@axe-core/playwright` beside `playwright` in the control install.",
    );
  }
  return B;
}

async function scan(axe, page, name) {
  const AxeBuilder = builderFrom(axe);
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations
    .filter((v) => BLOCKING.has(v.impact))
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length} node(s), first: ${v.nodes[0]?.target?.join(" ")})`);
  return { name, blocking, checked: results.passes.length, total: results.violations.length };
}

/**
 * The controls a person can actually press, with the box each occupies.
 *
 * `offsetParent === null` is not enough on its own — a `position: fixed`
 * element has none — so visibility is read from the rectangle, which is what
 * "on the page" means for the two questions below.
 */
async function actionBoxes(page) {
  return page.$$eval("button, a[href], input, select, [tabindex]:not([tabindex='-1'])", (nodes) =>
    nodes
      .map((n) => {
        const r = n.getBoundingClientRect();
        const s = window.getComputedStyle(n);
        return {
          text: (n.textContent || n.getAttribute("aria-label") || n.id || n.tagName).trim().slice(0, 40),
          x: r.x, y: r.y, w: r.width, h: r.height,
          hidden: s.visibility === "hidden" || s.display === "none" || r.width === 0 || r.height === 0,
        };
      })
      .filter((b) => !b.hidden),
  );
}

// ===========================================================================
// the scan
// ===========================================================================

test("G-P2-11 · an accessibility scan of the sign-in page and of the owner console finds no serious or critical barrier", async ({ assert, axe }) => {
  const reports = [];
  await withDecisions(async ({ fx, page }) => {
    // The console, with its decision surfaces settled. Scanning it mid-load
    // would scan a spinner.
    await settled(page);
    await settledRegion(page, "approvals");
    reports.push(await scan(axe, page, "/console"));

    // The sign-in page, in a context of its own so the console session does not
    // redirect away from it.
    const fresh = await newContext(fx.base);
    try {
      const login = await fresh.context.newPage();
      await login.goto(`${fx.base}/console/login`);
      await login.waitForSelector("#ticket");
      reports.push(await scan(axe, login, "/console/login"));
    } finally {
      await fresh.context.close();
    }

  });

  for (const r of reports) {
    process.stdout.write(`# [G-P2-11] axe ${r.name}: ${r.checked} checks passed, ${r.total} violations, ${r.blocking.length} blocking\n`);
  }
  const blocking = reports.flatMap((r) => r.blocking.map((b) => `${r.name} — ${b}`));
  assert.deepEqual(blocking, [], `the accessibility scan found barriers:\n  ${blocking.join("\n  ")}`);
  // A SCAN THAT CHECKED NOTHING IS NOT A CLEAN SCAN. axe reports what it
  // verified; an empty `passes` list means the scanner never ran over the page.
  for (const r of reports) assert.ok(r.checked > 0, `${r.name}: the scanner verified nothing, so its silence means nothing`);
});

// ===========================================================================
// the sign-in page, by keyboard alone
// ===========================================================================

test("G-P2-11 · an owner reaches the console from the sign-in page by keyboard alone, with visible focus", async ({ assert }) => {
  await withDecisions(
    async ({ fx, ownerKey }) => {
      const ticket = await mintTicket(fx.base, ownerKey);
      const fresh = await newContext(fx.base);
      try {
        const login = await fresh.context.newPage();
        await login.goto(`${fx.base}/console/login`);
        await login.waitForSelector("#ticket");

        // TAB FROM THE TOP OF THE DOCUMENT, not `focus()`. The question is
        // whether the field is REACHABLE, and calling focus() answers a
        // different one.
        let reached = false;
        for (let press = 0; press < 20 && !reached; press += 1) {
          await login.keyboard.press("Tab");
          reached = await login.evaluate(() => document.activeElement?.id === "ticket");
        }
        assert.ok(reached, "the ticket field cannot be reached from the keyboard");

        // VISIBLE FOCUS, read off the element that actually holds it.
        const focusStyle = await login.evaluate(() => {
          const s = window.getComputedStyle(document.activeElement);
          return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow };
        });
        assert.notEqual(
          `${focusStyle.outlineStyle}|${focusStyle.boxShadow}`,
          "none|none",
          `the focused sign-in field draws no visible focus (${JSON.stringify(focusStyle)})`,
        );

        // AND THE FIELD HAS AN ACCESSIBLE NAME. A person using a screen reader
        // is told what to type here or they are told nothing.
        const named = await login.evaluate(() => {
          const node = document.getElementById("ticket");
          const label = document.querySelector('label[for="ticket"]');
          return (node?.getAttribute("aria-label") || label?.textContent || "").trim();
        });
        assert.ok(named.length > 0, "the sign-in field has no accessible name");

        await login.keyboard.type(ticket);
        let submitted = false;
        for (let press = 0; press < 6 && !submitted; press += 1) {
          await login.keyboard.press("Tab");
          submitted = await login.evaluate(
            () => document.activeElement?.tagName === "BUTTON" && document.activeElement?.type === "submit",
          );
        }
        assert.ok(submitted, "the sign-in button cannot be reached from the keyboard");
        await login.keyboard.press("Enter");
        await login.waitForURL(`${fx.base}/console`, { timeout: 20000 });
        await login.waitForSelector("#proofline[data-state]", { state: "attached", timeout: 20000 });
        process.stdout.write("# [G-P2-11] the sign-in page was completed with Tab, typing and Enter\n");
      } finally {
        await fresh.context.close();
      }
    },
    { webhook: false },
  );
});

// ===========================================================================
// the sign-in page at both fixed viewports
// ===========================================================================

test("G-P2-11 · the sign-in page loses no action sideways and overlaps nothing at either fixed viewport", async ({ assert }) => {
  const VIEWPORTS = [
    { name: "mobile", width: 375, height: 667 },
    { name: "desktop", width: 1280, height: 900 },
  ];
  await withDecisions(
    async ({ fx }) => {
      for (const viewport of VIEWPORTS) {
        const fresh = await newContext(fx.base, { viewport: { width: viewport.width, height: viewport.height } });
        try {
          const login = await fresh.context.newPage();
          await login.goto(`${fx.base}/console/login`);
          await login.waitForSelector("#ticket");

          // NO HORIZONTAL LOSS: the document does not scroll sideways.
          const overflow = await login.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
          }));
          assert.ok(
            overflow.scroll <= overflow.client + 1,
            `${viewport.name}: the sign-in document scrolls sideways (${overflow.scroll}px of content in ${overflow.client}px)`,
          );

          const boxes = await actionBoxes(login);
          assert.ok(boxes.length >= 2, `${viewport.name}: only ${boxes.length} controls were found on the sign-in page`);
          for (const b of boxes) {
            assert.ok(
              b.x >= -1 && b.x + b.w <= viewport.width + 1,
              `${viewport.name}: the control \`${b.text}\` runs past the ${viewport.width}px viewport`,
            );
          }
          // NO OVERLAP between two controls a person is meant to press.
          for (let i = 0; i < boxes.length; i += 1) {
            for (let k = i + 1; k < boxes.length; k += 1) {
              const a = boxes[i];
              const c = boxes[k];
              const overlaps = a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
              assert.ok(!overlaps, `${viewport.name}: \`${a.text}\` and \`${c.text}\` overlap on the sign-in page`);
            }
          }
          process.stdout.write(`# [G-P2-11] sign-in at ${viewport.name} ${viewport.width}x${viewport.height}: ${boxes.length} controls, none clipped, none overlapping\n`);
        } finally {
          await fresh.context.close();
        }
      }
    },
    { webhook: false },
  );
});
