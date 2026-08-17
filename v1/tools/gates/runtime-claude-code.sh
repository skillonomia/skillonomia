#!/usr/bin/env bash
# GATE: actual Claude Code runtime session.
#
#   SKLN_RUNTIME_WORK=/some/writable/dir v1/tools/gates/runtime-claude-code.sh
#
# EXTENDED BY P5, which added the OUTCOME path to the same real run: the
# invocation's outcome is filed from the runtime's own output, a redelivery of
# it replays, a contradicting one is refused and recorded, and a second session
# closed with nothing said yields `nothing_reported` (`P5-FR-02`, `P5-FR-04`,
# `P5-FR-06`, `P5-FR-07`, `P5-FR-15`).
#
# IMPLEMENTED BY P4. It is a SEPARATE gate from the Codex one because the two
# native mechanisms differ and a single harness with a runtime flag invites one
# implementation to be proved and the other assumed — and it runs the SAME
# scenario body (`v1/tools/gates/runtime-session.mjs`) so the two cannot drift
# into proving different things.
#
# It drives the shipped product end to end against the REAL `claude` binary:
# `skillonomia adapter open` materialises the frozen loadout into a
# session-scoped `CLAUDE_CONFIG_DIR`, and `skillonomia adapter invoke` runs a
# real `claude -p ... --output-format json` session against that home. The
# machine-readable JSON that run emits carries the runtime's own `session_id`,
# which is the correlation the receipt is filed with.
#
# WHAT IT ASSERTS: the same eight obligations as
# `v1/tools/gates/runtime-codex.sh`, against a real Claude Code session. The
# additional claim that both runtimes loaded the SAME canonical revision — same
# skill id, same revision id, same content digest (`P4-FR-06`, `INV-01`) — is
# asserted in `test/v1p4-session-loadout.test.ts`, which builds one loadout per
# runtime from ONE approved revision and compares the rendered bytes; and it is
# visible here as the revision id and digest this gate prints, which are the
# same values the Codex gate prints for the same assignment.
#
# THIS RUNTIME'S ONE REQUIREMENT, STATED WHERE IT IS RELIED ON. Without
# `--permission-mode bypassPermissions` the Skill call is DENIED non-interactively
# and the run emits no JSON at all — so a session that would have loaded the
# skill leaves no receipt to file. The adapter passes it (`src/adapter-cli.ts`).
#
# IT REFUSES (exit 2) rather than simulating when the `claude` binary is absent,
# when no writable work directory OUTSIDE the evidence package was named, or when
# the port it would measure is already answering.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0  the gate passed
#   1  the gate failed — a real defect on the surface it measures
#   2  REFUSED — the harness could not reach its subject; never reported as a pass
#   3  NOT IMPLEMENTED FOR THIS PHASE — what it measures does not exist yet
set -uo pipefail
exec "$(dirname "$0")/runtime-harness.sh" claude_code
