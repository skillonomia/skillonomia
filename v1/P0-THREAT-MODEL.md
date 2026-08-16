# P0 — Frozen V1 threat model

Deliverable 4 of P0, satisfying `P0-FR-07`. This is the contract's section 6 threat
model, frozen for V1. It adds nothing and removes nothing.

The point of freezing it is procedural as much as technical. Contract section 8.9 lets
a security finding block a phase **only** when it is a reproducible violation of
something inside this model. A finding outside it is non-blocking backlog. So
the boundary has to be written down once, before any phase is reviewed, rather
than argued about per review.

## In the model

Each item is paired with the invariant or requirement that carries it, so a
finding can be anchored rather than asserted.

| # | Threat | Anchored to |
|---|---|---|
| T-01 | Untrusted or erroneous capture/import content | `P1-FR-10` structured refusal; `P1-FR-06`/`P1-FR-07` previews |
| T-02 | Accidentally pasted credentials, tokens and private values | `P1-FR-08`, `P1-FR-09`, `P4-FR-15` |
| T-03 | Malformed native skill | `P1-FR-10` |
| T-04 | Path traversal, unsafe filename and symlink escape during runtime materialisation | `P4-FR-14` |
| T-05 | XSS through draft content | `P2-FR-06` |
| T-06 | Unauthorised access to the Owner Console | `INV-04`, `P2-FR-01`, `P2-FR-02` |
| T-07 | CSRF and replay of mutating requests | `INV-04`, `P2-FR-13`, `P3-FR-09` |
| T-08 | Repeated lifecycle commands | `P3-FR-09`, `P3-FR-10` |
| T-09 | Stale concurrent updates | `P3-FR-11`, `P3-FR-12` |
| T-10 | Desired state passed off as observed | `INV-02`, `P3-FR-06`, `P4-FR-09`, `P5-FR-02` |
| T-11 | Incomplete, lost or contradictory runtime receipts | `INV-03`, `P4-FR-11`, `P5-FR-04`, `P5-FR-06`, `P5-FR-07` |
| T-12 | An attempt to load an unapproved or revoked revision | `P4-FR-04` |
| T-13 | Secret leakage through browser storage, audit, logs or evidence | `INV-04`, `P1-FR-08`, `P2-FR-14`, `P4-FR-15` |

## Out of the model

* Public multi-tenant SaaS.
* Federation and marketplace trust.
* Compromise of provider infrastructure.
* A full OS sandbox for arbitrary malicious code.
* External users and internet-scale abuse.
* Enterprise IAM and complex RBAC.
* Any hardening not tied to an explicit V1 invariant.

A reviewer asking for work from this list is asking for out-of-scope hardening,
which contract section 8.1 says does not invalidate a `PASS`.

## What this means for a finding

A blocking security finding must, per contract section 8.2, carry a unique ID, the exact
SHA, the violated requirement or invariant ID, the precise object (file, API or
UI path), reproduction steps, expected and actual result, its real impact inside
V1, and the check that closes it. A finding missing these cannot block a phase.

A finding may be closed two ways (section 8.10 of the contract): strengthen the mechanism, or honestly
narrow the claim while preserving the invariant. Building a general-purpose
parser, framework or abstraction "for later" is not an available answer.

## Baseline security posture at the base commit

Recorded so later phases measure change rather than re-litigate the starting
point. These are observations of the tree, not claims that the model is
satisfied.

* Authentication is bearer API key → SHA-256 → `api_keys`; the acting agent
  comes only from the resolved auth context, never from a request payload.
  Rejections are uniform `UNAUTHORIZED`, so a caller cannot distinguish an
  unknown key from a revoked one.
* An unauthenticated read of a protected route returns `401` (measured;
  evidence/P0/logs/registry-smoke.log).
* The two first-start credentials are printed once. The bootstrap token is not
  an API key: it is exchanged once for the owner key and dies.
* **There is no browser session mechanism at the base**, so `INV-04` is
  unimplemented rather than violated. Nothing in the tree sends a credential to
  a browser because nothing in the tree serves a browser session. P2 owes this
  invariant in full.
* `src/fleet.ts` already refuses to promote absence into success: `unknown` is a
  value, `loaded` is never claimed as `yes` on either runtime, and
  `src/fleet-dashboard.ts` re-audits finished HTML and JSON to catch a template
  that claims otherwise. This is the machinery `INV-02`, `INV-03` and `T-10`
  depend on, and it exists before P3 needs it.
* `src/fleet.ts` imports neither `node:fs` nor `node:path`; filesystem access is
  confined to `src/fleet-scan.ts`. That containment is what makes `T-04` a
  bounded surface, and a later phase that widens it owes a traversal test.
* No down-migration exists. `T-11`-adjacent recovery at the base is
  restore-from-copy. Later schema-changing phases owe reversibility evidence
  (contract section 2).
