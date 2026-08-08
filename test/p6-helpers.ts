// P6 fixtures — everything the search/reputation/dashboard suites need, built
// ONLY through the real surfaces (P6 is about what the API computes and
// shows, so a fixture that wrote rows directly would prove nothing).
import { p4Fixture, reviewedVersion, goodEvidence, NOW, type P4Fixture, type BuiltVersion } from "./p4-helpers.ts";
import { handleRest, type RestResponse } from "../src/http.ts";
import type { AuthContext } from "../src/auth.ts";
import { isApiError } from "../src/errors.ts";

export { p4Fixture, reviewedVersion, goodEvidence, NOW };
export type { P4Fixture, BuiltVersion };

/** An environment descriptor that matches the TV-01 fixture manifest. */
export const ENV = {
  runtime: { id: "claude-code", version: "2.1.0" },
  model: { id: "any", version: "1.0.0" },
  tools: [{ id: "shell", version: "5.2.0" }],
  os: "linux",
  shell: "bash",
  sandbox_capable: true,
};

export function env(overrides: Record<string, unknown> = {}): any {
  return { ...JSON.parse(JSON.stringify(ENV)), ...overrides };
}

export function rest(
  fx: P4Fixture,
  method: string,
  url: string,
  key: string,
  body?: unknown,
): { status: number; headers: Record<string, string>; body: any; raw: string } {
  const res: RestResponse = handleRest(fx.registry, {
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"),
  });
  const isJson = (res.headers["Content-Type"] ?? "").startsWith("application/json");
  return { status: res.status, headers: res.headers, body: isJson ? JSON.parse(res.body) : null, raw: res.body };
}

export function mcp(fx: P4Fixture, key: string, name: string, args: any): { isError: boolean; data: any } {
  const res = rest(fx, "POST", "/mcp", key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = res.body.result;
  return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
}

export function rejects(fn: () => unknown, code: string, message?: RegExp): any {
  try {
    fn();
  } catch (e) {
    if (!isApiError(e)) throw e;
    if (e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
    if (message && !message.test(e.message)) throw new Error(`wrong message: ${e.message}`);
    return e;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** The API key of an actor in the p4 fixture cast. */
export function keyOf(fx: P4Fixture, who: keyof P4Fixture["keys"]): string {
  return fx.keys[who as string];
}

export interface AdoptionRun {
  requestId: string;
  receiptId: string;
  compat: { result: string; unmet: string[] };
}

/**
 * request_adoption → adopt → attempted → adopted, entirely through REST, with
 * evidence that validates against the version's declared `validation_gates`.
 * This is the ONLY way a P6 fixture produces an `adopted` receipt, which is
 * precisely what "Reputation only from server-validated receipts" means.
 */
export function adoptThroughSurfaces(
  fx: P4Fixture,
  v: BuiltVersion,
  adopterKey: string,
  opts: { descriptor?: any; terminal?: "adopted" | "failed" | "none"; evidence?: unknown } = {},
): AdoptionRun {
  const requested = rest(fx, "POST", "/v1/adoptions/requests", adopterKey, { skill_version_id: v.versionId });
  if (requested.status !== 201) throw new Error(`request_adoption failed: ${requested.raw}`);
  const { adoption_request_id: requestId, receipt_id: receiptId } = requested.body;

  const adopted = rest(fx, "POST", `/v1/adoptions/${requestId}/adopt`, adopterKey, {
    environment_descriptor: opts.descriptor ?? env(),
  });
  if (adopted.status !== 200) throw new Error(`adopt failed: ${adopted.raw}`);
  const compat = adopted.body.compat;

  const terminal = opts.terminal ?? "adopted";
  if (terminal === "none") return { requestId, receiptId, compat };

  const attempted = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, adopterKey, { event: "attempted" });
  if (attempted.status !== 200) throw new Error(`attempted failed: ${attempted.raw}`);

  const body =
    terminal === "adopted"
      ? { event: "adopted", evidence: opts.evidence ?? goodEvidence(v.manifest) }
      : { event: "failed", failure_report: { category: "gate_failed", summary: "the declared gate did not pass" } };
  const done = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, adopterKey, body);
  if (done.status !== 200) throw new Error(`${terminal} failed: ${done.raw}`);
  return { requestId, receiptId, compat };
}

/** Surface 9 — a rating is only accepted from an adopter holding an `adopted` receipt. */
export function rateThroughSurface(
  fx: P4Fixture,
  v: BuiltVersion,
  raterKey: string,
  receiptId: string,
  score: number,
): void {
  const res = rest(fx, "POST", `/v1/versions/${v.versionId}/ratings`, raterKey, {
    score,
    adoption_receipt_id: receiptId,
  });
  if (res.status !== 201) throw new Error(`rate failed: ${res.raw}`);
}

/** AuthContext ↔ key pairs of the cast, for tests that need both forms. */
export const CAST: Array<{ name: keyof P4Fixture & string; ctx: (fx: P4Fixture) => AuthContext }> = [
  { name: "owner", ctx: (fx) => fx.owner },
  { name: "admin", ctx: (fx) => fx.admin },
  { name: "member", ctx: (fx) => fx.member },
  { name: "outsider", ctx: (fx) => fx.outsider },
];
