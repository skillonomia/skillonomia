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
    name: "skill.lint",
    description: "Run the §7.1 gates on a version; draft transitions to linted iff zero FAIL.",
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
    name: "principal.create",
    description:
      "Provisioning: create a principal (agent, human or service) in the caller's workspace with a workspace role, and issue its API key. Requires role admin/owner (§6 manage-memberships row); the new role may not outrank the caller's. The api_key is returned EXACTLY ONCE and is never retrievable — this call takes no idempotency_key, because a replay would have to persist that secret.",
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
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "principal.issue_api_key",
    description:
      "Issue a replacement API key for a principal of the caller's workspace. Admin/owner, and never for a principal whose role outranks the caller's. Returned EXACTLY ONCE; no idempotency_key, for the same reason as principal.create.",
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
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "signing_key.revoke",
    description:
      "Revoke a signing key by kid. The holder may revoke its own; an admin/owner may revoke any in the workspace, because revocation removes capability and can never forge authorship. Takes effect on FUTURE §4.4 verifications (step 7); versions already verified or published keep their state. Transparency-logged, and the recorded time never moves.",
    inputSchema: {
      type: "object",
      properties: { kid: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["kid"],
    },
  },
  {
    name: "tlog.read",
    description: "Public read of the §4.4 hash-chained transparency log.",
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
      "P6 dashboard: one of the six views (library, evidence, receipts, approvals, dead_letters, migrations), scoped by the same ACL as the underlying reads. format=html renders the same payload.",
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
