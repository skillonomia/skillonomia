#!/usr/bin/env bash
# GATE: actual Codex runtime session.
#
#   SKLN_RUNTIME_WORK=/some/writable/dir v1/tools/gates/runtime-codex.sh
#
# EXTENDED BY P5, which added the OUTCOME path to the same real run: the
# invocation's outcome is filed from the runtime's own output, a redelivery of
# it replays, a contradicting one is refused and recorded, and a second session
# closed with nothing said yields `nothing_reported` (`P5-FR-02`, `P5-FR-04`,
# `P5-FR-06`, `P5-FR-07`, `P5-FR-15`).
#
# IMPLEMENTED BY P4. It drives the SHIPPED product end to end against the REAL
# `codex` binary: an owner captures, approves, assigns and activates through the
# P1/P2/P3 surfaces; `skillonomia adapter open` freezes the session loadout and
# materialises it into a session-scoped `CODEX_HOME`; `skillonomia adapter
# invoke` runs a real `codex exec` session against that home; and the receipt
# the runtime's own output proves is filed through the evidence-principal
# boundary. Nothing here is mocked and nothing falls back to a simulation.
#
# WHAT IT ASSERTS — the six obligations this file has carried since P0, plus the
# two the phase added:
#   1. the loadout is built from a canonical ACTIVE assignment, through the
#      product path — no hand-written manifest, package, signature or runtime
#      config edit (`P4-FR-07`, `INV-09`);
#   2. a real Codex session loads what the adapter materialised natively;
#   3. the receipt correlates session, agent, skill AND EXACT REVISION with its
#      content digest — the runtime ECHOES the revision id and digest that the
#      materialised `SKILL.md` states, and the registry refuses the receipt if
#      the digest is not the one the loadout froze (`P4-FR-19`);
#   4. the stage order `proposed -> loaded -> invoked`, with `loaded` only on
#      adapter confirmation after a read-back and `invoked` only on that
#      structured receipt (`P4-FR-09`, `P4-FR-10`);
#   5. with the receipt withheld the observed state is `unknown` carrying
#      `reason_code`, `reason`, `source` and `observed_at` (`INV-03`,
#      `P4-FR-11`);
#   6. no raw secret reached the native artifacts or the runtime transcript
#      (`P4-FR-15`);
#   7. the OWNER's own key is `403` on the session and receipt intakes
#      (`P4-FR-13`, `INV-02`);
#   8. deleting every derived artifact destroys no canonical data (`P4-FR-08`).
#
# THIS CONTAINER'S ONE LIMITATION, STATED WHERE IT IS RELIED ON. `codex` ships
# its own bubblewrap sandbox and reads `SKILL.md` through its shell tool; this
# container cannot nest that sandbox, so skill loading fails until the sandbox is
# delegated to the container that already is one. The adapter therefore passes
# `--dangerously-bypass-approvals-and-sandbox` (`src/adapter-cli.ts`). That is an
# ENVIRONMENT LIMITATION of this host and not a security choice of the design; a
# host that can nest bubblewrap should drop the flag.
#
# IT REFUSES (exit 2) rather than simulating when the `codex` binary is absent,
# when no writable work directory OUTSIDE the evidence package was named, or
# when the port it would measure is already answering. Contract section 11 makes
# missing runtime access a blocker for Leo, never grounds to fall back to mocks.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0  the gate passed
#   1  the gate failed — a real defect on the surface it measures
#   2  REFUSED — the harness could not reach its subject; never reported as a pass
#   3  NOT IMPLEMENTED FOR THIS PHASE — what it measures does not exist yet
set -uo pipefail
exec "$(dirname "$0")/runtime-harness.sh" codex
