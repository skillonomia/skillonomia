#!/usr/bin/env bash
# GATE: dogfood ledger metrics.
#
#   SKLN_DOGFOOD_DB=/path/to/skillonomia.db v1/tools/gates/dogfood-metrics.sh [--json FILE]
#
# IMPLEMENTED BY P6. The stub this replaces carried the contract the
# implementation had to meet; it is met by `v1/tools/dogfood-metrics-check.ts`,
# and the header of that file records how each count is derived.
#
# WHAT IT MEASURES, and where the numbers come from: every one of them is a
# query over the registry's own INSERT-only tables — `runtime_receipts`,
# `agent_sessions`, `skill_assignment_events`, `revision_approvals`,
# `session_outcomes`. Nothing is read from a ledger, a file name, a session
# label or an audit string (`P6-FR-09`), and a counted revision that descends
# from no capture fails the gate (`P6-FR-08`).
#
# IT REFUSES (exit 2) rather than passing when no database is named, when the
# named file does not exist, or when it is not a registry migrated past `0017`.
# It is pointed at the DOGFOOD deployment — the one that persists outside the
# evidence package and outside the repository — because that is where real use
# accumulates. Pointed at a disposable gate database it will refuse or report the
# small numbers that database honestly holds; it has no mode in which it invents
# one.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0  the gate passed
#   1  the gate failed — a threshold was not met, reported with the number found
#   2  REFUSED — the harness could not reach its subject; never reported as a pass
#   3  NOT IMPLEMENTED FOR THIS PHASE — what it measures does not exist yet
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DB="${SKLN_DOGFOOD_DB:-}"
if [ -z "$DB" ]; then
  echo "REFUSED: set SKLN_DOGFOOD_DB to the dogfood registry's database." >&2
  echo "The dogfood deployment lives outside the evidence package and outside the repository," >&2
  echo "and this gate will not guess which database holds the real use." >&2
  exit 2
fi

exec node --experimental-strip-types --no-warnings "$REPO/v1/tools/dogfood-metrics-check.ts" "$DB" "$@"
