// [B-4] — EVERY DOCUMENT THIS REPOSITORY SHIPS, AGAINST THE CODE IT SHIPS.
//
// THE HISTORY, because it is the argument, and every round of it is the same
// mistake one layer higher up.
//
//   ROUND 2 named THREE DOCUMENTS — `README.md`, `docs/API.md`, `src/mcp.ts`.
//   A reviewer wrote "six views" into the normative `SPEC.md` and the suite
//   passed.
//
//   ROUND 3 replaced the list with a DISCOVERY — `package.json`'s `files` plus
//   a walk of two directories written as `["", "docs/"]`. It reached 61 of the
//   76 Markdown files this repository tracks, and a lie in `skills/README.md`
//   was read by nobody.
//
//   ROUND 4 took the Markdown set from `git ls-files -- '*.md'` — the
//   repository's own index, which cannot be behind the repository. It read 127
//   documents. A reviewer then planted a lie in `package.json`'s `description`,
//   WHICH IS SHIPPED TO EVERY USER AND IS NOT A MARKDOWN FILE, renamed the
//   first heading of `skills/README.md` so it would be taken for a review
//   record, and wrote a present-tense falsehood underneath it. Both passed.
//
// So THE SUBJECT OF THIS ROUND IS WHAT NPM SHIPS. `npm pack --json` is the
// actual list of files a user receives — every `.md`, every `.ts`, the
// `package.json` itself, `bin/skillonomia.js`, the migrations, the schemas, the
// seed and `LICENSE`. It is not a rule about extensions and not a walk of
// remembered directories; it is the package. The tracked Markdown set is kept
// as well, because a repository's self-description is a separate question from
// what it ships, and the union is what is read. EVERY FILE OF BOTH IS READ.
//
// AND THERE IS NO THIRD BUCKET. Round 4 sorted a claim into `wrong`,
// `unverifiable` or nothing, printed the middle one, and passed. 378 plantings
// produced 318 catches and 60 "unverifiable", and the test was green — a guard
// reporting a clean run over the sixty it could not answer for. A claim is now
// either refuted or true; a claim nobody can check IS a defect, because a
// reader acts on it and nothing contradicts it.
//
// THE PARAPHRASE, AND WHAT IS AND IS NOT CLOSED HERE — read this before
// trusting the paragraph above.
//
//   A count in prose can be phrased in more ways than any pattern enumerates,
//   and this file does NOT claim to recognise an arbitrary English sentence
//   that implies a number. What it does is narrower and checkable:
//
//     THE TRUE VALUE HAS ONE SOURCE — the code — and a document states it by
//     writing a QUANTITY next to a guarded NOUN. The quantities are a CLOSED
//     LEXICON of English definite-quantity expressions (digits, the number
//     words, `dozen`, `half a dozen`, `score`, `a couple`, `a pair`), which is
//     finite in a way that "the notations a number can be written in" is not.
//     A VAGUE quantity next to a guarded noun (`several`, `numerous`, `a
//     handful of`) is refused outright, because there is no value to compare it
//     against and a reader still reads a number out of it.
//
//   What that closes: "six views", "half a dozen screens", "a dozen tools",
//   "six read-only dashboard views" — every one of them resolves to a figure
//   and is checked. What it does NOT close: a sentence that computes the number
//   rather than naming it ("twice five views, plus one"), or that implies it
//   without a quantity word at all. That limit is stated here rather than
//   papered over, and the mitigation is structural: the lexicon is a
//   PROHIBITION as much as a resolver — a document that wants to state one of
//   these counts has exactly one way to write it, and any other phrasing that
//   the lexicon does catch is refused rather than resolved leniently.
//
// THE REVIEW RECORD, AND WHY THE EXEMPTION IS NARROWER THAN A HEADING.
//
//   Thirty-three tracked documents are the record of a review already accepted.
//   A P6 verdict saying "the dashboard's five views" is a TRUE STATEMENT ABOUT
//   THE BUILD IT REVIEWED, and checking it against today's eleven would demand
//   that history be rewritten to agree with the present.
//
//   Round 4 read that status off the document's first heading. A heading is
//   text, and a reviewer proved it by writing one. Round 5 required a commit as
//   well — and accepted a claim that agreed with ANY of the commits a document
//   named. A reviewer took that apart in one sentence: a record naming the
//   candidate AND its baseline, saying "the dashboard currently has five views",
//   agreed with the baseline and passed while stating something false about the
//   build under review. AGREEING WITH ONE OF SEVERAL IS NOT A BINDING; it is the
//   guard searching, on the document's behalf, for a commit that makes the
//   sentence true.
//
//   So an exemption now requires ALL of:
//
//     * the document declares itself a record in its first heading, AND
//     * the sentence is not in the present time — a present-time adverbial
//       ("currently", "at present", "as of today") means the sentence is about
//       THIS build and is checked against today's code, AND
//     * it NAMES A COMMIT THIS REPOSITORY CAN RESOLVE, AND
//     * the commits THE CLAIM IS BOUND TO agree about the constant — the ones
//       its own sentence names, or, where the sentence names none, the ones the
//       document names — AND
//     * the claim equals that one value.
//
//   Two different values among the bound commits is a REFUSAL naming both, and
//   the remedy is for the sentence to name the build it means. A claim that
//   fails any of those is checked against TODAY'S code. A record that names no
//   commit exempts nothing, which is exactly the attack that worked in round 4.
//
//   THE LIMIT, STATED: the present-time rule is a closed list of adverbials and
//   not a tense parser. A bare present-tense verb is not caught by it, and is
//   left to the binding rule — which is the rule that does the work, and which
//   does not care about tense at all.
//
//   Where a record genuinely speaks of a set that no commit can answer for — a
//   phase plan's five views, at a commit predating the dashboard — the sentence
//   carries a machine-readable ANCHOR naming the code constant it means
//   (`[skln:count=phase_plan_views]`), and the guard checks it against that
//   constant. The true value still has exactly one source.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DASHBOARD_VIEWS, FLEET_SCREENS, PHASE_PLAN_VIEWS } from "../src/dashboard.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { MIGRATION_SOURCE, RECIPIENT_SOURCE_REQUEST, RECIPIENT_SOURCE_TRANSFER } from "../src/skill-migrations.ts";

/** The repository root as a path `git`, `npm` and `readFileSync` all accept. */
export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * A guard that cannot list its subject REFUSES. It does not sweep an empty set
 * and report the result as clean — that is the mechanism of silent staleness
 * this whole file exists to remove.
 */
export class DocumentSetUnavailable extends Error {}

// ---------------------------------------------------------------- the subject

/**
 * WHERE THE PACK IS RUN — a tree of this guard's own, never the repository.
 *
 * THE PROBLEM THE COPY SOLVES. A real `npm pack` runs `prepack`, and this
 * package's `prepack` is `npm run build:js`, which WRITES `dist-js/cli.js`. So
 * the honest enumeration and "the working tree is untouched" pull against each
 * other, and the pull is silent: `dist-js/` is ignored by git, so a guard that
 * built into the repository would leave a stale artifact behind and `git status`
 * would say nothing about it. Worse, a leftover build makes `--ignore-scripts`
 * and a real pack agree, which is how the wrong enumeration survived a round of
 * review — on a fresh tree it reports 76 files where the packer ships 77.
 *
 * So the enumeration happens in a copy: every file git tracks, taken from the
 * WORKING TREE (so uncommitted edits are what gets checked), plus a symbolic
 * link to `node_modules`, which `prepack` needs and nothing writes into. The
 * copy holds no `dist-js/`, so the pack that runs here is the pack a user's
 * `npm install` performs on a fresh checkout, and `prepack` writes where a
 * write costs nothing.
 *
 * WHAT THIS COPY IS NOT. It is not a substitute for the repository: untracked
 * files are absent from it, deliberately, because an untracked file is either
 * ignored (and not shipped) or would show in `git status`, which the regime
 * requires to be empty. It is built ONCE per process and removed at exit.
 */
let packRootDir: string | null = null;
let packCacheDir: string | null = null;

/**
 * A PRIVATE npm CACHE, OUTSIDE THE TREE BEING PACKED.
 *
 * `npm` writes into `~/.npm/_cacache` by default, and this suite runs sixty-odd
 * files at once; two packers racing on the same content-addressed directory
 * produce `EEXIST` from a `mkdir` neither of them needed. A cache per process
 * removes the shared state rather than retrying around it. It lives beside the
 * pack root and never inside it, because anything inside it would be a file
 * offered to the packer.
 */
function packCache(): string {
  if (packCacheDir !== null) return packCacheDir;
  const dir = mkdtempSync(join(tmpdir(), "skln-docs-npm-cache-"));
  packCacheDir = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function packRoot(): string {
  if (packRootDir !== null) return packRootDir;
  let listing: string;
  try {
    listing = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 26,
    });
  } catch (e) {
    throw new DocumentSetUnavailable(
      `REFUSED: the package could not be COPIED for enumeration — \`git ls-files\` failed (${String((e as Error).message).split("\n")[0]}). ` +
        "A guard that cannot list its subject refuses; it does not sweep an empty set and call the result clean.",
    );
  }
  const files = listing.split("\0").filter((s) => s.length > 0);
  if (files.length === 0) {
    throw new DocumentSetUnavailable("REFUSED: `git ls-files` listed no file, so there is no package to enumerate.");
  }
  const dir = mkdtempSync(join(tmpdir(), "skln-docs-pack-"));
  for (const rel of files) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(dir, rel));
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  packRootDir = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * THE FILES THIS PACKAGE SHIPS, from `npm pack --json`, WITH ITS LIFECYCLE.
 *
 * Not `package.json`'s `files`, which is an INPUT to that computation and
 * answers a different question (it says nothing about `package.json` itself,
 * about `.npmignore`, or about what the packer adds). And not
 * `--ignore-scripts`, which was here and was the defect: it answers "which
 * files does the manifest list" where the subject is "which files does a user
 * receive". `prepack` builds `dist-js/cli.js` and `dist-js/` is in the `files`
 * list, so the built bundle IS shipped — 77 files, not 76 — and until this flag
 * came off it was read by nobody.
 *
 * `--dry-run` still writes no tarball. The build `prepack` does write lands in
 * `packRoot()`, which is not this repository.
 *
 * A LIFECYCLE SCRIPT PRINTS TO THE SAME STREAM `--json` DOES (`bun build`
 * announces its bundle), so the JSON is located rather than assumed: the array
 * starts at the first line that begins with `[`. Anything else is a refusal —
 * a guard that cannot read the answer does not guess at one.
 */
export function packedFiles(): string[] {
  const root = packRoot();
  // TWO ATTEMPTS, AND THE SECOND ONE SAYS SO. `npm pack` is an external process
  // that runs a build, and this suite runs sixty-odd files at once; a packer
  // that lost a race is not a package that cannot be listed. The retry is
  // ANNOUNCED rather than silent, and a second failure is still a refusal —
  // nothing here turns "I could not read the subject" into a clean sweep.
  let out = "";
  let failure: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1 << 26,
        env: { ...process.env, npm_config_cache: packCache() },
      });
      failure = null;
      break;
    } catch (e) {
      failure = e as Error;
      const stderr = String((e as { stderr?: string }).stderr ?? "").split("\n").filter(Boolean).slice(-6).join(" / ");
      console.log(`[B-4] \`npm pack\` attempt ${attempt} failed in ${root}: ${String(failure.message).split("\n")[0]} :: ${stderr}`);
    }
  }
  if (failure !== null) {
    throw new DocumentSetUnavailable(
      `REFUSED: the shipped file set could not be ENUMERATED — \`npm pack --json\` failed twice (${String(failure.message).split("\n")[0]}). ` +
        "A guard that cannot list its subject refuses; it does not sweep an empty set and call the result clean.",
    );
  }
  const start = /^\[/m.exec(out);
  let parsed: unknown;
  try {
    parsed = start === null ? null : JSON.parse(out.slice(start.index));
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    throw new DocumentSetUnavailable("REFUSED: `npm pack --json` did not answer with JSON, so the shipped file set is unknown.");
  }
  const files = (Array.isArray(parsed) ? parsed : [])
    .flatMap((p: any) => (Array.isArray(p?.files) ? p.files : []))
    .map((f: any) => String(f?.path ?? ""))
    .filter((p: string) => p.length > 0);
  if (files.length === 0) {
    throw new DocumentSetUnavailable(
      "REFUSED: `npm pack --json` reported no file. An empty subject is not a passing subject: nothing would be checked and nothing reported.",
    );
  }
  return [...new Set(files)].sort();
}

/**
 * Every Markdown file GIT TRACKS. Kept from round 4, because "what does this
 * repository say about itself" and "what does it ship" are two questions and
 * the answer to neither contains the other.
 */
export function trackedMarkdown(root: string = REPO_ROOT): string[] {
  let listing: string;
  try {
    listing = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "*.md"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
    });
  } catch (e) {
    throw new DocumentSetUnavailable(
      `REFUSED: the document set could not be ENUMERATED at ${root} — \`git ls-files\` failed (${String((e as Error).message).split("\n")[0]}). ` +
        "A guard that cannot list its subject refuses; it does not sweep an empty set and call the result clean.",
    );
  }
  const files = listing.split("\0").filter((s) => s.length > 0);
  if (files.length === 0) {
    throw new DocumentSetUnavailable(
      `REFUSED: \`git ls-files -- '*.md'\` listed no document at ${root}. ` +
        "An empty subject is not a passing subject: nothing would be checked and nothing would be reported.",
    );
  }
  return files.sort();
}

/** Files that are bytes rather than prose: nothing to read a claim out of, and
 *  reading one would only add noise. There are none in this package today, and
 *  the list is here so that adding one is a decision somebody writes down. */
const NOT_TEXT = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|tgz|gz|wasm)$/i;

/** THE UNION, read in full: what the package ships, plus what git tracks. */
export function documentSet(): Array<[string, string]> {
  // READ FROM THE TREE THAT WAS PACKED, and not from the repository. Every one
  // of these paths exists there — it holds each tracked file's WORKING-TREE
  // bytes, so an uncommitted edit is what gets checked — and one of them exists
  // ONLY there: `dist-js/cli.js` is built by `prepack` during the enumeration,
  // and a fresh checkout has no such file to open. Reading from the repository
  // would work on this machine, today, because a stale build happens to be
  // lying in it, and would fail on a clone — which is the same "it passed
  // because of something nobody declared" this file exists to remove.
  const root = packRoot();
  const paths = [...new Set([...packedFiles(), ...trackedMarkdown()])].filter((p) => !NOT_TEXT.test(p)).sort();
  return paths.map((rel) => [rel, readFileSync(join(root, rel), "utf8")] as [string, string]);
}

// ------------------------------------------------------------ the true values

export interface DocumentRules {
  views: number;
  screens: number;
  tools: number;
  /** every code constant a claim may be ANCHORED to, by name */
  anchors: Record<string, number>;
  permitted: ReadonlySet<string>;
  tables: readonly string[];
}

export function documentRules(): DocumentRules {
  return {
    views: DASHBOARD_VIEWS.length,
    screens: FLEET_SCREENS.length,
    tools: MCP_TOOLS.length,
    anchors: {
      dashboard_views: DASHBOARD_VIEWS.length,
      fleet_screens: FLEET_SCREENS.length,
      phase_plan_views: PHASE_PLAN_VIEWS.length,
      mcp_tools: MCP_TOOLS.length,
    },
    permitted: new Set([RECIPIENT_SOURCE_TRANSFER, RECIPIENT_SOURCE_REQUEST].map((s) => s.split(".")[0]!)),
    tables: tableNames(),
  };
}

/** Every table this schema has, from the migrations — never a list kept here. */
function tableNames(): string[] {
  const dir = new URL("../migrations/", import.meta.url);
  const names = new Set<string>();
  for (const file of execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--", "migrations/*.sql"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort()) {
    for (const m of readFileSync(new URL(file.replace("migrations/", ""), dir), "utf8").matchAll(/CREATE TABLE\s+"?([a-z_]+)"?\s*\(/gi)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

// ------------------------------------------------------------- the quantities

/**
 * THE CLOSED LEXICON OF DEFINITE QUANTITY.
 *
 * English has a finite vocabulary for "how many", and this is it for the sizes
 * a set in this repository can have. It is a lexicon and not a notation
 * grammar: the reason [I-3]'s figure pattern could never be closed is that the
 * ways to WRITE a number are unbounded, and the ways to SAY one in an English
 * noun phrase are not.
 */
const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/**
 * `one` IS NOT IN THE LEXICON, and the omission is reasoned rather than
 * convenient. In English "one tool" is almost always the indefinite article
 * doing emphasis — "one tool with a mode argument", "one new MCP tool" — and
 * not an assertion that the adapter advertises exactly one. A quantity word
 * that fires on every emphatic singular would have to be turned off, and a rule
 * that gets turned off is the failure this file is written against. The cost is
 * stated: a document could write "the dashboard has one view" and this guard
 * would not see it. Nothing else in the lexicon has that ambiguity.
 */

/** The compound quantities a person writes instead of a figure. */
const GROUP_WORDS: Record<string, number> = {
  "a dozen": 12,
  dozen: 12,
  "two dozen": 24,
  "half a dozen": 6,
  "a half-dozen": 6,
  "half-dozen": 6,
  "a baker's dozen": 13,
  "a score": 20,
  "a couple of": 2,
  "a couple": 2,
  "a pair of": 2,
  "a brace of": 2,
};

/** Quantities that name no value. A reader still reads a number out of one, and
 *  nothing in the code can confirm or refute it — so it is refused, not
 *  resolved. */
const VAGUE_WORDS = ["several", "numerous", "a handful of", "multiple", "various", "a number of"];

for (let tens = 20; tens <= 90; tens += 10) {
  for (let unit = 1; unit <= 9; unit += 1) {
    const tensWord = Object.keys(NUMBER_WORDS).find((w) => NUMBER_WORDS[w] === tens)!;
    const unitWord = Object.keys(NUMBER_WORDS).find((w) => NUMBER_WORDS[w] === unit)!;
    NUMBER_WORDS[`${tensWord}-${unitWord}`] = tens + unit;
  }
}

/** Longest first, so `thirty-six` is never read as `thirty`. */
function alternation(words: readonly string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

const QUANTITY = `${alternation([...Object.keys(GROUP_WORDS), ...VAGUE_WORDS, ...Object.keys(NUMBER_WORDS)])}|\\d+`;

/**
 * The words a quantity and its noun may be separated by.
 *
 * TWO, and the bound is the whole of the rule. "six read-only dashboard views"
 * is two; "twelve MCP tools" is one. Three admitted "surface 4 has two forms
 * behind ONE tool" as a claim of two tools, which is a sentence about a single
 * tool and not about how many there are. The cost of the bound is stated: "six
 * of the dashboard views" is three words apart and this guard does not read it
 * as a claim.
 */
const FILLER = "(?:[a-z][a-z-]*\\s+){0,2}";

/**
 * A quantity and the noun it counts are in ONE PARAGRAPH. `\s+` spans blank
 * lines, and across a blank line a figure at the end of one paragraph was being
 * read as counting a noun at the start of the next — which is how a JSON blob
 * in a bundled file "claimed" a number of views.
 */
const SAME_PARAGRAPH = (matched: string): boolean => !/\n\s*\n/.test(matched);

/** The value a matched quantity states, or `null` when it names none. */
function quantityValue(raw: string): number | null {
  const key = raw.toLowerCase();
  if (/^\d+$/.test(key)) return Number(key);
  if (key in GROUP_WORDS) return GROUP_WORDS[key]!;
  if (key in NUMBER_WORDS) return NUMBER_WORDS[key]!;
  return null; // a vague quantity: matched deliberately, resolved to nothing
}

// ------------------------------------------------------------- the subjects

interface Subject {
  key: string;
  /** the noun, as a document writes it */
  noun: string;
  truth: (r: DocumentRules) => number;
  /** the constant read back out of a commit, for a review record */
  atCommit: (sha: string) => number | null;
}

const SUBJECTS: readonly Subject[] = [
  { key: "views", noun: "views?", truth: (r) => r.views, atCommit: viewsAtCommit },
  { key: "screens", noun: "screens?", truth: (r) => r.screens, atCommit: screensAtCommit },
  { key: "tools", noun: "(?:MCP\\s+)?tools?", truth: (r) => r.tools, atCommit: toolsAtCommit },
];

/**
 * The guard against reading a SECTION NUMBER as a count: a `§`-reference such
 * as the internal phase plan's own numbering, or an Appendix delta id, is a
 * reference and not a quantity, and neither is a date such as `2026-08-11`.
 */
const NOT_A_QUANTITY_BEFORE = "(?<![.\\d§#§-])";

/**
 * The shapes that match a `tools` claim and are NOT about the MCP adapter,
 * because `tools/` is also a DIRECTORY of this repository beside `src` and
 * `test`. Both demand evidence of the directory in the same sentence — another
 * directory counted in the same clause, or a path under `tools/` — and not
 * merely a word standing next to a digit.
 */
const TOOLS_DIRECTORY_CENSUS = /\b\d+\s+(?:src|test)\b[^.]{0,80}?\b\d+\s+tools?\b/i;
const TOOLS_DIRECTORY_PATH = /`?tools\/[a-z0-9-]+/i;

interface Claim {
  subject: Subject;
  /** the number the document states, or null for a vague quantity */
  value: number | null;
  raw: string;
  at: number;
  length: number;
}

function claimsIn(text: string, subject: Subject): Claim[] {
  const re = new RegExp(`${NOT_A_QUANTITY_BEFORE}\\b(${QUANTITY})\\s+${FILLER}(?:${subject.noun})\\b`, "gi");
  const out: Claim[] = [];
  for (const m of text.matchAll(re)) {
    if (!SAME_PARAGRAPH(m[0])) continue;
    // THE ONE SHAPE THAT MATCHES AND IS NOT A CLAIM ABOUT THE ADAPTER: a census
    // of the source tree, where `tools` is a DIRECTORY beside `src` and `test`.
    // "all 13 src, 13 test and 2 tools TypeScript files" counts files in
    // `tools/`; it says nothing about how many tools `tools/list` advertises.
    // The exclusion demands the census — another directory of the same tree,
    // counted in the same clause — and not merely a word next to a digit.
    if (subject.key === "tools") {
      const sentence = sentenceAround(text, m.index, m[0].length);
      if (TOOLS_DIRECTORY_CENSUS.test(sentence) || TOOLS_DIRECTORY_PATH.test(sentence)) continue;
    }
    out.push({ subject, value: quantityValue(m[1]!), raw: m[1]!, at: m.index, length: m[0].length });
  }
  return out;
}

// ------------------------------------------------------- records, and the SHA

/**
 * The SENTENCE a match sits in — bounded, not a character window. A window of N
 * characters is a guess and it is the wrong guess in both directions. Comment
 * prefixes are stripped, because a sentence wrapped across the lines of a SQL
 * or TypeScript comment is still one sentence.
 */
export function sentenceAround(text: string, index: number, length: number): string {
  const starts = [text.lastIndexOf(". ", index), text.lastIndexOf(".\n", index), text.lastIndexOf("\n\n", index)];
  const from = Math.max(0, ...starts.map((i) => (i < 0 ? 0 : i + 1)));
  const dot = text.indexOf(".", index + length);
  const to = dot < 0 ? text.length : dot + 1;
  return text.slice(from, to).replace(/^[\s>]*(--|\/\/|\*)\s?/gm, " ");
}

const resolved = new Map<string, boolean>();

/** Whether this repository can resolve `ref` to a commit of its own. */
function resolvesToCommit(ref: string): boolean {
  const cached = resolved.get(ref);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "-q", "--verify", `${ref}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    ok = true;
  } catch {
    ok = false;
  }
  resolved.set(ref, ok);
  return ok;
}

/**
 * Every commit id a document names that this repository can resolve —
 * ABBREVIATED ONES INCLUDED, because that is how this repository's own records
 * write them (`3bdfef2`, `d09a8a1`). A 7-hex string that is not a commit here
 * resolves to nothing and is therefore not one.
 */
export function commitsNamedBy(text: string): string[] {
  const out: string[] = [];
  for (const m of new Set(text.match(/\b[0-9a-f]{7,40}\b/g) ?? [])) {
    if (resolvesToCommit(m)) out.push(m);
  }
  return out;
}

export function headCommit(): string {
  return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function sourceAtCommit(sha: string, path: string): string | null {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "show", `${sha}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 24,
    });
  } catch {
    return null;
  }
}

function listLengthAt(sha: string, path: string, constant: string): number | null {
  const source = sourceAtCommit(sha, path);
  if (source === null) return null;
  const literal = new RegExp(`${constant}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (literal === null) return null;
  const entries = literal[1]!.match(/"[a-z_]+"/g);
  return entries === null ? null : entries.length;
}

function viewsAtCommit(sha: string): number | null {
  return listLengthAt(sha, "src/dashboard.ts", "DASHBOARD_VIEWS");
}

function screensAtCommit(sha: string): number | null {
  return listLengthAt(sha, "src/dashboard.ts", "FLEET_SCREENS");
}

/** How many tools `MCP_TOOLS` advertised at a commit, from that commit's own
 *  source. Round 4 never asked this question and reported every tool claim in
 *  every record as unverifiable — sixty plantings that nothing caught. */
function toolsAtCommit(sha: string): number | null {
  const source = sourceAtCommit(sha, "src/mcp.ts");
  if (source === null) return null;
  const start = source.indexOf("MCP_TOOLS");
  if (start < 0) return null;
  const names = source.slice(start).match(/^\s{4}name: "/gm);
  return names === null ? null : names.length;
}

/** A document that DECLARES itself a review record in its own first heading. */
function declaresItselfARecord(text: string): boolean {
  const heading = /^#\s+(.+)$/m.exec(text);
  return heading !== null && /\b(independent review|review verdicts?|verdict)\b/i.test(heading[1]!);
}

/**
 * A record is a document that says it is one AND names a build this repository
 * can read back. A heading alone is text, and a reviewer proved that by writing
 * one into `skills/README.md`.
 */
export function isBoundReviewRecord(text: string): boolean {
  return declaresItselfARecord(text) && commitsNamedBy(text).length > 0;
}

/** The anchor a sentence may carry, naming the code constant it counts. */
const ANCHOR_RE = /\[skln:count=([a-z_]+)\]/;

/**
 * The views a sentence NAMES, out of the code's own list.
 *
 * `dead_letters` is written `dead letters` in prose as often as in code, so both
 * spellings count as the same member — and the member is only counted once, or
 * a sentence that used both spellings would inflate its own set.
 */
/** Whether a set of view names IS one of the sets the code defines, as a set.
 *  Five names that happen to be five is not a claim about a code set; the five
 *  the phase plan lists, or §9's five screens, is. */
function isCodeDefinedSet(named: readonly string[]): boolean {
  const key = [...named].sort().join(",");
  return [DASHBOARD_VIEWS, PHASE_PLAN_VIEWS, FLEET_SCREENS].some((set) => [...set].sort().join(",") === key);
}

/** Every size a set of this subject has in the code, so a historical claim can
 *  be answered without reading a constant that did not exist yet. */
function codeDefinedSizes(subject: string, rules: DocumentRules): number[] {
  const all = subject === "tools" ? [rules.tools] : [rules.views, PHASE_PLAN_VIEWS.length, FLEET_SCREENS.length];
  return [...new Set(all)].sort((a, b) => a - b);
}

function namedViews(sentence: string): string[] {
  const lower = sentence.toLowerCase();
  return DASHBOARD_VIEWS.filter((v) => lower.includes(v) || lower.includes(v.replace(/_/g, " ")));
}

// --------------------------------------------------------------- the families

/**
 * [I-6]'s claim family: WHERE A COUNTED RECIPIENT COMES FROM. Applies to every
 * document without exception — where a count is read from is a fact about this
 * schema and not about any particular build.
 */
const NOT_A_CURRENT_CLAIM = /\b(never|not|no longer|used to|would|cannot|must not|before|was|were|had been|already)\b/i;

/**
 * A SENTENCE THAT SPEAKS OF NOW, and therefore of TODAY'S code.
 *
 * A review record's exemption exists so that an accepted verdict about a past
 * build is not rewritten to agree with the present. It does not extend to a
 * sentence that says the present: "the dashboard CURRENTLY has five views" is a
 * claim about this build, and a baseline SHA further up the page does not make
 * it true.
 *
 * WHAT THIS DOES AND DOES NOT CATCH, stated rather than implied. It is a closed
 * list of present-TIME adverbials, not a tense parser: an English present-tense
 * verb with no adverbial ("the dashboard has five views") is NOT caught here,
 * and is left to the binding rule below, which is what actually carries the
 * weight. The adverbials are here because they are the phrasings under which a
 * record's exemption is plainly not being claimed at all.
 */
const PRESENT_TIME = /\b(currently|right now|as of today|as of now|at present|presently|as it stands|today's)\b/i;

function provenanceLies(text: string, permitted: ReadonlySet<string>, tables: readonly string[]): string[] {
  const out: string[] = [];
  const named = tables.filter((t) => !permitted.has(t)).join("|");
  if (named.length === 0) return out;
  const claim = new RegExp(
    String.raw`(?:recipient|migration|count|counted)[\s\S]{0,120}?\b(?:read|computed|obtained|answered|taken|comes?|counted)\s+from\s+(?:the\s+)?(?:INSERT-only\s+)?` +
      "`?(" + named + ")\\b",
    "gi",
  );
  for (const m of text.matchAll(claim)) {
    const sentence = sentenceAround(text, m.index, m[0].length);
    if (NOT_A_CURRENT_CLAIM.test(sentence)) continue;
    out.push(`claims a counted recipient is read from \`${m[1]}\`: ${JSON.stringify(sentence.slice(0, 160))}`);
  }
  return out;
}

export interface DocumentReading {
  /** the ONLY bucket. A claim nobody can check is in it too. */
  wrong: string[];
  count_claims: number;
  record: boolean;
}

/**
 * ONE DOCUMENT, AGAINST THE CODE.
 *
 * The same function the sweep runs and the planting proof runs — there is no
 * second implementation for the test to agree with itself about.
 */
export function readDocument(name: string, text: string, rules: DocumentRules): DocumentReading {
  const wrong: string[] = [];
  const record = isBoundReviewRecord(text);
  const commits = record ? commitsNamedBy(text) : [];
  let claims = 0;

  for (const subject of SUBJECTS) {
    for (const claim of claimsIn(text, subject)) {
      claims += 1;
      const sentence = sentenceAround(text, claim.at, claim.length);
      const where = `${name}: ${JSON.stringify(sentence.trim().slice(0, 140))}`;

      // A VAGUE QUANTITY NAMES NO VALUE, and no build can confirm or refute it.
      if (claim.value === null) {
        wrong.push(`${where} — \`${claim.raw} ${subject.key}\` states a count nothing can be checked against`);
        continue;
      }

      // A CLAIM IS TRUE IF ANY ONE OF THE CHECKS BELOW SAYS SO, and each of
      // them is a comparison against CODE. They are not degrees of leniency:
      // they are the three different sets a sentence in this repository can be
      // counting, and a claim that matches none of them is refused.

      // (1) THE WHOLE SET, as the code ships it today.
      const truth = subject.truth(rules);
      if (claim.value === truth) continue;

      // (2) AN ANCHOR NAMING A CODE CONSTANT. It is how a sentence about a set
      //     that is not the obvious one says which one it means, and how a
      //     record speaks of a build whose code cannot answer for it.
      const anchor = ANCHOR_RE.exec(sentence);
      if (anchor !== null) {
        const anchored = rules.anchors[anchor[1]!];
        if (anchored === undefined) {
          wrong.push(`${where} — the anchor \`${anchor[1]}\` names no code constant`);
        } else if (claim.value !== anchored) {
          wrong.push(`${where} — claims ${claim.value} where \`${anchor[1]}\` has ${anchored}`);
        }
        continue;
      }

      // (3) THE SENTENCE NAMES ITS MEMBERS. "the five named views — library,
      //     evidence, receipts, approvals, dead letters" is a claim about a set
      //     whose members are written beside the number, and the members are
      //     code. This is the strongest binding available: it needs no anchor,
      //     no commit and no heading, because the sentence says which set it
      //     means.
      const named = namedViews(sentence);
      if (subject.key !== "tools" && named.length === claim.value && isCodeDefinedSet(named)) continue;

      // (4) THE BUILD A REVIEW RECORD NAMES — ONE CLAIM BOUND TO ONE COMMIT.
      //
      //     ROUND 5 TOOK "one of the commits this document mentions" AS THE
      //     BINDING, and a reviewer took it apart in a sentence: a record that
      //     names the candidate AND its baseline, and then writes "the dashboard
      //     currently has five views", agrees with the BASELINE and passes,
      //     while saying something false about the build it is reviewing.
      //     Agreeing with one of several is not a binding — it is a search for a
      //     commit that makes the sentence true, run by the guard, on the
      //     document's behalf.
      //
      //     So: a sentence in the PRESENT TENSE is about the present and is
      //     checked against today's code, record or no record (that is the `if`
      //     below refusing to take this branch at all). Otherwise the claim is
      //     bound to the commits ITS OWN SENTENCE names; where the sentence
      //     names none, to the document's — and those must AGREE about the
      //     constant. Two different answers among them is a refusal that says so
      //     and asks the sentence to name which build it means.
      if (record && !PRESENT_TIME.test(sentence)) {
        const inSentence = commitsNamedBy(sentence);
        const bound = inSentence.length > 0 ? inSentence : commits;
        const scope = inSentence.length > 0 ? "the commit its sentence names" : "the commits the record names";
        const reviewed = [...new Set(bound.map((sha) => subject.atCommit(sha)).filter((n): n is number => n !== null))];
        if (reviewed.length > 1) {
          wrong.push(
            `${where} — a review record claims ${claim.value} ${subject.key} and ${scope} ship ${reviewed.join(" or ")}: ` +
              "agreeing with one of several named commits is not a binding, so the sentence must name the build it is true at",
          );
          continue;
        }
        if (reviewed.length === 1) {
          if (reviewed[0] === claim.value) continue;
          wrong.push(`${where} — a review record claims ${claim.value} ${subject.key}; ${scope} ships ${reviewed[0]}`);
          continue;
        }
        // THE CONSTANT DID NOT EXIST AT ANY COMMIT THE RECORD NAMES — a P5
        // verdict speaking of the dashboard the phase plan had not built yet.
        // There is still NO BUCKET FOR "cannot be checked": the claim is
        // admitted only if it is the size of SOME code-defined set of this
        // subject, and refused otherwise. That is weaker than reading the
        // constant back and it is stated as weaker — its purpose is that an
        // accepted verdict is not rewritten to agree with the present, and its
        // limit is that a record could name a size that belongs to a different
        // set of the same kind.
        const sizes = codeDefinedSizes(subject.key, rules);
        if (sizes.includes(claim.value)) continue;
        wrong.push(
          `${where} — a review record claims ${claim.value} ${subject.key}; the constant cannot be read at any commit it names, ` +
            `and ${claim.value} is not the size of any ${subject.key} set this code defines (${sizes.join(", ")})`,
        );
        continue;
      }

      wrong.push(`${where} — claims ${claim.value} ${subject.key}; the code ships ${truth}`);
    }
  }

  for (const lie of provenanceLies(text, rules.permitted, rules.tables)) wrong.push(`${name}: ${lie}`);

  // A DOCUMENT THAT ENUMERATES THE VIEWS MUST ENUMERATE THEM ALL — a partial
  // list reads as a whole one. "Enumerates" is five or more of the names,
  // because the names are ordinary words.
  const enumerated = DASHBOARD_VIEWS.filter((v) => text.includes(`\`${v}\``) || text.includes(`**${v}**`));
  if (!record && enumerated.length >= 5 && !DASHBOARD_VIEWS.every((v) => text.includes(v))) {
    wrong.push(`${name}: names ${enumerated.length} dashboard views and not all ${rules.views}`);
  }
  return { wrong, count_claims: claims, record };
}

// ----------------------------------------------------------------- the proof

/**
 * The claim families, each a sentence a document could actually contain. The
 * paraphrases are here because a guard that catches only the phrasing it was
 * shown is the defect this repository keeps paying for.
 */
export const LIES: ReadonlyArray<{ family: string; text: string }> = [
  { family: "view count, in figures", text: "\n\nThe dashboard has 6 read-only views.\n" },
  { family: "view count, in words", text: "\n\nThe dashboard has six read-only views.\n" },
  { family: "view count, paraphrased", text: "\n\nThe dashboard ships half a dozen views.\n" },
  { family: "screen count", text: "\n\nSection 9 specifies twelve screens.\n" },
  { family: "screen count, paraphrased", text: "\n\nSection 9 specifies a half-dozen screens.\n" },
  { family: "tool count", text: "\n\nThe MCP adapter advertises twenty tools.\n" },
  { family: "tool count, paraphrased", text: "\n\nThe MCP adapter advertises a dozen MCP tools.\n" },
  { family: "a count nothing can check", text: "\n\nThe MCP adapter advertises several tools.\n" },
  { family: "provenance", text: "\n\nThe recipient of a counted migration is read from `adoption_receipts`.\n" },
];

/**
 * THE HARNESS PROVES ITS OWN SUBSTITUTION. A planting that changed nothing
 * would "survive" for the wrong reason and read as a guard's failure.
 */
export function plant(name: string, text: string, lie: string): string {
  assert.equal(text.includes(lie.trim()), false, `${name} already contains ${JSON.stringify(lie.trim())}`);
  const mutated = text + lie;
  assert.equal(mutated.split(lie.trim()).length - 1, 1, `the lie is not in ${name} exactly once`);
  assert.equal(mutated.length, text.length + lie.length, `planting in ${name} moved other bytes`);
  return mutated;
}

/** Exported so a test can print what the guard was actually told the truth is. */
export { MIGRATION_SOURCE };
