// P1 — THE CONSOLE'S NEGATIVE PROBES, AND THE PROOF THAT EACH MEASURES ITS OWN
// GUARD.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `v1p1-p1-console.test.ts`.
//
//   That file asserts that a reviewer is refused, that a session is required,
//   that an HTML selector is refused. This one asserts WHY. A negative probe
//   that would be green with or without the code it names proves nothing: if
//   the call fails for some OTHER reason — a check further down, a foreign key,
//   a precondition the fixture happened to trip — the probe passes and the
//   guard could be deleted tomorrow without a single test turning red. That is
//   not hypothetical here: the route ACL and the service's own ACL are LAYERED
//   on purpose, so several of these calls would still be refused with the route
//   check gone, by something else, and a probe that only compared status codes
//   would report a green that means nothing.
//
//   THE ANSWER IS THE SAME ONE P0 AND `v1p1-p1-probes.test.ts` use: run every
//   probe TWICE — once against the shipped source, which must refuse it, and
//   once against the same source with EXACTLY ONE RULE NEUTRALISED, loaded as a
//   second set of modules, which must answer differently. `[P1.CD]` prints that
//   pair for every rule, and a probe that cannot show the pair fails.
//
//   WHAT "DIFFERENTLY" MEANS, AND WHY IT IS NOT ONLY THE STATUS. Where removing
//   the route ACL leaves a SECOND refusal underneath — the human-approval gate
//   is the case — the outcome compared is the refusal's ORIGIN and not merely
//   its code: the route's refusal names the session role, the service's names
//   the human type, and the pair shows which one answered. That is exactly the
//   property the closure gate asks for, which is that the route ACL is checked
//   BEFORE the service call rather than instead of it.
//
//   THE MUTATION IS OF THE SHIPPED TEXT, not of a copy kept beside it. Each
//   probe names a substring that must occur exactly once in the file it names;
//   a guard that is rewritten or moved makes the probe fail loudly rather than
//   quietly stop discriminating. Nothing is written into `src/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { p4Fixture, createVersion, lint, type P4Fixture } from "./p4-helpers.ts";
import { CONSOLE_COOKIE } from "../src/console-session.ts";
import { NOW } from "./p2-helpers.ts";
import { ulid } from "../src/ulid.ts";
import type { AuthContext } from "../src/auth.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const ORIGIN = "console.local";

/** Where the P1 gate manifest expects this run's evidence. Appended to, never
 *  truncated: a probe log a later run silently replaces is a log that cannot be
 *  compared with the one the reviewer read. */
const EVIDENCE_LOG = join(ROOT, "evidence", "P1", "console-probe.log");
function record(line: string): void {
  try {
    mkdirSync(dirname(EVIDENCE_LOG), { recursive: true });
    appendFileSync(EVIDENCE_LOG, `${line}\n`);
  } catch {
    // The log is evidence, not a dependency: a read-only checkout still runs
    // every assertion below. What must not happen is a probe passing because
    // the log could not be written.
  }
  console.log(line);
}

/** The modules a probe may mutate. Each is copied into a scratch directory with
 *  its edit applied; every other import resolves to the real `src/`, so the
 *  registry under test differs from the shipped one in exactly one place. */
type MutableFile = "http.ts" | "console-v2.ts" | "console-session.ts" | "service.ts" | "approvals.ts";

interface Edit {
  file: MutableFile;
  find: string;
  replace: string;
}

interface MutatedBuild {
  handleRest: (registry: any, req: any) => { status: number; headers: Record<string, string>; body: string };
  Registry: any | null;
}

/**
 * Load the router with one substring replaced, as a module of its own.
 *
 * The imports of every copied file are rewritten to ABSOLUTE paths — into the
 * scratch directory for the files this probe mutates, and into the real `src/`
 * for everything else. Nothing is written into `src/`: a second `.ts` file there
 * would be a source file `git ls-files` does not know about, which
 * `test/p14-r13-probes.test.ts` refuses on sight.
 */
async function mutatedRouter(edits: Edit[]): Promise<MutatedBuild> {
  const dir = mkdtempSync(join(tmpdir(), "skillonomia-console-probe-"));
  // `http.ts` is always copied, because it is the module a probe drives. Any
  // other file an edit names is copied too, and the copies import each other.
  const files: MutableFile[] = ["http.ts", ...edits.map((e) => e.file).filter((f) => f !== "http.ts")];
  // A module a probe mutates is reached through `service.ts`, so `service.ts`
  // is copied whenever anything below it is: an unmodified copy re-pointed at
  // the mutated module is what makes the edit reachable from the router at all.
  if (files.some((f) => f === "approvals.ts" || f === "console-session.ts") && !files.includes("service.ts")) {
    files.push("service.ts");
  }
  const unique = [...new Set(files)];
  const paths = new Map<string, string>(unique.map((f) => [f, join(dir, f)]));

  for (const file of unique) {
    let text = readFileSync(join(SRC, file), "utf8");
    for (const e of edits.filter((x) => x.file === file)) {
      const n = text.split(e.find).length - 1;
      assert.equal(n, 1, `the probe's anchor occurs ${n} times in src/${file}, not once: ${e.find}`);
      text = text.replace(e.find, e.replace);
    }
    text = text.replace(/from "\.\/([A-Za-z0-9_.-]+\.ts)"/g, (_m, name: string) =>
      `from "${(paths.get(name) ?? join(SRC, name)).replace(/\\/g, "/")}"`,
    );
    writeFileSync(paths.get(file)!, text);
  }
  const router = await import(pathToFileURL(paths.get("http.ts")!).href);
  const service = paths.has("service.ts") ? await import(pathToFileURL(paths.get("service.ts")!).href) : null;
  return { handleRest: router.handleRest, Registry: service ? service.Registry : null };
}

interface Call {
  method?: string;
  path: string;
  key?: string;
  cookie?: string;
  csrf?: string;
  body?: unknown;
}

function callWith(
  handle: MutatedBuild["handleRest"],
  registry: any,
  c: Call,
): { status: number; json: any; body: string } {
  const headers: Record<string, string | undefined> = { host: ORIGIN, origin: `http://${ORIGIN}` };
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  if (c.cookie) headers.cookie = `${CONSOLE_COOKIE}=${c.cookie}`;
  if (c.csrf) headers["x-skillonomia-console-csrf"] = c.csrf;
  // A refusal that is NOT an `ApiError` — a `CHECK` the database aborted on,
  // say — leaves the router by `throw` rather than as an envelope. That is a
  // real outcome and often the layered defence answering after the guard above
  // it was removed, so it is encoded here rather than crashing the probe.
  let res: { status: number; headers: Record<string, string>; body: string };
  try {
    res = handle(registry, {
      method: c.method ?? "GET",
      url: c.path,
      headers,
      body: c.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(c.body)),
    });
  } catch (e) {
    return {
      status: 0,
      json: { error: { code: "THROWN", message: `the database or the runtime refused it: ${(e as Error).message}` } },
      body: String((e as Error).message),
    };
  }
  let json: any = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.status, json, body: res.body };
}

/**
 * What a probe compares.
 *
 * The status and the error code, plus WHERE the refusal came from when two
 * layers can both produce one. `origin` is derived from the refusal's own
 * message against a small closed set of markers, so a probe can say "the route
 * refused this" as distinct from "something underneath did".
 */
interface Outcome {
  status: number;
  code: string | null;
  origin: string;
}

const ORIGIN_MARKERS: ReadonlyArray<{ marker: RegExp; name: string }> = [
  { marker: /console session holding the role/, name: "route-acl" },
  { marker: /the owner console requires a session/, name: "session-check" },
  { marker: /human/, name: "service-human-gate" },
  { marker: /self/i, name: "service-self-review" },
  { marker: /the HTML rendering is not a console representation/, name: "route-format-guard" },
  { marker: /the database or the runtime refused it/, name: "schema" },
];

function outcomeOf(res: { status: number; json: any }): Outcome {
  const message = typeof res.json?.error?.message === "string" ? res.json.error.message : "";
  const hit = ORIGIN_MARKERS.find((m) => m.marker.test(message));
  return {
    status: res.status,
    code: typeof res.json?.error?.code === "string" ? res.json.error.code : null,
    // status 0 is the encoded THROW above — a refusal, and never an acceptance
    origin: res.status >= 200 && res.status < 400 ? "accepted" : hit ? hit.name : "other",
  };
}

/** A version at `linted` whose review has been requested and not yet judged. */
function awaitingVerdict(fx: P4Fixture, slug: string, author: AuthContext = fx.author): { versionId: string } {
  const v = createVersion(fx, slug, { author });
  assert.equal(lint(fx, v.versionId, author), "linted");
  fx.registry.review(author, v.versionId, { action: "request" });
  return v;
}

function adoptionRequest(fx: P4Fixture, versionId: string): string {
  const id = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
    )
    .run(id, versionId, fx.member.agent_id, NOW);
  return id;
}

/**
 * A console session opened through the real login, against a given router.
 *
 * ONE login, and both halves read off the SAME response: the cookie from the
 * `Set-Cookie` header and the CSRF token from the body. Minting a second ticket
 * to get the header would open a SECOND session, and the token of the first
 * would not match the cookie of the second — every mutation would then be
 * refused as a forgery and every probe below would be measuring the CSRF check
 * instead of the guard it names.
 */
function signIn(handle: MutatedBuild["handleRest"], registry: any, key: string): { cookie: string; csrf: string } {
  const headers: Record<string, string | undefined> = {
    host: ORIGIN,
    origin: `http://${ORIGIN}`,
    authorization: `Bearer ${key}`,
  };
  const minted = handle(registry, { method: "POST", url: "/v1/console/tickets", headers, body: Buffer.from("{}") });
  assert.equal(minted.status, 201, `no ticket: ${minted.body}`);
  const opened = handle(registry, {
    method: "POST",
    url: "/v1/console/session",
    headers: { host: ORIGIN, origin: `http://${ORIGIN}` },
    body: Buffer.from(JSON.stringify({ ticket: JSON.parse(minted.body).ticket })),
  });
  assert.equal(opened.status, 201, opened.body);
  return {
    cookie: /skln_console=([^;]+)/.exec(opened.headers["Set-Cookie"])![1]!,
    csrf: JSON.parse(opened.body).csrf_token,
  };
}

/**
 * Run one probe against the shipped router and against a router with its guard
 * neutralised, and require the two to DISAGREE.
 *
 * Each side gets a FRESH database, so neither observes the other's writes.
 */
async function discriminate(opts: {
  id: string;
  rule: string;
  expect: { status: number; code: string; origin: string };
  edits: Edit[];
  probe: (fx: P4Fixture, handle: MutatedBuild["handleRest"], registry: any) => { status: number; json: any };
}): Promise<void> {
  const shippedBuild = await mutatedRouter([]);
  const shippedFx = p4Fixture();
  const shipped = outcomeOf(opts.probe(shippedFx, shippedBuild.handleRest, shippedFx.registry));
  shippedFx.db.close();

  const mutated = await mutatedRouter(opts.edits);
  const mutatedFx = p4Fixture();
  const registry = mutated.Registry
    ? new mutated.Registry(mutatedFx.db, { now: () => NOW, evidencePrincipals: mutatedFx.evidencePrincipals })
    : mutatedFx.registry;
  const neutralised = outcomeOf(opts.probe(mutatedFx, mutated.handleRest, registry));
  mutatedFx.db.close();

  assert.deepEqual(
    shipped,
    opts.expect,
    `${opts.id}: the shipped registry did not refuse as stated`,
  );
  assert.notDeepEqual(
    neutralised,
    shipped,
    `${opts.id}: the probe answers identically with the guard removed, so it does not measure the guard`,
  );
  record(
    `[P1.CD] ${opts.id}  shipped:${shipped.status}/${shipped.code}/${shipped.origin}  ` +
      `guard-removed:${neutralised.status}/${neutralised.code ?? "-"}/${neutralised.origin}  ${opts.rule}`,
  );
}

// ===========================================================================
// The probes
// ===========================================================================

test("[P1.CD1] the route ACL is what keeps a reviewer out of the owner's draft inbox", async () => {
  await discriminate({
    id: "P1.C1",
    rule: "a reviewer session may not read the owner console's drafts",
    expect: { status: 403, code: "FORBIDDEN", origin: "route-acl" },
    edits: [
      {
        file: "http.ts",
        find: "if (!consoleRouteAdmits(session.actor_role, routeClass)) {",
        replace: "if (false) {",
      },
    ],
    probe: (fx, handle, registry) => {
      const s = signIn(handle, registry, fx.keys.reviewer!);
      return callWith(handle, registry, { path: "/v1/console/drafts", cookie: s.cookie });
    },
  });
});

test("[P1.CD2] the route ACL refuses a reviewer's human approval BEFORE the service is called", async () => {
  await discriminate({
    id: "P1.C2",
    rule: "a reviewer meets the route ACL at the human approval, not the service's human gate",
    expect: { status: 403, code: "FORBIDDEN", origin: "route-acl" },
    edits: [
      {
        file: "http.ts",
        find: "if (!consoleRouteAdmits(session.actor_role, routeClass)) {",
        replace: "if (false) {",
      },
    ],
    // With the route check gone the call is STILL refused — by the service's
    // human gate — which is the layered defence showing itself. The pair is
    // discriminating because the ORIGIN of the refusal moves: `route-acl`
    // becomes `service-human-gate`, and that is precisely the claim "checked
    // before the service call".
    probe: (fx, handle, registry) => {
      const v = awaitingVerdict(fx, "cd2");
      const req = adoptionRequest(fx, v.versionId);
      const s = signIn(handle, registry, fx.keys.reviewer!);
      return callWith(handle, registry, {
        method: "POST",
        path: `/v1/console/versions/${v.versionId}/approvals`,
        cookie: s.cookie,
        csrf: s.csrf,
        body: { scope: "adopt_high_risk", decision: "approved", adoption_request_id: req },
      });
    },
  });
});

test("[P1.CD3] an unclassified console route is closed to a reviewer by DEFAULT, not by enumeration", async () => {
  await discriminate({
    id: "P1.C3",
    rule: "the console route classifier's default is `owner_only`",
    expect: { status: 403, code: "FORBIDDEN", origin: "route-acl" },
    edits: [
      {
        file: "console-v2.ts",
        find: '  return "owner_only";\n}',
        replace: '  return "review";\n}',
      },
    ],
    probe: (fx, handle, registry) => {
      const s = signIn(handle, registry, fx.keys.reviewer!);
      return callWith(handle, registry, { path: "/v1/console/capabilities", cookie: s.cookie });
    },
  });
});

test("[P1.CD4] the Proofline route is in the session-required list, and that list is what requires the session", async () => {
  await discriminate({
    id: "P1.C4",
    rule: "`GET /v1/console/dashboard/{view}` without a session is UNAUTHORIZED",
    expect: { status: 401, code: "UNAUTHORIZED", origin: "session-check" },
    edits: [
      {
        file: "http.ts",
        find: '      path.startsWith("/v1/console/dashboard") ||',
        replace: '      (path.startsWith("/v1/console/dashboard") && false) ||',
      },
    ],
    // A route omitted from that list is a console route with NO session check.
    // With the entry gone the call does not answer 401 — it falls through to the
    // Bearer branch below and is refused as an unauthenticated API call, which
    // is a different answer and a worse one: the route is no longer protected by
    // the console's own gate at all.
    probe: (_fx, handle, registry) => callWith(handle, registry, { path: "/v1/console/dashboard/library" }),
  });
});

test("[P1.CD5] the mutation routes are in the session-required list too", async () => {
  await discriminate({
    id: "P1.C5",
    rule: "`POST /v1/console/versions/{id}/reviews` without a session is UNAUTHORIZED",
    expect: { status: 401, code: "UNAUTHORIZED", origin: "session-check" },
    edits: [
      {
        file: "http.ts",
        find: '      path.startsWith("/v1/console/versions")',
        replace: '      (path.startsWith("/v1/console/versions") && false)',
      },
    ],
    probe: (fx, handle, registry) => {
      const v = awaitingVerdict(fx, "cd5");
      return callWith(handle, registry, {
        method: "POST",
        path: `/v1/console/versions/${v.versionId}/reviews`,
        body: { action: "request" },
      });
    },
  });
});

test("[P1.CD6] the console cannot be pointed at the HTML rendering", async () => {
  await discriminate({
    id: "P1.C6",
    rule: "a `format` selector on the console Proofline is INVALID_SCHEMA",
    expect: { status: 400, code: "INVALID_SCHEMA", origin: "route-format-guard" },
    edits: [
      {
        file: "http.ts",
        find: 'if (url.searchParams.get("format") !== null) {',
        replace: "if (false) {",
      },
    ],
    probe: (fx, handle, registry) => {
      const s = signIn(handle, registry, fx.keys.owner!);
      return callWith(handle, registry, { path: "/v1/console/dashboard/library?format=html", cookie: s.cookie });
    },
  });
});

test("[P1.CD7] the human gate is about `agents.type`, and a service principal holding admin does not pass it", async () => {
  await discriminate({
    id: "P1.C7",
    rule: "a service principal holding role admin cannot pass a human approval gate",
    expect: { status: 403, code: "FORBIDDEN", origin: "service-human-gate" },
    edits: [
      {
        file: "approvals.ts",
        find: "if (!isHumanApprover(db, ctx.approver_agent_id, ctx.workspace_id)) {",
        replace: "if (false) {",
      },
    ],
    probe: (fx, handle, registry) => {
      const v = awaitingVerdict(fx, "cd7");
      const req = adoptionRequest(fx, v.versionId);
      const s = signIn(handle, registry, fx.keys.service!);
      return callWith(handle, registry, {
        method: "POST",
        path: `/v1/console/versions/${v.versionId}/approvals`,
        cookie: s.cookie,
        csrf: s.csrf,
        body: { scope: "adopt_high_risk", decision: "approved", adoption_request_id: req },
      });
    },
  });
});

test("[P1.CD8] the self-review prohibition survives the console, and it is the service's", async () => {
  await discriminate({
    id: "P1.C8",
    rule: "the version's author may not record a verdict on it, whatever role it holds",
    expect: { status: 403, code: "FORBIDDEN", origin: "service-self-review" },
    edits: [
      // BOTH HALVES. The prohibition is one rule stated as two conditions — the
      // version's author and the skill's owner — and in this fixture they are
      // the same agent, so neutralising one leaves the other to refuse the call
      // and the probe would measure nothing.
      //
      // The conditions live in `src/approvals.ts` and are RAISED by
      // `service.ts`: the Approval Inbox has to publish the same verdict as an
      // `eligibility`, and a projection deciding it for itself would be a second
      // answer. Mutating them there is mutating the one place they are stated —
      // which is the stronger form of this probe, not a weaker one, because a
      // pass now means no OTHER copy of the rule refused the call.
      {
        file: "approvals.ts",
        find: "if (subject.author_agent_id === actor.agent_id) {",
        replace: "if (false) {",
      },
      {
        file: "approvals.ts",
        find: "if (subject.owner_agent_id === actor.agent_id) {",
        replace: "if (false) {",
      },
    ],
    probe: (fx, handle, registry) => {
      const v = awaitingVerdict(fx, "cd8", fx.reviewer);
      const s = signIn(handle, registry, fx.keys.reviewer!);
      return callWith(handle, registry, {
        method: "POST",
        path: `/v1/console/versions/${v.versionId}/reviews`,
        cookie: s.cookie,
        csrf: s.csrf,
        body: { action: "verdict", verdict: "approve" },
      });
    },
  });
});

test("[P1.CD9] the console is a three-role surface and not a four-role one", async () => {
  await discriminate({
    id: "P1.C9",
    rule: "a plain member cannot open a console session at all",
    expect: { status: 403, code: "FORBIDDEN", origin: "other" },
    edits: [
      {
        file: "console-session.ts",
        find: "if (role === null || !CONSOLE_ROLES.has(role)) {",
        replace: "if (false) {",
      },
    ],
    probe: (fx, handle, registry) =>
      callWith(handle, registry, { method: "POST", path: "/v1/console/tickets", key: fx.keys.member!, body: {} }),
  });
});

test("[P1.CD10] the schema refuses a console session role the contract does not admit", () => {
  // Not a router probe: the claim is about the DATABASE, and the way to measure
  // it is to write the row directly. `0019` widened the `CHECK` by exactly one
  // value, and the two halves of that — `reviewer` accepted, `member` still
  // refused — are what make the widening a decision rather than a removal.
  const fx = p4Fixture();
  const insert = (role: string): void => {
    fx.db
      .prepare(
        "INSERT INTO owner_sessions(id, workspace_id, agent_id, actor_role, token_hash, csrf_token, created_at_ms, absolute_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(ulid(NOW), fx.seed.wsA, fx.owner.agent_id, role, `sha256:${role.padEnd(64, "0")}`, "cx_probe_token_value", NOW, NOW + 1000);
  };
  insert("reviewer");
  for (const refused of ["member", "", "Reviewer", "admin,reviewer"]) {
    assert.throws(() => insert(refused), `the schema accepted the console session role ${JSON.stringify(refused)}`);
  }
  // …and the columns that must NOT have widened did not.
  for (const table of ["draft_decisions", "skill_assignment_events"]) {
    const sql = (fx.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as any).sql as string;
    assert.ok(
      /actor_role TEXT NOT NULL CHECK\(actor_role IN \('owner','admin'\)\)/.test(sql),
      `${table} widened its actor_role with the console's`,
    );
  }
  record("[P1.CD10] owner_sessions admits reviewer; member refused; draft_decisions and skill_assignment_events unchanged");
  fx.db.close();
});

test("[P1.CD11] every probe above showed a discriminating pair", () => {
  const log = readFileSync(EVIDENCE_LOG, "utf8");
  const pairs = log.split("\n").filter((l) => l.startsWith("[P1.CD] "));
  const ids = new Set(pairs.map((l) => l.split(/\s+/)[1]));
  for (let i = 1; i <= 9; i += 1) {
    assert.ok(ids.has(`P1.C${i}`), `P1.C${i} left no discrimination line in ${EVIDENCE_LOG}`);
  }
  record(`[P1.CD] ${ids.size} discriminating pairs recorded`);
});
