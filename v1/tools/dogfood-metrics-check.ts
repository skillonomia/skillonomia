#!/usr/bin/env node
// P6 — THE DOGFOOD METRICS, COMPUTED FROM THE RECEIPTS.
//
//   node --experimental-strip-types --no-warnings v1/tools/dogfood-metrics-check.ts <database> [--json FILE]
//
// `P6-FR-09` is the requirement this file exists for: the dogfood metrics are
// computed from STRUCTURED RECEIPTS, not from names and not from audit strings.
// So every number below is a query over the registry's own INSERT-only tables,
// and nothing here reads a ledger, a label, a file name or a session's title.
// The ledger is written FROM this output; if it were read INTO it, the count
// would be a transcription and the gate would be measuring its own input.
//
// WHAT A SKILL HAS TO BE TO BE COUNTED — the contract's four clauses, each a
// join rather than a claim:
//   1. it has an APPROVED revision            → `revision_approvals`
//   2. it has an ACTIVE desired assignment    → the latest `skill_assignment_events`
//      row of its assignment says `active`, which is the desired state P3 keeps
//      in an INSERT-only journal rather than in a mutable column
//   3. it has a real INVOCATION receipt       → `runtime_receipts` at stage
//      `invoked`, which P4 files only on a runtime echoing the exact revision
//      and the digest the loadout froze
//   4. it came through the PRODUCT PATH       → its revision descends from a
//      `captures` row, and its origin is `capture`
//
// AND WHAT MAKES A SECOND INVOCATION A REUSE. Two `invoked` receipts of one
// skill lineage in two DIFFERENT `agent_sessions`. A redelivery cannot inflate
// this: a redelivered receipt carries the same `invocation_ref` in the same
// session, so it collapses under the DISTINCT on session id — and the redelivery
// rule of `P5-FR-06` means a second delivery does not even write a row.
//
// USE BY DIFFERENT AGENTS is read off the SESSION's `agent_id`, never off the
// receipt's `reported_by_agent_id`: the reporter is the adapter's evidence
// principal and is the same for every session, so counting reporters would count
// one. The agent that HELD the loadout is the agent that used the skill.
//
// FIXTURE MASQUERADING is the failure this phase is judged on, so it is asserted
// rather than assumed: a counted revision whose origin is not `capture`, or
// which no `captures` row produced, fails the gate. The registry's own demo seed
// writes `skills`/`skill_versions` rows and no `draft_revisions` at all, so a
// seeded package cannot reach these counts — but the check is made anyway,
// because an unasserted absence is not evidence of one.
//
// EXIT CODES, the same as every other harness in this tree:
//   0  every threshold met
//   1  a threshold was not met — reported with the number actually found
//   2  REFUSED — no database to read, or it is not migrated to the P4/P5 tables
import { existsSync, writeFileSync } from "node:fs";
import { openReadOnly } from "../../src/db.ts";

const argv = process.argv.slice(2);
const path = argv.find((a) => !a.startsWith("--"));
const jsonAt = argv.indexOf("--json");
const jsonOut = jsonAt >= 0 ? argv[jsonAt + 1] : null;

if (!path) {
  console.error("REFUSED: name the dogfood database to measure.");
  console.error("usage: dogfood-metrics-check.ts <database> [--json FILE]");
  process.exit(2);
}
if (!existsSync(path)) {
  console.error(`REFUSED: ${path} does not exist.`);
  process.exit(2);
}

const db = openReadOnly(path);
const tables = new Set(
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
);
for (const required of [
  "captures",
  "draft_revisions",
  "revision_approvals",
  "skill_assignments",
  "skill_assignment_events",
  "agent_sessions",
  "session_loadout_entries",
  "runtime_receipts",
  "session_outcomes",
]) {
  if (!tables.has(required)) {
    console.error(`REFUSED: ${path} has no \`${required}\`; this is not a registry migrated past 0017.`);
    process.exit(2);
  }
}

const rows = <T = Record<string, unknown>>(sql: string): T[] => db.prepare(sql).all() as T[];

// The desired state of an assignment is the LATEST row of its journal. P3 keeps
// the journal INSERT-only, so "latest" is the highest `event_seq` and not a
// column somebody could have overwritten.
const ACTIVE_ASSIGNMENTS = `
  SELECT a.id AS assignment_id, a.agent_id, a.draft_id, e.desired_revision_id
  FROM skill_assignments a
  JOIN skill_assignment_events e ON e.assignment_id = a.id
  WHERE e.event_seq = (SELECT MAX(e2.event_seq) FROM skill_assignment_events e2 WHERE e2.assignment_id = a.id)
    AND e.desired_state = 'active'
`;

// One row per REAL INVOCATION: an `invoked` receipt, the skill lineage it names,
// the session it happened in and the agent that held that session's loadout.
const INVOCATIONS = `
  SELECT r.id AS receipt_id, r.session_id, r.draft_revision_id, r.content_digest,
         r.invocation_ref, r.runtime_session_ref,
         v.draft_id, s.agent_id, s.runtime_kind
  FROM runtime_receipts r
  JOIN draft_revisions v ON v.id = r.draft_revision_id
  JOIN agent_sessions s ON s.id = r.session_id
  WHERE r.stage = 'invoked'
`;

const activeByDraft = new Map<string, Array<{ assignment_id: string; agent_id: string }>>();
for (const a of rows<{ assignment_id: string; agent_id: string; draft_id: string }>(ACTIVE_ASSIGNMENTS)) {
  const list = activeByDraft.get(a.draft_id) ?? [];
  list.push({ assignment_id: a.assignment_id, agent_id: a.agent_id });
  activeByDraft.set(a.draft_id, list);
}

const approvedDrafts = new Set(
  rows<{ draft_id: string }>("SELECT DISTINCT draft_id FROM revision_approvals").map((r) => r.draft_id),
);

const invocations = rows<{
  receipt_id: string;
  session_id: string;
  draft_revision_id: string;
  content_digest: string;
  invocation_ref: string;
  runtime_session_ref: string;
  draft_id: string;
  agent_id: string;
  runtime_kind: string;
}>(INVOCATIONS);

// Provenance: a counted revision has to descend from a capture. Anything else is
// the masquerade `P6-FR-08` names.
const provenance = new Map(
  rows<{ id: string; origin: string; capture_id: string | null; capture_kind: string | null }>(
    `SELECT v.id, v.origin, v.capture_id, c.source_kind AS capture_kind
     FROM draft_revisions v LEFT JOIN captures c ON c.id = v.capture_id`,
  ).map((r) => [r.id, r]),
);

interface Skill {
  draft_id: string;
  revisions: Set<string>;
  sessions: Set<string>;
  agents: Set<string>;
  runtimes: Set<string>;
  invocations: number;
  approved: boolean;
  active_assignments: number;
  provenance_ok: boolean;
  provenance_note: string;
}
const skills = new Map<string, Skill>();
for (const i of invocations) {
  let s = skills.get(i.draft_id);
  if (s === undefined) {
    s = {
      draft_id: i.draft_id,
      revisions: new Set(),
      sessions: new Set(),
      agents: new Set(),
      runtimes: new Set(),
      invocations: 0,
      approved: approvedDrafts.has(i.draft_id),
      active_assignments: (activeByDraft.get(i.draft_id) ?? []).length,
      provenance_ok: true,
      provenance_note: "",
    };
    skills.set(i.draft_id, s);
  }
  s.revisions.add(i.draft_revision_id);
  s.sessions.add(i.session_id);
  s.agents.add(i.agent_id);
  s.runtimes.add(i.runtime_kind);
  s.invocations += 1;
  const p = provenance.get(i.draft_revision_id);
  if (p === undefined || p.origin === null || p.capture_id === null) {
    s.provenance_ok = false;
    s.provenance_note = `revision ${i.draft_revision_id} descends from no capture`;
  } else if (p.origin !== "capture" && p.origin !== "revision") {
    s.provenance_ok = false;
    s.provenance_note = `revision ${i.draft_revision_id} has origin \`${p.origin}\``;
  }
}

const counted = [...skills.values()].filter(
  (s) => s.approved && s.active_assignments > 0 && s.invocations > 0 && s.provenance_ok,
);
const reused = counted.filter((s) => s.sessions.size >= 2);
const multiAgent = counted.filter((s) => s.agents.size >= 2);
const runtimesCovered = new Set(counted.flatMap((s) => [...s.runtimes]));

// The two end-to-end runtime rows are about SESSIONS, not about skills: a real
// session of each kind that reached an invocation and an outcome.
const e2e = rows<{ runtime_kind: string; sessions: number }>(`
  SELECT s.runtime_kind, COUNT(DISTINCT s.id) AS sessions
  FROM agent_sessions s
  JOIN runtime_receipts r ON r.session_id = s.id AND r.stage = 'invoked'
  JOIN session_outcomes o ON o.session_id = s.id AND o.outcome = 'worked' AND o.evidence_class = 'runtime_receipt'
  GROUP BY s.runtime_kind
`);
const e2eByKind = new Map(e2e.map((r) => [r.runtime_kind, r.sessions]));

// The improvement cycle and the rollback, each read off the rows that would have
// to exist for it: a descendant revision with a named source outcome, and a
// `rolled_back` outcome naming its target and the lifecycle event behind it.
const improvements = tables.has("revision_sources")
  ? rows<{ revision_id: string; parent_revision_id: string; source_outcome_id: string; goal: string }>(
      `SELECT rs.draft_revision_id AS revision_id, rs.parent_revision_id, rs.source_outcome_id, rs.improvement_goal AS goal
       FROM revision_sources rs`,
    )
  : [];
const confirmedImprovements = tables.has("revision_comparisons")
  ? rows<{ id: string; baseline_revision_id: string; candidate_revision_id: string; verdict: string }>(
      `SELECT id, baseline_revision_id, candidate_revision_id, verdict FROM revision_comparisons WHERE verdict = 'improved'`,
    )
  : [];
const rollbacks = rows<{ id: string; draft_revision_id: string; rollback_to_revision_id: string }>(
  `SELECT id, draft_revision_id, rollback_to_revision_id FROM session_outcomes
   WHERE outcome = 'rolled_back' AND rollback_to_revision_id IS NOT NULL AND rollback_action_event_id IS NOT NULL`,
);

// A redelivery must not have inflated anything. Two `invoked` receipts sharing a
// session and an `invocation_ref` would be one invocation counted twice.
const duplicateInvocations = rows<{ session_id: string; invocation_ref: string; n: number }>(
  `SELECT session_id, invocation_ref, COUNT(*) AS n FROM runtime_receipts
   WHERE stage = 'invoked' GROUP BY session_id, invocation_ref HAVING COUNT(*) > 1`,
);

const metrics = {
  database: path,
  distinct_real_skills: counted.length,
  reused_skills: reused.length,
  multi_agent_skills: multiAgent.length,
  total_invocations: invocations.length,
  distinct_sessions: new Set(invocations.map((i) => i.session_id)).size,
  distinct_agents: new Set(invocations.map((i) => i.agent_id)).size,
  runtimes_covered: [...runtimesCovered].sort(),
  end_to_end_sessions: { codex: e2eByKind.get("codex") ?? 0, claude_code: e2eByKind.get("claude_code") ?? 0 },
  improvement_lineages: improvements.length,
  confirmed_improvements: confirmedImprovements.length,
  proved_rollbacks: rollbacks.length,
  duplicate_invocation_refs: duplicateInvocations.length,
  skills: counted
    .map((s) => ({
      draft_id: s.draft_id,
      revisions: [...s.revisions].sort(),
      invocations: s.invocations,
      sessions: [...s.sessions].sort(),
      agents: [...s.agents].sort(),
      runtimes: [...s.runtimes].sort(),
      reused: s.sessions.size >= 2,
      multi_agent: s.agents.size >= 2,
    }))
    .sort((a, b) => a.draft_id.localeCompare(b.draft_id)),
  uncounted: [...skills.values()]
    .filter((s) => !counted.includes(s))
    .map((s) => ({
      draft_id: s.draft_id,
      approved: s.approved,
      active_assignments: s.active_assignments,
      invocations: s.invocations,
      provenance_ok: s.provenance_ok,
      provenance_note: s.provenance_note,
    })),
};

let failures = 0;
const threshold = (held: boolean, what: string, detail: string) => {
  console.log(`${held ? "PASS" : "FAIL"}  ${what} — ${detail}`);
  if (!held) failures += 1;
};

console.log(`dogfood database: ${path}`);
console.log("");
threshold(metrics.distinct_real_skills >= 10, "P6-FR-01  ten distinct real skills, each active and invoked", `${metrics.distinct_real_skills} counted`);
threshold(metrics.reused_skills >= 5, "P6-FR-02  five reused across different real sessions", `${metrics.reused_skills} reused`);
threshold(metrics.multi_agent_skills >= 2, "P6-FR-03  two skills used by more than one agent identity", `${metrics.multi_agent_skills} multi-agent`);
threshold(metrics.end_to_end_sessions.codex >= 1, "P6-FR-04  a real end-to-end Codex session", `${metrics.end_to_end_sessions.codex} session(s)`);
threshold(
  metrics.end_to_end_sessions.claude_code >= 1,
  "P6-FR-05  a real end-to-end Claude Code session",
  `${metrics.end_to_end_sessions.claude_code} session(s)`,
);
threshold(metrics.confirmed_improvements >= 1, "P6-FR-06  one complete improvement cycle, confirmed", `${metrics.confirmed_improvements} confirmed`);
threshold(metrics.proved_rollbacks >= 1, "P6-FR-07  one proved revision rollback", `${metrics.proved_rollbacks} proved`);
threshold(
  metrics.uncounted.every((u) => u.provenance_ok),
  "P6-FR-08  no counted record traces to a fixture, a seed or a hand-written row",
  `${metrics.uncounted.filter((u) => !u.provenance_ok).length} with broken provenance`,
);
threshold(metrics.duplicate_invocation_refs === 0, "P5-FR-06  no redelivery was counted twice", `${metrics.duplicate_invocation_refs} duplicate refs`);

console.log("");
console.log(
  `${metrics.total_invocations} invocation receipts across ${metrics.distinct_sessions} sessions and ` +
    `${metrics.distinct_agents} agent identities, on ${metrics.runtimes_covered.join(" and ")}`,
);

if (jsonOut !== null) {
  writeFileSync(jsonOut, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(`metrics written to ${jsonOut}`);
}

process.exit(failures === 0 ? 0 : 1);
