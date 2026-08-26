// THE v1.1 AUTHORING CLI CONTRACT — `init`, `validate`, `create`.
//
// WHAT THIS FILE IS. The argument shapes, the closed vocabularies, the source
// validation profile's own rules and the finding shape those three subcommands
// answer with. It is not the commands: nothing here writes a file, reads a
// directory, opens a socket or reads an environment variable. P2 implements the
// commands against these shapes, and the point of separating them is that the
// LOCAL validator and the SERVER's `create_from_dir` can be held to one
// definition — the v1.1 requirement that both use the same source-profile semantics and the
// same error codes and JSON pointers is only checkable if there is one place the
// semantics are written down.
//
// THE ONE THING THIS CONTRACT REFUSES TO DO. It does not narrow the v1 package
// schema. `skill-source-v1` is a PROFILE OF THE INPUT a human hands the
// registry, not a replacement for `skill-package-v1`: it says which members are
// server-owned and therefore absent from a source directory, and nothing else.
// A package that validates today validates tomorrow. The useful resistance of
// the package schema is a property of the product and easing onboarding is not
// a reason to give it up.
import { REVOCATION_REASON_MAX } from "./lifecycle-v11.ts";

/** The Registry's own slug grammar. The CLI checks the SAME grammar the server
 *  checks, because a slug the CLI accepts and the server refuses is a failure
 *  the author meets after their source has already been archived and sent. */
export const CLI_SLUG_RE = /^[a-z0-9-]{3,64}$/;

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && CLI_SLUG_RE.test(slug);
}

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === "string" && (RISK_LEVELS as readonly string[]).includes(v);
}

// ===========================================================================
// The source profile
// ===========================================================================

/** The name of the profile, so a document, an error and a test cannot name three
 *  different things. */
export const SOURCE_PROFILE = "skill-source-v1";

/**
 * The members of `skill-package-v1` that a SOURCE directory does not carry,
 * because the server owns them.
 *
 * `author_agent` is the authenticated principal. `integrity` is computed over
 * the packed bytes AFTER the arrival marker is added, so a value computed
 * locally would be a value of a different package. A source that carries
 * `author_agent` anyway is not refused outright — it must simply MATCH the
 * authenticated principal at `create`, or the call is `FORBIDDEN`; declaring
 * yourself to be somebody else is a different error from forgetting a field.
 */
export const SERVER_OWNED_MANIFEST_MEMBERS = ["author_agent", "integrity"] as const;

/**
 * Files whose presence means the input is ALREADY PACKED, not a source.
 *
 * A directory holding `skill.json` or `SIGNATURE.jws` has been through the
 * packing path once. Accepting it would either re-pack a sealed package — giving
 * it a second arrival marker and a second integrity list, so the signature no
 * longer describes the bytes — or silently discard the signature that is
 * already there. Both are worse than a refusal that says which file gave it
 * away.
 */
export const ALREADY_PACKED_MARKERS = ["skill.json", "SIGNATURE.jws"] as const;

/** What `init` writes. Named here so `validate` can be run against exactly what
 *  `init` produced and the round trip is a test rather than a hope. */
export const INIT_FILES = ["manifest.json", "SKILL.md"] as const;

/**
 * `validation_gates[].gate_id` in a generated template is snake_case.
 *
 * WHY THE TEMPLATE AND NOT THE SCHEMA. The confirmed v1.0.0 gap is that
 * `gate_id` admits values that are awkward to name from
 * `outcome_contract.evidence[]`, and the fix people reach for first is to
 * narrow the schema — which would refuse packages that verify today, for the
 * sake of convenience. So the schema stays as it is, `init` GENERATES ids that
 * work, and `validate` gives a targeted error when a cross-field use is
 * incompatible, naming the two fields rather than the pattern.
 *
 * WHAT THIS PATTERN IS NOT. `outcome_contract.evidence[]` is the author's
 * declaration under their own signature and is NOT A SOURCE OF ADMISSIBLE NAMES
 * for this registry: the keys a journal accepts are the derived set the registry
 * computes, and generating an id that matches this form makes it CONVENIENT to
 * name, never admissible by declaration. Nor is the bound a security property.
 * A small character set and a capped length can still be made to
 * carry an encoding by somebody who sets out to build one — exactly as a flat
 * list of integers can. What the form buys is a name a cross-field reference can
 * resolve, and nothing beyond that.
 */
export const GENERATED_GATE_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function isGeneratedGateId(v: unknown): v is string {
  return typeof v === "string" && GENERATED_GATE_ID_RE.test(v);
}

/** The approvals a `high` risk template declares. Both, because §7.3 asks for
 *  them at two different moments — once to make the version externally
 *  adoptable, once per adoption — and a template that declared only one would
 *  teach the author that high risk is gated once. */
export const HIGH_RISK_REQUIRED_APPROVALS = ["publish", "adopt_high_risk"] as const;

// ===========================================================================
// The commands
// ===========================================================================

export interface InitArgs {
  directory: string;
  slug: string;
  risk: RiskLevel;
  /** Write into a directory that is not empty. Even then it does NOT delete
   *  files it did not write: an author's half-finished work is not the CLI's to
   *  remove, and `--force` means "overwrite what I generate", not "clear the
   *  directory". */
  force: boolean;
}

export interface ValidateArgs {
  directory: string;
  json: boolean;
}

export interface CreateArgs {
  directory: string;
  slug: string;
  server: string;
  /** The NAME of an environment variable, never the key. A key passed as an
   *  argument is in the process table, the shell history and every `ps` on the
   *  host; a key written to a config file is in a backup. The CLI reads the
   *  named variable and writes the value nowhere. */
  api_key_env: string;
  json: boolean;
}

/** The three subcommands v1.1 adds, as a runtime list — the help text, the
 *  documentation and the dispatch table are each checked against it. */
export const AUTHORING_SUBCOMMANDS = ["init", "validate", "create"] as const;
export type AuthoringSubcommand = (typeof AUTHORING_SUBCOMMANDS)[number];

// ===========================================================================
// What a check says
// ===========================================================================

/**
 * Three severities, and `FAIL` is the only one that decides the exit code.
 *
 * `WARN` exists so that a check which found something real but not
 * disqualifying does not have to choose between silence and refusal — the
 * eight safety gates already work this way. `INFO` carries the things an author
 * benefits from seeing on the first run.
 */
export const FINDING_SEVERITIES = ["FAIL", "WARN", "INFO"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * One finding.
 *
 * Every member is required, and two of them are the ones usually missing
 * elsewhere. `recovery` says what to DO: a validator that reports
 * `/procedure/validation_gates/0/gate_id: INVALID_SCHEMA` and stops has told a
 * first-time author the truth and left them no better off. `anchor` says where
 * to READ MORE, and it is a field rather than a sentence inside `detail`
 * because a caller rendering findings — the CLI, the Console, an editor
 * plugin — must be able to link it without parsing prose out of a message.
 *
 * `pointer` is an RFC 6901 JSON pointer into the manifest so an editor can jump
 * to it; `code` is stable so the published documentation can anchor one section
 * per category, and `anchor` is derived from `code` so the two cannot drift.
 */
export interface SourceFinding {
  pointer: string;
  code: string;
  severity: FindingSeverity;
  detail: string;
  recovery: string;
  anchor: string;
}

/** `validate --json`. `ok` is DERIVED from the findings rather than reported
 *  beside them, so the two cannot disagree. */
export interface ValidateReport {
  profile: typeof SOURCE_PROFILE;
  directory: string;
  ok: boolean;
  findings: SourceFinding[];
}

/** Exit 0 only when nothing FAILed. Warnings do not fail a validate, for the
 *  same reason they do not fail a gate run: a warning that blocks is a failure
 *  wearing a milder word. */
export function validateExitCode(findings: readonly SourceFinding[]): number {
  return findings.some((f) => f.severity === "FAIL") ? 1 : 0;
}

export function isValidateOk(findings: readonly SourceFinding[]): boolean {
  return validateExitCode(findings) === 0;
}

/**
 * `create --json`.
 *
 * `next_action` is a field and not a sentence in the output text: after a
 * create, what an author may do next depends on the risk level, the gate
 * results and the §7.3 matrix, and a CLI that guessed would be a second
 * implementation of the eligibility rules INV-01 forbids. The server says.
 */
export interface CreateReport {
  skill_id: string;
  skill_version_id: string;
  slug: string;
  semantic_version: string;
  state: string;
  gates: { passed: number; failed: number; warned: number };
  next_action: string;
}

/**
 * The typed conflict an author meets when the slug is taken by another skill.
 *
 * The CLI does NOT then guess that the author meant to publish a new version of
 * the existing skill: authoring a further version of an existing skill is the
 * existing advanced API/MCP path, and silently taking it would attach somebody's
 * source to somebody else's lineage. The source directory is left exactly as it
 * was found — which is the general rule below, not a special case of it.
 */
export const SLUG_CONFLICT_CODE = "CONFLICT";

/**
 * THE STANDING PROMISE OF ALL THREE COMMANDS: on every validation failure and
 * every transport failure, the source directory is exactly as it was found.
 *
 * It is written here, as a named constant a test asserts against, because it is
 * the promise an author relies on to be willing to run a command that talks to
 * a server at all — and because "we do not think we modify it" is not a
 * property, whereas "no command writes to the source directory outside `init`,
 * and `init` writes only the files it generates" is one.
 */
export const SOURCE_IS_NEVER_MUTATED_BY = ["validate", "create"] as const;

/** The transport policy flag the v1.1 registration parity rule names, kept
 *  beside the CLI contract because an author registering a loopback endpoint
 *  during development meets it here first. Registration and delivery read THE
 *  SAME flag: an endpoint the transport would refuse to deliver to must not be
 *  accepted at registration, which is the whole of the rule. */
export const WEBHOOK_LOOPBACK_FLAG = "SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK";

/** Re-exported so a CLI that reports a revocation reason bounds it the same way
 *  the registry does, rather than discovering the limit from a 400. */
export const CLI_REVOCATION_REASON_MAX = REVOCATION_REASON_MAX;
