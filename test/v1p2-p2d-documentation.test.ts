// G-P2-15 — THE PUBLIC REFERENCE, AGAINST THE CODE IT DOCUMENTS.
//
// WHY "PRESENT" IS THE WRONG BAR. A documentation example is COPIED. A reader
// does not read it and reason about it; they paste it and send it. So an example
// that does not parse, or that names a member the shipped schema refuses, is
// worse than a missing one — it teaches a form the registry will reject and it
// does so with the authority of the published reference. The gate is therefore
// not "the section exists" but "the payload validates against the schema that
// ships beside it", and the validation happens here, on every run.
//
// HOW AN EXAMPLE DECLARES WHAT IT IS. Each fenced block in `docs/REFERENCE.md`
// is preceded by an HTML comment naming an id and a check:
//
//     <!-- skln:example id=package-minimal check=schema:skill-package-v1 -->
//
// The comment is invisible to a reader and blanked by `test/absolutes.ts`'s
// prose reader, so it costs the document nothing. There are four kinds of
// check, and a block whose kind this file does not know is a FAILURE rather
// than a skip — an example nobody checks is exactly the thing this gate exists
// to prevent.
//
// AND THE TABLES ARE DERIVED, NOT TYPED. The required-member column, the role
// vocabulary, the approval kinds, the lifecycle states, the webhook environment
// variables, the REST/MCP pairs and the revocation consequences are each read
// out of the code and compared with what the document prints. A constant that
// changes without the document changing fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { APPROVAL_KINDS } from "../src/console-v2.ts";
import { REVOCATION_CONSEQUENCES } from "../src/console-surfaces.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { SOURCE_FINDING_CODES, anchorFor } from "../src/source-profile.ts";
import { restRoutes, subcommands, environmentNames } from "./absolutes.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DOC = "docs/REFERENCE.md";
const text = readFileSync(join(ROOT, DOC), "utf8");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

// ---------------------------------------------------------------- examples

interface Example {
  id: string;
  check: string;
  lang: string;
  body: string;
}

/** Every declared example of the document, with the block it introduces. */
function examples(): Example[] {
  const out: Example[] = [];
  const re = /<!--\s*skln:example\s+id=([a-z0-9-]+)\s+check=([^>]+?)\s*-->\s*\n```([a-z]*)\n([\s\S]*?)\n```/g;
  for (const m of text.matchAll(re)) out.push({ id: m[1]!, check: m[2]!, lang: m[3]!, body: m[4]! });
  return out;
}

const ajv = new (Ajv2020 as unknown as new (o: unknown) => any)({ allErrors: true, strict: false });
(addFormats as unknown as (a: unknown) => void)(ajv);
const compiled = new Map<string, (v: unknown) => boolean>();
function validator(name: string): (v: unknown) => boolean {
  let fn = compiled.get(name);
  if (fn === undefined) {
    const path = `schema/${name}.schema.json`;
    assert.ok(existsSync(join(ROOT, path)), `${DOC} names the schema \`${path}\`, which this repository does not ship`);
    fn = ajv.compile(JSON.parse(read(path))) as (v: unknown) => boolean;
    compiled.set(name, fn);
  }
  return fn;
}

test("G-P2-15: the document declares examples at all, and this guard can read them", () => {
  const found = examples();
  assert.ok(found.length >= 15, `only ${found.length} declared examples were parsed out of ${DOC} — the marker syntax moved`);
  const ids = found.map((e) => e.id);
  assert.deepEqual([...new Set(ids)], ids, "two examples share an id");
  // A MARKER WITH NO BLOCK is the silent-staleness shape: it would simply not
  // be parsed, and the count above would quietly fall.
  const markers = [...text.matchAll(/<!--\s*skln:example\b/g)].length;
  assert.equal(markers, found.length, `${markers} example markers but ${found.length} blocks — a marker introduces no fenced block`);
  console.log(`[G-P2-15] ${found.length} declared examples in ${DOC}`);
});

test("G-P2-15: every JSON example parses, and none is a fragment", () => {
  for (const e of examples()) {
    if (e.lang !== "json") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.body);
    } catch (err) {
      assert.fail(`${e.id}: the example is not JSON (${(err as Error).message}). A reader pastes this.`);
    }
    assert.ok(parsed !== null && typeof parsed === "object", `${e.id}: the example is not an object`);
    assert.ok(Object.keys(parsed as object).length > 0, `${e.id}: the example is empty`);
  }
});

test("G-P2-15: every schema-governed example VALIDATES against the shipped schema", () => {
  let checked = 0;
  for (const e of examples()) {
    const m = /^schema:([a-z0-9-]+)$/.exec(e.check);
    if (m === null) continue;
    const validate = validator(m[1]!);
    const ok = validate(JSON.parse(e.body));
    assert.ok(
      ok,
      `${e.id} does not validate against schema/${m[1]}.schema.json: ${JSON.stringify((validate as any).errors)?.slice(0, 500)}`,
    );
    checked += 1;
  }
  assert.ok(checked >= 7, `only ${checked} examples were validated against a shipped schema`);
  console.log(`[G-P2-15] ${checked} examples validated against a shipped schema`);
});

test("G-P2-15: the schema-validation is DISCRIMINATING — a broken example is caught", () => {
  // A validator that accepted anything would make the test above vacuous. So a
  // known-bad payload is put through the same path and has to be refused.
  const bad = [
    ["skill-package-v1", { skill_id: "not-a-ulid" }],
    ["evidence-v1", { gate_results: [] }],
    ["failure-report-v1", { category: "invented", summary: "long enough to pass the length bound" }],
    ["environment-descriptor-v1", { runtime: { id: "node", version: "22" }, model: { id: "m", version: "1" }, tools: [], os: "plan9", shell: "bash", sandbox_capable: true }],
  ] as const;
  for (const [name, payload] of bad) {
    assert.equal(validator(name)(payload), false, `schema/${name}.schema.json accepted a payload it should refuse`);
  }
});

test("G-P2-15: every route an example names is served, and every JSON body parses", () => {
  const routes = restRoutes();
  const served = (method: string, path: string): boolean =>
    [...routes].some((r) => {
      const [m, p] = r.split(" ") as [string, string];
      return m === method && (p === path || p.startsWith(`${path}/`));
    });
  let checked = 0;
  for (const e of examples()) {
    const m = /^route:([A-Z]+)\s+(\/\S+)$/.exec(e.check);
    if (m === null) continue;
    const path = m[2]!.replace(/\{[^}]+\}/g, "*");
    assert.ok(served(m[1]!, path), `${e.id} is documented on \`${m[1]} ${m[2]}\`, which src/http.ts does not serve`);
    JSON.parse(e.body);
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} examples were resolved against a served route`);
  console.log(`[G-P2-15] ${checked} example bodies posted at routes src/http.ts serves`);
});

test("G-P2-15: the example finding is the shape src/source-profile.ts produces", () => {
  const e = examples().find((x) => x.check === "derived:source-finding");
  assert.ok(e, "the document shows no example finding");
  const f = JSON.parse(e!.body) as Record<string, string>;
  assert.deepEqual(Object.keys(f).sort(), ["anchor", "code", "detail", "pointer", "recovery", "severity"]);
  assert.ok((SOURCE_FINDING_CODES as readonly string[]).includes(f.code!), `${f.code} is not a code the profile produces`);
  assert.equal(f.anchor, anchorFor(f.code!), "the example finding's anchor is not the one anchorFor derives");
  assert.match(f.pointer!, /^\//, "the example finding's pointer is not an RFC 6901 pointer");
  assert.ok(["FAIL", "WARN", "INFO"].includes(f.severity!));
});

test("G-P2-15: the CLI journey is the subcommands this build dispatches, run for real", () => {
  const e = examples().find((x) => x.check === "cli");
  assert.ok(e, "the document shows no CLI journey");
  const invoked = [...e!.body.matchAll(/^\$ skillonomia ([a-z-]+)/gm)].map((m) => m[1]!);
  assert.deepEqual(invoked, ["init", "validate", "create"], "the journey is not init → validate → create");
  const known = subcommands();
  for (const sub of invoked) assert.ok(known.includes(sub), `\`skillonomia ${sub}\` is not dispatched by src/cli-commands.ts`);

  // AND THE FIRST TWO ARE ACTUALLY RUN. `create` needs a server and an API key
  // and is exercised end to end by test/v1p2-p2-authoring-cli.test.ts; what is
  // proved here is that the two local steps the document prints do what it says
  // they do, with the exact flags it prints.
  const dir = mkdtempSync(join(tmpdir(), "skln-doc-journey-"));
  try {
    const target = join(dir, "my-skill");
    const cli = (...argv: string[]): string =>
      execFileSync("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src/cli.ts"), ...argv], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "" },
      });
    const initOut = cli("init", target, "--slug", "my-skill", "--risk", "low");
    assert.ok(existsSync(join(target, "manifest.json")), "`skillonomia init` wrote no manifest.json");
    assert.ok(existsSync(join(target, "SKILL.md")), "`skillonomia init` wrote no SKILL.md");
    assert.match(initOut, /no private key/i, "`skillonomia init` no longer states that it creates no private key");

    const before = readdirSync(target).sort();
    const validateOut = cli("validate", target);
    assert.deepEqual(readdirSync(target).sort(), before, "`skillonomia validate` changed the source directory");
    assert.ok(validateOut.length > 0, "`skillonomia validate` printed nothing");
    console.log(`[G-P2-15] the documented journey ran: init → validate on a clean directory`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- the derived tables

test("G-P2-15: the schema table names the six shipped schemas and their real required members", () => {
  const shipped = readdirSync(join(ROOT, "schema")).filter((f) => f.endsWith(".schema.json")).sort();
  assert.ok(shipped.length > 0, "no shipped schema was found — this guard is reading the wrong directory");
  for (const file of shipped) {
    const rel = `schema/${file}`;
    assert.ok(text.includes(`\`${rel}\``), `${DOC} does not document \`${rel}\``);
    const required: string[] = JSON.parse(read(rel)).required ?? [];
    // The row is the line that names the file; its required column has to name
    // every member the schema requires, and no member it does not.
    const row = text.split("\n").find((l) => l.includes(`\`${rel}\``) && l.startsWith("|"));
    assert.ok(row, `${rel} is named but not in the schema table`);
    const printed = [...row!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).filter((t) => t !== rel);
    for (const member of required) {
      assert.ok(printed.includes(member), `the row for ${rel} does not name its required member \`${member}\``);
    }
    for (const member of printed) {
      assert.ok(required.includes(member), `the row for ${rel} names \`${member}\`, which the schema does not require`);
    }
  }
  console.log(`[G-P2-15] ${shipped.length} shipped schemas documented with their own required-member lists`);
});

test("G-P2-15: the role/kind matrix is the vocabulary the code defines", () => {
  const roles = [...read("src/auth.ts").matchAll(/export type Role\s*=\s*([^;]+);/g)]
    .flatMap((m) => [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((r) => r[1]!));
  assert.ok(roles.length >= 4, "the Role union was not parsed out of src/auth.ts — this guard is reading it wrong");
  const table = text.slice(text.indexOf("## Role and type matrix"), text.indexOf("## Lifecycle"));
  for (const role of roles) assert.ok(table.includes(`| ${role} |`) || table.includes(`\`${role}\``), `the matrix omits the role \`${role}\``);
  for (const kind of APPROVAL_KINDS) assert.ok(table.includes(`\`${kind}\``), `the matrix omits the approval kind \`${kind}\``);
  // …and it invents none.
  for (const m of table.matchAll(/^\| `([a-z_]+)` \|/gm)) {
    assert.ok((APPROVAL_KINDS as readonly string[]).includes(m[1]!), `the matrix has a row for \`${m[1]}\`, which is not an approval kind`);
  }
  const rows = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].length;
  assert.equal(rows, APPROVAL_KINDS.length, `the matrix has ${rows} kind rows and the code defines ${APPROVAL_KINDS.length}`);
});

test("G-P2-15: the lifecycle section names the states src/transitions.ts defines", () => {
  const states = [...read("src/transitions.ts").matchAll(/export type VersionState\s*=([\s\S]*?);/g)]
    .flatMap((m) => [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((s) => s[1]!));
  assert.ok(states.length >= 8, "the VersionState union was not parsed out of src/transitions.ts");
  const section = text.slice(text.indexOf("## Lifecycle"), text.indexOf("## Webhooks"));
  for (const state of states) assert.ok(section.includes(`\`${state}\``), `the lifecycle section omits the state \`${state}\``);
  for (const word of ["deprecate", "supersede", "revoke"]) {
    assert.ok(section.includes(word), `the lifecycle section does not cover \`${word}\``);
  }
  assert.ok(section.includes("revoke-with-successor"), "the lifecycle section does not cover revoke-with-successor");
});

test("G-P2-15: the webhook environment variables are names this tree reads", () => {
  const names = environmentNames();
  const section = text.slice(text.indexOf("## Webhooks"), text.indexOf("## The revocation boundary"));
  const printed = [...new Set([...section.matchAll(/`(SKILLONOMIA_[A-Z0-9_]+)`/g)].map((m) => m[1]!))];
  assert.ok(printed.length >= 4, `the webhook section documents ${printed.length} environment variables`);
  for (const name of printed) assert.ok(names.has(name), `\`${name}\` is documented and nothing in this tree reads it`);
  // the four the transport reads must each be documented, so a flag cannot be
  // added to the transport and left undocumented.
  const transport = new Set([...read("src/transport.ts").matchAll(/SKILLONOMIA_WEBHOOK[A-Z0-9_]*/g)].map((m) => m[0]));
  for (const name of transport) assert.ok(printed.includes(name), `src/transport.ts reads \`${name}\`, which ${DOC} does not document`);
  for (const word of ["registration", "retr", "dead letter", "test"]) {
    assert.ok(section.toLowerCase().includes(word), `the webhook section does not cover ${word}`);
  }
});

test("G-P2-15: the no-DRM boundary quotes the consequences the Console renders", () => {
  const section = text.slice(text.indexOf("## The revocation boundary"), text.indexOf("## CLI authoring journey"));
  for (const c of REVOCATION_CONSEQUENCES) {
    assert.ok(section.includes(c.text), `the revocation boundary does not carry the \`${c.code}\` consequence verbatim`);
  }
  console.log(`[G-P2-15] ${REVOCATION_CONSEQUENCES.length} revocation consequences quoted from src/console-surfaces.ts`);
});

test("G-P2-15: every REST/MCP pair resolves on both adapters", () => {
  const section = text.slice(text.indexOf("## REST and MCP equivalents"), text.indexOf("## Validation error categories"));
  const routes = restRoutes();
  const tools = new Set<string>(MCP_TOOLS.map((t) => String(t.name)));
  const rows = [...section.matchAll(/^\|\s*[^|]+\|\s*`([A-Z]+) (\/[^`]+)`\s*\|\s*`([a-z0-9_.]+)`\s*\|/gm)];
  assert.ok(rows.length >= 12, `only ${rows.length} REST/MCP pairs were parsed — the table shape moved`);
  for (const r of rows) {
    const path = r[2]!.replace(/\{[^}]+\}/g, "*");
    const served = [...routes].some((x) => {
      const [m, p] = x.split(" ") as [string, string];
      return m === r[1] && (p === path || p.startsWith(`${path}/`));
    });
    assert.ok(served, `the equivalence table names \`${r[1]} ${r[2]}\`, which src/http.ts does not serve`);
    assert.ok(tools.has(r[3]!), `the equivalence table names \`${r[3]}\`, which the MCP adapter does not advertise`);
  }
  console.log(`[G-P2-15] ${rows.length} REST/MCP pairs resolved on both adapters`);
});

// ------------------------------------------------------------- the anchors

test("G-P2-15: every validation error category has an anchor, walked in both directions", () => {
  const spec = read("SPEC.md");
  const section = text.slice(text.indexOf("## Validation error categories"));
  const printed = [...new Set([...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]!))];

  // code → row → anchor → SPEC.md
  for (const code of SOURCE_FINDING_CODES) {
    assert.ok(printed.includes(code), `${DOC} documents no anchor for the error category \`${code}\``);
    const [doc, id] = anchorFor(code).split("#") as [string, string];
    assert.equal(doc, "SPEC.md");
    assert.ok(spec.includes(`id="${id}"`), `${code}: SPEC.md carries no anchor \`${id}\` — the published link is dead`);
    assert.ok(section.includes(`(../SPEC.md#${id})`), `${code}: the row does not link to \`../SPEC.md#${id}\``);
  }

  // …and back: a row here for a category the profile no longer produces is an
  // ORPHAN, and an orphan sends a reader to a section about nothing.
  for (const code of printed) {
    assert.ok((SOURCE_FINDING_CODES as readonly string[]).includes(code), `${DOC} documents \`${code}\`, which src/source-profile.ts no longer produces`);
  }
  assert.equal(printed.length, SOURCE_FINDING_CODES.length);
  console.log(`[G-P2-15] ${printed.length} error categories, each with a resolving SPEC.md anchor, walked both ways`);
});

test("G-P2-15: no dead internal link", () => {
  const headings = new Set(
    [...text.matchAll(/^#{2,}\s+(.+)$/gm)].map((m) =>
      m[1]!.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-"),
    ),
  );
  assert.ok(headings.size >= 10, `only ${headings.size} headings were derived from ${DOC} — this guard is reading it wrong`);
  const dead: string[] = [];
  let checked = 0;
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!;
    if (/^https?:/.test(target)) continue;
    checked += 1;
    const [file, fragment] = target.split("#") as [string, string | undefined];
    if (file === "") {
      if (!headings.has(fragment!)) dead.push(`${target} — no heading of ${DOC} has that anchor`);
      continue;
    }
    const path = join(ROOT, "docs", file);
    if (!existsSync(path)) {
      dead.push(`${target} — no such file (looked at docs/${file})`);
      continue;
    }
    if (fragment !== undefined && !readFileSync(path, "utf8").includes(`id="${fragment}"`)) {
      dead.push(`${target} — ${file} carries no anchor \`${fragment}\``);
    }
  }
  assert.ok(checked >= 15, `only ${checked} internal links were walked`);
  assert.deepEqual(dead, [], `${DOC} has dead internal links:\n  ${dead.join("\n  ")}`);

  // AND THE OTHER DIRECTION: a heading nothing links to is an orphan section.
  const linked = new Set([...text.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]!));
  // The contents list is the linker; it is not a section anything links TO.
  const orphans = [...headings].filter((h) => h !== "contents" && !linked.has(h));
  assert.deepEqual(orphans, [], `${DOC} has sections the contents does not reach: ${orphans.join(", ")}`);
  console.log(`[G-P2-15] ${checked} internal links walked, ${headings.size} headings, ${linked.size} of them linked, 0 orphans`);
});

test("G-P2-15: the reference covers the ten published subjects", () => {
  // The ten subjects the v1.1 public-documentation contract enumerates, each
  // named by the heading that answers it. A subject with no heading fails.
  const REQUIRED: ReadonlyArray<[string, string]> = [
    ["schema reference for the shipped schemas", "## Schema reference"],
    ["minimal and full valid payloads", "## Package payloads"],
    ["review request and verdict", "## Review request and verdict"],
    ["high-risk adoption and publish approval", "## Approval payloads"],
    ["role/type matrix", "## Role and type matrix"],
    ["lifecycle including revoke-with-successor", "## Lifecycle"],
    ["webhook registration, test, retry, dead letters and env flags", "## Webhooks"],
    ["the no-DRM/revocation boundary", "## The revocation boundary"],
    ["the CLI authoring journey", "## CLI authoring journey"],
    ["REST and MCP equivalents", "## REST and MCP equivalents"],
  ];
  const missing = REQUIRED.filter(([, heading]) => !text.includes(heading)).map(([subject]) => subject);
  assert.deepEqual(missing, [], `${DOC} does not publish: ${missing.join("; ")}`);
  console.log(`[G-P2-15] ${REQUIRED.length} published subjects, each with a section`);
});
