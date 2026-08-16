// THE OWNER CONSOLE'S BROWSER SESSION — `INV-04`, `P2-FR-01`, `P2-FR-02`,
// `P2-FR-03`, `P2-FR-13`, `P2-FR-14`.
//
// WHAT THE BROWSER EVER HOLDS, IN FULL:
//
//   1. an opaque random session value, in an `HttpOnly` cookie script cannot
//      read;
//   2. a CSRF token, in the page's memory, delivered in a response BODY.
//
// Neither is a Registry API key and neither is derived from one. The Registry
// key stays where `src/auth.ts` put it — on the server, in `api_keys`, as a
// hash — and no route below returns one, embeds one or accepts one from a
// browser. That is the whole content of `INV-04`, and the reason the login runs
// backwards from the usual shape: the owner does not type a credential into a
// page. A machine-to-machine call the owner makes with the CLI mints a one-time
// TICKET, and the browser trades the ticket for the session.
//
// WHY THE TICKET IS NOT IN A URL. `INV-04` names the URL as one of the places a
// credential may not be. A login link would put the one credential that opens a
// session into the address bar, the history, the referrer and every log between
// here and there. The ticket travels in a POST body, is single-use in the
// SCHEMA (`console_ticket_uses.ticket_id` is UNIQUE), and expires in five
// minutes.
//
// WHAT IS NOT PROMISED. A session is bound to no fingerprint: not to an IP, not
// to a user agent, not to a TLS channel. Somebody who can read the cookie can
// use the cookie. The mitigations are that it is `HttpOnly` (so a script cannot
// read it), `SameSite=Strict` (so another site cannot cause it to be sent),
// `Secure` outside localhost (so the network cannot read it) and short-lived
// (so a stolen one dies within the hour). Channel binding is not in the V1
// threat model (contract section 6.2) and is not claimed here.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./sqlite.ts";
import type { AuthContext, Role } from "./auth.ts";
import { sha256Hex } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";

/** The cookie name. One name, in one place, used by the server and asserted by
 *  the browser test — a second literal would be a second answer. */
export const CONSOLE_COOKIE = "skln_console";

/** `INV-04`: absolute session lifetime, 60 minutes at most. The schema enforces
 *  the same bound with a CHECK, so a caller reaching past this constant is
 *  refused by the database rather than trusted. */
export const MAX_SESSION_MS = 60 * 60 * 1000;

/** The default when a deployment configures nothing. Shorter than the cap on
 *  purpose: the cap is a limit, not a recommendation. */
export const DEFAULT_SESSION_MS = 30 * 60 * 1000;

/** A login ticket is a means of starting a session, not a session. Five
 *  minutes is long enough to paste and short enough that a ticket found in a
 *  terminal an hour later is worth nothing. */
export const TICKET_TTL_MS = 5 * 60 * 1000;

/** The two roles that may open a console. V1 is one owner and a closed fleet
 *  (contract section 3); `admin` is admitted because the existing workspace
 *  model already treats the two as the human roles, and `reviewer`/`member` are
 *  not console principals. */
const CONSOLE_ROLES = new Set<Role>(["owner", "admin"]);

export interface ConsoleSession {
  session_id: string;
  agent_id: string;
  workspace_id: string;
  actor_role: "owner" | "admin";
  created_at_ms: number;
  expires_at_ms: number;
  /** the anti-forgery nonce this session's page echoes on every mutation. It
   *  authenticates nothing on its own: without the cookie it opens nothing. */
  csrf_token: string;
}

export interface OpenedSession extends ConsoleSession {
  /** the opaque value the cookie carries; returned once, stored nowhere */
  cookie_value: string;
}

export interface MintedTicket {
  ticket: string;
  ticket_id: string;
  expires_at_ms: number;
}

function digestOf(secret: string): string {
  return `sha256:${sha256Hex(secret)}`;
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function requireConsoleRole(role: Role | null): "owner" | "admin" {
  if (role === null || !CONSOLE_ROLES.has(role)) {
    throw new ApiError("FORBIDDEN", "the owner console is an owner or admin surface");
  }
  return role as "owner" | "admin";
}

/**
 * `POST /v1/console/tickets` — the machine-to-machine half of the login.
 *
 * Authenticated by the Registry API key, over the channel that already carries
 * one. What comes back is a ticket, which is not a key: it opens one session,
 * once, within five minutes, and confers nothing else.
 */
export function mintConsoleTicket(db: Db, auth: AuthContext, nowMs: number): MintedTicket {
  const role = requireConsoleRole(auth.role);
  const ticket = opaque("ct");
  const id = ulid(nowMs);
  db.prepare(
    `INSERT INTO console_tickets(id, workspace_id, agent_id, actor_role, ticket_hash, created_at_ms, expires_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, auth.workspace_id, auth.agent_id, role, digestOf(ticket), nowMs, nowMs + TICKET_TTL_MS);
  return { ticket, ticket_id: id, expires_at_ms: nowMs + TICKET_TTL_MS };
}

interface TicketRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  actor_role: "owner" | "admin";
  expires_at_ms: number;
}

/**
 * `POST /v1/console/session` — the browser half.
 *
 * The ticket is looked up BY ITS HASH, so a database that leaks leaks no usable
 * ticket. Consumption and session creation are one transaction: there is no
 * state in which a ticket is spent and no session exists, and the UNIQUE on
 * `console_ticket_uses.ticket_id` is what makes a second use collide rather than
 * succeed.
 *
 * `ttlMs` is a deployment's choice within the cap. A value past the cap is not
 * clamped silently — it is refused, because a deployment that asked for two
 * hours and got one without being told has been given a session it does not
 * believe in.
 */
export function openConsoleSession(db: Db, ticket: unknown, nowMs: number, ttlMs: number = DEFAULT_SESSION_MS): OpenedSession {
  if (typeof ticket !== "string" || ticket.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "ticket must be a non-empty string");
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_SESSION_MS) {
    throw new ApiError("INVALID_SCHEMA", `session lifetime must be between 1 and ${MAX_SESSION_MS} ms`);
  }
  const hash = digestOf(ticket);
  const row = db
    .prepare(
      `SELECT t.id, t.workspace_id, t.agent_id, t.actor_role, t.expires_at_ms
         FROM console_tickets t
        WHERE t.ticket_hash=?`,
    )
    .get(hash) as TicketRow | undefined;
  // A ticket that is unknown, spent or expired is ONE answer. A caller cannot
  // tell which, and does not need to: every one of them means "open no session".
  //
  // The lookup is an equality over the DIGEST, not over the secret, so there is
  // no constant-time comparison here and none is owed: what the index compares
  // is a hash of the candidate, and the timing of that comparison says nothing
  // about the secret that produced it.
  if (!row) throw new ApiError("UNAUTHORIZED", "invalid or expired console ticket");
  if (nowMs >= row.expires_at_ms) throw new ApiError("UNAUTHORIZED", "invalid or expired console ticket");

  const cookieValue = opaque("cs");
  const csrfToken = opaque("cx");
  const sessionId = ulid(nowMs);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO owner_sessions(id, workspace_id, agent_id, actor_role, token_hash, csrf_token, created_at_ms, absolute_expires_at_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      sessionId,
      row.workspace_id,
      row.agent_id,
      row.actor_role,
      digestOf(cookieValue),
      csrfToken,
      nowMs,
      nowMs + ttlMs,
    );
    // the UNIQUE here is the single-use rule; a replay of a spent ticket fails
    // this INSERT and the whole transaction unwinds
    db.prepare("INSERT INTO console_ticket_uses(id, ticket_id, session_id, used_at_ms) VALUES (?,?,?,?)").run(
      ulid(nowMs),
      row.id,
      sessionId,
      nowMs,
    );
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    // a spent ticket lands here, and says exactly what an unknown one says
    throw new ApiError("UNAUTHORIZED", "invalid or expired console ticket");
  }
  return {
    session_id: sessionId,
    agent_id: row.agent_id,
    workspace_id: row.workspace_id,
    actor_role: row.actor_role,
    created_at_ms: nowMs,
    expires_at_ms: nowMs + ttlMs,
    csrf_token: csrfToken,
    cookie_value: cookieValue,
  };
}

interface SessionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  actor_role: "owner" | "admin";
  csrf_token: string;
  created_at_ms: number;
  absolute_expires_at_ms: number;
  revoked: number;
}

/**
 * The cookie value → a live session, or null.
 *
 * THREE facts decide it and all three are read here: the row exists, the
 * absolute expiry has not passed, and no revocation names it. Expiry is
 * therefore server-side even though the cookie also carries a `Max-Age`: a
 * browser that ignores the `Max-Age`, or a client that is not a browser at all,
 * gets the same answer.
 */
export function resolveConsoleSession(db: Db, cookieValue: string | undefined, nowMs: number): ConsoleSession | null {
  if (typeof cookieValue !== "string" || cookieValue.length === 0) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.workspace_id, s.agent_id, s.actor_role, s.csrf_token, s.created_at_ms, s.absolute_expires_at_ms,
              (SELECT COUNT(*) FROM owner_session_revocations r WHERE r.session_id=s.id) AS revoked
         FROM owner_sessions s
        WHERE s.token_hash=?`,
    )
    .get(digestOf(cookieValue)) as SessionRow | undefined;
  if (!row) return null;
  if (row.revoked > 0) return null;
  if (nowMs >= row.absolute_expires_at_ms) return null;
  return {
    session_id: row.id,
    agent_id: row.agent_id,
    workspace_id: row.workspace_id,
    actor_role: row.actor_role,
    created_at_ms: row.created_at_ms,
    expires_at_ms: row.absolute_expires_at_ms,
    csrf_token: row.csrf_token,
  };
}

/** Logout. An INSERT, so the logout is itself a record; a second logout of the
 *  same session is a no-op rather than an error, because a browser that sends
 *  the request twice has not done anything wrong. */
export function revokeConsoleSession(db: Db, sessionId: string, nowMs: number, reasonCode: "logout" | "superseded" = "logout"): void {
  try {
    db.prepare("INSERT INTO owner_session_revocations(id, session_id, reason_code, revoked_at_ms) VALUES (?,?,?,?)").run(
      ulid(nowMs),
      sessionId,
      reasonCode,
      nowMs,
    );
  } catch {
    /* already revoked: the UNIQUE refused a second row, which is the outcome asked for */
  }
}

/** The session, as the `AuthContext` every existing service method already
 *  takes. The console reaches the SAME service layer the API key reaches —
 *  `INV-01`, and the reason there is no second permission model here. */
export function authContextOf(session: ConsoleSession, toolProfile: string | null = null): AuthContext {
  return {
    agent_id: session.agent_id,
    workspace_id: session.workspace_id,
    role: session.actor_role,
    tool_profile: toolProfile,
    // the rate-limit bucket key. Prefixed like `src/seed.ts`'s `internal:` so it
    // can never collide with an `api_keys.id`, because it is not one
    api_key_id: `console:${session.session_id}`,
  };
}

/** `P2-FR-13`, the CSRF half: the token the page holds, compared against the one
 *  the session carries. A mutation with no header, or with the wrong one, is
 *  refused before it reaches a service method.
 *
 *  The comparison is over the SHA-256 of both sides so that it is constant-time
 *  regardless of the lengths involved — `timingSafeEqual` requires equal-length
 *  buffers, and two digests always are. */
export function checkCsrf(session: ConsoleSession, headerToken: string | undefined): void {
  if (typeof headerToken !== "string" || headerToken.length === 0) {
    throw new ApiError("FORBIDDEN", "missing CSRF token");
  }
  const got = Buffer.from(sha256Hex(headerToken), "hex");
  const want = Buffer.from(sha256Hex(session.csrf_token), "hex");
  if (!timingSafeEqual(got, want)) {
    throw new ApiError("FORBIDDEN", "invalid CSRF token");
  }
}

// --------------------------------------------------------------- the cookie

/** `Cookie:` → a map. Values are not decoded: the session value is base64url
 *  and the comparison is over the raw bytes the browser sent. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0 || Object.hasOwn(out, name)) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The `Set-Cookie` of a new session. Every attribute `INV-04` names is here and
 * each one is asserted by the browser gate rather than described:
 *
 *   `HttpOnly`      — script cannot read it, so it cannot be copied into
 *                     `localStorage` by anything running in the page;
 *   `SameSite=Strict` — another site cannot cause it to be sent, which is the
 *                     first of the two CSRF defences;
 *   `Secure`        — outside localhost. On `http://127.0.0.1` a `Secure`
 *                     cookie is discarded by the browser and the console could
 *                     not be developed or tested at all, which is why the flag
 *                     follows the deployment rather than being unconditional;
 *   `Path=/`        — the protected API and the protected page are one origin;
 *   `Max-Age`       — the browser's copy of the absolute lifetime. The server's
 *                     copy is the row, and the row is what decides.
 */
export function sessionCookie(value: string, maxAgeMs: number, secure: boolean): string {
  const attrs = [
    `${CONSOLE_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** The `Set-Cookie` of a logout: the same attributes, an empty value and an
 *  immediate expiry. The server-side revocation is what actually ends the
 *  session; this only stops the browser from sending a value that no longer
 *  works. */
export function clearedCookie(secure: boolean): string {
  const attrs = [`${CONSOLE_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * `P2-FR-13`, the Origin half. A mutation must come from this origin.
 *
 * The rule is deliberately strict and deliberately narrow: a mutating request
 * carrying an `Origin` that is not the request's own origin is refused, and a
 * mutating request carrying NO `Origin` is refused too. The second half matters
 * — every browser sends `Origin` on a cross-site POST, so an absent one is
 * either a non-browser client (which should be using the API key) or a browser
 * old enough that the header cannot be relied on. Refusing costs a console user
 * nothing and removes the case where absence reads as permission.
 */
export function checkOrigin(origin: string | undefined, host: string | undefined): void {
  if (typeof host !== "string" || host.length === 0) {
    throw new ApiError("FORBIDDEN", "cross-origin check requires a Host header");
  }
  if (typeof origin !== "string" || origin.length === 0) {
    throw new ApiError("FORBIDDEN", "a mutating console request must carry an Origin header");
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ApiError("FORBIDDEN", "Origin is not a URL");
  }
  if (parsed.host !== host) {
    throw new ApiError("FORBIDDEN", "Origin does not match this origin");
  }
}
