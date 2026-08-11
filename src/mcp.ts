// MCP adapter — thin JSON-RPC tool dispatch over the SAME service functions
// the REST adapter uses (§2: adapters contain no logic; §6: ACL and error
// model enforced identically on REST and MCP). Transport: streamable HTTP —
// POST one JSON-RPC message, receive one JSON response (mounted in http.ts).
import type { Registry, SearchParams } from "./service.ts";
import type { AuthContext } from "./auth.ts";
import { ApiError, isApiError } from "./errors.ts";
import { renderDashboard, parseDashboardFormat } from "./dashboard.ts";
import { VERSION } from "./version.ts";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

export const MCP_TOOLS = [
  {
    name: "skill.create",
    description:
      "Create a skill (idempotent on workspace+slug) and a new version in draft from a §4.1b package archive.",
    // [I-8]: a WRITE. It creates a skill and a draft version and appends to
    // the transparency log. `destructiveHint` is FALSE because every one of
    // those is an INSERT — nothing that already existed is changed or removed,
    // which is what the protocol calls additive. `idempotentHint` is true:
    // sending the same source again converges on the skill and version already
    // created from it, so a repeat adds nothing.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        skill_id: { type: "string" },
        archive_base64: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["archive_base64"],
    },
  },
  {
    name: "skill.create_from_dir",
    description:
      "Surface 14: pack, sign and create a version from a SOURCE tree (`manifest.json` + `SKILL.md` + files) in one call. The registry mints the version id, derives the §5 arrival marker from it, writes the marker into `SKILL.md` and `scripts/skln-arrive.sh`, computes §4.3 `integrity` over those bytes and signs with a system-held key it generates on first use. The manifest MUST declare an `outcome_contract` (`check`/`evidence`/`unknown`) — what success is for this skill — and that declaration rides inside the signature, so redefining success means issuing a new version; a source without one is refused before anything is written. No seed, no kid, no hand-written `integrity`, no packing step: the caller supplies no cryptographic material at all, and none is returned. The source archive is bytes the CLIENT read from its own directory — the registry never opens a path a caller names.",
    // [I-8]: every tool is one step of the loop, and this one WRITES. It mints
    // a version, generates a signing key on first use and appends to the
    // transparency log, so `readOnlyHint` is false. `destructiveHint` is FALSE
    // and that is a measured fact, not a courtesy: every row it writes is new,
    // and it changes nothing that was already there. `idempotentHint` is true:
    // resubmitting the SAME source converges on the version already packed from
    // it and writes nothing further. `openWorldHint` is false — it touches this
    // registry and nothing else.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        skill_id: { type: "string" },
        source_base64: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["source_base64"],
    },
  },
  {
    name: "skill.lint",
    description: "Run the §7.1 gates on a version; draft transitions to linted iff zero FAIL.",
    // [I-8]: a WRITE, and one that is easy to mistake for a read. Running the
    // §7.1 gates TRANSITIONS the version from `draft` to `linted` when they all
    // pass, and that transition is a recorded fact about a version other
    // callers can see — a change to a row that already existed, so
    // `destructiveHint` is true. `idempotentHint` is FALSE: running the gates
    // again files a second gate run, which is a new set of rows every time.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { skill_version_id: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["skill_version_id"],
    },
  },
  {
    name: "skill.verify",
    description:
      "Surface 4, both forms (Appendix H): with skill_version_id, the registry checks the §5.1 verified-gate conjunction and transitions; with archive_base64, the stateless §4.4 verification of an uploaded package.",
    // [I-8]: a WRITE in one of its two forms, so the hint is false for both.
    // With `skill_version_id` it checks the §5.1 conjunction and TRANSITIONS the
    // version; with `archive_base64` it verifies uploaded bytes and changes
    // nothing. A single tool whose hint were true for one form and false for the
    // other would be a hint a client cannot act on, so it takes the honest
    // reading of the pair: this tool may write.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        archive_base64: { type: "string" },
        idempotency_key: { type: "string" },
      },
    },
  },
  {
    name: "skill.search",
    description: "Search skills; results filtered by §5.1 visibility × access policy.",
    // [I-8]: a READ. It filters by §5.1 visibility × access policy and appends
    // nothing; a client may call it without an approval prompt.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        capability: { type: "string" },
        runtime: { type: "string" },
        tool: { type: "string" },
        risk: { type: "string" },
        state: { type: "string" },
        min_adopted: { type: "number" },
        min_rating: { type: "number" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "skill.review.request",
    description:
      "Surface 3: request review, or record a reviewer verdict. An approve verdict atomically writes the reviewer attestation.",
    // [I-8]: a WRITE. It records a review request or a reviewer's verdict, and
    // an approving verdict atomically writes the reviewer attestation. Both are
    // INSERTs, so `destructiveHint` is false; both happen AGAIN on a repeat, so
    // `idempotentHint` is false.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        action: { type: "string" },
        verdict: { type: "string" },
        note: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id", "action"],
    },
  },
  {
    name: "skill.publish",
    description:
      "Surface 12: publish a `verified` version — the §4.3.8 registry countersign is appended in the same transaction. Requires workspace role admin/owner; a version the §7.3 matrix flags needs a human `publish` approval first. Republishing is a noop.",
    // [I-8]: a WRITE — the §5.1 state transition to `published`.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id"],
    },
  },
  {
    name: "skill.supersede",
    description: "Surface 10: link a successor version; both versions' lifecycle fields move atomically and are transparency-logged.",
    // [I-8]: a WRITE. It supersedes one version by another, which is a
    // statement about the older version that cannot be taken back.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        successor_version_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id", "successor_version_id"],
    },
  },
  {
    name: "skill.deprecate",
    description:
      "Surface 13: deprecate a published version. It stays visible and adoptable with a warning (§5.1); the registry stamps `deprecation_date` and transparency-logs the retirement. Author, skill owner or workspace admin/owner.",
    // [I-8]: a WRITE — the transition to `deprecated`.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id"],
    },
  },
  {
    name: "skill.revoke",
    description: "Surface 11: revoke a published version with a reason; immediate effect on skill.verify verdicts and search.",
    // [I-8]: a WRITE, and the most destructive of them: a revoked version is
    // withdrawn and the state is terminal.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        reason: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id", "reason"],
    },
  },
  {
    name: "skill.approve",
    description:
      "§7.3 human-approval matrix: record an approval decision. Requires agents.type='human' with workspace role admin/owner; adopt_high_risk binds one exact adoption_request_id.",
    // [I-8]: a WRITE. It records a §7.3 human approval decision in the approval
    // journal, and a recorded decision is not withdrawn by calling again — an
    // INSERT, so `destructiveHint` is false. `idempotentHint` is FALSE: a
    // `publish`-scope decision is not unique per version, so calling twice
    // records the decision twice.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        scope: { type: "string" },
        decision: { type: "string" },
        adoption_request_id: { type: "string" },
        note: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id", "scope", "decision"],
    },
  },
  {
    name: "skill.request_adoption",
    description:
      "Surface 6: create an adoption request + receipt shell. A §7.3 condition holds the request in approval_pending until a human approval names it.",
    // [I-8]: a WRITE. It opens an adoption request, its receipt shell and the
    // `requested` event that names the recipient — three INSERTs, so
    // `destructiveHint` is false. `idempotentHint` is FALSE: without an
    // `idempotency_key` a second call opens a SECOND chain, which is a thing an
    // adopter may genuinely mean and a client must not be told is free.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { skill_version_id: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["skill_version_id"],
    },
  },
  {
    name: "skill.adopt",
    description:
      "Surface 7: adopter-side compatibility check, then package handover and the `delivered` receipt event. The request's adopter only.",
    // [I-8]: a WRITE. It appends to the INSERT-only receipt journal, and an
    // appended event cannot be withdrawn. `destructiveHint` is TRUE — the
    // handover also moves the adoption REQUEST row, which already existed.
    // `idempotentHint` is true: the chain has begun, and a second call is
    // refused without writing.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        adoption_request_id: { type: "string" },
        environment_descriptor: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["adoption_request_id", "environment_descriptor"],
    },
  },
  {
    name: "skill.validate_outcome",
    description:
      "Surface 8: append attempted/adopted/failed/rolled_back to your own receipt, per the §5.3 table. `adopted` requires evidence matching the declared validation gates.",
    // [I-8]: a WRITE. It appends the terminal outcome event to a receipt chain
    // — an INSERT into an INSERT-only journal, so `destructiveHint` is false,
    // and a repeat is refused by the §5.3 table without writing, so
    // `idempotentHint` is true.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        receipt_id: { type: "string" },
        event: { type: "string" },
        evidence: { type: "object" },
        failure_report: { type: "object" },
        rollback_report: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["receipt_id", "event"],
    },
  },
  {
    name: "skill.rate",
    description: "Surface 9: rate a version. Requires one of your own receipts whose terminal event is `adopted`.",
    // [I-8]: a WRITE. A rating is bound to a closed adoption receipt and
    // recorded against the version — an INSERT, and one per (version, rater),
    // so a repeat is refused without writing: additive and idempotent.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        score: { type: "number" },
        note: { type: "string" },
        adoption_receipt_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id", "score", "adoption_receipt_id"],
    },
  },
  {
    name: "skill.transfer",
    description:
      "Surface 15: transfer a version to a NAMED, TYPED recipient — `recipient` is `{kind,ref}` and has no default. `kind` is `local_agent` (carried out) or `remote_fleet` (declared by §5.4 and NOT implemented in V-1: refused with NOT_IMPLEMENTED after the permission is checked, never silently treated as local). The sender must hold an `assign` grant scoped to that recipient kind (§6.2). It records the transfer, opens the recipient's adoption request and receipt, and writes ONE `transferred` receipt event carrying the recipient. It is an INTENT and reports one: the answer carries `observed_state:\"unknown\"` beside it, because nothing has been observed at the recipient — a transfer never says a skill was installed, is running, or is active.",
    // [I-8]: one step of the loop, and this one WRITES. It opens a receipt
    // chain and appends to the INSERT-only journal, so `readOnlyHint` is false.
    //
    // `idempotentHint` IS FALSE, and the previous value of this field is the
    // reason the sweep beside it exists. It said `true`, and the comment under
    // it said, in the same breath, that repeating the call without an
    // `idempotency_key` records a second transfer. Both statements shipped. The
    // protocol's `idempotentHint` means exactly one thing — repeating the call
    // with the same arguments has no additional effect — and a second transfer
    // is an additional effect, so the hint was false and the comment beside it
    // was the proof. A client acting on `true` retries and moves the version
    // twice.
    //
    // `destructiveHint` is false: every row this writes is new. `openWorldHint`
    // is false — V-1 reaches nothing outside this registry, which is precisely
    // why `remote_fleet` refuses.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        skill_version_id: { type: "string" },
        recipient: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["local_agent", "remote_fleet"] },
            ref: { type: "string" },
          },
          required: ["kind", "ref"],
        },
        idempotency_key: { type: "string" },
      },
      required: ["skill_version_id", "recipient"],
    },
  },
  {
    name: "transfer_grant.create",
    description:
      "§6.2: grant one principal one step of the transfer loop towards one KIND of recipient — the triple (agent, action, recipient scope). `action` ∈ receive|assign|activate|revoke|report_outcome, a closed list; `recipient_scope` ∈ local_agent|remote_fleet, the same closed list `skill.transfer` uses. It introduces NO workspace role: the roles and principal types of the schema are untouched and approvals still stand on them. Requires admin/owner of the grantee's workspace. Re-issuing the same triple converges on the recorded grant.",
    // A write: it creates a capability. The read half is `transfer_grant.list`
    // and the two are separate steps, never one tool with a mode argument. The
    // triple (agent, action, scope) is unique, so a repeat is refused without
    // writing — additive, and idempotent.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        action: { type: "string", enum: ["receive", "assign", "activate", "revoke", "report_outcome"] },
        recipient_scope: { type: "string", enum: ["local_agent", "remote_fleet"] },
        idempotency_key: { type: "string" },
      },
      required: ["agent_id", "action", "recipient_scope"],
    },
  },
  {
    name: "transfer_grant.list",
    description:
      "§6.2: the transfer grants this actor may read — its own, or the workspace's for an admin/owner. Every row names the principal that issued it WITH its type and role as recorded, so `granted by the owner in person` and `granted by an agent holding an administrative role` are never the same answer. Read-only: it grants nothing.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "assignment.activate",
    description:
      "§5.5: materialize a deployment's managed copy in the runtime's NATIVE location and record that Skillonomia believes it activated it. The activation ROOT is deployment configuration, never a call argument: with no root configured this writes nothing anywhere and records `queued`. With one configured it writes the package under `<root>/<native location>` for the configured target (Claude Code personal/project/plugin, or Codex `.agents/skills/<name>/SKILL.md`), reads the entry file back FROM there, and only then records `active`. `active` is SKILLONOMIA'S INTENT and is labelled as one on every row: the answer carries the observed arrival as a SEPARATE column, and that column stays `unknown` until a runtime record carrying this version's §5 marker exists — a file on disk is not a run. Requires an `activate` grant scoped to the assignment's recipient kind (§6.2). Re-activating an unchanged copy is a convergent noop; one that has drifted is recorded as `drifted` and rewritten.",
    // [I-8]: one step of the loop, and it WRITES — to this registry's journal
    // and to a filesystem that is not this registry's. `openWorldHint` is TRUE
    // for exactly that reason and is the honest difference from every other
    // tool here: `skill.transfer` reaches nothing outside the registry, and
    // this one does.
    //
    // `destructiveHint` IS TRUE, and the previous value of this field is why
    // this comment is long. It said FALSE, on the ground that this call only
    // INSERTS rows — true of the database and beside the point. Activation
    // ends in `src/activation.ts` at `rmSync(target, { force: true })` and
    // `writeFileSync(target, bytes)`: on a copy that has DRIFTED, that unlinks
    // a file in a runtime's own directory and writes different bytes over its
    // name. MCP's word is "destructive updates to its ENVIRONMENT", and this
    // tool's environment includes a disk this registry does not own. A client
    // told `false` here is a client told not to ask before something on its
    // machine is overwritten.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { assignment_id: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["assignment_id"],
    },
  },
  {
    name: "assignment.pause",
    description:
      "§5.5: suspend a deployment — the managed copy is taken out of the native location and the assignment stays, so it can be activated again. Requires a `revoke` grant scoped to the assignment's recipient kind (§6.2): pausing and revoking exercise the same capability on the runtime and differ only in whether the deployment can be resumed. The answer states what became of the copy — `removed`, `absent` or `retained`, never a bare success — and states that a new session is required before the withdrawal changes what an agent is working from. It does NOT claim that an agent which has already read these instructions no longer has them.",
    // [I-8]: `destructiveHint` is TRUE. Withdrawing a deployment runs
    // `removeManaged`, which ends at `rmSync(dir, { recursive: true, force:
    // true })` — a directory on somebody else's disk and everything under it.
    // That the assignment row is only APPENDED to is a fact about the journal,
    // not about the environment, and the two are not the same measurement.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { assignment_id: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["assignment_id"],
    },
  },
  {
    name: "assignment.revoke",
    description:
      "§5.5: end a deployment and take the managed copy out of the native location. Terminal: a revoked assignment is not resumed, and handing the skill over again is a fresh push. Requires a `revoke` grant scoped to the assignment's recipient kind (§6.2). The answer states what became of the copy — `removed`, `absent` or `retained` (a copy that is still there because the registry could not reach it) — and carries the limit of the operation in words: removing a file does not reach into a session that has already loaded the skill, so a new session is required before the withdrawal has any effect on what that agent is working from.",
    // [I-8]: `destructiveHint` is TRUE, for the reason `assignment.pause`
    // gives — the same `removeManaged`, the same recursive removal.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { assignment_id: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["assignment_id"],
    },
  },
  {
    name: "assignment.list",
    description:
      "§5.5: the deployments this actor may read — its own, or the workspace's for an admin/owner. Every row carries TWO COLUMNS that are never merged: `intent_state` (what Skillonomia decided, read from the INSERT-only assignment journal, labelled `intent`) and `observed_arrival` (what a runtime record showed, computed only from the §5 arrival marker on a paired call/output record, `yes` or `unknown` and never `no`). Each states its own source and selection window, so no cell is a bare value. A version declaring `runtime.shell: [\"none\"]` reports `unknown` with the reason `no_executable_step`, which is machine-distinguishable from `no_paired_record`. Read-only: it activates nothing and changes nothing. It does READ outside this registry: the answer carries a native inventory count taken by walking the configured activation roots, symbolic links followed, and `openWorldHint` is true for that walk.",
    // [I-8]: a READ that nonetheless reaches a foreign disk. `openWorldHint`
    // said FALSE until a sweep that watched the FILESYSTEM as well as the
    // tables caught it: this call walks every configured activation root to
    // publish `inventory.skill_files`. The comment on `fleet.list` below used
    // to draw its own honest hint as a CONTRAST with this tool, which made a
    // false statement here into a justification there — one wrong hint holding
    // a right one up for the wrong reason.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fleet.list",
    description:
      "§6 part A: the fleet inventory — one row per principal this actor may read, carrying its identity and type as recorded, the runtime it was OBSERVED on (or the one this deployment is configured to read, labelled as configuration), its model, whether a session is active, when it was last active, and a synchronisation status of `in_sync|pending|drifted|failed|unknown`. Every one of those is three-valued: `unknown` is a VALUE and is never rendered as `no`, because the absence of a record is not the absence of a fact. The answer also publishes §4's state × runtime MATRIX itself, which is ASYMMETRIC: Claude Code splits `proposed` into `proposed_now` and `proposed_historical`, Codex has one `proposed` whose value is `unknown` ALWAYS, and `loaded` is shown as an explicit column on neither. Read-only: it writes nothing and observes nothing on its own. It does WALK a fleet member's configured inventory root while assembling each row, which is why `openWorldHint` is true.",
    // [I-8]: one step of the loop, and this one READS. `openWorldHint` is TRUE
    // because this surface walks a filesystem that is not this registry's — a
    // fleet member's own directory, reached through whatever links it contains.
    // `assignment.activate` carries the same hint for writing into that
    // filesystem; reading it is a smaller act, not a different KIND of act, and
    // a client deciding whether to ask deserves to know which of its machines
    // is being touched.
    //
    // The reason is stated here on its own terms and NOT as a contrast with
    // `assignment.list`, which is how it was written before: that tool walks a
    // foreign disk too, so the contrast was false, and a hint justified by a
    // comparison is a hint that goes wrong when the thing compared with does.
    // A black-box sweep cannot catch this one by its ANSWER, either — the walk
    // feeds nothing that reaches this payload — so the guard grades it ASKED
    // and says so rather than claiming a proof it does not have.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent.capabilities",
    description:
      "§6 part A: one agent's capabilities — skills, plugins, MCP servers, MCP tools and connectors — each with §4's six states as SEPARATE COLUMNS, and the column set is the one ITS RUNTIME publishes rather than a shared table with flags. Every cell carries three attributes and is published with none of them missing: which STATE it is about, which SOURCE it was read from (`filesystem|registry|runtime|transcript`) and which SELECTION WINDOW it was taken over (`live_session|period|all_time`). `assigned` is Skillonomia's INTENT and is labelled `intent`; every other column is an observation and is labelled `observation`; the two are never merged and neither is computed from the other. The inventory counts follow SYMBOLIC LINKS, because a shared skill library is normally handed to a fleet through one and a walk that stops at the link undercounts it silently. A count that could not be taken is `unknown` WITH A REASON and never a silent `0`. The answer also carries the intent-versus-fact gap and the DEAD WEIGHT slice: what is registered and has never once been demonstrated to run. Read-only.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
    },
  },
  {
    name: "capability.get",
    description:
      "§6 part A: one capability of one agent, with §4's matrix row for its runtime — what that runtime CAN and CANNOT report — and the scanner's tuples for it: `(skill version, agent, runtime, time, call_id, result)`. A tuple exists ONLY where a PAIRED call/output record sharing one `call_id` carried THIS version's §5 arrival marker: a lone call, a lone output, or a pair carrying another version's marker produces nothing, and a capability with no tuple is `unknown`, never `no`. A version declaring `runtime.shell: [\"none\"]` ships nothing that can print its marker, so its answer is `unknown` with the machine-distinguishable reason `no_executable_step`. Read-only.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" }, name: { type: "string" } },
      required: ["agent_id", "name"],
    },
  },
  {
    name: "observation.report",
    description:
      "§6 part A: file what was OBSERVED at one agent's runtime — the model, whether a session is live, when it was last active, and the runtime records themselves. THIS TOOL WRITES. The V-1 requirements list it among the READING surfaces and that classification is contradicted here deliberately: a self-report is an agent telling this registry something, telling is storing, and this call appends to two INSERT-only tables and moves the observation column of every deployment of that agent. [I-8] requires a tool's hints to be TRUE, and `readOnlyHint: true` on a call that writes is a false hint a client acts on by not asking. Requires a `report_outcome` grant scoped to `local_agent` (§6.2). `window` and `window_detail` are REQUIRED: a report that does not say what it looked at is a number with no method [I-3], and it is refused rather than given a default. The records' TEXT is reduced to §5 arrival markers at this boundary and is NOT stored, logged or returned [I-7]. A report can establish that a version RAN; it can never establish that one did not.",
    // [I-8]: one step of the loop — `report_outcome` — and it WRITES. The hints
    // say so. `destructiveHint` is FALSE: the tables are INSERT-only, so a filed
    // report cannot be withdrawn AND cannot disturb one already filed, which is
    // the protocol's "additive" exactly. `idempotentHint` is false — filing the
    // same report twice files it twice. `openWorldHint` is false because this
    // call reaches nothing outside this registry — the reporter did the
    // reaching, and what crosses this boundary is its account of it.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        runtime: { type: "string", enum: ["claude_code", "codex"] },
        model: { type: "string" },
        session_active: { type: "boolean" },
        last_activity_ms: { type: "number" },
        window: { type: "string", enum: ["live_session", "period", "all_time"] },
        window_detail: { type: "string" },
        proposal_inventory_complete: { type: "boolean" },
        records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["proposal", "call", "output"] },
              call_id: { type: "string" },
              at_ms: { type: "number" },
              marker: { type: "string" },
              text: { type: "string" },
              result: { type: "string", enum: ["success", "failure", "unknown"] },
            },
            required: ["role"],
          },
        },
        idempotency_key: { type: "string" },
      },
      required: ["agent_id", "runtime", "window", "window_detail"],
    },
  },
  {
    name: "principal.create",
    description:
      "Provisioning: create a principal (agent, human or service) in the caller's workspace with a workspace role, and issue its API key. Requires role admin/owner (§6 manage-memberships row); the new role may not outrank the caller's. The api_key is returned EXACTLY ONCE and is never retrievable — this call takes no idempotency_key, because a replay would have to persist that secret.",
    // [I-8]: a WRITE. It creates a principal and its workspace membership —
    // two INSERTs, so `destructiveHint` is false. `idempotentHint` is true, and
    // for a reason worth stating rather than assuming: this call takes no
    // `idempotency_key`, but a NAME is unique within a workspace, so a repeat
    // with the same arguments is refused and writes nothing. Change the name
    // and it is a different call, not a repeat.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string" },
        role: { type: "string" },
        tool_profile: { type: "string" },
      },
      required: ["name", "type", "role"],
    },
  },
  {
    name: "principal.list",
    description:
      "The workspace roster for an admin/owner; a member sees exactly its own row — which is how a principal learns the principal_id it must put in manifest.author_agent. Never returns a key, a hash or a key reference.",
    // [I-8]: a READ — the roster this actor may see, and nothing is issued.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "principal.issue_api_key",
    description:
      "Issue a replacement API key for a principal of the caller's workspace. Admin/owner, and never for a principal whose role outranks the caller's. Returned EXACTLY ONCE; no idempotency_key, for the same reason as principal.create.",
    // [I-8]: a WRITE. It mints an API key: the plaintext is returned ONCE and
    // the row that records it cannot be un-issued, only revoked. `idempotentHint`
    // is FALSE and that is the honest value — calling twice mints two keys.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { principal_id: { type: "string" } },
      required: ["principal_id"],
    },
  },
  {
    name: "principal.revoke_api_key",
    description:
      "Revoke one API key. The principal may revoke its own; an admin/owner may revoke any in the workspace. Revoking an already-revoked key converges on the original revocation time.",
    // [I-8]: a WRITE, and a withdrawal: a revoked key stays revoked.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        principal_id: { type: "string" },
        api_key_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["principal_id", "api_key_id"],
    },
  },
  {
    name: "signing_key.register",
    description:
      "Register the CALLER's own Ed25519 signing key (kid + unpadded base64url raw public key) — §4.4 step 3 resolves a package's kid against manifest.author_agent, so this is what makes a signed package attributable. A key is registered for the authenticated principal and for no one else, at every role: registering on another principal's behalf would forge authorship. Transparency-logged.",
    // [I-8]: a WRITE. It binds a `kid` to a principal and appends that binding
    // to the transparency log, where §4.4 step 3 reads it as a trust input.
    // Both are INSERTs — `destructiveHint` false — and a `kid` is unique, so a
    // repeat is refused and writes nothing: `idempotentHint` true.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        kid: { type: "string" },
        public_key_ed25519: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["kid", "public_key_ed25519"],
    },
  },
  {
    name: "signing_key.list",
    description:
      "Own signing keys with their revocation status; an admin/owner sees the workspace's. Public halves only.",
    // [I-8]: a READ. It publishes public halves, handles and scopes — never
    // private material [I-7] — and registers nothing.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "signing_key.revoke",
    description:
      "Revoke a signing key by kid. The holder may revoke its own; an admin/owner may revoke any in the workspace, because revocation removes capability and can never forge authorship. Takes effect on FUTURE §4.4 verifications (step 7); versions already verified or published keep their state. Transparency-logged, and the recorded time never moves.",
    // [I-8]: a WRITE, and terminal: §4.4 step 7 never re-registers a revoked
    // kid, so the revocation cannot be undone by calling anything.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { kid: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["kid"],
    },
  },
  {
    name: "tlog.read",
    description: "Public read of the §4.4 hash-chained transparency log.",
    // [I-8]: a READ over the append-only transparency log. It appends nothing —
    // a log surface that wrote while reading would make its own chain unverifiable.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { cursor: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "migration.count",
    description:
      "How often each visible skill MIGRATED: distinct (version, recipient) pairs with a terminal `adopted` receipt, distinct recipients, and distinct declared runtimes — counted from the INSERT-only receipt journal. Optional since_ms/until_ms bound the selection window; every row states its source, window and measurement state. Read-only: it counts, and changes nothing.",
    // Every tool here is one step of the loop, and the reading ones are not the
    // writing ones. This tool reads: the hints say so, so a client can call it
    // without an approval prompt and can never mistake it for a step that
    // appends an event. `idempotentHint` is trivially true for a read, and
    // `openWorldHint` false because it touches this registry and nothing else.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        since_ms: { type: "number" },
        until_ms: { type: "number" },
        q: { type: "string" },
        capability: { type: "string" },
        runtime: { type: "string" },
        tool: { type: "string" },
        risk: { type: "string" },
        state: { type: "string" },
        min_adopted: { type: "number" },
        min_rating: { type: "number" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "dashboard.view",
    description:
      "The dashboard: one of the ELEVEN views — library, evidence, receipts, approvals, dead_letters, migrations, and §9's five screens fleet, agent, skill_approval, capability, outcomes — scoped by the same ACL as the underlying reads. format=html renders the same payload. Every cell of every view carries an answer AND its method: `unknown` is written as the word and never as a blank or a dash [I-1], and every number states which state was counted, from which source, over which selection window [I-3].",
    // [I-8]: a READ. Every view is a rendering of surfaces the caller may
    // already read, under the SAME access rules, and none of them writes: a
    // dashboard that widened visibility or recorded a visit would be a second
    // source of truth rather than a view.
    //
    // `openWorldHint` is TRUE, and said FALSE until the sweep was driven with
    // EVERY view rather than the one that touches nothing. Three of the eleven
    // — `fleet`, `agent`, `capability` — render surfaces that walk a fleet
    // member's own directory, so this tool reaches outside this registry for
    // some of its arguments. A hint is a statement about the TOOL: "for the
    // argument the test happened to pass" is not a qualifier a client can read.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string" },
        format: { type: "string" },
        q: { type: "string" },
        capability: { type: "string" },
        runtime: { type: "string" },
        tool: { type: "string" },
        risk: { type: "string" },
        state: { type: "string" },
        min_adopted: { type: "number" },
        min_rating: { type: "number" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
      required: ["view"],
    },
  },
] as const;

function decodeArchive(args: any): Buffer {
  if (typeof args?.archive_base64 !== "string" || args.archive_base64.length === 0) {
    throw new ApiError("INVALID_SCHEMA", "archive_base64 (non-empty string) required");
  }
  return Buffer.from(args.archive_base64, "base64");
}

/** The path parameter of the REST twin, carried in the MCP arguments object. */
function versionIdOf(args: any): string {
  if (typeof args?.skill_version_id !== "string") {
    throw new ApiError("INVALID_SCHEMA", "skill_version_id (string) required");
  }
  return args.skill_version_id;
}

/** No coercion (verdict 1 major #2): a non-string key is INVALID_SCHEMA. */
function idemKey(args: any): string | undefined {
  if (args?.idempotency_key !== undefined && typeof args.idempotency_key !== "string") {
    throw new ApiError("INVALID_SCHEMA", "idempotency_key must be a string");
  }
  return args?.idempotency_key;
}

/** tools/call dispatch. Returns { json, replayed } — json is the exact bytes
 *  of the tool result (replay-identical for idempotent mutations). */
function callTool(registry: Registry, auth: AuthContext, name: string, args: any): { json: string; replayed: boolean } {
  switch (name) {
    case "skill.create": {
      // slug/skill_id pass through untouched — the service validates types and
      // shapes; the adapter never coerces (verdict 1 major #2)
      const out = registry.createVersion(
        auth,
        { slug: args?.slug, skill_id: args?.skill_id, archive: decodeArchive(args) },
        idemKey(args),
      );
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.create_from_dir": {
      if (typeof args?.source_base64 !== "string" || args.source_base64.length === 0) {
        throw new ApiError("INVALID_SCHEMA", "source_base64 (non-empty string) required");
      }
      const out = registry.createFromDir(
        auth,
        { slug: args?.slug, skill_id: args?.skill_id, source: Buffer.from(args.source_base64, "base64") },
        idemKey(args),
      );
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.lint": {
      if (typeof args?.skill_version_id !== "string") {
        throw new ApiError("INVALID_SCHEMA", "skill_version_id (string) required");
      }
      const out = registry.lintVersion(auth, args.skill_version_id, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.verify": {
      // Appendix H surface 4 has two forms behind ONE tool name: the
      // transition (skill_version_id) and the stateless §4.4 check (archive).
      // Naming both is INVALID_SCHEMA — never a silent choice between them.
      const hasId = args?.skill_version_id !== undefined;
      const hasArchive = args?.archive_base64 !== undefined;
      if (hasId && hasArchive) {
        throw new ApiError("INVALID_SCHEMA", "give either skill_version_id (transition) or archive_base64 (stateless), not both");
      }
      if (hasId) {
        if (typeof args.skill_version_id !== "string") {
          throw new ApiError("INVALID_SCHEMA", "skill_version_id (string) required");
        }
        const out = registry.verifyVersion(auth, args.skill_version_id, idemKey(args));
        return { json: out.responseJson, replayed: out.replayed };
      }
      return { json: JSON.stringify(registry.verifyStateless(auth, decodeArchive(args))), replayed: false };
    }
    case "skill.search":
      return { json: JSON.stringify(registry.search(auth, (args ?? {}) as SearchParams)), replayed: false };
    case "skill.review.request": {
      const out = registry.review(auth, versionIdOf(args), args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.publish": {
      const out = registry.publishVersion(auth, versionIdOf(args), idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.supersede": {
      const out = registry.supersedeVersion(auth, versionIdOf(args), args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.deprecate": {
      const out = registry.deprecateVersion(auth, versionIdOf(args), idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.revoke": {
      const out = registry.revokeVersion(auth, versionIdOf(args), args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.approve": {
      const out = registry.approve(auth, versionIdOf(args), args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.request_adoption": {
      const out = registry.requestAdoption(auth, args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.adopt": {
      if (typeof args?.adoption_request_id !== "string") {
        throw new ApiError("INVALID_SCHEMA", "adoption_request_id (string) required");
      }
      const out = registry.adopt(auth, args.adoption_request_id, args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.validate_outcome": {
      if (typeof args?.receipt_id !== "string") {
        throw new ApiError("INVALID_SCHEMA", "receipt_id (string) required");
      }
      const out = registry.validateOutcome(auth, args.receipt_id, args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.rate": {
      const out = registry.rate(auth, versionIdOf(args), args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "skill.transfer": {
      // `recipient` passes through untouched — §5.4's parser validates its
      // shape and refuses an absent one; the adapter never invents a default,
      // because a defaulted recipient is exactly the untyped internal move
      // this surface replaces.
      const out = registry.transfer(
        auth,
        { skill_version_id: args?.skill_version_id, recipient: args?.recipient },
        idemKey(args),
      );
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "transfer_grant.create": {
      const out = registry.createGrant(auth, args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "transfer_grant.list":
      return { json: JSON.stringify(registry.listGrants(auth)), replayed: false };
    case "assignment.activate": {
      const out = registry.activateAssignment(auth, args?.assignment_id, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "assignment.pause": {
      const out = registry.pauseAssignment(auth, args?.assignment_id, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "assignment.revoke": {
      const out = registry.revokeAssignment(auth, args?.assignment_id, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "assignment.list":
      return { json: JSON.stringify(registry.listAssignments(auth)), replayed: false };
    case "fleet.list":
      return { json: JSON.stringify(registry.fleetList(auth)), replayed: false };
    case "agent.capabilities":
      return { json: JSON.stringify(registry.agentCapabilities(auth, args?.agent_id)), replayed: false };
    case "capability.get":
      return { json: JSON.stringify(registry.capabilityGet(auth, args?.agent_id, args?.name)), replayed: false };
    case "observation.report": {
      const out = registry.reportObservation(auth, args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "principal.create":
      return { json: JSON.stringify(registry.createPrincipal(auth, args ?? {})), replayed: false };
    case "principal.list":
      return { json: JSON.stringify(registry.listPrincipals(auth)), replayed: false };
    case "principal.issue_api_key":
      return { json: JSON.stringify(registry.issueApiKey(auth, args?.principal_id)), replayed: false };
    case "principal.revoke_api_key": {
      const out = registry.revokeApiKey(auth, args?.principal_id, args?.api_key_id, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "signing_key.register": {
      const out = registry.registerSigningKey(auth, args ?? {}, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "signing_key.list":
      return { json: JSON.stringify(registry.listSigningKeys(auth)), replayed: false };
    case "signing_key.revoke": {
      const out = registry.revokeSigningKey(auth, args?.kid, idemKey(args));
      return { json: out.responseJson, replayed: out.replayed };
    }
    case "tlog.read":
      return { json: JSON.stringify(registry.readTlog(auth, args ?? {})), replayed: false };
    case "migration.count":
      return { json: JSON.stringify(registry.migrationCounts(auth, (args ?? {}) as SearchParams)), replayed: false };
    case "dashboard.view": {
      const format = parseDashboardFormat(args?.format);
      const payload = registry.dashboard(auth, args?.view, (args ?? {}) as SearchParams);
      return {
        json: JSON.stringify(format === "html" ? { view: payload.view, html: renderDashboard(payload) } : payload),
        replayed: false,
      };
    }
    default:
      throw new ApiError("NOT_FOUND", `unknown tool ${name}`);
  }
}

/**
 * Handle one JSON-RPC message for an authenticated caller. AuthN/rate limits
 * ran at the transport (http.ts) before this is reached — identically to REST.
 */
export function handleMcpMessage(registry: Registry, auth: AuthContext, msg: JsonRpcRequest): JsonRpcResponse {
  const id = msg.id ?? null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid JSON-RPC request" } };
  }
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "skillonomia", version: VERSION },
        },
      };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string") {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "params.name required" } };
      }
      try {
        // The advertised inputSchema of every tool is an object: a non-object
        // arguments container (42, "x", [], null) is INVALID_SCHEMA, never
        // silently treated as empty (verdict 2 major). Only an ABSENT
        // arguments member means "no arguments".
        const rawArgs = msg.params?.arguments;
        if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
          throw new ApiError("INVALID_SCHEMA", "arguments must be an object");
        }
        const { json, replayed } = callTool(registry, auth, name, rawArgs ?? {});
        const result: any = { content: [{ type: "text", text: json }], isError: false };
        if (replayed) result._meta = { "skillonomia/idempotency-replayed": true };
        return { jsonrpc: "2.0", id, result };
      } catch (e) {
        if (isApiError(e)) {
          // Tool-level failure: same typed envelope as REST, inside the result
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(e.toEnvelope()) }], isError: true },
          };
        }
        throw e;
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}
