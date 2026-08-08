// P2 auth: Bearer → sha256 → api_keys → AuthContext; §9.1 one-time bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openMigrated } from "../src/db.ts";
import { seedGraph } from "./helpers.ts";
import {
  authenticate,
  mintApiKey,
  bootstrapInstance,
  exchangeBootstrapToken,
  sha256Hex,
} from "../src/auth.ts";

const NOW = 1_754_000_000_000;

test("minted key authenticates to the full AuthContext; only the hash is stored", () => {
  const { db, adopterA, wsA } = seedGraph();
  const { api_key, key_id } = mintApiKey(db, adopterA, NOW);
  const ctx = authenticate(db, `Bearer ${api_key}`);
  assert.equal(ctx.agent_id, adopterA);
  assert.equal(ctx.workspace_id, wsA);
  assert.equal(ctx.role, "member");
  assert.equal(ctx.api_key_id, key_id);
  const row = db.prepare("SELECT key_hash FROM api_keys WHERE id=?").get(key_id) as { key_hash: string };
  assert.equal(row.key_hash, sha256Hex(api_key));
  assert.ok(!row.key_hash.includes(api_key.slice(3, 20)), "secret never stored");
  db.close();
});

test("missing/malformed/unknown Authorization is UNAUTHORIZED", () => {
  const { db } = seedGraph();
  for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer sk_unknown"]) {
    assert.throws(() => authenticate(db, header as string | undefined), /UNAUTHORIZED/);
  }
  db.close();
});

test("revoked key is UNAUTHORIZED", () => {
  const { db, adopterA } = seedGraph();
  const { api_key, key_id } = mintApiKey(db, adopterA, NOW);
  db.prepare("UPDATE api_keys SET revoked_at_ms=? WHERE id=?").run(NOW + 1, key_id);
  assert.throws(() => authenticate(db, `Bearer ${api_key}`), /UNAUTHORIZED/);
  db.close();
});

test("key of a disabled or merged agent is UNAUTHORIZED", () => {
  const { db, adopterA, authorA } = seedGraph();
  const a = mintApiKey(db, adopterA, NOW);
  db.prepare("UPDATE agents SET status='disabled' WHERE id=?").run(adopterA);
  assert.throws(() => authenticate(db, `Bearer ${a.api_key}`), /UNAUTHORIZED/);
  const b = mintApiKey(db, authorA, NOW);
  db.prepare("UPDATE agents SET status='merged', merged_into_agent_id=? WHERE id=?").run(adopterA, authorA);
  assert.throws(() => authenticate(db, `Bearer ${b.api_key}`), /UNAUTHORIZED/);
  db.close();
});

test("agent without a membership row authenticates with role null", () => {
  const { db, wsA } = seedGraph();
  const loner = "01LONER000000000000000000A";
  db.prepare(
    "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?, 'loner', 'agent', 'active', ?)",
  ).run(loner, wsA, NOW);
  const { api_key } = mintApiKey(db, loner, NOW);
  const ctx = authenticate(db, `Bearer ${api_key}`);
  assert.equal(ctx.role, null);
  db.close();
});

// ------------------------------------------------------------------ bootstrap

test("bootstrap creates default workspace, owner (human, role owner), demo-adopter (role member)", () => {
  const db = openMigrated();
  const boot = bootstrapInstance(db, NOW);
  assert.ok(boot, "fresh instance must bootstrap");
  const ws = db.prepare("SELECT name FROM workspaces WHERE id=?").get(boot.workspace_id) as { name: string };
  assert.equal(ws.name, "default");
  const owner = db.prepare("SELECT type FROM agents WHERE id=?").get(boot.owner_agent_id) as { type: string };
  assert.equal(owner.type, "human");
  const demoCtx = authenticate(db, `Bearer ${boot.demo_adopter_token}`);
  assert.equal(demoCtx.agent_id, boot.demo_adopter_agent_id);
  assert.equal(demoCtx.role, "member", "§9.1 demo-adopter auth context is role member");
  db.close();
});

test("bootstrap runs only on an empty instance", () => {
  const db = openMigrated();
  assert.ok(bootstrapInstance(db, NOW));
  assert.equal(bootstrapInstance(db, NOW + 1), null, "second start must not re-issue credentials");
  db.close();
});

test("bootstrap token exchanges exactly once, mints owner key, then is invalid", () => {
  const db = openMigrated();
  const boot = bootstrapInstance(db, NOW)!;
  // the raw bootstrap token is not an API key
  assert.throws(() => authenticate(db, `Bearer ${boot.bootstrap_owner_token}`), /UNAUTHORIZED/);

  const ex = exchangeBootstrapToken(db, boot.state, boot.bootstrap_owner_token, NOW + 10);
  assert.equal(ex.agent_id, boot.owner_agent_id);
  assert.equal(ex.role, "owner");
  assert.match(ex.api_key, /^sk_own_/, "§9.1 bootstrap-exchange owner key shape");
  const ctx = authenticate(db, `Bearer ${ex.api_key}`);
  assert.equal(ctx.role, "owner");

  // one-time: replaying the same token fails
  assert.throws(() => exchangeBootstrapToken(db, boot.state, boot.bootstrap_owner_token, NOW + 20), /UNAUTHORIZED/);
  db.close();
});

test("wrong bootstrap token is UNAUTHORIZED and does not consume the real one", () => {
  const db = openMigrated();
  const boot = bootstrapInstance(db, NOW)!;
  assert.throws(() => exchangeBootstrapToken(db, boot.state, "bt_wrong", NOW), /UNAUTHORIZED/);
  assert.throws(() => exchangeBootstrapToken(db, boot.state, 42, NOW), /INVALID_SCHEMA/);
  const ex = exchangeBootstrapToken(db, boot.state, boot.bootstrap_owner_token, NOW);
  assert.equal(ex.role, "owner");
  db.close();
});
