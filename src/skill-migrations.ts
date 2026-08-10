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
// records the transfer, and this counter reads it from there. A chain that NO
// TRANSFER OPENED has no such event and never had one — the recipient asked for
// the version itself — and its recipient is the receipt shell's own adopter,
// which is INSERT-only by trigger (`tg_receipts_no_upd`/`tg_receipts_no_del`)
// and written once when the chain begins. Neither source is
// `adoption_requests`, and neither can be edited after the fact.
//
// [I-6], AND WHAT IT COST TO GET WRONG. Those are two DIFFERENT chains, and
// this counter used to treat them as one: a chain that HAD a `transferred`
// event whose `recipient_json` was missing or unparseable fell through to the
// receipt shell and was counted anyway. That is fail-OPEN, and it is worse than
// it looks — the chain's own statement of where the version went was broken,
// and the counter answered from somewhere else without saying so. A recipient
// event that cannot be read now contributes NOTHING: no migration, no
// recipient, no runtime. The chain is reported as `recipients_unattributed`,
// for the same reason `runtimes_unknown` is reported: a migration that was
// dropped and a migration that never happened are different facts.
//
// [I-3], AND THE SOURCE THAT MUST NAME THE TRUTH. `source` used to be one
// constant naming `receipt_events`, printed on every row whatever the row was
// counted from — so a `migrations` figure whose (version, recipient) keys came
// half from the receipt shell still published `receipt_events` as its source.
// A number that names a source it was not obtained from is [I-3]'s failure with
// an attribution attached. `source` is now DERIVED from what each answer
// actually read, and names both journals when both were read.
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

/** The journal the QUALIFYING EVENT is selected from — always this one. */
export const MIGRATION_SOURCE = "receipt_events (registry journal, INSERT-only)";

/** The journal a recipient identity may come from when a TRANSFER opened the
 *  chain: the `transferred` event's own `recipient_json` [I-6]. */
export const RECIPIENT_SOURCE_EVENT = "receipt_events";

/** …and when NO transfer opened it: the INSERT-only receipt shell, which is
 *  where a chain the recipient opened for itself records who that was. */
export const RECIPIENT_SOURCE_SHELL = "adoption_receipts";

/** Where the recipient half of a (version, recipient) key was read from. */
export type RecipientSource = typeof RECIPIENT_SOURCE_EVENT | typeof RECIPIENT_SOURCE_SHELL;

/**
 * THE SOURCE PHRASE, DERIVED FROM WHAT WAS READ — never a constant printed over
 * whatever happened [I-3].
 *
 * It names JOURNALS and carries NO FIGURE. A count inside a sentence has no
 * measurement state, no source and no window of its own, and this string is
 * rendered into a cell beside numbers that have all three; `recipient_sources`
 * carries the same fact structurally, for a reader that needs to branch on it.
 *
 * A `migrations` figure is a count of (version, recipient) keys, so the journal
 * a recipient came from is half the provenance of the number. When every
 * recipient came from a `transferred` event the phrase names that journal
 * alone; when any came from the receipt shell it names both, and says how many.
 */
export function describeSource(read: { from_event: number; from_shell: number }): string {
  if (read.from_shell === 0) return MIGRATION_SOURCE;
  return (
    `${MIGRATION_SOURCE}; the recipient of at least one counted migration was read from ` +
    `${RECIPIENT_SOURCE_SHELL} (INSERT-only receipt shell), that chain having been opened by the recipient ` +
    `itself and carrying no transfer event`
  );
}

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
  /**
   * CHAINS DROPPED BECAUSE THEIR OWN RECIPIENT EVENT COULD NOT BE READ [I-6].
   *
   * A chain a transfer opened states where the version went, on the
   * INSERT-only `transferred` event. When that statement is missing or does not
   * parse, the chain contributes NOTHING — no migration, no recipient, no
   * runtime — because the alternative is to answer from a source the chain did
   * not name. It is REPORTED rather than silently dropped: a migration nobody
   * could attribute and a migration that never happened are different facts,
   * and a reader who cannot tell them apart has been told nothing.
   */
  recipients_unattributed: number;
  /** which journals the counted recipients were actually read from [I-3] */
  recipient_sources: RecipientSource[];
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
  /** chains whose own recipient event could not be read, and were dropped [I-6] */
  recipients_unattributed: number;
  /** the journals this row's recipients were read from [I-3] */
  recipient_sources: RecipientSource[];
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
  /** the receipt shell's own adopter — the recipient of a chain NO transfer
   *  opened, and never a substitute for a transfer's broken statement */
  recipient: string;
  ctx: string | null;
  /** the id of this chain's `transferred` event, or null when it has none.
   *  It is selected SEPARATELY from the payload so that "no transfer opened
   *  this chain" and "a transfer opened it and its statement is unreadable"
   *  are two different rows here, as they are two different facts [I-6]. */
  transfer_event_id: string | null;
  /** the `recipient_json` of that event — null when the event carried none */
  transferred_to: string | null;
}

interface Accumulator {
  pairs: Map<string, Set<string>>;
  recipients: Set<string>;
  runtimes: Set<string>;
  /** chains dropped because their own recipient event could not be read [I-6] */
  unattributed: number;
  /** how many counted (version, recipient) keys came from each journal [I-3] */
  from: Map<RecipientSource, number>;
}

function emptyAccumulator(): Accumulator {
  return { pairs: new Map(), recipients: new Set(), runtimes: new Set(), unattributed: 0, from: new Map() };
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
    recipients_unattributed: acc.unattributed,
    recipient_sources: [...acc.from.keys()].sort() as RecipientSource[],
  };
}

/** The source phrase this accumulator's numbers were actually obtained from. */
function sourceOf(acc: Accumulator): string {
  return describeSource({
    from_event: acc.from.get(RECIPIENT_SOURCE_EVENT) ?? 0,
    from_shell: acc.from.get(RECIPIENT_SOURCE_SHELL) ?? 0,
  });
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
      // The `transferred` join carries NO condition on `recipient_json`. It
      // used to, and that was the fail-open: an event whose payload was NULL
      // dropped out of the join and the chain then looked exactly like one no
      // transfer ever opened, so the receipt shell answered for a statement the
      // chain HAD made and could not read back [I-6].
      `SELECT DISTINCT v.skill_id AS skill_id, r.skill_version_id AS version, r.adopter_agent_id AS recipient,
              d.environment_json AS ctx, t.id AS transfer_event_id, t.recipient_json AS transferred_to
         FROM adoption_receipts r
         JOIN skill_versions v ON v.id = r.skill_version_id
         JOIN receipt_events e ON e.adoption_receipt_id = r.id
         LEFT JOIN receipt_events d
                ON d.adoption_receipt_id = r.id AND d.event = 'delivered' AND d.environment_json IS NOT NULL
         LEFT JOIN receipt_events t
                ON t.adoption_receipt_id = r.id AND t.event = 'transferred'
        WHERE ${where.join(" AND ")}`,
    )
    .all(...params) as PairRow[];
}

/**
 * WHO RECEIVED IT — and WHICH JOURNAL SAID SO [I-6], [I-3].
 *
 * There are exactly two kinds of chain and they are answered differently:
 *
 *   A TRANSFER OPENED IT. §5.4 records the recipient on the `transferred` row,
 *   typed, in the same transaction as the transfer. That row is the chain's own
 *   statement of where the version went, and it is the ONLY thing this function
 *   will accept for such a chain. If the statement is absent or does not parse,
 *   the answer is `null` — the chain contributes nothing at all.
 *
 *   NOBODY TRANSFERRED IT. The recipient asked for the version itself, so there
 *   is no transfer event and there never was one. The recipient is the receipt
 *   shell's own adopter, written once when the chain began and INSERT-only by
 *   trigger. That is not a fallback from a broken statement: it is the only
 *   statement this kind of chain ever makes.
 *
 * WHAT IT IS NOT ALLOWED TO BE. It used to return `row.recipient` for BOTH,
 * which meant a `transferred` event with a corrupt payload was answered from
 * somewhere it did not name — fail-open, and with the wrong source printed
 * beside the number. Never `adoption_requests`, in either branch: that is the
 * one mutable table in this path.
 */
function recipientOf(row: PairRow): { id: string; from: RecipientSource } | null {
  if (row.transfer_event_id !== null) {
    if (row.transferred_to === null) return null;
    try {
      const id = JSON.parse(row.transferred_to)?.id;
      if (typeof id === "string" && id.length > 0) return { id, from: RECIPIENT_SOURCE_EVENT };
    } catch {
      // an unreadable declaration is not a recipient, and nothing stands in
      // for it: this chain contributes zero
    }
    return null;
  }
  return { id: row.recipient, from: RECIPIENT_SOURCE_SHELL };
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
    if (recipient === null) {
      // [I-6] fail-closed: no migration, no recipient, no runtime. Counted so
      // that a dropped chain is visible as a dropped chain.
      acc.unattributed += 1;
      continue;
    }
    const key = `${row.version}\u0000${recipient.id}`;
    let runtimes = acc.pairs.get(key);
    if (runtimes === undefined) {
      runtimes = new Set<string>();
      acc.pairs.set(key, runtimes);
      acc.from.set(recipient.from, (acc.from.get(recipient.from) ?? 0) + 1);
    }
    acc.recipients.add(recipient.id);
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
    const acc = bySkill.get(subject.skill_id) ?? emptyAccumulator();
    const c = counters(acc);
    return {
      skill_id: subject.skill_id,
      slug: subject.slug,
      migrations: c.migrations,
      distinct_recipients: c.distinct_recipients,
      distinct_runtimes: c.distinct_runtimes,
      runtimes: c.runtimes,
      runtimes_unknown: c.runtimes_unknown,
      recipients_unattributed: c.recipients_unattributed,
      recipient_sources: c.recipient_sources,
      measurement_state: c.migrations > 0 ? "migrated" : "not_migrated",
      // [I-3]: the source of THIS row's numbers, derived from the journals this
      // row's recipients were actually read from — never a constant.
      source: sourceOf(acc),
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

/** The same totals WITH the source phrase they were obtained from [I-3]. */
export function migrationTotalsWithSource(
  db: Db,
  window: MigrationWindow = ALL_TIME,
): { counters: MigrationCounters; source: string } {
  const acc = emptyAccumulator();
  accumulate(selectPairs(db, window), () => acc);
  return { counters: counters(acc), source: sourceOf(acc) };
}
