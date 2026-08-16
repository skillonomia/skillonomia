# P1 — Capture → Draft backend/compiler

Phase P1 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
P1 built, where each binary requirement is met, and what the phase deliberately
did not build.

P1 is the first phase of this contract that changes product behaviour. It adds
the path that takes a workflow, an agent session or a supported native skill and
answers with a versioned draft or a structured refusal — inside the existing
Registry, with no second store and no duplicated logic (`INV-01`).

## 1. The path, end to end

```
capture → REDACT → classify → compile → semantic + security preview → store → audit
```

Redaction is the second stage on purpose. Everything after it — the classifier,
the compiler, the previews, the rows in SQLite, the audit and the response on the
wire — operates on the redacted text, and the original is a parameter of one
function call that outlives nothing.

| module | what it owns |
|---|---|
| `src/capture.ts` | the three input shapes, the native import for both runtimes, the pipeline, the storage and the reads |
| `src/redaction.ts` | credential removal at the boundary, and the findings a preview shows |
| `src/skillability.ts` | the classifier: seven categories, a boolean and a reason code |
| `src/draft.ts` | the compiler, the content digest, the semantic review and the security review |
| `migrations/0013_capture_and_draft_revisions.sql` | three INSERT-only tables, three indexes, six triggers |
| `migrations/down/0013_capture_and_draft_revisions.down.sql` | the reversal, which the round-trip gate runs |

### What it reuses rather than restates

* `src/gates.ts` — `SECRET_PATTERNS` and `isHighEntropyToken` (SPEC Appendix G.1
  and G.2) are what the package secret scan already applies, so a value gate 2
  refuses is a value redaction removes. The `⟦REDACTED:…⟧` token is that module's
  own convention, so a redacted capture reads to the scanner exactly as a
  redacted package does. The risk classes of the security preview — privilege
  escalation, the URL denylist, the prompt-injection patterns — are the published
  ones of Appendix G.3, G.4 and G.5.
* `src/activation.ts` — the native layouts. Import asks that module where a
  runtime keeps a skill instead of carrying a second table of the same fact, so a
  file this registry could not have written is refused rather than imported.
* `src/jcs.ts` — the canonical form the content digest is taken over.
* `src/journal.ts` and `src/identity.ts` — every new column is classified in the
  tables those modules own, which is why a column added here cannot be filed
  quietly.

## 2. The surfaces

| MCP tool | REST |
|---|---|
| `capture.submit` | `POST /v1/captures` |
| `draft.list` | `GET /v1/drafts` |
| `draft.get` | `GET /v1/drafts/{draft_id}`, `GET /v1/drafts/{draft_id}/revisions/{revision_id}` |
| `draft.revise` | `POST /v1/drafts/{draft_id}/revisions` |
| `draft.audit` | `GET /v1/drafts/{draft_id}/audit` |

Both adapters serve one answer; `SPEC.md` Appendix H carries the normative rows
and `docs/API.md` the operator's account of them.

A capture answers `201` whether it produced a draft or a refusal, and the
`outcome` field is which. That is deliberate: a capture the registry declined to
carry as a skill is an answer ABOUT the capture, and the arrival is recorded so
an owner can see that it was answered rather than lost. A request whose SHAPE is
wrong — a missing field, a number where a string belongs — is `INVALID_SCHEMA`
and records nothing, because no arrival was expressed.

## 3. Where each binary requirement is met

| id | where | proved by |
|---|---|---|
| `P1-FR-01` | `src/capture.ts` normalisation, three kinds | `test/v1p1-capture.test.ts` — one positive test per input path, four in all |
| `P1-FR-02` | `src/skillability.ts` `classify` | `test/v1p1-classifier.test.ts` — the table, one row per category |
| `P1-FR-03` | the `skillable` gate in `captureDraft` | `test/v1p1-refusals.test.ts` — no refusal leaves a revision |
| `P1-FR-04` | `NOT_A_PROCEDURE`/`ROUTING` in `src/skillability.ts` | `test/v1p1-refusals.test.ts` — one case per non-skill kind |
| `P1-FR-05` | `DRAFT_SECTIONS` and `compileDraft` in `src/draft.ts` | `test/v1p1-capture.test.ts` — every section asserted |
| `P1-FR-06` | `semanticReview` | `test/v1p1-capture.test.ts` — missing, contradictory, duplicated and unexecutable |
| `P1-FR-07` | `securityReview` | `test/v1p1-capture.test.ts` — permissions, dependencies, risky actions |
| `P1-FR-08` | `redact` called before any write | `test/v1p1-redaction.test.ts` — a sweep of every column of every table, both adapters and the audit |
| `P1-FR-09` | `RedactionFinding` | `test/v1p1-redaction.test.ts` — the finding's own field set is asserted, so a value has nowhere to hide |
| `P1-FR-10` | `readNative` and the refusal path | `test/v1p1-refusals.test.ts` — malformed, unsupported, unsafe and ambiguous |
| `P1-FR-11` | `contentDigest` over content and compiler version | `test/v1p1-capture.test.ts` — two captures, one digest; a recompile converges |
| `P1-FR-12` | `insertRevision` plus the INSERT-only triggers | `test/v1p1-capture.test.ts` — the parent is byte-for-byte unchanged, and the database refuses an update |
| `P1-FR-13` | the whole path takes text and nothing else | `test/v1p1-capture.test.ts` — no version, attestation or signing key is written |
| `P1-FR-14` | additive migration, untouched surfaces | `test/v1p1-compat.test.ts` and the two gate harnesses |

Invariants: `INV-01` — one Registry, the new modules are part of it and the
frontend is not involved at all. `INV-05` — every audit field is a column of
`draft_events` and `provenance_json` is a payload beside them, never the place
the event type hides. `INV-06` — a revision is immutable, in the schema.
`INV-08` — the migration is additive and the surfaces that existed answer as
they did. `INV-09` — the owner path needs no manifest, package, signature,
unpacking or storage access.

## 4. The classifier, and what it does not claim

Seven categories, a rule table, no model. Each category scores the number of
DISTINCT markers of its own that fired; `reusable_procedure` scores zero unless
the source presents at least two steps; the winner is the strict maximum; a tie
is `ambiguous` and so is a capture that fires nothing.

What that delivers is checkable: a capture carrying the markers of one kind is
routed to that kind, and one carrying the markers of two is refused rather than
guessed at. What it does not deliver is a general intent classifier — English
has more ways to describe a scheduled job than a marker table enumerates. A
wrong answer here is a rule to fix, not a model to retrain, and `ambiguous` is a
real answer with its own reason code rather than a failure to have one.

## 5. Redaction, stated exactly

What is delivered: the material the published patterns of SPEC Appendix G.1
recognise, the high-entropy heuristic of G.2, and the four shapes prose adds —
an assignment, an authorization header, a URL with credentials in it, and a PEM
block — are removed from the normalised source before anything is stored, and
the preview reports category, location and reason with no field that could carry
the value.

What is not promised: that no secret can ever be in the database. A credential
nothing recognises as one is a credential that reaches the column, and the
categories above are recognisers rather than a proof of absence. That limit is
the same one `src/journal.ts` states about its own boundary columns, and the
columns this phase adds are classified there as declared limits for that reason.

## 6. Schema, and how it comes back out

`migrations/0013_capture_and_draft_revisions.sql` adds `captures`,
`draft_revisions` and `draft_events` — INSERT-only, with the triggers to prove
it — and edits nothing. It is the first migration of this tree to ship a
reversal, `migrations/down/0013_capture_and_draft_revisions.down.sql`, because
the base has none at all and the contract requires reversibility.

Running the reversal on a disposable database:

```
v1/tools/gates/reversible-migration.sh
```

It builds the schema at the previous migration, seeds it, migrates up, applies
the reversal, and migrates up again, comparing schema digests at both ends. The
cost is stated rather than glossed: the reversal DROPS the three tables, so
captures, drafts and their audit — V1-only data that exists nowhere else — are
discarded with them. Take a copy of the database file first; nothing that
existed at `PRAGMA user_version` 12 is touched either way.

The upgrade from the release base is its own harness:

```
v1/tools/gates/upgrade-from-v016.sh
```

It builds a database with the release base's migration set, records the answers
of twelve read surfaces through the HTTP API, migrates forward with the runner
this build ships and no manual step, and compares every answer and every row
count.

## 7. What P1 did not build

Owner Console and any UI (P2), assignment and lifecycle control (P3), runtime
activation and the native adapters (P4), a marketplace or a general import
framework, and separate stores for memory, rule, automation or connector. The
classifier names those kinds and refuses them with a reason; naming a
destination for one would be inventing a product this contract puts out of
scope.
