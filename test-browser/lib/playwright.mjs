// WHERE PLAYWRIGHT COMES FROM, AND WHY IT IS NOT A DEPENDENCY OF THIS PACKAGE.
//
// The shipped package has exactly two runtime dependencies and the `ci`
// workflow's `supply-chain` job asserts that the npm lockfile agrees with
// `package.json`, that the bun lockfile agrees, that the installed toolchain is
// complete, and that `build:js` and `build:binary` are byte-reproducible. A
// browser engine added as a devDependency ripples into every one of those and
// into the artifact hashes the release phase has to certify — for a tool that is
// never part of the product.
//
// So the browser engine lives OUTSIDE the repository, at a control install, and
// this module is the one place that knows where. The path is overridable with
// `SKILLONOMIA_PLAYWRIGHT_DIR`; the default below is the documented location.
//
// WHAT HAPPENS WHEN IT IS NOT THERE. The suite DOES NOT RUN and DOES NOT PASS.
// It prints why, and exits `SKIPPED_EXIT` — a code that is neither 0 nor the
// failure code, so a caller cannot read "the browser gates were satisfied" out
// of a run in which no browser was started. A harness that quietly reports
// success when it did not run is worse than no harness.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** The control install the P2 gate manifest names. */
export const DEFAULT_PLAYWRIGHT_DIR = "/home/node/.ductor-alan/tools/v1.1-playwright";

/** The exit code that means "no browser was started, so nothing was proved". */
export const SKIPPED_EXIT = 3;

export function playwrightDir() {
  const fromEnv = process.env.SKILLONOMIA_PLAYWRIGHT_DIR;
  return fromEnv === undefined || fromEnv === "" ? DEFAULT_PLAYWRIGHT_DIR : fromEnv;
}

/**
 * The two modules the browser gates need, or `null` with the reason.
 *
 * `null` is returned rather than thrown so the runner can decide the exit code
 * once, in one place, instead of a `catch` at each call site guessing whether a
 * missing engine is a skip or a failure.
 */
export function loadPlaywright() {
  const dir = playwrightDir();
  if (!existsSync(join(dir, "node_modules", "playwright"))) {
    return { ok: false, dir, reason: `no \`playwright\` under ${join(dir, "node_modules")}` };
  }
  const require_ = createRequire(join(dir, "package.json"));
  let playwright;
  let axe;
  try {
    playwright = require_("playwright");
  } catch (e) {
    return { ok: false, dir, reason: `\`playwright\` did not load from ${dir}: ${String(e)}` };
  }
  try {
    // Present in the control install and used by the accessibility gate of a
    // later packet. Loaded here so one module answers "what is available",
    // and optional so a missing scanner is not a missing browser.
    axe = require_("@axe-core/playwright");
  } catch {
    axe = null;
  }
  return { ok: true, dir, playwright, axe };
}

/** The message a run prints when it did not run. Loud, exact, and naming the
 *  override — a skip nobody can read is a skip somebody mistakes for a pass. */
export function skipBanner(reason) {
  const dir = playwrightDir();
  return [
    "",
    "==============================================================",
    "  BROWSER GATES DID NOT RUN — NOTHING HERE IS A PASS",
    "==============================================================",
    `  reason: ${reason}`,
    `  looked in: ${dir}`,
    "",
    "  These gates need the Playwright control install, which is kept",
    "  OUTSIDE this repository on purpose (the shipped package has two",
    "  runtime dependencies and CI asserts byte-reproducible builds).",
    "",
    "  Point the harness at an install with:",
    "    SKILLONOMIA_PLAYWRIGHT_DIR=/path/to/install npm run test:browser",
    "",
    `  exit code ${SKIPPED_EXIT} means "did not run", not "passed".`,
    "==============================================================",
    "",
  ].join("\n");
}
