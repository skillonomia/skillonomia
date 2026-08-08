// P6 — surface 5, complete. The internal phase plan's P6 row ("Full search
// filters") and Appendix H's conventions:
//
//   "the declared filter set of surface 5 is exactly `q`, `capability`,
//    `runtime`, `tool`, `risk`, `state`, `min_adopted` and `min_rating`, and
//    they combine with AND; `limit` and `cursor` are pagination controls, not
//    filters."
//
// That set is Appendix H's query string together with §6's trust threshold
// ("min outcome count / rating") — `min_adopted` is the outcome-count half and
// `min_rating` the rating half. Each filter in it gets one positive and one
// negative case below.
//
// Every test runs through the REST surface (and the MCP twin for the whole
// set), never against the service object alone: a filter that AND-combines is
// a property of the surface, so these are integration tests of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVersion, lint, publishedVersion, type BuiltVersion } from "./p4-helpers.ts";
import {
  p4Fixture,
  rest,
  mcp,
  adoptThroughSurfaces,
  rateThroughSurface,
  type P4Fixture,
} from "./p6-helpers.ts";
import { SEARCH_FILTERS } from "../src/service.ts";

// --------------------------------------------------------------- the fixture

interface Shape {
  capability: string;
  runtimeIds: string[];
  toolIds: string[];
  risk: "low" | "medium" | "high";
}

/** A reviewed version whose declared groups differ exactly in the filter dimensions. */
function shaped(fx: P4Fixture, slug: string, s: Shape): BuiltVersion {
  const v = createVersion(fx, slug, {
    manifest: {
      title: `${slug} title`,
      capability_statement: s.capability,
      scope: {
        problem_class: "Search-filter fixture with a deterministic declared shape.",
        non_goals: ["Any production use"],
        prerequisites: [],
        risk_level: s.risk,
        // gate 1 (§7.1 schema) binds these two to `high` — a high-risk fixture
        // that skipped them would not lint, and could not reach `reviewed`
        required_approvals: s.risk === "high" ? ["publish", "adopt_high_risk"] : [],
      },
      safety: {
        dependency_manifest: [],
        forbidden_actions: ["Anything outside the fixture command"],
        secrets_policy: "The package carries no secrets.",
        url_allowlist: [],
        sandbox_requirement: s.risk === "high" ? "required" : "recommended",
      },
      runtime: {
        cloud_iam_assumptions: [],
        mcp_dependencies: [],
        model_compat: [{ id: "any", range: "*" }],
        os: ["linux", "macos"],
        runtime_compat: s.runtimeIds.map((id) => ({ id, range: "*" })),
        shell: ["bash", "sh"],
        tool_compat: s.toolIds.map((id) => ({ id, range: "*" })),
      },
    },
  });
  const state = lint(fx, v.versionId);
  if (state !== "linted") throw new Error(`${slug} did not lint clean: ${state}`);
  fx.registry.review(fx.author, v.versionId, { action: "request" });
  const out = fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve" }).response;
  if (out.state !== "reviewed") throw new Error(`${slug} did not reach reviewed: ${out.state}`);
  return v;
}

interface Graph {
  fx: P4Fixture;
  alpha: BuiltVersion;
  beta: BuiltVersion;
  published: BuiltVersion;
}

/**
 * `alpha` and `beta` disagree on EVERY declared filter dimension, so a single
 * query can show one included and the other excluded — that is the negative
 * test the amendment asks for, sharper than "returns nothing".
 */
function graph(): Graph {
  const fx = p4Fixture();
  const alpha = shaped(fx, "alpha-skill", {
    capability: "Alpha automation of invoice reconciliation for the finance fleet.",
    runtimeIds: ["claude-code"],
    toolIds: ["shell"],
    risk: "low",
  });
  const beta = shaped(fx, "beta-skill", {
    capability: "Beta ledger migration procedure for the platform fleet.",
    runtimeIds: ["codex"],
    toolIds: ["jq"],
    risk: "high",
  });
  const published = publishedVersion(fx, "published-skill");
  return { fx, alpha, beta, published };
}

function slugs(body: any): string[] {
  return body.items.map((i: any) => i.slug);
}

function search(fx: P4Fixture, query: string, key = fx.keys.member): any {
  const res = rest(fx, "GET", `/v1/skills${query}`, key);
  assert.equal(res.status, 200, res.raw);
  return res.body;
}

// ------------------------------------------- one positive + one negative each

test("filter q: matches slug/title/capability, and excludes the version that does not", () => {
  const g = graph();
  const got = slugs(search(g.fx, "?q=alpha"));
  assert.ok(got.includes("alpha-skill"), "positive: the matching version is returned");
  assert.ok(!got.includes("beta-skill"), "negative: the non-matching version is excluded");
  assert.deepEqual(slugs(search(g.fx, "?q=no-such-capability-anywhere")), [], "a value nothing matches returns nothing");
  g.fx.db.close();
});

test("filter capability: substring of capability_statement only", () => {
  const g = graph();
  const got = slugs(search(g.fx, "?capability=ledger%20migration"));
  assert.ok(got.includes("beta-skill"));
  assert.ok(!got.includes("alpha-skill"));
  // the filter reads capability_statement, not the slug: a slug-only match is excluded
  assert.deepEqual(slugs(search(g.fx, "?capability=beta-skill")), []);
  g.fx.db.close();
});

test("filter runtime: declared runtime_compat matcher id", () => {
  const g = graph();
  const got = slugs(search(g.fx, "?runtime=codex"));
  assert.ok(got.includes("beta-skill"));
  assert.ok(!got.includes("alpha-skill"));
  const other = slugs(search(g.fx, "?runtime=claude-code"));
  assert.ok(other.includes("alpha-skill"));
  assert.ok(!other.includes("beta-skill"));
  g.fx.db.close();
});

test("filter tool: declared tool_compat matcher id", () => {
  const g = graph();
  const got = slugs(search(g.fx, "?tool=jq"));
  assert.ok(got.includes("beta-skill"));
  assert.ok(!got.includes("alpha-skill"));
  const other = slugs(search(g.fx, "?tool=shell"));
  assert.ok(other.includes("alpha-skill"));
  assert.ok(!other.includes("beta-skill"));
  g.fx.db.close();
});

test("filter risk: declared scope.risk_level", () => {
  const g = graph();
  const high = slugs(search(g.fx, "?risk=high"));
  assert.ok(high.includes("beta-skill"));
  assert.ok(!high.includes("alpha-skill"));
  const low = slugs(search(g.fx, "?risk=low"));
  assert.ok(low.includes("alpha-skill"));
  assert.ok(!low.includes("beta-skill"));
  g.fx.db.close();
});

test("filter state: lifecycle state, exact", () => {
  const g = graph();
  const published = slugs(search(g.fx, "?state=published"));
  assert.ok(published.includes("published-skill"));
  assert.ok(!published.includes("alpha-skill"), "a reviewed version is not a published one");
  const reviewed = slugs(search(g.fx, "?state=reviewed"));
  assert.ok(reviewed.includes("alpha-skill"));
  assert.ok(!reviewed.includes("published-skill"));
  g.fx.db.close();
});

test("filter min_adopted: the outcome-count half of §6's trust threshold", () => {
  const g = graph();
  // one real adoption of alpha, through the surfaces only
  adoptThroughSurfaces(g.fx, g.alpha, g.fx.keys.member);
  const got = slugs(search(g.fx, "?min_adopted=1"));
  assert.ok(got.includes("alpha-skill"), "positive: one server-validated adopted receipt");
  assert.ok(!got.includes("beta-skill"), "negative: a version with no adoption is excluded");
  assert.deepEqual(slugs(search(g.fx, "?min_adopted=2")), [], "the threshold is a floor, not a flag");
  assert.ok(slugs(search(g.fx, "?min_adopted=0")).includes("beta-skill"), "0 admits everything");
  g.fx.db.close();
});

test("filter min_rating: the rating half of §6's trust threshold", () => {
  const g = graph();
  const a = adoptThroughSurfaces(g.fx, g.alpha, g.fx.keys.member);
  rateThroughSurface(g.fx, g.alpha, g.fx.keys.member, a.receiptId, 5);
  const b = adoptThroughSurfaces(g.fx, g.published, g.fx.keys.admin);
  rateThroughSurface(g.fx, g.published, g.fx.keys.admin, b.receiptId, 2);

  const strong = slugs(search(g.fx, "?min_rating=4"));
  assert.ok(strong.includes("alpha-skill"), "positive: avg 5 clears a 4 threshold");
  assert.ok(!strong.includes("published-skill"), "negative: avg 2 does not");
  assert.ok(!strong.includes("beta-skill"), "an UNRATED version fails a rating threshold, never passes by default");
  assert.ok(slugs(search(g.fx, "?min_rating=2")).includes("published-skill"), "the threshold is inclusive");
  g.fx.db.close();
});

test("pagination: limit is a page size and cursor walks the ordered set exactly once", () => {
  const g = graph();
  const page1 = search(g.fx, "?limit=1&state=reviewed");
  assert.equal(page1.items.length, 1, "positive: limit bounds the page");
  assert.ok(page1.next_cursor, "more reviewed versions exist");
  const page2 = search(g.fx, `?limit=1&state=reviewed&cursor=${encodeURIComponent(page1.next_cursor)}`);
  assert.equal(page2.items.length, 1);
  assert.notEqual(page1.items[0].skill_version_id, page2.items[0].skill_version_id, "negative: page 2 excludes page 1");
  const all = slugs(search(g.fx, "?state=reviewed"));
  assert.deepEqual([...slugs(page1), ...slugs(page2)], all.slice(0, 2), "the pages are a prefix of the full order");
  g.fx.db.close();
});

// ------------------------------------------------------------ AND semantics

test("Appendix H: all declared filters combine with AND — one unmet clause excludes the version", () => {
  const g = graph();
  adoptThroughSurfaces(g.fx, g.alpha, g.fx.keys.member);

  // each clause alone matches something…
  assert.ok(slugs(search(g.fx, "?q=beta")).includes("beta-skill"));
  assert.ok(slugs(search(g.fx, "?runtime=claude-code")).includes("alpha-skill"));
  // …and the conjunction of clauses that no single version satisfies is empty
  assert.deepEqual(slugs(search(g.fx, "?q=beta&runtime=claude-code")), [], "q ∧ runtime is a conjunction");
  assert.deepEqual(slugs(search(g.fx, "?risk=high&min_adopted=1")), [], "risk ∧ min_adopted is a conjunction");
  assert.deepEqual(slugs(search(g.fx, "?state=reviewed&tool=jq&risk=low")), [], "three clauses, still AND");

  // the full conjunction alpha DOES satisfy still returns it
  const full = slugs(
    search(
      g.fx,
      "?q=alpha&capability=invoice&runtime=claude-code&tool=shell&risk=low&state=reviewed&min_adopted=1&min_rating=1",
    ),
  );
  assert.deepEqual(full, [], "min_rating=1 with no rating excludes even a full match");

  const a = g.fx.db.prepare("SELECT id FROM adoption_receipts WHERE skill_version_id=?").get(g.alpha.versionId) as any;
  rateThroughSurface(g.fx, g.alpha, g.fx.keys.member, a.id, 4);
  const full2 = slugs(
    search(
      g.fx,
      "?q=alpha&capability=invoice&runtime=claude-code&tool=shell&risk=low&state=reviewed&min_adopted=1&min_rating=4",
    ),
  );
  assert.deepEqual(full2, ["alpha-skill"], "every clause met → the version is returned");
  g.fx.db.close();
});

test("filters NEVER widen §5.1 visibility: a cross-workspace actor matching every clause still sees nothing", () => {
  const g = graph();
  const asOutsider = slugs(search(g.fx, "?q=alpha&runtime=claude-code", g.fx.keys.outsider));
  assert.deepEqual(asOutsider, [], "a reviewed version never crosses the workspace boundary (BLOCKER-9)");
  // the same query is NOT vacuous — an in-workspace member gets the match
  assert.ok(slugs(search(g.fx, "?q=alpha&runtime=claude-code", g.fx.keys.member)).includes("alpha-skill"));
  // and the workspace-policy published version does not cross either (§5.1
  // access-policy precedence caps the state table, never widens it)
  assert.deepEqual(slugs(search(g.fx, "?state=published", g.fx.keys.outsider)), []);
  g.fx.db.close();
});

// ---------------------------------------------------------------- validation

test("out-of-range or mistyped filter values are INVALID_SCHEMA, on both adapters", () => {
  const g = graph();
  for (const query of ["?min_rating=0", "?min_rating=6", "?min_rating=abc", "?risk=extreme", "?state=shiny", "?limit=101"]) {
    const res = rest(g.fx, "GET", `/v1/skills${query}`, g.fx.keys.member);
    assert.equal(res.status, 400, query);
    assert.equal(res.body.error.code, "INVALID_SCHEMA", query);
  }
  const viaMcp = mcp(g.fx, g.fx.keys.member, "skill.search", { min_rating: 9 });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.data.error.code, "INVALID_SCHEMA");
  g.fx.db.close();
});

// ------------------------------------------------------------ adapter parity

test("MCP returns byte-identical results to REST for every declared filter", () => {
  const g = graph();
  const a = adoptThroughSurfaces(g.fx, g.alpha, g.fx.keys.member);
  rateThroughSurface(g.fx, g.alpha, g.fx.keys.member, a.receiptId, 5);

  const cases: Array<[string, Record<string, unknown>]> = [
    ["?q=alpha", { q: "alpha" }],
    ["?capability=invoice", { capability: "invoice" }],
    ["?runtime=codex", { runtime: "codex" }],
    ["?tool=shell", { tool: "shell" }],
    ["?risk=high", { risk: "high" }],
    ["?state=reviewed", { state: "reviewed" }],
    ["?min_adopted=1", { min_adopted: 1 }],
    ["?min_rating=5", { min_rating: 5 }],
    ["?limit=2", { limit: 2 }],
  ];
  for (const [query, args] of cases) {
    const viaRest = search(g.fx, query);
    const viaMcp = mcp(g.fx, g.fx.keys.member, "skill.search", args);
    assert.equal(viaMcp.isError, false, query);
    assert.deepEqual(viaMcp.data, viaRest, `adapters diverge on ${query}`);
  }
  assert.deepEqual(
    [...SEARCH_FILTERS].sort(),
    ["capability", "min_adopted", "min_rating", "q", "risk", "runtime", "state", "tool"],
    "the declared filter set is exactly the one this suite covers",
  );
  g.fx.db.close();
});
