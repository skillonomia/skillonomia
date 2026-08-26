// §7.1 lint gates — all 8 deterministic gates, run on `skill.lint` (P2
// surface 2) and re-run on `skill.verify` when that transition lands in P4.
// Gate names and result values are the DDL enums of `lint_reports`. Severity
// decisions live in exported tables (SHELL_SEVERITY, URL_DENYLIST,
// SECRET_PATTERNS, INJECTION_PATTERNS, STALENESS_POLICY) so the review
// subject "severity tables" is data, not prose.
//
// Determinism: no gate touches the network or the host environment. The
// staleness gate (7) evaluates against the committed STALENESS_POLICY table
// plus the caller's clock — the "policy window" clause is data-driven because
// a deterministic offline gate cannot discover release dates on its own.
import { validateManifest } from "./manifest.ts";
import type { PackageFiles } from "./archive.ts";

/** DDL enum lint_reports.gate, in §7.1 order. */
export type GateName =
  | "schema"
  | "secrets"
  | "pinning"
  | "urls"
  | "shell"
  | "injection"
  | "staleness"
  | "compat";

/** The §7.1 gate set, in order. A lint run is COMPLETE iff it covers all of these. */
export const GATE_NAMES: readonly GateName[] = [
  "schema", "secrets", "pinning", "urls", "shell", "injection", "staleness", "compat",
];

export interface GateReport {
  gate: GateName;
  result: "pass" | "fail" | "warn";
  details: string | null;
}

export interface GateContext {
  /** server clock (injected — tests pin it; staleness window is relative to it) */
  nowMs: number;
}

export type GateFn = (manifest: any, files: PackageFiles, ctx: GateContext) => GateReport;

// ---------------------------------------------------------------------------
// §7.1.2 structured-redaction convention (defect #7 inverted): evidence
// redacted as ⟦REDACTED:type⟧ passes the secret scan; the raw value fails it.
// Redaction tokens are stripped BEFORE scanning so the token itself can never
// trip a pattern, and their presence is never a finding.
// ---------------------------------------------------------------------------
export const REDACTION_RE = /⟦REDACTED:[a-z0-9_-]{1,32}⟧/g;

/**
 * A redaction token stands in for removed material, so scanning must consider
 * BOTH readings of the surrounding text: the token as a separator (its normal
 * use) and the token as if it were never there (concatenating its neighbours).
 * Scanning only the separator reading let an attacker split raw secret
 * material with a token — `AKIA⟦REDACTED:x⟧IOSFODNN7EXAMPLE` — and hide it
 * from every pattern (P3 verdict 1, blocking #2). A gate hit in EITHER
 * reading is a finding; a genuine redaction hits in neither.
 */
export function redactionReadings(text: string): [string, string] {
  return [text.replace(REDACTION_RE, " "), text.replace(REDACTION_RE, "")];
}

/** The separator reading — kept as the documented convention helper. */
export function stripRedactions(text: string): string {
  return text.replace(REDACTION_RE, " ");
}

/** §7.1.2 key-like patterns. Order matters only for reporting. */
export const SECRET_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "github-token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

/** Shannon entropy in bits per character. */
function entropyBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * High-entropy secret heuristic: ≥40 chars of base64-ish charset, NOT pure
 * hex (integrity/trace hashes are legitimate manifest content), charset-
 * diverse, entropy ≥ 4.5 bits/char. Random base64 material sits well above
 * this; prose and identifiers sit well below.
 */
export function isHighEntropyToken(token: string): boolean {
  if (token.length < 40) return false;
  if (/^[0-9a-fA-F]+$/.test(token)) return false;
  let classes = 0;
  if (/[a-z]/.test(token)) classes++;
  if (/[A-Z]/.test(token)) classes++;
  if (/[0-9]/.test(token)) classes++;
  if (/[+/=_-]/.test(token)) classes++;
  if (classes < 3) return false;
  return entropyBitsPerChar(token) >= 4.5;
}

// §7.1.4 denylist: raw-IP hosts, URL shorteners, non-TLS — FAIL regardless of
// the allowlist.
export const URL_DENYLIST = {
  shortenerHosts: new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "ow.ly", "buff.ly", "rb.gy"]),
  rawIpHost: /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])$/,
  /** the ONLY non-denied scheme: anything else (http, ftp, file, gopher…) FAILs */
  allowedScheme: "https:",
} as const;

// A URL CANDIDATE is `scheme:body` whose body LOOKS like a locator. The scheme
// itself is never enumerated (§7.1, gate 4: "Enumerating the hundreds of IANA
// schemes is not attempted") — `news:`, `tel:`, `ldap:` and any future scheme
// are candidates on the strength of their body alone. The shape test exists
// for the other half of the same decision: breaking a safe
// scenario without cause is a defect too, and prose glues colons to words
// ("Warning:see the docs"). Bodies that mark a locator: an authority (`//`),
// a path/host/query/user/fragment character, or a phone-style number. The
// WHATWG "special schemes" — a closed six-element list defined by the URL
// standard, not an IANA enumeration — additionally make an opaque body
// (`ftp:payload`) a candidate.
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file"]);

const URL_CANDIDATE_RE = /(?<![A-Za-z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*):([^\s"'`<>\[\]{}]+)/g;

function looksLikeLocator(scheme: string, body: string): boolean {
  if (body.length === 0) return false;
  if (body.startsWith("//")) return true;
  if (/[/@?#]/.test(body)) return true;
  if (/\.[A-Za-z0-9]/.test(body)) return true; // host- or path-like dot
  if (/^\+?\d[\d\-()]*$/.test(body)) return true; // tel:+15551234567
  return SPECIAL_SCHEMES.has(scheme.toLowerCase());
}

/**
 * Every URL candidate in `text`. Overlapping spans are resolved by span, not
 * by string prefix: in `blob:https://evil.example/id` the outer token wins and
 * the inner one is dropped, so one address yields exactly one verdict.
 */
export function extractUrls(text: string): string[] {
  const spans: Array<{ start: number; end: number; url: string }> = [];
  for (const m of text.matchAll(URL_CANDIDATE_RE)) {
    const scheme = m[1];
    // The shape test reads everything up to the next whitespace, so a body
    // carrying quotes or parentheses (`javascript:fetch('/x')`) still counts,
    // while the extracted VALUE keeps the narrower charset — a markdown
    // `[t](https://x)` must not absorb its closing paren.
    const shape = text.slice(m.index! + scheme.length + 1).split(/\s/)[0] ?? "";
    if (!looksLikeLocator(scheme, shape)) continue;
    // trailing sentence punctuation is not part of the address
    const url = m[0].replace(/[.,;:!?)]+$/, "");
    if (url.length === 0) continue;
    spans.push({ start: m.index!, end: m.index! + url.length, url });
  }
  return spans
    .filter((s) => !spans.some((o) => o !== s && o.start <= s.start && o.end >= s.end && o.end - o.start > s.end - s.start))
    .map((s) => s.url);
}

/**
 * DNS host canonicalization before any host comparison: lowercase and drop the
 * trailing dot of a fully-qualified name. `bit.ly.` and `BIT.LY` resolve to the
 * same host as `bit.ly`, so they must meet the same denylist and the same
 * allowlist (P3 verdict 3, blocking #2).
 */
export function canonicalHost(host: string): string {
  // "drop ONE trailing dot" per §7.1's gate 4; a name with more than one
  // trailing dot is not a valid FQDN and stays as-is, so it can never
  // canonicalize onto an allowlisted host.
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * The gate-4 verdict for one URL candidate (§7.1, deny-by-default): admit ONLY
 * an HTTPS address that matches `url_allowlist` after host canonicalization.
 * Everything else fails — non-HTTPS scheme, raw-IP host, shortener, userinfo,
 * outside the allowlist — and a candidate that cannot be parsed safely fails
 * rather than being skipped.
 */
export function urlVerdict(
  url: string,
  where: string,
  allowlist: string[],
): Array<{ severity: "fail"; text: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [{ severity: "fail", text: `unparseable URL candidate in ${where}` }];
  }
  if (u.protocol !== URL_DENYLIST.allowedScheme) {
    return [{ severity: "fail", text: `non-HTTPS URL (${u.protocol}) in ${where}` }];
  }
  if (u.username !== "" || u.password !== "") {
    return [{ severity: "fail", text: `URL carries userinfo in ${where}` }];
  }
  const host = canonicalHost(u.hostname);
  if (host === "") return [{ severity: "fail", text: `URL without a host in ${where}` }];
  if (URL_DENYLIST.rawIpHost.test(host)) return [{ severity: "fail", text: `raw-IP URL in ${where}` }];
  if (URL_DENYLIST.shortenerHosts.has(host)) return [{ severity: "fail", text: `URL-shortener in ${where}` }];
  if (!urlAllowed(url, allowlist)) return [{ severity: "fail", text: `URL outside url_allowlist in ${where}` }];
  return [];
}

// §7.1.5 severity table: class id → severity. This is the spec's "severity
// table" as data; DETECTION of every class is structural (see shellFindings),
// because the ways a class can be written are unbounded while the class itself
// is not. Scan targets: scripts/ package files, manifest.procedure.scripts
// entries, and every steps[].command.
export const SHELL_SEVERITY: ReadonlyArray<{
  id: string;
  severity: "fail" | "warn";
}> = [
  { id: "curl-pipe-shell", severity: "fail" },
  { id: "sudo", severity: "fail" },
  { id: "rm-rf-variable-or-root", severity: "fail" },
  { id: "background-daemon", severity: "warn" },
  { id: "unquoted-expansion", severity: "warn" },
  // OD-2026-08-02-5: what the gate cannot read statically is a FAIL, because
  // the command that actually runs is only decided at run time.
  { id: "unparseable-command", severity: "fail" },
  { id: "unclassifiable-command-name", severity: "fail" },
  { id: "command-substitution", severity: "fail" },
  { id: "eval-or-source", severity: "fail" },
  { id: "interpreter-inline-code", severity: "fail" },
  { id: "piped-into-interpreter", severity: "fail" },
  { id: "control-construct", severity: "fail" },
];

function severityOf(id: string): "fail" | "warn" {
  return SHELL_SEVERITY.find((s) => s.id === id)!.severity;
}

export interface ShellWord {
  /** the word as written, quotes and escapes included */
  raw: string;
  /** the word with quotes and escapes resolved — what the shell would pass on */
  literal: string;
  /** only the characters that stayed UNQUOTED and UNESCAPED: the shell-active ones */
  active: string;
  /** contains a `$NAME`/`${NAME}` expansion anywhere, quoted or not */
  hasExpansion: boolean;
  /** contains an expansion outside quotes (the unsafe form) */
  hasUnquotedExpansion: boolean;
  /** contains `$(…)` or a backtick substitution — the value is another command */
  hasCommandSubstitution: boolean;
  /**
   * `literal` with every expansion/substitution START replaced by
   * {@link UNKNOWN_MARK}, so a caller can tell WHICH PART of the word is
   * statically known. `"$CMD"` is unknown throughout; in `$PREFIX/bin/rm` only
   * the directory is unknown and the command name `rm` still reads plainly.
   */
  skeleton: string;
  isFlag: boolean;
}

/** Stands in for text the shell would produce at run time — never a real char. */
export const UNKNOWN_MARK = "\u0000";

/** One simple command: its words plus the operator that ended it. */
export interface ShellSegment {
  words: ShellWord[];
  /** `|`, `&`, `&&`, `||`, `;` or null at end of input */
  terminator: string | null;
}

export interface ShellParse {
  segments: ShellSegment[];
  /** flattened words of every segment */
  words: ShellWord[];
  /** an unquoted `&` used as a separator (not `&&`, not part of a redirect) */
  hasBackgrounding: boolean;
  /** the input ended inside an open quote — it cannot be classified safely */
  unbalanced: boolean;
}

/**
 * Minimal POSIX-ish splitter: enough to decide the §7.1.5 classes from
 * structure rather than spelling (§7.1, gate 5 — "a full shell interpreter is
 * not built"). It tracks quoting per character, so the gate can tell
 * `"$TARGET"` from `$TARGET` and an ACTIVE glob (`?`, `*`, `[…]`) from a quoted
 * or escaped literal one; and it separates operators, so a pipeline is
 * only a pipeline when the `|` is outside quotes.
 */
export function parseShell(command: string): ShellParse {
  const segments: ShellSegment[] = [];
  let words: ShellWord[] = [];
  let hasBackgrounding = false;
  let raw = "";
  let literal = "";
  let active = "";
  let skeleton = "";
  let hasExpansion = false;
  let hasUnquotedExpansion = false;
  let hasCommandSubstitution = false;
  let quote: '"' | "'" | null = null;

  const flushWord = (): void => {
    if (raw.length > 0) {
      words.push({
        raw,
        literal,
        active,
        hasExpansion,
        hasUnquotedExpansion,
        hasCommandSubstitution,
        skeleton,
        isFlag: /^-/.test(raw),
      });
    }
    raw = "";
    literal = "";
    active = "";
    skeleton = "";
    hasExpansion = false;
    hasUnquotedExpansion = false;
    hasCommandSubstitution = false;
  };
  const flushSegment = (terminator: string | null): void => {
    flushWord();
    if (words.length > 0 || terminator !== null) segments.push({ words, terminator });
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") {
      const next = command[i + 1] ?? "";
      raw += ch + next;
      literal += next; // escaped: part of the value, never shell-active
      skeleton += next;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        let opensUnknown = false;
        if (ch === "$" && quote === '"' && /[A-Za-z_{]/.test(command[i + 1] ?? "")) {
          hasExpansion = true;
          opensUnknown = true;
        }
        // `$(…)` and backticks execute inside double quotes as well
        if (quote === '"' && ((ch === "$" && command[i + 1] === "(") || ch === "`")) {
          hasCommandSubstitution = true;
          opensUnknown = true;
        }
        literal += ch; // quoted: part of the value, never shell-active
        // quoting hides the expansion from word splitting, NOT from the shell:
        // `"$CMD"` still runs whatever CMD holds (P3 verdict 8)
        skeleton += opensUnknown ? UNKNOWN_MARK : ch;
      }
      raw += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      raw += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    if ((ch === "$" && command[i + 1] === "(") || ch === "`") {
      // `$(…)` / backticks: this word's value is whatever another command prints
      hasCommandSubstitution = true;
      raw += ch;
      literal += ch;
      active += ch;
      skeleton += UNKNOWN_MARK;
      continue;
    }
    if (ch === "$" && /[A-Za-z_{]/.test(command[i + 1] ?? "")) {
      hasExpansion = true;
      hasUnquotedExpansion = true;
      raw += ch;
      literal += ch;
      active += ch;
      skeleton += UNKNOWN_MARK;
      continue;
    }
    if (ch === "&") {
      const prev = command[i - 1] ?? "";
      const next = command[i + 1] ?? "";
      if (next === "&") {
        flushSegment("&&");
        i++;
        continue;
      }
      if (prev === ">" || prev === "<" || next === ">") {
        raw += ch; // redirect: `2>&1`, `<&0`, `&>file`
        literal += ch;
        active += ch;
        skeleton += ch;
        continue;
      }
      flushSegment("&");
      hasBackgrounding = true;
      continue;
    }
    if (ch === "|") {
      if ((command[i + 1] ?? "") === "|") {
        flushSegment("||");
        i++;
        continue;
      }
      // `>|` is the POSIX clobber-override REDIRECTION, not a pipe. Reading it
      // as a pipe split `>|out eval "$X"` into two segments and made `out` the
      // second one's command name, so the eval behind it was never classified —
      // the same hole as `!`, arriving through the tokenizer instead. Decided
      // exactly as the `&` redirect above is: by the preceding character.
      if ((command[i - 1] ?? "") === ">") {
        raw += ch;
        literal += ch;
        active += ch;
        skeleton += ch;
        continue;
      }
      flushSegment("|");
      continue;
    }
    if (ch === ";") {
      flushSegment(";");
      continue;
    }
    raw += ch;
    literal += ch;
    active += ch;
    skeleton += ch;
  }
  flushSegment(null);
  return {
    segments,
    words: segments.flatMap((s) => s.words),
    hasBackgrounding,
    unbalanced: quote !== null,
  };
}

/**
 * The command a segment runs, as a bare name: path-qualified invocations are
 * the same command (`/bin/rm` is `rm`, `/usr/bin/sudo` is `sudo`), and leading
 * `VAR=value` assignments are not the command (P3 verdict 4, blocking #3).
 */
export function segmentCommand(seg: ShellSegment): string {
  for (const w of seg.words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.literal)) continue; // env assignment
    const base = w.literal.split("/").pop() ?? "";
    return base;
  }
  return "";
}

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "csh", "ash", "busybox"]);
const FETCHERS = new Set(["curl", "wget", "fetch"]);
const DAEMONIZERS = new Set(["nohup", "setsid", "daemonize", "disown", "coproc"]);
/**
 * Commands that RUN another command; the wrapped one is the real one. `builtin`
 * and `coproc` are here because without them the chain stopped at the wrapper
 * and never saw what it ran — `builtin eval "$P"` and `coproc bash -c "$P"`
 * both passed (P3 verdict 9, minor).
 *
 * This is a NAME table, and a name table is never complete: a prefix wrapper
 * nobody listed still hides what it runs. That is a different kind of limit
 * from the two SYNTACTIC prefixes below — `!` and a redirection — which are
 * decided from the parse and therefore need no list at all. G.4 states both.
 */
export const WRAPPERS: ReadonlySet<string> = new Set([
  "env", "sudo", "doas", "nohup", "setsid", "time", "command", "exec", "nice", "ionice",
  "builtin", "coproc",
  // exec-wrappers that were missing, each of which hid every named class behind
  // itself exactly as `!` did: `timeout 5 sudo rm -rf /` classified as `timeout`
  "timeout", "stdbuf", "chroot", "taskset", "setarch", "unshare", "nsenter", "flock",
  "xargs", "runuser", "strace", "ltrace", "proxychains", "torify",
  // `pkexec [options] PROGRAM ARGS` runs a command word list exactly as `sudo`
  // does, and leaving it out hid every class behind it: `pkexec rm -rf /` was
  // classified as `pkexec` and passed the gate outright.
  "pkexec",
]);
/**
 * Commands that raise privilege HERE, on the machine running the step. They are
 * one severity class — the table calls it `sudo` after its most common member —
 * because they do one thing: run the rest of the command as another user.
 *
 * `su` is the case this set exists for. It was left out on the reasoning that
 * its payload rides in a `-c` STRING the gate does not read, but that argument
 * is about the payload and the class is about the escalation: a package that
 * takes root through `su` takes root exactly as one that takes it through
 * `sudo`, and the gate has to say so.
 *
 * The line is drawn at LOCAL execution, deliberately. `ssh host …` and
 * `docker run img …` also run a command elsewhere, and neither is this class:
 * what they run does not execute here, so this gate is not the thing that
 * decides it. That is a scope statement, not an oversight — G.4 records it.
 *
 * Like every name table in this file, this one cannot be complete.
 */
export const PRIVILEGE_ESCALATORS: ReadonlySet<string> = new Set([
  "sudo", "sudoedit", "su", "doas", "runuser", "pkexec",
]);
/**
 * The escalators whose command argument is an inline code STRING (`su root -c
 * '…'`, `runuser -u root -c '…'`): both hand the string to the target user's
 * login shell, which is exactly what `sh -c` does. Restricted to the two that
 * actually spell it `-c` — for `sudo`, BSD `-c` is a login class and reporting
 * inline code there would be a false statement about a line that already FAILs.
 */
const ESCALATOR_INLINE_CODE: ReadonlySet<string> = new Set(["su", "runuser"]);
/**
 * Wrappers whose command argument can sit BEHIND positional operands
 * (`timeout 5 CMD`, `flock /tmp/l CMD`). Listing them in WRAPPERS alone is not
 * enough: the operand is not a flag, so the chain stopped on it and the wrapped
 * command was never reached. Which operand is the command is per-wrapper
 * knowledge this gate does not model, so — exactly as for a wrapper FLAG — every
 * following word becomes a candidate.
 */
const OPERAND_WRAPPERS = new Set(["timeout", "flock", "chroot", "taskset", "setarch", "runuser"]);
/**
 * The POSIX reserved word `!` negates a pipeline's exit status. It is not a
 * command, it takes no arguments, and the pipeline behind it runs unchanged —
 * so treating it as a command name ended the chain and let EVERY named class
 * through (`! eval "$X"`, `! sudo rm -rf /` classified as nothing at all).
 * Only the bare, unquoted word is the reserved word: `'!'` and `\!` are an
 * ordinary command name.
 */
function isPipelineNegation(w: ShellWord): boolean {
  return w.active === "!" && w.literal === "!";
}
/**
 * A REDIRECTION at the head of a word: an optional fd number or `&`, then an
 * unquoted `<`/`>` operator. POSIX allows the redirection prefix ANYWHERE in a
 * simple command, the command word included — `>log eval "$X"` runs eval — so a
 * redirection is not a command name either and must not end the chain. The
 * operator has to be UNQUOTED to be one, which is why `active` decides it:
 * `'>'file` is an ordinary word.
 */
const REDIRECTION_RE = /^(\d*&?)(>>|>&|<&|<>|<<-?|>\||[<>])/;

/**
 * Is this word a redirection, and does its TARGET live in the next word? The
 * operator is found in `active` (unquoted) but measured against `literal`,
 * because a quoted target rides in the same word: `>"$OUT"` carries its own
 * target, `> "$OUT"` does not.
 */
function redirectionPrefix(w: ShellWord): { is: boolean; consumesNext: boolean } {
  if (!REDIRECTION_RE.test(w.active)) return { is: false, consumesNext: false };
  const m = REDIRECTION_RE.exec(w.literal);
  return { is: true, consumesNext: m === null || w.literal.length === m[0].length };
}
/** Runs code the gate never sees, so its content cannot be classified (OD-5). */
const EXECUTION_INDIRECTION = new Set(["eval", "source", "."]);
/** Shell words that open a construct whose execution the gate cannot follow. */
const CONTROL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "select", "function",
]);

/**
 * Every command a segment runs, outermost first: `env FOO=b /bin/rm -rf $D`
 * yields ["env", "rm"], so a wrapper cannot hide a named class behind itself
 * (P3 verdict 4, blocking #3). Each entry carries the index of its command
 * word, so flag/target scanning can anchor there.
 *
 * A word that is not a command word is SKIPPED rather than ended on: a
 * `VAR=value` assignment, the reserved word `!`, and a redirection. Ending on
 * one was the whole bug — the shell runs the command behind it unchanged, so
 * the gate has to read past it or the command is never classified at all.
 */
export function segmentCommandChain(
  seg: ShellSegment,
): Array<{ name: string; index: number; unknown: boolean }> {
  const chain: Array<{ name: string; index: number; unknown: boolean }> = [];
  let sawWrapperFlag = false;
  for (let i = 0; i < seg.words.length; i++) {
    const w = seg.words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.literal)) continue; // env assignment
    if (isPipelineNegation(w)) continue; // reserved word, transparent to the chain
    const redirect = redirectionPrefix(w);
    if (redirect.is) {
      // `> file cmd` spends two words on the redirection; `>file cmd` spends one
      if (redirect.consumesNext) i++;
      continue;
    }
    if (w.isFlag) {
      // Whether a wrapper flag consumes the NEXT word (`env -u FOO`, `nice -n 5`)
      // is per-wrapper knowledge this gate deliberately does not model. Rather
      // than guess and let the wrapped command hide behind the option's
      // argument (P3 verdict 5, blocking #2), every following word becomes a
      // command candidate — conservative, as §7.1's gate 5 requires.
      sawWrapperFlag = true;
      continue;
    }
    const name = w.literal.split("/").pop() ?? "";
    if (name === "") continue;
    // Only the NAME has to be statically known. `$PREFIX/bin/rm` is still rm;
    // `"$CMD"` or `/usr/bin/$TOOL` is whatever the variable holds, and quoting
    // does not change that (P3 verdict 8).
    const unknown = (w.skeleton.split("/").pop() ?? "").includes(UNKNOWN_MARK);
    chain.push({ name, index: i, unknown });
    if (unknown) break; // cannot even tell whether it is a wrapper
    if (!WRAPPERS.has(name) && !sawWrapperFlag) break;
    if (OPERAND_WRAPPERS.has(name)) sawWrapperFlag = true;
  }
  return chain;
}

/** Does this segment invoke a shell interpreter (possibly via env/sudo)? */
function invokesShell(seg: ShellSegment): boolean {
  return segmentCommandChain(seg).some((c) => SHELL_INTERPRETERS.has(c.name));
}

/**
 * A subshell, a brace group or a function definition — the gate cannot follow
 * what runs inside one (OD-5). The brace must be its OWN word to be a group:
 * `{ cmd; }` opens one, while `find … -exec rm {} \;` passes a placeholder and
 * `echo ${V}` is an expansion, neither of which is a construct.
 */
function isStructureWord(w: ShellWord): boolean {
  if (w.active === "{" || w.active === "}") return true;
  return w.active.startsWith("(") || w.active.endsWith(")");
}

/**
 * An interpreter given code inline: `sh -c '…'`, `bash -lc '…'`. Only flags of
 * the command ITSELF count, so `echo sh -c x` (sh as an argument) is untouched.
 */
function hasInlineCodeFlag(seg: ShellSegment, from: number): boolean {
  return seg.words
    .slice(from + 1)
    .some((w) => w.isFlag && (/^-[a-z]*c[a-z]*$/.test(w.literal) || w.literal === "--command"));
}

/** A destructive target: an expansion, the filesystem root, or an ACTIVE glob. */
function isDangerousTarget(word: ShellWord): boolean {
  if (word.hasExpansion || word.hasCommandSubstitution) return true;
  if (/^\/+$/.test(word.literal)) return true;
  return /[*?[]/.test(word.active); // quoted/escaped glob chars are literals
}

/**
 * Split a script into LOGICAL lines. A physical newline does not end a command
 * when the line ends in an operator that demands a continuation (`|`, `&&`,
 * `||`, `;`, a backslash) or when it ends inside an open quote — the shell
 * reads on, and so must the gate, or a pipeline written across two lines
 * escapes classification entirely (P3 verdict 5, blocking #3).
 */
/**
 * Remove `#` comments, honouring quotes and escapes across newlines. A comment
 * runs to the end of ITS line, so this is safe on a multi-line logical line and
 * on a whole script. Comment text is not code: leaving it in made
 * `curl … # illustrative: | sh` read as a real pipeline (P3 verdict 7,
 * blocking #2).
 */
export function stripComment(text: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") {
      out += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    // an unquoted `#` starts a comment only at the start of a word
    if (ch === "#" && (i === 0 || /[\s;|&(]/.test(text[i - 1]))) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return out;
      out += "\n";
      i = nl;
      continue;
    }
    out += ch;
  }
  return out;
}

export function logicalLines(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    buf = buf === "" ? line : `${buf}\n${line}`;
    // A `#` only starts a comment OUTSIDE quotes: in `curl -H "X-Note: #" … |`
    // it is header data, and treating it as a comment hid the trailing pipe,
    // splitting a curl|sh pipeline into two commands (P3 verdict 6, blocking).
    const stripped = stripComment(buf).trimEnd();
    const continues =
      /(\||&&|\|\||;|\\)$/.test(stripped) || parseShell(buf).unbalanced;
    if (!continues) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf !== "") out.push(buf);
  return out;
}

/** §7.1.5 classes decided from parsed structure (§7.1, gate 5). */
function shellFindings(text: string): Array<{ severity: "fail" | "warn"; id: string }> {
  const out: Array<{ severity: "fail" | "warn"; id: string }> = [];
  // comment text is documentation, not code (P3 verdict 7, blocking #2)
  const parsed = parseShell(stripComment(text));

  // §7.1, gate 5: a command that cannot be classified safely is a FAIL
  if (parsed.unbalanced) {
    return [{ severity: severityOf("unparseable-command"), id: "unparseable-command" }];
  }
  // ---- OD-2026-08-02-5: only statically readable DIRECT commands are admitted.
  // Whatever decides its command or its code at run time is opaque to this gate
  // and therefore FAILs; the gate stays fail-closed instead of guessing.
  //
  // Command substitution and backticks run a command the gate never classifies,
  // wherever they appear — `$(printf sh)` in command position hid the name
  // (verdict 7), and `X=$(curl … | sh)` hides a whole pipeline in an argument.
  if (parsed.words.some((w) => w.hasCommandSubstitution)) {
    return [{ severity: severityOf("command-substitution"), id: "command-substitution" }];
  }
  for (let si = 0; si < parsed.segments.length; si++) {
    const seg = parsed.segments[si];
    // subshells, brace groups, function definitions
    if (seg.words.some(isStructureWord)) {
      return [{ severity: severityOf("control-construct"), id: "control-construct" }];
    }
    const chain = segmentCommandChain(seg);
    if (chain.length === 0) continue;
    // A command NAME the gate cannot read hides which command runs, quoted or
    // not: `CMD=rm; "$CMD" -rf /`, `S=sh; curl … | "$S"` (verdict 8). An
    // expansion in the DIRECTORY part (`$PREFIX/bin/rm`) leaves the name
    // readable and is not this case.
    if (chain.some((c) => c.unknown)) {
      return [{ severity: severityOf("unclassifiable-command-name"), id: "unclassifiable-command-name" }];
    }
    for (const { name, index } of chain) {
      if (CONTROL_KEYWORDS.has(name)) {
        return [{ severity: severityOf("control-construct"), id: "control-construct" }];
      }
      // `eval`, `source` and `.` execute text the gate never sees
      if (EXECUTION_INDIRECTION.has(name)) {
        return [{ severity: severityOf("eval-or-source"), id: "eval-or-source" }];
      }
      // A privilege escalator carrying an inline-code flag is two facts at
      // once, and neither may be dropped: the escalation, which is about the
      // command word, and code the gate never reads, which is about its
      // argument. Reporting only the opacity would lose which command took
      // root; reporting only the escalation would claim the payload had been
      // classified. So this one line reports BOTH and, like every other
      // opacity finding, preempts the rest of the line.
      if (ESCALATOR_INLINE_CODE.has(name) && hasInlineCodeFlag(seg, index)) {
        return [
          { severity: severityOf("sudo"), id: "sudo" },
          { severity: severityOf("interpreter-inline-code"), id: "interpreter-inline-code" },
        ];
      }
      if (SHELL_INTERPRETERS.has(name)) {
        // code passed inline (`sh -c '…'`), or piped in from ANY producer —
        // `echo … | sh` hides code exactly as `curl … | sh` does
        if (hasInlineCodeFlag(seg, index)) {
          return [{ severity: severityOf("interpreter-inline-code"), id: "interpreter-inline-code" }];
        }
        const producer = parsed.segments[si - 1];
        if (producer?.terminator === "|") {
          // the §7.1.5 class keeps reporting under its own name when the
          // producer is a fetcher; any other producer is the same hole
          const id = segmentCommandChain(producer).some((c) => FETCHERS.has(c.name))
            ? "curl-pipe-shell"
            : "piped-into-interpreter";
          return [{ severity: severityOf(id), id }];
        }
      }
    }
  }
  if (parsed.words.some((w) => w.hasUnquotedExpansion)) {
    out.push({ severity: severityOf("unquoted-expansion"), id: "unquoted-expansion" });
  }
  if (parsed.hasBackgrounding) {
    out.push({ severity: severityOf("background-daemon"), id: "background-daemon" });
  }

  parsed.segments.forEach((seg, i) => {
    const chain = segmentCommandChain(seg);
    for (const { name, index } of chain) {
      if (DAEMONIZERS.has(name)) {
        out.push({ severity: severityOf("background-daemon"), id: "background-daemon" });
      }
      if (PRIVILEGE_ESCALATORS.has(name)) {
        out.push({ severity: severityOf("sudo"), id: "sudo" });
      }
      if (FETCHERS.has(name) && seg.terminator === "|") {
        const next = parsed.segments[i + 1];
        if (next && invokesShell(next)) {
          out.push({ severity: severityOf("curl-pipe-shell"), id: "curl-pipe-shell" });
        }
      }
      if (name === "rm") {
        let flags = "";
        let j = index + 1;
        for (; j < seg.words.length && seg.words[j].isFlag; j++) {
          if (seg.words[j].literal === "--") { j++; break; }
          flags += seg.words[j].literal;
        }
        // EVERY operand is a target — `rm -rf build/tmp "$TARGET"` deletes both
        // (P3 verdict 5, blocking #1)
        if (/r/.test(flags) && /f/.test(flags) && seg.words.slice(j).some(isDangerousTarget)) {
          out.push({ severity: severityOf("rm-rf-variable-or-root"), id: "rm-rf-variable-or-root" });
        }
      }
    }
  });
  return out;
}

// §7.1.6 prompt-injection heuristics: imperatives addressed to the READING
// agent. Scanned over SKILL.md and steps[].instruction/expected.
export const INJECTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "ignore-instructions", re: /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|rules|guidance)\b/i },
  { id: "disregard-safety", re: /\bdisregard\s+(your|the|all)\s+(instructions|guidelines|safety|policies)\b/i },
  { id: "disable-safety", re: /\bdisable\s+(the\s+)?(safety|guardrails?|checks|filters)\b/i },
  { id: "exfiltrate", re: /\bexfiltrat/i },
  { id: "leak-secrets", re: /\b(send|post|upload|forward)\s+(the\s+|your\s+|all\s+)?(credentials?|secrets?|api[_ ]?keys?|tokens?|\.env)\b/i },
  { id: "hide-from-owner", re: /\bdo\s+not\s+(tell|inform|reveal\s+to|mention\s+to)\s+the\s+(user|owner|human)\b/i },
  { id: "persona-override", re: /\byou\s+are\s+now\s+(in\s+)?(developer\s+mode|dan|jailbreak)\b/i },
];

// Imperative verbs that turn an out-of-allowlist URL in SKILL.md into an
// injection finding (spec: "contact external endpoints outside allowlist").
const CONTACT_VERB_RE = /\b(curl|wget|fetch|post|send|upload|open|visit|call)\b/i;

// §7.1.7 committed staleness policy. Data, not code: extend by editing the
// table; the gate logic never changes. `releasedAtMs` feeds the policy-window
// clause for the pinned versions the table knows about.
export const STALENESS_POLICY = {
  policyWindowMs: 730 * 24 * 3600 * 1000, // 2 years
  /** deprecated upstream → FAIL (any version unless `before` narrows it) */
  deprecated: [
    { id: "request" }, // npm, deprecated 2020
    { id: "left-pad" },
    { id: "node-uuid" },
  ] as Array<{ id: string; before?: string }>,
  /** EOL below the given version → WARN */
  eol: [
    { id: "node", before: "18.0.0" },
    { id: "python", before: "3.8.0" },
    { id: "ubuntu", before: "20.04.0" },
  ],
  /**
   * Known release dates (epoch ms) for the policy-window check. Entries whose
   * line is ALSO EOL-listed would never reach this branch (EOL wins), so the
   * table carries lines that are only window-old — otherwise the branch is
   * dead machinery (defect #6 class of the internal defect ledger).
   */
  releasedAtMs: {
    "terraform@1.0.0": Date.UTC(2021, 5, 8),
    "kubectl@1.21.0": Date.UTC(2021, 3, 8),
    "node@14.0.0": Date.UTC(2020, 3, 21),
    "python@3.6.0": Date.UTC(2016, 11, 23),
  } as Record<string, number>,
} as const;

function semverLt(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

// ------------------------------------------------------------------ helpers

function worst(findings: Array<{ severity: "fail" | "warn"; text: string }>, gate: GateName): GateReport {
  if (findings.length === 0) return { gate, result: "pass", details: null };
  const anyFail = findings.some((f) => f.severity === "fail");
  return {
    gate,
    result: anyFail ? "fail" : "warn",
    details: findings.map((f) => f.text).slice(0, 10).join("; "),
  };
}

function fileText(files: PackageFiles, path: string): string {
  const buf = files.get(path);
  return buf ? buf.toString("utf8") : "";
}

/** files under a directory prefix, as [path, text] */
function dirTexts(files: PackageFiles, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [path, buf] of files) {
    if (path.startsWith(prefix)) out.push([path, buf.toString("utf8")]);
  }
  return out;
}

function steps(manifest: any): any[] {
  return Array.isArray(manifest?.procedure?.steps) ? manifest.procedure.steps : [];
}

/** shell-scan targets: scripts/ files, manifest scripts entries, step commands */
function shellSources(manifest: any, files: PackageFiles): Array<[string, string]> {
  const out: Array<[string, string]> = dirTexts(files, "scripts/");
  const inline: string[] = Array.isArray(manifest?.procedure?.scripts) ? manifest.procedure.scripts : [];
  inline.forEach((s, i) => out.push([`procedure.scripts[${i}]`, String(s)]));
  steps(manifest).forEach((s, i) => {
    if (typeof s?.command === "string") out.push([`steps[${i}].command`, s.command]);
  });
  return out;
}

/**
 * Allowlist matching is ORIGIN-based, never a textual prefix: an entry
 * `https://api.example.com` must not admit `https://api.example.com.evil.net`
 * or `https://api.example.com@evil.net` (P3 verdict 1, blocking #3). The
 * origin must match exactly; the entry's path, if any, constrains the URL's
 * path at a segment boundary.
 */
export function urlAllowed(url: string, allowlist: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // credentials in the authority are an origin-confusion vector in their own right
  if (u.username !== "" || u.password !== "") return false;
  return allowlist.some((raw) => {
    let e: URL;
    try {
      e = new URL(raw);
    } catch {
      return false; // a non-URL allowlist entry matches nothing
    }
    // compare canonicalized authority parts, never the raw origin string
    if (e.protocol !== u.protocol) return false;
    if (canonicalHost(e.hostname) !== canonicalHost(u.hostname)) return false;
    if (e.port !== u.port) return false;
    if (e.pathname === "/" || e.pathname === "") return true;
    const base = e.pathname.endsWith("/") ? e.pathname : `${e.pathname}/`;
    return u.pathname === e.pathname || u.pathname.startsWith(base);
  });
}

// -------------------------------------------------------------------- gates

/**
 * One Appendix E cross-field rule this gate applies ON TOP of the JSON schema.
 *
 * The schema cannot state these: both members are individually valid and it is
 * their COMBINATION that is refused. They carry a `pointer` because the gate
 * report cannot — `lint_reports` stores a gate name, a result and a sentence —
 * and the authoring CLI's finding shape must give an author the exact member to
 * edit. So the rule lives here once and has two readers: `schemaGate` below,
 * which joins the sentences, and `src/source-profile.ts`, which reports each
 * with its pointer. A second copy of these two conditions is exactly the drift
 * `INV-01` forbids.
 */
export interface SchemaCrossFieldProblem {
  /** RFC 6901 pointer to the member an author edits to satisfy the rule */
  pointer: string;
  detail: string;
  recovery: string;
}

/** The §4.2/Appendix E cross-field rules for a `high` risk manifest. */
export function schemaCrossFieldProblems(manifest: any): SchemaCrossFieldProblem[] {
  const problems: SchemaCrossFieldProblem[] = [];
  if (manifest?.scope?.risk_level !== "high") return problems;
  if (manifest?.safety?.sandbox_requirement !== "required") {
    problems.push({
      pointer: "/safety/sandbox_requirement",
      detail: "risk_level high requires safety.sandbox_requirement 'required'",
      recovery:
        "set safety.sandbox_requirement to `required` — a high-risk package is handed only to an adopter that attests sandbox capability, so `none` and `recommended` are refused for this risk level",
    });
  }
  const approvals: string[] = Array.isArray(manifest?.scope?.required_approvals) ? manifest.scope.required_approvals : [];
  if (!approvals.includes("publish") || !approvals.includes("adopt_high_risk")) {
    problems.push({
      pointer: "/scope/required_approvals",
      detail: "risk_level high requires required_approvals to include publish and adopt_high_risk",
      recovery:
        "list both `publish` and `adopt_high_risk` — a high-risk skill is decided twice, once to make the version adoptable and once per adoption",
    });
  }
  return problems;
}

/** Gate 1 — schema completeness (+ Appendix E cross-field rules, §4.2 WARN). */
function schemaGate(manifest: any): GateReport {
  const val = validateManifest(manifest);
  if (!val.valid) {
    return { gate: "schema", result: "fail", details: val.errors.slice(0, 10).join("; ") };
  }
  const problems = schemaCrossFieldProblems(manifest).map((p) => p.detail);
  if (problems.length > 0) {
    return { gate: "schema", result: "fail", details: problems.join("; ") };
  }
  if ((manifest.procedure?.failure_modes ?? []).length === 0) {
    return { gate: "schema", result: "warn", details: "failure_modes is empty (§4.2 zero-failure-mode WARN)" };
  }
  return { gate: "schema", result: "pass", details: null };
}

/** Gate 2 — secret patterns over manifest, SKILL.md, fixtures/, evidence/. */
function secretsGate(manifest: any, files: PackageFiles): GateReport {
  const targets: Array<[string, string]> = [
    ["manifest", JSON.stringify(manifest ?? {})],
    ["SKILL.md", fileText(files, "SKILL.md")],
    ...dirTexts(files, "fixtures/"),
    ...dirTexts(files, "evidence/"),
  ];
  const findings: Array<{ severity: "fail"; text: string }> = [];
  for (const [where, rawText] of targets) {
    // both readings of the redaction convention — see redactionReadings()
    for (const text of redactionReadings(rawText)) {
      for (const { id, re } of SECRET_PATTERNS) {
        if (re.test(text)) findings.push({ severity: "fail", text: `${id} in ${where}` });
      }
      for (const m of text.match(/[A-Za-z0-9+/=_-]{40,}/g) ?? []) {
        if (isHighEntropyToken(m)) {
          findings.push({ severity: "fail", text: `high-entropy string in ${where}` });
          break; // one entropy finding per reading is enough
        }
      }
    }
  }
  // dedupe: the same secret usually hits in both readings
  const seen = new Set<string>();
  return worst(
    findings.filter((f) => (seen.has(f.text) ? false : (seen.add(f.text), true))),
    "secrets",
  );
}

/** Gate 3 — dependency pinning: exact versions only, floating ranges FAIL. */
function pinningGate(manifest: any): GateReport {
  const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  const findings: Array<{ severity: "fail"; text: string }> = [];
  const mcpDeps: any[] = manifest?.runtime?.mcp_dependencies ?? [];
  mcpDeps.forEach((d, i) => {
    if (!exact.test(String(d?.version ?? ""))) {
      findings.push({ severity: "fail", text: `mcp_dependencies[${i}] '${d?.registry_id}' not pinned exactly` });
    }
  });
  const deps: any[] = manifest?.safety?.dependency_manifest ?? [];
  deps.forEach((d, i) => {
    if (!exact.test(String(d?.version ?? ""))) {
      findings.push({ severity: "fail", text: `dependency_manifest[${i}] '${d?.name}' not pinned exactly` });
    }
  });
  return worst(findings, "pinning");
}

/** Gate 4 — URLs in steps/scripts ⊆ allowlist; denylist classes FAIL flat. */
function urlsGate(manifest: any, files: PackageFiles): GateReport {
  const allowlist: string[] = manifest?.safety?.url_allowlist ?? [];
  const sources: Array<[string, string]> = [...shellSources(manifest, files)];
  steps(manifest).forEach((s, i) => {
    if (typeof s?.instruction === "string") sources.push([`steps[${i}].instruction`, s.instruction]);
    if (typeof s?.expected === "string") sources.push([`steps[${i}].expected`, s.expected]);
  });
  const findings: Array<{ severity: "fail"; text: string }> = [];
  for (const [where, text] of sources) {
    for (const url of extractUrls(text)) {
      findings.push(...urlVerdict(url, where, allowlist));
    }
  }
  return worst(findings, "urls");
}

/** Gate 5 — shell-command lint per SHELL_SEVERITY. */
function shellGate(manifest: any, files: PackageFiles): GateReport {
  const findings: Array<{ severity: "fail" | "warn"; text: string }> = [];
  for (const [where, text] of shellSources(manifest, files)) {
    // every class is structural now; judged per LOGICAL line, so a pipeline or
    // quoted string continued across a newline is still one command
    for (const line of logicalLines(text)) {
      for (const f of shellFindings(line)) findings.push({ severity: f.severity, text: `${f.id} in ${where}` });
    }
  }
  const seen = new Set<string>();
  return worst(
    findings.filter((f) => (seen.has(f.text) ? false : (seen.add(f.text), true))),
    "shell",
  );
}

/** Gate 6 — prompt-injection heuristics in SKILL.md and step prose. */
function injectionGate(manifest: any, files: PackageFiles): GateReport {
  const allowlist: string[] = manifest?.safety?.url_allowlist ?? [];
  const proseTargets: Array<[string, string]> = [["SKILL.md", fileText(files, "SKILL.md")]];
  steps(manifest).forEach((s, i) => {
    if (typeof s?.instruction === "string") proseTargets.push([`steps[${i}].instruction`, s.instruction]);
    if (typeof s?.expected === "string") proseTargets.push([`steps[${i}].expected`, s.expected]);
  });
  const findings: Array<{ severity: "fail"; text: string }> = [];
  for (const [where, text] of proseTargets) {
    for (const { id, re } of INJECTION_PATTERNS) {
      if (re.test(text)) findings.push({ severity: "fail", text: `${id} in ${where}` });
    }
    // imperative + endpoint outside the allowlist
    for (const line of text.split("\n")) {
      if (!CONTACT_VERB_RE.test(line)) continue;
      for (const url of extractUrls(line)) {
        if (!urlAllowed(url, allowlist)) {
          findings.push({ severity: "fail", text: `contact-endpoint outside allowlist in ${where}` });
        }
      }
    }
  }
  return worst(findings, "injection");
}

/** Gate 7 — staleness against the committed policy table. */
function stalenessGate(manifest: any, _files: PackageFiles, ctx: GateContext): GateReport {
  const findings: Array<{ severity: "fail" | "warn"; text: string }> = [];
  const entries: Array<{ id: string; version: string; where: string }> = [];
  (manifest?.runtime?.mcp_dependencies ?? []).forEach((d: any) =>
    entries.push({ id: String(d?.registry_id ?? ""), version: String(d?.version ?? ""), where: "mcp_dependencies" }),
  );
  (manifest?.safety?.dependency_manifest ?? []).forEach((d: any) =>
    entries.push({ id: String(d?.name ?? ""), version: String(d?.version ?? ""), where: "dependency_manifest" }),
  );
  // procedure.tools_used is a matcherList too and is the INPUT to the §4.2
  // compatibility match — an EOL tool referenced there must be caught
  // (P3 verdict 1, major #2).
  (manifest?.procedure?.tools_used ?? []).forEach((m: any) => {
    const v = /(\d+\.\d+(\.\d+)?)/.exec(String(m?.range ?? ""))?.[1];
    if (v) entries.push({ id: String(m?.id ?? ""), version: v, where: "procedure.tools_used" });
  });
  for (const list of ["runtime_compat", "tool_compat", "model_compat"]) {
    (manifest?.runtime?.[list] ?? []).forEach((m: any) => {
      // a matcher range like ">=1.2.3" or exact pins the referenced tool line
      const v = /(\d+\.\d+(\.\d+)?)/.exec(String(m?.range ?? ""))?.[1];
      if (v) entries.push({ id: String(m?.id ?? ""), version: v, where: list });
    });
  }
  for (const { id, version, where } of entries) {
    if (STALENESS_POLICY.deprecated.some((d) => d.id === id && (!d.before || semverLt(version, d.before)))) {
      findings.push({ severity: "fail", text: `deprecated upstream '${id}' in ${where}` });
      continue;
    }
    const eol = STALENESS_POLICY.eol.find((e) => e.id === id);
    if (eol && semverLt(version, eol.before)) {
      findings.push({ severity: "warn", text: `EOL version '${id}@${version}' in ${where}` });
      continue;
    }
    const released = STALENESS_POLICY.releasedAtMs[`${id}@${version}`];
    if (released !== undefined && ctx.nowMs - released > STALENESS_POLICY.policyWindowMs) {
      findings.push({ severity: "warn", text: `'${id}@${version}' older than the policy window in ${where}` });
    }
  }
  return worst(findings, "staleness");
}

/** Gate 8 — internal compatibility consistency. */
function compatGate(manifest: any, files: PackageFiles): GateReport {
  const findings: Array<{ severity: "fail"; text: string }> = [];
  const os: string[] = manifest?.runtime?.os ?? [];
  const shell: string[] = manifest?.runtime?.shell ?? [];
  if (shell.includes("powershell") && !os.includes("windows")) {
    findings.push({ severity: "fail", text: "shell declares powershell but os excludes windows" });
  }
  const psRe = /\b(powershell|pwsh|Get-\w+|Set-\w+|Invoke-\w+)\b|\.ps1\b/i;
  // `command` is OPTIONAL in the E.1 step schema, so a step can prescribe
  // PowerShell entirely in prose. Instruction/expected text is scanned too, or
  // the spec's own linux+PowerShell example passes (P3 verdict 1, major #3).
  const compatSources: Array<[string, string]> = [...shellSources(manifest, files)];
  steps(manifest).forEach((s, i) => {
    if (typeof s?.instruction === "string") compatSources.push([`steps[${i}].instruction`, s.instruction]);
    if (typeof s?.expected === "string") compatSources.push([`steps[${i}].expected`, s.expected]);
  });
  for (const [where, text] of compatSources) {
    if (psRe.test(text) && !shell.includes("powershell")) {
      findings.push({ severity: "fail", text: `PowerShell construct in ${where} but shell excludes powershell` });
      break;
    }
  }
  const hasCommands = steps(manifest).some((s) => typeof s?.command === "string" && s.command.length > 0);
  if (hasCommands && shell.length === 1 && shell[0] === "none") {
    findings.push({ severity: "fail", text: "steps carry commands but runtime.shell is ['none']" });
  }
  return worst(findings, "compat");
}

/** The 8 gates, §7.1 order. All registered; the runner never special-cases. */
export const ACTIVE_GATES: ReadonlyArray<GateFn> = [
  (m) => schemaGate(m),
  (m, f) => secretsGate(m, f),
  (m) => pinningGate(m),
  (m, f) => urlsGate(m, f),
  (m, f) => shellGate(m, f),
  (m, f) => injectionGate(m, f),
  (m, f, c) => stalenessGate(m, f, c),
  (m, f) => compatGate(m, f),
];

export function runGates(manifest: any, files: PackageFiles, ctx: GateContext): GateReport[] {
  return ACTIVE_GATES.map((g) => g(manifest, files, ctx));
}
