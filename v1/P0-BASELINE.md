# P0 — Baseline record

Phase P0 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
the repository **is** at the accepted base commit, and the commands that
actually exist to check it. Nothing here changes product behaviour: P0 is an
adoption phase (`P0-FR-08`).

Every number and every command in this file was produced by running it. Where a
value is measured, the command that measured it is printed next to it, so a
reviewer can reproduce the value rather than trust the sentence.

## 1. The accepted base

| | |
|---|---|
| repository | `skillonomia/skillonomia` |
| base commit | `eeefbe66098d6f93807383480790f9800335b516` |
| base tree | `11eb7dba228433891709b273055470d52a75093a` |
| release base | `v0.1.6` = `992258fff08f8399fb9552f589fbaa9f064c1987` |
| integration branch | `v1-final-integration`, created from the base commit |
| tracked files at base | 280 (`git ls-files | wc -l`) |

```
git rev-parse eeefbe66098d6f93807383480790f9800335b516^{commit}
git merge-base --is-ancestor 992258fff08f8399fb9552f589fbaa9f064c1987 HEAD   # exit 0
git status --porcelain=v1                                                    # empty
```

**The base is one commit above the `v0.1.6` tag, and that commit touches no
executable code.** This is worth stating precisely, because it is what makes
`v0.1.6` a usable compatibility baseline for every later phase:

```
$ git diff --name-only 992258fff08f8399fb9552f589fbaa9f064c1987 eeefbe66098d6f93807383480790f9800335b516 -- src/ migrations/ schema/
(no output)
```

`src/`, `migrations/` and `schema/` are byte-identical to the released
`v0.1.6`. The commit above the tag changes `README.md`, `SECURITY.md`,
`docs/OPERATIONS.md` and three test files only. So a compatibility claim
measured against this base *is* a claim about `v0.1.6`, and does not need a
separate checkout to be honest.

## 2. Toolchain actually present

Measured on the machine that produced the P0 evidence:

| tool | version | how it is used |
|---|---|---|
| Node.js | v22.22.3 | `npm test`, `npm run typecheck`, `serve` (`engines.node` is `>=22.6`) |
| npm | 10.9.8 | `npm ci`, every `npm run` script |
| Bun | 1.3.14 | `test:bun`, `build:js`, `build:binary` — the version `ci.yml` pins |
| git | 2.39.5 | ancestry, refs/tags snapshots |
| Python | 3.11.2 | `ci/quickstart.sh` parses JSON with it |
| Docker | present | `quickstart-e2e` builds an image from `Dockerfile` |
| SQLite | `node:sqlite` (built in) / `bun:sqlite` | `src/sqlite.ts` picks one per runtime |

### The one environment fact that will bite a reviewer

`npm ci` **exits 0 while leaving the TypeScript compiler unusable** if the
shared npm cache is not writable. TypeScript 7 ships its compiler as a
platform-specific *optional* dependency (`@typescript/typescript-linux-x64`),
and npm treats a failure to fetch an optional dependency as success. The
symptom appears three steps later as

```
Error: Unable to resolve @typescript/typescript-linux-x64.
```

`.github/workflows/ci.yml` already guards this with an explicit step. Reproduce
that guard before trusting a green install:

```
node -e "require.resolve('@typescript/typescript-linux-x64/package.json')"
```

On this machine `/home/node/.npm/_cacache` is not writable by the running user
(`EACCES` on `mkdir`), so every command in this record was run with a
per-workspace cache:

```
export NPM_CONFIG_CACHE=<workspace>/.npm-cache
export BUN_INSTALL_CACHE_DIR=<workspace>/.bun-cache
```

This is an environment workaround, not a repository change. Nothing in the
tree was modified to accommodate it.

## 3. Repo-native commands (`P0-FR-04`)

These are the commands the repository actually has. They were discovered from
`package.json` and `.github/workflows/ci.yml`, then **run**. No command name in
this table was invented, and no result was assumed.

| gate | command | result at base |
|---|---|---|
| install (npm) | `npm ci` | exit 0 |
| install (bun) | `bun install --frozen-lockfile` | exit 0, `bun.lock` unchanged |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| typecheck (bun toolchain) | `bun x tsc --noEmit` | exit 0 |
| unit + integration tests | `npm test` | exit 0 — 1155 tests, 1154 pass, 0 fail, 1 skipped |
| tests under Bun | `bun run test:bun` | exit 0 — 1155 tests across 80 files, 0 fail |
| build (JS entry point) | `npm run build:js` | exit 0 |
| build (single-file binary) | `npm run build:binary` | exit 0 |
| schema dump | `npm run dump-schema` | exit 0 |
| migration / schema on a disposable DB | `v1/tools/p0-db-check.ts` (see section 5) | exit 0 |
| Registry API + CLI smoke | `v1/tools/p0-registry-smoke.sh` (see section 5) | exit 0 |

`ci.yml` names `bunx tsc --noEmit`. On this machine the `bunx` shim is not on
`PATH`; `bun x` is the same subcommand of the same binary and was used instead.
That is a difference in how the tool is invoked, not in what was checked.

The one skipped test is `ci/windows-security.ps1 reports WINDOWS_SECURITY_OK
4/4`, which the suite skips on Linux by design — the checks are about NTFS ACLs
and reparse points. Contract section 4.2 puts Windows qualification out of V1 scope, so
this skip is expected rather than tolerated. It is reported here rather than
hidden, as section 9 of the contract requires.

### Commands that exist but were not run at P0, and why

| command | why not run here |
|---|---|
| `docker build` + `ci/quickstart-docker.sh` | The containerised form of the same quickstart already run natively in section 5. It is a packaging gate, and P0 publishes nothing. Listed in `v1/P0-EVIDENCE-FORMAT.md` as a P6 gate. |
| `node ci/high-risk-exercise.mjs` | An operational exercise of the release lane. Out of P0's stated IN list; belongs to P6. |
| `ci/pin-actions.sh` | Rewrites workflow files and needs an authenticated `gh`. It mutates the tree and reaches the network; neither is P0 work. |
| `npm pack` / `ci/mvp-release.mjs` / `release.yml` | Publication paths. Contract section 2 forbids publish, tag, release and deploy. |

None of these is marked `N/A`: each exists, each is attributed to the phase that
must run it.

## 4. Surface inventory at the base commit

Extracted from the tree; the extraction commands are recorded in
evidence/P0/03-surface-inventory.txt alongside their output.

### Registry / backend

One process, one SQLite database. `src/service.ts` holds the domain logic,
`src/http.ts` dispatches HTTP, `src/mcp.ts` exposes the same operations as MCP
tools, `src/db.ts` owns migration. There is no second registry and no separate
frontend service — this already satisfies the shape `INV-01` requires, and later
phases must not break it.

### HTTP API

Literal routes: `/health`, `/mcp`, `/v1/auth/bootstrap`, `/v1/skills`,
`/v1/skills/from-source`, `/v1/verify`, `/v1/adoptions/requests`,
`/v1/transfer-grants`, `/v1/assignments`, `/v1/fleet`, `/v1/observations`,
`/v1/principals`, `/v1/signing-keys`, `/v1/webhooks`, `/v1/dashboard`,
`/v1/migrations`, `/v1/tlog`.

Parameterised routes cover version lifecycle (`/v1/versions/:id/{approvals,
publish, deprecate, revoke, supersede, lint, verify, reviews, ratings,
transfers}`), receipts (`/v1/receipts/:id` and `/v1/receipts/:id/events`),
adoption (`/v1/adoptions/:id/adopt`), assignment lifecycle
(`/v1/assignments/:id/{activate,pause,revoke}`), fleet capability reads
(`/v1/fleet/:agent/capabilities[/:id]`), principal keys
(`/v1/principals/:id/api-keys[/:key/revoke]`), signing-key revocation, webhook
reads and per-view dashboard reads.

### MCP surface

36 tools over `POST /mcp` (JSON-RPC `tools/list`, measured live — the full list
is in evidence/P0/logs/registry-smoke.log). They span skill creation, lint,
review, approval, publication, adoption, transfer, assignment lifecycle, fleet
listing, observation reporting, principal and signing-key administration,
dashboard reads, migration counting and transparency-log reads.

### Schema and migrations

12 migration files, `0001_init.sql` … `0012_…`. A fresh install lands at
`PRAGMA user_version = 12` with 26 tables, 13 indexes and 20 triggers. There is
no bookkeeping table: the version *is* `PRAGMA user_version`.

`src/db.ts` exports `UNSUPPORTED_UPGRADE_FROM = [10]` and refuses to upgrade a
database at that version, before opening a transaction. The documented
supported upgrade floor is `user_version` 9 or below.

**There are no down-migrations in the tree.** Reversal at the base is
restore-from-copy, not a `DOWN` script. This is a fact about the base, and it is
a constraint every schema-changing phase inherits: Contract section 2 requires schema
changes to be *additive and reversible*, so P1 onwards must either ship a
reversal mechanism or prove reversibility by a documented restore procedure on a
disposable database. Recorded here so the requirement is not discovered late.

### Auth

Bearer API key → SHA-256 → `api_keys` → `AuthContext {agent_id, workspace_id,
role, tool_profile, api_key_id}` (`src/auth.ts`). Roles are `owner`, `admin`,
`reviewer`, `member`. Rejections are uniform `UNAUTHORIZED`. First start prints
two one-time credentials, `BOOTSTRAP_OWNER_TOKEN` and `DEMO_ADOPTER_TOKEN`; the
bootstrap token is exchanged once for the owner API key and is then dead.

This is **machine-to-machine** authorization. `INV-04` requires a *browser*
session that never receives a service credential — a short-lived, `HttpOnly`,
same-origin cookie session — and **no such mechanism exists at the base**. That
gap is P2 work; `INV-04`'s allowance that "existing machine-to-machine
authorization may be kept, with its keys on the server" is what makes the
current scheme survivable rather than something to remove.

### Frontend / dashboard

Server-rendered, in-process: `src/dashboard.ts` (11 views, a thin read layer
over service functions) and `src/fleet-dashboard.ts` (5 screens plus an audit
that re-reads finished HTML/JSON and refuses a cell that claims `loaded` or
drops its attribution). There is no separate SPA, no client bundle and no
browser session — so there is no browser storage surface at the base, which is
why `P2-FR-14`'s browser-storage evidence has nothing to measure until P2.

### Runtime integration (Codex / Claude Code)

Present in structure, not yet as the V1 Skill Loop. `src/fleet.ts` holds an
asymmetric state × runtime matrix for `codex` and `claude_code` in which
`unknown` is a first-class answer, `loaded` is never claimed as `yes` on either
runtime, and Codex's `proposed` column is `unknown` always. `src/fleet-scan.ts`
is the only module allowed to touch a filesystem; `src/activation.ts` writes
native activations when `SKILLONOMIA_ACTIVATION_ROOT` is set and otherwise
records `queued` and writes nothing.

This is a strong starting point for `INV-02`/`INV-03`: the honesty rules those
invariants demand are already implemented and guarded here. What is missing for
P4 is the loadout snapshot and the adapters that make a canonical assignment
materialise natively.

## 5. Bringing up a disposable database and a local environment

### Disposable database

Nothing in this section touches a production database. Both harnesses create
their own directory with `mktemp -d` and remove it on exit.

```
# migration / schema checks on a throwaway database
node --experimental-strip-types --no-warnings v1/tools/p0-db-check.ts
```

It exercises, through the repository's own `src/db.ts` runner and never with
hand-written DDL: a fresh install reaching the highest migration on disk; two
fresh installs producing a byte-identical schema; `migrate()` being idempotent
on an already-migrated database; an upgrade from the documented supported floor
(`user_version` 9) converging on exactly the fresh-install schema; and the
refusal at `UNSUPPORTED_UPGRADE_FROM` being the documented refusal rather than
an incidental error.

### Local / integration environment

```
export NPM_CONFIG_CACHE=$PWD/.npm-cache        # only if the shared cache is unwritable
npm ci
node -e "require.resolve('@typescript/typescript-linux-x64/package.json')"   # install really is complete
DATA=$(mktemp -d)
SKILLONOMIA_DATA=$DATA SKILLONOMIA_PORT=7487 node bin/skillonomia.js serve
```

First start prints `BOOTSTRAP_OWNER_TOKEN` and `DEMO_ADOPTER_TOKEN` once. Exchange
the first for the owner key at `POST /v1/auth/bootstrap`. Relevant environment
variables: `SKILLONOMIA_DATA`, `SKILLONOMIA_PORT`, `SKILLONOMIA_HOST`,
`SKILLONOMIA_WORKER_MS`, `SKILLONOMIA_ASSETS`, `SKILLONOMIA_ACTIVATION_ROOT`
with `SKILLONOMIA_ACTIVATION_TARGET`, `SKILLONOMIA_INVENTORY_ROOT` with
`SKILLONOMIA_INVENTORY_RUNTIME`.

The whole path above is what `v1/tools/p0-registry-smoke.sh` automates:

```
v1/tools/p0-registry-smoke.sh
```

It checks the CLI (`version`, `help`, `verify-log`), starts a registry on a
disposable database, asserts `/health` reports **this checkout's** version,
asserts an unauthenticated `/v1/skills` is `401`, runs the repository's own
normative quickstart `ci/quickstart.sh` end to end to a terminal `adopted`
receipt, and lists the MCP tool surface. It uses only the public HTTP and CLI
contracts — no SQL is issued against the registry (`P0-FR-05`).

**Pick a free port deliberately.** The default is `7431`, and a machine may
already be running an unrelated deployment there — this one was, answering with
a different version. The smoke refuses to start if its port is already
answering, and then verifies the version it gets back, so it cannot silently
report on a stranger's server. That refusal is the reason the default was
changed to `7487` in the harness.

## 6. Baseline compatibility record

* `src/`, `migrations/` and `schema/` are byte-identical to `v0.1.6` (section 1 of the contract), so the
  measured behaviour below *is* `v0.1.6` behaviour.
* Fresh install: `PRAGMA user_version = 12`, 26 tables. Two independent fresh
  installs produce the same schema digest.
* Upgrade from `user_version` 9 converges on the fresh-install schema exactly.
* The full quickstart — bootstrap exchange, seed lookup, adoption request,
  delivery, fixture execution, `attempted`, `adopted`, terminal read-back —
  completes against a disposable database.
* An unauthenticated read of a protected route is `401`.

Later phases compare against these values. A phase that changes any of them has
changed Registry behaviour and owes an explanation under `INV-08`.
