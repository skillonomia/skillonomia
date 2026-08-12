// §6 error model / Appendix H error envelope. Every surface failure is an
// ApiError with a typed code; adapters serialize it as
// {"error":{"code","message","current_state"?}} and map the HTTP status here.
//
// Appendix H fixes the code set as INVALID_SCHEMA | FORBIDDEN | NOT_FOUND |
// CONFLICT | PRECONDITION_FAILED | RATE_LIMITED | UNKNOWN_KEY | BAD_SIGNATURE |
// TAMPERED_CONTENT | MALFORMED_ARCHIVE | LIMIT_EXCEEDED. UNAUTHORIZED is the
// one addition: it covers AuthN failure (missing/unknown/revoked Bearer key),
// which happens before any surface contract applies — the H list enumerates
// surface errors of authenticated calls.
//
// NOT_IMPLEMENTED is the second, and it exists because §5.4 declares a
// recipient type this version does not carry out. The refusal it names is not
// any of the others and must not be dressed as one: `FORBIDDEN` would say the
// caller lacks permission when the caller's grant is satisfied and the
// TRANSPORT is what is missing — which is exactly the distinction the transfer
// model exists to keep, and the one a V-2 ambassador's operator has to be able
// to read. `INVALID_SCHEMA` would say the request was malformed when it was
// well-formed and accepted by every validator. So the honest answer is its own
// code, mapped to 501: the registry understood the request and does not
// implement it yet.
//
// The list is a RUNTIME constant and the type is derived from it, so a guard
// test can compare the code space against the one §6 and Appendix H publish.
// A type alone cannot be enumerated at run time, and an error space that only
// the compiler knows about is exactly what drifted from the specification.
import { isRefusedText } from "./outcome.ts";

export const ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "INVALID_SCHEMA",
  "RATE_LIMITED",
  "UNKNOWN_KEY",
  "BAD_SIGNATURE",
  "TAMPERED_CONTENT",
  "MALFORMED_ARCHIVE",
  "LIMIT_EXCEEDED",
  "NOT_IMPLEMENTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  INVALID_SCHEMA: 400,
  RATE_LIMITED: 429,
  UNKNOWN_KEY: 400,
  BAD_SIGNATURE: 400,
  TAMPERED_CONTENT: 400,
  MALFORMED_ARCHIVE: 400,
  LIMIT_EXCEEDED: 413,
  NOT_IMPLEMENTED: 501,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    current_state?: string;
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly current_state?: string;

  constructor(code: ErrorCode, message: string, currentState?: string) {
    super(`${code}: ${message}`);
    this.code = code;
    // Appendix H: PRECONDITION_FAILED/CONFLICT MUST include current_state so
    // callers can converge (defect #1). Enforced here, not left to call sites.
    if (code === "PRECONDITION_FAILED" || code === "CONFLICT") {
      if (currentState === undefined) {
        throw new Error(`${code} requires current_state (Appendix H converging-conflict rule)`);
      }
      this.current_state = currentState;
    } else if (currentState !== undefined) {
      this.current_state = currentState;
    }
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope["error"] = { code: this.code, message: this.message };
    if (this.current_state !== undefined) error.current_state = this.current_state;
    return { error };
  }
}

/**
 * Converging-conflict result (§6, defect #1 regression): transitioning a
 * resource into the state it already holds is a noop that reports the current
 * state — never an error a retry loop can get stuck on.
 */
export interface Converged {
  noop: true;
  state: string;
}

export function converged(state: string): Converged {
  return { noop: true, state };
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/**
 * THE ONE PLACE A SURFACE TURNS A FAILURE INTO AN ANSWER — and why there is one
 * rather than a translation at each place a rule is asked.
 *
 * Every adapter used to end with `if (isApiError(e)) return errorResponse(e);
 * throw e;`. Anything else — including a `RefusedText`, which is a plain
 * statement that the CALLER sent a string this registry cannot carry — left the
 * router and reached the client as `500 INTERNAL`. That happened with a
 * revocation `reason` holding an unpaired surrogate: the request satisfied every
 * rule the surface publishes, `jcsCanonicalize` refused it deep inside the
 * transaction, and the answer was "internal error".
 *
 * The boundaries still translate — `createPrincipal` and `validateIdempotencyKey`
 * name the FIELD, which is what a caller needs. This is the backstop under them,
 * so that a path nobody has annotated answers `INVALID_SCHEMA` rather than 500:
 * the property is a fact about the class of failure and about the single exit of
 * each adapter, not about anyone having remembered.
 */
export function asApiError(e: unknown): ApiError | undefined {
  if (e instanceof ApiError) return e;
  if (isRefusedText(e)) return new ApiError("INVALID_SCHEMA", e.message);
  return undefined;
}
