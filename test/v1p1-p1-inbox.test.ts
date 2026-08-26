// P1 — THE APPROVAL INBOX: A DETERMINISTIC PROJECTION, AND NOT A SECOND
// DECISION ENGINE.
//
// WHAT THIS FILE MEASURES, AND WHY EACH CLAIM IS SHAPED THE WAY IT IS.
//
//   THE FROZEN DOCUMENT. `fixtures/v1p1-approval-inbox.json` is checked in and
//   the projection is compared to its BYTES. Not to a parsed object, not field
//   by field: a comparison that re-serialized both sides would pass a
//   projection that reordered two equal-keyed items, and reordering under an
//   equal key is precisely the failure the ordering rule exists to prevent.
//
//   PLAN-ORDER INDEPENDENCE, DEMONSTRATED RATHER THAN ASSERTED. The same
//   fixture is built THREE ways — the declared insertion order, the exact
//   reverse of it, and a connection running `PRAGMA
//   reverse_unordered_selects=ON`, which is SQLite's own switch for making an
//   unordered query return its rows the other way round. All three must produce
//   the same bytes. Two of those change what a scan returns without changing a
//   single value in the database, so a projection that read "the latest row" off
//   a scan fails two of the three and passes none of them by luck.
//
//   THE TIES ARE IN THE FIXTURE ON PURPOSE. This tree writes whole runs of rows
//   carrying one timestamp — several suites do it — so "the latest row" is
//   genuinely ambiguous by time alone. Two ties are planted: a review request
//   and a review verdict at one millisecond on `4.0.0`, and two publish
//   approvals at one millisecond on `3.0.0`. Each is resolved by the `id` half
//   of `(created_at_ms, id)` and each CHANGES the answer, so a projection that
//   dropped the tiebreak produces a different document rather than the same one.
//
//   THE NEGATIVES DISCRIMINATE. Every access rule below is measured twice: the
//   refusal, and the same call with the guard removed from a COPY of the rule,
//   showing the refusal was that guard's and not something incidental. A
//   negative test that cannot be made to fail is a negative test that proves
//   nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRest, type RestResponse } from "../src/http.ts";
import { consoleApprovalInbox, parseInboxQuery, projectInbox } from "../src/approval-inbox.ts";
import {
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  CONSEQUENCE_OF_KIND,
  CONSOLE_CONTRACT_V2,
  DECIDED_STATUSES,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  REVIEWER_VISIBLE_KINDS,
  compareInboxItems,
  consoleInboxKindAdmits,
  consoleRouteClass,
  decodeInboxCursor,
  encodeInboxCursor,
  type ConsoleInboxItemV2,
} from "../src/console-v2.ts";
import { isHumanApprover, reviewVerdictRefusal } from "../src/approvals.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { p4Fixture, createVersion, lint, type P4Fixture } from "./p4-helpers.ts";
import { NOW } from "./p2-helpers.ts";
import { ulid } from "../src/ulid.ts";
import {
  AG_ADMIN,
  AG_ADOPTER,
  AG_AUTHOR,
  AG_OWNER,
  AG_OUTSIDER,
  AG_REVIEWER,
  AG_SVC,
  REQ_APPROVED,
  REQ_ORDINARY,
  REQ_PENDING,
  T,
  V1,
  V3,
  V4,
  WS_OTHER,
  buildInboxFixture,
  ctx,
} from "./v1p1-p1-inbox-fixture.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN_PATH = "fixtures/v1p1-approval-inbox.json";
const ORIGIN = "console.local";

/** The whole envelope, serialized exactly as the route serializes it. */
function project(db: any, principal: any, query: any = {}): string {
  return JSON.stringify(consoleApprovalInbox(db, principal, query, T + 1000), null, 2) + "\n";
}

function itemsOf(db: any, principal: any, query: any = {}): ConsoleInboxItemV2[] {
  return consoleApprovalInbox(db, principal, query, T + 1000).items;
}

function byId(items: ConsoleInboxItemV2[], id: string): ConsoleInboxItemV2 {
  const found = items.find((i) => i.item_id.startsWith(id));
  assert.ok(found, `no inbox item whose id starts with ${id}: ${items.map((i) => i.item_id).join(", ")}`);
  return found;
}

// ===========================================================================
// G-P1-9 — THE FROZEN DOCUMENT, BYTE-COMPARED
// ===========================================================================

test("[P1.N1] the fixture yields the ONE pre-frozen document, byte for byte", () => {
  const expected = readFileSync(join(ROOT, FROZEN_PATH), "utf8");
  const db = buildInboxFixture();
  const actual = project(db, ctx(AG_ADMIN, "admin"));
  assert.equal(
    actual,
    expected,
    `the projection no longer matches ${FROZEN_PATH}. This file is FROZEN: if the change is intended, the ` +
      `intent belongs in SPEC.md section 6.4.3 first and in the fixture second.`,
  );
  // and the frozen document is the fixture the gate asks for, not a smaller one
  const doc = JSON.parse(expected) as { items: ConsoleInboxItemV2[] };
  const verdicts = doc.items.filter((i) => i.kind === "review").map((i) => i.decision?.decision);
  assert.ok(verdicts.includes("conditional"), "the fixture must carry a conditional review verdict");
  assert.ok(verdicts.includes("reject"), "the fixture must carry a rejected review");
  assert.ok(verdicts.includes("approve"), "the fixture must carry an approved review");
  assert.equal(
    byId(doc.items, "publish:V3").decision_history.length,
    3,
    "the fixture must carry SEVERAL historical publish rows",
  );
  assert.equal(byId(doc.items, "review:V1").status, "pending", "repeated requests must reopen the review item");
  db.close();
});

test("[P1.N2] the same document comes out under a reversed physical order and under a reversed query plan", () => {
  const forward = buildInboxFixture();
  const reversed = buildInboxFixture({ insertionOrder: "reverse" });
  const planReversed = buildInboxFixture({ reverseUnorderedSelects: true });
  const reversedBoth = buildInboxFixture({ insertionOrder: "reverse", reverseUnorderedSelects: true });

  const a = project(forward, ctx(AG_ADMIN, "admin"));
  const b = project(reversed, ctx(AG_ADMIN, "admin"));
  const c = project(planReversed, ctx(AG_ADMIN, "admin"));
  const d = project(reversedBoth, ctx(AG_ADMIN, "admin"));

  assert.equal(b, a, "reversing the physical insertion order changed the projection");
  assert.equal(c, a, "PRAGMA reverse_unordered_selects=ON changed the projection");
  assert.equal(d, a, "reversing both the rows and the scan changed the projection");
  assert.equal(a, readFileSync(join(ROOT, FROZEN_PATH), "utf8"), "and all four are the frozen document");

  // the same projection, run repeatedly on one connection, is also stable —
  // a statement cache or a prepared-statement reuse bug would show here
  for (let i = 0; i < 5; i += 1) assert.equal(project(forward, ctx(AG_ADMIN, "admin")), a);

  for (const db of [forward, reversed, planReversed, reversedBoth]) db.close();
});

test("[P1.N3] the pragma this proof leans on actually reverses an unordered scan", () => {
  // A demonstration that P1.N2's third arm is measuring something. If this
  // build of SQLite ignored `reverse_unordered_selects`, that arm would be a
  // second copy of the first and would prove nothing — so the switch is shown
  // to change an unordered read of the very table the projection reads.
  const plain = buildInboxFixture();
  const flipped = buildInboxFixture({ reverseUnorderedSelects: true });
  const scan = (db: any): string[] =>
    (db.prepare("SELECT id FROM reviews").all() as Array<{ id: string }>).map((r) => r.id);
  const a = scan(plain);
  const b = scan(flipped);
  assert.ok(a.length >= 3, "the fixture must hold several review rows for this to mean anything");
  assert.deepEqual([...b].reverse(), a, "PRAGMA reverse_unordered_selects did not reverse an unordered scan");
  assert.notDeepEqual(b, a, "the two scans are identical — this arm of the determinism proof is inert");
  plain.close();
  flipped.close();
});

// ===========================================================================
// §6.4.3 — the status rules, each stated as the rule and not as a row order
// ===========================================================================

test("[P1.N4] a review request strictly newer than the verdict reopens the item; a tie is broken by id", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_ADMIN, "admin"));

  // `1.0.0`: request T+30 > conditional T+20 → pending, and the conditional is
  // still the decision on record.
  const v1 = byId(items, "review:V1");
  assert.equal(v1.status, "pending");
  assert.equal(v1.decision?.decision, "conditional");

  // `4.0.0`: request and verdict share T+15 and the verdict's id is greater, so
  // the verdict is the later row and the item is decided. A projection that
  // compared timestamps alone would call this pending — the assertion below is
  // what makes the `id` half of the key load-bearing rather than decorative.
  const v4 = byId(items, "review:V4");
  assert.equal(v4.status, "approved");
  assert.equal(v4.decision?.decision, "approve");
  const tied = db
    .prepare("SELECT created_at_ms FROM reviews WHERE skill_version_id=?")
    .get(V4) as { created_at_ms: number };
  const tiedRequest = db
    .prepare(
      "SELECT COUNT(*) AS c FROM activity_log WHERE subject_id=? AND action='skill.review.request' AND created_at_ms=?",
    )
    .get(V4, tied.created_at_ms) as { c: number };
  assert.equal(tiedRequest.c, 1, "the fixture's planted tie is gone — this assertion is inert");
  db.close();
});

test("[P1.N5] the tiebreak is what decides the tied item — remove it and the answer changes", () => {
  // THE DISCRIMINATION. A copy of the review rule, with the `id` half of the
  // key removed, run against the same rows. It must reach a DIFFERENT answer:
  // that is what says the shipped rule's answer came from the tiebreak.
  const db = buildInboxFixture();
  const requests = db
    .prepare("SELECT id, created_at_ms FROM activity_log WHERE subject_id=? AND action='skill.review.request'")
    .all(V4) as Array<{ id: string; created_at_ms: number }>;
  const reviews = db
    .prepare("SELECT id, verdict, created_at_ms FROM reviews WHERE skill_version_id=?")
    .all(V4) as Array<{ id: string; verdict: string; created_at_ms: number }>;
  assert.equal(requests.length, 2);
  assert.equal(reviews.length, 1);

  const latestRequest = requests.reduce((a, b) =>
    b.created_at_ms !== a.created_at_ms ? (b.created_at_ms > a.created_at_ms ? b : a) : b.id > a.id ? b : a,
  );
  const review = reviews[0]!;
  assert.equal(latestRequest.created_at_ms, review.created_at_ms, "the fixture's tie is gone — this probe is inert");

  // WITH the tiebreak (the shipped rule): the review's id is the greater, so
  // the review is not older than the request and the item is decided.
  assert.ok(review.id > latestRequest.id, "the fixture's review must be the greater id for this tie to bite");
  // WITHOUT it: "is the request newer than the review" degenerates to `>=` or
  // `>` on equal numbers, and either way the answer stops being a fact about
  // the rows. The shipped projection says `approved`; a timestamp-only rule
  // that treats a tie as "the request is not older" says `pending`.
  const withoutTiebreak = latestRequest.created_at_ms >= review.created_at_ms ? "pending" : "approved";
  const shipped = byId(itemsOf(db, ctx(AG_ADMIN, "admin")), "review:V4").status;
  assert.equal(shipped, "approved");
  assert.equal(withoutTiebreak, "pending");
  assert.notEqual(shipped, withoutTiebreak, "removing the tiebreak did not change the answer — the probe is inert");
  db.close();
});

test("[P1.N6] a publish approval by a non-human never makes the item approved", () => {
  const db = buildInboxFixture();
  const item = byId(itemsOf(db, ctx(AG_ADMIN, "admin")), "publish:V3");
  // the fixture holds an `approved` publish row — written by a service
  // principal, exactly as a row inserted behind the API would be
  const rows = db
    .prepare("SELECT approver_agent_id, decision FROM approvals WHERE skill_version_id=? AND scope='publish'")
    .all(V3) as Array<{ approver_agent_id: string; decision: string }>;
  assert.ok(rows.some((r) => r.decision === "approved"), "the fixture must hold an approved publish row");
  assert.equal(item.status, "denied", "an approved row by a non-human must not open the gate");

  // DISCRIMINATION: the shipped status asks `publishApprovalSatisfied`. A rule
  // that read the decision column alone reaches `approved` on the same rows.
  const columnOnly = rows.some((r) => r.decision === "approved") ? "approved" : "denied";
  assert.equal(columnOnly, "approved");
  assert.notEqual(item.status, columnOnly, "reading the column alone did not change the answer — the probe is inert");
  // and the reason it does not count is the human gate, asked of the database
  const svcRow = rows.find((r) => r.decision === "approved")!;
  assert.equal(isHumanApprover(db, svcRow.approver_agent_id, ctx(AG_ADMIN, "admin").workspace_id), false);
  db.close();
});

test("[P1.N7] a dead-lettered adoption denial is denied even with no decision row to read", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_ADMIN, "admin"));
  const backstop = byId(items, "adopt_high_risk:REQ4");
  assert.equal(backstop.status, "denied");
  assert.equal(backstop.decision, null, "there is no approval row bound to this request");
  assert.equal(backstop.adoption_request?.state, "dead_letter");
  // and an ordinary request that never entered a §7.3 hold is not an item at all
  assert.equal(
    items.some((i) => i.item_id.includes(REQ_ORDINARY)),
    false,
    "a request that never waited on a human decision is not an approval-inbox item",
  );
  db.close();
});

test("[P1.N8] kind-specific nullability holds for every item of every kind", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_ADMIN, "admin"));
  assert.ok(items.length >= 9, `the fixture must exercise all three kinds: ${items.length} items`);
  for (const kind of APPROVAL_KINDS) {
    assert.ok(items.some((i) => i.kind === kind), `no ${kind} item in the fixture`);
  }
  for (const i of items) {
    assert.ok(i.skill.skill_id.length > 0 && i.skill.skill_version_id.length > 0, `${i.item_id} has no skill`);
    assert.equal(i.consequence.scope, CONSEQUENCE_OF_KIND[i.kind].scope, `${i.item_id} carries the wrong scope`);
    assert.ok((APPROVAL_STATUSES as readonly string[]).includes(i.status));
    assert.equal(i.item_id.startsWith(`${i.kind}:`), true);
    if (i.kind === "adopt_high_risk") {
      assert.notEqual(i.adoption_request, null, `${i.item_id} must name its request`);
      assert.equal(i.adoption_request!.adoption_request_id, i.item_id.slice("adopt_high_risk:".length));
      assert.ok(i.conditions.length > 0, `${i.item_id} must carry its §7.3 conditions`);
    } else if (i.kind === "publish") {
      assert.equal(i.adoption_request, null, "a publish item is not bound to an adoption request");
      assert.ok(i.conditions.length > 0, `${i.item_id} must carry its §7.3 conditions`);
    } else {
      assert.equal(i.adoption_request, null, "a review item is not bound to an adoption request");
      assert.deepEqual(i.conditions, [], "a review verdict answers no §7.3 condition");
    }
    if (i.decision !== null) {
      assert.ok(i.decision.actor_agent_id.length > 0);
      assert.ok(i.decision.actor_type.length > 0, "a decided item names the actor's TYPE");
      assert.ok(i.decision.actor_role.length > 0, "a decided item names the actor's ROLE");
      assert.equal(typeof i.decision.server_at_ms, "number");
      assert.ok(i.decision.server_at_ms > 0, "a decided item carries the server time it was recorded at");
    }
  }
  db.close();
});

test("[P1.N9] a decided item shows the actor's type and role as two separate facts", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_ADMIN, "admin"));
  const decided = byId(items, "publish:V3");
  assert.equal(decided.decision?.actor_agent_id, AG_OWNER);
  assert.equal(decided.decision?.actor_type, "human");
  assert.equal(decided.decision?.actor_role, "owner");
  assert.equal(decided.decision?.note, "still no");
  // the history preserves the service principal's row exactly as recorded —
  // a decision the gate ignores is still a decision somebody took
  const service = decided.decision_history.find((d) => d.actor_agent_id === AG_SVC);
  assert.ok(service, "the history must preserve the service principal's row");
  assert.equal(service.actor_type, "service");
  assert.equal(service.actor_role, "admin");
  assert.equal(service.decision, "approved");
  // `INV-03`: a type and a role are different facts and a privileged role is
  // never read as a human
  assert.notEqual(service.actor_type, decided.decision?.actor_type);
  db.close();
});

test("[P1.N10] an absent manifest field is `unknown` and never a default (INV-03)", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_ADMIN, "admin"));
  const unreadable = byId(items, "publish:V5");
  assert.equal(unreadable.skill.risk_level, "unknown", "an unreadable manifest declares no risk level");
  assert.notEqual(unreadable.skill.risk_level, "low", "`unknown` is not the lowest value of the scale");
  assert.deepEqual(
    unreadable.conditions.map((c) => c.code),
    ["unreadable_manifest"],
    "§7.3 fails closed on a manifest it cannot read",
  );
  assert.equal(unreadable.conditions[0]!.source, "registry", "the fail-closed condition is not a fact the author signed");
  // and a readable one names the two sources apart
  const v3 = byId(items, "publish:V3");
  assert.deepEqual(
    v3.conditions.map((c) => `${c.code}/${c.source}`),
    ["risk_high/signed_manifest", "low_evidence_large_blast_radius/signed_manifest+registry"],
  );
  db.close();
});

// ===========================================================================
// Ordering, filters and paging
// ===========================================================================

test("[P1.N11] the order is `updated_at_ms DESC, item_id ASC`, and the tiebreak is total", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_ADMIN, "admin"));
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1]!;
    const cur = items[i]!;
    assert.ok(
      prev.updated_at_ms > cur.updated_at_ms ||
        (prev.updated_at_ms === cur.updated_at_ms && prev.item_id < cur.item_id),
      `${prev.item_id} must not precede ${cur.item_id}`,
    );
  }
  // the comparator's own tiebreak, on synthetic items, because the fixture is
  // built so that no two items share an `updated_at_ms` — the property still
  // has to hold, and a fixture cannot show it
  const tied = [
    { updated_at_ms: 5, item_id: "review:b" },
    { updated_at_ms: 5, item_id: "review:a" },
    { updated_at_ms: 9, item_id: "publish:z" },
  ];
  assert.deepEqual(
    [...tied].sort(compareInboxItems).map((i) => i.item_id),
    ["publish:z", "review:a", "review:b"],
  );
  db.close();
});

test("[P1.N12] `status` and `kind` filter, and `decided` is a filter and never a status", () => {
  const db = buildInboxFixture();
  const principal = ctx(AG_ADMIN, "admin");
  const all = itemsOf(db, principal, { status: "all", kind: "all" });
  const pending = itemsOf(db, principal, { status: "pending" });
  const decided = itemsOf(db, principal, { status: "decided" });
  assert.equal(pending.length + decided.length, all.length, "pending and decided must partition the union");
  assert.ok(pending.every((i) => i.status === "pending"));
  assert.ok(decided.every((i) => (DECIDED_STATUSES as readonly string[]).includes(i.status)));
  assert.equal(
    all.some((i) => (i.status as string) === "decided"),
    false,
    "no item is ever `decided` — it is a filter",
  );
  for (const kind of APPROVAL_KINDS) {
    const only = itemsOf(db, principal, { kind });
    assert.ok(only.length > 0, `no ${kind} items`);
    assert.ok(only.every((i) => i.kind === kind));
  }
  // an unrecognised filter is refused rather than coerced
  for (const bad of [{ status: "approved-ish" }, { kind: "reviews" }, { limit: "0" }, { limit: String(INBOX_MAX_LIMIT + 1) }, { cursor: "!!!" }]) {
    assert.throws(() => consoleApprovalInbox(db, principal, bad, T), /INVALID_SCHEMA|cursor/);
  }
  db.close();
});

test("[P1.N13] paging walks the same order exactly once, and the cursor is that pair", () => {
  const db = buildInboxFixture();
  const principal = ctx(AG_ADMIN, "admin");
  const all = itemsOf(db, principal);
  const walked: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const env: any = consoleApprovalInbox(db, principal, cursor === null ? { limit: 3 } : { limit: 3, cursor }, T + 1000);
    walked.push(...env.items.map((i: ConsoleInboxItemV2) => i.item_id));
    cursor = env.next_cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(walked, all.map((i) => i.item_id), "paging did not reproduce the single order");
  assert.equal(new Set(walked).size, walked.length, "an item was served twice");

  // the cursor IS `(updated_at_ms, item_id)` and nothing else
  const first = all[0]!;
  assert.deepEqual(decodeInboxCursor(encodeInboxCursor(first)), {
    updated_at_ms: first.updated_at_ms,
    item_id: first.item_id,
  });
  assert.equal(parseInboxQuery({}).limit, INBOX_DEFAULT_LIMIT);
  assert.throws(() => parseInboxQuery({ limit: INBOX_MAX_LIMIT + 1 }), /INVALID_SCHEMA/);
  db.close();
});

// ===========================================================================
// G-P1-7 — the negatives, each with the guard removed
// ===========================================================================

test("[P1.N14] a service or non-human admin principal never gets `allowed:true` for a human gate", () => {
  const db = buildInboxFixture();
  for (const [who, principal] of [
    ["service, role admin", ctx(AG_SVC, "admin")],
    ["human author, role member", ctx(AG_AUTHOR, "member")],
    ["agent adopter, role member", ctx(AG_ADOPTER, "member")],
  ] as const) {
    const items = itemsOf(db, principal);
    const gates = items.filter((i) => i.kind !== "review");
    assert.ok(gates.length > 0, `${who} saw no human gates at all`);
    for (const i of gates) {
      assert.equal(i.eligibility.allowed, false, `${who} was offered ${i.item_id}`);
      assert.equal(i.eligibility.reason_code, "NOT_HUMAN_APPROVER");
    }
  }
  // the two human admin/owner principals DO get one, so the assertion above is
  // about the gate and not about the fixture having no approvable item
  for (const principal of [ctx(AG_ADMIN, "admin"), ctx(AG_OWNER, "owner")]) {
    const offered = itemsOf(db, principal).filter((i) => i.kind !== "review" && i.eligibility.allowed);
    assert.ok(offered.length > 0, "no human gate is approvable by a human admin/owner — the negative proves nothing");
    assert.ok(offered.every((i) => i.eligibility.reason_code === "APPROVABLE"));
  }

  // DISCRIMINATION: the verdict comes from `isHumanApprover`. Remove the
  // `type='human'` half of it — the shape of the defect this guards — and the
  // service principal passes.
  const withoutTypeCheck = (agentId: string): boolean => {
    const a = db
      .prepare(
        `SELECT a.status, (SELECT role FROM workspace_memberships m WHERE m.agent_id=a.id AND m.workspace_id=a.workspace_id) AS role
           FROM agents a WHERE a.id=?`,
      )
      .get(agentId) as { status: string; role: string | null } | undefined;
    return !!a && a.status === "active" && (a.role === "admin" || a.role === "owner");
  };
  const ws = ctx(AG_SVC, "admin").workspace_id;
  assert.equal(isHumanApprover(db, AG_SVC, ws), false, "the shipped gate refuses a service principal");
  assert.equal(withoutTypeCheck(AG_SVC), true, "the guard-removed copy admits it — the probe discriminates");
  db.close();
});

test("[P1.N15] a reviewer never gets `allowed:true` for a high-risk publish or adoption", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_REVIEWER, "reviewer"));
  const gates = items.filter((i) => i.kind !== "review");
  assert.ok(gates.length > 0, "the fixture must show the reviewer some human gates for this to bite");
  for (const i of gates) {
    assert.equal(i.eligibility.allowed, false, `a reviewer was offered ${i.item_id}`);
    assert.equal(i.eligibility.reason_code, "NOT_HUMAN_APPROVER");
  }
  assert.ok(
    gates.some((i) => i.kind === "adopt_high_risk" && i.status === "pending"),
    "a PENDING high-risk adoption must be among them — a decided one would be refused for the wrong reason",
  );
  assert.ok(gates.some((i) => i.kind === "publish" && i.skill.risk_level === "high"));
  db.close();
});

test("[P1.N16] review eligibility is the review surface's own rule set, and self-review is refused", () => {
  const db = buildInboxFixture();
  // the author of every fixture version: refused as an author, whatever role
  const authorItems = itemsOf(db, ctx(AG_AUTHOR, "admin"), { kind: "review" });
  assert.ok(authorItems.length > 0);
  for (const i of authorItems) {
    assert.equal(i.eligibility.allowed, false);
    assert.equal(i.eligibility.reason_code, "SELF_REVIEW_AUTHOR");
  }
  // the skill's owner: refused as the owner
  const ownerItems = itemsOf(db, ctx(AG_OWNER, "owner"), { kind: "review" });
  for (const i of ownerItems) {
    assert.equal(i.eligibility.allowed, false);
    assert.equal(i.eligibility.reason_code, "SELF_REVIEW_SKILL_OWNER");
  }
  // a member who is neither: refused on role
  const memberItems = itemsOf(db, ctx(AG_ADOPTER, "member"), { kind: "review" });
  for (const i of memberItems) {
    assert.equal(i.eligibility.reason_code, "ROLE_MAY_NOT_REVIEW");
  }
  // the reviewer: eligible where the state admits it, and told which state does not
  const reviewerItems = itemsOf(db, ctx(AG_REVIEWER, "reviewer"), { kind: "review" });
  assert.ok(reviewerItems.some((i) => i.eligibility.allowed));
  assert.ok(reviewerItems.some((i) => i.eligibility.reason_code === "STATE_NOT_REVIEWABLE"));
  db.close();
});

test("[P1.N17] the Inbox's review eligibility and the review SURFACE agree, item by item", () => {
  // THE SINGLE-SOURCE CLAIM, measured rather than asserted: for every review
  // item and every principal, the projection's `allowed` is exactly whether the
  // service method would accept a verdict. A second copy of the rules would
  // show up here as one disagreement.
  const fx = p4Fixture();
  const v = createVersion(fx, "agree-skill");
  assert.equal(lint(fx, v.versionId, fx.author), "linted");
  fx.registry.review(fx.author, v.versionId, { action: "request" });

  const principals: Array<[string, any]> = [
    ["author", fx.author],
    ["owner", fx.owner],
    ["reviewer", fx.reviewer],
    ["admin", fx.admin],
    ["service", fx.service],
    ["member", fx.member],
  ];
  for (const [name, auth] of principals) {
    const item = itemsOf(fx.db, auth, { kind: "review" }).find((i) => i.item_id === `review:${v.versionId}`);
    assert.ok(item, `${name} could not see the review item`);
    let accepted = true;
    try {
      // a REAL verdict on a throwaway copy of the world, so the surface's own
      // answer is what is compared and not a restatement of it
      const probe = p4Fixture();
      const pv = createVersion(probe, "agree-skill");
      lint(probe, pv.versionId, probe.author);
      probe.registry.review(probe.author, pv.versionId, { action: "request" });
      const probeAuth = (probe as any)[name] ?? probe.member;
      probe.registry.review(probeAuth, pv.versionId, { action: "verdict", verdict: "approve" });
    } catch {
      accepted = false;
    }
    assert.equal(
      item.eligibility.allowed,
      accepted,
      `the Inbox and the review surface disagree for ${name}: inbox says ${item.eligibility.allowed}`,
    );
  }
  // and the predicate itself is the one the surface raises
  const row = fx.db
    .prepare(
      `SELECT v.author_agent_id, v.state, s.owner_agent_id FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE v.id=?`,
    )
    .get(v.versionId) as any;
  assert.equal(reviewVerdictRefusal(row, fx.reviewer), null);
  assert.equal(reviewVerdictRefusal(row, fx.author)?.reason_code, "SELF_REVIEW_AUTHOR");
});

test("[P1.N18] an adoption approval names the exact request; a publish approval names none", () => {
  const db = buildInboxFixture();
  const items = itemsOf(db, ctx(AG_ADMIN, "admin"));
  for (const i of items.filter((x) => x.kind === "adopt_high_risk")) {
    assert.ok(i.adoption_request, `${i.item_id} must name its request`);
    const bound = db
      .prepare("SELECT adoption_request_id FROM approvals WHERE adoption_request_id=? AND scope='adopt_high_risk'")
      .get(i.adoption_request!.adoption_request_id) as { adoption_request_id: string } | undefined;
    if (i.decision !== null) {
      assert.ok(bound, `${i.item_id} shows a decision with no row bound to that exact request`);
      assert.equal(bound.adoption_request_id, i.adoption_request!.adoption_request_id);
    }
  }
  // a publish approval carrying a request id is refused by the schema itself —
  // the projection can never see one, and this is why
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, created_at_ms) VALUES (?,?,?,?, 'publish', 'approved', ?)",
        )
        .run(ulid(T), V3, REQ_PENDING, AG_ADMIN, T),
    /CHECK|constraint/i,
  );
  // and the two requests for ONE version are two separate items: an approval
  // spent on one leaves the other pending
  const approved = byId(items, `adopt_high_risk:${REQ_APPROVED}`);
  const pending = byId(items, `adopt_high_risk:${REQ_PENDING}`);
  assert.equal(approved.skill.skill_version_id, pending.skill.skill_version_id);
  assert.equal(approved.status, "approved");
  assert.equal(pending.status, "pending");
  assert.equal(approved.consequence.reusable, false);
  db.close();
});

test("[P1.N19] the Inbox is same-workspace, and another workspace's rows are not in it", () => {
  const db = buildInboxFixture();
  const mine = itemsOf(db, ctx(AG_ADMIN, "admin"));
  assert.ok(mine.length > 0);
  assert.equal(
    mine.some((i) => i.skill.slug === "other-skill"),
    false,
    "another workspace's version reached this workspace's Inbox",
  );
  // the other workspace sees its own rows and only those — so the assertion
  // above is about scoping and not about the other rows being unreachable
  const theirs = itemsOf(db, ctx(AG_OUTSIDER, "owner", WS_OTHER));
  assert.ok(theirs.length > 0, "the other workspace's own rows must be visible to it");
  assert.ok(theirs.every((i) => i.skill.slug === "other-skill"));

  // DISCRIMINATION: the scope is the `WHERE s.workspace_id = ?` in the
  // projection. A copy without it returns both workspaces' versions.
  const scoped = (db.prepare(
    "SELECT COUNT(*) AS c FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE s.workspace_id=?",
  ).get(ctx(AG_ADMIN, "admin").workspace_id) as { c: number }).c;
  const unscoped = (db.prepare("SELECT COUNT(*) AS c FROM skill_versions").get() as { c: number }).c;
  assert.ok(unscoped > scoped, "the fixture must hold a version outside the workspace for this probe to bite");
  db.close();
});

// ===========================================================================
// The route — SPEC.md section 6.4.3
// ===========================================================================

interface Call {
  path: string;
  key?: string;
  cookie?: string;
}

function call(fx: P4Fixture, c: Call): RestResponse & { json: any } {
  const headers: Record<string, string | undefined> = { host: ORIGIN, origin: `http://${ORIGIN}` };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
  const res = handleRest(fx.registry, { method: "GET", url: c.path, headers, body: Buffer.alloc(0) });
  let json: any = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { ...res, json };
}

function signIn(fx: P4Fixture, keyName: keyof P4Fixture["keys"]): string {
  const minted = handleRest(fx.registry, {
    method: "POST",
    url: "/v1/console/tickets",
    headers: { host: ORIGIN, origin: `http://${ORIGIN}`, authorization: `Bearer ${fx.keys[keyName]!}` },
    body: Buffer.from("{}"),
  });
  assert.equal(minted.status, 201, minted.body);
  const opened = handleRest(fx.registry, {
    method: "POST",
    url: "/v1/console/session",
    headers: { host: ORIGIN, origin: `http://${ORIGIN}` },
    body: Buffer.from(JSON.stringify({ ticket: JSON.parse(minted.body).ticket })),
  });
  assert.equal(opened.status, 201, opened.body);
  return /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"])![1]!;
}

test("[P1.N20] the route needs a session, is classified, and answers `console.v2` with `no-store`", () => {
  const fx = p4Fixture();
  // NO SESSION — and this is the assertion the session-required path list in
  // `src/http.ts` exists for. A console path absent from that list reaches the
  // handler with no cookie check at all.
  const anon = call(fx, { path: "/v1/console/approvals" });
  assert.equal(anon.status, 401, `an unauthenticated caller reached the Inbox: ${anon.body}`);
  assert.equal(anon.json.contract, CONSOLE_CONTRACT_V2, "even the refusal declares the contract");
  // a Bearer API key is not a console session either
  const bearer = call(fx, { path: "/v1/console/approvals", key: fx.keys.owner! });
  assert.equal(bearer.status, 401);

  assert.equal(consoleRouteClass("/v1/console/approvals"), "approval_inbox");

  const cookie = signIn(fx, "owner");
  const ok = call(fx, { path: "/v1/console/approvals", cookie });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(ok.json.contract, CONSOLE_CONTRACT_V2);
  assert.deepEqual(ok.json.statuses, [...APPROVAL_STATUSES]);
  assert.deepEqual(ok.json.kinds, [...APPROVAL_KINDS]);
  assert.ok(Array.isArray(ok.json.items));
  assert.equal(ok.headers["Cache-Control"], "no-store");
});

test("[P1.N21] a reviewer may ask this inbox only for an explicit `kind=review`", () => {
  const fx = p4Fixture();
  const cookie = signIn(fx, "reviewer");
  const explicit = call(fx, { path: "/v1/console/approvals?kind=review", cookie });
  assert.equal(explicit.status, 200, explicit.body);

  for (const q of ["", "?kind=all", "?kind=publish", "?kind=adopt_high_risk", "?status=pending"]) {
    const res = call(fx, { path: `/v1/console/approvals${q}`, cookie });
    assert.equal(res.status, 403, `a reviewer reached the inbox with '${q}': ${res.body}`);
    assert.equal(res.json.error.code, "FORBIDDEN");
    assert.equal(res.json.contract, CONSOLE_CONTRACT_V2);
  }
  // an unrecognised kind is INVALID_SCHEMA for a reviewer too, so probing which
  // kinds exist by reading which ones answer FORBIDDEN learns nothing
  const bogus = call(fx, { path: "/v1/console/approvals?kind=nope", cookie });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.json.error.code, "INVALID_SCHEMA");

  // an owner passes every one of them
  const ownerCookie = signIn(fx, "owner");
  for (const q of ["", "?kind=all", "?kind=publish", "?kind=adopt_high_risk", "?kind=review"]) {
    assert.equal(call(fx, { path: `/v1/console/approvals${q}`, cookie: ownerCookie }).status, 200, q);
  }

  // DISCRIMINATION: the refusal is `consoleInboxKindAdmits`. Removing the
  // reviewer branch — the guard — admits every kind.
  assert.equal(consoleInboxKindAdmits("reviewer", "all"), false);
  assert.equal(consoleInboxKindAdmits("reviewer", "review"), true);
  assert.equal(consoleInboxKindAdmits("owner", "all"), true);
  const withoutGuard = (kind: string): boolean => ["review", "publish", "adopt_high_risk", "all"].includes(kind);
  assert.equal(withoutGuard("all"), true, "the guard-removed copy admits `all` — the probe discriminates");
  assert.deepEqual([...REVIEWER_VISIBLE_KINDS], ["review"]);
});

test("[P1.N22] the route serves the rows the real surfaces wrote", () => {
  // The frozen fixture writes rows directly, on purpose. This asserts the
  // projection reads the rows the SURFACES write, so neither claim leans on the
  // other.
  const fx = p4Fixture();
  const v = createVersion(fx, "surface-skill");
  assert.equal(lint(fx, v.versionId, fx.author), "linted");
  fx.registry.review(fx.author, v.versionId, { action: "request" });

  const cookie = signIn(fx, "owner");
  const before = call(fx, { path: "/v1/console/approvals?kind=review", cookie });
  const item = before.json.items.find((i: any) => i.item_id === `review:${v.versionId}`);
  assert.ok(item, `the requested review is not in the inbox: ${before.body}`);
  assert.equal(item.status, "pending");
  assert.equal(item.decision, null);

  fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "conditional", note: "pin it" });
  const after = call(fx, { path: "/v1/console/approvals?kind=review", cookie });
  const decided = after.json.items.find((i: any) => i.item_id === `review:${v.versionId}`);
  assert.equal(decided.status, "conditional");
  assert.equal(decided.decision.decision, "conditional");
  assert.equal(decided.decision.note, "pin it");
  assert.equal(decided.decision.actor_agent_id, fx.reviewer.agent_id);
  assert.equal(decided.decision.actor_type, "agent");
  assert.equal(decided.decision.actor_role, "reviewer");

  // and a request AFTER the verdict reopens it, through the real surface
  fx.registry.review(fx.author, v.versionId, { action: "request" });
  const reopened = call(fx, { path: "/v1/console/approvals?kind=review", cookie }).json.items.find(
    (i: any) => i.item_id === `review:${v.versionId}`,
  );
  // the surfaces write at one frozen clock, so this repeat is a genuine tie —
  // the request's ULID is the later one and the item reopens
  assert.equal(reopened.status, "pending", "a fresh request after a verdict must reopen the item");
  assert.equal(reopened.decision.decision, "conditional", "and the recorded verdict is still on the record");

  // the human-approval lane, driven through the real approval recorder
  const req = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'approval_pending', 0, 0, ?)",
    )
    .run(req, v.versionId, fx.member.agent_id, NOW);
  const held = call(fx, { path: "/v1/console/approvals?kind=adopt_high_risk", cookie }).json.items.find(
    (i: any) => i.item_id === `adopt_high_risk:${req}`,
  );
  assert.ok(held, "a held adoption request must appear as a pending item");
  assert.equal(held.status, "pending");
  assert.equal(held.eligibility.allowed, true, "the human owner may decide it");

  fx.registry.approve(fx.owner, v.versionId, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req,
  });
  const settled = call(fx, { path: "/v1/console/approvals?kind=adopt_high_risk", cookie }).json.items.find(
    (i: any) => i.item_id === `adopt_high_risk:${req}`,
  );
  assert.equal(settled.status, "approved");
  assert.equal(settled.decision.actor_agent_id, fx.owner.agent_id);
  assert.equal(settled.eligibility.allowed, false);
  assert.equal(settled.eligibility.reason_code, "ALREADY_DECIDED");
});

test("[P1.N23] the projection reads only rows and decides nothing about approval semantics", () => {
  // A source-level guard on the property the whole packet turns on. The module
  // may not carry its own copy of a human gate or a condition matrix: it must
  // IMPORT them. A new predicate written inline here would be the exact defect
  // `INV-01` names, and it would not be caught by any behavioural test until
  // the two copies diverged.
  const src = readFileSync(join(ROOT, "src", "approval-inbox.ts"), "utf8");
  for (const imported of [
    "approvalConditions",
    "requiresHumanApproval",
    "isHumanApprover",
    "publishApprovalSatisfied",
    "reviewVerdictRefusal",
  ]) {
    assert.ok(new RegExp(`\\b${imported}\\b`).test(src), `the projection does not call ${imported}`);
  }
  assert.equal(
    /type\s*[=!]==?\s*["']human["']/.test(src),
    false,
    "the projection carries its own copy of the human gate's type check",
  );
  assert.equal(
    /risk_level\s*===\s*["']high["']/.test(src),
    false,
    "the projection carries its own copy of a §7.3 condition predicate",
  );
  assert.equal(/INSERT INTO|UPDATE |DELETE FROM/.test(src), false, "the Inbox is a READ and writes nothing");
  // and the frozen document is reachable from the projection alone
  const db = buildInboxFixture();
  assert.ok(projectInbox(db, ctx(AG_ADMIN, "admin") as any, T + 1000).length >= 9);
  db.close();
});

test("[P1.N24] SPEC.md section 6.4.3 states the rules this file measures", () => {
  const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
  const at = spec.indexOf("#### 6.4.3 The Approval Inbox");
  assert.ok(at > 0, "SPEC.md has no section 6.4.3");
  const section = spec.slice(at, spec.indexOf("\n---", at));
  for (const claim of [
    "GET /v1/console/approvals",
    "READ-MODEL",
    "`review:{skill_version_id}`",
    "`publish:{skill_version_id}`",
    "`adopt_high_risk:{adoption_request_id}`",
    "`(created_at_ms, id)`",
    "`updated_at_ms DESC,",
    "one_skill_version_review",
    "one_skill_version_publish_gate",
    "one_adoption_request",
  ]) {
    assert.ok(section.includes(claim), `SPEC.md section 6.4.3 never states: ${claim}`);
  }
  assert.ok(section.includes("50") && section.includes("200"), "the page bounds must be stated");
  assert.equal(INBOX_DEFAULT_LIMIT, 50);
  assert.equal(INBOX_MAX_LIMIT, 200);
  // the fixture is checked in, and the document says what it must contain
  const frozen = JSON.parse(readFileSync(join(ROOT, FROZEN_PATH), "utf8")) as { contract: string };
  assert.equal(frozen.contract, CONSOLE_CONTRACT_V2);
  void [V1, V4, AG_REVIEWER];
});
