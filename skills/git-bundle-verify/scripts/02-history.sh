set -eu
# Step 1 must have PASSED: this token is written only where the digest matched,
# and it is what makes this bundle the one the digest names. Naming the missing
# artifact beats a bare git error.
#
# It reads checksum-ok.txt rather than actual.sha256 because actual.sha256 is now
# written before step 1's check and therefore survives a refusal — it is evidence
# of what was measured, not evidence that the measurement agreed.
cat "$2/checksum-ok.txt" > /dev/null
git init --quiet "$2/probe"
# The CLASSIFIER's input, written BEFORE the refusal condition so it exists
# whichever way the next line goes. In a v2/v3 bundle header every PREREQUISITE
# line begins with '-' followed by an object id, and the header ends at the
# first empty line — sed stops there, so packfile bytes cannot forge a
# prerequisite, and sed reports "nothing found" as an empty file rather than as
# an exit status.
sed --quiet --expression='/^$/q' --expression='/^-[0-9a-f]/p' "$1" > "$2/prerequisites.txt"
# SIGNAL 1, the refusal condition: the exit status of `git bundle verify`. It is
# non-zero for an incremental bundle whose prerequisites this empty probe lacks,
# for a damaged header, and for a file that is not a bundle at all — so it
# refuses all three without depending on the wording of any message. The wording
# was the earlier check, and it is both localizable and version-dependent.
# `--git-dir`, not `-C`: `-C` changes directory first, so a RELATIVE
# BUNDLE_PATH resolved against the probe repository and the step failed with
# "could not open" — into bundle-verify.txt, leaving both stdout and stderr
# empty. Pointing at the git directory instead leaves the caller's working
# directory alone, so both path forms work.
git --git-dir="$2/probe/.git" bundle verify "$1" > "$2/bundle-verify.txt" 2>&1
# SIGNAL 2, the cause: the prerequisite list must be EMPTY. The exit status
# alone cannot tell "incomplete history" from "not a bundle", and those need
# different actions from the operator; prerequisites.txt is what separates them.
printf '' > "$2/prerequisites-expected.txt"
cmp "$2/prerequisites-expected.txt" "$2/prerequisites.txt"
echo bundle-history-complete
