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
 * A CELL — AND THE REASON THIS TYPE EXISTS AT ALL.
 *
 * `Cell` is a string the type system will not let you WRITE. It is a branded
 * string: the brand is a `unique symbol` no module can name, so the only
 * expressions of this type are the ones the cell constructors in
 * `src/fleet-dashboard.ts` return. A section's `rows` hold `Cell`s and nothing
 * else, which makes
 *
 *     rows.push({ avg_rating: `${score}` })      // ← a bare value
 *
 * A COMPILE ERROR rather than a finding. That is the whole point, and it is
 * what the two rounds before this one could not achieve: they widened a pattern
 * that recognised a figure — integers, then decimals — and a reviewer answered
 * each widening with a notation it had not been shown (`.75`, `⅔`, `٤٫٥`, `1:2`,
 * `1×10³`, `5‰`, `0x10`, `12·5`). The set of notations a person can write a
 * number in is not enumerable, so a guard that enumerates it is behind by
 * whatever the next reviewer thinks of. THE SET OF WAYS A VALUE CAN REACH THE
 * PAGE is enumerable — there are the constructors, and there is nothing else —
 * so that is the set this build closes.
 *
 * A deliberate `as unknown as Cell` still compiles, as every brand in every
 * language does. It is not a way past the guard: a cell forged that way carries
 * no `kind:` and `auditCells` refuses it over the finished bytes. The two
 * layers are independent — one at compile time over the source, one at run time
 * over the rendered page — and a value has to defeat BOTH to reach a reader
 * without its method.
 */
declare const CELL_BRAND: unique symbol;
export type Cell = string & { readonly [CELL_BRAND]: "skillonomia.dashboard.cell" };

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
    .map((row) => {
      const cls = s.row_class_field === undefined ? null : rowClassOf(row[s.row_class_field]);
      const open = cls === null ? "<tr>" : `<tr class="${escapeHtml(cls)}">`;
      return `${open}${s.fields.map((f) => `<td>${escapeHtml(renderValue(row[f]))}</td>`).join("")}</tr>`;
    })
    .join("\n");
  return `<section id="${escapeHtml(s.key)}"><h2>${escapeHtml(s.title)}</h2>${note}
<table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></section>`;
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
