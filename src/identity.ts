// THE COLUMNS OF THIS REGISTRY THAT CARRY IDENTITY — what may go into each one,
// and where the SET of them comes from.
//
// WHY THIS FILE EXISTS, WHICH IS NOT THE SAME AS WHAT IT DOES.
//
//   Round 13 closed a real defect: `evidenceDigestOf` reduced a string to
//   `sha256` of its UTF-8 bytes, an unpaired surrogate became U+FFFD on the way,
//   and two ids that never matched were stored as one digest. The fix went into
//   the primitive and every caller of it was found BY WALKING `src/`.
//
//   The obligation, though, is not about hashing. It is:
//
//     NO COLUMN CARRYING IDENTITY MAY COLLAPSE TWO DIFFERENT STRINGS OF A
//     CLIENT INTO ONE.
//
//   Hashing is one way to collapse two strings. A UNIQUE KEY OVER RAW TEXT is
//   another, and `agents.name` has been one since work 1: never hashed, never
//   examined, and therefore never in a set taken from the callers of a digest.
//   A reviewer sent `"\ud800"` and then `"\ud801"` — two different names — and
//   got a principal and then a `409 CONFLICT` with it.
//
//   D-12 says the set must be taken from the system that KNOWS it. For THIS
//   obligation that system is the SCHEMA, not a list of call sites. This file is
//   `src/journal.ts` applied to a different question, for the reason that one
//   worked: what changed there was the SOURCE OF THE SET.
//
// SO THE SET COMES FROM TWO DERIVATIONS AND NO LIST.
//
//   `identityColumnsOf` reads `sqlite_master`: every PRIMARY KEY and every
//   UNIQUE constraint and unique index of every table, down to their TEXT
//   columns. A migration that adds one puts it in the set the moment it runs.
//
//   `equalitySearchedTextColumnsOf` reads `src/*.ts`: every SQL literal, the
//   tables it names, and the columns it compares with `=?` outside a `SET`
//   clause. That is the second way a column carries identity — `withIdempotency`
//   FINDS A ROW by `idempotency_keys.key` and replays that row's response, and
//   the schema alone would keep the column and lose the reason.
//
//   `IDENTITY_INTAKE` below classifies every member of the union. A column in
//   the set and absent here is reported by `surveyIdentityIntake` and FAILS THE
//   BUILD (`test/p14-r14-probes` [14.4]) — which is the property a hand-kept
//   list does not have, and the one round 13's set did not have either.
//
// THE THREE CLASSES.
//
//   `registry_generated` — a caller cannot express two different strings that
//                          land in this column as one, because the value is a
//                          ULID this registry mints, a digest it computes, a row
//                          id it resolved, or a member of a closed set whose
//                          form it defined and refuses anything outside.
//   `checked_at_boundary` — the caller's OWN text, admitted on purpose, with
//                          `assertIdentityText` (`src/outcome.ts`) at the
//                          boundary NAMED in the note. The strings that would
//                          collapse are refused before the column sees them.
//   `declared_limit`     — the caller's own text admitted into an identity
//                          position with nothing but a stated bound between it
//                          and a collision. EMPTY TODAY, and it is here so that
//                          the survey can NAME such a column rather than lack a
//                          word for it — the role `free_text` plays in
//                          `src/journal.ts`.
//
// WHAT IS DELIVERED, IN ONE SENTENCE.
//
//   EVERY COLUMN OF THIS SCHEMA THAT DECIDES WHETHER TWO ROWS ARE THE SAME ROW
//   EITHER HOLDS A VALUE THIS REGISTRY PRODUCED, OR HOLDS A CALLER'S STRING THAT
//   A BOUNDARY HAS CHECKED SURVIVES BEING STORED AND READ AGAIN.
//
//   It says nothing about columns that do not decide that, and it is not a claim
//   that a caller's text is safe in general: `receipt_events.evidence_json` is
//   an adopter's prose by design and `src/journal.ts` is where that is written
//   down. The two files answer two questions and neither answers the other's.
import { readFileSync, readdirSync } from "node:fs";
import type { Db } from "./sqlite.ts";

export type IdentityIntake = "registry_generated" | "checked_at_boundary" | "declared_limit";

export interface IdentityColumnClass {
  intake: IdentityIntake;
  /** what the column holds — and, for `checked_at_boundary`, WHICH boundary */
  note: string;
}

/** The three, as data, so the survey can report an empty class instead of
 *  losing it. */
export const IDENTITY_INTAKES: readonly IdentityIntake[] = ["checked_at_boundary", "declared_limit", "registry_generated"];

const MINTED: IdentityColumnClass = { intake: "registry_generated", note: "a ULID this registry mints" };
const RESOLVED: IdentityColumnClass = { intake: "registry_generated", note: "a row of this registry, resolved here" };
const FROM_AUTH: IdentityColumnClass = { intake: "registry_generated", note: "taken from AuthContext, never from the payload" };

/** `<table>.<column>` → why two different strings cannot become one there. */
export const IDENTITY_INTAKE: Record<string, IdentityColumnClass> = {
  // ------------------------------------------------------------ activity_log
  "activity_log.id": MINTED,

  // ------------------------------------------------------- adoption_receipts
  "adoption_receipts.id": MINTED,
  "adoption_receipts.adoption_request_id": RESOLVED,
  "adoption_receipts.skill_version_id": RESOLVED,

  // ------------------------------------------------------- adoption_requests
  "adoption_requests.id": MINTED,
  "adoption_requests.lease_owner": {
    intake: "registry_generated",
    note: "`worker:<host>:<pid>:<ULID>`, composed by `workerId` (src/delivery.ts) out of the machine this registry runs on; no request carries one",
  },

  // ------------------------------------------------------------------ agents
  "agents.id": MINTED,
  "agents.name": {
    intake: "checked_at_boundary",
    note:
      "THE OPERATOR'S OWN NAME for a principal, 1..120 characters, under `UNIQUE(workspace_id,name)`. " +
      "`createPrincipal` (src/provision.ts) is the only writer that takes a caller's string and it calls " +
      "`assertIdentityText` BEFORE the conflict lookup, so a name that would not survive storage is refused " +
      "rather than folded into another principal's",
  },
  "agents.workspace_id": FROM_AUTH,

  // ---------------------------------------------------------------- api_keys
  "api_keys.id": MINTED,
  "api_keys.agent_id": RESOLVED,
  "api_keys.key_hash": {
    intake: "registry_generated",
    note: "SHA-256 of the presented key in 64 hex characters, computed here; the secret itself is never stored or compared",
  },

  // --------------------------------------------------------------- approvals
  "approvals.id": MINTED,
  "approvals.adoption_request_id": RESOLVED,
  "approvals.skill_version_id": RESOLVED,
  "approvals.scope": { intake: "registry_generated", note: "publish|adopt_high_risk — a closed set" },

  // ------------------------------------------------------- assignment_events
  "assignment_events.id": MINTED,

  // ---------------------------------------------------------------- captures
  "captures.id": MINTED,

  // ------------------------------------------------------------ draft_events
  "draft_events.id": MINTED,
  "draft_events.capture_id": RESOLVED,
  "draft_events.draft_id": RESOLVED,

  // --------------------------------------------------------- draft_revisions
  "draft_revisions.id": MINTED,
  "draft_revisions.draft_id": {
    intake: "registry_generated",
    note:
      "a ULID this registry mints for the LINEAGE, under `UNIQUE(draft_id, revision)`. No caller names a lineage: " +
      "`captureDraft` mints one and `reviseDraft` copies the head's, so the unique key is over two values a caller " +
      "cannot express",
  },
  "draft_revisions.workspace_id": FROM_AUTH,

  // --------------------------------------------------------- V1 P2 identities
  "owner_sessions.id": MINTED,
  "owner_sessions.token_hash": {
    intake: "registry_generated",
    note: "`sha256:` of 32 random bytes this registry minted. UNIQUE, and a caller cannot express a value here: the column is written from the mint and read by digest lookup",
  },
  "owner_session_revocations.id": MINTED,
  "owner_session_revocations.session_id": RESOLVED,
  "console_tickets.id": MINTED,
  "console_tickets.ticket_hash": {
    intake: "registry_generated",
    note: "`sha256:` of 32 random bytes this registry minted. UNIQUE, and written only from the mint",
  },
  "console_ticket_uses.id": MINTED,
  "console_ticket_uses.ticket_id": RESOLVED,
  "draft_decisions.id": MINTED,
  "draft_decisions.draft_id": {
    intake: "registry_generated",
    note:
      "the LINEAGE id, resolved by `getDraft` from the caller's path parameter and never stored as the caller wrote it. " +
      "UNIQUE, which is what makes a second decision on one lineage collide in the database rather than in a check",
  },
  "draft_decisions.workspace_id": FROM_AUTH,

  // --------------------------------------------------------- V1 P3 identities
  "revision_approvals.id": MINTED,
  "revision_approvals.draft_id": RESOLVED,
  "revision_approvals.draft_revision_id": {
    intake: "registry_generated",
    note:
      "the revision the owner decided on, resolved by `getDraft` from the caller's path parameter. " +
      "UNIQUE, which is what makes one revision approvable exactly once and what a rollback target is selected from",
  },
  "revision_approvals.workspace_id": FROM_AUTH,
  "skill_assignments.id": MINTED,
  "skill_assignments.agent_id": {
    intake: "registry_generated",
    note:
      "resolved against `agents` of the caller's own workspace before the row is written: a string that names no agent of the closed fleet is refused with AGENT_NOT_IN_FLEET and never reaches the column",
  },
  "skill_assignments.draft_id": {
    intake: "registry_generated",
    note: "taken from the approval row this assignment names, never from the caller's payload",
  },
  "skill_assignments.workspace_id": FROM_AUTH,
  "skill_assignment_events.id": MINTED,
  "skill_assignment_events.assignment_id": RESOLVED,
  "assignment_observations.id": MINTED,
  "assignment_observations.assignment_id": RESOLVED,
  "idempotency_request_digests.idempotency_key_id": RESOLVED,
  "assignment_events.assignment_id": RESOLVED,
  "assignment_events.idempotency_key": {
    intake: "registry_generated",
    note: "`<event>:<clock>:<seq>` and `assigned:<id>`, composed by `appendAssignmentEvent`; the caller's own key never reaches this column",
  },

  // ------------------------------------------------------------- assignments
  "assignments.id": MINTED,
  "assignments.agent_id": RESOLVED,
  "assignments.skill_id": RESOLVED,
  "assignments.skill_version_id": RESOLVED,
  "assignments.transfer_id": RESOLVED,

  // ------------------------------------------------------------ attestations
  "attestations.id": MINTED,
  "attestations.skill_version_id": RESOLVED,

  // -------------------------------------------------------- idempotency_keys
  "idempotency_keys.id": MINTED,
  "idempotency_keys.actor_agent_id": FROM_AUTH,
  "idempotency_keys.surface": {
    intake: "registry_generated",
    note: "the name of the surface, a constant of this repository at every call site of `withIdempotency`",
  },
  "idempotency_keys.key": {
    intake: "checked_at_boundary",
    note:
      "THE CALLER'S OWN KEY, compared to decide whether a request is a repeat. `withIdempotency` " +
      "(src/idempotency.ts) calls the rule at the boundary and translates its refusal into `INVALID_SCHEMA`; " +
      "without it node folded an unpaired surrogate to U+FFFD and replayed a DIFFERENT key's stored response. " +
      "It is stored VERBATIM except on the surfaces of `DIGESTED_KEY_SURFACES` — `capture.submit` and " +
      "`draft.revise`, which carry capture content and must persist no raw caller text (`P1-R2-001`) — where the " +
      "column holds `correlationDigest` of it. The check runs on the caller's string either way, which is what " +
      "this class names: a digest of a string that folds is a digest of the wrong string",
  },

  // ------------------------------------------------------------ lint_reports
  "lint_reports.id": MINTED,
  "lint_reports.skill_version_id": RESOLVED,

  // -------------------------------------------------------- observed_records
  "observed_records.id": MINTED,
  "observed_records.observation_id": RESOLVED,

  // ----------------------------------------------------------------- ratings
  "ratings.id": MINTED,
  "ratings.rater_agent_id": FROM_AUTH,
  "ratings.skill_version_id": RESOLVED,

  // ---------------------------------------------------------- receipt_events
  "receipt_events.id": MINTED,
  "receipt_events.adoption_receipt_id": RESOLVED,
  "receipt_events.event": { intake: "registry_generated", note: "the seven §5.3 receipt events — a closed set" },
  "receipt_events.idempotency_key": {
    intake: "registry_generated",
    note:
      "`sha256:` of the adopter's key, computed by `correlationDigest` (src/journal.ts). The adopter's string is " +
      "asked `assertWellFormedText` before it is hashed (round 13) and never reaches the column, so what this " +
      "UNIQUE key compares is 64 hex characters of this registry's own arithmetic",
  },

  // ----------------------------------------------------------------- reviews
  "reviews.id": MINTED,
  "reviews.skill_version_id": RESOLVED,

  // ---------------------------------------------------- runtime_observations
  "runtime_observations.id": MINTED,
  "runtime_observations.agent_id": RESOLVED,

  // ------------------------------------------------------------ signing_keys
  "signing_keys.id": MINTED,
  "signing_keys.agent_id": FROM_AUTH,
  "signing_keys.kid": {
    intake: "registry_generated",
    note:
      "a value of a CLOSED SET: `KID_RE` — `[a-z0-9-]{1,64}` — enforced by `validateKid` (src/provision.ts) at " +
      "registration, lookup and revocation alike, so no string outside that alphabet reaches the column or the search",
  },

  // ------------------------------------------------------ skill_access_grants
  "skill_access_grants.id": MINTED,
  "skill_access_grants.skill_id": RESOLVED,
  "skill_access_grants.grantee_agent_id": RESOLVED,
  "skill_access_grants.grantee_workspace_id": RESOLVED,

  // ----------------------------------------------------------- skill_versions
  "skill_versions.id": MINTED,
  "skill_versions.skill_id": RESOLVED,
  "skill_versions.semantic_version": {
    intake: "registry_generated",
    note:
      "a value of a CLOSED SET: the `exactVersion` pattern of `schema/skill-package-v1.schema.json`, " +
      "`^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$`, enforced by `validateManifest` before the row is looked up",
  },
  "skill_versions.manifest_hash": {
    intake: "registry_generated",
    note: "64 hex characters computed by `manifestHash` over the canonical manifest",
  },
  "skill_versions.state": { intake: "registry_generated", note: "the eight §5.1 version states — a closed set" },

  // ------------------------------------------------------------------ skills
  "skills.id": MINTED,
  "skills.workspace_id": FROM_AUTH,
  "skills.slug": {
    intake: "registry_generated",
    note: "a value of a CLOSED SET: `SLUG_RE` — `[a-z0-9-]{3,64}` — enforced in `src/service.ts` before the skill is resolved or created",
  },

  // --------------------------------------------------------- transfer_grants
  "transfer_grants.id": MINTED,
  "transfer_grants.agent_id": RESOLVED,
  "transfer_grants.action": { intake: "registry_generated", note: "the five [I-8] actions — a closed set" },
  "transfer_grants.recipient_scope": { intake: "registry_generated", note: "local_agent|remote_fleet [B-8] — a closed set" },

  // --------------------------------------------------------------- transfers
  "transfers.id": MINTED,
  "transfers.adoption_receipt_id": RESOLVED,

  // -------------------------------------------------------- transparency_log
  "transparency_log.event_kind": {
    intake: "registry_generated",
    note: "`TLOG_EVENT_KIND` enforced at the append (src/tlog.ts); every writer passes a constant of this repository",
  },
  "transparency_log.subject_id": {
    intake: "registry_generated",
    note: "`TLOG_SUBJECT` enforced at the append (src/tlog.ts) — a ULID, a manifest hash, or a `kid`, which is itself a closed form",
  },

  // ---------------------------------------------------------------- webhooks
  "webhooks.id": MINTED,
  "webhooks.agent_id": FROM_AUTH,

  // --------------------------------------------------- workspace_memberships
  "workspace_memberships.agent_id": RESOLVED,
  "workspace_memberships.workspace_id": FROM_AUTH,

  // -------------------------------------------------------------- workspaces
  "workspaces.id": MINTED,
};

// ---------------------------------------------------------------- derivation

/** The columns of one table whose DECLARED type is TEXT. A collapse is a
 *  property of text: an INTEGER column holds no surrogate and no NUL. */
export function textColumnsOf(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
  return new Set(rows.filter((r) => String(r.type).toUpperCase() === "TEXT").map((r) => r.name));
}

/** Every table of the live schema, SQLite's own bookkeeping excluded. */
export function tablesOf(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/**
 * THE IDENTITY COLUMNS THE SCHEMA ITSELF DECLARES.
 *
 * A PRIMARY KEY and a UNIQUE key are the schema saying "these values decide
 * whether two rows are the same row". `PRAGMA index_list` reports the unique
 * indexes — SQLite's own autoindexes for `PRIMARY KEY` and `UNIQUE`, and the
 * explicit `CREATE UNIQUE INDEX`es, including partial ones — and `table_info`
 * reports a rowid-alias primary key, which has no index at all. Both are read;
 * neither is listed here.
 *
 * Returns `<table>.<column>` → the reasons it is in the set.
 */
export function identityColumnsOf(db: Db): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (table: string, column: string, why: string, text: Set<string>): void => {
    if (!text.has(column)) return;
    const key = `${table}.${column}`;
    const reasons = found.get(key) ?? [];
    if (!reasons.includes(why)) reasons.push(why);
    found.set(key, reasons);
  };
  for (const table of tablesOf(db)) {
    const text = textColumnsOf(db, table);
    for (const col of db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>) {
      if (col.pk > 0) add(table, col.name, "pk", text);
    }
    for (const idx of db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>) {
      if (idx.unique !== 1) continue;
      for (const ic of db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string | null }>) {
        // a NULL name is an indexed EXPRESSION, which is not a column
        if (ic.name !== null) add(table, ic.name, `unique:${idx.name}`, text);
      }
    }
  }
  return found;
}

/**
 * THE COLUMNS THE CODE FINDS A ROW BY — the second way a column carries
 * identity, taken from the SQL this project actually writes.
 *
 * Every string literal of every `src/*.ts` that looks like a statement is read
 * for the tables it names (`FROM`/`JOIN`/`INTO`/`UPDATE`) and the columns it
 * compares to a parameter (`col=?`). The `SET` clause of an `UPDATE` is cut out
 * first: `SET last_error=?` is an assignment, not a search, and counting it
 * would put columns in this set that decide nothing.
 *
 * A statement naming several tables attributes a column to EVERY table that has
 * one by that name. That over-approximates on purpose — a column wrongly in the
 * set costs one line of classification, and a column wrongly out of it is this
 * whole round.
 */
export function equalitySearchedTextColumnsOf(db: Db, srcDir: string): Map<string, string[]> {
  const text = new Map<string, Set<string>>();
  for (const table of tablesOf(db)) text.set(table, textColumnsOf(db, table));

  const found = new Map<string, string[]>();
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort()) {
    const source = readFileSync(srcDir + file, "utf8");
    for (const literal of source.match(/`[^`]*`|"[^"\\\n]*"|'[^'\\\n]*'/g) ?? []) {
      if (!/\b(SELECT|UPDATE|DELETE\s+FROM|INSERT\s+INTO)\b/i.test(literal)) continue;
      const searched = literal.replace(/\bSET\b[\s\S]*?(?=\bWHERE\b|$)/i, " ");
      const tables = new Set<string>();
      for (const m of literal.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) tables.add(m[1]!);
      for (const m of searched.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?/g)) {
        for (const table of tables) {
          if (!text.get(table)?.has(m[1]!)) continue;
          const key = `${table}.${m[1]!}`;
          const files = found.get(key) ?? [];
          if (!files.includes(file)) files.push(file);
          found.set(key, files);
        }
      }
    }
  }
  return found;
}

export interface IdentitySurvey {
  /** every identity column, from the schema and from the code */
  columns: string[];
  /** `<table>.<column>` → why it is in the set */
  reasons: Record<string, string[]>;
  /** in the set, absent from `IDENTITY_INTAKE` — a build failure */
  unclassified: string[];
  /** in `IDENTITY_INTAKE`, absent from the set — a claim about nothing */
  stale: string[];
  /** the members of each class, including the classes with no members */
  byClass: Record<IdentityIntake, string[]>;
}

/**
 * THE SURVEY. Set from the schema and the code, judgement from
 * `IDENTITY_INTAKE`, and the two compared in BOTH directions — a classification
 * that outlives its column is as much a lie as a column nobody classified.
 */
export function surveyIdentityIntake(db: Db, srcDir: string): IdentitySurvey {
  const reasons: Record<string, string[]> = {};
  for (const [key, why] of identityColumnsOf(db)) reasons[key] = [...why];
  for (const [key, files] of equalitySearchedTextColumnsOf(db, srcDir)) {
    reasons[key] = [...(reasons[key] ?? []), ...files.map((f) => `equality:src/${f}`)];
  }
  const columns = Object.keys(reasons).sort();
  const unclassified = columns.filter((c) => IDENTITY_INTAKE[c] === undefined);
  const known = new Set(columns);
  const stale = Object.keys(IDENTITY_INTAKE)
    .filter((c) => !known.has(c))
    .sort();
  const byClass = Object.fromEntries(
    IDENTITY_INTAKES.map((k) => [k, columns.filter((c) => IDENTITY_INTAKE[c]?.intake === k)]),
  ) as Record<IdentityIntake, string[]>;
  return { columns, reasons, unclassified, stale, byClass };
}
