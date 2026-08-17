// V1 P4 — THE CANONICAL SESSION AND LOADOUT SERVICE.
//
// One session of one agent gets ONE snapshot of what that agent was desired to
// be carrying at the moment the session opened, and that snapshot never changes
// again. Everything a runtime later confirms is measured against it.
//
// WHY A SESSION IS OPENED BY THE ADAPTER AND NOT BY THE OWNER.
//
// `P4-FR-09` says `proposed` appears once the loadout is built. `proposed` is
// OBSERVED state — it lives in `assignment_observations`, the table `INV-02`
// says an owner command may never write into. If a console route could open a
// session, an owner click would produce observed state, and the split P3 spent
// a phase enforcing would have a hole in it one phase later. So the session
// intake is mounted on the machine-to-machine surface behind the SAME evidence
// principal that P3 requires for an observation (`src/evidence-principal.ts`):
// a credential the DEPLOYMENT registered as a reporter, never the owner's.
//
// The owner keeps a READ of it — `GET /v1/console/sessions/{id}` — because
// seeing what a session was given is not the same act as claiming it was given.
//
// WHAT IS CANONICAL HERE AND WHAT IS A PROJECTION (`INV-01`).
//
// This module and the tables of `0016` are canonical. The native files an
// adapter writes are projections: `src/runtime-adapter.ts` renders them FROM
// these rows and can rebuild every one of them from these rows, and deleting
// all of them destroys nothing this module can no longer answer (`P4-FR-08`).
import { createHash } from "node:crypto";
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";
import { jcsCanonicalize, type JcsValue } from "./jcs.ts";
import { approvalOfRevision } from "./draft-decision.ts";
import {
  desiredOf,
  loadAssignment,
  recordObservation,
  type AssignmentRow,
  type ObservedView,
} from "./assignment-lifecycle.ts";
import type { EvidenceSource } from "./evidence-principal.ts";

// ------------------------------------------------------------------ runtimes

/** The two runtimes V1 supports, and the only two. Contract section 8.10: two
 *  thin adapters, not a plugin system — a third is a member here, a row in
 *  `RUNTIMES` in `src/runtime-adapter.ts`, and a member of the CHECK in `0016`. */
export const RUNTIME_KINDS = ["codex", "claude_code"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(v: unknown): v is RuntimeKind {
  return typeof v === "string" && (RUNTIME_KINDS as readonly string[]).includes(v);
}

/**
 * The version of the ADAPTER CONTRACT, not of the package.
 *
 * `P4-FR-02` requires the snapshot to record it, and the reason it is its own
 * number is that a loadout built by an older adapter and read by a newer one has
 * to be legible as such. It changes when the rendered native artifact or the
 * receipt shape changes — that is, when a receipt written by one version would
 * mean something different read by another.
 */
export const ADAPTER_VERSION = "skln-adapter/1";

/** `INV-05`: the versioned marker every answer of the machine-to-machine session
 *  surface carries, so a client checks the contract before it reads a field. */
export const SESSION_CONTRACT_VERSION = "session.v1";

// -------------------------------------------------------------- stage vocabulary

/**
 * The chain of contract section P4's goal, in order. `registered` and `assigned`
 * are P1/P3 facts about DESIRED state; the four this phase owns are OBSERVED.
 */
export const LOADOUT_STAGES = ["proposed", "loaded", "invoked"] as const;
export type LoadoutStage = (typeof LOADOUT_STAGES)[number];

/** The stages a RECEIPT may confirm. `proposed` is not one of them: it is what
 *  the backend saw itself do, and no runtime is asked to confirm it. */
export const RECEIPT_STAGES = ["loaded", "invoked"] as const;
export type ReceiptStage = (typeof RECEIPT_STAGES)[number];

export function isReceiptStage(v: unknown): v is ReceiptStage {
  return typeof v === "string" && (RECEIPT_STAGES as readonly string[]).includes(v);
}

// ------------------------------------------------------------------- the name
//
// THE NATIVE NAME IS DERIVED, NEVER TAKEN.
//
// A skill's directory name is a path component in somebody's home directory, and
// the title it comes from is prose an owner wrote. `P4-FR-14` is met FIRST here,
// at the place a name is decided, and again in `src/activation.ts` at the place
// a name becomes a path — the second check is not redundant, it is the one that
// still holds if a future caller invents a name some other way.

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The native directory name of one lineage: a slug of its title, suffixed with
 * the tail of its draft id.
 *
 * The suffix is not decoration. Two lineages may legitimately be called "Ship
 * the thing", and two entries of one loadout may not occupy one directory —
 * `UNIQUE(loadout_id, skill_name)` in `0016` refuses that in the database. The
 * suffix makes the collision impossible instead of making it an error the owner
 * has to resolve by renaming a skill.
 */
export function nativeSkillName(title: string, draftId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const suffix = draftId.slice(-8).toLowerCase();
  const name = slug.length > 0 ? `${slug}-${suffix}` : `skill-${suffix}`;
  if (!SAFE_NAME.test(name)) {
    // Unreachable through the slug above, and checked anyway: this function's
    // output is a path component, and "unreachable" is a claim about today's
    // callers rather than about the filesystem.
    throw new ApiError("INVALID_SCHEMA", "a native skill name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

// --------------------------------------------------------------------- rows

export interface SessionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  runtime_kind: RuntimeKind;
  runtime_version: string;
  adapter_version: string;
  opened_by_agent_id: string;
  opened_by_source: EvidenceSource;
  server_at_ms: number;
}

export interface LoadoutRow {
  id: string;
  session_id: string;
  workspace_id: string;
  agent_id: string;
  runtime_kind: RuntimeKind;
  runtime_version: string;
  adapter_version: string;
  entry_count: number;
  loadout_digest: string;
  provenance_json: string;
  created_at_ms: number;
  server_at_ms: number;
}

export interface LoadoutEntryRow {
  id: string;
  loadout_id: string;
  position: number;
  assignment_id: string;
  draft_id: string;
  draft_revision_id: string;
  revision: number;
  skill_name: string;
  content_digest: string;
  server_at_ms: number;
}

export interface ReceiptRow {
  id: string;
  session_id: string;
  loadout_id: string;
  loadout_entry_id: string;
  assignment_id: string;
  draft_revision_id: string;
  content_digest: string;
  stage: ReceiptStage;
  runtime_session_ref: string;
  invocation_ref: string | null;
  reported_by_agent_id: string;
  source: EvidenceSource;
  receipt_digest: string;
  payload_json: string;
  observed_at_ms: number;
  server_at_ms: number;
}

export function loadSession(db: Db, id: unknown): SessionRow {
  if (typeof id !== "string" || id.length !== 26) {
    throw new ApiError("NOT_FOUND", "no such session");
  }
  const row = db.prepare("SELECT * FROM agent_sessions WHERE id=?").get(id) as SessionRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `no session ${id}`);
  return row;
}

export function loadoutOfSession(db: Db, sessionId: string): LoadoutRow {
  const row = db.prepare("SELECT * FROM session_loadouts WHERE session_id=?").get(sessionId) as LoadoutRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `session ${sessionId} has no loadout`);
  return row;
}

export function loadoutEntries(db: Db, loadoutId: string): LoadoutEntryRow[] {
  return db
    .prepare("SELECT * FROM session_loadout_entries WHERE loadout_id=? ORDER BY position")
    .all(loadoutId) as LoadoutEntryRow[];
}

export function receiptsOfSession(db: Db, sessionId: string): ReceiptRow[] {
  return db
    .prepare("SELECT * FROM runtime_receipts WHERE session_id=? ORDER BY observed_at_ms, id")
    .all(sessionId) as ReceiptRow[];
}

export function receiptsOfEntry(db: Db, entryId: string, stage: ReceiptStage): ReceiptRow[] {
  return db
    .prepare("SELECT * FROM runtime_receipts WHERE loadout_entry_id=? AND stage=? ORDER BY observed_at_ms, id")
    .all(entryId, stage) as ReceiptRow[];
}

// ------------------------------------------------------------- what goes in

/** One candidate for a loadout, and the verdict on it. A candidate that is NOT
 *  included says why, in a machine-readable code — an exclusion nobody can read
 *  is indistinguishable from a skill that was never assigned. */
export interface LoadoutCandidate {
  assignment_id: string;
  draft_id: string;
  desired_state: string;
  included: boolean;
  reason_code:
    | "ACTIVE_APPROVED"
    | "NOT_ACTIVE"
    | "REVISION_NOT_APPROVED"
    | "REVISION_MISSING";
  draft_revision_id: string | null;
}

interface RevisionRow {
  id: string;
  draft_id: string;
  revision: number;
  content_json: string;
  content_digest: string;
}

function revisionRow(db: Db, revisionId: string): RevisionRow | undefined {
  return db
    .prepare("SELECT id, draft_id, revision, content_json, content_digest FROM draft_revisions WHERE id=?")
    .get(revisionId) as RevisionRow | undefined;
}

/**
 * `P4-FR-01` and `P4-FR-04`, as a value rather than as a side effect.
 *
 * Only the ACTIVE desired assignments of this agent go in. `assigned` (never
 * activated), `paused` and `revoked` do not, and neither does an active
 * assignment whose desired revision is not approved — which P3's transition
 * rules already make unreachable, and which is re-checked here because
 * "unreachable" is a statement about the other module.
 *
 * The verdict list is returned WHOLE, including the exclusions, because it is
 * what the provenance of the loadout records: a snapshot that says only what it
 * contains cannot answer why it does not contain something.
 */
export function loadoutCandidates(db: Db, agentId: string, workspaceId: string): LoadoutCandidate[] {
  const assignments = db
    .prepare("SELECT * FROM skill_assignments WHERE agent_id=? AND workspace_id=? ORDER BY server_at_ms, id")
    .all(agentId, workspaceId) as AssignmentRow[];
  return assignments.map((a) => {
    const desired = desiredOf(db, a.id);
    if (desired.state !== "active") {
      return {
        assignment_id: a.id,
        draft_id: a.draft_id,
        desired_state: desired.state,
        included: false,
        reason_code: "NOT_ACTIVE" as const,
        draft_revision_id: desired.revision_id,
      };
    }
    const revision = revisionRow(db, desired.revision_id);
    if (!revision) {
      return {
        assignment_id: a.id,
        draft_id: a.draft_id,
        desired_state: desired.state,
        included: false,
        reason_code: "REVISION_MISSING" as const,
        draft_revision_id: desired.revision_id,
      };
    }
    if (approvalOfRevision(db, desired.revision_id) === null) {
      return {
        assignment_id: a.id,
        draft_id: a.draft_id,
        desired_state: desired.state,
        included: false,
        reason_code: "REVISION_NOT_APPROVED" as const,
        draft_revision_id: desired.revision_id,
      };
    }
    return {
      assignment_id: a.id,
      draft_id: a.draft_id,
      desired_state: desired.state,
      included: true,
      reason_code: "ACTIVE_APPROVED" as const,
      draft_revision_id: desired.revision_id,
    };
  });
}

// ---------------------------------------------------------------- the build

export interface OpenSessionInput {
  agent_id: string;
  runtime_kind: RuntimeKind;
  runtime_version: string;
  /** the agent id of the registered evidence principal that opened it */
  opened_by_agent_id: string;
  opened_by_source: EvidenceSource;
  workspace_id: string;
}

export interface LoadoutEntryView {
  entry_id: string;
  position: number;
  assignment_id: string;
  draft_id: string;
  draft_revision_id: string;
  revision: number;
  skill_name: string;
  content_digest: string;
}

export interface LoadoutView {
  loadout_id: string;
  session_id: string;
  agent_id: string;
  runtime_kind: RuntimeKind;
  runtime_version: string;
  adapter_version: string;
  entry_count: number;
  loadout_digest: string;
  created_at_ms: number;
  entries: LoadoutEntryView[];
  excluded: LoadoutCandidate[];
}

/** The bytes the loadout digest is taken over: everything `P4-FR-02` names,
 *  in JCS order, and nothing that varies between two identical snapshots. */
function loadoutDigestOf(fields: {
  session_id: string;
  agent_id: string;
  runtime_kind: string;
  runtime_version: string;
  adapter_version: string;
  created_at_ms: number;
  entries: ReadonlyArray<{
    position: number;
    assignment_id: string;
    draft_id: string;
    draft_revision_id: string;
    revision: number;
    skill_name: string;
    content_digest: string;
  }>;
}): string {
  return `sha256:${createHash("sha256").update(jcsCanonicalize(fields as unknown as JcsValue), "utf8").digest("hex")}`;
}

/** The title a lineage's revision compiled to — the source of its native name. */
function titleOf(revision: RevisionRow): string {
  try {
    const parsed = JSON.parse(revision.content_json) as { title?: unknown };
    return typeof parsed.title === "string" ? parsed.title : "";
  } catch {
    return "";
  }
}

/**
 * OPEN A SESSION AND FREEZE ITS LOADOUT. One transaction, one snapshot.
 *
 * `P4-FR-09`: every included entry gets a `proposed` observation here, written
 * from the backend's own knowledge of what it just built and carrying the
 * loadout id, the session id, the revision and the digest. Nothing further is
 * written until a receipt arrives — `loaded` and `invoked` have exactly one
 * writer each and it is `confirmFromReceiptInTx` below.
 */
export function openSessionInTx(db: Db, input: OpenSessionInput, nowMs: number): LoadoutView {
  const sessionId = ulid(nowMs);
  db.prepare(
    `INSERT INTO agent_sessions(id, workspace_id, agent_id, runtime_kind, runtime_version,
       adapter_version, opened_by_agent_id, opened_by_source, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    sessionId,
    input.workspace_id,
    input.agent_id,
    input.runtime_kind,
    input.runtime_version,
    ADAPTER_VERSION,
    input.opened_by_agent_id,
    input.opened_by_source,
    nowMs,
  );

  const candidates = loadoutCandidates(db, input.agent_id, input.workspace_id);
  const included = candidates.filter((c) => c.included);

  const prepared = included.map((c, i) => {
    const revision = revisionRow(db, c.draft_revision_id as string) as RevisionRow;
    return {
      position: i + 1,
      assignment_id: c.assignment_id,
      draft_id: c.draft_id,
      draft_revision_id: revision.id,
      revision: revision.revision,
      skill_name: nativeSkillName(titleOf(revision), c.draft_id),
      content_digest: revision.content_digest,
    };
  });

  const loadoutId = ulid(nowMs);
  const digest = loadoutDigestOf({
    session_id: sessionId,
    agent_id: input.agent_id,
    runtime_kind: input.runtime_kind,
    runtime_version: input.runtime_version,
    adapter_version: ADAPTER_VERSION,
    created_at_ms: nowMs,
    entries: prepared,
  });

  db.prepare(
    `INSERT INTO session_loadouts(id, session_id, workspace_id, agent_id, runtime_kind, runtime_version,
       adapter_version, entry_count, loadout_digest, provenance_json, created_at_ms, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    loadoutId,
    sessionId,
    input.workspace_id,
    input.agent_id,
    input.runtime_kind,
    input.runtime_version,
    ADAPTER_VERSION,
    prepared.length,
    digest,
    JSON.stringify({
      built_by: "session-loadout service",
      opened_by_agent_id: input.opened_by_agent_id,
      opened_by_source: input.opened_by_source,
      candidates,
    }),
    nowMs,
    nowMs,
  );

  const entries: LoadoutEntryView[] = [];
  for (const p of prepared) {
    const entryId = ulid(nowMs);
    db.prepare(
      `INSERT INTO session_loadout_entries(id, loadout_id, position, assignment_id, draft_id,
         draft_revision_id, revision, skill_name, content_digest, server_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entryId,
      loadoutId,
      p.position,
      p.assignment_id,
      p.draft_id,
      p.draft_revision_id,
      p.revision,
      p.skill_name,
      p.content_digest,
      nowMs,
    );
    entries.push({ entry_id: entryId, ...p });

    // `P4-FR-09` first half: `proposed`, and only `proposed`, on the build.
    const assignment = loadAssignment(db, p.assignment_id);
    recordObservation(
      db,
      assignment,
      input.opened_by_agent_id,
      {
        status: "proposed",
        reason_code: "LOADOUT_BUILT",
        reason:
          "this revision entered the immutable loadout of a new session; nothing has confirmed " +
          "that the runtime read it, and nothing here claims it did",
        source: input.opened_by_source,
        observed_at_ms: nowMs,
        revision_id: p.draft_revision_id,
        session_ref: sessionId,
        provenance: {
          stage: "proposed",
          loadout_id: loadoutId,
          loadout_entry_id: entryId,
          loadout_digest: digest,
          session_id: sessionId,
          runtime_kind: input.runtime_kind,
          runtime_version: input.runtime_version,
          adapter_version: ADAPTER_VERSION,
          content_digest: p.content_digest,
        },
      },
      nowMs,
    );
  }

  return {
    loadout_id: loadoutId,
    session_id: sessionId,
    agent_id: input.agent_id,
    runtime_kind: input.runtime_kind,
    runtime_version: input.runtime_version,
    adapter_version: ADAPTER_VERSION,
    entry_count: prepared.length,
    loadout_digest: digest,
    created_at_ms: nowMs,
    entries,
    excluded: candidates.filter((c) => !c.included),
  };
}

/** Read a frozen loadout back — the same view, from the rows. */
export function loadoutViewOf(db: Db, session: SessionRow): LoadoutView {
  const loadout = loadoutOfSession(db, session.id);
  const provenance = JSON.parse(loadout.provenance_json) as { candidates?: LoadoutCandidate[] };
  return {
    loadout_id: loadout.id,
    session_id: loadout.session_id,
    agent_id: loadout.agent_id,
    runtime_kind: loadout.runtime_kind,
    runtime_version: loadout.runtime_version,
    adapter_version: loadout.adapter_version,
    entry_count: loadout.entry_count,
    loadout_digest: loadout.loadout_digest,
    created_at_ms: loadout.created_at_ms,
    entries: loadoutEntries(db, loadout.id).map((e) => ({
      entry_id: e.id,
      position: e.position,
      assignment_id: e.assignment_id,
      draft_id: e.draft_id,
      draft_revision_id: e.draft_revision_id,
      revision: e.revision,
      skill_name: e.skill_name,
      content_digest: e.content_digest,
    })),
    excluded: (provenance.candidates ?? []).filter((c) => !c.included),
  };
}

// -------------------------------------------------------------- the receipt

/**
 * THE MARKER A MATERIALIZED SKILL CARRIES, AND WHY IT IS A DIGEST.
 *
 * `P4-FR-19` refuses evidence that proves a skill NAME. A name is what an
 * accident or an attacker controls: two files can carry one name, and a runtime
 * reporting "I used ship-the-thing" has told you nothing about WHICH bytes it
 * read. So the rendered `SKILL.md` carries a line naming its own revision id and
 * content digest and instructs the runtime to echo it, the adapter lifts that
 * line out of the runtime's own output, and the registry refuses the receipt
 * unless the echoed digest is the one it froze into the entry.
 *
 * A runtime that invents a plausible-looking line cannot pass: it would have to
 * invent the sha256 of a canonical revision it never read.
 */
export const RECEIPT_MARKER = "SKLN-RECEIPT";
export const RECEIPT_MARKER_RE = /SKLN-RECEIPT\s+revision=([0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26})\s+digest=(sha256:[0-9a-f]{64})/;

/** The line a materialized skill prints, and the adapter greps for. */
export function receiptMarkerLine(revisionId: string, contentDigest: string): string {
  return `${RECEIPT_MARKER} revision=${revisionId} digest=${contentDigest}`;
}

/** What a runtime echoed, lifted out of its output. `null` when it echoed
 *  nothing — which is `unknown`, never a downgrade to `loaded` (`P4-FR-11`). */
export function parseReceiptMarker(text: string): { revision_id: string; content_digest: string } | null {
  const m = RECEIPT_MARKER_RE.exec(text);
  return m ? { revision_id: m[1] as string, content_digest: m[2] as string } : null;
}

export interface ReceiptInput {
  stage: ReceiptStage;
  /** the runtime's OWN session identifier — `session_id` from Claude Code's
   *  JSON, the session id Codex prints. This is the correlation `P4-FR-10`
   *  asks for and it comes from the runtime, not from the adapter's bookkeeping */
  runtime_session_ref: string;
  /** what the runtime echoed: the revision it says it read */
  revision_id: string;
  content_digest: string;
  /** required for `invoked`: which invocation. `P4-FR-10` again */
  invocation_ref?: string | null;
  observed_at_ms: number;
  /** the runtime's own words, kept as evidence and never parsed for a decision */
  transcript_excerpt?: string | null;
}

function boundedRef(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ApiError("INVALID_SCHEMA", `${field} must be a string`);
  const t = value.trim();
  if (t.length < 1 || t.length > max) throw new ApiError("INVALID_SCHEMA", `${field} is 1..${max} characters`);
  return t;
}

/** The shape check, before anything is compared. Every refusal here is a `400`
 *  and writes nothing — a malformed receipt is not an `unknown`, it is a client
 *  that has not filed a receipt at all. */
export function validateReceipt(body: Record<string, unknown>, nowMs: number): ReceiptInput {
  const stage = body.stage;
  if (!isReceiptStage(stage)) {
    throw new ApiError("INVALID_SCHEMA", `stage must be one of ${RECEIPT_STAGES.join(", ")}`);
  }
  // `P4-FR-13`, in the schema: a receipt names no source. The kind of evidence
  // it is comes from the principal that filed it, exactly as an observation's
  // does, and a field the server overrides is a field the next reader believes.
  if (body.source !== undefined) {
    throw new ApiError("INVALID_SCHEMA", "a receipt does not declare its source: the server derives it from the reporting principal");
  }
  const revisionId = body.revision_id;
  if (typeof revisionId !== "string" || revisionId.length !== 26) {
    throw new ApiError("INVALID_SCHEMA", "revision_id must be a 26-character id");
  }
  const digest = body.content_digest;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new ApiError("INVALID_SCHEMA", "content_digest must be sha256:<64 hex>");
  }
  const observedAt = body.observed_at_ms === undefined ? nowMs : body.observed_at_ms;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0) {
    throw new ApiError("INVALID_SCHEMA", "observed_at_ms must be a positive number of milliseconds");
  }
  let invocationRef: string | null = null;
  if (stage === "invoked") {
    invocationRef = boundedRef(body.invocation_ref, "invocation_ref", 200);
  } else if (body.invocation_ref !== undefined && body.invocation_ref !== null) {
    throw new ApiError("INVALID_SCHEMA", "invocation_ref belongs to an invoked receipt only");
  }
  let excerpt: string | null = null;
  if (body.transcript_excerpt !== undefined && body.transcript_excerpt !== null) {
    excerpt = boundedRef(body.transcript_excerpt, "transcript_excerpt", 4000);
  }
  return {
    stage,
    runtime_session_ref: boundedRef(body.runtime_session_ref, "runtime_session_ref", 200),
    revision_id: revisionId,
    content_digest: digest,
    invocation_ref: invocationRef,
    observed_at_ms: observedAt,
    transcript_excerpt: excerpt,
  };
}

export interface ReceiptResult {
  receipt_id: string;
  session_id: string;
  loadout_id: string;
  assignment_id: string;
  stage: ReceiptStage;
  receipt_digest: string;
  observed: ObservedView;
}

/**
 * THE ONE WRITER OF `loaded` AND `invoked` (`P4-FR-09`, `P4-FR-10`).
 *
 * The receipt is checked against the FROZEN entry before anything is written:
 * the revision must be one this session was actually given, and the digest must
 * be the digest that entry carries. A receipt that names a revision outside the
 * loadout, or the right revision with the wrong digest, is REFUSED — it is not
 * quietly recorded as an `unknown`, because an `unknown` is what the ABSENCE of
 * a receipt produces and conflating the two would let a wrong receipt look like
 * a missing one.
 *
 * `P4-FR-20`: the stage is written at the moment the receipt arrives, from the
 * receipt, with the receipt's own timestamp. Nothing here reconstructs a chain
 * from what must have happened.
 */
export function confirmFromReceiptInTx(
  db: Db,
  session: SessionRow,
  reportedByAgentId: string,
  source: EvidenceSource,
  input: ReceiptInput,
  nowMs: number,
): ReceiptResult {
  const loadout = loadoutOfSession(db, session.id);
  const entry = db
    .prepare("SELECT * FROM session_loadout_entries WHERE loadout_id=? AND draft_revision_id=?")
    .get(loadout.id, input.revision_id) as LoadoutEntryRow | undefined;
  if (!entry) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "this receipt names a revision that is not in this session's loadout",
      "REVISION_NOT_IN_LOADOUT",
    );
  }
  if (entry.content_digest !== input.content_digest) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "this receipt's content digest is not the digest this session's loadout froze for that revision",
      "DIGEST_MISMATCH",
    );
  }
  // `invoked` presupposes `loaded`: a runtime cannot invoke what it never read,
  // and a chain that skips a stage is a chain assembled after the fact
  // (`P4-FR-20`). The refusal names the missing stage rather than inventing it.
  if (input.stage === "invoked" && receiptsOfEntry(db, entry.id, "loaded").length === 0) {
    throw new ApiError(
      "PRECONDITION_FAILED",
      "no load receipt precedes this invocation receipt: the stage before it was never confirmed",
      "LOAD_NOT_CONFIRMED",
    );
  }

  const payload = {
    stage: input.stage,
    session_id: session.id,
    loadout_id: loadout.id,
    loadout_entry_id: entry.id,
    assignment_id: entry.assignment_id,
    draft_id: entry.draft_id,
    draft_revision_id: entry.draft_revision_id,
    revision: entry.revision,
    skill_name: entry.skill_name,
    content_digest: entry.content_digest,
    runtime_kind: session.runtime_kind,
    runtime_version: session.runtime_version,
    adapter_version: loadout.adapter_version,
    runtime_session_ref: input.runtime_session_ref,
    invocation_ref: input.invocation_ref,
    observed_at_ms: input.observed_at_ms,
    reported_by_agent_id: reportedByAgentId,
    source,
    transcript_excerpt: input.transcript_excerpt,
  };
  const receiptDigest = `sha256:${createHash("sha256")
    .update(jcsCanonicalize(payload as unknown as JcsValue), "utf8")
    .digest("hex")}`;

  const receiptId = ulid(nowMs);
  db.prepare(
    `INSERT INTO runtime_receipts(id, session_id, loadout_id, loadout_entry_id, assignment_id,
       draft_revision_id, content_digest, stage, runtime_session_ref, invocation_ref,
       reported_by_agent_id, source, receipt_digest, payload_json, observed_at_ms, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    receiptId,
    session.id,
    loadout.id,
    entry.id,
    entry.assignment_id,
    entry.draft_revision_id,
    entry.content_digest,
    input.stage,
    input.runtime_session_ref,
    input.invocation_ref,
    reportedByAgentId,
    source,
    receiptDigest,
    JSON.stringify(payload),
    input.observed_at_ms,
    nowMs,
  );

  const assignment = loadAssignment(db, entry.assignment_id);
  const observed = recordObservation(
    db,
    assignment,
    reportedByAgentId,
    {
      status: input.stage,
      reason_code: input.stage === "loaded" ? "RUNTIME_LOAD_RECEIPT" : "RUNTIME_INVOCATION_RECEIPT",
      reason:
        input.stage === "loaded"
          ? "a runtime receipt confirms this exact revision was read from its native location in this session"
          : "a runtime receipt correlates this exact revision, this session and one invocation of it",
      source,
      observed_at_ms: input.observed_at_ms,
      revision_id: entry.draft_revision_id,
      session_ref: session.id,
      provenance: {
        stage: input.stage,
        receipt_id: receiptId,
        receipt_digest: receiptDigest,
        loadout_id: loadout.id,
        loadout_entry_id: entry.id,
        content_digest: entry.content_digest,
        runtime_kind: session.runtime_kind,
        runtime_session_ref: input.runtime_session_ref,
        invocation_ref: input.invocation_ref,
      },
    },
    nowMs,
  );

  return {
    receipt_id: receiptId,
    session_id: session.id,
    loadout_id: loadout.id,
    assignment_id: entry.assignment_id,
    stage: input.stage,
    receipt_digest: receiptDigest,
    observed,
  };
}

// ---------------------------------------------------------- the stage chain

/** The stage of one entry, with the provenance of whatever established it. An
 *  entry with no confirmation is `unknown` and says so in all four `INV-03`
 *  fields — it is never reported as `proposed`-and-therefore-fine. */
export interface EntryStageView {
  entry_id: string;
  assignment_id: string;
  draft_revision_id: string;
  revision: number;
  skill_name: string;
  content_digest: string;
  stage: LoadoutStage | "unknown";
  reason_code: string;
  reason: string;
  source: string;
  observed_at_ms: number;
  /** every stage this entry reached, in the order it reached them */
  chain: Array<{
    stage: LoadoutStage;
    at_ms: number;
    source: string;
    receipt_id: string | null;
    receipt_digest: string | null;
    runtime_session_ref: string | null;
    invocation_ref: string | null;
  }>;
}

const STAGE_RANK: Readonly<Record<LoadoutStage, number>> = { proposed: 1, loaded: 2, invoked: 3 };

/**
 * `P4-FR-12`: every stage carries a structured timestamp and provenance, and
 * `P4-FR-11`: absent a trustworthy confirmation the answer is `unknown` with a
 * reason and a source.
 *
 * The chain is READ, never assembled (`P4-FR-20`). `proposed` comes from the
 * loadout row's own creation time — the backend saw itself build it — and the
 * later stages come from receipts. There is no branch here that promotes a stage
 * because a later one was seen, and none that infers one from a frontend claim.
 */
export function entryStages(db: Db, session: SessionRow, nowMs: number): EntryStageView[] {
  const loadout = loadoutOfSession(db, session.id);
  return loadoutEntries(db, loadout.id).map((entry) => {
    const chain: EntryStageView["chain"] = [
      {
        stage: "proposed",
        at_ms: loadout.created_at_ms,
        source: "backend",
        receipt_id: null,
        receipt_digest: null,
        runtime_session_ref: null,
        invocation_ref: null,
      },
    ];
    for (const stage of RECEIPT_STAGES) {
      for (const r of receiptsOfEntry(db, entry.id, stage)) {
        chain.push({
          stage,
          at_ms: r.observed_at_ms,
          source: r.source,
          receipt_id: r.id,
          receipt_digest: r.receipt_digest,
          runtime_session_ref: r.runtime_session_ref,
          invocation_ref: r.invocation_ref,
        });
      }
    }
    chain.sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || a.at_ms - b.at_ms);
    const top = chain[chain.length - 1] as EntryStageView["chain"][number];
    const confirmed = top.stage !== "proposed";
    return {
      entry_id: entry.id,
      assignment_id: entry.assignment_id,
      draft_revision_id: entry.draft_revision_id,
      revision: entry.revision,
      skill_name: entry.skill_name,
      content_digest: entry.content_digest,
      // A loadout entry nobody confirmed is `unknown`, not `proposed`-as-success.
      // `proposed` is kept in the chain as the fact it is — the backend built
      // this entry — and the STATUS reported for the entry is the honest one.
      stage: confirmed ? top.stage : "unknown",
      reason_code: confirmed
        ? top.stage === "loaded"
          ? "RUNTIME_LOAD_RECEIPT"
          : "RUNTIME_INVOCATION_RECEIPT"
        : "NO_RUNTIME_RECEIPT",
      reason: confirmed
        ? "a structured runtime receipt names this session, this revision and this digest"
        : "this revision was proposed to the session and no adapter or runtime receipt has confirmed " +
          "that it was read or invoked; observed_at_ms is the moment of this look",
      source: confirmed ? top.source : "backend",
      observed_at_ms: confirmed ? top.at_ms : nowMs,
      chain,
    };
  });
}
