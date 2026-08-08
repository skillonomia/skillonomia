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
step left its **success token** behind, so the four are a chain and not four
independent commands that happen to be listed in order.

A success token is not any file the previous step wrote. Steps 1 and 2 both
leave measurements and diagnoses behind *before* they know their own verdict —
`actual.sha256` is written before the digest is checked, and `bundle-verify.txt`
is created by the redirect that captures `git bundle verify`, so both exist
after a refusal too. Guarding on either of those is guarding on "the step ran",
which is not the question. `checksum-ok.txt` and `history-ok.txt` are written
only past the checks that decide, and they are what the next step reads.

## What a success token proves, and what it does not

A token says **a step agreed**. On its own it does not say **about what**, and
it does not say **when** — and both gaps were live defects, found by running the
chain rather than by reading it.

*About what.* `BUNDLE_PATH` is an argument, given again to steps 2 and 3, and
nothing used to require it to name the same file each time. One work directory
took `g1 good.bundle`, `g2 good.bundle`, then `g3` on a bundle of an **entirely
different repository** — and printed `head-commit`, `head-tree`,
`tracked-files` and `clone-ok` over it. The substitution was noticed at step 4,
by a comparison against the reference tree that happened to differ; had the
foreign bundle carried the same tree, nothing would have refused at all. So
step 1 now writes a **binding** as well as a token: `bundle-id.sha256`, holding
the SHA-256 it **measured** from the bytes it accepted — the digest alone, with
no path beside it, because the path is precisely what a substitution
re-points. Steps 2 and 3 each measure the file actually in front of them and
compare against that binding before doing anything else. Step 4 remains as
defence in depth, and stops being the first thing that notices.

*When.* A token used to outlive the run that wrote it. `g1 good.bundle`,
`g2 good.bundle` — token written; then `g2` again in the **same** work
directory on an incremental bundle: it refused, and `history-ok.txt` was still
there, left by the earlier run. `g3` read it, was satisfied, and cloned. So
step 2 now **destroys `history-ok.txt` as its first action**, before it can
succeed or fail at anything, and writes it again only past every signal. After
a refused step 2 there is no usable token — not this run's, not the last one's —
whichever bundle step 3 is then handed.

Neither of these makes a token proof of a correct run in general. They make it
proof of *this* run, on *this* artifact, which is what the next step needs. The
diagnosis files are the opposite and deliberately so: they survive everything,
because a refusal with nothing left to read is a refusal you cannot act on.

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

`g1` also does not say **why** the bytes differ when they do. It confirms one
thing and only that thing: the file matches the digest you obtained separately.
A flipped byte and a file cut off half way are the same event to it — two
digests that are not equal — and it cannot be otherwise, because a digest that
disagrees carries no information about the shape of the disagreement.
`vectors/MATRIX.tsv` records `evidence: none` for both of those rows for exactly
this reason, and that is not a gap in the gate. Which kind of damage it is
becomes visible at step 3, where the packfile is actually inflated: `inflate:
data stream error` for the corrupt bundle, `early EOF` for the truncated one.

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
  digest exits non-zero under `set -e` and nothing is printed. The step measures
  the bundle into `actual.sha256` **before** it runs the check, so both readings
  — the digest you asserted and the digest the file has — are in the work
  directory whichever way the check goes. What passing this gate means is
  narrow and exact: **the file matches a digest you obtained by another
  channel**, and nothing else. Read *What step 1 does NOT prove* above before
  treating it as authenticity, or as a diagnosis of the damage. Passing also
  writes `bundle-id.sha256` — the **measured** digest on its own line, no path —
  which is what binds the rest of the chain to this file. A refusal leaves it
  absent, exactly as it leaves `checksum-ok.txt` absent.
- `g1-binding` — steps 2 and 3 are about the **same artifact** step 1 accepted.
  Each measures its own `BUNDLE_PATH` and compares the digest field against
  `bundle-id.sha256`; a mismatch, or a binding that is not there at all, ends
  the step with empty stdout and a stderr naming the file. The comparison is
  made **before** either step does anything else — before `git init`, before
  the header is read, before `git bundle verify`, before `git clone` — so a
  substituted bundle leaves no `probe/`, no `bundle-verify.txt` and no `clone/`
  to be mistaken for progress. The digest is compared, never the path: the path
  is your argument and is what a substitution changes.
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
  verify a bundle from outside a repository at all. Past both signals it writes
  `history-ok.txt`, and step 3's guard reads THAT. `bundle-verify.txt` used to
  be that guard and could never be one: the redirect that captures git's output
  creates the file before the exit status exists, so a refused step 2 leaves it
  behind — see *How failure looks* for what that let through.

  Before any of that, step 2 **removes `history-ok.txt`**. The token is a claim
  about the run that writes it, and in a work directory a second step 2 may be
  run in, its mere presence stopped being that claim — see *What a success token
  proves*. Removing it first means a refusal at **any** later signal leaves the
  chain with no token to continue on.
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
Either way the exit status is non-zero.

**The diagnosis is always in the work directory.** For every step but `g1` it is
in stderr as well — the failing command names what it read and what it found.
`g1` is the exception in both directions, and by design: `sha256sum --status`
prints nothing on stdout *or* stderr, so its diagnosis is on disk alone, as
`expected.sha256` and `actual.sha256` written side by side. Read the pair; do
not expect a message.

| Refused at | Exit | stdout | What you see, and what it means |
|---|---|---|---|
| `g0-work-dir` | 1 | empty | `rmdir: failed to remove 'WORK_DIR': Directory not empty`. Point the run at a fresh directory; the runbook deletes nothing. |
| `g0-git-version` | 1 | empty | `sort: …/git-version-check.txt:2: disorder: git version 2.20.1` — the second line is your git, and it is below the minimum. |
| `g1-digest` | 1 | empty | **Nothing on stderr either**: `sha256sum --status` is silent by contract, and that silence is deliberate. The diagnosis is the pair of files in the work directory — read `expected.sha256` (the digest you asserted) against `actual.sha256` (the digest the file has). They differ, and that difference *is* the refusal. The bundle is not the artifact the digest names — re-obtain it, and do not clone the copy you hold. The step does not say which kind of damage it is; step 3 does. |
| `g2`, exit status | 1 | empty | `bundle-verify.txt` carries git's own words, and it is there **because the redirect wrote it, not because the step passed** — `history-ok.txt` is what is absent. If `prerequisites.txt` is **not empty**, it is an incremental bundle and the file names the commits you lack — obtain the base repository, or a full bundle. If `prerequisites.txt` **is** empty, the file is not a readable bundle at all. |
| `g2`, classifier | 1 | empty | `cmp: EOF on …/prerequisites-expected.txt which is empty` — `git bundle verify` was satisfied, but the bundle declares prerequisites. Same reading as above: incremental. `history-ok.txt` is absent here too: it is written past **both** signals or not at all. |
| `g3-clone` | 128 | empty | git's own error: `error: inflate: data stream error …` for damaged bytes, `fatal: early EOF` for a truncated file, `error: Repository lacks these prerequisite commits:` for an increment. Exit 128 is git's, not the runbook's. |
| step 2, no passing step 1 | 1 | empty | `cat: …/checksum-ok.txt: No such file or directory` — step 1 has not run, or ran and **refused**. `actual.sha256` being present is not permission to continue: it is written before the check and says only what was measured. Run the chain in order, and past a `g1` refusal do not run it at all. |
| step 3, no passing step 2 | 1 | empty | `cat: …/history-ok.txt: No such file or directory` — step 2 has not run, or ran and **refused**. `bundle-verify.txt` being present is not permission to continue: the redirect creates it before `git bundle verify` has an exit status, so it says only what git printed. Nothing is cloned; there is no `clone/`. |
| step 2 or 3, a DIFFERENT bundle | 1 | empty | `…/bundle-id.sha256 …/step2-input-id.sha256 differ: byte 1, line 1` (or `step3-…`) — the file this step was handed is not the file step 1 accepted. Nothing was initialised, verified or cloned; the two ids are in the work directory to be read side by side. Give every step the same `BUNDLE_PATH`, or start a fresh work directory for the other bundle. |
| step 2 or 3, no binding | 2 | empty | `cmp: …/bundle-id.sha256: No such file or directory` — step 1 has not run, or ran and **refused**: the binding is written past the same check as the token. |
| step 3, after a REFUSED second step 2 | 1 | empty | `cat: …/history-ok.txt: No such file or directory`, **even on the bundle the earlier step 2 passed**. Step 2 destroys its own token before it starts, so the last step 2 in this work directory is the only one whose verdict survives. Its diagnosis — `bundle-verify.txt`, `prerequisites.txt` — is still there to read. |
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
- those two rows are **indistinguishable at step 1**, and the matrix says so by
  giving both `evidence: none`. A digest that disagrees is a digest that
  disagrees; step 1 is not being coy about which defect it found, it does not
  have that fact. What it does leave, for both rows, is `expected.sha256` and
  `actual.sha256` in the work directory — the two numbers, so the mismatch is
  checkable rather than merely reported. The defects part company at step 3.
- **incremental** — dies at step 2 with a non-empty `prerequisites.txt`. This is
  the most informative failure in the set: the artifact names what is missing.
  It is also the row that shows the chain holding: run step 3 anyway, against
  the same work directory, and it refuses on `history-ok.txt` before it clones
  anything. It did not always. Step 3 used to guard on `bundle-verify.txt`,
  which the redirect writes before the verify has an exit status, so a refused
  step 2 satisfied it and `git clone` ran — refused, in the end, by git's own
  `error: Repository lacks these prerequisite commits:` rather than by the
  runbook naming the artifact its predecessor never wrote. No bad bundle was
  accepted, and that is not the point: a step ran after the step before it
  refused, which is the one thing the chain exists to prevent.
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

### Self-check, part two: the chain, not the bundles

Every row of `MATRIX.tsv` is one bundle walked through the steps in order, and
that is all the table's shape can say: bundle, digest, the step that refuses it.
The two defects above are not properties of a bundle — they are properties of a
**sequence**, and they need two bundles and one work directory to show. So they
are here, as three runs you can make on the vectors this package already ships.
Give each its own fresh `WORK_DIR`; `<good>` is `good.bundle`'s digest from
`MATRIX.tsv`.

**A — the input switched between step 1 and step 2.**

```
sh scripts/01-checksum.sh vectors/good.bundle    <good> WORK_DIR/A   → bundle-sha256-ok
sh scripts/02-history.sh  vectors/foreign.bundle        WORK_DIR/A   → refused
```

Step 2 must exit non-zero with **empty stdout**, stderr naming
`bundle-id.sha256`, and `WORK_DIR/A` must contain no `probe/`, no
`prerequisites.txt`, no `bundle-verify.txt` and no `history-ok.txt`. A step 2
that reports on `foreign.bundle` at all has reported truthfully about the wrong
artifact.

**B — the input switched between step 2 and step 3.**

```
sh scripts/01-checksum.sh vectors/good.bundle    <good> WORK_DIR/B   → bundle-sha256-ok
sh scripts/02-history.sh  vectors/good.bundle           WORK_DIR/B   → bundle-history-complete
sh scripts/03-clone.sh    vectors/foreign.bundle        WORK_DIR/B   → refused
```

Step 3 must exit non-zero with empty stdout, stderr naming `bundle-id.sha256`,
and **no `clone/` in `WORK_DIR/B`**. This is the run that used to print
`head-commit`, `head-tree`, `tracked-files` and `clone-ok` over another
repository, and be caught only at step 4.

**C — a stale token from an earlier step 2.**

```
sh scripts/01-checksum.sh vectors/good.bundle        <good> WORK_DIR/C  → bundle-sha256-ok
sh scripts/02-history.sh  vectors/good.bundle               WORK_DIR/C  → bundle-history-complete
sh scripts/02-history.sh  vectors/incremental.bundle        WORK_DIR/C  → refused
sh scripts/03-clone.sh    vectors/good.bundle               WORK_DIR/C  → refused
```

The last line is the one worth watching: step 3 is handed the bundle the first
step 2 **passed**, and must still refuse, naming `history-ok.txt`. The token
belongs to the run that wrote it, and the run that wrote it has been overtaken
by one that refused. `bundle-verify.txt` and `prerequisites.txt` from the
refused run stay — those are diagnosis, and diagnosis is meant to survive.

`MATRIX.tsv` is deliberately left as it is: one row is one bundle, and a table
that had to name two bundles and their order would stop being the flat,
machine-readable thing the seven rows are checked by.

## What each script leaves in the work directory

Two kinds of file, and the difference decides what may be read as permission to
continue. **Diagnosis** is written whichever way a step goes; its presence says
only that the step got that far. **Success tokens and the binding** are written
only past the checks that decide, and they are what the next step reads. Reading
a diagnosis file as a verdict is the defect this package has now closed three
times, at three different joints.

### Diagnosis — present after a refusal too, never permission to continue

| Path | Contents |
|---|---|
| `git-version.txt`, `git-required.txt` | your git, and the declared minimum |
| `git-version-check.txt` | the pair `[required, actual]` that `sort --check --version-sort` reads; it is the input to the version gate, not its result |
| `expected.sha256`, `actual.sha256` | the digest you asserted, and the one measured from the bundle. `actual.sha256` is written **before** the check, so both are here after a refusal too — they are what a refused `g1` leaves instead of a message |
| `step2-input.sha256`, `step3-input.sha256` | `sha256sum` over the `BUNDLE_PATH` that step 2 and step 3 were actually handed, name included |
| `step2-input-id.sha256`, `step3-input-id.sha256` | the digest field of the line above, alone — what is compared against the binding. After a refused binding check, read one of these against `bundle-id.sha256`: that difference *is* the refusal |
| `probe/` | the throwaway repository `git bundle verify` needs; it holds nothing but `probe/.git`, which is where git init put it |
| `prerequisites.txt` | the bundle's prerequisite lines. **Empty on success** — a complete bundle names none |
| `prerequisites-expected.txt` | the empty file the line above is compared against |
| `bundle-verify.txt` | the full output of `git bundle verify`, including any missing prerequisites. Written by a **redirect**, so it exists whichever way the verify went — it is the diagnosis, never the verdict, and cannot serve as step 3's guard |
| `clone/` | the clone |
| `head-commit.txt`, `head-tree.txt`, `tracked-files.txt` | the three identity facts |
| `divergences.txt` | one line per tracked path whose bytes differ. **0 bytes is the success case**, not a step that failed to run |
| `divergences-expected.txt` | the empty file the line above is compared against — the comparison is what turns a non-zero count into a non-zero exit status |

### Success tokens and the binding — written only past a passing check

| Path | Contents |
|---|---|
| `checksum-ok.txt` | written only where `g1` **passed**, and carrying the same `bundle-sha256-ok` the step prints. It is what step 2 refuses to run without: `actual.sha256` cannot serve as that guard now that it survives a refusal |
| `bundle-id.sha256` | the **binding**: the digest step 1 measured, alone on its line with no path beside it, written past the same check as the token. Steps 2 and 3 compare their own input against this before they do anything else, so the chain is about one artifact rather than about a sequence of agreements |
| `history-ok.txt` | written only where `g2` **passed** — past its binding check, a zero exit status from `git bundle verify` AND a `prerequisites.txt` proven empty — and carrying the same `bundle-history-complete` the step prints. It is what step 3 refuses to run without. **Removed at the start of every step 2**, so it is never the previous run's answer to this run's question |

Step 3 has no token of its own: step 4 guards on `head-commit.txt`, which is
step 3's finding rather than its verdict. That is a narrower joint than the
others — step 3's only failure mode is `git clone` failing, which leaves no
`head-commit.txt` either — but it is not the same shape as the two above, and
it is listed here so the difference is visible rather than assumed.

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
