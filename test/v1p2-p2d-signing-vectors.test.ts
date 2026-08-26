// G-P2-16 — THE SIGNING CONFORMANCE VECTORS, AND THE SECOND IMPLEMENTATION.
//
// WHAT THE v1.1 SIGNING-CONFORMANCE CONTRACT ASKS FOR AND WHY THE SECOND IMPLEMENTATION IS THE WHOLE POINT.
// A signing profile is a claim about BYTES: this canonicalization, this digest,
// these protected-header bytes, this signing input, this serialization. A single
// implementation cannot be wrong about its own output — whatever it emits is
// what it emits — so a fixture generated and then checked by the same code
// proves only that the code is deterministic. What catches a profile that is
// under-specified is a SECOND implementation, written from the specification
// rather than from the first, arriving at the same bytes.
//
// `fixtures/signing-conformance/validate.py` is that implementation. It imports
// nothing from this repository and nothing outside the Python standard library:
// JCS, the SHA-256 chain, the header bytes, the detached-JWS grammar and
// Ed25519 itself are re-derived there from RFC 8785, RFC 8032 and §4.3. The
// independence is asserted below rather than asserted in a comment — the file's
// own text is read and searched for an import of this tree.
//
// AND THE FIXTURE CANNOT DRIFT. It is regenerated here from the production
// functions and compared byte for byte with the committed file, so a change to
// `src/signing.ts` that nobody meant to make fails here rather than in an
// adopter's verifier.
//
// THE DISCRIMINATION. Two implementations that agree prove nothing unless
// disagreement is something the harness can actually see. So the last test
// hands the Python validator a fixture with one byte moved and requires it to
// refuse — if it passed that too, every agreement above would be worthless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { jcsBytes } from "../src/jcs.ts";
import { verifyJws } from "../src/signing.ts";
import {
  buildFixture,
  CONFORMANCE_KID,
  CONFORMANCE_SEED_LABEL,
  FIXTURE_PATH,
  seedHexFor,
  serialize,
  type ConformanceFixture,
} from "../tools/gen-signing-conformance.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VALIDATOR = join(ROOT, "fixtures/signing-conformance/validate.py");

const committed = (): string => readFileSync(FIXTURE_PATH, "utf8");
const fixture = (): ConformanceFixture => JSON.parse(committed()) as ConformanceFixture;

interface PythonReport {
  ok: boolean;
  refused?: string;
  imports_production_code?: boolean;
  fields_compared?: number;
  cases_compared?: number;
  disagreements?: Array<{ field: string; python: unknown; fixture: unknown }>;
}

/**
 * The Python validator's own verdict on a fixture file.
 *
 * A MISSING INTERPRETER IS A FAILURE, NOT A SKIP. This gate's entire subject is
 * that a second implementation agrees; a run that quietly skipped it would
 * report a green gate having checked nothing, which is the mechanism this
 * repository has removed from document discovery twice.
 */
function python(path: string): { code: number; report: PythonReport } {
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync("python3", [VALIDATOR, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; code?: string; message?: string };
    if (err.status === undefined) {
      assert.fail(
        `the independent validator could not be RUN (${err.code ?? err.message}). G-P2-16 is the claim that a second ` +
          "implementation agrees byte for byte; an interpreter that is absent makes that claim uncheckable, and an " +
          "uncheckable claim is not a passing one.",
      );
    }
    code = err.status!;
    stdout = String(err.stdout ?? "");
  }
  let report: PythonReport;
  try {
    report = JSON.parse(stdout) as PythonReport;
  } catch {
    assert.fail(`the independent validator did not answer with JSON: ${JSON.stringify(stdout.slice(0, 400))}`);
  }
  return { code, report };
}

// ===========================================================================
// the fixture
// ===========================================================================

test("G-P2-16: the committed fixture is byte-for-byte what the production profile produces", () => {
  assert.equal(
    committed(),
    serialize(buildFixture()),
    "fixtures/signing-conformance/fixture.json is not what src/signing.ts produces today. Regenerate it with " +
      "`node --experimental-strip-types tools/gen-signing-conformance.ts` and read the diff before committing it: a " +
      "moved byte here is a changed signing profile.",
  );
});

test("G-P2-16: the fixture carries every member the v1.1 signing-conformance contract requires, and each is the real thing", () => {
  const f = fixture();
  const manifestBytes = jcsBytes(f.canonical_manifest);

  // canonical manifest JSON, and the EXACT JCS bytes — as text and as bytes,
  // because an adopter re-deriving the profile needs to compare either one.
  assert.equal(f.jcs_utf8, manifestBytes.toString("utf8"), "the fixture's JCS text is not JCS(canonical_manifest)");
  assert.equal(f.jcs_bytes_hex, manifestBytes.toString("hex"), "the fixture's JCS bytes are not JCS(canonical_manifest)");
  assert.equal(f.jcs_byte_length, manifestBytes.length);
  assert.equal(Buffer.from(f.jcs_bytes_hex, "hex").toString("utf8"), f.jcs_utf8, "the two spellings of the JCS bytes disagree");

  // SHA-256, as bytes and as hex.
  const digest = createHash("sha256").update(manifestBytes).digest();
  assert.equal(f.sha256_bytes_hex, digest.toString("hex"));
  assert.equal(f.sha256_hex, digest.toString("hex"));
  assert.equal(digest.length, 32);

  // the EXACT protected-header bytes, with nothing else in them.
  assert.equal(f.protected_header_utf8, `{"alg":"EdDSA","kid":"${CONFORMANCE_KID}"}`);
  assert.equal(Buffer.from(f.protected_header_bytes_hex, "hex").toString("utf8"), f.protected_header_utf8);

  // the signing input, which is the two b64url segments and a dot.
  const [headerSeg, digestSeg, ...rest] = f.signing_input.split(".");
  assert.equal(rest.length, 0, "the signing input has more than two segments");
  assert.equal(Buffer.from(headerSeg!, "base64url").toString("hex"), f.protected_header_bytes_hex);
  assert.equal(Buffer.from(digestSeg!, "base64url").toString("hex"), f.sha256_bytes_hex);

  // the DETACHED JWS: three segments with an empty middle one.
  const parts = f.jws.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[1], "", "the serialization is not detached — the payload segment is not empty");
  assert.equal(parts[0], headerSeg, "the JWS header segment is not the signing input's header segment");
  assert.equal(Buffer.from(parts[2]!, "base64url").length, 64, "an Ed25519 signature is 64 bytes");

  // the public key, which is the raw 32 bytes and not an SPKI blob.
  assert.equal(Buffer.from(f.public_key_b64url, "base64url").length, 32);

  // and the expected verdicts, both kinds of them.
  const verdicts = new Set(f.cases.map((c) => c.verdict));
  assert.ok(verdicts.has("valid"), "the fixture states no valid verdict");
  assert.ok(verdicts.has("invalid"), "the fixture states no invalid verdict, so a validator that always says `valid` passes it");
  assert.ok(f.cases.filter((c) => c.verdict === "invalid").length >= 5, "too few refusals to discriminate between profiles");
  for (const c of f.cases) assert.ok(c.why.length > 20, `${c.name}: the fixture does not say what it is testing`);
});

test("G-P2-16: the TypeScript validator reaches every verdict the fixture states", () => {
  const f = fixture();
  for (const c of f.cases) {
    const got = verifyJws(f.canonical_manifest, c.jws, c.public_key_b64url).ok ? "valid" : "invalid";
    assert.equal(got, c.verdict, `${c.name}: src/signing.ts says ${got} where the fixture states ${c.verdict} — ${c.why}`);
  }
});

test("G-P2-16: the key is DERIVED from a label, so no credential-shaped literal is committed", () => {
  const f = fixture();
  assert.equal(f.seed_label, CONFORMANCE_SEED_LABEL);
  // The label is what regenerates the key, and the fixture publishes the public
  // half only. A reader can reproduce every byte from the label; nothing here
  // is a secret, and nothing here is SHAPED like one.
  const seedHex = seedHexFor(f.seed_label);
  assert.equal(seedHex.length, 64, "the derived seed is not 32 bytes");
  assert.equal(committed().includes(seedHex), false, "the derived private seed was written into the published fixture");
  const generator = readFileSync(join(ROOT, "tools/gen-signing-conformance.ts"), "utf8");
  assert.equal(generator.includes(seedHex), false, "the derived private seed is a literal in the generator");
  assert.equal(/[0-9a-f]{64}/.test(generator.replace(/302[ea0-9a-f]*/g, "")), false, "the generator holds a 64-hex literal");
});

// ===========================================================================
// the independent implementation
// ===========================================================================

test("G-P2-16: the Python validator imports no production signing code", () => {
  const source = readFileSync(VALIDATOR, "utf8");
  // Read the IMPORT STATEMENTS rather than searching the prose: the file's
  // header discusses `src/signing.ts` at length, and a substring search would
  // be answered by that sentence instead of by the file's dependencies.
  const imported: string[] = [];
  for (const m of source.matchAll(/^\s*(?:from\s+([A-Za-z0-9_.]+)\s+)?import\s+([A-Za-z0-9_., ]+)/gm)) {
    for (const name of (m[1] ?? m[2]!).split(",")) imported.push(name.trim().split(".")[0]!.split(" ")[0]!);
  }
  assert.ok(imported.length > 0, "no import statement was parsed out of the validator — this guard is reading it wrong");
  const STDLIB = new Set(["base64", "hashlib", "json", "sys", "unicodedata"]);
  const foreign = [...new Set(imported)].filter((n) => !STDLIB.has(n));
  assert.deepEqual(foreign, [], `the independent validator imports ${foreign.join(", ")} — it must stand on the standard library alone`);
  // …and it does not reach this tree by any other route either.
  for (const escape of ["subprocess", "importlib", "src/", "node ", "require("]) {
    assert.equal(source.includes(`\n${escape}`), false, `the validator reaches out through ${escape}`);
  }
  // The properties it must RE-DERIVE rather than take from the fixture.
  for (const derived of ["def jcs(", "def ed25519_verify(", "def ed25519_public_key(", "def protected_header_bytes("]) {
    assert.ok(source.includes(derived), `the validator does not re-derive ${derived} and so is not a second implementation`);
  }
});

test("G-P2-16: the two implementations agree byte for byte", () => {
  const { code, report } = python(FIXTURE_PATH);
  assert.deepEqual(report.disagreements ?? [], [], "the independent validator disagrees with the fixture");
  assert.equal(report.ok, true);
  assert.equal(code, 0, "the independent validator exited non-zero on the committed fixture");
  assert.equal(report.imports_production_code, false);
  assert.equal(report.cases_compared, fixture().cases.length, "the validator did not judge every case the fixture states");
  assert.ok((report.fields_compared ?? 0) >= 9, `only ${report.fields_compared} fields were compared`);
  console.log(`[G-P2-16] python3 agreed on ${report.fields_compared} fields and ${report.cases_compared} verdicts`);
});

test("G-P2-16: the agreement discriminates — a moved byte is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "skln-conformance-"));
  try {
    // EACH MUTATION BREAKS ONE FIELD AND LEAVES THE REST INTACT, so a validator
    // that checked only the first field, or only the verdicts, is caught by the
    // mutation it ignores.
    const mutations: Array<[string, (f: ConformanceFixture) => void]> = [
      ["a byte of the JCS text", (f) => { f.jcs_utf8 = `${f.jcs_utf8.slice(0, -1)} `; }],
      ["a digit of the digest", (f) => { f.sha256_hex = `0${f.sha256_hex.slice(1)}`; }],
      ["the order of the header members", (f) => { f.protected_header_utf8 = `{"kid":"${f.kid}","alg":"EdDSA"}`; }],
      ["the signing input", (f) => { f.signing_input = f.signing_input.replace(".", "A."); }],
      ["the published public key", (f) => { f.public_key_b64url = `A${f.public_key_b64url.slice(1)}`; }],
      ["an expected verdict", (f) => { f.cases[1]!.verdict = "valid"; }],
      ["a manifest value the signature covers", (f) => { (f.canonical_manifest as any).owner = "somebody-else"; }],
    ];
    for (const [what, mutate] of mutations) {
      const f = fixture();
      mutate(f);
      const path = join(dir, "mutated.json");
      writeFileSync(path, serialize(f), "utf8");
      const { code, report } = python(path);
      assert.equal(report.ok, false, `the independent validator ACCEPTED a fixture with ${what} changed`);
      assert.notEqual(code, 0, `the independent validator exited 0 on a fixture with ${what} changed`);
    }
    console.log(`[G-P2-16] the independent validator refused all ${mutations.length} mutations`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
