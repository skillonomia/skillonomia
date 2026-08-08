// The outbound HTTP transport — one case per defence.
//
// This is the only code in the repository that dials an address a user chose,
// so each rule gets its own case rather than being covered incidentally by the
// happy path: https-only, no redirects, every resolved address checked, the
// connection pinned to the address that WAS checked, a connect and a total
// deadline, and a cap on the response body. The happy path runs against a real
// listener, so the signature, the headers and the exact body bytes are
// asserted as an adopter would see them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  HttpsWebhookTransport,
  blockedReason,
  parseIpv6,
  defaultTransport,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "../src/transport.ts";
import { SIGNATURE_HEADER, signBody, verifySignature, type WebhookRequest } from "../src/webhooks.ts";

const SECRET = "whsec_a-secret-that-must-never-appear-anywhere";
const BODY = JSON.stringify({ adoption_request_id: "01REQ", attempt: 1 });

function push(url: string): WebhookRequest {
  return { url, body: BODY, signature: signBody(SECRET, BODY) };
}

interface Receiver {
  server: Server;
  port: number;
  seen: Array<{ method: string; url: string; headers: Record<string, any>; body: string }>;
  close: () => void;
}

/** A real listener on loopback — the only network this suite touches. */
async function receiver(handler: (req: IncomingMessage, res: ServerResponse, seen: Receiver["seen"]) => void): Promise<Receiver> {
  const seen: Receiver["seen"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, any>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res, seen);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => server.close(),
  };
}

// ------------------------------------------------------------- address rules

test("every forbidden range is refused, by literal address, before any socket exists", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["0.0.0.0", /unspecified/],
    ["10.1.2.3", /private 10\./],
    ["127.0.0.1", /loopback/],
    ["127.9.9.9", /loopback/],
    ["100.64.0.1", /carrier-grade NAT/],
    ["169.254.169.254", /link-local.*metadata/],
    ["172.16.0.1", /private 172/],
    ["172.31.255.255", /private 172/],
    ["192.168.1.1", /private 192\.168/],
    ["192.0.0.1", /protocol assignments/],
    ["192.88.99.1", /6to4 relay/],
    ["198.18.0.1", /benchmarking/],
    ["224.0.0.1", /multicast/],
    ["255.255.255.255", /reserved/],
    ["::", /unspecified/],
    ["::1", /loopback/],
    ["fd00:ec2::254", /unique local/],
    ["fc00::1", /unique local/],
    ["fe80::1", /link-local/],
    ["ff02::1", /multicast/],
    ["100::1", /discard-only/],
    // the wrappers that carry an IPv4 destination inside a v6 literal
    ["::ffff:127.0.0.1", /IPv4-mapped.*loopback/],
    ["::ffff:169.254.169.254", /IPv4-mapped.*metadata/],
    ["::ffff:10.0.0.1", /IPv4-mapped.*private/],
    ["64:ff9b::127.0.0.1", /NAT64-embedded.*loopback/],
    ["2002:7f00:0001::", /6to4-embedded.*loopback/],
    ["2002:a9fe:a9fe::", /6to4-embedded.*metadata/],
  ];
  for (const [address, reason] of forbidden) {
    const got = blockedReason(address);
    assert.ok(got !== null, `${address} must be refused`);
    assert.match(got!, reason, address);
  }

  // …and a genuinely public address is not
  for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) {
    assert.equal(blockedReason(address), null, address);
  }
  assert.equal(blockedReason("not-an-ip"), "not an IP address");
});

test("the IPv6 parser handles ::, embedded IPv4 and scope ids, and rejects nonsense", () => {
  assert.deepEqual([...parseIpv6("::1")!], [...new Uint8Array(15), 1]);
  assert.deepEqual([...parseIpv6("::ffff:1.2.3.4")!].slice(10), [0xff, 0xff, 1, 2, 3, 4]);
  assert.equal(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")![3], 0xb8);
  // A scope id names a local interface, never a different host. node's isIP
  // ACCEPTS a zoned literal, so the parser has to strip the zone itself —
  // otherwise `fe80::1%eth0` would parse as nonsense and the fe80::/10 rule
  // would never be reached for the one form in which link-local is usable.
  assert.equal(blockedReason("fe80::1%eth0"), "link-local fe80::/10");
  assert.deepEqual([...parseIpv6("fe80::1%eth0")!.slice(0, 2)], [0xfe, 0x80]);
  for (const bad of ["", "1:2:3", "::1::2", "gggg::1", "1.2.3.4", "::ffff:1.2.3.4:5"]) {
    assert.equal(parseIpv6(bad), null, bad);
  }
});

test("a name that resolves to ANY forbidden address is refused outright", async () => {
  const calls: string[] = [];
  const transport = new HttpsWebhookTransport({
    resolve: async (host) => {
      calls.push(host);
      // one public, one private — a round-robin resolver could hand over
      // either one on the next attempt, so neither is usable
      return ["93.184.216.34", "10.0.0.7"];
    },
  });
  const res = await transport.send(push("https://mixed.example.com/hook"));
  assert.equal(res.status, 0);
  assert.match(res.error!, /forbidden address \(private 10\./);
  assert.deepEqual(calls, ["mixed.example.com"]);

  // a name that resolves to nothing at all is refused too, not retried blind
  const empty = new HttpsWebhookTransport({ resolve: async () => [] });
  assert.match((await empty.send(push("https://void.example.com/h"))).error!, /resolved to no address/);

  // a resolver failure is a delivery failure with a message, never a throw
  const broken = new HttpsWebhookTransport({
    resolve: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.match((await broken.send(push("https://nx.example.com/h"))).error!, /cannot resolve/);
});

test("https is required, credentials in the URL are refused, and a bad URL is not a crash", async () => {
  const transport = new HttpsWebhookTransport({ resolve: async () => ["93.184.216.34"] });
  for (const [url, reason] of [
    ["http://plain.example.com/h", /https is required/],
    ["ftp://files.example.com/h", /https is required/],
    ["https://user:pw@auth.example.com/h", /carries credentials/],
    ["not a url", /not a valid URL/],
  ] as Array<[string, RegExp]>) {
    const res = await transport.send(push(url));
    assert.equal(res.status, 0, url);
    assert.match(res.error!, reason, url);
  }
});

// ---------------------------------------------------------------- happy path

test("the happy path: a real receiver gets POST, the exact body bytes and a verifiable signature", async () => {
  const rx = await receiver((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const transport = new HttpsWebhookTransport({ allowLoopback: true });
    const res = await transport.send(push(`http://127.0.0.1:${rx.port}/hooks/skillonomia?x=1`));
    assert.equal(res.status, 204, res.error ?? "");
    assert.equal(res.error, undefined);

    assert.equal(rx.seen.length, 1);
    const got = rx.seen[0];
    assert.equal(got.method, "POST");
    assert.equal(got.url, "/hooks/skillonomia?x=1", "path AND query are delivered");
    assert.equal(got.body, BODY, "the exact bytes, byte for byte");
    assert.equal(got.headers["content-type"], "application/json");
    assert.equal(got.headers["content-length"], String(Buffer.byteLength(BODY)));

    // §5.2: HMAC-SHA256 over the exact body bytes, and an adopter can check it
    const signature = got.headers[SIGNATURE_HEADER.toLowerCase()];
    assert.equal(typeof signature, "string");
    assert.equal(verifySignature(SECRET, got.body, signature), true);
    assert.equal(verifySignature("whsec_wrong", got.body, signature), false);
  } finally {
    rx.close();
  }
});

test("loopback is refused unless the deployment opts in — registering one is not delivering to one", async () => {
  const rx = await receiver((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const strict = new HttpsWebhookTransport();
    const res = await strict.send(push(`http://127.0.0.1:${rx.port}/hook`));
    assert.equal(res.status, 0);
    assert.match(res.error!, /https is required/);
    assert.equal(rx.seen.length, 0, "nothing was sent");

    // …and not even over https, where the scheme check would pass
    const viaHttps = await strict.send(push(`https://127.0.0.1:${rx.port}/hook`));
    assert.equal(viaHttps.status, 0);
    assert.match(viaHttps.error!, /forbidden address \(loopback/);
    assert.equal(rx.seen.length, 0);
  } finally {
    rx.close();
  }
});

// ------------------------------------------------------------ DNS rebinding

test("the socket goes to the address that was CHECKED — the name is resolved exactly once", async () => {
  const rx = await receiver((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  try {
    let calls = 0;
    const transport = new HttpsWebhookTransport({
      allowLoopback: true,
      resolve: async () => {
        calls += 1;
        // A rebinding attacker answers a second lookup differently. If the
        // transport resolved again at connect time, this would be its window.
        return calls === 1 ? ["127.0.0.1"] : ["169.254.169.254"];
      },
    });
    const res = await transport.send(push(`http://adopter.example.test:${rx.port}/hook`));
    assert.equal(res.status, 200, res.error ?? "");
    assert.equal(calls, 1, "the transport resolved the name once and pinned the answer");
    // the connection landed on the vetted address, carrying the original name
    assert.equal(rx.seen.length, 1);
    assert.equal(rx.seen[0].headers.host, `adopter.example.test:${rx.port}`, "Host stays the NAME; only the address is pinned");
  } finally {
    rx.close();
  }
});

// --------------------------------------------------------------- redirects

test("redirects are not followed: a 3xx is the answer, and the target is never fetched", async () => {
  const target = await receiver((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const rx = await receiver((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.port}/moved` });
    res.end();
  });
  try {
    const transport = new HttpsWebhookTransport({ allowLoopback: true });
    const res = await transport.send(push(`http://127.0.0.1:${rx.port}/hook`));
    assert.equal(res.status, 302, "reported as itself…");
    assert.match(res.error!, /status 302/);
    assert.equal(target.seen.length, 0, "…and the redirect target was never contacted");

    // a 3xx is not 2xx, so §5.2's health rules count it as a failure — which
    // is what stops an endpoint from redirecting its way anywhere at all
    assert.ok(!(res.status >= 200 && res.status < 300));
  } finally {
    rx.close();
    target.close();
  }
});

// ---------------------------------------------------------------- deadlines

test("a receiver that never answers hits the total deadline instead of holding the worker", async () => {
  const held: ServerResponse[] = [];
  const rx = await receiver((_req, res) => {
    held.push(res); // accepted, and deliberately never answered
  });
  try {
    const transport = new HttpsWebhookTransport({ allowLoopback: true, totalTimeoutMs: 300, connectTimeoutMs: 5_000 });
    const started = Date.now();
    const res = await transport.send(push(`http://127.0.0.1:${rx.port}/hook`));
    const elapsed = Date.now() - started;
    assert.equal(res.status, 0);
    assert.match(res.error!, /timed out after 300 ms/);
    assert.ok(elapsed < 5_000, `the deadline fired, not the connect timeout (${elapsed} ms)`);
  } finally {
    for (const res of held) res.end();
    rx.close();
  }
});

test("a receiver that accepts and then goes silent hits the CONNECT/inactivity deadline", async () => {
  // Two deadlines, two cases. This one is the socket-level one: the peer
  // accepts and then says nothing, which is what a black-holed endpoint looks
  // like. (Everything here stays on loopback — the suite opens no connection
  // off this machine.)
  const held: ServerResponse[] = [];
  const rx = await receiver((_req, res) => {
    held.push(res);
  });
  try {
    const transport = new HttpsWebhookTransport({ allowLoopback: true, connectTimeoutMs: 200, totalTimeoutMs: 10_000 });
    const started = Date.now();
    const res = await transport.send(push(`http://127.0.0.1:${rx.port}/hook`));
    assert.equal(res.status, 0);
    assert.match(res.error!, /connection timed out after 200 ms/);
    assert.ok(Date.now() - started < 5_000, "the socket deadline fired, not the total one");
  } finally {
    for (const res of held) res.end();
    rx.close();
  }
});

test("a refused connection is a delivery failure with a message, not an exception", async () => {
  const rx = await receiver((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const port = rx.port;
  rx.close();
  await once(rx.server, "close");
  const transport = new HttpsWebhookTransport({ allowLoopback: true, totalTimeoutMs: 2_000 });
  const res = await transport.send(push(`http://127.0.0.1:${port}/hook`));
  assert.equal(res.status, 0);
  assert.match(res.error!, /delivery failed/);
});

// ------------------------------------------------------------- response cap

test("a receiver that floods the response is a failed delivery, not an unbounded read", async () => {
  const rx = await receiver((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // far past the cap the transport is configured with
    for (let i = 0; i < 64; i += 1) res.write("x".repeat(4096));
    res.end();
  });
  try {
    const transport = new HttpsWebhookTransport({ allowLoopback: true, maxResponseBytes: 1024, totalTimeoutMs: 5_000 });
    const res = await transport.send(push(`http://127.0.0.1:${rx.port}/hook`));
    assert.equal(res.status, 0, "a 2xx that floods the registry is not an answer");
    assert.match(res.error!, /exceeded 1024 bytes/);

    // a small body is fine
    const ok = new HttpsWebhookTransport({ allowLoopback: true, maxResponseBytes: 1024 });
    const small = await receiver((_req, r) => {
      r.writeHead(200);
      r.end("thanks");
    });
    try {
      assert.equal((await ok.send(push(`http://127.0.0.1:${small.port}/hook`))).status, 200);
    } finally {
      small.close();
    }
  } finally {
    rx.close();
  }
});

// ---------------------------------------------------------- secret hygiene

test("no failure message can carry the secret, because the transport never receives one", async () => {
  const rx = await receiver((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    // the shape of what a transport is handed: url, body, signature. No secret.
    const req = push(`http://127.0.0.1:${rx.port}/hook`);
    assert.deepEqual(Object.keys(req).sort(), ["body", "signature", "url"]);

    const transport = new HttpsWebhookTransport({ allowLoopback: true });
    const outcomes = [
      await transport.send(req),
      await transport.send(push("https://10.0.0.1/hook")),
      await transport.send(push("http://plain.example.com/hook")),
      await transport.send(push("not a url")),
    ];
    for (const res of outcomes) {
      assert.ok(!JSON.stringify(res).includes(SECRET), "no error message names the secret");
      assert.ok(!JSON.stringify(res).includes(req.signature), "nor the signature");
      assert.ok(!JSON.stringify(res).includes(BODY), "nor the body");
    }
    // and the receiver saw the signature but never the secret
    assert.ok(!JSON.stringify(rx.seen).includes(SECRET));
  } finally {
    rx.close();
  }
});

// ----------------------------------------------------------- the default one

test("the deployment default is strict, and the env knobs are the only way to loosen it", async () => {
  const strict = defaultTransport({} as NodeJS.ProcessEnv);
  const res = await strict.send(push("http://127.0.0.1:1/hook"));
  assert.equal(res.status, 0);
  assert.match(res.error!, /https is required/, "loopback is OFF unless asked for");

  const rx = await receiver((_req, r) => {
    r.writeHead(200);
    r.end();
  });
  try {
    const dev = defaultTransport({ SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK: "1" } as NodeJS.ProcessEnv);
    assert.equal((await dev.send(push(`http://127.0.0.1:${rx.port}/hook`))).status, 200);
    assert.ok(DEFAULT_MAX_RESPONSE_BYTES > 0);
  } finally {
    rx.close();
  }
});
