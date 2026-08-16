#!/usr/bin/env bash
# GATE INTERFACE: browser E2E
#
#   v1/tools/gates/browser-e2e.sh
#
# NOT IMPLEMENTED FOR THIS PHASE. This is a real, invocable path with a written
# contract and a fail-closed exit — not a description of one. Contract section 9
# requires every mandatory gate category to be a command or a justified minimal
# deterministic harness; finding `P0-R1-002` was that P0 named this category in
# prose and left nothing to run. A stub that exits non-zero is an honest interface:
# it can be wired into a phase's gate list today and it can never be mistaken for a
# green result.
#
# OWED BY: P2, P3, P5 and P6 (every phase with an Owner Console surface)
#
# THE CONTRACT THE IMPLEMENTATION MUST MEET
# Contract section 9 makes browser E2E mandatory for Console phases; `INV-04` and the
# P2 requirement list fix what it must prove. No browser session and no console route
# exists at the base commit, which is why this is an interface rather than a command.
#
# The implementation must drive a REAL BROWSER against a locally started server and
# assert at minimum:
#   * a protected console route and a protected API are unreachable with no session
#     (`P2-FR-01`);
#   * the session cookie is `HttpOnly`, is `SameSite=Strict` or a justified `Lax`, is
#     `Secure` outside localhost, and the absolute session lifetime is 60 minutes or
#     less (`P2-FR-02`, `INV-04`);
#   * logout and expiry invalidate the session SERVER-side, not only in the browser;
#   * `localStorage`, `sessionStorage`, IndexedDB, the Cache API, JS-readable cookies
#     and the URL carry no API key, service credential or session secret after a full
#     workflow (`P2-FR-14`);
#   * no request or response in the captured network trace carries a Registry API key
#     (`P2-FR-03`);
#   * a CSRF/Origin negative case is rejected (`P2-FR-13`);
#   * untrusted draft content renders without executing HTML or script (`P2-FR-06`);
#   * a `409`/`412` conflict makes the console refetch canonical state and show the
#     conflict rather than a false success (`P3-FR-12`).
# It must write a sanitised trace to the phase evidence directory and reference it from
# the run record. A screenshot with no correlating backend receipt is not evidence
# (contract section 9).
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

echo "GATE browser E2E: NOT IMPLEMENTED FOR THIS PHASE." >&2
echo "Owed by: P2, P3, P5 and P6 (every phase with an Owner Console surface). Contract is in the header of $0." >&2
exit 3
