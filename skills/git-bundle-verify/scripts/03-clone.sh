set -eu
# Step 2 must have PASSED: this token is written only past both of its signals —
# a zero exit status from `git bundle verify` and a prerequisite list proven
# empty — and it is what makes this bundle one that carries a whole history.
#
# It reads history-ok.txt rather than bundle-verify.txt because bundle-verify.txt
# is created by the REDIRECT on step 2's verify line, before that command's exit
# status exists, and therefore survives a refusal — it is evidence of what git
# said, not evidence that git agreed. Guarding on it let an incremental bundle
# reach `git clone`, which then failed on git's own terms about prerequisite
# commits the operator never named.
cat "$2/history-ok.txt" > /dev/null
# …and the bundle in front of THIS step must be the one steps 1 and 2 accepted.
# The token above is destroyed at the top of every step 2 and re-written only
# past a binding check of its own, so a token that exists means the LAST step 2
# agreed AND agreed about the file bundle-id.sha256 names. That leaves exactly
# one substitution: handing step 3 a different path from the one its two
# predecessors were handed. It used to work — `g1 good`, `g2 good`, `g3 foreign`
# printed head-commit, head-tree, tracked-files and `clone-ok` over another
# repository's bundle, and the run was caught one step later by step 4's
# comparison with the reference tree. Step 4 catching it is defence in depth, not
# the chain holding: it refuses because two TREES differ, and it would have said
# nothing had the substituted bundle carried the same tree.
#
# Same three lines as step 2, deliberately: measure, keep the digest field alone,
# compare against the binding. And BEFORE `git clone`, so a switched bundle
# leaves no clone/ behind — a clone that ran and was then judged is not the same
# fact as a clone that never ran.
sha256sum "$1" > "$2/step3-input.sha256"
awk '{ print $1 }' "$2/step3-input.sha256" > "$2/step3-input-id.sha256"
cmp "$2/bundle-id.sha256" "$2/step3-input-id.sha256" >&2
git clone --quiet "$1" "$2/clone"
git -C "$2/clone" rev-parse HEAD > "$2/head-commit.txt"
git -C "$2/clone" rev-parse "HEAD^{tree}" > "$2/head-tree.txt"
git -C "$2/clone" ls-files > "$2/tracked-files.txt"
printf 'head-commit '
cat "$2/head-commit.txt"
printf 'head-tree '
cat "$2/head-tree.txt"
printf 'tracked-files '
# NOT `wc -l`. g3 is stated as an EXACT line, and `wc` pads its count to a
# column on a BSD userland — "tracked-files      2" fails the gate this package
# declares for itself, on a platform the manifest used to say it ran on. `awk`
# prints the number and nothing else on every implementation. It also counts the
# last line when the file does not end in a newline, which `wc -l` does not.
awk 'END { print NR }' "$2/tracked-files.txt"
echo clone-ok
