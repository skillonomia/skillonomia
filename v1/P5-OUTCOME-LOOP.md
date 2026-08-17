# P5 — Outcomes and the revision loop, end to end

Phase P5 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
P5 built, where each binary requirement is met, what it deliberately did not
build, and what it does not claim.

P4 ended the chain at `invoked`: a runtime read an exact revision and called it.
P5 answers the next question — whether calling it helped — and then closes the
loop: a failure becomes a new revision, that revision faces the same review and
the same approval, it is reassigned to a new session, the two runs are compared,
and a rollback is confirmed by a session that actually carries the rolled-back
revision.

## 1. An outcome is not a stage, and that is the whole design

```
runtime receipt ──▶ runtime_receipts        STAGE     proposed | loaded | invoked   (P4)
runtime outcome ──▶ session_outcomes        OUTCOME   worked | failed | rolled_back | nothing_reported
owner's word    ──▶ session_outcomes        OUTCOME   with source `owner`, labelled as such
session ended   ──▶ session_closures        the fact that produces `nothing_reported`
```

Nothing in this phase writes `assignment_observations`. The observed STAGE of an
entry stays exactly what a `0016` receipt made it, so an owner who confirms that
a skill worked has not caused the registry to claim that a runtime loaded one
(`INV-02`, `P4-FR-13`). The two vocabularies stay apart on purpose: one is about
what a runtime did with bytes, the other about whether the work succeeded.

| module | what it owns |
|---|---|
| `src/outcome-loop.ts` | the four values, the receipt rules, replay and conflict, closure, rollback confirmation, lineage, comparison |
| `migrations/0017_outcomes_and_the_revision_loop.sql` | five INSERT-only tables, six indexes, ten triggers |
| `migrations/down/0017_…down.sql` | the reversal the round-trip gate runs |
| `src/adapter-cli.ts` | `skillonomia adapter invoke` now files the outcome; `adapter close` reports the session ended |
| `console/app.ts` | the owner's outcome region: an outcome with its provenance, the revision form, the comparison, the rollback |
| `v1/tools/e2e/console-p5-e2e.mjs` | the browser run of the owner's path through that region |
| `v1/tools/p5-outcome-consistency-check.ts` | the stage/outcome statements a row-local CHECK has no way to make |

## 2. The surfaces

| route | what it is |
|---|---|
| `POST /v1/sessions/{id}/outcomes` | the runtime's outcome of ONE invocation — evidence principal only |
| `POST /v1/sessions/{id}/close` | the session ended; each entry with no outcome becomes `nothing_reported` |
| `POST /v1/sessions/{id}/rollback-confirmations` | a NEW session carrying the rolled-back revision confirms it |
| `POST /v1/console/outcomes` | the owner's explicit confirmation, carrying its source |
| `POST /v1/console/outcomes/{id}/revision` | a new draft revision out of a failure or a remark |
| `POST /v1/console/comparisons` | old against new, with the verdict computed |
| `GET /v1/console/capabilities/{id}/outcomes` | the whole history of one lineage |

`SPEC.md` Appendix D.1q carries the normative schema and Appendix H the rows;
`docs/API.md` carries the operator's account.

## 3. Where each binary requirement is met

Proved by `test/v1p5-outcome-loop.test.ts` unless another file is named. The two
runtime rows are proved by REAL runtime runs, because contract section 9 says
outright that a mocked adapter test never substitutes for one.

| id | where | proved by |
|---|---|---|
| `P5-FR-01` | `OUTCOMES`, `0017` | the vocabulary is four members in the code, and the CHECK refuses a fifth in the database — the test plants one by raw SQL and the write is refused |
| `P5-FR-02` | `recordOutcomeReceiptInTx` | a `proposed` entry and a `loaded` entry are each refused a `worked` with `NO_INVOCATION_EVIDENCE`, and nothing is written by either refusal; the outcome must name an `invoked` RECEIPT by its own `invocation_ref` and `runtime_session_ref`. The owner path is a separate route writing `source: owner` with a required `confirmation_source`, and the test asserts it produces no observation and no receipt |
| `P5-FR-03` | `validateOutcomeReceipt` | `reason_code` must be an UPPER_SNAKE machine code, `reason` is required, and the stored row names the invocation receipt it rests on and carries the runtime kind and the transcript excerpt in its payload |
| `P5-FR-04` | `closeSessionInTx` | a session closed with nothing said yields `nothing_reported` for an entry that reached `invoked` — the strong case, not the easy one. Closing twice is one closure; a late outcome is `409` rather than a rewrite |
| `P5-FR-05` | `recordRollbackConfirmationInTx` | the `rolled_back` row names the rollback action and its target revision and is a NEW row; the `failed` before it is read back unchanged, and the lineage history shows `failed`, `failed`, `rolled_back` in order |
| `P5-FR-06` | `replayOrConflict` | one `outcome_ref` redelivered with the same payload returns the same row and the same digest with `replayed: true`, and the table still holds one row — with no idempotency key involved, because a redelivery carries the reporter's ref rather than the caller's key |
| `P5-FR-07` | `replayOrConflict`, `refuseOnConflict` | a contradicting redelivery is `409`, the stored row is byte-identical afterwards, and the contradiction is a row of `outcome_conflicts` carrying the whole claim and its own digest. The conflict is COMMITTED and then refused — see section 4 |
| `P5-FR-08` | `createRevisionFromOutcome` | the new revision's lineage row names the parent revision, the source outcome and the source RECEIPT; the parent's digest is unchanged; `origin: failure` on an outcome that is not `failed` is `412` |
| `P5-FR-09` | `reviseDraftInTx` | the same function an ordinary edit calls, so the semantic and security previews both ran; the new revision is NOT approved by being created, and assigning it before approval is `412` |
| `P5-FR-10` | P3's `selectAssignmentRevision` | the reassignment answers `effective_from: next_session`, the running session's loadout is byte-identical afterwards, and the next session carries the new revision |
| `P5-FR-11` | `compareInTx` | the comparison names the exact old and new revision ids and numbers, the baseline's reason code, both outcomes and the goal |
| `P5-FR-12` | `decideComparison` | `improved` needs the same lineage, the same agent and the same runtime kind AND a transition to `worked`; a different agent or a different runtime is `not_comparable`, a candidate that did not work is `not_improved`, and a baseline that never failed is `not_improved`. A candidate with no lineage row — no goal stated in advance — is refused outright |
| `P5-FR-13` | `recordRollbackConfirmationInTx` | the confirming session must carry the rollback target at its exact digest, the event must be a `revision_selected` of that assignment whose selection went BACK — a forward update is refused with `NOT_A_ROLLBACK_ACTION` and nothing is appended — and a session that opened BEFORE the decision is refused with `SESSION_PREDATES_ROLLBACK`, including when it shares the decision's millisecond, while a session opened after it in that same millisecond still confirms |
| `P5-FR-14` | the routes | every answer carries `contract` — `outcome.v1` on the machine surface, `console.v1` on the owner's — and the conflict refusal carries the structured conflict in `current_state` rather than a sentence |
| `P5-FR-15` | `v1/tools/gates/runtime-codex.sh`, `v1/tools/gates/runtime-claude-code.sh` | a real `codex exec` and a real `claude -p` session, each reaching `outcome worked` filed from the runtime's own output, with the replay, the conflict and the `nothing_reported` closure exercised on the same real session |

Invariants: `INV-01` — one canonical model; the adapter stores nothing and the
console reads. `INV-02` — section 1, and the three machine intakes are behind the
same evidence principal P3 and P4 require. `INV-03` — an entry with no outcome
reports `unknown` with all four fields. `INV-05` — every answer is columns behind
a version marker. `INV-06` — all five tables are INSERT-only, asserted against
the database. `INV-07` — a reassignment and a rollback both take effect in the
next session. `INV-08` — `0017` is additive and reversible. `INV-09` — the owner
captures, approves, assigns, confirms and compares; no manifest, package, key or
runtime config is touched.

## 4. Why the conflict is written before it is refused

`P5-FR-07` asks for two things at once: the contradicting receipt must not
overwrite its predecessor, and the conflict must BECOME a structured state
carrying its own evidence. The obvious implementation — detect the contradiction
inside the transaction and throw — satisfies the first and destroys the second,
because the refusal rolls the conflict row back with it. That is how "the
conflict is recorded" quietly turns into "the conflict was refused and
forgotten".

So the conflict row is written, the transaction commits, and the refusal is
raised outside it from the value that came back (`Registry.refuseOnConflict`).
The caller still gets a `409`; the registry still has the evidence. The test
asserts both halves: the status, and the row.

## 5. What is synthetic, and where the line is

Contract section 10 permits synthetic fixtures for P5's automated tests and only
there. The line this phase drew:

* **`test/v1p5-outcome-loop.test.ts` is synthetic in exactly one respect** — the
  runtime receipts are filed by a registered evidence principal inside the test
  process rather than by a real `codex` or `claude` binary. Everything else in
  it is the real router, the real service and a real database, and the two
  end-to-end loop tests at its foot walk the whole path for each runtime kind.
* **The two runtime gates are not synthetic at all.** They drive the real
  binaries, and the outcome each files is lifted from the runtime's own output.
* **Neither is dogfood.** Dogfood is P6's job: real internal skills, real
  sessions, real reuse. It cannot be manufactured here and this phase does not
  claim any of it.

The outcome the adapter files after a real run says `worked` when the runtime
reported the canonical receipt line of the revision the session froze. That is
the task the probe skill defines, and it is a fact the adapter can establish
from the runtime's own output — it is deliberately not the runtime grading
itself, and it is deliberately not a claim that the skill was useful. What it
proves is that the outcome path carries a real runtime's real result end to end.

## 6. What P5 did NOT build

Machine-learned quality scoring, marketplace ranking, cross-tenant analytics, a
general observability platform and a statistical experiment system — all five are
P5's own OUT list. A comparison here is two rows and a computed verdict, not an
experiment framework.

BUILD-1 finished without the owner's SCREEN and said so. BUILD-2 built it, and
section 7 below is what it built; the paragraph BUILD-1 wrote here is kept as
history in evidence/P5/03-not-delivered.md, which records the state of the
package at `57f5764f71d4a57f07cb5f1c452c05f51dc8d592` rather than at the SHA this
document closes on.

## 7. The owner's screen, and the browser run of it

Built by BUILD-2. `console/app.ts` gains a third region under the capability
detail, and `src/console-page.ts` the empty box it fills:

| what the owner does there | what it reads or sends |
|---|---|
| reads an outcome with its provenance | the word the registry filed, its reason code, its reason, its source, its evidence class, the invocation receipt beneath it, the outcome digest and the time — and a contradicting redelivery beside it as its own row |
| makes a new revision out of a failure or a remark | `POST /v1/console/outcomes/{id}/revision`, carrying the observation and the goal |
| sees where a revision came from | the lineage row: parent revision, source outcome, source receipt, the goal stated in advance |
| compares an old run with a new one | `POST /v1/console/comparisons`, and then the registry's verdict, its reason code and whether the two runs were comparable |
| rolls back | a target read back before it is confirmed, then P3's `select_revision` on the assignment — and the `rolled_back` row a later session filed, naming the target and the lifecycle event |

Four properties of that region are the ones a reviewer should hold it to, and
each has a check behind it rather than a sentence:

1. **The verdicts are the server's.** The region prints `outcome`, `verdict`,
   `verdict_reason_code` and `comparable` as fields.
   `test/v1p5-outcome-loop.test.ts` reads `console/app.ts` and refuses a
   comparison of an outcome or a verdict against a literal, so the shape a
   client-side rule would take fails the suite (`P5-FR-12`, `P3-FR-16`).
2. **A control is a rendering of a server boolean.** The rollback confirmation
   is gated by `actions.select_revision.allowed`, which is the same verdict P3's
   control reads, and the same test asserts the form of every `disabled` line in
   the client.
3. **An outcome the backend did not call a success is not shown as one.** The
   word on the screen is the field; a `nothing_reported` reads as itself with its
   reason code, its source and its time (`INV-03`, `P5-FR-04`).
4. **The region writes no observed state.** It calls the owner's three
   mutations. Filing a receipt, an outcome, a closure or a rollback confirmation
   stays on the machine surface behind an evidence principal, and the test
   asserts the client names no route under the machine session prefix (`INV-02`,
   `P4-FR-13`).

`v1/tools/e2e/console-p5-e2e.mjs` drives that path in Chromium against a real
deployment: it captures a workflow, approves it, assigns it, opens a real session
as a registered evidence principal, files `loaded`, `invoked` and a `failed`
outcome with a contradicting redelivery behind it, and then the browser does the
owner's part — read the outcome, make the revision, review and approve it,
reassign it, compare the runs, prepare and confirm the rollback, and read the
confirmation a later session filed. Five outcomes come out of that loop:
`failed`, `worked`, `worked`, `rolled_back`, `nothing_reported`.

The run then happens again with `--broken-client`, against a bundle rebuilt from
a copy of `console/app.ts` with three changes undone — the refetch-and-report
after an owner command, the rendering of the registry's verdict, and the honest
rendering of the outcome word. Its probes are required to go red there while its
controls stay green, which is the pattern P2 and P3 both used: a check nobody has
seen fail is a check nobody has tested. `v1/tools/gates/browser-e2e.sh` runs both,
so the gate now covers P2, P3 and P5 in seven runs.

## 8. The stage/outcome consistency validator

Deliverable 8. BUILD-1 closed it by narrowing the claim to the CHECK constraints
of `0017` and the service code above them, and recorded the narrowing. BUILD-2
judged the narrowing incomplete for one reason: a CHECK is row-local. It can
require a `worked` to name an invocation receipt; it has no way to say that the
receipt named belongs to the same session and the same entry, that the
`invocation_ref` matches, that a `rolled_back` names a lifecycle event that
really selected the revision it claims, that the selection went BACK rather than
forward, that the confirming session opened after that decision, or that a
comparison marked comparable rests on two sessions of one agent and one runtime
kind. Those are joins.

`v1/tools/p5-outcome-consistency-check.ts` is the join half and stops there: it
takes a database path, opens it read-only, runs fifteen statements as queries
that have to return no rows, prints the offending rows when one does, and exits 0
or 1. It has no configuration, no schedule and no output format — the
observability platform and the experiment system on P5's OUT list are what it is
written to not become. Point it at the database a runtime gate or the browser
gate leaves behind and it reads rows a real run produced.

## 9. Reversal

```
sqlite3 <copy-of-the-db> < migrations/down/0017_outcomes_and_the_revision_loop.down.sql
```

Take a copy of the database file first. Reversal drops the five tables of
`0017`, which discards the outcomes, the recorded conflicts, the lineage claims
and the comparisons. The revisions themselves are `0013` rows and survive: a
revision created from a failure is still a revision, still approved, still
assignable — what is lost is the statement that it descends from that failure.
The sessions, loadouts and receipts of `0016` are untouched, so the chain through
`invoked` survives this reversal in full.
`v1/tools/gates/reversible-migration.sh` runs the round trip on a throwaway
database.
