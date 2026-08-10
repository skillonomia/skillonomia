// §6 PART A — THE ADAPTER HALF: the only place in this work that opens a file.
//
// [M-7] SPLITS THIS WORK IN TWO, and this file is the far side of the split.
// `src/fleet.ts` holds the assessment: the §4 matrix, the arrival scanner, the
// dead-weight slice. It receives RECORDS and imports neither `node:fs` nor
// `node:path`, so it works unchanged in V-2, where the records arrive as a
// self-report from an agent outside this perimeter and there is no filesystem
// of the addressee to reach at all.
//
// Everything that needs a disk is here. Two adapters, both against ROOTS THAT
// ARE PARAMETERS — the same rule D-7 fixed for activation, for the same reason:
//
//     nothing in this file names a real runtime directory, expands `~`, reads
//     HOME, or has a default root. An inventory with no configured root
//     inventories nothing and SAYS SO — `unknown`, never zero.
//
// Pointing this at a fleet's real directories is an act on somebody else's
// machine, authorized separately from the code that knows how. Keeping the root
// a parameter is what lets that second decision be made later, by a person,
// without this file changing — and a test greps this file for a home directory,
// a `~` path and an absolute user path, exactly as one greps `src/activation.ts`.
//
// [I-4] IS THE OTHER RULE HERE, and it is not a detail. Handing a fleet one
// shared skill library by symlinking a directory at it is the ORDINARY
// arrangement. A walk that stops at the link reports a systematically low
// number with nothing to show that it did — an undercount that looks exactly
// like a small installation. So every walk below follows links, breaks cycles
// on the RESOLVED path, and bounds its depth.
//
// [I-7]: a record's TEXT never leaves this file. What crosses back into the
// logic is the set of §5 markers a record contained, and nothing else. A
// transcript line is arbitrary content — a key, a customer, an operator's home
// directory — and none of it is needed to answer whether a version ran.
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { markerInSkillMd, markersIn } from "./marker.ts";
import {
  CAPABILITY_KINDS,
  NO_SNAPSHOT_WINDOW,
  isFleetRuntime,
  type CapabilityKind,
  type FleetObservationSource,
  type FleetRuntime,
  type ObservedRecord,
  type RegisteredCapability,
  type RuntimeSnapshot,
  type SelectionWindow,
  type Trivalent,
} from "./fleet.ts";
import type { RuntimeRecordSource, RuntimeRecordWindow } from "./assignments.ts";

// ---------------------------------------------------------------- the roots

/** One configured place an agent's capabilities may be READ from. */
export interface InventorySite {
  /** an absolute directory. There is no default and none is derived */
  root: string;
  runtime: FleetRuntime;
}

/**
 * Where, if anywhere, one agent's capabilities are inventoried.
 *
 * ONE interface, so "a temporary directory in a test" and "a fleet member's
 * real home" are the same shape and the second needs no new code. `null` is not
 * an error: it is an agent this deployment has not been pointed at, and every
 * number about it is `unknown` with a window saying nothing was walked.
 */
export interface InventoryRoots {
  rootFor(agentId: string): InventorySite | null;
}

/** The shipped default: nothing configured, so nothing is read. */
export const NO_INVENTORY_ROOTS: InventoryRoots = { rootFor: () => null };

/** One root and one runtime for every agent — the simplest real configuration. */
export class FixedInventoryRoots implements InventoryRoots {
  private readonly site: InventorySite;
  constructor(root: string, runtime: FleetRuntime) {
    if (!isAbsolute(root)) throw new Error("an inventory root must be an absolute path");
    if (!isFleetRuntime(runtime)) throw new Error(`unknown fleet runtime ${String(runtime)}`);
    this.site = { root, runtime };
  }
  rootFor(): InventorySite {
    return this.site;
  }
}

/** Per-agent roots, for a fleet whose members do not share one. */
export class PerAgentInventoryRoots implements InventoryRoots {
  private readonly sites: Map<string, InventorySite>;
  constructor(sites: Record<string, InventorySite>) {
    this.sites = new Map(Object.entries(sites));
  }
  rootFor(agentId: string): InventorySite | null {
    return this.sites.get(agentId) ?? null;
  }
}

// ------------------------------------------------------------- the layouts

/**
 * WHERE EACH RUNTIME KEEPS EACH KIND, RELATIVE TO A ROOT.
 *
 * A standing cost, written in one table for the reason `src/activation.ts`
 * gives about its own: each row is a promise about somebody else's layout,
 * decided by another project on its own schedule. A runtime that moves its
 * directory does not break the interface above it — it breaks a row here,
 * silently, and every count afterwards is taken in a place nothing lives.
 *
 * A kind ABSENT from a runtime's row is not a count of zero. It is a kind this
 * adapter cannot see from a disk, and it is reported `unknown` with a reason.
 */
const INVENTORY_DIRS: Readonly<Record<FleetRuntime, Readonly<Partial<Record<CapabilityKind, string>>>>> = {
  claude_code: { skill: ".claude/skills", plugin: ".claude/plugins" },
  codex: { skill: ".agents/skills" },
};

/** Files a runtime declares its MCP servers in, relative to a root. */
const MCP_CONFIG_FILES: Readonly<Record<FleetRuntime, readonly string[]>> = {
  claude_code: [".mcp.json", ".claude/settings.json"],
  // Codex declares its servers in a TOML file this adapter does not parse:
  // guessing at a format is how a count becomes wrong without becoming absent.
  codex: [],
};

/** The file a skill directory is recognised by — the runtime's own entry file. */
const ENTRY = "SKILL.md";

/** Why a kind has no filesystem answer. Codes, so a surface can branch on them. */
export type UndiscoverableReason =
  | "no_inventory_root_configured"
  | "inventory_root_unreadable"
  | "not_discoverable_from_a_filesystem"
  | "requires_a_live_connection"
  | "not_a_concept_of_this_runtime";

/** How deep a walk goes before it stops. A link farm is not a reason to hang. */
const MAX_DEPTH = 32;

function resolveRoot(root: string): string {
  if (!isAbsolute(root)) throw new InventoryError("root_not_absolute");
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new InventoryError("root_missing");
  }
  if (!lstatSync(real).isDirectory()) throw new InventoryError("root_not_a_directory");
  return real;
}

/**
 * A failure of the adapter, with a CODE and no path in it [I-7].
 *
 * A filesystem error message names absolute paths, and those are the operator's
 * business rather than something an API publishes. `src/activation.ts` answers
 * in reason codes for the same reason; this follows it.
 */
export class InventoryError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

// ------------------------------------------------------------- the walking

/**
 * Every directory under `dir` that IS a capability of `kind`, links FOLLOWED.
 *
 * `withFileTypes` reports a symbolic link as a link, and looking THROUGH it is
 * the entire point, so the kind is taken from the resolved path. Cycles are
 * broken on the resolved path too, so a link pointing at an ancestor ends the
 * walk instead of the process.
 */
function walkNames(realDir: string, wantEntry: boolean): Array<{ name: string; dir: string }> {
  const seen = new Set<string>();
  const found: Array<{ name: string; dir: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
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
      let childReal: string;
      let isDir = false;
      try {
        // [I-4]: the kind is taken from the RESOLVED path, so a link to a
        // shared library is entered rather than skipped
        childReal = realpathSync(child);
        isDir = lstatSync(childReal).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (!wantEntry) {
        found.push({ name: entry.name, dir: childReal });
        continue;
      }
      let hasEntry = false;
      try {
        hasEntry = lstatSync(realpathSync(join(childReal, ENTRY))).isFile();
      } catch {
        hasEntry = false;
      }
      if (hasEntry) found.push({ name: entry.name, dir: childReal });
      else walk(childReal, depth + 1);
    }
  };
  walk(realDir, 0);
  return found;
}

/** The §5 marker a materialized copy carries in its own `SKILL.md`, or null. */
function markerOfCopy(dir: string): string | null {
  try {
    return markerInSkillMd(readFileSync(join(dir, ENTRY), "utf8"));
  } catch {
    return null;
  }
}

/** The MCP server names one runtime DECLARES under this root. */
function mcpServerNames(realRoot: string, runtime: FleetRuntime): string[] {
  const names = new Set<string>();
  for (const rel of MCP_CONFIG_FILES[runtime]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(realRoot, rel), "utf8"));
    } catch {
      continue;
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const name of Object.keys(servers as Record<string, unknown>)) names.add(name);
  }
  return [...names].sort();
}

/** Why each kind has no filesystem answer. A kind that WAS walked is absent. */
export type UndiscoverableKinds = Partial<Record<CapabilityKind, UndiscoverableReason>>;

export interface InventoryResult {
  items: RegisteredCapability[];
  /** why a kind produced nothing, per kind. Absent for a kind that was walked. */
  undiscoverable: UndiscoverableKinds;
  /** the boundary, in words, for every number built from this */
  window_detail: string;
}

/**
 * WHAT IS ACTUALLY UNDER ONE AGENT'S ROOT — the [A-2] inventory.
 *
 * Every kind is answered: the ones this adapter can see are enumerated, and the
 * ones it cannot are named with the reason it cannot. That distinction is the
 * whole of [I-1] at this layer — `mcp_tool` is not `0`, it is `unknown`,
 * because tools are what a server offers when something connects to it and no
 * directory listing establishes their absence.
 */
export function inventoryUnder(site: InventorySite, agentId: string): InventoryResult {
  const realRoot = resolveRoot(site.root);
  const items: RegisteredCapability[] = [];
  const undiscoverable: Partial<Record<CapabilityKind, UndiscoverableReason>> = {};
  const dirs = INVENTORY_DIRS[site.runtime];

  for (const kind of CAPABILITY_KINDS) {
    if (kind === "mcp_tool") {
      undiscoverable.mcp_tool = "requires_a_live_connection";
      continue;
    }
    if (kind === "connector") {
      undiscoverable.connector = "not_discoverable_from_a_filesystem";
      continue;
    }
    if (kind === "mcp_server") {
      if (MCP_CONFIG_FILES[site.runtime].length === 0) {
        undiscoverable.mcp_server = "not_discoverable_from_a_filesystem";
        continue;
      }
      for (const name of mcpServerNames(realRoot, site.runtime)) {
        items.push({ agent_id: agentId, runtime: site.runtime, kind, name, skill_version_id: null, marker: null });
      }
      continue;
    }
    const rel = dirs[kind];
    if (rel === undefined) {
      undiscoverable[kind] = "not_a_concept_of_this_runtime";
      continue;
    }
    let base: string;
    try {
      base = realpathSync(join(realRoot, rel));
    } catch {
      // the directory is simply not there. That IS an answer — nothing is
      // registered under a layout this runtime does have — and it is not the
      // same as a kind the adapter cannot see, so no `undiscoverable` entry.
      continue;
    }
    for (const { name, dir } of walkNames(base, kind === "skill")) {
      items.push({
        agent_id: agentId,
        runtime: site.runtime,
        kind,
        name,
        skill_version_id: null,
        marker: kind === "skill" ? markerOfCopy(dir) : null,
      });
    }
  }
  items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return {
    items,
    undiscoverable,
    window_detail: `one configured inventory root for the \`${site.runtime}\` layout, all depths, symbolic links followed [I-4]`,
  };
}

// -------------------------------------------------------- transcript records

/** One configured place an agent's runtime records may be READ from. */
export interface TranscriptSite {
  root: string;
  runtime: FleetRuntime;
  window: SelectionWindow;
  /** the boundary in words — an operator's own description of what is there */
  window_detail: string;
}

export interface TranscriptRoots {
  rootFor(agentId: string): TranscriptSite | null;
}

export const NO_TRANSCRIPT_ROOTS: TranscriptRoots = { rootFor: () => null };

export class FixedTranscriptRoots implements TranscriptRoots {
  private readonly site: TranscriptSite;
  constructor(site: TranscriptSite) {
    if (!isAbsolute(site.root)) throw new Error("a transcript root must be an absolute path");
    if (!isFleetRuntime(site.runtime)) throw new Error(`unknown fleet runtime ${String(site.runtime)}`);
    this.site = site;
  }
  rootFor(): TranscriptSite {
    return this.site;
  }
}

/**
 * ONE TRANSCRIPT LINE, as this adapter is willing to read it.
 *
 * A deliberately small vocabulary, and every field optional: a reader that
 * demanded a shape would fail closed on the next version of a format it does
 * not own. What it needs is a role, an id that binds a call to its output, and
 * the text — and of the text it keeps only the markers.
 */
interface TranscriptLine {
  type?: unknown;
  role?: unknown;
  call_id?: unknown;
  at_ms?: unknown;
  text?: unknown;
  result?: unknown;
}

/** The record roles, recognised from the two runtimes' own event names. */
function roleOf(line: TranscriptLine): ObservedRecord["role"] | null {
  const raw = typeof line.type === "string" ? line.type : typeof line.role === "string" ? line.role : null;
  if (raw === null) return null;
  // Claude Code: a `tool_use` with `name=Skill` and its result. Codex: paired
  // `custom_tool_call` / `custom_tool_call_output` sharing one `call_id`.
  if (raw === "call" || raw === "tool_use" || raw === "custom_tool_call") return "call";
  if (raw === "output" || raw === "tool_result" || raw === "custom_tool_call_output") return "output";
  if (raw === "proposal" || raw === "skill_available") return "proposal";
  return null;
}

/**
 * The records under one transcript root, REDUCED TO MARKERS at the boundary.
 *
 * The text of a line does not survive this function. Everything §6 asks of a
 * record — which version, called or returned, bound to which call, when — is
 * expressible in the fields below, and none of it needs the content [I-7].
 */
export function recordsUnder(site: TranscriptSite, agentId: string): ObservedRecord[] {
  let realRoot: string;
  try {
    realRoot = resolveRoot(site.root);
  } catch {
    throw new InventoryError("transcript_root_unreadable");
  }
  const out: ObservedRecord[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
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
      let childReal: string;
      let isDir: boolean;
      try {
        childReal = realpathSync(child);
        isDir = lstatSync(childReal).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(childReal, depth + 1);
        continue;
      }
      if (!/\.jsonl?$/.test(entry.name)) continue;
      let text: string;
      try {
        text = readFileSync(childReal, "utf8");
      } catch {
        continue;
      }
      for (const raw of text.split("\n")) {
        if (raw.trim().length === 0) continue;
        let line: TranscriptLine;
        try {
          line = JSON.parse(raw) as TranscriptLine;
        } catch {
          continue;
        }
        const role = roleOf(line);
        if (role === null) continue;
        const markers = markersIn(typeof line.text === "string" ? line.text : "");
        if (markers.length === 0) continue;
        const result =
          line.result === "success" || line.result === "failure" ? (line.result as "success" | "failure") : "unknown";
        for (const marker of markers) {
          out.push({
            agent_id: agentId,
            runtime: site.runtime,
            role,
            call_id: typeof line.call_id === "string" && line.call_id.length > 0 ? line.call_id : null,
            at_ms: Number.isInteger(line.at_ms) ? (line.at_ms as number) : null,
            marker,
            result,
          });
        }
      }
    }
  };
  walk(realRoot, 0);
  return out;
}

/**
 * THE V-1 SCANNER, PLUGGED INTO BOTH SEAMS AT ONCE.
 *
 * It implements §5.5's `RuntimeRecordSource` — the seam work 5 left for exactly
 * this — and §6's `FleetObservationSource`, from one read. That it can satisfy
 * both without either interface changing is the evidence that the seam was the
 * right shape: neither consumer learns that a filesystem exists.
 *
 * In V-2 this class is replaced by one that receives a self-report over the
 * wire. Nothing above it changes, because nothing above it takes a path.
 */
export class TranscriptObservations implements FleetObservationSource, RuntimeRecordSource {
  private readonly roots: TranscriptRoots;
  constructor(roots: TranscriptRoots) {
    this.roots = roots;
  }

  snapshotFor(agentId: string): RuntimeSnapshot | null {
    const site = this.roots.rootFor(agentId);
    if (!site) return null;
    let records: ObservedRecord[];
    try {
      records = recordsUnder(site, agentId);
    } catch {
      return null;
    }
    const last = records.reduce<number | null>((n, r) => (r.at_ms !== null && (n === null || r.at_ms > n) ? r.at_ms : n), null);
    return {
      agent_id: agentId,
      runtime: site.runtime,
      // a transcript on a disk says nothing about the model, the session or an
      // inventory of what was offered: all three stay unknown rather than
      // becoming defaults
      model: null,
      session_active: "unknown" as Trivalent,
      last_activity_ms: last,
      window: site.window,
      window_detail: site.window_detail,
      proposal_inventory_complete: false,
      records,
    };
  }

  recordsFor(agentId: string): RuntimeRecordWindow | null {
    const snapshot = this.snapshotFor(agentId);
    if (!snapshot) return null;
    return {
      records: snapshot.records
        .filter((r) => r.role === "call" || r.role === "output")
        .map((r) => ({ role: r.role as "call" | "output", text: r.marker })),
      window: snapshot.window_detail,
    };
  }
}

/** The phrase every answer uses when no root was configured at all. */
export const NO_INVENTORY_WINDOW =
  "no inventory root is configured for this agent: no directory was walked";

export { NO_SNAPSHOT_WINDOW };
