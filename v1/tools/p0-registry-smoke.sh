#!/usr/bin/env bash
# P0 baseline Registry API + CLI smoke against a DISPOSABLE database.
#
#   v1/tools/p0-registry-smoke.sh            # defaults to port 7487
#   PORT=7500 v1/tools/p0-registry-smoke.sh
#
# `P0-FR-05` requires the baseline to be established through the EXISTING PUBLIC
# CONTRACTS rather than by reading the database. So nothing here issues SQL: the
# registry is exercised over HTTP and through the shipped CLI, and the central
# scenario is the repository's own normative quickstart, `ci/quickstart.sh`, run
# verbatim rather than reimplemented.
#
# THE PORT IS CHECKED BEFORE ANYTHING STARTS, and this is not defensive
# boilerplate. The default 7431 was occupied on the machine that first ran this,
# by an unrelated long-lived deployment answering with a different version — and
# the smoke passed, against a server that was not this checkout. A gate that can
# report on somebody else's process is worse than no gate, so the port must be
# silent first and `/health` must then return THIS tree's version.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-7487}"
DATA="$(mktemp -d)"
LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$DATA" "$LOG"
  if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/health"; then
    echo "WARNING: port $PORT is still answering after cleanup" >&2
  fi
}
trap cleanup EXIT

fails=0
step() { printf '\n=== %s\n' "$*"; }
res() { if [ "$1" -eq 0 ]; then echo "PASS  $2 (exit=$1)"; else echo "FAIL  $2 (exit=$1)"; fails=$((fails + 1)); fi; }

VERSION=$(node -p "require('$REPO/package.json').version")
echo "repo: $REPO"
echo "node: $(node --version)"
echo "disposable data directory: $DATA  (mktemp -d, removed on exit)"
echo "expected version (package.json): $VERSION"

step "the chosen port is free before anything starts"
if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/health"; then
  echo "FAIL  port $PORT is already answering - refusing to smoke against a foreign server"
  exit 1
fi
echo "PASS  port $PORT is free"

step "CLI: skillonomia version"
(cd "$REPO" && node bin/skillonomia.js version)
res $? "cli version"

step "CLI: skillonomia help"
(cd "$REPO" && node bin/skillonomia.js help | head -12)
res "${PIPESTATUS[0]}" "cli help"

step "start the registry on the disposable database"
# `exec`, so $! is the SERVER and not a subshell wrapper. Without it the trap
# kills the wrapper, the server survives as an orphan still holding the port,
# and the next run of this script finds it and refuses.
(cd "$REPO" && exec env SKILLONOMIA_DATA="$DATA" SKILLONOMIA_PORT="$PORT" node bin/skillonomia.js serve > "$LOG" 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
kill -0 "$SERVER_PID" 2>/dev/null
res $? "the server process this script started is alive"

step "GET /health"
HEALTH=$(curl -fsS "http://localhost:$PORT/health")
rc=$?
echo "$HEALTH"
res $rc "GET /health responded"
echo "$HEALTH" | grep -q '"status":"ok"'
res $? "/health reports status ok"
echo "$HEALTH" | grep -q "\"version\":\"$VERSION\""
res $? "/health reports this checkout's version ($VERSION) - the server answering is the one this script started"

step "first-start credentials were printed (values redacted here, never written to evidence)"
grep -q '^BOOTSTRAP_OWNER_TOKEN=' "$LOG"
res $? "BOOTSTRAP_OWNER_TOKEN printed"
grep -q '^DEMO_ADOPTER_TOKEN=' "$LOG"
res $? "DEMO_ADOPTER_TOKEN printed"
BOOTSTRAP_OWNER_TOKEN=$(grep '^BOOTSTRAP_OWNER_TOKEN=' "$LOG" | head -1 | cut -d= -f2-)
DEMO_ADOPTER_TOKEN=$(grep '^DEMO_ADOPTER_TOKEN=' "$LOG" | head -1 | cut -d= -f2-)
export BOOTSTRAP_OWNER_TOKEN DEMO_ADOPTER_TOKEN

step "protected API refuses an unauthenticated read"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/v1/skills")
echo "GET /v1/skills without Authorization -> HTTP $CODE"
[ "$CODE" = "401" ]
res $? "unauthenticated /v1/skills is 401"

step "the normative quickstart (ci/quickstart.sh) end to end"
# The transcript is FILTERED, and only for credentials: the quickstart echoes
# the minted owner key, and a secret must never reach an evidence file. Nothing
# else about the output is altered.
(cd "$REPO" && BASE_URL="http://localhost:$PORT" ci/quickstart.sh) 2>&1 |
  sed -E 's/(sk_[A-Za-z0-9_-]+|bt_[A-Za-z0-9_-]+)/<REDACTED-CREDENTIAL>/g'
res "${PIPESTATUS[0]}" "ci/quickstart.sh"

step "MCP surface: tools/list over POST /mcp (inventory, existing contract)"
MCP_JSON=$(curl -sS -X POST "http://localhost:$PORT/mcp" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
echo "$MCP_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
tools=d.get("result",{}).get("tools",[])
print("mcp tools advertised:", len(tools))
for t in sorted(x["name"] for x in tools): print("  -", t)
sys.exit(0 if tools else 1)
'
res $? "POST /mcp tools/list returned a non-empty tool list"

step "CLI: verify-log against the disposable database (read-only audit path)"
(cd "$REPO" && node bin/skillonomia.js verify-log --db "$DATA/skillonomia.db" | tail -5)
res "${PIPESTATUS[0]}" "cli verify-log"

step "the server log carried no unexpected error"
n=$(grep -icE '^(Error|Uncaught|FATAL)' "$LOG" || true)
echo "error-shaped log lines: $n"
[ "$n" -eq 0 ]
res $? "no error-shaped lines in the server log"

echo
echo "checks_failed=$fails"
exit $((fails == 0 ? 0 : 1))
