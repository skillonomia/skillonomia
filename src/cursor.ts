// THE PAGINATION CURSOR, AS A CODEC BOTH SIDES SHARE.
//
// It lived inside `src/service.ts` as a pair of local functions. It is here
// because a SECOND reader needs it: `auditDashboardPayload` has to answer
// whether a `next_cursor` on a payload is an opaque machine token or a sentence
// somebody wrote, and the only honest way to answer that is to DECODE IT. A
// second implementation of the shape would be a guard agreeing with itself.
//
// The shape is deliberately small: base64url of `[created_at_ms, version_id]`.
// It is opaque to a client — Appendix H calls it "the opaque cursor to pass back
// as `?cursor=`" — and it is not opaque to this repository, which is what makes
// it checkable.

export interface Cursor {
  ms: number;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.ms, cursor.id]), "utf8").toString("base64url");
}

/**
 * The cursor a token encodes, or `null` when it encodes none.
 *
 * `null` covers every way a string can fail to be one: not base64url, not JSON,
 * not the two-member shape. A caller that needs an error raises its own — this
 * function answers a question and does not decide what to do about the answer.
 */
export function decodeCursor(token: string): Cursor | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) return null;
  if (typeof decoded[0] !== "number" || typeof decoded[1] !== "string") return null;
  return { ms: decoded[0], id: decoded[1] };
}
