// THE `skill-source-v1` PROFILE, AS ONE FUNCTION WITH TWO CALLERS.
//
// The two callers are `skillonomia validate`, which runs on the author's
// machine before anything is sent, and `skill.create_from_dir`, which runs on
// the server after it arrives. They must reach the same verdict about the same
// directory, with the same stable code and the same JSON pointer, or the CLI's
// preflight is worthless: an author whose `validate` is green and whose `create`
// is a 400 has been told the check means something it does not.
//
// TWO IMPLEMENTATIONS THAT AGREE TODAY WILL DISAGREE LATER. That is not a
// prediction about carelessness, it is what happened to the webhook policy in
// this same repository — a registration rule and a delivery rule, written apart,
// each correct when written, drifting until registration accepted destinations
// delivery refused. `INV-01` is the standing answer and this file is its
// application here: the semantics live in ONE place, and the server calls it
// rather than restating it.
//
// WHAT A SOURCE IS, AND WHAT IT IS NOT. A source directory is the input a human
// hands the registry. It is not a package. The three members a package has that
// a source does not are server-owned — `author_agent` is the authenticated
// principal, `integrity` is computed over the packed bytes AFTER the arrival
// marker exists, and the signature is made by the registry — so a source that
// carries them is either confused or is a packed archive sent to the wrong
// surface, and either way saying which file gave it away is more use than a
// schema error.
//
// AND THE PROFILE DOES NOT NARROW THE PACKAGE SCHEMA. `skill-source-v1` says
// which members are server-owned and absent from a source; it does not tighten a
// single rule the package contract already makes. A package that validates today
// validates tomorrow. Easing onboarding is not a reason to give up the useful
// resistance of the package schema, so where a form is merely INCONVENIENT the
// profile warns and names the two fields involved, and where it is genuinely
// unusable it fails.
import { computeIntegrity, type PackageFiles } from "./archive.ts";
import { manifestSchemaErrors } from "./manifest.ts";
import { outcomeContractOf } from "./manifest.ts";
import { parseJsonStrict, utf8Decode } from "./jcs.ts";
import { runGates, schemaCrossFieldProblems, type GateName } from "./gates.ts";
import {
  ALREADY_PACKED_MARKERS,
  GENERATED_GATE_ID_RE,
  INIT_FILES,
  SOURCE_PROFILE,
  type SourceFinding,
} from "./cli-authoring-contract.ts";

/**
 * Every stable code this profile can produce.
 *
 * Stable because the published documentation anchors one section per code and
 * an author's tooling may branch on them; a renamed code silently breaks both.
 * The list is exported so a test can require an anchor for each, rather than
 * for each code somebody remembered.
 */
export const SOURCE_FINDING_CODES = [
  "source_manifest_missing",
  "source_manifest_not_json",
  "source_skill_md_missing",
  "source_already_packed",
  "source_server_owned_member",
  "source_schema",
  "source_outcome_contract",
  "source_gate_evidence_unresolved",
  "source_gate_id_not_nameable",
  "source_safety_gate",
] as const;
export type SourceFindingCode = (typeof SOURCE_FINDING_CODES)[number];

/** Where a reader is sent for a code. One published document, one anchor per
 *  code, and the anchor is DERIVED from the code so the two cannot drift. */
export const SOURCE_DOC = "SPEC.md";
export function anchorFor(code: SourceFindingCode | string): string {
  return `${SOURCE_DOC}#${String(code).replace(/_/g, "-")}`;
}

function finding(
  code: SourceFindingCode,
  pointer: string,
  severity: SourceFinding["severity"],
  detail: string,
  recovery: string,
): SourceFinding {
  return { pointer, code, severity, detail, recovery, anchor: anchorFor(code) };
}

/**
 * The `author_agent` the SHAPE CHECK borrows, and it has to be shape-valid.
 *
 * A source carries no `author_agent` — the server assigns the authenticated
 * principal — so the shape check has to supply one or every source would be
 * told it is missing a member it must not write. The value used before was the
 * readable string `agt_source_profile_placeholder`, which is not a ULID and
 * therefore failed the very schema the check exists to apply. Nothing noticed,
 * because the `/author_agent` schema error was filtered out below and the
 * schema GATE's report was discarded wholesale — so the shape check has been
 * running against a document it invented an invalid member for.
 *
 * A ULID of twenty-six Crockford zeros is valid under `#/$defs/ulid` and is
 * mintable by nothing: `ulid()` derives its first ten characters from a
 * timestamp, so this value cannot collide with a real agent id. It is
 * substituted UNCONDITIONALLY, over an author-supplied value too, because
 * whether that value is the right principal is a `create`-time question needing
 * an authenticated identity and is answered there, not here.
 */
export const SHAPE_PLACEHOLDER_AUTHOR = "00000000000000000000000000";

export interface SourceProfileContext {
  /** server clock, injected for the same reason the gate runner injects it:
   *  the staleness gate is relative to it and a test pins it. */
  nowMs: number;
}

/**
 * The verdict on one source tree, as findings.
 *
 * FINDINGS AND NOT AN EXCEPTION, because the CLI needs all of them and the
 * server needs the first. A validator that threw would force the CLI to call it
 * repeatedly, fixing one error per round trip, which is the experience §6.6
 * exists to end. The server maps the first FAIL to its typed error; that
 * direction loses nothing, and the reverse would.
 *
 * `files` is the WHOLE source tree including `manifest.json`, exactly as the
 * archive carries it, because two of the checks are about which files are
 * present.
 */
export function validateSourceProfile(files: PackageFiles, ctx: SourceProfileContext): SourceFinding[] {
  const out: SourceFinding[] = [];

  const rawManifest = files.get("manifest.json");
  if (rawManifest === undefined) {
    return [
      finding(
        "source_manifest_missing",
        "/",
        "FAIL",
        `manifest.json is missing from the source tree, and the ${SOURCE_PROFILE} profile is a profile of that file`,
        `create ${INIT_FILES.join(" and ")} at the root of the directory — \`skillonomia init <dir> --slug <slug> --risk low\` writes both`,
      ),
    ];
  }
  if (!files.has("SKILL.md")) {
    out.push(
      finding(
        "source_skill_md_missing",
        "/",
        "FAIL",
        "SKILL.md is missing at the source root, and it is the document an adopting agent reads",
        "add SKILL.md beside manifest.json; `skillonomia init` writes a skeleton you can edit",
      ),
    );
  }
  for (const produced of ALREADY_PACKED_MARKERS) {
    if (files.has(produced)) {
      out.push(
        finding(
          "source_already_packed",
          "/",
          "FAIL",
          `${produced} is produced by packing and must not be in a source tree — this directory has already been packed`,
          `send an already-packed archive to skill.create instead, or remove ${produced} if this really is source`,
        ),
      );
    }
  }

  let manifest: any;
  try {
    manifest = parseJsonStrict(utf8Decode(rawManifest));
  } catch (e: any) {
    out.push(
      finding(
        "source_manifest_not_json",
        "/",
        "FAIL",
        `manifest.json could not be read as JSON: ${e.message}`,
        "check the file for a trailing comma, an unquoted key or a duplicate member; the parser is strict on purpose",
      ),
    );
    return out;
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    out.push(
      finding(
        "source_manifest_not_json",
        "/",
        "FAIL",
        "manifest.json parsed, but it is not a JSON object",
        "the manifest is a single JSON object; see the schema reference for the minimal valid payload",
      ),
    );
    return out;
  }

  // The server-owned members, and the two are not the same mistake.
  //
  // `integrity` in a source is always wrong: it is computed over the packed
  // bytes after the arrival marker lands, so any value written here describes a
  // different package than the one that will ship.
  //
  // `author_agent` is merely premature. It is the authenticated principal, the
  // server assigns it, and a source that names one is only refused if it names
  // somebody else — which is a `create`-time decision needing an authenticated
  // identity, and therefore not this function's.
  if (manifest.integrity !== undefined) {
    out.push(
      finding(
        "source_server_owned_member",
        "/integrity",
        "FAIL",
        "integrity is computed by the registry over the packed bytes, after the arrival marker exists, so a value written into a source describes different bytes",
        "delete the integrity member; the registry computes and signs the real list",
      ),
    );
  }
  if (manifest.author_agent !== undefined) {
    out.push(
      finding(
        "source_server_owned_member",
        "/author_agent",
        "INFO",
        "author_agent is assigned from the authenticated principal at create; the value here is not used and must match that principal or the call is refused",
        "you may delete it — leaving it is only an error if it names an agent other than the one whose API key you use",
      ),
    );
  }

  // THE SHAPE, judged against the package schema with a TEMPORARY pre-marker
  // integrity list — computed here, discarded here, never written to the
  // source. Without it every source would report a missing required member and
  // the author would be told to write the one field they must not write. The
  // real list is computed and validated again on the server after the marker
  // lands; this one exists so the SURROUNDING document can be judged now.
  const shipped: PackageFiles = new Map();
  for (const [path, bytes] of files) {
    if (path === "manifest.json") continue;
    shipped.set(path, bytes);
  }
  const forShape = { ...manifest, author_agent: SHAPE_PLACEHOLDER_AUTHOR, integrity: computeIntegrity(shipped) };
  let schemaFindings = 0;
  for (const e of manifestSchemaErrors(forShape)) {
    // A schema error about a server-owned member is reported above, in the
    // author's terms; repeating it in the schema's terms would tell them to fix
    // a field they are not meant to supply.
    if (e.pointer === "/integrity" || e.pointer.startsWith("/integrity/") || e.pointer === "/author_agent") continue;
    schemaFindings += 1;
    out.push(
      finding(
        "source_schema",
        e.pointer,
        "FAIL",
        `${e.pointer} ${e.message}`,
        "compare this member against the Schema Reference for skill-package-v1; the pointer is the exact path inside manifest.json",
      ),
    );
  }

  // THE CROSS-FIELD RULES THE SCHEMA CANNOT STATE, reported here with the
  // pointer an author edits.
  //
  // `risk_level: high` with `sandbox_requirement: none` is two individually
  // valid members whose combination the §7.1 schema gate refuses. The gate says
  // so in one joined sentence and cannot say WHERE — `lint_reports` stores a
  // gate name, a result and a sentence — so an author who met it only through
  // the gate was handed a rule with no member attached to it. The condition is
  // `src/gates.ts`'s, imported rather than restated, so the gate and this
  // profile cannot come to different conclusions about the same manifest.
  for (const p of schemaCrossFieldProblems(forShape)) {
    schemaFindings += 1;
    out.push(finding("source_schema", p.pointer, "FAIL", `${p.pointer} ${p.detail}`, p.recovery));
  }

  // D-2, and the profile states it because `create_from_dir` enforces it: a
  // package the registry PACKS declares what success is, or its outcome column
  // can never say anything. An author meets this at `validate`, on their own
  // machine, rather than as a 400 after the source has been archived and sent.
  const contract = outcomeContractOf(manifest);
  if (!contract.valid) {
    out.push(
      finding(
        "source_outcome_contract",
        "/outcome_contract",
        "FAIL",
        `a package packed by this registry declares what success is, and this manifest does not (${contract.reason})`,
        "add outcome_contract with `check`, `evidence` and `unknown`; `unknown` is the sentence a reader gets when nothing was reported, and it is never the same as a failure",
      ),
    );
  }

  out.push(...crossFieldGateEvidence(manifest));
  out.push(...safetyGateFindings(forShape, shipped, ctx, schemaFindings > 0));
  return out;
}

/**
 * THE CROSS-FIELD CHECK, §6.6.2 — `procedure.validation_gates[].gate_id`
 * against `outcome_contract.evidence[]`.
 *
 * The confirmed v1.0.0 gap is that `gate_id` admits any string while an evidence
 * name is an identifier, so an author can write a gate they then cannot name.
 * The fix people reach for first is narrowing `gate_id` in the schema, which
 * would refuse packages that verify today for the sake of convenience — so the
 * schema is untouched and this reports the CROSS-FIELD USE instead, naming both
 * fields rather than reciting a pattern.
 *
 * Two findings, because two different things go wrong. An evidence name that
 * plainly MEANT a gate and reaches none is a FAIL: the manifest already
 * contains the mistake. A gate id merely outside the identifier form is a WARN:
 * nothing is broken yet, and the author is told now rather than after signing.
 *
 * `outcome_contract.evidence` is the author's own declaration under their own
 * signature and is NOT A SOURCE OF ADMISSIBLE NAMES for the registry's journal.
 * Nothing here reads it as one: it is compared against gate ids in the same
 * document and against nothing else.
 */
function crossFieldGateEvidence(manifest: any): SourceFinding[] {
  const out: SourceFinding[] = [];
  const gates: any[] = Array.isArray(manifest?.procedure?.validation_gates) ? manifest.procedure.validation_gates : [];
  const evidence: any[] = Array.isArray(manifest?.outcome_contract?.evidence) ? manifest.outcome_contract.evidence : [];
  const gateIds = gates.map((g) => (typeof g?.gate_id === "string" ? g.gate_id : null));

  /** the identifier an id would have to be to be nameable from evidence.
   *  A small character set and a capped length can still be made to
   *  carry an encoding by somebody who sets out to build one, so this is a
   *  convenience mapping and never a claim about what the journal admits. */
  const nameable = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "");

  for (let i = 0; i < evidence.length; i += 1) {
    const name = evidence[i];
    if (typeof name !== "string") continue;
    if (gateIds.includes(name)) continue;
    const meant = gateIds.findIndex((id) => id !== null && id !== name && nameable(id) === name);
    if (meant < 0) continue; // an evidence name that names no gate at all is the author's to define
    out.push(
      finding(
        "source_gate_evidence_unresolved",
        `/outcome_contract/evidence/${i}`,
        "FAIL",
        `outcome_contract.evidence[${i}] is \`${name}\`, and the only gate it can mean is /procedure/validation_gates/${meant}/gate_id = \`${gateIds[meant]}\`, which is spelled differently — the two fields do not join up`,
        `rename that gate_id to \`${name}\`, or change this evidence entry to the gate's exact id`,
      ),
    );
  }

  for (let i = 0; i < gateIds.length; i += 1) {
    const id = gateIds[i];
    if (id === null || GENERATED_GATE_ID_RE.test(id)) continue;
    out.push(
      finding(
        "source_gate_id_not_nameable",
        `/procedure/validation_gates/${i}/gate_id`,
        "WARN",
        `gate_id \`${id}\` is outside the identifier form outcome_contract.evidence[] uses, so this gate cannot be named from that field — the package schema still admits it and this is not a refusal`,
        `if you want to reference this gate as evidence, spell it \`${nameable(id)}\`; generated templates use that form for exactly this reason`,
      ),
    );
  }
  return out;
}

/**
 * The eight §7.1 safety gates, run on the source and reported in the profile's
 * own finding shape. The gate runner is the registry's, unchanged: a second
 * copy of a gate is the thing this file exists to prevent, and the gates are
 * the most tempting place to make one.
 *
 * NOTHING NON-PASSING IS DROPPED. This used to skip EVERY `schema` gate report,
 * pass or fail, on the reasoning that the schema errors above already said it.
 * That reasoning holds only when something above actually did say it — and for
 * the two Appendix E cross-field rules, and for the empty-`failure_modes` WARN,
 * nothing did. The consequence was a validator that answered `ok: true` about a
 * source the very next `lint` refuses. So the suppression is now CONDITIONAL on
 * the caller having emitted the pointer-carrying findings, and a schema gate
 * that fails for a reason nothing above reported is reported here.
 */
function safetyGateFindings(
  forShape: any,
  shipped: PackageFiles,
  ctx: SourceProfileContext,
  /** true when the loops above emitted a `source_schema` finding, in which case
   *  the gate's joined sentence would make an author fix one thing twice */
  schemaAlreadyReported: boolean,
): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const report of runGates(forShape, shipped, { nowMs: ctx.nowMs })) {
    if (report.result === "pass") continue;
    if (report.gate === "schema" && schemaAlreadyReported) continue;
    out.push(
      finding(
        "source_safety_gate",
        pointerForGate(report.gate),
        report.result === "fail" ? "FAIL" : "WARN",
        `safety gate \`${report.gate}\`: ${report.details ?? "no detail"}`,
        RECOVERY_BY_GATE[report.gate],
      ),
    );
  }
  return out;
}

/** Where in the manifest a gate's subject lives. `/` where a gate reads the
 *  whole tree rather than a member, which is the honest answer and better than
 *  a pointer that resolves to something the gate did not look at. */
function pointerForGate(gate: GateName): string {
  switch (gate) {
    case "pinning":
      return "/procedure/steps";
    case "staleness":
      return "/lifecycle";
    case "compat":
      return "/runtime";
    default:
      return "/";
  }
}

const RECOVERY_BY_GATE: Record<GateName, string> = {
  schema: "compare the manifest against the Schema Reference for skill-package-v1",
  secrets: "remove the credential and reference it from the environment instead; a value committed to source is a value in every backup",
  pinning: "pin the dependency to an exact version, so a run a year from now installs what you tested",
  urls: "use https and add the host to safety.url_allowlist; a raw IP or a shortener is refused whatever the allowlist says",
  shell: "rewrite the command so what actually runs can be read statically — quote expansions, drop `sudo` and do not pipe a download into a shell",
  injection: "remove the instruction that addresses the agent as a controller rather than describing the task",
  staleness: "refresh lifecycle.last_validated_at, or state the review window this skill really has",
  compat: "declare the runtime the steps need — a step carrying a command cannot run under runtime.shell = ['none']",
};
