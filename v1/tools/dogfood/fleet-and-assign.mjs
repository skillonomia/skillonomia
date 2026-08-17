// P6 DOGFOOD, STEP TWO — the closed fleet, and what each agent is given.
//
//   node v1/tools/dogfood/fleet-and-assign.mjs --base-url URL --owner-token T
//        --state FILE --plan FILE
//
// The plan names each agent of the closed fleet and, per agent, which of the
// approved sources it is assigned. Everything here goes through P3's console
// surfaces: `POST /v1/console/assignments` and then `activate`. No row is
// written and no lifecycle state is set by this file.
//
// IT ALSO PROVISIONS THE ADAPTER'S EVIDENCE PRINCIPAL, for the reason `INV-02`
// gives: the principal that REPORTS what a runtime did is not the principal that
// COMMANDS what it should do. The registration is a file in the deployment's
// data directory that no owner-reachable surface writes, which is the same
// boundary P4's gate crosses, crossed once here for the whole dogfood.
//
// The state file it writes carries agent ids, assignment ids and the adapter's
// key. It is written 0600 and lives OUTSIDE the evidence package: it holds a
// credential, and a credential in an evidence package is the defect the secret
// scan exists to find.
//
// It is idempotent: assignment and activation both carry an idempotency key
// derived from the agent and the revision, so a second run re-reads.
//
// EXIT: 0 every planned assignment is active; 1 one is not.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const BASE = (opt("base-url") ?? "").replace(/\/$/, "");
const TOKEN = opt("owner-token") ?? "";
const STATE = opt("state") ?? "";
const PLAN = opt("plan") ?? "";
const APPROVED = opt("approved") ?? "";
const DATA = opt("data") ?? "";
if (!BASE || !TOKEN || !STATE || !PLAN || !APPROVED || !DATA) {
  console.error("usage: fleet-and-assign.mjs --base-url URL --owner-token T --state FILE --plan FILE --approved FILE --data DIR");
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

const ticket = await api("POST", "/v1/console/tickets", {});
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

const plan = JSON.parse(readFileSync(PLAN, "utf8"));
const approvedOut = readFileSync(APPROVED, "utf8");
const approved = JSON.parse(approvedOut.slice(approvedOut.indexOf("\n\n{") + 2)).approved;
const bySource = new Map(approved.map((a) => [a.source.slice(0, 2), a]));

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { agents: {}, adapter: null, assignments: [] };

// -------------------------------------------------------- the adapter principal
if (state.adapter === null) {
  const p = await api("POST", "/v1/principals", { name: `dogfood-adapter`, type: "service", role: "member" });
  ok(p.status === 201, "the adapter principal was provisioned", p.text.slice(0, 200));
  if (p.status !== 201) process.exit(1);
  const id = p.json.principal?.agent_id ?? p.json.agent_id ?? p.json.principal_id ?? p.json.id;
  state.adapter = { agent_id: id, api_key: p.json.api_key ?? p.json.principal?.api_key };
  const file = join(DATA, "evidence-principals.json");
  const reg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  reg[id] = "adapter";
  writeFileSync(file, JSON.stringify(reg, null, 2), { mode: 0o600 });
  console.log(`registered ${id} as an evidence principal of kind \`adapter\``);
}
ok(typeof state.adapter.api_key === "string" && state.adapter.api_key.length > 0, "the adapter holds its own key");

// The refusal that gives the registration its meaning, re-asserted on THIS
// deployment rather than assumed from P4's.
const anyAgentPlan = plan.agents[0];

// ------------------------------------------------------------------ the fleet
for (const a of plan.agents) {
  if (state.agents[a.name] === undefined) {
    const p = await api("POST", "/v1/principals", { name: a.name, type: "agent", role: "member" });
    ok(p.status === 201, `the fleet agent \`${a.name}\` was provisioned`, p.text.slice(0, 200));
    if (p.status !== 201) continue;
    const id = p.json.principal?.agent_id ?? p.json.agent_id ?? p.json.principal_id ?? p.json.id;
    state.agents[a.name] = { agent_id: id };
  }
  ok(state.agents[a.name].agent_id.length === 26, `\`${a.name}\` has a canonical agent id`, state.agents[a.name].agent_id);
}

const ownerOpen = await api("POST", "/v1/sessions", {
  agent_id: state.agents[anyAgentPlan.name].agent_id,
  runtime_kind: "codex",
  runtime_version: "probe",
});
ok(ownerOpen.status === 403, "the OWNER's key cannot open a session on this deployment (INV-02, P4-FR-13)", `got ${ownerOpen.status}`);

// ------------------------------------------------------------ the assignments
for (const a of plan.agents) {
  const agentId = state.agents[a.name].agent_id;
  for (const num of a.skills) {
    const src = bySource.get(num);
    if (src === undefined) {
      ok(false, `${a.name}: source ${num} is approved`);
      continue;
    }
    const already = state.assignments.find((x) => x.agent === a.name && x.source === num);
    if (already !== undefined) {
      ok(true, `${a.name} ← ${num} already assigned (${already.assignment_id})`);
      continue;
    }
    const assigned = await console_("POST", "/v1/console/assignments", {
      agent_id: agentId,
      revision_id: src.revision_id,
      idempotency_key: `dogfood-asg-${agentId}-${src.revision_id}`,
    });
    ok(assigned.status === 201, `${a.name} ← ${num} assigned`, `${assigned.status} ${assigned.text.slice(0, 200)}`);
    if (assigned.status !== 201) continue;
    const assignmentId = assigned.json.assignment.assignment_id;
    const activated = await console_("POST", `/v1/console/assignments/${assignmentId}/activate`, {
      idempotency_key: `dogfood-act-${assignmentId}`,
    });
    ok(activated.status === 200, `${a.name} ← ${num} activated`, `${activated.status} ${activated.text.slice(0, 200)}`);
    ok(activated.json?.effective_from === "next_session", `${a.name} ← ${num} takes effect in the NEXT session (INV-07)`);
    state.assignments.push({
      agent: a.name,
      agent_id: agentId,
      source: num,
      revision_id: src.revision_id,
      content_digest: src.content_digest,
      assignment_id: assignmentId,
    });
  }
}

writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
console.log("");
console.log(`state written to ${STATE} (0600; it carries the adapter key and is outside the evidence package)`);
console.log(
  JSON.stringify(
    { agents: Object.fromEntries(Object.entries(state.agents)), assignments: state.assignments.length },
    null,
    2,
  ),
);
process.exit(failures === 0 ? 0 : 1);
