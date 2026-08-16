# `v1/` — the V1 → FINAL DONE working record

Working documents and harnesses for the contract *Skillonomia V1 → FINAL DONE*.
Nothing here is product code, nothing here is shipped by `npm pack`, and nothing
here changes the behaviour of the registry.

Phase P0 is an **adoption** phase: it accepts an exact base commit, records what
the repository already is, fixes the threat model, the evidence format and the
mandatory gates, and adds the reproducibility plumbing later phases need. It
implements no product behaviour (`P0-FR-08`).

| file | what it is |
|---|---|
| `P0-BASELINE.md` | the accepted base, the measured toolchain, the repo-native commands with their exit codes, the surface inventory, and how to bring up a disposable database and a local environment |
| `P0-TRACEABILITY.md` | every `INV-*` and `P*-FR-*` of the contract mapped to surface, check and phase |
| `P0-THREAT-MODEL.md` | the frozen V1 threat model, and what it means for a finding |
| `P0-EVIDENCE-FORMAT.md` | the frozen evidence record, the session record, the mandatory gates per phase with a command each, and the append-only rule |
| `P0-BRANCH-HISTORY.md` | the branch's history, the one rewrite that happened, and the audit boundary of P0 |
| `P2-OWNER-CONSOLE.md` | what P2 built — the browser session, the Inbox, the detail, approve/edit/reject, and what the session and the eligibility rule do and do not claim |
| `P1-CAPTURE-DRAFT.md` | what P1 built — the capture/draft path, where each `P1-FR-*` is met, what the classifier and the redactor do and do not claim, and how the schema change comes back out |
| `P0-RESIDUAL-LIMITATIONS.md` | what P0 leaves permanently unprovable, carried forward to the final report rather than forgotten |
| `append-only-baseline.tsv` | the disclosed non-append-only reflog entries — the only ones the append-only check excuses |
| `tools/p0-db-check.ts` | migration and schema checks on a throwaway database, through the repository's own runner |
| `tools/p0-registry-smoke.sh` | Registry API and CLI smoke over the existing public contracts, no SQL |
| `tools/p0-traceability-check.ts` | refuses if any contract requirement is missing from the matrix |
| `tools/p0-secret-scan.sh` | refuses if any evidence artifact carries a credential |
| `tools/p0-evidence-check.ts` | refuses on an incomplete run record, an invented session id, a role under the wrong model contract, or an artifact under `logs/` that no record owns |
| `tools/p0-gate-table-check.ts` | refuses if a mandatory gate is missing, renamed or downgraded, if a row has no runnable command, or if an N/A cell has no justification |
| `tools/p0-append-only-check.sh` | refuses on an undisclosed amend, rebase, reset or non-fast-forward move of the branch |
| `tools/p0-negative-probes.sh` | runs every validator against a deliberately damaged copy and fails unless each one refuses, for the stated reason |
| `tools/gates/` | one entry point per mandatory gate category. P0 left two real and seven executable interfaces; P1 implemented the reversible-migration round trip and the `v0.1.6` upgrade, and P2 implemented the browser E2E |
| `tools/e2e/console-e2e.mjs` | the browser run `tools/gates/browser-e2e.sh` drives: Chromium through Playwright against a real deployment |

## Running the P0 harnesses

```
export NPM_CONFIG_CACHE=$PWD/.npm-cache          # only if the shared npm cache is unwritable
npm ci
node -e "require.resolve('@typescript/typescript-linux-x64/package.json')"

node --experimental-strip-types --no-warnings v1/tools/p0-db-check.ts
v1/tools/p0-registry-smoke.sh
TZ=<path-to-contract> node --experimental-strip-types --no-warnings v1/tools/p0-traceability-check.ts
v1/tools/p0-secret-scan.sh <evidence-dir>
node --experimental-strip-types --no-warnings v1/tools/p0-evidence-check.ts <evidence-dir>
node --experimental-strip-types --no-warnings v1/tools/p0-gate-table-check.ts
v1/tools/p0-append-only-check.sh
v1/tools/p0-negative-probes.sh <evidence-dir> <workdir>
v1/tools/gates/registry-compat.sh
v1/tools/gates/security-regression.sh
```

The harnesses under `tools/gates/` share one exit-code contract: `0` passed, `1`
failed, `2` refused — could not reach its subject, and `3` not implemented for
this phase. Everything except `0` is a non-zero exit, so a gate that has not been
built yet cannot be mistaken for one that passed.

Each harness refuses rather than passes when it cannot reach its subject: a
missing contract path, an occupied port, an unreadable directory. A gate that
reports success having checked nothing is worse than one that is absent, because
only the first is mistaken for coverage.

## Where the evidence goes

Under evidence/<phase>/, which `.gitignore` keeps out of the tree. The
harnesses that produce it are tracked here, so a reviewer regenerates rather than
trusts. The record schema and the directory layout are fixed in
`P0-EVIDENCE-FORMAT.md`.
