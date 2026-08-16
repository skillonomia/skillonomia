#!/usr/bin/env bash
# GATE: security regression over the threat-model surface.
#
#   v1/tools/gates/security-regression.sh
#
# Contract section 9 makes "security regressions для затронутой threat-model
# поверхности" mandatory, and contract section 6 — frozen in `v1/P0-THREAT-MODEL.md` —
# fixes what that surface is. Contract section 6 also fixes what it is NOT: a finding
# outside the frozen model is backlog, never a phase blocker, so this gate is
# deliberately not a general hardening sweep.
#
# THIS IS A REAL COMMAND, NOT AN INTERFACE. The files below are the parts of the
# existing suite that sit on the frozen threat-model surface at the base commit:
#
#   p7-threats.test.ts      the threat cases the release round enumerated
#   p7-threat-map.test.ts   every threat maps to a mitigation and a test
#   p3-gates.test.ts        the content safety gates, including the secret gates
#   p14-r9-probes.test.ts   token-shaped values must not reach an evidence name
#   p14-r9b-probes.test.ts  secrets in other forms — hex, base32, token
#   p14-r10-probes.test.ts  a planted credential is found rather than passed through
#   bind-address.test.ts    the server does not bind wider than it was told to
#   docker-network-boundary.test.ts  the container network boundary
#   transport.test.ts       transport-level handling
#
# A PHASE THAT TOUCHES A NEW PART OF THE THREAT-MODEL SURFACE ADDS ITS FILE HERE.
# P2 owes the browser-session, CSRF and XSS cases; P4 owes path traversal, unsafe
# filename and symlink escape at materialisation. Those are listed against their
# phases in `v1/P0-TRACEABILITY.md`; this file is where their tests get run.
#
# Exit: 0 pass · 1 fail · 2 refused (a named test file is missing)
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

FILES=(
  test/p7-threats.test.ts
  test/p7-threat-map.test.ts
  test/p3-gates.test.ts
  test/p14-r9-probes.test.ts
  test/p14-r9b-probes.test.ts
  test/p14-r10-probes.test.ts
  test/bind-address.test.ts
  test/docker-network-boundary.test.ts
  test/transport.test.ts
)

missing=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "REFUSED: $f is named by this gate and is not in the tree." >&2; missing=1; }
done
if [ "$missing" -ne 0 ]; then
  echo "REFUSED: a security gate that silently drops a missing subject reports success having checked less." >&2
  exit 2
fi

echo "gate:  security regression over the frozen threat model (contract section 6)"
echo "files: ${#FILES[@]}"
echo
node --experimental-strip-types --no-warnings --test "${FILES[@]}"
rc=$?
echo
if [ "$rc" -eq 0 ]; then echo "PASS  security regression suite"; else echo "FAIL  security regression suite (exit $rc)" >&2; fi
exit "$rc"
