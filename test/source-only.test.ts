// SOURCE-ONLY IS A PROPERTY OF WHAT THE REPOSITORY EMITS, NOT OF WHAT IT SAYS.
//
// `README.md` states that this project ships no build of the Linux binary. For
// as long as that sentence has existed, `.github/workflows/ci.yml` compiled the
// binary in `binary-smoke` and then uploaded it with `actions/upload-artifact`
// as `skillonomia-linux-x86_64`. A workflow artifact is downloadable by anyone
// who can see the repository, so the document and the automation said opposite
// things, and the automation was the one that acted. Nothing consumed the
// artifact; it existed only to be fetched.
//
// A release review found it one step before the push that would have made it
// permanent — the sixth defect of one family (a shipped file asserting what the
// tree does not do) and the first found in a workflow rather than in prose.
//
// So the claim is checked against the machinery, and the OUTPUT PATH IS DERIVED
// from `package.json` rather than written here: renaming the binary's outfile
// must not quietly move it out of this guard's sight.
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

test("no workflow uploads the compiled binary as an artifact", () => {
  const outfile = binaryOutfile();
  const files = workflows();
  assert.ok(files.length > 0, "no workflow files found — this guard is reading the wrong directory");
  console.log(`[source-only] binary outfile from package.json: ${outfile}; workflows swept: ${files.map(([f]) => f).join(", ")}`);
  assert.deepEqual(
    workflowsUploading(outfile),
    [],
    `an \`upload-artifact\` step ships \`${outfile}\`. A workflow artifact is downloadable by anyone who can ` +
      `see this repository, and README states that no release of this project ships a build of the binary. ` +
      `Compile it and run it — that is what the smoke job is for — but do not publish it.`,
  );
});

test("README does not claim a binary is unavailable while a workflow publishes one", () => {
  // The two halves of the contradiction, asserted TOGETHER: it is the pair that
  // was wrong, and either half alone reads as fine.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const claimsNoShippedBuild = /no release of this project ships one/.test(readme);
  const anyUpload = workflowsUploading(binaryOutfile()).length > 0;
  assert.ok(
    claimsNoShippedBuild,
    "README no longer states that no release ships a build of the binary — if that changed on purpose, this " +
      "guard and the sentence must change together",
  );
  assert.ok(
    !anyUpload,
    "README says no release ships a build of the binary, and a workflow uploads it. One of the two is lying.",
  );
});
