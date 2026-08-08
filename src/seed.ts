// §9.1's seed package — the built-in package of a fresh instance.
//
// A new deployment must be adoptable end to end before the operator has
// published anything, so first start installs ONE signed low-risk package
// (`hello-skillonomia`, deterministic fixture, no shell or network steps) and
// walks it to state `reviewed` through the real surfaces — create → lint →
// review(approve). Nothing here writes a state directly: if the seed package
// stopped passing the §7.1 gates, the seed would fail to install rather than
// appear as a `reviewed` version that never linted.
//
// The reviewer of the seed is the instance owner. That is not the §9.1 demo
// exception but plain §5.1: the seed's author is the `skillonomia-seed`
// principal, never the human, so the owner is an eligible reviewer of it
// (role owner, same workspace, ≠ author). Demo mode (below) is what lets that
// single human also review a package they authored themselves.
import type { Db } from "./sqlite.ts";
import { seedDir } from "./assets.ts";
import type { AuthContext } from "./auth.ts";
import { readDirectory, writeTar } from "./archive.ts";
import type { Registry } from "./service.ts";

/** Fixed ids: the package is PRE-SIGNED, so the author it names must be the
 *  same principal on every instance (`author_agent` must equal the creating
 *  agent — defect #2 — and a signed manifest cannot carry a per-install id). */
export const SEED_AGENT_ID = "01SEED00000000000000000000";
// Crockford base32 (ULID) excludes I, L, O and U — these two constants are
// valid ULIDs, not arbitrary strings.
export const SEED_SKILL_ID = "01SEEDPACKAGE0000000000000";
export const SEED_SLUG = "hello-skillonomia";
export const SEED_KID = "skillonomia-seed";
const SEED_KEY_ROW_ID = "01SEEDKEY00000000000000000";

/** The seed signer's PUBLIC key — this is what §9.1 means by "baked into the
 *  image". The private half lives only in `tools/gen-seed.ts` and is a demo key
 *  by design (it signs one public fixture package; a real deployment removes
 *  the seed entirely). */
export const SEED_PUBLIC_KEY = "MOmq9idi5bgD80FucnBwt7qPx49AJp28q8eJP__8M2Q";

/** Regeneration input for `tools/gen-seed.ts` — never read at runtime. */
export const SEED_SIGNING_SEED_HEX = "5ee0000000000000000000000000000000000000000000000000000000000d01";

export interface SeedResult {
  skill_id: string;
  skill_version_id: string;
  state: string;
}

/** The committed seed directory, packed into a §4.1b archive. */
export function seedArchive(dir: string = seedDir(SEED_SLUG)): Buffer {
  return writeTar(readDirectory(dir));
}

/** Is this instance in §9.1 single-user demo mode? */
export function demoMode(db: Db): boolean {
  const row = db.prepare("SELECT COUNT(*) AS c FROM agents WHERE type='human'").get() as { c: number };
  return row.c === 1;
}

function ctx(agentId: string, workspaceId: string, role: AuthContext["role"]): AuthContext {
  return { agent_id: agentId, workspace_id: workspaceId, role, tool_profile: null, api_key_id: `internal:${agentId}` };
}

/**
 * Install the seed at first start: the `skillonomia-seed` principal and its
 * signing key, then the package through surfaces 1, 2 and 3.
 *
 * The seed principal holds NO API key — it is an authorship identity, not a
 * usable credential — so nothing can authenticate as it afterwards.
 */
export function installSeed(
  registry: Registry,
  db: Db,
  opts: { workspaceId: string; ownerAgentId: string; nowMs: number; dir?: string },
): SeedResult {
  const { workspaceId, ownerAgentId, nowMs } = opts;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?,?, 'service', 'active', ?)",
    ).run(SEED_AGENT_ID, workspaceId, "skillonomia-seed", nowMs);
    db.prepare(
      "INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?, 'member', ?)",
    ).run(SEED_AGENT_ID, workspaceId, nowMs);
    db.prepare(
      "INSERT INTO signing_keys(id, agent_id, kid, public_key_ed25519, created_at_ms) VALUES (?,?,?,?,?)",
    ).run(SEED_KEY_ROW_ID, SEED_AGENT_ID, SEED_KID, SEED_PUBLIC_KEY, nowMs);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw e;
  }

  const seed = ctx(SEED_AGENT_ID, workspaceId, "member");
  const owner = ctx(ownerAgentId, workspaceId, "owner");

  const created = registry.createVersion(seed, { slug: SEED_SLUG, archive: seedArchive(opts.dir) }).response;
  const linted = registry.lintVersion(seed, created.skill_version_id).response;
  if (linted.state !== "linted") {
    throw new Error(`seed package did not pass the §7.1 gates: ${JSON.stringify(linted.reports)}`);
  }
  registry.review(seed, created.skill_version_id, { action: "request" });
  const reviewed = registry.review(owner, created.skill_version_id, { action: "verdict", verdict: "approve" }).response;
  if (reviewed.state !== "reviewed") throw new Error(`seed package did not reach reviewed: ${reviewed.state}`);
  return { skill_id: created.skill_id, skill_version_id: created.skill_version_id, state: reviewed.state };
}

/** The seed's own README paragraph, printed at first start. */
export function seedNotice(result: SeedResult): string {
  return [
    `seed package     : ${SEED_SLUG} (${result.skill_version_id}) — state ${result.state}`,
    `                   signed by kid ${SEED_KID}; remove it in a real deployment (see README).`,
  ].join("\n");
}
