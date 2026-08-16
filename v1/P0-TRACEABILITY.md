# P0 — Requirement traceability matrix

Deliverable 3 of P0, satisfying `P0-FR-03`: every normative requirement of the
contract *Skillonomia V1 → FINAL DONE* — the nine architectural invariants and
every `P*-FR-*` of P0 through P6 — mapped to the surface expected to implement
it, the check expected to prove it, and the phase that owes it.

Read the columns as follows.

* **Surface** is where the requirement is expected to land. At the base commit
  some of these files exist and some do not. A path written `new` does not exist
  yet; naming it is a plan, not a claim that it is there. Contract section 11 is
  explicit that a file or endpoint name is not a blocker, so a later phase may
  land the behaviour elsewhere — it then owes an updated row, not an excuse.
* **Check** is the evidence that closes the requirement. Where a check already
  exists at the base it is named by file. Where it does not, the row states the
  kind of check the phase must add.
* **Phase** is where the requirement is discharged. `P0` rows are closed by this
  build; every other row is a forward obligation.

Nothing in this matrix asserts a result for a phase that has not run. P0 records
the obligation; the phase records the outcome.

## Architectural invariants (contract section 5)

| ID | Requirement | Surface | Check | Phase |
|---|---|---|---|---|
| INV-01 | One Registry/backend is the single source of truth; frontend duplicates no classifier, lifecycle, reconciliation or permission logic; adapters are thin projections; materialised native files are not truth | `src/service.ts`, `src/http.ts`, `src/mcp.ts`, `src/db.ts`; adapters (new, P4) | Baseline: single-process, single-database shape recorded in `v1/P0-BASELINE.md` section 4. Forward: a guard asserting no lifecycle/eligibility decision is computed in a view or adapter module | P0 records; P1–P5 preserve; P4 tested for adapters |
| INV-02 | Desired and observed state have separate fields, storage, API contracts and UI; owner commands change only desired; observed changes only on structured evidence | `src/fleet.ts` (state matrix), `src/assignments.ts`, `src/activation.ts`, observed tables from `0008_observed_runtime_records.sql` | Desired/observed separation tests; a test that an owner mutation leaves observed untouched | P3 (state model), P4 (observed ingestion) |
| INV-03 | Every observed `unknown` carries `reason_code`, `reason`, `source`, `observed_at` and known identifiers; `unknown` is never promoted to success | `src/fleet.ts`, `src/outcome.ts`, observed-record schema | Schema validation for `unknown`; negative test that a missing receipt yields `unknown` and never `loaded`/`worked` | P3 (contract), P4 (runtime), P5 (outcomes) |
| INV-04 | No API key or service credential reaches the browser; no credential in `localStorage`, `sessionStorage`, IndexedDB, Cache API, URL, JS-readable cookie or bundle; owner console runs on a short-lived same-origin `HttpOnly` cookie session ≤ 60 min; logout and expiry invalidate server-side; mutations carry same-origin/Origin validation and CSRF defence | new session module; `src/auth.ts` (kept for machine-to-machine, keys server-side); console routes | Browser E2E for unauthenticated access, login, expiry, logout; cookie-attribute assertions; CSRF/Origin negative tests; browser-storage inspection; network evidence showing no key in browser traffic | P2 |
| INV-05 | Frontend consumes versioned structured contracts; audit and runtime receipts carry separate structured fields for event type, actor/source, entity and revision, session/invocation correlation, timestamp, reason/result and provenance; text is display-only | `src/receipts.ts`, `src/journal.ts`, audit event contracts, DTO/schema modules | Structured audit contract tests; a guard that no product decision is taken by parsing a human-readable string | P1 (audit events), P2 (UI consumption), P4–P5 (receipts) |
| INV-06 | Editing a draft creates a new revision; approved revisions are never edited in place; reject preserves revision and audit; rollback selects a prior approved revision without rewriting history; assignment, loadout, invocation and outcome all reference exact revision and content digest | `src/skill-migrations.ts`, draft/revision tables (new, P1), `src/assignments.ts` | Immutable-revision tests; deterministic digest tests; rollback-preserves-history tests | P1 (revisions), P3 (rollback), P4 (digest in loadout) |
| INV-07 | An active session's loadout is immutable; assign/update/pause/revoke/rollback apply to the next session; the current session is never rewritten; UI states this explicitly; emergency termination is out of V1 | loadout snapshot service (new, P4), lifecycle UI | Immutable-snapshot tests; new-session-boundary tests; a UI assertion that the effective-from-next-session notice is shown | P3 (semantics), P4 (snapshot) |
| INV-08 | Existing Registry API, CLI and `v0.1.6` data keep working; schema changes are additive and reversible; business logic is not moved into a second registry; no manual migration in normal operation | `migrations/`, `src/db.ts`, `src/compat.ts`, existing suite | Baseline recorded at P0 (section 6 of `v1/P0-BASELINE.md`); per-phase re-run of the existing suite; migration round-trip on a disposable database; upgrade from a `v0.1.6` copy | P0 baseline; every later phase |
| INV-09 | The owner never hand-writes a manifest, package, JSON payload, SQLite row, signing material, API key, unpacked runtime file or runtime config; automatic materialisation is allowed if backend/adapter-driven, reproducible, safe and reversible | capture/draft path (P1), console (P2), adapters (P4) | Clean-room owner journey with no manual technical artefact; adapter materialisation tests | P1–P4 build; P6 proves end to end |

## P0 — Baseline and adoption

Closed by this build. The evidence column names files under
evidence/P0/.

| ID | Requirement | Surface | Check | Status |
|---|---|---|---|---|
| P0-FR-01 | Integration branch has the base SHA in its ancestry and contains no foreign changes | branch `v1-final-integration` | `02-integration-branch.txt`: `git merge-base --is-ancestor` exit 0; `git diff <base> HEAD --stat` empty at branch creation | closed |
| P0-FR-02 | `main` and existing tags unchanged | git refs | `00-refs-tags-before.txt` / `06-refs-tags-after.txt`: `main` and all seven tags identical before and after | closed |
| P0-FR-03 | Every normative requirement appears in the traceability matrix | this file | `v1/tools/p0-traceability-check.ts` parses the contract and this file and refuses on any missing ID | closed |
| P0-FR-04 | Real commands, or a justified minimal harness, are defined for every phase | `v1/P0-BASELINE.md` section 3, `v1/P0-EVIDENCE-FORMAT.md` section 3, `v1/tools/gates/` | Every gate row names a command that resolves to something runnable, and every N/A or conditional cell carries a justification naming its phases — checked by `v1/tools/p0-gate-table-check.ts`. The phase-specific gates that have no product surface yet are executable interfaces under `v1/tools/gates/` that exit `3`, not prose | closed |
| P0-FR-05 | Baseline Registry verified through existing public contracts, not direct SQL | `v1/tools/p0-registry-smoke.sh` | `logs/registry-smoke.log`: HTTP + CLI only; the quickstart reaches a terminal `adopted` receipt | closed |
| P0-FR-06 | Evidence format carries exact SHA, session IDs, model contract, commands and exit codes | `v1/P0-EVIDENCE-FORMAT.md` sections 1 and 2 | The frozen record schema — which also requires tool/runtime versions and an output-or-artifact reference, both named by contract section 9 — with every P0 run recorded in it and every artifact under logs/ owned by exactly one record, checked by `v1/tools/p0-evidence-check.ts` | closed |
| P0-FR-07 | Security scope limited to contract section 6, not widened to public SaaS | `v1/P0-THREAT-MODEL.md` | The frozen model reproduces section 6 in and out lists and adds no item | closed |
| P0-FR-08 | P0 does not change product semantics | the commit diff | `git diff --name-only <base>..HEAD -- src/ migrations/ schema/ bin/ ci/ tools/ seed/ skills/` is empty. One file outside `v1/` IS changed: `test/absolutes.ts`, by 12 lines, which register `v1/*.md` on that guard's REFERENCED_ONLY roster with its reason — the roster fails the build for a delivered document in neither half, so a new document cannot be added without one. It adds no assertion about product behaviour and changes no product code path. Full suite re-run green | closed |
| P0-FR-08 (append-only) | Contract section 2: no history rewrite; a fix lands as a new commit | `v1/P0-EVIDENCE-FORMAT.md` section 5, `v1/P0-BRANCH-HISTORY.md`, `v1/append-only-baseline.tsv` | `v1/tools/p0-append-only-check.sh` reads the branch reflog and fails on any undisclosed amend, rebase, reset or non-fast-forward move, on a phantom disclosure, and on a disclosed rewrite whose pre-rewrite commit has become unreachable; proved on a throwaway branch, one negative per detector | closed |

## P1 — Capture → Draft backend/compiler

| ID | Requirement | Surface | Check |
|---|---|---|---|
| P1-FR-01 | Capture accepted from workflow text, session reference/content and a supported native skill, with no hand-built JSON | capture endpoints + MCP tools (new), `src/service.ts` | Positive capture tests for all three input paths |
| P1-FR-02 | Classifier returns machine-readable category, `skillable` and a structured reason | classifier module (new) | Table-driven classifier tests across every category |
| P1-FR-03 | Only a reusable procedure becomes a draft | classifier + draft compiler | Negative tests that non-procedures are refused a draft |
| P1-FR-04 | Memory, rule, automation, connector, loadout and one-off are not disguised as skills and get a structured refusal/routing reason | classifier | One test per category asserting the refusal shape |
| P1-FR-05 | Canonical draft carries purpose, trigger/when-to-use, procedure, inputs, outputs, permissions, dependencies, failure modes, redactions and source provenance | draft schema + compiler | Compiler contract tests over every mandatory section |
| P1-FR-06 | Semantic preview names missing, contradictory or unexecutable sections in structured form | semantic preview module | Preview contract tests with deliberately defective drafts |
| P1-FR-07 | Security preview shows requested permissions, dependencies, risky actions and redactions in structured form | security preview module | Security preview contract tests |
| P1-FR-08 | Redaction happens before the draft, audit, logs and evidence are written; no raw secret is stored | redaction module | Redaction tests for credentials, tokens and private values; a sweep of database, API response, audit and logs for raw secrets |
| P1-FR-09 | Redaction preview shows category, location and reason without revealing the secret | redaction preview | Assertion that the preview omits the original value |
| P1-FR-10 | Malformed or unsupported import fails as a controlled structured refusal, never a partial draft | import path | Negative tests for malformed, unsupported and ambiguous input |
| P1-FR-11 | Recompiling one normalised input at one compiler version yields the same content digest | compiler + digest | Deterministic digest tests |
| P1-FR-12 | Edit or recompile never alters a previous revision | revision store | Immutable revision tests |
| P1-FR-13 | The happy path needs no manifest, packaging, signing, unpacking or direct storage access | capture → draft path | Clean-path test asserting no such step is required |
| P1-FR-14 | Existing Registry operations keep their behaviour | `src/service.ts`, `migrations/` | Existing suite re-run; migration up/down/up or an equivalent reversible round trip on a disposable database; upgrade test on a baseline-schema copy |

## P2 — Draft Inbox and semantic review in the Owner Console

| ID | Requirement | Surface | Check |
|---|---|---|---|
| P2-FR-01 | Without a valid browser session, protected console and protected API are unreachable | session middleware (new) | Browser E2E for unauthenticated access |
| P2-FR-02 | Browser session satisfies `INV-04`, expires within 60 minutes and is invalidated by logout | session module | Cookie-attribute assertions; expiry and logout E2E |
| P2-FR-03 | No Registry API key or equivalent service credential is ever sent to the browser | session module, console routes | Network evidence over the whole workflow |
| P2-FR-04 | The Draft Inbox shows real backend drafts, not fixtures or local state | inbox route | Contract test binding rendered rows to backend records |
| P2-FR-05 | Detail shows structured sections, permissions, dependencies, failure modes, redactions, semantic findings and security findings | detail route | Structured contract tests per panel |
| P2-FR-06 | Draft content renders without executing HTML or script | rendering layer | XSS regression with hostile draft content |
| P2-FR-07 | Edit creates a new revision and re-runs semantic and security preview | edit flow | Edit → new revision → preview re-run test |
| P2-FR-08 | Approve records the exact revision, digest, owner actor and timestamp | approval service | Approve contract test asserting all four fields |
| P2-FR-09 | A draft with an unresolved blocking semantic or security finding cannot be approved | approval service | Negative approval test |
| P2-FR-10 | Reject requires a reason and preserves revision and audit | rejection service | Reject contract test |
| P2-FR-11 | The frontend computes no eligibility, security result or state transition | console modules | A guard that these decisions have no second implementation in view code |
| P2-FR-12 | The UI parses no human-readable audit string; decisions use structured fields only | console modules | Audit schema tests plus a guard against string parsing |
| P2-FR-13 | Mutating requests are protected against CSRF and accidental replay | session middleware | CSRF and Origin negative tests; replay test |
| P2-FR-14 | After the full workflow, browser storage holds no API key, service credential or session secret | console | Browser storage inspection after inbox, edit, approve and reject |
| P2-FR-15 | Machine-to-machine Registry clients stay compatible | `src/auth.ts`, `src/http.ts` | Existing Registry compatibility suite |

## P3 — Assignment and lifecycle control

| ID | Requirement | Surface | Check |
|---|---|---|---|
| P3-FR-01 | Only an approved revision can be assigned, and only to an existing agent of the closed fleet | assignment service (`src/assignments.ts` extended) | Assignment eligibility tests |
| P3-FR-02 | Assign creates a canonical desired assignment in the backend | assignment service | Persistence contract test |
| P3-FR-03 | Activate, pause and revoke have checkable permitted transitions | `src/transitions.ts` | Lifecycle transition table tests |
| P3-FR-04 | A paused assignment can be activated; a revoked one cannot be silently reactivated | transition rules | Negative reactivation test |
| P3-FR-05 | Rollback selects a previously approved revision and deletes no newer revision | rollback service | Rollback and immutable-history tests |
| P3-FR-06 | An owner mutation never changes observed state | assignment service | Desired/observed separation test |
| P3-FR-07 | The UI shows desired and observed separately | capability/library detail | Rendering assertion over both columns |
| P3-FR-08 | Every observed `unknown` satisfies `INV-03` | observed model | Schema validation for `unknown` |
| P3-FR-09 | The same operation with the same idempotency key and payload creates no duplicate and returns an equivalent result | `src/idempotency.ts` | Idempotency replay tests |
| P3-FR-10 | A repeated idempotency key with a different payload returns `409` | `src/idempotency.ts` | Conflicting-payload test |
| P3-FR-11 | A stale entity version or precondition returns `412` | precondition handling | Stale ETag/version tests |
| P3-FR-12 | On `409` or `412` the console refetches canonical state, shows the conflict and shows no false success | console reconciliation | `409`/`412` browser E2E with refetch |
| P3-FR-13 | Lifecycle mutations are written as structured audit events | audit module | Structured audit contract tests |
| P3-FR-14 | Update, pause, revoke and rollback are marked effective from the next session | lifecycle service + UI | New-session-boundary tests |
| P3-FR-15 | The current immutable loadout is not changed | loadout service | Immutability test across a lifecycle mutation |
| P3-FR-16 | The frontend holds no second implementation of transition rules or conflict resolution | console modules | Guard against duplicated transition logic |

## P4 — Immutable session loadout and two native runtime adapters

| ID | Requirement | Surface | Check |
|---|---|---|---|
| P4-FR-01 | A new session snapshots only the active desired assignments of the chosen agent | loadout service (new) | Snapshot content tests |
| P4-FR-02 | The snapshot carries loadout ID, session ID, agent ID, runtime kind and version, adapter version, assignment IDs, exact skill and revision IDs, content digests and creation timestamp | loadout persistence | Field-by-field snapshot contract test |
| P4-FR-03 | A snapshot never changes after creation | loadout persistence | Immutability test |
| P4-FR-04 | Unapproved, paused or revoked revisions never enter a new loadout | loadout builder | Exclusion tests for all three states |
| P4-FR-05 | The Codex adapter automatically renders a canonical approved revision into Codex's supported native mechanism | Codex adapter (new), `src/activation.ts` | Adapter contract tests plus an actual Codex session |
| P4-FR-06 | The Claude Code adapter renders the same canonical model into Claude Code's supported native mechanism | Claude Code adapter (new) | Adapter contract tests plus an actual Claude Code session |
| P4-FR-07 | The owner writes no manifest, package or signature and edits no runtime config | adapters | Clean-room path assertion |
| P4-FR-08 | Adapter artifacts are derived projections; deleting them destroys no canonical data | adapters | Delete-and-rebuild test |
| P4-FR-09 | `proposed` follows loadout construction; `loaded` only follows adapter or runtime confirmation | stage event model | Stage-order validation |
| P4-FR-10 | `invoked` appears only on a structured runtime or adapter receipt correlating session, revision and invocation | receipt ingestion | Receipt correlation tests |
| P4-FR-11 | Absent trustworthy confirmation yields `unknown` with reason and source, never `loaded` or `invoked` | `src/fleet.ts` honesty rules | Negative test for a missing receipt |
| P4-FR-12 | Every stage carries a structured timestamp and provenance | stage events | Provenance contract test |
| P4-FR-13 | A runtime receipt cannot be forged by an owner UI command | ingestion boundary | Negative test attempting owner-side fabrication |
| P4-FR-14 | Path traversal, unsafe filenames and symlink escape are blocked during materialisation | materialisation code, `src/fleet-scan.ts` patterns | Traversal and symlink tests |
| P4-FR-15 | No raw source secret reaches a native artifact or runtime log | adapters + redaction | Secret-leak sweep over artifacts and logs |
| P4-FR-16 | Pause, revoke and update leave the current session alone; the next session gets a new snapshot | lifecycle + loadout | New-session update and revoke tests |
| P4-FR-17 | An actual Codex session loads and invokes the assigned exact skill | Codex runtime | Actual runtime session evidence (mocks do not satisfy this) |
| P4-FR-18 | An actual Claude Code session loads and invokes the assigned exact skill | Claude Code runtime | Actual runtime session evidence (mocks do not satisfy this) |
| P4-FR-19 | Both runtimes emit evidence proving the exact revision, not only a skill name | receipts | Revision-identity assertion in receipts |
| P4-FR-20 | The event chain is never backfilled from frontend assumptions | ingestion boundary | Guard that stage events originate from receipts |

## P5 — Outcomes and the revision loop end to end

| ID | Requirement | Surface | Check |
|---|---|---|---|
| P5-FR-01 | Normalised outcomes `worked`, `failed`, `rolled_back`, `nothing_reported` are supported | `src/outcome.ts` extended | Outcome contract tests for all four values |
| P5-FR-02 | `worked` cannot be inferred from `proposed` or `loaded` alone; it needs invocation and outcome evidence or explicit owner confirmation with a source | outcome derivation | Negative test: `loaded` without invocation never becomes `worked` |
| P5-FR-03 | `failed` carries a structured reason and provenance | outcome model | Failure contract test |
| P5-FR-04 | A session closing with no outcome receipt yields `nothing_reported`, never success | session close path | Session-close test |
| P5-FR-05 | `rolled_back` records the rollback action and target revision without rewriting the previous outcome | rollback + outcome | Rollback outcome test |
| P5-FR-06 | Redelivery of one receipt is idempotent | receipt ingestion | Receipt replay test |
| P5-FR-07 | A conflicting receipt does not overwrite its predecessor; the conflict becomes structured state | receipt ingestion | Receipt conflict test |
| P5-FR-08 | Feedback or failure creates a new draft revision carrying parent revision and source receipt | revision-from-feedback flow | Lineage test |
| P5-FR-09 | The new revision goes through the same semantic/security review and owner approval | review pipeline | Reuse-of-pipeline test |
| P5-FR-10 | Reassigning the new revision applies to a new session | assignment + loadout | New-session reassignment test |
| P5-FR-11 | Comparison shows exact old and new revisions, the original observation or failure and the new outcome | comparison view | Comparison contract test |
| P5-FR-12 | Confirmed improvement requires a comparable scenario and a proven transition from failure or observation to `worked`, or another binary goal fixed in advance | comparison + outcome | Improvement-cycle test |
| P5-FR-13 | Rollback selects a previously approved revision and is confirmed by a new session | rollback flow | Rollback exact-version test in a new session |
| P5-FR-14 | The UI consumes structured outcome and receipt contracts | console | Contract test plus a guard against string parsing |
| P5-FR-15 | Codex and Claude Code both traverse the outcome path end to end | both adapters | A full synthetic integration loop per runtime |

## P6 — Real internal dogfood and final acceptance

| ID | Requirement | Surface | Check |
|---|---|---|---|
| P6-FR-01 | At least 10 distinct real skills exist, each active and each really invoked at least once | dogfood ledger | Automatic count from structured receipts |
| P6-FR-02 | At least 5 of them are reused across different sessions | ledger | Automatic reuse count; redelivery of one receipt does not count |
| P6-FR-03 | At least 2 distinct skills are used by more than one `agent_id` | ledger | Automatic multi-agent count |
| P6-FR-04 | Dogfood includes at least one real end-to-end Codex session | Codex runtime | Actual runtime walkthrough |
| P6-FR-05 | Dogfood includes at least one real end-to-end Claude Code session | Claude Code runtime | Actual runtime walkthrough |
| P6-FR-06 | At least one full real cycle: use → failure or observation → new revision → review/approve → reassignment → new session → confirmed improvement | full loop | Improvement-cycle evidence with exact old and new revisions |
| P6-FR-07 | A proven revision rollback applied in a new session exists | rollback flow | Rollback cycle evidence |
| P6-FR-08 | No dogfood record originates from fixtures, seed scripts or hand-inserted rows | ledger provenance | Provenance check over every ledger row |
| P6-FR-09 | Dogfood metrics are computed from structured receipts, not names or audit strings | metrics code | Metric derivation test |
| P6-FR-10 | The clean-room owner starts from a natural "make this a skill" instruction in a supported workflow or session path | capture path | Clean-room walkthrough |
| P6-FR-11 | The owner sees the created draft and its semantic and security preview | console | Walkthrough with screenshots correlated to backend records |
| P6-FR-12 | The owner edits if needed and approves an exact revision | console | Walkthrough |
| P6-FR-13 | The owner assigns the skill to an agent and activates it | console | Walkthrough |
| P6-FR-14 | The owner starts a session and sees `proposed`, `loaded`, `invoked` and outcome with provenance | console + runtime | Walkthrough with correlated receipts |
| P6-FR-15 | The owner creates or selects a new revision and applies it in a new session | console | Walkthrough |
| P6-FR-16 | The owner rolls back to a previously approved revision and confirms it in a new session | console | Walkthrough |
| P6-FR-17 | The owner journey needs no manual manifest, package, JSON, SQLite, API key, signature, unpacking or runtime-config edit | whole path | Clean-room evidence (`INV-09`) |
| P6-FR-18 | Upgrading from a copy of `v0.1.6` schema and data preserves existing Registry behaviour | `migrations/`, `src/compat.ts` | Upgrade migration against a disposable copy of the `v0.1.6` database |
| P6-FR-19 | Migration rollback and application rollback are reproducible from the runbook on a disposable environment | runbooks | Executed rollback on a disposable environment |
| P6-FR-20 | Every final mandatory gate is green on one exact HEAD SHA | all | Full suite, typecheck, build, migrations, security, compatibility on one SHA |
| P6-FR-21 | No production mutation, deploy, release, push, tag or publish was performed | execution log | evidence/P0/05-forbidden-actions-log.md continued through P6; before/after refs and tags |

## Completeness

`v1/tools/p0-traceability-check.ts` reads the contract text and this file,
extracts every `INV-*` and `P*-FR-*` identifier from each, and exits non-zero if
any identifier appears in the contract but not here. It is a check, not a
claim — run it rather than believe this paragraph.
