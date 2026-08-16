// V1 P1 — CAPTURE: the three ways a procedure arrives, and what happens to it.
//
// This is the boundary of the V1 Skill Loop. Three inputs are accepted and no
// others:
//
//   * a WORKFLOW — text somebody wrote down, "here is how we do X";
//   * a SESSION — the content of an agent session, with the turns as they were;
//   * a NATIVE SKILL — a file one of the two supported runtimes already reads,
//     in the layout that runtime reads it from (`src/activation.ts` owns that
//     layout, and this module asks it rather than restating it).
//
// The pipeline is fixed and each stage may only see what the stage before it
// produced:
//
//   normalise → REDACT → classify → compile → preview → store → audit
//
// REDACTION IS THE SECOND STAGE ON PURPOSE. Everything downstream — the
// classifier, the compiler, the previews, the row in SQLite, the audit event,
// the response on the wire — operates on the redacted text. The original is a
// parameter of one function call and is never stored, logged or returned.
//
// A CAPTURE THAT PRODUCES NO DRAFT IS STILL AN ANSWER. Six of the seven kinds
// the classifier knows are not skills, and a malformed or unsupported native
// file is not one either. Each of those ends in a STRUCTURED REFUSAL with a
// code, a reason and — where the classifier had an opinion — the signals it
// fired on. What none of them ends in is a half-written draft.
import type { Db } from "./sqlite.ts";
import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { ulid } from "./ulid.ts";
import { createHash } from "node:crypto";
import { redact, redactReference, type RedactionFinding } from "./redaction.ts";
import { classify, type Classification, type SkillCategory } from "./skillability.ts";
import {
  COMPILER_VERSION,
  compileDraft,
  contentDigest,
  securityReview,
  semanticReview,
  type DraftContent,
  type DraftProvenance,
  type SecurityReview,
  type SemanticReview,
} from "./draft.ts";
import { ACTIVATION_TARGETS, NATIVE_ENTRY, nativeRelativePath, type ActivationTarget } from "./activation.ts";

/** The runtimes a native skill may be imported from — the two V1 supports. */
export const CAPTURE_RUNTIMES = ["claude_code", "codex"] as const;
export type CaptureRuntime = (typeof CAPTURE_RUNTIMES)[number];

export const CAPTURE_KINDS = ["workflow", "session", "native_skill"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const CAPTURE_FORMATS = ["workflow_text", "agent_session", "claude_code_skill", "codex_skill"] as const;
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number];

/** A capture larger than this is refused at the boundary rather than stored:
 *  the column is bounded, and a bound that is only enforced by SQLite is one
 *  that reports as a constraint failure instead of as an answer. */
export const MAX_SOURCE_CHARS = 100_000;

export interface SessionTurn {
  role: string;
  text: string;
}

export interface CaptureRefusal {
  /** the machine-readable refusal, distinct from the classifier's reason code */
  code: string;
  category: SkillCategory | null;
  reason_code: string;
  reason: string;
  routing_reason: string | null;
}

export interface DraftRevisionView {
  draft_id: string;
  revision_id: string;
  revision: number;
  parent_revision_id: string | null;
  capture_id: string;
  origin: "capture" | "edit" | "recompile";
  author_agent_id: string;
  compiler_version: string;
  content_digest: string;
  created_at_ms: number;
  content: DraftContent;
  semantic_review: SemanticReview;
  security_review: SecurityReview;
}

export interface CaptureResponse {
  outcome: "drafted" | "refused";
  capture_id: string;
  source_kind: CaptureKind;
  source_format: CaptureFormat;
  source_digest: string;
  classification: Classification | null;
  draft: DraftRevisionView | null;
  refusal: CaptureRefusal | null;
}

export interface DraftListItem {
  draft_id: string;
  latest_revision_id: string;
  latest_revision: number;
  revisions: number;
  capture_id: string;
  title: string;
  content_digest: string;
  semantic_status: SemanticReview["status"];
  semantic_blocking: number;
  security_blocking: number;
  created_at_ms: number;
}

export interface DraftLineageEntry {
  revision_id: string;
  revision: number;
  parent_revision_id: string | null;
  origin: "capture" | "edit" | "recompile";
  content_digest: string;
  created_at_ms: number;
}

export interface DraftDetail {
  draft_id: string;
  revision: DraftRevisionView;
  lineage: DraftLineageEntry[];
}

export interface DraftAuditEvent {
  event_id: string;
  event: string;
  draft_id: string | null;
  draft_revision_id: string | null;
  capture_id: string;
  actor_agent_id: string;
  actor_role: string;
  source: string;
  correlation_ref: string | null;
  reason_code: string | null;
  result: string;
  content_digest: string | null;
  provenance: unknown;
  server_at_ms: number;
}

export interface DraftAuditResponse {
  draft_id: string;
  items: DraftAuditEvent[];
}

// ------------------------------------------------------------- normalisation

interface Normalised {
  kind: CaptureKind;
  format: CaptureFormat;
  /** the raw normalised text. It leaves this function and goes STRAIGHT into
   *  `redact`; no other caller ever receives it. */
  text: string;
  ref: string | null;
  fallbackTitle: string;
}

interface NormalisationRefusal {
  code: string;
  reason: string;
  kind: CaptureKind;
  format: CaptureFormat;
  /** whatever of the source is safe to keep as the record of the arrival: the
   *  refusal itself, never the content that failed to parse */
  ref: string | null;
}

function asString(value: unknown, field: string, max = MAX_SOURCE_CHARS): string {
  if (typeof value !== "string") throw new ApiError("INVALID_SCHEMA", `${field} must be a string`);
  if (value.length > max) throw new ApiError("LIMIT_EXCEEDED", `${field} exceeds ${max} characters`);
  return value;
}

function optionalRef(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const s = asString(value, field, 200);
  return s.trim().length === 0 ? null : s.trim();
}

/** A native path, checked as a PATH before it is checked as a skill. */
function nativePathParts(path: string): { dir: string; name: string } | NativeProblem {
  if (path.length === 0 || path.length > 200) return { code: "UNSUPPORTED_NATIVE_SOURCE", reason: "the native path is empty or too long to be one" };
  if (path.includes("\\")) return { code: "UNSAFE_NATIVE_PATH", reason: "a native path is written with forward slashes; a backslash is not a separator here" };
  if (path.startsWith("/")) return { code: "UNSAFE_NATIVE_PATH", reason: "a native path is relative to the runtime's root, and an absolute path names somewhere else" };
  const segments = path.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === ".."))
    return { code: "UNSAFE_NATIVE_PATH", reason: "a native path may not contain an empty segment or a traversal segment" };
  if (segments.length < 2) return { code: "UNSUPPORTED_NATIVE_SOURCE", reason: "a native skill is a directory with an entry file in it" };
  const entry = segments[segments.length - 1]!;
  if (entry !== NATIVE_ENTRY)
    return { code: "UNSUPPORTED_NATIVE_SOURCE", reason: `the entry file of a native skill is \`${NATIVE_ENTRY}\`` };
  return { dir: segments.slice(0, -2).join("/"), name: segments[segments.length - 2]! };
}

interface NativeProblem {
  code: string;
  reason: string;
}

function isProblem(v: unknown): v is NativeProblem {
  return typeof v === "object" && v !== null && "code" in v && "reason" in v;
}

/** The activation targets that belong to one runtime — the same table the
 *  adapter writes through, read in the other direction. */
function targetsFor(runtime: CaptureRuntime): ActivationTarget[] {
  return ACTIVATION_TARGETS.filter((t) => (runtime === "codex" ? t === "codex" : t.startsWith("claude_code")));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Read a native skill file of one of the two supported runtimes.
 *
 * The two formats differ, and the difference is the point: a Claude Code skill
 * declares itself in YAML frontmatter, and the Codex layout this registry
 * materialises into carries a markdown document whose first heading names it. A
 * file in one runtime's layout written in the other runtime's form is refused
 * as unsupported rather than parsed leniently — leniency here would mean
 * importing a file neither runtime would load.
 */
function readNative(runtime: CaptureRuntime, path: string, content: string): Normalised | NativeProblem {
  const parts = nativePathParts(path);
  if (isProblem(parts)) return parts;
  let expected: string[];
  try {
    expected = targetsFor(runtime).map((t) => nativeRelativePath(t, parts.name));
  } catch {
    return {
      code: "UNSAFE_NATIVE_PATH",
      reason: "the directory name is not a name a native location may carry",
    };
  }
  if (!expected.includes(path)) {
    return {
      code: "UNSUPPORTED_NATIVE_SOURCE",
      reason: `\`${path}\` is not a location ${runtime === "codex" ? "Codex" : "Claude Code"} reads a skill from`,
    };
  }
  if (content.trim().length === 0) {
    return { code: "MALFORMED_NATIVE_SOURCE", reason: "the native skill file is empty" };
  }

  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (runtime === "claude_code") {
    if (frontmatter === null) {
      return {
        code: "MALFORMED_NATIVE_SOURCE",
        reason: "a Claude Code skill begins with a YAML frontmatter block delimited by `---`, and this file does not",
      };
    }
    const name = /^name\s*:\s*(.+)$/im.exec(frontmatter[1]!);
    const description = /^description\s*:\s*(.+)$/im.exec(frontmatter[1]!);
    if (name === null || description === null) {
      return {
        code: "MALFORMED_NATIVE_SOURCE",
        reason: "a Claude Code skill declares `name` and `description` in its frontmatter",
      };
    }
    if (slug(name[1]!.trim()) !== parts.name) {
      return {
        code: "MALFORMED_NATIVE_SOURCE",
        reason: "the declared `name` and the directory the skill sits in disagree",
      };
    }
    if (content.slice(frontmatter[0].length).trim().length === 0) {
      return { code: "MALFORMED_NATIVE_SOURCE", reason: "the skill declares itself and carries no body" };
    }
    return { kind: "native_skill", format: "claude_code_skill", text: content, ref: path, fallbackTitle: parts.name };
  }

  if (frontmatter !== null) {
    return {
      code: "UNSUPPORTED_NATIVE_SOURCE",
      reason: "this file is in the Codex layout and carries Claude Code's frontmatter form; it is not a document Codex reads",
    };
  }
  const heading = /^\s*#\s+(.+)$/m.exec(content);
  if (heading === null || heading.index !== 0) {
    return {
      code: "MALFORMED_NATIVE_SOURCE",
      reason: "a Codex skill document begins with a level-1 markdown heading naming the skill",
    };
  }
  if (slug(heading[1]!.trim()) !== parts.name) {
    return {
      code: "MALFORMED_NATIVE_SOURCE",
      reason: "the heading and the directory the skill sits in name different skills",
    };
  }
  if (content.slice(heading[0].length).trim().length === 0) {
    return { code: "MALFORMED_NATIVE_SOURCE", reason: "the skill names itself and carries no body" };
  }
  return { kind: "native_skill", format: "codex_skill", text: content, ref: path, fallbackTitle: parts.name };
}

/** The turns of a session, rendered as one document in the order they happened.
 *  Not markdown headings: a turn that began with `## Procedure` would otherwise
 *  become a section of the draft by accident of transcript formatting. */
function renderSession(turns: SessionTurn[]): string {
  return turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
}

const SESSION_ROLES = ["user", "assistant", "system", "tool"];

/**
 * Validate and normalise a capture request.
 *
 * A request whose SHAPE is wrong — a missing field, a number where a string
 * belongs — is `INVALID_SCHEMA`, because there is nothing to record. A request
 * that is well-formed and whose CONTENT cannot be imported is a refusal, which
 * is recorded: those are different failures and a caller has to be able to tell
 * them apart.
 */
function normalise(input: Record<string, unknown>): Normalised | NormalisationRefusal {
  const kind = input.kind;
  if (typeof kind !== "string" || !(CAPTURE_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError("INVALID_SCHEMA", `kind must be one of ${CAPTURE_KINDS.join(", ")}`);
  }
  if (kind === "workflow") {
    const text = asString(input.text, "text");
    return {
      kind,
      format: "workflow_text",
      text,
      ref: optionalRef(input.source_ref, "source_ref"),
      fallbackTitle: optionalRef(input.title, "title") ?? "untitled workflow",
    };
  }
  if (kind === "session") {
    const session = input.session;
    if (typeof session !== "object" || session === null || Array.isArray(session)) {
      throw new ApiError("INVALID_SCHEMA", "session must be an object");
    }
    const turns = (session as Record<string, unknown>).turns;
    if (!Array.isArray(turns) || turns.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "session.turns must be a non-empty array");
    }
    const parsed: SessionTurn[] = turns.map((turn, i) => {
      if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
        throw new ApiError("INVALID_SCHEMA", `session.turns[${i}] must be an object`);
      }
      const role = (turn as Record<string, unknown>).role;
      if (typeof role !== "string" || !SESSION_ROLES.includes(role)) {
        throw new ApiError("INVALID_SCHEMA", `session.turns[${i}].role must be one of ${SESSION_ROLES.join(", ")}`);
      }
      return { role, text: asString((turn as Record<string, unknown>).text, `session.turns[${i}].text`) };
    });
    const text = renderSession(parsed);
    if (text.length > MAX_SOURCE_CHARS) throw new ApiError("LIMIT_EXCEEDED", `session exceeds ${MAX_SOURCE_CHARS} characters`);
    return {
      kind,
      format: "agent_session",
      text,
      ref: optionalRef((session as Record<string, unknown>).session_ref, "session.session_ref"),
      fallbackTitle: optionalRef(input.title, "title") ?? "untitled session",
    };
  }
  const native = input.native;
  if (typeof native !== "object" || native === null || Array.isArray(native)) {
    throw new ApiError("INVALID_SCHEMA", "native must be an object");
  }
  const runtime = (native as Record<string, unknown>).runtime;
  if (typeof runtime !== "string" || !(CAPTURE_RUNTIMES as readonly string[]).includes(runtime)) {
    throw new ApiError("INVALID_SCHEMA", `native.runtime must be one of ${CAPTURE_RUNTIMES.join(", ")}`);
  }
  const path = asString((native as Record<string, unknown>).path, "native.path", 200);
  const content = asString((native as Record<string, unknown>).content, "native.content");
  const read = readNative(runtime as CaptureRuntime, path, content);
  if (isProblem(read)) {
    return {
      code: read.code,
      reason: read.reason,
      kind: "native_skill",
      format: runtime === "codex" ? "codex_skill" : "claude_code_skill",
      ref: path,
    };
  }
  return read;
}

// ------------------------------------------------------------------ storage

function digestOfSource(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface EventInput {
  event: "captured" | "classified" | "compiled" | "revised" | "refused";
  captureId: string;
  draftId: string | null;
  revisionId: string | null;
  auth: AuthContext;
  source: "registry" | "owner" | "agent";
  correlationRef: string | null;
  reasonCode: string | null;
  result: "drafted" | "refused" | "recorded";
  contentDigest: string | null;
  provenance: Record<string, unknown>;
  nowMs: number;
}

/** One audit row. Every field the reader needs is a COLUMN; `provenance_json`
 *  carries the payload and is never where the event type or the actor hides. */
function appendEvent(db: Db, e: EventInput): void {
  db.prepare(
    `INSERT INTO draft_events(id, draft_id, draft_revision_id, capture_id, event, actor_agent_id, actor_role, source,
       correlation_ref, reason_code, result, content_digest, provenance_json, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ulid(e.nowMs),
    e.draftId,
    e.revisionId,
    e.captureId,
    e.event,
    e.auth.agent_id,
    e.auth.role,
    e.source,
    e.correlationRef,
    e.reasonCode,
    e.result,
    e.contentDigest,
    JSON.stringify(e.provenance),
    e.nowMs,
  );
}

interface RevisionRow {
  id: string;
  draft_id: string;
  revision: number;
  parent_revision_id: string | null;
  capture_id: string;
  workspace_id: string;
  author_agent_id: string;
  origin: "capture" | "edit" | "recompile";
  compiler_version: string;
  content_json: string;
  content_digest: string;
  semantic_json: string;
  security_json: string;
  server_at_ms: number;
}

function viewOf(row: RevisionRow): DraftRevisionView {
  return {
    draft_id: row.draft_id,
    revision_id: row.id,
    revision: row.revision,
    parent_revision_id: row.parent_revision_id,
    capture_id: row.capture_id,
    origin: row.origin,
    author_agent_id: row.author_agent_id,
    compiler_version: row.compiler_version,
    content_digest: row.content_digest,
    created_at_ms: row.server_at_ms,
    content: JSON.parse(row.content_json) as DraftContent,
    semantic_review: JSON.parse(row.semantic_json) as SemanticReview,
    security_review: JSON.parse(row.security_json) as SecurityReview,
  };
}

function insertRevision(
  db: Db,
  args: {
    draftId: string;
    revision: number;
    parentRevisionId: string | null;
    captureId: string;
    auth: AuthContext;
    origin: "capture" | "edit" | "recompile";
    content: DraftContent;
    semantic: SemanticReview;
    security: SecurityReview;
    nowMs: number;
  },
): RevisionRow {
  const row: RevisionRow = {
    id: ulid(args.nowMs),
    draft_id: args.draftId,
    revision: args.revision,
    parent_revision_id: args.parentRevisionId,
    capture_id: args.captureId,
    workspace_id: args.auth.workspace_id,
    author_agent_id: args.auth.agent_id,
    origin: args.origin,
    compiler_version: COMPILER_VERSION,
    content_json: JSON.stringify(args.content),
    content_digest: contentDigest(args.content),
    semantic_json: JSON.stringify(args.semantic),
    security_json: JSON.stringify(args.security),
    server_at_ms: args.nowMs,
  };
  db.prepare(
    `INSERT INTO draft_revisions(id, draft_id, revision, parent_revision_id, capture_id, workspace_id, author_agent_id,
       origin, compiler_version, content_json, content_digest, semantic_json, security_json, server_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.draft_id,
    row.revision,
    row.parent_revision_id,
    row.capture_id,
    row.workspace_id,
    row.author_agent_id,
    row.origin,
    row.compiler_version,
    row.content_json,
    row.content_digest,
    row.semantic_json,
    row.security_json,
    row.server_at_ms,
  );
  return row;
}

// ----------------------------------------------------------------- the path

/**
 * Capture one input and answer with a draft or with a refusal.
 *
 * The transaction boundary is the caller's (`src/service.ts` runs this under
 * the same idempotency wrapper every other mutating surface uses), so a repeat
 * with one idempotency key replays the first answer rather than compiling
 * twice.
 */
export function captureDraft(db: Db, auth: AuthContext, input: Record<string, unknown>, nowMs: number): CaptureResponse {
  const normalised = normalise(input);

  // ---- the refusal that happens BEFORE any content is admitted: a native
  // file that is malformed or in a form neither runtime reads. Nothing of the
  // content is stored, and the record of the arrival is the refusal itself.
  if (!("text" in normalised)) {
    const refusal = normalised as NormalisationRefusal;
    const captureId = ulid(nowMs);
    const ref = refusal.ref === null ? null : redactReference(refusal.ref);
    db.prepare(
      `INSERT INTO captures(id, workspace_id, captured_by_agent_id, source_kind, source_format, source_ref,
         redacted_source, source_digest, category, skillable, reason_code, outcome, server_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      captureId,
      auth.workspace_id,
      auth.agent_id,
      refusal.kind,
      refusal.format,
      ref,
      `⟦REFUSED:${refusal.code}⟧`,
      digestOfSource(`refused:${refusal.code}`),
      "ambiguous",
      0,
      refusal.code,
      "refused",
      nowMs,
    );
    appendEvent(db, {
      event: "refused",
      captureId,
      draftId: null,
      revisionId: null,
      auth,
      source: "registry",
      correlationRef: ref,
      reasonCode: refusal.code,
      result: "refused",
      contentDigest: null,
      provenance: { source_kind: refusal.kind, source_format: refusal.format, stage: "import" },
      nowMs,
    });
    return {
      outcome: "refused",
      capture_id: captureId,
      source_kind: refusal.kind,
      source_format: refusal.format,
      source_digest: digestOfSource(`refused:${refusal.code}`),
      classification: null,
      draft: null,
      refusal: {
        code: refusal.code,
        category: null,
        reason_code: refusal.code,
        reason: refusal.reason,
        routing_reason: "an import that cannot be read is refused whole: no part of it becomes a draft",
      },
    };
  }

  // ---- REDACTION, before anything at all is written
  const redacted = redact(normalised.text);
  const text = redacted.text;
  const ref = normalised.ref === null ? null : redactReference(normalised.ref);
  const sourceDigest = digestOfSource(text);

  const classification = classify(text);
  const captureId = ulid(nowMs);

  const insertCapture = (outcome: "drafted" | "refused"): void => {
    db.prepare(
      `INSERT INTO captures(id, workspace_id, captured_by_agent_id, source_kind, source_format, source_ref,
         redacted_source, source_digest, category, skillable, reason_code, outcome, server_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      captureId,
      auth.workspace_id,
      auth.agent_id,
      normalised.kind,
      normalised.format,
      ref,
      text,
      sourceDigest,
      classification.category,
      classification.skillable ? 1 : 0,
      classification.reason_code,
      outcome,
      nowMs,
    );
    appendEvent(db, {
      event: "captured",
      captureId,
      draftId: null,
      revisionId: null,
      auth,
      source: normalised.kind === "workflow" ? "owner" : "agent",
      correlationRef: ref,
      reasonCode: null,
      result: "recorded",
      contentDigest: null,
      provenance: {
        source_kind: normalised.kind,
        source_format: normalised.format,
        source_digest: sourceDigest,
        redactions: redacted.findings.length,
      },
      nowMs,
    });
    appendEvent(db, {
      event: "classified",
      captureId,
      draftId: null,
      revisionId: null,
      auth,
      source: "registry",
      correlationRef: ref,
      reasonCode: classification.reason_code,
      result: "recorded",
      contentDigest: null,
      provenance: {
        category: classification.category,
        skillable: classification.skillable,
        classifier_version: classification.classifier_version,
        scores: classification.scores,
        step_count: classification.step_count,
      },
      nowMs,
    });
  };

  if (!classification.skillable) {
    insertCapture("refused");
    appendEvent(db, {
      event: "refused",
      captureId,
      draftId: null,
      revisionId: null,
      auth,
      source: "registry",
      correlationRef: ref,
      reasonCode: classification.reason_code,
      result: "refused",
      contentDigest: null,
      provenance: { stage: "classification", category: classification.category, signals: classification.signals },
      nowMs,
    });
    return {
      outcome: "refused",
      capture_id: captureId,
      source_kind: normalised.kind,
      source_format: normalised.format,
      source_digest: sourceDigest,
      classification,
      draft: null,
      refusal: {
        code: "NOT_SKILLABLE",
        category: classification.category,
        reason_code: classification.reason_code,
        reason: classification.reason,
        routing_reason: classification.routing_reason,
      },
    };
  }

  const provenance: DraftProvenance = {
    source_kind: normalised.kind,
    source_format: normalised.format,
    source_ref: ref,
    source_digest: sourceDigest,
  };
  const content = compileDraft({
    text,
    provenance,
    redactions: redacted.findings,
    fallbackTitle: normalised.fallbackTitle,
  });
  const semantic = semanticReview(content, text);
  const security = securityReview(content, text);

  insertCapture("drafted");
  const draftId = ulid(nowMs);
  const row = insertRevision(db, {
    draftId,
    revision: 1,
    parentRevisionId: null,
    captureId,
    auth,
    origin: "capture",
    content,
    semantic,
    security,
    nowMs,
  });
  appendEvent(db, {
    event: "compiled",
    captureId,
    draftId,
    revisionId: row.id,
    auth,
    source: "registry",
    correlationRef: ref,
    reasonCode: classification.reason_code,
    result: "drafted",
    contentDigest: row.content_digest,
    provenance: {
      compiler_version: COMPILER_VERSION,
      semantic_status: semantic.status,
      semantic_blocking: semantic.blocking_count,
      security_blocking: security.blocking_count,
      redactions: redacted.findings.length,
      revision: 1,
    },
    nowMs,
  });

  return {
    outcome: "drafted",
    capture_id: captureId,
    source_kind: normalised.kind,
    source_format: normalised.format,
    source_digest: sourceDigest,
    classification,
    draft: viewOf(row),
    refusal: null,
  };
}

// ------------------------------------------------------------------- revise

const EDITABLE_STRINGS = ["title", "purpose", "when_to_use"] as const;
const EDITABLE_LISTS = ["procedure", "inputs", "outputs", "permissions", "dependencies", "failure_modes"] as const;

/**
 * Edit or recompile a draft — always as a NEW revision.
 *
 * There is no code path in this module that updates a `draft_revisions` row,
 * and the table refuses one anyway (`tg_draft_revisions_no_upd`). An edit
 * carries the sections an owner changed; a body with no sections at all is a
 * RECOMPILE, which runs the current compiler over the capture's stored redacted
 * source. Both append.
 *
 * OWNER TEXT IS REDACTED TOO. An owner pasting a token into an edited step is
 * the same event as an agent pasting one into a capture, and it is treated the
 * same way: the value never reaches the row.
 */
export function reviseDraft(
  db: Db,
  auth: AuthContext,
  draftId: unknown,
  input: Record<string, unknown>,
  nowMs: number,
): DraftRevisionView {
  const latest = latestRevisionRow(db, auth, draftId);
  const previous = JSON.parse(latest.content_json) as DraftContent;
  const capture = db
    .prepare("SELECT redacted_source, source_ref FROM captures WHERE id=?")
    .get(latest.capture_id) as { redacted_source: string; source_ref: string | null };

  const sections = input.sections;
  if (sections !== undefined && (typeof sections !== "object" || sections === null || Array.isArray(sections))) {
    throw new ApiError("INVALID_SCHEMA", "sections must be an object");
  }
  const edits = (sections ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(edits)) {
    if (![...EDITABLE_STRINGS, ...EDITABLE_LISTS].includes(key as never)) {
      throw new ApiError("INVALID_SCHEMA", `sections.${key} is not an editable section of a draft`);
    }
  }

  if (Object.keys(edits).length === 0) {
    // a recompile: the same normalised input, the current compiler
    const content = compileDraft({
      text: capture.redacted_source,
      provenance: previous.provenance,
      redactions: previous.redactions,
      fallbackTitle: previous.title,
    });
    return appendRevision(db, auth, latest, content, capture.redacted_source, "recompile", nowMs);
  }

  const content: DraftContent = {
    ...previous,
    redactions: [...previous.redactions],
    provenance: previous.provenance,
  };
  const added: RedactionFinding[] = [];
  const clean = (value: string, section: string): string => {
    const out = redact(value);
    for (const finding of out.findings) {
      added.push({ ...finding, reason: `in the edited ${section.replace(/_/g, " ")}: ${finding.reason}` });
    }
    return out.text;
  };
  for (const key of EDITABLE_STRINGS) {
    if (!(key in edits)) continue;
    content[key] = clean(asString(edits[key], `sections.${key}`, 4000), key);
  }
  for (const key of EDITABLE_LISTS) {
    if (!(key in edits)) continue;
    const value = edits[key];
    if (!Array.isArray(value)) throw new ApiError("INVALID_SCHEMA", `sections.${key} must be an array of strings`);
    if (value.length > 200) throw new ApiError("LIMIT_EXCEEDED", `sections.${key} carries more than 200 entries`);
    content[key] = value.map((item, i) => clean(asString(item, `sections.${key}[${i}]`, 4000), key));
  }
  content.redactions = [...content.redactions, ...added];

  // the semantic and security previews are recomputed against the EDITED
  // draft, rendered back into the same line-oriented form the reviews read
  const rendered = renderForReview(content);
  return appendRevision(db, auth, latest, content, rendered, "edit", nowMs);
}

/** The edited draft as a document, so the reviews read what an owner changed
 *  rather than what the capture originally said. */
function renderForReview(content: DraftContent): string {
  const lines: string[] = [`# ${content.title}`, "", "## Purpose", content.purpose, "", "## When to use", content.when_to_use, "", "## Procedure"];
  content.procedure.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  for (const [heading, items] of [
    ["Inputs", content.inputs],
    ["Outputs", content.outputs],
    ["Permissions", content.permissions],
    ["Dependencies", content.dependencies],
    ["Failure modes", content.failure_modes],
  ] as const) {
    lines.push("", `## ${heading}`);
    for (const item of items) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function appendRevision(
  db: Db,
  auth: AuthContext,
  latest: RevisionRow,
  content: DraftContent,
  reviewSource: string,
  origin: "edit" | "recompile",
  nowMs: number,
): DraftRevisionView {
  const semantic = semanticReview(content, reviewSource);
  const security = securityReview(content, reviewSource);
  const row = insertRevision(db, {
    draftId: latest.draft_id,
    revision: latest.revision + 1,
    parentRevisionId: latest.id,
    captureId: latest.capture_id,
    auth,
    origin,
    content,
    semantic,
    security,
    nowMs,
  });
  appendEvent(db, {
    event: "revised",
    captureId: latest.capture_id,
    draftId: latest.draft_id,
    revisionId: row.id,
    auth,
    source: "owner",
    correlationRef: content.provenance.source_ref,
    reasonCode: null,
    result: "drafted",
    contentDigest: row.content_digest,
    provenance: {
      origin,
      revision: row.revision,
      parent_revision_id: latest.id,
      parent_content_digest: latest.content_digest,
      compiler_version: COMPILER_VERSION,
      semantic_status: semantic.status,
      semantic_blocking: semantic.blocking_count,
      security_blocking: security.blocking_count,
    },
    nowMs,
  });
  return viewOf(row);
}

// -------------------------------------------------------------------- reads

function requireDraftId(draftId: unknown): string {
  if (typeof draftId !== "string" || draftId.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "draft_id must be a string");
  }
  return draftId;
}

function latestRevisionRow(db: Db, auth: AuthContext, draftId: unknown): RevisionRow {
  const id = requireDraftId(draftId);
  const row = db
    .prepare("SELECT * FROM draft_revisions WHERE draft_id=? AND workspace_id=? ORDER BY revision DESC LIMIT 1")
    .get(id, auth.workspace_id) as RevisionRow | undefined;
  if (row === undefined) throw new ApiError("NOT_FOUND", `no draft ${id}`);
  return row;
}

export function listDrafts(db: Db, auth: AuthContext): { items: DraftListItem[] } {
  const rows = db
    .prepare("SELECT * FROM draft_revisions WHERE workspace_id=? ORDER BY draft_id, revision")
    .all(auth.workspace_id) as RevisionRow[];
  const byDraft = new Map<string, RevisionRow[]>();
  for (const row of rows) {
    const list = byDraft.get(row.draft_id);
    if (list === undefined) byDraft.set(row.draft_id, [row]);
    else list.push(row);
  }
  const items: DraftListItem[] = [];
  for (const [draftId, revisions] of byDraft) {
    const latest = revisions[revisions.length - 1]!;
    const semantic = JSON.parse(latest.semantic_json) as SemanticReview;
    const security = JSON.parse(latest.security_json) as SecurityReview;
    items.push({
      draft_id: draftId,
      latest_revision_id: latest.id,
      latest_revision: latest.revision,
      revisions: revisions.length,
      capture_id: latest.capture_id,
      title: (JSON.parse(latest.content_json) as DraftContent).title,
      content_digest: latest.content_digest,
      semantic_status: semantic.status,
      semantic_blocking: semantic.blocking_count,
      security_blocking: security.blocking_count,
      created_at_ms: revisions[0]!.server_at_ms,
    });
  }
  items.sort((a, b) => (a.draft_id < b.draft_id ? -1 : a.draft_id > b.draft_id ? 1 : 0));
  return { items };
}

export function getDraft(db: Db, auth: AuthContext, draftId: unknown, revisionId?: unknown): DraftDetail {
  const id = requireDraftId(draftId);
  const all = db
    .prepare("SELECT * FROM draft_revisions WHERE draft_id=? AND workspace_id=? ORDER BY revision")
    .all(id, auth.workspace_id) as RevisionRow[];
  if (all.length === 0) throw new ApiError("NOT_FOUND", `no draft ${id}`);
  let chosen = all[all.length - 1]!;
  if (revisionId !== undefined && revisionId !== null) {
    if (typeof revisionId !== "string") throw new ApiError("INVALID_SCHEMA", "revision_id must be a string");
    const found = all.find((r) => r.id === revisionId);
    if (found === undefined) throw new ApiError("NOT_FOUND", `no revision ${revisionId} of draft ${id}`);
    chosen = found;
  }
  return {
    draft_id: id,
    revision: viewOf(chosen),
    lineage: all.map((r) => ({
      revision_id: r.id,
      revision: r.revision,
      parent_revision_id: r.parent_revision_id,
      origin: r.origin,
      content_digest: r.content_digest,
      created_at_ms: r.server_at_ms,
    })),
  };
}

export function draftAudit(db: Db, auth: AuthContext, draftId: unknown): DraftAuditResponse {
  const latest = latestRevisionRow(db, auth, draftId);
  const rows = db
    .prepare("SELECT * FROM draft_events WHERE draft_id=? OR capture_id=? ORDER BY server_at_ms, id")
    .all(latest.draft_id, latest.capture_id) as Array<Record<string, unknown>>;
  return {
    draft_id: latest.draft_id,
    items: rows.map((r) => ({
      event_id: r.id as string,
      event: r.event as string,
      draft_id: (r.draft_id as string | null) ?? null,
      draft_revision_id: (r.draft_revision_id as string | null) ?? null,
      capture_id: r.capture_id as string,
      actor_agent_id: r.actor_agent_id as string,
      actor_role: r.actor_role as string,
      source: r.source as string,
      correlation_ref: (r.correlation_ref as string | null) ?? null,
      reason_code: (r.reason_code as string | null) ?? null,
      result: r.result as string,
      content_digest: (r.content_digest as string | null) ?? null,
      provenance: JSON.parse(r.provenance_json as string),
      server_at_ms: r.server_at_ms as number,
    })),
  };
}
