#!/usr/bin/env bash
# GATE INTERFACE: reversible migration round trip
#
#   v1/tools/gates/reversible-migration.sh
#
# NOT IMPLEMENTED FOR THIS PHASE. This is a real, invocable path with a written
# contract and a fail-closed exit — not a description of one. Contract section 9
# requires every mandatory gate category to be a command or a justified minimal
# deterministic harness; finding `P0-R1-002` was that P0 named this category in
# prose and left nothing to run. A stub that exits non-zero is an honest interface:
# it can be wired into a phase's gate list today and it can never be mistaken for a
# green result.
#
# OWED BY: every schema-changing phase (P1 onward)
#
# THE CONTRACT THE IMPLEMENTATION MUST MEET
# Contract section 2 requires schema changes to be additive AND reversible, and section 9
# makes a migration round trip mandatory for schema-changing phases. `v1/P0-BASELINE.md`
# records the fact this gate has to work around: at the base commit the repository has
# NO down-migration, so reversal is restore-from-copy rather than `migrate down`.
#
# The implementation must, on a disposable database only:
#   1. build the pre-change schema (fresh install at the previous migration count, or a
#      copy taken before the phase migration runs);
#   2. take a schema digest and a row census of the tables the phase touches;
#   3. apply the phase migration; assert it is ADDITIVE — no table or column dropped,
#      no column retyped, no existing row rewritten;
#   4. reverse it by the documented route (down-migration if the phase adds one,
#      otherwise restore-from-copy) and assert the digest and census match step 2;
#   5. re-apply and assert convergence on the post-change digest — up/down/up.
# It must print the digests it compared. A round trip that reports success without
# showing two equal digests has asserted rather than measured.
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

echo "GATE reversible migration round trip: NOT IMPLEMENTED FOR THIS PHASE." >&2
echo "Owed by: every schema-changing phase (P1 onward). Contract is in the header of $0." >&2
exit 3
