// §5.4 TRANSFER — an operation whose recipient is a first-class, TYPED value.
//
// WHAT THIS REPLACES, AND WHY IT COULD NOT WAIT. Before this surface, the only
// way a version moved from the agent that wrote it to an agent that runs it was
// the recipient asking for it (`skill.request_adoption`). The row that recorded
// the movement named an `adopter_agent_id`: a foreign key into `agents`, in this
// database, with no type on it. That model has exactly one case in it — sender
// and recipient are two rows of one SQLite file — and it cannot state the case
// it will have to state next, where the recipient is a fleet outside the
// owner's perimeter and is not a row here at all.
//
// Retrofitting a type onto the recipient later would mean re-interpreting every
// movement already recorded, and the journal those movements live in is
// INSERT-only by design. So the recipient becomes typed NOW, while the only
// implemented type is still the local one:
//
//     local_agent   — carried out end to end
//     remote_fleet  — declared, validated, and refused as NOT IMPLEMENTED
//
// The refusal is the load-bearing half. A declared type that silently behaved
// like the implemented one would produce records asserting a movement the
// registry never performed — the exact defect class this repository exists to
// refuse. And the refusal arrives AFTER the permission has been checked and
// found satisfied, so an operator standing up the V-2 ambassador can tell "you
// may not" from "this does not exist yet" by reading the error code.
//
// WHAT A TRANSFER IS NOT. It is an INTENT, and it is recorded as one [I-2].
// The registry decided that a version goes to a recipient; nothing has been
// observed at the recipient, and this operation may not say otherwise. It does
// not deliver a package, it does not assert that anything was installed, and it
// does not put a version into service. Every answer it gives carries the
// intent and the OBSERVED state as two separate fields, and the observed one is
// `unknown` — three-valued [I-1], never "no" and never silently "active".
// Deployment states (`assigned → queued → activating → active`) are a separate
// piece of work and are deliberately absent here.
//
// WHAT IT LEAVES BEHIND. One `transfers` row carrying the whole signature — the
// version, the sender, the typed recipient, the permission, the §5 arrival
// marker and the record — and one `transferred` event on the recipient's
// receipt, carrying the recipient itself. Both are written in ONE transaction
// with the request and the receipt shell: a receipt with no event would be a
// movement with no record, and an event with no transfer row would be a record
// of a movement nobody authorized.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import type { AuthContext } from "./auth.ts";
import { arrivalMarker } from "./marker.ts";
import { appendReceiptEventInTx } from "./receipts.ts";
import { selectWebhook } from "./delivery.ts";
import { ulid } from "./ulid.ts";
import {
  findGrant,
  isRecipientKind,
  loadPrincipal,
  IMPLEMENTED_RECIPIENT_KINDS,
  RECIPIENT_KINDS,
  type GrantPrincipal,
  type GrantAction,
  type RecipientKind,
} from "./grants.ts";

/**
 * The step of the transfer loop a transfer takes, and therefore the action its
 * sender must hold a grant for. It is a constant rather than a parameter: this
 * surface is ONE step, and a surface that let its caller choose which step it
 * was would be a catch-all with a step-shaped argument.
 */
export const TRANSFER_ACTION: GrantAction = "assign";

/** The recipient, as it is given and as it is stored: a kind and a reference. */
export interface TransferRecipient {
  kind: RecipientKind;
  ref: string;
}

/** The permission a transfer ran under, with the issuer's type and role. */
export interface TransferPermission {
  grant_id: string;
  action: GrantAction;
  recipient_scope: RecipientKind;
  granted_by: GrantPrincipal;
}

export interface TransferResponse {
  transfer_id: string;
  skill_version_id: string;
  /** the §5 marker this version derives — not a secret, and not a credential */
  arrival_marker: string;
  /** the acting principal, with the type and role it held [I-5] */
  sender: GrantPrincipal;
  recipient_kind: RecipientKind;
  recipient_ref: string;
  permission: TransferPermission;
  adoption_request_id: string;
  receipt_id: string;
  receipt_event: "transferred";
  event_seq: number;
  /** the §5.2 queue state of the request this transfer opened */
  request_state: string;
  /** the §7.3 conditions holding it, present exactly when it is held */
  approval_required?: string[];
  /**
   * [I-2] — TWO COLUMNS, NEVER ONE. `intent` is what Skillonomia decided;
   * `observed_state` is what has been observed at the recipient, which after a
   * transfer is nothing at all. It is `unknown` and not `not_running`, because
   * an absent observation is not an observation of absence [I-1].
   */
  intent: string;
  observed_state: "unknown";
  /** where an observed state would have to come from, named on every answer */
  observed_state_source: string;
}

export interface TransferInput {
  skill_version_id?: unknown;
  recipient?: unknown;
}

/**
 * The recipient the caller named — parsed, never defaulted.
 *
 * There is NO default and there is no shorthand. A transfer that does not name
 * a recipient is refused, and that refusal is the whole point of the surface:
 * moving a row inside one database, with the recipient implied by whoever
 * happens to be asking, is the shape this operation replaces. So an absent
 * `recipient`, an absent `kind` and an absent `ref` are each `INVALID_SCHEMA`
 * and none of them is filled in from context.
 */
export function parseRecipient(raw: unknown): TransferRecipient {
  if (raw === undefined || raw === null) {
    throw new ApiError(
      "INVALID_SCHEMA",
      `recipient {kind,ref} required — a transfer names its recipient and has no default (§5.4); kind must be one of ${RECIPIENT_KINDS.join("|")}`,
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("INVALID_SCHEMA", "recipient must be an object {kind,ref}");
  }
  const { kind, ref } = raw as { kind?: unknown; ref?: unknown };
  if (kind === undefined) {
    throw new ApiError("INVALID_SCHEMA", `recipient.kind required — one of ${RECIPIENT_KINDS.join("|")}, never inferred`);
  }
  if (!isRecipientKind(kind)) {
    throw new ApiError("INVALID_SCHEMA", `recipient.kind must be one of ${RECIPIENT_KINDS.join("|")}`);
  }
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 120) {
    throw new ApiError("INVALID_SCHEMA", "recipient.ref must be a string of 1..120 characters identifying the recipient");
  }
  return { kind, ref };
}

export interface TransferContext {
  /** the version, already resolved and access-checked by the caller */
  versionId: string;
  /** the §5.2/§7.3 state the opened request must start in */
  requestState: string;
  /** the §7.3 conditions in force, empty when none are */
  conditions: string[];
  nowMs: number;
}

/**
 * Perform one transfer. The caller has resolved the version and applied §5.1
 * visibility and the adoptability rules; everything §5.4-specific happens here,
 * and everything it writes is written in ONE transaction.
 */
export function recordTransfer(
  db: Db,
  auth: AuthContext,
  input: TransferInput,
  ctx: TransferContext,
): TransferResponse {
  const recipient = parseRecipient((input ?? {}).recipient);

  // The acting principal, read from the database rather than from the token, so
  // that the type and role stored on the record are the ones the registry
  // itself can vouch for [I-5].
  const sender = loadPrincipal(db, auth.agent_id);
  if (!sender || sender.role === null) {
    throw new ApiError("FORBIDDEN", "workspace membership required");
  }

  // THE PERMISSION COMES FIRST, and before the recipient type is checked for
  // implementation. That order is not cosmetic: it is what lets the V-2
  // ambassador be verified today. An agent granted `assign` into a
  // `remote_fleet` gets the implementation refusal, an agent without that grant
  // gets the permission refusal, and the two are never the same answer.
  const grant = findGrant(db, sender.id, TRANSFER_ACTION, recipient.kind);
  if (!grant) {
    throw new ApiError(
      "FORBIDDEN",
      `this principal holds no \`${TRANSFER_ACTION}\` grant scoped to \`${recipient.kind}\` (§6.2)`,
    );
  }

  if (!IMPLEMENTED_RECIPIENT_KINDS.includes(recipient.kind)) {
    // Not a stub that reports success, not a queue nobody drains, and not a
    // FORBIDDEN pretending the permission was the problem: the grant above was
    // found and is satisfied. V-1 does not carry a package outside this
    // registry, and says so.
    throw new ApiError(
      "NOT_IMPLEMENTED",
      `recipient kind \`${recipient.kind}\` is declared by §5.4 and is NOT implemented in V-1: this registry hands nothing outside its own perimeter, and the transfer was not recorded`,
    );
  }

  // A `local_agent` recipient is an agent of THIS registry and of the sender's
  // own workspace. Anything else is not acknowledged to exist — the same
  // deny-by-default the provisioning surfaces use, because "there is an agent
  // by that id in another workspace" is itself disclosure.
  const to = loadPrincipal(db, recipient.ref);
  if (!to || to.workspace_id !== auth.workspace_id) {
    throw new ApiError("NOT_FOUND", "recipient not found");
  }
  if (to.id === sender.id) {
    throw new ApiError(
      "INVALID_SCHEMA",
      "a transfer names a recipient other than its sender — sending to oneself is the untyped internal move this surface exists to replace (§5.4)",
    );
  }
  if (to.status !== "active") {
    throw new ApiError("PRECONDITION_FAILED", "the recipient is not an active principal", to.status);
  }
  if (to.role === null) {
    throw new ApiError("PRECONDITION_FAILED", "the recipient holds no membership of this workspace", "no_membership");
  }

  const marker = arrivalMarker(ctx.versionId);
  const now = ctx.nowMs;

  db.exec("BEGIN IMMEDIATE");
  try {
    const transferId = ulid(now);
    const requestId = ulid(now);
    const receiptId = ulid(now);
    // The §5.2 queue row belongs to the RECIPIENT: it is the recipient that has
    // to be notified and the recipient that will fetch the package. The
    // endpoint is snapshotted for the recipient for the same reason.
    const webhookId = selectWebhook(db, to.id);
    db.prepare(
      `INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, requester_context_json,
         state, attempt_count, next_attempt_at_ms, webhook_id, created_at_ms)
       VALUES (?,?,?,NULL,?,0,?,?,?)`,
    ).run(requestId, ctx.versionId, to.id, ctx.requestState, now, webhookId, now);
    db.prepare(
      "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
    ).run(receiptId, requestId, ctx.versionId, to.id, now);

    // The EVENT. `transferred`, not `delivered`: nothing has been handed to
    // anybody yet. It carries the typed recipient, on the INSERT-only row, in
    // this transaction — which is where the migration counter reads the
    // recipient from [I-6].
    const appended = appendReceiptEventInTx(db, {
      receiptId,
      actorAgentId: sender.id,
      event: "transferred",
      recipient: { kind: recipient.kind, id: to.id },
      idempotencyKey: `transfer:${transferId}`,
      nowMs: now,
      asRegistry: true,
    });

    db.prepare(
      `INSERT INTO transfers(id, skill_version_id, sender_agent_id, sender_type, sender_role,
         recipient_kind, recipient_ref, grant_id, grant_action, grantor_agent_id, grantor_type,
         grantor_role, arrival_marker, adoption_receipt_id, receipt_event_seq, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      transferId,
      ctx.versionId,
      sender.id,
      sender.type,
      sender.role,
      recipient.kind,
      to.id,
      grant.id,
      grant.action,
      grant.granted_by_agent_id,
      grant.granted_by_type,
      grant.granted_by_role,
      marker,
      receiptId,
      appended.event_seq,
      now,
    );
    db.exec("COMMIT");

    const res: TransferResponse = {
      transfer_id: transferId,
      skill_version_id: ctx.versionId,
      arrival_marker: marker,
      sender: { agent_id: sender.id, type: sender.type, role: sender.role },
      recipient_kind: recipient.kind,
      recipient_ref: to.id,
      permission: {
        grant_id: grant.id,
        action: grant.action,
        recipient_scope: grant.recipient_scope,
        granted_by: {
          agent_id: grant.granted_by_agent_id,
          type: grant.granted_by_type,
          role: grant.granted_by_role,
        },
      },
      adoption_request_id: requestId,
      receipt_id: receiptId,
      receipt_event: "transferred",
      event_seq: appended.event_seq,
      request_state: ctx.requestState,
      intent: "the registry recorded that this version is to go to this recipient",
      observed_state: "unknown",
      observed_state_source:
        "receipt_events (registry journal, INSERT-only): nothing has been observed at the recipient yet",
    };
    if (ctx.conditions.length > 0) res.approval_required = ctx.conditions;
    return res;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed by the branch that threw
    }
    throw e;
  }
}
