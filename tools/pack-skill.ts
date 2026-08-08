// Pack and sign a skill package from a source directory.
//
//   npm run pack-skill -- <src-dir> --author <ulid> --seed-hex <64 hex> \
//                         --kid <kid> --out <dir> [--skill-id <ulid>] [--lint]
//
// The test-vector packages under `vectors/` are PRE-SIGNED against a fixed
// author id, which is what makes them byte-reproducible and reviewable. A REAL
// package cannot work that way:
// §4.4 step 3 resolves `kid`
// against `manifest.author_agent`, and `principal.create` mints a fresh ULID
// that nobody chooses, so the author id — and therefore the signature — is a
// property of the DEPLOYMENT the package is published to, not of the source.
//
// So a real skill is committed as SOURCE (`SKILL.md`, `scripts/`,
// `manifest.json` without `integrity`) and signed per deployment. This tool is
// that step, and nothing more:
//
//   * it computes §4.3 `integrity` over the packaged bytes;
//   * it fills `skill_id` and `author_agent`;
//   * it signs the manifest with an Ed25519 seed whose public half the author
//     principal registered through `POST /v1/signing-keys`;
//   * with `--lint` it runs the §7.1 gates locally FIRST, so an author learns
//     that gate 5 refuses a construct before a registry tells them.
//
// It writes files. It talks to no database and no registry: everything after
// this is `skill.create` over HTTP.
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeIntegrity, readDirectory, writeTar, type PackageFiles } from "../src/archive.ts";
import { contentHash, keyFromSeedHex, signManifest } from "../src/signing.ts";
import { runGates, type GateReport } from "../src/gates.ts";

export interface PackOptions {
  /** the principal id the package is authored by — `manifest.author_agent` */
  author: string;
  /** the package's own id; defaults to the source manifest's `skill_id` */
  skillId?: string;
  /** Ed25519 private seed, 64 hex chars */
  seedHex: string;
  /** the `kid` the author registered the matching public key under */
  kid: string;
}

export interface PackResult {
  files: PackageFiles;
  manifest: Record<string, unknown>;
  /** §4.3 content hash over the integrity list — the package's identity */
  content_hash: string;
  paths: string[];
}

/**
 * Read a source directory and produce the signed package IN MEMORY.
 *
 * Everything under the source directory is packaged EXCEPT `manifest.json`
 * itself, which becomes `skill.json`. That exclusion is deliberate: shipping
 * both would put an unsigned near-copy of the manifest inside the integrity
 * list, and a reader would have two documents with equal claim to being the
 * manifest.
 */
export function packSkill(srcDir: string, opts: PackOptions): PackResult {
  const source = readDirectory(srcDir);
  const raw = source.get("manifest.json");
  if (!raw) throw new Error(`pack-skill: ${srcDir}/manifest.json is missing`);

  const files: PackageFiles = new Map();
  for (const [path, bytes] of source) {
    if (path === "manifest.json") continue;
    files.set(path, bytes);
  }
  if (!files.has("SKILL.md")) throw new Error(`pack-skill: ${srcDir}/SKILL.md is missing`);

  const manifest = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  manifest.author_agent = opts.author;
  if (opts.skillId !== undefined) manifest.skill_id = opts.skillId;
  // `integrity` covers exactly the files that ship, so it is computed last and
  // never read from the source.
  manifest.integrity = computeIntegrity(files);

  const { privateKey } = keyFromSeedHex(opts.seedHex);
  const { jws } = signManifest(manifest as never, privateKey, opts.kid);
  files.set("skill.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  files.set("SIGNATURE.jws", Buffer.from(jws, "utf8"));

  return {
    files,
    manifest,
    content_hash: contentHash(manifest.integrity as never),
    paths: [...files.keys()].sort(),
  };
}

/** Run the §7.1 gates over a packed result, exactly as `skill.lint` would. */
export function lintPacked(r: PackResult, nowMs: number): GateReport[] {
  return runGates(r.manifest, r.files, { nowMs });
}

/** Write the package as a directory plus a §4.1b tar of the same bytes. */
export function writePackage(r: PackResult, outDir: string, name: string): { dir: string; tar: string } {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, bytes] of r.files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const tar = join(outDir, `${name}.tar`);
  writeFileSync(tar, writeTar(r.files));
  return { dir, tar };
}

// ---------------------------------------------------------------------- CLI

const VALUE_FLAGS = new Set(["--author", "--skill-id", "--seed-hex", "--kid", "--out", "--name"]);

export function parseArgs(args: string[]): { positional: string[]; flags: Set<string>; options: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`pack-skill: ${a} needs a value`);
      options.set(a, v);
      i += 1;
    } else flags.add(a);
  }
  return { positional, flags, options };
}

function main(argv: string[]): number {
  const { positional, flags, options } = parseArgs(argv.slice(2));
  const src = positional[0];
  const author = options.get("--author");
  const seedHex = options.get("--seed-hex") ?? process.env.SKILLONOMIA_SIGNING_SEED_HEX;
  const kid = options.get("--kid");
  const outDir = options.get("--out");
  if (!src || !author || !seedHex || !kid || !outDir) {
    console.error(
      "usage: pack-skill <src-dir> --author <ulid> --seed-hex <64 hex> --kid <kid> --out <dir> [--skill-id <ulid>] [--name <n>] [--lint]",
    );
    return 2;
  }
  const r = packSkill(src, { author, skillId: options.get("--skill-id"), seedHex, kid });
  const name = options.get("--name") ?? String(r.manifest.title ?? "package");
  const { dir, tar } = writePackage(r, outDir, name);
  console.log(`packed ${src}`);
  console.log(`  skill_id     : ${r.manifest.skill_id}`);
  console.log(`  author_agent : ${r.manifest.author_agent}`);
  console.log(`  kid          : ${kid}`);
  console.log(`  content hash : ${r.content_hash}`);
  console.log(`  files        : ${r.paths.join(", ")}`);
  console.log(`  directory    : ${dir}`);
  console.log(`  archive      : ${tar}`);
  if (flags.has("--lint")) {
    console.log("\n§7.1 gates, run locally (the registry runs the same eight on `skill.lint`):");
    let worst = "pass";
    for (const g of lintPacked(r, Date.now())) {
      console.log(`  ${g.gate.padEnd(10)} ${g.result.toUpperCase().padEnd(4)} ${g.details ?? ""}`);
      if (g.result === "fail") worst = "fail";
      else if (g.result === "warn" && worst === "pass") worst = "warn";
    }
    if (worst === "fail") {
      console.error("\nA gate FAILs — `skill.lint` would refuse the draft→linted transition.");
      return 1;
    }
  }
  return 0;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) process.exitCode = main(process.argv);
