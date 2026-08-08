-- SKILLONOMIA — revocation notices on the §5.2 delivery machine.
--
-- §6 surface 11 and §5.1's tail table both promise that revoking a version
-- notifies its active adopters "through the delivery machine". The machine
-- (queue, lease, backoff, sweeper, dead letters, endpoint health) drives
-- `adoption_requests`, and every row in it described one thing: an adoption
-- request. A revocation notice is a different message to the same endpoint, so
-- the row has to say which it is — otherwise an adopter cannot tell "here is a
-- package you asked for" from "the package you are running has been revoked",
-- and `skill.adopt` cannot refuse a row that was never a request.
--
-- Strictly additive: one column, with a default that makes every existing row
-- exactly what it already was. No table is rebuilt, no constraint is relaxed,
-- and the 20-table shape of Appendix D.1 is unchanged.
ALTER TABLE adoption_requests ADD COLUMN notification_kind TEXT NOT NULL DEFAULT 'adoption'
  CHECK(notification_kind IN ('adoption','revocation'));
