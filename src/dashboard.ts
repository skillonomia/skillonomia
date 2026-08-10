// P6 dashboard — the views the internal phase plan names (library, evidence,
// receipts, approvals, dead letters), plus the migration counter the registry
// exists to make countable, as a THIN READ LAYER over the
// service functions the earlier phases already ship. It computes nothing of its own: every value it
// shows is a field of an API response (search + registry view, receipt read,
// the approval matrix, `deadLetters()`, webhook health, `migrationCounts()`).
//
// Appendix H's `dashboard.view` row fixes what the envelope must be: the six
// view names, the ACL scoping, `demo_mode`, and `fields` naming "the API fields
// of the numbered surfaces that the section's `rows` carry — the dashboard
// computes nothing of its own and is a rendering, never a second source of
// truth". The CHOICE of sections it deliberately leaves to the rendering, and
// ranking or visual polish is not a property of this format at all.
//
// So the contract this module implements is exactly that and nothing more:
//   * the five views named as the internal phase plan names them, and
//     `migrations` — the per-skill migration counter, which is a product
//     surface rather than a phase-plan view: the operator who installed this
//     registry has to be able to see whether anything ever migrated, and every
//     number on it states its source, its selection window and its state;
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

export type DashboardView = "library" | "evidence" | "receipts" | "approvals" | "dead_letters" | "migrations";

/**
 * The five views of the internal phase plan, in the order it lists them, and
 * `migrations` after them — added later, and appended rather than inserted, so
 * the phase plan's own order stays readable.
 */
export const DASHBOARD_VIEWS: readonly DashboardView[] = [
  "library",
  "evidence",
  "receipts",
  "approvals",
  "dead_letters",
  "migrations",
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

export interface DashboardSection {
  key: string;
  title: string;
  /** the API field names this section renders, in column order */
  fields: string[];
  rows: Array<Record<string, unknown>>;
  /** shown when `rows` is empty, so an empty view is still legible */
  empty: string;
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

function renderSection(s: DashboardSection): string {
  const head = s.fields.map((f) => `<th>${escapeHtml(f)}</th>`).join("");
  if (s.rows.length === 0) {
    return `<section id="${escapeHtml(s.key)}"><h2>${escapeHtml(s.title)}</h2>
<table><thead><tr>${head}</tr></thead><tbody></tbody></table>
<p class="empty">${escapeHtml(s.empty)}</p></section>`;
  }
  const body = s.rows
    .map((row) => `<tr>${s.fields.map((f) => `<td>${escapeHtml(renderValue(row[f]))}</td>`).join("")}</tr>`)
    .join("\n");
  return `<section id="${escapeHtml(s.key)}"><h2>${escapeHtml(s.title)}</h2>
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
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Skillonomia — ${escapeHtml(payload.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;margin:1rem 0}
th,td{border:1px solid #ccc;padding:.3rem .6rem;text-align:left;vertical-align:top;font-size:.9rem}
th{background:#f3f3f3}.empty{color:#666}
.demo{background:#fff3cd;border:1px solid #e0b400;padding:.6rem 1rem;margin:1rem 0;font-size:.95rem}</style></head>
<body><h1>${escapeHtml(payload.title)}</h1><nav>${nav}</nav>
${banner}
${payload.sections.map(renderSection).join("\n")}
</body></html>`;
}
