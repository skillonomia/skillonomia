// WHAT A CONSUMER OF `@skillonomia/cli` NEEDS INSTALLED, AND WHAT THEY DO NOT.
//
// B2's claim is one sentence: a user installs this CLI with npm and runs it on
// Node ≥22.6, and Bun — the canonical §2 runtime, and the thing every maintainer
// has — is NOT a prerequisite for them. That claim is made of four separable
// facts about `package.json` and `bin/`, and every one of them is the kind that
// goes quietly wrong:
//
//   * the NAME. `skillonomia` on the public registry is somebody else's
//     placeholder; this package is scoped, and a scoped package is private by
//     default unless `publishConfig.access` says otherwise.
//   * the LIFECYCLE. `prepack` is a `bun build`. npm runs `prepack` when a
//     tarball is PACKED and not when one is INSTALLED — so it is the
//     maintainer's build step, and an `install`/`postinstall`/`prepare` hook
//     that ran Bun would put it back on the user's side.
//   * the FILES. The published entry point is `dist-js/cli.js`, which only
//     exists because `prepack` built it; if `files` did not carry it the
//     installed package would have no runnable entry at all.
//   * the LAUNCHER. Node refuses to strip types under `node_modules`, so an
//     installed package cannot run the TypeScript sources. `bin/skillonomia.js`
//     prefers the built file and says so when it is missing.
//
// The live half of this — install the tarball into a clean prefix with no Bun on
// PATH and drive it to a terminal receipt — is `node ci/mvp-release.mjs npm`,
// which `candidate.yml` runs on every push. This file is the part that can be
// checked without packing anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, packedFiles } from "./docs-guard.ts";
import { resolveInterpreter } from "../src/demo.ts";

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json"));

test("the package is scoped, public, and named for what it is", () => {
  assert.equal(pkg.name, "@skillonomia/cli", "the scoped name is the identity B2 publishes under");
  // A scope is PRIVATE by default. Without this, the first `npm publish` fails
  // with a 402 asking for a paid plan — or, on an account that has one,
  // succeeds and publishes a package nobody outside the scope can install.
  assert.equal(pkg.publishConfig?.access, "public", "a scoped package publishes private unless it says otherwise");
  assert.equal(pkg.private, undefined, "`private: true` refuses to publish at all");
  assert.deepEqual(Object.keys(pkg.bin ?? {}), ["skillonomia"], "the executable keeps the name it has always had");
  assert.equal(pkg.bin.skillonomia, "bin/skillonomia.js");
});

test("nothing Bun runs is on the CONSUMER's side of the lifecycle", () => {
  // npm runs `prepack` for `npm pack` and `npm publish`; it runs `install`,
  // `postinstall`, `preinstall` and `prepare` for a consumer. The first is the
  // maintainer's build. The rest must not exist, or Bun becomes a prerequisite
  // for `npm install -g @skillonomia/cli` — which is the whole of B2.
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const CONSUMER_HOOKS = ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare"];
  for (const hook of CONSUMER_HOOKS) {
    assert.equal(scripts[hook], undefined, `\`${hook}\` runs on a consumer's machine; this package defines one`);
  }
  assert.match(scripts.prepack ?? "", /build:js/, "prepack is still the build that produces the published entry point");
  assert.match(scripts["build:js"] ?? "", /^bun build/, "…and that build is a `bun build`, which is why it may not move");
});

test("the published tarball carries the entry point the launcher runs", () => {
  const files: string[] = pkg.files ?? [];
  for (const required of ["bin/", "dist-js/", "migrations/", "schema/", "seed/"]) {
    assert.ok(files.includes(required), `\`files\` must carry ${required}`);
  }
  // …and `npm pack` agrees, which is the answer that actually ships. The seed
  // package and the migrations are read at runtime by `serve`: a tarball
  // without them installs and then fails to open a database.
  const packed = packedFiles();
  assert.ok(packed.includes("bin/skillonomia.js"), "the launcher ships");
  assert.ok(packed.includes("dist-js/cli.js"), "the built entry point ships — `prepack` produced it");
  assert.ok(packed.some((p) => p.startsWith("migrations/")), "the migrations ship");
  assert.ok(packed.some((p) => p.startsWith("seed/")), "the seed package ships");
  assert.ok(!packed.some((p) => p.startsWith("test/")), "the test suite does not");
});

test("the launcher prefers the built entry point and refuses a package that has none", () => {
  const launcher = read("bin/skillonomia.js");
  assert.match(launcher, /dist-js/, "the launcher runs the built file when it is there");
  assert.match(launcher, /experimental-strip-types/, "…and the sources in a checkout, where it is not");
  // The refusal is what turns a broken install into a sentence a user can act
  // on instead of ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
  assert.match(launcher, /node_modules/, "the launcher knows whether it is installed");
  assert.match(launcher, /process\.exit\(1\)/, "…and exits non-zero when an installed package has no entry point");
});

test("the engine floor is the one a consumer is told about, and Bun is not in it", () => {
  assert.match(pkg.engines?.node ?? "", /^>=22\.6/, "Node ≥22.6 is the consumer prerequisite");
  assert.equal(pkg.engines?.bun, undefined, "declaring a Bun engine would make it a prerequisite");
  const readme = read("README.md");
  assert.match(readme, /@skillonomia\/cli/, "README names the package a user installs");
});

// ---------------------------------------------------------------------------
// WHAT `skillonomia demo` NEEDS INSTALLED, WHICH IS NOTHING BUT NODE.
//
// FR-07 is the reason src/demo.ts exists: the §9.1 quickstart used to be
// `ci/quickstart.sh` — curl, python3, tar and bash — and that is a fine CI gate
// on Linux and not a product path. A Windows user who installed this CLI has
// Node, and this project may assume nothing else. So the claim "no bash, no
// curl, no tar" is checked against the module, not asserted in prose.

const DEMO = read("src/demo.ts");

test("the quickstart orchestration spawns exactly one program, and it is the package's own step", () => {
  // Every child process this module can start, found by the call rather than by
  // reading the prose around it.
  const spawns = [...DEMO.matchAll(/spawnSync\(\s*([A-Za-z_$][\w$]*|"[^"]*")/g)].map((m) => m[1]);
  assert.deepEqual(
    spawns,
    ["name", "interpreter"],
    "src/demo.ts starts something other than the probe and the declared step; `demo` may spawn no tool of its own",
  );
  for (const tool of ["curl", "tar", "bash", "python3"]) {
    assert.ok(!new RegExp(`spawnSync\\(\\s*"${tool}"`).test(DEMO), `demo must not shell out to ${tool}`);
  }
  // The archive is unpacked by this project's own reader, which is why no `tar`
  // binary is needed to receive a package.
  assert.match(DEMO, /import \{ readTar \} from "\.\/archive\.ts"/, "the delivered archive is read by src/archive.ts");
  assert.match(DEMO, /exactly one program|declared step/i, "…and the module says which one program it does start");
});

test("a missing interpreter is a refusal, not a receipt", () => {
  // The mechanism, executed: `resolveInterpreter` answers about THIS host, so
  // the refusal below is reached by a fact rather than by a flag.
  assert.equal(resolveInterpreter("skillonomia-no-such-interpreter"), null, "a program that is not there resolves to null");
  assert.equal(resolveInterpreter(process.platform === "win32" ? "cmd" : "sh"), process.platform === "win32" ? "cmd" : "sh");

  // …and the module refuses on that answer rather than reporting a gate result.
  assert.match(
    DEMO,
    /check\(\s*interpreter !== null,/,
    "src/demo.ts must stop when no interpreter answers",
  );
  assert.match(DEMO, /shell-missing/, "…naming the package's own declared failure mode");
  assert.match(
    DEMO,
    /receipt reaching `adopted` here would report a gate result that no run produced/,
    "…and saying why a green result there would be a lie",
  );
});

test("a self-started demo cannot spend a real deployment's one-time credentials", () => {
  // The §9.1 credentials are printed once. A `demo` that defaulted to the
  // deployment's own data directory would exchange the bootstrap token of a
  // registry somebody is running, and it cannot be reissued.
  assert.match(
    DEMO,
    /opts\.dataDir \?\? \(temporary = mkdtempSync/,
    "with no --data, a self-started demo uses a temporary directory of its own",
  );
  assert.match(DEMO, /rmSync\(temporary/, "…and removes it afterwards");
});

test("the two npm markers say which path was exercised", () => {
  // A local tarball and a registry install are different claims. A rehearsal
  // that printed the acceptance marker would assert a registry read-back that
  // never happened — the same rule `binary --local` already follows.
  const script = read("ci/mvp-release.mjs");
  assert.match(script, /const NPM_OK = "NPM_CLI_OK"/);
  assert.match(script, /const NPM_STAGED = "NPM_CLI_STAGED_OK"/);
  assert.match(
    script,
    /the registry path was NOT exercised[\s\S]{0,120}NPM_STAGED/,
    "the staged marker is printed with the sentence that says what was not done",
  );
  assert.match(script, /npm view/, "the registry path reads the registry back before installing from it");
});
