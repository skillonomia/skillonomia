// [B-5] — EVERY ABSOLUTE STATEMENT IN A DELIVERED DOCUMENT, AGAINST THE TREE.
//
// THE HISTORY, because it is the argument. Eight consecutive release reviews
// each found EXACTLY ONE false statement in a shipped document, and each one was
// new:
//
//   1. `README.md` counted 714 tests where the suite ran 1029.
//   2. `README.md` offered an `npx` form and a container image the release does
//      not publish.
//   3. `README.md` advertised `bun test`, which fails.
//   4. `README.md` said the binary "is not downloadable anywhere" while
//      `.github/workflows/ci.yml` uploaded it on every push.
//   5. `README.md` stated a number of dashboard views the code disagreed with.
//   6. `README.md` said "Every surface exists twice — REST … and MCP …" while
//      `docs/API.md`, IN THE SAME TREE, listed four REST-only surfaces.
//
// Every one was repaired where it stood and closed by a guard of its own. That
// is eight guards for eight sentences, found one per review round, each round
// costing a rebuild of the public mirror and a fresh read. The defects are not
// eight accidents: they are ONE CLASS — a delivered document asserting
// UNIVERSALITY, UNIQUENESS or ABSENCE about an artifact of this tree, and the
// tree not agreeing.
//
// So this file takes the class rather than the ninth sentence.
//
// ---------------------------------------------------------------------------
// WHAT IS SCANNED, AND WHY IT IS NOT A LIST
//
// The words that mark the class — `every`, `each`, `all`, `no`, `none`,
// `never`, `always`, `only`, `cannot`, `impossible`, `sole`, `must`,
// `exactly` — are searched for in the DELIVERED DOCUMENTS, and the sentence
// around each hit is the claim. No sentence is written down here; the set comes
// out of the files. That is deliberate: a hand-kept list of claims is the exact
// mechanism that let six of the eight defects above ship, and `test/docs-guard.ts`
// has already had to replace such a list twice.
//
// ---------------------------------------------------------------------------
// THE LIMIT, STATED OUT LOUD — READ THIS BEFORE TRUSTING ANYTHING ABOVE
//
//   THIS SCANNER DOES NOT UNDERSTAND ENGLISH. It matches a FORM — a closed list
//   of absolute words — and not a meaning. A sentence that asserts universality
//   WITHOUT one of those words is invisible to it:
//
//       "The registry ships source, and nothing else."   (no listed word)
//       "Both adapters expose the same surface."          (no listed word)
//
//   Neither would be seen here, and neither is claimed to be. The mitigation is
//   the same one `docs-guard.ts` uses for quantities: the word list is a
//   PROHIBITION as much as a detector — a document that wants to make an
//   absolute claim has an obvious vocabulary for it, and the vocabulary is
//   swept. It is not a proof that no unswept phrasing exists.
//
//   SECOND LIMIT: what is CHECKED is the claim's REFERENTS, not its logic. When
//   a sentence says "`src/gates.ts` runs all eight safety gates", this file
//   resolves `src/gates.ts` and compares `eight` with `GATE_NAMES.length`. It
//   does not decide whether "all" is true of the gates' behaviour — that is what
//   the other thousand tests are for. A claim whose referents all resolve is
//   therefore ANCHORED, not proven.
//
//   THIRD LIMIT: the total partition (every claim either checked or declared)
//   is run over the READER-FACING delivered documents. `SPEC.md` and the
//   shipped skill package get the REFERENCE and COUNT checks — so a wrong
//   number or a dead path in them still fails the build — but not the residue
//   partition, because their claim sets
//   are an order of magnitude larger and a table of that size with a written
//   reason per row would be a rubber stamp rather than a decision. Which
//   documents get which treatment is a ROSTER below, and a delivered document
//   in neither half of the roster fails the build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { GATE_NAMES, SHELL_SEVERITY } from "../src/gates.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { REPO_ROOT, packedFiles, trackedMarkdown, DocumentSetUnavailable } from "./docs-guard.ts";

export { DocumentSetUnavailable };

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

// --------------------------------------------------------------- the subject

/**
 * DOCUMENTS THIS REPOSITORY DELIVERS, as opposed to documents it keeps.
 *
 * The set is DISCOVERED — `npm pack`'s own file list plus every Markdown file
 * git tracks — and then narrowed by three rules, each of which is about what a
 * file IS rather than about which file it is:
 *
 *   * `reviews/**` is the record of a review already accepted. Its bytes ARE
 *     the record; a sentence in it is a true statement about the build it
 *     reviewed. `docs-guard.ts` carries the same exclusion, for the same
 *     reason, and the machinery that binds such a claim to its commit.
 *   * `fixtures/**` and any `vectors/` directory hold BYTE-FROZEN test
 *     payloads. Their prose is data — hashed, signed and compared — not an
 *     assertion this project makes, and editing one to narrow a sentence would
 *     break the digests that make them vectors at all.
 *   * files that are bytes rather than prose.
 *
 * Anything else this repository tracks or ships is a document it delivers.
 */
const NOT_PROSE = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|tgz|gz|wasm|bundle|tsv|sha256)$/i;
const IS_RECORD = /^reviews\//;
const IS_FROZEN_PAYLOAD = /^fixtures\/|(^|\/)vectors\//;

export function deliveredDocuments(): Array<[string, string]> {
  const all = [...new Set([...packedFiles(), ...trackedMarkdown()])].sort();
  const docs = all.filter(
    (p) => p.endsWith(".md") && !NOT_PROSE.test(p) && !IS_RECORD.test(p) && !IS_FROZEN_PAYLOAD.test(p),
  );
  if (docs.length === 0) {
    throw new DocumentSetUnavailable(
      "REFUSED: no delivered document was found. An empty subject is not a passing subject: nothing would be " +
        "scanned and nothing would be reported.",
    );
  }
  return docs.map((rel) => [rel, read(rel)] as [string, string]);
}

/**
 * THE ROSTER — which delivered document gets which treatment.
 *
 * `PARTITIONED` documents describe this software to whoever received it: every
 * absolute claim in them is CHECKED or DECLARED, with nothing in between.
 *
 * `REFERENCED_ONLY` documents get the reference and count checks and not the
 * residue partition. Each entry carries the reason, and the reason is the same
 * shape every time — the document's claim set is an order of magnitude larger
 * than a written-reason table can honestly hold. This is the third limit named
 * at the head of this file, and it is a GAP, not a clean bill.
 *
 * A delivered document in NEITHER list fails the build, which is the part that
 * makes this a roster rather than a filter: a new document cannot arrive
 * unclassified.
 */
export const PARTITIONED: ReadonlyArray<RegExp> = [
  /^README\.md$/,
  /^docs\/[A-Za-z0-9_.-]+\.md$/,
  /^SECURITY\.md$/,
  /^CONTRIBUTING\.md$/,
  /^skills\/README\.md$/,
  /^seed\/[^/]+\/SKILL\.md$/,
];

export const REFERENCED_ONLY: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^SPEC\.md$/,
    why:
      "the normative format-and-protocol specification: ~600 absolute sentences, nearly all of them RFC-2119 " +
      "requirements whose truth is the conformance suite's subject (test/spec-parity.test.ts, test/vectors.test.ts, " +
      "test/schema-conformance.test.ts). Its references and counts are checked here; its residue is not partitioned.",
  },
  {
    pattern: /^skills\/git-bundle-verify\//,
    why:
      "a shipped skill package under the no-touch rule: its `SKILL.md` is the runbook an adopter executes and its " +
      "bytes are covered by test/skill-git-bundle-verify.test.ts. Its claims are checked, never rewritten.",
  },
];

export function rosterOf(name: string): "partitioned" | "referenced-only" | null {
  if (PARTITIONED.some((re) => re.test(name))) return "partitioned";
  if (REFERENCED_ONLY.some((r) => r.pattern.test(name))) return "referenced-only";
  return null;
}

// ---------------------------------------------------------------- the claims

/**
 * THE ABSOLUTE VOCABULARY. Universality (`every`, `each`, `all`, `always`),
 * uniqueness (`only`, `sole`, `exactly`), absence (`no`, `none`, `never`) and
 * impossibility (`cannot`, `impossible`), plus the obligation word (`must`)
 * that turns a description into a rule.
 */
export const ABSOLUTE_WORDS: readonly string[] = [
  "every", "each", "all", "no", "none", "never", "always", "only", "cannot", "impossible", "sole", "must", "exactly",
];

const ABSOLUTE_RE = new RegExp(`(?<![\\w-])(${ABSOLUTE_WORDS.join("|")})(?![\\w-])`, "gi");

/**
 * Fenced and indented code, and HTML comments, BLANKED rather than removed —
 * every remaining character keeps its offset, so a sentence's bounds are the
 * bounds it has in the file. A shell transcript is a thing to RUN, not a thing
 * to read a claim out of, and `# no such file` in one is not this project
 * asserting an absence.
 */
export function prose(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?```/g, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * The sentence a hit sits in. Bounded by sentence punctuation, by a blank line,
 * and by the start of a list item, heading, quote or table row — a Markdown
 * bullet is a sentence's worth of claim whether or not it ends in a full stop.
 * A full stop that follows a digit, a capital or `§` is an ordinal or a version
 * (`22.6`, `§4.1b`, `R4.`) and does not end anything.
 */
const BOUNDARY = /(?:(?<![0-9A-Z§])[.!?](?=[\s)"'’]))|\n\s*\n|\n(?=\s*[-*+#>|])/;
const BOUNDARY_G = new RegExp(BOUNDARY.source, "g");

export function sentenceAt(text: string, index: number, length: number): string {
  let from = 0;
  for (const m of text.slice(0, index).matchAll(BOUNDARY_G)) from = m.index + m[0].length;
  const rest = text.slice(index + length);
  const end = BOUNDARY.exec(rest);
  const to = end === null ? text.length : index + length + end.index + end[0].length;
  return text.slice(from, to).trim().replace(/\s+/g, " ");
}

export interface AbsoluteClaim {
  document: string;
  sentence: string;
  /** the absolute words that put this sentence in the set, lower-cased */
  words: string[];
  digest: string;
}

/** The digest a claim is keyed by: the sentence, and nothing else. */
export function claimDigest(sentence: string): string {
  return createHash("sha256").update(sentence.trim(), "utf8").digest("hex");
}

export function absoluteClaims(name: string, text: string): AbsoluteClaim[] {
  const t = prose(text);
  const bySentence = new Map<string, Set<string>>();
  for (const m of t.matchAll(ABSOLUTE_RE)) {
    const sentence = sentenceAt(t, m.index, m[0].length);
    if (sentence.length === 0) continue;
    let words = bySentence.get(sentence);
    if (words === undefined) {
      words = new Set<string>();
      bySentence.set(sentence, words);
    }
    words.add(m[1]!.toLowerCase());
  }
  return [...bySentence].map(([sentence, words]) => ({
    document: name,
    sentence,
    words: [...words].sort(),
    digest: claimDigest(sentence),
  }));
}

// ------------------------------------------------------------ the referents

export interface Reference {
  kind: "path" | "npm-script" | "subcommand" | "mcp-tool" | "rest-route" | "env";
  token: string;
}

/** The subcommands `src/cli-commands.ts` dispatches, read from the dispatcher. */
export function subcommands(): string[] {
  const body = /export async function runCli\([\s\S]*?\n\}/.exec(read("src/cli-commands.ts"));
  assert.ok(body, "runCli not found in src/cli-commands.ts — this guard is reading the wrong thing");
  const found = [...body[0].matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!).filter((c) => !c.startsWith("-"));
  assert.ok(found.length > 0, "no subcommand cases parsed out of runCli — this guard is reading the wrong thing");
  return [...new Set(found)].sort();
}

/** The scripts `package.json` defines. */
export function npmScripts(): Record<string, string> {
  return JSON.parse(read("package.json")).scripts ?? {};
}

/**
 * Paths a script of this package WRITES — `dist/skillonomia`, `dist-js/cli.js`.
 * They are real artifacts of this tree and a document may name them, but a
 * clean checkout has not built them yet, so "does the file exist" is the wrong
 * question and "does a script produce it" is the right one.
 */
export function declaredBuildOutputs(): string[] {
  const out: string[] = [];
  for (const script of Object.values(npmScripts())) {
    for (const m of script.matchAll(/--outfile[= ]([^\s]+)/g)) out.push(m[1]!);
  }
  // …and the files the WORKFLOW writes. `ci/quickstart-transcript.txt` is the
  // release delivery record: three delivered documents name it, CI produces it
  // on every run, and a clean checkout has never had one. Same question, same
  // answer: not "does the file exist" but "does something here produce it".
  const workflow = read(".github/workflows/ci.yml");
  for (const m of workflow.matchAll(/\btee\s+([A-Za-z0-9_./-]+)|>\s*([A-Za-z0-9_./-]+\.[a-z]+)\b/g)) {
    out.push((m[1] ?? m[2]!).trim());
  }
  return [...new Set(out)];
}

/**
 * The SKILL PACKAGES this repository ships, as directories a document's path
 * may be relative to. `fixtures/tv01.sh` in `SPEC.md` is a member of the seed
 * package; it is not a file at this repository's root and was never meant to be.
 */
let packageDirCache: string[] | null = null;
export function packageDirectories(): string[] {
  if (packageDirCache !== null) return packageDirCache;
  const dirs = new Set<string>();
  for (const rel of trackedFiles()) {
    const m = /^(seed\/[^/]+|vectors\/[^/]+\/package|skills\/[^/]+)\//.exec(rel);
    if (m) dirs.add(m[1]!);
  }
  packageDirCache = [...dirs].sort();
  return packageDirCache;
}

/** Every REST route `src/http.ts` serves, parsed out of the router itself. */
export function restRoutes(): Set<string> {
  const lines = read("src/http.ts").split("\n");
  const found = new Set<string>();
  let pending: string | null = null;
  let decisions = 0;
  const unparsed: string[] = [];
  const normalize = (r: string): string => r.replace(/\{[^}]+\}/g, "*").replace(/\(\[\^\/\]\+\)/g, "*");
  for (const line of lines) {
    const rx = /^\s*(?:let |const )?m = \/\^(.*?)\$\/\.exec\(path\);/.exec(line);
    if (rx) pending = rx[1]!.replace(/\\\//g, "/");
    if (!/method === "([A-Z]+)"/.test(line)) continue;
    decisions += 1;
    const method = /method === "([A-Z]+)"/.exec(line)![1]!;
    const literal = /path === "([^"]+)"/.exec(line);
    if (literal) {
      found.add(`${method} ${normalize(literal[1]!)}`);
      continue;
    }
    if (/&& m\)/.test(line) && pending !== null) {
      found.add(`${method} ${normalize(pending)}`);
      pending = null;
      continue;
    }
    unparsed.push(line.trim());
  }
  assert.deepEqual(unparsed, [], "src/http.ts has a route shape this guard's parser does not understand");
  assert.equal(found.size, decisions, "every routing decision in src/http.ts must yield exactly one route");
  return found;
}

/**
 * Every `SKILLONOMIA_*` name this tree actually reads — from the sources, the
 * tools, the entry point, the CI scripts, the workflow and the image. A
 * variable a document tells an operator to set is a real variable wherever it is
 * read, so the sweep is not `src/` alone: in this tree
 * `SKILLONOMIA_SIGNING_SEED_HEX` is read by `tools/pack-skill.ts` and by nothing
 * under `src/`, and a sweep of the sources alone would not know the name at all.
 *
 * `test/` IS NOT IN THE SWEEP, and the omission is the point twice over. A
 * variable only a test reads is not a variable an operator can be told to set —
 * and this file's own planting proof names `SKILLONOMIA_TLS_CERT` to show that
 * an invented variable is caught. Sweeping `test/` would let the proof satisfy
 * itself: the moment the probe was committed, the invented name became a name
 * something in the tree "reads", and the probe passed for the wrong reason.
 */
export function environmentNames(): Set<string> {
  const names = new Set<string>();
  for (const rel of trackedFiles()) {
    if (!/^(src|tools|bin|ci|\.github)\/|^Dockerfile$/.test(rel)) continue;
    if (NOT_PROSE.test(rel) || rel.endsWith(".md")) continue;
    for (const m of read(rel).matchAll(/SKILLONOMIA_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  return names;
}

const MCP_NAMESPACES = [...new Set(MCP_TOOLS.map((t) => t.name.split(".")[0]!))];
// `[a-z][a-z0-9_]*` and not `[a-z_]+`: a tool renamed `skill.adopt2` has to be
// read as a tool that is not advertised, not shrugged off as some other token.
const MCP_TOOL_RE = new RegExp(`^(?:${MCP_NAMESPACES.join("|")})\\.[a-z][a-z0-9_]*$`);
const MCP_NAMES = new Set<string>(MCP_TOOLS.map((t) => t.name));

/** A file extension, so `skill.json` is not read as the tool `skill.<verb>`. */
const EXTENSION = /\.(md|ts|js|mjs|cjs|json|sql|sh|yml|yaml|tsv|jws|txt|lock|sha256|bundle|tar|gz|template)$/i;

/** Paths that name a place OUTSIDE this tree: a container, a host, a URL. */
const FOREIGN_PATH = /^(?:https?:|\/(?:app|data|tmp|etc|usr|var|proc|dev|home)\b|~|\$)/;
/** A path a document writes with a placeholder in it (`reviews/phase-NN.verdict.md`). */
const PLACEHOLDER = /NN|XX|\{[^}]*\}|<[^>]*>|\*/;

/**
 * A ROUTE a document may be naming: `/v1/<something>`, or one of the two
 * unversioned mounts. `/v1` alone is a BASE and names no route, and a lone `/`
 * is a leading slash somebody wrote about.
 */
const ROUTE_SHAPE = /^(?:\/v1\/[A-Za-z0-9/{}_.-]+|\/health|\/mcp)$/;

/**
 * The referents a sentence names. Only what is written as CODE counts: prose
 * mentions `docs` and `the migrations` constantly, and a guard that resolved
 * those would be guessing at which noun was a filename.
 *
 * A BARE FILENAME IS NOT A PATH OF THIS REPOSITORY. `SKILL.md`, `skill.json`,
 * `manifest.json` and `expected.json` are members of a skill package, of an
 * archive or of a vector directory, and the shipped documents name them
 * constantly without ever meaning a file that sits in this tree. So only a
 * ROOTED path is resolved — one whose first segment is a directory that
 * exists, tried against the document's own directory first and the repository
 * root second, so `vectors/MATRIX.tsv` inside a skill package means that
 * package's vectors and not the repository's.
 */
export function referencesIn(sentence: string): Reference[] {
  const out: Reference[] = [];
  const add = (kind: Reference["kind"], token: string): void => {
    if (!out.some((r) => r.kind === kind && r.token === token)) out.push({ kind, token });
  };
  for (const m of sentence.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1]!.trim();
    // A span with whitespace is a COMMAND LINE, not a name: read the commands
    // out of it and do not try to read its arguments as paths.
    if (/\s/.test(span)) {
      for (const c of span.matchAll(/\bnpm run (-s )?([a-z][a-z0-9:_-]*)/g)) add("npm-script", c[2]!);
      for (const c of span.matchAll(/\bskillonomia ([a-z][a-z-]*)/g)) add("subcommand", c[1]!);
      for (const c of span.matchAll(/\b(?:node|bun)(?: run)? (?:--[a-z-]+ )*((?:src|tools|test|bin|dist-js)\/[A-Za-z0-9_./-]+)/g)) {
        add("path", c[1]!);
      }
      for (const c of span.matchAll(/\b(GET|POST|DELETE|PUT|PATCH) (\/[A-Za-z0-9/{}_.-]*)/g)) {
        const path = c[2]!;
        if (ROUTE_SHAPE.test(path)) add("rest-route", `${c[1]} ${path.replace(/\{[^}]+\}/g, "*")}`);
      }
      continue;
    }
    if (/^SKILLONOMIA_[A-Z0-9_]+$/.test(span)) {
      add("env", span);
      continue;
    }
    if (MCP_TOOL_RE.test(span) && !EXTENSION.test(span)) {
      add("mcp-tool", span);
      continue;
    }
    if (span.startsWith("/")) {
      if (ROUTE_SHAPE.test(span)) add("rest-route", `ANY ${span.replace(/\{[^}]+\}/g, "*")}`);
      continue;
    }
    if (FOREIGN_PATH.test(span)) continue;
    // A ROOTED path with a file-ish tail: `src/gates.ts`, `migrations/`,
    // `reviews/phase-NN.verdict.md`. `tools/list` is an MCP method name and not
    // a file, and it is skipped because its last segment carries no extension
    // and it does not end in a slash.
    const clean = span.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (/[^A-Za-z0-9_./{}<>*-]/.test(clean)) continue;
    // TWO SEGMENTS AT LEAST, and the cost is stated: `migrations/` and `seed/`
    // written on their own are NOT checked here. A one-segment name — with or
    // without a trailing slash — is a NAME, and the delivered documents use
    // names for directories that are not this repository's: `package/` inside a
    // vector, `clone/` and `probe/` inside a runbook's work directory,
    // `evidence/` inside a scan target. Two segments is what makes a token a
    // path of somewhere rather than a word.
    if (!clean.includes("/")) continue;
    if (!EXTENSION.test(clean) && !span.endsWith("/")) continue;
    add("path", clean);
  }
  // `npm run …` and `skillonomia …` written outside a code span still name a
  // script and a subcommand; the eight defects included one that was prose.
  for (const c of sentence.matchAll(/\bnpm run `?([a-z][a-z0-9:_-]*)`?/g)) add("npm-script", c[1]!);
  return out;
}

let trackedCache: string[] | null = null;
function trackedFiles(): string[] {
  if (trackedCache !== null) return trackedCache;
  trackedCache = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\0")
    .filter(Boolean);
  return trackedCache;
}

/** Every tracked path AND every directory one of them lives in — a document
 *  names `skills/git-bundle-verify/vectors/`, which is a directory and therefore
 *  in no file listing. */
let trackedPathCache: Set<string> | null = null;
function trackedPaths(): Set<string> {
  if (trackedPathCache !== null) return trackedPathCache;
  const all = new Set<string>();
  for (const file of trackedFiles()) {
    all.add(file);
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) all.add(parts.slice(0, i).join("/"));
  }
  trackedPathCache = all;
  return all;
}

/** Whether a path with a placeholder in it matches something this tree holds. */
function placeholderResolves(token: string): boolean {
  const pattern = new RegExp(
    `^${token
      .split(/(NN|XX|\{[^}]*\}|<[^>]*>|\*)/)
      .map((part, i) => (i % 2 === 1 ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );
  for (const p of trackedPaths()) if (pattern.test(p)) return true;
  return false;
}

/**
 * WHERE A ROOTED PATH SHOULD BE LOOKED FOR, or `null` when it names nothing of
 * this tree at all.
 *
 * The bases are the document's own directory, the repository root, and every
 * skill package this repository ships — in that order. That last one is what
 * makes `vectors/MATRIX.tsv` inside a runbook mean that runbook's vectors, and
 * `fixtures/tv01.sh` in `SPEC.md` mean the seed package's fixture.
 *
 * A path is this tree's business only when its FIRST SEGMENT is a directory
 * one of those bases has. The delivered documents are full of paths that belong
 * to somebody else — `<root>/.claude/skills/<name>` on an operator's machine,
 * `WORK_DIR/A` under a runbook's work directory, `scripts/skln-arrive.sh`
 * inside a package the registry generates — and resolving those against this
 * repository would report a defect in a sentence that is correct.
 *
 * THE COST, STATED: a document that invents a WHOLE TOP-LEVEL DIRECTORY —
 * `fixtures-v2/thing.ts` — is not caught, because nothing distinguishes it from
 * a path into somebody else's tree. What IS caught is the case that actually
 * happens: a real directory of this repository, and a file in it that is not
 * there. Renaming `src/gates.ts` breaks every document that names it.
 */
function searchBases(document: string, token: string): string[] | null {
  const first = token.split("/")[0]!;
  if (first.length === 0) return null;
  const dir = document.includes("/") ? document.slice(0, document.lastIndexOf("/")) : "";
  const own = [...(dir === "" ? [] : [dir]), ""];
  const has = (b: string): boolean => {
    const at = join(REPO_ROOT, b, first);
    return existsSync(at) && statSync(at).isDirectory();
  };
  // A CLAIM HAS TO BE ABOUT SOMETHING THE READER IS STANDING IN. If the only
  // place this token's first segment exists is an unrelated skill package, the
  // document is naming a member of somebody's package and not a file here:
  // `scripts/skln-arrive.sh` is a path the registry GENERATES into a package,
  // and this repository has no `scripts/` of its own. The package directories
  // widen where a claim may resolve; they never make one fail.
  if (!own.some(has)) return null;
  return [...own, ...packageDirectories()].filter(has);
}

/** The referents that do NOT resolve, each with what was looked for. */
export function unresolvedReferences(refs: readonly Reference[], document = ""): string[] {
  const bad: string[] = [];
  const scripts = npmScripts();
  const outputs = declaredBuildOutputs();
  const subs = subcommands();
  const routes = restRoutes();
  const env = environmentNames();
  for (const ref of refs) {
    switch (ref.kind) {
      case "npm-script":
        if (!(ref.token in scripts)) bad.push(`\`npm run ${ref.token}\` — package.json defines no such script`);
        break;
      case "subcommand":
        if (!subs.includes(ref.token)) {
          bad.push(`\`skillonomia ${ref.token}\` — src/cli-commands.ts dispatches ${subs.join(", ")}`);
        }
        break;
      case "mcp-tool":
        if (!MCP_NAMES.has(ref.token)) bad.push(`\`${ref.token}\` — the MCP adapter advertises no such tool`);
        break;
      case "rest-route": {
        const [method, path] = ref.token.split(" ") as [string, string];
        // A document that writes `DELETE /v1/webhooks` is naming the SURFACE,
        // and the router mounts its member form at `/v1/webhooks/*`. So a route
        // resolves when it is served exactly, or when the router serves it with
        // further path segments under the same method. A misspelt collection
        // still matches nothing and still fails.
        const served = [...routes].some((r) => {
          const [m, p] = r.split(" ") as [string, string];
          if (method !== "ANY" && m !== method) return false;
          return p === path || p.startsWith(`${path}/`);
        });
        if (!served) bad.push(`\`${ref.token}\` — src/http.ts serves no such route`);
        break;
      }
      case "env":
        if (!env.has(ref.token)) bad.push(`\`${ref.token}\` — nothing in this tree reads that variable`);
        break;
      case "path": {
        if (outputs.includes(ref.token)) break;
        const rooted = searchBases(document, ref.token);
        if (rooted === null) break; // a member of somebody's package: not a claim about this tree
        const resolves = rooted.some((b) =>
          PLACEHOLDER.test(ref.token)
            ? placeholderResolves(join(b, ref.token))
            : existsSync(join(REPO_ROOT, b, ref.token)),
        );
        if (!resolves) {
          bad.push(
            `\`${ref.token}\` — no such file or directory (looked under ${rooted.map((b) => (b === "" ? "the repository root" : `\`${b}/\``)).join(" and ")})`,
          );
        }
        break;
      }
    }
  }
  return bad;
}

// ----------------------------------------------------------------- the counts

/**
 * A COUNTED NOUN whose true value is read out of this tree.
 *
 * `test/docs-guard.ts` already owns three of these — dashboard views, §9 screens
 * and MCP tools — with the review-record machinery they need. This table is the
 * rest of what the delivered documents actually count, and the values come from
 * the code, the migrations, the workflow and the fixture directories rather than
 * from anybody's memory.
 */
export interface CountedNoun {
  key: string;
  /** the phrases that STATE this count; `{q}` stands for the quantity */
  phrases: readonly string[];
  truth: () => number;
  source: string;
}

/** How many `.bundle` files the shipped skill offers as DEFECTIVE cases. */
function defectiveBundles(): number {
  const dir = join(REPO_ROOT, "skills/git-bundle-verify/vectors");
  return readdirSync(dir).filter((f) => f.endsWith(".bundle") && f !== "good.bundle").length;
}

function migrationFiles(): number {
  return readdirSync(join(REPO_ROOT, "migrations")).filter((f) => f.endsWith(".sql")).length;
}

/**
 * The PACKAGING PATHS this tree builds, discovered from the tree rather than
 * counted off a table. Each is a declared way to end up with a running
 * registry, and each is named by an artifact of this repository:
 *
 *   * `Dockerfile`               → a locally built container image
 *   * `scripts.start`            → a checkout run in place
 *   * `bin` + `files` + `prepack`→ an installable npm tarball (`npm pack`)
 *   * `scripts.build:binary`     → the compiled Linux x86_64 binary
 *
 * README said THREE and omitted the tarball, which `package.json` builds on
 * every `npm pack` and `.github/workflows/ci.yml` installs and smoke-tests in
 * `package-smoke`. That is the same defect as the binary the workflow uploaded:
 * the automation shipped a path the prose said did not exist.
 */
export function packagingPaths(): string[] {
  const pkg = JSON.parse(read("package.json"));
  const found: string[] = [];
  if (existsSync(join(REPO_ROOT, "Dockerfile"))) found.push("container image (Dockerfile)");
  if (pkg.scripts?.start) found.push("checkout (`npm start`)");
  if (pkg.bin && Array.isArray(pkg.files) && pkg.scripts?.prepack) found.push("npm tarball (`npm pack`)");
  if (pkg.scripts?.["build:binary"]) found.push("compiled binary (`npm run build:binary`)");
  return found;
}

/** How many tests `test/p7-threats.test.ts` actually declares. */
export function redTeamTests(): number {
  return (read("test/p7-threats.test.ts").match(/^test\(/gm) ?? []).length;
}

/** Shell-gate classes that REFUSE (FAIL) as against those that merely warn. */
export function refusedShellClasses(): number {
  return SHELL_SEVERITY.filter((s) => s.severity === "fail").length;
}

export const COUNTED_NOUNS: readonly CountedNoun[] = [
  {
    key: "safety-gates",
    phrases: [
      "{q} (?:deterministic )?safety gates?",
      "(?:all|the same|those) {q} (?:§7\\.1 )?gates?",
      "{q} §7\\.1 gates?",
    ],
    truth: () => GATE_NAMES.length,
    source: "src/gates.ts GATE_NAMES",
  },
  {
    key: "subcommands",
    phrases: ["{q} subcommands?", "the same {q} commands exist"],
    truth: () => subcommands().length,
    source: "src/cli-commands.ts runCli",
  },
  {
    key: "migrations",
    // NOT "{q} migrations": `SPEC.md` legitimately says "a process that dies
    // between two migrations", which counts a gap and not the schema. A count
    // of the SCHEMA says so — it is given in them, or it is all of them.
    phrases: ["given in {q} migrations", "all {q} migrations", "{q} migrations, applied"],
    truth: migrationFiles,
    source: "migrations/*.sql",
  },
  {
    key: "packaging-paths",
    phrases: ["{q} packaging paths?", "{q} paths?, all of them"],
    truth: () => packagingPaths().length,
    source: "package.json + Dockerfile",
  },
  {
    key: "red-team-tests",
    phrases: ["{q} red-team tests?"],
    truth: redTeamTests,
    source: "test/p7-threats.test.ts",
  },
  {
    key: "shell-classes",
    phrases: ["names {q} classes", "{q} (?:shell )?classes(?:,| that| which| the gate)"],
    truth: () => SHELL_SEVERITY.length,
    source: "src/gates.ts SHELL_SEVERITY",
  },
  {
    key: "refused-shell-classes",
    // NOT "{q} … refused": `skills/git-bundle-verify/SKILL.md` says "step 4
    // refused by", which counts nothing. A count of the gate's classes either
    // names them or is the tail of the sentence that named them.
    phrases: ["of which {q} are refused", "{q} (?:shell )?classes? (?:are |is )?refused"],
    truth: refusedShellClasses,
    source: "src/gates.ts SHELL_SEVERITY (severity `fail`)",
  },
  {
    key: "defective-bundles",
    phrases: ["{q} classes? of defective bundle"],
    truth: defectiveBundles,
    source: "skills/git-bundle-verify/vectors/*.bundle",
  },
];

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

/**
 * The quantity, as a document writes one. A CLOSED LEXICON, for the reason
 * `test/docs-guard.ts` gives at length: the ways to WRITE a number are
 * unbounded and the ways to SAY one in an English noun phrase are not.
 */
const QUANTITY = `${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")}|\\d+`;

/**
 * A count is matched as a PHRASE, quantity included, rather than as
 * "a number somewhere near a noun".
 *
 * The looser shape was here first and it was wrong in both directions at once.
 * `skills/README.md` now reads "It names twelve classes, of which ten are
 * refused" — one sentence stating TWO different true counts of the same noun.
 * A quantity-near-noun matcher reads both as the same claim and refuses the
 * sentence whichever number is right. Writing the phrase out makes the subject
 * of each count explicit, which is what a count needs to be checkable at all.
 */
function claimRegex(phrase: string): RegExp {
  // The emphasis marks around a figure are part of how a document writes it —
  // `given in **twelve** migrations` — and are not part of the figure.
  const quantity = `\\*{0,2}(?<![.\\d§#-])\\b(${QUANTITY})\\b\\*{0,2}`;
  return new RegExp(phrase.replace("{q}", quantity), "gi");
}

/** The counted claims a sentence makes that disagree with the tree. */
export function wrongCounts(sentence: string): string[] {
  const bad: string[] = [];
  for (const subject of COUNTED_NOUNS) {
    for (const phrase of subject.phrases) {
      for (const m of sentence.matchAll(claimRegex(phrase))) {
        const raw = m[1]!.toLowerCase();
        const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]!;
        const truth = subject.truth();
        if (value !== truth) bad.push(`claims ${value} ${subject.key} where ${subject.source} has ${truth}`);
      }
    }
  }
  return bad;
}

/** Whether a sentence states any count this table knows how to check. */
export function statesCount(sentence: string): string[] {
  const keys: string[] = [];
  for (const subject of COUNTED_NOUNS) {
    if (subject.phrases.some((p) => claimRegex(p).test(sentence))) keys.push(subject.key);
  }
  return keys;
}

// ------------------------------------------------------- the pinned figures

/**
 * A FIGURE A DOCUMENT WRITES WHOSE SUBJECT IS A FILE OF THIS TREE.
 *
 * Not every number in a delivered document sits next to an absolute word — the
 * pinned Bun version, the engine floor and the release gate's budget are three
 * that do not — and the first defect of this family was exactly such a number
 * (README's test count). So they are checked on their own account, against the
 * file that decides them.
 */
export interface PinnedFigure {
  key: string;
  /** where a document writes it; group 1 is the figure */
  where: RegExp;
  truth: () => string;
  source: string;
}

/** The single `bun-version:` the workflow pins, refusing if it pins two. */
function pinnedBunVersion(): string {
  const found = [...read(".github/workflows/ci.yml").matchAll(/bun-version:\s*"([^"]+)"/g)].map((m) => m[1]!);
  const distinct = [...new Set(found)];
  assert.equal(distinct.length, 1, `the workflow pins ${distinct.length} Bun versions (${distinct.join(", ")})`);
  return distinct[0]!;
}

function engineFloor(): string {
  const engines = JSON.parse(read("package.json")).engines?.node;
  assert.ok(typeof engines === "string", "package.json declares no `engines.node`");
  return engines.replace(/^[^\d]*/, "");
}

function quickstartBudget(): string {
  const script = read("ci/quickstart-docker.sh");
  const found = [...script.matchAll(/BUDGET_S="\$\{BUDGET_S:-(\d+)\}"|release target (\d+)s/g)].map((m) => m[1] ?? m[2]!);
  const distinct = [...new Set(found)];
  assert.equal(distinct.length, 1, `ci/quickstart-docker.sh states ${distinct.length} budgets (${distinct.join(", ")})`);
  return distinct[0]!;
}

export const PINNED_FIGURES: readonly PinnedFigure[] = [
  {
    key: "bun-version",
    where: /Bun (\d+\.\d+\.\d+) \(canonical runtime\)/g,
    truth: pinnedBunVersion,
    source: ".github/workflows/ci.yml `bun-version`",
  },
  {
    key: "node-engine-floor",
    where: /Node ≥(\d+\.\d+)/g,
    truth: engineFloor,
    source: "package.json `engines.node`",
  },
  {
    key: "quickstart-budget",
    where: /(\d+)-second budget/g,
    truth: quickstartBudget,
    source: "ci/quickstart-docker.sh `BUDGET_S`",
  },
];

export function wrongFigures(text: string): string[] {
  const bad: string[] = [];
  for (const figure of PINNED_FIGURES) {
    for (const m of text.matchAll(figure.where)) {
      const truth = figure.truth();
      if (m[1] !== truth) bad.push(`writes ${figure.key} \`${m[1]}\` where ${figure.source} says \`${truth}\``);
    }
  }
  return bad;
}

/** The five `.bundle` files the shipped skill's vector set is made of. */
export function bundleBytes(): number {
  const dir = join(REPO_ROOT, "skills/git-bundle-verify/vectors");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".bundle"))
    .reduce((n, f) => n + statSync(join(dir, f)).size, 0);
}

/** Everything else the vector set carries, except the prose that explains it. */
export function bundleSidecarBytes(): number {
  const dir = join(REPO_ROOT, "skills/git-bundle-verify/vectors");
  let total = 0;
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const at = join(rel, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (!entry.name.endsWith(".bundle") && entry.name !== "README.md") total += statSync(join(dir, at)).size;
    }
  };
  walk(".");
  return total;
}

// ------------------------------------------------------------- the partition

export type Ground =
  | "intent" // what this project will or will not do
  | "external" // the world outside this tree: a registry, a host, a filesystem
  | "behaviour" // a rule of the running service, exercised by the suite
  | "definition" // defines a term or a document's own scope rather than reporting a fact
  | "editorial"; // a statement about the documents themselves

export interface Declared {
  document: string;
  digest: string;
  ground: Ground;
  why: string;
}

export interface Reading {
  claim: AbsoluteClaim;
  /** what the guard verified, or the empty list when it verified nothing */
  checked: string[];
  /** why the claim is wrong. Non-empty is a failure. */
  wrong: string[];
}

/**
 * ONE SENTENCE, AGAINST THE TREE — the whole of what this file can check.
 *
 * The same function the sweep runs and the planting proof runs. There is no
 * second implementation for the test to agree with itself about, which is the
 * mistake `test/docs-guard.ts` records having made in an earlier round.
 */
export function readSentence(document: string, sentence: string): { checked: string[]; wrong: string[] } {
  const refs = referencesIn(sentence);
  return {
    checked: [...refs.map((r) => `${r.kind} \`${r.token}\``), ...statesCount(sentence).map((k) => `count ${k}`)],
    wrong: [...unresolvedReferences(refs, document), ...wrongCounts(sentence)],
  };
}

export function readClaim(claim: AbsoluteClaim): Reading {
  const { checked, wrong } = readSentence(claim.document, claim.sentence);
  return { claim, checked, wrong };
}
