import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error The browser harness is deliberately plain ESM outside the
// package's TypeScript build; this test exercises that shipped module directly.
import { playwrightCandidates, resolvePlaywrightDir } from "../test-browser/lib/playwright.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

test("Playwright candidates prefer the explicit override, then repository-local installs", () => {
  const candidates = playwrightCandidates({
    env: { SKILLONOMIA_PLAYWRIGHT_DIR: "/explicit/control" },
    cwd: "/work/repository",
    home: "/Users/operator",
  });
  assert.equal(candidates[0], "/explicit/control");
  assert.equal(candidates[1], "/work/repository");

  const checked: string[] = [];
  const resolved = resolvePlaywrightDir({
    env: { SKILLONOMIA_PLAYWRIGHT_DIR: "/explicit/control" },
    cwd: "/work/repository",
    home: "/Users/operator",
    exists(path: string) {
      checked.push(path);
      return path === join("/work/repository", "node_modules", "playwright");
    },
  });
  assert.equal(resolved.dir, "/work/repository");
  assert.deepEqual(checked, [
    join("/explicit/control", "node_modules", "playwright"),
    join("/work/repository", "node_modules", "playwright"),
  ]);
});

test("a relative explicit override is resolved from the repository before loading", () => {
  const candidates = playwrightCandidates({
    env: { SKILLONOMIA_PLAYWRIGHT_DIR: "control/playwright" },
    cwd: "/work/repository",
    home: "/Users/operator",
  });
  assert.equal(candidates[0], join("/work/repository", "control", "playwright"));

  const resolved = resolvePlaywrightDir({
    env: { SKILLONOMIA_PLAYWRIGHT_DIR: "control/playwright" },
    cwd: "/work/repository",
    home: "/Users/operator",
    exists: (path: string) => path === join("/work/repository", "control", "playwright", "node_modules", "playwright"),
  });
  assert.equal(resolved.dir, join("/work/repository", "control", "playwright"));
});

test("Playwright resolution falls back to a portable home-derived legacy control install", () => {
  const home = "/Users/portable-user";
  const legacy = join(home, ".ductor-alan", "tools", "v1.1-playwright");
  const resolved = resolvePlaywrightDir({
    env: {},
    cwd: "/work/repository",
    home,
    exists: (path: string) => path === join(legacy, "node_modules", "playwright"),
  });
  assert.equal(resolved.dir, legacy);
  assert.equal(resolved.candidates.at(-1), legacy);
});

test("a missing Playwright install returns every searched candidate and carries no /home/node literal", () => {
  const source = readFileSync(join(REPO_ROOT, "test-browser", "lib", "playwright.mjs"), "utf8");
  assert.ok(!source.includes("/home/node"), "the loader still embeds the container-specific home path");

  const resolved = resolvePlaywrightDir({
    env: { SKILLONOMIA_PLAYWRIGHT_DIR: "/missing/explicit" },
    cwd: "/missing/repository",
    home: "/missing/home",
    exists: () => false,
  });
  assert.equal(resolved.dir, null);
  assert.ok(resolved.candidates.length >= 4, "the resolver did not report the full fallback search");
  assert.equal(resolved.candidates[0], "/missing/explicit");
  assert.equal(resolved.candidates.at(-1), join("/missing/home", ".ductor-alan", "tools", "v1.1-playwright"));
});
