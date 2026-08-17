// V1 P4 — THE ADAPTER AS A COMMAND.
//
// `skillonomia adapter open | invoke | cleanup`. This is the executable half of
// `P4-FR-07` and `INV-09`: the owner assigns a revision in the Console and does
// nothing else. No manifest is written, no archive is packed, no signature is
// made, and no runtime config is edited by hand — this command asks the registry
// for the session's frozen loadout, renders it, writes it into a session-scoped
// runtime home, launches the runtime pointed at that home through the runtime's
// OWN environment variable, and files what the runtime said back as a receipt.
//
// IT HOLDS NO STATE. Everything it knows it re-reads from the registry, and
// everything it writes it can rebuild. `cleanup` deletes the whole session
// directory and destroys nothing canonical (`P4-FR-08`).
//
// THE CREDENTIAL IT USES IS AN EVIDENCE PRINCIPAL'S, NOT THE OWNER'S. The
// registry refuses an owner or admin key on every surface this command calls
// (`INV-02`, `P4-FR-13`), which is deliberate: the thing that reports what a
// runtime did must not be the thing that tells the runtime what to do.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DraftContent } from "./draft.ts";
import { RUNTIMES, materializeEntry, sessionHome, cleanupSession, credentialShapeIn } from "./runtime-adapter.ts";
import { parseReceiptMarker, isRuntimeKind, RUNTIME_KINDS, type LoadoutEntryView, type RuntimeKind } from "./session-loadout.ts";

export interface AdapterIo {
  out(line: string): void;
  err(line: string): void;
}

export class AdapterError extends Error {}

// ------------------------------------------------------------------- client

interface Client {
  baseUrl: string;
  key: string;
}

async function api(client: Client, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${client.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${client.key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    // The registry's own error envelope, with its code — never the key, never
    // the body that was sent.
    const code = parsed?.error?.code ?? parsed?.code ?? res.status;
    const message = parsed?.error?.message ?? parsed?.message ?? "";
    throw new AdapterError(`registry refused ${method} ${path}: ${code} ${message}`);
  }
  return parsed;
}

// --------------------------------------------------------------------- open

export interface OpenResult {
  session_id: string;
  loadout_id: string;
  loadout_digest: string;
  agent_id: string;
  runtime_kind: RuntimeKind;
  runtime_version: string;
  adapter_version: string;
  home: string;
  root: string;
  home_env: string;
  entries: Array<{
    entry_id: string;
    skill_name: string;
    draft_revision_id: string;
    content_digest: string;
    relpath: string;
    artifact_digest: string;
    load_receipt_id: string;
    load_receipt_digest: string;
  }>;
  excluded: unknown[];
}

/**
 * OPEN A SESSION, MATERIALIZE ITS LOADOUT, AND CONFIRM THE LOAD.
 *
 * The `loaded` receipt is filed AFTER the entry file has been read back out of
 * the native location the runtime will open (`src/runtime-adapter.ts`), which is
 * the only thing that makes `loaded` mean more than "a write call returned".
 * `P4-FR-09`: `loaded` is set on adapter confirmation and never on the owner
 * command that created the assignment.
 */
export async function adapterOpen(opts: {
  client: Client;
  agentId: string;
  runtimeKind: RuntimeKind;
  runtimeVersion: string;
  base: string;
}): Promise<OpenResult> {
  const opened = await api(opts.client, "POST", "/v1/sessions", {
    agent_id: opts.agentId,
    runtime_kind: opts.runtimeKind,
    runtime_version: opts.runtimeVersion,
  });
  const sessionId: string = opened.session_id;
  const full = await api(opts.client, "GET", `/v1/sessions/${sessionId}/loadout`);
  const home = sessionHome(opts.base, sessionId, opts.runtimeKind);
  const contents = new Map<string, DraftContent>(
    (full.contents as Array<{ entry_id: string; content: DraftContent }>).map((c) => [c.entry_id, c.content]),
  );

  const entries: OpenResult["entries"] = [];
  for (const entry of full.loadout.entries as LoadoutEntryView[]) {
    const content = contents.get(entry.entry_id);
    if (content === undefined) throw new AdapterError(`the registry returned no content for loadout entry ${entry.entry_id}`);
    const placed = materializeEntry(home, entry, content);
    const receipt = await api(opts.client, "POST", `/v1/sessions/${sessionId}/receipts`, {
      stage: "loaded",
      runtime_session_ref: `${opts.runtimeKind}:home:${home.home}`,
      revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      transcript_excerpt: `read back ${placed.relpath} artifact_digest=${placed.artifact_digest}`,
    });
    entries.push({
      entry_id: entry.entry_id,
      skill_name: entry.skill_name,
      draft_revision_id: entry.draft_revision_id,
      content_digest: entry.content_digest,
      relpath: placed.relpath,
      artifact_digest: placed.artifact_digest,
      load_receipt_id: receipt.receipt_id,
      load_receipt_digest: receipt.receipt_digest,
    });
  }

  return {
    session_id: sessionId,
    loadout_id: full.loadout.loadout_id,
    loadout_digest: full.loadout.loadout_digest,
    agent_id: full.session.agent_id,
    runtime_kind: opts.runtimeKind,
    runtime_version: full.session.runtime_version,
    adapter_version: full.session.adapter_version,
    home: home.home,
    root: home.root,
    home_env: RUNTIMES[opts.runtimeKind].home_env,
    entries,
    excluded: full.loadout.excluded,
  };
}

// ------------------------------------------------------------------- invoke

export interface InvokeResult {
  session_id: string;
  skill_name: string;
  runtime_kind: RuntimeKind;
  /** the runtime's OWN session identifier, lifted from its own output */
  runtime_session_ref: string;
  invocation_ref: string;
  echoed_revision_id: string;
  echoed_content_digest: string;
  receipt_id: string;
  receipt_digest: string;
  observed_status: string;
  exit_code: number;
  transcript_path: string;
}

/** What each runtime is asked, and how its own session id is found in what it
 *  said. Two rows, again — this is the whole of the runtime-specific knowledge
 *  in the invocation path. */
interface Launch {
  argv: (prompt: string, home: string) => string[];
  /** the runtime's own session identifier, out of its own output */
  sessionRef: (stdout: string, stderr: string) => string | null;
  /** what the runtime finally said, for the marker to be lifted from */
  finalText: (stdout: string) => string;
}

const LAUNCH: Readonly<Record<RuntimeKind, Launch>> = {
  // `--dangerously-bypass-approvals-and-sandbox` IS AN ENVIRONMENT LIMITATION,
  // NOT A DESIGN CHOICE. Codex ships its own bubblewrap sandbox and reads
  // SKILL.md through its shell tool; a container that cannot nest bubblewrap
  // breaks skill loading, and this flag delegates the sandbox to the container
  // that is already one. A deployment that can nest it should drop the flag.
  // Recorded here rather than in a report so the next reader of this file sees
  // it where it is used.
  codex: {
    argv: (prompt) => ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt],
    sessionRef: (stdout, stderr) =>
      /session id:\s*([0-9a-f-]{36})/i.exec(stdout)?.[1] ?? /session id:\s*([0-9a-f-]{36})/i.exec(stderr)?.[1] ?? null,
    finalText: (stdout) => stdout,
  },
  // Claude Code needs `--permission-mode bypassPermissions` or the Skill call is
  // DENIED non-interactively and the run emits no JSON at all — so a session
  // that would have loaded the skill leaves no receipt to file.
  claude_code: {
    argv: (prompt) => ["-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions"],
    sessionRef: (stdout) => {
      try {
        return (JSON.parse(stdout) as { session_id?: string }).session_id ?? null;
      } catch {
        return null;
      }
    },
    finalText: (stdout) => {
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        return typeof parsed.result === "string" ? parsed.result : stdout;
      } catch {
        return stdout;
      }
    },
  },
};

/**
 * RUN THE RUNTIME AND FILE WHAT IT SAID.
 *
 * `P4-FR-19`: the receipt is not filed on the runtime having named a skill. It
 * is filed on the runtime having echoed the REVISION ID AND CONTENT DIGEST that
 * the materialized entry file carries, and the registry then refuses it unless
 * that digest is the one it froze into the loadout entry. A run that names the
 * skill and echoes nothing produces NO receipt and therefore leaves the entry
 * `unknown` — which is `P4-FR-11` and is the honest answer, not a failure of
 * this command to try hard enough.
 */
export async function adapterInvoke(opts: {
  client: Client;
  sessionId: string;
  skillName: string;
  runtimeKind: RuntimeKind;
  home: string;
  workdir: string;
  transcriptDir: string;
  binary?: string;
}): Promise<InvokeResult> {
  const adapter = RUNTIMES[opts.runtimeKind];
  const launch = LAUNCH[opts.runtimeKind];
  const prompt =
    `Use the ${opts.skillName} skill. Follow its "Canonical revision receipt" section exactly: ` +
    `report the SKLN-RECEIPT line it gives you, verbatim, on a line of its own.`;
  const env: NodeJS.ProcessEnv = { ...process.env, [adapter.home_env]: opts.home };
  const run = spawnSync(opts.binary ?? adapter.binary, launch.argv(prompt, opts.home), {
    cwd: opts.workdir,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";

  // `P4-FR-15` OVER THE RUNTIME LOG. The transcript is evidence and it is
  // written to disk, so it is scanned on the same patterns the artifact is
  // scanned on, and a hit refuses rather than writes.
  const transcript = `--- argv ---\n${adapter.binary} ${launch.argv(prompt, opts.home).join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
  const shape = credentialShapeIn(transcript);
  if (shape !== null) {
    throw new AdapterError(`the runtime transcript carries a value shaped like a credential (${shape}); it was not written`);
  }
  const transcriptPath = join(opts.transcriptDir, `${opts.runtimeKind}-${opts.sessionId}.txt`);
  writeFileSync(transcriptPath, transcript, { mode: 0o600 });

  const echoed = parseReceiptMarker(launch.finalText(stdout)) ?? parseReceiptMarker(stdout);
  if (echoed === null) {
    throw new AdapterError(
      `the ${opts.runtimeKind} session echoed no SKLN-RECEIPT line: no invocation receipt was filed, and the ` +
        `entry stays unknown. transcript: ${transcriptPath}`,
    );
  }
  const runtimeSessionRef = launch.sessionRef(stdout, stderr);
  if (runtimeSessionRef === null) {
    throw new AdapterError(`the ${opts.runtimeKind} session did not report its own session id. transcript: ${transcriptPath}`);
  }

  const filed = await api(opts.client, "POST", `/v1/sessions/${opts.sessionId}/receipts`, {
    stage: "invoked",
    runtime_session_ref: runtimeSessionRef,
    revision_id: echoed.revision_id,
    content_digest: echoed.content_digest,
    invocation_ref: `${runtimeSessionRef}#${opts.skillName}`,
    transcript_excerpt: launch.finalText(stdout).slice(0, 3000),
  });

  return {
    session_id: opts.sessionId,
    skill_name: opts.skillName,
    runtime_kind: opts.runtimeKind,
    runtime_session_ref: runtimeSessionRef,
    invocation_ref: `${runtimeSessionRef}#${opts.skillName}`,
    echoed_revision_id: echoed.revision_id,
    echoed_content_digest: echoed.content_digest,
    receipt_id: filed.receipt_id,
    receipt_digest: filed.receipt_digest,
    observed_status: filed.observed?.status ?? "unknown",
    exit_code: run.status ?? -1,
    transcript_path: transcriptPath,
  };
}

// ------------------------------------------------------------------ dispatch

function need(values: Record<string, string>, name: string): string {
  const v = values[name];
  if (v === undefined || v.length === 0) throw new AdapterError(`adapter: ${name} is required`);
  return v;
}

function clientFrom(values: Record<string, string>): Client {
  const baseUrl = values["--base-url"] ?? process.env.SKILLONOMIA_BASE_URL ?? "";
  const key = values["--key"] ?? process.env.SKILLONOMIA_ADAPTER_KEY ?? "";
  if (baseUrl.length === 0) throw new AdapterError("adapter: --base-url or SKILLONOMIA_BASE_URL is required");
  if (key.length === 0) throw new AdapterError("adapter: --key or SKILLONOMIA_ADAPTER_KEY is required");
  return { baseUrl: baseUrl.replace(/\/$/, ""), key };
}

function runtimeFrom(values: Record<string, string>): RuntimeKind {
  const kind = need(values, "--runtime");
  if (!isRuntimeKind(kind)) throw new AdapterError(`adapter: --runtime must be one of ${RUNTIME_KINDS.join(", ")}`);
  return kind;
}

/** The `adapter` subcommand. Every answer is one line of JSON on stdout, because
 *  its callers are a gate harness and a launcher, not a person. */
export async function runAdapter(
  argv: readonly string[],
  values: Record<string, string>,
  io: AdapterIo,
): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case "open": {
      const result = await adapterOpen({
        client: clientFrom(values),
        agentId: need(values, "--agent"),
        runtimeKind: runtimeFrom(values),
        runtimeVersion: values["--runtime-version"] ?? "unknown",
        base: need(values, "--base"),
      });
      io.out(JSON.stringify(result));
      return 0;
    }
    case "invoke": {
      const result = await adapterInvoke({
        client: clientFrom(values),
        sessionId: need(values, "--session"),
        skillName: need(values, "--skill"),
        runtimeKind: runtimeFrom(values),
        home: need(values, "--home"),
        workdir: values["--workdir"] ?? process.cwd(),
        transcriptDir: need(values, "--transcripts"),
        binary: values["--binary"],
      });
      io.out(JSON.stringify(result));
      return 0;
    }
    case "cleanup": {
      const outcome = cleanupSession(need(values, "--base"), need(values, "--session"));
      io.out(JSON.stringify({ session_id: values["--session"], derived_artifacts: outcome }));
      return 0;
    }
    default:
      throw new AdapterError(`adapter: unknown subcommand ${String(sub)}`);
  }
}
