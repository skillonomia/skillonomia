// [B-5] — THE CLASS, NOT THE NINTH SENTENCE.
//
// The argument, the discovery rules and the STATED LIMITS are in
// `test/absolutes.ts`; read that file's head before this one. In short: eight
// release reviews found eight false statements in shipped documents, one per
// round, each a claim of UNIVERSALITY, UNIQUENESS or ABSENCE that the tree did
// not agree with. This file sweeps the delivered documents for the vocabulary
// that marks such a claim and requires each one to be either CHECKED against
// the tree or DECLARED below with a reason.
//
// THERE IS NO THIRD BUCKET, and that is the part worth defending. A claim
// nobody classified is a claim a reader acts on and nothing contradicts, which
// is exactly how the eight shipped. So a new absolute sentence in a partitioned
// document fails this suite until somebody decides which it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  type Declared,
  type Ground,
  PINNED_FIGURES,
  REFERENCED_ONLY,
  absoluteClaims,
  bundleBytes,
  bundleSidecarBytes,
  claimDigest,
  deliveredDocuments,
  packagingPaths,
  prose,
  readClaim,
  readSentence,
  referencesIn,
  rosterOf,
  statesCount,
  unresolvedReferences,
  wrongCounts,
  wrongFigures,
} from "./absolutes.ts";
import { REPO_ROOT } from "./docs-guard.ts";

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * EVERY workflow file WITH ITS COMMENTS REMOVED — what the automation RUNS, as
 * opposed to what it says about itself.
 *
 * The distinction is not academic: `ci.yml` explains in prose that "`npm pack`
 * produces the tarball locally", and a whole-file substring search is satisfied
 * by that sentence alone. Deleting the step and keeping the comment passed.
 *
 * The sweep is over the DIRECTORY and not over `ci.yml`, because as of A2 it is
 * not the only workflow: `candidate.yml` stages the release asset and
 * `release.yml` publishes it. A guard that reads one file would have kept
 * answering for a repository that had grown two more.
 */
const workflowSteps = (): string =>
  readdirSync(join(REPO_ROOT, ".github", "workflows"))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => read(`.github/workflows/${f}`))
    .join("\n")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

// ===========================================================================
// THE DECLARED LIST.
//
// Every entry is ONE SENTENCE of ONE DOCUMENT, keyed by the digest of that
// sentence, with the ground on which it is not checked and the reason.
//
//   `intent`      — what this project will or will not do. A promise about the
//                   future is not a fact about the tree; nothing in the tree
//                   can refute it, and the guard says so rather than pretending.
//   `external`    — about the world outside this repository: a public registry,
//                   another host, somebody's filesystem, a proxy.
//   `behaviour`   — a rule of the RUNNING SERVICE. True, and verified — by the
//                   suite, not by this file. An entry on this ground MUST name
//                   a test file, and the test below checks that the file exists.
//                   This is the weakest ground here and it is the largest: what
//                   it does NOT establish is that the named test covers that
//                   exact sentence. It establishes that the sentence was read,
//                   attributed, and cannot change without this list changing.
//   `definition`  — defines a term, a scope or a form rather than reporting a
//                   fact about the tree.
//   `editorial`   — a statement about the documents themselves.
//
// EDITING A DOCUMENT BREAKS ITS ENTRIES, on purpose: the key is the digest of
// the sentence, so a reworded claim falls out of this list and back into the
// partition, and somebody classifies it again.
// ===========================================================================
type Row = [document: string, digest: string, ground: Ground, why: string];

const DECLARED: ReadonlyArray<Declared> = ([] as Row[]).concat(
  // ------------------------------------------------------------ CONTRIBUTING
  [
    ["CONTRIBUTING.md", "d1587135dae41644", "intent", "no support commitment and no response-time target: a promise this project declines to make"],
    ["CONTRIBUTING.md", "ae41cb1364a3b2ef", "intent", "the published mirror may be force-updated; about a repository that is not this one"],
    ["CONTRIBUTING.md", "59cffc87b5626c56", "editorial", "invites a report of a SPEC.md defect; a statement about how to talk to the maintainers"],
  ],
  // ------------------------------------------------------------------ README
  [
    ["README.md", "30dbd7abb8b0bb13", "behaviour", "a checkout runs without a build: exercised on both runtimes by test/readme-quickstart.test.ts"],
    ["README.md", "6b4fbfc701c8952c", "editorial", "names the one non-literal step of the transcript; about the document"],
    ["README.md", "8324343cd261dc26", "editorial", "defines the `# →` convention the quickstart transcript is written in"],
    ["README.md", "db0351bb0784e0b7", "editorial", "claims the README cannot drift; the mechanism is test/readme-quickstart.test.ts"],
    ["README.md", "74a8c6d07aa10c82", "behaviour", "the image is built, never pulled: the Dockerfile and ci/quickstart-docker.sh, via test/p7-ci-gate.test.ts"],
    ["README.md", "a12d90cad7a54d9e", "external", "what a `-p` without a host address exposes is docker's behaviour on the operator's host"],
    ["README.md", "5834ede2d66b4a64", "intent", "declares the one supported topology for another host; a support boundary, not a fact of the tree"],
    ["README.md", "e5822ce80eb07603", "external", "the proxy's role in the operator's compose project"],
    ["README.md", "42ecbe221d61326e", "external", "what is reachable on the operator's host once the compose file above is used"],
    ["README.md", "64da2e914bea0929", "behaviour", "demo mode while one human principal exists: test/p6-dashboard.test.ts"],
    ["README.md", "9b691d71755cf149", "behaviour", "the `reviewed` row of the lifecycle table: test/p4-review.test.ts"],
    ["README.md", "44ec9bf7fcdc22ab", "behaviour", "the actor comes from the API key on both adapters: test/p2-auth.test.ts"],
    ["README.md", "32b510f9adb679d8", "behaviour", "reputation from server-validated receipts only: test/p6-reputation.test.ts"],
    ["README.md", "5f210fe33d6e6a4c", "behaviour", "provisioning is API-only and issues the key once: test/provisioning.test.ts"],
    ["README.md", "8c2dc322f99473f3", "behaviour", "a principal registers its own signing key only: test/provisioning.test.ts"],
    ["README.md", "82b6875816e6656b", "behaviour", "the view and screen counts are checked by test/docs-guard.ts through test/p14-r2-invariants.test.ts"],
    ["README.md", "c1cc960faf060022", "behaviour", "every dashboard cell carries its method: test/p6-dashboard.test.ts"],
    ["README.md", "e7e64edc7cc74f53", "behaviour", "the migration counters cannot be raised after the fact: test/p14-r5-probes.test.ts"],
    ["README.md", "4fe491caa55408cf", "behaviour", "the qualifying event and the recipient come from the receipt journal: test/insert-only.test.ts"],
    ["README.md", "f2a588b83554c3be", "behaviour", "an unreadable opening event contributes nothing: test/p14-r5-probes.test.ts"],
    ["README.md", "4f7d657d7b0926ff", "behaviour", "each migrations row names its opening events: test/p14-r5-probes.test.ts"],
    ["README.md", "88366685b1659567", "behaviour", "a never-migrated skill is a row of zeroes: test/p14-r5-probes.test.ts"],
    ["README.md", "591ffd55b670d997", "behaviour", "every packaging row listens on the loopback: test/bind-address.test.ts and test/docker-network-boundary.test.ts"],
    ["README.md", "809e73863b64d7c0", "intent", "serving another host is a different topology, not a flag; a support boundary"],
    ["README.md", "543ab46ce04a2c1f", "intent", "a loopback publish is a local trial and not a way to serve another host; a support boundary"],
    ["README.md", "5e7fbc1bff8b29b8", "behaviour", "an image is pinned by digest and a tag is refused: test/published-image-contract.test.ts"],
    ["README.md", "ce778aeb74d8b1f6", "behaviour", "the CLI needs Node and no Bun, bash, curl or tar: test/npm-consumer.test.ts"],
    ["README.md", "09da2477dd1e08af", "behaviour", "`demo` needs none of the transcript's shell tools: test/npm-consumer.test.ts"],
    ["README.md", "54a1182959065f0a", "behaviour", "`demo` spawns exactly one program, the declared step: test/npm-consumer.test.ts"],
    ["README.md", "bd29464177134815", "behaviour", "a missing interpreter is a refusal and not a receipt: test/npm-consumer.test.ts"],
    ["README.md", "85b06f30c59faa01", "external", "what a `-p` without a host address exposes is docker's behaviour on the operator's host"],
    ["README.md", "942f1892b504c907", "external", "how a case-insensitive or normalizing filesystem behaves is a property of that filesystem"],
    ["README.md", "453e3d967aadc778", "behaviour", "the `.tar` form of §4.1b is asserted on every host and never skipped: test/platform.test.ts"],
    ["README.md", "cc176e35f7526d11", "external", "a MUST NOT addressed to the operator about the network the listener is placed on"],
    ["README.md", "2192832e07ef9685", "intent", "declares the one supported way to reach a deployment from another host"],
    ["README.md", "cb0c315f7f7daf11", "intent", "declares the two supported container shapes; a support boundary"],
    ["README.md", "4c3198600b56b5d8", "behaviour", "no command in this repository publishes without a host address: test/docker-network-boundary.test.ts"],
    ["README.md", "2309b3d4ccccb855", "behaviour", "webhook secrets are never in SQLite and never returned twice: test/p5-webhooks.test.ts"],
    ["README.md", "bd673d9ee2d1996b", "behaviour", "receipts are INSERT-only and adopter-writable only: test/insert-only.test.ts"],
    ["README.md", "e5a84f971ae1e2c0", "behaviour", "a service key can never satisfy the human-approval gate: test/p4-approvals.test.ts"],
    ["README.md", "71e9d95b743ffe2c", "behaviour", "the seed's demo key signs that one package and verifies out of the box: test/readme-quickstart.test.ts"],
    // The owner's platform decision, stated in the document that would otherwise
    // imply more. Two artifacts, two widths, and one lane deferred — none of
    // which the tree can refute, because a deferral is a decision and an
    // unexercised platform leaves no evidence behind to read.
    ["README.md", "e547f6d3a19ea5af", "intent", "the container image is claimed on Ubuntu and on no other OS; a support boundary this project sets, not a fact of the tree"],
    ["README.md", "808df16ac1de47be", "intent", "the owner deferred Docker Desktop on macOS and Windows, so neither container job has run and neither is claimed; a decision, and the absence it leaves is unreadable from here"],
    ["README.md", "17a90d1d933e0a6a", "intent", "the Windows lane is deferred by the owner and no Windows result is reported; a support boundary. That the jobs remain declared is asserted by test/platform.test.ts"],
    ["README.md", "d80a47d48743b01a", "intent", "names the supported macOS path — the npm CLI on ordinary Node, not a container; a support boundary"],
    ["README.md", "7fc8f309a518600c", "behaviour", "the deferred jobs are still declared in the workflow, unaltered and undeleted: test/platform.test.ts"],
  ],
  // ---------------------------------------------------------------- SECURITY
  [
    ["SECURITY.md", "bd854583af53862f", "external", "what GitHub's private advisory form discloses is GitHub's behaviour"],
    ["SECURITY.md", "880b9c655acc98d8", "intent", "declares the single reporting channel; a policy"],
    ["SECURITY.md", "792d12c8b279ba55", "intent", "the deliberate absence of an email address; a policy about how reports arrive"],
    ["SECURITY.md", "3bbc6bfd55ee6a98", "editorial", "the reasoning for that absence"],
    ["SECURITY.md", "44db18caf512a1c9", "intent", "no patch SLA at any version; a maintenance policy"],
    ["SECURITY.md", "8442e2cce81396a8", "external", "what the published release page carries is not readable from this tree"],
    ["SECURITY.md", "bdb443af6dd0fa19", "behaviour", "the baseline tag is refused by name, so the published release is never amended: test/source-only.test.ts"],
    ["SECURITY.md", "00017c15de658726", "intent", "no security maintenance commitment at any version; a maintenance policy"],
    ["SECURITY.md", "d002d8a5033c2268", "intent", "only the tip of the published branch is looked at; a maintenance policy"],
    ["SECURITY.md", "de117bedc0e8ec40", "intent", "the supported-versions row restating that policy"],
    ["SECURITY.md", "aaf5c03f9bdb6429", "intent", "the supported-versions row for the version this tree declares, restating that policy"],
    ["SECURITY.md", "6702c7076146000d", "intent", "the owner's pilot instance is not a service this project offers and carries no uptime or response commitment; a support boundary, not a fact of the tree"],
    ["SECURITY.md", "a8ea82542519eb4c", "intent", "versions between the baseline and this one carry the same absence of commitment; a maintenance policy"],
    ["SECURITY.md", "e0c0cc07ec2fc4ca", "definition", "introduces the list of parts that make a security claim; defines the section's scope"],
    ["SECURITY.md", "5c767d464feceeb8", "definition", "assigns three attack shapes to the signing surface; a classification"],
    ["SECURITY.md", "d5ab67fba07df936", "behaviour", "there is no runtime sandbox: the gates are static only, test/p3-gates.test.ts"],
    ["SECURITY.md", "525de2a0bca0eebe", "definition", "draws the in-scope/out-of-scope line for the gates; a scope definition"],
  ],
  // ---------------------------------------------------------------- docs/API
  [
    ["docs/API.md", "380704a3889fe183", "behaviour", "a conflicting transition returns the current state: test/lifecycle-surfaces.test.ts"],
    ["docs/API.md", "fe0fd36e460f9b03", "behaviour", "every mutating call accepts `idempotency_key`: test/p4-adapters.test.ts"],
    ["docs/API.md", "f79f29c052e4e737", "behaviour", "no idempotency-key shape is reserved: test/p14-r10-probes.test.ts"],
    ["docs/API.md", "bbac3b0473bbfaa7", "behaviour", "a digest-shaped key repeats like any other: test/p14-r10-probes.test.ts"],
    ["docs/API.md", "b1512a302138500c", "behaviour", "each migration runs in its own transaction: test/migration-count.test.ts"],
    ["docs/API.md", "4f58debabc38613a", "behaviour", "the version-10 refusal and its reason: test/p14-r11-probes.test.ts"],
    ["docs/API.md", "dc11805ae4d69e82", "editorial", "a historical statement about an unreleased development commit"],
    ["docs/API.md", "3c041e55b26272db", "behaviour", "an unregistered `kid` verifies as UNKNOWN_KEY: test/vectors.test.ts"],
    ["docs/API.md", "201e732fa2bd0d68", "behaviour", "the archive's required members and integrity list: test/adopt-integrity.test.ts"],
    ["docs/API.md", "365eab3a44583ba3", "behaviour", "`draft → linted` iff no gate FAILs: test/p3-lint-integration.test.ts"],
    ["docs/API.md", "3189536a1928a0d2", "behaviour", "an author can never review their own version: test/p4-review.test.ts"],
    ["docs/API.md", "b632c56b7d9399bb", "behaviour", "the verified-gate conjunction: test/p4-verified-gate.test.ts"],
    ["docs/API.md", "f5df16ac94a95db3", "behaviour", "the response lists each unmet conjunct: test/p4-verified-gate.test.ts"],
    ["docs/API.md", "11742e0a3bacf83b", "behaviour", "search filters combine with AND: test/p2-search.test.ts"],
    ["docs/API.md", "89255d14b4519107", "behaviour", "no filter combination widens visibility: test/p2-search.test.ts"],
    ["docs/API.md", "1d751a41aacaa3ab", "behaviour", "the registry view each search item carries: test/p6-search.test.ts"],
    ["docs/API.md", "0e5e17d0d51bad44", "behaviour", "cross-workspace adoption accepts only `published`: test/p4-lifecycle.test.ts"],
    ["docs/API.md", "a9f9810f5e15166a", "behaviour", "`approval_pending` blocks the worker and the adoption: test/p4-approvals.test.ts"],
    ["docs/API.md", "141f918953585d44", "behaviour", "high risk requires attested sandbox capability: test/p6-compat.test.ts"],
    ["docs/API.md", "ae123544f4b407be", "behaviour", "a begun chain answers PRECONDITION_FAILED with no package: test/p5-delivery.test.ts"],
    ["docs/API.md", "033c8135a350dddb", "behaviour", "only the receipt's own adopter may append: test/insert-only.test.ts"],
    ["docs/API.md", "77141ec5429fa22f", "behaviour", "each event kind occurs at most once per receipt: test/p5-receipts.test.ts"],
    ["docs/API.md", "92ce300ed7db80b1", "behaviour", "`adopted` needs evidence for every declared gate: test/p5-receipts.test.ts"],
    ["docs/API.md", "75bc38a946d45243", "behaviour", "each evidence shape is schema-checked: test/schema-conformance.test.ts"],
    ["docs/API.md", "89f9f337de23c293", "editorial", "explains why §5.3's fields are written for a human reader"],
    ["docs/API.md", "3cfd8fda5fb461e5", "behaviour", "no caller text enters a journal outside the four columns: test/p14-r8-probes.test.ts"],
    ["docs/API.md", "fc0a13363f77829b", "editorial", "states what the previous sentence does NOT promise; a caveat about the document"],
    ["docs/API.md", "60cc824e7abc8517", "behaviour", "an idempotency key is compared, never read back: test/p14-r10-probes.test.ts"],
    ["docs/API.md", "0dbbcce6c4bc47ad", "behaviour", "a rating needs the rater's own terminal receipt: test/p6-reputation.test.ts"],
    ["docs/API.md", "27480a0f03d2b3b6", "behaviour", "a successor must be verified or published: test/p4-lifecycle.test.ts"],
    ["docs/API.md", "27f8100420b2c7a0", "behaviour", "publication has exactly one entry point: test/countersign.test.ts"],
    ["docs/API.md", "5c6154855a9fa6ba", "behaviour", "publication needs admin/owner: test/p4-approvals.test.ts"],
    ["docs/API.md", "4da7c67b9a50dca4", "behaviour", "who may supersede, and why a reviewer is admitted: test/p4-lifecycle.test.ts"],
    ["docs/API.md", "17950538b6acbe45", "behaviour", "a source manifest must carry an `outcome_contract`: test/create-from-dir.test.ts"],
    ["docs/API.md", "36934e7189d94b30", "behaviour", "a source without a contract is INVALID_SCHEMA before any write: test/create-from-dir.test.ts"],
    ["docs/API.md", "ec5d407df001fe3a", "behaviour", "a truncated contract names a method and withholds its subject: test/create-from-dir.test.ts"],
    ["docs/API.md", "ec7195d018fe6edb", "editorial", "a stated caveat about what a bounded alphabet can still encode"],
    ["docs/API.md", "41a926b01cad332e", "editorial", "restates the boundary of the journal promise; a caveat about the document"],
    ["docs/API.md", "09bd67c4741653f0", "behaviour", "the contract is signed, so redefining success needs a new version: test/create-from-dir.test.ts"],
    ["docs/API.md", "f96ffbee41ffb0b6", "behaviour", "surface 1 reports `unknown` with `no_outcome_contract`: test/p14-r7-probes.test.ts"],
    ["docs/API.md", "03d8e935846dcdac", "behaviour", "what a `yes`/`no` in the outcome column means: test/p14-r7-probes.test.ts"],
    ["docs/API.md", "bedee76f80128ead", "behaviour", "surface 2 takes no cryptographic material from the caller: test/create-from-dir.test.ts"],
    ["docs/API.md", "a827f6f8b9141aba", "behaviour", "no `--seed-hex`, `kid`, integrity list or packing step: test/create-from-dir.test.ts"],
    ["docs/API.md", "e9149175b6adf73b", "behaviour", "the system key's private half never enters SQLite or the API: test/p14-r6-probes.test.ts"],
    ["docs/API.md", "14e87c9ac1b3cc77", "behaviour", "`runtime.shell: [\"none\"]` gets the block and no script: test/p14-r9-probes.test.ts"],
    ["docs/API.md", "866bb3a4bdff4ded", "behaviour", "a declaration is never amended to add an interpreter: test/p14-r9-probes.test.ts"],
    ["docs/API.md", "51dbee1ff0127a1b", "behaviour", "step 4 compares two places when no script is declared: test/p14-r9-probes.test.ts"],
    ["docs/API.md", "edffb38b462da460", "behaviour", "such a version reports `unknown` for want of an executable step: test/p14-r9b-probes.test.ts"],
    ["docs/API.md", "b89ae0209109a568", "behaviour", "convergence is judged on the source, not the packed bytes: test/p14-r9-probes.test.ts"],
    ["docs/API.md", "c768ca8dfe5c1db6", "behaviour", "a transfer must name its recipient or it is INVALID_SCHEMA: test/transfer.test.ts"],
    ["docs/API.md", "80890eb6a0435eaf", "intent", "no unaddressed form of the transfer call exists, deliberately; a design decision"],
    ["docs/API.md", "a0e39fb014b44bf4", "behaviour", "a transfer cannot route around an approval: test/transfer.test.ts"],
    ["docs/API.md", "6f4a9e51656fdc03", "behaviour", "a transfer reports no arrival, install or run: test/transfer.test.ts"],
    ["docs/API.md", "0942eee0e74d7492", "behaviour", "only a terminal `adopted` makes a migration count: test/p14-r5-probes.test.ts"],
    ["docs/API.md", "aa48912892bdb3b8", "behaviour", "a service key can never satisfy the approval: test/p4-approvals.test.ts"],
    ["docs/API.md", "34eee992a92d9110", "behaviour", "`adopt_high_risk` binds exactly one request: test/p4-approvals.test.ts"],
    ["docs/API.md", "77e6c3f3f6d9f253", "behaviour", "the webhook URL rules at registration: test/p5-webhooks.test.ts"],
    ["docs/API.md", "fafa66a7663320ba", "behaviour", "the api_key is shown once and the call takes no idempotency key: test/provisioning.test.ts"],
    ["docs/API.md", "ed9bf4b11ad1f2fa", "behaviour", "no parameter registers a key for another principal: test/provisioning.test.ts"],
    ["docs/API.md", "18ce809b0fb003e6", "behaviour", "a transfer grant adds no workspace role: test/transfer.test.ts"],
    ["docs/API.md", "95b65078945c1ff3", "behaviour", "each grant row names its issuer with type and role: test/transfer.test.ts"],
    ["docs/API.md", "48a3013415f77f9a", "behaviour", "the activation root is configuration and never a request field: test/assignment-activation.test.ts"],
    ["docs/API.md", "b876188f222d9515", "behaviour", "with no root configured the activation records `queued`: test/assignment-activation.test.ts"],
    ["docs/API.md", "fea6d5db63b28a97", "behaviour", "`active` is recorded only after the entry file reads back: test/assignment-activation.test.ts"],
    ["docs/API.md", "502fad2d2a44f59f", "behaviour", "`intent_state` and `observed_state` are never merged: test/p14-fleet-dashboard.test.ts"],
    ["docs/API.md", "73d9a81674c00e8f", "behaviour", "each number names its source and window: test/fleet-inventory.test.ts"],
    ["docs/API.md", "8e1af8e4e14c0924", "behaviour", "`unknown` is a value and never rendered as `no`: test/fleet-inventory.test.ts"],
    ["docs/API.md", "e561a4a7287f7719", "behaviour", "the asymmetric state × runtime matrix: test/p14-fleet-dashboard.test.ts"],
    ["docs/API.md", "824398c377e1dd70", "behaviour", "every cell carries state, source and window: test/p14-fleet-dashboard.test.ts"],
    ["docs/API.md", "3c51434e0e4aca6d", "behaviour", "an untaken count is `unknown` with a reason, never 0: test/fleet-inventory.test.ts"],
    ["docs/API.md", "453de69fa6a2a7b5", "behaviour", "the DEAD WEIGHT slice of the capability view: test/p14-fleet-dashboard.test.ts"],
    ["docs/API.md", "dbbe4b5ac42903aa", "behaviour", "a tuple needs a paired call/output record sharing one `call_id`: test/p14-r12-probes.test.ts"],
    ["docs/API.md", "2a6521633c5bccd0", "behaviour", "a period report must state its window: test/p14-r12-probes.test.ts"],
    ["docs/API.md", "008db6ea99c9b0a7", "behaviour", "`model` is refused rather than truncated: test/p14-r12-probes.test.ts"],
    ["docs/API.md", "edce98b38eb31c38", "behaviour", "`call_id` is stored as a digest of itself: test/p14-r12-probes.test.ts"],
    ["docs/API.md", "31af0bc2e4a2792f", "definition", "states what an observation report can and cannot establish; defines the evidence's reach"],
    ["docs/API.md", "66f888cf90374b86", "behaviour", "the registry runs the contract's own check, never the word: test/p14-r7-probes.test.ts"],
    ["docs/API.md", "4df0d0b8241a8c2a", "behaviour", "each dashboard section declares its fields and scoping: test/p6-dashboard.test.ts"],
    ["docs/API.md", "dc66ad0d813e5bdc", "behaviour", "every dashboard cell carries its method: test/p6-dashboard.test.ts"],
    ["docs/API.md", "88145dbb4b075152", "behaviour", "counted from the receipt journal, never from the request context: test/p14-r5-probes.test.ts"],
    ["docs/API.md", "6f9cd028ccead62f", "behaviour", "where a counted migration's recipient is read from: test/p14-r5-probes.test.ts"],
    ["docs/API.md", "a6a72a1045b8afec", "behaviour", "every migrations row restates source, window and state: test/p14-r5-probes.test.ts"],
    ["docs/API.md", "16954f76ea1792b7", "behaviour", "every journal annotation is checked against the column set: test/p14-r8-probes.test.ts"],
    ["docs/API.md", "4ba9cd41976b99cb", "behaviour", "the outbound transport's constraints: test/transport.test.ts"],
    ["docs/API.md", "0146b868b8fd1786", "behaviour", "a source tree carrying skill.json or SIGNATURE.jws is INVALID_SCHEMA: test/create-from-dir.test.ts"],
  ],
  // ------------------------------------------------------------ docs/DOGFOOD
  [
  ],
  // --------------------------------------------------------- docs/OPERATIONS
  [
    ["docs/OPERATIONS.md", "7cba9cf255642c1d", "behaviour", "the compiled binary targets Linux x86_64 and no other: test/platform.test.ts"],
    ["docs/OPERATIONS.md", "b2cd59fa936e9a5d", "behaviour", "the Windows ACL check reads the ACL and runs a second-account probe, failing closed: test/windows-security.test.ts"],
    ["docs/OPERATIONS.md", "f2549d1d0fe06bdd", "behaviour", "the CLI needs Node and no Bun, bash, curl or tar: test/npm-consumer.test.ts"],
    ["docs/OPERATIONS.md", "6ce22276f2e3fdcf", "external", "when npm runs `prepack` is npm's own lifecycle, not a fact of this tree"],
    ["docs/OPERATIONS.md", "b561dd70d0febbbd", "behaviour", "no install, postinstall or prepare script exists: test/npm-consumer.test.ts"],
    ["docs/OPERATIONS.md", "0dc49a43115a58ce", "behaviour", "the staged and registry markers are distinct and say which path ran: test/npm-consumer.test.ts"],
    ["docs/OPERATIONS.md", "c415e04517ec1fe0", "behaviour", "`demo` runs the quickstart in Node with no bash, curl or tar: test/npm-consumer.test.ts"],
    ["docs/OPERATIONS.md", "59a837b30de5d74d", "behaviour", "a self-started demo uses a temporary directory of its own: test/npm-consumer.test.ts"],
    ["docs/OPERATIONS.md", "041392fd2dc3b0d2", "behaviour", "a missing interpreter is a refusal and not a receipt: test/npm-consumer.test.ts"],
    ["docs/OPERATIONS.md", "b616e87c205f4c67", "behaviour", "unset activation variables activate nothing: test/assignment-activation.test.ts"],
    ["docs/OPERATIONS.md", "48fac24685a61527", "intent", "writing into a runtime directory happens only on an operator's say-so; a design decision"],
    ["docs/OPERATIONS.md", "727edb1a232a9443", "behaviour", "no `~`, `$HOME` or relative form is expanded: test/assignment-activation.test.ts"],
    ["docs/OPERATIONS.md", "9b00e47fd9497e2c", "behaviour", "every path component is resolved and confined to the root: test/assignment-activation.test.ts"],
    ["docs/OPERATIONS.md", "fbcc7059c02eee19", "behaviour", "the two Claude Code scopes differ only in the root: test/assignment-activation.test.ts"],
    ["docs/OPERATIONS.md", "22c7b2103aab234f", "behaviour", "observed arrival stays `unknown` without a runtime record: test/p14-r12-probes.test.ts"],
    ["docs/OPERATIONS.md", "55f94d7669de6335", "behaviour", "unset inventory variables walk nothing: test/fleet-inventory.test.ts"],
    ["docs/OPERATIONS.md", "3dee7d440027bb76", "intent", "reading somebody's machine happens only on an operator's say-so; a design decision"],
    ["docs/OPERATIONS.md", "0ee8e74bed7c62d3", "definition", "states the inventory's scope — what it counts and what it does not"],
    ["docs/OPERATIONS.md", "5797505d1f71bd38", "behaviour", "tools and connectors come back `unknown`, never 0: test/fleet-inventory.test.ts"],
    ["docs/OPERATIONS.md", "dc4677c9af88af1e", "external", "a MUST NOT addressed to the operator about the network the listener is placed on"],
    ["docs/OPERATIONS.md", "318cc777faf22683", "behaviour", "the bootstrap token and every later key cross the listener: test/p2-auth.test.ts"],
    ["docs/OPERATIONS.md", "fb59923d45ba68bf", "behaviour", "the bind default never widens by itself: test/bind-address.test.ts"],
    ["docs/OPERATIONS.md", "c35a313069f91bbf", "behaviour", "an external bind needs `--host` or SKILLONOMIA_HOST: test/bind-address.test.ts"],
    ["docs/OPERATIONS.md", "66acbe67ecbfc23c", "intent", "declares the supported way to serve another host"],
    ["docs/OPERATIONS.md", "ba83c5bfb44ce1df", "external", "the certificate lives with the operator's proxy"],
    ["docs/OPERATIONS.md", "12abe69e5a5f7cc5", "intent", "declares `0.0.0.0` without a proxy unsupported"],
    ["docs/OPERATIONS.md", "f597585f16f4c037", "external", "what such a bind exposes depends on the host's networks"],
    ["docs/OPERATIONS.md", "2b927f1ed80895d1", "definition", "a heading separating the image's decision from the operator's"],
    ["docs/OPERATIONS.md", "bc940d46b5d23861", "editorial", "explains why the two decisions are written on one page"],
    ["docs/OPERATIONS.md", "70f67795ce2bb594", "behaviour", "the container healthcheck needs no network: test/docker-network-boundary.test.ts"],
    ["docs/OPERATIONS.md", "9316db9ea3bfb8c6", "intent", "declares exactly two supported publish shapes"],
    ["docs/OPERATIONS.md", "47e39648a140870c", "intent", "the table row restating the proxy shape; a support boundary"],
    ["docs/OPERATIONS.md", "18b1af4e8528538b", "external", "what a host-address-less publish maps onto is docker's behaviour"],
    ["docs/OPERATIONS.md", "466f3ab7441ac84d", "behaviour", "no command in this repository is written that way: test/docker-network-boundary.test.ts"],
    ["docs/OPERATIONS.md", "fc43a325b53c6c89", "external", "what such a publish would expose on the operator's networks"],
    ["docs/OPERATIONS.md", "7131c613333314bb", "external", "why a firewall in front is not the boundary; about the operator's estate"],
    ["docs/OPERATIONS.md", "2aa6bc7c9fce75b9", "intent", "the compose recipe's first rule; a support boundary"],
    ["docs/OPERATIONS.md", "60cb61e268f7df48", "external", "the proxy is the only public listener in the operator's project"],
    ["docs/OPERATIONS.md", "8b3fec11c8d01d3d", "behaviour", "verify and verify-log need no path on a running deployment: test/cli.test.ts"],
    ["docs/OPERATIONS.md", "217e562748f2a229", "behaviour", "credentials are issued at first start only: test/p5-e2e.test.ts"],
    ["docs/OPERATIONS.md", "a6cd6e33f5aae00f", "behaviour", "both credentials are printed once and not stored retrievably: test/p2-auth.test.ts"],
    ["docs/OPERATIONS.md", "2c08517602f1b996", "behaviour", "a restart does not reprint the token: test/p2-auth.test.ts"],
    ["docs/OPERATIONS.md", "bda6f239e2831320", "behaviour", "the token file disappears before the owner key is minted: test/p2-auth.test.ts"],
    ["docs/OPERATIONS.md", "1e74c4b8d88b7383", "behaviour", "a restart prints no credentials and installs no second seed: test/p5-e2e.test.ts"],
    ["docs/OPERATIONS.md", "8e2c0b8339934285", "intent", "a lost one-time credential is unrecoverable by design; a design decision"],
    ["docs/OPERATIONS.md", "239c11d358b12f6a", "definition", "opens the branch for a deployment whose data must be kept"],
    ["docs/OPERATIONS.md", "39c0861e7dbc3622", "behaviour", "nothing mints an owner key without an existing one: test/provisioning.test.ts"],
    ["docs/OPERATIONS.md", "fd49c767185b0d68", "behaviour", "/health carries no instance data: test/p2-service.test.ts"],
    ["docs/OPERATIONS.md", "0fcd3fee1e17ea0f", "behaviour", "an adopter with no endpoint gets dead_letter(endpoint_missing): test/p5-delivery.test.ts"],
    ["docs/OPERATIONS.md", "3efa21083ddb234f", "behaviour", "only a denied approval refuses adoption outright: test/p5-delivery.test.ts"],
    ["docs/OPERATIONS.md", "01d7b232cc5d0497", "behaviour", "the webhook push is the only outbound connection: test/transport.test.ts"],
    ["docs/OPERATIONS.md", "eec6363aef420d2d", "behaviour", "https only; an http endpoint is not delivered to: test/transport.test.ts"],
    ["docs/OPERATIONS.md", "1e86b93e3296a3dd", "behaviour", "a 3xx is the answer and counts as a failed delivery: test/transport.test.ts"],
    ["docs/OPERATIONS.md", "65d6ec5c9dd8cf2f", "behaviour", "the name is resolved once and the connection pinned: test/transport.test.ts"],
    ["docs/OPERATIONS.md", "d3a59124160c28b1", "behaviour", "deadlines and a response cap bound the worker slot: test/transport.test.ts"],
    ["docs/OPERATIONS.md", "104fc853b38f3efb", "behaviour", "a literal address is judged at registration, a name at delivery: test/transport.test.ts"],
    ["docs/OPERATIONS.md", "70bbcb4425939b0a", "behaviour", "the 2000-character bound and the stored-as-written rule: test/p5-webhooks.test.ts"],
    ["docs/OPERATIONS.md", "ded6608e2c6b8fea", "behaviour", "registration returns the plaintext secret once: test/p5-webhooks.test.ts"],
    ["docs/OPERATIONS.md", "eb986893e4421f81", "behaviour", "nothing in the API returns the secret afterwards: test/p5-webhooks.test.ts"],
    ["docs/OPERATIONS.md", "b73226eedcf22e42", "behaviour", "verify-log walks the whole chain: test/verify-log.test.ts"],
    ["docs/OPERATIONS.md", "467219492429f97f", "behaviour", "verify-log opens read-only and runs no migration: test/verify-log.test.ts"],
    ["docs/OPERATIONS.md", "5fb295324f45f276", "external", "SQLite's WAL index needs a writable directory; a property of SQLite"],
    ["docs/OPERATIONS.md", "121a6b75d0c09491", "behaviour", "the version-10 refusal and why it cannot be told apart: test/p14-r11-probes.test.ts"],
    ["docs/OPERATIONS.md", "d14f3ce4d29b8886", "editorial", "a historical statement about an unreleased development commit"],
    ["docs/OPERATIONS.md", "07e53a809d6b4dee", "behaviour", "an interrupted upgrade to 10 is equally indistinguishable: test/p14-r11-probes.test.ts"],
    // The same platform decision, restated for the operator. `qualify-docker-linux`
    // is the one container qualification; the other two rows and the Windows lane
    // are the owner's deferral, written down so an absence is not read as a pass.
    ["docs/OPERATIONS.md", "bd2a80bc63b7a753", "intent", "the container image is claimed on Ubuntu and on no other OS; a support boundary this project sets"],
    ["docs/OPERATIONS.md", "34412b3e8f03ab47", "intent", "`qualify-docker-macos` is deferred by the owner and has produced no macOS container result; a decision, and an unexercised platform leaves nothing here to read"],
    ["docs/OPERATIONS.md", "f21b3521832d9fdd", "intent", "`qualify-docker-windows` is deferred on the same decision, with no Windows container result"],
    ["docs/OPERATIONS.md", "b89482d027524001", "intent", "names the supported macOS path — ordinary Node and npm, not a container; a support boundary"],
    ["docs/OPERATIONS.md", "a3f4c7db1e2b9330", "behaviour", "each docker job takes the workflow's one digest and refuses a host it is not on: test/published-image-contract.test.ts"],
  ],
  // ----------------------------------------------------------- skills/README
  [
    ["skills/README.md", "4473cec51dc4bb5b", "behaviour", "a real package cannot be committed pre-signed because `kid` resolves per deployment: test/vectors.test.ts"],
    ["skills/README.md", "add3561572fdf784", "definition", "declares what each directory under skills/ is; a definition of the layout"],
    ["skills/README.md", "025e7b75235aefc5", "behaviour", "gate 5 admits only statically readable shell: test/p3-gates.test.ts"],
    ["skills/README.md", "49fc3768051a1950", "behaviour", "every control construct is refused: test/p3-gates.test.ts"],
    ["skills/README.md", "feceadf90fc7a3a8", "behaviour", "the rewritten form parses nothing and fails closed: test/skill-git-bundle-verify.test.ts"],
    ["skills/README.md", "3b05e2b81beddd5d", "behaviour", "the subset cannot express a conditional step: test/p3-gates.test.ts"],
    ["skills/README.md", "1b0cfb517dcefefd", "behaviour", "there is no third option inside the gate: test/p3-gates.test.ts"],
    ["skills/README.md", "155f830463ba2f0f", "behaviour", "git-bundle-verify's step 4 always runs: test/skill-git-bundle-verify.test.ts"],
    ["skills/README.md", "e1f93818b13bf32a", "editorial", "advice on how to write a precondition inside the subset"],
    ["skills/README.md", "6c47ddff46b62637", "editorial", "an example of that advice — `rmdir` as an emptiness check"],
    ["skills/README.md", "0966d0d62effbe2c", "editorial", "an example of that advice — a version check by `sort --check`"],
    ["skills/README.md", "afca3959b8e6d860", "editorial", "an example of that advice — `cmp` against an empty file"],
    ["skills/README.md", "04aad11f94859160", "behaviour", "each of those forms fails closed and is readable by gate 5: test/p3-gates.test.ts"],
    ["skills/README.md", "35c86feec266b70b", "editorial", "argues why negative vectors belong inside the package"],
    ["skills/README.md", "41c2e16e50356c1b", "behaviour", "git-bundle-verify is read-only, offline and low risk: test/skill-git-bundle-verify.test.ts"],
  ],
  // ------------------------------------------------ the public README's own
  [
    //
    // Fifteen absolute sentences the internal README does not carry: the
    // preamble, the boundaries list and the whole `## Validation` section are
    // public editorial work, so the internal table has no entry for any of
    // them and the partition would fail on all fifteen. Each is classified on
    // the same five grounds as the rest of this table, and each digest is the
    // digest of the sentence as this file's own reader yields it.
    ["README.md", "7f4ed457c4335e18", "intent", "declares what this release is and is not offered as — no support commitment, no external pilot, no service — while naming the artifacts that ARE published; a support boundary. The automation half, that publication happens in release.yml alone and on a version tag, is checked by test/source-only.test.ts"],
    ["README.md", "7d9c8ad2c339b10a", "editorial", "says why the boundaries are placed before the description; about the document's own order"],
    ["README.md", "d8746380edea0754", "intent", "declares two scope boundaries — no sandbox is created or enforced, and the truth of an adopter's attestation is not this software's subject"],
    ["README.md", "d59b3e41e9ef9f5f", "intent", "declares the network boundary as a support boundary: plain HTTP on the listener, and serving another host is a different topology rather than a flag"],
    ["README.md", "0a2a48c8a6b2a9df", "behaviour", "the bind address defaults to the loopback and no shipped instruction leaves it: test/bind-address.test.ts"],
    ["README.md", "1036b25c24a8991a", "intent", "declares the one supported way to reach a deployment from another host; a support boundary, not a fact of the tree"],
    ["README.md", "d3234854678d05b3", "behaviour", "deny-by-default inside the classes the eight gates enumerate, and a refusal where a command cannot be classified: test/p3-gates.test.ts"],
    ["README.md", "769e39b76bed196c", "definition", "defines what passing the eight gates does and does not mean; a statement about the verdict's scope rather than a report about this tree"],
    ["README.md", "656bd081fce09338", "intent", "declares what this release has and has not demonstrated; a statement about the state of the evidence, which no file of this tree holds"],
    ["README.md", "448bc53a2dfc17c0", "intent", "declares two things this project does not build; a scope boundary"],
    ["README.md", "1096d62332b559a7", "intent", "declares which runtimes the delivered suite is run on and what it covers. The pinned Bun version and the engine floor are checked as figures; the coverage list describes the suite rather than stating a fact of one file, and no size is named — D-29"],
    ["README.md", "c1802db621c87ca2", "external", "reports what was exercised on a local instance outside this repository; no file of this tree records that run"],
    ["README.md", "cce60393467ccf94", "external", "reports what a past operational run did not contain; the run is outside this tree"],
    ["README.md", "cc2bec8ed2af3ad3", "external", "reports the absence of a pilot and of a third-party review; both are events outside this repository"],
    ["README.md", "4e7bd903873cf1da", "definition", "the one-sentence definition of what this project is, closed by a pointer to the limits above it"],
  ],
).map(([document, digest, ground, why]): Declared => ({ document, digest, ground, why }));

// ===========================================================================
// The subject, and that nothing fell out of it.
// ===========================================================================

test("the delivered document set is discovered, non-empty and fully rostered", () => {
  const docs = deliveredDocuments();
  assert.ok(docs.length > 0, "no delivered document — the discovery is broken");
  const unrostered = docs.map(([n]) => n).filter((n) => rosterOf(n) === null);
  assert.deepEqual(
    unrostered,
    [],
    "a document this repository delivers is in neither half of the roster. Decide: does every absolute claim in " +
      "it get checked-or-declared (PARTITIONED), or only its references and counts (REFERENCED_ONLY, with a reason)?",
  );
  const partitioned = docs.filter(([n]) => rosterOf(n) === "partitioned");
  assert.ok(partitioned.length >= 5, `only ${partitioned.length} documents are partitioned — the roster is broken`);
  console.log(
    `[B-5] delivered: ${docs.length} documents (${partitioned.length} partitioned); ` +
      `claims: ${docs.reduce((n, [name, text]) => n + absoluteClaims(name, text).length, 0)}`,
  );
});

// ===========================================================================
// The checks. These run over EVERY delivered document, both halves of the
// roster: a dead path or a wrong number in `SPEC.md` is as much a defect as one
// in `README.md`, and nothing about the residue partition changes that.
// ===========================================================================

// A REFERENCE IS SWEPT OVER THE WHOLE DOCUMENT, not only over the sentences
// that carry an absolute word — for the same reason a count is. README's
// Development table says "`src/gates.ts` | the eight safety gates and their
// severity tables" and contains no absolute word at all; renaming that file
// would leave a shipped document pointing at nothing, and a sweep bounded by
// the absolute vocabulary would not notice. The vocabulary decides which claims
// need CLASSIFYING; it does not decide which names need to exist.
test("every reference a delivered document makes into this tree resolves", () => {
  const bad: string[] = [];
  let refs = 0;
  for (const [name, text] of deliveredDocuments()) {
    const found = referencesIn(prose(text));
    refs += found.length;
    for (const failure of unresolvedReferences(found, name)) bad.push(`${name}: ${failure}`);
  }
  console.log(`[B-5] references resolved: ${refs}`);
  assert.ok(refs > 0, "no reference was resolved at all — the extractor is broken");
  assert.deepEqual(bad, [], `a delivered document names something this tree does not have:\n  ${bad.join("\n  ")}`);
});

// A COUNT IS SWEPT OVER THE WHOLE DOCUMENT, not only over the sentences that
// carry an absolute word. README's "the ten red-team tests that cover it" has
// no `every`, no `only` and no `all` in it — and the FIRST defect of this
// family was exactly such a sentence, a test count with no absolute word
// anywhere near it. A number whose subject this tree can answer for is checked
// wherever it is written.
test("every count a delivered document states matches the tree", () => {
  const bad: string[] = [];
  let counts = 0;
  for (const [name, text] of deliveredDocuments()) {
    const text_ = prose(text);
    counts += statesCount(text_).length;
    for (const failure of wrongCounts(text_)) bad.push(`${name}: ${failure}`);
  }
  console.log(`[B-5] documents stating a checkable count: ${counts}`);
  assert.ok(counts > 0, "no counted claim was found at all — the matcher is broken");
  assert.deepEqual(bad, [], `a delivered document counts something the tree counts differently:\n  ${bad.join("\n  ")}`);
});

test("every pinned figure a delivered document writes matches the file that decides it", () => {
  const bad: string[] = [];
  const seen = new Map<string, number>();
  for (const [name, text] of deliveredDocuments()) {
    for (const figure of PINNED_FIGURES) {
      seen.set(figure.key, (seen.get(figure.key) ?? 0) + [...text.matchAll(figure.where)].length);
    }
    for (const failure of wrongFigures(text)) bad.push(`${name}: ${failure}`);
  }
  // A figure nobody writes is a pattern that stopped matching, which is the
  // silent-staleness failure this whole family exists to remove.
  for (const figure of PINNED_FIGURES) {
    assert.ok(
      (seen.get(figure.key) ?? 0) > 0,
      `no delivered document writes the ${figure.key} any more — either the sentence was reworded and this ` +
        `pattern is now checking nothing, or the claim was dropped and this entry should be too`,
    );
  }
  console.log(`[B-5] pinned figures: ${[...seen].map(([k, n]) => `${k}×${n}`).join(", ")}`);
  assert.deepEqual(bad, [], `a document writes a figure its own source contradicts:\n  ${bad.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// The size claim in `skills/README.md`. It carries no absolute word, so the
// sweep above never sees it — and it was wrong: "the whole set here is under
// 2 KB" was true of the five bundles (1 931 B) and false of the vector set they
// sit in. A figure whose subject is a directory of this repository is checkable
// whether or not it happens to sit next to the word `every`.
test("the shipped skill's vector set is the size skills/README.md says it is", () => {
  const doc = read("skills/README.md");
  const bundles = /the five bundles here are under (\d+) KB/.exec(doc);
  assert.ok(bundles, "skills/README.md no longer states the bundles' size — the sentence and this guard move together");
  const cap = Number(bundles[1]) * 1024;
  assert.ok(
    bundleBytes() < cap,
    `skills/README.md says the bundles are under ${bundles[1]} KB; they are ${bundleBytes()} bytes`,
  );

  const sidecar = /add about ([\d.]+) KB more/.exec(doc);
  assert.ok(sidecar, "skills/README.md no longer states the sidecar size — the sentence and this guard move together");
  const stated = Number(sidecar[1]) * 1024;
  const actual = bundleSidecarBytes();
  assert.ok(
    Math.abs(actual - stated) <= 256,
    `skills/README.md says the matrix, digests and reference tree add about ${sidecar[1]} KB; they add ${actual} bytes`,
  );
  console.log(`[B-5] vectors: ${bundleBytes()} B of bundles, ${actual} B beside them`);
});

// ---------------------------------------------------------------------------
// WHAT THE PROJECT SAYS IT DOES NOT DO, AGAINST THE AUTOMATION.
//
// The fourth defect of this family was a document saying the binary is not
// shipped while `.github/workflows/ci.yml` uploaded it on every push, and
// `test/source-only.test.ts` closed that one sentence. This is the general
// form: the automation may not PUBLISH what every delivered document says is
// unpublished.
//
// THE SUBJECT OF THIS TEST HAS NARROWED TWICE, and each narrowing is stated
// rather than silently done.
//
// A2 made a release carry a Linux binary, so "publishes nothing" stopped being
// anybody's claim; the release-asset half moved to `test/source-only.test.ts`,
// which reads the trigger, the tag rule and the one file allowed to publish.
//
// B1 and B2 added a container image and `@skillonomia/cli`, and the documents
// asserted a CURRENT absence about both: the publishing path exists, is armed
// behind the owner's approval, and has not run.
//
// THAT SENTENCE EXPIRED, AND EXPIRING IS THE WHOLE POINT OF THIS FILE. Both
// artifacts are on their registries now — `@skillonomia/cli` on npm and a tag
// per version of `ghcr.io/skillonomia/skillonomia` on GHCR — so a document
// still saying "not published yet" is exactly the defect family this suite was
// written for, only pointing the other way: the automation acted, and the
// documents were the ones left behind. A guard that REQUIRED that sentence
// would have made the build enforce it.
//
// So the pair the guard tests is now:
//
//   * a publish of either artifact may exist ONLY in `release.yml`, which runs
//     on a version tag out of the protected environment — nothing on a push;
//   * and no delivered document may still claim either one is unpublished. This
//     is a DATED PROHIBITION, not a permanent one: if a future artifact is
//     documented before it is published, its absence gets said in words that
//     are true then, and this list is what has to change with it.
//
// The document half is what makes this a pair rather than a duplicate of
// `test/source-only.test.ts`: that file guards the automation, this one guards
// the automation AGAINST THE DOCUMENTS, which is the defect family it belongs to.
test("no delivered document still calls a published artifact unpublished", () => {
  const PUBLISHERS = [
    [/^\s*(?:run:\s*)?.*\bnpm\s+publish\b/m, "`npm publish`"],
    [/^\s*(?:run:\s*)?.*\bdocker\s+push\b/m, "`docker push`"],
    [/^\s*(?:run:\s*)?.*--push\b/m, "a buildx push"],
    [/uses:\s*docker\/build-push-action/, "docker/build-push-action"],
  ] as const;

  const dir = join(REPO_ROOT, ".github", "workflows");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
    const steps = read(`.github/workflows/${file}`)
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const found = PUBLISHERS.filter(([re]) => re.test(steps)).map(([, what]) => what);
    if (file === "release.yml") {
      assert.deepEqual(
        found,
        ["`npm publish`", "a buildx push"],
        "release.yml publishes the npm package and the container image, and those are the two the documents describe",
      );
      continue;
    }
    assert.deepEqual(
      found,
      [],
      `${file} ${found.join(" and ")}. Publication follows a version tag out of the protected environment; a ` +
        "workflow that runs on a push must not be able to reach a registry.",
    );
  }

  // THE DOCUMENT HALF. Both artifacts are named in the delivered documents, and
  // neither may still be described as one that has not been published.
  const docs = deliveredDocuments();
  for (const [what, names, stale] of [
    ["the container image", /ghcr\.io\/skillonomia/, /no digest has been published|no published digest|digest that is not there yet/i],
    [
      "`@skillonomia/cli`",
      /npm install -g @skillonomia\/cli/,
      /not on the npm registry yet|nothing has been published to npm yet|until a version of `@skillonomia\/cli` exists/i,
    ],
  ] as const) {
    const naming = docs.filter(([, text]) => names.test(text));
    assert.ok(naming.length >= 2, `${what} is named in ${naming.length} delivered document(s) — this guard reads two`);
    for (const [name, text] of naming) {
      const said = stale.exec(text);
      assert.equal(
        said,
        null,
        `${name} still says ${what} has not been published (“${said?.[0]}”), and it has. A reader is told to build ` +
          "or pack what a registry already serves — the same document-versus-automation disagreement as before, with " +
          "the document on the losing side this time.",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The packaging-path count is only as good as its derivation, so the derivation
// is checked too: every path this tree builds must be a path CI actually
// builds and launches. That is what makes "four" a fact rather than an opinion.
test("every packaging path this tree builds is exercised by the workflow", () => {
  const workflow = workflowSteps();
  const evidence: Record<string, RegExp> = {
    "container image (Dockerfile)": /docker build -t skillonomia:ci/,
    "checkout (`npm start`)": /npm ci/,
    "npm tarball (`npm pack`)": /npm pack/,
    "compiled binary (`npm run build:binary`)": /build:binary/,
  };
  const paths = packagingPaths();
  assert.ok(paths.length > 0, "no packaging path discovered — the derivation is broken");
  const unexercised = paths.filter((p) => !(evidence[p] ?? /$^/).test(workflow));
  assert.deepEqual(
    unexercised,
    [],
    `this tree builds a packaging path CI never builds: ${unexercised.join(", ")}. Either the workflow lost a ` +
      "job or the derivation counts something that is not a path.",
  );
  console.log(`[B-5] packaging paths: ${paths.length} — ${paths.join("; ")}`);
});

// ===========================================================================
// THE PARTITION. Checked, declared, or the build stops.
// ===========================================================================

const declaredBy = new Map(DECLARED.map((d) => [`${d.document} ${d.digest}`, d]));

test("every absolute claim in a partitioned document is checked or declared", () => {
  const unclassified: string[] = [];
  let checked = 0;
  let declared = 0;
  for (const [name, text] of deliveredDocuments()) {
    if (rosterOf(name) !== "partitioned") continue;
    for (const claim of absoluteClaims(name, text)) {
      const reading = readClaim(claim);
      assert.deepEqual(reading.wrong, [], `${name}: ${reading.wrong.join("; ")}`);
      if (reading.checked.length > 0) {
        checked += 1;
        continue;
      }
      if (declaredBy.has(`${name} ${claim.digest.slice(0, 16)}`)) {
        declared += 1;
        continue;
      }
      unclassified.push(
        `${name} [${claim.words.join(",")}] ${claim.digest.slice(0, 16)}\n    ${JSON.stringify(claim.sentence.slice(0, 180))}`,
      );
    }
  }
  console.log(`[B-5] partition: ${checked} checked, ${declared} declared`);
  assert.deepEqual(
    unclassified,
    [],
    `${unclassified.length} absolute claim(s) are neither checked against this tree nor declared.\n  ` +
      unclassified.join("\n  ") +
      "\n\nA claim nobody classified is a claim a reader acts on and nothing contradicts — which is how eight of " +
      "these shipped. Either make it checkable (name a file, a script, a route, a tool or a count this tree can " +
      "answer for), or add it to DECLARED in test/absolutes.test.ts with the ground and the reason.",
  );
});

test("no declaration is dead: every entry keys a sentence that is still written", () => {
  const live = new Set<string>();
  for (const [name, text] of deliveredDocuments()) {
    for (const claim of absoluteClaims(name, text)) live.add(`${name} ${claim.digest.slice(0, 16)}`);
  }
  const dead = DECLARED.filter((d) => !live.has(`${d.document} ${d.digest}`)).map(
    (d) => `${d.document} ${d.digest} (${d.ground}) — ${d.why}`,
  );
  assert.deepEqual(
    dead,
    [],
    "these declarations key no sentence of the document they name: it was reworded, moved or never matched.\n  " +
      dead.join("\n  ") +
      "\n\nA declaration that binds nothing is the silent-staleness failure this project has already removed twice " +
      "from document discovery. Re-read the sentence and re-key it, or drop the entry.",
  );
});

// EVERY `test/…​.ts` THIS GUARD'S OWN SOURCE NAMES MUST EXIST.
//
// The guard above checks the paths cited by `behaviour` declarations. It does
// NOT check the paths named in the ROSTER's prose — and one of them was wrong:
// `test/absolutes.ts` named the bundle-verify suite without its `.test`
// segment, and no such file exists. A release review found it. The guard that exists to stop a
// document naming what the tree does not have was doing exactly that, one
// function above the check that would have caught it.
//
// The wrong spelling is described here rather than quoted: this guard reads its
// own source, so writing the bad path in a comment would make the comment the
// defect. It caught exactly that on the first run.
test("every test path this guard's own source names exists", () => {
  const sources = ["test/absolutes.ts", "test/absolutes.test.ts"];
  const bad: string[] = [];
  for (const src of sources) {
    const text = readFileSync(join(REPO_ROOT, src), "utf8");
    for (const m of text.matchAll(/\btest\/[A-Za-z0-9_.-]+\.ts\b/g)) {
      if (!existsSync(join(REPO_ROOT, m[0]))) bad.push(`${src} names \`${m[0]}\`, which does not exist`);
    }
  }
  assert.deepEqual(bad, [], "this guard names a test file the tree does not have");
});

test("a `behaviour` declaration names a test file that exists", () => {
  const behaviour = DECLARED.filter((d) => d.ground === "behaviour");
  assert.ok(behaviour.length > 0, "no behaviour declaration — this guard is reading the wrong list");
  const bad: string[] = [];
  for (const d of behaviour) {
    const cited = [...d.why.matchAll(/\btest\/[A-Za-z0-9_.-]+\.ts\b/g)].map((m) => m[0]);
    if (cited.length === 0) {
      bad.push(`${d.document} ${d.digest}: ground \`behaviour\` and no test named — say which one`);
      continue;
    }
    for (const path of cited) {
      if (!existsSync(join(REPO_ROOT, path))) bad.push(`${d.document} ${d.digest}: names \`${path}\`, which does not exist`);
    }
  }
  console.log(`[B-5] behaviour declarations: ${behaviour.length}, each naming a test`);
  assert.deepEqual(bad, [], `a declaration on the weakest ground must at least name where the rule is exercised:\n  ${bad.join("\n  ")}`);
});

test("every declaration keys a document that is actually partitioned", () => {
  const misfiled = DECLARED.filter((d) => rosterOf(d.document) !== "partitioned").map(
    (d) => `${d.document} ${d.digest}`,
  );
  assert.deepEqual(
    misfiled,
    [],
    "a declaration names a document whose claims are not partitioned, so it exempts nothing and hides a decision",
  );
  const duplicates = DECLARED.map((d) => `${d.document} ${d.digest}`).filter((k, i, a) => a.indexOf(k) !== i);
  assert.deepEqual(duplicates, [], "the same sentence is declared twice, so its reason is whichever one you read first");
});

test("the referenced-only half of the roster states its reason", () => {
  for (const entry of REFERENCED_ONLY) {
    assert.ok(entry.why.length > 60, `${entry.pattern} is exempted from the partition with no real reason`);
  }
  const covered = deliveredDocuments()
    .map(([n]) => n)
    .filter((n) => rosterOf(n) === "referenced-only");
  assert.ok(covered.length > 0, "nothing is referenced-only, so the exemption list describes nothing");
  console.log(`[B-5] referenced-only (checked, not partitioned): ${covered.join(", ")}`);
});

// ===========================================================================
// THE PROOF. A guard nobody has seen fail is a guard nobody has seen.
//
// Every family below is a sentence a delivered document could actually contain,
// planted into a COPY of a real document, run through the same `readClaim` the
// sweep runs. A planting that changed nothing would "survive" for the wrong
// reason, so the harness checks its own substitution first.
// ===========================================================================

const PLANTINGS: ReadonlyArray<{ family: string; sentence: string; expect: RegExp }> = [
  {
    family: "a path that is not there",
    sentence: "Every gate is defined in `src/gates-v2.ts`.",
    expect: /src\/gates-v2\.ts.*no such file/,
  },
  {
    family: "a directory that is not there",
    sentence: "All of the vectors live in `skills/git-bundle-verify/vectors-v2/`.",
    expect: /skills\/git-bundle-verify\/vectors-v2.*no such file/,
  },
  {
    family: "an npm script that does not exist",
    sentence: "Every check runs with `npm run lint-docs`.",
    expect: /npm run lint-docs.*no such script/,
  },
  {
    family: "a subcommand that does not exist",
    sentence: "The only way to see the log is `skillonomia dump-log`.",
    expect: /skillonomia dump-log.*dispatches/,
  },
  {
    family: "an MCP tool that is not advertised",
    sentence: "Every adopter calls `skill.unadopt` and nothing else.",
    expect: /skill\.unadopt.*no such tool/,
  },
  {
    family: "a REST route that is not served",
    sentence: "No caller may reach `/v1/skills/purge`.",
    expect: /\/v1\/skills\/purge.*no such route/,
  },
  {
    family: "an environment variable nothing reads",
    sentence: "`SKILLONOMIA_TLS_CERT` must always be set.",
    expect: /SKILLONOMIA_TLS_CERT.*reads that variable/,
  },
  {
    family: "a count of the safety gates",
    sentence: "All nine safety gates run in one invocation.",
    expect: /claims 9 safety-gates/,
  },
  {
    family: "a count of the subcommands",
    sentence: "One executable, eight subcommands, on every packaging path.",
    expect: /claims 8 subcommands/,
  },
  {
    family: "a count of the packaging paths",
    sentence: "Only six packaging paths exist, and all of them are local.",
    expect: /claims 6 packaging-paths/,
  },
  {
    family: "a count of the red-team tests",
    sentence: "The threat model and the twenty red-team tests that cover it are shipped.",
    expect: /claims 20 red-team-tests/,
  },
  {
    family: "a count of the refused shell classes",
    sentence: "Gate 5 admits only what it can read: fifteen classes are refused.",
    expect: /claims 15 refused-shell-classes/,
  },
  {
    family: "a count of the schema's migrations",
    sentence: "The normative schema is given in **seven** migrations, applied in ascending order.",
    expect: /claims 7 migrations/,
  },
  {
    family: "a count of the defective bundles",
    sentence: "The package ships nine classes of defective bundle and one positive control.",
    expect: /claims 9 defective-bundles/,
  },
];

test("each planted family of false absolute is caught", () => {
  for (const planting of PLANTINGS) {
    const wrong = readSentence("README.md", planting.sentence).wrong;
    assert.ok(
      wrong.some((w) => planting.expect.test(w)),
      `${planting.family}: planted ${JSON.stringify(planting.sentence)} and the guard said ${JSON.stringify(wrong)}`,
    );
  }
  console.log(`[B-5] plantings caught: ${PLANTINGS.length}`);
});

test("the true form of each planted family passes", () => {
  // The other half of a mutation proof: a guard that refused everything would
  // catch every planting and be worth nothing.
  const TRUE_FORMS = [
    "Every gate is defined in `src/gates.ts`.",
    "All of the vectors live in `skills/git-bundle-verify/vectors/`.",
    "Every check runs with `npm run typecheck`.",
    "The only way to see the log is `skillonomia verify-log`.",
    "Every adopter calls `skill.adopt` and nothing else.",
    "No caller may reach `/v1/skills` without a key.",
    "`SKILLONOMIA_DATA` must always be set.",
    "All eight safety gates run in one invocation.",
    "One executable, six subcommands, on every packaging path.",
    "Only four packaging paths exist, and all of them are local.",
    "The threat model and the ten red-team tests that cover it are shipped.",
    "Gate 5 admits only what it can read: ten classes are refused.",
    "The normative schema is given in **twelve** migrations, applied in ascending order.",
    "The package ships four classes of defective bundle and one positive control.",
  ];
  assert.equal(TRUE_FORMS.length, PLANTINGS.length, "every planted family needs its true form beside it");
  for (const sentence of TRUE_FORMS) {
    const reading = readSentence("README.md", sentence);
    assert.deepEqual(reading.wrong, [], `a TRUE sentence was refused: ${sentence}`);
    assert.ok(reading.checked.length > 0, `a true form must actually be CHECKED, or it proves nothing: ${sentence}`);
  }
});

test("an undeclared absolute claim in a partitioned document is refused", () => {
  // The partition itself, proved: a sentence with no referent and no count is
  // exactly what the DECLARED list exists to hold, and one that is not in it
  // must not pass. This is the mechanism, run over a document copy in memory —
  // nothing is written to the tree.
  const sentence = "Skillonomia never loses a receipt, under any circumstances at all.";
  const claims = absoluteClaims("README.md", `# probe\n\n${sentence}\n`);
  assert.equal(claims.length, 1, "the planting produced the wrong number of claims");
  const claim = claims[0]!;
  assert.deepEqual(readClaim(claim).checked, [], "the planted sentence must name nothing this guard can check");
  assert.equal(
    declaredBy.has(`README.md ${claim.digest.slice(0, 16)}`),
    false,
    "the planted sentence must not already be declared, or this probe proves nothing",
  );
});
