// The default bind address is the LOOPBACK, and going wider is a decision
// somebody has to make out loud.
//
// WHY THIS IS A SECURITY BOUNDARY AND NOT A PREFERENCE. This service speaks
// plain HTTP; it terminates no TLS and it is not going to. Two kinds of
// credential cross that listener in the clear: the §9.1 one-time bootstrap
// token, printed once at first start and exchangeable by whoever presents it,
// and every API key thereafter, sent as a Bearer header on every call. A
// default of `0.0.0.0` publishes that surface on every interface the host has
// — including the one facing whatever network the host happens to be on — for
// an operator who typed nothing but `serve`. The safe direction is the one you
// have to ask for: bind the loopback by default, and make an external bind a
// thing an operator wrote down (`--host`, or `SKILLONOMIA_HOST`), so it is
// visible in the command line or the unit file that a reviewer reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type Instance } from "../src/server.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * Start a throwaway deployment. The environment is neutralised around the
 * call: `SKILLONOMIA_HOST` set in the shell that runs the suite would make
 * "what does a bare serve do" unanswerable.
 */
async function boundAddressOf(
  opts: Parameters<typeof serve>[0],
  env: string | undefined,
): Promise<string> {
  const before = process.env.SKILLONOMIA_HOST;
  if (env === undefined) delete process.env.SKILLONOMIA_HOST;
  else process.env.SKILLONOMIA_HOST = env;
  const dataDir = mkdtempSync(join(tmpdir(), "sklo-bind-"));
  let inst: Instance | null = null;
  try {
    inst = serve({ port: 0, dataDir, workerIntervalMs: 0, installSeedPackage: false, log: () => {}, ...opts });
    // `listen` is asynchronous: the socket has no address until it is bound,
    // and the address is the whole subject of this file
    if (inst.server.address() === null) await once(inst.server, "listening");
    const addr = inst.server.address();
    assert.ok(addr && typeof addr === "object", "the listener must have an address");
    return addr.address;
  } finally {
    inst?.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (before === undefined) delete process.env.SKILLONOMIA_HOST;
    else process.env.SKILLONOMIA_HOST = before;
  }
}

test("a bare serve binds the loopback and nothing else", async () => {
  assert.equal(
    await boundAddressOf({}, undefined),
    "127.0.0.1",
    "the default listener must not be reachable from off the host: bootstrap tokens and API keys cross it in the clear",
  );
});

test("an external bind is possible, and only on an explicit instruction", async () => {
  // the environment variable — how the container image asks for it
  assert.equal(await boundAddressOf({}, "0.0.0.0"), "0.0.0.0");
  // the flag — how an operator asks for it on the command line
  assert.equal(await boundAddressOf({ host: "0.0.0.0" }, undefined), "0.0.0.0");
});

test("an explicit option outranks the environment, which outranks the default", async () => {
  assert.equal(await boundAddressOf({ host: "127.0.0.1" }, "0.0.0.0"), "127.0.0.1", "--host wins over SKILLONOMIA_HOST");
  assert.equal(await boundAddressOf({}, "127.0.0.1"), "127.0.0.1");
});

test("the documents state the boundary, and state it as a boundary", () => {
  for (const doc of ["README.md", "docs/OPERATIONS.md"]) {
    const text = read(doc).replace(/\s+/g, " ");
    assert.ok(
      text.includes("`SKILLONOMIA_HOST` | `127.0.0.1`") || text.includes("`SKILLONOMIA_HOST` (`127.0.0.1`)"),
      `${doc} must publish 127.0.0.1 as the default bind address`,
    );
    assert.ok(
      /MUST NOT be reached over plain HTTP from another host/.test(text),
      `${doc} must state the TLS boundary in normative words, not as advice`,
    );
    assert.ok(
      /TLS-terminating (reverse )?proxy/.test(text),
      `${doc} must say what the only supported external path is`,
    );
    assert.doesNotMatch(
      text,
      /\b0\.0\.0\.0\b(?![^.]{0,400}?(proxy|loopback|TLS))/,
      `${doc} mentions 0.0.0.0 without the condition attached`,
    );
  }
});

test("no runnable block in the documents binds a non-loopback address", () => {
  for (const doc of ["README.md", "docs/OPERATIONS.md"]) {
    const blocks = [...read(doc).matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    for (const b of blocks) {
      assert.doesNotMatch(
        b,
        /--host\s+(?!127\.0\.0\.1\b|localhost\b|H\b)\S+/,
        `${doc}: a copy-pasteable block must not put the listener on a non-loopback address`,
      );
      assert.doesNotMatch(
        b,
        /SKILLONOMIA_HOST=(?!127\.0\.0\.1\b|localhost\b)\S+/,
        `${doc}: a copy-pasteable block must not set SKILLONOMIA_HOST to a non-loopback address`,
      );
    }
  }
});

test("the container image binds outward INSIDE the container — which settles nothing about the host", () => {
  // This test used to say the image's outward bind was "the operator's explicit
  // decision" and stop there. That sentence was doing work it had no right to
  // do: it read as a JUSTIFICATION, and under it the documents kept a
  // copy-pasteable `docker run` that published the registry on every interface
  // of the host. The bind and the publication are two different decisions, and
  // only the first one is this file's.
  //
  // What is asserted here is the first one, narrowly: the image binds outward
  // so that a proxy — or a loopback publish — can reach the process at all,
  // because a bind to the container's own loopback is reachable by nothing.
  // That bind is not a boundary; it neither terminates TLS nor checks a
  // permission. The boundary is where the port is published on the host, and
  // that is asserted, over every shipped instruction, in
  // `test/docker-network-boundary.test.ts`.
  const dockerfile = read("Dockerfile");
  assert.match(
    dockerfile,
    /SKILLONOMIA_HOST=0\.0\.0\.0/,
    "the image must set SKILLONOMIA_HOST itself: inside a container a loopback bind is unreachable through a publish or a proxy",
  );
  assert.match(dockerfile, /EXPOSE 7431/);
  assert.match(
    dockerfile,
    /HEALTHCHECK[\s\S]*?http:\/\/127\.0\.0\.1:/,
    "liveness is checked from inside the container, on the loopback, and needs no network",
  );
  // The pairing this file is not allowed to forget: the outward bind above is
  // acceptable ONLY because nothing shipped publishes that port off the
  // loopback. If that check ever disappears, this one stops being true.
  assert.ok(
    existsSync(join(ROOT, "test/docker-network-boundary.test.ts")),
    "the publication check must exist: without it, `SKILLONOMIA_HOST=0.0.0.0` in the image is an unchecked claim",
  );
});
