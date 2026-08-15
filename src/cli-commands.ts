// `skillonomia <command>` — the whole command line, in one dispatcher.
//
// All three release packaging paths run src/cli.ts, which is a four-line
// wrapper around `runCli` below: the Docker image (`ENTRYPOINT bun run
// /app/src/cli.ts`, `CMD ["serve"]`), `bin/skillonomia.js` (the npx launcher,
// which forwards argv verbatim), and the `bun build --compile` binary. There
// is therefore exactly one place where a subcommand is defined, and every path
// gets every subcommand.
//
// The commands are thin: `serve` composes src/server.ts, `verify` calls
// src/verify-cli.ts (§4.4), `verify-log` calls src/verify-log.ts (§3).
// This module owns argument parsing, the human/JSON output forms and the exit
// codes, and nothing else.
//
// **Exit codes.** 0 success (including the §4.4 warning verdicts, which are
// verifications that succeeded), 1 a check that FAILED or an operational
// error, 2 wrong usage. A caller can therefore distinguish "this package does
// not verify" from "you called me wrong", which a single non-zero code cannot.
import { existsSync } from "node:fs";
import { VERSION } from "./version.ts";
import { serve, defaultDbPath, type ServeOptions } from "./server.ts";
import { verifyPackageAt } from "./verify-cli.ts";
import { verifyLogAt } from "./verify-log.ts";
import { runDemo } from "./demo.ts";

export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_USAGE = 2;

/** Where a command writes. Injected so the tests can read what it printed;
 *  the process entry point passes the console. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Wrong usage — reported with the help text and EXIT_USAGE, never a stack. */
class UsageError extends Error {}

export const HELP: string = [
  `skillonomia ${VERSION} — self-hosted registry of Verified Skill Packages`,
  "",
  "usage: skillonomia <command> [options]",
  "",
  "commands:",
  "  serve [--port N] [--data DIR] [--host H]",
  "        run the registry (REST + /mcp + dashboard + delivery worker).",
  "        This is also what a bare `skillonomia` does.",
  "  verify <package> [<registry-db>] [--db PATH] [--json]",
  "        §4.4 verification of a package directory, .tar or .tar.gz against a",
  "        registry database. Exit 0 = verified (warning verdicts included),",
  "        1 = not verified.",
  "  verify-log [<registry-db>] [--db PATH] [--json]",
  "        walk the §4.4 transparency-log hash chain and recompute every link.",
  "        Exit 0 = intact, 1 = broken.",
  "  demo [--base-url URL] [--data DIR] [--json]",
  "        the §9.1 quickstart, end to end: bootstrap exchange, seed package,",
  "        adoption, the package's own step, terminal `adopted` receipt and a",
  "        read-back. With no --base-url it starts a clean deployment of its own",
  "        in a temporary directory. Needs no bash, curl or tar.",
  "  version",
  "        print the release version.",
  "  help",
  "        this text.",
  "",
  "The registry database defaults to <SKILLONOMIA_DATA>/skillonomia.db, the file",
  "`serve` opens — so `skillonomia verify ./pkg` checks against this deployment.",
  "SKILLONOMIA_DATA itself defaults to the platform's own state location",
  "(macOS ~/Library/Application Support/Skillonomia, Windows %LOCALAPPDATA%\\Skillonomia,",
  "Linux ${XDG_STATE_HOME:-~/.local/state}/skillonomia); the container sets it to /data.",
  "",
  "environment: SKILLONOMIA_DATA, SKILLONOMIA_PORT, SKILLONOMIA_HOST,",
  "             SKILLONOMIA_WORKER_MS, SKILLONOMIA_ASSETS,",
  "             SKILLONOMIA_BOOTSTRAP_TOKEN, SKILLONOMIA_ADOPTER_TOKEN (demo)",
].join("\n");

interface ParsedArgs {
  /** `--name value` options, by name */
  values: Record<string, string>;
  /** `--name` switches that were present */
  flags: Set<string>;
  positional: string[];
}

/**
 * Split argv into options and positionals. Unknown options and value options
 * with no value are usage errors — never silently ignored, and never coerced
 * into a positional, which is how `verify --db` could otherwise have gone
 * looking for a package called `--db`.
 */
function parseArgs(argv: readonly string[], valueOpts: readonly string[], flagOpts: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { values: {}, flags: new Set(), positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    if (flagOpts.includes(arg)) {
      out.flags.add(arg);
      continue;
    }
    if (valueOpts.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      out.values[arg] = value;
      i += 1;
      continue;
    }
    throw new UsageError(`unknown option ${arg}`);
  }
  return out;
}

/** The registry database this invocation operates on. */
function dbPathOf(parsed: ParsedArgs, positionalIndex: number): string {
  return parsed.values["--db"] ?? parsed.positional[positionalIndex] ?? defaultDbPath();
}

function requireExistingDb(path: string): string {
  if (!existsSync(path)) {
    throw new UsageError(
      `registry database not found: ${path} — pass --db PATH, or set SKILLONOMIA_DATA to the deployment's data directory`,
    );
  }
  return path;
}

// ------------------------------------------------------------------- serve

/** How long a signalled `serve` waits for the loop to drain before forcing the
 *  exit. Only reached if a handle outlives the ones `serve` owns. */
const SHUTDOWN_GRACE_MS = 5_000;

async function cmdServe(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv, ["--port", "--data", "--host"], []);
  if (parsed.positional.length > 0) {
    throw new UsageError(`serve takes no positional arguments (got ${parsed.positional[0]})`);
  }
  const opts: ServeOptions = {};
  if (parsed.values["--port"] !== undefined) {
    const port = Number(parsed.values["--port"]);
    // serve() rejects this too; catching it here makes it a USAGE error
    // rather than a crash, which is the difference the exit codes carry
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(`--port must be an integer 0..65535 (got ${parsed.values["--port"]})`);
    }
    opts.port = port;
  }
  if (parsed.values["--data"] !== undefined) opts.dataDir = parsed.values["--data"];
  if (parsed.values["--host"] !== undefined) opts.host = parsed.values["--host"];
  opts.log = (line) => io.out(line);

  // A signalled `serve` TRUNCATED its own log. That matters to an operator
  // because the lines at risk are the §9.1 one-time credentials: printed
  // ONCE, stored nowhere, and `docker stop` (or any supervisor) sends SIGTERM.
  //
  // THE CAUSE, measured. The handlers used to be installed AFTER `serve()`
  // returned — that is, after the whole startup block had been printed. A
  // SIGTERM arriving in that window found no JS handler and took the DEFAULT
  // disposition, which terminates the process outright, and everything still
  // queued for stdout (a pipe is written asynchronously) died with it. The
  // window is small but it is entered from outside: a parent that signals as
  // soon as it reads the banner is racing a handful of statements. Measured on
  // this tree before the fix: 19 of 60 runs lost the credentials block, with
  // the child reported dead by signal rather than by exit code. So the handlers
  // now go in FIRST, before a single byte can leave. `instance` is filled in
  // below, which is safe: a signal cannot be handled until this synchronous
  // block has finished anyway.
  //
  // WHY THE HANDLER NO LONGER CALLS `process.exit`. `process.exit` discards
  // writes that are still queued rather than written. At this output size that
  // path never lost a line in 100 runs once the handler was installed in time,
  // so it was NOT the flake — but it is a real loss path for exactly the lines
  // that cannot be reprinted. Closing the listener, the interval and the
  // database leaves nothing holding the loop open except the writes already in
  // flight, and those keep stdout referenced until their bytes are gone, so the
  // process exits 0 having actually printed what it said. The unref'd fallback
  // bounds the wait if a handle this command does not own keeps the loop alive;
  // being unref'd it can never delay the exit itself.
  let instance: Awaited<ReturnType<typeof serve>> | null = null;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return; // SIGINT after SIGTERM must not close twice
    stopped = true;
    instance?.close();
    process.exitCode = EXIT_OK;
    setTimeout(() => process.exit(EXIT_OK), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  instance = await serve(opts);
  // A signal that arrived while the socket was still binding found no instance
  // to close. Closing it here is the same decision taken one moment later.
  if (stopped) instance.close();
  // the listener keeps the process alive; returning here is not exiting
  return EXIT_OK;
}

// ------------------------------------------------------------------ verify

function cmdVerify(argv: readonly string[], io: CliIo): number {
  const parsed = parseArgs(argv, ["--db"], ["--json"]);
  if (parsed.positional.length === 0) {
    throw new UsageError("verify needs a package: skillonomia verify <package-dir|.tar|.tar.gz>");
  }
  if (parsed.positional.length > 2) {
    throw new UsageError(`verify takes at most two positional arguments (got ${parsed.positional.length})`);
  }
  const pkg = parsed.positional[0];
  if (!existsSync(pkg)) throw new UsageError(`package not found: ${pkg}`);
  const dbPath = requireExistingDb(dbPathOf(parsed, 1));

  const { outcome, ok, warning } = verifyPackageAt(pkg, dbPath);
  const json = parsed.flags.has("--json");

  if (json) {
    // the machine form is the verdict envelope src/verify.ts returns, verbatim
    io.out(JSON.stringify(outcome));
  } else {
    const lines = [`package : ${pkg}`, `registry: ${dbPath}`, `verdict : ${outcome.verdict}`];
    if (outcome.detail !== undefined) lines.push(`detail  : ${outcome.detail}`);
    if (outcome.manifest_hash !== undefined) lines.push(`manifest: ${outcome.manifest_hash}`);
    if (outcome.successor_version_id !== undefined) lines.push(`successor: ${outcome.successor_version_id}`);
    if (outcome.revocation_reason !== undefined) lines.push(`reason  : ${outcome.revocation_reason}`);
    if (warning) lines.push("verify  : OK (with a warning verdict — read it before adopting)");
    else if (ok) lines.push("verify  : OK");
    else lines.push("verify  : FAILED");
    // a failed check goes to stderr, so `skillonomia verify … > out` keeps a
    // shell pipeline's error visible
    for (const line of lines) (ok ? io.out : io.err)(line);
  }
  return ok ? EXIT_OK : EXIT_CHECK_FAILED;
}

// -------------------------------------------------------------- verify-log

function cmdVerifyLog(argv: readonly string[], io: CliIo): number {
  const parsed = parseArgs(argv, ["--db"], ["--json"]);
  if (parsed.positional.length > 1) {
    throw new UsageError(`verify-log takes at most one positional argument (got ${parsed.positional.length})`);
  }
  const dbPath = requireExistingDb(dbPathOf(parsed, 0));
  const res = verifyLogAt(dbPath);

  if (parsed.flags.has("--json")) {
    io.out(JSON.stringify({ ...res, registry: dbPath }));
  } else if (res.ok) {
    io.out(`verify-log: OK (${res.checked} entries, chain intact)`);
  } else {
    io.err(
      `verify-log: FAIL at seq ${res.failed_seq}: ${res.reason} (${res.checked} entries verified before failure)`,
    );
  }
  return res.ok ? EXIT_OK : EXIT_CHECK_FAILED;
}

// -------------------------------------------------------------------- demo

/**
 * The §9.1 quickstart as a subcommand (src/demo.ts). Tokens come from the
 * ENVIRONMENT and not from the command line: an argument is visible in `ps` to
 * every other user of the machine, and these two are one-time credentials that
 * mint an owner key.
 */
async function cmdDemo(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv, ["--base-url", "--data"], ["--json"]);
  if (parsed.positional.length > 0) {
    throw new UsageError(`demo takes no positional arguments (got ${parsed.positional[0]})`);
  }
  const json = parsed.flags.has("--json");
  const result = await runDemo({
    baseUrl: parsed.values["--base-url"],
    dataDir: parsed.values["--data"],
    bootstrapToken: process.env.SKILLONOMIA_BOOTSTRAP_TOKEN,
    adopterToken: process.env.SKILLONOMIA_ADOPTER_TOKEN,
    log: json ? () => {} : (line) => io.out(line),
  });
  if (json) io.out(JSON.stringify(result));
  else io.out(`DEMO OK — receipt ${result.receipt_id} reached terminal \`adopted\` in ${(result.elapsed_ms / 1000).toFixed(1)}s`);
  return EXIT_OK;
}

// ---------------------------------------------------------------- dispatch

/**
 * Run one command line. Resolves to the process exit code; `serve` resolves 0
 * once its socket is BOUND and leaves the listener running, which is what keeps
 * the process alive. A bind that fails rejects inside `cmdServe` and is caught
 * below as the operational failure it is — one message, exit 1, no banner.
 */
export async function runCli(argv: readonly string[], io: CliIo = CONSOLE_IO): Promise<number> {
  // A bare invocation serves — the behaviour every packaging path shipped
  // before there were subcommands, and what the container's CMD relies on.
  const cmd = argv[0] ?? "serve";
  const rest = argv.slice(1);
  try {
    switch (cmd) {
      case "version":
      case "--version":
      case "-v":
        io.out(VERSION);
        return EXIT_OK;
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return EXIT_OK;
      case "serve":
        return await cmdServe(rest, io);
      case "verify":
        return cmdVerify(rest, io);
      case "verify-log":
        return cmdVerifyLog(rest, io);
      case "demo":
        return await cmdDemo(rest, io);
      default:
        throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`skillonomia: ${e.message}`);
      io.err("");
      io.err(HELP);
      return EXIT_USAGE;
    }
    // An operational failure — an unreadable database, a port already bound —
    // is reported as a message, not as a stack trace: this is a command-line
    // tool, and the code says which kind of failure it was.
    io.err(`skillonomia: ${String((e as Error)?.message ?? e)}`);
    return EXIT_CHECK_FAILED;
  }
}
