// Shared fixtures for §4.5 test vectors: Appendix F package + registry graph.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../src/sqlite.ts";
import { openMigrated } from "../src/db.ts";
import { ulid } from "../src/ulid.ts";
import { keyFromSeedHex, signManifest, manifestHash } from "../src/signing.ts";
import { appendTlog } from "../src/tlog.ts";
import { COUNTERSIGN_EVENT } from "../src/verify.ts";
import { TLOG_KEY_REGISTERED } from "../src/provision.ts";
import type { PackageFiles } from "../src/archive.ts";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TV_SEED_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
export const TV_KID = "tv-key-1";
export const TV_PUB_B64URL = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";

export const TV_SKILL_MD = "# hello-skillonomia (TV-01)\nRun the fixture and report its output.\n";
export const TV_FIXTURE_SH = "echo skillonomia-tv01-ok\n";

/** The exact 1889-byte JCS(M) line from Appendix F of the spec. */
export function appendixFJcs(): string {
  const spec = readFileSync(join(root, "SPEC.md"), "utf8").split("\n");
  const marker = spec.findIndex((l) => l.startsWith("JCS(M), 1889 bytes, exact:"));
  const fenceOpen = spec.findIndex((l, i) => i > marker && l === "```");
  return spec[fenceOpen + 1];
}

export function tv01Manifest(): any {
  return JSON.parse(appendixFJcs());
}

/** Build the TV-01 package files (signed with the deterministic key). */
export function tv01Package(): PackageFiles {
  const manifest = tv01Manifest();
  const { privateKey } = keyFromSeedHex(TV_SEED_HEX);
  const { jws } = signManifest(manifest, privateKey, TV_KID);
  const files: PackageFiles = new Map();
  files.set("SKILL.md", Buffer.from(TV_SKILL_MD, "utf8"));
  files.set("fixtures/tv01.sh", Buffer.from(TV_FIXTURE_SH, "utf8"));
  files.set("skill.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  files.set("SIGNATURE.jws", Buffer.from(jws, "utf8"));
  return files;
}

/** Raw tar entry builder for adversarial fixtures (valid checksum, arbitrary type/name). */
export function rawTarEntry(name: string, data: Buffer, typeflag: string, linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header[156] = typeflag.charCodeAt(0);
  header.write(linkname, 157, "utf8");
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = Math.ceil(data.length / 512) * 512 - data.length;
  return Buffer.concat([header, data, Buffer.alloc(pad)]);
}

export function tarOf(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

/** Pax extended-header entry with raw record bytes (for byte-length parsing tests). */
export function paxEntry(records: Buffer): Buffer {
  return rawTarEntry("pax-header", records, "x");
}

/** Build one pax record with BYTE-accurate length prefix. */
export function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  // length includes the digits themselves: iterate to fixed point
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.concat([Buffer.from(String(len), "ascii"), body]);
}

export interface RegistryFixture {
  db: Db;
  versionId: string;
  keyId: string;
  countersignAtMs: number;
  mHash: string;
}

/**
 * Registry graph for the TV package: workspace, author, signing key (TV_KID),
 * skill + version holding the TV manifest_hash, countersign tlog entry.
 */
export function tvRegistry(opts?: {
  state?: string;
  keyRevokedAtMs?: number | null;
  skipCountersign?: boolean;
  supersededBy?: boolean;
  keyOwnedByOtherAgent?: boolean; // §4.4.3 author-binding negative
  /** a NON-countersign tlog row whose subject_id is the manifest_hash — the
   *  shape `signing_key.register` writes, and the shape §4.4 step 6 must not
   *  read as inclusion */
  nonCountersignRowOnHash?: boolean;
  /** write to a real file instead of :memory: — what the CLI tests hand to
   *  `skillonomia verify --db`, since a subprocess cannot share memory */
  dbPath?: string;
}): RegistryFixture {
  const db = openMigrated(opts?.dbPath);
  const now = 1_754_000_000_000;
  const countersignAtMs = now + 5_000;
  const ws = ulid(now);
  db.prepare("INSERT INTO workspaces(id, name, created_at_ms) VALUES (?,?,?)").run(ws, "tv-ws", now);
  // §4.4.3 author binding: the signing key MUST belong to manifest.author_agent,
  // so the fixture agent carries the exact id from the Appendix F manifest.
  const author = tv01Manifest().author_agent as string;
  db.prepare(
    "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?,?,?, 'active', ?)",
  ).run(author, ws, "tv-author", "agent", now);
  let keyOwner = author;
  if (opts?.keyOwnedByOtherAgent) {
    keyOwner = ulid(now);
    db.prepare(
      "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?,?,?, 'active', ?)",
    ).run(keyOwner, ws, "other-agent", "agent", now);
  }
  const keyId = ulid(now);
  db.prepare(
    "INSERT INTO signing_keys(id, agent_id, kid, public_key_ed25519, created_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?)",
  ).run(keyId, keyOwner, TV_KID, TV_PUB_B64URL, now, opts?.keyRevokedAtMs ?? null);

  const skill = ulid(now);
  db.prepare(
    "INSERT INTO skills(id, workspace_id, slug, owner_agent_id, access_policy, created_at_ms) VALUES (?,?,?,?, 'workspace', ?)",
  ).run(skill, ws, "hello-skillonomia", author, now);

  const manifest = tv01Manifest();
  const mHash = manifestHash(manifest);
  const versionId = ulid(now);
  db.prepare(
    `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
       manifest_hash, content_hash, package_blob_ref, signature_jws, state, created_at_ms)
     VALUES (?,?,?,?,?,?,?, 'blob:tv01', 'sig', ?, ?)`,
  ).run(versionId, skill, "1.0.0", author, JSON.stringify(manifest), mHash, "c".repeat(64), opts?.state ?? "published", now);

  if (opts?.supersededBy) {
    const v2 = ulid(now);
    db.prepare(
      `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
         manifest_hash, content_hash, package_blob_ref, signature_jws, state, created_at_ms)
       VALUES (?,?,?,?, '{}', ?, ?, 'blob:v2', 'sig', 'published', ?)`,
    ).run(v2, skill, "2.0.0", author, "d".repeat(64), "e".repeat(64), now);
    db.exec(`UPDATE skill_versions SET superseded_by_version_id='${v2}' WHERE id='${versionId}'`);
  }

  if (opts?.nonCountersignRowOnHash) {
    // a row of one of the OTHER eight §4.4 kinds, addressed at the manifest
    // hash: what an attacker gets by registering a kid equal to that hash
    appendTlog(db, TLOG_KEY_REGISTERED, mHash, { kid: mHash, agent_id: keyOwner }, countersignAtMs);
  } else if (!opts?.skipCountersign) {
    appendTlog(db, COUNTERSIGN_EVENT, mHash, { manifest_hash: mHash, skill_version_id: versionId }, countersignAtMs);
  }
  return { db, versionId, keyId, countersignAtMs, mHash };
}
