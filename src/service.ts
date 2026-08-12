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
import { outcomeContractOf, validateManifest, type OutcomeContract } from "./manifest.ts";
import { EVIDENCE_LIST_MAX, EVIDENCE_NAMES, contractLiterals, isAdmissibleEvidenceValue, selfReported } from "./outcome.ts";
import { decodeCursor, encodeCursor as encodeCursorToken, type Cursor } from "./cursor.ts";
import { manifestHash, contentHash, signManifest } from "./signing.ts";
import {
  ARRIVAL_SCRIPT_PATH,
  arrivalMarker,
  checkArrivalIdentity,
  embedArrivalStep,
  markersIn,
  renderArrivalScript,
  shipsArrivalScript,
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
import {
  appendReceiptEvent,
  appendReceiptEventInTx,
  derivedState,
  isStalled,
  ADOPTER_EVENTS,
  type AppendResult,
  type DerivedState,
  type ReceiptEvent,
} from "./receipts.ts";
import { parseRecipient, recordTransfer, type TransferResponse } from "./transfer.ts";
import {
  ActivationError,
  NATIVE_ENTRY,
  NO_ACTIVATION_ROOTS,
  materialize,
  readBack,
  registryObservedEvidence,
  removeManaged,
  skillFilesUnder,
  type ActivationPlacement,
  type ActivationRoots,
  type ManagedCopy,
} from "./activation.ts";
import {
  ARRIVAL_OBSERVATION_SOURCE,
  ASSIGNMENT_INTENT_SOURCE,
  NATIVE_INVENTORY_SOURCE,
  NO_RUNTIME_RECORDS,
  appendAssignmentEvent,
  assignmentView,
  assignmentsForAgents,
  eventsOf,
  headFrom,
  headOf,
  loadAssignment,
  observedArrival,
  subjectOf,
  type AppendAssignmentEventInput,
  type AssignmentEventRow,
  type AssignmentHead,
  type AssignmentRow,
  type AssignmentView,
  type RuntimeRecordSource,
} from "./assignments.ts";
import {
  CAPABILITY_KINDS,
  CAPABILITY_STATES,
  FLEET_RUNTIMES,
  NO_FLEET_OBSERVATIONS,
  NO_SNAPSHOT_WINDOW,
  SELECTION_WINDOWS,
  capabilityColumns,
  columnsOf,
  countedNumber,
  stateOfColumn,
  deadWeightOf,
  fleetMatrixRows,
  gapOf,
  isFleetRuntime,
  isSelectionWindow,
  matrixCell,
  scanArrivals,
  syncStatusOf,
  unknownNumber,
  type AgentInventoryRow,
  type ArrivalScanRow,
  type CapabilityKind,
  type CapabilityState,
  type ColumnName,
  type DeadWeightAnswer,
  type EvidenceSource,
  type FleetObservationSource,
  type FleetRuntime,
  type IntentFactGap,
  type MatrixCell,
  type MeasuredNumber,
  type ObservedRecord,
  type RegisteredCapability,
  type RuntimeSnapshot,
  type ScanSubject,
  type SelectionWindow,
  type StateColumn,
  type Trivalent,
} from "./fleet.ts";
import {
  NO_INVENTORY_ROOTS,
  NO_INVENTORY_WINDOW,
  inventoryUnder,
  type InventoryResult,
  type InventoryRoots,
  type InventorySite,
  type UndiscoverableKinds,
} from "./fleet-scan.ts";
import { StoredObservations, recordObservationInTx } from "./fleet-store.ts";
import {
  createGrant,
  findGrant,
  listGrants,
  loadPrincipal,
  type CreatedGrant,
  type CreateGrantInput,
  type GrantAction,
  type GrantPrincipal,
  type GrantRow,
  type GrantView,
} from "./grants.ts";
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
  type Cell,
  type DashboardNotice,
  type DashboardPayload,
  type DashboardSection,
  type DashboardView,
} from "./dashboard.ts";
import {
  APPROVAL_NOTICES,
  RECONCILIATION_LEGEND,
  agentSections,
  approvalSections,
  capabilitySections,
  fleetSections,
  instant,
  labelCell,
  VERSIONS_BOUNDARY,
  list,
  numberCell,
  observationCell,
  outcomeSections,
  plain,
  principalCell,
  registryCount,
  registryUnknown,
  type AgentCapabilityInput,
  type ApprovalDecisionInput,
  type ApprovalSubjectInput,
  type CapabilityVersionInput,
  type FleetAgentInput,
  type OutcomeReceiptInput,
  type OutcomeVersionInput,
} from "./fleet-dashboard.ts";
import {
  ALL_TIME,
  describeWindow,
  migrationCounts as countMigrationsPerSkill,
  parseMigrationWindow,
  MIGRATION_SOURCE,
  RECIPIENT_SOURCE_TRANSFER,
  RECIPIENT_SOURCE_REQUEST,
  describeSource,
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
  /**
   * §5.5: WHERE a deployment may be materialized, per agent.
   *
   * There is no default root and none is derived from the environment: the
   * shipped value activates nothing, records `queued`, and says so in the
   * answer. Pointing this at a real runtime directory is a separate decision,
   * made in configuration by a person, and it needs no code change — which is
   * the whole reason the root is a parameter.
   */
  activation?: ActivationRoots;
  /**
   * §5.5: where RUNTIME RECORDS come from, for the observation column.
   *
   * The shipped value yields none, so every observed arrival is `unknown` with
   * a window that says no transcript was searched. This is the seam the
   * inventory/scanner work plugs into; it hands over records rather than paths,
   * because the next version's record is a line of text an agent outside this
   * perimeter sent.
   */
  runtimeRecords?: RuntimeRecordSource;
  /**
   * §6: where the richer §6 snapshot comes from — records, plus the model, the
   * session and the boundary they were taken over.
   *
   * The default reads the self-reports `observation.report` stores. Pointing it
   * at a transcript directory instead is `TranscriptObservations`, and in V-2 it
   * is a third implementation receiving a message from an agent outside this
   * perimeter. None of the three is visible to anything above this seam [M-7].
   */
  observations?: FleetObservationSource;
  /**
   * §6: where an agent's capabilities are READ from the filesystem.
   *
   * The root is a PARAMETER for the reason D-7 gives about activation: reading
   * a fleet member's real directories is an act on somebody else's machine and
   * is authorized separately from the code that knows how. The shipped default
   * walks nothing and every inventory number is `unknown`, never zero.
   */
  inventory?: InventoryRoots;
}

// ------------------------------------------- §5.5 deployment answer shapes

/** The write steps of §6.3, as they are named on every answer. */
export type AssignmentAction = "activate" | "pause" | "revoke";

/**
 * The answer of one deployment write.
 *
 * `managed_copy` is what happened to the FILE at this step, and it is five-
 * valued with no blank member. `requires_new_session` and `session_effect` are
 * the honest limit of every withdrawal: taking a file away cannot reach into a
 * session that has already read it, and this system does not say it can.
 */
export interface AssignmentActionResponse {
  action: AssignmentAction;
  assignment: AssignmentView;
  managed_copy: ManagedCopy | "unknown";
  activation_root_configured: boolean;
  requires_new_session: boolean;
  session_effect: string;
  noop?: boolean;
}

/** Counts of the read surface — each with its state, its source and its window. */
export interface AssignmentCounts {
  assignments: number;
  /** how many deployments Skillonomia INTENDS to be active */
  intent_active: number;
  /** how many have an OBSERVED arrival — a different column, counted apart */
  observed_arrival_yes: number;
  observed_arrival_unknown: number;
  measurement_state: "counted";
  intent_source: string;
  observation_source: string;
  window: string;
}

/** The filesystem number, three-valued, never a bare figure. */
export interface NativeInventory {
  /** null exactly when `measurement_state` is `unknown` — never a silent 0 */
  skill_files: number | null;
  measurement_state: "counted" | "unknown";
  reason: string | null;
  source: string;
  window: string;
}

export interface AssignmentListResponse {
  items: AssignmentView[];
  counts: AssignmentCounts;
  native_inventory: NativeInventory;
}

// ------------------------------------------------- §6 part A answer shapes

/** Everything one agent's fleet answer is assembled from, gathered once and
 *  kept SEPARATE: intent, observation and filesystem never merge. */
/** Every version of one workspace, by the §5 marker its id derives. */
type MarkerIndex = Map<string, { skill_version_id: string; manifest_json: string; manifest_hash: string; slug: string }>;

interface FleetContext {
  agentId: string;
  /** COLUMN ONE — the registry's decisions, exactly as §5.5 publishes them */
  views: AssignmentView[];
  /** COLUMN TWO — what was observed, or null when nothing ever was */
  snapshot: RuntimeSnapshot | null;
  site: InventorySite | null;
  inventory: InventoryResult | null;
  inventoryReason: string | null;
  registered: RegisteredCapability[];
  runtime: FleetRuntime | null;
  runtimeSource: EvidenceSource | "none";
  index: MarkerIndex;
  scan: ArrivalScanRow[];
  subjects: ScanSubject[];
}

/** One capability, with the column set ITS RUNTIME publishes. */
export interface CapabilityRow {
  kind: CapabilityKind;
  name: string;
  /** null when no runtime has been observed and none is configured */
  runtime: FleetRuntime | null;
  skill_version_id: string | null;
  arrival_marker: string | null;
  has_executable_step: boolean;
  columns: StateColumn[];
}

export interface FleetCounts {
  agents: MeasuredNumber;
  observed_agents: MeasuredNumber;
}

export interface FleetListResponse {
  agents: AgentInventoryRow[];
  counts: FleetCounts;
  runtimes: FleetRuntime[];
  /** §4's matrix, published with the answer rather than assumed by a renderer */
  matrix: MatrixCell[];
}

export interface AgentCapabilitiesResponse {
  agent: AgentInventoryRow;
  /** the runtime's OWN column set — Claude Code's and Codex's differ [A-3] */
  columns: ColumnName[];
  /**
   * Why the column set is empty, or null when it is not.
   *
   * WHICH columns exist is a property of the RUNTIME, so an agent whose runtime
   * has neither been observed nor configured has no column set to publish. That
   * is an `unknown` like any other and it carries a reason rather than being an
   * empty table a reader would take for an empty inventory [I-1].
   */
  columns_reason: string | null;
  capabilities: CapabilityRow[];
  /** [A-2]: one number per kind, each carrying its three attributes [I-3] */
  inventory: MeasuredNumber[];
  /** one number per published column, counted over the capabilities above */
  states: MeasuredNumber[];
  undiscoverable: UndiscoverableKinds;
  inventory_reason: string | null;
  /** [A-4]: intent beside fact, one row per deployment */
  gap: IntentFactGap[];
  /** [A-5]: registered and never once demonstrated to have run */
  dead_weight: DeadWeightAnswer;
}

export interface CapabilityGetResponse {
  agent: AgentInventoryRow;
  columns: ColumnName[];
  columns_reason: string | null;
  capability: CapabilityRow;
  /** §4's row for this capability's runtime, both what it can and cannot say */
  matrix: MatrixCell[];
  /** [A-6]'s tuples: version, agent, runtime, time, call_id, result */
  scan: ArrivalScanRow[];
  gap: IntentFactGap | null;
}

/**
 * The sentence `observation.report` returns, and the reason it is a constant.
 *
 * It states the two things a reporter must be able to rely on and a reader must
 * not have to infer: the text of a record is not kept, and a report is evidence
 * FOR a run and never evidence against one.
 */
/** A manifest as an object, or null. An unreadable one fails CLOSED in the
 *  direction that produces MORE checking — see `subjectOf`. */
function safeManifest(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** The selection boundary every outcome number on §9's screens is counted over. */
const RECEIPT_JOURNAL = "receipt_events (registry journal, INSERT-only), all time";

/** The boundary every value read out of a SIGNED manifest was taken over. */
const MANIFEST_BOUNDARY = "the version's manifest, as signed";

/** The boundary a receipt-backed rating average was taken over. */
const RATING_BOUNDARY = "ratings bound to a closed adoption receipt, all time; the scale is 1 to 5";

/** The boundary the request/queue rows were read over. */
const REQUEST_BOUNDARY = "adoption_requests (registry), all time";

/** The boundary a recorded §7.3 decision was read over. */
const APPROVAL_BOUNDARY = "approvals (registry journal), all time";

/** The boundary the endpoint health rows were read over. */
const WEBHOOK_BOUNDARY = "webhooks (registry), all time";

/** The DECLARED SECTIONS a manifest diff compares. It is a comparison of what
 *  two versions SAY about themselves, not a textual diff of two packages, and
 *  the screen says so beside every answer it produces. */
const MANIFEST_SECTIONS = [
  "title",
  "capability_statement",
  "access_policy",
  "scope",
  "runtime",
  "procedure",
  "evidence",
  "safety",
  "lifecycle",
  "integrity",
] as const;

export const OBSERVATION_REPORT_NOTE =
  "Records were reduced to §5 arrival markers at this boundary: no record text is stored, logged or returned. " +
  "A report can establish that a version RAN; it can never establish that one did not — a marker that is absent " +
  "from a report is `unknown`, never `no`.";

export interface ObservationReportResponse {
  observation_id: string;
  agent_id: string;
  runtime: FleetRuntime;
  records_examined: number;
  markers_recorded: number;
  window: SelectionWindow;
  window_detail: string;
  /** always false, and stated rather than implied [I-7] */
  records_text_stored: false;
  note: string;
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
    /**
     * §5.4: the typed recipient `{kind,id}` of a `transferred` row, and null on
     * every other row. It is served for the same reason as the descriptor
     * above: the recipient is what the migration counter reads off this event,
     * so it has to be readable by the people the count is about.
     */
    recipient: unknown;
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
  /** §5.5: where deployments may be materialized. Nowhere, by default. */
  private readonly activation: ActivationRoots;
  /** §5.5: where runtime records come from. Nowhere, by default. */
  private readonly runtimeRecords: RuntimeRecordSource;
  /** §6: where §6's richer snapshots come from. The stored self-reports, by
   *  default — a report that moved nothing would be a report for nobody. */
  private readonly observations: FleetObservationSource;
  /** §6: where an agent's capabilities are READ from. Nowhere, by default:
   *  an inventory with no configured root inventories nothing and says so. */
  private readonly inventory: InventoryRoots;

  constructor(db: Db, opts: RegistryOptions = {}) {
    this.db = db;
    this.activation = opts.activation ?? NO_ACTIVATION_ROOTS;
    // The default is NOT `NO_RUNTIME_RECORDS`: `observation.report` writes the
    // records a §5 arrival is assessed from, and a registry that stored them
    // and then read from nowhere would publish `unknown` beside its own
    // evidence. With no report filed, `StoredObservations` answers `null` —
    // which is the same "nothing was searched" the shipped default meant.
    this.runtimeRecords = opts.runtimeRecords ?? new StoredObservations(db);
    this.observations = opts.observations ?? new StoredObservations(db);
    this.inventory = opts.inventory ?? NO_INVENTORY_ROOTS;
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

    // D-2: THIS PATH REQUIRES A DEFINITION OF SUCCESS, and the older one does
    // not. `skill.create` accepts a package an author signed elsewhere — the
    // seed, the fifteen dogfood fixtures and `skills/git-bundle-verify` were
    // signed before this section existed, and a registry that refused them would
    // be demanding a document their authors could not have written. Those
    // packages report `outcome` = `unknown` with the reason
    // `no_outcome_contract`, which is the honest answer and never `no` [I-1],
    // [A-0].
    //
    // A package packed HERE is different: the registry is producing it, now, and
    // a skill whose success nobody defined is a skill whose §4 `outcome` column
    // can never say anything. The refusal is BEFORE the transaction and before
    // the marker, so a source without a contract leaves no row, no key and no
    // blob behind. The section then rides inside the manifest that gets signed,
    // which is what makes the definition of success unchangeable without a new
    // version [M-6].
    const contract = outcomeContractOf(manifest);
    if (!contract.valid) {
      throw new ApiError(
        "INVALID_SCHEMA",
        `a package packed by this registry declares what success is: manifest.outcome_contract with \`check\`, \`evidence\` and \`unknown\` (${contract.reason}) — D-2`,
      );
    }

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
      // D-6: the SKILL.md block is written for EVERY version; the script only
      // for a version whose own manifest declares a shell to run it. The
      // manifest decides — a package that says `runtime.shell: ["none"]` is not
      // handed a shell script, and its declaration is not amended to pretend
      // otherwise. `scripts/skln-arrive.sh` is a reserved path either way, so a
      // source that ships one under that name loses it here rather than having
      // it signed as though the registry had generated it.
      const executableStep = shipsArrivalScript(manifest);
      files.set(
        "SKILL.md",
        Buffer.from(
          embedArrivalStep(files.get("SKILL.md")!.toString("utf8"), versionId, { executableStep }),
          "utf8",
        ),
      );
      if (executableStep) files.set(ARRIVAL_SCRIPT_PATH, Buffer.from(renderArrivalScript(versionId), "utf8"));
      else files.delete(ARRIVAL_SCRIPT_PATH);

      // D-1's guard as D-6 amends it: three values where there are three places
      // for a marker to live, two where there are two. A disagreement refuses
      // the pack in either shape; it is never a report.
      const identity = checkArrivalIdentity(files, versionId, { executableStep });
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
                environment_json, recipient_json
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
      recipient_json: string | null;
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
        // §5.4: the typed recipient of a `transferred` row, served back for the
        // same reason the declared environment is — a fact nobody can read is a
        // fact nobody can notice being wrong. `null` on every other row.
        recipient: e.recipient_json === null ? null : JSON.parse(e.recipient_json),
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
  // The phase-plan views, each a THIN read layer: every row is built from the fields the
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
      case "fleet":
        return this.dashFleet(auth);
      case "agent":
        return this.dashAgent(auth);
      case "skill_approval":
        return this.dashSkillApproval(auth, params);
      case "capability":
        return this.dashCapability(auth, params);
      case "outcomes":
        return this.dashOutcomes(auth, params);
    }
  }

  // ---------------------------------------------------------------------
  // THE OLDER VIEWS' CELLS.
  //
  // [I-1] and [I-3] are invariants over EVERY view, and the first six were
  // built before either had a shape: they put raw values into rows, so a null
  // rendered as `—` and a count rendered as a bare figure. The five §9 screens
  // were then built with cell BUILDERS, tested with a sweep over the rendered
  // bytes, and the sweep was pointed only at them — so a live
  // `/v1/dashboard/library?format=html` carried three dashes and four naked
  // numbers while the suite reported the invariants held.
  //
  // The helpers below give the older six the same cells the five use. They are
  // not a rendering convenience: `—` is a claim that there is nothing, and a
  // figure with no method is the defect the whole of §6 was written about.
  // ---------------------------------------------------------------------

  /** A count over one of this registry's own journals [I-3]. */
  private countCell(value: number, state: CapabilityState, boundary: string, reason: string | null = null): Cell {
    return numberCell(registryCount(value, state, boundary, reason));
  }

  /** A count that could not be taken, and the reason it could not [I-3]. */
  private unknownCell(state: CapabilityState, boundary: string, reason: string): Cell {
    return numberCell(registryUnknown(state, boundary, reason));
  }

  /** One observed value of this registry's own records, with its method. */
  private registryCell(observation: string, answer: string | null, why: string, boundary: string): Cell {
    return observationCell({ observation, answer, why, source: "registry", window: "all_time", boundary });
  }

  /**
   * AN IDENTIFIER OR A NAME, published as a cell like everything else.
   *
   * These used to be `plain(...)` — a raw string dropped straight into a row.
   * That was the last path by which a value reached a page carrying no method
   * at all, and it is the path a reviewer walked eight numeric notations
   * through: a raw cell says nothing about itself, so the sweep had nothing to
   * check and no way to tell a slug from a figure. `rows` now hold `Cell`s and
   * `plain` returns a `string`, so this conversion is not a convention anybody
   * has to remember — the compiler refuses the old shape.
   */
  private labelCell(observation: string, answer: string | null, why: string, boundary: string): Cell {
    return labelCell(observation, answer, why, boundary);
  }

  private payload(
    view: DashboardView,
    title: string,
    sections: DashboardSection[],
    notices: DashboardNotice[] = [],
  ): DashboardPayload {
    // §9.1: the demo-mode label is part of every view's payload, so both
    // adapters carry it and the rendered page can show it prominently.
    return { view, title, views: DASHBOARD_VIEWS, sections, demo_mode: demoMode(this.db), notices };
  }

  /** Library — surface 5's items, including the registry-computed Reputation. */
  private dashLibrary(auth: AuthContext, params: SearchParams): DashboardPayload {
    const { items, next_cursor } = this.search(auth, params);
    const rows = items.map((i) => {
      const r = i.registry.reputation;
      return {
        skill_id: this.labelCell("skill_id", i.skill_id, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        slug: this.labelCell("slug", i.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        skill_version_id: this.labelCell("skill_version_id", i.skill_version_id, "minted_by_the_registry", VERSIONS_BOUNDARY),
        semantic_version: this.labelCell("semantic_version", i.semantic_version, "declared_by_the_author", MANIFEST_BOUNDARY),
        state: this.labelCell("state", i.state, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        // [I-1]: a version that declares no risk level is `unknown`, in the
        // word, and never a dash — a dash reads as "there is no risk".
        risk_level: this.registryCell(
          "risk_level",
          i.risk_level ?? null,
          i.risk_level ? "declared_by_the_manifest" : "this version's manifest declares no risk level",
          MANIFEST_BOUNDARY,
        ),
        access_policy: this.labelCell("access_policy", i.access_policy, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        warning: this.registryCell(
          "warning",
          i.warning ?? null,
          i.warning ? "raised_by_the_registry" : "this registry raises no warning about this version",
          "the registry's own view of this version, all time",
        ),
        adoption_attempts: this.countCell(r.adoption_attempts, "outcome", RECEIPT_JOURNAL),
        adopted_count: this.countCell(r.adopted_count, "outcome", RECEIPT_JOURNAL),
        failed_count: this.countCell(r.failed_count, "outcome", RECEIPT_JOURNAL),
        rolled_back_count: this.countCell(r.rolled_back_count, "outcome", RECEIPT_JOURNAL),
        avg_rating:
          r.avg_rating === null
            ? this.unknownCell("outcome", RATING_BOUNDARY, "no receipt-backed rating has been recorded for this version")
            : numberCell({
                ...registryCount(0, "outcome", RATING_BOUNDARY, "receipt_backed_average"),
                value: r.avg_rating,
              }),
        failure_modes_observed: this.registryCell(
          "failure_modes_observed",
          list(r.failure_modes_observed, ""),
          r.failure_modes_observed.length === 0 ? "no failure mode has been reported for this version" : "reported_by_adopters",
          RECEIPT_JOURNAL,
        ),
      };
    });
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
    const rows: Array<Record<string, Cell>> = [];
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
          slug: this.labelCell("slug", item.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
          skill_version_id: this.labelCell("skill_version_id", item.skill_version_id, "minted_by_the_registry", VERSIONS_BOUNDARY),
          semantic_version: this.labelCell("semantic_version", item.semantic_version, "declared_by_the_author", MANIFEST_BOUNDARY),
          state: this.labelCell("state", item.state, "recorded_by_the_registry", VERSIONS_BOUNDARY),
          receipt_id: this.labelCell("receipt_id", e.receipt_id, "recorded_by_the_receipt_journal", RECEIPT_JOURNAL),
          adopter_agent_id: this.labelCell("adopter_agent_id", e.adopter_agent_id, "recorded_by_the_receipt_journal", RECEIPT_JOURNAL),
          event_seq: this.countCell(e.event_seq, "outcome", RECEIPT_JOURNAL, "the position of this event in its chain"),
          recorded_at: this.registryCell(
            "recorded_at",
            instant(e.server_at_ms),
            "recorded_by_the_receipt_journal",
            RECEIPT_JOURNAL,
          ),
          gate_results: this.registryCell(
            "gate_results",
            list(gates, ""),
            gates.length === 0 ? "the validated payload declared no gate result" : "validated_at_append_time",
            RECEIPT_JOURNAL,
          ),
          reviewer_notes: this.registryCell(
            "reviewer_notes",
            plain(item.registry.reviewer_notes, ""),
            "recorded_by_the_review_surface",
            "the reviewer attestation on this version, all time",
          ),
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
          "recorded_at",
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
    const rows: Array<Record<string, Cell>> = [];
    for (const r of all) {
      if (rows.length === limit) break;
      // exactly the `GET /v1/receipts/{id}` rule: adopter, skill owner, or an
      // admin/owner of the skill's workspace
      if (!this.mayReadReceipt(auth, r)) continue;
      const evs = events.all(r.receipt_id) as Array<{ event: string; event_seq: number; server_at_ms: number }>;
      const stalled = isStalled(this.db, r.receipt_id, this.now());
      rows.push({
        receipt_id: this.labelCell("receipt_id", r.receipt_id, "recorded_by_the_receipt_journal", RECEIPT_JOURNAL),
        adoption_request_id: this.labelCell("adoption_request_id", r.adoption_request_id, "recorded_by_the_request_queue", REQUEST_BOUNDARY),
        skill_version_id: this.labelCell("skill_version_id", r.skill_version_id, "minted_by_the_registry", VERSIONS_BOUNDARY),
        slug: this.labelCell("slug", r.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        adopter_agent_id: this.labelCell("adopter_agent_id", r.adopter_agent_id, "recorded_by_the_receipt_journal", RECEIPT_JOURNAL),
        derived_state: this.labelCell("derived_state", derivedState(this.db, r.receipt_id), "derived_from_the_receipt_journal", RECEIPT_JOURNAL),
        stalled: this.registryCell(
          "stalled",
          stalled
            ? "yes — no terminal event within the staleness window"
            : "no — the chain is closed or still inside the window",
          "compared_against_the_staleness_window",
          RECEIPT_JOURNAL,
        ),
        request_state: this.registryCell(
          "request_state",
          r.request_state,
          r.request_state === null ? "this chain has no adoption request row" : "recorded_by_the_request_queue",
          REQUEST_BOUNDARY,
        ),
        dead_letter_reason: this.registryCell(
          "dead_letter_reason",
          r.dead_letter_reason,
          r.dead_letter_reason === null ? "this request was not dead-lettered" : "recorded_by_the_delivery_queue",
          REQUEST_BOUNDARY,
        ),
        attempt_count:
          r.attempt_count === null
            ? this.unknownCell("outcome", REQUEST_BOUNDARY, "this chain has no adoption request row to count attempts on")
            : this.countCell(r.attempt_count, "outcome", REQUEST_BOUNDARY),
        events: this.registryCell(
          "events",
          // `seq#N`, not `seq N`: the sequence number is an ORDINAL — it names
          // this row's place in the chain — and a bare figure on a page is read
          // as a count, which is why the render guard refuses one that carries
          // no measurement state. Written joined to its sigil it is what it is.
          list(evs.map((e) => `seq#${e.event_seq}: ${e.event} at ${instant(e.server_at_ms) ?? "no time was recorded"}`), ""),
          evs.length === 0 ? "no event has been appended to this chain" : "read_from_the_receipt_journal",
          RECEIPT_JOURNAL,
        ),
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
    const holds: Array<Record<string, Cell>> = [];
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
      const conditions = approvalConditions(manifest, { adoptedCount: this.adoptedCountOf(h.skill_version_id) });
      holds.push({
        adoption_request_id: this.labelCell("adoption_request_id", h.adoption_request_id, "recorded_by_the_request_queue", REQUEST_BOUNDARY),
        skill_version_id: this.labelCell("skill_version_id", h.skill_version_id, "minted_by_the_registry", VERSIONS_BOUNDARY),
        slug: this.labelCell("slug", h.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        adopter_agent_id: this.labelCell("adopter_agent_id", h.adopter_agent_id, "recorded_by_the_request_queue", REQUEST_BOUNDARY),
        state: this.labelCell("state", h.state, "recorded_by_the_request_queue", REQUEST_BOUNDARY),
        conditions: this.registryCell(
          "matrix_conditions",
          list(conditions as readonly string[], ""),
          conditions.length === 0 ? "no §7.3 matrix condition is recorded against this request" : "evaluated_from_the_signed_manifest",
          MANIFEST_BOUNDARY,
        ),
        held_since: this.registryCell(
          "held_since",
          instant(h.created_at_ms),
          "recorded_by_the_request_queue",
          REQUEST_BOUNDARY,
        ),
      });
    }

    const decisionRows = this.db
      .prepare(
        // [I-5]: the approver's TYPE and ROLE are selected, not just its id.
        // "approved by the workspace owner in person" and "approved by an agent
        // holding a role" are different facts, and this view published neither
        // — it printed an opaque `approver_agent_id` and left a reader to guess
        // which of the two they were looking at.
        `SELECT a.id AS approval_id, a.skill_version_id, a.adoption_request_id, a.approver_agent_id,
                a.scope, a.decision, a.note, a.created_at_ms,
                s.slug, s.workspace_id, s.owner_agent_id, v.author_agent_id, q.adopter_agent_id,
                ap.type AS approver_type,
                (SELECT m.role FROM workspace_memberships m
                  WHERE m.agent_id = ap.id AND m.workspace_id = ap.workspace_id) AS approver_role
           FROM approvals a
           JOIN skill_versions v ON v.id = a.skill_version_id
           JOIN skills s ON s.id = v.skill_id
           LEFT JOIN adoption_requests q ON q.id = a.adoption_request_id
           LEFT JOIN agents ap ON ap.id = a.approver_agent_id
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
      approver_type: string | null;
      approver_role: string | null;
    }>;
    const decisions: Array<Record<string, Cell>> = [];
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
        approval_id: this.labelCell("approval_id", d.approval_id, "recorded_by_the_approval_journal", APPROVAL_BOUNDARY),
        skill_version_id: this.labelCell("skill_version_id", d.skill_version_id, "minted_by_the_registry", VERSIONS_BOUNDARY),
        slug: this.labelCell("slug", d.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        adoption_request_id: this.registryCell(
          "adoption_request_id",
          d.adoption_request_id,
          d.adoption_request_id === null ? "this decision was recorded against the version, not against one request" : "recorded_by_the_approval_journal",
          APPROVAL_BOUNDARY,
        ),
        scope: this.labelCell("scope", d.scope, "recorded_by_the_approval_journal", APPROVAL_BOUNDARY),
        decision: this.labelCell("decision", d.decision, "recorded_by_the_approval_journal", APPROVAL_BOUNDARY),
        // [I-5]: WHO, and WHAT KIND OF PRINCIPAL — the same cell the §9 screen
        // uses, so the two surfaces cannot answer this differently.
        approved_by: principalCell({
          agent_id: d.approver_agent_id,
          type: d.approver_type,
          role: d.approver_role,
          observation: "approved_by",
          source: "registry",
        }),
        note: this.registryCell(
          "note",
          d.note,
          d.note === null ? "the decision carried no note" : "recorded_by_the_approval_journal",
          APPROVAL_BOUNDARY,
        ),
        decided_at: this.registryCell(
          "decided_at",
          instant(d.created_at_ms),
          "recorded_by_the_approval_journal",
          APPROVAL_BOUNDARY,
        ),
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
          "held_since",
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
          "approved_by",
          "note",
          "decided_at",
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
    const rows: Array<Record<string, Cell>> = [];
    for (const dl of deadLetters(this.db)) {
      if (rows.length === limit) break;
      const d = detail.get(dl.id) as
        | { attempt_count: number; created_at_ms: number; slug: string; workspace_id: string; owner_agent_id: string }
        | undefined;
      if (!d) continue;
      if (!this.mayReadReceipt(auth, { adopter_agent_id: dl.adopter_agent_id, ...d })) continue;
      rows.push({
        adoption_request_id: this.labelCell("adoption_request_id", dl.id, "recorded_by_the_request_queue", REQUEST_BOUNDARY),
        // which message failed to arrive: an adoption notification, or a
        // surface-11 revocation notice. Undeliverable is loud either way, but
        // an operator needs to know WHICH adopter was not told what.
        notification_kind: this.labelCell("notification_kind", dl.notification_kind, "recorded_by_the_delivery_queue", REQUEST_BOUNDARY),
        reason: this.registryCell(
          "dead_letter_reason",
          dl.reason,
          dl.reason === null ? "the delivery queue recorded no reason" : "recorded_by_the_delivery_queue",
          REQUEST_BOUNDARY,
        ),
        adopter_agent_id: this.labelCell("adopter_agent_id", dl.adopter_agent_id, "recorded_by_the_request_queue", REQUEST_BOUNDARY),
        skill_version_id: this.labelCell("skill_version_id", dl.skill_version_id, "minted_by_the_registry", VERSIONS_BOUNDARY),
        slug: this.labelCell("slug", d.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
        attempt_count: this.countCell(d.attempt_count, "outcome", REQUEST_BOUNDARY, "delivery attempts recorded for this request"),
        queued_since: this.registryCell("queued_since", instant(d.created_at_ms), "recorded_by_the_request_queue", REQUEST_BOUNDARY),
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
          "queued_since",
        ],
        rows,
        empty: "no dead-lettered adoption request is visible to this actor",
      },
      {
        key: "webhook_health",
        title: "Webhook endpoint health (§5.2: active | failing | dead)",
        fields: ["webhook_id", "agent_id", "url", "status", "failure_count", "last_error", "updated_at"],
        rows: webhookHealth(this.db, agentIds).map((w) => ({
          webhook_id: this.labelCell("webhook_id", w.webhook_id, "recorded_by_the_registry", WEBHOOK_BOUNDARY),
          agent_id: this.labelCell("agent_id", w.agent_id, "recorded_by_the_registry", WEBHOOK_BOUNDARY),
          // never the secret and never its reference (Appendix H)
          url: this.labelCell("url", w.url, "recorded_by_the_registry", WEBHOOK_BOUNDARY),
          status: this.labelCell("status", w.status, "recorded_by_the_delivery_queue", WEBHOOK_BOUNDARY),
          failure_count: this.countCell(w.failure_count, "outcome", WEBHOOK_BOUNDARY, "consecutive delivery failures"),
          last_error: this.registryCell(
            "last_error",
            w.last_error,
            w.last_error === null ? "this endpoint has recorded no error" : "recorded_by_the_delivery_queue",
            WEBHOOK_BOUNDARY,
          ),
          updated_at: this.registryCell(
            "updated_at",
            instant(w.updated_at_ms),
            "recorded_by_the_delivery_queue",
            WEBHOOK_BOUNDARY,
          ),
        })),
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
    const rows = countMigrationsPerSkill(this.db, subjects, window);
    return {
      // [I-3]: the ENVELOPE's source names what the rows under it were actually
      // read from. A constant here would republish `receipt_events` over an
      // answer whose recipients came, in part, from the receipt shell.
      source: describeSource({
        from_transfer: rows.filter((r) => r.recipient_sources.includes(RECIPIENT_SOURCE_TRANSFER)).length,
        from_request: rows.filter((r) => r.recipient_sources.includes(RECIPIENT_SOURCE_REQUEST)).length,
      }),
      window: describeWindow(window),
      window_since_ms: window.since_ms,
      window_until_ms: window.until_ms,
      items: rows,
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
    // [I-3]: the counter's own rows already carry a source, a window and a
    // measurement state as FIELDS — and the page used to print the figures
    // beside them as bare integers anyway, so the method sat in a neighbouring
    // column instead of travelling with the number. Every figure here is a
    // number cell, and the boundary each one names is the counter's own.
    // [I-3]: the boundary printed BESIDE each figure is the answer's OWN source
    // phrase, not the module constant. A constant here republished
    // `receipt_events` under every cell whatever the row was read from — the
    // panel reasserting a provenance the API had already qualified. The two now
    // cannot disagree, because there is one string and the API produced it.
    const boundary = `${counted.source} — ${counted.window}`;
    const rows = counted.items.map((m) => ({
      skill_id: this.labelCell("skill_id", m.skill_id, "recorded_by_the_registry", VERSIONS_BOUNDARY),
      slug: this.labelCell("slug", m.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
      migrations: this.countCell(m.migrations, "outcome", boundary, m.measurement_state),
      distinct_recipients: this.countCell(m.distinct_recipients, "outcome", boundary, m.measurement_state),
      distinct_runtimes: this.countCell(m.distinct_runtimes, "outcome", boundary, m.measurement_state),
      runtimes: this.registryCell(
        "runtimes",
        list(m.runtimes, ""),
        m.runtimes.length === 0 ? "no migration of this skill carried a runtime this registry could read" : "declared_by_the_adopter",
        boundary,
      ),
      runtimes_unknown: this.countCell(
        m.runtimes_unknown,
        "outcome",
        boundary,
        "migrations whose declared runtime could not be read — unknown, and never `none`",
      ),
      recipients_unattributed: this.countCell(
        m.recipients_unattributed,
        "outcome",
        boundary,
        "chains dropped because their own recipient event could not be read [I-6]",
      ),
      recipient_sources: this.registryCell(
        "recipient_sources",
        list(m.recipient_sources, ""),
        m.recipient_sources.length === 0 ? "no recipient was read for this skill, so no journal is named" : "the journals these recipients were read from",
        boundary,
      ),
      measurement_state: this.labelCell("measurement_state", m.measurement_state, "the state every number in this row was measured in", boundary),
      source: this.labelCell("source", m.source, "the journal every number in this row was read from", boundary),
      window: this.labelCell("window", m.window, "the selection window every number in this row was taken over", boundary),
    }));
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
          "recipients_unattributed",
          "recipient_sources",
          "measurement_state",
          "source",
          "window",
        ],
        rows,
        empty: "no skill is visible to this actor, so nothing was counted",
        next_cursor: counted.next_cursor,
      },
    ]);
  }

  // ================================================================ §9 =====
  // THE FIVE SCREENS, MINIMAL VERSIONS ([D-1]..[D-5]).
  //
  // Every one of them is a READ LAYER over what §6 part A and §5.5 already
  // publish. Nothing below computes a state, a verdict about a runtime, or a
  // number the surfaces do not already return with its method attached: the
  // screens exist to RENDER those answers honestly, and `src/fleet-dashboard.ts`
  // holds the grammar plus the sweep that proves the rendering did not lose
  // anything on the way out.
  //
  // The parts of §9 that belong to work that does not exist yet are declared as
  // `capability_absent` notices and are NOT rendered as empty tables — an
  // absent capability and an empty result set are different facts [I-1].

  /** The manifest of one version as an object, or null when unreadable. */
  private manifestOfVersion(versionId: string): any {
    const row = this.db.prepare("SELECT manifest_json FROM skill_versions WHERE id=?").get(versionId) as
      | { manifest_json: string }
      | undefined;
    if (!row) return null;
    return safeManifest(row.manifest_json);
  }

  /** The last deployment event of one agent that recorded a failure or a drift. */
  private lastDeploymentFailure(agentId: string): FleetAgentInput["last_failure"] {
    const row = this.db
      .prepare(
        `SELECT e.event AS state, e.server_at_ms AS at_ms, e.reason AS reason, s.slug AS slug
           FROM assignment_events e
           JOIN assignments a ON a.id = e.assignment_id
           JOIN skills s ON s.id = a.skill_id
          WHERE a.agent_id = ? AND e.event IN ('failed','drifted')
          ORDER BY e.server_at_ms DESC, e.id DESC LIMIT 1`,
      )
      .get(agentId) as { state: string; at_ms: number; reason: string | null; slug: string } | undefined;
    return row ?? null;
  }

  /** The last rating this principal recorded. */
  private lastFeedback(agentId: string): FleetAgentInput["last_feedback"] {
    const row = this.db
      .prepare(
        `SELECT r.score AS score, r.created_at_ms AS at_ms, r.note AS note, s.slug AS slug
           FROM ratings r
           JOIN skill_versions v ON v.id = r.skill_version_id
           JOIN skills s ON s.id = v.skill_id
          WHERE r.rater_agent_id = ?
          ORDER BY r.created_at_ms DESC, r.id DESC LIMIT 1`,
      )
      .get(agentId) as { score: number; at_ms: number; note: string | null; slug: string } | undefined;
    return row ?? null;
  }

  /**
   * [D-1] THE FLEET — every agent, and the state of the reconciliation.
   *
   * The three numbers §9 asks for are three DIFFERENT measurements and are kept
   * apart on purpose: `intent_assigned` is read from the assignment journal,
   * `fact_available` from the filesystem under the configured inventory root,
   * `fact_invoked` from paired call/output records. Merging any two of them
   * into a single "coverage" figure would be the intent column answering for
   * the fact column, which is the failure [I-2] exists for.
   */
  private dashFleet(auth: AuthContext): DashboardPayload {
    const list = this.fleetList(auth);
    const agents: FleetAgentInput[] = list.agents.map((agent) => {
      const ctx = this.fleetContext(agent.agent_id, auth.workspace_id);
      return {
        agent,
        dead_weight: this.deadWeightOfContext(ctx),
        last_failure: this.lastDeploymentFailure(agent.agent_id),
        last_feedback: this.lastFeedback(agent.agent_id),
      };
    });
    return this.payload("fleet", "Fleet", fleetSections({ agents, counts: list.counts }), [RECONCILIATION_LEGEND]);
  }

  /** [A-5] for one already-gathered context, so the fleet view and the agent
   *  view read one answer rather than two that could drift. */
  private deadWeightOfContext(ctx: FleetContext): DeadWeightAnswer {
    return deadWeightOf({
      registered: ctx.registered,
      scan: ctx.scan,
      intent_active_version_ids: ctx.views.filter((v) => v.intent_state === "active").map((v) => v.skill_version_id),
      attribution: {
        registeredWindow: ctx.inventory?.window_detail ?? NO_INVENTORY_WINDOW,
        invokedWindow: ctx.snapshot?.window_detail ?? NO_SNAPSHOT_WINDOW,
        invokedSelection: ctx.snapshot?.window ?? "all_time",
      },
    });
  }

  /**
   * [D-2] THE AGENT — the full capability list, in §4's six states.
   *
   * The two runtimes get two tables, because §4's column sets differ. The
   * `never_used` block is [A-5], counted from records and never from what this
   * registry intended.
   */
  private dashAgent(auth: AuthContext): DashboardPayload {
    const entries = this.fleetAgentIds(auth).map((id) => {
      const ctx = this.fleetContext(id, auth.workspace_id);
      const agent = this.agentRow(ctx);
      const dead = this.deadWeightOfContext(ctx);
      const viewByVersion = new Map(ctx.views.map((v) => [v.skill_version_id, v]));
      const lastInvoked = new Map<string, number | null>();
      for (const row of ctx.scan) {
        const before = lastInvoked.get(row.skill_version_id);
        if (before === undefined || (row.at_ms !== null && (before === null || row.at_ms > before))) {
          lastInvoked.set(row.skill_version_id, row.at_ms);
        }
      }
      const observationWindow = ctx.snapshot?.window_detail ?? NO_SNAPSHOT_WINDOW;
      const capabilities: AgentCapabilityInput[] = this.capabilityRows(ctx).map((c) => {
        const view = c.skill_version_id ? viewByVersion.get(c.skill_version_id) : undefined;
        const invokedAt = c.skill_version_id ? lastInvoked.get(c.skill_version_id) : undefined;
        return {
          kind: c.kind,
          name: c.name,
          runtime: c.runtime,
          skill_version_id: c.skill_version_id,
          semantic_version: view?.semantic_version ?? null,
          columns: c.columns,
          origin: view
            ? `handed over by transfer ${view.transfer_id} to a recipient of kind \`${view.recipient_kind}\``
            : "found under the configured inventory root with no assignment of this registry behind it",
          assigned_by: view
            ? { agent_id: view.assigned_by.agent_id, type: view.assigned_by.type, role: view.assigned_by.role }
            : null,
          assigned_at_ms: view?.created_at_ms ?? null,
          last_invoked_ms: invokedAt ?? null,
          last_invoked_reason:
            invokedAt !== undefined && invokedAt !== null
              ? "the latest PAIRED call/output record carrying this version's marker [M-5]"
              : "no paired call/output record carrying this version's marker was found — unobserved, NOT known never to have run [I-1]",
          observation_window: observationWindow,
        };
      });
      return {
        agent,
        columns_reason: ctx.runtime
          ? null
          : "runtime_unknown: no runtime has been observed for this agent and none is configured",
        capabilities,
        dead_weight: dead,
        dead_items: dead.items.map((i) => ({
          kind: i.kind,
          name: i.name,
          skill_version_id: i.skill_version_id,
          reason: i.reason,
        })),
      };
    });
    return this.payload("agent", "Agent", agentSections({ agents: entries }));
  }

  /**
   * [D-3] REGISTER AS A SKILL — the MEANING of a capability, not its manifest.
   *
   * [B-6] is the whole point of this screen: a person deciding whether to
   * approve reads what the thing does, when it applies, what rights it needs,
   * what went into it and what its author deliberately left out. The JSON is not
   * shown, and nobody is asked to read one to decide.
   *
   * [B-7]/[I-5]: every recorded decision names the TYPE of the principal who
   * made it, and distinguishes the workspace owner from a principal holding a
   * role.
   *
   * WHAT IS NOT HERE, AND SAYS SO: the drafts inbox with its marking and
   * redaction preview ([B-2]/[B-3], work 9) and the register of refusals
   * ([B-5], work 10). Both are declared as absent capabilities rather than
   * rendered as empty tables.
   */
  private dashSkillApproval(auth: AuthContext, params: SearchParams): DashboardPayload {
    const { items, next_cursor } = this.search(auth, params);
    const subjects: ApprovalSubjectInput[] = items.map((item) => {
      const manifest = this.manifestOfVersion(item.skill_version_id);
      const readable = manifest !== null && typeof manifest === "object";
      const scope = readable ? (manifest.scope ?? {}) : {};
      const safety = readable ? (manifest.safety ?? {}) : {};
      const runtime = readable ? (manifest.runtime ?? {}) : {};
      const procedure = readable ? (manifest.procedure ?? {}) : {};
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
      return {
        slug: item.slug,
        skill_version_id: item.skill_version_id,
        semantic_version: item.semantic_version,
        state: item.state,
        title: readable && typeof manifest.title === "string" ? manifest.title : null,
        capability_statement:
          readable && typeof manifest.capability_statement === "string" ? manifest.capability_statement : null,
        problem_class: typeof scope.problem_class === "string" ? scope.problem_class : null,
        prerequisites: strings(scope.prerequisites),
        non_goals: strings(scope.non_goals),
        risk_level: typeof scope.risk_level === "string" ? scope.risk_level : null,
        sandbox_requirement: typeof safety.sandbox_requirement === "string" ? safety.sandbox_requirement : null,
        forbidden_actions: strings(safety.forbidden_actions),
        secrets_policy: typeof safety.secrets_policy === "string" ? safety.secrets_policy : null,
        url_allowlist: strings(safety.url_allowlist),
        cloud_iam_assumptions: strings(runtime.cloud_iam_assumptions),
        mcp_dependencies: Array.isArray(runtime.mcp_dependencies)
          ? runtime.mcp_dependencies.map((d: any) => `${String(d?.registry_id)}@${String(d?.version)}`)
          : [],
        step_count: Array.isArray(procedure.steps) ? procedure.steps.length : null,
        file_count: readable && Array.isArray(manifest.integrity) ? manifest.integrity.length : null,
        required_approvals: strings(scope.required_approvals),
        approval_state: this.approvalStateOf(item.skill_version_id, strings(scope.required_approvals)),
        manifest_readable: readable,
      };
    });

    const visible = new Set(items.map((i) => i.skill_version_id));
    const decisionRows = this.db
      .prepare(
        `SELECT a.id AS approval_id, a.skill_version_id, a.scope, a.decision, a.note, a.created_at_ms,
                a.approver_agent_id, s.slug AS slug, v.semantic_version AS semantic_version
           FROM approvals a
           JOIN skill_versions v ON v.id = a.skill_version_id
           JOIN skills s ON s.id = v.skill_id
          ORDER BY a.created_at_ms DESC, a.id DESC`,
      )
      .all() as Array<{
      approval_id: string;
      skill_version_id: string;
      scope: string;
      decision: string;
      note: string | null;
      created_at_ms: number;
      approver_agent_id: string;
      slug: string;
      semantic_version: string;
    }>;
    const decisions: ApprovalDecisionInput[] = [];
    for (const d of decisionRows) {
      // a decision about a version this actor may not see is not acknowledged
      if (!visible.has(d.skill_version_id)) continue;
      const principal = loadPrincipal(this.db, d.approver_agent_id);
      decisions.push({
        approval_id: d.approval_id,
        slug: d.slug,
        semantic_version: d.semantic_version,
        scope: d.scope,
        decision: d.decision,
        note: d.note,
        created_at_ms: d.created_at_ms,
        approver: {
          agent_id: d.approver_agent_id,
          type: principal?.type ?? "unknown",
          role: principal?.role ?? null,
        },
      });
    }
    return this.payload(
      "skill_approval",
      "Register as a skill",
      approvalSections({ subjects, decisions, next_cursor }),
      [...APPROVAL_NOTICES],
    );
  }

  /** Which of a version's declared approvals have been recorded. Never a bare
   *  "approved": a version needing none and a version whose approval was
   *  recorded are different facts. */
  private approvalStateOf(versionId: string, required: readonly string[]): string {
    const rows = this.db
      .prepare("SELECT scope, decision FROM approvals WHERE skill_version_id=? ORDER BY created_at_ms, id")
      .all(versionId) as Array<{ scope: string; decision: string }>;
    if (required.length === 0) {
      return rows.length === 0
        ? "none required, and none recorded"
        : `none required; ${rows.length} decision(s) recorded anyway`;
    }
    const parts = required.map((scope) => {
      const decided = rows.filter((r) => r.scope === scope);
      if (decided.length === 0) return `${scope}: no decision recorded`;
      return `${scope}: ${decided[decided.length - 1]!.decision}`;
    });
    return parts.join(" | ");
  }

  /**
   * [D-4] THE CAPABILITY — its versions, where each came from, who holds it,
   * where it worked, where it broke, how often it migrated [C-1], and what its
   * rollback is.
   *
   * The `diff` is between the DECLARED SECTIONS of two manifests, and it says
   * so: it is not a textual diff of the packages, and a version with no
   * predecessor gets `unknown` with the reason rather than an empty cell.
   */
  private dashCapability(auth: AuthContext, params: SearchParams): DashboardPayload {
    const { items, next_cursor } = this.search(auth, params);
    const readable = new Set(this.fleetAgentIds(auth));
    const migrationsBySkill = new Map(
      countMigrationsPerSkill(
        this.db,
        [...new Map(items.map((i) => [i.skill_id, { skill_id: i.skill_id, slug: i.slug }])).values()],
        ALL_TIME,
      ).map((m) => [m.skill_id, m]),
    );
    const versions: CapabilityVersionInput[] = items.map((item) => {
      const row = this.db
        .prepare("SELECT author_agent_id, created_at_ms, manifest_json FROM skill_versions WHERE id=?")
        .get(item.skill_version_id) as
        | { author_agent_id: string; created_at_ms: number; manifest_json: string }
        | undefined;
      const manifest = row ? safeManifest(row.manifest_json) : null;
      const supersedes =
        manifest && typeof manifest === "object" && typeof (manifest as any).lifecycle?.supersedes === "string"
          ? ((manifest as any).lifecycle.supersedes as string)
          : null;
      const diff = this.manifestDiff(manifest, supersedes);
      const holders = this.db
        .prepare("SELECT DISTINCT agent_id FROM assignments WHERE skill_version_id=? ORDER BY agent_id")
        .all(item.skill_version_id) as Array<{ agent_id: string }>;
      const shown = holders.filter((h) => readable.has(h.agent_id)).map((h) => h.agent_id);
      const hidden = holders.length - shown.length;
      const assigned = [...shown];
      if (hidden > 0) assigned.push(`${hidden} further recipient(s) this actor may not read`);
      const migration = migrationsBySkill.get(item.skill_id);
      const rollback =
        manifest && typeof manifest === "object" && Array.isArray((manifest as any).procedure?.rollback)
          ? ((manifest as any).procedure.rollback as unknown[]).length
          : null;
      return {
        skill_id: item.skill_id,
        slug: item.slug,
        skill_version_id: item.skill_version_id,
        semantic_version: item.semantic_version,
        state: item.state,
        author_agent_id: row?.author_agent_id ?? "unknown",
        created_at_ms: row?.created_at_ms ?? 0,
        supersedes,
        diff_sections: diff.sections,
        diff_reason: diff.reason,
        assigned_to: assigned,
        worked: registryCount(item.registry.reputation.adopted_count, "outcome", RECEIPT_JOURNAL),
        broke: registryCount(item.registry.reputation.failed_count, "outcome", RECEIPT_JOURNAL),
        rolled_back: registryCount(item.registry.reputation.rolled_back_count, "outcome", RECEIPT_JOURNAL),
        migrations: registryCount(
          migration?.migrations ?? 0,
          "outcome",
          // [I-3]: the counted row's OWN source phrase, exactly as the
          // migrations panel prints it. A skill that was not among the counted
          // subjects has no answer to name a source for, so the module constant
          // is what the empty case states — and it says the journal, which is
          // where the zero beside it would have been read from.
          `${migration?.source ?? MIGRATION_SOURCE} — ${migration?.window ?? describeWindow(ALL_TIME)}`,
          // [I-3]: the recipients and the unreadable runtimes are NOT restated
          // as figures inside this sentence. They are numbers, they were
          // measured, and each is published as its own number cell — with its
          // own state, source and boundary — on the migrations view. A figure
          // repeated into a reason arrives with none of the three.
          migration === undefined
            ? "this skill was not among the counted subjects"
            : "the distinct recipients and the migrations whose declared runtime could not be read are their own number cells on the migrations view",
        ),
        rollback_steps: rollback,
      };
    });
    return this.payload("capability", "Capability", capabilitySections({ versions, next_cursor }));
  }

  /** Which DECLARED SECTIONS of two manifests differ. Not a textual diff, and
   *  it never pretends to be one. */
  private manifestDiff(manifest: unknown, predecessorId: string | null): { sections: string[] | null; reason: string } {
    if (!manifest || typeof manifest !== "object") {
      return { sections: null, reason: "this version's manifest could not be read, so nothing could be compared" };
    }
    if (predecessorId === null) {
      return { sections: null, reason: "this version supersedes nothing: there is no predecessor to compare with" };
    }
    const previous = this.manifestOfVersion(predecessorId);
    if (!previous || typeof previous !== "object") {
      return {
        sections: null,
        reason: `the predecessor ${predecessorId} is not a version of this registry, or its manifest could not be read`,
      };
    }
    const differ: string[] = [];
    for (const key of MANIFEST_SECTIONS) {
      const a = JSON.stringify((manifest as any)[key] ?? null);
      const b = JSON.stringify((previous as any)[key] ?? null);
      if (a !== b) differ.push(key);
    }
    return { sections: differ, reason: `compared section by section against ${predecessorId}` };
  }

  /**
   * [D-5] RESULTS — what worked, what broke, and what needs a new version.
   *
   * `nothing_reported` is a verdict of its own. A version nobody has closed a
   * receipt over has NOT been shown to work, and rendering it beside the ones
   * that did — under a heading that reads "worked" — would be the same collapse
   * of `unknown` into an answer that [I-1] exists to prevent.
   */
  private dashOutcomes(auth: AuthContext, params: SearchParams): DashboardPayload {
    const { items, next_cursor } = this.search(auth, params);
    const versions: OutcomeVersionInput[] = items.map((item) => {
      const r = item.registry.reputation;
      const bad = r.failed_count + r.rolled_back_count;
      const verdict: OutcomeVersionInput["verdict"] =
        bad > 0 ? "needs_new_version" : r.adopted_count > 0 ? "worked" : "nothing_reported";
      // [I-3]: the reason NAMES the cells it compared and restates no figure.
      // A count inside a sentence carries no measurement state, no source and
      // no window; `worked`, `broke` and `rolled_back` stand on this row and
      // each carries all three.
      const reason =
        bad > 0
          ? "chains over this version ended `failed` or `rolled_back` — the counts are the `broke` and `rolled_back` cells of this row"
          : r.adopted_count > 0
            ? "chains over this version ended `adopted` and none ended `failed` or `rolled_back` — the count is the `worked` cell of this row"
            : "no adoption chain over this version has reached a terminal event: nothing was reported, which is not the same as working";
      return {
        slug: item.slug,
        skill_version_id: item.skill_version_id,
        semantic_version: item.semantic_version,
        state: item.state,
        worked: registryCount(r.adopted_count, "outcome", RECEIPT_JOURNAL),
        broke: registryCount(r.failed_count, "outcome", RECEIPT_JOURNAL),
        rolled_back: registryCount(r.rolled_back_count, "outcome", RECEIPT_JOURNAL),
        avg_rating: r.avg_rating,
        failure_modes: r.failure_modes_observed,
        verdict,
        verdict_reason: reason,
      };
    });

    const limit = parseLimit(params.limit);
    const chains = this.db
      .prepare(
        `SELECT r.id AS receipt_id, r.adopter_agent_id, s.slug AS slug, s.workspace_id, s.owner_agent_id,
                (SELECT MAX(server_at_ms) FROM receipt_events WHERE adoption_receipt_id = r.id) AS at_ms,
                (SELECT failure_report_json FROM receipt_events WHERE adoption_receipt_id = r.id
                  AND failure_report_json IS NOT NULL ORDER BY event_seq DESC LIMIT 1) AS failure_json
           FROM adoption_receipts r
           JOIN skill_versions v ON v.id = r.skill_version_id
           JOIN skills s ON s.id = v.skill_id
          ORDER BY r.created_at_ms DESC, r.id DESC`,
      )
      .all() as Array<{
      receipt_id: string;
      adopter_agent_id: string;
      slug: string;
      workspace_id: string;
      owner_agent_id: string;
      at_ms: number | null;
      failure_json: string | null;
    }>;
    const receipts: OutcomeReceiptInput[] = [];
    for (const c of chains) {
      if (receipts.length === limit) break;
      if (!this.mayReadReceipt(auth, c)) continue;
      let summary: string | null = null;
      if (c.failure_json !== null) {
        const parsed = safeManifest(c.failure_json) as any;
        summary =
          parsed && typeof parsed === "object"
            ? `${String(parsed.category ?? "unknown category")}: ${String(parsed.summary ?? "no summary")}`
            : "the failure report could not be read";
      }
      receipts.push({
        receipt_id: c.receipt_id,
        slug: c.slug,
        derived_state: derivedState(this.db, c.receipt_id),
        adopter_agent_id: c.adopter_agent_id,
        at_ms: c.at_ms ?? 0,
        failure_summary: summary,
        stalled: isStalled(this.db, c.receipt_id, this.now()),
      });
    }
    return this.payload("outcomes", "Results", outcomeSections({ versions, receipts, next_cursor }));
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

  /**
   * The §5.1 rules that decide whether a version may enter an adoption chain at
   * all, plus the §7.3 hold that decides which state the chain's request starts
   * in. Shared by surface 6 (the recipient asks) and §5.4's transfer (a sender
   * sends), because those two differ in WHO acts and not at all in what may be
   * adopted — and a second copy of these rules would be a second answer to
   * "is this version adoptable", only one of which would be tested.
   */
  private adoptability(
    auth: AuthContext,
    versionId: unknown,
  ): { row: VersionRow; conditions: string[]; requestState: RequestState } {
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
    const adoptedCount = this.adoptedCountOf(row.id);
    // §7.3 adoption column. A §7.3 condition does NOT refuse this call
    // (Appendix H surface 6): the request is created in `approval_pending`, no
    // worker may claim it (§5.2), and `skill.adopt` — surface 7 — is what
    // refuses until a matching human approval names this exact request. That is
    // what breaks the approval↔request circular dependency: an approval must
    // name an `adoption_request_id`, so the request has to exist first.
    const conditions = approvalConditions(manifest, { adoptedCount });
    return { row, conditions, requestState: conditions.length > 0 ? "approval_pending" : "pending" };
  }

  private requestAdoptionInner(auth: AuthContext, input: { skill_version_id?: unknown }): RequestAdoptionResponse {
    const { row, conditions, requestState: state } = this.adoptability(auth, (input ?? {}).skill_version_id);
    const versionId = row.id;

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

      // …and the EVENT that says who this movement is TO. `requested` is the
      // pull twin of §5.4's `transferred`: this chain was opened by the
      // authenticated caller, asking for this version for ITSELF, so the
      // recipient is that caller and its kind is `local_agent`.
      //
      // It is written HERE, in the transaction that writes the request and the
      // shell, for the reason `0004` moved the declared environment onto
      // `delivered` and `0006` put the recipient onto `transferred`: the
      // migration counter's key is (version, RECIPIENT), and a key half-read
      // from outside the journal makes "every count is computed from
      // `receipt_events`" a sentence that holds for push chains and quietly
      // fails for pull ones. The recipient is taken from `AuthContext` and never
      // from the payload — surface 6 names no recipient and never will, because
      // a pull whose recipient is someone else is a push.
      appendReceiptEventInTx(db, {
        receiptId,
        actorAgentId: auth.agent_id,
        event: "requested",
        recipient: { kind: "local_agent", id: auth.agent_id },
        idempotencyKey: `request:${requestId}`,
        nowMs: now,
        asRegistry: true,
      });
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

  // ------------------------------------------- §5.4: skill.transfer + grants

  /**
   * Surface 15 — a transfer with a NAMED, TYPED recipient. The service layer
   * contributes exactly what it owns: the §5.1 access rules and the §7.3 hold,
   * both shared verbatim with surface 6. Everything about the recipient, the
   * permission and the record is §5.4's own module.
   */
  transfer(
    auth: AuthContext,
    input: { skill_version_id?: unknown; recipient?: unknown },
    idempotencyKey?: string,
  ): IdempotentOutcome<TransferResponse> {
    return withIdempotency(this.db, auth.agent_id, "skill.transfer", idempotencyKey, this.now(), () => {
      // The recipient is parsed BEFORE the version is resolved, so a call that
      // names no recipient is refused as the malformed transfer it is rather
      // than reporting whatever the version's state happens to be. A transfer
      // without a recipient is not a transfer with a default one.
      parseRecipient((input ?? {}).recipient);
      const { row, conditions, requestState } = this.adoptability(auth, (input ?? {}).skill_version_id);
      return recordTransfer(this.db, auth, input ?? {}, {
        versionId: row.id,
        requestState,
        conditions,
        nowMs: this.now(),
      });
    });
  }

  /** §6.2 — issue one (agent, action, recipient scope) grant. */
  createGrant(
    auth: AuthContext,
    input: CreateGrantInput,
    idempotencyKey?: string,
  ): IdempotentOutcome<CreatedGrant> {
    return withIdempotency(this.db, auth.agent_id, "transfer_grant.create", idempotencyKey, this.now(), () =>
      createGrant(this.db, auth, input ?? {}, this.now()),
    );
  }

  /** §6.2 — the grants this actor may read. */
  listGrants(auth: AuthContext): { items: GrantView[] } {
    return listGrants(this.db, auth);
  }

  // ---------------------------------- §5.5: deployment assignments (§6.3)

  /**
   * The assignment, the actor and the permission — resolved in that order, and
   * the order is the ACL.
   *
   * An assignment addressed to an agent of another workspace is ABSENT, not
   * forbidden, exactly as a principal of another workspace is: acknowledging it
   * would disclose that a fleet elsewhere holds this skill. The permission is
   * then the §6.2 grant for the step being taken, scoped to the assignment's own
   * recipient kind — no second permission system, and no role invented for
   * deployment.
   */
  private assignmentContext(
    auth: AuthContext,
    assignmentId: unknown,
    action: GrantAction,
  ): { row: AssignmentRow; head: AssignmentHead; grant: GrantRow; actor: GrantPrincipal } {
    if (typeof assignmentId !== "string" || assignmentId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "assignment_id (string) required");
    }
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    const row = loadAssignment(this.db, assignmentId);
    if (!row || row.workspace_id !== auth.workspace_id) throw new ApiError("NOT_FOUND", "assignment not found");
    const actorRow = loadPrincipal(this.db, auth.agent_id);
    if (!actorRow || actorRow.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    const grant = findGrant(this.db, actorRow.id, action, row.recipient_kind);
    if (!grant) {
      throw new ApiError(
        "FORBIDDEN",
        `this principal holds no \`${action}\` grant scoped to \`${row.recipient_kind}\` (§6.2)`,
      );
    }
    return {
      row,
      head: headOf(this.db, row.id),
      grant,
      actor: { agent_id: actorRow.id, type: actorRow.type, role: actorRow.role },
    };
  }

  /** One assignment as the surfaces publish it: intent and observation apart. */
  private viewOf(row: AssignmentRow): AssignmentView {
    return assignmentView(
      row,
      headOf(this.db, row.id),
      // the observation is computed from RECORDS and a marker, by the one
      // function allowed to compute it, and it is handed to the view already
      // finished — the view never has both columns' inputs in one scope
      observedArrival(this.runtimeRecords.recordsFor(row.agent_id), subjectOf(row)),
    );
  }

  private assignmentOutcome(
    row: AssignmentRow,
    action: AssignmentAction,
    opts: { managedCopy: ManagedCopy | "unknown"; rootConfigured: boolean; noop?: boolean },
  ): AssignmentActionResponse {
    const assignment = this.viewOf(row);
    const res: AssignmentActionResponse = {
      action,
      assignment,
      managed_copy: opts.managedCopy,
      activation_root_configured: opts.rootConfigured,
      requires_new_session: assignment.requires_new_session,
      session_effect: assignment.session_effect,
    };
    if (opts.noop) res.noop = true;
    return res;
  }

  /** The package files of one version, or a refusal naming the missing blob. */
  private filesOf(versionId: string): PackageFiles {
    const row = this.db.prepare("SELECT package_blob_ref AS r FROM skill_versions WHERE id=?").get(versionId) as
      | { r: string }
      | undefined;
    const blob = row ? this.blobs.get(row.r) : undefined;
    if (!blob) throw new ApiError("NOT_FOUND", "package blob unavailable for this version — nothing can be materialized");
    return readArchiveBytes(blob);
  }

  /**
   * `assignment.activate` — materialize the managed copy in the runtime's
   * native location, and record what this registry now BELIEVES.
   *
   * Three things about this call are load-bearing:
   *
   * 1. With no activation root configured it writes NOTHING and records
   *    `queued`. That is the shipped default, and it is why a deployment that
   *    has never been configured cannot accidentally write into a real fleet.
   * 2. `activating` is committed BEFORE the filesystem is touched, so a crash
   *    leaves an unfinished activation rather than a claim.
   * 3. `active` is recorded only after the entry file has been READ BACK from
   *    the native location and found to be the version's own bytes. It still
   *    means "Skillonomia believes it activated this", and the answer says so:
   *    the observation column beside it stays `unknown` until a runtime record
   *    carrying this version's marker exists.
   */
  activateAssignment(
    auth: AuthContext,
    assignmentId: unknown,
    idempotencyKey?: string,
  ): IdempotentOutcome<AssignmentActionResponse> {
    return withIdempotency(this.db, auth.agent_id, "assignment.activate", idempotencyKey, this.now(), () =>
      this.activateInner(auth, assignmentId),
    );
  }

  private activateInner(auth: AuthContext, assignmentId: unknown): AssignmentActionResponse {
    const { row, head, grant, actor } = this.assignmentContext(auth, assignmentId, "activate");
    if (head.state === "revoked") {
      throw new ApiError("PRECONDITION_FAILED", "a revoked assignment is not re-activated — assign the skill again", head.state);
    }
    const site = this.activation.rootFor(row.agent_id);
    const append = (input: Omit<AppendAssignmentEventInput, "assignmentId" | "actor" | "nowMs">): void => {
      appendAssignmentEvent(this.db, { ...input, assignmentId: row.id, actor, nowMs: this.now() });
    };

    if (site === null) {
      // Nothing is configured, so nothing is written and nothing is claimed.
      if (head.state === "queued") return this.assignmentOutcome(row, "activate", { managedCopy: head.managed_copy ?? "unknown", rootConfigured: false, noop: true });
      append({
        event: "queued",
        reason: "no_activation_root_configured",
        grantId: grant.id,
        grantAction: grant.action,
        managedCopy: head.managed_copy === "written" ? "retained" : "absent",
        idempotencyKey: `queued:${this.now()}:${head.event_seq}`,
      });
      return this.assignmentOutcome(row, "activate", { managedCopy: head.managed_copy === "written" ? "retained" : "absent", rootConfigured: false });
    }

    const files = this.filesOf(row.skill_version_id);
    const entry = files.get(NATIVE_ENTRY);
    if (!entry) throw new ApiError("PRECONDITION_FAILED", `this package carries no ${NATIVE_ENTRY} — there is nothing a runtime would read`, head.state);

    // DRIFT is checked before anything is written, and only against what the
    // native location actually holds. An `active` deployment whose copy still
    // matches is a convergent noop: re-recording `activating`/`active` on every
    // call would fill the journal with steps nothing took.
    if (head.state === "active") {
      const onDisk = readBack(site, row.slug);
      if (onDisk !== null && onDisk.equals(entry)) {
        return this.assignmentOutcome(row, "activate", { managedCopy: "written", rootConfigured: true, noop: true });
      }
      append({
        event: "drifted",
        reason: onDisk === null ? "native_copy_missing" : "native_copy_differs",
        grantId: grant.id,
        grantAction: grant.action,
        managedCopy: onDisk === null ? "absent" : "written",
        idempotencyKey: `drifted:${this.now()}:${head.event_seq}`,
      });
    }

    append({ event: "activating", grantId: grant.id, grantAction: grant.action, idempotencyKey: `activating:${this.now()}:${head.event_seq}` });
    try {
      const placed = materialize(site, row.slug, files);
      const back = readBack(site, row.slug);
      if (back === null || !back.equals(entry)) {
        throw new ActivationError("read_back_failed", "the managed copy could not be read back from the native location");
      }
      append({
        event: "active",
        grantId: grant.id,
        grantAction: grant.action,
        activationTarget: site.target,
        nativeRelpath: placed.relpath,
        managedCopy: "written",
        idempotencyKey: `active:${this.now()}:${head.event_seq}`,
      });
      return this.assignmentOutcome(row, "activate", { managedCopy: "written", rootConfigured: true });
    } catch (e) {
      // The REASON is a code, never a filesystem message: an errno string names
      // absolute paths, and a fleet member's directory layout is not the
      // registry's to publish into an INSERT-only table or an error body.
      const reason = e instanceof ActivationError ? e.reason : "activation_failed";
      append({ event: "failed", reason, grantId: grant.id, grantAction: grant.action, idempotencyKey: `failed:${this.now()}:${head.event_seq}` });
      throw new ApiError(
        "PRECONDITION_FAILED",
        `activation did not complete (${reason}); the deployment is recorded as failed and nothing claims it is running`,
        "failed",
      );
    }
  }

  /** `assignment.pause` — withdraw the managed copy, keep the assignment. */
  pauseAssignment(
    auth: AuthContext,
    assignmentId: unknown,
    idempotencyKey?: string,
  ): IdempotentOutcome<AssignmentActionResponse> {
    return withIdempotency(this.db, auth.agent_id, "assignment.pause", idempotencyKey, this.now(), () =>
      this.withdraw(auth, assignmentId, "paused"),
    );
  }

  /** `assignment.revoke` — withdraw the managed copy, and end the assignment. */
  revokeAssignment(
    auth: AuthContext,
    assignmentId: unknown,
    idempotencyKey?: string,
  ): IdempotentOutcome<AssignmentActionResponse> {
    return withIdempotency(this.db, auth.agent_id, "assignment.revoke", idempotencyKey, this.now(), () =>
      this.withdraw(auth, assignmentId, "revoked"),
    );
  }

  /**
   * The one path both withdrawals take.
   *
   * They exercise the SAME capability on the runtime — removing the managed
   * copy — and differ only in whether the assignment can be taken up again, so
   * both require the §6.2 `revoke` grant and neither invents a permission of its
   * own. What they may NOT do is claim more than a file removal is: the answer
   * carries `requires_new_session` and the sentence that says an agent which has
   * already read the instructions still has them.
   */
  private withdraw(auth: AuthContext, assignmentId: unknown, event: "paused" | "revoked"): AssignmentActionResponse {
    const { row, head, grant, actor } = this.assignmentContext(auth, assignmentId, "revoke");
    if (head.state === event) {
      return this.assignmentOutcome(row, event === "paused" ? "pause" : "revoke", {
        managedCopy: head.managed_copy ?? "unknown",
        rootConfigured: this.activation.rootFor(row.agent_id) !== null,
        noop: true,
      });
    }
    if (head.state === "revoked") {
      throw new ApiError("PRECONDITION_FAILED", "a revoked assignment is terminal", head.state);
    }
    const site = this.activation.rootFor(row.agent_id);
    // With no root configured the registry cannot reach a copy it may have
    // placed under a root that has since been unconfigured. `retained` is the
    // honest answer there, and it is not `removed`.
    const copy: ManagedCopy =
      site === null ? (head.managed_copy === "written" ? "retained" : "absent") : removeManaged(site, row.slug);
    appendAssignmentEvent(this.db, {
      assignmentId: row.id,
      event,
      actor,
      reason: site === null && copy === "retained" ? "no_activation_root_configured" : null,
      grantId: grant.id,
      grantAction: grant.action,
      managedCopy: copy,
      idempotencyKey: `${event}:${this.now()}:${head.event_seq}`,
      nowMs: this.now(),
    });
    return this.assignmentOutcome(row, event === "paused" ? "pause" : "revoke", {
      managedCopy: copy,
      rootConfigured: site !== null,
    });
  }

  /**
   * `assignment.list` — the deployments this actor may read, with BOTH columns
   * and with every number carrying its method.
   *
   * Strictly reading: it appends nothing, moves nothing and takes no
   * idempotency key. An admin/owner reads the workspace's deployments; anyone
   * else reads exactly the ones addressed to itself.
   */
  listAssignments(auth: AuthContext): AssignmentListResponse {
    const wide = auth.role === "admin" || auth.role === "owner";
    const agentIds = wide
      ? (this.db.prepare("SELECT id FROM agents WHERE workspace_id=? ORDER BY id").all(auth.workspace_id) as Array<{
          id: string;
        }>).map((r) => r.id)
      : [auth.agent_id];
    const rows = assignmentsForAgents(this.db, agentIds);
    const byAssignment = new Map<string, AssignmentEventRow[]>();
    for (const e of eventsOf(this.db, rows.map((r) => r.id))) {
      const list = byAssignment.get(e.assignment_id);
      if (list === undefined) byAssignment.set(e.assignment_id, [e]);
      else list.push(e);
    }
    const items = rows.map((row) =>
      assignmentView(
        row,
        headFrom(byAssignment.get(row.id) ?? []),
        observedArrival(this.runtimeRecords.recordsFor(row.agent_id), subjectOf(row)),
      ),
    );

    // The two counts are taken from the two COLUMNS, separately. An
    // `intent_active` that happened to equal `observed_arrival_yes` would be a
    // coincidence of one deployment and never a rule, and neither number is
    // computed from the other.
    const counts: AssignmentCounts = {
      assignments: items.length,
      intent_active: items.filter((i) => i.intent_state === "active").length,
      observed_arrival_yes: items.filter((i) => i.observed_arrival === "yes").length,
      observed_arrival_unknown: items.filter((i) => i.observed_arrival === "unknown").length,
      measurement_state: "counted",
      intent_source: ASSIGNMENT_INTENT_SOURCE,
      observation_source: ARRIVAL_OBSERVATION_SOURCE,
      window: "all time; the assignments this actor may read",
    };

    // The native inventory is a FILESYSTEM number and says so. It counts what is
    // under the configured roots — symbolic links followed, because a fleet's
    // shared skill library is normally reached through one — and it counts what
    // is THERE rather than what this registry put there.
    const roots = new Set<string>();
    for (const id of new Set(rows.map((r) => r.agent_id))) {
      const site = this.activation.rootFor(id);
      if (site) roots.add(site.root);
    }
    let inventory: NativeInventory;
    if (roots.size === 0) {
      inventory = {
        skill_files: null,
        measurement_state: "unknown",
        reason: "no activation root is configured for any agent in this answer: nothing was walked",
        source: NATIVE_INVENTORY_SOURCE,
        window: "no activation root",
      };
    } else {
      let total = 0;
      let unreadable = 0;
      for (const root of roots) {
        try {
          total += skillFilesUnder(root);
        } catch {
          unreadable += 1;
        }
      }
      inventory =
        unreadable === roots.size
          ? {
              skill_files: null,
              measurement_state: "unknown",
              reason: "every configured activation root was unreadable",
              source: NATIVE_INVENTORY_SOURCE,
              window: `${roots.size} configured activation root(s)`,
            }
          : {
              skill_files: total,
              measurement_state: "counted",
              reason: unreadable === 0 ? null : `${unreadable} of ${roots.size} configured roots were unreadable`,
              source: NATIVE_INVENTORY_SOURCE,
              window: `${roots.size - unreadable} of ${roots.size} configured activation root(s), all depths`,
            };
    }
    return { items, counts, native_inventory: inventory };
  }

  // ==================================================================
  // §6 PART A — the fleet inventory, the six states, and the scanner
  // ==================================================================

  /** The agents this actor may read: its own, or the workspace's as admin/owner. */
  private fleetAgentIds(auth: AuthContext): string[] {
    const wide = auth.role === "admin" || auth.role === "owner";
    if (!wide) return [auth.agent_id];
    return (
      this.db.prepare("SELECT id FROM agents WHERE workspace_id=? ORDER BY id").all(auth.workspace_id) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
  }

  /**
   * Every marker this workspace's versions derive, mapped back to the version.
   *
   * The marker is derived from the version id and NEVER stored, so the reverse
   * direction is a computation over the versions a reader may see rather than a
   * lookup. That is the honest shape: a marker found on a disk that belongs to
   * no version this workspace holds resolves to NOTHING, which is precisely the
   * dead-weight case [A-5] must be able to report.
   */
  private markerIndex(workspaceId: string): MarkerIndex {
    const rows = this.db
      .prepare(
        `SELECT v.id AS id, v.manifest_json AS manifest_json, v.manifest_hash AS manifest_hash, s.slug AS slug
           FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.workspace_id = ? ORDER BY v.id`,
      )
      .all(workspaceId) as Array<{ id: string; manifest_json: string; manifest_hash: string; slug: string }>;
    const out: MarkerIndex = new Map();
    for (const r of rows) {
      out.set(arrivalMarker(r.id), {
        skill_version_id: r.id,
        manifest_json: r.manifest_json,
        manifest_hash: r.manifest_hash,
        slug: r.slug,
      });
    }
    return out;
  }

  /**
   * The evidence names ONE version's SIGNED contract declares, or `null` where
   * no such contract can be read.
   *
   * "Signed" is checked and not assumed: the stored manifest is canonicalised
   * and hashed, and the result must be the `manifest_hash` the detached JWS was
   * made over. A manifest that no longer hashes to what was signed is not the
   * document whose definition of success anybody approved, so it declares
   * nothing here — the same rule D-2 states for redefining success without a
   * new version, applied at the one boundary that would otherwise widen what a
   * report may carry.
   *
   * `null` means "no contract could be read", which the caller turns into the
   * base set and nothing more. It never means "no restriction".
   */
  private signedEvidenceNames(
    index: MarkerIndex,
    marker: string,
    memo: Map<string, SignedEvidenceTerms | null>,
  ): SignedEvidenceTerms | null {
    // ONE ANSWER PER MARKER PER REPORT. A report carries up to 5000 records and
    // a manifest hash is a canonicalisation plus a SHA-256; recomputing it per
    // record would make the size of a report quadratic in the work it costs.
    // The memo lives for the length of one call and is never a cache of
    // anything a later report could read.
    const cached = memo.get(marker);
    if (cached !== undefined) return cached;
    const answer = this.readSignedEvidenceNames(index, marker);
    memo.set(marker, answer);
    return answer;
  }

  private readSignedEvidenceNames(index: MarkerIndex, marker: string): SignedEvidenceTerms | null {
    const known = index.get(marker);
    if (!known) return null;
    let manifest: unknown;
    try {
      manifest = JSON.parse(known.manifest_json);
    } catch {
      return null;
    }
    try {
      if (manifestHash(manifest as never) !== known.manifest_hash) return null;
    } catch {
      return null;
    }
    const read = outcomeContractOf(manifest);
    if (!read.valid || read.contract === null) return null;
    // THE NAMES AND THE LITERALS COME OUT OF THE SAME SIGNED DOCUMENT, in one
    // read. `evidence` says which values a run must present; the `check`'s own
    // parameters are the only strings a reporter may echo back (2.3). Reading
    // them apart would be two answers about one manifest, free to disagree.
    return { names: new Set(read.contract.evidence), literals: contractLiterals(read.contract) };
  }

  /**
   * [I-7]'s admissible set for ONE record: the names this registry's checks
   * read, plus the names EVERY marker on the record has a signed contract for.
   *
   * THE INTERSECTION, NOT THE UNION, and the reason is that one record with two
   * markers is written as two rows. A name declared by one version's contract
   * would otherwise be stored against the other version's record too, and that
   * second row would carry a value nothing ever asked for — the defect this
   * whole boundary exists to close, arriving through the back of it. One marker
   * whose contract cannot be read closes the record down to the base set.
   */
  private admissibleEvidenceNames(
    index: MarkerIndex,
    markers: readonly string[],
    memo: Map<string, SignedEvidenceTerms | null>,
  ): SignedEvidenceTerms {
    const admissible = new Set(EVIDENCE_NAMES);
    // THE LITERALS ARE INTERSECTED FOR THE SAME REASON THE NAMES ARE. One
    // record with two markers is written as two rows, and a word one version's
    // contract happens to name is not a word the other version ever asked for.
    if (markers.length === 0) return { names: admissible, literals: new Set() };
    let sharedNames: string[] | null = null;
    let sharedLiterals: string[] | null = null;
    for (const marker of markers) {
      const declared = this.signedEvidenceNames(index, marker, memo);
      if (declared === null) return { names: admissible, literals: new Set() };
      sharedNames = sharedNames === null ? [...declared.names] : sharedNames.filter((n) => declared.names.has(n));
      sharedLiterals =
        sharedLiterals === null ? [...declared.literals] : sharedLiterals.filter((l) => declared.literals.has(l));
    }
    for (const name of sharedNames ?? []) admissible.add(name);
    return { names: admissible, literals: new Set(sharedLiterals ?? []) };
  }

  /** D-2: whether this version declares what success is. Without a WHOLE
   *  contract the `outcome` column is `unknown` — a finished task is not a
   *  success [M-6] — and the shape rule lives in one place (src/manifest.ts) so
   *  the packing gate and this dashboard cannot answer differently. */
  /**
   * THE CONTRACT ITSELF, not a boolean saying one exists.
   *
   * A boolean was the defect: it told §4's `outcome` column that a definition
   * of success existed somewhere, and the column then read the verdict off
   * `records[].result` — the field the REPORTING agent fills in. The evaluator
   * receives the signed document and executes its `check` [D-2], [M-6].
   */
  private outcomeContract(manifestJson: string): OutcomeContract | null {
    try {
      return outcomeContractOf(JSON.parse(manifestJson)).contract;
    } catch {
      return null;
    }
  }

  /**
   * Everything one agent's answer is assembled from, gathered once.
   *
   * The three inputs are kept SEPARATE all the way down and are never derived
   * from one another: `views` is the registry's intent, `snapshot` is what was
   * observed, `inventory` is what is on a disk. Each carries its own window.
   */
  private fleetContext(agentId: string, workspaceId: string): FleetContext {
    const rows = assignmentsForAgents(this.db, [agentId]);
    const views = rows.map((row) =>
      assignmentView(
        row,
        headFrom(eventsOf(this.db, [row.id])),
        observedArrival(this.runtimeRecords.recordsFor(row.agent_id), subjectOf(row)),
      ),
    );
    const snapshot = this.observations.snapshotFor(agentId);
    const site = this.inventory.rootFor(agentId);
    let inventory: InventoryResult | null = null;
    let inventoryReason: string | null = site ? null : "no_inventory_root_configured";
    if (site) {
      try {
        inventory = inventoryUnder(site, agentId);
      } catch {
        inventoryReason = "inventory_root_unreadable";
      }
    }
    const index = this.markerIndex(workspaceId);
    const registered: RegisteredCapability[] = (inventory?.items ?? []).map((item) => ({
      ...item,
      skill_version_id: item.marker !== null ? (index.get(item.marker)?.skill_version_id ?? null) : null,
    }));
    // THE RUNTIME. Observed if anything was reported; otherwise the layout this
    // deployment was configured to read, which is this registry's own setting
    // and is labelled as such; otherwise unknown, and never a guess.
    const runtime: FleetRuntime | null = snapshot?.runtime ?? site?.runtime ?? null;
    const runtimeSource: EvidenceSource | "none" = snapshot ? "runtime" : site ? "registry" : "none";
    const subjects: ScanSubject[] = [];
    const seenSubject = new Set<string>();
    for (const v of views) {
      if (seenSubject.has(v.skill_version_id)) continue;
      seenSubject.add(v.skill_version_id);
      subjects.push({
        skill_version_id: v.skill_version_id,
        marker: v.arrival_marker,
        has_executable_step: v.has_executable_step,
      });
    }
    for (const r of registered) {
      if (r.skill_version_id === null || seenSubject.has(r.skill_version_id)) continue;
      seenSubject.add(r.skill_version_id);
      const known = index.get(r.marker ?? "");
      subjects.push({
        skill_version_id: r.skill_version_id,
        marker: r.marker!,
        has_executable_step: known ? shipsArrivalScript(safeManifest(known.manifest_json)) : true,
      });
    }
    const scan = scanArrivals(snapshot?.records ?? [], subjects);
    return { agentId, views, snapshot, site, inventory, inventoryReason, registered, runtime, runtimeSource, index, scan, subjects };
  }

  /** [A-1]'s row: identity, runtime, model, session, last activity, sync. */
  private agentRow(ctx: FleetContext): AgentInventoryRow {
    const principal = loadPrincipal(this.db, ctx.agentId);
    const named = this.db.prepare("SELECT name FROM agents WHERE id=?").get(ctx.agentId) as { name: string } | undefined;
    const intentActive = ctx.views.filter((v) => v.intent_state === "active").length;
    const arrivalYes = ctx.views.filter((v) => v.observed_arrival === "yes").length;
    const sync = syncStatusOf({
      observed: ctx.snapshot !== null,
      headStates: ctx.views.map((v) => v.intent_state),
      intentActive,
      arrivalYes,
    });
    const observationWindow = ctx.snapshot
      ? ctx.snapshot.window_detail
      : ctx.site
        ? "no runtime observation has been reported; the runtime below is this deployment's own configuration, not a report"
        : NO_SNAPSHOT_WINDOW;
    return {
      agent_id: ctx.agentId,
      type: principal?.type ?? "agent",
      role: principal?.role ?? null,
      name: named?.name ?? ctx.agentId,
      runtime: ctx.runtime,
      runtime_source: ctx.runtimeSource,
      model: ctx.snapshot?.model ?? null,
      session_active: ctx.snapshot?.session_active ?? "unknown",
      last_activity_ms: ctx.snapshot?.last_activity_ms ?? null,
      observation_window: observationWindow,
      observation_is: "observation",
      sync_status: sync.status,
      sync_status_is: "comparison",
      sync_status_reason: sync.reason,
      // the two columns the comparison was made FROM, published beside it so it
      // is never mistaken for a third fact [I-2]
      intent_active: countedNumber(intentActive, {
        state: "assigned",
        source: "registry",
        window: "all_time",
        window_detail: ASSIGNMENT_INTENT_SOURCE,
      }),
      observed_arrival_yes: countedNumber(arrivalYes, {
        state: "invoked",
        source: "transcript",
        window: ctx.snapshot?.window ?? "all_time",
        window_detail: ctx.snapshot?.window_detail ?? NO_SNAPSHOT_WINDOW,
      }),
    };
  }

  /**
   * `fleet.list` — who is in the fleet, and what is known about each of them.
   *
   * Strictly reading. The §4 matrix travels WITH the answer rather than being
   * assumed by whoever renders it: a reader holding one response can tell that
   * `proposed` on Codex is `unknown` by construction and not by accident.
   */
  fleetList(auth: AuthContext): FleetListResponse {
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    const agents = this.fleetAgentIds(auth).map((id) => this.agentRow(this.fleetContext(id, auth.workspace_id)));
    const observed = agents.filter((a) => a.runtime_source === "runtime").length;
    return {
      agents,
      counts: {
        agents: countedNumber(agents.length, {
          state: "assigned",
          source: "registry",
          window: "all_time",
          window_detail: "the principals of this workspace this actor may read",
        }),
        observed_agents: countedNumber(
          observed,
          {
            state: "proposed",
            source: "runtime",
            window: "all_time",
            window_detail: "principals for which at least one runtime observation has been reported",
          },
          // [I-3]: the COMPLEMENT is not stated as a figure here. A count
          // inside a reason has no state, no source and no window of its own,
          // and both numbers it would be computed from are published as number
          // cells in this very table, each carrying all three.
          observed === agents.length ? null : "not every readable principal has been observed",
        ),
      },
      runtimes: [...FLEET_RUNTIMES],
      matrix: fleetMatrixRows(),
    };
  }

  /**
   * `agent.capabilities` — [A-2] the inventory, [A-3] the six states, [A-4] the
   * gap and [A-5] the dead weight, for one agent.
   *
   * The COLUMN SET depends on the runtime and that is the point: Claude Code
   * publishes `proposed_now` and `proposed_historical`, Codex publishes one
   * `proposed` whose value is `unknown` always. They are not one table with a
   * flag, and a caller cannot render them as one.
   */
  agentCapabilities(auth: AuthContext, agentId: unknown): AgentCapabilitiesResponse {
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "agent_id (string) required");
    }
    if (!this.fleetAgentIds(auth).includes(agentId)) throw new ApiError("NOT_FOUND", "agent not found");
    const ctx = this.fleetContext(agentId, auth.workspace_id);
    const agent = this.agentRow(ctx);
    const capabilities = this.capabilityRows(ctx);
    const dead = this.deadWeightOfContext(ctx);
    return {
      agent,
      columns: ctx.runtime ? [...columnsOf(ctx.runtime)] : [],
      columns_reason: ctx.runtime
        ? null
        : "runtime_unknown: no runtime has been observed for this agent and none is configured, so which of §4's column sets applies is not established",
      capabilities,
      inventory: this.inventoryCounts(ctx),
      states: this.stateCounts(ctx, capabilities),
      undiscoverable: ctx.inventory?.undiscoverable ?? {},
      inventory_reason: ctx.inventoryReason,
      gap: ctx.views.map((v) => gapOf(v)),
      dead_weight: dead,
    };
  }

  /** `capability.get` — one capability, its matrix row and its scan rows. */
  capabilityGet(auth: AuthContext, agentId: unknown, name: unknown): CapabilityGetResponse {
    if (typeof name !== "string" || name.length === 0) throw new ApiError("INVALID_SCHEMA", "name (string) required");
    const all = this.agentCapabilities(auth, agentId);
    const capability = all.capabilities.find((c) => c.name === name);
    if (!capability) throw new ApiError("NOT_FOUND", "capability not found for this agent");
    const ctx = this.fleetContext(agentId as string, auth.workspace_id);
    return {
      agent: all.agent,
      columns: all.columns,
      columns_reason: all.columns_reason,
      capability,
      matrix: capability.runtime ? CAPABILITY_STATES.map((s) => matrixCell(s, capability.runtime!)) : [],
      scan: ctx.scan.filter((r) => r.skill_version_id === capability.skill_version_id),
      gap: all.gap.find((g) => g.skill_version_id === capability.skill_version_id) ?? null,
    };
  }

  /** One row per capability: everything on the disk, plus everything assigned. */
  private capabilityRows(ctx: FleetContext): CapabilityRow[] {
    const runtime = ctx.runtime;
    const rows: CapabilityRow[] = [];
    const claimed = new Set<string>();
    const viewByVersion = new Map(ctx.views.map((v) => [v.skill_version_id, v]));
    const rootWalked = ctx.inventory !== null;
    const registeredWindow = ctx.inventory?.window_detail ?? NO_INVENTORY_WINDOW;

    for (const item of ctx.registered) {
      const view = item.skill_version_id ? viewByVersion.get(item.skill_version_id) : undefined;
      if (item.skill_version_id) claimed.add(item.skill_version_id);
      rows.push(
        this.capabilityRow(ctx, {
          kind: item.kind,
          name: item.name,
          skill_version_id: item.skill_version_id,
          marker: item.marker,
          view,
          registered: { value: "yes", reason: null, window_detail: registeredWindow },
          runtime,
        }),
      );
    }
    for (const view of ctx.views) {
      if (claimed.has(view.skill_version_id)) continue;
      claimed.add(view.skill_version_id);
      rows.push(
        this.capabilityRow(ctx, {
          kind: "skill",
          name: view.slug,
          skill_version_id: view.skill_version_id,
          marker: view.arrival_marker,
          view,
          // a root that WAS walked and did not hold this copy answers `no`;
          // one that was never configured answers `unknown`. Collapsing the two
          // would report an unwalked disk as an empty one [I-1].
          registered: rootWalked
            ? { value: "no", reason: "not_found_under_the_inventory_root", window_detail: registeredWindow }
            : { value: "unknown", reason: ctx.inventoryReason, window_detail: NO_INVENTORY_WINDOW },
          runtime,
        }),
      );
    }
    rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return rows;
  }

  private capabilityRow(
    ctx: FleetContext,
    input: {
      kind: CapabilityKind;
      name: string;
      skill_version_id: string | null;
      marker: string | null;
      view: AssignmentView | undefined;
      registered: { value: Trivalent; reason: string | null; window_detail: string };
      runtime: FleetRuntime | null;
    },
  ): CapabilityRow {
    const known = input.marker ? ctx.index.get(input.marker) : undefined;
    const manifestJson = known?.manifest_json ?? null;
    const contract = manifestJson ? this.outcomeContract(manifestJson) : null;
    // WHAT THIS REGISTRY CAN SEE FOR ITSELF, before anything a reporter said.
    // ONE thing qualifies, and it is narrower than "a file under a root this
    // registry manages": an artifact THIS REGISTRY'S OWN ACTIVATION JOURNAL says
    // it placed. The journal's record — the target, the native relative path and
    // its last word on the managed copy — is read off the assignment view for
    // THIS capability and handed over; without one there is nothing to look for
    // and no standing to look. Everything else in the evidence a contract reads
    // is a fact about a process on the addressee's machine, which is a
    // self-report and is published as one [M-7], [D-18].
    const view = input.view;
    const placed: ActivationPlacement | null =
      view && view.activation_target !== null && view.native_relpath !== null && view.managed_copy !== "unknown"
        ? { target: view.activation_target, native_relpath: view.native_relpath, managed_copy: view.managed_copy }
        : null;
    const observedEvidence = registryObservedEvidence(this.activation.rootFor(ctx.agentId), contract, placed);
    const subject: ScanSubject = {
      skill_version_id: input.skill_version_id ?? "",
      marker: input.marker ?? "",
      has_executable_step: manifestJson ? shipsArrivalScript(safeManifest(manifestJson)) : true,
    };
    const columns = input.runtime
      ? capabilityColumns({
          runtime: input.runtime,
          subject,
          registered: input.registered,
          intent: input.view ? { state: input.view.intent_state, source: input.view.intent_state_source } : null,
          snapshot: ctx.snapshot,
          outcome_contract: contract,
          observed_evidence: observedEvidence,
          reported_by: ctx.snapshot?.reported_by ?? null,
        })
      : [];
    return {
      kind: input.kind,
      name: input.name,
      runtime: input.runtime,
      skill_version_id: input.skill_version_id,
      arrival_marker: input.marker,
      has_executable_step: subject.has_executable_step,
      columns,
    };
  }

  /** [A-2]: one number per KIND, and each of them carries its method [I-3]. */
  private inventoryCounts(ctx: FleetContext): MeasuredNumber[] {
    const out: MeasuredNumber[] = [];
    const window_detail = ctx.inventory?.window_detail ?? NO_INVENTORY_WINDOW;
    for (const kind of CAPABILITY_KINDS) {
      const a = {
        state: "registered" as const,
        source: "filesystem" as const,
        window: "all_time" as const,
        window_detail,
      };
      if (!ctx.inventory) {
        out.push(unknownNumber(a, ctx.inventoryReason ?? "no_inventory_root_configured"));
        continue;
      }
      const why = ctx.inventory.undiscoverable[kind];
      if (why !== undefined) {
        // NOT zero. A kind this adapter cannot see from a disk is `unknown`,
        // and the reason says which of the ways it cannot see it.
        out.push(unknownNumber(a, why));
        continue;
      }
      out.push(countedNumber(ctx.registered.filter((r) => r.kind === kind).length, { ...a, state: "registered" }));
    }
    return out;
  }

  /** One number per COLUMN of this runtime, counted over the capability rows. */
  private stateCounts(ctx: FleetContext, rows: readonly CapabilityRow[]): MeasuredNumber[] {
    if (!ctx.runtime) return [];
    const out: MeasuredNumber[] = [];
    for (const column of columnsOf(ctx.runtime)) {
      const cells = rows.map((r) => r.columns.find((c) => c.column === column)).filter((c): c is StateColumn => !!c);
      const first = cells[0];
      // THE STATE COMES FROM THE COLUMN'S DECLARED NAME, never from a cell that
      // happened to be built. With no capabilities there is no cell to read,
      // and a fallback would publish a number attributed to the wrong state —
      // which is what [I-3] is for. The source and the window are properties of
      // HOW the column is answered, so they are taken from the matrix and from
      // the observation's own boundary, and only the phrasing of the boundary
      // comes from a cell when there is one.
      const state = stateOfColumn(column);
      const matrix = matrixCell(state, ctx.runtime);
      const a = {
        state,
        source: (matrix.source === "none" ? "transcript" : matrix.source) as EvidenceSource,
        window:
          column === "proposed_now"
            ? ("live_session" as SelectionWindow)
            : (first?.window ?? ctx.snapshot?.window ?? ("all_time" as SelectionWindow)),
        window_detail: first?.window_detail ?? ctx.snapshot?.window_detail ?? NO_SNAPSHOT_WINDOW,
      };
      const yes = cells.filter((c) => c.value === "yes").length;
      const unknown = cells.filter((c) => c.value === "unknown").length;
      out.push(
        countedNumber(
          yes,
          a,
          unknown === 0
            ? null
            : `${unknown} of ${cells.length} capabilities answer \`unknown\` for this column — unobserved, NOT known to be absent [I-1]`,
        ),
      );
    }
    return out;
  }

  /**
   * `observation.report` — A WRITE, although the V-1 requirements list it
   * among the READING surfaces.
   *
   * THE LIST IS FOLLOWED WHERE IT CAN BE AND CONTRADICTED WHERE IT CANNOT. A
   * self-report by [M-7] is an agent TELLING this registry something, and
   * telling is storing: this call appends to two INSERT-only tables and moves
   * the observation column of every deployment of that agent. [I-8] requires a
   * tool's hints to be TRUE, and a `readOnlyHint: true` on a call that writes is
   * a false hint that a client will act on by not asking. So the tool is
   * annotated as a write, and the divergence from that list is stated rather
   * than papered over.
   *
   * The permission is the §6.2 `report_outcome` grant — the step of the loop
   * this is, and no new role.
   *
   * [I-7]: THE TEXT OF A RECORD DOES NOT SURVIVE THIS BOUNDARY, and there are
   * two separate reasons for that rather than one.
   *
   *   * A record's `text` is reduced to §5 markers HERE, before anything else
   *     reads it, and the text is not stored, not logged and not echoed. What
   *     comes back is how many markers were kept and how many records were
   *     examined.
   *
   *   * AND THE `evidence` OBJECT IS NOT A WAY ROUND THAT. This sentence used to
   *     stop at the paragraph above while `evidenceOf` accepted any string of
   *     any content under any admitted name, so a reviewer stored a secret under
   *     the contract's own `stdout` and a transcript goes the same way. A value
   *     is now a boolean, a safe integer, a digest of fixed form, or a literal
   *     the SIGNED check itself names — free text is refused under every name,
   *     the contract's own included. That is WHY the text does not reach the
   *     journal, and it is enforced in `isAdmissibleEvidenceValue` rather than
   *     asserted here.
   */
  reportObservation(
    auth: AuthContext,
    input: unknown,
    idempotencyKey?: string,
  ): IdempotentOutcome<ObservationReportResponse> {
    return withIdempotency(this.db, auth.agent_id, "observation.report", idempotencyKey, this.now(), () =>
      this.reportObservationInner(auth, input),
    );
  }

  private reportObservationInner(auth: AuthContext, raw: unknown): ObservationReportResponse {
    if (auth.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    const input = (raw ?? {}) as Record<string, unknown>;
    const agentId = input.agent_id;
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new ApiError("INVALID_SCHEMA", "agent_id (string) required");
    }
    const subject = loadPrincipal(this.db, agentId);
    if (!subject || subject.workspace_id !== auth.workspace_id) throw new ApiError("NOT_FOUND", "agent not found");
    if (!isFleetRuntime(input.runtime)) {
      throw new ApiError("INVALID_SCHEMA", `runtime must be one of ${FLEET_RUNTIMES.join("|")}`);
    }
    if (!isSelectionWindow(input.window)) {
      throw new ApiError("INVALID_SCHEMA", `window must be one of ${SELECTION_WINDOWS.join("|")}`);
    }
    const windowDetail = input.window_detail;
    if (typeof windowDetail !== "string" || windowDetail.length === 0 || windowDetail.length > 500) {
      // [I-3]: a report with no boundary is a number with no method, and it is
      // refused rather than given a default that would describe the wrong search
      throw new ApiError("INVALID_SCHEMA", "window_detail (1..500 chars) required: a report states what it looked at");
    }
    const model = input.model === undefined || input.model === null ? null : String(input.model).slice(0, 200);
    const sessionActive =
      input.session_active === undefined || input.session_active === null ? null : input.session_active === true;
    const lastActivity =
      Number.isInteger(input.last_activity_ms) && (input.last_activity_ms as number) > 0
        ? (input.last_activity_ms as number)
        : null;
    const rawRecords = input.records === undefined ? [] : input.records;
    if (!Array.isArray(rawRecords)) throw new ApiError("INVALID_SCHEMA", "records must be an array");
    if (rawRecords.length > 5000) throw new ApiError("LIMIT_EXCEEDED", "a report carries at most 5000 records");

    // THE VERSIONS THIS WORKSPACE HOLDS, BY MARKER — read once, because [I-7]'s
    // admissible set of evidence names is the SIGNED contract's and a record
    // names its version by nothing but its marker.
    const index = this.markerIndex(auth.workspace_id);
    const declaredNames = new Map<string, SignedEvidenceTerms | null>();

    const reduced: Array<Omit<ObservedRecord, "agent_id" | "runtime">> = [];
    for (const item of rawRecords) {
      const r = (item ?? {}) as Record<string, unknown>;
      const role = r.role;
      if (role !== "proposal" && role !== "call" && role !== "output") {
        throw new ApiError("INVALID_SCHEMA", "records[].role must be proposal|call|output");
      }
      // THE REDUCTION. Whatever the reporter sent as text, only markers survive
      // it, and the text is referenced nowhere below this line [I-7].
      const markers = typeof r.text === "string" ? markersIn(r.text) : [];
      const declared = typeof r.marker === "string" ? markersIn(r.marker) : [];
      const all = [...new Set([...markers, ...declared])];
      const callId =
        typeof r.call_id === "string" && r.call_id.length > 0 && r.call_id.length <= 200 ? r.call_id : null;
      const atMs = Number.isInteger(r.at_ms) && (r.at_ms as number) > 0 ? (r.at_ms as number) : null;

      // A VERDICT IS NOT A THING A PRINCIPAL MAY STATE ON ITS OWN [M-6], [D-2].
      //
      // `result` used to be taken as written and §4's `outcome` column printed
      // it, so the holder of a `report_outcome` grant declared its own success.
      // A report may still SAY what it observed — that is what a self-report is
      // — but a stated `success` or `failure` must arrive WITH THE EVIDENCE
      // that establishes it, and the evidence, not the word, is what the
      // contract's `check` is executed against. A word with no working is
      // refused here rather than stored and quietly ignored downstream: a
      // reporter that believes its verdict was recorded would otherwise never
      // learn that nothing read it.
      // …AND THE VALUES ARE MARKED AS A PRINCIPAL'S HERE, at the point they are
      // accepted, before anything evaluates them (2.1). What arrives on this
      // surface is what an agent says about a machine this registry cannot
      // reach, and the mark travels with it to the column that publishes it —
      // so the attribution of the verdict is a fact about WHERE THE DATA CAME
      // FROM and never about which branch of the assessor happened to run.
      const evidence = selfReported(evidenceOf(r.evidence, this.admissibleEvidenceNames(index, all, declaredNames)));
      const stated = r.result === "success" || r.result === "failure";
      if (stated && evidence === null) {
        throw new ApiError(
          "INVALID_SCHEMA",
          "records[].result states an outcome, so records[].evidence (an object of named values) is required: " +
            "the registry executes the version's signed `outcome_contract` against the evidence and never takes a verdict on a principal's word (D-2, [M-6])",
        );
      }
      const result = stated ? (r.result as "success" | "failure") : "unknown";
      for (const marker of all) reduced.push({ role, call_id: callId, at_ms: atMs, marker, result, evidence });
    }

    const actorRow = loadPrincipal(this.db, auth.agent_id);
    if (!actorRow || actorRow.role === null) throw new ApiError("FORBIDDEN", "workspace membership required");
    const reportedBy: GrantPrincipal = { agent_id: actorRow.id, type: actorRow.type, role: actorRow.role };
    const grant = findGrant(this.db, actorRow.id, "report_outcome", "local_agent");
    if (!grant) {
      throw new ApiError("FORBIDDEN", "this principal holds no `report_outcome` grant scoped to `local_agent` (§6.2)");
    }
    const now = this.now();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    let written: { observation_id: string };
    try {
      written = recordObservationInTx(db, {
        agentId,
        runtime: input.runtime as FleetRuntime,
        model,
        sessionActive,
        lastActivityMs: lastActivity,
        window: input.window as SelectionWindow,
        windowDetail,
        proposalInventoryComplete: input.proposal_inventory_complete === true,
        records: reduced,
        reportedBy,
        grantId: grant.id,
        idempotencyKey: `observation:${ulid(now)}`,
        nowMs: now,
      });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return {
      observation_id: written.observation_id,
      agent_id: agentId,
      runtime: input.runtime as FleetRuntime,
      /** how many records the reporter examined, and how many markers survived */
      records_examined: rawRecords.length,
      markers_recorded: reduced.length,
      window: input.window as SelectionWindow,
      window_detail: windowDetail,
      records_text_stored: false,
      note: OBSERVATION_REPORT_NOTE,
    };
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
    // `transferred` is the one non-empty state a handover is still legal from,
    // and it is legal precisely BECAUSE a transfer handed nothing over (§5.4):
    // a sender recorded an intent, and this call is the recipient fetching the
    // package that intent is about. Every other non-empty state means the
    // handover already happened.
    // `requested` joins `transferred` here for the same reason: it is the event
    // that OPENED this chain, it handed nothing over, and this call is the
    // recipient fetching the package its own request is about.
    const already = derivedState(this.db, receipt.id);
    if (already !== "none" && already !== "transferred" && already !== "requested") {
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
    // §5.4: `transferred` is a receipt event and is NOT one of this surface's.
    // It records a sender's decision and is written by the registry on that
    // sender's authority; an adopter appending it here would be naming its own
    // recipient on the row the migration counter reads. Refused by name, so the
    // caller is told which vocabulary this step speaks rather than being given a
    // transition error about a state machine it was never in.
    if (!(ADOPTER_EVENTS as readonly unknown[]).includes((input ?? {}).event)) {
      throw new ApiError("INVALID_SCHEMA", `event must be one of ${ADOPTER_EVENTS.join("|")}`);
    }
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


/** §6's rating half of the trust threshold: a score on the 1–5 `ratings` scale. */
/**
 * The named values a report presents, or `null`.
 *
 * WHAT THE DEFECT WAS, because the shape of it is the argument for the fix.
 * This function used to take ANY name of 1 to 80 characters and store the
 * object as written. A reviewer went through the shipped `/v1/observations`
 * surface with a secret-shaped name and a field called `extra_transcript`, and
 * both were written into `observed_records.evidence` word for word. The bound
 * on length and the bound on depth are not a bound on WHAT: an arbitrary
 * key-value store had been opened inside a table whose whole point [I-7] is
 * that a record's text does not survive this boundary.
 *
 * SO THE SET OF NAMES HAS A SOURCE, AND THE SOURCE IS THE CONTRACT.
 * `terms.names` is `EVIDENCE_NAMES` — the values this registry's four checks
 * read, derived in `src/outcome.ts` from the check table itself — plus the names
 * the SIGNED `outcome_contract.evidence` of the version the record's marker
 * names declares. A name outside that set is `INVALID_SCHEMA` and nothing is
 * written.
 *
 * AND SO DOES THE SET OF VALUES, WHICH IS WHAT ROUND 6 LEFT OPEN. Closing the
 * names and leaving the values as "any scalar" was a key-value store with a
 * vocabulary: a reviewer stored `sk-live-…` under the contract's own `stdout`,
 * word for word, and a whole transcript goes the same way under any name at
 * all. A value is now a BOOLEAN, a SAFE INTEGER, a DIGEST of fixed form, or one
 * of the literals THE SIGNED CHECK ITSELF NAMES — or a bounded list of those.
 * The rule lives in `isAdmissibleEvidenceValue` (`src/outcome.ts`), in one
 * place, so this boundary and the checks that read a value cannot disagree.
 *
 * FAIL CLOSED WHERE THE CONTRACT CANNOT BE READ. A marker of no version this
 * workspace holds, a stored manifest that does not hash to what was signed, a
 * manifest with no usable contract: in every one of those the names are
 * `EVIDENCE_NAMES` and the enumeration of literals is EMPTY, so only booleans,
 * integers and digests pass. The alternative — admit it and sort it out later —
 * is how the reviewer's field got in.
 *
 * A value outside the grammar is REFUSED rather than truncated, and an oversized
 * object is refused rather than trimmed: evidence this registry edited would not
 * be the evidence the run produced.
 *
 * THE REFUSAL NAMES THE ADMISSIBLE SET AND NEVER THE REJECTED NAME OR VALUE. An
 * error message is a thing that gets logged, and what a caller chose to send may
 * be the very material [I-7] exists to keep out of this process's output.
 */
const EVIDENCE_LIMIT = 4000;

/** What one version's SIGNED contract permits: the names a run may present, and
 *  the literals a run may echo. Read together, from one manifest, in one pass. */
interface SignedEvidenceTerms {
  names: ReadonlySet<string>;
  literals: ReadonlySet<string>;
}

function evidenceOf(raw: unknown, terms: SignedEvidenceTerms): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("INVALID_SCHEMA", "records[].evidence must be an object of named values");
  }
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!terms.names.has(name)) {
      throw new ApiError(
        "INVALID_SCHEMA",
        "records[].evidence names a value no contract asked for. The admissible names are the ones this registry's checks read " +
          `(${[...EVIDENCE_NAMES].join(", ")}) plus the names the signed \`outcome_contract.evidence\` of the version this record's ` +
          "marker identifies declares; where no contract can be read, only the first list applies. The rejected name is not repeated " +
          "here: a name a caller chose is not a thing this registry writes to its own output [I-7]",
      );
    }
    if (!isAdmissibleEvidenceValue(value, terms.literals)) {
      throw new ApiError(
        "INVALID_SCHEMA",
        `records[].evidence.${name} is not a value this journal carries. A named value is a boolean, a safe integer, a digest of ` +
          `the form sha256:<64 lowercase hex>, or one of the literals the SIGNED \`outcome_contract.check\` itself names — or a ` +
          `list of at most ${EVIDENCE_LIST_MAX} of those. Free text is refused under EVERY name, the contract's own included: text ` +
          "in this journal is a transcript however the field is called [I-7]. The rejected value is not repeated here",
      );
    }
    out[name] = value;
  }
  if (Object.keys(out).length === 0) return null;
  const encoded = JSON.stringify(out);
  if (encoded.length > EVIDENCE_LIMIT) {
    throw new ApiError("LIMIT_EXCEEDED", `records[].evidence is at most ${EVIDENCE_LIMIT} bytes encoded`);
  }
  return out;
}

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
  // ONE CODEC, in `src/cursor.ts`, because `auditDashboardPayload` decodes the
  // same token to answer whether a `next_cursor` on a payload is an opaque
  // machine value; two implementations of the shape would be a guard agreeing
  // with itself.
  const decoded = decodeCursor(cursor);
  if (decoded === null) throw new ApiError("INVALID_SCHEMA", "malformed cursor");
  return decoded;
}

function encodeCursor(row: VersionRow): string {
  return encodeCursorToken({ ms: row.created_at_ms, id: row.id });
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
