// THE OWNER CONSOLE, IN THE BROWSER.
//
// THE THREE RULES THIS FILE IS WRITTEN UNDER, AND HOW EACH IS VISIBLE HERE:
//
//   `P2-FR-06` — nothing this file writes into the DOM goes through `innerHTML`,
//     `insertAdjacentHTML`, `document.write` or a `new Function`. Text arrives
//     through `textContent` and elements through `createElement`. A draft whose
//     title is `<img src=x onerror=…>` becomes those characters on the screen,
//     because there is no code path here that could make it anything else.
//
//   `P2-FR-11` / `P2-FR-12` — this file computes no eligibility, no security
//     verdict and no state transition, and parses no message. Whether an approve
//     button is enabled is `eligibility.approvable`. Why it is disabled is
//     `eligibility.reason_code`, rendered through a lookup table of labels. The
//     state of a draft is `item.state`. Every one of those is a field.
//
//   `P2-FR-14` — nothing is written to `localStorage`, `sessionStorage`,
//     IndexedDB, the Cache API or a cookie. The CSRF token lives in the module
//     variable below and dies with the page. The session lives in an `HttpOnly`
//     cookie this file cannot read and never tries to.
//
// The API key is not here either, in any form. This file has no way to obtain
// one: the only credential it ever holds is a CSRF token, and the only thing
// that authenticates its requests is a cookie the browser attaches.

interface Eligibility {
  approvable: boolean;
  reason_code: string;
  semantic_blocking: number;
  security_blocking: number;
  decided: DecisionRecord | null;
}

interface DecisionRecord {
  decision: string;
  reason: string | null;
  actor_agent_id: string;
  draft_revision_id: string;
  content_digest: string;
  server_at_ms: number;
}

interface InboxItem {
  draft_id: string;
  title: string;
  latest_revision: number;
  latest_revision_id: string;
  content_digest: string;
  semantic_blocking: number;
  security_blocking: number;
  state: string;
  eligibility: Eligibility;
  created_at_ms: number;
}

interface Inbox {
  contract: string;
  states: string[];
  items: InboxItem[];
}

interface Finding {
  code: string;
  severity: string;
  detail: string;
  section?: string;
  line?: number | null;
}

interface RedactionFinding {
  category: string;
  location: string;
  reason: string;
  source_field?: string;
}

interface RiskyAction {
  code: string;
  severity: string;
  detail: string;
}

interface DraftDetail {
  contract: string;
  state: string;
  decision: DecisionRecord | null;
  eligibility: Eligibility;
  draft: {
    draft_id: string;
    revision: {
      revision_id: string;
      revision: number;
      content_digest: string;
      compiler_version: string;
      origin: string;
      created_at_ms: number;
      content: {
        title: string;
        purpose: string;
        when_to_use: string;
        procedure: string[];
        inputs: string[];
        outputs: string[];
        permissions: string[];
        dependencies: string[];
        failure_modes: string[];
        redactions: RedactionFinding[];
        provenance: Record<string, unknown>;
      };
      semantic_review: {
        status: string;
        blocking_count: number;
        missing_sections: string[];
        findings: Finding[];
      };
      security_review: {
        requested_permissions: string[];
        dependencies: string[];
        risky_actions: RiskyAction[];
        redactions: RedactionFinding[];
        blocking_count: number;
      };
    };
    lineage: Array<{ revision_id: string; revision: number; origin: string; content_digest: string }>;
  };
}

interface AuditEntry {
  entry_id: string;
  event: string;
  actor_agent_id: string;
  actor_role: string;
  source: string;
  result: string;
  reason_code: string | null;
  reason: string | null;
  draft_revision_id: string | null;
  content_digest: string | null;
  server_at_ms: number;
}

/** The contract version this build was written against. A payload announcing a
 *  different one is refused rather than rendered on a guess — which is the point
 *  of a versioned contract (`INV-05`). */
const CONTRACT = "console.v1";

/** Why an approve button is disabled, in words, from the machine-readable code.
 *  The DECISION came from the server; this table only names it. */
const REASON_LABEL: Record<string, string> = {
  APPROVABLE: "ready to approve",
  BLOCKING_SEMANTIC_FINDINGS: "blocked: unresolved semantic findings",
  BLOCKING_SECURITY_FINDINGS: "blocked: unresolved security findings",
  ALREADY_DECIDED: "already decided",
  NOT_LATEST_REVISION: "a newer revision exists — reload",
};

let csrfToken = "";
let openDraftId: string | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  // textContent, never innerHTML: this is the whole of `P2-FR-06` in this file
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function showError(message: string): void {
  const box = document.getElementById("error") ?? document.getElementById("login-error");
  if (box) box.textContent = message;
}

interface ApiFailure {
  status: number;
  code: string;
  message: string;
  current_state?: string;
}

/**
 * Every request this console makes.
 *
 * `credentials: "same-origin"` so the session cookie travels and nothing else
 * does. `X-Skillonomia-Console-CSRF` on every mutation. And an
 * `idempotency_key` in the BODY of every mutation — the field this registry's
 * own mutations already take, minted per ATTEMPT by `crypto.randomUUID`, which
 * is what makes a double-clicked approve one approval rather than two
 * (`P2-FR-13`). A header of its own would be a second mechanism for a thing that
 * already has one.
 *
 * A `401` means the session ended — expiry or logout, and the console cannot
 * tell which because the server does not say. Either way the answer is the same:
 * go to the sign-in page. That is not a product decision computed from a string;
 * it is the status code.
 */
async function api<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let payload = body;
  if (method !== "GET") {
    headers["X-Skillonomia-Console-CSRF"] = csrfToken;
    payload = { ...((body ?? {}) as Record<string, unknown>) };
    if (idempotencyKey) (payload as Record<string, unknown>).idempotency_key = idempotencyKey;
  }
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (res.status === 401) {
    window.location.assign("/console/login");
    throw new Error("session ended");
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw Object.assign(new Error("the server sent a body this console cannot read"), {
      status: res.status,
      code: "UNPARSEABLE",
      message: "unparseable response",
    } satisfies ApiFailure);
  }
  if (!res.ok) {
    const envelope = (parsed as { error?: { code?: string; message?: string; current_state?: string } } | null)?.error;
    throw Object.assign(new Error(envelope?.message ?? `request failed (${res.status})`), {
      status: res.status,
      code: envelope?.code ?? "UNKNOWN",
      message: envelope?.message ?? "",
      current_state: envelope?.current_state,
    } satisfies ApiFailure);
  }
  return parsed as T;
}

function failureOf(e: unknown): ApiFailure {
  const f = e as Partial<ApiFailure>;
  return { status: f.status ?? 0, code: f.code ?? "UNKNOWN", message: f.message ?? String(e), current_state: f.current_state };
}

// ------------------------------------------------------------------ the login

function wireLogin(): void {
  const form = byId<HTMLFormElement>("login");
  form.addEventListener("submit", (event) => {
    event.preventDefault(); // never a GET with the ticket in the query string
    const field = byId<HTMLInputElement>("ticket");
    const ticket = field.value.trim();
    field.value = "";
    showError("");
    void (async () => {
      try {
        await api<{ expires_at_ms: number }>("POST", "/v1/console/session", { ticket });
        window.location.assign("/console");
      } catch (e) {
        showError(failureOf(e).message || "sign-in failed");
      }
    })();
  });
}

// ----------------------------------------------------------------- the inbox

function renderInbox(inbox: Inbox, filter: string): void {
  const rows = byId("inbox-rows");
  clear(rows);
  const shown = inbox.items.filter((i) => filter === "" || i.state === filter);
  for (const item of shown) {
    const tr = el("tr");
    tr.appendChild(el("td", item.title));
    tr.appendChild(el("td", item.state));
    tr.appendChild(el("td", String(item.latest_revision)));
    const sem = el("td", String(item.semantic_blocking));
    if (item.semantic_blocking > 0) sem.className = "blocking";
    tr.appendChild(sem);
    const sec = el("td", String(item.security_blocking));
    if (item.security_blocking > 0) sec.className = "blocking";
    tr.appendChild(sec);
    // the verdict is the server's field, rendered; nothing here recomputes it
    tr.appendChild(el("td", REASON_LABEL[item.eligibility.reason_code] ?? item.eligibility.reason_code));
    const actions = el("td");
    const open = el("button", "Open");
    open.type = "button";
    open.dataset.draftId = item.draft_id;
    open.addEventListener("click", () => void openDraft(item.draft_id));
    actions.appendChild(open);
    tr.appendChild(actions);
    tr.dataset.draftId = item.draft_id;
    tr.dataset.state = item.state;
    rows.appendChild(tr);
  }
  if (shown.length === 0) {
    const tr = el("tr");
    const td = el("td", "no drafts", "muted");
    td.colSpan = 7;
    tr.appendChild(td);
    rows.appendChild(tr);
  }
  rows.dataset.count = String(shown.length);
}

function renderStates(states: string[], select: HTMLSelectElement): void {
  if (select.options.length > 0) return;
  const all = el("option", "all");
  all.value = "";
  select.appendChild(all);
  for (const s of states) {
    const opt = el("option", s);
    opt.value = s;
    select.appendChild(opt);
  }
}

async function loadInbox(): Promise<void> {
  showError("");
  const inbox = await api<Inbox>("GET", "/v1/console/drafts");
  if (inbox.contract !== CONTRACT) {
    showError(`this console reads ${CONTRACT} and the server sent ${inbox.contract}`);
    return;
  }
  const select = byId<HTMLSelectElement>("state-filter");
  renderStates(inbox.states, select);
  renderInbox(inbox, select.value);
  byId("inbox").dataset.loaded = "true";
}

// ---------------------------------------------------------------- the detail

function section(parent: HTMLElement, heading: string, lines: string[]): void {
  const h = el("h3", heading);
  parent.appendChild(h);
  if (lines.length === 0) {
    parent.appendChild(el("p", "—", "muted"));
    return;
  }
  const ul = el("ul");
  for (const line of lines) ul.appendChild(el("li", line));
  parent.appendChild(ul);
}

function prose(parent: HTMLElement, heading: string, text: string): void {
  parent.appendChild(el("h3", heading));
  // a <pre> with textContent: the characters of an untrusted draft, shown as
  // characters. Line breaks survive; markup does not become markup.
  parent.appendChild(el("pre", text));
}

function renderDetail(detail: DraftDetail): void {
  const box = byId("detail");
  clear(box);
  box.hidden = false;
  box.dataset.draftId = detail.draft.draft_id;
  box.dataset.state = detail.state;
  box.dataset.revisionId = detail.draft.revision.revision_id;

  const rev = detail.draft.revision;
  const head = el("div", undefined, "row");
  head.appendChild(el("h2", rev.content.title));
  head.appendChild(el("span", `revision ${rev.revision} · ${rev.content_digest}`, "muted"));
  box.appendChild(head);

  prose(box, "Purpose", rev.content.purpose);
  prose(box, "When to use", rev.content.when_to_use);
  section(box, "Procedure", rev.content.procedure);
  section(box, "Inputs", rev.content.inputs);
  section(box, "Outputs", rev.content.outputs);
  section(box, "Permissions", rev.content.permissions);
  section(box, "Dependencies", rev.content.dependencies);
  section(box, "Failure modes", rev.content.failure_modes);
  section(
    box,
    `Redactions (${rev.content.redactions.length})`,
    rev.content.redactions.map((r) => `${r.category} at ${r.location}: ${r.reason}`),
  );
  section(
    box,
    `Semantic findings (${rev.semantic_review.blocking_count} blocking)`,
    rev.semantic_review.findings.map((f) => `${f.severity} · ${f.code} · ${f.detail}`),
  );
  section(
    box,
    `Security findings (${rev.security_review.blocking_count} blocking)`,
    rev.security_review.risky_actions.map((a) => `${a.severity} · ${a.code} · ${a.detail}`),
  );
  section(box, "Provenance", Object.entries(rev.content.provenance).map(([k, v]) => `${k}: ${String(v)}`));
  section(
    box,
    "Lineage",
    detail.draft.lineage.map((l) => `revision ${l.revision} · ${l.origin} · ${l.content_digest}`),
  );

  if (detail.decision) {
    const d = el("p", `${detail.decision.decision} by ${detail.decision.actor_agent_id}`);
    d.id = "decision-line";
    box.appendChild(d);
    if (detail.decision.reason) box.appendChild(el("pre", detail.decision.reason));
  }

  const verdict = el("p", REASON_LABEL[detail.eligibility.reason_code] ?? detail.eligibility.reason_code);
  verdict.id = "eligibility";
  verdict.dataset.reasonCode = detail.eligibility.reason_code;
  verdict.dataset.approvable = String(detail.eligibility.approvable);
  box.appendChild(verdict);

  const actions = el("div", undefined, "row");
  const approve = el("button", "Approve");
  approve.type = "button";
  approve.id = "approve";
  // the ONLY input to this line is the server's boolean
  approve.disabled = !detail.eligibility.approvable;
  approve.addEventListener("click", () => void decide(detail, "approve"));
  actions.appendChild(approve);

  const reject = el("button", "Reject");
  reject.type = "button";
  reject.id = "reject";
  reject.disabled = detail.decision !== null;
  reject.addEventListener("click", () => void decide(detail, "reject"));
  actions.appendChild(reject);

  const reason = el("input");
  reason.id = "reason";
  reason.type = "text";
  reason.size = 40;
  reason.placeholder = "reason (required to reject)";
  actions.appendChild(reason);

  const editLabel = el("label", "Edit procedure");
  editLabel.htmlFor = "edit-procedure";
  actions.appendChild(editLabel);
  const edit = el("textarea");
  edit.id = "edit-procedure";
  edit.rows = 3;
  edit.cols = 60;
  edit.value = rev.content.procedure.join("\n");
  actions.appendChild(edit);
  const save = el("button", "Save as new revision");
  save.type = "button";
  save.id = "save-edit";
  save.disabled = detail.decision !== null;
  save.addEventListener("click", () => void saveEdit(detail));
  actions.appendChild(save);

  box.appendChild(actions);
}

function renderAudit(audit: { contract: string; items: AuditEntry[] }): void {
  const box = byId("audit");
  clear(box);
  box.hidden = false;
  box.appendChild(el("h3", "Audit"));
  const table = el("table");
  table.id = "audit-table";
  const head = el("tr");
  for (const h of ["event", "actor", "role", "source", "result", "reason_code", "revision", "at"]) {
    head.appendChild(el("th", h));
  }
  table.appendChild(head);
  for (const item of audit.items) {
    const tr = el("tr");
    tr.dataset.event = item.event; // the event TYPE is a field, not a parsed word
    tr.appendChild(el("td", item.event));
    tr.appendChild(el("td", item.actor_agent_id));
    tr.appendChild(el("td", item.actor_role));
    tr.appendChild(el("td", item.source));
    tr.appendChild(el("td", item.result));
    tr.appendChild(el("td", item.reason_code ?? "—"));
    tr.appendChild(el("td", item.draft_revision_id ?? "—"));
    tr.appendChild(el("td", new Date(item.server_at_ms).toISOString()));
    table.appendChild(tr);
  }
  table.dataset.count = String(audit.items.length);
  box.appendChild(table);
}

async function openDraft(draftId: string): Promise<void> {
  showError("");
  openDraftId = draftId;
  const detail = await api<DraftDetail>("GET", `/v1/console/drafts/${encodeURIComponent(draftId)}`);
  if (detail.contract !== CONTRACT) {
    showError(`this console reads ${CONTRACT} and the server sent ${detail.contract}`);
    return;
  }
  renderDetail(detail);
  const audit = await api<{ contract: string; items: AuditEntry[] }>(
    "GET",
    `/v1/console/drafts/${encodeURIComponent(draftId)}/audit`,
  );
  renderAudit(audit);
}

/**
 * Approve or reject.
 *
 * The idempotency key is minted ONCE per attempt and the button is disabled
 * while the attempt is in flight, so a double click is one request with one key.
 * A `409` or `412` is not argued with: the console refetches the draft and shows
 * what the server says the state is, which is the converging-conflict rule the
 * API already implements.
 */
async function decide(detail: DraftDetail, action: "approve" | "reject"): Promise<void> {
  showError("");
  const button = byId<HTMLButtonElement>(action === "approve" ? "approve" : "reject");
  const reason = byId<HTMLInputElement>("reason").value.trim();
  button.disabled = true;
  const key = crypto.randomUUID();
  try {
    await api(
      "POST",
      `/v1/console/drafts/${encodeURIComponent(detail.draft.draft_id)}/${action}`,
      { revision_id: detail.draft.revision.revision_id, reason: reason.length > 0 ? reason : undefined },
      key,
    );
  } catch (e) {
    const failure = failureOf(e);
    showError(`${failure.code}: ${failure.message}`);
  }
  // whatever happened — success, conflict, refusal — the truth is refetched
  await openDraft(detail.draft.draft_id);
  await loadInbox();
}

/** `P2-FR-07`: an edit is a POST to the revisions surface, which creates a NEW
 *  revision and re-runs both previews server-side. This console sends the text
 *  and re-reads the answer; it compiles nothing itself. */
async function saveEdit(detail: DraftDetail): Promise<void> {
  showError("");
  const text = byId<HTMLTextAreaElement>("edit-procedure").value;
  const button = byId<HTMLButtonElement>("save-edit");
  button.disabled = true;
  const key = crypto.randomUUID();
  try {
    await api(
      "POST",
      `/v1/console/drafts/${encodeURIComponent(detail.draft.draft_id)}/revisions`,
      // `sections`, which is the field `draft.revise` takes. A body without it
      // RECOMPILES the stored source instead of editing it — a new revision with
      // the same digest, which is not what the owner asked for.
      { sections: { procedure: text.split("\n").filter((line) => line.trim().length > 0) } },
      key,
    );
  } catch (e) {
    const failure = failureOf(e);
    showError(`${failure.code}: ${failure.message}`);
  }
  await openDraft(detail.draft.draft_id);
  await loadInbox();
}

// ------------------------------------------------------------------ the boot

async function boot(): Promise<void> {
  const me = await api<{ agent_id: string; expires_at_ms: number; csrf_token: string; contract: string }>(
    "GET",
    "/v1/console/session",
  );
  csrfToken = me.csrf_token;
  byId("who").textContent = `${me.agent_id}`;
  byId("session-note").textContent = `session ends ${new Date(me.expires_at_ms).toISOString()}`;
  byId("refresh").addEventListener("click", () => void loadInbox());
  byId<HTMLSelectElement>("state-filter").addEventListener("change", () => void loadInbox());
  byId("logout").addEventListener("click", () => {
    void (async () => {
      await api("POST", "/v1/console/logout", {}, crypto.randomUUID());
      window.location.assign("/console/login");
    })();
  });
  await loadInbox();
  if (openDraftId) await openDraft(openDraftId);
}

if (document.getElementById("login")) {
  wireLogin();
} else {
  void boot().catch((e) => showError(failureOf(e).message));
}
