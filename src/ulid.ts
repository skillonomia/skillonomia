// Monotonic ULID generator (Crockford base32, 26 chars).
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = ALPHABET[ms % 32] + s;
    ms = Math.floor(ms / 32);
  }
  return s;
}

function encodeRandom(): string {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i] % 32];
  return s;
}

let lastMs = 0;
let lastRand = "";

export function ulid(nowMs: number = Date.now()): string {
  if (nowMs === lastMs) {
    // increment the random tail to stay monotonic within one ms
    const chars = lastRand.split("");
    for (let i = chars.length - 1; i >= 0; i--) {
      const idx = ALPHABET.indexOf(chars[i]);
      if (idx < 31) {
        chars[i] = ALPHABET[idx + 1];
        break;
      }
      chars[i] = ALPHABET[0];
    }
    lastRand = chars.join("");
  } else {
    lastMs = nowMs;
    lastRand = encodeRandom();
  }
  return encodeTime(nowMs) + lastRand;
}
