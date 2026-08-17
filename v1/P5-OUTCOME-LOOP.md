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
| `P5-FR-13` | `recordRollbackConfirmationInTx` | the confirming session must carry the rollback target at its exact digest, the event must be a `revision_selected` of that assignment, and a session that opened BEFORE the decision is refused with `SESSION_PREDATES_ROLLBACK` |
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

**Not delivered by BUILD-1, and stated plainly rather than implied.** The owner
CONSOLE SCREEN for outcomes — the browser page that renders the outcome view,
the create-revision-from-feedback form and the rollback confirmation — was not
built, and the P5 browser end-to-end run that would drive it does not exist. The
backend contracts those screens would consume are built, documented and tested
through the router, and the session view already returns the outcome of every
entry beside its stage; what is missing is the page and its browser run. The
browser E2E gate therefore still drives P2's and P3's screens only, which is
recorded in the gate summary rather than presented as coverage of this phase.

## 7. Reversal

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
