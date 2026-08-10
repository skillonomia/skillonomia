-- SKILLONOMIA — a transfer names its recipient, and the recipient has a TYPE.
--
-- WHAT WAS WRONG. Until now the only way a skill moved from the agent that
-- wrote it to an agent that runs it was `skill.request_adoption`: the RECIPIENT
-- asked, and the row it produced named an `adopter_agent_id` — a local row id,
-- in this database, with no type. That shape has exactly one case in it, and it
-- is the case where sender and recipient are two rows of one SQLite file. In
-- V-2 the recipient is outside the owner's perimeter and is not a row here at
-- all, and a model whose recipient is "a foreign key into `agents`" cannot say
-- so. Adding the type later would mean rewriting every row that already
-- recorded a movement — which is the one thing an INSERT-only journal cannot do.
--
-- So the recipient becomes a first-class TYPED value now, while the only
-- implemented type is still the local one. `local_agent` works end to end;
-- `remote_fleet` is DECLARED and refused with "not implemented in V-1" rather
-- than silently treated as local. A declared type that quietly behaves like
-- another type is worse than an absent one: it produces records that claim a
-- movement the registry never performed.
--
-- THIS MIGRATION IS THE FIRST TO ADD TABLES. Every earlier delta was a column,
-- and each said "the 20-table shape of Appendix D.1 is unchanged". That is no
-- longer true and the sentence is not repeated: two tables are added, and
-- Appendix D states the new object counts. Nothing existing is dropped, no
-- constraint of D.1 is relaxed, and no row is lost. What is REBUILT is
-- `receipt_events`, for the one reason SQLite gives no alternative to: a CHECK
-- constraint cannot be altered in place, and the transfer needs an event kind.
--
-- ---------------------------------------------------------------------------
-- `transfer_grants` — the permission triple, and NOT a new role.
--
-- The workspace roles (`owner`, `admin`, `reviewer`, `member`) and the principal
-- types (`human`, `agent`, `service`) of D.1 are untouched. Approvals stand on
-- those roles and are not rewritten. What is added is one narrow concept: a
-- GRANT, the triple (agent, action, recipient scope).
--
-- The actions are exactly the steps of the transfer loop — `receive`, `assign`,
-- `activate`, `revoke`, `report_outcome` — and the list is closed by CHECK, so
-- an action nobody designed cannot be granted. The recipient scope is the same
-- closed set of recipient types the transfer itself uses, which is what makes
-- the V-2 ambassador ONE ROW OF DATA: an agent permitted to `assign` into a
-- `remote_fleet` is expressible today, on this schema, with no new column, no
-- new enum member and no branch in the code.
--
-- `granted_by_type` and `granted_by_role` are SNAPSHOTS, and they are the point
-- of [I-5]. In a single-owner deployment almost every grant is made by an agent
-- holding an administrative role, not by the human owner. "Granted by an
-- administrator" and "granted by the owner in person" are different facts, and a
-- reader must be able to tell them apart from the record rather than by looking
-- up who that agent is today.
--
-- ---------------------------------------------------------------------------
-- `transfers` — the operation, with its whole signature stored.
--
-- One row is one transfer, and it carries everything the operation was: the
-- skill VERSION, the SENDER (with the type and role it held), the RECIPIENT
-- (type and identifier, never an untyped id), the PERMISSION it ran under (the
-- grant, its action, and the principal that issued it, again with type and
-- role), the §5 arrival MARKER of that version, and the RECORD it left — the
-- receipt and the `event_seq` of the event written in the same transaction.
--
-- The principal columns are copies of values that also live in `agents`,
-- `workspace_memberships` and `transfer_grants`. That duplication is deliberate:
-- those three are mutable, this table is INSERT-only, and a transfer must keep
-- saying what was true when it happened. A record whose meaning changes when a
-- membership is edited is not a record.
--
-- ---------------------------------------------------------------------------
-- `receipt_events` — one new event kind, and the recipient ON the event.
--
-- `transferred` is not `delivered`. `delivered` means the package reached the
-- adopter's runtime and is written on the adopter's own authenticated call;
-- `transferred` means the registry recorded a sender's decision to send it. The
-- transfer is an INTENT, and writing it as `delivered` would be the registry
-- asserting a fact nobody observed. It is written by the registry on the
-- sender's authority and never by the receipt's adopter.
--
-- `recipient_json` carries the typed recipient on that INSERT-only row, for the
-- same reason `environment_json` was moved there by D.1d: the migration counter
-- reads the recipient, and a count taken from a mutable row is a reading of
-- whoever wrote last.
PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;

CREATE TABLE transfer_grants(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('receive','assign','activate','revoke','report_outcome')),
  recipient_scope TEXT NOT NULL CHECK(recipient_scope IN ('local_agent','remote_fleet')),
  granted_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  granted_by_type TEXT NOT NULL CHECK(granted_by_type IN ('human','agent','service')),
  granted_by_role TEXT NOT NULL CHECK(granted_by_role IN ('owner','admin','reviewer','member')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(agent_id,action,recipient_scope)
);

CREATE TABLE transfers(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  sender_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('human','agent','service')),
  sender_role TEXT NOT NULL CHECK(sender_role IN ('owner','admin','reviewer','member')),
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('local_agent','remote_fleet')),
  recipient_ref TEXT NOT NULL CHECK(length(recipient_ref) BETWEEN 1 AND 120),
  grant_id TEXT NOT NULL REFERENCES transfer_grants(id) ON DELETE RESTRICT,
  grant_action TEXT NOT NULL CHECK(grant_action IN ('receive','assign','activate','revoke','report_outcome')),
  grantor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  grantor_type TEXT NOT NULL CHECK(grantor_type IN ('human','agent','service')),
  grantor_role TEXT NOT NULL CHECK(grantor_role IN ('owner','admin','reviewer','member')),
  arrival_marker TEXT NOT NULL CHECK(length(arrival_marker)=22),
  adoption_receipt_id TEXT NOT NULL UNIQUE REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  receipt_event_seq INTEGER NOT NULL CHECK(receipt_event_seq>=1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_transfers_version ON transfers(skill_version_id);

-- the INSERT-only triggers are dropped BEFORE the table they guard, so that the
-- rebuild never depends on whether SQLite fires a delete trigger for the rows
-- DROP TABLE removes. They are recreated verbatim below.
DROP TRIGGER tg_revents_no_upd;
DROP TRIGGER tg_revents_no_del;

CREATE TABLE receipt_events_p14(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('delivered','attempted','adopted','failed','rolled_back','transferred')),
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  evidence_json TEXT,
  failure_report_json TEXT,
  rollback_report_json TEXT,
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL,
  environment_json TEXT,
  recipient_json TEXT,
  UNIQUE(adoption_receipt_id,idempotency_key),
  UNIQUE(adoption_receipt_id,event_seq),
  UNIQUE(adoption_receipt_id,event)
);

INSERT INTO receipt_events_p14(id, adoption_receipt_id, event, event_seq, evidence_json,
       failure_report_json, rollback_report_json, server_at_ms, idempotency_key, environment_json, recipient_json)
  SELECT id, adoption_receipt_id, event, event_seq, evidence_json,
         failure_report_json, rollback_report_json, server_at_ms, idempotency_key, environment_json, NULL
    FROM receipt_events;

DROP TABLE receipt_events;
ALTER TABLE receipt_events_p14 RENAME TO receipt_events;
PRAGMA legacy_alter_table=OFF;

-- identical to D.1's partial index and D.1's two triggers, on the rebuilt table
CREATE UNIQUE INDEX uq_receipt_terminal ON receipt_events(adoption_receipt_id) WHERE event IN ('adopted','failed');
CREATE TRIGGER tg_revents_no_upd BEFORE UPDATE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_del BEFORE DELETE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

-- a transfer, once recorded, is not edited or withdrawn — the same rule the
-- receipt journal lives under, for the same reason
CREATE TRIGGER tg_transfers_no_upd BEFORE UPDATE ON transfers BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_transfers_no_del BEFORE DELETE ON transfers BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
