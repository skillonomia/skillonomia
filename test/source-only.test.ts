// WHAT MAY LEAVE THIS REPOSITORY IS A PROPERTY OF THE MACHINERY, NOT OF PROSE.
//
// THE BOUNDARY THIS FILE GUARDS HAS MOVED, and the move is the whole reason the
// file still exists. It was written for a SOURCE-ONLY release: `README.md` said
// no release ships a build of the Linux binary while `.github/workflows/ci.yml`
// compiled that binary in `binary-smoke` and uploaded it with
// `actions/upload-artifact` on every push. A workflow artifact is downloadable
// by anyone who can see the repository, so the document and the automation said
// opposite things, and the automation was the one that acted. A release review
// found it one step before the push that would have made it permanent — the
// sixth defect of one family (a shipped file asserting what the tree does not
// do) and the first found in a workflow rather than in prose.
//
// A2 makes this project SHIP that binary: `skillonomia-linux-x86_64.tar.gz` and
// `SHA256SUMS`, from `.github/workflows/release.yml`, on a new version tag. The
// old sentences in `README.md` and `docs/OPERATIONS.md` change in the same
// commit as this file, because a document that denies what the tree now does is
// the defect that cost this project a rebuild cycle.
//
// DELETING THE GUARD WOULD HAVE BEEN THE WRONG MOVE. "Nothing is published" and
// "anything may be published" are both unguarded states; what a release needs is
// a LINE, and the line is now drawn between three acts that used to be one:
//
//   BUILD    — `ci.yml` compiles the binary and runs it. It uploads neither the
//              binary nor the archive: a smoke job proves a build starts, and
//              nothing more should be inferrable from it.
//   STAGE    — `candidate.yml` packages the release asset and uploads it as a
//              workflow artifact, so a reviewer reads the exact bytes a release
//              would carry. It publishes nothing.
//   PUBLISH  — `release.yml`, and only it, and only on a new version tag, with
//              `v0.1.0` refused by name: that release was published as source
//              only, and a published release that later grows an asset changes
//              what its own checksum meant for everyone who already read it.
//
// B1 AND B2 MOVE IT AGAIN, IN THE SAME DIRECTION. Two more artifacts are
// published — the GHCR image and `@skillonomia/cli` — so `npm publish` and a
// registry push stop being forbidden verbs and become verbs with ONE address.
// The rule that replaces "these words appear nowhere" is stronger than it: every
// job that publishes anything must sit behind the `release` environment, which
// holds it until the owner approves the deployment. A file-level check would
// have been satisfied by one guarded job among three.
//
// The NAMES ARE DERIVED rather than written here — the outfile from
// `package.json`, the two asset names from `ci/mvp-release.mjs` — so renaming
// either cannot quietly move it out of this guard's sight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

/** The outfile `build:binary` compiles to, taken from the script that makes it. */
function binaryOutfile(): string {
  const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
  const script = scripts["build:binary"];
  assert.ok(script, "package.json no longer defines `build:binary` — this guard is reading the wrong thing");
  const out = /--outfile\s+(\S+)/.exec(script)?.[1];
  assert.ok(out, "`build:binary` no longer names an `--outfile` — this guard is reading the wrong thing");
  return out;
}

/** The release asset and its checksum file, from the script that makes them. */
function releaseAssets(): { archive: string; sums: string } {
  const script = readFileSync(join(ROOT, "ci", "mvp-release.mjs"), "utf8");
  const named = (constant: string): string => {
    const value = new RegExp(`export const ${constant} = "([^"]+)"`).exec(script)?.[1];
    assert.ok(value, `ci/mvp-release.mjs no longer names ${constant} — this guard is reading the wrong thing`);
    return value;
  };
  return { archive: named("ARCHIVE"), sums: named("SUMS") };
}

/** Every workflow file, so a new one cannot arrive outside this sweep. */
function workflows(): Array<[string, string]> {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => [f, readFileSync(join(WORKFLOWS, f), "utf8")] as [string, string]);
}

/**
 * Workflow files that upload the compiled binary — scanned STEP BY STEP, not by
 * whole-file substring. `ci.yml` legitimately names `dist/skillonomia` in the
 * reproducibility check and legitimately uses `upload-artifact` for the schema
 * dump; a file-level test conflates the two and fails on a clean tree. It did,
 * the first time this was written.
 */
function workflowsUploading(outfile: string): string[] {
  const guilty: string[] = [];
  for (const [name, text] of workflows()) {
    const lines = text.split("\n");
    // An `upload-artifact` step owns the lines until the next step (`- ` at its
    // own indent) — enough to read its `path:` block without a YAML parser,
    // and a parser is not worth a dependency for one question.
    for (let i = 0; i < lines.length; i += 1) {
      if (!/uses:\s*actions\/upload-artifact@/.test(lines[i])) continue;
      const stepIndent = lines[i].search(/\S/);
      let j = i + 1;
      const body: string[] = [];
      for (; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === "") continue;
        const indent = l.search(/\S/);
        if (indent <= stepIndent && /^\s*-\s/.test(l)) break;
        if (indent < stepIndent) break;
        body.push(l);
      }
      if (body.join("\n").includes(outfile)) guilty.push(name);
    }
  }
  return guilty;
}

test("no workflow uploads the bare compiled binary as an artifact", () => {
  // The RAW outfile, as against the packaged archive. What a release carries is
  // checksummed, versioned and unpackable next to its migrations; `dist/skillonomia`
  // on its own is none of those, and a downloadable copy of it is a release
  // nobody can verify.
  const outfile = binaryOutfile();
  const files = workflows();
  assert.ok(files.length > 0, "no workflow files found — this guard is reading the wrong directory");
  console.log(`[release-boundary] binary outfile from package.json: ${outfile}; workflows swept: ${files.map(([f]) => f).join(", ")}`);
  assert.deepEqual(
    workflowsUploading(outfile),
    [],
    `an \`upload-artifact\` step ships the bare \`${outfile}\`. A workflow artifact is downloadable by anyone ` +
      `who can see this repository. Compile it and run it — that is what the smoke job is for — and let the ` +
      `packaged, checksummed archive be the thing that leaves.`,
  );
});

test("only the candidate workflow stages the release archive", () => {
  const { archive } = releaseAssets();
  assert.deepEqual(
    workflowsUploading(archive),
    ["candidate.yml"],
    `\`${archive}\` is staged as a workflow artifact by the wrong file. Staging is the candidate stage's job — ` +
      "one artifact, on one commit, for a reviewer to read — and publishing it is release.yml's.",
  );
});

/** Workflow files that publish anything anywhere, by the verb they publish with. */
function workflowsPublishing(): Array<[string, string]> {
  const VERBS: ReadonlyArray<[RegExp, string]> = [
    [/^\s*(?:-\s*)?(?:run:\s*)?.*\bgh\s+release\s+(?:create|upload|edit|delete)\b/m, "`gh release`"],
    [/uses:\s*softprops\/action-gh-release|uses:\s*actions\/create-release/, "a release action"],
    [/^\s*(?:-\s*)?(?:run:\s*)?.*\bnpm\s+publish\b/m, "`npm publish`"],
    [/^\s*(?:-\s*)?(?:run:\s*)?.*\bdocker\s+push\b/m, "`docker push`"],
    [/uses:\s*docker\/build-push-action/, "docker/build-push-action"],
  ];
  const found: Array<[string, string]> = [];
  for (const [name, text] of workflows()) {
    // comments removed: a workflow that EXPLAINS why it does not publish is not
    // publishing, and the last guard of this family was satisfied by prose.
    const steps = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    for (const [re, what] of VERBS) if (re.test(steps)) found.push([name, what]);
  }
  return found;
}

test("one workflow publishes, it publishes only the approved artifacts, and only on a version tag", () => {
  const publishing = workflowsPublishing();
  const { archive, sums } = releaseAssets();
  console.log(`[release-boundary] publishing steps: ${publishing.map(([f, w]) => `${f} ${w}`).join(", ") || "none"}`);

  const elsewhere = publishing.filter(([name]) => name !== "release.yml");
  assert.deepEqual(
    elsewhere.map(([name, what]) => `${name} runs ${what}`),
    [],
    "a workflow other than release.yml publishes. Publication follows a version tag, which is an act the owner " +
      "performs; CI must not be able to reach the outside world on a push.",
  );

  // THE SET OF PUBLISHED THINGS HAS GROWN, AND IT IS STILL A SET. B1 adds a
  // container image and B2 adds `@skillonomia/cli`, so `npm publish` and a
  // registry push are no longer forbidden outright — they are forbidden
  // ANYWHERE BUT HERE, and each one must be inside the protected environment
  // that holds the job until the owner approves it. A publish verb that
  // appeared in release.yml OUTSIDE that environment would be a release the
  // owner never saw.
  const release = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  const verbs = publishing.map(([, what]) => what);
  assert.ok(verbs.includes("`gh release`"), "release.yml no longer publishes anything — this guard is reading the wrong file");
  for (const asset of [archive, sums]) {
    assert.match(release, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `release.yml publishes ${asset}`);
  }

  // Every publishing JOB is gated on the `release` environment. The check is per
  // job rather than per file: one unguarded job in a file whose other jobs are
  // guarded publishes just as thoroughly.
  const jobs = [...release.matchAll(/^  ([a-z0-9-]+):\n((?:    .*\n|\n)*)/gm)].map(([, name, body]) => [name, body] as const);
  assert.ok(jobs.length >= 3, `release.yml declares ${jobs.length} jobs; B1 and B2 add two to the binary's one`);
  const PUBLISHES = /gh release create|npm publish|--push\b/;
  for (const [name, body] of jobs) {
    const steps = body.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    if (!PUBLISHES.test(steps)) continue;
    assert.match(steps, /environment: release/, `the publishing job \`${name}\` is not behind the release environment`);
  }
  const published = ["gh release create", "npm publish", "--push"].filter((verb) => release.includes(verb));
  assert.deepEqual(
    published,
    ["gh release create", "npm publish", "--push"],
    "the three published artifacts are the release assets, the npm package and the container image",
  );

  // The trigger, read out of the file: tags, and no second way in. A
  // `workflow_dispatch` or a branch push here would be a publish button.
  const on = /^on:\n((?:[ \t].*\n|\n)*)/m.exec(release)?.[1];
  assert.ok(on, "release.yml has no `on:` block — this guard is reading the wrong file");
  assert.match(on, /^\s+push:\n\s+tags:\n/m, "release.yml triggers on a tag push");
  for (const trigger of ["workflow_dispatch", "pull_request", "schedule", "branches"]) {
    assert.doesNotMatch(on, new RegExp(`\\b${trigger}\\b`), `release.yml can be triggered by ${trigger}`);
  }
});

test("the baseline release cannot gain an asset, and a tag cannot disagree with the version", () => {
  const release = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  // `v0.1.0` was published as source and a git bundle. People have downloaded
  // and checksummed that release; an asset added to it afterwards would change
  // what the tag means without changing the tag.
  assert.match(
    release,
    /if \[ "\$TAG" = "v0\.1\.0" \]; then\n\s+echo "::error::/,
    "release.yml no longer refuses `v0.1.0` by name. The source-only baseline is not amended; a new artifact is a " +
      "new version.",
  );
  assert.match(
    release,
    /require\('\.\/package\.json'\)\.version/,
    "release.yml no longer checks the tag against package.json, so a release could carry a version its own " +
      "manifest disagrees with",
  );
  assert.match(
    release,
    /gh release view "\$TAG"/,
    "release.yml no longer refuses a tag whose release already exists, so a publish could amend one",
  );
  console.log(`[release-boundary] package.json is at ${version}; v0.1.0 is refused by name`);
});

// ---------------------------------------------------------------------------
// A GATE THAT NEVER PASSES IS THE MIRROR OF A GATE THAT PASSES EVERYTHING, and
// this repository shipped the first kind.
//
// The test above reads the three refusals out of `release.yml` and checks that
// each one is still written there. It never asked whether ANY tag survives
// them. It could not have: it compares text to text. So when A2 introduced the
// tag rules while `package.json` was still at `0.1.0`, the refusals were all
// present, the guard was green, and the set of publishable tags was EMPTY —
// `v0.1.0` refused by name as the baseline, and everything else refused for
// disagreeing with `package.json`. The candidate could not be released by any
// tag at all, and nothing in the suite said so, because every assertion in the
// file was of the form "this refusal is still here".
//
// A refusal-only guard cannot see that. The missing assertion is the POSITIVE
// one: that the tag the owner would actually push — `v` plus the version
// `package.json` names — is ACCEPTED. That is the assertion below, and it is
// the reason this test runs the gate instead of reading it.
//
// So the gate is EXECUTED, not mirrored: the `run:` block is lifted out of
// `release.yml` and handed to `bash` with `GITHUB_REF_NAME` set, in this
// checkout, against this `package.json`. A re-implementation of the rules here
// would agree with itself and prove nothing about the file CI runs. The only
// substitution is `gh release view`, the one refusal that needs the network; a
// stub answers it locally, and the last case below pushes the stub the other
// way so that "accepted" cannot mean "the gate stopped running".
//
// The version is READ, never written: this test says nothing about which
// version ships, only that whatever `package.json` says can be tagged.

/** Every `run: |` block in a workflow file, dedented, in file order. */
function runBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const opener = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!opener) continue;
    const indent = opener[1].length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (lines[j].trim() === "") {
        body.push("");
        continue;
      }
      if (lines[j].search(/\S/) <= indent) break;
      body.push(lines[j]);
    }
    const filled = body.filter((l) => l !== "");
    const pad = Math.min(...filled.map((l) => l.search(/\S/)));
    blocks.push(body.map((l) => l.slice(pad)).join("\n"));
    i = j - 1;
  }
  return blocks;
}

/**
 * The one step in `release.yml` that decides whether a tag may publish, found
 * by what it does rather than by its name, so renaming the step cannot move it
 * out of sight.
 */
function tagGate(): string {
  const release = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  const gates = runBlocks(release).filter((b) => b.includes("GITHUB_REF_NAME") && b.includes("package.json"));
  assert.equal(
    gates.length,
    1,
    `release.yml has ${gates.length} steps that read the tag against package.json — this guard needs exactly the one`,
  );
  assert.doesNotMatch(
    gates[0],
    /\$\{\{/,
    "the tag gate interpolates a GitHub expression into its script, so running it here would not be running what " +
      "CI runs — the substitution would have to be guessed, and a guessed gate proves nothing",
  );
  return gates[0];
}

/** The gate, run as CI runs it: `bash`, `GITHUB_REF_NAME`, this checkout. */
function runGate(tag: string, releaseAlreadyExists: boolean): { status: number; output: string } {
  const bin = mkdtempSync(join(tmpdir(), "sklo-tag-gate-"));
  // The only stub. `gh release view` asks the network whether the release is
  // already there; exit 0 says it is, exit 1 says it is not.
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexit ${releaseAlreadyExists ? 0 : 1}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  try {
    const run = spawnSync("bash", ["-c", tagGate()], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_NAME: tag, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    });
    return { status: run.status ?? -1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("the tag gate refuses the baseline and any mismatch, AND accepts the version package.json names", () => {
  const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const candidate = `v${version}`;
  // The refused-by-name tag comes out of the workflow, so this test keeps
  // working if the baseline is ever a different tag, and cannot silently stop
  // testing the refusal that exists.
  const baseline = /if \[ "\$TAG" = "(v[^"]+)" \]/.exec(tagGate())?.[1];
  assert.ok(baseline, "release.yml no longer refuses a tag by name — the baseline refusal is what this reads");

  // THE DEADLOCK, stated as an arithmetic fact before anything is run: if the
  // version in package.json IS the baseline, the two rules contradict and no
  // tag exists that satisfies both.
  assert.notEqual(
    candidate,
    baseline,
    `package.json is at ${version}, which is exactly the tag release.yml refuses by name (${baseline}). No tag can ` +
      "satisfy both rules, so this candidate cannot be published at all. Bump the version.",
  );

  const refusedBaseline = runGate(baseline, false);
  assert.notEqual(refusedBaseline.status, 0, `the gate accepted ${baseline}, which is refused by name`);
  assert.match(refusedBaseline.output, /baseline/, "the refusal of the baseline tag says why");
  // BY NAME, and by nothing else. Once the version moved off the baseline, the
  // version check refuses that tag too — so a baseline branch that printed its
  // error and then fell through would still look refused here, and the
  // refusal-by-name would be gone without a single test turning red. It is the
  // reason that has to hold: the gate stops at the name.
  assert.doesNotMatch(
    refusedBaseline.output,
    /does not match package\.json/,
    `${baseline} was refused for disagreeing with package.json, not for being the baseline. The baseline refusal ` +
      "no longer stops the run — and it would disappear entirely the day the version happened to match.",
  );

  // A tag that is neither the baseline nor the version: one major above.
  const mismatch = `v${Number(version.split(".")[0]) + 1}.0.0`;
  assert.notEqual(mismatch, candidate);
  assert.notEqual(mismatch, baseline);
  const refusedMismatch = runGate(mismatch, false);
  assert.notEqual(refusedMismatch.status, 0, `the gate accepted ${mismatch}, which package.json does not name`);
  assert.match(refusedMismatch.output, /does not match package\.json/, "the refusal of a mismatched tag says why");

  // THE ONE THAT WAS MISSING. Everything above can be true of a gate that
  // refuses everything.
  const accepted = runGate(candidate, false);
  assert.equal(
    accepted.status,
    0,
    `the gate refused ${candidate}, the tag package.json itself names, so no tag can publish this candidate: ` +
      `${accepted.output.trim()}`,
  );

  // …and "accepted" means the gate ran and let it through, not that the gate
  // stopped deciding: the same tag is refused when the release already exists.
  const refusedExisting = runGate(candidate, true);
  assert.notEqual(refusedExisting.status, 0, `the gate accepted ${candidate} over an existing release, which it amends`);
  assert.match(refusedExisting.output, /already exists/, "the refusal of an existing release says why");

  console.log(
    `[release-boundary] tag gate: ${baseline} refused (baseline), ${mismatch} refused (mismatch), ` +
      `${candidate} ACCEPTED, ${candidate} refused when the release already exists`,
  );
});

test("the documents describe the release the workflow actually publishes", () => {
  // The pair that was wrong before, asserted from the other side. README used to
  // say "no release of this project ships one" while nothing shipped it; now
  // release.yml ships it, so that sentence must be gone AND the two asset names
  // a reader is told to download must be the two the release carries.
  const { archive, sums } = releaseAssets();
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const operations = readFileSync(join(ROOT, "docs", "OPERATIONS.md"), "utf8");
  for (const [name, text] of [["README.md", readme], ["docs/OPERATIONS.md", operations]] as const) {
    assert.doesNotMatch(
      text,
      /no release of this project ships one|publishes source only/,
      `${name} still says this project ships no build of the binary, and release.yml publishes one. One of the ` +
        "two is lying — and the last time this pair disagreed, the automation was the one that acted.",
    );
    for (const asset of [archive, sums]) {
      assert.ok(
        text.includes(asset),
        `${name} tells a reader how to install the binary but never names \`${asset}\`, which is what the ` +
          "release carries",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TWO DOCUMENTS THAT NAME THE SAME SET MUST NAME THE SAME SET.
//
// `README.md` said "Every surface exists twice — REST … and MCP tools …", and
// `docs/API.md` said, in the same tree, that `GET /health`,
// `POST /v1/auth/bootstrap`, `GET /v1/receipts/{id}` and webhook management have
// no MCP tool at all. Both sentences shipped, in every published commit, for the
// whole life of this repository, and they cannot both be true.
//
// A release review found it one step before the push. It is the eighth defect of
// one family and the second where the contradiction was already inside the
// SHIPPED SET rather than between a document and the code — which is what makes
// it checkable: the exceptions are named in prose twice, so the two lists can be
// compared without a parser for either.
test("the REST-only surfaces README names are exactly the ones docs/API.md names", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const api = readFileSync(join(ROOT, "docs/API.md"), "utf8");

  // The surfaces, as each document spells them. `webhook management` is prose in
  // both, so it is matched as prose; the three routes are matched as routes.
  const SURFACES = [
    /`GET \/health`/,
    /`POST \/v1\/auth\/bootstrap`/,
    /`GET \/v1\/receipts\/\{id\}`/,
    /webhook management/,
  ];

  const inReadme = SURFACES.filter((re) => re.test(readme)).length;
  const inApi = SURFACES.filter((re) => re.test(api)).length;

  assert.equal(
    inApi,
    SURFACES.length,
    "docs/API.md no longer names all four REST-only surfaces — if the set changed, both documents change together",
  );
  assert.equal(
    inReadme,
    SURFACES.length,
    "README names fewer REST-only surfaces than docs/API.md does. The two documents describe one system; " +
      "for the whole life of this repository README claimed every surface exists twice while API.md listed " +
      "the exceptions, and both shipped.",
  );

  // …and README must not be claiming universality again.
  assert.doesNotMatch(
    readme,
    /^Every surface exists twice/m,
    "README claims every surface exists twice, which docs/API.md contradicts in the same tree",
  );
});
