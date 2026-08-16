// ASSIGNMENT AND LIFECYCLE CONTROL — `P3-FR-01` … `P3-FR-16`, `INV-01`,
// `INV-02`, `INV-03`, `INV-06`, `INV-07`.
//
// THE ONE RULE THAT DECIDES THIS FILE: AN OWNER COMMAND WRITES DESIRED STATE
// AND NOTHING ELSE.
//
//   `INV-02` and `P3-FR-06` say observed state changes only on structured
//   backend, adapter or runtime evidence, and that nothing may be marked
//   `loaded`, `invoked` or `worked` as a side effect of an owner action. The way
//   to mean that is for the two to be different tables, written by different
//   functions, with no value in the observation table's `source` column that an
//   owner command could put there. `recordObservation` below is the only writer
//   of `assignment_observations` and it takes an evidence payload, never an
//   `AuthContext` acting as an owner; `appendLifecycleEventInTx` is the only
//   writer of `skill_assignment_events` and it cannot reach the other table.
//
// THE SECOND RULE: THE TRANSITION TABLE IS HERE AND NOWHERE ELSE.
//
//   `P3-FR-16` and `INV-01` forbid the frontend holding a second implementation
//   of the transition rules or of conflict resolution. So the server answers
//   "may this assignment be activated, paused, revoked, rolled back?" as
//   structured fields (`AssignmentActions`), and the console renders those
//   fields. A request that ignores the rendering is refused by the same function
//   that produced it.
import type { Db } from "./sqlite.ts";
import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";
import { correlationDigest } from "./journal.ts";
import { approvedRevisionsOf, type RevisionApproval } from "./draft-decision.ts";

// ---------------------------------------------------------- the state machine

/** The DESIRED lifecycle states. Every one of them is the owner's intent; not
 *  one of them is a report about a runtime (`INV-02`). */
export const DESIRED_STATES = ["assigned", "active", "paused", "revoked"] as const;
export type DesiredState = (typeof DESIRED_STATES)[number];

/**
 * What may follow what — `P3-FR-03`, `P3-FR-04`.
 *
 * `revoked` is terminal. `P3-FR-04` is explicit that a revoked assignment is
 * not silently reactivated: taking it back again is a NEW assignment, which the
 * assign path creates, and an `activate` on a revoked assignment is refused
 * with the state it is still in rather than quietly succeeding.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<DesiredState, readonly DesiredState[]>> = {
  assigned: ["active", "paused", "revoked"],
  active: ["paused", "revoked"],
  paused: ["active", "revoked"],
  revoked: [],
};

/** The owner commands, and the desired state each one asks for. `select_revision`
 *  is absent on purpose: it changes the revision and leaves the state alone. */
export const LIFECYCLE_ACTIONS = ["activate", "pause", "revoke"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export const ACTION_TARGET: Readonly<Record<LifecycleAction, DesiredState>> = {
  activate: "active",
  pause: "paused",
  revoke: "revoked",
};

const ACTION_EVENT: Readonly<Record<LifecycleAction, string>> = {
  activate: "activated",
  pause: "paused",
  revoke: "revoked",
};

export function isLegalLifecycleTransition(from: DesiredState, to: DesiredState): boolean {
  return (LIFECYCLE_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * `INV-07`, as a column with one member.
 *
 * Assignment, update, pause, revoke and rollback apply to the NEXT session. The
 * loadout of a running session is immutable and this registry has no statement
 * that could rewrite one — there is no UPDATE anywhere in this file, and the
 * session/loadout surface P4 builds reads the desired state at session creation
 * rather than being pushed to. The value travels on every event and in every
 * answer so the console can say it (`P3-FR-14`).
 */
export const EFFECTIVE_FROM = "next_session" as const;

/** The one source a desired state may be read from, named in every answer. */
export const DESIRED_STATE_SOURCE = "skill_assignment_events (registry journal, INSERT-only)";

/** The one source an observed state may be read from, named in every answer. */
export const OBSERVED_STATE_SOURCE = "assignment_observations (structured backend/adapter/runtime evidence)";

// ------------------------------------------------------------- desired state

export interface AssignmentRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  draft_id: string;
  created_by_agent_id: string;
  created_by_role: string;
  server_at_ms: number;
}

export interface LifecycleEventRow {
  id: string;
  assignment_id: string;
  event_seq: number;
  event: string;
  desired_state: DesiredState;
  desired_revision_id: string;
  effective_from: string;
  actor_agent_id: string;
  actor_role: string;
  source: string;
  reason_code: string;
  reason: string | null;
  content_digest: string;
  provenance_json: string;
  server_at_ms: number;
}

/** The desired state of one assignment, derived from its journal and from
 *  nowhere else. `entity_version` IS `event_seq` — see `0015`'s header. */
export interface DesiredView {
  state: DesiredState;
  revision_id: string;
  content_digest: string;
  effective_from: typeof EFFECTIVE_FROM;
  entity_version: number;
  event: string;
  reason_code: string;
  reason: string | null;
  decided_at_ms: number;
  source: string;
}

export function loadAssignment(db: Db, id: unknown): AssignmentRow {
  if (typeof id !== "string" || id.length !== 26) {
    throw new ApiError("INVALID_SCHEMA", "assignment_id must be a 26-character id");
  }
  const row = db.prepare("SELECT * FROM skill_assignments WHERE id=?").get(id) as AssignmentRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `no assignment ${id}`);
  return row;
}

export function lifecycleEvents(db: Db, assignmentId: string): LifecycleEventRow[] {
  return db
    .prepare("SELECT * FROM skill_assignment_events WHERE assignment_id=? ORDER BY event_seq ASC")
    .all(assignmentId) as LifecycleEventRow[];
}

export function desiredFrom(events: readonly LifecycleEventRow[]): DesiredView {
  const head = events[events.length - 1];
  if (!head) {
    throw new Error("an assignment with no event is not reachable: the row and its first event are one transaction");
  }
  return {
    state: head.desired_state,
    revision_id: head.desired_revision_id,
    content_digest: head.content_digest,
    effective_from: EFFECTIVE_FROM,
    entity_version: head.event_seq,
    event: head.event,
    reason_code: head.reason_code,
    reason: head.reason,
    decided_at_ms: head.server_at_ms,
    source: DESIRED_STATE_SOURCE,
  };
}

export function desiredOf(db: Db, assignmentId: string): DesiredView {
  return desiredFrom(lifecycleEvents(db, assignmentId));
}

// ------------------------------------------------------------ observed state

/** `INV-03`: an observed status, WITH the reason it is what it is. Every field
 *  below is required of an `unknown` by the invariant, so every field below is
 *  required of every observation — a shape that is complete only sometimes is a
 *  shape a reader has to test before using. */
export interface ObservedView {
  status: "proposed" | "loaded" | "invoked" | "unknown";
  reason_code: string;
  reason: string;
  source: string;
  observed_at_ms: number | null;
  /** the identifiers relating to the observation, when they are known */
  revision_id: string | null;
  session_ref: string | null;
  agent_id: string | null;
  observation_id: string | null;
}

/**
 * THE ANSWER WHEN NOBODY HAS REPORTED ANYTHING.
 *
 * It is `unknown`, with a reason code, a readable reason and a source naming
 * the boundary the search was made over — never `proposed`, never a blank, and
 * never a silent success (`INV-03`). It is computed here rather than stored,
 * because a stored "nothing has been seen" would have to be written by
 * somebody, and the only honest writer of it is the reader.
 */
export function noObservation(agentId: string): ObservedView {
  return {
    status: "unknown",
    reason_code: "NO_OBSERVATION",
    reason:
      "no adapter or runtime has reported an observation for this assignment: " +
      "the registry has looked at every row of assignment_observations for it and found none",
    source: OBSERVED_STATE_SOURCE,
    observed_at_ms: null,
    revision_id: null,
    session_ref: null,
    agent_id: agentId,
    observation_id: null,
  };
}

interface ObservationRow {
  id: string;
  assignment_id: string;
  agent_id: string;
  observed_status: ObservedView["status"];
  draft_revision_id: string | null;
  session_ref: string | null;
  reason_code: string;
  reason: string;
  source: string;
  reported_by_agent_id: string;
  observed_at_ms: number;
  provenance_json: string;
  server_at_ms: number;
}

function observedFrom(row: ObservationRow): ObservedView {
  return {
    status: row.observed_status,
    reason_code: row.reason_code,
    reason: row.reason,
    source: row.source,
    observed_at_ms: row.observed_at_ms,
    revision_id: row.draft_revision_id,
    session_ref: row.session_ref,
    agent_id: row.agent_id,
    observation_id: row.id,
  };
}

/** The latest observation of an assignment, or the honest absence of one. */
export function observedOf(db: Db, assignment: AssignmentRow): ObservedView {
  const row = db
    .prepare(
      "SELECT * FROM assignment_observations WHERE assignment_id=? ORDER BY observed_at_ms DESC, id DESC LIMIT 1",
    )
    .get(assignment.id) as ObservationRow | undefined;
  return row ? observedFrom(row) : noObservation(assignment.agent_id);
}

export function observationsOf(db: Db, assignmentId: string): ObservedView[] {
  const rows = db
    .prepare("SELECT * FROM assignment_observations WHERE assignment_id=? ORDER BY observed_at_ms ASC, id ASC")
    .all(assignmentId) as ObservationRow[];
  return rows.map(observedFrom);
}

/** The evidence an observation is made of. There is no `owner` member of
 *  `source`, in this type and in the CHECK on the column (`INV-02`). */
export interface ObservationEvidence {
  status: ObservedView["status"];
  reason_code: string;
  reason: string;
  source: "backend" | "adapter" | "runtime";
  observed_at_ms: number;
  revision_id?: string | null;
  session_ref?: string | null;
  provenance: Record<string, unknown>;
}

const OBSERVED_STATUSES = ["proposed", "loaded", "invoked", "unknown"] as const;
const OBSERVATION_SOURCES = ["backend", "adapter", "runtime"] as const;

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ApiError("INVALID_SCHEMA", `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < 1) throw new ApiError("INVALID_SCHEMA", `${field} must not be blank`);
  if (trimmed.length > max) throw new ApiError("LIMIT_EXCEEDED", `${field} exceeds ${max} characters`);
  return trimmed;
}

/**
 * `INV-03` as a validator: an observation this registry will not accept without
 * a machine-readable reason code, a readable reason, a source and a time.
 *
 * The `unknown` case is not special-cased, and that is the point. A shape whose
 * completeness depends on the value in one of its fields is a shape somebody
 * fills in halfway; requiring all four of every observation is how "unknown is
 * a full state" stops being a sentence in a document.
 */
export function validateObservation(input: unknown, nowMs: number): ObservationEvidence {
  if (input === null || typeof input !== "object") {
    throw new ApiError("INVALID_SCHEMA", "an observation must be an object");
  }
  const o = input as Record<string, unknown>;
  const status = o.observed_status;
  if (typeof status !== "string" || !(OBSERVED_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError("INVALID_SCHEMA", `observed_status must be one of ${OBSERVED_STATUSES.join("|")}`);
  }
  const source = o.source;
  if (typeof source !== "string" || !(OBSERVATION_SOURCES as readonly string[]).includes(source)) {
    throw new ApiError(
      "INVALID_SCHEMA",
      `source must be one of ${OBSERVATION_SOURCES.join("|")}: an owner command is not evidence (INV-02)`,
    );
  }
  const observedAt = o.observed_at_ms ?? nowMs;
  if (!Number.isInteger(observedAt) || (observedAt as number) <= 0) {
    throw new ApiError("INVALID_SCHEMA", "observed_at_ms must be a positive integer");
  }
  const revisionId = o.revision_id === undefined || o.revision_id === null ? null : o.revision_id;
  if (revisionId !== null && (typeof revisionId !== "string" || revisionId.length !== 26)) {
    throw new ApiError("INVALID_SCHEMA", "revision_id must be a 26-character id when it is given");
  }
  const sessionRef = o.session_ref === undefined || o.session_ref === null ? null : boundedText(o.session_ref, "session_ref", 200);
  const provenance = o.provenance;
  if (provenance === undefined || provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new ApiError("INVALID_SCHEMA", "provenance must be an object: an observation with no provenance is a claim");
  }
  return {
    status: status as ObservedView["status"],
    reason_code: boundedText(o.reason_code, "reason_code", 64),
    reason: boundedText(o.reason, "reason", 2000),
    source: source as ObservationEvidence["source"],
    observed_at_ms: observedAt as number,
    revision_id: revisionId as string | null,
    session_ref: sessionRef,
    provenance: provenance as Record<string, unknown>,
  };
}

/**
 * The only writer of `assignment_observations`.
 *
 * It takes EVIDENCE, and the reporter is the authenticated agent that filed it.
 * There is no path from an owner lifecycle command to this function: the
 * lifecycle writer below does not call it, the service method that does is a
 * different method on a different route, and the column's CHECK has no `owner`
 * member. That is `P3-FR-06` enforced in three places rather than asserted in
 * one comment.
 */
export function recordObservation(
  db: Db,
  assignment: AssignmentRow,
  reportedByAgentId: string,
  evidence: ObservationEvidence,
  nowMs: number,
): ObservedView {
  const id = ulid(nowMs);
  db.prepare(
    `INSERT INTO assignment_observations(
       id, assignment_id, agent_id, observed_status, draft_revision_id, session_ref,
       reason_code, reason, source, reported_by_agent_id, observed_at_ms, provenance_json, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    assignment.id,
    assignment.agent_id,
    evidence.status,
    evidence.revision_id ?? null,
    evidence.session_ref ?? null,
    evidence.reason_code,
    evidence.reason,
    evidence.source,
    reportedByAgentId,
    evidence.observed_at_ms,
    JSON.stringify({ ...evidence.provenance, recorded_by: OBSERVED_STATE_SOURCE }),
    nowMs,
  );
  const row = db.prepare("SELECT * FROM assignment_observations WHERE id=?").get(id) as ObservationRow;
  return observedFrom(row);
}

// -------------------------------------------------------------- eligibility

/** `P3-FR-01`, as a value: whether this revision may be assigned to this agent,
 *  with a machine-readable reason when it may not. */
export interface AssignmentEligibility {
  assignable: boolean;
  reason_code:
    | "ASSIGNABLE"
    | "REVISION_NOT_APPROVED"
    | "AGENT_NOT_IN_FLEET"
    | "AGENT_NOT_ACTIVE"
    | "ALREADY_ASSIGNED";
  agent_id: string;
  draft_id: string | null;
  revision_id: string;
}

export interface FleetAgent {
  agent_id: string;
  name: string;
  type: string;
  status: string;
}

/**
 * THE CLOSED FLEET, and what makes it closed.
 *
 * The target agents are the ACTIVE agents of the caller's own workspace. There
 * is no cross-workspace target, no invitation and no external agent — contract
 * section 4.2 puts federation and external agents out of V1, and the way to
 * mean that is for the query to have no parameter that could name one.
 */
export function fleetAgents(db: Db, auth: AuthContext): FleetAgent[] {
  const rows = db
    .prepare(
      "SELECT id AS agent_id, name, type, status FROM agents WHERE workspace_id=? AND status='active' ORDER BY name ASC",
    )
    .all(auth.workspace_id) as FleetAgent[];
  return rows;
}

function agentInFleet(db: Db, auth: AuthContext, agentId: string): { found: boolean; active: boolean } {
  const row = db.prepare("SELECT status FROM agents WHERE id=? AND workspace_id=?").get(agentId, auth.workspace_id) as
    | { status: string }
    | undefined;
  if (!row) return { found: false, active: false };
  return { found: true, active: row.status === "active" };
}

/** The live (non-revoked) assignment of one lineage at one agent, or null. */
export function liveAssignment(db: Db, agentId: string, draftId: string): AssignmentRow | null {
  const rows = db
    .prepare("SELECT * FROM skill_assignments WHERE agent_id=? AND draft_id=?")
    .all(agentId, draftId) as AssignmentRow[];
  for (const row of rows) {
    if (desiredOf(db, row.id).state !== "revoked") return row;
  }
  return null;
}

/**
 * `P3-FR-01`: only an APPROVED revision, only to an EXISTING agent of the
 * closed fleet. The order of the tests is part of the rule and is the order a
 * reader would ask them in — is the target real, is it usable, is the thing
 * being assigned approved, is it already there.
 */
export function assignmentEligibility(
  db: Db,
  auth: AuthContext,
  agentId: string,
  approval: RevisionApproval | null,
  revisionId: string,
  draftId: string | null,
): AssignmentEligibility {
  const base = { agent_id: agentId, draft_id: draftId, revision_id: revisionId };
  const fleet = agentInFleet(db, auth, agentId);
  if (!fleet.found) return { assignable: false, reason_code: "AGENT_NOT_IN_FLEET", ...base };
  if (!fleet.active) return { assignable: false, reason_code: "AGENT_NOT_ACTIVE", ...base };
  if (!approval) return { assignable: false, reason_code: "REVISION_NOT_APPROVED", ...base };
  if (liveAssignment(db, agentId, approval.draft_id)) {
    return { assignable: false, reason_code: "ALREADY_ASSIGNED", ...base, draft_id: approval.draft_id };
  }
  return { assignable: true, reason_code: "ASSIGNABLE", ...base, draft_id: approval.draft_id };
}

/** One lifecycle action, and whether the SERVER will carry it out. The console
 *  renders these; it does not compute them (`P3-FR-16`). */
export interface ActionVerdict {
  allowed: boolean;
  reason_code: string;
}

export interface AssignmentActions {
  activate: ActionVerdict;
  pause: ActionVerdict;
  revoke: ActionVerdict;
  select_revision: ActionVerdict;
}

export function assignmentActions(desired: DesiredView, approvedCount: number): AssignmentActions {
  const verdict = (action: LifecycleAction): ActionVerdict =>
    desired.state === ACTION_TARGET[action]
      ? { allowed: true, reason_code: "ALREADY_IN_STATE" }
      : isLegalLifecycleTransition(desired.state, ACTION_TARGET[action])
        ? { allowed: true, reason_code: "TRANSITION_ALLOWED" }
        : { allowed: false, reason_code: `ILLEGAL_TRANSITION_FROM_${desired.state.toUpperCase()}` };
  return {
    activate: verdict("activate"),
    pause: verdict("pause"),
    revoke: verdict("revoke"),
    select_revision:
      desired.state === "revoked"
        ? { allowed: false, reason_code: "ILLEGAL_TRANSITION_FROM_REVOKED" }
        : approvedCount > 1
          ? { allowed: true, reason_code: "SELECTABLE" }
          : { allowed: false, reason_code: "NO_OTHER_APPROVED_REVISION" },
  };
}

// ------------------------------------------------------------------ the view

export interface AssignmentDetail {
  assignment_id: string;
  agent_id: string;
  draft_id: string;
  workspace_id: string;
  /** `P3-FR-07`: the two are separate fields of separate shapes, computed by
   *  separate functions over separate tables. Neither is derived from the
   *  other, and there is no combined "status" field for a reader to mistake for
   *  either of them. */
  desired: DesiredView;
  observed: ObservedView;
  actions: AssignmentActions;
  /** every approved revision of this lineage, oldest first — the rollback
   *  targets, as a list the console renders (`P3-FR-05`) */
  approved_revisions: RevisionApproval[];
  entity_version: number;
  created_at_ms: number;
}

export function assignmentDetail(db: Db, assignment: AssignmentRow): AssignmentDetail {
  const desired = desiredFrom(lifecycleEvents(db, assignment.id));
  const approved = approvedRevisionsOf(db, assignment.draft_id);
  return {
    assignment_id: assignment.id,
    agent_id: assignment.agent_id,
    draft_id: assignment.draft_id,
    workspace_id: assignment.workspace_id,
    desired,
    observed: observedOf(db, assignment),
    actions: assignmentActions(desired, approved.length),
    approved_revisions: approved,
    entity_version: desired.entity_version,
    created_at_ms: assignment.server_at_ms,
  };
}

export function assignmentsOfWorkspace(db: Db, workspaceId: string): AssignmentRow[] {
  return db
    .prepare("SELECT * FROM skill_assignments WHERE workspace_id=? ORDER BY server_at_ms ASC, id ASC")
    .all(workspaceId) as AssignmentRow[];
}

// ---------------------------------------------------------------- the writes

/** The precondition a caller may state, and the answer when it does not hold.
 *  `P3-FR-11`: a stale version is `412` with the state the caller must converge
 *  on, which is the shape `src/errors.ts` already requires of the code. */
export function requireVersion(desired: DesiredView, expected: unknown, assignmentId: string): void {
  if (expected === undefined || expected === null) return;
  if (!Number.isInteger(expected)) {
    throw new ApiError("INVALID_SCHEMA", "if_version must be an integer");
  }
  if (expected !== desired.entity_version) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      `assignment ${assignmentId} is at version ${desired.entity_version}, not ${expected}; refetch and retry`,
      desired.state,
    );
  }
}

function insertEvent(
  db: Db,
  assignmentId: string,
  seq: number,
  event: string,
  desiredState: DesiredState,
  revisionId: string,
  contentDigest: string,
  auth: AuthContext,
  reasonCode: string,
  reason: string | null,
  provenance: Record<string, unknown>,
  nowMs: number,
): LifecycleEventRow {
  const id = ulid(nowMs);
  db.prepare(
    `INSERT INTO skill_assignment_events(
       id, assignment_id, event_seq, event, desired_state, desired_revision_id, effective_from,
       actor_agent_id, actor_role, source, reason_code, reason, content_digest, provenance_json, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    assignmentId,
    seq,
    event,
    desiredState,
    revisionId,
    EFFECTIVE_FROM,
    auth.agent_id,
    auth.role === "admin" ? "admin" : "owner",
    "owner",
    reasonCode,
    reason,
    contentDigest,
    JSON.stringify({ ...provenance, effective_from: EFFECTIVE_FROM, desired_state_source: DESIRED_STATE_SOURCE }),
    nowMs,
  );
  return db.prepare("SELECT * FROM skill_assignment_events WHERE id=?").get(id) as LifecycleEventRow;
}

export interface AssignmentResponse {
  assignment: AssignmentDetail;
  /** `P3-FR-14`: the answer says, in a field, that the change is for the next
   *  session. The console renders the field; it does not know the sentence. */
  effective_from: typeof EFFECTIVE_FROM;
  event_id: string;
}

/**
 * `P3-FR-02`: assign creates the canonical desired assignment, in the backend.
 *
 * The row and its first event are ONE transaction — the caller's — for the
 * reason `src/assignments.ts` gives about its own pair: an assignment with no
 * event has no state, and a state that has to be defaulted somewhere is a state
 * two readers can default differently.
 */
export function createAssignmentInTx(
  db: Db,
  auth: AuthContext,
  agentId: string,
  approval: RevisionApproval,
  reason: string | null,
  nowMs: number,
): AssignmentResponse {
  const id = ulid(nowMs);
  db.prepare(
    `INSERT INTO skill_assignments(id, workspace_id, agent_id, draft_id, created_by_agent_id, created_by_role, server_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, auth.workspace_id, agentId, approval.draft_id, auth.agent_id, auth.role === "admin" ? "admin" : "owner", nowMs);
  const event = insertEvent(
    db,
    id,
    1,
    "assigned",
    "assigned",
    approval.draft_revision_id,
    approval.content_digest,
    auth,
    "OWNER_ASSIGNED",
    reason,
    { revision: approval.revision, approval_id: approval.approval_id },
    nowMs,
  );
  const row = db.prepare("SELECT * FROM skill_assignments WHERE id=?").get(id) as AssignmentRow;
  return { assignment: assignmentDetail(db, row), effective_from: EFFECTIVE_FROM, event_id: event.id };
}

/**
 * `P3-FR-03`, `P3-FR-04`: activate, pause and revoke, against the transition
 * table above.
 *
 * A request for the state the assignment is ALREADY in is a convergent noop —
 * it appends no event and answers the current state, which is the
 * converging-conflict rule `src/transitions.ts` established for versions and
 * the reason a retried command is not an error. An ILLEGAL transition is `412`
 * with `current_state`, so a console that got there from a stale render
 * refetches rather than guessing (`P3-FR-12`).
 */
export function applyLifecycleActionInTx(
  db: Db,
  auth: AuthContext,
  assignment: AssignmentRow,
  action: LifecycleAction,
  reason: string | null,
  ifVersion: unknown,
  nowMs: number,
): AssignmentResponse {
  const events = lifecycleEvents(db, assignment.id);
  const desired = desiredFrom(events);
  requireVersion(desired, ifVersion, assignment.id);
  const target = ACTION_TARGET[action];
  if (desired.state === target) {
    return {
      assignment: assignmentDetail(db, assignment),
      effective_from: EFFECTIVE_FROM,
      event_id: events[events.length - 1]!.id,
    };
  }
  if (!isLegalLifecycleTransition(desired.state, target)) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      `assignment ${assignment.id} is ${desired.state}; ${action} is not a transition this lifecycle allows` +
        (desired.state === "revoked"
          ? " — a revoked assignment is not silently reactivated, and taking it back is a new assignment"
          : ""),
      desired.state,
    );
  }
  const event = insertEvent(
    db,
    assignment.id,
    desired.entity_version + 1,
    ACTION_EVENT[action]!,
    target,
    desired.revision_id,
    desired.content_digest,
    auth,
    `OWNER_${target.toUpperCase()}`,
    reason,
    { from_state: desired.state, to_state: target, action },
    nowMs,
  );
  const row = db.prepare("SELECT * FROM skill_assignments WHERE id=?").get(assignment.id) as AssignmentRow;
  return { assignment: assignmentDetail(db, row), effective_from: EFFECTIVE_FROM, event_id: event.id };
}

/**
 * `P3-FR-05` and `INV-06`: revision selection, which is also rollback.
 *
 * Forward and backward are the same operation and there is deliberately no
 * second one: selecting revision 1 when revision 2 is in force is a rollback,
 * selecting revision 2 when revision 1 is in force is an update, and both are
 * "the owner chose a previously approved revision for the next session". The
 * target must be APPROVED — the eligible set is `approvedRevisionsOf` — and
 * NOTHING IS DELETED: the newer revision keeps its row, keeps its approval and
 * keeps its place in the lineage, and the journal keeps every selection that
 * came before. What changes is which revision the next session gets.
 */
export function selectRevisionInTx(
  db: Db,
  auth: AuthContext,
  assignment: AssignmentRow,
  revisionId: unknown,
  reason: string | null,
  ifVersion: unknown,
  nowMs: number,
): AssignmentResponse {
  const desired = desiredOf(db, assignment.id);
  requireVersion(desired, ifVersion, assignment.id);
  if (desired.state === "revoked") {
    throw new ApiError(
      "PRECONDITION_FAILED",
      `assignment ${assignment.id} is revoked; a revoked assignment takes no revision selection`,
      desired.state,
    );
  }
  if (typeof revisionId !== "string" || revisionId.length !== 26) {
    throw new ApiError("INVALID_SCHEMA", "revision_id must be a 26-character id");
  }
  const approved = approvedRevisionsOf(db, assignment.draft_id);
  const target = approved.find((a) => a.draft_revision_id === revisionId);
  if (!target) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      `revision ${revisionId} is not an approved revision of draft ${assignment.draft_id}`,
      desired.state,
    );
  }
  if (target.draft_revision_id === desired.revision_id) {
    return { assignment: assignmentDetail(db, assignment), effective_from: EFFECTIVE_FROM, event_id: "" };
  }
  const direction = target.revision < revisionNumberOf(approved, desired.revision_id) ? "rollback" : "update";
  const event = insertEvent(
    db,
    assignment.id,
    desired.entity_version + 1,
    "revision_selected",
    desired.state,
    target.draft_revision_id,
    target.content_digest,
    auth,
    direction === "rollback" ? "OWNER_ROLLED_BACK" : "OWNER_SELECTED_REVISION",
    reason,
    {
      direction,
      from_revision_id: desired.revision_id,
      to_revision_id: target.draft_revision_id,
      to_revision: target.revision,
      approval_id: target.approval_id,
    },
    nowMs,
  );
  const row = db.prepare("SELECT * FROM skill_assignments WHERE id=?").get(assignment.id) as AssignmentRow;
  return { assignment: assignmentDetail(db, row), effective_from: EFFECTIVE_FROM, event_id: event.id };
}

function revisionNumberOf(approved: readonly RevisionApproval[], revisionId: string): number {
  return approved.find((a) => a.draft_revision_id === revisionId)?.revision ?? 0;
}

// ------------------------------------------------------- idempotency payload

/**
 * `P3-FR-09` and `P3-FR-10`, which are two halves of one comparison.
 *
 * The released `withIdempotency` keys a replay on (actor, surface, key) and
 * stores the response. That answers the first half — a repeat with the same key
 * replays and writes nothing — and cannot answer the second, because the row
 * does not remember what the FIRST call was asked to do. So the request is
 * fingerprinted: `correlationDigest` over the canonical form of the payload
 * fields that decide the operation, stored beside the key, compared on the
 * repeat. A digest rather than the payload for the reason
 * `DIGESTED_KEY_SURFACES` gives about the key itself — equality survives a hash
 * exactly, and a caller's text does not become durable registry data.
 */
export function requestDigest(payload: Record<string, unknown>): string {
  const canonical = Object.keys(payload)
    .filter((k) => k !== "idempotency_key" && payload[k] !== undefined)
    .sort()
    .map((k) => [k, payload[k]] as const);
  return correlationDigest(JSON.stringify(canonical));
}
