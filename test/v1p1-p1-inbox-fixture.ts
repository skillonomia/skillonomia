// THE APPROVAL INBOX FIXTURE — one world, buildable in either physical order.
//
// WHY THE ROWS ARE INSERTED DIRECTLY AND NOT DRIVEN THROUGH THE SURFACES. What
// the deterministic gate measures is the PROJECTION: given these rows, does the
// registry produce one fixed document whatever SQLite did on the way? To ask
// that question the rows have to be the independent variable — exact ids, exact
// timestamps, exact ties — and a surface that mints a ULID from a clock cannot
// give a test either. The rows this builder writes are the rows the surfaces
// write: same DDL, same CHECKs, same tenancy and approval triggers, which run on
// every INSERT below and refuse a fixture that is not a state the registry could
// have reached. A separate suite drives the real surfaces and compares their
// rows against the projection, so neither claim leans on the other.
//
// WHY IT TAKES AN ORDER. `insertionOrder: "reverse"` writes exactly the same
// rows with exactly the same ids and timestamps, in the opposite physical
// sequence. Two databases built that way differ in rowid order and in nothing
// else — so a projection that read "the latest row" off a scan rather than off
// `(created_at_ms, id)` produces two different documents, and the byte-compare
// says so.
//
// THE TIES ARE DELIBERATE. Two rows carry one timestamp in two places, because
// that is ordinary in this tree and it is the case where a query plan gets to
// decide. On `4.0.0` a review request and a review verdict share a millisecond,
// and the verdict's id is the greater — so the item is DECIDED, and a
// projection that resolved the tie the other way would call it pending. On
// `3.0.0` two publish approvals share a millisecond, and only one of them is
// the item's `decision`.
import type { Db } from "../src/sqlite.ts";
import { openMigrated } from "../src/db.ts";

/** An id is 26 characters and this tree checks only that. Readable ones make
 *  the ordering the fixture depends on visible in the source rather than
 *  hidden in a ULID's random tail. */
export function id26(s: string): string {
  if (s.length > 26) throw new Error(`fixture id longer than 26: ${s}`);
  return s.padEnd(26, "0");
}

/** The frozen clock this fixture is written against. Every timestamp below is
 *  an explicit offset from it, so a reader can see which rows tie. */
export const T = 1_700_000_000_000;

export const WS = id26("WS-INBOX");
export const WS_OTHER = id26("WS-OTHER");

export const AG_OWNER = id26("AG-OWNER");
export const AG_AUTHOR = id26("AG-AUTHOR");
export const AG_ADMIN = id26("AG-ADMIN");
export const AG_SVC = id26("AG-SVC");
export const AG_REVIEWER = id26("AG-REVIEWER");
export const AG_ADOPTER = id26("AG-ADOPTER");
export const AG_OUTSIDER = id26("AG-OUTSIDER");

export const SK = id26("SK-ALPHA");
export const SK_OTHER = id26("SK-OTHER");

export const V1 = id26("V1-LOW-LINTED");
export const V2 = id26("V2-HIGH-LINTED");
export const V3 = id26("V3-HIGH-VERIFIED");
export const V4 = id26("V4-LOW-PUBLISHED");
export const V5 = id26("V5-UNREADABLE");
export const V_OTHER = id26("V-OTHER-WORKSPACE");

export const REQ_PENDING = id26("REQ1-APPROVAL-PENDING");
export const REQ_APPROVED = id26("REQ2-APPROVED");
export const REQ_DENIED = id26("REQ3-DENIED");
export const REQ_DEAD_ONLY = id26("REQ4-DEAD-NO-ROW");
export const REQ_ORDINARY = id26("REQ5-ORDINARY");

/**
 * A manifest the §7.3 matrix can read. Only the members the matrix predicates
 * touch matter here — `approvalConditions` reads declared fields and nothing
 * else — and writing more would suggest the projection depended on them.
 */
function manifest(risk: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scope: { risk_level: risk },
    runtime: { cloud_iam_assumptions: [] },
    safety: { url_allowlist: [] },
    ...extra,
  });
}

const HASH = "a".repeat(64);

interface Row {
  sql: string;
  params: unknown[];
}

/**
 * The whole fixture as an ORDERED list of writes.
 *
 * Returned as data rather than executed inline so the same list can be replayed
 * forwards and backwards. The prefix — workspaces, agents, memberships, skills,
 * versions — is NOT reorderable: a foreign key and three tenancy triggers
 * decide that, and reversing it would be measuring SQLite's referential
 * integrity rather than the projection. The DECISION rows after it are the ones
 * whose physical order the projection must not depend on, and those are what
 * `reverse` reverses.
 */
function graphRows(): Row[] {
  const ws = (id: string, name: string): Row => ({
    sql: "INSERT INTO workspaces(id, name, created_at_ms) VALUES (?,?,?)",
    params: [id, name, T],
  });
  const agent = (id: string, workspace: string, name: string, type: string): Row => ({
    sql: "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?,?,?,'active',?)",
    params: [id, workspace, name, type, T],
  });
  const member = (id: string, workspace: string, role: string): Row => ({
    sql: "INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)",
    params: [id, workspace, role, T],
  });
  const skill = (id: string, workspace: string, slug: string, owner: string): Row => ({
    sql: "INSERT INTO skills(id, workspace_id, slug, owner_agent_id, access_policy, created_at_ms) VALUES (?,?,?,?, 'workspace', ?)",
    params: [id, workspace, slug, owner, T],
  });
  const version = (
    id: string,
    skillId: string,
    author: string,
    semver: string,
    state: string,
    manifestJson: string,
    createdAt: number,
  ): Row => ({
    sql: `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json, manifest_hash,
            content_hash, package_blob_ref, signature_jws, state, created_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    params: [id, skillId, semver, author, manifestJson, HASH, HASH, `blob:${id}`, "jws.fixture.signature", state, createdAt],
  });

  return [
    ws(WS, "inbox workspace"),
    ws(WS_OTHER, "another workspace"),
    agent(AG_OWNER, WS, "owner-h", "human"),
    agent(AG_AUTHOR, WS, "author-a", "agent"),
    agent(AG_ADMIN, WS, "admin-h", "human"),
    agent(AG_SVC, WS, "svc-a", "service"),
    agent(AG_REVIEWER, WS, "reviewer-a", "agent"),
    agent(AG_ADOPTER, WS, "adopter-a", "agent"),
    agent(AG_OUTSIDER, WS_OTHER, "outsider-a", "agent"),
    member(AG_OWNER, WS, "owner"),
    member(AG_AUTHOR, WS, "member"),
    member(AG_ADMIN, WS, "admin"),
    member(AG_SVC, WS, "admin"),
    member(AG_REVIEWER, WS, "reviewer"),
    member(AG_ADOPTER, WS, "member"),
    member(AG_OUTSIDER, WS_OTHER, "owner"),
    skill(SK, WS, "alpha-skill", AG_OWNER),
    skill(SK_OTHER, WS_OTHER, "other-skill", AG_OUTSIDER),
    // `1.0.0` declares nothing the §7.3 matrix reads → no publish gate ahead of
    // it, so it appears in the Inbox as a REVIEW item and as nothing else.
    version(V1, SK, AG_AUTHOR, "1.0.0", "linted", manifest("low"), T + 1),
    // `2.0.0` is high risk and has no approval row at all: its publish item is
    // the "a gate is ahead of this version" case, ordered by the version's own
    // creation because no decision row has entered the projection yet.
    version(V2, SK, AG_AUTHOR, "2.0.0", "linted", manifest("high"), T + 2),
    // `3.0.0` carries BOTH matrix sources: `risk_high` is read from the signed
    // manifest, `low_evidence_large_blast_radius` also from a registry counter.
    version(V3, SK, AG_AUTHOR, "3.0.0", "verified", manifest("high", { x_ext: { blast_radius: "fleet" } }), T + 3),
    version(V4, SK, AG_AUTHOR, "4.0.0", "published", manifest("low"), T + 4),
    // an unreadable manifest is the fail-closed case: §7.3 yields the single
    // pseudo-condition and the risk level is `unknown`, which is not `low`.
    version(V5, SK, AG_AUTHOR, "5.0.0", "draft", "{ this is not json", T + 5),
    // another workspace's version, high risk, with its own review and approval
    // rows: the scoping assertion has something to fail on.
    version(V_OTHER, SK_OTHER, AG_OUTSIDER, "1.0.0", "linted", manifest("high"), T + 6),
  ];
}

/** The rows whose PHYSICAL order the projection must not depend on. */
function decisionRows(): Row[] {
  const request = (id: string, versionId: string, at: number, note: string): Row => ({
    sql: "INSERT INTO activity_log(id, workspace_id, actor_agent_id, action, subject_id, details_json, created_at_ms) VALUES (?,?,?,'skill.review.request',?,?,?)",
    params: [id, WS, AG_AUTHOR, versionId, JSON.stringify({ note }), at],
  });
  const review = (id: string, versionId: string, verdict: string, note: string | null, at: number): Row => ({
    sql: "INSERT INTO reviews(id, skill_version_id, reviewer_agent_id, verdict, note, created_at_ms) VALUES (?,?,?,?,?,?)",
    params: [id, versionId, AG_REVIEWER, verdict, note, at],
  });
  const publishApproval = (
    id: string,
    versionId: string,
    approver: string,
    decision: string,
    note: string | null,
    at: number,
  ): Row => ({
    sql: "INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, note, created_at_ms) VALUES (?,?,NULL,?, 'publish', ?,?,?)",
    params: [id, versionId, approver, decision, note, at],
  });
  const adoption = (
    id: string,
    versionId: string,
    state: string,
    deadLetterReason: string | null,
    at: number,
  ): Row => ({
    sql: "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, dead_letter_reason, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?,?,?,0,0,?)",
    params: [id, versionId, AG_ADOPTER, state, deadLetterReason, at],
  });
  const adoptionApproval = (
    id: string,
    versionId: string,
    requestId: string,
    approver: string,
    decision: string,
    note: string | null,
    at: number,
  ): Row => ({
    sql: "INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, note, created_at_ms) VALUES (?,?,?,?, 'adopt_high_risk', ?,?,?)",
    params: [id, versionId, requestId, approver, decision, note, at],
  });

  return [
    // --- `1.0.0`: REPEATED REQUESTS around a conditional verdict. The second
    // request is strictly newer than the verdict, so the item is `pending`
    // again and the conditional is still the decision on record.
    request(id26("AL-V1-REQ-1"), V1, T + 10, "first pass please"),
    review(id26("RV-V1-CONDITIONAL"), V1, "conditional", "pin the two unpinned steps", T + 20),
    request(id26("AL-V1-REQ-2"), V1, T + 30, "conditions addressed"),

    // --- `2.0.0`: a rejection, and no later request.
    request(id26("AL-V2-REQ-1"), V2, T + 10, "please review"),
    review(id26("RV-V2-REJECT"), V2, "reject", "shell gate is not satisfiable offline", T + 40),

    // --- `4.0.0`: THE TIE. A request and an approve verdict share T+15, and the
    // verdict's id is the greater of the two, so the verdict is the later row.
    request(id26("AL-V4-REQ-1"), V4, T + 10, "please review"),
    request(id26("AL-V4-REQ-2-TIED"), V4, T + 15, "ping"),
    review(id26("RV-V4-APPROVE-TIED"), V4, "approve", null, T + 15),

    // --- `3.0.0`: SEVERAL HISTORICAL PUBLISH ROWS, and only one of them could
    // ever have opened the gate.
    //
    // The `approved` row is a service principal's. `agents.type='service'` never
    // satisfies the §7.3 human gate, so it does not make the item `approved` —
    // a projection that read the decision column alone would say it did. The
    // two T+60 rows tie, and the denial's id is the greater, so the denial is
    // the item's current `decision`.
    publishApproval(id26("AP-V3-PUB-A-DENIED"), V3, AG_ADMIN, "denied", "wait for the fleet rollout", T + 50),
    publishApproval(id26("AP-V3-PUB-S-SERVICE"), V3, AG_SVC, "approved", "automated", T + 60),
    publishApproval(id26("AP-V3-PUB-Z-DENIED"), V3, AG_OWNER, "denied", "still no", T + 60),

    // --- the adoption lane.
    adoption(REQ_PENDING, V3, "approval_pending", null, T + 70),
    adoption(REQ_APPROVED, V3, "pending", null, T + 71),
    adoption(REQ_DENIED, V3, "dead_letter", "approval_denied", T + 72),
    // a request the delivery machine dead-lettered on an approval denial whose
    // decision row is not reachable — the spec's backstop, and `denied`.
    adoption(REQ_DEAD_ONLY, V3, "dead_letter", "approval_denied", T + 73),
    // an ordinary request that never entered a §7.3 hold: NOT an inbox item.
    adoption(REQ_ORDINARY, V1, "pending", null, T + 74),
    adoptionApproval(id26("AP-REQ2-APPROVED"), V3, REQ_APPROVED, AG_ADMIN, "approved", "one team, one version", T + 80),
    adoptionApproval(id26("AP-REQ3-DENIED"), V3, REQ_DENIED, AG_OWNER, "denied", "not this quarter", T + 90),

    // --- the other workspace's rows. Nothing here may reach the Inbox.
    {
      sql: "INSERT INTO activity_log(id, workspace_id, actor_agent_id, action, subject_id, details_json, created_at_ms) VALUES (?,?,?,'skill.review.request',?,NULL,?)",
      params: [id26("AL-OTHER-REQ"), WS_OTHER, AG_OUTSIDER, V_OTHER, T + 95],
    },
    publishApproval(id26("AP-OTHER-PUB"), V_OTHER, AG_OUTSIDER, "approved", null, T + 96),
  ];
}

export interface FixtureOptions {
  /** `forward` writes the decision rows in the order they are declared;
   *  `reverse` writes exactly the same rows last-first. */
  insertionOrder?: "forward" | "reverse";
  /** Run with `PRAGMA reverse_unordered_selects=ON`, which makes SQLite return
   *  the rows of an unordered query in the opposite order to the one it would
   *  otherwise have chosen — the engine's own way of exposing a reader that
   *  depends on a query plan. */
  reverseUnorderedSelects?: boolean;
}

export function buildInboxFixture(opts: FixtureOptions = {}): Db {
  const db = openMigrated();
  for (const r of graphRows()) db.prepare(r.sql).run(...r.params);
  const decisions = decisionRows();
  // The reversal is TOTAL except where the schema itself forbids it: an
  // `adopt_high_risk` approval names its request and `tg_approval_version_match`
  // reads that request, so an approval written before its request is refused by
  // the database rather than by anything this projection does. Those two rows
  // keep their relative order; every other pair — review against review,
  // request against verdict, approval against approval — is written the other
  // way round, and those are the pairs the projection could have depended on.
  const ordered =
    opts.insertionOrder === "reverse"
      ? [
          ...[...decisions].reverse().filter((r) => r.sql.includes("INSERT INTO adoption_requests")),
          ...[...decisions].reverse().filter((r) => !r.sql.includes("INSERT INTO adoption_requests")),
        ]
      : decisions;
  for (const r of ordered) db.prepare(r.sql).run(...r.params);
  if (opts.reverseUnorderedSelects) db.exec("PRAGMA reverse_unordered_selects=ON");
  return db;
}

/** The `AuthContext` shape the projection takes, for a fixture principal. */
export function ctx(agentId: string, role: string | null, workspaceId: string = WS): {
  agent_id: string;
  workspace_id: string;
  role: any;
  tool_profile: null;
  api_key_id: string;
} {
  return {
    agent_id: agentId,
    workspace_id: workspaceId,
    role: role as any,
    tool_profile: null,
    api_key_id: id26(`KEY-${agentId.slice(0, 12)}`),
  };
}
