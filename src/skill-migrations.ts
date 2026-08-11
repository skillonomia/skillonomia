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
// WHO THE RECIPIENT IS, AND WHERE THAT COMES FROM. A movement is opened either
// by a SENDER naming a typed recipient (§5.4) or by the RECIPIENT asking for the
// version itself (§5.2), and each writes its own event in the transaction that
// opens the chain: `transferred` for the push, `requested` for the pull. Both
// carry the typed recipient in `recipient_json`, and this counter reads it from
// there and from nowhere else.
//
// It used to read the pull half from `adoption_receipts.adopter_agent_id` — the
// receipt SHELL. That column is INSERT-only, so nothing was rewritable, and the
// number was right. It was still the wrong place: the shell is not
// `receipt_events`, and the sentence this surface is specified by says every
// count is computed from `receipt_events`. A rule that holds for push chains and
// silently does not hold for pull chains is a rule the next reader applies to
// the half it does not cover. `0009` moved the fact, exactly as `0004` moved the
// declared environment, and the sentence is now literally true: no query in this
// file selects a recipient from any table but the journal.
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
// The same posture covers a chain that carries NO recipient event at all —
// which, on an instance upgraded across `0009`, is every chain opened before it.
// No recipient is invented for those: a back-fill would be the registry writing
// today an event asserting what it did not record then, and `0004` refused that
// for the declared environment on the identical reasoning. They are dropped and
// REPORTED, not counted from a second journal and not silently omitted.
//
// [I-3], AND THE SOURCE THAT MUST NAME THE TRUTH. `source` used to be one
// constant naming `receipt_events`, printed on every row whatever the row was
// counted from — so a `migrations` figure whose (version, recipient) keys came
// half from the receipt shell still published `receipt_events` as its source.
// A number that names a source it was not obtained from is [I-3]'s failure with
// an attribution attached. `source` is now DERIVED from what each answer
// actually read, and names the opening events — `transferred`, `requested`, or
// both — that the counted recipients came off.
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

/** The recipient of a chain a SENDER opened: the `transferred` event's own
 *  `recipient_json` [I-6], §5.4. */
export const RECIPIENT_SOURCE_TRANSFER = "receipt_events.transferred";

/** …and of a chain the RECIPIENT opened for itself: the `requested` event's
 *  `recipient_json`, written in the same transaction as the request (§5.2). */
export const RECIPIENT_SOURCE_REQUEST = "receipt_events.requested";

/**
 * Where the recipient half of a (version, recipient) key was read from.
 *
 * Both members are rows of `receipt_events`. That is the point: there is no
 * longer a third possibility, and the ONLY thing this type still distinguishes
 * is WHICH KIND of opening event answered — a push or a pull. A reader who wants
 * the journal has it unconditionally; a reader who wants to know how the
 * movement started can still branch.
 */
export type RecipientSource = typeof RECIPIENT_SOURCE_TRANSFER | typeof RECIPIENT_SOURCE_REQUEST;

/**
 * THE SOURCE PHRASE, DERIVED FROM WHAT WAS READ — never a constant printed over
 * whatever happened [I-3].
 *
 * It names JOURNALS and carries NO FIGURE. A count inside a sentence has no
 * measurement state, no source and no window of its own, and this string is
 * rendered into a cell beside numbers that have all three; `recipient_sources`
 * carries the same fact structurally, for a reader that needs to branch on it.
 *
 * A `migrations` figure is a count of (version, recipient) keys, so WHERE the
 * recipient came from is half the provenance of the number. Every possibility is
 * now one journal — `receipt_events` — so the phrase always names it and then
 * says which OPENING EVENTS were read: a push's `transferred`, a pull's
 * `requested`, or both. The phrase is still derived rather than fixed, because a
 * derived phrase that happens to be constant today is a different thing from a
 * constant: the next event kind that carries a recipient changes what this
 * prints without anyone having to remember to change it.
 */
export function describeSource(read: { from_transfer: number; from_request: number }): string {
  const kinds: string[] = [];
  if (read.from_transfer > 0) kinds.push("`transferred` (§5.4, a sender opened the chain)");
  if (read.from_request > 0) kinds.push("`requested` (§5.2, the recipient opened it itself)");
  if (kinds.length === 0) return MIGRATION_SOURCE;
  return `${MIGRATION_SOURCE}; recipients read from ${kinds.join(" and ")}`;
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
   * Every chain states where the version was going, on the INSERT-only event
   * that opened it: `transferred` for a push, `requested` for a pull. When that
   * statement is missing, unparseable, or was never written at all — history
   * from before `0009` — the chain contributes NOTHING: no migration, no
   * recipient, no runtime, because the alternative is to answer from a source
   * the chain did not name. It is REPORTED rather than silently dropped: a
   * migration nobody could attribute and a migration that never happened are
   * different facts, and a reader who cannot tell them apart has been told
   * nothing.
   */
  recipients_unattributed: number;
  /** which OPENING EVENTS of the journal the counted recipients were actually
   *  read from [I-3] — every one of them a row of `receipt_events` */
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
  /** the opening events this row's recipients were read from [I-3] */
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
  ctx: string | null;
  /** the id of this chain's `transferred` event, or null when it has none.
   *  It is selected SEPARATELY from the payload so that "no transfer opened
   *  this chain" and "a transfer opened it and its statement is unreadable"
   *  are two different rows here, as they are two different facts [I-6]. */
  transfer_event_id: string | null;
  /** the `recipient_json` of that event — null when the event carried none */
  transferred_to: string | null;
  /** the same pair for the PULL half: the `requested` event this chain was
   *  opened with, and the recipient it named. */
  request_event_id: string | null;
  requested_to: string | null;
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
    from_transfer: acc.from.get(RECIPIENT_SOURCE_TRANSFER) ?? 0,
    from_request: acc.from.get(RECIPIENT_SOURCE_REQUEST) ?? 0,
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
      // NOTHING IN THIS SELECT LIST IS A RECIPIENT FROM OUTSIDE THE JOURNAL.
      // `adoption_receipts` appears only to reach the version and the events;
      // its `adopter_agent_id` — which this query used to select as the pull
      // half's recipient — is not read here or anywhere in this file. That
      // absence is what makes "every count is computed from `receipt_events`"
      // checkable rather than asserted.
      //
      // Neither recipient join carries a condition on `recipient_json`. One used
      // to, and that was the fail-open: an event whose payload was NULL dropped
      // out of the join and the chain then looked exactly like one no opening
      // event ever made a statement about, so a second source answered for a
      // statement the chain HAD made and could not read back [I-6].
      `SELECT DISTINCT v.skill_id AS skill_id, r.skill_version_id AS version,
              d.environment_json AS ctx,
              t.id AS transfer_event_id, t.recipient_json AS transferred_to,
              q.id AS request_event_id, q.recipient_json AS requested_to
         FROM adoption_receipts r
         JOIN skill_versions v ON v.id = r.skill_version_id
         JOIN receipt_events e ON e.adoption_receipt_id = r.id
         LEFT JOIN receipt_events d
                ON d.adoption_receipt_id = r.id AND d.event = 'delivered' AND d.environment_json IS NOT NULL
         LEFT JOIN receipt_events t
                ON t.adoption_receipt_id = r.id AND t.event = 'transferred'
         LEFT JOIN receipt_events q
                ON q.adoption_receipt_id = r.id AND q.event = 'requested'
        WHERE ${where.join(" AND ")}`,
    )
    .all(...params) as PairRow[];
}

/**
 * WHO RECEIVED IT — and WHICH EVENT SAID SO [I-6], [I-3].
 *
 * There are exactly two kinds of chain, each opens with its own event, and each
 * event is that chain's OWN statement of where the version was going:
 *
 *   A TRANSFER OPENED IT. §5.4 records the typed recipient on the `transferred`
 *   row, in the same transaction as the transfer.
 *
 *   THE RECIPIENT OPENED IT. §5.2 records the typed recipient on the
 *   `requested` row, in the same transaction as the request and the receipt
 *   shell. It is the same shape of fact written by the same registry in the same
 *   INSERT-only table; the two differ only in who decided.
 *
 * In BOTH branches an absent or unreadable statement answers `null`, and the
 * chain then contributes nothing at all. And a chain carrying NEITHER event —
 * an instance's history from before `0009` — also answers `null`: there is no
 * third place to look, by construction, because the function reads two columns
 * of one journal and nothing else.
 *
 * WHAT IT IS NOT ALLOWED TO BE. It used to answer the pull branch from
 * `adoption_receipts.adopter_agent_id`, and before that it answered BOTH from
 * there — which meant a `transferred` event with a corrupt payload was answered
 * from somewhere it did not name. Never `adoption_requests` either: that is the
 * one mutable table in this path.
 */
function recipientOf(row: PairRow): { id: string; from: RecipientSource } | null {
  const parse = (payload: string | null, from: RecipientSource): { id: string; from: RecipientSource } | null => {
    if (payload === null) return null;
    try {
      const id = JSON.parse(payload)?.id;
      if (typeof id === "string" && id.length > 0) return { id, from };
    } catch {
      // an unreadable declaration is not a recipient, and nothing stands in
      // for it: this chain contributes zero
    }
    return null;
  };
  if (row.transfer_event_id !== null) return parse(row.transferred_to, RECIPIENT_SOURCE_TRANSFER);
  if (row.request_event_id !== null) return parse(row.requested_to, RECIPIENT_SOURCE_REQUEST);
  return null;
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
