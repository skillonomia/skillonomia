// The executable entry point shared by every packaging path (P7): the Docker
// image runs it, `bin/skillonomia.js` re-execs it under Node's type stripping,
// and `bun build --compile` compiles it into the Linux x86_64 binary.
//
// It does nothing but hand argv to the dispatcher, so all three paths expose
// exactly the same subcommands (src/cli-commands.ts).
import { runCli } from "./cli-commands.ts";

// `process.exitCode`, not `process.exit`: `serve` returns 0 with a listener
// still bound, and the process must stay alive to answer on it.
process.exitCode = runCli(process.argv.slice(2));
