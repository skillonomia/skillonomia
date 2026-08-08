set -eu
# Step 2 must have run: its verify output is the evidence this bundle carries a
# whole history, and cloning an increment produces a confusing git error instead
# of a named refusal.
cat "$2/bundle-verify.txt" > /dev/null
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
