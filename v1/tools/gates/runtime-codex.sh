#!/usr/bin/env bash
# GATE INTERFACE: actual Codex runtime session
#
#   v1/tools/gates/runtime-codex.sh
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
# Contract section 9 and `P4-FR-17`/`P4-FR-19`: an ACTUAL Codex session must load and
# invoke the assigned exact revision. Contract section 9 states outright that mocked
# adapter tests never substitute for this, and contract section 11 makes missing runtime
# access a blocker for Leo rather than grounds to fall back to mocks — so this harness
# must REFUSE (exit 2) when it cannot reach a real runtime, and must never downgrade
# itself to a simulation.
#
# The implementation must:
#   1. build a loadout from a canonical active desired assignment, through the product
#      path — no hand-written manifest, package, signature or runtime config edit
#      (`P4-FR-07`, `INV-09`);
#   2. start a real Codex session and let the adapter materialise natively;
#   3. capture a structured runtime receipt correlating session, agent, skill AND EXACT
#      REVISION with its content digest — a skill name alone fails `P4-FR-19`;
#   4. assert the stage order `registered -> assigned -> proposed -> loaded -> invoked
#      -> outcome`, with `loaded` set only on adapter/runtime confirmation and `invoked`
#      only on a structured receipt (`P4-FR-09`, `P4-FR-10`);
#   5. assert that with the receipt withheld the observed state is `unknown` carrying
#      `reason_code`, `reason`, `source` and `observed_at` — never `loaded` or `worked`
#      (`INV-03`, `P4-FR-11`);
#   6. assert no raw secret reached the native artifacts or the runtime logs
#      (`P4-FR-15`).
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

echo "GATE actual Codex runtime session: NOT IMPLEMENTED FOR THIS PHASE." >&2
echo "Owed by: P4, P5 and P6. Contract is in the header of $0." >&2
exit 3
