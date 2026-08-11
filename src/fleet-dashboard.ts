// §9 — THE FIVE SCREENS, MINIMAL VERSIONS, AND THE GUARDS THAT WATCH THE RENDER.
//
// WHY THIS MODULE EXISTS SEPARATELY FROM THE LOGIC IT SHOWS. Work 2's answers
// are honest: `unknown` is a value, a `no` the matrix forbids cannot be built, a
// number carries its method. None of that survives a renderer by itself. A
// template can take an honest answer and print it dishonestly — an `unknown` as
// a blank cell, a number stripped of its attribution, a `loaded` claimed under
// its own name, the intent column and the fact column merged into one to fit a
// phone. Every one of those is a lie told by the LAST hundred lines of the
// pipeline, and every one of them passes a test that checks the intermediate
// structure.
//
// So this module does two things, and the second is why it is worth reading:
//
//   1. it builds §9's five screens ([D-1]..[D-5]) out of the values work 2 and
//      work 5 already publish — reading §4's rules from `STATE_MATRIX` rather
//      than restating them, so the screen has no matrix of its own to drift;
//
//   2. it ships an AUDIT THAT RUNS OVER FINISHED BYTES. `auditRenderedHtml`
//      takes a page, `auditRenderedJson` takes a response body, and both
//      reconstruct the cells from what SHIPPED — the same text a person reads —
//      and hand them to work 2's own guards (`explicitLoadedClaim`,
//      `forbiddenNoClaim`, `missingAttribute`). A cell that a template
//      assembled by hand, bypassing the builders below, is caught by the same
//      sweep, because the sweep does not know or care which function produced a
//      cell: it reads the page.
//
// THE CELL GRAMMAR, and why a cell is verbose. Every answering cell carries its
// method IN THE TEXT, separated by ` · `:
//
//   unknown · why: no_paired_record · kind: state_column · column: invoked ·
//   is: observation · claim: explicit · reliability: reliable · state: invoked ·
//   runtime: codex · source: transcript · window: all_time · boundary: …
//
// [I-3] requires the three attributes to be VISIBLE TO A PERSON and not merely
// present in a JSON field nobody renders, so they are in the cell. `kind:` is
// what makes the audit possible over bytes: an answer without a `kind:` is an
// answer assembled outside these builders, and the sweep refuses it rather than
// skipping it — the failure mode "the guard was applied to the structure, so
// the hand-built cell was never seen" is the one this file is shaped against.
//
// WHAT IS DELIBERATELY NOT HERE. No database handle, no `service.ts` import, no
// filesystem. It takes values and returns sections, which is what lets a test
// mutate this file alone and prove the audit kills the mutant.
import {
  FLEET_RUNTIMES,
  SYNC_STATUSES,
  columnsOf,
  countedNumber,
  explicitLoadedClaim,
  forbiddenNoClaim,
  matrixCell,
  missingAttribute,
  unknownNumber,
  type AgentInventoryRow,
  type Attribution,
  type CapabilityState,
  type ColumnName,
  type DeadWeightAnswer,
  type FleetRuntime,
  type MeasuredNumber,
  type StateColumn,
  type SyncStatus,
  type Trivalent,
} from "./fleet.ts";
import type { Cell, DashboardNotice, DashboardSection } from "./dashboard.ts";

// =========================================================================
// The grammar of a cell
// =========================================================================

/** The separator between a cell's answer and the parts of its method. */
export const SEP = " · ";

/**
 * THE ONLY PLACE A `Cell` IS MADE.
 *
 * Every constructor below ends here, and nothing else in the codebase can: the
 * brand on `Cell` is a `unique symbol` declared in `src/dashboard.ts` and never
 * exported, so `mint` is the sole expression in the program whose type the
 * compiler will accept where a row value is required. A renderer, a template or
 * a service method holding a string — a slug, a count, a hex figure, a fraction
 * — has NO WAY TO SPELL a row value out of it, in any notation, because the
 * refusal is about the TYPE and not about the text.
 *
 * `parts[0]` is the answer; everything after it is the method, and `kind:` is
 * among the parts every caller supplies. That token is the mark this function's
 * output carries into the rendered bytes, where `auditCells` requires it of
 * every cell it finds.
 */
function mint(parts: readonly string[]): Cell {
  return parts.join(SEP) as Cell;
}

/**
 * Texts a cell may NEVER be [I-1].
 *
 * `unknown` is a VALUE. A dash, an "n/a" or nothing at all is a renderer
 * declining to say which of the three answers it holds, and a reader supplies
 * the missing one themselves — almost always `no`.
 */
export const FORBIDDEN_CELL_TEXTS: readonly string[] = ["", "—", "–", "-", "n/a", "N/A", "na", "null", "undefined", "?"];

/** The three answers, as words. A cell prints one of these or a real value. */
export const TRIVALENT_WORDS: readonly string[] = ["yes", "no", "unknown"];

/** What kind of answer a cell is. Absent = not an answer, and then it may not
 *  LOOK like one either — see `auditCells`. */
export type CellKind = "state_column" | "measured_number" | "observation";

/** The column that carries §6's reconciliation state AND decides the row's
 *  colour. It is the one cell that is a closed-vocabulary token rather than an
 *  answer, and it is checked against that vocabulary. */
export const RECONCILIATION_FIELD = "reconciliation_state";

/**
 * Free text, reduced to something a cell can hold.
 *
 * Two jobs, and both are [I-1]: the separator is removed so a value cannot
 * forge a method key, and an empty result becomes the caller's explicit
 * `fallback` — which every caller states as a sentence about WHY there is
 * nothing, never as a dash.
 */
/** The boundary a receipt-backed rating was taken over. */
export const RATING_BOUNDARY = "ratings bound to a closed adoption receipt, all time; the scale is 1 to 5";

/** The boundaries the label cells of this file are read over. Written once,
 *  because a boundary repeated by hand is a boundary that drifts. */
export const ROSTER_BOUNDARY = "the workspace roster and its memberships, all time";
export const INVENTORY_BOUNDARY = "the inventory of this agent, as scanned under its configured root";
export const VERSIONS_BOUNDARY = "skill_versions (registry), all time";

export const APPROVALS_BOUNDARY = "approvals (registry journal), all time";
export const RECEIPT_BOUNDARY = "receipt_events (registry journal, INSERT-only), all time";

/** The NAME of a number standing beside it in a two-column table. */
export function metricCell(name: string): Cell {
  return labelCell("metric", name, "the name of the number in this row", "the row's own number cell states its method");
}

/** WHICH VERSION a row is about: the author's semantic version and the id this
 *  registry minted, together, because either alone answers half the question. */
export function versionCell(semantic: string | null, versionId: string | null): Cell {
  const parts = [`semantic: ${plain(semantic, "unknown")}`];
  if (versionId !== null) parts.push(`id: ${plain(versionId, "unknown")}`);
  return labelCell("version", parts.join(" | "), "recorded_by_the_registry", VERSIONS_BOUNDARY);
}

export function plain(v: unknown, fallback: string): string {
  const s = v === null || v === undefined ? "" : String(v);
  const cleaned = s
    .replace(/·/g, "|")
    // …AND THE MARK ITSELF. `·` alone was enough while `kind:` was only read as
    // documentation; it is not enough now that the sweep TREATS the mark as
    // proof a constructor made the cell. A rating note or a failure summary is
    // text a stranger wrote, and a stranger who could write `kind:` into one
    // would be writing the guard's own evidence. Neutralised rather than
    // refused, because a note is not a reason to fail a page.
    .replace(/kind:/gi, "kind|")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 ? fallback : cleaned;
}

/** A timestamp as a readable instant. Never a bare integer: a bare integer on a
 *  page is a number with no method, and the sweep refuses one [I-3]. */
export function instant(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** The same instant inside a longer sentence, where `null` would print itself. */
export function instantOr(ms: number | null | undefined, fallback: string): string {
  return instant(ms) ?? fallback;
}

function methodOf(a: Attribution): string {
  return [
    `state: ${a.state}`,
    `source: ${a.source}`,
    `window: ${a.window}`,
    `boundary: ${plain(a.window_detail, "no boundary was recorded")}`,
  ].join(SEP);
}

/**
 * ONE STATE CELL, from §4's own answer.
 *
 * Everything printed is read off the column work 2 built — including `claim`,
 * which comes from the MATRIX (`explicit`) and not from an opinion held here.
 * That is what makes `loaded` unclaimable by construction: the screen has no
 * table of its own to disagree with §4's.
 */
export function stateCell(c: StateColumn): Cell {
  const why = plain(c.reason, c.value === "yes" ? "observed" : "no_reason_recorded");
  return mint([
    c.value,
    `why: ${why}`,
    "kind: state_column",
    `column: ${c.column}`,
    `is: ${c.is}`,
    `claim: ${matrixCell(c.state, c.runtime).explicit ? "explicit" : "reported"}`,
    `reliability: ${c.reliability}`,
    // WHICH of §4's two column sets this cell belongs to. It is in the cell and
    // not merely in the table's caption, because the sweep rebuilds the cell
    // from the page and the matrix rule it must apply — can this cell ever say
    // `no`? — is a property of the (state, runtime) PAIR.
    `runtime: ${c.runtime}`,
    methodOf(c),
  ]);
}

/** ONE NUMBER, with the three attributes [I-3] and never as a bare figure. */
export function numberCell(n: MeasuredNumber): Cell {
  const answer = n.measurement_state === "counted" && n.value !== null ? String(n.value) : "unknown";
  const why = plain(n.reason, n.measurement_state === "counted" ? "counted" : "no_reason_recorded");
  return mint([answer, `why: ${why}`, "kind: measured_number", methodOf(n)]);
}

/**
 * ONE OBSERVATION that is not one of §4's six states and not a count — a model
 * name, a session flag, the last failure, a rating.
 *
 * It carries a method for the same reason a number does: a reader holding one
 * row must be able to tell "nothing was reported" from "there was nothing".
 */
export function observationCell(input: {
  observation: string;
  answer: string | null;
  why: string;
  source: string;
  window: string;
  boundary: string;
}): Cell {
  // THE ONE PATH THAT TAKES FREE TEXT, AND WHAT IT GUARANTEES.
  //
  // Everything else a caller can reach takes a typed value: a `MeasuredNumber`,
  // a `StateColumn`, a member of §6's closed vocabulary. This constructor takes
  // a sentence, because a model name, a session flag and a failure summary are
  // sentences.
  //
  // WHAT IT DOES NOT DO IS JUDGE WHETHER THE SENTENCE IS A QUANTITY, and the
  // omission is deliberate. Three rounds died on that question: `.75`, `⅔`,
  // `٤٫٥`, `1:2`, `1×10³`, `5‰`, `0x10`, `12·5` — and, on the other side,
  // `1.0.0`, which is a version and not a count, and
  // `2026-08-10T00:00:00.000Z`, which is an instant. No test on the TEXT
  // separates those two lists, and a fourth attempt would be the same mistake
  // with a longer pattern.
  //
  // It does not need to. Two things are true of whatever this path is handed,
  // and neither depends on reading it:
  //
  //   * IT COMES OUT WITH ITS METHOD — the observation it answers, its source,
  //     its selection window, its boundary. A figure handed to this path is
  //     published as an attributed observation, never as a bare value, because
  //     there is no expression in this program that produces a bare one.
  //   * IT CANNOT FORGE A METHOD. `plain` has already turned `·` into `|` and
  //     `kind:` into `kind|`, so an answer cannot write the separator the
  //     method is parsed by or the mark the sweep reads as proof of a builder.
  //     Both halves are defined in this file, so that set is closed by
  //     construction rather than by enumeration.
  const answer = plain(input.answer, "unknown");
  return mint([
    answer,
    `why: ${plain(input.why, "no_reason_recorded")}`,
    "kind: observation",
    `observation: ${input.observation}`,
    `source: ${plain(input.source, "none")}`,
    `window: ${plain(input.window, "all_time")}`,
    `boundary: ${plain(input.boundary, "no boundary was recorded")}`,
  ]);
}

/**
 * Text that would write a cell's own method — the separator it is parsed by, or
 * the mark the sweep reads as proof a builder made the cell.
 *
 * Nothing that has been through `plain` can satisfy this, which is the point:
 * it is the property `plain` is there to remove, stated so a test can assert it
 * of every answer this file publishes rather than trusting the replacement.
 */
export function forgesMethod(answer: string): boolean {
  return /(?:^|·\s)kind:/.test(answer) || answer.includes(SEP.trim());
}

/**
 * A LABEL — a name, an identifier, a token this registry holds — published as a
 * cell, because everything on a page is a cell.
 *
 * There is no "plain" row value any more: a slug, a version and a decision each
 * arrive with the same method a state or a number does, and they arrive through
 * the SAME free-text constructor, so this convenience adds no path of its own.
 */
export function labelCell(observation: string, answer: string | null, why: string, boundary: string): Cell {
  return observationCell({ observation, answer, why, source: "registry", window: "all_time", boundary });
}

/** The [I-5] cell: WHO, and WHAT KIND OF PRINCIPAL they are. */
export function principalCell(input: {
  agent_id: string;
  type: string | null;
  role: string | null;
  observation?: string;
  source: string;
}): Cell {
  const role = plain(input.role, "unknown");
  const kind =
    role === "owner"
      ? "workspace_owner"
      : role === "unknown"
        ? "unknown: no workspace role is recorded for this principal"
        : `role_holder (${role})`;
  return observationCell({
    observation: input.observation ?? "principal",
    answer: `${plain(input.agent_id, "unknown")} | type: ${plain(input.type, "unknown")} | role: ${role} | principal: ${kind}`,
    why: "recorded_by_the_registry",
    source: input.source,
    window: "all_time",
    boundary: "the workspace roster and its memberships, all time [I-5]",
  });
}

/**
 * THE ONE CELL THAT IS A TOKEN AND NOT AN ANSWER: §6's reconciliation state,
 * which is also the row's CSS class and therefore its colour.
 *
 * It carries no method because it is not an answer about a capability — it is a
 * word out of a CLOSED VOCABULARY the code defines, and the vocabulary is what
 * takes the method's place. That makes it the narrowest path in this file:
 * `SYNC_STATUSES` has five members, the type refuses everything else at compile
 * time, and this function refuses it again at run time, so no quantity in any
 * notation can be spelled through it. `auditCells` checks the value on the page
 * against the same vocabulary rather than against the cell grammar — a stricter
 * test than the one every other cell gets, not a looser one.
 */
export function reconciliationCell(status: SyncStatus): Cell {
  if (!(SYNC_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `[D-1] refused: \`${String(status)}\` is not one of §6's reconciliation states (${SYNC_STATUSES.join("|")}) — ` +
        "the colour of a row is the state of the reconciliation, and a word outside the vocabulary encodes something else",
    );
  }
  return status as string as Cell;
}

// =========================================================================
// THE AUDIT — over finished bytes, never over the structure that made them
// =========================================================================

export interface RenderViolation {
  where: string;
  problem: string;
}

export interface RenderAudit {
  /** how many cells were examined — a sweep over nothing proves nothing */
  cells: number;
  rows: number;
  state_cells: number;
  number_cells: number;
  /** cells carrying the mark only a constructor sets */
  constructed: number;
  /** cells carrying NO constructor mark. The invariant is that this is 0. */
  unconstructed: number;
  violations: RenderViolation[];
}

interface ParsedCell {
  text: string;
  header: string;
  where: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** The text a PERSON sees in a cell: tags removed, entities restored. */
export function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** One method key out of a cell's own text. */
export function cellAttr(text: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|·\\s)${key}:\\s*([^·]*)`).exec(text);
  return m ? m[1].trim() : undefined;
}

/** The answer part: everything before the first method key. */
function answerOf(text: string): string {
  const i = text.indexOf(SEP);
  return (i < 0 ? text : text.slice(0, i)).trim();
}

/**
 * A FIGURE, IN THE NOTATIONS LISTED BELOW — AND NOT A UNIVERSAL CLAIM.
 *
 * READ THIS BEFORE TRUSTING IT. Two rounds tried to make this pattern the guard
 * that [I-3] needs, and both failed the same way. The first recognised a number
 * only when the ENTIRE cell was digits, so `steps: 4 | files: 7` walked past it.
 * The second recognised a standalone run of digits and stopped there, so
 * `<td>4.5</td>` walked past it. The third inverted the rule — every token that
 * is a figure in "any notation", minus a short exclusion list — and a reviewer
 * answered it with `.75`, `⅔`, `٤٫٥`, `1:2`, `1×10³`, `5‰`, `0x10` and `12·5`
 * inside a week. Each round widened the pattern to the last example it was
 * shown, and each time the claim in this comment stayed universal while the code
 * under it stayed finite. THE SET OF NOTATIONS A PERSON CAN WRITE A NUMBER IN IS
 * NOT ENUMERABLE, so no pattern here will ever be the thing that closes [I-3].
 *
 * WHAT CLOSES IT IS ONE LAYER UP, AND IT IS STRUCTURAL. A value reaches a reader
 * only inside a `Cell`, a `Cell` exists only where a constructor above returned
 * one, and every constructor attaches the method its kind requires. So a figure
 * on a page — in `.75`, in `٤٫٥`, in a notation invented tomorrow — arrives
 * carrying its source, its selection window and its boundary, because there is
 * no expression in this program that puts a bare value in a row. `auditCells`
 * enforces that over the finished bytes by demanding the constructor's mark of
 * EVERY cell it finds, whatever the cell says.
 *
 * WHAT THIS PATTERN IS FOR, THEN. One narrower question, and it is a question of
 * JUDGEMENT rather than of escape: did an author put a count inside a cell of
 * the wrong KIND — a figure in an observation, where a `measured_number` with a
 * measurement state belonged? A pattern is the right tool for a heuristic and
 * the wrong tool for an invariant. It catches the notations named in
 * `test/p14-r2-invariants.test.ts`'s corpus and it does not claim to catch the
 * ones it has not been shown; the invariant does not rest on it.
 */

/** The numeric notations this heuristic knows. Written as one grammar so a
 *  shape cannot be forgotten by being implemented somewhere else. */
const GROUPED_DIGITS = String.raw`\d{1,3}(?:[  ,'_]\d{3})+`;
const NUMBER_TOKEN = new RegExp(
  // sign · (grouped | plain) · fraction part · exponent · percent
  String.raw`^[+−-]?(?:${GROUPED_DIGITS}|\d+)(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?$`,
);
/** …and a ratio, which is two counts and therefore twice a figure. */
const FRACTION_TOKEN = /^[+−-]?\d+\/\d+$/;

/**
 * THE EXCLUSIONS. Each one is a value that is written with digits and is NOT a
 * count, so [I-3] has nothing to require of it. Each is narrow — it demands a
 * distinctive shape or sigil, never merely "has a letter next to it" — and each
 * carries the reason it is here. Anything not on this list that looks like a
 * figure IS a figure.
 */
export const NOT_A_COUNT: ReadonlyArray<{ name: string; pattern: RegExp; why: string }> = [
  {
    name: "ulid",
    pattern: /^[0-9A-HJKMNP-TV-Z]{26}$/,
    why: "an identifier of exactly 26 Crockford base32 characters; it names a row, and no reader adds two of them",
  },
  {
    name: "all_digit_ulid",
    pattern: /^\d{26}$/,
    why: "the degenerate ULID whose 26 characters happen to be digits — still an identifier, and the only reason the rule above is not enough",
  },
];

/** True when a token that LOOKS like a figure is one of the listed non-counts. */
function excludedFromCounting(token: string): boolean {
  return NOT_A_COUNT.some((e) => e.pattern.test(token));
}

/**
 * Tokens, with the punctuation a sentence wraps them in removed.
 *
 * `§`, `[`…`]`-with-a-letter and `-` INSIDE a token are deliberately NOT
 * stripped: `§5.3` is a section, `[I-3]` is an invariant, `2026-08-10T…Z` is an
 * instant, `1.0.0` is a semantic version, `sha256:…` is a digest, `v2` is a
 * revision and `dogfood-01-echo-token` is a slug — none of them survives the
 * grammar above once its non-numeric characters are left in place, which is why
 * none of them needs an exclusion of its own. Only the punctuation a figure can
 * genuinely be wrapped in — brackets, quotes, and terminal sentence marks — is
 * taken off.
 */
function tokensOf(text: string): string[] {
  return text
    .split(/[\s|]+/)
    .map((t) => t.replace(/^[([{«"'`]+/, "").replace(/[)\]}»"'`.,;:!?]+$/, ""))
    .filter((t) => t.length > 0);
}

/**
 * Every figure in `text`, in the order it is written.
 *
 * The name is kept from the sweep it replaces: callers ask "which numbers does
 * this cell publish", and the answer used to be "the integers I recognise".
 */
export function embeddedNumbers(text: string): string[] {
  const out: string[] = [];
  for (const token of tokensOf(text)) {
    if (!NUMBER_TOKEN.test(token) && !FRACTION_TOKEN.test(token)) continue;
    if (excludedFromCounting(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * A `state_column` cell text, back into the shape work 2's guards take.
 *
 * It is rebuilt FROM THE PAGE. Nothing here reaches into the structure the
 * renderer held; if the page says `no` where the object said `unknown`, this is
 * the `no` that gets checked.
 */
function stateColumnFromText(text: string): StateColumn | null {
  const value = answerOf(text);
  if (!TRIVALENT_WORDS.includes(value)) return null;
  const state = cellAttr(text, "state");
  const runtime = cellAttr(text, "runtime");
  if (state === undefined || runtime === undefined) return null;
  const claim = cellAttr(text, "claim");
  return {
    column: (cellAttr(text, "column") ?? "") as ColumnName,
    runtime: runtime as FleetRuntime,
    value: value as Trivalent,
    reason: cellAttr(text, "why") ?? null,
    is: (cellAttr(text, "is") ?? "observation") as "observation" | "intent",
    explicit: claim === "explicit",
    reliability: (cellAttr(text, "reliability") ?? "reliable") as StateColumn["reliability"],
    observability: "observable",
    state: state as CapabilityState,
    source: (cellAttr(text, "source") ?? "") as StateColumn["source"],
    window: (cellAttr(text, "window") ?? "") as StateColumn["window"],
    window_detail: cellAttr(text, "boundary") ?? "",
  };
}

/**
 * THE SWEEP. Every cell of a shipped answer, whatever produced it.
 *
 * The order of the checks is the order of the failures they exist for:
 *
 *   1. A BLANK CELL, or a dash, or an "n/a" [I-1]. The cheapest lie on a page.
 *   2. A BARE NUMBER [I-3] — a figure with no state, no source and no boundary,
 *      in the notations the pattern below knows. The two disagreements this
 *      project is built around were both this.
 *   3. A CELL WITH NO CONSTRUCTOR MARK, whatever it says. This is the one that
 *      does not depend on recognising anything: every builder stamps `kind:`,
 *      the type system admits no other way to make a row value, so a cell
 *      without the mark was assembled outside them and is REFUSED — not
 *      skipped, which is what round 3 did with everything that was not one of
 *      the three words. `constructed` and `unconstructed` are the numbers this
 *      check is reported by, and the invariant is that the second is zero.
 *   4. `explicitLoadedClaim`, `forbiddenNoClaim`, `missingAttribute` — work 2's
 *      own guards, applied to the cells reconstructed from the bytes.
 *
 * ONE CELL IS EXEMPT FROM 3 AND CHECKED HARDER: the `reconciliation_state`
 * token, which is a member of §6's closed vocabulary and is verified against
 * that vocabulary instead. Five permitted words is a narrower gate than any
 * method, not a wider one.
 */
/** The method keys whose value may legitimately contain digits: the two that
 *  STATE THE SELECTION. Everything else in a cell's method is prose, and a
 *  figure in prose is a count nobody can check. */
export const BOUNDARY_KEYS: readonly string[] = ["window", "boundary"];

/** Every figure written into a cell's method text, with the key it hid in. */
export function methodFigures(text: string): Array<{ key: string; figure: string }> {
  const out: Array<{ key: string; figure: string }> = [];
  const i = text.indexOf(SEP);
  if (i < 0) return out;
  for (const part of text.slice(i + SEP.length).split("·")) {
    const m = /^\s*([a-z_]+):([\s\S]*)$/.exec(part);
    if (m === null) continue;
    const key = m[1]!;
    if (BOUNDARY_KEYS.includes(key)) continue;
    for (const figure of embeddedNumbers(m[2]!)) out.push({ key, figure });
  }
  return out;
}

/** The kinds a constructor stamps. A `kind:` outside this set was written by
 *  something that is not one of them. */
export const CELL_KINDS: readonly CellKind[] = ["state_column", "measured_number", "observation"];

export function auditCells(cells: readonly ParsedCell[]): RenderAudit {
  const violations: RenderViolation[] = [];
  const columns: StateColumn[] = [];
  let numbers = 0;
  let constructed = 0;
  let unconstructed = 0;
  for (const cell of cells) {
    const text = cell.text;
    // THE COUNT FIRST, BEFORE ANY OTHER QUESTION. `constructed` and
    // `unconstructed` are the numbers the structural claim is made of, so they
    // are taken of EVERY cell — including the ones a later check refuses and
    // stops looking at. A cell that leaves this loop early still leaves it
    // counted, or the totals would describe a subset and read as if they
    // described the page.
    const mark = cellAttr(text, "kind") as CellKind | undefined;
    const isConstructed =
      cell.header === RECONCILIATION_FIELD
        ? (SYNC_STATUSES as readonly string[]).includes(text)
        : mark !== undefined && CELL_KINDS.includes(mark);
    if (isConstructed) constructed += 1;
    else unconstructed += 1;
    if (FORBIDDEN_CELL_TEXTS.includes(text)) {
      violations.push({
        where: cell.where,
        problem: `a cell is blank or a placeholder (${JSON.stringify(text)}): \`unknown\` is a value and is never rendered as nothing [I-1]`,
      });
      continue;
    }
    // THE WHOLE CELL IS A FIGURE — recognised by the SAME rule that finds a
    // figure inside one, so the two guards cannot disagree about what a number
    // is. It used to be its own `/^\d+$/`, which meant an identifier written
    // entirely in digits was a violation here and not a violation one separator
    // to the right.
    const whole = embeddedNumbers(text);
    if (whole.length === 1 && whole[0] === text) {
      violations.push({
        where: cell.where,
        problem: `a bare number \`${text}\` with no state, source or selection boundary [I-3]`,
      });
      continue;
    }
    const kind = cellAttr(text, "kind") as CellKind | undefined;
    const answer = answerOf(text);
    // …and the ANSWER on its own, because a placeholder does not stop being one
    // by having a method appended to it: `— · why: … · source: …` is still a
    // dash where one of the three answers belongs [I-1].
    if (FORBIDDEN_CELL_TEXTS.includes(answer)) {
      violations.push({
        where: cell.where,
        problem: `the ANSWER part of a cell is a placeholder (${JSON.stringify(answer)}): \`unknown\` is a value [I-1]`,
      });
      continue;
    }
    // THE ONE CELL THAT IS A TOKEN AND NOT AN ANSWER: the reconciliation state,
    // which is also the row's CSS class. It is checked against §6's CLOSED
    // vocabulary instead of against the cell grammar — a stricter test, not a
    // looser one, and `auditReconciliationColour` then ties it to the colour.
    if (cell.header === RECONCILIATION_FIELD) {
      if (!(SYNC_STATUSES as readonly string[]).includes(text)) {
        violations.push({
          where: cell.where,
          problem: `\`${text}\` is not one of §6's reconciliation states (${SYNC_STATUSES.join("|")})`,
        });
      }
      continue;
    }
    // ===================================================================
    // THE STRUCTURAL RULE: NOTHING REACHED THIS PAGE PAST A CONSTRUCTOR.
    // ===================================================================
    //
    // Every cell carries `kind:`, because every constructor stamps it and
    // there is no other way to obtain a row value — the type refuses one. So a
    // cell WITHOUT the mark was not built by a constructor, and it is refused
    // HERE, before anything is asked about what it says.
    //
    // That order is the fix. The sweep used to reach this question last and
    // ask it only of cells that said `yes`/`no`/`unknown`; everything else with
    // no `kind:` fell through to a `continue` and was never seen. A reviewer
    // walked `.75`, `⅔`, `٤٫٥`, `1:2`, `1×10³`, `5‰`, `0x10` and `12·5` through
    // that gap, one notation at a time, and every one of them is refused now —
    // not because the figure pattern learned eight more shapes, but because
    // none of the eight carries a method, and a cell with no method is not a
    // cell this program can produce. The notation stopped mattering.
    if (kind === undefined || !CELL_KINDS.includes(kind)) {
      violations.push({
        where: cell.where,
        problem:
          `a cell with no \`kind:\` of the cell builders (${JSON.stringify(text.slice(0, 60))}): it was assembled outside them, ` +
          "so it carries no source, no selection window and no boundary, and no guard ever saw it [I-3]",
      });
      continue;
    }
    // A NUMBER INSIDE A CELL IS STILL A NUMBER [I-3]. Whatever else this cell
    // is, a figure in its ANSWER is a count, and a count that is not in a
    // `measured_number` cell is a figure with no measurement state. The two
    // cells that got past the first sweep — `steps: N | files: N` and `declared
    // steps: N` — were exactly this, and `4.5` got past the second.
    if (kind !== "measured_number") {
      const embedded = embeddedNumbers(answer);
      if (embedded.length > 0) {
        numbers += embedded.length;
        violations.push({
          where: cell.where,
          problem: `a bare number \`${embedded[0]}\` embedded in a \`${kind ?? "plain"}\` cell: a count is published as a number cell with its state, source and boundary, or not at all [I-3]`,
        });
        continue;
      }
    }
    // …AND SO IS A NUMBER IN THE METHOD. A figure moved out of the answer and
    // into `why:` is still published, still read, and now has neither its own
    // state nor its own source — a count inside a sentence, which is the thing
    // [I-3] exists to refuse. The answer half of this sweep was passed by
    // putting the number one separator to the right, so the sweep covers both.
    //
    // TWO KEYS ARE EXEMPT, and they are the two where a figure is not a count
    // but the STATEMENT OF A BOUNDARY: `window` and `boundary` are where [I-3]
    // requires the selection to be named, and a window named in milliseconds is
    // that requirement being met rather than evaded.
    const methodNumbers = methodFigures(text);
    if (methodNumbers.length > 0) {
      violations.push({
        where: cell.where,
        problem: `a bare number \`${methodNumbers[0]!.figure}\` inside the cell's \`${methodNumbers[0]!.key}:\` method text: a count moved out of the answer is still a count, and still has no state, source or boundary of its own [I-3]`,
      });
      continue;
    }
    if (kind === "state_column") {
      const parsed = stateColumnFromText(text);
      if (parsed === null) {
        violations.push({ where: cell.where, problem: `a \`state_column\` cell that is not one: ${JSON.stringify(text.slice(0, 120))}` });
        continue;
      }
      const missing = missingAttribute(parsed);
      if (missing !== null) {
        violations.push({ where: cell.where, problem: `a state cell lost its \`${missing}\` [I-3]` });
      }
      // the runtime decides WHICH of §4's two column sets this cell belongs to,
      // so a cell naming no runtime of the matrix is not a cell §4 can rule on
      if (!(FLEET_RUNTIMES as readonly string[]).includes(parsed.runtime)) {
        violations.push({ where: cell.where, problem: `a state cell names no runtime of §4's matrix: \`${parsed.runtime}\`` });
        continue;
      }
      if (missing !== null) continue;
      columns.push(parsed);
      continue;
    }
    if (kind === "measured_number") {
      numbers += 1;
      // a figure, or the word. A rating average is a measured number too, so a
      // decimal is a figure; anything else is prose wearing a number's clothes.
      if (!/^\d+(?:\.\d+)?$/.test(answer) && answer !== "unknown") {
        violations.push({ where: cell.where, problem: `a number that is neither a figure nor \`unknown\`: ${JSON.stringify(answer)}` });
      }
      const missing = missingAttribute({
        state: cellAttr(text, "state"),
        source: cellAttr(text, "source"),
        window: cellAttr(text, "window"),
        window_detail: cellAttr(text, "boundary"),
      });
      if (missing !== null) {
        violations.push({ where: cell.where, problem: `a number lost its \`${missing}\` — a figure with no method is not published [I-3]` });
      }
      continue;
    }
    // an observation: not one of §4's six states, but still never a bare word
    for (const key of ["observation", "source", "window", "boundary"]) {
      const v = cellAttr(text, key);
      if (v === undefined || v.length === 0) {
        violations.push({ where: cell.where, problem: `an observation lost its \`${key}\`` });
      }
    }
  }
  const loaded = explicitLoadedClaim(columns);
  if (loaded !== null) violations.push({ where: "the rendered answer", problem: `[§4] ${loaded}` });
  const forbidden = forbiddenNoClaim(columns);
  if (forbidden !== null) violations.push({ where: "the rendered answer", problem: `[A-0] ${forbidden}` });
  return {
    cells: cells.length,
    rows: 0,
    state_cells: columns.length,
    number_cells: numbers,
    constructed,
    unconstructed,
    violations,
  };
}

interface ParsedTable {
  headers: string[];
  rows: Array<{ cls: string | null; cells: string[] }>;
}

/** The tables of a rendered page, as headers and rows of visible text. */
export function parseTables(html: string): ParsedTable[] {
  const out: ParsedTable[] = [];
  for (const table of html.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
    const body = table[1]!;
    const headers = [...body.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => cellText(m[1]!));
    const rows: ParsedTable["rows"] = [];
    for (const tr of body.matchAll(/<tr(?:\s+class="([^"]*)")?>([\s\S]*?)<\/tr>/g)) {
      const cells = [...tr[2]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellText(m[1]!));
      if (cells.length === 0) continue;
      rows.push({ cls: tr[1] ?? null, cells });
    }
    out.push({ headers, rows });
  }
  return out;
}

/**
 * [I-2] — THE TWO COLUMNS, AND THE PROOF THEY WERE NOT MERGED.
 *
 * The distinction is carried by the COLUMN NAME: `intent_*` is what this
 * registry decided, `fact_*` is what a runtime or a disk reported. A table that
 * publishes one of them publishes both, no header carries both tokens, and the
 * cell under a name must AGREE with it — an intent cell under a `fact_` header
 * is the merge wearing two names, and it is caught here.
 */
function auditIntentFact(table: ParsedTable, where: string, violations: RenderViolation[]): void {
  const intent = table.headers.filter((h) => h.startsWith("intent_"));
  const fact = table.headers.filter((h) => h.startsWith("fact_"));
  for (const h of table.headers) {
    if (h.includes("intent") && h.includes("fact")) {
      violations.push({ where: `${where}/${h}`, problem: "one column named for BOTH the intent and the fact: the two columns are never merged [I-2]" });
    }
  }
  if (intent.length > 0 && fact.length === 0) {
    violations.push({ where, problem: "a table publishes the intent column and no fact column: both are always visible [I-2]" });
  }
  if (fact.length > 0 && intent.length === 0) {
    violations.push({ where, problem: "a table publishes the fact column and no intent column: both are always visible [I-2]" });
  }
  for (const row of table.rows) {
    for (let i = 0; i < table.headers.length && i < row.cells.length; i++) {
      const header = table.headers[i]!;
      const text = row.cells[i]!;
      const kind = cellAttr(text, "kind");
      const isIntent = header.startsWith("intent_");
      const isFact = header.startsWith("fact_");
      if (!isIntent && !isFact) continue;
      if (kind === "state_column") {
        const is = cellAttr(text, "is");
        if (isIntent && is !== "intent") {
          violations.push({ where: `${where}/${header}`, problem: `an \`${is}\` cell under an intent column [I-2]` });
        }
        if (isFact && is !== "observation") {
          violations.push({ where: `${where}/${header}`, problem: `an \`${is}\` cell under a fact column [I-2]` });
        }
      } else if (kind === "measured_number") {
        const source = cellAttr(text, "source");
        if (isIntent && source !== "registry") {
          violations.push({ where: `${where}/${header}`, problem: `an intent number read from \`${source}\`, which is not this registry's journal [I-2]` });
        }
        if (isFact && source === "registry") {
          violations.push({ where: `${where}/${header}`, problem: "a fact number read from the registry's own journal: that is the intent column answering for the fact column [I-2]" });
        }
      }
    }
  }
}

/**
 * [D-1] — WHAT THE COLOUR MEANS, PROVEN FROM THE PAGE.
 *
 * §9 says it in as many words: "the colour means the state of the
 * reconciliation, and not an abstract `all is well`". So the class of a row is
 * required to be `row-<x>` where `<x>` is a member of §6's reconciliation
 * vocabulary AND is the value standing in that row's own
 * `reconciliation_state` cell. A palette word — `ok`, `green`, `healthy` — is
 * not in the vocabulary and does not survive this, and neither does a class
 * that disagrees with the cell beside it.
 */
function auditReconciliationColour(table: ParsedTable, where: string, violations: RenderViolation[]): void {
  const i = table.headers.indexOf(RECONCILIATION_FIELD);
  if (i < 0) return;
  const intentAt = table.headers.indexOf("intent_assigned");
  const factAt = table.headers.indexOf("fact_invoked");
  const figure = (cell: string | undefined): number | null => {
    if (cell === undefined) return null;
    const answer = answerOf(cell);
    return /^\d+$/.test(answer) ? Number(answer) : null;
  };
  for (const row of table.rows) {
    const value = (row.cells[i] ?? "").trim();
    if (!(SYNC_STATUSES as readonly string[]).includes(value)) {
      violations.push({ where, problem: `\`${value}\` is not one of §6's reconciliation states (${SYNC_STATUSES.join("|")})` });
      continue;
    }
    if (row.cls === null) {
      violations.push({ where, problem: `a fleet row carries no colour at all: the reconciliation state \`${value}\` is not encoded [D-1]` });
      continue;
    }
    if (row.cls !== `row-${value}`) {
      violations.push({
        where,
        problem: `the row's colour is \`${row.cls}\` while its reconciliation state is \`${value}\`: the colour encodes something other than the state of the reconciliation [D-1]`,
      });
    }
    // THE CROSS-CHECK, and the reason it is here rather than in a comment.
    //
    // A colour that agrees with the word beside it is still a lie if the word
    // itself is a mood. So the state is RE-DERIVED from the two numbers ON THE
    // SAME ROW — the intent column and the fact column, each with its own
    // source — against §6's own rule: `in_sync` means every deployment intended
    // active has an observed arrival, and an agent with nothing intended has
    // nothing to be in sync WITH. A screen that paints "nothing has failed" as
    // green fails this, because the numbers it printed itself do not support it.
    const intent = figure(row.cells[intentAt]);
    const fact = figure(row.cells[factAt]);
    if (intent === null || fact === null) continue;
    if (intent === 0 && (value === "in_sync" || value === "pending")) {
      violations.push({
        where,
        problem: `\`${value}\` for a row whose intent column is 0: nothing was intended active, so nothing was reconciled — the colour encodes something other than the state of the reconciliation [D-1]`,
      });
    }
    if (value === "in_sync" && fact < intent) {
      violations.push({
        where,
        problem: `\`in_sync\` for a row whose fact column (${fact}) is below its intent column (${intent}): the two numbers on this row do not support the colour [D-1]`,
      });
    }
  }
}

/** THE WHOLE PAGE: every cell, every table, and the two structural rules. */
export function auditRenderedHtml(html: string): RenderAudit {
  const tables = parseTables(html);
  const cells: ParsedCell[] = [];
  const violations: RenderViolation[] = [];
  let rows = 0;
  tables.forEach((table, t) => {
    const where = `table#${t}`;
    rows += table.rows.length;
    table.rows.forEach((row, r) => {
      row.cells.forEach((text, c) => {
        cells.push({ text, header: table.headers[c] ?? `col#${c}`, where: `${where}/row#${r}/${table.headers[c] ?? `col#${c}`}` });
      });
    });
    auditIntentFact(table, where, violations);
    auditReconciliationColour(table, where, violations);
  });
  const swept = auditCells(cells);
  return { ...swept, rows, violations: [...violations, ...swept.violations] };
}

/**
 * THE SAME SWEEP OVER THE JSON BODY.
 *
 * The two adapters serve ONE answer, so the JSON carries the same cell texts
 * the page does and the same parser reads them. What this adds over the page is
 * the shape: a row VALUE that is not a string at all — a null, a number, an
 * object — is a value the renderer would have to invent a rendering for, and
 * `renderValue` renders a null as a dash [I-1].
 */
export function auditRenderedJson(text: string): RenderAudit {
  const violations: RenderViolation[] = [];
  const cells: ParsedCell[] = [];
  let rows = 0;
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return { cells: 0, rows: 0, state_cells: 0, number_cells: 0, constructed: 0, unconstructed: 0, violations: [{ where: "body", problem: "the response body is not JSON" }] };
  }
  for (const section of (payload?.sections ?? []) as any[]) {
    for (const [r, row] of ((section?.rows ?? []) as any[]).entries()) {
      rows += 1;
      // EVERY MEMBER OF THE ROW, not only the ones the section declared.
      //
      // The sweep used to walk `section.fields`, which is the table's HEADER
      // list — so a member the renderer put in the row and the section did not
      // announce was served to the client and audited by nobody. That is the
      // same failure the HTML sweep had in its first form: a guard over a subset
      // chosen by the thing being guarded. The union is taken in the declared
      // order first, so the output still reads in the order the table does, and
      // a declared field MISSING from the row is a violation of its own rather
      // than a silent skip.
      const declared = (section?.fields ?? []) as string[];
      const present = row === null || typeof row !== "object" ? [] : Object.keys(row);
      const fields = [...declared, ...present.filter((k) => !declared.includes(k))];
      for (const field of fields) {
        const where = `${payload?.view}/${section?.key}/row#${r}/${field}`;
        if (!present.includes(field)) {
          violations.push({
            where,
            problem: `the section declares the field \`${field}\` and the row does not carry it: a column with no value renders as a blank cell [I-1]`,
          });
          continue;
        }
        const value = row?.[field];
        if (typeof value !== "string") {
          violations.push({
            where,
            problem: `a row value is \`${value === null ? "null" : typeof value}\` and not a rendered string: a null renders as a dash, and a dash is a blank cell [I-1]`,
          });
          continue;
        }
        cells.push({ text: value, header: field, where });
      }
    }
  }
  const swept = auditCells(cells);
  return { ...swept, rows, violations: [...violations, ...swept.violations] };
}

/**
 * [D-3] — THE HONEST ABSENCE.
 *
 * The approval screen is missing two things on purpose: the draft inbox with
 * its `parameter / personal context / secret / non-transferable` marking and
 * its redaction preview ([B-2]/[B-3], work 9), and the register of refusals
 * ([B-5], work 10). §9 forbids BOTH failure modes — imitating them, and
 * rendering an empty block that reads as "we looked and found nothing".
 *
 * So the rule has two halves and needs both: a `capability_absent` notice for
 * each, AND no section anywhere on the view whose key or field names one of
 * them. An empty `drafts` table plus a notice would still be an empty `drafts`
 * table.
 */
export const ABSENT_APPROVAL_CAPABILITIES: readonly string[] = ["drafts", "redaction", "rejected"];

export function auditAbsentCapabilities(text: string): RenderViolation[] {
  const violations: RenderViolation[] = [];
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return [{ where: "body", problem: "the response body is not JSON" }];
  }
  const declared = ((payload?.notices ?? []) as any[]).filter((n) => n?.kind === "capability_absent");
  for (const capability of ABSENT_APPROVAL_CAPABILITIES) {
    const named = declared.some(
      (n) => String(n?.subject ?? "").includes(capability) || String(n?.detail ?? "").includes(capability),
    );
    if (!named) {
      violations.push({
        where: `${payload?.view}/notices`,
        problem: `\`${capability}\` is not built and the screen does not say so: an absent capability is not an empty result [I-1]`,
      });
    }
    for (const section of (payload?.sections ?? []) as any[]) {
      const names = [String(section?.key ?? ""), ...((section?.fields ?? []) as string[])];
      if (names.some((n) => n.includes(capability))) {
        violations.push({
          where: `${payload?.view}/${section?.key}`,
          problem: `a table for \`${capability}\`, which does not exist: an empty table reads as "nothing found", which is a claim about the data [I-1]`,
        });
      }
    }
  }
  return violations;
}

// =========================================================================
// [D-1] THE FLEET
// =========================================================================

/** The colour legend, on the page, beside the thing it decodes. */
export const RECONCILIATION_LEGEND: DashboardNotice = {
  kind: "legend",
  subject: "what the colour of a fleet row means",
  detail:
    "The colour of a row is the STATE OF THE RECONCILIATION between what this registry intends (the `intent_` columns, read from the assignment journal) and what a runtime or a disk reported (the `fact_` columns). It is not a health indicator. " +
    "`unknown` (grey) means nothing was compared — an agent nothing has ever reported about is NOT in sync, it is unobserved. " +
    "`pending` (amber) means deployments intended active have no observed arrival: unobserved, NOT known to be absent. " +
    "`drifted` and `failed` (orange, red) are recorded by the deployment journal. " +
    "`in_sync` (green) means every deployment intended active has an observed arrival, and nothing more than that.",
};

export interface FleetAgentInput {
  agent: AgentInventoryRow;
  /** [A-5]'s answer for this agent: the filesystem number and the intent beside it */
  dead_weight: DeadWeightAnswer;
  /** the last deployment event that recorded a failure, if any */
  last_failure: { state: string; at_ms: number; reason: string | null; slug: string } | null;
  /** the last rating this principal recorded, if any */
  last_feedback: { score: number; at_ms: number; note: string | null; slug: string } | null;
}

export interface FleetViewInput {
  agents: FleetAgentInput[];
  counts: { agents: MeasuredNumber; observed_agents: MeasuredNumber };
}

export const FLEET_FIELDS = [
  "agent",
  "principal",
  "runtime",
  "model",
  "session_active",
  "last_activity",
  "intent_assigned",
  "fact_available",
  "fact_invoked",
  "reconciliation_state",
  "reconciliation",
  "last_failure",
  "last_feedback_score",
  "last_feedback",
];

export function fleetSections(input: FleetViewInput): DashboardSection[] {
  const rows = input.agents.map((a) => {
    const agent = a.agent;
    return {
      agent: labelCell(
        "agent",
        `${plain(agent.name, "unnamed")} | id: ${plain(agent.agent_id, "unknown")}`,
        "recorded_by_the_registry",
        ROSTER_BOUNDARY,
      ),
      principal: principalCell({
        agent_id: agent.agent_id,
        type: agent.type,
        role: agent.role,
        observation: "principal",
        source: "registry",
      }),
      runtime: observationCell({
        observation: "runtime",
        answer: agent.runtime,
        why: agent.runtime === null ? "no runtime has been observed and none is configured" : `read_from: ${agent.runtime_source}`,
        source: agent.runtime_source,
        window: "all_time",
        boundary: agent.observation_window,
      }),
      model: observationCell({
        observation: "model",
        answer: agent.model,
        why: agent.model === null ? "no runtime observation carries a model" : "reported_by_the_runtime",
        source: agent.model === null ? "none" : "runtime",
        window: "all_time",
        boundary: agent.observation_window,
      }),
      session_active: observationCell({
        observation: "session_active",
        answer: agent.session_active,
        why: agent.session_active === "unknown" ? "no runtime observation has been reported" : "reported_by_the_runtime",
        source: agent.session_active === "unknown" ? "none" : "runtime",
        window: "live_session",
        boundary: agent.observation_window,
      }),
      last_activity: observationCell({
        observation: "last_activity",
        answer: instant(agent.last_activity_ms),
        why: agent.last_activity_ms === null ? "no runtime observation carries an activity time" : "reported_by_the_runtime",
        source: agent.last_activity_ms === null ? "none" : "runtime",
        window: "all_time",
        boundary: agent.observation_window,
      }),
      intent_assigned: numberCell(agent.intent_active),
      fact_available: numberCell(a.dead_weight.registered),
      fact_invoked: numberCell(agent.observed_arrival_yes),
      reconciliation_state: reconciliationCell(agent.sync_status),
      reconciliation: observationCell({
        observation: "reconciliation",
        answer: agent.sync_status_reason,
        why: `comparison_of: intent_assigned and fact_invoked (${agent.sync_status_is})`,
        source: "registry",
        window: "all_time",
        boundary: agent.observation_window,
      }),
      last_failure:
        a.last_failure === null
          ? observationCell({
              observation: "last_failure",
              answer: null,
              why: "no deployment event recording a failure or a drift exists for this agent",
              source: "registry",
              window: "all_time",
              boundary: "assignment_events (registry journal, INSERT-only), all time",
            })
          : observationCell({
              observation: "last_failure",
              answer: `${a.last_failure.state} | ${plain(a.last_failure.slug, "unknown skill")} | ${instantOr(a.last_failure.at_ms, "no time was recorded")}`,
              why: plain(a.last_failure.reason, "the journal recorded no reason"),
              source: "registry",
              window: "all_time",
              boundary: "assignment_events (registry journal, INSERT-only), all time",
            }),
      // [I-3]: the SCORE is a number and is published as one. It used to ride
      // inside the sentence as `score N of 5`, where it carried no measurement
      // state — and the sweep, which recognised a number only when the whole
      // cell was digits, never looked at it.
      last_feedback_score: numberCell(
        a.last_feedback === null
          ? registryUnknown("outcome", RATING_BOUNDARY, "this principal has recorded no rating")
          // the SCALE lives in the boundary, which is where a method belongs;
          // "out of 5" in the reason was a figure in prose with no state of its
          // own, which is the same defect one separator to the right
          : registryCount(a.last_feedback.score, "outcome", RATING_BOUNDARY, "the most recent rating this principal recorded"),
      ),
      last_feedback:
        a.last_feedback === null
          ? observationCell({
              observation: "last_feedback",
              answer: null,
              why: "this principal has recorded no rating",
              source: "registry",
              window: "all_time",
              boundary: RATING_BOUNDARY,
            })
          : observationCell({
              observation: "last_feedback",
              answer: `${plain(a.last_feedback.slug, "unknown skill")} | ${instantOr(a.last_feedback.at_ms, "no time was recorded")} | the score is the \`last_feedback_score\` cell of this row`,
              why: plain(a.last_feedback.note, "the rating carried no note"),
              source: "registry",
              window: "all_time",
              boundary: RATING_BOUNDARY,
            }),
    };
  });

  return [
    {
      key: "fleet",
      title: "[D-1] Every agent: what the registry INTENDS, what was REPORTED, and the state of the reconciliation",
      note:
        "The two columns are never merged: `intent_*` is read from the assignment journal, `fact_*` from a disk or from runtime records. " +
        "The colour of a row is the reconciliation state in the `reconciliation_state` cell, and nothing else.",
      fields: FLEET_FIELDS,
      rows,
      empty: "no principal of this workspace is readable by this actor",
      row_class_field: "reconciliation_state",
    },
    {
      key: "fleet_counts",
      title: "How many principals, and how many of them anything has ever reported about",
      fields: ["metric", "number"],
      rows: [
        { metric: metricCell("principals readable by this actor"), number: numberCell(input.counts.agents) },
        { metric: metricCell("principals with at least one runtime observation"), number: numberCell(input.counts.observed_agents) },
      ],
      empty: "nothing was counted",
    },
  ];
}

// =========================================================================
// [D-2] THE AGENT
// =========================================================================

/** The column name a state gets on the page: the intent column is named for
 *  what it is, and so is every fact column [I-2]. */
export function fieldOfColumn(column: ColumnName): string {
  return column === "assigned" ? "intent_assigned" : `fact_${column}`;
}

export interface AgentCapabilityInput {
  kind: string;
  name: string;
  runtime: FleetRuntime | null;
  skill_version_id: string | null;
  semantic_version: string | null;
  columns: StateColumn[];
  /** where this capability came to be here: a transfer, or a disk with no
   *  matching assignment */
  origin: string;
  assigned_by: { agent_id: string; type: string; role: string } | null;
  assigned_at_ms: number | null;
  last_invoked_ms: number | null;
  last_invoked_reason: string;
  observation_window: string;
}

export interface AgentViewInput {
  agents: Array<{
    agent: AgentInventoryRow;
    columns_reason: string | null;
    capabilities: AgentCapabilityInput[];
    dead_weight: DeadWeightAnswer;
    dead_items: Array<{ kind: string; name: string; skill_version_id: string | null; reason: string }>;
  }>;
}

const IDENTITY_FIELDS = ["agent", "kind", "name", "origin", "version", "assigned_by", "assigned_at", "last_invoked"];

function capabilityIdentity(agent: AgentInventoryRow, c: AgentCapabilityInput): Record<string, Cell> {
  return {
    agent: labelCell(
      "agent",
      `${plain(agent.name, "unnamed")} | id: ${plain(agent.agent_id, "unknown")}`,
      "recorded_by_the_registry",
      ROSTER_BOUNDARY,
    ),
    kind: labelCell("kind", c.kind, "the kind of capability this row is", INVENTORY_BOUNDARY),
    name: labelCell("name", c.name, "the name this capability carries on the disk", INVENTORY_BOUNDARY),
    origin: observationCell({
      observation: "origin",
      answer: c.origin,
      why: "where_this_capability_came_from",
      source: "registry",
      window: "all_time",
      boundary: "the transfer and assignment journals, all time",
    }),
    version: observationCell({
      observation: "version",
      answer:
        c.skill_version_id === null
          ? null
          : `${plain(c.semantic_version, "no semantic version is recorded")} | id: ${c.skill_version_id}`,
      why: c.skill_version_id === null ? "the copy on the disk carries no marker this workspace can resolve to a version" : "resolved_from_the_arrival_marker",
      source: c.skill_version_id === null ? "filesystem" : "registry",
      window: "all_time",
      boundary: "the versions of this workspace, resolved by §5 arrival marker",
    }),
    assigned_by:
      c.assigned_by === null
        ? observationCell({
            observation: "assigned_by",
            answer: null,
            why: "no assignment of this capability to this agent is recorded",
            source: "registry",
            window: "all_time",
            boundary: "assignments (registry journal, INSERT-only), all time",
          })
        : principalCell({
            agent_id: c.assigned_by.agent_id,
            type: c.assigned_by.type,
            role: c.assigned_by.role,
            observation: "assigned_by",
            source: "registry",
          }),
    assigned_at: observationCell({
      observation: "assigned_at",
      answer: instant(c.assigned_at_ms),
      why: c.assigned_at_ms === null ? "no assignment of this capability to this agent is recorded" : "recorded_by_the_assignment_journal",
      source: "registry",
      window: "all_time",
      boundary: "assignments (registry journal, INSERT-only), all time",
    }),
    last_invoked: observationCell({
      observation: "last_invoked",
      answer: instant(c.last_invoked_ms),
      why: c.last_invoked_reason,
      source: c.last_invoked_ms === null ? "none" : "transcript",
      window: "all_time",
      boundary: c.observation_window,
    }),
  };
}

export function agentSections(input: AgentViewInput): DashboardSection[] {
  const sections: DashboardSection[] = [];
  // ONE TABLE PER RUNTIME, because §4's two runtimes publish DIFFERENT COLUMN
  // SETS. Rendering them as one table with blanks where a runtime has no such
  // column would put a blank cell on the page, which is the one thing [I-1]
  // forbids — and would quietly assert the two are the same table.
  for (const runtime of ["claude_code", "codex"] as const) {
    const columns = columnsOf(runtime);
    const rows: Array<Record<string, Cell>> = [];
    for (const entry of input.agents) {
      for (const c of entry.capabilities) {
        if (c.runtime !== runtime) continue;
        const row: Record<string, Cell> = capabilityIdentity(entry.agent, c);
        for (const column of columns) {
          const cell = c.columns.find((x) => x.column === column);
          row[fieldOfColumn(column)] = cell
            ? stateCell(cell)
            : observationCell({
                observation: `column_${column}`,
                answer: null,
                why: "this runtime published no cell for this column",
                source: "none",
                window: "all_time",
                boundary: c.observation_window,
              });
        }
        rows.push(row);
      }
    }
    sections.push({
      key: `capabilities_${runtime}`,
      title: `[D-2] Capabilities on \`${runtime}\`, with §4's six states — ${runtime === "claude_code" ? "`proposed` splits into a live answer and an unreliable historical one" : "`proposed` is one column and its value is `unknown` always [A-0]"}`,
      note: `§4's two runtimes publish different column sets, so they are two tables and not one table with a flag. \`loaded\` is REPORTED and never claimed: every cell of it says \`claim: reported\`.`,
      fields: [...IDENTITY_FIELDS, ...columns.map(fieldOfColumn)],
      rows,
      empty: `no capability of any readable agent runs on \`${runtime}\``,
    });
  }

  const unknownRows: Array<Record<string, Cell>> = [];
  for (const entry of input.agents) {
    for (const c of entry.capabilities) {
      if (c.runtime !== null) continue;
      unknownRows.push({
        ...capabilityIdentity(entry.agent, c),
        columns_reason: observationCell({
          observation: "columns_reason",
          answer: null,
          why: plain(entry.columns_reason, "no runtime has been observed for this agent and none is configured"),
          source: "none",
          window: "all_time",
          boundary: entry.agent.observation_window,
        }),
      });
    }
  }
  sections.push({
    key: "capabilities_runtime_unknown",
    title: "[D-2] Capabilities whose runtime is not established — no column set of §4 applies, and none is guessed",
    note: "WHICH columns exist is a property of the runtime. An agent no runtime has been observed for gets no state columns at all, with the reason in the row — not a table of blanks [I-1].",
    fields: [...IDENTITY_FIELDS, "columns_reason"],
    rows: unknownRows,
    empty: "every readable capability belongs to an agent whose runtime is established",
  });

  const deadRows: Array<Record<string, Cell>> = [];
  const countRows: Array<Record<string, Cell>> = [];
  for (const entry of input.agents) {
    const who = labelCell(
      "agent",
      `${plain(entry.agent.name, "unnamed")} | id: ${plain(entry.agent.agent_id, "unknown")}`,
      "recorded_by_the_registry",
      ROSTER_BOUNDARY,
    );
    for (const item of entry.dead_items) {
      deadRows.push({
        agent: who,
        kind: labelCell("kind", item.kind, "the kind of capability this row is", INVENTORY_BOUNDARY),
        name: labelCell("name", item.name, "the name this capability carries on the disk", INVENTORY_BOUNDARY),
        version: labelCell(
          "version",
          item.skill_version_id === null ? null : `id: ${item.skill_version_id}`,
          "resolved_from_the_arrival_marker",
          VERSIONS_BOUNDARY,
        ),
        reason: labelCell("reason", item.reason, "why this copy counts as dead weight", INVENTORY_BOUNDARY),
      });
    }
    countRows.push({ agent: who, metric: metricCell("registered under the inventory root"), number: numberCell(entry.dead_weight.registered) });
    countRows.push({ agent: who, metric: metricCell("registered AND demonstrated to have run"), number: numberCell(entry.dead_weight.invoked) });
    countRows.push({ agent: who, metric: metricCell("registered with no paired call/output record"), number: numberCell(entry.dead_weight.dead) });
    countRows.push({ agent: who, metric: metricCell("intended active by this registry (published for comparison, never merged)"), number: numberCell(entry.dead_weight.intent_active) });
  }
  sections.push({
    key: "never_used",
    title: "[A-5] Registered, and never once demonstrated to have run",
    note:
      "This is counted from RECORDS and never from what this registry decided. `never_invoked` means no paired call/output record carrying this version's marker was found — unobserved, NOT known to be unused [I-1].",
    fields: ["agent", "kind", "name", "version", "reason"],
    rows: deadRows,
    empty: "no capability is registered for a readable agent, so nothing could be dead weight",
  });
  sections.push({
    key: "never_used_counts",
    title: "The numbers [A-5] is made of, each with its state, its source and its selection boundary",
    fields: ["agent", "metric", "number"],
    rows: countRows,
    empty: "no readable agent has an inventory to count",
  });
  return sections;
}

// =========================================================================
// [D-3] REGISTER AS A SKILL — the meaning, the approver, and what is absent
// =========================================================================

export const APPROVAL_NOTICES: readonly DashboardNotice[] = [
  {
    kind: "capability_absent",
    subject: "the drafts inbox and its redaction preview ([B-2]/[B-3], work 9)",
    detail:
      "NOT BUILT. `skill.capture` and the inbox of drafts marked `parameter / personal context / secret / non-transferable`, with the preview of what would be redacted, are work 9 (P1) and do not exist in this build. " +
      "This screen shows no drafts and no redaction preview because THE CAPABILITY IS ABSENT, not because a search returned nothing: there is no drafts table on this page for exactly that reason [I-1].",
  },
  {
    kind: "capability_absent",
    subject: "the register of refusals ([B-5], work 10)",
    detail:
      "NOT BUILT. The register of rejected proposals — what was declined, by whom, and on what ground — is work 10 (P1) and does not exist in this build. " +
      "No rejected register is rendered here, empty or otherwise: an absent capability and an empty result are different facts [I-1].",
  },
];

export interface ApprovalSubjectInput {
  slug: string;
  skill_version_id: string;
  semantic_version: string;
  state: string;
  title: string | null;
  capability_statement: string | null;
  problem_class: string | null;
  prerequisites: string[];
  non_goals: string[];
  risk_level: string | null;
  sandbox_requirement: string | null;
  forbidden_actions: string[];
  secrets_policy: string | null;
  url_allowlist: string[];
  cloud_iam_assumptions: string[];
  mcp_dependencies: string[];
  step_count: number | null;
  file_count: number | null;
  required_approvals: string[];
  approval_state: string;
  manifest_readable: boolean;
}

export interface ApprovalDecisionInput {
  approval_id: string;
  slug: string;
  semantic_version: string;
  scope: string;
  decision: string;
  note: string | null;
  created_at_ms: number;
  approver: { agent_id: string; type: string; role: string | null };
}

export interface ApprovalViewInput {
  subjects: ApprovalSubjectInput[];
  decisions: ApprovalDecisionInput[];
  next_cursor?: string | null;
}

export function list(values: readonly string[], fallback: string): string {
  const cleaned = values.map((v) => plain(v, "")).filter((v) => v.length > 0);
  return cleaned.length === 0 ? fallback : cleaned.join(" | ");
}

/** The boundary every number read out of a signed manifest was taken over. */
const MANIFEST_BOUNDARY = "the version's manifest, as signed";

export function approvalSections(input: ApprovalViewInput): DashboardSection[] {
  const rows = input.subjects.map((s) => ({
    slug: labelCell("slug", s.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    version: versionCell(s.semantic_version, s.skill_version_id),
    state: labelCell("state", s.state, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    // [B-6] — WHAT IT DOES, in the author's own sentence. Not the manifest.
    what_it_does: labelCell("what_it_does", plain(
      s.title === null && s.capability_statement === null ? null : `${plain(s.title, "untitled")}: ${plain(s.capability_statement, "no capability statement")}`,
      s.manifest_readable ? "unknown: the manifest declares neither a title nor a capability statement" : "unknown: this version's manifest could not be read",
    ), "declared_by_the_manifest", MANIFEST_BOUNDARY),
    when_it_applies: labelCell("when_it_applies", plain(
      s.problem_class === null && s.prerequisites.length === 0
        ? null
        : `${plain(s.problem_class, "no problem class is declared")} | prerequisites: ${list(s.prerequisites, "none declared")}`,
      "unknown: this version declares neither a problem class nor a prerequisite",
    ), "declared_by_the_manifest", MANIFEST_BOUNDARY),
    rights_required: labelCell("rights_required", [
      `risk: ${plain(s.risk_level, "unknown")}`,
      `sandbox: ${plain(s.sandbox_requirement, "unknown")}`,
      `forbidden: ${list(s.forbidden_actions, "none declared")}`,
      `secrets: ${plain(s.secrets_policy, "no secrets policy is declared")}`,
      `network: ${list(s.url_allowlist, "no URL is allowlisted")}`,
      `cloud/iam: ${list(s.cloud_iam_assumptions, "none assumed")}`,
      `mcp: ${list(s.mcp_dependencies, "none declared")}`,
    ].join(" | "), "declared_by_the_manifest", MANIFEST_BOUNDARY),
    // [I-3]: WHAT WENT IN, as two NUMBERS rather than two figures inside a
    // sentence. They used to be rendered as `steps: N | files: N` in a plain
    // cell, which the sweep could not see as numbers at all — it recognised a
    // number only when the whole cell was digits, so this page audited clean
    // with `number_cells: 0` while carrying two unattributed counts.
    steps: numberCell(
      s.step_count === null
        ? registryUnknown("registered", MANIFEST_BOUNDARY, "this version's manifest declares no procedure step this registry can count")
        : registryCount(s.step_count, "registered", MANIFEST_BOUNDARY),
    ),
    files: numberCell(
      s.file_count === null
        ? registryUnknown("registered", MANIFEST_BOUNDARY, "this version's manifest declares no file list this registry can count")
        : registryCount(s.file_count, "registered", MANIFEST_BOUNDARY),
    ),
    // [B-6] — AND WHAT WAS DELIBERATELY LEFT OUT. The author's own non-goals,
    // shown beside what went in, because a reader approving a capability is
    // approving its boundary as much as its content.
    deliberately_excluded: labelCell(
      "deliberately_excluded",
      list(
        s.non_goals,
        s.manifest_readable ? "unknown: this version declares no non-goal, so its boundary is not stated" : "unknown: this version's manifest could not be read",
      ),
      "declared_by_the_manifest",
      MANIFEST_BOUNDARY,
    ),
    approval_required: labelCell(
      "approval_required",
      list(s.required_approvals, "none: this version declares no required approval"),
      "declared_by_the_manifest",
      MANIFEST_BOUNDARY,
    ),
    approval_state: labelCell("approval_state", s.approval_state, "recorded_by_the_approval_journal", APPROVALS_BOUNDARY),
  }));

  const decisions = input.decisions.map((d) => ({
    approval_id: labelCell("approval_id", d.approval_id, "recorded_by_the_approval_journal", APPROVALS_BOUNDARY),
    slug: labelCell("slug", d.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    version: versionCell(d.semantic_version, null),
    scope: labelCell("scope", d.scope, "recorded_by_the_approval_journal", APPROVALS_BOUNDARY),
    decision: labelCell("decision", d.decision, "recorded_by_the_approval_journal", APPROVALS_BOUNDARY),
    // [B-7] and [I-5]: WHO, and what KIND of principal they are. "approved by
    // the workspace owner" and "approved by a principal holding a role" are
    // different facts and are never printed as one.
    approved_by: principalCell({
      agent_id: d.approver.agent_id,
      type: d.approver.type,
      role: d.approver.role,
      observation: "approved_by",
      source: "registry",
    }),
    approved_at: observationCell({
      observation: "approved_at",
      answer: instant(d.created_at_ms),
      why: "recorded_by_the_approval_journal",
      source: "registry",
      window: "all_time",
      boundary: "approvals (registry journal), all time",
    }),
    note: labelCell("note", d.note, "recorded_by_the_approval_journal", APPROVALS_BOUNDARY),
  }));

  return [
    {
      key: "approval",
      title: "[D-3] Register as a skill — WHAT IT MEANS, not the manifest [B-6]",
      note:
        "Every column here is a sentence about the capability: what it does, when it applies, what rights it needs, what went in, and what its author deliberately left out. " +
        "The manifest JSON is not shown, and a reader is not asked to read one to approve.",
      fields: [
        "slug",
        "version",
        "state",
        "what_it_does",
        "when_it_applies",
        "rights_required",
        "steps",
        "files",
        "deliberately_excluded",
        "approval_required",
        "approval_state",
      ],
      rows,
      empty: "no version is visible to this actor",
      next_cursor: input.next_cursor,
    },
    {
      key: "decisions",
      title: "[B-7] Decisions already recorded, with the TYPE of the principal who made each [I-5]",
      note:
        "`approved by the workspace owner` and `approved by a principal holding a role` are different facts. The type and the role of the approver are on every row, always.",
      fields: ["approval_id", "slug", "version", "scope", "decision", "approved_by", "approved_at", "note"],
      rows: decisions,
      empty: "no approval decision is visible to this actor",
    },
  ];
}

// =========================================================================
// [D-4] THE CAPABILITY
// =========================================================================

export interface CapabilityVersionInput {
  skill_id: string;
  slug: string;
  skill_version_id: string;
  semantic_version: string;
  state: string;
  author_agent_id: string;
  created_at_ms: number;
  supersedes: string | null;
  /** the manifest sections that differ from the predecessor, or null when
   *  there is no predecessor to compare with */
  diff_sections: string[] | null;
  diff_reason: string;
  assigned_to: string[];
  worked: MeasuredNumber;
  broke: MeasuredNumber;
  rolled_back: MeasuredNumber;
  migrations: MeasuredNumber;
  rollback_steps: number | null;
}

export interface CapabilityViewInput {
  versions: CapabilityVersionInput[];
  next_cursor?: string | null;
}

export function capabilitySections(input: CapabilityViewInput): DashboardSection[] {
  const rows = input.versions.map((v) => ({
    slug: labelCell("slug", v.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    version: versionCell(v.semantic_version, v.skill_version_id),
    state: labelCell("state", v.state, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    origin: observationCell({
      observation: "origin",
      answer: `author: ${plain(v.author_agent_id, "unknown")} | created: ${instantOr(v.created_at_ms, "no time was recorded")} | supersedes: ${plain(v.supersedes, "nothing — this is the first version of this lineage")}`,
      why: "recorded_at_creation",
      source: "registry",
      window: "all_time",
      boundary: "skill_versions (registry), all time",
    }),
    diff: observationCell({
      observation: "diff_from_predecessor",
      answer: v.diff_sections === null ? null : v.diff_sections.length === 0 ? "no declared section differs" : v.diff_sections.join(" | "),
      why: plain(v.diff_reason, "no_reason_recorded"),
      source: "registry",
      window: "all_time",
      boundary: "the two manifests, compared section by section",
    }),
    assigned_to: observationCell({
      observation: "assigned_to",
      answer: v.assigned_to.length === 0 ? null : v.assigned_to.join(" | "),
      why: v.assigned_to.length === 0 ? "no assignment of this version is recorded" : "read_from_the_assignment_journal",
      source: "registry",
      window: "all_time",
      boundary: "assignments (registry journal, INSERT-only), all time",
    }),
    worked: numberCell(v.worked),
    broke: numberCell(v.broke),
    migrations: numberCell(v.migrations),
    // [I-3]: the declared rollback is a COUNT, and it is published as one.
    // It used to be `declared steps: N` inside an observation cell — a figure
    // with no measurement state, which the old sweep did not recognise as a
    // number and therefore never checked.
    rollback_steps: numberCell(
      v.rollback_steps === null
        ? registryUnknown("registered", MANIFEST_BOUNDARY, "this version declares no rollback procedure this registry can count")
        : registryCount(v.rollback_steps, "registered", MANIFEST_BOUNDARY, "the version's own declared rollback procedure"),
    ),
    rollback: observationCell({
      observation: "rollback",
      answer:
        v.rollback_steps === null
          ? null
          : "this version declares a rollback procedure; its length is the `rollback_steps` cell of this row",
      why: "performing a rollback is `skill.supersede` or `skill.revoke` and is not this screen",
      source: "registry",
      window: "all_time",
      boundary: MANIFEST_BOUNDARY,
    }),
    rolled_back: numberCell(v.rolled_back),
  }));
  return [
    {
      key: "capability",
      title: "[D-4] One capability across its versions: where it came from, who holds it, where it worked, where it broke",
      note:
        "`worked`, `broke`, `rolled_back` and `migrations` are counted from terminal receipt events (§5.3) — this registry's record of what adopters reported, over all time. None of them is a claim about a run nobody reported.",
      fields: [
        "slug",
        "version",
        "state",
        "origin",
        "diff",
        "assigned_to",
        "worked",
        "broke",
        "rolled_back",
        "migrations",
        "rollback_steps",
        "rollback",
      ],
      rows,
      empty: "no version is visible to this actor",
      next_cursor: input.next_cursor,
    },
  ];
}

// =========================================================================
// [D-5] RESULTS
// =========================================================================

export interface OutcomeVersionInput {
  slug: string;
  skill_version_id: string;
  semantic_version: string;
  state: string;
  worked: MeasuredNumber;
  broke: MeasuredNumber;
  rolled_back: MeasuredNumber;
  avg_rating: number | null;
  failure_modes: string[];
  verdict: "worked" | "needs_new_version" | "nothing_reported";
  verdict_reason: string;
}

export interface OutcomeReceiptInput {
  receipt_id: string;
  slug: string;
  derived_state: string;
  adopter_agent_id: string;
  at_ms: number;
  failure_summary: string | null;
  stalled: boolean;
}

export interface OutcomeViewInput {
  versions: OutcomeVersionInput[];
  receipts: OutcomeReceiptInput[];
  next_cursor?: string | null;
}

export function outcomeSections(input: OutcomeViewInput): DashboardSection[] {
  const rows = input.versions.map((v) => ({
    slug: labelCell("slug", v.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    version: versionCell(v.semantic_version, v.skill_version_id),
    state: labelCell("state", v.state, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    worked: numberCell(v.worked),
    broke: numberCell(v.broke),
    rolled_back: numberCell(v.rolled_back),
    // [I-3]: an average IS a measured number, `of 5` and all — the scale is in
    // the boundary, where a method belongs, and the figure carries its state.
    avg_rating: numberCell(
      v.avg_rating === null
        ? registryUnknown("outcome", RATING_BOUNDARY, "no receipt-backed rating has been recorded for this version")
        : { ...registryCount(0, "outcome", RATING_BOUNDARY, "receipt_backed_average"), value: v.avg_rating },
    ),
    failure_modes: labelCell(
      "failure_modes",
      list(v.failure_modes, "no failure mode has been reported"),
      "reported_by_adopters",
      RECEIPT_BOUNDARY,
    ),
    verdict: labelCell("verdict", v.verdict, "comparison_of_the_counted_outcomes", RECEIPT_BOUNDARY),
    why: observationCell({
      observation: "verdict",
      answer: v.verdict_reason,
      why: "comparison_of_the_counted_outcomes",
      source: "registry",
      window: "all_time",
      boundary: "receipt_events (registry journal, INSERT-only), all time",
    }),
  }));
  const receipts = input.receipts.map((r) => ({
    receipt_id: labelCell("receipt_id", r.receipt_id, "recorded_by_the_receipt_journal", RECEIPT_BOUNDARY),
    slug: labelCell("slug", r.slug, "recorded_by_the_registry", VERSIONS_BOUNDARY),
    derived_state: labelCell("derived_state", r.derived_state, "derived_from_the_receipt_journal", RECEIPT_BOUNDARY),
    adopter: labelCell("adopter", r.adopter_agent_id, "recorded_by_the_receipt_journal", RECEIPT_BOUNDARY),
    at: observationCell({
      observation: "last_event_at",
      answer: instant(r.at_ms),
      why: "recorded_by_the_receipt_journal",
      source: "registry",
      window: "all_time",
      boundary: "receipt_events (registry journal, INSERT-only), all time",
    }),
    stalled: labelCell(
      "stalled",
      r.stalled ? "yes — no terminal event within the staleness window" : "no — the chain is closed or still inside the window",
      "compared_against_the_staleness_window",
      RECEIPT_BOUNDARY,
    ),
    failure_summary: labelCell("failure_summary", r.failure_summary, "reported_by_the_adopter", RECEIPT_BOUNDARY),
  }));
  return [
    {
      key: "outcomes",
      title: "[D-5] What worked, what broke, and what needs a new version",
      note:
        "`nothing_reported` is a verdict of its own and is NOT `worked`: a version nobody has reported an outcome for has not been shown to work [I-1]. `needs_new_version` is a comparison of counted outcomes, never a judgement about a run.",
      fields: ["slug", "version", "state", "worked", "broke", "rolled_back", "avg_rating", "failure_modes", "verdict", "why"],
      rows,
      empty: "no version is visible to this actor",
      next_cursor: input.next_cursor,
    },
    {
      key: "outcome_receipts",
      title: "The chains those numbers were counted from, most recent first",
      fields: ["receipt_id", "slug", "derived_state", "adopter", "at", "stalled", "failure_summary"],
      rows: receipts,
      empty: "no adoption receipt is readable by this actor",
    },
  ];
}

// =========================================================================
// Small helpers the wiring needs, kept here so the numbers keep their method
// =========================================================================

/** A count over this registry's own journals [I-3]. */
export function registryCount(value: number, state: CapabilityState, boundary: string, reason: string | null = null): MeasuredNumber {
  return countedNumber(value, { state, source: "registry", window: "all_time", window_detail: boundary }, reason);
}

/** A number nothing was measured for, with the reason it was not [I-3]. */
export function registryUnknown(state: CapabilityState, boundary: string, reason: string): MeasuredNumber {
  return unknownNumber({ state, source: "registry", window: "all_time", window_detail: boundary }, reason);
}
