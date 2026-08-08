// Regression suite for P1 review verdict 15 (CONDITIONAL on 0c737ea).
// Each test targets a behaviour that did NOT hold at 0c737ea: the committed
// NFC composition table was under-populated (689 pairs of 941), and two pax
// constructs §4.1b permits were refused.
//
// Unicode literals are written as \u escapes ONLY — an NFC-normalizing editor
// would otherwise silently rewrite the decomposed fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTar, ArchiveError } from "../src/archive.ts";
import { verifyPackage } from "../src/verify.ts";
import { toNFC, isNFC } from "../src/unicode.ts";
import { COMPOSE } from "../src/unicode-tables.ts";
import { tvRegistry, tv01Package, rawTarEntry, tarOf, paxEntry, paxRecord } from "./vectors-helpers.ts";

function expectArchiveError(fn: () => unknown, code: "MALFORMED_ARCHIVE" | "LIMIT_EXCEEDED") {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ArchiveError, `expected ArchiveError, got ${e}`);
    assert.equal((e as ArchiveError).code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

function globalEntry(records: Buffer): Buffer {
  return rawTarEntry("pax_global_header", records, "g");
}

// ---- B-1r15: the committed NFC composition table was under-populated ----

test("B-1r15: pairs whose first component itself decomposes DO compose (the dropped 252)", () => {
  // U+00D5 (O with tilde) canonically decomposes to O + combining tilde, but
  // is a STARTER (ccc 0) — the old `decomp[a]` filter wrongly excluded every
  // such pair, so O-tilde + combining acute (U+0301) never composed to U+1E4C.
  assert.equal(toNFC("\u00D5\u0301"), "\u1E4C");
  assert.equal(isNFC("\u00D5\u0301"), false, "decomposed spelling must NOT count as NFC");
  assert.equal(isNFC("\u1E4C"), true, "the true NFC form must be accepted");
  // Same class, lowercase and a different mark: U+01EB (o with ogonek, itself
  // decomposable, starter) + combining macron (U+0304) → U+01ED.
  assert.equal(toNFC("\u01EB\u0304"), "\u01ED");
});

test("B-1r15: exclusions survive the fix — non-starter decompositions still do not compose", () => {
  // U+0344 decomposes to U+0308 U+0301 — two combining marks, the first a
  // NON-starter: a genuine non-starter decomposition, never recomposed.
  assert.equal(toNFC("\u0344"), "\u0308\u0301");
  // Composition-excluded pair via the Python round-trip: Devanagari U+0958
  // decomposes to U+0915 U+093C and must stay decomposed under NFC.
  assert.equal(toNFC("\u0958"), "\u0915\u093C");
});

test("B-1r15: the composition table carries the full Unicode 14 pair count", () => {
  assert.equal(COMPOSE.size, 941);
});

// ---- B-2r15: a global extended header whose records change nothing is permitted ----

test("B-2r15: global header carrying only comment= is accepted, entries read normally", () => {
  const files = readTar(tarOf(
    globalEntry(paxRecord("comment", "produced by some archiver")),
    rawTarEntry("SKILL.md", Buffer.from("x"), "0"),
  ));
  assert.deepEqual([...files.keys()], ["SKILL.md"]);
  assert.equal(files.get("SKILL.md")!.toString(), "x");
});

test("B-2r15: a signed package behind a comment-only global header verifies end-to-end", () => {
  const { db } = tvRegistry();
  const members = [...tv01Package()].map(([p, b]) => rawTarEntry(p, b, "0"));
  const files = readTar(tarOf(globalEntry(paxRecord("comment", "hello")), ...members));
  assert.equal(verifyPackage(files, db).verdict, "valid");
});

test("B-2r15: global records §4.1b already ignores for hashing are accepted with shape checks", () => {
  const records = Buffer.concat([
    paxRecord("comment", "c"),
    paxRecord("mtime", "1754000000.5"),
    paxRecord("uid", "1000"),
    paxRecord("uname", "builder"),
    paxRecord("charset", "ISO-IR 10646 2000 UTF-8"),
  ]);
  const files = readTar(tarOf(globalEntry(records), rawTarEntry("a.txt", Buffer.from("x"), "0")));
  assert.deepEqual([...files.keys()], ["a.txt"]);
  // ...but a malformed value under a recognized key is still a malformed archive
  expectArchiveError(
    () => readTar(tarOf(globalEntry(paxRecord("uid", "10x0")), rawTarEntry("a.txt", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-2r15: global records a pax-aware consumer would APPLY are still refused", () => {
  const member = () => rawTarEntry("a.txt", Buffer.from("x"), "0");
  // path renames every following entry
  expectArchiveError(() => readTar(tarOf(globalEntry(paxRecord("path", "renamed.txt")), member())), "MALFORMED_ARCHIVE");
  // size changes how following entry bytes are read
  expectArchiveError(() => readTar(tarOf(globalEntry(paxRecord("size", "1")), member())), "MALFORMED_ARCHIVE");
  // hdrcharset changes how later header values decode
  expectArchiveError(() => readTar(tarOf(globalEntry(paxRecord("hdrcharset", "BINARY")), member())), "MALFORMED_ARCHIVE");
  // unknown keys are refused, never ignored
  expectArchiveError(() => readTar(tarOf(globalEntry(paxRecord("GNU.sparse.size", "1")), member())), "MALFORMED_ARCHIVE");
});

test("B-2r15: global header structure rules hold", () => {
  const member = () => rawTarEntry("a.txt", Buffer.from("x"), "0");
  // no records at all → malformed (POSIX requires at least one)
  expectArchiveError(() => readTar(tarOf(globalEntry(Buffer.alloc(0)), member())), "MALFORMED_ARCHIVE");
  // a global header between a local extended header and its file header
  // breaks the x-must-be-followed-by-its-file-header contract
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("path", "b.txt")), globalEntry(paxRecord("comment", "c")), member())),
    "MALFORMED_ARCHIVE",
  );
  // deletion records are no-ops (no refused global default can have been set)
  const files = readTar(tarOf(globalEntry(Buffer.concat([paxRecord("path", ""), paxRecord("comment", "c")])), member()));
  assert.deepEqual([...files.keys()], ["a.txt"]);
  // a trailing global header describing nothing is not an orphan — it promises
  // no following file header, unlike typeflag x
  assert.deepEqual([...readTar(tarOf(member(), globalEntry(paxRecord("comment", "bye")))).keys()], ["a.txt"]);
});

// ---- B-3r15: a local size override that agrees with its header is permitted ----

test("B-3r15: size= agreeing with the ustar header is accepted, bytes read once", () => {
  const files = readTar(tarOf(
    paxEntry(paxRecord("size", "5")),
    rawTarEntry("a.txt", Buffer.from("hello"), "0"),
  ));
  assert.equal(files.get("a.txt")!.toString(), "hello");
  // combined with a path override in the same extended header
  const both = readTar(tarOf(
    paxEntry(Buffer.concat([paxRecord("size", "5"), paxRecord("path", "renamed.txt")])),
    rawTarEntry("a.txt", Buffer.from("hello"), "0"),
  ));
  assert.deepEqual([...both.keys()], ["renamed.txt"]);
});

test("B-3r15: size= that disagrees with the header is refused (two readers would diverge)", () => {
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("size", "4")), rawTarEntry("a.txt", Buffer.from("hello"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  // an override far beyond octal-field range can never agree with any header
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("size", "99999999999999999999")), rawTarEntry("a.txt", Buffer.from("hello"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-3r15: size value shape and deletion semantics", () => {
  // non-decimal value → malformed even though the key is now recognized
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("size", "0x5")), rawTarEntry("a.txt", Buffer.from("hello"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  // set-then-delete inside one header: deletion wins, no comparison happens
  const files = readTar(tarOf(
    paxEntry(Buffer.concat([paxRecord("size", "999"), paxRecord("size", "")])),
    rawTarEntry("a.txt", Buffer.from("hello"), "0"),
  ));
  assert.equal(files.get("a.txt")!.toString(), "hello");
});
