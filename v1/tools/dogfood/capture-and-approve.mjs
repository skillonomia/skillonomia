// P6 DOGFOOD, STEP ONE — the owner's part, through the product path.
//
//   node v1/tools/dogfood/capture-and-approve.mjs --base-url URL --owner-token T
//        --sources DIR [--only 03,07]
//
// It captures each source through `POST /v1/captures`, reads the semantic and
// security preview the registry produced, opens a console session the way the
// product opens one, and approves the exact revision the capture created. That
// is P1's capture/draft path and P2's review/approval path, driven as a caller
// rather than reimplemented — the reason this file is 150 lines and not 600.
//
// IT WRITES NO ROW. Every identifier it prints came back from the registry. A
// dogfood ledger assembled from a script's own bookkeeping would be the thing
// `P6-FR-08` and `P6-FR-09` exist to refuse, so this file prints what it was
// told and the ledger is computed later from the receipts themselves.
//
// It is idempotent per source: the capture and the approval both carry an
// idempotency key derived from the source's digest, so re-running it against
// the same registry re-reads rather than re-creates.
//
// EXIT: 0 every source reached an approved revision; 1 one did not.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const BASE = (opt("base-url") ?? "").replace(/\/$/, "");
const TOKEN = opt("owner-token") ?? "";
const SOURCES = opt("sources") ?? "";
const ONLY = (opt("only") ?? "").split(",").filter(Boolean);
if (!BASE || !TOKEN || !SOURCES) {
  console.error("usage: capture-and-approve.mjs --base-url URL --owner-token T --sources DIR [--only 01,02]");
  process.exit(2);
}

let failures = 0;
const ok = (cond, what, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures += 1;
};

async function fetchOnce(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    return await fetch(url, init);
  }
}
async function api(method, path, body) {
  const res = await fetchOnce(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// The console session, opened the way the product opens one: a ticket minted
// with the owner key, exchanged for a cookie. The approval below is a console
// act and goes through it, not through the owner key.
const ticket = await api("POST", "/v1/console/tickets", {});
if (ticket.status !== 201) {
  console.error(`REFUSED: no console ticket (${ticket.status}) ${ticket.text.slice(0, 200)}`);
  process.exit(2);
}
const openedSession = await fetch(`${BASE}/v1/console/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ ticket: ticket.json.ticket }),
});
const sessionBody = await openedSession.json();
const cookie = /skln_console=([^;]+)/.exec(openedSession.headers.get("set-cookie") ?? "")?.[1] ?? "";
const csrf = sessionBody.csrf_token;
if (openedSession.status !== 201 || !cookie) {
  console.error(`REFUSED: no console session (${openedSession.status})`);
  process.exit(2);
}
async function console_(method, path, body) {
  const res = await fetchOnce(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      cookie: `skln_console=${cookie}`,
      "x-skillonomia-console-csrf": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const files = readdirSync(SOURCES)
  .filter((n) => n.endsWith(".md"))
  .filter((n) => ONLY.length === 0 || ONLY.includes(n.slice(0, 2)))
  .sort();

const results = [];
for (const name of files) {
  const text = readFileSync(join(SOURCES, name), "utf8");
  const key = createHash("sha256").update(text).digest("hex").slice(0, 32);

  const captured = await api("POST", "/v1/captures", { kind: "workflow", text, idempotency_key: `dogfood-cap-${key}` });
  ok(captured.status === 201, `${name}: captured through the product path`, `${captured.status} ${captured.text.slice(0, 200)}`);
  if (captured.status !== 201) continue;

  const c = captured.json;
  ok(c.classification.skillable === true, `${name}: the classifier called it skillable`, c.classification.reason_code);
  ok(
    c.classification.category === "reusable_procedure",
    `${name}: and classified it a reusable procedure`,
    c.classification.category,
  );
  ok(c.outcome === "drafted", `${name}: a draft came out of it`, c.outcome);

  const draftId = c.draft.draft_id;
  const revisionId = c.draft.revision_id;

  // The owner READS the previews before approving. Not asserted green — a
  // preview is a finding list and the point is that it was produced and read.
  const detail = await console_("GET", `/v1/console/drafts/${draftId}`);
  ok(detail.status === 200, `${name}: the owner read the draft detail`, detail.text.slice(0, 200));
  const sem = detail.json?.draft?.revision?.semantic_review ?? null;
  const sec = detail.json?.draft?.revision?.security_review ?? null;
  ok(sem !== null, `${name}: with its semantic preview`);
  ok(sec !== null, `${name}: and its security preview`);

  const approved = await console_("POST", `/v1/console/drafts/${draftId}/approve`, {
    revision_id: revisionId,
    idempotency_key: `dogfood-app-${key}`,
  });
  ok(approved.status === 201, `${name}: the owner approved the exact revision`, `${approved.status} ${approved.text.slice(0, 300)}`);

  results.push({
    source: name,
    source_digest: c.source_digest,
    capture_id: c.capture_id,
    draft_id: draftId,
    revision_id: revisionId,
    revision: c.draft.revision,
    content_digest: c.draft.content_digest,
    title: c.draft.content.title,
    classifier_category: c.classification.category,
    classifier_reason_code: c.classification.reason_code,
    semantic_blocking: sem?.blocking_count ?? null,
    semantic_status: sem?.status ?? null,
    security_blocking: sec?.blocking_count ?? null,
    security_permissions: Array.isArray(sec?.requested_permissions) ? sec.requested_permissions.length : null,
    approved: approved.status === 201,
  });
}

console.log("");
console.log(JSON.stringify({ approved: results }, null, 2));
process.exit(failures === 0 ? 0 : 1);
