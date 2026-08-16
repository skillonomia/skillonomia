// V1 P1 — THE DRAFT COMPILER, AND THE TWO PREVIEWS AN OWNER READS.
//
// A capture is text. A DRAFT is that text compiled into named sections a person
// can review and a later phase can assign, version and load. This module is the
// compiler and the two structured reviews that come with every compilation:
//
//   * `compileDraft`  — text → the ten canonical sections;
//   * `contentDigest` — the same normalised input at the same compiler version
//                       always digests the same, which is what makes a revision
//                       identifiable rather than merely stored;
//   * `semanticReview`— what is missing, contradictory or unexecutable;
//   * `securityReview`— what the procedure asks for and what it does that is
//                       worth a second look.
//
// THE SECTIONS ARE A CLOSED LIST and every draft has all of them. A section the
// source did not supply is EMPTY and is reported as missing by the semantic
// review — it is never filled in with a plausible sentence, because an owner
// approving a draft is approving what the capture actually said, and a compiler
// that writes the missing half is the fastest way to an approved skill nobody
// wrote.
//
// WHAT IT REUSES. Risk classification comes from `src/gates.ts` — the shell
// severity table, the privilege-escalation and wrapper name tables, the URL
// denylist and the prompt-injection patterns are this registry's published
// answers about dangerous content (SPEC Appendix G), and a second opinion in
// this file would be a second answer. What this module adds is the reading of
// a PROSE PROCEDURE rather than of a packaged file.
import { createHash } from "node:crypto";
import { jcsCanonicalize, type JcsValue } from "./jcs.ts";
import {
  INJECTION_PATTERNS,
  PRIVILEGE_ESCALATORS,
  SHELL_SEVERITY,
  URL_DENYLIST,
  extractUrls,
  canonicalHost,
} from "./gates.ts";
import { stepLines } from "./skillability.ts";
import type { RedactionFinding } from "./redaction.ts";

/** The compiler's identity. It is part of the digest input, so a change here
 *  changes every digest — which is the point: two drafts that agree on content
 *  but were produced by different compilers are not the same object. */
export const COMPILER_VERSION = "skln-compile-1";

/** The canonical sections, in the order a draft presents them. */
export const DRAFT_SECTIONS = [
  "purpose",
  "when_to_use",
  "procedure",
  "inputs",
  "outputs",
  "permissions",
  "dependencies",
  "failure_modes",
  "redactions",
  "provenance",
] as const;
export type DraftSection = (typeof DRAFT_SECTIONS)[number];

export interface DraftProvenance {
  source_kind: "workflow" | "session" | "native_skill";
  source_format: "workflow_text" | "agent_session" | "claude_code_skill" | "codex_skill";
  /** the session id, file path or title the capture named, after redaction */
  source_ref: string | null;
  /** digest of the REDACTED normalised source this draft was compiled from */
  source_digest: string;
}

/**
 * How many findings of one list a stored preview LISTS.
 *
 * The three JSON columns of a revision are bounded (`migrations/0013`), and the
 * lists below are the only fields of a draft whose length is decided by the
 * SOURCE rather than by the schema: one redaction finding per credential, one
 * semantic finding per bad line, one risky action per risky line. A capture
 * inside the published input bound can carry a thousand of each, and P1
 * BUILD-1 answered that with `500 INTERNAL` after the arrival was already
 * written — finding `P1-R1-002`.
 *
 * So the LIST is capped and the COUNT is not. `blocking_count` and every
 * `*_total` are computed over the whole set before the cap applies, so nothing
 * that decides whether a draft may be approved is affected by how much of the
 * detail an owner can read. This is the narrowing contract section 8.10 permits
 * rather than a rebuild of the bounded column: the bound is a `CHECK` on a
 * table that already holds rows, and widening it is a table rebuild, which is
 * neither additive nor reversible.
 */
export const MAX_LISTED_FINDINGS = 200;

/**
 * The `MAX_LISTED_FINDINGS` findings WORTH READING, and how many there really
 * were.
 *
 * WHY THE ORDER IS NOT SOURCE ORDER ANY MORE. The counts were always honest —
 * `blocking_count` and every `*_total` are computed over the whole set — so a
 * capture with two hundred unpinned installs on lines 1..200 and one `rm -rf`
 * on line 201 was never approvable. But the LIST an owner reads held two
 * hundred warnings and not the destructive command, which is the one finding
 * the window existed to show. So the listed window is filled by priority first
 * and by source order within a priority.
 *
 * `rank` is the caller's, because severity is spelled differently in the two
 * lists it applies to (`blocking`/`advisory`, `fail`/`warn`) and a shared
 * vocabulary would be a third one to keep in step. A list with no priority —
 * the redactions, where every finding is one credential and none outranks
 * another — passes no `rank` and keeps source order exactly as before.
 *
 * The sort is stable (ES2019), so two findings of one rank stay in the order
 * the reviewer produced them, which is the order of the source.
 */
export function capFindings<T>(all: readonly T[], rank?: (item: T) => number): { listed: T[]; total: number } {
  const ordered = rank === undefined ? all : [...all].sort((a, b) => rank(a) - rank(b));
  return { listed: ordered.slice(0, MAX_LISTED_FINDINGS), total: all.length };
}

export interface DraftContent {
  title: string;
  purpose: string;
  when_to_use: string;
  procedure: string[];
  inputs: string[];
  outputs: string[];
  permissions: string[];
  dependencies: string[];
  failure_modes: string[];
  redactions: RedactionFinding[];
  /** how many pieces of credential material were removed in total — never
   *  smaller than `redactions.length`, and larger when the list was capped */
  redactions_total: number;
  provenance: DraftProvenance;
}

export interface SemanticFinding {
  code: string;
  section: DraftSection | "document";
  severity: "blocking" | "advisory";
  detail: string;
  /** 1-based line of the redacted source, where the finding is about one */
  line: number | null;
}

export interface SemanticReview {
  status: "complete" | "incomplete";
  /** true when no finding is blocking — the field P2's approve gate reads */
  blocking_count: number;
  missing_sections: DraftSection[];
  findings: SemanticFinding[];
  /** how many findings there were before the list was capped */
  findings_total: number;
  compiler_version: string;
}

export interface RiskyAction {
  code: string;
  severity: "fail" | "warn";
  detail: string;
  line: number | null;
}

export interface SecurityReview {
  requested_permissions: string[];
  dependencies: string[];
  risky_actions: RiskyAction[];
  /** how many risky actions there were before the list was capped */
  risky_actions_total: number;
  /** category, location and reason of everything redaction removed — never the
   *  value. The preview an owner reads is this list. */
  redactions: RedactionFinding[];
  /** how many pieces of material were removed before the list was capped */
  redactions_total: number;
  blocking_count: number;
  compiler_version: string;
}

// --------------------------------------------------------------- extraction

/** The body of a `## <name>` section, up to the next heading of any level. */
function sectionBody(text: string, names: readonly string[]): string {
  const lines = text.split("\n");
  const heading = new RegExp(`^#{1,6}\\s*(?:${names.join("|")})\\b\\s*:?\\s*$`, "i");
  const anyHeading = /^#{1,6}\s+\S/;
  for (let i = 0; i < lines.length; i += 1) {
    if (!heading.test(lines[i]!.trim())) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (anyHeading.test(lines[j]!)) break;
      body.push(lines[j]!);
    }
    return body.join("\n").trim();
  }
  return "";
}

/** List items of a block: bulleted, numbered, or one item per line. */
function listItems(body: string): string[] {
  if (body.length === 0) return [];
  return body
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/** The first non-empty paragraph that is not a heading. */
function firstParagraph(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^#{1,6}\s+\S/.test(line) || /^---$/.test(line)) {
      if (out.length > 0) break;
      continue;
    }
    if (line.length === 0) {
      if (out.length > 0) break;
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(raw)) break;
    out.push(line);
  }
  return out.join(" ").trim();
}

const INSTALL_RE = /\b(?:npm (?:i|install|ci)|pnpm add|yarn add|pip install|pip3 install|apt-get install|apt install|brew install|cargo install|go install|gem install)\s+([A-Za-z0-9@._/-]+)/gi;
const REQUIRES_RE = /\brequires?\s+`([^`\n]{1,60})`/gi;

function derivedDependencies(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(INSTALL_RE)) out.add(m[1]!);
  for (const m of text.matchAll(REQUIRES_RE)) out.add(m[1]!.trim());
  return [...out];
}

/** `allowed-tools:` is Claude Code's own declaration; a `## Permissions`
 *  section is what a prose procedure writes instead. Both are the AUTHOR's
 *  request, and neither is a grant. */
function declaredPermissions(text: string): string[] {
  const out = new Set<string>();
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  if (frontmatter !== null) {
    const line = /^allowed-tools\s*:\s*(.+)$/im.exec(frontmatter[1]!);
    if (line !== null) {
      for (const part of line[1]!.split(",")) {
        const value = part.trim().replace(/^\[|\]$/g, "").trim();
        if (value.length > 0) out.add(value);
      }
    }
  }
  for (const item of listItems(sectionBody(text, ["permissions", "required permissions", "access"]))) out.add(item);
  return [...out];
}

function titleOf(text: string, fallback: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  if (frontmatter !== null) {
    const name = /^name\s*:\s*(.+)$/im.exec(frontmatter[1]!);
    if (name !== null) return name[1]!.trim();
  }
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading !== null) return heading[1]!.trim();
  return fallback;
}

function descriptionOf(text: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  if (frontmatter === null) return "";
  const description = /^description\s*:\s*(.+)$/im.exec(frontmatter[1]!);
  return description === null ? "" : description[1]!.trim();
}

/** The body with any YAML frontmatter removed — the prose a reader sees. */
function withoutFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

export interface CompileInput {
  /** the REDACTED normalised source. Nothing else is ever passed here. */
  text: string;
  provenance: DraftProvenance;
  redactions: readonly RedactionFinding[];
  /** the title to fall back on when the source states none */
  fallbackTitle: string;
}

/**
 * Compile one redacted capture into the canonical sections.
 *
 * Every section is derived from the source and nothing is invented. Where a
 * source states a section explicitly — a heading, a frontmatter key — that
 * statement wins; otherwise a narrow derivation applies (the first paragraph is
 * the purpose, the step lines are the procedure), and where neither produces
 * anything the section is empty and the semantic review says so.
 */
export function compileDraft(input: CompileInput): DraftContent {
  const text = input.text;
  const body = withoutFrontmatter(text);
  const description = descriptionOf(text);

  const purposeSection = sectionBody(body, ["purpose", "what this does", "goal", "summary", "why this exists"]);
  const whenSection = sectionBody(body, ["when to use", "when to use it", "trigger", "triggers", "use when", "applies when"]);
  const procedureSection = sectionBody(body, ["procedure", "steps", "how to", "instructions", "workflow"]);

  const procedureSource = procedureSection.length > 0 ? procedureSection : body;
  const procedure = stepLines(procedureSource).map((s) => s.text);

  const purpose = purposeSection.length > 0 ? firstParagraph(purposeSection) : description.length > 0 ? description : firstParagraph(body);
  const whenToUse =
    whenSection.length > 0
      ? firstParagraph(whenSection)
      : (/^.*\b(?:whenever|every time|each time|use this when|any time you)\b.*$/im.exec(body)?.[0] ?? "").trim();

  return {
    title: titleOf(text, input.fallbackTitle),
    purpose,
    when_to_use: whenToUse,
    procedure,
    inputs: listItems(sectionBody(body, ["inputs", "input", "parameters", "arguments"])),
    outputs: listItems(sectionBody(body, ["outputs", "output", "result", "results", "deliverable"])),
    permissions: declaredPermissions(text),
    dependencies: [...new Set([...listItems(sectionBody(body, ["dependencies", "requirements", "prerequisites"])), ...derivedDependencies(body)])],
    failure_modes: listItems(sectionBody(body, ["failure modes", "failures", "troubleshooting", "when it fails", "errors"])),
    redactions: capFindings(input.redactions).listed,
    redactions_total: input.redactions.length,
    provenance: input.provenance,
  };
}

// ------------------------------------------------------------------ digest

/**
 * The content digest: `sha256:<hex>` over the JCS canonicalization of the
 * compiler version and the content together.
 *
 * JCS is already this registry's canonical form for anything that gets hashed
 * (`src/jcs.ts`, SPEC §4.2), so key order, unicode escaping and number form are
 * decided in one place rather than by whatever `JSON.stringify` did today. No
 * identifier and no timestamp enters this function: a digest that moved because
 * a row got a new ULID would identify the row and not the content, and
 * recompiling the same input would then never converge.
 */
export function contentDigest(content: DraftContent, compilerVersion: string = COMPILER_VERSION): string {
  const canonical = jcsCanonicalize({ compiler_version: compilerVersion, content } as unknown as JcsValue);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------- semantic review

const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|XXX)\b|\?{3,}|<[a-z][a-z _-]{1,30}>|\$\{[a-z_][a-z0-9_]*\}/i;
const PROHIBITION = /\b(?:never|do not|don't|must not)\s+([a-z]+(?:\s+[a-z]+){0,2})/gi;

/** Words that carry no action, so a "step" made only of them cannot be run. */
const UNEXECUTABLE = /^(?:etc\.?|and so on|the usual|as needed|as appropriate|same as (?:above|before))\.?$/i;

const REQUIRED_SECTIONS: readonly DraftSection[] = ["purpose", "when_to_use", "procedure"];
const ADVISORY_SECTIONS: readonly DraftSection[] = ["inputs", "outputs", "permissions", "dependencies", "failure_modes"];

function isEmptySection(content: DraftContent, section: DraftSection): boolean {
  const value = (content as unknown as Record<string, unknown>)[section];
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * What is missing, contradictory or unexecutable — as structured findings.
 *
 * `blocking` means an owner should not be able to approve this revision as it
 * stands, and P2's approve gate is what will read that count. `advisory` means
 * the draft is usable and thinner than it could be.
 */
export function semanticReview(content: DraftContent, source: string): SemanticReview {
  const findings: SemanticFinding[] = [];
  const missing: DraftSection[] = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!isEmptySection(content, section)) continue;
    missing.push(section);
    findings.push({
      code: "missing_section",
      section,
      severity: "blocking",
      detail: `the capture states no ${section.replace(/_/g, " ")}, and a draft cannot be reviewed without one`,
      line: null,
    });
  }
  for (const section of ADVISORY_SECTIONS) {
    if (!isEmptySection(content, section)) continue;
    missing.push(section);
    findings.push({
      code: "missing_section",
      section,
      severity: "advisory",
      detail: `the capture states no ${section.replace(/_/g, " ")}`,
      line: null,
    });
  }
  if (content.procedure.length === 1) {
    findings.push({
      code: "single_step_procedure",
      section: "procedure",
      severity: "blocking",
      detail: "one step is an instruction rather than a procedure",
      line: null,
    });
  }

  // a step number written twice: the source disagrees with itself about order
  const ordinals = new Map<string, number>();
  source.split("\n").forEach((raw, i) => {
    const m = /^\s*(?:(\d+)[.)]|step\s+(\d+)\s*[:.)])\s+\S/i.exec(raw);
    if (m === null) return;
    const n = (m[1] ?? m[2])!;
    const seen = ordinals.get(n);
    if (seen === undefined) {
      ordinals.set(n, i + 1);
      return;
    }
    findings.push({
      code: "duplicate_step_ordinal",
      section: "procedure",
      severity: "blocking",
      detail: `step ${n} is numbered twice, on lines ${seen} and ${i + 1}, so the order of the procedure is not stated`,
      line: i + 1,
    });
  });

  // a prohibition that one of the steps then performs
  const prohibited = new Map<string, number>();
  source.split("\n").forEach((raw, i) => {
    for (const m of raw.matchAll(PROHIBITION)) {
      const phrase = m[1]!.toLowerCase().replace(/\s+/g, " ").trim();
      if (phrase.length >= 3 && !prohibited.has(phrase)) prohibited.set(phrase, i + 1);
    }
  });
  for (const step of stepLines(source)) {
    const normalised = step.text.toLowerCase().replace(/\s+/g, " ");
    for (const [phrase, at] of prohibited) {
      if (!normalised.startsWith(phrase)) continue;
      findings.push({
        code: "contradictory_directive",
        section: "procedure",
        severity: "blocking",
        detail: `line ${at} forbids "${phrase}" and the step on line ${step.line} does it`,
        line: step.line,
      });
    }
  }

  // a step that cannot be carried out as written
  for (const step of stepLines(source)) {
    if (UNEXECUTABLE.test(step.text.trim())) {
      findings.push({
        code: "unexecutable_step",
        section: "procedure",
        severity: "blocking",
        detail: `the step on line ${step.line} names no action`,
        line: step.line,
      });
      continue;
    }
    const placeholder = PLACEHOLDER.exec(step.text);
    if (placeholder === null) continue;
    const declared = content.inputs.some((i) => i.toLowerCase().includes(placeholder[0]!.toLowerCase()));
    if (declared) continue;
    findings.push({
      code: "unresolved_placeholder",
      section: "procedure",
      severity: "blocking",
      detail: `the step on line ${step.line} carries a placeholder that no input declares`,
      line: step.line,
    });
  }

  // the counts are over the WHOLE set; only the listed detail is capped
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  // blocking findings fill the window first: what the list is FOR is the part
  // an owner has to act on
  const capped = capFindings(findings, (f) => (f.severity === "blocking" ? 0 : 1));
  return {
    status: blocking === 0 ? "complete" : "incomplete",
    blocking_count: blocking,
    missing_sections: missing,
    findings: capped.listed,
    findings_total: capped.total,
    compiler_version: COMPILER_VERSION,
  };
}

// ---------------------------------------------------------- security review

const DESTRUCTIVE = /\brm\s+-[a-z]*[rf][a-z]*\b|\bshred\b|\bmkfs\b|\bdd\s+if=|\bDROP\s+TABLE\b|\bgit\s+push\s+--force\b|\bgit\s+reset\s+--hard\b/i;
const UNPINNED = /\b(?:npm (?:i|install)|pip install|pip3 install)\s+(?!.*[@=]\d)[A-Za-z0-9@._/-]+/i;

/**
 * What the procedure asks for and what it does that deserves a second look.
 *
 * Every risk class here is one this registry already publishes: the shell
 * severity table and the privilege-escalation names of Appendix G.4, the URL
 * denylist of G.3, the prompt-injection patterns of G.5. A capture is prose
 * rather than a packaged file, so the reading is line-based — but the CLASSES
 * are the registry's own, and a value gate 5 refuses inside a package is a
 * risky action here.
 */
export function securityReview(content: DraftContent, source: string): SecurityReview {
  const risky: RiskyAction[] = [];
  const lines = source.split("\n");

  lines.forEach((raw, i) => {
    const line = raw.trim();
    const at = i + 1;
    for (const name of PRIVILEGE_ESCALATORS) {
      if (new RegExp(`(?:^|[\\s;|&(\`])${name}\\s`, "i").test(line)) {
        risky.push({
          code: "privilege_escalation",
          severity: "fail",
          detail: `the procedure runs \`${name}\`, which raises privilege`,
          line: at,
        });
        break;
      }
    }
    if (DESTRUCTIVE.test(line)) {
      risky.push({
        code: "destructive_command",
        severity: "fail",
        detail: "the procedure removes or overwrites data without a way back",
        line: at,
      });
    }
    for (const { id, re } of INJECTION_PATTERNS) {
      if (!re.test(line)) continue;
      risky.push({
        code: "prompt_injection_pattern",
        severity: "fail",
        detail: `the text carries the published prompt-injection pattern \`${id}\` (SPEC Appendix G.5)`,
        line: at,
      });
      break;
    }
    if (UNPINNED.test(line)) {
      risky.push({
        code: "unpinned_dependency",
        severity: "warn",
        detail: "a dependency is installed without a pinned version",
        line: at,
      });
    }
  });

  for (const url of extractUrls(source)) {
    let host = "";
    let scheme = "";
    try {
      const parsed = new URL(url);
      host = canonicalHost(parsed.hostname);
      scheme = parsed.protocol;
    } catch {
      continue;
    }
    const at = lines.findIndex((l) => l.includes(url));
    if (scheme !== URL_DENYLIST.allowedScheme) {
      risky.push({
        code: "insecure_url",
        severity: "fail",
        detail: `the procedure fetches over \`${scheme}\`, and the denylist admits only \`${URL_DENYLIST.allowedScheme}\` (SPEC Appendix G.3)`,
        line: at < 0 ? null : at + 1,
      });
      continue;
    }
    if (URL_DENYLIST.shortenerHosts.has(host) || URL_DENYLIST.rawIpHost.test(host)) {
      risky.push({
        code: "denylisted_url",
        severity: "fail",
        detail: "the procedure fetches from a URL shortener or a raw-IP host (SPEC Appendix G.3)",
        line: at < 0 ? null : at + 1,
      });
    }
  }

  if (content.redactions_total > 0) {
    risky.push({
      code: "credential_material_removed",
      severity: "warn",
      detail: `${content.redactions_total} piece(s) of credential material were removed from the source before it was stored`,
      line: content.redactions[0]?.line ?? null,
    });
  }

  // `fail` outranks `warn` in the listed window, for the reason `capFindings`
  // states: a destructive command behind two hundred unpinned installs is the
  // finding the window exists to show
  const cappedRisky = capFindings(risky, (r) => (r.severity === "fail" ? 0 : 1));
  return {
    requested_permissions: content.permissions,
    dependencies: content.dependencies,
    risky_actions: cappedRisky.listed,
    risky_actions_total: cappedRisky.total,
    redactions: content.redactions,
    redactions_total: content.redactions_total,
    blocking_count: risky.filter((r) => r.severity === "fail").length,
    compiler_version: COMPILER_VERSION,
  };
}

/** The severity vocabulary is the gate table's, not a second one. */
export const RISK_SEVERITIES = [...new Set(SHELL_SEVERITY.map((s) => s.severity))] as readonly string[];
