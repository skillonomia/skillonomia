// TRANSFER GRANTS — the one concept the permission model gains, and the roles
// it deliberately does NOT gain.
//
// The workspace roles of the initial schema (`owner`, `admin`, `reviewer`,
// `member`) and the principal types (`human`, `agent`, `service`) are untouched
// by this module and by everything downstream of it. Approvals stand on those
// roles (src/approvals.ts) and are not rewritten. A new role would have meant
// re-deciding what every existing role may do, for a question that is not about
// standing in a workspace at all.
//
// What the transfer needs is narrower and orthogonal: may THIS agent take THIS
// step of the transfer loop towards THAT KIND of recipient? Three values, one
// row:
//
//     (agent, action, recipient scope)
//
// THE ACTION LIST IS CLOSED and is not a design space. It is exactly the steps
// of the transfer loop — `receive`, `assign`, `activate`, `revoke`,
// `report_outcome` — restated in the DDL as a CHECK, so a grant naming a step
// nobody designed cannot be stored even by a caller writing SQL directly.
//
// THE SCOPE IS THE RECIPIENT TYPE, and this is what makes the V-2 ambassador a
// row of data rather than a change of model. An agent permitted to `assign`
// into a `remote_fleet` is expressible on this schema today: no new column, no
// new enum member, no branch. V-1 refuses to CARRY OUT such a transfer — the
// transport does not exist yet — and it refuses with `NOT_IMPLEMENTED` after
// finding the permission satisfied, never with `FORBIDDEN`, because "you may
// not" and "this does not exist yet" are different answers and an operator
// standing up an ambassador has to be able to tell which one it got.
//
// [I-5] — THE TYPE OF THE ISSUING PRINCIPAL IS RECORDED, NOT INFERRED. In a
// single-owner deployment nearly every administrative act is performed by an
// agent holding an administrative role rather than by the human owner in
// person. Those are different facts. Both the row and every answer built from
// it carry the issuer's `type` and `role` as stored values, so a reader never
// has to look up who that agent is TODAY to find out what kind of principal
// authorized something YESTERDAY.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import type { AuthContext } from "./auth.ts";
import { ulid } from "./ulid.ts";

/** The steps of the transfer loop. Closed: this is the whole list. */
export const GRANT_ACTIONS = ["receive", "assign", "activate", "revoke", "report_outcome"] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];

/**
 * The recipient types a transfer can name. Closed, and BOTH members are part of
 * the model in V-1: `local_agent` is carried out, `remote_fleet` is declared,
 * validated and refused as unimplemented. The refusal is the honest half —
 * a declared type that behaved like the other one would mint records claiming a
 * movement that never happened.
 */
export const RECIPIENT_KINDS = ["local_agent", "remote_fleet"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

/** The recipient types this version actually carries out. */
export const IMPLEMENTED_RECIPIENT_KINDS: readonly RecipientKind[] = ["local_agent"];

export type PrincipalType = "human" | "agent" | "service";
export type WorkspaceRole = "owner" | "admin" | "reviewer" | "member";

/**
 * A principal as every answer of this subsystem publishes it: the id, and the
 * two things [I-5] refuses to let a reader infer.
 */
export interface GrantPrincipal {
  agent_id: string;
  type: PrincipalType;
  role: WorkspaceRole;
}

export interface GrantView {
  grant_id: string;
  agent_id: string;
  action: GrantAction;
  recipient_scope: RecipientKind;
  /** the principal that issued it, with its type and role AS RECORDED */
  granted_by: GrantPrincipal;
  created_at_ms: number;
}

/** The write surface's answer: the grant, plus the convergence marker a READ
 *  can never carry — which is why it is a shape of its own rather than an
 *  optional member of the row every list returns. */
export interface CreatedGrant extends GrantView {
  /** true when this call converged on a grant that already existed */
  noop?: boolean;
}

export interface GrantRow {
  id: string;
  agent_id: string;
  action: GrantAction;
  recipient_scope: RecipientKind;
  granted_by_agent_id: string;
  granted_by_type: PrincipalType;
  granted_by_role: WorkspaceRole;
  created_at_ms: number;
}

export function grantView(row: GrantRow): GrantView {
  return {
    grant_id: row.id,
    agent_id: row.agent_id,
    action: row.action,
    recipient_scope: row.recipient_scope,
    granted_by: {
      agent_id: row.granted_by_agent_id,
      type: row.granted_by_type,
      role: row.granted_by_role,
    },
    created_at_ms: row.created_at_ms,
  };
}

export function isGrantAction(v: unknown): v is GrantAction {
  return typeof v === "string" && (GRANT_ACTIONS as readonly string[]).includes(v);
}

export function isRecipientKind(v: unknown): v is RecipientKind {
  return typeof v === "string" && (RECIPIENT_KINDS as readonly string[]).includes(v);
}

interface AgentRow {
  id: string;
  type: PrincipalType;
  workspace_id: string;
  status: string;
  role: WorkspaceRole | null;
}

/** An agent with the role it holds in its OWN workspace, read from the database. */
export function loadPrincipal(db: Db, agentId: string): AgentRow | undefined {
  return db
    .prepare(
      `SELECT a.id, a.type, a.workspace_id, a.status,
              (SELECT role FROM workspace_memberships m
                WHERE m.agent_id=a.id AND m.workspace_id=a.workspace_id) AS role
         FROM agents a WHERE a.id=?`,
    )
    .get(agentId) as AgentRow | undefined;
}

/** The one lookup the transfer authorizes itself with: the exact triple. */
export function findGrant(
  db: Db,
  agentId: string,
  action: GrantAction,
  scope: RecipientKind,
): GrantRow | undefined {
  return db
    .prepare(
      `SELECT id, agent_id, action, recipient_scope, granted_by_agent_id, granted_by_type,
              granted_by_role, created_at_ms
         FROM transfer_grants WHERE agent_id=? AND action=? AND recipient_scope=?`,
    )
    .get(agentId, action, scope) as GrantRow | undefined;
}

export interface CreateGrantInput {
  agent_id?: unknown;
  action?: unknown;
  recipient_scope?: unknown;
}

/**
 * Issue one grant. Admin/owner of the grantee's workspace only — the same
 * standing that manages memberships (§6's ACL matrix), because a grant is a
 * capability of a principal and issuing one is administration of that
 * principal.
 *
 * Convergent: re-issuing the same triple returns the ORIGINAL row with
 * `noop:true` rather than minting a second authorization. The DDL's
 * UNIQUE(agent_id, action, recipient_scope) is the backstop under concurrency.
 */
export function createGrant(db: Db, auth: AuthContext, input: CreateGrantInput, nowMs: number): CreatedGrant {
  const agentId = (input ?? {}).agent_id;
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "agent_id (string) required");
  }
  // The closed lists are checked BEFORE anything is looked up, and the message
  // names the whole list: a caller that guessed an action learns what the steps
  // of the loop actually are instead of guessing again.
  if (!isGrantAction((input ?? {}).action)) {
    throw new ApiError("INVALID_SCHEMA", `action must be one of ${GRANT_ACTIONS.join("|")}`);
  }
  if (!isRecipientKind((input ?? {}).recipient_scope)) {
    throw new ApiError("INVALID_SCHEMA", `recipient_scope must be one of ${RECIPIENT_KINDS.join("|")}`);
  }
  const action = (input as { action: GrantAction }).action;
  const scope = (input as { recipient_scope: RecipientKind }).recipient_scope;

  if (auth.role !== "admin" && auth.role !== "owner") {
    throw new ApiError("FORBIDDEN", "issuing a transfer grant requires workspace role admin/owner");
  }
  const issuer = loadPrincipal(db, auth.agent_id);
  if (!issuer || issuer.role === null) {
    throw new ApiError("FORBIDDEN", "issuing a transfer grant requires workspace membership");
  }
  const grantee = loadPrincipal(db, agentId);
  // Deny-by-default, and the same rule the provisioning surfaces use: a
  // principal of another workspace is absent, not forbidden.
  if (!grantee || grantee.workspace_id !== auth.workspace_id) {
    throw new ApiError("NOT_FOUND", "principal not found");
  }
  if (grantee.status !== "active") {
    throw new ApiError("PRECONDITION_FAILED", "a non-active principal takes no grant", grantee.status);
  }
  if (grantee.role === null) {
    throw new ApiError("PRECONDITION_FAILED", "a principal with no workspace membership takes no grant", "no_membership");
  }

  const existing = findGrant(db, agentId, action, scope);
  if (existing) return { ...grantView(existing), noop: true };

  const row: GrantRow = {
    id: ulid(nowMs),
    agent_id: agentId,
    action,
    recipient_scope: scope,
    granted_by_agent_id: issuer.id,
    granted_by_type: issuer.type,
    granted_by_role: issuer.role,
    created_at_ms: nowMs,
  };
  try {
    db.prepare(
      `INSERT INTO transfer_grants(id, agent_id, action, recipient_scope, granted_by_agent_id,
         granted_by_type, granted_by_role, created_at_ms) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      row.id,
      row.agent_id,
      row.action,
      row.recipient_scope,
      row.granted_by_agent_id,
      row.granted_by_type,
      row.granted_by_role,
      row.created_at_ms,
    );
  } catch (e) {
    // the UNIQUE backstop: a lost race converges on the winner's row
    const raced = findGrant(db, agentId, action, scope);
    if (raced) return { ...grantView(raced), noop: true };
    throw e;
  }
  return grantView(row);
}

/**
 * The grants an actor may read: its own always, and the whole workspace's for
 * an admin/owner. A grant of another workspace is not disclosed, exactly as a
 * principal of another workspace is not.
 */
export function listGrants(db: Db, auth: AuthContext): { items: GrantView[] } {
  const wide = auth.role === "admin" || auth.role === "owner";
  const rows = wide
    ? (db
        .prepare(
          `SELECT g.id, g.agent_id, g.action, g.recipient_scope, g.granted_by_agent_id, g.granted_by_type,
                  g.granted_by_role, g.created_at_ms
             FROM transfer_grants g JOIN agents a ON a.id = g.agent_id
            WHERE a.workspace_id = ? ORDER BY g.created_at_ms, g.id`,
        )
        .all(auth.workspace_id) as GrantRow[])
    : (db
        .prepare(
          `SELECT id, agent_id, action, recipient_scope, granted_by_agent_id, granted_by_type,
                  granted_by_role, created_at_ms
             FROM transfer_grants WHERE agent_id = ? ORDER BY created_at_ms, id`,
        )
        .all(auth.agent_id) as GrantRow[]);
  return { items: rows.map(grantView) };
}
