#!/usr/bin/env bash
# Contract §2 and §9: no secret, API key, token or credential may appear in an
# evidence artifact. This sweeps a directory and refuses on a hit.
#
#   v1/tools/p0-secret-scan.sh <evidence-dir>
#
# THE PATTERNS ARE THE ONES THIS SYSTEM ACTUALLY MINTS, plus the generic shapes
# that show up when somebody pastes a credential by accident. A scanner tuned to
# an imaginary threat finds nothing and reports clean, which is the failure mode
# worth avoiding here:
#
#   sk_… / sk_own_…  the registry's own API keys (src/auth.ts mints `sk_<b64url>`)
#   bt_…             the one-time bootstrap token
#   the standard prefixes of credentials people paste from elsewhere
#   PEM private key blocks
#   `Authorization: Bearer <something long>` in a captured transcript
#
# A REDACTION MARKER IS NOT A HIT. Harnesses replace credentials with
# `<REDACTED-CREDENTIAL>` before writing, and the marker must survive a scan or
# redaction would be indistinguishable from leakage.
set -uo pipefail

DIR="${1:-}"
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "REFUSED: pass a directory to scan. A scan with no subject reports clean having read nothing." >&2
  exit 2
fi

PATTERNS=(
  'sk_[A-Za-z0-9_-]{16,}'
  'bt_[A-Za-z0-9_-]{16,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'AKIA[0-9A-Z]{16}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9._-]{20,}'
)

# THE ONE NARROWING, AND WHY IT IS NOT A MUTE BUTTON.
#
# This repository's own test suite carries DELIBERATELY TOKEN-SHAPED FIXTURES —
# `test/p14-r9b-probes.test.ts` builds one from fragments at run time so that a
# push-side scanner does not see a complete vendor key literal in the file, and
# then pins it with `pinnedFixture(value, sha256, what)`, which REFUSES if the
# assembled bytes are not the ones the probe was written against. Running the
# suite prints such a fixture into the transcript, and a transcript is evidence.
#
# So a scan of evidence hits it, correctly on SHAPE and wrongly on SUBSTANCE.
# The claim is narrowed rather than the check weakened: a match is excused ONLY
# when its sha256 equals a digest THIS REPOSITORY HAS COMMITTED in a
# `pinnedFixture` call. The digests are read out of the test sources at scan
# time, never copied into this file — an allow-list kept here would be a second
# place to edit, and the edit that matters would be the one that adds a real
# secret to it. Everything else still fails, and a fixture whose bytes drift
# from its pin fails the suite before it ever reaches this scanner.
#
# THE EXTRACTION IS THE CALL SITE, NOT THE FILE. An earlier version of this line
# read EVERY quoted 64-hex literal anywhere under test/ — 8 values, of which only
# 4 are pinned fixture digests. The other 4 are content digests, tree hashes and
# vector checksums that have nothing to do with excusing a credential shape, and
# a scanner whose excuse list is wider than its stated claim is a scanner whose
# documentation is wrong. So the call bodies are cut out first — from
# `pinnedFixture(` to the `);` that closes it — and only the digests INSIDE those
# bodies are eligible. If a call is ever written so that the cut truncates it,
# the digest is simply not extracted and the match is NOT excused: the failure
# direction is a false alarm, never a silent pass.
PINNED=$(perl -0777 -ne 'while (/pinnedFixture\s*\((.*?)\)\s*;/gs) { my $b = $1; while ($b =~ /"([0-9a-f]{64})"/g) { print "$1\n" } }' \
  "$(dirname "$0")/../../test"/*.ts 2>/dev/null | sort -u)
echo "scanning: $DIR"
echo "files:    $(find "$DIR" -type f | wc -l)"
echo "pinned test-fixture digests read from test/: $(printf '%s\n' "$PINNED" | grep -c . || echo 0)"

excused=0
hits=0
for p in "${PATTERNS[@]}"; do
  # -I skips binaries; the redaction marker is excluded so a redacted transcript
  # does not read as a leak.
  found=$(grep -rIEno "$p" "$DIR" 2>/dev/null | grep -v 'REDACTED-CREDENTIAL' || true)
  real=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # `file:line:match` — the match is everything after the second colon
    value=${line#*:}
    value=${value#*:}
    d=$(printf '%s' "$value" | sha256sum | cut -d' ' -f1)
    if printf '%s\n' "$PINNED" | grep -qx "$d"; then
      excused=$((excused + 1))
      continue
    fi
    real="${real}${line}"$'\n'
  done <<< "$found"

  if [ -n "${real//[$'\n']/}" ]; then
    echo "HIT  pattern: $p"
    # The match itself is NOT printed. A scanner that echoes what it found would
    # copy the secret into its own report.
    printf '%s' "$real" | sed -E 's/:([0-9]+):.*/:\1: <match suppressed>/'
    hits=$((hits + 1))
  else
    echo "clean  pattern: $p"
  fi
done
[ "$excused" -gt 0 ] && echo "excused: $excused match(es) whose sha256 is a pinned test fixture of this repository"

echo
if [ "$hits" -eq 0 ]; then
  echo "PASS  no credential-shaped value found in any artifact under $DIR"
  exit 0
fi
echo "FAIL  $hits pattern(s) matched - an artifact carries a credential"
exit 1
