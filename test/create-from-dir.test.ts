// [B-1] server-side packing + §5's arrival marker — the two halves of one
// change, tested together because they share one foundation.
//
// WHAT EACH TEST HERE HAS TO DO. This repository has been bitten twice by the
// same class of defect: a guard that proves something OTHER than what it
// claims. Once, the existence of an artefact file was accepted as proof that
// the step producing it had succeeded. Once, a test named "an unverified key
// plus an enable with no countersign still verifies as valid" was recorded as a
// GUARANTEE when it was a description of a vulnerability.
//
// So every test below was checked by MUTATION: the implementation was broken in
// the specific way the test claims to detect, the mutation was confirmed to have
// landed in code rather than in a comment, and the test was confirmed to fail.
// A test that passes on a broken implementation is worth less than no test,
// because it also stops anyone else from writing the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { p2Fixture, makeManifest, NOW, type P2Fixture } from "./p2-helpers.ts";
import { computeIntegrity, readTar, writeTar, type PackageFiles } from "../src/archive.ts";
import { MCP_TOOLS, handleMcpMessage } from "../src/mcp.ts";
import { handleRest } from "../src/http.ts";
import { mintApiKey } from "../src/auth.ts";
import { MemorySecretStore, type SecretStore } from "../src/webhooks.ts";
import { Registry } from "../src/service.ts";
import { seedGraph } from "./helpers.ts";
import { ulid } from "../src/ulid.ts";
import { ctxFor } from "./p2-helpers.ts";
import {
  ARRIVAL_BLOCK_BEGIN,
  ARRIVAL_BLOCK_END,
  ARRIVAL_SCRIPT_PATH,
  MARKER_PREFIX,
  arrivalMarker,
  arrivalVerdict,
  assessArrival,
  checkArrivalIdentity,
  embedArrivalStep,
  markersIn,
  renderArrivalScript,
  shipsArrivalScript,
  type ArrivalRecord,
} from "../src/marker.ts";
import { SYSTEM_KID_PREFIX, systemKidFor } from "../src/system-key.ts";

// --------------------------------------------------------------- source trees

const SKILL_MD = [
  "# From-source demo",
  "",
  "Prose an author wrote, above the procedure.",
  "",
  "## Procedure",
  "",
  "1. Run the fixture.",
  "",
].join("\n");

/**
 * A SOURCE tree: `manifest.json` + `SKILL.md`, and no packed artefacts.
 *
 * `skill_id` is overridable because "the same source, submitted twice" has to
 * mean the same bytes — and `makeManifest` mints a fresh id on every call.
 */
function sourceTree(
  fx: P2Fixture,
  overrides: Record<string, unknown> = {},
  extras: Record<string, string> = {},
): { tar: Buffer; files: PackageFiles; manifest: any } {
  const manifest = makeManifest({ semantic_version: "1.0.0", ...overrides });
  delete manifest.integrity; // a source tree does not carry one; packing computes it
  // nor an author, normally: the registry fills that in from AuthContext. A test
  // that deliberately plants one keeps it, so the refusal can be observed.
  if (!("author_agent" in overrides)) delete manifest.author_agent;
  const files: PackageFiles = new Map();
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  files.set("SKILL.md", Buffer.from(SKILL_MD, "utf8"));
  for (const [path, text] of Object.entries(extras)) files.set(path, Buffer.from(text, "utf8"));
  return { tar: writeTar(files), files, manifest };
}

/** D-6's two shapes, named so a call site says which one it means. */
const WITH_SCRIPT = { executableStep: true } as const;
const WITHOUT_SCRIPT = { executableStep: false } as const;

/** A source tree whose manifest declares `runtime.shell: ["none"]` — the case
 *  D-6 is about. `os` and the rest are left exactly as they were. */
function noShellSource(
  fx: P2Fixture,
  overrides: Record<string, unknown> = {},
  extras: Record<string, string> = {},
): { tar: Buffer; files: PackageFiles; manifest: any } {
  const base = makeManifest();
  const runtime = { ...base.runtime, shell: ["none"] };
  // a package with no shell has no shell COMMANDS either, or §7.1 gate 8 would
  // refuse it on its own account — this is the author's own doing, not ours
  const procedure = {
    ...base.procedure,
    steps: base.procedure.steps.map((s: any) => {
      const { command: _dropped, ...rest } = s;
      return rest;
    }),
  };
  return sourceTree(fx, { runtime, procedure, ...overrides }, extras);
}

/** The bytes the registry actually stored for a version. */
function packedFiles(fx: P2Fixture, versionId: string): PackageFiles {
  const row = fx.db.prepare("SELECT package_blob_ref b FROM skill_versions WHERE id=?").get(versionId) as {
    b: string;
  };
  const blob = fx.registry.blobs.get(row.b);
  assert.ok(blob, "the version's package blob was stored");
  return readTar(blob);
}

function text(files: PackageFiles, path: string): string {
  const b = files.get(path);
  assert.ok(b, `${path} is in the package`);
  return b.toString("utf8");
}

// ===========================================================================
// 1. The marker is derived from the VERSION ID, deterministically [M-1].
// ===========================================================================

test("the arrival marker is a function of the skill version id, and of nothing else", () => {
  // same id → same marker, every time, in any process
  const id = "01K1M83S80EZJBJVYBH8XEK5ZR";
  assert.equal(arrivalMarker(id), arrivalMarker(id));
  assert.equal(
    arrivalMarker(id),
    `${MARKER_PREFIX}${createHash("sha256")
      .update(id, "utf8")
      .digest()
      // the first 16 Crockford base32 characters of the digest — D-1's form,
      // recomputed here from first principles rather than from the module
      .reduce<{ acc: number; bits: number; out: string }>(
        (s, byte) => {
          s.acc = (s.acc << 8) | byte;
          s.bits += 8;
          while (s.bits >= 5) {
            s.bits -= 5;
            s.out += "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[(s.acc >> s.bits) & 31];
          }
          return s;
        },
        { acc: 0, bits: 0, out: "" },
      ).out.slice(0, 16)}`,
    "D-1: SKLN1-<base32(sha256(skill_version_id))[:16]>",
  );

  // different ids → different markers. Two versions really packed by the
  // registry, so this is the property as it ships and not as a helper computes it.
  const fx = p2Fixture();
  const a = fx.registry.createFromDir(fx.author, { slug: "marker-a", source: sourceTree(fx).tar }).response;
  const b = fx.registry.createFromDir(fx.author, {
    slug: "marker-b",
    source: sourceTree(fx, { semantic_version: "2.0.0" }).tar,
  }).response;
  assert.notEqual(a.skill_version_id, b.skill_version_id);
  assert.notEqual(a.arrival_marker, b.arrival_marker, "different versions carry different markers");
  assert.equal(a.arrival_marker, arrivalMarker(a.skill_version_id));
  assert.equal(b.arrival_marker, arrivalMarker(b.skill_version_id));
  fx.db.close();
});

test("the marker is NOT derived from the package content — that would be a circle", () => {
  // The forbidden alternative, stated as a check rather than as prose: the
  // marker of a shipped version is reproducible from its id ALONE, with no
  // access to the package, its content_hash or its manifest_hash.
  const fx = p2Fixture();
  const out = fx.registry.createFromDir(fx.author, { slug: "not-content-derived", source: sourceTree(fx).tar })
    .response;
  assert.equal(arrivalMarker(out.skill_version_id), out.arrival_marker);
  assert.notEqual(out.arrival_marker, arrivalMarker(out.content_hash));
  assert.notEqual(out.arrival_marker, arrivalMarker(out.manifest_hash));
  fx.db.close();
});

// ===========================================================================
// 2. The packing guard REFUSES on any of the three disagreements.
// ===========================================================================

test("the packing guard refuses when SKILL.md, the script and the version id disagree — each case separately", () => {
  const id = "01K1M83S80EZJBJVYBH8XEK5ZR";
  const other = "01K1M83S80EZJBJVYBH8XEK5ZS";
  assert.notEqual(arrivalMarker(id), arrivalMarker(other));

  const good = (): PackageFiles => {
    const f: PackageFiles = new Map();
    f.set("SKILL.md", Buffer.from(embedArrivalStep(SKILL_MD, id, WITH_SCRIPT), "utf8"));
    f.set(ARRIVAL_SCRIPT_PATH, Buffer.from(renderArrivalScript(id), "utf8"));
    return f;
  };
  assert.equal(checkArrivalIdentity(good(), id, WITH_SCRIPT).ok, true, "the agreeing case holds");

  // (a) SKILL.md carries another version's marker
  const a = good();
  a.set("SKILL.md", Buffer.from(embedArrivalStep(SKILL_MD, other, WITH_SCRIPT), "utf8"));
  const ra = checkArrivalIdentity(a, id, WITH_SCRIPT);
  assert.equal(ra.ok, false);
  assert.match(String(ra.reason), /SKILL\.md's marker .* is not the marker/);

  // (b) the script prints another version's marker
  const b = good();
  b.set(ARRIVAL_SCRIPT_PATH, Buffer.from(renderArrivalScript(other), "utf8"));
  const rb = checkArrivalIdentity(b, id, WITH_SCRIPT);
  assert.equal(rb.ok, false);
  assert.match(String(rb.reason), /skln-arrive\.sh's marker .* is not the marker/);

  // (c) both agree with each other but neither with the version id — the case a
  // two-way comparison would call fine, which is why the guard is three-way
  const c: PackageFiles = new Map();
  c.set("SKILL.md", Buffer.from(embedArrivalStep(SKILL_MD, other, WITH_SCRIPT), "utf8"));
  c.set(ARRIVAL_SCRIPT_PATH, Buffer.from(renderArrivalScript(other), "utf8"));
  const rc = checkArrivalIdentity(c, id, WITH_SCRIPT);
  assert.equal(rc.ok, false, "SKILL.md == script is NOT sufficient; the id decides");
  assert.equal(rc.in_skill_md, rc.in_script, "the two agreed with each other");
  assert.notEqual(rc.in_skill_md, rc.expected);

  // (d) and absence is a refusal, not a pass by default
  const d1 = good();
  d1.delete(ARRIVAL_SCRIPT_PATH);
  assert.equal(checkArrivalIdentity(d1, id, WITH_SCRIPT).ok, false, "a missing script refuses");
  const d2 = good();
  d2.set("SKILL.md", Buffer.from(SKILL_MD, "utf8")); // no generated block at all
  assert.equal(checkArrivalIdentity(d2, id, WITH_SCRIPT).ok, false, "a missing block refuses");
});

test("the packed version passes the guard, and the guard is what the packing path ran", () => {
  const fx = p2Fixture();
  const out = fx.registry.createFromDir(fx.author, { slug: "guarded", source: sourceTree(fx).tar }).response;
  const files = packedFiles(fx, out.skill_version_id);

  const identity = checkArrivalIdentity(files, out.skill_version_id, WITH_SCRIPT);
  assert.equal(identity.ok, true, identity.reason ?? "");
  assert.equal(identity.in_skill_md, out.arrival_marker);
  assert.equal(identity.in_script, out.arrival_marker);

  // the two places D-1 names, and the block delimiters that make the SKILL.md
  // half a GENERATED region rather than prose someone might edit by accident
  const md = text(files, "SKILL.md");
  assert.ok(md.includes(ARRIVAL_BLOCK_BEGIN) && md.includes(ARRIVAL_BLOCK_END));
  assert.ok(
    md.indexOf(ARRIVAL_BLOCK_BEGIN) > md.indexOf("## Procedure"),
    "the block is the FIRST STEP of the procedure, not a footnote",
  );
  assert.ok(
    md.indexOf(ARRIVAL_BLOCK_BEGIN) < md.indexOf("1. Run the fixture."),
    "and it precedes the author's own first step",
  );
  assert.ok(md.includes(`./${ARRIVAL_SCRIPT_PATH}`), "the block tells the agent what to run");

  const script = text(files, ARRIVAL_SCRIPT_PATH);
  assert.ok(script.includes(out.arrival_marker), "the script prints the marker");
  assert.ok(script.includes(out.skill_version_id), "and the version id it belongs to");
  fx.db.close();
});

// ===========================================================================
// 3. `integrity` COVERS the marker.
// ===========================================================================

test("integrity covers the arrival marker: altering it after packing breaks verification", () => {
  const fx = p2Fixture();
  const out = fx.registry.createFromDir(fx.author, { slug: "integrity-covers", source: sourceTree(fx).tar })
    .response;
  const files = packedFiles(fx, out.skill_version_id);

  // the untouched package verifies past §4.4's integrity step — the verdict is
  // about lifecycle state, never about the bytes
  const clean = fx.registry.verifyStateless(fx.author, writeTar(files));
  assert.notEqual(clean.verdict, "TAMPERED_CONTENT");

  // Both carriers of the marker are covered, and the integrity list names both.
  const declared = JSON.parse(text(files, "skill.json")).integrity as Array<{ path: string; sha256: string }>;
  assert.deepEqual(
    declared.map((e) => e.path).sort(),
    ["SKILL.md", ARRIVAL_SCRIPT_PATH].sort(),
    "integrity lists exactly the shipped files, the generated script included",
  );

  for (const path of ["SKILL.md", ARRIVAL_SCRIPT_PATH]) {
    const tampered = new Map(files);
    const before = text(files, path);
    const after = before.replace(out.arrival_marker, arrivalMarker("01K1M83S80EZJBJVYBH8XEK5ZZ"));
    assert.notEqual(after, before, `the tamper actually changed ${path}`);
    tampered.set(path, Buffer.from(after, "utf8"));
    const v = fx.registry.verifyStateless(fx.author, writeTar(tampered));
    assert.equal(v.verdict, "TAMPERED_CONTENT", `a swapped marker in ${path} is caught`);
  }

  // and the same fact at the level below the verdict: the declared list is the
  // list of the bytes that ship, marker included
  assert.deepEqual(computeIntegrity(files), declared);
  fx.db.close();
});

// ===========================================================================
// 4. Convergence is judged on the SOURCE, not on the packed bytes.
//
// This is the trap the marker sets. Because the marker is derived from a freshly
// minted id, packing one source twice produces two byte-different packages. A
// convergence check on `manifest_hash`/`content_hash` — which is what
// `skill.create` uses and what looks obviously right here — can therefore NEVER
// fire, and a resubmitted source would mint versions for ever, silently.
// ===========================================================================

test("resubmitting an UNCHANGED source converges on the version already packed from it", () => {
  const fx = p2Fixture();
  const { tar } = sourceTree(fx, { skill_id: ulid(NOW) });

  const first = fx.registry.createFromDir(fx.author, { slug: "converge", source: tar }).response;
  assert.equal(first.noop, undefined, "the first submission is not a noop");

  // The SAME source bytes again — no idempotency_key, so nothing is being
  // replayed: this is convergence on content, decided by the service.
  const second = fx.registry.createFromDir(fx.author, { slug: "converge", source: tar }).response;
  assert.equal(second.noop, true, "the second submission converged");
  assert.equal(second.skill_version_id, first.skill_version_id, "…on the SAME version");
  assert.equal(second.arrival_marker, first.arrival_marker, "…and reports THAT version's marker");

  const rows = fx.db
    .prepare("SELECT id FROM skill_versions WHERE skill_id=? AND semantic_version='1.0.0'")
    .all(first.skill_id) as Array<{ id: string }>;
  assert.equal(rows.length, 1, "one source, one version — not one version per submission");

  // And the reason the check cannot live on the packed bytes, demonstrated
  // rather than argued: submit the SAME source bytes to a second registry. The
  // version id it mints is a different one, so the marker is different, so the
  // package is different — and `content_hash`/`manifest_hash` therefore differ
  // for input that is byte-for-byte identical.
  const twin = p2Fixture();
  const other = twin.registry.createFromDir(twin.author, { slug: "converge", source: tar }).response;
  assert.notEqual(other.skill_version_id, first.skill_version_id);
  assert.notEqual(other.arrival_marker, first.arrival_marker);
  assert.notEqual(
    other.content_hash,
    first.content_hash,
    "one unchanged source packs to DIFFERENT bytes — which is exactly why the check cannot live there",
  );
  assert.notEqual(other.manifest_hash, first.manifest_hash);
  twin.db.close();
  fx.db.close();
});

test("a CHANGED source under an existing semantic_version is a CONFLICT, not a silent second version", () => {
  const fx = p2Fixture();
  const sid = ulid(NOW);
  fx.registry.createFromDir(fx.author, { slug: "conflict", source: sourceTree(fx, { skill_id: sid }).tar });
  const changed = sourceTree(fx, { skill_id: sid }, { "fixtures/extra.txt": "a file the first submission did not have\n" });
  assert.throws(
    () => fx.registry.createFromDir(fx.author, { slug: "conflict", source: changed.tar }),
    (e: any) => e.code === "CONFLICT" && typeof e.current_state === "string",
    "different source, same version number → CONFLICT with the current state",
  );
  fx.db.close();
});

test("convergence follows the source through cosmetic changes and stops at real ones", () => {
  const fx = p2Fixture();
  const built = sourceTree(fx, { skill_id: ulid(NOW) });

  // reformatting manifest.json changes its bytes and no claim it makes
  const reformatted: PackageFiles = new Map(built.files);
  const pretty = JSON.stringify(JSON.parse(text(built.files, "manifest.json")), null, 2);
  assert.notEqual(pretty, text(built.files, "manifest.json"), "the reformat changed the bytes");
  reformatted.set("manifest.json", Buffer.from(pretty, "utf8"));

  const first = fx.registry.createFromDir(fx.author, { slug: "cosmetic", source: built.tar }).response;
  const same = fx.registry.createFromDir(fx.author, { slug: "cosmetic", source: writeTar(reformatted) }).response;
  assert.equal(same.noop, true, "a reformatted manifest is the same source");
  assert.equal(same.skill_version_id, first.skill_version_id);

  // changing what the manifest SAYS is a different source
  const retitled: PackageFiles = new Map(built.files);
  const m = JSON.parse(text(built.files, "manifest.json"));
  m.title = "a different title";
  retitled.set("manifest.json", Buffer.from(JSON.stringify(m), "utf8"));
  assert.throws(
    () => fx.registry.createFromDir(fx.author, { slug: "cosmetic", source: writeTar(retitled) }),
    (e: any) => e.code === "CONFLICT",
  );
  fx.db.close();
});

// ===========================================================================
// 5. [I-7]: the private half appears in NOTHING observable.
// ===========================================================================

/** A store that keeps every secret ever written, so a test can look for them. */
class SpySecretStore implements SecretStore {
  readonly inner = new MemorySecretStore();
  readonly written: string[] = [];
  put(ref: string, secret: string): void {
    this.written.push(secret);
    this.inner.put(ref, secret);
  }
  get(ref: string): string | undefined {
    return this.inner.get(ref);
  }
  delete(ref: string): void {
    this.inner.delete(ref);
  }
}

/**
 * WHAT THIS TEST CAN AND CANNOT PROVE — stated, because it used to overstate it.
 *
 * It searches SAVED BYTES: the archive, the response, every table of the live
 * database, every lint report and error message. That is a real sweep and it
 * covers everything whose saved form still contains what was written.
 *
 * IT DOES NOT COVER THE TRANSPARENCY LOG, and cannot. That table saves
 * `sha256(jcs(payload))` and never the payload, so a seed placed in a payload
 * would be stored as a hash and no search of any row could find it — this test
 * passed, unchanged, with the seed added to the payload. The log is covered at
 * its APPEND SITE instead, over the preimage, by `appendKeyRegistrationTlog`
 * (src/system-key.ts), and `test/p14-r2-invariants.test.ts` runs that very
 * mutation and requires the pack to REFUSE.
 */
test("no private signing material reaches the package, the response, the database or a log line", () => {
  const seed = seedGraph();
  const secrets = new SpySecretStore();
  const registry = new Registry(seed.db, { now: () => NOW, secrets });
  const author = ctxFor(seed, seed.authorA, seed.wsA, "member");
  const fx = { db: seed.db, registry, author } as unknown as P2Fixture;

  const out = registry.createFromDir(author, { slug: "no-leak", source: sourceTree(fx).tar }).response;

  assert.equal(secrets.written.length, 1, "exactly one private seed was generated and stored");
  const seedHex = secrets.written[0]!;
  assert.match(seedHex, /^[0-9a-f]{64}$/, "and it is a 32-byte Ed25519 seed");
  const raw = Buffer.from(seedHex, "hex");

  // every encoding the material could wear on the way out
  const needles = [
    seedHex,
    seedHex.toUpperCase(),
    raw.toString("base64"),
    raw.toString("base64url"),
  ];

  const haystacks: Array<[string, Buffer]> = [];
  const blobRef = (seed.db.prepare("SELECT package_blob_ref b FROM skill_versions WHERE id=?").get(
    out.skill_version_id,
  ) as { b: string }).b;
  haystacks.push(["the package archive", registry.blobs.get(blobRef)!]);
  haystacks.push(["the response body", Buffer.from(JSON.stringify(out), "utf8")]);
  haystacks.push(["the arrival marker", Buffer.from(out.arrival_marker, "utf8")]);
  // the WHOLE database file, table by table — not just the columns we expected
  for (const t of seed.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string;
  }>) {
    const rows = seed.db.prepare(`SELECT * FROM "${t.name}"`).all();
    haystacks.push([`table ${t.name}`, Buffer.from(JSON.stringify(rows), "utf8")]);
  }
  // and every lint report and error message the surfaces produce for it
  haystacks.push([
    "the lint response",
    Buffer.from(JSON.stringify(registry.lintVersion(author, out.skill_version_id).response), "utf8"),
  ]);
  try {
    registry.createFromDir(author, { slug: "no-leak", source: sourceTree(fx, {}, { "x.txt": "y" }).tar });
  } catch (e: any) {
    haystacks.push(["the CONFLICT error message", Buffer.from(String(e.message), "utf8")]);
  }

  for (const [where, hay] of haystacks) {
    for (const needle of needles) {
      assert.ok(!hay.includes(needle), `private signing material appeared in ${where}`);
    }
    assert.ok(!hay.includes(raw), `private signing material appeared raw in ${where}`);
  }

  // What the database DOES hold is the public half, the kid and a HANDLE
  const key = seed.db.prepare("SELECT * FROM signing_keys WHERE kid=?").get(systemKidFor(seed.authorA)) as any;
  assert.ok(key, "the system key is on file");
  assert.equal(key.public_key_ed25519.length, 43, "the PUBLIC half, in §4.3 encoding");
  assert.match(key.secret_ref, /^secretstore:\/\/signing-key\//, "a reference, not the material");
  assert.ok(!needles.some((n) => key.secret_ref.includes(n)), "and the reference is not the material in disguise");

  // the tlog row that records the binding carries the public half only
  const tlog = seed.db
    .prepare("SELECT payload_hash, subject_id FROM transparency_log WHERE subject_id=?")
    .all(systemKidFor(seed.authorA)) as Array<{ payload_hash: string; subject_id: string }>;
  assert.equal(tlog.length, 1, "the kid→agent binding is logged, once");
  seed.db.close();
});

test("the system key is per principal, and a key with no system-held half is never signed with", () => {
  const fx = p2Fixture();
  const kid = systemKidFor(fx.author.agent_id);
  assert.ok(kid.startsWith(SYSTEM_KID_PREFIX));
  assert.match(kid, /^[a-z0-9-]{1,64}$/, "§4.3.4 / D.1 charset");
  assert.ok(!/^[0-9a-f]{64}$/.test(kid), "and never the manifest_hash namespace of the tlog");

  const out = fx.registry.createFromDir(fx.author, { slug: "per-principal", source: sourceTree(fx).tar }).response;
  assert.equal(out.kid, kid, "the package is signed by the AUTHOR's key, not by a registry-wide one");
  const manifest = JSON.parse(
    (fx.db.prepare("SELECT manifest_json m FROM skill_versions WHERE id=?").get(out.skill_version_id) as {
      m: string;
    }).m,
  );
  assert.equal(manifest.author_agent, fx.author.agent_id, "§4.4 step 3 resolves kid against THIS author");

  // a kid registered through `signing_key.register` has no `secret_ref`, and the
  // registry refuses to pretend it can sign with it
  const other = p2Fixture();
  other.registry.registerSigningKey(other.author, {
    kid: systemKidFor(other.author.agent_id),
    public_key_ed25519: "MOmq9idi5bgD80FucnBwt7qPx49AJp28q8eJP__8M2Q",
  });
  assert.throws(
    () => other.registry.createFromDir(other.author, { slug: "hijack", source: sourceTree(other).tar }),
    /registered without a system-held private half/,
    "a caller cannot displace the system key by claiming its name first",
  );
  fx.db.close();
  other.db.close();
});

// ===========================================================================
// 6. The main path takes NO cryptographic material, at all, from anyone.
// ===========================================================================

test("create_from_dir → lint → reviewed with no seed, no kid and no hand-written manifest", () => {
  const fx = p2Fixture();
  const { tar } = sourceTree(fx);

  // The ENTIRE input: a slug and the bytes of a directory. Nothing else is
  // passed, so nothing else can have been typed by an owner — which is the
  // whole of what [B-1] asks for: no config edited by hand, no seed at a prompt.
  const out = fx.registry.createFromDir(fx.author, { slug: "no-crypto-args", source: tar }).response;
  assert.equal(out.state, "draft");

  const lint = fx.registry.lintVersion(fx.author, out.skill_version_id).response;
  assert.equal(lint.state, "linted", `the generated package passes §7.1 unaided: ${JSON.stringify(lint.reports)}`);
  assert.equal(lint.reports.length, 8, "all eight gates ran");
  assert.deepEqual(
    lint.reports.filter((r) => r.result === "fail"),
    [],
    "the marker script trips no gate — the gates were not relaxed for it",
  );

  // and on to a reviewed version, still with no cryptographic argument anywhere
  fx.registry.review(fx.author, out.skill_version_id, { action: "request" });
  const reviewed = fx.registry.review(fx.owner, out.skill_version_id, { action: "verdict", verdict: "approve" })
    .response;
  assert.equal(reviewed.state, "reviewed");

  // The declared surface is checked too, not just this call: no field of either
  // adapter accepts key material.
  const tool = MCP_TOOLS.find((t) => t.name === "skill.create_from_dir") as any;
  assert.deepEqual(
    Object.keys(tool.inputSchema.properties).sort(),
    ["idempotency_key", "skill_id", "slug", "source_base64"],
    "the tool's whole input surface — no seed, no kid, no key, no signature",
  );
  fx.db.close();
});

test("a source tree carrying packed artefacts is refused, and named the surface that takes one", () => {
  const fx = p2Fixture();
  for (const produced of ["skill.json", "SIGNATURE.jws"]) {
    const built = sourceTree(fx);
    const files = new Map(built.files);
    files.set(produced, Buffer.from("{}", "utf8"));
    assert.throws(
      () => fx.registry.createFromDir(fx.author, { slug: "packed-source", source: writeTar(files) }),
      (e: any) => e.code === "INVALID_SCHEMA" && /skill\.create/.test(e.message),
      `${produced} in a source tree is refused`,
    );
  }
  fx.db.close();
});

test("a malformed source manifest is INVALID_SCHEMA, never a database error", () => {
  // The source manifest decides `skill_id` and `semantic_version`, both of which
  // reach SQL. Validating only AFTER the marker is embedded left a junk manifest
  // to surface as a parameter-binding error — an untyped 500 where §6's error
  // model promises a typed envelope.
  const fx = p2Fixture();
  const junk = (manifest: unknown): Buffer => {
    const files: PackageFiles = new Map();
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
    files.set("SKILL.md", Buffer.from(SKILL_MD, "utf8"));
    return writeTar(files);
  };
  const drop = (field: string): any => {
    const m = sourceTree(fx).manifest;
    delete m[field];
    return m;
  };
  for (const [what, manifest] of [
    ["a manifest that is not one at all", { hello: "world" }],
    ["a manifest with no skill_id", drop("skill_id")],
    ["a manifest with no semantic_version", drop("semantic_version")],
  ] as Array<[string, unknown]>) {
    assert.throws(
      () => fx.registry.createFromDir(fx.author, { slug: "malformed-source", source: junk(manifest) }),
      (e: any) => e.code === "INVALID_SCHEMA",
      what,
    );
  }
  fx.db.close();
});

test("author_agent comes from authentication and a payload cannot name another author", () => {
  const fx = p2Fixture();
  const built = sourceTree(fx, { author_agent: fx.member.agent_id });
  assert.throws(
    () => fx.registry.createFromDir(fx.author, { slug: "wrong-author", source: built.tar }),
    (e: any) => e.code === "FORBIDDEN",
  );
  // omitting it entirely is the normal path — the registry fills it in
  const out = fx.registry.createFromDir(fx.author, { slug: "right-author", source: sourceTree(fx).tar }).response;
  const manifest = JSON.parse(text(packedFiles(fx, out.skill_version_id), "skill.json"));
  assert.equal(manifest.author_agent, fx.author.agent_id);
  fx.db.close();
});

// ===========================================================================
// 7. [I-8]: this tool is one step of the loop, and it says that it WRITES.
// ===========================================================================

test("skill.create_from_dir advertises itself as a write, and its read twin still advertises a read", () => {
  const write = MCP_TOOLS.find((t) => t.name === "skill.create_from_dir") as any;
  assert.ok(write, "the tool is advertised");
  assert.equal(write.annotations?.readOnlyHint, false, "a client must not take this for a read");
  assert.equal(write.annotations?.destructiveHint, true, "it mints a version and a key; a client may ask first");
  assert.equal(write.annotations?.openWorldHint, false, "it touches this registry and nothing else");

  // the contrast the invariant is about: the read tool next door is still a read
  const read = MCP_TOOLS.find((t) => t.name === "migration.count") as any;
  assert.equal(read.annotations?.readOnlyHint, true);
  assert.equal(read.annotations?.destructiveHint, false);

  // and it is ONE step, not a catch-all: no tool name is a prefix router
  assert.equal(
    MCP_TOOLS.filter((t) => t.name === "skill.create_from_dir").length,
    1,
    "one name, one step",
  );
});

// ===========================================================================
// 8. [M-7]: the consuming primitives take a RECORD, never a path.
//     [I-1]/[M-5]: the third answer is `unknown`, and it is the default.
// ===========================================================================

test("markers are parsed out of a record, and a record is a string", () => {
  const marker = arrivalMarker("01K1M83S80EZJBJVYBH8XEK5ZR");
  assert.deepEqual(markersIn(`… ${marker} …`), [marker]);
  assert.deepEqual(markersIn(`{"output":"${marker}\\n"}`), [marker], "a JSON-ish transcript line, not a file");
  assert.deepEqual(markersIn("nothing here"), []);
  // a truncated or extended marker is not a marker: a corrupted record must not
  // parse as a good one
  assert.deepEqual(markersIn(marker.slice(0, -1)), []);
  assert.deepEqual(markersIn(`${marker}X`), []);
  // and the primitive never touches a filesystem: a path-shaped argument is
  // just text with no marker in it
  assert.deepEqual(markersIn("/var/log/agent/transcript.jsonl"), []);
});

test("[M-5]: `invoked` needs a PAIR, and everything else is `unknown` — never `no`", () => {
  const marker = arrivalMarker("01K1M83S80EZJBJVYBH8XEK5ZR");
  const otherMarker = arrivalMarker("01K1M83S80EZJBJVYBH8XEK5ZS");

  assert.equal(
    arrivalVerdict(
      [
        { role: "call", call_id: "c-1", text: `sh ./${ARRIVAL_SCRIPT_PATH}` },
        { role: "output", call_id: "c-1", text: `skln-arrival-marker: ${marker}` },
      ],
      marker,
    ),
    "unknown",
    "an output alone is not a pair: the call did not carry the marker",
  );
  assert.equal(
    arrivalVerdict(
      [
        { role: "call", call_id: "c-1", text: `echo ${marker}` },
        { role: "output", call_id: "c-1", text: `skln-arrival-marker: ${marker}` },
      ],
      marker,
    ),
    "yes",
    "call AND output, both carrying this version's marker, bound by ONE call_id",
  );
  // [M-5]: a pair is what the RUNTIME bound, and the id is what says so
  assert.equal(
    arrivalVerdict(
      [
        { role: "call", call_id: "c-1", text: `echo ${marker}` },
        { role: "output", call_id: "c-2", text: `skln-arrival-marker: ${marker}` },
      ],
      marker,
    ),
    "unknown",
    "a call of one invocation and an output of another are two facts, not one pair",
  );
  assert.equal(
    arrivalVerdict(
      [
        { role: "call", call_id: null, text: `echo ${marker}` },
        { role: "output", call_id: null, text: `skln-arrival-marker: ${marker}` },
      ],
      marker,
    ),
    "unknown",
    "a runtime that bound nothing produced no pair: a null call_id can never pair",
  );
  assert.equal(
    arrivalVerdict(
      [
        { role: "call", call_id: "", text: `echo ${marker}` },
        { role: "output", call_id: "", text: `skln-arrival-marker: ${marker}` },
      ],
      marker,
    ),
    "unknown",
    "an EMPTY call_id is not an id: two records bound by nothing are not a pair",
  );
  assert.equal(
    arrivalVerdict([{ role: "call", call_id: "c-1", text: marker }], marker),
    "unknown",
    "a call alone is not a pair",
  );
  assert.equal(
    arrivalVerdict([{ role: "output", call_id: "c-1", text: marker }], marker),
    "unknown",
    "an output alone is not a pair",
  );
  assert.equal(arrivalVerdict([], marker), "unknown", "[A-0]: no records is `unknown`, never `no`");
  assert.equal(
    arrivalVerdict(
      [
        { role: "call", call_id: "c-1", text: otherMarker },
        { role: "output", call_id: "c-1", text: otherMarker },
      ],
      marker,
    ),
    "unknown",
    "another version's pair says nothing about this version",
  );
  // there is no third value to return
  const values = new Set(
    [
      arrivalVerdict([], marker),
      arrivalVerdict([{ role: "call", call_id: "c-1", text: marker }], marker),
      arrivalVerdict(
        [
          { role: "call", call_id: "c-1", text: marker },
          { role: "output", call_id: "c-1", text: marker },
        ],
        marker,
      ),
    ],
  );
  assert.deepEqual([...values].sort(), ["unknown", "yes"], "the vocabulary is `yes` and `unknown`");
});

// ===========================================================================
// 9. D-6: `runtime.shell: ["none"]`.
//
// A package whose author declared that no shell runs it was still being handed
// a generated shell script. No §7.1 gate refused it — gate 8 reads
// `steps[].command`, not `scripts/` — but the package and its own signed
// manifest disagreed, which is the defect §3 puts first.
//
// The fix is NOT to amend the declaration to `["sh"]`. That would make the
// manifest assert an interpreter the author never asked for, which is the same
// defect pointing the other way. The script is simply not shipped; the SKILL.md
// block still is; and the two facts that follow from that — a two-place
// identity check, and an arrival that is structurally undemonstrable — are said
// out loud rather than left to be inferred.
// ===========================================================================

test("D-6: a `[\"none\"]` version ships NO arrival script, and its SKILL.md block still carries the right marker", () => {
  const fx = p2Fixture();
  const built = noShellSource(fx);
  assert.deepEqual(built.manifest.runtime.shell, ["none"], "the source really declares no shell");

  const out = fx.registry.createFromDir(fx.author, { slug: "no-shell", source: built.tar }).response;
  const files = packedFiles(fx, out.skill_version_id);

  assert.equal(files.has(ARRIVAL_SCRIPT_PATH), false, "no shell declared, no shell script shipped");
  const md = text(files, "SKILL.md");
  assert.ok(md.includes(ARRIVAL_BLOCK_BEGIN) && md.includes(ARRIVAL_BLOCK_END), "the block is generated anyway");
  assert.deepEqual(markersIn(md), [out.arrival_marker], "and carries exactly this version's marker");
  assert.equal(out.arrival_marker, arrivalMarker(out.skill_version_id), "[M-1] is not relaxed for this case");

  // the block does not tell a reader to run a file that is not there…
  assert.ok(!md.includes(`./${ARRIVAL_SCRIPT_PATH}`), "no instruction to run a script the package lacks");
  // …and says why, so nobody goes looking for evidence that cannot exist
  assert.ok(/Arrival step: none/.test(md));

  // the manifest is the author's: it still says exactly what the author wrote
  const packedManifest = JSON.parse(text(files, "skill.json"));
  assert.deepEqual(packedManifest.runtime.shell, ["none"], "the declaration was NOT amended to ['sh']");

  // and the whole thing still passes §7.1 unaided
  const lint = fx.registry.lintVersion(fx.author, out.skill_version_id).response;
  assert.deepEqual(lint.reports.filter((r) => r.result === "fail"), [], JSON.stringify(lint.reports));
  assert.equal(lint.state, "linted");
  fx.db.close();
});

test("D-6: a version that declares a shell is unchanged — script shipped, THREE values compared", () => {
  const fx = p2Fixture();
  const built = sourceTree(fx);
  assert.deepEqual(built.manifest.runtime.shell, ["bash", "sh"], "the ordinary case really declares a shell");

  const out = fx.registry.createFromDir(fx.author, { slug: "has-shell", source: built.tar }).response;
  const files = packedFiles(fx, out.skill_version_id);
  assert.equal(files.has(ARRIVAL_SCRIPT_PATH), true, "a shell is declared, so the script ships");

  const identity = checkArrivalIdentity(files, out.skill_version_id, WITH_SCRIPT);
  assert.equal(identity.ok, true, identity.reason ?? "");
  assert.equal(identity.places, 3, "three places, because there are three places for a marker to live");
  assert.equal(identity.in_skill_md, out.arrival_marker);
  assert.equal(identity.in_script, out.arrival_marker);
  fx.db.close();
});

test("D-6: the TWO-place guard still refuses a wrong marker in SKILL.md", () => {
  const id = "01K1M83S80EZJBJVYBH8XEK5ZR";
  const other = "01K1M83S80EZJBJVYBH8XEK5ZS";

  const good: PackageFiles = new Map();
  good.set("SKILL.md", Buffer.from(embedArrivalStep(SKILL_MD, id, WITHOUT_SCRIPT), "utf8"));
  const ok = checkArrivalIdentity(good, id, WITHOUT_SCRIPT);
  assert.equal(ok.ok, true, ok.reason ?? "");
  assert.equal(ok.places, 2, "two places, because there is no third one");
  assert.equal(ok.in_script, null);

  // the one comparison there is, is actually made
  const wrong: PackageFiles = new Map();
  wrong.set("SKILL.md", Buffer.from(embedArrivalStep(SKILL_MD, other, WITHOUT_SCRIPT), "utf8"));
  const bad = checkArrivalIdentity(wrong, id, WITHOUT_SCRIPT);
  assert.equal(bad.ok, false, "fewer places is not a lower bar");
  assert.equal(bad.places, 2);
  assert.match(String(bad.reason), /SKILL\.md's marker .* is not the marker/);

  // and a missing block is still a refusal, not a pass by default
  const empty: PackageFiles = new Map();
  empty.set("SKILL.md", Buffer.from(SKILL_MD, "utf8"));
  assert.equal(checkArrivalIdentity(empty, id, WITHOUT_SCRIPT).ok, false, "no block, no pack");
});

test("D-6 degenerate case: a package WITH a script never gets the two-place check", () => {
  // The failure this test exists for is a guard that "adapts" by noticing the
  // script is there and comparing two values anyway — a weakening wearing the
  // word "adaptive". Two independent facts make it visible: the reported number
  // of places, and a package whose script disagrees.
  const id = "01K1M83S80EZJBJVYBH8XEK5ZR";
  const other = "01K1M83S80EZJBJVYBH8XEK5ZS";

  const withBadScript: PackageFiles = new Map();
  withBadScript.set("SKILL.md", Buffer.from(embedArrivalStep(SKILL_MD, id, WITH_SCRIPT), "utf8"));
  withBadScript.set(ARRIVAL_SCRIPT_PATH, Buffer.from(renderArrivalScript(other), "utf8"));

  const judged = checkArrivalIdentity(withBadScript, id, WITH_SCRIPT);
  assert.equal(judged.places, 3, "a version that ships a script is judged on three places, always");
  assert.equal(judged.ok, false, "the script's marker was compared, and it disagreed");
  assert.match(String(judged.reason), /skln-arrive\.sh's marker .* is not the marker/);

  // The shape is an INPUT, not an observation: a script present where the
  // manifest declares none is itself a refusal, so a packer bug that shipped one
  // cannot pass by making the guard agree with what it found.
  const stray: PackageFiles = new Map();
  stray.set("SKILL.md", Buffer.from(embedArrivalStep(SKILL_MD, id, WITHOUT_SCRIPT), "utf8"));
  stray.set(ARRIVAL_SCRIPT_PATH, Buffer.from(renderArrivalScript(id), "utf8"));
  const strayJudged = checkArrivalIdentity(stray, id, WITHOUT_SCRIPT);
  assert.equal(strayJudged.ok, false, "a script the manifest did not ask for is a refusal");
  assert.match(String(strayJudged.reason), /is present although the manifest declares/);

  // and the real packing path really does take the shape from the manifest
  const fx = p2Fixture();
  const shellVersion = fx.registry.createFromDir(fx.author, { slug: "shape-shell", source: sourceTree(fx).tar })
    .response;
  const noneVersion = fx.registry.createFromDir(fx.author, {
    slug: "shape-none",
    source: noShellSource(fx).tar,
  }).response;
  assert.equal(
    checkArrivalIdentity(packedFiles(fx, shellVersion.skill_version_id), shellVersion.skill_version_id, WITH_SCRIPT)
      .places,
    3,
  );
  assert.equal(
    checkArrivalIdentity(packedFiles(fx, noneVersion.skill_version_id), noneVersion.skill_version_id, WITHOUT_SCRIPT)
      .places,
    2,
  );
  // a `["none"]` version judged as though it shipped a script is a refusal, not
  // a quiet pass — the two shapes are not interchangeable in either direction
  assert.equal(
    checkArrivalIdentity(packedFiles(fx, noneVersion.skill_version_id), noneVersion.skill_version_id, WITH_SCRIPT).ok,
    false,
  );
  fx.db.close();
});

test("D-6: the two reasons for `unknown` are distinguishable as values, not as prose", () => {
  const marker = arrivalMarker("01K1M83S80EZJBJVYBH8XEK5ZR");
  const pair: ArrivalRecord[] = [
    { role: "call", call_id: "c-1", text: `sh ./${ARRIVAL_SCRIPT_PATH}` },
    { role: "output", call_id: "c-1", text: `skln-arrival-marker: ${marker}` },
  ];
  const markedPair: ArrivalRecord[] = [
    { role: "call", call_id: "c-1", text: `sh ./${ARRIVAL_SCRIPT_PATH} # ${marker}` },
    { role: "output", call_id: "c-1", text: `skln-arrival-marker: ${marker}` },
  ];

  // (a) a version that CAN be demonstrated, with nothing found yet
  const searched = assessArrival(pair, { marker, has_executable_step: true });
  assert.equal(searched.verdict, "unknown");
  assert.equal(searched.reason, "no_paired_record", "records were searched and came up short");

  // (b) a version that can NEVER be demonstrated
  const structural = assessArrival(markedPair, { marker, has_executable_step: false });
  assert.equal(structural.verdict, "unknown");
  assert.equal(structural.reason, "no_executable_step", "there is nothing to run, so nothing can be recorded");

  // the two are different VALUES — a scanner and a dashboard can branch on them
  assert.notEqual(searched.reason, structural.reason);
  assert.equal(new Set([searched.reason, structural.reason]).size, 2);

  // neither is `no`, and neither is empty [I-1], [A-0]
  for (const r of [searched, structural]) {
    assert.notEqual(r.verdict, "no");
    assert.notEqual(r.reason, null);
    assert.notEqual(r.reason, "");
  }

  // `yes` carries no reason at all — the field is null exactly when it holds
  const proven = assessArrival(markedPair, { marker, has_executable_step: true });
  assert.equal(proven.verdict, "yes");
  assert.equal(proven.reason, null);

  // and a `["none"]` version does not become `yes` because some record happened
  // to quote its marker: it ships nothing that could have printed one
  assert.equal(assessArrival(markedPair, { marker, has_executable_step: false }).verdict, "unknown");

  // the predicate a caller uses to fill `has_executable_step` reads the manifest
  assert.equal(shipsArrivalScript({ runtime: { shell: ["none"] } }), false);
  assert.equal(shipsArrivalScript({ runtime: { shell: ["bash", "sh"] } }), true);
  assert.equal(shipsArrivalScript({ runtime: { shell: ["none", "bash"] } }), true, "['none','bash'] HAS bash");
  assert.equal(shipsArrivalScript({}), true, "an unreadable declaration means MORE checking, never less");
});

test("D-6: integrity still covers the SKILL.md marker when there is no script", () => {
  const fx = p2Fixture();
  const out = fx.registry.createFromDir(fx.author, { slug: "none-integrity", source: noShellSource(fx).tar })
    .response;
  const files = packedFiles(fx, out.skill_version_id);
  assert.equal(files.has(ARRIVAL_SCRIPT_PATH), false);

  const declared = JSON.parse(text(files, "skill.json")).integrity as Array<{ path: string; sha256: string }>;
  assert.deepEqual(declared.map((e) => e.path), ["SKILL.md"], "the one shipped file, and the marker is in it");
  assert.deepEqual(computeIntegrity(files), declared);

  const clean = fx.registry.verifyStateless(fx.author, writeTar(files));
  assert.notEqual(clean.verdict, "TAMPERED_CONTENT", "the untouched package is intact");

  const tampered = new Map(files);
  const before = text(files, "SKILL.md");
  const after = before.replace(out.arrival_marker, arrivalMarker("01K1M83S80EZJBJVYBH8XEK5ZZ"));
  assert.notEqual(after, before, "the tamper actually changed SKILL.md");
  tampered.set("SKILL.md", Buffer.from(after, "utf8"));
  assert.equal(
    fx.registry.verifyStateless(fx.author, writeTar(tampered)).verdict,
    "TAMPERED_CONTENT",
    "a swapped marker is caught with two places exactly as with three",
  );
  fx.db.close();
});

// ===========================================================================
// 10. Both adapters, one service.
// ===========================================================================

function restFx(): { fx: P2Fixture; key: string } {
  const fx = p2Fixture();
  const key = mintApiKey(fx.db, fx.author.agent_id, NOW).api_key;
  return { fx, key };
}

test("REST and MCP reach surface 14 and answer identically", () => {
  const { fx, key } = restFx();
  const { tar } = sourceTree(fx);

  const rest = handleRest(fx.registry, {
    method: "POST",
    url: "/v1/skills/from-source",
    headers: { authorization: `Bearer ${key}` },
    body: Buffer.from(JSON.stringify({ slug: "rest-form", source: tar.toString("base64") }), "utf8"),
  });
  assert.equal(rest.status, 201, rest.body);
  const created = JSON.parse(rest.body);
  assert.equal(created.arrival_marker, arrivalMarker(created.skill_version_id));

  // the new-version form, over MCP this time
  const mcp = handleMcpMessage(fx.registry, fx.author, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "skill.create_from_dir",
      arguments: {
        skill_id: created.skill_id,
        source_base64: sourceTree(fx, {
          skill_id: created.skill_id,
          semantic_version: "2.0.0",
        }).tar.toString("base64"),
      },
    },
  });
  assert.equal(mcp.result.isError, false, mcp.result.content[0].text);
  const second = JSON.parse(mcp.result.content[0].text);
  assert.equal(second.skill_id, created.skill_id, "a new version of the same skill");
  assert.equal(second.arrival_marker, arrivalMarker(second.skill_version_id));
  assert.notEqual(second.arrival_marker, created.arrival_marker);

  // an idempotency replay returns the ORIGINAL bytes, header and all
  const idemSource = sourceTree(fx, { skill_id: ulid(NOW) }).tar;
  const body = JSON.stringify({
    slug: "idem-form",
    source: idemSource.toString("base64"),
    idempotency_key: "k-1",
  });
  const one = handleRest(fx.registry, {
    method: "POST",
    url: "/v1/skills/from-source",
    headers: { authorization: `Bearer ${key}` },
    body: Buffer.from(body, "utf8"),
  });
  const two = handleRest(fx.registry, {
    method: "POST",
    url: "/v1/skills/from-source",
    headers: { authorization: `Bearer ${key}` },
    body: Buffer.from(body, "utf8"),
  });
  assert.equal(two.status, one.status);
  assert.equal(two.body, one.body, "byte-identical replay");
  assert.equal(two.headers["Idempotency-Replayed"], "true");
  fx.db.close();
});

// ===========================================================================
// 10. What did NOT change: the local packer and the pre-signed fixtures.
// ===========================================================================

test("skill.create still takes a locally packed, locally signed archive", async () => {
  const { buildPackage } = await import("./p2-helpers.ts");
  const fx = p2Fixture();
  const manifest = makeManifest({ author_agent: fx.author.agent_id, semantic_version: "1.0.0" });
  const { tar } = buildPackage(manifest); // signed with the Appendix F test seed
  const out = fx.registry.createVersion(fx.author, { slug: "still-works", archive: tar }).response;
  assert.equal(out.state, "draft");

  // and it carries NO arrival marker: surface 1 does not pack, so it has no
  // version id to derive one from at the time the bytes are sealed. That is the
  // honest answer, and it is why surface 14 exists.
  const files = packedFiles(fx, out.skill_version_id);
  assert.equal(markersIn(text(files, "SKILL.md")).length, 0);
  assert.ok(!files.has(ARRIVAL_SCRIPT_PATH));
  // its `source_hash` is NULL, so it converges with nothing rather than
  // colliding with the first source that happens to arrive
  const row = fx.db.prepare("SELECT source_hash FROM skill_versions WHERE id=?").get(out.skill_version_id) as {
    source_hash: string | null;
  };
  assert.equal(row.source_hash, null);
  fx.db.close();
});
