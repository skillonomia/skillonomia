#!/usr/bin/env bash
# GATE INTERFACE: dogfood ledger metrics
#
#   v1/tools/gates/dogfood-metrics.sh
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
# Contract section 9 and the P6 evidence list: the dogfood metrics must be COMPUTED FROM
# STRUCTURED RECEIPTS, not from names or audit strings (`P6-FR-09`), and no record may
# come from fixtures, seed scripts or hand-inserted rows (`P6-FR-08`).
#
# The implementation must read the ledger and the receipt store and assert:
#   * at least 10 distinct real skills, each with an approved revision, an active
#     desired assignment and at least one real invocation receipt (`P6-FR-01`);
#   * at least 5 of them reused — same skill/revision lineage invoked in two or more
#     DIFFERENT real sessions, where a redelivered receipt does not count twice
#     (`P6-FR-02`, and the idempotency rule of `P5-FR-06`);
#   * at least 2 distinct skills with invocation receipts from two or more distinct
#     `agent_id` values (`P6-FR-03`);
#   * at least one real end-to-end Codex session and one real end-to-end Claude Code
#     session (`P6-FR-04`, `P6-FR-05`);
#   * one complete improvement cycle and one proven revision rollback, each with exact
#     old and new revision IDs (`P6-FR-06`, `P6-FR-07`);
#   * no record traceable to a fixture, a seed script or a direct database insert.
# Every count must be derived by the harness from the receipts. A count restated from
# the ledger prose is a transcription, not a measurement.
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

echo "GATE dogfood ledger metrics: NOT IMPLEMENTED FOR THIS PHASE." >&2
echo "Owed by: P6. Contract is in the header of $0." >&2
exit 3
