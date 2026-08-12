// Regression suite for P1 review verdict 3 (BLOCKED on d87d698).
// Each test targets a behaviour that did NOT hold at d87d698.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as transitions from "../src/transitions.ts";
import { publishVersion } from "../src/countersign.ts";
import { readTar, readDirectory, checkPath, ArchiveError } from "../src/archive.ts";
import { verifyPackage } from "../src/verify.ts";
import { verifyTlog } from "../src/tlog.ts";
import { jcsCanonicalize } from "../src/jcs.ts";
import { tvRegistry, tv01Package, tv01Manifest, rawTarEntry, tarOf, paxEntry, paxRecord } from "./vectors-helpers.ts";
import { CASE_FOLD, UNICODE_VERSION, toNFC, isNFC, foldKey } from "../src/unicode.ts";

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

/** ustar entry with an explicit version field (default "00"). */
function entryWithVersion(name: string, data: Buffer, version: string): Buffer {
  const e = rawTarEntry(name, data, "0");
  e.write(version, 263);
  e.write("        ", 148);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += e[i]!;
  e.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return e;
}

// ---- B-1: publication has exactly one entry point, all reads under the lock ----

test("B-1: the transitions module exports no `published` writer at all", () => {
  const exported = Object.keys(transitions);
  assert.ok(!exported.includes("setPublishedInTx"), `no publish backdoor may be exported, got: ${exported.join(",")}`);
  for (const name of exported) {
    assert.ok(!/publish/i.test(name), `unexpected publish-ish export: ${name}`);
  }
});

test("B-1: publishVersion opens its transaction BEFORE any read (no stale-check window)", () => {
  const { db, versionId } = tvRegistry({ state: "verified", skipCountersign: true });
  const ops: string[] = [];
  const traced = {
    exec: (sql: string) => {
      ops.push(sql.trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase());
      return db.exec(sql);
    },
    prepare: (sql: string) => {
      const verb = sql.trim().split(/\s+/)[0]!.toUpperCase();
      const st = db.prepare(sql);
      return {
        get: (...p: unknown[]) => {
          ops.push(verb);
          return st.get(...p);
        },
        all: (...p: unknown[]) => {
          ops.push(verb);
          return st.all(...p);
        },
        run: (...p: unknown[]) => {
          ops.push(verb);
          return st.run(...p);
        },
      };
    },
    close: () => db.close(),
  };
  publishVersion(traced as unknown as typeof db, versionId, 1_754_000_250_000);
  assert.equal(ops[0], "BEGIN IMMEDIATE", `first operation must be the transaction, got: ${ops.join(" → ")}`);
  const end = ops.findIndex((o) => o === "COMMIT" || o === "ROLLBACK");
  assert.ok(end > 0, "transaction must be closed");
  assert.ok(
    !ops.slice(end).some((o) => o === "SELECT"),
    "no read may happen outside the transaction",
  );
});

test("B-1: publishVersion is the only path to `published` and always pairs it with one countersign", () => {
  const { db, versionId, mHash } = tvRegistry({ state: "verified", skipCountersign: true });
  assert.equal(transitions.transitionVersion(db, versionId, "published").ok, false);
  const before = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as { state: string };
  assert.equal(before.state, "verified");

  const res = publishVersion(db, versionId, 1_754_000_300_000);
  assert.ok(res.transition.ok && res.countersign);
  const rows = db
    .prepare("SELECT server_at_ms FROM transparency_log WHERE event_kind='countersign' AND subject_id=?")
    .all(mHash) as Array<{ server_at_ms: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.server_at_ms, 1_754_000_300_000);
  assert.equal(verifyTlog(db).ok, true);
});

test("B-1: repeated publish never appends a second countersign with a different reference time", () => {
  const { db, versionId, mHash } = tvRegistry({ state: "verified", skipCountersign: true });
  publishVersion(db, versionId, 1_754_000_400_000);
  for (const t of [1_754_000_500_000, 1_754_000_600_000, 1_754_000_700_000]) {
    const r = publishVersion(db, versionId, t);
    assert.ok(r.transition.ok && r.transition.noop, "republish must be a noop");
    assert.equal(r.countersign, undefined);
  }
  const times = db
    .prepare("SELECT server_at_ms FROM transparency_log WHERE event_kind='countersign' AND subject_id=?")
    .all(mHash) as Array<{ server_at_ms: number }>;
  assert.deepEqual(times.map((t) => t.server_at_ms), [1_754_000_400_000], "exactly one reference time");
});

// ---- B-2: POSIX ustar/pax conformance ----

test("B-2: pax records that reinterpret entry bytes are refused, not ignored", () => {
  // a `size` override would change how many bytes belong to the next entry
  const tar = tarOf(
    paxEntry(Buffer.concat([paxRecord("path", "a.txt"), paxRecord("size", "99999999")])),
    rawTarEntry("placeholder", Buffer.from("x"), "0"),
  );
  expectArchiveError(() => readTar(tar), "MALFORMED_ARCHIVE");
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("linkpath", "/etc/passwd")), rawTarEntry("a", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("GNU.sparse.name", "x")), rawTarEntry("a", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-2: non-'00' ustar version and non-octal size fields are refused", () => {
  expectArchiveError(() => readTar(tarOf(entryWithVersion("a.txt", Buffer.from("x"), "01"))), "MALFORMED_ARCHIVE");
  expectArchiveError(() => readTar(tarOf(entryWithVersion("a.txt", Buffer.from("x"), "  "))), "MALFORMED_ARCHIVE");

  const bad = rawTarEntry("a.txt", Buffer.from("x"), "0");
  bad.write("0000000009x\0", 124); // non-octal digit
  bad.write("        ", 148);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += bad[i]!;
  bad.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  expectArchiveError(() => readTar(tarOf(bad)), "MALFORMED_ARCHIVE");
});

test("B-2: GNU long-name entries are refused (outside the POSIX profile)", () => {
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("././@LongLink", Buffer.from("some/long/name\0"), "L"), rawTarEntry("short", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-2: case-equivalent collisions that need a full case fold are detected", () => {
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("straße.txt", Buffer.from("a"), "0"), rawTarEntry("STRASSE.txt", Buffer.from("b"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

// ---- M-1: §4.1 layout ----

test("M-1: a correctly signed package without root SKILL.md is not valid", () => {
  const { db } = tvRegistry();
  const files = tv01Package();
  files.delete("SKILL.md");
  const out = verifyPackage(files, db);
  assert.notEqual(out.verdict, "valid");
  assert.equal(out.verdict, "INVALID_SCHEMA");
});

// ---- M-2: canonicalization failures are verdicts, not exceptions ----

test("M-2: escaped lone surrogates in skill.json yield INVALID_SCHEMA, never an exception", () => {
  const { db } = tvRegistry();
  const m = tv01Manifest();
  m.x_ext = { bad: "\\ud800" }; // placeholder replaced below with a real escape
  const raw = JSON.stringify(m).replace('"\\\\ud800"', '"\\ud800"');
  assert.ok(raw.includes("\\ud800"), "fixture sanity: escaped lone surrogate present");
  const files = tv01Package();
  files.set("skill.json", Buffer.from(raw, "utf8"));
  const out = verifyPackage(files, db); // must not throw
  assert.equal(out.verdict, "INVALID_SCHEMA");
  // Round 14: the same refusal, from the one definition and typed (src/outcome.ts).
  assert.throws(() => jcsCanonicalize(JSON.parse(raw)), /unpaired surrogate/);
});

// ---- M-3: directory-form packages with ill-formed names ----

test("M-3: ill-formed UTF-8 filename in a directory package → MALFORMED_ARCHIVE, not ENOENT", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-badname-"));
  // build the path as raw bytes: 'a', 0xFF (invalid UTF-8 lead), '.txt'
  const badPath = Buffer.concat([Buffer.from(dir + "/"), Buffer.from([0x61, 0xff]), Buffer.from(".txt")]);
  writeFileSync(badPath, "x");
  expectArchiveError(() => readDirectory(dir), "MALFORMED_ARCHIVE");
});

test("M-3: directory package with a full-case-fold collision (needs the NFKC fold, not toLowerCase)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-dircol-"));
  writeFileSync(join(dir, "straße.txt"), "x");
  writeFileSync(join(dir, "STRASSE.txt"), "y");
  expectArchiveError(() => readDirectory(dir), "MALFORMED_ARCHIVE");
});

// ---- verdict-4 findings ----

test("B-2b: global pax extended headers that rename entries are refused (a pax-aware reader would apply them)", () => {
  const globalHeader = rawTarEntry("pax_global_header", paxRecord("path", "../outside.txt"), "g");
  expectArchiveError(
    () => readTar(tarOf(globalHeader, rawTarEntry("SKILL.md", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  // …and a signed package carrying one never verifies
  const { db } = tvRegistry();
  const files = tv01Package();
  const tar = tarOf(
    globalHeader,
    ...[...files].map(([p, b]) => rawTarEntry(p, b, "0")),
  );
  assert.throws(() => readTar(tar), ArchiveError);
  assert.equal(verifyPackage(files, db).verdict, "valid", "control: the same files without the global header are valid");
});

test("M-3b: an extended header not followed by its file header is a truncated archive", () => {
  // orphan at end-of-archive, after an otherwise complete package
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("SKILL.md", Buffer.from("x"), "0"), paxEntry(paxRecord("path", "never-applied.txt")))),
    "MALFORMED_ARCHIVE",
  );
  // orphan with nothing else at all
  expectArchiveError(() => readTar(tarOf(paxEntry(paxRecord("path", "x.txt")))), "MALFORMED_ARCHIVE");
  // control: consumed by a following file header → fine
  assert.deepEqual(
    [...readTar(tarOf(paxEntry(paxRecord("path", "renamed.txt")), rawTarEntry("orig.txt", Buffer.from("x"), "0"))).keys()],
    ["renamed.txt"],
  );
});

test("M-2c: uid, gid and mtime must also be octal (every ustar numeric field)", () => {
  const withField = (offset: number, text: string) => {
    const e = rawTarEntry("a.txt", Buffer.from("x"), "0");
    e.write(text, offset);
    e.write("        ", 148);
    let s = 0;
    for (let i = 0; i < 512; i++) s += e[i]!;
    e.write(s.toString(8).padStart(6, "0") + "\0 ", 148);
    return tarOf(e);
  };
  expectArchiveError(() => readTar(withField(108, "00009x9\0")), "MALFORMED_ARCHIVE"); // uid
  expectArchiveError(() => readTar(withField(116, "0000zz0\0")), "MALFORMED_ARCHIVE"); // gid
  expectArchiveError(() => readTar(withField(136, "0000000008x\0")), "MALFORMED_ARCHIVE"); // mtime
  // control: well-formed octal values in those same fields still parse
  assert.deepEqual([...readTar(withField(108, "0000123\0")).keys()], ["a.txt"]);
});

test("M-2b: ustar numeric fields must be octal and non-empty (size, mode, checksum)", () => {
  const mutate = (patch: (e: Buffer) => void) => {
    const e = rawTarEntry("a.txt", Buffer.from("x"), "0");
    patch(e);
    return tarOf(e);
  };
  // empty size field
  expectArchiveError(() => readTar(mutate((e) => {
    e.fill(0, 124, 136);
    e.write("        ", 148);
    let s = 0;
    for (let i = 0; i < 512; i++) s += e[i]!;
    e.write(s.toString(8).padStart(6, "0") + "\0 ", 148);
  })), "MALFORMED_ARCHIVE");
  // non-octal mode field
  expectArchiveError(() => readTar(mutate((e) => {
    e.write("00006r4\0", 100);
    e.write("        ", 148);
    let s = 0;
    for (let i = 0; i < 512; i++) s += e[i]!;
    e.write(s.toString(8).padStart(6, "0") + "\0 ", 148);
  })), "MALFORMED_ARCHIVE");
  // checksum field with a non-octal suffix
  expectArchiveError(() => readTar(mutate((e) => {
    e.write("        ", 148);
    let s = 0;
    for (let i = 0; i < 512; i++) s += e[i]!;
    e.write(s.toString(8).padStart(6, "0") + "9\0", 148);
  })), "MALFORMED_ARCHIVE");
});

// ---- verdict-6 finding: extended-header structure ----

test("B-3b: consecutive local pax extended headers are refused", () => {
  const files = tv01Package();
  const members = [...files].map(([p, b]) => rawTarEntry(p, b, "0"));
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("path", "SKILL.md")), paxEntry(paxRecord("comment", "second")), ...members)),
    "MALFORMED_ARCHIVE",
  );
  // control: a single extended header consumed by the next file header is fine
  const ok = readTar(tarOf(paxEntry(paxRecord("path", "renamed.md")), rawTarEntry("placeholder", Buffer.from("x"), "0")));
  assert.deepEqual([...ok.keys()], ["renamed.md"]);
});

// coverage (not a regression against the immediate parent — orphan handling
// landed in cbd3211; kept so the structural rule stays covered as a whole)
test("B-3b: an orphan extended header is refused at end-of-archive and when alone", () => {
  const members = [...tv01Package()].map(([p, b]) => rawTarEntry(p, b, "0"));
  expectArchiveError(
    () => readTar(tarOf(...members, paxEntry(paxRecord("path", "never-applied.txt")))),
    "MALFORMED_ARCHIVE",
  );
  expectArchiveError(() => readTar(tarOf(paxEntry(paxRecord("path", "alone.txt")))), "MALFORMED_ARCHIVE");
});

test("B-3c: a pax extended header with zero records is refused (POSIX requires at least one)", () => {
  const empty = rawTarEntry("pax-header", Buffer.alloc(0), "x");
  expectArchiveError(
    () => readTar(tarOf(empty, rawTarEntry("SKILL.md", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  // …including when it precedes a complete signed package
  const members = [...tv01Package()].map(([p, b]) => rawTarEntry(p, b, "0"));
  expectArchiveError(() => readTar(tarOf(empty, ...members)), "MALFORMED_ARCHIVE");
  // control: one real record is still accepted
  const ok = readTar(tarOf(paxEntry(paxRecord("path", "kept.md")), rawTarEntry("ph", Buffer.from("x"), "0")));
  assert.deepEqual([...ok.keys()], ["kept.md"]);
});

// ---- verdict-8: remaining ustar header structure rules ----

/** rawTarEntry with an arbitrary header patch, checksum recomputed. */
function patched(name: string, data: Buffer, typeflag: string, patch: (e: Buffer) => void): Buffer {
  const e = rawTarEntry(name, data, typeflag);
  patch(e);
  e.write("        ", 148);
  let s = 0;
  for (let i = 0; i < 512; i++) s += e[i]!;
  e.write(s.toString(8).padStart(6, "0") + "\0 ", 148);
  return e;
}

test("B-4b: a directory entry with nonzero size (and data blocks) is refused", () => {
  const dirWithData = patched("dir/", Buffer.from("hidden payload"), "5", (e) => {
    e.write((14).toString(8).padStart(11, "0") + "\0", 124);
  });
  expectArchiveError(
    () => readTar(tarOf(dirWithData, rawTarEntry("SKILL.md", Buffer.from("x"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  // control: a zero-size directory entry is fine
  const ok = readTar(tarOf(rawTarEntry("dir/", Buffer.alloc(0), "5"), rawTarEntry("dir/a.txt", Buffer.from("x"), "0")));
  assert.deepEqual([...ok.keys()], ["dir/a.txt"]);
});

test("B-4b: linkname set on a regular file or directory is refused", () => {
  expectArchiveError(
    () => readTar(tarOf(patched("a.txt", Buffer.from("x"), "0", (e) => e.write("/etc/passwd", 157)))),
    "MALFORMED_ARCHIVE",
  );
  expectArchiveError(
    () => readTar(tarOf(patched("d/", Buffer.alloc(0), "5", (e) => e.write("elsewhere", 157)))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-4b: non-octal device fields and ill-formed owner names are refused", () => {
  expectArchiveError(
    () => readTar(tarOf(patched("a.txt", Buffer.from("x"), "0", (e) => e.write("00009x9\0", 329)))),
    "MALFORMED_ARCHIVE",
  );
  expectArchiveError(
    () => readTar(tarOf(patched("a.txt", Buffer.from("x"), "0", (e) => e.write("0000zz0\0", 337)))),
    "MALFORMED_ARCHIVE",
  );
  expectArchiveError(
    () => readTar(tarOf(patched("a.txt", Buffer.from("x"), "0", (e) => { e[265] = 0xff; e[266] = 0; }))),
    "MALFORMED_ARCHIVE",
  );
  // gname is validated exactly like uname
  expectArchiveError(
    () => readTar(tarOf(patched("a.txt", Buffer.from("x"), "0", (e) => { e[297] = 0xff; e[298] = 0; }))),
    "MALFORMED_ARCHIVE",
  );
});

test("B-4b: content after the end-of-archive marker is refused", () => {
  const base = tarOf(rawTarEntry("SKILL.md", Buffer.from("x"), "0"));
  const trailing = Buffer.concat([base, rawTarEntry("smuggled.txt", Buffer.from("payload"), "0")]);
  expectArchiveError(() => readTar(trailing), "MALFORMED_ARCHIVE");
  // control: zero padding after the marker is legitimate blocking-factor padding
  const padded = Buffer.concat([base, Buffer.alloc(4096)]);
  assert.deepEqual([...readTar(padded).keys()], ["SKILL.md"]);
});

// ---- verdict-9: the collision rule must not be WIDER than the spec ----

test("B-5: collision folding is case + NFC/NFD only, never compatibility folding", () => {
  // distinct under the normative rule: a package using both must be accepted
  const ok = readTar(tarOf(rawTarEntry("1.txt", Buffer.from("a"), "0"), rawTarEntry("①.txt", Buffer.from("b"), "0")));
  assert.deepEqual([...ok.keys()].sort(), ["1.txt", "①.txt"].sort());
  const ok2 = readTar(tarOf(rawTarEntry("2.txt", Buffer.from("a"), "0"), rawTarEntry("²2.txt", Buffer.from("b"), "0")));
  assert.equal(ok2.size, 2, "superscript digits are distinct paths, not compatibility duplicates");

  // default full case folding keeps U+0131 DOTLESS I distinct from ASCII "i"
  // (the i↔İ mapping is Turkic-only and not part of the default algorithm)
  const ok3 = readTar(tarOf(rawTarEntry("i.txt", Buffer.from("a"), "0"), rawTarEntry("ı.txt", Buffer.from("b"), "0")));
  assert.equal(ok3.size, 2, "dotless i and ASCII i are distinct under the default fold");

  // still collides: full case fold over NFC
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("straße.txt", Buffer.from("a"), "0"), rawTarEntry("STRASSE.txt", Buffer.from("b"), "0"))),
    "MALFORMED_ARCHIVE",
  );
  expectArchiveError(
    () => readTar(tarOf(rawTarEntry("Café.txt".normalize("NFC"), Buffer.from("a"), "0"), rawTarEntry("CAFÉ.txt".normalize("NFC"), Buffer.from("b"), "0"))),
    "MALFORMED_ARCHIVE",
  );
});

// ---- verdict-10 findings ----

test("B-6: two package members that are the same file are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sklo-hardlink-"));
  writeFileSync(join(dir, "SKILL.md"), "x");
  linkSync(join(dir, "SKILL.md"), join(dir, "alias.md"));
  expectArchiveError(() => readDirectory(dir), "MALFORMED_ARCHIVE");

  // control: identical content in two independent files is fine
  const dir2 = mkdtempSync(join(tmpdir(), "sklo-nolink-"));
  writeFileSync(join(dir2, "SKILL.md"), "x");
  writeFileSync(join(dir2, "copy.md"), "x");
  assert.equal(readDirectory(dir2).size, 2);

  // control: a member whose inode has a link OUTSIDE the package is fine —
  // the package itself contains no duplicate
  const dir3 = mkdtempSync(join(tmpdir(), "sklo-extlink-"));
  const outside = mkdtempSync(join(tmpdir(), "sklo-outside-"));
  writeFileSync(join(dir3, "SKILL.md"), "x");
  linkSync(join(dir3, "SKILL.md"), join(outside, "elsewhere.md"));
  assert.deepEqual([...readDirectory(dir3).keys()], ["SKILL.md"]);
});

test("B-6: recognized pax records with malformed values are refused", () => {
  for (const [k, v] of [["uid", "not-a-decimal-id"], ["gid", "-1"], ["mtime", "not-time"], ["atime", "1e9"]]) {
    expectArchiveError(
      () => readTar(tarOf(paxEntry(paxRecord(k!, v!)), rawTarEntry("SKILL.md", Buffer.from("x"), "0"))),
      "MALFORMED_ARCHIVE",
    );
  }
  // POSIX: an empty value DELETES the attribute — a valid record, not malformed
  assert.deepEqual(
    [...readTar(tarOf(paxEntry(paxRecord("comment", "")), rawTarEntry("SKILL.md", Buffer.from("x"), "0"))).keys()],
    ["SKILL.md"],
  );
  // control: well-formed values still parse, including a fractional time
  const ok = readTar(tarOf(
    paxEntry(Buffer.concat([paxRecord("uid", "1000"), paxRecord("mtime", "1754000000.5"), paxRecord("path", "kept.md")])),
    rawTarEntry("placeholder", Buffer.from("x"), "0"),
  ));
  assert.deepEqual([...ok.keys()], ["kept.md"]);
});

test("B-6: a signed package carrying an invalid pax uid record never verifies", () => {
  const members = [...tv01Package()].map(([p, b]) => rawTarEntry(p, b, "0"));
  expectArchiveError(
    () => readTar(tarOf(paxEntry(paxRecord("uid", "not-a-decimal-id")), ...members)),
    "MALFORMED_ARCHIVE",
  );
});

// ---- verdict-11: the fold must be the REAL Unicode default full case fold ----

test("B-7: full case-fold equivalences collide (µ/μ, ſ/s, ς/σ, Greek iota-subscript)", () => {
  const pairs: Array<[string, string]> = [
    ["µ.txt", "μ.txt"],      // MICRO SIGN vs GREEK SMALL MU
    ["ſ.txt", "s.txt"],      // LONG S vs s
    ["ς.txt", "σ.txt"],      // final sigma vs sigma
    ["ᾈ.txt", "ἀι.txt"],     // iota-subscript capital vs its full-fold expansion
    ["ϐ.txt", "β.txt"],      // beta symbol vs beta
    ["ẞ.txt", "ss.txt"],     // capital sharp s vs ss
  ];
  for (const [a, b] of pairs) {
    expectArchiveError(
      () => readTar(tarOf(rawTarEntry(a, Buffer.from("a"), "0"), rawTarEntry(b, Buffer.from("b"), "0"))),
      "MALFORMED_ARCHIVE",
    );
  }
});

test("B-7: the fold table is complete and self-contained (no runtime toLowerCase)", () => {
  // known Unicode case-folding facts
  assert.equal(CASE_FOLD.get(0x00b5), "μ");   // MICRO SIGN
  assert.equal(CASE_FOLD.get(0x017f), "s");   // LONG S
  assert.equal(CASE_FOLD.get(0x03c2), "σ");   // final sigma
  assert.equal(CASE_FOLD.get(0x00df), "ss");  // sharp s
  assert.equal(CASE_FOLD.get(0x1f88), "ἀι");  // iota-subscript expansion
  assert.equal(CASE_FOLD.get(0x0041), "a");   // plain ASCII is in the table too
  // Cherokee folds LOWERCASE to UPPERCASE — the direction Unicode defines,
  // not the direction toLowerCase() would produce
  assert.equal(CASE_FOLD.get(0xab70), String.fromCodePoint(0x13a0));
  assert.equal(CASE_FOLD.get(0x13a0), undefined, "the uppercase form is already the folded form");
  // Turkic-only mappings must be absent: dotless i folds to itself
  assert.equal(CASE_FOLD.get(0x0131), undefined);
  // no entry may be an identity mapping
  for (const [cp, fold] of CASE_FOLD) {
    assert.notEqual(String.fromCodePoint(cp), fold, `identity entry U+${cp.toString(16)}`);
  }
  // IDEMPOTENCE: folding a folded string must change nothing. A reverse or
  // swapped entry (the Cherokee bug) breaks exactly this.
  const fold = (s: string) => [...s].map((c) => CASE_FOLD.get(c.codePointAt(0)!) ?? c).join("");
  for (const [cp, f] of CASE_FOLD) {
    assert.equal(fold(f), f, `fold is not idempotent for U+${cp.toString(16)} → ${f}`);
  }
});

test("B-7: normalization and folding come from committed tables, not the runtime", () => {
  // Node (Unicode 17) and Bun (15.1) disagree about these code points. The
  // committed tables carry no decomposition or fold for them, so both runtimes
  // treat them identically — and per OD-2026-08-02-2 the profile accepts them:
  // it forbids no such thing.
  for (const p of ["\u{10D50}.txt", "\u{105C9}.txt", "\u{1FAE8}.txt"]) checkPath(p);
  assert.deepEqual(
    [...readTar(tarOf(rawTarEntry("\u{1FAE8}.txt", Buffer.from("a"), "0"))).keys()],
    ["\u{1FAE8}.txt"],
  );
  // a newer character's decomposed spelling is not silently composed
  assert.equal(toNFC("\u{105D2}\u0307"), "\u{105D2}\u0307");
});

test("B-7: the committed NFC agrees with the runtime across the pinned repertoire", () => {
  assert.equal(UNICODE_VERSION, "14.0.0");
  for (const t of ["caf\u00e9", "cafe\u0301", "\ud55c\uad6d", "\u03a9", "\ufb01le", "x\u0301y", "\u1e9b\u0323"]) {
    assert.equal(toNFC(t), t.normalize("NFC"), JSON.stringify(t));
  }
  assert.equal(isNFC("cafe\u0301"), false);
  assert.equal(isNFC("caf\u00e9"), true);
  assert.equal(foldKey("caf\u00e9.txt"), foldKey("cafe\u0301.txt"));
});

test("B-7: Cherokee case pairs collide (the fold direction Unicode defines)", () => {
  expectArchiveError(
    () => readTar(tarOf(
      rawTarEntry("\u13A0.txt", Buffer.from("a"), "0"),
      rawTarEntry("\uAB70.txt", Buffer.from("b"), "0"),
    )),
    "MALFORMED_ARCHIVE",
  );
});

test("B-8: pax uid and gid are digit-only; only times may be fractional", () => {
  for (const k of ["uid", "gid"]) {
    expectArchiveError(
      () => readTar(tarOf(paxEntry(paxRecord(k, "1.5")), rawTarEntry("SKILL.md", Buffer.from("x"), "0"))),
      "MALFORMED_ARCHIVE",
    );
  }
  // control: integer ids and a fractional mtime are both valid
  const ok = readTar(tarOf(
    paxEntry(Buffer.concat([paxRecord("uid", "1000"), paxRecord("gid", "1000"), paxRecord("mtime", "1754000000.25"), paxRecord("path", "kept.md")])),
    rawTarEntry("placeholder", Buffer.from("x"), "0"),
  ));
  assert.deepEqual([...ok.keys()], ["kept.md"]);
});

// ---- §4.1b point 1: the profile refuses only what §4.1b enumerates ----

test("B-9: POSIX constructs the profile does not forbid are accepted", () => {
  // a directory header may carry a nonzero allocation-size hint
  const dirHint = rawTarEntry("dir/", Buffer.alloc(0), "5");
  dirHint.write((4096).toString(8).padStart(11, "0") + "\0", 124);
  dirHint.write("        ", 148);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += dirHint[i]!;
  dirHint.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  assert.deepEqual(
    [...readTar(tarOf(dirHint, rawTarEntry("dir/a.txt", Buffer.from("x"), "0"))).keys()],
    ["dir/a.txt"],
  );

  // the standard UTF-8 hdrcharset record
  const ok = readTar(tarOf(
    paxEntry(Buffer.concat([paxRecord("hdrcharset", "ISO-IR 10646 2000 UTF-8"), paxRecord("path", "kept.md")])),
    rawTarEntry("placeholder", Buffer.from("x"), "0"),
  ));
  assert.deepEqual([...ok.keys()], ["kept.md"]);
});
