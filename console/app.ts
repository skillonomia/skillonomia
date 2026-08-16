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
  REJECTABLE: "can be rejected",
  REVISABLE: "can be edited",
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
  // envelope, ahead of everything. `P2-R2-001`: the check used to sit at the
  // bottom, so a failed response was read for `code`, `message` and
  // `current_state` before its version had been looked at, and a payload
  // announcing a contract this build does not know was rendered on the strength
  // of being an error. A version boundary with a hole in it is not a boundary.
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
 * reads `console.v1`; a body that announces anything else, or announces nothing,
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
  observed_at_ms: number | null;
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
  box.appendChild(
    el("p", `observed at: ${o.observed_at_ms === null ? "never" : new Date(o.observed_at_ms).toISOString()}`, "muted"),
  );
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
  renderCapability(capability);
}

/** The refetch that follows EVERY owner command, successful or refused. */
async function refreshCapability(): Promise<void> {
  if (openCapabilityId === null) return;
  const capability = await api<Capability>("GET", `/v1/console/capabilities/${encodeURIComponent(openCapabilityId)}`);
  renderCapability(capability);
  await loadCapabilities();
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

// ------------------------------------------------------------------ the boot

async function boot(): Promise<void> {
  const me = await api<{ agent_id: string; expires_at_ms: number; csrf_token: string; contract: string }>(
    "GET",
    "/v1/console/session",
  );
  csrfToken = me.csrf_token;
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
  await loadInbox();
  await loadCapabilities();
  if (openDraftId) await openDraft(openDraftId);
  if (openCapabilityId) await openCapability(openCapabilityId);
}

if (document.getElementById("login")) {
  wireLogin();
} else {
  void boot().catch((e) => showError(failureOf(e).message));
}
