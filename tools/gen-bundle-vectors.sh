#!/bin/sh
# Regenerate the negative vectors that ship inside skills/git-bundle-verify.
#
#   sh tools/gen-bundle-vectors.sh [<out-dir>]      # default: the skill's vectors/
#
# WHY THESE BYTES SHIP RATHER THAN BEING BUILT AT RUN TIME. "The skill refuses a
# defective bundle" has to be a property of the PACKAGE, checkable by whoever
# adopted it, not a claim its author verified elsewhere and wrote down. So the
# defective bundles travel with the runbook, together with the digests and the
# expected refusal of each (vectors/MATRIX.tsv), and an adopter re-runs the
# matrix instead of trusting this file.
#
# WHY A THROWAWAY REPOSITORY. Bundles of a real project are megabytes and would
# dominate the package; two commits over two small files are ~500 bytes each and
# exercise exactly the same code paths in git.
#
# Determinism: identities and both dates are pinned, so re-running produces
# byte-identical bundles on the same git. A git that changes pack encoding will
# produce different bytes — that is a new vector set, and MATRIX.tsv carries the
# digests, so the change cannot pass unnoticed.
set -eu

out=${1:-skills/git-bundle-verify/vectors}
mkdir -p "$out"
out=$(cd "$out" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=vectors GIT_AUTHOR_EMAIL=vectors@skillonomia.invalid
export GIT_COMMITTER_NAME=vectors GIT_COMMITTER_EMAIL=vectors@skillonomia.invalid
export GIT_AUTHOR_DATE="2020-01-01T00:00:00+0000" GIT_COMMITTER_DATE="2020-01-01T00:00:00+0000"

# --- the repository the GOOD bundle carries: two commits, two files ----------
git init --quiet --initial-branch=main "$work/repo"
printf 'one\n' > "$work/repo/a.txt"
git -C "$work/repo" add a.txt
git -C "$work/repo" commit --quiet -m one
printf 'two\n' > "$work/repo/b.txt"
git -C "$work/repo" add b.txt
git -C "$work/repo" commit --quiet -m two

git -C "$work/repo" bundle create --quiet "$out/good.bundle" --all
# INCREMENTAL: the top commit only, so its prerequisite is absent from any fresh
# probe repository. Cloning it where the base exists succeeds, which is exactly
# why the class needs catching.
git -C "$work/repo" bundle create --quiet "$out/incremental.bundle" HEAD~1..HEAD

# --- FOREIGN: a valid, complete bundle of a DIFFERENT repository -------------
git init --quiet --initial-branch=main "$work/other"
printf 'elsewhere\n' > "$work/other/x.txt"
git -C "$work/other" add x.txt
git -C "$work/other" commit --quiet -m other
git -C "$work/other" bundle create --quiet "$out/foreign.bundle" --all

# --- CORRUPT: one byte flipped inside the packfile ---------------------------
# Offset 300 is past the header of a bundle this size, so the header still reads
# and `git bundle verify` still accepts it — the damage surfaces at the digest,
# or at the clone if the digest travelled with the file.
cp "$out/good.bundle" "$out/corrupt.bundle"
printf '\377' | dd of="$out/corrupt.bundle" bs=1 seek=300 conv=notrunc status=none

# --- TRUNCATED: header intact, packfile cut off -----------------------------
head -c 200 "$out/good.bundle" > "$out/truncated.bundle"

# --- the reference tree the GOOD bundle must equal --------------------------
rm -rf "$out/reference"
mkdir -p "$out/reference"
cp "$work/repo/a.txt" "$work/repo/b.txt" "$out/reference/"

# --- the matrix: which vector is refused where, and by which signal ---------
good=$(sha256sum "$out/good.bundle" | cut -d' ' -f1)
corrupt=$(sha256sum "$out/corrupt.bundle" | cut -d' ' -f1)
truncated=$(sha256sum "$out/truncated.bundle" | cut -d' ' -f1)
incremental=$(sha256sum "$out/incremental.bundle" | cut -d' ' -f1)
foreign=$(sha256sum "$out/foreign.bundle" | cut -d' ' -f1)

{
  printf '# bundle\tdigest passed to step 1\trefused at step (0 = accepted)\tevidence\n'
  printf 'good.bundle\t%s\t0\taccepted\n' "$good"
  printf 'corrupt.bundle\t%s\t1\tnone\n' "$good"
  printf 'corrupt.bundle\t%s\t3\tnone\n' "$corrupt"
  printf 'truncated.bundle\t%s\t1\tnone\n' "$good"
  printf 'truncated.bundle\t%s\t3\tnone\n' "$truncated"
  printf 'incremental.bundle\t%s\t2\tprerequisites\n' "$incremental"
  printf 'foreign.bundle\t%s\t4\tdivergences\n' "$foreign"
} > "$out/MATRIX.tsv"

sha256sum "$out"/*.bundle | sed "s#$out/##" > "$out/DIGESTS.sha256"

printf 'wrote vectors to %s\n' "$out"
ls -l "$out"
