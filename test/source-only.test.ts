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
// The NAMES ARE DERIVED rather than written here — the outfile from
// `package.json`, the two asset names from `ci/mvp-release.mjs` — so renaming
// either cannot quietly move it out of this guard's sight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

test("one workflow publishes, it publishes only the release assets, and only on a version tag", () => {
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

  // Publication is the release assets and NOTHING ELSE at this version: no npm
  // package and no container image are published under this project's name, and
  // several delivered documents say so.
  const verbs = publishing.map(([, what]) => what);
  for (const forbidden of ["`npm publish`", "`docker push`", "docker/build-push-action"]) {
    assert.ok(
      !verbs.includes(forbidden),
      `release.yml runs ${forbidden}, and this project publishes no npm package and no container image. ` +
        "Whichever of the two changed, the documents change with it.",
    );
  }

  const release = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  assert.ok(verbs.includes("`gh release`"), "release.yml no longer publishes anything — this guard is reading the wrong file");
  for (const asset of [archive, sums]) {
    assert.match(release, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `release.yml publishes ${asset}`);
  }

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
