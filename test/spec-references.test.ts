// Every section reference in a PUBLISHED file must resolve to a section that
// SPEC.md actually has.
//
// The class of defect this exists to make impossible: this repository was
// written against an internal requirements document that is NOT published with
// it. Its numbering does not match SPEC.md's — it has a phase plan, an
// acceptance-criteria chapter with sub-clauses, and appendices that the
// specification has no counterpart for. Comments, test names, CI steps, shell
// scripts and the specification itself quoted those numbers. Published, they
// pointed at nothing: a reader who follows one lands in a document that has no
// such section, and cannot tell whether the claim is wrong, moved, or was never
// there. One of them was printed to the operator's terminal on every first
// start; another shipped inside the signed seed package every adopter receives.
//
// So the rule, checked here rather than remembered: `§` in this repository
// means "a section of SPEC.md", always, and the number must exist. A reference
// to some other document is written in words — "the internal phase plan", "the
// release acceptance gate" — or, for a public standard, spelled out in full
// ("RFC 8785 section 3.2.3"), because a reader can fetch that one.
//
// The anchor set is DERIVED FROM SPEC.md, never listed here, so a section that
// is renumbered or removed takes its references down with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What "published" means: the whole tree, minus any working paper that stays
 * behind. In THIS tree both sets are empty — every file present here is
 * published, which is the property that makes the guard below total. They exist
 * so that a checkout carrying private notes beside the source can name them
 * here instead of switching the guard off; anything not named is scanned.
 */
const UNPUBLISHED_FILES = new Set<string>();
const UNPUBLISHED_DIRS: string[] = [];

/** Untracked build output and dependencies: not sources, never published as such. */
const NOT_SOURCE_DIRS = new Set([".git", "node_modules", "dist", "dist-js"]);

/** Archives and databases: read as bytes, they carry no readable reference. */
const BINARY_EXT = /\.(tar|gz|tgz|zip|png|jpg|jpeg|gif|ico|db|wasm|bundle)$/i;

function publishedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        if (NOT_SOURCE_DIRS.has(entry.name)) continue;
        if (UNPUBLISHED_DIRS.includes(rel)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (UNPUBLISHED_FILES.has(rel.split(sep).join("/"))) continue;
      if (BINARY_EXT.test(entry.name)) continue;
      out.push(rel.split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

/**
 * The anchors SPEC.md offers, computed from SPEC.md.
 *
 * Two kinds, because the document is referred to in two ways and both are in
 * use. A HEADING gives its own number (`## 9.` → §9, `### 4.1b` → §4.1b,
 * `## Appendix G.` → Appendix G, `### G.4` → Appendix G.4). A NUMBERED ITEM
 * inside a section gives one level below it: the verification algorithm is a
 * numbered list under one heading, and its steps are cited as §4.4 step 8 is
 * cited — by number. Fenced code blocks are skipped, so a numbered line inside
 * an example never invents an anchor.
 */
function specAnchors(spec: string): Set<string> {
  const anchors = new Set<string>();
  let section: string | null = null;
  let fenced = false;
  for (const line of spec.split("\n")) {
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      let m: RegExpExecArray | null;
      section = null;
      if ((m = /^(\d+(?:\.\d+)*[a-z]?)\.?\s/.exec(title))) section = `§${m[1]}`;
      else if ((m = /^Appendix\s+([A-Z])\b/.exec(title))) section = `Appendix ${m[1]}`;
      else if ((m = /^([A-Z])\.(\d+[a-z]?)\s/.exec(title))) section = `Appendix ${m[1]}.${m[2]}`;
      if (section) anchors.add(section);
      continue;
    }

    const item = /^(\d+)\.\s/.exec(line);
    if (item && section?.startsWith("§")) anchors.add(`${section}.${item[1]}`);
  }
  return anchors;
}

/** `§9.1`, `§ 9.1`, `Appendix H`, `Appendix D.1b` — wherever they appear. */
const REFERENCE = /§\s?(\d+(?:\.\d+)*[a-z]?)|Appendix\s+([A-Z])(?:\.(\d+[a-z]?))?/g;

function referencesIn(text: string): Array<{ ref: string; line: number }> {
  const found: Array<{ ref: string; line: number }> = [];
  text.split("\n").forEach((line, i) => {
    let m: RegExpExecArray | null;
    REFERENCE.lastIndex = 0;
    while ((m = REFERENCE.exec(line))) {
      found.push({ ref: m[1] ? `§${m[1]}` : `Appendix ${m[2]}${m[3] ? `.${m[3]}` : ""}`, line: i + 1 });
    }
  });
  return found;
}

test("every §-reference and Appendix reference in a published file resolves to a section SPEC.md has", () => {
  const anchors = specAnchors(readFileSync(join(root, "SPEC.md"), "utf8"));
  // Sanity: the derivation itself must be working. If SPEC.md were unreadable
  // as sections, an empty anchor set would make this guard pass everything.
  assert.ok(anchors.size >= 30, `only ${anchors.size} anchors were derived from SPEC.md — the parser is reading it wrong`);
  for (const expected of ["§1", "§9.1", "§4.4.8", "Appendix D.1d", "Appendix H"]) {
    assert.ok(anchors.has(expected), `${expected} is in SPEC.md but was not derived — the parser is reading it wrong`);
  }

  const dangling: string[] = [];
  const skipped: string[] = [];
  let checked = 0;
  for (const file of publishedFiles()) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // unreadable as text: no reference to find
    }
    if (text.includes("\0")) {
      // A NUL byte used to make this guard skip the whole file in silence, and
      // src/archive.ts — which is published and did carry citations — has one.
      // A guard that quietly drops a file it was built to read is the defect it
      // exists to prevent, so an unexpected skip is now a failure, not a pass.
      skipped.push(file);
      continue;
    }
    for (const { ref, line } of referencesIn(text)) {
      checked++;
      if (!anchors.has(ref)) dangling.push(`${file}:${line}  ${ref}`);
    }
  }

  assert.ok(checked > 500, `only ${checked} references were scanned — the file walk is not reaching the tree`);
  assert.deepEqual(
    dangling,
    [],
    `these published files cite a section SPEC.md does not have. Either the number is wrong (fix it), or the ` +
      `subject is covered by a section with another number (cite that one), or SPEC.md does not describe the ` +
      `subject at all — in which case drop the number and say what you mean in words:\n${dangling.join("\n")}`,
  );

  assert.deepEqual(
    skipped,
    [],
    "a published text file was skipped because it contains a NUL byte — an unscanned file, silently",
  );
});

/**
 * The unpublished documents this repository was written against, as a reader
 * would meet their names in a comment: the internal requirements revisions
 * `R3`/`R4`, and the owner's dated amendments to them — `OD-2026-08-02-4` and
 * its shorthand `OD-4`, and every sibling of both spellings.
 */
const UNPUBLISHED_DOC = /\b(?:R[34]|OD-\d[\d-]*)\b/;

test("no published file cites an unpublished document by section number", () => {
  // The test above catches a § that resolves to nothing. This one catches the
  // WORSE case: a § that resolves — to the wrong document.
  //
  // The owner's amendments number their clauses §1…§6, and so does SPEC.md.
  // The numbers collide by accident and the subjects do not: the amendment's §3
  // is webhook delivery, the specification's §3 is the data model. A reader of
  // the published repository who follows "OD-4 §3" therefore lands somewhere
  // real and reads the wrong thing, with nothing to tell them so — and the
  // check above cannot see it, because §3 does exist. There is no repair for
  // that at read time; the citation has to not be written.
  //
  // So the rule is the one the first test states, applied to the other half:
  // `§` in this repository means "a section of SPEC.md", so it may not stand
  // next to the name of a document the reader does not receive. Where the
  // specification covers the subject, cite the section that covers it — by
  // subject, never by copying the number across, since the numbers agree only
  // by coincidence. Where it does not, drop the number and say the thing in
  // words. Naming an owner decision WITHOUT a section number stays allowed,
  // because it explains why the code is what it is and asks the reader to
  // follow nothing: "by owner decision, adoption requests are created in
  // `approval_pending` rather than refused" is a complete sentence.
  const offenders: string[] = [];
  const skipped: string[] = [];
  for (const file of publishedFiles()) {
    if (file === "test/spec-references.test.ts") continue; // this comment
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) {
      // A NUL byte used to make this guard skip the whole file in silence, and
      // src/archive.ts — which is published and did carry citations — has one.
      // A guard that quietly drops a file it was built to read is the defect it
      // exists to prevent, so an unexpected skip is now a failure, not a pass.
      skipped.push(file);
      continue;
    }
    text.split("\n").forEach((line, i) => {
      // Both shapes, on one line: the citation itself (`OD-4 §3`, `R3 §7.1`),
      // and the looser form where the document is named and a § appears
      // anywhere after it — `R3 §7.1 and OD-…-3`, or a `§3` trailing an earlier
      // `OD-4 §2`, which reads as that document's §3 and is the same defect.
      const doc = UNPUBLISHED_DOC.exec(line);
      if (doc && line.indexOf("§", doc.index) > doc.index) {
        offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `these published files put a § next to a document the reader never receives. Such a citation is not ` +
      `dangling — it RESOLVES, into SPEC.md, under a number that means something else there. Cite the SPEC.md ` +
      `section that covers the subject (found by subject, not by keeping the number), or drop the number and ` +
      `name the thing in words:\n${offenders.join("\n")}`,
  );

  assert.deepEqual(
    skipped,
    [],
    "a published text file was skipped because it contains a NUL byte. Source is text: " +
      "write control characters as escapes. A silently skipped file is an unscanned file.",
  );
});
