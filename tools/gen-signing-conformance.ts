// THE v1.1 SIGNING CONFORMANCE FIXTURE, GENERATED FROM THE PRODUCTION PROFILE.
//
// WHY A GENERATOR AND NOT A HAND-WRITTEN FILE. The fixture's whole value is that
// it is what `src/signing.ts` actually produces. A file typed by hand agrees
// with the implementation on the day it is typed and silently stops agreeing
// afterwards, and the reader who trusted it has no way to notice. So the bytes
// come out of the production functions, and `test/v1p2-p2d-signing-vectors.test.ts`
// regenerates them on every run and refuses if a single byte moved.
//
// THE KEY IS DERIVED, NEVER WRITTEN DOWN. A 32-byte Ed25519 seed written as a
// literal is a credential-shaped blob in a git object, and a push-side scanner
// that matched it would block a later authorized push permanently — a blob
// cannot be taken back out of a linear history. The seed is therefore COMPUTED
// from an ASCII label with SHA-256, by both implementations, so the fixture is
// reproducible from the label alone while nothing in the tree is shaped like a
// key. What the fixture publishes is the PUBLIC key, which is what the v1.1 signing-conformance contract asks
// for.
//
// WHY THE MANIFEST IS TV-01's. A conformance vector over an invented manifest
// proves the arithmetic and nothing about this registry. TV-01's `skill.json` is
// a real, shipped, schema-valid package manifest whose bytes are already frozen
// by `test/vectors.test.ts`, so the fixture is anchored to something that cannot
// drift underneath it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { jcsBytes, parseJsonStrict, type JcsValue } from "../src/jcs.ts";
import { b64url, keyFromSeedHex, manifestHash, protectedHeaderBytes, signManifest, signingInput } from "../src/signing.ts";

/** The ASCII label the Ed25519 seed is derived from. Not a secret, and not
 *  shaped like one: `seed = SHA-256(label)`, in both implementations. */
export const CONFORMANCE_SEED_LABEL = "skillonomia/v1.1/signing-conformance/key-01";

/** The `kid` the protected header carries. */
export const CONFORMANCE_KID = "skln-conformance-01";

export const MANIFEST_PATH = fileURLToPath(new URL("../vectors/tv-01/package/skill.json", import.meta.url));
export const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/signing-conformance/fixture.json", import.meta.url));

export function seedHexFor(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

export function conformanceManifest(): JcsValue {
  return parseJsonStrict(readFileSync(MANIFEST_PATH, "utf8"));
}

export interface ConformanceCase {
  name: string;
  verdict: "valid" | "invalid";
  jws: string;
  public_key_b64url: string;
  why: string;
}

export interface ConformanceFixture {
  profile: string;
  seed_label: string;
  kid: string;
  manifest_source: string;
  canonical_manifest: JcsValue;
  jcs_utf8: string;
  jcs_bytes_hex: string;
  jcs_byte_length: number;
  sha256_bytes_hex: string;
  sha256_hex: string;
  protected_header_utf8: string;
  protected_header_bytes_hex: string;
  signing_input: string;
  jws: string;
  public_key_b64url: string;
  cases: ConformanceCase[];
}

/**
 * THE REFUSALS, and why each one is a separate case.
 *
 * A conformance fixture that carried only a valid vector would be satisfied by
 * an implementation that returned `valid` unconditionally. Each case below
 * breaks ONE property of the §4.3 profile and leaves the rest intact, so an
 * implementation that skips that property fails exactly here and nowhere else.
 */
export function invalidCases(jws: string, publicKeyB64url: string, kid: string): ConformanceCase[] {
  const [p, , sig] = jws.split(".");
  const flip = (b64: string): string => {
    const raw = Buffer.from(b64, "base64url");
    raw[0] = raw[0]! ^ 0x01;
    return b64url(raw);
  };
  // A DIFFERENT, EQUALLY DERIVED KEY — not a random one, so the fixture stays
  // reproducible from its labels alone.
  const otherKey = keyFromSeedHex(seedHexFor(`${CONFORMANCE_SEED_LABEL}/other`)).publicKeyB64url;
  return [
    {
      name: "signature-bit-flipped",
      verdict: "invalid",
      jws: `${p}..${flip(sig!)}`,
      public_key_b64url: publicKeyB64url,
      why: "one bit of the Ed25519 signature is inverted; every other byte is the profile's own",
    },
    {
      name: "wrong-public-key",
      verdict: "invalid",
      jws,
      public_key_b64url: otherKey,
      why: "the serialization is byte-identical to the valid case and the key is a different one",
    },
    {
      name: "attached-serialization",
      verdict: "invalid",
      jws: `${p}.${b64url(Buffer.from("x", "utf8"))}.${sig}`,
      public_key_b64url: publicKeyB64url,
      why: "the payload segment is non-empty, so this is not the detached serialization the profile fixes",
    },
    {
      name: "base64url-padded",
      verdict: "invalid",
      jws: `${p}..${sig!.replace(/$/, "=")}`,
      public_key_b64url: publicKeyB64url,
      why: "padding is not part of the unpadded base64url alphabet the profile fixes",
    },
    {
      name: "protected-header-not-canonical",
      verdict: "invalid",
      jws: `${b64url(Buffer.from(`{"kid":${JSON.stringify(kid)},"alg":"EdDSA"}`, "utf8"))}..${sig}`,
      public_key_b64url: publicKeyB64url,
      why: "the header members are in the other order, so its bytes are not the canonical bytes for this kid",
    },
    {
      name: "protected-header-extra-member",
      verdict: "invalid",
      jws: `${b64url(Buffer.from(`{"alg":"EdDSA","kid":${JSON.stringify(kid)},"typ":"JWT"}`, "utf8"))}..${sig}`,
      public_key_b64url: publicKeyB64url,
      why: "the profile fixes the header at exactly two members",
    },
    {
      name: "signature-truncated",
      verdict: "invalid",
      jws: `${p}..${b64url(Buffer.from(sig!, "base64url").subarray(0, 63))}`,
      public_key_b64url: publicKeyB64url,
      why: "an Ed25519 signature is 64 bytes and this one is a byte short",
    },
    {
      name: "leading-whitespace",
      verdict: "invalid",
      jws: ` ${jws}`,
      public_key_b64url: publicKeyB64url,
      why: "the serialization is byte-exact, so surrounding whitespace is not tolerated",
    },
  ];
}

export function buildFixture(): ConformanceFixture {
  const manifest = conformanceManifest();
  const kid = CONFORMANCE_KID;
  const { privateKey, publicKeyB64url } = keyFromSeedHex(seedHexFor(CONFORMANCE_SEED_LABEL));
  const jcs = jcsBytes(manifest);
  const digest = createHash("sha256").update(jcs).digest();
  const header = protectedHeaderBytes(kid);
  const { input } = signingInput(manifest, kid);
  const { jws } = signManifest(manifest, privateKey, kid);

  return {
    profile: "EdDSA/Ed25519 detached JWS over SHA-256 of JCS(skill.json) — SPEC.md §4.3",
    seed_label: CONFORMANCE_SEED_LABEL,
    kid,
    manifest_source: "vectors/tv-01/package/skill.json",
    canonical_manifest: manifest,
    jcs_utf8: jcs.toString("utf8"),
    jcs_bytes_hex: jcs.toString("hex"),
    jcs_byte_length: jcs.length,
    sha256_bytes_hex: digest.toString("hex"),
    sha256_hex: manifestHash(manifest),
    protected_header_utf8: header.toString("utf8"),
    protected_header_bytes_hex: header.toString("hex"),
    signing_input: input,
    jws,
    public_key_b64url: publicKeyB64url,
    cases: [
      { name: "valid", verdict: "valid", jws, public_key_b64url: publicKeyB64url, why: "the profile's own output, unmodified" },
      ...invalidCases(jws, publicKeyB64url, kid),
    ],
  };
}

/** The fixture as it is written to disk: two-space JSON with a trailing newline. */
export function serialize(fixture: ConformanceFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(FIXTURE_PATH, serialize(buildFixture()), "utf8");
  process.stdout.write(`wrote ${FIXTURE_PATH}\n`);
}
