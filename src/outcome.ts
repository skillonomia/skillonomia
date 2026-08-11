// D-2 — WHAT SUCCESS IS, AND WHO IS ALLOWED TO SAY IT HAPPENED.
//
// THE DEFECT THIS MODULE EXISTS TO REMOVE. The `outcome_contract` was signed
// correctly and never executed. §4's `outcome` column read `records[].result` —
// a field the REPORTING agent fills in — whenever a boolean said a contract
// existed somewhere. So a principal holding the §6.2 `report_outcome` grant
// declared its own success and the registry printed it, which is exactly what
// [M-6] exists to forbid: the end of a task is the end of its execution, not
// success on the merits.
//
// WHY THIS IS ITS OWN MODULE, with no imports at all. `src/fleet.ts` holds a
// discipline — nothing in it may reach a filesystem, because a V-2 addressee is
// an agent on somebody else's machine and there is no disk of theirs to open
// [M-7]. `src/manifest.ts` reads Appendix E's schema files off disk through
// `ajv`. Putting the contract's shape and its evaluator here lets both import
// them and keeps that discipline exactly where it was.

export const OUTCOME_CHECK_KINDS: readonly string[] = ["exit_code", "stdout_match", "artifact_exists", "command"];

/**
 * THE PARAMETER EVERY KIND OF CHECK NEEDS TO BE EXECUTABLE, and what evidence
 * has to be produced for it to be executed.
 *
 * A `stdout_match` with no pattern, an `artifact_exists` with no path, a
 * `command` with no command and an `exit_code` with no code are not
 * definitions of success. They name a METHOD and withhold its subject, and a
 * registry that accepted one would be signing a document that says nothing
 * while looking as though it says something — which is precisely the class §3
 * calls the main defect.
 *
 * The table is here, in ONE place, because the schema and the reader must not
 * be able to disagree about what a whole contract is: `test/p14-r5-probes` asks
 * both the same question about the same four truncations.
 */
export const OUTCOME_CHECK_SHAPE: Readonly<Record<string, { parameter: string; evidence: string }>> = {
  exit_code: { parameter: "exit_code", evidence: "exit_code" },
  stdout_match: { parameter: "stdout_match", evidence: "stdout" },
  artifact_exists: { parameter: "artifact_path", evidence: "artifacts" },
  command: { parameter: "command", evidence: "exit_code" },
};

export interface OutcomeCheck {
  kind: string;
  exit_code?: number;
  stdout_match?: string;
  artifact_path?: string;
  command?: string;
}

export interface OutcomeContract {
  check: OutcomeCheck;
  /** the named values a run must produce for the check to be executable */
  evidence: string[];
  /** what the absence of evidence means; never "a failure" */
  unknown: string;
}

/** The three answers §4 allows. Repeated here rather than imported, so this
 *  module keeps its promise of having no imports; `src/fleet.ts` declares the
 *  same union and a test asserts the two agree. */
export type OutcomeTrivalent = "yes" | "no" | "unknown";

/**
 * THE EVALUATOR. Deterministic, total, and it never reads what anybody claimed.
 *
 * Its inputs are the SIGNED contract and the EVIDENCE a run produced. It
 * answers `yes` only where the contract's own `check` was executed and
 * satisfied, `no` only where it was executed and not satisfied, and `unknown`
 * — with a reason naming what was missing — everywhere else. There is no path
 * through it that reaches `yes` or `no` without running the check, which is
 * what makes "a principal cannot declare its own success" a property of the
 * code instead of a sentence about it.
 *
 * WHAT "EXECUTES" MEANS HERE, precisely, because the word could be read as
 * running a shell and this registry runs nothing. The check is executed AGAINST
 * THE EVIDENCE: `exit_code` compares the code the run reported to the code the
 * contract requires; `stdout_match` tests the contract's pattern against the
 * output the run produced; `artifact_exists` looks for the contract's path in
 * the artifact list the run presented; `command` requires the evidence to name
 * the very command the contract names and that command to have exited 0. The
 * registry never opens a path a caller named and never spawns anything [M-7] —
 * a V-2 addressee is on somebody else's machine and there is nothing to spawn.
 * What it does is decide, deterministically, from values it was given, and
 * refuse to decide when it was not given them.
 */
export interface OutcomeVerdict {
  value: OutcomeTrivalent;
  reason: string;
}

export function evaluateOutcome(contract: unknown, evidence: unknown): OutcomeVerdict {
  if (contract === null || contract === undefined) return { value: "unknown", reason: "no_outcome_contract" };
  const c = contract as OutcomeContract;
  const shape = OUTCOME_CHECK_SHAPE[c?.check?.kind as string];
  if (!shape) return { value: "unknown", reason: "outcome_contract_names_no_deterministic_check" };
  if (evidence === null || evidence === undefined || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { value: "unknown", reason: "no_evidence_so_the_check_was_never_executed" };
  }
  const values = evidence as Record<string, unknown>;

  // EVERY VALUE THE CONTRACT NAMED, and then the one the check needs. The
  // contract's `evidence` list is the author's statement of what a run must
  // present; the check's own input is what this function cannot proceed
  // without. Both are required, and a missing one is `unknown` with the NAME of
  // what was missing — never a `no`.
  for (const named of c.evidence ?? []) {
    if (!(named in values)) return { value: "unknown", reason: `evidence_missing:${named}` };
  }
  if (!(shape.evidence in values)) {
    return { value: "unknown", reason: `evidence_missing:${shape.evidence}_so_the_check_was_never_executed` };
  }

  const satisfied = executeCheck(c.check, values);
  if (satisfied === null) return { value: "unknown", reason: "evidence_is_not_of_the_shape_the_check_reads" };
  return satisfied
    ? { value: "yes", reason: "contract_satisfied" }
    : { value: "no", reason: "contract_not_satisfied" };
}

/** The four checks, executed against evidence. `null` = the evidence is not of
 *  a shape this check can read, which is not a failure of the run. */
function executeCheck(check: OutcomeContract["check"], values: Record<string, unknown>): boolean | null {
  switch (check.kind) {
    case "exit_code": {
      const observed = values.exit_code;
      if (!Number.isInteger(observed)) return null;
      return observed === check.exit_code;
    }
    case "stdout_match": {
      const observed = values.stdout;
      if (typeof observed !== "string") return null;
      return observed.includes(String(check.stdout_match));
    }
    case "artifact_exists": {
      const observed = values.artifacts;
      if (!Array.isArray(observed) || !observed.every((a) => typeof a === "string")) return null;
      return (observed as string[]).includes(String(check.artifact_path));
    }
    case "command": {
      // THE COMMAND THE CONTRACT NAMES, AND NO OTHER. Accepting an exit code
      // without checking WHICH command produced it would let a run present the
      // status of something else entirely.
      if (values.command !== check.command) return null;
      const observed = values.exit_code;
      if (!Number.isInteger(observed)) return null;
      return observed === 0;
    }
    default:
      return null;
  }
}
