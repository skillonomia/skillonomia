#!/usr/bin/env bash
# GATE: Registry backwards-compatibility suite.
#
#   v1/tools/gates/registry-compat.sh
#
# Contract section 9 makes "backwards-compatibility checks Registry" a mandatory gate
# category for every phase, and `INV-08` is the invariant it defends: the existing
# Registry API, CLI and the data of release base `v0.1.6` keep working, schema
# changes stay additive, and no existing operation changes behaviour.
#
# THIS IS A REAL COMMAND, NOT AN INTERFACE. The repository already carries the tests
# that make the claim; what was missing at P0 BUILD-1 was a named, runnable entry
# point, which is what finding `P0-R1-002` was about. The file list below is the
# compatibility surface as it exists at the base commit:
#
#   p6-compat.test.ts         the compatibility matcher and its result vocabulary
#   v1p2-console.test.ts      P2's own: every P1 draft surface answers as it did with
#                             an API key, and a machine client carrying nothing but an
#                             Authorization header is unaffected by the console
#   migration-count.test.ts   the migration set is append-only and its count is pinned
#   schema-conformance.test.ts the shipped JSON schemas against the objects produced
#   insert-only.test.ts       the append-only storage triggers
#   lifecycle-surfaces.test.ts the lifecycle surfaces the CLI and HTTP API expose
#
# A LATER PHASE THAT ADDS A COMPATIBILITY SURFACE ADDS ITS FILE HERE. That is the
# point of the indirection: the gate table names one command, and the command's
# subject grows with the product. A phase that adds a table, an endpoint or a
# migration and does NOT extend this list has left the gate measuring the old
# surface, which the phase's own review is expected to catch.
#
# Exit: 0 pass · 1 fail · 2 refused (a named test file is missing)
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

FILES=(
  test/p6-compat.test.ts
  test/migration-count.test.ts
  test/schema-conformance.test.ts
  test/insert-only.test.ts
  test/lifecycle-surfaces.test.ts
  test/v1p1-compat.test.ts
  test/v1p2-console.test.ts
)

missing=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "REFUSED: $f is named by this gate and is not in the tree." >&2; missing=1; }
done
if [ "$missing" -ne 0 ]; then
  echo "REFUSED: a compatibility gate that silently drops a missing subject reports success having checked less." >&2
  exit 2
fi

echo "gate:  Registry backwards-compatibility (INV-08)"
echo "files: ${#FILES[@]}"
echo
node --experimental-strip-types --no-warnings --test "${FILES[@]}"
rc=$?
echo
if [ "$rc" -eq 0 ]; then echo "PASS  Registry backwards-compatibility suite"; else echo "FAIL  Registry backwards-compatibility suite (exit $rc)" >&2; fi
exit "$rc"
