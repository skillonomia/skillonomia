// V1 P1 — REDACTION AT THE BOUNDARY, BEFORE ANYTHING IS STORED.
//
// A capture arrives as text somebody wrote in a terminal or a chat window, and
// the one thing that text reliably contains eventually is a credential. The
// contract's rule is exact: redaction happens BEFORE the draft, the audit, the
// logs and the evidence are written, and no raw secret value is persisted.
//
// So this module is a FUNCTION AT THE BOUNDARY and not a filter somewhere in
// the middle. `src/capture.ts` calls it on the normalised input and passes only
// the result onwards; every later stage — classifier, compiler, previews,
// storage, audit — sees the redacted text and has no access to the original.
// The original is never assigned to a variable that outlives the call.
//
// WHAT IT REUSES, AND WHY IT MUST. `src/gates.ts` already carries this
// registry's answer to "what does a key look like" — `SECRET_PATTERNS` (which
// Appendix G.1 publishes verbatim) and `isHighEntropyToken` (Appendix G.2).
// Package gate 2 scans a published package with those. A second, differently
// worded idea of a secret living in this file would mean a value that gate 2
// refuses could pass here, or the reverse, and the two would drift apart on
// their own schedules. So the patterns come from there, and what this module
// adds is the shapes that appear in PROSE rather than in a packaged file: an
// assignment (`api_key = …`), an authorization header, a URL with credentials
// in it, and a PEM block spanning lines.
//
// WHAT A FINDING MAY CARRY. Category, location and reason — never the value,
// never a prefix of it, and never a digest of it. A digest would be a stable
// identifier for the secret, which is most of what an attacker wanted from it,
// and the preview has no question that needs one. `removed_characters` is the
// length of what was taken out, which tells an owner that something substantial
// was removed without telling anybody what.
import { SECRET_PATTERNS, isHighEntropyToken } from "./gates.ts";

/** The kinds of material this module removes. The value is what a preview
 *  shows an owner, so it is a category and not a pattern name. */
export const REDACTION_CATEGORIES = [
  "api_key",
  "token",
  "private_key",
  "password",
  "credential_in_url",
  "high_entropy_value",
] as const;
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];

/**
 * WHERE A FINDING CAME FROM, AS A FIELD RATHER THAN AS A SENTENCE.
 *
 * The body of a capture is `source`; the two metadata fields that travel with
 * it are `title` and `source_ref`; an owner's edit names the section it changed
 * as `sections.<name>`. The vocabulary is open at exactly that last point,
 * because the sections are the compiler's and are enumerated there.
 *
 * INV-05 is why this is a column of the finding and not a phrase inside
 * `reason`: a consumer deciding "which field do I show this next to" was
 * parsing `in the capture title: …` out of prose. The prose stays, as display.
 */
export const REDACTION_SOURCE_BODY = "source";

export interface RedactionFinding {
  /** what kind of material was removed */
  category: RedactionCategory;
  /** which field of the request the material was removed from — `source`,
   *  `title`, `source_ref` or `sections.<name>`. Structured, and never derived
   *  by reading `reason`. */
  source_field: string;
  /** which detector fired — the id of the pattern, never the value it matched */
  detector: string;
  /** 1-based line of the NORMALISED SOURCE the material was removed from */
  line: number;
  /** 1-based column of the same */
  column: number;
  /** how many characters were removed. Not the value, and not a prefix of it. */
  removed_characters: number;
  /** why this was treated as a secret, in words an owner can act on */
  reason: string;
}

export interface RedactionResult {
  /** the text with every finding replaced by a `⟦REDACTED:<category>⟧` token */
  text: string;
  findings: RedactionFinding[];
}

interface Hit {
  start: number;
  end: number;
  category: RedactionCategory;
  detector: string;
  reason: string;
}

/** The prose shapes, the ones a packaged file rarely has and a transcript
 *  always does. Group 1 of each is the material to remove. */
const PROSE_PATTERNS: ReadonlyArray<{
  id: string;
  category: RedactionCategory;
  re: RegExp;
  reason: string;
}> = [
  {
    id: "pem-block",
    category: "private_key",
    re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g,
    reason: "a PEM private-key block was pasted into the source",
  },
  {
    id: "authorization-header",
    category: "token",
    re: /(?:authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?([^\s"'`,;]{8,})/gi,
    reason: "an Authorization header value is a live credential",
  },
  {
    id: "bearer-token",
    category: "token",
    re: /\bbearer\s+([A-Za-z0-9._~+/=-]{12,})/gi,
    reason: "a bearer token is a live credential",
  },
  {
    id: "assigned-secret",
    category: "api_key",
    re: /\b(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token)\s*[:=]\s*["'`]?([^\s"'`,;]{6,})["'`]?/gi,
    reason: "a value assigned to a key-named field is treated as the key itself",
  },
  {
    id: "assigned-password",
    category: "password",
    // `is` as well as `:` and `=`, because a transcript says "the password is
    // hunter2" far more often than it says "password=hunter2", and a rule that
    // only knew the second form left the first in the database.
    re: /\b(?:password|passwd|passphrase)\s*(?:[:=]|\bis\b)\s*["'`]?([^\s"'`,;]{4,})["'`]?/gi,
    reason: "a password written next to its name is a password",
  },
  {
    id: "credential-in-url",
    category: "credential_in_url",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]+)@/gi,
    reason: "a URL carrying a password in its userinfo",
  },
];

/** `⟦REDACTED:<category>⟧` — the token `src/gates.ts` already defines, so a
 *  redacted capture reads to the package secret scan exactly as a redacted
 *  package does. */
function token(category: RedactionCategory): string {
  return `⟦REDACTED:${category}⟧`;
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: offset - lastBreak };
}

/** Every token of the text that is long enough for the entropy heuristic to
 *  have an opinion about. Splitting on whitespace and on the punctuation that
 *  surrounds a value in prose — a quoted key is still one token. */
function highEntropyHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{40,}/g)) {
    if (!isHighEntropyToken(m[0])) continue;
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      category: "high_entropy_value",
      detector: "high-entropy-token",
      reason: "a long, charset-diverse, high-entropy string: the shape of key material rather than of prose",
    });
  }
  return hits;
}

function patternHits(text: string): Hit[] {
  const hits: Hit[] = [];
  // Appendix G.1's patterns, which gate 2 applies to a packaged file. They are
  // declared without `g`, so they are recompiled here rather than mutated:
  // `lastIndex` is per-object state and sharing it across callers would make
  // one scan depend on the previous one.
  for (const { id, re } of SECRET_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        category: id === "pem-private-key" ? "private_key" : id === "jwt" ? "token" : "api_key",
        detector: id,
        reason: `matches the published key-like pattern \`${id}\` (SPEC Appendix G.1)`,
      });
    }
  }
  for (const { id, category, re, reason } of PROSE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[1];
      if (value === undefined || value.length === 0) continue;
      // the whole match is the sentence; only the VALUE is removed, so the
      // preview can still say which field carried it
      const start = m.index + m[0].lastIndexOf(value);
      hits.push({ start, end: start + value.length, category, detector: id, reason });
    }
  }
  return hits;
}

/**
 * Remove every piece of credential material and report what was removed.
 *
 * Overlapping hits are merged into the FIRST one that starts, extended to the
 * furthest end: a JWT that is also a high-entropy token is one secret and must
 * leave one token behind, not two nested ones. The findings are returned in
 * source order, which is the order an owner reads them in.
 */
export function redact(text: string, sourceField: string = REDACTION_SOURCE_BODY): RedactionResult {
  const hits = [...patternHits(text), ...highEntropyHits(text)].sort((a, b) =>
    a.start === b.start ? b.end - a.end : a.start - b.start,
  );
  const merged: Hit[] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last !== undefined && hit.start < last.end) {
      if (hit.end > last.end) last.end = hit.end;
      // THE MORE SPECIFIC DETECTOR WINS THE LABEL. The entropy heuristic often
      // matches a longer span than the pattern inside it — `session-ghp_…` is
      // one token to it — and reporting that as `high_entropy_value` would tell
      // an owner less than the tree already knows. The span stays the union;
      // the category and the reason become the named pattern's.
      if (last.category === "high_entropy_value" && hit.category !== "high_entropy_value") {
        last.category = hit.category;
        last.detector = hit.detector;
        last.reason = hit.reason;
      }
      continue;
    }
    merged.push({ ...hit });
  }
  const findings: RedactionFinding[] = [];
  let out = "";
  let cursor = 0;
  for (const hit of merged) {
    out += text.slice(cursor, hit.start) + token(hit.category);
    const at = lineAndColumn(text, hit.start);
    findings.push({
      category: hit.category,
      source_field: sourceField,
      detector: hit.detector,
      line: at.line,
      column: at.column,
      removed_characters: hit.end - hit.start,
      reason: hit.reason,
    });
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return { text: out, findings };
}

/**
 * A short reference — a session id, a file path — redacted the same way.
 *
 * A reference is stored in its own column and in the audit's correlation field,
 * so it goes through the same rule as the body: a "session id" that is really a
 * signed URL with a token in it must not become the one field that kept it.
 */
export function redactReference(ref: string): string {
  return redact(ref).text;
}
