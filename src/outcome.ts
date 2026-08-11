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
export const OUTCOME_CHECK_SHAPE: Readonly<Record<string, { parameter: string; evidence: string; reads: readonly string[] }>> = {
  exit_code: { parameter: "exit_code", evidence: "exit_code", reads: ["exit_code"] },
  stdout_match: { parameter: "stdout_match", evidence: "stdout", reads: ["stdout"] },
  artifact_exists: { parameter: "artifact_path", evidence: "artifacts", reads: ["artifacts"] },
  command: { parameter: "command", evidence: "exit_code", reads: ["command", "exit_code"] },
};

/**
 * THE NAMED VALUES A CHECK OF THIS REGISTRY READS — every one of them, and no
 * other. `reads` above is the per-kind list; this is their union.
 *
 * It exists because [I-7]'s boundary needs a SET OF ADMISSIBLE NAMES and the
 * only honest source for one is the code that consumes them. Written out as a
 * literal at the boundary it would be a second list, free to disagree with
 * `executeCheck` the moment a kind is added; derived here it cannot. The probe
 * closes the remaining gap in the other direction: it executes all four checks
 * against a recording proxy and asserts the names they actually touch are
 * exactly this set, so a kind that starts reading a fifth value fails a test
 * rather than silently narrowing what a report may present.
 *
 * WHAT IS NOT HERE, deliberately: `stdout_match`, `artifact_path` and the
 * `exit_code` of a `check` are the CONTRACT's parameters — what the author
 * demanded — and not values a run produces. A report presents the second kind.
 */
export const EVIDENCE_NAMES: readonly string[] = [
  ...new Set(Object.values(OUTCOME_CHECK_SHAPE).flatMap((s) => s.reads)),
].sort();

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

/**
 * The three principal types `0001_init.sql` allows. Repeated rather than
 * imported, so this module keeps its promise of having none; a test asserts the
 * two agree.
 */
export type PrincipalType = "human" | "agent" | "service";

/**
 * A VERDICT WITH ITS PROVENANCE — [I-3] applied to the one number that shipped
 * without any.
 *
 * §4's `outcome` was the last value in this product published as a bare answer.
 * Every other number here carries its state, its source and its boundary; this
 * one said `yes` and left a reader to assume the registry had checked.
 *
 * D-18 settled what it must say instead, and the three attributes are its three
 * sentences:
 *
 *   * `assessed_by` — WHOSE values decided it. `registry` where the deciding
 *     evidence is something this registry observed itself; `principal` where it
 *     is what an agent reported about its own machine.
 *   * `principal_type` — WHICH KIND of principal reported, out of the three
 *     `agents.type` allows [I-5]. `null` where nothing was reported.
 *   * `basis` — whether this is a SELF-REPORT or an OBSERVATION. It is the same
 *     fact as `assessed_by` under the name a reader needs, and the two cannot
 *     disagree because one is computed from the other, four lines below. Both
 *     are published because D-18 requires both to be printed and because the
 *     panel colours one and reads the other.
 *
 * And one more, which is not provenance but its consequence:
 *
 *   * `claim` — WHAT THE SELF-REPORT AMOUNTS TO, if it were believed. This is
 *     how a self-report is published LOUDLY rather than swallowed: the reader
 *     sees `unknown`, sees that a principal claimed `yes`, and sees that the
 *     registry did not check it. `null` where there is no claim to speak of.
 */
export interface OutcomeAssessment extends OutcomeVerdict {
  assessed_by: "registry" | "principal";
  principal_type: PrincipalType | null;
  basis: "registry_observation" | "self_report";
  claim: OutcomeTrivalent | null;
}

/** The one place `basis` comes from, so the two names are one fact. */
function basisOf(assessedBy: OutcomeAssessment["assessed_by"]): OutcomeAssessment["basis"] {
  return assessedBy === "registry" ? "registry_observation" : "self_report";
}

export interface OutcomeInputs {
  contract: unknown;
  /** the named values a PRINCIPAL presented about its own machine */
  claimed: unknown;
  /** the named values THIS REGISTRY produced by looking itself, or `null` */
  observed: unknown;
  /** the principal that reported, for its type [I-5]. `null` where none did */
  principal: { type: PrincipalType } | null;
}

/**
 * THE PUBLISHED VERDICT — what §4's column says, and on whose authority.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A CHANGE TO `evaluateOutcome`. The two
 * answer different questions. `evaluateOutcome` answers "does this evidence
 * satisfy this contract" — a pure, total function of two documents, and the
 * thing D-14 asked for. This one answers "what may the registry PUBLISH", which
 * needs one fact `evaluateOutcome` has no business knowing: WHERE THE EVIDENCE
 * CAME FROM.
 *
 * D-18 IS THE REQUIREMENT CHANGE THIS IMPLEMENTS, and it is worth stating why
 * the requirement moved rather than the code. D-14 said the evaluator EXECUTES
 * the `check`. [M-7] says this registry does not assume access to the
 * addressee's machine. For a remote addressee those two are not both
 * satisfiable: `exit_code`, `stdout` and `command` are facts about a process on
 * somebody else's computer, and nothing this registry can do will make them its
 * own observations. The registry not running processes on other people's
 * machines is a PROPERTY OF THE PRODUCT.
 *
 * So the split is by WHAT THE REGISTRY CAN CONFIRM:
 *
 *   * evidence the registry produced itself — today, exactly one thing: whether
 *     an artifact is present under the activation root THIS REGISTRY writes to
 *     and can read back (work 5, D-7) — decides a real `yes` or `no`, attributed
 *     to the registry.
 *
 *   * evidence a principal presented is a SELF-REPORT. The contract is still
 *     executed against it, because what the self-report AMOUNTS TO is worth
 *     publishing, but the published verdict is `unknown` with a reason that says
 *     it was not verified here, and the claim rides beside it under its own
 *     name. `{"command":"false","exit_code":0}` is the case that makes this
 *     obvious: `false` exits 1 on every machine there is, the report says 0, and
 *     a registry that answered `yes` to that would be certifying a lie it has no
 *     way to detect. [M-6] is kept whole — a task that finished is not a task
 *     that succeeded, and neither is a task whose runner says it succeeded.
 *
 *   * `unknown` with a reason stays for everything else: no contract, no
 *     evidence, evidence of a shape the check cannot read.
 *
 * [I-1] IS NOT WEAKENED. The verdict is still one of three values. Provenance is
 * attributes BESIDE it, exactly as it is for every counted number in this
 * product, and never a fourth answer.
 */
export function assessOutcome(input: OutcomeInputs): OutcomeAssessment {
  const principalType = input.principal?.type ?? null;
  const registry = (v: OutcomeVerdict, claim: OutcomeTrivalent | null = null): OutcomeAssessment => ({
    ...v,
    assessed_by: "registry",
    principal_type: principalType,
    basis: basisOf("registry"),
    claim,
  });

  if (input.contract === null || input.contract === undefined) {
    return registry({ value: "unknown", reason: "no_outcome_contract" });
  }

  // WHAT THE REGISTRY SAW ITSELF, FIRST. A root this registry manages is the one
  // place it has standing to answer, so its own reading wins over a report about
  // the same subject — and where its reading is `unknown` it does not pretend
  // otherwise, it falls through to the self-report.
  if (input.observed !== null && input.observed !== undefined) {
    const own = evaluateOutcome(input.contract, input.observed);
    if (own.value !== "unknown") return registry(own);
  }

  const claimed = evaluateOutcome(input.contract, input.claimed);
  if (claimed.value === "unknown") return registry(claimed);
  return {
    value: "unknown",
    reason: "self_reported_not_verified_by_the_registry",
    assessed_by: "principal",
    principal_type: principalType,
    basis: basisOf("principal"),
    claim: claimed.value,
  };
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
