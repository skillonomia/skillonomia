# Security Policy

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: open this
repository's **Security** tab and choose **Report a vulnerability**. The report
is visible only to the maintainers of this repository, it does not create a
public issue, and it does not appear in the issue list.

That is the only channel. There is deliberately no email address in this file.
A mailbox nobody has committed to monitoring turns a report into a report the
reporter believes was received, which is worse than naming no address at all.
Private reporting goes to the people who can act on it and to nobody else.

**Acknowledgement.** Best effort, targeting seven days to confirm the report has
been read. That is an acknowledgement target, not a remediation target. See
*Supported versions*: no version carries a patch SLA, and a confirmed defect
may be answered with "yes, and it is not being fixed at this version."

**Please do not** describe an exploitable defect in a public issue, a discussion
or a pull request. If private reporting is not available to you, hold the report
rather than publishing it.

## Supported versions

`0.1.0` is published and is source only. Version `0.1.6` is the version this
tree declares; the release tagged `v0.1.6` carries a Linux x86_64 binary and its
checksum alongside the source, and the same version is published as
`@skillonomia/cli` on npm and as a tag of the container image
`ghcr.io/skillonomia/skillonomia`. `v0.1.0` is refused by name, so the published
source-only release is never amended. Every version between the baseline and
the one this tree declares is published history and carries the same absence of
commitment as the two rows below. There is **no security maintenance
commitment** at any version: no backport policy, no patch SLA, and no advisory
feed. Only the tip of the published branch is looked at.

| Version | Supported |
|---|---|
| `0.1.0` | source published; no maintenance commitment |
| `0.1.6` | what `v0.1.6` carries — source, a Linux x86_64 binary, `@skillonomia/cli` on npm and a tag of `ghcr.io/skillonomia/skillonomia`; no maintenance commitment |
| the unscoped `skillonomia` package on npm | a name-holding placeholder under the same npm account — not this software, and out of scope here |

## Scope — what a security report would be about

The parts of this system that make a security claim at all, and where a defect
in them would matter:

- **The signing and verification profile** (`SPEC.md` §4.3, §4.4). A package
  that verifies as `valid` while its bytes, its manifest, its author binding or
  its transparency-log entry do not actually hold. Signature malleability,
  canonicalisation mismatches, and `kid`-to-author confusion all land here.
- **The archive profile** (`SPEC.md` §4.1b). Any path that escapes the extraction
  root, any symlink or hardlink surviving verification, any collision the profile
  claims to reject, and any resource-exhaustion input passing the enumerated
  limits.
- **Tenancy and access control** (`SPEC.md` §5.1, §6). Reading or adopting a
  version the visibility table and `access_policy` do not permit; acting as an
  agent other than the authenticated one; escalating a role through a payload
  field.
- **Receipt integrity** (`SPEC.md` §5.3). Writing to a receipt you do not own,
  backdating or reordering a chain, mutating or deleting an INSERT-only row, or
  reaching two terminal events on one receipt.
- **The human-approval matrix** (`SPEC.md` §7.3). Adopting or publishing a
  high-risk package without the approval it requires, or replaying one approval
  against a different adoption request.
- **Transparency log integrity.** A chain that `verify-log` accepts after an
  entry has been altered, removed or inserted.

## Out of scope — stated plainly, not to deflect

These are not vulnerabilities in this software, because it does not claim to
prevent them. They are documented in the README's boundaries section.

- **A verified package doing something harmful when executed.** `verified` is a
  provenance and process statement, not a safety judgement. A signed, reviewed,
  receipt-backed package whose runbook destroys your infrastructure is working
  as specified.
- **Escaping a sandbox.** There is no runtime sandbox. `sandbox_requirement` is
  a declared field and `skill.adopt` refuses high-risk handover to an adopter
  that does not attest capability — the enforcement is entirely on your side.
- **A gate not catching a construct it does not enumerate.** The eight gates are
  deny-by-default within their scope (`SPEC.md` §7.1). A dangerous shell command
  or URL from a class the gates *do* enumerate slipping through is in scope; a
  novel class they never claimed to cover is not.
- **Copying a package after delivery.** Once handed over, a package is bytes on
  the adopter's machine. Revocation changes what the registry answers, not what
  someone already holds.
- **A deployment somebody is running, the owner's own included.** One exists: a
  private pilot at `registry.skillonomia.ai`, which answers `/health` with the
  version it runs and refuses everything else without a key. It is not a service
  this project offers, takes sign-ups for, or invites reports about, and it
  carries no uptime and no response commitment. What this policy answers for is
  the code in this repository and the artifacts a release publishes: a defect
  you can reproduce against those is in scope wherever you happened to see it.
  The pilot itself — its availability, its data, its configuration — is outside
  that, and it is not a host to point a scanner at.

## What a good report contains

The offending input or request sequence, the observed result, the result
`SPEC.md` requires, and the commit you saw it on. A failing test case against
this repository's suite is the most useful form — the vectors in `vectors/` show
the shape.
