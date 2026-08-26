// THE DECISION SURFACES, CHECKED AT THE SOURCE.
//
// The browser gates in `test-browser/` prove that an owner can decide in a
// browser and that the registry records it. This file proves the properties a
// browser run cannot: that the words on those surfaces are constants of THIS
// build and not sentences a test typed, that the two places declaring the four
// human-decision labels agree byte for byte, that the pre-commit read applies
// the same rules the mutation does, and — the one the P2 gate manifest is
// explicit about — that the four forbidden labels are ABSENT.
//
// WHY THE ABSENCE CHECK LIVES HERE AS WELL AS IN THE BROWSER. A browser gate
// sees the controls one journey rendered. This one sees every label the bundle
// can ever produce, because it reads the tables they come from. The two answer
// different questions and the gate asks for both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVALS_TEXT,
  FORBIDDEN_PRIMARY_LABELS,
  HUMAN_DECISION_LABELS,
  HUMAN_DECISION_LABEL_LIST,
  INVALID_CODE,
  FORBIDDEN_CODE,
  REPLAY_HEADER,
  REPLAY_HEADER_TRUE,
  REVIEW_ACTION_LABELS,
  REVOCATION_CONSEQUENCES,
  REVOCATION_TEXT,
  REVOKE_PRIMARY_LABELS,
  STALE_CODES,
  WEBHOOK_TEXT,
  revokePrimaryKey,
} from "../src/console-surfaces.ts";
import {
  FORBIDDEN_DECISION_LABELS,
  HUMAN_DECISION_LABELS as CONTRACT_LABELS,
  validateConsoleRevoke,
  validateConsoleWebhook,
} from "../src/console-v2.ts";
import { REVOCATION_REASON_MAX, SUCCESSOR_ELIGIBLE_STATES } from "../src/lifecycle-v11.ts";
import { REVOCABLE_STATES } from "../src/transitions.ts";
import { REVOCATION_REASON_CODES } from "../src/console-revocation.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const APP = read("console/app.ts");
const PAGE = read("src/console-page.ts");
const SURFACES = read("src/console-surfaces.ts");

// ===========================================================================
// G-P2-9 — the four exact labels, and the ABSENCE of the four forbidden ones
// ===========================================================================

test("[P2C.1] the four human-decision labels are declared twice and agree byte for byte", () => {
  // Two files declare them and neither imports the other: `src/console-v2.ts`
  // is the wire contract and pulls in `src/dashboard.ts`, which reaches `node:`
  // modules and cannot be bundled into a browser; `src/console-surfaces.ts` has
  // no imports at all because it IS bundled. So the agreement is kept by this
  // test rather than by an import that cannot cross the boundary — the same
  // arrangement `test/v1p2-p2b-proofline.test.ts` keeps for the cell separator.
  assert.deepEqual(
    [...HUMAN_DECISION_LABEL_LIST].sort(),
    Object.values(CONTRACT_LABELS).sort(),
    "the browser's labels and the contract's labels are not the same four strings",
  );
  assert.equal(HUMAN_DECISION_LABELS.adopt_high_risk.approved, CONTRACT_LABELS.approve_adoption);
  assert.equal(HUMAN_DECISION_LABELS.adopt_high_risk.denied, CONTRACT_LABELS.deny_adoption);
  assert.equal(HUMAN_DECISION_LABELS.publish.approved, CONTRACT_LABELS.approve_publication);
  assert.equal(HUMAN_DECISION_LABELS.publish.denied, CONTRACT_LABELS.deny_publication);

  // The exact bytes, restated once here so a coordinated edit of both files
  // still has to face the specification's own words.
  assert.deepEqual([...HUMAN_DECISION_LABEL_LIST].sort(), [
    "Approve publication",
    "Approve this adoption",
    "Deny publication",
    "Deny this adoption",
  ]);
});

test("[P2C.2] the labels are KEYED BY THE SERVER'S FIELDS, so no branch in the bundle picks one", () => {
  // The table is indexed by `kind` and then by `decision`, both of which are
  // values the server sent. A chain of comparisons in the renderer would be the
  // browser deciding which act it is about, which is what `INV-02` forbids.
  assert.deepEqual(Object.keys(HUMAN_DECISION_LABELS).sort(), ["adopt_high_risk", "publish"]);
  for (const kind of Object.keys(HUMAN_DECISION_LABELS)) {
    assert.deepEqual(Object.keys(HUMAN_DECISION_LABELS[kind]).sort(), ["approved", "denied"]);
  }
  // `review` is deliberately absent: a review verdict is a different type and
  // SPEC.md section 6.4 fixes these four words for the human half only.
  assert.equal(HUMAN_DECISION_LABELS.review, undefined);
  assert.ok(APP.includes("HUMAN_DECISION_LABELS[item.kind]"), "the bundle does not index the table by the server's kind");
  assert.ok(!APP.includes('=== "adopt_high_risk"'), "the bundle compares a kind instead of looking one up");
  assert.ok(!APP.includes('=== "publish"'), "the bundle compares a kind instead of looking one up");
});

test("[P2C.3] no label this build can render is `Confirm`, `OK`, `Yes` or `Submit`", () => {
  assert.deepEqual([...FORBIDDEN_PRIMARY_LABELS].sort(), [...FORBIDDEN_DECISION_LABELS].sort());
  assert.deepEqual([...FORBIDDEN_PRIMARY_LABELS].sort(), ["Confirm", "OK", "Submit", "Yes"]);

  // EVERY LABEL THE BUNDLE CAN PRODUCE, from the tables it produces them out of.
  const everyLabel = [
    ...HUMAN_DECISION_LABEL_LIST,
    ...Object.values(REVIEW_ACTION_LABELS),
    ...Object.values(REVOKE_PRIMARY_LABELS),
    APPROVALS_TEXT.clear_filter,
    APPROVALS_TEXT.empty_action,
    APPROVALS_TEXT.retry,
    APPROVALS_TEXT.stale_refresh,
    REVOCATION_TEXT.load,
    REVOCATION_TEXT.retry,
    REVOCATION_TEXT.stale_refresh,
    REVOCATION_TEXT.dead_letter_link,
    WEBHOOK_TEXT.register,
    WEBHOOK_TEXT.send_test,
    WEBHOOK_TEXT.retry,
    WEBHOOK_TEXT.stale_refresh,
  ];
  assert.ok(everyLabel.length >= 18, `only ${everyLabel.length} labels were checked`);
  for (const label of everyLabel) {
    assert.ok(
      !FORBIDDEN_PRIMARY_LABELS.includes(label),
      `a control of this build reads exactly \`${label}\``,
    );
    // A CONSEQUENTIAL ACTION NAMES ITS OBJECT. Every one of them is longer than
    // any of the forbidden four, because every one of them says what it acts on.
    assert.ok(label.length > "Confirm".length, `the label \`${label}\` names no object, scope or consequence`);
  }

  // …and neither the page shell nor the bundle carries one as a button's text.
  for (const forbidden of FORBIDDEN_PRIMARY_LABELS) {
    assert.ok(
      !PAGE.includes(`>${forbidden}</button>`),
      `the console shell renders a button whose entire text is \`${forbidden}\``,
    );
    assert.ok(
      !APP.includes(`el("button", "${forbidden}")`),
      `the bundle creates a button whose entire text is \`${forbidden}\``,
    );
  }
});

// ===========================================================================
// The words on the page are constants of this build
// ===========================================================================

test("[P2C.4] every sentence these three surfaces add is a source constant, not a literal at a call site", () => {
  // The rule `PROOFLINE_TEXT` keeps for the read surface, applied to the three
  // surfaces where an owner decides. A sentence on a decision surface is read as
  // a statement of fact; one that is not a constant of this build is a sentence
  // nobody compared against anything.
  const tables = { APPROVALS_TEXT, REVOCATION_TEXT, WEBHOOK_TEXT };
  let declared = 0;
  for (const [name, table] of Object.entries(tables)) {
    for (const [key, value] of Object.entries(table)) {
      declared += 1;
      assert.equal(typeof value, "string", `${name}.${key} is not a string`);
      assert.ok(value.length > 0, `${name}.${key} is empty`);
      assert.ok(
        APP.includes(`${name}.${key}`) || PAGE.includes(`${name}.${key}`),
        `${name}.${key} is declared and never used — a constant nothing renders proves nothing`,
      );
    }
  }
  assert.ok(declared >= 60, `only ${declared} sentences are declared, which is too few to be these three surfaces'`);

  // …and the renderer does not put a bare sentence on the page beside them. Any
  // string literal long enough to be prose must be one of the constants.
  // SCOPED TO THE THREE SURFACES THIS PACKET ADDS. The v1.0 regions above them
  // predate this rule and are not what it is about; widening it to the whole
  // file would be rewriting another phase's decisions under cover of this one.
  const from = APP.indexOf("// V1.1 P2 — THE THREE DECISION SURFACES");
  assert.ok(from > 0, "the decision surfaces are not where this test looks for them");
  const prose = [...APP.slice(from).matchAll(/el\("(?:p|h2|h3|li)", "([^"]{25,})"/g)].map((m) => m[1]);
  assert.deepEqual(prose, [], `the bundle writes prose that is not a declared constant: ${JSON.stringify(prose)}`);
});

test("[P2C.5] the four revocation consequences are four separate statements", () => {
  assert.equal(REVOCATION_CONSEQUENCES.length, 4);
  assert.deepEqual(
    REVOCATION_CONSEQUENCES.map((c) => c.code),
    ["new_adoptions_blocked", "issued_bytes_not_deleted", "signature_still_valid", "delivery_may_dead_letter"],
  );
  // Each says the thing SPEC.md section 6.4 requires the console to say, and the
  // two that are about what revocation does NOT do say so in the negative —
  // which is the whole point: a registry cannot recall bytes and cannot
  // invalidate a signature, and an owner who believes otherwise has been misled.
  const byCode = Object.fromEntries(REVOCATION_CONSEQUENCES.map((c) => [c.code, c.text]));
  assert.match(byCode.new_adoptions_blocked, /blocked/);
  assert.match(byCode.issued_bytes_not_deleted, /not deleted/);
  assert.match(byCode.signature_still_valid, /remains mathematically valid/);
  assert.match(byCode.delivery_may_dead_letter, /dead letter/);
  for (const c of REVOCATION_CONSEQUENCES) {
    assert.ok(APP.includes("REVOCATION_CONSEQUENCES"), "the bundle does not render the declared consequences");
    assert.ok(c.text.length > 40, `the \`${c.code}\` statement is too short to be a statement`);
  }
});

test("[P2C.6] the two revocation primary labels are exactly the two SPEC.md section 6.4 fixes", () => {
  assert.equal(REVOKE_PRIMARY_LABELS.without_successor, "Revoke version");
  assert.equal(REVOKE_PRIMARY_LABELS.with_successor, "Revoke and replace version");
  assert.equal(revokePrimaryKey(false), "without_successor");
  assert.equal(revokePrimaryKey(true), "with_successor");
  // The label follows the form's own state, so a person who picked a
  // replacement is never offered a button that does not mention one.
  assert.ok(APP.includes("REVOKE_PRIMARY_LABELS[key]"));
});

// ===========================================================================
// INV-07 — the console never calls a queued notification delivered
// ===========================================================================

test("[P2C.7] the committed revocation panel reports three counts under three names", () => {
  assert.notEqual(REVOCATION_TEXT.count_queued_label, REVOCATION_TEXT.count_delivered_label);
  assert.notEqual(REVOCATION_TEXT.count_delivered_label, REVOCATION_TEXT.count_failed_label);
  // The bundle stamps each count with its own token, so a gate reads three
  // separate nodes rather than parsing one sentence.
  for (const token of ['data-count="queued"', 'data-count="delivered"', 'data-count="dead_lettered"']) {
    const attr = token.replace('data-count="', "").replace('"', "");
    assert.ok(APP.includes(`queued.dataset.count = "queued"`) || APP.includes(`= "${attr}"`), `no node carries ${token}`);
  }
  // …and the page says in words what the three names mean, so the distinction
  // survives a reader who does not know the schema.
  assert.match(REVOCATION_TEXT.queued_is_not_delivered, /queued/);
  assert.match(REVOCATION_TEXT.queued_is_not_delivered, /has not been delivered/);
  assert.ok(APP.includes("REVOCATION_TEXT.queued_is_not_delivered"), "the honesty sentence is never rendered");

  // THE COUNTS COME FROM THE SERVER'S RE-READ, not from the mutation's own
  // response: the mutation reports what it QUEUED, and what became of those
  // notices afterwards is the delivery machine's fact.
  assert.ok(
    APP.includes("ctx.notices.queued") && APP.includes("ctx.notices.delivered") && APP.includes("ctx.notices.dead_lettered"),
    "the committed panel does not read the three counts from the server's revocation context",
  );
});

// ===========================================================================
// The pre-commit read and the mutation apply the same rules
// ===========================================================================

test("[P2C.8] the revocation eligibility is computed from the same state sets the lifecycle uses", () => {
  // The read model imports `REVOCABLE_STATES` and `SUCCESSOR_ELIGIBLE_STATES`
  // rather than restating either, so a control this read withholds is a call the
  // service would refuse and a replacement it offers is one SPEC.md section 5.1b
  // admits (INV-01).
  const source = read("src/console-revocation.ts");
  assert.ok(source.includes('from "./transitions.ts"'), "the read model does not use the lifecycle's own state set");
  assert.ok(source.includes('from "./lifecycle-v11.ts"'), "the read model does not use the lifecycle's successor set");
  assert.ok(!/REVOCABLE_STATES\s*=/.test(source), "the read model declares its own copy of the revocable states");
  assert.ok(REVOCABLE_STATES.length > 0);
  assert.deepEqual([...SUCCESSOR_ELIGIBLE_STATES], ["verified", "published"]);

  // The four reason codes are four different facts. `ALREADY_REVOKED` is not
  // `NOT_REVOCABLE_STATE`: the first says the thing you wanted has happened and
  // the second says it cannot happen yet, and collapsing them would make a done
  // job look like a broken one.
  assert.deepEqual(Object.values(REVOCATION_REASON_CODES).sort(), [
    "ALREADY_REVOKED",
    "NOT_PERMITTED_ACTOR",
    "NOT_REVOCABLE_STATE",
    "REVOCABLE",
  ]);
  assert.equal(new Set(Object.values(REVOCATION_REASON_CODES)).size, 4);
});

test("[P2C.9] the pre-commit adopter query is the delivery machine's own", () => {
  // The read must show an owner the adopters the revoke call would actually
  // queue a notice for. `enqueueRevocationNoticesInTx` cannot be imported here —
  // it writes inside a transaction — so the two share a `WHERE`, and this is
  // what says they still do.
  const readModel = read("src/console-revocation.ts");
  const delivery = read("src/delivery.ts");
  const clause = "AND NOT EXISTS (";
  assert.ok(readModel.includes(clause) && delivery.includes(clause));
  for (const fragment of ["adoption_receipts", "receipt_events", "'failed','rolled_back'"]) {
    assert.ok(readModel.includes(fragment), `the read model's adopter query lost \`${fragment}\``);
    assert.ok(delivery.includes(fragment), `the delivery machine's adopter query lost \`${fragment}\``);
  }
});

// ===========================================================================
// The boundary validators
// ===========================================================================

test("[P2C.10] a revocation body is checked at the boundary and admits `null` for no replacement", () => {
  assert.deepEqual(validateConsoleRevoke({ reason: "gone" }), []);
  assert.deepEqual(validateConsoleRevoke({ reason: "gone", successor_version_id: null }), []);
  assert.deepEqual(validateConsoleRevoke({ reason: "gone", successor_version_id: "V2" }), []);

  // A BLANK REASON IS REFUSED, because SPEC.md section 5.1b makes it immutable:
  // a blank reason accepted here is a blank reason nobody can ever correct.
  for (const body of [{}, { reason: "" }, { reason: 7 }, { reason: "x".repeat(REVOCATION_REASON_MAX + 1) }]) {
    const out = validateConsoleRevoke(body);
    assert.equal(out.length >= 1, true, `${JSON.stringify(body)} was accepted`);
    assert.equal(out[0].pointer, "/reason");
    assert.equal(out[0].code, INVALID_CODE);
  }
  assert.equal(validateConsoleRevoke({ reason: "x".repeat(REVOCATION_REASON_MAX) }).length, 0);

  const bad = validateConsoleRevoke({ reason: "gone", successor_version_id: 7 });
  assert.equal(bad[0].pointer, "/successor_version_id");
});

test("[P2C.11] the webhook registration body carries NO second URL policy", () => {
  assert.deepEqual(validateConsoleWebhook({ url: "https://example.test/hook" }), []);
  assert.equal(validateConsoleWebhook({}).length, 1);
  assert.equal(validateConsoleWebhook({ url: "" })[0].pointer, "/url");
  // Everything that makes a destination admissible — the scheme, the SSRF
  // rules, the loopback flag, the reserved-name space — stays in
  // `src/transport.ts`. A second URL policy at this boundary is exactly the
  // parity break SPEC.md section 6.5 exists to prevent, so a URL this validator
  // shrugs at is one the transport still gets to refuse.
  assert.deepEqual(validateConsoleWebhook({ url: "http://127.0.0.1/hook" }), []);
  assert.deepEqual(validateConsoleWebhook({ url: "http://169.254.169.254/" }), []);
  const source = read("src/console-v2.ts");
  for (const smell of ["https://", "127.0.0.1", "loopback", "localhost"]) {
    assert.ok(
      !source.includes(`url.startsWith("${smell}`),
      `the console contract inspects a URL for \`${smell}\` — a second transport policy`,
    );
  }
});

// ===========================================================================
// INV-04 — the console never receives a webhook secret
// ===========================================================================

test("[P2C.12] the console webhook wrapper strips the secret, and strips it BEFORE the replay is persisted", () => {
  const service = read("src/service.ts");
  const wrapper = /registerWebhookForConsole\([\s\S]*?\n  \}/.exec(service);
  assert.ok(wrapper, "the console webhook wrapper is not in the shape this test reads");
  const body = wrapper[0];
  assert.ok(body.includes("withIdempotency("), "the console registration is not idempotent, so it has no replay row");
  // THE ORDER IS THE PROPERTY. `withIdempotency` PERSISTS the response bytes it
  // will replay, so the stripping has to happen INSIDE the callback: wrapping
  // the unstripped value would write the plaintext secret into
  // `idempotency_keys` — a third place a credential lives, and the one place
  // nobody would ever look for it.
  const idem = body.indexOf("withIdempotency(");
  const strip = body.indexOf("webhook_id: created.webhook_id");
  assert.ok(idem >= 0 && strip > idem, "the secret is stripped outside the idempotency callback");
  assert.ok(!body.includes("secret"), "the console wrapper mentions the secret in what it returns");

  // …and the route serves the wrapper, not the machine method.
  const http = read("src/http.ts");
  assert.ok(http.includes("registry.registerWebhookForConsole("), "the console route calls the machine registration");
  const consoleRoute = http.indexOf('path === "/v1/console/webhooks"');
  assert.ok(consoleRoute > 0);
});

test("[P2C.13] the bundle holds no credential and writes to no browser store", () => {
  // USAGE, not the word. The file's own header explains at length that it
  // writes to none of these, and a check that refused the WORD would refuse the
  // explanation of why the thing is refused.
  for (const forbidden of [
    "localStorage.",
    "sessionStorage.",
    "indexedDB.",
    "document.cookie =",
    "whsec_",
    "api_key",
  ]) {
    assert.ok(!APP.includes(forbidden), `the console bundle uses \`${forbidden}\``);
  }
  // The three surfaces this packet adds send exactly one credential-shaped
  // header, and it is the CSRF token the page holds in memory.
  // Both request paths — `api()` and `mutate()` — take it from the same module
  // variable, and there is exactly one such variable.
  const sources = [
    ...[...APP.matchAll(/"X-Skillonomia-Console-CSRF": ([A-Za-z]+)/g)].map((m) => m[1]),
    ...[...APP.matchAll(/headers\["X-Skillonomia-Console-CSRF"\] = ([A-Za-z]+);/g)].map((m) => m[1]),
  ];
  assert.deepEqual(sources, ["csrfToken", "csrfToken"], `unexpected CSRF header sources: ${JSON.stringify(sources)}`);
  assert.equal([...APP.matchAll(/^let csrfToken = "";$/gm)].length, 1, "more than one place holds the CSRF token");
});

// ===========================================================================
// The §7 vocabulary the surfaces sort a refusal into
// ===========================================================================

test("[P2C.14] the stale row is exactly the three typed codes SPEC.md section 6.4 names", () => {
  assert.deepEqual([...STALE_CODES].sort(), ["CONFLICT", "NOT_FOUND", "PRECONDITION_FAILED"]);
  assert.equal(INVALID_CODE, "INVALID_SCHEMA");
  assert.equal(FORBIDDEN_CODE, "FORBIDDEN");
  // `decided while open in another session` is that row and not a class of its
  // own, so there is no fourth bucket in the renderer.
  const states = [...APP.matchAll(/box\.dataset\.state = "(forbidden|invalid|stale|error)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(states)].sort(), ["error", "forbidden", "invalid", "stale"]);
});

test("[P2C.15] a replay is read from the header, because a replayed body is byte-identical to the original", () => {
  assert.equal(REPLAY_HEADER, "Idempotency-Replayed");
  assert.equal(REPLAY_HEADER_TRUE, "true");
  // The server sets it in one place and the bundle reads it in one place.
  assert.ok(read("src/http.ts").includes('"Idempotency-Replayed": "true"'), "the server no longer marks a replay");
  const reads = [...APP.matchAll(/res\.headers\.get\(REPLAY_HEADER\)/g)];
  assert.equal(reads.length, 1, `the bundle reads the replay header ${reads.length} times`);
  // …and it is NOT inferred from the body, which is the thing that cannot work:
  // a replay's body is the original's body, byte for byte.
  assert.ok(!APP.includes('"replayed"'), "the bundle looks for a replay marker in a payload");
});

test("[P2C.16] every recovery action on a decision surface is bounded and belongs to its refusal", () => {
  // One retry, one refresh, and neither is offered where it would be a lie:
  // `FORBIDDEN` retried is `FORBIDDEN` again, and a body the server called
  // malformed is recovered by changing it, not by sending it twice.
  assert.ok(
    APP.includes('if (box.dataset.state === "stale" || box.dataset.state === "error")'),
    "the recovery action is offered for refusals that have no recovery",
  );
  const actions = [...APP.matchAll(/button\.dataset\.action = stale \? "refresh" : "retry"/g)];
  assert.equal(actions.length, 1, "more than one place decides which recovery a refusal gets");
});

// ===========================================================================
// The shell and the bundle agree about the regions
// ===========================================================================

test("[P2C.17] every region the bundle addresses exists in the shell, with a live region and a busy flag", () => {
  for (const id of ["approvals", "approval-detail", "revocation", "webhooks"]) {
    assert.ok(PAGE.includes(`id="${id}"`), `the console shell has no #${id}`);
    assert.ok(APP.includes(`byId("${id}")`) || APP.includes(`byId<`), `the bundle never addresses #${id}`);
  }
  for (const id of ["approvals", "revocation", "webhooks"]) {
    // A region an operator watches for an answer announces when it is busy.
    const region = PAGE.slice(PAGE.indexOf(`id="${id}"`));
    assert.ok(region.slice(0, 120).includes('aria-live="polite"'), `#${id} is not a live region`);
    assert.ok(region.slice(0, 120).includes('aria-busy="false"'), `#${id} does not start with a busy flag`);
  }
  // The shell's headings are the declared constants and not typed twice.
  assert.ok(PAGE.includes("${APPROVALS_TEXT.heading}"));
  assert.ok(PAGE.includes("${REVOCATION_TEXT.heading}"));
  assert.ok(PAGE.includes("${WEBHOOK_TEXT.heading}"));
});

test("[P2C.18] no backtick sits inside the shell's template literals", () => {
  // A backtick inside these templates ends the literal early and the file stops
  // parsing — a failure that costs an hour and is invisible in review.
  const style = PAGE.slice(PAGE.indexOf("const SHELL_STYLE = `") + "const SHELL_STYLE = `".length);
  const styleBody = style.slice(0, style.indexOf("\n`;"));
  assert.ok(!styleBody.includes("`"), "SHELL_STYLE contains a backtick");
  for (const marker of ["export function loginPage", "export function consolePage"]) {
    const from = PAGE.indexOf(marker);
    const body = PAGE.slice(from, PAGE.indexOf("\n}", from));
    const literals = body.split("`");
    assert.ok(literals.length % 2 === 1, `${marker} has an unbalanced template literal`);
  }
});

test("[P2C.19] the surfaces module is browser-safe: it imports nothing", () => {
  // It is bundled into the browser, exactly as `src/console-proofline.ts` is. A
  // `node:` import anywhere in its transitive graph would end up in a browser
  // build or fail it, and the cheapest way to have no transitive graph is to
  // have no imports.
  const imports = [...SURFACES.matchAll(/^import\s/gm)];
  assert.deepEqual(imports.map((m) => m[0]), [], "src/console-surfaces.ts has an import");
  assert.ok(!/from "node:/.test(SURFACES), "src/console-surfaces.ts imports a builtin module");
  assert.ok(!/require\(/.test(SURFACES), "src/console-surfaces.ts requires a module");
});
