// P4 fixtures: the review-workflow cast (§5.1 reviewer policy, §7.3 human
// gate) plus builders that drive versions through the REAL surfaces up to the
// point each test wants to attack.
import type { Db } from "../src/sqlite.ts";
import { seedGraph, insertAgent, type Seed } from "./helpers.ts";
import { makeManifest, buildPackage, ctxFor, NOW } from "./p2-helpers.ts";
import { Registry } from "../src/service.ts";
import { mintApiKey, type AuthContext, type Role } from "../src/auth.ts";
import { MemoryEvidencePrincipals, type EvidenceSource } from "../src/evidence-principal.ts";
import type { SecretStore } from "../src/webhooks.ts";
import type { ActivationRoots } from "../src/activation.ts";
import type { RuntimeRecordSource } from "../src/assignments.ts";
import type { InventoryRoots } from "../src/fleet-scan.ts";
import type { FleetObservationSource } from "../src/fleet.ts";
import { ulid } from "../src/ulid.ts";

export { NOW };

export interface P4Fixture {
  seed: Seed;
  db: Db;
  registry: Registry;
  /** authorA — member of wsA, author of every version these helpers create */
  author: AuthContext;
  /** ownerA — HUMAN, role owner of wsA, owner of the seeded skill */
  owner: AuthContext;
  /** reviewerA — non-human agent, role reviewer, ≠ author and ≠ skill owner */
  reviewer: AuthContext;
  /** reviewerB — a second eligible reviewer */
  reviewer2: AuthContext;
  /** adminA — HUMAN, role admin: the only §7.3-capable identity besides owner */
  admin: AuthContext;
  /** svcA — agents.type='service' holding role admin: privileged but NOT human */
  service: AuthContext;
  /** botAdmin — agents.type='agent' holding role admin: also not human */
  botAdmin: AuthContext;
  /** reporter-a — `agents.type='agent'`, role `member`: a genuine runtime/adapter
   *  identity. It commands no desired state, so it is the one principal in this
   *  cast that may hold `report_outcome` and file observations (`INV-02`). */
  reporter: AuthContext;
  /** adopterA — plain member of wsA */
  member: AuthContext;
  /** adopterB — member of wsB, the cross-workspace actor */
  outsider: AuthContext;
  keys: Record<string, string>;
  /** `INV-02`: the deployment's registered reporters of observed state. Empty
   *  until a test asks for one through `evidenceReporter` below, because the
   *  shipped default registers nobody. */
  evidencePrincipals: MemoryEvidencePrincipals;
}

function agentCtx(db: Db, seed: Seed, name: string, type: "human" | "agent" | "service", role: Role): AuthContext {
  const id = insertAgent(db, seed.wsA, name, type, seed.now);
  db.prepare("INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)").run(
    id,
    seed.wsA,
    role,
    seed.now,
  );
  return ctxFor(seed, id, seed.wsA, role);
}

export function p4Fixture(
  opts: {
    secrets?: SecretStore;
    /** §5.5: where deployments may be materialized. Absent = nowhere, which is
     *  the shipped default and what every suite but the activation one wants. */
    activation?: ActivationRoots;
    /** §5.5: where runtime records come from. Absent = none, so every observed
     *  arrival is `unknown` — again the shipped default. */
    runtimeRecords?: RuntimeRecordSource;
    /** §6: where an agent's capabilities are READ from. Absent = nowhere, so
     *  every inventory number is `unknown` — the shipped default. */
    inventory?: InventoryRoots;
    /** §6: where the richer §6 snapshot comes from. Absent = the stored
     *  self-reports, which is also the shipped default. */
    observations?: FleetObservationSource;
    /** §6 per-key rate limit. Absent = the SHIPPED default, which is what every
     *  suite gets; a sweep that drives all 36 tools more than once needs a
     *  larger bucket to reach the behaviour it is measuring rather than the
     *  limiter, and says so at its call site. */
    rateLimit?: { capacity: number; refillPerSec: number };
    /** `INV-02`: the registered reporters of observed state. Absent = an empty
     *  registry, which is the shipped default and what every suite but the
     *  observation one wants. */
    evidencePrincipals?: MemoryEvidencePrincipals;
    /** The database to seed. Absent = a freshly migrated one, which is what
     *  every suite but the upgrade probe wants; that probe needs a fixture
     *  built on a database an OLDER build left behind. */
    db?: Db;
    /** The clock. Absent = the frozen `NOW` every other suite wants; a suite
     *  that has to distinguish BEFORE from AFTER — a session opened before a
     *  rollback was decided, say — cannot do it with a stopped clock, and says
     *  so at its call site. */
    clock?: () => number;
  } = {},
): P4Fixture {
  const seed = seedGraph(opts.db);
  const evidencePrincipals = opts.evidencePrincipals ?? new MemoryEvidencePrincipals();
  const registry = new Registry(seed.db, {
    now: opts.clock ?? (() => NOW),
    evidencePrincipals,
    secrets: opts.secrets,
    activation: opts.activation,
    runtimeRecords: opts.runtimeRecords,
    inventory: opts.inventory,
    observations: opts.observations,
    rateLimit: opts.rateLimit,
  });
  const reviewer = agentCtx(seed.db, seed, "reviewer-a", "agent", "reviewer");
  const reviewer2 = agentCtx(seed.db, seed, "reviewer-a2", "agent", "reviewer");
  const admin = agentCtx(seed.db, seed, "admin-a", "human", "admin");
  const service = agentCtx(seed.db, seed, "svc-a", "service", "admin");
  const botAdmin = agentCtx(seed.db, seed, "bot-admin-a", "agent", "admin");
  // `INV-02`, `P3-R2-001`: THE PRINCIPAL A RUNTIME REPORT ACTUALLY COMES FROM.
  //
  // Every observation suite in this tree used to grant `report_outcome` to
  // `fx.owner` and file its reports with the owner's own key, because the owner
  // is the credential nearest to hand. That is the exact shape REVIEW-2
  // reproduced against the shipped surfaces, and it is now refused twice over:
  // a principal may not grant ITSELF, and an owner or admin credential may not
  // write observed state on any surface. So the suites report as what a
  // reporter is — `agents.type='agent'`, holding no role that commands desired
  // state — and the fixture names it rather than leaving each file to invent one.
  const reporter = agentCtx(seed.db, seed, "reporter-a", "agent", "member");
  const fx: P4Fixture = {
    seed,
    db: seed.db,
    registry,
    author: ctxFor(seed, seed.authorA, seed.wsA, "member"),
    owner: ctxFor(seed, seed.ownerA, seed.wsA, "owner"),
    reviewer,
    reviewer2,
    admin,
    service,
    botAdmin,
    reporter,
    member: ctxFor(seed, seed.adopterA, seed.wsA, "member"),
    outsider: ctxFor(seed, seed.adopterB, seed.wsB, "member"),
    keys: {},
    evidencePrincipals,
  };
  for (const [name, ctx] of Object.entries(fx)) {
    if (name === "seed" || name === "db" || name === "registry" || name === "keys") continue;
    if (name === "evidencePrincipals") continue;
    fx.keys[name] = mintApiKey(seed.db, (ctx as AuthContext).agent_id, NOW).api_key;
  }
  return fx;
}

export interface BuiltVersion {
  skillId: string;
  versionId: string;
  manifest: any;
}

/** Create a version through surface 1 (state `draft`). */
export function createVersion(
  fx: P4Fixture,
  slug: string,
  opts: {
    semver?: string;
    skill_id?: string;
    manifest?: Record<string, unknown>;
    files?: Record<string, string>;
    /** author of the version (default authorA) — must satisfy the §6 create ACL */
    author?: AuthContext;
  } = {},
): BuiltVersion {
  const author = opts.author ?? fx.author;
  const manifest = makeManifest({
    author_agent: author.agent_id,
    access_policy: "workspace",
    semantic_version: opts.semver ?? "1.0.0",
    ...(opts.manifest ?? {}),
  });
  const { tar } = buildPackage(manifest, opts.files ?? {});
  const res = fx.registry.createVersion(
    author,
    opts.skill_id === undefined ? { slug, archive: tar } : { skill_id: opts.skill_id, archive: tar },
  ).response;
  return { skillId: res.skill_id, versionId: res.skill_version_id, manifest };
}

/** draft → linted through surface 2 (the real gates run). */
export function lint(fx: P4Fixture, versionId: string, actor: AuthContext = fx.author): string {
  return fx.registry.lintVersion(actor, versionId).response.state;
}

/** draft → linted → reviewed through surfaces 2 and 3 (a real approve verdict). */
export function reviewedVersion(
  fx: P4Fixture,
  slug: string,
  opts: Parameters<typeof createVersion>[2] = {},
): BuiltVersion {
  const v = createVersion(fx, slug, opts);
  const author = opts.author ?? fx.author;
  const state = lint(fx, v.versionId, author);
  if (state !== "linted") throw new Error(`fixture package did not lint clean: ${state}`);
  fx.registry.review(author, v.versionId, { action: "request" });
  const out = fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve" }).response;
  if (out.state !== "reviewed") throw new Error(`fixture did not reach reviewed: ${out.state}`);
  return v;
}

/** Evidence that validates against the fixture manifest's declared gates. */
export function goodEvidence(manifest: any): any {
  return {
    gate_results: (manifest.procedure.validation_gates as Array<{ gate_id: string }>).map((g) => ({
      gate_id: g.gate_id,
      pass: true,
      observed: "skillonomia-tv01-ok",
    })),
  };
}

/**
 * A trial-adoption receipt whose terminal event is `adopted` (§5.1 evidence
 * conjunct). P5 owns the real machinery; these rows are the shape it will
 * write, inserted directly so P4 can attack the gate that reads them.
 */
export function adoptedReceipt(
  fx: P4Fixture,
  versionId: string,
  evidence: unknown,
  opts: { adopter?: string; terminal?: "adopted" | "failed" | "none" } = {},
): { requestId: string; receiptId: string } {
  const db = fx.db;
  const adopter = opts.adopter ?? fx.member.agent_id;
  const now = NOW;
  const requestId = ulid(now);
  db.prepare(
    "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
  ).run(requestId, versionId, adopter, now);
  const receiptId = ulid(now);
  db.prepare(
    "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
  ).run(receiptId, requestId, versionId, adopter, now);
  const ev = db.prepare(
    "INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, evidence_json, server_at_ms, idempotency_key) VALUES (?,?,?,?,?,?,?)",
  );
  ev.run(ulid(now), receiptId, "delivered", 1, null, now, `d-${receiptId}`);
  ev.run(ulid(now), receiptId, "attempted", 2, null, now, `a-${receiptId}`);
  const terminal = opts.terminal ?? "adopted";
  // `none` leaves the chain open at `attempted` — receipt_events is INSERT-only
  // (D.1 triggers), so an open chain is built, never edited afterwards.
  if (terminal === "none") return { requestId, receiptId };
  db.prepare(
    `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, evidence_json, failure_report_json, server_at_ms, idempotency_key)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    ulid(now),
    receiptId,
    terminal,
    3,
    terminal === "adopted" && evidence !== undefined ? JSON.stringify(evidence) : null,
    terminal === "failed" ? JSON.stringify({ category: "gate_failed", summary: "the fixture gate did not pass" }) : null,
    now,
    `t-${receiptId}`,
  );
  return { requestId, receiptId };
}

/** Everything the §5.1 conjunction wants, through the real surfaces. */
export function verifiableVersion(
  fx: P4Fixture,
  slug: string,
  opts: Parameters<typeof createVersion>[2] = {},
): BuiltVersion {
  const v = reviewedVersion(fx, slug, opts);
  adoptedReceipt(fx, v.versionId, goodEvidence(v.manifest));
  return v;
}

/**
 * reviewed → verified → published (publication carries its countersign).
 * Both steps go through the PUBLIC surfaces, so every fixture that wants a
 * published version is also a small proof that surface 12 works.
 */
export function publishedVersion(fx: P4Fixture, slug: string): BuiltVersion {
  const v = verifiableVersion(fx, slug);
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  if (out.state !== "verified") throw new Error(`fixture did not verify: ${JSON.stringify(out.checks)}`);
  const pub = fx.registry.publishVersion(fx.owner, v.versionId).response;
  if (pub.state !== "published") throw new Error(`fixture did not publish: ${JSON.stringify(pub)}`);
  return v;
}

/**
 * A REGISTERED EVIDENCE PRINCIPAL — the close of P3 REVIEW-1 finding
 * `P3-R1-001`, as a fixture.
 *
 * It is created on demand rather than in `p4Fixture`, because an agent added to
 * the seeded workspace is an agent every fleet count in every other suite would
 * have to grow to accommodate. The registration is the deployment's, so the
 * fixture makes it the way a deployment does: outside every surface the owner
 * can call.
 */
export function evidenceReporter(
  fx: P4Fixture,
  source: EvidenceSource,
  opts: { name?: string; role?: Role | null } = {},
): { ctx: AuthContext; key: string } {
  const name = opts.name ?? `evidence-${source}-${Math.random().toString(36).slice(2, 8)}`;
  const id = insertAgent(fx.db, fx.seed.wsA, name, "service", fx.seed.now);
  const role = opts.role === undefined ? "member" : opts.role;
  if (role !== null) {
    fx.db.prepare(
      "INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)",
    ).run(id, fx.seed.wsA, role, fx.seed.now);
  }
  fx.evidencePrincipals.register(id, source);
  return { ctx: ctxFor(fx.seed, id, fx.seed.wsA, role), key: mintApiKey(fx.db, id, NOW).api_key };
}
