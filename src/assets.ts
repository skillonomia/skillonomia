// Where the runtime data files live: `migrations/` (Appendix D.1 and the one
// authorized P5 migration) and `seed/` (the §9.1 seed package).
//
// Running from a checkout or from an npm install, they sit next to `src/`.
// A compiled single-file binary has no `src/` on disk, so the release tarball
// puts them next to the executable (or under `share/skillonomia`). This module
// is the ONE place that knows the difference; everything else asks for a path.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A directory is the asset root iff it holds the normative first migration
 *  AND the Appendix E schemas — the two things the registry cannot run without. */
function isAssetRoot(dir: string): boolean {
  return existsSync(join(dir, "migrations", "0001_init.sql")) && existsSync(join(dir, "schema", "evidence-v1.schema.json"));
}

function candidates(): string[] {
  const out: string[] = [];
  try {
    // checkout / npm install layout: this module is <root>/src/assets.ts
    out.push(join(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch {
    // a bundled runtime may not give this module a file URL — the executable
    // candidates below are what carry the compiled binary
  }
  const exe = process.execPath ? dirname(process.execPath) : null;
  if (exe) {
    out.push(exe);
    out.push(join(exe, "..", "share", "skillonomia"));
  }
  out.push(process.cwd());
  return out;
}

let cached: string | null = null;

/** The asset root, resolved once. Throws with the searched list if none fits. */
export function assetRoot(): string {
  // An explicit override is AUTHORITATIVE: an operator who names an asset
  // directory gets that one or a loud error, never a silent fallback to some
  // other tree that happens to look right.
  const fromEnv = process.env.SKILLONOMIA_ASSETS;
  if (fromEnv) {
    if (!isAssetRoot(fromEnv)) {
      throw new Error(
        `cannot locate migrations/0001_init.sql and schema/ under SKILLONOMIA_ASSETS=${fromEnv}`,
      );
    }
    return fromEnv;
  }
  if (cached && isAssetRoot(cached)) return cached;
  const tried = candidates();
  for (const dir of tried) {
    if (isAssetRoot(dir)) {
      cached = dir;
      return dir;
    }
  }
  throw new Error(
    `cannot locate migrations/0001_init.sql — set SKILLONOMIA_ASSETS to the directory holding migrations/ and seed/. Tried: ${tried.join(", ")}`,
  );
}

export function migrationsDir(): string {
  return join(assetRoot(), "migrations");
}

export function seedDir(slug: string): string {
  return join(assetRoot(), "seed", slug);
}

/** Where the BUILT Owner Console bundle sits. It is a build output, not a
 *  source file: `npm run build:console` writes it and the server reads it, so
 *  the thing an owner's browser runs is the thing the production build made. */
export function consoleAssetDir(): string {
  return join(assetRoot(), "dist-console");
}
