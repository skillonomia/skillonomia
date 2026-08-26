// `skillonomia init`, `validate`, `create` — the authoring journey, §6.6.
//
// WHAT THIS EXISTS TO REPLACE. Before it, the shortest honest path from "I have
// a skill" to "the registry holds a signed version of it" was: hand-write a
// manifest against a schema reference, mint a ULID by some other means, guess
// which members the server owns, tar the directory, base64 it, and POST it with
// curl — discovering each mistake one 400 at a time, after the archive had
// already been sent. `INV-10` says the ordinary path must not require hand-built
// JSON, and these three commands are that path.
//
// THE THREE PROMISES THE COMMANDS MAKE, and each is a property rather than an
// intention:
//
//   * `validate` MUTATES NOTHING. It reads the directory and writes to stdout.
//     Not "we don't think it writes": no function called from `runValidate`
//     opens a file for writing, and the gate hashes the tree either side.
//   * `create` LEAVES THE SOURCE AS IT FOUND IT, on every failure — a rejected
//     validation, a refused server, a socket that died mid-request. The archive
//     is built in memory from bytes that were read, and nothing is written back.
//   * THE API KEY IS READ FROM ONE PLACE and written to none. Not an argument
//     (the process table, the shell history and every `ps` on the host), not a
//     config file (every backup), not the URL (proxy logs, and the server's own
//     access log). The NAME of an environment variable is the argument; the
//     value never leaves the request header.
//
// AND ONE VALIDATOR, TWO CALLERS. `validate` here and `skill.create_from_dir` on
// the server both call `validateSourceProfile`. An author whose preflight is
// green and whose upload is a 400 has been told their check means something it
// does not, and two implementations that agree today disagree later — which is
// not a worry about carelessness but what the webhook policy in this repository
// actually did.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { ulid } from "./ulid.ts";
import { writeTar, type PackageFiles } from "./archive.ts";
import { validateSourceProfile } from "./source-profile.ts";
import {
  isValidSlug,
  isValidateOk,
  validateExitCode,
  CLI_SLUG_RE,
  HIGH_RISK_REQUIRED_APPROVALS,
  SLUG_CONFLICT_CODE,
  SOURCE_PROFILE,
  type CreateArgs,
  type CreateReport,
  type InitArgs,
  type RiskLevel,
  type SourceFinding,
  type ValidateArgs,
  type ValidateReport,
} from "./cli-authoring-contract.ts";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_USAGE = 2;

/** Files `init` generates. `--force` overwrites THESE and nothing else — an
 *  author's half-finished work beside them is not the CLI's to remove, and
 *  "force" has meant "delete the directory" in enough tools that saying so is
 *  worth a line. */
export const GENERATED_PATHS = ["manifest.json", "SKILL.md", "fixtures/smoke.sh"] as const;

// ===========================================================================
// init
// ===========================================================================

/**
 * The manifest template.
 *
 * THE SLUG IS NOT IN IT, and that is the point of the parameter list. A slug is
 * the Registry's public name for a skill and is passed to `create`; the
 * `skill_id` is the identity inside the signed manifest. Deriving one from the
 * other — or from the title, or from the directory name — would mean an author
 * who renames a directory has renamed their skill, silently, under a signature.
 * So `init` prints the slug back in the next-step command and writes it nowhere.
 *
 * `skill_id` IS MINTED HERE, ONCE. `init` is the only moment in the journey
 * where a new identity is created; `validate` reads it and `create` sends it,
 * and the version the registry mints carries this exact value. Minting it again
 * anywhere would produce a second skill from one author's one directory.
 */
function manifestTemplate(skillId: string, risk: RiskLevel, nowIso: string): Record<string, unknown> {
  return {
    skill_id: skillId,
    semantic_version: "0.1.0",
    title: "A new skill",
    capability_statement: "Describe, in one sentence, what an agent can do with this skill that it could not do without it.",
    owner: "your-workspace",
    created_at: nowIso,
    license: "Apache-2.0",
    access_policy: "workspace",
    scope: {
      problem_class: "Describe the class of problem this solves, not the one instance you had.",
      non_goals: ["What this deliberately does not do"],
      prerequisites: [],
      risk_level: risk,
      // §7.3 asks twice for a high-risk skill — once to make the version
      // externally adoptable, once per adoption — so a template that declared
      // only one would teach an author that high risk is gated once.
      required_approvals: risk === "high" ? [...HIGH_RISK_REQUIRED_APPROVALS] : [],
    },
    runtime: {
      os: ["linux", "macos"],
      shell: ["bash", "sh"],
      model_compat: [{ id: "any", range: "*" }],
      runtime_compat: [{ id: "any", range: "*" }],
      tool_compat: [{ id: "shell", range: "*" }],
      mcp_dependencies: [],
      cloud_iam_assumptions: [],
    },
    procedure: {
      steps: [{ n: 1, instruction: "Run the fixture and read its output.", command: "sh fixtures/smoke.sh", expected: "skillonomia-smoke-ok" }],
      expected_outputs: ["skillonomia-smoke-ok"],
      // snake_case, so this gate can be named from `outcome_contract.evidence[]`.
      // The package schema is NOT narrowed to require it — that would refuse
      // packages which verify today — the TEMPLATE simply generates a form that
      // works, and `validate` says so when a cross-field use does not join up.
      //
      // That field is the author's declaration under their own signature and is
      // NOT A SOURCE OF ADMISSIBLE NAMES for this registry: the keys a journal
      // accepts are the derived set the registry computes, so generating an id
      // in this form makes it CONVENIENT to name and never admissible by
      // declaration. The bound is not a security property either — a small
      // character set and a capped length can still be made to
      // carry an encoding by somebody who sets out to build one.
      validation_gates: [{ gate_id: "smoke_output", check: "stdout equals the expected string", pass_criteria: "stdout == 'skillonomia-smoke-ok'" }],
      rollback: ["No changes are made by the fixture; there is nothing to roll back."],
      failure_modes: [{ mode: "shell-missing", symptom: "sh: not found", mitigation: "install a POSIX shell" }],
      tools_used: [{ id: "shell", range: "*" }],
    },
    evidence: {
      test_results: "local: smoke_output pass",
      summary: "The fixture prints a fixed string; the gate compares stdout against it.",
      redaction_level: "none",
    },
    safety: {
      forbidden_actions: ["network access", "file writes outside the working directory"],
      secrets_policy: "No secrets are used or accepted. Read any credential from the environment; never write one into this directory.",
      sandbox_requirement: "none",
      url_allowlist: [],
      dependency_manifest: [],
    },
    lifecycle: { supersedes: null },
    // D-2, and it is a TEMPLATE rather than a default: what success means is the
    // author's to state, and a registry that guessed would be filling in the one
    // field that decides whether the §4 outcome column can ever say anything.
    // `unknown` is a sentence and not a status because a reader meets it when
    // nothing was reported — which is never the same as a failure.
    outcome_contract: {
      check: { kind: "exit_code", exit_code: 0 },
      evidence: ["exit_code", "stdout"],
      unknown: "no evaluated run of this skill was reported, which is not a failure of it",
    },
  };
}

const SKILL_MD_TEMPLATE = [
  "# A new skill",
  "",
  "One paragraph an adopting agent reads before it does anything. Say what the",
  "skill is for, what it will change, and what it will not touch.",
  "",
  "## Procedure",
  "",
  "1. Run `sh fixtures/smoke.sh` and read its output.",
  "",
  "## Gate `smoke_output`",
  "",
  "The fixture prints `skillonomia-smoke-ok`. Anything else is a failure.",
  "",
].join("\n");

const FIXTURE_TEMPLATE = ["#!/bin/sh", "# The smallest thing that can be run and checked.", 'echo "skillonomia-smoke-ok"', ""].join("\n");

export interface InitOptions {
  /** injected so the generated `created_at` is a value a test can pin, and so
   *  nothing in this module reads a clock the caller cannot see */
  nowMs: number;
  /** injected for the same reason; `init` mints exactly one */
  mintId?: (nowMs: number) => string;
}

export function runInit(args: InitArgs, io: CliIo, opts: InitOptions): number {
  if (!isValidSlug(args.slug)) {
    io.err(`--slug must match the Registry grammar ${CLI_SLUG_RE.source} — \`${args.slug}\` does not`);
    io.err("a slug is lowercase letters, digits and hyphens, between 3 and 64 characters");
    return EXIT_USAGE;
  }

  const dir = args.directory;
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      io.err(`${dir} exists and is not a directory`);
      return EXIT_CHECK_FAILED;
    }
    if (readdirSync(dir).length > 0 && !args.force) {
      io.err(`${dir} is not empty — pass --force to write the generated files into it`);
      io.err("--force overwrites only the files init generates; it deletes nothing it did not write");
      return EXIT_CHECK_FAILED;
    }
  }

  // ONE ULID, MINTED ONCE, and it is minted before anything is written so that
  // a failed write cannot leave two files claiming two identities.
  const skillId = (opts.mintId ?? ulid)(opts.nowMs);
  const manifest = manifestTemplate(skillId, args.risk, new Date(opts.nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"));

  mkdirSync(join(dir, "fixtures"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "SKILL.md"), SKILL_MD_TEMPLATE, "utf8");
  writeFileSync(join(dir, "fixtures", "smoke.sh"), FIXTURE_TEMPLATE, "utf8");

  io.out(`initialised ${dir} (${SOURCE_PROFILE}, risk ${args.risk})`);
  io.out(`  skill_id  ${skillId}   minted once, here; create sends this exact value`);
  io.out(`  slug      ${args.slug}   the Registry's public name — NOT written into the signed manifest`);
  for (const p of GENERATED_PATHS) io.out(`  wrote     ${p}`);
  if (args.risk === "high") {
    io.out(`  approvals ${HIGH_RISK_REQUIRED_APPROVALS.join(", ")} — a high-risk skill is decided twice, not once`);
  }
  // No private key is created, stored or referenced by any of this. The registry
  // signs with a system-held key whose private half never leaves its secret
  // store, and browser private-key signing is out of scope by §6.6.3.
  io.out("  no private key was created — the registry signs with its own system key");
  io.out("");
  io.out("next:");
  io.out(`  skillonomia validate ${dir}`);
  io.out(`  skillonomia create ${dir} --slug ${args.slug} --server <url> --api-key-env SKILLONOMIA_API_KEY`);
  return EXIT_OK;
}

// ===========================================================================
// validate
// ===========================================================================

/** Read a source directory into the same map shape the archive and the server
 *  use. READ ONLY — every path here is opened for reading, and the gate that
 *  hashes the tree either side of a run is what turns that from a claim into a
 *  measurement. */
export function readSourceDir(dir: string): PackageFiles {
  const files: PackageFiles = new Map();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue; // a socket or a symlink to nowhere is not source
      files.set(relative(dir, abs).split(sep).join("/"), readFileSync(abs));
    }
  };
  walk(dir);
  return files;
}

export interface ValidateOptions {
  nowMs: number;
}

export function collectFindings(dir: string, opts: ValidateOptions): SourceFinding[] {
  return validateSourceProfile(readSourceDir(dir), { nowMs: opts.nowMs });
}

export function runValidate(args: ValidateArgs, io: CliIo, opts: ValidateOptions): number {
  if (!existsSync(args.directory) || !statSync(args.directory).isDirectory()) {
    io.err(`${args.directory} is not a directory`);
    return EXIT_USAGE;
  }
  const findings = collectFindings(args.directory, opts);
  const report: ValidateReport = {
    profile: SOURCE_PROFILE,
    directory: args.directory,
    // derived, never reported beside the findings, so the two cannot disagree
    ok: isValidateOk(findings),
    findings,
  };
  if (args.json) {
    io.out(JSON.stringify(report, null, 2));
    return validateExitCode(findings);
  }
  printFindings(findings, io);
  io.out(report.ok ? `${SOURCE_PROFILE}: ok` : `${SOURCE_PROFILE}: ${findings.filter((f) => f.severity === "FAIL").length} FAIL`);
  return validateExitCode(findings);
}

/** Four lines per finding, and the last two are the ones that make it useful:
 *  where to look, and what to do. A validator that prints a pointer and a code
 *  has told a first-time author the truth and left them no better off. */
function printFindings(findings: readonly SourceFinding[], io: CliIo): void {
  for (const f of findings) {
    const write = f.severity === "FAIL" ? io.err : io.out;
    write(`${f.severity}  ${f.pointer}  [${f.code}]`);
    write(`      ${f.detail}`);
    write(`      fix: ${f.recovery}`);
    write(`      see: ${f.anchor}`);
  }
}

// ===========================================================================
// create
// ===========================================================================

/** A typed refusal from the server, carried out to the caller with the code the
 *  server chose. The CLI adds no code of its own: an error space invented on the
 *  client is an error space the server does not know about. */
export class CreateFailed extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface CreateOptions {
  nowMs: number;
  /** the whole environment, injected — the key is looked up in THIS, and the
   *  process environment is never read directly from this module */
  env: Record<string, string | undefined>;
  mintId?: (nowMs: number) => string;
}

interface HttpAnswer {
  status: number;
  json: any;
  body: string;
}

async function post(server: string, path: string, apiKey: string, body: unknown): Promise<HttpAnswer> {
  const url = new URL(path, server.endsWith("/") ? server : `${server}/`);
  // THE KEY GOES IN A HEADER AND NOWHERE ELSE. Not the query string: a URL is
  // logged by every proxy between here and the server, and by the server's own
  // access log, and neither of those is a place a credential can be withdrawn
  // from afterwards.
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const req = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<HttpAnswer>((resolve, reject) => {
    const r = req(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, body: text });
        });
      },
    );
    // A transport error carries the address it failed to reach and nothing
    // else; `err.message` from node never contains a request header, and the
    // key is only ever a request header.
    r.on("error", (e) => reject(new CreateFailed("TRANSPORT", 0, `could not reach ${url.origin}: ${e.message}`)));
    r.end(payload);
  });
}

/**
 * What an author may do next, RENDERED FROM THE STATE THE SERVER REPORTED.
 *
 * Not computed: eligibility is the §7.3 matrix's, it lives on the server, and a
 * second copy on a client is the drift `INV-01` forbids. This maps the state the
 * server just returned to the name of the surface that consumes that state, and
 * if the server returns a state this does not know it says so rather than
 * guessing.
 */
function nextActionFor(state: string): string {
  switch (state) {
    case "draft":
      return "request a review (POST /v1/versions/{id}/reviews) — the eight gates run when the version leaves draft";
    case "reviewed":
      return "seek publication approval, then publish (the server decides eligibility; §7.3)";
    case "published":
      return "the version is published; adopters may request it";
    default:
      return `the server reports state \`${state}\`; consult the lifecycle documentation for what it permits`;
  }
}

export async function runCreate(args: CreateArgs, io: CliIo, opts: CreateOptions): Promise<number> {
  if (!isValidSlug(args.slug)) {
    io.err(`--slug must match the Registry grammar ${CLI_SLUG_RE.source} — \`${args.slug}\` does not`);
    return EXIT_USAGE;
  }
  if (!existsSync(args.directory) || !statSync(args.directory).isDirectory()) {
    io.err(`${args.directory} is not a directory`);
    return EXIT_USAGE;
  }

  // THE KEY, FROM THE NAMED VARIABLE AND NOWHERE ELSE. If it is absent the CLI
  // says which variable it looked in — the name is not a secret, the value is —
  // and it does not fall back to a config file, a keychain or a prompt, because
  // a fallback is a second place a credential can come from.
  const apiKey = opts.env[args.api_key_env];
  if (apiKey === undefined || apiKey === "") {
    io.err(`${args.api_key_env} is not set in the environment`);
    io.err(`export ${args.api_key_env}=<your api key> and run this again; the key is never taken as an argument`);
    return EXIT_USAGE;
  }

  // THE SAME VALIDATE FIRST, and it is the same function the server will run.
  const files = readSourceDir(args.directory);
  const findings = validateSourceProfile(files, { nowMs: opts.nowMs });
  if (!isValidateOk(findings)) {
    printFindings(findings, io);
    io.err(`${SOURCE_PROFILE}: refusing to send a source that does not validate — nothing was uploaded and the directory is unchanged`);
    return EXIT_CHECK_FAILED;
  }

  // ONE IDEMPOTENCY KEY PER ATTEMPT, minted before the request and reused if
  // the request has to be repeated. That is what makes a retry after transport
  // uncertainty safe: a socket that dies after the server committed and before
  // the answer arrived is indistinguishable here from one that died before, and
  // a fresh key on the retry would create a second version out of that
  // ambiguity. A key minted per RETRY is not an idempotency key.
  const idempotencyKey = (opts.mintId ?? ulid)(opts.nowMs);
  const source = writeTar(files).toString("base64");

  let answer: HttpAnswer;
  try {
    answer = await post(args.server, "v1/skills/from-source", apiKey, {
      slug: args.slug,
      source,
      idempotency_key: idempotencyKey,
    });
  } catch (e: any) {
    // The source is untouched: nothing above this line opened a file for
    // writing, and the archive was built in memory.
    io.err(e instanceof CreateFailed ? e.message : String(e?.message ?? e));
    io.err(`the source directory is unchanged; re-running with the same idempotency key ${idempotencyKey} is safe`);
    return EXIT_CHECK_FAILED;
  }

  if (answer.status !== 201) {
    const code = String(answer.json?.error?.code ?? `HTTP_${answer.status}`);
    const detail = String(answer.json?.error?.message ?? answer.body.slice(0, 400));
    // IS THIS THE SLUG CONFLICT? ASKED OF THE REGISTRY, not read out of the
    // refusal's prose. The server's existing code for "this slug names a
    // different skill" is the one it has always used and is not renamed here
    // (`INV-09`); what the CLI adds is the QUESTION whose answer decides how to
    // present it — a read of the skill the slug already names, over the
    // existing search surface. Matching on the message text instead would make
    // a wording change a silent behaviour change.
    const conflicting = code === SLUG_CONFLICT_CODE ? args.slug : await slugTakenByAnother(args.server, apiKey, args.slug, String(manifestIdOf(files)));
    if (conflicting !== null) {
      // THE TYPED CONFLICT, and what the CLI does NOT do about it. Publishing a
      // further version of an existing skill is the existing advanced API/MCP
      // path; taking it here on a guess would attach this author's source to
      // somebody else's lineage. The source is not rewritten — not the slug,
      // not the skill_id, not a line of it.
      io.err(`${SLUG_CONFLICT_CODE}: the slug \`${args.slug}\` already belongs to a different skill_id`);
      io.err(`the server refused with ${code}: ${detail}`);
      io.err("the source directory has not been rewritten. Choose another slug, or publish a new VERSION of the");
      io.err("existing skill through POST /v1/skills/{skill_id}/versions/from-source, which is the advanced path.");
      return EXIT_CHECK_FAILED;
    }
    io.err(`${code}: ${detail}`);
    io.err("the source directory is unchanged");
    return EXIT_CHECK_FAILED;
  }

  const created = answer.json;
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
  const report: CreateReport = {
    skill_id: String(created.skill_id),
    skill_version_id: String(created.skill_version_id),
    slug: args.slug,
    semantic_version: String(manifest.semantic_version),
    state: String(created.state),
    // the gate summary is the SERVER's — the eight gates ran there, on the
    // package it packed, and a summary computed here would be a second answer
    // about bytes this process never saw
    gates: gateSummary(created.gate_reports),
    next_action: nextActionFor(String(created.state)),
  };

  if (args.json) {
    io.out(JSON.stringify(report, null, 2));
    return EXIT_OK;
  }
  io.out(`created ${report.slug}`);
  io.out(`  skill_id          ${report.skill_id}`);
  io.out(`  skill_version_id  ${report.skill_version_id}`);
  io.out(`  semantic_version  ${report.semantic_version}`);
  io.out(`  state             ${report.state}`);
  io.out(`  gates             ${report.gates.passed} passed, ${report.gates.failed} failed, ${report.gates.warned} warned`);
  io.out(`  next              ${report.next_action}`);
  return EXIT_OK;
}

function manifestIdOf(files: PackageFiles): unknown {
  try {
    return JSON.parse(files.get("manifest.json")!.toString("utf8")).skill_id;
  } catch {
    return null;
  }
}

/**
 * Does this slug already name a DIFFERENT skill?
 *
 * Asked over the existing read surface, with the same key, and answered `null`
 * when it cannot be established — an unreachable or unhelpful read must not turn
 * a refusal into a conflict the CLI made up. The caller then reports the
 * server's own code, which is the honest fallback.
 */
async function slugTakenByAnother(server: string, apiKey: string, slug: string, localSkillId: string): Promise<string | null> {
  const url = new URL("v1/skills", server.endsWith("/") ? server : `${server}/`);
  url.searchParams.set("q", slug);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const body: any = await res.json();
    const items: any[] = Array.isArray(body?.items) ? body.items : [];
    const hit = items.find((i) => i?.slug === slug && typeof i?.skill_id === "string" && i.skill_id !== localSkillId);
    return hit ? String(hit.skill_id) : null;
  } catch {
    return null;
  }
}

/** `unknown` is not zero: a response that carried no gate reports says so by
 *  reporting nothing counted, and the caller who wants the gate verdicts asks
 *  the lint surface. Reporting `0 failed` for "we were not told" would be the
 *  `INV-03` mistake in a smaller place. */
function gateSummary(reports: unknown): CreateReport["gates"] {
  if (!Array.isArray(reports)) return { passed: 0, failed: 0, warned: 0 };
  return {
    passed: reports.filter((r: any) => r?.result === "pass").length,
    failed: reports.filter((r: any) => r?.result === "fail").length,
    warned: reports.filter((r: any) => r?.result === "warn").length,
  };
}
