set -eu
# Step 3 must have run. This step reads $1/clone/.git, which only step 3
# creates; run on its own it used to fail with a raw git error about a git
# directory the operator never named. `cat` on step 3's own finding names the
# missing artifact instead — and it is the finding, not the directory, because a
# clone interrupted half way leaves the directory behind without the identity.
cat "$1/head-commit.txt" > /dev/null
git --git-dir="$1/clone/.git" --work-tree="$2" diff --name-only HEAD > "$1/divergences.txt"
printf 'divergences '
# `awk`, not `wc -l`, for the reason given in 03-clone.sh: g4 is an exact line
# and `wc` pads. An empty divergences.txt — the success case — is 0 either way.
# The count is printed BEFORE the refusal below, so the number stays on stdout
# whichever way the run goes: it is the finding, and the refusal must not eat it.
awk 'END { print NR }' "$1/divergences.txt"
# THE REFUSAL, and it is an exit status. This step used to refuse by VALUE only:
# it printed `divergences 1` over a bundle of an entirely different repository
# and exited 0, so a caller that checks exit statuses — which is every caller
# that composes steps, this package's own `walk` included — accepted it. The
# trap was written down in SKILL.md, and a documented trap is still a trap.
#
# The same idiom as step 2's classifier, and for the same reason: gate 5 FAILs a
# conditional as `control-construct`, so a refusal cannot be `if`. It has to be a
# command that fails, and comparing against a file known to be empty is one.
# `cmp`'s complaint for this case ("EOF on … which is empty") goes to stderr, so
# stdout still ends at the count.
printf '' > "$1/divergences-expected.txt"
cmp "$1/divergences-expected.txt" "$1/divergences.txt"
