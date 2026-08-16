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
  "input_base_sha": "eeefbe66098d6f93807383480790f9800335b516",
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
`model`, `reasoning_effort`, `input_base_sha`, `output_sha`, `command`, `cwd`,
`exit_code`, `timestamp_utc`, `gate_verdict`.

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
| task_id | recorded in evidence/P0/04-session-record.md |
| session_id | recorded in evidence/P0/04-session-record.md |
| input SHA | `eeefbe66098d6f93807383480790f9800335b516` |
| output SHA | the commit this build produced |

The identifiers are written in the evidence file rather than restated here,
because a document that carries a value in two places will eventually carry two
different values.

## 3. Mandatory gates per phase

Commands are the repository's own, discovered and run at P0
(`v1/P0-BASELINE.md` section 3). A phase runs everything in its row.

| gate | P0 | P1 | P2 | P3 | P4 | P5 | P6 |
|---|---|---|---|---|---|---|---|
| `npm ci` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `npm run typecheck` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `npm test` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `bun run test:bun` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `npm run build:js` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `npm run build:binary` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| migration / schema on a disposable DB | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| reversible migration round trip | — | ✓ | if schema changes | ✓ | ✓ | ✓ | ✓ |
| Registry API/CLI smoke | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Registry backwards-compatibility suite | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| security regression on the touched surface | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| secret-absence sweep of evidence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| browser E2E | — | — | ✓ | ✓ | — | ✓ | ✓ |
| actual Codex runtime session | — | — | — | — | ✓ | ✓ | ✓ |
| actual Claude Code runtime session | — | — | — | — | ✓ | ✓ | ✓ |
| upgrade from a `v0.1.6` copy | — | ✓ | — | — | — | — | ✓ |
| containerised quickstart (`ci/quickstart-docker.sh`) | — | — | — | — | — | — | ✓ |
| high-risk exercise (`ci/high-risk-exercise.mjs`) | — | — | — | — | — | — | ✓ |
| dogfood ledger metrics | — | — | — | — | — | — | ✓ |
| clean-room owner journey | — | — | — | — | — | — | ✓ |

`—` means the surface does not exist in that phase; it is not permission to
skip a check that does. `if schema changes` is decided by the diff, not by
preference.

Two entries deserve their reasons stated, since contract section 9 allows `N/A` only
with a concrete justification and neither of these is being waived:

* **Browser E2E is absent before P2** because there is no browser session and no
  console route to drive at the base. It becomes mandatory the moment P2 creates
  one, and stays mandatory afterwards for every phase that touches the console.
* **Actual runtime sessions are absent before P4** because no adapter exists to
  load a skill into Codex or Claude Code. Contract section 9 is explicit that mocked
  adapter tests never substitute for actual runtime evidence once P4 arrives,
  and that missing runtime access at that point is a blocker for Leo rather than
  a reason to fall back to mocks.

## 4. Where evidence lives

```
evidence/
  P0/
    00-refs-tags-before.txt        refs and tags before any change
    01-base-sha-ancestry.txt       base SHA, tree, ancestry, v0.1.6 relationship
    02-integration-branch.txt      branch creation, ancestry, clean worktree
    03-surface-inventory.txt       API, CLI, MCP, schema, workflows — with the commands used
    04-session-record.md           this session's role, model contract, task and session IDs
    05-forbidden-actions-log.md    the log of forbidden production actions (must stay empty)
    06-refs-tags-after.txt         refs and tags after the commit
    07-gate-summary.md             every gate, its command and its exit code
    08-secret-scan.txt             the secret-absence sweep over every artifact
    runs.jsonl                     one record per run, in the schema of section 1
    logs/                          full captured output of each command
```

evidence/ is listed in the repository's `.gitignore`, so these artifacts live
outside the tracked tree by design and are handed to the reviewer as a directory.
The harnesses that produce them are tracked, under `v1/tools/`, so a reviewer can
regenerate rather than trust.
