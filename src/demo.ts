// `skillonomia demo` — the §9.1 quickstart, in Node, with no shell of its own.
//
// The quickstart has existed since P7 as `ci/quickstart.sh`: curl, python3 and
// tar, driven by bash. That is a fine CI gate on Linux and it is not a product
// path — a Windows user installing `@skillonomia/cli` from npm has Node and
// nothing else this project may assume. So the same eight steps live here, in
// the shipped package, reachable as one subcommand:
//
//   1. exchange the one-time bootstrap token for the owner key;
//   2. find the seed package and check it is `reviewed`;
//   3. request adoption as the demo adopter;
//   4. adopt — the handover, with the §4.2 compatibility outcome reported;
//   5. unpack the delivered archive (src/archive.ts, no `tar` binary);
//   6. RUN the package's own declared step and compare its output;
//   7. record `attempted` and then `adopted` with the gate results;
//   8. read the receipt back from the server and require terminal `adopted`.
//
// THE ONE PROCESS THIS SPAWNS IS THE PACKAGE'S OWN STEP. The seed package
// declares `sh fixtures/tv01.sh` and `tools_used: [shell]`; running it is the
// adopter's side of the contract, and a runner that skipped it would be
// reporting a gate result nobody produced. If no such interpreter exists on
// this host, step 6 REFUSES and names the package's own declared failure mode
// (`shell-missing`) — it does not report `adopted` for a run that did not
// happen. The refusal is the honest outcome on a host the package does not
// claim; a green one would be this project asserting an execution it never saw.
//
// WHAT THE DESCRIPTOR SAYS IS WHAT THIS HOST IS. `os`, `shell` and `runtime`
// are read off the machine, never fixed to the values that would match: on
// Windows the seed's `os: [linux, macos]` is genuinely unmet and §4.2 returns a
// `mismatch`, which at `risk_level: low` is a WARNING and not a block. That
// warning is printed. Declaring `linux` on a Windows host to obtain a `match`
// would be the adopter lying to the registry about its own environment.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readTar } from "./archive.ts";
import { serve, type Instance } from "./server.ts";

/** §7 performance budget: a clean quickstart reaches `adopted` within this. */
export const DEMO_BUDGET_MS = 600_000;

export interface DemoOptions {
  /** a running deployment to drive; omitted, the demo starts its own */
  baseUrl?: string;
  bootstrapToken?: string;
  adopterToken?: string;
  /** where a self-started instance keeps its data (default: a temp directory) */
  dataDir?: string;
  log?: (line: string) => void;
}

export interface DemoResult {
  base_url: string;
  skill_version_id: string;
  receipt_id: string;
  derived_state: string;
  compat: { result: string; unmet: string[] };
  command: string;
  observed: string;
  elapsed_ms: number;
}

/** A failure of the quickstart itself — reported as one line, never a stack. */
export class DemoError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DemoError(message);
}

// ------------------------------------------------------------------ the host

/** The §4.2 `os` name for this platform, or null if the profile has none. */
export function descriptorOs(platform: NodeJS.Platform = process.platform): "linux" | "macos" | "windows" | null {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return null;
}

/**
 * The interpreter a declared step needs, resolved on THIS host — `sh` for the
 * seed package. Returned as null when nothing answers, which is what makes the
 * refusal in step 6 a fact about the machine rather than a guess.
 */
export function resolveInterpreter(name: string): string | null {
  // `--version` is not universal (`sh --version` is a dash error), so the probe
  // is the interpreter running the smallest possible program successfully.
  const probe = spawnSync(name, ["-c", "exit 0"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0 ? name : null;
}

/** The §4.2 shell this host offers, as opposed to the one that would match. */
function descriptorShell(interpreter: string | null): "sh" | "powershell" | "none" {
  if (interpreter !== null) return "sh";
  return process.platform === "win32" ? "powershell" : "none";
}

// ------------------------------------------------------------------- the API

async function api(
  base: string,
  method: string,
  path: string,
  key: string | undefined,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new DemoError(`${method} ${path}: the deployment at ${base} did not answer (${String((e as Error).message)})`);
  }
  const text = await res.text();
  if (text.length === 0) return { status: res.status, body: null };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new DemoError(`${method} ${path}: answered ${res.status} with a body that is not JSON: ${text.slice(0, 200)}`);
  }
}

function expect(res: { status: number; body: any }, status: number, what: string): any {
  if (res.status !== status) {
    const detail = res.body?.error?.message ?? JSON.stringify(res.body)?.slice(0, 200) ?? "";
    throw new DemoError(`${what}: expected HTTP ${status}, got ${res.status} — ${detail}`);
  }
  return res.body;
}

// ------------------------------------------------------------------ the steps

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const started = Date.now();

  let instance: Instance | null = null;
  let temporary: string | null = null;
  let base = opts.baseUrl;
  let bootstrapToken = opts.bootstrapToken;
  let adopterToken = opts.adopterToken;

  if (base === undefined) {
    // A SELF-STARTED DEMO GETS ITS OWN DATA DIRECTORY. The §9.1 credentials are
    // one-time: spending them here against a real deployment's directory would
    // leave that deployment with no way to mint its owner key. `--data` is how
    // somebody asks for the other behaviour on purpose.
    const dataDir = opts.dataDir ?? (temporary = mkdtempSync(join(tmpdir(), "skillonomia-demo-")));
    instance = await serve({ port: 0, host: "127.0.0.1", dataDir, workerIntervalMs: 0, log: () => {} });
    base = `http://127.0.0.1:${instance.port}`;
    check(
      instance.credentials !== null,
      `the deployment at ${dataDir} has already been bootstrapped, so its one-time credentials cannot be printed ` +
        "again — pass --base-url with SKILLONOMIA_BOOTSTRAP_TOKEN and SKILLONOMIA_ADOPTER_TOKEN, or point --data at " +
        "a directory that has never been started",
    );
    bootstrapToken = instance.credentials.bootstrap_owner_token;
    adopterToken = instance.credentials.demo_adopter_token;
    log(`[0/8] a clean deployment on ${base}  (data: ${dataDir})`);
  }

  try {
    check(
      bootstrapToken !== undefined && bootstrapToken !== "",
      "no bootstrap token: set SKILLONOMIA_BOOTSTRAP_TOKEN (printed once at the deployment's first start)",
    );
    check(
      adopterToken !== undefined && adopterToken !== "",
      "no adopter token: set SKILLONOMIA_ADOPTER_TOKEN (printed once at the deployment's first start)",
    );

    // ---- 1. the bootstrap exchange
    const owner = expect(
      await api(base, "POST", "/v1/auth/bootstrap", undefined, { bootstrap_token: bootstrapToken }),
      200,
      "the §9.1 bootstrap exchange",
    );
    check(owner.role === "owner", `the bootstrap exchange returned role ${String(owner.role)}, not owner`);
    const ownerKey: string = owner.api_key;
    log("[1/8] bootstrap token exchanged for the owner key");

    // ---- 2. the seed package
    const search = expect(
      await api(base, "GET", "/v1/skills?q=hello-skillonomia", ownerKey),
      200,
      "the seed-package search",
    );
    const item = search.items?.[0];
    check(item?.slug === "hello-skillonomia", "the seed package hello-skillonomia is not in this registry");
    check(item.state === "reviewed", `the seed package is ${String(item.state)}, not reviewed`);
    const versionId: string = item.skill_version_id;
    log(`[2/8] seed package found: ${versionId} (${item.state})`);

    // ---- 3. the adoption request
    const request = expect(
      await api(base, "POST", "/v1/adoptions/requests", adopterToken, { skill_version_id: versionId }),
      201,
      "the adoption request",
    );
    const receiptId: string = request.receipt_id;
    log(`[3/8] adoption requested: receipt ${receiptId}`);

    // ---- 4. the handover, with THIS host in the descriptor
    const os = descriptorOs();
    check(os !== null, `${process.platform} is not one of the §4.2 platforms (linux, macos, windows)`);
    const interpreter = resolveInterpreter("sh");
    const descriptor = {
      runtime: { id: "node", version: process.versions.node.replace(/[^0-9.].*$/, "") },
      model: { id: "none", version: "0.0.0" },
      tools: interpreter === null ? [] : [{ id: "shell", version: "1.0.0" }],
      os,
      shell: descriptorShell(interpreter),
      sandbox_capable: false,
    };
    const adopted = expect(
      await api(base, "POST", `/v1/adoptions/${request.adoption_request_id}/adopt`, adopterToken, {
        environment_descriptor: descriptor,
      }),
      200,
      "the handover",
    );
    check(adopted.receipt_event === "delivered", `the handover recorded ${String(adopted.receipt_event)}, not delivered`);
    const compat = { result: String(adopted.compat?.result), unmet: (adopted.compat?.unmet ?? []) as string[] };
    log(`[4/8] delivered — §4.2 ${compat.result}${compat.unmet.length > 0 ? ` (unmet: ${compat.unmet.join(", ")})` : ""}`);
    if (adopted.warning !== undefined) log(`      warning: ${adopted.warning}`);

    // ---- 5. the archive, unpacked by this package's own reader
    const files = readTar(Buffer.from(adopted.package.archive_base64, "base64"));
    const work = mkdtempSync(join(tmpdir(), "skillonomia-demo-pkg-"));
    for (const [path, bytes] of files) {
      const target = join(work, path);
      // src/archive.ts already refuses traversal, absolute and drive-letter
      // member names; this is the same rule asserted where the write happens.
      check(resolve(target).startsWith(resolve(work)), `the delivered archive names a path outside the work directory: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const manifest = JSON.parse(files.get("skill.json")!.toString("utf8"));
    log(`[5/8] package unpacked: ${files.size} members, content hash ${String(adopted.package.content_hash).slice(0, 16)}…`);

    // ---- 6. the package's own step, run
    const steps = manifest.procedure?.steps ?? [];
    check(steps.length === 1, `the seed package declares ${steps.length} steps; this quickstart runs the one it has`);
    const step = steps[0];
    const command = String(step.command);
    const [program, ...args] = command.split(/\s+/);
    check(
      program === "sh",
      `the seed package's step is \`${command}\`, whose interpreter this quickstart does not know how to run`,
    );
    check(
      interpreter !== null,
      `the package's declared step is \`${command}\` and no POSIX shell answers on this host. That is the package's ` +
        "own declared failure mode `shell-missing`; its remedy is to install a POSIX shell. Nothing was adopted: a " +
        "receipt reaching `adopted` here would report a gate result that no run produced.",
    );
    const run = spawnSync(interpreter, args, { cwd: work, encoding: "utf8" });
    check(run.error === undefined, `\`${command}\` could not be run: ${String(run.error?.message)}`);
    check(run.status === 0, `\`${command}\` exited ${String(run.status)}: ${run.stderr}`);
    const observed = run.stdout.trim();
    check(
      observed === step.expected,
      `\`${command}\` printed ${JSON.stringify(observed)}, and the package expects ${JSON.stringify(step.expected)}`,
    );
    log(`[6/8] \`${command}\` ran and printed ${JSON.stringify(observed)}`);

    // ---- 7. the receipt chain, to terminal
    expect(
      await api(base, "POST", `/v1/receipts/${receiptId}/events`, adopterToken, { event: "attempted" }),
      200,
      "the `attempted` event",
    );
    const gates = (manifest.procedure?.validation_gates ?? []).map((g: any) => ({
      gate_id: g.gate_id,
      pass: true,
      observed,
    }));
    const terminal = expect(
      await api(base, "POST", `/v1/receipts/${receiptId}/events`, adopterToken, {
        event: "adopted",
        evidence: { gate_results: gates },
      }),
      200,
      "the `adopted` event",
    );
    check(terminal.receipt_event === "adopted", `the chain recorded ${String(terminal.receipt_event)}, not adopted`);
    log(`[7/8] receipt chain terminal: ${gates.length} gate result(s) reported by this runner`);

    // ---- 8. the read-back — the server's answer, not this process's memory
    const readBack = expect(await api(base, "GET", `/v1/receipts/${receiptId}`, adopterToken), 200, "the receipt read-back");
    check(
      readBack.derived_state === "adopted",
      `the server reads this receipt back as ${String(readBack.derived_state)}, not adopted`,
    );
    const elapsed = Date.now() - started;
    log(`[8/8] read back from the server: receipt ${receiptId} is \`adopted\` (${(elapsed / 1000).toFixed(1)}s)`);
    log(
      "      `observed` and this receipt are the adopter's and the server's assertions: the registry checks that the " +
        "reported gate ids are the ones this version declares, and does not witness the run.",
    );

    return {
      base_url: base,
      skill_version_id: versionId,
      receipt_id: receiptId,
      derived_state: readBack.derived_state,
      compat,
      command,
      observed,
      elapsed_ms: elapsed,
    };
  } finally {
    instance?.close();
    if (temporary !== null) rmSync(temporary, { recursive: true, force: true });
  }
}
