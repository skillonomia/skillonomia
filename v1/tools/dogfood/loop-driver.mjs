// P6 DOGFOOD, STEP FOUR — the improvement cycle and the rollback cycle, driven
// through the owner's own surfaces.
//
//   node v1/tools/dogfood/loop-driver.mjs --step STEP --base-url URL --owner-token T [...]
//
// `P6-FR-06` and `P6-FR-07` are the two requirements a dogfood ledger cannot
// accumulate on its own: an improvement has to be OBSERVED and acted on, and a
// rollback has to be DECIDED. Every other number in this phase is a by-product
// of real sessions doing real work; these two are owner acts, and this file is
// the owner making them through the product path rather than a script writing
// rows.
//
// IT WRITES NO ROW AND DECIDES NO VERDICT. Each step is one console call. The
// verdict of a comparison is computed by the registry from the rows it already
// holds (`P5-FR-12`), the lineage is written by the registry when the revision
// is created, and the rollback confirmation is refused by the registry unless
// the session confirming it really carries the rolled-back revision and really
// opened after the decision (`P5-FR-13`). What this file contributes is the
// owner's judgement about WHICH outcome was a failure and WHAT the new revision
// should say — which is exactly the part a script must not invent.
//
// THE STEPS, in the order the cycle runs them:
//   observe-failure   the owner records what a real run failed to do, naming
//                     where it read it (`confirmation_source`)
//   revise            a descendant revision from that outcome, with the goal
//                     stated IN ADVANCE of the run that will be judged by it
//   approve           the owner approves the exact new revision
//   select            the assignment moves to it — effective next session
//   compare           two outcomes offered, the registry deciding the verdict
//   rollback-select   the earlier approved revision selected again
//   rollback-confirm  the new session that carries it says so
//
// EXIT: 0 the step did what it says; 1 the registry refused it; 2 the harness
//       could not reach its subject.
import { readFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const STEP = opt("step") ?? "";
const BASE = (opt("base-url") ?? "").replace(/\/$/, "");
const TOKEN = (opt("owner-token") ?? "").trim();
const RECORD = opt("record") ?? "";
if (!BASE || !TOKEN || !STEP) {
  console.error("usage: loop-driver.mjs --step STEP --base-url URL --owner-token T [--record FILE] ...");
  process.exit(2);
}

async function api(method, path, body, key = TOKEN) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
// with the owner key and exchanged for a cookie. Every owner act below goes
// through it, because that is the surface the owner has.
const ticket = await api("POST", "/v1/console/tickets", {});
if (ticket.status !== 201) {
  console.error(`REFUSED: no console ticket (${ticket.status})`);
  process.exit(2);
}
const opened = await fetch(`${BASE}/v1/console/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ ticket: ticket.json.ticket }),
});
const openedBody = await opened.json();
const cookie = /skln_console=([^;]+)/.exec(opened.headers.get("set-cookie") ?? "")?.[1] ?? "";
if (opened.status !== 201 || !cookie) {
  console.error(`REFUSED: no console session (${opened.status})`);
  process.exit(2);
}
async function console_(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      cookie: `skln_console=${cookie}`,
      "x-skillonomia-console-csrf": openedBody.csrf_token,
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

const emit = (result) => {
  const line = JSON.stringify({ step: STEP, ...result });
  console.log(line);
  if (RECORD) appendFileSync(RECORD, `${line}\n`);
};
const done = (res, result) => {
  if (res.status >= 400) {
    console.error(`REFUSED by the registry (${res.status}): ${res.text.slice(0, 400)}`);
    emit({ ok: false, status: res.status, error: res.text.slice(0, 400) });
    process.exit(1);
  }
  emit({ ok: true, status: res.status, ...result });
  process.exit(0);
};

switch (STEP) {
  // -------------------------------------------------- the owner sees a failure
  case "observe-failure": {
    const res = await console_("POST", "/v1/console/outcomes", {
      session_id: opt("session"),
      entry_id: opt("entry"),
      outcome: "failed",
      outcome_ref: opt("ref"),
      confirmation_source: opt("source"),
      reason_code: opt("reason-code"),
      reason: readFileSync(opt("reason-file"), "utf8").trim(),
      idempotency_key: `dogfood-owner-${opt("ref")}`,
    });
    done(res, { outcome_id: res.json?.outcome_id, outcome: res.json?.outcome, evidence_class: res.json?.evidence_class });
    break;
  }

  // ------------------------------- the descendant revision, and its stated goal
  case "revise": {
    const res = await console_("POST", `/v1/console/outcomes/${opt("outcome")}/revision`, {
      origin: "failure",
      goal_kind: "failure_to_worked",
      observation: readFileSync(opt("observation-file"), "utf8").trim(),
      improvement_goal: readFileSync(opt("goal-file"), "utf8").trim(),
      revision: JSON.parse(readFileSync(opt("sections-file"), "utf8")),
      idempotency_key: `dogfood-rev-${opt("outcome")}`,
    });
    done(res, {
      revision_source_id: res.json?.revision_source_id,
      parent_revision_id: res.json?.parent_revision_id,
      new_revision_id: res.json?.revision?.revision_id,
      new_revision: res.json?.revision?.revision,
      content_digest: res.json?.revision?.content_digest,
      goal: res.json?.improvement_goal,
    });
    break;
  }

  // The owner READS the new revision and its two previews before approving it.
  // Not asserted green: a preview is a finding list, and what matters is that
  // the revision faced the same review an ordinary edit faces (`P5-FR-09`).
  case "read-draft": {
    const res = await console_("GET", `/v1/console/drafts/${opt("draft")}`);
    const rev = res.json?.draft?.revision;
    done(res, {
      head_revision_id: rev?.revision_id,
      revision: rev?.revision,
      semantic_status: rev?.semantic_review?.status ?? null,
      semantic_blocking: rev?.semantic_review?.blocking_count ?? null,
      security_blocking: rev?.security_review?.blocking_count ?? null,
      security_permissions: rev?.security_review?.requested_permissions?.length ?? null,
    });
    break;
  }

  case "approve": {
    const res = await console_("POST", `/v1/console/drafts/${opt("draft")}/approve`, {
      revision_id: opt("revision"),
      idempotency_key: `dogfood-app-${opt("revision")}`,
    });
    done(res, { approved_revision_id: opt("revision") });
    break;
  }

  case "select": {
    const res = await console_("POST", `/v1/console/assignments/${opt("assignment")}/revision`, {
      revision_id: opt("revision"),
      idempotency_key: `dogfood-sel-${opt("assignment")}-${opt("revision")}`,
    });
    done(res, {
      desired_revision_id: res.json?.assignment?.desired_revision_id ?? res.json?.desired_revision_id,
      effective_from: res.json?.effective_from,
    });
    break;
  }

  case "compare": {
    const res = await console_("POST", "/v1/console/comparisons", {
      baseline_outcome_id: opt("baseline"),
      candidate_outcome_id: opt("candidate"),
      idempotency_key: `dogfood-cmp-${opt("baseline")}-${opt("candidate")}`,
    });
    done(res, {
      comparison_id: res.json?.comparison_id,
      verdict: res.json?.verdict,
      verdict_reason_code: res.json?.verdict_reason_code,
      comparable: res.json?.comparable,
      baseline: res.json?.baseline,
      candidate: res.json?.candidate,
      goal: res.json?.improvement_goal,
    });
    break;
  }

  // -------------------------------------------------------------- the rollback
  case "rollback-event": {
    const res = await console_("GET", `/v1/console/assignments/${opt("assignment")}/audit`);
    if (res.status !== 200) done(res, {});
    const event = [...res.json.items]
      .reverse()
      .find((i) => i.event === "revision_selected" && i.desired_revision_id === opt("revision"));
    if (!event) {
      console.error("no `revision_selected` event selecting that revision");
      process.exit(1);
    }
    done(res, { rollback_action_event_id: event.entry_id, desired_revision_id: event.desired_revision_id });
    break;
  }

  case "rollback-confirm": {
    // Filed by the ADAPTER's evidence principal, on the machine surface: a
    // rollback confirmation is observed state and the owner's credential is
    // refused there (`P4-FR-13`).
    const state = JSON.parse(readFileSync(opt("state"), "utf8"));
    const res = await api(
      "POST",
      `/v1/sessions/${opt("session")}/rollback-confirmations`,
      {
        entry_id: opt("entry"),
        rollback_action_event_id: opt("event"),
        reason: readFileSync(opt("reason-file"), "utf8").trim(),
        idempotency_key: `dogfood-rbc-${opt("session")}-${opt("event")}`,
      },
      state.adapter.api_key,
    );
    done(res, {
      outcome_id: res.json?.outcome_id,
      outcome: res.json?.outcome,
      evidence_class: res.json?.evidence_class,
    });
    break;
  }

  default:
    console.error(`no such step \`${STEP}\``);
    process.exit(2);
}
