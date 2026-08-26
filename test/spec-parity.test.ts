// SPEC ↔ code parity guards.
//
// The class of defect these exist to make impossible: the code grows a surface,
// a field, an error code, a transparency-log kind or a migration, every test
// still passes, and SPEC.md — which this project publishes as the document an
// independent implementation is built from — quietly stops describing the
// software. A full manual re-read finds those; it finds them once, and the next
// change reopens them.
//
// So every guard below is DERIVED FROM THE CODE and compares the specification
// against it. Three already existed in this suite and are the model:
// `test/version.test.ts` (one version string), `test/supply-chain.test.ts`
// (pinned actions), and the surface inventory in
// `test/lifecycle-surfaces.test.ts` (numbered tools ↔ Appendix H). These extend
// the same idea to the inventories that had drifted: auxiliary surfaces, REST
// routes, response bodies, the error space, the verdict space, the tlog kinds,
// the migrations and the Appendix G gate data.
//
// Direction matters. Where a guard is one-way it is because that is the
// direction drift actually travels — the code gains something and the document
// does not — and the comment says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CODES, HTTP_STATUS } from "../src/errors.ts";
import { VERDICTS } from "../src/verify.ts";
import { ARCHIVE_ERROR_CODES } from "../src/archive.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { SEARCH_FILTERS } from "../src/service.ts";
import { GATE_NAMES, SECRET_PATTERNS, INJECTION_PATTERNS, SHELL_SEVERITY, URL_DENYLIST, STALENESS_POLICY, WRAPPERS, PRIVILEGE_ESCALATORS } from "../src/gates.ts";
import { APPROVAL_MATRIX } from "../src/approvals.ts";
import { DASHBOARD_VIEWS } from "../src/dashboard.ts";
import { RECEIPT_EVENTS } from "../src/receipts.ts";
import { satisfies, checkCompatibility, isRange } from "../src/compat.ts";
import { blockedReason } from "../src/transport.ts";
import { openMigrated } from "../src/db.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const SPEC = read("SPEC.md");
/** SPEC with every whitespace run collapsed, so a phrase can be searched for
 *  without caring where the author wrapped the line. */
const FLAT = SPEC.replace(/\s+/g, " ");

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

function section(heading: string, nextHeading: string): string {
  const from = SPEC.indexOf(heading);
  assert.ok(from >= 0, `SPEC section not found: ${heading}`);
  const to = SPEC.indexOf(nextHeading, from + heading.length);
  assert.ok(to > from, `SPEC section end not found: ${nextHeading}`);
  return SPEC.slice(from, to);
}

/** Backticked tokens of a slice, in order, deduplicated. */
function ticked(slice: string): string[] {
  return [...new Set([...slice.matchAll(/`([^`]+)`/g)].map((m) => m[1]))];
}

/** Cells of a markdown table row, trimmed. */
function cells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// ===========================================================================
// 1. Migrations: every embedded block is the shipped file, and Appendix D's
//    prose counts them correctly.
//
// The Appendix D preamble said "two migrations" and `user_version` `2` for as
// long as three migrations shipped, because only D.1's byte-identity was ever
// asserted. Both halves are checked here.
// ===========================================================================

/** The ```sql block under a `### D.1…` heading. */
function ddlBlock(heading: string): string {
  const lines = SPEC.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  assert.ok(start >= 0, `no ${heading}`);
  const open = lines.findIndex((l, i) => i > start && l === "```sql");
  const close = lines.findIndex((l, i) => i > open && l === "```");
  assert.ok(open > start && close > open, `no sql block under ${heading}`);
  return lines.slice(open + 1, close).join("\n") + "\n";
}

const MIGRATION_BLOCKS: ReadonlyArray<{ heading: string; file: string }> = [
  { heading: "### D.1 NORMATIVE DDL", file: "migrations/0001_init.sql" },
  { heading: "### D.1b NORMATIVE DELTA", file: "migrations/0002_p5.sql" },
  { heading: "### D.1c NORMATIVE DELTA", file: "migrations/0003_revocation_notice.sql" },
  { heading: "### D.1d NORMATIVE DELTA", file: "migrations/0004_declared_environment_on_the_event.sql" },
  { heading: "### D.1e NORMATIVE DELTA", file: "migrations/0005_server_side_packing.sql" },
  { heading: "### D.1f NORMATIVE DELTA", file: "migrations/0006_transfer_to_a_named_recipient.sql" },
  { heading: "### D.1g NORMATIVE DELTA", file: "migrations/0007_assignment_and_native_activation.sql" },
  { heading: "### D.1h NORMATIVE DELTA", file: "migrations/0008_observed_runtime_records.sql" },
  { heading: "### D.1i NORMATIVE DELTA", file: "migrations/0009_the_recipient_of_a_pull_is_on_the_event.sql" },
  { heading: "### D.1j NORMATIVE DELTA", file: "migrations/0010_evidence_on_the_observed_record.sql" },
  { heading: "### D.1k NORMATIVE DELTA", file: "migrations/0011_a_rebuild_whose_rule_was_withdrawn.sql" },
  { heading: "### D.1l NORMATIVE DELTA", file: "migrations/0012_the_key_of_a_repeat_is_a_digest_on_every_row.sql" },
  { heading: "### D.1m NORMATIVE DELTA", file: "migrations/0013_capture_and_draft_revisions.sql" },
  { heading: "### D.1n NORMATIVE DELTA", file: "migrations/0014_owner_console_sessions_and_decisions.sql" },
  { heading: "### D.1o NORMATIVE DELTA", file: "migrations/0015_assignment_and_lifecycle_control.sql" },
  { heading: "### D.1p NORMATIVE DELTA", file: "migrations/0016_session_loadout_and_runtime_receipts.sql" },
  { heading: "### D.1q NORMATIVE DELTA", file: "migrations/0017_outcomes_and_the_revision_loop.sql" },
  { heading: "### D.1r NORMATIVE DELTA", file: "migrations/0018_a_revocation_and_a_replacement_are_two_facts.sql" },
];

test("every migration file is embedded in Appendix D byte-identically", () => {
  const onDisk = readdirSync(join(root, "migrations")).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  assert.deepEqual(
    onDisk,
    MIGRATION_BLOCKS.map((m) => m.file.replace("migrations/", "")),
    "a migration was added or removed without an Appendix D block",
  );
  for (const { heading, file } of MIGRATION_BLOCKS) {
    assert.equal(ddlBlock(heading), read(file), `${file} must equal its Appendix D block verbatim`);
  }
});

test("Appendix D's prose counts the migrations, the user_version and the delta the way the code does", () => {
  const n = MIGRATION_BLOCKS.length;
  assert.ok(
    FLAT.includes(`given in **${NUMBER_WORDS[n]}** migrations`),
    `Appendix D must say "${NUMBER_WORDS[n]} migrations"`,
  );
  // each migration's own user_version claim
  for (let i = 1; i <= n; i += 1) {
    assert.ok(
      FLAT.includes(`\`PRAGMA user_version\` = \`${i}\`.`),
      `Appendix D must state \`PRAGMA user_version\` = \`${i}\` for migration ${i}`,
    );
  }
  // and the live value after all of them
  const db = openMigrated();
  const live = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  db.close();
  assert.equal(live, n, "user_version tracks the highest applied migration number");
  assert.ok(
    FLAT.includes(`After all ${NUMBER_WORDS[n]} migrations \`PRAGMA user_version\` MUST report \`${live}\``),
    `Appendix D must report user_version ${live} after all ${NUMBER_WORDS[n]} migrations`,
  );
});

// ===========================================================================
// 2. The transparency-log event kinds.
//
// `version_verified` and `approval_recorded` were written by the registry and
// absent from §4.4's list. The inventory is discovered from the source rather
// than restated here, so a new kind cannot be added quietly.
// ===========================================================================

/** Every tlog `event_kind` the code can write, found by its declaration. */
function tlogKindsFromSource(): Set<string> {
  const kinds = new Set<string>();
  for (const file of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"))) {
    const src = read(join("src", file));
    for (const m of src.matchAll(/export const (?:TLOG_[A-Z_]+|COUNTERSIGN_EVENT) = "([a-z_]+)"/g)) {
      kinds.add(m[1]);
    }
  }
  return kinds;
}

test("§4.4 lists exactly the transparency-log kinds the code writes", () => {
  const fromCode = tlogKindsFromSource();
  assert.ok(fromCode.size >= 8, `the source scan found only ${fromCode.size} kinds — the scan itself is broken`);

  const whole = section("`event_kind` is not a closed set", "§4.4 step 6 tests INCLUSION");
  // rows only: everything after the table's header separator
  const slice = whole.slice(whole.indexOf("|---|"));
  const fromSpec = new Set(
    [...slice.matchAll(/^\| `([a-z_]+)` \| /gm)].map((m) => m[1]),
  );
  assert.deepEqual([...fromSpec].sort(), [...fromCode].sort(), "§4.4's kind table and the code disagree");

  const word = NUMBER_WORDS[fromCode.size];
  assert.ok(word, "the kind count has a spelled-out form");
  assert.ok(
    FLAT.includes(`The kinds V1 writes are exactly these ${word}:`),
    `§4.4 must say "exactly these ${word}"`,
  );
});

// ===========================================================================
// 3. The error space and its HTTP statuses.
//
// §6 claimed the code space was "the §4.4 verdict and failure vocabulary",
// which put eight verdicts and `NOT_LOGGED` in a list of error codes that has
// never contained any of them, while leaving `UNAUTHORIZED` out of Appendix H.
// ===========================================================================

test("§6, Appendix H and docs/API.md carry exactly the code's ErrorCode set", () => {
  const codes = [...ERROR_CODES].sort();
  assert.deepEqual(Object.keys(HTTP_STATUS).sort(), codes, "HTTP_STATUS covers every code and no other");

  // §6's fenced list
  const errorModel = section("**Error model.** Errors are typed codes", "One rule governs every state machine");
  const fenced = /```\n([\s\S]*?)\n```/.exec(errorModel);
  assert.ok(fenced, "§6's error model must carry the code list in a fenced block");
  const fromSpec = fenced[1].split(/[·\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  assert.deepEqual([...fromSpec].sort(), codes, "§6's closed code list and ErrorCode disagree");

  const word = NUMBER_WORDS[ERROR_CODES.length];
  assert.ok(
    FLAT.includes(`The code space is closed and has exactly ${word} members:`),
    `§6 must say "exactly ${word} members"`,
  );

  // Appendix H's inline list
  const h = section("## Appendix H.", "| # | MCP tool |");
  const inline = new RegExp(`with the ${word} codes §6 closes over — ([^—]+) —`).exec(h);
  assert.ok(inline, "Appendix H's conventions must list the codes");
  assert.deepEqual(
    inline[1].split("|").map((s) => s.replace(/`/g, "").trim()).sort(),
    codes,
    "Appendix H's code list and ErrorCode disagree",
  );

  // docs/API.md's list
  const api = read("docs/API.md");
  const doc = /- \*\*Errors\*\*: `\{"error".*?\}` with codes\s+`([^`]+)`/s.exec(api);
  assert.ok(doc, "docs/API.md must list the codes");
  assert.deepEqual(
    doc[1].split("|").map((s) => s.replace(/\s+/g, " ").trim()).sort(),
    codes,
    "docs/API.md's code list and ErrorCode disagree",
  );
});

test("§6 states the HTTP status of every error code, as errors.ts maps it", () => {
  const errorModel = section("The HTTP status of each code is fixed", "Over MCP the same envelope");
  const flat = errorModel.replace(/\s+/g, " ");
  // the sentence groups codes by status: "`A`, `B` and `C` 400"
  for (const [code, status] of Object.entries(HTTP_STATUS)) {
    const re = new RegExp(`\`${code}\`[^.]*?\\b${status}\\b`);
    assert.ok(re.test(flat), `§6 must give ${code} the status ${status}`);
  }
});

test("NOT_LOGGED is a verdict and never an error code, and the spec says so in both places", () => {
  assert.ok((VERDICTS as readonly string[]).includes("NOT_LOGGED"));
  assert.ok(!(ERROR_CODES as readonly string[]).includes("NOT_LOGGED"));
  assert.ok(
    FLAT.includes("**`NOT_LOGGED` is likewise a verdict and not an error code.**"),
    "§6 must say NOT_LOGGED is not an error code",
  );
  assert.ok(
    FLAT.includes("The §4.4 verdicts, `NOT_LOGGED` included, are NEVER error codes"),
    "Appendix H must say the same",
  );
  // and no §4.4 verdict leaked into the error space
  for (const v of VERDICTS) {
    if ((ERROR_CODES as readonly string[]).includes(v)) {
      assert.ok(
        /^[A-Z_]+$/.test(v),
        `${v} is both a verdict and an error code — only the §4.4 failure CODES may be both`,
      );
    }
  }
});

// ===========================================================================
// 4. The §4.4.8 verdict vocabulary.
// ===========================================================================

test("§4.4.8 lists exactly the verdicts the implementation can return", () => {
  const step8 = section("8. **Verdict vocabulary — the complete set:**", "`valid` means:");
  const fromSpec = ticked(step8);
  const fromCode = [...new Set([...VERDICTS, ...ARCHIVE_ERROR_CODES])];
  assert.deepEqual(
    [...fromSpec].sort(),
    [...fromCode].sort(),
    "§4.4.8 and (verify.ts VERDICTS + archive.ts ARCHIVE_ERROR_CODES) disagree",
  );
});

// ===========================================================================
// 5. Surface inventory — MCP tools, including the auxiliaries.
//
// The numbered tools were already guarded (lifecycle-surfaces.test.ts). The
// AUXILIARY ones were not, which is how `tlog.read` and `dashboard.view` came
// to exist in the code and nowhere in the specification.
// ===========================================================================

/** Every tool name Appendix H names in a table's tool column. */
function toolsInAppendixH(): Set<string> {
  const h = SPEC.slice(SPEC.indexOf("## Appendix H."));
  const out = new Set<string>();
  for (const line of h.split("\n")) {
    if (!line.startsWith("|")) continue;
    for (const cell of cells(line).slice(0, 2)) {
      const m = /^`([a-z_]+(?:\.[a-z_]+)+)`$/.exec(cell);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

test("Appendix H names every advertised MCP tool, and advertises every tool it names", () => {
  const advertised = new Set(MCP_TOOLS.map((t) => t.name));
  const documented = toolsInAppendixH();
  assert.deepEqual([...documented].sort(), [...advertised].sort(), "MCP_TOOLS and Appendix H disagree");
});

// ===========================================================================
// 6. REST route inventory.
//
// Parsed out of the router itself. The parser is checked against the number of
// `method === "` decisions in the file, so a route written in a shape the
// parser does not understand fails loudly instead of going uncounted.
// ===========================================================================

/** `{id}`-style placeholders and `([^/]+)` capture groups both become `*`. */
function normalizeRoute(route: string): string {
  return route.replace(/\{[^}]+\}/g, "*").replace(/\(\[\^\/\]\+\)/g, "*");
}

function restRoutesFromRouter(): Set<string> {
  const src = read("src/http.ts").split("\n");
  const found = new Set<string>();
  let decisions = 0;
  let pending: string | null = null;
  for (const line of src) {
    const rx = /^\s*(?:let |const )?m = \/\^(.*?)\$\/\.exec\(path\);/.exec(line);
    if (rx) pending = rx[1].replace(/\\\//g, "/");
    const method = /method === "([A-Z]+)"/.exec(line);
    if (!method) continue;
    decisions += 1;
    const literal = /path === "([^"]+)"/.exec(line);
    if (literal) {
      found.add(`${method[1]} ${normalizeRoute(literal[1])}`);
      continue;
    }
    if (/&& m\)/.test(line) && pending) {
      found.add(`${method[1]} ${normalizeRoute(pending)}`);
      pending = null;
      continue;
    }
    // a decision the parser could not attribute to a route
    found.add(`UNPARSED ${line.trim()}`);
  }
  const unparsed = [...found].filter((r) => r.startsWith("UNPARSED"));
  assert.deepEqual(unparsed, [], "src/http.ts has a route shape this parser does not understand");
  assert.equal(found.size, decisions, "every routing decision in src/http.ts yielded exactly one route");
  return found;
}

test("Appendix H documents every REST route the router serves", () => {
  const routes = restRoutesFromRouter();
  assert.ok(routes.size >= 30, `only ${routes.size} routes parsed — the parser is broken`);
  const h = SPEC.slice(SPEC.indexOf("## Appendix H."));
  // `POST /mcp` is the MCP transport mount, documented in the conventions
  // paragraph rather than as a row.
  const documented = new Set<string>(
    [...h.matchAll(/`(GET|POST|DELETE) (\/[A-Za-z0-9/{}_.-]*)/g)].map((m) => `${m[1]} ${normalizeRoute(m[2])}`),
  );
  const missing = [...routes].filter((r) => !documented.has(r));
  assert.deepEqual(missing, [], "these REST routes exist in src/http.ts and not in Appendix H");
});

// ===========================================================================
// 7. Response-body parity.
//
// Appendix H's success column said `200 {"verdict"}` for a surface that returns
// five members, and `{both versions' lifecycle}` for one that returns six. The
// guard is ONE-WAY on purpose: it fails when the code returns a field the row
// does not name, which is the direction drift travels. The reverse — a row
// naming a field the code never returns — is covered by the suites that assert
// the actual bodies (lifecycle-surfaces, p5-*, provisioning).
// ===========================================================================

/** Field names declared anywhere inside `export interface <name>`, any depth.
 *  An `extends` clause is skipped rather than refused: the fields it inherits
 *  are declared in the parent, which is listed in its own right. */
function interfaceFields(file: string, name: string): string[] {
  const src = read(file);
  const at = src.search(new RegExp(`export interface ${name}(?: extends [A-Za-z0-9_,<> ]+)? \\{`));
  assert.ok(at >= 0, `${file} has no interface ${name}`);
  let depth = 0;
  let i = src.indexOf("{", at);
  const start = i;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = src.slice(start + 1, i);
  return [...new Set([...body.matchAll(/^\s*([a-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]))];
}

/** The Appendix H row whose first tool/number cell matches. */
function appendixHRow(match: string): string {
  const h = SPEC.slice(SPEC.indexOf("## Appendix H."));
  const line = h.split("\n").find((l) => l.startsWith("|") && cells(l).slice(0, 2).includes(match));
  assert.ok(line, `no Appendix H row for ${match}`);
  return line;
}

const RESPONSE_SHAPES: ReadonlyArray<{ row: string; file: string; iface: string }> = [
  { row: "`skill.create`", file: "src/service.ts", iface: "CreateResponse" },
  { row: "`skill.lint`", file: "src/service.ts", iface: "LintResponse" },
  { row: "`skill.review.request`", file: "src/service.ts", iface: "ReviewResponse" },
  { row: "`skill.verify`", file: "src/verified-gate.ts", iface: "VerifyTransitionOutcome" },
  { row: "`skill.verify`", file: "src/verify.ts", iface: "VerifyOutcome" },
  { row: "`skill.search`", file: "src/service.ts", iface: "SearchItem" },
  { row: "`skill.request_adoption`", file: "src/service.ts", iface: "RequestAdoptionResponse" },
  { row: "`skill.adopt`", file: "src/service.ts", iface: "AdoptResponse" },
  { row: "`skill.transfer`", file: "src/transfer.ts", iface: "TransferResponse" },
  { row: "`skill.transfer`", file: "src/transfer.ts", iface: "TransferPermission" },
  { row: "`transfer_grant.create`", file: "src/grants.ts", iface: "GrantView" },
  { row: "`transfer_grant.create`", file: "src/grants.ts", iface: "CreatedGrant" },
  { row: "`transfer_grant.create`", file: "src/grants.ts", iface: "GrantPrincipal" },
  { row: "`transfer_grant.list`", file: "src/grants.ts", iface: "GrantView" },
  { row: "`transfer_grant.list`", file: "src/grants.ts", iface: "GrantPrincipal" },
  { row: "`assignment.activate`", file: "src/service.ts", iface: "AssignmentActionResponse" },
  { row: "`assignment.activate`", file: "src/assignments.ts", iface: "AssignmentView" },
  { row: "`assignment.pause`", file: "src/service.ts", iface: "AssignmentActionResponse" },
  { row: "`assignment.pause`", file: "src/assignments.ts", iface: "AssignmentView" },
  { row: "`assignment.revoke`", file: "src/service.ts", iface: "AssignmentActionResponse" },
  { row: "`assignment.revoke`", file: "src/assignments.ts", iface: "AssignmentView" },
  { row: "`assignment.list`", file: "src/service.ts", iface: "AssignmentListResponse" },
  { row: "`assignment.list`", file: "src/service.ts", iface: "AssignmentCounts" },
  { row: "`assignment.list`", file: "src/service.ts", iface: "NativeInventory" },
  { row: "`skill.validate_outcome`", file: "src/receipts.ts", iface: "AppendResult" },
  { row: "`skill.supersede`", file: "src/service.ts", iface: "SupersedeResponse" },
  { row: "`skill.revoke`", file: "src/service.ts", iface: "RevokeResponse" },
  { row: "`skill.publish`", file: "src/service.ts", iface: "PublishResponse" },
  { row: "`skill.deprecate`", file: "src/service.ts", iface: "DeprecateResponse" },
  { row: "`skill.approve`", file: "src/approvals.ts", iface: "ApprovalResponse" },
  { row: "`principal.create`", file: "src/provision.ts", iface: "CreatedPrincipal" },
  { row: "`principal.list`", file: "src/provision.ts", iface: "PrincipalView" },
  { row: "`principal.issue_api_key`", file: "src/provision.ts", iface: "IssuedApiKey" },
  { row: "`principal.revoke_api_key`", file: "src/provision.ts", iface: "RevokedApiKey" },
  { row: "`signing_key.register`", file: "src/provision.ts", iface: "RegisteredSigningKey" },
  { row: "`signing_key.list`", file: "src/provision.ts", iface: "SigningKeyView" },
  { row: "`signing_key.revoke`", file: "src/provision.ts", iface: "RevokedSigningKey" },
  { row: "`GET /v1/receipts/{id}`", file: "src/service.ts", iface: "ReceiptView" },
  { row: "`tlog.read`", file: "src/tlog.ts", iface: "TlogRow" },
  { row: "`POST /v1/webhooks`", file: "src/webhooks.ts", iface: "RegisteredWebhook" },
  { row: "`migration.count`", file: "src/skill-migrations.ts", iface: "MigrationCountResponse" },
  { row: "`migration.count`", file: "src/skill-migrations.ts", iface: "SkillMigrationCount" },
  { row: "`dashboard.view`", file: "src/dashboard.ts", iface: "DashboardPayload" },
  { row: "`dashboard.view`", file: "src/dashboard.ts", iface: "DashboardSection" },
];

test("Appendix H names every field of every response body the code returns", () => {
  for (const { row, file, iface } of RESPONSE_SHAPES) {
    const line = appendixHRow(row);
    for (const field of interfaceFields(file, iface)) {
      assert.ok(
        line.includes(`"${field}"`),
        `Appendix H row ${row} does not name \`${field}\` of ${iface} (${file})`,
      );
    }
  }
});

// ===========================================================================
// 8. Enumerations the specification restates.
// ===========================================================================

test("every closed enumeration the code owns is restated exactly in SPEC", () => {
  const db = openMigrated();
  const ddlEnum = (table: string, column: string): string[] => {
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }).sql;
    const m = new RegExp(`CHECK\\((?:${column} IS NULL OR )?${column} IN \\(([^)]*)\\)\\)`).exec(sql.replace(/\s+/g, " "));
    assert.ok(m, `no CHECK enum for ${table}.${column}`);
    return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  };

  // §5.1 lifecycle states
  for (const s of ddlEnum("skill_versions", "state")) {
    assert.ok(FLAT.includes(`\`${s}\``), `SPEC never mentions lifecycle state ${s}`);
  }
  // §5.2 delivery states and dead-letter reasons
  const states = ddlEnum("adoption_requests", "state");
  assert.ok(
    FLAT.includes("The states are exactly `approval_pending`, `pending`, `leased`, `pushed` and `dead_letter`;"),
    "§5.2 must restate the delivery states",
  );
  assert.equal(states.length, 5);
  const reasons = ddlEnum("adoption_requests", "dead_letter_reason");
  assert.equal(reasons.length, 5);
  assert.ok(
    FLAT.includes(
      "the dead-letter reasons are exactly `max_attempts`, `stale_lease`, `endpoint_dead`, `approval_denied` and `endpoint_missing`.",
    ),
    "§5.2 must restate the dead-letter reasons",
  );
  // §5.3 receipt events
  assert.deepEqual(
    [...ddlEnum("receipt_events", "event")],
    [...RECEIPT_EVENTS],
    "the receipt_events enum and RECEIPT_EVENTS disagree",
  );
  for (const e of RECEIPT_EVENTS) assert.ok(FLAT.includes(`\`${e}\``), `SPEC never mentions receipt event ${e}`);
  // §7.1 gate names (the lint_reports enum is the same list)
  assert.deepEqual(ddlEnum("lint_reports", "gate"), [...GATE_NAMES], "DDL gate enum ≠ GATE_NAMES");
  db.close();

  // Appendix H's declared search filters
  const conventions = section("## Appendix H.", "| # | MCP tool |");
  const declared = /the declared filter set of surface 5 is exactly (.+?), and they combine with AND;/.exec(conventions);
  assert.ok(declared, "Appendix H must declare the filter set");
  assert.deepEqual(
    declared[1].split(/,| and /).map((s) => s.replace(/`/g, "").trim()).filter(Boolean).sort(),
    [...SEARCH_FILTERS].sort(),
    "Appendix H's filter set ≠ SEARCH_FILTERS",
  );

  // the five dashboard views, named in the row that defines the surface
  const dashRow = appendixHRow("`dashboard.view`");
  for (const v of DASHBOARD_VIEWS) {
    assert.ok(new RegExp(`\\b${v}\\b`).test(dashRow), `Appendix H never names dashboard view ${v}`);
  }
  assert.ok(dashRow.includes(`"views":[the ${NUMBER_WORDS[DASHBOARD_VIEWS.length]} names]`), "the view count must match");
});

test("§7.3's condition ids are exactly the approval matrix's, plus the fail-closed one", () => {
  const matrix = section("| Condition id | Row | Predicate |", "The last table row");
  const ids = [...matrix.matchAll(/^\| `([a-z_]+)` \| /gm)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), APPROVAL_MATRIX.map((c) => c.id).sort(), "§7.3's predicate table ≠ APPROVAL_MATRIX");
  assert.ok(
    FLAT.includes("yields the single pseudo-condition `unreadable_manifest`"),
    "§7.3 must name the fail-closed condition id the code returns",
  );
});

// ===========================================================================
// 9. Appendix G — the normative gate data.
//
// Appendix G exists so two implementations reach the same gate verdict without
// reading each other's source. Nothing asserted that it still matched
// src/gates.ts.
// ===========================================================================

test("Appendix G.1 carries exactly the secret patterns gate 2 applies", () => {
  const g1 = section("### G.1 Gate 2 — key-like secret patterns", "### G.2 ");
  const block = /```\n([\s\S]*?)\n```/.exec(g1);
  assert.ok(block, "G.1 must give the patterns in a fenced block");
  const fromSpec = block[1]
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const m = /^(\S+)\s+(.*)$/.exec(l.trim());
      assert.ok(m, `G.1 line is not "<id> <pattern>": ${l}`);
      return { id: m[1], source: m[2] };
    });
  assert.deepEqual(
    fromSpec,
    SECRET_PATTERNS.map((p) => ({ id: p.id, source: p.re.source })),
    "G.1 and SECRET_PATTERNS disagree",
  );
});

test("Appendix G.2's high-entropy thresholds are the ones the code uses", () => {
  const g2 = section("### G.2 Gate 2 — high-entropy heuristic", "### G.3 ");
  const src = read("src/gates.ts");
  const body = /export function isHighEntropyToken\(token: string\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(body, "isHighEntropyToken not found");
  assert.ok(/token\.length < 40/.test(body[1]) && g2.includes("≥ 40 characters"), "G.2 length threshold");
  assert.ok(/\^\[0-9a-fA-F\]\+\$/.test(body[1]) && g2.includes("`^[0-9a-fA-F]+$`"), "G.2 hex disqualifier");
  assert.ok(/classes < 3/.test(body[1]) && g2.includes("at least 3 of these 4"), "G.2 class count");
  const threshold = /entropyBitsPerChar\(token\) >= ([\d.]+)/.exec(body[1]);
  assert.ok(threshold, "no entropy threshold in the code");
  assert.ok(g2.includes(`≥ ${threshold[1]} bits per character`), `G.2 must state the ${threshold[1]} bit threshold`);
});

test("Appendix G.3's denylist is the code's denylist", () => {
  const g3 = section("### G.3 Gate 4 — URL denylist", "### G.4 ");
  const hosts = /\*\*Shortener hosts\*\* \(configurable; shipped default\): ([\s\S]*?)\n\n/.exec(g3);
  assert.ok(hosts, "G.3 must list the shortener hosts");
  assert.deepEqual(
    ticked(hosts[1]).sort(),
    [...URL_DENYLIST.shortenerHosts].sort(),
    "G.3 and URL_DENYLIST.shortenerHosts disagree",
  );
  assert.ok(g3.includes(`\`${URL_DENYLIST.rawIpHost.source}\``), "G.3 must carry the raw-IP pattern verbatim");
  assert.ok(g3.includes(`not exactly \`${URL_DENYLIST.allowedScheme}\``), "G.3 must name the one admitted scheme");
});

test("Appendix G.4's severity table is SHELL_SEVERITY", () => {
  const g4 = section("### G.4 Gate 5 — shell severity table", "The four opacity classes");
  const rows = [...g4.matchAll(/^\| `([a-z-]+)` \| .*? \| (FAIL|WARN) \|$/gm)].map((m) => ({
    id: m[1],
    severity: m[2].toLowerCase(),
  }));
  assert.deepEqual(rows, SHELL_SEVERITY.map((s) => ({ id: s.id, severity: s.severity })), "G.4 and SHELL_SEVERITY disagree");
});

test("Appendix G.4's wrapper name table is the code's WRAPPERS", () => {
  // The list G.4 prints is the list the chain actually follows. It is a NAME
  // table — the one part of gate 5 that cannot be complete — so the document
  // must not be allowed to describe a different one than the code walks.
  const g4 = section("### G.4 Gate 5 — shell severity table", "For a wrapper whose command argument");
  const listed = /\*\*Wrapper commands\*\* \(name table; shipped default\): ([\s\S]*?)\.\n/.exec(g4);
  assert.ok(listed, "G.4 must print the wrapper name table");
  assert.deepEqual(ticked(listed[1]).sort(), [...WRAPPERS].sort(), "G.4 and WRAPPERS disagree");
});

test("Appendix G.4's privilege-escalation name table is the code's PRIVILEGE_ESCALATORS", () => {
  // The second name table of gate 5, and the one this project got wrong: `su`
  // was absent from the code while the document described the class as `sudo`
  // or `doas`, so document and code agreed with each other and both were
  // narrower than the class they name. A printed list nobody derives from the
  // code can go on agreeing with a hole indefinitely — hence this guard, in the
  // same shape as the wrapper one above.
  const g4 = section("### G.4 Gate 5 — shell severity table", "Two of them — `su` and `runuser`");
  const listed = /\*\*Privilege-escalating commands\*\* \(name table; shipped default\): ([\s\S]*?)\.\n/.exec(g4);
  assert.ok(listed, "G.4 must print the privilege-escalation name table");
  assert.deepEqual(
    ticked(listed[1]).sort(),
    [...PRIVILEGE_ESCALATORS].sort(),
    "G.4 and PRIVILEGE_ESCALATORS disagree",
  );
  // and the severity-table row must name every member, or the row describes a
  // narrower class than the table above it
  const row = /^\| `sudo` \| (.*?) \| FAIL \|$/m.exec(SPEC);
  assert.ok(row, "G.4 must carry the `sudo` severity row");
  for (const name of PRIVILEGE_ESCALATORS) {
    assert.ok(row[1].includes(`\`${name}\``), `the \`sudo\` row must name \`${name}\``);
  }
});

test("Appendix G.5 carries exactly the injection patterns gate 6 applies", () => {
  const g5 = section("### G.5 Gate 6 — prompt-injection patterns", "Gate 6 carries one further rule");
  const block = /```\n([\s\S]*?)\n```/.exec(g5);
  assert.ok(block, "G.5 must give the patterns in a fenced block");
  const fromSpec = block[1]
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const m = /^(\S+)\s+(.*)$/.exec(l.trim());
      assert.ok(m, `G.5 line is not "<id> <pattern>": ${l}`);
      return { id: m[1], source: m[2] };
    });
  assert.deepEqual(
    fromSpec,
    INJECTION_PATTERNS.map((p) => ({ id: p.id, source: p.re.source })),
    "G.5 and INJECTION_PATTERNS disagree",
  );
});

test("Appendix G.6's staleness policy is STALENESS_POLICY", () => {
  const g6 = section("### G.6 Gate 7 — staleness policy", "## Appendix H.");
  const days = STALENESS_POLICY.policyWindowMs / (24 * 3600 * 1000);
  assert.ok(g6.includes(`**Policy window:** ${days} days`), `G.6 must state a ${days}-day window`);

  const deprecated = /\*\*Deprecated upstreams → FAIL, any version:\*\* ([\s\S]*?)\n\n/.exec(g6);
  assert.ok(deprecated, "G.6 must list the deprecated upstreams");
  assert.deepEqual(
    ticked(deprecated[1]).sort(),
    STALENESS_POLICY.deprecated.map((d) => d.id).sort(),
    "G.6 and STALENESS_POLICY.deprecated disagree",
  );

  const eol = [...g6.matchAll(/^\| `([a-z]+)` \| `([\d.]+)` \|$/gm)].map((m) => ({ id: m[1], before: m[2] }));
  assert.deepEqual(eol, STALENESS_POLICY.eol.map((e) => ({ id: e.id, before: e.before })), "G.6 EOL table disagrees");

  const released = [...g6.matchAll(/^\| `([a-z]+@[\d.]+)` \| (\d{4})-(\d{2})-(\d{2}) \|$/gm)].map((m) => ({
    pin: m[1],
    ms: Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4])),
  }));
  assert.deepEqual(
    Object.fromEntries(released.map((r) => [r.pin, r.ms])),
    STALENESS_POLICY.releasedAtMs,
    "G.6 release-date table disagrees with STALENESS_POLICY.releasedAtMs",
  );
});

// ===========================================================================
// 10. §6's ACL matrix and Appendix H's Auth column must agree with each other.
//
// Appendix H said `skill.revoke` was "owner/admin" while the matrix gave the
// row to the author too — and the code follows the matrix. Two normative
// statements of one rule is the defect; this makes them agree.
// ===========================================================================

const ACL_ROWS: ReadonlyArray<{ operation: string; tool: string }> = [
  { operation: "publish (`verified → published`)", tool: "`skill.publish`" },
  { operation: "deprecate", tool: "`skill.deprecate`" },
  { operation: "supersede", tool: "`skill.supersede`" },
  { operation: "revoke", tool: "`skill.revoke`" },
];

test("§6's ACL matrix and Appendix H's Auth column name the same actors", () => {
  const matrix = section("| Operation / resource | Author/skill owner |", "**Error model.**");
  for (const { operation, tool } of ACL_ROWS) {
    const line = matrix.split("\n").find((l) => cells(l)[0] === operation);
    assert.ok(line, `no ACL matrix row for ${operation}`);
    const [, author, memberPlus, reviewer, adminOwner] = cells(line);
    const auth = cells(appendixHRow(tool))[3];

    const admits = (cell: string): boolean => cell !== "—" && !cell.startsWith("never");
    assert.equal(
      /author/i.test(auth),
      admits(author),
      `${tool}: Appendix H ${/author/i.test(auth) ? "admits" : "excludes"} the author, the matrix disagrees`,
    );
    assert.equal(
      /reviewer/i.test(auth),
      admits(reviewer),
      `${tool}: Appendix H and the matrix disagree about the reviewer`,
    );
    assert.ok(admits(adminOwner) && /admin/i.test(auth), `${tool}: admin/owner must be admitted in both`);
    assert.equal(
      /\bmember\b/i.test(auth),
      admits(memberPlus),
      `${tool}: Appendix H and the matrix disagree about a plain member`,
    );
  }
});

// ===========================================================================
// 11. The shipped documentation carries the same inventory.
//
// README's interface table lost `skill.publish` and `skill.deprecate` when
// those surfaces were added: the table is where a reader looks first, and it
// had been silently wrong ever since. Both documents are checked against
// MCP_TOOLS, for the same reason Appendix H is.
// ===========================================================================

test("README.md and docs/API.md name every advertised MCP tool", () => {
  for (const doc of ["README.md", "docs/API.md"]) {
    const text = read(doc);
    for (const { name } of MCP_TOOLS) {
      assert.ok(text.includes(`\`${name}\``), `${doc} never names the MCP tool ${name}`);
    }
  }
});

test("README.md's interface table pairs every MCP tool with its REST route", () => {
  const readme = read("README.md");
  const table = readme.slice(readme.indexOf("| MCP tool | REST |"), readme.indexOf("Provisioning is API-only"));
  const paired = new Set(
    table
      .split("\n")
      .filter((l) => l.startsWith("|"))
      .map((l) => cells(l)[0])
      .filter((c) => /^`[a-z_]+(\.[a-z_]+)+`$/.test(c))
      .map((c) => c.replace(/`/g, "")),
  );
  assert.deepEqual(
    [...paired].sort(),
    MCP_TOOLS.map((t) => t.name).sort(),
    "README's interface table and MCP_TOOLS disagree",
  );
});

// ===========================================================================
// 12. The command line: §2's profile, the help text and both documents.
// ===========================================================================

test("§2, the help text, README and OPERATIONS list the same subcommands", () => {
  const dispatch = read("src/cli-commands.ts");
  const body = /export async function runCli\([\s\S]*?\n\}/.exec(dispatch);
  assert.ok(body, "runCli not found");
  // the canonical name of each subcommand: a `case "x":` that is not an alias
  const subcommands = [...body[0].matchAll(/case "([a-z-]+)":/g)]
    .map((m) => m[1])
    .filter((c) => !c.startsWith("-"));
  assert.deepEqual(subcommands.sort(), ["adapter", "demo", "help", "serve", "verify", "verify-log", "version"]);

  const help = /export const HELP: string = \[([\s\S]*?)\]\.join/.exec(dispatch);
  assert.ok(help, "HELP not found");
  for (const c of subcommands) {
    assert.ok(new RegExp(`"\\s*${c}[ "]`).test(help[1]), `the help text omits \`${c}\``);
    assert.ok(FLAT.includes(`\`${c}`), `SPEC §2 omits \`${c}\``);
    assert.ok(read("docs/OPERATIONS.md").includes(`skillonomia ${c}`), `OPERATIONS.md omits \`${c}\``);
  }
  const word = NUMBER_WORDS[subcommands.length];
  assert.ok(
    read("docs/OPERATIONS.md").includes(`One executable, ${word} subcommands`),
    `OPERATIONS.md must say "${word} subcommands"`,
  );
  assert.ok(
    read("README.md").includes(`the same ${word} commands exist on every packaging path`),
    `README.md must say "${word} commands"`,
  );
});

// ===========================================================================
// 13. §4.2's range profile, exercised rather than restated.
//
// §4.2 said "semver-range" and gave `>=2.0` as its example, and the
// implementation parsed only three-component bounds — so the specification's
// own example was UNMET and blocked adoption at medium and high risk. A partial
// bound is now zero-filled, which is what the example always meant. The grammar
// is written out, and this guard runs it: every row of the table is a claim
// about `satisfies()`, checked by calling it, and every range literal the
// document uses as an example is checked against the grammar itself.
// ===========================================================================

test("§4.2's range table is what compat.ts actually accepts", () => {
  const cases: ReadonlyArray<[string, string, boolean, string]> = [
    ["1.9.9", "*", true, "wildcard"],
    ["1.9.9", "x", true, "wildcard"],
    ["1.9.9", "any", true, "wildcard"],
    ["1.2.3", "1.2.3", true, "exact"],
    ["1.2.4", "1.2.3", false, "exact"],
    ["1.2.3", "=1.2.3", true, "exact"],
    ["2.0.0", ">=1.2.3", true, "comparator"],
    ["1.2.2", ">=1.2.3", false, "comparator"],
    ["1.2.3", ">1.2.3", false, "comparator"],
    ["1.2.3", "<=1.2.3", true, "comparator"],
    ["1.2.3", "<1.2.3", false, "comparator"],
    ["1.9.0", "^1.2.3", true, "caret keeps the major"],
    ["2.0.0", "^1.2.3", false, "caret keeps the major"],
    ["1.2.2", "^1.2.3", false, "caret is not below the bound"],
    ["0.2.9", "^0.2.3", true, "caret below 1.0.0 keeps the minor"],
    ["0.3.0", "^0.2.3", false, "caret below 1.0.0 keeps the minor"],
    ["1.2.9", "~1.2.3", true, "tilde keeps major and minor"],
    ["1.3.0", "~1.2.3", false, "tilde keeps major and minor"],
    ["1.0.0-rc1", ">=1.0.0", true, "a prerelease does not order below its release"],
    ["2.5.0", "  >=2.0.0  ", true, "surrounding whitespace is stripped"],
    ["2.5", ">=1.0.0", false, "an unparseable adopter version is unmet"],
    ["1.0.0", "1.x", false, "no partial-wildcard form"],
    ["1.0.0", ">=1.0.0 <2.0.0", false, "no compound ranges"],
    ["1.0.0", "1.0.0 || 2.0.0", false, "no union ranges"],

    // partial bounds are zero-filled — the defect this row set was written for
    ["2.5.0", ">=2.0", true, "a two-component bound is >=2.0.0"],
    ["2.5.0", ">=2", true, "a one-component bound is >=2.0.0"],
    ["2.0.0", ">=2.0", true, "the bound itself satisfies >="],
    ["1.9.9", ">=2.0", false, "and below it does not"],
    ["2.0.0", ">2.0", false, "strict comparison of the zero-filled bound"],
    ["2.0.1", ">2.0", true, "strict comparison of the zero-filled bound"],
    ["1.9.9", "<2", true, "a one-component upper bound"],
    ["2.0.0", "<2", false, "a one-component upper bound"],
    ["2.0.0", "<=2.0", true, "a two-component upper bound"],
    ["2.0.1", "<=2.0", false, "a two-component upper bound"],
    ["2.0.0", "=2.0", true, "an equality bound is the zero-filled version"],
    ["2.0.1", "=2.0", false, "an equality bound is the zero-filled version"],
    ["2.0.0", "2", true, "a bare partial is an equality bound"],
    ["1.9.0", "^1", true, "^1 is ^1.0.0 — the same major"],
    ["2.0.0", "^1", false, "^1 is ^1.0.0 — the same major"],
    ["1.2.9", "^1.2", true, "^1.2 is ^1.2.0"],
    ["0.2.9", "^0.2", true, "below 1.0.0 the caret keeps the minor"],
    ["0.3.0", "^0.2", false, "below 1.0.0 the caret keeps the minor"],
    ["1.2.9", "~1.2", true, "~1.2 is ~1.2.0 — major and minor fixed"],
    ["1.3.0", "~1.2", false, "~1.2 is ~1.2.0 — major and minor fixed"],
    ["2.0.9", "~2", true, "zero-fill first, rule second: ~2 is ~2.0.0"],
    ["2.1.0", "~2", false, "zero-fill first, rule second: ~2 fixes the minor too"],
  ];
  for (const [version, range, expected, why] of cases) {
    assert.equal(satisfies(version, range), expected, `satisfies(${version}, ${JSON.stringify(range)}) — ${why}`);
  }

  // and an empty matcher list satisfies nothing (§4.2's closing sentence)
  const empty = checkCompatibility(
    { runtime: { os: ["linux"], shell: ["bash"], runtime_compat: [], model_compat: [{ id: "any", range: "*" }] },
      procedure: { tools_used: [] } },
    { os: "linux", shell: "bash", runtime: { id: "node", version: "22.0.0" }, model: { id: "m", version: "1.0.0" }, tools: [] },
  );
  assert.deepEqual(empty.unmet, ["runtime"], "an empty matcher list is unmet, and the clause order is fixed");
  assert.equal(empty.result, "mismatch");

  // the specification must carry every form this test exercises
  const profile = section("*Range profile (normative).*", "- **Procedure:**");
  for (const form of ["`*`, `x`, `any`", "`1.2.3` or `=1.2.3`", "`>=1.2.3`", "`^1.2.3`", "`~1.2.3`"]) {
    assert.ok(profile.includes(form), `§4.2's range table omits ${form}`);
  }
  const flatProfile = profile.replace(/\s+/g, " ");
  assert.ok(
    flatProfile.includes("`>=2` and `>=2.0` both mean `>=2.0.0`"),
    "§4.2 must state that a partial bound is zero-filled",
  );
  assert.ok(
    flatProfile.includes("Zero-filling happens BEFORE the form's rule is applied"),
    "§4.2 must fix the order of zero-fill and the form's rule, which is what makes `~2` decidable",
  );
  // the V1 divergences are stated as divergences, not left to be discovered
  assert.ok(
    flatProfile.includes("DIVERGES from semver 2.0.0 precedence deliberately"),
    "§4.2 must say the prerelease rule diverges from semver, not merely that it is simple",
  );
  assert.ok(
    flatProfile.includes("A compound or union range — `>=1.0.0 <2.0.0`, `1.0.0 || 2.0.0` — is not a form of this profile"),
    "§4.2 must name the compound forms it refuses, since refusing them BLOCKS at medium/high risk",
  );

  // EVERY range literal the document uses as an example must be a form of the
  // grammar. This is what the old "the example must not be `>=2.0`" assertion
  // was reaching for: the failure it caught was the document demonstrating a
  // range the implementation treats as unmet.
  const literals = [...SPEC.matchAll(/"range"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(literals.length >= 4, `only ${literals.length} range literals found in SPEC — the scan is broken`);
  for (const r of literals) {
    assert.ok(isRange(r), `SPEC uses \`${r}\` as an example range, and §4.2's grammar does not accept it`);
  }
});

// ===========================================================================
// 14. §5.1's `verified` conjunction.
//
// The four conjuncts are named in Appendix H row 4 (guard 7 already checks
// those ids against the code) and COUNTED in §5.1. This ties the count and the
// names together, so a fifth conjunct cannot appear in one place only.
// ===========================================================================

test("§5.1 counts and Appendix H names the same set of verified-gate conjuncts", () => {
  const union = /export type VerifiedConjunct =([\s\S]*?);/.exec(read("src/verified-gate.ts"));
  assert.ok(union, "VerifiedConjunct union not found");
  const ids = [...union[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2, "the union scan is broken");

  const word = NUMBER_WORDS[ids.length];
  assert.ok(
    FLAT.includes(`**The gate for \`verified\` is a conjunction of exactly ${word} conditions**`),
    `§5.1 must say "exactly ${word} conditions"`,
  );
  const gate = section("**The gate for `verified` is a conjunction", "`published` additionally requires");
  const numbered = [...gate.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbered, ids.map((_, i) => i + 1), `§5.1 must number ${ids.length} conjuncts with no gap`);

  const row = appendixHRow("`skill.verify`");
  for (const id of ids) assert.ok(new RegExp(`\\b${id}\\b`).test(row), `Appendix H row 4 omits the conjunct id ${id}`);
});

// ===========================================================================
// 15. §5.2 rule 4 — the outbound address filter.
//
// The rule read as a summary ("private", "documentation ranges") while
// src/transport.ts refuses three ranges the summary never named. A registry
// that connects where an adopter points it is the one place a summary is not
// good enough, so the table is now exhaustive and this guard keeps it that
// way — from the refusal REASONS the code emits, which each name their range.
// ===========================================================================

test("§5.2's forbidden-address table names every range the transport refuses", () => {
  const src = read("src/transport.ts");
  const fns = /function blockedIpv4[\s\S]*?\n}\n[\s\S]*?function blockedIpv6[\s\S]*?\n}\n/.exec(src);
  assert.ok(fns, "the two address classifiers were not found");
  const ranges = new Set<string>();
  for (const m of fns[0].matchAll(/return "([^"]+)"/g)) {
    for (const cidr of m[1].matchAll(/(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})|(?:[0-9a-f]{0,4}(?::{1,2}[0-9a-f]{0,4})+\/\d{1,3})/g)) {
      ranges.add(cidr[0]);
    }
    if (/unspecified ::$/.test(m[1])) ranges.add("::");
    if (/loopback ::1$/.test(m[1])) ranges.add("::1");
  }
  assert.ok(ranges.size >= 20, `only ${ranges.size} ranges found in the classifiers — the scan is broken`);

  const rule4 = section("4. **Every resolved address is checked", "5. **The connection MUST go");
  for (const r of ranges) {
    assert.ok(rule4.includes(`\`${r}\``), `§5.2 rule 4 does not name the forbidden range ${r}`);
  }

  // and the rule is a rule, not only a table: one representative per family,
  // plus a public address that must pass
  const mustBlock = [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1",
    "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fd00:ec2::254", "fe80::1", "ff02::1", "100::1", "2001:db8::1",
    "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1",
  ];
  for (const a of mustBlock) assert.ok(blockedReason(a) !== null, `${a} must be refused`);
  for (const a of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:93.184.216.34"]) {
    assert.equal(blockedReason(a), null, `${a} is a public address and must be permitted`);
  }
  // an interface scope never changes which host an address names
  assert.equal(blockedReason("fe80::1%eth0"), blockedReason("fe80::1"));
});

// ===========================================================================
// 16. The two `--json` envelopes of the command line.
//
// §2 said "the outcome envelope" for both subcommands. They are two different
// envelopes, and `verify-log` adds a field neither §2 nor Appendix H named.
// ===========================================================================

test("§2 names every field of both CLI --json envelopes", () => {
  const cli = section("The registry database of `verify` and `verify-log`", "**Exit codes are three-valued");
  for (const field of interfaceFields("src/verify.ts", "VerifyOutcome")) {
    assert.ok(cli.includes(`"${field}"`), `§2 does not name \`${field}\` of the verify envelope`);
  }
  for (const field of interfaceFields("src/tlog.ts", "VerifyResult")) {
    assert.ok(cli.includes(`"${field}"`), `§2 does not name \`${field}\` of the verify-log envelope`);
  }
  // …and the one field the command adds on top of that outcome
  const added = /io\.out\(JSON\.stringify\(\{ \.\.\.res, ([a-z_]+): /.exec(read("src/cli-commands.ts"));
  assert.ok(added, "verify-log's --json line no longer spreads its outcome plus one field");
  assert.ok(cli.includes(`"${added[1]}"`), `§2 does not name the extra \`${added[1]}\` field verify-log prints`);
});

// ===========================================================================
// 17. The declared environment, and the boundary of an idempotent repeat.
//
// This one is a parity guard because the DOCUMENT is half of the fix. The
// specification described `skill.adopt` as answering a repeat with `noop:true`
// and a package, which is what the implementation did and what let a late
// caller collect an archive for an adoption that never happened — and, worse,
// let an invented runtime id be written over a closed adoption's environment,
// raising a release counter that read from that column.
//
// So four things have to stay true together, and each is checked against the
// code rather than restated: the declared environment is written to the
// INSERT-only event rather than to the mutable request row; the counter does
// not read the mutable column; the response has no `noop` member to hide a
// refusal in; and the sentence that grants a byte-for-byte repeat says IN THE
// SAME BREATH what bounds it.
// ===========================================================================

test("the declared environment lives on the event, in the document and in the code", () => {
  const insert = /INSERT INTO receipt_events\(([\s\S]*?)\)/.exec(read("src/receipts.ts"));
  assert.ok(insert, "the receipt-event INSERT was not found — this guard is reading the wrong thing");
  assert.ok(
    /\benvironment_json\b/.test(insert[1]),
    "the declared environment must be written to the INSERT-only event, not to the mutable request row",
  );

  // …and the denormalized copy on the mutable request row is written only
  // AFTER that event exists, so it can never hold a descriptor belonging to a
  // caller whose adoption did not happen.
  const service = read("src/service.ts");
  const event = service.indexOf('environment: { environment_descriptor: descriptor }');
  const cache = service.indexOf('UPDATE adoption_requests SET requester_context_json=?');
  assert.ok(event > 0 && cache > 0, "the adopt path was not found — this guard is reading the wrong thing");
  assert.ok(
    event < cache,
    "the mutable request row is written before the INSERT-only event — that ordering is what made the declaration forgeable",
  );

  assert.ok(
    FLAT.includes("**The declared environment lives on the event, and this is a defence of the release gate rather than a matter of tidy writing.**"),
    "§5.3 must present the rule as a defence of the acceptance figure, not as write hygiene",
  );
  assert.ok(
    FLAT.includes("A registry MUST NOT compute this conjunct from `adoption_requests.requester_context_json`"),
    "§5.3 must forbid counting the gate from the mutable column by name",
  );
});

test("the migration counters are computed from the journal, in the document and in the code", () => {
  // The query used to live in the release gate. It is now the SHIPPED
  // counter's, and the gate calls it — so this guard follows it there, and the
  // rule it enforces now protects a product surface as well as the acceptance
  // figure.
  const counter = read("src/skill-migrations.ts");
  const query = /function selectPairs\([\s\S]*?\.all\(\.\.\.params\)/.exec(counter);
  assert.ok(query, "the counting query was not found — this guard is reading the wrong thing");
  assert.ok(
    !/requester_context_json/.test(query[0]),
    "the migration counter reads `requester_context_json` again — that column is mutable and the figure was forgeable through it",
  );
  assert.ok(/receipt_events/.test(query[0]) && /environment_json/.test(query[0]), "it must read the delivered events");

  assert.ok(
    FLAT.includes("**The declared environment lives on the event, and this is a defence of the release gate rather than a matter of tidy writing.**"),
    "§5.3 must present the rule as a defence of the acceptance figure, not as write hygiene",
  );
  assert.ok(
    FLAT.includes("A registry MUST NOT compute this conjunct from `adoption_requests.requester_context_json`"),
    "§5.3 must forbid counting the gate from the mutable column by name",
  );
});

test("surface 7 grants the byte-for-byte repeat and bounds it in the same sentence", () => {
  const row = appendixHRow("`skill.adopt`");
  const sentences = row.split(". ");
  const grant = sentences.find((s) => s.includes("byte for byte"));
  assert.ok(grant, "Appendix H must state that a repeat returns the original bytes");
  assert.ok(
    grant.includes("SAME principal") && grant.includes("SAME `idempotency_key`"),
    "…and the SAME sentence must say what a repeat IS, or the grant reads as a property of the response",
  );
  assert.ok(
    grant.includes("never a match of state"),
    "…including the half that is easy to get wrong: state is not what identifies a repeat",
  );
  assert.ok(
    row.includes("`PRECONDITION_FAILED{current_state}` and NO package"),
    "Appendix H must give a late caller the same refusal the receipt surface gives",
  );

  // and the code has no `noop` shape left for a refusal to hide in
  assert.ok(
    !interfaceFields("src/service.ts", "AdoptResponse").includes("noop"),
    "AdoptResponse grew a `noop` member again",
  );
  assert.ok(!row.includes('"noop":true'), "Appendix H's surface-7 row promises a `noop` the code does not return");
});
