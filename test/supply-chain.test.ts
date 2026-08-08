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
