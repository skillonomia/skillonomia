// WHERE A DEPLOYMENT'S DATA LIVES, on each of the three platforms
// `src/platform.ts` ANSWERS FOR — asserted as a TABLE, from one host.
//
// Three rows is not three claims. The CLI is qualified on Ubuntu and macOS;
// Windows is deferred by the owner. `dataDirFor` still has to answer for a
// Windows host, because the function is a definition and not a qualification —
// and the row below is what it answers, not evidence that anyone ran it there.
//
// The rule that matters is not any single row: it is that there is ONE function
// answering this question. Before src/platform.ts the answer was `/data`, which
// is the container's volume, and the npm path inherited it — so a macOS user who
// typed `skillonomia serve` was told to create a directory at the root of the
// system disk, and a Windows user was handed a path with no drive on it.
//
// The three platform rows cannot be reached from the host running this file, so
// `dataDirFor` takes the platform and the environment as ARGUMENTS. That is the
// only way this table is checkable at all: a test that could only assert its own
// host would leave two of the three rows to a reader's confidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirFor, defaultDataDir, DATA_DIR_VARIABLE } from "../src/platform.ts";
import { defaultDataDir as fromServer, defaultDbPath, DB_FILENAME } from "../src/server.ts";
import { REPO_ROOT } from "./docs-guard.ts";

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/** The §8 B2 table, as the specification writes it. */
const TABLE: ReadonlyArray<[NodeJS.Platform, Record<string, string | undefined>, string]> = [
  ["darwin", { HOME: "/Users/ada" }, "/Users/ada/Library/Application Support/Skillonomia"],
  ["win32", { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, "C:\\Users\\ada\\AppData\\Local\\Skillonomia"],
  ["linux", { HOME: "/home/ada" }, "/home/ada/.local/state/skillonomia"],
  ["linux", { HOME: "/home/ada", XDG_STATE_HOME: "/var/lib/ada" }, "/var/lib/ada/skillonomia"],
];

test("each platform's default is the platform's own state location", () => {
  for (const [platform, env, expected] of TABLE) {
    assert.equal(dataDirFor(platform, env), expected, `${platform} ${JSON.stringify(env)}`);
  }
});

test("SKILLONOMIA_DATA beats every default, on every platform", () => {
  for (const [platform, env] of TABLE) {
    assert.equal(
      dataDirFor(platform, { ...env, [DATA_DIR_VARIABLE]: "/srv/skillonomia" }),
      "/srv/skillonomia",
      `${platform}: the override is the whole point of having one`,
    );
  }
  // …and an EMPTY value is not a value. `SKILLONOMIA_DATA=` in a unit file or a
  // `docker run -e SKILLONOMIA_DATA` with nothing after it would otherwise put
  // the deployment at the filesystem root.
  assert.equal(dataDirFor("linux", { HOME: "/home/ada", [DATA_DIR_VARIABLE]: "" }), "/home/ada/.local/state/skillonomia");
});

test("the container's /data comes from the same rule, and not from a second one", () => {
  // The Dockerfile sets the variable; that is why `/data` is still the answer
  // inside the image, and why nothing in the code special-cases a container.
  assert.match(read("Dockerfile"), /ENV SKILLONOMIA_DATA=\/data/, "the image sets the override the table's last row describes");
  assert.equal(dataDirFor("linux", { SKILLONOMIA_DATA: "/data" }), "/data");
});

test("a host with no home directory is refused, not guessed at", () => {
  // A relative path resolved against whatever the working directory happened to
  // be is a data directory nobody chose — and the first start writes two
  // one-time credentials into it.
  for (const platform of ["darwin", "linux"] as const) {
    assert.throws(
      () => dataDirFor(platform, {}),
      (e: unknown) => e instanceof Error && e.message.includes(DATA_DIR_VARIABLE),
      `${platform}: the refusal names the variable to set`,
    );
  }
  assert.throws(() => dataDirFor("win32", {}), /LOCALAPPDATA/);
});

test("`serve`, `verify` and `verify-log` ask the same function", () => {
  // They used to be able to disagree: `defaultDataDir` lived in src/server.ts
  // and nothing said the CLI's other subcommands read the same variable.
  assert.equal(fromServer(), defaultDataDir(), "src/server.ts re-exports the one definition rather than keeping a copy");
  assert.equal(defaultDbPath(), join(defaultDataDir(), DB_FILENAME));
});

test("the documents state the same table the code implements", () => {
  // Each row is written where a reader of that document would look for it, and
  // the strings are the ones `dataDirFor` returns.
  for (const doc of ["README.md", "docs/OPERATIONS.md"]) {
    const text = read(doc);
    assert.match(text, /~\/Library\/Application Support\/Skillonomia/, `${doc} states the macOS default`);
    assert.match(text, /%LOCALAPPDATA%\\Skillonomia/, `${doc} states the Windows default`);
    assert.match(text, /\$\{XDG_STATE_HOME:-~\/\.local\/state\}\/skillonomia/, `${doc} states the Linux default`);
    assert.match(text, new RegExp(`${DATA_DIR_VARIABLE}`), `${doc} names the override`);
  }
});
