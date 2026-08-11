// Appendix E schema validation (JSON Schema 2020-12 via Ajv).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { assetRoot } from "./assets.ts";

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

/**
 * D-2: the §4 `outcome` column's contract, and whether this manifest carries a
 * WHOLE one.
 *
 * The schema declares the section optional, because `skill.create` accepts
 * packages an author signed elsewhere — including packages signed before this
 * section existed — and a registry that refused them would be demanding a
 * document the author could not have written. Surface 14 requires it, and this
 * is the one place that says what "carries one" means, so the packing gate and
 * the fleet dashboard cannot come to different answers about the same manifest.
 *
 * The check is on the SHAPE, not on presence. A truncated contract — a `check`
 * with no `kind`, an empty `evidence`, a missing `unknown` — is not a definition
 * of success, and treating it as one would make `outcome` answer `no` on the
 * strength of a document that never said what success was. That is the [M-6]
 * failure with a manifest attached: completion read as success.
 */
export const OUTCOME_CHECK_KINDS: readonly string[] = ["exit_code", "stdout_match", "artifact_exists", "command"];

export function outcomeContractOf(manifest: unknown): { valid: boolean; reason: string } {
  const c = (manifest as any)?.outcome_contract;
  if (c === undefined || c === null) return { valid: false, reason: "no_outcome_contract" };
  if (typeof c !== "object" || Array.isArray(c)) return { valid: false, reason: "outcome_contract_is_not_a_section" };
  if (typeof c.check !== "object" || c.check === null || !OUTCOME_CHECK_KINDS.includes(c.check.kind)) {
    return { valid: false, reason: "outcome_contract_names_no_deterministic_check" };
  }
  if (!Array.isArray(c.evidence) || c.evidence.length === 0 || !c.evidence.every((e: unknown) => typeof e === "string" && e.length > 0)) {
    return { valid: false, reason: "outcome_contract_names_no_evidence" };
  }
  if (typeof c.unknown !== "string" || c.unknown.length === 0) {
    return { valid: false, reason: "outcome_contract_does_not_say_what_absent_evidence_means" };
  }
  return { valid: true, reason: "outcome_contract" };
}

export function validatePayload(kind: keyof typeof validators, payload: unknown): ValidationResult {
  const v = validators[kind];
  const valid = v(payload) as boolean;
  return { valid, errors: valid ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message}`) };
}
