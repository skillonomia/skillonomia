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
// So the browser engine normally lives OUTSIDE the repository, at a control
// install, and this module is the one place that knows where to search. An
// explicit `SKILLONOMIA_PLAYWRIGHT_DIR` wins; portable local and home-derived
// candidates follow it.
//
// WHAT HAPPENS WHEN IT IS NOT THERE. The suite DOES NOT RUN and DOES NOT PASS.
// It prints why, and exits `SKIPPED_EXIT` — a code that is neither 0 nor the
// failure code, so a caller cannot read "the browser gates were satisfied" out
// of a run in which no browser was started. A harness that quietly reports
// success when it did not run is worse than no harness.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The exit code that means "no browser was started, so nothing was proved". */
export const SKIPPED_EXIT = 3;

/** Every supported control-install location, in resolution order. */
export function playwrightCandidates({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const repository = resolve(cwd);
  const operatorHome = resolve(home);
  const fromEnv = env.SKILLONOMIA_PLAYWRIGHT_DIR;
  return [
    ...(fromEnv === undefined || fromEnv === "" ? [] : [resolve(repository, fromEnv)]),
    repository,
    join(repository, ".playwright"),
    join(repository, ".skillonomia", "tools", "v1.1-playwright"),
    join(repository, ".ductor-alan", "tools", "v1.1-playwright"),
    join(operatorHome, ".skillonomia", "tools", "v1.1-playwright"),
    join(operatorHome, ".ductor-alan", "tools", "v1.1-playwright"),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

/** Resolve the first candidate that contains the Playwright package. */
export function resolvePlaywrightDir({
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
  exists = existsSync,
} = {}) {
  const candidates = playwrightCandidates({ env, cwd, home });
  const dir = candidates.find((candidate) => exists(join(candidate, "node_modules", "playwright"))) ?? null;
  return { dir, candidates };
}

/** The selected control install, retained as a small compatibility helper. */
export function playwrightDir(options = {}) {
  return resolvePlaywrightDir(options).dir;
}

/**
 * The two modules the browser gates need, or `null` with the reason.
 *
 * `null` is returned rather than thrown so the runner can decide the exit code
 * once, in one place, instead of a `catch` at each call site guessing whether a
 * missing engine is a skip or a failure.
 */
export function loadPlaywright(options = {}) {
  const resolved = resolvePlaywrightDir(options);
  const { dir, candidates } = resolved;
  if (dir === null) {
    return {
      ok: false,
      dir,
      candidates,
      reason: `no \`playwright\` found; searched:\n${candidates.map((candidate) => `    ${candidate}`).join("\n")}`,
    };
  }
  const require_ = createRequire(join(dir, "package.json"));
  let playwright;
  let axe;
  try {
    playwright = require_("playwright");
  } catch (e) {
    return { ok: false, dir, candidates, reason: `\`playwright\` did not load from ${dir}: ${String(e)}` };
  }
  try {
    // Present in the control install and used by the accessibility gate of a
    // later packet. Loaded here so one module answers "what is available",
    // and optional so a missing scanner is not a missing browser.
    axe = require_("@axe-core/playwright");
  } catch {
    axe = null;
  }
  return { ok: true, dir, candidates, playwright, axe };
}

/** The message a run prints when it did not run. Loud, exact, and naming the
 *  override — a skip nobody can read is a skip somebody mistakes for a pass. */
export function skipBanner(reason) {
  return [
    "",
    "==============================================================",
    "  BROWSER GATES DID NOT RUN — NOTHING HERE IS A PASS",
    "==============================================================",
    `  reason: ${reason}`,
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
