# Contributing

**This repository is a read-only mirror for now.**

The source is published under Apache-2.0 so that the package format, the signing
profile and the verification algorithm can be read, checked and implemented
independently. Development happens elsewhere, and this repository is a curated
snapshot of it.

## What that means in practice

- **Pull requests will not be merged.** We are not set up to review, accept or
  maintain external contributions yet, and leaving PRs open while that is true
  would waste your time. If you open one, expect it to be closed with a pointer
  to this file — that is not a judgement of the work.
- **Issues may not get a timely answer.** There is no support commitment and no
  response-time target attached to this release.
- **The mirror may be force-updated.** Snapshots are curated, so the published
  history is not the development history and will not always be a fast-forward.

## What is useful right now

- **Implement the specification.** `SPEC.md` is written to be implementable
  without reading this codebase. The test vectors in `vectors/` and the executed
  byte-level vector in `SPEC.md` Appendix F exist so that an independent
  implementation can prove it produces identical signatures and identical
  verdicts.
- **Report a specification defect.** If `SPEC.md` is ambiguous, contradicts the
  code, or is impossible to implement as written, that is worth telling us about
  even without a fix. Include the section and what two readings you had to
  choose between.
- **Report a security issue privately.** See `SECURITY.md` — not through a
  public issue.

## If that changes

If contributions open up, this file changes first: it will state the licence
terms contributions are accepted under, the review process, and who signs off.
Until then, treat the absence of those things as deliberate rather than as an
oversight.
