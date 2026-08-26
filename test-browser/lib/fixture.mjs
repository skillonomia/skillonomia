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
  // THE LOOPBACK FLAG IS A PROPERTY OF THE PROCESS, NOT OF A CALL. `serve()`
  // builds this deployment's transport from `process.env` at startup, so a
  // deployment that must accept a `http://127.0.0.1` endpoint has to be started
  // with the flag set — and only for as long as that takes. Restoring it
  // immediately keeps the DEFAULT of every other gate in this run "loopback is
  // refused", which is the shipped default and the one worth regressing against.
  const restore = process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK;
  if (opts.allowLoopback) process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK = "1";
  let inst;
  try {
    inst = await serve({
      port: 0,
      host: "127.0.0.1",
      dataDir,
      workerIntervalMs: 0,
      log: (l) => lines.push(l),
      ...opts,
    });
  } finally {
    if (opts.allowLoopback) {
      if (restore === undefined) delete process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK;
      else process.env.SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK = restore;
    }
  }
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

// ===========================================================================
// THE DECISION JOURNEYS — what the Approval Inbox, the revocation flow and the
// webhook flow need, put there the way an author and an owner actually put it
// there.
//
// NOT FIXTURES. `authorSkill` runs the shipped authoring CLI's own `init` and
// `create` against this deployment, so the version an inbox item is about is a
// version the registry packed and signed from a source tree; `releaseVersion`
// walks review → adopt → outcome → verify → publish over the REST surface an
// operator uses. A row written straight into SQLite would prove the renderer
// draws a row and would prove nothing about the journey — which is the standard
// the P2 gate manifest sets for this phase.
// ===========================================================================

import { mkdtempSync as mkdtemp, readFileSync, writeFileSync } from "node:fs";
import { runInit, runCreate } from "../../src/cli-authoring.ts";

/** An `io` that keeps what the CLI said, so a failure names the step. */
function collectingIo() {
  const out = [];
  const err = [];
  return { out: (l) => out.push(l), err: (l) => err.push(l), lines: out, errors: err };
}

/**
 * One skill, authored and published to this deployment BY THE SHIPPED CLI.
 *
 * `risk` selects the template, and it selects a product behaviour with it: a
 * `high` skill declares the two approvals SPEC.md section 7.3 gates it on, so
 * the Approval Inbox has something to hold. The API key is read from an
 * environment map handed to `runCreate`, never from `process.env` and never
 * from argv — the same rule the CLI itself is held to.
 */
export async function authorSkill(fx, { slug, risk, apiKey, edit = null }) {
  const dir = mkdtemp(join(tmpdir(), "skln-src-"));
  const io = collectingIo();
  const initCode = runInit({ slug, risk, directory: dir, force: false }, io, { nowMs: Date.now() });
  if (initCode !== 0) throw new Error(`init failed for ${slug}: ${io.errors.join(" | ")}`);

  // THE AUTHOR'S OWN EDIT, and every source tree gets one — a template is a
  // starting point and `skillonomia init` says so in its own next-steps output.
  // A `high` tree needs one specific edit before the registry will take it: the
  // §7.1 schema gate refuses `risk_level: high` unless
  // `safety.sandbox_requirement` is `required`, and the generated template
  // writes `none` for every risk. Making the edit here is what an author does;
  // it is written down rather than hidden because the shipped template not
  // making it is a fact about the template, not about this fixture.
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (risk === "high") manifest.safety.sandbox_requirement = "required";
  if (edit) edit(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const createCode = await runCreate(
    { slug, directory: dir, server: fx.base, api_key_env: "SKLN_TEST_KEY" },
    io,
    { nowMs: Date.now(), env: { SKLN_TEST_KEY: apiKey } },
  );
  if (createCode !== 0) throw new Error(`create failed for ${slug}: ${io.errors.join(" | ")}`);
  const found = await api(fx.base, "GET", `/v1/skills?q=${encodeURIComponent(slug)}`, apiKey);
  const item = (found.body?.items ?? []).find((i) => i.slug === slug);
  if (!item) throw new Error(`the registry does not list ${slug} after create: ${JSON.stringify(found.body)}`);
  return { slug, risk, dir, sourceDir: dir, skill_id: item.skill_id, skill_version_id: item.skill_version_id, io };
}

/** The environment an adopter declares. Every member the shipped schema
 *  requires, and no member it does not. */
export const ENVIRONMENT_DESCRIPTOR = {
  runtime: { id: "cli", version: "1.0.0" },
  model: { id: "test-model", version: "1" },
  // `shell` is what the authoring template declares in `tool_compat`; an
  // adopter that declared none would report a compatibility mismatch, which is
  // a true statement about a mismatched environment and not the journey under
  // test.
  tools: [{ id: "shell", version: "1.0.0" }],
  os: "linux",
  shell: "bash",
  sandbox_capable: true,
};

/** The evidence a passing trial adoption reports: every declared gate, passed,
 *  read out of the version's own signed manifest rather than guessed. */
export function evidenceFor(manifest) {
  return {
    gate_results: (manifest?.procedure?.validation_gates ?? []).map((g) => ({
      gate_id: g.gate_id,
      pass: true,
      observed: "skillonomia-smoke-ok",
    })),
  };
}

/**
 * reviewed → verified → published, over REST, with a real trial adoption in
 * the middle because SPEC.md section 5.1 requires one before a version verifies.
 *
 * `stopBefore` lets a caller take the walk only as far as it needs: the
 * Approval Inbox wants a HIGH-risk version sitting at `verified` with its
 * publication waiting on a human, and the revocation flow wants a LOW-risk one
 * that reached `published`.
 */
export async function releaseVersion(fx, { ownerKey, reviewerKey, adopterKey, versionId, manifest, stopAfter = "publish", tag = "rel" }) {
  const steps = [];
  const record = (what, r) => {
    steps.push({ what, status: r.status, ok: r.status < 400, body: r.body });
    return r;
  };
  /** Stop at the first step that did not work, so a gate reports the step that
   *  broke rather than a symptom four calls later. */
  const must = (what, r) => {
    record(what, r);
    if (r.status >= 400) throw new Error(`${tag}: ${what} answered ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };

  // draft → linted. The gates run here, on the bytes the registry signed.
  must("lint", await api(fx.base, "POST", `/v1/versions/${versionId}/lint`, ownerKey, { idempotency_key: `${tag}-lint` }));
  if (stopAfter === "lint") return { steps, requestId: null, receiptId: null };

  // linted → reviewed. TWO PRINCIPALS, because the self-review prohibition is
  // real: the author asks and a reviewer answers.
  must(
    "ask for a review",
    await api(fx.base, "POST", `/v1/versions/${versionId}/reviews`, ownerKey, {
      action: "request",
      idempotency_key: `${tag}-review-request`,
    }),
  );
  if (stopAfter === "review_requested") return { steps, requestId: null, receiptId: null };
  must(
    "record the reviewer's verdict",
    await api(fx.base, "POST", `/v1/versions/${versionId}/reviews`, reviewerKey, {
      action: "verdict",
      verdict: "approve",
      note: "the fixture reviewer approves",
      idempotency_key: `${tag}-review-verdict`,
    }),
  );
  if (stopAfter === "reviewed") return { steps, requestId: null, receiptId: null };

  // The trial adoption SPEC.md section 5.1 requires before a version verifies:
  // requested, adopted, attempted, and reported `adopted` with its evidence.
  const req = must(
    "request a trial adoption",
    await api(fx.base, "POST", "/v1/adoptions/requests", adopterKey, {
      skill_version_id: versionId,
      idempotency_key: `${tag}-adopt-request`,
    }),
  );
  const requestId = req.body?.adoption_request_id ?? null;
  let receiptId = req.body?.receipt_id ?? null;
  // A HIGH-RISK REQUEST STOPS HERE BY ITSELF. The registry answers
  // `approval_pending` and refuses the adopt until a human decides, which is
  // precisely the `adopt_high_risk` item the Approval Inbox is for — so a caller
  // that wants one asks for this stop and lets the Console take the next step.
  if (stopAfter === "adoption_requested") return { steps, requestId, receiptId };

  const adopted = must(
    "adopt, which hands the package over and opens a receipt",
    await api(fx.base, "POST", `/v1/adoptions/${requestId}/adopt`, adopterKey, {
      environment_descriptor: ENVIRONMENT_DESCRIPTOR,
      idempotency_key: `${tag}-adopt`,
    }),
  );
  receiptId = adopted.body?.receipt_id ?? receiptId;

  must(
    "report that the procedure was attempted",
    await api(fx.base, "POST", `/v1/receipts/${receiptId}/events`, adopterKey, {
      event: "attempted",
      idempotency_key: `${tag}-attempted`,
    }),
  );
  must(
    "report the trial's outcome, with the gate evidence",
    await api(fx.base, "POST", `/v1/receipts/${receiptId}/events`, adopterKey, {
      event: "adopted",
      evidence: evidenceFor(manifest),
      idempotency_key: `${tag}-adopted`,
    }),
  );
  if (stopAfter === "adopted") return { steps, requestId, receiptId };

  // reviewed → verified.
  const verified = must(
    "verify",
    await api(fx.base, "POST", `/v1/versions/${versionId}/verify`, ownerKey, { idempotency_key: `${tag}-verify` }),
  );
  if (verified.body?.state !== "verified") {
    throw new Error(`${tag}: verify did not verify — ${JSON.stringify(verified.body?.checks ?? verified.body)}`);
  }
  if (stopAfter === "verified") return { steps, requestId, receiptId };

  // verified → published. For a HIGH-risk version this is the step SPEC.md
  // section 7.3 puts a human in front of, so a caller that wants a pending
  // publication approval stops at `verified` and lets the Console decide.
  must("publish", await api(fx.base, "POST", `/v1/versions/${versionId}/publish`, ownerKey, { idempotency_key: `${tag}-publish` }));
  return { steps, requestId, receiptId };
}

/** A principal of this workspace, created over the provisioning surface, with
 *  the API key it was issued. The Approval Inbox needs at least two — an author
 *  and somebody who is not the author — and a reviewer session needs a third. */
export async function principal(fx, ownerKey, { name, type = "human", role = "member" }) {
  const r = await api(fx.base, "POST", "/v1/principals", ownerKey, {
    name,
    type,
    role,
    idempotency_key: `principal-${name}`,
  });
  if (r.status !== 201) throw new Error(`could not create the principal ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return { agent_id: r.body.principal_id, api_key: r.body.api_key, role, type };
}

/** The manifest a source directory declares, read from the tree the author
 *  wrote. It is the same document the registry packed and signed, which is why
 *  the evidence built from it satisfies the gates the signed manifest names. */
export function sourceManifest(sourceDir) {
  return JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
}

/** The state the registry currently reports for a version. Read over the
 *  product's own surface, so an assertion about "the backend record" is an
 *  assertion about what the backend serves. */
export async function versionState(fx, key, slug, versionId) {
  const r = await api(fx.base, "GET", `/v1/skills?q=${encodeURIComponent(slug)}&include_states=all`, key);
  const item = (r.body?.items ?? []).find((i) => i.skill_version_id === versionId) ?? null;
  return { status: r.status, state: item?.registry?.state ?? item?.state ?? null, item };
}

/** Every transparency-log entry, oldest first. The second half of "assert the
 *  approval row AND the tlog entry" — a decision that did not reach the log is a
 *  decision this registry cannot prove it made. */
export async function tlog(fx, key) {
  const r = await api(fx.base, "GET", "/v1/tlog?limit=200", key);
  return r.body?.items ?? r.body?.entries ?? [];
}
