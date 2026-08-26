// THE DEPLOYMENT THE DECISION GATES DECIDE IN.
//
// Every gate for the Approval Inbox, the revocation flow and the webhook flow
// needs the same three things on the page: a HIGH-risk adoption waiting on a
// human, a publication waiting on a human, and a PUBLISHED version somebody
// already holds. This module builds all three the way they are actually built —
// `skillonomia init` and `skillonomia create` author the packages, a reviewer
// who is not the author records the verdict, an adopter runs the trial and
// reports its evidence, and the owner verifies and publishes over REST.
//
// NOTHING HERE IS WRITTEN INTO SQLITE. A seeded row would prove the renderer
// draws a row; the P2 gate manifest asks for the journey, and this is it.
import { newContext, signIn } from "./harness.mjs";
import {
  api,
  authorSkill,
  consoleReader,
  mintTicket,
  principal,
  releaseVersion,
  sourceManifest,
  startRefusingEndpoint,
  startServer,
} from "./fixture.mjs";

/** The one loopback endpoint every webhook gate points at: a server this run
 *  started, on `127.0.0.1`, closed in the caller's `finally`. */
export { startRefusingEndpoint };

/**
 * A deployment with the three decisions on it, a browser, and a real login.
 *
 * `opts.role` picks whose session the browser holds. `reviewer` is the one that
 * matters beyond the happy path: SPEC.md section 6.4 puts a reviewer outside the
 * human-approval and revocation routes, and the gate for that has to be a
 * reviewer actually signing in, not a claim about a table.
 */
export async function withDecisions(body, opts = {}) {
  const refusing = opts.webhook === false ? null : await startRefusingEndpoint();
  const fx = await startServer({ allowLoopback: true });
  let ctx = null;
  let browser = null;
  try {
    const creds = fx.inst.credentials;
    const exchanged = await api(fx.base, "POST", "/v1/auth/bootstrap", undefined, {
      bootstrap_token: creds.bootstrap_owner_token,
    });
    const ownerKey = exchanged.body?.api_key;
    if (typeof ownerKey !== "string") throw new Error(`no owner key: ${JSON.stringify(exchanged.body)}`);
    const ownerAgentId = exchanged.body.agent_id;
    const adopterKey = creds.demo_adopter_token;

    // A REVIEWER WHO IS NOT THE AUTHOR. The self-review prohibition is real, so
    // the verdicts below need a second principal, and the reviewer-session gates
    // need one that holds exactly the reviewer role.
    const reviewer = await principal(fx, ownerKey, { name: "pc-reviewer", role: "reviewer" });

    // The version the revocation flow revokes: low risk, so no human gate stands
    // between `verified` and `published`, and published is the state SPEC.md
    // section 5.1b admits a revocation from.
    const low = await authorSkill(fx, { slug: "packet-c-published", risk: "low", apiKey: ownerKey });
    const lowRelease = await releaseVersion(fx, {
      ownerKey,
      reviewerKey: reviewer.api_key,
      adopterKey,
      versionId: low.skill_version_id,
      manifest: sourceManifest(low.dir),
      tag: "low",
    });

    // A second low-risk version of the SAME skill, left at `verified`, so the
    // revocation form has a real replacement to select. `verified` is one of the
    // two states SPEC.md section 5.1b admits as a successor.
    const successor = await authorSkill(fx, {
      slug: "packet-c-published",
      risk: "low",
      apiKey: ownerKey,
      edit: (m) => {
        m.skill_id = low.skill_id;
        m.semantic_version = "0.2.0";
      },
    });
    await releaseVersion(fx, {
      ownerKey,
      reviewerKey: reviewer.api_key,
      adopterKey,
      versionId: successor.skill_version_id,
      manifest: sourceManifest(successor.dir),
      stopAfter: "verified",
      tag: "successor",
    });

    // The high-risk skill: its adoption request stops at `approval_pending`, so
    // the Inbox holds an `adopt_high_risk` item, and its publication is gated on
    // a human, so the Inbox holds a `publish` item too.
    const high = await authorSkill(fx, { slug: "packet-c-high", risk: "high", apiKey: ownerKey });
    const highRelease = await releaseVersion(fx, {
      ownerKey,
      reviewerKey: reviewer.api_key,
      adopterKey,
      versionId: high.skill_version_id,
      manifest: sourceManifest(high.dir),
      stopAfter: "adoption_requested",
      tag: "high",
    });

    let webhookId = null;
    if (refusing) {
      const hook = await api(fx.base, "POST", "/v1/webhooks", ownerKey, { url: refusing.url });
      webhookId = hook.body?.webhook_id ?? null;
      if (webhookId === null) throw new Error(`the webhook did not register: ${JSON.stringify(hook.body)}`);
    }

    const sessionKey = opts.role === "reviewer" ? reviewer.api_key : ownerKey;
    const reader = await consoleReader(fx.base, sessionKey);
    const { chromiumContext, foreign, logs } = await openContext(fx.base, opts);
    ctx = chromiumContext;
    const page = await signIn(ctx, fx.base, await mintTicket(fx.base, sessionKey));

    await body({
      fx,
      page,
      reader,
      foreign,
      logs,
      refusing,
      ownerKey,
      ownerAgentId,
      adopterKey,
      reviewer,
      sessionKey,
      webhookId,
      low: { ...low, release: lowRelease },
      successor,
      high: { ...high, release: highRelease },
    });
  } finally {
    if (ctx !== null) await ctx.close();
    if (browser !== null) await browser.close();
    fx.close();
    if (refusing) refusing.close();
  }
}

/** `newContext` renamed on the way out, so the caller's `finally` closes the
 *  thing it opened rather than a member of a bag. */
async function openContext(base, opts) {
  const { context, foreign, logs } = await newContext(base, opts);
  return { chromiumContext: context, foreign, logs };
}

/** Wait for one of the three regions to settle out of `loading`. A gate that
 *  read the DOM mid-flight would be asserting about a spinner. */
export async function settledRegion(page, id, timeout = 20000) {
  await page.waitForFunction(
    (region) => {
      const box = document.getElementById(region);
      return box !== null && box.dataset.state !== undefined && box.dataset.state !== "loading";
    },
    id,
    { timeout },
  );
  return page.$eval(`#${id}`, (b) => b.dataset.state);
}

/** Every row of the Approval Inbox, as the page holds it. */
export async function readApprovalRows(page) {
  return page.$$eval("#approval-rows tr", (rows) =>
    rows.map((r) => ({
      item_id: r.dataset.itemId,
      kind: r.dataset.kind,
      status: r.dataset.status,
      allowed: r.dataset.allowed,
      reason_code: r.dataset.reasonCode,
    })),
  );
}

/** Open one inbox item by its kind, through the row's own control. */
export async function openItemOfKind(page, kind) {
  await page.click(`#approval-rows tr[data-kind="${kind}"] button[data-action="open-approval"]`);
  await page.waitForSelector("#approval-detail[data-state]", { state: "attached", timeout: 20000 });
  return page.$eval("#approval-detail", (b) => ({ ...b.dataset }));
}

/** The text of every control this surface is currently offering. The absence
 *  check for the forbidden labels reads THIS, so it is reading the controls a
 *  person can press and not the whole document. */
export async function primaryControlLabels(page, selector) {
  return page.$$eval(selector, (nodes) => nodes.map((n) => (n.textContent ?? "").trim()));
}

/** Every backend row this registry would show for one version's approvals,
 *  read over the console session the TEST holds — a second opinion about the
 *  registry is exactly what `INV-01` forbids, so the assertion compares the DOM
 *  against the server rather than against a sentence in a test. */
export async function backendInbox(reader, query = "?status=all&kind=all") {
  const r = await reader.raw(`/v1/console/approvals${query}`);
  if (r.status !== 200) throw new Error(`the inbox read failed: ${r.status} ${r.text}`);
  return r.body.items;
}

/** One item of that read, by id. */
export function itemById(items, itemId) {
  return items.find((i) => i.item_id === itemId) ?? null;
}

/** The transparency log, oldest first. A decision that did not reach the log is
 *  a decision this registry cannot prove it made, which is why every mutation
 *  gate below asserts a tlog entry as well as a row. */
export async function tlogEntries(fx, key) {
  // PAGED, because the read route bounds `limit` at 100 and this log grows past
  // that within one journey. A single capped read would have returned the same
  // first hundred entries before and after a mutation, and the difference — the
  // very thing every mutation gate asserts — would have been empty every time.
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const query = cursor === null ? "?limit=100" : `?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const r = await api(fx.base, "GET", `/v1/tlog${query}`, key);
    if (r.status !== 200) throw new Error(`the transparency log read failed: ${r.status} ${JSON.stringify(r.body)}`);
    const items = r.body?.items ?? r.body?.entries ?? [];
    out.push(...items);
    cursor = r.body?.next_cursor ?? null;
    if (cursor === null || items.length === 0) break;
  }
  return out;
}
