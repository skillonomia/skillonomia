#!/usr/bin/env bash
# GATE INTERFACE: upgrade from a v0.1.6 copy
#
#   v1/tools/gates/upgrade-from-v016.sh
#
# NOT IMPLEMENTED FOR THIS PHASE. This is a real, invocable path with a written
# contract and a fail-closed exit — not a description of one. Contract section 9
# requires every mandatory gate category to be a command or a justified minimal
# deterministic harness; finding `P0-R1-002` was that P0 named this category in
# prose and left nothing to run. A stub that exits non-zero is an honest interface:
# it can be wired into a phase's gate list today and it can never be mistaken for a
# green result.
#
# OWED BY: P1 and P6
#
# THE CONTRACT THE IMPLEMENTATION MUST MEET
# Contract section 3.1 point 8 and `INV-08`: the data of release base `v0.1.6` keeps
# working. `v1/P0-BASELINE.md` records that the phase base commit is one commit above
# the `v0.1.6` tag and changes no file under src/, migrations/ or schema/, so a
# database built by this checkout at the base IS a `v0.1.6` database — no second
# checkout is needed to produce the subject.
#
# The implementation must, on a disposable copy only:
#   1. create a database with the base-commit migration set and populate it through the
#      PUBLIC contracts — the CLI and the HTTP API, never direct SQL, per `P0-FR-05`;
#   2. record the surfaces that must survive: the readable rows, the API responses and
#      the schema digest;
#   3. run the current migration set over that copy;
#   4. assert every recorded surface still answers identically, and that no existing
#      Registry operation changed behaviour;
#   5. assert no manual migration step was required — contract `INV-08` forbids one as
#      part of normal operation.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0  the gate passed
#   1  the gate failed — a real defect on the surface it measures
#   2  REFUSED — the harness could not reach its subject; never reported as a pass
#   3  NOT IMPLEMENTED FOR THIS PHASE — what it measures does not exist yet
#
# Replacing this file is the implementing phase's job. Deleting it, or making it
# exit 0, is not: the gate table names this path, and `v1/tools/p0-gate-table-check.ts`
# fails if the path stops resolving.
set -uo pipefail

echo "GATE upgrade from a v0.1.6 copy: NOT IMPLEMENTED FOR THIS PHASE." >&2
echo "Owed by: P1 and P6. Contract is in the header of $0." >&2
exit 3
