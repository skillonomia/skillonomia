// P6 dashboard — the views the internal phase plan names (library, evidence,
// receipts, approvals, dead letters), plus the migration counter the registry
// exists to make countable, as a THIN READ LAYER over the
// service functions the earlier phases already ship. It computes nothing of its own: every value it
// shows is a field of an API response (search + registry view, receipt read,
// the approval matrix, `deadLetters()`, webhook health, `migrationCounts()`).
//
// Appendix H's `dashboard.view` row fixes what the envelope must be: the view
// names, the ACL scoping, `demo_mode`, and `fields` naming "the API fields
// of the numbered surfaces that the section's `rows` carry — the dashboard
// computes nothing of its own and is a rendering, never a second source of
// truth". The CHOICE of sections it deliberately leaves to the rendering, and
// ranking or visual polish is not a property of this format at all.
//
// So the contract this module implements is exactly that and nothing more:
//   * the views named as the internal phase plan names them,
//     `migrations` — the per-skill migration counter, which is a product
//     surface rather than a phase-plan view: the operator who installed this
//     registry has to be able to see whether anything ever migrated, and every
//     number on it states its source, its selection window and its state —
//     and §9's five screens ([D-1]..[D-5]), whose CONTENT is built in
//     `src/fleet-dashboard.ts` and whose two extra rendering devices (a section
//     `note`, a row class taken from a named field) live here;
//   * each view declares the API FIELDS it renders (`fields` on every section),
//     which makes "renders the corresponding API fields" a checkable property
//     rather than an opinion — a test asserts both the field names and the row
//     VALUES appear in the rendered output;
//   * the dead-letter view carries webhook health (status, failure_count,
//     last_error), because §5.2's "dead letters are loud, not silent" is worth
//     little if the operator cannot see the endpoint that stopped answering.
//
// Everything about WHO may see a row is decided in `src/service.ts` by the same
// visibility/ACL rules the underlying surfaces use — a dashboard that widened
// them would be an access-control bypass, not a view.

import { ApiError } from "./errors.ts";

export type DashboardView =
  | "library"
  | "evidence"
  | "receipts"
  | "approvals"
  | "dead_letters"
  | "migrations"
  | "fleet"
  | "agent"
  | "skill_approval"
  | "capability"
  | "outcomes";

/**
 * The views of the internal phase plan, in the order it lists them,
 * `migrations` after them — added later, and appended rather than inserted, so
 * the phase plan's own order stays readable — and then §9's five screens
 * ([D-1]..[D-5]), appended for the same reason.
 *
 * The §9 five are the MINIMAL versions: they carry every fact their §9 row
 * names, and where a part of a screen belongs to work that does not exist yet
 * they say so in a `capability_absent` notice rather than rendering an empty
 * table that a reader would take for "nothing found" [I-1].
 */
export const DASHBOARD_VIEWS: readonly DashboardView[] = [
  "library",
  "evidence",
  "receipts",
  "approvals",
  "dead_letters",
  "migrations",
  "fleet",
  "agent",
  "skill_approval",
  "capability",
  "outcomes",
] as const;

export function isDashboardView(v: unknown): v is DashboardView {
  return typeof v === "string" && (DASHBOARD_VIEWS as readonly string[]).includes(v);
}

export type DashboardFormat = "json" | "html";

/**
 * The `format` selector, parsed in ONE place for both adapters (§2: the
 * adapters carry no logic, and §6 requires identical answers on REST and MCP).
 * P6 verdict 1, blocking #1: REST special-cased only `format=html` and served
 * JSON for every other value, while MCP refused anything but `html`/`json` —
 * the same request produced 200 on one adapter and INVALID_SCHEMA on the
 * other. An unrecognised value is INVALID_SCHEMA on BOTH, and the default,
 * when the parameter is absent, is `json` on both.
 */
export function parseDashboardFormat(v: unknown): DashboardFormat {
  if (v === undefined || v === null) return "json";
  if (v === "json" || v === "html") return v;
  throw new ApiError("INVALID_SCHEMA", "format must be json or html");
}

/**
 * A block of a view that is NOT a table of data.
 *
 * It exists because of one distinction §9 turns on and a table cannot make:
 * AN ABSENT CAPABILITY IS NOT AN EMPTY RESULT SET [I-1]. A screen whose
 * drafts inbox has not been built yet must not render an empty drafts table
 * under the caption "no draft found" — that reads as "we looked and there was
 * nothing", which is a claim about the data and not about the software.
 *
 * `capability_absent` says the part does not exist, and names the work it
 * belongs to. `legend` explains what a rendering DEVICE means — the colour of a
 * row, in the fleet view's case — so the meaning is on the page beside the
 * thing it decodes rather than in a commit message.
 */
export type DashboardNoticeKind = "capability_absent" | "legend";

export interface DashboardNotice {
  kind: DashboardNoticeKind;
  /** a short name for what is being declared */
  subject: string;
  /** the sentence a reader of the page gets, in full */
  detail: string;
}

/**
 * A CELL — AND WHY IT IS AN OBJECT WITH A MEMBERSHIP AND NOT A MARKED STRING.
 *
 * ROUND 4 MADE THIS TYPE A BRANDED STRING and called the brand a mechanism of
 * impossibility. It is not one. `as Cell` exists in TypeScript for exactly the
 * purpose of defeating a brand; `as unknown as Cell`, a widening through `any`
 * and `JSON.parse` (whose return type is `any`) each reach the same place
 * without a cast being written anywhere near a renderer. A mark carried IN THE
 * VALUE — a `kind:` token in the text — is worse still: it is evidence a
 * stranger can write, and the free-text path of a dashboard exists to publish
 * text strangers wrote.
 *
 * SO PROVENANCE IS NOT READ OFF THE VALUE. `mintCell` is the only expression in
 * the program that produces a cell, and it records what it produced in a
 * `WeakSet` held in this module's closure. `isMintedCell` answers by IDENTITY:
 * is THIS OBJECT one of the ones that function returned. A cast changes a type
 * and changes no object; a literal with the same fields is a different object;
 * `JSON.parse` of a real cell's own bytes produces a different object; a
 * `structuredClone` of one produces a different object. None of them can be
 * made a member without calling the constructor, and calling the constructor is
 * the thing that was wanted.
 *
 * WHAT THIS COSTS, STATED PLAINLY: a cell is no longer a string, so a payload
 * carries objects and the two adapters serialise them at the boundary
 * (`serializeDashboard`). That is a change to the shape of the data, and it is
 * the price of the guarantee — the wire format is unchanged because the
 * boundary flattens each cell to its text after checking its provenance.
 *
 * WHAT THIS DOES NOT CLAIM. Membership proves a cell came from `mintCell`. It
 * does NOT prove the caller of `mintCell` attached a method: that is a separate
 * property, kept by the constructors in `src/fleet-dashboard.ts`, checked over
 * the finished bytes by `auditCells`, and checked at the payload by
 * `auditDashboardPayload`. Two independent layers, and each is described here
 * as what it is.
 */
export interface Cell {
  readonly text: string;
}

/**
 * The set of cells this program has made. A `WeakSet` because it must not keep
 * a page alive, and because membership is the whole of the answer: there is
 * nothing to read out of it, only a yes or a no about one object.
 */
const MINTED = new WeakSet<object>();

/**
 * THE ONE EXPRESSION THAT PRODUCES A CELL.
 *
 * Frozen, so the text a caller checked is the text the boundary renders, and
 * recorded, so `isMintedCell` can answer about it later.
 */
export function mintCell(text: string): Cell {
  const cell: Cell = Object.freeze({ text });
  MINTED.add(cell);
  return cell;
}

/** Whether this exact object is one `mintCell` returned. */
export function isMintedCell(value: unknown): value is Cell {
  return typeof value === "object" && value !== null && MINTED.has(value as object);
}

/**
 * The refusal a boundary raises. Its own class, so a caller can tell "a value
 * of unknown provenance reached the render" from any other failure, and so the
 * refusal cannot be swallowed by a `catch` written for something else.
 */
export class ForeignValue extends Error {}

/**
 * A cell's text, or a REFUSAL. Every boundary that turns a payload into bytes
 * goes through here, which is what makes "the render accepts members of the
 * constructor's set and nothing else" a property of the code rather than a
 * sentence in a comment.
 */
export function cellTextOf(value: unknown, where: string): string {
  if (!isMintedCell(value)) {
    throw new ForeignValue(
      `[B-2] refused at ${where}: a row value that no cell constructor produced (${describe(value)}). ` +
        "A cell is admitted by IDENTITY — it is one of the objects `mintCell` returned — so a cast, a literal of the " +
        "same shape, a `JSON.parse` of a cell's own bytes and a clone of one are all refused here.",
    );
  }
  return value.text;
}

/** What a refused value IS, without printing what it says. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return `a ${typeof value}`;
  return `an object with keys [${Object.keys(value as object).join(", ")}]`;
}

export interface DashboardSection {
  key: string;
  title: string;
  /** the API field names this section renders, in column order */
  fields: string[];
  /**
   * The rows, as CELLS. Not `unknown`, and not `string`: the render layer
   * accepts only values a cell constructor produced, so a template cannot put a
   * bare number, a bare id or a raw `null` on the page.
   */
  rows: Array<Record<string, Cell>>;
  /** shown when `rows` is empty, so an empty view is still legible */
  empty: string;
  /**
   * A sentence rendered with the section whether or not it has rows — for
   * saying what the table is counted over, or what it deliberately leaves out.
   * `empty` cannot carry that: it disappears the moment one row arrives.
   */
  note?: string;
  /**
   * The name of the row field whose VALUE decides the row's CSS class
   * (`row-<value>`).
   *
   * §9's [D-1] requires the colour of a fleet row to encode THE STATE OF THE
   * RECONCILIATION between what the registry intends and what a runtime
   * reported — not an abstract "all is well". Naming a FIELD rather than
   * passing a function keeps the payload JSON, keeps the two adapters serving
   * one answer, and makes the colour checkable from the shipped bytes: the
   * class of a row and the value in its own cell must agree.
   */
  row_class_field?: string;
  /**
   * Appendix H pagination, for the sections that page over versions: the
   * opaque cursor to pass back as `?cursor=`. Absent where the section is not
   * paged (a view that returns a cursor it cannot honour would be worse than
   * one that returns none).
   */
  next_cursor?: string | null;
}

export interface DashboardPayload {
  view: DashboardView;
  title: string;
  views: readonly DashboardView[];
  sections: DashboardSection[];
  /**
   * §9.1 single-user demo mode — true while the instance has exactly one
   * human principal. The spec requires it to be "prominently labeled on the
   * dashboard", so it is a field of the payload (both adapters) and a banner
   * in the rendered page, not a comment in the README.
   */
  demo_mode: boolean;
  /**
   * The non-table blocks of this view. Always present — empty on the views
   * that declare nothing. An OPTIONAL field would let a screen quietly omit
   * the statement that a part of it does not exist, and that omission is
   * exactly the [I-1] failure this field was added for.
   */
  notices: DashboardNotice[];
}

// --------------------------------------------------------------- rendering

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * One value → one cell. Deterministic and lossless enough that a test can
 * assert the API value itself is on the page: strings and numbers render
 * verbatim, arrays join with ", ", objects fall back to JSON.
 */
export function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length === 0 ? "—" : v.map((x) => renderValue(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * The CSS class a row's class field yields: `row-` plus the field's own value,
 * reduced to a class-safe token.
 *
 * The value is NOT translated into a palette word here, and that is the point.
 * A mapping step is where "pending" quietly becomes "warning" and "in_sync"
 * becomes "ok"; keeping the class the value itself means the colour on the page
 * and the word in the cell cannot drift apart, and a check over the rendered
 * bytes can insist they agree.
 */
export function rowClassOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const token = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .slice(0, 40);
  return token.length === 0 ? null : `row-${token}`;
}

function renderNotice(n: DashboardNotice): string {
  return `<div class="notice notice-${escapeHtml(n.kind)}"><h3>${escapeHtml(n.kind)}: ${escapeHtml(n.subject)}</h3>
<p>${escapeHtml(n.detail)}</p></div>`;
}

function renderSection(s: DashboardSection): string {
  const head = s.fields.map((f) => `<th>${escapeHtml(f)}</th>`).join("");
  const note = s.note === undefined ? "" : `\n<p class="note">${escapeHtml(s.note)}</p>`;
  if (s.rows.length === 0) {
    return `<section id="${escapeHtml(s.key)}"><h2>${escapeHtml(s.title)}</h2>${note}
<table><thead><tr>${head}</tr></thead><tbody></tbody></table>
<p class="empty">${escapeHtml(s.empty)}</p></section>`;
  }
  const body = s.rows
    .map((row, r) => {
      // THE PROVENANCE CHECK IS THE READ ITSELF. There is no path from a row to
      // the page that does not go through `cellTextOf`, so a value of unknown
      // provenance cannot be rendered — not "is detected on the finished page",
      // which is what the round before this one claimed and could not keep.
      const cls =
        s.row_class_field === undefined
          ? null
          : rowClassOf(cellTextOf(row[s.row_class_field], `${s.key}/row#${r}/${s.row_class_field}`));
      const open = cls === null ? "<tr>" : `<tr class="${escapeHtml(cls)}">`;
      return `${open}${s.fields.map((f) => `<td>${escapeHtml(cellTextOf(row[f], `${s.key}/row#${r}/${f}`))}</td>`).join("")}</tr>`;
    })
    .join("\n");
  return `<section id="${escapeHtml(s.key)}"><h2>${escapeHtml(s.title)}</h2>${note}
<table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></section>`;
}

/**
 * THE JSON BOUNDARY — the same provenance check, on the other adapter.
 *
 * A cell is an object in the payload and a string on the wire. Both adapters
 * call this, so a value that no constructor produced cannot be served as JSON
 * any more than it can be rendered as HTML: the two boundaries ask the SAME
 * question of the SAME set, and neither reads anything out of the value to
 * decide it.
 */
export interface SerializedSection extends Omit<DashboardSection, "rows"> {
  rows: Array<Record<string, string>>;
}
export interface SerializedPayload extends Omit<DashboardPayload, "sections"> {
  sections: SerializedSection[];
}

export function serializeDashboard(payload: DashboardPayload): SerializedPayload {
  return {
    ...payload,
    sections: payload.sections.map((s) => ({
      ...s,
      rows: s.rows.map((row, r) => {
        const out: Record<string, string> = {};
        // EVERY MEMBER OF THE ROW, not the declared fields: a member the section
        // did not announce is still served to the client, and a guard whose
        // coverage is chosen by the thing it guards is the defect this file
        // keeps being corrected for.
        for (const [field, value] of Object.entries(row)) {
          out[field] = cellTextOf(value, `${s.key}/row#${r}/${field}`);
        }
        return out;
      }),
    })),
  };
}

/** The view as a self-contained HTML page (no scripts, no external assets). */
export function renderDashboard(payload: DashboardPayload): string {
  const nav = payload.views
    .map((v) =>
      v === payload.view
        ? `<strong>${escapeHtml(v)}</strong>`
        : `<a href="/v1/dashboard/${escapeHtml(v)}?format=html">${escapeHtml(v)}</a>`,
    )
    .join(" · ");
  const banner = payload.demo_mode
    ? `<p class="demo"><strong>DEMO MODE</strong> — this instance has exactly one human principal (SPEC §9.1). ` +
      `That principal may review the built-in seed package. Demo mode ends automatically when a second human principal is created.</p>`
    : "";
  const notices = payload.notices.length === 0 ? "" : payload.notices.map(renderNotice).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skillonomia — ${escapeHtml(payload.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;margin:1rem 0}
th,td{border:1px solid #ccc;padding:.3rem .6rem;text-align:left;vertical-align:top;font-size:.9rem}
th{background:#f3f3f3}.empty{color:#666}.note{color:#444;font-size:.9rem;margin:.2rem 0 .6rem}
.demo{background:#fff3cd;border:1px solid #e0b400;padding:.6rem 1rem;margin:1rem 0;font-size:.95rem}
.notice{border-left:.35rem solid #666;padding:.5rem 1rem;margin:1rem 0;font-size:.95rem;background:#f7f7f7}
.notice-capability_absent{border-left-color:#7b1fa2;background:#f6effa}
/* [D-1] the colour of a fleet row is the state of the RECONCILIATION between
   what the registry intends and what a runtime reported. It is not a health
   indicator: an unknown reconciliation is not a failure, and in_sync is not a compliment. */
tr.row-in_sync td{background:#eef7ee}
tr.row-pending td{background:#fff6e0}
tr.row-drifted td{background:#ffeedd}
tr.row-failed td{background:#fdeceb}
tr.row-unknown td{background:#eceff1}
/* the owner reads this on a phone: a cell WRAPS, and no column is dropped —
   losing a column is how an attribute of a number goes missing [I-3] */
td{overflow-wrap:anywhere}
@media (max-width:640px){body{margin:.6rem}th,td{font-size:.8rem;padding:.25rem .35rem}
section{overflow-x:auto}}</style></head>
<body><h1>${escapeHtml(payload.title)}</h1><nav>${nav}</nav>
${banner}
${notices}
${payload.sections.map(renderSection).join("\n")}
</body></html>`;
}
