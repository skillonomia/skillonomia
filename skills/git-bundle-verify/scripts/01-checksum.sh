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
printf '%s  %s\n' "$2" "$1" > "$3/expected.sha256"
sha256sum --check --strict --status "$3/expected.sha256"
sha256sum "$1" > "$3/actual.sha256"
echo bundle-sha256-ok
