// THE release version, in one place.
//
// `package.json` is the canonical source and this module is the only reader.
// Everything that reports a version — `/health`, MCP `initialize`, the CLI's
// `version` and `help`, the README's quickstart transcript and SPEC's header —
// takes it from here, so the literal exists exactly once in the repository and
// the sources cannot drift apart. `test/version.test.ts` fails if any of them
// does anyway.
//
// Why a static import and not a runtime file read: three packaging paths have
// to keep working and only one of them has a filesystem that looks
// like this repository. `bun build --compile` produces a single executable with
// no `package.json` beside it, and `bun build --target=node` produces one
// bundled `dist-js/cli.js`. An import attribute is resolved by the BUNDLER, so
// the value is inlined into both artifacts at build time; `readFileSync` of
// `../package.json` would have compiled cleanly and then failed at runtime in
// the binary. Verified on all four paths: `node --experimental-strip-types`,
// `tsc`, `bun build --target=node`, `bun build --compile`.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
