#!/usr/bin/env bash
# APPEND-ONLY: the integration branch may only ever gain commits.
#
#   v1/tools/p0-append-only-check.sh [branch] [phase-base-sha]
#
# Contract section 2 forbids force-push, history rewriting, history deletion and
# destructive reset. `git commit --amend` is a history rewrite: it REPLACES the
# commit an earlier session published, which is exactly the object a reviewer was
# handed. P0 REVIEW-1 found one on this branch (finding P0-R1-001), and the
# response is a mechanism rather than a promise — this check.
#
# WHAT IS CHECKED, AND WITH WHICH EVIDENCE. The reflog is the only local record of
# where a branch has been, so it is the subject. Two independent detectors run over
# it, because either alone has a blind spot:
#
#   TEXTUAL   the reflog message names the operation — `commit (amend)`, `rebase`,
#             `reset`. This catches a rewrite that happens to be a fast-forward.
#   STRUCTURAL  the old SHA must be an ancestor of the new SHA. This catches a
#             rewrite whose message says nothing useful, including one written by a
#             tool this list has never heard of.
#
# A disclosed entry in v1/append-only-baseline.tsv is excused, and nothing else is.
# The disclosure is checked in BOTH directions: an undisclosed rewrite fails, and a
# disclosed line that does not correspond to a real reflog entry also fails, so the
# file cannot quietly accumulate blanket permissions.
#
# WHY THIS REFUSES INSTEAD OF PASSING WHEN THE REFLOG IS MISSING. A fresh clone has
# no reflog: it would report "no rewrite found" having read nothing, which is the
# failure mode this whole harness set exists to avoid. So a missing reflog is exit 2,
# REFUSED, and the committed snapshot in v1/P0-BRANCH-HISTORY.md is what a reviewer
# without this working copy compares against.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

BRANCH="${1:-v1-final-integration}"
BASE="${2:-eeefbe66098d6f93807383480790f9800335b516}"
BASELINE="v1/append-only-baseline.tsv"

REFLOG_FILE=$(git rev-parse --git-path "logs/refs/heads/$BRANCH" 2>/dev/null)
if [ -z "$REFLOG_FILE" ] || [ ! -s "$REFLOG_FILE" ]; then
  echo "REFUSED: no reflog for refs/heads/$BRANCH at ${REFLOG_FILE:-<unresolved>}." >&2
  echo "         A history check with no history to read reports clean having read nothing." >&2
  exit 2
fi
if [ ! -f "$BASELINE" ]; then
  echo "REFUSED: $BASELINE is missing. The excuse list must be present and tracked, even when empty." >&2
  exit 2
fi

echo "branch:     $BRANCH"
echo "phase base: $BASE"
echo "reflog:     $REFLOG_FILE"
echo "baseline:   $BASELINE"
echo

# --- the phase base must still be an ancestor of the tip -------------------------
if ! git merge-base --is-ancestor "$BASE" "refs/heads/$BRANCH" 2>/dev/null; then
  echo "FAIL  the phase base $BASE is not an ancestor of $BRANCH — the branch was re-pointed." >&2
  exit 1
fi
echo "ok    phase base is an ancestor of the branch tip"

# Only the disclosures written for THIS branch are in play. A line naming another
# branch neither excuses an entry here nor counts as a phantom here.
DISCLOSED=$(grep -v '^#' "$BASELINE" | grep -v '^[[:space:]]*$' | awk -F'\t' -v b="$BRANCH" '$1 == b' || true)

rewrites=0
excused=0
undisclosed=0
seen_keys=""

# reflog line format: <old> <new> <who> <ts> <tz>\t<message>
while IFS= read -r line; do
  [ -z "$line" ] && continue
  old=${line%% *}
  rest=${line#* }
  new=${rest%% *}
  msg=${line#*$'\t'}

  # branch creation: no previous position, nothing to rewrite
  case "$old" in 0000000000000000000000000000000000000000) continue ;; esac

  op=""
  case "$msg" in
    *"commit (amend)"*) op="commit (amend)" ;;
    *rebase*)           op="rebase" ;;
    *reset*)            op="reset" ;;
    *filter-branch*)    op="filter-branch" ;;
  esac

  ff="yes"
  git merge-base --is-ancestor "$old" "$new" 2>/dev/null || ff="no"
  if [ -z "$op" ] && [ "$ff" = "no" ]; then op="non-fast-forward move"; fi

  [ -z "$op" ] && continue

  rewrites=$((rewrites + 1))
  key="$BRANCH	$old	$new	$op"
  seen_keys="${seen_keys}${key}"$'\n'

  if printf '%s\n' "$DISCLOSED" | cut -f1-4 | grep -qxF "$key"; then
    if ! git cat-file -e "${old}^{commit}" 2>/dev/null; then
      echo "FAIL  disclosed rewrite $op: the pre-rewrite commit $old is NOT reachable — an object was destroyed." >&2
      undisclosed=$((undisclosed + 1))
      continue
    fi
    excused=$((excused + 1))
    echo "ok    DISCLOSED $op  $old -> $new  (pre-rewrite commit still reachable)"
  else
    echo "FAIL  UNDISCLOSED $op  $old -> $new" >&2
    echo "      A fix lands as a NEW COMMIT. See v1/P0-EVIDENCE-FORMAT.md section 5." >&2
    undisclosed=$((undisclosed + 1))
  fi
done < "$REFLOG_FILE"

# --- the disclosure file may not carry a line that matches nothing ----------------
phantom=0
while IFS= read -r d; do
  [ -z "$d" ] && continue
  key=$(printf '%s' "$d" | cut -f1-4)
  if ! printf '%s' "$seen_keys" | grep -qxF "$key"; then
    echo "FAIL  $BASELINE discloses an entry that is not in the reflog: $key" >&2
    echo "      A standing excuse for a rewrite that never happened is a blanket permission." >&2
    phantom=$((phantom + 1))
  fi
done <<< "$DISCLOSED"

echo
echo "rewrite-shaped reflog entries: $rewrites   disclosed: $excused   undisclosed: $undisclosed   phantom disclosures: $phantom"
if [ "$undisclosed" -eq 0 ] && [ "$phantom" -eq 0 ]; then
  echo "PASS  every move of $BRANCH after the phase base is append-only or disclosed, and nothing was destroyed"
  exit 0
fi
echo "FAIL  the branch history is not append-only" >&2
exit 1
