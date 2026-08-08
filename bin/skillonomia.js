#!/usr/bin/env node
// `npx skillonomia` — the published launcher.
//
// Node refuses to strip types from files under `node_modules`
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an installed package cannot
// run the TypeScript sources the way a checkout does. The published tarball
// therefore carries a plain-JS entry point built by `prepack`
// (`dist-js/cli.js`), and this launcher prefers it. In a source checkout that
// file does not exist and the launcher re-execs Node with type stripping, so
// `npm start`, `npx .` and the tests all keep running the reviewed sources
// directly. (P7 verdict 1, blocking #1.)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist-js", "cli.js");
const args = process.argv.slice(2);

const [entry, flags] = existsSync(built)
  ? [built, []]
  : [join(root, "src", "cli.ts"), ["--experimental-strip-types", "--no-warnings"]];

const child = spawn(process.execPath, [...flags, entry, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
