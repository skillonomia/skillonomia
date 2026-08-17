# P6 — the real internal dogfood

Phase P6 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
BUILD-1 of P6 actually produced, how each number was measured, and — at its foot
— what BUILD-1 did not deliver.

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

## 4. What the gate reports today

```
PASS  P6-FR-01  ten distinct real skills, each active and invoked — 10 counted
PASS  P6-FR-02  five reused across different real sessions — 7 reused
PASS  P6-FR-03  two skills used by more than one agent identity — 2 multi-agent
PASS  P6-FR-04  a real end-to-end Codex session — 3 session(s)
PASS  P6-FR-05  a real end-to-end Claude Code session — 2 session(s)
FAIL  P6-FR-06  one complete improvement cycle, confirmed — 0 confirmed
FAIL  P6-FR-07  one proved revision rollback — 0 proved
PASS  P6-FR-08  no counted record traces to a fixture, a seed or a hand-written row
PASS  P5-FR-06  no redelivery was counted twice — 0 duplicate refs
```

The gate exits 1 on that, which is the honest result and is what a later session
inherits. It was not softened to report the seven as a pass.

17 invocation receipts across 5 sessions and 2 agent identities, on both runtimes.

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

## 7. What BUILD-1 did NOT deliver

Stated plainly, because an honest gap is worth more than a manufactured metric.

1. **The improvement cycle (`P6-FR-06`).** No descendant revision was created
   from a failure, so no comparison exists and the gate reports zero. The raw
   material is present in the dogfood database — real `nothing_reported`
   outcomes from sessions where a runtime reported no marker — but a
   `nothing_reported` is not the `failed` that `origin: failure` requires, so
   the cycle has to be driven deliberately rather than harvested.
2. **The rollback cycle (`P6-FR-07`).** No rollback was selected and no later
   session confirmed one.
3. **The clean-room owner journey (`P6-FR-10` … `P6-FR-17`).**
   `v1/tools/gates/clean-room-journey.sh` is still the P0 stub and still exits 3.
4. **The upgrade and rollback from a copy of the `v0.1.6` base
   (`P6-FR-18`, `P6-FR-19`)** were not run in this session.
5. **The runbooks** (start, diagnose, migrate, revision rollback, application
   rollback) were not written.
6. **The final mandatory gate battery on one exact SHA (`P6-FR-20`)** was not
   run by BUILD-1.

A later session continues from this SHA. The dogfood registry, its database, the
fleet state and the ten approved skills all persist, so the work above adds to
this ledger rather than restarting it.
