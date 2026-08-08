#!/usr/bin/env node
// Materializes the public test-vector suite TV-01…TV-12 under vectors/.
// Each vector = input files + expected verdict JSON (§4.5). Byte-stable:
// skill.json is written as exact JCS bytes; no timestamps are embedded.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { jcsBytes } from "../src/jcs.ts";
import { keyFromSeedHex, signManifest } from "../src/signing.ts";
import {
  appendixFJcs, TV_SEED_HEX, TV_KID, TV_SKILL_MD, TV_FIXTURE_SH, rawTarEntry, tarOf, paxEntry, paxRecord,
} from "../test/vectors-helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vroot = join(root, "vectors");
const { privateKey } = keyFromSeedHex(TV_SEED_HEX);

interface Vector {
  id: string;
  description: string;
  expected_verdict: string;
  /** package files (directory form) */
  files?: Record<string, Buffer | string>;
  /** raw archive bytes instead of a directory */
  archive?: { name: string; bytes: Buffer };
  registry?: Record<string, unknown>;
}

function baseManifest(): any {
  return JSON.parse(appendixFJcs());
}

function signedFiles(manifest: any, opts?: { kid?: string; seed?: string; skillMd?: string; jwsOverride?: string }) {
  const key = opts?.seed ? keyFromSeedHex(opts.seed) : { privateKey };
  const { jws } = signManifest(manifest, key.privateKey, opts?.kid ?? TV_KID);
  return {
    "SKILL.md": opts?.skillMd ?? TV_SKILL_MD,
    "fixtures/tv01.sh": TV_FIXTURE_SH,
    "skill.json": jcsBytes(manifest),
    "SIGNATURE.jws": opts?.jwsOverride ?? jws,
  };
}

const tamperedMd = TV_SKILL_MD.replace("# hello", "# Hello");

const reordered = (() => {
  const m = baseManifest();
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(m).reverse()) out[k] = m[k];
  return out;
})();

const schemaInvalid = (() => {
  const m = baseManifest();
  delete m.scope;
  return m;
})();

const vectors: Vector[] = [
  { id: "tv-01", description: "valid signed package", expected_verdict: "valid", files: signedFiles(baseManifest()) },
  {
    id: "tv-02", description: "one byte changed in SKILL.md", expected_verdict: "TAMPERED_CONTENT",
    files: { ...signedFiles(baseManifest()), "SKILL.md": tamperedMd },
  },
  {
    id: "tv-03", description: "manifest fields reordered, pretty-printed (JCS invariance)", expected_verdict: "valid",
    files: { ...signedFiles(baseManifest()), "skill.json": Buffer.from(JSON.stringify(reordered, null, 2), "utf8") },
  },
  {
    id: "tv-04", description: "key revoked AFTER countersign", expected_verdict: "valid_but_key_since_revoked",
    files: signedFiles(baseManifest()), registry: { key_revoked_at_ms: "after_countersign" },
  },
  {
    id: "tv-05", description: "key revoked BEFORE countersign", expected_verdict: "invalid_key_revoked_at_signing",
    files: signedFiles(baseManifest()), registry: { key_revoked_at_ms: "before_countersign" },
  },
  {
    id: "tv-06", description: "unknown kid", expected_verdict: "UNKNOWN_KEY",
    files: signedFiles(baseManifest(), { kid: "no-such-kid" }),
  },
  {
    id: "tv-07", description: "schema-invalid manifest (required group removed)", expected_verdict: "INVALID_SCHEMA",
    files: { ...signedFiles(baseManifest()), "skill.json": Buffer.from(JSON.stringify(schemaInvalid), "utf8") },
  },
  {
    id: "tv-08", description: "revoked version", expected_verdict: "revoked",
    files: signedFiles(baseManifest()), registry: { version_state: "revoked", revocation_reason: "security issue" },
  },
  {
    id: "tv-09", description: "superseded version", expected_verdict: "valid_superseded",
    files: signedFiles(baseManifest()), registry: { version_state: "superseded", has_successor: true },
  },
  {
    id: "tv-10", description: "transparency-log hash-chain break (verify-log detects)", expected_verdict: "CHAIN_BROKEN",
    registry: { tamper: "UPDATE transparency_log SET subject_id='forged' WHERE seq=1", detected_by: "verify-log" },
  },
  {
    id: "tv-11a", description: "tar member with ../ traversal", expected_verdict: "MALFORMED_ARCHIVE",
    archive: { name: "package.tar", bytes: tarOf(rawTarEntry("../evil.sh", Buffer.from("x"), "0")) },
  },
  {
    id: "tv-11b", description: "tar member with absolute path", expected_verdict: "MALFORMED_ARCHIVE",
    archive: { name: "package.tar", bytes: tarOf(rawTarEntry("/etc/passwd", Buffer.from("x"), "0")) },
  },
  {
    id: "tv-11c", description: "tar symlink member", expected_verdict: "MALFORMED_ARCHIVE",
    archive: { name: "package.tar", bytes: tarOf(rawTarEntry("link", Buffer.alloc(0), "2", "/etc/passwd")) },
  },
  {
    id: "tv-11d", description: "duplicate tar member", expected_verdict: "MALFORMED_ARCHIVE",
    archive: {
      name: "package.tar",
      bytes: tarOf(rawTarEntry("SKILL.md", Buffer.from("a"), "0"), rawTarEntry("SKILL.md", Buffer.from("b"), "0")),
    },
  },
  {
    id: "tv-11e", description: "case-insensitive path collision", expected_verdict: "MALFORMED_ARCHIVE",
    archive: {
      name: "package.tar",
      bytes: tarOf(rawTarEntry("Skill.md", Buffer.from("a"), "0"), rawTarEntry("skill.MD", Buffer.from("b"), "0")),
    },
  },
  {
    id: "tv-11f", description: "pax path override hiding a traversal behind multi-byte records",
    expected_verdict: "MALFORMED_ARCHIVE",
    archive: {
      name: "package.tar",
      bytes: tarOf(
        paxEntry(Buffer.concat([paxRecord("comment", "многобайтовый-щит"), paxRecord("path", "../evil.sh")])),
        rawTarEntry("innocent.txt", Buffer.from("x"), "0"),
      ),
    },
  },
  {
    id: "tv-12", description: "decompression bomb (ratio and size caps)", expected_verdict: "LIMIT_EXCEEDED",
    archive: { name: "package.tar.gz", bytes: gzipSync(Buffer.alloc(32 * 1024 * 1024)) },
  },
];

rmSync(vroot, { recursive: true, force: true });
for (const v of vectors) {
  const dir = join(vroot, v.id);
  mkdirSync(dir, { recursive: true });
  if (v.files) {
    for (const [rel, content] of Object.entries(v.files)) {
      const target = join(dir, "package", rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, typeof content === "string" ? Buffer.from(content, "utf8") : content);
    }
  }
  if (v.archive) writeFileSync(join(dir, v.archive.name), v.archive.bytes);
  writeFileSync(
    join(dir, "expected.json"),
    JSON.stringify(
      {
        vector: "TV-" + v.id.slice(3),
        description: v.description,
        expected_verdict: v.expected_verdict,
        ...(v.registry ? { registry: v.registry } : {}),
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(`vectors written: ${vectors.map((v) => v.id).join(", ")}`);
