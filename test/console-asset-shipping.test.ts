// THE OWNER CONSOLE HAS TO BE IN THE THING THAT SHIPS.
//
// `src/console-page.ts` serves exactly one script — `/console/app.js` — and the
// router answers it from `dist-console/app.js` under the asset root
// `src/assets.ts` resolves. `dist-console/` is a BUILD OUTPUT and is
// `.gitignore`d, so it exists in a checkout only because `pretest` built it.
// That is the trap this file closes: every suite in this repository runs after
// `npm run build:console`, so every suite sees a Console that loads, while the
// npm tarball, the container image and the binary archive each shipped without
// the file and answered `/console/app.js` with a 500 — a deployment whose
// Console cannot start at all, which is every claim about the eleven Proofline
// views and about deciding a review, an adoption or a publication without curl.
//
// The three artifacts are checked HERE by their recipes, and the tarball is
// additionally checked by what `npm pack` actually enumerates, because the
// recipe and the result are two different claims and it was the result that was
// wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, packedFiles, packRoot } from "./docs-guard.ts";
import { CONSOLE_SCRIPT_PATH } from "../src/console-page.ts";

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

test("the npm tarball carries the Console bundle, by recipe and by enumeration", () => {
  assert.ok(
    (pkg.files ?? []).includes("dist-console/"),
    "`files` must carry dist-console/ or the installed package has no Console script",
  );
  // `prepack` is the maintainer's build step and the only thing that creates
  // the directory: a `files` entry for a directory nothing builds ships nothing.
  assert.match(pkg.scripts?.prepack ?? "", /build:console/, "prepack must build the Console bundle it ships");

  const packed = packedFiles();
  assert.ok(
    packed.includes("dist-console/app.js"),
    `npm pack enumerated no dist-console/app.js — it listed ${packed.length} files`,
  );
  const bytes = statSync(join(packRoot(), "dist-console", "app.js")).size;
  assert.ok(bytes > 1024, `the packed Console bundle is ${bytes} bytes, which is not a bundle`);
});

test("the container image builds the Console bundle from its own sources", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY console /, "the image copies console/");
  // Built in the image rather than copied from the build host: a `COPY
  // dist-console` would make `docker build` from a clean checkout produce an
  // image whose Console is missing, which is the defect this file exists for.
  assert.match(
    dockerfile,
    /bun build --target=browser --format=esm --minify console\/app\.ts --outfile dist-console\/app\.js/,
    "the image builds dist-console/app.js with the same bundler and flags as `npm run build:console`",
  );
  assert.equal(
    pkg.scripts?.["build:console"],
    "bun build --target=browser --format=esm --minify console/app.ts --outfile dist-console/app.js",
    "…and that is still what `build:console` is, so the two cannot drift apart silently",
  );
});

test("the binary archive stages the Console bundle beside the executable", () => {
  // `src/assets.ts` resolves the asset root of a compiled binary to the
  // directory holding the executable, so `dist-console/` has to be staged there
  // exactly as `migrations/`, `schema/` and `seed/` are.
  assert.match(pkg.scripts?.["prebuild:binary"] ?? "", /build:console/, "the binary build builds the Console bundle first");
  assert.ok(
    (pkg.scripts?.["build:binary"] ?? "").includes("dist/dist-console"),
    "build:binary must stage dist/dist-console next to the executable",
  );
  const release = readFileSync(join(REPO_ROOT, "ci", "mvp-release.mjs"), "utf8");
  assert.match(release, /"skillonomia", "migrations", "schema", "seed", "dist-console"/, "the release archive tars dist-console");

  // TARRING IT AND ADMITTING IT ARE TWO CLAIMS, and the same script makes both.
  // `verifyMembers` compares the archive's top-level members against `MEMBERS`
  // as a SET, so a bundle added to the tar line and not to `MEMBERS` does not
  // ship silently — it makes the release check refuse the archive it just
  // built. That is exactly what happened: the tar line carried `dist-console`
  // and `MEMBERS` still named the five without it, so `binary --local` failed
  // with "contains [… dist-console/ …]; a release carries [… no console …]".
  const members = release.match(/^export const MEMBERS = \[(.*)\];$/m)?.[1];
  assert.ok(members, "ci/mvp-release.mjs must declare MEMBERS on one line");
  assert.ok(
    members.includes('"dist-console/"'),
    `MEMBERS must admit the bundle the archive now carries; it lists [${members}]`,
  );
});

test("the one script the Console page loads is the one the artifacts ship", () => {
  assert.equal(CONSOLE_SCRIPT_PATH, "/console/app.js");
});
