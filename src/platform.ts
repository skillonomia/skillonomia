// WHERE A DEPLOYMENT KEEPS ITS DATA — one answer, for every host this CLI runs on.
//
// The data directory holds the SQLite file, the package blobs, the outstanding
// bootstrap token's hash and the webhook secret store. Until B2 there was one
// rule for all of it — `SKILLONOMIA_DATA`, or `/data` — and `/data` is the
// volume the CONTAINER declares. On a macOS or Windows workstation that default
// names a directory at the root of the system disk which the user running the
// CLI has no business creating, so the npm path had exactly one usable form:
// set the variable, every time, or watch the first start fail (or worse,
// succeed as root and leave a registry nobody else can open).
//
// So the default is now the platform's own answer to the same question, and the
// variable stays what it always was: an override that beats every default,
// which is how the container keeps `/data` (the Dockerfile sets it) and how an
// operator pins a deployment to a volume they chose.
//
//   | platform | default                                            |
//   |----------|----------------------------------------------------|
//   | macOS    | `~/Library/Application Support/Skillonomia`         |
//   | Windows  | `%LOCALAPPDATA%\Skillonomia`                        |
//   | Linux    | `${XDG_STATE_HOME:-~/.local/state}/skillonomia`     |
//   | any      | `SKILLONOMIA_DATA`, which always wins               |
//
// Linux uses STATE and not CONFIG or CACHE: the XDG basedir specification
// reserves `$XDG_STATE_HOME` for "state data that should persist between
// restarts but is not important enough to be in the data directory" — logs,
// history, current state — and a registry database is precisely that. A cache
// may be deleted at any moment and this must not be.
//
// NOTHING IS DERIVED FROM NOTHING. A host with no `HOME` (or no `LOCALAPPDATA`)
// gets a REFUSAL naming the variable to set, not a relative path resolved
// against whatever the working directory happened to be. A data directory this
// code guessed is a place the operator did not choose, and the first start
// writes credentials into it.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The override, named once. Every path below is a default it beats. */
export const DATA_DIR_VARIABLE = "SKILLONOMIA_DATA";

/** The directory name under the platform's own state/support location. */
const UNIX_DIR = "skillonomia";
const WINDOWS_DIR = "Skillonomia";
const MACOS_DIR = "Skillonomia";

export type Env = Record<string, string | undefined>;

/** An unset variable and an empty one mean the same thing: not given. */
function value(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * The data directory for one host, from one environment. Both are parameters
 * rather than reads of `process`, so `test/platform-paths.test.ts` can assert
 * the whole table on any machine — including the three rows that cannot be
 * reached from the host it runs on.
 *
 * The home directory comes from `env` and from nowhere else. An optional
 * parameter defaulting to `homedir()` looked equivalent and is not: passing
 * `undefined` explicitly TAKES the default in JavaScript, so a test asking
 * "what happens with no home at all" would have been answered with this
 * machine's home and would have passed while checking nothing.
 */
export function dataDirFor(platform: NodeJS.Platform, env: Env): string {
  const override = value(env, DATA_DIR_VARIABLE);
  if (override !== undefined) return override;

  // The SEPARATOR is the target platform's, not this process's. `node:path`'s
  // default binding follows the host, so a Linux machine asked what a Windows
  // deployment's directory is would answer with a forward slash in the middle
  // of a drive path — which is the one thing this table exists to get right.
  const join = platform === "win32" ? win32.join : posix.join;

  if (platform === "win32") {
    const local = value(env, "LOCALAPPDATA");
    if (local !== undefined) return join(local, WINDOWS_DIR);
    const profile = value(env, "USERPROFILE") ?? value(env, "HOME");
    if (profile === undefined) throw noHome("LOCALAPPDATA");
    return join(profile, "AppData", "Local", WINDOWS_DIR);
  }

  const homeDir = value(env, "HOME");
  if (platform === "darwin") {
    if (homeDir === undefined) throw noHome("HOME");
    return join(homeDir, "Library", "Application Support", MACOS_DIR);
  }

  // Linux and every other POSIX host: XDG state, or its specified default.
  const state = value(env, "XDG_STATE_HOME");
  if (state !== undefined) return join(state, UNIX_DIR);
  if (homeDir === undefined) throw noHome("HOME");
  return join(homeDir, ".local", "state", UNIX_DIR);
}

function noHome(variable: string): Error {
  return new Error(
    `no home directory: ${variable} is not set, so there is no platform default for the data directory — ` +
      `set ${DATA_DIR_VARIABLE} to the directory this deployment should use, or pass \`serve --data DIR\``,
  );
}

/**
 * The data directory THIS process would use with no `--data` on the line.
 *
 * `homedir()` is folded in UNDER the environment: on a POSIX host `HOME` is
 * normally set and wins, and on one where it is not, the operating system still
 * knows where the account lives.
 */
export function defaultDataDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  return dataDirFor(platform, { HOME: safeHomedir(), ...env });
}

function safeHomedir(): string | undefined {
  try {
    const home = homedir();
    return home === "" ? undefined : home;
  } catch {
    return undefined;
  }
}
