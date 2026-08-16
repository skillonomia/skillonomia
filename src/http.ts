// REST adapter — Appendix H routes mirrored 1:1 onto the service layer, plus
// the /mcp mount of the MCP adapter. No business logic here (§2): parse,
// authenticate, dispatch, serialize. The error envelope and status mapping
// come from src/errors.ts; idempotent replays write the STORED response bytes
// with `Idempotency-Replayed: true` (Appendix H).
import { createServer, type Server } from "node:http";
import type { Registry, SearchParams } from "./service.ts";
import { SEARCH_FILTERS } from "./service.ts";
import { ApiError, asApiError, isApiError } from "./errors.ts";
import { handleMcpMessage, type JsonRpcRequest } from "./mcp.ts";
import { DASHBOARD_VIEWS, renderDashboard, serializeDashboard, parseDashboardFormat } from "./dashboard.ts";
import { VERSION } from "./version.ts";
import {
  CONSOLE_COOKIE,
  checkCsrf,
  checkOrigin,
  clearedCookie,
  parseCookies,
  sessionCookie,
  type ConsoleSession,
} from "./console-session.ts";
import { CONSOLE_CONTRACT_VERSION } from "./console-view.ts";
import { consolePage, consoleScript, loginPage } from "./console-page.ts";

/** Reported by `/health`; the release version of the running build.
 *  Re-exported from src/version.ts — the literal lives in package.json only. */
export const SERVICE_VERSION = VERSION;

export interface RestRequest {
  method: string;
  /** path + query string, e.g. "/v1/skills?q=x" */
  url: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Uploads are base64 in JSON; §4.1b caps the archive at 64 MiB uncompressed. */
const MAX_BODY_BYTES = 96 * 1024 * 1024;

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, bodyJson: string, extra: Record<string, string> = {}): RestResponse {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: bodyJson };
}

/**
 * The header a console mutation carries its CSRF token in, and the one place its
 * name is written on the server. `console/app.ts` holds the other.
 */
const CSRF_HEADER = "x-skillonomia-console-csrf";

/**
 * `INV-04`: `Secure` outside localhost.
 *
 * The decision is made from the request's own `Host`, because that is what the
 * browser will compare the cookie against. A loopback host gets a cookie without
 * `Secure` — a `Secure` cookie on `http://127.0.0.1` is discarded by the browser
 * and the console could not run at all — and everything else gets one with it.
 * There is no configuration switch here on purpose: a flag that can be turned
 * off is a flag that will be found off in a deployment.
 */
function secureFor(host: string | undefined): boolean {
  if (typeof host !== "string") return true;
  const name = host.replace(/:\d+$/, "").toLowerCase().replace(/^\[|\]$/g, "");
  return !(name === "localhost" || name === "127.0.0.1" || name === "::1");
}

/** Pages and the bundle. `nosniff` and a `frame-ancestors 'none'` CSP, because a
 *  console in somebody else's frame is the clickjacking half of the same problem
 *  `SameSite=Strict` covers on the request side. */
function html(status: number, body: string, contentType = "text/html; charset=utf-8"): RestResponse {
  return {
    status,
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    },
    body,
  };
}

/**
 * `P2-R2-001` — WHERE THE VERSIONED-CONTRACT BOUNDARY IS DRAWN, AND WHY THERE.
 *
 * `console/app.ts` refuses a response that does not announce `console.v1` before
 * it reads a field of it (`INV-05`). Until this fix that held for the answers a
 * console route SUCCEEDS with and for none of the answers it FAILS with: a `400`,
 * a `409` and a `412` left here as a bare `{"error":{…}}`, and the browser read
 * `code`, `message` and `current_state` out of a document whose version nobody
 * had checked. P2 REVIEW-2 rewrote one of those refusals to announce `console.v999`
 * with a planted message and the console rendered the planted message.
 *
 * THE BOUNDARY IS THE REQUEST PATH, and it is the console surface: a response to
 * a request under `/v1/console/` carries the marker, and every other response
 * carries the envelope `src/errors.ts` has always produced, byte for byte. That
 * is the line `INV-08` asks for. The error envelope is the machine-to-machine
 * Registry API's error envelope too — `v0.1.6` clients read it, `SPEC.md` §6 and
 * Appendix H fix its shape, and `test/spec-parity.test.ts` compares that shape
 * against the specification — so the marker is added where the console reads and
 * nowhere a released client does. Inside the console surface the addition is
 * additive as well: a field beside `error`, with `error` unchanged, on a surface
 * P2 itself introduced.
 *
 * `path`, not a flag threaded through the throw sites: a refusal is raised deep
 * inside the service layer, which knows nothing about channels, and a flag would
 * be a second thing to keep in step with the routes — which is the shape of the
 * defect being closed here.
 */
const CONSOLE_SURFACE = "/v1/console";

function isConsoleSurface(rawUrl: string | undefined): boolean {
  if (typeof rawUrl !== "string") return false;
  let requested: string;
  try {
    requested = new URL(rawUrl, "http://registry.local").pathname;
  } catch {
    return false;
  }
  return requested === CONSOLE_SURFACE || requested.startsWith(`${CONSOLE_SURFACE}/`);
}

/** The one place a structured refusal becomes bytes. Every exit that writes an
 *  error envelope — the router's, the oversize-body guard's and the listener's
 *  internal-error tail — goes through it, so the marker is a property of the
 *  SURFACE rather than of the exits somebody remembered. */
function errorBody(envelope: { error: { code: string; message: string; current_state?: string } }, rawUrl: string | undefined): string {
  return JSON.stringify(isConsoleSurface(rawUrl) ? { contract: CONSOLE_CONTRACT_VERSION, ...envelope } : envelope);
}

function errorResponse(e: ApiError, rawUrl: string | undefined): RestResponse {
  return json(e.httpStatus, errorBody(e.toEnvelope(), rawUrl));
}

function parseBody(req: RestRequest): any {
  if (req.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString("utf8"));
  } catch {
    throw new ApiError("INVALID_SCHEMA", "request body must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("INVALID_SCHEMA", "request body must be a JSON object");
  }
  return parsed;
}

function decodeArchive(body: any): Buffer {
  if (typeof body.archive !== "string" || body.archive.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "archive (base64 string) required");
  }
  return Buffer.from(body.archive, "base64");
}

/** Surface 14's upload: the SOURCE tree, base64 of a §4.1b archive. It carries
 *  its own field name rather than reusing `archive`, because a source tree and
 *  a packed package are different documents and a route that accepted either
 *  under one name would make the difference invisible at the call site. */
function decodeSource(body: any): Buffer {
  if (typeof body.source !== "string" || body.source.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "source (base64 string of the source tree) required");
  }
  return Buffer.from(body.source, "base64");
}

/** No coercion (verdict 1 major #2): a non-string key is INVALID_SCHEMA. */
function idemKey(body: any): string | undefined {
  if (body.idempotency_key !== undefined && typeof body.idempotency_key !== "string") {
    throw new ApiError("INVALID_SCHEMA", "idempotency_key must be a string");
  }
  return body.idempotency_key;
}

/** Serialize an idempotent mutation outcome: replayed bytes verbatim + header.
 *  The status is the Appendix H success status of the route — a convergent
 *  noop or a replay reproduces it unchanged (verdict 1 minor). */
function mutationResponse(
  out: { replayed: boolean; responseJson: string; response: unknown },
  successStatus: number,
): RestResponse {
  const extra: Record<string, string> = out.replayed ? { "Idempotency-Replayed": "true" } : {};
  return json(successStatus, out.responseJson, extra);
}

/**
 * The console's half of `mutationResponse` — `P2-R1-004`.
 *
 * EVERY console response carries `contract`, including the ones a mutation
 * returns, because `console/app.ts` refuses a payload whose version it does not
 * know BEFORE it reads a field of it. A surface with one unversioned answer is a
 * surface where that check has a hole, and the hole is exactly where a payload
 * from a server this build was not written for gets consumed.
 *
 * The version is added on the way out rather than stored in the idempotency
 * record, so a replayed mutation is stamped with the version of the build that
 * replayed it, and the machine-to-machine shape under `/v1/drafts/` is untouched
 * (`P2-FR-15`, `INV-08`).
 */
function consoleMutationResponse(
  out: { replayed: boolean; responseJson: string; response: unknown },
  successStatus: number,
): RestResponse {
  const extra: Record<string, string> = out.replayed ? { "Idempotency-Replayed": "true" } : {};
  const body = JSON.parse(out.responseJson) as Record<string, unknown>;
  return json(successStatus, JSON.stringify({ contract: CONSOLE_CONTRACT_VERSION, ...body }), extra);
}

/**
 * Query string → surface-5 parameters. Every declared filter plus the two
 * pagination controls, passed through as strings: the service does the typing
 * and the validation, so REST and MCP cannot diverge (verdict 1 major #2).
 */
function searchParamsOf(url: URL): SearchParams {
  const params: SearchParams = {};
  for (const k of [...SEARCH_FILTERS, "limit", "cursor"] as const) {
    const v = url.searchParams.get(k);
    if (v !== null) params[k] = v;
  }
  return params;
}

/**
 * Pure router: one RestRequest in, one RestResponse out. The node:http server
 * below is a byte-shoveling wrapper around this function, so the full contract
 * is testable without sockets.
 */
export function handleRest(registry: Registry, req: RestRequest): RestResponse {
  try {
    if (req.body.length > MAX_BODY_BYTES) {
      throw new ApiError("LIMIT_EXCEEDED", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const url = new URL(req.url, "http://registry.local");
    const path = url.pathname;
    const method = req.method.toUpperCase();
    // One capture variable for the whole router. It is declared here rather than
    // at its first use because the console's routes now come first and the rest
    // of the file has always shared one — two variables would be two things to
    // keep in step, and `test/spec-parity.test.ts` reads this file's routes by
    // the shape of these lines.
    let m: RegExpExecArray | null;

    // -- unauthenticated: liveness. Launch plus a `/health` smoke is the whole
    // acceptance requirement of the packaged-tarball and binary release paths,
    // so this route must answer before any credential exists and must never
    // carry instance data beyond liveness.
    if (method === "GET" && path === "/health") {
      return json(200, JSON.stringify({ status: "ok", service: "skillonomia", version: SERVICE_VERSION }));
    }

    // -- unauthenticated: one-time bootstrap exchange (§9.1)
    if (method === "POST" && path === "/v1/auth/bootstrap") {
      const body = parseBody(req);
      return json(200, JSON.stringify(registry.exchangeBootstrap(body.bootstrap_token)));
    }

    // ---- V1 P2: the Owner Console.
    //
    // TWO UNAUTHENTICATED THINGS AND NOTHING ELSE: the sign-in page, and the
    // bundle. Neither carries a draft, a credential or an identifier — the page
    // is a fixed shell (`src/console-page.ts`) and the bundle is the same bytes
    // for every visitor. Everything under `/console` past this point, and every
    // route under `/v1/console/`, needs a live session (`P2-FR-01`).

    if (method === "GET" && path === "/console/login") {
      return html(200, loginPage());
    }

    // The literal is written out here rather than compared against the constant,
    // because `test/spec-parity.test.ts` reads the routes of this file out of its
    // TEXT and a route named by a constant is a route Appendix H cannot be
    // checked against. That the constant and this literal agree is asserted by
    // `test/v1p2-console-api.test.ts`, which asks the router for the path the
    // page references and requires the bundle back.
    if (method === "GET" && path === "/console/app.js") {
      return html(200, consoleScript(), "text/javascript; charset=utf-8");
    }

    // The session establishment. It is not authenticated BY A COOKIE — it is
    // what mints one — and it is authenticated by the one-time ticket in its
    // body. The Origin check applies here too: a form on another site must not
    // be able to plant a session in this browser.
    if (method === "POST" && path === "/v1/console/session") {
      checkOrigin(req.headers["origin"], req.headers["host"]);
      const body = parseBody(req);
      const opened = registry.openConsoleSession(body.ticket);
      return json(
        201,
        JSON.stringify({
          contract: CONSOLE_CONTRACT_VERSION,
          agent_id: opened.agent_id,
          actor_role: opened.actor_role,
          expires_at_ms: opened.expires_at_ms,
          // the CSRF token is delivered HERE, in a body, and the page keeps it in
          // memory. It is deliberately not a cookie: `P2-FR-14` has to be able to
          // say the browser's stores are empty.
          csrf_token: opened.csrf_token,
        }),
        {
          "Set-Cookie": sessionCookie(
            opened.cookie_value,
            opened.expires_at_ms - opened.created_at_ms,
            secureFor(req.headers["host"]),
          ),
          "Cache-Control": "no-store",
        },
      );
    }

    const cookies = parseCookies(req.headers["cookie"]);
    const session: ConsoleSession | null = registry.resolveConsoleSession(cookies[CONSOLE_COOKIE]);

    if (method === "GET" && path === "/console") {
      // `P2-FR-01`: no session, no console. The body is the sign-in page and the
      // status is 401 — a browser lands on something usable and a script sees a
      // refusal, and neither is told anything about the deployment.
      if (!session) return html(401, loginPage());
      return html(200, consolePage());
    }

    if (
      path === "/v1/console/session" ||
      path === "/v1/console/logout" ||
      path === "/v1/console/fleet" ||
      path.startsWith("/v1/console/drafts") ||
      path.startsWith("/v1/console/capabilities") ||
      path.startsWith("/v1/console/assignments")
    ) {
      if (!session) throw new ApiError("UNAUTHORIZED", "the owner console requires a session");
      // Every MUTATION under the console carries both defences: the request must
      // come from this origin, and it must echo the token only this page holds
      // (`P2-FR-13`). Reads carry neither, because a read changes nothing and a
      // `SameSite=Strict` cookie is not sent cross-site to begin with.
      if (method !== "GET") {
        checkOrigin(req.headers["origin"], req.headers["host"]);
        checkCsrf(session, req.headers[CSRF_HEADER]);
      }

      if (method === "GET" && path === "/v1/console/session") {
        // The CSRF token comes back here, and this is the route a reload uses to
        // get it again — the page keeps it in memory only, so a refresh has no
        // copy. Handing it out is safe for the reason it is not a credential:
        // reading this response requires the cookie, `SameSite=Strict` keeps the
        // cookie off a cross-site request, and the same-origin policy keeps a
        // cross-site script from reading the body even if one were sent.
        return json(
          200,
          JSON.stringify({
            contract: CONSOLE_CONTRACT_VERSION,
            agent_id: session.agent_id,
            actor_role: session.actor_role,
            expires_at_ms: session.expires_at_ms,
            csrf_token: session.csrf_token,
          }),
          { "Cache-Control": "no-store" },
        );
      }

      if (method === "POST" && path === "/v1/console/logout") {
        // `P2-R1-002`: the answer to a logout is the answer to "was the session
        // revoked", and nothing else. A revocation that did not happen is a
        // refusal naming the state the session is STILL in, not a 200 with a
        // cleared cookie — a cleared cookie the server does not know about is a
        // session an owner believes is closed and an attacker can still use.
        try {
          registry.revokeConsoleSession(session.session_id);
        } catch {
          // the driver's message is not repeated: it names a file path and this
          // is a browser-facing surface
          throw new ApiError(
            "CONFLICT",
            "the session could not be revoked, so the logout did not take effect — retry",
            "active",
          );
        }
        return json(200, JSON.stringify({ contract: CONSOLE_CONTRACT_VERSION, logged_out: true }), {
          "Set-Cookie": clearedCookie(secureFor(req.headers["host"])),
          "Cache-Control": "no-store",
        });
      }

      // From here the session becomes the ordinary `AuthContext` every service
      // method takes, rate-limited on the same limiter an API key uses.
      const cauth = registry.consoleAuth(session);

      if (method === "GET" && path === "/v1/console/drafts") {
        return json(200, JSON.stringify(registry.consoleInbox(cauth)), { "Cache-Control": "no-store" });
      }

      m = /^\/v1\/console\/drafts\/([^/]+)\/audit$/.exec(path);
      if (method === "GET" && m) {
        return json(200, JSON.stringify(registry.consoleAudit(cauth, m[1])), { "Cache-Control": "no-store" });
      }

      m = /^\/v1\/console\/drafts\/([^/]+)\/revisions$/.exec(path);
      if (method === "POST" && m) {
        const body = parseBody(req);
        // the SAME service method the API-key surface calls: an edit is a new
        // revision with both previews re-run, and there is one implementation
        const out = registry.reviseDraft(cauth, m[1], body, idemKey(body));
        return consoleMutationResponse(out, 201);
      }

      m = /^\/v1\/console\/drafts\/([^/]+)\/approve$/.exec(path);
      if (method === "POST" && m) {
        const body = parseBody(req);
        return consoleMutationResponse(registry.decideDraft(cauth, m[1], "approved", body, idemKey(body)), 201);
      }

      m = /^\/v1\/console\/drafts\/([^/]+)\/reject$/.exec(path);
      if (method === "POST" && m) {
        const body = parseBody(req);
        return consoleMutationResponse(registry.decideDraft(cauth, m[1], "rejected", body, idemKey(body)), 201);
      }

      m = /^\/v1\/console\/drafts\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        const revision = url.searchParams.get("revision_id");
        return json(200, JSON.stringify(registry.consoleDraft(cauth, m[1], revision ?? undefined)), {
          "Cache-Control": "no-store",
        });
      }

      // ------------------------------------------- V1 P3: the capability and
      // its assignments. Reads answer the console's contract; mutations go
      // through the same idempotency and precondition machinery every other
      // mutation of this registry uses, and their refusals — `409` and `412` —
      // carry `current_state` so the page refetches rather than guessing
      // (`P3-FR-12`).
      if (method === "GET" && path === "/v1/console/capabilities") {
        return json(200, JSON.stringify(registry.consoleCapabilities(cauth)), { "Cache-Control": "no-store" });
      }

      m = /^\/v1\/console\/capabilities\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        return json(200, JSON.stringify(registry.consoleCapability(cauth, m[1])), { "Cache-Control": "no-store" });
      }

      if (method === "GET" && path === "/v1/console/fleet") {
        return json(200, JSON.stringify({ contract: CONSOLE_CONTRACT_VERSION, agents: registry.fleetAgents(cauth) }), {
          "Cache-Control": "no-store",
        });
      }

      if (method === "POST" && path === "/v1/console/assignments") {
        const body = parseBody(req);
        return consoleMutationResponse(registry.assignRevision(cauth, body, idemKey(body)), 201);
      }

      m = /^\/v1\/console\/assignments\/([^/]+)\/audit$/.exec(path);
      if (method === "GET" && m) {
        return json(200, JSON.stringify(registry.assignmentAudit(cauth, m[1])), { "Cache-Control": "no-store" });
      }

      m = /^\/v1\/console\/assignments\/([^/]+)\/(activate|pause|revoke)$/.exec(path);
      if (method === "POST" && m) {
        const body = parseBody(req);
        return consoleMutationResponse(
          registry.assignmentLifecycle(cauth, m[1], m[2] as "activate" | "pause" | "revoke", body, idemKey(body)),
          200,
        );
      }

      m = /^\/v1\/console\/assignments\/([^/]+)\/revision$/.exec(path);
      if (method === "POST" && m) {
        const body = parseBody(req);
        return consoleMutationResponse(registry.selectAssignmentRevision(cauth, m[1], body, idemKey(body)), 200);
      }

      m = /^\/v1\/console\/assignments\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        return json(200, JSON.stringify(registry.consoleAssignment(cauth, m[1])), { "Cache-Control": "no-store" });
      }

      throw new ApiError("NOT_FOUND", `no route ${method} ${path}`);
    }

    // -- everything else: Bearer auth + per-key rate limit
    const auth = registry.authenticate(req.headers["authorization"]);

    // The machine-to-machine half of the console login. Authenticated by the
    // Registry API key, over the channel that already carries one, and answering
    // with a ticket that is not a key: it opens one session, once, within five
    // minutes. This is the route that keeps `INV-04` true — the browser never
    // holds a credential because the credential never leaves this side.
    if (method === "POST" && path === "/v1/console/tickets") {
      const minted = registry.mintConsoleTicket(auth);
      return json(201, JSON.stringify({ contract: CONSOLE_CONTRACT_VERSION, ...minted }), {
        "Cache-Control": "no-store",
      });
    }

    // `INV-02`: THE OBSERVED-STATE INTAKE, AND WHY IT IS HERE RATHER THAN UNDER
    // `/v1/console/`. Observed state changes only on structured backend,
    // adapter or runtime evidence. A route reachable with a console session
    // would be a route an owner action could reach, so it is mounted on the
    // machine-to-machine surface, behind a Bearer key, and the console client
    // never calls it. `P3-FR-06` is three things: this placement, the absence of
    // an `owner` member in the `source` vocabulary, and the fact that no
    // lifecycle writer can reach the observation table.
    m = /^\/v1\/assignments\/([^/]+)\/observations$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      return mutationResponse(registry.recordAssignmentObservation(auth, m[1], body, idemKey(body)), 201);
    }

    if (method === "POST" && path === "/mcp") {
      const msg = parseBody(req) as JsonRpcRequest;
      return json(200, JSON.stringify(handleMcpMessage(registry, auth, msg)));
    }

    if (method === "POST" && path === "/v1/skills") {
      const body = parseBody(req);
      // body.slug passes through untouched — the service validates its type
      // and shape; the adapter never coerces (verdict 1 major #2)
      const out = registry.createVersion(auth, { slug: body.slug, archive: decodeArchive(body) }, idemKey(body));
      return mutationResponse(out, 201);
    }

    m = /^\/v1\/skills\/([^/]+)\/versions$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.createVersion(auth, { skill_id: m[1], archive: decodeArchive(body) }, idemKey(body));
      return mutationResponse(out, 201);
    }

    // -- surface 14: the registry packs and signs. `source` is the SOURCE tree
    // as an archive, never a path — the server reads bytes a client sent, and
    // never a location a caller named.
    if (method === "POST" && path === "/v1/skills/from-source") {
      const body = parseBody(req);
      const out = registry.createFromDir(auth, { slug: body.slug, source: decodeSource(body) }, idemKey(body));
      return mutationResponse(out, 201);
    }

    m = /^\/v1\/skills\/([^/]+)\/versions\/from-source$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.createFromDir(auth, { skill_id: m[1], source: decodeSource(body) }, idemKey(body));
      return mutationResponse(out, 201);
    }

    m = /^\/v1\/versions\/([^/]+)\/lint$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.lintVersion(auth, m[1], idemKey(body));
      return mutationResponse(out, 200);
    }

    if (method === "POST" && path === "/v1/verify") {
      const body = parseBody(req);
      return json(200, JSON.stringify(registry.verifyStateless(auth, decodeArchive(body))));
    }

    // ---- P4: surfaces 3, 4 (transition), 10, 11 + §7.3 approvals + tlog read

    m = /^\/v1\/versions\/([^/]+)\/reviews$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.review(auth, m[1], body, idemKey(body));
      return mutationResponse(out, 200);
    }

    m = /^\/v1\/versions\/([^/]+)\/verify$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.verifyVersion(auth, m[1], idemKey(body));
      return mutationResponse(out, 200);
    }

    // ---- surface 12: skill.publish (verified → published + §4.3.8 countersign)

    m = /^\/v1\/versions\/([^/]+)\/publish$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.publishVersion(auth, m[1], idemKey(body));
      return mutationResponse(out, 200);
    }

    m = /^\/v1\/versions\/([^/]+)\/supersede$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.supersedeVersion(auth, m[1], body, idemKey(body));
      return mutationResponse(out, 200);
    }

    m = /^\/v1\/versions\/([^/]+)\/deprecate$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.deprecateVersion(auth, m[1], idemKey(body));
      return mutationResponse(out, 200);
    }

    m = /^\/v1\/versions\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.revokeVersion(auth, m[1], body, idemKey(body));
      return mutationResponse(out, 200);
    }

    m = /^\/v1\/versions\/([^/]+)\/approvals$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.approve(auth, m[1], body, idemKey(body));
      return mutationResponse(out, 201);
    }

    // ---- P5: surfaces 6, 7, 8, 9 (Appendix H routes, 1:1)

    if (method === "POST" && path === "/v1/adoptions/requests") {
      const body = parseBody(req);
      const out = registry.requestAdoption(auth, body, idemKey(body));
      return mutationResponse(out, 201);
    }

    m = /^\/v1\/adoptions\/([^/]+)\/adopt$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.adopt(auth, m[1], body, idemKey(body));
      return mutationResponse(out, 200);
    }

    m = /^\/v1\/receipts\/([^/]+)\/events$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.validateOutcome(auth, m[1], body, idemKey(body));
      return mutationResponse(out, 200);
    }

    // ---- §5.4: the transfer, and the grants it runs under

    m = /^\/v1\/versions\/([^/]+)\/transfers$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      // `recipient` is taken from the body verbatim: the service decides what a
      // recipient is and refuses one that is absent. The route never supplies a
      // default, and there is no form of this call that omits it.
      const out = registry.transfer(auth, { skill_version_id: m[1], recipient: body.recipient }, idemKey(body));
      return mutationResponse(out, 201);
    }

    if (method === "POST" && path === "/v1/transfer-grants") {
      const body = parseBody(req);
      return mutationResponse(registry.createGrant(auth, body, idemKey(body)), 201);
    }

    if (method === "GET" && path === "/v1/transfer-grants") {
      return json(200, JSON.stringify(registry.listGrants(auth)));
    }

    // ---- V1 P1: capture → draft. `POST /v1/captures` answers 201 for a draft
    //      AND for a refusal, because both record an arrival the registry
    //      answered; the `outcome` field of the body is which. A request whose
    //      shape is wrong never reaches here as a 201: it is INVALID_SCHEMA.

    if (method === "POST" && path === "/v1/captures") {
      const body = parseBody(req);
      return mutationResponse(registry.capture(auth, body, idemKey(body)), 201);
    }

    if (method === "GET" && path === "/v1/drafts") {
      return json(200, JSON.stringify(registry.listDrafts(auth)));
    }

    m = /^\/v1\/drafts\/([^/]+)\/revisions$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      return mutationResponse(registry.reviseDraft(auth, m[1], body, idemKey(body)), 201);
    }

    m = /^\/v1\/drafts\/([^/]+)\/revisions\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      return json(200, JSON.stringify(registry.getDraft(auth, m[1], m[2])));
    }

    m = /^\/v1\/drafts\/([^/]+)\/audit$/.exec(path);
    if (method === "GET" && m) {
      return json(200, JSON.stringify(registry.draftAudit(auth, m[1])));
    }

    m = /^\/v1\/drafts\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      return json(200, JSON.stringify(registry.getDraft(auth, m[1])));
    }

    // ---- §5.5: deployment assignments. The activation ROOT is never taken
    //      from a request: it is deployment configuration, and a route that
    //      accepted a path from a caller would be a route that let a caller
    //      choose which runtime this registry writes into.

    if (method === "GET" && path === "/v1/assignments") {
      return json(200, JSON.stringify(registry.listAssignments(auth)));
    }

    m = /^\/v1\/assignments\/([^/]+)\/activate$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      return mutationResponse(registry.activateAssignment(auth, m[1], idemKey(body)), 200);
    }

    m = /^\/v1\/assignments\/([^/]+)\/pause$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      return mutationResponse(registry.pauseAssignment(auth, m[1], idemKey(body)), 200);
    }

    m = /^\/v1\/assignments\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      return mutationResponse(registry.revokeAssignment(auth, m[1], idemKey(body)), 200);
    }

    // ---- §6 part A: the fleet inventory and the arrival scanner. The
    //      inventory ROOT is never taken from a request either, for the same
    //      reason: which directories this registry reads is configuration.

    if (method === "GET" && path === "/v1/fleet") {
      return json(200, JSON.stringify(registry.fleetList(auth)));
    }

    m = /^\/v1\/fleet\/([^/]+)\/capabilities$/.exec(path);
    if (method === "GET" && m) {
      return json(200, JSON.stringify(registry.agentCapabilities(auth, decodeURIComponent(m[1]))));
    }

    m = /^\/v1\/fleet\/([^/]+)\/capabilities\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      return json(
        200,
        JSON.stringify(registry.capabilityGet(auth, decodeURIComponent(m[1]), decodeURIComponent(m[2]))),
      );
    }

    // A WRITE, although the requirements list this surface among the reading
    // ones. A self-report is an agent telling this registry something, and
    // telling is storing: see `Registry.reportObservation`.
    if (method === "POST" && path === "/v1/observations") {
      const body = parseBody(req);
      return mutationResponse(registry.reportObservation(auth, body, idemKey(body)), 201);
    }

    m = /^\/v1\/versions\/([^/]+)\/ratings$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      const out = registry.rate(auth, m[1], body, idemKey(body));
      return mutationResponse(out, 201);
    }

    m = /^\/v1\/receipts\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      return json(200, JSON.stringify(registry.readReceipt(auth, m[1])));
    }

    // ---- provisioning (Appendix H auxiliaries): principals, their API keys,
    //      and the signing keys §4.4 step 3 resolves a package's kid against

    if (method === "POST" && path === "/v1/principals") {
      return json(201, JSON.stringify(registry.createPrincipal(auth, parseBody(req))));
    }

    if (method === "GET" && path === "/v1/principals") {
      return json(200, JSON.stringify(registry.listPrincipals(auth)));
    }

    m = /^\/v1\/principals\/([^/]+)\/api-keys$/.exec(path);
    if (method === "POST" && m) {
      return json(201, JSON.stringify(registry.issueApiKey(auth, m[1])));
    }

    m = /^\/v1\/principals\/([^/]+)\/api-keys\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      return mutationResponse(registry.revokeApiKey(auth, m[1], m[2], idemKey(body)), 200);
    }

    if (method === "POST" && path === "/v1/signing-keys") {
      const body = parseBody(req);
      return mutationResponse(registry.registerSigningKey(auth, body, idemKey(body)), 201);
    }

    if (method === "GET" && path === "/v1/signing-keys") {
      return json(200, JSON.stringify(registry.listSigningKeys(auth)));
    }

    m = /^\/v1\/signing-keys\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && m) {
      const body = parseBody(req);
      return mutationResponse(registry.revokeSigningKey(auth, m[1], idemKey(body)), 200);
    }

    if (method === "POST" && path === "/v1/webhooks") {
      const body = parseBody(req);
      return json(201, JSON.stringify(registry.registerWebhook(auth, body)));
    }

    if (method === "GET" && path === "/v1/webhooks") {
      return json(200, JSON.stringify(registry.listWebhooks(auth)));
    }

    m = /^\/v1\/webhooks\/([^/]+)$/.exec(path);
    if (method === "DELETE" && m) {
      return json(200, JSON.stringify(registry.deleteWebhook(auth, m[1])));
    }

    if (method === "GET" && path === "/v1/tlog") {
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");
      return json(
        200,
        JSON.stringify(
          registry.readTlog(auth, {
            cursor: cursor === null ? undefined : cursor,
            limit: limit === null ? undefined : limit,
          }),
        ),
      );
    }

    if (method === "GET" && path === "/v1/skills") {
      return json(200, JSON.stringify(registry.search(auth, searchParamsOf(url))));
    }

    // The migration counter (Appendix H, `migration.count`): a read, with the
    // surface-5 filters and an optional selection window. The window bounds are
    // parsed by the same parser the MCP adapter uses, so a malformed one is
    // INVALID_SCHEMA on both.
    if (method === "GET" && path === "/v1/migrations") {
      const since = url.searchParams.get("since_ms");
      const until = url.searchParams.get("until_ms");
      return json(
        200,
        JSON.stringify(
          registry.migrationCounts(auth, {
            ...searchParamsOf(url),
            since_ms: since === null ? undefined : since,
            until_ms: until === null ? undefined : until,
          }),
        ),
      );
    }

    // ---- P6: the dashboard views (Appendix H, `dashboard.view`)

    if (method === "GET" && path === "/v1/dashboard") {
      return json(200, JSON.stringify({ views: DASHBOARD_VIEWS }));
    }

    m = /^\/v1\/dashboard\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      // the selector is parsed BEFORE the read, by the shared parser both
      // adapters use — an unrecognised value is INVALID_SCHEMA here exactly as
      // it is over MCP (P6 verdict 1, blocking #1)
      const format = parseDashboardFormat(url.searchParams.get("format"));
      const payload = registry.dashboard(auth, m[1], searchParamsOf(url));
      // JSON is the API; `format=html` renders the SAME payload — the view is
      // a rendering of API fields, never a second source of truth.
      if (format === "html") {
        return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: renderDashboard(payload) };
      }
      // the cells are objects in the payload and strings on the wire, and
      // `serializeDashboard` is where the provenance of each is checked [B-2]
      return json(200, JSON.stringify(serializeDashboard(payload)));
    }

    throw new ApiError("NOT_FOUND", `no route ${method} ${path}`);
  } catch (e) {
    // `asApiError` and not `isApiError`: a refusal of a string this registry
    // cannot carry is a statement about the REQUEST, and re-raising it here made
    // the listener below answer 500 INTERNAL for a request the published schema
    // accepts. One exit, one mapping, every route (`src/errors.ts`).
    const api = asApiError(e);
    if (api) return errorResponse(api, req.url);
    throw e;
  }
}

/**
 * Bind the router to a real HTTP listener (quickstart entry point), and RESOLVE
 * ONLY ONCE THE SOCKET IS BOUND.
 *
 * WHY THIS IS A PROMISE. `server.listen()` returns with the bind still pending
 * — for a host it is preceded by a name lookup, so the failure arrives an event
 * loop turn later as an `error` event. A caller that treated the return as
 * success went on to open a deployment and print its startup block for a
 * listener that did not exist: on `EADDRINUSE`, the ordinary case of a port
 * another instance already holds, the operator got the whole success banner
 * INCLUDING the two §9.1 one-time credentials, and then exit code 1. Bind
 * readiness is therefore the FIRST thing `serve` waits for and everything else
 * is downstream of it (src/server.ts).
 *
 * A failed bind rejects with the `listen` error and leaves no listener behind.
 * After the bind, this function's own `error` handler is removed: a later error
 * on the server has the same disposition it always had.
 *
 * `registry` is a THUNK, not a value, because the deployment behind the router
 * is opened AFTER the socket is bound. Nothing can call it in between — the
 * caller's setup from bind to registry is synchronous, so no request can be
 * dispatched in that window — and calling it early raises, which the request
 * path below answers as an internal error rather than as a surface refusal.
 */
export function startServer(registry: () => Registry, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        res.writeHead(413, JSON_HEADERS);
        res.end(errorBody(new ApiError("LIMIT_EXCEEDED", "request body too large").toEnvelope(), req.url));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      try {
        const out = handleRest(registry(), {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          // The forwarded set is a LIST, not the whole request. Everything the
          // router reads is here and nothing else is: the console needs the
          // cookie it authenticates with, the `Origin` and `Host` it compares,
          // and the CSRF header it echoes. A header the router does not read is a
          // header the router cannot be surprised by.
          headers: {
            authorization: req.headers.authorization,
            cookie: req.headers.cookie,
            origin: req.headers.origin as string | undefined,
            host: req.headers.host,
            [CSRF_HEADER]: req.headers[CSRF_HEADER] as string | undefined,
          },
          body: Buffer.concat(chunks),
        });
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      } catch {
        res.writeHead(500, JSON_HEADERS);
        res.end(errorBody({ error: { code: "INTERNAL", message: "internal error" } }, req.url));
      }
    });
  });
  return new Promise<Server>((resolve, reject) => {
    const failed = (e: Error): void => {
      server.close();
      reject(e);
    };
    server.once("error", failed);
    server.listen(port, host, () => {
      server.removeListener("error", failed);
      resolve(server);
    });
  });
}
