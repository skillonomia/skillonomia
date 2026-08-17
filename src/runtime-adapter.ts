// V1 P4 — THE TWO THIN ADAPTERS.
//
// One canonical model, two native mechanisms (`P4-FR-05`, `P4-FR-06`). What is
// here is a TABLE with two rows and a renderer; what is deliberately NOT here is
// a plugin architecture, a manifest format or a second registry (contract
// section 8.10, and P4's own OUT list).
//
// An adapter does four things and nothing else:
//
//   1. it knows WHERE its runtime looks for a skill (`RUNTIMES` below);
//   2. it renders one canonical revision into that runtime's entry file;
//   3. it writes the file through the hardened path of `src/activation.ts` and
//      reads it back from the location the runtime will open;
//   4. it lifts the runtime's own receipt line out of the runtime's own output.
//
// It stores nothing. Everything it wrote can be rebuilt from the Registry rows,
// and deleting all of it destroys no canonical data (`P4-FR-08`).
//
// THE OWNER TOUCHES NONE OF THIS (`P4-FR-07`, `INV-09`). There is no manifest to
// write, no archive to pack, no signature to make and no runtime config to edit:
// the adapter sets the runtime's own home environment variable at launch to the
// session-scoped directory it just materialized into.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  materialize,
  readBack,
  nativeRelativePath,
  resolveRoot,
  ActivationError,
  type ActivationSite,
  type ActivationTarget,
} from "./activation.ts";
import type { DraftContent } from "./draft.ts";
import { receiptMarkerLine, type LoadoutEntryView, type RuntimeKind } from "./session-loadout.ts";

// ------------------------------------------------------------- the two rows

/**
 * One runtime: the activation target whose directory layout it uses, the
 * subdirectory of a session root that IS its home, and the environment variable
 * that points it there.
 *
 * WHY THE LAYOUT ROWS ARE REUSED RATHER THAN RESTATED. `src/activation.ts`
 * already carries a `TARGET_DIR` table that maps a target to the directory a
 * skill occupies under a root, and it already carries the traversal, symlink and
 * containment checks that make writing there safe. Restating either would give
 * this system two places where a runtime's layout is written down, and the
 * second one would be the one that goes stale.
 *
 * WHAT THE ROWS MEAN CONCRETELY, with a session root of `<base>/<session_id>`:
 *
 *   codex        home `<root>/.agents`, entry `<root>/.agents/skills/<name>/SKILL.md`
 *                launched with `CODEX_HOME=<root>/.agents`, so the entry is at
 *                `<CODEX_HOME>/skills/<name>/SKILL.md` — codex's own layout.
 *   claude_code  home `<root>/.claude`, entry `<root>/.claude/skills/<name>/SKILL.md`
 *                launched with `CLAUDE_CONFIG_DIR=<root>/.claude`, so the entry
 *                is at `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md`.
 *
 * The home directory NAME is the adapter's choice and nothing else's; the path
 * BELOW it is the runtime's rule, and that is the part this table promises.
 */
export interface RuntimeAdapter {
  kind: RuntimeKind;
  /** the `src/activation.ts` target whose layout this runtime uses */
  target: ActivationTarget;
  /** the subdirectory of a session root that becomes the runtime's home */
  home_subdir: string;
  /** the environment variable that points the runtime at that home */
  home_env: string;
  /** the executable, for the record a receipt carries */
  binary: string;
}

export const RUNTIMES: Readonly<Record<RuntimeKind, RuntimeAdapter>> = {
  codex: {
    kind: "codex",
    target: "codex",
    home_subdir: ".agents",
    home_env: "CODEX_HOME",
    binary: "codex",
  },
  claude_code: {
    kind: "claude_code",
    target: "claude_code_personal",
    home_subdir: ".claude",
    home_env: "CLAUDE_CONFIG_DIR",
    binary: "claude",
  },
};

// ------------------------------------------------------------- the renderer

/**
 * `P4-FR-15` — NO RAW SENSITIVE VALUE REACHES A NATIVE ARTIFACT OR A RUNTIME LOG.
 *
 * The canonical content is already redacted at capture (P1, `src/redaction.ts`),
 * and this is the SECOND check rather than the first: the artifact that is about
 * to be written into somebody's runtime home is scanned again, on its final
 * bytes, and a hit REFUSES the materialization rather than writing the file and
 * reporting a warning. The direction of failure matters more than the breadth of
 * the pattern list: a credential that reaches a runtime home cannot be unsent.
 *
 * The patterns are the ones this system mints plus the shapes people paste,
 * which is the same list `v1/tools/p0-secret-scan.sh` sweeps evidence with.
 */
const SECRET_SHAPES: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: "registry_api_key", re: /sk_[A-Za-z0-9_-]{16,}/ },
  { code: "bootstrap_token", re: /bt_[A-Za-z0-9_-]{16,}/ },
  { code: "openai_key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { code: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { code: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { code: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { code: "slack_token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { code: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "bearer_header", re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i },
];

/** The code of the first credential shape in this text, or null. The VALUE is
 *  never returned, logged or put in an error message. */
export function credentialShapeIn(text: string): string | null {
  for (const { code, re } of SECRET_SHAPES) {
    if (re.test(text)) return code;
  }
  return null;
}

/**
 * The canonical revision, as the entry file the runtime opens.
 *
 * BOTH RUNTIMES READ THE SAME SHAPE — YAML frontmatter with `name` and
 * `description`, then markdown — which is why one renderer serves two adapters
 * and why `INV-01` holds: there is one canonical model and two projections of
 * it, not two models.
 *
 * THE RECEIPT BLOCK IS THE PART `P4-FR-19` NEEDS. The file states its own
 * revision id and content digest and instructs the runtime to echo that line
 * when it uses the skill. What comes back is therefore evidence about WHICH
 * BYTES were read, and not about which name was matched.
 */
export function renderSkillMd(entry: LoadoutEntryView, content: DraftContent): string {
  const description = firstLine(content.purpose) || firstLine(content.when_to_use) || content.title;
  const lines: string[] = [
    "---",
    `name: ${entry.skill_name}`,
    `description: ${yamlScalar(description)}`,
    "---",
    "",
    `# ${content.title}`,
    "",
    "## Canonical revision receipt",
    "",
    "This skill was materialized from a Skillonomia registry assignment. When you use it,",
    "report the following line VERBATIM, on a line of its own, before anything else:",
    "",
    "```",
    receiptMarkerLine(entry.draft_revision_id, entry.content_digest),
    "```",
    "",
    "## Purpose",
    "",
    content.purpose,
    "",
    "## When to use",
    "",
    content.when_to_use,
    "",
    "## Procedure",
    "",
    ...content.procedure.map((s, i) => `${i + 1}. ${s}`),
  ];
  const section = (heading: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push("", `## ${heading}`, "", ...items.map((i) => `- ${i}`));
  };
  section("Inputs", content.inputs);
  section("Outputs", content.outputs);
  section("Permissions", content.permissions);
  section("Dependencies", content.dependencies);
  section("Failure modes", content.failure_modes);
  lines.push("");
  return lines.join("\n");
}

function firstLine(text: string): string {
  return (text ?? "").split("\n")[0]?.trim() ?? "";
}

/** A YAML scalar that cannot break out of its line. Newlines are impossible in
 *  a compiled description, and the quoting is here anyway for the same reason
 *  the name is re-checked in `src/activation.ts`. */
function yamlScalar(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ,.'()/-]*$/.test(flat) ? flat : JSON.stringify(flat);
}

// -------------------------------------------------------- materializing

export interface SessionHome {
  /** `<base>/<session_id>` — the session's own root, created here */
  root: string;
  /** the directory the runtime's home environment variable is set to */
  home: string;
  site: ActivationSite;
  adapter: RuntimeAdapter;
}

/**
 * Create the session-scoped runtime home. NOTHING outside `<base>/<session_id>`
 * is created or touched, and the base must already exist — this code does not
 * decide where a deployment materializes, exactly as `resolveRoot` does not.
 */
export function sessionHome(base: string, sessionId: string, kind: RuntimeKind): SessionHome {
  if (!isAbsolute(base)) throw new ActivationError("root_not_absolute", "a materialization base must be an absolute path");
  if (!/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(sessionId)) {
    throw new ActivationError("bad_session_id", "a session id is a 26-character ULID");
  }
  const adapter = RUNTIMES[kind];
  const root = join(resolveRoot(base), sessionId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = join(root, adapter.home_subdir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { root, home, site: { root, target: adapter.target }, adapter };
}

export interface MaterializedEntry {
  entry_id: string;
  skill_name: string;
  draft_revision_id: string;
  content_digest: string;
  /** relative to the session root — an absolute path is the operator's business */
  relpath: string;
  /** the sha256 of the bytes READ BACK from the native location */
  artifact_digest: string;
}

/**
 * Write one entry into the runtime's native location and read it back.
 *
 * `P4-FR-14` is met by `src/activation.ts`: `nativeDirectory` re-checks the
 * name, `checkPackagePath` refuses a traversing or absolute component,
 * `mkdirWithinRoot` refuses a component that resolves outside the root — which
 * is what a planted symbolic link does — and `materialize` unlinks an existing
 * entry before writing, because `writeFile` on a symbolic link writes through it.
 *
 * `P4-FR-15` is met immediately above the write: the rendered bytes are scanned
 * and a credential shape refuses the materialization.
 *
 * The read-back is what makes `loaded` mean anything later: the adapter reports
 * a load only after the bytes came back OUT of the place the runtime will open.
 */
export function materializeEntry(
  home: SessionHome,
  entry: LoadoutEntryView,
  content: DraftContent,
): MaterializedEntry {
  const text = renderSkillMd(entry, content);
  const shape = credentialShapeIn(text);
  if (shape !== null) {
    throw new ActivationError(
      "credential_in_artifact",
      `a rendered native artifact carries a value shaped like a credential (${shape}); it was not written`,
    );
  }
  const files = new Map<string, Buffer>([["SKILL.md", Buffer.from(text, "utf8")]]);
  materialize(home.site, entry.skill_name, files);
  const back = readBack(home.site, entry.skill_name);
  if (back === null) {
    throw new ActivationError("read_back_failed", "the native entry file could not be read back from its location");
  }
  return {
    entry_id: entry.entry_id,
    skill_name: entry.skill_name,
    draft_revision_id: entry.draft_revision_id,
    content_digest: entry.content_digest,
    relpath: nativeRelativePath(home.site.target, entry.skill_name),
    artifact_digest: sha256Hex(back),
  };
}

function sha256Hex(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * `P4-FR-08` — the derived artifacts of one session, removed.
 *
 * It removes the SESSION DIRECTORY and nothing above it, and it removes no row
 * of the Registry: a deployment that deletes every materialized file keeps every
 * skill, revision, approval, assignment, loadout and receipt, and the next
 * session rebuilds the files from those rows.
 */
export function cleanupSession(base: string, sessionId: string): "removed" | "absent" {
  if (!isAbsolute(base)) throw new ActivationError("root_not_absolute", "a materialization base must be an absolute path");
  if (!/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(sessionId)) {
    throw new ActivationError("bad_session_id", "a session id is a 26-character ULID");
  }
  const root = join(resolveRoot(base), sessionId);
  if (!existsSync(root)) return "absent";
  rmSync(root, { recursive: true, force: true });
  return "removed";
}
