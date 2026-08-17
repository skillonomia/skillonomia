#!/usr/bin/env bash
# P4 RUNTIME FEASIBILITY PROBE
#
#   v1/tools/p4-runtime-feasibility.sh <output-dir>
#
# WHAT THIS IS. It answers one question and no other: can an ACTUAL Codex session
# and an ACTUAL Claude Code session be driven from this container, non-interactively,
# so that each LOADS a natively materialised skill and RETURNS its content?
#
# WHAT THIS IS NOT. It is not `v1/tools/gates/runtime-codex.sh` and it is not
# `v1/tools/gates/runtime-claude-code.sh`, both of which still exit 3. Those gates
# must drive the loadout through the PRODUCT path and assert exact-revision
# correlation, stage order, the `unknown` fallback and secret absence
# (`P4-FR-09`..`P4-FR-11`, `P4-FR-15`, `P4-FR-17`..`P4-FR-19`). This probe asserts
# only reachability, because reachability is the precondition the contract calls a
# blocker for Leo if it fails, and it is worth knowing separately from the product.
# A green run here does NOT mean the P4 gates are green. Do not read it as one.
#
# ISOLATION. Both runtimes are pointed at a runtime home created under the output
# directory. Nothing is written into the live $HOME/.claude or into the live CODEX_HOME.
# Auth material is COPIED into the isolated home and never printed.
#
# EXIT CODES, as for every harness in this tree:
#   0  both runtimes loaded and returned the materialised skill's marker
#   1  a runtime was reachable but did not load the skill — a real defect
#   2  REFUSED — a binary or a credential is missing; never reported as a pass
set -uo pipefail

OUT="${1:?usage: p4-runtime-feasibility.sh <output-dir> [runtime-home-dir]}"
# The runtime homes hold COPIED AUTH MATERIAL and therefore must NOT live under the
# evidence directory. The first run of this harness put them there and the credentials
# had to be shredded out of the package; the second argument exists so that cannot
# recur. Only the two transcripts are written under <output-dir>.
RTDIR="${2:-$OUT/../p4-runtime-homes}"
mkdir -p "$OUT" "$RTDIR" || exit 2
MARKER="SKLN-P4-FEASIBILITY-MARKER-7F3A"

command -v codex  >/dev/null || { echo "REFUSED: codex not on PATH"  >&2; exit 2; }
command -v claude >/dev/null || { echo "REFUSED: claude not on PATH" >&2; exit 2; }

CODEX_SRC="${CODEX_HOME:-$HOME/.codex}/auth.json"
CC_SRC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
[ -f "$CODEX_SRC" ] || { echo "REFUSED: no Codex auth at $CODEX_SRC" >&2; exit 2; }
[ -f "$CC_SRC" ]    || { echo "REFUSED: no Claude Code credential at $CC_SRC" >&2; exit 2; }

skill() {  # $1 = skills root
  mkdir -p "$1/p4-feasibility-probe"
  { echo '---'
    echo 'name: p4-feasibility-probe'
    echo 'description: Use when asked for the SKILLONOMIA FEASIBILITY MARKER.'
    echo '---'
    echo "The SKILLONOMIA FEASIBILITY MARKER is ${MARKER}."
  } > "$1/p4-feasibility-probe/SKILL.md"
}

# ---- Codex -----------------------------------------------------------------
# The isolated home lives inside the workdir codex is given. Codex enumerates
# skills into its prompt but READS SKILL.md through its shell tool, so its shell
# has to work; this container cannot nest codex's bundled bubblewrap, which is why
# the sandbox is delegated to the container. That is an environment limitation,
# recorded in evidence/P4/00-runtime-feasibility.txt, not a design choice.
CXW="$RTDIR/codex-work"; CXH="$CXW/.codex"
mkdir -p "$CXH/skills"
cp "$CODEX_SRC" "$CXH/auth.json"; chmod 600 "$CXH/auth.json"
printf 'model = "gpt-5.6-sol"\napproval_policy = "never"\n' > "$CXH/config.toml"
skill "$CXH/skills"
CODEX_HOME="$CXH" timeout 600 codex exec --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox -C "$CXW" \
  "Use the p4-feasibility-probe skill and report the SKILLONOMIA FEASIBILITY MARKER." \
  < /dev/null > "$OUT/codex-transcript.txt" 2>&1
CX_RC=$?

# ---- Claude Code -----------------------------------------------------------
# User-level skills are read from <CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md.
# Without --permission-mode bypassPermissions the Skill tool call is denied
# non-interactively and the run emits no JSON at all.
CCH="$RTDIR/claude-home"
mkdir -p "$CCH/skills"
cp "$CC_SRC" "$CCH/.credentials.json"; chmod 600 "$CCH/.credentials.json"
skill "$CCH/skills"
CLAUDE_CONFIG_DIR="$CCH" timeout 600 claude -p \
  "Use the p4-feasibility-probe skill and report the SKILLONOMIA FEASIBILITY MARKER." \
  --output-format json --permission-mode bypassPermissions \
  < /dev/null > "$OUT/claude-transcript.json" 2>&1
CC_RC=$?

RC=0
grep -q "$MARKER" "$OUT/codex-transcript.txt" \
  && echo "CODEX  loaded the materialised skill and returned the marker (rc=$CX_RC)" \
  || { echo "CODEX  did NOT return the marker (rc=$CX_RC) — see $OUT/codex-transcript.txt" >&2; RC=1; }
grep -q "$MARKER" "$OUT/claude-transcript.json" \
  && echo "CLAUDE loaded the materialised skill and returned the marker (rc=$CC_RC)" \
  || { echo "CLAUDE did NOT return the marker (rc=$CC_RC) — see $OUT/claude-transcript.json" >&2; RC=1; }

# The isolation assertion is part of the probe, not a claim beside it.
for LIVE in "$HOME/.claude/skills" "${CODEX_HOME:-$HOME/.codex}/skills"; do
  if [ -e "$LIVE/p4-feasibility-probe" ]; then
    echo "FAILED: probe skill leaked into the live runtime home $LIVE" >&2; RC=1
  fi
done
echo "isolation held: no probe skill in either live runtime home"
exit $RC
