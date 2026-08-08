// The outbound HTTP transport — the only code in this repository that opens a
// connection to an address a user supplied.
//
// §5.2's delivery machine (queue, lease, backoff, sweeper, dead letters,
// endpoint health) was complete without it; what was missing was the push
// itself, so every registered webhook silently dead-lettered. This module is
// that push, and nothing else.
//
// Everything below exists because the destination is attacker-chosen. A
// registry that POSTs to whatever URL an adopter registers is a request
// forgery engine pointed at its own network: the classic targets are the cloud
// instance-metadata services (169.254.169.254, fd00:ec2::254), anything on
// loopback that trusts local callers, and RFC1918 neighbours. The rules:
//
//   * **https only.** `http://` is refused unless the deployment explicitly
//     opts into loopback for local development.
//   * **No redirects, ever.** node:http does not follow them; this module does
//     not add it. A 3xx is returned as the answer it is, and since it is not
//     2xx the delivery counts as failed. Following even one hop would mean
//     re-validating an address the endpoint chose AFTER passing the checks.
//   * **Every resolved address is checked, and the refusal is all-or-nothing.**
//     A name that resolves to one public and one private address is refused
//     outright: accepting the public one would leave a round-robin resolver
//     free to hand over the private one on any retry.
//   * **The connection goes to the address that was checked.** The vetted IP
//     is pinned into the request through a `lookup` that ignores its argument,
//     so the name is resolved exactly once. Without that, the gap between
//     "checked the DNS answer" and "opened the socket" is a DNS-rebinding
//     window, and every check above is decorative.
//   * **Hard deadlines** on connect and on the whole exchange, and a **cap on
//     the response body** — an endpoint must not be able to hold a worker slot
//     open or stream into it indefinitely.
//
// The webhook SECRET never reaches this module: `pushOnce` resolves it, signs
// the body with it and passes only the resulting hex signature. Nothing here
// can leak it into an error message, because nothing here has it.
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WebhookRequest, WebhookResponse, WebhookTransport } from "./webhooks.ts";
import { SIGNATURE_HEADER } from "./webhooks.ts";

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface HttpsTransportOptions {
  /** ms budget for the whole exchange, connect included */
  totalTimeoutMs?: number;
  /** ms budget for establishing the connection (and for socket inactivity) */
  connectTimeoutMs?: number;
  /** bytes of response body accepted before the delivery is failed */
  maxResponseBytes?: number;
  /**
   * Permit `http://` and loopback destinations. LOCAL DEVELOPMENT ONLY, and
   * off by default. Appendix D.1 lets an adopter REGISTER an
   * `http://localhost` endpoint, which is useful while writing a receiver;
   * delivering to one is a separate decision and the deployment has to make it.
   */
  allowLoopback?: boolean;
  /** name → addresses. Injectable so the address rules are testable offline. */
  resolve?: (hostname: string) => Promise<string[]>;
}

// --------------------------------------------------------- address classes

/** Non-null = the reason this address must not be connected to. */
export function blockedReason(address: string): string | null {
  const kind = isIP(address);
  if (kind === 4) return blockedIpv4(address);
  if (kind === 6) return blockedIpv6(address);
  return "not an IP address";
}

function blockedIpv4(address: string): string | null {
  const o = address.split(".").map((p) => Number(p));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "malformed IPv4 address";
  const [a, b] = o;
  if (a === 0) return "unspecified/this-network 0.0.0.0/8";
  if (a === 10) return "private 10.0.0.0/8";
  if (a === 127) return "loopback 127.0.0.0/8";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64.0.0/10";
  // 169.254.169.254 and 100.100.100.200 (both covered above/here) are the
  // cloud instance-metadata endpoints this whole module exists to refuse
  if (a === 169 && b === 254) return "link-local 169.254.0.0/16 (cloud instance metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16.0.0/12";
  if (a === 192 && b === 168) return "private 192.168.0.0/16";
  if (a === 192 && b === 0 && o[2] === 0) return "IETF protocol assignments 192.0.0.0/24";
  if (a === 192 && b === 0 && o[2] === 2) return "documentation 192.0.2.0/24";
  if (a === 192 && b === 88 && o[2] === 99) return "6to4 relay anycast 192.88.99.0/24";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking 198.18.0.0/15";
  if (a === 198 && b === 51 && o[2] === 100) return "documentation 198.51.100.0/24";
  if (a === 203 && b === 0 && o[2] === 113) return "documentation 203.0.113.0/24";
  if (a >= 224 && a <= 239) return "multicast 224.0.0.0/4";
  if (a >= 240) return "reserved 240.0.0.0/4 (incl. broadcast)";
  return null;
}

/** Parse an IPv6 literal (with optional embedded IPv4) into its 16 bytes. */
export function parseIpv6(address: string): Uint8Array | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone); // a scope id names an interface, never a different host
  const bytes = new Uint8Array(16);
  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0) return null;

  const expand = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const groups = part.split(":");
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      if (g.includes(".")) {
        if (i !== groups.length - 1) return null; // embedded IPv4 is last
        if (isIP(g) !== 4) return null;
        for (const octet of g.split(".")) out.push(Number(octet));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      const v = parseInt(g, 16);
      out.push(v >> 8, v & 0xff);
    }
    return out;
  };

  const left = expand(head);
  const right = tail === undefined ? [] : expand(tail);
  if (left === null || right === null) return null;
  if (tail === undefined) {
    if (left.length !== 16) return null;
    bytes.set(left);
    return bytes;
  }
  if (left.length + right.length > 15) return null; // `::` must cover ≥1 group
  bytes.set(left, 0);
  bytes.set(right, 16 - right.length);
  return bytes;
}

function blockedIpv6(address: string): string | null {
  const b = parseIpv6(address);
  if (!b) return "malformed IPv6 address";
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  const dotted = (from: number): string => `${b[from]}.${b[from + 1]}.${b[from + 2]}.${b[from + 3]}`;

  // IPv4-mapped ::ffff:a.b.c.d — the same host as the IPv4 address, so it is
  // judged as one. Without this, ::ffff:127.0.0.1 walks straight past the v6
  // rules below and reaches loopback.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    const reason = blockedIpv4(dotted(12));
    return reason === null ? null : `IPv4-mapped ${dotted(12)}: ${reason}`;
  }
  // NAT64 64:ff9b::/96 and 6to4 2002::/16 both carry an IPv4 destination
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    const reason = blockedIpv4(dotted(12));
    return reason === null ? null : `NAT64-embedded ${dotted(12)}: ${reason}`;
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    const reason = blockedIpv4(dotted(2));
    return reason === null ? null : `6to4-embedded ${dotted(2)}: ${reason}`;
  }

  if (zero(0, 15) && b[15] === 0) return "unspecified ::";
  if (zero(0, 15) && b[15] === 1) return "loopback ::1";
  if ((b[0] & 0xfe) === 0xfc) return "unique local fc00::/7 (incl. cloud metadata fd00:ec2::254)";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local fe80::/10";
  if (b[0] === 0xff) return "multicast ff00::/8";
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return "discard-only 100::/64";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation 2001:db8::/32";
  return null;
}

/** Loopback is the one blocked class a deployment may opt back into. */
export function isLoopback(address: string): boolean {
  if (isIP(address) === 4) return address.split(".")[0] === "127";
  const b = parseIpv6(address);
  if (!b) return false;
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b[12] === 127;
  return false;
}

// ------------------------------------------------------- the URL rules

export class WebhookRefused extends Error {}

/** §5.2 registration rule: an endpoint URL longer than this is INVALID_SCHEMA.
 *  It is an API rule, not a D.1 constraint — `webhooks.url` carries only the
 *  scheme CHECK — so the refusal has to be a message from here. */
export const MAX_ENDPOINT_URL_LENGTH = 2000;

/**
 * The bare host of a URL — `[::1]` unwrapped, so an IPv6 literal can be judged
 * by the same functions as an IPv4 one.
 */
export function endpointHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** A host that names this machine and no other. Literals, plus `localhost`. */
export function isLoopbackHost(hostname: string): boolean {
  if (isIP(hostname)) return isLoopback(hostname);
  return hostname.toLowerCase() === "localhost";
}

export interface UrlPolicy {
  /** whether `http://` is admissible at all */
  allowHttp: boolean;
  /** …and, if so, only to a host that is literally this machine */
  requireLoopbackHost?: boolean;
  /**
   * Judge an IP LITERAL host against `blockedReason` here and now. The
   * transport leaves this off because it checks EVERY resolved address a few
   * lines later, all-or-nothing, and owns that message; a caller with no
   * resolver (registration) turns it on, because for a literal there is nothing
   * left to resolve.
   */
  refuseBlockedLiteral?: boolean;
}

/**
 * Everything that can be decided about an endpoint URL WITHOUT resolving a
 * name: that it parses, that it carries no credentials, and that its scheme is
 * permitted. This is the half the registration surface and the delivery
 * transport must agree on, so it lives once and both call it.
 *
 * It exists because the registration check used to be a prefix regex —
 * `/^(https:\/\/|http:\/\/localhost|http:\/\/127\.0\.0\.1)/` — and a prefix is
 * not a URL. Two strings walked straight through it:
 *
 *   * `https://evil.com@internal.host/` — everything before the `@` is
 *     USERINFO, so this addresses `internal.host`. The regex read the
 *     `https://evil.com` prefix and saw a public host.
 *   * `http://localhost.attacker.com/` — an attacker-controlled name that
 *     merely STARTS with `localhost`. The regex was checking a prefix of the
 *     string, not the host of the URL.
 *
 * Neither was exploitable, because the transport (below) refuses both when it
 * comes to deliver. That is exactly the problem worth fixing: a registration
 * check that accepts what delivery will refuse teaches an operator that the
 * registry filtered something, and the filter would be the only thing standing
 * there if the transport were ever replaced.
 *
 * What this deliberately does NOT do is resolve the host. Registration happens
 * once and delivery happens later; a name checked here could answer differently
 * there, so a "pass" would be a promise this code cannot keep. The addresses
 * are judged where the socket is opened, all of them, every time (see `vet`).
 * An IP LITERAL is different — it cannot change — so it is judged here too,
 * with the same `blockedReason` table the transport uses.
 */
export function vetEndpointUrl(rawUrl: unknown, policy: UrlPolicy): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new WebhookRefused("refused: endpoint URL must be a non-empty string");
  }
  if (rawUrl.length > MAX_ENDPOINT_URL_LENGTH) {
    throw new WebhookRefused(`refused: endpoint URL exceeds ${MAX_ENDPOINT_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookRefused("refused: endpoint URL is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebhookRefused("refused: endpoint URL carries credentials");
  }
  const host = endpointHost(url);
  if (host === "") throw new WebhookRefused("refused: endpoint URL has no host");

  if (url.protocol !== "https:") {
    if (!(policy.allowHttp && url.protocol === "http:")) {
      throw new WebhookRefused(`refused: ${url.protocol}// endpoints are not delivered to; https is required`);
    }
    if (policy.requireLoopbackHost === true && !isLoopbackHost(host)) {
      throw new WebhookRefused(
        `refused: http:// is permitted only to this machine (localhost, 127.0.0.0/8, ::1) — ${host} is not one`,
      );
    }
  }

  // A literal address is final: no resolver stands between this string and the
  // socket, so the transport's own table can decide it now.
  if (policy.refuseBlockedLiteral === true && isIP(host)) {
    const reason = blockedReason(host);
    if (reason !== null && !isLoopbackHost(host)) {
      throw new WebhookRefused(`refused: ${host} is a forbidden address (${reason})`);
    }
  }
  return url;
}

// ------------------------------------------------------------- the transport

export class HttpsWebhookTransport implements WebhookTransport {
  private readonly totalTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly allowLoopback: boolean;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;

  constructor(opts: HttpsTransportOptions = {}) {
    this.totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.allowLoopback = opts.allowLoopback ?? false;
    this.resolveHost =
      opts.resolve ??
      (async (hostname: string) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address));
  }

  async send(req: WebhookRequest): Promise<WebhookResponse> {
    try {
      const { url, address } = await this.vet(req.url);
      return await this.exchange(url, address, req);
    } catch (e) {
      if (e instanceof WebhookRefused) return { status: 0, error: e.message };
      // a resolver failure, a TLS failure, anything unforeseen: a delivery
      // failure with a message, never a thrown exception into the worker loop
      return { status: 0, error: `delivery failed: ${short(e)}` };
    }
  }

  /** Scheme, credentials and EVERY resolved address, decided before a socket exists. */
  private async vet(rawUrl: string): Promise<{ url: URL; address: string }> {
    // The scheme/credential half is `vetEndpointUrl`, shared verbatim with the
    // registration surface so the two cannot drift apart. The address half
    // below is this transport's alone, because only it has a resolver.
    const url = vetEndpointUrl(rawUrl, { allowHttp: this.allowLoopback });

    const hostname = endpointHost(url);
    const addresses = isIP(hostname) ? [hostname] : await this.resolveAddresses(hostname);
    if (addresses.length === 0) throw new WebhookRefused("refused: endpoint hostname resolved to no address");

    // All-or-nothing: one bad address poisons the name, because a resolver is
    // free to answer with any of them on the next attempt.
    for (const address of addresses) {
      const reason = blockedReason(address);
      if (reason === null) continue;
      if (this.allowLoopback && isLoopback(address)) continue;
      throw new WebhookRefused(`refused: ${hostname} resolves to a forbidden address (${reason})`);
    }
    return { url, address: addresses[0] };
  }

  private async resolveAddresses(hostname: string): Promise<string[]> {
    try {
      return await this.resolveHost(hostname);
    } catch (e) {
      throw new WebhookRefused(`refused: cannot resolve endpoint hostname (${short(e)})`);
    }
  }

  private exchange(url: URL, address: string, req: WebhookRequest): Promise<WebhookResponse> {
    const body = Buffer.from(req.body, "utf8");
    const isHttps = url.protocol === "https:";
    const options: RequestOptions = {
      method: "POST",
      // The pinned address, NOT the hostname: this is the anti-rebinding step.
      // `lookup` ignores what it is asked and hands back the address that was
      // vetted, so the socket cannot reach a host the checks never saw.
      host: url.hostname,
      port: url.port === "" ? (isHttps ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        "content-type": "application/json",
        "content-length": String(body.length),
        "user-agent": "skillonomia-webhook/1",
        [SIGNATURE_HEADER]: req.signature,
      },
      timeout: this.connectTimeoutMs,
      lookup: (_hostname, opts, cb) => {
        const family = isIP(address);
        if (typeof opts === "function") return (opts as any)(null, address, family);
        if ((opts as any)?.all) return cb(null, [{ address, family }] as any);
        return cb(null, address as any, family);
      },
      // SNI and certificate validation stay on the NAME, which is what the
      // certificate is issued for; only the address is pinned.
      ...(isHttps ? { servername: url.hostname } : {}),
    } as RequestOptions;

    return new Promise<WebhookResponse>((resolve) => {
      let settled = false;
      const finish = (res: WebhookResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        request.destroy();
        resolve(res);
      };

      const deadline = setTimeout(
        () => finish({ status: 0, error: `delivery timed out after ${this.totalTimeoutMs} ms` }),
        this.totalTimeoutMs,
      );
      deadline.unref?.();

      const request = (isHttps ? httpsRequest : httpRequest)(options, (response) => {
        const status = response.statusCode ?? 0;
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.maxResponseBytes) {
            // An endpoint that streams into the registry is not answering it.
            finish({ status: 0, error: `endpoint response exceeded ${this.maxResponseBytes} bytes` });
          }
        });
        // Redirects are NOT followed: a 3xx is reported as itself, and the
        // §5.2 health rules count it as a failure because it is not 2xx.
        response.on("end", () => finish({ status, error: ok(status) ? undefined : `status ${status}` }));
        response.on("error", (e) => finish({ status: 0, error: `response failed: ${short(e)}` }));
      });

      request.on("timeout", () => finish({ status: 0, error: `connection timed out after ${this.connectTimeoutMs} ms` }));
      request.on("error", (e) => finish({ status: 0, error: `delivery failed: ${short(e)}` }));
      request.end(body);
    });
  }
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/** One short line. Never the body, never the signature, never a stack. */
function short(e: unknown): string {
  const message = String((e as Error)?.message ?? e);
  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}

/** The transport a deployment gets unless it supplies its own (src/server.ts). */
export function defaultTransport(env: NodeJS.ProcessEnv = process.env): WebhookTransport {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return new HttpsWebhookTransport({
    totalTimeoutMs: number("SKILLONOMIA_WEBHOOK_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS),
    connectTimeoutMs: number("SKILLONOMIA_WEBHOOK_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
    maxResponseBytes: number("SKILLONOMIA_WEBHOOK_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES),
    allowLoopback: env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK === "1",
  });
}
