#!/usr/bin/env bash
# A VALIDATOR NOBODY HAS SEEN FAIL IS NOT A VALIDATOR.
#
#   v1/tools/p0-negative-probes.sh <evidence/PHASE-dir> <workdir>
#
# P0 REVIEW-2 finding `P0-R2-001` was not that `v1/tools/p0-evidence-check.ts` was
# missing. It was there, it was cited, and it exited 0 on a ledger whose every
# session id was invented and on a FIX record declaring the one provider/model/effort
# combination contract section 7 forbids. The check existed; the refusal did not. So
# each rule those checkers gained is exercised here against a deliberately damaged
# copy, and this harness fails unless every damaged copy is REFUSED — and refused for
# the stated reason, not incidentally, which is why each probe also asserts what the
# refusal said.
#
# Nothing is mutated in place. Every probe works on a copy under <workdir>; the real
# evidence directory and the real table are read only. Two positive controls run
# first and last: if the unmodified inputs do not pass, a later refusal proves
# nothing, because everything would be refused.
#
# <workdir> is required rather than defaulted to a temp directory. These transcripts
# are the evidence that the refusals happened, and evidence written somewhere the
# system may delete is a claim again.
set -uo pipefail

EV="${1:-}"
WORK="${2:-}"
if [ -z "$EV" ] || [ ! -d "$EV" ]; then
  echo "REFUSED: pass the phase evidence directory as the first argument. A probe run with no subject proves nothing." >&2
  exit 2
fi
if [ -z "$WORK" ]; then
  echo "REFUSED: pass a working directory as the second argument. Probe transcripts are evidence and need a durable home." >&2
  exit 2
fi

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
EV="$(cd "$EV" && pwd)"
mkdir -p "$WORK" || exit 2
WORK="$(cd "$WORK" && pwd)"
PHASE_DIR_NAME="$(basename "$EV")"
TABLE="$REPO/v1/P0-EVIDENCE-FORMAT.md"

EVCHECK=(node --experimental-strip-types --no-warnings "$REPO/v1/tools/p0-evidence-check.ts")
GTCHECK=(node --experimental-strip-types --no-warnings "$REPO/v1/tools/p0-gate-table-check.ts")

passed=0
failed=0
n=0

# patch <ledger> <0-based line> <json>   — merge json into that record; a null deletes.
patch() {
  node -e '
    const fs = require("fs");
    const [file, idx, raw] = process.argv.slice(1);
    const patch = JSON.parse(raw);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const i = Number(idx);
    const r = JSON.parse(lines[i]);
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete r[k]; else r[k] = v; }
    lines[i] = JSON.stringify(r);
    fs.writeFileSync(file, lines.join("\n"));
  ' "$1" "$2" "$3"
}

# fresh_copy <slug>  — an untouched copy of the evidence directory; echoes its path.
fresh_copy() {
  local dest="$WORK/$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -r "$EV" "$dest/"
  echo "$dest/$PHASE_DIR_NAME"
}

# probe <name> <expected exit> <expected text in output> -- <command...>
probe() {
  local name="$1" want_exit="$2" want_text="$3"
  shift 4 # name, exit, text, and the literal --
  n=$((n + 1))
  local id
  id="$(printf '%02d' "$n")"
  local out="$WORK/probe-$id-$name.txt"
  {
    echo "probe:    $id-$name"
    echo "expect:   exit $want_exit, output matching: $want_text"
    echo "command:  $*"
    echo "---"
  } >"$out"
  "$@" >>"$out" 2>&1
  local got=$?
  echo "--- actual exit: $got" >>"$out"

  local verdict="OK"
  if [ "$got" != "$want_exit" ]; then
    verdict="WRONG EXIT (wanted $want_exit, got $got)"
  elif ! grep -qF -- "$want_text" "$out"; then
    verdict="WRONG REASON (exit $got, but nothing matching: $want_text)"
  fi
  echo "verdict:  $verdict" >>"$out"

  if [ "$verdict" = "OK" ]; then
    passed=$((passed + 1))
    printf '  %s  %-34s exit %s  %s\n' "$id" "$name" "$got" "as expected"
  else
    failed=$((failed + 1))
    printf '  %s  %-34s exit %s  %s\n' "$id" "$name" "$got" "$verdict"
  fi
}

echo "evidence: $EV"
echo "table:    $TABLE"
echo "workdir:  $WORK"
echo
echo "positive controls and negative probes:"

# --- 01 positive control ------------------------------------------------------
# If the real ledger does not pass, every refusal below is meaningless.
probe positive-control-evidence 0 "PASS  every run record is complete" -- "${EVCHECK[@]}" "$EV"

# --- 02 the finding itself: a constructed session label ----------------------
D="$(fresh_copy synthetic-session)"
patch "$D/runs.jsonl" 0 '{"session_id":"fix1-P0-0c453cad"}'
probe synthetic-session-id 1 "session identity:" -- "${EVCHECK[@]}" "$D"

# --- 03 the forbidden model contract on a FIX row ----------------------------
D="$(fresh_copy fix-as-codex)"
patch "$D/runs.jsonl" 0 '{"provider":"codex","model":"gpt-5.6-sol","reasoning_effort":"low"}'
probe fix-declaring-codex-low 1 "role contract:" -- "${EVCHECK[@]}" "$D"

# --- 04 a model alias the contract forbids by name ---------------------------
D="$(fresh_copy model-alias)"
patch "$D/runs.jsonl" 0 '{"model":"opus-5"}'
probe model-alias-opus-5 1 "forbids by name" -- "${EVCHECK[@]}" "$D"

D="$(fresh_copy model-alias-long)"
patch "$D/runs.jsonl" 0 '{"model":"claude-opus-5-high"}'
probe model-alias-claude-opus-5-high 1 "forbids by name" -- "${EVCHECK[@]}" "$D"

# --- 05 the mapping in the other direction -----------------------------------
# A REVIEW row is not free to claim the builder's model either.
D="$(fresh_copy review-as-claude)"
patch "$D/runs.jsonl" 0 '{"role":"REVIEW-2","provider":"claude","model":"opus"}'
probe review-declaring-claude-opus 1 "role contract:" -- "${EVCHECK[@]}" "$D"

# --- 06 a session id shaped right but built from the record ------------------
D="$(fresh_copy self-minted-uuid)"
patch "$D/runs.jsonl" 0 '{"session_id":"00000000-0000-0000-0000-000000000000"}'
probe nil-uuid-session 1 "session identity:" -- "${EVCHECK[@]}" "$D"

# --- 07 two roles, one session ------------------------------------------------
# Contract section 7.3 forbids continuing one role's work in another's session.
#
# THE ROLE THIS PATCHES IN IS COMPUTED, NOT FIXED, and that is the whole of the
# repair P1 made here. The probe used to write `BUILD-1` into record 0
# unconditionally, which produced a second role only because P0's first record
# happened to be a FIX. On a phase ledger written entirely by one role — which is
# what a BUILD-only phase produces — it wrote the role that was already there,
# changed nothing, and the checker correctly found nothing to refuse. A probe
# that passes by asserting an unchanged file is a probe that measures nothing, so
# the value is now the OTHER builder role of contract section 7.1: `BUILD-1` and
# `FIX-1` share a provider, a model and a reasoning effort, so the only rule the
# patch can trip is the one this probe is about.
D="$(fresh_copy shared-session)"
OTHER_ROLE="$(node -e '
  const fs = require("fs");
  const first = JSON.parse(fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)[0]);
  process.stdout.write(first.role === "BUILD-1" ? "FIX-1" : "BUILD-1");
' "$D/runs.jsonl")"
patch "$D/runs.jsonl" 0 "{\"role\":\"$OTHER_ROLE\"}"
probe two-roles-one-session 1 "is shared by roles" -- "${EVCHECK[@]}" "$D"

# --- 08 the split SHA fields --------------------------------------------------
D="$(fresh_copy no-phase-base)"
patch "$D/runs.jsonl" 0 '{"phase_base_sha":null}'
probe missing-phase-base-sha 1 'required field "phase_base_sha"' -- "${EVCHECK[@]}" "$D"

D="$(fresh_copy no-input-sha)"
patch "$D/runs.jsonl" 0 '{"input_sha":null}'
probe missing-input-sha 1 'required field "input_sha"' -- "${EVCHECK[@]}" "$D"

D="$(fresh_copy legacy-field)"
patch "$D/runs.jsonl" 0 '{"input_base_sha":"eeefbe66098d6f93807383480790f9800335b516"}'
probe unmigrated-input-base-sha 1 "has not been migrated" -- "${EVCHECK[@]}" "$D"

# --- 09 the sideways move -----------------------------------------------------
# An archived ledger is still bound by the identity rules, and must say why it exists.
D="$(fresh_copy archived-bad-session)"
ARCHIVED="$(ls "$D" | grep -E '^runs-.*\.jsonl$' | head -1)"
if [ -n "$ARCHIVED" ]; then
  patch "$D/$ARCHIVED" 0 '{"session_id":"build1-P0-46e4a796"}'
  probe archived-ledger-bad-session 1 "session identity:" -- "${EVCHECK[@]}" "$D"

  D="$(fresh_copy archived-undisclosed)"
  rm -f "$D/$ARCHIVED.README.md"
  probe archived-ledger-undisclosed 1 "archived ledger with no" -- "${EVCHECK[@]}" "$D"
else
  echo "  --  archived-ledger probes                 SKIPPED (no runs-*.jsonl in $EV)"
fi

# --- 10 the gate table: present, not merely well-formed -----------------------
probe positive-control-gate-table 0 "PASS  every mandatory gate is present" -- "${GTCHECK[@]}" "$TABLE"

T="$WORK/table-no-security-regression.md"
grep -v '^| security regression on the threat-model surface |' "$TABLE" >"$T"
probe gate-table-row-deleted 1 "required gate" -- "${GTCHECK[@]}" "$T"

T="$WORK/table-no-browser-e2e.md"
grep -v '^| browser E2E |' "$TABLE" >"$T"
probe gate-table-browser-e2e-deleted 1 "required gate" -- "${GTCHECK[@]}" "$T"

T="$WORK/table-dogfood-downgraded.md"
sed 's/^\(| dogfood ledger metrics .*\)| ✓ |$/\1| — |/' "$TABLE" >"$T"
probe gate-table-mandatory-downgraded 1 "required gate" -- "${GTCHECK[@]}" "$T"

T="$WORK/table-runtime-renamed.md"
sed 's/^| actual Codex runtime session |/| codex thing |/' "$TABLE" >"$T"
probe gate-table-row-renamed 1 "required gate" -- "${GTCHECK[@]}" "$T"

# --- 10b the output-SHA agreement of the phase package -----------------------
#
# P2 REVIEW-1 finding `P2-R1-005`: the closure artifacts named an EARLIER commit
# than the one under review, for the third time in this contract. Every artifact
# was individually well-formed, so every individual checker passed. The check
# that closes the class compares them against each other, and the probes below
# are it being made to fail — once on a stale marker, which is the finding's own
# shape, and once on a missing one, which is the way a stale artifact would
# otherwise be made to pass.
#
# GUARDED, because the check requires an `OUTPUT_SHA:` marker in every artifact
# and P0's and P1's packages were closed before the marker existed. On those
# directories there is nothing here to measure and saying so is the honest
# answer; see the justification under the gate table.
OSCHECK=(node --experimental-strip-types --no-warnings "$REPO/v1/tools/p0-output-sha-check.ts")
if grep -rlq '^[[:space:]]*\(#\|-\|\*\|>\)\?[[:space:]]*OUTPUT_SHA:' "$EV"/*.md "$EV"/*.txt 2>/dev/null; then
  probe positive-control-output-sha 0 "PASS  every closure artifact" -- "${OSCHECK[@]}" "$EV"

  # The finding itself: ONE artifact left describing the previous commit.
  D="$(fresh_copy stale-output-sha)"
  STALE_FILE="$(grep -rl 'OUTPUT_SHA:' "$D"/*.md "$D"/*.txt 2>/dev/null | head -1)"
  sed -i 's/^\([[:space:]]*\(#\|-\|\*\|>\)\?[[:space:]]*OUTPUT_SHA:[[:space:]]*\)[0-9a-f]\{40\}$/\18450df72d7f989f4ecefcce473765f182dd229f7/' "$STALE_FILE"
  probe stale-output-sha-artifact 1 "disagrees with the ledger's closing output_sha" -- "${OSCHECK[@]}" "$D"

  # And the way out of the first probe: delete the marker instead of fixing it.
  D="$(fresh_copy no-output-sha-marker)"
  DROP_FILE="$(grep -rl 'OUTPUT_SHA:' "$D"/*.md "$D"/*.txt 2>/dev/null | head -1)"
  sed -i '/OUTPUT_SHA:/d' "$DROP_FILE"
  probe missing-output-sha-marker 1 "no OUTPUT_SHA marker" -- "${OSCHECK[@]}" "$D"

  # The optional half: agreement with the tree, not only with itself.
  D="$(fresh_copy output-sha-vs-repo)"
  probe output-sha-matches-repo-head 0 "and so does the repository" -- "${OSCHECK[@]}" "$D" --repo "$REPO"
else
  echo "  --  output-SHA agreement probes            SKIPPED (no OUTPUT_SHA marker in $EV)"
fi

# --- 11 positive control, again ----------------------------------------------
# The last word belongs to the unmodified inputs: nothing above left them changed.
probe positive-control-evidence-again 0 "PASS  every run record is complete" -- "${EVCHECK[@]}" "$EV"
probe positive-control-gate-table-again 0 "PASS  every mandatory gate is present" -- "${GTCHECK[@]}" "$TABLE"

echo
echo "probes: $((passed + failed))   behaved as expected: $passed   did not: $failed"
echo "transcripts: $WORK/probe-*.txt"
if [ "$failed" -ne 0 ]; then
  echo
  echo "FAIL  $failed probe(s) did not behave as expected. A checker that does not refuse what it claims to refuse is not evidence."
  exit 1
fi
echo
echo "PASS  every checker refused what it claims to refuse, for the stated reason, and passed the unmodified inputs"
