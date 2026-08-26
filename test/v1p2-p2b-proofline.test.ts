// THE PROOFLINE SURFACE'S PROPERTIES THAT DO NOT NEED A BROWSER.
//
// WHY THIS FILE EXISTS BESIDE THE BROWSER GATES. `test-browser/` runs under node
// only, needs a Chromium the repository deliberately does not depend on, and is
// therefore outside `npm test`. Everything below is a property of the SOURCE the
// bundle is built from, so it belongs in the suite both runtimes run and CI
// gates on — a property nobody checks without a browser installed is a property
// that quietly stops holding.
//
// The load-bearing one is the first: `src/console-proofline.ts` is bundled into
// a browser and so cannot import `src/fleet-dashboard.ts`, whose graph reaches
// node. The cell separator is therefore DECLARED in both. Two declarations of
// one fact is exactly the shape this project keeps removing, so the test below
// is what stands in for the import: they are compared byte for byte, and a
// change to one that is not made to the other fails here rather than in a
// browser somebody remembered to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  CONSOLE_FIRST_VIEW,
  DELIVERY_CLAIM_WORDS,
  FORBIDDEN_RENDERED_ANSWERS,
  INV03_ANSWERS,
  PROOFLINE_TEXT,
  PROVENANCE_FIELDS,
  PROVENANCE_KEY_SEP,
  PROVENANCE_SEP,
  answerToken,
  attrOf,
  formatCell,
  parseCell,
  partialDetail,
  refusalDetail,
} from "../src/console-proofline.ts";
import { SEP, labelCell, numberCell, observationCell, stateCell } from "../src/fleet-dashboard.ts";
import { registryCount, registryUnknown } from "../src/fleet-dashboard.ts";
import { DASHBOARD_VIEWS } from "../src/dashboard.ts";
import { consolePage } from "../src/console-page.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

test("the browser's cell separator IS the server's, and the key separator is the one the builders write", () => {
  assert.equal(PROVENANCE_SEP, SEP, "the bundle and the cell builders disagree about how a method is separated");
  // Every builder writes `key: value`, so the reader's key separator has to be
  // that. Asserted against a cell an actual builder produced rather than against
  // the literal, because the literal is what is under suspicion.
  const cell = labelCell("slug", "hello", "recorded_by_the_registry", "the registry, all time");
  assert.ok(cell.text.includes(`why${PROVENANCE_KEY_SEP}`), `a real cell does not use ${JSON.stringify(PROVENANCE_KEY_SEP)}`);
});

test("the view the Console opens first is a view the registry serves", () => {
  assert.ok(
    (DASHBOARD_VIEWS as readonly string[]).includes(CONSOLE_FIRST_VIEW),
    `the Console boots by asking for ${CONSOLE_FIRST_VIEW}, which the registry does not serve`,
  );
});

test("parsing a cell loses nothing — every builder's output survives a round trip", () => {
  const cells = [
    labelCell("slug", "hello-skillonomia", "recorded_by_the_registry", "skill_versions (registry), all time"),
    labelCell("note", "a value with : a colon in it, and a | pipe", "recorded_by_the_registry", "all time"),
    numberCell(registryCount(0, "outcome", "receipt_events, all time", "counted")),
    numberCell(registryUnknown("outcome", "receipt_events, all time", "no paired record exists")),
    observationCell({
      observation: "principal",
      answer: "unknown: no workspace role is recorded for this principal",
      why: "recorded_by_the_registry",
      source: "registry",
      window: "all_time",
      boundary: "the workspace roster and its memberships, all time",
    }),
  ];
  for (const cell of cells) {
    assert.equal(formatCell(parseCell(cell.text)), cell.text, `a round trip changed ${JSON.stringify(cell.text)}`);
  }
  // …and on shapes no builder produces, because the reader runs on whatever the
  // wire carries and a lossy branch is a dropped attribute on somebody's screen.
  for (const odd of ["", "bare", `a${SEP}`, `${SEP}b`, `a${SEP}b${SEP}c: d: e`, `x${SEP}: leading colon`]) {
    assert.equal(formatCell(parseCell(odd)), odd, `a round trip changed ${JSON.stringify(odd)}`);
  }
});

test("the answer is never split on a colon it happens to contain", () => {
  const text = `unknown: no workspace role is recorded${SEP}why: recorded_by_the_registry${SEP}kind: observation`;
  const parsed = parseCell(text);
  assert.equal(parsed.value, "unknown: no workspace role is recorded");
  assert.equal(attrOf(parsed, "why"), "recorded_by_the_registry");
  assert.equal(attrOf(parsed, "kind"), "observation");
});

test("the six pieces of provenance the contract names are all found in a real state cell", () => {
  const cell = stateCell({
    column: "invoked",
    runtime: "codex",
    value: "unknown",
    reason: null,
    reason_code: "no_paired_record",
    observed_at_ms: null,
    is: "observation",
    explicit: true,
    reliability: "reliable",
    observability: "observable",
    state: "invoked",
    source: "transcript",
    window: "all_time",
    window_detail: "the transcripts this registry holds, all time",
  });
  const parsed = parseCell(cell.text);
  for (const { field, attr } of PROVENANCE_FIELDS) {
    if (attr === null) {
      assert.ok(parsed.value.length > 0, "the cell carries no value");
      continue;
    }
    assert.ok(attrOf(parsed, attr) !== null, `a real state cell carries no ${field} (\`${attr}:\`)`);
  }
});

test("INV-03: the four answers reduce to four different class tokens, and none of them is a forbidden rendering", () => {
  const tokens = INV03_ANSWERS.map((a) => answerToken(a));
  assert.equal(new Set(tokens).size, tokens.length, `two of the four answers share a class token: ${tokens.join(", ")}`);
  for (const answer of INV03_ANSWERS) {
    assert.ok(!FORBIDDEN_RENDERED_ANSWERS.includes(answer), `${answer} is in the list of texts a cell may never be`);
    assert.equal(answerToken(answer), `answer-${answer}`, "the token is not the answer itself");
  }
  // `0` and `unknown` are two answers and must not collapse — the exact claim
  // INV-03 makes, checked at the one function that reduces an answer to a class.
  assert.notEqual(answerToken("0"), answerToken("unknown"));
});

test("INV-07: no sentence this Console adds to a dashboard claims that anything arrived", () => {
  for (const [key, text] of Object.entries(PROOFLINE_TEXT)) {
    for (const word of DELIVERY_CLAIM_WORDS) {
      assert.ok(
        !text.toLowerCase().includes(word),
        `PROOFLINE_TEXT.${key} claims an arrival with the word "${word}": ${JSON.stringify(text)}`,
      );
    }
  }
  for (const detail of [partialDetail(1, 2), refusalDetail("FORBIDDEN", "a reason the server gave")]) {
    for (const word of DELIVERY_CLAIM_WORDS) {
      assert.ok(!detail.toLowerCase().includes(word), `a generated Console sentence claims an arrival: ${detail}`);
    }
  }
});

test("the partial sentence states both counts and says what is still true", () => {
  const s = partialDetail(3, 14);
  assert.ok(s.includes("3 of 14"), s);
  assert.ok(s.includes("The other 11"), s);
  assert.ok(s.includes("not a zero"), "the partial sentence does not say that unknown is not a zero");
});

test("the console shell carries the Proofline region, its navigation and its filter", () => {
  const page = consolePage();
  for (const id of ["proofline-region", "proofline-heading", "proofline-nav", "proofline-filter", "proofline"]) {
    assert.ok(page.includes(`id="${id}"`), `the console shell has no #${id}`);
  }
  assert.ok(page.includes(`>${PROOFLINE_TEXT.heading}<`), "the region is not headed with its declared name");
  assert.ok(page.includes(`aria-label="${PROOFLINE_TEXT.nav_label}"`), "the navigation is not labelled");
  // The shell carries NO VIEW NAME. The eleven are the server's vocabulary and
  // arrive in the payload; a name compiled into the page would be the second
  // list this design exists to avoid.
  for (const view of DASHBOARD_VIEWS) {
    assert.ok(!page.includes(`data-view="${view}"`), `the shell hard-codes the view ${view}`);
  }
});

test("the bundle source reads the Proofline's words from the shared module and writes no markup", () => {
  const src = readFileSync(join(REPO_ROOT, "console", "app.ts"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
    assert.ok(!code.includes(forbidden), `console/app.ts uses ${forbidden}`);
  }
  assert.ok(code.includes('from "../src/console-proofline.ts"'), "the bundle does not read the shared Proofline module");

  // THE PROOFLINE NAMES NO VIEW. The navigation is built from the `views`
  // member of the payload, so a view added to `DASHBOARD_VIEWS` appears in the
  // Console with no edit here — and a name typed into this region would be the
  // second list that made all eleven views invisible in v1.0.0.
  //
  // The check is scoped to the Proofline's own code because the v1.0 console
  // regions above it legitimately use some of the same words for their own
  // elements (`fleet.id = "fleet"` is a DOM id of the P3 fleet panel, not a
  // dashboard view). A whole-file sweep would be a check that fails for a reason
  // that has nothing to do with what it is asserting.
  const start = code.indexOf("function prooflineViewOfHash");
  const end = code.indexOf("async function boot(");
  assert.ok(start > 0 && end > start, "the Proofline region is not where this test expects it");
  const proofline = code.slice(start, end);
  assert.ok(proofline.includes("renderProoflineNav(payload.views"), "the navigation is not built from the server's view list");
  for (const view of DASHBOARD_VIEWS) {
    assert.ok(!proofline.includes(`"${view}"`), `the Proofline region names the view ${view}`);
  }
  assert.ok(!proofline.includes(CONSOLE_FIRST_VIEW), "the Proofline region hard-codes the view it boots with");
});

test("the browser harness is outside `npm test`, and its own script is the one the gates are run by", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  // The suite CI runs globs `test/*.test.ts`, so nothing under `test-browser/`
  // can be swept into it by accident.
  assert.ok(pkg.scripts.test.includes("test/*.test.ts"), "the node suite no longer globs test/*.test.ts");
  assert.equal(pkg.scripts["test:browser"], "node --experimental-strip-types --no-warnings test-browser/run.mjs");
  // AND THE BROWSER ENGINE IS NOT A DEPENDENCY OF THIS PACKAGE. The shipped
  // package has two runtime dependencies and the `supply-chain` job asserts both
  // lockfiles agree with this file and that the builds are byte-reproducible.
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of Object.keys(declared)) {
    assert.ok(
      !name.includes("playwright") && !name.includes("puppeteer") && !name.includes("axe-core"),
      `${name} is declared as a dependency of the shipped package`,
    );
  }
});

test("the harness refuses to report a pass it did not earn", () => {
  // Pointed at a directory with no control install, the runner must exit with
  // the did-not-run code and say so. A harness that exited 0 here would report
  // every browser gate as satisfied on a machine with no browser.
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", join(REPO_ROOT, "test-browser", "run.mjs")],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, SKILLONOMIA_PLAYWRIGHT_DIR: join(REPO_ROOT, "no-such-control-install") },
        timeout: 120_000,
      },
    );
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? "";
  }
  assert.equal(status, 3, `the runner exited ${status} with no browser available`);
  assert.match(stdout, /BROWSER GATES DID NOT RUN/, stdout.slice(0, 400));
  assert.match(stdout, /SKILLONOMIA_PLAYWRIGHT_DIR/, "the banner does not name the override");
});
