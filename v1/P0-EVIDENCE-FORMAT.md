# P0 — Frozen evidence format and mandatory gates

Deliverable 5 of P0, satisfying `P0-FR-06`. Two things are frozen here: the
record every run must produce, and the gates each phase must clear.

## 1. The record

Contract section 9 lists what each run must save. This is that list as a schema. One
JSON object per run, appended to evidence/<phase>/runs.jsonl.

```json
{
  "phase": "P0",
  "role": "BUILD-1",
  "task_id": "<the Ductor task id, verbatim>",
  "session_id": "<the Ductor session id, verbatim>",
  "provider": "claude",
  "model": "opus",
  "reasoning_effort": "high",
  "phase_base_sha": "eeefbe66098d6f93807383480790f9800335b516",
  "input_sha": "<the SHA this session started from>",
  "output_sha": "<the commit this run produced, or the SHA reviewed>",
  "command": "npm test",
  "cwd": "<absolute path>",
  "tool_versions": { "node": "v22.22.3", "npm": "10.9.8", "bun": "1.3.14" },
  "exit_code": 0,
  "artifact": "evidence/P0/logs/npm-test.log",
  "stdout_tail": "<sanitised, or omitted when an artifact path is given>",
  "timestamp_utc": "2026-08-16T16:10:13Z",
  "gate_verdict": "pass | fail | skipped",
  "notes": "<why, when a check is skipped or narrowed>"
}
```

Required for every record: `phase`, `role`, `task_id`, `session_id`, `provider`,
`model`, `reasoning_effort`, `phase_base_sha`, `input_sha`, `output_sha`,
`command`, `cwd`, `tool_versions`, `exit_code`, `timestamp_utc`, `gate_verdict`,
and an **output reference** — `artifact` (a path that resolves) or a non-empty
`stdout_tail`.

### Two SHAs, two fields

Contract section 9 requires the "input/base SHA" of every run. P0 FIX-1 read that as
one value and wrote `input_base_sha` — the phase base — in all 21 of its records,
while FIX-1 had in fact started from BUILD-1's commit
`3927571a8349e215aff096ee3ac58135435f4b51`. Both facts matter and they are different
facts, so they are two required fields:

* `phase_base_sha` — the commit the phase branched from. The same value for every
  session of a phase; for P0, `eeefbe66098d6f93807383480790f9800335b516`.
* `input_sha` — the exact SHA this session started from. For a BUILD-1 that is the
  phase base; for a FIX it is the SHA whose findings it received; for a REVIEW it is
  the SHA under review.

`input_base_sha` is now **refused**, not silently accepted as either one. A record
still carrying it has not been migrated, and reading it as one of the two would be
guessing which the writer meant — the ambiguity that produced the defect.

### The identifiers are the isolation

Contract section 7.3 gives every BUILD, FIX and REVIEW its own `task_id` and
`session_id` and forbids one role continuing in another's provider session. That is
only checkable if the values are the provider's. P0 FIX-1 wrote
`session_id: "fix1-P0-0c453cad"` in every record — a label built from its own role
and task id, which is a restatement of the record rather than evidence about it —
and the checker accepted it, together with a FIX record declaring
`codex` / `gpt-5.6-sol` / `low`. That was P0 REVIEW-2's finding `P0-R2-001`. So:

* `session_id` must have the shape a provider session id has: a canonical UUID.
  Claude's are v4, Codex's are v7; both are 8-4-4-4-12 lowercase hex. A constructed
  label, the nil UUID, or an id embedding its own `task_id` is refused.
* `role` fixes `provider`, `model` and `reasoning_effort` exactly — BUILD and FIX are
  `claude` / `opus` / `high`, REVIEW is `codex` / `gpt-5.6-sol` / `high`, per contract
  section 7. The aliases contract section 7.1 forbids by name, `opus-5` and
  `claude-opus-5-high`, are refused by name.
* One role holds one `(task_id, session_id)` pair, and no two roles share either
  value.

The authoritative values are written once, in the session ledger evidence/SESSIONS.md, from the
provider's own task ledger. A well-shaped id is not proof that the session ran the
command — nothing local can establish that after the fact — but a badly-shaped one is
proof that it did not.

The last two entries of that list were added by P0 FIX-1, closing finding
`P0-R1-003`. Contract section 9 names "релевантные tool/runtime versions" and
"sanitised stdout/stderr или путь к artifact" among the things every run must
save, and the first freeze of this schema showed both in the example while
omitting both from the required list — which is how a record with neither gets
written and still validates. `tool_versions` must be a non-empty object; the
whole point of a version field is that a rerun on a different toolchain is
distinguishable from a rerun on the same one.

Enforced, not asked for: `v1/tools/p0-evidence-check.ts` validates every record
against this list and refuses on a missing field, an abbreviated SHA, an invented
session id, a role declaring the wrong model contract, a model alias, or a
`fail`/`skipped` verdict with no `notes`.

**And the refusals are watched.** `v1/tools/p0-negative-probes.sh` runs each rule
against a deliberately damaged copy of the evidence and of the gate table, and fails
unless every copy is refused *for the stated reason*, with the unmodified inputs
passing before and after. `P0-R2-001` was not a missing checker; it was a checker
nobody had seen refuse anything. A rule added without a probe repeats that.

### Archived ledgers

A phase has one ledger, `runs.jsonl`. Any other `runs*.jsonl` in the phase directory
is an **archived ledger** — a frozen record of what an earlier session wrote, kept
because merging it would misrepresent something. P0 has one:
`runs-build1-superseded.jsonl`.

* It must carry a `<name>.README.md` sidecar saying why it exists. Otherwise every
  rule above is satisfiable by renaming a file.
* Its records are **exempt from the field schema of this section**, because a
  preserved ledger is kept for the single property of being what that session
  actually recorded, and rewriting it to satisfy a schema invented later destroys
  that property while looking like tidiness.
* Its records are **never exempt from identity**: real session id, real task id, the
  role → model mapping of contract section 7, no id shared with another role.
  Identity was never a matter of schema version, and an exemption covering it would
  make "archive it" the way to launder a bad record.

### One artifact, one record

Every file under evidence/&lt;phase&gt;/logs/ is the output of exactly one run and
must be named by exactly one record's `artifact`. An unregistered log is a
command that ran with no record of who ran it, at which SHA, or what it returned
— which is the state finding `P0-R1-003` found P0 in, with 13 files against 11
records. The correspondence is checked in both directions: a log no record names
fails, and a record naming a log that is not there fails. Records may point at an
artifact outside logs/ (the secret sweep writes evidence/&lt;phase&gt;/08-secret-scan.txt);
those must resolve, but they are not part of the one-to-one set.

A `.log` file anywhere else under the phase directory must sit in a directory
that carries a `README.md` saying what it is. Otherwise the one-to-one rule is
satisfiable by moving an inconvenient artifact one level sideways.

`model` is the exact model ID the contract section 7 fixes — `opus` for BUILD and FIX,
`gpt-5.6-sol` for REVIEW. Any alias is a contract violation, not a formatting
detail.

`gate_verdict` may be `skipped`, but never silently: a skipped or failed check
must appear in the record with `notes` saying why. Contract section 9 forbids hiding
either.

### Rules

* **Exact SHAs only.** Never a branch name, never `HEAD`, never an abbreviation.
* **No invented values.** A SHA, session ID, task ID, test count or receipt that
  a run did not produce does not go in. A phase that has not run has no record.
* **No secrets.** No API key, token, credential or private runtime config, in
  any field, ever — including inside `stdout_tail` and inside any referenced
  artifact. Harnesses that handle credentials must redact before writing. This
  is checked, not promised: `v1/tools/p0-secret-scan.sh`.
* **Evidence is produced, not asserted.** contract section 9 rules out a hand-edited
  database, fabricated fixtures, seed data presented as dogfood, screenshots
  with no correlating backend or runtime receipt, a serialised audit string with
  no structured payload, and a builder's word with no command or artifact behind
  it.
* **Artifacts over transcripts.** Long output goes to a file under
  evidence/<phase>/logs/ and the record points at it.

### On reusing historical evidence

Contract section 1.1 allows reuse of confirmed historical results — the `v0.1.6` release
base, published artifact checksums, SBOM and provenance, secret-absence checks,
the working hosted Registry, backup/restore and monitoring evidence — but only
after checking that the evidence is identical, that it applies to the current
exact SHA, and that it meets the specific phase's requirements. Historical
evidence never grants an automatic `PASS` and never substitutes for a missing
internal Skill Loop.

## 2. Session records

Contract section 7 requires each BUILD, FIX and REVIEW to be its own background session,
with builder and reviewer sharing no provider context. Each session contributes
one row:

| field | P0 BUILD-1 |
|---|---|
| phase / role | P0 / BUILD-1 |
| provider | claude |
| model | opus |
| reasoning_effort | high |
| task_id | recorded in evidence/SESSIONS.md |
| session_id | recorded in evidence/SESSIONS.md |
| phase base SHA | `eeefbe66098d6f93807383480790f9800335b516` |
| input SHA | `eeefbe66098d6f93807383480790f9800335b516` |
| output SHA | the commit this build produced |

The identifiers are written in the evidence file rather than restated here,
because a document that carries a value in two places will eventually carry two
different values.

The session ledger evidence/SESSIONS.md is that file, and it carries `task_id` and `session_id`
as columns of the session table — one row per session of this contract, taken
from the provider's own task ledger. P0 FIX-2 added the `session_id` column: until
then the real ids appeared nowhere in the evidence package, which is what let the
constructed labels in `runs.jsonl` go unnoticed. Contract sections 7.3 and 9
require both identifiers of every run to be preserved in evidence, and a column
that is absent cannot disagree with a record that is wrong.

## 3. Mandatory gates per phase

Every row carries a **command**. That is the whole change P0 FIX-1 made here, and
it is what finding `P0-R1-002` was: the first freeze of this table named the
phase-specific gates — reversible migration, security regression, browser E2E,
actual Codex session, actual Claude Code session, dogfood metrics, clean-room
journey — as descriptive labels with nothing to run behind them, which satisfies
`P0-FR-04` only in the sense that a menu satisfies hunger.

Two kinds of command appear, and they are not the same claim:

* **Real commands.** The repository's own, discovered and run at P0
  (`v1/P0-BASELINE.md` section 3), plus the two subject-list harnesses
  `v1/tools/gates/registry-compat.sh` and `v1/tools/gates/security-regression.sh`,
  which run existing tests and are green today.
* **Gate interfaces.** A path under `v1/tools/gates/` that exists, is executable,
  documents in its own header exactly what the implementing phase must assert, and
  exits `3` — NOT IMPLEMENTED FOR THIS PHASE. It fails closed. It is an interface,
  not a feature: P0 defines how a phase's gate is invoked and what it owes, and
  implements no P1–P6 product behaviour. Contract section 10 puts that behaviour
  out of P0's scope; contract section 9 still requires the gate to be a runnable
  path rather than a sentence, so it is one.

A phase runs everything marked `✓` in its column.

| gate | command | P0 | P1 | P2 | P3 | P4 | P5 | P6 |
|---|---|---|---|---|---|---|---|---|
| install, npm toolchain | `npm ci` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| install, Bun toolchain | `bun install --frozen-lockfile` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| typecheck | `npm run typecheck` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| unit and integration suite, Node | `npm test` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| unit and integration suite, Bun | `bun run test:bun` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| build, JS entry point | `npm run build:js` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| build, single-file binary | `npm run build:binary` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| migration / schema on a disposable DB | `node --experimental-strip-types --no-warnings v1/tools/p0-db-check.ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| reversible migration round trip | `v1/tools/gates/reversible-migration.sh` | — | ✓ | cond | ✓ | ✓ | ✓ | ✓ |
| Registry API / CLI / MCP contract smoke | `v1/tools/p0-registry-smoke.sh` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Registry backwards-compatibility suite | `v1/tools/gates/registry-compat.sh` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| security regression on the threat-model surface | `v1/tools/gates/security-regression.sh` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| secret-absence sweep of evidence | `v1/tools/p0-secret-scan.sh <evidence-dir>` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| traceability completeness | `node --experimental-strip-types --no-warnings v1/tools/p0-traceability-check.ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| evidence-record completeness | `node --experimental-strip-types --no-warnings v1/tools/p0-evidence-check.ts <evidence-dir>` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| gate-table validity | `node --experimental-strip-types --no-warnings v1/tools/p0-gate-table-check.ts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| output-SHA agreement across the phase package | `node --experimental-strip-types --no-warnings v1/tools/p0-output-sha-check.ts <evidence-dir> --repo <repo>` | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| validator negative probes | `v1/tools/p0-negative-probes.sh <evidence-dir> <workdir>` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| append-only branch history | `v1/tools/p0-append-only-check.sh` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| browser E2E | `v1/tools/gates/browser-e2e.sh` | — | — | ✓ | ✓ | — | ✓ | ✓ |
| actual Codex runtime session | `v1/tools/gates/runtime-codex.sh` | — | — | — | — | ✓ | ✓ | ✓ |
| actual Claude Code runtime session | `v1/tools/gates/runtime-claude-code.sh` | — | — | — | — | ✓ | ✓ | ✓ |
| upgrade from a `v0.1.6` copy | `v1/tools/gates/upgrade-from-v016.sh` | — | ✓ | ✓ | — | ✓ | — | ✓ |
| containerised quickstart | `ci/quickstart-docker.sh` | — | — | — | — | — | — | ✓ |
| high-risk exercise | `node ci/high-risk-exercise.mjs` | — | — | — | — | — | — | ✓ |
| dogfood ledger metrics | `v1/tools/gates/dogfood-metrics.sh` | — | — | — | — | — | — | ✓ |
| clean-room owner journey | `v1/tools/gates/clean-room-journey.sh` | — | — | — | — | — | — | ✓ |

Cell vocabulary, and nothing else is accepted: `✓` the gate runs in that phase ·
`—` N/A, the surface does not exist in that phase · `cond` conditional, run when
the stated rule fires. `—` is never permission to skip a check whose surface does
exist.

`v1/tools/p0-gate-table-check.ts` parses this table and refuses if any row has no
command, if a command does not resolve to something runnable in this tree, if a
cell holds a word outside that vocabulary, or if a row carrying a `—` or a `cond`
has no justification below naming every phase it applies to.

### The set is pinned, not merely well-formed

Everything in the paragraph above validates the rows that ARE here. P0 REVIEW-2
deleted the security-regression row from a copy of this table and the checker
reported 24 of 24 commands resolving and exited 0 — a table that loses a mandatory
category passed, which made the check an argument for whatever the table happened to
say.

So the mandatory set is pinned inside `p0-gate-table-check.ts`: every row above, and
the phases whose cell must be `✓`. A later phase may **add** a row and may **upgrade**
a `—` to a `✓`. It may not delete a pinned row, rename one, or downgrade a pinned
`✓` — each of those fails the gate. The pinned list can only change by editing the
tracked checker, which is a deliberate reviewable act rather than a row quietly going
missing from a document. Proved, not asserted: probes 15–18 of
`v1/tools/p0-negative-probes.sh` delete a mandatory row, delete another, downgrade a
`✓` and rename a row, and require a refusal each time.

### N/A and conditional justifications

Contract section 9 permits `N/A` only for a surface that genuinely does not exist,
and only with a concrete reason. One entry per gate that carries a `—` or a
`cond`; each names the phases it covers.

* **output-SHA agreement across the phase package** — P0, P1: the check was written
  in P2, as the close of P2 REVIEW-1 finding `P2-R1-005`, and it requires an
  `OUTPUT_SHA:` marker in every closure artifact of the directory it reads. P0's and
  P1's evidence packages were written and closed before that marker existed. Adding
  the markers to them now would be editing two closed phases' evidence to satisfy a
  rule invented afterwards — which is the thing the archived-ledger rule of
  `p0-evidence-check.ts` exists to forbid. It is `✓` from P2, the phase that
  introduced it, onward.

* **reversible migration round trip** — P0: this phase changes no schema. Its diff
  touches no file under migrations/ or schema/, which is checked rather than
  claimed (`P0-FR-08`). P2: `cond`, and the condition FIRED. Contract section 9 makes the round
  trip mandatory
  for schema-changing phases, and whether P2 changes schema is decided by its diff
  against the phase base — if any file under migrations/ or schema/ differs, the
  gate runs. P2's diff adds
  `migrations/0014_owner_console_sessions_and_decisions.sql` and its reversal, so the
  gate ran and its exit code is in P2's gate summary. The rule is the diff, not
  preference, and a P2 that reported this gate
  as `—` while its diff shows a migration would have failed the gate, not skipped it.
* **browser E2E** — P0, P1: there is no browser session and no console route to
  drive; P2 creates the first one, and `v1/tools/gates/browser-e2e.sh` stopped being
  an interface there — it drives Chromium through Playwright against a real
  deployment (`v1/tools/e2e/console-e2e.mjs`). P4: P4 adds runtime adapters and touches no
  console surface, so there is nothing new to drive — but a P4 that does touch the
  console owes this gate, and the same diff rule applies. The rule was applied rather
  than assumed: P4's diff against `77f10b0537103e46d46b9c9b3a69f1b5d89813b6` names no
  file under the console surface, so the cell stays `—`. P4's closing session ran the
  gate anyway and recorded its exit code; an N/A cell is a statement that a phase does
  not OWE a gate, never a licence to leave a runnable one unrun.
* **actual Codex runtime session** — P0, P1, P2, P3: no adapter exists to load a
  skill into Codex before P4 builds one, so there is no runtime path to exercise.
  Contract section 9 is explicit that mocked adapter tests never substitute once P4
  arrives, and contract section 11 makes missing runtime access at that point a blocker
  for Leo rather than grounds to fall back to mocks.
* **actual Claude Code runtime session** — P0, P1, P2, P3: the same absent surface,
  on the other adapter. No Claude Code adapter exists before P4 builds one, so there
  is no native mechanism to materialise into and no session to invoke. It is listed
  as its own row rather than folded into the Codex one because the two native
  mechanisms differ, and one gate covering both invites one runtime to be proved and
  the other assumed.
* **upgrade from a `v0.1.6` copy** — P0: the phase base commit is one commit above
  the `v0.1.6` tag and changes no file under src/, migrations/ or schema/, so at P0
  the current schema and the `v0.1.6` schema are the same object and an upgrade has
  nothing to traverse; `v1/P0-BASELINE.md` records the `git diff` that shows it.
  P3, P5: these phases inherit the migration set the earlier phases established, and
  the upgrade path from `v0.1.6` is re-measured at P1 when the first schema change
  lands and at P6 as final acceptance. A phase in that range whose diff adds a
  migration owes the gate — the same diff rule as the round trip. P2's diff adds
  `migrations/0014_owner_console_sessions_and_decisions.sql`, so P2 owed it and its
  cell is `✓` rather than the `—` P0 wrote there: the rule fired, exactly as
  written, and the cell moved. It fired again at P4, whose diff against
  `77f10b0537103e46d46b9c9b3a69f1b5d89813b6` adds
  `migrations/0016_session_loadout_and_runtime_receipts.sql` and its reversal, so P4's
  cell moved from `—` to `✓` too and the gate's exit code is in P4's gate summary. A
  phase does not get to decide this: the diff decides it.
* **containerised quickstart** — P0, P1, P2, P3, P4, P5: this exercises the packaged
  container against the published quickstart and is the final acceptance form of the
  owner path. Contract section 4.2 puts release and publish packaging out of V1, and
  contract section 10 places the final clean-room and dogfood validation in P6, so it is
  run once, at P6, on the final SHA rather than repeatedly against intermediate
  states that no one adopts.
* **high-risk exercise** — P0, P1, P2, P3, P4, P5: same reason as the containerised
  quickstart. It is a final-acceptance exercise over the packaged artifact, and P6
  is where contract section 10 puts final acceptance.
* **dogfood ledger metrics** — P0, P1, P2, P3, P4, P5: no dogfood exists to measure.
  Contract section 10 P5 states outright that synthetic fixtures are permitted for P5's
  automated tests and are NOT dogfood, so running this gate before P6 could only
  measure fixtures, which `P6-FR-08` forbids counting.
* **clean-room owner journey** — P0, P1, P2, P3, P4, P5: the journey spans capture,
  approval, assignment, session loadout, invocation, outcome, revision and rollback.
  Until P5 closes the loop there is no complete journey to walk, and a partial walk
  reported as this gate would be a green mark for a path that does not join up.

## 4. Where evidence lives

The listing is complete: a file added to the phase directory is added here. P0
REVIEW-2 noted that FIX-1 wrote `12-` and `13-` and left this block naming eleven
files, which turns a frozen layout into a stale one.

```
evidence/
  SESSIONS.md                      the session ledger: role, task_id, session_id, model contract, SHAs
  P0/
    00-refs-tags-before.txt        refs and tags before any change
    01-base-sha-ancestry.txt       base SHA, tree, ancestry, v0.1.6 relationship
    02-integration-branch.txt      branch creation, ancestry, clean worktree
    03-surface-inventory.txt       API, CLI, MCP, schema, workflows — with the commands used
    04-session-record.md           this session's role, model contract, task and session IDs
    05-forbidden-actions-log.md    the log of forbidden production and history-rewriting actions
    06-refs-tags-after.txt         refs and tags after the commit
    07-gate-summary.md             every gate, its command and its exit code, per session
    08-secret-scan.txt             the secret-absence sweep, BUILD-1
    09-refs-before-after-diff.txt  the before/after ref comparison
    10-branch-reflog.txt           the full branch reflog — the append-only record
    11-append-only-check.txt       the append-only check, positive and negative runs
    12-secret-scan-fix1.txt        the secret-absence sweep, FIX-1
    13-evidence-check-fix1.txt     the evidence-record check, FIX-1
    14-secret-scan-fix2.txt        the secret-absence sweep, FIX-2 gate run
    15-evidence-check-fix2.txt     the evidence-record check, FIX-2 gate run
    16-residual-limitations.md     P0's standing residual audit limitations, carried forward
    17-secret-scan-final.txt       the closing secret sweep, run after the last word was written
    18-evidence-check-final.txt    the closing evidence-record check — the last file P0 writes
    runs.jsonl                     one record per run, in the schema of section 1
    runs-build1-superseded.jsonl   archived ledger: BUILD-1's 11 records, byte-identical
    runs-build1-superseded.jsonl.README.md   why that ledger is archived (required sidecar)
    logs/                          full captured output of each command, one file per record
    logs-build1/                   what survives of BUILD-1's artifacts, with its own README.md
    logs-fix2-attempt1/            an aborted gate run kept with its red log, with its own README.md
    probes-fix2/                   one transcript per negative probe, with its own README.md
  P1/
    00-refs-tags-before.txt        refs and tags before the phase's first commit
    01-refs-tags-after.txt         refs, tags, ancestry and clean-worktree at the output SHA
    02-branch-reflog.txt           the full branch reflog — the append-only record
    03-session-record.md           this session's role, model contract, task and session IDs, and its two commits
    04-forbidden-actions-log.md    the log of forbidden production and history-rewriting actions
    05-refs-before-after-diff.txt  the before/after ref comparison
    06-gate-summary.md             every gate, its command and its exit code, for both runs
    07-negative-probes.txt         the validator negative probes
    08-secret-scan.txt             the secret-absence sweep
    09-evidence-check.txt          the evidence-record check of that sweep's package
    10-negative-probes-final.txt   the probes again, at the phase's final SHA
    11-secret-scan-final.txt       the closing sweep, run after the last word was written
    12-evidence-check-final.txt    the closing evidence-record check of FIX-1
    13-session-record-fix2.md      FIX-2's role, model contract, task and session IDs, and its commit
    14-review2-probes-before.txt   REVIEW-2's own probe file at the SHA it reviewed, where it passes on the defects
    15-review2-probes-after.txt    the same probes at the FIX-2 SHA, where the ones asserting a defect fail
    16-gate-summary-fix2.md        every gate of the FIX-2 run, its command and its exit code
    17-negative-probes-fix2.txt    the validator negative probes, at the FIX-2 SHA
    18-refs-tags-after-fix2.txt    refs, tags, ancestry and clean-worktree at the final SHA
    19-secret-scan-fix2-final.txt  the closing secret sweep, run after the last word was written
    20-evidence-check-fix2-final.txt  the closing evidence-record check — the last file P1 writes
    runs.jsonl                     one record per run, in the schema of section 1
    logs/                          full captured output of each command, one file per record
    logs-baseline/                 the pre-change reading at the phase base, with its own README.md
    probes/                        one transcript per negative probe, with its own README.md
  P2/
    00-browser-feasibility.txt     whether a real browser can be driven in this container at all, answered first
    01-refs-tags-and-base.txt      refs, tags, ancestry and clean-worktree at the output SHA, and why there is no before-snapshot
    02-branch-reflog.txt           the full branch reflog — the append-only record
    03-session-record.md           this session's role, model contract, task and session IDs, and its commits
    04-forbidden-actions-log.md    the log of forbidden production and history-rewriting actions
    05-p2-record.md                what P2 built, per deliverable and per requirement, at the exact SHA
    06-gate-summary.md             every mandatory P2 gate, its command and its exit code
    07-browser-e2e-trace.txt       the browser run's sanitised network trace, one line per exchange
    08-negative-probes.txt         the validator negative probes
    09-secret-scan-final.txt       the closing secret sweep, run after the last word was written
    10-evidence-check-final.txt    the closing evidence-record check — the last file P2 writes
    runs.jsonl                     one record per run, in the schema of section 1
    logs/                          full captured output of each command, one file per record
    e2e-development-runs/          the browser gate's development runs, with its own README.md
  P3/
    01-refs-tags-and-base.txt      refs, tags, ancestry and clean-worktree at the output SHA
    02-branch-reflog.txt           the full branch reflog — the append-only record
    03-session-record.md           this session's role, model contract, task and session IDs, and its commits
    04-forbidden-actions-log.md    the log of forbidden production and history-rewriting actions, including the gate this phase ran red on purpose
    05-p3-record.md                what P3 built and what it did NOT build, at the exact SHA
    06-gate-summary.md             every mandatory P3 gate, its command and its exit code
    07-browser-e2e-trace.txt       the browser run's sanitised network trace, one line per exchange
    08-negative-probes.txt         the validator negative probes
    09-output-sha-agreement.txt    the output-SHA agreement across the phase package
    10-secret-scan-final.txt       the closing secret sweep, run after the last word was written
    11-evidence-check-final.txt    the closing evidence-record check
    12-clean-clone.txt             the clean-clone transcript: clone, npm ci, npm test, nothing between
    13-browser-e2e-trace-cont.txt  the P2 console browser run's trace, from the continuation session
    14-p3-screen-e2e-trace.txt     the P3 assignment/lifecycle screen run's trace, one line per exchange
    15-session-record-cont.md      the continuation session's role, model contract, task and session IDs, and its commits
    16-p3-record-cont.md           what the continuation session delivered, and what it did not
    17-gate-summary-cont.md        every mandatory P3 gate at the final SHA, its command and its exit code
    18-refs-tags-and-base-cont.txt refs, tags, ancestry and clean-worktree at the final SHA
    19-branch-reflog-cont.txt      the branch reflog after the continuation session's commits
    20-forbidden-actions-log-cont.md  the continuation session's log of forbidden production and history-rewriting actions
    21-clean-clone-cont.txt        the clean-clone transcript at the final SHA: clone, npm ci, npm test, nothing between
    22-negative-probes-cont.txt    the validator negative probes at the final SHA
    23-output-sha-agreement-cont.txt  the output-SHA agreement across the extended package
    24-secret-scan-final-cont.txt  the closing secret sweep of the extended package
    25-evidence-check-final-cont.txt  the closing evidence-record check — the last file P3 writes
    26-session-record-fix1.md      FIX-1's role, model contract, task and session IDs, and its commits
    27-browser-e2e-trace-fix1.txt  the P2 console browser run's trace, at the FIX-1 SHA
    28-p3-screen-e2e-trace-fix1.txt  the P3 screen run's trace, at the FIX-1 SHA
    29-clean-clone-fix1.txt        the clean-clone transcript at the FIX-1 SHA: clone, npm ci, npm test, nothing between
    30-p3-record-fix1.md           what FIX-1 changed, finding by finding, and what it does not claim
    31-gate-summary-fix1.md        every mandatory P3 gate at the FIX-1 SHA, its command and its exit code
    32-refs-tags-and-base-fix1.txt refs, tags, ancestry and clean-worktree at the FIX-1 SHA
    33-branch-reflog-fix1.txt      the branch reflog after FIX-1's commits
    34-forbidden-actions-log-fix1.md  FIX-1's log of forbidden production and history-rewriting actions
    35-negative-probes-fix1.txt    the validator negative probes at the FIX-1 SHA, including the three new ones
    36-output-sha-agreement-fix1.txt  the output-SHA agreement across the extended package
    37-secret-scan-final-fix1.txt  the closing secret sweep of the extended package
    38-evidence-check-final-fix1.txt  the closing evidence-record check of the FIX-1 package
    39-session-record-fix2.md      FIX-2's role, model contract, task and session IDs, its commits, and why it ran no battery
    40-session-record-fix2b.md     FIX-2b's role, model contract, task and session IDs, and its commits
    41-p3-record-fix2b.md          the last open finding, closed: what changed, what it does not claim
    42-gate-summary-fix2b.md       every mandatory P3 gate at the final SHA, its command and its exit code
    43-browser-e2e-trace-fix2b.txt the P2 console browser run's trace, at the final SHA
    44-p3-screen-e2e-trace-fix2b.txt  the P3 screen run's trace, at the final SHA
    45-unknown-surface-reproducer.txt  REVIEW-2's own reproducer for `P3-R2-002`, run before and after the fix
    46-refs-tags-and-base-fix2b.txt  refs, tags, ancestry and clean-worktree at the final SHA
    47-branch-reflog-fix2b.txt     the branch reflog after FIX-2's and FIX-2b's commits
    48-forbidden-actions-log-fix2b.md  FIX-2b's log of forbidden production and history-rewriting actions
    49-clean-clone-fix2b.txt       the clean-clone transcript at the final SHA: clone, npm ci, npm test, nothing between
    50-negative-probes-fix2b.txt   the validator negative probes at the final SHA
    51-output-sha-agreement-fix2b.txt  the output-SHA agreement across the whole package
    52-secret-scan-final-fix2b.txt the closing secret sweep of the whole package
    53-evidence-check-final-fix2b.txt  the closing evidence-record check of the FIX-2b package
    54-session-record-fix2c.md     FIX-2c's role, model contract, task and session IDs, and its commits
    55-p3-record-fix2c.md          what FIX-2c changed, finding by finding, and what it does not claim
    56-gate-summary-fix2c.md       every mandatory P3 gate at the final SHA, its command and its exit code
    57-browser-e2e-trace-fix2c.txt the P2 console browser run's trace, at the FIX-2c SHA
    58-p3-screen-e2e-trace-fix2c.txt  the P3 screen run's trace, at the FIX-2c SHA
    59-refs-tags-and-base-fix2c.txt  refs, tags, ancestry and clean-worktree at the FIX-2c SHA
    60-branch-reflog-fix2c.txt     the branch reflog after FIX-2c's commits
    61-forbidden-actions-log-fix2c.md  FIX-2c's log of forbidden production and history-rewriting actions
    62-clean-clone-fix2c.txt       the clean-clone transcript at the FIX-2c SHA: clone, npm ci, npm test, nothing between
    63-fix2b-gate-results.txt      the FIX-2b gate run's raw per-gate results, carried into the FIX-2c package
    64-gate-results-fix2c.txt      the FIX-2c gate run's raw per-gate results
    65-negative-probes-fix2c.txt   the validator negative probes, closing pass 1
    66-output-sha-agreement-fix2c.txt  the output-SHA agreement across the package, closing pass 1
    67-secret-scan-final-fix2c.txt the closing secret sweep, closing pass 1
    68-evidence-check-final-fix2c.txt  the closing evidence-record check, closing pass 1
    69-negative-probes-fix2c.txt   the validator negative probes, closing pass 2
    70-output-sha-agreement-fix2c.txt  the output-SHA agreement across the package, closing pass 2
    71-secret-scan-final-fix2c.txt the closing secret sweep, closing pass 2
    72-evidence-check-final-fix2c.txt  the closing evidence-record check, closing pass 2
    73-negative-probes-fix2c.txt   the validator negative probes, closing pass 3
    74-output-sha-agreement-fix2c.txt  the output-SHA agreement across the package, closing pass 3
    75-secret-scan-final-fix2c.txt the closing secret sweep, closing pass 3
    76-evidence-check-final-fix2c.txt  the closing evidence-record check — the last file P3 writes
    runs.jsonl                     one record per run, in the schema of section 1
    logs/                          full captured output of each command, one file per record
    probes-fix1/                   one transcript per negative probe of the FIX-1 run, with its own README.md
    probes-fix2/                   FIX-2's reproducer transcripts for `P3-R2-001`, before and after
  P4/
    00-runtime-feasibility.txt     whether real Codex and Claude Code sessions can be driven in this container at all, answered first
    01-feasibility-harness-run.txt the feasibility harness's own run: both runtimes loaded the materialised probe and returned its marker
    02-runtime-receipts.txt        what each runtime actually returned in that feasibility run, reduced to the lines that carry the claim
    03-session-record.md           BUILD-1's role, model contract, task and session IDs
    04-not-delivered.md            what BUILD-1 did NOT deliver, per deliverable and per requirement
    05-gate-table-check.txt        the gate-table validity check, BUILD-1
    06-secret-scan.txt             the secret-absence sweep, BUILD-1
    07-gate-runtime-codex.txt      the actual Codex runtime gate, BUILD-2
    08-gate-runtime-claude-code.txt  the actual Claude Code runtime gate, BUILD-2
    09-build1-codex-transcript.txt   BUILD-1's Codex feasibility transcript, kept when the 53 MB of runtime homes around it was moved out of the package
    09-build1-claude-transcript.json BUILD-1's Claude Code feasibility transcript, kept for the same reason
    10-secret-scan-negative-probe.txt  the secret scan refusing a directory that holds a credential FILE whose contents match no value pattern
    11-gate-results.tsv            BUILD-2's raw per-gate results, one line per gate
    12-session-record.md           BUILD-2's role, model contract, task and session IDs, and its four commits
    13-not-delivered.md            what BUILD-2 left open: the unclosed package, and the gates it did not run at its final SHA
    14-secret-scan.txt             the secret-absence sweep, BUILD-2
    15-refs-tags-and-base.txt      refs, tags, ancestry and clean-worktree at the phase's final SHA
    16-branch-reflog.txt           the full branch reflog — the append-only record
    17-session-record-build3.md    BUILD-3's role, model contract, task and session IDs, and its one commit
    18-forbidden-actions-log.md    BUILD-3's log of forbidden production and history-rewriting actions
    19-p4-record.md                what P4 built, deliverable by deliverable and requirement by requirement, at the exact SHA — and what it does not claim
    20-gate-summary.md             every mandatory P4 gate at the final SHA, its command and its exit code
    21-gate-results.tsv            BUILD-3's raw per-gate results, one line per gate
    22-clean-clone.txt             the clean-clone transcript at the final SHA: clone, npm ci, npm test, nothing between
    23-negative-probes.txt         the validator negative probes at the final SHA
    24-output-sha-agreement.txt    the output-SHA agreement across the phase package
    25-secret-scan-final.txt       the closing secret sweep, run after the last word was written
    26-evidence-check-final.txt    the closing evidence-record check of BUILD-3's package
    27-session-record-fix1.md      FIX-1's role, model contract, task and session IDs, and its two commits
    28-finding-p4-r1-001.md        the one blocking finding P4 REVIEW-1 returned, how it was closed, and what else was checked for the same shape
    29-repro-before.txt            the finding reproduced at the input SHA: the session root planted as an outward link, both runtimes, the artifact written outside the base
    30-repro-after.txt             the same reproducer at the fix SHA: refused, and nothing outside the base
    31-component-probes.txt        every component of the session path planted as an outward link in turn, before and after
    32-negative-demo.txt           the new regression seen RED: the fix reverted in the working tree, the test failing, the fix restored
    33-gate-summary-fix1.md        every mandatory P4 gate at FIX-1's final SHA, its command and its exit code
    34-gate-results-fix1.tsv       FIX-1's raw per-gate results, one line per gate
    35-clean-clone-fix1.txt        the clean-clone transcript at the final SHA: clone, npm ci, npm test, nothing between
    36-refs-tags-and-base-fix1.txt refs, tags, ancestry and clean-worktree at FIX-1's final SHA
    37-forbidden-actions-log-fix1.md  FIX-1's log of forbidden production and history-rewriting actions
    38-negative-probes.txt         the validator negative probes at FIX-1's final SHA
    39-output-sha-agreement.txt    the output-SHA agreement across the phase package, at FIX-1's final SHA
    40-secret-scan-final.txt       the closing secret sweep, run after the last word was written
    41-evidence-check-final.txt    the closing evidence-record check — the last file P4 writes
    runs.jsonl                     one record per run, in the schema of section 1
    logs/                          full captured output of each command, one file per record
    logs-fix1-aborted/             the first four logs of a FIX-1 battery stopped on purpose before this listing was committed, with its own README.md
    logs-fix1-aborted-2/           the logs of a second FIX-1 battery, stopped because its `npm test` gate FAILED and the package had to be corrected, with its own README.md
  P5/
    01-session-record.md           BUILD-1's role, model contract, task and session IDs, and its commits
    02-p5-record.md                what P5 built, deliverable by deliverable and requirement by requirement — and what it does NOT claim
    03-not-delivered.md            what BUILD-1 did NOT deliver, named plainly
    04-forbidden-actions-log.md    BUILD-1's log of forbidden production and history-rewriting actions
    05-gate-summary.md             every mandatory P5 gate at the final SHA, its command and its exit code
    06-gate-results.tsv            the gate battery's raw per-gate results, one line per gate
    07-runtime-codex.txt           the actual Codex runtime gate, reaching the outcome
    08-runtime-claude-code.txt     the actual Claude Code runtime gate, reaching the outcome
    09-refs-tags-and-base.txt      refs, tags, ancestry and clean-worktree at the phase's final SHA
    10-branch-reflog.txt           the full branch reflog — the append-only record
    11-clean-clone.txt             the clean-clone transcript at the final SHA: clone, npm ci, npm test, nothing between
    12-negative-probes.txt         the validator negative probes at the final SHA
    13-output-sha-agreement.txt    the output-SHA agreement across the phase package
    14-secret-scan-final.txt       the closing secret sweep, run after the last word was written
    15-evidence-check-final.txt    the closing evidence-record check of BUILD-1's package
    16-session-record-build2.md    BUILD-2's role, model contract, task and session IDs, and its commits
    17-build2-record.md            what BUILD-2 delivered against the three items BUILD-1 left, and what it does NOT claim
    18-gate-summary-build2.md      every mandatory P5 gate at BUILD-2's final SHA, its command and its exit code
    19-gate-results-build2.tsv     that battery's raw per-gate results, one line per gate
    20-browser-e2e-p5.txt          the browser gate at the final SHA: the P2 run, the error-contract probes, the P3 screen, the P5 outcome screen, and the three negative demonstrations
    21-p5-consistency-check.txt    the stage/outcome consistency validator over a real run's database, and the demonstration that it fails on a planted cross-table inconsistency
    22-runtime-codex-build2.txt    the actual Codex runtime gate at the final SHA
    23-runtime-claude-code-build2.txt  the actual Claude Code runtime gate at the final SHA
    24-refs-tags-and-base-build2.txt   refs, tags, ancestry and clean-worktree at the final SHA
    25-branch-reflog-build2.txt    the full branch reflog after BUILD-2's commits
    26-clean-clone-build2.txt      the clean-clone transcript at the final SHA: clone, npm ci, npm test, nothing between
    27-negative-probes-build2.txt  the validator negative probes at the final SHA
    28-output-sha-agreement-build2.txt  the output-SHA agreement across the phase package
    29-secret-scan-build2.txt      the closing secret sweep, run after the last word was written
    30-evidence-check-build2.txt   the closing evidence-record check of BUILD-2's package
    31-session-record-fix1.md      FIX-1's role, model contract, task and session IDs, and its commits
    32-fix1-record.md              the two REVIEW-1 findings, the one mechanism that closes both, and what FIX-1 does NOT claim
    33-gate-summary-fix1.md        every mandatory P5 gate at FIX-1's final SHA, its command and its exit code
    34-gate-results-fix1.tsv       that battery's raw per-gate results, one line per gate
    35-repro-before-and-after.txt  the reviewer's own reproduction, run at the input SHA and at the final SHA
    36-router-regressions-fix1.txt the four new router regressions, and the same four with the new guards disabled so the refusals are seen to fail
    37-p5-consistency-check-fix1.txt  the consistency validator over a real run's database at the final SHA, and over a copy with the two refused rollback shapes planted
    38-browser-e2e-p5-fix1.txt     the browser gate at the final SHA
    39-runtime-codex-fix1.txt      the actual Codex runtime gate at the final SHA
    40-runtime-claude-code-fix1.txt   the actual Claude Code runtime gate at the final SHA
    41-refs-tags-and-base-fix1.txt    refs, tags, ancestry and clean-worktree at the final SHA
    42-branch-reflog-fix1.txt      the full branch reflog after FIX-1's commits
    43-clean-clone-fix1.txt        the clean-clone transcript at the final SHA: clone, npm ci, npm test, nothing between
    44-negative-probes-fix1.txt    the validator negative probes at the final SHA
    45-output-sha-agreement-fix1.txt  the output-SHA agreement across the phase package
    46-secret-scan-fix1.txt        the closing secret sweep, run after the last word was written
    47-evidence-check-fix1.txt     the closing evidence-record check — the last file P5 writes
    runs.jsonl                     one record per run, in the schema of section 1
    logs/                          full captured output of each command, one file per record
    logs-fix1-aborted/             the first five logs of a FIX-1 battery stopped on purpose before this listing was committed, with its own README.md
```

**P5 was built by TWO sessions, and the second one is the rest of the build.**
`BUILD-1` delivered the outcome model, the routes, the adapter's part and both
runtime gates, and closed its package having stated in
evidence/P5/03-not-delivered.md that the owner's SCREEN and its browser run were
absent. `BUILD-2` is that screen, its browser run and the consistency validator,
recorded under its own role because the identity rule of section 1 binds one role
to one provider session — which is what makes the isolation of contract section
7.3 visible rather than assumed. No review had run on P5 when BUILD-2 started, so
the two-review two-fix budget of contract section 8 is untouched by it. Every
marker in the package names BUILD-2's final SHA, and the files BUILD-1 wrote were
re-pointed rather than duplicated: a package whose artifacts name two different
SHAs is a package that certifies neither.

**P5 REVIEW-1 returned two blocking findings, and `FIX-1` closed both.**
`P5-R1-001` accepted a forward revision update as the confirmation of a rollback and
`P5-R1-002` accepted a session that predated the rollback when the two shared a
millisecond; both are recorded in evidence/P5/32-fix1-record.md with the reviewer's own
reproduction before and after and with the transcript of the new regressions seen RED with
the new guards disabled. `FIX-1` committed the fix, then the phase document, then THIS
listing, and only then ran the certifying battery, the clean clone and the four closing
checks — a commit after the markers are written invalidates every one of them, and the
first battery of this session was stopped mid-run for exactly that reason. Its logs are
kept under evidence/P5/logs-fix1-aborted/ rather than deleted.

**P4 REVIEW-1 returned one blocking finding, and `FIX-1` closed it.** The finding,
`P4-R1-001`, is recorded in evidence/P4/28-finding-p4-r1-001.md with the reproduction
before and after and the transcript of the new regression seen RED with the fix reverted.
`FIX-1` made TWO commits: the fix, and then THIS listing — in that order, because the
listing describes files the fix session had not written yet, and because a session that
writes its markers and then commits has invalidated every one of them. The certifying
battery, the clean clone and the four closing checks all ran after the second commit and
name the SHA it produced.

**P4 was built by THREE sessions, and the third one committed first on purpose.**
`BUILD-1` answered the runtime feasibility question and delivered nothing else;
`BUILD-2` built all nine deliverables and both runtime gates and ran out of wall
before closing; `BUILD-3` closed the package. They are three roles because they are
three provider sessions with three task ids, which is what section 7.3's isolation is
checked by — the phase automaton has still run ONE build step and no review, and the
two-review two-fix budget of contract section 8 is untouched.

The listing above and the P4 gate rows are BUILD-3's ONLY commit, and it is the first
thing that session did. The order is not stylistic. A commit moves `HEAD`, and every
`OUTPUT_SHA` marker in this package names `HEAD`; P3's closing session learned this by
writing a package and then invalidating it, and P4 `BUILD-1` inherited the debt for the
same reason. Committing the documentation debt BEFORE the closing battery is how the
debt gets paid without costing a third session.

**Files `00`–`14` are BUILD-1's and BUILD-2's and are not rewritten, except for their
`OUTPUT_SHA` marker**, which names the phase's exact final SHA — one marker per
artifact is what `v1/tools/p0-output-sha-check.ts` requires, so it is added rather than
doubled. Their text is left exactly as those sessions wrote it, including
`13-not-delivered.md`, which says the package is not closed. That statement was true
when it was written and `19-p4-record.md` says what changed, rather than the earlier
file being edited to agree with a later state.

**`runs.jsonl` holds records BUILD-3 did not itself run, and they say so.** Neither
BUILD-1 nor BUILD-2 wrote a run ledger, and their artifacts — `01`, `05`, `06`, `07`,
`08`, `10`, `11`, `14` — are executions with exit codes and no record of who ran them,
which is the exact state `P0-R1-003` exists to catch. BUILD-3 transcribed one record
per surviving artifact, under the ORIGINATING session's role and identifiers, with a
`notes` field naming BUILD-3 as the transcriber and the artifact as the only source.
That is weaker than a record written by the session that ran the command, and it is
labelled as weaker; the alternative — a phase ledger silently missing its first two
sessions — hides the weakness instead of stating it.

**Three closing passes, not one.** Files `65`–`68`, `69`–`72` and `73`–`76` are the
same four closing artifacts written three times, because P3's FIX-2c had to commit
again after each pass and a commit moves the SHA the previous pass certified. The
numbered files are per event, and re-running the closing battery is three events.
Only the last pass certifies the final SHA; the earlier two are kept because
deleting a superseded run is how a package stops being append-only.

**This listing was brought up to date by P4 `BUILD-1`, and the reason it was stale
is worth keeping.** P3's own closing session could not repair it: committing the
correction would have moved `HEAD`, invalidating the seventy-six `OUTPUT_SHA`
markers it had just re-pointed — the exact defect the session existed to close. The
debt was therefore carried to the next phase that commits anyway. Two corrections
beyond the missing range: file `53` was described as "the last file P3 writes",
which file `76` now is; and the listing named a `probes-fix2b/` directory that the
package does not contain — FIX-2b's probe transcripts are in the numbered files, not
in a directory of their own.

P3 was built by TWO sessions, and fixed by a third: `BUILD-1`, which built the backend and recorded
that the console screen and its browser end-to-end were not delivered, and
`BUILD-2`, the continuation that built them. They are two roles in this ledger
because they are two provider sessions with two task ids, which is what section
7.3's isolation is checked by; the phase automaton has still run one BUILD step
and no review. Files `01`–`12` are BUILD-1's and are not rewritten, except for
their `OUTPUT_SHA` marker, which names the phase's exact final SHA — one marker
per artifact is what `v1/tools/p0-output-sha-check.ts` requires, so it is
re-pointed rather than doubled. `FIX-1` (files `26`–`38`) closed P3 REVIEW-1's
three findings and re-pointed every earlier marker to ITS final SHA for the same
reason.

**Two files of that package were CORRECTED rather than re-pointed, and say so in
their own text.** `03-session-record.md` named an intermediate commit as
BUILD-1's output SHA and `15-session-record-cont.md` deferred its output SHA to
the package marker; P3 REVIEW-1 finding `P3-R1-003` was that the three records of
those two sessions disagreed and no checker compared them. Both now name the SHA
the run ledger and the session ledger name, each carries a paragraph saying what
was changed and why, and `v1/tools/p0-evidence-check.ts` compares the session
ledger, every `*session-record*.md` and the unique role tuple of `runs.jsonl`
against each other — a pending value, a role no ledger row carries and an output
SHA the runs contradict are each a refusal, with a negative probe apiece.

A phase directory follows the same rules: the numbered files are per event, the
`logs/` correspondence is one file to one record, and the closing pair runs last.
P1's numbered files start at `00` for the same reason P0's did — the snapshot
that has to be taken before anything moves is the first thing written.

Two things this layout does not promise. **logs/ holds more than one session's
artifacts** — FIX-1's and FIX-2's live side by side under distinct names, because a
name reused is an artifact destroyed (`L-P0-01`); the one-to-one rule is per file, not
per session. And **the numbered files are per event, not per session**: a phase that
runs its gates twice writes two sweeps rather than overwriting one.

**The closing pair runs last, in this order.** Every document in the package —
including the gate summary and this ledger's prose — is finished before
`17-secret-scan-final.txt` sweeps it, and the evidence-record check that writes
`18-evidence-check-final.txt` is the last thing the phase does. Otherwise the closing
check certifies a package that then changes, which is a certificate for a state
nobody inspected.

evidence/ is listed in the repository's `.gitignore`, so these artifacts live
outside the tracked tree by design and are handed to the reviewer as a directory.
The harnesses that produce them are tracked, under `v1/tools/`, so a reviewer can
regenerate rather than trust.

The forbidden-actions log is **not** a file whose only correct content is
"empty". It is a log, and P0 has an entry in it. A log that can only ever say
nothing happened is a decoration; one that records what did happen is evidence.

## 5. Append-only: how a fix lands

**Every BUILD and FIX session of this contract lands its work as new commits. No
`--amend`, no rebase, no reset, no non-fast-forward move of an integration
branch.** This binds every later session, not only P0.

Contract section 2 already forbids force-push, history rewriting, history deletion and
destructive reset. This section states the operational form of that rule, because
P0 BUILD-1 amended a commit it had already written and then recorded that no
history rewrite had occurred — finding `P0-R1-001`. The full account of that
amend, including why the lineage was not rebuilt in a fresh repository, is
`v1/P0-BRANCH-HISTORY.md`.

Three consequences worth stating plainly:

* **A mistake in a commit is corrected by the next commit.** A wrong sentence, a
  wrong log, a broken harness — all of them are new-commit work. The cost is a
  slightly longer history, and the history is the audit trail, so that is not a
  cost.
* **The reflog is part of the evidence.** `git log` cannot show where a branch has
  been, only where it is, so an amend is invisible in it. Every phase captures its
  branch reflog at evidence/&lt;phase&gt;/10-branch-reflog.txt, and P0's audit boundary
  is the reflog plus the run records — that pair, not the commit graph alone.
* **The rule is checked.** `v1/tools/p0-append-only-check.sh` reads the branch
  reflog and fails on any amend, rebase, reset or non-fast-forward move that is not
  disclosed in the tracked file `v1/append-only-baseline.tsv`, on a disclosure that
  matches no real reflog entry, and on a disclosed entry whose pre-rewrite commit
  has stopped being reachable. It refuses rather than passes when no reflog is
  available. It is in the gate table for every phase.
