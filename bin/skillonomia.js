#!/usr/bin/env node
// `skillonomia` — the launcher the published package installs.
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
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist-js", "cli.js");
const args = process.argv.slice(2);

// AN INSTALLED PACKAGE HAS NO SECOND CHANCE. Under `node_modules` the fallback
// below cannot work — Node refuses to strip types there — so a tarball that
// shipped without `dist-js/cli.js` would fail with
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, an error about Node's rules
// rather than about the package that is missing its entry point. `prepack`
// builds that file; a package where it is absent was not packed, and this says
// so. In a checkout `dist-js/` legitimately does not exist and the sources are
// the thing to run.
const installed = root.includes(`${sep}node_modules${sep}`);
if (!existsSync(built) && installed) {
  console.error(
    `skillonomia: this installed package carries no ${join("dist-js", "cli.js")}. It is built by \`prepack\` when ` +
      "the tarball is packed, so this install came from a tree that was never packed. Reinstall from a published " +
      "tarball (`npm install -g @skillonomia/cli`) or from one made with `npm pack`.",
  );
  process.exit(1);
}

const [entry, flags] = existsSync(built)
  ? [built, []]
  : [join(root, "src", "cli.ts"), ["--experimental-strip-types", "--no-warnings"]];

const child = spawn(process.execPath, [...flags, entry, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
