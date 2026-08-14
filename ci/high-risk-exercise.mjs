#!/usr/bin/env node
// THE HIGH-RISK OPERATIONAL EXERCISE — one clean instance, driven end to end.
//
//   node ci/high-risk-exercise.mjs --clean --transcript evidence/high-risk-exercise.json
//
// It performs, in this order, and fails the run at the first step that does not
// behave:
//
//   1. occupy a port and start a second `serve` on it: the start must be
//      FAIL-CLOSED — `EADDRINUSE`, no success banner, no §9.1 credentials in
//      the clear, and no data directory left behind;
//   2. load `fixtures/high-risk-safe/`, whose manifest declares `risk_level:
//      high`, and pack it against this deployment's own author principal;
//   3. request adoption of it;
//   4. confirm the TYPED refusal before any human approval exists;
//   5. record a human approval through the existing §7.3 contract;
//   6. run the safe fixture that was actually handed over, and nothing else;
//   7. save this run's output, redacted, as the operational transcript;
//   8. drive the receipt to terminal `adopted` and read it back from the server.
//
// WHAT A PASS PROVES, AND WHAT IT DOES NOT. `observed` and the receipt remain
// assertions — the adopter's and the server's. This exercise does not claim any
// cryptographic proof that the text in `observed` was produced by a run. What
// it proves is narrower and is the whole claim: an owner-controlled runner
// executed these commands against a clean instance, the refusal happened before
// the approval and the handover after it, and the terminal receipt reads back
// from the server as `adopted` for this one safe fixture.
//
// Node only: no bash, no curl, no tar binary. `sh` is spawned once, in step 6,
// because the fixture package declares a shell as the tool of its single step —
// that is the package's contract, not this runner's.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.ts");
const NODE_TS = ["--experimental-strip-types", "--no-warnings"];
const FIXTURE_DIR = join(ROOT, "fixtures", "high-risk-safe");
const MARKER = "HIGH_RISK_EXERCISE_OK";
/** §7 performance budget: `/health` answers within this after a start. */
const HEALTH_TIMEOUT_MS = 120_000;

// ----------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { clean: false, transcript: null, dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--clean") opts.clean = true;
    else if (a === "--transcript" || a === "--data") {
      const v = argv[i + 1];
      if (v === undefined) fail(`${a} needs a value`);
      if (a === "--transcript") opts.transcript = resolve(v);
      else opts.dataDir = resolve(v);
      i += 1;
    } else fail(`unknown option ${a}\nusage: node ci/high-risk-exercise.mjs [--clean] [--data DIR] [--transcript FILE]`);
  }
  return opts;
}

class Failure extends Error {}
function fail(message) {
  throw new Failure(message);
}
function check(condition, message) {
  if (!condition) fail(message);
}

// ------------------------------------------------------------------ redaction
//
// One register of live secrets, and one substitution applied to every string
// that reaches the transcript. A value is registered the moment it exists, so
// nothing can be recorded before it is redactable.

const SECRETS = new Map(); // value → label

function classify(value, label) {
  if (typeof value === "string" && value.length >= 8) SECRETS.set(value, label);
  return value;
}

function redact(text) {
  let out = String(text);
  for (const [value, label] of SECRETS) out = out.split(value).join(`[redacted:${label}]`);
  return out;
}

function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

// ---------------------------------------------------------------------- ports

async function holdPort() {
  const holder = createServer();
  holder.listen(0, "127.0.0.1");
  await once(holder, "listening");
  const { port } = holder.address();
  return { port, release: () => new Promise((r) => holder.close(r)) };
}

async function freePort() {
  const held = await holdPort();
  await held.release();
  return held.port;
}

// ------------------------------------------------------------------- the tar
//
// A POSIX ustar reader, small enough to read: the delivered package arrives as
// base64 of the archive the registry signed, and unpacking it must not depend
// on a `tar` binary being on PATH.

function readUstar(bytes) {
  const files = new Map();
  for (let off = 0; off + 512 <= bytes.length; ) {
    const header = bytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const nul = header.indexOf(0);
    const name = header.subarray(0, nul === -1 || nul > 100 ? 100 : nul).toString("utf8");
    const size = parseInt(header.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim(), 8);
    check(Number.isInteger(size) && size >= 0, `delivered archive: unreadable size field for ${name}`);
    const type = String.fromCharCode(header[156]);
    const start = off + 512;
    if (type === "0" || type === "\0") files.set(name, bytes.subarray(start, start + size));
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

// ------------------------------------------------------------- the deployment

/** Run `serve` and collect everything it prints. Resolves when the process ends. */
function serveToCompletion(args, timeoutMs = 60_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [...NODE_TS, CLI, ...args], { cwd: ROOT });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Failure(`a start that was expected to fail is still running after ${timeoutMs} ms`));
    }, timeoutMs);
    const read = (c) => {
      out += c.toString("utf8");
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, out });
    });
  });
}

/** Start `serve` and wait until `/health` answers. */
async function startInstance(port, dataDir) {
  const child = spawn(process.execPath, [...NODE_TS, CLI, "serve", "--port", String(port), "--data", dataDir], {
    cwd: ROOT,
  });
  let out = "";
  const read = (c) => {
    out += c.toString("utf8");
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  let died = null;
  child.on("close", (code, signal) => {
    died = `serve exited ${code}/${signal}`;
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let health = null;
  while (Date.now() < deadline) {
    if (died !== null) fail(`${died} before answering /health:\n${redact(out)}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        health = await res.json();
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  check(health !== null, `/health did not answer within ${HEALTH_TIMEOUT_MS} ms:\n${redact(out)}`);

  const credential = (name) => {
    const m = new RegExp(`^${name}=(\\S+)$`, "m").exec(out);
    check(m, `the first start did not print ${name}:\n${redact(out)}`);
    return classify(m[1], name);
  };
  const tokens = {
    bootstrap_owner_token: credential("BOOTSTRAP_OWNER_TOKEN"),
    demo_adopter_token: credential("DEMO_ADOPTER_TOKEN"),
  };

  return {
    base,
    health,
    tokens,
    log: () => out,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}

// ----------------------------------------------------------------------- HTTP

async function api(base, method, path, key, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

function expect(res, status, what) {
  check(res.status === status, `${what}: expected HTTP ${status}, got ${res.status} — ${redact(JSON.stringify(res.body))}`);
  return res.body;
}

// ------------------------------------------------------------------ the steps

async function main(opts) {
  const startedAt = new Date().toISOString();
  const steps = [];
  const record = (n, name, detail) => {
    steps.push({ n, name, ...redactDeep(detail) });
    console.log(`[${n}/8] ${name}`);
  };

  // ---- the data directory. `--clean` means a directory this run created.
  let dataDir = opts.dataDir;
  let disposable = false;
  if (dataDir === null) {
    dataDir = join(mkdtempSync(join(tmpdir(), "sklo-hrx-")), "data");
    disposable = opts.clean;
  } else if (opts.clean && existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    fail(`--clean will not reuse a populated data directory: ${dataDir}`);
  }

  // ---- 1. a bound port, and a start that refuses to half-open on it
  const held = await holdPort();
  const refusedDataDir = join(mkdtempSync(join(tmpdir(), "sklo-hrx-bind-")), "never-created");
  const bindRun = await serveToCompletion(["serve", "--port", String(held.port), "--data", refusedDataDir]);
  await held.release();

  const bindOut = bindRun.out;
  check(bindRun.code !== 0, `a start on an occupied port exited ${bindRun.code}:\n${bindOut}`);
  check(/EADDRINUSE/.test(bindOut), `the refusal did not name EADDRINUSE:\n${bindOut}`);
  check(!/listening on http:\/\//.test(bindOut), `a server that never bound announced itself:\n${bindOut}`);
  check(!/first start/.test(bindOut), `the §9.1 block was printed without a listener:\n${bindOut}`);
  for (const secret of ["BOOTSTRAP_OWNER_TOKEN=", "DEMO_ADOPTER_TOKEN="]) {
    check(!bindOut.includes(secret), `${secret} was printed by a process that never served`);
  }
  check(!existsSync(refusedDataDir), `a bootstrap side effect survived a failed bind: ${refusedDataDir}`);
  record(1, "fail-closed start on an occupied port", {
    port_held: held.port,
    exit_code: bindRun.code,
    banner_printed: false,
    credentials_printed: false,
    data_directory_created: false,
    stderr_first_line: bindOut.trim().split("\n")[0] ?? "",
  });

  // ---- the clean instance every step below runs against
  const port = await freePort();
  const instance = await startInstance(port, dataDir);
  const { base } = instance;
  try {
    const owner = expect(
      await api(base, "POST", "/v1/auth/bootstrap", undefined, {
        bootstrap_token: instance.tokens.bootstrap_owner_token,
      }),
      200,
      "the §9.1 bootstrap exchange",
    );
    const ownerKey = classify(owner.api_key, "OWNER_API_KEY");

    const publisher = expect(
      await api(base, "POST", "/v1/principals", ownerKey, { name: "exercise-publisher", type: "agent", role: "member" }),
      201,
      "creating the author principal",
    );
    const publisherKey = classify(publisher.api_key, "PUBLISHER_API_KEY");

    // ---- 2. the high-risk fixture, packed against this deployment's author
    const seedHex = classify(randomBytes(32).toString("hex"), "SIGNING_SEED_HEX");
    const packOut = join(mkdtempSync(join(tmpdir(), "sklo-hrx-pack-")), "out");
    const packed = spawnSync(
      process.execPath,
      [
        ...NODE_TS,
        join(ROOT, "tools", "pack-skill.ts"),
        FIXTURE_DIR,
        "--author", publisher.principal_id,
        "--seed-hex", seedHex,
        "--kid", "exercise-key-1",
        "--out", packOut,
        "--name", "high-risk-safe",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    check(packed.status === 0, `pack-skill refused the fixture: ${redact(packed.stdout + packed.stderr)}`);
    const contentHash = /content hash\s*:\s*([0-9a-f]{64})/.exec(packed.stdout)?.[1];
    check(contentHash, `pack-skill printed no content hash: ${redact(packed.stdout)}`);
    const archive = readFileSync(join(packOut, "high-risk-safe.tar"));
    const sourceManifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"));
    check(
      sourceManifest.scope.risk_level === "high",
      `the fixture is not high-risk (${sourceManifest.scope.risk_level}) — there is nothing to exercise`,
    );

    const created = expect(
      await api(base, "POST", "/v1/skills", publisherKey, {
        slug: "high-risk-safe",
        archive: archive.toString("base64"),
      }),
      201,
      "skill.create",
    );
    const versionId = created.skill_version_id;
    const linted = expect(await api(base, "POST", `/v1/versions/${versionId}/lint`, publisherKey, {}), 200, "skill.lint");
    check(linted.state === "linted", `the fixture did not lint clean: ${redact(JSON.stringify(linted))}`);
    expect(await api(base, "POST", `/v1/versions/${versionId}/reviews`, publisherKey, { action: "request" }), 200, "review request");
    const reviewed = expect(
      await api(base, "POST", `/v1/versions/${versionId}/reviews`, ownerKey, { action: "verdict", verdict: "approve" }),
      200,
      "review verdict",
    );
    check(reviewed.state === "reviewed", `the fixture did not reach reviewed: ${redact(JSON.stringify(reviewed))}`);
    record(2, "high-risk fixture loaded and reviewed", {
      source: "fixtures/high-risk-safe",
      risk_level: sourceManifest.scope.risk_level,
      sandbox_requirement: sourceManifest.safety.sandbox_requirement,
      required_approvals: sourceManifest.scope.required_approvals,
      content_hash: contentHash,
      skill_version_id: versionId,
      state: reviewed.state,
      gates: linted.reports.map((g) => `${g.gate}:${g.result}`),
    });

    // ---- 3. the adoption request, as the §9.1 demo adopter
    const adopterKey = instance.tokens.demo_adopter_token;
    const request = expect(
      await api(base, "POST", "/v1/adoptions/requests", adopterKey, { skill_version_id: versionId }),
      201,
      "skill.request_adoption",
    );
    check(
      request.state === "approval_pending",
      `a high-risk request was not held for approval: ${redact(JSON.stringify(request))}`,
    );
    record(3, "adoption requested", {
      adoption_request_id: request.adoption_request_id,
      receipt_id: request.receipt_id,
      state: request.state,
      approval_required: request.approval_required,
    });

    // ---- 4. the typed refusal, BEFORE any approval exists
    const descriptor = {
      runtime: { id: "any", version: "1.0.0" },
      model: { id: "any", version: "1.0.0" },
      tools: [{ id: "shell", version: "1.0.0" }],
      os: "linux",
      shell: "sh",
      sandbox_capable: true,
    };
    const refusal = await api(base, "POST", `/v1/adoptions/${request.adoption_request_id}/adopt`, adopterKey, {
      environment_descriptor: descriptor,
    });
    check(refusal.status === 403, `an unapproved high-risk adoption answered ${refusal.status}`);
    check(
      refusal.body?.error?.code === "FORBIDDEN",
      `the refusal was not typed: ${redact(JSON.stringify(refusal.body))}`,
    );
    check(
      refusal.body.error.current_state === "approval_pending",
      `the refusal did not name the state it refused from: ${redact(JSON.stringify(refusal.body))}`,
    );
    check(
      !("package" in (refusal.body ?? {})),
      "the refusal carried a package — a refused high-risk adoption must hand nothing over",
    );
    const refusalRecord = {
      http_status: refusal.status,
      code: refusal.body.error.code,
      current_state: refusal.body.error.current_state,
      message: refusal.body.error.message,
    };
    record(4, "typed refusal before human approval", refusalRecord);

    // ---- 5. the human approval, through the existing §7.3 contract
    const approval = expect(
      await api(base, "POST", `/v1/versions/${versionId}/approvals`, ownerKey, {
        scope: "adopt_high_risk",
        decision: "approved",
        adoption_request_id: request.adoption_request_id,
        note: "high-risk operational exercise: owner-controlled runner, safe fixture",
      }),
      201,
      "the §7.3 approval",
    );
    check(approval.decision === "approved", `the approval was not recorded as approved: ${redact(JSON.stringify(approval))}`);
    check(
      approval.adoption_request_id === request.adoption_request_id,
      "the approval is not bound to this adoption request",
    );
    const approvalRecord = {
      approval_id: approval.approval_id,
      scope: approval.scope,
      decision: approval.decision,
      adoption_request_id: approval.adoption_request_id,
      conditions: approval.conditions,
      tlog_seq: approval.tlog_seq,
      approver: "the §9.1 owner — agents.type='human', workspace role owner",
    };
    record(5, "human approval recorded", approvalRecord);

    // ---- 6. the handover, and the ONLY thing this exercise executes
    const adopted = expect(
      await api(base, "POST", `/v1/adoptions/${request.adoption_request_id}/adopt`, adopterKey, {
        environment_descriptor: descriptor,
      }),
      200,
      "skill.adopt after the approval",
    );
    check(adopted.receipt_event === "delivered", `the handover did not happen: ${redact(JSON.stringify(adopted))}`);
    check(
      adopted.package.content_hash === contentHash,
      `the delivered package is not the one that was packed (${adopted.package.content_hash} ≠ ${contentHash})`,
    );

    const workDir = join(mkdtempSync(join(tmpdir(), "sklo-hrx-run-")), "package");
    const delivered = readUstar(Buffer.from(adopted.package.archive_base64, "base64"));
    for (const [path, bytes] of delivered) {
      const target = join(workDir, path);
      check(resolve(target).startsWith(resolve(workDir)), `delivered archive names a path outside the work directory: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const manifest = JSON.parse(delivered.get("skill.json").toString("utf8"));
    const step = manifest.procedure.steps[0];
    check(
      manifest.procedure.steps.length === 1 && step.command === "sh fixtures/tv-high.sh",
      `the fixture declares something other than the one safe step: ${redact(JSON.stringify(manifest.procedure.steps))}`,
    );
    const run = spawnSync("sh", [join(workDir, "fixtures", "tv-high.sh")], { cwd: workDir, encoding: "utf8" });
    check(run.status === 0, `the fixture exited ${run.status}: ${run.stderr}`);
    const observed = run.stdout.trim();
    check(observed === step.expected, `the fixture printed ${JSON.stringify(observed)}, not ${JSON.stringify(step.expected)}`);
    const runnerOutput = {
      command: step.command,
      exit_code: run.status,
      stdout: observed,
      stderr: run.stderr,
      expected: step.expected,
      work_directory: "a temporary directory created by this run",
    };
    record(6, "the safe fixture executed", runnerOutput);

    // ---- 7/8. the receipt, and the read-back from the server
    expect(
      await api(base, "POST", `/v1/receipts/${request.receipt_id}/events`, adopterKey, { event: "attempted" }),
      200,
      "the `attempted` event",
    );
    const terminal = expect(
      await api(base, "POST", `/v1/receipts/${request.receipt_id}/events`, adopterKey, {
        event: "adopted",
        evidence: {
          gate_results: manifest.procedure.validation_gates.map((g) => ({
            gate_id: g.gate_id,
            pass: true,
            observed,
          })),
        },
      }),
      200,
      "the `adopted` event",
    );
    check(terminal.receipt_event === "adopted", `the chain did not reach adopted: ${redact(JSON.stringify(terminal))}`);

    const readBack = expect(
      await api(base, "GET", `/v1/receipts/${request.receipt_id}`, adopterKey),
      200,
      "the receipt read-back",
    );
    check(
      readBack.derived_state === "adopted",
      `the server reads this receipt back as ${readBack.derived_state}, not adopted`,
    );
    const readBackRecord = {
      receipt_id: request.receipt_id,
      derived_state: readBack.derived_state,
      events: readBack.events.map((e) => e.event),
      skill_version_id: versionId,
      read_back_from: "GET /v1/receipts/{id} on the running instance",
      trust_boundary:
        "`observed` and this receipt are the adopter's and the server's assertions. The registry checks that the " +
        "reported gate ids are the ones this version declares and that each passed; it does not witness the run.",
    };
    record(8, "terminal receipt read back from the server", readBackRecord);

    // ---- 7 (the artefact). Everything above, redacted, in one file.
    const transcript = redactDeep({
      exercise: "high-risk-exercise",
      marker: MARKER,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      instance: { health: instance.health, base_url: `http://127.0.0.1:${port}`, clean: true },
      fixture: {
        source: "fixtures/high-risk-safe",
        content_hash: contentHash,
        risk_level: sourceManifest.scope.risk_level,
      },
      steps,
      refusal: refusalRecord,
      approval: approvalRecord,
      runner_output: runnerOutput,
      terminal_read_back: readBackRecord,
      server_log: redact(instance.log()).split("\n"),
    });

    const serialized = `${JSON.stringify(transcript, null, 2)}\n`;
    // The transcript is the artefact a reviewer reads, so the absence of
    // secrets in it is checked HERE rather than assumed of the redactor.
    for (const [value, label] of SECRETS) {
      check(!serialized.includes(value), `the transcript leaked ${label} — it must not leave this process`);
    }
    if (opts.transcript !== null) {
      mkdirSync(dirname(opts.transcript), { recursive: true });
      writeFileSync(opts.transcript, serialized);
      console.log(`[7/8] transcript written (last, because it records step 8): ${opts.transcript}`);
      console.log(`      sha256 ${createHash("sha256").update(serialized).digest("hex")}`);
    } else {
      console.log("[7/8] transcript not written: --transcript was not given");
    }
    return { dataDir, disposable, instance };
  } catch (e) {
    instance.stop();
    if (disposable) rmSync(dirname(dataDir), { recursive: true, force: true });
    throw e;
  }
}

const opts = parseArgs(process.argv.slice(2));
try {
  const { dataDir, disposable, instance } = await main(opts);
  instance.stop();
  if (disposable) rmSync(dirname(dataDir), { recursive: true, force: true });
  console.log(MARKER);
  process.exitCode = 0;
} catch (e) {
  console.error(`high-risk-exercise: ${e instanceof Failure ? e.message : redact(String(e?.stack ?? e))}`);
  process.exitCode = 1;
}
