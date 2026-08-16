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
| `P0-EVIDENCE-FORMAT.md` | the frozen evidence record, the session record, and the mandatory gates per phase |
| `tools/p0-db-check.ts` | migration and schema checks on a throwaway database, through the repository's own runner |
| `tools/p0-registry-smoke.sh` | Registry API and CLI smoke over the existing public contracts, no SQL |
| `tools/p0-traceability-check.ts` | refuses if any contract requirement is missing from the matrix |
| `tools/p0-secret-scan.sh` | refuses if any evidence artifact carries a credential |

## Running the P0 harnesses

```
export NPM_CONFIG_CACHE=$PWD/.npm-cache          # only if the shared npm cache is unwritable
npm ci
node -e "require.resolve('@typescript/typescript-linux-x64/package.json')"

node --experimental-strip-types --no-warnings v1/tools/p0-db-check.ts
v1/tools/p0-registry-smoke.sh
TZ=<path-to-contract> node --experimental-strip-types --no-warnings v1/tools/p0-traceability-check.ts
v1/tools/p0-secret-scan.sh <evidence-dir>
```

Each harness refuses rather than passes when it cannot reach its subject: a
missing contract path, an occupied port, an unreadable directory. A gate that
reports success having checked nothing is worse than one that is absent, because
only the first is mistaken for coverage.

## Where the evidence goes

Under evidence/<phase>/, which `.gitignore` keeps out of the tree. The
harnesses that produce it are tracked here, so a reviewer regenerates rather than
trusts. The record schema and the directory layout are fixed in
`P0-EVIDENCE-FORMAT.md`.
