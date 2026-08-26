// P1 — THE NEGATIVE PROBES, AND THE PROOF THAT EACH ONE MEASURES ITS OWN GUARD.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `v1p1-p1-lifecycle.test.ts`.
//
//   That file asserts that a bad lifecycle call is refused. This one asserts
//   WHY it is refused. A negative probe that would be green with or without the
//   code it names proves nothing: if the call fails for some OTHER reason — a
//   foreign key, a trigger, an unrelated precondition earlier in the method —
//   the probe passes and the guard could be deleted tomorrow without a single
//   test turning red. P0 met the same problem with migration triggers and
//   answered it by running every illegal statement TWICE, once against the
//   migrated schema and once against the baseline, and printing the pair.
//
//   The guards this phase adds are service-layer conditions rather than
//   triggers, so the baseline they are run against is built here: the shipped
//   source with EXACTLY ONE RULE NEUTRALISED, loaded as a second module and
//   driven through the same fixture. A probe is discriminating when the shipped
//   registry refuses it and the neutralised one does not. `[P1.D]` prints that
//   pair for every rule, and a probe that cannot show the pair fails.
//
//   THE MUTATION IS OF THE SHIPPED TEXT, not of a copy kept beside it. Each
//   probe names a substring that must occur exactly once in `src/service.ts` or
//   `src/idempotency.ts`; a guard that is rewritten or moved makes the probe
//   fail loudly rather than quietly stop discriminating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { p4Fixture, publishedVersion, verifiableVersion, type P4Fixture } from "./p4-helpers.ts";
import { ERROR_CODES } from "../src/errors.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** Where the P1 gate manifest expects this run's evidence. Appended to, never
 *  truncated: a probe log a later run silently replaces is a log that cannot be
 *  compared with the one the reviewer read. */
const EVIDENCE_LOG = join(ROOT, "evidence", "P1", "lifecycle-probe.log");
function record(line: string): void {
  try {
    mkdirSync(dirname(EVIDENCE_LOG), { recursive: true });
    appendFileSync(EVIDENCE_LOG, `${line}\n`);
  } catch {
    // The log is evidence, not a dependency: a read-only checkout still runs
    // every assertion below. What must not happen is a probe passing because
    // the log could not be written.
  }
}

/**
 * Load `src/service.ts` (and the `src/idempotency.ts` it sits on) with one
 * substring replaced, as a module of its own.
 *
 * The imports are rewritten to ABSOLUTE paths into the real `src/`, so every
 * module but the one or two being mutated resolves to the instance the shipped
 * registry already loaded. Nothing is written into `src/` — a second `.ts` file
 * there would be a source file `git ls-files` does not know about, which
 * `test/p14-r13-probes.test.ts` refuses on sight.
 */
async function mutatedRegistry(
  edits: Array<{ file: "service.ts" | "idempotency.ts"; find: string; replace: string }>,
): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "skillonomia-probe-"));
  const idemPath = join(dir, "idempotency.ts");
  const rewrite = (text: string, self: Record<string, string>): string =>
    text.replace(/from "\.\/([A-Za-z0-9_.-]+\.ts)"/g, (_m, name: string) =>
      `from "${(self[name] ?? join(SRC, name)).replace(/\\/g, "/")}"`,
    );
  const apply = (text: string, file: string): string => {
    for (const e of edits.filter((x) => x.file === file)) {
      const n = text.split(e.find).length - 1;
      assert.equal(n, 1, `the probe's anchor occurs ${n} times in src/${file}, not once: ${e.find}`);
      text = text.replace(e.find, e.replace);
    }
    return text;
  };
  writeFileSync(idemPath, rewrite(apply(readFileSync(join(SRC, "idempotency.ts"), "utf8"), "idempotency.ts"), {}));
  const servicePath = join(dir, "service.ts");
  writeFileSync(
    servicePath,
    rewrite(apply(readFileSync(join(SRC, "service.ts"), "utf8"), "service.ts"), { "idempotency.ts": idemPath }),
  );
  return await import(pathToFileURL(servicePath).href);
}

/** The outcome of one call, reduced to what a probe compares. */
type Outcome = { refused: string } | { accepted: true };

/**
 * The refusal is read as its PUBLIC CODE and not by class identity.
 *
 * A mutated module is a second instance of `src/errors.ts` as far as the
 * loader is concerned, so `isApiError` — which is `instanceof` — answers false
 * for an error the mutated registry raised even though it is the same error.
 * Comparing the code rather than the constructor is not a workaround around a
 * weaker check: `ERROR_CODES` is what §6's error model actually promises a
 * caller, and it is the thing these probes are about.
 */
function attempt(fn: () => unknown): Outcome {
  try {
    fn();
    return { accepted: true };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && ERROR_CODES.includes(code as never)) return { refused: code };
    return { refused: `THROWN:${String((e as Error).message).slice(0, 60)}` };
  }
}

/**
 * Run one probe against the shipped registry and against a registry with its
 * guard neutralised, and require the two to DISAGREE.
 *
 * The shipped side must refuse with the stated code. The neutralised side must
 * do something else — accept, or fail with a different code. If both refuse
 * identically the probe is measuring something other than the guard it names,
 * and this fails rather than reporting a green that means nothing.
 */
async function discriminate(opts: {
  id: string;
  rule: string;
  code: string;
  edits: Array<{ file: "service.ts" | "idempotency.ts"; find: string; replace: string }>;
  /** Build the fixture and return the call to probe. Called twice — once per
   *  registry — against a FRESH database each time, so neither side observes
   *  the other's writes. */
  probe: (fx: P4Fixture) => () => unknown;
  /** Construct the registry class under test over an existing fixture. */
}): Promise<void> {
  const shippedFx = p4Fixture();
  const shipped = attempt(opts.probe(shippedFx));
  shippedFx.db.close();

  const mod = await mutatedRegistry(opts.edits);
  const mutatedFx = p4Fixture();
  (mutatedFx as any).registry = new mod.Registry(mutatedFx.db, {
    now: () => mutatedFx.seed.now,
    evidencePrincipals: mutatedFx.evidencePrincipals,
  });
  const neutralised = attempt(opts.probe(mutatedFx));
  mutatedFx.db.close();

  assert.deepEqual(shipped, { refused: opts.code }, `${opts.id}: the shipped registry did not refuse with ${opts.code}`);
  assert.notDeepEqual(
    neutralised,
    shipped,
    `${opts.id}: the probe is refused identically with the guard removed, so it does not measure the guard`,
  );
  const outcome = "accepted" in neutralised ? "accepted" : neutralised.refused;
  record(`[P1.D] ${opts.id}  refused:${opts.code}  guard-removed:${outcome}  ${opts.rule}`);
}

/** A published predecessor and a verified successor of the same skill. */
function pair(fx: P4Fixture, slug: string) {
  const predecessor = publishedVersion(fx, slug);
  const successor = verifiableVersion(fx, slug, {
    skill_id: predecessor.skillId,
    semver: "2.0.0",
    manifest: { skill_id: predecessor.skillId },
  });
  fx.registry.verifyVersion(fx.owner, successor.versionId);
  return { predecessor, successor };
}

// ===========================================================================
// The probes
// ===========================================================================

test("[P1.D1] a revocation reason is immutable once written", async () => {
  await discriminate({
    id: "P1.R1",
    rule: "a revocation reason is immutable once written",
    code: "CONFLICT",
    edits: [
      {
        file: "service.ts",
        find: "if (row.revocation_reason !== accepted.reason) {",
        replace: "if (false) {",
      },
    ],
    probe: (fx) => {
      const v = publishedVersion(fx, "probe-reason");
      fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "first" });
      return () => fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "second" });
    },
  });
});

test("[P1.D2] a predecessor that already names a successor refuses a different one, on surface 11", async () => {
  await discriminate({
    id: "P1.R2",
    rule: "one successor per predecessor, asked by `skill.revoke`",
    code: "CONFLICT",
    edits: [
      {
        file: "service.ts",
        find: 'if (existing !== requested) {\n          throw new ApiError("CONFLICT", "this version already names a different successor", existing);',
        replace: 'if (false) {\n          throw new ApiError("CONFLICT", "this version already names a different successor", existing);',
      },
    ],
    probe: (fx) => {
      const { predecessor, successor } = pair(fx, "probe-revoke-link");
      const other = verifiableVersion(fx, "probe-revoke-link", {
        skill_id: predecessor.skillId,
        semver: "3.0.0",
        manifest: { skill_id: predecessor.skillId },
      });
      fx.registry.verifyVersion(fx.owner, other.versionId);
      fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
        reason: "r",
        successor_version_id: successor.versionId,
      });
      return () =>
        fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
          reason: "r",
          successor_version_id: other.versionId,
        });
    },
  });
});

test("[P1.D3] the same refusal on surface 10", async () => {
  await discriminate({
    id: "P1.R3",
    rule: "one successor per predecessor, asked by `skill.supersede`",
    code: "CONFLICT",
    edits: [
      {
        file: "service.ts",
        find: "      if (existing !== successorId) {",
        replace: "      if (false) {",
      },
    ],
    probe: (fx) => {
      const { predecessor, successor } = pair(fx, "probe-sup-link");
      const other = verifiableVersion(fx, "probe-sup-link", {
        skill_id: predecessor.skillId,
        semver: "3.0.0",
        manifest: { skill_id: predecessor.skillId },
      });
      fx.registry.verifyVersion(fx.owner, other.versionId);
      fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: successor.versionId });
      return () => fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: other.versionId });
    },
  });
});

test("[P1.D4] a version that never reached `published` cannot be revoked", async () => {
  await discriminate({
    id: "P1.R4",
    rule: "only a released state may be revoked",
    code: "PRECONDITION_FAILED",
    edits: [
      {
        file: "service.ts",
        find: "} else if (!REVOCABLE_STATES.includes(row.state)) {",
        replace: "} else if (false) {",
      },
    ],
    probe: (fx) => {
      const v = verifiableVersion(fx, "probe-unreleased", {});
      fx.registry.verifyVersion(fx.owner, v.versionId);
      return () => fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "too early" });
    },
  });
});

test("[P1.D5] a version that never reached `published` may hold no successor link", async () => {
  await discriminate({
    id: "P1.R5",
    rule: "a successor link belongs to a released version",
    code: "PRECONDITION_FAILED",
    edits: [
      {
        file: "service.ts",
        find: "    if (!isLineageLinkableState(row.state)) {",
        replace: "    if (false) {",
      },
    ],
    probe: (fx) => {
      const { predecessor, successor } = pair(fx, "probe-unreleased-link");
      // the SUCCESSOR is `verified`, so it may not itself be given a successor
      return () =>
        fx.registry.supersedeVersion(fx.owner, successor.versionId, { successor_version_id: predecessor.versionId });
    },
  });
});

test("[P1.D6] a successor has itself reached `verified` when the link is created", async () => {
  await discriminate({
    id: "P1.R6",
    rule: "a successor has itself reached `verified` or `published` at link creation",
    code: "PRECONDITION_FAILED",
    // TWO ANCHORS, ONE RULE. Eligibility is asked twice in the same method —
    // once of the snapshot the caller loaded and once of the row re-read inside
    // the transaction — because a successor may be retired between the two.
    // Neutralising the rule means neutralising both; leaving the second in
    // place would make this probe report that the FIRST is load-bearing when it
    // is the pair that is.
    edits: [
      {
        file: "service.ts",
        find: "    if (!isSuccessorEligibleState(successor.state)) {",
        replace: "    if (false) {",
      },
      {
        file: "service.ts",
        find: "    if (!fresh || !isSuccessorEligibleState(fresh.state)) {",
        replace: "    if (!fresh) {",
      },
    ],
    probe: (fx) => {
      const predecessor = publishedVersion(fx, "probe-successor-state");
      const draft = verifiableVersion(fx, "probe-successor-state", {
        skill_id: predecessor.skillId,
        semver: "2.0.0",
        manifest: { skill_id: predecessor.skillId },
      });
      // deliberately NOT verified
      return () =>
        fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
          reason: "r",
          successor_version_id: draft.versionId,
        });
    },
  });
});

test("[P1.D7] predecessor and successor belong to one skill", async () => {
  await discriminate({
    id: "P1.R7",
    rule: "predecessor and successor belong to one skill",
    code: "INVALID_SCHEMA",
    edits: [
      {
        file: "service.ts",
        find: "    if (successor.skill_id !== row.skill_id) {",
        replace: "    if (false) {",
      },
    ],
    probe: (fx) => {
      const predecessor = publishedVersion(fx, "probe-cross-a");
      const stranger = verifiableVersion(fx, "probe-cross-b", {});
      fx.registry.verifyVersion(fx.owner, stranger.versionId);
      return () =>
        fx.registry.revokeVersion(fx.owner, predecessor.versionId, {
          reason: "r",
          successor_version_id: stranger.versionId,
        });
    },
  });
});

test("[P1.D8] a version is not its own successor", async () => {
  await discriminate({
    id: "P1.R8",
    rule: "a version is not its own successor",
    code: "INVALID_SCHEMA",
    edits: [
      {
        file: "service.ts",
        find: 'if (successorId === row.id) throw new ApiError("INVALID_SCHEMA", "a version cannot supersede itself");',
        replace: "if (false) throw new ApiError(\"INVALID_SCHEMA\", \"a version cannot supersede itself\");",
      },
    ],
    probe: (fx) => {
      const v = publishedVersion(fx, "probe-self-link");
      return () =>
        fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "r", successor_version_id: v.versionId });
    },
  });
});

test("[P1.D9] one idempotency key names one request", async () => {
  await discriminate({
    id: "P1.R9",
    rule: "the same key carrying a different payload is refused, not replayed",
    code: "CONFLICT",
    edits: [
      {
        file: "idempotency.ts",
        find: "  if (row.request_digest !== requestDigest) {",
        replace: "  if (false) {",
      },
    ],
    probe: (fx) => {
      const v = publishedVersion(fx, "probe-digest");
      const other = publishedVersion(fx, "probe-digest-other");
      fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "first" }, "kd");
      return () => fx.registry.revokeVersion(fx.owner, other.versionId, { reason: "second" }, "kd");
    },
  });
});

test("[P1.D10] a legacy row carrying no digest is not a mismatch — the guard proved by its removal", async () => {
  // THE ONE PROBE READ IN THE OTHER DIRECTION. Every rule above is a refusal
  // and its discrimination is "the guard's removal admits it". This rule is an
  // ADMISSION — INV-09's promise that a released deployment's existing keys keep
  // working — so its discrimination is the mirror: with the NULL case removed,
  // the legacy replay becomes the `409` on first retry that the promise forbids.
  const legacyBody = JSON.stringify({ state: "revoked", reason: "written by v1.0.0" });
  const seedLegacy = (fx: P4Fixture, versionId: string): void => {
    fx.db
      .prepare(
        "INSERT INTO idempotency_keys(id, actor_agent_id, surface, key, response_json, created_at_ms) VALUES (?,?,?,?,?,?)",
      )
      .run("01LEGACYLEGACYLEGACYLEGACY", fx.owner.agent_id, "skill.revoke", "legacy", legacyBody, fx.seed.now);
    assert.ok(versionId);
  };

  const shippedFx = p4Fixture();
  const v1 = publishedVersion(shippedFx, "probe-legacy");
  seedLegacy(shippedFx, v1.versionId);
  const shipped = attempt(() => shippedFx.registry.revokeVersion(shippedFx.owner, v1.versionId, { reason: "x" }, "legacy"));
  assert.deepEqual(shipped, { accepted: true }, "a v1.0.0 key stopped replaying");
  shippedFx.db.close();

  const mod = await mutatedRegistry([
    {
      file: "idempotency.ts",
      find: "  if (requestDigest === undefined || row.request_digest === null) return;",
      replace: "  if (requestDigest === undefined) return;",
    },
  ]);
  const mutatedFx = p4Fixture();
  (mutatedFx as any).registry = new mod.Registry(mutatedFx.db, {
    now: () => mutatedFx.seed.now,
    evidencePrincipals: mutatedFx.evidencePrincipals,
  });
  const v2 = publishedVersion(mutatedFx, "probe-legacy");
  seedLegacy(mutatedFx, v2.versionId);
  const neutralised = attempt(() => mutatedFx.registry.revokeVersion(mutatedFx.owner, v2.versionId, { reason: "x" }, "legacy"));
  mutatedFx.db.close();

  assert.deepEqual(neutralised, { refused: "CONFLICT" }, "the NULL case is not what makes the legacy replay work");
  record("[P1.D] P1.R10  replayed:v1.0-row  guard-removed:CONFLICT  a legacy idempotency row with no digest is not a mismatch");
});

test("[P1.D11] the outer transaction is what makes a fault leave nothing behind", async () => {
  // The gate this packet turns on, run as a discrimination rather than as a
  // happy path. `[P1.L9]` asserts that an injected fault leaves no partial
  // state; this asserts that the OUTER TRANSACTION is why. With `revokeVersion`
  // wired to the self-transacting wrapper instead — which is exactly the
  // arrangement v1.0.0 shipped — the identical fault commits the state change,
  // the reason, the log entry and the notice, and leaves the retry to compile a
  // second revocation against a key that was never written.
  const inject = (fx: P4Fixture, body: () => unknown): Outcome => {
    const real = fx.db.prepare.bind(fx.db);
    (fx.db as any).prepare = (sql: string) => {
      const st = real(sql);
      if (!sql.includes("INSERT INTO idempotency_keys")) return st;
      return {
        get: (...p: unknown[]) => st.get(...p),
        all: (...p: unknown[]) => st.all(...p),
        run: () => {
          throw new Error("injected");
        },
      };
    };
    try {
      return attempt(body);
    } finally {
      (fx.db as any).prepare = real;
    }
  };
  const stateAfter = (fx: P4Fixture, id: string): string =>
    (fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(id) as { state: string }).state;

  const shippedFx = p4Fixture();
  const a = publishedVersion(shippedFx, "probe-atomic");
  inject(shippedFx, () => shippedFx.registry.revokeVersion(shippedFx.owner, a.versionId, { reason: "r" }, "ka"));
  assert.equal(stateAfter(shippedFx, a.versionId), "published", "the shipped path left the revocation committed");
  shippedFx.db.close();

  const mod = await mutatedRegistry([
    {
      file: "service.ts",
      find: "    return withIdempotencyInTx(\n      this.db,\n      auth.agent_id,\n      \"skill.revoke\",",
      replace: "    return withIdempotency(\n      this.db,\n      auth.agent_id,\n      \"skill.revoke\",",
    },
  ]);
  const mutatedFx = p4Fixture();
  (mutatedFx as any).registry = new mod.Registry(mutatedFx.db, {
    now: () => mutatedFx.seed.now,
    evidencePrincipals: mutatedFx.evidencePrincipals,
  });
  const b = publishedVersion(mutatedFx, "probe-atomic");
  inject(mutatedFx, () => mutatedFx.registry.revokeVersion(mutatedFx.owner, b.versionId, { reason: "r" }, "ka"));
  const leaked = stateAfter(mutatedFx, b.versionId);
  mutatedFx.db.close();

  assert.equal(leaked, "revoked", "the outer transaction is not what holds the domain write");
  record(
    "[P1.D] P1.R11  fault-leaves:nothing  guard-removed:state=revoked-with-no-key  the outer BEGIN IMMEDIATE is what makes the revoke atomic",
  );
});
