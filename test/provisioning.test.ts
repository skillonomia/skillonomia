// Provisioning: principals, their API keys, and their own signing keys.
//
// The headline case is the last one in this file — a full lifecycle over a
// REAL listener, from a first-start bootstrap to a `published` version, using
// nothing but HTTP. Before these surfaces existed that run was impossible: the
// only writers of `signing_keys` were the built-in seed and a direct-SQL tool,
// and §4.4 step 3 resolves a package's `kid` against `manifest.author_agent`,
// so a package signed by any NEW principal could only ever verify as
// `UNKNOWN_KEY`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { serve } from "../src/server.ts";
import { computeIntegrity, writeTar, type PackageFiles } from "../src/archive.ts";
import { keyFromSeedHex, signManifest } from "../src/signing.ts";
import { TLOG_KEY_REGISTERED, TLOG_KEY_REVOKED } from "../src/provision.ts";
import { p4Fixture, rest, mcp, env, NOW, type P4Fixture } from "./p6-helpers.ts";
import { makeManifest } from "./p2-helpers.ts";
import { tv01Manifest } from "./vectors-helpers.ts";
import { ulid } from "../src/ulid.ts";

/** A deterministic Ed25519 pair for a test principal — never a real key. */
function pair(seedByte: number): { publicKey: string; privateKey: ReturnType<typeof keyFromSeedHex>["privateKey"] } {
  const seed = Buffer.alloc(32, seedByte).toString("hex");
  const { privateKey, publicKeyB64url } = keyFromSeedHex(seed);
  return { publicKey: publicKeyB64url, privateKey };
}

const KEY_A = pair(0x11);
const KEY_B = pair(0x22);

// ---------------------------------------------------------------- principals

test("only admin/owner may create a principal, and never one that outranks them (§6 manage-memberships)", () => {
  const fx = p4Fixture();

  const created = rest(fx, "POST", "/v1/principals", fx.keys.owner, {
    name: "provisioned-agent",
    type: "agent",
    role: "member",
  });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.body.role, "member");
  assert.equal(created.body.type, "agent");
  assert.equal(created.body.status, "active");
  assert.equal(created.body.workspace_id, fx.seed.wsA, "the workspace comes from AuthContext, never from a payload");
  assert.match(created.body.api_key, /^sk_/, "the API key is issued with the principal");

  // …and the key WORKS immediately: this is the whole point of the surface
  const asNew = rest(fx, "GET", "/v1/principals", created.body.api_key);
  assert.equal(asNew.status, 200);
  assert.deepEqual(
    asNew.body.items.map((i: any) => i.principal_id),
    [created.body.principal_id],
    "a plain member sees exactly its own row — which is how it learns its own principal_id",
  );

  // deny is the default: everything below admin is FORBIDDEN
  for (const who of ["member", "author", "reviewer"] as const) {
    const res = rest(fx, "POST", "/v1/principals", fx.keys[who], { name: `x-${who}`, type: "agent", role: "member" });
    assert.equal(res.status, 403, `${who} must not create principals`);
    assert.equal(res.body.error.code, "FORBIDDEN");
  }

  // no escalation: an admin cannot mint an owner and then use it
  const escalate = rest(fx, "POST", "/v1/principals", fx.keys.admin, {
    name: "would-be-owner",
    type: "human",
    role: "owner",
  });
  assert.equal(escalate.status, 403, escalate.raw);
  assert.match(escalate.body.error.message, /outranks/);
  // …while an owner may create one
  assert.equal(
    rest(fx, "POST", "/v1/principals", fx.keys.owner, { name: "second-owner", type: "human", role: "owner" }).status,
    201,
  );
  fx.db.close();
});

test("principal.create validates its inputs and reports a name clash as CONFLICT + current_state", () => {
  const fx = p4Fixture();
  const ok = { name: "dup", type: "agent", role: "member" };
  assert.equal(rest(fx, "POST", "/v1/principals", fx.keys.owner, ok).status, 201);

  const dup = rest(fx, "POST", "/v1/principals", fx.keys.owner, ok);
  assert.equal(dup.status, 409, dup.raw);
  assert.equal(dup.body.error.code, "CONFLICT");
  assert.equal(dup.body.error.current_state, "active", "Appendix H: a CONFLICT carries the current state");

  for (const bad of [
    {},
    { name: "", type: "agent", role: "member" },
    { name: "x", type: "robot", role: "member" },
    { name: "x", type: "agent", role: "superuser" },
    { name: "x", type: "agent" },
    { name: "a".repeat(121), type: "agent", role: "member" },
  ]) {
    const res = rest(fx, "POST", "/v1/principals", fx.keys.owner, bad);
    assert.equal(res.status, 400, `${JSON.stringify(bad)} → ${res.raw}`);
    assert.equal(res.body.error.code, "INVALID_SCHEMA");
  }
  fx.db.close();
});

test("API keys: reissue works, revocation stops authentication, and rank is respected", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/principals", fx.keys.owner, { name: "rotator", type: "agent", role: "member" })
    .body;

  // the first key authenticates
  assert.equal(rest(fx, "GET", "/v1/signing-keys", created.api_key).status, 200);

  // a REISSUE is how a lost key is recovered without SQL. "Issued exactly
  // once" is about DISPLAY: a new key is a new secret, shown once as well.
  const second = rest(fx, "POST", `/v1/principals/${created.principal_id}/api-keys`, fx.keys.owner, {});
  assert.equal(second.status, 201, second.raw);
  assert.notEqual(second.body.api_key, created.api_key);
  assert.equal(rest(fx, "GET", "/v1/signing-keys", second.body.api_key).status, 200);

  // revoking the first one takes effect immediately, and does not touch the second
  const revoked = rest(
    fx,
    "POST",
    `/v1/principals/${created.principal_id}/api-keys/${created.api_key_id}/revoke`,
    fx.keys.owner,
    {},
  );
  assert.equal(revoked.status, 200, revoked.raw);
  assert.equal(revoked.body.revoked_at_ms, NOW);
  assert.equal(rest(fx, "GET", "/v1/signing-keys", created.api_key).status, 401, "a revoked key is not a credential");
  assert.equal(rest(fx, "GET", "/v1/signing-keys", second.body.api_key).status, 200);

  // convergent: revoking again reports the ORIGINAL time and does not move it
  const again = rest(
    fx,
    "POST",
    `/v1/principals/${created.principal_id}/api-keys/${created.api_key_id}/revoke`,
    fx.keys.owner,
    {},
  );
  assert.equal(again.status, 200);
  assert.equal(again.body.noop, true);
  assert.equal(again.body.revoked_at_ms, revoked.body.revoked_at_ms);

  // a principal may retire its OWN key without an admin
  const selfRevoke = rest(
    fx,
    "POST",
    `/v1/principals/${created.principal_id}/api-keys/${second.body.api_key_id}/revoke`,
    second.body.api_key,
    {},
  );
  assert.equal(selfRevoke.status, 200, selfRevoke.raw);

  // …but not another principal's
  const third = rest(fx, "POST", "/v1/principals", fx.keys.owner, { name: "bystander", type: "agent", role: "member" })
    .body;
  const trespass = rest(
    fx,
    "POST",
    `/v1/principals/${third.principal_id}/api-keys/${third.api_key_id}/revoke`,
    rest(fx, "POST", `/v1/principals/${created.principal_id}/api-keys`, fx.keys.owner, {}).body.api_key,
    {},
  );
  assert.equal(trespass.status, 403, trespass.raw);

  // rank: an admin may not disarm an owner
  const ownerRow = rest(fx, "GET", "/v1/principals", fx.keys.owner).body.items.find((i: any) => i.role === "owner");
  const ownerKeyAttack = rest(fx, "POST", `/v1/principals/${ownerRow.principal_id}/api-keys`, fx.keys.admin, {});
  assert.equal(ownerKeyAttack.status, 403, ownerKeyAttack.raw);
  fx.db.close();
});

test("a principal of another workspace does not exist to this one", () => {
  const fx = p4Fixture();
  const outsiderId = fx.outsider.agent_id;
  assert.equal(rest(fx, "POST", `/v1/principals/${outsiderId}/api-keys`, fx.keys.owner, {}).status, 404);
  assert.equal(
    rest(fx, "POST", `/v1/principals/${outsiderId}/api-keys/whatever/revoke`, fx.keys.owner, {}).status,
    404,
  );
  fx.db.close();
});

// -------------------------------------------------------------- signing keys

test("a signing key is registered for the CALLER and for no one else — §4.3.8 author binding", () => {
  const fx = p4Fixture();
  const reg = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, {
    kid: "author-key-1",
    public_key_ed25519: KEY_A.publicKey,
    // §2: an actor field in a request body cannot select a different agent.
    // These are ignored, not honoured — and not rejected either, exactly as
    // `author_agent` is handled on surface 1.
    principal_id: fx.member.agent_id,
    agent_id: fx.member.agent_id,
  });
  assert.equal(reg.status, 201, reg.raw);
  assert.equal(reg.body.principal_id, fx.author.agent_id, "bound to the authenticated principal");
  assert.equal(reg.body.kid, "author-key-1");
  assert.ok(reg.body.tlog_seq >= 1, "registration is transparency-logged");
  const logged = rest(fx, "GET", "/v1/tlog", fx.keys.owner).body.items.find((r: any) => r.seq === reg.body.tlog_seq);
  assert.equal(logged.event_kind, TLOG_KEY_REGISTERED);
  assert.equal(logged.subject_id, "author-key-1", "the kid is the subject — §4.4 step 3's lookup key");

  // there is no surface at all through which an ADMIN registers a key for
  // someone else: the operation takes no principal parameter
  const asAdmin = rest(fx, "POST", "/v1/signing-keys", fx.keys.admin, {
    kid: "admin-forges-one",
    public_key_ed25519: KEY_B.publicKey,
    principal_id: fx.author.agent_id,
  });
  assert.equal(asAdmin.status, 201);
  assert.equal(asAdmin.body.principal_id, fx.admin.agent_id, "an admin's registration binds the ADMIN");

  const listed = rest(fx, "GET", "/v1/signing-keys", fx.keys.author).body.items;
  assert.deepEqual(listed.map((k: any) => k.kid), ["author-key-1"], "a member sees only its own keys");
  assert.equal(rest(fx, "GET", "/v1/signing-keys", fx.keys.owner).body.items.length, 2, "an owner sees the workspace's");
  fx.db.close();
});

test("a malformed kid or public key is refused with INVALID_SCHEMA, never a constraint violation", () => {
  const fx = p4Fixture();
  const bad: Array<Record<string, unknown>> = [
    { kid: "UPPERCASE", public_key_ed25519: KEY_A.publicKey },
    { kid: "has space", public_key_ed25519: KEY_A.publicKey },
    { kid: "a".repeat(65), public_key_ed25519: KEY_A.publicKey },
    { kid: "", public_key_ed25519: KEY_A.publicKey },
    { kid: "ok-kid", public_key_ed25519: "too-short" },
    { kid: "ok-kid", public_key_ed25519: `${KEY_A.publicKey}=` },
    { kid: "ok-kid", public_key_ed25519: KEY_A.publicKey.replace(/.$/, "+") },
    { kid: "ok-kid" },
    { public_key_ed25519: KEY_A.publicKey },
    { kid: 7, public_key_ed25519: KEY_A.publicKey },
  ];
  for (const body of bad) {
    const res = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.raw}`);
    assert.equal(res.body.error.code, "INVALID_SCHEMA");
  }
  // …and none of them registered anything
  assert.equal(rest(fx, "GET", "/v1/signing-keys", fx.keys.author).body.items.length, 0);

  // What the surface deliberately does NOT do is judge whether a well-formed
  // key is the caller's real one: Ed25519 admits any 32-byte string as a
  // public-key encoding, so 43 characters of `A` is accepted. Nothing is lost
  // — a package signed by a key other than the registered one fails §4.4 step
  // 4 with BAD_SIGNATURE, which is where that question belongs.
  assert.equal(
    rest(fx, "POST", "/v1/signing-keys", fx.keys.author, { kid: "well-formed-nonsense", public_key_ed25519: "A".repeat(43) })
      .status,
    201,
  );
  fx.db.close();
});

test("kid is globally unique: re-registering the same binding converges, anything else is CONFLICT", () => {
  const fx = p4Fixture();
  const first = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, {
    kid: "shared-kid",
    public_key_ed25519: KEY_A.publicKey,
  });
  assert.equal(first.status, 201);

  const same = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, {
    kid: "shared-kid",
    public_key_ed25519: KEY_A.publicKey,
  });
  assert.equal(same.status, 201, same.raw);
  assert.equal(same.body.noop, true, "the identical binding converges");
  assert.equal(same.body.created_at_ms, first.body.created_at_ms);

  // the same kid with a DIFFERENT key would silently re-point an author binding
  const swap = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, {
    kid: "shared-kid",
    public_key_ed25519: KEY_B.publicKey,
  });
  assert.equal(swap.status, 409, swap.raw);
  assert.equal(swap.body.error.current_state, "active");

  // and another principal cannot take a kid that is already bound…
  const steal = rest(fx, "POST", "/v1/signing-keys", fx.keys.member, {
    kid: "shared-kid",
    public_key_ed25519: KEY_B.publicKey,
  });
  assert.equal(steal.status, 409, steal.raw);
  // …without being told whose it is
  assert.ok(!steal.body.error.message.includes(fx.author.agent_id), "the refusal does not name the other principal");
  fx.db.close();
});

test("signing-key revocation: self or admin, convergent, transparency-logged once", () => {
  const fx = p4Fixture();
  const tlogSeqs = (): number[] =>
    rest(fx, "GET", "/v1/tlog", fx.keys.owner)
      .body.items.filter((r: any) => r.event_kind === TLOG_KEY_REVOKED)
      .map((r: any) => r.seq);

  rest(fx, "POST", "/v1/signing-keys", fx.keys.author, { kid: "revoke-me", public_key_ed25519: KEY_A.publicKey });
  const revoked = rest(fx, "POST", "/v1/signing-keys/revoke-me/revoke", fx.keys.author, {});
  assert.equal(revoked.status, 200, revoked.raw);
  assert.equal(revoked.body.revoked_at_ms, NOW);
  assert.equal(tlogSeqs().length, 1);

  const again = rest(fx, "POST", "/v1/signing-keys/revoke-me/revoke", fx.keys.author, {});
  assert.equal(again.body.noop, true);
  assert.equal(again.body.revoked_at_ms, revoked.body.revoked_at_ms, "the §4.4 step-7 reference time never moves");
  assert.equal(tlogSeqs().length, 1, "and no second log row");

  // an admin may revoke another principal's key — revocation removes
  // capability, it cannot forge authorship
  rest(fx, "POST", "/v1/signing-keys", fx.keys.member, { kid: "members-key", public_key_ed25519: KEY_B.publicKey });
  assert.equal(rest(fx, "POST", "/v1/signing-keys/members-key/revoke", fx.keys.admin, {}).status, 200);
  // …a peer may not
  rest(fx, "POST", "/v1/signing-keys", fx.keys.reviewer, { kid: "reviewers-key", public_key_ed25519: pair(0x33).publicKey });
  assert.equal(rest(fx, "POST", "/v1/signing-keys/reviewers-key/revoke", fx.keys.member, {}).status, 403);

  // an unknown kid, and a kid of another workspace, are both NOT_FOUND
  assert.equal(rest(fx, "POST", "/v1/signing-keys/never-existed/revoke", fx.keys.owner, {}).status, 404);
  rest(fx, "POST", "/v1/signing-keys", fx.keys.outsider, { kid: "ws-b-key", public_key_ed25519: pair(0x44).publicKey });
  assert.equal(rest(fx, "POST", "/v1/signing-keys/ws-b-key/revoke", fx.keys.owner, {}).status, 404);

  // a revoked kid is never re-registered: the revocation time is a trust input
  const reuse = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, {
    kid: "revoke-me",
    public_key_ed25519: KEY_A.publicKey,
  });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.current_state, "revoked");
  fx.db.close();
});

test("MCP and REST answer identically on every provisioning surface (§2)", () => {
  const fx = p4Fixture();
  const created = mcp(fx, fx.keys.owner, "principal.create", { name: "via-mcp", type: "agent", role: "member" });
  assert.equal(created.isError, false, JSON.stringify(created.data));
  assert.match(created.data.api_key, /^sk_/);

  const reg = mcp(fx, created.data.api_key, "signing_key.register", {
    kid: "mcp-key",
    public_key_ed25519: KEY_A.publicKey,
  });
  assert.equal(reg.isError, false, JSON.stringify(reg.data));
  assert.equal(reg.data.principal_id, created.data.principal_id);

  // the SAME rows are visible over REST, from the same key
  assert.deepEqual(
    rest(fx, "GET", "/v1/signing-keys", created.data.api_key).body,
    mcp(fx, created.data.api_key, "signing_key.list", {}).data,
  );
  assert.deepEqual(
    rest(fx, "GET", "/v1/principals", created.data.api_key).body,
    mcp(fx, created.data.api_key, "principal.list", {}).data,
  );

  // the error envelope is the REST one, in the MCP result
  const denied = mcp(fx, fx.keys.member, "principal.create", { name: "nope", type: "agent", role: "member" });
  assert.equal(denied.isError, true);
  assert.equal(denied.data.error.code, "FORBIDDEN");

  const revoked = mcp(fx, created.data.api_key, "signing_key.revoke", { kid: "mcp-key" });
  assert.equal(revoked.data.revoked_at_ms, NOW);

  const rotated = mcp(fx, fx.keys.owner, "principal.issue_api_key", { principal_id: created.data.principal_id });
  assert.match(rotated.data.api_key, /^sk_/);
  const killed = mcp(fx, fx.keys.owner, "principal.revoke_api_key", {
    principal_id: created.data.principal_id,
    api_key_id: rotated.data.api_key_id,
  });
  assert.equal(killed.data.revoked_at_ms, NOW);
  fx.db.close();
});

test("the surfaces that return a one-time secret are NOT idempotency-replayable; the others are", () => {
  const fx = p4Fixture();
  // signing_key.register takes a key and replays it byte-identically
  const first = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, {
    kid: "idem-key",
    public_key_ed25519: KEY_A.publicKey,
    idempotency_key: "reg-1",
  });
  const replay = rest(fx, "POST", "/v1/signing-keys", fx.keys.author, {
    kid: "totally-different",
    public_key_ed25519: KEY_B.publicKey,
    idempotency_key: "reg-1",
  });
  assert.equal(replay.headers["Idempotency-Replayed"], "true");
  assert.equal(replay.raw, first.raw, "the persisted original response, byte for byte");

  // …while principal.create ignores the member entirely rather than persisting
  // a plaintext key in idempotency_keys.response_json
  const a = rest(fx, "POST", "/v1/principals", fx.keys.owner, {
    name: "idem-a",
    type: "agent",
    role: "member",
    idempotency_key: "p-1",
  });
  const b = rest(fx, "POST", "/v1/principals", fx.keys.owner, {
    name: "idem-b",
    type: "agent",
    role: "member",
    idempotency_key: "p-1",
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.api_key, b.body.api_key);
  assert.equal(b.headers["Idempotency-Replayed"], undefined);
  const stored = fx.db
    .prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE surface LIKE 'principal.create%'")
    .get() as { c: number };
  assert.equal(stored.c, 0, "no response of a secret-returning surface is persisted");
  fx.db.close();
});

// --------------------------------------------------------- secret hygiene

/** Every TEXT the database holds, from every table. */
function everyStoredString(fx: P4Fixture): string {
  const tables = fx.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return tables.map((t) => JSON.stringify(fx.db.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
}

test("an issued API key never reaches the database, the activity log, the tlog or the dashboard", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/principals", fx.keys.owner, {
    name: "leak-canary",
    type: "agent",
    role: "member",
  }).body;
  const rotated = rest(fx, "POST", `/v1/principals/${created.principal_id}/api-keys`, fx.keys.owner, {}).body;
  rest(fx, "POST", "/v1/signing-keys", created.api_key, { kid: "canary-key", public_key_ed25519: KEY_A.publicKey });

  const secrets = [created.api_key, rotated.api_key];
  for (const secret of secrets) {
    assert.ok(secret.length > 20, "a real secret, not an empty string that would pass vacuously");
  }

  // 1. the whole database — every table, every column
  const dump = everyStoredString(fx);
  for (const secret of secrets) {
    assert.ok(!dump.includes(secret), "the plaintext API key is nowhere in SQLite");
    assert.ok(!dump.includes(secret.slice(4)), "…not even without its `sk_` prefix");
  }
  // the sweep can see: the HASH is there, so it is looking at the right rows
  const hashes = fx.db.prepare("SELECT key_hash FROM api_keys").all() as Array<{ key_hash: string }>;
  assert.ok(hashes.length >= 2 && dump.includes(hashes[0].key_hash), "the sweep does read api_keys");

  // 2. the activity log records WHO did WHAT, by key id, never by secret
  const audit = fx.db
    .prepare("SELECT action, subject_id, details_json FROM activity_log WHERE action LIKE 'principal.%' OR action LIKE 'signing_key.%'")
    .all() as Array<{ action: string; details_json: string }>;
  assert.ok(audit.some((a) => a.action === "principal.create"), "provisioning is audited at all");
  for (const row of audit) {
    for (const secret of secrets) assert.ok(!row.details_json.includes(secret));
  }
  assert.ok(audit.some((a) => a.details_json.includes(created.api_key_id)), "…by key id");

  // 3. every readable surface: the tlog, the roster, the key list, all five
  //    dashboard views — in both formats
  const surfaces = [
    rest(fx, "GET", "/v1/tlog", fx.keys.owner).raw,
    rest(fx, "GET", "/v1/principals", fx.keys.owner).raw,
    rest(fx, "GET", "/v1/signing-keys", fx.keys.owner).raw,
    ...["library", "evidence", "receipts", "approvals", "dead_letters"].flatMap((view) => [
      rest(fx, "GET", `/v1/dashboard/${view}`, fx.keys.owner).raw,
      rest(fx, "GET", `/v1/dashboard/${view}?format=html`, fx.keys.owner).raw,
    ]),
  ].join("\n");
  for (const secret of secrets) assert.ok(!surfaces.includes(secret), "no surface echoes the key back");
  assert.ok(!surfaces.includes(hashes[0].key_hash), "and none of them exposes the hash either");
  fx.db.close();
});

test("revoking a signing key changes FUTURE verdicts and moves no registry state", () => {
  const fx = p4Fixture();
  // a package whose author is the fixture author, signed by a key that author
  // registers through the surface
  rest(fx, "POST", "/v1/signing-keys", fx.keys.author, { kid: "verdict-key", public_key_ed25519: KEY_A.publicKey });
  const manifest = makeManifest({
    author_agent: fx.author.agent_id,
    access_policy: "workspace",
    semantic_version: "1.0.0",
  });
  const files: PackageFiles = new Map();
  files.set("SKILL.md", Buffer.from("# revocation subject\n", "utf8"));
  manifest.integrity = computeIntegrity(files);
  files.set("skill.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  files.set("SIGNATURE.jws", Buffer.from(signManifest(manifest, KEY_A.privateKey, "verdict-key").jws, "utf8"));
  const archive = writeTar(files).toString("base64");

  const stateless = (): any => rest(fx, "POST", "/v1/verify", fx.keys.author, { archive }).body;
  assert.equal(stateless().verdict, "not_verified", "no registry version for this manifest yet");

  const created = rest(fx, "POST", "/v1/skills", fx.keys.author, { slug: "revocation-subject", archive });
  assert.equal(created.status, 201, created.raw);
  fx.registry.lintVersion(fx.author, created.body.skill_version_id);
  fx.registry.review(fx.author, created.body.skill_version_id, { action: "request" });
  fx.registry.review(fx.reviewer, created.body.skill_version_id, { action: "verdict", verdict: "approve" });

  // …now revoke the key AFTER the version exists
  rest(fx, "POST", "/v1/signing-keys/verdict-key/revoke", fx.keys.author, {});
  assert.equal(
    fx.registry.registryView(fx.db.prepare("SELECT id, state, superseded_by_version_id, revocation_reason, deprecation_at_ms FROM skill_versions WHERE id=?").get(created.body.skill_version_id) as any).state,
    "reviewed",
    "revoking a KEY moves no version state — §5.1 transitions have their own surfaces",
  );
  // and the verdict is now about the key, not about the package
  const after = stateless();
  assert.ok(
    ["not_verified", "unverifiable_timing", "invalid_key_revoked_at_signing"].includes(after.verdict),
    `a revoked key changes the §4.4 outcome: ${JSON.stringify(after)}`,
  );
  fx.db.close();
});

// ------------------------------------------------------------------- the E2E

interface Api {
  (method: string, path: string, key: string | undefined, body?: unknown): Promise<{ status: number; body: any }>;
}

test("PROVISIONING E2E: bootstrap → principal → its own signing key → create/lint/review/verify → published, over HTTP only", async () => {
  const inst = serve({
    port: 0,
    host: "127.0.0.1",
    dataDir: mkdtempSync(join(tmpdir(), "sklo-prov-")),
    workerIntervalMs: 0,
    log: () => {},
  });
  try {
    if (!inst.server.listening) await once(inst.server, "listening");
    const addr = inst.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : inst.port}`;

    const api: Api = async (method, path, key, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text.length ? JSON.parse(text) : null };
    };

    // 1 — the owner, from the one-time bootstrap token §9.1 prints at first start
    const boot = await api("POST", "/v1/auth/bootstrap", undefined, {
      bootstrap_token: inst.credentials!.bootstrap_owner_token,
    });
    assert.equal(boot.status, 200, JSON.stringify(boot.body));
    const ownerKey = boot.body.api_key as string;

    // 2 — the owner provisions the three principals this run needs. Each API
    //     key is handed over exactly once, in this response.
    const provision = async (name: string, role: string): Promise<{ id: string; key: string }> => {
      const res = await api("POST", "/v1/principals", ownerKey, { name, type: "agent", role });
      assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.body)}`);
      return { id: res.body.principal_id, key: res.body.api_key };
    };
    const publisher = await provision("e2e-publisher", "member");
    const reviewer = await provision("e2e-reviewer", "reviewer");
    const adopter = await provision("e2e-adopter", "member");

    // 3 — the publisher discovers its own principal_id through the API, which
    //     is what has to go into manifest.author_agent (§4.4 step 3)
    const me = await api("GET", "/v1/principals", publisher.key);
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.items.map((i: any) => i.principal_id), [publisher.id]);

    // 4 — …and registers ITS OWN signing key
    const kid = "e2e-publisher-key";
    const signer = keyFromSeedHex(randomBytes(32).toString("hex"));
    const registered = await api("POST", "/v1/signing-keys", publisher.key, {
      kid,
      public_key_ed25519: signer.publicKeyB64url,
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.equal(registered.body.principal_id, publisher.id);

    // 5 — build and sign a package with that key, naming that principal
    const manifest = tv01Manifest();
    manifest.skill_id = ulid(Date.now());
    manifest.author_agent = publisher.id;
    manifest.title = "E2E provisioning skill";
    manifest.capability_statement = "A package built and signed by an API-provisioned principal.";
    manifest.access_policy = "workspace";
    const files: PackageFiles = new Map();
    files.set("SKILL.md", Buffer.from("# E2E provisioning skill\nRun the fixture.\n", "utf8"));
    files.set("fixtures/tv01.sh", Buffer.from("echo skillonomia-tv01-ok\n", "utf8"));
    manifest.integrity = computeIntegrity(files);
    files.set("skill.json", Buffer.from(JSON.stringify(manifest), "utf8"));
    files.set("SIGNATURE.jws", Buffer.from(signManifest(manifest, signer.privateKey, kid).jws, "utf8"));
    const archive = writeTar(files).toString("base64");

    // 6 — create → lint → review → reviewed
    const created = await api("POST", "/v1/skills", publisher.key, { slug: "e2e-provisioned", archive });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const versionId = created.body.skill_version_id as string;
    assert.equal(created.body.state, "draft");

    const linted = await api("POST", `/v1/versions/${versionId}/lint`, publisher.key, {});
    assert.equal(linted.body.state, "linted", JSON.stringify(linted.body));

    await api("POST", `/v1/versions/${versionId}/reviews`, publisher.key, { action: "request" });
    const verdict = await api("POST", `/v1/versions/${versionId}/reviews`, reviewer.key, {
      action: "verdict",
      verdict: "approve",
    });
    assert.equal(verdict.body.state, "reviewed", JSON.stringify(verdict.body));

    // 7 — the §5.1 trial-adoption lane supplies the receipt conjunct
    const request = await api("POST", "/v1/adoptions/requests", adopter.key, { skill_version_id: versionId });
    assert.equal(request.status, 201, JSON.stringify(request.body));
    const receiptId = request.body.receipt_id as string;
    const adopted = await api("POST", `/v1/adoptions/${request.body.adoption_request_id}/adopt`, adopter.key, {
      environment_descriptor: env(),
    });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    await api("POST", `/v1/receipts/${receiptId}/events`, adopter.key, { event: "attempted" });
    const terminal = await api("POST", `/v1/receipts/${receiptId}/events`, adopter.key, {
      event: "adopted",
      evidence: {
        gate_results: manifest.procedure.validation_gates.map((g: any) => ({
          gate_id: g.gate_id,
          pass: true,
          observed: "skillonomia-tv01-ok",
        })),
      },
    });
    assert.equal(terminal.body.receipt_event, "adopted", JSON.stringify(terminal.body));

    // 8 — verify → publish
    const verified = await api("POST", `/v1/versions/${versionId}/verify`, ownerKey, {});
    assert.equal(verified.body.state, "verified", JSON.stringify(verified.body));
    const published = await api("POST", `/v1/versions/${versionId}/publish`, ownerKey, {});
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.state, "published");
    assert.ok(published.body.countersign_seq >= 1, "§4.3.8 countersign appended");

    // 9 — and the §4.4 algorithm now says `valid` about the bytes the publisher
    //     signed. This is the whole point: the kid resolves to a key of
    //     manifest.author_agent because the principal registered it itself.
    const check = await api("POST", "/v1/verify", ownerKey, { archive });
    assert.equal(check.status, 200);
    assert.equal(check.body.verdict, "valid", JSON.stringify(check.body));
    assert.equal(check.body.manifest_hash, published.body.manifest_hash);

    // 10 — nothing in this test touched SQLite, and the instance holds exactly
    //      the principals the API created plus §9.1's two
    const roster = await api("GET", "/v1/principals", ownerKey);
    assert.deepEqual(
      roster.body.items.map((i: any) => i.name).sort(),
      ["demo-adopter", "e2e-adopter", "e2e-publisher", "e2e-reviewer", "owner", "skillonomia-seed"],
      "§9.1's bootstrap pair and seed identity, plus the three principals provisioned over HTTP",
    );
    // the seed identity still holds no API key — provisioning did not change
    // what §9.1's seed installs
    assert.equal(
      roster.body.items.find((i: any) => i.name === "skillonomia-seed").active_api_keys,
      0,
      "the seed identity is not a usable credential",
    );
  } finally {
    inst.close();
  }
});
