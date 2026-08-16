#!/usr/bin/env bash
# GATE INTERFACE: clean-room owner journey
#
#   v1/tools/gates/clean-room-journey.sh
#
# NOT IMPLEMENTED FOR THIS PHASE. This is a real, invocable path with a written
# contract and a fail-closed exit — not a description of one. Contract section 9
# requires every mandatory gate category to be a command or a justified minimal
# deterministic harness; finding `P0-R1-002` was that P0 named this category in
# prose and left nothing to run. A stub that exits non-zero is an honest interface:
# it can be wired into a phase's gate list today and it can never be mistaken for a
# green result.
#
# OWED BY: P6
#
# THE CONTRACT THE IMPLEMENTATION MUST MEET
# Contract section 3.1 point 6 and `P6-FR-10` through `P6-FR-17`: an owner starting from
# nothing completes capture, review, approval, assignment, activation, a session with
# proposed/loaded/invoked/outcome, a revision update and a rollback — WITHOUT hand-
# writing a manifest, a package, a JSON payload, a SQLite row, an API key, signing
# material, an unpacked runtime file or a runtime config edit (`INV-09`).
#
# The implementation must:
#   1. start from a clean environment — fresh database, no adopted state, no artifact
#      left by another gate;
#   2. drive the journey through the product surfaces only, beginning with the natural
#      capture command of `P6-FR-10`;
#   3. record every step with a correlating backend or runtime receipt. Contract section 9
#      rules out screenshots that no receipt corroborates;
#   4. assert the ABSENCE of the manual steps: the transcript must contain no manifest
#      authored by the owner, no direct database write, no key or signature handling,
#      and no runtime config edit. Absence is the claim, so it must be measured — an
#      unasserted absence is the defect class this repository already has eight guards
#      for.
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

echo "GATE clean-room owner journey: NOT IMPLEMENTED FOR THIS PHASE." >&2
echo "Owed by: P6. Contract is in the header of $0." >&2
exit 3
