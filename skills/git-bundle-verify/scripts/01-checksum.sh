set -eu
# WORK_DIR must be absent or EMPTY. `mkdir -p` alone let a second run write into
# a populated directory, where a step that fails early leaves the PREVIOUS run's
# head-commit.txt and divergences.txt in place — and a reader then takes last
# time's success for this time's. rmdir refuses a directory with anything in it,
# so this refuses too; on an absent or empty one it succeeds, and the mkdir that
# follows hands back a directory this run provably owns.
mkdir -p "$3"
rmdir "$3"
mkdir "$3"
# The minimum git this runbook is declared against, checked before anything
# depends on it. `sort --check` reads the pair [required, actual] and fails
# unless it is already in version order, so an older git is refused HERE rather
# than surfacing two steps later as an unknown subcommand or option.
git version > "$3/git-version.txt"
printf 'git version 2.30.0\n' > "$3/git-required.txt"
cat "$3/git-required.txt" "$3/git-version.txt" > "$3/git-version-check.txt"
sort --check --version-sort "$3/git-version-check.txt"
# The MEASURED digest is written BEFORE the check, not after it. Written after,
# it was absent on the one run that needed it: `--check` fails, `set -e` ends the
# script, and the work directory kept the digest you ASSERTED with nothing beside
# it to compare — while this package's own artifact table promised both. The
# operator was then told to "compare expected.sha256 with the file yourself",
# which is a manual step standing in for evidence the run could have left behind.
# Measuring first costs one extra read of the bundle and makes the refusal
# self-evidencing: two files, side by side, the asserted and the actual reading
# of the same path. Nothing is printed either way — see the check below.
sha256sum "$1" > "$3/actual.sha256"
printf '%s  %s\n' "$2" "$1" > "$3/expected.sha256"
# THE REFUSAL, unchanged and deliberately mute: `--status` prints nothing on
# either outcome, so a wrong digest ends the run with empty stdout AND empty
# stderr. That silence is the contract — the diagnosis is the pair of files
# above, not a message. This step decides ONE thing: whether the bytes in front
# of you are the bytes the digest names. It cannot say WHY they differ, and does
# not try to.
sha256sum --check --strict --status "$3/expected.sha256"
# The BINDING, written only past the check above, and the thing that makes the
# rest of the chain about THIS bundle rather than about "some bundle that once
# passed". A success token says a step agreed; it does not say what it agreed
# ABOUT. With tokens alone one work directory accepted g1 and g2 on the bundle
# you were told about and then g3 on a DIFFERENT file, printed `clone-ok`, and
# left the substitution to be noticed at step 4 by a tree that happened to
# differ — a comparison against a reference, not a broken chain.
#
# What identity to carry is decided by what an attacker controls. The path is
# the operator's to choose and can be re-pointed at will, and `sha256sum` writes
# the NAME beside the digest, so the two fields are separated here and only the
# digest is kept: steps 2 and 3 compare the reading, never the path. The digest
# is the one MEASURED from the bytes a line above, not the one asserted on the
# command line — an asserted digest is the caller's word, and this file has to
# outlive that.
awk '{ print $1 }' "$3/actual.sha256" > "$3/bundle-id.sha256"
# The success token, and step 2's guard reads THIS. actual.sha256 used to be that
# guard — step 2 refuses to run unless step 1 left its artifact behind — and it
# stopped being usable as one the moment it moved above the check: it now exists
# after a REFUSED step 1 too. This file is written only where the check passed,
# so the chain still refuses to continue past a digest mismatch. It carries the
# same bytes the step prints, and `cat` is what prints them. The digest stays OUT
# of it: the stdout contract of this step is the exact line `bundle-sha256-ok`,
# and the token is printed verbatim, so identity lives in bundle-id.sha256 beside
# it rather than in the line an adopter's gate matches.
printf 'bundle-sha256-ok\n' > "$3/checksum-ok.txt"
cat "$3/checksum-ok.txt"
