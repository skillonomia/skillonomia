// A document does not get an exemption for being the shipped path.
//
// `test/bind-address.test.ts` settles what the SOFTWARE does: a bare `serve`
// binds `127.0.0.1`, and going wider takes an explicit `--host` or
// `SKILLONOMIA_HOST`. That left one hole, and it was the one an operator
// actually walks through. The container image sets `SKILLONOMIA_HOST=0.0.0.0`
// itself, the documents printed a copy-pasteable `docker run` publishing the
// registry port with NO host address, and the earlier test declined to look at
// it — the container path was reasoned about as "the operator's explicit
// decision" and therefore excluded from the check. An exclusion is how a test
// stops being evidence: the one path we ship end-to-end was the one path the
// boundary was never asserted over, and the safe default we had just installed
// was undone by the line most readers copy.
//
// THE RULE THIS FILE ENFORCES, on the container path exactly as strictly as on
// the from-source path:
//
//   Nothing this repository ships may show a command that publishes the
//   registry port onto an interface other than the loopback.
//
// That is a boundary, not a style preference, and for the same reason as the
// bind address: this process speaks plain HTTP and terminates no TLS, and two
// kinds of credential cross the listener in the clear — the §9.1 one-time
// bootstrap token, which mints the owner's key for whoever presents it, and
// every API key afterwards as a `Bearer` header. `-p 7431:7431` maps that onto
// every interface the host has. Prose beside the command does not change what
// the command does; the only thing that does is not writing the command.
//
// What remains allowed, and is asserted here as a positive control so this file
// cannot degenerate into "no docker anywhere":
//
//   - `-p 127.0.0.1:7431:7431` — a LOCAL trial, in a section that says so;
//   - an external topology in which the registry port is not published at all
//     and a TLS-terminating proxy is the only thing on a public interface;
//   - `SKILLONOMIA_HOST=0.0.0.0` INSIDE the image, which is what makes the
//     container reachable through that proxy at all, and which is neither a TLS
//     boundary nor a permission boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/** The registry's own listener port — the one whose publication is the subject. */
const REGISTRY_PORT = "7431";

// ------------------------------------------------------------------- corpus
//
// Everything an operator is told to run. `ci/*.sh` and the `Dockerfile` are in
// here deliberately: they are shipped instructions too, executed rather than
// read, and the Dockerfile's own header comment carried the unsafe form.

const OPERATOR_DOCS = [
  "README.md",
  ...readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `docs/${f}`),
  "CONTRIBUTING.md",
  "SECURITY.md",
];

const OPERATOR_SCRIPTS = [
  "Dockerfile",
  ...readdirSync(join(ROOT, "ci"))
    .filter((f) => f.endsWith(".sh"))
    .sort()
    .map((f) => `ci/${f}`),
];

const SCANNED = [...OPERATOR_DOCS, ...OPERATOR_SCRIPTS];

/**
 * Markdown that is NOT an instruction to an operator, each with the reason it
 * is not. This list is the entire exemption surface of this file, it is short
 * on purpose, and the test below proves nothing else escaped by accident.
 */
const NOT_INSTRUCTIONS: Record<string, string> = {
  "SPEC.md": "the normative text the implementation is checked against, addressed by §; not a runbook",
};

// ------------------------------------------------------- the publish grammar

interface Publish {
  /** exactly as written */
  spec: string;
  /** the host address the port is bound to, or `null` when none was named */
  hostAddr: string | null;
  /** the container-side port */
  containerPort: string;
}

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|::1|0:0:0:0:0:0:0:1)$/i;

/**
 * `[[hostAddr:]hostPort:]containerPort[/proto]` — Docker's own publish grammar.
 *
 * Returns `null` for anything that is not a port mapping at all, which is how
 * `mkdir -p /data` stays out of the way. The two cases that matter:
 *
 *   `127.0.0.1:7431:7431` → bound to the loopback, and reachable nowhere else;
 *   `7431:7431` and bare `7431` → NO address named, which in Docker means every
 *   interface the host has. The absence is the danger, so it is modelled as a
 *   value (`hostAddr === null`) rather than as a missing field.
 */
function parsePublish(raw: string): Publish | null {
  let s = raw.replace(/\/(tcp|udp|sctp)$/i, "");
  let hostAddr: string | null = null;
  const v6 = /^\[([^\]]+)\]:(.*)$/.exec(s);
  if (v6) {
    hostAddr = v6[1];
    s = v6[2];
  }
  const parts = s.split(":");
  if (hostAddr === null && parts.length === 3) hostAddr = parts.shift() ?? null;
  if (parts.length > 2) return null;
  const containerPort = parts[parts.length - 1];
  if (!/^\d{1,5}(-\d{1,5})?$/.test(containerPort)) return null;
  return { spec: raw, hostAddr, containerPort };
}

/**
 * Every `-p` / `--publish` in a body of text, wherever it sits — a fenced
 * block, a table cell, a shell script, a comment. Scanning the raw text rather
 * than "the commands" is deliberate: deciding which strings are runnable is
 * exactly the judgement call that let the last hole through, and a reader
 * copies from prose as readily as from a fence.
 */
function publishesIn(text: string): Publish[] {
  const out: Publish[] = [];
  const re = /(?:^|[\s(`"'])(?:-p|--publish)(?:=|\s+)(["'`]?)([^\s"'`]+)\1/g;
  for (const m of text.matchAll(re)) {
    const p = parsePublish(m[2]);
    if (p) out.push(p);
  }
  // Docker Compose's `ports:` is the same publication under another spelling.
  for (const m of text.matchAll(/^\s*(?:ports:\s*)?[-[]?\s*["']([^"']+)["']/gm)) {
    const p = parsePublish(m[1]);
    if (p && m[1].includes(":")) out.push(p);
  }
  return out;
}

/** `true` when this publication puts the port on something other than the loopback. */
const isExternal = (p: Publish): boolean => p.hostAddr === null || !LOOPBACK.test(p.hostAddr);

/** Publications of the REGISTRY's port that reach past the loopback. */
function registryPortLeaks(text: string): Publish[] {
  return publishesIn(text).filter((p) => p.containerPort === REGISTRY_PORT && isExternal(p));
}

// --------------------------------------------------------------- doc surgery

/**
 * A markdown document cut at its headings: `{heading, body}`, body includes the
 * heading line. Fence-aware, because `# 1. exchange the bootstrap token` inside
 * a ```bash block is a shell comment and not a heading, and a splitter that
 * cannot tell the difference silently cuts a section in half — which is exactly
 * how a command ends up outside the paragraph that was supposed to govern it.
 */
function sections(md: string): Array<{ heading: string; body: string }> {
  const lines = md.split("\n");
  const out: Array<{ heading: string; body: string }> = [];
  let heading = "(preamble)";
  let body: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,6}\s/.test(line)) {
      out.push({ heading, body: body.join("\n") });
      heading = line.replace(/^#+\s*/, "").trim();
      body = [line];
    } else body.push(line);
  }
  out.push({ heading, body: body.join("\n") });
  return out;
}

/** Prose for matching: a sentence broken across two lines is still one sentence. */
const flat = (s: string): string => s.replace(/\s+/g, " ");

const sectionOf = (md: string, match: RegExp): { heading: string; body: string } => {
  const found = sections(md).filter((s) => match.test(s.heading));
  assert.equal(found.length, 1, `expected exactly one section whose heading matches ${match}, found ${found.length}`);
  return found[0];
};

/** The fenced block introduced by `<!-- doc-test: name -->`, verbatim. */
function docBlock(md: string, name: string): string {
  const marker = `<!-- doc-test: ${name} -->`;
  const at = md.indexOf(marker);
  assert.notEqual(at, -1, `the document must carry a \`${marker}\` block`);
  const fence = md.indexOf("```bash\n", at);
  const start = fence + "```bash\n".length;
  const end = md.indexOf("\n```", start);
  assert.ok(fence !== -1 && end !== -1, `${marker} must be followed by a closed \`\`\`bash fence`);
  return md.slice(start, end);
}

// -------------------------------------------------------------------- tests

test("the checker itself is not vacuous: it reads Docker's publish grammar", () => {
  // If this file only ever asserted "the documents are clean", a broken parser
  // would look exactly like a clean repository. So: the forms that must be
  // caught, and the forms that must not be.
  const external = ["7431:7431", "8443:7431", "0.0.0.0:7431:7431", "[::]:7431:7431", "7431", "7431:7431/tcp"];
  for (const spec of external) {
    const p = parsePublish(spec);
    assert.ok(p, `\`-p ${spec}\` must parse as a publication`);
    assert.equal(p.containerPort, REGISTRY_PORT, `\`-p ${spec}\` publishes the registry port`);
    assert.ok(isExternal(p), `\`-p ${spec}\` names no loopback address — it must be rejected`);
  }

  const loopback = ["127.0.0.1:7431:7431", "127.0.0.1:9000:7431", "[::1]:7431:7431", "localhost:7431:7431"];
  for (const spec of loopback) {
    const p = parsePublish(spec);
    assert.ok(p, `\`-p ${spec}\` must parse as a publication`);
    assert.ok(!isExternal(p), `\`-p ${spec}\` is loopback-bound and must be allowed`);
  }

  // and the flag that is not a publication at all
  assert.equal(parsePublish("/data"), null, "`mkdir -p /data` is not a port mapping");
  assert.equal(registryPortLeaks("RUN mkdir -p /data && chown -R bun:bun /data").length, 0);

  // the scan finds them where they actually live: a fence, a table cell, a
  // compose file, a script
  assert.equal(registryPortLeaks("```bash\ndocker run -p 7431:7431 img\n```").length, 1, "a fenced command");
  assert.equal(registryPortLeaks("| Docker | `docker run -p 7431:7431 img` | note |").length, 1, "a table cell");
  assert.equal(registryPortLeaks('    ports: ["7431:7431"]').length, 1, "a compose mapping");
  assert.equal(
    registryPortLeaks('docker run --publish="$PORT:7431" img').length,
    1,
    "a host port from a variable is still a publication, and one that names no address is still every interface",
  );
  assert.equal(registryPortLeaks('docker run -p "127.0.0.1:$PORT:7431" img').length, 0, "a loopback-bound variable host port");
});

test("no shipped instruction publishes the registry port off the loopback", () => {
  const offenders: string[] = [];
  for (const file of SCANNED) {
    for (const p of registryPortLeaks(read(file))) {
      offenders.push(
        `${file}: \`-p ${p.spec}\` — ${p.hostAddr === null ? "no host address, so every interface this host has" : `bound to ${p.hostAddr}`}`,
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these publish the registry's plain-HTTP listener past the loopback; the §9.1 bootstrap token and every Bearer API key cross it in the clear:\n  ${offenders.join("\n  ")}`,
  );
});

test("no shipped instruction publishes ANY port of a skillonomia container off the loopback", () => {
  // The rule above is pinned to 7431. `SKILLONOMIA_PORT` can move the listener,
  // and a command that publishes the moved port is the same command. So: every
  // `docker run` of this image, whatever it publishes, publishes to the
  // loopback — or publishes nothing, which is the external topology.
  const offenders: string[] = [];
  for (const file of SCANNED) {
    const text = read(file).replace(/\\\n\s*/g, " "); // join line continuations
    for (const line of text.split("\n")) {
      if (!/docker\s+run\b/.test(line) || !/skillonomia/.test(line)) continue;
      if (/(?:^|\s)(?:-P|--publish-all)(?:\s|$)/.test(line)) {
        offenders.push(`${file}: \`-P\` publishes every EXPOSEd port on every interface — ${line.trim()}`);
      }
      for (const p of publishesIn(line).filter(isExternal)) {
        offenders.push(`${file}: \`-p ${p.spec}\` on a skillonomia container — ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}`);
});

test("the local Docker probe exists, is loopback-bound, and is labelled local", () => {
  // The positive control. The point of this file is not "delete the docker
  // command" — it is that the command a reader copies is the safe one, in a
  // section that says what it is and where the other path is.
  const readme = read("README.md");
  const block = docBlock(readme, "docker");
  assert.match(block, /^docker build -t skillonomia:local \.$/m, "the image is built from this repository, never pulled");

  const run = /^docker run .*$/m.exec(block)?.[0];
  assert.ok(run, "the Docker quickstart must still show a `docker run`");
  const published = publishesIn(run);
  assert.equal(published.length, 1, `the local probe publishes exactly one port, found ${published.length}`);
  assert.deepEqual(
    { hostAddr: published[0].hostAddr, containerPort: published[0].containerPort },
    { hostAddr: "127.0.0.1", containerPort: REGISTRY_PORT },
    "the local probe must name the loopback explicitly: an unaddressed `-p` is every interface",
  );

  // and the same command with the address dropped — the candidate's line — is
  // caught by the very check that just passed it
  assert.equal(
    registryPortLeaks(run.replace("127.0.0.1:", "")).length,
    1,
    "the check must reject this exact command once the host address is removed, or it is proving nothing",
  );

  const sec = sectionOf(readme, /Docker/i);
  assert.match(flat(sec.body), /\bloopback\b/i, "the section must say the publish is loopback-bound");
  assert.match(
    flat(sec.body),
    /not a way to serve another host/i,
    "the section must say what this is NOT, in words a reader cannot mistake for a deployment",
  );
  assert.match(flat(sec.body), /TLS-terminating/, "the section must point at the one path that does serve another host");
});

test("every section that publishes the registry port states the loopback rule and the TLS path", () => {
  // A safe command in a section that explains nothing teaches the reader that
  // the address is noise, and the next reader drops it.
  for (const doc of OPERATOR_DOCS) {
    for (const sec of sections(read(doc))) {
      const publishes = publishesIn(sec.body).some((p) => p.containerPort === REGISTRY_PORT);
      if (!publishes) continue;
      assert.match(flat(sec.body), /\bloopback\b/i, `${doc} → "${sec.heading}" publishes the registry port without stating the loopback rule`);
      assert.match(
        flat(sec.body),
        /TLS-terminating/,
        `${doc} → "${sec.heading}" publishes the registry port without naming the only supported external path`,
      );
    }
  }
});

test("the documented external path terminates TLS and publishes no registry port", () => {
  const readme = read("README.md");
  const ext = sectionOf(readme, /another host/i);
  assert.match(flat(ext.body), /TLS-terminating/, "the external section must name a TLS-terminating proxy");
  assert.equal(
    publishesIn(ext.body).filter((p) => p.containerPort === REGISTRY_PORT).length,
    0,
    "the external topology must not publish the registry port at all — not even on the loopback, which would only invite a firewall rule in place of a boundary",
  );
  const proxyPorts = publishesIn(ext.body).map((p) => p.containerPort);
  assert.ok(proxyPorts.includes("443"), `the only published port in the external topology is the proxy's 443, found [${proxyPorts.join(", ")}]`);
  assert.match(flat(ext.body), /publishes \*\*NO\*\* port|publishes no port/i, "the external topology must say, in the example itself, that the registry publishes nothing");

  const ops = read("docs/OPERATIONS.md");
  const container = sectionOf(ops, /container: two decisions/i);
  assert.match(flat(container.body), /TLS-terminating/);
  assert.match(
    flat(container.body),
    /not supported for external access/i,
    "OPERATIONS must refuse the unaddressed publish in normative words, not describe it neutrally",
  );
  assert.match(
    flat(container.body),
    /not a TLS boundary and not a permission boundary/i,
    "OPERATIONS must say what the container's own `0.0.0.0` bind is NOT",
  );
  assert.match(
    flat(container.body),
    /publishes \*\*no\*\* port|publishes no port/i,
    "OPERATIONS must state the external topology as: the registry publishes nothing",
  );
  assert.match(
    flat(container.body),
    /HEALTHCHECK/,
    "OPERATIONS must keep the in-container liveness probe on 127.0.0.1 attached to this explanation",
  );
});

test("the container path is parsed as strictly as the from-source path — no exemptions", () => {
  // The failure this file exists to prevent was not a missing rule, it was a
  // carve-out: the shipped path was reasoned about instead of checked. So the
  // corpus is asserted as a corpus.
  const readme = read("README.md");
  for (const name of ["serve", "docker"]) {
    assert.ok(docBlock(readme, name).length > 0, `the README's \`${name}\` block must be extractable and checked like any other`);
  }
  for (const required of ["README.md", "docs/OPERATIONS.md", "Dockerfile", "ci/quickstart-docker.sh"]) {
    assert.ok(SCANNED.includes(required), `${required} carries the shipped Docker path and must be in the scan`);
  }

  // Nothing may leave the scan quietly: every markdown file this repository
  // keeps at the root or under docs/ is either scanned or named, with its
  // reason, in NOT_INSTRUCTIONS.
  const allMarkdown = [
    ...readdirSync(ROOT).filter((f) => f.endsWith(".md")),
    ...readdirSync(join(ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/${f}`),
  ];
  for (const file of allMarkdown) {
    const known = SCANNED.includes(file) || file in NOT_INSTRUCTIONS;
    assert.ok(known, `${file} is neither scanned nor listed as "not an instruction" — decide which, in this file`);
  }
  for (const [file, why] of Object.entries(NOT_INSTRUCTIONS)) {
    assert.ok(allMarkdown.includes(file), `NOT_INSTRUCTIONS names ${file}, which no longer exists — a stale exemption is a hole`);
    assert.ok(why.length > 20, `${file}'s exemption must carry a reason a reviewer can disagree with`);
  }
});

test("the image still binds outward INSIDE the container, and probes liveness on the loopback", () => {
  // Both halves are load-bearing and they are not in tension: a loopback bind
  // inside a container is unreachable through a proxy, and the healthcheck runs
  // in the same namespace as the process it is checking.
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /SKILLONOMIA_HOST=0\.0\.0\.0/, "the image sets the outward bind itself; without it, the proxy topology cannot reach the registry");
  assert.match(dockerfile, /EXPOSE 7431/);
  assert.match(
    dockerfile,
    /HEALTHCHECK[\s\S]*?http:\/\/127\.0\.0\.1:/,
    "the in-container liveness probe stays on 127.0.0.1 — it needs no network",
  );
  assert.equal(
    registryPortLeaks(dockerfile).length,
    0,
    "the image's own comments must not advertise a publish this repository refuses to document",
  );
});
