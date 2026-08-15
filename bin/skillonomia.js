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

// A SIGNAL SENT TO THIS LAUNCHER HAS TO REACH THE PROCESS THAT IS SERVING.
//
// This file is a shim: the thing that listens, holds the database and handles
// SIGTERM is the CHILD, and it inherits this process's stdio. Without the loop
// below, a SIGTERM aimed at `skillonomia` killed the shim on the DEFAULT
// disposition and left the child running, reparented to init, still holding
// the stdout and stderr the caller gave the shim. A supervisor that had just
// "stopped" the server was then left reading a pipe that would never reach EOF.
//
// That is not a hypothetical: it is how `v0.1.4`'s release hung. The release
// gate starts `serve` through this launcher, signals it, and then waits for the
// process to be gone; the orphaned child kept the gate's pipes open, so the gate
// finished all of its work, printed `NPM_CLI_OK`, and never exited. The step
// waited 2h21m and was cancelled by hand — and the three steps that publish the
// tarball's SBOM and read the registries back never ran.
//
// So the signal is FORWARDED and this process stays alive until the child is
// actually gone, which is what makes `exit` below the child's exit and not a
// guess about it. `SIGKILL` cannot be forwarded by anyone, which is why the
// caller must also kill the process GROUP — but a caller that sends SIGTERM and
// waits now gets a clean stop instead of an orphan.
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
for (const signal of FORWARDED) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // the child is already gone; `exit` below is what ends this process
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise with the DEFAULT disposition, so a supervisor sees the signal
    // that killed the child and not a synthesised exit code. The handlers above
    // have to go first, or this process would forward the signal to a child
    // that is already dead and then outlive it — which is the failure this
    // whole block exists to remove.
    for (const s of FORWARDED) process.removeAllListeners(s);
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 0);
});
