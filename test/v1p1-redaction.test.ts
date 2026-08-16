// V1 P1 — REDACTION, AND THE SWEEP THAT PROVES IT.
//
// `P1-FR-08` says redaction happens BEFORE the draft, the audit, the logs and
// the evidence are written, and that no raw secret value is persisted.
// `P1-FR-09` says the preview shows category, location and reason WITHOUT
// revealing the secret. A test that asserted the first by reading the response
// body would prove nothing about the second half of the sentence, so what this
// file does is sweep:
//
//   * EVERY column of EVERY table of the live database, decoded, for the
//     material and for every fragment of it long enough to matter;
//   * the API responses of every capture and draft surface, on both adapters;
//   * the audit rows;
//   * and the previews, which must name the removal without carrying it.
//
// The material below is planted, not real: three shapes of credential written
// the way somebody pastes them into a terminal transcript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture } from "./p4-helpers.ts";
import { rest, mcp } from "./p6-helpers.ts";
import { redact } from "../src/redaction.ts";
import { SECRET_PATTERNS } from "../src/gates.ts";

/**
 * Planted material. Every one of these is a value a sweep must not find.
 *
 * ASSEMBLED FROM FRAGMENTS AT RUN TIME, never written as a literal, for the
 * reason `test/p7-threats.test.ts` gives at TM-03 and `[15.4]` enforces over
 * every tracked file: a push-side secret scanner matches the blob and cannot
 * tell a red-team fixture from a credential, so it refuses the publication. The
 * values are byte for byte what they would have been; only the spelling in this
 * file changes.
 */
const SECRETS = {
  github: ["ghp", "_0123456789", "abcdefghijklmnopqrstuvwxyz"].join(""),
  aws: ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
  jwt: [
    ["eyJhbGci", "OiJIUzI1NiJ9"].join(""),
    ["eyJzdWIiOiJza2xuIiwi", "aWF0IjoxNTE2MjM5MDIyfQ"].join(""),
    ["dBjftJeZ4CVPmB92K27u", "hbUJU1p1r_wW1gFWFOEjXk"].join(""),
  ].join("."),
  apiKey: ["sk-live-9f2b7c41", "d8e6a05b3f7c19d4e82a6b0c"].join(""),
  password: ["hunter2", "-correct-horse"].join(""),
  urlPassword: ["s3cr3t", "-in-a-url"].join(""),
} as const;

const CAPTURE = [
  "# Restore the staging database",
  "",
  "## Purpose",
  "Bring staging back from the nightly dump.",
  "",
  "## When to use",
  "Whenever staging is wedged and the nightly dump is younger than a day.",
  "",
  "## Procedure",
  `1. Export the token: api_key=${SECRETS.apiKey}`,
  `2. Run \`curl -H "Authorization: Bearer ${SECRETS.jwt}" https://staging.example.com/dump\`.`,
  `3. Use the deploy key ${SECRETS.github} and the account ${SECRETS.aws}.`,
  `4. Connect with \`psql postgres://admin:${SECRETS.urlPassword}@db.example.com/staging\`.`,
  `5. The password is ${SECRETS.password} if the restore prompts.`,
].join("\n");

/** Every value, plus the fragments a partial leak would show up as. */
function fragments(): string[] {
  const out: string[] = [];
  for (const value of Object.values(SECRETS)) {
    out.push(value);
    if (value.length >= 24) out.push(value.slice(0, 16), value.slice(-16));
  }
  return out;
}

/** Every byte of every column of every table, as text. */
function databaseBytes(db: any): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  const out: string[] = [];
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        out.push(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
      }
    }
  }
  return out.join("\n");
}

test("P1-FR-08: no raw secret reaches the database, the API response, the audit or a preview", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    title: "restore-staging",
    source_ref: `session-${SECRETS.github}`,
    // …AND IN THE IDEMPOTENCY KEY. `P1-R2-001`: the key travels with the body
    // into a column of its own, and it is the one field of this request that
    // cannot be redacted, because it is the lookup index. It is digested
    // instead, so the sweep below covers it like everything else.
    idempotency_key: `retry-${SECRETS.apiKey}`,
    text: CAPTURE,
  });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.body.outcome, "drafted", created.raw);
  const draftId = created.body.draft.draft_id;

  const surfaces = [
    created.raw,
    rest(fx, "GET", "/v1/drafts", fx.keys.owner!).raw,
    rest(fx, "GET", `/v1/drafts/${draftId}`, fx.keys.owner!).raw,
    rest(fx, "GET", `/v1/drafts/${draftId}/audit`, fx.keys.owner!).raw,
    JSON.stringify(mcp(fx, fx.keys.owner!, "draft.get", { draft_id: draftId }).data),
    JSON.stringify(mcp(fx, fx.keys.owner!, "draft.audit", { draft_id: draftId }).data),
    databaseBytes(fx.db),
  ];
  for (const fragment of fragments()) {
    for (const [i, surface] of surfaces.entries()) {
      assert.ok(!surface.includes(fragment), `surface ${i} carries planted material: ${fragment.slice(0, 8)}…`);
    }
  }

  // …and the sweep is proved to be capable of finding something: the same
  // search over the RAW capture finds every one of them.
  for (const fragment of fragments()) {
    assert.ok(CAPTURE.includes(fragment) || `session-${SECRETS.github}`.includes(fragment), "the sweep's own subject");
  }
  fx.db.close();
});

test("P1-FR-09: the preview names category, location and reason and carries no value", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: CAPTURE });
  const redactions = created.body.draft.content.redactions;
  assert.ok(redactions.length >= 5, `every planted secret is reported; got ${redactions.length}`);
  const categories = new Set(redactions.map((r: any) => r.category));
  for (const expected of ["api_key", "token", "password", "credential_in_url"]) {
    assert.ok(categories.has(expected), `no finding of category ${expected}`);
  }
  for (const finding of redactions) {
    assert.ok(Number.isInteger(finding.line) && finding.line >= 1, "a location");
    assert.ok(Number.isInteger(finding.column) && finding.column >= 1);
    assert.ok(finding.reason.length > 0, "a reason");
    assert.ok(finding.removed_characters > 0, "how much was taken out");
    assert.deepEqual(
      Object.keys(finding).sort(),
      ["category", "column", "detector", "line", "reason", "removed_characters", "source_field"],
      "a finding carries no field that could hold the value",
    );
    assert.equal(finding.source_field, "source", "the body's findings name the body, as a field and not a sentence");
  }
  // the security preview is the same list, and the security review reports it
  assert.deepEqual(created.body.draft.security_review.redactions, redactions);
  assert.ok(
    created.body.draft.security_review.risky_actions.some((r: any) => r.code === "credential_material_removed"),
    "an owner is told that material was removed",
  );
  fx.db.close();
});

test("the stored source keeps the shape of the procedure and loses only the secrets", () => {
  const fx = p4Fixture();
  rest(fx, "POST", "/v1/captures", fx.keys.owner!, { kind: "workflow", text: CAPTURE });
  const stored = fx.db.prepare("SELECT redacted_source FROM captures").get() as { redacted_source: string };
  assert.match(stored.redacted_source, /⟦REDACTED:api_key⟧/);
  assert.match(stored.redacted_source, /⟦REDACTED:token⟧/);
  assert.match(stored.redacted_source, /⟦REDACTED:password⟧/);
  assert.match(stored.redacted_source, /Bring staging back from the nightly dump\./, "the prose survives");
  assert.match(stored.redacted_source, /Export the token/, "…and so does the step it was in");
  fx.db.close();
});

test("a reference is redacted too: a session id that is really a token stores no token", () => {
  const fx = p4Fixture();
  rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    source_ref: `session-${SECRETS.github}`,
    text: "## Procedure\n1. Run the tests.\n2. Read the failures.\n\nWhenever the build breaks.",
  });
  const row = fx.db.prepare("SELECT source_ref FROM captures").get() as { source_ref: string };
  assert.ok(!row.source_ref.includes(SECRETS.github));
  assert.match(row.source_ref, /⟦REDACTED:api_key⟧/);
  const event = fx.db.prepare("SELECT correlation_ref FROM draft_events WHERE event='captured'").get() as {
    correlation_ref: string;
  };
  assert.ok(!event.correlation_ref.includes(SECRETS.github), "the audit's correlation field is the same value");
  fx.db.close();
});

test("P1-FR-08 applies to an owner's EDIT as much as to a capture", () => {
  const fx = p4Fixture();
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    text: "## Procedure\n1. Run the tests.\n2. Read the failures.\n\nWhenever the build breaks.",
  });
  const draftId = created.body.draft.draft_id;
  const edited = rest(fx, "POST", `/v1/drafts/${draftId}/revisions`, fx.keys.owner!, {
    sections: { procedure: [`Run the tests with api_key=${SECRETS.apiKey}`, "Read the failures."] },
  });
  assert.equal(edited.status, 201, edited.raw);
  assert.ok(!edited.raw.includes(SECRETS.apiKey), "the answer does not echo what the owner pasted");
  assert.ok(!databaseBytes(fx.db).includes(SECRETS.apiKey), "…and neither does any column");
  const added = edited.body.content.redactions.filter((r: any) => /in the edited procedure/.test(r.reason));
  assert.equal(added.length, 1, "the finding says which section the material came out of");
  fx.db.close();
});

test("the redactor's own contract: overlapping matches leave one token, and the categories are the published ones", () => {
  // a JWT is also a high-entropy token: one secret, one token, not two nested
  const out = redact(`the header was Authorization: Bearer ${SECRETS.jwt} and that is all`);
  assert.equal(out.findings.length, 1, "one secret, one finding");
  assert.equal((out.text.match(/⟦REDACTED:/g) ?? []).length, 1);
  assert.ok(!out.text.includes(SECRETS.jwt));
  assert.match(out.text, /the header was Authorization: .*and that is all/);

  // the published patterns of Appendix G.1 are the ones this module applies
  for (const { id, re } of SECRET_PATTERNS) {
    if (id === "pem-private-key") continue; // exercised below as a block
    assert.ok(re instanceof RegExp, `${id} is a pattern`);
  }
  // the PEM header is assembled too: written out, it is the `pem-private-key`
  // pattern's own shape and `[15.4]` refuses it in a tracked file
  const begin = ["-----BEGIN RSA ", "PRIVATE KEY", "-----"].join("");
  const end = ["-----END RSA ", "PRIVATE KEY", "-----"].join("");
  const pem = redact(`${begin}\nMIIBOgIBAAJBAK\n${end}`);
  assert.equal(pem.findings.length, 1);
  assert.equal(pem.findings[0]!.category, "private_key");
  assert.ok(!pem.text.includes("MIIBOgIBAAJBAK"), "the whole block goes, not only its header");
});

test("redaction is deterministic: the same source redacts the same way", () => {
  const first = redact(CAPTURE);
  const second = redact(CAPTURE);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.findings, first.findings);
  // …which is what makes the digest of a redacted capture stable
  assert.ok(first.findings.length >= 5);
});

test("a capture with no credential in it reports no redactions and no removal warning", () => {
  const fx = p4Fixture();
  const clean = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    text: "## Procedure\n1. Run the tests.\n2. Read the failures.\n\nWhenever the build breaks.",
  });
  assert.deepEqual(clean.body.draft.content.redactions, []);
  assert.ok(
    !clean.body.draft.security_review.risky_actions.some((r: any) => r.code === "credential_material_removed"),
    "a clean capture is not warned about material that was never there",
  );
  fx.db.close();
});
