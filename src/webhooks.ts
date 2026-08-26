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
import { registrationUrlPolicy, vetEndpointUrl, WebhookRefused, type WebhookDeliveryPolicy } from "./transport.ts";
import { REGISTRY_VERIFICATION_PATH } from "./lifecycle-v11.ts";
import type { AuthContext } from "./auth.ts";

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
 * The policy of a transport that declares none.
 *
 * `WebhookTransport` is a SEAM: the tests drive the §5.2 machine through a fake,
 * and a deployment may substitute one of its own. Such a transport is not the
 * SSRF-hardened HTTP one and imposes no scheme rule at all — it has no
 * addresses to judge and no socket to open — so registration has nothing to
 * refuse on its behalf and says so by admitting the loopback spellings D.1
 * stores. The narrowing `INV-08` is about belongs to the transport that
 * actually declines to connect, and that one declares its policy.
 */
export const UNDECLARED_DELIVERY_POLICY: WebhookDeliveryPolicy = { allowLoopback: true };

/** The policy registration must obey: the transport's own, or the undeclared
 *  reading above. Registration NEVER reads the environment variable itself —
 *  that read happens once, in `defaultTransport`, and this is how it travels. */
export function deliveryPolicyOf(transport: WebhookTransport | undefined): WebhookDeliveryPolicy {
  return transport?.deliveryPolicy?.() ?? UNDECLARED_DELIVERY_POLICY;
}

export interface RegisteredWebhook {
  webhook_id: string;
  url: string;
  /** returned EXACTLY ONCE, at creation; never retrievable afterwards */
  secret: string;
}

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
 * src/transport.ts), not a second copy, with two narrowings this surface is
 * entitled to and the transport does not need: `http://` is admitted only to a
 * host that IS this machine — a loopback literal or the name `localhost`, which
 * is what the old regex was reaching for and missing — and an IP LITERAL is
 * judged against the transport's own address table immediately, because a
 * literal cannot change between here and the socket.
 *
 * AND THE `http://` QUESTION IS NO LONGER DECIDED HERE AT ALL (§6.5.1,
 * `INV-08`). It used to be an unconditional `allowHttp: true` written in this
 * file, beside a transport that delivers over `http://` only when
 * `SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK` is set. Two constants, one rule: with
 * the flag off, this surface accepted `http://localhost:8080/hook`, answered
 * `201` with a secret, and every notice queued for that endpoint then
 * dead-lettered at the socket. Nothing was insecure; the operator was told
 * something untrue about their own deployment, which is the drift `INV-08`
 * closes.
 *
 * So the policy is a PARAMETER, taken from the transport this process holds
 * (`deliveryPolicyOf` below), and turned into URL rules by
 * `registrationUrlPolicy`. Whichever way the flag moves, both surfaces move
 * with it, because there is one value and not two.
 *
 * Names are NOT resolved here, deliberately: this happens once and delivery
 * happens later, so a name that passed now could answer differently then. The
 * addresses behind a name are judged at the socket, every time. A registration
 * that passed therefore says the destination is admissible under today's
 * policy — never that a later delivery will reach it.
 *
 * Apply the policy above and return the URL AS GIVEN — not `URL.href`. What the
 * adopter registered is what is stored, listed back and delivered to; silently
 * normalising it would mean an operator reading the dashboard is not looking at
 * the string their adopter sent.
 */
function validateEndpointUrl(url: unknown, policy: WebhookDeliveryPolicy): string {
  try {
    vetEndpointUrl(url, registrationUrlPolicy(policy));
  } catch (e) {
    if (!(e instanceof WebhookRefused)) throw e;
    // the transport's own wording, carried out to the API caller: one rule and
    // one explanation, whether it is hit at registration or at delivery. The
    // parenthesis is conditional for the same reason the rule is: on a
    // deployment that will not deliver over `http://`, offering the loopback
    // spelling as an alternative would be advertising a second refusal.
    const alternative = policy.allowLoopback ? " (or http:// to this machine, which this deployment delivers to)" : "";
    throw new ApiError(
      "INVALID_SCHEMA",
      `url must be https://${alternative} — ${e.message.replace(/^refused: /, "")}`,
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
  policy: WebhookDeliveryPolicy,
): RegisteredWebhook {
  // FIRST, AND THE ORDER IS THE REQUIREMENT (§6.5.1). A refusal that happened
  // after the secret was minted and stored would have leaked a credential for
  // an endpoint that does not exist; a refusal after the INSERT would have left
  // a row. Nothing below this line runs for a URL this deployment will not
  // deliver to — not `randomBytes`, not `ulid`, not `BEGIN IMMEDIATE`.
  const url = validateEndpointUrl(rawUrl, policy);
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
  /**
   * True when the transport DECLINED THE DESTINATION rather than failing to
   * reach it — a forbidden address, a scheme this deployment does not deliver
   * over, credentials in the URL. §6.5.2 has to report those two as different
   * `error_code`s, and a flag the transport sets is the only way to tell them
   * apart that does not involve reading its English.
   */
  refused?: boolean;
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
  /**
   * §6.5.1: the destinations this transport is willing to open a connection to,
   * so the REGISTRATION surface can refuse what delivery would refuse
   * (`INV-08`). Optional because the seam admits transports that judge no
   * address at all — see `UNDECLARED_DELIVERY_POLICY` for what registration
   * makes of one.
   */
  deliveryPolicy?(): WebhookDeliveryPolicy;
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
  // §5.2: the notice carries the reason, the successor when there is one, and
  // where the recipient can ask the registry for a verdict of its own. All
  // three are read AT PUSH TIME from the row, so a successor attached after the
  // revocation — which §5.1b explicitly allows — reaches an adopter whose
  // delivery had not yet succeeded, rather than a snapshot taken at enqueue.
  const revocation =
    kind === "revocation"
      ? (db
          .prepare(
            `SELECT v.revocation_reason AS revocation_reason,
                    v.superseded_by_version_id AS successor_version_id,
                    s.semantic_version AS successor_semantic_version
               FROM skill_versions v
               LEFT JOIN skill_versions s ON s.id = v.superseded_by_version_id
              WHERE v.id = ?`,
          )
          .get(req.skill_version_id) as
          | { revocation_reason: string | null; successor_version_id: string | null; successor_semantic_version: string | null }
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
    ...(kind === "revocation"
      ? {
          revocation_reason: revocation?.revocation_reason ?? null,
          // NULL rather than omitted, both of them. An adopter reading a notice
          // has to be able to tell "there is no replacement" from "this server
          // does not say", and an absent member says the second thing while
          // meaning the first.
          successor_version_id: revocation?.successor_version_id ?? null,
          successor_semantic_version: revocation?.successor_semantic_version ?? null,
          registry_verification_path: REGISTRY_VERIFICATION_PATH,
        }
      : {}),
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

// ------------------------------------------------------------- test delivery
//
// §6.5.2. An operator registers an endpoint and then has no way to learn
// whether it works except by causing a real adoption and reading the health
// column afterwards. This is the missing answer: one push, on demand, over the
// REAL transport and with the REAL secret, reported to the caller.
//
// WHAT IT IS NOT ALLOWED TO BE is a second delivery machine. It writes no queue
// row, claims no lease, and — the part that matters most — records NO endpoint
// health: `recordWebhookResult`, `failDelivery`, `completeDelivery`,
// `markEndpointDead` and `markEndpointMissing` are the five functions that move
// §5.2 state, and none of them is called from here. A test that could push an
// endpoint from `failing` to `dead` would be a diagnostic that damages the
// thing it diagnoses, and an endpoint a test could keep alive would be a health
// column reporting the operator's clicking rather than the adopters' notices.
// So a dead endpoint stays dead and is still testable, which is how an operator
// finds out that a repaired receiver is answering again.

/** §6.5.2's `error_code` vocabulary. `null` accompanies a delivered test. */
export const WEBHOOK_TEST_ERROR_CODES = ["non_2xx", "refused", "transport_error", "secret_unresolved"] as const;
export type WebhookTestErrorCode = (typeof WEBHOOK_TEST_ERROR_CODES)[number];

/** The bound on `error_detail`. The endpoint's own body is never a candidate —
 *  the transport does not return it — so this bounds the transport's message. */
export const MAX_TEST_ERROR_DETAIL = 200;

export interface WebhookTestResult {
  /** 2xx from the endpoint. Never true for a queued notice — this IS the push */
  delivered: boolean;
  /** the endpoint's status, or `null` when no exchange produced one */
  http_status: number | null;
  /** wall-clock milliseconds spent on this attempt */
  latency_ms: number;
  /** one of `WEBHOOK_TEST_ERROR_CODES`, or `null` on a delivered test */
  error_code: string | null;
  /** a bounded, sanitized line from the transport — never the endpoint's body */
  error_detail: string | null;
}

/** ASCII control characters, written as escapes so this source carries none. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * One line, control characters removed, bounded.
 *
 * The endpoint's RESPONSE BODY cannot arrive here: `HttpsWebhookTransport`
 * counts the body's bytes and throws them away, and the strings it returns are
 * its own vocabulary. This function is the second bound rather than the first,
 * and it exists because a transport a deployment substitutes is not held to
 * that discipline by the type system.
 */
function boundedDetail(text: string): string {
  const clean = text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return clean.length > MAX_TEST_ERROR_DETAIL ? `${clean.slice(0, MAX_TEST_ERROR_DETAIL - 1)}…` : clean;
}

/**
 * The audit row §6.5.2 requires, and what is deliberately NOT in it.
 *
 * Not the secret and not the signature, for the reason §5.2 gives everywhere
 * else. Not the response body, which never reaches this module. And not the
 * ENDPOINT URL: a registered URL may carry a query string, a query string is a
 * place people put tokens, and `webhooks.url` already holds the string for a
 * reader entitled to it. The row names the endpoint by id and says what
 * happened to it.
 */
function auditTest(db: Db, auth: AuthContext, webhookId: string, result: WebhookTestResult, nowMs: number): void {
  db.prepare(
    "INSERT INTO activity_log(id, workspace_id, actor_agent_id, action, subject_id, details_json, created_at_ms) VALUES (?,?,?,?,?,?,?)",
  ).run(
    ulid(nowMs),
    auth.workspace_id,
    auth.agent_id,
    "webhook.test",
    webhookId,
    JSON.stringify({
      delivered: result.delivered,
      http_status: result.http_status,
      latency_ms: result.latency_ms,
      error_code: result.error_code,
    }),
    nowMs,
  );
}

/**
 * `POST /v1/webhooks/{webhook_id}/test` — §6.5.2.
 *
 * Authorization is the shape §6.1 uses for a signing key: the endpoint's own
 * agent, or an admin/owner of the workspace that agent belongs to. An endpoint
 * of another workspace, and an endpoint of another member asked for by someone
 * who is neither, are both `NOT_FOUND` — the answer `deleteWebhook` already
 * gives, because acknowledging an endpoint is itself information.
 */
export async function testWebhookDelivery(
  db: Db,
  store: SecretStore,
  transport: WebhookTransport,
  auth: AuthContext,
  webhookId: unknown,
  nowMs: number,
): Promise<WebhookTestResult> {
  if (typeof webhookId !== "string" || webhookId.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "webhook_id must be a non-empty string");
  }
  if (auth.role === null) throw new ApiError("FORBIDDEN", "testing an endpoint requires a workspace membership");
  const found = db
    .prepare(
      `SELECT w.id AS id, w.agent_id AS agent_id, w.url AS url, w.secret_ref AS secret_ref, a.workspace_id AS workspace_id
         FROM webhooks w JOIN agents a ON a.id = w.agent_id
        WHERE w.id = ?`,
    )
    .get(webhookId) as
    | { id: string; agent_id: string; url: string; secret_ref: string | null; workspace_id: string }
    | undefined;
  const mayTest =
    found !== undefined &&
    found.workspace_id === auth.workspace_id &&
    (found.agent_id === auth.agent_id || auth.role === "admin" || auth.role === "owner");
  if (!mayTest || found === undefined) throw new ApiError("NOT_FOUND", "webhook not found");
  const hook = found;

  const finish = (result: WebhookTestResult): WebhookTestResult => {
    auditTest(db, auth, hook.id, result, nowMs);
    return result;
  };

  // The clock is the REAL one and not the registry's injectable `now`: a
  // latency is a measurement of this attempt, and a deployment that pins the
  // server clock for reproducibility would otherwise publish a measured zero.
  const startedAt = Date.now();
  const secret = hook.secret_ref === null ? undefined : store.get(hook.secret_ref);
  if (secret === undefined) {
    // An unsigned push is not a test of anything an adopter would accept, so
    // nothing is sent. Reported as its own code rather than as a failure to
    // connect, which is what an operator would otherwise go looking for.
    return finish({
      delivered: false,
      http_status: null,
      latency_ms: Math.max(0, Date.now() - startedAt),
      error_code: "secret_unresolved",
      error_detail: "the endpoint's signing secret did not resolve in the deployment-local store",
    });
  }

  // `kind:"test"` is what lets a receiver answer a probe without treating it as
  // an adoption. It carries no `adoption_request_id` and no `receipt_id`,
  // because there is no request and no receipt: a test push proves that the
  // endpoint answers, and `INV-07`'s distinction between queued and delivered
  // is untouched by it, since nothing was queued.
  const body = JSON.stringify({
    kind: "test",
    webhook_id: hook.id,
    adopter_agent_id: hook.agent_id,
    requested_by_agent_id: auth.agent_id,
    server_at_ms: nowMs,
  });
  const res = await transport.send({ url: hook.url, body, signature: signBody(secret, body) });
  const latency = Math.max(0, Date.now() - startedAt);
  const delivered = res.status >= 200 && res.status < 300;
  return finish({
    delivered,
    http_status: res.status === 0 ? null : res.status,
    latency_ms: latency,
    error_code: delivered ? null : res.refused === true ? "refused" : res.status === 0 ? "transport_error" : "non_2xx",
    error_detail: delivered ? null : boundedDetail(res.error ?? `status ${res.status}`),
  });
}
