// One release version, one literal.
//
// Before this file the version was written out three times and had already
// drifted: package.json said `0.0.1-p7`, `SERVICE_VERSION` in src/http.ts said
// `0.0.1-p7`, MCP `initialize` said `0.0.1-p2`, and SPEC's header said `0.1.0`.
// Nothing failed, because nothing compared them.
//
// The point of these tests is NOT that the strings are right today. It is that
// they can no longer diverge: every consumer either imports src/version.ts or
// is asserted here against it, and the ONE literal lives in package.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../src/version.ts";
import { SERVICE_VERSION, handleRest } from "../src/http.ts";
import { VERSION as SERVER_VERSION } from "../src/server.ts";
import { HELP as CLI_HELP } from "../src/cli-commands.ts";
import { handleMcpMessage } from "../src/mcp.ts";
import { p4Fixture } from "./p4-helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

test("package.json is the canonical source and src/version.ts is its only reader", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(VERSION, pkg.version, "src/version.ts must report package.json's version");
  assert.match(VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "the version is semver");

  // exactly one file may contain the literal declaration
  const declarations = read("src/version.ts");
  assert.match(declarations, /import pkg from "\.\.\/package\.json"/, "it reads package.json, it does not restate it");
  assert.doesNotMatch(declarations, new RegExp(`"${VERSION.replace(/\./g, "\\.")}"`), "no hardcoded copy");

  // npm keeps its own copy in the lockfile; it drifts whenever a version bump
  // lands without an `npm install` (it was already two releases behind)
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, VERSION, "package-lock.json — run `npm install --package-lock-only`");
  assert.equal(lock.packages?.[""]?.version, VERSION, "package-lock.json root package entry");
});

test("no source file hardcodes a version string of its own", () => {
  // Any `x.y.z` string literal in src/ that is NOT the current version would
  // be a second source of truth. (Test fixtures legitimately use 1.0.0/2.0.0
  // as PACKAGE semantic_versions, which is why only src/ is swept.)
  const files = ["src/http.ts", "src/mcp.ts", "src/server.ts", "src/cli.ts", "src/cli-commands.ts"];
  for (const f of files) {
    const src = read(f);
    const literals = [...src.matchAll(/version"?\s*[:=]\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(literals, [], `${f} must take the version from src/version.ts, not restate it: ${literals}`);
  }
});

test("every runtime reporter agrees with the single source", () => {
  assert.equal(SERVICE_VERSION, VERSION, "src/http.ts SERVICE_VERSION");
  assert.equal(SERVER_VERSION, VERSION, "src/server.ts VERSION (what the running instance logs at startup)");
  assert.equal(CLI_HELP.split("\n")[0], `skillonomia ${VERSION} — self-hosted registry of Verified Skill Packages`,
    "the CLI's `help` banner");

  const fx = p4Fixture();

  // GET /health — the entire acceptance smoke of the packaged-tarball and
  // binary paths, so it is the version an operator actually sees
  const health = JSON.parse(
    handleRest(fx.registry, { method: "GET", url: "/health", headers: {}, body: Buffer.alloc(0) }).body,
  );
  assert.deepEqual(health, { status: "ok", service: "skillonomia", version: VERSION });

  // MCP initialize — the version an MCP client negotiates against
  const init = handleMcpMessage(fx.registry, fx.member, { jsonrpc: "2.0", id: 1, method: "initialize" }) as any;
  assert.equal(init.result.serverInfo.version, VERSION, "MCP initialize serverInfo.version");
  assert.equal(init.result.serverInfo.name, "skillonomia");

  fx.db.close();
});

test("the documents agree with the single source", () => {
  // SPEC's header is normative about which release it describes
  const spec = read("SPEC.md");
  assert.ok(
    spec.includes(`Version \`${VERSION}\``),
    `SPEC.md must declare Version \`${VERSION}\` — it is the release this specification describes`,
  );

  // README's quickstart shows a real /health transcript; a stale one teaches
  // the reader a version that does not exist
  // (matched narrowly on the `service` field: the quickstart also shows
  // environment-descriptor `version` fields, which are package versions and
  // have nothing to do with the release)
  const readme = read("README.md");
  const shown = [...readme.matchAll(/"service"\s*:\s*"skillonomia"\s*,\s*"version"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(shown.length > 0, "README's quickstart shows a /health response");
  for (const v of shown) {
    assert.equal(v, VERSION, "README's /health transcript must show the shipping version");
  }
});
