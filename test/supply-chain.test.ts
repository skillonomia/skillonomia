// What a build of this commit is allowed to pull in.
//
// Two mutable pointers decide what actually runs when this repository is built:
// the Dockerfile's base image and the workflow's actions. Both were on tags.
// A tag is a name someone else can repoint, so a reviewer reading this commit
// could not tell what a build of it would contain — and neither could a second
// build a week later.
//
//   * The base image is pinned by DIGEST here, and this file refuses a tag.
//   * The actions are pinned to COMMIT SHAs by `ci/pin-actions.sh`, which needs
//     the network. Until that runs, each `uses:` carries an explicit
//     `# UNPINNED` marker naming the script, and this file refuses a `uses:`
//     that is neither a SHA nor marked. An invented SHA would be worse than a
//     tag — it would LOOK pinned — so the marker is the honest state, and it is
//     enforced rather than hoped for.
//
// The lockfile half of the same question (an install that resolves to the same
// bytes twice) is executed by the `supply-chain` job in CI; what can be checked
// offline is checked here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(WORKFLOW_DIR, f), "utf8") }));

test("the Dockerfile's base image is addressed by digest, not by tag", () => {
  const dockerfile = read("Dockerfile");
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length > 0, "the Dockerfile has a FROM");
  for (const image of froms) {
    assert.match(
      image,
      /^[^\s:@]+(\/[^\s:@]+)*@sha256:[0-9a-f]{64}$/,
      `FROM ${image} — a tag is a mutable pointer; pin the base image by digest ` +
        `(docker image inspect <image>:<tag> --format '{{index .RepoDigests 0}}')`,
    );
  }
  // the tag survives as a comment, or the digest is unreadable to a human
  assert.match(
    dockerfile,
    /#\s*\^?\s*oven\/bun:\d+\.\d+\.\d+-slim/,
    "the pinned digest must be annotated with the tag it was resolved from",
  );
});

test("every GitHub Action is pinned to a commit SHA, or explicitly marked as not yet pinned", () => {
  const SHA = /^[0-9a-f]{40}$/;
  let seen = 0;
  const unpinned: string[] = [];
  for (const { file, text } of workflows) {
    for (const line of text.split("\n")) {
      const m = /^\s*-?\s*uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@(\S+)(.*)$/.exec(line);
      if (!m) continue;
      seen += 1;
      const [, action, ref, rest] = m;
      if (SHA.test(ref)) {
        assert.match(rest, /#\s*\S+/, `${file}: ${action}@${ref} — keep the tag as a trailing comment`);
        continue;
      }
      assert.match(
        rest,
        /#\s*UNPINNED:\s*ci\/pin-actions\.sh/,
        `${file}: \`uses: ${action}@${ref}\` is on a mutable tag and carries no marker. ` +
          `Pin it with ci/pin-actions.sh, or mark it \`# UNPINNED: ci/pin-actions.sh\`.`,
      );
      unpinned.push(`${action}@${ref}`);
    }
  }
  assert.ok(seen >= 10, `every action is accounted for (found ${seen})`);

  // The debt is now zero, and this is where it stays zero. The marker branch
  // above still exists so that a newly added action fails here with a usable
  // message rather than slipping in on a tag — but an empty set is the only
  // passing value, so no marker can become a resting place.
  assert.deepEqual(
    [...new Set(unpinned)].sort(),
    [],
    "every action is pinned to a commit SHA; a new one on a tag must be pinned with ci/pin-actions.sh, not marked",
  );
});

test("ci/pin-actions.sh exists, is executable, and is the script the markers name", () => {
  const path = join(ROOT, "ci", "pin-actions.sh");
  const mode = statSync(path).mode;
  assert.ok((mode & 0o111) !== 0, "ci/pin-actions.sh must be executable");
  const src = read("ci/pin-actions.sh");
  assert.match(src, /--check/, "it can report what is still unpinned without rewriting");
  assert.match(src, /git\/tags/, "it dereferences annotated tags rather than using the tag object's own sha");
});

test("the lockfiles describe exactly package.json's dependencies", () => {
  // `npm ci` and `bun install --frozen-lockfile` enforce this at install time,
  // in CI, with the network. Offline, the same fact is readable from the files —
  // and a lock that has drifted is the single most common reason a documented
  // `npm ci` quickstart fails on someone else's machine.
  const pkg = JSON.parse(read("package.json"));
  const wanted = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;

  const npmLock = JSON.parse(read("package-lock.json"));
  const npmRoot = npmLock.packages[""];
  assert.equal(npmLock.name, pkg.name);
  assert.deepEqual(npmRoot.dependencies ?? {}, pkg.dependencies ?? {}, "package-lock.json root dependencies");
  assert.deepEqual(npmRoot.devDependencies ?? {}, pkg.devDependencies ?? {}, "package-lock.json root devDependencies");
  for (const [name, range] of Object.entries(wanted)) {
    const entry = npmLock.packages[`node_modules/${name}`];
    assert.ok(entry, `package-lock.json resolves ${name}`);
    assert.ok(entry.version, `package-lock.json pins a version for ${name} (range ${range})`);
  }

  // bun.lock is JSONC (trailing commas); the workspace block is what has to
  // agree with package.json, and it is compared as text so a reformat cannot
  // hide a change.
  const bunLock = read("bun.lock");
  for (const [name, range] of Object.entries(wanted)) {
    assert.ok(
      bunLock.includes(`"${name}": "${range}"`),
      `bun.lock's workspace block must carry ${name}: ${range} — run \`bun install\` and commit bun.lock`,
    );
    assert.ok(bunLock.includes(`"${name}@`), `bun.lock resolves ${name}`);
  }
  const npmVersion = (n: string): string => npmLock.packages[`node_modules/${n}`].version;
  for (const name of Object.keys(wanted)) {
    assert.ok(
      bunLock.includes(`"${name}@${npmVersion(name)}"`),
      `the two lockfiles disagree about ${name}: npm has ${npmVersion(name)} and bun.lock does not`,
    );
  }
});

test("the npm lockfile's outstanding integrity debt is exactly these six entries", () => {
  // A `package-lock.json` entry without `resolved`+`integrity` records WHICH
  // version to install and neither where it comes from nor what it hashes to.
  // `npm ci` will happily install such an entry from whatever the configured
  // registry answers with, unverified — which is most of the value of having a
  // lockfile at all.
  //
  // Six entries are in that state: the two runtime dependencies and their four
  // transitives. They are the entries npm did not fetch itself, so it had no
  // tarball hash to write down. Regenerating the file needs registry metadata
  // and therefore the network:
  //
  //     rm package-lock.json && npm install --package-lock-only && npm ci
  //
  // Until that runs, the debt is asserted EXACTLY — so it cannot grow quietly,
  // and paying it off fails this test until the list below is emptied, which is
  // the point.
  const lock = JSON.parse(read("package-lock.json"));
  const naked = Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string }>)
    .filter(([path, entry]) => path !== "" && !(entry.resolved && entry.integrity))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(naked, [
    "node_modules/ajv",
    "node_modules/ajv-formats",
    "node_modules/fast-deep-equal",
    "node_modules/fast-uri",
    "node_modules/json-schema-traverse",
    "node_modules/require-from-string",
  ], "run `rm package-lock.json && npm install --package-lock-only` (needs network), then empty this list");
});

// ---------------------------------------------------------------------------
// THE PRE-DEPLOY GATE'S REFUSALS, EXERCISED ON DOCUMENTS INSTEAD OF ON RELEASES.
//
// `ci/mvp-release.mjs hardening` reads registries. Its VALIDATION is pure — an
// in-toto statement, a SLSA predicate, an npm attestation bundle in, a verdict
// out — and that is the half a review can be wrong about without anybody
// noticing, because every one of its failure modes looks like a pass: an empty
// document accepted as an SBOM, a builder URL with a suffix accepted as a run,
// a publish attestation about some other version accepted as a countersignature,
// two genuine artifacts of two different releases accepted as one release.
//
// So the validators are exported and driven here with FIXTURES: one that is
// exactly right, and one per way of being wrong. Every negative below was
// written against a specific line of the previous implementation that accepted
// it, and the positive controls are what stop the negatives from being satisfied
// by a validator that refuses everything.
//
// The module is imported through a computed URL so this file stays free of a
// hand-written `.d.mts` for a script that has no types — a declaration file
// beside the implementation is one more thing that can drift away from it.
type Verdict = {
  family: string;
  artifact: string;
  status: string;
  detail: string;
  identity?: { repository: string | null; ref: string | null; commit: string | null; workflow: string | null; runId: string | null };
};
type Expected = ReturnType<typeof gate.releaseIdentity>;

const gate = (await import(new URL("../ci/mvp-release.mjs", import.meta.url).href)) as {
  releaseIdentity: (repo: string, version: string) => {
    repo: string;
    version: string;
    tag: string;
    ref: string;
    workflow: string;
    repositoryUrl: string;
    certificateIdentity: string;
  };
  imageSbom: (image: unknown, found: unknown) => Verdict;
  imageProvenance: (image: unknown, found: unknown, expected: Expected) => Verdict;
  npmProvenanceFrom: (pkg: unknown, dist: unknown, expected: Expected, bundles: unknown[]) => Verdict;
  releaseIdentityVerdict: (expected: Expected, image: unknown, npm: unknown, imageSignatureStatus?: string | null) => Verdict;
  cosignVerdict: (image: unknown, expected: Expected, present: string[]) => Verdict;
  repositoryOf: (repository: unknown) => { raw: string | null; url: string | null; fault: string | null };
  repositoryCheck: (manifest: unknown, expected: string, where: string) => Check;
  versionCheck: (version: string, tag: string | null) => Check;
  npmVersionCheck: (spec: string, version: string, packument: unknown) => Check;
  releaseCheck: (repo: string, tag: string, status: number) => Check;
  tarballCheck: (manifest: unknown, expected: string, version: string, name: string) => Check;
  tagObjectCheck: (tag: string, kind: string | null, sha: string | null, head: string | null) => Check;
};

type Check = { check: string; status: string; detail: string };

const REPO = "skillonomia/skillonomia";
const EXPECTED = gate.releaseIdentity(REPO, "0.1.2");
const INDEX = `sha256:${"a".repeat(64)}`;
const AMD64 = `sha256:${"1".repeat(64)}`;
const COMMIT = "b".repeat(40);
const RUN = "17";
const IMAGE = { ref: `ghcr.io/${REPO}@${INDEX}`, host: "ghcr.io", repository: REPO, digest: INDEX };

/** The registry answer `hardening` builds before any validator sees it. */
const published = (statements: unknown[]) => ({
  index: {},
  runtime: [{ digest: AMD64, platform: { os: "linux", architecture: "amd64" } }],
  attestations: [{}],
  statements: new Map([[AMD64, statements]]),
});

/** A correct BuildKit SPDX attestation of `AMD64`, with one thing changed. */
const spdx = (over: Record<string, unknown> = {}) => ({
  predicateType: "https://spdx.dev/Document",
  blob: `sha256:${"9".repeat(64)}`,
  statement: {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType: "https://spdx.dev/Document",
    subject: [{ name: "ghcr.io/skillonomia/skillonomia", digest: { sha256: AMD64.slice("sha256:".length) } }],
    predicate: { spdxVersion: "SPDX-2.3", packages: [{ name: "bun" }, { name: "ca-certificates" }] },
    ...over,
  },
});

/** A correct SLSA v1 provenance of `AMD64` for `v0.1.2`, with one thing changed. */
const provenance = (over: Record<string, unknown> = {}, predicateOver: Record<string, unknown> = {}) => ({
  predicateType: "https://slsa.dev/provenance/v1",
  blob: `sha256:${"8".repeat(64)}`,
  statement: {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "ghcr.io/skillonomia/skillonomia", digest: { sha256: AMD64.slice("sha256:".length) } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: `https://github.com/${REPO}`, ref: "refs/tags/v0.1.2", path: ".github/workflows/release.yml" },
        },
        resolvedDependencies: [{ uri: `git+https://github.com/${REPO}@refs/tags/v0.1.2`, digest: { gitCommit: COMMIT } }],
        ...predicateOver,
      },
      runDetails: { builder: { id: `https://github.com/${REPO}/actions/runs/${RUN}` } },
    },
    ...over,
  },
});

const TARBALL = createHash("sha512").update("the @skillonomia/cli tarball").digest();
const DIST = { integrity: `sha512-${TARBALL.toString("base64")}` };
const PKG = { spec: "@skillonomia/cli@0.1.2", name: "@skillonomia/cli", version: "0.1.2" };
const subjectOf = (sha512: string) => [{ name: "@skillonomia/cli", digest: { sha512 } }];

/** One entry of what `dist.attestations.url` serves, in npm's bundle shape. */
const bundle = (predicateType: string, statement: Record<string, unknown>, material: unknown = { certificate: { rawBytes: "MII..." } }) => ({
  predicateType,
  bundle: {
    verificationMaterial: material,
    dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"), payloadType: "application/vnd.in-toto+json" },
  },
});

const npmProvenanceStatement = (over: Record<string, unknown> = {}) => ({
  _type: "https://in-toto.io/Statement/v1",
  predicateType: "https://slsa.dev/provenance/v1",
  subject: subjectOf(TARBALL.toString("hex")),
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: { repository: `https://github.com/${REPO}`, ref: "refs/tags/v0.1.2", path: ".github/workflows/release.yml" },
      },
      resolvedDependencies: [{ uri: `git+https://github.com/${REPO}@refs/tags/v0.1.2`, digest: { gitCommit: COMMIT } }],
    },
    runDetails: { metadata: { invocationId: `https://github.com/${REPO}/actions/runs/${RUN}/attempts/1` } },
  },
  ...over,
});

const npmPublishStatement = (sha512: string = TARBALL.toString("hex")) => ({
  _type: "https://in-toto.io/Statement/v1",
  predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
  subject: subjectOf(sha512),
  predicate: { name: "@skillonomia/cli", version: "0.1.2", registry: "https://registry.npmjs.org" },
});

const NPM_PROVENANCE = "https://slsa.dev/provenance/v1";
const NPM_PUBLISH = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";

// --- the positive controls -------------------------------------------------
//
// A gate that refuses everything passes every negative test below. These four
// are what make the negatives mean something: the exact documents the release
// workflow is meant to produce, accepted.

test("[D-A] the SPDX attestation the release attaches is accepted", () => {
  const r = gate.imageSbom(IMAGE, published([spdx()]));
  assert.equal(r.status, "OK", r.detail);
  assert.match(r.detail, /SPDX-2\.3 \(2 packages\)/);
});

test("[D-B] the provenance the release attaches is accepted, and carries the release identity", () => {
  const r = gate.imageProvenance(IMAGE, published([provenance()]), EXPECTED);
  assert.equal(r.status, "OK", r.detail);
  assert.equal(r.identity?.commit, COMMIT);
  assert.equal(r.identity?.ref, "refs/tags/v0.1.2");
  assert.equal(r.identity?.runId, RUN);
});

test("[D-D] a trusted publish's bundle is accepted, and carries the same identity", () => {
  const r = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [
    bundle(NPM_PROVENANCE, npmProvenanceStatement()),
    bundle(NPM_PUBLISH, npmPublishStatement()),
  ]);
  assert.equal(r.status, "OK", r.detail);
  assert.equal(r.identity?.commit, COMMIT);
  assert.equal(r.identity?.runId, RUN);
});

test("[D-F] one release identity on both artifacts is accepted", () => {
  const image = gate.imageProvenance(IMAGE, published([provenance()]), EXPECTED);
  const npm = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [
    bundle(NPM_PROVENANCE, npmProvenanceStatement()),
    bundle(NPM_PUBLISH, npmPublishStatement()),
  ]);
  const r = gate.releaseIdentityVerdict(EXPECTED, image.identity, npm.identity);
  assert.equal(r.status, "OK", r.detail);
  assert.match(r.detail, new RegExp(`run ${RUN}`));
});

// --- A: the image's SBOM ---------------------------------------------------

test("[D-A1] an empty CycloneDX attestation is not an SBOM", () => {
  // The `packages < 1` refusal was written under `if (spdx !== undefined)`, so a
  // CycloneDX-annotated `{}` reached neither it nor any other check and was
  // reported as a carried SBOM. An operator reads `SBOM OK` and believes a CVE
  // can be looked up in the thing that is running.
  const empty = {
    predicateType: "https://cyclonedx.org/bom",
    blob: `sha256:${"7".repeat(64)}`,
    statement: {
      _type: "https://in-toto.io/Statement/v0.1",
      predicateType: "https://cyclonedx.org/bom",
      subject: [{ name: "ghcr.io/skillonomia/skillonomia", digest: { sha256: AMD64.slice("sha256:".length) } }],
      predicate: {},
    },
  };
  const r = gate.imageSbom(IMAGE, published([empty]));
  assert.notEqual(r.status, "OK", `an empty CycloneDX document was accepted: ${r.detail}`);
  assert.match(r.detail, /CycloneDX attestation on an image is not accepted/);
});

test("[D-A2] a layer annotated SPDX whose statement is about something else is refused", () => {
  // The annotation and the document disagreed and only the annotation was read.
  const r = gate.imageSbom(IMAGE, published([spdx({ predicateType: "https://cyclonedx.org/bom" })]));
  assert.notEqual(r.status, "OK", `the annotation was taken at its word: ${r.detail}`);
  assert.match(r.detail, /annotated https:\/\/spdx\.dev\/Document and the statement inside says/);
});

test("[D-A3] an SBOM blob that is not an in-toto Statement is refused", () => {
  const r = gate.imageSbom(IMAGE, published([spdx({ _type: undefined })]));
  assert.notEqual(r.status, "OK", `a bare predicate wrapper was accepted: ${r.detail}`);
  assert.match(r.detail, /`_type` is null/);
});

test("[D-A4] an SPDX document with no packages is refused", () => {
  const r = gate.imageSbom(IMAGE, published([spdx({ predicate: { spdxVersion: "SPDX-2.3", packages: [] } })]));
  assert.notEqual(r.status, "OK", r.detail);
  assert.match(r.detail, /lists no packages/);
});

test("[D-A5] an SPDX attestation about another platform's digest is refused", () => {
  const other = spdx();
  other.statement.subject = [{ name: "ghcr.io/skillonomia/skillonomia", digest: { sha256: "f".repeat(64) } }];
  const r = gate.imageSbom(IMAGE, published([other]));
  assert.notEqual(r.status, "OK", r.detail);
  assert.match(r.detail, /does not name sha256:1{64} among its subjects/);
});

// --- B: the image's provenance ---------------------------------------------

test("[D-B1] a builder.id with a suffix after the run number is refused", () => {
  // `^https://github\.com/<repo>/actions/runs/\d+` with no `$`: the prefix
  // matches and the tail is whatever was appended. The value below is a URL a
  // reader would click, and it is not a run of anything.
  const forged = provenance();
  forged.statement.predicate.runDetails.builder.id = `https://github.com/${REPO}/actions/runs/123/not-a-valid-run-document`;
  const r = gate.imageProvenance(IMAGE, published([forged]), EXPECTED);
  assert.notEqual(r.status, "OK", `an unanchored builder.id was accepted: ${r.detail}`);
  assert.match(r.detail, /not a run of skillonomia\/skillonomia/);
});

test("[D-B2] a provenance blob that is not an in-toto Statement is refused", () => {
  const r = gate.imageProvenance(IMAGE, published([provenance({ _type: "https://example.invalid/Statement" })]), EXPECTED);
  assert.notEqual(r.status, "OK", r.detail);
  assert.match(r.detail, /an in-toto Statement is what carries a predicate/);
});

test("[D-B3] provenance of a genuine build of ANOTHER tag of this repository is refused", () => {
  const older = provenance();
  older.statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/v0.1.1";
  older.statement.predicate.buildDefinition.resolvedDependencies = [
    { uri: `git+https://github.com/${REPO}@refs/tags/v0.1.1`, digest: { gitCommit: "d".repeat(40) } },
  ];
  const r = gate.imageProvenance(IMAGE, published([older]), EXPECTED);
  assert.notEqual(r.status, "OK", `an image of v0.1.1 passed the gate for v0.1.2: ${r.detail}`);
  assert.match(r.detail, /the ref is refs\/tags\/v0\.1\.1 and 0\.1\.2 is released from refs\/tags\/v0\.1\.2/);
});

test("[D-B4] provenance that records no workflow and no commit is refused, not attributed", () => {
  const bare = provenance({}, { externalParameters: {}, resolvedDependencies: [] });
  const r = gate.imageProvenance(IMAGE, published([bare]), EXPECTED);
  assert.notEqual(r.status, "OK", r.detail);
  assert.match(r.detail, /the workflow is \(not recorded\)/);
  assert.match(r.detail, /does not record the commit it was built from/);
});

// --- C and the marker ------------------------------------------------------

test("[D-C1] the cryptographic verification of the npm bundle happens in the gate, and gates the marker", () => {
  // `npm_bundle_cryptographically_verified` was the literal `false` while the
  // marker was printed on the families alone — the record and the marker
  // contradicted each other in the one place a deploy reads.
  const src = read("ci/mvp-release.mjs");
  assert.match(src, /npm audit signatures/, "the gate runs the verifier itself");
  assert.doesNotMatch(
    src,
    /npm_bundle_cryptographically_verified:\s*false\b/,
    "the record's verification field must be this run's result, not a constant",
  );
  assert.match(
    src,
    /marker:\s*failed\.length === 0 && cryptographicallyVerified/,
    "SUPPLY_CHAIN_HARDENING_OK is refused unless the bundle was cryptographically verified",
  );
  assert.match(src, /const cryptographicallyVerified = npmSig\.status === "OK"/);
});

test("[D-C2] a missing verifier is UNVERIFIABLE and never OK", () => {
  // `cosign` is not installed in every place a deploy runs, and a check that
  // downgraded to "the signature is present" when its verifier was missing is
  // the failure this stage exists to prevent. This is a regression lock on
  // behaviour the previous implementation also had.
  const r = gate.cosignVerdict(IMAGE, EXPECTED, ["the `.sig` tag sha256-…"]);
  assert.ok(["UNVERIFIABLE", "OK", "REFUSED"].includes(r.status));
  assert.notEqual(r.status, "MISSING");
  if (r.status === "UNVERIFIABLE") assert.match(r.detail, /is not on this machine's PATH/);
});

test("[D-C3] the cosign identity is pinned to the exact tag, not to any tag", () => {
  // `--certificate-identity-regexp "…@refs/tags/"` accepts a signature this
  // workflow made on ANY tag — a correct signature over a different release.
  assert.equal(EXPECTED.certificateIdentity, `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v0.1.2`);
  const src = read("ci/mvp-release.mjs");
  assert.doesNotMatch(
    src,
    /"--certificate-identity-regexp"/,
    "an identity regexp is a prefix match over every tag; the flag must not be passed to cosign (the prose above may still name it)",
  );
  assert.match(src, /"--certificate-identity", expected\.certificateIdentity/);
});

// --- D: the npm publish attestation ----------------------------------------

test("[D-D1] a publish attestation about another version of the same package is refused", () => {
  // `statements.some(s => s.predicateType === NPM_PUBLISH_PREDICATE)` asked
  // whether the bundle carried one, and the bundle is fetched from a URL the
  // registry chose. A countersignature of a different upload is not a
  // countersignature of this one.
  const r = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [
    bundle(NPM_PROVENANCE, npmProvenanceStatement()),
    bundle(NPM_PUBLISH, npmPublishStatement(createHash("sha512").update("some other tarball").digest("hex"))),
  ]);
  assert.notEqual(r.status, "OK", `an unbound publish attestation was accepted: ${r.detail}`);
  assert.match(r.detail, /and the registry serves sha512-/);
  assert.match(r.detail, /the registry did not countersign THIS upload/);
});

test("[D-D2] a bundle with no certificate is refused", () => {
  const r = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [
    bundle(NPM_PROVENANCE, npmProvenanceStatement(), null),
    bundle(NPM_PUBLISH, npmPublishStatement()),
  ]);
  assert.notEqual(r.status, "OK", `an uncertified bundle was accepted with a parenthetical: ${r.detail}`);
  assert.match(r.detail, /carries no certificate in `verificationMaterial`/);
});

test("[D-D3] a bundle whose payload is not base64 of JSON is refused, and does not throw", () => {
  const broken = bundle(NPM_PROVENANCE, npmProvenanceStatement());
  broken.bundle.dsseEnvelope.payload = "bm90IGpzb24=";
  const r = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [broken, bundle(NPM_PUBLISH, npmPublishStatement())]);
  assert.notEqual(r.status, "OK", r.detail);
  assert.match(r.detail, /not base64 of JSON/);
});

test("[D-D4] a package published by a workflow that is not release.yml is refused", () => {
  // This is the one that decides whether an already-published version can ever
  // pass: `0.1.2` went out of `npm-v012-recovery.yml`, and the previous check
  // compared only `workflow.repository`.
  const recovery = npmProvenanceStatement();
  (recovery.predicate.buildDefinition.externalParameters.workflow as { path: string }).path = ".github/workflows/npm-v012-recovery.yml";
  const r = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [bundle(NPM_PROVENANCE, recovery), bundle(NPM_PUBLISH, npmPublishStatement())]);
  assert.notEqual(r.status, "OK", `a publish by another workflow of this repository was accepted: ${r.detail}`);
  assert.match(r.detail, /only \.github\/workflows\/release\.yml publishes this project/);
});

// --- F: one release, or two artifacts that each look fine -------------------

test("[D-F1] a genuine image and a genuine package from different commits are refused together", () => {
  const image = { repository: EXPECTED.repositoryUrl, ref: EXPECTED.ref, workflow: EXPECTED.workflow, commit: "a".repeat(40), runId: "17" };
  const npm = { repository: EXPECTED.repositoryUrl, ref: EXPECTED.ref, workflow: EXPECTED.workflow, commit: "b".repeat(40), runId: "18" };
  const r = gate.releaseIdentityVerdict(EXPECTED, image, npm);
  assert.equal(r.status, "REFUSED", `two releases were accepted as one: ${r.detail}`);
  assert.match(r.detail, /genuine artifacts of two different releases/);
});

test("[D-F2] the same commit published by two different runs is refused", () => {
  const base = { repository: EXPECTED.repositoryUrl, ref: EXPECTED.ref, workflow: EXPECTED.workflow, commit: COMMIT };
  const r = gate.releaseIdentityVerdict(EXPECTED, { ...base, runId: "17" }, { ...base, runId: "18" });
  assert.equal(r.status, "REFUSED", r.detail);
  assert.match(r.detail, /publishes both from one run/);
});

test("[D-F3] an unreadable provenance on either side is a refusal, not a skipped comparison", () => {
  const npm = { repository: EXPECTED.repositoryUrl, ref: EXPECTED.ref, workflow: EXPECTED.workflow, commit: COMMIT, runId: RUN };
  const r = gate.releaseIdentityVerdict(EXPECTED, null, npm);
  assert.equal(r.status, "REFUSED", r.detail);
  assert.match(r.detail, /two artifacts are one release only if both say so/);
});

// --- G: the one field BuildKit does not write ------------------------------
//
// `identityFaults` demanded `workflow` of BOTH provenances. npm's generator
// writes it; BuildKit's does not, under any build mode: its `externalParameters`
// are `{configSource, request}` and `configSource.path` is `Dockerfile` — the
// file the build read, not the workflow that ran it. So the image side of the
// gate demanded a field its own producer cannot emit, and no image this pipeline
// builds could ever pass.
//
// The carve-out below is exactly one field wide, and these tests are what say
// so: the workflow may be ABSENT from an image provenance whose repository, ref,
// commit, subject digest and `builder.id` all bind to this release, and nothing
// else is forgiven — not a wrong workflow, not a wrong anything-else, not the
// npm side, and not an image whose certificate went unverified.
//
// EACH TEST CARRIES ITS OWN CONTROL. A bare negative here ("a broken ref is
// refused") passes on ca6baf0a too — that gate refused everything — so it would
// prove nothing about the carve-out. What discriminates is the pair: the
// workflow-less provenance is ACCEPTED here and the same document with one
// binding broken is REFUSED. The accepting half is the half ca6baf0a fails.

/**
 * The provenance BuildKit actually attaches to an image built from a git
 * context: a `configSource` naming the repository, the tag and the commit, a
 * `request`, `path: "Dockerfile"` — and no `workflow` anywhere. The shape is the
 * one observed on a locally built and pushed index (§3 of the D report).
 */
const buildkit = (over: Record<string, unknown> = {}, configOver: Record<string, unknown> = {}) => ({
  predicateType: "https://slsa.dev/provenance/v1",
  blob: `sha256:${"6".repeat(64)}`,
  statement: {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "ghcr.io/skillonomia/skillonomia", digest: { sha256: AMD64.slice("sha256:".length) } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          configSource: {
            uri: `https://github.com/${REPO}.git#refs/tags/v0.1.2`,
            digest: { sha1: COMMIT },
            path: "Dockerfile",
            ...configOver,
          },
          request: { frontend: "dockerfile.v0", args: { "build-arg:VERSION": "0.1.2" } },
        },
      },
      runDetails: { builder: { id: `https://github.com/${REPO}/actions/runs/${RUN}` } },
    },
    ...over,
  },
});

/**
 * What `imageProvenance` reads out of the document above — asserted against the
 * real fixture in [D-G1], and driven directly into `releaseIdentityVerdict` in
 * [D-G5] and [D-G6] so that those two test the SENTENCE and not the reader.
 */
const IMAGE_IDENTITY = { repository: EXPECTED.repositoryUrl, ref: EXPECTED.ref, commit: COMMIT, workflow: null, runId: RUN };

/** npm's provenance with the one field npm's generator does write taken out. */
const npmWithoutWorkflow = () => {
  const s = npmProvenanceStatement();
  (s.predicate.buildDefinition as { externalParameters: Record<string, unknown> }).externalParameters = {};
  return s;
};

test("[D-G1] an image provenance that records no workflow, and binds everything else, is accepted", () => {
  // On ca6baf0a this is REFUSED with `the workflow is (not recorded)` — the
  // refusal a BuildKit image can never talk its way out of, because the field
  // does not exist at the producer.
  const r = gate.imageProvenance(IMAGE, published([buildkit()]), EXPECTED);
  assert.equal(r.status, "OK", `a BuildKit provenance was refused for a field BuildKit does not write: ${r.detail}`);
  assert.equal(r.identity?.repository, EXPECTED.repositoryUrl);
  assert.equal(r.identity?.ref, EXPECTED.ref);
  assert.equal(r.identity?.commit, COMMIT);
  assert.equal(r.identity?.runId, RUN);
  // and the field is reported as what it is: absent, not satisfied.
  assert.equal(r.identity?.workflow, null);
  // this is also what ties [D-G5] and [D-G6] to a real document: the identity
  // they hand to the verdict is the one this reader produces, field for field.
  const { repository, ref, commit, workflow, runId } = r.identity!;
  assert.deepEqual({ repository, ref, commit, workflow, runId }, IMAGE_IDENTITY);
});

test("[D-G2] the absent workflow is excused only while the repository, the ref and the commit all bind", () => {
  assert.equal(gate.imageProvenance(IMAGE, published([buildkit()]), EXPECTED).status, "OK", "the control: the carve-out exists");

  const otherRepo = gate.imageProvenance(IMAGE, published([buildkit({}, { uri: "https://github.com/someone-else/skillonomia.git#refs/tags/v0.1.2" })]), EXPECTED);
  assert.notEqual(otherRepo.status, "OK", `another repository was accepted: ${otherRepo.detail}`);
  assert.match(otherRepo.detail, /it was built by https:\/\/github\.com\/someone-else\/skillonomia and this deploy expects/);
  assert.match(otherRepo.detail, /the workflow is \(not recorded\)/, "the excuse is withdrawn as soon as anything else fails");

  const otherTag = gate.imageProvenance(IMAGE, published([buildkit({}, { uri: `https://github.com/${REPO}.git#refs/tags/v0.1.1` })]), EXPECTED);
  assert.notEqual(otherTag.status, "OK", `an image of another tag was accepted: ${otherTag.detail}`);
  assert.match(otherTag.detail, /the ref is refs\/tags\/v0\.1\.1 and 0\.1\.2 is released from refs\/tags\/v0\.1\.2/);

  const noCommit = gate.imageProvenance(IMAGE, published([buildkit({}, { digest: {} })]), EXPECTED);
  assert.notEqual(noCommit.status, "OK", `a provenance naming no commit was accepted: ${noCommit.detail}`);
  assert.match(noCommit.detail, /does not record the commit it was built from/);

  // and a workflow that IS recorded is still compared, because the carve-out is
  // for a producer with nothing to say, not for one that says the wrong thing.
  const wrong = buildkit();
  (wrong.statement.predicate.buildDefinition.externalParameters.configSource as { entryPoint?: string }).entryPoint = ".github/workflows/npm-v012-recovery.yml";
  const named = gate.imageProvenance(IMAGE, published([wrong]), EXPECTED);
  assert.notEqual(named.status, "OK", `a wrong workflow rode in on the carve-out: ${named.detail}`);
  assert.match(named.detail, /the workflow is \.github\/workflows\/npm-v012-recovery\.yml/);
});

test("[D-G3] the absent workflow is excused only while builder.id is a run of this repository", () => {
  assert.equal(gate.imageProvenance(IMAGE, published([buildkit()]), EXPECTED).status, "OK", "the control: the carve-out exists");

  const forged = buildkit();
  forged.statement.predicate.runDetails.builder.id = "https://github.com/someone-else/skillonomia/actions/runs/17";
  const r = gate.imageProvenance(IMAGE, published([forged]), EXPECTED);
  assert.notEqual(r.status, "OK", `a run of another repository was accepted: ${r.detail}`);
  assert.match(r.detail, /not a run of skillonomia\/skillonomia/);

  // min-mode provenance — an empty builder — is the other half of the same
  // check, and the carve-out must not have reopened it.
  const min = buildkit();
  min.statement.predicate.runDetails.builder.id = "";
  const m = gate.imageProvenance(IMAGE, published([min]), EXPECTED);
  assert.notEqual(m.status, "OK", `mode=min provenance was accepted: ${m.detail}`);
  assert.match(m.detail, /a build happened, and it says nothing about whose/);

  // the subject binding, likewise: an attestation about some other platform's
  // digest is not this image's, carve-out or no carve-out.
  const elsewhere = buildkit();
  elsewhere.statement.subject = [{ name: "ghcr.io/skillonomia/skillonomia", digest: { sha256: "f".repeat(64) } }];
  const s = gate.imageProvenance(IMAGE, published([elsewhere]), EXPECTED);
  assert.notEqual(s.status, "OK", `an attestation about another digest was accepted: ${s.detail}`);
  assert.match(s.detail, /does not name sha256:1{64} among its subjects/);
});

test("[D-G4] the carve-out is the image's alone: an npm provenance with no workflow is still refused", () => {
  // The npm side comes out of a generator that writes `externalParameters.workflow`,
  // so a bundle without it is not a producer's limitation — it is a publish this
  // gate cannot attribute to `release.yml`, and `0.1.2` went out of another
  // workflow (see [D-D4]). Nothing about the image's missing field weakens this.
  assert.equal(gate.imageProvenance(IMAGE, published([buildkit()]), EXPECTED).status, "OK", "the control: the image's absent workflow is excused");

  const r = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [bundle(NPM_PROVENANCE, npmWithoutWorkflow()), bundle(NPM_PUBLISH, npmPublishStatement())]);
  assert.notEqual(r.status, "OK", `an unattributed npm publish was accepted: ${r.detail}`);
  assert.match(r.detail, /the workflow is \(not recorded\) and only \.github\/workflows\/release\.yml publishes this project/);
});

test("[D-G5] a workflow-less image whose signature was not verified is refused by the identity line", () => {
  // What names `release.yml` for an image whose provenance cannot is the Fulcio
  // identity on its signature. If `cosign verify` did not accept it — refused,
  // or UNVERIFIABLE because cosign is not installed — then nothing named the
  // workflow at all, and the identity line says so instead of passing.
  const npm = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [bundle(NPM_PROVENANCE, npmProvenanceStatement()), bundle(NPM_PUBLISH, npmPublishStatement())]);
  assert.equal(npm.status, "OK", npm.detail);

  for (const status of ["REFUSED", "UNVERIFIABLE", "MISSING", null]) {
    const r = gate.releaseIdentityVerdict(EXPECTED, IMAGE_IDENTITY, npm.identity, status);
    assert.equal(r.status, "REFUSED", `signature ${status ?? "(not passed)"} and the identity line still passed: ${r.detail}`);
    assert.match(r.detail, /does not name a workflow/);
    assert.ok(r.detail.includes(EXPECTED.certificateIdentity), `the refusal names the certificate that would have carried it: ${r.detail}`);
  }

  const ok = gate.releaseIdentityVerdict(EXPECTED, IMAGE_IDENTITY, npm.identity, "OK");
  assert.equal(ok.status, "OK", `a verified signature is what the carve-out rests on: ${ok.detail}`);
});

test("[D-G6] the successful verdict does not claim the image named the workflow", () => {
  // THIS IS THE POINT OF THE WHOLE CHANGE. The old sentence — `both artifacts
  // name <repo> <workflow>@<ref> at commit <sha>` — was true while both
  // provenances were required to carry the workflow. After the carve-out it
  // would be a gate asserting a fact it did not check, about the one field it
  // stopped checking, in the line an operator reads to decide a deploy.
  const npm = gate.npmProvenanceFrom(PKG, DIST, EXPECTED, [bundle(NPM_PROVENANCE, npmProvenanceStatement()), bundle(NPM_PUBLISH, npmPublishStatement())]);
  const r = gate.releaseIdentityVerdict(EXPECTED, IMAGE_IDENTITY, npm.identity, "OK");
  assert.equal(r.status, "OK", r.detail);

  assert.doesNotMatch(
    r.detail,
    /both artifacts name .*\.github\/workflows\/release\.yml/,
    `the verdict claims both artifacts name the workflow, and the image's provenance does not: ${r.detail}`,
  );
  // what it says instead, and every clause of it was checked above:
  assert.match(r.detail, /The package's provenance names \.github\/workflows\/release\.yml/);
  assert.match(r.detail, /the image's provenance names no workflow/);
  assert.match(r.detail, /`builder\.id` run of skillonomia\/skillonomia/);
  assert.ok(r.detail.includes(EXPECTED.certificateIdentity), `the verdict names the identity cosign checked: ${r.detail}`);
  assert.match(r.detail, new RegExp(`commit ${COMMIT}`));
  assert.match(r.detail, new RegExp(`run ${RUN}`));

  // and when a generator DOES name the workflow on both sides, the old sentence
  // is still the true one and is still what gets printed.
  const named = gate.imageProvenance(IMAGE, published([provenance()]), EXPECTED);
  const both = gate.releaseIdentityVerdict(EXPECTED, named.identity, npm.identity, "OK");
  assert.equal(both.status, "OK", both.detail);
  assert.match(both.detail, /both artifacts name https:\/\/github\.com\/skillonomia\/skillonomia \.github\/workflows\/release\.yml@refs\/tags\/v0\.1\.2/);
});

test("[D-F4] the expected tag is derived from the npm version and nothing else", () => {
  const other = gate.releaseIdentity(REPO, "9.9.9");
  assert.equal(other.tag, "v9.9.9");
  assert.equal(other.ref, "refs/tags/v9.9.9");
  assert.equal(other.certificateIdentity, `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v9.9.9`);
  const r = gate.imageProvenance(IMAGE, published([provenance()]), other);
  assert.notEqual(r.status, "OK", "an image of v0.1.2 must not pass the gate for v9.9.9");
});

// ---------------------------------------------------------------------------
// THE PREFLIGHT'S REFUSALS — THE GATE THAT RUNS BEFORE THE TAG.
//
// `v0.1.3` published a binary and an image and then the npm registry refused
// the third artifact:
//
//     npm error code E422
//     Error verifying sigstore provenance bundle: Failed to validate repository
//     information: package.json: "repository.url" is "", expected to match
//     "https://github.com/skillonomia/skillonomia" from provenance
//
// The signing worked. `package.json` carried no `repository`, and the registry
// compares that field with the repository the provenance names. One line, and
// it cost a version — because the release had already published two artifacts
// that cannot be withdrawn by the time the third was refused.
//
// EVERY CHECK IN THIS PROJECT READ SOMETHING PUBLISHED. `binary --tag`
// downloads a release, `ghcr` pulls an image, `hardening` reads both
// registries — correct for each of them, and between them they left the
// PRECONDITIONS of a publish examined by nobody until the registry examined
// them. `preflight` is the check that runs first and reads none of them.
//
// [P-A] IS THE REGRESSION ITSELF, and it is the only test here that reads this
// tree rather than a fixture: it takes THIS `package.json` and asks the
// question the registry asked. On `5206dbbc` — the tree `v0.1.3` was cut from —
// it fails, with the same sentence the registry answered with.

const PREFLIGHT_REPO = "https://github.com/skillonomia/skillonomia";
const manifestOf = (over: Record<string, unknown> = {}) => ({ name: "@skillonomia/cli", version: "0.1.4", ...over });

test("[P-A] this tree's package.json names the repository the provenance will name", () => {
  // THE REGRESSION ON v0.1.3. This assertion fails on 5206dbbc, whose
  // package.json has no `repository` at all, and the failure message is the
  // registry's own complaint.
  const manifest = JSON.parse(read("package.json"));
  const r = gate.repositoryCheck(manifest, PREFLIGHT_REPO, "package.json");
  assert.equal(r.status, "OK", r.detail);
  assert.equal(gate.repositoryOf(manifest.repository).url, PREFLIGHT_REPO);
});

test("[P-B] every form npm resolves to this repository is accepted, and resolves to one string", () => {
  // The positive control the refusals below need: a parser that refused
  // everything would pass all of them. These are the shapes `hosted-git-info`
  // accepts for github — the shorthand, the shortcut, the scp form and the six
  // protocols — each with and without `.git`.
  const forms = [
    "git+https://github.com/skillonomia/skillonomia.git",
    "https://github.com/skillonomia/skillonomia.git",
    "https://github.com/skillonomia/skillonomia",
    "http://github.com/skillonomia/skillonomia",
    "https://www.github.com/skillonomia/skillonomia",
    "git://github.com/skillonomia/skillonomia.git",
    "ssh://git@github.com/skillonomia/skillonomia.git",
    "git+ssh://git@github.com/skillonomia/skillonomia.git",
    "git@github.com:skillonomia/skillonomia.git",
    "github:skillonomia/skillonomia",
    "skillonomia/skillonomia",
    "https://github.com/skillonomia/skillonomia.git#v0.1.4",
  ];
  for (const url of forms) {
    assert.equal(gate.repositoryOf(url).url, PREFLIGHT_REPO, `the string form ${url}`);
    assert.equal(gate.repositoryOf({ type: "git", url }).url, PREFLIGHT_REPO, `the object form ${url}`);
  }
});

test("[P-1] a manifest with no repository field at all is refused", () => {
  // The v0.1.3 tree, exactly.
  const r = gate.repositoryCheck(manifestOf(), PREFLIGHT_REPO, "package.json");
  assert.equal(r.status, "REFUSED", r.detail);
  assert.match(r.detail, /there is no `repository` field at all/);
  assert.match(r.detail, /Failed to validate repository information/);
});

test("[P-2] `repository.url` is the empty string — the field the registry quoted back", () => {
  const r = gate.repositoryCheck(manifestOf({ repository: { type: "git", url: "" } }), PREFLIGHT_REPO, "package.json");
  assert.equal(r.status, "REFUSED", r.detail);
  assert.match(r.detail, /`repository\.url` is ""/);
});

test("[P-3] a repository object that carries no url is refused", () => {
  const r = gate.repositoryCheck(manifestOf({ repository: { type: "git" } }), PREFLIGHT_REPO, "package.json");
  assert.equal(r.status, "REFUSED", r.detail);
  assert.match(r.detail, /carries no `url` string/);
});

test("[P-4] somebody else's repository, and a one-character typo in this one, are refused", () => {
  // Both resolve; neither is the repository the provenance will name, which is
  // the whole of what the registry compares.
  for (const url of [
    "git+https://github.com/someone-else/skillonomia.git",
    "git+https://github.com/skillonomia/skillonomiaa.git",
    "git+https://github.com/skillonomia.git",
  ]) {
    const r = gate.repositoryCheck(manifestOf({ repository: { type: "git", url } }), PREFLIGHT_REPO, "package.json");
    assert.equal(r.status, "REFUSED", `${url} was accepted: ${r.detail}`);
  }
  const typo = gate.repositoryCheck(
    manifestOf({ repository: { type: "git", url: "git+https://github.com/skillonomia/skillonomiaa.git" } }),
    PREFLIGHT_REPO,
    "package.json",
  );
  assert.match(typo.detail, /resolves to https:\/\/github\.com\/skillonomia\/skillonomiaa; the provenance will say/);
});

test("[P-5] a repository on another host, and a string that is not a repository, are refused", () => {
  const elsewhere = gate.repositoryOf("git+https://gitlab.com/skillonomia/skillonomia.git");
  assert.equal(elsewhere.url, null, "a gitlab URL resolved to a github repository");
  assert.match(elsewhere.fault!, /whose host is gitlab\.com/);

  for (const url of ["not a url at all", "https://github.com/", "https://example.com/skillonomia/skillonomia"]) {
    assert.equal(gate.repositoryOf(url).url, null, `${url} resolved to something`);
  }
});

test("[P-6] the version and the tag are compared, and a missing tag is not a pass", () => {
  assert.equal(gate.versionCheck("0.1.4", "v0.1.4").status, "OK");
  const wrong = gate.versionCheck("0.1.4", "v0.1.3");
  assert.equal(wrong.status, "REFUSED", wrong.detail);
  assert.match(wrong.detail, /a release cannot carry a version its own manifest disagrees with/);
  assert.equal(gate.versionCheck("0.1.4", "0.1.4").status, "REFUSED", "a tag without its `v` is not the tag release.yml runs on");
  // absent is SKIPPED, and a SKIPPED line is what keeps the acceptance marker
  // from being printed — it is never counted as an answer.
  const none = gate.versionCheck("0.1.4", null);
  assert.equal(none.status, "SKIPPED", none.detail);
  assert.notEqual(none.status, "OK");
});

test("[P-7] a version the registry already serves is refused", () => {
  // `npm publish` answers E403 for this, in the third job, after the binary and
  // the image are published.
  const packument = { versions: { "0.1.2": {}, "0.1.4": {} } };
  const spent = gate.npmVersionCheck("@skillonomia/cli", "0.1.4", packument);
  assert.equal(spent.status, "REFUSED", spent.detail);
  assert.match(spent.detail, /already serves @skillonomia\/cli@0\.1\.4/);

  assert.equal(gate.npmVersionCheck("@skillonomia/cli", "0.1.5", packument).status, "OK");
  // a package the registry has never heard of is the commonest passing answer
  assert.equal(gate.npmVersionCheck("@skillonomia/cli", "0.1.4", null).status, "OK");
});

test("[P-8] a tag whose release already exists is refused, and an unanswered question is not a pass", () => {
  assert.equal(gate.releaseCheck(REPO, "v0.1.4", 404).status, "OK");
  const exists = gate.releaseCheck(REPO, "v0.1.3", 200);
  assert.equal(exists.status, "REFUSED", exists.detail);
  assert.match(exists.detail, /creates releases and never amends them/);
  for (const status of [403, 500, 0]) {
    const r = gate.releaseCheck(REPO, "v0.1.4", status);
    assert.equal(r.status, "UNVERIFIABLE", `${status} was treated as an answer: ${r.detail}`);
    assert.notEqual(r.status, "OK");
  }
});

test("[P-9] the tarball is read, not the tree — the registry reads the manifest inside the archive", () => {
  // A tree can be right and the archive wrong: `files`, `prepack` and a packing
  // bug are three ways. The registry never sees the tree.
  const good = manifestOf({ repository: { type: "git", url: "git+https://github.com/skillonomia/skillonomia.git" } });
  assert.equal(gate.tarballCheck(good, PREFLIGHT_REPO, "0.1.4", "skillonomia-cli-0.1.4.tgz").status, "OK");

  const stripped = gate.tarballCheck(manifestOf(), PREFLIGHT_REPO, "0.1.4", "skillonomia-cli-0.1.4.tgz");
  assert.equal(stripped.status, "REFUSED", stripped.detail);
  assert.match(stripped.detail, /package\/package\.json: there is no `repository` field at all/);

  const stale = gate.tarballCheck({ ...good, version: "0.1.3" }, PREFLIGHT_REPO, "0.1.4", "skillonomia-cli-0.1.4.tgz");
  assert.equal(stale.status, "REFUSED", stale.detail);
  assert.match(stale.detail, /declares version "0\.1\.3" and the working tree declares 0\.1\.4/);
});

test("[P-10] an annotated tag is refused before it is pushed, not after both artifacts are published", () => {
  const head = "c".repeat(40);
  const ok = gate.tagObjectCheck("v0.1.4", "commit", head, head);
  assert.equal(ok.status, "OK", ok.detail);

  const annotated = gate.tagObjectCheck("v0.1.4", "tag", "e".repeat(40), head);
  assert.equal(annotated.status, "REFUSED", annotated.detail);
  assert.match(annotated.detail, /is a tag object/);
  assert.match(annotated.detail, /refused as different releases/);

  const elsewhere = gate.tagObjectCheck("v0.1.4", "commit", "f".repeat(40), head);
  assert.equal(elsewhere.status, "REFUSED", elsewhere.detail);

  // absent is SKIPPED — the same rule as [P-6]: not an answer, and not a pass.
  const absent = gate.tagObjectCheck("v0.1.4", null, null, head);
  assert.equal(absent.status, "SKIPPED", absent.detail);
  assert.notEqual(absent.status, "OK");
});

test("[P-11] release.yml runs preflight before it publishes anything, and demands the acceptance marker", () => {
  // comments removed, as in `test/source-only.test.ts`: a step is what RUNS,
  // and the prose above this one names `gh release create` while explaining
  // what it comes before.
  const release = read(".github/workflows/release.yml").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const preflight = release.indexOf("ci/mvp-release.mjs preflight");
  assert.ok(preflight > -1, "release.yml no longer runs the preflight");
  for (const verb of ["gh release create", "npm publish", "--push", "ci/mvp-release.mjs binary", "docker buildx build"]) {
    const at = release.indexOf(verb);
    assert.ok(at > -1, `release.yml no longer runs \`${verb}\` — this guard is reading the wrong file`);
    assert.ok(preflight < at, `\`${verb}\` runs before the preflight, so a release that cannot finish would still publish through it`);
  }
  // a STAGED run is not the run this step demands
  assert.match(
    release,
    /grep -qx 'RELEASE_PREFLIGHT_OK'/,
    "release.yml awaits the preflight's exit status and not its marker; a staged run answers 0 with checks unasked",
  );
  const src = read("ci/mvp-release.mjs");
  assert.match(src, /const PREFLIGHT_OK = "RELEASE_PREFLIGHT_OK"/);
  assert.match(src, /const PREFLIGHT_STAGED = "RELEASE_PREFLIGHT_STAGED_OK"/);
});
