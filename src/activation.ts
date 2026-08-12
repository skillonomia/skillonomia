// NATIVE ACTIVATION — the adapter half: how a managed version becomes a file
// a runtime will actually read, and where that file may be written.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE. Skillonomia is the source of
// truth; a native file is a PROJECTION of it. A projection has to land in the
// place the runtime looks, and the places runtimes look are directories in
// somebody's home, somebody's project, somebody's plugin. So the interface is
// one interface and the ROOT IS A PARAMETER:
//
//     nothing in this file names a real runtime directory, expands `~`, reads
//     HOME, or has a default root. A deployment that configures no root
//     activates nothing and says so.
//
// That is not caution about tests. Writing into a fleet's real Claude Code or
// Codex directories is an action on somebody else's runtime, and it is
// authorized separately from the code that knows how. Keeping the root a
// parameter is what lets the second decision be made later, by a person,
// without this file changing at all — and a test greps this file for a home
// directory, a `~` path and an absolute user path, so the rule is checked and
// not merely written down here.
//
// WHAT FOLLOWS FROM THAT, AND IS THE REST OF THE MODULE:
//
//   * a write may not leave the root. Not lexically (`..`), and not physically:
//     a symbolic link is the ordinary way a fleet shares one skill library, so
//     `<root>/.claude/skills` being a link is expected — and if that link
//     leaves the root, a write through it leaves the root too. Every directory
//     component is created, then RESOLVED, then checked for containment before
//     the next one is entered, and an existing file is unlinked rather than
//     opened, because opening a planted symlink writes wherever it points.
//
//   * a READ follows symbolic links, and counting follows them too. The same
//     shared-library link that makes writing dangerous makes a non-following
//     walk UNDERCOUNT: a registry that reported "one skill under this root"
//     while the root linked to a library of forty would be reporting the walk
//     it chose rather than what is there.
//
//   * removing a managed copy removes a FILE. It does not, and this module
//     never says it does, reach into an agent that has already read the file.
//     `INSTRUCTIONS_ALREADY_READ` is that sentence, written once, and
//     `erasureClaim` is the guard that keeps any answer built from this module
//     from promising otherwise.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { PackageFiles } from "./archive.ts";
import { evidenceDigestOf, registryObserved, type Evidence } from "./outcome.ts";

// ------------------------------------------------------------- the targets

/**
 * The native locations this version knows how to write, as a closed set.
 *
 * Claude Code reads skills from three scopes and Codex from one. The three
 * Claude scopes differ in WHICH DIRECTORY IS THE ROOT — a home, a project, a
 * plugin — and `personal` and `project` have the same layout INSIDE that root,
 * which is why their templates below are identical and neither is a mistake.
 * The scope is chosen by pointing the adapter at a root, which is exactly the
 * property that lets a real path be configured without this table changing.
 */
export const ACTIVATION_TARGETS = [
  "claude_code_personal",
  "claude_code_project",
  "claude_code_plugin",
  "codex",
] as const;
export type ActivationTarget = (typeof ACTIVATION_TARGETS)[number];

export function isActivationTarget(v: unknown): v is ActivationTarget {
  return typeof v === "string" && (ACTIVATION_TARGETS as readonly string[]).includes(v);
}

/**
 * The directory each target puts a skill in, RELATIVE TO THE ROOT.
 *
 * THIS TABLE IS A STANDING COST, and it is written here rather than left as a
 * note somewhere because that is the only place it will be read. Each row is a
 * promise about somebody else's filesystem layout — a layout decided by another
 * project, on its own schedule, with no obligation to this one. A runtime that
 * moves its skills directory does not break the interface above it; it breaks
 * this table, silently, and every activation afterwards writes to a place
 * nothing reads.
 *
 * So the table is kept SMALL and in ONE place: adding a runtime is a row, and
 * following a runtime that moved is an edit to a row, never a search through
 * the module. What it is NOT is a task that gets finished. For as long as a
 * target is supported, somebody has to check that its row is still true — the
 * same kind of upkeep a pinned dependency needs, and not a gap waiting for one
 * more commit.
 */
const TARGET_DIR: Readonly<Record<ActivationTarget, string>> = {
  claude_code_personal: ".claude/skills",
  claude_code_project: ".claude/skills",
  claude_code_plugin: "skills",
  codex: ".agents/skills",
};

/** The file every target's runtime opens first. */
export const NATIVE_ENTRY = "SKILL.md";

/** What a skill may be called in a native location: the registry's own slug
 *  profile, re-checked here rather than trusted, because this is the boundary
 *  where a name becomes a path. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The directory one skill occupies under a root, as a POSIX relative path. */
export function nativeDirectory(target: ActivationTarget, name: string): string {
  if (!isActivationTarget(target)) throw new ActivationError("unknown_target", "unknown activation target");
  if (!NAME_RE.test(name)) throw new ActivationError("bad_name", "a skill name for a native location must match [a-z0-9][a-z0-9-]{0,63}");
  return `${TARGET_DIR[target]}/${name}`;
}

/** The entry file's path, RELATIVE TO THE ROOT — what the journal records. */
export function nativeRelativePath(target: ActivationTarget, name: string): string {
  return `${nativeDirectory(target, name)}/${NATIVE_ENTRY}`;
}

/** One configured place a deployment may activate into. */
export interface ActivationSite {
  /** an absolute directory. There is no default and none is derived */
  root: string;
  target: ActivationTarget;
}

/**
 * Where, if anywhere, one agent's deployments are materialized.
 *
 * ONE interface, so that "a temporary directory in a test" and "a fleet member's
 * real home" are the same shape and the second needs no new code. The default
 * (`NO_ACTIVATION_ROOTS`) answers `null` for every agent, and a `null` answer is
 * not an error: it is a deployment that has been decided and not yet placed,
 * which the state machine records as `queued`.
 */
export interface ActivationRoots {
  rootFor(agentId: string): ActivationSite | null;
}

/** The shipped default: nothing is configured, so nothing is written. */
export const NO_ACTIVATION_ROOTS: ActivationRoots = { rootFor: () => null };

/** One root and one target for every agent — the simplest real configuration. */
export class FixedActivationRoots implements ActivationRoots {
  private readonly site: ActivationSite;
  constructor(root: string, target: ActivationTarget) {
    if (!isAbsolute(root)) throw new Error("an activation root must be an absolute path");
    if (!isActivationTarget(target)) throw new Error(`unknown activation target ${String(target)}`);
    this.site = { root, target };
  }
  rootFor(): ActivationSite {
    return this.site;
  }
}

/** Per-agent roots, for a deployment whose fleet members do not share one. */
export class PerAgentActivationRoots implements ActivationRoots {
  private readonly sites: Map<string, ActivationSite>;
  constructor(sites: Record<string, ActivationSite>) {
    this.sites = new Map(Object.entries(sites));
  }
  rootFor(agentId: string): ActivationSite | null {
    return this.sites.get(agentId) ?? null;
  }
}

// --------------------------------------------------------------- failures

/**
 * A failure of the adapter, with a CODE and no path in it.
 *
 * The code is what the journal records and what an answer carries. A filesystem
 * error message names absolute paths, and those are the operator's business and
 * not the registry's to publish: a `failed` event whose reason was an `ENOENT`
 * string would put a fleet member's home directory into an INSERT-only table.
 */
export class ActivationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

// ------------------------------------------------------- staying in the root

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The root as the filesystem sees it. It must already exist: creating an
 * activation root would mean this code deciding where to write, which is the
 * one decision it does not make.
 */
export function resolveRoot(root: string): string {
  if (!isAbsolute(root)) throw new ActivationError("root_not_absolute", "an activation root must be an absolute path");
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new ActivationError("root_missing", "the configured activation root does not exist");
  }
  if (!lstatSync(real).isDirectory()) throw new ActivationError("root_not_a_directory", "the configured activation root is not a directory");
  return real;
}

/**
 * Create `<root>/<relDir>` one component at a time and REFUSE to leave the root.
 *
 * Each component is created if absent, then resolved through any symbolic link,
 * then checked for containment; the walk continues from the RESOLVED path, so a
 * link that stays inside the root is followed and one that leaves it stops the
 * activation. Doing this per component rather than once at the end is what
 * catches the case that matters: a root whose `.claude/skills` is a link to a
 * shared library elsewhere on the disk. Writing there would be writing outside
 * the root while every lexical check still passed.
 */
function mkdirWithinRoot(realRoot: string, relDir: string): string {
  let current = realRoot;
  for (const part of relDir.split("/")) {
    if (part.length === 0 || part === "." || part === "..") {
      throw new ActivationError("bad_relative_path", "a native location is a relative path with no traversal");
    }
    const next = join(current, part);
    try {
      mkdirSync(next);
    } catch (e) {
      // EEXIST is the ordinary case on a second activation; anything else is a
      // filesystem refusal and must not be reported as success
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ActivationError("mkdir_failed", "a native directory could not be created");
      }
    }
    let real: string;
    try {
      real = realpathSync(next);
    } catch {
      // a dangling symbolic link: it exists, it resolves to nothing, and
      // writing through it would create a file wherever it points
      throw new ActivationError("outside_root_refused", "a native path component does not resolve inside the activation root");
    }
    if (!within(realRoot, real)) {
      throw new ActivationError("outside_root_refused", "a native path component resolves outside the activation root");
    }
    current = real;
  }
  return current;
}

/** Every path a package carries, checked before it becomes part of a location. */
function checkPackagePath(path: string): void {
  if (path.length === 0 || path.length > 400) throw new ActivationError("bad_package_path", "a package path is 1..400 characters");
  if (isAbsolute(path) || path.startsWith("/")) throw new ActivationError("bad_package_path", "a package path is relative");
  for (const part of path.split("/")) {
    if (part.length === 0 || part === "." || part === "..") {
      throw new ActivationError("bad_package_path", "a package path has no empty or traversing component");
    }
  }
}

// ------------------------------------------------------------ materializing

export interface Materialized {
  /** the entry file's path relative to the root — what the journal stores */
  relpath: string;
  /** how many files of the package were placed */
  files: number;
}

/**
 * Write the managed copy of one version into its native location.
 *
 * The WHOLE package is written, `skill.json` and `SIGNATURE.jws` included, so
 * that the projection carries its own evidence: a copy a runtime can read but
 * nobody can check against the registry is a copy that has to be trusted.
 *
 * An existing entry is UNLINKED before the new bytes are written. `writeFile`
 * on a path that is a symbolic link writes through it, so a link planted at the
 * entry's name would make this function write outside the root while every
 * directory check above passed. Unlinking follows no link.
 */
export function materialize(site: ActivationSite, name: string, files: PackageFiles): Materialized {
  const realRoot = resolveRoot(site.root);
  const relDir = nativeDirectory(site.target, name);
  if (!files.has(NATIVE_ENTRY)) {
    throw new ActivationError("no_entry_file", `a package with no ${NATIVE_ENTRY} has nothing a runtime would read`);
  }
  let written = 0;
  for (const [path, bytes] of files) {
    checkPackagePath(path);
    const dir = path.includes("/") ? mkdirWithinRoot(realRoot, `${relDir}/${dirname(path)}`) : mkdirWithinRoot(realRoot, relDir);
    const target = join(dir, path.split("/").pop() as string);
    try {
      rmSync(target, { force: true });
    } catch {
      throw new ActivationError("replace_failed", "an existing native file could not be replaced");
    }
    try {
      writeFileSync(target, bytes);
    } catch {
      throw new ActivationError("write_failed", "a native file could not be written");
    }
    written += 1;
  }
  return { relpath: nativeRelativePath(site.target, name), files: written };
}

/**
 * Read the entry file back FROM THE NATIVE LOCATION.
 *
 * This is the half that makes `active` mean something: the registry says it
 * activated a version when it has read the bytes back out of the place the
 * runtime will read them, and not when a write call returned without error.
 * Symbolic links are followed here — a shared library reached through a link is
 * a legitimate way for the bytes to be there.
 *
 * A ROOT THAT WILL NOT RESOLVE ANSWERS `null`, like every other way of failing
 * to read. `removeManaged` below has always treated an unresolvable root as an
 * ordinary answer, and the asymmetry between the two was a defect and not a
 * distinction: a root that has been unmounted or renamed made the reading half
 * throw out of a call that its caller handles by state, so the caller's own
 * `failed` path — the one that records a REASON on the journal — was skipped
 * and the deployment kept claiming `active`. There is one honest answer to
 * "are the version's bytes at the native location", and when the location
 * cannot even be reached the answer is no.
 */
export function readBack(site: ActivationSite, name: string): Buffer | null {
  let realRoot: string;
  try {
    realRoot = resolveRoot(site.root);
  } catch {
    return null;
  }
  const target = resolve(realRoot, nativeRelativePath(site.target, name));
  if (!within(realRoot, target)) return null;
  try {
    return readFileSync(target);
  } catch {
    return null;
  }
}

/**
 * WHAT THIS REGISTRY'S OWN JOURNAL SAYS IT PLACED — the record `registryObserved
 * Evidence` will not answer without.
 *
 * Its three fields are the three the journal writes (`assignment_events`:
 * `activation_target`, `native_relpath`, `managed_copy`). It is a PARAMETER and
 * not something this module reads, for the reason `observedArrival` is a
 * parameter in `src/assignments.ts`: a function that could reach the journal
 * itself is a function that could start answering from it, and the two columns
 * are kept apart by not being in one scope.
 */
export interface ActivationPlacement {
  target: ActivationTarget;
  /** the entry path, RELATIVE TO THE ROOT, the journal recorded */
  native_relpath: string;
  /** the journal's last word on the managed copy */
  managed_copy: ManagedCopy;
}

/**
 * THE ONE THING THIS REGISTRY CAN CHECK FOR ITSELF — D-18 part 2, narrowed.
 *
 * §4's `outcome` is decided by a contract, and a contract's `check` is executed
 * against NAMED VALUES a run produced. Almost all of those values are facts
 * about a process on somebody else's computer: an exit code, an output, a
 * command line. This registry did not run that process and cannot, so what it
 * receives about them is a self-report and is published as one [M-7], [M-6].
 *
 * There is exactly one exception, and it is this function. But the exception is
 * NARROWER than "a file under a root this registry manages", and the two defects
 * a review found in the earlier version are both the difference between the two:
 *
 *   THE PATH WAS CHECKED LEXICALLY AND THEN OPENED PHYSICALLY. `resolve` plus
 *   `within` answers about the STRING; `existsSync` follows symbolic links. A
 *   link planted inside the root and pointing out of it passed the first and was
 *   read through by the second, so a file on the other side of the disk was
 *   published as this registry's own `yes`.
 *
 *   AND NOTHING TIED THE ARTIFACT TO A MATERIALIZATION. Any file anybody dropped
 *   under the root produced a `yes`. "The registry can read this directory" is
 *   not "the registry put this file here", and only the second is a thing the
 *   registry has standing to certify.
 *
 * SO A `yes` REQUIRES ALL OF:
 *
 *   * a root this deployment configured, which resolves and is a directory;
 *   * a JOURNAL RECORD of this registry's own — `managed_copy: "written"`, under
 *     THIS site's target — naming a native relative path;
 *   * a contract whose `artifact_path` IS THAT PATH, character for character;
 *   * a path that, RESOLVED THROUGH EVERY LINK, is still inside the root.
 *
 * Drop any one and the answer is `null`: "this registry observed nothing",
 * which is not "the artifact is absent" and which sends the caller back to the
 * self-report. What remains is a genuine `no` — the journal says a copy was
 * written at this path, the registry looked at that path, and nothing of its own
 * is there. That is the drift a fleet operator needs to see, and it is the only
 * `no` this registry is entitled to.
 *
 * WHAT IT DOES NOT DO: it never opens a path a REPORTER named. The only path it
 * joins is the one the SIGNED contract declares AND the journal already wrote.
 */
export function registryObservedEvidence(
  site: ActivationSite | null,
  contract: unknown,
  placed: ActivationPlacement | null,
): Evidence | null {
  if (site === null || site === undefined) return null;
  // THE JOURNAL FIRST, before a path is even formed. A registry with no record
  // of having placed anything has nothing to look for and no standing to look.
  if (placed === null || placed === undefined) return null;
  if (placed.managed_copy !== "written") return null;
  if (placed.target !== site.target) return null;
  const check = (contract as { check?: { kind?: unknown; artifact_path?: unknown } } | null)?.check;
  if (check?.kind !== "artifact_exists" || typeof check.artifact_path !== "string" || check.artifact_path.length === 0) {
    return null;
  }
  // THE CONTRACT MUST BE ASKING ABOUT THE VERY THING THE JOURNAL RECORDED. A
  // contract naming any other path is asking about something this registry did
  // not place, whether or not that path happens to be under the root.
  if (check.artifact_path !== placed.native_relpath) return null;
  let realRoot: string;
  try {
    realRoot = resolveRoot(site.root);
  } catch {
    return null;
  }
  const target = resolve(realRoot, check.artifact_path);
  if (!within(realRoot, target)) return null;

  // NOW THE FILESYSTEM. `lstat` first, because it follows nothing: a name that
  // holds nothing is an honest absence, and the walk did happen.
  let present: boolean;
  try {
    lstatSync(target);
    present = true;
  } catch {
    present = false;
  }
  if (present) {
    // …AND THE BYTES MUST REALLY BE UNDER THE ROOT. A symbolic link is the
    // ordinary way a fleet shares one skill library, so the name resolving
    // elsewhere is expected and is not an error — it is a place this registry
    // has no standing to answer about, so it answers about nothing at all
    // rather than reporting somebody else's file as its own.
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return null; // a dangling link: something is there and it is not a file
    }
    if (!within(realRoot, real)) return null;
    if (!lstatSync(real).isFile()) return null;
  }
  // THE WALK HAPPENED, so the answer is a list — empty when the copy this
  // registry wrote is no longer there. An empty list is what makes an honest
  // `no` possible; `null` above is what keeps "nothing was looked at" from
  // being read as one.
  //
  // AND THE LIST HOLDS DIGESTS, not paths, because the registry's own evidence
  // obeys the grammar the registry imposes on everybody else's. A path is a
  // string an author wrote; `evidenceDigestOf` is the same function the check
  // compares against, so there is one form of this value and not two.
  return registryObserved({ artifacts: present ? [evidenceDigestOf(check.artifact_path)] : [] });
}

/** What became of a managed copy at one step. Four values, and never blank. */
export type ManagedCopy = "written" | "removed" | "absent" | "retained";

/**
 * Remove the managed copy, and report which of three things happened.
 *
 * `retained` is the honest answer the specification asks for and the one that is
 * easy to get wrong: a step that could not remove the copy must not report
 * `removed`, and a caller must be able to tell "there was nothing there" from
 * "it is still there". Nothing here reports anything about the AGENT — see
 * `INSTRUCTIONS_ALREADY_READ`.
 */
export function removeManaged(site: ActivationSite, name: string): ManagedCopy {
  let realRoot: string;
  try {
    realRoot = resolveRoot(site.root);
  } catch {
    return "retained";
  }
  const dir = resolve(realRoot, nativeDirectory(site.target, name));
  if (!within(realRoot, dir)) return "retained";
  // lstat, not exists: a dangling link at that name is something that IS there
  try {
    lstatSync(dir);
  } catch {
    return "absent";
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return "retained";
  }
  return existsSync(dir) ? "retained" : "removed";
}

// ---------------------------------------------------------------- counting

/**
 * How many skill entry files are reachable under a root — FOLLOWING SYMBOLIC
 * LINKS.
 *
 * It counts what is THERE, not what this registry put there, and it says so in
 * its name and in every answer built from it. Following links is not a detail:
 * handing a fleet one shared skill library by linking `<root>/.claude/skills` at
 * it is the ordinary arrangement, and a walk that stopped at the link would
 * report a systematically low number with no sign that it had.
 *
 * Cycles are broken on the RESOLVED path, so a link that points at an ancestor
 * terminates the walk instead of the process.
 */
export function skillFilesUnder(root: string): number {
  let realRoot: string;
  try {
    realRoot = resolveRoot(root);
  } catch {
    throw new ActivationError("root_missing", "the configured activation root cannot be read");
  }
  const seen = new Set<string>();
  let found = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 32) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: Array<{ name: string }>;
    try {
      entries = readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(real, entry.name);
      // `withFileTypes` reports a link as a link; the whole point is to look
      // THROUGH it, so the kind is taken from the resolved path instead
      let isDir = false;
      try {
        isDir = lstatSync(realpathSync(child)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(child, depth + 1);
      else if (entry.name === NATIVE_ENTRY) found += 1;
    }
  };
  walk(realRoot, 0);
  return found;
}

// ------------------------------------------- what removal does NOT do [B-12]

/**
 * The sentence every answer about withdrawing a deployment carries.
 *
 * It is a constant because it is a claim about the world that must not be
 * re-worded per surface, and because the guard below is applied to it: the one
 * statement this system is not allowed to make is that taking a file away makes
 * an agent forget what it has already read. It cannot. An agent that has loaded
 * a skill has the instructions in its context, and no file operation reaches
 * into that.
 */
export const INSTRUCTIONS_ALREADY_READ =
  "Removing the managed copy takes away the file a runtime loads. It does not reach into a session that has " +
  "already loaded this skill: an agent holding those instructions keeps them for the rest of that session, and " +
  "a NEW SESSION IS REQUIRED before the withdrawal has any effect on what the agent is working from.";

/** What an activation says about a session that has not loaded the skill yet. */
export const ACTIVATION_SESSION_EFFECT =
  "A session started after this activation loads the managed copy. A session already running does not pick it " +
  "up until it is restarted.";

/**
 * Claims about withdrawal that this system may not make, as patterns.
 *
 * The guard is applied to the shipped text — every answer, every tool
 * description — and a test feeds it a doctored answer to prove it bites. It is
 * a word filter and therefore crude, so it is DELIBERATELY negation-aware: the
 * true sentence and the false one are built from the same words and differ only
 * in the "not", and a guard that failed the honest wording would be worked
 * around rather than obeyed.
 */
const ERASURE_CLAIMS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "unread", re: /\bunread\b/i },
  { id: "forget", re: /\bforget(s|ting)?\b|\bforgotten\b/i },
  { id: "erases_what_was_read", re: /\b(eras\w*|delet\w*|wipe\w*|clear\w*)\b[^.]{0,80}\b(instruction|prompt|context|memory|memories)/i },
  { id: "no_longer_knows", re: /\bno longer\b[^.]{0,40}\b(knows?|remembers?|has read|follows?)\b/i },
  { id: "stops_using_at_once", re: /\b(immediately|at once|instantly)\b[^.]{0,60}\bstops?\b/i },
  { id: "loses_access_to_instructions", re: /\bloses?\b[^.]{0,40}\b(access to )?(the )?(instruction|skill|prompt)/i },
];

/**
 * Words that turn a forbidden claim into an honest denial of it.
 *
 * A bare `no` is NOT among them, and that omission is load-bearing: "the agent
 * no longer knows the procedure" is the claim this guard exists to catch, and a
 * negation list containing `no` would read its own subject as a denial and let
 * it through.
 */
const NEGATIONS = /\b(?:not|never|cannot|can't|without|nothing)\b/i;

/**
 * The id of the first forbidden claim `text` makes, or null.
 *
 * A match whose immediate context carries a negation is NOT a claim: "revoking
 * does not erase what the agent has already read" is the sentence this guard
 * exists to protect, not one it exists to catch.
 */
export function erasureClaim(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const { id, re } of ERASURE_CLAIMS) {
    const m = re.exec(text);
    if (!m) continue;
    const from = Math.max(0, (m.index ?? 0) - 60);
    if (NEGATIONS.test(text.slice(from, (m.index ?? 0) + m[0].length))) continue;
    return id;
  }
  return null;
}
