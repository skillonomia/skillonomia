// The skill migration counter — how often a skill actually MOVED from the
// agent that wrote it to an agent that ran it, counted from the receipt
// journal and from nothing else.
//
// WHY IT IS ITS OWN MODULE, AND WHY IT SHIPS. The mechanics below were written
// once already, inside the owner's internal release-gate module, where they
// counted adoptions across the whole instance against a fixed threshold. That
// threshold is the owner's release decision and stays internal; the COUNT is
// the number this registry exists to make countable, and an installation that
// cannot see it has no way to answer "did anything ever migrate?" about its own
// library. So the counting moved here, into the shipped product, and the
// release gate above it keeps only its thresholds and its verdict.
//
// The file is `skill-migrations.ts` rather than `migrations.ts` because
// `migrations/` at the repository root is the SQL schema-migration directory
// (src/db.ts runs it), and a `src/migrations.ts` would read as its code twin.
// A migration here is a SKILL migrating between agents.
//
// WHAT A MIGRATION IS — the §5.3 definition, unchanged:
//
//   one skill VERSION, one RECIPIENT agent, and a receipt whose terminal event
//   is `adopted` carrying the evidence the receipt machine validated against
//   that version's declared `validation_gates` at append time.
//
// The unit is the (version, recipient) PAIR, not the receipt row: a recipient
// that re-runs the same version does not migrate it twice.
//
// WHERE THE NUMBER COMES FROM, AND WHERE IT MUST NOT. `receipt_events` only.
// That table is INSERT-only by trigger (`tg_revents_no_upd`, `tg_revents_no_del`
// — see migrations/0004), carries `event_seq`, and each row is written in the
// same transaction as the fact it describes. `adoption_requests.
// requester_context_json` holds the same JSON and is a MUTABLE denormalized
// cache: it keeps no history, so anything counted from it is counted from
// whoever wrote last. That is not a theoretical preference. On the release
// instance an ordinary `skill.adopt` carrying an invented `runtime.id`, sent
// against a request whose receipt chain was already closed, rewrote the stored
// descriptor of two earlier adoptions and pushed the runtime count up by one —
// no event, no error, no trace. Nothing in this file may read that column.
//
// WHO THE RECIPIENT IS, AND WHERE THAT COMES FROM. Since §5.4 a movement can
// be initiated by a SENDER, and the sender names a typed recipient. That
// recipient is recorded on the `transferred` event, in the transaction that
// records the transfer, and this counter reads it from there — see
// `recipientOf` below. A chain that no transfer opened has no such event and
// falls back to the receipt shell, which is INSERT-only by trigger and written
// once. Neither source is `adoption_requests`, and neither can be edited after
// the fact.
//
// FAIL-CLOSED, AND THE DIFFERENCE BETWEEN "none" AND "unknown". An adoption
// whose declared runtime cannot be read — no `delivered` event carried one, or
// the JSON does not parse — contributes NO runtime id. Not an "unknown" bucket
// masquerading as a runtime, not a guess from the request row: zero. It is
// still reported, as `runtimes_unknown`, because a count of 0 known runtimes
// over 3 migrations is a different fact from 0 known runtimes over 0
// migrations, and a reader who cannot tell them apart has been told nothing.
//
// EVERY NUMBER CARRIES ITS METHOD. Each row published from here states its
// SOURCE (this journal), its SELECTION WINDOW (all time, or the bounds asked
// for) and its measurement STATE. A skill with no events at all is not an
// absent row: it is `not_migrated`, 0, over a stated window. An empty cell
// would say "no fact"; the registry always knows whether it looked.
import type { Db } from "./sqlite.ts";
import { ApiError } from "./errors.ts";

/** The one source these counts may be read from, named in every answer. */
export const MIGRATION_SOURCE = "receipt_events (registry journal, INSERT-only)";

/** The selection boundary of a count. `null` on both sides means all time. */
export interface MigrationWindow {
  since_ms: number | null;
  until_ms: number | null;
}

export const ALL_TIME: MigrationWindow = { since_ms: null, until_ms: null };

/**
 * The window a caller asked for, parsed in ONE place so both adapters answer
 * identically (§2: the adapters carry no logic; §6 requires the same answer on
 * REST and MCP). An absent bound is open; a bound that is not an integer
 * number of milliseconds, or a pair in the wrong order, is `INVALID_SCHEMA` —
 * never silently widened to all time, because a number whose stated boundary is
 * not the boundary it was computed over is the defect this attribute exists to
 * prevent.
 */
export function parseMigrationWindow(input: { since_ms?: unknown; until_ms?: unknown }): MigrationWindow {
  const bound = (v: unknown, name: string): number | null => {
    if (v === undefined || v === null) return null;
    // A string bound must LOOK like an integer: `Number("")` is 0, and an empty
    // `?since_ms=` that quietly became "since the epoch" would be a window the
    // answer states and the query did not use.
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n)) throw new ApiError("INVALID_SCHEMA", `${name} must be an integer number of milliseconds`);
    return n;
  };
  const since_ms = bound(input.since_ms, "since_ms");
  const until_ms = bound(input.until_ms, "until_ms");
  if (since_ms !== null && until_ms !== null && since_ms > until_ms) {
    throw new ApiError("INVALID_SCHEMA", "since_ms must not be later than until_ms");
  }
  return { since_ms, until_ms };
}

/** The window as one publishable phrase — never omitted from an answer. */
export function describeWindow(w: MigrationWindow): string {
  if (w.since_ms === null && w.until_ms === null) return "all time";
  if (w.until_ms === null) return `from ${w.since_ms} (ms) to now`;
  if (w.since_ms === null) return `all time up to ${w.until_ms} (ms)`;
  return `from ${w.since_ms} to ${w.until_ms} (ms)`;
}

/** The counters themselves, over whatever set of receipts was selected. */
export interface MigrationCounters {
  /** distinct (version, recipient) pairs with a terminal `adopted` receipt */
  migrations: number;
  /** distinct recipient agents among those migrations */
  distinct_recipients: number;
  /** distinct declared `environment_descriptor.runtime.id` values, READ ones only */
  distinct_runtimes: number;
  runtimes: string[];
  /** migrations whose declared runtime could not be read: unknown, never "none" */
  runtimes_unknown: number;
}

/**
 * One skill's counters with the three attributes every published number
 * carries. Written flat rather than by extension so the response shape is
 * legible in one place — the specification's row for this surface names these
 * exact fields.
 */
export interface SkillMigrationCount {
  skill_id: string;
  slug: string;
  migrations: number;
  distinct_recipients: number;
  distinct_runtimes: number;
  runtimes: string[];
  runtimes_unknown: number;
  /**
   * Three-valued and never blank. `migrated` and `not_migrated` are both
   * MEASURED answers — the journal was read over the stated window and either
   * held qualifying receipts or held none. The third value, "unknown", cannot
   * arise for this number and so is not offered here: the journal is the only
   * source and it is complete by construction. Where unknown DOES arise — a
   * migration whose declared runtime is unreadable — it is carried separately
   * as `runtimes_unknown`, so it can never be mistaken for "no runtime".
   */
  measurement_state: "migrated" | "not_migrated";
  source: string;
  window: string;
}

/**
 * The answer of the read surface: the counted skills, and the method the
 * counting used, stated once at the envelope as well as on every row. A reader
 * who takes a single row away from the page still carries its source and its
 * window with it.
 */
export interface MigrationCountResponse {
  source: string;
  window: string;
  window_since_ms: number | null;
  window_until_ms: number | null;
  items: SkillMigrationCount[];
  next_cursor: string | null;
}

/** One qualifying (skill, version, recipient) row, possibly repeated per runtime. */
interface PairRow {
  skill_id: string;
  version: string;
  /** the receipt shell's adopter — the fallback, see `recipientOf` */
  recipient: string;
  ctx: string | null;
  /** the `recipient_json` of this chain's `transferred` event, when it has one */
  transferred_to: string | null;
}

interface Accumulator {
  pairs: Map<string, Set<string>>;
  recipients: Set<string>;
  runtimes: Set<string>;
}

function emptyAccumulator(): Accumulator {
  return { pairs: new Map(), recipients: new Set(), runtimes: new Set() };
}

function counters(acc: Accumulator): MigrationCounters {
  let unknown = 0;
  for (const runtimes of acc.pairs.values()) if (runtimes.size === 0) unknown += 1;
  return {
    migrations: acc.pairs.size,
    distinct_recipients: acc.recipients.size,
    distinct_runtimes: acc.runtimes.size,
    runtimes: [...acc.runtimes].sort(),
    runtimes_unknown: unknown,
  };
}

/**
 * The one query. `adopted` + evidence is the qualifying event; the declared
 * environment is LEFT-joined off the `delivered` EVENT of the same receipt, so
 * a receipt that declared nothing readable still counts as a migration and
 * still contributes no runtime.
 *
 * The window is applied to the `adopted` event's `server_at_ms` — the registry
 * clock at the moment the migration completed, on an INSERT-only row.
 */
function selectPairs(db: Db, window: MigrationWindow, skillIds?: readonly string[]): PairRow[] {
  const where: string[] = ["e.event = 'adopted'", "e.evidence_json IS NOT NULL"];
  const params: unknown[] = [];
  if (window.since_ms !== null) {
    where.push("e.server_at_ms >= ?");
    params.push(window.since_ms);
  }
  if (window.until_ms !== null) {
    where.push("e.server_at_ms <= ?");
    params.push(window.until_ms);
  }
  if (skillIds !== undefined) {
    if (skillIds.length === 0) return [];
    where.push(`v.skill_id IN (${skillIds.map(() => "?").join(",")})`);
    params.push(...skillIds);
  }
  return db
    .prepare(
      `SELECT DISTINCT v.skill_id AS skill_id, r.skill_version_id AS version, r.adopter_agent_id AS recipient,
              d.environment_json AS ctx, t.recipient_json AS transferred_to
         FROM adoption_receipts r
         JOIN skill_versions v ON v.id = r.skill_version_id
         JOIN receipt_events e ON e.adoption_receipt_id = r.id
         LEFT JOIN receipt_events d
                ON d.adoption_receipt_id = r.id AND d.event = 'delivered' AND d.environment_json IS NOT NULL
         LEFT JOIN receipt_events t
                ON t.adoption_receipt_id = r.id AND t.event = 'transferred' AND t.recipient_json IS NOT NULL
        WHERE ${where.join(" AND ")}`,
    )
    .all(...params) as PairRow[];
}

/**
 * WHO RECEIVED IT — read from the transfer EVENT wherever there is one.
 *
 * §5.4 records the recipient on the `transferred` row, typed, in the same
 * transaction as the transfer. That row is the registry's statement of where a
 * version was sent, and it is the statement this counter reads: `recipient_json`
 * first, the receipt shell second.
 *
 * The fallback is not a weakening and is not a mutable source. A chain opened
 * by surface 6 has no transfer to read — the recipient asked for the version
 * itself — and `adoption_receipts` is INSERT-only by trigger
 * (`tg_receipts_no_upd`/`tg_receipts_no_del`), written once when the chain
 * begins and never afterwards. What the counter must never read is
 * `adoption_requests`, the one mutable table in this path, and it does not.
 *
 * Fail-closed the same way the runtime is: a `recipient_json` that does not
 * parse, or names no string id, contributes nothing of its own rather than a
 * placeholder recipient.
 */
function recipientOf(row: PairRow): string {
  if (row.transferred_to !== null) {
    try {
      const id = JSON.parse(row.transferred_to)?.id;
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      // an unreadable declaration is not a recipient — fall through
    }
  }
  return row.recipient;
}

/** The declared runtime id of one `delivered` payload, or null if unreadable. */
function runtimeIdOf(ctx: string | null): string | null {
  if (ctx === null) return null;
  try {
    const id = JSON.parse(ctx)?.environment_descriptor?.runtime?.id;
    return typeof id === "string" ? id : null;
  } catch {
    // an unreadable declaration contributes no runtime — never a placeholder
    return null;
  }
}

function accumulate(rows: PairRow[], into: (skillId: string) => Accumulator): void {
  for (const row of rows) {
    const acc = into(row.skill_id);
    const recipient = recipientOf(row);
    const key = `${row.version}\u0000${recipient}`;
    let runtimes = acc.pairs.get(key);
    if (runtimes === undefined) {
      runtimes = new Set<string>();
      acc.pairs.set(key, runtimes);
    }
    acc.recipients.add(recipient);
    const id = runtimeIdOf(row.ctx);
    if (id !== null) {
      runtimes.add(id);
      acc.runtimes.add(id);
    }
  }
}

/**
 * Per-skill counts for exactly the skills the caller passes — which is where
 * the access rules live: this module counts, and never decides who may see a
 * skill. A subject with no qualifying receipt gets a row of zeroes rather than
 * no row at all.
 */
export function migrationCounts(
  db: Db,
  subjects: ReadonlyArray<{ skill_id: string; slug: string }>,
  window: MigrationWindow = ALL_TIME,
): SkillMigrationCount[] {
  const ids = subjects.map((s) => s.skill_id);
  const bySkill = new Map<string, Accumulator>();
  accumulate(selectPairs(db, window, ids), (skillId) => {
    let acc = bySkill.get(skillId);
    if (acc === undefined) {
      acc = emptyAccumulator();
      bySkill.set(skillId, acc);
    }
    return acc;
  });

  const windowText = describeWindow(window);
  return subjects.map((subject) => {
    const c = counters(bySkill.get(subject.skill_id) ?? emptyAccumulator());
    return {
      skill_id: subject.skill_id,
      slug: subject.slug,
      migrations: c.migrations,
      distinct_recipients: c.distinct_recipients,
      distinct_runtimes: c.distinct_runtimes,
      runtimes: c.runtimes,
      runtimes_unknown: c.runtimes_unknown,
      measurement_state: c.migrations > 0 ? "migrated" : "not_migrated",
      source: MIGRATION_SOURCE,
      window: windowText,
    };
  });
}

/**
 * The same counters over the WHOLE instance, with no per-skill split: distinct
 * (version, recipient) pairs, distinct recipients, and the UNION of the read
 * runtimes. The owner's release gate is one caller of this; it adds thresholds
 * and a verdict, and changes none of the arithmetic.
 */
export function migrationTotals(db: Db, window: MigrationWindow = ALL_TIME): MigrationCounters {
  const acc = emptyAccumulator();
  accumulate(selectPairs(db, window), () => acc);
  return counters(acc);
}
