# `vectors/` — the bundles this runbook must REFUSE

Four defect classes, one positive control, and the digest each one is to be
offered with. They are here so that "the runbook refuses a bad bundle" is
something you can check on the package you were given, instead of something its
author checked elsewhere and wrote down. `SKILL.md > Self-check` is the
procedure; `MATRIX.tsv` is the same thing in one machine-readable table.

Every bundle is cut from a throwaway two-commit repository, which is why they
are a few hundred bytes each. `tools/gen-bundle-vectors.sh` in the source
repository regenerates them byte for byte: identities and both dates are pinned.

| File | What it is |
|---|---|
| `good.bundle` | complete, clonable, matches `reference/` — the positive control |
| `corrupt.bundle` | `good.bundle` with one byte flipped at offset 300, inside the packfile |
| `truncated.bundle` | the first 200 bytes of `good.bundle`: header intact, packfile cut off |
| `incremental.bundle` | the top commit only, so its prerequisite is missing from any fresh probe |
| `foreign.bundle` | a valid, complete bundle of a DIFFERENT repository |
| `reference/` | the working tree of `good.bundle`'s HEAD — two files |
| `MATRIX.tsv` | bundle, digest to pass to step 1, the step that must refuse it, the evidence |
| `DIGESTS.sha256` | `sha256sum` over every bundle here |

## What the matrix shows, and it is not what one would guess

`git bundle verify` reads the bundle HEADER. It does not inflate the packfile.
So `corrupt.bundle` and `truncated.bundle` both pass step 2 — it prints `is
okay` and `records a complete history` over a file that cannot possibly clone.
Damage is caught by step 1 when the digest is honest, and by step 3 when it is
not. That is why the runbook has four steps and not two, and why the matrix
offers the damaged bundles twice: once with the digest you were told, once with
the digest of the file you actually hold.

| Vector, and the digest it is offered with | Refused at | How you know |
|---|---|---|
| `good.bundle`, its own digest | nowhere — accepted | `divergences 0` |
| `corrupt.bundle`, `good.bundle`'s digest | step 1 | exit non-zero; stdout and stderr both empty; `expected.sha256` and `actual.sha256` in the work directory, differing |
| `corrupt.bundle`, its own digest | step 3 | `error: inflate: data stream error …` |
| `truncated.bundle`, `good.bundle`'s digest | step 1 | exit non-zero; stdout and stderr both empty; the same two files, differing |
| `truncated.bundle`, its own digest | step 3 | `fatal: early EOF` |
| `incremental.bundle`, its own digest | step 2 | exit non-zero; `prerequisites.txt` NOT empty |
| `foreign.bundle`, its own digest | step 4 | exit non-zero, and `divergences 1` on stdout — the count survives the refusal because it IS the finding |

The `evidence` column of `MATRIX.tsv` reads `none` for both step-1 rows, and
that is a statement about the CONSOLE, not about the run. Step 1 prints nothing
either way — `sha256sum --status` is silent by contract — and it genuinely
cannot name the defect: a digest that disagrees is the same event whether one
byte was flipped or the tail was cut off, which is why those two rows are
identical in shape and part company only at step 3. What the run does leave
behind is the arithmetic: `expected.sha256` holds the digest you passed in,
`actual.sha256` the digest the file actually has, and they are written side by
side because the measurement happens *before* the check rather than after it.
Verifying a step-1 row means reading those two files, not looking for a message.

## What the matrix cannot say, and where that case lives instead

One row is one bundle: the file, the digest to offer it with, the step that must
refuse it. That shape covers every defect that is a property of a **bundle**,
and it covers none that is a property of a **sequence** — the same work
directory, two different bundles, the steps run in an order the operator chose.
Two of those were live defects here:

- the input **switched** between steps. `g1 good.bundle`, `g2 good.bundle`,
  `g3 foreign.bundle` printed `clone-ok` over another repository's bundle, and
  was caught one step later by the reference-tree comparison — which would have
  said nothing had the foreign bundle carried the same tree;
- a **stale** token. `g1 good.bundle`, `g2 good.bundle`, then `g2` again on
  `incremental.bundle` in the same directory: the second `g2` refused and the
  first one's `history-ok.txt` was still there, so `g3` cloned.

Step 1 now writes `bundle-id.sha256` — the digest it measured, no path — and
steps 2 and 3 compare their own input against it before doing anything else;
step 2 destroys `history-ok.txt` as its first action and writes it again only
past every signal. `SKILL.md > Self-check, part two` gives the three runs (A, B
and C) that demonstrate both, on the vectors in this directory and nothing else.
They are not rows here because a row would have to name two bundles and their
order, and the flat table is worth more than the two extra cases.

The last two rows are the ones worth dwelling on. The incremental bundle is the
only class where the work directory NAMES what is wrong rather than merely
showing it: `prerequisites.txt` gives the commit you are missing, and
`bundle-verify.txt` repeats it. It is also the row that exercises the joint
between steps 2 and 3: `bundle-verify.txt` is written by the redirect that
captures `git bundle verify`, so it is there after the refusal too, and step 3
therefore guards on `history-ok.txt` — the token step 2 writes only past both of
its signals. Run step 3 on this row's work directory and it refuses on that name
before cloning anything. Guarding on `bundle-verify.txt`, as it once did, let
`git clone` run after a refused step 2 and answer with git's own `error:
Repository lacks these prerequisite commits:`. And the foreign bundle passes
three gates —
right digest, complete history, clean clone — and is caught only by comparison
with the reference tree, which is the whole reason step 4 exists. It is also the
only refusal that prints anything: step 4 reports the count first and refuses
after, so a reader gets the number and a caller gets the exit status. Earlier
versions of this package gave only the number, and a caller that composed the
four steps by exit status accepted this bundle.
