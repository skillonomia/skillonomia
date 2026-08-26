// THE PROOFLINE SURFACE'S OWN VOCABULARY — SHARED BY THE BUNDLE AND THE GATES.
//
// WHAT THIS FILE IS. The Console renders the eleven dashboard views the registry
// already serves (SPEC.md section 6.4). This file holds the two things that
// rendering needs and that must not be written twice: the GRAMMAR a serialized
// cell is read back with, and the exact WORDS the Console puts on the page that
// did not come from the server.
//
// WHAT IT IS NOT. It computes no eligibility, no verdict and no state. It does
// not know what a view means. `Registry.dashboard()` answers every question
// about the data and the Console draws the answer (INV-01, INV-02) — a second
// opinion here would be a second place for a view to say something the registry
// did not.
//
// WHY THE WORDS ARE CONSTANTS AND NOT STRING LITERALS AT A CALL SITE. Text on a
// dashboard is text a reader takes for a statement of fact. Every sentence this
// Console adds beside the registry's own — a busy state, a refusal, a partial
// warning — is declared here, once, so a gate can compare the bytes on the page
// against the bytes in this file rather than against a sentence somebody typed
// into a test. It is the rule `src/fleet-dashboard.ts` keeps for the notices the
// SERVER puts on a dashboard, applied to the ones the BROWSER adds.
//
// WHY THIS FILE HAS NO IMPORTS. It is bundled into the browser. A `node:` import
// anywhere in its transitive graph would end up in a browser build or fail it,
// so the separator below is DECLARED here and `test/v1p2-p2b-proofline.test.ts`
// asserts it is byte-identical to `SEP` in `src/fleet-dashboard.ts`. One source
// of truth, kept by a test rather than by an import that cannot cross this
// boundary.

// ===========================================================================
// The cell grammar, read back
// ===========================================================================

/** The separator between a cell's answer and the parts of its method. Equal to
 *  `SEP` in `src/fleet-dashboard.ts`, and a test says so. */
export const PROVENANCE_SEP = " · ";

/** What separates a method part's KEY from its value. */
export const PROVENANCE_KEY_SEP = ": ";

/**
 * The six pieces of provenance every dashboard value carries (SPEC.md section
 * 6.4), and where each is found in a serialized cell.
 *
 * `value` is the answer — `parts[0]`, and it is not a keyed attribute, which is
 * why it is `null` here rather than a key nobody would find. `bounds` is spelled
 * `boundary` in the cell grammar; the mapping is stated once, here, so a gate
 * asking "did the browser keep the bounds" and a builder writing them use one
 * name for one thing.
 */
export const PROVENANCE_FIELDS: ReadonlyArray<{ field: string; attr: string | null }> = [
  { field: "value", attr: null },
  { field: "kind", attr: "kind" },
  { field: "why", attr: "why" },
  { field: "source", attr: "source" },
  { field: "window", attr: "window" },
  { field: "bounds", attr: "boundary" },
];

/**
 * The ONE view the Console asks for before it has a navigation.
 *
 * Not a list — a bootstrap. The navigation is built from the `views` member the
 * server puts in every dashboard payload, so this is the single name needed to
 * obtain that vocabulary, and a view added to `DASHBOARD_VIEWS` appears in the
 * Console with no edit to the bundle. `test/v1p2-p2b-proofline.test.ts` asserts
 * it is a member of that array, so a rename cannot leave the Console asking for
 * a view the registry no longer serves.
 */
export const CONSOLE_FIRST_VIEW = "library";

/** One part of a cell's method: a key and its text, or an unkeyed part. A part
 *  with no `: ` is kept AS TEXT rather than dropped — dropping it is exactly the
 *  provenance loss this type exists to make impossible. */
export interface ProvenancePart {
  key: string | null;
  text: string;
}

/** A serialized cell, taken apart without losing a character of it. */
export interface ParsedCell {
  value: string;
  parts: ProvenancePart[];
}

/**
 * A cell's text → its answer and its method.
 *
 * LOSSLESS BY CONSTRUCTION: `formatCell(parseCell(t)) === t` for every string,
 * which is the property the provenance gate is asserted with. The answer is
 * `parts[0]` and is never split on a colon — an answer may legitimately contain
 * one (`unknown: no workspace role is recorded for this principal`), and a
 * splitter that took the first colon anywhere would silently turn half an answer
 * into an attribute name.
 */
export function parseCell(text: string): ParsedCell {
  const chunks = text.split(PROVENANCE_SEP);
  const value = chunks.length > 0 ? chunks[0] : "";
  const parts: ProvenancePart[] = [];
  for (const chunk of chunks.slice(1)) {
    const at = chunk.indexOf(PROVENANCE_KEY_SEP);
    if (at <= 0) {
      parts.push({ key: null, text: chunk });
    } else {
      parts.push({ key: chunk.slice(0, at), text: chunk.slice(at + PROVENANCE_KEY_SEP.length) });
    }
  }
  return { value, parts };
}

/** The inverse. The two together are what a gate compares against the bytes the
 *  server sent. */
export function formatCell(cell: ParsedCell): string {
  const method = cell.parts.map((p) => (p.key === null ? p.text : `${p.key}${PROVENANCE_KEY_SEP}${p.text}`));
  return [cell.value, ...method].join(PROVENANCE_SEP);
}

/** The value of one method attribute, or `null`. */
export function attrOf(cell: ParsedCell, attr: string): string | null {
  for (const p of cell.parts) if (p.key === attr) return p.text;
  return null;
}

// ===========================================================================
// INV-03 — unknown is not zero, and the four answers are four answers
// ===========================================================================

/**
 * The answers that must remain TELLABLE APART on the page.
 *
 * They are four different statements and collapsing any two of them is a lie in
 * a specific direction: `unknown` said as `0` claims a measurement nobody took,
 * `nothing_reported` said as `worked` claims a success nobody reported, and
 * `broke` said as `nothing_reported` hides one somebody did. The Console gives
 * each its own token in the DOM and its own visible word, so the distinction
 * survives a reader who cannot see colour and a gate that reads the markup.
 */
export const INV03_ANSWERS: readonly string[] = ["unknown", "nothing_reported", "worked", "broke"];

/**
 * The class token a rendered answer carries.
 *
 * It IS the answer, reduced to a token — not translated into a palette word.
 * The reason is the one `rowClassOf` gives in `src/dashboard.ts`: a mapping step
 * is where `unknown` quietly becomes `warning` and two answers land on one
 * class. An answer with no token of its own gets `answer-other`, which is a
 * class that claims nothing.
 */
export function answerToken(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9_]+/g, "-").slice(0, 40);
  return token.length === 0 ? "answer-other" : `answer-${token}`;
}

/** The texts a rendered answer may never be — the same list the server's own
 *  sweep refuses, restated for the browser because the browser is a second place
 *  a value can be flattened into nothing. */
export const FORBIDDEN_RENDERED_ANSWERS: readonly string[] = ["", "—", "–", "-", "n/a", "N/A", "na", "null", "undefined", "?"];

// ===========================================================================
// INV-07 — queued is not delivered
// ===========================================================================

/**
 * Words that assert an ARRIVAL.
 *
 * The Console does not add any of them to the `dead_letters` view. It cannot:
 * the view's two tables are two different facts (`DELIVERY_SEPARATION_LEGEND`,
 * `src/fleet-dashboard.ts`) and neither is evidence a notification arrived. This
 * list is what the gate checks the Console's OWN chrome against — the registry's
 * cells are rendered byte for byte and are not this file's business.
 */
export const DELIVERY_CLAIM_WORDS: readonly string[] = ["delivered", "arrived", "received", "notified", "sent"];

// ===========================================================================
// The words the Console adds
// ===========================================================================

/**
 * Every sentence the Proofline puts on the page that the server did not send.
 *
 * DECLARED, in one object, for the reason `APPROVAL_NOTICES` is declared: a
 * dashboard sentence is read as a statement of fact, and one that is not a
 * constant of this build is a sentence nobody compared against anything. The
 * gates assert the bytes on the page are these bytes.
 */
export const PROOFLINE_TEXT = {
  /** the region's heading */
  heading: "Proofline",
  /** the label of the view navigation */
  nav_label: "Views",
  /** shown while the first response for a view is outstanding (§7 initial loading) */
  loading: "Loading this view — no value below has been read yet.",
  /** the accessible busy announcement that accompanies it */
  busy: "busy",
  /** the label of the filter control */
  filter_label: "Filter",
  /** the action that removes a filter (§7 filtered-to-zero) */
  clear_filter: "Clear the filter and show every row",
  /** what a section says when a filter, not the data, emptied it */
  filtered_to_zero:
    "No row matches this filter. The rows are still there; the filter selected none of them. Clearing it shows them again.",
  /** the refusal the server returned, shown as the server's own (§7 permission denied) */
  forbidden_heading: "The server refused this view",
  /** a transport or server failure, with a bounded recovery (§7 network/server error) */
  error_heading: "This view could not be read",
  retry: "Retry loading this view",
  /** §7 partial: some values are unknown and the known ones stay on the page */
  partial_heading: "Partial: some values in this view are unknown",
  /** the legend under which every cell publishes its method */
  provenance_label: "the method behind this value",
} as const;

/**
 * The partial banner's sentence, with the two counts in it.
 *
 * A FUNCTION rather than a literal, because the numbers are facts about the
 * payload and a sentence assembled at the call site is a sentence the gate
 * cannot compare. It says what is still true — the known values are on the page
 * — because that is the whole content of the `partial` state: unknown is not a
 * reason to stop showing what is known.
 */
export function partialDetail(unknownCells: number, totalCells: number): string {
  return (
    `${unknownCells} of ${totalCells} values in this view are unknown and say so. ` +
    `The other ${totalCells - unknownCells} were read and are shown below with their method. ` +
    `An unknown value is not a zero and is not a failure.`
  );
}

/** The refusal's body: the server's own code and message, and nothing this
 *  build inferred from them. */
export function refusalDetail(code: string, message: string): string {
  return `${code}: ${message}`;
}
