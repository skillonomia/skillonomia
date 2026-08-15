#!/usr/bin/env node
// THE RELEASE-ARTIFACT CHECKS — one script, one subcommand per published thing.
//
//   node ci/mvp-release.mjs binary --tag v0.1.4         # the release path: download, then smoke
//   node ci/mvp-release.mjs binary --local              # the rehearsal: package, then smoke
//   node ci/mvp-release.mjs ghcr --digest <ref@sha256:> # pull one published image and drive it
//   node ci/mvp-release.mjs npm --package <tgz|spec>    # install as a consumer, with no Bun
//   node ci/mvp-release.mjs platform --package <tgz> --sha256 <hex>   # the qualification contract
//   node ci/mvp-release.mjs hardening --image <ref@sha256:> --npm <spec>  # the pre-deploy gate
//   node ci/mvp-release.mjs preflight --tag v0.1.4      # BEFORE the tag: can this release happen at all
//
// SIX SUBCOMMANDS AND NOT SIX SCRIPTS. §7 allows this project four new
// acceptance scripts before the pilots and two are already spent
// (`ci/high-risk-exercise.mjs`, this file). Each published thing needs its own
// checks and they share nearly all of their machinery — a free port, a `/health`
// wait, the credential capture, the restart on the same database, the receipt
// read-back — so they are subcommands here rather than four more files that
// would each grow their own answer to the same question.
//
// WHAT THE FIRST FIVE HAVE IN COMMON. Every one of them takes the artifact from
// where a USER would get it (a release, a registry, a tarball), refuses to
// consult the build directory instead, drives the shipped `demo` subcommand to a
// terminal `adopted` receipt, restarts on the same SQLite file and reads the
// receipt back from the server afterwards. And every one of them prints a marker
// that says WHICH path was exercised: a rehearsal never prints an acceptance
// marker.
//
// AND THAT IS EXACTLY WHY THE SIXTH EXISTS. All five read something PUBLISHED,
// so not one of them can run before the release exists — which left the
// PRECONDITIONS of a publish checked by nobody until the registry checked them,
// and the registry checks them after two of the three artifacts are already out
// and irreversible. `preflight` is the one subcommand that reads no published
// artifact of its own release: it asks, from a checkout, everything the npm
// registry and GitHub will ask later. It shares the repository slug, the release
// identity and the verdict table with `hardening`, which is why it lives here
// too.
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
const HARDENING_OK = "SUPPLY_CHAIN_HARDENING_OK";
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
  node ci/mvp-release.mjs hardening --image ghcr.io/<owner>/<image>@sha256:<64 hex> --npm <@scope/name@version>
                                               read the PUBLISHED SBOM, signature and provenance of both
                                               artifacts back out of the registries, before a deploy
  node ci/mvp-release.mjs preflight [--tag v<version>]
                                               BEFORE the tag and before any publish: the manifest names the
                                               repository the provenance will name, the version and the tag
                                               agree, neither the registry nor the release exists yet, the
                                               packed tarball carries both, and the tag is this commit

options:
  --out <dir>          binary: where the packaged assets are written (default: dist/release)
  --keep               do not remove the temporary directories that were created
  --expect-host <id>   ghcr: the host this job claims to be, as <platform>-<arch> (e.g. darwin-arm64)
  --record <file>      ghcr/platform/hardening/preflight: write the machine-readable record here
  --repo <owner/name>  hardening/preflight: the GitHub repository the release and the signing identity
                       belong to (default: GITHUB_REPOSITORY, or the origin remote)
  --tag <tag>          preflight: the tag this release will be made from (default: GITHUB_REF_NAME)
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

// ------------------------------------------------------------------ hardening
//
// THE GATE A DEPLOY PASSES THROUGH, AND IT READS THE REGISTRIES, NOT THE BUILD.
//
//   node ci/mvp-release.mjs hardening --image "${SKILLONOMIA_IMAGE_DIGEST}" \
//        --npm "@skillonomia/cli@${SKILLONOMIA_VERSION}"
//
// A release job that ran `--sbom=true`, `cosign sign` and a trusted-publisher
// `npm publish` has evidence that those COMMANDS were issued. It has none that
// the SBOM, the signature and the provenance are on the registries a deploy will
// pull from — a step can be reordered, a job can be skipped on a re-run, a
// registry can garbage-collect, and a digest can be handed to a deploy by a
// human who copied it from the wrong run. So this subcommand asks the
// registries, from wherever it is run, with nothing but the digest and the
// package specifier a deploy was given.
//
// EVERYTHING HANGS OFF THE DIGEST THE OPERATOR TYPED. The index is fetched by
// `--image`'s digest and re-hashed; every manifest and every blob reached from
// it is re-hashed against the digest that referenced it. So an SBOM this gate
// accepts is an SBOM the named image's own index points at, and not a document
// that happens to sit in the same repository under a movable tag.
//
// FOUR FAMILIES, REPORTED SEPARATELY. `SBOM`, `signature`, `provenance` and
// `identity` are four different questions, they fail for four different reasons,
// and a gate that answered "supply chain: no" would send an operator to read a
// workflow instead of to the one thing that is missing. Each family is reported
// with its own verdict and its own sentence, and each artifact — the image and
// the npm package — contributes to the families it can:
//
//   SBOM        the image's per-platform SPDX attestation, and the CycloneDX
//               document published for the npm tarball on the release
//   signature   the keyless cosign signature over the image index digest, and
//               `npm audit signatures` over a clean install of the package
//   provenance  the image's SLSA provenance attestation, attributed to a run of
//               THIS repository's workflow, and npm's own publish provenance
//   identity    that the two artifacts are ONE RELEASE — the same tag, the same
//               commit and, when both record it, the same run
//
// THE FOURTH FAMILY IS THE ONE THE OTHER THREE CANNOT ASK. Every check above it
// asks "is this artifact genuine", and two genuine artifacts of two different
// releases answer yes to all of them: an image this repository signed in March
// beside a package this repository attested in August is a pairing no run ever
// produced and no per-artifact check can see. So the expectation is derived ONCE
// from the npm version — `refs/tags/v<version>`, `release.yml`, this repository
// — every provenance is measured against it, the cosign certificate identity is
// pinned to THAT EXACT TAG rather than to `refs/tags/` and anything after it,
// and the commits the two provenances name are then required to be the same.
//
// WHAT THIS GATE VERIFIES ITSELF AND WHAT IT DELEGATES. The digest chain above
// is verified here, in this file. The CRYPTOGRAPHY is delegated to the two
// verifiers that own it, and both are run HERE, at the gate, against what the
// registries serve now: `cosign verify` for the image, and `npm audit
// signatures` on a clean temporary install for the package. If either verifier
// is absent its family reports `UNVERIFIABLE` and the gate refuses — a check
// that downgraded to "present" when its verifier was missing would be the exact
// failure this stage exists to prevent — and `SUPPLY_CHAIN_HARDENING_OK` is
// refused unless `npm audit signatures` named a verified attestation, so the
// marker cannot be printed beside a record saying the bundle was never checked.

const UA = "skillonomia-mvp-release";
/** Every media type a manifest this gate reads may be served as. */
const OCI_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SPDX_PREDICATE = "https://spdx.dev/Document";
const CYCLONEDX_PREDICATE = "https://cyclonedx.org/bom";
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const NPM_PUBLISH_PREDICATE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
/** The one workflow allowed to have produced a release this gate accepts. */
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
/**
 * THE ENVELOPE, AND WHY THE VERSION IS A SET. An attestation's OCI annotation is
 * a label a pusher chose; the document inside is the claim. The claim is only a
 * claim if it is an in-toto Statement, so `_type` is checked against the two
 * spellings in the wild — v0.1 is what BuildKit has emitted for years, v1 is the
 * current one — and anything else is a JSON blob wearing a label.
 */
const IN_TOTO_STATEMENT_TYPES = ["https://in-toto.io/Statement/v1", "https://in-toto.io/Statement/v0.1"];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseImageRef(ref) {
  if (!DIGEST_REF.test(ref)) {
    usage(`--image must be an immutable reference \`<registry>/<image>@sha256:<64 hex>\`, not \`${ref}\``);
  }
  const path = ref.slice(0, ref.indexOf("@"));
  return {
    ref,
    host: path.slice(0, path.indexOf("/")),
    // `docker.io` is the name a REFERENCE uses; it is not the host the API answers on.
    api: path.startsWith("docker.io/") ? "registry-1.docker.io" : path.slice(0, path.indexOf("/")),
    repository: path.slice(path.indexOf("/") + 1),
    digest: ref.slice(ref.indexOf("@") + 1),
    token: null,
  };
}

/** The registry's own anonymous pull token, taken from its `WWW-Authenticate`. */
async function registryToken(image) {
  const probe = await fetch(`https://${image.api}/v2/`, { headers: { "user-agent": UA } });
  if (probe.status !== 401) return null;
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const field = (name) => new RegExp(`${name}="([^"]+)"`).exec(challenge)?.[1] ?? null;
  const realm = field("realm");
  if (realm === null) return null;
  const url = new URL(realm);
  const service = field("service");
  if (service !== null) url.searchParams.set("service", service);
  url.searchParams.set("scope", `repository:${image.repository}:pull`);
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  const body = await res.json();
  return body.token ?? body.access_token ?? null;
}

function registryGet(image, kind, reference, accept) {
  return fetch(`https://${image.api}/v2/${image.repository}/${kind}/${reference}`, {
    headers: {
      accept,
      "user-agent": UA,
      ...(image.token === null ? {} : { authorization: `Bearer ${image.token}` }),
    },
  });
}

/**
 * A manifest, re-hashed against the digest that referenced it. `null` when the
 * registry does not have it — a missing signature is an answer, not an error.
 */
async function registryManifest(image, reference, what) {
  const res = await registryGet(image, "manifests", reference, OCI_ACCEPT);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${what}: ${reference} answered ${res.status} ${res.statusText}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (reference.startsWith("sha256:") && `sha256:${sha256(raw)}` !== reference) {
    throw new Error(`${what}: ${reference} was served as sha256:${sha256(raw)} — the registry answered with other bytes`);
  }
  return JSON.parse(raw.toString("utf8"));
}

/** A blob, re-hashed against the digest its manifest gave it. */
async function registryBlob(image, digest, what) {
  const res = await registryGet(image, "blobs", digest, "application/octet-stream");
  if (!res.ok) throw new Error(`${what}: blob ${digest} answered ${res.status} ${res.statusText}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (`sha256:${sha256(raw)}` !== digest) {
    throw new Error(`${what}: blob ${digest} was served as sha256:${sha256(raw)}`);
  }
  return raw;
}

/**
 * The in-toto statements buildx attaches to an index, indexed BY THE PLATFORM
 * MANIFEST THEY ARE ABOUT. The link is the attestation manifest's
 * `vnd.docker.reference.digest` annotation, and the statement's own `subject`
 * is checked against it afterwards: an attestation that names a different image
 * is a document about something else that was filed in the right drawer.
 */
async function imageStatements(image) {
  const index = await registryManifest(image, image.digest, "the image index");
  if (index === null) fail(`${image.ref} is not in the registry, or is not readable anonymously`);
  const entries = index.manifests ?? [];
  const runtime = entries.filter((m) => (m.annotations?.["vnd.docker.reference.type"] ?? null) === null);
  const attestations = entries.filter((m) => m.annotations?.["vnd.docker.reference.type"] === "attestation-manifest");
  const statements = new Map(runtime.map((m) => [m.digest, []]));
  for (const entry of attestations) {
    const subject = entry.annotations["vnd.docker.reference.digest"];
    const bucket = statements.get(subject);
    // an attestation about a manifest this index does not list is about something else
    if (bucket === undefined) continue;
    const manifest = await registryManifest(image, entry.digest, "an attestation manifest");
    if (manifest === null) continue;
    for (const layer of manifest.layers ?? []) {
      const predicateType = layer.annotations?.["in-toto.io/predicate-type"] ?? null;
      if (predicateType === null) continue;
      const raw = await registryBlob(image, layer.digest, `the ${predicateType} attestation`);
      let statement;
      try {
        statement = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new Error(`the ${predicateType} attestation of ${subject} is not JSON`);
      }
      bucket.push({ predicateType, statement, blob: layer.digest });
    }
  }
  return { index, runtime, attestations, statements };
}

/** Does an in-toto statement say it is about this exact manifest digest? */
function statementBinds(statement, digest) {
  const want = digest.slice("sha256:".length);
  return (statement.subject ?? []).some((s) => (s.digest ?? {}).sha256 === want);
}

/**
 * THE ONE RELEASE THIS GATE IS ABOUT, DERIVED FROM ONE INPUT. The operator hands
 * a deploy two strings — an image digest and a package specifier — and a gate
 * that checked each of them against "some run of this repository" would accept
 * last month's correctly signed image beside this month's correctly attested
 * package. They would both be genuine and they would not be the same release.
 *
 * So the expectation is computed ONCE, from the npm version, and everything else
 * is measured against it: the tag is `v<version>`, the ref is `refs/tags/v<version>`,
 * the workflow is `release.yml`, and the Fulcio identity a signature must carry
 * is that workflow AT THAT TAG — not `refs/tags/` and whatever follows.
 */
export function releaseIdentity(repo, version) {
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  return {
    repo,
    version,
    tag,
    ref,
    workflow: RELEASE_WORKFLOW,
    repositoryUrl: `https://github.com/${repo}`,
    certificateIdentity: `https://github.com/${repo}/${RELEASE_WORKFLOW}@${ref}`,
  };
}

/**
 * WHY THE STATEMENT AND NOT THE ANNOTATION. `in-toto.io/predicate-type` on an
 * OCI layer is metadata the pusher wrote; the gate finds attestations by it
 * because that is how they are indexed, and then it must not believe it. What is
 * checked here is the document: it is an in-toto Statement, its OWN
 * `predicateType` is the one the annotation advertised, and its subject names
 * the manifest this attestation was filed under. A layer annotated SPDX that
 * carries a CycloneDX statement — or `{}` — fails here rather than counting.
 *
 * Returns the sentence that says what is wrong, or `null` when nothing is.
 */
export function statementFault(attached, digest, predicateType) {
  const { predicateType: annotated, statement } = attached;
  if (statement === null || typeof statement !== "object" || Array.isArray(statement)) {
    return `the ${annotated} attestation is ${Array.isArray(statement) ? "a JSON array" : JSON.stringify(statement)}, not an in-toto Statement`;
  }
  if (!IN_TOTO_STATEMENT_TYPES.includes(statement._type)) {
    return `the ${annotated} attestation's \`_type\` is ${JSON.stringify(statement._type ?? null)}, and an in-toto Statement is what carries a predicate`;
  }
  if (statement.predicateType !== predicateType) {
    return `the layer is annotated ${annotated} and the statement inside says ${JSON.stringify(statement.predicateType ?? null)}`;
  }
  if (!statementBinds(statement, digest)) {
    const names = (statement.subject ?? []).map((s) => s.name ?? "(unnamed)");
    return `the ${annotated} attestation does not name ${digest} among its subjects (it names ${JSON.stringify(names)})`;
  }
  return null;
}

/** `https://github.com/o/r.git#refs/tags/v1` → its repository and its ref. */
export function parseGitUri(uri) {
  if (typeof uri !== "string") return null;
  const m = /^(?:git\+)?(https:\/\/github\.com\/[^/\s]+\/[^/\s#@]+?)(?:\.git)?(?:[#@](\S+))?$/.exec(uri);
  if (m === null) return null;
  return { repository: m[1], ref: m[2] ?? null };
}

/**
 * WHO BUILT IT, FROM WHICH COMMIT, UNDER WHICH WORKFLOW, IN WHICH RUN — read out
 * of a SLSA v1 predicate wherever the generator that wrote it puts those facts.
 * Three shapes are read, because two different generators produce the two
 * provenances this gate compares:
 *
 *   externalParameters.workflow      npm's and GitHub's generator: {repository, ref, path}
 *   externalParameters.configSource  a BuildKit build whose context is a git URL: {uri, digest, entryPoint}
 *   resolvedDependencies[]           the git source either one resolved, with its commit
 *
 * A field no shape supplies stays `null`, and every caller treats `null` as a
 * refusal rather than as a pass — a provenance that does not say which commit it
 * built cannot be the one that says two artifacts came from the same commit.
 */
export function provenanceIdentity(predicate) {
  const out = { repository: null, ref: null, commit: null, workflow: null, runId: null };
  const take = (field, value) => {
    if (out[field] === null && typeof value === "string" && value !== "") out[field] = value;
  };
  const bd = predicate?.buildDefinition ?? {};
  const ext = bd.externalParameters ?? {};

  const wf = ext.workflow ?? null;
  if (wf !== null && typeof wf === "object") {
    take("repository", wf.repository);
    take("ref", wf.ref);
    take("workflow", wf.path);
  }
  const cs = ext.configSource ?? null;
  if (cs !== null && typeof cs === "object") {
    const parsed = parseGitUri(cs.uri);
    if (parsed !== null) {
      take("repository", parsed.repository);
      take("ref", parsed.ref);
    }
    take("commit", cs.digest?.sha1);
    take("commit", cs.digest?.gitCommit);
    take("workflow", cs.entryPoint);
  }
  for (const dep of Array.isArray(bd.resolvedDependencies) ? bd.resolvedDependencies : []) {
    const parsed = parseGitUri(dep?.uri);
    if (parsed === null) continue;
    take("repository", parsed.repository);
    take("ref", parsed.ref);
    take("commit", dep?.digest?.sha1);
    take("commit", dep?.digest?.gitCommit);
  }
  // The run: `builder.id` is what this repository's image build sets by hand,
  // `metadata.invocationId` is what npm's generator writes. Either is the same
  // number, and the number is what makes two artifacts one run.
  const rd = predicate?.runDetails ?? {};
  for (const candidate of [rd.builder?.id, rd.metadata?.invocationId]) {
    if (typeof candidate !== "string") continue;
    const m = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(candidate);
    if (m !== null) take("runId", m[1]);
  }
  return out;
}

/**
 * What an identity read out of a provenance must say, or the sentence saying it
 * did not.
 *
 * THE ONE FIELD A BUILDKIT PROVENANCE CANNOT CARRY. `workflow` comes out of
 * `externalParameters.workflow.path`, which is what GitHub's and npm's generator
 * writes. BuildKit does not write it under any build mode: its
 * `externalParameters` are `{configSource, request}`, and `configSource.path` is
 * `Dockerfile` — the file the build read, not the workflow that ran it.
 * (`entryPoint` is the SLSA v0.2 spelling of the same field and is likewise a
 * Dockerfile here.) So demanding `workflow` of an IMAGE provenance demands a
 * field this project's producer does not emit, and no image this pipeline builds
 * can ever satisfy it.
 *
 * `workflowMayBeAbsent` is that carve-out, and it is exactly one field wide:
 *
 *   * ABSENCE ONLY. A provenance that records SOME workflow which is not
 *     `release.yml` is refused as before — the excuse is for a producer that has
 *     nothing to say, not for one that says the wrong thing.
 *   * EVERY OTHER BINDING MUST HOLD. If the repository, the ref or the commit
 *     does not bind, the absent workflow is reported as a fault too: the excuse
 *     is granted only to a provenance that is otherwise exactly this release's.
 *   * IMAGE ONLY. npm's provenance comes from a generator that DOES write the
 *     field, so `npmProvenanceFrom` keeps demanding `.github/workflows/release.yml`
 *     and this parameter stays at its default there.
 *
 * What replaces the missing field for the image is named in the verdict rather
 * than assumed: the subject digest and the `builder.id` run URL checked by
 * `imageProvenance` before this function is reached, and the Fulcio identity
 * `cosign verify` checks in the `signature` family — which is why
 * `releaseIdentityVerdict` refuses a workflow-less image whose signature was not
 * verified.
 */
function identityFaults(id, expected, { workflowMayBeAbsent = false } = {}) {
  const repository =
    id.repository !== expected.repositoryUrl
      ? `it was built by ${id.repository ?? "(no repository)"} and this deploy expects ${expected.repositoryUrl}`
      : null;
  const workflow =
    id.workflow !== expected.workflow
      ? `the workflow is ${id.workflow ?? "(not recorded)"} and only ${expected.workflow} publishes this project`
      : null;
  const ref = id.ref !== expected.ref ? `the ref is ${id.ref ?? "(not recorded)"} and ${expected.version} is released from ${expected.ref}` : null;
  const commit = id.commit === null ? "it does not record the commit it was built from, so nothing ties it to the other artifact of this release" : null;
  const excused = workflowMayBeAbsent && id.workflow === null && [repository, ref, commit].every((f) => f === null);
  return [repository, excused ? null : workflow, ref, commit].filter((f) => f !== null);
}

const platformName = (m) => `${m.platform?.os ?? "?"}/${m.platform?.architecture ?? "?"}`;

/**
 * One line of the verdict table: a family, an artifact, a status and why — and,
 * when the check read one, the release identity the artifact claims, so the
 * cross-artifact check further down compares what was actually verified rather
 * than re-parsing the same documents with a second set of rules.
 */
const verdict = (family, artifact, status, detail, identity = null) => ({
  family,
  artifact,
  status,
  detail,
  ...(identity === null ? {} : { identity }),
});

/**
 * THE IMAGE'S SBOM: one SPDX document per runtime platform, bound to that
 * platform's digest, and listing something.
 *
 * SPDX AND NOTHING ELSE, ON PURPOSE. `--sbom=true` is what this project's
 * release runs and BuildKit's SPDX predicate is what it produces; no step
 * anywhere in this repository produces a CycloneDX attestation for an IMAGE. A
 * format with no producer here is a format whose documents this gate has never
 * seen and cannot schema-validate, so accepting one would mean accepting
 * whatever a pusher chose to put under that name — and `{}` is a valid
 * "whatever". The npm tarball's CycloneDX document is a different artifact,
 * found on the release, and it IS validated against the tarball it names.
 *
 * ACCEPTING AN SBOM MEANS READING IT. A document that passes here declares an
 * SPDX version and lists at least one package, because "the SBOM is present" is
 * a claim an operator uses to answer "is that CVE in the thing we run", and an
 * empty document answers no to every such question while looking like evidence.
 */
export function imageSbom(image, found) {
  if (found.runtime.length === 0) {
    return verdict("SBOM", image.ref, "MISSING", "the reference is a single-platform manifest, so it carries no attestation manifests at all — a digest that has an SBOM is the index digest buildx reported when it pushed");
  }
  const missing = [];
  const carried = [];
  for (const entry of found.runtime) {
    const all = found.statements.get(entry.digest) ?? [];
    const attached = all.filter((s) => s.predicateType === SPDX_PREDICATE);
    if (attached.length === 0) {
      const other = all.map((s) => s.predicateType);
      const cyclonedx = other.includes(CYCLONEDX_PREDICATE)
        ? ` — a CycloneDX attestation on an image is not accepted: nothing in this release produces one, so this gate has no producer to validate its shape against and would be taking the annotation's word for the contents`
        : "";
      missing.push(`${platformName(entry)} carries ${other.length === 0 ? "no attestation" : other.join(", ")}${cyclonedx}`);
      continue;
    }
    const fault = attached.map((s) => statementFault(s, entry.digest, SPDX_PREDICATE)).find((f) => f !== null);
    if (fault !== undefined) {
      missing.push(`${platformName(entry)}: ${fault}`);
      continue;
    }
    const predicate = attached[0].statement.predicate ?? null;
    if (predicate === null || typeof predicate !== "object" || Array.isArray(predicate)) {
      missing.push(`${platformName(entry)}: the SPDX statement's predicate is ${JSON.stringify(predicate)}, not a document`);
      continue;
    }
    if (typeof predicate.spdxVersion !== "string" || !predicate.spdxVersion.startsWith("SPDX-")) {
      missing.push(`${platformName(entry)}: the predicate declares \`spdxVersion\` ${JSON.stringify(predicate.spdxVersion ?? null)}, so it is not an SPDX document`);
      continue;
    }
    if (!Array.isArray(predicate.packages) || predicate.packages.length < 1) {
      missing.push(`${platformName(entry)}: the SPDX document lists no packages, and an SBOM nobody can look a package up in is not one`);
      continue;
    }
    carried.push(`${platformName(entry)} ${predicate.spdxVersion} (${predicate.packages.length} packages)`);
  }
  if (missing.length > 0) {
    return verdict("SBOM", image.ref, "MISSING", `no SBOM attestation this gate can use: ${missing.join("; ")}. \`docker buildx build --sbom=true\` attaches one per platform.`);
  }
  return verdict("SBOM", image.ref, "OK", carried.join(", "));
}

/**
 * THE IMAGE'S PROVENANCE, AND WHO IS IN IT. buildx attaches SLSA provenance by
 * DEFAULT in `mode=min`, and a min-mode statement has an EMPTY `builder.id`: it
 * says a build happened and not whose build it was. A gate that accepted it
 * would pass on any image anyone built from any checkout, which is the property
 * provenance exists to deny — so the builder must be a run of this repository.
 */
export function imageProvenance(image, found, expected) {
  if (found.runtime.length === 0) {
    return verdict("provenance", image.ref, "MISSING", "the reference is a single-platform manifest, so it carries no attestation manifests at all");
  }
  const problems = [];
  const attributed = [];
  const identities = [];
  // ANCHORED AT BOTH ENDS. Without the `$` this pattern accepts
  // `.../actions/runs/123/not-a-run-at-all`: the prefix matches, the tail is
  // whatever the pusher appended, and a URL that reads like a run of this
  // repository is exactly what a reader would click and believe.
  const builderRe = new RegExp(`^https://github\\.com/${escapeRe(expected.repo)}/actions/runs/\\d+$`);
  for (const entry of found.runtime) {
    const all = found.statements.get(entry.digest) ?? [];
    const attached = all.filter((s) => s.predicateType === PROVENANCE_PREDICATE);
    if (attached.length === 0) {
      const other = all.map((s) => s.predicateType);
      problems.push(`${platformName(entry)} carries ${other.length === 0 ? "no attestation" : other.join(", ")}`);
      continue;
    }
    const fault = statementFault(attached[0], entry.digest, PROVENANCE_PREDICATE);
    if (fault !== null) {
      problems.push(`${platformName(entry)}: ${fault}`);
      continue;
    }
    const { statement } = attached[0];
    const builder = statement.predicate?.runDetails?.builder?.id ?? "";
    if (!builderRe.test(builder)) {
      problems.push(
        `${platformName(entry)}: builder.id is ${builder === "" ? "empty (buildx `mode=min` provenance: a build happened, and it says nothing about whose)" : JSON.stringify(builder)}, not a run of ${expected.repo}`,
      );
      continue;
    }
    // THE SAME RELEASE, NOT MERELY THE SAME REPOSITORY. An image built by a run
    // of this repository from some other tag is a genuine artifact of a
    // different release, and pairing it with this version's package is the
    // substitution this check exists to refuse.
    const id = provenanceIdentity(statement.predicate);
    // THE IMAGE IS THE SIDE WHOSE GENERATOR HAS NO WORKFLOW FIELD. Everything
    // else this line demands — the repository, the tag, the commit — BuildKit
    // does write, and the subject digest and the run URL above were already
    // checked; see `identityFaults` for why the workflow alone is excused, and
    // only when nothing else is.
    const faults = identityFaults(id, expected, { workflowMayBeAbsent: true });
    if (faults.length > 0) {
      problems.push(`${platformName(entry)}: ${faults.join("; ")}`);
      continue;
    }
    identities.push({ platform: platformName(entry), ...id });
    attributed.push(`${platformName(entry)} ${builder} ${id.ref}@${id.commit}`);
  }
  if (problems.length > 0) {
    const anyPresent = found.runtime.some((e) => (found.statements.get(e.digest) ?? []).some((s) => s.predicateType === PROVENANCE_PREDICATE));
    return verdict(
      "provenance",
      image.ref,
      anyPresent ? "REFUSED" : "MISSING",
      `${problems.join("; ")}. \`--provenance=mode=max,builder-id=<run url>\` over a source the build records ` +
        `(a git context, or a \`configSource\`) is what attaches a provenance naming the run, the workflow, the tag and the commit.`,
    );
  }
  // Two platforms of one push are one build; if they disagree about the commit
  // they are two builds that were pushed under one index.
  const distinct = [...new Set(identities.map((i) => `${i.ref}@${i.commit}#${i.runId ?? "?"}`))];
  if (distinct.length > 1) {
    return verdict("provenance", image.ref, "REFUSED", `the platforms of this index name different builds: ${distinct.join(" vs ")}`);
  }
  return verdict("provenance", image.ref, "OK", attributed.join(", "), identities[0]);
}

/**
 * THE KEYLESS SIGNATURE. Discovery covers both layouts a cosign release may
 * have written — the `sha256-<hex>.sig` tag of the classic layout and the
 * `sha256-<hex>` referrers-fallback tag of the OCI 1.1 bundle layout — because
 * which one exists is a property of the cosign version that signed, and an
 * operator reading this output cares whether a signature is THERE.
 *
 * Discovery is not verification. What makes the signature worth anything is the
 * Fulcio certificate's identity, and that is `cosign verify`'s job.
 */
async function imageSignature(image, expected) {
  const hex = image.digest.slice("sha256:".length);
  const layouts = [
    [`sha256-${hex}.sig`, "the `.sig` tag"],
    [`sha256-${hex}`, "the referrers-fallback tag"],
  ];
  const present = [];
  for (const [tag, what] of layouts) {
    const manifest = await registryManifest(image, tag, `the signature under ${what}`);
    if (manifest !== null) present.push(`${what} ${tag}`);
  }
  return cosignVerdict(image, expected, present);
}

/**
 * THE IDENTITY IS THE EXACT TAG, AND NOT A PREFIX OF IT. `--certificate-identity-regexp`
 * ending at `@refs/tags/` accepts a signature made by `release.yml` on ANY tag of
 * this repository — which is a correct signature over a different release, and
 * pairing one of those with this version's package is the substitution the
 * identity check exists to deny. `--certificate-identity` takes the whole string
 * and compares it, so `v0.1.2`'s package can only be deployed beside the image
 * `release.yml` signed while running on `refs/tags/v0.1.2`.
 */
export function cosignVerdict(image, expected, present) {
  const hex = image.digest.slice("sha256:".length);
  if (present.length === 0) {
    return verdict("signature", image.ref, "MISSING", `neither sha256-${hex}.sig nor sha256-${hex} is in ${image.host}/${image.repository} — nothing has signed this digest`);
  }
  const probe = spawnSync("cosign", ["version"], { encoding: "utf8" });
  if (probe.error !== undefined) {
    return verdict("signature", image.ref, "UNVERIFIABLE", `${present.join(", ")} is published, and \`cosign\` is not on this machine's PATH. A published signature nobody verified is not a verified signature, so this gate refuses rather than reporting it as present.`);
  }
  const r = spawnSync(
    "cosign",
    ["verify", "--certificate-oidc-issuer", OIDC_ISSUER, "--certificate-identity", expected.certificateIdentity, image.ref],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    return verdict("signature", image.ref, "REFUSED", `${present.join(", ")} is published and \`cosign verify\` refused it against ${expected.certificateIdentity} at ${OIDC_ISSUER}:\n${redact(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim()}`);
  }
  return verdict("signature", image.ref, "OK", `${present.join(", ")}, verified against ${expected.certificateIdentity} at ${OIDC_ISSUER}`);
}

/** `@scope/name@version` → its two halves, and nothing looser. */
function parseNpmSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) usage(`--npm must be \`<name>@<version>\`, not \`${spec}\``);
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!/^\d+\.\d+\.\d+/.test(version)) usage(`--npm must name an exact version, not \`${version}\``);
  return { spec, name, version };
}

const integrityHex = (integrity) => Buffer.from(integrity.slice(integrity.indexOf("-") + 1), "base64").toString("hex");

/** What the registry says it is serving under this exact version. */
async function npmRegistryVersion(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}`, { headers: { "user-agent": UA } });
  if (!res.ok) fail(`the npm registry answered ${res.status} ${res.statusText} for ${pkg.name}`);
  const packument = await res.json();
  const version = (packument.versions ?? {})[pkg.version];
  if (version === undefined) fail(`the npm registry has no ${pkg.spec} — it carries ${Object.keys(packument.versions ?? {}).join(", ") || "no versions"}`);
  return version;
}

/**
 * NPM'S OWN PROVENANCE, WHICH ONLY EXISTS IF THE PUBLISH WAS A TRUSTED ONE. A
 * long-lived `NPM_TOKEN` publish produces a package with registry signatures and
 * NO attestations; OIDC Trusted Publishing produces the SLSA provenance read
 * here. So this check is also the one that says which of the two ways the
 * package on the registry was published.
 */
async function npmProvenance(pkg, dist, expected) {
  const attestations = dist.attestations ?? null;
  if (attestations === null || attestations.url === undefined) {
    return verdict("provenance", pkg.spec, "MISSING", "the registry reports no `dist.attestations` for this version, which is what a publish with a long-lived token leaves behind; OIDC Trusted Publishing is what attaches provenance");
  }
  const res = await fetch(attestations.url, { headers: { "user-agent": UA } });
  if (!res.ok) return verdict("provenance", pkg.spec, "REFUSED", `the registry names an attestations bundle at ${attestations.url} and it answered ${res.status} ${res.statusText}`);
  return npmProvenanceFrom(pkg, dist, expected, (await res.json()).attestations ?? []);
}

/**
 * WHAT THE BUNDLE SAYS, CHECKED AGAINST THIS RELEASE AND THIS TARBALL.
 *
 * A MALFORMED BUNDLE IS AN ANSWER. The envelope's payload is base64 of JSON, and
 * a payload that is neither is not an error to crash the gate with — it is a
 * bundle that proves nothing, reported as such, in the same table as everything
 * else. So is a bundle with no certificate: what makes a DSSE envelope evidence
 * is the key that signed it, and `verificationMaterial` is where that key is.
 *
 * BOTH ATTESTATIONS ARE ABOUT THIS TARBALL. The provenance says who built it and
 * the npm publish attestation says the registry countersigned the upload — and
 * both are checked against `dist.integrity`, because "a publish attestation
 * exists in the bundle" is satisfied by an attestation about a DIFFERENT version
 * of the same package, and the bundle is fetched by a URL the registry chose.
 */
export function npmProvenanceFrom(pkg, dist, expected, bundles) {
  const statements = bundles.map((b) => {
    const payload = b.bundle?.dsseEnvelope?.payload;
    const certified = (b.bundle?.verificationMaterial?.certificate ?? b.bundle?.verificationMaterial?.x509CertificateChain ?? null) !== null;
    if (typeof payload !== "string") return { predicateType: b.predicateType ?? null, statement: null, certified, fault: "carries no `bundle.dsseEnvelope.payload`" };
    let statement = null;
    try {
      statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      return { predicateType: b.predicateType ?? null, statement: null, certified, fault: "has a `dsseEnvelope.payload` that is not base64 of JSON" };
    }
    if (statement === null || typeof statement !== "object" || Array.isArray(statement)) {
      return { predicateType: b.predicateType ?? null, statement: null, certified, fault: `has a payload that decodes to ${JSON.stringify(statement)}, not a statement` };
    }
    return { predicateType: b.predicateType ?? null, statement, certified, fault: null };
  });
  const broken = statements.filter((s) => s.fault !== null);
  if (broken.length > 0) {
    return verdict("provenance", pkg.spec, "REFUSED", `the attestation bundle for ${dist.integrity} is not readable: ${broken.map((s) => `the ${s.predicateType ?? "(unlabelled)"} entry ${s.fault}`).join("; ")}`);
  }
  const want = integrityHex(dist.integrity);
  /** The one entry of `predicateType` that is a statement about THIS tarball. */
  const about = (predicateType) => {
    const carried = statements.filter((s) => s.statement.predicateType === predicateType);
    if (carried.length === 0) return { entry: null, fault: `the bundle carries ${statements.map((s) => s.statement.predicateType ?? s.predicateType).join(", ") || "nothing"} and no ${predicateType}` };
    const entry = carried[0];
    if (!IN_TOTO_STATEMENT_TYPES.includes(entry.statement._type)) {
      return { entry: null, fault: `the ${predicateType} statement's \`_type\` is ${JSON.stringify(entry.statement._type ?? null)}, and an in-toto Statement is what carries a predicate` };
    }
    if (!entry.certified) {
      return { entry: null, fault: `the ${predicateType} bundle carries no certificate in \`verificationMaterial\`, so nothing identifies who signed it` };
    }
    const subjects = entry.statement.subject ?? [];
    if (!subjects.some((s) => (s.digest ?? {}).sha512 === want)) {
      return {
        entry: null,
        fault:
          `the ${predicateType} statement is about ${JSON.stringify(subjects.map((s) => s.name ?? "(unnamed)"))} ` +
          `at sha512 ${JSON.stringify(subjects.map((s) => (s.digest ?? {}).sha512 ?? null))}, and the registry serves ${dist.integrity} for ${pkg.spec}`,
      };
    }
    return { entry, fault: null };
  };

  const provenance = about(PROVENANCE_PREDICATE);
  if (provenance.fault !== null) return verdict("provenance", pkg.spec, "REFUSED", provenance.fault);
  const publish = about(NPM_PUBLISH_PREDICATE);
  if (publish.fault !== null) {
    return verdict("provenance", pkg.spec, "REFUSED", `${publish.fault} — without it the registry did not countersign THIS upload`);
  }

  const id = provenanceIdentity(provenance.entry.statement.predicate);
  const faults = identityFaults(id, expected);
  if (faults.length > 0) return verdict("provenance", pkg.spec, "REFUSED", faults.join("; "));
  return verdict(
    "provenance",
    pkg.spec,
    "OK",
    `${id.repository} ${id.workflow}@${id.ref} commit ${id.commit}${id.runId === null ? "" : ` run ${id.runId}`}, ` +
      `provenance and npm publish attestation both bound to ${dist.integrity}`,
    id,
  );
}

/**
 * ONE RELEASE, OR TWO ARTIFACTS THAT EACH LOOK FINE. Everything above answers
 * "is this artifact genuine". Nothing above answers "are these two the same
 * release" — and a gate built out of per-artifact answers accepts last month's
 * correctly signed image beside this month's correctly attested package, both
 * genuine, both from this repository, and together a pairing no run ever
 * produced. That is the one substitution an operator cannot see by reading the
 * lines above, so it gets a line of its own.
 *
 * THE RUN IS COMPARED WHEN BOTH SIDES RECORD IT. The tag and the commit are
 * demanded of both provenances by `identityFaults`; the run id is demanded to
 * AGREE, because `release.yml` publishes both artifacts from one run, and it is
 * not demanded to EXIST, because whether a generator writes it is the
 * generator's choice and the commit already pins the release.
 *
 * AND THE LINE SAYS ONLY WHAT WAS CHECKED. The workflow is demanded of the
 * package's provenance and CANNOT be demanded of the image's, because BuildKit
 * writes no such field (`identityFaults`). So the sentence this returns does not
 * claim the image named `release.yml`: it names what actually binds the image to
 * this release — the repository, the tag and the commit in its provenance, the
 * `builder.id` run URL `imageProvenance` checked, and the Fulcio identity on the
 * signature. That last one is the only thing that names the WORKFLOW for the
 * image, so `imageSignatureStatus` is required to be `OK` before the sentence is
 * printed: a workflow-less provenance beside an unverified certificate is a
 * release nobody demonstrated, and it is refused here rather than described.
 * The parameter defaults to `null` so that a caller which forgets it refuses.
 */
export function releaseIdentityVerdict(expected, image, npm, imageSignatureStatus = null) {
  const missing = [image === null ? "the image" : null, npm === null ? "the npm package" : null].filter((x) => x !== null);
  if (missing.length > 0) {
    return verdict(
      "identity",
      `${expected.tag}`,
      "REFUSED",
      `${missing.join(" and ")} did not produce a readable provenance, so there is nothing to compare: two artifacts are one release only if both say so`,
    );
  }
  if (image.commit !== npm.commit) {
    return verdict("identity", expected.tag, "REFUSED", `the image was built from commit ${image.commit} and ${expected.version} was published from ${npm.commit} — genuine artifacts of two different releases`);
  }
  if (image.ref !== npm.ref) {
    return verdict("identity", expected.tag, "REFUSED", `the image names ${image.ref} and the package names ${npm.ref}`);
  }
  if (image.runId !== null && npm.runId !== null && image.runId !== npm.runId) {
    return verdict("identity", expected.tag, "REFUSED", `the image was built by run ${image.runId} and the package was published by run ${npm.runId}; \`${RELEASE_WORKFLOW}\` publishes both from one run`);
  }
  const run = image.runId ?? npm.runId;
  const both = `${expected.repositoryUrl} at ${expected.ref}, commit ${image.commit}${run === null ? " (neither provenance records a run id)" : `, run ${run}`}`;
  if (image.workflow === expected.workflow) {
    return verdict("identity", expected.tag, "OK", `both artifacts name ${expected.repositoryUrl} ${expected.workflow}@${expected.ref} at commit ${image.commit}${run === null ? " (neither provenance records a run id)" : `, run ${run}`}`);
  }
  if (imageSignatureStatus !== "OK") {
    return verdict(
      "identity",
      expected.tag,
      "REFUSED",
      `the image's provenance does not name a workflow — BuildKit writes none — so the only thing that names ${expected.workflow} for this image is ` +
        `the Fulcio identity ${expected.certificateIdentity} on its signature, and the signature check answered ${imageSignatureStatus ?? "nothing"}. ` +
        `Both artifacts do name ${both}, and that is not by itself the claim that ${expected.workflow} built them.`,
    );
  }
  return verdict(
    "identity",
    expected.tag,
    "OK",
    `both artifacts were built from ${both}. The package's provenance names ${expected.workflow}; the image's provenance names no workflow, ` +
      `because BuildKit records \`configSource\`/\`request\` and has no such field — what ties the image to this release is the repository, ` +
      `the ref and the commit above, the \`builder.id\` run of ${expected.repo} in its provenance, and the Fulcio identity ` +
      `${expected.certificateIdentity}, which \`cosign verify\` accepted (see the signature line).`,
  );
}

/**
 * THE CRYPTOGRAPHY, RUN HERE, ON THE EXACT PACKAGE THIS DEPLOY WAS HANDED.
 *
 * Reading a DSSE payload tells you what a bundle SAYS. It does not tell you that
 * anybody signed it, and every check above this one is a check on the contents
 * of a document the registry served over TLS and nothing more. `npm audit
 * signatures` is the verifier: it fetches the registry's own signature and the
 * Sigstore bundle for an installed tree and verifies both against npm's trust
 * root — so it is run HERE, at the gate, and not only in the workflow that
 * published. A workflow that verified is evidence about a job that already
 * finished; a deploy needs evidence about the bytes it is about to run.
 *
 * A CLEAN DIRECTORY, AND ONLY THE PACKAGE. The install is done in a fresh
 * temporary tree with its own cache, with `--ignore-scripts`, so what is audited
 * is this specifier and not this repository's dependency tree — auditing the
 * checkout would report on packages the deploy never installs and would pass
 * whether or not the one package under test carries anything.
 *
 * A VERIFIED REGISTRY SIGNATURE IS NOT A VERIFIED ATTESTATION. npm exits 0 for a
 * package that has a registry signature and no provenance at all, so the output
 * is required to name a verified attestation: that sentence is what says the
 * Sigstore bundle read above was cryptographically checked.
 */
export function npmSignature(pkg) {
  const where = mkdtempSync(join(tmpdir(), "skillonomia-audit-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const opts = {
    cwd: where,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(where, "cache"), npm_config_fund: "false", npm_config_update_notifier: "false" },
  };
  const say = (r) => redact(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim();
  try {
    const init = spawnSync(npm, ["init", "-y"], opts);
    if (init.error !== undefined) {
      return verdict("signature", pkg.spec, "UNVERIFIABLE", "`npm` is not on this machine's PATH, and `npm audit signatures` is what verifies the registry signature and the Sigstore bundle. An unverified bundle is not a verified one, so this gate refuses rather than reporting the bundle as read.");
    }
    if (init.status !== 0) return verdict("signature", pkg.spec, "UNVERIFIABLE", `\`npm init -y\` failed in a clean directory, so nothing could be installed to verify:\n${say(init)}`);
    const install = spawnSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", pkg.spec], opts);
    if (install.status !== 0) return verdict("signature", pkg.spec, "REFUSED", `a clean install of ${pkg.spec} failed, so what a deploy would install is not installable:\n${say(install)}`);
    const audit = spawnSync(npm, ["audit", "signatures"], opts);
    const out = say(audit);
    if (audit.status !== 0) return verdict("signature", pkg.spec, "REFUSED", `\`npm audit signatures\` refused ${pkg.spec}:\n${out}`);
    if (!/verified attestations?/i.test(out)) {
      return verdict(
        "signature",
        pkg.spec,
        "REFUSED",
        `\`npm audit signatures\` verified the registry signature and named no verified attestation, so the provenance bundle read above was never cryptographically checked:\n${out}`,
      );
    }
    return verdict("signature", pkg.spec, "OK", `\`npm audit signatures\` on a clean install of ${pkg.spec}:\n${out}`);
  } finally {
    rmSync(where, { recursive: true, force: true });
  }
}

/** `pkg:npm/%40scope/name@version` → `@scope/name@version`, or null. */
export function purlOf(component) {
  const purl = component.purl ?? null;
  if (purl === null || !purl.startsWith("pkg:npm/")) return null;
  const body = purl.slice("pkg:npm/".length).split("?")[0];
  const at = body.lastIndexOf("@");
  if (at <= 0) return null;
  return `${decodeURIComponent(body.slice(0, at))}@${body.slice(at + 1)}`;
}

/**
 * THE NPM TARBALL'S SBOM, ON THE RELEASE. An image's SBOM rides in the registry
 * beside the image; npm has no such place, so the CycloneDX document is a
 * release asset — and it is found BY ITS CONTENT, not by a filename this file
 * and the workflow would each have to spell the same way. What makes it the
 * SBOM OF THIS TARBALL is the hash the workflow records in it: the root
 * component's SHA-512 must be the integrity the registry serves.
 */
async function npmSbom(pkg, dist, expected) {
  const { repo, tag } = expected;
  // `GITHUB_API_URL` is what a GitHub Enterprise host sets, and what a workflow
  // already carries; the public API is the default and not the only answer.
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: {
      "user-agent": UA,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN}` } : {}),
    },
  });
  if (!res.ok) return verdict("SBOM", pkg.spec, "MISSING", `${repo} has no release tagged ${tag} to carry an SBOM (the API answered ${res.status} ${res.statusText})`);
  const release = await res.json();
  const candidates = (release.assets ?? []).filter((a) => a.name.endsWith(".cdx.json"));
  if (candidates.length === 0) {
    return verdict("SBOM", pkg.spec, "MISSING", `release ${tag} carries [${(release.assets ?? []).map((a) => a.name).join(", ")}] and no CycloneDX document`);
  }
  const want = integrityHex(dist.integrity);
  const rejected = [];
  for (const asset of candidates) {
    const body = await (await fetchOrFail(asset.url, `the SBOM asset ${asset.name} of ${tag}`, { accept: "application/octet-stream" })).arrayBuffer();
    let document;
    try {
      document = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      rejected.push(`${asset.name} is not JSON`);
      continue;
    }
    if (document.bomFormat !== "CycloneDX") {
      rejected.push(`${asset.name} is not a CycloneDX document`);
      continue;
    }
    const root = document.metadata?.component ?? {};
    // THE PACKAGE URL AND NOT THE NAME. `npm sbom` fills the root component's
    // `name` from the directory it ran in — "skillonomia", not
    // "@skillonomia/cli" — and puts the registry's own identifier in `purl`.
    // Comparing the field a human would reach for first would refuse every
    // document this project publishes.
    if (purlOf(root) !== `${pkg.name}@${pkg.version}`) {
      rejected.push(`${asset.name} describes ${purlOf(root) ?? `${root.name ?? "?"}@${root.version ?? "?"}`}`);
      continue;
    }
    const hash = (root.hashes ?? []).find((h) => h.alg === "SHA-512");
    if (hash === undefined || hash.content.toLowerCase() !== want) {
      rejected.push(`${asset.name} records ${hash === undefined ? "no SHA-512 for the tarball" : `SHA-512 ${hash.content}`}, and the registry serves ${dist.integrity}`);
      continue;
    }
    return verdict(
      "SBOM",
      pkg.spec,
      "OK",
      `${asset.name} (CycloneDX ${document.specVersion}, ${(document.components ?? []).length} components), bound to ${dist.integrity}`,
    );
  }
  return verdict("SBOM", pkg.spec, "REFUSED", `release ${tag} carries a CycloneDX document that is not this package's: ${rejected.join("; ")}`);
}

async function hardening(argv) {
  const opts = { image: null, npm: null, repo: null, record: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--image" || a === "--npm" || a === "--repo" || a === "--record") {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      if (a === "--image") opts.image = v;
      else if (a === "--npm") opts.npm = v;
      else if (a === "--repo") opts.repo = v;
      else opts.record = resolve(v);
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  if (opts.image === null) usage("`hardening` needs --image <registry>/<image>@sha256:<64 hex>");
  if (opts.npm === null) usage("`hardening` needs --npm <@scope/name@version>");

  const image = parseImageRef(opts.image);
  const pkg = parseNpmSpec(opts.npm);
  // WITHOUT A REPOSITORY THERE IS NO IDENTITY TO CHECK AGAINST, and a signature
  // verified against no identity is a signature by anybody.
  const repo = opts.repo ?? repositorySlug();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) usage(`--repo must be \`owner/name\`, not \`${repo}\``);

  // THE RELEASE THIS GATE IS ABOUT IS THE NPM VERSION'S. One operator-supplied
  // string decides the tag, the ref and the Fulcio identity, and the image is
  // then measured against it — so an image digest from another release cannot
  // define its own expectation and pass.
  const expected = releaseIdentity(repo, pkg.version);
  console.log(`[1/6] the release under test: ${expected.repositoryUrl} ${expected.workflow}@${expected.ref}`);

  console.log(`[2/6] the published index of ${image.ref}`);
  image.token = await registryToken(image);
  const found = await imageStatements(image);
  console.log(
    `      ${found.runtime.length} runtime manifest(s) [${found.runtime.map(platformName).join(", ")}], ` +
      `${found.attestations.length} attestation manifest(s)`,
  );

  console.log(`[3/6] the image's SBOM and provenance, by digest`);
  const imageProv = imageProvenance(image, found, expected);
  const results = [imageSbom(image, found), imageProv];

  console.log(`[4/6] the keyless signature over ${image.digest}`);
  // KEPT, BECAUSE THE IDENTITY LINE DEPENDS ON IT. The image's provenance names
  // no workflow, so the certificate is what does; `releaseIdentityVerdict` is
  // handed this verdict's status and refuses unless it was verified here.
  const imageSig = await imageSignature(image, expected);
  results.push(imageSig);

  console.log(`[5/6] ${pkg.spec} on the npm registry`);
  const dist = (await npmRegistryVersion(pkg)).dist ?? {};
  if (dist.integrity === undefined) fail(`the npm registry reports no integrity for ${pkg.spec}`);
  console.log(`      ${dist.integrity}`);
  const npmProv = await npmProvenance(pkg, dist, expected);
  results.push(npmProv);
  console.log(`      \`npm audit signatures\` on a clean install of ${pkg.spec}`);
  const npmSig = npmSignature(pkg);
  results.push(npmSig);

  console.log(`[6/6] the CycloneDX document published for the tarball`);
  results.push(await npmSbom(pkg, dist, expected));

  // AND THEN THE ONE QUESTION NO PER-ARTIFACT LINE ASKS.
  results.push(releaseIdentityVerdict(expected, imageProv.identity ?? null, npmProv.identity ?? null, imageSig.status));

  // THE VERDICT, ONE LINE PER CHECK AND ONE PER FAMILY. A family is only OK if
  // every artifact that can answer for it did.
  const families = ["SBOM", "signature", "provenance", "identity"];
  console.log("");
  for (const family of families) {
    for (const r of results.filter((x) => x.family === family)) {
      const indent = " ".repeat(27);
      console.log(`  ${family.padEnd(10)} ${r.status.padEnd(13)} ${r.artifact}\n${indent}${r.detail.split("\n").join(`\n${indent}`)}`);
    }
  }
  const failed = families.filter((f) => results.some((r) => r.family === f && r.status !== "OK"));
  // THE FIELD IS A FACT ABOUT THIS RUN, NOT A CONSTANT. It is `true` when, and
  // only when, `npm audit signatures` verified an attestation on the package
  // this gate was handed — and the marker below is refused unless it is.
  const cryptographicallyVerified = npmSig.status === "OK";
  const record = {
    check: "hardening",
    marker: failed.length === 0 && cryptographicallyVerified ? HARDENING_OK : null,
    image: image.ref,
    npm: pkg.spec,
    repository: repo,
    release: { tag: expected.tag, ref: expected.ref, workflow: expected.workflow, certificate_identity: expected.certificateIdentity },
    families: Object.fromEntries(families.map((f) => [f, results.filter((r) => r.family === f).every((r) => r.status === "OK") ? "OK" : "REFUSED"])),
    checks: results,
    cosign_available: spawnSync("cosign", ["version"], { encoding: "utf8" }).error === undefined,
    npm_bundle_cryptographically_verified: cryptographicallyVerified,
  };
  if (opts.record !== null) {
    mkdirSync(dirname(opts.record), { recursive: true });
    writeFileSync(opts.record, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\n      record written: ${opts.record}`);
  }
  console.log("");
  if (failed.length > 0) {
    fail(
      `this digest is not deployable: ${failed.join(", ")} ${failed.length === 1 ? "is" : "are"} not published, or not what a deploy of ${repo} ${expected.tag} may accept. ` +
        "Each line above says which artifact and why.",
    );
  }
  // The marker cannot be reached with an unverified bundle — but a second,
  // explicit refusal here is what keeps that true if a future family stops
  // carrying the npm signature check.
  if (!cryptographicallyVerified) {
    fail(`every family answered OK and \`npm audit signatures\` did not verify ${pkg.spec}; ${HARDENING_OK} is not printed for a bundle nobody verified`);
  }
  console.log(`npm's Sigstore bundle was verified here by \`npm audit signatures\`, on a clean install of ${pkg.spec}.`);
  console.log(HARDENING_OK);
}

// ------------------------------------------------------------------ preflight
//
// THE GATE THAT RUNS BEFORE THE TAG, BECAUSE EVERY OTHER GATE RUNS TOO LATE.
//
//   node ci/mvp-release.mjs preflight --tag v0.1.4 --repo skillonomia/skillonomia
//
// WHAT HAPPENED. `v0.1.3` published its binary, published its image, and then
// `publish-npm` failed:
//
//     npm error code E422
//     Error verifying sigstore provenance bundle: Failed to validate repository
//     information: package.json: "repository.url" is "", expected to match
//     "https://github.com/skillonomia/skillonomia" from provenance
//
// Trusted publishing worked — the job's log carries `npm notice publish Signed
// provenance statement with source and build information from GitHub Actions`.
// The REGISTRY refused, because `package.json` carried no `repository` at all
// and the registry compares that field with the repository the provenance names.
// The cost was a version: a release and an image were already published under
// `v0.1.3` and neither can be withdrawn, so the fix ships as `0.1.4`.
//
// THE DEFECT IS NOT THE MISSING FIELD. Every check in this file reads a
// PUBLISHED artifact — `binary --tag` downloads a release, `ghcr` pulls an
// image, `npm --package <spec>` installs from the registry, `hardening` reads
// both registries back. That is the right thing for each of them to do and it
// means none of them can run until the release exists. So the PRECONDITIONS of
// a publish were examined by nobody until the registry examined them, and by
// then failing is not free: `release.yml` runs `publish-binary`, then
// `publish-image`, then `publish-npm`, and a refusal in the third arrives after
// the first two are irreversible.
//
// WHAT IS ASKED, AND BY WHOM IT WOULD OTHERWISE BE ASKED:
//
//   repository      `package.json`'s repository resolves to the SAME repository
//                   the provenance will name. Otherwise: the npm registry,
//                   E422, after the image is out.
//   version         `package.json`'s version is the tag without its leading
//                   `v`. Otherwise: `release.yml`'s own first step — which is
//                   already correct, and is re-asked here so that ONE command
//                   answers "can this tag be released" for a maintainer holding
//                   an untagged commit.
//   npm-version     the registry does not already serve this version.
//                   Otherwise: `npm publish`, E403, after the image is out.
//   github-release  no release carries this tag yet. Otherwise: `gh release
//                   create`, in the first job — cheap, but it is the same
//                   question and this is where the answer belongs.
//   pack            `npm pack` succeeds at all.
//   tarball         and THE ARCHIVE IT PRODUCED carries that repository and that
//                   version. The registry reads the manifest INSIDE the tarball,
//                   not the working tree, and `files`, `prepack` and a packing
//                   bug are three ways for a tree to be right and an archive to
//                   be wrong. A gate that read the tree would have been
//                   satisfied by a tree that packs to something else.
//   tag-object      the tag resolves to THIS commit and is lightweight.
//                   Otherwise: `hardening`, at the very end, refusing two
//                   genuine artifacts as different releases — see the step of
//                   the same name in `release.yml`, which settles it where the
//                   only cost is a re-tag.
//
// EACH REFUSAL IS ITS OWN LINE WITH ITS OWN REASON, as in `hardening`. A gate
// that answered "not releasable" would send a maintainer to read a workflow
// instead of to the one thing that is wrong.
//
// AND A CHECK THAT COULD NOT BE RUN IS NOT A PASS. A registry that answers 500,
// a network that is not there, a `--repo` that cannot be worked out — each is
// `UNVERIFIABLE` and refuses, for the same reason `cosign` missing refuses in
// `hardening`: the whole content of this stage is that the questions were
// actually asked.

const PREFLIGHT_OK = "RELEASE_PREFLIGHT_OK";
const PREFLIGHT_STAGED = "RELEASE_PREFLIGHT_STAGED_OK";

/**
 * NPM'S RULE, REPRODUCED RATHER THAN APPROXIMATED.
 *
 * Two halves have to agree, and both are readable in npm's own source:
 *
 *   what the provenance says   `libnpmpublish/lib/provenance.js` writes
 *                              `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}` into
 *                              `externalParameters.workflow.repository` — which
 *                              is the `https://github.com/skillonomia/skillonomia`
 *                              the E422 above quoted back at us.
 *   what the manifest says     `repository`, resolved the way `hosted-git-info`
 *                              resolves it: the GitHub shorthand (`owner/name`),
 *                              the shortcut (`github:owner/name`), the scp form
 *                              (`git@github.com:owner/name.git`) and the six
 *                              protocols `hosts.github.protocols` lists, each
 *                              with or without `.git`, with or without a
 *                              `#committish`.
 *
 * The three functions below are that library's `from-url.js` and `parse-url.js`,
 * narrowed to the one host this project publishes from. They are copied because
 * `hosted-git-info` is not a dependency of this package and adding one to run a
 * pre-tag check would put a package in every consumer's install tree.
 *
 * THE ASYMMETRY IS DELIBERATE. A form this parser refuses and npm would have
 * accepted costs a maintainer one edit before a tag. A form this parser accepts
 * and npm refuses costs a version. So anything that does not resolve to
 * github.com through one of those shapes is refused and named, rather than
 * passed through on the chance that the registry is more forgiving.
 */
const GITHUB_PROTOCOLS = ["git:", "http:", "git+ssh:", "git+https:", "ssh:", "https:"];
/** Every scheme hosted-git-info recognises; used only to decide URL repair. */
const KNOWN_PROTOCOLS = [
  "git+ssh:", "ssh:", "git+https:", "git:", "http:", "https:", "git+http:",
  "github:", "bitbucket:", "gitlab:", "gist:", "sourcehut:",
];

/** `owner/name` with no protocol, no space, no second slash — `from-url.js`. */
function isGitHubShorthand(arg) {
  const firstHash = arg.indexOf("#");
  const firstSlash = arg.indexOf("/");
  const secondSlash = arg.indexOf("/", firstSlash + 1);
  const firstColon = arg.indexOf(":");
  const firstSpace = /\s/.exec(arg);
  const firstAt = arg.indexOf("@");
  const spaceOnlyAfterHash = !firstSpace || (firstHash > -1 && firstSpace.index > firstHash);
  const atOnlyAfterHash = firstAt === -1 || (firstHash > -1 && firstAt > firstHash);
  const colonOnlyAfterHash = firstColon === -1 || (firstHash > -1 && firstColon > firstHash);
  const secondSlashOnlyAfterHash = secondSlash === -1 || (firstHash > -1 && secondSlash > firstHash);
  const doesNotEndWithSlash = firstHash > -1 ? arg[firstHash - 1] !== "/" : !arg.endsWith("/");
  return (
    spaceOnlyAfterHash && firstSlash > 0 && doesNotEndWithSlash && !arg.startsWith(".") &&
    atOnlyAfterHash && colonOnlyAfterHash && secondSlashOnlyAfterHash
  );
}

/** `parse-url.js`: the two repairs that make an scp-style ref parse as a URL. */
function looseUrl(giturl) {
  const safe = (u) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  };
  const lastIndexOfBefore = (str, char, before) => {
    const at = str.indexOf(before);
    return str.lastIndexOf(char, at > -1 ? at : Infinity);
  };
  const firstColon = giturl.indexOf(":");
  let withProtocol;
  if (KNOWN_PROTOCOLS.includes(giturl.slice(0, firstColon + 1))) withProtocol = giturl;
  else if (giturl.indexOf("@") > -1) withProtocol = giturl.indexOf("@") > firstColon ? `git+ssh://${giturl}` : giturl;
  else if (giturl.indexOf("//") === firstColon + 1) withProtocol = giturl;
  else withProtocol = `${giturl.slice(0, firstColon + 1)}//${giturl.slice(firstColon + 1)}`;

  const direct = safe(withProtocol);
  if (direct !== null) return direct;
  let repaired = withProtocol;
  const firstAt = lastIndexOfBefore(repaired, "@", "#");
  const lastColon = lastIndexOfBefore(repaired, ":", "#");
  if (lastColon > firstAt) repaired = `${repaired.slice(0, lastColon)}/${repaired.slice(lastColon + 1)}`;
  if (lastIndexOfBefore(repaired, ":", "#") === -1 && repaired.indexOf("//") === -1) repaired = `git+ssh://${repaired}`;
  return safe(repaired);
}

/**
 * A manifest's `repository` → `https://github.com/<owner>/<name>`, or the
 * sentence that says why it is not one. `repository` may be the object form or
 * the string form; both are what npm reads.
 */
export function repositoryOf(repository) {
  const raw =
    typeof repository === "string"
      ? repository
      : repository !== null && typeof repository === "object" && !Array.isArray(repository)
        ? repository.url
        : undefined;
  if (repository === undefined || repository === null) {
    return { raw: null, url: null, fault: "there is no `repository` field at all" };
  }
  if (typeof raw !== "string") {
    return { raw: null, url: null, fault: `\`repository\` is ${JSON.stringify(repository)}, which carries no \`url\` string` };
  }
  if (raw.trim() === "") {
    return { raw, url: null, fault: '`repository.url` is ""' };
  }
  const corrected = isGitHubShorthand(raw) ? `github:${raw}` : raw;
  const parsed = looseUrl(corrected);
  if (parsed === null) {
    return { raw, url: null, fault: `\`repository.url\` is ${JSON.stringify(raw)}, which is not a URL npm can resolve` };
  }
  const host = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : parsed.hostname;
  let user;
  let project;
  if (parsed.protocol === "github:") {
    // the shortcut: everything after any auth, and the last slash splits it
    let pathname = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
    const at = pathname.indexOf("@");
    if (at > -1) pathname = pathname.slice(at + 1);
    const lastSlash = pathname.lastIndexOf("/");
    if (lastSlash === -1) return { raw, url: null, fault: `\`repository.url\` is ${JSON.stringify(raw)}, which names no owner` };
    user = decodeURIComponent(pathname.slice(0, lastSlash));
    project = decodeURIComponent(pathname.slice(lastSlash + 1));
  } else {
    if (host !== "github.com") {
      return { raw, url: null, fault: `\`repository.url\` is ${JSON.stringify(raw)}, whose host is ${parsed.hostname}; the provenance names a github.com repository` };
    }
    if (!GITHUB_PROTOCOLS.includes(parsed.protocol)) {
      return { raw, url: null, fault: `\`repository.url\` is ${JSON.stringify(raw)}, and \`${parsed.protocol}\` is not one of the schemes npm resolves for github.com (${GITHUB_PROTOCOLS.join(" ")})` };
    }
    // `hosts.github.extract`: /<user>/<project>[/tree/<committish>]
    const [, u, p, type] = parsed.pathname.split("/", 5);
    if (type !== undefined && type !== "" && type !== "tree") {
      return { raw, url: null, fault: `\`repository.url\` is ${JSON.stringify(raw)}, whose path is not \`/<owner>/<name>\`` };
    }
    user = u === undefined ? "" : decodeURIComponent(u);
    project = p === undefined ? "" : decodeURIComponent(p);
  }
  if (project.endsWith(".git")) project = project.slice(0, -4);
  if (!user || !project) {
    return { raw, url: null, fault: `\`repository.url\` is ${JSON.stringify(raw)}, which does not name both an owner and a repository` };
  }
  return { raw, url: `https://github.com/${user}/${project}`, fault: null };
}

/** One line of the preflight table. Same shape as `hardening`'s verdicts. */
const check = (name, status, detail) => ({ check: name, status, detail });

/**
 * THE ONE THAT COST A VERSION. `expected` is the repository URL the provenance
 * will carry, so this compares exactly the two strings the registry compares.
 */
export function repositoryCheck(manifest, expected, where) {
  const r = repositoryOf(manifest.repository);
  if (r.url === null) {
    return check(
      "repository",
      "REFUSED",
      `${where}: ${r.fault}. The npm registry compares this field with ${expected} from the provenance and refuses ` +
        "the publish with `E422 Error verifying sigstore provenance bundle: Failed to validate repository information` " +
        '— add `"repository": { "type": "git", "url": "git+' + `${expected}.git" }\`.`,
    );
  }
  if (r.url !== expected) {
    return check(
      "repository",
      "REFUSED",
      `${where}: \`repository.url\` is ${JSON.stringify(r.raw)}, which resolves to ${r.url}; the provenance will say ${expected}. ` +
        "Two different repositories is what E422 reports, and it reports it after the other artifacts are published.",
    );
  }
  return check("repository", "OK", `${where}: ${JSON.stringify(r.raw)} resolves to ${r.url}`);
}

/** The tag is `v` and the version, and the version is the manifest's. */
export function versionCheck(version, tag) {
  if (tag === null) {
    return check("version", "SKIPPED", `no tag was given and none is in the environment, so \`${version}\` was not compared with one`);
  }
  if (!/^v\d+\.\d+\.\d+/.test(tag)) {
    return check("version", "REFUSED", `\`${tag}\` is not a version tag; \`release.yml\` runs on \`v*.*.*\` and on nothing else`);
  }
  if (tag.slice(1) !== version) {
    return check("version", "REFUSED", `the tag is \`${tag}\` and \`package.json\` declares \`${version}\`; a release cannot carry a version its own manifest disagrees with`);
  }
  return check("version", "OK", `\`${tag}\` is \`${version}\``);
}

/**
 * A VERSION IS SPENT ONCE. `packument` is the registry's document for the
 * package, or `null` when the registry has never heard of it — which is the
 * commonest passing answer for a package's first release and is not an error.
 */
export function npmVersionCheck(spec, version, packument) {
  if (packument === null) return check("npm-version", "OK", `the registry serves no ${spec} at all, so ${version} is free`);
  const versions = Object.keys(packument.versions ?? {});
  if (versions.includes(version)) {
    return check(
      "npm-version",
      "REFUSED",
      `the registry already serves ${spec}@${version} — npm refuses a second publish of a version with \`E403 You cannot publish over the previously published versions\`. ` +
        `Published: ${versions.join(", ")}.`,
    );
  }
  return check("npm-version", "OK", `the registry serves ${versions.join(", ") || "no versions"}, and not ${version}`);
}

/** A release is created, never amended — so the tag must carry none yet. */
export function releaseCheck(repo, tag, status) {
  if (status === 404) return check("github-release", "OK", `${repo} has no release tagged ${tag}`);
  if (status === 200) {
    return check(
      "github-release",
      "REFUSED",
      `${repo} already has a release tagged ${tag}. \`release.yml\` creates releases and never amends them, and a tag whose release exists is a version that has been spent.`,
    );
  }
  return check(
    "github-release",
    "UNVERIFIABLE",
    `asking whether ${repo} has a release tagged ${tag} answered ${status}. Whether this tag is free was not established, and a question that was not answered is not a pass.`,
  );
}

/** What the archive says, which is what the registry will read. */
export function tarballCheck(manifest, expected, version, name) {
  const faults = [];
  const repository = repositoryCheck(manifest, expected, `${name}: package/package.json`);
  if (repository.status !== "OK") faults.push(repository.detail);
  if (manifest.version !== version) {
    faults.push(`${name}: package/package.json declares version ${JSON.stringify(manifest.version ?? null)} and the working tree declares ${version}`);
  }
  if (faults.length > 0) return check("tarball", "REFUSED", faults.join("; "));
  return check("tarball", "OK", `${name} carries ${JSON.stringify(manifest.repository)} and version ${manifest.version}`);
}

/**
 * A LIGHTWEIGHT TAG ON THIS COMMIT, AND NOTHING ELSE. `kind` and `sha` are what
 * git said the tag resolves to; `head` is this checkout's commit. Both the
 * annotated case and the wrong-commit case end the same way — two provenances
 * naming two shas, refused by `hardening` after everything is published.
 */
export function tagObjectCheck(tag, kind, sha, head) {
  if (kind === null) {
    return check("tag-object", "SKIPPED", `this checkout has no \`refs/tags/${tag}\`, so what it resolves to could not be read here`);
  }
  if (kind !== "commit") {
    return check(
      "tag-object",
      "REFUSED",
      `\`refs/tags/${tag}\` is a ${kind} object (${sha}), not a commit. The image's provenance records what the ref resolves to and npm's records the commit, so both artifacts would be published and then refused as different releases. ` +
        `Re-tag with a lightweight tag: \`git tag -d ${tag} && git tag ${tag} ${head} && git push --force origin ${tag}\`.`,
    );
  }
  if (sha !== head) {
    return check("tag-object", "REFUSED", `\`refs/tags/${tag}\` is commit ${sha} and this checkout is at ${head}; the release would publish a tree nobody checked here`);
  }
  return check("tag-object", "OK", `\`refs/tags/${tag}\` is the lightweight tag of ${sha}, which is HEAD`);
}

/** The registry's document for a package, or null when it has none. */
async function packumentOf(name) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, { headers: { "user-agent": UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the npm registry answered ${res.status} ${res.statusText} for ${name}`);
  return await res.json();
}

/** `npm pack`, into a directory of its own, and the manifest it produced. */
function packed(expected, version) {
  const where = mkdtempSync(join(tmpdir(), "skillonomia-preflight-"));
  try {
    const r = spawnSync("npm", ["pack", "--pack-destination", where], { cwd: ROOT, encoding: "utf8" });
    if (r.error !== undefined) return [check("pack", "UNVERIFIABLE", `\`npm pack\` could not be run: ${r.error.message}`), check("tarball", "UNVERIFIABLE", "there is no tarball to read")];
    if (r.status !== 0) {
      return [
        check("pack", "REFUSED", `\`npm pack\` exited ${r.status}, so there is nothing for \`npm publish\` to upload:\n${redact(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim()}`),
        check("tarball", "UNVERIFIABLE", "there is no tarball to read"),
      ];
    }
    const made = readdirSync(where).filter((f) => f.endsWith(".tgz"));
    if (made.length !== 1) {
      return [check("pack", "REFUSED", `\`npm pack\` left [${made.join(", ")}] and a publish uploads exactly one tarball`), check("tarball", "UNVERIFIABLE", "there is no single tarball to read")];
    }
    const tgz = join(where, made[0]);
    const listed = spawnSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" });
    if (listed.status !== 0) {
      return [
        check("pack", "OK", `${made[0]}, sha256 ${sha256File(tgz)}`),
        check("tarball", "REFUSED", `${made[0]} carries no \`package/package.json\`, which is the manifest the registry reads`),
      ];
    }
    let manifest;
    try {
      manifest = JSON.parse(listed.stdout);
    } catch {
      return [check("pack", "OK", `${made[0]}, sha256 ${sha256File(tgz)}`), check("tarball", "REFUSED", `${made[0]}'s \`package/package.json\` is not JSON`)];
    }
    return [check("pack", "OK", `${made[0]}, sha256 ${sha256File(tgz)}`), tarballCheck(manifest, expected, version, made[0])];
  } finally {
    rmSync(where, { recursive: true, force: true });
  }
}

/** What `refs/tags/<tag>` is in this checkout, or nulls when it is not here. */
function tagObject(tag) {
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return { kind: null, sha: null, head: null };
  const ref = spawnSync("git", ["-C", ROOT, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { encoding: "utf8" });
  if (ref.status !== 0) return { kind: null, sha: null, head: head.stdout.trim() };
  const sha = ref.stdout.trim();
  const kind = spawnSync("git", ["-C", ROOT, "cat-file", "-t", sha], { encoding: "utf8" });
  return { kind: kind.status === 0 ? kind.stdout.trim() : null, sha, head: head.stdout.trim() };
}

async function preflight(argv) {
  const opts = { tag: null, repo: null, record: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tag" || a === "--repo" || a === "--record") {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      if (a === "--tag") opts.tag = v;
      else if (a === "--repo") opts.repo = v;
      else opts.record = resolve(v);
      i += 1;
    } else usage(`unknown option ${a}`);
  }
  const repo = opts.repo ?? repositorySlug();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) usage(`--repo must be \`owner/name\`, not \`${repo}\``);
  // The provenance's `workflow.repository` is `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`,
  // and that whole string — not the slug — is what the registry compares.
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const expected = `${server}/${repo}`;
  // A workflow that forgot `--tag` would otherwise rehearse instead of check.
  const fromEnv = process.env.GITHUB_REF_NAME ?? "";
  const tag = opts.tag ?? (/^v\d+\.\d+\.\d+/.test(fromEnv) ? fromEnv : null);

  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = manifest.version;
  const results = [];

  console.log(`[1/5] \`package.json\` names the repository the provenance will name`);
  results.push(repositoryCheck(manifest, expected, "package.json"));

  console.log(`[2/5] the tag and the version are one release`);
  results.push(versionCheck(version, tag));

  console.log(`[3/5] nothing has been published as ${manifest.name}@${version} yet`);
  try {
    results.push(npmVersionCheck(manifest.name, version, await packumentOf(manifest.name)));
  } catch (err) {
    results.push(check("npm-version", "UNVERIFIABLE", `whether ${manifest.name}@${version} is already published was not established: ${err.message}`));
  }
  const releaseTag = tag ?? `v${version}`;
  try {
    const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const res = await fetch(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`, {
      headers: {
        "user-agent": UA,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    results.push(releaseCheck(repo, releaseTag, res.status));
  } catch (err) {
    results.push(check("github-release", "UNVERIFIABLE", `asking whether ${repo} has a release tagged ${releaseTag} failed: ${err.message}`));
  }

  console.log(`[4/5] \`npm pack\`, and the manifest inside the tarball it made`);
  results.push(...packed(expected, version));

  console.log(`[5/5] \`refs/tags/${releaseTag}\``);
  const at = tagObject(releaseTag);
  results.push(tagObjectCheck(releaseTag, at.kind, at.sha, at.head));

  console.log("");
  for (const r of results) {
    const indent = " ".repeat(27);
    console.log(`  ${r.check.padEnd(15)} ${r.status.padEnd(9)} ${r.detail.split("\n").join(`\n${indent}`)}`);
  }
  console.log("");

  const failed = results.filter((r) => r.status !== "OK" && r.status !== "SKIPPED");
  const skipped = results.filter((r) => r.status === "SKIPPED");
  const record = {
    check: "preflight",
    marker: failed.length === 0 ? (skipped.length === 0 ? PREFLIGHT_OK : PREFLIGHT_STAGED) : null,
    repository: repo,
    expected_repository_url: expected,
    package: `${manifest.name}@${version}`,
    tag: releaseTag,
    tag_given: tag,
    checks: results,
  };
  if (opts.record !== null) {
    mkdirSync(dirname(opts.record), { recursive: true });
    writeFileSync(opts.record, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`      record written: ${opts.record}`);
  }
  if (failed.length > 0) {
    fail(
      `this tree cannot be released as ${releaseTag}: ${failed.map((r) => r.check).join(", ")} ${failed.length === 1 ? "is" : "are"} not what a publish needs. ` +
        "Each line above says which one and why — and every one of them is free to fix here, which is the point of asking before the tag.",
    );
  }
  if (skipped.length > 0) {
    // A rehearsal never prints an acceptance marker: the same rule `binary
    // --local` follows. What was not asked is named, so the marker cannot be
    // read as "everything was checked".
    console.log(`not asked here: ${skipped.map((r) => r.check).join(", ")}. The release runs this with a tag, where they are.`);
    console.log(PREFLIGHT_STAGED);
    return;
  }
  console.log(PREFLIGHT_OK);
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
  const SUBCOMMANDS = { binary, ghcr, npm: npmCli, platform, hardening, preflight };
  const chosen = SUBCOMMANDS[subcommand];
  if (chosen === undefined) usage(`unknown subcommand \`${subcommand}\` — one of ${Object.keys(SUBCOMMANDS).join(", ")}`);
  await chosen(rest);
}
