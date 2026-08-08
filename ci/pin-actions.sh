#!/usr/bin/env bash
# Pin every GitHub Action this repository uses to a COMMIT SHA.
#
#   ci/pin-actions.sh            # rewrite .github/workflows/*.yml in place
#   ci/pin-actions.sh --check    # exit 1 if anything is still on a tag
#
# Why. `uses: actions/checkout@v4` is a mutable pointer: `v4` is a tag, tags
# move, and a moved tag is arbitrary third-party code running with this
# repository's checkout, its secrets and its release artifacts. A commit SHA is
# a content address — it cannot be repointed. The tag survives as a trailing
# comment, because a bare SHA tells a reader nothing about which release it is.
#
# THIS SCRIPT NEEDS THE NETWORK. It is deliberately not run by CI: pinning is an
# edit a human reviews, not something a job does to itself. `gh` must be
# installed and authenticated (`gh auth status`).
#
# Annotated tags are dereferenced. `refs/tags/v4` on an annotated tag points at
# a TAG object, not a commit, and `uses:` needs the commit — so the object type
# is checked and followed rather than assumed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOWS="$REPO_ROOT/.github/workflows"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# `owner/repo@ref` → the commit SHA `ref` names.
resolve() {
  local repo="$1" ref="$2" sha type
  read -r sha type < <(gh api "repos/$repo/git/ref/tags/$ref" \
    --jq '.object.sha + " " + .object.type' 2>/dev/null | tr '\n' ' ') || {
    echo "pin-actions: cannot resolve $repo@$ref — is it a tag? is gh authenticated?" >&2
    return 1
  }
  if [ "$type" = "tag" ]; then
    sha=$(gh api "repos/$repo/git/tags/$sha" --jq '.object.sha')
  fi
  printf '%s' "$sha"
}

status=0
for file in "$WORKFLOWS"/*.yml "$WORKFLOWS"/*.yaml; do
  [ -e "$file" ] || continue
  # every `uses: owner/repo@ref`, ref not already a 40-hex commit
  while IFS= read -r ref_line; do
    repo="${ref_line%@*}"
    ref="${ref_line#*@}"
    if [ "$CHECK_ONLY" = 1 ]; then
      echo "UNPINNED: $repo@$ref  (in $(basename "$file"))" >&2
      status=1
      continue
    fi
    sha="$(resolve "$repo" "$ref")"
    echo "$repo@$ref -> $sha"
    # rewrite `uses: repo@ref` (with whatever trailing comment) to the SHA form
    perl -pi -e "s{uses:\\s*\\Q$repo\\E\\@\\Q$ref\\E(\\s*#.*)?\$}{uses: $repo\\@$sha # $ref}" "$file"
  done < <(grep -Eo 'uses:[[:space:]]*[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+' "$file" |
    sed -E 's/uses:[[:space:]]*//' |
    grep -Ev '@[0-9a-f]{40}$' |
    sort -u)
done

if [ "$CHECK_ONLY" = 1 ]; then
  [ "$status" = 0 ] && echo "all actions are pinned to commit SHAs"
  exit "$status"
fi
echo
echo "Now review the diff and update the '# UNPINNED' markers in the workflow."
