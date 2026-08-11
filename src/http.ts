// REST adapter — Appendix H routes mirrored 1:1 onto the service layer, plus
// the /mcp mount of the MCP adapter. No business logic here (§2): parse,
// authenticate, dispatch, serialize. The error envelope and status mapping
// come from src/errors.ts; idempotent replays write the STORED response bytes
// with `Idempotency-Replayed: true` (Appendix H).
import { createServer, type Server } from "node:http";
import type { Registry, SearchParams } from "./service.ts";
import { SEARCH_FILTERS } from "./service.ts";
import { ApiError, isApiError } from "./errors.ts";
import { handleMcpMessage, type JsonRpcRequest } from "./mcp.ts";
import { DASHBOARD_VIEWS, renderDashboard, serializeDashboard, parseDashboardFormat } from "./dashboard.ts";
import { VERSION } from "./version.ts";

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

function errorResponse(e: ApiError): RestResponse {
  return json(e.httpStatus, JSON.stringify(e.toEnvelope()));
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

    // -- everything else: Bearer auth + per-key rate limit
    const auth = registry.authenticate(req.headers["authorization"]);

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

    let m = /^\/v1\/skills\/([^/]+)\/versions$/.exec(path);
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
    if (isApiError(e)) return errorResponse(e);
    throw e;
  }
}

/** Bind the router to a real HTTP listener (quickstart entry point). */
export function startServer(registry: Registry, port: number, host = "127.0.0.1"): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        res.writeHead(413, JSON_HEADERS);
        res.end(JSON.stringify(new ApiError("LIMIT_EXCEEDED", "request body too large").toEnvelope()));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      try {
        const out = handleRest(registry, {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: { authorization: req.headers.authorization },
          body: Buffer.concat(chunks),
        });
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      } catch {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ error: { code: "INTERNAL", message: "internal error" } }));
      }
    });
  });
  server.listen(port, host);
  return server;
}
