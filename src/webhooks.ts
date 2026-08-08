// Webhook registration, signing and the push worker.
//
// §5.2 is the complete V1 contract here: the plaintext secret is shown ONCE at
// registration (Appendix H) and NEVER stored in SQLite; `webhooks.secret_hash`
// (D.1) remains a verifier only, and the worker resolves the signing secret
// through `webhooks.secret_ref` — a key into a deployment-local secret store —
// so no transport can leak it. §5.2 also selects at most one endpoint per
// adopter; endpoint rotation, fan-out and retry-policy tuning are, by owner
// decision, outside V1 and deliberately unimplemented.
//
// The push itself is behind a `WebhookTransport` so the delivery machine can be
// driven deterministically in tests and in the single-binary deployment alike:
// §7.1 determinism is about gates, but a machine whose behaviour depends on a
// live network is not testable either.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import {
  completeDelivery,
  failDelivery,
  markEndpointDead,
  markEndpointMissing,
  pollDelivery,
  recordWebhookResult,
  type ClaimedJob,
} from "./delivery.ts";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "./ulid.ts";
import { vetEndpointUrl, WebhookRefused, type UrlPolicy } from "./transport.ts";

// -------------------------------------------------------------- secret store

/** The deployment-local store the `secret_ref` points into. */
export interface SecretStore {
  put(ref: string, secret: string): void;
  get(ref: string): string | undefined;
  delete(ref: string): void;
}

export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();
  put(ref: string, secret: string): void {
    this.secrets.set(ref, secret);
  }
  get(ref: string): string | undefined {
    return this.secrets.get(ref);
  }
  delete(ref: string): void {
    this.secrets.delete(ref);
  }
}

/**
 * The deployment-local store of a real single-binary deployment (P7): one file
 * per `secret_ref` under the data volume, mode 0600, outside SQLite — which is
 * exactly what §5.2 asks for (the webhook secret is never handed to the
 * transport, and never lives in SQLite). A deployment with a KMS or a vault
 * supplies its own `SecretStore` instead; nothing else in the code knows where
 * a secret lives.
 */
export class FsSecretStore implements SecretStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  /** The ref is server-generated (`secretstore://webhook/<ulid>`), but it is
   *  never used as a path: the file name is its SHA-256, so no ref shape can
   *  escape the directory. */
  private path(ref: string): string {
    return join(this.dir, `${createHash("sha256").update(ref, "utf8").digest("hex")}.secret`);
  }
  put(ref: string, secret: string): void {
    writeFileSync(this.path(ref), secret, { encoding: "utf8", mode: 0o600 });
  }
  get(ref: string): string | undefined {
    try {
      return readFileSync(this.path(ref), "utf8");
    } catch {
      return undefined;
    }
  }
  delete(ref: string): void {
    try {
      rmSync(this.path(ref));
    } catch {
      /* already gone — deletion is idempotent */
    }
  }
}

// ------------------------------------------------------------------ signing

export const SIGNATURE_HEADER = "X-Webhook-Signature";

/** §5.2: HMAC-SHA256 over the exact body bytes, lowercase hex. */
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Constant-time check — the adopter side of the same contract. */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signBody(secret, body), "utf8");
  const got = Buffer.from(String(signature), "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ------------------------------------------------------------- registration

/**
 * What an endpoint URL has to be to be REGISTERED.
 *
 * This used to be a prefix regex
 * (`/^(https:\/\/|http:\/\/localhost|http:\/\/127\.0\.0\.1)/`), which is not a
 * URL parser and let two hostile strings through:
 * `https://evil.com@internal.host/` (everything before the `@` is userinfo, so
 * the host is `internal.host`) and `http://localhost.attacker.com/` (a name
 * that merely starts with `localhost`). Neither could be delivered to — the
 * transport refuses both — but a registration check that accepts what delivery
 * refuses is worse than no check, because it reads like a filter.
 *
 * The rules are therefore the transport's own (`vetEndpointUrl` in
 * src/transport.ts), not a second copy, with one difference this surface is
 * entitled to: Appendix D.1's `webhooks.url` CHECK admits `http://localhost`
 * and `http://127.0.0.1`, so an adopter can REGISTER a local endpoint while it
 * is still writing a receiver. §5.2 fixes what that exception is worth: it is
 * granted "to a host that IS this machine", so `http://` is admitted here but
 * only to a loopback literal or the name `localhost` — which is what the old
 * regex was reaching for and missing. Delivering to one remains a separate
 * decision (`SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK`).
 *
 * Names are NOT resolved here, deliberately: this happens once and delivery
 * happens later, so a name that passed now could answer differently then. The
 * addresses behind a name are judged at the socket, every time. An IP literal
 * cannot change, so it is judged here.
 */
const REGISTRATION_URL_POLICY: UrlPolicy = {
  allowHttp: true,
  requireLoopbackHost: true,
  refuseBlockedLiteral: true,
};

export interface RegisteredWebhook {
  webhook_id: string;
  url: string;
  /** returned EXACTLY ONCE, at creation; never retrievable afterwards */
  secret: string;
}

/**
 * Apply the policy above and return the URL AS GIVEN — not `URL.href`. What the
 * adopter registered is what is stored, listed back and delivered to; silently
 * normalising it would mean an operator reading the dashboard is not looking at
 * the string their adopter sent.
 */
function validateEndpointUrl(url: unknown): string {
  try {
    vetEndpointUrl(url, REGISTRATION_URL_POLICY);
  } catch (e) {
    if (!(e instanceof WebhookRefused)) throw e;
    // the transport's own wording, carried out to the API caller: one rule and
    // one explanation, whether it is hit at registration or at delivery
    throw new ApiError(
      "INVALID_SCHEMA",
      `url must be https:// (or http:// to this machine for local development) — ${e.message.replace(/^refused: /, "")}`,
    );
  }
  const endpoint = url as string; // vetEndpointUrl refuses every non-string before this
  if (!storableUnderD1(endpoint)) {
    throw new ApiError(
      "INVALID_SCHEMA",
      "url is not storable under Appendix D.1, whose CHECK on webhooks.url admits only https://, " +
        "http://localhost… and http://127.0.0.1… — use one of those loopback spellings",
    );
  }
  return endpoint;
}

/**
 * Appendix D.1: `CHECK(url LIKE 'https://%' OR url LIKE 'http://localhost%' OR
 * url LIKE 'http://127.0.0.1%')`, restated here.
 *
 * It is not a duplicate of the check above and it is not the filter — it is a
 * PREFIX test, and a prefix of a string is exactly what the two decoys walked
 * through, which is why the parse runs first and this runs second. Its only job
 * is that a URL the normative schema cannot store comes back as a 400 with a
 * reason instead of a CHECK-constraint violation from SQLite. The narrowing is
 * real and worth knowing: `http://[::1]/…` and `http://127.0.0.5/…` name this
 * machine as truly as `127.0.0.1` does, and D.1 does not admit them.
 */
function storableUnderD1(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1");
}

export function registerWebhook(
  db: Db,
  store: SecretStore,
  agentId: string,
  rawUrl: unknown,
  nowMs: number,
): RegisteredWebhook {
  const url = validateEndpointUrl(rawUrl);
  const id = ulid(nowMs);
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const ref = `secretstore://webhook/${id}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    // §5.2 selects at most ONE endpoint per adopter, so registering a new one
    // retires the previous rather than fanning out.
    db.prepare("UPDATE webhooks SET status='dead', updated_at_ms=? WHERE agent_id=? AND status<>'dead'").run(nowMs, agentId);
    db.prepare(
      "INSERT INTO webhooks(id, agent_id, url, secret_hash, status, failure_count, updated_at_ms, secret_ref) VALUES (?,?,?,?, 'active', 0, ?, ?)",
    ).run(id, agentId, url, createHash("sha256").update(secret, "utf8").digest("hex"), nowMs, ref);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw e;
  }
  // the plaintext lands ONLY in the deployment-local store, after the commit
  store.put(ref, secret);
  return { webhook_id: id, url, secret };
}

export function deleteWebhook(db: Db, store: SecretStore, agentId: string, webhookId: string): { deleted: boolean } {
  const row = db.prepare("SELECT id, agent_id, secret_ref FROM webhooks WHERE id=?").get(webhookId) as
    | { id: string; agent_id: string; secret_ref: string | null }
    | undefined;
  // "own only" (Appendix H): another agent's endpoint is not acknowledged
  if (!row || row.agent_id !== agentId) throw new ApiError("NOT_FOUND", "webhook not found");
  db.prepare("DELETE FROM webhooks WHERE id=?").run(webhookId);
  if (row.secret_ref) store.delete(row.secret_ref);
  return { deleted: true };
}

/** The endpoint view the API may return — never the secret, never its ref. */
export function listWebhooks(db: Db, agentId: string): Array<{ webhook_id: string; url: string; status: string; failure_count: number }> {
  return (
    db
      .prepare("SELECT id, url, status, failure_count FROM webhooks WHERE agent_id=? ORDER BY updated_at_ms DESC, id")
      .all(agentId) as Array<{ id: string; url: string; status: string; failure_count: number }>
  ).map((r) => ({ webhook_id: r.id, url: r.url, status: r.status, failure_count: r.failure_count }));
}

export interface WebhookHealth {
  webhook_id: string;
  agent_id: string;
  url: string;
  /** §5.2 endpoint health: active | failing | dead */
  status: string;
  failure_count: number;
  last_error: string | null;
  updated_at_ms: number;
}

/**
 * Endpoint health for a set of agents — the P6 dashboard's dead-letter view is
 * the only reader. It selects the health columns EXPLICITLY, so neither
 * `secret_hash` nor `secret_ref` can reach a response through it (§3, and
 * Appendix H's `GET /v1/webhooks`: "never the secret, never its reference" —
 * the secret never leaves the deployment-local store).
 */
export function webhookHealth(db: Db, agentIds: readonly string[]): WebhookHealth[] {
  if (agentIds.length === 0) return [];
  const placeholders = agentIds.map(() => "?").join(",");
  return (
    db
      .prepare(
        `SELECT id, agent_id, url, status, failure_count, last_error, updated_at_ms
           FROM webhooks WHERE agent_id IN (${placeholders})
          ORDER BY updated_at_ms DESC, id`,
      )
      .all(...agentIds) as Array<{
      id: string;
      agent_id: string;
      url: string;
      status: string;
      failure_count: number;
      last_error: string | null;
      updated_at_ms: number;
    }>
  ).map((r) => ({
    webhook_id: r.id,
    agent_id: r.agent_id,
    url: r.url,
    status: r.status,
    failure_count: r.failure_count,
    last_error: r.last_error,
    updated_at_ms: r.updated_at_ms,
  }));
}

// ------------------------------------------------------------- the push loop

export interface WebhookRequest {
  url: string;
  body: string;
  signature: string;
}

export interface WebhookResponse {
  /** the HTTP status, or 0 for a transport-level timeout/failure */
  status: number;
  error?: string;
}

/**
 * How a push leaves the process. The real one is
 * `HttpsWebhookTransport` in src/transport.ts, which is where all the
 * address, redirect, timeout and size rules live; this interface is the seam
 * that keeps the §5.2 machine drivable without a network in the tests.
 *
 * Note what a transport is NOT given: the webhook secret. `pushOnce` resolves
 * it, signs the body and passes the resulting hex signature — so no transport,
 * including a third-party one a deployment supplies, can leak it.
 */
export interface WebhookTransport {
  send(req: WebhookRequest): WebhookResponse | Promise<WebhookResponse>;
}

/** A transport that sends nothing. Reporting 0 keeps the health rules honest
 *  rather than silently marking endpoints healthy — a deployment that installs
 *  this has switched push delivery off, and its adopters pull instead. */
export class NullTransport implements WebhookTransport {
  send(): WebhookResponse {
    return { status: 0, error: "no webhook transport configured" };
  }
}

export interface PushOutcome {
  request_id: string;
  state: "pushed" | "pending" | "dead_letter";
  endpoint_status?: "active" | "failing" | "dead";
  reason?: string;
}

/**
 * Deliver ONE claimed job. The body names the adoption request and its receipt;
 * the package itself is fetched by the adopter through `skill.adopt`, which is
 * what produces the `delivered` receipt event — a webhook 2xx only ever moves
 * the request to `pushed` (§5.2: the two machines share no state names).
 */
export async function pushOnce(
  db: Db,
  store: SecretStore,
  transport: WebhookTransport,
  job: ClaimedJob,
  nowMs: number,
): Promise<PushOutcome> {
  const req = job.request;
  const hook = req.webhook_id
    ? (db.prepare("SELECT id, url, secret_ref, status FROM webhooks WHERE id=?").get(req.webhook_id) as
        | { id: string; url: string; secret_ref: string | null; status: string }
        | undefined)
    : undefined;
  if (!hook) {
    // §5.2: no selected endpoint is loud, never a silent no-op — but it is
    // still a transition this worker causes, so it carries the same live-owner
    // CAS as every other one (P5 verdict 1, blocking #1).
    markEndpointMissing(db, req.id, job.lease_owner, nowMs);
    return { request_id: req.id, state: "dead_letter", reason: "endpoint_missing" };
  }

  // §5.2's webhook-dead row applies BEFORE anything is sent: a dead endpoint is
  // not an endpoint to try (P5 verdict 2, blocking B1).
  if (hook.status === "dead") {
    markEndpointDead(db, req.id, job.lease_owner, nowMs);
    return { request_id: req.id, state: "dead_letter", endpoint_status: "dead", reason: "endpoint_dead" };
  }

  const receipt = db.prepare("SELECT id FROM adoption_receipts WHERE adoption_request_id=?").get(req.id) as
    | { id: string }
    | undefined;
  // `kind` is what lets a receiver tell "the package you asked for is ready"
  // from "the package you are running has been revoked" — two messages on one
  // machine (§5.2), and a revocation notice carries the reason with it so the
  // adopter can act without another round trip.
  const kind = req.notification_kind ?? "adoption";
  const revocation =
    kind === "revocation"
      ? (db.prepare("SELECT revocation_reason FROM skill_versions WHERE id=?").get(req.skill_version_id) as
          | { revocation_reason: string | null }
          | undefined)
      : undefined;
  const body = JSON.stringify({
    kind,
    adoption_request_id: req.id,
    receipt_id: receipt?.id ?? null,
    skill_version_id: req.skill_version_id,
    adopter_agent_id: req.adopter_agent_id,
    attempt: req.attempt_count,
    server_at_ms: nowMs,
    ...(kind === "revocation" ? { revocation_reason: revocation?.revocation_reason ?? null } : {}),
  });

  const secret = hook.secret_ref === null ? undefined : store.get(hook.secret_ref);
  if (secret === undefined) {
    // an unresolvable secret is a delivery failure, not an unsigned push
    const status = recordWebhookResult(db, hook.id, false, nowMs, "secret_ref did not resolve");
    const out = failDelivery(db, req.id, job.lease_owner, nowMs);
    return { request_id: req.id, state: out.state as PushOutcome["state"], endpoint_status: status, reason: out.reason };
  }

  // the only await in the machine: the CAS predicates below are what make
  // a lease that expires while this is in flight safe (§5.2)
  const res = await transport.send({ url: hook.url, body, signature: signBody(secret, body) });
  const ok = res.status >= 200 && res.status < 300;
  const endpointStatus = recordWebhookResult(db, hook.id, ok, nowMs, ok ? undefined : res.error ?? `status ${res.status}`);
  // …and again after the push, but only on SUCCESS: the endpoint may have died
  // while this delivery was in flight (other deliveries failing concurrently, or
  // a replacement registered). §5.2's webhook-dead row is unconditional for a
  // pending/leased request, and `pushed` is terminal, so completing here would
  // be unrecoverable. When this push itself FAILED, §5.2's own precedence keeps
  // the `fail` transition — the fifth attempt is `max_attempts`, not
  // `endpoint_dead`, even though that same failure is what killed the endpoint.
  if (ok && endpointStatus === "dead") {
    markEndpointDead(db, req.id, job.lease_owner, nowMs);
    return { request_id: req.id, state: "dead_letter", endpoint_status: "dead", reason: "endpoint_dead" };
  }
  if (ok) {
    completeDelivery(db, req.id, job.lease_owner, nowMs);
    return { request_id: req.id, state: "pushed", endpoint_status: endpointStatus };
  }
  const out = failDelivery(db, req.id, job.lease_owner, nowMs);
  return { request_id: req.id, state: out.state as PushOutcome["state"], endpoint_status: endpointStatus, reason: out.reason };
}

/** One worker tick: claim what is due and push each claimed job.
 *  Sequential, not concurrent: one tick is one worker, and §5.2's per-request
 *  CAS is what protects against OTHER workers, not against this loop. */
export async function runWorkerOnce(
  db: Db,
  store: SecretStore,
  transport: WebhookTransport,
  worker: string,
  nowMs: number,
  limit = 10,
): Promise<PushOutcome[]> {
  const out: PushOutcome[] = [];
  for (const job of pollDelivery(db, worker, nowMs, limit)) {
    out.push(await pushOnce(db, store, transport, job, nowMs));
  }
  return out;
}
