#!/usr/bin/env node
// `P0-FR-03` — every normative requirement of the contract appears in the
// traceability matrix.
//
//   TZ=/path/to/TZ.md node --experimental-strip-types --no-warnings v1/tools/p0-traceability-check.ts
//
// The contract text lives OUTSIDE this repository: it is the working document of
// a build, not a file the product ships, and committing it would put a
// specification the repository does not implement yet into the tree every
// documentation guard reads. So the path is given, and a missing path is a
// refusal rather than a pass — a completeness check that cannot read its subject
// has checked nothing, and saying so is the only honest outcome.
//
// The comparison is deliberately dumb: extract every `INV-nn` and every
// `P<n>-FR-nn` identifier from each document, and report identifiers the
// contract has that the matrix has not. It cannot tell whether a row is any
// GOOD — no automated check can — but it can prove that no requirement was
// dropped, which is the property `P0-FR-03` actually names.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MATRIX = join(REPO, "v1", "P0-TRACEABILITY.md");

const contractPath = process.env.TZ ?? process.argv[2];
if (!contractPath) {
  console.error(
    "REFUSED: no contract path. Pass it as TZ=<path> or as the first argument.\n" +
      "A completeness check with no subject would report success having compared nothing.",
  );
  process.exit(2);
}
if (!existsSync(contractPath)) {
  console.error(`REFUSED: the contract was not found at ${contractPath}.`);
  process.exit(2);
}

const ID = /\b(INV-\d{2}|P\d-FR-\d{2})\b/g;
const idsIn = (text: string): Set<string> => new Set(text.match(ID) ?? []);

const contractIds = idsIn(readFileSync(contractPath, "utf8"));
const matrixIds = idsIn(readFileSync(MATRIX, "utf8"));

if (contractIds.size === 0) {
  console.error(`REFUSED: no requirement identifier was found in ${contractPath}. An empty subject is not a passing subject.`);
  process.exit(2);
}

const missing = [...contractIds].filter((id) => !matrixIds.has(id)).sort();
const extra = [...matrixIds].filter((id) => !contractIds.has(id)).sort();

console.log(`contract: ${contractPath}`);
console.log(`identifiers in the contract: ${contractIds.size}`);
console.log(`identifiers in the matrix:   ${matrixIds.size}`);

// An identifier the matrix has and the contract has not is reported but does not
// fail: `P0-FR-03` is about nothing being DROPPED. A superset is a documentation
// question, and failing on it would give a future build a reason to delete rows.
if (extra.length) console.log(`in the matrix but not in the contract (reported, not fatal): ${extra.join(", ")}`);

if (missing.length) {
  console.error(`\nFAIL  ${missing.length} requirement(s) in the contract are absent from the matrix:`);
  for (const id of missing) console.error(`  - ${id}`);
  process.exit(1);
}
console.log("\nPASS  every requirement identifier in the contract appears in v1/P0-TRACEABILITY.md");
