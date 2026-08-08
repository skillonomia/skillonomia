// The command line, exercised as a real process.
//
// Every case here spawns `src/cli.ts` (or a built artifact) the way an
// operator would and reads its exit code and its bytes. Calling `runCli()`
// in-process would not test what the release paths actually ship: argv reaching
// the entry point, the exit code reaching the shell, stdout and stderr apart.
//
// The exit-code contract under test: 0 success, 1 a check that FAILED or an
// operational error, 2 wrong usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";
import { EXIT_OK, EXIT_CHECK_FAILED, EXIT_USAGE } from "../src/cli-commands.ts";
import { openMigrated } from "../src/db.ts";
import { appendTlog } from "../src/tlog.ts";
import { tvRegistry } from "./vectors-helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "src", "cli.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI as a process, the way `npx skillonomia …` does. */
function run(args: string[], env: Record<string, string> = {}): Run {
  const res = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...env },
  });
  if (res.error) throw res.error;
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A file-backed registry holding the TV package, in the state the vector wants. */
function tvDb(name: string, opts: Parameters<typeof tvRegistry>[0] = {}): string {
  const dbPath = join(tmp("sklo-cli-db-"), `${name}.db`);
  tvRegistry({ ...opts, dbPath }).db.close();
  return dbPath;
}

// ----------------------------------------------------------- version / help

test("`version` prints the single-source version and exits 0", () => {
  const res = run(["version"]);
  assert.equal(res.code, EXIT_OK, res.stderr);
  assert.equal(res.stdout.trim(), VERSION);
  for (const alias of ["--version", "-v"]) {
    assert.equal(run([alias]).stdout.trim(), VERSION, `alias ${alias}`);
  }
});

test("`help` lists every subcommand and exits 0", () => {
  const res = run(["help"]);
  assert.equal(res.code, EXIT_OK, res.stderr);
  for (const cmd of ["serve", "verify", "verify-log", "version", "help"]) {
    assert.match(res.stdout, new RegExp(`^\\s+${cmd}[\\s\\[]`, "m"), `help documents ${cmd}`);
  }
  for (const alias of ["--help", "-h"]) {
    assert.match(run([alias]).stdout, /usage: skillonomia/, `alias ${alias}`);
  }
});

test("an unknown command is a USAGE error (2), with the help text on stderr", () => {
  const res = run(["frobnicate"]);
  assert.equal(res.code, EXIT_USAGE);
  assert.match(res.stderr, /unknown command frobnicate/);
  assert.match(res.stderr, /usage: skillonomia/, "…and it says what the commands are");
  assert.equal(res.stdout, "", "a usage error writes nothing to stdout");
});

// ------------------------------------------------------------------ verify

test("`verify` on the committed TV-01 vector reaches the verdict the vector declares", () => {
  // the §4.5 expectation, read from the vector rather than restated here
  const expected = JSON.parse(readFileSync(join(root, "vectors", "tv-01", "expected.json"), "utf8"));
  assert.equal(expected.expected_verdict, "valid");

  const db = tvDb("tv01");
  const pkg = join(root, "vectors", "tv-01", "package");

  const human = run(["verify", pkg, "--db", db]);
  assert.equal(human.code, EXIT_OK, human.stderr);
  assert.match(human.stdout, /^verdict : valid$/m);
  assert.match(human.stdout, /^verify {2}: OK$/m);
  assert.match(human.stdout, /^manifest: [0-9a-f]{64}$/m, "the manifest hash is reported to a human too");

  const machine = run(["verify", pkg, "--db", db, "--json"]);
  assert.equal(machine.code, EXIT_OK, machine.stderr);
  const parsed = JSON.parse(machine.stdout);
  assert.equal(parsed.verdict, expected.expected_verdict);
  assert.equal(parsed.manifest_hash, "5498c4f560409b1dbdf78794d5072a36672e54c825dbad6d0f1b89ea5fd794d0");
  assert.equal(machine.stdout.trim().split("\n").length, 1, "--json is exactly one line");
});

test("`verify` exits non-zero on a package that does not verify, and says so on stderr", () => {
  const expected = JSON.parse(readFileSync(join(root, "vectors", "tv-08", "expected.json"), "utf8"));
  assert.equal(expected.expected_verdict, "revoked");

  const db = tvDb("tv08", { state: "revoked" });
  const res = run(["verify", join(root, "vectors", "tv-08", "package"), "--db", db]);
  assert.equal(res.code, EXIT_CHECK_FAILED);
  assert.match(res.stderr, /^verdict : revoked$/m);
  assert.match(res.stderr, /^verify {2}: FAILED$/m);
  assert.equal(res.stdout, "", "a failed verification does not print a success line to stdout");

  const machine = run(["verify", join(root, "vectors", "tv-08", "package"), "--db", db, "--json"]);
  assert.equal(machine.code, EXIT_CHECK_FAILED);
  assert.equal(JSON.parse(machine.stdout).verdict, "revoked");
});

test("a §4.4.8 WARNING verdict is a success (0) that names itself", () => {
  // valid_superseded / valid_deprecated / valid_but_key_since_revoked: the
  // package verifies. Exiting non-zero would make `verify` unusable as a gate
  // for the case it was designed to describe.
  const db = tvDb("tv09", { state: "superseded", supersededBy: true });
  const res = run(["verify", join(root, "vectors", "tv-09", "package"), "--db", db]);
  assert.equal(res.code, EXIT_OK, res.stderr);
  assert.match(res.stdout, /^verdict : valid_superseded$/m);
  assert.match(res.stdout, /with a warning verdict/);
  assert.match(res.stdout, /^successor: /m);
});

test("`verify` reports the §4.1b archive refusals as verdicts, not as crashes", () => {
  const db = tvDb("archive");
  for (const vector of ["tv-11a", "tv-12"]) {
    const expected = JSON.parse(readFileSync(join(root, "vectors", vector, "expected.json"), "utf8"));
    const pkg = ["package.tar", "package.tar.gz"].map((f) => join(root, "vectors", vector, f)).find(existsSync)!;
    const res = run(["verify", pkg, "--db", db, "--json"]);
    assert.equal(res.code, EXIT_CHECK_FAILED, `${vector}: ${res.stderr}`);
    assert.equal(JSON.parse(res.stdout).verdict, expected.expected_verdict, vector);
    assert.equal(res.stderr, "", `${vector}: an archive refusal is a verdict, so nothing goes to stderr in --json`);
  }
});

test("`verify` argument errors are USAGE errors (2), distinct from a failed verification", () => {
  const db = tvDb("usage");
  const pkg = join(root, "vectors", "tv-01", "package");

  assert.equal(run(["verify"]).code, EXIT_USAGE, "no package named");
  assert.match(run(["verify"]).stderr, /verify needs a package/);

  const noPkg = run(["verify", join(root, "does-not-exist"), "--db", db]);
  assert.equal(noPkg.code, EXIT_USAGE);
  assert.match(noPkg.stderr, /package not found/);

  const noDb = run(["verify", pkg, "--db", join(root, "no-such.db")]);
  assert.equal(noDb.code, EXIT_USAGE);
  assert.match(noDb.stderr, /registry database not found/);
  assert.match(noDb.stderr, /SKILLONOMIA_DATA/, "…and it says how to point at one");

  const dangling = run(["verify", pkg, "--db"]);
  assert.equal(dangling.code, EXIT_USAGE, "an option with no value is not a package called --db");
  assert.match(dangling.stderr, /--db needs a value/);

  assert.equal(run(["verify", pkg, "--nonsense", "x"]).code, EXIT_USAGE);
  assert.equal(run(["verify", pkg, db, "extra"]).code, EXIT_USAGE, "too many positionals");
});

test("the registry defaults to <SKILLONOMIA_DATA>/skillonomia.db — the file `serve` opens", () => {
  const dir = tmp("sklo-cli-data-");
  tvRegistry({ dbPath: join(dir, "skillonomia.db") }).db.close();
  const res = run(["verify", join(root, "vectors", "tv-01", "package")], { SKILLONOMIA_DATA: dir });
  assert.equal(res.code, EXIT_OK, res.stderr);
  assert.match(res.stdout, /^verdict : valid$/m);
  assert.match(res.stdout, new RegExp(`^registry: ${dir}/skillonomia\\.db$`, "m"));
});

test("the positional registry form still works — README's `npm run verify <pkg> <db>`", () => {
  const db = tvDb("positional");
  const res = run(["verify", join(root, "vectors", "tv-01", "package"), db]);
  assert.equal(res.code, EXIT_OK, res.stderr);
  assert.match(res.stdout, /^verdict : valid$/m);
});

// -------------------------------------------------------------- verify-log

test("`verify-log` walks the chain: 0 intact, 1 broken, and --json for a machine", () => {
  const dir = tmp("sklo-cli-tlog-");
  const dbPath = join(dir, "skillonomia.db");
  const db = openMigrated(dbPath);
  appendTlog(db, "publish", "s1", { a: 1 }, 1_700_000_000_000);
  appendTlog(db, "verify", "s1", { b: 2 }, 1_700_000_000_001);
  db.close();

  const ok = run(["verify-log", "--db", dbPath]);
  assert.equal(ok.code, EXIT_OK, ok.stderr);
  assert.match(ok.stdout, /verify-log: OK \(2 entries, chain intact\)/);

  const machine = run(["verify-log", dbPath, "--json"]);
  assert.equal(machine.code, EXIT_OK);
  assert.deepEqual(JSON.parse(machine.stdout), { ok: true, checked: 2, registry: dbPath });

  // the default registry is the same one `serve` and `verify` resolve
  assert.equal(run(["verify-log"], { SKILLONOMIA_DATA: dir }).code, EXIT_OK);

  const tampered = openMigrated(dbPath);
  tampered.exec("DROP TRIGGER tg_tlog_no_upd"); // an attacker with DDL access
  tampered.exec("UPDATE transparency_log SET event_kind='forged' WHERE seq=1");
  tampered.close();

  const bad = run(["verify-log", "--db", dbPath]);
  assert.equal(bad.code, EXIT_CHECK_FAILED);
  assert.match(bad.stderr, /FAIL at seq 1/);
  assert.equal(bad.stdout, "");
  assert.equal(JSON.parse(run(["verify-log", "--db", dbPath, "--json"]).stdout).ok, false);

  assert.equal(run(["verify-log", "--db", join(dir, "absent.db")]).code, EXIT_USAGE);
});

// ------------------------------------------------------------------- serve

interface ServeRun {
  /** stdout and stderr, interleaved as the reader saw them */
  out: string;
  /** exit code, or null when the process was killed by a signal */
  code: number | null;
  /** the signal that killed it, or null when it exited on its own */
  signal: string | null;
}

/**
 * Start the CLI, SIGTERM it the moment the banner line arrives, and collect
 * everything it managed to print.
 *
 * Signalling on the FIRST line is deliberate, not convenience: the startup
 * block is several lines long and the ones that follow the banner are the
 * §9.1 one-time credentials. So this helper reproduces the operator's
 * `docker stop` on a first start, and the assertions below are about what
 * survives it.
 */
async function serveOnce(args: string[], env: Record<string, string>): Promise<ServeRun> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    cwd: root,
    env: { ...process.env, SKILLONOMIA_WORKER_MS: "0", ...env },
  });
  let out = "";
  let listening = false;
  return await new Promise<ServeRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve did not report a listener within 20s; got: ${out}`));
    }, 20_000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      // SIGTERM once, then keep reading: the startup banner is the FIRST line
      // of several, and the credentials §9.1 prints follow it
      if (!listening && out.includes("listening on")) {
        listening = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", reject);
    // `close`, not `exit`: it fires once the pipes have been drained
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (listening) resolve({ out, code, signal });
      else reject(new Error(`serve exited ${code}/${signal} before listening: ${out}`));
    });
  });
}

test("`serve` starts a listener — and so does a BARE invocation, which is what the image's CMD relies on", async () => {
  const explicit = await serveOnce(["serve", "--port", "0", "--data", tmp("sklo-cli-serve-")], {});
  assert.match(explicit.out, /skillonomia .* listening on http:\/\//);
  assert.match(explicit.out, /first start/, "a fresh data directory bootstraps");

  // No subcommand at all must keep serving: this is how the CLI behaved before
  // there were subcommands, and `docker run skillonomia` with an overridden
  // CMD still lands here.
  const bare = await serveOnce([], { SKILLONOMIA_DATA: tmp("sklo-cli-bare-"), SKILLONOMIA_PORT: "0" });
  assert.match(bare.out, /listening on http:\/\//);
});

test("SIGTERM on the banner line neither kills `serve` outright nor loses the credentials that follow it", async () => {
  // The case above asserted `first start` after signalling on the banner, and
  // that assertion USED TO BE A COIN FLIP: the signal handlers were installed
  // after `serve()` had already printed, so a SIGTERM arriving in that window
  // took the default disposition and killed the process with its remaining
  // output still queued. Measured on the broken tree: 19 losses in 60 runs.
  //
  // One iteration cannot separate a fixed tree from a broken one, so this
  // repeats. At the measured loss rate a reverted fix survives eight
  // iterations with probability ≈0.68^8 ≈ 4%, while a correct one is not a
  // race at all: from the first byte a handler exists, and the handler drains
  // instead of calling process.exit.
  //
  // The two assertions separate the two failure shapes on purpose. `signal`
  // catches the process being killed rather than handling the signal; the
  // credential lines catch queued output being discarded by whatever exits.
  for (let i = 0; i < 8; i += 1) {
    const r = await serveOnce(["serve", "--port", "0", "--data", tmp("sklo-cli-sigterm-")], {});
    assert.equal(r.signal, null, `run ${i}: killed by ${r.signal} instead of handling SIGTERM — ${r.out}`);
    assert.equal(r.code, EXIT_OK, `run ${i}: exited ${r.code} — ${r.out}`);
    assert.match(r.out, /first start/, `run ${i}: startup block truncated — ${JSON.stringify(r.out)}`);
    assert.match(r.out, /BOOTSTRAP_OWNER_TOKEN=/, `run ${i}: lost a one-time credential — ${JSON.stringify(r.out)}`);
    assert.match(r.out, /DEMO_ADOPTER_TOKEN=/, `run ${i}: lost a one-time credential — ${JSON.stringify(r.out)}`);
  }
});

test("`serve` argument errors are USAGE errors (2), not stack traces", () => {
  for (const args of [
    ["serve", "--nonsense", "1"],
    ["serve", "--port"],
    ["serve", "--port", "not-a-number"],
    ["serve", "--port", "70000"],
    ["serve", "somewhere"],
  ]) {
    const res = run(args);
    assert.equal(res.code, EXIT_USAGE, `${args.join(" ")} → ${res.stdout}${res.stderr}`);
    assert.doesNotMatch(res.stderr, /at .*\.ts:\d+/, "no stack trace");
  }
});

// ------------------------------------------------------- the shipped builds

test("the BUILT JS entry point exposes the same subcommands as the sources", (t) => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const argv = (pkg.scripts["build:js"] as string).split(/\s+/);
  if (spawnSync("bun", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("bun is not on PATH, so `npm run build:js` cannot run here; the CI `npx-smoke` job covers this path");
    return;
  }

  // built here rather than read from the gitignored dist-js/, so the case can
  // neither fail on a missing artifact nor pass on a stale one
  const staged = join(tmp("sklo-cli-build-"), "node_modules", "skillonomia");
  mkdirSync(join(staged, "dist-js"), { recursive: true });
  mkdirSync(join(staged, "bin"), { recursive: true });
  cpSync(join(root, "bin", "skillonomia.js"), join(staged, "bin", "skillonomia.js"));
  const flags = argv.slice(1).map((a) => (a === "dist-js/cli.js" ? join(staged, "dist-js", "cli.js") : a));
  const build = spawnSync("bun", flags, { encoding: "utf8", cwd: root });
  assert.equal(build.status, 0, build.stderr);

  const launcher = join(staged, "bin", "skillonomia.js");
  const viaLauncher = (args: string[]): Run => {
    const res = spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", cwd: root });
    return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
  };

  assert.equal(viaLauncher(["version"]).stdout.trim(), VERSION);
  assert.match(viaLauncher(["help"]).stdout, /usage: skillonomia/);
  assert.equal(viaLauncher(["frobnicate"]).code, EXIT_USAGE);

  // …including the one that does real work: §4.4 over a committed vector
  const db = tvDb("built");
  const verified = viaLauncher(["verify", join(root, "vectors", "tv-01", "package"), "--db", db, "--json"]);
  assert.equal(verified.code, EXIT_OK, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).verdict, "valid");
});
