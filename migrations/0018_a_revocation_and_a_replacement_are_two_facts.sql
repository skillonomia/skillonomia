-- 0018 — A REVOCATION AND A REPLACEMENT ARE TWO FACTS, AND ONE ROW MAY HOLD BOTH.
--
-- WHAT WAS WRONG. v1.0.0 shipped `revoked` and `superseded` as two of three
-- mutually exclusive tails of one state column (§5.1: "all three tails are
-- terminal"), and put the replacement pointer on the same row as the state. So
-- a version that was superseded could not afterwards be revoked — the whitelist
-- refused the edge — and a version that was revoked could never be given a
-- successor, because reaching `superseded` would have erased the revocation.
-- Both orders were impossible, which made the trap irreversible: an owner who
-- revoked first lost the ability to point adopters at the replacement, and an
-- owner who superseded first lost the ability to say the old bytes are unsafe.
--
-- WHAT IS TRUE INSTEAD (§5.1b). A revocation and a replacement are ORTHOGONAL
-- facts about one version. `state='revoked'` is the disposition:
-- new adoptions are blocked and `revocation_reason` says why. The lineage pair
-- `supersedes_version_id` / `superseded_by_version_id` is a POINTER: it names
-- the version that replaces this one. A revoked row keeps `state='revoked'` AND
-- gains `superseded_by_version_id`; the successor link is a COLUMN, not a state
-- change, so nothing has to be given up to record the other fact.
--
-- WHY THIS MIGRATION ADDS TRIGGERS AND INDEXES AND NOT A `CHECK`. §5.1b says
-- its constraints are held by the database and not only by the service, and
-- leaves the FORM to this file. The form is not a stylistic preference here.
-- `skill_versions` is the most-referenced
-- table in this schema — eight tables hold a foreign key into it — and SQLite
-- cannot add a `CHECK` in place, so a `CHECK` would mean the twelve-step rebuild
-- `0011` and `0012` perform on `receipt_events`: drop and re-create the tenancy
-- trigger, drop the table every one of those foreign keys points at, and rename
-- a copy over it. A trigger refuses exactly the same writes a `CHECK` would, on
-- INSERT and on UPDATE, for every statement issued through every connection —
-- so the rebuild would buy nothing and risk the centre of the registry.
--
-- The one thing a rebuild WOULD give that a trigger cannot is a proof that the
-- rows already in the database satisfy the rule: the rebuild's `INSERT…SELECT`
-- fails on a row that does not. That proof is not given up either — it is taken
-- explicitly, by the three scratch tables below, each of which is a `CHECK`
-- whose failure names the rule that was broken. They are created, filled from a
-- count over the live rows and dropped inside this migration's transaction, so
-- they are never part of a schema a reader sees, and a database that violates a
-- rule leaves this migration by `ROLLBACK` with `PRAGMA user_version` exactly
-- where it was found — the state the documented rollback procedure restores from.
--
-- WHAT IS DELIBERATELY NOT HERE. The cross-row rules §5.1b states that need a
-- decision rather than a refusal — "an existing different link returns
-- `CONFLICT`", the convergent noop of a repeated supersede, the ordering of the
-- `version_revoked` and `version_superseded` transparency-log appends — belong
-- to the service layer, which is where a caller can be told WHICH rule it broke
-- in the vocabulary of §6's error model. A trigger can only abort. Duplicating
-- those here would give one rule two enforcers that could drift, which is the
-- defect class `test/spec-parity.test.ts` exists to prevent.
--
-- NOTHING ELSE MOVES. No table is created or rebuilt, no column is added,
-- removed or altered, no row is inserted, updated or deleted, and no statement
-- of any earlier migration is edited. `PRAGMA user_version` = `18`.

-- ============ 1. the rows that already exist satisfy the rules ============
--
-- Each scratch table is one rule. `CHECK(n=0)` turns a non-zero count into an
-- abort whose message carries the table's name, so the failure says which rule
-- the database broke rather than only that something failed. The migration
-- runner's `ROLLBACK` unwinds the table with everything else.

-- §5.1b: `revocation_reason IS NOT NULL` iff `state='revoked'`. Both
-- directions. The forward one is what v1.0.0's revoke path writes; the REVERSE
-- one — a reason on a row that is not revoked — is the half no shipped writer
-- produces and therefore the half nothing has ever checked.
CREATE TABLE mig0018_a_reason_belongs_to_a_revocation(n INTEGER NOT NULL CHECK(n=0));
INSERT INTO mig0018_a_reason_belongs_to_a_revocation(n)
  SELECT COUNT(*) FROM skill_versions
   WHERE (revocation_reason IS NOT NULL) <> (state='revoked');
DROP TABLE mig0018_a_reason_belongs_to_a_revocation;

-- §5.1b: predecessor and successor belong to one `skill_id`, and a version is
-- not its own predecessor or successor. Checked on BOTH columns, because either
-- one alone can carry the pointer: v1.0.0's supersede writes both, and a
-- database whose halves disagree is exactly what this asks about.
CREATE TABLE mig0018_a_link_stays_inside_one_skill(n INTEGER NOT NULL CHECK(n=0));
INSERT INTO mig0018_a_link_stays_inside_one_skill(n)
  SELECT COUNT(*) FROM skill_versions v
   WHERE v.superseded_by_version_id = v.id
      OR v.supersedes_version_id = v.id
      OR (v.superseded_by_version_id IS NOT NULL
          AND (SELECT s.skill_id FROM skill_versions s WHERE s.id = v.superseded_by_version_id) <> v.skill_id)
      OR (v.supersedes_version_id IS NOT NULL
          AND (SELECT p.skill_id FROM skill_versions p WHERE p.id = v.supersedes_version_id) <> v.skill_id);
DROP TABLE mig0018_a_link_stays_inside_one_skill;

-- §5.1b: `superseded_by_version_id` is permitted for `published`,
-- `deprecated`, `superseded` and `revoked`. A version that never reached
-- `published` has nothing to replace.
CREATE TABLE mig0018_a_link_belongs_to_a_released_version(n INTEGER NOT NULL CHECK(n=0));
INSERT INTO mig0018_a_link_belongs_to_a_released_version(n)
  SELECT COUNT(*) FROM skill_versions
   WHERE superseded_by_version_id IS NOT NULL
     AND state NOT IN ('published','deprecated','superseded','revoked');
DROP TABLE mig0018_a_link_belongs_to_a_released_version;

-- ============ 2. one successor, one predecessor ============
--
-- §5.1b rule 6: a predecessor has at most one successor and a successor has at
-- most one predecessor. Each side of the pair is a single column, so no row can name two — what has to be forbidden is TWO ROWS
-- naming one. That is a uniqueness rule, and a partial unique index states it
-- exactly: it constrains the rows that carry a pointer and says nothing about
-- the rows that do not, which are most of them.
--
-- Creating the index is itself the check on existing data: SQLite refuses to
-- build a unique index over duplicate values, and that refusal rolls the
-- migration back like any other.

-- no two versions are replaced BY the same successor
CREATE UNIQUE INDEX uq_versions_superseded_by
  ON skill_versions(superseded_by_version_id) WHERE superseded_by_version_id IS NOT NULL;
-- no two versions replace the same predecessor
CREATE UNIQUE INDEX uq_versions_supersedes
  ON skill_versions(supersedes_version_id) WHERE supersedes_version_id IS NOT NULL;

-- the read a revoked-with-successor Console view makes: every version of one
-- skill that carries a disposition or a pointer, without scanning the table
CREATE INDEX idx_versions_disposition ON skill_versions(skill_id,state,superseded_by_version_id);

-- ============ 3. the rules hold for every future write ============
--
-- Two triggers, one per operation, rather than one trigger per rule: SQLite
-- evaluates the statements of a trigger body in order and the first `RAISE`
-- wins, so a caller that breaks two rules is told about one of them, and which
-- one is decided here rather than by the order SQLite happens to fire separate
-- triggers in. Each `RAISE` message is the rule's name, so the abort a service
-- method catches says what was violated.
--
-- These are BEFORE triggers on the table itself, so they bind every writer:
-- the service layer, a migration step, and a statement typed at the file.

CREATE TRIGGER tg_version_disposition_ins BEFORE INSERT ON skill_versions
BEGIN
  -- the iff. Both operands are 0/1, so `<>` is exactly "these disagree".
  SELECT CASE WHEN (NEW.revocation_reason IS NOT NULL) <> (NEW.state='revoked')
    THEN RAISE(ABORT,'DISPOSITION_REASON_IFF_REVOKED') END;
  SELECT CASE WHEN NEW.superseded_by_version_id IS NOT NULL
       AND NEW.state NOT IN ('published','deprecated','superseded','revoked')
    THEN RAISE(ABORT,'LINEAGE_STATE_NOT_LINKABLE') END;
  SELECT CASE WHEN NEW.superseded_by_version_id = NEW.id OR NEW.supersedes_version_id = NEW.id
    THEN RAISE(ABORT,'LINEAGE_SELF_LINK') END;
  SELECT CASE WHEN NEW.superseded_by_version_id IS NOT NULL
       AND (SELECT s.skill_id FROM skill_versions s WHERE s.id=NEW.superseded_by_version_id) <> NEW.skill_id
    THEN RAISE(ABORT,'LINEAGE_CROSS_SKILL') END;
  SELECT CASE WHEN NEW.supersedes_version_id IS NOT NULL
       AND (SELECT p.skill_id FROM skill_versions p WHERE p.id=NEW.supersedes_version_id) <> NEW.skill_id
    THEN RAISE(ABORT,'LINEAGE_CROSS_SKILL') END;
  -- §5.1b rule 5: at the moment the link is created the successor is `verified`
  -- or `published`. On an INSERT the link is always newly created, so the check
  -- is unconditional here.
  SELECT CASE WHEN NEW.superseded_by_version_id IS NOT NULL
       AND (SELECT s.state FROM skill_versions s WHERE s.id=NEW.superseded_by_version_id)
           NOT IN ('verified','published')
    THEN RAISE(ABORT,'LINEAGE_SUCCESSOR_NOT_READY') END;
END;

CREATE TRIGGER tg_version_disposition_upd BEFORE UPDATE ON skill_versions
BEGIN
  SELECT CASE WHEN (NEW.revocation_reason IS NOT NULL) <> (NEW.state='revoked')
    THEN RAISE(ABORT,'DISPOSITION_REASON_IFF_REVOKED') END;
  SELECT CASE WHEN NEW.superseded_by_version_id IS NOT NULL
       AND NEW.state NOT IN ('published','deprecated','superseded','revoked')
    THEN RAISE(ABORT,'LINEAGE_STATE_NOT_LINKABLE') END;
  SELECT CASE WHEN NEW.superseded_by_version_id = NEW.id OR NEW.supersedes_version_id = NEW.id
    THEN RAISE(ABORT,'LINEAGE_SELF_LINK') END;
  SELECT CASE WHEN NEW.superseded_by_version_id IS NOT NULL
       AND (SELECT s.skill_id FROM skill_versions s WHERE s.id=NEW.superseded_by_version_id) <> NEW.skill_id
    THEN RAISE(ABORT,'LINEAGE_CROSS_SKILL') END;
  SELECT CASE WHEN NEW.supersedes_version_id IS NOT NULL
       AND (SELECT p.skill_id FROM skill_versions p WHERE p.id=NEW.supersedes_version_id) <> NEW.skill_id
    THEN RAISE(ABORT,'LINEAGE_CROSS_SKILL') END;
  -- AT LINK CREATION, and only then. A successor is `verified` or `published`
  -- when the pointer is written; it may be deprecated, superseded or revoked
  -- later, and re-asking the question on every subsequent UPDATE of the
  -- predecessor would then refuse the `superseded → revoked` edge §5.1 admits.
  -- So the
  -- check is guarded on the pointer having just changed. `IS NOT` is SQLite's
  -- null-safe inequality: it is true when the old value was NULL, which is what
  -- "just created" means.
  SELECT CASE WHEN NEW.superseded_by_version_id IS NOT NULL
       AND NEW.superseded_by_version_id IS NOT OLD.superseded_by_version_id
       AND (SELECT s.state FROM skill_versions s WHERE s.id=NEW.superseded_by_version_id)
           NOT IN ('verified','published')
    THEN RAISE(ABORT,'LINEAGE_SUCCESSOR_NOT_READY') END;
  -- §5.1b rule 2: the reason and each half of the lineage pair are IMMUTABLE
  -- once written. Neither may be changed and neither may be cleared; a service
  -- method that is asked to change one answers `CONFLICT` before it writes, and
  -- this is the backstop under it. This is what makes `revoked` terminal without a second rule saying
  -- so: leaving `revoked` requires clearing the reason (the iff above), and
  -- clearing the reason is refused here.
  SELECT CASE WHEN OLD.revocation_reason IS NOT NULL
       AND NEW.revocation_reason IS NOT OLD.revocation_reason
    THEN RAISE(ABORT,'DISPOSITION_REASON_IMMUTABLE') END;
  SELECT CASE WHEN OLD.superseded_by_version_id IS NOT NULL
       AND NEW.superseded_by_version_id IS NOT OLD.superseded_by_version_id
    THEN RAISE(ABORT,'LINEAGE_LINK_IMMUTABLE') END;
  SELECT CASE WHEN OLD.supersedes_version_id IS NOT NULL
       AND NEW.supersedes_version_id IS NOT OLD.supersedes_version_id
    THEN RAISE(ABORT,'LINEAGE_LINK_IMMUTABLE') END;
END;
