// V1 P1 — CAPTURE → DRAFT, THROUGH THE SURFACES.
//
// Everything here drives `POST /v1/captures` and the draft reads beside it, on
// both adapters where the contract cares. Nothing writes a row it then asserts:
// the arrival, the classification, the draft and its audit are all products of
// the shipped surface.
//
// The four positive paths the contract names are the four this file opens with
// — a workflow, an agent session, a Codex native skill and a Claude Code native
// skill — followed by the compiler contract over every canonical section, the
// determinism of the digest, and the immutability of a revision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture } from "./p4-helpers.ts";
import { rest, mcp } from "./p6-helpers.ts";
import { DRAFT_SECTIONS, COMPILER_VERSION } from "../src/draft.ts";

const WORKFLOW = [
  "# Rotate the demo signing key",
  "",
  "## Purpose",
  "Retire a demo signing key and put its replacement in service without downtime.",
  "",
  "## When to use",
  "Whenever the demo key is older than ninety days.",
  "",
  "## Procedure",
  "1. List the signing keys and note the active kid.",
  "2. Register the replacement key under a new kid.",
  "3. Revoke the retired kid once the replacement answers.",
  "",
  "## Inputs",
  "- the kid to retire",
  "",
  "## Outputs",
  "- the kid now in service",
  "",
  "## Permissions",
  "- registry admin",
  "",
  "## Dependencies",
  "- `skillonomia`",
  "",
  "## Failure modes",
  "- the retired kid was already revoked, and the third step reports it",
].join("\n");

const CLAUDE_SKILL = [
  "---",
  "name: rotate-demo-key",
  "description: Rotate the demo signing key. Use whenever the demo key is older than ninety days.",
  "allowed-tools: Bash, Read",
  "---",
  "",
  "## Procedure",
  "1. List the signing keys and note the active kid.",
  "2. Register the replacement key under a new kid.",
  "3. Revoke the retired kid.",
].join("\n");

const CODEX_SKILL = [
  "# rotate-demo-key",
  "",
  "## Purpose",
  "Rotate the demo signing key.",
  "",
  "## When to use",
  "Whenever the demo key is older than ninety days.",
  "",
  "## Procedure",
  "1. List the signing keys and note the active kid.",
  "2. Register the replacement key under a new kid.",
  "3. Revoke the retired kid.",
].join("\n");

const SESSION_TURNS = [
  { role: "user", text: "how do we rotate the demo signing key?" },
  {
    role: "assistant",
    text: [
      "## Procedure",
      "1. List the signing keys and note the active kid.",
      "2. Register the replacement key under a new kid.",
      "3. Revoke the retired kid once the replacement answers.",
      "Whenever the demo key is older than ninety days, this is the runbook.",
    ].join("\n"),
  },
];

function capture(fx: any, key: string, body: unknown): any {
  const res = rest(fx, "POST", "/v1/captures", key, body);
  assert.equal(res.status, 201, res.raw);
  return res.body;
}

// ===========================================================================
// 1. The three input paths, and the two native formats
// ===========================================================================

test("P1-FR-01: a workflow becomes a versioned draft, with no JSON assembled by the owner", () => {
  const fx = p4Fixture();
  const out = capture(fx, fx.keys.owner!, { kind: "workflow", title: "rotate-demo-key", text: WORKFLOW });
  assert.equal(out.outcome, "drafted");
  assert.equal(out.classification.category, "reusable_procedure");
  assert.equal(out.classification.skillable, true);
  assert.equal(out.draft.revision, 1);
  assert.match(out.draft.content_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(out.draft.compiler_version, COMPILER_VERSION);
  assert.equal(out.draft.content.provenance.source_kind, "workflow");
  assert.equal(out.draft.content.provenance.source_format, "workflow_text");
  fx.db.close();
});

test("P1-FR-01: an agent session becomes a draft, and the session reference is kept as provenance", () => {
  const fx = p4Fixture();
  const out = capture(fx, fx.keys.member!, {
    kind: "session",
    session: { session_ref: "session-2026-08-16-01", turns: SESSION_TURNS },
  });
  assert.equal(out.outcome, "drafted", JSON.stringify(out.refusal));
  assert.equal(out.source_format, "agent_session");
  assert.equal(out.draft.content.provenance.source_ref, "session-2026-08-16-01");
  assert.ok(out.draft.content.procedure.length >= 3, "the assistant's steps became the procedure");
  fx.db.close();
});

test("P1-FR-01: a Claude Code native skill imports, and its frontmatter becomes purpose and title", () => {
  const fx = p4Fixture();
  const out = capture(fx, fx.keys.owner!, {
    kind: "native_skill",
    native: { runtime: "claude_code", path: ".claude/skills/rotate-demo-key/SKILL.md", content: CLAUDE_SKILL },
  });
  assert.equal(out.outcome, "drafted", JSON.stringify(out.refusal));
  assert.equal(out.source_format, "claude_code_skill");
  assert.equal(out.draft.content.title, "rotate-demo-key");
  assert.match(out.draft.content.purpose, /Rotate the demo signing key/);
  assert.deepEqual(out.draft.content.permissions, ["Bash", "Read"], "`allowed-tools` is a REQUESTED permission");
  fx.db.close();
});

test("P1-FR-01: a Codex native skill imports from the layout Codex reads", () => {
  const fx = p4Fixture();
  const out = capture(fx, fx.keys.owner!, {
    kind: "native_skill",
    native: { runtime: "codex", path: ".agents/skills/rotate-demo-key/SKILL.md", content: CODEX_SKILL },
  });
  assert.equal(out.outcome, "drafted", JSON.stringify(out.refusal));
  assert.equal(out.source_format, "codex_skill");
  assert.equal(out.draft.content.title, "rotate-demo-key");
  assert.equal(out.draft.content.provenance.source_ref, ".agents/skills/rotate-demo-key/SKILL.md");
  fx.db.close();
});

// ===========================================================================
// 2. The canonical compiler contract
// ===========================================================================

test("P1-FR-05: the canonical draft carries every required section", () => {
  const fx = p4Fixture();
  const out = capture(fx, fx.keys.owner!, { kind: "workflow", text: WORKFLOW });
  const content = out.draft.content;
  for (const section of DRAFT_SECTIONS) {
    assert.ok(section in content, `the compiled draft has no \`${section}\``);
  }
  assert.match(content.purpose, /Retire a demo signing key/);
  assert.match(content.when_to_use, /ninety days/);
  assert.deepEqual(content.procedure, [
    "List the signing keys and note the active kid.",
    "Register the replacement key under a new kid.",
    "Revoke the retired kid once the replacement answers.",
  ]);
  assert.deepEqual(content.inputs, ["the kid to retire"]);
  assert.deepEqual(content.outputs, ["the kid now in service"]);
  assert.deepEqual(content.permissions, ["registry admin"]);
  assert.deepEqual(content.dependencies, ["`skillonomia`"]);
  assert.equal(content.failure_modes.length, 1);
  assert.deepEqual(content.redactions, []);
  assert.equal(content.provenance.source_digest.slice(0, 7), "sha256:");
  fx.db.close();
});

test("P1-FR-06: a section the capture never stated is EMPTY and reported, never filled in", () => {
  const fx = p4Fixture();
  // a capture that states its purpose and its trigger and nothing else: what is
  // missing is advisory, and the draft is usable
  const thin = "Whenever the log fills up.\n\n1. Rotate the log file.\n2. Restart the collector.";
  const out = capture(fx, fx.keys.owner!, { kind: "workflow", text: thin });
  assert.equal(out.outcome, "drafted", JSON.stringify(out.refusal));
  const review = out.draft.semantic_review;
  assert.equal(review.status, "complete", "nothing blocking is missing from this one");
  assert.ok(review.missing_sections.includes("failure_modes"));
  const missing = review.findings.filter((f: any) => f.code === "missing_section");
  assert.ok(missing.length > 0, "the missing sections are structured findings, not prose");
  for (const finding of missing) {
    assert.equal(finding.severity, "advisory");
    assert.ok((DRAFT_SECTIONS as readonly string[]).includes(finding.section));
    assert.equal(out.draft.content[finding.section].length, 0, "a reported section really is empty");
  }

  // …and a capture that states neither purpose nor trigger is BLOCKED on both,
  // with the sections left empty rather than written on the author's behalf
  const stepsOnly = "## Procedure\n1. Rotate the log file.\n2. Restart the collector.";
  const bare = capture(fx, fx.keys.owner!, { kind: "workflow", text: stepsOnly });
  assert.equal(bare.outcome, "drafted", JSON.stringify(bare.refusal));
  const bareReview = bare.draft.semantic_review;
  assert.equal(bareReview.status, "incomplete");
  const blocking = bareReview.findings.filter((f: any) => f.severity === "blocking");
  assert.deepEqual(
    blocking.map((f: any) => f.section).sort(),
    ["purpose", "when_to_use"],
    "a missing purpose and a missing trigger are what an owner must not approve past",
  );
  assert.equal(bare.draft.content.purpose, "");
  assert.equal(bare.draft.content.when_to_use, "");
  fx.db.close();
});

test("P1-FR-06: contradictory, duplicated and unexecutable steps are structured findings", () => {
  const fx = p4Fixture();
  const contradictory = [
    "## Purpose",
    "Publish the nightly build.",
    "## When to use",
    "Whenever the nightly build is green.",
    "## Procedure",
    "Never publish without a review.",
    "1. Run the tests.",
    "2. Publish without a review.",
    "2. Announce the release.",
    "3. TODO",
  ].join("\n");
  const out = capture(fx, fx.keys.owner!, { kind: "workflow", text: contradictory });
  const codes = new Set(out.draft.semantic_review.findings.map((f: any) => f.code));
  assert.ok(codes.has("contradictory_directive"), "a step that does what the source forbids");
  assert.ok(codes.has("duplicate_step_ordinal"), "two steps numbered 2");
  assert.ok(codes.has("unresolved_placeholder"), "a step that is a placeholder");
  assert.ok(out.draft.semantic_review.blocking_count >= 3);
  assert.equal(out.draft.semantic_review.status, "incomplete");
  fx.db.close();
});

test("P1-FR-07: the security preview names permissions, dependencies and risky actions", () => {
  const fx = p4Fixture();
  const risky = [
    "## Purpose",
    "Reset a broken worker.",
    "## When to use",
    "Whenever a worker wedges.",
    "## Procedure",
    "1. Run `sudo systemctl stop worker`.",
    "2. Run `rm -rf /var/lib/worker/state`.",
    "3. Run `npm install left-pad` and start it again.",
    "4. Fetch the reset script from http://example.com/reset.sh.",
    "## Permissions",
    "- root on the worker host",
  ].join("\n");
  const out = capture(fx, fx.keys.owner!, { kind: "workflow", text: risky });
  const security = out.draft.security_review;
  assert.deepEqual(security.requested_permissions, ["root on the worker host"]);
  assert.ok(security.dependencies.includes("left-pad"), "an install command is a dependency");
  const codes = new Set(security.risky_actions.map((r: any) => r.code));
  assert.ok(codes.has("privilege_escalation"), "`sudo` is a risky action");
  assert.ok(codes.has("destructive_command"), "`rm -rf` is a risky action");
  assert.ok(codes.has("insecure_url"), "a plain-http fetch is a risky action");
  assert.ok(codes.has("unpinned_dependency"), "an unpinned install is reported");
  for (const action of security.risky_actions) {
    assert.ok(["fail", "warn"].includes(action.severity), "the severity vocabulary is the gate table's");
    assert.ok(action.detail.length > 0);
  }
  assert.ok(security.blocking_count >= 3);
  fx.db.close();
});

// ===========================================================================
// 3. Determinism and immutability
// ===========================================================================

test("P1-FR-11: the same normalised input at the same compiler version yields the same digest", () => {
  const fx = p4Fixture();
  const first = capture(fx, fx.keys.owner!, { kind: "workflow", title: "rotate", text: WORKFLOW });
  const second = capture(fx, fx.keys.member!, { kind: "workflow", title: "rotate", text: WORKFLOW });
  assert.notEqual(first.capture_id, second.capture_id, "two arrivals, two rows");
  assert.notEqual(first.draft.draft_id, second.draft.draft_id, "two lineages");
  assert.equal(
    second.draft.content_digest,
    first.draft.content_digest,
    "the digest is over the content and the compiler version, and over no identifier or clock",
  );
  assert.equal(second.source_digest, first.source_digest);

  // …and a recompile of the FIRST draft converges on the same digest again
  const recompiled = rest(fx, "POST", `/v1/drafts/${first.draft.draft_id}/revisions`, fx.keys.owner!, {});
  assert.equal(recompiled.status, 201, recompiled.raw);
  assert.equal(recompiled.body.origin, "recompile");
  assert.equal(recompiled.body.content_digest, first.draft.content_digest, "recompiling is not rewriting");
  fx.db.close();
});

test("P1-FR-12 / INV-06: an edit appends a revision and never touches the one before it", () => {
  const fx = p4Fixture();
  const created = capture(fx, fx.keys.owner!, { kind: "workflow", text: WORKFLOW });
  const draftId = created.draft.draft_id;
  const before = rest(fx, "GET", `/v1/drafts/${draftId}/revisions/${created.draft.revision_id}`, fx.keys.owner!).body;

  const edited = rest(fx, "POST", `/v1/drafts/${draftId}/revisions`, fx.keys.owner!, {
    sections: { purpose: "Retire a demo signing key on a fixed schedule." },
  });
  assert.equal(edited.status, 201, edited.raw);
  assert.equal(edited.body.revision, 2);
  assert.equal(edited.body.parent_revision_id, created.draft.revision_id);
  assert.equal(edited.body.origin, "edit");
  assert.notEqual(edited.body.content_digest, created.draft.content_digest, "different content, different digest");

  const after = rest(fx, "GET", `/v1/drafts/${draftId}/revisions/${created.draft.revision_id}`, fx.keys.owner!).body;
  assert.deepEqual(after.revision, before.revision, "revision 1 is byte-for-byte what it was");
  assert.equal(before.lineage.length, 1, "…and the lineage it sat in has GROWN, which is the other half of the claim");
  assert.equal(after.lineage.length, 2);

  const detail = rest(fx, "GET", `/v1/drafts/${draftId}`, fx.keys.owner!).body;
  assert.equal(detail.revision.revision, 2, "the latest revision is the head of the lineage");
  assert.equal(detail.lineage.length, 2, "and the whole lineage is readable");
  assert.deepEqual(detail.lineage.map((r: any) => r.revision), [1, 2]);

  // the database refuses the update this code never issues
  assert.throws(
    () => fx.db.prepare("UPDATE draft_revisions SET content_json='{}'").run(),
    /INSERT_ONLY/,
    "a revision that could be edited would prove nothing about what an owner approved",
  );
  assert.throws(() => fx.db.prepare("DELETE FROM draft_revisions").run(), /INSERT_ONLY/);
  fx.db.close();
});

test("editing a draft re-runs the semantic and security previews against the edit", () => {
  const fx = p4Fixture();
  const created = capture(fx, fx.keys.owner!, { kind: "workflow", text: WORKFLOW });
  const edited = rest(fx, "POST", `/v1/drafts/${created.draft.draft_id}/revisions`, fx.keys.owner!, {
    sections: { procedure: ["Run `sudo rm -rf /var/lib/worker`."] },
  });
  assert.equal(edited.status, 201, edited.raw);
  const codes = new Set(edited.body.security_review.risky_actions.map((r: any) => r.code));
  assert.ok(codes.has("privilege_escalation"), "the preview is recomputed over what the owner wrote");
  assert.ok(edited.body.semantic_review.findings.some((f: any) => f.code === "single_step_procedure"));
  fx.db.close();
});

// ===========================================================================
// 4. The audit, and the shape of the answer
// ===========================================================================

test("INV-05: every audit event carries its fields as columns, not as a sentence to parse", () => {
  const fx = p4Fixture();
  const created = capture(fx, fx.keys.owner!, {
    kind: "session",
    session: { session_ref: "session-abc", turns: SESSION_TURNS },
  });
  rest(fx, "POST", `/v1/drafts/${created.draft.draft_id}/revisions`, fx.keys.owner!, {
    sections: { purpose: "Rotate the key." },
  });
  const audit = rest(fx, "GET", `/v1/drafts/${created.draft.draft_id}/audit`, fx.keys.owner!);
  assert.equal(audit.status, 200, audit.raw);
  const events = audit.body.items.map((e: any) => e.event);
  assert.deepEqual(events, ["captured", "classified", "compiled", "revised"]);
  for (const event of audit.body.items) {
    for (const field of ["event_id", "event", "capture_id", "actor_agent_id", "actor_role", "source", "result", "server_at_ms"]) {
      assert.ok(event[field] !== undefined && event[field] !== null, `the audit row has no \`${field}\``);
    }
    assert.equal(typeof event.provenance, "object", "the provenance is structured, never a string to parse");
  }
  const classified = audit.body.items.find((e: any) => e.event === "classified");
  assert.equal(classified.provenance.category, "reusable_procedure");
  assert.equal(classified.reason_code, "REUSABLE_PROCEDURE");
  assert.equal(classified.correlation_ref, "session-abc", "the session correlates with its events");
  const compiled = audit.body.items.find((e: any) => e.event === "compiled");
  assert.equal(compiled.content_digest, created.draft.content_digest);
  fx.db.close();
});

test("the two adapters answer with one draft: MCP and REST agree", () => {
  const fx = p4Fixture();
  const viaMcp = mcp(fx, fx.keys.owner!, "capture.submit", { kind: "workflow", text: WORKFLOW });
  assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.data));
  assert.equal(viaMcp.data.outcome, "drafted");
  const draftId = viaMcp.data.draft.draft_id;

  const viaRest = rest(fx, "GET", `/v1/drafts/${draftId}`, fx.keys.owner!);
  const viaMcpGet = mcp(fx, fx.keys.owner!, "draft.get", { draft_id: draftId });
  assert.deepEqual(viaMcpGet.data, viaRest.body, "one answer, two adapters");

  const list = mcp(fx, fx.keys.owner!, "draft.list", {});
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].draft_id, draftId);
  assert.equal(list.data.items[0].latest_revision, 1);
  fx.db.close();
});

test("an idempotency key replays the first answer instead of capturing twice", () => {
  const fx = p4Fixture();
  const body = { kind: "workflow", text: WORKFLOW, idempotency_key: "capture-once" };
  const first = rest(fx, "POST", "/v1/captures", fx.keys.owner!, body);
  const second = rest(fx, "POST", "/v1/captures", fx.keys.owner!, body);
  assert.equal(first.status, 201, first.raw);
  assert.equal(second.status, 201, second.raw);
  assert.equal(second.headers["Idempotency-Replayed"], "true");
  assert.equal(second.raw, first.raw, "the stored bytes of the original answer");
  const count = fx.db.prepare("SELECT COUNT(*) AS c FROM captures").get() as { c: number };
  assert.equal(count.c, 1, "one arrival");
  fx.db.close();
});

test("P1-FR-13 / INV-09: the happy path asks for no manifest, package, signature or storage access", () => {
  const fx = p4Fixture();
  // the whole owner path: capture, read, edit, read again — with a body that
  // carries text and nothing else
  const created = capture(fx, fx.keys.owner!, { kind: "workflow", text: WORKFLOW });
  assert.equal(created.outcome, "drafted");
  const draftId = created.draft.draft_id;
  assert.equal(rest(fx, "GET", "/v1/drafts", fx.keys.owner!).status, 200);
  assert.equal(rest(fx, "GET", `/v1/drafts/${draftId}`, fx.keys.owner!).status, 200);
  assert.equal(
    rest(fx, "POST", `/v1/drafts/${draftId}/revisions`, fx.keys.owner!, { sections: { title: "rotate-demo-key" } }).status,
    201,
  );
  // nothing on that path created a package, a manifest, a signature or a
  // version: the draft domain is beside the package domain, not inside it
  for (const table of ["skill_versions", "attestations", "signing_keys"]) {
    const rows = fx.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    const baseline = table === "skill_versions" ? 1 : 0; // the seed graph's own version
    assert.equal(rows.c, baseline, `capturing a draft wrote to ${table}`);
  }
  fx.db.close();
});

// ===========================================================================
// 5. Visibility
// ===========================================================================

test("a draft is visible in its own workspace and nowhere else", () => {
  const fx = p4Fixture();
  const created = capture(fx, fx.keys.owner!, { kind: "workflow", text: WORKFLOW });
  const outsider = rest(fx, "GET", "/v1/drafts", fx.keys.outsider!);
  assert.equal(outsider.status, 200);
  assert.deepEqual(outsider.body.items, [], "a cross-workspace actor sees no drafts");
  const direct = rest(fx, "GET", `/v1/drafts/${created.draft.draft_id}`, fx.keys.outsider!);
  assert.equal(direct.status, 404, "…and cannot read one by naming it");
  const unauthenticated = rest(fx, "GET", "/v1/drafts", "sk_not_a_key");
  assert.equal(unauthenticated.status, 401);
  fx.db.close();
});

test("editing a draft is an owner or admin action", () => {
  const fx = p4Fixture();
  const created = capture(fx, fx.keys.member!, { kind: "workflow", text: WORKFLOW });
  const asMember = rest(fx, "POST", `/v1/drafts/${created.draft.draft_id}/revisions`, fx.keys.member!, {
    sections: { title: "renamed" },
  });
  assert.equal(asMember.status, 403, asMember.raw);
  const asAdmin = rest(fx, "POST", `/v1/drafts/${created.draft.draft_id}/revisions`, fx.keys.admin!, {
    sections: { title: "renamed" },
  });
  assert.equal(asAdmin.status, 201, asAdmin.raw);
  fx.db.close();
});
