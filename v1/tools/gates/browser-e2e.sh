#!/usr/bin/env bash
# GATE: browser E2E — a real browser against a real deployment.
#
#   v1/tools/gates/browser-e2e.sh
#
# IMPLEMENTED BY P2, the first phase of this contract with a console to drive.
# Until then this path exited 3, NOT IMPLEMENTED FOR THIS PHASE; the contract P0
# wrote for it is unchanged and is what the harness below meets.
#
# OWED BY: P2, P3, P5 and P6 (every phase with an Owner Console surface)
#
# WHAT IT DRIVES. Chromium, through Playwright, against `skillonomia serve` on a
# free port with its own temporary data directory and its own SQLite file. The
# drafts it reads are drafts the run creates through `POST /v1/captures` with the
# owner's API key; there is no fixture and no hand-written row anywhere in it.
# The assertions and the requirement each one is owed to are listed at the head
# of `v1/tools/e2e/console-e2e.mjs`, and the run prints one line per check.
#
# THREE HARNESSES, FIVE RUNS. `console-e2e.mjs` drives the P2 workflow;
# `console-error-contract.mjs` drives the versioned-contract boundary on the
# answers that FAIL — a `400`, a `409` and a `412`, each with its version missing
# and with a foreign one (`INV-05`, P2 REVIEW-2 finding `P2-R2-001`) — and then
# runs again against a rebuilt PRE-FIX bundle, where those probes must fail.
# `console-p3-e2e.mjs`, added by V1 P3, drives the assignment and lifecycle
# screen: assign, activate, rollback, desired beside observed, and a REAL `412`
# and a REAL `409` with the refetch and reconciliation `P3-FR-12` requires — and
# it too runs again against a PRE-FIX bundle whose conflict handling is undone,
# where its conflict probes must fail. All five runs must pass for this gate to
# pass.
#
# WHERE `P3-FR-12` IS COVERED, SAID HERE RATHER THAN LEFT TO BE ASSUMED. The
# contract P0 wrote for this gate names `P3-FR-12` — a `409`/`412` conflict makes
# the console refetch canonical state. The P2 run exercises both statuses on the
# DRAFT surface (a second decision is `409`, an approval of a draft with a
# blocking finding is `412`). The P3 run exercises them on the ASSIGNMENT
# surface, which is where the requirement was written: the assignment moves under
# the rendered page and its lifecycle command comes back `412`, and one
# idempotency key over two payloads comes back `409`. Both refusals are this
# server's own, and the run records the statuses the browser actually received.
#
# THE BROWSER IS A DEPENDENCY, AND A MISSING ONE IS A REFUSAL, NOT A PASS.
# Playwright and its Chromium build are not in `package.json`: they are a harness
# dependency of this gate, installed under `PLAYWRIGHT_BROWSERS_PATH`, and a
# machine without them cannot run this gate. Exit 2 says so — the one thing this
# file may never do is report success having driven nothing.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0  the gate passed
#   1  the gate failed — a real defect on the surface it measures
#   2  REFUSED — the harness could not reach its subject; never reported as a pass
#   3  NOT IMPLEMENTED FOR THIS PHASE — what it measures does not exist yet
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

command -v node >/dev/null 2>&1 || { echo "REFUSED: node is not on PATH." >&2; exit 2; }
[ -f src/cli.ts ] || { echo "REFUSED: src/cli.ts is not here; this is not the registry checkout." >&2; exit 2; }
[ -f v1/tools/e2e/console-e2e.mjs ] || { echo "REFUSED: the browser run is missing." >&2; exit 2; }
[ -f v1/tools/e2e/console-p3-e2e.mjs ] || { echo "REFUSED: the P3 screen run is missing." >&2; exit 2; }

# The built console. The gate drives what a production build produced, never a
# source file served on the fly: P2's evidence list requires a production build
# of the console, and a gate that drove something else would be measuring a
# different artifact from the one the phase claims.
if ! command -v bun >/dev/null 2>&1; then
  echo "REFUSED: bun is not on PATH and it is what builds the console bundle." >&2
  exit 2
fi
echo "build: npm run build:console"
if ! npm run build:console >/dev/null 2>&1; then
  echo "FAIL  the console bundle did not build" >&2
  exit 1
fi
[ -s dist-console/app.js ] || { echo "REFUSED: the build produced no bundle." >&2; exit 2; }

# Playwright, and a browser it can actually launch.
if ! node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  echo "REFUSED: the 'playwright' module is not resolvable from this checkout." >&2
  echo "         Install it and its chromium build, then rerun. NODE_PATH or a local" >&2
  echo "         install both work; PLAYWRIGHT_BROWSERS_PATH names the browser dir." >&2
  exit 2
fi

# A port, and the assertion that whatever answers on it is THIS checkout. A
# long-lived registry from another tree holding the port would otherwise be
# measured instead, and would answer a different version — which the run checks
# against `package.json` before it drives anything.
PORT="${SKLN_E2E_PORT:-7993}"
# A GATE THAT DIRTIES THE TREE IT CERTIFIES CANNOT CERTIFY A CLEAN TREE. The
# default trace used to be `$PWD/console-e2e-trace.txt`, which is inside the
# checkout and is not ignored, so a run with no `SKLN_E2E_TRACE` left an
# untracked file behind and the next `git status --porcelain` — the check that
# the phase closes on a clean worktree — reported it. The default is now a
# temporary file outside the repository; a caller that wants the trace as
# evidence names where, which the phase runner already does.
TRACE="${SKLN_E2E_TRACE:-$(mktemp -t skln-console-e2e-trace.XXXXXX)}"
export SKLN_E2E_PORT="$PORT"
export SKLN_E2E_TRACE="$TRACE"

echo "gate:  browser E2E of the Owner Console (P2-FR-01..15, INV-04, INV-05)"
echo "port:  $PORT"
echo "trace: $TRACE"
echo
node v1/tools/e2e/console-e2e.mjs
rc=$?
if [ "$rc" -ne 0 ]; then
  echo
  case "$rc" in
    2) echo "REFUSED browser E2E — the harness could not reach its subject" >&2 ;;
    *) echo "FAIL  browser E2E (exit $rc)" >&2 ;;
  esac
  exit "$rc"
fi

# THE SECOND HARNESS — the versioned-contract boundary on the answers that FAIL
# (`INV-05`, P2 REVIEW-2 finding `P2-R2-001`). It is part of this gate rather
# than a probe beside it because it measures the same surface with the same
# browser, and a check that runs only when somebody remembers to run it is the
# shape of the hole it closes.
#
# It runs TWICE. The first run is the probes. The second rebuilds the bundle from
# a copy of `console/app.ts` with the fix undone and requires every mutated probe
# to FAIL against it — a probe nobody has seen fail proves nothing, and this is
# the seeing.
echo
echo "gate:  the versioned-contract boundary on 400 / 409 / 412 (INV-05, P2-R2-001)"
echo
SKLN_ERROR_CONTRACT_PORT="${SKLN_ERROR_CONTRACT_PORT:-$((PORT - 1))}" node v1/tools/e2e/console-error-contract.mjs
rc=$?
if [ "$rc" -ne 0 ]; then
  echo
  case "$rc" in
    2) echo "REFUSED error-contract probes — the harness could not reach its subject" >&2 ;;
    *) echo "FAIL  error-contract probes (exit $rc)" >&2 ;;
  esac
  exit "$rc"
fi

echo
echo "demo:  the same probes against the PRE-FIX client, which must fail them"
echo
SKLN_ERROR_CONTRACT_PORT="${SKLN_ERROR_CONTRACT_NEG_PORT:-$((PORT - 2))}" node v1/tools/e2e/console-error-contract.mjs --broken-client
rc=$?
echo
case "$rc" in
  0) echo "ok    the error-contract probes fail against a client that has the defect" ;;
  2) echo "REFUSED the negative demonstration — the harness could not reach its subject" >&2 ; exit 2 ;;
  *) echo "FAIL  the negative demonstration (exit $rc): the probes did not fail against a client that has the defect" >&2 ; exit "$rc" ;;
esac

# THE THIRD HARNESS — V1 P3's assignment and lifecycle screen, and the conflict
# and precondition reconciliation the contract's P3 evidence list names.
echo
echo "gate:  the assignment and lifecycle screen, with a real 409 and a real 412 (P3-FR-01..16, INV-02, INV-03, INV-07)"
echo
SKLN_P3_E2E_PORT="${SKLN_P3_E2E_PORT:-$((PORT - 3))}" node v1/tools/e2e/console-p3-e2e.mjs
rc=$?
if [ "$rc" -ne 0 ]; then
  echo
  case "$rc" in
    2) echo "REFUSED the P3 screen run — the harness could not reach its subject" >&2 ;;
    *) echo "FAIL  the P3 screen run (exit $rc)" >&2 ;;
  esac
  exit "$rc"
fi

echo
echo "demo:  the same conflict probes against a PRE-FIX client, which must fail them"
echo
SKLN_P3_E2E_PORT="${SKLN_P3_E2E_NEG_PORT:-$((PORT - 4))}" node v1/tools/e2e/console-p3-e2e.mjs --broken-client
rc=$?
echo
case "$rc" in
  0) echo "PASS  the P2 browser E2E, the error-contract probes, the P3 assignment and lifecycle screen, and both demonstrations that their probes can fail" ;;
  2) echo "REFUSED the P3 negative demonstration — the harness could not reach its subject" >&2 ;;
  *) echo "FAIL  the P3 negative demonstration (exit $rc): the conflict probes did not fail against a client that has the defect" >&2 ;;
esac
exit "$rc"
