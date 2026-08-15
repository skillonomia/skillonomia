// THE CONTAINER IMAGE: what is documented, what is pushed, and what is smoked —
// held to ONE reference and ONE digest.
//
// B1 publishes a container image, and a published image is the artifact with the
// most ways to drift quietly:
//
//   * the DOCUMENTS can name an image the workflow does not push (this
//     repository has shipped that exact defect, in the other direction: README
//     denied a binary the workflow uploaded);
//   * a TAG can be documented where a digest is meant — `:latest` is a pointer
//     that moves after it was smoked, so what a reader pulls is not what CI ran;
//   * a PUBLISH can appear outside `release.yml`;
//   * and, until an image actually exists, the documents can promise a digest
//     nobody can pull.
//
// The last one is the live question at this commit: NOTHING HAS BEEN PUBLISHED.
// The workflow that would publish exists and is armed behind the owner's
// approval; the registry holds no image. So the documents must state the command
// AND state that it has no digest yet, and this file requires both — a document
// that printed a plausible 64-hex digest would be inventing an artifact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./docs-guard.ts";

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");
const workflow = (name: string): string => read(`.github/workflows/${name}`);

/** The image reference, read out of the workflow that pushes it. */
function publishedImage(): string {
  const refs = [...workflow("release.yml").matchAll(/^\s*IMAGE:\s*(\S+)$/gm)].map((m) => m[1]);
  assert.equal(refs.length, 1, `release.yml names ${refs.length} images; a second spelling would be a second image`);
  return refs[0];
}

test("the image has one name, and the candidate stage builds exactly it", () => {
  const image = publishedImage();
  assert.match(image, /^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+$/, "the reference is a GHCR repository with no tag on it");
  const candidate = [...workflow("candidate.yml").matchAll(/^\s*IMAGE:\s*(\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(candidate, [image], "candidate.yml builds the same reference release.yml pushes");
});

test("only release.yml pushes it, and the candidate stage cannot", () => {
  const candidate = workflow("candidate.yml")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(candidate, /--push\b/, "the candidate build must not push");
  assert.doesNotMatch(candidate, /docker\s+login/, "…and must not hold a registry credential at all");
  assert.match(candidate, /--output type=cacheonly|--load\b/, "it builds and keeps the result local");

  const release = workflow("release.yml");
  assert.match(release, /--push\b/, "release.yml is where the push is");
  assert.match(release, /docker login ghcr\.io/, "…with the credential named there and nowhere else");
  assert.match(release, /environment: release/, "…behind the protected environment the owner approves");
});

test("what is pushed is qualified by DIGEST, on three named runtimes", () => {
  const platform = workflow("platform.yml");
  const jobs = ["qualify-docker-linux", "qualify-docker-macos", "qualify-docker-windows"];
  const hosts = ["linux-x64", "darwin-arm64", "win32-x64"];
  for (const [i, job] of jobs.entries()) {
    assert.match(platform, new RegExp(`^  ${job}:$`, "m"), `platform.yml declares ${job}`);
    assert.ok(platform.includes(`--expect-host ${hosts[i]}`), `${job} declares the host it claims to be (${hosts[i]})`);
  }
  // ONE digest, given from outside, and the same one to all three: a job that
  // resolved its own tag would be qualifying whatever the tag pointed at when it
  // ran, and three jobs could then qualify three different images.
  const passes = [...platform.matchAll(/--digest "\$\{\{ inputs\.digest \}\}"/g)];
  assert.equal(passes.length, jobs.length, "each docker job takes the workflow's one digest input");
  const gated = [...platform.matchAll(/if: inputs\.digest != ''/g)];
  assert.equal(gated.length, jobs.length, "…and none of them runs when there is no digest to qualify");

  // The two that are not Linux ask for self-hosted Docker Desktop hosts. A
  // hosted runner is not one, and the workflow may not quietly say it is.
  assert.match(platform, /runs-on: \[self-hosted, macOS, ARM64, docker-desktop\]/);
  assert.match(platform, /runs-on: \[self-hosted, Windows, X64, docker-desktop\]/);
});

test("the smoke REFUSES a tag, and refuses to run on a host it is not", () => {
  // Executed, not read: this is the assertion that a `:latest` in a document or
  // a workflow could not become a qualification result.
  const image = publishedImage();
  const tagged = spawnSync(process.execPath, [join(REPO_ROOT, "ci/mvp-release.mjs"), "ghcr", "--digest", `${image}:0.1.2`], {
    encoding: "utf8",
  });
  assert.equal(tagged.status, 2, "a tag is a usage error, not a run");
  assert.match(tagged.stderr, /immutable reference/, "…and the refusal says why");

  // `--expect-host` is checked before anything is pulled, so a mislabelled
  // self-hosted runner fails instead of producing a foreign platform's result.
  const digest = `${image}@sha256:${"0".repeat(64)}`;
  const foreign = process.platform === "darwin" ? "linux-x64" : "darwin-arm64";
  const wrongHost = spawnSync(process.execPath, [join(REPO_ROOT, "ci/mvp-release.mjs"), "ghcr", "--digest", digest, "--expect-host", foreign], {
    encoding: "utf8",
  });
  assert.equal(wrongHost.status, 1, "a job that is not on the host it claims must fail");
  assert.match(wrongHost.stderr, /--expect-host/, "…naming the mismatch");
  assert.doesNotMatch(wrongHost.stdout, /docker pull/, "…before anything is pulled");
});

test("the documents give the loopback-only command, by digest, and say no digest exists yet", () => {
  const image = publishedImage();
  for (const doc of ["README.md", "docs/OPERATIONS.md"]) {
    const text = read(doc);
    assert.ok(text.includes(image), `${doc} names the image the workflow publishes`);
    assert.ok(
      text.includes(`${image}@sha256:<digest>`),
      `${doc} pins the image by digest — a tag is a pointer that moves after it was smoked`,
    );
    assert.match(
      text,
      /docker run[^\n]*-p 127\.0\.0\.1:7431:7431/,
      `${doc}'s container command publishes on the loopback and nowhere else`,
    );

    // THE HONESTY CLAUSE. No image is published at this commit, so a document
    // must not read as though one is: a reader following the command gets a
    // manifest-unknown error, and the document has to have said so first.
    assert.match(
      text,
      /no published digest|no digest has been published/i,
      `${doc} must say that no digest exists yet — the command is a shape, not a working pull`,
    );
    // …and it must not contain something that LOOKS like a real digest.
    const looksReal = [...text.matchAll(/@sha256:([0-9a-f]{64})/g)].map((m) => m[1]);
    assert.deepEqual(looksReal, [], `${doc} prints a concrete digest (${looksReal[0]}) for an image nobody published`);
  }
});

test("ci/quickstart-docker.sh stays the product quickstart and is not an acceptance script", () => {
  // §7 caps this project at four acceptance scripts before the pilots. The
  // quickstart is not one of them: it builds the image from this repository and
  // times the §9.1 scenario, and the published-image acceptance is a subcommand
  // of `ci/mvp-release.mjs`. Two scripts that both claimed to accept the image
  // would be two answers to one question.
  const quickstart = read("ci/quickstart-docker.sh");
  assert.doesNotMatch(quickstart, /GHCR_SMOKE_OK/, "the quickstart does not print the published-image marker");
  assert.doesNotMatch(quickstart, /docker pull/, "…and pulls nothing: it builds from this Dockerfile");
  assert.match(quickstart, /QUICKSTART-E2E OK/, "…and keeps its own marker");
  assert.match(read("ci/mvp-release.mjs"), /GHCR_SMOKE_OK/, "the published-image marker belongs to the release checks");
});
