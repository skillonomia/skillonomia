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

export function validatePayload(kind: keyof typeof validators, payload: unknown): ValidationResult {
  const v = validators[kind];
  const valid = v(payload) as boolean;
  return { valid, errors: valid ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message}`) };
}
