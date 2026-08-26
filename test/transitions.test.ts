// §5.1 transition whitelist — full matrix + converging-conflict semantics (defect #1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedGraph, insertVersion, insertLintRun, insertPassingLintRun, insertApproveReview } from "./helpers.ts";
import { GATE_NAMES } from "../src/gates.ts";
import {
  TRANSITION_WHITELIST,
  transitionVersion,
  isLegalTransition,
  lintGatePassed,
  type VersionState,
} from "../src/transitions.ts";

const STATES: VersionState[] = [
  "draft",
  "linted",
  "reviewed",
  "verified",
  "published",
  "deprecated",
  "superseded",
  "revoked",
];

const LEGAL = new Set([
  "draft>linted",
  "linted>reviewed",
  "reviewed>verified",
  "verified>published",
  "published>deprecated",
  "published>superseded",
  "published>revoked",
  // v1.1 §5.1: a version withdrawn from use may afterwards be found unsafe, and
  // the registry has to be able to say so. `revoked` keeps no outgoing edge —
  // attaching a successor to a revoked version is a COLUMN write, not a state
  // change (§5.1b) — so the graph gains exactly these two.
  "deprecated>revoked",
  "superseded>revoked",
]);

// `published` and `verified` are legal edges of the §5.1 graph but neither is
// reachable through the generic transition function:
//   - publication must carry its countersign → publishVersion() is the only
//     entry point (P1 review finding B-3);
//   - `verified` is a conjunction over receipts, attestations, compatibility
//     metadata and a CURRENT eight-gate run (§5.1 conjuncts 1–4), none
//     of which this function can see → verifyVersionTransition() is the only
//     entry point (P4).
// Leaving either open here would make the exported function itself the bypass.
//   - `revoked` is inseparable from the mandatory reason, the optional
//     successor link, the transparency-log append(s) and the adopter notices,
//     all in one transaction → revokeVersion() is the only entry point. It was
//     not gated in v1.0.0 because `published→revoked` was the only edge and the
//     service never used the generic path; v1.1 gives it two more inbound edges,
//     which is exactly when an ungated generic path becomes reachable.
const GATED_TARGETS: Record<string, string> = {
  published: "USE_PUBLISH_VERSION",
  verified: "USE_VERIFY_VERSION",
  revoked: "USE_REVOKE_VERSION",
};

test("whitelist encodes exactly the §5.1 graph (9 legal edges)", () => {
  const edges: string[] = [];
  for (const from of STATES) for (const to of TRANSITION_WHITELIST[from]) edges.push(`${from}>${to}`);
  assert.deepEqual(new Set(edges), LEGAL);
});

test("full matrix: legal transitions succeed, illegal rejected with current_state", () => {
  const s = seedGraph();
  let n = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      if (from === to) continue;
      n += 1;
      const v = insertVersion(s.db, s.skill, s.authorA, `0.0.${n}`, from, s.now);
      // §7.1: `linted` additionally requires a passing gate run, and §6
      // surface 3: `reviewed` additionally requires an eligible approve
      // review. The whitelist matrix under test is the STATE rule, so give
      // every candidate both kinds of evidence and let the whitelist decide.
      insertPassingLintRun(s.db, v, s.now);
      insertApproveReview(s.db, s, v, s.now);
      const res = transitionVersion(s.db, v, to);
      if (GATED_TARGETS[to]) {
        assert.ok(
          !res.ok && res.code === GATED_TARGETS[to],
          `${from}→${to} must route to its dedicated entry point (${GATED_TARGETS[to]})`,
        );
      } else if (LEGAL.has(`${from}>${to}`)) {
        assert.ok(res.ok && !res.noop && res.state === to, `${from}→${to} must succeed`);
      } else {
        assert.ok(!res.ok && res.code === "PRECONDITION_FAILED", `${from}→${to} must be rejected`);
        assert.equal((res as any).current_state, from, `${from}→${to} must return current state`);
      }
      assert.equal(isLegalTransition(from, to), LEGAL.has(`${from}>${to}`));
    }
  }
});

test("defect #1 regression: transition to the current state returns noop:true, never an error", () => {
  const s = seedGraph();
  for (const state of STATES) {
    // publishVersion() / verifyVersionTransition() own these targets and are
    // covered by their own tests
    if (GATED_TARGETS[state]) continue;
    const v = insertVersion(s.db, s.skill, s.authorA, `1.1.${STATES.indexOf(state)}`, state, s.now);
    const res = transitionVersion(s.db, v, state);
    assert.ok(res.ok && res.noop && res.state === state, `noop expected for ${state}→${state}`);
    // repeated call converges identically (no Mako-loop)
    const res2 = transitionVersion(s.db, v, state);
    assert.deepEqual(res2, res);
  }
});

test("`revoked` is the one state with no outgoing edge, and the other two lead only to it", () => {
  // The v1.1 shape of "terminal", and the reason it is not one sentence any
  // more. `revoked` leads NOWHERE: giving it an edge to `superseded` would make
  // the registry surrender the revocation in order to record a replacement,
  // which is the trap §5.1b closes — the successor of a revoked version is a
  // column, not a state. `deprecated` and `superseded` lead ONLY to `revoked`:
  // a version does not come back, and the single further move admitted is the
  // strongest disposition, not a return to service.
  assert.deepEqual([...TRANSITION_WHITELIST.revoked], []);
  assert.deepEqual([...TRANSITION_WHITELIST.deprecated], ["revoked"]);
  assert.deepEqual([...TRANSITION_WHITELIST.superseded], ["revoked"]);
  for (const t of ["deprecated", "superseded", "revoked"] as VersionState[]) {
    assert.ok(
      !TRANSITION_WHITELIST[t].includes("published"),
      `${t} must not return to published`,
    );
  }
});

test("unknown version → NOT_FOUND", () => {
  const s = seedGraph();
  const res = transitionVersion(s.db, "01AAAAAAAAAAAAAAAAAAAAAAAA", "linted");
  assert.ok(!res.ok && res.code === "NOT_FOUND");
});

// §7.1 aggregate, enforced in the transition function itself so this exported
// path is not a gate bypass (P3 verdict 1, blocking #1).
test("draft→linted requires a passing gate run: none, or one with a FAIL, is refused", () => {
  const s = seedGraph();
  const noRun = insertVersion(s.db, s.skill, s.authorA, "2.0.0", "draft", s.now);
  const r1 = transitionVersion(s.db, noRun, "linted");
  assert.ok(!r1.ok && r1.code === "GATES_NOT_PASSED", "no lint run at all must be refused");
  assert.equal((r1 as any).current_state, "draft");
  assert.equal(lintGatePassed(s.db, noRun), false);

  const failed = insertVersion(s.db, s.skill, s.authorA, "2.0.1", "draft", s.now);
  insertLintRun(s.db, failed, s.now, GATE_NAMES.map((g) => [g, g === "secrets" ? "fail" : "pass"]));
  const r2 = transitionVersion(s.db, failed, "linted");
  assert.ok(!r2.ok && r2.code === "GATES_NOT_PASSED", "a FAIL in the latest run must be refused");

  const warned = insertVersion(s.db, s.skill, s.authorA, "2.0.2", "draft", s.now);
  insertLintRun(s.db, warned, s.now, GATE_NAMES.map((g) => [g, g === "shell" ? "warn" : "pass"]));
  const r3 = transitionVersion(s.db, warned, "linted");
  assert.ok(r3.ok && r3.state === "linted", "warn does not block");

  // a later COMPLETE clean run supersedes an earlier failing one
  const rerun = insertVersion(s.db, s.skill, s.authorA, "2.0.3", "draft", s.now);
  insertLintRun(s.db, rerun, s.now, GATE_NAMES.map((g) => [g, g === "secrets" ? "fail" : "pass"]));
  assert.equal(lintGatePassed(s.db, rerun), false);
  insertPassingLintRun(s.db, rerun, s.now + 1000);
  assert.equal(lintGatePassed(s.db, rerun), true);
  assert.ok(transitionVersion(s.db, rerun, "linted").ok);
});

// P3 verdict 2, blocking #1: a partial run is not a run — otherwise a caller
// authorizes the transition with one PASS row while the gates that would have
// failed simply never ran.
test("draft→linted requires a COMPLETE gate run: any missing gate is refused", () => {
  const s = seedGraph();
  const onePass = insertVersion(s.db, s.skill, s.authorA, "3.0.0", "draft", s.now);
  insertLintRun(s.db, onePass, s.now, [["schema", "pass"]]);
  const r1 = transitionVersion(s.db, onePass, "linted");
  assert.ok(!r1.ok && r1.code === "GATES_NOT_PASSED", "a single PASS row must not authorize the transition");
  assert.equal(lintGatePassed(s.db, onePass), false);

  // every 7-of-8 subset is still incomplete
  for (const missing of GATE_NAMES) {
    const v = insertVersion(s.db, s.skill, s.authorA, `3.1.${GATE_NAMES.indexOf(missing)}`, "draft", s.now);
    insertLintRun(s.db, v, s.now, GATE_NAMES.filter((g) => g !== missing).map((g) => [g, "pass"]));
    assert.equal(lintGatePassed(s.db, v), false, `missing ${missing} must not count as a completed run`);
  }

  // an older complete run does not rescue a newer incomplete one
  const stale = insertVersion(s.db, s.skill, s.authorA, "3.2.0", "draft", s.now);
  insertPassingLintRun(s.db, stale, s.now);
  assert.equal(lintGatePassed(s.db, stale), true);
  insertLintRun(s.db, stale, s.now + 1000, [["schema", "pass"]]);
  assert.equal(lintGatePassed(s.db, stale), false, "the NEWEST run is the one that must be complete");
});
