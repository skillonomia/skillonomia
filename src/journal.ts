// THE JOURNALS OF THIS REGISTRY, COLUMN BY COLUMN — what each one is allowed
// to hold, and where the set of columns comes from.
//
// WHY THIS FILE EXISTS, WHICH IS NOT THE SAME AS WHAT IT DOES.
//
//   Nine passes of independent review found four channels by which a caller's
//   text reached a journal. Each was found alone, each was closed, and each
//   closing note said the class was closed. The common cause was never the
//   quality of a fix: it was that THE SURFACE WAS NEVER WRITTEN DOWN. A repair
//   aimed at the column somebody pointed at is not evidence about a set nobody
//   has enumerated.
//
//   Twice the opposite worked in this repository. The set of MCP tools was
//   taken FROM THE CODE and the tool findings stopped recurring. The set of
//   shipped documents was taken from `git ls-files` and then from
//   `npm pack --json` and the document findings stopped recurring. What changed
//   was the SOURCE OF THE SET.
//
// SO THE SET COMES FROM THE SCHEMA, AND THE JUDGEMENT COMES FROM HERE.
//
//   A JOURNAL is a table the schema itself marks as one: it carries a
//   `BEFORE UPDATE` trigger raising `INSERT_ONLY`. That is the repository's own
//   definition — `migrations/0008` names `transfers`, `receipt_events` and
//   `assignment_events` as "the rule these live under" — and `journalTablesOf`
//   reads it out of `sqlite_master`, so a journal added by a future migration
//   is in the set the moment it exists and without anybody remembering to add
//   it here. The COLUMNS come from `PRAGMA table_info` for the same reason.
//
//   `JOURNAL_INTAKE` below classifies every one of them. A column present in
//   the schema and absent here is reported by `surveyJournalIntake` and FAILS
//   THE BUILD: the next column somebody adds cannot be filed quietly, which is
//   the property that the four separate discoveries above did not have.
//
// THE FIVE CLASSES, AND WHY `free_text` IS ONE OF THEM.
//
//   `registry_generated` — the caller does not influence the value at all.
//   `bounded_form`       — an enum, an identifier, a number, a boolean: a form
//                          this registry defined and refuses anything outside.
//   `digest`             — stored as `sha256:<64 lowercase hex>`. Equality
//                          survives, which is all a correlation key needs.
//   `declared_limit`     — a caller's text is admitted, ON PURPOSE, and the
//                          limit is STATED in the files this package ships.
//   `free_text`          — a caller's text is admitted and nobody decided that.
//
//   `free_text` is not a resting place. `surveyJournalIntake` returns those
//   columns separately and a probe requires the list to be EMPTY. It exists so
//   that the survey can NAME the defect rather than lack a word for it, and so
//   that the red commit of a round could record what the tree actually held.
//
// WHAT IS DELIVERED, IN ONE SENTENCE WRITTEN SO THAT ITS OWN EXCEPTIONS ARE IN IT.
//
//   EXCEPT IN THE COLUMNS THIS FILE NAMES AS DECLARED LIMITS, THIS REGISTRY
//   PUTS NO CALLER'S TEXT INTO A JOURNAL, AND THE FORMS IT ACCEPTS THERE ARE
//   ITS OWN.
//
//   The exception clause is first on purpose. "The registry does not put text
//   into its journals", said flatly and qualified afterwards, is the shape of
//   sentence this project has had to correct four times: the reader keeps the
//   headline and loses the qualification. Four columns of `receipt_events` hold
//   an adopter's prose, deliberately, and they are named where the promise is
//   made rather than in a footnote to it.
//
//   The LARGER sentence — that a secret cannot be in a journal — is FALSE under
//   every alphabet and is written nowhere. A bounded alphabet can be made to
//   carry an encoding by somebody who sets out to build one, exactly as the flat
//   list of thirty-two integers an evidence value may be can; a bound on a
//   number bounds a quantity of bits and not their meaning. What is enforced is
//   the sentence above, and it is the one worth having: a registry that
//   accumulates transcripts is a registry that holds material nobody meant to
//   give it.
import type { Db } from "./sqlite.ts";
import { evidenceDigestOf } from "./outcome.ts";

/**
 * A CORRELATION KEY, REDUCED TO A DIGEST.
 *
 * Two columns of this schema exist so that two facts can be recognised as the
 * same one: `observed_records.call_id` binds a call to its output [M-5], and
 * `receipt_events.idempotency_key` binds a retry to the call it repeats. NEITHER
 * IS EVER READ — only compared. So the string a caller sends is replaced by its
 * digest: equality survives a hash exactly, and the string does not survive at
 * all. A human holding the runtime's own log hashes the id they have and finds
 * the row; a human holding only the journal learns that two rows go together,
 * which is the entire question those columns answer.
 *
 * `evidenceDigestOf` is reused rather than reimplemented, for the reason
 * `isAdmissibleEvidenceValue` is in one place: two implementations of "the
 * digest of a string" are two answers to one question.
 *
 * AND THE SENTENCE ABOVE HAS A CONDITION, which round 13 had to add because it
 * was false without one. Equality survives a hash exactly; INEQUALITY does not,
 * for a string JavaScript admits and UTF-8 cannot carry. `"\ud800"` and
 * `"\ud801"` are two strings with ONE digest, because encoding replaces an
 * unpaired surrogate with U+FFFD — so two ids that never matched were read as a
 * pair [M-5] and two different keys replayed one another. `evidenceDigestOf`
 * now REFUSES such a string rather than returning a value that means two
 * things, and the promise this comment makes holds for every string it returns
 * a digest for. The refusal is stated once, in the primitive.
 *
 * NULL IS NOT HASHED, and that is load-bearing. `migrations/0008` records that a
 * record with no `call_id` can never form a pair — a runtime that gave no id
 * established nothing. Hashing the empty string would give every such record
 * ONE SHARED VALUE and manufacture pairs out of absence, turning `unknown` into
 * `yes` [I-1], [A-0]. A caller that sends nothing gets NULL.
 */
export function correlationDigest(value: string): string {
  return evidenceDigestOf(value);
}

/**
 * A NAME OF A MODEL — a form this registry defined, and not a sentence.
 *
 * What it is for: `runtime_observations.model` is read by a human off a
 * dashboard, so a digest would make the column useless and an enumeration would
 * make it wrong the week a new model ships. What it is NOT: a closure. Round 9b
 * settled that a form is not a subject — every alphabet fit for readable names
 * is fit for part of the secrets — so this is a NARROWING and is classified as
 * one. What it delivers is that a boundary column of this registry holds a token
 * of at most 64 characters with no whitespace, and never a paragraph.
 */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+/[\]-]{0,63}$/;

/**
 * A REASON THIS REGISTRY WRITES — an identifier, optionally naming one ULID.
 *
 * `assignment_events.reason` carried `no_activation_root_configured`,
 * `native_copy_missing`, `native_copy_differs` and
 * `superseded_by_assignment:<ULID>` from every writer, and refused nothing. A
 * column whose contents happen to be safe is a property of today's call sites;
 * this is the same property made a property of the append.
 */
export const EVENT_REASON = /^[a-z][a-z0-9_]{0,63}(:[0-9A-HJKMNP-TV-Z]{26})?$/;

/**
 * A SUBJECT OF THE TRANSPARENCY LOG — a ULID, a `kid`, or another identifier of
 * this registry's own vocabulary. Bounded here so the classification of
 * `transparency_log.subject_id` is a rule and not an observation about the
 * writers that exist today.
 */
export const TLOG_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/**
 * A KIND OF TRANSPARENCY-LOG EVENT — an identifier, and no route lets a caller
 * choose one. Every writer passes a constant of this repository
 * (`approval_recorded`, `signing_key_registered`, `version_verified`,
 * `countersign`, …); the form below is the backstop that makes that a property
 * of the APPEND and not of the writers that happen to exist today.
 */
export const TLOG_EVENT_KIND = /^[a-z][a-z0-9_]{0,59}$/;

export type JournalIntake =
  | "registry_generated"
  | "bounded_form"
  | "digest"
  | "declared_limit"
  | "free_text";

export interface JournalColumnClass {
  intake: JournalIntake;
  /** what the column holds — and, for `declared_limit`, what the limit IS */
  note: string;
}

/** `<table>.<column>` → what that column is allowed to take, and from whom. */
export const JOURNAL_INTAKE: Record<string, JournalColumnClass> = {
  // ---------------------------------------------------------------- captures
  //
  // The V1 capture domain (`migrations/0013`). Its text columns are the one
  // place in this schema that holds a WORKFLOW somebody wrote, and they are
  // declared limits for the reason the §5.3 reports are: an owner reads the
  // draft to decide whether to approve it, and a digest of a procedure is not a
  // procedure. What makes the limit narrower than the §5.3 one is that this
  // text is REDACTED FIRST — `src/redaction.ts` runs at the boundary, before
  // any of these rows exist, so what is admitted here is the caller's prose
  // with its credential material already replaced by `⟦REDACTED:…⟧`.
  "captures.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "captures.workspace_id": { intake: "registry_generated", note: "taken from AuthContext, never from the payload" },
  "captures.captured_by_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "captures.source_kind": { intake: "bounded_form", note: "workflow|session|native_skill" },
  "captures.source_format": {
    intake: "bounded_form",
    note: "workflow_text|agent_session|claude_code_skill|codex_skill",
  },
  "captures.source_ref": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V1 CAPTURE. The session id, native path or title the caller named, at most 200 characters, kept because an owner has to see WHICH session or file a draft came from and a digest of a reference is not a reference. It goes through `redactReference` first, so a reference that carries a token stores the token nowhere",
  },
  "captures.redacted_source": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V1 CAPTURE. The normalised source a draft is compiled from, at most 200000 characters, AFTER redaction. It is kept as text because recompiling a draft means compiling this again and because an owner comparing a draft with what was captured needs the second half of that comparison; the credential material is already gone, and `src/redaction.ts` — not this column — is what makes that true",
  },
  "captures.source_digest": { intake: "digest", note: "`sha256:` of the redacted source, computed here" },
  "captures.category": {
    intake: "bounded_form",
    note: "the seven classifier categories plus `ambiguous` — a closed set of `src/skillability.ts`",
  },
  "captures.skillable": { intake: "bounded_form", note: "0|1" },
  "captures.reason_code": {
    intake: "bounded_form",
    note: "an identifier the classifier or the importer chose; no caller supplies one",
  },
  "captures.outcome": { intake: "bounded_form", note: "drafted|refused" },
  "captures.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // --------------------------------------------------------- draft_revisions
  "draft_revisions.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "draft_revisions.draft_id": { intake: "registry_generated", note: "a ULID this registry mints for the lineage" },
  "draft_revisions.revision": { intake: "registry_generated", note: "the head of the lineage plus one" },
  "draft_revisions.parent_revision_id": { intake: "registry_generated", note: "a row of this registry" },
  "draft_revisions.capture_id": { intake: "registry_generated", note: "a row of this registry" },
  "draft_revisions.workspace_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "draft_revisions.author_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "draft_revisions.origin": { intake: "bounded_form", note: "capture|edit|recompile" },
  "draft_revisions.compiler_version": {
    intake: "registry_generated",
    note: "`COMPILER_VERSION` of `src/draft.ts`; no caller names one",
  },
  "draft_revisions.content_json": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V1 CAPTURE. The ten canonical sections, compiled from the redacted source or supplied by an owner's edit, at most 200000 characters. This is the document a person reviews and later approves, so it is stored as text; every owner-supplied section goes through the same redaction the capture did",
  },
  "draft_revisions.content_digest": {
    intake: "digest",
    note: "`sha256:` of the JCS canonicalization of the compiler version and the content, computed here",
  },
  "draft_revisions.semantic_json": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V1 CAPTURE. The structured semantic review, at most 100000 characters. Its codes, sections and severities are this registry's own; its `detail` fields quote the line of the redacted source a finding is about, which is the half a reader acts on",
  },
  "draft_revisions.security_json": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V1 CAPTURE. The structured security review, at most 100000 characters: requested permissions and dependencies as the source declared them, the risky actions found in it, and the redaction findings — category, location and reason, never a value",
  },
  "draft_revisions.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ------------------------------------------------------------ draft_events
  "draft_events.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "draft_events.draft_id": { intake: "registry_generated", note: "a row of this registry" },
  "draft_events.draft_revision_id": { intake: "registry_generated", note: "a row of this registry" },
  "draft_events.capture_id": { intake: "registry_generated", note: "a row of this registry" },
  "draft_events.event": { intake: "bounded_form", note: "captured|classified|compiled|revised|refused" },
  "draft_events.actor_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "draft_events.actor_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "draft_events.source": { intake: "bounded_form", note: "registry|owner|agent" },
  "draft_events.correlation_ref": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V1 CAPTURE. The same reference `captures.source_ref` holds, on the audit row, so that an event can be correlated with the session it came from. Redacted at the same boundary and bounded at 200 characters",
  },
  "draft_events.reason_code": {
    intake: "bounded_form",
    note: "an identifier of the classifier or the importer; no caller supplies one",
  },
  "draft_events.result": { intake: "bounded_form", note: "drafted|refused|recorded" },
  "draft_events.content_digest": { intake: "digest", note: "the revision's own digest, or NULL where no revision was written" },
  "draft_events.provenance_json": {
    intake: "registry_generated",
    note: "composed by `src/capture.ts` out of this registry's own vocabulary — category, scores, marker ids, versions, counts and line numbers. No string a caller sent is copied into it",
  },
  "draft_events.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ---------------------------------------------------------- owner_sessions
  // V1 P2. Not one of these columns holds a caller's text: a browser session is
  // composed entirely out of this registry's own material, which is why the
  // whole table is `registry_generated` and `bounded_form` with no declared
  // limit anywhere in it.
  "owner_sessions.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "owner_sessions.workspace_id": { intake: "registry_generated", note: "taken from the ticket's row, which took it from AuthContext" },
  "owner_sessions.agent_id": { intake: "registry_generated", note: "taken from the ticket's row, which took it from AuthContext" },
  "owner_sessions.actor_role": { intake: "bounded_form", note: "owner|admin" },
  "owner_sessions.token_hash": { intake: "digest", note: "`sha256:` of the opaque value this registry minted; the value itself is stored nowhere" },
  "owner_sessions.csrf_token": {
    intake: "registry_generated",
    note: "32 random bytes this registry minted, base64url. Stored in the clear on purpose: it authenticates nothing without the cookie, and a reload has to be able to read it back",
  },
  "owner_sessions.created_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "owner_sessions.absolute_expires_at_ms": {
    intake: "registry_generated",
    note: "the clock plus the configured lifetime, capped at 60 minutes by a CHECK on this table (`INV-04`)",
  },

  // ----------------------------------------------- owner_session_revocations
  "owner_session_revocations.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "owner_session_revocations.session_id": { intake: "registry_generated", note: "a row of this registry" },
  "owner_session_revocations.reason_code": { intake: "bounded_form", note: "logout|superseded" },
  "owner_session_revocations.revoked_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // --------------------------------------------------------- console_tickets
  "console_tickets.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "console_tickets.workspace_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "console_tickets.agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "console_tickets.actor_role": { intake: "bounded_form", note: "owner|admin" },
  "console_tickets.ticket_hash": { intake: "digest", note: "`sha256:` of the one-time ticket this registry minted" },
  "console_tickets.created_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "console_tickets.expires_at_ms": { intake: "registry_generated", note: "the clock plus five minutes, capped by a CHECK on this table" },

  // ----------------------------------------------------- console_ticket_uses
  "console_ticket_uses.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "console_ticket_uses.ticket_id": { intake: "registry_generated", note: "a row of this registry; UNIQUE, which is the single-use rule" },
  "console_ticket_uses.session_id": { intake: "registry_generated", note: "a row of this registry" },
  "console_ticket_uses.used_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // --------------------------------------------------------- draft_decisions
  "draft_decisions.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "draft_decisions.draft_id": { intake: "registry_generated", note: "a row of this registry; UNIQUE, which makes a lineage's decision singular" },
  "draft_decisions.draft_revision_id": { intake: "registry_generated", note: "a row of this registry" },
  "draft_decisions.capture_id": { intake: "registry_generated", note: "a row of this registry" },
  "draft_decisions.workspace_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "draft_decisions.decision": { intake: "bounded_form", note: "approved|rejected" },
  "draft_decisions.actor_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "draft_decisions.actor_role": { intake: "bounded_form", note: "owner|admin" },
  "draft_decisions.source": { intake: "bounded_form", note: "owner" },
  "draft_decisions.reason_code": { intake: "bounded_form", note: "OWNER_APPROVED|OWNER_REJECTED; no caller supplies one" },
  "draft_decisions.reason": {
    intake: "declared_limit",
    note:
      "THE OWNER'S OWN PROSE, admitted on purpose: `P2-FR-10` requires a rejection to carry a reason and a reason nobody can write is not one. It is redacted at the same boundary a capture body is, and bounded at 2000 characters",
  },
  "draft_decisions.content_digest": { intake: "digest", note: "the approved revision's own digest, copied from the row rather than recomputed" },
  "draft_decisions.provenance_json": {
    intake: "registry_generated",
    note: "composed by `src/draft-decision.ts` out of this registry's own vocabulary — the revision number, the two blocking counts, the semantic status and the compiler version. No string a caller sent is copied into it",
  },
  "draft_decisions.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ------------------------------------------------------ revision_approvals
  // V1 P3. An approval is composed entirely out of this registry's own
  // material: which revision, which digest, who, when. There is no prose column
  // here at all — a rejection carries the owner's reason and an approval does
  // not, so there is nothing to declare a limit about.
  "revision_approvals.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "revision_approvals.draft_id": { intake: "registry_generated", note: "a row of this registry" },
  "revision_approvals.draft_revision_id": {
    intake: "registry_generated",
    note: "a row of this registry; UNIQUE, which is what makes one revision approvable once",
  },
  "revision_approvals.capture_id": { intake: "registry_generated", note: "a row of this registry" },
  "revision_approvals.workspace_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "revision_approvals.revision": { intake: "registry_generated", note: "the revision number of the approved row" },
  "revision_approvals.actor_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "revision_approvals.actor_role": { intake: "bounded_form", note: "owner|admin" },
  "revision_approvals.source": { intake: "bounded_form", note: "owner" },
  "revision_approvals.reason_code": { intake: "bounded_form", note: "OWNER_APPROVED; no caller supplies one" },
  "revision_approvals.content_digest": {
    intake: "digest",
    note: "the approved revision's own digest, copied from the row rather than recomputed",
  },
  "revision_approvals.provenance_json": {
    intake: "registry_generated",
    note: "the same payload `draft_decisions` carries, composed by `src/draft-decision.ts` out of this registry's vocabulary",
  },
  "revision_approvals.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // -------------------------------------------------------- skill_assignments
  "skill_assignments.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "skill_assignments.workspace_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "skill_assignments.agent_id": {
    intake: "registry_generated",
    note: "resolved against `agents` of the caller's own workspace before the row is written; a value that names no agent of the closed fleet never reaches this column",
  },
  "skill_assignments.draft_id": { intake: "registry_generated", note: "taken from the approval row, never from the caller" },
  "skill_assignments.created_by_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "skill_assignments.created_by_role": { intake: "bounded_form", note: "owner|admin" },
  "skill_assignments.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // -------------------------------------------------- skill_assignment_events
  // The DESIRED state machine. Every column but one is this registry's own
  // vocabulary; the one that is not is the owner's reason, admitted for the
  // reason `draft_decisions.reason` is admitted and cleaned at the same
  // boundary.
  "skill_assignment_events.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "skill_assignment_events.assignment_id": { intake: "registry_generated", note: "a row of this registry" },
  "skill_assignment_events.event_seq": {
    intake: "registry_generated",
    note: "the journal's own counter, dense from 1 and UNIQUE per assignment; it is also the optimistic-concurrency token",
  },
  "skill_assignment_events.event": {
    intake: "bounded_form",
    note: "assigned|activated|paused|revoked|revision_selected",
  },
  "skill_assignment_events.desired_state": { intake: "bounded_form", note: "assigned|active|paused|revoked" },
  "skill_assignment_events.desired_revision_id": {
    intake: "registry_generated",
    note: "a row of this registry, checked against the approved set before the write",
  },
  "skill_assignment_events.effective_from": {
    intake: "bounded_form",
    note: "next_session, and nothing else — `INV-07` written in the schema rather than in a comment",
  },
  "skill_assignment_events.actor_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "skill_assignment_events.actor_role": { intake: "bounded_form", note: "owner|admin" },
  "skill_assignment_events.source": { intake: "bounded_form", note: "owner" },
  "skill_assignment_events.reason_code": {
    intake: "bounded_form",
    note: "OWNER_ASSIGNED|OWNER_ACTIVE|OWNER_PAUSED|OWNER_REVOKED|OWNER_SELECTED_REVISION|OWNER_ROLLED_BACK; no caller supplies one",
  },
  "skill_assignment_events.reason": {
    intake: "declared_limit",
    note:
      "THE OWNER'S OWN PROSE, admitted on purpose: a lifecycle command an owner cannot explain is a journal entry nobody can read. It goes through `redact` at the same boundary a capture body does, and is bounded at 2000 characters",
  },
  "skill_assignment_events.content_digest": {
    intake: "digest",
    note: "the desired revision's own digest, copied from the approval row rather than recomputed",
  },
  "skill_assignment_events.provenance_json": {
    intake: "registry_generated",
    note: "composed by `src/assignment-lifecycle.ts` out of this registry's own vocabulary — the states, the revision ids, the approval id and the direction of a selection. No string a caller sent is copied into it",
  },
  "skill_assignment_events.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // --------------------------------------------------- assignment_observations
  // What somebody REPORTED SEEING (`INV-02`). Two columns carry the reporter's
  // own text — the reason and the session reference — and both are declared
  // limits for that reason: an observation whose reason nobody may write is an
  // observation with no reason, which `INV-03` forbids outright.
  "assignment_observations.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "assignment_observations.assignment_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignment_observations.agent_id": {
    intake: "registry_generated",
    note: "copied from the assignment row, never from the report: an observation cannot be filed against another agent by naming one",
  },
  "assignment_observations.observed_status": { intake: "bounded_form", note: "proposed|loaded|invoked|unknown" },
  "assignment_observations.draft_revision_id": {
    intake: "registry_generated",
    note: "a row of this registry when the report names one; NULL when it does not, which is `unknown` about the revision and never a default",
  },
  "assignment_observations.session_ref": {
    intake: "declared_limit",
    note: "THE REPORTER'S OWN REFERENCE to the session it saw, bounded at 200 characters. `INV-03` requires the identifiers of an observation to be kept when they are known, and a runtime's session id is one",
  },
  "assignment_observations.reason_code": {
    intake: "declared_limit",
    note: "THE REPORTER'S OWN CODE, bounded at 64 characters. It is machine-readable by contract and this registry does not enumerate an adapter's vocabulary for it — an adapter that must pick from a list this build ships cannot report a reason this build did not anticipate",
  },
  "assignment_observations.reason": {
    intake: "declared_limit",
    note: "THE REPORTER'S OWN PROSE, bounded at 2000 characters and required by `INV-03` of every observation, `unknown` included",
  },
  "assignment_observations.source": {
    intake: "bounded_form",
    note: "backend|adapter|runtime — and no `owner` member, which is how `INV-02` is enforced rather than promised",
  },
  "assignment_observations.reported_by_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "assignment_observations.observed_at_ms": {
    intake: "declared_limit",
    note: "THE REPORTER'S OWN CLOCK, which is the time the thing was SEEN and cannot be this registry's; `server_at_ms` beside it is the time it arrived, and the pair is the boundary [I-3] asks for",
  },
  "assignment_observations.provenance_json": {
    intake: "declared_limit",
    note: "THE REPORTER'S OWN PAYLOAD, bounded by the column. It is stored as it arrived because it is evidence about a runtime this registry did not observe, and it is never the place a column above hides",
  },
  "assignment_observations.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ------------------------------------------------ idempotency_request_digests
  "idempotency_request_digests.idempotency_key_id": {
    intake: "registry_generated",
    note: "the id of the `idempotency_keys` row this fingerprint belongs to; a row of this registry",
  },
  "idempotency_request_digests.request_digest": {
    intake: "digest",
    note: "`sha256:` of the canonical form of the request payload, computed by `requestDigest` in `src/assignment-lifecycle.ts`. The payload itself is stored nowhere",
  },
  "idempotency_request_digests.server_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ------------------------------------------------------- adoption_receipts
  "adoption_receipts.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "adoption_receipts.adoption_request_id": { intake: "registry_generated", note: "a row of this registry" },
  "adoption_receipts.skill_version_id": { intake: "registry_generated", note: "a row of this registry" },
  "adoption_receipts.adopter_agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "adoption_receipts.created_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ------------------------------------------------------- assignment_events
  "assignment_events.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "assignment_events.assignment_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignment_events.event": { intake: "bounded_form", note: "the eight §5.5 deployment states" },
  "assignment_events.event_seq": { intake: "registry_generated", note: "derived from the head of the chain" },
  "assignment_events.reason": {
    intake: "bounded_form",
    note: "`EVENT_REASON` — an identifier, optionally naming one ULID; enforced by `appendAssignmentEvent`",
  },
  "assignment_events.actor_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "assignment_events.actor_type": { intake: "bounded_form", note: "human|agent|service" },
  "assignment_events.actor_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "assignment_events.grant_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignment_events.grant_action": { intake: "bounded_form", note: "the five [I-8] actions" },
  "assignment_events.activation_target": { intake: "bounded_form", note: "the four native layouts" },
  "assignment_events.native_relpath": {
    intake: "registry_generated",
    note: "composed by the activation adapter from the target and the skill's own slug",
  },
  "assignment_events.managed_copy": { intake: "bounded_form", note: "written|removed|absent|retained" },
  "assignment_events.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "assignment_events.idempotency_key": {
    intake: "registry_generated",
    note: "`<event>:<clock>:<seq>` and `assigned:<id>`, composed here; the caller's own key never reaches this column",
  },

  // ------------------------------------------------------------- assignments
  "assignments.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "assignments.skill_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignments.skill_version_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignments.agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "assignments.recipient_kind": { intake: "bounded_form", note: "local_agent|remote_fleet [B-8]" },
  "assignments.transfer_id": { intake: "registry_generated", note: "a row of this registry" },
  "assignments.assigned_by_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "assignments.assigned_by_type": { intake: "bounded_form", note: "human|agent|service" },
  "assignments.assigned_by_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "assignments.created_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // -------------------------------------------------------- observed_records
  "observed_records.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "observed_records.observation_id": { intake: "registry_generated", note: "the report this record arrived on" },
  "observed_records.agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "observed_records.runtime": { intake: "bounded_form", note: "claude_code|codex" },
  "observed_records.role": { intake: "bounded_form", note: "proposal|call|output" },
  "observed_records.call_id": {
    intake: "digest",
    note: "`sha256:` of the reporter's id, or NULL when the runtime gave none. Equality is all [M-5] asks, and equality is what a digest keeps",
  },
  "observed_records.at_ms": { intake: "bounded_form", note: "a positive integer" },
  "observed_records.marker": {
    intake: "bounded_form",
    note: "`SKLN1-` and sixteen Crockford base32 characters — the §5 form, reduced from the record's text by `markersIn`",
  },
  "observed_records.result": { intake: "bounded_form", note: "success|failure|unknown" },
  "observed_records.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "observed_records.evidence": {
    intake: "bounded_form",
    note: "keys are `EVIDENCE_NAMES`, this registry's own four; values are a boolean, a safe integer, a `sha256:` digest, or a flat list of at most 32 of those (`isAdmissibleEvidenceValue`, `src/outcome.ts`)",
  },

  // ----------------------------------------------------------- receipt_events
  "receipt_events.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "receipt_events.adoption_receipt_id": { intake: "registry_generated", note: "a row of this registry" },
  "receipt_events.event": { intake: "bounded_form", note: "the seven §5.3 receipt events" },
  "receipt_events.event_seq": { intake: "registry_generated", note: "derived from the head of the chain" },
  "receipt_events.evidence_json": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V-1. §5.3 requires an adopter to PRESENT the results of the gates the version declared, and this column holds that document as sent — schema-checked in shape, with prose inside its own fields. It is not reduced to a digest because a human reads it to decide whether an adoption is trustworthy, and a digest of a report is not a report. This is a limit, not a closure: an adopter is a fleet agent and what it writes here is its own text",
  },
  "receipt_events.failure_report_json": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V-1. §5.3 requires an adopter that failed to say WHY, and a cause a human can act on is prose. Schema-checked in shape, free in its `summary` and its detail fields. A digest here would leave a reader with a failure and no account of it",
  },
  "receipt_events.rollback_report_json": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V-1, for the reason the failure report is one: §5.3 requires an account of what was undone, and an account is prose. Schema-checked in shape, free in its prose fields",
  },
  "receipt_events.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "receipt_events.idempotency_key": {
    intake: "digest",
    note: "`sha256:` of the adopter's key. Nothing reads the column — a retry is recognised by EQUALITY, which a digest keeps exactly, and `UNIQUE(adoption_receipt_id, idempotency_key)` still separates two keys",
  },
  "receipt_events.environment_json": {
    intake: "declared_limit",
    note: "THE STATED LIMIT OF V-1. §5.3's declared environment is validated against Appendix E.2 and stored as sent; the schema bounds its SHAPE and its version strings are the adopter's own. The compatibility answer is computed from it, so a digest would remove the fact it exists to carry",
  },
  "receipt_events.recipient_json": {
    intake: "registry_generated",
    note: "written only under `asRegistry`: the typed kind and the resolved principal's own id [I-6]",
  },

  // ---------------------------------------------------- runtime_observations
  "runtime_observations.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "runtime_observations.agent_id": { intake: "registry_generated", note: "a principal resolved by this registry" },
  "runtime_observations.runtime": { intake: "bounded_form", note: "claude_code|codex" },
  "runtime_observations.model": {
    intake: "bounded_form",
    note: "`MODEL_NAME` — at most 64 characters, no whitespace, refused rather than truncated. A NARROWING and not a closure: round 9b settled that a form is not a subject",
  },
  "runtime_observations.session_active": { intake: "bounded_form", note: "a boolean, or NULL for `unknown`" },
  "runtime_observations.last_activity_ms": { intake: "bounded_form", note: "a positive integer, or NULL" },
  "runtime_observations.selection_window": { intake: "bounded_form", note: "live_session|period|all_time" },
  "runtime_observations.window_detail": {
    intake: "registry_generated",
    note: "composed by `windowDetailOf` (`src/service.ts`) from the window kind and, for a `period`, the milliseconds the reporter declared. A report that sends `window_detail` is REFUSED, not ignored [I-3]",
  },
  "runtime_observations.proposal_inventory_complete": { intake: "bounded_form", note: "a boolean" },
  "runtime_observations.records_read": { intake: "bounded_form", note: "a non-negative integer" },
  "runtime_observations.reported_by_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "runtime_observations.reported_by_type": { intake: "bounded_form", note: "human|agent|service [I-5]" },
  "runtime_observations.reported_by_role": { intake: "bounded_form", note: "owner|admin|reviewer|member [I-5]" },
  "runtime_observations.grant_id": { intake: "registry_generated", note: "the §6.2 grant this report ran under" },
  "runtime_observations.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
  "runtime_observations.idempotency_key": {
    intake: "registry_generated",
    note: "`observation:<ULID>`, composed here; the caller's own key never reaches this column",
  },

  // ----------------------------------------------------------------- transfers
  "transfers.id": { intake: "registry_generated", note: "a ULID this registry mints" },
  "transfers.skill_version_id": { intake: "registry_generated", note: "a row of this registry" },
  "transfers.sender_agent_id": { intake: "registry_generated", note: "taken from AuthContext" },
  "transfers.sender_type": { intake: "bounded_form", note: "human|agent|service" },
  "transfers.sender_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "transfers.recipient_kind": { intake: "bounded_form", note: "local_agent|remote_fleet [B-8]" },
  "transfers.recipient_ref": {
    intake: "registry_generated",
    note: "the RESOLVED recipient's own id: the caller names a principal, this registry writes the row it found",
  },
  "transfers.grant_id": { intake: "registry_generated", note: "a row of this registry" },
  "transfers.grant_action": { intake: "bounded_form", note: "the five [I-8] actions" },
  "transfers.grantor_agent_id": { intake: "registry_generated", note: "read off the grant row" },
  "transfers.grantor_type": { intake: "bounded_form", note: "human|agent|service" },
  "transfers.grantor_role": { intake: "bounded_form", note: "owner|admin|reviewer|member" },
  "transfers.arrival_marker": {
    intake: "registry_generated",
    note: "derived from the skill version's own id [M-1] (`arrivalMarker`, `src/marker.ts`)",
  },
  "transfers.adoption_receipt_id": { intake: "registry_generated", note: "a row of this registry" },
  "transfers.receipt_event_seq": { intake: "registry_generated", note: "derived from the head of the chain" },
  "transfers.created_at_ms": { intake: "registry_generated", note: "the registry clock" },

  // ---------------------------------------------------------- transparency_log
  "transparency_log.seq": { intake: "registry_generated", note: "AUTOINCREMENT" },
  "transparency_log.event_kind": {
    intake: "registry_generated",
    note: "a constant of this repository at every writer, and `TLOG_EVENT_KIND` at the append so that this is a property of the journal",
  },
  "transparency_log.subject_id": {
    intake: "bounded_form",
    note: "`TLOG_SUBJECT` — a ULID, a manifest hash, or a `kid`, which the principal registering a key chooses; enforced at the append",
  },
  "transparency_log.payload_hash": { intake: "digest", note: "SHA-256 of the JCS payload" },
  "transparency_log.prev_hash": { intake: "digest", note: "the previous row's hash" },
  "transparency_log.this_hash": { intake: "digest", note: "SHA-256 over the canonical row" },
  "transparency_log.server_at_ms": { intake: "registry_generated", note: "the registry clock" },
};

/**
 * THE MODULES THAT WRITE EACH JOURNAL — declared, so that a new one is noticed.
 *
 * NOT "exactly one writer", because that is not true and this file does not say
 * things that are not true: `adoption_receipts` is written by `src/service.ts`
 * on the adoption path and by `src/transfer.ts` in the transaction that opens a
 * transfer chain, and both write values of this registry's own. What matters
 * for the classification above is that the set of places a column can be filled
 * from is KNOWN: a rule enforced at one boundary is a property of that boundary
 * and not of the journal, and the way that stops being true is a second writer
 * appearing quietly. A probe scans `src/*.ts` for `INSERT INTO <table>` and
 * compares what it finds against this table.
 */
export const JOURNAL_WRITERS: Record<string, readonly string[]> = {
  adoption_receipts: ["src/service.ts", "src/transfer.ts"],
  assignment_observations: ["src/assignment-lifecycle.ts"],
  captures: ["src/capture.ts"],
  idempotency_request_digests: ["src/idempotency.ts"],
  revision_approvals: ["src/draft-decision.ts"],
  skill_assignment_events: ["src/assignment-lifecycle.ts"],
  skill_assignments: ["src/assignment-lifecycle.ts"],
  console_ticket_uses: ["src/console-session.ts"],
  console_tickets: ["src/console-session.ts"],
  draft_decisions: ["src/draft-decision.ts"],
  draft_events: ["src/capture.ts"],
  draft_revisions: ["src/capture.ts"],
  owner_session_revocations: ["src/console-session.ts"],
  owner_sessions: ["src/console-session.ts"],
  assignment_events: ["src/assignments.ts"],
  assignments: ["src/assignments.ts"],
  observed_records: ["src/fleet-store.ts"],
  receipt_events: ["src/receipts.ts"],
  runtime_observations: ["src/fleet-store.ts"],
  transfers: ["src/transfer.ts"],
  transparency_log: ["src/tlog.ts"],
};

/**
 * THE JOURNALS, READ OUT OF THE LIVE SCHEMA.
 *
 * A table with a `BEFORE UPDATE` trigger that raises `INSERT_ONLY` is a journal
 * — the schema's own mark, not a list kept here. A migration that adds one puts
 * it in this set without editing this file, which is the point.
 */
export function journalTablesOf(db: Db): string[] {
  const rows = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  const tables = new Set<string>();
  for (const row of rows) {
    if (!/INSERT_ONLY/.test(row.sql)) continue;
    const m = /BEFORE\s+UPDATE\s+ON\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(row.sql);
    if (m) tables.add(m[1]!);
  }
  return [...tables].sort();
}

/** The columns of one table, from `PRAGMA table_info` and from nowhere else. */
export function journalColumnsOf(db: Db, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export interface JournalSurvey {
  /** every `<table>.<column>` of every journal, from the schema */
  columns: string[];
  /** in the schema, absent from `JOURNAL_INTAKE` — a build failure */
  unclassified: string[];
  /** in `JOURNAL_INTAKE`, absent from the schema — a claim about nothing */
  stale: string[];
  /** classified `free_text`: a caller's text, admitted, with nobody's decision */
  freeText: string[];
  /** classified `declared_limit`: a caller's text, admitted, and said so */
  declaredLimits: string[];
}

/**
 * THE SURVEY. Set from the schema, judgement from `JOURNAL_INTAKE`, and the
 * two compared in both directions — a classification that outlives its column
 * is as much a lie as a column nobody classified.
 */
export function surveyJournalIntake(db: Db): JournalSurvey {
  const columns: string[] = [];
  for (const table of journalTablesOf(db)) {
    for (const column of journalColumnsOf(db, table)) columns.push(`${table}.${column}`);
  }
  columns.sort();
  const unclassified = columns.filter((c) => JOURNAL_INTAKE[c] === undefined);
  const known = new Set(columns);
  const stale = Object.keys(JOURNAL_INTAKE)
    .filter((c) => !known.has(c))
    .sort();
  const freeText = columns.filter((c) => JOURNAL_INTAKE[c]?.intake === "free_text");
  const declaredLimits = columns.filter((c) => JOURNAL_INTAKE[c]?.intake === "declared_limit");
  return { columns, unclassified, stale, freeText, declaredLimits };
}

/** The columns whose limit this package states out loud. */
export function declaredLimitColumns(db: Db): string[] {
  return surveyJournalIntake(db).declaredLimits;
}
