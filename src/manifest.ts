// Appendix E schema validation (JSON Schema 2020-12 via Ajv).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { assetRoot } from "./assets.ts";
import { OUTCOME_CHECK_KINDS, OUTCOME_CHECK_SHAPE, isEvidenceName, type OutcomeContract } from "./outcome.ts";

// Appendix E's schema files ship with the code; `assetRoot()` is what knows
// where that is in each packaging layout (checkout, npm, compiled binary).
const SCHEMA_DIR = join(assetRoot(), "schema");

const ajv = new (Ajv2020 as any)({ allErrors: true, strict: false });
(addFormats as any)(ajv);

function load(name: string) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

export const validators = {
  manifest: ajv.compile(load("skill-package-v1.schema.json")),
  environment_descriptor: ajv.compile(load("environment-descriptor-v1.schema.json")),
  evidence: ajv.compile(load("evidence-v1.schema.json")),
  failure_report: ajv.compile(load("failure-report-v1.schema.json")),
  rollback_report: ajv.compile(load("rollback-report-v1.schema.json")),
  version_registry_view: ajv.compile(load("version-registry-view-v1.schema.json")),
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateManifest(manifest: unknown): ValidationResult {
  const valid = validators.manifest(manifest) as boolean;
  return {
    valid,
    errors: valid ? [] : (validators.manifest.errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message}`),
  };
}

export { OUTCOME_CHECK_KINDS, OUTCOME_CHECK_SHAPE, type OutcomeCheck, type OutcomeContract } from "./outcome.ts";

/**
 * D-2: the §4 `outcome` column's contract, and whether this manifest carries a
 * WHOLE one — returned AS THE CONTRACT, never as a boolean.
 *
 * The schema declares the section optional, because `skill.create` accepts
 * packages an author signed elsewhere — including packages signed before this
 * section existed — and a registry that refused them would be demanding a
 * document the author could not have written. Surface 14 requires it, and this
 * is the one place that says what "carries one" means, so the packing gate and
 * the fleet dashboard cannot come to different answers about the same manifest.
 *
 * A BOOLEAN IS WHAT THE EVALUATOR USED TO BE GIVEN, and it is the whole shape
 * of the defect: `outcome_contract: true` said a definition of success existed
 * somewhere and left the surface to decide what success WAS. The surface then
 * read the reporter's own `result`. So this function hands back the document
 * and `evaluateOutcome` executes its `check` [M-6].
 *
 * The check is on the SHAPE, not on presence. A truncated contract — a `check`
 * with no `kind`, a `stdout_match` with no pattern, an empty `evidence`, a
 * missing `unknown` — is not a definition of success, and treating it as one
 * would make `outcome` answer on the strength of a document that never said
 * what success was.
 */
export function outcomeContractOf(manifest: unknown): { valid: boolean; reason: string; contract: OutcomeContract | null } {
  const no = (reason: string) => ({ valid: false, reason, contract: null });
  const c = (manifest as any)?.outcome_contract;
  if (c === undefined || c === null) return no("no_outcome_contract");
  if (typeof c !== "object" || Array.isArray(c)) return no("outcome_contract_is_not_a_section");
  if (typeof c.check !== "object" || c.check === null || !OUTCOME_CHECK_KINDS.includes(c.check.kind)) {
    return no("outcome_contract_names_no_deterministic_check");
  }
  // THE PARAMETER OF ITS OWN KIND. A check that names a kind and none of its
  // parameters cannot be executed, and a contract that cannot be executed
  // defines nothing.
  const shape = OUTCOME_CHECK_SHAPE[c.check.kind as string]!;
  const parameter = c.check[shape.parameter];
  const present =
    shape.parameter === "exit_code"
      ? Number.isInteger(parameter)
      : typeof parameter === "string" && parameter.length > 0;
  if (!present) return no(`outcome_contract_check_has_no_${shape.parameter}`);
  if (!Array.isArray(c.evidence) || c.evidence.length === 0 || !c.evidence.every((e: unknown) => typeof e === "string" && e.length > 0)) {
    return no("outcome_contract_names_no_evidence");
  }
  // THE FORM OF A NAME, ENFORCED HERE AS WELL AS IN THE SCHEMA — and it is a
  // rule about THIS DOCUMENT, not about the journal.
  //
  // WHAT IT USED TO BE, because the change matters. A declared name was stored
  // in `observed_records.evidence` as a JSON KEY, word for word, so the form was
  // [I-7]'s last line of defence; round 9b found that no form is one — a hex
  // string of 33 characters is an identifier — and removed the channel instead.
  // The journal's names are `EVIDENCE_NAMES` alone and this field is NOT A
  // SOURCE OF ADMISSIBLE NAMES.
  //
  // WHAT IT IS FOR NOW. `outcome_contract` is machine-readable content of a
  // SIGNED manifest, and a field whose items may be paragraphs is not
  // machine-readable. So a contract naming a sentence is not a definition of
  // success this registry reads — from the packer (the schema refuses it) or
  // from anywhere else (this does).
  //
  // A contract is refused WHOLE rather than filtered down to its usable names:
  // a filter would be a second, quieter definition of what a contract is, and
  // the `outcome` this version reports is then `unknown` WITH THIS REASON —
  // never `no`, because a task nobody could evaluate is not a task that failed
  // [I-1], [A-0].
  if (!c.evidence.every((e: unknown) => isEvidenceName(e))) {
    return no("outcome_contract_declares_a_name_that_is_not_an_identifier");
  }
  if (typeof c.unknown !== "string" || c.unknown.length === 0) {
    return no("outcome_contract_does_not_say_what_absent_evidence_means");
  }
  return {
    valid: true,
    reason: "outcome_contract",
    contract: { check: { ...c.check }, evidence: [...c.evidence], unknown: c.unknown },
  };
}

export function validatePayload(kind: keyof typeof validators, payload: unknown): ValidationResult {
  const v = validators[kind];
  const valid = v(payload) as boolean;
  return { valid, errors: valid ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message}`) };
}
