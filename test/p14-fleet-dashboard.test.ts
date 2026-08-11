// §9 — THE FIVE SCREENS, AND THE ONE PLACE AN HONEST SYSTEM STILL LIES.
//
// Work 2's logic is honest. This suite is not about that logic. It is about the
// LAST hundred lines: the render. A screen can take a truthful answer and print
// it as a falsehood, and every one of those falsehoods passes a test that
// inspects the intermediate structure:
//
//   * `unknown` printed as a blank cell, or a dash, or "n/a" [I-1];
//   * `unknown` printed as `no` for a cell §4 says can never say `no` [A-0];
//   * a number printed without one of its three attributes [I-3];
//   * the intent column and the fact column merged into one to fit a phone [I-2];
//   * a colour that encodes "all is well" instead of the state of the
//     reconciliation [D-1];
//   * `loaded` claimed under its own name §4 forbids;
//   * a cell assembled BY HAND, bypassing the builders, so no guard sees it;
//   * a capability that does not exist rendered as an empty table, which reads
//     as "we looked and found nothing" [D-3]/[I-1].
//
// So every assertion below is made against FINISHED BYTES — the rendered page
// and the JSON body a client receives — and every one is paired with a MUTATION
// of the shipped source that must break it. The harness proves its own
// substitution: exactly one occurrence, the sha256 moves, the line before and
// after are printed.
//
// The mutation is loaded through the COPIED `src/service.ts`, so what is
// exercised is the whole pipeline — the registry's own answer, the shipped
// renderer, and the shipped sweep — and not a fragment of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  adoptThroughSurfaces,
  mcp,
  p4Fixture,
  rest,
  reviewedVersion,
  NOW,
  type P4Fixture,
} from "./p6-helpers.ts";
import { makeManifest } from "./p2-helpers.ts";
import { TRANSFER_ACTION } from "../src/transfer.ts";
import { arrivalMarker, embedArrivalStep } from "../src/marker.ts";
import { FixedActivationRoots } from "../src/activation.ts";
import { ForeignValue, renderDashboard, serializeDashboard, type DashboardPayload, type SerializedPayload } from "../src/dashboard.ts";
import { SYNC_STATUSES, columnsOf } from "../src/fleet.ts";
import type { InventoryRoots, InventorySite } from "../src/fleet-scan.ts";
import {
  ABSENT_APPROVAL_CAPABILITIES,
  auditAbsentCapabilities,
  auditRenderedHtml,
  auditRenderedJson,
  cellAttr,
  cellText,
  fieldOfColumn,
  parseTables,
  type RenderAudit,
} from "../src/fleet-dashboard.ts";

// ===========================================================================
// The harness
// ===========================================================================

/** The ANSWER half of a cell — everything before the first method key. Every
 *  row value is a cell now, so a comparison against a bare value reads the
 *  answer rather than the whole method. */
function ans(cell: unknown): string {
  const text = String(cell ?? "");
  const i = text.indexOf(" · ");
  return (i < 0 ? text : text.slice(0, i)).trim();
}

const temps: string[] = [];

function tempBase(prefix = "skln-dash-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return realpathSync(dir);
}

/**
 * A temporary tree for a MUTANT, OUTSIDE this checkout.
 *
 * Outside is not incidental. `npm test` runs the suites concurrently, and this
 * repository has guards that walk its own tree — a mutated copy of `src/` left
 * lying inside the checkout would be read by them as a published file. So the
 * tree lives under the system temporary directory, and `node_modules` is
 * SYMLINKED into it: the mutant loads `src/service.ts`, which reaches `ajv`,
 * and a copy placed inside `node_modules` itself would be refused type
 * stripping. Neither placement is available; a link gives both.
 */
function mutantBase(): string {
  const dir = tempBase("skln-dash-mutant-");
  symlinkSync(new URL("../node_modules", import.meta.url), join(dir, "node_modules"), "dir");
  return dir;
}

process.on("exit", () => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a test that already removed its own tree is not a failure
    }
  }
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A copy of `src/` with ONE substitution in `src/fleet-dashboard.ts`, loaded
 * WHOLE — the copied `service.ts`, the copied renderer, the copied sweep.
 *
 * The substitution is proved rather than trusted, exactly as
 * `test/fleet-inventory.test.ts` proves its own: the template must occur
 * exactly once (zero means the mutation matched nothing and everything after it
 * is vacuous), the replacement must differ from it, the file's sha256 must
 * move, and the line before and after are printed so a reader of the output can
 * see which code was broken.
 */
async function mutantTree(...edits: Array<[from: string, to: string]>): Promise<{
  service: any;
  dashboard: any;
  fleetDashboard: any;
}> {
  const dir = mutantBase();
  cpSync(new URL("../src", import.meta.url), join(dir, "src"), { recursive: true });
  const path = join(dir, "src", "fleet-dashboard.ts");
  const before = readFileSync(path, "utf8");
  const beforeSha = sha256(before);
  let text = before;
  for (const [from, to] of edits) {
    const occurrences = text.split(from).length - 1;
    assert.equal(occurrences, 1, `the mutation template must occur EXACTLY ONCE in fleet-dashboard.ts, found ${occurrences}`);
    assert.notEqual(from, to, "a substitution whose replacement equals its template changes nothing");
    text = text.replace(from, to);
    console.log(`  before: ${from.split("\n")[0]!.trim()}`);
    console.log(`  after : ${to.split("\n")[0]!.trim()}`);
  }
  const afterSha = sha256(text);
  assert.notEqual(afterSha, beforeSha, "the substitution did not change the bytes of fleet-dashboard.ts");
  writeFileSync(path, text);
  console.log(`[mutation] src/fleet-dashboard.ts  sha256 ${beforeSha.slice(0, 12)} → ${afterSha.slice(0, 12)}`);
  return {
    service: await import(pathToFileURL(join(dir, "src", "service.ts")).href),
    dashboard: await import(pathToFileURL(join(dir, "src", "dashboard.ts")).href),
    fleetDashboard: await import(pathToFileURL(join(dir, "src", "fleet-dashboard.ts")).href),
  };
}

/** THE MUTANT MUST DIE: the sweep over the mutated page must report something. */
function mustCatch(what: string, audit: RenderAudit | { violations: Array<{ problem: string }> }): void {
  const violations = audit.violations;
  assert.ok(violations.length > 0, `THE MUTANT SURVIVED: ${what} — this test proves nothing`);
  console.log(`  [killed] ${violations[0]!.problem}`);
}

/**
 * …AND BY THE RIGHT GUARD.
 *
 * A mutant that dies to some other check is a mutant that dies by luck: the
 * guard this case exists to exercise would still be free to be broken. So the
 * violation naming it must be among the ones reported.
 */
function mustCatchBy(
  what: string,
  audit: RenderAudit | { violations: Array<{ problem: string }> },
  guard: RegExp,
): void {
  mustCatch(what, audit);
  const hit = audit.violations.find((v) => guard.test(v.problem));
  assert.ok(hit, `the mutant died, but not to ${guard}: ${audit.violations.map((v) => v.problem).join(" ;; ")}`);
  console.log(`  [by the right guard] ${hit!.problem}`);
}

/** Roots that can be pointed at an agent AFTER the fixture has minted its ids. */
class MutableRoots implements InventoryRoots {
  readonly sites = new Map<string, InventorySite>();
  rootFor(agentId: string): InventorySite | null {
    return this.sites.get(agentId) ?? null;
  }
}

// ===========================================================================
// THE FIXTURE — one graph with everything the five screens are supposed to show
// ===========================================================================

interface Screens {
  fx: P4Fixture;
  roots: MutableRoots;
  claudeAgent: string;
  codexAgent: string;
  alpha: { versionId: string; slug: string; marker: string };
  beta: { versionId: string; slug: string; marker: string };
}

function grant(fx: P4Fixture, agentId: string, action: string): void {
  const res = rest(fx, "POST", "/v1/transfer-grants", fx.keys.owner, {
    agent_id: agentId,
    action,
    recipient_scope: "local_agent",
  });
  assert.equal(res.status, 201, res.raw);
}

/**
 * A graph that DISCRIMINATES: two agents on the two runtimes of §4, one of them
 * with a demonstrated arrival and one with a lone call that is not one, a copy
 * on a disk that resolves to a version and one that does not, an approval
 * decision, and a rating.
 *
 * A screen tested against an empty graph proves nothing at all, so every test
 * below prints what it swept.
 */
function screens(): Screens {
  const base = tempBase();
  const roots = new MutableRoots();
  const activationRoot = join(base, "activation-root");
  mkdirSync(activationRoot, { recursive: true });
  const fx = p4Fixture({ inventory: roots, activation: new FixedActivationRoots(activationRoot, "claude_code_project") });

  const alphaV = reviewedVersion(fx, "dash-alpha");
  const betaV = reviewedVersion(fx, "dash-beta");
  const alpha = { versionId: alphaV.versionId, slug: "dash-alpha", marker: arrivalMarker(alphaV.versionId) };
  const beta = { versionId: betaV.versionId, slug: "dash-beta", marker: arrivalMarker(betaV.versionId) };

  grant(fx, fx.member.agent_id, TRANSFER_ACTION);
  grant(fx, fx.member.agent_id, "activate");
  const claudeAgent = fx.reviewer.agent_id;
  const codexAgent = fx.reviewer2.agent_id;
  for (const [version, recipient] of [
    [alpha.versionId, claudeAgent],
    [beta.versionId, codexAgent],
  ] as const) {
    const pushed = rest(fx, "POST", `/v1/versions/${version}/transfers`, fx.keys.member, {
      recipient: { kind: "local_agent", ref: recipient },
    });
    assert.equal(pushed.status, 201, pushed.raw);
    // ACTIVATED, so the registry INTENDS something for both agents. Without an
    // active deployment the reconciliation is `unknown` for every row and the
    // colour on the fleet screen would be untested.
    const activated = rest(fx, "POST", `/v1/assignments/${pushed.body.assignment_id}/activate`, fx.keys.member, {});
    assert.equal(activated.status, 200, activated.raw);
    assert.equal(activated.body.assignment.intent_state, "active", activated.raw);
  }

  // A DISK for the Claude Code agent: one managed copy carrying the version's
  // §5 arrival block, and one carrying nothing this workspace can resolve — the
  // unidentifiable copy [A-5] exists to make visible.
  const claudeRoot = join(base, "claude-root");
  mkdirSync(join(claudeRoot, ".claude", "skills", alpha.slug), { recursive: true });
  writeFileSync(
    join(claudeRoot, ".claude", "skills", alpha.slug, "SKILL.md"),
    embedArrivalStep("# alpha\n\n## Procedure\n", alpha.versionId, { executableStep: true }),
  );
  mkdirSync(join(claudeRoot, ".claude", "skills", "stray-copy"), { recursive: true });
  writeFileSync(join(claudeRoot, ".claude", "skills", "stray-copy", "SKILL.md"), "# a copy nobody is tracking\n");
  roots.sites.set(claudeAgent, { root: claudeRoot, runtime: "claude_code" });

  const codexRoot = join(base, "codex-root");
  mkdirSync(join(codexRoot, ".agents", "skills"), { recursive: true });
  roots.sites.set(codexAgent, { root: codexRoot, runtime: "codex" });

  // OBSERVATIONS, through the real surface, so the two runtimes answer
  // differently and both answers are the runtime's own.
  grant(fx, fx.owner.agent_id, "report_outcome");
  const live = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: claudeAgent,
    runtime: "claude_code",
    model: "claude-opus-4",
    session_active: true,
    last_activity_ms: NOW,
    window: "live_session",
    window_detail: "one live session, enumerating what it was offered",
    proposal_inventory_complete: true,
    records: [
      { role: "proposal", call_id: "p-1", at_ms: NOW, text: `offered ${alpha.marker}` },
      { role: "call", call_id: "k-1", at_ms: NOW, text: `starting ${alpha.marker}` },
      { role: "output", call_id: "k-1", at_ms: NOW + 10, text: `done ${alpha.marker}`, result: "success", evidence: { exit_code: 0 } },
    ],
  });
  assert.equal(live.status, 201, live.raw);
  const lone = rest(fx, "POST", "/v1/observations", fx.keys.owner, {
    agent_id: codexAgent,
    runtime: "codex",
    window: "period",
    window_detail: "one session file of the last hour",
    records: [{ role: "call", call_id: "c-1", at_ms: NOW, text: `starting ${beta.marker}` }],
  });
  assert.equal(lone.status, 201, lone.raw);

  return { fx, roots, claudeAgent, codexAgent, alpha, beta };
}

/**
 * The payload AS THE WIRE CARRIES IT. A cell is an object in the payload the
 * registry builds and a string on the wire; `serializeDashboard` is the
 * boundary that flattens one into the other AFTER checking that every row value
 * is one the cell constructor made [B-2].
 */
function payloadOf(fx: P4Fixture, view: string, key: string, query = ""): SerializedPayload {
  const res = rest(fx, "GET", `/v1/dashboard/${view}${query}`, key);
  assert.equal(res.status, 200, res.raw);
  return res.body as SerializedPayload;
}

/** The payload as the REGISTRY builds it — cells, not their texts. */
function builtOf(fx: P4Fixture, view: string): DashboardPayload {
  return fx.registry.dashboard(fx.owner, view);
}

function rawOf(fx: P4Fixture, view: string, key: string): string {
  return rest(fx, "GET", `/v1/dashboard/${view}`, key).raw;
}

function htmlOf(fx: P4Fixture, view: string, key: string): string {
  const res = rest(fx, "GET", `/v1/dashboard/${view}?format=html`, key);
  assert.equal(res.status, 200, res.raw);
  return res.raw;
}

const SCREENS = ["fleet", "agent", "skill_approval", "capability", "outcomes"] as const;

/** Every cell of one page, as a person sees it. */
function cellsOf(html: string): string[] {
  return parseTables(html).flatMap((t) => t.rows.flatMap((r) => r.cells));
}

/** The cell under `header` in the first row whose `name` column matches. */
function cellUnder(html: string, sectionHeaders: string, header: string, match: (row: string[]) => boolean): string | null {
  for (const table of parseTables(html)) {
    if (!table.headers.includes(sectionHeaders)) continue;
    const i = table.headers.indexOf(header);
    if (i < 0) continue;
    for (const row of table.rows) if (match(row.cells)) return row.cells[i] ?? null;
  }
  return null;
}

// ===========================================================================
// 1. THE FIVE SCREENS EXIST, CARRY DATA, AND THE TWO ADAPTERS SERVE ONE ANSWER
// ===========================================================================

test("§9's five screens are served by both adapters, and none of them is an empty page", () => {
  const s = screens();
  for (const view of SCREENS) {
    const payload = payloadOf(s.fx, view, s.fx.keys.owner);
    assert.equal(payload.view, view);
    const viaMcp = mcp(s.fx, s.fx.keys.owner, "dashboard.view", { view });
    assert.equal(viaMcp.isError, false, `${view}: MCP refused the view`);
    assert.deepEqual(viaMcp.data, payload, `${view}: the adapters serve one payload`);

    const rows = payload.sections.reduce((n, sec) => n + sec.rows.length, 0);
    console.log(`[§9] ${view}: ${payload.sections.length} section(s), ${rows} row(s), ${payload.notices.length} notice(s)`);
    assert.ok(rows > 0, `${view} rendered no row at all: a check over an empty set proves nothing`);

    // …and the page is a rendering of that payload, never a second source
    const html = htmlOf(s.fx, view, s.fx.keys.owner);
    assert.equal(html, renderDashboard(builtOf(s.fx, view)));
    assert.deepEqual(serializeDashboard(builtOf(s.fx, view)), payload, `${view}: the wire payload is the flattened one`);
    assert.equal(mcp(s.fx, s.fx.keys.owner, "dashboard.view", { view, format: "html" }).data.html, html);
  }
  s.fx.db.close();
});

// ===========================================================================
// 2. THE SWEEP OVER FINISHED BYTES
// ===========================================================================

test("the shipped sweep runs over the rendered page AND the JSON body, and finds nothing wrong", () => {
  const s = screens();
  let states = 0;
  let numbers = 0;
  let cells = 0;
  for (const view of SCREENS) {
    const html = htmlOf(s.fx, view, s.fx.keys.owner);
    const json = rawOf(s.fx, view, s.fx.keys.owner);
    const onPage = auditRenderedHtml(html);
    const onWire = auditRenderedJson(json);
    console.log(
      `[sweep] ${view}: page ${onPage.cells} cell(s) / ${onPage.state_cells} state / ${onPage.number_cells} number — wire ${onWire.cells} cell(s)`,
    );
    assert.deepEqual(onPage.violations, [], `${view}: the rendered page`);
    assert.deepEqual(onWire.violations, [], `${view}: the JSON body`);
    assert.equal(onPage.cells, onWire.cells, `${view}: the page and the body carry the same cells`);
    states += onPage.state_cells;
    numbers += onPage.number_cells;
    cells += onPage.cells;
  }
  console.log(`[sweep] TOTAL over the five screens: ${cells} cells, ${states} state cells, ${numbers} numbers`);
  assert.ok(cells > 200, "the sweep must have swept something");
  assert.ok(states > 10, "no §4 state cell reached a page: the sweep is vacuous for [A-0] and for `loaded`");
  assert.ok(numbers > 10, "no attributed number reached a page: the sweep is vacuous for [I-3]");
  s.fx.db.close();
});

test("[I-1] DEGENERATE 1: not one cell of the five screens is blank, a dash or an `n/a`", async () => {
  const s = screens();
  let swept = 0;
  for (const view of SCREENS) {
    for (const cell of cellsOf(htmlOf(s.fx, view, s.fx.keys.owner))) {
      swept += 1;
      assert.notEqual(cell, "", `${view}: an EMPTY cell`);
      assert.ok(!["—", "–", "-", "n/a", "N/A", "null", "undefined", "?"].includes(cell), `${view}: a placeholder cell ${cell}`);
    }
  }
  console.log(`[I-1] ${swept} rendered cells, none of them blank`);
  assert.ok(swept > 200, "the cell sweep found nothing to check");

  // MUTATION 1a — `unknown` printed as nothing at all.
  const blanked = await mutantTree([
    `  const answer = plain(input.answer, "unknown");`,
    `  if (input.answer === null) return mintCell("");
  const answer = plain(input.answer, "unknown");`,
  ]);
  const registryA = new blanked.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const pageA = blanked.dashboard.renderDashboard(registryA.dashboard(s.fx.owner, "fleet"));
  mustCatch("an `unknown` observation rendered as an EMPTY cell [I-1]", blanked.fleetDashboard.auditRenderedHtml(pageA));
  assert.ok(pageA.includes("<td></td>"), "the mutation must actually have produced an empty cell");

  // MUTATION 1b — `unknown` printed as the dash a spreadsheet would use.
  const dashed = await mutantTree([`  const answer = plain(input.answer, "unknown");`, `  const answer = plain(input.answer, "—");`]);
  const registryB = new dashed.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const pageB = dashed.dashboard.renderDashboard(registryB.dashboard(s.fx.owner, "agent"));
  assert.ok(pageB.includes("<td>—"), "the mutation must actually have produced a dash");
  mustCatch("an unobserved value rendered as `—` [I-1]", dashed.fleetDashboard.auditRenderedHtml(pageB));
  s.fx.db.close();
});

// ===========================================================================
// 3. [A-0] — `unknown` IS NOT `no`, ON THE PAGE
// ===========================================================================

test("[A-0] DEGENERATE 2: Codex `proposed` and `loaded` read `unknown` on the page, and a render as `no` is killed", async () => {
  const s = screens();
  const html = htmlOf(s.fx, "agent", s.fx.keys.owner);
  const tables = parseTables(html).filter((t) => t.headers.includes(fieldOfColumn("proposed")));
  assert.equal(tables.length, 1, "exactly one table publishes Codex's undivided `proposed` column");
  const codex = tables[0]!;
  const iProposed = codex.headers.indexOf(fieldOfColumn("proposed"));
  const iLoaded = codex.headers.indexOf(fieldOfColumn("loaded"));
  assert.ok(codex.rows.length > 0, "the Codex table is empty: this test would prove nothing");
  for (const row of codex.rows) {
    const proposed = row.cells[iProposed]!;
    const loaded = row.cells[iLoaded]!;
    console.log(`[A-0] codex proposed → ${proposed.slice(0, 80)}`);
    assert.ok(proposed.startsWith("unknown"), `Codex \`proposed\` reads \`${proposed.split(" ")[0]}\``);
    assert.ok(loaded.startsWith("unknown"), `Codex \`loaded\` reads \`${loaded.split(" ")[0]}\``);
    assert.notEqual(proposed.split(" ")[0], "no", "[A-0]: `unknown` was rendered as `no`");
    // and the DISTINCTION is visible, not merely the word: the reason says why
    assert.equal(cellAttr(proposed, "why"), "runtime_emits_no_skill_inventory");
  }

  // THE MUTATION: the renderer decides that an unobserved cell is a negative
  // one — the single most damaging thing a screen over this data can do.
  const m = await mutantTree([
    `export function stateCell(c: StateColumn): Cell {
  const why = plain(c.reason, c.value === "yes" ? "observed" : "no_reason_recorded");
  return mint([
    c.value,`,
    `export function stateCell(c: StateColumn): Cell {
  const why = plain(c.reason, c.value === "yes" ? "observed" : "no_reason_recorded");
  return mint([
    c.value === "unknown" ? "no" : c.value,`,
  ]);
  const registry = new m.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const page = m.dashboard.renderDashboard(registry.dashboard(s.fx.owner, "agent"));
  assert.ok(page.includes("no · why: runtime_emits_no_skill_inventory"), "the mutation must actually print `no`");
  // killed by `forbiddenNoClaim` — work 2's own guard, applied to the cells the
  // sweep rebuilt from the PAGE
  mustCatchBy(
    "`unknown` rendered as `no` where §4's matrix forbids `no` [A-0]",
    m.fleetDashboard.auditRenderedHtml(page),
    /\[A-0\].*only `unknown` is establishable/,
  );
  s.fx.db.close();
});

test("§4 DEGENERATE 6: `loaded` is REPORTED and never claimed, and a render that claims it is killed", async () => {
  const s = screens();
  const html = htmlOf(s.fx, "agent", s.fx.keys.owner);
  let checked = 0;
  for (const table of parseTables(html)) {
    const i = table.headers.indexOf(fieldOfColumn("loaded"));
    if (i < 0) continue;
    for (const row of table.rows) {
      const cell = row.cells[i]!;
      checked += 1;
      assert.equal(cellAttr(cell, "claim"), "reported", "`loaded` was published as an explicit claim");
      assert.ok(cell.startsWith("unknown"), `\`loaded\` answered \`${cell.split(" ")[0]}\``);
    }
  }
  console.log(`[§4] ${checked} \`loaded\` cells, every one of them reported and none of them claimed`);
  assert.ok(checked > 0, "no `loaded` cell reached a page: this test proves nothing");

  // THE MUTATION: the classic inference — a call implies the instructions were
  // read, so print `loaded: yes` whenever `invoked` is `yes`.
  const m = await mutantTree([
    `        for (const column of columns) {
          const cell = c.columns.find((x) => x.column === column);`,
    `        for (const column of columns) {
          let cell = c.columns.find((x) => x.column === column);
          if (column === "loaded" && c.columns.some((x) => x.column === "invoked" && x.value === "yes")) {
            cell = { ...cell, value: "yes", reason: null };
          }`,
  ]);
  const registry = new m.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const page = m.dashboard.renderDashboard(registry.dashboard(s.fx.owner, "agent"));
  // killed by `explicitLoadedClaim`, over the page
  mustCatchBy(
    "an EXPLICIT `loaded` claim inferred from an invocation",
    m.fleetDashboard.auditRenderedHtml(page),
    /\[§4\] loaded: `loaded` answered/,
  );
  s.fx.db.close();
});

// ===========================================================================
// 4. [I-3] — A NUMBER CARRIES ITS METHOD, VISIBLY
// ===========================================================================

test("[I-3] DEGENERATE 3: every number on the page shows its state, its source and its boundary", async () => {
  const s = screens();
  let numbers = 0;
  for (const view of SCREENS) {
    for (const cell of cellsOf(htmlOf(s.fx, view, s.fx.keys.owner))) {
      if (cellAttr(cell, "kind") !== "measured_number") continue;
      numbers += 1;
      for (const key of ["state", "source", "window", "boundary"]) {
        const v = cellAttr(cell, key);
        assert.ok(v !== undefined && v.length > 0, `${view}: a number lost its \`${key}\`: ${cell.slice(0, 120)}`);
      }
      // …and the attributes are VISIBLE, not merely parseable: they are in the
      // text a person reads, which is what [I-3] asks for
      assert.ok(cell.includes("state: ") && cell.includes("source: ") && cell.includes("boundary: "));
    }
  }
  console.log(`[I-3] ${numbers} attributed numbers across the five screens`);
  assert.ok(numbers > 10, "no number reached a page: this test proves nothing");

  // THE MUTATION: the source is dropped to make the cell fit a narrow screen.
  const m = await mutantTree([
    `    \`state: \${a.state}\`,
    \`source: \${a.source}\`,`,
    `    \`state: \${a.state}\`,`,
  ]);
  const registry = new m.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const page = m.dashboard.renderDashboard(registry.dashboard(s.fx.owner, "fleet"));
  assert.ok(
    page.includes("kind: measured_number · state: assigned · window:"),
    "the mutation must actually have dropped the source from a number cell",
  );
  // killed by `missingAttribute` — again work 2's own guard, over the page
  mustCatchBy(
    "a number rendered without its SOURCE [I-3]",
    m.fleetDashboard.auditRenderedHtml(page),
    /a number lost its `source`/,
  );
  s.fx.db.close();
});

// ===========================================================================
// 5. [I-2] — TWO COLUMNS, ALWAYS BOTH VISIBLE
// ===========================================================================

test("[I-2] DEGENERATE 4: intent and fact are two columns on every screen that has either, and a merge is killed", async () => {
  const s = screens();
  let tablesChecked = 0;
  for (const view of ["fleet", "agent"] as const) {
    const html = htmlOf(s.fx, view, s.fx.keys.owner);
    for (const table of parseTables(html)) {
      const intent = table.headers.filter((h) => h.startsWith("intent_"));
      const fact = table.headers.filter((h) => h.startsWith("fact_"));
      if (intent.length === 0 && fact.length === 0) continue;
      tablesChecked += 1;
      console.log(`[I-2] ${view}: intent columns ${intent.join(", ")} | fact columns ${fact.join(", ")}`);
      assert.ok(intent.length > 0 && fact.length > 0, `${view}: one of the two columns is missing`);
      for (const h of table.headers) {
        assert.ok(!(h.includes("intent") && h.includes("fact")), `${view}: one column named for both`);
      }
      // the cell under an intent column IS an intent, and never an observation
      const i = table.headers.indexOf(intent[0]!);
      for (const row of table.rows) {
        const cell = row.cells[i]!;
        const kind = cellAttr(cell, "kind");
        if (kind === "state_column") assert.equal(cellAttr(cell, "is"), "intent");
        if (kind === "measured_number") assert.equal(cellAttr(cell, "source"), "registry");
      }
    }
  }
  assert.ok(tablesChecked >= 3, "too few two-column tables were found for this to mean anything");

  // THE MUTATION: the phone is narrow, so the fact column is folded into the
  // intent column and one heading is kept.
  const m = await mutantTree([
    `  "intent_assigned",
  "fact_available",
  "fact_invoked",`,
    `  "intent_assigned",`,
  ]);
  const registry = new m.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const page = m.dashboard.renderDashboard(registry.dashboard(s.fx.owner, "fleet"));
  assert.ok(!page.includes("<th>fact_invoked</th>"), "the mutation must actually have dropped the fact column");
  mustCatch("the fact column dropped, leaving the intent column alone on the page [I-2]", m.fleetDashboard.auditRenderedHtml(page));

  // …and the other direction: one column carrying both, which is the merge
  // BOTH the declared column and the row member are renamed. Renaming only the
  // header would leave the section declaring a field no row carries, and that is
  // refused at the render boundary before the [I-2] question is ever reached —
  // a kill, but by the wrong guard.
  const merged = await mutantTree(
    [`  "intent_assigned",\n  "fact_available",`, `  "intent_and_fact_assigned",\n  "fact_available",`],
    [`      intent_assigned: numberCell(agent.intent_active),`, `      intent_and_fact_assigned: numberCell(agent.intent_active),`],
  );
  const registryM = new merged.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const pageM = merged.dashboard.renderDashboard(registryM.dashboard(s.fx.owner, "fleet"));
  mustCatch("one column named for BOTH the intent and the fact [I-2]", merged.fleetDashboard.auditRenderedHtml(pageM));
  s.fx.db.close();
});

// ===========================================================================
// 6. [D-1] — WHAT THE COLOUR MEANS
// ===========================================================================

test("[D-1] DEGENERATE 5: the colour of a fleet row is the reconciliation state, and a `looks fine` colour is killed", async () => {
  const s = screens();
  const html = htmlOf(s.fx, "fleet", s.fx.keys.owner);
  const table = parseTables(html).find((t) => t.headers.includes("reconciliation_state"));
  assert.ok(table, "the fleet page must publish a reconciliation column");
  const i = table!.headers.indexOf("reconciliation_state");
  const seen = new Set<string>();
  for (const row of table!.rows) {
    const value = row.cells[i]!;
    seen.add(value);
    assert.ok((SYNC_STATUSES as readonly string[]).includes(value), `\`${value}\` is not a reconciliation state`);
    assert.equal(row.cls, `row-${value}`, "the colour and the cell beside it disagree");
  }
  console.log(`[D-1] reconciliation states on the page: ${[...seen].sort().join(", ")}`);
  // an agent NOTHING has reported about must not wear the colour of an agent
  // that reconciled: `unknown` is not `in_sync`
  assert.ok(seen.has("unknown"), "the fixture has no unobserved agent: the discrimination is untested");
  assert.ok(seen.size >= 2, "every row has the same reconciliation state: the colour is untested");
  assert.ok(html.includes(".row-unknown"), "the page must carry the colour rule it uses");
  // the LEGEND says what the colour means, on the page, beside the thing it decodes
  const legend = payloadOf(s.fx, "fleet", s.fx.keys.owner).notices.find((n) => n.kind === "legend");
  assert.ok(legend, "the fleet screen must state what the colour means");
  assert.match(legend!.detail, /STATE OF THE RECONCILIATION/);
  assert.match(legend!.detail, /not a health indicator/);
  assert.ok(html.includes("not a health indicator"), "…and the statement must be ON THE PAGE");

  // THE MUTATION: the colour becomes a mood — green unless something failed.
  const m = await mutantTree([
    `      reconciliation_state: reconciliationCell(agent.sync_status),`,
    `      reconciliation_state: reconciliationCell(agent.sync_status === "failed" ? "failed" : "in_sync"),`,
  ]);
  const registry = new m.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const payload = registry.dashboard(s.fx.owner, "fleet");
  const page = m.dashboard.renderDashboard(payload);
  assert.ok(page.includes('class="row-in_sync"'), "the mutation must actually have painted a row green");
  const audit = m.fleetDashboard.auditRenderedHtml(page);
  mustCatch("a colour that encodes `nothing has failed` instead of the state of the reconciliation [D-1]", audit);
  s.fx.db.close();
});

// ===========================================================================
// 7. DEGENERATE 7 — A CELL ASSEMBLED BY HAND, BYPASSING THE BUILDERS
// ===========================================================================

test("DEGENERATE 7: a cell built by a template instead of by the builders is caught by the sweep over the PAGE", async () => {
  const s = screens();
  // THE MUTATION: a template that "knows" what a cell should look like and
  // writes the word itself. Every guard applied to the STRUCTURE would still
  // see a well-formed StateColumn object and pass; only a sweep over what
  // SHIPPED sees the bare word.
  const m = await mutantTree([
    `          row[fieldOfColumn(column)] = cell
            ? stateCell(cell)`,
    `          row[fieldOfColumn(column)] = cell
            ? (cell.column === "invoked" ? mintCell(cell.value) : stateCell(cell))`,
  ]);
  const registry = new m.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const payload = registry.dashboard(s.fx.owner, "agent");
  const page = m.dashboard.renderDashboard(payload);
  assert.ok(page.includes("<td>unknown</td>") || page.includes("<td>yes</td>"), "the mutation must actually have written a bare word");

  // the guard applied to the INTERMEDIATE structure is happy: the objects the
  // registry built are unchanged and still pass work 2's own checks
  const intermediate = registry.agentCapabilities(s.fx.owner, s.claudeAgent);
  for (const capability of intermediate.capabilities) {
    assert.equal(m.fleetDashboard === null, false);
  }
  console.log("[bypass] the structure the renderer was given is unchanged — only the render lies");

  mustCatch("a three-valued answer written by a template, with no method at all", m.fleetDashboard.auditRenderedHtml(page));
  mustCatch("…and the same cell in the JSON body", m.fleetDashboard.auditRenderedJson(JSON.stringify(payload)));
  s.fx.db.close();
});

// ===========================================================================
// 8. [D-3] — THE HONEST ABSENCE
// ===========================================================================

test("[D-3] DEGENERATE 8: what is NOT built is declared, and rendering it as an empty table is killed", async () => {
  const s = screens();
  const payload = payloadOf(s.fx, "skill_approval", s.fx.keys.owner);
  const absent = payload.notices.filter((n) => n.kind === "capability_absent");
  console.log(`[D-3] declared absent: ${absent.map((n) => n.subject).join(" | ")}`);
  assert.equal(absent.length, 2, "both missing parts of §9's approval screen must be declared");
  assert.match(absent.map((n) => n.detail).join("\n"), /work #9/);
  assert.match(absent.map((n) => n.detail).join("\n"), /work #10/);
  for (const capability of ABSENT_APPROVAL_CAPABILITIES) {
    assert.ok(
      absent.some((n) => n.subject.includes(capability) || n.detail.includes(capability)),
      `\`${capability}\` is not declared absent`,
    );
    for (const section of payload.sections) {
      assert.ok(!section.key.includes(capability), `an empty table for \`${capability}\`, which does not exist`);
      for (const field of section.fields) assert.ok(!field.includes(capability));
    }
  }
  // the declaration is ON THE PAGE, not only in the payload
  const html = htmlOf(s.fx, "skill_approval", s.fx.keys.owner);
  assert.ok(html.includes("notice-capability_absent"), "the page must render the absence block");
  assert.ok(html.includes("NOT BUILT"), "…and say so in words a reader cannot mistake for an empty result");
  assert.deepEqual(auditAbsentCapabilities(rawOf(s.fx, "skill_approval", s.fx.keys.owner)), []);

  // THE MUTATION: the absence becomes an empty table with a friendly caption —
  // which is a claim about the DATA and not about the software.
  const m = await mutantTree([
    `  return [
    {
      key: "approval",`,
    `  return [
    {
      key: "drafts",
      title: "Drafts awaiting marking",
      fields: ["draft_id", "marking", "redaction_preview"],
      rows: [],
      empty: "no draft found",
    },
    {
      key: "approval",`,
  ]);
  const registry = new m.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  const mutated = JSON.stringify(registry.dashboard(s.fx.owner, "skill_approval"));
  assert.ok(mutated.includes("no draft found"), "the mutation must actually have added the empty table");
  mustCatch("an absent capability rendered as an empty table [I-1]", { violations: m.fleetDashboard.auditAbsentCapabilities(mutated) });

  // …and the other half: the notice removed, leaving nothing said at all
  const silent = await mutantTree([
    `    kind: "capability_absent",
    subject: "the register of refusals ([B-5], work #10)",`,
    `    kind: "legend",
    subject: "refusals",`,
  ]);
  const registryS = new silent.service.Registry(s.fx.db, { now: () => NOW, inventory: s.roots });
  mustCatch("a part of the screen that does not exist and is not declared", {
    violations: silent.fleetDashboard.auditAbsentCapabilities(JSON.stringify(registryS.dashboard(s.fx.owner, "skill_approval"))),
  });
  s.fx.db.close();
});

// ===========================================================================
// 9. THE CONTENT EACH SCREEN OWES ITS §9 ROW
// ===========================================================================

test("[D-1] the fleet screen carries the three numbers, the principal, the sync state and the last failure", () => {
  const s = screens();
  const html = htmlOf(s.fx, "fleet", s.fx.keys.owner);
  const table = parseTables(html).find((t) => t.headers.includes("reconciliation_state"))!;
  for (const field of [
    "agent",
    "principal",
    "runtime",
    "model",
    "session_active",
    "intent_assigned",
    "fact_available",
    "fact_invoked",
    "reconciliation",
    "last_failure",
    "last_feedback",
  ]) {
    assert.ok(table.headers.includes(field), `[D-1] the fleet screen omits \`${field}\``);
  }
  const row = table.rows.find((r) => r.cells[0]!.includes(s.claudeAgent));
  assert.ok(row, "the observed agent must be on the fleet screen");
  const at = (name: string): string => row!.cells[table.headers.indexOf(name)]!;
  console.log(`[D-1] ${at("intent_assigned").slice(0, 60)}`);
  console.log(`[D-1] ${at("fact_available").slice(0, 60)}`);
  console.log(`[D-1] ${at("fact_invoked").slice(0, 60)}`);
  // the three numbers are three DIFFERENT measurements, and they say so
  assert.equal(cellAttr(at("intent_assigned"), "source"), "registry");
  assert.equal(cellAttr(at("fact_available"), "source"), "filesystem");
  assert.equal(cellAttr(at("fact_invoked"), "source"), "transcript");
  assert.match(at("principal"), /type: agent/);
  assert.match(at("runtime"), /^claude_code/);
  assert.match(at("model"), /^claude-opus-4/);
  assert.match(at("session_active"), /^yes/);
  // the copy on the disk that resolves to a version, plus the stray one
  assert.equal(at("fact_available").split(" ")[0], "2");
  assert.equal(at("fact_invoked").split(" ")[0], "1", "the PAIR was reported, so one arrival is observed");
  s.fx.db.close();
});

test("[D-2] the agent screen publishes the six states per runtime, the origin, and the never-used block", () => {
  const s = screens();
  const html = htmlOf(s.fx, "agent", s.fx.keys.owner);
  const payload = payloadOf(s.fx, "agent", s.fx.keys.owner);

  // §4's asymmetry survives the render: two tables, two column sets
  const claude = parseTables(html).find((t) => t.headers.includes(fieldOfColumn("proposed_now")))!;
  const codex = parseTables(html).find((t) => t.headers.includes(fieldOfColumn("proposed")))!;
  assert.ok(claude && codex, "each runtime must publish its own table");
  assert.deepEqual(
    claude.headers.filter((h) => h.startsWith("fact_") || h.startsWith("intent_")),
    [...columnsOf("claude_code")].map(fieldOfColumn).sort((a, b) =>
      claude.headers.indexOf(a) - claude.headers.indexOf(b),
    ),
  );
  assert.ok(!codex.headers.includes(fieldOfColumn("proposed_now")), "Codex has no live/historical distinction to publish");

  const alphaRow = claude.rows.find((r) => ans(r.cells[claude.headers.indexOf("name")]) === s.alpha.slug)!;
  assert.ok(alphaRow, "the assigned and registered capability must be on the Claude Code table");
  const at = (name: string): string => alphaRow.cells[claude.headers.indexOf(name)]!;
  console.log(`[D-2] origin      → ${at("origin").slice(0, 90)}`);
  console.log(`[D-2] assigned_by → ${at("assigned_by").slice(0, 90)}`);
  console.log(`[D-2] last_invoked→ ${at("last_invoked").slice(0, 90)}`);
  assert.match(at("origin"), /handed over by transfer/);
  assert.match(at("assigned_by"), /type: agent/);
  assert.match(at("assigned_by"), /principal: role_holder/);
  assert.match(at("version"), /1\.0\.0/);
  assert.match(at("last_invoked"), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(at(fieldOfColumn("registered")).startsWith("yes"), "the managed copy is on the disk");
  assert.ok(at(fieldOfColumn("proposed_now")).startsWith("yes"), "the live session enumerated it");
  assert.ok(at(fieldOfColumn("invoked")).startsWith("yes"), "the PAIR was reported");

  // [A-5]: registered and never demonstrated — the stray copy nobody tracks
  const dead = payload.sections.find((x) => x.key === "never_used")!;
  console.log(`[A-5] never used: ${dead.rows.map((r) => `${ans(r.name)}/${ans(r.reason)}`).join(", ")}`);
  assert.ok(dead.rows.some((r) => ans(r.name) === "stray-copy" && ans(r.reason) === "no_version_identified"));
  const counts = payload.sections.find((x) => x.key === "never_used_counts")!;
  assert.ok(counts.rows.length > 0, "the [A-5] numbers must be published beside the list");
  s.fx.db.close();
});

test("[D-3]/[I-5] the approval screen shows MEANING, and names the TYPE of the principal who decided", () => {
  const s = screens();
  // a decision, recorded through the real surface
  const base = makeManifest({});
  const held = reviewedVersion(s.fx, "dash-risky", {
    manifest: {
      scope: {
        ...base.scope,
        problem_class: "deciding whether a high-risk capability may be adopted at all",
        non_goals: ["it does not provision credentials", "it does not touch production"],
        prerequisites: ["an approved change window"],
        risk_level: "high",
        required_approvals: ["publish", "adopt_high_risk"],
      },
      safety: { ...base.safety, sandbox_requirement: "required" },
    },
  });
  const req = rest(s.fx, "POST", "/v1/adoptions/requests", s.fx.keys.member, { skill_version_id: held.versionId });
  assert.equal(req.body.state, "approval_pending", req.raw);
  const approved = rest(s.fx, "POST", `/v1/versions/${held.versionId}/approvals`, s.fx.keys.owner, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req.body.adoption_request_id,
    note: "sandboxed rollout approved",
  });
  assert.equal(approved.status, 201, approved.raw);

  const html = htmlOf(s.fx, "skill_approval", s.fx.keys.owner);
  const meaning = parseTables(html).find((t) => t.headers.includes("deliberately_excluded"))!;
  const row = meaning.rows.find((r) => ans(r.cells[0]) === "dash-risky")!;
  const at = (n: string): string => row.cells[meaning.headers.indexOf(n)]!;
  console.log(`[B-6] what_it_does          → ${at("what_it_does").slice(0, 90)}`);
  console.log(`[B-6] when_it_applies       → ${at("when_it_applies").slice(0, 90)}`);
  console.log(`[B-6] rights_required       → ${at("rights_required").slice(0, 90)}`);
  console.log(`[B-6] deliberately_excluded → ${at("deliberately_excluded").slice(0, 90)}`);
  assert.match(at("when_it_applies"), /deciding whether a high-risk capability/);
  assert.match(at("rights_required"), /risk: high/);
  assert.match(at("rights_required"), /sandbox: /);
  assert.match(at("deliberately_excluded"), /it does not touch production/);
  // [I-3]: what went in is TWO NUMBERS with their method, not two figures
  // inside a sentence — `steps: N | files: N` was invisible to the sweep
  for (const n of ["steps", "files"]) {
    assert.equal(cellAttr(at(n), "kind"), "measured_number", `${n} is published as a number cell`);
    assert.match(at(n), /^(\d+|unknown) /, `${n} is a figure or the word`);
  }
  assert.match(at("steps"), /^\d+ /, "the fixture must declare steps, or the check is vacuous");
  assert.match(at("approval_required"), /adopt_high_risk/);
  assert.match(at("approval_state"), /adopt_high_risk: approved/);
  // [B-6]: the MANIFEST is not what is shown
  assert.ok(!html.includes("capability_statement\":"), "the screen must not be the manifest JSON");

  // [B-7]/[I-5]: the decision names the principal TYPE, and distinguishes the
  // workspace owner from a principal merely holding a role
  const decisions = parseTables(html).find((t) => t.headers.includes("approved_by"))!;
  const decision = decisions.rows.find((r) => ans(r.cells[decisions.headers.indexOf("slug")]) === "dash-risky")!;
  const approver = decision.cells[decisions.headers.indexOf("approved_by")]!;
  console.log(`[I-5] approved_by → ${approver.slice(0, 110)}`);
  assert.match(approver, /type: human/);
  assert.match(approver, /role: owner/);
  assert.match(approver, /principal: workspace_owner/);
  assert.ok(!approver.includes("role_holder"), "the owner must not be shown as a mere role holder");
  s.fx.db.close();
});

test("[D-4] the capability screen carries the origin, the diff, the holders, the migration counter and the rollback", () => {
  const s = screens();
  const html = htmlOf(s.fx, "capability", s.fx.keys.owner);
  const table = parseTables(html).find((t) => t.headers.includes("migrations"))!;
  const row = table.rows.find((r) => ans(r.cells[0]) === s.alpha.slug)!;
  const at = (n: string): string => row.cells[table.headers.indexOf(n)]!;
  console.log(`[D-4] origin     → ${at("origin").slice(0, 100)}`);
  console.log(`[D-4] diff       → ${at("diff").slice(0, 100)}`);
  console.log(`[D-4] assigned_to→ ${at("assigned_to").slice(0, 100)}`);
  console.log(`[D-4] migrations → ${at("migrations").slice(0, 100)}`);
  console.log(`[D-4] rollback   → ${at("rollback_steps").slice(0, 100)} · ${at("rollback").slice(0, 80)}`);
  assert.match(at("origin"), /author: /);
  assert.match(at("diff"), /^unknown/, "a first version has no predecessor, and says so rather than showing nothing");
  assert.match(at("diff"), /there is no predecessor to compare with/);
  assert.ok(at("assigned_to").startsWith(s.claudeAgent), "the recipient of the transfer must be named");
  assert.equal(cellAttr(at("migrations"), "kind"), "measured_number");
  assert.equal(cellAttr(at("rollback_steps"), "kind"), "measured_number", "a declared step count is a number cell [I-3]");
  assert.match(at("rollback_steps"), /^\d+ /, "the fixture must declare a rollback, or the check is vacuous");
  for (const n of ["worked", "broke", "rolled_back"]) assert.equal(cellAttr(at(n), "kind"), "measured_number");
  s.fx.db.close();
});

test("[D-5] the results screen separates `nothing was reported` from `it worked`", () => {
  const s = screens();
  const html = htmlOf(s.fx, "outcomes", s.fx.keys.owner);
  const table = parseTables(html).find((t) => t.headers.includes("verdict"))!;
  const row = table.rows.find((r) => ans(r.cells[0]) === s.alpha.slug)!;
  const at = (n: string): string => row.cells[table.headers.indexOf(n)]!;
  console.log(`[D-5] verdict → ${at("verdict")} — ${at("why").slice(0, 110)}`);
  assert.equal(ans(at("verdict")), "nothing_reported", "no receipt over this version has closed");
  assert.match(at("why"), /which is not the same as working/);
  assert.equal(at("worked").split(" ")[0], "0");
  assert.match(at("avg_rating"), /^unknown/);
  assert.match(at("failure_modes"), /no failure mode has been reported/);

  // and a version that DID fail is a different verdict, with the reason
  const failing = reviewedVersion(s.fx, "dash-broken");
  adoptThroughSurfaces(s.fx, failing, s.fx.keys.member, { terminal: "failed" });

  const page = htmlOf(s.fx, "outcomes", s.fx.keys.owner);
  const after = parseTables(page).find((t) => t.headers.includes("verdict"))!;
  const broken = after.rows.find((r) => ans(r.cells[0]) === "dash-broken")!;
  const atB = (n: string): string => broken.cells[after.headers.indexOf(n)]!;
  console.log(`[D-5] verdict → ${atB("verdict")} — ${atB("why").slice(0, 110)}`);
  assert.equal(ans(atB("verdict")), "needs_new_version");
  assert.match(atB("why"), /ended `failed`/);
  assert.equal(atB("broke").split(" ")[0], "1");
  const chains = parseTables(page).find((t) => t.headers.includes("failure_summary"))!;
  assert.ok(
    chains.rows.some((r) => r.cells.join(" ").includes("the declared gate did not pass")),
    "the failure report must be readable on the same screen",
  );
  s.fx.db.close();
});

// ===========================================================================
// 10. [I-7] — NOTHING ON THESE PAGES IS A SECRET OR AN ABSOLUTE PATH
// ===========================================================================

test("[I-7] no §9 screen carries a secret, a key or an absolute path", () => {
  const s = screens();
  const registered = rest(s.fx, "POST", "/v1/webhooks", s.fx.keys.owner, { url: "https://hooks.example/p14" });
  assert.equal(registered.status, 201, registered.raw);
  const secret: string = registered.body.secret;
  const root = s.roots.sites.get(s.claudeAgent)!.root;
  assert.ok(root.startsWith("/"), "the fixture root must be absolute, or this test proves nothing");

  const keys = [s.fx.keys.owner, s.fx.keys.admin, s.fx.keys.member];
  let swept = 0;
  for (const view of SCREENS) {
    for (const key of keys) {
      for (const blob of [rawOf(s.fx, view, key), htmlOf(s.fx, view, key)]) {
        swept += 1;
        assert.ok(!blob.includes(secret), `${view}: the plaintext webhook secret is on the page`);
        assert.ok(!blob.includes("secret_ref") && !blob.includes("secret_hash"), `${view}: a secret handle is on the page`);
        assert.ok(!blob.includes(root), `${view}: an ABSOLUTE PATH of a fleet member is on the page`);
        assert.ok(!blob.includes("/tmp/"), `${view}: an absolute path is on the page`);
        for (const k of keys) assert.ok(!blob.includes(k), `${view}: an API key is on the page`);
      }
    }
  }
  console.log(`[I-7] ${swept} response bodies swept for secrets and absolute paths`);
  s.fx.db.close();
});

// ===========================================================================
// 11. THE RENDER IS NOT A SECOND SOURCE OF TRUTH
// ===========================================================================

test("every value on a §9 page is a value of the API answer the same registry serves", () => {
  const s = screens();
  const caps = rest(s.fx, "GET", `/v1/fleet/${s.claudeAgent}/capabilities`, s.fx.keys.owner).body;
  const html = htmlOf(s.fx, "agent", s.fx.keys.owner);
  const claude = parseTables(html).find((t) => t.headers.includes(fieldOfColumn("proposed_now")))!;
  const row = claude.rows.find((r) => ans(r.cells[claude.headers.indexOf("name")]) === s.alpha.slug)!;
  const apiCapability = caps.capabilities.find((c: any) => c.name === s.alpha.slug);
  assert.ok(apiCapability, "the API answer must carry the same capability");
  let compared = 0;
  for (const column of columnsOf("claude_code")) {
    const api = apiCapability.columns.find((c: any) => c.column === column);
    const cell = row.cells[claude.headers.indexOf(fieldOfColumn(column))]!;
    assert.ok(api, `the API answer has no \`${column}\` column`);
    assert.equal(cell.split(" ")[0], api.value, `${column}: the page and the API disagree`);
    assert.equal(cellAttr(cell, "state"), api.state);
    assert.equal(cellAttr(cell, "source"), api.source);
    assert.equal(cellAttr(cell, "window"), api.window);
    assert.equal(cellAttr(cell, "boundary"), api.window_detail);
    assert.equal(cellAttr(cell, "is"), api.is);
    compared += 1;
  }
  console.log(`[parity] ${compared} columns compared cell by cell against \`agent.capabilities\``);
  assert.equal(compared, columnsOf("claude_code").length);

  const fleetApi = rest(s.fx, "GET", "/v1/fleet", s.fx.keys.owner).body;
  const fleetTable = parseTables(htmlOf(s.fx, "fleet", s.fx.keys.owner)).find((t) => t.headers.includes("reconciliation_state"))!;
  for (const agent of fleetApi.agents) {
    const fleetRow = fleetTable.rows.find((r) => r.cells[0]!.includes(agent.agent_id));
    assert.ok(fleetRow, `the fleet page omits ${agent.agent_id}`);
    assert.equal(fleetRow!.cells[fleetTable.headers.indexOf("reconciliation_state")], agent.sync_status);
    assert.equal(
      fleetRow!.cells[fleetTable.headers.indexOf("intent_assigned")]!.split(" ")[0],
      String(agent.intent_active.value),
    );
  }
  s.fx.db.close();
});

test("the sweep itself discriminates: it is not a function that always answers `no violations`", () => {
  // A guard that cannot fail is not a guard. These are hand-written pages —
  // the shapes the mutations above produce — fed to the SHIPPED sweep.
  const table = (cells: string) => `<table><thead><tr><th>x</th></tr></thead><tbody><tr>${cells}</tr></tbody></table>`;
  assert.ok(auditRenderedHtml(table("<td></td>")).violations.length > 0, "an empty cell must be caught");
  assert.ok(auditRenderedHtml(table("<td>—</td>")).violations.length > 0, "a dash must be caught");
  assert.ok(auditRenderedHtml(table("<td>7</td>")).violations.length > 0, "a bare number must be caught");
  assert.ok(auditRenderedHtml(table("<td>unknown</td>")).violations.length > 0, "a bare `unknown` must be caught");
  assert.ok(
    auditRenderedHtml(
      table(
        "<td>no · why: x · kind: state_column · column: proposed · is: observation · claim: explicit · reliability: reliable · state: proposed · runtime: codex · source: runtime · window: all_time · boundary: b</td>",
      ),
    ).violations.length > 0,
    "[A-0] a `no` where the matrix forbids one must be caught",
  );
  assert.ok(
    auditRenderedHtml(
      table(
        "<td>yes · why: x · kind: state_column · column: loaded · is: observation · claim: reported · reliability: reliable · state: loaded · runtime: codex · source: transcript · window: all_time · boundary: b</td>",
      ),
    ).violations.length > 0,
    "a `loaded` answered anything but `unknown` must be caught",
  );
  assert.ok(
    auditRenderedHtml(table("<td>3 · why: counted · kind: measured_number · state: assigned · window: all_time · boundary: b</td>")).violations
      .length > 0,
    "[I-3] a number without its source must be caught",
  );
  // …and a WELL-FORMED page passes, so the sweep is not simply always angry
  const good = table(
    "<td>unknown · why: no_paired_record · kind: state_column · column: invoked · is: observation · claim: explicit · reliability: reliable · state: invoked · runtime: codex · source: transcript · window: all_time · boundary: b</td>",
  );
  assert.deepEqual(auditRenderedHtml(good).violations, []);
  assert.equal(auditRenderedHtml(good).state_cells, 1);
  assert.equal(cellText("<td>a &amp; b</td>"), "a & b");
});
