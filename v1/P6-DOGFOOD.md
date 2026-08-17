# P6 — the real internal dogfood

Phase P6 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
the build sessions of P6 actually produced, how each number was measured, and —
in section 7 — what each of them left open, and who closed it.

P6 is the phase that cannot be manufactured. Every earlier phase was satisfied by
building something and proving it with tests; this one is satisfied by real use,
and the contract calls fixture masquerading out by name as the thing that
invalidates it. So this document states counts that were computed from the
registry's own receipts, and states plainly where a count is missing.

## 1. The dogfood registry

The deployment real use accumulates in. It is NOT disposable and it is NOT a
gate database: it persists under `dogfood/` in the work area, outside the
evidence package and outside the repository, so a later session adds to the same
ledger rather than starting over.

```
<work-area>/dogfood/up.sh          # brings it up, or reports the one already up
<work-area>/dogfood/port           # the port it chose
<work-area>/dogfood/data/          # its database
<work-area>/dogfood/owner.key      # 0600, exchanged once through the product path
```

`up.sh` asks the operating system for a free port rather than taking a default
one, refuses if that port already answers, and refuses again unless `/health`
reports this checkout's version. Those three refusals are not decoration: a
long-lived skillonomia from another tree answers on 7431 on this host, and the
P0 smoke records what happened the first time a gate measured it. Re-running the
script re-attaches to the deployment already up; it does not start a second.

Stop it by the pid in `dogfood/registry.pid`. Not by name — pattern-killing on
this host ends the session doing the killing.

## 2. The ten skills, and why each is real

Each one is a procedure this contract has itself performed repeatedly across its
own phases. None was written to pass a check; each was written so that the next
session doing that job would do it correctly. All ten were captured through
`POST /v1/captures` from a plain workflow text, classified `reusable_procedure`
by the shipped classifier with no help, compiled into a versioned draft, read by
the owner with its semantic and security previews, and approved through the
console session the product opens.

| # | skill (title) | draft_id | revision_id | invocations | sessions | agents | runtimes | reused | multi-agent |
|---|---|---|---|---|---|---|---|---|---|
| 1 | launch a phase session under the model contract | `01M07F30ZRCD6SN92VRHK4G1E2` | `01M07F30ZRCD6SN92VRHK4G1E3` | 2 | 2 | 1 | codex | yes | no |
| 2 | run the mandatory gate battery for a phase | `01M07F3103JE9QNSVR5TE725WA` | `01M07F3103JE9QNSVR5TE725WB` | 2 | 2 | 1 | claude_code, codex | yes | no |
| 3 | close an evidence package in the frozen order | `01M07F3109J0JY3T1PJC460FGW` | `01M07F3109J0JY3T1PJC460FGX` | 2 | 2 | 1 | claude_code, codex | yes | no |
| 4 | repoint the output-SHA markers after a commit | `01M07F310ESVSB18R4WBY6CCBM` | `01M07F310ESVSB18R4WBY6CCBN` | 2 | 2 | 2 | codex | yes | yes |
| 5 | prove a clean clone installs and tests | `01M07F310KSH7N57AAV146PY7W` | `01M07F310KSH7N57AAV146PY7X` | 2 | 2 | 2 | codex | yes | yes |
| 6 | check a reviewer brief before sending it | `01M07F310Q9CV46WZBXVZ5ZRSW` | `01M07F310Q9CV46WZBXVZ5ZRSX` | 2 | 2 | 1 | claude_code, codex | yes | no |
| 7 | derive a session identity from the live transcript | `01M07F310TYYHB8CFBG8547XA3` | `01M07F310TYYHB8CFBG8547XA4` | 2 | 2 | 1 | claude_code, codex | yes | no |
| 8 | run the negative probes with a work directory outside the package | `01M07F310YZ801F6GVRS1FHMM3` | `01M07F310YZ801F6GVRS1FHMM4` | 1 | 1 | 1 | codex | no | no |
| 9 | bring up a registry on a free port and assert the version | `01M07F3113B2JMD8RNN61EANXZ` | `01M07F3113B2JMD8RNN61EANY0` | 1 | 1 | 1 | codex | no | no |
| 10 | reverse a migration on a copy of the database | `01M07F3117C4GX9X6DPXEYQCSZ` | `01M07F3117C4GX9X6DPXEYQCT0` | 1 | 1 | 1 | codex | no | no |

The sources are kept at `<work-area>/dogfood/sources/`, which is the owner's
input rather than repository content. The canonical copies are the registry's.

Three candidate procedures were considered and used; three more were considered
and are recorded in section 6 as not captured, with the reason.

## 3. How the counts were measured

`v1/tools/dogfood-metrics-check.ts`, behind `v1/tools/gates/dogfood-metrics.sh`.
Every number is a query over INSERT-only tables and none is read from a name, a
label, a file or an audit string (`P6-FR-09`). Two of its joins are the ones
worth naming:

* **Use by different agents** is read off the SESSION's `agent_id`, never off
  the receipt's `reported_by_agent_id`. The reporter is the adapter's evidence
  principal and is the same for every session, so counting reporters would count
  one agent for the whole dogfood. The agent that held the loadout is the agent
  that used the skill.
* **Reuse** is two `invoked` receipts of one lineage in two different
  `agent_sessions`. A redelivery cannot inflate it: it carries the same
  `invocation_ref` in the same session, so it collapses under the DISTINCT —
  and the gate separately asserts that no `(session, invocation_ref)` pair
  carries two receipts.

## 4. What the gate reports

BUILD-1 left it at seven of nine, with the improvement cycle and the rollback
cycle reporting zero and the gate exiting 1. That result is kept in section 7,
because it is what BUILD-1 measured. BUILD-2 drove the two cycles — sections 8
and 9 — and re-ran the same gate against the same database:

```
PASS  P6-FR-01  ten distinct real skills, each active and invoked — 10 counted
PASS  P6-FR-02  five reused across different real sessions — 7 reused
PASS  P6-FR-03  two skills used by more than one agent identity — 2 multi-agent
PASS  P6-FR-04  a real end-to-end Codex session — 4 session(s)
PASS  P6-FR-05  a real end-to-end Claude Code session — 3 session(s)
PASS  P6-FR-06  one complete improvement cycle, confirmed — 1 confirmed
PASS  P6-FR-07  one proved revision rollback — 1 proved
PASS  P6-FR-08  no counted record traces to a fixture, a seed or a hand-written row — 0 with broken provenance
PASS  P5-FR-06  no redelivery was counted twice — 0 duplicate refs
```

19 invocation receipts across 7 sessions and 2 agent identities, on both runtimes.

One line of the checker changed to reach that, and it is worth naming rather than
burying. The provenance rule read `origin` against `capture` or `revision`, and
`revision` is not a member of the vocabulary the `0013` CHECK constraint admits —
that vocabulary is `capture`, `edit`, `recompile`. So the moment this dogfood
produced its first EDITED revision, which is what an improvement cycle produces,
the checker called its provenance broken and dropped the whole lineage out of
`P6-FR-01`. The set is now the schema's own, the substance is untouched — a
counted revision names a `captures` row and that row exists — and the
counter-case a reviewer should test is that a revision with any other origin, or
with no capture, still fails.

## 5. What a real invocation proved, and what it did not

`skillonomia adapter invoke` asks the runtime to use the named skill and report
the canonical receipt line the materialised entry file carries. The receipt is
filed on the runtime having echoed the exact revision id AND the content digest
the loadout froze, and the registry refuses it if the digest is not the frozen
one. So an invocation here proves that a real `codex exec` or `claude -p`
session natively loaded that exact revision's bytes.

It is not a claim that the runtime executed the procedure end to end. One run
went further on its own and is worth recording because it is evidence rather
than decoration: asked for the marker of *derive a session identity from the
live transcript*, a Claude Code session instead carried the procedure out —
listed the transcripts of its own session home by mtime, took the newest, read
its `sessionId`, confirmed the transcript carried its own prompt, found the
provider task ledger empty, and declined to write a `task_id` it could not read,
citing the skill's own failure mode. It reported no marker, so no receipt was
filed and the entry stayed `unknown` — which is `P4-FR-11` working. The skill
was re-invoked in a later session and that run did report the marker.

## 6. Candidates judged and not captured

* **Adding a row to the session ledger** — real and repeated, but it is one
  write whose whole content is decided elsewhere. Its substance already lives in
  *derive a session identity from the live transcript*, and capturing it
  separately would be two skills over one procedure.
* **Reading the contract before starting a phase** — repeated, but it is not a
  procedure with steps, inputs and failure modes. It is a precondition.
* **Committing with a message in this tree's voice** — repeatable in form, but
  what makes it correct is judgement about the change, not a sequence. A skill
  here would be a style note, which the classifier would route to `rule`.

## 7. What each build session left open, and who closed it

Stated plainly, because an honest gap is worth more than a manufactured metric.
Every item below names the session that opened it and, where there is one, the
session that closed it. The status is the status at the SHA this file is part of.

1. **The improvement cycle (`P6-FR-06`).** Opened by BUILD-1: it created no
   descendant revision from a failure, so no comparison existed and the gate
   reported zero. The raw material was already in the dogfood database — real
   `nothing_reported` outcomes from sessions where a runtime reported no marker
   — but a `nothing_reported` is not the `failed` that `origin: failure`
   requires, so the cycle had to be driven deliberately rather than harvested.
   CLOSED by BUILD-2; section 8 tells it.
2. **The rollback cycle (`P6-FR-07`).** Opened by BUILD-1: it selected no
   rollback, and no later session confirmed one at its SHA. CLOSED by BUILD-2;
   section 9 tells it.
3. **The clean-room owner journey (`P6-FR-10` … `P6-FR-17`).** Opened by
   BUILD-1, which left `v1/tools/gates/clean-room-journey.sh` at the P0 stub
   exiting 3. CLOSED by BUILD-3: the gate drives a real browser through the
   owner path and exits 0, and its journal-based check refuses a run whose owner
   took any of the technical steps by hand.
4. **The upgrade and the reversible migration from a copy of the `v0.1.6` base
   (`P6-FR-18`, `P6-FR-19`).** Opened by BUILD-1, which ran neither. CLOSED by
   BUILD-3: `v1/tools/gates/upgrade-from-v016.sh` and
   `v1/tools/gates/reversible-migration.sh` both exit 0.
5. **The runbooks** (start, diagnose, migrate, revision rollback, application
   rollback). Opened by BUILD-1, which wrote none. CLOSED by BUILD-3, which
   wrote `v1/P6-RUNBOOKS.md` and followed the two that write on a disposable
   copy rather than describing them. BUILD-4 carried the application rollback to
   its last step, on a disposable copy; the run record for that step is the
   evidence package's.
6. **The final mandatory gate battery on one exact SHA (`P6-FR-20`).** Opened by
   BUILD-1 and left open by BUILD-2 and BUILD-3. It is BUILD-4's, and its result
   belongs to the evidence package rather than to this file, because a battery
   result is a fact about the exact SHA it ran at and this file is one of the
   inputs to that SHA.

The dogfood registry, its database, the fleet state and the ten approved skills
all persist between sessions, so each session adds to this ledger rather than
restarting it.

## 8. The improvement cycle, as it actually happened

BUILD-2 drove items 1 and 2 of that list. Neither was harvested from the rows
already present; both were driven, and the failure at the head of the first one
was reproduced before it was acted on.

**The skill.** *derive a session identity from the live transcript* — number 7 in
the table above, the procedure this contract performs at the top of every session.

**What it genuinely failed at.** Its procedure reads a `task_id` out of the
provider's task ledger at step 3 and then, at step 7, writes both identifiers
into the run records. A runtime home has no provider task ledger of its own, so
step 3 cannot be completed there — and the procedure gives a run that holds half
an answer no way to deliver it. BUILD-1 saw one claude_code session end that way:
it derived the session id, checked it against the transcript's own prompt, and
then stopped and asked the owner where the row should go, delivering nothing the
registry could file. BUILD-2 opened a new claude_code session of the same agent
on the same revision and it happened again — the run said in its own words that
it stopped rather than fill the missing half. No receipt reached the registry in
either run, so the entry stayed `unknown` and the closure recorded
`nothing_reported`, which is `P4-FR-11` and `P5-FR-04` behaving correctly and is
not the same thing as a failure being on the record.

So the owner put it on the record: `POST /v1/console/outcomes`, a `failed` with
`source: owner`, `evidence_class: owner_confirmation`, and a
`confirmation_source` naming the runtime transcript it was read in. That is the
contract's "failure or specific owner observation" — and it is both, because
what the owner recorded is a run that was applied and did not do what it was
written to do.

**What the revision changed.** `POST /v1/console/outcomes/{id}/revision` with
`origin: failure`, which the registry refuses on an outcome that is not `failed`.
Three sections were edited through the same path an ordinary owner edit takes, so
the semantic and security previews both ran on it and it was NOT approved by
being created:

* step 3 gained the missing branch — a ledger with no row for the role is
  recorded as unavailable, with the reason, and the run goes on;
* step 7 asks for the values that WERE established, each read or marked
  unavailable, and says not to stop at the missing part;
* the outputs gained the run's own final report, and the failure modes gained the
  one that had just been observed.

Nothing in the edit mentions the receipt line, the adapter or the marker. The
goal was stated in the same call, before the new revision had run anywhere: a
claude_code session of this agent against a home with no ledger row completes the
procedure and delivers its result instead of ending in a question.

**What the new session did differently.** The owner approved revision 2 and moved
the assignment to it, which answered `effective_from: next_session`; the next
session's loadout carried revision 2 at the digest the registry froze. That
session reported the canonical receipt line, the receipt was filed against the
exact revision and digest, and the adapter filed `worked` from the same output.
It also did the thing the edit was for, which is the part worth reading rather
than counting: it wrote a run record naming `task_id: null` with
`task_id_status: unavailable` and a paragraph of reason beginning "The provider
task ledger of this runtime home holds no row for this role", and it delivered
the session id it had derived. The run that failed had the same session id in
hand and delivered none of it.

`POST /v1/console/comparisons` then named the two outcomes and nothing else. The
registry read the lineage, found the goal it had recorded in advance, checked
that both runs were the same skill, the same agent and the same runtime kind, and
returned `improved` with `FAILURE_TO_WORKED`. The caller could not have named
that verdict (`P5-FR-12`).

**What this does not claim.** The defect is intermittent, not deterministic:
revision 1 also produced a `worked` in a claude_code session and in a codex one.
Two of the three claude_code runs of revision 1 ended with no result; the one run
of revision 2 delivered one. That is one comparison, on one agent, on one runtime
kind — which is exactly what the registry says it is, and the reason
`decideComparison` refuses to call two runs on different agents or runtimes a
before and an after at all.

## 9. The rollback cycle

Revision 2 has been seen on one runtime kind. Before the fleet carries a revision
proved in one place, the owner selected the earlier approved revision again —
P3's `select_revision` on the same assignment, answering `effective_from:
next_session`, leaving revision 2 approved and leaving the history alone
(`INV-06`).

A NEW session then confirmed it, and the confirmation is the part the registry
refuses to take on trust. A real codex session of the same agent opened after
that decision, its loadout carried revision 1 at the frozen digest, the runtime
invoked it and reported the receipt line, and
`POST /v1/sessions/{id}/rollback-confirmations` named the lifecycle event behind
the rollback. The registry checked that the event really was a `revision_selected`
of this entry's assignment, that the selection went BACK, that this session
carries the revision it selected and that it opened after the decision — the four
refusals `P5-FR-13` is made of — and filed `rolled_back` with
`evidence_class: rollback_confirmation`. This is that mechanism on real dogfood
rows rather than on a test's fixtures.

The assignment is left on revision 1, which is what a rollback means. Revision 2
remains approved and selectable.

`v1/tools/dogfood/loop-driver.mjs` is the driver. It decides nothing: each step
is one console call, the verdict is the registry's, and the observation, the goal
and the edited sections — the parts a script must not invent — are files the
owner wrote.

## 10. A statement the dogfood corrected

`v1/tools/p5-outcome-consistency-check.ts` refused the database this cycle
produced, and it was right to be pointed at it: that is what it is for. Its
`nothing_reported` statement read plain coexistence — an entry holding a
`nothing_reported` beside any other outcome was a contradiction. An owner who
reads a transcript AFTER a session has ended and records what the run failed to
do produces exactly that pair, and both rows are true: one says nothing had been
reported by the time the session closed, the other says what the owner later saw
and names where it saw it. The statement now compares against the outcomes that
existed BEFORE the closure wrote its row. It still refuses the thing it was
written to refuse — a closure claiming nothing was reported for an entry that
already held an outcome. The correction narrowed one statement and added none.

## 10b. The clean-room walkthrough is photographed, and each picture resolves

P6 REVIEW-1 finding `P6-R1-001`: the walkthrough passed its gate and left a
thorough journal, and contract section 10's P6 evidence list asks for something
the journal is not — screenshots, with correlating backend and runtime receipts.
Section 8.1 does not let a description of a screen stand in for the screen.

`v1/tools/e2e/clean-room-journey.mjs` now photographs the six states it was
already asserting: the draft with its two previews, the exact revision the owner
approved, the assignment activated on that revision, the session with its stages
and the outcome under them, the new revision carried by a new session, and the
rollback confirmed by a third. Each capture writes the image, the rendered text of
that same page, and a manifest entry naming the identifiers the registry itself
returned for that state — draft, revision, assignment, session, receipt and
outcome — with each identifier marked according to whether it is readable on the
screen or carried behind it as an attribute. Most are on the screen, and the ones
that sit behind it are marked as such rather than counted as if a reader of the
picture could check them; the manifest is where that division is written down.

`v1/tools/p6-clean-room-check.ts` reads that manifest and recomputes what it
claims: the digest of every image, the digest of every rendered page, and the
presence of every identifier in the text it just read. The gate then damages two
copies — one with a required state removed, one with a single byte flipped inside
an image whose digest is left alone — and requires a refusal for each. The image
bytes and the rendered text are swept for credential shapes as well, because the
owner holds no key and the console cookie is `HttpOnly`, and a property that good
is worth measuring rather than assuming.

## 11. Why this file ends in the plain present

The [B-4] provenance rule in `test/docs-guard.ts` reads the sentence AROUND the
words it matches, and it skips a sentence written in the past or in the
negative: such a sentence tells what something used to do rather than where a
number comes from today. Both halves of that are right, and together they have a
consequence for the LAST sentence of any document. A match may begin in the
closing words of a file and end in text appended after it, so the closing
sentence's exemption reaches over the file's end. A document that ends on a
hedged sentence hides from the guard whatever is written next.

Section 10 ended that way. Its closing sentence bundled the narration — "it was
written to refuse", "nothing was reported", "already held an outcome" — with a
present claim about the checker's statements, and it ended on the word `count`.
The planting proof in `test/p14-r2-invariants.test.ts` demonstrated the
consequence: a provenance claim planted at the end of this file was swallowed by
that sentence and went unread, which is the one outcome that proof forbids. The
sentence is now two sentences, the narration in one and the present claim in the
other.

So this file keeps a rule about its own last line, and the rule is short: the
last sentence of this document states a fact about today, in the plain present,
and it carries none of the nouns the provenance rule keys on. A session that
appends to this file writes its new material as its own sentences and leaves the
closing one in that form.
