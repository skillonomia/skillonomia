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
//   `INV-05` — EVERY response from the console API is refused before a field of
//     it is read unless it announces the contract version this build was written
//     against. The check is in `api()`, which is the one function every request
//     goes through, so there is no call site that could forget it. P2 REVIEW-1
//     finding `P2-R1-004`: the session and the audit payloads were consumed
//     without it, so a payload marked `console.v999` was rendered. P2 REVIEW-2
//     finding `P2-R2-001`: the check was in `api()` but BELOW the failure branch,
//     so a `400`, a `409` or a `412` was read for `code`, `message` and
//     `current_state` before its version was looked at. The check is now the
//     first thing done with a parsed body and there is still exactly one of it —
//     a second check beside the first is how the hole appeared.
//
//   `P2-FR-14` — nothing is written to `localStorage`, `sessionStorage`,
//     IndexedDB, the Cache API or a cookie. The CSRF token lives in the module
//     variable below and dies with the page. The session lives in an `HttpOnly`
//     cookie this file cannot read and never tries to.
//
// The API key is not here either, in any form. This file has no way to obtain
// one: the only credential it ever holds is a CSRF token, and the only thing
// that authenticates its requests is a cookie the browser attaches.

// The Proofline's grammar and its words, from the one file that declares them
// (`src/console-proofline.ts`). It is imported rather than restated because a
// second copy of the cell separator or of a sentence on a dashboard is a second
// thing to keep in step — and because the gates compare the bytes on the page
// against these exact constants.
import {
  CELL_SELECTOR,
  CONSOLE_FIRST_VIEW,
  PROOFLINE_TEXT,
  PROVENANCE_SEP,
  UNKNOWN_CELL_SELECTOR,
  answerToken,
  parseCell,
  partialDetail,
  refusalDetail,
} from "../src/console-proofline.ts";

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
  /** whether the HEAD revision carries an approval of its own — V1 P3 made
   *  approval a fact about a revision, so this and `state` can disagree and the
   *  page shows both rather than the lineage's alone */
  head_approved: boolean;
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

interface ActionEligibility {
  allowed: boolean;
  reason_code: string;
}

/** The server's answer to "will you approve / reject / revise this?" — three
 *  fields, so this file holds none of the three rules (`P2-FR-11`). */
interface DraftActions {
  approve: ActionEligibility;
  reject: ActionEligibility;
  revise: ActionEligibility;
}

/** An approval of ONE revision — what an assignment may name and what a
 *  rollback may return to (`P3-FR-05`). */
interface RevisionApproval {
  approval_id: string;
  draft_id: string;
  draft_revision_id: string;
  revision: number;
  actor_agent_id: string;
  content_digest: string;
  server_at_ms: number;
}

interface DraftDetail {
  contract: string;
  state: string;
  decision: DecisionRecord | null;
  eligibility: Eligibility;
  actions: DraftActions;
  /** the approval of the revision being shown, or null */
  revision_approval: RevisionApproval | null;
  approved_revisions: RevisionApproval[];
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

/**
 * The contract version this build was written against. A payload announcing a
 * different one is refused rather than rendered on a guess — which is the point
 * of a versioned contract (`INV-05`).
 *
 * IT MOVES WITH THE SERVER AND IN THE SAME COMMIT. v1.1 changed what a
 * `/v1/console/*` envelope means, so the surface announces `console.v2` and this
 * bundle reads `console.v2`. The two literals are one decision: a server that
 * stamps a version this file does not know produces a console that refuses every
 * response, and a bundle that accepts a version the server no longer sends is
 * the hole `requireContract` exists to close. A DEPLOYED older bundle meeting
 * this server refuses, loudly and by name, which is the behaviour asked for.
 */
const CONTRACT = "console.v2";

/** Why an approve button is disabled, in words, from the machine-readable code.
 *  The DECISION came from the server; this table only names it. */
const REASON_LABEL: Record<string, string> = {
  APPROVABLE: "ready to approve",
  BLOCKING_SEMANTIC_FINDINGS: "blocked: unresolved semantic findings",
  BLOCKING_SECURITY_FINDINGS: "blocked: unresolved security findings",
  ALREADY_DECIDED: "already decided",
  NOT_LATEST_REVISION: "a newer revision exists — reload",
  REJECTABLE: "can be rejected",
  REVISABLE: "can be edited",
};

let csrfToken = "";
let openDraftId: string | null = null;

/**
 * A horizontally scrollable box that a KEYBOARD can reach.
 *
 * The wrapper exists so a wide table scrolls inside its own box instead of
 * pushing the page sideways and taking an action off the right edge. A box that
 * only a pointer can scroll is a barrier for anyone who does not use one, and an
 * accessibility scan names it `scrollable-region-focusable`. Focusable, with a
 * role and a name, the arrow keys move it and a screen reader says what it is.
 */
function scrollBox(label: string): HTMLDivElement {
  const box = el("div", undefined, "scroll-x");
  box.tabIndex = 0;
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", label);
  return box;
}

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
  return readConsoleResponse<T>(res, path);
}

/**
 * EVERY CONSOLE RESPONSE, READ IN ONE PLACE.
 *
 * `api()` above and `mutate()` below both end here, and that is the whole point
 * of the function existing: `INV-05` says the contract is checked ONCE, before a
 * field of the body is read, and two copies of that check are two places for one
 * of them to drift below a status branch. `P2-R2-001` was exactly that drift —
 * the check sitting under the error envelope, so a failed response was read for
 * `code`, `message` and `current_state` before its version had been looked at.
 *
 * The order below is the requirement, in this order and no other: parse, then
 * refuse an unknown contract, then the session, then the error envelope, then
 * the body.
 */
async function readConsoleResponse<T>(res: Response, path: string): Promise<T> {
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
  // `INV-05`, and it stands HERE — ahead of the status, ahead of the error
  // envelope, ahead of everything. A version boundary with a hole in it is not
  // a boundary.
  requireContract(parsed, path);
  if (res.status === 401) {
    window.location.assign("/console/login");
    throw new Error("session ended");
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

/**
 * `INV-05` — the refusal, in the one place every response passes through.
 *
 * A console response is a versioned document — SUCCEEDING OR FAILING. This build
 * reads `console.v2`; a body that announces anything else, or announces nothing,
 * is refused HERE, before the caller can read a field of it. Refusing is the
 * point of a version: a payload from a server this bundle was not built against
 * may have moved a field, changed what a code means, or dropped a check, and
 * rendering it on a guess is how a console shows an owner something that is not
 * true. An error envelope is such a payload — its `code` decides what the owner
 * is told happened — which is why `P2-R2-001` was a hole and not a nicety, and
 * why `src/http.ts` stamps the marker on the console surface's refusals too.
 */
function requireContract(parsed: unknown, path: string): void {
  const got = (parsed as { contract?: unknown } | null)?.contract;
  if (got === CONTRACT) return;
  throw Object.assign(new Error("unsupported contract version"), {
    status: 0,
    code: "CONTRACT_MISMATCH",
    message: `this console reads ${CONTRACT} and ${path} announced ${typeof got === "string" ? got : "no contract"}`,
  } satisfies ApiFailure);
}

/** An event handler's tail. A rejected promise handed to `void` is an unhandled
 *  rejection and a page that silently did nothing; this shows the refusal. */
function guard(run: () => Promise<unknown>): void {
  void run().catch((e) => showError(failureOf(e).message));
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
    // the lineage's state and the head's own approval are two server fields and
    // two columns: an approved lineage whose head is a newer revision reads
    // `approved` / `no`, which is what it is
    const headCell = el("td", item.head_approved ? "yes" : "no");
    headCell.dataset.headApproved = String(item.head_approved);
    tr.appendChild(headCell);
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
    open.addEventListener("click", () => guard(() => openDraft(item.draft_id)));
    actions.appendChild(open);
    tr.appendChild(actions);
    tr.dataset.draftId = item.draft_id;
    tr.dataset.state = item.state;
    rows.appendChild(tr);
  }
  if (shown.length === 0) {
    const tr = el("tr");
    const td = el("td", "no drafts", "muted");
    td.colSpan = 8;
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
  // the contract was checked in `api()`; nothing below can run on a payload
  // this build does not read
  const inbox = await api<Inbox>("GET", "/v1/console/drafts");
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

  // THE REVISION IN HAND, AND WHETHER IT IS APPROVED. The line above is the
  // LINEAGE's decision; this one is the server's answer about THIS revision
  // (`revision_approval`), and they are shown apart because since V1 P3 they can
  // differ — an approved lineage whose head is a later revision has an
  // unapproved head, and only an APPROVED revision can be assigned.
  const revisionApproval = el(
    "p",
    detail.revision_approval
      ? `this revision is approved (${detail.revision_approval.content_digest})`
      : "this revision carries no approval of its own",
  );
  revisionApproval.id = "revision-approval";
  revisionApproval.dataset.approved = String(detail.revision_approval !== null);
  revisionApproval.dataset.approvedRevisions = String(detail.approved_revisions.length);
  box.appendChild(revisionApproval);

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
  // the three server answers, as attributes, so a gate can read what was
  // rendered rather than infer it from whether a button looked disabled
  verdict.dataset.reviseAllowed = String(detail.actions.revise.allowed);
  verdict.dataset.reviseReason = detail.actions.revise.reason_code;
  verdict.dataset.rejectAllowed = String(detail.actions.reject.allowed);
  box.appendChild(verdict);

  const actions = el("div", undefined, "row");
  const approve = el("button", "Approve");
  approve.type = "button";
  approve.id = "approve";
  // the ONLY input to this line is the server's boolean
  approve.disabled = !detail.actions.approve.allowed;
  approve.addEventListener("click", () => guard(() => decide(detail, "approve")));
  actions.appendChild(approve);

  const reject = el("button", "Reject");
  reject.type = "button";
  reject.id = "reject";
  // `P2-R1-003`: the server's field, not `decision !== null` computed here
  reject.disabled = !detail.actions.reject.allowed;
  reject.addEventListener("click", () => guard(() => decide(detail, "reject")));
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
  // likewise: whether an edit is possible is a thing the server answers, and the
  // same answer refuses the POST
  save.disabled = !detail.actions.revise.allowed;
  save.addEventListener("click", () => guard(() => saveEdit(detail)));
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
  let failure: ApiFailure | null = null;
  try {
    await api(
      "POST",
      `/v1/console/drafts/${encodeURIComponent(detail.draft.draft_id)}/${action}`,
      { revision_id: detail.draft.revision.revision_id, reason: reason.length > 0 ? reason : undefined },
      key,
    );
  } catch (e) {
    failure = failureOf(e);
  }
  // whatever happened — success, conflict, refusal — the truth is refetched
  await openDraft(detail.draft.draft_id);
  await loadInbox();
  // and the refusal is shown AFTER the refetch, because the refetch clears the
  // error box: a message written before it is a message the owner never sees
  if (failure) showError(`${failure.code}: ${failure.message}`);
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
  let failure: ApiFailure | null = null;
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
    failure = failureOf(e);
  }
  await openDraft(detail.draft.draft_id);
  await loadInbox();
  if (failure) showError(`${failure.code}: ${failure.message}`);
}

// --------------------------------------------- V1 P3: the capability screen
//
// WHAT THIS HALF OF THE PAGE IS, AND THE FOUR RULES IT IS WRITTEN UNDER.
//
//   `P3-FR-07` / `INV-02` — DESIRED AND OBSERVED ARE TWO BLOCKS. They are
//     rendered by two functions from two fields of two shapes, each naming its
//     own `source`, and there is no place below where one is written from the
//     other. An owner command changes desired state only: the mutations at the
//     bottom of this file POST to the lifecycle routes, and nothing in this file
//     writes an observed status anywhere — the intake for those is a Bearer
//     route this console never calls.
//
//   `P3-FR-08` / `INV-03` — AN OBSERVED `unknown` IS RENDERED WITH ITS REASON
//     AND ITS SOURCE. Never blank, and never quietly shown as a success: the
//     status is printed as the word the server sent, and the reason code, the
//     reason and the source are printed beside it whatever that word is.
//
//   `P3-FR-14` / `INV-07` — THE PAGE SAYS THE CHANGE IS FOR THE NEXT SESSION.
//     The server sends `effective_from`; this file maps that field to a sentence
//     through a lookup table, the way `REASON_LABEL` maps a reason code. A value
//     this build does not know is printed as itself rather than guessed at.
//
//   `P3-FR-16` / `INV-01` — THE TRANSITION RULES ARE NOT HERE. Whether activate,
//     pause, revoke or a revision selection is possible is `actions.<x>.allowed`,
//     computed in `src/assignment-lifecycle.ts`; whether an agent may be assigned
//     is `eligibility.assignable`. Every `disabled` line below is `!` applied to
//     one of those booleans, which `test/v1p3-assignment.test.ts` asserts by
//     reading this file: a line that compared a state to a string instead would
//     fail that test.

interface FleetAgent {
  agent_id: string;
  name: string;
  type: string;
  status: string;
}

interface AssignmentEligibility {
  assignable: boolean;
  reason_code: string;
  agent_id: string;
  draft_id: string | null;
  revision_id: string;
}

/** The owner's intent. Its `source` is the registry journal, and it is named. */
interface DesiredView {
  state: string;
  revision_id: string;
  content_digest: string;
  effective_from: string;
  entity_version: number;
  event: string;
  reason_code: string;
  reason: string | null;
  decided_at_ms: number;
  source: string;
}

/** What somebody SAW, or the honest absence of it (`INV-03`). */
interface ObservedView {
  status: string;
  reason_code: string;
  reason: string;
  source: string;
  /** `INV-03`: every observed state carries a time, the synthesized `unknown`
   *  included — so this is not nullable and the page has no "never" branch
   *  (P3 REVIEW-1 finding `P3-R1-002`). */
  observed_at_ms: number;
  revision_id: string | null;
  session_ref: string | null;
  agent_id: string | null;
  observation_id: string | null;
}

interface ActionVerdict {
  allowed: boolean;
  reason_code: string;
}

interface AssignmentActions {
  activate: ActionVerdict;
  pause: ActionVerdict;
  revoke: ActionVerdict;
  select_revision: ActionVerdict;
}

interface AssignmentDetail {
  assignment_id: string;
  agent_id: string;
  draft_id: string;
  desired: DesiredView;
  observed: ObservedView;
  actions: AssignmentActions;
  approved_revisions: RevisionApproval[];
  entity_version: number;
  created_at_ms: number;
}

interface CapabilityItem {
  draft_id: string;
  title: string;
  latest_revision_id: string;
  latest_revision: number;
  approved_revisions: RevisionApproval[];
  head_approval: RevisionApproval | null;
  assignment_count: number;
  active_assignment_count: number;
}

interface CapabilityLibrary {
  contract: string;
  items: CapabilityItem[];
}

interface Capability {
  contract: string;
  draft_id: string;
  title: string;
  approved_revisions: RevisionApproval[];
  head_approval: RevisionApproval | null;
  fleet: FleetAgent[];
  eligibility: AssignmentEligibility[];
  assignments: AssignmentDetail[];
  effective_from: string;
  desired_state_source: string;
  observed_state_source: string;
  lifecycle_states: string[];
}

/** `P3-FR-14` / `INV-07`, as a lookup rather than a rule: the server's field
 *  becomes the sentence an owner reads. */
const EFFECTIVE_LABEL: Record<string, string> = {
  next_session:
    "takes effect in the NEXT session — the current session's loadout is unchanged",
};

function effectiveLabel(value: string): string {
  return EFFECTIVE_LABEL[value] ?? value;
}

/** Why a control is off, in words, from the server's machine-readable code. The
 *  DECISION is the server's; this names it. */
const LIFECYCLE_REASON_LABEL: Record<string, string> = {
  ASSIGNABLE: "ready to assign",
  REVISION_NOT_APPROVED: "the revision is not approved",
  AGENT_NOT_IN_FLEET: "the agent is not in this fleet",
  AGENT_NOT_ACTIVE: "the agent is not active",
  ALREADY_ASSIGNED: "already assigned to this agent",
  TRANSITION_ALLOWED: "allowed",
  ALREADY_IN_STATE: "already in this state",
  SELECTABLE: "another approved revision exists",
  NO_OTHER_APPROVED_REVISION: "no other approved revision",
  NO_OBSERVATION: "nothing has been reported yet",
};

function lifecycleLabel(code: string): string {
  return LIFECYCLE_REASON_LABEL[code] ?? code;
}

let openCapabilityId: string | null = null;

function renderCapabilityRows(library: CapabilityLibrary): void {
  const rows = byId("capability-rows");
  clear(rows);
  for (const item of library.items) {
    const tr = el("tr");
    tr.dataset.capabilityId = item.draft_id;
    tr.appendChild(el("td", item.title));
    tr.appendChild(el("td", String(item.approved_revisions.length)));
    tr.appendChild(el("td", item.head_approval ? `revision ${item.head_approval.revision}` : "—"));
    tr.appendChild(el("td", String(item.assignment_count)));
    tr.appendChild(el("td", String(item.active_assignment_count)));
    const actions = el("td");
    const open = el("button", "Open");
    open.type = "button";
    open.dataset.capabilityId = item.draft_id;
    open.addEventListener("click", () => guard(() => openCapability(item.draft_id)));
    actions.appendChild(open);
    tr.appendChild(actions);
    rows.appendChild(tr);
  }
  if (library.items.length === 0) {
    const tr = el("tr");
    const td = el("td", "no approved capabilities", "muted");
    td.colSpan = 6;
    tr.appendChild(td);
    rows.appendChild(tr);
  }
  rows.dataset.count = String(library.items.length);
}

async function loadCapabilities(): Promise<void> {
  const library = await api<CapabilityLibrary>("GET", "/v1/console/capabilities");
  renderCapabilityRows(library);
  byId("capabilities").dataset.loaded = "true";
}

/** The desired half: the owner's intent, its revision, its version and the
 *  source it was read from — beside a statement of when it takes effect. */
function renderDesired(parent: HTMLElement, assignment: AssignmentDetail, effectiveFrom: string, source: string): void {
  const box = el("div", undefined, "panel");
  box.className = "panel desired";
  box.dataset.assignmentId = assignment.assignment_id;
  box.dataset.desiredState = assignment.desired.state;
  box.dataset.desiredRevisionId = assignment.desired.revision_id;
  box.dataset.entityVersion = String(assignment.entity_version);
  box.appendChild(el("h4", "Desired — what the owner asked for"));
  box.appendChild(el("p", `state: ${assignment.desired.state}`));
  box.appendChild(el("p", `revision: ${assignment.desired.revision_id} · ${assignment.desired.content_digest}`));
  box.appendChild(el("p", `version: ${assignment.entity_version} · last event: ${assignment.desired.event}`));
  box.appendChild(el("p", `source: ${source}`, "muted"));
  const effective = el("p", `This is an intent, not an observation — it ${effectiveLabel(effectiveFrom)}.`);
  effective.className = "effective-from";
  effective.dataset.effectiveFrom = effectiveFrom;
  box.appendChild(effective);
  parent.appendChild(box);
}

/**
 * The observed half — `P3-FR-08`, `INV-03`.
 *
 * The status is printed as the word the server sent, and the reason code, the
 * reason, the source and the time are printed beside it WHATEVER that word is.
 * There is no branch here that hides a field when the status is `unknown` and no
 * branch that turns an `unknown` into anything else: the one thing the render
 * does with the status is put it on the screen and in an attribute.
 */
function renderObserved(parent: HTMLElement, assignment: AssignmentDetail, source: string): void {
  const o = assignment.observed;
  const box = el("div", undefined, "panel");
  box.className = "panel observed";
  box.dataset.assignmentId = assignment.assignment_id;
  box.dataset.observedStatus = o.status;
  box.dataset.observedReasonCode = o.reason_code;
  box.dataset.observedSource = o.source;
  box.appendChild(el("h4", "Observed — what evidence reported"));
  box.appendChild(el("p", `status: ${o.status}`));
  box.appendChild(el("p", `reason (${o.reason_code}): ${o.reason}`));
  box.appendChild(el("p", `source: ${o.source}`, "muted"));
  const observedAt = el("p", `observed at: ${new Date(o.observed_at_ms).toISOString()}`, "muted");
  observedAt.dataset.observedAtMs = String(o.observed_at_ms);
  box.appendChild(observedAt);
  box.appendChild(el("p", `session: ${o.session_ref ?? "—"} · revision: ${o.revision_id ?? "—"}`, "muted"));
  box.appendChild(el("p", `this deployment reads observations from: ${source}`, "muted"));
  parent.appendChild(box);
}

/** One lifecycle button: a rendering of `verdict.allowed` and nothing else. */
function lifecycleButton(
  parent: HTMLElement,
  assignment: AssignmentDetail,
  action: "activate" | "pause" | "revoke",
  verdict: ActionVerdict,
): void {
  const button = el("button", action[0]!.toUpperCase() + action.slice(1));
  button.type = "button";
  button.dataset.action = action;
  button.dataset.assignmentId = assignment.assignment_id;
  button.dataset.reasonCode = verdict.reason_code;
  button.disabled = !verdict.allowed;
  button.addEventListener("click", () => guard(() => lifecycle(assignment, action)));
  parent.appendChild(button);
  parent.appendChild(el("span", lifecycleLabel(verdict.reason_code), "muted"));
}

function renderAssignment(parent: HTMLElement, capability: Capability, assignment: AssignmentDetail): void {
  const box = el("div", undefined, "panel");
  box.className = "panel assignment";
  box.dataset.assignmentId = assignment.assignment_id;
  box.dataset.agentId = assignment.agent_id;
  box.dataset.entityVersion = String(assignment.entity_version);
  const agent = capability.fleet.find((a) => a.agent_id === assignment.agent_id);
  box.appendChild(el("h3", `Assignment to ${agent ? agent.name : assignment.agent_id}`));

  renderDesired(box, assignment, capability.effective_from, capability.desired_state_source);
  renderObserved(box, assignment, capability.observed_state_source);

  const controls = el("div", undefined, "row");
  lifecycleButton(controls, assignment, "activate", assignment.actions.activate);
  lifecycleButton(controls, assignment, "pause", assignment.actions.pause);
  lifecycleButton(controls, assignment, "revoke", assignment.actions.revoke);
  box.appendChild(controls);

  // Revision selection, which is also rollback: one control, because forward and
  // back are one operation on the server (`P3-FR-05`).
  const revisionRow = el("div", undefined, "row");
  revisionRow.appendChild(el("label", "Revision for the next session"));
  const select = el("select");
  select.id = `revision-${assignment.assignment_id}`;
  select.dataset.assignmentId = assignment.assignment_id;
  for (const approval of assignment.approved_revisions) {
    const option = el("option", `revision ${approval.revision} · ${approval.content_digest}`);
    option.value = approval.draft_revision_id;
    if (approval.draft_revision_id === assignment.desired.revision_id) option.selected = true;
    select.appendChild(option);
  }
  revisionRow.appendChild(select);
  const apply = el("button", "Use this revision");
  apply.type = "button";
  apply.dataset.action = "select_revision";
  apply.dataset.assignmentId = assignment.assignment_id;
  apply.dataset.reasonCode = assignment.actions.select_revision.reason_code;
  apply.disabled = !assignment.actions.select_revision.allowed;
  apply.addEventListener("click", () => guard(() => selectRevision(assignment, select.value)));
  revisionRow.appendChild(apply);
  revisionRow.appendChild(el("span", lifecycleLabel(assignment.actions.select_revision.reason_code), "muted"));
  box.appendChild(revisionRow);

  parent.appendChild(box);
}

function renderCapability(capability: Capability): void {
  const box = byId("capability");
  clear(box);
  box.hidden = false;
  box.dataset.capabilityId = capability.draft_id;
  box.dataset.assignmentCount = String(capability.assignments.length);

  box.appendChild(el("h2", capability.title));
  const effective = el(
    "p",
    `Every assignment, update, pause, revoke and rollback below ${effectiveLabel(capability.effective_from)}.`,
  );
  effective.id = "effective-from";
  effective.dataset.effectiveFrom = capability.effective_from;
  box.appendChild(effective);

  section(
    box,
    `Approved revisions (${capability.approved_revisions.length})`,
    capability.approved_revisions.map((a) => `revision ${a.revision} · ${a.draft_revision_id} · ${a.content_digest}`),
  );

  // the fleet, with the server's per-agent verdict beside each name
  box.appendChild(el("h3", "Fleet"));
  const fleet = el("div");
  fleet.id = "fleet";
  fleet.dataset.count = String(capability.fleet.length);
  for (const agent of capability.fleet) {
    // An agent the server sent no verdict for is NOT assignable here. That is
    // not this file deciding the rule: it is this file refusing to invent one
    // the server did not send.
    const verdict: AssignmentEligibility = capability.eligibility.find((e) => e.agent_id === agent.agent_id) ?? {
      assignable: false,
      reason_code: "NO_SERVER_VERDICT",
      agent_id: agent.agent_id,
      draft_id: capability.draft_id,
      revision_id: "",
    };
    const row = el("div", undefined, "row");
    row.dataset.agentId = agent.agent_id;
    row.dataset.assignable = String(verdict.assignable);
    row.dataset.reasonCode = verdict.reason_code;
    row.appendChild(el("span", `${agent.name} · ${agent.type}`));
    const assign = el("button", "Assign");
    assign.type = "button";
    assign.dataset.assignAgentId = agent.agent_id;
    assign.dataset.reasonCode = verdict.reason_code;
    // the server's boolean, and nothing else, decides this
    assign.disabled = !verdict.assignable;
    assign.addEventListener("click", () => guard(() => assign_(capability, agent.agent_id)));
    row.appendChild(assign);
    row.appendChild(el("span", lifecycleLabel(verdict.reason_code), "muted"));
    fleet.appendChild(row);
  }
  box.appendChild(fleet);

  const reasonRow = el("div", undefined, "row");
  reasonRow.appendChild(el("label", "Note for the journal"));
  const reason = el("input");
  reason.id = "lifecycle-reason";
  reason.type = "text";
  reason.size = 40;
  reasonRow.appendChild(reason);
  box.appendChild(reasonRow);

  const result = el("p", "");
  result.id = "lifecycle-result";
  result.dataset.result = "";
  result.dataset.code = "";
  result.dataset.currentState = "";
  box.appendChild(result);

  box.appendChild(el("h3", `Assignments (${capability.assignments.length})`));
  const list = el("div");
  list.id = "assignments";
  list.dataset.count = String(capability.assignments.length);
  for (const assignment of capability.assignments) renderAssignment(list, capability, assignment);
  box.appendChild(list);
}

async function openCapability(draftId: string): Promise<void> {
  showError("");
  openCapabilityId = draftId;
  const capability = await api<Capability>("GET", `/v1/console/capabilities/${encodeURIComponent(draftId)}`);
  openCapabilityView = capability;
  renderCapability(capability);
  // V1 P5: the outcomes OF this lineage, in their own region below.
  await loadOutcomes(draftId);
}

/** The refetch that follows EVERY owner command, successful or refused. */
async function refreshCapability(): Promise<void> {
  if (openCapabilityId === null) return;
  const capability = await api<Capability>("GET", `/v1/console/capabilities/${encodeURIComponent(openCapabilityId)}`);
  openCapabilityView = capability;
  renderCapability(capability);
  await loadCapabilities();
  await refreshOutcomes();
}

/**
 * What the owner is told a command did — `P3-FR-12`.
 *
 * A refusal is shown AS a refusal, with the server's code and the state the
 * server says the assignment is in. There is no branch here that reports a
 * refused command as applied, and the caller has already refetched the canonical
 * state before this runs, so what is on the screen beside this line is the
 * server's answer rather than the owner's request.
 */
function reportLifecycle(action: string, failure: ApiFailure | null): void {
  const box = byId("lifecycle-result");
  if (failure === null) {
    box.dataset.result = "applied";
    box.dataset.code = "";
    box.dataset.currentState = "";
    box.textContent = `${action}: accepted by the registry`;
    return;
  }
  box.dataset.result = "refused";
  box.dataset.code = failure.code;
  box.dataset.currentState = failure.current_state ?? "";
  box.textContent =
    `${action}: REFUSED — ${failure.code}` +
    (failure.current_state ? ` · the registry says the state is ${failure.current_state}` : "") +
    `: ${failure.message}`;
}

/**
 * One owner command.
 *
 * The idempotency key is derived from what the command IS — the assignment, the
 * action and the version it was issued against — rather than minted per click.
 * A command re-sent at the same version is the SAME command and replays
 * (`P3-FR-09`); the same command re-sent with a DIFFERENT note at the same
 * version is a different payload under one key, which the registry refuses with
 * `409` (`P3-FR-10`). Both answers are the server's.
 *
 * WHATEVER HAPPENS, the canonical state is refetched BEFORE anything is
 * reported, and the report is the server's answer (`P3-FR-12`). A page that
 * skipped the refetch on failure, or wrote "applied" without one, would be
 * showing the owner their own request back — which is the defect the browser
 * gate's negative demonstration rebuilds on purpose.
 */
async function ownerCommand(action: string, path: string, body: Record<string, unknown>, key: string): Promise<void> {
  showError("");
  let failure: ApiFailure | null = null;
  try {
    await api("POST", path, body, key);
  } catch (e) {
    failure = failureOf(e);
  }
  await refreshCapability();
  reportLifecycle(action, failure);
}

function noteText(): string | undefined {
  const field = document.getElementById("lifecycle-reason") as HTMLInputElement | null;
  const value = field ? field.value.trim() : "";
  return value.length > 0 ? value : undefined;
}

/** `P3-FR-01` / `P3-FR-02`: assign the head APPROVED revision to one agent. The
 *  revision is the server's `head_approval`; this file picks nothing. */
async function assign_(capability: Capability, agentId: string): Promise<void> {
  const approval = capability.head_approval;
  if (!approval) {
    showError("this capability has no approved revision to assign");
    return;
  }
  const note = noteText();
  await ownerCommand(
    "assign",
    "/v1/console/assignments",
    { agent_id: agentId, revision_id: approval.draft_revision_id, reason: note },
    `assign:${agentId}:${approval.draft_revision_id}:${note ?? ""}`,
  );
}

async function lifecycle(assignment: AssignmentDetail, action: "activate" | "pause" | "revoke"): Promise<void> {
  await ownerCommand(
    action,
    `/v1/console/assignments/${encodeURIComponent(assignment.assignment_id)}/${action}`,
    { if_version: assignment.entity_version, reason: noteText() },
    `${assignment.assignment_id}:${action}:${assignment.entity_version}`,
  );
}

/** Revision selection, which is rollback when the target is older. Which it is
 *  is the server's word, in the journal it writes. */
async function selectRevision(assignment: AssignmentDetail, revisionId: string): Promise<void> {
  await ownerCommand(
    "select_revision",
    `/v1/console/assignments/${encodeURIComponent(assignment.assignment_id)}/revision`,
    { revision_id: revisionId, if_version: assignment.entity_version, reason: noteText() },
    `${assignment.assignment_id}:revision:${revisionId}:${assignment.entity_version}`,
  );
}

// ----------------------------------------------- V1 P5: the outcome screen
//
// WHAT THIS THIRD REGION IS, AND THE FIVE RULES IT IS WRITTEN UNDER.
//
//   `INV-03` / `P5-FR-04` — AN OUTCOME IS PRINTED AS THE WORD THE SERVER SENT.
//     `renderOutcome` puts `o.outcome` on the screen and in an attribute and does
//     nothing else with it: there is no branch here that reads one value and
//     shows another, so a `nothing_reported` cannot appear as a success and an
//     entry with no outcome cannot appear as one either. Beside the word go its
//     reason code, its reason, its source, its evidence class and its time —
//     whatever the word is.
//
//   `P5-FR-12` — THE IMPROVEMENT VERDICT IS THE SERVER'S. `comparison.verdict`
//     is rendered, together with the reason code the registry decided it by,
//     whether the two runs were comparable at all, and the goal that was stated
//     in advance. This file compares no outcomes to each other. A client that
//     read `candidate_outcome` and concluded `improved` would be inventing a
//     confirmed improvement out of a run nobody judged, which is the thing
//     `P5-FR-12` exists to forbid, and it is what the browser gate's negative
//     demonstration rebuilds on purpose.
//
//   `P5-FR-14` / `INV-05` — every payload below arrives through `api()`, so its
//     contract version was checked before a field of it was read. There is still
//     exactly one such check in this file.
//
//   `INV-07` — THE PAGE SAYS WHEN A ROLLBACK TAKES EFFECT, and says that the
//     registry — not the click — is what confirms it. The rollback control here
//     is a confirmation step in front of the SAME server operation P3 already
//     owns (`select_revision` on the assignment), driven by the same server
//     verdict; the CONFIRMATION OF FACT is a `rolled_back` outcome a later
//     session filed, and it is displayed as evidence rather than produced here.
//
//   `INV-02` / `P4-FR-13` — nothing in this region writes observed state. The
//     three mutations it offers are the owner's three: a confirmation labelled as
//     the owner's word, a new revision, and a comparison. Filing a receipt, an
//     outcome, a closure or a rollback confirmation is a machine surface behind
//     an evidence principal, and this console has no call to any of them.

interface OutcomeConflictRow {
  conflict_id: string;
  outcome_ref: string;
  existing_outcome_id: string;
  existing_outcome: string;
  claimed_outcome: string;
  conflict_digest: string;
  observed_at_ms: number;
}

interface OutcomeRow {
  outcome_id: string;
  session_id: string;
  loadout_entry_id: string;
  assignment_id: string;
  draft_revision_id: string;
  content_digest: string;
  outcome: string;
  evidence_class: string | null;
  reason_code: string;
  reason: string;
  source: string;
  confirmation_source: string | null;
  invocation_receipt_id: string | null;
  rollback_to_revision_id: string | null;
  rollback_action_event_id: string | null;
  outcome_digest: string;
  observed_at_ms: number;
  conflicts: OutcomeConflictRow[];
}

/** Where a revision CAME FROM: the parent, the outcome that prompted it, the
 *  receipt behind that outcome and the goal stated before it ran (`P5-FR-08`). */
interface LineageRow {
  revision_source_id: string;
  draft_revision_id: string;
  parent_revision_id: string;
  origin: string;
  source_outcome_id: string;
  source_session_id: string;
  source_receipt_id: string | null;
  observation: string;
  improvement_goal: string;
  goal_kind: string;
  created_at_ms: number;
}

interface ComparisonRow {
  comparison_id: string;
  baseline_revision_id: string;
  candidate_revision_id: string;
  baseline_outcome_id: string;
  candidate_outcome_id: string;
  baseline_outcome: string;
  candidate_outcome: string;
  comparable: boolean;
  improvement_goal: string;
  goal_kind: string;
  verdict: string;
  verdict_reason_code: string;
  verdict_reason: string;
  created_at_ms: number;
}

interface OutcomeHistory {
  contract: string;
  draft_id: string;
  outcomes: OutcomeRow[];
  lineage: LineageRow[];
  comparisons: ComparisonRow[];
}

/** Names for the four normalised outcomes and for the three verdicts — LABELS,
 *  in the shape `REASON_LABEL` already has. A word this build does not know is
 *  printed as itself, because the alternative is a page that hides a value the
 *  server sent. */
const OUTCOME_LABEL: Record<string, string> = {
  worked: "worked — an invocation reported success",
  failed: "failed — an invocation reported a failure",
  rolled_back: "rolled back — a later session carried the rollback target",
  nothing_reported: "nothing reported — the session ended without an outcome, which is not a success",
  unknown: "unknown — nothing has been reported for this entry yet",
};

const VERDICT_LABEL: Record<string, string> = {
  improved: "confirmed improvement",
  not_improved: "no improvement",
  not_comparable: "not comparable — the two runs are not the same scenario",
};

let outcomeHistory: OutcomeHistory | null = null;
let openCapabilityView: Capability | null = null;
/** The rollback the owner has PREPARED but not yet confirmed, per assignment. */
const rollbackPlans = new Map<string, string>();

function label(table: Record<string, string>, value: string): string {
  return table[value] ?? value;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** What the owner is told a P5 command did. A refusal is shown AS a refusal,
 *  with the server's code and the state the server named — the same rule
 *  `reportLifecycle` follows, on this region's own line. */
function reportOutcome(action: string, failure: ApiFailure | null): void {
  const box = document.getElementById("outcome-result");
  if (!box) return;
  if (failure === null) {
    box.dataset.result = "applied";
    box.dataset.code = "";
    box.dataset.currentState = "";
    box.textContent = `${action}: accepted by the registry`;
    return;
  }
  box.dataset.result = "refused";
  box.dataset.code = failure.code;
  box.dataset.currentState = failure.current_state ?? "";
  box.textContent =
    `${action}: REFUSED — ${failure.code}` +
    (failure.current_state ? ` · the registry says ${failure.current_state}` : "") +
    `: ${failure.message}`;
}

/**
 * One owner command on this region.
 *
 * WHATEVER HAPPENS, the canonical state is refetched BEFORE anything is
 * reported, and what is reported is the server's answer — the rule `P3-FR-12`
 * wrote for the lifecycle screen, which is no weaker here: a create-revision
 * refused as a precondition failure, reported as applied, would be the console
 * telling an owner they have a revision the registry never made.
 */
async function ownerOutcomeCommand(action: string, path: string, body: Record<string, unknown>, key: string): Promise<void> {
  showError("");
  let failure: ApiFailure | null = null;
  try {
    await api("POST", path, body, key);
  } catch (e) {
    failure = failureOf(e);
  }
  await refreshCapability();
  reportOutcome(action, failure);
}

function renderOutcome(parent: HTMLElement, o: OutcomeRow): void {
  const box = el("div", undefined, "panel outcome");
  box.dataset.outcomeId = o.outcome_id;
  // THE WORD THE SERVER SENT, in an attribute and on the screen. Both come from
  // the same field and nothing between them looks at its value (`INV-03`).
  const shown = o.outcome;
  box.dataset.outcome = shown;
  box.dataset.evidenceClass = o.evidence_class ?? "";
  box.dataset.source = o.source;
  box.dataset.reasonCode = o.reason_code;
  box.dataset.revisionId = o.draft_revision_id;
  box.dataset.sessionId = o.session_id;
  box.dataset.invocationReceiptId = o.invocation_receipt_id ?? "";
  box.appendChild(el("h4", `outcome: ${shown} — ${label(OUTCOME_LABEL, shown)}`));
  box.appendChild(el("p", `reason (${o.reason_code}): ${o.reason}`));
  box.appendChild(
    el(
      "p",
      `source: ${o.source} · evidence: ${o.evidence_class ?? "—"} · the owner saw it at: ${o.confirmation_source ?? "—"}`,
      "muted",
    ),
  );
  box.appendChild(el("p", `revision: ${o.draft_revision_id} · ${o.content_digest}`, "muted"));
  box.appendChild(
    el("p", `session: ${o.session_id} · invocation receipt: ${o.invocation_receipt_id ?? "—"} · entry: ${o.loadout_entry_id}`, "muted"),
  );
  const at = el("p", `outcome digest: ${o.outcome_digest} · observed at: ${iso(o.observed_at_ms)}`, "muted");
  at.dataset.observedAtMs = String(o.observed_at_ms);
  box.appendChild(at);

  // A ROLLBACK CONFIRMATION, when the row carries one. It is a FIELD being
  // present, not a verdict being computed: the registry writes the target
  // revision and the lifecycle event the rollback was, and this prints them.
  if (o.rollback_to_revision_id !== null) {
    const confirmed = el(
      "p",
      `ROLLBACK CONFIRMED: a session that opened after the decision carried revision ${o.rollback_to_revision_id}, ` +
        `selected by lifecycle event ${o.rollback_action_event_id ?? "—"}. The outcomes before it are untouched.`,
      "rollback-confirmation",
    );
    confirmed.dataset.rollbackToRevisionId = o.rollback_to_revision_id;
    confirmed.dataset.rollbackActionEventId = o.rollback_action_event_id ?? "";
    box.appendChild(confirmed);
  }

  for (const c of o.conflicts) {
    const line = el(
      "p",
      `CONFLICT: a redelivery under ${c.outcome_ref} claimed ${c.claimed_outcome}; the filed ${c.existing_outcome} stands ` +
        `and the claim is kept as its own evidence · ${c.conflict_digest}`,
      "conflict",
    );
    line.dataset.conflictId = c.conflict_id;
    line.dataset.claimedOutcome = c.claimed_outcome;
    line.dataset.existingOutcome = c.existing_outcome;
    box.appendChild(line);
  }

  // THE FORM THAT CLOSES THE LOOP — a new draft revision out of this outcome.
  // It is offered for every outcome and gated by NEITHER a rule of this file's
  // making: whether a revision may be made from a particular outcome is the
  // server's answer (`origin: failure` on an outcome that did not fail is a
  // `412`), and the refusal is shown as one.
  const form = el("div", undefined, "row revision-form");
  form.dataset.outcomeId = o.outcome_id;
  const observationLabel = el("label", "What was observed");
  observationLabel.htmlFor = `observation-${o.outcome_id}`;
  form.appendChild(observationLabel);
  const observation = el("textarea");
  observation.id = `observation-${o.outcome_id}`;
  observation.rows = 2;
  observation.cols = 40;
  form.appendChild(observation);
  const goalLabel = el("label", "The goal, stated in advance");
  goalLabel.htmlFor = `goal-${o.outcome_id}`;
  form.appendChild(goalLabel);
  const goal = el("input");
  goal.id = `goal-${o.outcome_id}`;
  goal.type = "text";
  goal.size = 30;
  form.appendChild(goal);
  const origin = el("select");
  origin.id = `origin-${o.outcome_id}`;
  for (const value of ["failure", "feedback"]) {
    const option = el("option", value);
    option.value = value;
    origin.appendChild(option);
  }
  form.appendChild(origin);
  const procedureLabel = el("label", "The corrected procedure");
  procedureLabel.htmlFor = `procedure-${o.outcome_id}`;
  form.appendChild(procedureLabel);
  const procedure = el("textarea");
  procedure.id = `procedure-${o.outcome_id}`;
  procedure.rows = 2;
  procedure.cols = 40;
  form.appendChild(procedure);
  const create = el("button", "Create a revision from this outcome");
  create.type = "button";
  create.className = "create-revision";
  create.dataset.outcomeId = o.outcome_id;
  create.addEventListener("click", () => guard(() => createRevision(o.outcome_id)));
  form.appendChild(create);
  box.appendChild(form);
  parent.appendChild(box);
}

/** `P5-FR-08`, `P5-FR-09`: the new revision is created through the ordinary
 *  revise path, so it faces the same semantic and security preview and the same
 *  owner approval. This console sends the observation, the goal and the text; it
 *  compiles nothing and approves nothing by asking. */
async function createRevision(outcomeId: string): Promise<void> {
  const observation = (document.getElementById(`observation-${outcomeId}`) as HTMLTextAreaElement | null)?.value ?? "";
  const goal = (document.getElementById(`goal-${outcomeId}`) as HTMLInputElement | null)?.value ?? "";
  const origin = (document.getElementById(`origin-${outcomeId}`) as HTMLSelectElement | null)?.value ?? "failure";
  const procedure = (document.getElementById(`procedure-${outcomeId}`) as HTMLTextAreaElement | null)?.value ?? "";
  const lines = procedure.split("\n").filter((line) => line.trim().length > 0);
  await ownerOutcomeCommand(
    "create_revision",
    `/v1/console/outcomes/${encodeURIComponent(outcomeId)}/revision`,
    {
      origin,
      observation,
      improvement_goal: goal,
      revision: lines.length > 0 ? { sections: { procedure: lines } } : {},
    },
    `revision-from:${outcomeId}:${origin}:${goal}`,
  );
}

function renderLineage(parent: HTMLElement, l: LineageRow): void {
  const box = el("div", undefined, "panel lineage");
  box.dataset.revisionSourceId = l.revision_source_id;
  box.dataset.revisionId = l.draft_revision_id;
  box.dataset.parentRevisionId = l.parent_revision_id;
  box.dataset.sourceOutcomeId = l.source_outcome_id;
  box.dataset.goalKind = l.goal_kind;
  box.appendChild(el("h4", `revision ${l.draft_revision_id} came from ${l.origin}`));
  box.appendChild(el("p", `parent revision: ${l.parent_revision_id}`));
  box.appendChild(el("p", `from outcome: ${l.source_outcome_id} · session ${l.source_session_id}`));
  box.appendChild(el("p", `on the receipt: ${l.source_receipt_id ?? "—"}`, "muted"));
  box.appendChild(el("p", `what was observed: ${l.observation}`));
  box.appendChild(el("p", `the goal, stated in advance (${l.goal_kind}): ${l.improvement_goal}`));
  parent.appendChild(box);
}

function renderComparison(parent: HTMLElement, c: ComparisonRow): void {
  const box = el("div", undefined, "panel comparison");
  box.dataset.comparisonId = c.comparison_id;
  box.dataset.verdict = c.verdict;
  box.dataset.verdictReasonCode = c.verdict_reason_code;
  box.dataset.comparable = String(c.comparable);
  box.dataset.baselineRevisionId = c.baseline_revision_id;
  box.dataset.candidateRevisionId = c.candidate_revision_id;
  // THE SERVER'S VERDICT, RENDERED (`P5-FR-12`). The registry decided it from a
  // comparable scenario and a goal stated in advance; this line is a rendering of
  // that decision and there is no expression here that could produce another.
  const verdictLine = el("p", `verdict: ${c.verdict} — ${label(VERDICT_LABEL, c.verdict)}`);
  verdictLine.dataset.verdict = c.verdict;
  box.appendChild(verdictLine);
  box.appendChild(el("p", `the registry's reason (${c.verdict_reason_code}): ${c.verdict_reason}`));
  box.appendChild(el("p", `comparable scenario: ${String(c.comparable)}`));
  box.appendChild(el("p", `the goal, stated in advance (${c.goal_kind}): ${c.improvement_goal}`));
  box.appendChild(el("p", `old: revision ${c.baseline_revision_id} · outcome ${c.baseline_outcome}`));
  box.appendChild(el("p", `new: revision ${c.candidate_revision_id} · outcome ${c.candidate_outcome}`));
  box.appendChild(
    el("p", "This verdict is the registry's, computed from the two runs and the goal; the console displays it.", "muted"),
  );
  parent.appendChild(box);
}

function outcomeOption(o: OutcomeRow): HTMLOptionElement {
  const option = el("option", `${o.outcome} · revision ${o.draft_revision_id} · ${iso(o.observed_at_ms)}`);
  option.value = o.outcome_id;
  return option;
}

/** `P5-FR-11`: the owner names two runs. Everything else — the exact revisions,
 *  the original observation, whether the two are the same scenario, and the
 *  verdict — is the server's. */
async function compare(): Promise<void> {
  const baseline = (document.getElementById("baseline-outcome") as HTMLSelectElement | null)?.value ?? "";
  const candidate = (document.getElementById("candidate-outcome") as HTMLSelectElement | null)?.value ?? "";
  await ownerOutcomeCommand(
    "compare",
    "/v1/console/comparisons",
    { baseline_outcome_id: baseline, candidate_outcome_id: candidate },
    `compare:${baseline}:${candidate}`,
  );
}

/**
 * THE ROLLBACK, IN TWO ACTS, AND WHAT EACH ONE IS.
 *
 * The first act is the owner's: choose an earlier APPROVED revision and read back
 * what selecting it would mean before confirming it. The second act is not the
 * owner's at all — a rollback is CONFIRMED when a session that opened after the
 * decision reports carrying the target revision, which arrives as a
 * `rolled_back` outcome above (`P5-FR-13`, `INV-02`).
 *
 * The command the confirm button sends is the SAME one P3's revision control
 * sends, to the same route, gated by the same server verdict
 * (`actions.select_revision.allowed`) — a rollback is not a second operation and
 * this file does not make it one.
 */
function renderRollback(parent: HTMLElement, capability: Capability, assignment: AssignmentDetail): void {
  const box = el("div", undefined, "panel rollback");
  box.dataset.assignmentId = assignment.assignment_id;
  box.dataset.desiredRevisionId = assignment.desired.revision_id;
  box.appendChild(el("h4", `Roll back the assignment to ${assignment.agent_id}`));
  const select = el("select");
  select.id = `rollback-target-${assignment.assignment_id}`;
  for (const approval of assignment.approved_revisions) {
    const option = el("option", `revision ${approval.revision} · ${approval.content_digest}`);
    option.value = approval.draft_revision_id;
    select.appendChild(option);
  }
  box.appendChild(select);

  const plan = el("p", "");
  plan.className = "rollback-plan";
  plan.dataset.assignmentId = assignment.assignment_id;
  plan.dataset.targetRevisionId = "";

  const confirm = el("button", "Confirm the rollback");
  confirm.type = "button";
  confirm.className = "confirm-rollback";
  confirm.dataset.assignmentId = assignment.assignment_id;
  confirm.dataset.reasonCode = assignment.actions.select_revision.reason_code;
  // the server's boolean, and nothing else, decides whether this is possible
  confirm.disabled = !assignment.actions.select_revision.allowed;
  // …and the owner has not confirmed anything they have not been shown, so the
  // button appears only once the plan has been read back. `hidden` is a step in
  // the owner's own act of confirming; it is not a rule about the registry.
  confirm.hidden = true;
  confirm.addEventListener("click", () => guard(() => confirmRollback(assignment, select.value)));

  const prepare = el("button", "Prepare the rollback");
  prepare.type = "button";
  prepare.className = "prepare-rollback";
  prepare.dataset.assignmentId = assignment.assignment_id;
  prepare.addEventListener("click", () => {
    const target = select.value;
    rollbackPlans.set(assignment.assignment_id, target);
    plan.dataset.targetRevisionId = target;
    plan.textContent =
      `This selects revision ${target} for the assignment to ${assignment.agent_id}. It ` +
      `${effectiveLabel(capability.effective_from)}, and it is CONFIRMED only when a session that opens ` +
      `after this decision reports carrying that revision — not by this click.`;
    confirm.hidden = false;
  });
  box.appendChild(prepare);
  box.appendChild(confirm);
  box.appendChild(plan);
  parent.appendChild(box);
}

async function confirmRollback(assignment: AssignmentDetail, fallbackTarget: string): Promise<void> {
  const target = rollbackPlans.get(assignment.assignment_id) ?? fallbackTarget;
  await ownerOutcomeCommand(
    "rollback",
    `/v1/console/assignments/${encodeURIComponent(assignment.assignment_id)}/revision`,
    { revision_id: target, if_version: assignment.entity_version, reason: noteText() },
    `${assignment.assignment_id}:revision:${target}:${assignment.entity_version}`,
  );
}

function renderOutcomes(history: OutcomeHistory, capability: Capability | null): void {
  const box = byId("outcomes");
  clear(box);
  box.hidden = false;
  box.dataset.capabilityId = history.draft_id;
  box.dataset.outcomeCount = String(history.outcomes.length);
  box.dataset.lineageCount = String(history.lineage.length);
  box.dataset.comparisonCount = String(history.comparisons.length);

  box.appendChild(el("h2", "Outcomes and the revision loop"));
  const effective = el(
    "p",
    capability
      ? `A new revision or a rollback chosen here ${effectiveLabel(capability.effective_from)}.`
      : "Open a capability to see its outcomes.",
  );
  effective.id = "outcome-effective-from";
  effective.dataset.effectiveFrom = capability ? capability.effective_from : "";
  box.appendChild(effective);

  const result = el("p", "");
  result.id = "outcome-result";
  result.dataset.result = "";
  result.dataset.code = "";
  result.dataset.currentState = "";
  box.appendChild(result);

  box.appendChild(el("h3", `Outcomes (${history.outcomes.length})`));
  const rows = el("div");
  rows.id = "outcome-rows";
  rows.dataset.count = String(history.outcomes.length);
  for (const o of history.outcomes) renderOutcome(rows, o);
  if (history.outcomes.length === 0) rows.appendChild(el("p", "no outcome has been filed for this capability", "muted"));
  box.appendChild(rows);

  box.appendChild(el("h3", `Revisions made from an outcome (${history.lineage.length})`));
  const lineage = el("div");
  lineage.id = "lineage";
  lineage.dataset.count = String(history.lineage.length);
  for (const l of history.lineage) renderLineage(lineage, l);
  box.appendChild(lineage);

  box.appendChild(el("h3", "Compare an old run with a new one"));
  const form = el("div", undefined, "row");
  form.id = "comparison-form";
  const baselineLabel = el("label", "Old");
  baselineLabel.htmlFor = "baseline-outcome";
  form.appendChild(baselineLabel);
  const baseline = el("select");
  baseline.id = "baseline-outcome";
  for (const o of history.outcomes) baseline.appendChild(outcomeOption(o));
  form.appendChild(baseline);
  const candidateLabel = el("label", "New");
  candidateLabel.htmlFor = "candidate-outcome";
  form.appendChild(candidateLabel);
  const candidate = el("select");
  candidate.id = "candidate-outcome";
  for (const o of history.outcomes) candidate.appendChild(outcomeOption(o));
  form.appendChild(candidate);
  const run = el("button", "Compare");
  run.type = "button";
  run.id = "compare";
  run.addEventListener("click", () => guard(() => compare()));
  form.appendChild(run);
  box.appendChild(form);

  const comparisons = el("div");
  comparisons.id = "comparisons";
  comparisons.dataset.count = String(history.comparisons.length);
  for (const c of history.comparisons) renderComparison(comparisons, c);
  box.appendChild(comparisons);

  box.appendChild(el("h3", "Rollback"));
  const rollbacks = el("div");
  rollbacks.id = "rollbacks";
  const assignments = capability ? capability.assignments : [];
  rollbacks.dataset.count = String(assignments.length);
  for (const assignment of assignments) renderRollback(rollbacks, capability!, assignment);
  if (assignments.length === 0) rollbacks.appendChild(el("p", "no assignment to roll back", "muted"));
  box.appendChild(rollbacks);
}

async function loadOutcomes(draftId: string): Promise<void> {
  const history = await api<OutcomeHistory>("GET", `/v1/console/capabilities/${encodeURIComponent(draftId)}/outcomes`);
  outcomeHistory = history;
  renderOutcomes(history, openCapabilityView);
}

/** The refetch of this region, after an owner command and on demand. */
async function refreshOutcomes(): Promise<void> {
  if (openCapabilityId === null) return;
  await loadOutcomes(openCapabilityId);
}

// ------------------------------------------------- V1 P6: the session region
//
// `P6-FR-14` — the owner runs a session and SEES proposed, loaded, invoked and
// an outcome, EACH WITH ITS PROVENANCE. Until P6 this console had every one of
// those facts on the server (`GET /v1/console/sessions/{id}` has answered with
// the stage chain, the receipts and the outcomes since P4) and no place to read
// them: the outcome region showed the outcome and named the receipt under it,
// but the stages a run passed through were reachable only by reading the JSON.
// A requirement whose answer is "open the API response in a tab" is not met by
// a console, so the region below renders them.
//
// IT COMPUTES NOTHING. Every stage, every source and every time is a server
// field; the page groups them by entry and prints them. `INV-05` is why: a
// client that derived `invoked` from the presence of a receipt would be a
// second implementation of a rule the registry already owns.

interface SessionStage {
  stage: string;
  at_ms: number;
  source: string;
  receipt_id: string | null;
  receipt_digest: string | null;
  runtime_session_ref: string | null;
  invocation_ref: string | null;
}

interface SessionEntryView {
  entry_id: string;
  draft_revision_id: string;
  revision: number;
  skill_name: string;
  content_digest: string;
  stage: string;
  reason_code: string;
  chain: SessionStage[];
}

/** The outcome OF AN ENTRY, which is not the same shape as the outcome rows the
 *  capability screen reads: this one is per loadout entry, carries the latest
 *  outcome as its own fields and every delivery under it as `history`. They are
 *  rendered by different functions because they are different facts, and a
 *  renderer shared between them would print `undefined` for whichever fields the
 *  other one has — which is exactly what the first draft of this region did. */
interface SessionOutcomeHistoryRow {
  outcome_id: string;
  outcome: string;
  evidence_class: string | null;
  reason_code: string;
  reason: string;
  source: string;
  confirmation_source: string | null;
  invocation_receipt_id: string | null;
  observed_at_ms: number;
}

interface SessionEntryOutcome {
  entry_id: string;
  draft_revision_id: string;
  skill_name: string;
  outcome: string;
  outcome_id: string | null;
  evidence_class: string | null;
  reason_code: string;
  reason: string;
  source: string;
  observed_at_ms: number;
  history: SessionOutcomeHistoryRow[];
}

function renderSessionOutcome(parent: HTMLElement, o: SessionEntryOutcome): void {
  const latest = o.history.length > 0 ? o.history[o.history.length - 1]! : null;
  const box = el("div", undefined, "panel outcome");
  box.dataset.outcomeId = o.outcome_id ?? "";
  box.dataset.entryId = o.entry_id;
  box.dataset.outcome = o.outcome;
  box.dataset.source = o.source;
  box.dataset.evidenceClass = o.evidence_class ?? "";
  box.dataset.invocationReceiptId = latest?.invocation_receipt_id ?? "";
  box.appendChild(el("h4", `Outcome — ${o.outcome}: ${label(OUTCOME_LABEL, o.outcome)}`));
  box.appendChild(el("p", `reason (${o.reason_code}): ${o.reason}`));
  box.appendChild(
    el("p", `source: ${o.source} · evidence: ${o.evidence_class ?? "—"} · skill: ${o.skill_name}`, "muted"),
  );
  box.appendChild(el("p", `revision: ${o.draft_revision_id} · entry: ${o.entry_id}`, "muted"));
  box.appendChild(el("p", `observed at: ${new Date(o.observed_at_ms).toISOString()}`, "muted"));
  for (const row of o.history) {
    const line = el("p", undefined, "muted");
    line.className = "muted outcome-delivery";
    line.dataset.outcomeId = row.outcome_id;
    line.dataset.invocationReceiptId = row.invocation_receipt_id ?? "";
    line.textContent =
      `delivery ${row.outcome_id}: ${row.outcome} (${row.reason_code}) · source ${row.source} · ` +
      `invocation receipt: ${row.invocation_receipt_id ?? "—"} · at ${new Date(row.observed_at_ms).toISOString()}`;
    box.appendChild(line);
  }
  parent.appendChild(box);
}

interface SessionView {
  contract: string;
  session: {
    session_id: string;
    agent_id: string;
    runtime_kind: string;
    runtime_version: string | null;
    opened_by_agent_id: string;
    opened_by_source: string;
    opened_at_ms: number;
  };
  entries: SessionEntryView[];
  outcomes: SessionEntryOutcome[];
}

function renderSessionView(view: SessionView): void {
  const box = byId("session");
  clear(box);
  box.hidden = false;
  box.dataset.sessionId = view.session.session_id;
  box.dataset.runtimeKind = view.session.runtime_kind;
  box.dataset.entryCount = String(view.entries.length);
  box.dataset.outcomeCount = String(view.outcomes.length);

  box.appendChild(el("h2", `Session ${view.session.session_id}`));
  box.appendChild(
    el(
      "p",
      `runtime: ${view.session.runtime_kind} ${view.session.runtime_version ?? "—"} · agent: ${view.session.agent_id}`,
      "muted",
    ),
  );
  box.appendChild(
    el(
      "p",
      `opened by ${view.session.opened_by_agent_id} (${view.session.opened_by_source}) at ` +
        `${new Date(view.session.opened_at_ms).toISOString()}`,
      "muted",
    ),
  );

  for (const entry of view.entries) {
    const panel = el("div", undefined, "panel session-entry");
    panel.dataset.entryId = entry.entry_id;
    panel.dataset.revisionId = entry.draft_revision_id;
    panel.dataset.stage = entry.stage;
    panel.dataset.reasonCode = entry.reason_code;
    panel.appendChild(el("h3", `${entry.skill_name} · revision ${entry.revision}`));
    panel.appendChild(el("p", `revision ${entry.draft_revision_id} · ${entry.content_digest}`, "muted"));
    panel.appendChild(el("p", `stage now: ${entry.stage} (${entry.reason_code})`));

    const chain = el("div");
    chain.className = "stage-chain";
    chain.dataset.count = String(entry.chain.length);
    chain.dataset.stages = entry.chain.map((s) => s.stage).join(",");
    for (const step of entry.chain) {
      const row = el("div", undefined, "stage");
      row.dataset.stage = step.stage;
      row.dataset.source = step.source;
      row.dataset.receiptId = step.receipt_id ?? "";
      row.dataset.runtimeSessionRef = step.runtime_session_ref ?? "";
      row.dataset.atMs = String(step.at_ms);
      row.appendChild(
        el(
          "p",
          `${step.stage} · source: ${step.source} · receipt: ${step.receipt_id ?? "—"} · ` +
            `runtime ref: ${step.runtime_session_ref ?? "—"} · invocation: ${step.invocation_ref ?? "—"} · ` +
            `at ${new Date(step.at_ms).toISOString()}`,
        ),
      );
      if (step.receipt_digest) row.appendChild(el("p", `receipt digest: ${step.receipt_digest}`, "muted"));
      chain.appendChild(row);
    }
    panel.appendChild(chain);
    box.appendChild(panel);
  }

  const outcomes = el("div");
  outcomes.id = "session-outcomes";
  outcomes.dataset.count = String(view.outcomes.length);
  for (const outcome of view.outcomes) renderSessionOutcome(outcomes, outcome);
  box.appendChild(outcomes);
}

async function openSessionView(sessionId: string): Promise<void> {
  const view = await api<SessionView>("GET", `/v1/console/sessions/${encodeURIComponent(sessionId)}`);
  renderSessionView(view);
}

// -------------------------------------------------------------- the Proofline
//
// THE ELEVEN VIEWS THE REGISTRY HAS ALWAYS SERVED, IN THE BROWSER.
//
// The confirmed v1.0.0 gap was not that the data was missing: `Registry.
// dashboard()` answered all eleven views over Bearer and over MCP, and the
// Console showed none of them. So this region is a RENDERER and deliberately
// nothing else. It does not know what a view means, does not decide what a cell
// says, does not compute a total and does not translate a value into a verdict.
// Everything below is `payload.<field>` (`INV-01`, `INV-02`).
//
// WHAT IT MUST NOT LOSE, AND HOW THE CODE MAKES THAT HARD TO GET WRONG. Every
// dashboard value arrives as ONE STRING carrying its answer and its method —
// `unknown · why: … · kind: … · source: … · window: … · boundary: …`. A renderer
// that printed the answer and dropped the tail would be the provenance loss
// SPEC.md section 6.4 forbids, and it would look perfectly fine on the screen.
// So the cell is parsed with the lossless parser in `src/console-proofline.ts`
// and EVERY part is written into the DOM — `formatCell(parseCell(t)) === t`, and
// the gate reassembles a cell from the rendered nodes and compares it to the
// bytes the server sent.
//
// AND `unknown` STAYS `unknown` (`INV-03`). The four answers that must not
// collapse into one another get four class tokens and four visible marks, and
// the token is the ANSWER reduced — never a palette word, because a mapping step
// is where two answers land on one class.

interface ProoflineSection {
  key: string;
  title: string;
  fields: string[];
  rows: Array<Record<string, string>>;
  empty: string;
  note?: string;
  row_class_field?: string;
  next_cursor?: string | null;
}

interface ProoflineNotice {
  kind: string;
  subject: string;
  detail: string;
}

interface ProoflineEnvelope {
  contract: string;
  view: string;
  title: string;
  views: string[];
  sections: ProoflineSection[];
  demo_mode: boolean;
  notices: ProoflineNotice[];
}

/** The view the address bar names, or null while none is open. The hash is the
 *  navigation: a link is a link, the back button works, and a reload opens the
 *  same view — none of which is true of a click handler that keeps the current
 *  view in a variable. */
const PROOFLINE_HASH = "#/proofline/";

let prooflineFilter = "";

/** The view list the navigation is built from. It comes from the server's
 *  payload and is held so a view that FAILED can still be navigated away from. */
let prooflineViews: string[] = [];

function prooflineViewOfHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith(PROOFLINE_HASH)) return null;
  const view = decodeURIComponent(hash.slice(PROOFLINE_HASH.length));
  return view.length === 0 ? null : view;
}

/** The navigation, built from the SERVER's list of views and never from a list
 *  compiled into this bundle — a bundle-side copy is a second place for a view
 *  to fail to appear, which is the defect being fixed rather than a fix. */
function renderProoflineNav(views: string[], current: string | null): void {
  const nav = byId("proofline-nav");
  clear(nav);
  for (const view of views) {
    const link = el("a", view);
    link.href = `${PROOFLINE_HASH}${encodeURIComponent(view)}`;
    link.setAttribute("role", "listitem");
    link.dataset.view = view;
    if (view === current) link.setAttribute("aria-current", "page");
    nav.appendChild(link);
  }
}

/** ONE CELL. The answer, then every part of its method, each under its own key.
 *  Nothing is summarised and nothing is dropped. */
function renderProoflineCell(td: HTMLTableCellElement, text: string): void {
  const cell = parseCell(text);
  td.classList.add(answerToken(cell.value));
  td.dataset.answer = cell.value;
  const value = el("span", cell.value, "cell-value");
  td.appendChild(value);
  if (cell.parts.length === 0) return;
  const dl = el("dl", undefined, "cell-method");
  dl.setAttribute("aria-label", PROOFLINE_TEXT.provenance_label);
  for (const part of cell.parts) {
    const wrap = el("div");
    if (part.key === null) {
      wrap.dataset.unkeyed = "true";
    } else {
      wrap.appendChild(el("dt", part.key));
    }
    wrap.appendChild(el("dd", part.text));
    dl.appendChild(wrap);
  }
  td.appendChild(dl);
}

function renderProoflineSection(parent: HTMLElement, s: ProoflineSection): void {
  const box = el("section");
  box.dataset.sectionKey = s.key;
  box.appendChild(el("h3", s.title));
  if (s.note !== undefined) box.appendChild(el("p", s.note, "muted"));

  if (s.rows.length === 0) {
    // A FILTER THAT SELECTED NOTHING IS NOT AN EMPTY REGISTRY. The server's own
    // `empty` sentence is a statement about the data; saying it while a filter
    // is on would attribute the filter's work to the registry. The two states
    // are different words and a different action.
    if (prooflineFilter.length > 0) {
      box.dataset.rows = "filtered-to-zero";
      box.appendChild(el("p", PROOFLINE_TEXT.filtered_to_zero, "muted"));
      const clear_ = el("button", PROOFLINE_TEXT.clear_filter);
      clear_.type = "button";
      clear_.dataset.action = "clear-filter";
      clear_.addEventListener("click", () => {
        byId<HTMLInputElement>("proofline-filter").value = "";
        prooflineFilter = "";
        guard(() => showProofline());
      });
      box.appendChild(clear_);
    } else {
      box.dataset.rows = "empty";
      box.appendChild(el("p", s.empty, "muted"));
    }
    parent.appendChild(box);
    return;
  }

  box.dataset.rows = String(s.rows.length);
  const scroll = scrollBox("Proofline table");
  const table = el("table");
  const thead = el("thead");
  const hrow = el("tr");
  for (const field of s.fields) hrow.appendChild(el("th", field));
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const row of s.rows) {
    const tr = el("tr");
    if (s.row_class_field !== undefined) {
      const value = row[s.row_class_field];
      if (value !== undefined) tr.dataset.rowState = parseCell(value).value;
    }
    for (const field of s.fields) {
      const td = el("td");
      td.dataset.field = field;
      const text = row[field];
      // A FIELD THE SECTION ANNOUNCED AND THE ROW DOES NOT CARRY is reported as
      // that, not drawn as an empty box. An empty box is the dash `INV-03`
      // forbids wearing a different hat.
      renderProoflineCell(td, text === undefined ? `unknown${PROVENANCE_SEP}why: the server sent no ${field} for this row` : text);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  box.appendChild(scroll);
  parent.appendChild(box);
}

function renderProofline(payload: ProoflineEnvelope): void {
  const box = byId("proofline");
  clear(box);
  box.dataset.state = "loaded";
  box.dataset.view = payload.view;
  box.setAttribute("aria-busy", "false");
  renderProoflineNav(payload.views, payload.view);

  box.appendChild(el("h2", payload.title));
  if (payload.demo_mode) {
    const badge = el("p", "demo_mode", "muted");
    badge.dataset.demoMode = "true";
    box.appendChild(badge);
  }

  // The registry's own notices, verbatim. `dead_letters` carries the one that
  // says queued is not delivered (`INV-07`); it is rendered as sent, beside two
  // sections this renderer never merges.
  for (const notice of payload.notices) {
    const n = el("div", undefined, "notice");
    n.dataset.noticeKind = notice.kind;
    n.appendChild(el("h3", `${notice.kind}: ${notice.subject}`));
    n.appendChild(el("p", notice.detail));
    box.appendChild(n);
  }

  // The sections first, then the banner ABOUT them — see below.
  const firstSection = box.childNodes.length;
  for (const s of payload.sections) renderProoflineSection(box, s);

  // §7 `partial`: an unknown value is a value, and the ones that were read stay
  // on the page beside it. It is not a loading state, which is why it renders
  // WITH the data rather than instead of it.
  //
  // THE COUNT IS OF THE RENDERED CELLS. This file labels the server's values and
  // never compares one — a comparison here is where a client-side verdict starts
  // — so the banner counts the nodes the renderer produced rather than deciding
  // for itself which payload values are unknown. The class it counts is
  // `answerToken` of the answer itself, so the count cannot disagree with the
  // table underneath it.
  const total = box.querySelectorAll(CELL_SELECTOR).length;
  const unknown = box.querySelectorAll(UNKNOWN_CELL_SELECTOR).length;
  if (unknown > 0) {
    const partial = el("div", undefined, "partial");
    partial.dataset.partial = "true";
    partial.dataset.unknownCells = String(unknown);
    partial.dataset.totalCells = String(total);
    partial.appendChild(el("h3", PROOFLINE_TEXT.partial_heading));
    partial.appendChild(el("p", partialDetail(unknown, total)));
    box.insertBefore(partial, box.childNodes[firstSection] ?? null);
  }
}

/** The refusal and the failure, told apart, because they are different facts
 *  and only one of them is worth retrying. Both print the SERVER's code and the
 *  SERVER's message; neither infers anything from them. */
function renderProoflineFailure(view: string, failure: ApiFailure): void {
  const box = byId("proofline");
  clear(box);
  box.setAttribute("aria-busy", "false");
  box.dataset.view = view;
  const denied = failure.code === "FORBIDDEN" || failure.status === 403;
  box.dataset.state = denied ? "forbidden" : "error";
  box.dataset.code = failure.code;
  box.appendChild(el("h2", denied ? PROOFLINE_TEXT.forbidden_heading : PROOFLINE_TEXT.error_heading));
  const p = el("p", refusalDetail(failure.code, failure.message), "blocking");
  p.setAttribute("role", "alert");
  box.appendChild(p);
  if (!denied) {
    // BOUNDED RECOVERY, and only where recovery is the answer. A `FORBIDDEN`
    // retried is a `FORBIDDEN` again, and a button offering it would be the
    // console suggesting the server did not mean it.
    const retry = el("button", PROOFLINE_TEXT.retry);
    retry.type = "button";
    retry.dataset.action = "retry";
    retry.addEventListener("click", () => guard(() => showProofline()));
    box.appendChild(retry);
  }
}

/** Open the view the address bar names. */
async function showProofline(): Promise<void> {
  const view = prooflineViewOfHash();
  if (view === null) return;
  const box = byId("proofline");
  clear(box);
  box.dataset.state = "loading";
  box.dataset.view = view;
  box.setAttribute("aria-busy", "true");
  box.appendChild(el("p", PROOFLINE_TEXT.loading, "muted"));
  renderProoflineNav(prooflineViews, view);
  const query = prooflineFilter.length > 0 ? `?q=${encodeURIComponent(prooflineFilter)}` : "";
  try {
    const payload = await api<ProoflineEnvelope>("GET", `/v1/console/dashboard/${encodeURIComponent(view)}${query}`);
    renderProofline(payload);
  } catch (e) {
    renderProoflineFailure(view, failureOf(e));
  }
}

function wireProofline(views: string[]): void {
  prooflineViews = views;
  renderProoflineNav(views, prooflineViewOfHash());
  window.addEventListener("hashchange", () => guard(() => showProofline()));
  const filter = byId<HTMLInputElement>("proofline-filter");
  filter.addEventListener("change", () => {
    const next = filter.value.trim();
    // A `change` THAT CHANGED NOTHING RELOADS NOTHING. The browser fires this
    // event on blur as well as on commit, so a reader who typed a filter and
    // then reached for a control would otherwise re-issue the same request and
    // redraw the section under their own pointer — the control they were about
    // to press detached between the press and the release.
    if (next === prooflineFilter) return;
    prooflineFilter = next;
    guard(() => showProofline());
  });
}

// ------------------------------------------------------------------ the boot

async function boot(): Promise<void> {
  const me = await api<{
    agent_id: string;
    expires_at_ms: number;
    csrf_token: string;
    contract: string;
    inbox_kinds?: string[];
  }>("GET", "/v1/console/session");
  csrfToken = me.csrf_token;
  // v1.1: THE INBOX FILTERS THIS SESSION IS ENTITLED TO ASK FOR, taken from the
  // server before the first Inbox request is made.
  //
  // The Approval Inbox's kind selector used to be filled from the Inbox
  // RESPONSE. A reviewer session may not ask for `kind=all` — the server refuses
  // the question rather than narrowing the answer — so a reviewer's first load
  // was `FORBIDDEN`, no envelope arrived, the selector stayed EMPTY, and the one
  // control that could have asked the admissible question was the control that
  // never got drawn. A reviewer could not reach the Approval Inbox in a browser
  // at all, which is every claim about recording a review verdict without curl.
  //
  // The set is the SERVER'S, and the default is its first member rather than a
  // name written here: the page must not hold a second opinion about which
  // filters a role may use (`INV-01`).
  inboxKinds = Array.isArray(me.inbox_kinds) ? me.inbox_kinds : [];
  if (inboxKinds.length > 0 && !inboxKinds.includes(approvalsKind)) approvalsKind = inboxKinds[0];
  if (inboxKinds.length > 0) fillFilter(byId<HTMLSelectElement>("approvals-kind"), inboxKinds, approvalsKind);
  byId("who").textContent = `${me.agent_id}`;
  byId("session-note").textContent = `session ends ${new Date(me.expires_at_ms).toISOString()}`;
  byId("refresh").addEventListener("click", () => guard(() => loadInbox()));
  byId<HTMLSelectElement>("state-filter").addEventListener("change", () => guard(() => loadInbox()));
  byId("logout").addEventListener("click", () => {
    // `P2-R1-002`: the browser leaves the page only if the SERVER said the
    // session is revoked. A logout that failed shows the refusal and keeps the
    // owner where they are, because a sign-in page after a failed revocation is
    // the console telling them something the server does not agree with.
    guard(async () => {
      await api("POST", "/v1/console/logout", {}, crypto.randomUUID());
      window.location.assign("/console/login");
    });
  });
  byId("refresh-capabilities").addEventListener("click", () => guard(() => loadCapabilities()));
  byId("refresh-outcomes").addEventListener("click", () => guard(() => refreshOutcomes()));
  byId("open-session").addEventListener("click", () =>
    guard(() => openSessionView(byId<HTMLInputElement>("session-id").value.trim())),
  );
  // THE PROOFLINE IS WIRED FROM THE SERVER'S OWN VIEW LIST. One request for one
  // view yields the vocabulary the navigation is built from, so a view added to
  // `DASHBOARD_VIEWS` appears in this Console without an edit here — which is
  // the whole of why the list is not compiled into this bundle.
  // THE BUSY STATE IS STAMPED BEFORE THE REQUEST, not after it. A region that
  // acquired a state only once an answer arrived would be a region with NO state
  // for exactly as long as the server is slow — which is the whole of the §7
  // `initial loading` row, and the one moment an operator is actually looking at
  // it.
  const region = byId("proofline");
  region.dataset.state = "loading";
  region.setAttribute("aria-busy", "true");
  region.appendChild(el("p", PROOFLINE_TEXT.loading, "muted"));
  const first = await api<ProoflineEnvelope>("GET", `/v1/console/dashboard/${CONSOLE_FIRST_VIEW}`);
  wireProofline(first.views);
  if (prooflineViewOfHash() === null) {
    window.location.hash = `${PROOFLINE_HASH}${encodeURIComponent(first.view)}`;
  }
  await showProofline();
  // v1.1: THE THREE DECISION SURFACES, OPENED BEFORE THE v1.0 REGIONS.
  //
  // The order is load-bearing and not a preference. `loadInbox` and
  // `loadCapabilities` are owner-only reads that REJECT for a reviewer session,
  // and a rejection there aborts `boot`. Opening the decision surfaces first
  // means a reviewer — who is entitled to the review half of the Approval Inbox
  // and is entitled to be told `FORBIDDEN` for the rest — sees the server's
  // answer on those regions instead of three regions that never acquired a
  // state at all. Each of the three catches its own refusal, so none of them
  // can abort this function in turn.
  await bootDecisionSurfaces();
  await loadInbox();
  await loadCapabilities();
  if (openDraftId) await openDraft(openDraftId);
  if (openCapabilityId) await openCapability(openCapabilityId);
}


// ===========================================================================
// V1.1 P2 — THE THREE DECISION SURFACES: the Approval Inbox, the revocation
// flow and the webhook flow (SPEC.md section 6.4, SPEC.md section 6.5).
//
// WHAT IS DIFFERENT ABOUT THESE THREE AND THE PROOFLINE ABOVE. The Proofline is
// a read: the worst a bug in it can do is show an owner a wrong number. These
// three CHANGE THE REGISTRY, and two of them change it irreversibly — a
// revocation reason is immutable and a human approval is spent. So every
// control below obeys three rules that the read surface does not need:
//
//   1. A CONTROL IS OFFERED ONLY WHERE THE SERVER SAID IT MAY BE. `eligibility`
//      is `{allowed, reason_code}` and this file renders it. Where `allowed` is
//      false the control is NOT DRAWN AT ALL and the server's own reason code is
//      shown in its place. A greyed-out button is a button an operator can still
//      reach with a keyboard, a devtools console or an accidental Enter, and it
//      is a path that would send a request the server is going to refuse.
//
//   2. EVERY LABEL NAMES ITS OBJECT, ITS SCOPE AND ITS CONSEQUENCE, and the four
//      human-decision labels are fixed verbatim by SPEC.md section 6.4. They come
//      from `src/console-surfaces.ts` through a TABLE keyed by the two server
//      fields that select one, so this file never assembles one and never falls
//      back to a generic word.
//
//   3. A CONSEQUENCE IS STATED BEFORE THE COMMIT, NOT AFTER IT. The revocation
//      panel says what revoking does and — the part that matters — what it does
//      NOT do, before the button exists to be pressed.
//
// AND ONE RULE ABOUT WHAT IS NEVER CLAIMED (`INV-07`): a queued notification is
// queued. The committed panel below reports three separate counts under three
// separate names and there is no place in this file where the queued one is
// rendered as a delivery.

import {
  APPROVALS_TEXT,
  FORBIDDEN_CODE,
  HUMAN_DECISION_LABELS,
  INVALID_CODE,
  REPLAY_HEADER,
  REPLAY_HEADER_TRUE,
  REVIEW_ACTION_LABELS,
  REVOCATION_CONSEQUENCES,
  REVOCATION_TEXT,
  REVOKE_PRIMARY_LABELS,
  STALE_CODES,
  WEBHOOK_TEXT,
  decisionRefusalDetail,
  disabledDetail,
  revocationSubject,
  revokePrimaryKey,
  webhookTestWithheldDetail,
} from "../src/console-surfaces.ts";

interface ConsoleEligibility {
  allowed: boolean;
  reason_code: string;
}

interface ApprovalSkillRef {
  skill_id: string;
  skill_version_id: string;
  slug: string;
  semantic_version: string;
  risk_level: string;
}

interface ApprovalAdoptionRef {
  adoption_request_id: string;
  adopter_agent_id: string;
  state: string;
}

interface ApprovalCondition {
  code: string;
  source: string;
  detail: string;
}

interface ApprovalDecisionRow {
  decision: string;
  actor_agent_id: string;
  actor_type: string;
  actor_role: string;
  note: string | null;
  server_at_ms: number;
}

interface ApprovalItem {
  item_id: string;
  kind: string;
  status: string;
  skill: ApprovalSkillRef;
  adoption_request: ApprovalAdoptionRef | null;
  conditions: ApprovalCondition[];
  eligibility: ConsoleEligibility;
  consequence: { scope: string; reusable: boolean; blocks_until_decided: boolean };
  decision: ApprovalDecisionRow | null;
  decision_history: ApprovalDecisionRow[];
  updated_at_ms: number;
  server_at_ms: number;
}

interface ApprovalEnvelope {
  contract: string;
  statuses: string[];
  kinds: string[];
  status_filters: string[];
  kind_filters: string[];
  items: ApprovalItem[];
  next_cursor: string | null;
}

interface RevocationContext {
  contract: string;
  skill_version_id: string;
  skill_id: string;
  slug: string;
  semantic_version: string;
  manifest_hash: string;
  state: string;
  revocation_reason: string | null;
  superseded_by: string | null;
  active_adopters: Array<{ adopter_agent_id: string; receipts: number }>;
  successors: Array<{ skill_version_id: string; semantic_version: string; state: string }>;
  notices: { queued: number; delivered: number; dead_lettered: number; total: number };
  eligibility: ConsoleEligibility;
  server_at_ms: number;
}

interface RevokeResult {
  contract: string;
  skill_version_id: string;
  state: string;
  reason: string | null;
  superseded_by: string | null;
  notifications_queued?: number;
  notified_adopters?: number;
  tlog_seq?: number;
  lineage_tlog_seq?: number;
  noop?: boolean;
}

interface WebhookRow {
  webhook_id: string;
  url: string;
  status: string;
  failure_count: number;
  /**
   * The server's verdict on the one action this row offers. Optional in the
   * TYPE and never computed when it is missing: a build of this page served an
   * older registry gets no control and says the verdict is absent, which is the
   * `INV-03` answer. Guessing `allowed: true` from the row's other columns
   * would be the client recomputing eligibility that `INV-02` puts on the
   * server.
   */
  eligibility?: ConsoleEligibility;
}

interface WebhookTestResult {
  contract: string;
  delivered: boolean;
  http_status: number | null;
  latency_ms: number;
  error_code: string | null;
  error_detail: string | null;
}

/**
 * A mutation, with the ONE fact about the response that is not in its body.
 *
 * `src/http.ts` marks an idempotent replay with a header, and it has to be a
 * header: the body of a replay is byte-identical to the body of the original —
 * that is what replay means — so a page that tried to tell them apart from the
 * payload would be guessing. `api()` above is unchanged and every read still
 * goes through it; this adds the header read for the three surfaces that need
 * a replay badge, and returns the parsed body exactly as `api()` does.
 */
async function mutate<T>(
  method: string,
  path: string,
  body: unknown,
  idempotencyKey: string,
  out: { replayed: boolean },
): Promise<T> {
  const payload = { ...((body ?? {}) as Record<string, unknown>), idempotency_key: idempotencyKey };
  const res = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Skillonomia-Console-CSRF": csrfToken,
    },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  out.replayed = res.headers.get(REPLAY_HEADER) === REPLAY_HEADER_TRUE;
  // THE SAME READER `api()` USES, and not a second copy of it: `INV-05`'s check
  // is one check in one place, and the header above is the only thing this
  // function does that `api()` does not.
  return readConsoleResponse<T>(res, path);
}

/** A definition list row — the shape every fact on these three surfaces is
 *  written in, so a gate reads `[data-fact="manifest_hash"]` rather than the
 *  third `<p>` of a panel. */
function fact(parent: HTMLElement, key: string, label: string, value: string): HTMLElement {
  const wrap = el("div", undefined, "row");
  wrap.dataset.fact = key;
  wrap.appendChild(el("dt", label));
  wrap.appendChild(el("dd", value));
  parent.appendChild(wrap);
  return wrap;
}

/** A facts panel. `<dl>` because these are keyed facts and a reader with a
 *  screen reader is told which key each value belongs to. */
function facts(parent: HTMLElement, className: string): HTMLElement {
  const dl = el("dl", undefined, className);
  parent.appendChild(dl);
  return dl;
}

/**
 * A typed refusal, sorted into the §7 row it belongs to and rendered there.
 *
 * ONE FUNCTION FOR ALL THREE SURFACES, because the classification is the
 * SERVER'S CODE and not a judgement about the surface. `INVALID_SCHEMA` is the
 * validation-error row, the three codes SPEC.md section 6.4 names for a
 * concurrent change are the stale row, `FORBIDDEN` is permission denied and
 * everything else is the network/server row with a bounded retry. A surface
 * that sorted these differently would be a surface where the same server answer
 * means two things.
 */
function renderFailure(
  box: HTMLElement,
  failure: ApiFailure,
  text: { forbidden_heading: string; error_heading: string; invalid_heading: string; stale_heading: string; retry: string; stale_refresh: string },
  onRetry: () => void,
  preserved: string | null,
): void {
  const notice = el("div", undefined, "notice");
  if (failure.code === FORBIDDEN_CODE) {
    box.dataset.state = "forbidden";
    notice.appendChild(el("h3", text.forbidden_heading));
  } else if (failure.code === INVALID_CODE) {
    box.dataset.state = "invalid";
    notice.appendChild(el("h3", text.invalid_heading));
  } else if (STALE_CODES.includes(failure.code)) {
    box.dataset.state = "stale";
    notice.appendChild(el("h3", text.stale_heading));
  } else {
    box.dataset.state = "error";
    notice.appendChild(el("h3", text.error_heading));
  }
  box.dataset.code = failure.code;
  const p = el("p", decisionRefusalDetail(failure.code, failure.message), "blocking");
  p.setAttribute("role", "alert");
  notice.appendChild(p);
  if (failure.current_state !== undefined) {
    const cur = el("p", failure.current_state, "muted");
    cur.dataset.currentState = failure.current_state;
    notice.appendChild(cur);
  }
  // WHAT THE OPERATOR TYPED IS STILL THERE, and the page says so. §7's
  // validation-error row is not "show an error": it is "show an error and do not
  // throw away the sentence the operator wrote", because retyping a revocation
  // reason from memory is how a reason ends up different from the one intended.
  if (preserved !== null) {
    const kept = el("p", preserved, "muted");
    kept.dataset.preserved = "true";
    notice.appendChild(kept);
  }
  // A BOUNDED RECOVERY, AND ONLY WHERE RECOVERY IS THE ANSWER.
  //
  //   `FORBIDDEN` — none. Retried, it is `FORBIDDEN` again, and a button
  //     offering it would be this console suggesting the server did not mean it.
  //   `INVALID_SCHEMA` — none. The recovery is to change the note, the reason or
  //     the URL, and those are on the page with what the operator wrote still in
  //     them; a button that re-sent the same refused body would be a button that
  //     produces the same refusal.
  //   stale — a REFRESH, not a retry, because the point is to show what the
  //     other session actually did rather than to try again over the top of it.
  //   anything else — one retry.
  if (box.dataset.state === "stale" || box.dataset.state === "error") {
    const stale = box.dataset.state === "stale";
    const button = el("button", stale ? text.stale_refresh : text.retry);
    button.type = "button";
    button.dataset.action = stale ? "refresh" : "retry";
    button.addEventListener("click", onRetry);
    notice.appendChild(button);
  }
  box.appendChild(notice);
}

/** The replay badge. Drawn from the header and from nothing else. */
function replayBadge(parent: HTMLElement, replayed: boolean, sentence: string): void {
  if (!replayed) return;
  const badge = el("p", sentence, "notice");
  badge.dataset.replayed = "true";
  parent.appendChild(badge);
}

/** The busy stamp every one of these regions wears while a request is out.
 *  Stamped BEFORE the request, so the region is never stateless for exactly as
 *  long as the server is slow — which is the one moment §7's loading rows are
 *  about. */
function beginLoading(box: HTMLElement, sentence: string): void {
  clear(box);
  box.dataset.state = "loading";
  box.setAttribute("aria-busy", "true");
  box.appendChild(el("p", sentence, "muted"));
}

// ------------------------------------------------------ the Approval Inbox

/** The filters, defaulting to "everything". `all` is the ABSENCE of a filter,
 *  which is what makes "this inbox is empty" and "your filters selected
 *  nothing" two different states with two different sentences. */
let approvalsStatus = "all";
let approvalsKind = "all";
/** The kind filters THIS session may ask the Inbox for, as the server named
 *  them on `GET /v1/console/session`. Empty until `boot` has read it. */
let inboxKinds: string[] = [];
let approvalsEnvelope: ApprovalEnvelope | null = null;
let openApprovalId: string | null = null;

/** The item the detail panel is about, found in the envelope the list was drawn
 *  from. There is no per-item route: the Inbox is one projection and asking for
 *  a single row again would be asking a second question that could answer
 *  differently from the list the operator is looking at. */
function approvalItem(itemId: string): ApprovalItem | null {
  for (const item of approvalsEnvelope?.items ?? []) if (item.item_id === itemId) return item;
  return null;
}

/** A filter control, built from the FILTER vocabulary the server sent.
 *
 *  NOT from the item vocabulary beside it. `statuses` are the four states an
 *  item can be in and `status_filters` are the three values the query parameter
 *  accepts; a control built from the first would offer an operator `conditional`
 *  as a filter and the route would answer `INVALID_SCHEMA`. The two lists are
 *  both the server's, and picking the right one is this function's whole job. */
function fillFilter(select: HTMLSelectElement, values: string[], current: string): void {
  clear(select);
  for (const value of values) {
    const option = el("option", value);
    option.value = value;
    if (value === current) option.selected = true;
    select.appendChild(option);
  }
}

function renderApprovals(envelope: ApprovalEnvelope): void {
  approvalsEnvelope = envelope;
  const box = byId("approvals");
  clear(box);
  box.setAttribute("aria-busy", "false");
  box.dataset.state = "loaded";
  box.dataset.items = String(envelope.items.length);

  fillFilter(byId<HTMLSelectElement>("approvals-status"), envelope.status_filters, approvalsStatus);
  // THE SESSION'S SET WINS over the envelope's. `kind_filters` is the whole
  // vocabulary of the surface and is the same for every reader; the session's
  // set is the part THIS reader may ask for, and offering a reviewer the `all`
  // this envelope lists would be offering a control whose only outcome is a
  // refusal.
  fillFilter(
    byId<HTMLSelectElement>("approvals-kind"),
    inboxKinds.length > 0 ? inboxKinds : envelope.kind_filters,
    approvalsKind,
  );

  if (envelope.items.length === 0) {
    // ZERO ROWS IS NOT ONE STATE. A filter that selected nothing is a statement
    // about the filter; an inbox that never had an item is a statement about the
    // workspace. Saying the second while a filter is on would attribute the
    // filter's work to the registry, and the actions differ too.
    // "FILTERED" MEANS NARROWER THAN WHAT THIS SESSION MAY ASK FOR, not narrower
    // than `all`. A reviewer's widest admissible question is `kind=review`, and
    // calling that a filter would tell a reviewer with nothing to review that
    // their filter is hiding something.
    const widestKind = inboxKinds.includes("all") || inboxKinds.length === 0 ? "all" : inboxKinds[0];
    const filtered = approvalsStatus !== "all" || approvalsKind !== widestKind;
    box.dataset.state = filtered ? "filtered-to-zero" : "empty";
    box.appendChild(el("p", filtered ? APPROVALS_TEXT.filtered_to_zero : APPROVALS_TEXT.empty, "muted"));
    const action = el("button", filtered ? APPROVALS_TEXT.clear_filter : APPROVALS_TEXT.empty_action);
    action.type = "button";
    action.dataset.action = filtered ? "clear-filter" : "reload";
    action.addEventListener("click", () => {
      if (filtered) {
        approvalsStatus = "all";
        // …to the widest kind this session may actually ask for, which for a
        // reviewer is not `all`.
        approvalsKind = inboxKinds.includes("all") || inboxKinds.length === 0 ? "all" : inboxKinds[0];
      }
      guard(() => loadApprovals());
    });
    box.appendChild(action);
    return;
  }

  const scroll = scrollBox("Approval inbox table");
  const table = el("table");
  table.id = "approval-rows-table";
  const thead = el("thead");
  const hrow = el("tr");
  for (const h of ["Item", "Kind", "Status", "Skill", "Version", "Risk", "Decision offered", ""]) {
    hrow.appendChild(el("th", h));
  }
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el("tbody");
  tbody.id = "approval-rows";
  for (const item of envelope.items) {
    const tr = el("tr");
    tr.dataset.itemId = item.item_id;
    tr.dataset.kind = item.kind;
    tr.dataset.status = item.status;
    tr.dataset.allowed = String(item.eligibility.allowed);
    tr.dataset.reasonCode = item.eligibility.reason_code;
    tr.appendChild(el("td", item.item_id));
    tr.appendChild(el("td", item.kind));
    tr.appendChild(el("td", item.status));
    tr.appendChild(el("td", item.skill.slug));
    tr.appendChild(el("td", item.skill.semantic_version));
    tr.appendChild(el("td", item.skill.risk_level));
    tr.appendChild(el("td", item.eligibility.reason_code));
    const cell = el("td");
    const open = el("button", `Open ${item.item_id}`);
    open.type = "button";
    open.dataset.action = "open-approval";
    open.dataset.itemId = item.item_id;
    open.addEventListener("click", () => guard(async () => openApproval(item.item_id)));
    cell.appendChild(open);
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  box.appendChild(scroll);
}

/**
 * ONE ITEM, AND EVERY CONTROL IT IS ENTITLED TO.
 *
 * The order is the order a person decides in: what is being decided, why a
 * decision is being asked for, what deciding it affects, what has already been
 * decided, and only then the controls. A page that put the button first would be
 * a page whose consequential action is reachable before its consequence is read.
 */
function renderApprovalDetail(item: ApprovalItem): void {
  const box = byId("approval-detail");
  clear(box);
  box.hidden = false;
  box.dataset.itemId = item.item_id;
  box.dataset.kind = item.kind;
  box.dataset.status = item.status;
  box.dataset.allowed = String(item.eligibility.allowed);
  box.dataset.reasonCode = item.eligibility.reason_code;
  box.dataset.state = "loaded";
  // A REDRAW IS THE END OF WHATEVER WAS IN FLIGHT. Leaving the action state at
  // `pending` on a panel that has already been redrawn with the server's answer
  // would leave the region reporting a request that finished.
  box.removeAttribute("data-action-state");
  box.setAttribute("aria-busy", "false");

  box.appendChild(el("h2", item.item_id));
  const what = facts(box, "panel");
  fact(what, "kind", "kind", item.kind);
  fact(what, "status", "status", item.status);
  fact(what, "slug", "skill", item.skill.slug);
  fact(what, "skill_version_id", "skill_version_id", item.skill.skill_version_id);
  fact(what, "semantic_version", "semantic_version", item.skill.semantic_version);
  fact(what, "risk_level", "risk_level", item.skill.risk_level);
  if (item.adoption_request !== null) {
    // THE EXACT REQUEST AN ADOPTION APPROVAL IS SPENT ON. A high-risk approval
    // binds to one request and is not reusable; showing the id is what lets an
    // owner see WHICH one before spending it.
    fact(what, "adoption_request_id", "adoption_request_id", item.adoption_request.adoption_request_id);
    fact(what, "adopter_agent_id", "adopter_agent_id", item.adoption_request.adopter_agent_id);
    fact(what, "adoption_request_state", "adoption request state", item.adoption_request.state);
  }

  const why = el("div", undefined, "panel");
  why.appendChild(el("h3", APPROVALS_TEXT.conditions_label));
  why.dataset.conditions = String(item.conditions.length);
  for (const condition of item.conditions) {
    const row = el("div", undefined, "row");
    row.dataset.conditionCode = condition.code;
    row.appendChild(el("dt", condition.code));
    row.appendChild(el("dd", `${condition.source}: ${condition.detail}`));
    why.appendChild(row);
  }
  box.appendChild(why);

  const consequence = facts(box, "panel");
  consequence.dataset.consequence = "true";
  fact(consequence, "consequence_scope", APPROVALS_TEXT.consequence_label, item.consequence.scope);
  fact(consequence, "consequence_reusable", "reusable", String(item.consequence.reusable));
  fact(consequence, "consequence_blocks", "blocks until decided", String(item.consequence.blocks_until_decided));

  const history = el("div", undefined, "panel");
  history.dataset.history = String(item.decision_history.length);
  history.appendChild(el("h3", APPROVALS_TEXT.history_label));
  for (const decision of item.decision_history) {
    const row = el("p", `${decision.decision} · ${decision.actor_agent_id} · ${decision.actor_type}/${decision.actor_role} · ${iso(decision.server_at_ms)}${decision.note === null ? "" : ` · ${decision.note}`}`);
    row.dataset.decision = decision.decision;
    history.appendChild(row);
  }
  box.appendChild(history);

  const note = el("textarea") as HTMLTextAreaElement;
  note.id = "approval-note";
  note.rows = 2;
  note.cols = 60;
  const noteLabel = el("label", APPROVALS_TEXT.note_label);
  noteLabel.htmlFor = "approval-note";
  box.appendChild(noteLabel);
  box.appendChild(note);

  const controls = el("div", undefined, "row");
  controls.id = "approval-controls";
  box.appendChild(controls);

  // §7 `disabled`: the server offers no decision, so THERE IS NO CONTROL. Not a
  // greyed one — none. The reason code is the server's own and is shown as its
  // own, because a browser that translated `NOT_HUMAN_APPROVER` into friendlier
  // words would be restating a decision it did not make.
  if (!item.eligibility.allowed) {
    const denied = el("div", undefined, "notice");
    // `data-withheld`, and NOT `data-disabled`. The source guard in
    // `test/v1p5-outcome-loop.test.ts` reads every assignment to a `disabled`
    // property in this file and requires the right-hand side to be the in-flight
    // constant or a negated server verdict; a dataset key of the same name is
    // indistinguishable from that when the rule is read off the source. The
    // attribute means something different anyway — no control was drawn at all,
    // which is a stronger statement than a control being greyed out.
    denied.dataset.withheld = "true";
    denied.dataset.reasonCode = item.eligibility.reason_code;
    denied.appendChild(el("h3", APPROVALS_TEXT.disabled_heading));
    denied.appendChild(el("p", disabledDetail(item.eligibility.reason_code)));
    controls.appendChild(denied);
    return;
  }

  // THE LABELS COME FROM A TABLE KEYED BY THE SERVER'S OWN TWO FIELDS. A `kind`
  // this build has no labels for yields no controls rather than a generic word:
  // a wrong label on a consequential button is worse than a missing button,
  // because the missing button is visible.
  const humanLabels = HUMAN_DECISION_LABELS[item.kind];
  if (humanLabels !== undefined) {
    for (const decision of ["approved", "denied"]) {
      const label = humanLabels[decision];
      if (label === undefined) continue;
      const button = el("button", label);
      button.type = "button";
      button.dataset.action = "decide";
      button.dataset.decision = decision;
      button.addEventListener("click", () => guard(() => decideApproval(item, decision)));
      controls.appendChild(button);
    }
    return;
  }

  // The review half. A different type from a human approval, with its own words.
  for (const verdict of ["approve", "reject", "conditional"]) {
    const label = REVIEW_ACTION_LABELS[verdict];
    if (label === undefined) continue;
    const button = el("button", label);
    button.type = "button";
    button.dataset.action = "verdict";
    button.dataset.verdict = verdict;
    button.addEventListener("click", () => guard(() => recordVerdict(item, verdict)));
    controls.appendChild(button);
  }
}

/** Hold every control on this surface while one request is out. §7's
 *  action-loading row is exactly this: a second press of a consequential button
 *  must not become a second request, and the region says it is busy while the
 *  first one is outstanding. */
function holdApprovalControls(): void {
  const box = byId("approval-detail");
  box.dataset.actionState = "pending";
  box.setAttribute("aria-busy", "true");
  for (const node of box.querySelectorAll("#approval-controls button")) {
    (node as HTMLButtonElement).disabled = true;
  }
  const busy = el("p", APPROVALS_TEXT.deciding, "muted");
  busy.dataset.actionBusy = "true";
  byId("approval-controls").appendChild(busy);
}

async function decideApproval(item: ApprovalItem, decision: string): Promise<void> {
  const note = byId<HTMLTextAreaElement>("approval-note").value;
  holdApprovalControls();
  const replay = { replayed: false };
  try {
    await mutate<{ contract: string }>(
      "POST",
      `/v1/console/versions/${encodeURIComponent(item.skill.skill_version_id)}/approvals`,
      {
        scope: item.kind,
        decision,
        ...(item.adoption_request === null ? {} : { adoption_request_id: item.adoption_request.adoption_request_id }),
        ...(note.length === 0 ? {} : { note }),
      },
      // ONE KEY PER (ITEM, DECISION, NOTE), not one per attempt. A double click
      // that got past the held controls is the SAME decision with the SAME
      // payload, which is what makes the registry's replay rule answer it with
      // the original response instead of a second approval row.
      `console-approval-${item.item_id}-${decision}-${note.length}`,
      replay,
    );
    await loadApprovals();
    const reloaded = approvalItem(item.item_id);
    if (reloaded !== null) renderApprovalDetail(reloaded);
    replayBadge(byId("approval-detail"), replay.replayed, APPROVALS_TEXT.replay_badge);
  } catch (e) {
    renderApprovalFailure(failureOf(e), note, item.item_id, () => guard(() => decideApproval(item, decision)));
  }
}

async function recordVerdict(item: ApprovalItem, verdict: string): Promise<void> {
  const note = byId<HTMLTextAreaElement>("approval-note").value;
  holdApprovalControls();
  const replay = { replayed: false };
  try {
    await mutate<{ contract: string }>(
      "POST",
      `/v1/console/versions/${encodeURIComponent(item.skill.skill_version_id)}/reviews`,
      { action: "verdict", verdict, ...(note.length === 0 ? {} : { note }) },
      `console-review-${item.item_id}-${verdict}-${note.length}`,
      replay,
    );
    await loadApprovals();
    const reloaded = approvalItem(item.item_id);
    if (reloaded !== null) renderApprovalDetail(reloaded);
    replayBadge(byId("approval-detail"), replay.replayed, APPROVALS_TEXT.replay_badge);
  } catch (e) {
    renderApprovalFailure(failureOf(e), note, item.item_id, () => guard(() => recordVerdict(item, verdict)));
  }
}

/** A refused decision, with the note still on the page. */
function renderApprovalFailure(failure: ApiFailure, note: string, itemId: string, again: (() => void) | null = null): void {
  const box = byId("approval-detail");
  box.setAttribute("aria-busy", "false");
  box.dataset.actionState = "failed";
  renderFailure(
    box,
    failure,
    {
      forbidden_heading: APPROVALS_TEXT.forbidden_heading,
      error_heading: APPROVALS_TEXT.error_heading,
      invalid_heading: APPROVALS_TEXT.invalid_heading,
      stale_heading: APPROVALS_TEXT.stale_heading,
      retry: APPROVALS_TEXT.retry,
      stale_refresh: APPROVALS_TEXT.stale_refresh,
    },
    // A LOST RESPONSE IS THE CASE THIS EXISTS FOR. The request may have reached
    // the registry and the answer may have been dropped on the way back, so the
    // recovery is to SEND THE SAME REQUEST AGAIN — same key, same payload —
    // which the registry answers with the original response rather than with a
    // second decision. That is what an idempotency key is for, and a recovery
    // that reloaded instead would leave the operator guessing whether their
    // decision landed.
    // WHICH RECOVERY BELONGS TO WHICH REFUSAL — the same split the revocation
    // surface makes, and for the same reasons. A stale item is RELOADED, because
    // the point is to show the decision the other session recorded. Anything
    // else is RESENT with the same key and the same payload, because a lost
    // answer is what an idempotency key is for and a reload would leave the
    // operator guessing whether their decision landed.
    again === null || STALE_CODES.includes(failure.code)
      ? () => guard(async () => {
          await loadApprovals();
          await openApproval(itemId);
        })
      : again,
    // THE NOTE IS STILL IN THE FIELD and it is also stated on the page, so the
    // promise is visible rather than merely true.
    note.length === 0 ? APPROVALS_TEXT.note_preserved : `${APPROVALS_TEXT.note_preserved} ${note}`,
  );
}

async function openApproval(itemId: string): Promise<void> {
  openApprovalId = itemId;
  if (approvalsEnvelope === null) await loadApprovals();
  const item = approvalItem(itemId);
  if (item === null) {
    // The item is gone: another session decided or deleted it. That is §7's
    // stale row and not an error of this page.
    renderApprovalFailure(
      { status: 404, code: "NOT_FOUND", message: `${itemId} is no longer in this inbox` },
      "",
      itemId,
    );
    return;
  }
  renderApprovalDetail(item);
}

async function loadApprovals(): Promise<void> {
  const box = byId("approvals");
  beginLoading(box, APPROVALS_TEXT.loading);
  const query = `?status=${encodeURIComponent(approvalsStatus)}&kind=${encodeURIComponent(approvalsKind)}`;
  try {
    renderApprovals(await api<ApprovalEnvelope>("GET", `/v1/console/approvals${query}`));
  } catch (e) {
    box.setAttribute("aria-busy", "false");
    clear(box);
    renderFailure(
      box,
      failureOf(e),
      {
        forbidden_heading: APPROVALS_TEXT.forbidden_heading,
        error_heading: APPROVALS_TEXT.error_heading,
        invalid_heading: APPROVALS_TEXT.invalid_heading,
        stale_heading: APPROVALS_TEXT.stale_heading,
        retry: APPROVALS_TEXT.retry,
        stale_refresh: APPROVALS_TEXT.stale_refresh,
      },
      () => guard(() => loadApprovals()),
      null,
    );
  }
}

function wireApprovals(): void {
  const status = byId<HTMLSelectElement>("approvals-status");
  const kind = byId<HTMLSelectElement>("approvals-kind");
  status.addEventListener("change", () => {
    approvalsStatus = status.value;
    guard(() => loadApprovals());
  });
  kind.addEventListener("change", () => {
    approvalsKind = kind.value;
    guard(() => loadApprovals());
  });
}

// ------------------------------------------------------ the revocation flow

let revocationContext: RevocationContext | null = null;

/** Which of the two primary labels the form is currently offering. It follows
 *  the `<select>`, so a person who picked a replacement is never offered a
 *  button that does not mention one. */
function refreshRevokePrimary(): void {
  const button = document.getElementById("revoke-primary");
  const select = document.getElementById("revocation-successor");
  if (button === null || select === null) return;
  const chosen = (select as HTMLSelectElement).value.length > 0;
  const key = revokePrimaryKey(chosen);
  button.textContent = REVOKE_PRIMARY_LABELS[key];
  (button as HTMLElement).dataset.primaryKey = key;
}

/**
 * WHAT REVOKING THIS VERSION WOULD DO, BEFORE THERE IS A BUTTON TO DO IT WITH.
 *
 * The order on the page is the requirement: the exact bytes, the people already
 * holding them, what this does and does not do, the reason, the replacement —
 * and the primary action last. SPEC.md section 6.4 asks for the statements
 * "before commit", and putting the button above them would satisfy the letter
 * and defeat the point.
 */
function renderRevocationPrecommit(ctx: RevocationContext): void {
  revocationContext = ctx;
  const box = byId("revocation");
  clear(box);
  box.setAttribute("aria-busy", "false");
  box.dataset.state = "precommit";
  box.dataset.versionId = ctx.skill_version_id;
  box.dataset.allowed = String(ctx.eligibility.allowed);
  box.dataset.reasonCode = ctx.eligibility.reason_code;
  box.removeAttribute("data-action-state");

  box.appendChild(el("h2", REVOCATION_TEXT.precommit_heading));
  const subject = el("p", revocationSubject(ctx.skill_version_id, ctx.manifest_hash));
  subject.dataset.subject = "true";
  box.appendChild(subject);

  const what = facts(box, "panel");
  fact(what, "skill_version_id", "skill_version_id", ctx.skill_version_id);
  fact(what, "manifest_hash", "manifest hash", ctx.manifest_hash);
  fact(what, "slug", "skill", ctx.slug);
  fact(what, "semantic_version", "semantic_version", ctx.semantic_version);
  fact(what, "state", "registry state", ctx.state);
  fact(what, "superseded_by", "superseded_by", ctx.superseded_by ?? "null");

  // THE FOUR STATEMENTS, each its own node, each carrying its own code so a
  // gate asserts four separate facts rather than searching one paragraph.
  const consequences = el("div", undefined, "panel");
  consequences.dataset.consequences = String(REVOCATION_CONSEQUENCES.length);
  consequences.appendChild(el("h3", REVOCATION_TEXT.consequence_heading));
  const list = el("ul");
  for (const c of REVOCATION_CONSEQUENCES) {
    const li = el("li", c.text);
    li.dataset.consequence = c.code;
    list.appendChild(li);
  }
  consequences.appendChild(list);
  box.appendChild(consequences);

  const adopters = el("div", undefined, "panel");
  adopters.dataset.adopters = String(ctx.active_adopters.length);
  adopters.appendChild(el("h3", REVOCATION_TEXT.adopters_heading));
  if (ctx.active_adopters.length === 0) {
    adopters.appendChild(el("p", REVOCATION_TEXT.adopters_none, "muted"));
  } else {
    for (const a of ctx.active_adopters) {
      const p = el("p", `${a.adopter_agent_id} · receipts: ${a.receipts}`);
      p.dataset.adopter = a.adopter_agent_id;
      adopters.appendChild(p);
    }
  }
  box.appendChild(adopters);

  const form = el("div", undefined, "panel");
  const reasonLabel = el("label", REVOCATION_TEXT.reason_label);
  reasonLabel.htmlFor = "revocation-reason";
  const reason = el("textarea") as HTMLTextAreaElement;
  reason.id = "revocation-reason";
  reason.rows = 2;
  reason.cols = 60;
  form.appendChild(reasonLabel);
  form.appendChild(reason);

  const successorLabel = el("label", REVOCATION_TEXT.successor_label);
  successorLabel.htmlFor = "revocation-successor";
  const successor = el("select") as HTMLSelectElement;
  successor.id = "revocation-successor";
  const none = el("option", REVOCATION_TEXT.successor_none);
  none.value = "";
  successor.appendChild(none);
  for (const s of ctx.successors) {
    const option = el("option", `${s.semantic_version} · ${s.state} · ${s.skill_version_id}`);
    option.value = s.skill_version_id;
    option.dataset.successorState = s.state;
    successor.appendChild(option);
  }
  successor.addEventListener("change", () => refreshRevokePrimary());
  form.appendChild(successorLabel);
  form.appendChild(successor);
  box.appendChild(form);

  // §7 `disabled` again, and the same rule: no control at all, and the server's
  // own reason code in its place.
  if (!ctx.eligibility.allowed) {
    const denied = el("div", undefined, "notice");
    // `data-withheld`, and NOT `data-disabled`. The source guard in
    // `test/v1p5-outcome-loop.test.ts` reads every assignment to a `disabled`
    // property in this file and requires the right-hand side to be the in-flight
    // constant or a negated server verdict; a dataset key of the same name is
    // indistinguishable from that when the rule is read off the source. The
    // attribute means something different anyway — no control was drawn at all,
    // which is a stronger statement than a control being greyed out.
    denied.dataset.withheld = "true";
    denied.dataset.reasonCode = ctx.eligibility.reason_code;
    denied.appendChild(el("h3", REVOCATION_TEXT.disabled_heading));
    denied.appendChild(el("p", disabledDetail(ctx.eligibility.reason_code)));
    box.appendChild(denied);
    return;
  }

  const primary = el("button", REVOKE_PRIMARY_LABELS.without_successor);
  primary.type = "button";
  primary.id = "revoke-primary";
  primary.dataset.action = "revoke";
  primary.addEventListener("click", () => guard(() => commitRevocation(ctx)));
  box.appendChild(primary);
  refreshRevokePrimary();
}

/**
 * AFTER THE COMMIT — and this is where `INV-07` is either kept or broken.
 *
 * Three counts, three names, three nodes. `queued` is the number of notices the
 * delivery machine is holding; it is not a delivery and nothing here says it is.
 * `delivered` counts the ones an endpoint accepted and `dead_lettered` counts
 * the ones that failed for good — and the page carries the sentence saying so,
 * so the distinction survives a reader who does not know the schema.
 */
function renderRevocationCommitted(result: RevokeResult, ctx: RevocationContext, replayed: boolean): void {
  const box = byId("revocation");
  clear(box);
  box.setAttribute("aria-busy", "false");
  box.dataset.state = "committed";
  box.dataset.versionId = result.skill_version_id;
  box.removeAttribute("data-action-state");

  box.appendChild(el("h2", REVOCATION_TEXT.committed_heading));
  const after = facts(box, "panel");
  fact(after, "state", "registry state", result.state);
  fact(after, "reason", "reason", result.reason ?? "null");
  fact(after, "superseded_by", "successor", result.superseded_by ?? "null");
  fact(after, "tlog_seq", "tlog_seq", result.tlog_seq === undefined ? "null" : String(result.tlog_seq));
  fact(
    after,
    "lineage_tlog_seq",
    "lineage_tlog_seq",
    result.lineage_tlog_seq === undefined ? "null" : String(result.lineage_tlog_seq),
  );

  const counts = facts(box, "panel");
  counts.dataset.counts = "true";
  const queued = fact(counts, "notices_queued", REVOCATION_TEXT.count_queued_label, String(ctx.notices.queued));
  queued.dataset.count = "queued";
  const delivered = fact(counts, "notices_delivered", REVOCATION_TEXT.count_delivered_label, String(ctx.notices.delivered));
  delivered.dataset.count = "delivered";
  const failed = fact(counts, "notices_dead_lettered", REVOCATION_TEXT.count_failed_label, String(ctx.notices.dead_lettered));
  failed.dataset.count = "dead_lettered";
  const honesty = el("p", REVOCATION_TEXT.queued_is_not_delivered, "notice");
  honesty.dataset.queuedIsNotDelivered = "true";
  box.appendChild(honesty);

  // Into the view that holds the failures, by the Console's own navigation.
  const link = el("a", REVOCATION_TEXT.dead_letter_link);
  link.href = `${PROOFLINE_HASH}${encodeURIComponent("dead_letters")}`;
  link.dataset.action = "dead-letters";
  box.appendChild(link);

  replayBadge(box, replayed, REVOCATION_TEXT.replay_badge);
}

async function commitRevocation(ctx: RevocationContext): Promise<void> {
  const reason = byId<HTMLTextAreaElement>("revocation-reason").value;
  const successor = byId<HTMLSelectElement>("revocation-successor").value;
  const box = byId("revocation");
  box.dataset.actionState = "pending";
  box.setAttribute("aria-busy", "true");
  const primary = document.getElementById("revoke-primary");
  if (primary !== null) (primary as HTMLButtonElement).disabled = true;
  const busy = el("p", REVOCATION_TEXT.committing, "muted");
  busy.dataset.actionBusy = "true";
  box.appendChild(busy);

  const replay = { replayed: false };
  try {
    const result = await mutate<RevokeResult>(
      "POST",
      `/v1/console/versions/${encodeURIComponent(ctx.skill_version_id)}/revoke`,
      { reason, successor_version_id: successor.length === 0 ? null : successor },
      // The key is a function of the exact revocation, so a second press is the
      // same request and the registry replays it rather than writing again.
      `console-revoke-${ctx.skill_version_id}-${successor}-${reason.length}`,
      replay,
    );
    // THE COUNTS ARE RE-READ FROM THE SERVER, not taken from the mutation's
    // response: the mutation reports what it QUEUED, and what became of those
    // notices afterwards is a fact the delivery machine owns.
    const after = await api<RevocationContext>(
      "GET",
      `/v1/console/versions/${encodeURIComponent(ctx.skill_version_id)}/revocation`,
    );
    revocationContext = after;
    renderRevocationCommitted(result, after, replay.replayed);
  } catch (e) {
    box.setAttribute("aria-busy", "false");
    box.dataset.actionState = "failed";
    if (busy.parentNode !== null) busy.parentNode.removeChild(busy);
    renderFailure(
      box,
      failureOf(e),
      {
        forbidden_heading: REVOCATION_TEXT.forbidden_heading,
        error_heading: REVOCATION_TEXT.error_heading,
        invalid_heading: REVOCATION_TEXT.invalid_heading,
        stale_heading: REVOCATION_TEXT.stale_heading,
        retry: REVOCATION_TEXT.retry,
        stale_refresh: REVOCATION_TEXT.stale_refresh,
      },
      // WHICH RECOVERY BELONGS TO WHICH REFUSAL.
      //
      //   stale — RELOAD. Another session changed this version, and the point is
      //     to show what they recorded, not to try again over the top of it.
      //   anything else — RESEND, with the same key and the same payload. A lost
      //     answer is the case an idempotency key exists for: the registry
      //     replays the original response instead of writing a second time.
      () => guard(() => (STALE_CODES.includes(failureOf(e).code) ? loadRevocation(ctx.skill_version_id) : commitRevocation(ctx))),
      // THE REASON IS STILL IN THE FIELD, and this is the one that matters most
      // on this surface: a revocation reason is immutable once recorded, so a
      // page that cleared it would make the operator retype from memory the one
      // sentence they can never correct.
      reason.length === 0 ? REVOCATION_TEXT.reason_preserved : `${REVOCATION_TEXT.reason_preserved} ${reason}`,
    );
  }
}

async function loadRevocation(versionId: string): Promise<void> {
  const box = byId("revocation");
  beginLoading(box, REVOCATION_TEXT.loading);
  box.dataset.versionId = versionId;
  try {
    renderRevocationPrecommit(
      await api<RevocationContext>("GET", `/v1/console/versions/${encodeURIComponent(versionId)}/revocation`),
    );
  } catch (e) {
    box.setAttribute("aria-busy", "false");
    clear(box);
    renderFailure(
      box,
      failureOf(e),
      {
        forbidden_heading: REVOCATION_TEXT.forbidden_heading,
        error_heading: REVOCATION_TEXT.error_heading,
        invalid_heading: REVOCATION_TEXT.invalid_heading,
        stale_heading: REVOCATION_TEXT.stale_heading,
        retry: REVOCATION_TEXT.retry,
        stale_refresh: REVOCATION_TEXT.stale_refresh,
      },
      () => guard(() => loadRevocation(versionId)),
      null,
    );
  }
}

function wireRevocation(): void {
  byId("revocation-load").addEventListener("click", () =>
    guard(() => loadRevocation(byId<HTMLInputElement>("revocation-version").value.trim())),
  );
}

// --------------------------------------------------------- the webhook flow

let webhookRows: WebhookRow[] = [];

function renderWebhooks(items: WebhookRow[]): void {
  webhookRows = items;
  const box = byId("webhooks");
  clear(box);
  box.setAttribute("aria-busy", "false");
  box.dataset.state = items.length === 0 ? "empty" : "loaded";
  box.dataset.items = String(items.length);

  if (items.length === 0) {
    // The first valid action on a workspace that has never registered one is to
    // register one, and it is already in the region above this panel.
    box.appendChild(el("p", WEBHOOK_TEXT.empty, "muted"));
    return;
  }

  const scroll = scrollBox("Webhook endpoints table");
  const table = el("table");
  const thead = el("thead");
  const hrow = el("tr");
  for (const h of ["Endpoint", "URL", "Status", "Failure count", ""]) hrow.appendChild(el("th", h));
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el("tbody");
  tbody.id = "webhook-rows";
  for (const row of items) {
    const tr = el("tr");
    tr.dataset.webhookId = row.webhook_id;
    tr.dataset.status = row.status;
    tr.dataset.failureCount = String(row.failure_count);
    tr.appendChild(el("td", row.webhook_id));
    tr.appendChild(el("td", row.url));
    // PRODUCTION HEALTH, LABELLED AS SUCH. The test result below is drawn in a
    // panel of its own with a sentence saying it is not this — SPEC.md section
    // 6.5 keeps the test off these two columns server-side, and a page that drew
    // a probe's answer here would undo that in the only place an operator looks.
    const status = el("td", row.status);
    status.dataset.health = "status";
    tr.appendChild(status);
    const failures = el("td", String(row.failure_count));
    failures.dataset.health = "failure_count";
    tr.appendChild(failures);
    // §7 `disabled` for this column, and the same rule the other two follow: the
    // server's verdict is on the row, and where it says no THERE IS NO CONTROL.
    // Not a greyed one — none — and the server's own reason code in its place,
    // untranslated, because a browser that renamed `ENDPOINT_NOT_DELIVERABLE`
    // into friendlier words would be restating a decision it did not make.
    const verdict = row.eligibility;
    tr.dataset.allowed = verdict === undefined ? "unknown" : String(verdict.allowed);
    tr.dataset.reasonCode = verdict === undefined ? "" : verdict.reason_code;
    const cell = el("td");
    if (verdict === undefined || !verdict.allowed) {
      const withheld = el("div", undefined, "notice");
      // `data-withheld`, and NOT `data-disabled`, for the reason the approval
      // and revocation halves give: the source guard in
      // `test/v1p5-outcome-loop.test.ts` reads every assignment to a `disabled`
      // property in this file, and the attribute says a stronger thing anyway —
      // no control was drawn at all.
      withheld.dataset.withheld = "true";
      withheld.dataset.reasonCode = verdict === undefined ? "" : verdict.reason_code;
      withheld.appendChild(
        el("p", verdict === undefined ? WEBHOOK_TEXT.eligibility_absent : webhookTestWithheldDetail(verdict.reason_code)),
      );
      cell.appendChild(withheld);
    } else {
      const test = el("button", WEBHOOK_TEXT.send_test);
      test.type = "button";
      test.dataset.action = "test-webhook";
      test.dataset.webhookId = row.webhook_id;
      test.addEventListener("click", () => guard(() => testWebhook(row.webhook_id)));
      cell.appendChild(test);
    }
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  box.appendChild(scroll);
}

/**
 * ONE TEST DELIVERY'S RESULT — five fields, and a sentence about what it is not.
 *
 * The five are rendered under their own field names rather than under a verdict
 * this page composed, and the endpoint's response body is not among them
 * because the transport never returns one: `error_detail` is the transport's own
 * bounded, sanitized line. The panel says both of those things on the page, so
 * an operator reading a failure is not left to assume the endpoint's own words
 * are being withheld from them.
 */
function renderWebhookTest(webhookId: string, result: WebhookTestResult): void {
  const box = byId("webhooks");
  const panel = el("div", undefined, "panel");
  panel.id = "webhook-test-result";
  panel.dataset.webhookId = webhookId;
  panel.dataset.delivered = String(result.delivered);
  panel.appendChild(el("h3", WEBHOOK_TEXT.result_heading));
  const dl = facts(panel, "row");
  fact(dl, "delivered", WEBHOOK_TEXT.field_delivered, String(result.delivered));
  fact(dl, "http_status", WEBHOOK_TEXT.field_http_status, result.http_status === null ? WEBHOOK_TEXT.field_absent : String(result.http_status));
  fact(dl, "latency_ms", WEBHOOK_TEXT.field_latency_ms, String(result.latency_ms));
  fact(dl, "error_code", WEBHOOK_TEXT.field_error_code, result.error_code ?? WEBHOOK_TEXT.field_absent);
  fact(dl, "error_detail", WEBHOOK_TEXT.field_error_detail, result.error_detail ?? WEBHOOK_TEXT.field_absent);
  const notHealth = el("p", WEBHOOK_TEXT.result_not_health, "notice");
  notHealth.dataset.notHealth = "true";
  panel.appendChild(notHealth);
  const bounded = el("p", WEBHOOK_TEXT.detail_bounded, "muted");
  bounded.dataset.bounded = "true";
  panel.appendChild(bounded);
  box.appendChild(panel);
}

async function testWebhook(webhookId: string): Promise<void> {
  const box = byId("webhooks");
  box.dataset.actionState = "pending";
  box.setAttribute("aria-busy", "true");
  for (const node of box.querySelectorAll('button[data-action="test-webhook"]')) {
    (node as HTMLButtonElement).disabled = true;
  }
  const busy = el("p", WEBHOOK_TEXT.testing, "muted");
  busy.dataset.actionBusy = "true";
  box.appendChild(busy);
  const replay = { replayed: false };
  try {
    const result = await mutate<WebhookTestResult>(
      "POST",
      `/v1/console/webhooks/${encodeURIComponent(webhookId)}/test`,
      {},
      `console-webhook-test-${webhookId}`,
      replay,
    );
    // THE LIST IS RE-READ, so the health columns beside the result are the
    // registry's current answer and not a copy from before the probe. That is
    // what makes "the test moved no counter" a thing an operator can see rather
    // than a thing this page asserts.
    renderWebhooks((await api<{ items: WebhookRow[] }>("GET", "/v1/console/webhooks")).items);
    byId("webhooks").dataset.actionState = "done";
    renderWebhookTest(webhookId, result);
  } catch (e) {
    box.setAttribute("aria-busy", "false");
    box.dataset.actionState = "failed";
    if (busy.parentNode !== null) busy.parentNode.removeChild(busy);
    renderFailure(
      box,
      failureOf(e),
      {
        forbidden_heading: WEBHOOK_TEXT.forbidden_heading,
        error_heading: WEBHOOK_TEXT.error_heading,
        invalid_heading: WEBHOOK_TEXT.invalid_heading,
        stale_heading: WEBHOOK_TEXT.stale_heading,
        retry: WEBHOOK_TEXT.retry,
        stale_refresh: WEBHOOK_TEXT.stale_refresh,
      },
      () => guard(() => loadWebhooks()),
      null,
    );
  }
}

async function registerWebhookEndpoint(): Promise<void> {
  const field = byId<HTMLInputElement>("webhook-url");
  const url = field.value.trim();
  const box = byId("webhooks");
  box.dataset.actionState = "pending";
  box.setAttribute("aria-busy", "true");
  const button = byId<HTMLButtonElement>("webhook-register");
  button.disabled = true;
  const replay = { replayed: false };
  try {
    await mutate<{ webhook_id: string; url: string }>(
      "POST",
      "/v1/console/webhooks",
      { url },
      `console-webhook-register-${url}`,
      replay,
    );
    await loadWebhooks();
    byId("webhooks").dataset.actionState = "done";
    replayBadge(byId("webhooks"), replay.replayed, WEBHOOK_TEXT.replay_badge);
    field.value = "";
  } catch (e) {
    box.setAttribute("aria-busy", "false");
    box.dataset.actionState = "failed";
    button.removeAttribute("disabled");
    renderFailure(
      box,
      failureOf(e),
      {
        forbidden_heading: WEBHOOK_TEXT.forbidden_heading,
        error_heading: WEBHOOK_TEXT.error_heading,
        invalid_heading: WEBHOOK_TEXT.invalid_heading,
        stale_heading: WEBHOOK_TEXT.stale_heading,
        retry: WEBHOOK_TEXT.retry,
        stale_refresh: WEBHOOK_TEXT.stale_refresh,
      },
      () => guard(() => loadWebhooks()),
      // §7's validation-error row names the URL for this column: the endpoint an
      // operator typed is still in the field and the page says so.
      url.length === 0 ? WEBHOOK_TEXT.url_preserved : `${WEBHOOK_TEXT.url_preserved} ${url}`,
    );
  }
}

async function loadWebhooks(): Promise<void> {
  const box = byId("webhooks");
  beginLoading(box, WEBHOOK_TEXT.loading);
  try {
    renderWebhooks((await api<{ items: WebhookRow[] }>("GET", "/v1/console/webhooks")).items);
  } catch (e) {
    box.setAttribute("aria-busy", "false");
    clear(box);
    renderFailure(
      box,
      failureOf(e),
      {
        forbidden_heading: WEBHOOK_TEXT.forbidden_heading,
        error_heading: WEBHOOK_TEXT.error_heading,
        invalid_heading: WEBHOOK_TEXT.invalid_heading,
        stale_heading: WEBHOOK_TEXT.stale_heading,
        retry: WEBHOOK_TEXT.retry,
        stale_refresh: WEBHOOK_TEXT.stale_refresh,
      },
      () => guard(() => loadWebhooks()),
      null,
    );
  }
}

function wireWebhooks(): void {
  byId("webhook-register").addEventListener("click", () => guard(() => registerWebhookEndpoint()));
}

/**
 * The three decision surfaces, opened once the session is known.
 *
 * SEQUENTIAL AND NOT `Promise.all`. Each region stamps its own busy state before
 * its own request, and a failure in one must leave the other two on the page —
 * a combined await would make one refused surface hide two that answered.
 */
async function bootDecisionSurfaces(): Promise<void> {
  wireApprovals();
  wireRevocation();
  wireWebhooks();
  for (const region of ["approvals", "revocation", "webhooks"]) {
    const box = byId(region);
    box.dataset.state = "loading";
    box.setAttribute("aria-busy", "true");
  }
  // The revocation region has no subject until an operator names one, so it
  // waits rather than pretending to load. It says which state it is in.
  const revocation = byId("revocation");
  revocation.dataset.state = "idle";
  revocation.setAttribute("aria-busy", "false");
  await loadApprovals();
  await loadWebhooks();
  if (openApprovalId !== null) await openApproval(openApprovalId);
}

// ---------------------------------------------------------------- the entry
//
// LAST IN THE FILE, and it has to be: the sign-in page and the console page are
// two different documents served by the same bundle, the choice between them is
// which one is in the DOM, and every function and every module variable above
// must exist before either branch runs. A dispatch written half way up the file
// would put the module state declared below it in its temporal dead zone.

if (document.getElementById("login")) {
  wireLogin();
} else {
  void boot().catch((e) => showError(failureOf(e).message));
}
