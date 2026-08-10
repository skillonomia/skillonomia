// DEPLOYMENT ASSIGNMENTS — what the registry DECIDED, kept apart from what has
// been OBSERVED, in every row, on every surface, forever.
//
// THE TRAP THIS MODULE IS BUILT AROUND. The deployment state machine contains a
// state called `active`:
//
//     assigned → queued → activating → active → drifted | failed
//                                            → paused  | revoked
//
// and `active` is the most dangerous word in this system. It is SKILLONOMIA'S
// INTENT — "this registry believes it put the managed copy where the runtime
// reads it, and read it back from there". It is not a report about the runtime.
// Nothing in a Codex-class runtime reports skill lifecycle; a file being on
// disk says nothing about whether an agent ever opened it, and an agent that
// opened it may have been running before the file arrived.
//
// So this module has TWO COLUMNS and they never touch:
//
//   INTENT      `intent_state`, read from the INSERT-only journal, labelled as
//               an intent on every row it appears on.
//   OBSERVATION `observed_arrival`, computed ONLY by `assessArrival`
//               (src/marker.ts) from runtime records, and `unknown` whenever
//               there are none. Three-valued and never blank: the answers are
//               `yes` and `unknown`, and `no` is not among them because nothing
//               observable establishes it.
//
// `observedArrival` below takes records and a marker. It takes no assignment,
// no state and no database handle, and that is deliberate: the cheapest way for
// the observation column to start echoing the intent column is for the function
// that computes it to have the intent within reach. It does not.
//
// WHERE RECORDS COME FROM, AND WHY THAT IS A SEAM. In V1 the registry does not
// scan transcripts — the inventory and scanner are a separate piece of work —
// so the shipped default source yields nothing and every observation is
// `unknown` with its window saying exactly that. `RuntimeRecordSource` is the
// seam that work plugs into, and it is shaped by [M-7]: it hands over RECORDS,
// never paths, because in the next version the record is a line of text an
// agent outside this perimeter sent.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";
import {
  arrivalMarker,
  assessArrival,
  shipsArrivalScript,
  type ArrivalRecord,
  type ArrivalSubject,
  type ArrivalUnknownReason,
  type ArrivalVerdict,
} from "./marker.ts";
import type { GrantAction, GrantPrincipal, PrincipalType, RecipientKind, WorkspaceRole } from "./grants.ts";
import {
  ACTIVATION_SESSION_EFFECT,
  INSTRUCTIONS_ALREADY_READ,
  type ActivationTarget,
  type ManagedCopy,
} from "./activation.ts";

// ---------------------------------------------------------- the state machine

/** The deployment states, which are also the journal's event names. */
export const DEPLOYMENT_STATES = [
  "assigned",
  "queued",
  "activating",
  "active",
  "drifted",
  "failed",
  "paused",
  "revoked",
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/**
 * What may follow what. `revoked` is terminal — a withdrawal that could be
 * undone by another event would make the journal's last row a poor answer to
 * "was this taken back?", and taking it back again is a fresh assignment.
 */
export const DEPLOYMENT_TRANSITIONS: Readonly<Record<DeploymentState, readonly DeploymentState[]>> = {
  assigned: ["queued", "activating", "paused", "revoked"],
  queued: ["activating", "paused", "revoked"],
  activating: ["active", "failed"],
  active: ["drifted", "activating", "paused", "revoked"],
  drifted: ["activating", "paused", "revoked"],
  failed: ["activating", "paused", "revoked"],
  paused: ["activating", "revoked"],
  revoked: [],
};

/** The one source a deployment state may be read from, named in every answer. */
export const ASSIGNMENT_INTENT_SOURCE = "assignment_events (registry journal, INSERT-only)";

/** The one source an ARRIVAL may be read from, named in every answer. */
export const ARRIVAL_OBSERVATION_SOURCE =
  "runtime transcript records, matched by the §5 arrival marker on a PAIRED call/output record";

/** The selection boundary when no record source is configured. Not zero
 *  records examined out of many — no search at all, which is a different fact. */
export const NO_RECORD_SOURCE_WINDOW =
  "no runtime record source is configured for this deployment: no transcript record was searched";

/** The source of the native-inventory count, named wherever that number goes. */
export const NATIVE_INVENTORY_SOURCE =
  "filesystem under the configured activation root, symbolic links followed";

// ------------------------------------------------------- the observation seam

/** A set of records with the SELECTION BOUNDARY they were taken over. */
export interface RuntimeRecordWindow {
  records: readonly ArrivalRecord[];
  /** one publishable phrase saying which records these are */
  window: string;
}

/**
 * Where runtime records come from, if anywhere.
 *
 * [M-7]: it yields RECORDS, never a path and never a file handle. A source that
 * knows nothing about one agent answers `null`, and `null` is not zero records —
 * it is "nothing was searched", which the window below says in words.
 */
export interface RuntimeRecordSource {
  recordsFor(agentId: string): RuntimeRecordWindow | null;
}

/** The shipped default: no transcript is read, so no arrival is observed. */
export const NO_RUNTIME_RECORDS: RuntimeRecordSource = { recordsFor: () => null };

export interface ArrivalObservation {
  verdict: ArrivalVerdict;
  reason: ArrivalUnknownReason | null;
  source: string;
  window: string;
  /** how many records this answer was taken over — the third attribute */
  records_read: number;
}

/**
 * THE OBSERVATION COLUMN, and the only function permitted to compute it.
 *
 * Its parameters are the whole of what it may know: a set of records and the
 * subject's marker. It cannot see the assignment, the deployment state or the
 * database, so it cannot report an intent as an observation even by accident —
 * and a change that let it would have to widen this signature, in the open.
 *
 * The verdict itself is `assessArrival`'s, unmodified: `yes` only on a PAIRED
 * call/output record carrying this version's marker, `unknown` otherwise, and
 * never `no`.
 */
export function observedArrival(window: RuntimeRecordWindow | null, subject: ArrivalSubject): ArrivalObservation {
  const records = window?.records ?? [];
  const assessment = assessArrival(records, subject);
  return {
    verdict: assessment.verdict,
    reason: assessment.reason,
    source: ARRIVAL_OBSERVATION_SOURCE,
    window: window?.window ?? NO_RECORD_SOURCE_WINDOW,
    records_read: records.length,
  };
}

// ------------------------------------------------------------------ the rows

export interface AssignmentRow {
  id: string;
  skill_id: string;
  slug: string;
  skill_version_id: string;
  semantic_version: string;
  manifest_json: string;
  agent_id: string;
  workspace_id: string;
  recipient_kind: RecipientKind;
  transfer_id: string;
  assigned_by_agent_id: string;
  assigned_by_type: PrincipalType;
  assigned_by_role: WorkspaceRole;
  created_at_ms: number;
}

export interface AssignmentEventRow {
  id: string;
  assignment_id: string;
  event: DeploymentState;
  event_seq: number;
  reason: string | null;
  actor_agent_id: string;
  actor_type: PrincipalType;
  actor_role: WorkspaceRole;
  grant_id: string | null;
  grant_action: GrantAction | null;
  activation_target: ActivationTarget | null;
  native_relpath: string | null;
  managed_copy: ManagedCopy | null;
  server_at_ms: number;
}

const ASSIGNMENT_COLUMNS = `a.id, a.skill_id, s.slug AS slug, a.skill_version_id, v.semantic_version AS semantic_version,
        v.manifest_json AS manifest_json, a.agent_id, ag.workspace_id AS workspace_id, a.recipient_kind, a.transfer_id,
        a.assigned_by_agent_id, a.assigned_by_type, a.assigned_by_role, a.created_at_ms`;

const ASSIGNMENT_FROM = `FROM assignments a
        JOIN skills s ON s.id = a.skill_id
        JOIN skill_versions v ON v.id = a.skill_version_id
        JOIN agents ag ON ag.id = a.agent_id`;

export function loadAssignment(db: Db, id: string): AssignmentRow | undefined {
  return db.prepare(`SELECT ${ASSIGNMENT_COLUMNS} ${ASSIGNMENT_FROM} WHERE a.id = ?`).get(id) as
    | AssignmentRow
    | undefined;
}

/** Every assignment addressed to one of the given agents, oldest first. */
export function assignmentsForAgents(db: Db, agentIds: readonly string[]): AssignmentRow[] {
  if (agentIds.length === 0) return [];
  return db
    .prepare(
      `SELECT ${ASSIGNMENT_COLUMNS} ${ASSIGNMENT_FROM}
        WHERE a.agent_id IN (${agentIds.map(() => "?").join(",")})
        ORDER BY a.created_at_ms, a.id`,
    )
    .all(...agentIds) as AssignmentRow[];
}

export function eventsOf(db: Db, assignmentIds: readonly string[]): AssignmentEventRow[] {
  if (assignmentIds.length === 0) return [];
  return db
    .prepare(
      `SELECT id, assignment_id, event, event_seq, reason, actor_agent_id, actor_type, actor_role, grant_id,
              grant_action, activation_target, native_relpath, managed_copy, server_at_ms
         FROM assignment_events WHERE assignment_id IN (${assignmentIds.map(() => "?").join(",")})
        ORDER BY assignment_id, event_seq`,
    )
    .all(...assignmentIds) as AssignmentEventRow[];
}

// ------------------------------------------------------------ the head state

export interface AssignmentHead {
  state: DeploymentState;
  event_seq: number;
  at_ms: number;
  reason: string | null;
  /** the last placement this journal recorded, if it recorded one */
  activation_target: ActivationTarget | null;
  native_relpath: string | null;
  managed_copy: ManagedCopy | null;
}

/**
 * The deployment state, derived from the journal and from nowhere else.
 *
 * The head is the highest `event_seq`; the placement fields are the LAST
 * non-null value of each, which is not the same thing — a `paused` event carries
 * a `managed_copy` and no target, and a reader still needs to know which native
 * location the copy had been placed in.
 */
export function headFrom(events: readonly AssignmentEventRow[]): AssignmentHead {
  if (events.length === 0) throw new Error("an assignment with no event is not reachable: the row and its first event are one transaction");
  let head = events[0]!;
  const last: AssignmentHead = {
    state: head.event,
    event_seq: head.event_seq,
    at_ms: head.server_at_ms,
    reason: head.reason,
    activation_target: null,
    native_relpath: null,
    managed_copy: null,
  };
  for (const e of events) {
    if (e.event_seq >= head.event_seq) head = e;
    if (e.activation_target !== null) last.activation_target = e.activation_target;
    if (e.native_relpath !== null) last.native_relpath = e.native_relpath;
    if (e.managed_copy !== null) last.managed_copy = e.managed_copy;
  }
  last.state = head.event;
  last.event_seq = head.event_seq;
  last.at_ms = head.server_at_ms;
  last.reason = head.reason;
  return last;
}

export function headOf(db: Db, assignmentId: string): AssignmentHead {
  return headFrom(eventsOf(db, [assignmentId]));
}

// --------------------------------------------------------------- the writes

export interface CreateAssignmentInput {
  skillId: string;
  skillVersionId: string;
  agentId: string;
  recipientKind: RecipientKind;
  transferId: string;
  assignedBy: GrantPrincipal;
  grantId: string;
  grantAction: GrantAction;
  nowMs: number;
}

/**
 * Record one push: the row and its first event, in the caller's transaction.
 *
 * The two are inseparable for the reason the transfer gives about its own
 * writes — an assignment with no event would be a decision with no journal, and
 * the journal is where the state lives.
 */
export function createAssignmentInTx(db: Db, input: CreateAssignmentInput): { assignment_id: string } {
  const id = ulid(input.nowMs);
  db.prepare(
    `INSERT INTO assignments(id, skill_id, skill_version_id, agent_id, recipient_kind, transfer_id,
       assigned_by_agent_id, assigned_by_type, assigned_by_role, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.skillId,
    input.skillVersionId,
    input.agentId,
    input.recipientKind,
    input.transferId,
    input.assignedBy.agent_id,
    input.assignedBy.type,
    input.assignedBy.role,
    input.nowMs,
  );
  appendAssignmentEvent(db, {
    assignmentId: id,
    event: "assigned",
    actor: input.assignedBy,
    grantId: input.grantId,
    grantAction: input.grantAction,
    idempotencyKey: `assigned:${id}`,
    nowMs: input.nowMs,
  });
  return { assignment_id: id };
}

export interface AppendAssignmentEventInput {
  assignmentId: string;
  event: DeploymentState;
  actor: GrantPrincipal;
  reason?: string | null;
  grantId?: string | null;
  grantAction?: GrantAction | null;
  activationTarget?: ActivationTarget | null;
  nativeRelpath?: string | null;
  managedCopy?: ManagedCopy | null;
  idempotencyKey: string;
  nowMs: number;
}

/**
 * Append one deployment event, refusing an illegal transition.
 *
 * There is NO enclosing transaction around the sequence a caller writes, and
 * that is on purpose for `activating`: it is committed BEFORE the filesystem is
 * touched, so a process that dies mid-write leaves an assignment stuck at
 * `activating` and never one that claims `active` for a copy that was never
 * placed. An unfinished activation is a fact worth keeping.
 */
export function appendAssignmentEvent(db: Db, input: AppendAssignmentEventInput): { event_seq: number } {
  const existing = eventsOf(db, [input.assignmentId]);
  let seq = 1;
  if (existing.length > 0) {
    const head = headFrom(existing);
    const allowed = DEPLOYMENT_TRANSITIONS[head.state];
    if (!allowed.includes(input.event)) {
      throw new ApiError(
        "PRECONDITION_FAILED",
        `a deployment in \`${head.state}\` does not move to \`${input.event}\` (allowed: ${allowed.length === 0 ? "nothing — it is terminal" : allowed.join("|")})`,
        head.state,
      );
    }
    seq = head.event_seq + 1;
  } else if (input.event !== "assigned") {
    throw new Error("the first event of an assignment is `assigned`");
  }
  db.prepare(
    `INSERT INTO assignment_events(id, assignment_id, event, event_seq, reason, actor_agent_id, actor_type,
       actor_role, grant_id, grant_action, activation_target, native_relpath, managed_copy, server_at_ms,
       idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ulid(input.nowMs),
    input.assignmentId,
    input.event,
    seq,
    input.reason ?? null,
    input.actor.agent_id,
    input.actor.type,
    input.actor.role,
    input.grantId ?? null,
    input.grantAction ?? null,
    input.activationTarget ?? null,
    input.nativeRelpath ?? null,
    input.managedCopy ?? null,
    input.nowMs,
    input.idempotencyKey,
  );
  return { event_seq: seq };
}

/**
 * SUPERSEDE — one agent holds at most one standing assignment per skill.
 *
 * A second push of the same skill to the same agent replaces the first, and the
 * replacement is written as a `revoked` event naming the successor rather than
 * as an edit of the old row: the old decision was real and stays readable.
 *
 * The managed copy is reported `retained`, and that is the honest answer rather
 * than a shortcut. This runs inside the transfer's transaction, which touches no
 * filesystem; the successor's activation writes the SAME native location, so
 * the copy is replaced when the successor is activated and not before. Saying
 * `removed` here would be the registry claiming a file operation it did not
 * perform.
 */
export function supersedeAssignmentsInTx(
  db: Db,
  input: { skillId: string; agentId: string; successorAssignmentId: string; actor: GrantPrincipal; nowMs: number },
): string[] {
  const rows = db
    .prepare("SELECT id FROM assignments WHERE skill_id=? AND agent_id=? AND id<>? ORDER BY created_at_ms, id")
    .all(input.skillId, input.agentId, input.successorAssignmentId) as Array<{ id: string }>;
  const superseded: string[] = [];
  for (const row of rows) {
    const head = headFrom(eventsOf(db, [row.id]));
    if (head.state === "revoked") continue;
    appendAssignmentEvent(db, {
      assignmentId: row.id,
      event: "revoked",
      actor: input.actor,
      reason: `superseded_by_assignment:${input.successorAssignmentId}`,
      managedCopy: head.managed_copy === "written" ? "retained" : "absent",
      idempotencyKey: `superseded:${input.successorAssignmentId}`,
      nowMs: input.nowMs,
    });
    superseded.push(row.id);
  }
  return superseded;
}

// ---------------------------------------------------------------- the view

/**
 * One assignment as every surface publishes it.
 *
 * The field NAMES carry the distinction and the `_is` labels repeat it, because
 * a reader who takes one row away from a page must not be able to mistake which
 * column is which. `intent_state` is what this registry decided. `observed_
 * arrival` is what a runtime record showed. They are computed from different
 * sources, both sources are named on the row, and neither is derived from the
 * other.
 */
export interface AssignmentView {
  assignment_id: string;
  skill_id: string;
  slug: string;
  skill_version_id: string;
  semantic_version: string;
  agent_id: string;
  recipient_kind: RecipientKind;
  transfer_id: string;
  assigned_by: GrantPrincipal;
  created_at_ms: number;

  /** COLUMN ONE — Skillonomia's intent, from the journal */
  intent_state: DeploymentState;
  intent_state_is: "intent";
  intent_state_source: string;
  intent_event_seq: number;
  intent_at_ms: number;
  intent_reason: string | null;

  /** COLUMN TWO — what has been observed at the runtime, and nothing else */
  observed_arrival: ArrivalVerdict;
  observed_arrival_is: "observation";
  observed_arrival_reason: ArrivalUnknownReason | null;
  observed_arrival_source: string;
  observed_arrival_window: string;
  observed_records_read: number;

  /** the §5 marker a run of this version prints, and whether it can print one */
  arrival_marker: string;
  has_executable_step: boolean;

  /** the native projection, as far as this registry knows it */
  activation_target: ActivationTarget | null;
  native_relpath: string | null;
  /** five-valued and never blank: `unknown` is not `absent` */
  managed_copy: ManagedCopy | "unknown";
  requires_new_session: boolean;
  session_effect: string;
}

/**
 * Build the row. The observation is a PARAMETER, computed by `observedArrival`
 * before this is called: a view that computed it would be a view that had both
 * columns in one scope.
 */
export function assignmentView(
  row: AssignmentRow,
  head: AssignmentHead,
  observation: ArrivalObservation,
): AssignmentView {
  const withdrawn = head.state === "revoked" || head.state === "paused";
  return {
    assignment_id: row.id,
    skill_id: row.skill_id,
    slug: row.slug,
    skill_version_id: row.skill_version_id,
    semantic_version: row.semantic_version,
    agent_id: row.agent_id,
    recipient_kind: row.recipient_kind,
    transfer_id: row.transfer_id,
    assigned_by: { agent_id: row.assigned_by_agent_id, type: row.assigned_by_type, role: row.assigned_by_role },
    created_at_ms: row.created_at_ms,

    intent_state: head.state,
    intent_state_is: "intent",
    intent_state_source: ASSIGNMENT_INTENT_SOURCE,
    intent_event_seq: head.event_seq,
    intent_at_ms: head.at_ms,
    intent_reason: head.reason,

    observed_arrival: observation.verdict,
    observed_arrival_is: "observation",
    observed_arrival_reason: observation.reason,
    observed_arrival_source: observation.source,
    observed_arrival_window: observation.window,
    observed_records_read: observation.records_read,

    arrival_marker: arrivalMarker(row.skill_version_id),
    has_executable_step: subjectOf(row).has_executable_step,

    activation_target: head.activation_target,
    native_relpath: head.native_relpath,
    managed_copy: head.managed_copy ?? "unknown",
    requires_new_session: withdrawn,
    session_effect: withdrawn ? INSTRUCTIONS_ALREADY_READ : ACTIVATION_SESSION_EFFECT,
  };
}

/**
 * What the arrival assessment is ABOUT, derived from the version rather than
 * guessed: the marker its id yields, and whether the package ships the
 * executable step at all. The second is taken from the manifest through
 * `shipsArrivalScript`, never from what happens to be in a package or on a
 * disk — a version that declares `runtime.shell: ["none"]` can never produce a
 * record, and that structural impossibility is a property of the DECLARATION.
 *
 * An unreadable manifest fails CLOSED, in the direction that produces more
 * checking: it is treated as shipping the step, so the answer becomes "no
 * paired record was found" rather than "this could never be shown".
 */
export function subjectOf(row: { skill_version_id: string; manifest_json: string }): ArrivalSubject {
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(row.manifest_json);
  } catch {
    manifest = null;
  }
  return { marker: arrivalMarker(row.skill_version_id), has_executable_step: shipsArrivalScript(manifest) };
}
