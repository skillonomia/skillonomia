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
| `P1-FR-08` | `redact` called before any write, on the body and on every metadata field | `test/v1p1-redaction.test.ts` — a sweep of every column of every table, both adapters and the audit; `test/v1p1-r1-fixes.test.ts` — the same sweep over title, reference and native path, with a run that proves the sweep can fail |
| `P1-FR-09` | `RedactionFinding` | `test/v1p1-redaction.test.ts` — the finding's own field set is asserted, so a value has nowhere to hide |
| `P1-FR-10` | `readNative`, the refusal path and the column-bound refusal | `test/v1p1-refusals.test.ts` — malformed, unsupported, unsafe and ambiguous; `test/v1p1-r1-fixes.test.ts` — an unstorable bounded capture at the real HTTP listener |
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

What is not promised: absence. A credential nothing recognises as one is a
credential that reaches the column, and the categories above are recognisers
rather than a proof that the database holds none. That limit is
the same one `src/journal.ts` states about its own boundary columns, and the
columns this phase adds are classified there as declared limits for that reason.

### 5.1. The metadata is source too

P1 REVIEW-1's finding `P1-R1-001` was that the rule above was applied to the
BODY of a capture and to nothing around it. A title reached the draft's own
`title` verbatim whenever the source stated no name of its own — no frontmatter
`name`, no level-one heading — and an unsupported native path was interpolated
into the refusal's `reason`. Neither is a lesser field: an owner types a token
into a title as readily as into a step, and both travel to the response, the
row and the audit.

So every field that travels goes through the same function the body does — the
title, the source reference, a session's own reference, the native path a
refusal names, and the identifiers echoed back by a `NOT_FOUND` or an
`INVALID_SCHEMA`. A finding from one of them says which field it came out of,
in the form an edited section already used, so the preview still answers
`P1-FR-09`: category, location and reason, and nowhere for the value.

The redaction of a path is why a refusal can still name one. A refusal that
dropped the path would be a refusal an owner cannot act on; the shape survives
and the material does not.

## 5.2. Bounds, and the answer when one is reached

The three JSON columns of a revision are bounded, and the fields whose length
is decided by the SOURCE rather than by the schema are the finding lists: one
redaction finding per credential, one semantic finding per bad line, one risky
action per risky line. A capture inside the published input bound can carry a
thousand of each. P1 BUILD-1 answered that with `500 INTERNAL` after the
arrival row was already written — an arrival classified as drafted with neither
draft nor refusal behind it, which is P1 REVIEW-1's finding `P1-R1-002`.

Two changes, and they close different halves of it.

* **The lists are capped and the counts are not.** `MAX_LISTED_FINDINGS` in
  `src/draft.ts` bounds what a stored preview LISTS; `redactions_total`,
  `findings_total`, `risky_actions_total` and every `blocking_count` are
  computed over the whole set before the cap applies, so nothing that decides
  whether a draft may be approved depends on how much detail fits. This is the
  narrowing contract section 8.10 permits rather than a wider column: the bound
  is a `CHECK` on a populated table, and widening it is a rebuild, which is
  neither additive nor reversible.
* **What a cap cannot reach is refused, not attempted.** A declared permissions
  block the size of the input bound is the draft's own content and not a
  finding list, so it is checked against the column bound before the write:
  `DRAFT_TOO_LARGE`, a structured refusal with a reason on the capture path,
  and `LIMIT_EXCEEDED` on the edit path, which the error model answers as
  `413`. Neither reaches SQLite as a constraint failure.

And the writes are one transaction. `withIdempotency` calls its handler
directly and opens none, which is what let a failure between the arrival and
the revision leave partial state; `captureDraft` and `reviseDraft` each own a
`BEGIN IMMEDIATE` now, in the shape every other mutating surface of this
registry already used. `test/v1p1-r1-fixes.test.ts` drives a failure at each of
the three write boundaries and asserts that no row survives any of them.

## 5.3. What P1 REVIEW-2 found, and how each was closed

REVIEW-2 returned three blocking findings against the FIX-1 SHA. None of them
needed a schema change, and none is closed by narrowing a claim.

**`P1-R2-001` — the key of a repeat was the caller's own text.** `P1-FR-08`
promises that no raw secret value is persisted by this surface, and the
`idempotency_key` travelled beside the body into `idempotency_keys.key`
verbatim: a caller who put a token in the key made it durable registry data on
the one surface whose contract says otherwise. It cannot be redacted — a cleaned
key would no longer equal the key a retry sends, and the replay would be lost —
so it is HASHED. `DIGESTED_KEY_SURFACES` in `src/idempotency.ts` names
`capture.submit` and `draft.revise`, and on those two the column holds
`correlationDigest` of the key: the primitive this tree already applies to
`receipt_events.idempotency_key` and `observed_records.call_id`, for the same
reason — equality survives a hash exactly and the string does not survive at
all.

The rule is decided by the SURFACE, which is a constant of this repository at
every call site, and never by the form of a value: that second rule is the one
`migrations/0012` had to withdraw. No migration is needed, because both surfaces
are new in this phase and no released build wrote a row on either — and
`UNIQUE(actor_agent_id, surface, key)` keeps each surface in its own comparison
domain, so a raw key stored by an older surface can never be read as a digest
here. What this does NOT cover is stated rather than left to be found: the
surfaces that existed before P1 still store the caller's key, which is unchanged
base behaviour on surfaces that carry no capture content, and converting the
rows a released build wrote is a different change from this one.

**`P1-R2-002` — an accepted bounded capture could still end in `500`.** The
input bound and the stored bound are different bounds, and cleaning moves a
value between them: redaction replaces material with a marker, so
`password=abcd` becomes longer than it arrived. A `source_ref` inside the
200-character input bound could reach a 200-character column as a longer string,
and an empty workflow reached the lower bound of `captures.redacted_source`.
Both surfaced as `500 INTERNAL`. `TEXT_COLUMN_BOUNDS` in `src/capture.ts` now
checks the CLEANED value before any write: a reference that does not fit is
`LIMIT_EXCEEDED`, and a source that does not fit is a recorded structured
refusal — `EMPTY_SOURCE` or `SOURCE_TOO_LARGE` — whose stored
`redacted_source` is the marker and never the content. The same check covers the
native path a refusal carries. `test/v1p1-r2-fixes.test.ts` drives each case at
a real HTTP listener and on the MCP surface, asserting the typed answer and zero
rows.

**`P1-R2-003` — the capture and its replay row were two mutations.**
`captureDraft` committed and `withIdempotency` inserted the replay row
afterwards, so a failure between them left a capture, a revision and three
events with no idempotency row — and the retry with the same key compiled a
SECOND lineage instead of replaying the first. `withIdempotencyInTx` owns one
`BEGIN IMMEDIATE` around both halves, and `captureDraftInTx` and
`reviseDraftInTx` are the handlers that run inside it. The multi-process UNIQUE
race still converges, and converges more strictly: the loser rolls its own
domain write back before replaying the winner's stored response.

Two non-blocking items REVIEW-2 recorded were closed with them. The listed
window of a capped finding list is filled by SEVERITY first and by source order
within a severity, so a destructive action behind two hundred warnings is shown
rather than cut — the totals are unchanged and were always true. And a redaction
finding now carries `source_field`, naming the field it came from as a
structured value (`source`, `title`, `source_ref`, `sections.<name>`); the
sentence in `reason` stays as display, which is what `INV-05` asks for.

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
