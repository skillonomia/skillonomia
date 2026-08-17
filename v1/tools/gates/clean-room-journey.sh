#!/usr/bin/env bash
# GATE: the clean-room owner journey.
#
#   v1/tools/gates/clean-room-journey.sh
#
# IMPLEMENTED BY P6. Until P6 this path exited 3, NOT IMPLEMENTED FOR THIS PHASE;
# the contract P0 wrote for it is below, unchanged, and is what this harness meets.
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
# HOW EACH OF THE FOUR IS MET, so a reader can check the claim rather than take it:
#   1  `v1/tools/e2e/clean-room-journey.mjs` starts `skillonomia serve` on a free port
#      with a `mktemp -d` data directory: an empty registry, and nothing another gate
#      touched. It refuses unless `/health` reports THIS checkout's version.
#   2  the owner's every act is a click or a keystroke in Chromium against the built
#      console bundle, or a sentence typed at their agent. The journey begins at
#      "оформи это как скилл" and the capture is submitted by the runtime adapter with
#      the adapter's own credential — the owner never holds one.
#   3  every act is written to a JOURNAL with the server-confirmed identifier that came
#      back: draft, revision, assignment, session, receipt and outcome ids the REGISTRY
#      answered with. `v1/tools/p6-clean-room-check.ts` fails an act that has none.
#   4  the absence is measured four ways — transport, credential, typed content and
#      filesystem — and the measurement is itself tested: this gate runs the journey a
#      second time with `--manual-owner`, whose owner hand-writes a manifest, sends the
#      API key and edits a runtime config, and REQUIRES the checker to refuse that
#      journal. It then truncates a good journal and requires the checker to refuse
#      that too, because a checker that only reads what is there would pass an empty
#      file.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0  the gate passed
#   1  the gate failed — a real defect on the surface it measures
#   2  REFUSED — the harness could not reach its subject; never reported as a pass
#   3  NOT IMPLEMENTED FOR THIS PHASE — what it measures does not exist yet
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

command -v node >/dev/null 2>&1 || { echo "REFUSED: node is not on PATH." >&2; exit 2; }
[ -f src/cli.ts ] || { echo "REFUSED: src/cli.ts is not here; this is not the registry checkout." >&2; exit 2; }
[ -f v1/tools/e2e/clean-room-journey.mjs ] || { echo "REFUSED: the journey harness is missing." >&2; exit 2; }
[ -f v1/tools/p6-clean-room-check.ts ] || { echo "REFUSED: the journal checker is missing." >&2; exit 2; }

if ! command -v bun >/dev/null 2>&1; then
  echo "REFUSED: bun is not on PATH and it is what builds the console bundle." >&2
  exit 2
fi
if ! node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  echo "REFUSED: the 'playwright' module is not resolvable from this checkout." >&2
  exit 2
fi

echo "build: npm run build:console"
if ! npm run build:console >/dev/null 2>&1; then
  echo "FAIL  the console bundle did not build" >&2
  exit 1
fi
[ -s dist-console/app.js ] || { echo "REFUSED: the build produced no bundle." >&2; exit 2; }

WORK="${SKLN_CLEAN_ROOM_WORK:-$(mktemp -d -t skln-clean-room.XXXXXX)}"
mkdir -p "$WORK" || { echo "REFUSED: $WORK is not writable." >&2; exit 2; }
JOURNAL="$WORK/clean-room-journal.jsonl"
MANUAL_JOURNAL="$WORK/manual-owner-journal.jsonl"
PARTIAL_JOURNAL="$WORK/partial-journal.jsonl"

echo "gate:  the clean-room owner journey (P6-FR-10..17, INV-04, INV-06, INV-07, INV-09)"
echo "work:  $WORK"
echo

echo "--- the journey"
SKLN_CLEAN_ROOM_JOURNAL="$JOURNAL" node v1/tools/e2e/clean-room-journey.mjs
rc=$?
if [ "$rc" -ne 0 ]; then
  case "$rc" in
    2) echo "REFUSED the journey — the harness could not reach its subject" >&2 ;;
    *) echo "FAIL  the journey (exit $rc)" >&2 ;;
  esac
  exit "$rc"
fi

echo
echo "--- the journal, read by the checker"
node --experimental-strip-types --no-warnings v1/tools/p6-clean-room-check.ts "$JOURNAL"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FAIL  the journal of a clean journey did not pass the checker (exit $rc)" >&2
  exit "$rc"
fi

echo
echo "--- the demonstration: an owner who DOES hand-write a manifest, send the key and edit a runtime config"
SKLN_CLEAN_ROOM_JOURNAL="$MANUAL_JOURNAL" node v1/tools/e2e/clean-room-journey.mjs --manual-owner
rc=$?
if [ "$rc" -ne 0 ]; then
  case "$rc" in
    2) echo "REFUSED the manual-owner journey — the harness could not reach its subject" >&2 ;;
    *) echo "FAIL  the manual-owner journey did not run (exit $rc)" >&2 ;;
  esac
  exit "$rc"
fi
echo
node --experimental-strip-types --no-warnings v1/tools/p6-clean-room-check.ts "$MANUAL_JOURNAL"
rc=$?
if [ "$rc" -ne 1 ]; then
  echo "FAIL  the checker did not refuse a journey with three forbidden owner steps in it (exit $rc)" >&2
  exit 1
fi
echo "ok    the checker refuses a journal with forbidden owner steps in it"

echo
echo "--- the demonstration: a journal that stops halfway"
head -n 12 "$JOURNAL" > "$PARTIAL_JOURNAL"
node --experimental-strip-types --no-warnings v1/tools/p6-clean-room-check.ts "$PARTIAL_JOURNAL" >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 1 ]; then
  echo "FAIL  the checker did not refuse a journal with most of the journey missing (exit $rc)" >&2
  exit 1
fi
echo "ok    the checker refuses a journal that does not carry the whole journey"

echo
echo "journal: $JOURNAL"
echo "PASS  the clean-room owner journey ran through the product alone, and the checker that says so refuses both a manual owner and a partial journey."
exit 0
