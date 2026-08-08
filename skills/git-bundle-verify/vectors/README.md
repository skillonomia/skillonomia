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
| `corrupt.bundle`, `good.bundle`'s digest | step 1 | exit non-zero, stdout empty |
| `corrupt.bundle`, its own digest | step 3 | `error: inflate: data stream error …` |
| `truncated.bundle`, `good.bundle`'s digest | step 1 | exit non-zero, stdout empty |
| `truncated.bundle`, its own digest | step 3 | `fatal: early EOF` |
| `incremental.bundle`, its own digest | step 2 | exit non-zero; `prerequisites.txt` NOT empty |
| `foreign.bundle`, its own digest | step 4 | exit non-zero, and `divergences 1` on stdout — the count survives the refusal because it IS the finding |

The last two rows are the ones worth dwelling on. The incremental bundle is the
only class where the work directory carries a positive diagnosis rather than
just a refusal: `prerequisites.txt` names the commit you are missing, and
`bundle-verify.txt` repeats it. And the foreign bundle passes three gates —
right digest, complete history, clean clone — and is caught only by comparison
with the reference tree, which is the whole reason step 4 exists. It is also the
only refusal that prints anything: step 4 reports the count first and refuses
after, so a reader gets the number and a caller gets the exit status. Earlier
versions of this package gave only the number, and a caller that composed the
four steps by exit status accepted this bundle.
