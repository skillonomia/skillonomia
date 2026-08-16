// V1 P1 — THE REFUSALS: what a capture that is not a skill leaves behind.
//
// Two families, and they are not the same failure:
//
//   * a request whose SHAPE is wrong — a missing field, a number where a string
//     belongs — is `INVALID_SCHEMA` and records NOTHING. There is nothing to
//     record: no arrival was expressed.
//   * a request that is well-formed and whose CONTENT this registry declines to
//     carry is a 201 whose `outcome` is `refused`. The arrival IS recorded,
//     with the reason, because an owner has to be able to see that the registry
//     answered rather than lost it.
//
// `P1-FR-10` is the one this file exists for: a malformed or unsupported import
// ends in a controlled structured refusal and NEVER in a partial draft. Every
// refusal below is checked against the database as well as against the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture } from "./p4-helpers.ts";
import { rest, mcp } from "./p6-helpers.ts";

const CLAUDE_SKILL = [
  "---",
  "name: rotate-demo-key",
  "description: Rotate the demo signing key.",
  "---",
  "",
  "## Procedure",
  "1. List the keys.",
  "2. Register the replacement.",
].join("\n");

function refused(fx: any, body: unknown, code: string): any {
  const res = rest(fx, "POST", "/v1/captures", fx.keys.owner!, body);
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.outcome, "refused", res.raw);
  assert.equal(res.body.refusal.code, code, res.raw);
  assert.equal(res.body.draft, null, "a refusal never carries a draft");
  return res.body;
}

/** No draft, no revision, no half-written anything — the P1-FR-10 assertion. */
function noPartialDraft(fx: any): void {
  const revisions = fx.db.prepare("SELECT COUNT(*) AS c FROM draft_revisions").get() as { c: number };
  assert.equal(revisions.c, 0, "a refused capture left a draft revision behind");
}

// ===========================================================================
// 1. The six kinds that are not skills
// ===========================================================================

const NOT_SKILLS: ReadonlyArray<{ what: string; text: string; category: string; reason_code: string }> = [
  {
    what: "memory",
    text: "Remember that the owner's preferred timezone is Europe/Berlin.",
    category: "memory",
    reason_code: "NOT_A_PROCEDURE_MEMORY",
  },
  {
    what: "rule",
    text: "Policy: never force-push to main, and always open a pull request. It is our house style.",
    category: "rule",
    reason_code: "NOT_A_PROCEDURE_RULE",
  },
  {
    what: "automation",
    text: "Every morning at 7am a scheduled job should collect the build logs; trigger when a deploy finishes. Use cron.",
    category: "automation",
    reason_code: "NOT_A_PROCEDURE_AUTOMATION",
  },
  {
    what: "connector",
    text: "## Connection\nConnect to the billing api: the base url is on the wiki, authenticate with a service account.",
    category: "connector",
    reason_code: "NOT_A_PROCEDURE_CONNECTOR",
  },
  {
    what: "loadout",
    text: "## Loadout\nLoad these skills for review sessions, and always load that bundle of skills as a session preset.",
    category: "loadout",
    reason_code: "NOT_A_PROCEDURE_LOADOUT",
  },
  {
    what: "one-off",
    text: "One-off for this ticket: patch the config by hand for incident INC-4471, quick and dirty.",
    category: "one_off",
    reason_code: "NOT_A_PROCEDURE_ONE_OFF",
  },
];

test("P1-FR-04: none of the six other kinds is dressed up as a skill", () => {
  for (const row of NOT_SKILLS) {
    const fx = p4Fixture();
    const out = refused(fx, { kind: "workflow", text: row.text }, "NOT_SKILLABLE");
    assert.equal(out.refusal.category, row.category, row.what);
    assert.equal(out.refusal.reason_code, row.reason_code, row.what);
    assert.ok(out.refusal.routing_reason.length > 0, `${row.what}: the refusal says why V1 does not carry it`);
    assert.equal(out.classification.skillable, false);
    noPartialDraft(fx);

    // the arrival IS recorded, with the classifier's answer in columns
    const row2 = fx.db.prepare("SELECT category, skillable, outcome, reason_code FROM captures").get() as any;
    assert.equal(row2.category, row.category);
    assert.equal(row2.skillable, 0);
    assert.equal(row2.outcome, "refused");
    assert.equal(row2.reason_code, row.reason_code);
    fx.db.close();
  }
});

test("a refusal is audited as an event of its own, with its reason in a column", () => {
  const fx = p4Fixture();
  refused(fx, { kind: "workflow", text: NOT_SKILLS[0]!.text }, "NOT_SKILLABLE");
  const events = fx.db.prepare("SELECT event, result, reason_code FROM draft_events ORDER BY id").all() as any[];
  assert.deepEqual(events.map((e) => e.event), ["captured", "classified", "refused"]);
  const refusal = events[2]!;
  assert.equal(refusal.result, "refused");
  assert.equal(refusal.reason_code, "NOT_A_PROCEDURE_MEMORY");
  fx.db.close();
});

// ===========================================================================
// 2. Malformed and unsupported imports
// ===========================================================================

test("P1-FR-10: a native file with no frontmatter is refused as malformed, not parsed leniently", () => {
  const fx = p4Fixture();
  const out = refused(
    fx,
    {
      kind: "native_skill",
      native: {
        runtime: "claude_code",
        path: ".claude/skills/rotate-demo-key/SKILL.md",
        content: "# rotate-demo-key\n\n1. do a thing\n2. do another",
      },
    },
    "MALFORMED_NATIVE_SOURCE",
  );
  assert.match(out.refusal.reason, /frontmatter/);
  noPartialDraft(fx);
  fx.db.close();
});

test("P1-FR-10: frontmatter without `name` and `description`, and a name that disagrees with its directory", () => {
  const fx = p4Fixture();
  refused(
    fx,
    {
      kind: "native_skill",
      native: {
        runtime: "claude_code",
        path: ".claude/skills/rotate-demo-key/SKILL.md",
        content: "---\nname: rotate-demo-key\n---\n\n1. a\n2. b",
      },
    },
    "MALFORMED_NATIVE_SOURCE",
  );
  refused(
    fx,
    {
      kind: "native_skill",
      native: {
        runtime: "claude_code",
        path: ".claude/skills/some-other-name/SKILL.md",
        content: CLAUDE_SKILL,
      },
    },
    "MALFORMED_NATIVE_SOURCE",
  );
  noPartialDraft(fx);
  fx.db.close();
});

test("P1-FR-10: one runtime's form in the other runtime's layout is unsupported, not converted", () => {
  const fx = p4Fixture();
  const out = refused(
    fx,
    {
      kind: "native_skill",
      native: { runtime: "codex", path: ".agents/skills/rotate-demo-key/SKILL.md", content: CLAUDE_SKILL },
    },
    "UNSUPPORTED_NATIVE_SOURCE",
  );
  assert.match(out.refusal.reason, /Codex/);
  noPartialDraft(fx);
  fx.db.close();
});

test("P1-FR-10: a path outside the runtime's own layout is unsupported", () => {
  const fx = p4Fixture();
  refused(
    fx,
    {
      kind: "native_skill",
      native: { runtime: "claude_code", path: "somewhere/else/rotate-demo-key/SKILL.md", content: CLAUDE_SKILL },
    },
    "UNSUPPORTED_NATIVE_SOURCE",
  );
  refused(
    fx,
    {
      kind: "native_skill",
      native: { runtime: "claude_code", path: ".claude/skills/rotate-demo-key/README.md", content: CLAUDE_SKILL },
    },
    "UNSUPPORTED_NATIVE_SOURCE",
  );
  noPartialDraft(fx);
  fx.db.close();
});

test("a native path that tries to leave its root is refused as unsafe", () => {
  const fx = p4Fixture();
  for (const path of [
    "../../.claude/skills/rotate-demo-key/SKILL.md",
    "/etc/.claude/skills/rotate-demo-key/SKILL.md",
    ".claude\\skills\\rotate-demo-key\\SKILL.md",
  ]) {
    refused(fx, { kind: "native_skill", native: { runtime: "claude_code", path, content: CLAUDE_SKILL } }, "UNSAFE_NATIVE_PATH");
  }
  // …and a directory name that is not a name a native location may carry
  refused(
    fx,
    {
      kind: "native_skill",
      native: { runtime: "claude_code", path: ".claude/skills/Rotate Demo Key/SKILL.md", content: CLAUDE_SKILL },
    },
    "UNSAFE_NATIVE_PATH",
  );
  noPartialDraft(fx);
  fx.db.close();
});

test("an empty native file is refused, and so is one that declares itself and says nothing", () => {
  const fx = p4Fixture();
  refused(
    fx,
    { kind: "native_skill", native: { runtime: "claude_code", path: ".claude/skills/x/SKILL.md", content: "   " } },
    "MALFORMED_NATIVE_SOURCE",
  );
  refused(
    fx,
    {
      kind: "native_skill",
      native: {
        runtime: "claude_code",
        path: ".claude/skills/x/SKILL.md",
        content: "---\nname: x\ndescription: nothing follows\n---\n",
      },
    },
    "MALFORMED_NATIVE_SOURCE",
  );
  noPartialDraft(fx);
  fx.db.close();
});

// ===========================================================================
// 3. Ambiguous input, and the shape-level refusals
// ===========================================================================

test("an ambiguous capture is refused as ambiguous rather than filed under one reading", () => {
  const fx = p4Fixture();
  const out = refused(
    fx,
    {
      kind: "workflow",
      text: "Remember that the owner's preferred timezone is Europe/Berlin.\nNever deploy on a Friday, and always ask before a release.",
    },
    "NOT_SKILLABLE",
  );
  assert.equal(out.refusal.category, "ambiguous");
  assert.equal(out.refusal.reason_code, "AMBIGUOUS_SIGNALS");
  assert.match(out.refusal.reason, /equally strong/);
  noPartialDraft(fx);
  fx.db.close();
});

test("a request whose SHAPE is wrong is INVALID_SCHEMA and records nothing", () => {
  const fx = p4Fixture();
  const cases: Array<[unknown, string]> = [
    [{}, "kind must be one of"],
    [{ kind: "nonsense", text: "x" }, "kind must be one of"],
    [{ kind: "workflow" }, "text must be a string"],
    [{ kind: "workflow", text: 42 }, "text must be a string"],
    [{ kind: "session" }, "session must be an object"],
    [{ kind: "session", session: { turns: [] } }, "non-empty array"],
    [{ kind: "session", session: { turns: [{ role: "narrator", text: "x" }] } }, "role must be one of"],
    [{ kind: "native_skill" }, "native must be an object"],
    [{ kind: "native_skill", native: { runtime: "emacs", path: "a/SKILL.md", content: "x" } }, "runtime must be one of"],
  ];
  for (const [body, message] of cases) {
    const res = rest(fx, "POST", "/v1/captures", fx.keys.owner!, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.raw}`);
    assert.equal(res.body.error.code, "INVALID_SCHEMA");
    assert.ok(res.body.error.message.includes(message), res.raw);
  }
  const captures = fx.db.prepare("SELECT COUNT(*) AS c FROM captures").get() as { c: number };
  assert.equal(captures.c, 0, "a request that expressed no arrival recorded none");
  noPartialDraft(fx);
  fx.db.close();
});

test("a source larger than the stated limit is refused before it is stored", () => {
  const fx = p4Fixture();
  const res = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: "x".repeat(100_001) });
  assert.equal(res.status, 413, res.raw);
  assert.equal(res.body.error.code, "LIMIT_EXCEEDED");
  const captures = fx.db.prepare("SELECT COUNT(*) AS c FROM captures").get() as { c: number };
  assert.equal(captures.c, 0);
  fx.db.close();
});

test("both adapters refuse identically", () => {
  const fx = p4Fixture();
  const body = { kind: "workflow", text: NOT_SKILLS[1]!.text };
  const viaRest = rest(fx, "POST", "/v1/captures", fx.keys.owner!, body).body;
  const viaMcp = mcp(fx, fx.keys.owner!, "capture.submit", body);
  assert.equal(viaMcp.isError, false, "a refusal is an ANSWER, not a tool error");
  assert.equal(viaMcp.data.outcome, "refused");
  assert.deepEqual(viaMcp.data.refusal, viaRest.refusal, "one refusal, two adapters");

  const badShape = mcp(fx, fx.keys.owner!, "capture.submit", { kind: "workflow" });
  assert.equal(badShape.isError, true, "a malformed REQUEST is still an error on both");
  assert.equal(badShape.data.error.code, "INVALID_SCHEMA");
  fx.db.close();
});

test("revising a draft that does not exist is NOT_FOUND, and an unknown section is INVALID_SCHEMA", () => {
  const fx = p4Fixture();
  const missing = rest(fx, "POST", "/v1/drafts/01J0000000000000000000000/revisions", fx.keys.owner!, {});
  assert.equal(missing.status, 404, missing.raw);

  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    text: "## Procedure\n1. Run the tests.\n2. Read the failures.\n\nWhenever the build breaks.",
  });
  assert.equal(created.status, 201, created.raw);
  const bad = rest(fx, "POST", `/v1/drafts/${created.body.draft.draft_id}/revisions`, fx.keys.owner!, {
    sections: { provenance: { source_kind: "workflow" } },
  });
  assert.equal(bad.status, 400, bad.raw);
  assert.match(bad.body.error.message, /not an editable section/);
  const revisions = fx.db.prepare("SELECT COUNT(*) AS c FROM draft_revisions").get() as { c: number };
  assert.equal(revisions.c, 1, "a refused edit appended nothing");
  fx.db.close();
});
