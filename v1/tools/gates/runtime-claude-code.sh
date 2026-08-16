#!/usr/bin/env bash
# GATE INTERFACE: actual Claude Code runtime session
#
#   v1/tools/gates/runtime-claude-code.sh
#
# NOT IMPLEMENTED FOR THIS PHASE. This is a real, invocable path with a written
# contract and a fail-closed exit — not a description of one. Contract section 9
# requires every mandatory gate category to be a command or a justified minimal
# deterministic harness; finding `P0-R1-002` was that P0 named this category in
# prose and left nothing to run. A stub that exits non-zero is an honest interface:
# it can be wired into a phase's gate list today and it can never be mistaken for a
# green result.
#
# OWED BY: P4, P5 and P6
#
# THE CONTRACT THE IMPLEMENTATION MUST MEET
# Contract section 9 and `P4-FR-18`/`P4-FR-19`, the Claude Code half of the same
# requirement. It is a separate harness rather than a parameter of the Codex one
# because the two native mechanisms differ, and a single harness with a runtime flag
# invites one implementation to be proved and the other to be assumed.
#
# The implementation must meet the same six obligations as
# `v1/tools/gates/runtime-codex.sh`, against a real Claude Code session, and must
# additionally assert that the SAME canonical revision — same skill ID, same revision
# ID, same content digest — is what both runtimes loaded (`P4-FR-06`, `INV-01`: the
# adapters are thin projections of one canonical model, not two models).
#
# It must REFUSE (exit 2) rather than simulate when no real runtime is reachable.
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

echo "GATE actual Claude Code runtime session: NOT IMPLEMENTED FOR THIS PHASE." >&2
echo "Owed by: P4, P5 and P6. Contract is in the header of $0." >&2
exit 3
