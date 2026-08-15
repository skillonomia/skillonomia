#!/usr/bin/env node
// THE RELEASE-ARTIFACT CHECKS — one script, one subcommand per published thing.
//
//   node ci/mvp-release.mjs binary --tag v0.1.2         # the release path: download, then smoke
//   node ci/mvp-release.mjs binary --local              # the rehearsal: package, then smoke
//   node ci/mvp-release.mjs ghcr --digest <ref@sha256:> # pull one published image and drive it
//   node ci/mvp-release.mjs npm --package <tgz|spec>    # install as a consumer, with no Bun
//   node ci/mvp-release.mjs platform --package <tgz> --sha256 <hex>   # the qualification contract
//
// FOUR SUBCOMMANDS AND NOT FOUR SCRIPTS. §7 allows this project four new
// acceptance scripts before the pilots and two are already spent
// (`ci/high-risk-exercise.mjs`, this file). Each published thing needs its own
// checks and they share nearly all of their machinery — a free port, a `/health`
// wait, the credential capture, the restart on the same database, the receipt
// read-back — so they are subcommands here rather than three more files that
// would each grow their own answer to the same question.
//
// WHAT THEY HAVE IN COMMON. Every one of them takes the artifact from where a
// USER would get it (a release, a registry, a tarball), refuses to consult the
// build directory instead, drives the shipped `demo` subcommand to a terminal
// `adopted` receipt, restarts on the same SQLite file and reads the receipt back
// from the server afterwards. And every one of them prints a marker that says
// WHICH path was exercised: a rehearsal never prints an acceptance marker.
//
// `binary` is the Linux x86_64 release asset and nothing else. It packages the
// compiled binary with the runtime data it needs, writes the checksum file,
// TAKES THE ARCHIVE BACK from where a user would get it, and runs it OUTSIDE
// THIS CHECKOUT:
//
//   1. package  — `dist/skillonomia` plus `migrations/`, `schema/`, `seed/` and
//                 `LICENSE` into `skillonomia-linux-x86_64.tar.gz`;
//   2. checksum — `SHA256SUMS`, verified by `sha256sum -c` rather than by this
//                 script comparing a string it just computed to itself;
//   3. download — with `--tag`, the two files come from THE RELEASE over the
//                 network; the local build is not consulted;
//   4. smoke    — unpack into a temporary directory that is not under this
//                 repository, then `version`, `serve` and `/health`.
//
// WHY STEP 3 IS THE POINT. A binary that runs from `dist/` proves the compiler
// worked. It does not prove that what a user downloads is that binary, that the
// archive carries the migrations the server opens the database with, or that
// either one works with the checkout absent — and the checkout is the thing a
// release exists to remove. So the smoke runs on the UNPACKED ARCHIVE, in a
// directory outside this tree, and refuses if that directory is inside it.
//
// THE TWO MODES, AND WHY THE MARKER DIFFERS. `--tag` is the acceptance run and
// prints `RELEASE_BINARY_OK`. `--local` packages the same archive from this
// checkout and smokes it, but nothing was downloaded from anywhere, so it
// prints `RELEASE_BINARY_STAGED_OK` instead. A rehearsal that printed the
// acceptance marker would be a claim that the network path was exercised when
// it was not — the one thing a release check must not do.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The release asset, and the checksum file beside it. Named once, here. */
export const ARCHIVE = "skillonomia-linux-x86_64.tar.gz";
export const SUMS = "SHA256SUMS";

/** What the archive contains — the whole of it, checked as a set. */
export const MEMBERS = ["LICENSE", "migrations/", "schema/", "seed/", "skillonomia"];

const OK = "RELEASE_BINARY_OK";
const STAGED = "RELEASE_BINARY_STAGED_OK";
const GHCR_OK = "GHCR_SMOKE_OK";
const NPM_OK = "NPM_CLI_OK";
const NPM_STAGED = "NPM_CLI_STAGED_OK";
const PLATFORM_OK = "PLATFORM_QUALIFICATION_OK";
/** §7 performance budget: `/health` answers within this after a start. */
const HEALTH_TIMEOUT_MS = 120_000;
/** §7 performance budget: a clean quickstart reaches `adopted` within this. */
const QUICKSTART_BUDGET_MS = 600_000;

const USAGE = `usage:
  node ci/mvp-release.mjs binary --tag <tag>   download the release assets and smoke them outside this checkout
  node ci/mvp-release.mjs binary --local       package the assets from this checkout and smoke them the same way
  node ci/mvp-release.mjs ghcr --digest ghcr.io/<owner>/<image>@sha256:<64 hex>
                                               pull that exact image, run it loopback-only and drive the quickstart
  node ci/mvp-release.mjs npm --package <file.tgz|@scope/name@version>
                                               install it as a consumer with no Bun in PATH, then drive the quickstart
  node ci/mvp-release.mjs platform --package <file.tgz> --sha256 <hex>
                                               the OS-neutral qualification contract for one platform job

options:
  --out <dir>          binary: where the packaged assets are written (default: dist/release)
  --keep               do not remove the temporary directories that were created
  --expect-host <id>   ghcr: the host this job claims to be, as <platform>-<arch> (e.g. darwin-arm64)
  --record <file>      ghcr/platform: write the machine-readable record here
`;

function fail(message) {
  console.error(`ci/mvp-release.mjs: ${message}`);
  process.exit(1);
}

function usage(message) {
  console.error(`ci/mvp-release.mjs: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Credentials the server prints on a first start, removed from anything this
 * script echoes. The smoke starts a real instance, so its log carries the §9.1
 * tokens; a failing run must be readable without disclosing them.
 */
function redact(text) {
  return text.replace(/(BOOTSTRAP_OWNER_TOKEN|DEMO_ADOPTER_TOKEN)=\S+/g, "$1=[redacted]");
}

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: "utf8", ...opts });
  if (r.error) fail(`${file} could not be run: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`${file} ${args.join(" ")} exited ${r.status}\n${redact(`${r.stdout ?? ""}${r.stderr ?? ""}`)}`);
  }
  return r.stdout ?? "";
}

// ----------------------------------------------------------------- packaging

/**
 * The archive, byte-for-byte the same on two runs of the same commit.
 *
 * `tar` is asked for a sorted, owner-less, timestamp-less ustar stream and the
 * gzip wrapper is written by `node:zlib`, which stores no modification time —
 * between them nothing about the machine that packed the release ends up in the
 * file. `.github/workflows/ci.yml` already proves `build:binary` itself is
 * reproducible; this keeps the packaging step from undoing that.
 */
function packageAssets(outDir) {
  run("npm", ["run", "-s", "build:binary"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  const dist = join(ROOT, "dist");
  for (const member of ["skillonomia", "migrations", "schema", "seed"]) {
    if (!existsSync(join(dist, member))) fail(`build:binary left no dist/${member} — the archive would be incomplete`);
  }
  mkdirSync(outDir, { recursive: true });
  const tarPath = join(outDir, "skillonomia-linux-x86_64.tar");
  run("tar", [
    "--format=ustar", "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0",
    "-cf", tarPath,
    "-C", dist, "skillonomia", "migrations", "schema", "seed",
    "-C", ROOT, "LICENSE",
  ]);
  const archive = join(outDir, ARCHIVE);
  writeFileSync(archive, gzipSync(readFileSync(tarPath), { level: 9 }));
  rmSync(tarPath);
  writeFileSync(join(outDir, SUMS), `${sha256(readFileSync(archive))}  ${ARCHIVE}\n`);
  return outDir;
}

// ------------------------------------------------------------------ download

/** `owner/repo`, from the workflow's own environment or from the git remote. */
function repositorySlug() {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  const remote = spawnSync("git", ["-C", ROOT, "remote", "get-url", "origin"], { encoding: "utf8" });
  const url = remote.status === 0 ? remote.stdout.trim() : "";
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) fail("cannot tell which repository to download from: set GITHUB_REPOSITORY or add a github.com origin");
  return m[1];
}

async function fetchOrFail(url, what, headers = {}) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetch(url, {
    headers: {
      "user-agent": "skillonomia-mvp-release",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  if (!res.ok) fail(`${what}: ${url} answered ${res.status} ${res.statusText}`);
  return res;
}

/**
 * THE RELEASE PATH. The assets come from the release identified by `--tag` and
 * from nowhere else: a run that silently fell back to the local build would
 * smoke the file this machine just made and call it a release check.
 */
async function downloadAssets(tag, outDir) {
  const slug = repositorySlug();
  const release = await (
    await fetchOrFail(
      `https://api.github.com/repos/${slug}/releases/tags/${encodeURIComponent(tag)}`,
      `no release is tagged ${tag} in ${slug}`,
      { accept: "application/vnd.github+json" },
    )
  ).json();
  mkdirSync(outDir, { recursive: true });
  for (const name of [ARCHIVE, SUMS]) {
    const asset = (release.assets ?? []).find((a) => a.name === name);
    if (!asset) fail(`release ${tag} carries no asset named ${name}`);
    const body = await (
      await fetchOrFail(asset.url, `asset ${name} of ${tag}`, { accept: "application/octet-stream" })
    ).arrayBuffer();
    writeFileSync(join(outDir, name), Buffer.from(body));
  }
  return outDir;
}

// ------------------------------------------------------------ the assertions

/** `sha256sum -c`, the command the documents tell a user to run. */
function verifyChecksums(dir) {
  const out = run("sha256sum", ["-c", SUMS], { cwd: dir });
  process.stdout.write(out);
}

/** The archive's top-level members, as a set, against what a release carries. */
function verifyMembers(dir) {
  const listed = run("tar", ["-tzf", join(dir, ARCHIVE)]).split("\n").filter(Boolean);
  const top = [...new Set(listed.map((p) => (p.includes("/") ? `${p.slice(0, p.indexOf("/"))}/` : p)))].sort();
  const expected = [...MEMBERS].sort();
  if (top.join(" ") !== expected.join(" ")) {
    fail(`${ARCHIVE} contains [${top.join(", ")}]; a release carries [${expected.join(", ")}]`);
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function health(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") return body;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * THE SMOKE, OUTSIDE THE CHECKOUT. The unpack directory is refused if it is
 * inside this repository: a binary that finds `migrations/` because it happens
 * to be standing next to the sources has proved nothing about the archive.
 */
async function smoke(dir, keep) {
  const where = mkdtempSync(join(tmpdir(), "skillonomia-release-"));
  if (resolve(where).startsWith(`${ROOT}/`)) fail(`the unpack directory ${where} is inside this checkout`);
  try {
    run("tar", ["-xzf", join(dir, ARCHIVE), "-C", where]);
    const exe = join(where, "skillonomia");

    const version = run(exe, ["version"], { cwd: where }).trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) fail(`\`skillonomia version\` printed ${JSON.stringify(version)}`);
    console.log(`      version ${version}`);

    const port = await freePort();
    const child = spawn(exe, ["serve"], {
      cwd: where,
      env: { ...process.env, SKILLONOMIA_DATA: join(where, "data"), SKILLONOMIA_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (b) => (log += b));
    child.stderr.on("data", (b) => (log += b));
    const exited = once(child, "exit");

    const body = await health(port);
    if (body === null) {
      child.kill("SIGKILL");
      fail(`no \`status=ok\` from /health within ${HEALTH_TIMEOUT_MS / 1000}s\n${redact(log)}`);
    }
    console.log(`      /health ${JSON.stringify(body)}`);
    child.kill("SIGTERM");
    await exited;
    if (!/listening on/.test(log)) fail(`the unpacked server never announced a listener\n${redact(log)}`);
  } finally {
    if (keep) console.log(`      kept ${where}`);
    else rmSync(where, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- binary

async function binary(argv) {
  const opts = { tag: null, local: false, out: join(ROOT, "dist", "release"), keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--local") opts.local = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--tag" || a === "--out") {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      if (a === "--tag") opts.tag = v;
      else opts.out = resolve(v);
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  if (opts.tag !== null && opts.local) usage("--tag and --local are two different runs; pick one");
  if (opts.tag === null && !opts.local) usage("`binary` needs --tag <tag> or --local");

  if (opts.local) {
    console.log(`[1/4] packaging ${ARCHIVE} from this checkout`);
    packageAssets(opts.out);
  } else {
    console.log(`[1/4] downloading ${ARCHIVE} and ${SUMS} from release ${opts.tag}`);
    await downloadAssets(opts.tag, opts.out);
  }
  console.log(`[2/4] sha256sum -c ${SUMS}`);
  verifyChecksums(opts.out);
  console.log(`[3/4] the archive carries ${MEMBERS.join(", ")}`);
  verifyMembers(opts.out);
  console.log(`[4/4] version, serve and /health, unpacked outside this checkout`);
  await smoke(opts.out, opts.keep);

  if (opts.local) {
    console.log("the release download path was NOT exercised: nothing was fetched from a release.");
    console.log(STAGED);
  } else {
    console.log(OK);
  }
}

// ------------------------------------------------------- the shared machinery
//
// Everything below is used by `ghcr`, `npm` and `platform` alike: they differ in
// WHERE the artifact comes from and agree on what is done to it.

const sha256File = (path) => sha256(readFileSync(path));

/**
 * A PATH WITH NO BUN ON IT. §2 makes Bun the maintainer's build runtime and B2
 * makes it not the user's, and the difference is only checkable if a consumer
 * install is actually run somewhere Bun cannot be reached.
 *
 * The check is not "is Bun absent from this machine" — it is present on every
 * maintainer's machine and on the CI job that packs the tarball, so that
 * question would make the check unrunnable exactly where it matters. Instead
 * the consumer environment is CONSTRUCTED: every directory holding a `bun`
 * executable is removed from PATH, and the result is then asked to resolve
 * `bun` and required to fail. A consumer step that ran with Bun still reachable
 * would prove nothing about a user who has never installed it.
 */
function bunFreePath(where) {
  const sep = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
  const kept = [];
  let shadows = 0;
  for (const dir of (process.env.PATH ?? "").split(sep).filter((d) => d.length > 0)) {
    if (!names.some((n) => existsSync(join(dir, n)))) {
      kept.push(dir);
      continue;
    }
    // Bun shares a directory with node and npm on most machines, so dropping
    // the directory would remove the runtime this check needs along with the
    // one it is removing. The directory is SHADOWED instead: a temporary
    // directory of links to everything in it except bun.
    const others = readdirSync(dir).filter((e) => !names.includes(e));
    if (others.length === 0) continue;
    if (process.platform === "win32") {
      fail(`${dir} holds bun alongside other executables; remove bun from PATH before running the consumer check`);
    }
    const shadow = join(where, `path-${shadows++}`);
    mkdirSync(shadow, { recursive: true });
    for (const entry of others) {
      try {
        symlinkSync(join(dir, entry), join(shadow, entry));
      } catch {
        // a name that cannot be linked is a name this consumer will not have
      }
    }
    kept.push(shadow);
  }
  return kept.join(sep);
}

/** Is `name` runnable under `path`? Used to PROVE bun is gone, not to find it. */
function resolvesUnder(name, path) {
  const probe = spawnSync(name, ["--version"], { env: { ...process.env, PATH: path }, stdio: "ignore" });
  return probe.error === undefined;
}

/**
 * Start a long-running command, collect everything it prints, and wait for
 * `/health`. Returns the §9.1 credentials when this was a first start and null
 * when it was not — which is the whole assertion the restart step makes.
 */
async function startAndWait(file, args, opts, port, what) {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  let died = null;
  child.on("exit", (code, signal) => (died = `${what} exited ${code}/${signal}`));

  const body = await health(port);
  if (body === null) {
    child.kill("SIGKILL");
    fail(`${what}: no \`status=ok\` from /health within ${HEALTH_TIMEOUT_MS / 1000}s${died ? ` (${died})` : ""}\n${redact(log)}`);
  }
  const token = (name) => new RegExp(`^${name}=(\\S+)$`, "m").exec(log)?.[1] ?? null;
  const credentials =
    token("BOOTSTRAP_OWNER_TOKEN") === null
      ? null
      : { bootstrap: token("BOOTSTRAP_OWNER_TOKEN"), adopter: token("DEMO_ADOPTER_TOKEN") };
  return {
    health: body,
    credentials,
    log: () => log,
    stop: async () => {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 10_000))]);
      child.kill("SIGKILL");
    },
  };
}

/** The receipt, from the server, after everything else has happened. */
async function readReceipt(base, receiptId, key) {
  const res = await fetch(`${base}/v1/receipts/${receiptId}`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) fail(`the receipt read-back answered ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.derived_state !== "adopted") {
    fail(`the server reads receipt ${receiptId} back as ${body.derived_state}, not adopted`);
  }
  return body;
}

/**
 * The shipped `demo` subcommand, driven against a running deployment. The
 * tokens go in the ENVIRONMENT: an argument is visible in `ps` to every other
 * user of the machine and these two mint an owner key.
 */
function runDemoAgainst(cli, base, credentials, budgetMs = QUICKSTART_BUDGET_MS) {
  const started = Date.now();
  const r = spawnSync(cli.file, [...cli.args, "demo", "--base-url", base, "--json"], {
    encoding: "utf8",
    shell: cli.shell === true,
    timeout: budgetMs,
    env: {
      ...process.env,
      PATH: cli.path ?? process.env.PATH,
      SKILLONOMIA_BOOTSTRAP_TOKEN: credentials.bootstrap,
      SKILLONOMIA_ADOPTER_TOKEN: credentials.adopter,
    },
  });
  const elapsed = Date.now() - started;
  if (r.error) fail(`\`skillonomia demo\` could not be run: ${r.error.message}`);
  if (r.status !== 0) fail(`\`skillonomia demo\` exited ${r.status}\n${redact(`${r.stdout ?? ""}${r.stderr ?? ""}`)}`);
  let result;
  try {
    result = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    fail(`\`skillonomia demo --json\` did not answer with JSON:\n${redact(r.stdout)}`);
  }
  if (result.derived_state !== "adopted") fail(`the quickstart ended at ${result.derived_state}, not adopted`);
  if (elapsed >= budgetMs) fail(`the quickstart took ${elapsed} ms, and §7 budgets ${budgetMs} ms`);
  console.log(`      quickstart: receipt ${result.receipt_id} adopted in ${(elapsed / 1000).toFixed(1)}s (§4.2 ${result.compat.result})`);
  return { ...result, elapsed_ms: elapsed };
}

/** A free port, and the §9.1 loopback base URL on it. */
async function loopback() {
  const port = await freePort();
  return { port, base: `http://127.0.0.1:${port}` };
}

// --------------------------------------------------------- the archive vectors
//
// A raw ustar writer, because these members are exactly the ones src/archive.ts
// refuses to WRITE: a vector built with the shipped writer could only ever be a
// well-formed archive.

export function ustar(members) {
  const blocks = [];
  for (const [name, body] of members) {
    const header = Buffer.alloc(512);
    Buffer.from(name, "utf8").copy(header, 0, 0, Math.min(100, Buffer.byteLength(name, "utf8")));
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148); // checksum field, blank while it is computed
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/**
 * The §4.1b vectors every qualification job runs through the INSTALLED CLI:
 * traversal, an absolute member, a Windows drive-letter member, a member name
 * that is not NFC, and a case-fold collision. Each one must come back
 * `MALFORMED_ARCHIVE` — on every filesystem, because these names come out of
 * the archive and never touch the host's directory entries.
 */
export const ARCHIVE_VECTORS = [
  ["traversal", [["../escape.md", Buffer.from("x")]]],
  ["absolute", [["/etc/skillonomia", Buffer.from("x")]]],
  ["drive-letter", [["C:\\skillonomia", Buffer.from("x")]]],
  ["unicode-not-nfc", [["café".normalize("NFD"), Buffer.from("x")]]],
  ["case-collision", [["SKILL.md", Buffer.from("a")], ["skill.MD", Buffer.from("b")]]],
];

function checkArchiveVectors(cli, dbPath, where) {
  for (const [name, members] of ARCHIVE_VECTORS) {
    const file = join(where, `vector-${name}.tar`);
    writeFileSync(file, ustar(members));
    const r = spawnSync(cli.file, [...cli.args, "verify", file, "--db", dbPath, "--json"], {
      encoding: "utf8",
      shell: cli.shell === true,
      env: { ...process.env, PATH: cli.path ?? process.env.PATH },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status !== 1) fail(`the ${name} vector exited ${r.status}; a refused archive is exit 1\n${redact(out)}`);
    if (!out.includes("MALFORMED_ARCHIVE")) {
      fail(`the ${name} vector was not refused as MALFORMED_ARCHIVE:\n${redact(out)}`);
    }
  }
  console.log(`      §4.1b vectors refused: ${ARCHIVE_VECTORS.map(([n]) => n).join(", ")}`);
}

// ---------------------------------------------------------------------- ghcr

/** `<host>/<path>@sha256:<64 hex>` and nothing else. */
const DIGEST_REF = /^[a-z0-9][a-z0-9.\-_/]*(?::[0-9]+)?\/[a-z0-9][a-z0-9.\-_/]*@sha256:[0-9a-f]{64}$/;

function docker(args, opts = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", ...opts });
  if (r.error) fail(`docker could not be run: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` };
}

function dockerOrFail(args, what) {
  const r = docker(args);
  if (r.status !== 0) fail(`${what}: \`docker ${args.join(" ")}\` exited ${r.status}\n${redact(r.out + r.err)}`);
  return r.out.trim();
}

/**
 * THE RUNTIME THIS JOB CLAIMS TO BE. This check is written for ONE digest on a
 * real Docker runtime, of which THE CLAIMED ONE IS LINUX. The macOS arm64 and
 * Windows x86_64 lanes are DEFERRED BY OWNER — Docker Desktop is not being
 * installed on either host — so `qualify-docker-macos` and
 * `qualify-docker-windows` stay in the workflow unrun, and no container result
 * exists or is claimed for either. The mechanism below is unchanged and stays
 * correct for the day the deferral is lifted: the two non-Linux lanes would
 * need a Docker Desktop host running LINUX CONTAINERS.
 *
 * A hosted GitHub runner is not that. `macos-14` has no Docker daemon at all,
 * and `windows-latest` has one in WINDOWS-CONTAINER mode, which cannot run this
 * image. Both would fail somewhere later with a message about a pull or a
 * socket, and a job that fails for an unclear reason invites being marked
 * `continue-on-error` — so the refusal happens HERE, first, and says exactly
 * which of the three facts about this host is not the claimed one. Without it
 * `qualify-docker-macos` could be pointed at a hosted runner and would look
 * like a macOS result for as long as nobody read the log.
 */
function requireHost(expected) {
  const actual = `${process.platform}-${process.arch}`;
  if (expected !== null && expected !== actual) {
    fail(
      `--expect-host ${expected}, but this process is running on ${actual}. This job's whole content is that ONE ` +
        `digest ran on ${expected}; on any other host it proves nothing and must not report success.`,
    );
  }
  const version = docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}"]);
  if (version.status !== 0) {
    fail(
      `no Docker daemon answered on this host (${actual}): ${redact(version.err.trim() || version.out.trim())}. ` +
        "A qualification job for a Docker runtime cannot be run without one — a hosted runner with no Docker " +
        "Desktop is not a substitute.",
    );
  }
  const osType = dockerOrFail(["info", "--format", "{{.OSType}}"], "reading the daemon's container type");
  if (osType !== "linux") {
    fail(
      `this Docker daemon runs ${osType} containers, and this image is a Linux container. Switch Docker Desktop to ` +
        "Linux containers; a Windows-container daemon cannot run it, and a job that stopped here is the honest result.",
    );
  }
  return { host: actual, docker: version.out.trim(), container_os: osType };
}

async function ghcr(argv) {
  const opts = { digest: null, expectHost: null, record: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--keep") opts.keep = true;
    else if (a === "--digest" || a === "--expect-host" || a === "--record") {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      if (a === "--digest") opts.digest = v;
      else if (a === "--expect-host") opts.expectHost = v;
      else opts.record = resolve(v);
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  if (opts.digest === null) usage("`ghcr` needs --digest <ref>@sha256:<64 hex>");
  // A TAG IS NOT AN IMAGE. `:latest` is a pointer that can be moved after this
  // check passes, so what was smoked and what a user pulls would be two
  // different things with one name. §7 pins the container by immutable digest.
  if (!DIGEST_REF.test(opts.digest)) {
    usage(`--digest must be an immutable reference \`<registry>/<image>@sha256:<64 hex>\`, not \`${opts.digest}\``);
  }
  const digest = opts.digest.slice(opts.digest.indexOf("@") + 1);

  console.log(`[1/7] this host is what this job claims it is`);
  const runtime = requireHost(opts.expectHost);
  console.log(`      ${runtime.host}, docker ${runtime.docker}, ${runtime.container_os} containers`);

  console.log(`[2/7] docker pull ${opts.digest}`);
  dockerOrFail(["pull", opts.digest], "pulling the published image");

  // THE READ-BACK: what the local daemon now holds must be named by the digest
  // that was asked for. `docker pull` resolves the reference itself, so this is
  // the step that ties the running container to the published bytes.
  const repoDigests = JSON.parse(dockerOrFail(["image", "inspect", opts.digest, "--format", "{{json .RepoDigests}}"], "inspecting the pulled image"));
  if (!repoDigests.some((d) => d.endsWith(`@${digest}`))) {
    fail(`the pulled image reports RepoDigests ${JSON.stringify(repoDigests)}, none of which is ${digest}`);
  }
  const imageId = dockerOrFail(["image", "inspect", opts.digest, "--format", "{{.Id}}"], "reading the image id");
  console.log(`      RepoDigest confirmed: ${digest}`);

  const name = `skillonomia-ghcr-${process.pid}`;
  const volume = `${name}-data`;
  const { port, base } = await loopback();
  const cli = { file: process.execPath, args: [join(ROOT, "bin", "skillonomia.js")] };
  const cleanup = () => {
    docker(["rm", "-f", name]);
    if (!opts.keep) docker(["volume", "rm", "-f", volume]);
  };
  let record;
  try {
    // THE PUBLISH IS LOOPBACK-ONLY, and that is part of what is being checked.
    // This listener speaks plain HTTP and prints two one-time credentials on
    // its first start; a publish naming no host address puts both on every
    // interface the machine has.
    console.log(`[3/7] docker run -p 127.0.0.1:${port}:7431 -v ${volume}:/data`);
    dockerOrFail(["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:7431`, "-v", `${volume}:/data`, opts.digest], "starting the container");
    const first = await health(port);
    if (first === null) fail(`no \`status=ok\` from /health within ${HEALTH_TIMEOUT_MS / 1000}s\n${redact(docker(["logs", name]).out + docker(["logs", name]).err)}`);
    console.log(`      /health ${JSON.stringify(first)}`);

    const logs = docker(["logs", name]);
    const all = `${logs.out}${logs.err}`;
    const token = (n) => new RegExp(`^${n}=(\\S+)$`, "m").exec(all)?.[1] ?? null;
    const credentials = { bootstrap: token("BOOTSTRAP_OWNER_TOKEN"), adopter: token("DEMO_ADOPTER_TOKEN") };
    if (credentials.bootstrap === null || credentials.adopter === null) {
      fail("the container's first start printed no §9.1 credentials — there is nothing to drive the quickstart with");
    }

    console.log(`[4/7] the quickstart, against the published image`);
    const demo = runDemoAgainst(cli, base, credentials);

    // THE RESTART, ON THE SAME VOLUME. A container is disposable and the volume
    // is not: this is where "the data survived" is either true or is a sentence
    // in a document. A second first-start would print two new credentials and
    // mean the old database was not opened.
    console.log(`[5/7] restart on the same volume`);
    dockerOrFail(["rm", "-f", name], "removing the container");
    dockerOrFail(["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:7431`, "-v", `${volume}:/data`, opts.digest], "restarting the container");
    const second = await health(port);
    if (second === null) fail("the restarted container never answered /health");
    const restartLogs = docker(["logs", name]);
    const restarted = `${restartLogs.out}${restartLogs.err}`;
    for (const secret of ["BOOTSTRAP_OWNER_TOKEN=", "DEMO_ADOPTER_TOKEN="]) {
      if (restarted.includes(secret)) fail(`the restart printed ${secret} again, so it did not re-open the same deployment`);
    }
    console.log(`      /health ${JSON.stringify(second)}, and no credential was printed twice`);

    console.log(`[6/7] receipt read-back, after the restart`);
    const receipt = await readReceipt(base, demo.receipt_id, credentials.adopter);
    console.log(`      receipt ${receipt.receipt_id}: ${receipt.derived_state}`);

    record = {
      check: "ghcr",
      marker: GHCR_OK,
      image: opts.digest,
      digest,
      image_id: imageId,
      host: runtime.host,
      docker: runtime.docker,
      container_os: runtime.container_os,
      health: second,
      receipt_id: receipt.receipt_id,
      receipt_state: receipt.derived_state,
      compat: demo.compat,
      quickstart_ms: demo.elapsed_ms,
      published_port: `127.0.0.1:${port}`,
    };
  } finally {
    cleanup();
  }

  console.log(`[7/7] the record`);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (opts.record !== null) {
    mkdirSync(dirname(opts.record), { recursive: true });
    writeFileSync(opts.record, serialized);
    console.log(`      written: ${opts.record}`);
  }
  process.stdout.write(serialized);
  console.log(GHCR_OK);
}

// ------------------------------------------------------------ consumer install

/**
 * Install a package into a PREFIX OF ITS OWN, with no Bun on PATH, and hand
 * back the two ways to invoke what was installed: the shim npm wrote (which is
 * what a user types) and the launcher inside the installed tree (which is what
 * a long-running child is spawned as, so that no shell stands between this
 * script and the process it has to signal).
 */
function consumerInstall(spec, where) {
  const prefix = join(where, "prefix");
  const cache = join(where, "npm-cache");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const path = bunFreePath(where);
  if (resolvesUnder("bun", path)) {
    fail("bun is still reachable after every directory holding it was removed from PATH — the consumer check would be a claim, not a check");
  }
  console.log(`      bun is not on the consumer PATH (${resolvesUnder("bun", process.env.PATH ?? "") ? "it is on this machine's" : "nor on this machine's"})`);

  const env = { ...process.env, PATH: path, npm_config_cache: cache, npm_config_prefix: prefix, npm_config_yes: "true" };
  const install = spawnSync("npm", ["install", "--global", "--prefix", prefix, spec], { encoding: "utf8", env, shell: process.platform === "win32" });
  if (install.status !== 0) {
    fail(`the consumer install of ${spec} exited ${install.status}\n${redact(`${install.stdout ?? ""}${install.stderr ?? ""}`)}`);
  }

  const shimName = process.platform === "win32" ? "skillonomia.cmd" : join("bin", "skillonomia");
  const shim = join(prefix, shimName);
  if (!existsSync(shim)) fail(`the install left no \`skillonomia\` executable at ${shim}`);
  // npm's global layout: `<prefix>/lib/node_modules` on POSIX, `<prefix>/node_modules` on Windows.
  const launcher = [
    join(prefix, "lib", "node_modules", "@skillonomia", "cli", "bin", "skillonomia.js"),
    join(prefix, "node_modules", "@skillonomia", "cli", "bin", "skillonomia.js"),
  ].find((p) => existsSync(p));
  if (launcher === undefined) fail(`the install left no bin/skillonomia.js under ${prefix}`);

  return {
    prefix,
    path,
    /** what a user types — a shim, so on Windows it needs a shell */
    shim: { file: shim, args: [], shell: process.platform === "win32", path },
    /** the same package, spawned without a shell in between */
    cli: { file: process.execPath, args: [launcher], path },
  };
}

/**
 * The contract every consumer install must satisfy, wherever it came from:
 * `version`, `serve`, `/health`, the quickstart to a terminal receipt, a restart
 * on the same SQLite file that mints no second credential, and a receipt
 * read-back afterwards. `extra` runs while the deployment is up.
 */
async function consumerContract(installed, where, expectedVersion, extra) {
  const shimVersion = spawnSync(installed.shim.file, ["version"], {
    encoding: "utf8",
    shell: installed.shim.shell,
    env: { ...process.env, PATH: installed.path },
  });
  if (shimVersion.status !== 0) fail(`the installed \`skillonomia version\` exited ${shimVersion.status}\n${redact(shimVersion.stderr ?? "")}`);
  const version = shimVersion.stdout.trim().split("\n").pop().trim();
  if (expectedVersion !== null && version !== expectedVersion) {
    fail(`the installed package reports version ${version}, and the tarball says ${expectedVersion}`);
  }
  console.log(`      version ${version}`);

  const dataDir = join(where, "data");
  const { port, base } = await loopback();
  const env = { ...process.env, PATH: installed.path, SKILLONOMIA_DATA: dataDir, SKILLONOMIA_PORT: String(port) };
  const first = await startAndWait(installed.cli.file, [...installed.cli.args, "serve"], { cwd: where, env }, port, "the installed `serve`");
  let demo;
  let receipt;
  try {
    if (first.credentials === null) fail("the first start of a fresh data directory printed no §9.1 credentials");
    console.log(`      /health ${JSON.stringify(first.health)}`);
    demo = runDemoAgainst(installed.cli, base, first.credentials);
    if (extra !== undefined) await extra({ installed, base, dataDir, where, credentials: first.credentials });
  } finally {
    await first.stop();
  }

  // THE RESTART, ON THE SAME SQLITE FILE.
  const second = await startAndWait(installed.cli.file, [...installed.cli.args, "serve"], { cwd: where, env }, port, "the restarted `serve`");
  try {
    if (second.credentials !== null) {
      fail("the restart printed the §9.1 credentials again, so it did not re-open the same database");
    }
    console.log(`      restarted on the same SQLite file, and no credential was printed twice`);
    receipt = await readReceipt(base, demo.receipt_id, first.credentials.adopter);
    console.log(`      receipt ${receipt.receipt_id}: ${receipt.derived_state}`);
  } finally {
    await second.stop();
  }
  return { version, demo, receipt, dataDir, base };
}

/** The version a tarball declares, read out of the tarball itself. */
function tarballVersion(file) {
  const listed = run("tar", ["-xzOf", file, "package/package.json"]);
  return JSON.parse(listed).version;
}

// ----------------------------------------------------------------------- npm

async function npmCli(argv) {
  const opts = { pkg: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--keep") opts.keep = true;
    else if (a === "--package") {
      const v = argv[i + 1];
      if (v === undefined) usage("--package needs a value");
      opts.pkg = v;
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  if (opts.pkg === null) usage("`npm` needs --package <file.tgz|@scope/name@version>");

  const local = opts.pkg.endsWith(".tgz");
  const spec = local ? resolve(opts.pkg) : opts.pkg;
  if (local && !existsSync(spec)) fail(`no such tarball: ${spec}`);

  let expectedVersion = null;
  if (local) {
    expectedVersion = tarballVersion(spec);
    console.log(`[1/4] the tarball ${basename(spec)} (version ${expectedVersion}, sha256 ${sha256File(spec)})`);
  } else {
    // THE REGISTRY READ-BACK. What the registry says it has, before anything is
    // installed from it: a publish that uploaded different bytes, or a version
    // that never arrived, is a fact about the registry and is read from it.
    console.log(`[1/4] npm view ${spec}`);
    const viewed = run("npm", ["view", spec, "dist.integrity", "version", "--json"], { encoding: "utf8" });
    const view = JSON.parse(viewed);
    expectedVersion = view.version ?? spec.slice(spec.lastIndexOf("@") + 1);
    console.log(`      registry: version ${expectedVersion}, integrity ${view["dist.integrity"] ?? view.dist?.integrity ?? "(none reported)"}`);
  }

  const where = mkdtempSync(join(tmpdir(), "skillonomia-npm-"));
  if (resolve(where).startsWith(`${ROOT}/`)) fail(`the consumer prefix ${where} is inside this checkout`);
  try {
    console.log(`[2/4] a clean npm prefix, with no bun on PATH`);
    const installed = consumerInstall(spec, where);
    console.log(`[3/4] version, serve, /health, demo, restart, receipt read-back`);
    await consumerContract(installed, where, expectedVersion, undefined);
    console.log(`[4/4] done`);
  } finally {
    if (opts.keep) console.log(`      kept ${where}`);
    else rmSync(where, { recursive: true, force: true });
  }

  if (local) {
    console.log("the registry path was NOT exercised: nothing was installed from a registry.");
    console.log(NPM_STAGED);
  } else {
    console.log(NPM_OK);
  }
}

// ------------------------------------------------------------------- platform

/**
 * THE QUALIFICATION CONTRACT, once, on whichever OS this is running on.
 *
 * It takes the tarball the `package-build` job made and its checksum, and NEVER
 * builds one: a platform job that packed its own package would be qualifying its
 * own build environment (and would need Bun to do it), not the artifact the
 * other platform jobs are given. The checksum is what makes "the same tarball"
 * checkable rather than asserted by the workflow's own wiring.
 */
async function platform(argv) {
  const opts = { pkg: null, sha256: null, record: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--keep") opts.keep = true;
    else if (a === "--package" || a === "--sha256" || a === "--record") {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      if (a === "--package") opts.pkg = resolve(v);
      else if (a === "--sha256") opts.sha256 = v.trim().toLowerCase();
      else opts.record = resolve(v);
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  if (opts.pkg === null) usage("`platform` needs --package <file.tgz>");
  if (opts.sha256 === null) usage("`platform` needs --sha256 <hex> — the checksum the package-build job recorded");
  if (!existsSync(opts.pkg)) fail(`no such tarball: ${opts.pkg}`);

  console.log(`[1/5] the tarball this job was given is the one that was built`);
  const actual = sha256File(opts.pkg);
  if (actual !== opts.sha256) {
    fail(`${basename(opts.pkg)} hashes to ${actual}, and the package-build job recorded ${opts.sha256}`);
  }
  const expectedVersion = tarballVersion(opts.pkg);
  console.log(`      sha256 ${actual} — version ${expectedVersion}`);

  const where = mkdtempSync(join(tmpdir(), "skillonomia-platform-"));
  let result;
  try {
    console.log(`[2/5] a clean consumer install, with no bun on PATH`);
    const installed = consumerInstall(opts.pkg, where);
    console.log(`[3/5] version, serve, /health, demo <${QUICKSTART_BUDGET_MS / 1000}s, restart, receipt read-back`);
    result = await consumerContract(installed, where, expectedVersion, async ({ dataDir }) => {
      console.log(`[4/5] the §4.1b archive vectors, through the installed CLI`);
      checkArchiveVectors(installed.cli, join(dataDir, "skillonomia.db"), where);
    });
  } finally {
    if (opts.keep) console.log(`      kept ${where}`);
    else rmSync(where, { recursive: true, force: true });
  }

  const record = {
    check: "platform",
    marker: PLATFORM_OK,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    package: basename(opts.pkg),
    sha256: actual,
    version: result.version,
    receipt_id: result.receipt.receipt_id,
    receipt_state: result.receipt.derived_state,
    compat: result.demo.compat,
    quickstart_ms: result.demo.elapsed_ms,
    archive_vectors: ARCHIVE_VECTORS.map(([n]) => n),
  };
  console.log(`[5/5] the record`);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (opts.record !== null) {
    mkdirSync(dirname(opts.record), { recursive: true });
    writeFileSync(opts.record, serialized);
    console.log(`      written: ${opts.record}`);
  }
  process.stdout.write(serialized);
  console.log(PLATFORM_OK);
}

// --------------------------------------------------------------------- main

// RUN ONLY WHEN RUN. `ci/windows-security.ps1` imports `ustar` and
// `ARCHIVE_VECTORS` from this file so that the §4.1b vectors have ONE
// definition rather than one per checker; without this guard an import would
// also execute the dispatcher and exit.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(USAGE);
    process.exit(subcommand === undefined ? 2 : 0);
  }
  const SUBCOMMANDS = { binary, ghcr, npm: npmCli, platform };
  const chosen = SUBCOMMANDS[subcommand];
  if (chosen === undefined) usage(`unknown subcommand \`${subcommand}\` — one of ${Object.keys(SUBCOMMANDS).join(", ")}`);
  await chosen(rest);
}
