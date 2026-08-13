#!/usr/bin/env bash
# The normative quickstart command sequence — the same scenario the README
# publishes and `test/readme-quickstart.test.ts` extracts — executed verbatim.
#
#   BASE_URL=http://localhost:7431 \
#   BOOTSTRAP_OWNER_TOKEN=bt_… DEMO_ADOPTER_TOKEN=sk_… ci/quickstart.sh
#
# Every step asserts the expectation the README prints next to it; the last one
# asserts the terminal `adopted` receipt. Anything unexpected exits non-zero.
# The transcript goes to stdout — CI archives it as ci/quickstart-transcript.txt.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:7431}"
: "${BOOTSTRAP_OWNER_TOKEN:?BOOTSTRAP_OWNER_TOKEN is required (printed at first start)}"
: "${DEMO_ADOPTER_TOKEN:?DEMO_ADOPTER_TOKEN is required (printed at first start)}"
H='Content-Type: application/json'
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A GATE THAT DIES OF A TRACEBACK HAS NOT REPORTED ANYTHING.
#
# `jqf` used to be `json.load(sys.stdin); print(<expr>)`. That reads a value
# where the answer is the shape it expects, and DIES OF PYTHON where it is not:
# an empty body, a proxy's plain-text 502, or a typed API error carrying no
# `api_key` all ended this gate with a JSONDecodeError or a KeyError naming
# python's internals — never the step, never what came back. The script owns a
# `fail()` that says both, and the parser was dying before reaching it.
#
# So the parser refuses in the script's own voice. Three answers are separated
# because they mean three different things to whoever reads the CI log: nothing
# arrived, something arrived that is not JSON, or JSON arrived without the field
# this step needs. The first 200 bytes of the body are shown for the same
# reason — a gate that says only "failed" sends its reader back to guessing.
step() { QS_STEP="$*"; export QS_STEP; printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
#
# The program is held in a variable and passed with `-c`, NOT on stdin: the
# body being parsed arrives on stdin, and `python3 - <<EOF` would eat it.
QS_PARSER='
import json, os, sys

raw = sys.stdin.read()
where = os.environ.get("QS_STEP", "(before the first step)")
expr = os.environ["QS_EXPR"]
head = raw[:200] + ("…" if len(raw) > 200 else "")

if not raw.strip():
    sys.exit(f"FAIL: {where} — the response body was EMPTY where JSON was required")
try:
    d = json.loads(raw)
except json.JSONDecodeError as e:
    sys.exit(f"FAIL: {where} — the response is not JSON ({e}); first bytes: {head!r}")
try:
    print(eval(expr, {"__builtins__": {}}, {"d": d}))
except (KeyError, IndexError, TypeError) as e:
    sys.exit(f"FAIL: {where} — the response is JSON but has no {expr} "
             f"({type(e).__name__}: {e}); first bytes: {head!r}")
'
jqf() { QS_EXPR="$1" python3 -c "$QS_PARSER"; }

step "9.1.6.1 exchange the bootstrap token for the owner key"
OWNER_JSON=$(curl -sS -X POST "$BASE_URL/v1/auth/bootstrap" -H "$H" \
  -d "{\"bootstrap_token\":\"$BOOTSTRAP_OWNER_TOKEN\"}")
echo "$OWNER_JSON"
OWNER_KEY=$(printf '%s' "$OWNER_JSON" | jqf "d['api_key']")
[ "$(printf '%s' "$OWNER_JSON" | jqf "d['role']")" = "owner" ] || fail "not the owner role"
case "$OWNER_KEY" in sk_own_*) ;; *) fail "owner key does not look like sk_own_*" ;; esac

step "9.1.6.2 find the seed package (owner key)"
SEARCH_JSON=$(curl -sS "$BASE_URL/v1/skills?q=hello-skillonomia" -H "Authorization: Bearer $OWNER_KEY")
echo "$SEARCH_JSON"
[ "$(printf '%s' "$SEARCH_JSON" | jqf "d['items'][0]['slug']")" = "hello-skillonomia" ] || fail "seed not found"
[ "$(printf '%s' "$SEARCH_JSON" | jqf "d['items'][0]['state']")" = "reviewed" ] || fail "seed is not reviewed"
VERSION_ID=$(printf '%s' "$SEARCH_JSON" | jqf "d['items'][0]['skill_version_id']")

step "9.1.6.3 request adoption (demo-adopter key)"
REQ_JSON=$(curl -sS -X POST "$BASE_URL/v1/adoptions/requests" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d "{\"skill_version_id\":\"$VERSION_ID\",\"idempotency_key\":\"qs-1\"}")
echo "$REQ_JSON"
REQUEST_ID=$(printf '%s' "$REQ_JSON" | jqf "d['adoption_request_id']")
RECEIPT_ID=$(printf '%s' "$REQ_JSON" | jqf "d['receipt_id']")

step "9.1.6.4 adopt = confirm delivery (demo-adopter key)"
ADOPT_JSON=$(curl -sS -X POST "$BASE_URL/v1/adoptions/$REQUEST_ID/adopt" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d '{"environment_descriptor":{"runtime":{"id":"any","version":"1.0.0"},"model":{"id":"any","version":"1.0.0"},"tools":[{"id":"shell","version":"1.0.0"}],"os":"linux","shell":"bash","sandbox_capable":false},"idempotency_key":"qs-2"}')
printf '%s\n' "$ADOPT_JSON" | cut -c1-400
[ "$(printf '%s' "$ADOPT_JSON" | jqf "d['receipt_event']")" = "delivered" ] || fail "no delivered event"
[ "$(printf '%s' "$ADOPT_JSON" | jqf "d['event_seq']")" = "2" ] || fail "delivered is not event_seq 2 (seq 1 is the \`requested\` event that opened the chain)"
[ "$(printf '%s' "$ADOPT_JSON" | jqf "d['compat']['result']")" = "match" ] || fail "compat is not match"

step "9.1.6.5 run the fixture, then report the outcome"
printf '%s' "$ADOPT_JSON" | python3 -c "
import base64, json, sys
d = json.load(sys.stdin)
open('$WORK/package.tar','wb').write(base64.b64decode(d['package']['archive_base64']))
"
tar -xf "$WORK/package.tar" -C "$WORK"
OUT=$(sh "$WORK/fixtures/tv01.sh")
echo "fixture stdout: $OUT"
[ "$OUT" = "skillonomia-tv01-ok" ] || fail "fixture output is not the expected string"

curl -sS -X POST "$BASE_URL/v1/receipts/$RECEIPT_ID/events" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d '{"event":"attempted","idempotency_key":"qs-3"}'
echo
ADOPTED_JSON=$(curl -sS -X POST "$BASE_URL/v1/receipts/$RECEIPT_ID/events" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d "{\"event\":\"adopted\",\"evidence\":{\"gate_results\":[{\"gate_id\":\"g1\",\"pass\":true,\"observed\":\"$OUT\"}]},\"idempotency_key\":\"qs-4\"}")
echo "$ADOPTED_JSON"
[ "$(printf '%s' "$ADOPTED_JSON" | jqf "d['receipt_event']")" = "adopted" ] || fail "terminal event is not adopted"
[ "$(printf '%s' "$ADOPTED_JSON" | jqf "d['event_seq']")" = "4" ] || fail "adopted is not event_seq 4"

step "receipt read-back: the chain is terminal"
RECEIPT_JSON=$(curl -sS "$BASE_URL/v1/receipts/$RECEIPT_ID" -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN")
echo "$RECEIPT_JSON" | cut -c1-400
[ "$(printf '%s' "$RECEIPT_JSON" | jqf "d['derived_state']")" = "adopted" ] || fail "receipt is not terminal adopted"

printf '\nQUICKSTART OK — receipt %s reached terminal `adopted`\n' "$RECEIPT_ID"
