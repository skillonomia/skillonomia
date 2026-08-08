// P2 surface 5: skill.search — §5.1 state-visibility table × access-policy
// precedence, filters, pagination, and the E.2 version-registry-view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p2Fixture, createInState, NOW, type P2Fixture } from "./p2-helpers.ts";
import { insertReceiptEvent } from "./helpers.ts";
import { validatePayload } from "../src/manifest.ts";
import { isApiError } from "../src/errors.ts";
import { ulid } from "../src/ulid.ts";

function slugs(items: Array<{ slug: string }>): Set<string> {
  return new Set(items.map((i) => i.slug));
}

function grantAgent(fx: P2Fixture, skillId: string, agentId: string): void {
  fx.db
    .prepare(
      "INSERT INTO skill_access_grants(id, skill_id, grantee_agent_id, granted_by_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
    )
    .run(ulid(NOW), skillId, agentId, fx.owner.agent_id, NOW);
}

function grantWorkspace(fx: P2Fixture, skillId: string, workspaceId: string): void {
  fx.db
    .prepare(
      "INSERT INTO skill_access_grants(id, skill_id, grantee_workspace_id, granted_by_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
    )
    .run(ulid(NOW), skillId, workspaceId, fx.owner.agent_id, NOW);
}

/** Fixture graph: one skill per (state × access_policy) case under test. */
function searchGraph(fx: P2Fixture) {
  return {
    pubPublic: createInState(fx, "pub-public", "published", { access_policy: "public" }),
    pubWorkspace: createInState(fx, "pub-workspace", "published", { access_policy: "workspace" }),
    revWorkspace: createInState(fx, "rev-workspace", "reviewed", { access_policy: "workspace" }),
    draftWs: createInState(fx, "draft-ws", "draft", { access_policy: "workspace" }),
    privRev: createInState(fx, "priv-rev", "reviewed", { access_policy: "private" }),
    privPub: createInState(fx, "priv-pub", "published", { access_policy: "private" }),
    invPub: createInState(fx, "inv-pub", "published", { access_policy: "invite" }),
    depPub: createInState(fx, "dep-pub", "deprecated", { access_policy: "public" }),
  };
}

test("same-workspace member: sees reviewed/published per policy; never drafts, never ungranted private/invite", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  const { items } = fx.registry.search(fx.member, {});
  const got = slugs(items);
  assert.ok(got.has("pub-public"));
  assert.ok(got.has("pub-workspace"));
  assert.ok(got.has("rev-workspace"));
  assert.ok(got.has("seed-skill"), "seed reviewed workspace-policy version is member-visible");
  assert.ok(got.has("dep-pub"));
  assert.ok(!got.has("draft-ws"), "drafts are owner+admin only (§5.1)");
  assert.ok(!got.has("priv-rev"), "private caps members to grantees");
  assert.ok(!got.has("priv-pub"));
  assert.ok(!got.has("inv-pub"), "invite caps members to grantees");
  fx.db.close();
});

test("draft visibility: author and ws admin/owner see it; a plain member does not", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  assert.ok(slugs(fx.registry.search(fx.author, {}).items).has("draft-ws"), "author sees own draft");
  assert.ok(slugs(fx.registry.search(fx.owner, {}).items).has("draft-ws"), "ws owner sees drafts");
  assert.ok(!slugs(fx.registry.search(fx.member, {}).items).has("draft-ws"));
  fx.db.close();
});

test("private/invite same-workspace: agent grant opens visibility", () => {
  const fx = p2Fixture();
  const g = searchGraph(fx);
  grantAgent(fx, g.privRev.skillId, fx.member.agent_id);
  grantAgent(fx, g.invPub.skillId, fx.member.agent_id);
  const got = slugs(fx.registry.search(fx.member, {}).items);
  assert.ok(got.has("priv-rev"));
  assert.ok(got.has("inv-pub"));
  fx.db.close();
});

test("cross-workspace actor: only published (or post-published) + policy/grant; reviewed NEVER leaks (BLOCKER-9)", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  const got = slugs(fx.registry.search(fx.outsider, {}).items);
  assert.deepEqual(got, new Set(["pub-public", "dep-pub"]));
  fx.db.close();
});

test("cross-workspace invite: workspace-level grant opens published version", () => {
  const fx = p2Fixture();
  const g = searchGraph(fx);
  grantWorkspace(fx, g.invPub.skillId, fx.outsider.workspace_id);
  const got = slugs(fx.registry.search(fx.outsider, {}).items);
  assert.ok(got.has("inv-pub"));
  fx.db.close();
});

test("cross-workspace private: agent grant required; a workspace grant is NOT enough (§3)", () => {
  const fx = p2Fixture();
  const g = searchGraph(fx);
  grantWorkspace(fx, g.privPub.skillId, fx.outsider.workspace_id);
  assert.ok(!slugs(fx.registry.search(fx.outsider, {}).items).has("priv-pub"), "ws grant must not open private");
  grantAgent(fx, g.privPub.skillId, fx.outsider.agent_id);
  assert.ok(slugs(fx.registry.search(fx.outsider, {}).items).has("priv-pub"));
  fx.db.close();
});

test("deprecated/superseded carry a warning; revoked is listed as revoked", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  createInState(fx, "sup-pub", "superseded", { access_policy: "public" });
  createInState(fx, "rvk-pub", "revoked", { access_policy: "public" });
  const { items } = fx.registry.search(fx.outsider, {});
  const bySlug = new Map(items.map((i) => [i.slug, i]));
  assert.equal(bySlug.get("dep-pub")?.warning, "deprecated");
  assert.equal(bySlug.get("sup-pub")?.warning, "superseded");
  assert.equal(bySlug.get("rvk-pub")?.state, "revoked");
  assert.equal(bySlug.get("rvk-pub")?.warning, undefined);
  assert.equal(bySlug.get("pub-public")?.warning, undefined);
  fx.db.close();
});

test("filters: q, state, risk narrow the result set", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  const q = fx.registry.search(fx.member, { q: "pub-workspace" }).items;
  assert.deepEqual(slugs(q), new Set(["pub-workspace"]));
  const st = fx.registry.search(fx.member, { state: "reviewed" }).items;
  assert.ok(slugs(st).has("rev-workspace"));
  assert.ok(!slugs(st).has("pub-public"));
  const risk = fx.registry.search(fx.member, { risk: "high" }).items;
  assert.equal(risk.length, 0, "all fixtures are low risk");
  const low = fx.registry.search(fx.member, { risk: "low" }).items;
  assert.ok(slugs(low).has("pub-public"));
  fx.db.close();
});

test("min_adopted counts only server-recorded adopted events", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  // the seed receipt gains delivered→attempted→adopted
  insertReceiptEvent(fx.db, fx.seed.receipt, "delivered", 1, NOW);
  insertReceiptEvent(fx.db, fx.seed.receipt, "attempted", 2, NOW);
  insertReceiptEvent(fx.db, fx.seed.receipt, "adopted", 3, NOW);
  const all = fx.registry.search(fx.member, { min_adopted: 0 }).items;
  assert.ok(all.length > 1);
  const adopted = fx.registry.search(fx.member, { min_adopted: 1 }).items;
  assert.deepEqual(slugs(adopted), new Set(["seed-skill"]));
  const item = adopted[0];
  assert.equal(item.registry.reputation.adopted_count, 1);
  assert.equal(item.registry.reputation.adoption_attempts, 1);
  assert.deepEqual(item.registry.receipt_ids, [fx.seed.receipt]);
  fx.db.close();
});

test("every returned registry group validates against the E.2 version-registry-view schema", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  const { items } = fx.registry.search(fx.owner, {});
  assert.ok(items.length >= 5);
  for (const item of items) {
    const val = validatePayload("version_registry_view", item.registry);
    assert.ok(val.valid, `${item.slug}: ${val.errors.join("; ")}`);
  }
  fx.db.close();
});

test("pagination: limit + opaque cursor walk the full ordered set exactly once", () => {
  const fx = p2Fixture();
  searchGraph(fx);
  const page1 = fx.registry.search(fx.outsider, { limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.ok(page1.next_cursor, "more results exist");
  const page2 = fx.registry.search(fx.outsider, { limit: 1, cursor: page1.next_cursor! });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.next_cursor, null, "outsider sees exactly 2 versions");
  assert.notEqual(page1.items[0].skill_version_id, page2.items[0].skill_version_id);
  const all = fx.registry.search(fx.outsider, {}).items.map((i) => i.skill_version_id);
  assert.deepEqual([page1.items[0].skill_version_id, page2.items[0].skill_version_id], all);
  fx.db.close();
});

test("invalid search params are INVALID_SCHEMA", () => {
  const fx = p2Fixture();
  for (const params of [
    { limit: 0 },
    { limit: 101 },
    { limit: "abc" },
    { state: "shiny" },
    { risk: "extreme" },
    { min_adopted: -1 },
    { cursor: "///not-a-cursor" },
  ] as const) {
    try {
      fx.registry.search(fx.member, params as any);
      assert.fail(`expected INVALID_SCHEMA for ${JSON.stringify(params)}`);
    } catch (e) {
      if (!isApiError(e)) throw e;
      assert.equal(e.code, "INVALID_SCHEMA", JSON.stringify(params));
    }
  }
  fx.db.close();
});

test("§9.1 quickstart shape: q finds the slug, item exposes slug and state at top level", () => {
  const fx = p2Fixture();
  createInState(fx, "hello-skillonomia", "reviewed", { access_policy: "workspace" });
  const { items } = fx.registry.search(fx.member, { q: "hello-skillonomia" });
  assert.equal(items[0].slug, "hello-skillonomia");
  assert.equal(items[0].state, "reviewed");
  fx.db.close();
});
