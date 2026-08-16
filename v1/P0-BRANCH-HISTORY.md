# P0 — branch history, and the one rewrite that happened

P0 REVIEW-1 raised finding `P0-R1-001`: BUILD-1 rewrote history with
`git commit --amend`, and the forbidden-actions log it wrote said no history
rewrite had occurred. Both halves were true findings. This document is the
accurate record, and section 5 of `v1/P0-EVIDENCE-FORMAT.md` is the rule that
stops it recurring.

## 1. What happened

BUILD-1 committed, then amended that commit 2 minutes 54 seconds later.

| | |
|---|---|
| branch | `v1-final-integration` |
| pre-amend commit | `c9606ac4adb9d4aad3f3e362453c115967707042` |
| post-amend commit | `3927571a8349e215aff096ee3ac58135435f4b51` |
| first commit written | 2026-08-16T16:29:15Z |
| amend written | 2026-08-16T16:32:09Z |
| operation recorded by git | `commit (amend)` |
| file changed by the amend | `v1/tools/p0-secret-scan.sh`, +38 / −2, one file |
| commit message | unchanged by the amend |
| pre-amend commit still reachable | yes — `git cat-file -e c9606ac4^{commit}` succeeds, and the object is named by the reflog |

The amend replaced the scanner's excuse list with the narrowed
`pinnedFixture`-digest form described in that file's own header. No other path
differs between the two commits.

## 2. What did NOT happen

These are stated separately from section 1 because a rewrite is not one event
but a family, and only one member of the family occurred.

* No `git push` and no force-push. This clone has no push credential, and
  `origin/main` still points at the base commit.
* No rebase, no `filter-branch`, no destructive `git reset`.
* No branch or tag was deleted or moved. `main` and all seven tags are
  byte-identical to their state before the work.
* **No object was destroyed.** `c9606ac4…` is still in this repository and still
  reachable through the reflog. Nothing that a reviewer could have been handed
  has become unavailable; a reviewer given the pre-amend SHA can still check it
  out and diff it.

## 3. The audit boundary of P0

P0's audit boundary is **the branch reflog plus the run records** — that pair,
and not the commit graph alone.

The reason is structural rather than rhetorical. A commit graph shows where a
branch *is*; it cannot show where a branch *has been*, so an amend is invisible
in it. `git log` on this branch shows one clean commit on top of the base and
would have shown exactly that whether or not BUILD-1 amended. The reflog is the
only local artefact that records the move, which is how REVIEW-1 found it, and
run records in evidence/P0/runs.jsonl are the only artefact that says which
commands actually ran and what they returned. Anything asserted about P0 that
neither of those two supports is an assertion, and should be read as one.

The consequence a reviewer should draw: this boundary does not travel. A fresh
clone has no reflog, so section 4 commits the bytes.

## 4. The reflog, as it stood when this was written

Raw form, from `.git/logs/refs/heads/v1-final-integration` — oldest first, and
verbatim apart from the committer identity, which is `Skillonomia
<noreply@skillonomia.dev>` on both commits and `node <node@…>` on the branch
creation.

```
0000000000000000000000000000000000000000 eeefbe66098d6f93807383480790f9800335b516 1786896554 +0000	branch: Created from eeefbe66098d6f93807383480790f9800335b516
eeefbe66098d6f93807383480790f9800335b516 c9606ac4adb9d4aad3f3e362453c115967707042 1786897755 +0000	commit: a baseline is the one phase that may only describe, …
c9606ac4adb9d4aad3f3e362453c115967707042 3927571a8349e215aff096ee3ac58135435f4b51 1786897929 +0000	commit (amend): a baseline is the one phase that may only describe, …
```

Three entries: the branch creation from the phase base, BUILD-1's commit, and
BUILD-1's amend of it. The FIX-1 commit that carries this document is written
after this snapshot and therefore appears above these lines in the live reflog,
never among them. The live reflog at the FIX-1 SHA is captured in full at
evidence/P0/10-branch-reflog.txt.

## 5. Why the lineage was not rebuilt in a fresh repository

REVIEW-1's suggested remedy was to rebuild the P0 lineage in a fresh repository
so that no amend appears in it. That remedy was rejected, and the reason is that
it is the same act as the finding: replacing the history a reviewer was handed
with a tidier one. It would also destroy `c9606ac4…`, which today is merely
disclosed. Contract section 8 point 10 allows a finding to be closed either by
strengthening the mechanism or by honestly narrowing the claim while preserving
the invariant, and here both were done — the claim was corrected (this document
and evidence/P0/05-forbidden-actions-log.md) and the mechanism added
(`v1/tools/p0-append-only-check.sh`).

## 6. The rule from here

Stated in full in `v1/P0-EVIDENCE-FORMAT.md` section 5 and enforced by
`v1/tools/p0-append-only-check.sh`:

> Every BUILD and FIX session of this contract lands its work as new commits. No
> `--amend`, no rebase, no reset, no non-fast-forward move of an integration
> branch.

The check reads the branch reflog and fails on any move that is not a
fast-forward, and on any entry whose recorded operation is an amend, a rebase, a
reset or a `filter-branch` — two independent detectors, because a rewrite can be
a fast-forward and a rewrite's message can say nothing. The single pre-existing
entry above is disclosed in the tracked file `v1/append-only-baseline.tsv`, and
only entries listed there are excused. Disclosure is checked both ways: an
undisclosed rewrite fails, and a disclosure matching no real reflog entry also
fails, so the file cannot become a blanket permission. A disclosed entry whose
pre-rewrite commit has stopped being reachable fails too.

FIX-1 proved the check on a throwaway branch rather than asserting it. The
branch `p0-append-only-negative-probe` — created from the phase base, never
merged, and left in place so the probe can be re-run — carries an undisclosed
amend and then a non-fast-forward `update-ref` whose message names no known
operation. The check fails on both, one per detector. The transcript is at
evidence/P0/11-append-only-check.txt.
