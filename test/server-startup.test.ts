// THE STARTUP ORDER, AS A LIVE REGRESSION.
//
// `serve` used to open the deployment first and bind the socket afterwards.
// `server.listen()` returns with the bind still pending, so on the ordinary
// failure — `EADDRINUSE`, a port another instance already holds — the process
// had already created the data directory, migrated a database, run the §9.1
// bootstrap, installed the seed package and PRINTED THE WHOLE SUCCESS BANNER,
// including the two one-time credentials, before Node emitted the bind error
// as an unhandled `error` event. The operator got a banner from a server that
// never served, two secrets in the terminal scrollback, and exit code 1.
//
// The fix is an ordering, so the test is an ordering: bind first, and let the
// absence of everything else be the assertion. An absence only means something
// next to a presence, so the first case here is the POSITIVE CONTROL — the same
// command on a free port, which does create and print all of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CHECK_FAILED } from "../src/cli-commands.ts";
import { BOOTSTRAP_FILENAME, DB_FILENAME } from "../src/server.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.ts");

/** A data directory path that does NOT exist yet: its creation is the subject. */
function unmadeDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "sklo-startup-")), "data");
}

/** Hold a real TCP port so a second bind on it fails the way a second instance does. */
async function occupied(): Promise<{ port: number; release: () => void }> {
  const holder: Server = createServer();
  holder.listen(0, "127.0.0.1");
  await once(holder, "listening");
  const addr = holder.address();
  assert.ok(addr && typeof addr === "object", "the port holder must have an address");
  return { port: addr.port, release: () => holder.close() };
}

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** stdout and stderr interleaved: the claim is about what the operator sees */
  out: string;
}

/**
 * Run `serve` as a real process. `until` decides when the run has shown what it
 * is going to show: the failing case ends by itself, the succeeding one has to
 * be signalled once its banner is out.
 */
function serveRun(args: readonly string[], until?: (out: string) => boolean): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, SKILLONOMIA_DATA: "", SKILLONOMIA_PORT: "", SKILLONOMIA_HOST: "" },
    });
    let out = "";
    let signalled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve did not finish in 30 s: ${out}`));
    }, 30_000);
    const read = (c: Buffer): void => {
      out += c.toString("utf8");
      if (!signalled && until?.(out) === true) {
        signalled = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", reject);
    // `close`, not `exit`: it fires once the pipes have been drained, and the
    // whole question here is what did or did not reach them
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

test("the positive control: a free port creates the deployment and prints the §9.1 credentials", async () => {
  const dataDir = unmadeDataDir();
  const run = await serveRun(["serve", "--port", "0", "--data", dataDir], (o) => o.includes("DEMO_ADOPTER_TOKEN="));
  assert.match(run.out, /listening on http:\/\//, run.out);
  assert.match(run.out, /BOOTSTRAP_OWNER_TOKEN=/, "a first start prints the one-time owner token");
  assert.match(run.out, /DEMO_ADOPTER_TOKEN=/, "…and the demo adopter's key");
  assert.ok(existsSync(join(dataDir, DB_FILENAME)), "a first start migrates a database");
  assert.ok(existsSync(join(dataDir, BOOTSTRAP_FILENAME)), "a first start records the outstanding token's hash");
});

test("EADDRINUSE is fail-closed: no banner, no credentials, no data directory, non-zero exit", async () => {
  const { port, release } = await occupied();
  const dataDir = unmadeDataDir();
  let run: Run;
  try {
    run = await serveRun(["serve", "--port", String(port), "--data", dataDir]);
  } finally {
    release();
  }

  assert.equal(run.signal, null, `the process must end by itself, not by a signal — ${run.out}`);
  assert.equal(run.code, EXIT_CHECK_FAILED, `a failed bind is an operational failure (1) — ${run.out}`);
  // The two runtimes word it differently — Node names the errno, Bun names the
  // port — and both are run by this suite. What is asserted is the operator's
  // side of it: the message says the port was the problem.
  assert.match(
    run.out,
    /EADDRINUSE|port \d+ in use/,
    `the refusal does not say what failed: ${JSON.stringify(run.out)}`,
  );
  assert.doesNotMatch(run.out, /at .*\.ts:\d+/, "a bound port is an operational failure, not a crash to report");

  // The banner belongs to a listener. There is none.
  assert.doesNotMatch(run.out, /listening on http:\/\//, `a server that never bound announced itself:\n${run.out}`);
  assert.doesNotMatch(run.out, /first start/, `the §9.1 block was printed without a listener:\n${run.out}`);
  for (const secret of ["BOOTSTRAP_OWNER_TOKEN=", "DEMO_ADOPTER_TOKEN="]) {
    assert.ok(
      !run.out.includes(secret),
      `${secret} reached the terminal from a process that never served — the credential is printed once and ` +
        `stored nowhere, so this is the whole of its exposure:\n${run.out}`,
    );
  }

  // …and no side effect of the bootstrap survives, because none was reached.
  assert.ok(
    !existsSync(dataDir),
    `the data directory was created for a deployment that never opened: ${dataDir}`,
  );
});
