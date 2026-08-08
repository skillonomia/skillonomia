// §4.4 verification algorithm (normative). Ships as `skillonomia verify <pkg>`.
import type { Db } from "./sqlite.ts";
import { validateManifest } from "./manifest.ts";
import { computeIntegrity, type PackageFiles } from "./archive.ts";
import { manifestHash, verifyJws } from "./signing.ts";
import { parseJsonStrict, utf8Decode, type JcsValue } from "./jcs.ts";

/**
 * §4.4.8's complete verdict vocabulary, as a RUNTIME constant so a guard test
 * can compare it against the specification. The first eight are outcomes of a
 * verification that ran to a decision; the last five are the failure codes of
 * steps 1–6. None of them is an error code (§6): a verdict is the value of a
 * SUCCESSFUL response's `verdict` field, which is why `NOT_LOGGED` appears here
 * and not in `ErrorCode`.
 */
export const VERDICTS = [
  "valid",
  "valid_superseded",
  "valid_deprecated",
  "valid_but_key_since_revoked",
  "unverifiable_timing",
  "not_verified",
  "revoked",
  "invalid_key_revoked_at_signing",
  "INVALID_SCHEMA",
  "TAMPERED_CONTENT",
  "UNKNOWN_KEY",
  "BAD_SIGNATURE",
  "NOT_LOGGED",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface VerifyOutcome {
  verdict: Verdict;
  detail?: string;
  manifest_hash?: string;
  successor_version_id?: string;
  revocation_reason?: string;
}

export const COUNTERSIGN_EVENT = "countersign";

/**
 * §4.4 steps 1–8. `db` is the registry (steps 3, 5–7). The verifier never
 * trusts author-declared time: the reference clock is the countersign tlog row.
 */
export function verifyPackage(files: PackageFiles, db: Db): VerifyOutcome {
  // 1. parse + schema (strict parse: duplicate keys rejected per RFC 8785 input rules)
  const rawManifest = files.get("skill.json");
  if (!rawManifest) return { verdict: "INVALID_SCHEMA", detail: "skill.json missing" };
  let manifest: any;
  try {
    // strict UTF-8: replacement-decoding would let distinct byte strings share
    // one manifest hash
    manifest = parseJsonStrict(utf8Decode(rawManifest));
  } catch (e: any) {
    return { verdict: "INVALID_SCHEMA", detail: `skill.json: ${e.message}` };
  }
  const val = validateManifest(manifest);
  if (!val.valid) return { verdict: "INVALID_SCHEMA", detail: val.errors.slice(0, 5).join("; ") };

  // §4.1 package layout: SKILL.md at the root is the human/agent-readable
  // runbook and is not optional.
  if (!files.has("SKILL.md")) return { verdict: "INVALID_SCHEMA", detail: "SKILL.md missing at package root" };

  // 2. integrity (exclusions per §4.3.2)
  const recomputed = computeIntegrity(files);
  const declared = manifest.integrity as Array<{ path: string; sha256: string }>;
  const same =
    recomputed.length === declared.length &&
    recomputed.every((e, i) => declared[i].path === e.path && declared[i].sha256 === e.sha256);
  if (!same) return { verdict: "TAMPERED_CONTENT", detail: "integrity list mismatch" };

  // canonicalization can still reject input the schema accepts (e.g. escaped
  // lone surrogates) — that is a verdict, never an uncaught throw
  let mHash: string;
  try {
    mHash = manifestHash(manifest as JcsValue);
  } catch (e: any) {
    return { verdict: "INVALID_SCHEMA", detail: `canonicalization: ${e.message}` };
  }

  // 3. resolve kid → signing key OF author_agent (§4.4.3), REGARDLESS of
  //    revocation status (timing decided in step 7). A kid registered to a
  //    different agent than manifest.author_agent is UNKNOWN for this package.
  const rawJws = files.get("SIGNATURE.jws");
  if (!rawJws) return { verdict: "BAD_SIGNATURE", detail: "SIGNATURE.jws missing", manifest_hash: mHash };
  const jws = rawJws.toString("utf8");
  const parsed = verifyJws(manifest as JcsValue, jws); // parse-only: extract kid
  if (!parsed.ok || !parsed.kid) return { verdict: "BAD_SIGNATURE", detail: parsed.reason, manifest_hash: mHash };
  const key = db
    .prepare("SELECT public_key_ed25519, revoked_at_ms FROM signing_keys WHERE kid=? AND agent_id=?")
    .get(parsed.kid, manifest.author_agent) as
    | { public_key_ed25519: string; revoked_at_ms: number | null }
    | undefined;
  if (!key) return { verdict: "UNKNOWN_KEY", detail: `kid ${parsed.kid} not a key of author_agent`, manifest_hash: mHash };

  // 4. verify JWS
  const sigCheck = verifyJws(manifest as JcsValue, jws, key.public_key_ed25519);
  if (!sigCheck.ok) return { verdict: "BAD_SIGNATURE", detail: sigCheck.reason, manifest_hash: mHash };

  // 5. registry version state. manifest_hash has no UNIQUE constraint in the
  //    D.1 schema, so selection must be deterministic: latest (created_at_ms, id).
  const version = db
    .prepare(
      `SELECT id, state, superseded_by_version_id, revocation_reason FROM skill_versions
       WHERE manifest_hash=? ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
    )
    .get(mHash) as
    | { id: string; state: string; superseded_by_version_id: string | null; revocation_reason: string | null }
    | undefined;
  if (!version) return { verdict: "not_verified", detail: "no registry version for manifest_hash", manifest_hash: mHash };
  if (version.state === "revoked")
    return { verdict: "revoked", revocation_reason: version.revocation_reason ?? undefined, manifest_hash: mHash };
  if (version.state === "superseded")
    return {
      verdict: "valid_superseded",
      successor_version_id: version.superseded_by_version_id ?? undefined,
      manifest_hash: mHash,
    };
  if (version.state === "deprecated") return { verdict: "valid_deprecated", manifest_hash: mHash };
  if (version.state !== "verified" && version.state !== "published")
    return { verdict: "not_verified", detail: `state=${version.state}`, manifest_hash: mHash };

  // 6. transparency-log INCLUSION of manifest_hash (§4.4.6). Inclusion is a
  //    COUNTERSIGN entry for this hash — the event_kind and the subject_id
  //    together, never the subject_id alone.
  //
  //    Subject alone was a hole. §4.4's table puts three namespaces in that one
  //    column (manifest_hash, skill_version_id, kid) and only `countersign`
  //    puts a manifest hash there — but `kid` is caller-chosen over
  //    `[a-z0-9-]{1,64}`, which contains every 64-character lowercase hex
  //    string. Registering a signing key whose kid WAS a victim package's
  //    manifest hash appended `signing_key_registered` with that subject, and
  //    an unfiltered inclusion test read it as proof of a countersign the
  //    registry had never made. §6.1 now closes the kid namespace as well; this
  //    filter is the half that does not depend on any other namespace staying
  //    disjoint.
  const included = db
    .prepare("SELECT 1 AS x FROM transparency_log WHERE event_kind=? AND subject_id=? LIMIT 1")
    .get(COUNTERSIGN_EVENT, mHash) as { x: number } | undefined;
  if (!included) return { verdict: "NOT_LOGGED", manifest_hash: mHash };

  // 7. key-revocation timing (§4.4.7): the reference clock is specifically the
  //    COUNTERSIGN entry (§4.3.8) — the EARLIEST one, by seq.
  //
  //    `unverifiable_timing` is the answer when there is no server-registered
  //    countersign time to compare against. Since step 6 now demands exactly
  //    that entry, a package reaching here always has one, and this branch is a
  //    backstop rather than a reachable outcome: it is what keeps step 7 true
  //    on its own terms if step 6's predicate is ever widened again. The
  //    verdict stays in the §4.4.8 vocabulary because that vocabulary is a
  //    closed contract a consumer switches over, not an inventory of paths.
  if (key.revoked_at_ms == null) return { verdict: "valid", manifest_hash: mHash };
  const countersign = db
    .prepare("SELECT server_at_ms FROM transparency_log WHERE event_kind=? AND subject_id=? ORDER BY seq LIMIT 1")
    .get(COUNTERSIGN_EVENT, mHash) as { server_at_ms: number } | undefined;
  if (!countersign) return { verdict: "unverifiable_timing", manifest_hash: mHash };
  if (key.revoked_at_ms > countersign.server_at_ms)
    return { verdict: "valid_but_key_since_revoked", manifest_hash: mHash };
  return { verdict: "invalid_key_revoked_at_signing", manifest_hash: mHash };
}
