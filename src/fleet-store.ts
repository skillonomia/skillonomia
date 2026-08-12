// §6 PART A — the stored half of an observation.
//
// `observation.report` files what an agent says it saw; this module is where
// that report is written and read back. It is the OTHER V-1 implementation of
// the same two seams `src/fleet-scan.ts` implements from a transcript
// directory, and it exists to make one thing concrete:
//
//     the assessment logic cannot tell which of the two it is talking to.
//
// A snapshot assembled from rows of this database and a snapshot assembled from
// files under a configured root are the same shape, carry the same window, and
// answer the same interface. That is [M-7]'s whole point: in V-2 the records
// arrive as a message from an agent on somebody else's machine, and the third
// implementation will be the same shape again.
//
// WHAT IS NOT HERE. No record text. The reduction to markers happens before a
// row is written (`src/service.ts`), the column does not exist (D.1h), and so
// there is nothing for this module to read back and publish [I-7].
import type { Db } from "./sqlite.ts";
import { ulid } from "./ulid.ts";
import {
  NO_SNAPSHOT_WINDOW,
  arrivalRecordsOf,
  type FleetObservationSource,
  type FleetRuntime,
  type ObservedRecord,
  type RuntimeSnapshot,
  type SelectionWindow,
  type Trivalent,
} from "./fleet.ts";
import type { RuntimeRecordSource, RuntimeRecordWindow } from "./assignments.ts";
import type { GrantPrincipal } from "./grants.ts";
import { selfReported, type Evidence } from "./outcome.ts";

export interface RuntimeObservationRow {
  id: string;
  agent_id: string;
  runtime: FleetRuntime;
  model: string | null;
  session_active: number | null;
  last_activity_ms: number | null;
  selection_window: SelectionWindow;
  window_detail: string;
  proposal_inventory_complete: number;
  records_read: number;
  reported_by_agent_id: string;
  reported_by_type: GrantPrincipal["type"];
  reported_by_role: GrantPrincipal["role"];
  grant_id: string | null;
  server_at_ms: number;
}

export interface ObservedRecordRow {
  id: string;
  observation_id: string;
  agent_id: string;
  runtime: FleetRuntime;
  role: ObservedRecord["role"];
  call_id: string | null;
  at_ms: number | null;
  marker: string;
  result: ObservedRecord["result"];
  /** the named values the run presented, as stored JSON. `0010`. */
  evidence: string | null;
  server_at_ms: number;
}

/** One report, already reduced to markers by the caller. */
export interface RecordObservationInput {
  agentId: string;
  runtime: FleetRuntime;
  model: string | null;
  sessionActive: boolean | null;
  lastActivityMs: number | null;
  window: SelectionWindow;
  windowDetail: string;
  proposalInventoryComplete: boolean;
  records: ReadonlyArray<Omit<ObservedRecord, "agent_id" | "runtime">>;
  reportedBy: GrantPrincipal;
  grantId: string | null;
  idempotencyKey: string;
  nowMs: number;
}

/**
 * Write one report and its records in the caller's transaction.
 *
 * `records_read` is stored rather than counted at read time, and deliberately:
 * it is how many records the reporter LOOKED AT, which is not how many rows
 * survived the reduction to markers. A report that examined four hundred lines
 * and found one marker examined four hundred lines, and a window that said "1"
 * would misdescribe the search.
 */
export function recordObservationInTx(db: Db, input: RecordObservationInput): { observation_id: string } {
  const id = ulid(input.nowMs);
  db.prepare(
    `INSERT INTO runtime_observations(id, agent_id, runtime, model, session_active, last_activity_ms,
       selection_window, window_detail, proposal_inventory_complete, records_read, reported_by_agent_id,
       reported_by_type, reported_by_role, grant_id, server_at_ms, idempotency_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.agentId,
    input.runtime,
    input.model,
    input.sessionActive === null ? null : input.sessionActive ? 1 : 0,
    input.lastActivityMs,
    input.window,
    input.windowDetail,
    input.proposalInventoryComplete ? 1 : 0,
    input.records.length,
    input.reportedBy.agent_id,
    input.reportedBy.type,
    input.reportedBy.role,
    input.grantId,
    input.nowMs,
    input.idempotencyKey,
  );
  const insert = db.prepare(
    `INSERT INTO observed_records(id, observation_id, agent_id, runtime, role, call_id, at_ms, marker, result,
       evidence, server_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // ONE CLOCK, NOT A CLOCK PLUS AN OFFSET. `ulid` is already monotonic within a
  // millisecond, so repeating `input.nowMs` orders the records of one report by
  // insertion. Adding `n` to the timestamp instead pushed the generator's clock
  // PAST the report's own, and the next report filed in the same millisecond
  // then got a fresh RANDOM tail — an id that could sort BELOW the report
  // before it. `latestObservation` breaks its tie on that id, so "the latest
  // report wins" silently became "one of the two reports wins", and which
  // records §5 and §6 had searched depended on 16 random characters.
  for (const r of input.records) {
    insert.run(
      ulid(input.nowMs),
      id,
      input.agentId,
      input.runtime,
      r.role,
      r.call_id,
      r.at_ms,
      r.marker,
      r.result,
      r.evidence === null ? null : JSON.stringify(r.evidence),
      input.nowMs,
    );
  }
  return { observation_id: id };
}

/** The LATEST report about one agent, or undefined when there is none. */
export function latestObservation(db: Db, agentId: string): RuntimeObservationRow | undefined {
  return db
    .prepare(
      `SELECT id, agent_id, runtime, model, session_active, last_activity_ms, selection_window, window_detail,
              proposal_inventory_complete, records_read, reported_by_agent_id, reported_by_type, reported_by_role,
              grant_id, server_at_ms
         FROM runtime_observations WHERE agent_id=? ORDER BY server_at_ms DESC, id DESC LIMIT 1`,
    )
    .get(agentId) as RuntimeObservationRow | undefined;
}

/** Every record of one report, oldest first. */
export function recordsOfObservation(db: Db, observationId: string): ObservedRecordRow[] {
  return db
    .prepare(
      `SELECT id, observation_id, agent_id, runtime, role, call_id, at_ms, marker, result, evidence, server_at_ms
         FROM observed_records WHERE observation_id=? ORDER BY id`,
    )
    .all(observationId) as ObservedRecordRow[];
}

/**
 * Stored evidence, back into named values — MARKED AS A PRINCIPAL'S.
 *
 * This is the point of acceptance on the reading side, and the mark goes on
 * here rather than at the column that publishes a verdict (2.1). These bytes
 * were written by `observation.report`: they are what an agent said about a
 * machine this registry cannot reach, and nothing downstream may treat them as
 * anything else. Marking them where they are parsed is what makes the
 * provenance of the verdict a property of the DATA rather than of the branch
 * that read it.
 *
 * Unreadable stored bytes are `null` — an evidence nobody can read is an
 * evidence nobody presented, and that is `unknown` downstream, never `no`.
 */
function parseEvidence(stored: string | null): Evidence | null {
  if (stored === null) return null;
  try {
    const parsed = JSON.parse(stored);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? selfReported(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function trivalent(v: number | null): Trivalent {
  return v === null ? "unknown" : v === 1 ? "yes" : "no";
}

/**
 * The stored reports, as the two seams see them.
 *
 * THE LATEST REPORT WINS, and that is a choice worth naming. An observation is
 * a statement about a moment; stacking every report an agent has ever filed
 * would answer "was this ever seen" when the question is "what is there now".
 * The window travels with the answer either way, so a reader is never left to
 * guess which moment they are looking at.
 */
export class StoredObservations implements FleetObservationSource, RuntimeRecordSource {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  snapshotFor(agentId: string): RuntimeSnapshot | null {
    const head = latestObservation(this.db, agentId);
    if (!head) return null;
    const rows = recordsOfObservation(this.db, head.id);
    return {
      agent_id: head.agent_id,
      runtime: head.runtime,
      model: head.model,
      session_active: trivalent(head.session_active),
      last_activity_ms: head.last_activity_ms,
      window: head.selection_window,
      window_detail: `${head.window_detail} (${head.records_read} record(s) examined)`,
      proposal_inventory_complete: head.proposal_inventory_complete === 1,
      // WHO FILED IT, and of which of the three kinds `agents.type` allows. §4's
      // `outcome` publishes it beside its verdict, because a self-report from a
      // service and a self-report from a human are different things to read
      // [I-5], [D-18].
      reported_by: { agent_id: head.reported_by_agent_id, type: head.reported_by_type },
      records: rows.map((r) => ({
        agent_id: r.agent_id,
        runtime: r.runtime,
        role: r.role,
        call_id: r.call_id,
        at_ms: r.at_ms,
        marker: r.marker,
        result: r.result,
        evidence: parseEvidence(r.evidence),
      })),
    };
  }

  /** [M-5]: `arrivalRecordsOf`, and never a hand-written projection. The one
   *  this replaced dropped `call_id`, which is the only thing that makes a call
   *  and an output ONE pair — so the assignments surface read a pair where the
   *  capability surface read none, from these very rows. */
  recordsFor(agentId: string): RuntimeRecordWindow | null {
    const snapshot = this.snapshotFor(agentId);
    if (!snapshot) return null;
    return { records: arrivalRecordsOf(snapshot.records), window: snapshot.window_detail };
  }
}

/**
 * Both V-1 sources at once, with the STORED report taking precedence.
 *
 * A deployment may have a transcript directory configured AND receive
 * self-reports; a self-report is the more recent and the more specific of the
 * two, so it wins, and when there is none the configured directory answers. A
 * consumer still sees one interface and still cannot tell which side answered.
 */
export class FirstAvailableObservations implements FleetObservationSource, RuntimeRecordSource {
  private readonly sources: ReadonlyArray<FleetObservationSource & RuntimeRecordSource>;
  constructor(sources: ReadonlyArray<FleetObservationSource & RuntimeRecordSource>) {
    this.sources = sources;
  }
  snapshotFor(agentId: string): RuntimeSnapshot | null {
    for (const s of this.sources) {
      const snapshot = s.snapshotFor(agentId);
      if (snapshot) return snapshot;
    }
    return null;
  }
  recordsFor(agentId: string): RuntimeRecordWindow | null {
    for (const s of this.sources) {
      const w = s.recordsFor(agentId);
      if (w) return w;
    }
    return null;
  }
}

export { NO_SNAPSHOT_WINDOW };
