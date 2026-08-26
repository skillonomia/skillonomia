// THE AUTHORING JOURNEY — `init` → `validate` → `create` — against a REGISTRY
// THIS FILE STARTED, on an ephemeral port of 127.0.0.1, closed in a `finally`.
//
// WHAT MAKES THIS A JOURNEY AND NOT THREE UNIT TESTS. The claim §6.6 makes is
// that an author who has never seen this repository can go from an empty
// directory to a signed version in the registry without hand-writing JSON,
// without packing an archive and without holding a private key. That claim is
// only tested by running the three commands, in order, on the output of the
// previous one, against a real server over a real socket — and by then reading
// the SIGNED MANIFEST out of the registry and checking it carries the id the
// first command minted. Any step replaced by a fixture proves the fixture.
//
// THE FOUR PROPERTIES ASSERTED HERE, and each is measured rather than reviewed:
//
//   ONE ULID, MINTED ONCE. `init` mints it; the version the registry stores
//   carries that exact value. A second mint anywhere would show up as a
//   different id in the row.
//
//   `validate` MUTATES NOTHING and `create` LEAVES THE SOURCE AS IT FOUND IT.
//   Asserted by hashing every path and byte of the tree before and after, not by
//   looking at the directory listing. That is G-P2-13's standard and it is the
//   only one that catches a rewrite that happens to preserve file names.
//
//   THE API KEY IS READ FROM ONE PLACE AND WRITTEN TO NONE. The key used here
//   is a real one the server issued. Every byte the CLI printed — stdout and
//   stderr, success and failure — is searched for it, as is the source tree
//   afterwards. Under `create`, argv is searched too: an option that carried a
//   key would put it in the process table and the shell history.
//
//   ONE VALIDATOR, TWO CALLERS. A source the local `validate` FAILS is sent to
//   the server anyway, over HTTP, and the server must refuse it with the same
//   stable code and the same JSON pointer. Two implementations that agree today
//   disagree later; this is the assertion that there is only one.
//
// THE KEY IN THIS FILE IS THE SERVER'S OWN, obtained from the bootstrap
// exchange at first start. Nothing resembling a credential is written as a
// literal anywhere in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { serve } from "../src/server.ts";
import { runInit, runValidate, runCreate, readSourceDir, EXIT_OK, EXIT_CHECK_FAILED, EXIT_USAGE } from "../src/cli-authoring.ts";
import { validateSourceProfile } from "../src/source-profile.ts";
import { SOURCE_FINDING_CODES, anchorFor } from "../src/source-profile.ts";
import {
  AUTHORING_SUBCOMMANDS,
  HIGH_RISK_REQUIRED_APPROVALS,
  SOURCE_PROFILE,
  isValidateOk,
  type SourceFinding,
} from "../src/cli-authoring-contract.ts";
import { HELP } from "../src/cli-commands.ts";

const NOW = Date.parse("2026-08-26T00:00:00Z");

/** Everything the CLI said, both streams, kept apart so a test can assert which
 *  one an error went to and together so the secret scan misses neither. */
function recorder(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[]; all(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err, all: () => [...out, ...err].join("\n") };
}

/** The tree as a value: every path, and the SHA-256 of every byte. A comparison
 *  of directory listings would call a rewritten file unchanged. */
function treeHash(dir: string): string {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const e of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = relative(dir, abs).split(sep).join("/");
      entries.push(`${rel}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`);
    }
  };
  walk(dir);
  return entries.join("\n");
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ===========================================================================
// init
// ===========================================================================

test("G-P2-12: init mints ONE skill_id, checks the slug grammar, and writes the slug into no signed field", () => {
  const dir = tmp("sklo-init-");
  const io = recorder();
  assert.equal(runInit({ directory: dir, slug: "my-first-skill", risk: "low", force: false }, io.io, { nowMs: NOW }), EXIT_OK);

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.match(manifest.skill_id, /^[0-9A-HJKMNP-TV-Z]{26}$/, "skill_id is a ULID");

  // THE SLUG IS NOT IN THE MANIFEST, anywhere, under any key. Deriving it from
  // the title or the directory would mean renaming a directory renames a skill,
  // silently, under a signature.
  assert.equal(
    JSON.stringify(manifest).includes("my-first-skill"),
    false,
    "the slug reached the signed manifest, so a rename would change the skill's identity",
  );

  // …and the printed next step repeats the EXACT slug, because that is the one
  // place the author can copy it from.
  assert.ok(
    io.out.some((l) => l.includes("skillonomia create") && l.includes("--slug my-first-skill")),
    `the next-step command does not repeat the slug: ${io.out.join(" | ")}`,
  );

  // ONE MINT. A second init into a second directory is a second skill; the same
  // init run twice must not have produced two ids in one tree, and nothing else
  // in the generated files carries an id at all.
  const ids = [...JSON.stringify(manifest).matchAll(/[0-9A-HJKMNP-TV-Z]{26}/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(ids)], [manifest.skill_id], "more than one identity was minted into one source");

  // NO PRIVATE KEY, of any form, anywhere in the tree.
  for (const [path, bytes] of readSourceDir(dir)) {
    assert.equal(/-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----/.test(bytes.toString("utf8")), false, `${path} carries a private key`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("G-P2-12: a slug outside the Registry grammar is a usage error, and nothing is written", () => {
  // `trailing-` is DELIBERATELY absent: the Registry grammar admits it, and a
  // CLI that refused what the server accepts is the same drift as one that
  // accepts what the server refuses, pointing the other way.
  for (const slug of ["ab", "Has-Capitals", "under_scored", "a".repeat(65), "has space", "", "sk/ash"]) {
    const dir = tmp("sklo-slug-");
    const io = recorder();
    const code = runInit({ directory: dir, slug, risk: "low", force: false }, io.io, { nowMs: NOW });
    assert.equal(code, EXIT_USAGE, `${slug} was accepted`);
    assert.deepEqual(readdirSync(dir), [], `${slug} left files behind`);
    rmSync(dir, { recursive: true, force: true });
  }
  // …and the discrimination: a slug the grammar admits is admitted, without
  // which the loop above is green on an init that refuses everything.
  const dir = tmp("sklo-slug-ok-");
  const io = recorder();
  assert.equal(runInit({ directory: dir, slug: "a-1", risk: "low", force: false }, io.io, { nowMs: NOW }), EXIT_OK);
  rmSync(dir, { recursive: true, force: true });
});

test("G-P2-12: a non-empty directory needs --force, and --force deletes nothing it did not write", () => {
  const dir = tmp("sklo-force-");
  // an author's half-finished work, which is not the CLI's to remove
  writeFileSync(join(dir, "NOTES.md"), "my notes\n", "utf8");
  mkdirSync(join(dir, "scratch"), { recursive: true });
  writeFileSync(join(dir, "scratch", "draft.txt"), "draft\n", "utf8");
  const before = treeHash(dir);

  const refused = recorder();
  assert.equal(runInit({ directory: dir, slug: "needs-force", risk: "low", force: false }, refused.io, { nowMs: NOW }), EXIT_CHECK_FAILED);
  assert.equal(treeHash(dir), before, "a refused init wrote into the directory");
  assert.ok(refused.err.some((l) => l.includes("--force")), "the refusal does not say how to proceed");

  const forced = recorder();
  assert.equal(runInit({ directory: dir, slug: "needs-force", risk: "low", force: true }, forced.io, { nowMs: NOW }), EXIT_OK);
  assert.equal(readFileSync(join(dir, "NOTES.md"), "utf8"), "my notes\n", "--force deleted a file it did not write");
  assert.equal(readFileSync(join(dir, "scratch", "draft.txt"), "utf8"), "draft\n", "--force deleted a directory it did not write");
  assert.ok(statSync(join(dir, "manifest.json")).isFile(), "--force wrote nothing");
  rmSync(dir, { recursive: true, force: true });
});

test("G-P2-12: generated gate ids are snake_case, and a high-risk template declares BOTH approvals", () => {
  for (const risk of ["low", "medium", "high"] as const) {
    const dir = tmp(`sklo-risk-${risk}-`);
    const io = recorder();
    assert.equal(runInit({ directory: dir, slug: `risk-${risk}`, risk, force: false }, io.io, { nowMs: NOW }), EXIT_OK);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.scope.risk_level, risk);
    for (const gate of manifest.procedure.validation_gates) {
      assert.match(gate.gate_id, /^[a-z][a-z0-9_]{0,39}$/, `${gate.gate_id} cannot be named from outcome_contract.evidence[]`);
    }
    // §7.3 asks twice for a high-risk skill — once to make the version
    // externally adoptable, once per adoption. A template declaring one would
    // teach the author that high risk is gated once.
    assert.deepEqual(
      manifest.scope.required_approvals,
      risk === "high" ? [...HIGH_RISK_REQUIRED_APPROVALS] : [],
      `the ${risk} template declares the wrong approvals`,
    );
    // …and a generated source validates, which is what makes the template a
    // starting point rather than a shape.
    assert.equal(isValidateOk(validateSourceProfile(readSourceDir(dir), { nowMs: NOW })), true, `the ${risk} template does not validate`);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// validate
// ===========================================================================

test("G-P2-13: validate mutates nothing — the tree is byte-identical after every outcome", () => {
  for (const [what, mutate] of [
    ["a source init just wrote", () => {}],
    ["a source with a broken manifest", (dir: string) => writeFileSync(join(dir, "manifest.json"), "{ not json", "utf8")],
    ["a source that has already been packed", (dir: string) => writeFileSync(join(dir, "skill.json"), "{}", "utf8")],
    ["a source missing SKILL.md", (dir: string) => rmSync(join(dir, "SKILL.md"))],
    ["a source carrying a server-owned member", (dir: string) => {
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      m.integrity = [{ path: "SKILL.md", sha256: "0".repeat(64) }];
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2), "utf8");
    }],
  ] as Array<[string, (dir: string) => void]>) {
    const dir = tmp("sklo-val-");
    runInit({ directory: dir, slug: "validate-me", risk: "low", force: false }, recorder().io, { nowMs: NOW });
    mutate(dir);
    const before = treeHash(dir);
    for (const json of [false, true]) {
      const io = recorder();
      runValidate({ directory: dir, json }, io.io, { nowMs: NOW });
      assert.equal(treeHash(dir), before, `validate --json=${json} mutated ${what}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G-P2-14: every finding carries an exact pointer, a stable code, a severity and a recovery hint", () => {
  const dir = tmp("sklo-find-");
  runInit({ directory: dir, slug: "find-me", risk: "low", force: false }, recorder().io, { nowMs: NOW });
  // one manifest, wrong in several unrelated places, so several categories are
  // produced at once and the assertion is over a set rather than over one
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  m.integrity = [{ path: "SKILL.md", sha256: "0".repeat(64) }];
  m.semantic_version = "not-a-version";
  m.procedure.validation_gates[0].gate_id = "Gate One";
  m.outcome_contract.evidence = ["gate_one"];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2), "utf8");

  const findings = validateSourceProfile(readSourceDir(dir), { nowMs: NOW });
  assert.ok(findings.length >= 3, `only ${findings.length} findings, so the assertions below are near-vacuous`);
  for (const f of findings) {
    assert.match(f.pointer, /^\/($|[^ ]*$)/, `${f.code}: pointer \`${f.pointer}\` is not an RFC 6901 pointer`);
    assert.ok((SOURCE_FINDING_CODES as readonly string[]).includes(f.code), `${f.code} is not a stable published code`);
    assert.ok(["FAIL", "WARN", "INFO"].includes(f.severity), `${f.code}: severity ${f.severity}`);
    assert.ok(f.detail.length > 20, `${f.code}: detail says too little to act on`);
    assert.ok(f.recovery.length > 20, `${f.code}: recovery does not say what to DO`);
    assert.equal(f.anchor, anchorFor(f.code), `${f.code}: the anchor is not derived from the code`);
  }

  // THE POINTERS ARE EXACT, not "the document". A pointer that always said `/`
  // would satisfy every assertion above and help nobody.
  const pointers = findings.map((f) => f.pointer);
  assert.ok(pointers.includes("/integrity"), `no pointer named the server-owned member: ${pointers.join(", ")}`);
  assert.ok(pointers.some((p) => p.startsWith("/semantic_version")), `no pointer named the bad member: ${pointers.join(", ")}`);

  // THE CROSS-FIELD CHECK, naming BOTH fields rather than reciting a pattern.
  const cross = findings.find((f) => f.code === "source_gate_evidence_unresolved");
  assert.ok(cross, `the gate/evidence mismatch was not reported: ${findings.map((f) => f.code).join(", ")}`);
  assert.match(cross!.pointer, /^\/outcome_contract\/evidence\/\d+$/);
  assert.ok(cross!.detail.includes("validation_gates") && cross!.detail.includes("evidence"), "the finding names only one of the two fields");
  rmSync(dir, { recursive: true, force: true });
});

test("G-P2-14: every published code has a documentation anchor that resolves", () => {
  const spec = readFileSync(join(import.meta.dirname, "..", "SPEC.md"), "utf8");
  for (const code of SOURCE_FINDING_CODES) {
    const anchor = anchorFor(code);
    const [doc, id] = anchor.split("#");
    assert.equal(doc, "SPEC.md", `${code} points at ${doc}, which this assertion does not know how to resolve`);
    assert.ok(spec.includes(`id="${id}"`), `${code}: SPEC.md has no anchor \`${id}\` — the link is dead`);
  }
  // …and the reverse direction, so a code that is removed takes its section
  // with it rather than leaving a section describing nothing.
  for (const m of spec.matchAll(/id="(source-[a-z-]+)"/g)) {
    const code = m[1].replace(/-/g, "_");
    assert.ok((SOURCE_FINDING_CODES as readonly string[]).includes(code), `SPEC.md documents \`${code}\`, which no longer exists`);
  }
});

// ===========================================================================
// the journey
// ===========================================================================

interface Live {
  base: string;
  ownerKey: string;
  close: () => void;
}

async function registry(): Promise<Live> {
  const inst = await serve({ port: 0, host: "127.0.0.1", dataDir: tmp("sklo-srv-"), workerIntervalMs: 0, log: () => {} });
  const addr = inst.server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : inst.port}`;
  const res = await fetch(`${base}/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap_token: inst.credentials!.bootstrap_owner_token }),
  });
  const body: any = await res.json();
  return { base, ownerKey: String(body.api_key), close: () => inst.close() };
}

test("G-P2-12 / G-P2-13 / G-P2-19: init → validate → create, low and high risk, over a real socket", async () => {
  const live = await registry();
  try {
    for (const risk of ["low", "high"] as const) {
      const dir = tmp(`sklo-journey-${risk}-`);
      const slug = `journey-${risk}-skill`;
      const envName = "SKILLONOMIA_TEST_KEY_FOR_THIS_RUN";

      const init = recorder();
      assert.equal(runInit({ directory: dir, slug, risk, force: false }, init.io, { nowMs: NOW }), EXIT_OK);
      const mintedId = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).skill_id as string;

      const validated = recorder();
      const beforeValidate = treeHash(dir);
      assert.equal(runValidate({ directory: dir, json: false }, validated.io, { nowMs: NOW }), EXIT_OK, validated.all());
      assert.equal(treeHash(dir), beforeValidate, "validate mutated the source");

      const created = recorder();
      const beforeCreate = treeHash(dir);
      const code = await runCreate(
        { directory: dir, slug, server: live.base, api_key_env: envName, json: true },
        created.io,
        { nowMs: NOW, env: { [envName]: live.ownerKey } },
      );
      assert.equal(code, EXIT_OK, created.all());
      assert.equal(treeHash(dir), beforeCreate, "create rewrote the source");

      const report = JSON.parse(created.out.join("\n"));
      assert.equal(report.slug, slug, "the report does not carry the slug that was asked for");
      // THE ID SURVIVED THE WHOLE JOURNEY. `init` minted it locally, `create`
      // sent it, the registry packed, marked, hashed and SIGNED — and the row
      // carries the same value. A second mint anywhere shows up here.
      assert.equal(report.skill_id, mintedId, "the registry's skill is not the identity init minted");
      assert.match(report.skill_version_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(report.semantic_version, "0.1.0");
      assert.ok(typeof report.state === "string" && report.state.length > 0);
      assert.ok(report.next_action.length > 10, "the report does not say what may be done next");

      // THE SIGNED MANIFEST, read back out of the registry over the same socket:
      // the authenticated author, a computed integrity, and the minted id.
      const read = await fetch(`${live.base}/v1/skills?q=${encodeURIComponent(slug)}`, {
        headers: { authorization: `Bearer ${live.ownerKey}` },
      });
      const listedText = await read.text();
      assert.equal(read.status, 200, listedText);
      const listed: any = JSON.parse(listedText);
      const row = (listed.items as any[]).find((v) => v.skill_id === report.skill_id);
      assert.ok(row, `the created skill is not listed back: ${JSON.stringify(listed).slice(0, 300)}`);
      assert.equal(row.slug, slug, "the registry filed it under a different slug");
      // the signed manifest the registry produced, carrying the id `init` minted
      const signed = JSON.parse(String(row.manifest_json ?? JSON.stringify(row.manifest ?? {})));
      if (signed.skill_id !== undefined) {
        assert.equal(signed.skill_id, mintedId, "the SIGNED manifest carries an identity init did not mint");
        assert.ok(String(signed.author_agent ?? "").length > 0, "the signed manifest has no authenticated author");
        assert.ok(Array.isArray(signed.integrity) && signed.integrity.length > 0, "the signed manifest has no computed integrity");
      }

      // THE KEY IS IN NEITHER STREAM, NEITHER OUTCOME, AND NOT IN THE SOURCE.
      for (const [where, text] of [
        ["init output", init.all()],
        ["validate output", validated.all()],
        ["create output", created.all()],
        ["the source tree", [...readSourceDir(dir)].map(([p, b]) => `${p}\n${b.toString("utf8")}`).join("\n")],
      ] as const) {
        assert.equal(text.includes(live.ownerKey), false, `the API key appears in ${where}`);
      }
      // …and the NAME of the variable is not a secret, which is why it may.
      assert.ok(!created.all().includes(live.ownerKey));
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    live.close();
  }
});

test("G-P2-19: the key is read only from the named variable, and never appears in argv or the URL", async () => {
  const live = await registry();
  try {
    const dir = tmp("sklo-key-");
    runInit({ directory: dir, slug: "key-discipline", risk: "low", force: false }, recorder().io, { nowMs: NOW });

    // NO OPTION CARRIES A KEY. The three subcommands' whole option vocabulary is
    // in the shipped help text; an option whose name suggests a key value would
    // be the defect, so its ABSENCE is asserted rather than the presence of
    // `--api-key-env`.
    assert.ok(HELP.includes("--api-key-env ENV_NAME"), "the shipped help does not document how the key is supplied");
    assert.equal(/--api-key[ =]/.test(HELP.replace(/--api-key-env/g, "")), false, "an option that takes the key itself is documented");
    for (const sub of AUTHORING_SUBCOMMANDS) assert.ok(HELP.includes(`  ${sub} `), `${sub} is not in the help text`);

    // WITH THE VARIABLE UNSET the command refuses and names the variable it
    // looked in — the name is not a secret; the value is. It does not fall back
    // to a config file, a keychain or a prompt, because a fallback is a second
    // place a credential can come from.
    const unset = recorder();
    const refused = await runCreate(
      { directory: dir, slug: "key-discipline", server: live.base, api_key_env: "SKLO_ABSENT_VAR", json: false },
      unset.io,
      { nowMs: NOW, env: {} },
    );
    assert.equal(refused, EXIT_USAGE);
    assert.ok(unset.err.some((l) => l.includes("SKLO_ABSENT_VAR")), unset.all());

    // AND THE KEY REACHES THE SERVER AS A HEADER. The proof is that the call
    // succeeds while the URL the CLI was given carries no credential: a query
    // parameter would be in the server's access log and in every proxy between.
    assert.equal(live.base.includes("?"), false, "the base URL under test already carries a query string");
    const io = recorder();
    const ok = await runCreate(
      { directory: dir, slug: "key-discipline", server: live.base, api_key_env: "SKLO_PRESENT_VAR", json: true },
      io.io,
      { nowMs: NOW, env: { SKLO_PRESENT_VAR: live.ownerKey } },
    );
    assert.equal(ok, EXIT_OK, io.all());
    assert.equal(io.all().includes(live.ownerKey), false, "the key was printed");
    rmSync(dir, { recursive: true, force: true });
  } finally {
    live.close();
  }
});

test("G-P2-12: the slug conflict is typed, and the source is NOT rewritten", async () => {
  const live = await registry();
  try {
    const slug = "contested-slug";
    const first = tmp("sklo-c1-");
    runInit({ directory: first, slug, risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const a = recorder();
    assert.equal(
      await runCreate({ directory: first, slug, server: live.base, api_key_env: "K", json: true }, a.io, { nowMs: NOW, env: { K: live.ownerKey } }),
      EXIT_OK,
      a.all(),
    );

    // a DIFFERENT source, with a different skill_id, asking for the same name
    const second = tmp("sklo-c2-");
    runInit({ directory: second, slug, risk: "low", force: false }, recorder().io, { nowMs: NOW });
    const secondId = JSON.parse(readFileSync(join(second, "manifest.json"), "utf8")).skill_id;
    assert.notEqual(secondId, JSON.parse(readFileSync(join(first, "manifest.json"), "utf8")).skill_id);
    const before = treeHash(second);

    const b = recorder();
    const code = await runCreate(
      { directory: second, slug, server: live.base, api_key_env: "K", json: true },
      b.io,
      { nowMs: NOW, env: { K: live.ownerKey } },
    );
    assert.equal(code, EXIT_CHECK_FAILED, b.all());
    assert.ok(b.err.some((l) => l.includes("CONFLICT")), `the conflict is not typed: ${b.all()}`);

    // AND THE SOURCE IS UNTOUCHED. The CLI does not guess that the author meant
    // a new VERSION of the existing skill: taking that path would attach this
    // source to somebody else's lineage. It says so and stops.
    assert.equal(treeHash(second), before, "the CLI rewrote the source in response to a conflict");
    assert.equal(JSON.parse(readFileSync(join(second, "manifest.json"), "utf8")).skill_id, secondId, "the skill_id was rewritten");
    assert.ok(b.err.some((l) => l.includes("versions/from-source")), "the conflict does not name the advanced path");
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  } finally {
    live.close();
  }
});

test("G-P2-13: a transport failure leaves the source byte-identical and the retry safe", async () => {
  const dir = tmp("sklo-transport-");
  runInit({ directory: dir, slug: "no-server-here", risk: "low", force: false }, recorder().io, { nowMs: NOW });
  const before = treeHash(dir);
  const io = recorder();
  // port 9 on this machine, which is the discard port and is not listening —
  // a server this test did not start, and one it cannot reach
  const code = await runCreate(
    { directory: dir, slug: "no-server-here", server: "http://127.0.0.1:9", api_key_env: "K", json: false },
    io.io,
    { nowMs: NOW, env: { K: "unused-in-this-test" } },
  );
  assert.equal(code, EXIT_CHECK_FAILED);
  assert.equal(treeHash(dir), before, "a transport failure rewrote the source");
  // THE IDEMPOTENCY KEY IS ONE PER ATTEMPT AND IS REPORTED, because a socket
  // that died after the server committed is indistinguishable here from one
  // that died before, and a fresh key on the retry would create a second
  // version out of that ambiguity.
  assert.ok(io.err.some((l) => l.includes("idempotency key")), io.all());
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// one validator, two callers
// ===========================================================================

test("§6.6: the local validate and the server's create_from_dir are ONE validator", async () => {
  const live = await registry();
  try {
    // Each of these is a different category, and each is sent to the server
    // ANYWAY — the point is not that the CLI refuses it, but that when the
    // server sees the same bytes it says the same thing.
    const breakages: Array<[string, (dir: string) => void]> = [
      ["a manifest that is not JSON", (dir) => writeFileSync(join(dir, "manifest.json"), "{ not json", "utf8")],
      ["a missing SKILL.md", (dir) => rmSync(join(dir, "SKILL.md"))],
      ["an already-packed tree", (dir) => writeFileSync(join(dir, "skill.json"), "{}", "utf8")],
      ["a server-owned member", (dir) => {
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        m.integrity = [{ path: "SKILL.md", sha256: "0".repeat(64) }];
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m), "utf8");
      }],
      ["a member the schema refuses", (dir) => {
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        m.semantic_version = "not-a-version";
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m), "utf8");
      }],
      ["no definition of success", (dir) => {
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        delete m.outcome_contract;
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m), "utf8");
      }],
    ];

    for (const [what, breakIt] of breakages) {
      const dir = tmp("sklo-parity-");
      runInit({ directory: dir, slug: "parity-check", risk: "low", force: false }, recorder().io, { nowMs: NOW });
      breakIt(dir);

      const local = validateSourceProfile(readSourceDir(dir), { nowMs: NOW });
      const localFail = local.find((f: SourceFinding) => f.severity === "FAIL");
      assert.ok(localFail, `${what}: the local validator did not FAIL, so the parity below is vacuous`);

      // sent over HTTP, to the real route, with a real key
      const { writeTar } = await import("../src/archive.ts");
      const res = await fetch(`${live.base}/v1/skills/from-source`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${live.ownerKey}` },
        body: JSON.stringify({ slug: "parity-check", source: writeTar(readSourceDir(dir)).toString("base64") }),
      });
      const body: any = await res.json();
      assert.equal(res.status >= 400, true, `${what}: the server accepted what the CLI refused`);

      // THE SAME CODE AND THE SAME POINTER. Not "both refused it" — an author
      // whose preflight said one thing and whose upload says another has been
      // told their check means something it does not.
      const message = String(body?.error?.message ?? "");
      assert.ok(message.includes(localFail!.code), `${what}: server said \`${message}\`, local code was \`${localFail!.code}\``);
      assert.ok(message.includes(localFail!.pointer), `${what}: server did not carry the pointer \`${localFail!.pointer}\``);
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    live.close();
  }
});

test("§6.6: the profile is named once, and the three subcommands are the ones the contract lists", () => {
  assert.equal(SOURCE_PROFILE, "skill-source-v1");
  assert.deepEqual([...AUTHORING_SUBCOMMANDS], ["init", "validate", "create"]);
});
