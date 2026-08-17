// WHO MAY REPORT WHAT WAS SEEN — `INV-02`, `P3-FR-06`.
//
// P3 REVIEW-1 finding `P3-R1-001`: the observed-state intake was mounted
// outside the console surface, which was necessary and not sufficient. It
// authenticated with the ordinary Registry Bearer key — the key the OWNER holds
// — and it took the evidence's `source` from the request body. So the owner
// could POST `source: "adapter"` with invented provenance, receive 201, and the
// Console would then report the assignment `loaded`. The desired/observed
// boundary the whole phase exists to hold was bypassable by the one principal
// it exists to hold it against.
//
// Two things close it, and both are here rather than in the route:
//
//   1. AN EVIDENCE PRINCIPAL IS A REGISTRATION, NOT A ROLE. A credential may
//      write observed state only if the DEPLOYMENT registered its agent as a
//      reporter. Nothing an owner can reach — no console route, no Registry API,
//      no CLI command — writes this registration. An owner or admin credential
//      is refused outright, before anything in the body is read, whatever any
//      registration says.
//   2. THE SOURCE IS DERIVED, NOT DECLARED. The kind of evidence a principal
//      files — `backend`, `adapter` or `runtime` — is the kind it was registered
//      as. A body that names a source at all is refused, because a field the
//      server ignores is a field a reader will believe.
//
// WHY A FILE AND NOT A TABLE. This is deployment provisioning state, the same
// kind as the outstanding bootstrap token hash and the webhook signing secrets,
// and both of those live in the data directory for the reason `src/auth.ts`
// gives: Appendix D.1 is byte-frozen and the live schema is compared against it,
// so a table for a piece of process state is a change to the normative schema
// for something that is not registry data. It also keeps the boundary honest in
// the direction that matters — a row is written by SQL this server runs, while
// this file is written by whoever installs the deployment.
//
// WHAT THIS DOES NOT CLAIM. It does not claim an owner cannot obtain a
// registered principal's API key. In a single-owner closed fleet whoever
// installs the deployment can install anything; no registry can rule that out
// from inside. What it does claim, and what `INV-02` asks for, is that no
// owner or admin CREDENTIAL and no console session can write observed state on
// any surface of this registry, and that the source recorded against an
// observation is the one this server derived from the authenticated principal.
import { readFileSync } from "node:fs";

export const EVIDENCE_SOURCES = ["backend", "adapter", "runtime"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export function isEvidenceSource(v: unknown): v is EvidenceSource {
  return typeof v === "string" && (EVIDENCE_SOURCES as readonly string[]).includes(v);
}

/** One registered reporter: an agent, and the kind of evidence it files. */
export interface EvidencePrincipal {
  agent_id: string;
  source: EvidenceSource;
}

/**
 * Where the registrations come from. `lookup` returns null for every agent that
 * is not registered — including when the store cannot be read at all, which is
 * deliberate: a reporter registry nobody can read authorizes nobody.
 */
export interface EvidencePrincipalStore {
  lookup(agentId: string): EvidencePrincipal | null;
}

/** The shipped default: nothing is registered, so no credential may report.
 *  A deployment that wants an adapter to report says so. */
export class NoEvidencePrincipals implements EvidencePrincipalStore {
  lookup(): EvidencePrincipal | null {
    return null;
  }
}

/** What the tests use, and what a P4 adapter provisioner will drive. */
export class MemoryEvidencePrincipals implements EvidencePrincipalStore {
  private readonly byAgent = new Map<string, EvidenceSource>();
  register(agentId: string, source: EvidenceSource): void {
    this.byAgent.set(agentId, source);
  }
  lookup(agentId: string): EvidencePrincipal | null {
    const source = this.byAgent.get(agentId);
    return source ? { agent_id: agentId, source } : null;
  }
}

/**
 * The deployment's own file: `{"<agent_id>": "adapter", …}` in the data
 * directory. Re-read on every lookup, so a deployment that registers an adapter
 * does not have to restart the registry, and FAIL-CLOSED at every step — a
 * missing file, unparsable JSON, a value outside the vocabulary, all of them
 * authorize nobody rather than everybody.
 */
export class FsEvidencePrincipals implements EvidencePrincipalStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  lookup(agentId: string): EvidencePrincipal | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return null; // no file: this deployment registered no reporter
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // unreadable: authorizes nobody, never everybody
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const source = (parsed as Record<string, unknown>)[agentId];
    return isEvidenceSource(source) ? { agent_id: agentId, source } : null;
  }
}
