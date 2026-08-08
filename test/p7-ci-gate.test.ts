// P7 verdict 2, blocking — the quickstart CI gate was masked by shell
// semantics, not by the script. `ci/quickstart-docker.sh` exits 1 correctly
// when the elapsed time reaches the budget, but the workflow ran it as
// `… | tee …` under GitHub's IMPLICIT step shell, `bash -e {0}`: errexit
// without pipefail. A
// pipeline's status is its last command's, so the step took `tee`'s 0 and the
// job went green while the timing assertion failed.
//
// Asserting that the script returns 1 therefore proves nothing about the gate.
// What has to hold is the CI-LEVEL contract: run the step's OWN command line,
// under the shell the COMMITTED workflow resolves to, with a quickstart that
// fails — and get a non-zero status. Both halves are read out of ci.yml rather
// than written down here, so removing the workflow's `defaults.run.shell` flips
// these tests to red instead of leaving them passing against a masked gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetRoot } from "../src/assets.ts";

const CI_PATH = join(assetRoot(), ".github", "workflows", "ci.yml");
const GATE_JOB = "quickstart-e2e";

function ciLines(): string[] {
  return readFileSync(CI_PATH, "utf8").split("\n");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** `shell:` of the nearest `defaults: → run:` block opening at `indent`, if any. */
function defaultsShell(lines: string[], from: number, to: number, indent: number): string | undefined {
  for (let i = from; i < to; i++) {
    if (lines[i] !== `${" ".repeat(indent)}defaults:`) continue;
    for (let j = i + 1; j < to; j++) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) <= indent) break; // left the block
      const m = /^\s*shell:\s*(\S+)\s*$/.exec(lines[j]);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** `[from, to)` of a job's body, keyed by its name at indent 2. */
function jobBounds(lines: string[], job: string): [number, number] {
  const from = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(from >= 0, `job ${job} is in ${CI_PATH}`);
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    if (/^  \S.*:\s*$/.test(lines[i])) {
      to = i;
      break;
    }
  }
  return [from, to];
}

type Step = { name: string; run: string; shell?: string };

/** Every step of a job that carries a `run:`, with its own `shell:` if it sets one. */
function steps(lines: string[], from: number, to: number): Step[] {
  const out: Step[] = [];
  const marks: number[] = [];
  let listIndent = -1;
  for (let i = from; i < to; i++) {
    const l = lines[i];
    if (!/^\s*- /.test(l)) continue;
    const ind = indentOf(l);
    if (listIndent === -1) listIndent = ind;
    if (ind === listIndent) marks.push(i);
  }
  for (let k = 0; k < marks.length; k++) {
    const s = marks[k];
    const e = k + 1 < marks.length ? marks[k + 1] : to;
    let name = "";
    let run: string | undefined;
    let shell: string | undefined;
    for (let i = s; i < e; i++) {
      const nm = /^\s*(?:- )?name:\s*(.+?)\s*$/.exec(lines[i]);
      if (nm) name ||= nm[1];
      const sh = /^\s*(?:- )?shell:\s*(\S+)\s*$/.exec(lines[i]);
      if (sh) shell = sh[1];
      const rn = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
      if (!rn) continue;
      if (rn[2] === "|" || rn[2] === "|-") {
        const body: string[] = [];
        const base = indentOf(lines[i]) + 2;
        for (let j = i + 1; j < e; j++) {
          if (lines[j].trim() === "") {
            body.push("");
            continue;
          }
          if (indentOf(lines[j]) < base) break;
          body.push(lines[j].slice(base));
        }
        run = body.join("\n");
      } else {
        run = rn[2];
      }
    }
    if (run !== undefined) out.push({ name: name || `step ${k}`, run, shell });
  }
  return out;
}

/**
 * The argv GitHub Actions uses for a step, per its documented shell defaults:
 * an explicit `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`, and
 * the implicit non-Windows default is `bash -e {0}` — errexit, NO pipefail.
 */
function shellArgv(shell: string | undefined): string[] {
  if (shell === undefined) return ["bash", "-e"];
  if (shell === "bash") return ["bash", "--noprofile", "--norc", "-eo", "pipefail"];
  throw new Error(`this test knows "bash" and the implicit default, not ${JSON.stringify(shell)}`);
}

/** The shell a step of `job` resolves to: step > job defaults > workflow defaults. */
function effectiveShell(lines: string[], job: string, step: Step): string | undefined {
  const [from, to] = jobBounds(lines, job);
  return step.shell ?? defaultsShell(lines, from, to, 4) ?? defaultsShell(lines, 0, lines.length, 0);
}

/**
 * A checkout-shaped sandbox: `ci/` plus stubs for the two commands the gate's
 * pipelines start with. `STUB_FAIL=1` makes both fail the way a breached budget
 * or a missing image does.
 */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "sklo-ci-gate-"));
  mkdirSync(join(dir, "ci"));
  mkdirSync(join(dir, "stub-bin"));

  const quickstart = join(dir, "ci", "quickstart-docker.sh");
  writeFileSync(
    quickstart,
    `#!/usr/bin/env bash
if [ "\${STUB_FAIL:-0}" = "1" ]; then
  echo "=== elapsed 601s from container start (budget 600s, release target 600s)"
  echo "FAIL: quickstart took 601s >= 600s" >&2
  exit 1
fi
echo "QUICKSTART-E2E OK in 3s"
`,
  );
  chmodSync(quickstart, 0o755);

  const docker = join(dir, "stub-bin", "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
if [ "\${STUB_FAIL:-0}" = "1" ]; then
  echo "Error: No such image: skillonomia:ci" >&2
  exit 1
fi
echo "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`,
  );
  chmodSync(docker, 0o755);
  return dir;
}

/** Run a step's own `run:` body under its own resolved shell, GitHub-style. */
function runStep(step: Step, shell: string | undefined, dir: string, fail: boolean) {
  const script = join(dir, "step.sh");
  writeFileSync(script, step.run.endsWith("\n") ? step.run : `${step.run}\n`);
  const argv = shellArgv(shell);
  return spawnSync(argv[0], [...argv.slice(1), script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "stub-bin")}:${process.env.PATH ?? ""}`,
      STUB_FAIL: fail ? "1" : "0",
    },
  });
}

/** The gate's piped steps — the ones whose status a bare `bash -e` would drop. */
function pipedSteps(): { lines: string[]; piped: Step[] } {
  const lines = ciLines();
  const [from, to] = jobBounds(lines, GATE_JOB);
  const piped = steps(lines, from, to).filter((s) => s.run.includes("| tee"));
  assert.equal(piped.length, 2, "the gate job still has exactly the two `| tee` pipelines this covers");
  return { lines, piped };
}

test("the quickstart CI gate: a failing quickstart makes the CI step exit non-zero — under the shell ci.yml actually resolves to", () => {
  const { lines, piped } = pipedSteps();
  for (const step of piped) {
    const shell = effectiveShell(lines, GATE_JOB, step);
    const dir = sandbox();
    const res = runStep(step, shell, dir, true);
    assert.notEqual(
      res.status,
      0,
      `step ${JSON.stringify(step.name)} resolved to shell ${JSON.stringify(shell ?? "(implicit bash -e)")} ` +
        `and returned 0 while its pipeline head failed — the gate cannot fail the job. stdout: ${res.stdout}`,
    );
  }
});

test("the quickstart CI gate: the same steps still succeed on a healthy quickstart, and still write their transcript", () => {
  const { lines, piped } = pipedSteps();
  for (const step of piped) {
    const shell = effectiveShell(lines, GATE_JOB, step);
    const dir = sandbox();
    const res = runStep(step, shell, dir, false);
    assert.equal(res.status, 0, `step ${JSON.stringify(step.name)} must pass when nothing fails: ${res.stderr}`);

    const target = /\|\s*tee\s+(\S+)/.exec(step.run)?.[1];
    assert.ok(target, "the pipeline names its tee target");
    const archived = readFileSync(join(dir, target), "utf8");
    assert.ok(archived.trim().length > 0, `${target} is written, so the gate's transcript artifact survives the fix`);
  }
});

test("the pipefail default is declared once at workflow level, not duplicated per step", () => {
  const lines = ciLines();
  assert.equal(defaultsShell(lines, 0, lines.length, 0), "bash", "ci.yml declares a workflow-level `defaults.run.shell`");

  const [from, to] = jobBounds(lines, GATE_JOB);
  for (const step of steps(lines, from, to)) {
    assert.equal(step.shell, undefined, `step ${JSON.stringify(step.name)} needs no shell override of its own`);
  }
});
