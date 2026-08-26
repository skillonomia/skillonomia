#!/usr/bin/env python3
"""An INDEPENDENT validator for the signing conformance fixture.

WHAT "INDEPENDENT" MEANS HERE, because a second implementation that calls the
first proves nothing at all. This file imports NOTHING from this repository and
nothing from outside the Python standard library. JCS canonicalization, the
SHA-256 chain, the protected-header bytes, the detached-JWS grammar and Ed25519
itself are all re-derived here from RFC 8785, RFC 8032 and SPEC.md's §4.3 prose.
It does not read `src/signing.ts`, does not shell out to node, and does not
install a package. The only thing it shares with the TypeScript producer is the
fixture file and the specification both were written against.

That constraint is why Ed25519 is spelled out below rather than imported: the
interpreters this runs on carry no Ed25519 in the standard library, and pulling
in `cryptography` would swap one dependency for another while adding a network
fetch this build is not allowed to make.

Usage:

    python3 fixtures/signing-conformance/validate.py [path/to/fixture.json]

Exit 0 and a JSON report on stdout when every field and every verdict agrees.
Exit 1 and the disagreement on stdout otherwise. A validator that cannot read
its subject exits 2 rather than reporting a clean run.
"""

import base64
import hashlib
import json
import sys
import unicodedata  # noqa: F401  (kept: JCS is defined over Unicode strings)

# ---------------------------------------------------------------- Ed25519
#
# RFC 8032 section 5.1, the reference formulation, over the twisted Edwards curve
# -x^2 + y^2 = 1 + d x^2 y^2 mod 2^255 - 19.

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
I = pow(2, (P - 1) // 4, P)


def _recover_x(y: int, sign: int):
    """The x that goes with a compressed y, or None when there is none."""
    if y >= P:
        return None
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * I % P
    if (x * x - xx) % P != 0:
        return None
    if x % 2 != sign:
        x = P - x
    return x


# Extended homogeneous coordinates (X, Y, Z, T), RFC 8032 section 5.1.4.
BASE_Y = 4 * pow(5, P - 2, P) % P
BASE_X = _recover_x(BASE_Y, 0)
BASE = (BASE_X, BASE_Y, 1, BASE_X * BASE_Y % P)
IDENTITY = (0, 1, 1, 0)


def _add(a, b):
    ax, ay, az, at = a
    bx, by, bz, bt = b
    aa = (ay - ax) * (by - bx) % P
    bb = (ay + ax) * (by + bx) % P
    cc = 2 * at * bt * D % P
    dd = 2 * az * bz % P
    e, f, g, h = bb - aa, dd - cc, dd + cc, bb + aa
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(s: int, q):
    out = IDENTITY
    while s > 0:
        if s & 1:
            out = _add(out, q)
        q = _add(q, q)
        s >>= 1
    return out


def _compress(q) -> bytes:
    x, y, z, _ = q
    zi = pow(z, P - 2, P)
    x, y = x * zi % P, y * zi % P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _decompress(b: bytes):
    if len(b) != 32:
        return None
    y = int.from_bytes(b, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)


def ed25519_public_key(seed: bytes) -> bytes:
    """RFC 8032 section 5.1.5: the public key for a 32-byte seed."""
    h = bytearray(hashlib.sha512(seed).digest()[:32])
    h[0] &= 248
    h[31] &= 127
    h[31] |= 64
    return _compress(_mul(int.from_bytes(h, "little"), BASE))


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """RFC 8032 section 5.1.7. Returns False rather than raising on any malformed input."""
    if len(signature) != 64 or len(public_key) != 32:
        return False
    a = _decompress(public_key)
    r = _decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    k = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % L
    left = _mul(s, BASE)
    right = _add(r, _mul(k, a))
    return _compress(left) == _compress(right)


# -------------------------------------------------------------------- JCS
#
# RFC 8785. Two rules do the work: members are sorted by the UTF-16 code units
# of their names, and there is no insignificant whitespace anywhere.


class JcsUnsupported(Exception):
    """A value RFC 8785 covers and this validator declines to guess at."""


def _utf16_key(name: str):
    return tuple(name.encode("utf-16-be"))


def _jcs_string(value: str) -> str:
    out = ['"']
    for ch in value:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif code < 0x20:
            out.append("\\u%04x" % code)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _jcs_number(value) -> str:
    # The manifests this profile signs carry integers only. A non-integral
    # number needs ECMAScript's shortest-round-trip formatting, and GUESSING at
    # it would produce bytes that differ from the producer's in exactly the way
    # this fixture exists to detect. So it refuses instead.
    if isinstance(value, bool):
        raise JcsUnsupported("bool reached the number path")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return str(int(value))
    raise JcsUnsupported("non-integral number: ECMAScript number formatting is not re-derived here")


def jcs(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _jcs_string(value)
    if isinstance(value, (int, float)):
        return _jcs_number(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        names = sorted(value.keys(), key=_utf16_key)
        return "{" + ",".join(_jcs_string(n) + ":" + jcs(value[n]) for n in names) + "}"
    raise JcsUnsupported("value of type %s" % type(value).__name__)


# ------------------------------------------------------------- the profile

B64URL_ALPHABET = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64url_decode_strict(text: str):
    """Unpadded base64url only, and the encoding must be the canonical one."""
    if text == "" or any(ch not in B64URL_ALPHABET for ch in text):
        return None
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64url_encode(raw) != text:
        return None
    return raw


def protected_header_bytes(kid: str) -> bytes:
    """SPEC.md §4.3.4 fixes these bytes exactly: two members, in this order."""
    return ('{"alg":"EdDSA","kid":' + json.dumps(kid, ensure_ascii=False) + "}").encode("utf-8")


def verify_detached(manifest, jws: str, public_key_b64url: str) -> bool:
    if jws != jws.strip() or any(c.isspace() for c in jws):
        return False
    parts = jws.split(".")
    if len(parts) != 3 or parts[1] != "":
        return False
    header_raw = b64url_decode_strict(parts[0])
    if header_raw is None:
        return False
    try:
        header = json.loads(header_raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False
    if not isinstance(header, dict) or sorted(header.keys()) != ["alg", "kid"]:
        return False
    if header["alg"] != "EdDSA" or not isinstance(header["kid"], str):
        return False
    if header_raw != protected_header_bytes(header["kid"]):
        return False
    signature = b64url_decode_strict(parts[2])
    if signature is None or len(signature) != 64:
        return False
    public_key = b64url_decode_strict(public_key_b64url)
    if public_key is None or len(public_key) != 32:
        return False
    digest = hashlib.sha256(jcs(manifest).encode("utf-8")).digest()
    signing_input = (b64url_encode(header_raw) + "." + b64url_encode(digest)).encode("ascii")
    return ed25519_verify(public_key, signing_input, signature)


# ----------------------------------------------------------------- the run


def check(fixture) -> list:
    """Every disagreement between this implementation and the fixture."""
    wrong = []

    def same(field, mine, theirs):
        if mine != theirs:
            wrong.append({"field": field, "python": mine, "fixture": theirs})

    manifest = fixture["canonical_manifest"]
    canonical = jcs(manifest)
    raw = canonical.encode("utf-8")
    same("jcs_utf8", canonical, fixture["jcs_utf8"])
    same("jcs_bytes_hex", raw.hex(), fixture["jcs_bytes_hex"])
    same("jcs_byte_length", len(raw), fixture["jcs_byte_length"])

    digest = hashlib.sha256(raw).digest()
    same("sha256_bytes_hex", digest.hex(), fixture["sha256_bytes_hex"])
    same("sha256_hex", digest.hex(), fixture["sha256_hex"])

    header = protected_header_bytes(fixture["kid"])
    same("protected_header_utf8", header.decode("utf-8"), fixture["protected_header_utf8"])
    same("protected_header_bytes_hex", header.hex(), fixture["protected_header_bytes_hex"])

    signing_input = b64url_encode(header) + "." + b64url_encode(digest)
    same("signing_input", signing_input, fixture["signing_input"])

    seed = hashlib.sha256(fixture["seed_label"].encode("utf-8")).digest()
    same("public_key_b64url", b64url_encode(ed25519_public_key(seed)), fixture["public_key_b64url"])

    for case in fixture["cases"]:
        got = "valid" if verify_detached(manifest, case["jws"], case["public_key_b64url"]) else "invalid"
        if got != case["verdict"]:
            wrong.append({"field": "case:" + case["name"], "python": got, "fixture": case["verdict"]})
    return wrong


def main(argv) -> int:
    path = argv[1] if len(argv) > 1 else __file__.rsplit("/", 1)[0] + "/fixture.json"
    try:
        with open(path, "r", encoding="utf-8") as handle:
            fixture = json.load(handle)
    except (OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "refused": "the fixture could not be read: %s" % exc}))
        return 2
    try:
        wrong = check(fixture)
    except JcsUnsupported as exc:
        print(json.dumps({"ok": False, "refused": "this validator declines to guess: %s" % exc}))
        return 2
    report = {
        "ok": not wrong,
        "validator": "fixtures/signing-conformance/validate.py",
        "imports_production_code": False,
        "fields_compared": 9,
        "cases_compared": len(fixture["cases"]),
        "disagreements": wrong,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if not wrong else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
