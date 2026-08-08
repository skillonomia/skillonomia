// Regenerate the built-in seed package `hello-skillonomia` (§9.1).
//
//   node --experimental-strip-types --no-warnings tools/gen-seed.ts
//
// The seed is the ONE package a fresh instance ships, so that the §9.1
// quickstart has something to adopt before the operator has published
// anything. It is the TV-01 fixture package (deterministic, low risk, no shell
// or network steps) re-identified for the registry and re-signed under the
// built-in `skillonomia-seed` kid, whose PUBLIC key is baked into
// `src/seed.ts` (that is what "baked into the image" means in §9.1).
//
// The signing seed below is a DEMO key with no security value: it signs one
// public fixture package and nothing else, it is documented as such in the
// README, and §9.1 says a real deployment removes the seed package. Rotating
// it means running this tool and pasting the new public key into src/seed.ts.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFromSeedHex, signManifest } from "../src/signing.ts";
import { computeIntegrity, type PackageFiles } from "../src/archive.ts";
import { SEED_AGENT_ID, SEED_KID, SEED_SKILL_ID, SEED_SLUG, SEED_SIGNING_SEED_HEX } from "../src/seed.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "seed", SEED_SLUG);

const skillMd = `# ${SEED_SLUG}

The built-in seed package of a fresh Skillonomia instance (SPEC §9.1). It exists
so a new deployment has one adoptable, deterministic, low-risk package before
anything has been published.

## Procedure

1. Run \`fixtures/tv01.sh\`.
2. Compare its stdout with the expected string \`skillonomia-tv01-ok\`.

Gate \`g1\` passes when the two are equal. A real deployment removes this
package: see "Remove the seed" in the README.
`;

const fixture = readFileSync(join(root, "vectors", "tv-01", "package", "fixtures", "tv01.sh"));

const base = JSON.parse(readFileSync(join(root, "vectors", "tv-01", "package", "skill.json"), "utf8"));
const manifest = {
  ...base,
  skill_id: SEED_SKILL_ID,
  semantic_version: "1.0.0",
  title: SEED_SLUG,
  capability_statement:
    "Built-in seed package: run one deterministic fixture command and verify its output against a declared gate.",
  owner: "skillonomia",
  author_agent: SEED_AGENT_ID,
  access_policy: "workspace",
};

const files: PackageFiles = new Map();
files.set("SKILL.md", Buffer.from(skillMd, "utf8"));
files.set("fixtures/tv01.sh", fixture);
manifest.integrity = computeIntegrity(files);

const { privateKey, publicKeyB64url } = keyFromSeedHex(SEED_SIGNING_SEED_HEX);
const { jws, manifest_hash } = signManifest(manifest, privateKey, SEED_KID);

mkdirSync(join(out, "fixtures"), { recursive: true });
writeFileSync(join(out, "SKILL.md"), skillMd);
writeFileSync(join(out, "fixtures", "tv01.sh"), fixture);
writeFileSync(join(out, "skill.json"), JSON.stringify(manifest));
writeFileSync(join(out, "SIGNATURE.jws"), jws);

console.log(`wrote ${out}`);
console.log(`kid          : ${SEED_KID}`);
console.log(`public key   : ${publicKeyB64url}   <- must equal SEED_PUBLIC_KEY in src/seed.ts`);
console.log(`manifest_hash: ${manifest_hash}`);
