// The README's quickstart, EXECUTED.
//
// `test/version.test.ts` already made one README claim unable to drift — the
// version string in the `/health` transcript — by comparing it with the single
// source. This file does the same for the rest of the quickstart, and it does
// it the only way that actually settles the question: it runs the commands.
//
// What is proved here:
//
//   1. The README's own `serve` line starts a server from these sources and
//      prints the two §9.1 credentials it says it prints.
//   2. The README's quickstart block, extracted verbatim and run under
//      `bash -euo pipefail`, drives that server to a TERMINAL `adopted`
//      receipt. `set -e` plus `curl -sS` means any step that fails, fails this
//      test.
//   3. Every `# →` line in the block equals what the command above it actually
//      printed — key for key, value for value, `…` being the only wildcard and
//      only for values that differ per run (ids, keys, base64). So a response
//      that gains, loses or renames a field fails this test until the README is
//      updated, and a README edited away from the software fails it too.
//
// Why the block captures responses through `python3` rather than reading like a
// transcript with `<paste this here>` placeholders: a placeholder cannot be
// executed, so a quickstart written that way can only ever be proof-read. The
// blocks are marked in the README with `<!-- doc-test: NAME -->` immediately
// before the fence, which is how this file finds them; that marker is the whole
// contract between the document and this test.
//
// The one thing NOT executed here is `npm ci`, because it reaches the network
// and this suite does not. That the README's `npm ci` line is still the setup
// line is asserted below; that `npm ci` can actually succeed is a lockfile
// property, checked offline by the lockfile test and for real by CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

// --------------------------------------------------------------- extraction

/** The fenced block introduced by `<!-- doc-test: name -->`, verbatim. */
function docBlock(name: string): string {
  const marker = `<!-- doc-test: ${name} -->`;
  const at = README.indexOf(marker);
  assert.notEqual(at, -1, `README must carry a \`${marker}\` block — this test runs it`);
  const fence = README.indexOf("```bash\n", at);
  assert.notEqual(fence, -1, `${marker} must be followed by a \`\`\`bash fence`);
  const start = fence + "```bash\n".length;
  const end = README.indexOf("\n```", start);
  assert.notEqual(end, -1, `${marker}'s fence is not closed`);
  return README.slice(start, end);
}

/** The `# → …` annotations of a block, in document order. */
function expectations(block: string): string[] {
  return block
    .split("\n")
    .map((l) => /^#\s*→\s*(.+)$/.exec(l.trim())?.[1])
    .filter((v): v is string => v !== undefined);
}

// ------------------------------------------------------------- the comparer

/** The one wildcard the README is allowed: a value that differs per run. */
const ANY = "…";

/**
 * `expected` is what the README promises, `actual` is what the command printed.
 * The comparison is exact in BOTH directions — an extra key in the response is
 * as much a failure as a missing one, because a README that lists four of five
 * fields is teaching the reader a shape the server does not have.
 */
function assertMatches(expected: unknown, actual: unknown, where: string): void {
  if (expected === ANY) {
    assert.equal(typeof actual, "string", `${where}: \`…\` stands for a per-run string, got ${JSON.stringify(actual)}`);
    assert.ok((actual as string).length > 0, `${where}: \`…\` stands for a non-empty value`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal((actual as unknown[]).length, expected.length, `${where}: array length`);
    expected.forEach((e, i) => assertMatches(e, (actual as unknown[])[i], `${where}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${where}: expected an object`);
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(a).sort(),
      Object.keys(e).sort(),
      `${where}: the README's field list must be the response's field list`,
    );
    for (const k of Object.keys(e)) assertMatches(e[k], a[k], `${where}.${k}`);
    return;
  }
  assert.deepEqual(actual, expected, where);
}

// ------------------------------------------------------------- the instance

async function freePort(): Promise<number> {
  // A port the OS just handed out and we immediately gave back. The window is
  // small enough for a test and the alternative — `--port 0` — cannot be used,
  // because the quickstart needs a port it can put in a URL.
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") return reject(new Error("the probe listener has no address"));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

interface Instance {
  child: ChildProcessByStdio<null, Readable, Readable>;
  base: string;
  bootstrapToken: string;
  demoToken: string;
  log: () => string;
}

/**
 * Start the server with the README's OWN command. Two values are substituted —
 * the port and the data directory — because a test cannot bind a fixed port or
 * write into the checkout; everything else, `npm start --` included, is the
 * literal line a reader copies.
 */
async function startFromReadme(): Promise<Instance> {
  const block = docBlock("serve");
  assert.match(block, /^npm ci$/m, "the README's setup block must still install with `npm ci`");
  const line = /^npm start .*$/m.exec(block)?.[0];
  assert.ok(line, "the README's setup block must still start the server with `npm start`");
  const argv = line.split(/\s+/).slice(1); // drop `npm`
  assert.deepEqual(
    argv.filter((a) => a.startsWith("--")),
    ["--", "--port", "--data"],
    "the README's start line is `npm start -- --port <n> --data <dir>`",
  );

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "sklo-readme-"));
  const run = argv.map((a, i) =>
    argv[i - 1] === "--port" ? String(port) : argv[i - 1] === "--data" ? dataDir : a,
  );

  // `detached` puts npm AND the node it spawns in one process group, so `stop`
  // can take the whole tree down. Killing only npm leaves the server holding
  // the inherited stdout pipe open, which keeps this test process alive after
  // its assertions have passed — a green suite that never exits.
  const child = spawn("npm", run, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout.on("data", (b: Buffer) => {
    log += b.toString("utf8");
  });
  child.stderr.on("data", (b: Buffer) => {
    log += b.toString("utf8");
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const token = (name: string): string => {
    const m = new RegExp(`^${name}=(\\S+)$`, "m").exec(log);
    assert.ok(m, `the first start must print ${name} (§9.1) — got:\n${log}`);
    return m[1];
  };
  const inst: Instance = {
    child,
    base,
    bootstrapToken: token("BOOTSTRAP_OWNER_TOKEN"),
    demoToken: token("DEMO_ADOPTER_TOKEN"),
    log: () => log,
  };
  // the temp data dir is the child's; removing it is this function's caller's
  // job through `stop`, which is why the path travels on the child
  (child as unknown as { dataDir: string }).dataDir = dataDir;
  return inst;
}

function stop(inst: Instance): void {
  try {
    if (inst.child.pid !== undefined) process.kill(-inst.child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  inst.child.kill("SIGKILL");
  inst.child.stdout.destroy();
  inst.child.stderr.destroy();
  const dir = (inst.child as unknown as { dataDir?: string }).dataDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------- tests

test("the README's own start command runs a server from these sources", async () => {
  const inst = await startFromReadme();
  try {
    const health = (await (await fetch(`${inst.base}/health`)).json()) as unknown;

    // the `/health` transcript is a doc-test block of its own
    const shown = expectations(docBlock("health"));
    assert.equal(shown.length, 1, "the README shows exactly one /health response");
    assertMatches(JSON.parse(shown[0]), health, "/health");

    assert.match(inst.bootstrapToken, /^bt_/, "BOOTSTRAP_OWNER_TOKEN is the one-time token, not an API key");
    assert.match(inst.demoToken, /^sk_/, "DEMO_ADOPTER_TOKEN is the demo adopter's API key");
  } finally {
    stop(inst);
  }
});

test("the README's quickstart block, run verbatim, reaches a terminal `adopted` receipt", async () => {
  const block = docBlock("quickstart");
  const expected = expectations(block);
  assert.ok(expected.length >= 8, `the quickstart annotates every step (found ${expected.length})`);

  const inst = await startFromReadme();
  try {
    const run = spawnSync("bash", ["-euo", "pipefail", "-c", block], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE: inst.base,
        BOOTSTRAP_OWNER_TOKEN: inst.bootstrapToken,
        DEMO_ADOPTER_TOKEN: inst.demoToken,
      },
      timeout: 120_000,
    });
    assert.equal(
      run.status,
      0,
      `the README's quickstart failed (exit ${run.status}):\n${run.stdout}\n--- stderr\n${run.stderr}`,
    );

    const printed = run.stdout.split("\n").filter((l) => l.trim() !== "");
    assert.equal(
      printed.length,
      expected.length,
      `the block printed ${printed.length} lines and annotates ${expected.length}:\n${run.stdout}`,
    );
    expected.forEach((want, i) => {
      assertMatches(JSON.parse(want), JSON.parse(printed[i]), `step ${i + 1}`);
    });

    // the point of the whole scenario, asserted as itself and not inferred
    // from the loop above
    const last = JSON.parse(printed[printed.length - 1]) as { derived_state: string; events: string[] };
    assert.equal(last.derived_state, "adopted", "the quickstart ends at a TERMINAL adopted receipt");
    assert.deepEqual(last.events, ["requested", "delivered", "attempted", "adopted"]);
  } finally {
    stop(inst);
  }
});

test("the README promises no artifact that does not exist", () => {
  // §1's rule, kept mechanical, and NARROWED BY B1/B2 rather than dropped.
  //
  // Two commands a reader could copy now name artifacts this project intends to
  // publish and has not: `docker run ghcr.io/...` and
  // `npm install -g @skillonomia/cli`. Writing them down is right — they are the
  // documented shapes — and writing them as if they WORKED is the defect. So:
  //
  //   * `npx skillonomia` stays forbidden outright. That name on the public
  //     registry is somebody else's package, and `npx` would run it.
  //   * a `docker run`/`pull` of the published image must carry the `<digest>`
  //     PLACEHOLDER. A concrete digest would be a pull a reader can attempt and
  //     an artifact this repository invented.
  //   * and the README must say, in prose, that neither has been published.
  const blocks = [...README.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  for (const b of blocks) {
    for (const line of b.split("\n")) {
      const cmd = line.trim();
      assert.doesNotMatch(
        cmd,
        /^npx\s/,
        `README runnable block: \`${cmd}\` — the public npm name is an unrelated placeholder (§Availability)`,
      );
      if (/^docker\s+(run|pull)\b/.test(cmd) || /ghcr\.io/.test(cmd)) {
        const local = /skillonomia:local\b/.test(cmd) || /skillonomia:ci\b/.test(cmd);
        const placeholder = /@sha256:<digest>/.test(cmd) || /\\$/.test(cmd);
        assert.ok(
          local || placeholder,
          `README runnable block: \`${cmd}\` — an image is either built locally or named by the \`<digest>\` ` +
            "placeholder; a concrete reference here would be a pull of something nobody published",
        );
      }
    }
  }

  // The prose half. A placeholder a reader does not notice is a promise, so the
  // absence is stated in words as well as in syntax.
  assert.match(README, /No digest has been published/, "README says the image has no published digest");
  assert.match(
    README,
    /`@skillonomia\/cli` is \*\*not on the npm registry yet\*\*/,
    "README says the CLI is not on the registry yet",
  );
});

// ---------------------------------------------------------------------------
// THE RELEASE GATE MUST REFUSE IN ITS OWN VOICE.
//
// `ci/quickstart-docker.sh` is what the release is measured against, and it
// drives `ci/quickstart.sh`. That script parses every response through one
// helper. The helper used to be `json.load(sys.stdin); print(<expr>)`, which
// reads a value where the answer has the expected shape and DIES OF PYTHON
// where it does not: an empty body, a proxy's plain-text 502, or a typed API
// error carrying no `api_key` each ended the gate with a JSONDecodeError or a
// KeyError naming python's internals — not the step, not what came back. The
// script has owned a `fail()` that says both all along; the parser was dying
// before reaching it.
//
// This probe runs THE SHIPPED FILE, not a copy of its logic: it reads
// `ci/quickstart.sh`, takes the parser exactly as the script defines it, and
// feeds it the three answers a gate meets on a bad day. A traceback reaching
// the log is the defect, so a traceback fails this test.
test("the quickstart parser refuses an empty, an untyped and a wrong-shaped body in the script's own voice", () => {
  const script = readFileSync(join(ROOT, "ci/quickstart.sh"), "utf8");

  // The parser is taken from the file, so a rewrite that drops the refusal
  // cannot leave this probe passing against yesterday's text.
  const start = script.indexOf("QS_PARSER='");
  const end = script.indexOf("\njqf() {", start);
  assert.ok(start > 0 && end > start, "ci/quickstart.sh no longer defines QS_PARSER followed by jqf()");
  const defs = script.slice(start, end) + "\njqf() { QS_EXPR=\"$1\" python3 -c \"$QS_PARSER\"; }";

  const cases: Array<[string, string, RegExp]> = [
    ["an empty body", "", /the response body was EMPTY where JSON was required/],
    ["a body that is not JSON", "service unavailable", /the response is not JSON/],
    ["JSON without the field", '{"error":{"code":"UNAUTHORIZED"}}', /the response is JSON but has no d\['api_key'\]/],
  ];

  for (const [what, body, expected] of cases) {
    const run = spawnSync("bash", ["-c", `${defs}\nprintf '%s' "$1" | jqf "d['api_key']"`, "_", body], {
      encoding: "utf8",
      env: { ...process.env, QS_STEP: "9.1.6.1 exchange the bootstrap token for the owner key" },
    });
    assert.equal(run.status, 1, `${what}: the gate must exit 1, got ${run.status}`);
    assert.match(run.stderr, /^FAIL: /m, `${what}: the refusal must be the script's own FAIL line`);
    assert.match(run.stderr, expected, `${what}: the refusal must say which of the three answers arrived`);
    assert.match(
      run.stderr,
      /9\.1\.6\.1 exchange the bootstrap token/,
      `${what}: the refusal must name the STEP — a gate that says only "failed" sends its reader back to guessing`,
    );
    // The defect is a TRACEBACK — python's frames in place of a sentence. The
    // exception's NAME inside the refusal is not the defect; it is evidence,
    // and the message carries it on purpose. So this forbids the frames.
    assert.doesNotMatch(
      run.stderr,
      /Traceback \(most recent call last\)|^\s+File ".*", line \d+/m,
      `${what}: python frames in the log IS the defect this probe exists for`,
    );
  }

  // …and the value still comes back on the happy path, or the repair broke the gate.
  const ok = spawnSync("bash", ["-c", `${defs}\nprintf '%s' "$1" | jqf "d['api_key']"`, "_", '{"api_key":"sk_own_abc"}'], {
    encoding: "utf8",
    env: { ...process.env, QS_STEP: "9.1.6.1" },
  });
  assert.equal(ok.status, 0, "the happy path must still succeed");
  assert.equal(ok.stdout.trim(), "sk_own_abc", "the happy path must still yield the value");
});

// ---------------------------------------------------------------------------
// A DOCUMENT MAY NOT ADVERTISE A COMMAND THIS PROJECT HAS ALREADY REPLACED.
//
// `README.md`'s Development block told a reader to run `bun test`. That command
// exists, and it FAILS: `package.json` defines the suite as
// `bun test --timeout 120000`, bun's own default is five seconds, and four
// tests here legitimately take 7-25 s because they sweep a whole set. So the
// document shipped a runnable line that does not work — and the same mistake
// had already been found and fixed in `.github/workflows/ci.yml`, which is what
// makes it worth a guard rather than an edit: one spelling was repaired and the
// other was left, in a different file, saying the same wrong thing.
//
// The rule is derived from `package.json`, not listed here: if a script's
// command begins with what a README line runs, and the script adds more, then
// the README is advertising the truncated form of a command this project has
// already decided how to run. The remedy is named in the failure, so nobody has
// to guess which script was meant.
test("no runnable README line is the truncated form of a command package.json defines", () => {
  const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
  const blocks = [...README.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]);

  for (const block of blocks) {
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line) continue;
      for (const [name, body] of Object.entries(scripts)) {
        if (body === line) continue;                       // the whole command: fine
        if (!body.startsWith(line + " ")) continue;         // unrelated: fine
        // The defect is DROPPED FLAGS, not a shorter command. `npm run check` is
        // `npm run typecheck && npm test`, so the README's `npm run typecheck` is
        // a prefix of it — and is its own perfectly good command. What cannot be
        // dropped is the tail that MODIFIES the same invocation, and that tail
        // begins with a flag.
        const tail = body.slice(line.length + 1);
        if (!tail.startsWith("-")) continue;
        assert.fail(
          `README runs \`${line}\`, which is \`npm run ${name}\` (\`${body}\`) with its tail cut off. ` +
            `The missing part is not decoration — run \`npm run ${name}\`.`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// A DELIVERY RECORD THAT CAN BE EMPTY IS NOT A RECORD.
//
// `ci/quickstart-docker.sh` prints the image id and repo digests, and CI keeps
// the same query's answer in `ci/quickstart-image-id.txt`, calling it a release
// delivery record. The step used to be one `docker image inspect --format` that
// PRINTED and asserted nothing: `join` over an empty or absent list is not an
// error — measured against docker 29.5.2, a null field yields "" and exits 0 —
// so an image that answered with no id would have printed a blank line and the
// gate would have carried on with an empty record.
//
// Two answers that look alike and are not: an empty ID is a failure (the
// inspect did not answer for this tag), an empty DIGEST LIST is the normal case
// (V1 publishes no image, so nothing was ever pushed) and must be said in words
// rather than trail off into whitespace.
//
// The probe runs THE SHIPPED FILE's own block with `docker` stubbed on PATH.
test("the quickstart gate refuses an empty image id and spells out an empty digest list", () => {
  const script = readFileSync(join(ROOT, "ci/quickstart-docker.sh"), "utf8");
  const from = script.indexOf("# THE DELIVERY RECORD");
  const to = script.indexOf("\n\n", script.indexOf('echo "digests', from));
  assert.ok(from > 0 && to > from, "ci/quickstart-docker.sh no longer carries the delivery-record block");
  const block = script.slice(from, to);

  const withStub = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "sklo-docker-stub-"));
    writeFileSync(join(dir, "docker"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const run = spawnSync("bash", ["-c", `set -euo pipefail\n${block}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, IMAGE: "skillonomia:probe" },
    });
    rmSync(dir, { recursive: true, force: true });
    return run;
  };

  const idOnly = 'case "$*" in *RepoDigests*) echo "";; *) echo "sha256:deadbeef";; esac';
  const both = 'case "$*" in *RepoDigests*) echo "reg@sha256:abc";; *) echo "sha256:deadbeef";; esac';

  const ok = withStub(both);
  assert.equal(ok.status, 0, "an image with an id and a digest must pass");
  assert.match(ok.stdout, /id\s*:\s*sha256:deadbeef/, "the id must be reported");
  assert.match(ok.stdout, /digests\s*:\s*reg@sha256:abc/, "the digest must be reported");

  const local = withStub(idOnly);
  assert.equal(local.status, 0, "a locally built image with no repo digest is NOT a failure");
  assert.match(
    local.stdout,
    /digests\s*:\s*\(none/,
    "an empty digest list must be said in words — this project publishes no image, and silence reads as a value",
  );

  const noId = withStub('echo ""');
  assert.equal(noId.status, 1, "an empty image id must fail the gate");
  assert.match(noId.stderr, /^FAIL: .*has no image id/m, "…in the script's own voice");

  const broken = withStub("exit 1");
  assert.equal(broken.status, 1, "an inspect that does not answer must fail the gate");
  assert.match(broken.stderr, /^FAIL: docker image inspect did not answer/m, "…naming what did not answer");
});
