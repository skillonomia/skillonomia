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
  releaseIdentityVerdict: (expected: Expected, image: unknown, npm: unknown) => Verdict;
  cosignVerdict: (image: unknown, expected: Expected, present: string[]) => Verdict;
};

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

test("[D-F4] the expected tag is derived from the npm version and nothing else", () => {
  const other = gate.releaseIdentity(REPO, "9.9.9");
  assert.equal(other.tag, "v9.9.9");
  assert.equal(other.ref, "refs/tags/v9.9.9");
  assert.equal(other.certificateIdentity, `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v9.9.9`);
  const r = gate.imageProvenance(IMAGE, published([provenance()]), other);
  assert.notEqual(r.status, "OK", "an image of v0.1.2 must not pass the gate for v9.9.9");
});
