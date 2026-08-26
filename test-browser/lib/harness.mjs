// THE BROWSER HARNESS — the part every later packet reuses.
//
// It is deliberately small: a test registry, a browser lifecycle, a Console
// login that goes through the actual sign-in page, and a set of assertions. It
// is NOT a test framework — `node:assert` is the assertion library and this file
// adds nothing to it.
//
// TWO RULES IT ENFORCES ON EVERY TEST THAT USES IT:
//
//   1. EVERY SERVER AND EVERY BROWSER IS CLOSED IN A `finally`. A gate that
//      leaked a listener would make the next run's port allocation the previous
//      run's problem, and a leaked browser is a process nobody owns.
//   2. NOTHING OUTSIDE `127.0.0.1` IS EVER CONTACTED. The browser context is
//      created with a route handler that ABORTS any request whose origin is not
//      the deployment this run started, so a page that grew a third-party asset
//      fails the run instead of quietly fetching it.
import assert from "node:assert/strict";
import { loadPlaywright, skipBanner, SKIPPED_EXIT } from "./playwright.mjs";

const tests = [];

/** Register one gate. `name` is what the report prints. */
export function test(name, fn) {
  tests.push({ name, fn });
}

/** The browser, opened once for the whole run — launching Chromium per test
 *  costs more than every assertion in this suite put together. */
let browser = null;

export async function newContext(base, opts = {}) {
  const context = await browser.newContext({
    baseURL: base,
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    ...opts.contextOptions,
  });
  // THE ORIGIN FENCE. Everything this page may load is the deployment under
  // test. A request anywhere else is aborted AND recorded, so a gate can assert
  // the list is empty rather than trusting that it is.
  const foreign = [];
  await context.route("**/*", (route, request) => {
    const url = request.url();
    if (url.startsWith(base) || url.startsWith("data:") || url.startsWith("about:")) {
      return route.continue();
    }
    foreign.push(url);
    return route.abort();
  });
  const logs = [];
  context.on("console", (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  context.on("pageerror", (e) => logs.push(`pageerror: ${String(e)}`));
  return { context, foreign, logs };
}

/**
 * A REAL CONSOLE LOGIN.
 *
 * The ticket is minted on the SERVER side with the owner's API key and typed
 * into the sign-in page's field, which is what an operator does. The browser
 * never holds the API key — `INV-04` is a property of this path and not a wish
 * about it, and the gate that checks the browser's stores checks them after
 * this function has run.
 */
export async function signIn(context, base, ticket) {
  const page = await context.newPage();
  await page.goto(`${base}/console/login`);
  await page.fill("#ticket", ticket);
  await page.click('#login button[type="submit"]');
  await page.waitForURL(`${base}/console`, { timeout: 15000 });
  await page.waitForSelector("#proofline[data-state]", { state: "attached", timeout: 15000 });
  return page;
}

/** Wait for the Proofline region to settle into a terminal state. `loading` is
 *  not one: a gate that read the DOM mid-flight would be asserting about a
 *  spinner. */
export async function settled(page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const box = document.getElementById("proofline");
      return box !== null && box.dataset.state !== undefined && box.dataset.state !== "loading";
    },
    undefined,
    { timeout },
  );
  return page.$eval("#proofline", (b) => b.dataset.state);
}

/** Click a Proofline navigation link — the way an operator reaches a view.
 *  Navigation, not a fetch: the gate for the eleven views is explicitly not
 *  satisfied by asking the route for its JSON. */
export async function navigateTo(page, view) {
  // The state is stamped `loading` synchronously by the click handler, so a
  // reader that waited only for "not loading" could observe the PREVIOUS view's
  // finished state. Waiting for the region to name the new view first removes
  // that race without a sleep.
  await page.click(`#proofline-nav a[data-view="${view}"]`);
  await page.waitForFunction(
    (v) => document.getElementById("proofline")?.dataset.view === v,
    view,
    { timeout: 15000 },
  );
  return settled(page);
}

/**
 * THE RUNNER.
 *
 * Sequential on purpose: every test starts a deployment and a browser context,
 * and running them in parallel would make a failure's cause depend on how many
 * cores the machine has.
 */
export async function run() {
  const loaded = loadPlaywright();
  if (!loaded.ok) {
    process.stdout.write(skipBanner(loaded.reason));
    process.exit(SKIPPED_EXIT);
  }
  process.stdout.write(`# playwright from ${loaded.dir}\n`);
  browser = await loaded.playwright.chromium.launch();
  let pass = 0;
  const failures = [];
  try {
    for (const t of tests) {
      const started = Date.now();
      try {
        await t.fn({ assert, axe: loaded.axe });
        pass += 1;
        process.stdout.write(`ok ${pass + failures.length} - ${t.name} (${Date.now() - started}ms)\n`);
      } catch (e) {
        failures.push({ name: t.name, error: e });
        process.stdout.write(`not ok ${pass + failures.length} - ${t.name} (${Date.now() - started}ms)\n`);
        process.stdout.write(`  ${String(e && e.stack ? e.stack : e).split("\n").join("\n  ")}\n`);
      }
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`1..${tests.length}\n# pass ${pass}\n# fail ${failures.length}\n`);
  if (failures.length > 0) process.exit(1);
}
