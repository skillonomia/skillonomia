#!/usr/bin/env node
// THE RELEASE-ARTIFACT CHECKS — one script, one subcommand per published thing.
//
//   node ci/mvp-release.mjs binary --tag v0.1.1   # the release path: download, then smoke
//   node ci/mvp-release.mjs binary --local        # the rehearsal: package, then smoke
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
/** §7 performance budget: `/health` answers within this after a start. */
const HEALTH_TIMEOUT_MS = 120_000;

const USAGE = `usage:
  node ci/mvp-release.mjs binary --tag <tag>   download the release assets and smoke them outside this checkout
  node ci/mvp-release.mjs binary --local       package the assets from this checkout and smoke them the same way

options:
  --out <dir>   where the packaged assets are written (default: dist/release)
  --keep        do not remove the temporary directory the archive is unpacked into
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

// --------------------------------------------------------------------- main

const [subcommand, ...rest] = process.argv.slice(2);
if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
  process.stdout.write(USAGE);
  process.exit(subcommand === undefined ? 2 : 0);
}
if (subcommand !== "binary") usage(`unknown subcommand \`${subcommand}\``);
await binary(rest);
