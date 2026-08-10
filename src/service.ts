// P2 registry core — the ONE internal service layer behind both adapters
// (§2: MCP and REST are thin; no business logic outside this module).
// Surfaces at this phase: 1 skill.create, 2 skill.lint, 4-read stateless
// §4.4 verify, 5 skill.search — plus AuthContext, bootstrap, idempotency
// replay and per-key rate limits.
//
// Invariants enforced here (§2): the acting agent comes exclusively from
// AuthContext — no payload field can impersonate (defect #2) or escalate
// (defect #3); every state answer converges (defect #1); every mutation
// accepts an idempotency_key whose duplicate replays the original response
// byte-identically (defect #4).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";
import {
  authenticate as authenticateKey,
  bootstrapInstance,
  exchangeBootstrapToken,
  MemoryBootstrapStore,
  type AuthContext,
  type BootstrapState,
  type BootstrapStore,
  type BootstrapExchange,
} from "./auth.ts";
import { withIdempotency, type IdempotentOutcome } from "./idempotency.ts";
import { RateLimiter, DEFAULT_RATE_LIMIT, type RateLimitOptions } from "./ratelimit.ts";
import { ArchiveError, readPackage, computeIntegrity, writeTar, type PackageFiles } from "./archive.ts";
import { parseJsonStrict, utf8Decode, jcsBytes } from "./jcs.ts";
import { validateManifest } from "./manifest.ts";
import { manifestHash, contentHash, signManifest } from "./signing.ts";
import {
  ARRIVAL_SCRIPT_PATH,
  arrivalMarker,
  checkArrivalIdentity,
  embedArrivalStep,
  renderArrivalScript,
} from "./marker.ts";
import { assertNoPrivateMaterial, systemSigningKey } from "./system-key.ts";
import { transitionVersion, type VersionState } from "./transitions.ts";
import { publishVersion as countersignAndPublish, COUNTERSIGN_EVENT } from "./countersign.ts";
import { verifyPackage, type VerifyOutcome } from "./verify.ts";
import { runGates, type GateReport } from "./gates.ts";
import { appendTlogInTx, type TlogRow } from "./tlog.ts";
import {
  recordApproval,
  type ApprovalDecision,
  type ApprovalResponse,
  type ApprovalScope,
} from "./approvals.ts";
import { verifyVersionTransition, type VerifyTransitionOutcome } from "./verified-gate.ts";
import { appendReceiptEvent, derivedState, isStalled, type AppendResult, type DerivedState, type ReceiptEvent } from "./receipts.ts";
import {
  loadRequest,
  selectWebhook,
  deadLetters,
  enqueueRevocationNoticesInTx,
  type RequestState,
} from "./delivery.ts";
import { demoMode } from "./seed.ts";
import {
  DASHBOARD_VIEWS,
  isDashboardView,
  type DashboardPayload,
  type DashboardSection,
  type DashboardView,
} from "./dashboard.ts";
import {
  ALL_TIME,
  describeWindow,
  migrationCounts as countMigrationsPerSkill,
  parseMigrationWindow,
  MIGRATION_SOURCE,
  type MigrationCountResponse,
  type MigrationWindow,
} from "./skill-migrations.ts";
import { checkCompatibility, mismatchBlocks, type CompatResult } from "./compat.ts";
import { approvalConditions } from "./approvals.ts";
import {
  registerWebhook,
  deleteWebhook,
  listWebhooks,
  webhookHealth,
  MemorySecretStore,
  type RegisteredWebhook,
  type SecretStore,
} from "./webhooks.ts";
import { validatePayload } from "./manifest.ts";
import {
  createPrincipal,
  issueApiKey,
  listPrincipals,
  listSigningKeys,
  registerSigningKey,
  revokeApiKey,
  revokeSigningKey,
  type CreatedPrincipal,
  type IssuedApiKey,
  type PrincipalView,
  type RegisteredSigningKey,
  type RevokedApiKey,
  type RevokedSigningKey,
  type SigningKeyView,
} from "./provision.ts";
import { ulid } from "./ulid.ts";

// ---------------------------------------------------------------- blob store

export interface BlobStore {
  put(ref: string, bytes: Buffer): void;
  get(ref: string): Buffer | undefined;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();
  put(ref: string, bytes: Buffer): void {
    this.blobs.set(ref, bytes);
  }
  get(ref: string): Buffer | undefined {
    return this.blobs.get(ref);
  }
}

/** Content-addressed files under one directory (refs are `sha256:<hex>`). */
export class FsBlobStore implements BlobStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  private path(ref: string): string {
    const m = /^sha256:([0-9a-f]{64})$/.exec(ref);
    if (!m) throw new Error(`blob ref must be sha256:<hex64>, got ${ref}`);
    return join(this.dir, `${m[1]}.tar`);
  }
  put(ref: string, bytes: Buffer): void {
    writeFileSync(this.path(ref), bytes);
  }
  get(ref: string): Buffer | undefined {
    const p = this.path(ref);
    return existsSync(p) ? readFileSync(p) : undefined;
  }
}

// ------------------------------------------------------------------- registry

export interface RegistryOptions {
  rateLimit?: RateLimitOptions;
  now?: () => number;
  blobs?: BlobStore;
  /** §5.2: where webhook signing secrets live — never SQLite */
  secrets?: SecretStore;
  /**
   * §9.1: where the OUTSTANDING bootstrap token's HASH lives between the first
   * start and the exchange. In memory by default, which is what a test wants;
   * a deployment passes a durable one so a restart before the exchange does not
   * strand it without an owner key (src/server.ts).
   */
  bootstrap?: BootstrapStore;
}

export interface CreateInput {
  /** new-skill form (POST /v1/skills): slug of the skill to create-or-reuse */
  slug?: string;
  /** new-version form (POST /v1/skills/{skill_id}/versions) */
  skill_id?: string;
  /** package archive bytes: tar, or gzip-compressed tar (§4.1b) */
  archive: Buffer;
}

export interface CreateResponse {
  skill_id: string;
  skill_version_id: string;
  state: VersionState;
  /** present (true) only when the call converged on an existing identical version */
  noop?: boolean;
}

/**
 * [B-1]: the input of `skill.create_from_dir` — a SOURCE tree, not a package.
 *
 * "From a directory" is what the author experiences; what crosses the wire is
 * an archive of that directory, and the distinction is a security boundary, not
 * a packaging detail. The registry never reads a path the caller names: a
 * server that opened `/etc/…` because a request asked it to would be a file-read
 * primitive with an API in front of it. The client reads its own directory; the
 * server reads bytes.
 */
export interface CreateFromDirInput {
  /** new-skill form: slug of the skill to create-or-reuse */
  slug?: string;
  /** new-version form: the existing skill this version belongs to */
  skill_id?: string;
  /** the SOURCE tree as a §4.1b archive — `manifest.json` + `SKILL.md` + files */
  source: Buffer;
}

export interface CreateFromDirResponse {
  skill_id: string;
  skill_version_id: string;
  state: VersionState;
  /** D-1's §5 marker, derived from `skill_version_id`. Not a secret [M-2] */
  arrival_marker: string;
  /** the system-held key that signed it; its private half exists only in the
   *  deployment's secret store and appears in no response, ever [I-7] */
  kid: string;
  manifest_hash: string;
  content_hash: string;
  /** present (true) only when this SOURCE had already been packed as this version */
  noop?: boolean;
}

export interface LintResponse {
  reports: Array<{ gate: string; result: string; details: string | null }>;
  state: VersionState;
  /** true when the version was already past `draft` — nothing transitioned */
  noop?: boolean;
}

// ------------------------------------------------------------- P4 contracts

/** transparency-log event kinds written by this phase (§3, INSERT-only) */
export const TLOG_ATTESTATION = "reviewer_attestation";
export const TLOG_SUPERSEDED = "version_superseded";
export const TLOG_REVOKED = "version_revoked";
export const TLOG_DEPRECATED = "version_deprecated";

export interface ReviewInput {
  action?: "request" | "verdict";
  verdict?: "approve" | "reject" | "conditional";
  note?: string | null;
}

export interface ReviewResponse {
  action: "request" | "verdict";
  /** null for `request` — a request records no review row */
  review_id: string | null;
  verdict?: "approve" | "reject" | "conditional";
  state: VersionState;
  /** `request`: the eligible reviewers that were notified (§5.1, ≠ author) */
  notified?: string[];
  /** `verdict`: the attestation written in the same transaction as an approve */
  attestation_id?: string | null;
  noop?: boolean;
}

export interface PublishResponse {
  skill_version_id: string;
  state: VersionState;
  manifest_hash: string;
  /** §4.3.8 countersign seq in the transparency log — the §4.4 step-7 clock */
  countersign_seq: number;
  noop?: boolean;
}

export interface SupersedeInput {
  successor_version_id?: unknown;
}

export interface SupersedeResponse {
  skill_version_id: string;
  state: VersionState;
  superseded_by: string | null;
  successor: { skill_version_id: string; state: VersionState };
  tlog_seq?: number;
  noop?: boolean;
}

export interface RevokeInput {
  reason?: unknown;
}

export interface RevokeResponse {
  skill_version_id: string;
  state: VersionState;
  reason: string | null;
  tlog_seq?: number;
  /** §6 surface 11: how many active adopters were queued a revocation notice
   *  on the §5.2 delivery machine. Absent on a convergent re-revoke, which
   *  queues nothing. */
  notified_adopters?: number;
  noop?: boolean;
}

export interface DeprecateResponse {
  skill_version_id: string;
  state: VersionState;
  /** §4.2 Lifecycle-registry `deprecation_date`, ISO-8601 from the registry clock */
  deprecation_date: string | null;
  tlog_seq?: number;
  noop?: boolean;
}

export interface RequestAdoptionResponse {
  adoption_request_id: string;
  receipt_id: string;
  state: RequestState;
  /** §7.3 conditions holding this request in `approval_pending`, if any */
  approval_required?: string[];
  /** null when the adopter has no selectable endpoint (Appendix H surface 6) */
  webhook_id?: null;
}

export interface AdoptResponse {
  receipt_event: "delivered";
  event_seq: number;
  receipt_id: string;
  compat: { result: CompatResult; unmet: string[] };
  package: {
    skill_version_id: string;
    semantic_version: string;
    manifest_hash: string;
    content_hash: string;
    archive_base64: string;
  };
  warning?: string;
  // No `noop` member: handover happens once. A late caller is refused with
  // `PRECONDITION_FAILED` and the current state, and the one caller entitled to
  // a repeat — same principal, same `idempotency_key` — is served the stored
  // bytes of the original response by `withIdempotency`, which never reaches
  // this shape at all.
}

export interface ReceiptView {
  receipt_id: string;
  adoption_request_id: string;
  skill_version_id: string;
  adopter_agent_id: string;
  derived_state: DerivedState;
  /** §5.3: derived, never stored — INSERT-only is preserved */
  stalled: boolean;
  events: Array<{
    event: ReceiptEvent;
    event_seq: number;
    server_at_ms: number;
    evidence: unknown;
    failure_report: unknown;
    rollback_report: unknown;
    /**
     * §5.3: the environment declared at handover, on the `delivered` row and
     * null everywhere else. Served so the adopter can read back its OWN
     * declaration in its OWN event — the rule "confirm a write by reading the
     * state back" had nothing to read for this field, and a descriptor nobody
     * could read was a descriptor nobody could notice being wrong.
     */
    environment_descriptor: unknown;
  }>;
}

export interface ValidateOutcomeInput {
  event?: ReceiptEvent;
  evidence?: unknown;
  failure_report?: unknown;
  rollback_report?: unknown;
}

export interface ApproveInput {
  scope?: unknown;
  decision?: unknown;
  adoption_request_id?: string | null;
  note?: string | null;
}

export interface SearchParams {
  q?: string;
  capability?: string;
  runtime?: string;
  tool?: string;
  risk?: string;
  state?: string;
  /** §6 trust threshold, outcome-count half — server-validated `adopted` events */
  min_adopted?: string | number;
  /** §6 trust threshold, rating half — the receipt-backed average (P6) */
  min_rating?: string | number;
  limit?: string | number;
  cursor?: string;
}

/**
 * The complete declared filter set of surface 5 (Appendix H's query string plus
 * §6's trust threshold), excluding the `limit`/`cursor` pagination controls.
 * Appendix H's conventions fix both halves: the declared set is exactly this
 * one, and the filters combine with AND. Exported so the adapters and the P6
 * test suite enumerate exactly one list.
 */
export const SEARCH_FILTERS = [
  "q",
  "capability",
  "runtime",
  "tool",
  "risk",
  "state",
  "min_adopted",
  "min_rating",
] as const;

export interface SearchItem {
  skill_id: string;
  slug: string;
  skill_version_id: string;
  semantic_version: string;
  state: VersionState;
  title?: string;
  capability_statement?: string;
  risk_level?: string;
  access_policy: string;
  /** §5.1: deprecated/superseded surface with a warning */
  warning?: "deprecated" | "superseded";
  registry: RegistryView;
}

export interface RegistryView {
  state: VersionState;
  superseded_by: string | null;
  deprecation_date: string | null;
  revocation_reason: string | null;
  receipt_ids: string[];
  reviewer_notes: string[];
  reputation: {
    adoption_attempts: number;
    adopted_count: number;
    failed_count: number;
    rolled_back_count: number;
    avg_rating: number | null;
    failure_modes_observed: string[];
  };
}

interface VersionRow {
  id: string;
  skill_id: string;
  semantic_version: string;
  author_agent_id: string;
  manifest_json: string;
  manifest_hash: string;
  content_hash: string;
  package_blob_ref: string;
  state: VersionState;
  superseded_by_version_id: string | null;
  revocation_reason: string | null;
  deprecation_at_ms: number | null;
  created_at_ms: number;
  slug: string;
  workspace_id: string;
  owner_agent_id: string;
  access_policy: string;
}

const VERSION_STATES = new Set([
  "draft", "linted", "reviewed", "verified", "published", "deprecated", "superseded", "revoked",
]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const SLUG_RE = /^[a-z0-9-]{3,64}$/;

export class Registry {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly secrets: SecretStore;
  private readonly limiter: RateLimiter;
  private readonly now: () => number;
  private readonly bootstrapStore: BootstrapStore;
  private bootstrapState: BootstrapState | null;

  constructor(db: Db, opts: RegistryOptions = {}) {
    this.db = db;
    this.blobs = opts.blobs ?? new MemoryBlobStore();
    this.secrets = opts.secrets ?? new MemorySecretStore();
    this.limiter = new RateLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.now = opts.now ?? Date.now;
    this.bootstrapStore = opts.bootstrap ?? new MemoryBootstrapStore();
    // A restart before the exchange finds the outstanding token here. Nothing
    // is re-issued and nothing is printed — the token the operator already has
    // is simply still valid, which is what makes §9.1 survivable.
    this.bootstrapState = this.bootstrapStore.load();
  }

  /** True while a §9.1 bootstrap token has been issued and not yet exchanged. */
  bootstrapOutstanding(): boolean {
    return this.bootstrapState?.tokenHash != null;
  }

  // ------------------------------------------------------------------- auth

  /** First-start bootstrap (§9.1); null when the instance already has data. */
  bootstrap(): {
    bootstrap_owner_token: string;
    demo_adopter_token: string;
    workspace_id: string;
    owner_agent_id: string;
  } | null {
    const boot = bootstrapInstance(this.db, this.now());
    if (!boot) return null;
    this.bootstrapState = boot.state;
    // durable BEFORE the token is printed: a token an operator has read and the
    // registry has forgotten is the failure this exists to prevent
    this.bootstrapStore.save(boot.state);
    // the two ids are returned so a deployment can seed §9.1's package as the owner
    // without re-deriving them from the database (P7)
    return {
      bootstrap_owner_token: boot.bootstrap_owner_token,
      demo_adopter_token: boot.demo_adopter_token,
      workspace_id: boot.workspace_id,
      owner_agent_id: boot.owner_agent_id,
    };
  }

  /** POST /v1/auth/bootstrap — one-time token → owner API key. */
  exchangeBootstrap(token: unknown): BootstrapExchange {
    if (!this.bootstrapState) throw new ApiError("UNAUTHORIZED", "no bootstrap token outstanding");
    return exchangeBootstrapToken(this.db, this.bootstrapState, token, this.now(), () => this.bootstrapStore.clear());
  }

  /**
   * AuthN + per-key rate limit — the single entry point both adapters use, so
   * every authenticated call on every surface is limited identically.
   */
  authenticate(authorizationHeader: string | undefined): AuthContext {
    const ctx = authenticateKey(this.db, authorizationHeader);
    if (!this.limiter.take(ctx.api_key_id, this.now())) {
      throw new ApiError("RATE_LIMITED", "rate limit exceeded for this API key");
    }
    return ctx;
  }

  // ---------------------------------------------------- surface 1: skill.create

  createVersion(
    auth: AuthContext,
    input: CreateInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<CreateResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.create", idempotencyKey, this.now(), () =>
      this.createVersionInner(auth, input),
    );
  }

  private createVersionInner(auth: AuthContext, input: CreateInput): CreateResponse {
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");

    const files = readArchiveBytes(input.archive);
    const rawManifest = files.get("skill.json");
    if (!rawManifest) throw new ApiError("INVALID_SCHEMA", "skill.json missing from package");
    let manifest: any;
    try {
      manifest = parseJsonStrict(utf8Decode(rawManifest));
    } catch (e: any) {
      throw new ApiError("INVALID_SCHEMA", `skill.json: ${e.message}`);
    }
    const val = validateManifest(manifest);
    if (!val.valid) throw new ApiError("INVALID_SCHEMA", val.errors.slice(0, 5).join("; "));
    if (!files.has("SKILL.md")) throw new ApiError("INVALID_SCHEMA", "SKILL.md missing at package root (§4.1)");
    const jws = files.get("SIGNATURE.jws");
    if (!jws) throw new ApiError("INVALID_SCHEMA", "SIGNATURE.jws missing (§4.1 layout)");

    // §4.3.2 integrity must match the actual files before anything is stored
    const recomputed = computeIntegrity(files);
    const declared = manifest.integrity as Array<{ path: string; sha256: string }>;
    const same =
      recomputed.length === declared.length &&
      recomputed.every((e, i) => declared[i].path === e.path && declared[i].sha256 === e.sha256);
    if (!same) throw new ApiError("TAMPERED_CONTENT", "integrity list does not match package contents");

    // Defect #2: the author is the authenticated agent, or the call is rejected.
    if (manifest.author_agent !== auth.agent_id) {
      throw new ApiError("FORBIDDEN", "author_agent must equal the authenticated agent (actor from auth, never payload)");
    }

    let mHash: string;
    try {
      mHash = manifestHash(manifest);
    } catch (e: any) {
      throw new ApiError("INVALID_SCHEMA", `canonicalization: ${e.message}`);
    }
    const cHash = contentHash(declared);

    const now = this.now();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const skillId = this.resolveTargetSkill(auth, input, manifest, now);

      const existing = db
        .prepare("SELECT id, state, manifest_hash, content_hash FROM skill_versions WHERE skill_id=? AND semantic_version=?")
        .get(skillId, manifest.semantic_version) as
        | { id: string; state: VersionState; manifest_hash: string; content_hash: string }
        | undefined;
      if (existing) {
        db.exec("ROLLBACK");
        if (existing.manifest_hash === mHash && existing.content_hash === cHash) {
          // Idempotent create: identical content converges (defect #1 shape).
          return { skill_id: skillId, skill_version_id: existing.id, state: existing.state, noop: true };
        }
        throw new ApiError(
          "CONFLICT",
          `version ${manifest.semantic_version} of this skill already exists with different content`,
          existing.state,
        );
      }

      const tar = writeTar(files);
      const blobRef = `sha256:${createHash("sha256").update(tar).digest("hex")}`;
      const versionId = ulid(now);
      db.prepare(
        `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
           manifest_hash, content_hash, package_blob_ref, signature_jws, state, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?)`,
      ).run(
        versionId,
        skillId,
        manifest.semantic_version,
        auth.agent_id,
        rawManifest.toString("utf8"),
        mHash,
        cHash,
        blobRef,
        jws.toString("utf8"),
        now,
      );
      db.exec("COMMIT");
      this.blobs.put(blobRef, tar); // after commit: a rolled-back row never leaks a blob ref
      return { skill_id: skillId, skill_version_id: versionId, state: "draft" };
    } catch (e) {
      rollbackIfOpen(db);
      throw e;
    }
  }

  // ------------------------------------- surface 14: skill.create_from_dir
  //
  // [B-1] and §5's arrival marker are ONE operation because they share one
  // foundation. §5 requires a marker derived from the SKILL VERSION ID, and the
  // version id is minted by the registry — so a packer that never speaks to the
  // registry has nothing to derive from. `tools/pack-skill.ts` says so in its
  // own header: it "talks to no database and no registry". Server-side packing
  // is therefore a CONSEQUENCE of [M-1], not a preference.
  //
  // ---------------------------------------------------------------------------
  // THE ORDER, and why there is only one that is consistent
  // ---------------------------------------------------------------------------
  //
  //     mint the version ULID
  //       → derive the marker from it
  //         → write the marker into SKILL.md and scripts/skln-arrive.sh
  //           → compute §4.3 `integrity` over those bytes
  //             → sign
  //               → INSERT the row under THE SAME id
  //
  // `skill.create` mints its version id AFTER `integrity` is computed, because
  // it receives a package that is already sealed. That order cannot carry a
  // marker: `integrity` would cover a package the marker was added to
  // afterwards, and the signature would attest a package that is not the one
  // that ships. So the id is minted first here and carried to the INSERT.
  //
  // Deriving the marker from `content_hash` instead would remove the need to
  // mint early and is FORBIDDEN: the marker changes the content, the content
  // decides the hash, and the hash would decide the marker. That is a circle,
  // and it is also not what [M-1] says.
  //
  // ---------------------------------------------------------------------------
  // CONVERGENCE, and why it is judged on the source
  // ---------------------------------------------------------------------------
  //
  // Because the marker is derived from a freshly minted id, packing one source
  // twice yields two byte-different packages. `skill.create` converges by
  // comparing `manifest_hash` and `content_hash`; that comparison here would
  // never be equal, so a second submission of an unchanged source would mint a
  // second version, silently, for ever.
  //
  // The comparison therefore happens on the SOURCE, computed BEFORE the marker
  // exists, and is stored in `skill_versions.source_hash`. Move it back onto the
  // packed bytes and `test/create-from-dir.test.ts`'s convergence test fails —
  // which is the point of that test.

  createFromDir(
    auth: AuthContext,
    input: CreateFromDirInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<CreateFromDirResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.create_from_dir", idempotencyKey, this.now(), () =>
      this.createFromDirInner(auth, input),
    );
  }

  private createFromDirInner(auth: AuthContext, input: CreateFromDirInput): CreateFromDirResponse {
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");

    const source = readArchiveBytes(input.source);
    const rawManifest = source.get("manifest.json");
    if (!rawManifest) {
      throw new ApiError("INVALID_SCHEMA", "manifest.json missing from the source tree (§4.1 source layout)");
    }
    if (!source.has("SKILL.md")) throw new ApiError("INVALID_SCHEMA", "SKILL.md missing at source root (§4.1)");
    // A source tree is not a package. `skill.json` and `SIGNATURE.jws` are
    // PRODUCED here; a source carrying them is either a packed archive sent to
    // the wrong surface or an attempt to supply a signature the registry is
    // about to make. Either way the answer is the same, and it names the
    // surface that does accept a sealed package.
    for (const produced of ["skill.json", "SIGNATURE.jws"]) {
      if (source.has(produced)) {
        throw new ApiError(
          "INVALID_SCHEMA",
          `${produced} is produced by packing and must not be in the source tree — an already-packed archive goes to skill.create`,
        );
      }
    }

    let manifest: any;
    try {
      manifest = parseJsonStrict(utf8Decode(rawManifest));
    } catch (e: any) {
      throw new ApiError("INVALID_SCHEMA", `manifest.json: ${e.message}`);
    }
    // Defect #2, at the one place a packer could otherwise decide it: the author
    // is the authenticated agent. Unlike `skill.create` this is not a refusal
    // but an assignment — there is no author-supplied signature to invalidate,
    // and [B-1] says the owner fills in nothing. What a payload still cannot do
    // is name a DIFFERENT author.
    if (manifest.author_agent !== undefined && manifest.author_agent !== auth.agent_id) {
      throw new ApiError(
        "FORBIDDEN",
        "author_agent must equal the authenticated agent (actor from auth, never payload)",
      );
    }
    manifest.author_agent = auth.agent_id;

    // The files that ship, minus the manifest — which becomes `skill.json` and
    // is excluded for the reason tools/pack-skill.ts gives: shipping both would
    // put an unsigned near-copy of the manifest inside the integrity list.
    const files: PackageFiles = new Map();
    for (const [path, bytes] of source) {
      if (path === "manifest.json") continue;
      files.set(path, bytes);
    }

    // The source manifest is validated HERE, before anything is resolved or
    // written, for the reason `skill.create` validates before its transaction:
    // `resolveTargetSkill` reads `manifest.skill_id` and the row carries
    // `semantic_version`, so a manifest that is merely junk would otherwise
    // surface as a database binding error instead of a typed INVALID_SCHEMA.
    //
    // `integrity` is the one field a SOURCE legitimately lacks — packing
    // computes it, and it cannot be computed before the marker exists — so the
    // check runs against a copy carrying the pre-marker list. Its VALUE is
    // discarded; only the shape of the surrounding document is being judged,
    // and the real list is computed and validated again after the marker lands.
    const shapeCheck = validateManifest({ ...manifest, integrity: computeIntegrity(files) });
    if (!shapeCheck.valid) throw new ApiError("INVALID_SCHEMA", shapeCheck.errors.slice(0, 5).join("; "));

    // The convergence identity, computed on the SOURCE and therefore BEFORE the
    // marker is written. Canonical rather than byte-wise: reformatting
    // `manifest.json` without changing what it says still converges.
    const sourceHash = sourceIdentity(files, manifest);

    // The signing key is obtained BEFORE the packing transaction opens: minting
    // one needs its own `BEGIN IMMEDIATE`, and SQLite has no nested one.
    const now = this.now();
    const key = systemSigningKey(this.db, this.secrets, auth.agent_id, now);
    // Read back for the [I-7] check below. `systemSigningKey` has already
    // established that this handle resolves, so an absence here is a store that
    // changed under us — refused, and named without naming what is missing.
    const seedHex = this.secrets.get(key.secret_ref);
    if (seedHex === undefined) throw new Error(`system signing key: nothing at ${key.secret_ref}`);

    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const skillId = this.resolveTargetSkill(auth, input, manifest, now);

      const existing = db
        .prepare("SELECT id, state, source_hash FROM skill_versions WHERE skill_id=? AND semantic_version=?")
        .get(skillId, manifest.semantic_version) as
        | { id: string; state: VersionState; source_hash: string | null }
        | undefined;
      if (existing) {
        db.exec("ROLLBACK");
        if (existing.source_hash !== null && existing.source_hash === sourceHash) {
          // Convergent: this exact SOURCE is already this version. The marker
          // reported is the one the EXISTING id derives, so a caller that
          // resubmits gets the marker of the package that actually shipped.
          const row = db
            .prepare("SELECT manifest_hash, content_hash FROM skill_versions WHERE id=?")
            .get(existing.id) as { manifest_hash: string; content_hash: string };
          return {
            skill_id: skillId,
            skill_version_id: existing.id,
            state: existing.state,
            arrival_marker: arrivalMarker(existing.id),
            kid: key.kid,
            manifest_hash: row.manifest_hash,
            content_hash: row.content_hash,
            noop: true,
          };
        }
        throw new ApiError(
          "CONFLICT",
          `version ${manifest.semantic_version} of this skill already exists, packed from a different source`,
          existing.state,
        );
      }

      // ---- the order [M-1] forces, from here to the INSERT
      const versionId = ulid(now);
      const marker = arrivalMarker(versionId);
      files.set(
        "SKILL.md",
        Buffer.from(embedArrivalStep(files.get("SKILL.md")!.toString("utf8"), versionId), "utf8"),
      );
      files.set(ARRIVAL_SCRIPT_PATH, Buffer.from(renderArrivalScript(versionId), "utf8"));

      // D-1's guard: SKILL.md, the script and the version id must name ONE
      // marker. A disagreement refuses the pack; it is never a report.
      const identity = checkArrivalIdentity(files, versionId);
      if (!identity.ok) {
        throw new ApiError("TAMPERED_CONTENT", `arrival marker identity check failed: ${identity.reason}`);
      }

      // `integrity` is computed LAST over the files that ship, so it covers the
      // marker. Everything after this point is attesting these exact bytes.
      manifest.integrity = computeIntegrity(files);
      const val = validateManifest(manifest);
      if (!val.valid) throw new ApiError("INVALID_SCHEMA", val.errors.slice(0, 5).join("; "));

      let mHash: string;
      try {
        mHash = manifestHash(manifest);
      } catch (e: any) {
        throw new ApiError("INVALID_SCHEMA", `canonicalization: ${e.message}`);
      }
      const cHash = contentHash(manifest.integrity);
      const { jws } = signManifest(manifest as never, key.privateKey, key.kid);
      const manifestJson = JSON.stringify(manifest);
      files.set("skill.json", Buffer.from(manifestJson, "utf8"));
      files.set("SIGNATURE.jws", Buffer.from(jws, "utf8"));

      const tar = writeTar(files);
      const blobRef = `sha256:${createHash("sha256").update(tar).digest("hex")}`;

      // [I-7]/[M-2], checked over the actual bytes rather than promised: the
      // package, the stored manifest, the signature, the marker and the response
      // are searched for the private seed in every encoding it could wear.
      const response: CreateFromDirResponse = {
        skill_id: skillId,
        skill_version_id: versionId,
        state: "draft",
        arrival_marker: marker,
        kid: key.kid,
        manifest_hash: mHash,
        content_hash: cHash,
      };
      assertNoPrivateMaterial(seedHex, [
        ["the package archive", tar],
        ["the stored manifest", manifestJson],
        ["SIGNATURE.jws", jws],
        ["the arrival marker", marker],
        ["the response body", JSON.stringify(response)],
      ]);

      db.prepare(
        `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
           manifest_hash, content_hash, package_blob_ref, signature_jws, state, created_at_ms, source_hash)
         VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?,?)`,
      ).run(
        versionId,
        skillId,
        manifest.semantic_version,
        auth.agent_id,
        manifestJson,
        mHash,
        cHash,
        blobRef,
        jws,
        now,
        sourceHash,
      );
      db.exec("COMMIT");
      this.blobs.put(blobRef, tar); // after commit, as `skill.create` does
      return response;
    } catch (e) {
      rollbackIfOpen(db);
      throw e;
    }
  }

  /** Create-or-reuse the target skill row; returns its id. Caller holds the tx. */
  private resolveTargetSkill(
    auth: AuthContext,
    input: { slug?: string; skill_id?: string },
    manifest: any,
    now: number,
  ): string {
    const db = this.db;
    if (input.skill_id !== undefined) {
      if (typeof input.skill_id !== "string") throw new ApiError("INVALID_SCHEMA", "skill_id must be a string");
      // new-version form: the skill must exist in the actor's workspace
      const skill = db
        .prepare("SELECT id, workspace_id, owner_agent_id, access_policy FROM skills WHERE id=?")
        .get(input.skill_id) as
        | { id: string; workspace_id: string; owner_agent_id: string; access_policy: string }
        | undefined;
      // deny-by-default: a cross-workspace skill id is indistinguishable from a missing one
      if (!skill || skill.workspace_id !== auth.workspace_id) throw new ApiError("NOT_FOUND", "skill not found");
      this.checkExistingSkill(auth, skill, manifest);
      return skill.id;
    }

    const slug = input.slug;
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw new ApiError("INVALID_SCHEMA", "slug must match [a-z0-9-]{3,64}");
    }
    const existing = db
      .prepare("SELECT id, workspace_id, owner_agent_id, access_policy FROM skills WHERE workspace_id=? AND slug=?")
      .get(auth.workspace_id, slug) as
      | { id: string; workspace_id: string; owner_agent_id: string; access_policy: string }
      | undefined;
    if (existing) {
      // §6.1: create is idempotent on (workspace, slug) — reuse, never duplicate
      this.checkExistingSkill(auth, existing, manifest);
      return existing.id;
    }

    // New skill: its id is the author-minted manifest.skill_id; the creator
    // becomes owner (actor from auth — a payload cannot assign ownership).
    const clash = db.prepare("SELECT id FROM skills WHERE id=?").get(manifest.skill_id) as { id: string } | undefined;
    if (clash) {
      throw new ApiError("CONFLICT", "manifest.skill_id is already registered", this.latestVersionState(clash.id));
    }
    db.prepare(
      "INSERT INTO skills(id, workspace_id, slug, owner_agent_id, access_policy, created_at_ms) VALUES (?,?,?,?,?,?)",
    ).run(manifest.skill_id, auth.workspace_id, slug, auth.agent_id, manifest.access_policy, now);
    return manifest.skill_id;
  }

  private checkExistingSkill(
    auth: AuthContext,
    skill: { id: string; owner_agent_id: string; access_policy: string },
    manifest: any,
  ): void {
    // ACL matrix (§6): new versions of an existing skill — skill owner or ws admin/owner
    if (skill.owner_agent_id !== auth.agent_id && auth.role !== "admin" && auth.role !== "owner") {
      throw new ApiError("FORBIDDEN", "only the skill owner or a workspace admin/owner may add versions");
    }
    if (manifest.skill_id !== skill.id) {
      throw new ApiError("INVALID_SCHEMA", "manifest.skill_id does not match the target skill");
    }
    if (manifest.access_policy !== skill.access_policy) {
      // the registered policy is the current state of the conflicting attribute
      throw new ApiError(
        "CONFLICT",
        `manifest.access_policy '${manifest.access_policy}' does not match the registered skill access_policy`,
        skill.access_policy,
      );
    }
  }

  private latestVersionState(skillId: string): string {
    const row = this.db
      .prepare("SELECT state FROM skill_versions WHERE skill_id=? ORDER BY created_at_ms DESC, id DESC LIMIT 1")
      .get(skillId) as { state: string } | undefined;
    return row?.state ?? "none";
  }

  // ------------------------------------------------------ surface 2: skill.lint

  lintVersion(auth: AuthContext, versionId: string, idempotencyKey?: string): IdempotentOutcome<LintResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.lint", idempotencyKey, this.now(), () =>
      this.lintVersionInner(auth, versionId),
    );
  }

  private lintVersionInner(auth: AuthContext, versionId: string): LintResponse {
    // Appendix H minimum role for surface 2 is `member`: an authenticated key
    // whose agent holds no workspace membership cannot lint, even as the
    // version author or skill owner (the ACL matrix columns all presuppose
    // membership — verdict 1 major #1).
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    if (typeof versionId !== "string") throw new ApiError("INVALID_SCHEMA", "skill_version_id must be a string");
    const row = this.loadVersion(versionId);
    // deny-by-default: cross-workspace versions are not acknowledged to exist
    if (!row || row.workspace_id !== auth.workspace_id) throw new ApiError("NOT_FOUND", "version not found");
    // ACL matrix (§6): lint = author / skill owner / ws admin/owner
    const allowed =
      row.author_agent_id === auth.agent_id ||
      row.owner_agent_id === auth.agent_id ||
      auth.role === "admin" ||
      auth.role === "owner";
    if (!allowed) throw new ApiError("FORBIDDEN", "only the author, skill owner or a workspace admin/owner may lint");

    let manifest: any;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      manifest = null; // unparseable stored manifest still gets a schema FAIL below
    }
    // File-level gates (secrets/urls/shell/injection/compat) read the stored
    // package blob. A version whose blob is unavailable cannot be linted —
    // running the gates over an empty file set would silently pass the file
    // scans, which is exactly the bypass §7.1 forbids.
    const blob = this.blobs.get(row.package_blob_ref);
    if (!blob) throw new ApiError("NOT_FOUND", "package blob unavailable for this version — cannot run file gates");
    const files = readArchiveBytes(blob);
    const now = this.now();
    const reports = runGates(manifest, files, { nowMs: now });
    const insert = this.db.prepare(
      "INSERT INTO lint_reports(id, skill_version_id, gate, result, details_json, created_at_ms) VALUES (?,?,?,?,?,?)",
    );
    for (const r of reports) {
      insert.run(ulid(now), versionId, r.gate, r.result, r.details === null ? null : JSON.stringify({ details: r.details }), now);
    }

    const reportsOut = reports.map((r: GateReport) => ({ gate: r.gate, result: r.result, details: r.details }));
    const anyFail = reports.some((r) => r.result === "fail");

    if (row.state === "draft") {
      if (anyFail) return { reports: reportsOut, state: "draft" };
      const t = transitionVersion(this.db, versionId, "linted");
      if (!t.ok) {
        // lost a race with a concurrent transition; converge on the current state
        throw new ApiError("PRECONDITION_FAILED", "version state changed during lint", t.current_state ?? "unknown");
      }
      return { reports: reportsOut, state: t.state };
    }
    // §6 error model / defect #1: linting a version already past draft is a
    // converging noop that reports the current state, never an error loop.
    return { reports: reportsOut, state: row.state, noop: true };
  }

  // ------------------------------------- surface 4 (read): stateless §4.4 verify

  verifyStateless(_auth: AuthContext, archive: Buffer): VerifyOutcome {
    return verifyPackage(readArchiveBytes(archive), this.db);
  }

  // ----------------------------------------------------- surface 5: skill.search

  search(auth: AuthContext, params: SearchParams): { items: SearchItem[]; next_cursor: string | null } {
    // Normative input validation lives in the service so REST and MCP cannot
    // diverge: any non-string filter is INVALID_SCHEMA, never a crash
    // (verdict 1 major #2 — a numeric `q` over MCP escaped as HTTP 500).
    for (const k of ["q", "capability", "runtime", "tool", "risk", "state", "cursor"] as const) {
      if (params[k] !== undefined && typeof params[k] !== "string") {
        throw new ApiError("INVALID_SCHEMA", `${k} must be a string`);
      }
    }
    for (const k of ["min_adopted", "min_rating", "limit"] as const) {
      if (params[k] !== undefined && typeof params[k] !== "string" && typeof params[k] !== "number") {
        throw new ApiError("INVALID_SCHEMA", `${k} must be a number`);
      }
    }
    const limit = parseLimit(params.limit);
    const cursor = parseCursor(params.cursor);
    if (params.state !== undefined && !VERSION_STATES.has(params.state)) {
      throw new ApiError("INVALID_SCHEMA", "state filter must be a version state");
    }
    if (params.risk !== undefined && !RISK_LEVELS.has(params.risk)) {
      throw new ApiError("INVALID_SCHEMA", "risk filter must be low|medium|high");
    }
    const minAdopted = parseMinAdopted(params.min_adopted);
    const minRating = parseMinRating(params.min_rating);

    const grants = this.grantsFor(auth);
    const rows = this.db
      .prepare(
        `SELECT v.id, v.skill_id, v.semantic_version, v.author_agent_id, v.manifest_json,
                v.manifest_hash, v.content_hash, v.package_blob_ref, v.state, v.superseded_by_version_id,
                v.revocation_reason, v.deprecation_at_ms, v.created_at_ms,
                s.slug, s.workspace_id, s.owner_agent_id, s.access_policy
           FROM skill_versions v JOIN skills s ON s.id = v.skill_id
          ORDER BY v.created_at_ms DESC, v.id DESC`,
      )
      .all() as unknown as VersionRow[];

    const items: SearchItem[] = [];
    let lastIncluded: VersionRow | null = null;
    let nextCursor: string | null = null;
    for (const row of rows) {
      if (cursor && !(row.created_at_ms < cursor.ms || (row.created_at_ms === cursor.ms && row.id < cursor.id))) {
        continue;
      }
      const vis = this.visibility(auth, row, grants);
      if (!vis.visible) continue;

      let manifest: any = null;
      try {
        manifest = JSON.parse(row.manifest_json);
      } catch {
        manifest = null;
      }
      if (!matchesFilters(params, row, manifest)) continue;

      // The two trust-threshold filters (§6 "min outcome count / rating") read
      // ONLY the registry-computed Reputation group — §8 threat 5: no
      // author-declared field can move either of them. They AND with the rest,
      // like every other declared filter (Appendix H, conventions).
      const registry = this.registryView(row);
      if (minAdopted !== undefined && registry.reputation.adopted_count < minAdopted) continue;
      if (minRating !== undefined) {
        // an unrated version has no rating to compare: it fails a threshold
        // rather than passing one by default
        if (registry.reputation.avg_rating === null || registry.reputation.avg_rating < minRating) continue;
      }

      if (items.length === limit) {
        // a (limit+1)-th match exists → the previous item ends this page
        nextCursor = encodeCursor(lastIncluded!);
        break;
      }
      const item: SearchItem = {
        skill_id: row.skill_id,
        slug: row.slug,
        skill_version_id: row.id,
        semantic_version: row.semantic_version,
        state: row.state,
        access_policy: row.access_policy,
        registry,
      };
      if (typeof manifest?.title === "string") item.title = manifest.title;
      if (typeof manifest?.capability_statement === "string") item.capability_statement = manifest.capability_statement;
      if (typeof manifest?.scope?.risk_level === "string") item.risk_level = manifest.scope.risk_level;
      if (vis.warning) item.warning = vis.warning;
      items.push(item);
      lastIncluded = row;
    }
    return { items, next_cursor: nextCursor };
  }

  /** skill ids granted to this actor (agent-level) or its workspace. */
  private grantsFor(auth: AuthContext): Set<string> {
    const rows = this.db
      .prepare("SELECT skill_id FROM skill_access_grants WHERE grantee_agent_id=? OR grantee_workspace_id=?")
      .all(auth.agent_id, auth.workspace_id) as Array<{ skill_id: string }>;
    return new Set(rows.map((r) => r.skill_id));
  }

  /**
   * §5.1 state-visibility table × access-policy precedence (the policy caps
   * the "members" audience and never expands state visibility), applied to one
   * (skill, version) row for one actor. Deny is the default.
   */
  private visibility(
    auth: AuthContext,
    row: VersionRow,
    grants: Set<string>,
  ): { visible: boolean; warning?: "deprecated" | "superseded" } {
    // `revoked` needs no warning flag: §5.1 asks for it to be "listed as
    // revoked", which `state` (and registry.revocation_reason) already say.
    const warning = row.state === "deprecated" || row.state === "superseded" ? row.state : undefined;
    const sameWs = auth.workspace_id === row.workspace_id;

    if (!sameWs) {
      // Cross-workspace: only states reached FROM published (BLOCKER-9). The
      // §5.1 whitelist admits deprecated/superseded/revoked solely as
      // successors of published, so "previously published" = those states.
      if (!["published", "deprecated", "superseded", "revoked"].includes(row.state)) return { visible: false };
      switch (row.access_policy) {
        case "public":
          return { visible: true, warning };
        case "invite":
          // invite: agent- or workspace-level grants (§3)
          return grants.has(row.skill_id) ? { visible: true, warning } : { visible: false };
        case "private": {
          // private: explicit AGENT grants only
          const agentGrant = this.db
            .prepare("SELECT 1 AS x FROM skill_access_grants WHERE skill_id=? AND grantee_agent_id=?")
            .get(row.skill_id, auth.agent_id) as { x: number } | undefined;
          return agentGrant ? { visible: true, warning } : { visible: false };
        }
        default: // 'workspace' never crosses the workspace boundary
          return { visible: false };
      }
    }

    // Same workspace. The §6 ACL matrix grants the skill owner and the version
    // author read unconditionally ("yes" column).
    if (row.owner_agent_id === auth.agent_id || row.author_agent_id === auth.agent_id) {
      return { visible: true, warning };
    }
    if (row.state === "draft" || row.state === "linted") {
      // "owner + admins only" — this row of §5.1 is not policy-capped
      return auth.role === "admin" || auth.role === "owner" ? { visible: true, warning } : { visible: false };
    }
    // reviewed…revoked: audience "members", capped by access_policy
    if (auth.role === null) return { visible: false };
    switch (row.access_policy) {
      case "workspace":
      case "public":
        return { visible: true, warning };
      case "invite":
        return grants.has(row.skill_id) ? { visible: true, warning } : { visible: false };
      case "private": {
        const agentGrant = this.db
          .prepare("SELECT 1 AS x FROM skill_access_grants WHERE skill_id=? AND grantee_agent_id=?")
          .get(row.skill_id, auth.agent_id) as { x: number } | undefined;
        return agentGrant ? { visible: true, warning } : { visible: false };
      }
      default:
        return { visible: false };
    }
  }

  /**
   * Registry-side groups (§4.2) as the E.2 version-registry-view.
   *
   * §8 threat 5, which Appendix H repeats for the two trust-threshold filters:
   * **Reputation is computed ONLY from server-validated receipts** and never
   * from an author-declared field. Every number below comes from a row
   * the server itself wrote —
   *   - the outcome counters read `receipt_events`, whose ONLY writer is
   *     `appendReceiptEvent` (§5.3), and an `adopted` event is refused unless
   *     its evidence validated against the version's declared
   *     `validation_gates` at append time;
   *   - `avg_rating` reads `ratings`, and surface 9 admits a rating only from
   *     an adopter holding a terminal `adopted` receipt of THIS version;
   *   - `failure_modes_observed` reads the `category` of schema-validated
   *     failure reports, not the author's `failure_modes[]` declaration.
   * Nothing here reads the signed manifest's Evidence group (`test_results`,
   * `benchmark`, `third_party_attestation`) — authors do not sign, and cannot
   * move, their own reputation (§4.2, "Reputation" bullet).
   *
   * `adoption_attempts` counts `attempted` events: an EXECUTION attempt. A
   * receipt that fails with `category: pre_execution` before `attempted` was by
   * §5.3's own definition never attempted, and is counted in `failed_count`
   * only. This is the P2 definition, unchanged.
   */
  registryView(row: Pick<VersionRow, "id" | "state" | "superseded_by_version_id" | "revocation_reason" | "deprecation_at_ms">): RegistryView {
    const db = this.db;
    const receiptIds = (
      db.prepare("SELECT id FROM adoption_receipts WHERE skill_version_id=? ORDER BY created_at_ms, id").all(row.id) as Array<{ id: string }>
    ).map((r) => r.id);
    const countEvent = db.prepare(
      `SELECT COUNT(*) AS c FROM receipt_events e JOIN adoption_receipts r ON r.id=e.adoption_receipt_id
        WHERE r.skill_version_id=? AND e.event=?`,
    );
    const count = (event: string): number => (countEvent.get(row.id, event) as { c: number }).c;
    const avg = db
      .prepare("SELECT AVG(score) AS a FROM ratings WHERE skill_version_id=?")
      .get(row.id) as { a: number | null };
    const failureReports = db
      .prepare(
        `SELECT e.failure_report_json AS f FROM receipt_events e JOIN adoption_receipts r ON r.id=e.adoption_receipt_id
          WHERE r.skill_version_id=? AND e.event='failed' AND e.failure_report_json IS NOT NULL`,
      )
      .all(row.id) as Array<{ f: string }>;
    const modes = new Set<string>();
    for (const { f } of failureReports) {
      try {
        const cat = JSON.parse(f)?.category;
        if (typeof cat === "string") modes.add(cat);
      } catch {
        // unparseable report contributes no observed mode
      }
    }
    const notes = (
      db.prepare("SELECT note FROM reviews WHERE skill_version_id=? AND note IS NOT NULL ORDER BY created_at_ms, id").all(row.id) as Array<{ note: string }>
    ).map((r) => r.note);
    return {
      state: row.state,
      superseded_by: row.superseded_by_version_id,
      deprecation_date: row.deprecation_at_ms === null ? null : new Date(row.deprecation_at_ms).toISOString(),
      revocation_reason: row.revocation_reason,
      receipt_ids: receiptIds,
      reviewer_notes: notes,
      reputation: {
        adoption_attempts: count("attempted"),
        adopted_count: count("adopted"),
        failed_count: count("failed"),
        rolled_back_count: count("rolled_back"),
        avg_rating: avg.a,
        failure_modes_observed: [...modes].sort(),
      },
    };
  }

  // ================================================================ P4 =====
  // Review workflow, approvals, attestations, transparency logging and the
  // `verified` transition. The internal phase plan makes this phase
  // NEGATIVE-scope: the receipt engine is P5, so what these surfaces must
  // demonstrate is that the gate cannot be faked or bypassed.

  // ------------------------------------------ surface 3: skill.review.request

  /**
   * Surface 3 (Appendix H): `{"action":"request"}` notifies the eligible
   * reviewers, `{"action":"verdict","verdict":…}` records one. An `approve`
   * verdict writes the `reviews` row AND the `attestations(kind=reviewer)` row
   * in ONE transaction together with the linted→reviewed transition and the
   * transparency-log entry (§6 surface 3: "reviews and reviewer attestations
   * cannot diverge, so the verified-gate conjunction has exactly one source of
   * reviewer truth").
   */
  review(
    auth: AuthContext,
    versionId: string,
    input: ReviewInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<ReviewResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.review.request", idempotencyKey, this.now(), () =>
      this.reviewInner(auth, versionId, input),
    );
  }

  private reviewInner(auth: AuthContext, versionId: string, input: ReviewInput): ReviewResponse {
    const row = this.resolveVersionForMutation(auth, versionId);
    const action = (input ?? {}).action;
    if (action !== "request" && action !== "verdict") {
      throw new ApiError("INVALID_SCHEMA", "action must be 'request' or 'verdict'");
    }
    const note = input.note;
    if (note !== undefined && note !== null && typeof note !== "string") {
      throw new ApiError("INVALID_SCHEMA", "note must be a string");
    }

    if (action === "request") {
      // Appendix H surface 3 fixes this exactly: "request: author/owner" — the
      // VERSION's author or the SKILL's owner, and nobody else. A workspace
      // admin who is neither is not on that list (P4 verdict 1, blocking #2:
      // admitting one was over-permissive against an explicit contract).
      const allowed = row.author_agent_id === auth.agent_id || row.owner_agent_id === auth.agent_id;
      if (!allowed) {
        throw new ApiError(
          "FORBIDDEN",
          "only the version author or the skill owner may request review (Appendix H surface 3: request = author/owner)",
        );
      }
      if (row.state === "reviewed") {
        // defect #1 convergence: already reviewed is not an error loop
        return { action, review_id: null, state: row.state, notified: this.eligibleReviewers(row), noop: true };
      }
      if (row.state !== "linted") {
        throw new ApiError(
          "PRECONDITION_FAILED",
          "review can only be requested for a version that passed the §7.1 gates (state `linted`)",
          row.state,
        );
      }
      const notified = this.eligibleReviewers(row);
      const now = this.now();
      this.db
        .prepare(
          "INSERT INTO activity_log(id, workspace_id, actor_agent_id, action, subject_id, details_json, created_at_ms) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          ulid(now),
          row.workspace_id,
          auth.agent_id,
          "skill.review.request",
          versionId,
          JSON.stringify({ notified, note: note ?? null }),
          now,
        );
      return { action, review_id: null, state: row.state, notified };
    }

    // --- action === "verdict"
    const verdict = input.verdict;
    if (verdict !== "approve" && verdict !== "reject" && verdict !== "conditional") {
      throw new ApiError("INVALID_SCHEMA", "verdict must be approve|reject|conditional");
    }
    // §6 surface 3 + ACL matrix: the author/skill-owner column is "never
    // (self-review)"; §5.1 adds that reviewers are same-workspace members with
    // role reviewer/admin/owner. Self-review is checked FIRST, so an author who
    // also holds admin cannot review their own version.
    if (row.author_agent_id === auth.agent_id) {
      throw new ApiError("FORBIDDEN", "the version author may not review their own version (self-review, §6 surface 3)");
    }
    if (row.owner_agent_id === auth.agent_id) {
      throw new ApiError("FORBIDDEN", "the skill owner may not review their own skill (self-review, §6 ACL matrix)");
    }
    if (auth.role !== "reviewer" && auth.role !== "admin" && auth.role !== "owner") {
      throw new ApiError("FORBIDDEN", "a review verdict requires workspace role reviewer/admin/owner (§5.1)");
    }
    if (row.state !== "linted" && row.state !== "reviewed") {
      throw new ApiError(
        "PRECONDITION_FAILED",
        "a review verdict applies to a version in state `linted` (or an already `reviewed` one)",
        row.state,
      );
    }

    const now = this.now();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      // re-read under the write lock: the state must not have moved between
      // the ACL check and the atomic write
      const fresh = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as
        | { state: VersionState }
        | undefined;
      if (!fresh || (fresh.state !== "linted" && fresh.state !== "reviewed")) {
        db.exec("ROLLBACK");
        throw new ApiError("PRECONDITION_FAILED", "version state changed during review", fresh?.state ?? "unknown");
      }
      const reviewId = ulid(now);
      db.prepare(
        "INSERT INTO reviews(id, skill_version_id, reviewer_agent_id, verdict, note, created_at_ms) VALUES (?,?,?,?,?,?)",
      ).run(reviewId, versionId, auth.agent_id, verdict, note ?? null, now);

      if (verdict !== "approve") {
        db.exec("COMMIT");
        return { action, review_id: reviewId, verdict, state: fresh.state, attestation_id: null };
      }

      const attestationId = ulid(now);
      db.prepare(
        "INSERT INTO attestations(id, skill_version_id, attester_agent_id, kind, payload_json, signature_jws, created_at_ms) VALUES (?,?,?,?,?,?,?)",
      ).run(
        attestationId,
        versionId,
        auth.agent_id,
        "reviewer",
        JSON.stringify({ review_id: reviewId, verdict, note: note ?? null }),
        null,
        now,
      );
      // §8 threat 7 (review rings): attestations are logged.
      appendTlogInTx(
        db,
        TLOG_ATTESTATION,
        versionId,
        {
          skill_version_id: versionId,
          review_id: reviewId,
          attestation_id: attestationId,
          reviewer_agent_id: auth.agent_id,
          verdict,
        },
        now,
      );
      let state: VersionState = fresh.state;
      if (fresh.state === "linted") {
        const t = transitionVersion(db, versionId, "reviewed");
        if (!t.ok) {
          db.exec("ROLLBACK");
          throw new ApiError("PRECONDITION_FAILED", "linted→reviewed refused", t.current_state ?? fresh.state);
        }
        state = t.state;
      }
      db.exec("COMMIT");
      return { action, review_id: reviewId, verdict, state, attestation_id: attestationId };
    } catch (e) {
      rollbackIfOpen(db);
      throw e;
    }
  }

  /** §5.1 reviewer eligibility: same-workspace members with role
   *  reviewer/admin/owner, minus the author and the skill owner. */
  private eligibleReviewers(row: VersionRow): string[] {
    return (
      this.db
        .prepare(
          `SELECT a.id FROM agents a JOIN workspace_memberships m ON m.agent_id = a.id AND m.workspace_id = a.workspace_id
            WHERE a.workspace_id = ? AND a.status = 'active' AND m.role IN ('reviewer','admin','owner')
              AND a.id <> ? AND a.id <> ?
            ORDER BY a.id`,
        )
        .all(row.workspace_id, row.author_agent_id, row.owner_agent_id) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  // ------------------------------------ surface 4 (transition): skill.verify

  /**
   * Surface 4 transition form. Appendix H fixes the minimum role at
   * admin/owner — the registry, not the author, decides `verified`.
   */
  verifyVersion(auth: AuthContext, versionId: string, idempotencyKey?: string): IdempotentOutcome<VerifyTransitionOutcome> {
    return withIdempotency(this.db, auth.agent_id, "skill.verify", idempotencyKey, this.now(), () =>
      this.verifyVersionInner(auth, versionId),
    );
  }

  private verifyVersionInner(auth: AuthContext, versionId: string): VerifyTransitionOutcome {
    const row = this.resolveVersionForMutation(auth, versionId);
    if (auth.role !== "admin" && auth.role !== "owner") {
      throw new ApiError("FORBIDDEN", "the `verified` transition requires workspace role admin/owner (Appendix H surface 4)");
    }
    // §5.1 conjunct 4 re-runs all eight gates, and the file gates need the
    // stored package. A version whose blob is unavailable is REFUSED rather than
    // scanned as an empty file set (the P3 rule, same reason).
    const blob = this.blobs.get(row.package_blob_ref);
    if (!blob) throw new ApiError("NOT_FOUND", "package blob unavailable for this version — cannot re-run the §7.1 gates");
    const files = readArchiveBytes(blob);
    return verifyVersionTransition(this.db, versionId, files, row.package_blob_ref, this.now());
  }

  // --------------------------------------------- surface 12: skill.publish

  /**
   * `verified → published`, the §4.3.8 countersign included.
   *
   * **ACL, derived rather than chosen.** §6's matrix has no `publish` row, so
   * the rule comes from the two places that do constrain it:
   *
   *  - §5.1 makes `published` the state that opens EXTERNAL adoption ("yes, per
   *    `access_policy` + grants" in the visibility table), reached from
   *    `verified`, which §5.1 calls an internal-only state. Appendix H fixes
   *    the minimum role for the `verified` transition (surface 4) at
   *    admin/owner because the registry, not the author, decides it. Publishing
   *    is strictly the more consequential of the two — it is what makes the
   *    package adoptable outside the workspace — so it cannot be reachable by a
   *    weaker role than the step before it. Minimum role: **admin/owner of the
   *    version's workspace**. The author, a plain member and a reviewer are all
   *    `FORBIDDEN`; a cross-workspace actor is refused by
   *    `resolveVersionForMutation` (§5.1: those operations do not exist in v1).
   *  - §5.1's "`published` additionally requires human approval whenever the
   *    §7.3 matrix demands it" is a SEPARATE, stricter condition on the version,
   *    not on the caller: the approval must come from a `type=human`
   *    admin/owner (§6 approval row). So a service identity holding role admin
   *    may make this call, but it can never supply the approval that unblocks a
   *    high-risk version — which is the §7.3 separation this surface exists to
   *    preserve.
   *
   * All of that is enforced inside `publishVersion()`'s single transaction; this
   * method adds the role check, the idempotency scope and the error envelope.
   */
  publishVersion(auth: AuthContext, versionId: string, idempotencyKey?: string): IdempotentOutcome<PublishResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.publish", idempotencyKey, this.now(), () =>
      this.publishVersionInner(auth, versionId),
    );
  }

  private publishVersionInner(auth: AuthContext, versionId: string): PublishResponse {
    const row = this.resolveVersionForMutation(auth, versionId);
    if (auth.role !== "admin" && auth.role !== "owner") {
      throw new ApiError(
        "FORBIDDEN",
        "publication requires workspace role admin/owner — §5.1 makes `published` the registry's decision, as `verified` is (Appendix H surface 4)",
      );
    }
    // The countersign module is the ONE writer of `published`; a generic
    // transition refuses with USE_PUBLISH_VERSION precisely so this path stays
    // the only one (src/transitions.ts).
    const out = countersignAndPublish(this.db, versionId, this.now());
    const t = out.transition;
    if (t.ok) {
      const res: PublishResponse = {
        skill_version_id: versionId,
        state: "published",
        manifest_hash: row.manifest_hash,
        countersign_seq: out.countersign?.seq ?? this.countersignSeqOf(row.manifest_hash),
      };
      // Republishing an already-published version is a convergent noop, never
      // an error a retry loop can get stuck on (§6 error model, defect #1).
      if (t.noop) res.noop = true;
      return res;
    }
    switch (t.code) {
      case "NOT_FOUND":
        throw new ApiError("NOT_FOUND", "version not found");
      case "APPROVAL_REQUIRED": {
        // §7.3 publish column. FORBIDDEN carries `current_state` so the caller
        // knows the version is intact and merely waiting on a human.
        let manifest: any = null;
        try {
          manifest = JSON.parse(row.manifest_json);
        } catch {
          manifest = null;
        }
        const conditions = approvalConditions(manifest, { adoptedCount: this.adoptedCountOf(versionId) });
        throw new ApiError(
          "FORBIDDEN",
          `§7.3 requires a human \`publish\` approval before this version may be published (${conditions.join(", ")})`,
          t.current_state,
        );
      }
      case "CONFLICT":
        throw new ApiError(
          "CONFLICT",
          "an unpublished version already carries a §4.3.8 countersign, or its state changed concurrently — re-read and retry",
          t.current_state ?? row.state,
        );
      default:
        throw new ApiError(
          "PRECONDITION_FAILED",
          "only a `verified` version can be published (§5.1)",
          t.current_state ?? row.state,
        );
    }
  }

  /** The §4.3.8 countersign seq already recorded for this manifest hash. */
  private countersignSeqOf(manifestHash: string): number {
    const row = this.db
      .prepare("SELECT seq FROM transparency_log WHERE event_kind=? AND subject_id=? ORDER BY seq LIMIT 1")
      .get(COUNTERSIGN_EVENT, manifestHash) as { seq: number } | undefined;
    return row?.seq ?? -1;
  }

  // ------------------------------------------------- surface 10: skill.supersede

  supersedeVersion(
    auth: AuthContext,
    versionId: string,
    input: SupersedeInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<SupersedeResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.supersede", idempotencyKey, this.now(), () =>
      this.supersedeInner(auth, versionId, input),
    );
  }

  private supersedeInner(auth: AuthContext, versionId: string, input: SupersedeInput): SupersedeResponse {
    const row = this.resolveVersionForMutation(auth, versionId);
    // §6 ACL matrix "supersede": author/skill owner, reviewer, admin/owner.
    const allowed =
      row.author_agent_id === auth.agent_id ||
      row.owner_agent_id === auth.agent_id ||
      auth.role === "reviewer" ||
      auth.role === "admin" ||
      auth.role === "owner";
    if (!allowed) throw new ApiError("FORBIDDEN", "supersede requires the author, skill owner, or a reviewer/admin/owner");

    const successorId = (input ?? {}).successor_version_id;
    if (typeof successorId !== "string" || successorId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "successor_version_id (string) required");
    }
    if (successorId === versionId) throw new ApiError("INVALID_SCHEMA", "a version cannot supersede itself");
    const successor = this.loadVersion(successorId);
    if (!successor || successor.workspace_id !== auth.workspace_id) {
      throw new ApiError("NOT_FOUND", "successor version not found");
    }
    if (successor.skill_id !== row.skill_id) {
      throw new ApiError("INVALID_SCHEMA", "the successor must be a version of the same skill");
    }
    if (successor.state !== "verified" && successor.state !== "published") {
      throw new ApiError(
        "PRECONDITION_FAILED",
        "the successor must itself have reached `verified` or `published` before it can retire its predecessor",
        successor.state,
      );
    }
    // The successor's `supersedes` is author-signed (§4.2 Lifecycle); when it
    // is declared it must name this predecessor, or the registry-side link and
    // the signed manifest would contradict each other.
    let declaredSupersedes: unknown = null;
    try {
      declaredSupersedes = JSON.parse(successor.manifest_json)?.lifecycle?.supersedes ?? null;
    } catch {
      declaredSupersedes = null;
    }
    if (typeof declaredSupersedes === "string" && declaredSupersedes !== versionId) {
      throw new ApiError(
        "CONFLICT",
        "the successor's signed lifecycle.supersedes names a different version",
        declaredSupersedes,
      );
    }

    if (row.state === "superseded") {
      // converging noop (defect #1): report the recorded link
      return {
        skill_version_id: versionId,
        state: "superseded",
        superseded_by: row.superseded_by_version_id,
        successor: { skill_version_id: successorId, state: successor.state },
        noop: true,
      };
    }
    if (row.state !== "published") {
      throw new ApiError("PRECONDITION_FAILED", "only a published version can be superseded (§5.1)", row.state);
    }

    const now = this.now();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      // §6 surface 10: "both versions' Lifecycle fields updated atomically".
      // D.1 gives each side its own column — the predecessor's
      // `superseded_by_version_id` (+ state) and the successor's
      // `supersedes_version_id` — so both writes and the tlog append land in
      // this one transaction or none of them do.
      const freshSuccessor = db
        .prepare("SELECT state, supersedes_version_id FROM skill_versions WHERE id=?")
        .get(successorId) as { state: VersionState; supersedes_version_id: string | null } | undefined;
      if (!freshSuccessor || (freshSuccessor.state !== "verified" && freshSuccessor.state !== "published")) {
        db.exec("ROLLBACK");
        throw new ApiError("PRECONDITION_FAILED", "successor state changed during supersede", freshSuccessor?.state ?? "unknown");
      }
      if (freshSuccessor.supersedes_version_id !== null && freshSuccessor.supersedes_version_id !== versionId) {
        db.exec("ROLLBACK");
        throw new ApiError(
          "CONFLICT",
          "the successor already supersedes a different version",
          freshSuccessor.supersedes_version_id,
        );
      }
      const res = db
        .prepare("UPDATE skill_versions SET state='superseded', superseded_by_version_id=? WHERE id=? AND state='published'")
        .run(successorId, versionId);
      if (res.changes !== 1) {
        db.exec("ROLLBACK");
        const current = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as { state: VersionState };
        throw new ApiError("PRECONDITION_FAILED", "version state changed during supersede", current.state);
      }
      const linked = db
        .prepare("UPDATE skill_versions SET supersedes_version_id=? WHERE id=? AND supersedes_version_id IS NULL")
        .run(versionId, successorId);
      if (linked.changes !== 1 && freshSuccessor.supersedes_version_id !== versionId) {
        db.exec("ROLLBACK");
        throw new ApiError("CONFLICT", "successor lifecycle changed during supersede", freshSuccessor.state);
      }
      const tlog = appendTlogInTx(
        db,
        TLOG_SUPERSEDED,
        versionId,
        { skill_version_id: versionId, superseded_by: successorId, actor_agent_id: auth.agent_id },
        now,
      );
      db.exec("COMMIT");
      return {
        skill_version_id: versionId,
        state: "superseded",
        superseded_by: successorId,
        successor: { skill_version_id: successorId, state: freshSuccessor.state },
        tlog_seq: tlog.seq,
      };
    } catch (e) {
      rollbackIfOpen(db);
      throw e;
    }
  }

  // ---------------------------------------------------- surface 11: skill.revoke

  revokeVersion(
    auth: AuthContext,
    versionId: string,
    input: RevokeInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<RevokeResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.revoke", idempotencyKey, this.now(), () =>
      this.revokeInner(auth, versionId, input),
    );
  }

  private revokeInner(auth: AuthContext, versionId: string, input: RevokeInput): RevokeResponse {
    const row = this.resolveVersionForMutation(auth, versionId);
    // §6 ACL matrix "revoke": author/skill owner, admin/owner — NOT a reviewer.
    const allowed =
      row.author_agent_id === auth.agent_id ||
      row.owner_agent_id === auth.agent_id ||
      auth.role === "admin" ||
      auth.role === "owner";
    if (!allowed) throw new ApiError("FORBIDDEN", "revoke requires the author, skill owner, or a workspace admin/owner");

    const reason = (input ?? {}).reason;
    if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2000) {
      throw new ApiError("INVALID_SCHEMA", "reason (non-empty string ≤2000 chars) required — §6 surface 11");
    }

    if (row.state === "revoked") {
      return { skill_version_id: versionId, state: "revoked", reason: row.revocation_reason, noop: true };
    }
    if (row.state !== "published") {
      throw new ApiError("PRECONDITION_FAILED", "only a published version can be revoked (§5.1)", row.state);
    }

    const now = this.now();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const res = db
        .prepare("UPDATE skill_versions SET state='revoked', revocation_reason=? WHERE id=? AND state='published'")
        .run(reason, versionId);
      if (res.changes !== 1) {
        db.exec("ROLLBACK");
        const current = db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as { state: VersionState };
        throw new ApiError("PRECONDITION_FAILED", "version state changed during revoke", current.state);
      }
      const tlog = appendTlogInTx(
        db,
        TLOG_REVOKED,
        versionId,
        { skill_version_id: versionId, reason, actor_agent_id: auth.agent_id },
        now,
      );
      // §6 surface 11 / §5.1 tail table: "active adopters are notified through
      // the delivery machine". Queued in the SAME transaction as the state
      // change, so there is no window in which a version is revoked and its
      // adopters were never told — and no notice for a revocation that rolled
      // back. From here the §5.2 machine owns them: lease, backoff, endpoint
      // health, and a loud dead letter for an adopter with no endpoint.
      const notices = enqueueRevocationNoticesInTx(db, versionId, now, (adopter) => selectWebhook(db, adopter));
      db.exec("COMMIT");
      return {
        skill_version_id: versionId,
        state: "revoked",
        reason,
        tlog_seq: tlog.seq,
        notified_adopters: notices.length,
      };
    } catch (e) {
      rollbackIfOpen(db);
      throw e;
    }
  }

  // ------------------------------------------------ surface 13: skill.deprecate

  /**
   * `published → deprecated`. §5.1 promises this transition and the whitelist
   * has always contained it, but it was unreachable: the generic transition
   * path is not exported through either adapter, so `deprecated` had no way in.
   *
   * **ACL, derived rather than chosen.** §6's matrix has no deprecate row.
   * Deprecation is a retirement WITHOUT a successor: §5.1's visibility table
   * makes it the mildest of the three tails ("visible with warning; adoption
   * warns", against revoke's "adoption blocked"). The matrix gives supersede an
   * extra actor over revoke — the reviewer — because naming a successor is a
   * judgement about a replacement package. Deprecation names none, so it takes
   * the revoke row exactly: **the version's author, the skill's owner, or a
   * workspace admin/owner**. A reviewer holds no special claim here, and a
   * cross-workspace actor is refused by `resolveVersionForMutation`.
   *
   * The transition itself goes through `transitionVersion`, so the §5.1
   * whitelist stays the single source of truth for which states may follow
   * `published` — this method never hardcodes the legal predecessor.
   */
  deprecateVersion(auth: AuthContext, versionId: string, idempotencyKey?: string): IdempotentOutcome<DeprecateResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.deprecate", idempotencyKey, this.now(), () =>
      this.deprecateInner(auth, versionId),
    );
  }

  private deprecateInner(auth: AuthContext, versionId: string): DeprecateResponse {
    const row = this.resolveVersionForMutation(auth, versionId);
    const allowed =
      row.author_agent_id === auth.agent_id ||
      row.owner_agent_id === auth.agent_id ||
      auth.role === "admin" ||
      auth.role === "owner";
    if (!allowed) {
      throw new ApiError("FORBIDDEN", "deprecate requires the author, skill owner, or a workspace admin/owner");
    }

    const now = this.now();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const t = transitionVersion(db, versionId, "deprecated");
      if (!t.ok) {
        db.exec("ROLLBACK");
        if (t.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", "version not found");
        throw new ApiError(
          "PRECONDITION_FAILED",
          "only a published version can be deprecated (§5.1)",
          t.current_state ?? row.state,
        );
      }
      if (t.noop) {
        // already deprecated: converging noop (§6, defect #1) — report the
        // recorded date rather than stamping a second one
        db.exec("ROLLBACK");
        const recorded = db.prepare("SELECT deprecation_at_ms AS ms FROM skill_versions WHERE id=?").get(versionId) as
          | { ms: number | null }
          | undefined;
        return {
          skill_version_id: versionId,
          state: "deprecated",
          deprecation_date: recorded?.ms == null ? null : new Date(recorded.ms).toISOString(),
          noop: true,
        };
      }
      // §4.2 Lifecycle-registry `deprecation_date`: written by the registry
      // clock in the SAME transaction as the state change, so a `deprecated`
      // version can never be missing its date. Guarded on NULL so a repeated
      // path could never move an already-recorded date forward.
      db.prepare("UPDATE skill_versions SET deprecation_at_ms=? WHERE id=? AND deprecation_at_ms IS NULL").run(
        now,
        versionId,
      );
      const tlog = appendTlogInTx(
        db,
        TLOG_DEPRECATED,
        versionId,
        { skill_version_id: versionId, actor_agent_id: auth.agent_id },
        now,
      );
      const stamped = db.prepare("SELECT deprecation_at_ms AS ms FROM skill_versions WHERE id=?").get(versionId) as {
        ms: number | null;
      };
      db.exec("COMMIT");
      return {
        skill_version_id: versionId,
        state: "deprecated",
        deprecation_date: stamped.ms == null ? null : new Date(stamped.ms).toISOString(),
        tlog_seq: tlog.seq,
      };
    } catch (e) {
      rollbackIfOpen(db);
      throw e;
    }
  }

  // -------------------------------------------------------- §7.3 approvals

  /**
   * Record a §7.3 human approval. Appendix H's numbered-surface table has no
   * approval tool because §7.3 makes approval an API-LEVEL enforcement point
   * rather than a skill surface; this follows H's auxiliary-endpoint pattern
   * (`/v1/auth/bootstrap`, `/v1/receipts/{id}`, `/v1/tlog`). It has to exist as
   * an API path: §6 makes "service key passing a human gate" a mandatory
   * negative test on BOTH adapters.
   */
  approve(
    auth: AuthContext,
    versionId: string,
    input: ApproveInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<ApprovalResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.approve", idempotencyKey, this.now(), () =>
      this.approveInner(auth, versionId, input),
    );
  }

  private approveInner(auth: AuthContext, versionId: string, input: ApproveInput): ApprovalResponse {
    const row = this.resolveVersionForMutation(auth, versionId);
    let manifest: any = null;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      manifest = null;
    }
    const adopted = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM receipt_events e JOIN adoption_receipts r ON r.id = e.adoption_receipt_id
          WHERE r.skill_version_id = ? AND e.event = 'adopted'`,
      )
      .get(versionId) as { c: number };
    return recordApproval(
      this.db,
      {
        skill_version_id: versionId,
        scope: (input ?? {}).scope as ApprovalScope,
        decision: (input ?? {}).decision as ApprovalDecision,
        adoption_request_id: (input ?? {}).adoption_request_id ?? null,
        note: (input ?? {}).note ?? null,
      },
      {
        approver_agent_id: auth.agent_id,
        workspace_id: row.workspace_id,
        manifest,
        adoptedCount: adopted.c,
        nowMs: this.now(),
      },
    );
  }

  // ------------------------------------------- provisioning (Appendix H aux)
  //
  // src/provision.ts carries the rules and the reasoning; these are the entry
  // points both adapters call, so REST and MCP cannot diverge (§2).
  //
  // The two calls that RETURN a one-time secret take no `idempotency_key`: a
  // replay is served from `idempotency_keys.response_json`, and persisting a
  // plaintext API key there would undo "stored only as a hash". Webhook
  // registration, which returns a secret for the same reason, already sets
  // that precedent.

  /** `POST /v1/principals` — owner/admin creates a principal and its ONE-TIME key. */
  createPrincipal(auth: AuthContext, input: Record<string, unknown>): CreatedPrincipal {
    return createPrincipal(this.db, auth, input ?? {}, this.now());
  }

  /** `GET /v1/principals` — the workspace roster for admin/owner, own row for a member. */
  listPrincipals(auth: AuthContext): { items: PrincipalView[] } {
    return listPrincipals(this.db, auth);
  }

  /** `POST /v1/principals/{id}/api-keys` — mint a replacement key, shown once. */
  issueApiKey(auth: AuthContext, principalId: unknown): IssuedApiKey {
    return issueApiKey(this.db, auth, principalId, this.now());
  }

  /** `POST /v1/principals/{id}/api-keys/{key_id}/revoke` — own key, or admin/owner. */
  revokeApiKey(
    auth: AuthContext,
    principalId: unknown,
    keyId: unknown,
    idempotencyKey?: string,
  ): IdempotentOutcome<RevokedApiKey> {
    return withIdempotency(this.db, auth.agent_id, "principal.revoke_api_key", idempotencyKey, this.now(), () =>
      revokeApiKey(this.db, auth, principalId, keyId, this.now()),
    );
  }

  /** `POST /v1/signing-keys` — the caller registers its OWN Ed25519 key (§4.3.8). */
  registerSigningKey(
    auth: AuthContext,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ): IdempotentOutcome<RegisteredSigningKey> {
    return withIdempotency(this.db, auth.agent_id, "signing_key.register", idempotencyKey, this.now(), () =>
      registerSigningKey(this.db, auth, input ?? {}, this.now()),
    );
  }

  /** `POST /v1/signing-keys/{kid}/revoke` — own key, or admin/owner of its holder. */
  revokeSigningKey(auth: AuthContext, kid: unknown, idempotencyKey?: string): IdempotentOutcome<RevokedSigningKey> {
    return withIdempotency(this.db, auth.agent_id, "signing_key.revoke", idempotencyKey, this.now(), () =>
      revokeSigningKey(this.db, auth, kid, this.now()),
    );
  }

  /** `GET /v1/signing-keys` — own keys; admin/owner sees the workspace's. */
  listSigningKeys(auth: AuthContext): { items: SigningKeyView[] } {
    return listSigningKeys(this.db, auth);
  }

  // ------------------------------------- webhook management (own only, H aux)

  /** `POST /v1/webhooks` — the plaintext secret is shown ONCE here and never
   *  again (Appendix H); SQLite stores only its hash and its ref (§5.2). */
  registerWebhook(auth: AuthContext, input: { url?: unknown }): RegisteredWebhook {
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    return registerWebhook(this.db, this.secrets, auth.agent_id, (input ?? {}).url, this.now());
  }

  /** `DELETE /v1/webhooks/{id}` — own only. */
  deleteWebhook(auth: AuthContext, webhookId: string): { deleted: boolean } {
    if (typeof webhookId !== "string") throw new ApiError("INVALID_SCHEMA", "webhook_id must be a string");
    return deleteWebhook(this.db, this.secrets, auth.agent_id, webhookId);
  }

  /** `GET /v1/webhooks` — own endpoints, with the health §5.2 defines. */
  listWebhooks(auth: AuthContext): { items: ReturnType<typeof listWebhooks> } {
    return { items: listWebhooks(this.db, auth.agent_id) };
  }

  /**
   * `GET /v1/receipts/{id}` (Appendix H auxiliary): owner/adopter/admin read.
   * The chain is returned in `event_seq` order — the only normative order.
   */
  readReceipt(auth: AuthContext, receiptId: string): ReceiptView {
    if (typeof receiptId !== "string" || receiptId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "receipt_id must be a string");
    }
    const receipt = this.db
      .prepare(
        `SELECT r.id, r.adoption_request_id, r.skill_version_id, r.adopter_agent_id, r.created_at_ms,
                s.workspace_id, s.owner_agent_id
           FROM adoption_receipts r
           JOIN skill_versions v ON v.id = r.skill_version_id
           JOIN skills s ON s.id = v.skill_id
          WHERE r.id = ?`,
      )
      .get(receiptId) as
      | {
          id: string;
          adoption_request_id: string;
          skill_version_id: string;
          adopter_agent_id: string;
          created_at_ms: number;
          workspace_id: string;
          owner_agent_id: string;
        }
      | undefined;
    if (!receipt) throw new ApiError("NOT_FOUND", "receipt not found");
    const isAdopter = receipt.adopter_agent_id === auth.agent_id;
    const isWsAdmin =
      receipt.workspace_id === auth.workspace_id && (auth.role === "admin" || auth.role === "owner");
    const isSkillOwner = receipt.owner_agent_id === auth.agent_id;
    if (!isAdopter && !isWsAdmin && !isSkillOwner) throw new ApiError("NOT_FOUND", "receipt not found");

    const events = this.db
      .prepare(
        `SELECT event, event_seq, server_at_ms, evidence_json, failure_report_json, rollback_report_json,
                environment_json
           FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq`,
      )
      .all(receiptId) as Array<{
      event: ReceiptEvent;
      event_seq: number;
      server_at_ms: number;
      evidence_json: string | null;
      failure_report_json: string | null;
      rollback_report_json: string | null;
      environment_json: string | null;
    }>;
    return {
      receipt_id: receipt.id,
      adoption_request_id: receipt.adoption_request_id,
      skill_version_id: receipt.skill_version_id,
      adopter_agent_id: receipt.adopter_agent_id,
      derived_state: derivedState(this.db, receiptId),
      stalled: isStalled(this.db, receiptId, this.now()),
      events: events.map((e) => ({
        event: e.event,
        event_seq: e.event_seq,
        server_at_ms: e.server_at_ms,
        evidence: e.evidence_json === null ? null : JSON.parse(e.evidence_json),
        failure_report: e.failure_report_json === null ? null : JSON.parse(e.failure_report_json),
        rollback_report: e.rollback_report_json === null ? null : JSON.parse(e.rollback_report_json),
        environment_descriptor:
          e.environment_json === null ? null : (JSON.parse(e.environment_json).environment_descriptor ?? null),
      })),
    };
  }

  // -------------------------------------------- transparency log (public read)

  /** `GET /v1/tlog?cursor=` (Appendix H auxiliary endpoint). */
  readTlog(_auth: AuthContext, params: { cursor?: unknown; limit?: unknown }): { items: TlogRow[]; next_cursor: string | null } {
    const { cursor, limit } = params ?? {};
    if (cursor !== undefined && typeof cursor !== "string") throw new ApiError("INVALID_SCHEMA", "cursor must be a string");
    if (limit !== undefined && typeof limit !== "string" && typeof limit !== "number") {
      throw new ApiError("INVALID_SCHEMA", "limit must be a number");
    }
    const n = parseLimit(limit as string | number | undefined);
    let after = 0;
    if (cursor !== undefined) {
      const parsedCursor = Number(cursor);
      if (!Number.isInteger(parsedCursor) || parsedCursor < 0) throw new ApiError("INVALID_SCHEMA", "malformed cursor");
      after = parsedCursor;
    }
    const rows = this.db
      .prepare("SELECT * FROM transparency_log WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(after, n + 1) as unknown as TlogRow[];
    const items = rows.slice(0, n);
    const next = rows.length > n && items.length > 0 ? String(items[items.length - 1].seq) : null;
    return { items, next_cursor: next };
  }

  // ================================================================ P6 =====
  // The dashboard (internal phase plan, P6 row; Appendix H `dashboard.view`).
  // Five views, each a THIN read layer: every row is built from the fields the
  // surfaces already return, and every row is filtered by the SAME ACL the
  // underlying read enforces — a dashboard that widened visibility would be a
  // bypass, not a view.

  /**
   * `GET /v1/dashboard/{view}` (and MCP `dashboard.view`). `params` are the
   * surface-5 search parameters for the views that page over versions.
   */
  dashboard(auth: AuthContext, view: unknown, params: SearchParams = {}): DashboardPayload {
    if (!isDashboardView(view)) {
      throw new ApiError("INVALID_SCHEMA", `view must be one of ${DASHBOARD_VIEWS.join(", ")}`);
    }
    switch (view) {
      case "library":
        return this.dashLibrary(auth, params);
      case "evidence":
        return this.dashEvidence(auth, params);
      case "receipts":
        return this.dashReceipts(auth, params);
      case "approvals":
        return this.dashApprovals(auth, params);
      case "dead_letters":
        return this.dashDeadLetters(auth, params);
      case "migrations":
        return this.dashMigrations(auth, params);
    }
  }

  private payload(view: DashboardView, title: string, sections: DashboardSection[]): DashboardPayload {
    // §9.1: the demo-mode label is part of every view's payload, so both
    // adapters carry it and the rendered page can show it prominently.
    return { view, title, views: DASHBOARD_VIEWS, sections, demo_mode: demoMode(this.db) };
  }

  /** Library — surface 5's items, including the registry-computed Reputation. */
  private dashLibrary(auth: AuthContext, params: SearchParams): DashboardPayload {
    const { items, next_cursor } = this.search(auth, params);
    const rows = items.map((i) => ({
      skill_id: i.skill_id,
      slug: i.slug,
      skill_version_id: i.skill_version_id,
      semantic_version: i.semantic_version,
      state: i.state,
      risk_level: i.risk_level ?? null,
      access_policy: i.access_policy,
      warning: i.warning ?? null,
      adoption_attempts: i.registry.reputation.adoption_attempts,
      adopted_count: i.registry.reputation.adopted_count,
      failed_count: i.registry.reputation.failed_count,
      rolled_back_count: i.registry.reputation.rolled_back_count,
      avg_rating: i.registry.reputation.avg_rating,
      failure_modes_observed: i.registry.reputation.failure_modes_observed,
    }));
    return this.payload("library", "Library", [
      {
        key: "library",
        title: "Visible skill versions (§5.1 visibility × access policy) with their Reputation",
        fields: [
          "skill_id",
          "slug",
          "skill_version_id",
          "semantic_version",
          "state",
          "risk_level",
          "access_policy",
          "warning",
          "adoption_attempts",
          "adopted_count",
          "failed_count",
          "rolled_back_count",
          "avg_rating",
          "failure_modes_observed",
        ],
        rows,
        empty: "no version is visible to this actor",
        next_cursor,
      },
    ]);
  }

  /**
   * Evidence — the server-validated `adopted` receipts behind each visible
   * version, plus the reviewer notes the registry view carries. Nothing here is
   * author-declared: the gate results shown are the payload the receipt machine
   * validated against the version's `validation_gates` at append time (§5.1).
   */
  private dashEvidence(auth: AuthContext, params: SearchParams): DashboardPayload {
    const { items, next_cursor } = this.search(auth, params);
    const stmt = this.db.prepare(
      `SELECT r.id AS receipt_id, r.adopter_agent_id, e.event_seq, e.server_at_ms, e.evidence_json
         FROM receipt_events e JOIN adoption_receipts r ON r.id = e.adoption_receipt_id
        WHERE r.skill_version_id = ? AND e.event = 'adopted' AND e.evidence_json IS NOT NULL
        ORDER BY e.server_at_ms, r.id`,
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const evs = stmt.all(item.skill_version_id) as Array<{
        receipt_id: string;
        adopter_agent_id: string;
        event_seq: number;
        server_at_ms: number;
        evidence_json: string;
      }>;
      for (const e of evs) {
        let gates: string[] = [];
        try {
          const parsed = JSON.parse(e.evidence_json);
          if (Array.isArray(parsed?.gate_results)) {
            gates = parsed.gate_results.map((g: any) => `${String(g?.gate_id)}=${g?.pass === true ? "pass" : "fail"}`);
          }
        } catch {
          gates = ["unreadable evidence payload"];
        }
        rows.push({
          slug: item.slug,
          skill_version_id: item.skill_version_id,
          semantic_version: item.semantic_version,
          state: item.state,
          receipt_id: e.receipt_id,
          adopter_agent_id: e.adopter_agent_id,
          event_seq: e.event_seq,
          server_at_ms: e.server_at_ms,
          gate_results: gates,
          reviewer_notes: item.registry.reviewer_notes,
        });
      }
    }
    return this.payload("evidence", "Evidence", [
      {
        key: "evidence",
        title: "Server-validated adoption evidence (§5.1 evidence conjunct)",
        fields: [
          "slug",
          "skill_version_id",
          "semantic_version",
          "state",
          "receipt_id",
          "adopter_agent_id",
          "event_seq",
          "server_at_ms",
          "gate_results",
          "reviewer_notes",
        ],
        rows,
        empty: "no validated adoption evidence is visible to this actor",
        // the cursor pages the VERSIONS this view reads, exactly as surface 5 does
        next_cursor,
      },
    ]);
  }

  /** Receipts — the chains this actor may read, in `event_seq` order (§5.3). */
  private dashReceipts(auth: AuthContext, params: SearchParams): DashboardPayload {
    const limit = parseLimit(params.limit);
    const all = this.db
      .prepare(
        `SELECT r.id AS receipt_id, r.adoption_request_id, r.skill_version_id, r.adopter_agent_id,
                r.created_at_ms, s.slug, s.workspace_id, s.owner_agent_id,
                q.state AS request_state, q.dead_letter_reason, q.attempt_count
           FROM adoption_receipts r
           JOIN skill_versions v ON v.id = r.skill_version_id
           JOIN skills s ON s.id = v.skill_id
           LEFT JOIN adoption_requests q ON q.id = r.adoption_request_id
          ORDER BY r.created_at_ms DESC, r.id DESC`,
      )
      .all() as Array<{
      receipt_id: string;
      adoption_request_id: string;
      skill_version_id: string;
      adopter_agent_id: string;
      created_at_ms: number;
      slug: string;
      workspace_id: string;
      owner_agent_id: string;
      request_state: string | null;
      dead_letter_reason: string | null;
      attempt_count: number | null;
    }>;
    const events = this.db.prepare(
      "SELECT event, event_seq, server_at_ms FROM receipt_events WHERE adoption_receipt_id=? ORDER BY event_seq",
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const r of all) {
      if (rows.length === limit) break;
      // exactly the `GET /v1/receipts/{id}` rule: adopter, skill owner, or an
      // admin/owner of the skill's workspace
      if (!this.mayReadReceipt(auth, r)) continue;
      const evs = events.all(r.receipt_id) as Array<{ event: string; event_seq: number; server_at_ms: number }>;
      rows.push({
        receipt_id: r.receipt_id,
        adoption_request_id: r.adoption_request_id,
        skill_version_id: r.skill_version_id,
        slug: r.slug,
        adopter_agent_id: r.adopter_agent_id,
        derived_state: derivedState(this.db, r.receipt_id),
        stalled: isStalled(this.db, r.receipt_id, this.now()),
        request_state: r.request_state,
        dead_letter_reason: r.dead_letter_reason,
        attempt_count: r.attempt_count,
        events: evs.map((e) => `${e.event_seq}:${e.event}@${e.server_at_ms}`),
      });
    }
    return this.payload("receipts", "Receipts", [
      {
        key: "receipts",
        title: "Adoption receipts readable by this actor, in event_seq order",
        fields: [
          "receipt_id",
          "adoption_request_id",
          "skill_version_id",
          "slug",
          "adopter_agent_id",
          "derived_state",
          "stalled",
          "request_state",
          "dead_letter_reason",
          "attempt_count",
          "events",
        ],
        rows,
        empty: "no receipt is readable by this actor",
      },
    ]);
  }

  private mayReadReceipt(
    auth: AuthContext,
    r: { adopter_agent_id: string; workspace_id: string; owner_agent_id: string },
  ): boolean {
    if (r.adopter_agent_id === auth.agent_id) return true;
    if (r.owner_agent_id === auth.agent_id) return true;
    return r.workspace_id === auth.workspace_id && (auth.role === "admin" || auth.role === "owner");
  }

  /**
   * Approvals — the §7.3 lane: requests HELD in `approval_pending` (§5.2)
   * with the matrix conditions that put them there, and the decisions already
   * recorded. Visible to the parties and to the workspace's admins/owners.
   */
  private dashApprovals(auth: AuthContext, params: SearchParams): DashboardPayload {
    const limit = parseLimit(params.limit);
    const isWsAdmin = (workspaceId: string): boolean =>
      workspaceId === auth.workspace_id && (auth.role === "admin" || auth.role === "owner");

    const holdRows = this.db
      .prepare(
        `SELECT q.id AS adoption_request_id, q.skill_version_id, q.adopter_agent_id, q.state, q.created_at_ms,
                s.slug, s.workspace_id, s.owner_agent_id, v.author_agent_id, v.manifest_json
           FROM adoption_requests q
           JOIN skill_versions v ON v.id = q.skill_version_id
           JOIN skills s ON s.id = v.skill_id
          WHERE q.state = 'approval_pending'
          ORDER BY q.created_at_ms, q.id`,
      )
      .all() as Array<{
      adoption_request_id: string;
      skill_version_id: string;
      adopter_agent_id: string;
      state: string;
      created_at_ms: number;
      slug: string;
      workspace_id: string;
      owner_agent_id: string;
      author_agent_id: string;
      manifest_json: string;
    }>;
    const holds: Array<Record<string, unknown>> = [];
    for (const h of holdRows) {
      if (holds.length === limit) break;
      const party =
        h.adopter_agent_id === auth.agent_id ||
        h.owner_agent_id === auth.agent_id ||
        h.author_agent_id === auth.agent_id ||
        isWsAdmin(h.workspace_id);
      if (!party) continue;
      let manifest: any = null;
      try {
        manifest = JSON.parse(h.manifest_json);
      } catch {
        manifest = null;
      }
      holds.push({
        adoption_request_id: h.adoption_request_id,
        skill_version_id: h.skill_version_id,
        slug: h.slug,
        adopter_agent_id: h.adopter_agent_id,
        state: h.state,
        conditions: approvalConditions(manifest, { adoptedCount: this.adoptedCountOf(h.skill_version_id) }),
        created_at_ms: h.created_at_ms,
      });
    }

    const decisionRows = this.db
      .prepare(
        `SELECT a.id AS approval_id, a.skill_version_id, a.adoption_request_id, a.approver_agent_id,
                a.scope, a.decision, a.note, a.created_at_ms,
                s.slug, s.workspace_id, s.owner_agent_id, v.author_agent_id, q.adopter_agent_id
           FROM approvals a
           JOIN skill_versions v ON v.id = a.skill_version_id
           JOIN skills s ON s.id = v.skill_id
           LEFT JOIN adoption_requests q ON q.id = a.adoption_request_id
          ORDER BY a.created_at_ms DESC, a.id DESC`,
      )
      .all() as Array<{
      approval_id: string;
      skill_version_id: string;
      adoption_request_id: string | null;
      approver_agent_id: string;
      scope: string;
      decision: string;
      note: string | null;
      created_at_ms: number;
      slug: string;
      workspace_id: string;
      owner_agent_id: string;
      author_agent_id: string;
      adopter_agent_id: string | null;
    }>;
    const decisions: Array<Record<string, unknown>> = [];
    for (const d of decisionRows) {
      if (decisions.length === limit) break;
      const party =
        d.approver_agent_id === auth.agent_id ||
        d.owner_agent_id === auth.agent_id ||
        d.author_agent_id === auth.agent_id ||
        d.adopter_agent_id === auth.agent_id ||
        isWsAdmin(d.workspace_id);
      if (!party) continue;
      decisions.push({
        approval_id: d.approval_id,
        skill_version_id: d.skill_version_id,
        slug: d.slug,
        adoption_request_id: d.adoption_request_id,
        scope: d.scope,
        decision: d.decision,
        approver_agent_id: d.approver_agent_id,
        note: d.note,
        created_at_ms: d.created_at_ms,
      });
    }

    return this.payload("approvals", "Approvals", [
      {
        key: "holds",
        title: "Adoption requests held for a §7.3 human approval (§5.2)",
        fields: [
          "adoption_request_id",
          "skill_version_id",
          "slug",
          "adopter_agent_id",
          "state",
          "conditions",
          "created_at_ms",
        ],
        rows: holds,
        empty: "no adoption request is waiting for a human approval",
      },
      {
        key: "decisions",
        title: "Recorded §7.3 decisions",
        fields: [
          "approval_id",
          "skill_version_id",
          "slug",
          "adoption_request_id",
          "scope",
          "decision",
          "approver_agent_id",
          "note",
          "created_at_ms",
        ],
        rows: decisions,
        empty: "no approval decision is visible to this actor",
      },
    ]);
  }

  /**
   * Dead letters — §5.2's loud undeliverability, plus the endpoint health that
   * explains it. Appendix H leaves the CHOICE of sections to the rendering, and
   * this one is on this view because an endpoint gone `dead` is usually WHY the
   * letters are there. The endpoint rows carry status, failure_count and
   * last_error and NEVER the secret or its ref (Appendix H, `GET /v1/webhooks`:
   * "never the secret, never its reference").
   */
  private dashDeadLetters(auth: AuthContext, params: SearchParams): DashboardPayload {
    const limit = parseLimit(params.limit);
    const detail = this.db.prepare(
      `SELECT q.attempt_count, q.created_at_ms, s.slug, s.workspace_id, s.owner_agent_id
         FROM adoption_requests q
         JOIN skill_versions v ON v.id = q.skill_version_id
         JOIN skills s ON s.id = v.skill_id
        WHERE q.id = ?`,
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const dl of deadLetters(this.db)) {
      if (rows.length === limit) break;
      const d = detail.get(dl.id) as
        | { attempt_count: number; created_at_ms: number; slug: string; workspace_id: string; owner_agent_id: string }
        | undefined;
      if (!d) continue;
      if (!this.mayReadReceipt(auth, { adopter_agent_id: dl.adopter_agent_id, ...d })) continue;
      rows.push({
        adoption_request_id: dl.id,
        // which message failed to arrive: an adoption notification, or a
        // surface-11 revocation notice. Undeliverable is loud either way, but
        // an operator needs to know WHICH adopter was not told what.
        notification_kind: dl.notification_kind,
        reason: dl.reason,
        adopter_agent_id: dl.adopter_agent_id,
        skill_version_id: dl.skill_version_id,
        slug: d.slug,
        attempt_count: d.attempt_count,
        created_at_ms: d.created_at_ms,
      });
    }

    // own endpoints always; a workspace admin/owner sees the workspace's, which
    // is what makes "dashboard shows failing webhooks", the P6 review subject
    // of the internal phase plan, operable
    let agentIds = [auth.agent_id];
    if (auth.role === "admin" || auth.role === "owner") {
      agentIds = (
        this.db.prepare("SELECT id FROM agents WHERE workspace_id=? ORDER BY id").all(auth.workspace_id) as Array<{
          id: string;
        }>
      ).map((r) => r.id);
      if (!agentIds.includes(auth.agent_id)) agentIds.push(auth.agent_id);
    }

    return this.payload("dead_letters", "Dead letters", [
      {
        key: "dead_letters",
        title: "Dead-lettered adoption requests (§5.2 — undeliverability is loud)",
        fields: [
          "adoption_request_id",
          "notification_kind",
          "reason",
          "adopter_agent_id",
          "skill_version_id",
          "slug",
          "attempt_count",
          "created_at_ms",
        ],
        rows,
        empty: "no dead-lettered adoption request is visible to this actor",
      },
      {
        key: "webhook_health",
        title: "Webhook endpoint health (§5.2: active | failing | dead)",
        fields: ["webhook_id", "agent_id", "url", "status", "failure_count", "last_error", "updated_at_ms"],
        rows: webhookHealth(this.db, agentIds) as unknown as Array<Record<string, unknown>>,
        empty: "no webhook endpoint is registered for this actor",
      },
    ]);
  }

  // ------------------------------------------- the migration counter (read)

  /**
   * `GET /v1/migrations` and MCP `migration.count` — how often each skill
   * MIGRATED: how many times it moved to an agent that ran it and closed a
   * receipt over it, how many distinct recipients that was, and across how many
   * distinct declared runtimes.
   *
   * Strictly reading, and it must stay so: it appends no event, transitions
   * nothing and takes no idempotency key, because there is nothing to replay.
   *
   * The rows are the skills VISIBLE to this actor, resolved by surface 5 —
   * counting is not a way around §5.1 visibility × access policy, so a skill an
   * actor may not see is not counted for them and is not acknowledged to exist.
   * A visible skill that never migrated gets a row of zeroes: the registry
   * always knows whether it looked, and an absent row would say otherwise.
   */
  migrationCounts(
    auth: AuthContext,
    params: SearchParams & { since_ms?: unknown; until_ms?: unknown } = {},
  ): MigrationCountResponse {
    return this.countMigrations(auth, params, parseMigrationWindow(params));
  }

  private countMigrations(
    auth: AuthContext,
    params: SearchParams,
    window: MigrationWindow,
  ): MigrationCountResponse {
    const { items, next_cursor } = this.search(auth, params);
    // Surface 5 pages over VERSIONS; the migration counter's subject is the
    // SKILL, so two visible versions of one skill are one row, counted once.
    const subjects: Array<{ skill_id: string; slug: string }> = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.skill_id)) continue;
      seen.add(item.skill_id);
      subjects.push({ skill_id: item.skill_id, slug: item.slug });
    }
    return {
      source: MIGRATION_SOURCE,
      window: describeWindow(window),
      window_since_ms: window.since_ms,
      window_until_ms: window.until_ms,
      items: countMigrationsPerSkill(this.db, subjects, window),
      next_cursor,
    };
  }

  /**
   * Migrations — the same counter as a view. Every row carries the three
   * attributes the number is meaningless without: `source` (this registry's
   * receipt journal), `window` (all time, on this view) and
   * `measurement_state`, so no cell on the page is a bare figure and none is
   * blank. `runtimes_unknown` is kept beside `distinct_runtimes` because a
   * migration whose declared runtime could not be read is an unknown, not a
   * zero, and the two must not render the same.
   */
  private dashMigrations(auth: AuthContext, params: SearchParams): DashboardPayload {
    const counted = this.countMigrations(auth, params, ALL_TIME);
    return this.payload("migrations", "Migrations", [
      {
        key: "migrations",
        title: "Skill migrations, counted from terminal `adopted` receipts (§5.3) over all time",
        fields: [
          "skill_id",
          "slug",
          "migrations",
          "distinct_recipients",
          "distinct_runtimes",
          "runtimes",
          "runtimes_unknown",
          "measurement_state",
          "source",
          "window",
        ],
        rows: counted.items as unknown as Array<Record<string, unknown>>,
        empty: "no skill is visible to this actor, so nothing was counted",
        next_cursor: counted.next_cursor,
      },
    ]);
  }

  /**
   * Resolve a version for a workspace-internal MUTATION. Deny-by-default keeps
   * P2's rule that a version an actor cannot see is not acknowledged to exist;
   * a cross-workspace actor who CAN see the version (published + policy/grant)
   * gets the §5.1 answer instead: cross-workspace review, supersede, revoke and
   * approval do not exist in v1 → FORBIDDEN.
   */
  private resolveVersionForMutation(auth: AuthContext, versionId: string): VersionRow {
    if (typeof versionId !== "string" || versionId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "skill_version_id must be a string");
    }
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    const row = this.loadVersion(versionId);
    if (!row) throw new ApiError("NOT_FOUND", "version not found");
    if (row.workspace_id !== auth.workspace_id) {
      if (!this.visibility(auth, row, this.grantsFor(auth)).visible) {
        throw new ApiError("NOT_FOUND", "version not found");
      }
      // §6's ACL matrix: the X-ws column is "—" for every mutating operation
      // this helper guards — review, verify, publish, supersede, deprecate,
      // revoke and approval alike. Naming a subset of them here went stale as
      // soon as surfaces 12 and 13 were added.
      throw new ApiError(
        "FORBIDDEN",
        "no cross-workspace mutation of a version exists in v1 (§6 ACL matrix, X-ws column)",
      );
    }
    return row;
  }

  // ================================================================ P5 =====
  // Adoption and receipts: surfaces 6 (request_adoption), 7 (adopt),
  // 8 (validate_outcome), 9 (rate). The delivery machine (§5.2) and the receipt
  // machine (§5.3) live in their own modules; this layer is the ACL, the
  // §5.1 visibility rules and the §7.3 hold.

  // -------------------------------------- surface 6: skill.request_adoption

  requestAdoption(
    auth: AuthContext,
    input: { skill_version_id?: unknown },
    idempotencyKey?: string,
  ): IdempotentOutcome<RequestAdoptionResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.request_adoption", idempotencyKey, this.now(), () =>
      this.requestAdoptionInner(auth, input),
    );
  }

  private requestAdoptionInner(auth: AuthContext, input: { skill_version_id?: unknown }): RequestAdoptionResponse {
    const versionId = (input ?? {}).skill_version_id;
    if (typeof versionId !== "string" || versionId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "skill_version_id (string) required");
    }
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    const row = this.loadVersion(versionId);
    if (!row) throw new ApiError("NOT_FOUND", "version not found");

    // §5.1 visibility × access policy decides whether this actor may even see
    // the version; the adoption rules below decide whether it may adopt it.
    if (!this.visibility(auth, row, this.grantsFor(auth)).visible) {
      throw new ApiError("NOT_FOUND", "version not found");
    }
    const sameWs = row.workspace_id === auth.workspace_id;
    if (row.state === "revoked") {
      throw new ApiError("PRECONDITION_FAILED", "this version is revoked — adoption is blocked (§5.1)", row.state);
    }
    if (!sameWs) {
      // §5.1: "External (cross-workspace/public) search results and
      // skill.request_adoption accept ONLY `published` versions" — the D.2 T-9
      // probe. `verified` is an internal-only state and never crosses.
      if (row.state !== "published") {
        throw new ApiError(
          "FORBIDDEN",
          "cross-workspace adoption accepts only `published` versions (§5.1 state-visibility table)",
          row.state,
        );
      }
    } else if (!["reviewed", "verified", "published", "deprecated", "superseded"].includes(row.state)) {
      // draft/linted are "owner + admins only; no adoption" in the §5.1 table
      throw new ApiError("PRECONDITION_FAILED", "this version is not adoptable in its current state (§5.1)", row.state);
    }

    let manifest: any = null;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      manifest = null;
    }
    const adoptedCount = this.adoptedCountOf(versionId);
    // §7.3 adoption column. A §7.3 condition does NOT refuse this call
    // (Appendix H surface 6): the request is created in `approval_pending`, no
    // worker may claim it (§5.2), and `skill.adopt` — surface 7 — is what
    // refuses until a matching human approval names this exact request. That is
    // what breaks the approval↔request circular dependency: an approval must
    // name an `adoption_request_id`, so the request has to exist first.
    const conditions = approvalConditions(manifest, { adoptedCount });
    const state = conditions.length > 0 ? "approval_pending" : "pending";

    const now = this.now();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const requestId = ulid(now);
      const receiptId = ulid(now);
      // §5.2 endpoint selection: at most ONE endpoint per adopter, snapshotted here.
      const webhookId = selectWebhook(db, auth.agent_id);
      db.prepare(
        `INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, requester_context_json,
           state, attempt_count, next_attempt_at_ms, webhook_id, created_at_ms)
         VALUES (?,?,?,NULL,?,0,?,?,?)`,
      ).run(requestId, versionId, auth.agent_id, state, now, webhookId, now);
      // the receipt shell: the chain exists from the moment the request does,
      // so every adoption attempt is accounted for even if delivery never
      // succeeds (§5.3 "one receipt per adoption attempt chain")
      db.prepare(
        "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
      ).run(receiptId, requestId, versionId, auth.agent_id, now);
      db.exec("COMMIT");
      const res: RequestAdoptionResponse = { adoption_request_id: requestId, receipt_id: receiptId, state };
      if (conditions.length > 0) res.approval_required = conditions;
      if (webhookId === null) res.webhook_id = null;
      return res;
    } catch (e) {
      rollbackIfOpen(db);
      throw e;
    }
  }

  private adoptedCountOf(versionId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM receipt_events e JOIN adoption_receipts r ON r.id = e.adoption_receipt_id
            WHERE r.skill_version_id = ? AND e.event = 'adopted'`,
        )
        .get(versionId) as { c: number }
    ).c;
  }

  // ------------------------------------------------------ surface 7: skill.adopt

  adopt(
    auth: AuthContext,
    requestId: string,
    input: { environment_descriptor?: unknown },
    idempotencyKey?: string,
  ): IdempotentOutcome<AdoptResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.adopt", idempotencyKey, this.now(), () =>
      this.adoptInner(auth, requestId, input),
    );
  }

  private adoptInner(auth: AuthContext, requestId: string, input: { environment_descriptor?: unknown }): AdoptResponse {
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "adoption_request_id (string) required");
    }
    const req = loadRequest(this.db, requestId);
    if (!req) throw new ApiError("NOT_FOUND", "adoption request not found");
    // Appendix H: "the request's adopter only". Deny-by-default: another
    // agent's request is not acknowledged to exist.
    if (req.adopter_agent_id !== auth.agent_id) throw new ApiError("NOT_FOUND", "adoption request not found");
    // A revocation notice (surface 11) is a row of the same §5.2 queue but was
    // never a request for anything: it is not an adoption request and does not
    // acknowledge itself as one.
    if (req.notification_kind === "revocation") throw new ApiError("NOT_FOUND", "adoption request not found");

    const descriptor = (input ?? {}).environment_descriptor;
    const val = validatePayload("environment_descriptor", descriptor);
    if (!val.valid) throw new ApiError("INVALID_SCHEMA", `environment_descriptor: ${val.errors.slice(0, 3).join("; ")}`);

    // §7.3 / §5.2: the hold. A missing approval cannot cause adoption.
    if (req.state === "approval_pending") {
      throw new ApiError(
        "FORBIDDEN",
        "this adoption needs a §7.3 human approval bound to this exact request before it can proceed",
        req.state,
      );
    }
    // A dead-lettered request refuses adoption only when the DECISION was to
    // refuse it: `approval_denied` is a §7.3 denial and, per §5.2, is final.
    //
    // The delivery machine's other terminal reasons — `endpoint_missing`,
    // `endpoint_dead`, `max_attempts`, `stale_lease` — say only that the
    // registry could not NOTIFY this adopter. §5.2 routes notifications and
    // deliberately shares no state names with §5.3 (`pushed` ≠ `delivered`);
    // the package itself is always pulled by the adopter through this surface.
    // Refusing here would break the normative §9.1 quickstart outright — its
    // demo adopter registers no webhook, so its request dead-letters as
    // `endpoint_missing` within a worker tick, and Appendix H's surface 7 puts
    // no precondition on the request's delivery state. Turning a failed
    // notification into a refused adoption is exactly the "safe scenario broken
    // without cause" the review boundary weighs equally with an unsafe one.
    if (req.state === "dead_letter" && req.dead_letter_reason === "approval_denied") {
      throw new ApiError("PRECONDITION_FAILED", `this adoption request is dead-lettered (${req.dead_letter_reason})`, req.state);
    }

    const row = this.loadVersion(req.skill_version_id);
    if (!row) throw new ApiError("NOT_FOUND", "version not found");
    if (row.state === "revoked") {
      throw new ApiError("PRECONDITION_FAILED", "this version is revoked — handover is blocked (§5.1)", row.state);
    }
    let manifest: any = null;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      manifest = null;
    }
    const risk = manifest?.scope?.risk_level;

    // §7.2: high-risk handover is refused to an adopter that does not attest
    // sandbox capability in its environment descriptor.
    if (risk === "high" && (descriptor as any)?.sandbox_capable !== true) {
      throw new ApiError(
        "FORBIDDEN",
        "a high-risk package is only handed to an adopter attesting sandbox capability (§7.2)",
      );
    }

    // The §4.2 match, whose outcome set is binary: mismatch blocks at
    // medium/high, warns at low.
    const compat = checkCompatibility(manifest, descriptor);
    if (compat.result === "mismatch" && mismatchBlocks(risk)) {
      throw new ApiError(
        "PRECONDITION_FAILED",
        `environment does not match the declared compatibility (${compat.unmet.join(", ")}) and risk_level ${String(risk)} blocks on mismatch`,
        req.state,
      );
    }

    const blob = this.blobs.get(row.package_blob_ref);
    if (!blob) throw new ApiError("NOT_FOUND", "package blob unavailable for this version");
    const receipt = this.db
      .prepare("SELECT id FROM adoption_receipts WHERE adoption_request_id=?")
      .get(requestId) as { id: string } | undefined;
    if (!receipt) throw new ApiError("NOT_FOUND", "receipt shell missing for this request");

    // A chain that has already begun refuses this call the way §5.3 refuses any
    // event it has no transition for: `PRECONDITION_FAILED` naming the current
    // state, and NO package. `delivered` is legal from derived state `none`
    // alone, so this is that table's rule read one step earlier — before a byte
    // of the caller's descriptor is stored and before the archive is serialized
    // into a response.
    //
    // It closes a real divergence rather than tidying one: the receipt surface
    // answered a late caller with 412 and a reason, while this surface answered
    // 200, handed over the whole `archive_base64`, and hid the refusal in a
    // boolean `noop` that a caller may never look at. One API cannot hold two
    // relations to one state machine. A genuine idempotent REPLAY does not
    // arrive here at all: `withIdempotency` serves it from the stored response
    // of the ORIGINAL call, and a replay is a match of (principal, caller's
    // key) — never a match of state.
    const already = derivedState(this.db, receipt.id);
    if (already !== "none") {
      throw new ApiError(
        "PRECONDITION_FAILED",
        `this adoption request has already been handed over (its receipt is \`${already}\`); a repeat is served only to the same principal replaying the same idempotency_key (§5.3)`,
        already,
      );
    }

    // The `delivered` receipt event is written HERE — on adopter-authenticated
    // confirmation — and never by the delivery machine's webhook 2xx (§5.2:
    // the two machines share no state names). The declared environment travels
    // WITH it, into the same INSERT-only row and the same transaction, because
    // the release gate's "different runtimes" conjunct is counted from these
    // rows: a descriptor on a mutable column was rewritable after the fact by
    // any holder of an adopter key, with no event and no trace, and the
    // acceptance figure moved upward when it happened.
    const appended = appendReceiptEvent(this.db, {
      receiptId: receipt.id,
      actorAgentId: auth.agent_id,
      event: "delivered",
      environment: { environment_descriptor: descriptor },
      idempotencyKey: `adopt:${requestId}`,
      nowMs: this.now(),
    });

    // The request row keeps a denormalized COPY for queries over requests. It
    // is a cache and nothing reads it for a gate — the count reads the event.
    // It is written only now, after the event exists, so it can no longer hold a
    // descriptor belonging to a caller whose adoption never happened.
    this.db
      .prepare("UPDATE adoption_requests SET requester_context_json=? WHERE id=?")
      .run(JSON.stringify({ environment_descriptor: descriptor }), requestId);

    const res: AdoptResponse = {
      receipt_event: "delivered",
      event_seq: appended.event_seq,
      receipt_id: receipt.id,
      compat: { result: compat.result, unmet: compat.unmet },
      package: {
        skill_version_id: row.id,
        semantic_version: row.semantic_version,
        manifest_hash: row.manifest_hash,
        content_hash: row.content_hash,
        archive_base64: blob.toString("base64"),
      },
    };
    if (compat.result === "mismatch") {
      res.warning = `compatibility mismatch (${compat.unmet.join(", ")}) — accepted because risk_level is ${String(risk)}`;
    }
    return res;
  }

  // -------------------------------------------- surface 8: skill.validate_outcome

  validateOutcome(
    auth: AuthContext,
    receiptId: string,
    input: ValidateOutcomeInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<AppendResult> {
    // §5.3 receipts carry their OWN idempotency (D.1
    // UNIQUE(adoption_receipt_id, idempotency_key)), so the surface-level key is
    // required here and is passed straight through to the receipt machine
    // rather than being replayed twice at two layers.
    const key = idempotencyKey ?? `outcome:${receiptId}:${String((input ?? {}).event)}`;
    return withIdempotency(this.db, auth.agent_id, "skill.validate_outcome", undefined, this.now(), () =>
      appendReceiptEvent(this.db, {
        receiptId,
        actorAgentId: auth.agent_id,
        event: (input ?? {}).event as any,
        evidence: (input ?? {}).evidence,
        failure_report: (input ?? {}).failure_report,
        rollback_report: (input ?? {}).rollback_report,
        idempotencyKey: key,
        nowMs: this.now(),
      }),
    );
  }

  // ------------------------------------------------------ surface 9: skill.rate

  rate(
    auth: AuthContext,
    versionId: string,
    input: { score?: unknown; note?: unknown; adoption_receipt_id?: unknown },
    idempotencyKey?: string,
  ): IdempotentOutcome<{ rating_id: string; score: number; noop?: boolean }> {
    return withIdempotency(this.db, auth.agent_id, "skill.rate", idempotencyKey, this.now(), () =>
      this.rateInner(auth, versionId, input),
    );
  }

  private rateInner(
    auth: AuthContext,
    versionId: string,
    input: { score?: unknown; note?: unknown; adoption_receipt_id?: unknown },
  ): { rating_id: string; score: number; noop?: boolean } {
    const { score, note, adoption_receipt_id: receiptId } = input ?? {};
    if (typeof versionId !== "string") throw new ApiError("INVALID_SCHEMA", "skill_version_id must be a string");
    if (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5) {
      throw new ApiError("INVALID_SCHEMA", "score must be an integer 1..5");
    }
    if (note !== undefined && note !== null && typeof note !== "string") {
      throw new ApiError("INVALID_SCHEMA", "note must be a string");
    }
    if (typeof receiptId !== "string" || receiptId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "adoption_receipt_id (string) required — ratings come only from verified adopters (§6 surface 9)");
    }
    const receipt = this.db
      .prepare("SELECT id, adopter_agent_id, skill_version_id FROM adoption_receipts WHERE id=?")
      .get(receiptId) as { id: string; adopter_agent_id: string; skill_version_id: string } | undefined;
    // deny-by-default: somebody else's receipt is not acknowledged
    if (!receipt || receipt.adopter_agent_id !== auth.agent_id) throw new ApiError("NOT_FOUND", "receipt not found");
    if (receipt.skill_version_id !== versionId) {
      throw new ApiError("PRECONDITION_FAILED", "that receipt belongs to a different version", receipt.skill_version_id);
    }
    // "requires an adoption_receipt_id owned by the rater with terminal
    // `adopted`" — a failed, open or rolled-back chain is not a rating right.
    const state = derivedState(this.db, receiptId);
    if (state !== "adopted") {
      throw new ApiError("PRECONDITION_FAILED", "ratings require a receipt whose terminal event is `adopted` (§6 surface 9)", state);
    }

    const now = this.now();
    const id = ulid(now);
    try {
      this.db
        .prepare("INSERT INTO ratings(id, skill_version_id, rater_agent_id, adoption_receipt_id, score, note, created_at_ms) VALUES (?,?,?,?,?,?,?)")
        .run(id, versionId, auth.agent_id, receiptId, score, note ?? null, now);
    } catch (e: any) {
      if (!/UNIQUE/i.test(String(e.message ?? e))) throw e;
      const existing = this.db
        .prepare("SELECT id, score FROM ratings WHERE skill_version_id=? AND rater_agent_id=?")
        .get(versionId, auth.agent_id) as { id: string; score: number };
      // one rating per (version, rater): a repeat converges on the recorded one
      return { rating_id: existing.id, score: existing.score, noop: true };
    }
    return { rating_id: id, score: score as number };
  }

  private loadVersion(versionId: string): VersionRow | undefined {
    return this.db
      .prepare(
        `SELECT v.id, v.skill_id, v.semantic_version, v.author_agent_id, v.manifest_json,
                v.manifest_hash, v.content_hash, v.package_blob_ref, v.state, v.superseded_by_version_id,
                v.revocation_reason, v.deprecation_at_ms, v.created_at_ms,
                s.slug, s.workspace_id, s.owner_agent_id, s.access_policy
           FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE v.id=?`,
      )
      .get(versionId) as VersionRow | undefined;
  }
}

// -------------------------------------------------------------------- helpers

function rollbackIfOpen(db: Db): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // transaction already closed (committed or rolled back) — nothing to undo
  }
}

/**
 * The identity of a SOURCE tree — the value `skill.create_from_dir` converges
 * on, computed before a marker exists.
 *
 * Two halves, because a source is two things: the files it ships and what its
 * manifest says. Changing either changes the version, so both are covered.
 *
 * `integrity` is dropped from the manifest half deliberately: the source
 * manifest's `integrity` is whatever the author left there, the packer
 * overwrites it, and a source that differs only in a field about to be
 * discarded is the same source. Canonical (JCS) rather than byte-wise for the
 * same reason: reformatting `manifest.json` changes no claim it makes.
 */
function sourceIdentity(sourceFiles: PackageFiles, manifest: any): string {
  const { integrity: _dropped, ...claims } = manifest as Record<string, unknown>;
  return createHash("sha256")
    .update(
      jcsBytes({
        files: computeIntegrity(sourceFiles) as unknown as never,
        manifest: manifestHash(claims as never),
      }),
    )
    .digest("hex");
}

/** §4.1b archive bytes → PackageFiles; gzip sniffed by magic. */
function readArchiveBytes(bytes: Buffer): PackageFiles {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ApiError("MALFORMED_ARCHIVE", "package archive bytes required");
  }
  const kind = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? "tar.gz" : "tar";
  try {
    return readPackage(bytes, kind);
  } catch (e) {
    if (e instanceof ArchiveError) throw new ApiError(e.code, e.message);
    throw e;
  }
}

function parseLimit(limit: SearchParams["limit"]): number {
  if (limit === undefined) return 20;
  const n = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ApiError("INVALID_SCHEMA", "limit must be an integer 1..100");
  }
  return n;
}

function parseMinAdopted(v: SearchParams["min_adopted"]): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ApiError("INVALID_SCHEMA", "min_adopted must be an integer >= 0");
  return n;
}

interface Cursor {
  ms: number;
  id: string;
}

/** §6's rating half of the trust threshold: a score on the 1–5 `ratings` scale. */
function parseMinRating(v: SearchParams["min_rating"]): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    throw new ApiError("INVALID_SCHEMA", "min_rating must be a number 1..5");
  }
  return n;
}

function parseCursor(cursor: string | undefined): Cursor | null {
  if (cursor === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(decoded) && typeof decoded[0] === "number" && typeof decoded[1] === "string") {
      return { ms: decoded[0], id: decoded[1] };
    }
  } catch {
    // fall through to the typed error below
  }
  throw new ApiError("INVALID_SCHEMA", "malformed cursor");
}

function encodeCursor(row: VersionRow): string {
  return Buffer.from(JSON.stringify([row.created_at_ms, row.id]), "utf8").toString("base64url");
}

function matchesFilters(params: SearchParams, row: VersionRow, manifest: any): boolean {
  if (params.state !== undefined && row.state !== params.state) return false;
  if (params.risk !== undefined && manifest?.scope?.risk_level !== params.risk) return false;
  if (params.q !== undefined) {
    const q = params.q.toLowerCase();
    const hay = [row.slug, manifest?.title, manifest?.capability_statement]
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.toLowerCase());
    if (!hay.some((s) => s.includes(q))) return false;
  }
  if (params.capability !== undefined) {
    const cap = manifest?.capability_statement;
    if (typeof cap !== "string" || !cap.toLowerCase().includes(params.capability.toLowerCase())) return false;
  }
  if (params.runtime !== undefined) {
    const matchers: Array<{ id: string }> = manifest?.runtime?.runtime_compat ?? [];
    if (!matchers.some((m) => m.id === params.runtime || m.id === "any")) return false;
  }
  if (params.tool !== undefined) {
    const matchers: Array<{ id: string }> = manifest?.runtime?.tool_compat ?? [];
    if (!matchers.some((m) => m.id === params.tool || m.id === "any")) return false;
  }
  return true;
}
