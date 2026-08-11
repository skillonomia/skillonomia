// P7 — release: the §9.1 quickstart as an executable test, the seed package,
// single-user demo mode, `/health`, and the metadata the three release
// packaging paths depend on.
//
// The CI job `quickstart-e2e` runs the SAME scenario against the container
// image with a wall-clock budget (ci/quickstart-docker.sh). This file runs it
// against a real listener in-process, so the scenario is covered on both
// runtimes and on every push, not only where Docker is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, BOOTSTRAP_FILENAME, VERSION } from "../src/server.ts";
import { sha256Hex } from "../src/auth.ts";
import { assetRoot } from "../src/assets.ts";
import { SEED_AGENT_ID, SEED_KID, SEED_SLUG, SEED_PUBLIC_KEY, demoMode, seedArchive } from "../src/seed.ts";
import { verifyPackage } from "../src/verify.ts";
import { readTar } from "../src/archive.ts";
import { insertAgent } from "./helpers.ts";

const ENV_DESCRIPTOR = {
  runtime: { id: "any", version: "1.0.0" },
  model: { id: "any", version: "1.0.0" },
  tools: [{ id: "shell", version: "1.0.0" }],
  os: "linux",
  shell: "bash",
  sandbox_capable: false,
};

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "sklo-p7-"));
}

/**
 * The random part of a credential — everything after its `bt_`/`sk_` prefix.
 *
 * `_` is a character of the base64url alphabet, so `secret.split("_").pop()`
 * does not strip a prefix: on the ~50% of draws whose random part contains an
 * underscore it returns a SUFFIX of the secret, and when that suffix is short
 * its decoded bytes are found in any database file by coincidence. That is
 * what made "not in the database" fail roughly one run in fifteen with no
 * change to the software under test.
 */
function randomPart(secret: string): string {
  const m = /^(?:bt|sk)_([A-Za-z0-9_-]+)$/.exec(secret);
  assert.ok(m, `credential does not have the expected prefix_base64url shape: ${secret.slice(0, 6)}…`);
  return m[1];
}

/** A listener on an ephemeral port, with the delivery worker disabled unless asked. */
function instance(opts: Parameters<typeof serve>[0] = {}) {
  const lines: string[] = [];
  const inst = serve({
    port: 0,
    host: "127.0.0.1",
    dataDir: dataDir(),
    workerIntervalMs: 0,
    log: (l) => lines.push(l),
    ...opts,
  });
  const address = async (): Promise<string> => {
    if (!inst.server.listening) await once(inst.server, "listening");
    const addr = inst.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : inst.port;
    return `http://127.0.0.1:${port}`;
  };
  return { inst, lines, address };
}

async function api(
  base: string,
  method: string,
  path: string,
  key?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length ? JSON.parse(text) : null };
}

// ------------------------------------------------------------------- §9.1 E2E

test("§9.1 quickstart: clean start → seed found → adoption → fixture → terminal `adopted` receipt", async () => {
  const { inst, address } = instance();
  const base = await address();
  try {
    // 9.1.2/9.1.5 — two one-time credentials at first start
    assert.ok(inst.credentials, "first start issued credentials");
    const { bootstrap_owner_token: bootToken, demo_adopter_token: demoKey } = inst.credentials!;
    assert.match(bootToken, /^bt_/);
    assert.match(demoKey, /^sk_/);

    // 9.1.6.1 — exchange for the owner key; the token is one-time
    const owner = await api(base, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: bootToken });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.role, "owner");
    const ownerKey = owner.body.api_key as string;
    const replay = await api(base, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: bootToken });
    assert.equal(replay.status, 401, "the bootstrap token cannot be exchanged twice");

    // 9.1.6.2 — the seed is there, reviewed
    const search = await api(base, "GET", "/v1/skills?q=hello-skillonomia", ownerKey);
    assert.equal(search.status, 200);
    assert.equal(search.body.items[0].slug, SEED_SLUG);
    assert.equal(search.body.items[0].state, "reviewed");
    const versionId = search.body.items[0].skill_version_id;

    // 9.1.6.3 — request adoption as the demo adopter
    const req = await api(base, "POST", "/v1/adoptions/requests", demoKey, {
      skill_version_id: versionId,
      idempotency_key: "qs-1",
    });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const { adoption_request_id: requestId, receipt_id: receiptId } = req.body;

    // 9.1.6.4 — adopt: delivered, event_seq 2 (seq 1 is the `requested` event
    // that opened this chain), compat match, package handed over
    const adopt = await api(base, "POST", `/v1/adoptions/${requestId}/adopt`, demoKey, {
      environment_descriptor: ENV_DESCRIPTOR,
      idempotency_key: "qs-2",
    });
    assert.equal(adopt.status, 200, JSON.stringify(adopt.body));
    assert.equal(adopt.body.receipt_event, "delivered");
    assert.equal(adopt.body.event_seq, 2);
    assert.equal(adopt.body.compat.result, "match");

    // 9.1.6.5 — the fixture the package hands over is the one the gate names
    const files = readTar(Buffer.from(adopt.body.package.archive_base64, "base64"));
    assert.equal(files.get("fixtures/tv01.sh")!.toString("utf8").trim(), "echo skillonomia-tv01-ok");

    const attempted = await api(base, "POST", `/v1/receipts/${receiptId}/events`, demoKey, {
      event: "attempted",
      idempotency_key: "qs-3",
    });
    assert.equal(attempted.body.event_seq, 3);
    const adopted = await api(base, "POST", `/v1/receipts/${receiptId}/events`, demoKey, {
      event: "adopted",
      evidence: { gate_results: [{ gate_id: "g1", pass: true, observed: "skillonomia-tv01-ok" }] },
      idempotency_key: "qs-4",
    });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.receipt_event, "adopted");
    assert.equal(adopted.body.event_seq, 4);

    const receipt = await api(base, "GET", `/v1/receipts/${receiptId}`, demoKey);
    assert.equal(receipt.body.derived_state, "adopted");
  } finally {
    inst.close();
  }
});

test("a restart re-opens the same deployment: no new credentials, no second seed", async () => {
  const dir = dataDir();
  const first = instance({ dataDir: dir });
  const seedVersion = first.inst.seed!.skill_version_id;
  first.inst.close();

  const second = instance({ dataDir: dir });
  try {
    assert.equal(second.inst.credentials, null, "credentials are never re-issued");
    assert.equal(second.inst.seed, null, "the seed is installed once");
    const count = second.inst.db
      .prepare("SELECT COUNT(*) AS c FROM skill_versions WHERE skill_id=?")
      .get("01SEEDPACKAGE0000000000000") as { c: number };
    assert.equal(count.c, 1);
    assert.equal(
      (second.inst.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(seedVersion) as any).state,
      "reviewed",
      "the seed survived the restart in the state it was installed in",
    );
  } finally {
    second.inst.close();
  }
});

// ---------------------------------------------------------- §9.1 bootstrap
//
// The BOOTSTRAP_OWNER_TOKEN used to live only in the process that printed it.
// Everything else about the first start was committed — the workspace, the
// owner principal, the demo adopter — so `bootstrapInstance` would never run
// again and never re-issue, while the only credential that could mint the
// owner's key went with the process. A restart between the first start and the
// exchange left a deployment with no owner key and no way back except deleting
// the data directory. With the README's quickstart now being "start it, then
// follow the transcript", any restart in between broke it.
//
// The outstanding token's SHA-256 is therefore durable. The plaintext is not,
// anywhere: not in the file, not in SQLite, and not in a log line after the one
// §9.1 requires at the first start.

test("the bootstrap token survives a restart before the exchange", async () => {
  const dir = dataDir();
  const first = instance({ dataDir: dir });
  const token = first.inst.credentials!.bootstrap_owner_token;
  const demoToken = first.inst.credentials!.demo_adopter_token;
  first.inst.close(); // a restart BEFORE the exchange — the case that stranded it

  const second = instance({ dataDir: dir });
  try {
    assert.equal(second.inst.credentials, null, "nothing is re-issued");
    assert.equal(second.inst.registry.bootstrapOutstanding(), true, "but the token is still outstanding");
    // the restart says so, and does NOT reprint the token
    assert.ok(second.lines.some((l) => l.includes("BOOTSTRAP_OWNER_TOKEN is still outstanding")));
    assert.ok(!second.lines.join("\n").includes(token), "a restart never reprints the token");

    const base = await second.address();
    const res = await api(base, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.role, "owner");
    assert.match(res.body.api_key, /^sk_own_/);
    assert.equal(second.inst.registry.bootstrapOutstanding(), false, "and it is spent");

    // the owner key it minted actually works
    const me = await api(base, "GET", "/v1/principals", res.body.api_key);
    assert.equal(me.status, 200);
    assert.ok(demoToken.startsWith("sk_"));
  } finally {
    second.inst.close();
  }
});

test("the exchange is still one-time, and stays spent across a restart", async () => {
  const dir = dataDir();
  const first = instance({ dataDir: dir });
  const token = first.inst.credentials!.bootstrap_owner_token;
  const base1 = await first.address();
  const ok = await api(base1, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: token });
  assert.equal(ok.status, 200);
  const again = await api(base1, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: token });
  assert.equal(again.status, 401, "a second exchange in the same process");
  first.inst.close();

  const second = instance({ dataDir: dir });
  try {
    assert.equal(second.inst.registry.bootstrapOutstanding(), false);
    assert.ok(
      !second.lines.some((l) => l.includes("still outstanding")),
      "a spent token is not announced as outstanding",
    );
    const base2 = await second.address();
    const replay = await api(base2, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: token });
    assert.equal(replay.status, 401, "durability must not resurrect a spent token");
    assert.equal(
      (second.inst.db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE id IS NOT NULL").get() as { c: number }).c,
      2,
      "one demo-adopter key and one owner key — the replay minted nothing",
    );
  } finally {
    second.inst.close();
  }
});

test("the token is never at rest in the clear: not in the file, not in the database", async () => {
  const dir = dataDir();
  const { inst, lines } = instance({ dataDir: dir });
  try {
    const token = inst.credentials!.bootstrap_owner_token;
    const demo = inst.credentials!.demo_adopter_token;
    const statePath = join(dir, BOOTSTRAP_FILENAME);
    const raw = readFileSync(statePath, "utf8");

    assert.ok(!raw.includes(token), "the bootstrap state file holds no plaintext token");
    assert.equal(JSON.parse(raw).tokenHash, sha256Hex(token), "it holds its sha256, which cannot reproduce it");
    assert.equal(statSync(statePath).mode & 0o777, 0o600, "and it is not world-readable");

    // §9.1 requires the token on stdout exactly once, at the first start —
    // that line, and no other, may carry it
    assert.equal(lines.filter((l) => l.includes(token)).length, 1);
    assert.equal(lines.filter((l) => l.includes(demo)).length, 1);

    // Neither credential is anywhere in the database, in any encoding the bytes
    // would reveal. The write-ahead log and its index count as the database:
    // Bun's `close()` leaves committed pages in the `-wal` where Node's
    // checkpoints them, and a secret sitting in a sidecar is a secret at rest.
    inst.db.close();
    const bytes = Buffer.concat(
      ["skillonomia.db", "skillonomia.db-wal", "skillonomia.db-shm"]
        .map((f) => join(dir, f))
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f)),
    );
    for (const secret of [token, demo]) {
      assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `${secret.slice(0, 6)}… is not in the database`);
      const raw = Buffer.from(randomPart(secret), "base64url");
      // The decoded secret is the whole 32 bytes `mintApiKey`/`issueBootstrap`
      // draw, asserted here so a future truncation of the expression above
      // cannot quietly turn this line into a search for a byte or two.
      assert.equal(raw.length, 32, "the decoded credential is the full 32-byte draw");
      assert.equal(bytes.includes(raw), false, "nor its decoded bytes");
    }
    // what IS there is the hash of the demo key, which is how §3 works
    assert.ok(bytes.includes(Buffer.from(sha256Hex(demo), "utf8")), "the api_keys row holds the key's sha256");
  } finally {
    inst.server.close();
  }
});

// ------------------------------------------------------------------- /health

test("GET /health answers before any credential exists, and carries no instance data", async () => {
  const { inst, address } = instance();
  const base = await address();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: "ok", service: "skillonomia", version: VERSION });
    // the smoke path is unauthenticated on purpose; everything else is not
    assert.equal((await fetch(`${base}/v1/skills`)).status, 401);
  } finally {
    inst.close();
  }
});

// ------------------------------------------------------------------ §9.1 seed

test("the seed package is genuinely signed by the baked-in kid and reaches `reviewed` through the surfaces", () => {
  const { inst } = instance();
  try {
    const db = inst.db;
    const seed = inst.seed!;
    // it was LINTED, not written into a state: a complete clean gate run exists
    const reports = db
      .prepare("SELECT gate, result FROM lint_reports WHERE skill_version_id=?")
      .all(seed.skill_version_id) as Array<{ gate: string; result: string }>;
    assert.equal(reports.length, 8, "all eight §7.1 gates ran on the seed");
    assert.ok(!reports.some((r) => r.result === "fail"), "the seed package passes every gate");

    // …and REVIEWED by the owner, with the reviewer attestation §6 requires
    const attestations = db
      .prepare("SELECT COUNT(*) AS c FROM attestations WHERE skill_version_id=? AND kind='reviewer'")
      .get(seed.skill_version_id) as { c: number };
    assert.equal(attestations.c, 1);
    assert.equal(seed.state, "reviewed");

    // the author is the seed principal, and that principal holds NO API key
    const version = db.prepare("SELECT author_agent_id FROM skill_versions WHERE id=?").get(seed.skill_version_id) as any;
    assert.equal(version.author_agent_id, SEED_AGENT_ID);
    const keys = db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE agent_id=?").get(SEED_AGENT_ID) as { c: number };
    assert.equal(keys.c, 0, "the seed identity is not a usable credential");

    // the signature verifies against the key baked into the image
    const key = db.prepare("SELECT kid, public_key_ed25519 FROM signing_keys WHERE agent_id=?").get(SEED_AGENT_ID) as any;
    assert.equal(key.kid, SEED_KID);
    assert.equal(key.public_key_ed25519, SEED_PUBLIC_KEY);
    // §4.4 over the shipped bytes, resolving the kid through this instance's
    // own signing_keys row — the one the image baked in
    // §4.4 over the shipped bytes: signature, kid binding and integrity all
    // check out against this instance's own signing_keys row, and the only
    // thing the algorithm still withholds is the lifecycle state (§4.4.8) —
    // a `reviewed` version is not a published one.
    const verdict = verifyPackage(readTar(seedArchive()), db);
    assert.equal(verdict.verdict, "not_verified", JSON.stringify(verdict));
    assert.equal(verdict.detail, "state=reviewed");
    // …and the check discriminates: one flipped content byte is a crypto failure
    const tampered = readTar(seedArchive());
    tampered.set("fixtures/tv01.sh", Buffer.from("echo backdoored\n", "utf8"));
    const bad = verifyPackage(tampered, db);
    assert.ok(["TAMPERED_CONTENT", "BAD_SIGNATURE"].includes(bad.verdict), JSON.stringify(bad));
  } finally {
    inst.close();
  }
});

// --------------------------------------------------------------- §9.1 demo mode

test("§9.1 demo mode is on with one human principal, ends with the second, and is labelled on the dashboard", async () => {
  const { inst, address, lines } = instance();
  const base = await address();
  try {
    assert.equal(demoMode(inst.db), true);
    assert.ok(lines.some((l) => l.includes("demo mode")), "first start says so on stdout");

    const owner = await api(base, "POST", "/v1/auth/bootstrap", undefined, {
      bootstrap_token: inst.credentials!.bootstrap_owner_token,
    });
    const ownerKey = owner.body.api_key as string;
    const before = await api(base, "GET", "/v1/dashboard/library", ownerKey);
    assert.equal(before.body.demo_mode, true);
    const html = await (await fetch(`${base}/v1/dashboard/library?format=html`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    })).text();
    assert.match(html, /DEMO MODE/, "prominently labelled on the dashboard (§9.1)");

    // a SECOND human principal ends demo mode automatically
    insertAgent(inst.db, inst.credentials!.workspace_id, "second-human", "human", Date.now());
    assert.equal(demoMode(inst.db), false);
    const after = await api(base, "GET", "/v1/dashboard/library", ownerKey);
    assert.equal(after.body.demo_mode, false);
    const html2 = await (await fetch(`${base}/v1/dashboard/library?format=html`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    })).text();
    assert.ok(!html2.includes("DEMO MODE"));
  } finally {
    inst.close();
  }
});

// ------------------------------------------------------------------ packaging

test("packaging: the three release paths are declared, and each ships the runtime assets", () => {
  const root = assetRoot();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  // the packaged-tarball path. V1 publishes nothing, so this is the shape a
  // `npm pack` + local install exercises, not a claim that `npx skillonomia`
  // reaches this software (§1: that name on the public registry is somebody
  // else's placeholder).
  assert.equal(pkg.bin.skillonomia, "bin/skillonomia.js");
  assert.ok(existsSync(join(root, "bin", "skillonomia.js")));
  for (const dir of ["src/", "migrations/", "schema/", "seed/"]) {
    assert.ok(pkg.files.includes(dir), `the published tarball ships ${dir}`);
  }
  // the launcher must be executable, or the installed package fails on a clean box
  assert.ok(statSync(join(root, "bin", "skillonomia.js")).mode & 0o111, "bin/skillonomia.js is executable");

  // docker path
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  for (const dir of ["src", "migrations", "schema", "seed"]) {
    assert.match(dockerfile, new RegExp(`COPY ${dir} `), `the image copies ${dir}`);
  }
  assert.match(dockerfile, /HEALTHCHECK/, "the image declares the /health smoke its liveness contract is");
  assert.match(dockerfile, /EXPOSE 7431/);

  // binary path — the compile step also stages the assets next to the binary
  assert.match(pkg.scripts["build:binary"], /bun build --compile --target=bun-linux-x64/);
  for (const dir of ["migrations", "schema", "seed"]) {
    assert.ok(pkg.scripts["build:binary"].includes(`dist/${dir}`), `the binary release stages ${dir}`);
  }

  // CI: the quickstart gate and both smokes exist and are wired to the scripts
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  // `package-smoke` was `npx-smoke` until §4: it packs and installs the tarball
  // from a FILE, which is the rehearsal for a publication that has not happened.
  for (const job of ["quickstart-e2e:", "package-smoke:", "binary-smoke:"]) assert.ok(ci.includes(job), `CI job ${job}`);
  assert.match(ci, /ci\/quickstart-docker\.sh/);
  assert.match(ci, /quickstart-transcript\.txt/, "the transcript is archived");
  const script = readFileSync(join(root, "ci", "quickstart-docker.sh"), "utf8");
  assert.match(script, /BUDGET_S:-600/, "the ≤600 s budget is asserted in the script, not just claimed");
});

test("the asset resolver finds migrations, schemas and the seed, and says so when it cannot", () => {
  const root = assetRoot();
  for (const p of ["migrations/0001_init.sql", "schema/evidence-v1.schema.json", `seed/${SEED_SLUG}/skill.json`]) {
    assert.ok(existsSync(join(root, p)), p);
  }
  // an override that does not hold the assets is a loud error, never a silent
  // fallback to an empty registry
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e",
     `import { assetRoot } from ${JSON.stringify(join(root, "src", "assets.ts"))};
      try { assetRoot(); console.log("RESOLVED"); } catch (e) { console.log("ERROR:" + e.message.slice(0, 60)); }`],
    { encoding: "utf8", env: { ...process.env, SKILLONOMIA_ASSETS: "/nonexistent" }, cwd: "/" },
  );
  assert.match(out, /ERROR:cannot locate migrations/, "an explicit override that is wrong is loud, never a silent fallback");
});

// -------------------------------------- P7 verdict 1, blocking #1: the npx path

test("the launcher runs the BUILT entry point, because Node refuses to strip types under node_modules", () => {
  const root = assetRoot();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.prepack, "npm run build:js", "packing builds the JS entry");
  assert.match(pkg.scripts["build:js"], /src\/cli\.ts --outfile dist-js\/cli\.js/);
  assert.ok(pkg.files.includes("dist-js/"), "the published tarball ships the built entry");

  // Reproduce the installed layout exactly: an INSTALLED package lives under a
  // `node_modules` directory, which is where Node refuses type stripping.
  const home = mkdtempSync(join(tmpdir(), "sklo-npx-"));
  const installed = join(home, "node_modules", "skillonomia");
  mkdirSync(join(installed, "bin"), { recursive: true });
  cpSync(join(root, "bin", "skillonomia.js"), join(installed, "bin", "skillonomia.js"));
  mkdirSync(join(installed, "src"), { recursive: true });
  writeFileSync(join(installed, "src", "cli.ts"), 'const x: number = 1;\nconsole.log("FROM SOURCES", x);\n');

  // (a) without the built entry, the sources cannot run from under node_modules
  //     UNDER NODE — this is the failure the verdict reported. Bun strips types
  //     anywhere, so the hazard is Node's alone; assert what each runtime does
  //     rather than skipping the case on one of them.
  const bare = spawnSync(process.execPath, [join(installed, "bin", "skillonomia.js"), "version"], { encoding: "utf8" });
  if (typeof (globalThis as any).Bun === "undefined") {
    assert.notEqual(bare.status, 0, "running the .ts sources from node_modules must fail under Node");
    assert.match(
      `${bare.stderr}`,
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|Unsupported/,
      "…and it fails for exactly the documented reason",
    );
  } else {
    assert.equal(bare.status, 0, "Bun runs the sources anywhere — the restriction is Node's");
    assert.match(bare.stdout, /FROM SOURCES/);
  }

  // (b) with the built entry present, the launcher runs THAT, with no flags
  mkdirSync(join(installed, "dist-js"), { recursive: true });
  writeFileSync(join(installed, "dist-js", "cli.js"), 'console.log("FROM BUILD");\n');
  const built = spawnSync(process.execPath, [join(installed, "bin", "skillonomia.js"), "version"], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /FROM BUILD/);
  assert.ok(!built.stdout.includes("FROM SOURCES"), "the sources are not preferred over the build");

  // (c) a source CHECKOUT — no `dist-js/` — falls back to the .ts sources.
  //     Built as a synthetic checkout outside node_modules rather than run
  //     against this working tree: `dist-js/` is gitignored, so whether the
  //     real root holds a build is a property of the developer's machine. The
  //     old form ran the real launcher, which silently preferred whatever
  //     build happened to be lying there — passing on a stale artifact and
  //     failing on a missing one, for reasons that had nothing to do with the
  //     code under test.
  const checkout = mkdtempSync(join(tmpdir(), "sklo-checkout-"));
  mkdirSync(join(checkout, "bin"), { recursive: true });
  cpSync(join(root, "bin", "skillonomia.js"), join(checkout, "bin", "skillonomia.js"));
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src", "cli.ts"), 'const x: number = 1;\nconsole.log("FROM SOURCES", x);\n');
  const fromSources = spawnSync(process.execPath, [join(checkout, "bin", "skillonomia.js"), "version"], {
    encoding: "utf8",
  });
  assert.equal(fromSources.status, 0, fromSources.stderr);
  assert.match(fromSources.stdout, /FROM SOURCES/, "with no build present the launcher runs the sources");

  // (d) …and the REVIEWED sources of this repository answer `version` — the
  //     `npm start` invocation, with no artifact anywhere in the path.
  const sources = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", join(root, "src", "cli.ts"), "version"],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(sources.status, 0, sources.stderr);
  assert.match(sources.stdout, new RegExp(VERSION.replace(/\./g, "\\.")));
});

test("the published JS entry point is BUILT here and answers `version` — never asserted against a stale artifact", (t) => {
  const root = assetRoot();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  // `dist-js/cli.js` is gitignored, so a test that reads the committed tree's
  // copy asserts nothing repeatable: absent it fails, stale it passes green on
  // code nobody reviewed. This case builds the artifact from the command
  // package.json declares — parsed out of the script, so the two cannot drift
  // — into a throwaway directory, and runs THAT through the real launcher.
  const build = pkg.scripts["build:js"] as string;
  const argv = build.split(/\s+/);
  assert.equal(argv[0], "bun", `build:js must be a bun invocation: ${build}`);
  if (spawnSync("bun", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip(
      "bun is not on PATH, so `npm run build:js` cannot run here — the npx path's BUILT entry point is unverified " +
        "in this environment. It is covered by the `npx-smoke` CI job, which installs bun.",
    );
    return;
  }

  const out = mkdtempSync(join(tmpdir(), "sklo-buildjs-"));
  const staged = join(out, "node_modules", "skillonomia");
  mkdirSync(join(staged, "dist-js"), { recursive: true });
  mkdirSync(join(staged, "bin"), { recursive: true });
  cpSync(join(root, "bin", "skillonomia.js"), join(staged, "bin", "skillonomia.js"));
  // same flags as the script, with only the outfile redirected
  const flags = argv.slice(1).map((a) => (a === "dist-js/cli.js" ? join(staged, "dist-js", "cli.js") : a));
  const built = spawnSync("bun", flags, { encoding: "utf8", cwd: root });
  assert.equal(built.status, 0, `build:js failed: ${built.stderr}`);
  assert.ok(existsSync(join(staged, "dist-js", "cli.js")), "build:js produced the entry point");

  // …and it is what the launcher runs from an INSTALLED layout, where Node
  // refuses to strip types from the sources beside it
  const run = spawnSync(process.execPath, [join(staged, "bin", "skillonomia.js"), "version"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(VERSION.replace(/\./g, "\\.")), "the built entry reports the shipping version");
});

// ------------------------ P7 verdict 1, major #1: the narrowed dead-letter rule

test("a dead-lettered NOTIFICATION does not refuse adoption; a denied approval still does", async () => {
  const { inst, address } = instance();
  const base = await address();
  try {
    const owner = await api(base, "POST", "/v1/auth/bootstrap", undefined, {
      bootstrap_token: inst.credentials!.bootstrap_owner_token,
    });
    const ownerKey = owner.body.api_key as string;
    const demoKey = inst.credentials!.demo_adopter_token;
    const search = await api(base, "GET", "/v1/skills?q=hello-skillonomia", ownerKey);
    const versionId = search.body.items[0].skill_version_id;

    const req = await api(base, "POST", "/v1/adoptions/requests", demoKey, { skill_version_id: versionId });
    const { adoption_request_id: requestId, receipt_id: receiptId } = req.body;
    assert.equal(req.body.webhook_id, null, "the demo adopter registers no endpoint — as §9.1 has it");

    // the delivery worker runs and dead-letters the NOTIFICATION (§5.2)
    await inst.tick();
    const row = inst.db
      .prepare("SELECT state, dead_letter_reason FROM adoption_requests WHERE id=?")
      .get(requestId) as { state: string; dead_letter_reason: string };
    assert.equal(row.state, "dead_letter");
    assert.equal(row.dead_letter_reason, "endpoint_missing");

    // …and the adopter can still PULL the package: §5.2 routes notifications,
    // §5.3 records outcomes, and surface 7 is the pull. Before this rule the
    // normative §9.1 quickstart could not complete at all.
    const adopt = await api(base, "POST", `/v1/adoptions/${requestId}/adopt`, demoKey, {
      environment_descriptor: ENV_DESCRIPTOR,
    });
    assert.equal(adopt.status, 200, JSON.stringify(adopt.body));
    assert.equal(adopt.body.receipt_event, "delivered");
    const receipt = await api(base, "GET", `/v1/receipts/${receiptId}`, demoKey);
    assert.equal(receipt.body.derived_state, "delivered");

    // the §7.3 DENIAL is a different thing entirely and still refuses
    inst.db
      .prepare("UPDATE adoption_requests SET dead_letter_reason='approval_denied' WHERE id=?")
      .run(requestId);
    const refused = await api(base, "POST", `/v1/adoptions/${requestId}/adopt`, demoKey, {
      environment_descriptor: ENV_DESCRIPTOR,
      idempotency_key: "denied-1",
    });
    assert.equal(refused.status, 412, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "PRECONDITION_FAILED");
    assert.match(refused.body.error.message, /approval_denied/);
  } finally {
    inst.close();
  }
});
