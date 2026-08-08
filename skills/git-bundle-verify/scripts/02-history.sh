set -eu
# FIRST, before anything can succeed or fail: this step's own PASS token from a
# PREVIOUS run is destroyed. A token is a claim about the run that wrote it, and
# it was outliving that run — g1 and g2 on the announced bundle, then g2 again in
# the same work directory on an incremental one: the second g2 exited non-zero
# and history-ok.txt was still there, left by the first. Step 3 read it, was
# satisfied, and cloned; git refused on its own terms at exit 128. The presence
# of the file no longer means "the LAST step 2 passed" once a second step 2 has
# run, so the file is removed at the top and re-created only at the bottom, past
# every signal. A refusal anywhere in between — the missing token of step 1, a
# switched bundle, a non-zero verify, a non-empty prerequisite list — therefore
# leaves NO usable token, this run's or the last one's, whichever bundle step 3
# is then handed.
#
# One named path inside the work directory, and nothing else: the runbook still
# deletes nothing it did not write.
rm -f "$2/history-ok.txt"
# Step 1 must have PASSED: this token is written only where the digest matched,
# and it is what makes this bundle the one the digest names. Naming the missing
# artifact beats a bare git error.
#
# It reads checksum-ok.txt rather than actual.sha256 because actual.sha256 is now
# written before step 1's check and therefore survives a refusal — it is evidence
# of what was measured, not evidence that the measurement agreed.
cat "$2/checksum-ok.txt" > /dev/null
# …and the bundle in front of THIS step must be the one step 1 accepted. The
# token above proves a digest matched; it cannot prove which file it matched,
# and BUNDLE_PATH is an argument that may differ from the one step 1 was given.
# Offered a foreign bundle after a passing g1, this step used to init a probe,
# read the header and run `git bundle verify` on the substituted file — all of
# it truthful about the wrong artifact.
#
# So: measure what is actually here, keep the digest field alone (`sha256sum`
# prints the name too, and the name is exactly what an operator re-points), and
# compare against the binding step 1 measured. `cmp` reports a difference on
# STDOUT, which would break this step's contract of printing nothing when it
# refuses, so its output is sent to stderr — where it names both files, and
# where a missing binding reads `No such file or directory` under the same
# redirect. This runs BEFORE `git init`, before the header is read and before
# `git bundle verify`, so a switched bundle leaves no probe/, no
# prerequisites.txt and no bundle-verify.txt to be mistaken for a step that got
# somewhere.
sha256sum "$1" > "$2/step2-input.sha256"
awk '{ print $1 }' "$2/step2-input.sha256" > "$2/step2-input-id.sha256"
cmp "$2/bundle-id.sha256" "$2/step2-input-id.sha256" >&2
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
# The success token, and step 3's guard reads THIS. bundle-verify.txt used to be
# that guard — step 3 refuses to run unless step 2 left its artifact behind —
# and it never could be one: the redirect on the verify line CREATES the file
# before the exit status of `git bundle verify` is known, so a REFUSED step 2
# leaves it behind too. On incremental.bundle offered with its own digest that
# was visible end to end: step 2 exited non-zero, bundle-verify.txt was there,
# and step 3 read it, was satisfied, and went on to run `git clone` — which then
# died on git's own terms with "Repository lacks these prerequisite commits"
# instead of the runbook naming the artifact its predecessor never wrote.
#
# bundle-verify.txt stays where it is: it is the DIAGNOSIS, git's own words about
# what is missing, and it has to survive a refusal for prerequisites.txt to be
# readable beside it. It is simply not the same fact as "step 2 passed". This
# file is written only past BOTH signals — a zero exit status from the verify
# above and a prerequisite list proven empty by the cmp above — so it is the one
# artifact whose existence means the step agreed. Same shape as step 1's
# checksum-ok.txt, and for the same reason: an artifact of MEASUREMENT is not
# evidence of a PASS. It carries the same bytes the step prints, and `cat` is
# what prints them, so the stdout contract of this step is unchanged.
printf 'bundle-history-complete\n' > "$2/history-ok.txt"
cat "$2/history-ok.txt"
