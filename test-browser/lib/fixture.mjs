// A REAL DEPLOYMENT, ON A REAL SOCKET, WITH DATA THE PRODUCT PUT THERE.
//
// EVERY SERVER THIS FILE STARTS IS A SERVER THIS FILE STARTED — `127.0.0.1`, an
// ephemeral port, closed in a `finally`. No third-party host is contacted by any
// browser gate: the only origin a page ever loads is the one below.
//
// AND THE DATA IS NOT A FIXTURE. `journey()` drives the shipped REST surface —
// bootstrap exchange, adoption request, adoption, receipt, outcome report,
// webhook registration — with the same credentials and the same routes an
// operator would use. A row seeded straight into SQLite would prove the renderer
// draws a row; it would not prove the path an operator takes reaches the page.
import { serve } from "../../src/server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

/** A data directory that dies with the run. */
export function tempDataDir() {
  return mkdtempSync(join(tmpdir(), "skln-browser-"));
}

/**
 * A deployment listening on an ephemeral loopback port.
 *
 * `workerIntervalMs: 0` keeps the delivery worker off the clock — a gate that
 * raced a background timer would be a gate whose result depends on how fast the
 * machine is. `inst.tick()` runs it by hand where a test wants one.
 */
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir ?? tempDataDir();
  const lines = [];
  const inst = await serve({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    workerIntervalMs: 0,
    log: (l) => lines.push(l),
    ...opts,
  });
  const addr = inst.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : inst.port;
  return {
    inst,
    lines,
    dataDir,
    base: `http://127.0.0.1:${port}`,
    close() {
      try {
        inst.close();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/** One call to the shipped REST surface. Returns the status and the parsed body
 *  rather than throwing, because several gates are ABOUT a refusal. */
export async function api(base, method, path, key, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length ? JSON.parse(text) : null, headers: res.headers };
}

/** A local endpoint that always refuses, so a delivery can fail for a real
 *  reason. Started here, on loopback, closed by the caller. */
export async function startRefusingEndpoint() {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"this endpoint refuses on purpose"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits: () => hits,
    close: () => server.close(),
  };
}

/**
 * THE JOURNEY. Everything the Proofline views draw, put there through the
 * product's own surfaces.
 *
 * Each step is optional in the sense that a failure is REPORTED rather than
 * swallowed: `steps` records what happened, so a gate that depends on a row can
 * say which call was supposed to create it. Nothing here writes to the database
 * directly and nothing here mints a cell.
 */
export async function journey(fx) {
  const steps = [];
  const record = (what, r) => {
    steps.push({ what, status: r.status, ok: r.status < 400 });
    return r;
  };

  const creds = fx.inst.credentials;
  if (!creds) throw new Error("first start issued no credentials — the journey has no owner");

  const exchanged = record(
    "exchange the bootstrap token for the owner key",
    await api(fx.base, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: creds.bootstrap_owner_token }),
  );
  const ownerKey = exchanged.body?.api_key;
  if (typeof ownerKey !== "string") throw new Error(`the bootstrap exchange did not yield an owner key: ${JSON.stringify(exchanged.body)}`);
  const ownerAgentId = exchanged.body.agent_id;
  const adopterKey = creds.demo_adopter_token;

  // The seeded skill, found the way an adopter finds one.
  const search = record("search the registry for the seeded skill", await api(fx.base, "GET", "/v1/skills?q=hello", ownerKey));
  const found = search.body?.items?.[0] ?? null;

  let requestId = null;
  let receiptId = null;
  if (found) {
    const req = record(
      "request adoption as the demo adopter",
      await api(fx.base, "POST", "/v1/adoptions/requests", adopterKey, {
        skill_version_id: found.skill_version_id,
        idempotency_key: "browser-journey-request-1",
      }),
    );
    requestId = req.body?.adoption_request_id ?? null;
    receiptId = req.body?.receipt_id ?? null;
  }

  let adopted = null;
  if (requestId) {
    adopted = record(
      "adopt the version, which hands the package over and writes a receipt",
      await api(fx.base, "POST", `/v1/adoptions/${requestId}/adopt`, adopterKey, {
        environment_descriptor: { runtime: "cli", os: "linux", arch: "x64" },
        idempotency_key: "browser-journey-adopt-1",
      }),
    );
  }

  // A webhook endpoint that will fail, registered through the product's own
  // route. Loopback is admitted only when the deployment says so, and the
  // deployment this harness starts does say so — every destination is a server
  // this harness started.
  let webhookId = null;
  if (fx.refusing) {
    const hook = record(
      "register a webhook endpoint through the shipped route",
      await api(fx.base, "POST", "/v1/webhooks", ownerKey, {
        url: fx.refusing.url,
        idempotency_key: "browser-journey-webhook-1",
      }),
    );
    webhookId = hook.body?.webhook_id ?? null;
  }

  return { ownerKey, ownerAgentId, adopterKey, found, requestId, receiptId, adopted, webhookId, steps };
}

/**
 * A SECOND console session, held by the test process, over which the exact
 * payload the server sends can be read.
 *
 * The provenance gate compares the DOM against THIS, not against a sentence
 * written into the test. A hand-written expectation would be a second opinion
 * about what the registry says, which is the thing `INV-01` exists to prevent —
 * and it would pass just as happily if the server and the browser were both
 * wrong in the same way.
 */
export async function consoleReader(base, apiKey) {
  const ticket = await mintTicket(base, apiKey);
  const res = await fetch(`${base}/v1/console/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ ticket }),
  });
  if (res.status !== 201) throw new Error(`the reader session was refused: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")];
  const cookie = setCookie.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
  return {
    cookie,
    async view(name, query = "") {
      const r = await fetch(`${base}/v1/console/dashboard/${encodeURIComponent(name)}${query}`, {
        headers: { cookie, accept: "application/json" },
      });
      const text = await r.text();
      return { status: r.status, body: text.length ? JSON.parse(text) : null };
    },
    async raw(path, method = "GET", body) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: {
          cookie,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json", origin: base }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, text, body: text.length ? JSON.parse(text) : null };
    },
  };
}

/** A console ticket, minted the way the operator's instructions say to mint one:
 *  over the machine surface, with an API key, on the server's side of the wire.
 *  The browser never sees the key — only the ticket, and only once. */
export async function mintTicket(base, apiKey) {
  const r = await api(base, "POST", "/v1/console/tickets", apiKey);
  if (r.status !== 201 || typeof r.body?.ticket !== "string") {
    throw new Error(`could not mint a console ticket: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.ticket;
}
