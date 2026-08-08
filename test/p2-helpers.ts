// P2 shared fixtures: parameterized valid packages + a seeded Registry.
import type { Db } from "../src/sqlite.ts";
import { seedGraph, type Seed } from "./helpers.ts";
import { tv01Manifest, TV_SEED_HEX, TV_KID } from "./vectors-helpers.ts";
import { computeIntegrity, writeTar, type PackageFiles } from "../src/archive.ts";
import { keyFromSeedHex, signManifest } from "../src/signing.ts";
import { Registry } from "../src/service.ts";
import type { AuthContext, Role } from "../src/auth.ts";
import { ulid } from "../src/ulid.ts";

export const NOW = 1_754_100_000_000;

/** A schema-valid manifest derived from the Appendix F vector, overridable. */
export function makeManifest(overrides: Record<string, unknown> = {}): any {
  const m = JSON.parse(JSON.stringify(tv01Manifest()));
  m.skill_id = ulid(NOW);
  m.title = "P2 test skill";
  m.capability_statement = "A deterministic package used by the P2 registry-core test suite.";
  return Object.assign(m, overrides);
}

export interface BuiltPackage {
  tar: Buffer;
  files: PackageFiles;
  manifest: any;
}

/**
 * Build a signed §4.1b tar for `manifest`: SKILL.md + extras hashed into
 * integrity, skill.json + detached JWS excluded per §4.3.2.
 */
export function buildPackage(manifest: any, extraFiles: Record<string, string> = {}): BuiltPackage {
  const files: PackageFiles = new Map();
  files.set("SKILL.md", Buffer.from(`# ${manifest.title}\nRun the fixture.\n`, "utf8"));
  for (const [path, content] of Object.entries(extraFiles)) {
    files.set(path, Buffer.from(content, "utf8"));
  }
  manifest.integrity = computeIntegrity(files);
  const { privateKey } = keyFromSeedHex(TV_SEED_HEX);
  const { jws } = signManifest(manifest, privateKey, TV_KID);
  files.set("skill.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  files.set("SIGNATURE.jws", Buffer.from(jws, "utf8"));
  return { tar: writeTar(files), files, manifest };
}

export function ctxFor(seed: Seed, agentId: string, workspaceId: string, role: Role | null): AuthContext {
  return { agent_id: agentId, workspace_id: workspaceId, role, tool_profile: null, api_key_id: `test-${agentId}` };
}

export interface P2Fixture {
  seed: Seed;
  db: Db;
  registry: Registry;
  /** authorA as member of wsA */
  author: AuthContext;
  /** ownerA (human) as owner of wsA */
  owner: AuthContext;
  /** adopterA as plain member of wsA */
  member: AuthContext;
  /** adopterB as member of wsB (cross-workspace actor) */
  outsider: AuthContext;
}

export function p2Fixture(): P2Fixture {
  const seed = seedGraph();
  const registry = new Registry(seed.db, { now: () => NOW });
  return {
    seed,
    db: seed.db,
    registry,
    author: ctxFor(seed, seed.authorA, seed.wsA, "member"),
    owner: ctxFor(seed, seed.ownerA, seed.wsA, "owner"),
    member: ctxFor(seed, seed.adopterA, seed.wsA, "member"),
    outsider: ctxFor(seed, seed.adopterB, seed.wsB, "member"),
  };
}

/** Create a version through the real surface and force its lifecycle state. */
export function createInState(
  fx: P2Fixture,
  slug: string,
  state: string,
  opts: { access_policy?: string; semver?: string; author?: AuthContext } = {},
): { skillId: string; versionId: string } {
  const author = opts.author ?? fx.author;
  const manifest = makeManifest({
    author_agent: author.agent_id,
    access_policy: opts.access_policy ?? "workspace",
    semantic_version: opts.semver ?? "1.0.0",
  });
  const { tar } = buildPackage(manifest);
  const res = fx.registry.createVersion(author, { slug, archive: tar }).response;
  if (state !== "draft") {
    fx.db.prepare("UPDATE skill_versions SET state=? WHERE id=?").run(state, res.skill_version_id);
  }
  return { skillId: res.skill_id, versionId: res.skill_version_id };
}
