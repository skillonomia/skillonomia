#!/usr/bin/env node
// THE EXTERNAL PILOT — one run, one record, one verifier.
//
//   node ci/run-pilot.mjs run --path npm --artifact @skillonomia/cli@<version> \
//     --candidate-sha <40 hex> --verification-base-url https://<host> \
//     --record evidence/pilots/macos.json --transcript evidence/pilots/macos-transcript.json \
//     --token-file <a file outside this checkout>
//
//   node ci/run-pilot.mjs verify --online \
//     --macos-record evidence/pilots/macos.json \
//     --macos-token-file "${MACOS_PILOT_TOKEN_FILE}" \
//     --windows-record evidence/pilots/windows.json \
//     --windows-token-file "${WINDOWS_PILOT_TOKEN_FILE}"
//
// …and, when the owner has deferred the Windows pilot, the same command with
// `--windows-deferred` in place of that pair. It runs the identical checks on
// the record it has and prints a marker that counts it: one, not two.
//
// THE ONE PRODUCER, AND THE ONE VERIFIER. §7 allows this project four new
// acceptance scripts before the pilots and this is the fourth. `run` is the
// only thing that writes a pilot record, and `verify` is the only thing that
// reads one as evidence. Nobody fills a terminal field in by hand: the receipt
// id, its state, the read-back hash, the transcript hash and the time to the
// first `adopted` are produced by the run that observed them, and a record
// edited afterwards fails `verify` rather than passing quietly.
//
// WHAT ONE RUN DOES, in the order §C names it:
//
//   install → start → create → review → adopt → adopter claim → receipt read-back
//
// The artifact comes from WHERE A USER GETS IT — the npm registry or a
// container registry, by version or by immutable digest — and never from this
// checkout. The package that is created, reviewed and adopted is a low-risk
// source tree carried inside THIS FILE, so that a pilot host needs no fixture
// directory and no signing key of its own: the registry packs and signs it.
//
// WHAT A PASS PROVES, AND WHAT IT DOES NOT. The receipt is a server-recorded
// adopter claim. This runner executed the package's own declared step and
// reported what it saw; the registry checked that the gate ids reported are the
// ones the version declares. Neither is a cryptographic proof that the text in
// `observed` came from a run. The narrow claim — an owner-controlled harness
// drove these steps against this artifact on this host, and the server reads
// the receipt back as `adopted` at a URL the owner can reach — is the whole of
// what a pilot record asserts.
//
// SECRETS LEAVE THROUGH ONE DOOR. The credential the owner needs for the
// read-back is written to the token file named on the command line, with no
// other copy: not in the record, not in the transcript, not on stdout. Before
// either artefact is written, both are searched for every credential this run
// minted, for this machine's user name and for its absolute paths, and a hit
// stops the run.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ustar } from "./mvp-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The record a completed, non-rehearsal run produces. */
const RUN_OK = "PILOT_RUN_OK";
/** The same run when the owner's verification URL is this machine's loopback. */
const RUN_STAGED = "PILOT_RUN_STAGED_OK";
/** A run that reproduced a blocker and never reached `adopted`. */
const RUN_BLOCKED = "PILOT_RUN_BLOCKED";
/** §C's acceptance marker: two records, both online, neither a rehearsal. */
const PILOTS_OK = "PILOTS_OK 2/2";
/**
 * THE OWNER'S DEFERRAL, SAID OUT LOUD. §C names two participants and the marker
 * above counts them, so while the Windows boundary stands deferred by the owner
 * there is no second record and the marker above is unreachable — not failed,
 * unreachable. This is what that run prints instead: a DIFFERENT marker for a
 * WEAKER claim, reached only when `--windows-deferred` is passed by name. The
 * checks it applies to the one record it has are the ones a two-record run
 * applies; what it does not have is a second record, and it says which.
 */
const PILOTS_DEFERRED = "PILOTS_OK 1/1 WINDOWS_DEFERRED_BY_OWNER";
/** The same checks when at least one record is a rehearsal. */
const PILOTS_REHEARSAL = "PILOTS_REHEARSAL_OK";

/** §7 performance budget: `/health` answers within this after a start. */
const HEALTH_TIMEOUT_MS = 120_000;
/** §7 performance budget: a clean quickstart reaches `adopted` within this. */
const QUICKSTART_BUDGET_MS = 600_000;

/** The schema a record is checked against, at this path in this repository. */
const TEMPLATE = "evidence/pilots/PILOT_TEMPLATE.json";

const USAGE = `usage:
  node ci/run-pilot.mjs run --path <npm|docker> --artifact <spec> --candidate-sha <40 hex>
                            --verification-base-url <url> --record <file> --transcript <file>
                            --token-file <file>
      install the artifact the way a user would, drive install→start→create→review→adopt→claim→read-back,
      and write the record, the redacted transcript and the read-back credential

  node ci/run-pilot.mjs verify --online --macos-record <file> --macos-token-file <file>
                               --windows-record <file> --windows-token-file <file>
      check both records against their transcripts, their artifacts, the live /health and the live receipt

  node ci/run-pilot.mjs verify --online --macos-record <file> --macos-token-file <file>
                               --windows-deferred
      the same checks on the one record there is, when the owner has deferred the Windows pilot;
      prints ${PILOTS_DEFERRED} and never ${PILOTS_OK}

options (run):
  --path npm|docker            which official path this pilot used
  --artifact <spec>            @scope/name@version, or <registry>/<image>@sha256:<64 hex>
  --candidate-sha <40 hex>     the exact source commit the artifact was built from
  --verification-base-url <u>  where the owner will reach this deployment until acceptance
  --record <file>              where the record is written
  --transcript <file>          where the redacted transcript is written (beside the record)
  --token-file <file>          where the read-back credential is written, and its only copy
  --port <n>                   the loopback port to publish on (default: one this run picks)
  --stop-when-done             stop the deployment at the end (a rehearsal; the owner can then reach nothing)
  --keep                       leave the temporary install directory in place

options (verify):
  --online                     required for ${PILOTS_OK}: the live instance is contacted
  --macos-record / --windows-record <file>
  --macos-token-file / --windows-token-file <file>
  --windows-deferred           the owner deferred the Windows pilot: check the one record there is and say so
                               in the marker. Never implied — without it a missing --windows-record is an error,
                               and with it a --windows-record is one too
`;

// ------------------------------------------------------------------ failures

class Failure extends Error {}
function fail(message) {
  throw new Failure(message);
}
function check(condition, message) {
  if (!condition) fail(message);
}
function usage(message) {
  process.stderr.write(`ci/run-pilot.mjs: ${message}\n\n${USAGE}`);
  process.exit(2);
}

// ----------------------------------------------------------------- redaction
//
// One register of live secrets and one substitution applied to every string
// that reaches an artefact. A value is registered the moment it exists, so
// nothing can be recorded before it is redactable. The machine's own names —
// its user, its home, the temporary directories this run created — are
// registered the same way, because §C forbids them in a record for the same
// reason it forbids a token: they identify a person and a machine.

const SECRETS = new Map(); // value → label

function classify(value, label) {
  if (typeof value === "string" && value.length >= 8) SECRETS.set(value, label);
  return value;
}

const PLACES = new Map(); // value → placeholder

function place(value, placeholder) {
  if (typeof value === "string" && value.length >= 3) PLACES.set(value, placeholder);
  return value;
}

function redact(text) {
  let out = String(text);
  for (const [value, label] of SECRETS) out = out.split(value).join(`[redacted:${label}]`);
  for (const [value, placeholder] of PLACES) out = out.split(value).join(placeholder);
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

/**
 * WHAT AN ARTEFACT IS SEARCHED FOR BEFORE IT IS WRITTEN, and what a verifier
 * searches a record for afterwards. The registered values are this run's own;
 * the patterns below hold for a record this process never produced, which is
 * the case that matters when a record arrives from somebody else's machine.
 */
const FORBIDDEN_SHAPES = [
  [/BOOTSTRAP_OWNER_TOKEN\s*=\s*\S/, "a bootstrap credential"],
  [/DEMO_ADOPTER_TOKEN\s*=\s*\S/, "an adopter credential"],
  [/\bBearer\s+\S/, "an authorization header"],
  [/\bsk-[A-Za-z0-9]{16,}/, "an API key"],
  [/(^|[^A-Za-z0-9])\/(?:Users|home)\/[A-Za-z0-9._-]+\//, "a user's home directory"],
  [/[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]+/, "a Windows user profile path"],
  [/\/(?:private\/)?(?:var|tmp)\/[A-Za-z0-9._\/-]*skillonomia/i, "a temporary machine path"],
];

function scanForSecrets(what, text) {
  for (const [value, label] of SECRETS) {
    check(!text.includes(value), `${what} carries ${label} — a credential leaves through the token file and nowhere else`);
  }
  for (const [pattern, label] of FORBIDDEN_SHAPES) {
    const hit = pattern.exec(text);
    check(hit === null, `${what} carries ${label} (${JSON.stringify(hit?.[0]?.slice(0, 60))})`);
  }
}

// ------------------------------------------------------------------- hashing

/** Keys in order, everywhere, so a hash is of what a document SAYS. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const hashOf = (value) => sha256(Buffer.from(canonical(value), "utf8"));

// --------------------------------------------------------------------- ulid

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A §4.1 identifier for the source manifest. Time first, then randomness. */
function ulid(now = Date.now()) {
  let time = "";
  let ms = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  let rand = "";
  for (const byte of randomBytes(16)) rand += CROCKFORD[byte % 32];
  return time + rand;
}

// ------------------------------------------------------------- the package
//
// THE SOURCE TREE TRAVELS WITH THE RUNNER. A pilot host has the artifact and
// this file, and nothing else of this project: no fixture directory, no signing
// key, no packer. So the low-risk package it creates is written here and handed
// to `POST /v1/skills/from-source`, where the registry packs and signs it with
// its own system key. The step is one deterministic line of shell, the gate
// compares its stdout with the string the manifest declares, and the manifest
// says what success is (`outcome_contract`) because a registry-packed package
// is refused without it.

const SLUG = "skillonomia-pilot-check";
const EXPECTED = "skillonomia-pilot-ok";
const FIXTURE = `#!/bin/sh\nprintf '${EXPECTED}'\n`;
const SKILL_MD = [
  "# Skillonomia pilot check",
  "",
  "The package an external pilot creates, reviews and adopts on one host.",
  "",
  "## Procedure",
  "",
  "1. Run the fixture and compare its output with the declared gate.",
  "",
].join("\n");

function pilotManifest() {
  return {
    skill_id: ulid(),
    semantic_version: "1.0.0",
    title: "skillonomia-pilot-check",
    capability_statement:
      "External pilot package: run one deterministic fixture command and compare its output with the declared gate.",
    owner: "skillonomia-pilot",
    created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    license: "Apache-2.0",
    access_policy: "workspace",
    scope: {
      problem_class: "Proving that one external host can create, review and adopt a low-risk package end to end.",
      non_goals: ["Any production use"],
      prerequisites: [],
      risk_level: "low",
      required_approvals: [],
    },
    runtime: {
      model_compat: [{ id: "any", range: "*" }],
      runtime_compat: [{ id: "any", range: "*" }],
      tool_compat: [{ id: "shell", range: "*" }],
      // Three platforms and one shell: the step is POSIX and runs wherever a
      // POSIX shell answers, which on Windows means the one a user installed.
      // `failure_modes` carries the case where none does, and the runner
      // reports that case rather than a receipt nobody earned.
      os: ["linux", "macos", "windows"],
      shell: ["sh"],
      cloud_iam_assumptions: [],
      mcp_dependencies: [],
    },
    procedure: {
      steps: [
        {
          n: 1,
          instruction: "Run the fixture script.",
          command: "sh fixtures/tv-pilot.sh",
          expected: EXPECTED,
        },
      ],
      expected_outputs: [EXPECTED],
      validation_gates: [
        { gate_id: "g1", check: "stdout equals expected string", pass_criteria: `stdout == '${EXPECTED}'` },
      ],
      rollback: ["No changes made; nothing to roll back."],
      failure_modes: [{ mode: "shell-missing", symptom: "sh not found", mitigation: "install a POSIX shell" }],
      tools_used: [{ id: "shell", range: "*" }],
    },
    evidence: {
      summary: "Deterministic fixture prints a fixed string; gate g1 compares stdout.",
      test_results: "pilot host: g1 pass",
      redaction_level: "none",
    },
    safety: {
      forbidden_actions: ["network access", "file writes outside workdir"],
      secrets_policy: "No secrets used or accepted.",
      dependency_manifest: [],
      url_allowlist: [],
      sandbox_requirement: "none",
    },
    lifecycle: { supersedes: null },
    outcome_contract: {
      check: { kind: "stdout_match", stdout_match: EXPECTED },
      evidence: ["exit_code", "stdout"],
      unknown: "no evaluated run of this package was reported, which is not a failure of it",
    },
  };
}

function pilotSource(manifest) {
  return ustar([
    ["manifest.json", Buffer.from(JSON.stringify(manifest), "utf8")],
    ["SKILL.md", Buffer.from(SKILL_MD, "utf8")],
    ["fixtures/tv-pilot.sh", Buffer.from(FIXTURE, "utf8")],
  ]);
}

// --------------------------------------------------------------------- tar
//
// A POSIX ustar reader for the DELIVERED package. `ustar` above writes the
// source; this reads what the registry signed and handed back, and neither may
// depend on a `tar` binary being on a pilot's PATH.

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

// -------------------------------------------------------------------- ports

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

const LOOPBACK_URL = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)(?::\d+)?(?:\/|$)/i;

// --------------------------------------------------------------------- HTTP

async function api(base, method, path, key, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    fail(`${method} ${path}: ${base} did not answer (${String(e?.message ?? e)})`);
  }
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

function expect(res, status, what) {
  check(
    res.status === status,
    `${what}: expected HTTP ${status}, got ${res.status} — ${redact(JSON.stringify(res.body)).slice(0, 300)}`,
  );
  return res.body;
}

/** Wait for `status=ok`, and return the body the deployment answered with. */
async function waitForHealth(base, what) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") return body;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) fail(`${what}: no \`status=ok\` from /health within ${HEALTH_TIMEOUT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ------------------------------------------------------------ the two paths
//
// Each pilot uses ONE official path. What the two have in common is the shape
// of the answer: an artifact identity a registry can be asked about later, a
// deployment on the loopback, and the §9.1 credentials its first start printed.

const NPM_SPEC = /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-._~]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST_REF = /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._\/-]+@sha256:[0-9a-f]{64}$/;

function runCommand(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: "utf8", ...opts });
  if (r.error) fail(`${file} could not be run: ${r.error.message}`);
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/**
 * THE NPM PATH. The registry is asked what it holds BEFORE anything is
 * installed from it — a version that never arrived, or one whose bytes are not
 * the ones a record names, is a fact about the registry and is read from it.
 */
function npmArtifact(spec) {
  check(NPM_SPEC.test(spec), `--artifact must be \`@scope/name@version\` on the npm path, not \`${spec}\``);
  const viewed = runCommand("npm", ["view", spec, "dist.integrity", "version", "--json"], {
    shell: process.platform === "win32",
  });
  check(viewed.status === 0, `\`npm view ${spec}\` exited ${viewed.status} — the registry did not answer for it\n${viewed.err}`);
  const view = JSON.parse(viewed.out);
  const integrity = view["dist.integrity"] ?? view.dist?.integrity ?? null;
  check(typeof integrity === "string" && integrity.length > 0, `the registry reports no integrity for ${spec}`);
  return {
    reference: spec,
    kind: "npm-tarball",
    checksum: integrity,
    digest: null,
    version: view.version ?? spec.slice(spec.lastIndexOf("@") + 1),
  };
}

/** Install it into a prefix of its own, the way a user installs it. */
function npmInstall(spec, where) {
  const prefix = join(where, "prefix");
  const cache = join(where, "npm-cache");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const env = { ...process.env, npm_config_cache: cache, npm_config_prefix: prefix, npm_config_yes: "true" };
  const install = spawnSync("npm", ["install", "--global", "--prefix", prefix, spec], {
    encoding: "utf8",
    env,
    shell: process.platform === "win32",
  });
  check(
    install.status === 0,
    `the install of ${spec} exited ${install.status}\n${redact(`${install.stdout ?? ""}${install.stderr ?? ""}`)}`,
  );
  const launcher = [
    join(prefix, "lib", "node_modules", "@skillonomia", "cli", "bin", "skillonomia.js"),
    join(prefix, "node_modules", "@skillonomia", "cli", "bin", "skillonomia.js"),
  ].find((p) => existsSync(p));
  check(launcher !== undefined, "the install left no bin/skillonomia.js under the prefix it was given");
  return launcher;
}

/** THE CONTAINER PATH. A tag is a pointer; §7 pins the image by digest. */
function dockerArtifact(ref) {
  check(DIGEST_REF.test(ref), `--artifact must be \`<registry>/<image>@sha256:<64 hex>\` on the docker path, not \`${ref}\``);
  const digest = ref.slice(ref.indexOf("@") + 1);
  const pull = runCommand("docker", ["pull", ref]);
  check(pull.status === 0, `\`docker pull\` exited ${pull.status} — the image was not obtained\n${pull.err}`);
  const inspected = runCommand("docker", ["image", "inspect", ref, "--format", "{{json .RepoDigests}}"]);
  check(inspected.status === 0, `\`docker image inspect\` exited ${inspected.status}\n${inspected.err}`);
  const repoDigests = JSON.parse(inspected.out);
  check(
    repoDigests.some((d) => d.endsWith(`@${digest}`)),
    `the pulled image reports ${JSON.stringify(repoDigests)}, none of which is ${digest}`,
  );
  return { reference: ref, kind: "container-image", checksum: null, digest, version: null };
}

/**
 * Start the deployment and hand back its base URL, the §9.1 credentials and a
 * way to stop it. The publish is LOOPBACK-ONLY on both paths: this listener
 * speaks plain HTTP and prints two one-time credentials on its first start.
 */
async function startDeployment(path, artifact, where, port) {
  if (path === "docker") {
    const name = `skillonomia-pilot-${process.pid}`;
    const volume = `${name}-data`;
    const started = runCommand("docker", [
      "run", "-d", "--name", name,
      "-p", `127.0.0.1:${port}:7431`,
      "-v", `${volume}:/data`,
      artifact.reference,
    ]);
    check(started.status === 0, `\`docker run\` exited ${started.status}\n${started.err}`);
    const base = `http://127.0.0.1:${port}`;
    const stop = () => {
      runCommand("docker", ["rm", "-f", name]);
      runCommand("docker", ["volume", "rm", "-f", volume]);
    };
    let health;
    try {
      health = await waitForHealth(base, "the container");
    } catch (e) {
      stop();
      throw e;
    }
    return {
      base,
      health,
      readLog: () => {
        const r = runCommand("docker", ["logs", name]);
        return `${r.out}${r.err}`;
      },
      handle: { kind: "container", name, volume },
      stop,
    };
  }

  const launcher = npmInstall(artifact.reference, where);
  const dataDir = join(where, "data");
  // `detached` because §C keeps the pilot instance reachable for the owner's
  // read-back AFTER this process exits. A child in this process's group would
  // die with it and the record would name a URL nobody can reach.
  const child = spawn(process.execPath, [launcher, "serve"], {
    cwd: where,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SKILLONOMIA_DATA: dataDir, SKILLONOMIA_PORT: String(port) },
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  // A START THAT DIED IS NOT A DEPLOYMENT THAT IS SLOW. Without this, a port
  // already held by somebody else's instance answers `/health` while this one
  // exits on `EADDRINUSE`, and the run would go on to drive a deployment it
  // never started.
  let died = null;
  child.on("exit", (code, signal) => (died = `the installed \`serve\` exited ${code}/${signal}`));
  const base = `http://127.0.0.1:${port}`;
  // THE GROUP, NOT THE PROCESS. `bin/skillonomia.js` is a launcher: it spawns
  // the entry point as a child of its own and the LISTENER is that grandchild.
  // Signalling the pid this run holds kills the launcher and leaves the
  // listener holding the port, which is how a stopped pilot goes on answering.
  // `detached` above made the child a group leader so the group can be named.
  const stop = () => {
    try {
      if (process.platform === "win32") runCommand("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  let health;
  try {
    health = await waitForHealth(base, "the installed `serve`");
    check(died === null, `${died}, and ${base} was answered by something this run did not start:\n${redact(log)}`);
  } catch (e) {
    stop();
    throw e;
  }
  return {
    base,
    health,
    readLog: () => log,
    handle: { kind: "process", pid: child.pid },
    stop,
    release: () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    },
  };
}

/**
 * The §9.1 credentials, WAITED FOR RATHER THAN READ ONCE. A deployment answers
 * `/health` the moment it is listening and prints the first-start block a
 * moment later; a reader that looked at the log at the instant health answered
 * would find nothing there and blame the deployment for it.
 */
async function awaitCredentials(readLog, what) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const text = readLog();
    const token = (name) => new RegExp(`^${name}=(\\S+)$`, "m").exec(text)?.[1] ?? null;
    const bootstrap = token("BOOTSTRAP_OWNER_TOKEN");
    const adopter = token("DEMO_ADOPTER_TOKEN");
    if (bootstrap !== null && adopter !== null) {
      return {
        bootstrap: classify(bootstrap, "BOOTSTRAP_OWNER_TOKEN"),
        adopter: classify(adopter, "DEMO_ADOPTER_TOKEN"),
      };
    }
    check(
      Date.now() < deadline,
      `${what}: no §9.1 credentials were printed within 60 s — this deployment has been started before, and a ` +
        "pilot needs a data directory that never has",
    );
    await new Promise((r) => setTimeout(r, 200));
  }
}

// --------------------------------------------------------------- blockers
//
// A BLOCKER IS SOMETHING THAT WAS REPRODUCED, and this runner records no other
// kind. There is no `--blocker` option: a blocker enters a record only when
// this process observed the condition and then re-executed the probe that
// observes it, twice, with the same answer. §C's list is "only reproduced
// blockers", and a flag would make it "only claimed ones".

function probeShell() {
  const r = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" });
  return r.error === undefined && r.status === 0;
}

function reproduce(id, probe, symptom, mitigation) {
  const observations = [probe(), probe()];
  if (observations.some((ok) => ok)) return null;
  return { id, symptom, mitigation, probe: "sh -c 'exit 0'", reproduced_times: observations.length };
}

// ==========================================================================
// run
// ==========================================================================

function parseRun(argv) {
  const opts = {
    path: null, artifact: null, candidateSha: null, verificationBaseUrl: null,
    record: null, transcript: null, tokenFile: null, port: null, stopWhenDone: false, keep: false,
  };
  const named = {
    "--path": "path", "--artifact": "artifact", "--candidate-sha": "candidateSha",
    "--verification-base-url": "verificationBaseUrl", "--record": "record",
    "--transcript": "transcript", "--token-file": "tokenFile",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--stop-when-done") opts.stopWhenDone = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--port") {
      const v = argv[i + 1];
      if (v === undefined) usage("--port needs a value");
      if (!/^\d{1,5}$/.test(v)) usage(`--port is a TCP port, not \`${v}\``);
      opts.port = Number(v);
      i += 1;
    } else if (a in named) {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      opts[named[a]] = v;
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  for (const [flag, key] of Object.entries(named)) {
    if (opts[key] === null) usage(`\`run\` needs ${flag}`);
  }
  if (opts.path !== "npm" && opts.path !== "docker") usage("--path is `npm` or `docker` — §C gives each pilot one official path");
  if (!/^[0-9a-f]{40}$/.test(opts.candidateSha)) usage("--candidate-sha is the exact 40-hex commit the artifact was built from");
  if (!/^https?:\/\//.test(opts.verificationBaseUrl)) usage("--verification-base-url is an http(s) URL the owner can reach");
  for (const key of ["record", "transcript", "tokenFile"]) opts[key] = resolve(opts[key]);
  if (dirname(opts.record) !== dirname(opts.transcript)) {
    usage("--transcript is written beside --record: a record names its transcript by file name and never by machine path");
  }
  return opts;
}

const OS_NAME = { linux: "linux", darwin: "macos", win32: "windows" };

async function run(argv) {
  const opts = parseRun(argv);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const osName = OS_NAME[process.platform] ?? null;
  check(osName !== null, `${process.platform} is not one of the §4.2 platforms (linux, macos, windows)`);

  const steps = [];
  const record = (n, name, detail) => {
    steps.push({ n, name, ...redactDeep(detail) });
    console.log(`[${n}/9] ${name}`);
  };

  // This machine's own names, registered before anything can be written down.
  place(homedir(), "[home]");
  try {
    place(userInfo().username, "[user]");
  } catch {
    // a host with no resolvable user entry: nothing to hide, nothing to do
  }
  const where = mkdtempSync(join(tmpdir(), "skillonomia-pilot-"));
  place(where, "[install]");
  place(tmpdir(), "[tmp]");

  // ---- 1. the artifact, from where a user gets it
  const artifact = opts.path === "npm" ? npmArtifact(opts.artifact) : dockerArtifact(opts.artifact);
  record(1, "the artifact, identified at its registry", {
    path: opts.path,
    reference: artifact.reference,
    checksum: artifact.checksum,
    digest: artifact.digest,
    version: artifact.version,
  });

  // ---- 2/3. install and start, loopback-only
  //
  // THE PORT IS THE PILOT'S TO CHOOSE, because the owner's verification URL is
  // named before this run starts and something has to forward to it. Left
  // unnamed, this run picks a free one — which is the rehearsal case, where the
  // verification URL is the loopback itself.
  const port = opts.port ?? (await freePort());
  const deployment = await startDeployment(opts.path, artifact, where, port);
  const healthAtMs = Date.now();
  const healthHash = hashOf(deployment.health);
  record(2, "installed from that artifact and started", {
    published_on: `127.0.0.1:${port}`,
    instance: deployment.handle.kind,
  });
  record(3, "/health answered", {
    health: deployment.health,
    health_hash: healthHash,
    time_to_health_ms: healthAtMs - startedAtMs,
  });

  const { base } = deployment;
  let outcome;
  let credentials;
  try {
    // Inside the try, so that a deployment whose first start printed nothing is
    // STOPPED rather than left holding a port for the rest of the day.
    credentials = await awaitCredentials(deployment.readLog, `the ${deployment.handle.kind} on 127.0.0.1:${port}`);
    const owner = expect(
      await api(base, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: credentials.bootstrap }),
      200,
      "the §9.1 bootstrap exchange",
    );
    const ownerKey = classify(owner.api_key, "OWNER_API_KEY");
    const author = expect(
      await api(base, "POST", "/v1/principals", ownerKey, { name: "pilot-author", type: "agent", role: "member" }),
      201,
      "creating the author principal",
    );
    const authorKey = classify(author.api_key, "AUTHOR_API_KEY");
    const adopterKey = credentials.adopter;

    // ---- 4. create — the registry packs and signs the source this file carries
    const manifest = pilotManifest();
    const created = expect(
      await api(base, "POST", "/v1/skills/from-source", authorKey, {
        slug: SLUG,
        source: pilotSource(manifest).toString("base64"),
      }),
      201,
      "skill.create_from_dir",
    );
    const versionId = created.skill_version_id;
    const linted = expect(await api(base, "POST", `/v1/versions/${versionId}/lint`, authorKey, {}), 200, "skill.lint");
    check(linted.state === "linted", `the pilot package did not lint clean: ${redact(JSON.stringify(linted))}`);
    record(4, "created from source and linted", {
      slug: SLUG,
      skill_version_id: versionId,
      content_hash: created.content_hash,
      manifest_hash: created.manifest_hash,
      risk_level: manifest.scope.risk_level,
      gates: linted.reports.map((g) => `${g.gate}:${g.result}`),
    });

    // ---- 5. review
    expect(
      await api(base, "POST", `/v1/versions/${versionId}/reviews`, authorKey, { action: "request" }),
      200,
      "the review request",
    );
    const reviewed = expect(
      await api(base, "POST", `/v1/versions/${versionId}/reviews`, ownerKey, { action: "verdict", verdict: "approve" }),
      200,
      "the review verdict",
    );
    check(reviewed.state === "reviewed", `the package did not reach reviewed: ${redact(JSON.stringify(reviewed))}`);
    record(5, "reviewed", { skill_version_id: versionId, state: reviewed.state });

    // ---- 6. adopt, and run the package's own declared step
    const request = expect(
      await api(base, "POST", "/v1/adoptions/requests", adopterKey, { skill_version_id: versionId }),
      201,
      "the adoption request",
    );
    const receiptId = request.receipt_id;

    // WHAT THE DESCRIPTOR SAYS IS WHAT THIS HOST IS. A runner that declared the
    // values which would produce a `match` would be lying to the registry about
    // the machine it is standing on.
    const shell = probeShell();
    const descriptor = {
      runtime: { id: "node", version: process.versions.node.replace(/[^0-9.].*$/, "") },
      model: { id: "none", version: "0.0.0" },
      tools: shell ? [{ id: "shell", version: "1.0.0" }] : [],
      os: osName,
      shell: shell ? "sh" : process.platform === "win32" ? "powershell" : "none",
      sandbox_capable: false,
    };
    const adopted = expect(
      await api(base, "POST", `/v1/adoptions/${request.adoption_request_id}/adopt`, adopterKey, {
        environment_descriptor: descriptor,
      }),
      200,
      "the handover",
    );
    check(adopted.receipt_event === "delivered", `the handover recorded ${adopted.receipt_event}, not delivered`);
    const compat = { result: String(adopted.compat?.result), unmet: adopted.compat?.unmet ?? [] };

    // A BLOCKER STOPS THE RUN AND STILL LEAVES EVIDENCE. Without a shell the
    // package's own declared step cannot run, and a receipt reaching `adopted`
    // here would report a gate result no run produced. The record is written
    // with the reproduced blocker, the marker says blocked and the exit code is
    // not zero.
    const blocker = shell
      ? null
      : reproduce("posix-shell-missing", probeShell, "no POSIX shell answered on this host", "install a POSIX shell");
    if (blocker !== null) {
      outcome = {
        state: "blocked",
        marker: RUN_BLOCKED,
        blockers: [blocker],
        receipt: { id: receiptId, state: String(request.state), read_back_hash: null },
        skill: { slug: SLUG, version_id: versionId, content_hash: created.content_hash, risk_level: "low", compat },
        adoptedAtMs: null,
      };
      record(6, "blocked: the declared step has no interpreter here", { blocker, compat });
    } else {
      const work = join(where, "package");
      const delivered = readUstar(Buffer.from(adopted.package.archive_base64, "base64"));
      for (const [path, bytes] of delivered) {
        const target = join(work, path);
        check(resolve(target).startsWith(resolve(work)), `the delivered archive names a path outside the work directory: ${path}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      const deliveredManifest = JSON.parse(delivered.get("skill.json").toString("utf8"));
      const step = deliveredManifest.procedure.steps[0];
      check(
        deliveredManifest.procedure.steps.length === 1 && step.command === "sh fixtures/tv-pilot.sh",
        `the delivered package declares something other than the one pilot step: ${redact(JSON.stringify(deliveredManifest.procedure.steps))}`,
      );
      const ran = spawnSync("sh", [join(work, "fixtures", "tv-pilot.sh")], { cwd: work, encoding: "utf8" });
      check(ran.status === 0, `\`${step.command}\` exited ${ran.status}: ${redact(ran.stderr ?? "")}`);
      const observed = ran.stdout.trim();
      check(observed === step.expected, `\`${step.command}\` printed ${JSON.stringify(observed)}, not ${JSON.stringify(step.expected)}`);
      record(6, "adopted and the declared step ran", {
        adoption_request_id: request.adoption_request_id,
        receipt_id: receiptId,
        content_hash: adopted.package.content_hash,
        compat,
        command: step.command,
        exit_code: ran.status,
        stdout: observed,
      });

      // ---- 7. the adopter's claim
      expect(
        await api(base, "POST", `/v1/receipts/${receiptId}/events`, adopterKey, { event: "attempted" }),
        200,
        "the `attempted` event",
      );
      const terminal = expect(
        await api(base, "POST", `/v1/receipts/${receiptId}/events`, adopterKey, {
          event: "adopted",
          evidence: {
            gate_results: deliveredManifest.procedure.validation_gates.map((g) => ({ gate_id: g.gate_id, pass: true, observed })),
          },
        }),
        200,
        "the `adopted` event",
      );
      check(terminal.receipt_event === "adopted", `the chain recorded ${terminal.receipt_event}, not adopted`);
      const adoptedAtMs = Date.now();
      record(7, "adopter claim recorded", {
        receipt_id: receiptId,
        event: terminal.receipt_event,
        gate_results: deliveredManifest.procedure.validation_gates.map((g) => g.gate_id),
      });

      // ---- 8. the read-back, THROUGH THE URL THE OWNER WILL USE
      //
      // Not through the loopback this runner drove: the record names a URL the
      // owner reads the receipt back from until acceptance, and a URL nobody
      // checked is a URL that may answer for another deployment or for none.
      //
      // AND THE RECEIPT IS WHAT TIES THEM, not `/health`. `/health` reports a
      // status, a service name and a version, which every deployment of this
      // version reports alike; matching it says the URL serves this software at
      // this version and no more than that. The receipt id below exists on the
      // deployment this run drove and on no other, so it is the read-back —
      // here and in `verify` — that binds the URL to this run.
      const verifyBase = opts.verificationBaseUrl.replace(/\/+$/, "");
      const remoteHealth = await waitForHealth(verifyBase, "the verification URL");
      check(
        hashOf(remoteHealth) === healthHash,
        `the verification URL answers a different /health than the deployment this run drove (${hashOf(remoteHealth)} ≠ ${healthHash})`,
      );
      const readBack = expect(await api(verifyBase, "GET", `/v1/receipts/${receiptId}`, adopterKey), 200, "the receipt read-back");
      check(readBack.derived_state === "adopted", `the server reads this receipt back as ${readBack.derived_state}, not adopted`);
      const elapsed = adoptedAtMs - startedAtMs;
      check(elapsed < QUICKSTART_BUDGET_MS, `the pilot took ${elapsed} ms to reach adopted, and §7 budgets ${QUICKSTART_BUDGET_MS} ms`);
      record(8, "read back through the verification URL", {
        receipt_id: receiptId,
        derived_state: readBack.derived_state,
        events: readBack.events.map((e) => e.event),
        read_back_hash: hashOf(readBack),
      });
      outcome = {
        state: "adopted",
        marker: LOOPBACK_URL.test(verifyBase) ? RUN_STAGED : RUN_OK,
        blockers: [],
        receipt: { id: receiptId, state: readBack.derived_state, read_back_hash: hashOf(readBack) },
        skill: { slug: SLUG, version_id: versionId, content_hash: created.content_hash, risk_level: "low", compat },
        adoptedAtMs,
      };
    }
  } catch (e) {
    deployment.stop();
    if (!opts.keep) rmSync(where, { recursive: true, force: true });
    throw e;
  }

  // ---- 9. the artefacts: the credential, the transcript, the record
  const finishedAt = new Date().toISOString();
  const rehearsal = LOOPBACK_URL.test(opts.verificationBaseUrl);

  const transcript = redactDeep({
    transcript: "skillonomia-pilot",
    marker: outcome.marker,
    platform: { os: osName, arch: process.arch, node: process.versions.node },
    path: opts.path,
    artifact,
    candidate_sha: opts.candidateSha,
    verification_base_url: opts.verificationBaseUrl,
    started_at: startedAt,
    finished_at: finishedAt,
    steps,
    trust_boundary:
      "This transcript proves that an owner-controlled harness ran these commands against this artifact on this " +
      "host. The receipt is the server's record of the adopter's claim; neither witnesses the execution of the " +
      "text reported as `observed`.",
  });
  const transcriptText = `${JSON.stringify(transcript, null, 2)}\n`;
  scanForSecrets("the transcript", transcriptText);
  const transcriptHash = sha256(Buffer.from(transcriptText, "utf8"));

  const body = {
    record: "skillonomia-pilot",
    schema: TEMPLATE,
    marker: outcome.marker,
    outcome: outcome.state,
    rehearsal,
    platform: { os: osName, arch: process.arch, node: process.versions.node },
    path: opts.path,
    artifact,
    candidate_sha: opts.candidateSha,
    verification_base_url: opts.verificationBaseUrl,
    health: { body: deployment.health, hash: healthHash },
    timestamps: {
      started_at: startedAt,
      health_at: new Date(healthAtMs).toISOString(),
      adopted_at: outcome.adoptedAtMs === null ? null : new Date(outcome.adoptedAtMs).toISOString(),
      finished_at: finishedAt,
    },
    receipt: outcome.receipt,
    skill: outcome.skill,
    transcript: { file: basename(opts.transcript), hash: transcriptHash },
    time_to_first_adopted_ms: outcome.adoptedAtMs === null ? null : outcome.adoptedAtMs - startedAtMs,
    time_to_health_ms: healthAtMs - startedAtMs,
    blockers: outcome.blockers,
    instance_left_running: !opts.stopWhenDone,
    trust_boundary: transcript.trust_boundary,
  };
  const finished = { ...body, record_hash: hashOf(body) };
  const recordText = `${JSON.stringify(finished, null, 2)}\n`;
  scanForSecrets("the record", recordText);
  validateAgainstTemplate(finished, "the record this run produced");

  mkdirSync(dirname(opts.transcript), { recursive: true });
  writeFileSync(opts.transcript, transcriptText);
  mkdirSync(dirname(opts.record), { recursive: true });
  writeFileSync(opts.record, recordText);
  mkdirSync(dirname(opts.tokenFile), { recursive: true });
  writeFileSync(opts.tokenFile, `${credentials.adopter}\n`, { mode: 0o600 });
  try {
    chmodSync(opts.tokenFile, 0o600);
  } catch {
    // a filesystem with no POSIX mode: the file is still the only copy
  }
  console.log(`[9/9] record, transcript and token file written`);
  console.log(`      record     ${opts.record}`);
  console.log(`      transcript ${opts.transcript}  sha256 ${transcriptHash}`);
  console.log(`      token file ${opts.tokenFile}  (the read-back credential, and its only copy)`);

  if (opts.stopWhenDone) {
    deployment.stop();
    if (!opts.keep) rmSync(where, { recursive: true, force: true });
    console.log("      the deployment was stopped: the owner can no longer read this receipt back");
  } else {
    deployment.release?.();
    const how = deployment.handle.kind === "container"
      ? `docker rm -f ${deployment.handle.name} && docker volume rm -f ${deployment.handle.volume}`
      : process.platform === "win32"
        ? `taskkill /T /F /PID ${deployment.handle.pid}`
        : `kill -TERM -${deployment.handle.pid}   (the group: the listener is a child of that pid)`;
    console.log(`      the deployment is still running for the owner's read-back; stop it with: ${how}`);
  }

  if (outcome.state === "blocked") {
    console.log(RUN_BLOCKED);
    process.exitCode = 1;
    return;
  }
  if (rehearsal) {
    console.log("the owner's verification URL is this machine's loopback, so no external read-back was exercised.");
    console.log(RUN_STAGED);
  } else {
    console.log(RUN_OK);
  }
}

// ==========================================================================
// the template, and the little validator that reads it
// ==========================================================================

let templateCache = null;
function template() {
  if (templateCache === null) templateCache = JSON.parse(readFileSync(join(ROOT, TEMPLATE), "utf8"));
  return templateCache;
}

/**
 * The subset of JSON Schema `evidence/pilots/PILOT_TEMPLATE.json` is written
 * in — `type`, `required`, `properties`, `additionalProperties`, `enum`,
 * `pattern`, `items`, `const`. A pilot host has this file and Node, and adding
 * a validator dependency to the one script that must run on a stranger's
 * machine would be a prerequisite nobody agreed to.
 */
function validate(schema, value, path, errors) {
  const at = path === "" ? "the record" : path;
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types !== null) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const ok = types.some((t) => (t === "integer" ? Number.isInteger(value) : t === actual));
    if (!ok) {
      errors.push(`${at}: expected ${types.join(" or ")}, got ${actual}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((item, i) => validate(schema.items, item, `${at}[${i}]`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}: ${key} is missing`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(value)) {
      if (props[key] !== undefined) validate(props[key], sub, `${at === "the record" ? "" : `${at}.`}${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: ${key} is not a field of this schema`);
    }
  }
}

function validateAgainstTemplate(value, what) {
  const errors = [];
  validate(template(), value, "", errors);
  check(errors.length === 0, `${what} does not match ${TEMPLATE}:\n  ${errors.join("\n  ")}`);
}

// ==========================================================================
// verify
// ==========================================================================

/**
 * THE DEFERRAL IS ASKED FOR, NEVER INFERRED. A verifier that dropped the second
 * record because the second record was absent would turn every incomplete
 * invocation into a pass, which is the failure mode §C's marker exists to make
 * impossible. So `--windows-deferred` is a word the owner types, and it is
 * refused alongside a Windows record: a run that HAS the record is not a run
 * whose pilot was deferred, and one of the two statements would be false.
 */
const MACOS_FLAGS = { "--macos-record": "macosRecord", "--macos-token-file": "macosTokenFile" };
const WINDOWS_FLAGS = { "--windows-record": "windowsRecord", "--windows-token-file": "windowsTokenFile" };

function parseVerify(argv) {
  const opts = {
    online: false, windowsDeferred: false,
    macosRecord: null, macosTokenFile: null, windowsRecord: null, windowsTokenFile: null,
  };
  const named = { ...MACOS_FLAGS, ...WINDOWS_FLAGS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--online") opts.online = true;
    else if (a === "--windows-deferred") opts.windowsDeferred = true;
    else if (a in named) {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      opts[named[a]] = resolve(v);
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  for (const [flag, key] of Object.entries(MACOS_FLAGS)) {
    if (opts[key] === null) usage(`\`verify\` needs ${flag}`);
  }
  for (const [flag, key] of Object.entries(WINDOWS_FLAGS)) {
    if (opts.windowsDeferred) {
      if (opts[key] !== null) {
        usage(
          `${flag} was given with --windows-deferred — a deferred pilot produced no record, so a run that has one ` +
            "is not the case this flag describes",
        );
      }
    } else if (opts[key] === null) {
      usage(`\`verify\` needs ${flag}`);
    }
  }
  return opts;
}

/** Read a token file, and register what it holds so it cannot be printed. */
function readToken(file) {
  check(existsSync(file), `no token file at ${file} — the read-back credential travels in one, and nowhere else`);
  const token = readFileSync(file, "utf8").trim();
  check(token.length > 0, `the token file ${file} is empty`);
  return classify(token, "READ_BACK_TOKEN");
}

/**
 * ONE RECORD, AGAINST EVERYTHING THAT IS NOT IT. The transcript it names, the
 * registry the artifact came from, the live `/health` and the live receipt.
 * A field somebody retyped disagrees with one of them.
 */
async function verifyRecord(label, expectedOs, recordFile, tokenFile, online) {
  const notes = [];
  // EVERY DISAGREEMENT, NOT THE FIRST ONE. A record is refused if any check
  // fails, so stopping at the first would only decide which sentence a reviewer
  // reads — and a record that is from the wrong host AND names a transcript
  // that was edited has two things wrong with it, not one.
  const problems = [];
  const holds = (condition, message) => {
    if (!condition) problems.push(`${label}: ${message}`);
    return condition;
  };

  // The two that are fatal on their own: without a parsed record of the right
  // shape there are no fields for anything below to read.
  check(existsSync(recordFile), `no ${label} record at ${recordFile}`);
  const text = readFileSync(recordFile, "utf8");
  let record;
  try {
    record = JSON.parse(text);
  } catch (e) {
    fail(`${label}: ${recordFile} is not JSON (${String(e?.message ?? e)})`);
  }
  validateAgainstTemplate(record, `${label}: ${basename(recordFile)}`);

  // 1. no credential and no machine path anywhere in it
  try {
    scanForSecrets(`${label}: ${basename(recordFile)}`, text);
  } catch (e) {
    problems.push(e.message);
  }

  // 2. the record's own checksum. NOT A SIGNATURE — it catches an edit that did
  //    not also recompute it, and the checks below catch the ones that did.
  const { record_hash: claimed, ...body } = record;
  if (holds(hashOf(body) === claimed, `record_hash is ${claimed}, and this record hashes to ${hashOf(body)}`)) {
    notes.push(`record_hash ${claimed.slice(0, 16)}…`);
  }

  // 3. the platform this record claims, and the outcome it claims
  holds(record.platform.os === expectedOs, `this record is from ${record.platform.os}, not ${expectedOs}`);
  holds(record.outcome === "adopted", `the outcome is \`${record.outcome}\`, not adopted`);
  holds(record.receipt.state === "adopted", `the receipt state is \`${record.receipt.state}\`, not adopted`);

  // 4. the transcript, beside the record, by hash
  const transcriptFile = join(dirname(recordFile), record.transcript.file);
  if (holds(existsSync(transcriptFile), `the record names transcript ${record.transcript.file}, which is not beside it`)) {
    const transcriptText = readFileSync(transcriptFile, "utf8");
    try {
      scanForSecrets(`${label}: ${record.transcript.file}`, transcriptText);
    } catch (e) {
      problems.push(e.message);
    }
    const transcriptHash = sha256(Buffer.from(transcriptText, "utf8"));
    if (
      holds(
        transcriptHash === record.transcript.hash,
        `${record.transcript.file} hashes to ${transcriptHash}, and the record says ${record.transcript.hash}`,
      )
    ) {
      notes.push(`transcript ${transcriptHash.slice(0, 16)}…`);
    }
  }

  // 5. the artifact, re-read from the registry it came from
  if (record.path === "npm") {
    const viewed = runCommand("npm", ["view", record.artifact.reference, "dist.integrity", "version", "--json"], {
      shell: process.platform === "win32",
    });
    if (holds(viewed.status === 0, `\`npm view ${record.artifact.reference}\` exited ${viewed.status}`)) {
      const view = JSON.parse(viewed.out);
      const integrity = view["dist.integrity"] ?? view.dist?.integrity ?? null;
      if (
        holds(
          integrity === record.artifact.checksum,
          `the registry reports integrity ${integrity} and the record says ${record.artifact.checksum}`,
        )
      ) {
        notes.push(`npm ${record.artifact.reference}`);
      }
    }
  } else {
    const inspected = runCommand("docker", ["manifest", "inspect", record.artifact.reference]);
    if (
      holds(
        inspected.status === 0,
        `\`docker manifest inspect ${record.artifact.reference}\` exited ${inspected.status} — the image the record ` +
          `names could not be read back from its registry`,
      )
    ) {
      notes.push(`image ${record.artifact.digest.slice(0, 23)}…`);
    }
  }

  // 6/7. the live deployment: /health, then the receipt
  if (online) {
    const base = record.verification_base_url.replace(/\/+$/, "");
    try {
      const health = await waitForHealth(base, `the instance at ${base}`);
      holds(
        hashOf(health) === record.health.hash,
        `/health at ${base} hashes to ${hashOf(health)} and the record says ${record.health.hash}`,
      );
      const token = readToken(tokenFile);
      const readBack = expect(
        await api(base, "GET", `/v1/receipts/${record.receipt.id}`, token),
        200,
        "the receipt read-back",
      );
      holds(
        readBack.derived_state === "adopted",
        `the server reads receipt ${record.receipt.id} back as ${readBack.derived_state}, not adopted`,
      );
      if (
        holds(
          hashOf(readBack) === record.receipt.read_back_hash,
          `the receipt reads back as ${hashOf(readBack)} and the record says ${record.receipt.read_back_hash}`,
        )
      ) {
        notes.push(`live read-back ${record.receipt.id}`);
      }
    } catch (e) {
      problems.push(`${label}: ${e instanceof Failure ? e.message : redact(String(e?.message ?? e))}`);
    }
  }

  console.log(`      ${label}: ${record.platform.os}/${record.path} — ${notes.length === 0 ? "nothing held" : notes.join(", ")}`);
  check(problems.length === 0, `${problems.length} check(s) refused this record:\n  ${problems.join("\n  ")}`);
  return record;
}

async function verify(argv) {
  const opts = parseVerify(argv);

  // THE RECORDS THIS RUN ACTUALLY HAS, counted once and used for everything
  // below — the cross-check, the blocker list and the marker. The marker is
  // chosen from `verified.length` rather than from the flag, so `${PILOTS_OK}`
  // cannot be printed by a path that holds one record however it got there.
  console.log(
    opts.windowsDeferred
      ? "[1/3] the macOS record, its transcript and its artifact — the owner deferred the Windows pilot"
      : "[1/3] the two records, their transcripts and their artifacts",
  );
  const verified = [["macos", await verifyRecord("macos", "macos", opts.macosRecord, opts.macosTokenFile, opts.online)]];
  if (!opts.windowsDeferred) {
    verified.push(["windows", await verifyRecord("windows", "windows", opts.windowsRecord, opts.windowsTokenFile, opts.online)]);
  }

  console.log("[2/3] one candidate SHA, and one official path each");
  if (verified.length === 2) {
    const [[, macos], [, windows]] = verified;
    check(
      macos.candidate_sha === windows.candidate_sha,
      `the two pilots ran different candidates (${macos.candidate_sha} and ${windows.candidate_sha}) — a PASS is bound to one exact SHA`,
    );
    console.log(`      candidate ${macos.candidate_sha}`);
  } else {
    // A CROSS-CHECK OF ONE RECORD IS NOT A CROSS-CHECK. §C binds a PASS to one
    // SHA by making two pilots agree on it; with one record there is a SHA and
    // nothing that agrees with it, and printing the SHA without saying so would
    // read exactly like the two-record line above.
    console.log(`      candidate ${verified[0][1].candidate_sha}`);
    console.log("      one record, so this SHA was compared with nothing — the agreement §C asks for needs a second pilot");
  }

  console.log("[3/3] the blockers each run reproduced");
  for (const [label, record] of verified) {
    const list = record.blockers.map((b) => b.id);
    console.log(`      ${label}: ${list.length === 0 ? "none reproduced" : list.join(", ")}`);
  }
  if (opts.windowsDeferred) {
    console.log("      windows: no record, and therefore no blockers reproduced there — deferred, not clean");
  }

  const rehearsal = verified.some(([, record]) => record.rehearsal);
  if (!opts.online) {
    console.log("the live instances were NOT contacted: --online was not given.");
    console.log(PILOTS_REHEARSAL);
    return;
  }
  if (rehearsal) {
    console.log(
      "at least one record names this machine's loopback as the owner's verification URL, so no external read-back " +
        "was exercised.",
    );
    console.log(PILOTS_REHEARSAL);
    return;
  }
  if (verified.length === 2) {
    console.log(PILOTS_OK);
    return;
  }
  console.log(
    "the Windows pilot was deferred by the owner, so this run checked the one record §C's other participant did " +
      "not produce a partner for.",
  );
  console.log(PILOTS_DEFERRED);
}

// ==========================================================================
// main
// ==========================================================================

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(USAGE);
    process.exit(subcommand === undefined ? 2 : 0);
  }
  const SUBCOMMANDS = { run, verify };
  const chosen = SUBCOMMANDS[subcommand];
  if (chosen === undefined) usage(`unknown subcommand \`${subcommand}\` — one of ${Object.keys(SUBCOMMANDS).join(", ")}`);
  try {
    await chosen(rest);
  } catch (e) {
    console.error(`run-pilot: ${e instanceof Failure ? e.message : redact(String(e?.stack ?? e))}`);
    process.exitCode = 1;
  }
}
