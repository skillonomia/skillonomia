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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    assert.deepEqual(last.events, ["delivered", "attempted", "adopted"]);
  } finally {
    stop(inst);
  }
});

test("the README promises no artifact that does not exist", () => {
  // §1's rule, kept mechanical: a `docker run` of a named image or an `npx` of
  // this package would send a reader to something this project has not
  // published. Both are allowed to appear in prose that says they do NOT
  // exist; neither may appear inside a runnable block.
  const blocks = [...README.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  for (const b of blocks) {
    for (const line of b.split("\n")) {
      const cmd = line.trim();
      assert.doesNotMatch(
        cmd,
        /^npx\s/,
        `README runnable block: \`${cmd}\` — the public npm name is an unrelated placeholder (§Availability)`,
      );
      assert.doesNotMatch(
        cmd,
        /^docker\s+(run|pull)\b(?!.*skillonomia:local)/,
        `README runnable block: \`${cmd}\` — no container image is published; build it locally`,
      );
    }
  }
});
