// THE ENTRY POINT OF THE BROWSER GATES.
//
//   npm run test:browser
//
// It is DELIBERATELY OUTSIDE `npm test`. The suite CI runs is dependency-light —
// the shipped package has two runtime dependencies and the `supply-chain` job
// asserts that both lockfiles agree with `package.json`, that the toolchain is
// complete and that `build:js` and `build:binary` are byte-reproducible. A
// browser engine added as a devDependency ripples into every one of those and
// into the artifact hashes the release phase certifies, for a tool that is never
// part of the product. So Playwright is resolved from a control install outside
// the repository (`test-browser/lib/playwright.mjs`), and when it is absent this
// runner exits 3 with a banner rather than reporting a pass it did not earn.
import { run } from "./lib/harness.mjs";

// Each file registers its gates by importing the harness's `test`.
await import("./proofline.mjs");
await import("./states.mjs");
await import("./decisions.mjs");
await import("./decision-states.mjs");

await run();
