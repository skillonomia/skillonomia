// §6 Auth + §9.1 bootstrap. Bearer API key → sha256 → api_keys (the SINGLE
// source of key truth, §3) → AuthContext {agent_id, workspace_id, role,
// tool_profile}. The acting agent is derived exclusively from this context;
// payload-supplied fields can never impersonate or escalate (§2 invariant,
// snapshot defects #2/#3).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";

export type Role = "owner" | "admin" | "reviewer" | "member";

export interface AuthContext {
  agent_id: string;
  workspace_id: string;
  /** role from workspace_memberships in the agent's own workspace; null = no membership */
  role: Role | null;
  tool_profile: string | null;
  /** id of the api_keys row that authenticated this call (rate-limit bucket key) */
  api_key_id: string;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint an API key for an agent; only the sha256 of the secret is stored. */
export function mintApiKey(db: Db, agentId: string, nowMs: number, prefix = "sk"): { api_key: string; key_id: string } {
  const secret = `${prefix}_${b64url(randomBytes(32))}`;
  const keyId = ulid(nowMs);
  db.prepare("INSERT INTO api_keys(id, agent_id, key_hash, created_at_ms) VALUES (?,?,?,?)").run(
    keyId,
    agentId,
    sha256Hex(secret),
    nowMs,
  );
  return { api_key: secret, key_id: keyId };
}

/**
 * Resolve `Authorization: Bearer <key>` to an AuthContext. Rejections are
 * uniform UNAUTHORIZED — a caller cannot distinguish unknown key, revoked key
 * or inactive agent.
 */
export function authenticate(db: Db, authorizationHeader: string | undefined): AuthContext {
  if (!authorizationHeader) throw new ApiError("UNAUTHORIZED", "missing Authorization header");
  const m = /^Bearer\s+(\S+)$/.exec(authorizationHeader);
  if (!m) throw new ApiError("UNAUTHORIZED", "Authorization must be 'Bearer <api_key>'");
  const row = db
    .prepare(
      `SELECT k.id AS key_id, a.id AS agent_id, a.workspace_id, a.tool_profile, a.status
         FROM api_keys k JOIN agents a ON a.id=k.agent_id
        WHERE k.key_hash=? AND k.revoked_at_ms IS NULL`,
    )
    .get(sha256Hex(m[1])) as
    | { key_id: string; agent_id: string; workspace_id: string; tool_profile: string | null; status: string }
    | undefined;
  if (!row || row.status !== "active") throw new ApiError("UNAUTHORIZED", "invalid API key");
  const membership = db
    .prepare("SELECT role FROM workspace_memberships WHERE agent_id=? AND workspace_id=?")
    .get(row.agent_id, row.workspace_id) as { role: Role } | undefined;
  return {
    agent_id: row.agent_id,
    workspace_id: row.workspace_id,
    role: membership?.role ?? null,
    tool_profile: row.tool_profile,
    api_key_id: row.key_id,
  };
}

// ---------------------------------------------------------------------------
// §9.1 bootstrap: first start creates workspace `default`, human principal
// `owner` (role owner) and agent `demo-adopter` (role member), and issues two
// one-time credentials. The BOOTSTRAP_OWNER_TOKEN is NOT an API key: it is
// exchangeable exactly once at POST /v1/auth/bootstrap, which mints the
// owner's real key and invalidates the token. The DEMO_ADOPTER_TOKEN is the
// demo adopter's real (minted) API key.
//
// The unexchanged token used to live ONLY in process memory. That made a
// restart before the exchange terminal: the workspace and the two principals
// were committed, so `bootstrapInstance` would never run again and never
// re-issue, while the only credential that could mint the owner's key had gone
// with the process. The deployment was left with no owner key and no path back
// except deleting the data directory — and since the README's quickstart is now
// "start it, then follow the transcript", any restart in between broke it.
//
// So the OUTSTANDING state is durable, through a `BootstrapStore`. What is
// stored is the sha256 of the token and nothing else: the plaintext is printed
// once, at first start, and exists nowhere afterwards. A stored hash cannot
// reprint a lost token, which is deliberate — a one-time credential that can be
// reissued is not one.
//
// It is a file, not a row. Appendix D.1 is byte-frozen at twenty tables and the
// live schema is compared against it; a table or a column for this would be a
// change to the normative schema for a piece of process state, which is the
// wrong trade. It sits beside the webhook secret store, which is in the data
// directory for the same reason.
// ---------------------------------------------------------------------------

export interface BootstrapState {
  /** sha256 of the outstanding one-time token; null once exchanged (or never issued) */
  tokenHash: string | null;
  ownerAgentId: string;
  workspaceId: string;
}

/**
 * Where the OUTSTANDING bootstrap state lives between the first start and the
 * exchange. `clear()` is called the moment the token is consumed, before the
 * owner's key is minted, so a crash in between cannot leave a live token behind.
 */
export interface BootstrapStore {
  load(): BootstrapState | null;
  save(state: BootstrapState): void;
  clear(): void;
}

/** The default: nothing survives the process. What the tests use. */
export class MemoryBootstrapStore implements BootstrapStore {
  private state: BootstrapState | null = null;
  load(): BootstrapState | null {
    return this.state;
  }
  save(state: BootstrapState): void {
    this.state = { ...state };
  }
  clear(): void {
    this.state = null;
  }
}

export interface BootstrapResult {
  workspace_id: string;
  owner_agent_id: string;
  demo_adopter_agent_id: string;
  /** one-time credential printed at first start (§9.1) */
  bootstrap_owner_token: string;
  /** the demo adopter's minted API key (§9.1) */
  demo_adopter_token: string;
  state: BootstrapState;
}

/**
 * First-start bootstrap. Returns null when the instance already has any
 * workspace (bootstrap ran before) — it never re-issues credentials.
 */
export function bootstrapInstance(db: Db, nowMs: number): BootstrapResult | null {
  const any = db.prepare("SELECT 1 AS x FROM workspaces LIMIT 1").get() as { x: number } | undefined;
  if (any) return null;

  const wsId = ulid(nowMs);
  const ownerId = ulid(nowMs);
  const demoId = ulid(nowMs);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO workspaces(id, name, created_at_ms) VALUES (?,?,?)").run(wsId, "default", nowMs);
    db.prepare(
      "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?, 'owner', 'human', 'active', ?)",
    ).run(ownerId, wsId, nowMs);
    db.prepare(
      "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?, 'demo-adopter', 'agent', 'active', ?)",
    ).run(demoId, wsId, nowMs);
    const mem = db.prepare(
      "INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)",
    );
    mem.run(ownerId, wsId, "owner", nowMs);
    mem.run(demoId, wsId, "member", nowMs);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const bootstrapToken = `bt_${b64url(randomBytes(32))}`;
  const { api_key: demoKey } = mintApiKey(db, demoId, nowMs);
  return {
    workspace_id: wsId,
    owner_agent_id: ownerId,
    demo_adopter_agent_id: demoId,
    bootstrap_owner_token: bootstrapToken,
    demo_adopter_token: demoKey,
    state: { tokenHash: sha256Hex(bootstrapToken), ownerAgentId: ownerId, workspaceId: wsId },
  };
}

export interface BootstrapExchange {
  api_key: string;
  agent_id: string;
  role: "owner";
}

/**
 * POST /v1/auth/bootstrap — the exchange of §9.1: trade the one-time token for
 * the owner's real API key. The token is invalidated before the key is minted,
 * so a second exchange — or a replay racing the first — fails UNAUTHORIZED.
 *
 * `onConsumed` runs at that same instant, between invalidating the token and
 * minting the key, and is where the durable copy is dropped. Doing it after the
 * mint would leave a window in which a crash resurrects a token the process had
 * already treated as spent.
 */
export function exchangeBootstrapToken(
  db: Db,
  state: BootstrapState,
  token: unknown,
  nowMs: number,
  onConsumed: () => void = () => {},
): BootstrapExchange {
  if (typeof token !== "string" || token.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "bootstrap_token must be a non-empty string");
  }
  const expected = state.tokenHash;
  if (expected === null) throw new ApiError("UNAUTHORIZED", "bootstrap token already used or not issued");
  const got = Buffer.from(sha256Hex(token), "hex");
  const want = Buffer.from(expected, "hex");
  if (!timingSafeEqual(got, want)) throw new ApiError("UNAUTHORIZED", "invalid bootstrap token");
  state.tokenHash = null; // one-time: invalidate first…
  onConsumed(); // …durably, before anything else can fail
  const { api_key } = mintApiKey(db, state.ownerAgentId, nowMs, "sk_own");
  return { api_key, agent_id: state.ownerAgentId, role: "owner" };
}

/**
 * The durable store of a real deployment: one 0600 file in the data directory
 * holding the token's SHA-256 and the two ids the exchange needs. The plaintext
 * token is never written anywhere — not here, not in SQLite, not in a log after
 * the one line §9.1 requires at first start.
 */
export class FsBootstrapStore implements BootstrapStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  load(): BootstrapState | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return null; // exchanged, or never issued
    }
    try {
      const v = JSON.parse(raw) as Partial<BootstrapState>;
      if (typeof v.tokenHash !== "string" || typeof v.ownerAgentId !== "string" || typeof v.workspaceId !== "string") {
        return null;
      }
      return { tokenHash: v.tokenHash, ownerAgentId: v.ownerAgentId, workspaceId: v.workspaceId };
    } catch {
      // an unreadable file is treated as no outstanding token: the safe
      // direction is a deployment that cannot be bootstrapped, never one that
      // can be bootstrapped by something we could not parse
      return null;
    }
  }
  save(state: BootstrapState): void {
    writeFileSync(this.path, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  clear(): void {
    try {
      rmSync(this.path);
    } catch {
      /* already gone — consuming a token twice is not an error here */
    }
  }
}
