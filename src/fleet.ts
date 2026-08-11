// §6 PART A — PROOF OF ARRIVAL: the fleet inventory, the six states, and the
// scanner that is allowed to say `invoked`.
//
// WHAT THIS MODULE IS FOR. "I handed the skill over" is an INTENT. §6 exists so
// that a reader can also be told what was OBSERVED, and — far more often — that
// nothing was. Everything below is built around one shape:
//
//     three answers, and the third is not the second.
//
// `yes`, `no`, `unknown` [I-1]. A blank cell is forbidden, and `unknown` is
// never rendered as `no`, because the absence of a record is not the absence of
// a fact. Most of this file is the machinery that makes that distinction
// survive contact with a table.
//
// THERE IS NO SINGLE TABLE OF STATES. There is a MATRIX of state × runtime, and
// it is ASYMMETRIC — the two runtimes do not merely differ in how much they
// report, they differ in WHICH COLUMNS EXIST AT ALL:
//
//   * Claude Code can be asked what it was offered right now, so `proposed`
//     splits into `proposed_now` (a live session, trustworthy) and
//     `proposed_historical` (a stored transcript, and UNRELIABLE — the marker
//     survives in roughly one transcript in fifty).
//   * Codex has no such signal in either direction. `turn_context` carries no
//     skill inventory and there is no dedicated lifecycle event, so `proposed`
//     is ONE column and its value is `unknown` ALWAYS [A-0].
//   * `loaded` is not a column either runtime can honestly fill. A call implies
//     the instructions were read, but implication is not observation, and
//     nothing distinguishes "read the instructions" from "was offered them".
//     So `loaded` is never `yes` and never `no` on either runtime, and it is
//     never shown as an EXPLICIT `loaded` — `explicitLoadedClaim` is the guard
//     that keeps a later surface from inventing one.
//
// Implementing that as one table with per-runtime flags was the tempting shape
// and is the wrong one: a flag is something a reader skips, and the flag that
// gets skipped here is the one that turns "no" back into "unknown".
//
// [M-7] — THE PROJECT CONSTRAINT THAT DECIDES THIS MODULE'S IMPORTS. The
// scanner interface MUST NOT presuppose access to the ADDRESSEE'S filesystem.
// In V-1 the records are read locally; in V-2 the marker arrives as a
// self-report from an ambassador agent outside this perimeter, where there is
// no disk to open and no path to stat. So:
//
//     NOTHING IN THIS FILE IMPORTS `node:fs` OR `node:path`.
//
// The assessment logic receives RECORDS. Reading a filesystem lives in the
// ADAPTER (src/fleet-scan.ts) and nowhere else, and a test greps this file to
// keep it that way — the same discipline `src/marker.ts` already holds to.
import { evaluateOutcome, type OutcomeContract, type OutcomeVerdict } from "./outcome.ts";
export { evaluateOutcome, type OutcomeContract, type OutcomeVerdict };
import {
  MARKER_RE,
  assessArrival,
  matchArrivalPairs,
  type ArrivalRecord,
  type ArrivalSubject,
  type ArrivalUnknownReason,
} from "./marker.ts";

// =========================================================================
// The runtimes, and the six states
// =========================================================================

/** The runtimes §4's matrix has a column for. Closed. */
export const FLEET_RUNTIMES = ["claude_code", "codex"] as const;
export type FleetRuntime = (typeof FLEET_RUNTIMES)[number];

export function isFleetRuntime(v: unknown): v is FleetRuntime {
  return typeof v === "string" && (FLEET_RUNTIMES as readonly string[]).includes(v);
}

/** §4's six states, in the order a capability passes through them. */
export const CAPABILITY_STATES = [
  "registered",
  "assigned",
  "proposed",
  "loaded",
  "invoked",
  "outcome",
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/** [I-1]: three answers. `unknown` is a VALUE, never an absent field. */
export type Trivalent = "yes" | "no" | "unknown";

// =========================================================================
// [I-3] — a number, or a cell, carries THREE attributes or it is not published
// =========================================================================
//
// The two independent disagreements in the canonical note (385 against 386, 33
// against 79) had ONE cause: a number with no method. A count of skills is
// meaningless until a reader is told which STATE was counted, from which
// SOURCE, over which SELECTION BOUNDARY. So the three travel with the value, in
// the type, and `attributed` refuses to build one that is missing any of them.

/** Where an answer was read. Four places, and they are not interchangeable. */
export const EVIDENCE_SOURCES = ["filesystem", "registry", "runtime", "transcript"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** How much was looked at. */
export const SELECTION_WINDOWS = ["live_session", "period", "all_time"] as const;
export type SelectionWindow = (typeof SELECTION_WINDOWS)[number];

/** The three attributes, plus one publishable sentence naming the boundary. */
export interface Attribution {
  /** which of the six states this value is about */
  state: CapabilityState;
  source: EvidenceSource;
  window: SelectionWindow;
  /** the boundary in words, for a reader who has only this row */
  window_detail: string;
}

/**
 * The name of the FIRST attribute this object is missing, or null.
 *
 * Exported because it is applied twice: once here, where a value is built, and
 * once by the tests, which sweep a whole shipped answer and fail on any number
 * that lost one. A guard that only ran at construction would be satisfied by a
 * surface that assembled its own object literal.
 */
export function missingAttribute(v: unknown): string | null {
  const a = v as Partial<Attribution> | null | undefined;
  if (!a || typeof a !== "object") return "state";
  if (typeof a.state !== "string" || !(CAPABILITY_STATES as readonly string[]).includes(a.state)) return "state";
  if (typeof a.source !== "string" || !(EVIDENCE_SOURCES as readonly string[]).includes(a.source)) return "source";
  if (typeof a.window !== "string" || !(SELECTION_WINDOWS as readonly string[]).includes(a.window)) return "window";
  if (typeof a.window_detail !== "string" || a.window_detail.length === 0) return "window_detail";
  return null;
}

/** A number that carries its method. `value` is null EXACTLY when the
 *  measurement state is `unknown` — never a silent 0, because "nothing was
 *  looked at" and "nothing was found" are different facts. */
export interface MeasuredNumber extends Attribution {
  value: number | null;
  measurement_state: "counted" | "unknown";
  /** why it is unknown, or what qualifies the count; null when neither */
  reason: string | null;
}

/** Build a counted number, REFUSING one that lost an attribute [I-3]. */
export function countedNumber(value: number, a: Attribution, reason: string | null = null): MeasuredNumber {
  const missing = missingAttribute(a);
  if (missing !== null) {
    throw new Error(`a number is not published without its method: \`${missing}\` is missing [I-3]`);
  }
  if (!Number.isInteger(value) || value < 0) throw new Error("a count is a non-negative integer");
  return { value, measurement_state: "counted", reason, ...a };
}

/** Build the honest non-number: nothing was measured, and the reason says so. */
export function unknownNumber(a: Attribution, reason: string): MeasuredNumber {
  const missing = missingAttribute(a);
  if (missing !== null) {
    throw new Error(`a number is not published without its method: \`${missing}\` is missing [I-3]`);
  }
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("an unmeasured number states why it is unmeasured");
  }
  return { value: null, measurement_state: "unknown", reason, ...a };
}

// =========================================================================
// §4's MATRIX — state × runtime, and it is not a table with flags
// =========================================================================

/**
 * WHAT KIND OF ANSWER a (state, runtime) pair can ever produce.
 *
 * This is the vocabulary the asymmetry is written in. Two cells with the same
 * `Observability` behave identically; two with different ones do not, and no
 * amount of evidence moves a cell from one class to another.
 */
export type Observability =
  /** the runtime, or a disk, reports it; `yes` and `no` are both reachable */
  | "observable"
  /** Skillonomia's own decision. It is NEVER shown in the fact column [I-2] */
  | "intent_only"
  /** a live session can be asked, and answers truthfully */
  | "live_session_only"
  /** a stored transcript MAY carry it; absence proves nothing */
  | "historically_unreliable"
  /** the runtime emits no signal, in either direction, ever [A-0] */
  | "never_observable"
  /** an invocation implies it, and implication is not observation */
  | "not_separable_from_proposed"
  /** only a PAIRED call/output carrying this version's marker [M-5] */
  | "marker_pair_only"
  /** only against a declared evaluation contract; completion is not success */
  | "contract_only";

export interface MatrixCell {
  state: CapabilityState;
  runtime: FleetRuntime;
  observability: Observability;
  /** where such an answer would be read; `none` when there is nowhere */
  source: EvidenceSource | "none";
  /** whether `no` is EVER a legal value of this cell. `false` is the [A-0] rule
   *  stated as data: a cell that cannot say `no` says `unknown` instead. */
  can_be_no: boolean;
  /** whether this state is published as a column of its OWN, under its own
   *  name. `loaded` is false on both runtimes: it is reported, it is never
   *  claimed. */
  explicit: boolean;
  /** the sentence §4 gives for this cell */
  note: string;
}

function cell(
  state: CapabilityState,
  runtime: FleetRuntime,
  observability: Observability,
  source: EvidenceSource | "none",
  can_be_no: boolean,
  explicit: boolean,
  note: string,
): MatrixCell {
  return { state, runtime, observability, source, can_be_no, explicit, note };
}

/**
 * §4's TABLE, transcribed. Read it as two columns that happen to share a page,
 * not as one column with exceptions.
 *
 * The `proposed` and `loaded` rows are where the money is. `proposed` on Claude
 * Code is answerable NOW and unreliable in HISTORY; on Codex it is not
 * answerable at all, ever, and the entry says so in `can_be_no: false` and
 * `observability: "never_observable"` rather than in a comment. `loaded` is
 * `explicit: false` on BOTH, because the one thing observable about loading —
 * that a call happened — is already the `invoked` column, and printing it twice
 * under a second name would be one fact wearing two hats.
 */
export const STATE_MATRIX: Readonly<Record<CapabilityState, Readonly<Record<FleetRuntime, MatrixCell>>>> = {
  registered: {
    claude_code: cell(
      "registered", "claude_code", "observable", "filesystem", true, true,
      "the managed copy is under the configured root's `.claude/skills` or `.claude/plugins`; symbolic links are followed [I-4]",
    ),
    codex: cell(
      "registered", "codex", "observable", "filesystem", true, true,
      "the managed copy is under the configured root's `.agents/skills/<name>/SKILL.md`; symbolic links are followed [I-4]",
    ),
  },
  assigned: {
    claude_code: cell(
      "assigned", "claude_code", "intent_only", "registry", true, true,
      "Skillonomia's own decision, read from the INSERT-only assignment journal. It is an INTENT and is never published as a runtime fact [I-2]",
    ),
    codex: cell(
      "assigned", "codex", "intent_only", "registry", true, true,
      "Skillonomia's own decision, read from the INSERT-only assignment journal. It is an INTENT and is never published as a runtime fact [I-2]",
    ),
  },
  proposed: {
    claude_code: cell(
      "proposed", "claude_code", "live_session_only", "transcript", true, true,
      "a live session can be asked what it was offered (`available for use with the Skill tool`), and answers completely; a STORED transcript carries the same signal in roughly one case in fifty, so its silence establishes nothing",
    ),
    codex: cell(
      "proposed", "codex", "never_observable", "none", false, true,
      "`turn_context` carries no skill inventory and there is no dedicated lifecycle event: NOTHING is reported in either direction, so this cell is `unknown` always and never `no` [A-0]",
    ),
  },
  loaded: {
    claude_code: cell(
      "loaded", "claude_code", "not_separable_from_proposed", "none", false, false,
      "an invocation strongly implies the instructions were read, and implication is not observation: nothing separates `loaded` from `proposed` reliably, so it is NOT shown as an explicit `loaded`",
    ),
    codex: cell(
      "loaded", "codex", "never_observable", "none", false, false,
      "not observable at all: the runtime reports no skill lifecycle, so there is nothing to separate from anything [A-0]",
    ),
  },
  invoked: {
    claude_code: cell(
      "invoked", "claude_code", "marker_pair_only", "transcript", false, true,
      "a `tool_use` with `name=Skill`, matched to its result — counted only on a PAIRED call/output record carrying this version's marker [M-5]",
    ),
    codex: cell(
      "invoked", "codex", "marker_pair_only", "transcript", false, true,
      "paired `custom_tool_call` / `custom_tool_call_output` sharing one `call_id`, both carrying this version's §5 marker [M-5]; without the pair the answer is `unknown`, never `no`",
    ),
  },
  outcome: {
    claude_code: cell(
      "outcome", "claude_code", "contract_only", "transcript", true, true,
      "only against the version's declared evaluation contract. Finishing the task is finishing the EXECUTION and is not success [M-6]",
    ),
    codex: cell(
      "outcome", "codex", "contract_only", "transcript", true, true,
      "only against the version's declared evaluation contract. Finishing the task is finishing the EXECUTION and is not success [M-6]",
    ),
  },
};

export function isSelectionWindow(v: unknown): v is SelectionWindow {
  return typeof v === "string" && (SELECTION_WINDOWS as readonly string[]).includes(v);
}

/** The matrix, flattened for publication — every cell, both runtimes, in §4's
 *  order. It travels WITH the answer: a reader holding one response can see
 *  that Codex's `proposed` is `unknown` by construction, not by accident. */
export function fleetMatrixRows(): MatrixCell[] {
  const out: MatrixCell[] = [];
  for (const state of CAPABILITY_STATES) for (const runtime of FLEET_RUNTIMES) out.push(matrixCell(state, runtime));
  return out;
}

export function matrixCell(state: CapabilityState, runtime: FleetRuntime): MatrixCell {
  const row = STATE_MATRIX[state];
  if (!row) throw new Error(`unknown capability state ${String(state)}`);
  const c = row[runtime];
  if (!c) throw new Error(`unknown runtime ${String(runtime)}`);
  return c;
}

/**
 * The COLUMN NAMES one runtime publishes, in order.
 *
 * This is where the asymmetry stops being an annotation and becomes structure:
 * the two runtimes return DIFFERENT LISTS. Claude Code splits `proposed` into
 * the two answers it can actually give; Codex has one `proposed` column whose
 * only value is `unknown`. A caller cannot accidentally render them as one
 * table with a flag, because they are not the same table.
 */
export type ColumnName =
  | "registered"
  | "assigned"
  | "proposed"
  | "proposed_now"
  | "proposed_historical"
  | "loaded"
  | "invoked"
  | "outcome";

/**
 * The STATE a column is about, taken from the column's DECLARED name.
 *
 * It is derived from the name rather than read off whatever cell happened to be
 * built, and that is not a stylistic choice: a count over an empty capability
 * list has no cell to read a state from, and a caller that fell back to a
 * default would publish a number attributed to the wrong state — the exact
 * defect [I-3] exists to prevent, wearing the shape of a harmless fallback.
 */
export function stateOfColumn(column: ColumnName): CapabilityState {
  if (column === "proposed_now" || column === "proposed_historical") return "proposed";
  return column as CapabilityState;
}

export function columnsOf(runtime: FleetRuntime): readonly ColumnName[] {
  if (runtime === "claude_code") {
    return ["registered", "assigned", "proposed_now", "proposed_historical", "loaded", "invoked", "outcome"];
  }
  return ["registered", "assigned", "proposed", "loaded", "invoked", "outcome"];
}

// =========================================================================
// The records — what an observation is made of
// =========================================================================

/**
 * ONE RECORD OF A RUNTIME, reduced to what §6 needs and NOTHING ELSE.
 *
 * [I-7] is the reason this shape carries a MARKER and not the record's text. A
 * transcript line is arbitrary content — an API key, a customer's name, a path
 * inside somebody's home directory. Nothing that reaches storage or an answer
 * needs any of it: the only thing §6 reads out of a record is which markers it
 * contains, so the text is reduced to markers at the boundary and the text
 * itself is never kept.
 */
export interface ObservedRecord {
  agent_id: string;
  runtime: FleetRuntime;
  /**
   * `proposal` — the runtime told the agent this capability was available.
   * `call` — the agent asked for it.  `output` — the runtime reported back.
   *
   * The third value is what makes [M-5] expressible: a shape that could not
   * tell a call from its output could not require a pair.
   */
  role: "proposal" | "call" | "output";
  /** what binds a call to ITS output. Null when the runtime gave none, and a
   *  null one can never form a pair — see `scanArrivals`. */
  call_id: string | null;
  at_ms: number | null;
  /** one §5 arrival marker. A record carrying several yields several records. */
  marker: string;
  /**
   * What the reporter SAID about the result, on an `output` record.
   *
   * IT IS NOT THE VERDICT AND NOTHING READS IT AS ONE. It is kept because a
   * self-report is a record of what an agent claimed, and throwing that away
   * would lose the only thing that lets a reader see a claim and its evaluation
   * disagree. §4's `outcome` column is computed by `evaluateOutcome` from the
   * signed contract and the EVIDENCE below, and this field is not one of its
   * inputs — grep for it: the outcome path does not mention it.
   */
  result: "success" | "failure" | "unknown";
  /**
   * THE NAMED VALUES THE RUN PRODUCED — what the contract's `check` is executed
   * against. `null` where the reporter presented none, which is the ordinary
   * case and yields `unknown`, never `no`.
   */
  evidence: Record<string, unknown> | null;
}

/**
 * One agent's observation, with the SELECTION BOUNDARY it was taken over.
 *
 * `proposal_inventory_complete` is the difference between "this was not among
 * the ones I was offered" and "I did not list what I was offered". Only a live
 * session can honestly set it; a stored transcript never can.
 */
export interface RuntimeSnapshot {
  agent_id: string;
  runtime: FleetRuntime;
  /** null is UNKNOWN, never "no model" */
  model: string | null;
  session_active: Trivalent;
  last_activity_ms: number | null;
  window: SelectionWindow;
  window_detail: string;
  proposal_inventory_complete: boolean;
  records: readonly ObservedRecord[];
}

/** The window phrase for an agent nothing has ever reported about. Not "zero
 *  records out of many" — no search at all, which is a different fact. */
export const NO_SNAPSHOT_WINDOW =
  "no runtime observation has been reported for this agent: no record was searched";

/**
 * WHERE A SNAPSHOT COMES FROM, IF ANYWHERE — the §6 twin of §5.5's
 * `RuntimeRecordSource`, and shaped by [M-7] in the same way.
 *
 * It yields a SNAPSHOT: records, plus the boundary they were taken over. It
 * never yields a path, a handle or a root. An implementation may read a local
 * transcript directory (V-1), a table of self-reports (V-1), or a message from
 * an agent on somebody else's machine (V-2) — the consumer cannot tell, which
 * is the property that makes the V-2 change an adapter and not a rewrite.
 *
 * `null` is NOT "zero records": it is "nothing was searched", which every
 * answer built from it says in words.
 */
export interface FleetObservationSource {
  snapshotFor(agentId: string): RuntimeSnapshot | null;
}

/** The shipped default: nothing is observed, so nothing is claimed. */
export const NO_FLEET_OBSERVATIONS: FleetObservationSource = { snapshotFor: () => null };

/** The source phrase for every arrival answer, so no cell is a bare value. */
export const SCAN_SOURCE =
  "runtime records, reduced to §5 arrival markers, matched on a PAIRED call/output record sharing one call_id";

/** The source phrase for the filesystem inventory. */
export const REGISTERED_SOURCE =
  "the filesystem under the configured inventory root, symbolic links followed [I-4]";

/** Records of one agent, narrowed to the two roles `assessArrival` understands.
 *  It is a narrowing and not a translation: the marker and the `call_id` are
 *  the record's own, and the `call_id` TRAVELS — without it the narrowing would
 *  destroy the only thing that makes a call and an output one pair [M-5]. */
export function arrivalRecordsOf(records: readonly ObservedRecord[]): ArrivalRecord[] {
  const out: ArrivalRecord[] = [];
  for (const r of records) {
    if (r.role === "call" || r.role === "output") out.push({ role: r.role, call_id: r.call_id, text: r.marker });
  }
  return out;
}

// =========================================================================
// [A-6] THE SCANNER — the only thing permitted to say `invoked`
// =========================================================================

/** What the scanner is looking FOR: one version, by the marker its id derives. */
export interface ScanSubject {
  skill_version_id: string;
  /** the marker `arrivalMarker(skill_version_id)` yields */
  marker: string;
  /** false for a `runtime.shell: ["none"]` version — D-6. Such a version ships
   *  nothing that prints its marker, so a pair carrying it cannot have come
   *  from running it. */
  has_executable_step: boolean;
}

/** [A-6]'s output tuple, one row per demonstrated arrival. */
export interface ArrivalScanRow {
  skill_version_id: string;
  marker: string;
  agent_id: string;
  runtime: FleetRuntime;
  /** when the OUTPUT was recorded; null when the runtime gave no time */
  at_ms: number | null;
  /** the id that BOUND the pair. Never null on a row: without one there is no
   *  pair, and without a pair there is no row [M-5]. */
  call_id: string;
  /** what the reporter CLAIMED. Never an input to `outcome` — see below. */
  result: "success" | "failure" | "unknown";
  /** the named values the run produced, which is what a contract is executed
   *  against. `null` where none was presented. */
  evidence: Record<string, unknown> | null;
}

/**
 * [M-5] AND [M-7], and the discipline of both is in what this function CANNOT do.
 *
 * It receives RECORDS. There is no path, no handle, no root, and no way for it
 * to look at anything the caller did not hand it — which is exactly what makes
 * it work unchanged in V-2, where the records are a message from an agent on
 * somebody else's machine and there is no filesystem of the addressee at all.
 *
 * A row is produced ONLY when:
 *
 *   * an `output` record and a `call` record share ONE non-null `call_id`,
 *   * both carry the SAME marker,
 *   * both belong to the same agent and the same runtime, and
 *   * that marker is the marker of a subject that SHIPS the arrival step.
 *
 * Every one of those is load-bearing. A lone call says an agent tried. A lone
 * output says something quoted a marker. A pair carrying ANOTHER version's
 * marker says that other version ran, and reading it as evidence for this one
 * would be the plainest form of the defect this project keeps paying for: a
 * guard that proves something other than what it claims. Anything short of the
 * full conjunction produces NO ROW, and a subject with no row is `unknown` —
 * never `no`.
 */
export function scanArrivals(
  records: Iterable<ObservedRecord>,
  subjects: readonly ScanSubject[],
): ArrivalScanRow[] {
  const bySubjectMarker = new Map<string, ScanSubject>();
  for (const s of subjects) {
    // a subject that cannot print its marker can never be demonstrated by one
    if (s.has_executable_step && MARKER_RE.test(s.marker)) bySubjectMarker.set(s.marker, s);
  }
  // THE PAIR RULE IS NOT RESTATED HERE. It is `matchArrivalPairs`
  // (src/marker.ts), the same call §5's `assessArrival` makes, because the two
  // surfaces answering the same question from the same records with two
  // implementations of "a pair" is the defect this file was corrected for.
  // What §6 adds is the SCOPE — the agent and the runtime — and a scope is a
  // narrowing, never a different rule.
  const rows: ArrivalScanRow[] = [];
  for (const pair of matchArrivalPairs(records, (r) =>
    r && typeof r.marker === "string"
      ? { role: r.role, call_id: r.call_id, markers: [r.marker], scope: [r.agent_id, r.runtime] }
      : null,
  )) {
    // THE VERSION. The marker on the record decides which subject this is
    // evidence for; it is never the subject the caller happened to ask about.
    const subject = bySubjectMarker.get(pair.marker);
    if (!subject) continue;
    const out = pair.output;
    rows.push({
      skill_version_id: subject.skill_version_id,
      marker: pair.marker,
      agent_id: out.agent_id,
      runtime: out.runtime,
      at_ms: out.at_ms ?? null,
      call_id: pair.call_id,
      result: out.result === "success" || out.result === "failure" ? out.result : "unknown",
      evidence: out.evidence ?? null,
    });
  }
  rows.sort(
    (a, b) =>
      (a.at_ms ?? 0) - (b.at_ms ?? 0) ||
      a.agent_id.localeCompare(b.agent_id) ||
      a.call_id.localeCompare(b.call_id),
  );
  return rows;
}

/**
 * The versions a SCAN demonstrated, as a set.
 *
 * It exists as a named function so that the one place [A-5] gets its "was it
 * ever used" answer from is a scan of RECORDS, and so that a change to make it
 * read intent instead would have to be written here, in the open, rather than
 * hidden in a filter expression at a call site.
 */
export function invokedVersionIds(scan: readonly ArrivalScanRow[]): Set<string> {
  return new Set(scan.map((r) => r.skill_version_id));
}

// =========================================================================
// [A-3] THE COLUMNS — every cell three-valued, every cell attributed
// =========================================================================

export interface StateColumn extends Attribution {
  column: ColumnName;
  runtime: FleetRuntime;
  value: Trivalent;
  /** a machine-readable code for WHY, never prose and never null on `unknown` */
  reason: string | null;
  /** [I-2]: which of the two columns this is. They are never merged. */
  is: "observation" | "intent";
  /** false when this state is REPORTED but not claimed under its own name */
  explicit: boolean;
  /** whether a `yes` here can be relied on */
  reliability: "reliable" | "unreliable" | "not_applicable";
  observability: Observability;
}

/** Everything a caller must supply before a column set means anything. */
export interface CapabilityEvidence {
  runtime: FleetRuntime;
  subject: ScanSubject;
  /** the FILESYSTEM answer for `registered` — three-valued, from the adapter */
  registered: { value: Trivalent; reason: string | null; window_detail: string };
  /**
   * The INTENT, verbatim from the assignment journal, or null when this
   * registry has assigned nothing. It is placed in the `assigned` column and
   * reaches no other column: the fact columns below are computed from records
   * and cannot see it [I-2].
   */
  intent: { state: string; source: string } | null;
  /** the agent's observation, or null when nothing has ever been reported */
  snapshot: RuntimeSnapshot | null;
  /**
   * THE CONTRACT ITSELF (D-2), or `null` where the version declares none.
   *
   * It used to be a BOOLEAN — "a definition of success exists somewhere" — and
   * that is how a principal's own word became a verdict: with the boolean true,
   * `outcome` was read off `records[].result`, a field the REPORTING agent
   * fills in. A principal holding the §6.2 `report_outcome` grant therefore
   * declared its own success, which is the exact thing [M-6] exists to forbid.
   *
   * The evaluator now receives the contract and EXECUTES its `check`.
   */
  outcome_contract: OutcomeContract | null;
}

function windowOf(snapshot: RuntimeSnapshot | null): { window: SelectionWindow; window_detail: string } {
  if (!snapshot) return { window: "all_time", window_detail: NO_SNAPSHOT_WINDOW };
  return { window: snapshot.window, window_detail: snapshot.window_detail };
}

function column(
  c: ColumnName,
  state: CapabilityState,
  runtime: FleetRuntime,
  value: Trivalent,
  reason: string | null,
  source: EvidenceSource,
  win: { window: SelectionWindow; window_detail: string },
  extra: { is?: "observation" | "intent"; reliability?: StateColumn["reliability"] } = {},
): StateColumn {
  const m = matrixCell(state, runtime);
  // THE [A-0] RULE, ENFORCED RATHER THAN DOCUMENTED. A cell the matrix says can
  // never say `no` does not say `no`, whatever the caller computed. This is the
  // single most important line in the module: it is what stops a later change,
  // a later surface or a later refactor from turning "nothing was reported"
  // into "it did not happen".
  const safe: Trivalent = value === "no" && !m.can_be_no ? "unknown" : value;
  const col: StateColumn = {
    column: c,
    runtime,
    value: safe,
    reason: safe === "yes" ? reason : (reason ?? "no_evidence"),
    is: extra.is ?? "observation",
    explicit: m.explicit,
    reliability: extra.reliability ?? "reliable",
    observability: m.observability,
    state,
    source,
    window: win.window,
    window_detail: win.window_detail,
  };
  const missing = missingAttribute(col);
  if (missing !== null) throw new Error(`a state column is not published without its method: \`${missing}\` [I-3]`);
  return col;
}

/**
 * The columns ONE capability publishes on ONE runtime.
 *
 * The shape of the answer differs by runtime, deliberately — see `columnsOf`.
 * Everything below is the §4 matrix executed, with the two rules that keep it
 * honest applied at every step: a cell that cannot be `no` is never `no`, and a
 * cell that is not `explicit` is reported without being claimed.
 */
export function capabilityColumns(ev: CapabilityEvidence): StateColumn[] {
  const runtime = ev.runtime;
  const snapshot = ev.snapshot;
  const win = windowOf(snapshot);
  const all: SelectionWindow = "all_time";
  const out: StateColumn[] = [];

  // ---- registered: a FILESYSTEM fact, and the one state where `no` is honest
  out.push(
    column("registered", "registered", runtime, ev.registered.value, ev.registered.reason, "filesystem", {
      window: all,
      window_detail: ev.registered.window_detail,
    }),
  );

  // ---- assigned: the INTENT column, labelled as one, and never anywhere else
  out.push(
    column(
      "assigned",
      "assigned",
      runtime,
      ev.intent ? "yes" : "no",
      ev.intent ? ev.intent.state : "no_assignment_recorded",
      "registry",
      { window: all, window_detail: ev.intent ? ev.intent.source : "the INSERT-only assignment journal, all time" },
      { is: "intent" },
    ),
  );

  const proposals = (snapshot?.records ?? []).filter(
    (r) => r.role === "proposal" && r.marker === ev.subject.marker,
  );

  if (runtime === "claude_code") {
    // ---- proposed_now: a live session, and only a live session
    let nowValue: Trivalent = "unknown";
    let nowReason: string | null = "no_live_session";
    if (snapshot && snapshot.window === "live_session" && snapshot.session_active === "yes") {
      if (proposals.length > 0) {
        nowValue = "yes";
        nowReason = null;
      } else if (snapshot.proposal_inventory_complete) {
        // the ONE place a proposal may honestly be `no`: the session listed
        // everything it was offered, and this was not among them
        nowValue = "no";
        nowReason = "absent_from_a_complete_live_inventory";
      } else {
        nowReason = "live_session_did_not_enumerate_what_was_offered";
      }
    }
    out.push(
      column("proposed_now", "proposed", runtime, nowValue, nowReason, "runtime", {
        window: "live_session",
        window_detail:
          snapshot && snapshot.window === "live_session"
            ? snapshot.window_detail
            : "no live session was observed for this agent",
      }),
    );

    // ---- proposed_historical: a stored transcript, and it is UNRELIABLE.
    // Its silence is `unknown`. Not `no`, not ever, and not even when the
    // report claimed to enumerate: the signal survives in roughly one stored
    // transcript in fifty, so an enumeration of stored transcripts enumerates
    // the transcripts and not what was offered.
    const historic = snapshot && snapshot.window !== "live_session" ? proposals.length > 0 : false;
    out.push(
      column(
        "proposed_historical",
        "proposed",
        runtime,
        historic ? "yes" : "unknown",
        historic ? null : snapshot ? "no_transcript_record" : "no_runtime_observation",
        "transcript",
        {
          window: snapshot && snapshot.window !== "live_session" ? snapshot.window : all,
          window_detail: snapshot && snapshot.window !== "live_session" ? snapshot.window_detail : NO_SNAPSHOT_WINDOW,
        },
        { reliability: "unreliable" },
      ),
    );
  } else {
    // ---- Codex `proposed`: ONE column, `unknown` ALWAYS [A-0].
    // Not "unknown until we look harder" — there is nothing to look at.
    // `turn_context` carries no skill inventory and no dedicated event exists,
    // so this is `unknown` even when a report volunteers a proposal record.
    out.push(
      column("proposed", "proposed", runtime, "unknown", "runtime_emits_no_skill_inventory", "runtime", {
        window: all,
        window_detail: "the runtime publishes no skill-availability signal in any window",
      }),
    );
  }

  // ---- loaded: reported, never claimed, on either runtime
  out.push(
    column(
      "loaded",
      "loaded",
      runtime,
      "unknown",
      runtime === "claude_code" ? "not_separable_from_proposed" : "runtime_emits_no_skill_inventory",
      "transcript",
      { window: all, window_detail: "no window makes this separable from `proposed`" },
    ),
  );

  // ---- invoked: [M-5], and D-6's two distinguishable unknowns
  const assessment = assessArrival(arrivalRecordsOf(snapshot?.records ?? []), ev.subject as ArrivalSubject);
  const paired = scanArrivals(snapshot?.records ?? [], [ev.subject]);
  const invoked: Trivalent = paired.length > 0 ? "yes" : "unknown";
  const invokedReason: ArrivalUnknownReason | null =
    invoked === "yes" ? null : ev.subject.has_executable_step ? "no_paired_record" : "no_executable_step";
  out.push(column("invoked", "invoked", runtime, invoked, invokedReason, "transcript", win));

  // §5 AND §6 NOW ANSWER BY THE SAME RULE, AND THIS ASSERTS IT ON REAL RECORDS.
  //
  // They did not always. `assessArrival` used to count SOME call record and
  // SOME output record carrying the marker, while §6 required the two to be
  // bound by ONE `call_id`. The gap was not academic: one set of records was a
  // pair on the assignments surface and not a pair on the capability surface,
  // at the same moment, from the same rows — and each surface cited [M-5].
  // Both now call `matchArrivalPairs` (src/marker.ts); §6 adds the agent and
  // the runtime as a SCOPE, which narrows within one snapshot and never widens.
  //
  // So on the records of ONE agent's snapshot the two answers are EQUAL, in
  // both directions, and a disagreement in either is a defect in one of the two
  // rather than a state a caller's records can reach.
  if (invoked === "yes" && assessment.verdict !== "yes") {
    throw new Error("the §6 scanner found a pair the §5 assessment does not: one of the two is reporting something other than what it says");
  }
  if (assessment.verdict === "yes" && invoked !== "yes") {
    throw new Error("the §5 assessment found a pair the §6 scanner does not: one of the two is reporting something other than what it says");
  }

  // ---- outcome: THE CONTRACT IS EXECUTED, or the answer is `unknown` [M-6].
  //
  // WHAT THIS USED TO BE, because the shape of the defect matters more than the
  // fix. `outcome` was read off `paired[last].result` — a field the REPORTING
  // agent fills in — whenever a boolean said a contract existed. A principal
  // with the §6.2 `report_outcome` grant declared its own success and this
  // column printed it. `result` is not read here any more, in either direction:
  // a reporter's `success` is not a `yes`, and its `failure` is not a `no`.
  let outcomeValue: Trivalent = "unknown";
  let outcomeReason: string | null = ev.outcome_contract ? "no_evaluated_run" : "no_outcome_contract";
  if (ev.outcome_contract && paired.length > 0) {
    const verdict = evaluateOutcome(ev.outcome_contract, paired[paired.length - 1]!.evidence);
    outcomeValue = verdict.value;
    outcomeReason = verdict.value === "yes" ? null : verdict.reason;
  }
  out.push(column("outcome", "outcome", runtime, outcomeValue, outcomeReason, "transcript", win));

  return out;
}

/**
 * The name of the first column making an EXPLICIT `loaded` claim, or null.
 *
 * `loaded` is the state §4 says is not separable from `proposed`, so a surface
 * that printed `loaded: yes` would be publishing an inference as an
 * observation. The guard is applied to the shipped answers rather than trusted
 * to the function above, for the same reason `erasureClaim` is applied to
 * shipped text: the rule has to survive the next surface somebody adds.
 */
export function explicitLoadedClaim(columns: readonly StateColumn[]): string | null {
  for (const c of columns) {
    if (c.state !== "loaded") continue;
    if (c.explicit) return `${c.column}: published as an explicit \`loaded\` column`;
    if (c.value !== "unknown") return `${c.column}: \`loaded\` answered \`${c.value}\``;
  }
  return null;
}

/**
 * The name of the first column that answered `no` where the matrix forbids it,
 * or null. [A-0] as a check over a finished answer.
 */
export function forbiddenNoClaim(columns: readonly StateColumn[]): string | null {
  for (const c of columns) {
    if (c.value !== "no") continue;
    if (!matrixCell(c.state, c.runtime).can_be_no) {
      return `${c.runtime}/${c.column}: answered \`no\` where only \`unknown\` is establishable [A-0]`;
    }
  }
  return null;
}

/** The name of the first column, or number, that lost an attribute [I-3]. */
export function unattributed(values: readonly Attribution[]): string | null {
  for (const v of values) {
    const missing = missingAttribute(v);
    if (missing !== null) return `${(v as { column?: string }).column ?? v.state}: \`${missing}\``;
  }
  return null;
}

// =========================================================================
// [A-4] THE GAP — intent against fact, in one visible row
// =========================================================================

/**
 * What Skillonomia INTENDS, beside what has been OBSERVED.
 *
 * It is derived from an `AssignmentView` and from nothing else — work 5's row
 * is the pattern §6 follows and a second source of truth is exactly what this
 * project is trying not to grow. The classification below reads the two fields
 * that view already publishes; it computes neither from the other.
 */
export type GapClass =
  /** the registry says active and a record shows the version ran */
  | "intent_active_and_arrival_observed"
  /** the registry says active and NOTHING has been observed — the common case */
  | "intent_active_arrival_unobserved"
  /** a record shows a run the registry has not (or no longer) declared active */
  | "arrival_observed_without_active_intent"
  /** neither side claims anything */
  | "no_claim_on_either_side";

export interface IntentFactGap {
  agent_id: string;
  skill_id: string;
  slug: string;
  skill_version_id: string;
  /** COLUMN ONE — verbatim from the assignment view */
  intent_state: string;
  intent_state_is: "intent";
  intent_state_source: string;
  /** COLUMN TWO — verbatim from the assignment view */
  observed_arrival: Trivalent;
  observed_arrival_is: "observation";
  observed_arrival_reason: string | null;
  observed_arrival_source: string;
  observed_arrival_window: string;
  /** the comparison, labelled as a comparison and not as either column */
  gap: GapClass;
  gap_is: "comparison";
}

/** The two fields of an assignment view this comparison is allowed to read. */
export interface GapInput {
  agent_id: string;
  skill_id: string;
  slug: string;
  skill_version_id: string;
  intent_state: string;
  intent_state_source: string;
  observed_arrival: "yes" | "unknown";
  observed_arrival_reason: string | null;
  observed_arrival_source: string;
  observed_arrival_window: string;
}

export function gapOf(view: GapInput): IntentFactGap {
  const active = view.intent_state === "active";
  const arrived = view.observed_arrival === "yes";
  const gap: GapClass = active
    ? arrived
      ? "intent_active_and_arrival_observed"
      : "intent_active_arrival_unobserved"
    : arrived
      ? "arrival_observed_without_active_intent"
      : "no_claim_on_either_side";
  return {
    agent_id: view.agent_id,
    skill_id: view.skill_id,
    slug: view.slug,
    skill_version_id: view.skill_version_id,
    intent_state: view.intent_state,
    intent_state_is: "intent",
    intent_state_source: view.intent_state_source,
    observed_arrival: view.observed_arrival,
    observed_arrival_is: "observation",
    observed_arrival_reason: view.observed_arrival_reason,
    observed_arrival_source: view.observed_arrival_source,
    observed_arrival_window: view.observed_arrival_window,
    gap,
    gap_is: "comparison",
  };
}

// =========================================================================
// [A-5] DEAD WEIGHT — registered, and never once invoked
// =========================================================================

/** One thing found on a disk, as the inventory adapter reports it. */
export interface RegisteredCapability {
  agent_id: string;
  runtime: FleetRuntime;
  kind: CapabilityKind;
  name: string;
  /** the version this is a managed copy OF, when it could be identified */
  skill_version_id: string | null;
  /** the §5 marker read out of the copy's own `SKILL.md`, when it carries one */
  marker: string | null;
}

export const CAPABILITY_KINDS = ["skill", "plugin", "mcp_server", "mcp_tool", "connector"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export interface DeadWeightItem {
  agent_id: string;
  runtime: FleetRuntime;
  kind: CapabilityKind;
  name: string;
  skill_version_id: string | null;
  /** why it counts as dead weight, as a code */
  reason: "never_invoked" | "no_version_identified";
}

export interface DeadWeightSlice {
  items: DeadWeightItem[];
  registered: MeasuredNumber;
  invoked: MeasuredNumber;
  dead: MeasuredNumber;
}

/**
 * THE FIRST DAY'S USEFUL SCREEN: what is on the disk and has never run.
 *
 * The signature is the guarantee. It takes what was FOUND (a filesystem walk)
 * and what was DEMONSTRATED (a set of version ids a scan of records produced).
 * It takes no assignment, no deployment state and no database handle, so it
 * cannot count "used" from what this registry INTENDED — the mistake that would
 * turn the number from a measurement into a restatement of our own decisions.
 *
 * A copy whose version could not be identified is dead weight WITH ITS OWN
 * REASON rather than silently absent: an unidentifiable copy is precisely the
 * one nobody is tracking.
 */
export function deadWeight(
  registered: readonly RegisteredCapability[],
  invoked: ReadonlySet<string>,
  attribution: { registeredWindow: string; invokedWindow: string; invokedSelection: SelectionWindow },
): DeadWeightSlice {
  const items: DeadWeightItem[] = [];
  let used = 0;
  for (const r of registered) {
    if (r.skill_version_id === null) {
      items.push({ ...pick(r), reason: "no_version_identified" });
      continue;
    }
    if (invoked.has(r.skill_version_id)) {
      used += 1;
      continue;
    }
    items.push({ ...pick(r), reason: "never_invoked" });
  }
  return {
    items,
    registered: countedNumber(registered.length, {
      state: "registered",
      source: "filesystem",
      window: "all_time",
      window_detail: attribution.registeredWindow,
    }),
    invoked: countedNumber(used, {
      state: "invoked",
      source: "transcript",
      window: attribution.invokedSelection,
      window_detail: attribution.invokedWindow,
    }),
    dead: countedNumber(
      items.length,
      {
        state: "invoked",
        source: "transcript",
        window: attribution.invokedSelection,
        window_detail: attribution.invokedWindow,
      },
      "registered capabilities for which no paired call/output record was found — `unknown`, not `never used` [I-1]",
    ),
  };
}

/** What `deadWeightOf` needs, with BOTH columns in scope on purpose. */
export interface DeadWeightInput {
  registered: readonly RegisteredCapability[];
  /** COLUMN TWO — what a scan of RECORDS demonstrated. This is the one the
   *  count is taken from. */
  scan: readonly ArrivalScanRow[];
  /** COLUMN ONE — the versions this registry INTENDS to be active.
   *
   *  It is carried here deliberately, and it is NOT used to decide whether
   *  anything is dead weight. [A-5]'s whole value is that it measures rather
   *  than restates our own decisions, and the failure mode is a single filter
   *  expression swapped at a call site where nobody would look. So both columns
   *  are put in ONE scope, next to the sentence forbidding the swap, and the
   *  intent number is PUBLISHED BESIDE the slice — for a person to compare, and
   *  never for the code to merge [I-2]. */
  intent_active_version_ids: readonly string[];
  attribution: { registeredWindow: string; invokedWindow: string; invokedSelection: SelectionWindow };
}

export interface DeadWeightAnswer extends DeadWeightSlice {
  /** the OTHER column, published so the comparison is a reader's to make */
  intent_active: MeasuredNumber;
}

/** [A-5] as every surface publishes it: the slice, and the intent beside it. */
export function deadWeightOf(input: DeadWeightInput): DeadWeightAnswer {
  // THE INVOKED SET COMES FROM THE SCAN — from records — and from nothing else.
  const invoked = invokedVersionIds(input.scan);
  return {
    ...deadWeight(input.registered, invoked, input.attribution),
    intent_active: countedNumber(input.intent_active_version_ids.length, {
      state: "assigned",
      source: "registry",
      window: "all_time",
      window_detail: "the versions this registry intends to be active at this agent, from the assignment journal",
    }),
  };
}

function pick(r: RegisteredCapability): Omit<DeadWeightItem, "reason"> {
  return {
    agent_id: r.agent_id,
    runtime: r.runtime,
    kind: r.kind,
    name: r.name,
    skill_version_id: r.skill_version_id,
  };
}

// =========================================================================
// [A-1] THE AGENT ROW, and [A-2] the capability counts
// =========================================================================

/** §6's synchronisation vocabulary. `unknown` is a member, not a fallback. */
export const SYNC_STATUSES = ["in_sync", "pending", "drifted", "failed", "unknown"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export interface AgentInventoryRow {
  agent_id: string;
  /** the principal's own type and role, AS RECORDED [I-5] */
  type: string;
  role: string | null;
  name: string;
  /** the runtime, when one has been observed. `null` is UNKNOWN, never a guess */
  runtime: FleetRuntime | null;
  runtime_source: EvidenceSource | "none";
  model: string | null;
  session_active: Trivalent;
  last_activity_ms: number | null;
  /** the boundary every field above was read over */
  observation_window: string;
  observation_is: "observation";
  sync_status: SyncStatus;
  sync_status_is: "comparison";
  sync_status_reason: string;
  /** the two columns the comparison was made FROM, so it is never taken for one */
  intent_active: MeasuredNumber;
  observed_arrival_yes: MeasuredNumber;
}

/**
 * The synchronisation status of one agent, as a COMPARISON of the two columns.
 *
 * It is not a third fact and is labelled so. The order of the tests is the
 * order of severity, and the `unknown` branch comes BEFORE the agreeable ones:
 * an agent nothing has reported about is not "in sync", it is unobserved, and
 * calling that `in_sync` would be the intent column answering for the fact
 * column in one word.
 */
export function syncStatusOf(input: {
  observed: boolean;
  headStates: readonly string[];
  intentActive: number;
  arrivalYes: number;
}): { status: SyncStatus; reason: string } {
  if (input.headStates.includes("failed")) {
    return { status: "failed", reason: "a deployment journal records `failed`" };
  }
  if (input.headStates.includes("drifted")) {
    return { status: "drifted", reason: "a deployment journal records `drifted`" };
  }
  if (!input.observed) {
    return {
      status: "unknown",
      reason: "no runtime observation has been reported for this agent: nothing was compared",
    };
  }
  if (input.intentActive === 0) {
    return { status: "unknown", reason: "this registry intends nothing active for this agent: nothing to compare" };
  }
  if (input.arrivalYes >= input.intentActive) {
    return { status: "in_sync", reason: "every deployment intended active has an observed arrival" };
  }
  // [I-3]: the reason NAMES the two numbers it compared and does not restate a
  // derived count in prose. A figure inside a sentence carries no measurement
  // state, no source and no window; the two cells it would be derived from
  // carry all three, and they stand on this very row.
  return {
    status: "pending",
    reason:
      "fewer deployments have an observed arrival than this registry intends active — compare the `intent_assigned` " +
      "and `fact_invoked` cells of this row, each with its own source and window. The difference is UNOBSERVED, and " +
      "never known to be absent",
  };
}
