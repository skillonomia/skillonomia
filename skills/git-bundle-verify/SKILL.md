# git-bundle-verify

Accept, or refuse, a git bundle you were handed as a release artifact.

This is a reading procedure. It writes only inside the work directory you give
it, it never touches the network, it needs no elevated privileges, and it is
deterministic: the same bundle and the same reference tree produce the same
lines every time.

## Why this exists

A bundle arrives with a digest written next to it. Four things have to be true
before anything downstream may rely on it, and each of them fails in a different
way:

1. the file is the one the digest names — otherwise you are verifying a
   different artifact than the one that was signed off;
2. the bundle records a **complete** history, not an increment against a
   repository you do not have — an incremental bundle clones only where the base
   already exists, so it looks fine on the machine that produced it;
3. it actually clones, and the clone's HEAD commit and tree are the ones you
   were told to expect;
4. the tree it produces equals the reference checkout **byte for byte** — a
   bundle can be well-formed, complete and still be cut from the wrong commit.

Each step ends the run on failure, so a later step never reports on a bundle an
earlier step already refused. Each step also refuses to run unless the previous
step left its artifact behind, so the four are a chain and not four independent
commands that happen to be listed in order.

## What step 1 does NOT prove

`g1` proves that the file in front of you is the one you were told about. It
says nothing about whether the one who told you is to be trusted. **The expected
SHA-256 and the reference tree must reach you by a different channel than the
bundle itself.** If the digest travelled beside the artifact — same download,
same directory, same message — then whoever replaced the artifact replaced the
digest with it, and step 1 adds no guarantee at all. It is still worth running
in that case, because it catches corruption in transit; it is simply not
evidence of provenance, and the runbook cannot make it into any.

Provenance is a signature over the digest, verified against a key you obtained
independently. That is outside this runbook.

## About the SIGNATURE.jws in this package

You do not have to verify it before running these scripts. The registry checks
the package signature when it hands the package over (§4.4); an adopter's copy
has already been through that. It ships so the package stays verifiable after
it leaves the registry, not because the runbook depends on it.

## Inputs

| Placeholder | Meaning |
|---|---|
| `BUNDLE_PATH` | the `.bundle` file, opened read-only |
| `EXPECTED_SHA256` | the digest recorded for it, 64 lowercase hex characters, **obtained separately from the bundle** |
| `WORK_DIR` | a directory that does not exist, or exists and is **empty**; step 1 refuses anything else |
| `REFERENCE_DIR` | a checkout of the commit the bundle is supposed to carry, opened read-only |

Substitute the placeholder words for real values; the runbook takes them as
positional arguments and quotes them, so paths with spaces are fine, and both
absolute and relative paths work.

## Requirements

- **git 2.30 or newer.** The runbook is entirely about the behaviour of
  `git bundle verify`, which has changed across git's branches, so the version
  is declared rather than assumed. Step 1 checks it and refuses an older one.
  Only a lower bound is meaningful here: a newer git is fine.
- **GNU coreutils** on `PATH` (`sha256sum`, `sort`, `cat`, `printf`), **GNU
  sed**, and `cmp` from diffutils.
- **awk** on `PATH` — any POSIX awk. It is what counts the lines in steps 3
  and 4. `wc -l` would be the obvious choice and is the wrong one: some
  implementations pad the count to a column, and `g3`/`g4` are declared as
  **exact** lines, so `tracked-files      2` fails a gate this package sets for
  itself. `awk 'END { print NR }'` prints the number and nothing else
  everywhere — and counts a final line that has no newline, which `wc -l` skips.

## `runtime.os` is `linux`, and that is a declaration, not a preference

An earlier version of this package declared `linux` **and** `macos`, and listed
GNU coreutils under `prerequisites` beside it. That reads as "runs on macOS,
mind the dependencies". It does not run on a stock macOS at all, and nobody had
checked:

| The script writes | Stock macOS has | Portable? |
|---|---|---|
| `sha256sum --check --strict --status` | `shasum -a 256`, different name and different check semantics | no |
| `sort --check --version-sort` | BSD `sort`, which has neither the long option nor `-V` | no |
| `sed --quiet --expression=…` | BSD `sed`, `-n`/`-e` only | no |

The fix is not to move the caveat somewhere more prominent. A declared `os` is a
promise about where the runbook runs, so it now names only where the runbook
runs. Making it true instead would mean choosing between two spellings at run
time — a conditional — and **gate 5 classifies a conditional as
`control-construct` and FAILs the package**. A runbook that must pass its own
safety gate cannot carry a portability branch, so `linux` is the honest
declaration and not merely the convenient one.

With GNU coreutils and GNU sed installed and ahead of the BSD ones on `PATH`,
the scripts will of course run on macOS. That is the operator's arrangement, not
this package's claim.

## The scripts look broken, and are not

They ship with mtime `1970-01-01` and no execute bit. That is the archive
profile: the packer normalises both so the package hashes to the same bytes
everywhere (§4.1b). It is why the runbook is invoked as `sh scripts/…` rather
than `./scripts/…`, and it is not damage.

## Procedure

```
sh scripts/01-checksum.sh BUNDLE_PATH EXPECTED_SHA256 WORK_DIR
sh scripts/02-history.sh  BUNDLE_PATH WORK_DIR
sh scripts/03-clone.sh    BUNDLE_PATH WORK_DIR
sh scripts/04-compare.sh  WORK_DIR REFERENCE_DIR
```

Expected stdout, in order:

```
bundle-sha256-ok
bundle-history-complete
head-commit <40 hex>
head-tree <40 hex>
tracked-files <count>
clone-ok
divergences 0
```

## Validation gates

- `g0-work-dir` — `WORK_DIR` is absent or empty. Step 1 removes it and creates
  it again; a directory with anything in it survives `rmdir`, which fails.
- `g0-git-version` — `git version` is at least the declared minimum, decided by
  `sort --check --version-sort` over the pair [required, actual].
- `g1-digest` — stdout of step 1 is exactly `bundle-sha256-ok`. `sha256sum` runs
  in check mode against a file the script writes from your argument, so a wrong
  digest exits non-zero under `set -e` and nothing is printed. Read *What step 1
  does NOT prove* above before treating this as authenticity.
- `g2-complete-history` — stdout of step 2 is exactly `bundle-history-complete`,
  which requires **two** signals to agree:
  - the **exit status** of `git bundle verify` — the refusal condition. It is
    non-zero for an incremental bundle, for a damaged header and for a file that
    is not a bundle, and unlike the sentence `The bundle records a complete
    history` it is neither localizable nor version-dependent;
  - an **empty `prerequisites.txt`** — the classifier. The exit status alone
    cannot tell "incomplete history" from "not a bundle at all", and those need
    different actions from you. The list is parsed out of the bundle header,
    where a prerequisite is a line beginning `-` followed by an object id, up to
    the blank line that ends the header.

  Step 2 initialises an empty probe repository first, because git refuses to
  verify a bundle from outside a repository at all.
- `g3-clone` — stdout of step 3 ends with `clone-ok`, preceded by the three
  identity lines. Those three lines are the finding worth recording.
- `g4-matches-reference` — stdout of step 4 is exactly `divergences 0` **and**
  step 4 exits `0`. The two cannot disagree: the count is printed, then
  `divergences.txt` is compared against an empty file, so a non-zero count is a
  non-zero exit status. Read either signal.

## How failure looks

Every script runs under `set -e`, so a failing step stops. Every step but the
last prints **nothing on stdout** when it refuses; an empty stdout is the
refusal, not "the step did not run". Step 4 is the exception, and deliberately:
it prints its count *before* it refuses, so the finding survives the refusal.
Either way the exit status is non-zero. The diagnosis is in stderr and in the
work directory.

| Refused at | Exit | stdout | What you see, and what it means |
|---|---|---|---|
| `g0-work-dir` | 1 | empty | `rmdir: failed to remove 'WORK_DIR': Directory not empty`. Point the run at a fresh directory; the runbook deletes nothing. |
| `g0-git-version` | 1 | empty | `sort: …/git-version-check.txt:2: disorder: git version 2.20.1` — the second line is your git, and it is below the minimum. |
| `g1-digest` | 1 | empty | **Nothing at all**: `sha256sum --status` is silent by contract. Compare `expected.sha256` with the file yourself. The bundle is not the artifact the digest names — re-obtain it, and do not clone the copy you hold. |
| `g2`, exit status | 1 | empty | `bundle-verify.txt` carries git's own words. If `prerequisites.txt` is **not empty**, it is an incremental bundle and the file names the commits you lack — obtain the base repository, or a full bundle. If `prerequisites.txt` **is** empty, the file is not a readable bundle at all. |
| `g2`, classifier | 1 | empty | `cmp: EOF on …/prerequisites-expected.txt which is empty` — `git bundle verify` was satisfied, but the bundle declares prerequisites. Same reading as above: incremental. |
| `g3-clone` | 128 | empty | git's own error: `error: inflate: data stream error …` for damaged bytes, `fatal: early EOF` for a truncated file, `error: Repository lacks these prerequisite commits:` for an increment. Exit 128 is git's, not the runbook's. |
| step 4, no step 3 | 1 | empty | `cat: …/head-commit.txt: No such file or directory` — step 3 has not run, or did not finish. Run the chain in order. |
| `g4-matches-reference` | 1 | `divergences N` | The one step that prints on refusal, because the count *is* the finding: anything but `divergences 0` is a refusal, and the count says how large it is. stderr reads `cmp: EOF on …/divergences-expected.txt which is empty`. `divergences.txt` names the paths — either the reference tree carries local edits, or the bundle is not the commit it claims. |

The last row used to read exit `0`, and that was a trap: step 4 refused by
**value** only, so a caller that composes steps by exit status accepted a bundle
of an entirely different repository. Writing the trap down did not disarm it. It
now refuses both ways — the number for a reader, the exit status for a caller —
and the two are the same fact, because the count is compared against an empty
file rather than merely printed.

## Self-check: prove the runbook can refuse

The package ships the bundles it is supposed to reject, in `vectors/`. Run them
before you trust a verdict from this runbook — on a package you were given, this
is the difference between "the author says it refuses bad bundles" and "it
refused these bad bundles here, just now".

`vectors/MATRIX.tsv` has one row per case: the bundle, the digest to pass to
step 1, the step that must refuse it, and the evidence to look for.
`vectors/README.md` explains each vector. Give **every row its own fresh work
directory** — step 1's `g0-work-dir` refuses a shared one, which is itself part
of the demonstration.

```
sh scripts/01-checksum.sh vectors/good.bundle        <digest from MATRIX.tsv> WORK_DIR/1
sh scripts/02-history.sh  vectors/good.bundle        WORK_DIR/1
sh scripts/03-clone.sh    vectors/good.bundle        WORK_DIR/1
sh scripts/04-compare.sh  WORK_DIR/1 vectors/reference
```

That row is the positive control and must end in `divergences 0`. Without it a
runbook that refused *everything* would look perfect. The other six rows must
each stop at the step the matrix names:

- **corrupt** — one byte flipped inside the packfile. Offered with the digest
  you were told, it dies at step 1. Offered with its own digest — the case where
  the digest was replaced along with the file — it passes steps 1 and 2 and dies
  at the clone.
- **truncated** — the same two readings, `fatal: early EOF` at step 3.
- **incremental** — dies at step 2 with a non-empty `prerequisites.txt`. This is
  the most informative failure in the set: the artifact names what is missing.
- **foreign** — a valid, complete bundle of another repository. Right digest,
  complete history, clean clone, and `divergences 1` at step 4, with a non-zero
  exit status alongside it.

Two facts the matrix makes visible, and neither is obvious:

- `git bundle verify` reads only the **header**. It accepts both the corrupt and
  the truncated bundle, printing `is okay` and `records a complete history` over
  a file that cannot clone. Damage is caught by the digest or by the clone —
  never by step 2. Any procedure that stops after `git bundle verify` is weaker
  than it reads.
- All four classes are caught by an exit status, and the fourth — the foreign
  bundle — is *also* caught by a number on stdout. That was not always true: the
  foreign bundle used to be caught by the number alone. Two signals that cannot
  disagree is the point; one signal that a caller might not read is the defect
  the earlier version shipped.

## What each script leaves in the work directory

| Path | Contents |
|---|---|
| `git-version.txt`, `git-required.txt`, `git-version-check.txt` | your git, the declared minimum, and the pair the version check read |
| `expected.sha256`, `actual.sha256` | the digest you asserted, and the one measured |
| `probe/` | the throwaway repository `git bundle verify` needs; it holds nothing but `probe/.git`, which is where git init put it |
| `prerequisites.txt` | the bundle's prerequisite lines. **Empty on success** — a complete bundle names none |
| `prerequisites-expected.txt` | the empty file the line above is compared against |
| `bundle-verify.txt` | the full output of `git bundle verify`, including any missing prerequisites |
| `clone/` | the clone |
| `head-commit.txt`, `head-tree.txt`, `tracked-files.txt` | the three identity facts |
| `divergences.txt` | one line per tracked path whose bytes differ. **0 bytes is the success case**, not a step that failed to run |
| `divergences-expected.txt` | the empty file the line above is compared against — the comparison is what turns a non-zero count into a non-zero exit status |

## Notes on the comparison

Step 4 does not walk the two directories with `diff`. It points the clone's own
git directory at the reference tree as a work tree and asks git which **tracked**
paths differ from HEAD. That is deliberate:

- untracked build output in the reference tree (`dist/`, `node_modules/`) is not
  a divergence, and a directory walk reports it as one;
- comparison is by content, so a re-checkout with different timestamps or
  permissions is not a divergence either;
- every byte git writes goes into the clone's git directory, inside `WORK_DIR`.
  The reference tree is only read.

A missing tracked path in the reference tree **is** a divergence, and is
reported.

## Rollback

Delete `WORK_DIR`. There is nothing else: no remote, no registry, no system
state, and neither the bundle nor the reference tree is modified.
