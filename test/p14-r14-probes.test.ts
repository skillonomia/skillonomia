// ROUND 14 — THE PROBES, WRITTEN BEFORE THE FIX.
//
// The rule of the round, unchanged since D-16: the attacks are composed from
// the STATEMENT OF THE REQUIREMENT, committed first, and must FAIL on the code
// as it stands. A probe written after the fix cannot discriminate — it was
// shaped by the answer.
//
// THE REQUIREMENT, AND WHY ROUND 13 CLOSED SOMETHING SMALLER THAN IT.
//
//   NO COLUMN CARRYING IDENTITY MAY COLLAPSE TWO DIFFERENT STRINGS OF A CLIENT
//   INTO ONE.
//
//   Round 13 took its set from the CODE: "every place the digest primitive is
//   called". That set is a set of CALL SITES, and hashing is only one way to
//   collapse two strings. The other has been in the schema since work 1: a
//   UNIQUE key over raw TEXT. `agents.name` is `TEXT NOT NULL CHECK(length
//   BETWEEN 1 AND 120)` with `UNIQUE(workspace_id,name)` — never hashed, never
//   examined, and therefore never in round 13's set.
//
//   D-12 says the set must be taken from the system that KNOWS it. For this
//   obligation that system is THE SCHEMA, not a list of callers.
//
// WHAT THE PRODUCT DOES TODAY, through the shipped surfaces, with nothing but
// the agent's own request (D-21):
//
//   POST /v1/principals {"name":"\ud800"}  → 201, and the row holds U+FFFD
//   POST /v1/principals {"name":"\ud801"}  → 409 CONFLICT
//
//   Two names that are DIFFERENT are one name. The second principal is refused
//   as a duplicate of a principal it does not duplicate. On bun both rows are
//   created and SQLite hands both names back as the EMPTY STRING — the same
//   collapse, moved from the write to the read.
//
//   POST /v1/principals {"name":"\u0000x"} → the CHECK on `length(name)` fails,
//   the raw SQLite error escapes, and the client gets 500 INTERNAL.
//
//   POST /v1/versions/<id>/revoke {"reason":"…\ud800…"} → `reason` passes its
//   declared validation, reaches JCS, and `src/jcs.ts` throws a BARE `Error`.
//   `handleRest` re-raises anything that is not an `ApiError`, so the client
//   gets 500 INTERNAL for a request its own published schema accepts.
//
// THE CLASS, STATED AS A PROPERTY AND NOT AS A LIST OF THREE BUGS. A string may
// be put in an identity position only if it SURVIVES THE ROUND TRIP: what the
// registry reads back is what the client sent, in both runtimes. [14.7] sweeps
// the entire BMP plus every astral plane and reports which code points fail
// that test — the set is discovered, not asserted — and then requires the
// registry's refusal to be exactly that set. Everything else is legitimate
// text and must pass: emoji, correct surrogate pairs, CJK, RTL marks, NFC and
// NFD spellings of one grapheme, ZWJ sequences, the length bounds.
//
// THE PROBES:
//
//   14.1 `agents.name`, the unhashed identity column: REST and MCP, both
//        runtimes, no false CONFLICT and no row.
//   14.2 the same column and U+0000: no 500, and never two principals whose
//        names read back as one.
//   14.3 the revocation reason: a controlled refusal, never 500.
//   14.4 THE SURVEY. The set of identity columns is read out of `sqlite_master`
//        and out of the equality searches in `src/`, never from a list; every
//        member is classified; an unclassified member fails the build.
//   14.5 the mutations that prove the survey: a new identity column fails, a
//        renamed one does not pass silently, a classification for a column that
//        no longer exists is reported.
//   14.6 NO FALSE REFUSALS.
//   14.7 the class, swept from the runtime rather than assumed.
//   14.8 no surface may answer with an untyped exception: every MCP tool and
//        every REST route, both taken from the source, driven with these
//        strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { p4Fixture, rest, mcp, NOW, type P4Fixture } from "./p6-helpers.ts";
import { publishedVersion } from "./p4-helpers.ts";
import { insertVersion } from "./helpers.ts";
import { openMigrated } from "../src/db.ts";
import { openSqlite } from "../src/sqlite.ts";
import { ERROR_CODES, isApiError } from "../src/errors.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { handleRest, handleRestAsync } from "../src/http.ts";
import { jcsCanonicalize } from "../src/jcs.ts";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const HTTP_SRC = readFileSync(fileURLToPath(new URL("../src/http.ts", import.meta.url)), "utf8");
const RUNTIME = typeof (globalThis as any).Bun !== "undefined" ? "bun" : "node";

const NUL = String.fromCharCode(0);
const HI_A = "\uD800";
const HI_B = "\uD801";

/** A bucket big enough that a sweep measures the surfaces and not the limiter. */
const NO_LIMIT = { rateLimit: { capacity: 1_000_000, refillPerSec: 0 } };

function units(s: string): string {
  return [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
}

/** Every agent row of a workspace, as the REGISTRY reads it back. */
function agentNames(fx: P4Fixture): Array<{ id: string; name: string; hex: string }> {
  return fx.seed.db
    .prepare("SELECT id, name, hex(name) AS hex FROM agents WHERE workspace_id=? ORDER BY id")
    .all(fx.seed.wsA) as Array<{ id: string; name: string; hex: string }>;
}

function createPrincipalRest(fx: P4Fixture, name: string) {
  return rest(fx, "POST", "/v1/principals", fx.keys.admin, { name, type: "agent", role: "member" });
}

// ---------------------------------------------------------------------------
// 14.1 — the identity column that is never hashed
// ---------------------------------------------------------------------------

test("[14.1] REST: two different principal names are two, or neither is admitted", () => {
  const fx = p4Fixture(NO_LIMIT);
  const before = agentNames(fx).length;

  const first = createPrincipalRest(fx, HI_A);
  const second = createPrincipalRest(fx, HI_B);

  const rows = agentNames(fx);
  const report =
    `${RUNTIME}: first=${first.status} second=${second.status} ` +
    `rows=${JSON.stringify(rows.slice(before).map((r) => r.hex))}`;

  // The requirement admits exactly two outcomes and no third: either both names
  // are admitted AS THEMSELVES, or both are refused with a typed error. What is
  // forbidden is the middle — one admitted under a name that is not its own,
  // and the other refused as a duplicate of it.
  assert.notEqual(second.status, 409, `a FALSE CONFLICT: ${HI_A} and ${HI_B} are different names — ${report}`);

  if (first.status === 201) {
    const stored = rows.find((r) => r.id === first.body.principal_id);
    assert.ok(stored, `the created principal has no row — ${report}`);
    assert.equal(stored!.name, HI_A, `the registry reads back a name that is not the one it was sent — ${report}`);
  } else {
    assert.equal(first.status, 400, `an unadmitted name must be refused with INVALID_SCHEMA — ${report}`);
    assert.equal(first.body.error.code, "INVALID_SCHEMA", report);
    assert.equal(second.status, 400, report);
    assert.equal(second.body.error.code, "INVALID_SCHEMA", report);
    assert.equal(rows.length, before, `a refused name left a row behind — ${report}`);
  }
});

test("[14.1] MCP: the same question through the other surface", () => {
  const fx = p4Fixture(NO_LIMIT);
  const before = agentNames(fx).length;

  const first = mcp(fx, fx.keys.admin, "principal.create", { name: HI_A, type: "agent", role: "member" });
  const second = mcp(fx, fx.keys.admin, "principal.create", { name: HI_B, type: "agent", role: "member" });

  const rows = agentNames(fx);
  const report =
    `${RUNTIME}: first=${JSON.stringify(first.data).slice(0, 120)} second=${JSON.stringify(second.data).slice(0, 120)}`;

  assert.notEqual(second.data?.error?.code, "CONFLICT", `a FALSE CONFLICT through MCP — ${report}`);

  if (!first.isError) {
    const stored = rows.find((r) => r.id === first.data.principal_id);
    assert.equal(stored?.name, HI_A, `MCP stored a name that is not the one it was sent — ${report}`);
  } else {
    assert.equal(first.data.error.code, "INVALID_SCHEMA", report);
    assert.equal(second.data.error.code, "INVALID_SCHEMA", report);
    assert.equal(rows.length, before, `a refused name left a row behind — ${report}`);
  }
});

// ---------------------------------------------------------------------------
// 14.2 — the same column, the other member of the class
// ---------------------------------------------------------------------------

test("[14.2] a name holding U+0000 is answered, never 500, and never read back as another name", () => {
  const fx = p4Fixture(NO_LIMIT);
  const before = agentNames(fx).length;

  // (a) a name whose SQLite `length()` is 0 while its JS length is 1: the CHECK
  //     constraint fires inside the transaction and the raw error escapes.
  let leading: { status: number; body: any } | string;
  try {
    leading = createPrincipalRest(fx, `${NUL}x`);
  } catch (e: any) {
    leading = `THREW ${isApiError(e) ? "ApiError" : e.constructor.name}: ${e.message}`;
  }
  assert.equal(
    typeof leading === "string",
    false,
    `an untyped exception reaches the client as 500 INTERNAL — ${RUNTIME}: ${leading}`,
  );
  assert.equal((leading as any).status, 400, `${RUNTIME}: ${JSON.stringify(leading)}`);
  assert.equal((leading as any).body.error.code, "INVALID_SCHEMA", `${RUNTIME}: ${JSON.stringify(leading)}`);

  // (b) two names that differ only after a U+0000. On node SQLite hands both
  //     back as "a": two principals, one name, in a column that is UNIQUE.
  const one = (() => {
    try {
      return createPrincipalRest(fx, `a${NUL}b`);
    } catch (e: any) {
      return { status: -1, body: { threw: e.message } } as any;
    }
  })();
  const two = (() => {
    try {
      return createPrincipalRest(fx, `a${NUL}c`);
    } catch (e: any) {
      return { status: -1, body: { threw: e.message } } as any;
    }
  })();
  const rows = agentNames(fx).slice(before);
  const report = `${RUNTIME}: one=${one.status} two=${two.status} rows=${JSON.stringify(rows.map((r) => [r.name, r.hex]))}`;

  assert.notEqual(one.status, -1, `an untyped exception — ${report}`);
  assert.notEqual(two.status, -1, `an untyped exception — ${report}`);

  const names = rows.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, `two rows of a UNIQUE column read back as one name — ${report}`);
});

// ---------------------------------------------------------------------------
// 14.3 — the revocation reason
// ---------------------------------------------------------------------------

test("[14.3] a revocation reason JCS cannot carry is refused, not answered with 500", () => {
  const fx = p4Fixture(NO_LIMIT);
  const v = publishedVersion(fx, "r14-revoke");

  let out: any;
  try {
    out = rest(fx, "POST", `/v1/versions/${v.versionId}/revoke`, fx.keys.owner, { reason: `unsafe ${HI_A} reason` });
  } catch (e: any) {
    out = `THREW ${isApiError(e) ? "ApiError" : e.constructor.name}: ${e.message}`;
  }
  assert.equal(
    typeof out === "string",
    false,
    `${RUNTIME}: an untyped exception escapes the router, which the server answers as 500 INTERNAL — ${out}`,
  );
  assert.equal(out.status, 400, `${RUNTIME}: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.error.code, "INVALID_SCHEMA", `${RUNTIME}: ${JSON.stringify(out.body)}`);

  const state = fx.seed.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as { state: string };
  assert.equal(state.state, "published", "a refused revocation must leave the version where it was");
});

test("[14.3] the canonicalizer's refusal is a typed one, so no route can turn it into 500", async () => {
  const { isRefusedText } = await import("../src/outcome.ts");
  for (const [what, value] of [
    ["a value", { reason: `x${HI_A}` } as any],
    ["a member name", { [`k${HI_A}`]: "v" } as any],
    ["inside an array", { a: ["ok", HI_B] } as any],
  ] as const) {
    let caught: unknown = null;
    try {
      jcsCanonicalize(value);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, `${what}: JCS accepted a string it cannot canonicalize`);
    assert.ok(
      isRefusedText(caught),
      `${what}: JCS threw a bare Error (${(caught as Error).constructor.name}), which every adapter re-raises as 500`,
    );
  }
});

// ---------------------------------------------------------------------------
// 14.4 — THE SURVEY: the set comes from the schema and from the code
// ---------------------------------------------------------------------------

async function identityModule(): Promise<any> {
  try {
    return await import("../src/identity.ts");
  } catch (e: any) {
    assert.fail(
      `the survey of identity columns does not exist: the set of columns that carry identity has never been ` +
        `written down, which is why a UNIQUE key over raw TEXT was not in round 13's set (${e.message})`,
    );
  }
}

test("[14.4] every identity column of the live schema is classified", async () => {
  const id = await identityModule();
  const db = openMigrated();
  const survey = id.surveyIdentityIntake(db, SRC_DIR);

  assert.ok(survey.columns.length >= 40, `the survey found ${survey.columns.length} identity columns, which is too few to be the schema's`);
  assert.deepEqual(
    survey.unclassified,
    [],
    `identity columns nobody classified — a UNIQUE key over raw TEXT is exactly what round 13 missed:\n  ${survey.unclassified.join("\n  ")}`,
  );
  assert.deepEqual(survey.stale, [], `classifications for columns that no longer exist:\n  ${survey.stale.join("\n  ")}`);
});

test("[14.4] the set is DERIVED: the schema's own unique keys are all in it", async () => {
  const id = await identityModule();
  const db = openMigrated();
  const found = id.identityColumnsOf(db) as Map<string, string[]>;

  // Read the unique keys straight out of sqlite_master here, independently of
  // the module, and require the module's set to cover every TEXT column of
  // every one of them. A module that agreed only with itself would prove
  // nothing.
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const missing: string[] = [];
  for (const t of tables) {
    const info = db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; type: string; pk: number }>;
    const isText = new Set(info.filter((c) => String(c.type).toUpperCase() === "TEXT").map((c) => c.name));
    for (const c of info) if (c.pk > 0 && isText.has(c.name) && !found.has(`${t}.${c.name}`)) missing.push(`${t}.${c.name} (pk)`);
    for (const idx of db.prepare(`PRAGMA index_list(${t})`).all() as Array<{ name: string; unique: number }>) {
      if (idx.unique !== 1) continue;
      for (const ic of db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string | null }>) {
        if (ic.name !== null && isText.has(ic.name) && !found.has(`${t}.${ic.name}`)) missing.push(`${t}.${ic.name} (${idx.name})`);
      }
    }
  }
  assert.deepEqual(missing, [], `unique TEXT columns the survey did not derive:\n  ${missing.join("\n  ")}`);

  // `agents.name` is the column this round exists for: it must be there, and it
  // must be there BECAUSE OF THE UNIQUE KEY, not because somebody typed it in.
  const why = found.get("agents.name");
  assert.ok(why, "agents.name is not in the derived set — the derivation does not read UNIQUE(workspace_id,name)");
  assert.ok(
    why!.some((r: string) => r.startsWith("unique:")),
    `agents.name is in the set for the wrong reason: ${JSON.stringify(why)}`,
  );
});

test("[14.4] the columns the code searches by equality are in the set too", async () => {
  const id = await identityModule();
  const db = openMigrated();
  const eq = id.equalitySearchedTextColumnsOf(db, SRC_DIR) as Map<string, string[]>;

  // `idempotency_keys.key` is not unique on its own and is not a primary key:
  // it is identity because `withIdempotency` FINDS A ROW BY IT and replays that
  // row's response. A survey that read only the schema's unique keys would keep
  // the column and lose the reason.
  assert.ok(eq.has("idempotency_keys.key"), "the equality search on idempotency_keys.key was not derived from src/");
  assert.ok(eq.has("agents.name"), "the equality search on agents.name (the CONFLICT probe) was not derived from src/");
  const survey = id.surveyIdentityIntake(db, SRC_DIR);
  for (const k of eq.keys()) {
    assert.ok(survey.columns.includes(k), `${k} is searched by equality in src/ and is not in the survey`);
  }
});

test("[14.4] a class is a claim about a mechanism, and every class in use is one of the three", async () => {
  const id = await identityModule();
  const db = openMigrated();
  const survey = id.surveyIdentityIntake(db, SRC_DIR);
  const classes = Object.keys(survey.byClass).sort();
  assert.deepEqual(classes, ["checked_at_boundary", "declared_limit", "registry_generated"]);
  const total = classes.reduce((n, c) => n + survey.byClass[c].length, 0);
  assert.equal(total, survey.columns.length, "a column landed in no class, or in two");

  // The column this round is about carries a client's own text, so its class
  // must be the one that says a boundary examines it — not the one that says
  // the registry made the value up.
  assert.equal(id.IDENTITY_INTAKE["agents.name"].intake, "checked_at_boundary");
  assert.equal(id.IDENTITY_INTAKE["idempotency_keys.key"].intake, "checked_at_boundary");
});

// ---------------------------------------------------------------------------
// 14.5 — the mutations that prove the survey
// ---------------------------------------------------------------------------

test("[14.5] MUTATION: a new identity column of free TEXT fails the build", async () => {
  const id = await identityModule();
  const db = openMigrated();
  assert.deepEqual(id.surveyIdentityIntake(db, SRC_DIR).unclassified, [], "precondition: the tree is clean");

  // The migration a future work would write, applied here: one more column that
  // carries identity, and nobody has said what may go into it.
  db.exec("ALTER TABLE skills ADD COLUMN external_ref TEXT");
  db.exec("CREATE UNIQUE INDEX uq_skills_external_ref ON skills(external_ref)");

  const after = id.surveyIdentityIntake(db, SRC_DIR);
  assert.deepEqual(
    after.unclassified,
    ["skills.external_ref"],
    "a new identity column was filed quietly — the survey is a list, not a derivation",
  );
});

test("[14.5] MUTATION: renaming a classified column gives no silent pass", async () => {
  const id = await identityModule();
  const db = openMigrated();
  // SQLite renames the column and rewrites the UNIQUE key with it.
  db.exec("ALTER TABLE agents RENAME COLUMN name TO display_name");

  const after = id.surveyIdentityIntake(db, SRC_DIR);
  assert.ok(
    after.unclassified.includes("agents.display_name"),
    `the renamed column is unclassified and must be reported: ${JSON.stringify(after.unclassified)}`,
  );
  assert.ok(
    after.stale.includes("agents.name"),
    `the classification of the old name is a claim about nothing and must be reported: ${JSON.stringify(after.stale)}`,
  );
});

test("[14.5] MUTATION: dropping the boundary check turns the false CONFLICT back on", async () => {
  // The behavioural half of the mutation: the survey can only say a boundary is
  // CLAIMED to check. This probe drives the claim, so a classification that
  // names a boundary which does nothing cannot pass.
  const id = await identityModule();
  const { RefusedText } = await import("../src/outcome.ts");
  const boundary = id.IDENTITY_INTAKE["agents.name"];
  assert.match(
    boundary.note,
    /src\/provision\.ts/,
    "the classification of agents.name must name the boundary that examines it",
  );

  const db = openSqlite(":memory:");
  db.exec("CREATE TABLE t(v TEXT NOT NULL, UNIQUE(v))");
  const { assertIdentityText } = await import("../src/outcome.ts");
  for (const bad of [HI_A, HI_B, `${NUL}x`, `a${NUL}b`]) {
    assert.throws(
      () => assertIdentityText(bad, "a probe"),
      (e: unknown) => e instanceof RefusedText,
      `${units(bad)} reached storage: it does not survive the round trip`,
    );
  }
});

// ---------------------------------------------------------------------------
// 14.6 — no false refusals
// ---------------------------------------------------------------------------

const LEGITIMATE: Array<[string, string]> = [
  ["ascii", "plain-name"],
  ["emoji (a correct surrogate pair)", "deploy \u{1F680} bot"],
  ["astral, alone", "\u{1F600}"],
  ["CJK", "配置エージェント"],
  ["Cyrillic", "агент-один"],
  ["RTL, right-to-left mark", "عميل‏-1"],
  ["NFC", "éclair".normalize("NFC")],
  ["NFD", "éclair".normalize("NFD")],
  ["ZWJ sequence", "family \u{1F468}‍\u{1F469}‍\u{1F467}"],
  ["combining marks", "à́̂"],
  ["U+FFFD sent on purpose", "replacement � here"],
  ["one character", "x"],
  ["120 UTF-16 units", "n".repeat(120)],
  ["120 UTF-16 units of astral text", "\u{1F600}".repeat(60)],
];

test("[14.6] every legitimate name is admitted, stored as itself, and stays its own row", () => {
  const fx = p4Fixture(NO_LIMIT);
  const created: Array<[string, string, string]> = [];
  for (const [what, name] of LEGITIMATE) {
    const out = createPrincipalRest(fx, name);
    assert.equal(out.status, 201, `${RUNTIME}: ${what} was refused: ${out.raw.slice(0, 200)}`);
    created.push([what, name, out.body.principal_id]);
  }
  const byId = new Map(agentNames(fx).map((r) => [r.id, r.name]));
  for (const [what, name, principalId] of created) {
    assert.equal(byId.get(principalId), name, `${RUNTIME}: ${what} was stored as something else (${units(name)})`);
  }
  // NFC and NFD are two spellings of one grapheme and two DIFFERENT strings.
  // A registry that folded them would refuse the second as a duplicate; one
  // that keeps them apart is what this column's UNIQUE key means.
  const nfc = created.find(([w]) => w === "NFC")![2];
  const nfd = created.find(([w]) => w === "NFD")![2];
  assert.notEqual(nfc, nfd);
  assert.notEqual(byId.get(nfc), byId.get(nfd));
});

test("[14.6] a name of 121 units is refused for its LENGTH, and never truncated into another name", () => {
  const fx = p4Fixture(NO_LIMIT);
  const out = createPrincipalRest(fx, "n".repeat(121));
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, "INVALID_SCHEMA");
  assert.match(out.body.error.message, /1\.\.120/);
  assert.equal(agentNames(fx).some((r) => r.name.startsWith("nnnn")), false, "a refused name was truncated in");
});

// ---------------------------------------------------------------------------
// 14.7 — the class, swept from the runtime
// ---------------------------------------------------------------------------

test("[14.7] the strings a TEXT column cannot carry are exactly the ones the registry refuses", async () => {
  const { assertIdentityText, isRefusedText } = await import("../src/outcome.ts");
  const db = openSqlite(":memory:");
  db.exec("CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO t(k,v) VALUES (?,?)");
  const sel = db.prepare("SELECT v FROM t WHERE k=?");

  /** Does this exact string come back out of SQLite as itself? */
  const survives = (key: number, s: string): boolean => {
    try {
      ins.run(key, s);
    } catch {
      return false;
    }
    return ((sel.get(key) as { v: string }).v as string) === s;
  };
  const refuses = (s: string): boolean => {
    try {
      assertIdentityText(s, "a swept string");
      return false;
    } catch (e) {
      assert.ok(isRefusedText(e), `the refusal of ${units(s)} is not a typed one: ${(e as Error).constructor.name}`);
      return true;
    }
  };

  /** SQLite's OWN measure of a value, which is what a `CHECK(length(...))` sees.
   *  It is asked of the engine, so it is the same question in both runtimes. */
  const measured = db.prepare("SELECT length(?) AS l");

  const admitted: string[] = [];
  const refusedButSurvives: string[] = [];
  const refused: number[] = [];
  let key = 0;
  const sweep = (cp: number, s: string): void => {
    const ok = survives(key++, s);
    const no = refuses(s);
    if (no) refused.push(cp);
    // DIRECTION ONE, and it is the one correctness depends on: nothing that
    // fails to come back out as itself may be admitted.
    if (!ok && !no) admitted.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    if (ok && no) refusedButSurvives.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  };
  for (let cu = 0; cu <= 0xffff; cu++) sweep(cu, `x${String.fromCharCode(cu)}y`);
  for (let plane = 1; plane <= 16; plane++) {
    for (const cp of [plane * 0x10000, plane * 0x10000 + 0xfffd]) sweep(cp, `x${String.fromCodePoint(cp)}y`);
  }

  assert.deepEqual(
    admitted.slice(0, 20),
    [],
    `${RUNTIME}: ${admitted.length} code points do not survive a TEXT column here and are admitted anyway`,
  );

  // DIRECTION TWO — the anti-widening half. The refused set is exactly the two
  // ranges this round names, over the whole domain swept above, so a rule
  // quietly widened to (say) every C0 control or to NFD spellings fails here.
  const ranges = (xs: number[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < xs.length; ) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
      const hex = (n: number) => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;
      out.push(i === j ? hex(xs[i]!) : `${hex(xs[i]!)}..${hex(xs[j]!)}`);
      i = j + 1;
    }
    return out;
  };
  assert.deepEqual(ranges(refused.sort((a, b) => a - b)), ["U+0000", "U+D800..U+DFFF"], `${RUNTIME}: the refused set`);

  // AND THE DIFFERENCE BETWEEN THE TWO DIRECTIONS IS MEASURED, NOT ASSUMED.
  // A code point may be refused although it survives HERE — the rule is that a
  // string must survive on every runtime this project ships on, and this process
  // is one of them. bun round-trips U+0000 and node does not. So each such code
  // point must carry a reason SQLITE ITSELF gives, in this runtime: the engine
  // measures the value SHORTER than it is, which is what makes
  // `CHECK(length(name) BETWEEN 1 AND 120)` fail for a name the request
  // satisfied, on bun exactly as on node.
  for (const name of refusedButSurvives) {
    const s = `x${String.fromCodePoint(Number.parseInt(name.slice(2), 16))}y`;
    const l = (measured.get(s) as { l: number }).l;
    assert.notEqual(
      l,
      [...s].length,
      `${RUNTIME}: ${name} is refused, survives the round trip here, and SQLite measures it faithfully — nothing ` +
        `in this runtime justifies refusing it`,
    );
  }
  console.log(
    `[14.7] ${RUNTIME}: swept ${key} code points · refused ${ranges(refused).join(" ")} · ` +
      `refused-but-round-trips-here ${refusedButSurvives.join(",") || "none"}`,
  );
});

// ---------------------------------------------------------------------------
// 14.8 — no surface answers with an untyped exception
// ---------------------------------------------------------------------------

/** Every REST route, taken from the SOURCE of the router and not from a list. */
function restRoutesFromSource(): Array<{ method: string; path: string }> {
  const lines = HTTP_SRC.split("\n");
  const routes: Array<{ method: string; path: string }> = [];
  let lastRegex: string | null = null;
  for (const line of lines) {
    const rx = /=\s*\/\^(.+?)\$\/\.exec\(path\)/.exec(line);
    if (rx) lastRegex = rx[1]!;
    const lit = /method === "([A-Z]+)" && path === "([^"]+)"/.exec(line);
    if (lit) {
      routes.push({ method: lit[1]!, path: lit[2]! });
      continue;
    }
    const dyn = /method === "([A-Z]+)" && m\b/.exec(line);
    if (dyn && lastRegex) routes.push({ method: dyn[1]!, path: lastRegex.replace(/\\\//g, "/") });
  }
  return routes;
}

/**
 * Every field a request body may carry, from TWO sources and no list.
 *
 * The router names some of them itself (`body.slug`), but most surfaces take
 * the body WHOLE and hand it to the service — `revokeVersion(auth, id, body)`
 * never mentions `reason`, which is precisely the field this round is about. So
 * the second source is the declared `inputSchema` of every MCP tool: the same
 * surfaces, with their arguments written down as data.
 */
function requestFieldsFromSource(): string[] {
  const names = new Set<string>();
  for (const m of HTTP_SRC.matchAll(/\bbody\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]!);
  for (const m of HTTP_SRC.matchAll(/\bbody\?\.\[?"?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]!);
  for (const tool of MCP_TOOLS as ReadonlyArray<{ inputSchema: any }>) {
    for (const prop of Object.keys(tool.inputSchema?.properties ?? {})) names.add(prop);
  }
  return [...names].sort();
}

/**
 * A route with its parameters filled in with REAL rows, so that the sweep
 * reaches the surface's own work instead of stopping at NOT_FOUND. The value
 * for a parameter is chosen BY THE SEGMENT BEFORE IT — the same rule the router
 * itself uses to name the thing — so a route added tomorrow gets a live id if
 * its collection is one of these and a syntactically valid ULID otherwise.
 */
const PARAM = "__PARAM__"; // the capture group, as one segment, so `/` inside it does not split
function fillPath(path: string, live: Record<string, string>): string {
  const segments = path.replace(/\(\[\^\/\]\+\)/g, PARAM).split("/");
  return segments
    .map((seg, i) => (seg === PARAM ? (live[segments[i - 1] ?? ""] ?? live.__fallback!) : seg))
    .join("/");
}

// THE ROUTER IS DRIVEN THE WAY A LISTENER DRIVES IT — `handleRestAsync`.
//
// `handleRest` is synchronous and stays so, but a route may finish DECIDING
// before it finishes ANSWERING and hand the rest out on `RestResponse.pending`
// (§6.5.2, src/http.ts). The synchronous return of such a route is a
// placeholder that deliberately reads as `500 INTERNAL`, because a caller that
// ignored the promise would not have answered the request at all. A sweep that
// read that placeholder would be reporting the sweep's own shortcut as a defect
// of the surface, so this one awaits exactly what `src/server.ts` writes.
test("[14.8] no REST route answers a string like this with an untyped exception", async () => {
  const routes = restRoutesFromSource();
  const fields = requestFieldsFromSource();
  assert.ok(routes.length >= 30, `only ${routes.length} routes were derived from src/http.ts — the derivation is broken`);
  assert.ok(fields.length >= 8, `only ${fields.length} body fields were derived from src/http.ts`);

  const failures: string[] = [];
  let semver = 0;
  for (const bad of [HI_A, `${NUL}x`, `a${NUL}b`]) {
    const fx = p4Fixture(NO_LIMIT);
    const seeded = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, {
      skill_version_id: insertVersion(fx.seed.db, fx.seed.skill, fx.seed.authorA, "9.0.0", "published", NOW),
    });

    for (const route of routes) {
      // ONE field at a time, everything else absent: a body that sets every
      // field at once is refused by the FIRST field the surface looks at and
      // never reaches the one under test. And a FRESH version per call, because
      // a surface that succeeds leaves the version in a state where the next
      // call is refused before it does its own work — which is exactly how an
      // earlier draft of this sweep passed while the defect was still there.
      for (const field of fields) {
        const url = fillPath(route.path, {
          __fallback: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
          versions: insertVersion(fx.seed.db, fx.seed.skill, fx.seed.authorA, `7.0.${semver++}`, "published", NOW),
          skills: fx.seed.skill,
          adoptions: seeded.body.adoption_request_id,
          receipts: seeded.body.receipt_id,
          principals: fx.member.agent_id,
          fleet: fx.member.agent_id,
          "signing-keys": "r14-probe-kid",
        });
        let res: any;
        try {
          res = await handleRestAsync(fx.registry, {
            method: route.method,
            url,
            headers: { authorization: `Bearer ${fx.keys.owner}` },
            body: Buffer.from(JSON.stringify({ [field]: bad }), "utf8"),
          });
        } catch (e: any) {
          failures.push(`${route.method} ${route.path} {${field}} [${units(bad)}] threw ${e.constructor.name}: ${e.message}`);
          continue;
        }
        if (res.status >= 500) failures.push(`${route.method} ${route.path} {${field}} [${units(bad)}] answered ${res.status}`);
      }
    }
  }
  assert.deepEqual(
    failures.slice(0, 12),
    [],
    `${RUNTIME}: ${failures.length} route/field/string triples leave the router as an untyped exception, which the ` +
      `server answers as 500 INTERNAL`,
  );
});

test("[14.8] no MCP tool answers a string like this with an untyped exception", () => {
  const failures: string[] = [];
  let semver = 0;
  let tested = 0;
  for (const bad of [HI_A, `${NUL}x`, `a${NUL}b`]) {
    const fx = p4Fixture(NO_LIMIT);
    const seeded = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, {
      skill_version_id: insertVersion(fx.seed.db, fx.seed.skill, fx.seed.authorA, "9.0.0", "published", NOW),
    });
    for (const tool of MCP_TOOLS as ReadonlyArray<{ name: string; inputSchema: any }>) {
      const strings = Object.entries((tool.inputSchema?.properties ?? {}) as Record<string, any>)
        .filter(([, spec]) => spec?.type === "string")
        .map(([prop]) => prop);

      for (const under of strings) {
        // The OTHER arguments are given values that work, so the tool reaches
        // its own work instead of refusing the request for a missing argument
        // and never looking at the one under test. The SET of tools and of
        // their string arguments is still read off the declared schemas.
        const live: Record<string, string> = {
          skill_version_id: insertVersion(fx.seed.db, fx.seed.skill, fx.seed.authorA, `8.0.${semver++}`, "published", NOW),
          skill_id: fx.seed.skill,
          adoption_request_id: seeded.body.adoption_request_id,
          receipt_id: seeded.body.receipt_id,
          principal_id: fx.member.agent_id,
          agent_id: fx.member.agent_id,
          key_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
        };
        const args: Record<string, unknown> = {};
        for (const prop of strings) args[prop] = live[prop] ?? "probe";
        args[under] = bad;
        tested++;

        let out: any;
        try {
          out = rest(fx, "POST", "/mcp", fx.keys.owner, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool.name, arguments: args },
          });
        } catch (e: any) {
          failures.push(`${tool.name}{${under}} [${units(bad)}] threw ${e.constructor.name}: ${e.message}`);
          continue;
        }
        const result = out.body?.result;
        if (!result) {
          failures.push(`${tool.name}{${under}} [${units(bad)}] produced no tool result: ${out.raw.slice(0, 120)}`);
          continue;
        }
        if (result.isError) {
          const env = JSON.parse(result.content[0].text);
          if (!ERROR_CODES.includes(env.error?.code)) {
            failures.push(`${tool.name}{${under}} [${units(bad)}] answered with an untyped code ${env.error?.code}`);
          }
        }
      }
    }
  }
  assert.ok(tested >= 100, `only ${tested} tool/argument pairs were driven — the derivation from MCP_TOOLS is broken`);
  assert.deepEqual(failures.slice(0, 12), [], `${RUNTIME}: ${failures.length} tool/argument/string triples are not typed refusals`);
});

/**
 * [14.10] — THE BACKSTOP, PROVED SEPARATELY BECAUSE NOTHING ELSE PROVES IT.
 *
 * Written AFTER the fix, and it says so. Every path that reaches
 * `jcsCanonicalize` with a caller's string today is ALSO closed at its own
 * boundary — the sweep above found exactly one, `skill.revoke{reason}`, and that
 * boundary now refuses it by name. So removing the adapter mapping breaks no
 * probe above, which means the sweep alone would let the structural half of this
 * fix be deleted silently.
 *
 * What the mapping is for is the path NOBODY HAS ANNOTATED — the next surface to
 * canonicalize a field, the reason class to gain a third member. This asserts
 * the adapter contract directly: a surface that raises a `RefusedText` is
 * answered with a typed `INVALID_SCHEMA` on both adapters, never re-raised into
 * the listener's `500 INTERNAL`.
 */
test("[14.10] a surface that raises a refusal is answered, on either adapter, never re-raised", async () => {
  const { NotWellFormedText } = await import("../src/outcome.ts");
  const fx = p4Fixture(NO_LIMIT);
  const boom = () => {
    throw new NotWellFormedText("a value some future surface canonicalizes");
  };

  (fx.registry as any).listPrincipals = boom;
  const viaRest = rest(fx, "GET", "/v1/principals", fx.keys.admin);
  assert.equal(viaRest.status, 400, `REST: ${viaRest.raw.slice(0, 200)}`);
  assert.equal(viaRest.body.error.code, "INVALID_SCHEMA");

  (fx.registry as any).createPrincipal = boom;
  const viaMcp = mcp(fx, fx.keys.admin, "principal.create", { name: "ok", type: "agent", role: "member" });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.data.error.code, "INVALID_SCHEMA", JSON.stringify(viaMcp.data));
});

// ---------------------------------------------------------------------------
// the rule lives in ONE place
// ---------------------------------------------------------------------------

test("[14.9] `isWellFormed` is asked in exactly one file, and the identity rule is built on it there", () => {
  const sites: string[] = [];
  for (const f of readdirSync(SRC_DIR).filter((n) => n.endsWith(".ts")).sort()) {
    const text = readFileSync(SRC_DIR + f, "utf8");
    for (const line of text.split("\n")) {
      // a CALL, not a mention in prose
      if (/\.isWellFormed\s*\(/.test(line) && !/^\s*(\*|\/\/)/.test(line)) sites.push(`${f}: ${line.trim()}`);
    }
  }
  assert.equal(
    sites.length,
    1,
    `the rule is stated in ${sites.length} places, and two statements of one rule are how they come apart:\n  ${sites.join("\n  ")}`,
  );
  assert.match(sites[0]!, /^outcome\.ts:/, `the rule must live in src/outcome.ts, not in ${sites[0]}`);
});
