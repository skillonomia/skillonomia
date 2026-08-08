// §4.4 over a package (directory / .tar / .tar.gz) against a registry
// database — the logic behind `skillonomia verify`.
//
// This module decides ONLY the verdict. Argument parsing, output format and
// exit codes belong to src/cli-commands.ts, which is the single command-line
// entry point; keeping them apart is what let `verify` grow a `--json` form
// without touching the algorithm.
import { openMigrated } from "./db.ts";
import { readPackage, ArchiveError } from "./archive.ts";
import { verifyPackage, type VerifyOutcome } from "./verify.ts";

/**
 * §4.4.8 verdicts that are a WARNING rather than a failure: the signature, the
 * kid binding and the integrity list all check out, and the registry merely has
 * something to say about the version's lifecycle or the key's later fate. The
 * CLI exits 0 on these — a caller that wants to reject them reads the verdict.
 */
export const WARNING_VERDICTS: readonly string[] = [
  "valid_superseded",
  "valid_deprecated",
  "valid_but_key_since_revoked",
];

/**
 * What the CLI reports. It is §4.4's own outcome, widened by the two §4.1b
 * archive-profile refusals: an unreadable or oversized archive stops the
 * algorithm before step 1, so it has no §4.4.8 verdict of its own and is
 * reported under the Appendix H code that named it.
 */
export interface CliVerifyOutcome extends Omit<VerifyOutcome, "verdict"> {
  verdict: VerifyOutcome["verdict"] | ArchiveError["code"];
}

export interface PackageVerification {
  outcome: CliVerifyOutcome;
  /** verdict `valid`, or one of WARNING_VERDICTS */
  ok: boolean;
  warning: boolean;
}

/** Verify the package at `pkg` against the registry database at `dbPath`. */
export function verifyPackageAt(pkg: string, dbPath: string): PackageVerification {
  let outcome: CliVerifyOutcome;
  try {
    const files = readPackage(pkg);
    const db = openMigrated(dbPath);
    try {
      outcome = verifyPackage(files, db);
    } finally {
      db.close();
    }
  } catch (e) {
    // A malformed or oversized archive is a VERDICT of the §4.1b profile, not
    // a crash: it is reported in the same envelope as every other outcome.
    if (!(e instanceof ArchiveError)) throw e;
    outcome = { verdict: e.code, detail: e.message };
  }
  const warning = WARNING_VERDICTS.includes(outcome.verdict);
  return { outcome, ok: outcome.verdict === "valid" || warning, warning };
}
