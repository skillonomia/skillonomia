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
//   * and a documented digest can outlive the version it was resolved from.
//
// The last one is the live question at this commit. THE IMAGE IS PUBLISHED: the
// registry holds a tag per version, so the B1 rule — documents must say no digest
// exists — inverted, and a document still saying it would be the false statement.
// What replaces it is the DATING CLAUSE below: a concrete digest is a claim about
// one moment and one version, so the document that prints one names the tag it
// resolved from and the command that resolves another. A bare 64-hex string with
// neither is the "always this digest" promise this project does not make.
//
// AND THE IMAGE IS A LINUX ARTIFACT. The owner deferred Docker Desktop on macOS
// and every Windows lane, so `qualify-docker-linux` is the one container
// qualification this project claims; `qualify-docker-macos` and
// `qualify-docker-windows` stay in the workflow, unrun and named as deferred.
// Nothing checked below may read as a container result on either.
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

test("what is pushed is taken by DIGEST — qualified on Linux, deferred on the other two", () => {
  // The three jobs are wired identically and take one digest; only the Linux one
  // is a CLAIM. macOS and Windows are deferred by the owner (Docker Desktop is
  // not being installed), and the wiring below is checked so that the deferred
  // pair stays exactly as written rather than being quietly made to pass.
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

  // …and both are named as DEFERRED BY OWNER where they are declared, so a
  // reader of the workflow meets the decision and not a job that looks pending.
  for (const job of ["qualify-docker-macos", "qualify-docker-windows"]) {
    const at = platform.indexOf(`  ${job}:`);
    assert.notEqual(at, -1, `platform.yml still declares ${job}`);
    const block = platform.slice(at, at + 900);
    assert.match(block, /DEFERRED BY OWNER/, `${job} is declared as deferred, not as a pending qualification`);
  }
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

test("the documents give the loopback-only command, pinned by digest and dated where the digest is concrete", () => {
  const image = publishedImage();
  const quoted = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const doc of ["README.md", "docs/OPERATIONS.md"]) {
    const text = read(doc);
    assert.ok(text.includes(image), `${doc} names the image the workflow publishes`);
    const pinned = [...text.matchAll(new RegExp(`${quoted}@sha256:(<digest>|[0-9a-f]{64})(?![0-9a-f])`, "g"))].map(
      (m) => m[1],
    );
    assert.ok(
      pinned.length > 0,
      `${doc} pins the image by digest — a tag is a pointer that moves after it was smoked`,
    );
    assert.match(
      text,
      /docker run[^\n]*-p 127\.0\.0\.1:7431:7431/,
      `${doc}'s container command publishes on the loopback and nowhere else`,
    );
    // A TAG IN A RUNNABLE PULL is what stays refused. `imagetools inspect` on a
    // tag is the resolution step and is not a pull, so it is allowed to name one.
    const tagged = [...text.matchAll(new RegExp(`docker\\s+(?:run|pull)[^\\n]*${quoted}:\\S`, "g"))].map((m) => m[0]);
    assert.deepEqual(tagged, [], `${doc} runs or pulls the image by tag: ${tagged[0]}`);

    // THE DATING CLAUSE, which replaces B1's honesty clause. The image IS
    // published now — a document repeating "no digest exists" would be the false
    // statement — but a 64-hex digest written into prose is a claim about ONE
    // MOMENT and one version. Whichever document writes one has to say which tag
    // it resolved from and how a reader resolves another, or the digest reads as
    // the image's permanent identity: a promise nobody here can keep, because
    // the next version's digest is a different string.
    const concrete = pinned.filter((p) => p !== "<digest>");
    if (concrete.length > 0) {
      assert.match(
        text,
        /resolved to when this line was written/,
        `${doc} writes a concrete digest (${concrete[0].slice(0, 12)}…) without dating it to the tag it came from`,
      );
      assert.match(
        text,
        /imagetools inspect/,
        `${doc} writes a concrete digest without saying how a reader resolves another version's`,
      );
    }
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
