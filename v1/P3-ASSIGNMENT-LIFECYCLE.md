# P3 — Assignment and lifecycle control

Phase P3 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
P3 built, where each binary requirement is met, what the phase deliberately did
not build, and what it does not claim.

P3 adds owner-controlled assignment and the lifecycle of approved revisions on
top of the capture/draft path P1 left and the protected Console P2 left. It adds
no second registry, no second transition table and no second conflict rule: the
Console reads verdicts the server computed (`INV-01`, `P3-FR-16`).

## 1. The two halves that are never one column

```
owner command ──▶ skill_assignment_events   DESIRED   (source: owner)
adapter/runtime ─▶ assignment_observations  OBSERVED  (source: backend|adapter|runtime)
```

`INV-02` says an owner command changes desired state only, and that nothing may
be marked `loaded`, `invoked` or `worked` as a side effect of one. That is
enforced in four places rather than asserted in one:

* two tables, written by two functions, in one module;
* `assignment_observations.source` has no `owner` member, in the type and in the
  CHECK — there is no value an owner command could put there;
* the observed-state intake is mounted OUTSIDE the console surface
  (`POST /v1/assignments/{id}/observations`, Bearer), so a console session
  cannot reach it — `test/v1p3-assignment.test.ts` drives that route with a
  session and gets `401`;
* three owner commands in a row leave `assignment_observations` with zero rows,
  which is a counted assertion rather than a reading of the code.

| module | what it owns |
|---|---|
| `src/assignment-lifecycle.ts` | the transition table, the eligibility rule, the desired and observed views, the writes, the payload fingerprint |
| `src/draft-decision.ts` | approval as a fact about a REVISION, and the union of the two approval tables |
| `src/console-view.ts` | the capability library, the capability detail and the assignment view — versioned read contracts |
| `src/idempotency.ts` | the replay, and the conflicting-payload refusal |
| `migrations/0015_assignment_and_lifecycle_control.sql` | five INSERT-only tables, five indexes, nine triggers |
| `migrations/down/0015_assignment_and_lifecycle_control.down.sql` | the reversal the round-trip gate runs |

## 2. The surfaces

| route | what it is |
|---|---|
| `GET /v1/console/fleet` | the active agents of the workspace — the closed fleet |
| `GET /v1/console/capabilities` | every lineage carrying an approved revision |
| `GET /v1/console/capabilities/{draft_id}` | its approved revisions, the fleet, the per-agent eligibility, the assignments |
| `POST /v1/console/assignments` | assign an approved revision to an agent |
| `GET /v1/console/assignments/{id}` | desired and observed, side by side |
| `POST /v1/console/assignments/{id}/activate` | activate |
| `POST /v1/console/assignments/{id}/pause` | pause |
| `POST /v1/console/assignments/{id}/revoke` | revoke — terminal |
| `POST /v1/console/assignments/{id}/revision` | revision selection, which is also rollback |
| `GET /v1/console/assignments/{id}/audit` | the lifecycle journal, structured |
| `POST /v1/assignments/{id}/observations` | the observed-state intake, Bearer only |

`SPEC.md` Appendix H carries the normative rows and `docs/API.md` the operator's
account of them.

## 3. Where each binary requirement is met

Every row is proved by `test/v1p3-assignment.test.ts` unless another file is
named. That suite drives the real router against a real database.

| id | where | proved by |
|---|---|---|
| `P3-FR-01` | `assignmentEligibility` | an unapproved revision, an agent outside the fleet, the eligible pair and a second assignment of the same lineage — four answers, one rule |
| `P3-FR-02` | `createAssignmentInTx` | the row and its first event are one transaction; the answer is the canonical assignment |
| `P3-FR-03` | `LIFECYCLE_TRANSITIONS`, `applyLifecycleActionInTx` | the table is walked CELL BY CELL on real assignments: every allowed cell succeeds, every forbidden one is `412` with the state it is still in |
| `P3-FR-04` | the same table, `revoked: []` | a revoked assignment refuses `activate` and a NEW assignment is accepted; the revoked one keeps its journal |
| `P3-FR-05` | `selectRevisionInTx`, `approvedRevisionsOf` | forward and back, then a count of revisions and approvals: nothing is deleted, and the journal holds all three events |
| `P3-FR-06` | two tables, two writers, two routes | three owner commands leave the observation table empty, and an observation claiming `source: owner` is refused |
| `P3-FR-07` | `AssignmentDetail.desired` / `.observed` | separate objects with separate `source` strings; neither is computed from the other |
| `P3-FR-08` | `validateObservation`, `noObservation` | a report missing any of the four required fields is refused; the absence of any report is `unknown` carrying all four |
| `P3-FR-09` | `withIdempotencyInTx` | the replay returns the same assignment id, carries `Idempotency-Replayed`, and leaves one row |
| `P3-FR-10` | `requireSamePayload`, `idempotency_request_digests` | the same key with another payload is `409` with `current_state` |
| `P3-FR-11` | `requireVersion` | a stale `if_version` is `412` with the state to converge on |
| `P3-FR-12` | `errorBody` in `src/http.ts` (P2), the two refusals above | both the `409` and the `412` carry the `console.v1` marker and a `current_state`, and the refetch shows the canonical state |
| `P3-FR-13` | `assignmentAudit` | four events, eleven columns each asserted present, `provenance` an object beside them |
| `P3-FR-14` | `EFFECTIVE_FROM` | every answer and every journal row carries `next_session` |
| `P3-FR-15` | the INSERT-only journal | earlier rows are byte-for-byte what they were after a later command, and the database refuses an `UPDATE` |
| `P3-FR-16` | the server computes, the page renders | the client bundle is searched for a transition entry and for the server's table; the server's table is data and `revoked` maps to `[]` |

Invariants: `INV-01` — one registry, one transition table, one eligibility rule.
`INV-02` — section 1. `INV-03` — every observation carries all four fields, and
`unknown` is never turned into success. `INV-05` — the lifecycle audit is
columns, and `provenance_json` is a payload beside them. `INV-06` — nothing is
deleted and no revision or event is rewritten. `INV-07` — `effective_from` has
one member. `INV-08` — the migration is additive and reversible and the existing
surfaces answer as they did.

## 4. What P3 changed about P2's approval, and why

**Approval became a fact about a REVISION.** `0014` gave a lineage one decision
(`draft_decisions.draft_id` is UNIQUE). `P3-FR-05` needs a lineage that can carry
more than one approved revision, because a rollback selects a PREVIOUSLY APPROVED
one and a lineage with exactly one approval has nothing to roll back to. So
`0015` adds `revision_approvals`, one row per revision. `draft_decisions` is not
altered, not rebuilt and not deprecated — it keeps meaning what it meant, the
first decision taken on a lineage — and the first approval writes both rows.

**One consequence, stated rather than left to be found.** P2 REVIEW-1's finding
`P2-R1-003` was closed by refusing a revision after ANY decision. P3 narrows that
refusal to a REJECTION, which is still terminal. The property the finding was
protecting — that no lineage reports a state its head does not have — is now
carried by the data instead: `ConsoleDraft.revision_approval` is the head's own
approval and `ConsoleInboxItem.head_approved` is the Inbox's, so an approved
lineage whose head is a newer revision reports that head as unapproved.
`test/v1p2-r1-fixes.test.ts` asserts both halves: the rejection still refuses,
and the approved lineage revises while its approved revision, its approval and
its lineage stay exactly as they were.

**That claim was checked rather than inherited, and one gap in it was closed.**
`test/v1p3-approval-property.test.ts` puts the four things the narrowing could
have broken to the registry: whether a lineage can report a state its head does
not have, whether an approved revision can be mutated, whether history can be
rewritten, and whether an unapproved head can reach an agent. What it found:

* the head's approval is a field on every surface that could be read as "this is
  approved" — the Inbox row (`head_approved`), the detail (`revision_approval`)
  and the capability (`approved_revisions`, which the head is not in);
* an approved revision survives a later edit byte for byte, with its approval and
  the lineage's first decision, and a second approval of the same revision is
  refused;
* `revision_approvals`, `draft_decisions`, `draft_revisions` and
  `skill_assignment_events` refuse an `UPDATE` and a `DELETE` in the database
  itself, so "history is not rewritten" is a property of the storage;
* an UNAPPROVED head cannot be assigned — `412 REVISION_NOT_APPROVED` — so the
  disagreement between a lineage's state and its head's cannot reach an agent;
* a rejected lineage still takes no further revision, and an approved lineage
  still cannot be rejected afterwards.

The gap was in the CONSOLE, not the data: the Inbox rendered the lineage's
`state` and not the head's `head_approved`, so the one surface an owner reads was
the one that still showed a lineage state its head might not have. The Inbox now
carries both columns and the detail names the shown revision's own approval.
Every one of those assertions fails if the property stops holding.

## 5. The eligibility and the concurrency model, stated exactly

What is delivered: an assignment names an APPROVED revision and an ACTIVE agent
of the caller's own workspace; the transition table is the one in
`src/assignment-lifecycle.ts`; the optimistic-concurrency token is the journal's
own `event_seq`, so two owners cannot both extend it and a stale one is refused
with the current state; a request for the state an assignment is already in is a
convergent noop rather than an error.

What is not promised: that `if_version` is required. A caller that omits it gets
last-writer-wins on the LIFECYCLE, bounded by the transition table — the token is
offered on every answer and honoured when sent, which is the shape the released
surfaces of this registry already use. A caller that wants the check states it.

Also not promised: cross-process serialisation beyond SQLite's. Two writers in
two processes are serialised by `BEGIN IMMEDIATE` and by
`UNIQUE(assignment_id, event_seq)`; the loser of that race gets a constraint
failure rather than a silent second head.

## 6. What P3 did NOT build

Runtime materialization and the native adapters (P4), a runtime-specific
registry, federation, external agents, and termination of an already-running
session. The observation intake is the SEAM an adapter will report through; it
materialises nothing and knows no runtime.

## 6b. The Console's P3 screen

The capability library, the capability detail, the assign control, the lifecycle
controls, revision selection and rollback, and the desired/observed rendering are
in `console/app.ts` and `src/console-page.ts`. What each part is written under:

| requirement | how the page meets it |
|---|---|
| `P3-FR-07`, `INV-02` | desired and observed are two blocks rendered by two functions from two fields; each names its own source, and neither carries the other's data attribute |
| `P3-FR-08`, `INV-03` | the observed block prints the status, the reason code, the reason, the source and the time whatever the status is — there is no branch that hides a field for an `unknown` and none that turns one into a success |
| `P3-FR-14`, `INV-07` | the screen states that every command below it takes effect in the NEXT session and that the current session's loadout is unchanged, from the server's `effective_from` through a label table |
| `P3-FR-16`, `INV-01` | every control is `!<server field>.allowed` / `.assignable`; `test/v1p3-assignment.test.ts` reads every `disabled` assignment in the client and fails on one that is anything else |
| `P3-FR-12` | an owner command refetches canonical state whatever happened, then reports the server's code and `current_state`; a refused command is reported as refused |
| `INV-05` | every response, succeeding or failing, goes through `api()`, which checks the contract version before a field is read — the P2 boundary, unchanged |

`v1/tools/e2e/console-p3-e2e.mjs` drives it in Chromium, and
`v1/tools/gates/browser-e2e.sh` runs it. The `412` is produced by moving the
assignment out from under the rendered page and the `409` by re-issuing one
command with a different note under one idempotency key; both are this server's
own refusals, and the run records the statuses the browser received. The same
file runs again with `--broken-client` against a bundle rebuilt from a copy of
`console/app.ts` whose conflict handling is undone, where its conflict probes
must fail.

## 7. Reversal

```
sqlite3 <copy-of-the-db> < migrations/down/0015_assignment_and_lifecycle_control.down.sql
```

Take a copy of the database file first. Reversal drops the five tables of `0015`,
which discards the per-revision approvals, the assignments, their lifecycle
journal, the observations and the payload fingerprints; `draft_decisions` and
everything of `0013`, `0014` and the released base are untouched.
`v1/tools/gates/reversible-migration.sh` runs the round trip on a throwaway
database.
