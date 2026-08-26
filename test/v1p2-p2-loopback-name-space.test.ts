// THE FOURTH APPEARANCE OF ONE CLASS, CLOSED AT THE LEVEL OF THE RULE.
//
// The class: a loopback destination that registration admits and delivery
// refuses. It appeared as an `http://` spelling, then as an `https://` literal,
// then as a trailing-dot name, and each of the first three was closed by adding
// a row to a list — after which a spelling nobody had listed walked through.
//
// The third repair stopped doing that. It fixed HOW a name is compared:
// `canonicalHost` runs once, ahead of every rule that reads the host, so every
// spelling of one name became one string. That closed spellings nobody
// enumerated, and it is not what this file is about.
//
// The fourth appearance was not a spelling. `foo.localhost` is canonical
// already — lowercase, no trailing root dot, no percent-escape — so there was
// nothing left for `canonicalHost` to reduce, and the name arm, which asked
// whether the host EQUALLED `localhost`, said no. Registration answered `201`,
// minted a secret, and (§5.2 retires the previous endpoint on register) took
// away the endpoint that was working, while the SAME PROCESS's transport
// resolved the name to `::1` and declined the socket.
//
// What was wrong was WHICH NAMES COUNT AS KNOWN-LOOPBACK. RFC 6761 section 6.3
// reserves `localhost.` and `*.localhost.` together and gives them one
// property: they resolve to a loopback address or to nothing. The code cited
// that section while implementing half of it.
//
// SO THIS FILE ASSERTS THE RULE AND NOT A TABLE. A table of `.localhost` names
// would be the same mistake in a new costume: green today, short by one the next
// time somebody writes a name nobody listed. What is asserted here is the
// closure property — for EVERY label sequence built from the alphabet the DNS
// permits, a name under `.localhost` is refused, and its non-reserved
// counterpart is decided on other grounds — together with the boundary that
// keeps the claim honest.
//
// THE BOUNDARY, AND IT DOES NOT MOVE. Registration still cannot reach parity
// with delivery for arbitrary names. `evil.example.com` may answer `127.0.0.1`
// tomorrow; nothing decided once, with no resolver, can know that, and that case
// is delivery's to refuse at the socket — which it does, on every connect. This
// change widens the set of RESERVED names registration can decide without a
// resolver. It promises nothing about resolution, and the last test here is the
// assertion that it does not.
//
// EVERY DESTINATION IN THIS FILE IS EITHER REFUSED BEFORE A SOCKET IS OPENED OR
// IS A SERVER THIS FILE STARTED on an ephemeral port of 127.0.0.1 and closed in
// a `finally`. Nothing here reaches a network this machine is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";

import { handleRestAsync, type RestResponse } from "../src/http.ts";
import { p4Fixture, type P4Fixture } from "./p4-helpers.ts";
import { MemorySecretStore, deliveryPolicyOf, type WebhookTransport } from "../src/webhooks.ts";
import { HttpsWebhookTransport, canonicalHost, isLoopbackHost } from "../src/transport.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "console.local";

/** Short deadlines: the flag-ON half opens real sockets to CLOSED ports on this
 *  machine, and a refused connection should not wait out a production timeout. */
const PROBE_TIMEOUTS = { connectTimeoutMs: 1_000, totalTimeoutMs: 2_000 };

/**
 * A secret store that RECORDS every write, because the claim is that no secret
 * was minted — not that no secret survives under a ref the test knows how to
 * name. Reading the store by the refs of the rows that exist cannot see a
 * credential minted for a registration that was then refused, which is exactly
 * the harm §6.5.1 names.
 */
class RecordingSecretStore extends MemorySecretStore {
  readonly writes: string[] = [];
  override put(ref: string, secret: string): void {
    this.writes.push(`put ${ref}`);
    super.put(ref, secret);
  }
  override delete(ref: string): void {
    this.writes.push(`delete ${ref}`);
    super.delete(ref);
  }
}

interface WhFixture extends P4Fixture {
  secrets: RecordingSecretStore;
}

function fixture(transport: WebhookTransport): WhFixture {
  const secrets = new RecordingSecretStore();
  const fx = p4Fixture({ secrets, transport }) as WhFixture;
  fx.secrets = secrets;
  fx.db.prepare("UPDATE adoption_requests SET state='pushed' WHERE id=?").run(fx.seed.request);
  return fx;
}

async function register(fx: P4Fixture, url: string): Promise<RestResponse & { json: any }> {
  const res = await handleRestAsync(fx.registry, {
    method: "POST",
    url: "/v1/webhooks",
    headers: { host: ORIGIN, origin: `http://${ORIGIN}`, authorization: `Bearer ${fx.keys.member}` },
    body: Buffer.from(JSON.stringify({ url })),
  });
  let json: any = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { ...res, json };
}

/** Everything a registration could have moved, as one comparable value: the
 *  webhook rows with their health and secret columns, and the secret store. A
 *  refusal that arrives after either has moved has already minted a credential
 *  or retired a working endpoint, which is the harm and not a detail of it. */
function writtenState(fx: WhFixture): string {
  const rows = fx.db
    .prepare("SELECT id, agent_id, url, status, failure_count, last_error, secret_hash, secret_ref FROM webhooks ORDER BY id")
    .all();
  return JSON.stringify({ rows, secretWrites: fx.secrets.writes });
}

/**
 * The label alphabet a DNS name may use, and the shapes a reserved name can
 * take. Not a list of names somebody thought of: the CROSS PRODUCT, so the
 * assertion is over a space rather than over a sample. Depth matters because
 * section 6.3 reserves `*.localhost.`, which is any depth, not one level.
 */
const LABELS = ["a", "z", "0", "9", "foo", "x-y", "hook", "a0-z", "very-long-label-name"];
const DEPTHS = [1, 2, 3];

function reservedNames(): string[] {
  const out: string[] = [];
  for (const depth of DEPTHS) {
    for (const label of LABELS) {
      out.push(`${Array.from({ length: depth }, (_, i) => (i === 0 ? label : LABELS[i % LABELS.length])).join(".")}.localhost`);
    }
  }
  // and the spellings, so the two repairs are shown composing rather than each
  // being assumed to still hold in the other's presence
  for (const n of ["foo.localhost.", "FOO.LOCALHOST", "Foo.LocalHost.", "foo.localhost..", "foo%2elocalhost"]) out.push(n);
  return [...new Set(out)];
}

test("G-P2-0 / §6.5.1: every name in the reserved localhost space is known-loopback, at any depth", () => {
  const names = reservedNames();
  assert.ok(names.length >= 30, `the space is asserted over ${names.length} names, which is not a space`);
  for (const name of names) {
    assert.equal(isLoopbackHost(name), true, `${name} is reserved by RFC 6761 section 6.3 and names this machine`);
  }

  // THE DISCRIMINATION, without which the loop above is green on a predicate
  // that returns `true`. Each of these ends in the LABEL without ending in the
  // dotted label, or contains it somewhere that does not make it a suffix, and
  // each is a name somebody else can control and register.
  const others: string[] = [];
  for (const label of LABELS) {
    others.push(`${label}.localhost.attacker.com`, `${label}localhost`, `localhost.${label}`, `${label}.example.com`);
  }
  others.push("notlocalhost", "xlocalhost", "attacker-localhost", "localhost-evil.example", "evil.example.com.");
  for (const name of others) {
    assert.equal(isLoopbackHost(name), false, `${name} is not reserved and must remain an ordinary host`);
  }

  // …and the two sets are disjoint by construction, not by hope: a name in both
  // would make one of the loops above vacuous.
  const reserved = new Set(names.map(canonicalHost));
  for (const name of others) assert.equal(reserved.has(canonicalHost(name)), false, `${name} is in both sets`);
});

test("G-P2-0 / §6.5.1: this host answers the reserved names with loopback, which is why registering them was the defect", async () => {
  // The premise stated as a measurement rather than as a citation. If this host
  // ever stopped resolving these names to loopback the refusal would still be
  // correct — section 6.3 is what makes it correct — but the DEFECT the gate
  // reproduces would no longer be reproducible here, and a reader deserves to
  // know which of those two situations they are in.
  for (const name of ["localhost", "foo.localhost", "foo.localhost.", "a.b.localhost", "FOO.LocalHost"]) {
    const addresses = (await lookup(name, { all: true })).map((a) => a.address);
    assert.ok(
      addresses.length > 0 && addresses.every((a) => a === "::1" || a.startsWith("127.")),
      `${name} resolved to ${JSON.stringify(addresses)}, which is not loopback`,
    );
  }
});

test("G-P2-0 / §6.5.1: with the flag off, a reserved name is refused before any row or secret is written", async () => {
  const strict = new HttpsWebhookTransport({ allowLoopback: false, ...PROBE_TIMEOUTS });
  assert.equal(deliveryPolicyOf(strict).allowLoopback, false);
  const fx = fixture(strict);

  // THE ENDPOINT THAT MUST SURVIVE THE ATTEMPT. §5.2 keeps one endpoint per
  // adopter and registering retires the previous one, so admitting an
  // undeliverable destination does not merely add a bad row — it takes away the
  // good one. Without this row, "nothing moved" would hold on an empty table.
  const prior = await register(fx, "https://adopter.example.com/hook");
  assert.equal(prior.status, 201, prior.body);
  const priorId = prior.json.webhook_id as string;
  const before = writtenState(fx);

  for (const name of reservedNames()) {
    const url = `https://${name}:9/hook`;

    // the transport half first: if THIS process would deliver to it, the
    // registration assertion below is measuring the wrong thing
    const declined = await strict.send({ url, body: "{}", signature: "00" });
    assert.equal(declined.refused, true, `${url}: this transport does not decline the destination (${declined.error})`);

    const res = await register(fx, url);
    assert.equal(res.status, 400, `${url} was admitted by a deployment whose own transport declines it`);
    assert.equal(res.json.error.code, "INVALID_SCHEMA", `${url}: ${res.body}`);
  }

  assert.equal(writtenState(fx), before, "a refused registration wrote a row or minted a secret");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM webhooks").get() as { c: number }).c,
    1,
    "a refused registration changed the webhook row count",
  );
  assert.equal(
    (fx.db.prepare("SELECT status FROM webhooks WHERE id=?").get(priorId) as { status: string }).status,
    "active",
    "a refused registration retired the endpoint that was working",
  );
  fx.db.close();
});

test("G-P2-0 / §6.5.1: with the flag on, the same names register and the transport does not decline them", async () => {
  const permissive = new HttpsWebhookTransport({ allowLoopback: true, ...PROBE_TIMEOUTS });
  assert.equal(deliveryPolicyOf(permissive).allowLoopback, true);
  const fx = fixture(permissive);

  // The mirror. A fix that only closed the admit direction would leave the
  // over-refusal: on a deployment that DOES deliver to this machine,
  // `foo.localhost` is a destination it delivers to, and refusing to register
  // it would be the same drift pointing the other way.
  for (const name of ["foo.localhost", "a.b.localhost", "FOO.LocalHost", "foo.localhost."]) {
    const url = `https://${name}:9/hook`;
    const res = await register(fx, url);
    assert.equal(res.status, 201, `${url} was refused by a deployment that delivers to this machine: ${res.body}`);
    assert.equal(res.json.url, url, "the URL is echoed exactly as written");

    // whatever happens at a closed port, it must not be a POLICY refusal
    const attempted = await permissive.send({ url, body: "{}", signature: "00" });
    assert.notEqual(attempted.refused, true, `${url}: registration admitted what the SAME transport declines (${attempted.error})`);
  }
  fx.db.close();
});

test("G-P2-0 / §6.5.1: the boundary does not move — an UNRESERVED name that resolves to loopback still registers", async () => {
  // This is the edge the widened rule must not swallow, asserted so the prose in
  // src/transport.ts cannot outgrow it. Registration resolves no name. A name
  // outside the reserved space registers even where it answers `127.0.0.1`
  // today, because it may answer something else tomorrow and registration is
  // decided once. Delivery is what refuses it, at the socket, every connect.
  const strict = new HttpsWebhookTransport({
    allowLoopback: false,
    ...PROBE_TIMEOUTS,
    resolve: async () => ["127.0.0.1"],
  });
  const fx = fixture(strict);
  const url = "https://rebinds-later.example.com/hook";
  const admitted = await register(fx, url);
  assert.equal(admitted.status, 201, `registration resolves no name and must not pretend to: ${admitted.body}`);
  const declined = await strict.send({ url, body: "{}", signature: "00" });
  assert.equal(declined.refused, true, "the socket is where an unreserved name is judged, and it did not judge it");
  assert.match(declined.error!, /forbidden address \(loopback 127\.0\.0\.0\/8\)/);
  fx.db.close();
});

test("G-P2-0: the shipped prose states the rule the code applies, and no more", () => {
  // The previous three repairs each left a comment wider than the code. This
  // reads the two published statements of the rule and requires both to name the
  // reserved space and to keep the resolution disclaimer, so a reader is not
  // told registration decides more than it does.
  const transport = readFileSync(join(ROOT, "src", "transport.ts"), "utf8");
  const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
  for (const [where, text] of [["src/transport.ts", transport], ["SPEC.md", spec]] as const) {
    assert.match(text, /RFC 6761 section 6\.3/, `${where} must cite the rule it applies`);
    assert.match(text, /\.localhost/, `${where} must name the reserved space, not only the bare label`);
  }
  assert.match(transport, /evil\.example\.com/, "src/transport.ts must keep the case registration does NOT decide");
  assert.match(spec, /evil\.example\.com/, "SPEC.md must keep the case registration does NOT decide");
});
