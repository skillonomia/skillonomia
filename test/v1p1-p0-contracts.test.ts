// P0 — THE CONTRACTS, EXERCISED.
//
// A contract that is only a TypeScript type is a contract nothing can be held
// to: types erase, and a build that ships a payload the type forbids compiles
// and runs. So every vocabulary in `src/console-v2.ts`, `src/lifecycle-v11.ts`
// and `src/cli-authoring-contract.ts` is a runtime value, and this file is what
// runs them — against each other, against the migration that enforces the same
// rules from below, and against the frozen record of what v1.0.0 promised.
//
// THE THREE CLASSES OF CHECK HERE, and why each is a class rather than a case:
//
//   1. AGREEMENT BETWEEN TWO SOURCES. Wherever one rule is stated twice —
//      the linkable states in a constant and in a trigger, the slug grammar in
//      the CLI and in the service, the eleven views in the console contract and
//      in the dashboard — the two are compared. Two statements of one rule that
//      nothing compares is how this project's inventories drifted in v1.0.0.
//   2. A VALIDATOR ACCEPTS AND REFUSES. Every validator is given a body it must
//      accept and, for each rule it holds, a body it must refuse WITH THE
//      POINTER at the member that is wrong. A validator tested only on valid
//      input is a validator that could `return []`.
//   3. BACKWARD COMPATIBILITY, from a fixture rather than from reading. The
//      v1.0.0 response members are frozen in `fixtures/v1.0-compat/`, the real
//      surfaces are driven, and the two are compared both ways: a member that
//      disappeared fails, and so does one that appeared without being written
//      down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONSOLE_CONTRACT_V2,
  CONSOLE_VIEWS,
  isConsoleView,
  isConsoleV2,
  assertConsoleContract,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  APPROVAL_STATUS_FILTERS,
  APPROVAL_KIND_FILTERS,
  DECIDED_STATUSES,
  CONSEQUENCE_SCOPES,
  SCOPE_OF_KIND,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  inboxItemId,
  parseInboxItemId,
  compareInboxItems,
  encodeInboxCursor,
  decodeInboxCursor,
  validateConsoleReview,
  validateConsoleApproval,
  HUMAN_DECISION_LABELS,
  FORBIDDEN_DECISION_LABELS,
  CONSOLE_SESSION_ROLES,
  REVIEWER_VISIBLE_KINDS,
} from "../src/console-v2.ts";
import {
  LINEAGE_LINKABLE_STATES,
  SUCCESSOR_ELIGIBLE_STATES,
  REVOCATION_REASON_MAX,
  LIFECYCLE_TLOG_ORDER,
  revokeRequestDigest,
  supersedeRequestDigest,
  REGISTRY_VERIFICATION_PATH,
} from "../src/lifecycle-v11.ts";
import {
  CLI_SLUG_RE,
  isValidSlug,
  RISK_LEVELS,
  isRiskLevel,
  SOURCE_PROFILE,
  SERVER_OWNED_MANIFEST_MEMBERS,
  ALREADY_PACKED_MARKERS,
  AUTHORING_SUBCOMMANDS,
  FINDING_SEVERITIES,
  validateExitCode,
  isValidateOk,
  HIGH_RISK_REQUIRED_APPROVALS,
  isGeneratedGateId,
  WEBHOOK_LOOPBACK_FLAG,
  type SourceFinding,
} from "../src/cli-authoring-contract.ts";
import { CONSOLE_CONTRACT_VERSION } from "../src/console-view.ts";
import { DASHBOARD_VIEWS } from "../src/dashboard.ts";
import { TRANSITION_WHITELIST, REVOCABLE_STATES, transitionVersion, type VersionState } from "../src/transitions.ts";
import { openMigrated } from "../src/db.ts";
import { p4Fixture, publishedVersion, verifiableVersion } from "./p4-helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPAT = JSON.parse(
  readFileSync(join(ROOT, "fixtures", "v1.0-compat", "lifecycle-responses.json"), "utf8"),
) as any;

// ===========================================================================
// P0-FR-04 — Console v2 successes and errors are versioned
// ===========================================================================

test("[P0.C1] `console.v2` is a NEW version beside `console.v1`, not a rename of it", () => {
  assert.equal(CONSOLE_CONTRACT_V2, "console.v2");
  assert.equal(CONSOLE_CONTRACT_VERSION, "console.v1", "the v1.0.0 console contract must keep its own name");
  assert.notEqual(CONSOLE_CONTRACT_V2, CONSOLE_CONTRACT_VERSION);
  assert.equal(COMPAT.console_contract.v1_0_0, CONSOLE_CONTRACT_VERSION);
  assert.equal(COMPAT.console_contract.v1_1_0, CONSOLE_CONTRACT_V2);
});

test("[P0.C2] a bundle REFUSES a payload it was not built for — including the previous version", () => {
  assert.equal(isConsoleV2({ contract: CONSOLE_CONTRACT_V2, view: "library" }), true);
  // the three shapes an over-permissive reader waves through
  for (const bad of [
    { contract: "console.v1" },
    { contract: "console.v3" },
    { view: "library" },
    null,
    "console.v2",
  ]) {
    assert.equal(isConsoleV2(bad), false, `accepted ${JSON.stringify(bad)}`);
    assert.throws(() => assertConsoleContract(bad), /console\.v2/);
  }
  // and the refusal SAYS what it got, or an operator cannot tell an old server
  // from a proxy that mangled the body
  assert.throws(() => assertConsoleContract({ contract: "console.v1" }), /console\.v1/);
});

test("[P0.C3] the eleven Console views ARE the dashboard's views — not a second list", () => {
  assert.deepEqual([...CONSOLE_VIEWS], [...DASHBOARD_VIEWS]);
  assert.equal(CONSOLE_VIEWS.length, 11, "the confirmed gap was eleven views the Console did not show");
  for (const v of DASHBOARD_VIEWS) assert.ok(isConsoleView(v));
  for (const bad of ["", "Library", "dead_letter", "outcome", 7, null]) {
    assert.equal(isConsoleView(bad), false, `accepted ${JSON.stringify(bad)} as a view`);
  }
});

// ===========================================================================
// The Inbox vocabulary and its projection rules
// ===========================================================================

test("[P0.C4] the Inbox vocabularies are closed, and `decided` is DERIVED from the statuses", () => {
  assert.deepEqual([...APPROVAL_KINDS], ["review", "publish", "adopt_high_risk"]);
  assert.deepEqual([...APPROVAL_STATUSES], ["pending", "approved", "denied", "conditional"]);
  assert.deepEqual([...APPROVAL_STATUS_FILTERS], ["pending", "decided", "all"]);
  assert.deepEqual([...APPROVAL_KIND_FILTERS], [...APPROVAL_KINDS, "all"]);

  // `decided` is every status that is not `pending`, computed rather than typed:
  // a status added later is decided by default, which is the safe direction —
  // an item wrongly shown in a decided list is visible, one wrongly hidden is
  // not.
  assert.deepEqual([...DECIDED_STATUSES], APPROVAL_STATUSES.filter((s) => s !== "pending"));
  assert.ok(!DECIDED_STATUSES.includes("pending" as never));
  // `decided` is a FILTER and never a status an item can hold
  assert.ok(!(APPROVAL_STATUSES as readonly string[]).includes("decided"));
});

test("[P0.C5] every kind has exactly one consequence scope, and the three scopes are distinct", () => {
  assert.deepEqual(Object.keys(SCOPE_OF_KIND).sort(), [...APPROVAL_KINDS].sort());
  const scopes = Object.values(SCOPE_OF_KIND);
  assert.equal(new Set(scopes).size, scopes.length, "two kinds share a scope — the decisions are not distinguishable");
  for (const s of scopes) assert.ok((CONSEQUENCE_SCOPES as readonly string[]).includes(s));
  // the load-bearing one: a high-risk approval is spent on ONE request
  assert.equal(SCOPE_OF_KIND.adopt_high_risk, "one_adoption_request");
});

test("[P0.C6] an item id round-trips, and an id whose kind is not one of the three is not an item id", () => {
  for (const kind of APPROVAL_KINDS) {
    const id = inboxItemId(kind, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.deepEqual(parseInboxItemId(id), { kind, subject_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
  }
  for (const bad of ["", ":x", "review:", "approve:x", "review", 7, null, "REVIEW:x"]) {
    assert.equal(parseInboxItemId(bad), null, `parsed ${JSON.stringify(bad)}`);
  }
  // a subject that itself contains the separator keeps every character after
  // the FIRST one, or an id would not round-trip
  assert.deepEqual(parseInboxItemId("review:a:b"), { kind: "review", subject_id: "a:b" });
});

test("[P0.C7] the order is TOTAL, and the cursor carries exactly the sort key", () => {
  const items = [
    { updated_at_ms: 100, item_id: "review:b" },
    { updated_at_ms: 200, item_id: "publish:a" },
    { updated_at_ms: 100, item_id: "review:a" },
  ];
  assert.deepEqual(
    [...items].sort(compareInboxItems).map((i) => i.item_id),
    ["publish:a", "review:a", "review:b"],
    "newest first, then item_id ascending",
  );
  // totality: no pair compares equal unless it IS the same pair, which is what
  // makes a fixture reproducible between runs and between query plans
  for (const a of items) {
    for (const b of items) {
      if (a === b) assert.equal(compareInboxItems(a, b), 0);
      else assert.notEqual(compareInboxItems(a, b), 0, `${a.item_id} and ${b.item_id} compare equal`);
    }
  }
  for (const i of items) assert.deepEqual(decodeInboxCursor(encodeInboxCursor(i)), i);
  for (const bad of ["", "!!!", "bm90LWEtY3Vyc29y", 7, null]) {
    assert.equal(decodeInboxCursor(bad), null, `decoded ${JSON.stringify(bad)}`);
  }
  assert.ok(INBOX_DEFAULT_LIMIT < INBOX_MAX_LIMIT && INBOX_MAX_LIMIT === 200 && INBOX_DEFAULT_LIMIT === 50);
});

// ===========================================================================
// The mutation validators — accepted, and refused with a pointer
// ===========================================================================

test("[P0.C8] the review body: a verdict is required to give one and forbidden to ask for one", () => {
  assert.deepEqual(validateConsoleReview({ action: "request" }), []);
  assert.deepEqual(validateConsoleReview({ action: "verdict", verdict: "approve", note: "ok" }), []);
  assert.deepEqual(validateConsoleReview({ action: "verdict", verdict: "conditional" }), []);

  const noVerdict = validateConsoleReview({ action: "verdict" });
  assert.deepEqual(noVerdict.map((v) => v.pointer), ["/verdict"]);
  // asking for a review WHILE carrying a verdict is ambiguous, not redundant:
  // a caller that got no error would believe the verdict was recorded
  const both = validateConsoleReview({ action: "request", verdict: "approve" });
  assert.deepEqual(both.map((v) => v.pointer), ["/verdict"]);
  assert.deepEqual(validateConsoleReview({ action: "approve" }).map((v) => v.pointer), ["/action"]);
  assert.deepEqual(validateConsoleReview({}).map((v) => v.pointer), ["/action"]);
  // bounded text, both members
  assert.deepEqual(validateConsoleReview({ action: "request", note: "x".repeat(2001) }).map((v) => v.pointer), ["/note"]);
  assert.deepEqual(
    validateConsoleReview({ action: "request", idempotency_key: "k".repeat(129) }).map((v) => v.pointer),
    ["/idempotency_key"],
  );
  for (const v of validateConsoleReview({})) assert.equal(v.code, "INVALID_SCHEMA");
});

test("[P0.C9] the approval body binds a high-risk decision to ONE request, and refuses to bind a publish to any", () => {
  assert.deepEqual(
    validateConsoleApproval({ scope: "adopt_high_risk", decision: "approved", adoption_request_id: "01ARZ3ND" }),
    [],
  );
  assert.deepEqual(validateConsoleApproval({ scope: "publish", decision: "denied" }), []);

  // REQUIRED for adopt_high_risk — this is what makes an approval non-reusable
  assert.deepEqual(
    validateConsoleApproval({ scope: "adopt_high_risk", decision: "approved" }).map((v) => v.pointer),
    ["/adoption_request_id"],
  );
  assert.deepEqual(
    validateConsoleApproval({ scope: "adopt_high_risk", decision: "approved", adoption_request_id: "" }).map((v) => v.pointer),
    ["/adoption_request_id"],
  );
  // FORBIDDEN for publish — the other half, and the one a lenient validator
  // drops, leaving a request id on a decision it does not bind
  assert.deepEqual(
    validateConsoleApproval({ scope: "publish", decision: "approved", adoption_request_id: "01ARZ3ND" }).map((v) => v.pointer),
    ["/adoption_request_id"],
  );
  assert.deepEqual(validateConsoleApproval({ scope: "review", decision: "approved" }).map((v) => v.pointer).sort(), ["/scope"]);
  assert.deepEqual(validateConsoleApproval({ scope: "publish", decision: "yes" }).map((v) => v.pointer), ["/decision"]);
});

test("[P0.C10] the four human decision labels are exact, and none of the bare ones is among them", () => {
  assert.deepEqual(Object.values(HUMAN_DECISION_LABELS), [
    "Approve this adoption",
    "Deny this adoption",
    "Approve publication",
    "Deny publication",
  ]);
  // Each names the OBJECT and the ACT. A label that named neither would pass a
  // "is it non-empty" check, which is why the property tested is membership in
  // an exact set and not a shape.
  for (const label of Object.values(HUMAN_DECISION_LABELS)) {
    assert.ok(!FORBIDDEN_DECISION_LABELS.includes(label));
    assert.ok(/^(Approve|Deny) /.test(label), `${label} does not begin with the act`);
  }
  assert.deepEqual([...FORBIDDEN_DECISION_LABELS], ["Confirm", "OK", "Yes", "Submit"]);
});

test("[P0.C11] a Console session admits three roles, and admitting the reviewer widens nothing", () => {
  assert.deepEqual([...CONSOLE_SESSION_ROLES], ["owner", "admin", "reviewer"]);
  // the closure: a reviewer session may ask the Inbox for reviews and for
  // nothing else — not another kind, and not `all`
  assert.deepEqual([...REVIEWER_VISIBLE_KINDS], ["review"]);
  for (const kind of APPROVAL_KIND_FILTERS) {
    if (kind === "review") continue;
    assert.ok(!REVIEWER_VISIBLE_KINDS.includes(kind), `a reviewer must not see ${kind}`);
  }
});

// ===========================================================================
// The lifecycle contract, against the migration and the whitelist
// ===========================================================================

test("[P0.C12] the state sets in the contract are the state sets in the migration", () => {
  const sql = readFileSync(
    join(ROOT, "migrations", "0018_a_revocation_and_a_replacement_are_two_facts.sql"),
    "utf8",
  );
  // The trigger names the linkable states in a `NOT IN (…)` list. Read it out of
  // the file rather than trusting that somebody kept the two in step: this is
  // the one rule that is genuinely stated twice, in TypeScript and in SQL, and
  // the whole point of reading it here is that the copy cannot drift.
  const linkable = /NEW\.state NOT IN \(([^)]*)\)/.exec(sql);
  assert.ok(linkable, "the migration no longer states the linkable states in the shape this guard reads");
  assert.deepEqual(
    linkable[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort(),
    [...LINEAGE_LINKABLE_STATES].sort(),
    "LINEAGE_LINKABLE_STATES and the migration disagree",
  );
  const successor = /WHERE s\.id=NEW\.superseded_by_version_id\)\s*\n?\s*NOT IN \(([^)]*)\)/.exec(sql);
  assert.ok(successor, "the migration no longer states the successor-eligible states in the shape this guard reads");
  assert.deepEqual(
    successor[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort(),
    [...SUCCESSOR_ELIGIBLE_STATES].sort(),
    "SUCCESSOR_ELIGIBLE_STATES and the migration disagree",
  );
  // and both sets are real states of the column
  const db = openMigrated();
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='skill_versions'").get() as { sql: string }).sql;
  db.close();
  for (const s of [...LINEAGE_LINKABLE_STATES, ...SUCCESSOR_ELIGIBLE_STATES]) {
    assert.ok(ddl.includes(`'${s}'`), `${s} is not a state of skill_versions.state`);
  }
});

test("[P0.C13] `REVOCABLE_STATES` is the whitelist read backwards, and never a second list", () => {
  const fromGraph = (Object.keys(TRANSITION_WHITELIST) as VersionState[]).filter((from) =>
    TRANSITION_WHITELIST[from].includes("revoked"),
  );
  assert.deepEqual([...REVOCABLE_STATES], fromGraph);
  assert.deepEqual([...REVOCABLE_STATES].sort(), ["deprecated", "published", "superseded"]);
  // the fixture records the edge change as a change, so a later removal is loud
  assert.deepEqual(COMPAT.lifecycle_states.v1_1_0_added_edges, ["deprecated>revoked", "superseded>revoked"]);
  assert.deepEqual(COMPAT.lifecycle_states.v1_1_0_removed_edges, []);
  const edges: string[] = [];
  for (const from of Object.keys(TRANSITION_WHITELIST) as VersionState[]) {
    for (const to of TRANSITION_WHITELIST[from]) edges.push(`${from}>${to}`);
  }
  assert.deepEqual(
    edges.sort(),
    [...COMPAT.lifecycle_states.v1_0_0_edges, ...COMPAT.lifecycle_states.v1_1_0_added_edges].sort(),
    "the live graph is not the frozen v1.0 graph plus exactly the recorded additions",
  );
});

test("[P0.C14] no generic transition reaches `revoked` — the two new inbound edges do not open a back door", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "p0-no-generic-revoke");
  const res = transitionVersion(fx.db, v.versionId, "revoked");
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "USE_REVOKE_VERSION");
  // …and nothing moved, which is the half that matters: a refusal that had
  // already written the state would be a bypass with a polite error
  const after = fx.db.prepare("SELECT state, revocation_reason FROM skill_versions WHERE id=?").get(v.versionId) as
    { state: string; revocation_reason: string | null };
  assert.equal(after.state, "published");
  assert.equal(after.revocation_reason, null);
  fx.db.close();
});

test("[P0.C15] the revoke digest is sensitive to what a repeat must differ on, and blind to what it must not", () => {
  const base = { version_id: "V1", reason: "leaks a token" };
  const d = revokeRequestDigest(base);
  assert.match(d, /^[0-9a-f]{64}$/);
  // stable across calls — otherwise a legitimate replay is a CONFLICT
  assert.equal(revokeRequestDigest(base), d);
  // an ABSENT successor and an explicit null are the same request
  assert.equal(revokeRequestDigest({ ...base, successor_version_id: null }), d);
  // …and everything else is a different request
  assert.notEqual(revokeRequestDigest({ ...base, successor_version_id: "V2" }), d);
  assert.notEqual(revokeRequestDigest({ ...base, reason: "leaks a token." }), d);
  assert.notEqual(revokeRequestDigest({ ...base, version_id: "V2" }), d);
  // THE REASON IS NOT NORMALISED. Two reasons a boundary accepted as different
  // strings must stay two requests: folding them would replay one caller's
  // response to another caller's revocation.
  assert.notEqual(revokeRequestDigest({ ...base, reason: " leaks a token" }), d);
  assert.notEqual(revokeRequestDigest({ ...base, reason: "Leaks a token" }), d);

  // supersede: the pair is ORDERED, because supersede(A,B) and supersede(B,A)
  // are different calls with different outcomes
  const ab = supersedeRequestDigest({ predecessor_version_id: "A", successor_version_id: "B" });
  const ba = supersedeRequestDigest({ predecessor_version_id: "B", successor_version_id: "A" });
  assert.notEqual(ab, ba);
  assert.equal(supersedeRequestDigest({ predecessor_version_id: "A", successor_version_id: "B" }), ab);
});

test("[P0.C16] the two lifecycle log entries have a fixed order and the reason has a stated bound", () => {
  assert.deepEqual([...LIFECYCLE_TLOG_ORDER], ["version_revoked", "version_superseded"]);
  assert.equal(REVOCATION_REASON_MAX, 2000);
  // the bound the shipped v1.0.0 surface already enforces, so the constant is
  // the same number and not a second opinion
  const service = readFileSync(join(ROOT, "src", "service.ts"), "utf8");
  assert.ok(
    service.includes(`reason.length > ${REVOCATION_REASON_MAX}`),
    "the revoke surface bounds the reason at a different number than the contract states",
  );
  assert.ok(REGISTRY_VERIFICATION_PATH.includes("{skill_version_id}"));
});

// ===========================================================================
// The CLI contract
// ===========================================================================

test("[P0.C17] the CLI checks the SAME slug grammar the registry checks", () => {
  const service = readFileSync(join(ROOT, "src", "service.ts"), "utf8");
  const serverRe = /const SLUG_RE = (\/[^;]+\/);/.exec(service);
  assert.ok(serverRe, "src/service.ts no longer declares SLUG_RE in the shape this guard reads");
  assert.equal(
    serverRe[1],
    CLI_SLUG_RE.toString(),
    "the CLI grammar and the registry grammar differ — an author would meet the refusal after sending",
  );
  for (const ok of ["abc", "a-b-c", "a".repeat(64), "0-9"]) assert.ok(isValidSlug(ok), ok);
  for (const bad of ["ab", "a".repeat(65), "Abc", "a_b", "a b", "", null, 7]) {
    assert.equal(isValidSlug(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("[P0.C18] the source profile names what the server owns, and what marks an input already packed", () => {
  assert.equal(SOURCE_PROFILE, "skill-source-v1");
  assert.deepEqual([...SERVER_OWNED_MANIFEST_MEMBERS], ["author_agent", "integrity"]);
  assert.deepEqual([...ALREADY_PACKED_MARKERS], ["skill.json", "SIGNATURE.jws"]);
  // both markers are names the packing path actually produces — a marker that
  // named a file nothing writes would refuse nothing
  const archive = readFileSync(join(ROOT, "src", "archive.ts"), "utf8");
  for (const m of ALREADY_PACKED_MARKERS) {
    assert.ok(archive.includes(`"${m}"`), `${m} is not a file this build's packing path names`);
  }
  assert.deepEqual([...RISK_LEVELS], ["low", "medium", "high"]);
  for (const r of RISK_LEVELS) assert.ok(isRiskLevel(r));
  for (const bad of ["LOW", "critical", "", null]) assert.equal(isRiskLevel(bad), false);
  // high risk declares BOTH approvals: §7.3 asks at two different moments
  assert.deepEqual([...HIGH_RISK_REQUIRED_APPROVALS], ["publish", "adopt_high_risk"]);
});

test("[P0.C19] only a FAIL decides the exit code, and `ok` is derived rather than reported beside it", () => {
  const f = (severity: SourceFinding["severity"]): SourceFinding => ({
    pointer: "/procedure/validation_gates/0/gate_id",
    code: "INVALID_SCHEMA",
    severity,
    detail: "d",
    recovery: "r",
  });
  assert.deepEqual([...FINDING_SEVERITIES], ["FAIL", "WARN", "INFO"]);
  assert.equal(validateExitCode([]), 0);
  assert.equal(validateExitCode([f("WARN"), f("INFO")]), 0, "a warning that blocks is a failure wearing a milder word");
  assert.equal(validateExitCode([f("WARN"), f("FAIL")]), 1);
  for (const findings of [[], [f("WARN")], [f("FAIL")], [f("INFO"), f("FAIL")]]) {
    assert.equal(isValidateOk(findings), validateExitCode(findings) === 0, "ok and the exit code disagree");
  }
  assert.deepEqual([...AUTHORING_SUBCOMMANDS], ["init", "validate", "create"]);
  for (const id of ["exit_code", "a", "a1_b"]) assert.ok(isGeneratedGateId(id));
  for (const bad of ["Exit_Code", "1a", "a-b", "", "a".repeat(41)]) assert.equal(isGeneratedGateId(bad), false, bad);
  // the flag registration and delivery must BOTH read
  assert.equal(WEBHOOK_LOOPBACK_FLAG, "SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK");
  const transport = readFileSync(join(ROOT, "src", "transport.ts"), "utf8");
  assert.ok(
    transport.includes(WEBHOOK_LOOPBACK_FLAG),
    "the CLI names a transport flag the transport does not read — registration and delivery would disagree",
  );
});

// ===========================================================================
// Backward compatibility, from the fixture
// ===========================================================================

/** `"string|null"` → the set of `typeof`/null answers the fixture admits. */
function admits(spec: string, value: unknown): boolean {
  return spec.split("|").some((t) => {
    if (t === "null") return value === null;
    if (t === "object") return typeof value === "object" && value !== null;
    return typeof value === t;
  });
}

function checkSurface(name: string, body: Record<string, unknown>): void {
  const s = COMPAT.surfaces[name];
  assert.ok(s, `the compat fixture does not describe ${name}`);
  for (const [member, spec] of Object.entries(s.required as Record<string, string>)) {
    assert.ok(member in body, `${name}: v1.0.0 required member \`${member}\` is gone`);
    assert.ok(admits(spec, body[member]), `${name}.${member}: ${JSON.stringify(body[member])} is not ${spec}`);
  }
  for (const [member, spec] of Object.entries(s.optional as Record<string, string>)) {
    if (!(member in body) || body[member] === undefined) continue;
    assert.ok(admits(spec, body[member]), `${name}.${member}: ${JSON.stringify(body[member])} is not ${spec}`);
  }
  // the reverse direction: a member nobody wrote down must not appear. An
  // addition is fine — it just has to be RECORDED, which is the whole value of
  // the fixture.
  const known = new Set([
    ...Object.keys(s.required),
    ...Object.keys(s.optional),
    ...Object.keys(s.added_in_v1_1 ?? {}),
  ]);
  const surprises = Object.keys(body).filter((k) => !known.has(k));
  assert.deepEqual(surprises, [], `${name} returned members the compat fixture does not record`);
}

test("[P0.C20] P0-FR-03: the v1.0.0 lifecycle responses still carry every member they promised", () => {
  const fx = p4Fixture();

  const doomed = publishedVersion(fx, "p0-compat-revoke");
  checkSurface("skill.revoke", fx.registry.revokeVersion(fx.owner, doomed.versionId, { reason: "compromised" }).response as never);
  // …and the convergent repeat, which is a different body: two of the optional
  // members are absent and `noop` appears
  checkSurface("skill.revoke", fx.registry.revokeVersion(fx.owner, doomed.versionId, { reason: "compromised" }).response as never);

  const dep = publishedVersion(fx, "p0-compat-deprecate");
  checkSurface("skill.deprecate", fx.registry.deprecateVersion(fx.owner, dep.versionId).response as never);

  const old = publishedVersion(fx, "p0-compat-supersede");
  const next = verifiableVersion(fx, "p0-compat-supersede", {
    skill_id: old.skillId,
    semver: "2.0.0",
    manifest: { skill_id: old.skillId },
  });
  fx.registry.verifyVersion(fx.owner, next.versionId);
  checkSurface(
    "skill.supersede",
    fx.registry.supersedeVersion(fx.owner, old.versionId, { successor_version_id: next.versionId }).response as never,
  );
  fx.db.close();
});

test("[P0.C21] the compat fixture records the baseline it was taken from, and records no removals", () => {
  assert.equal(COMPAT.baseline_commit, "1de63be92ab67de79b3888468bcf7fc89b4127d8");
  for (const [name, s] of Object.entries(COMPAT.surfaces as Record<string, any>)) {
    // A member may not be in two of the three lists: that would let a required
    // member be "also optional" and quietly stop being returned.
    const lists = [Object.keys(s.required), Object.keys(s.optional), Object.keys(s.added_in_v1_1 ?? {})];
    const all = lists.flat();
    assert.equal(new Set(all).size, all.length, `${name}: a member appears in more than one list`);
    assert.ok(Object.keys(s.required).length > 0, `${name}: a surface with no required member records nothing`);
    assert.ok(typeof s.route === "string" && s.route.startsWith("POST /v1/"));
  }
  // the v1.1 additions to `skill.revoke`, named — so an addition that ships
  // without being written here fails `[P0.C20]`'s reverse check
  assert.deepEqual(Object.keys(COMPAT.surfaces["skill.revoke"].added_in_v1_1), [
    "superseded_by",
    "notifications_queued",
    "lineage_tlog_seq",
  ]);
});
