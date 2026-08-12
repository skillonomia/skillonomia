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
 *
 * `observable` IS THE NARROWING, WRITTEN AS DATA. It says whether THIS REGISTRY
 * can produce this kind's evidence by looking at something of its own. Exactly
 * one kind can: `artifact_exists`, and only for an artifact its own activation
 * journal says it placed under a root it manages. An exit code, an output and a
 * command line are facts about a process on the addressee's machine; this
 * registry did not run it and cannot [M-7], so no amount of evidence about them
 * is its own to answer for. A kind added later is `observable: false` until
 * somebody writes down why it is not, which is the direction that fails safe.
 */
export const OUTCOME_CHECK_SHAPE: Readonly<
  Record<string, { parameter: string; evidence: string; reads: readonly string[]; observable: boolean }>
> = {
  exit_code: { parameter: "exit_code", evidence: "exit_code", reads: ["exit_code"], observable: false },
  stdout_match: { parameter: "stdout_match", evidence: "stdout", reads: ["stdout"], observable: false },
  artifact_exists: { parameter: "artifact_path", evidence: "artifacts", reads: ["artifacts"], observable: true },
  command: { parameter: "command", evidence: "exit_code", reads: ["command", "exit_code"], observable: false },
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

// ===========================================================================
// WHAT A NAMED VALUE MAY BE — the CHANNEL, closed the same way the names were.
// ===========================================================================

/**
 * THE DEFECT THIS SECTION EXISTS TO REMOVE, and it is the previous round's fix
 * looked at from one step further back.
 *
 * Round 6 closed the set of evidence NAMES: a report may only present names the
 * signed contract asked for. It left the VALUES open — any string, of any
 * content, up to the size bound. A reviewer put `sk-live-…` through the shipped
 * `/v1/observations` surface under the contract's own `stdout` and it was
 * stored, word for word, in an INSERT-only journal. A whole transcript goes the
 * same way. A closed set of names over an open set of values is not a closed
 * channel: it is a key-value store with a vocabulary.
 *
 * SO A VALUE IS ONE OF FOUR THINGS, and never "a string":
 *
 *   * a BOOLEAN — one bit, nothing can be hidden in it;
 *   * a SAFE INTEGER — an exit code, a count, a duration;
 *   * a DIGEST OF FIXED FORM — `sha256:` and sixty-four lowercase hex digits,
 *     and nothing else may wear that shape. A digest carries no text: it is the
 *     way to present "the output was exactly this" without presenting output;
 *   * a LITERAL THE SIGNED CONTRACT ITSELF NAMES — the `command` it demands, the
 *     `artifact_path` it demands. This is an enumeration whose members were
 *     fixed when the version was signed, which is what makes it not a channel:
 *     a reporter can only echo back one of the author's own words.
 *
 * …or a list of those. Everything else is refused at the boundary and never
 * reaches the database.
 *
 * WHAT THIS COSTS, STATED. Free text can no longer be presented under ANY name,
 * including a name the contract declared. An author who wants a run's output
 * evaluated presents its digest, and the contract states the digest it expects.
 * A `stdout_match` that names a SUBSTRING is therefore no longer executable by
 * this registry — see `checkIsExecutable` below, which says so in a reason
 * rather than answering `no` to a run that may well have printed the pattern.
 */
export const EVIDENCE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** How many elements a list-valued evidence may carry. A list is a value, not
 *  a place to put a transcript one element at a time. */
export const EVIDENCE_LIST_MAX = 32;

/**
 * The literals ONE SIGNED CONTRACT names — the enumeration a reporter may echo.
 *
 * They are read off the `check` and nowhere else: what the AUTHOR wrote, inside
 * the signature, before any run existed. `evidence` (the list of NAMES) is not a
 * source of literals, and neither is anything a caller sent.
 */
export function contractLiterals(contract: unknown): Set<string> {
  const out = new Set<string>();
  const check = (contract as { check?: Record<string, unknown> } | null | undefined)?.check;
  if (check === null || check === undefined || typeof check !== "object") return out;
  for (const field of ["command", "artifact_path", "stdout_match"]) {
    const v = (check as Record<string, unknown>)[field];
    if (typeof v === "string" && v.length > 0) out.add(v);
  }
  return out;
}

/**
 * Whether ONE value may be carried, given the enumeration this contract fixed.
 *
 * ONE implementation, here, because the boundary that refuses a report and the
 * checks that read a value must not be able to disagree about what a value is —
 * that disagreement is how the name rule was widened in round 5 and how the
 * value rule would be widened next.
 */
export function isAdmissibleEvidenceValue(value: unknown, literals: ReadonlySet<string>): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "string") return EVIDENCE_DIGEST.test(value) || literals.has(value);
  if (Array.isArray(value)) {
    return value.length <= EVIDENCE_LIST_MAX && value.every((v) => isAdmissibleEvidenceValue(v, literals));
  }
  return false;
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

// ===========================================================================
// WHOSE VALUES THESE ARE — the mark, set at intake, carried to publication.
// ===========================================================================

/**
 * THE DEFECT THIS SECTION EXISTS TO REMOVE, and it is worth stating exactly,
 * because the fix is a change of SHAPE and not a change of behaviour.
 *
 * `assessOutcome` used to read:
 *
 *     const claimed = evaluateOutcome(input.contract, input.claimed);
 *     if (claimed.value === "unknown") return registry(claimed);
 *
 * The values came from a PRINCIPAL. The verdict was `unknown`. And the answer
 * went out with `assessed_by: registry`, `basis: registry_observation` —
 * because `registry(…)` was a helper any branch could wrap any verdict in, and
 * this branch happened to be written that way. THE PROVENANCE WAS INFERRED
 * FROM WHICH BRANCH OF THE CODE RAN, not from whose data was read.
 *
 * That is the same class of defect `as Cell` was in round 5, and it takes the
 * same kind of answer. Not a check that the two agree — a CONSTRUCTION in which
 * they cannot disagree:
 *
 *   * values are MARKED WHEN THEY ARE ACCEPTED, before anything evaluates
 *     them: `selfReported` where an agent presented them, `registryObserved`
 *     where this registry produced them by looking at something it manages;
 *   * the mark is membership in a `WeakMap` held in this module's closure, so
 *     it is carried BY IDENTITY. A cast changes a type and changes no object;
 *     a literal of the same shape is a different object; `JSON.parse` of a
 *     marked object's own bytes, a `structuredClone` and a spread copy are all
 *     different objects, and none of them can be made a member without calling
 *     a constructor — which is the thing that was wanted;
 *   * `assessed_by` is not a parameter of anything, and it is not a literal
 *     anywhere in the executable part of this module. There is ONE function
 *     that builds a published verdict, it computes the verdict ITSELF from the
 *     marked values it was handed, and it reads the attribution off that same
 *     object. So no branch of the assessor can pair one party's data with the
 *     other's authority: `registry(claimed)` is not refused here, it is not
 *     expressible here.
 *
 * WHAT THIS DOES NOT CLAIM — and the limit is stated because a comment claiming
 * the stronger thing would be the very defect this round is about.
 *
 *   Membership proves an object came from a constructor. It does NOT prove the
 *   CALLER of `registryObserved` was entitled to call it: a new module could
 *   call it on values an agent sent, and nothing in this file would notice.
 *   That is a separate property and it is kept separately — there is exactly
 *   one caller in `src/`, and a probe reads the source DIRECTORY and asserts
 *   which file it is, so a second caller is a failing test. It is a guard, not
 *   an impossibility, and it is described here as a guard.
 */
export type EvidenceOrigin = "registry" | "principal";

declare const EVIDENCE_MARK: unique symbol;

/**
 * Named values that KNOW where they came from.
 *
 * At runtime this is exactly the object of named values — the wire shape does
 * not change and neither does what `JSON.stringify` produces. The brand is a
 * type-level declaration only, and it is the WEAKER of the two layers: `as
 * Evidence` defeats it, which is precisely why the answer that matters is the
 * `WeakMap` below.
 */
export type Evidence = Readonly<Record<string, unknown>> & { readonly [EVIDENCE_MARK]: EvidenceOrigin };

/** The mark. A `WeakMap` because it must not keep a report alive, and because
 *  the whole of the answer is one word about one object. */
const MARKED = new WeakMap<object, EvidenceOrigin>();

/**
 * The refusal raised when values of unknown provenance reach the assessor. Its
 * own class, so it cannot be swallowed by a `catch` written for something else,
 * and so a caller can tell it from any other failure.
 */
export class ForeignEvidence extends Error {}

/**
 * THE VALUES A PRINCIPAL PRESENTED — marked here, at the point of acceptance.
 *
 * `null` in, `null` out: a report that presented nothing is not a report of
 * nothing, and both are `unknown` downstream, never `no`.
 */
export function selfReported(values: Record<string, unknown> | null | undefined): Evidence | null {
  return mark(values ?? null, "principal");
}

/**
 * THE VALUES THIS REGISTRY PRODUCED BY LOOKING AT SOMETHING IT MANAGES.
 *
 * There is exactly ONE caller of this function in `src/` —
 * `registryObservedEvidence` in `src/activation.ts`, which reads an artifact
 * under an activation root against this registry's own journal entry saying it
 * put the artifact there. A probe reads the source directory and asserts that,
 * so a second caller is a failing test rather than a widened authority.
 */
export function registryObserved(values: Record<string, unknown>): Evidence {
  return mark(values, "registry") as Evidence;
}

function mark(values: Record<string, unknown> | null, origin: EvidenceOrigin): Evidence | null {
  if (values === null) return null;
  const frozen = Object.freeze({ ...values });
  MARKED.set(frozen, origin);
  return frozen as Evidence;
}

/** Whether this exact object is one a constructor above marked. */
export function isEvidence(value: unknown): value is Evidence {
  return typeof value === "object" && value !== null && MARKED.has(value as object);
}

/**
 * WHOSE VALUES THESE ARE, or a REFUSAL.
 *
 * Every published verdict's attribution comes through here, which is what makes
 * "the answer stands on the authority of whoever produced the data" a property
 * of the code rather than a sentence about it.
 */
export function originOf(value: unknown): EvidenceOrigin {
  const origin = typeof value === "object" && value !== null ? MARKED.get(value as object) : undefined;
  if (origin === undefined) {
    throw new ForeignEvidence(
      "refused: named values that no evidence constructor marked reached the assessor " +
        `(${describeEvidence(value)}). Provenance is admitted by IDENTITY — the object is one \`selfReported\` or ` +
        "`registryObserved` returned — so a cast, a literal of the same shape, a `JSON.parse` of marked bytes and a " +
        "clone of one are all refused here.",
    );
  }
  return origin;
}

/** What a refused object IS, without printing what it says: a rejected value
 *  may be the very material [I-7] keeps out of this process's output. */
function describeEvidence(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return `a ${typeof value}`;
  return `an object with keys [${Object.keys(value as object).join(", ")}]`;
}

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
  /** the named values a PRINCIPAL presented about its own machine, marked as
   *  such by `selfReported` AT THE POINT THEY WERE ACCEPTED */
  claimed: Evidence | null;
  /** the named values THIS REGISTRY produced by looking at something it
   *  manages, marked by `registryObserved`, or `null` where it looked at
   *  nothing. `null` is not "the artifact is absent" */
  observed: Evidence | null;
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

  if (input.contract === null || input.contract === undefined) {
    return publish(null, null, principalType);
  }

  // WHAT THE REGISTRY SAW ITSELF, FIRST. The one place it has standing to answer
  // is a thing its own journal says it put there, and `registryObservedEvidence`
  // is the only producer of values marked that way. Where its own reading is
  // `unknown` it does not pretend otherwise — it falls through to the report.
  if (input.observed !== null && input.observed !== undefined) {
    const own = publish(input.observed, input.contract, principalType);
    if (own.value !== "unknown") return own;
  }

  return publish(input.claimed ?? null, input.contract, principalType);
}

/**
 * THE ONE EXPRESSION THAT PUBLISHES A VERDICT, and the whole of 2.1's fix.
 *
 * It takes the MARKED VALUES and the CONTRACT — never a verdict somebody else
 * computed. That is the load-bearing detail: because it evaluates the contract
 * against the very object it read the attribution off, there is no way to hand
 * it an answer derived from one party's data and an authority belonging to the
 * other. `registry(claimed)` is not something this module refuses; it is
 * something no caller can spell.
 *
 * AND THE NARROWING LIVES HERE TOO. Values a PRINCIPAL presented never become
 * the published verdict, whatever the contract says about them: the column
 * reads `unknown`, the reason says it was not verified here, and what the
 * self-report AMOUNTS TO rides beside it as `claim`. A self-report that fails
 * to satisfy its contract is published the same way — `claim: "no"` — because
 * "this registry did not check it" is equally true of a claimed failure, and a
 * `no` printed on the registry's authority for a process on somebody else's
 * machine is the same lie in the other direction [M-6], [M-7].
 */
function publish(evidence: Evidence | null, contract: unknown, principalType: PrincipalType | null): OutcomeAssessment {
  // THE ATTRIBUTION, READ OFF THE DATA. `null` is the one case with no data to
  // read: no contract, or no evidence from anybody. The statement then made is
  // about this registry's OWN state of knowledge — "no contract was carried",
  // "no run presented evidence" — and it is the registry's to make. It is
  // always `unknown`; nothing here can turn an absence into an answer.
  const assessed_by: EvidenceOrigin = evidence === null ? "registry" : originOf(evidence);
  const verdict = evaluateOutcome(contract, evidence);
  const decided = verdict.value !== "unknown";

  // THE NARROWING, ENFORCED WHERE THE ANSWER IS PUBLISHED AND NOT ONLY WHERE THE
  // EVIDENCE IS PRODUCED. `registryObservedEvidence` yields values for
  // `artifact_exists` alone, so today no other kind can reach this function with
  // the registry's mark — and "cannot happen today" is exactly the sort of
  // guarantee that stops holding when somebody writes a second producer. The
  // rule is therefore stated against the check table, which is where
  // `observable` is decided and where a new kind will be added.
  const observable = OUTCOME_CHECK_SHAPE[(contract as OutcomeContract | null)?.check?.kind as string]?.observable === true;

  // A DECISION STANDS ON THIS REGISTRY'S AUTHORITY only where this registry's
  // OWN values decided it AND the kind is one it can observe. Everything else
  // is `unknown` — with the principal's conclusion published beside it where
  // there was one to publish.
  const stands = assessed_by === "registry" && decided && observable;

  // ONE CONSTRUCTION, and `assessed_by` is not a literal in it. There is no
  // expression here that CHOOSES an authority: the field is the origin read off
  // the data, `basis` is computed from that same value, and a caller that wants
  // a different attribution has no argument to pass and no branch to take.
  return {
    value: stands ? verdict.value : "unknown",
    reason: stands || !decided
      ? verdict.reason
      : assessed_by === "principal"
        ? "self_reported_not_verified_by_the_registry"
        : "check_kind_is_not_one_this_registry_can_observe",
    assessed_by,
    principal_type: principalType,
    basis: basisOf(assessed_by),
    claim: assessed_by === "principal" && decided ? verdict.value : null,
  };
}

export function evaluateOutcome(contract: unknown, evidence: unknown): OutcomeVerdict {
  if (contract === null || contract === undefined) return { value: "unknown", reason: "no_outcome_contract" };
  const c = contract as OutcomeContract;
  const shape = OUTCOME_CHECK_SHAPE[c?.check?.kind as string];
  if (!shape) return { value: "unknown", reason: "outcome_contract_names_no_deterministic_check" };
  // THE CONTRACT'S OWN PARAMETER MAY BE UNREADABLE, and that is a fact about
  // the CONTRACT and not about the run. `stdout` is carried as a digest (2.3),
  // and a substring cannot be tested against a digest — so a `stdout_match`
  // whose pattern is a substring is not executable by this registry, and it
  // says so rather than answering `no` to a run that may well have printed the
  // pattern. Blaming the evidence for the contract's shape would be a reason
  // that names the wrong party.
  if (!checkParameterIsReadable(c.check)) {
    return { value: "unknown", reason: "contract_check_parameter_is_not_one_this_registry_can_read" };
  }
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

/**
 * Whether the SIGNED contract's own parameter is something this registry can
 * read, given what a run is now allowed to present.
 *
 * Only `stdout_match` has a constraint, and it is a consequence of 2.3 rather
 * than a new rule: the pattern is compared against `stdout`, `stdout` is a
 * digest, so a pattern that is not a digest of the same form names a
 * comparison nothing can perform. The other three compare against an integer,
 * a path the contract itself declares, and a command the contract itself
 * declares — all of which a run may present under the value grammar.
 */
function checkParameterIsReadable(check: OutcomeContract["check"]): boolean {
  if (check.kind !== "stdout_match") return true;
  return typeof check.stdout_match === "string" && EVIDENCE_DIGEST.test(check.stdout_match);
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
      // AN EQUALITY OF DIGESTS, and no longer a substring test. `stdout` is a
      // digest of fixed form (2.3) because a channel that takes arbitrary text
      // is a transcript however the field is named, and `checkParameterIsReadable`
      // has already refused a contract whose pattern is not a digest, so both
      // sides of this comparison are digests or this line is not reached.
      const observed = values.stdout;
      if (typeof observed !== "string" || !EVIDENCE_DIGEST.test(observed)) return null;
      return observed === check.stdout_match;
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
