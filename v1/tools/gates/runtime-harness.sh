#!/usr/bin/env bash
# The shared body of the two runtime gates: a DISPOSABLE registry on a free
# port, the owner key exchanged the way the product exchanges it, and then
# `v1/tools/gates/runtime-session.mjs` against a REAL runtime binary.
#
#   v1/tools/gates/runtime-harness.sh <codex|claude_code>
#
# It is sourced by no one and called by both gates with one argument, so the two
# gates cannot drift into proving different things about their two runtimes.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0 passed   1 failed   2 REFUSED (could not reach the subject)   3 not implemented
set -uo pipefail
RUNTIME="${1:-}"
case "$RUNTIME" in
  codex|claude_code) ;;
  *) echo "usage: $0 <codex|claude_code>" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
WORK_BASE="${SKLN_RUNTIME_WORK:-}"
if [ -z "$WORK_BASE" ]; then
  echo "REFUSED: set SKLN_RUNTIME_WORK to a writable directory OUTSIDE the evidence package." >&2
  echo "A runtime home is not evidence: it is a copy of somebody else's runtime, and it does not" >&2
  echo "belong inside an evidence package. The gate refuses to pick the directory for you." >&2
  exit 2
fi

# THE PORT IS CHECKED BEFORE ANYTHING STARTS, for the reason
# `v1/tools/p0-registry-smoke.sh` gives: a foreign deployment answering on the
# default port made a smoke pass against a server that was not this checkout.
PORT="${PORT:-0}"
if [ "$PORT" = "0" ]; then
  PORT=$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')
fi
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health"; then
  echo "REFUSED: port $PORT is already answering — this gate will not measure a foreign server." >&2
  exit 2
fi

DATA="$(mktemp -d)"
LOG="$(mktemp)"
WORK="$(mktemp -d "$WORK_BASE/skln-runtime-$RUNTIME-XXXXXX")"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$DATA" "$LOG"
}
trap cleanup EXIT

# The runtime credential the harness will seed into the session home. It is a
# path, named by the operator; nothing here reads the value and nothing writes
# it outside the disposable work directory.
if [ "$RUNTIME" = "codex" ]; then
  : "${SKLN_RUNTIME_AUTH_CODEX:=${CODEX_HOME:-$HOME/.codex}/auth.json}"
  export SKLN_RUNTIME_AUTH_CODEX
else
  : "${SKLN_RUNTIME_AUTH_CLAUDE:=$HOME/.claude/.credentials.json}"
  export SKLN_RUNTIME_AUTH_CLAUDE
fi

VERSION=$(node -p "require('$REPO/package.json').version")
echo "repo:    $REPO"
echo "runtime: $RUNTIME"
echo "port:    $PORT   (chosen free; /health is asserted to be THIS checkout)"
echo "data:    $DATA   (mktemp -d, removed on exit)"
echo "work:    $WORK   (runtime homes and transcripts — OUTSIDE the evidence package)"

(cd "$REPO" && exec env SKILLONOMIA_DATA="$DATA" SKILLONOMIA_PORT="$PORT" SKILLONOMIA_HOST=127.0.0.1 \
  node bin/skillonomia.js serve > "$LOG" 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -fsS "http://127.0.0.1:$PORT/health" | grep -q "\"version\":\"$VERSION\""; then
  echo "REFUSED: /health did not report this checkout's version ($VERSION)." >&2
  exit 2
fi
echo "the server answering on $PORT is this checkout ($VERSION)"

BOOTSTRAP_OWNER_TOKEN=$(grep '^BOOTSTRAP_OWNER_TOKEN=' "$LOG" | head -1 | cut -d= -f2-)
if [ -z "$BOOTSTRAP_OWNER_TOKEN" ]; then
  echo "REFUSED: the server printed no bootstrap token." >&2
  exit 2
fi
OWNER_KEY=$(curl -sS -X POST "http://127.0.0.1:$PORT/v1/auth/bootstrap" -H 'Content-Type: application/json' \
  -d "{\"bootstrap_token\":\"$BOOTSTRAP_OWNER_TOKEN\"}" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["api_key"])')
if [ -z "$OWNER_KEY" ]; then
  echo "REFUSED: the bootstrap exchange produced no owner key." >&2
  exit 2
fi
echo "the owner key was exchanged (value never printed)"

# The transcript is FILTERED for credentials only, and by the same rule the P0
# smoke uses: a secret must never reach an evidence file.
set -o pipefail
node "$REPO/v1/tools/gates/runtime-session.mjs" "$RUNTIME" \
  --base-url "http://127.0.0.1:$PORT" \
  --owner-token "$OWNER_KEY" \
  --data "$DATA" \
  --work "$WORK" \
  --repo "$REPO" 2>&1 |
  sed -E 's/(sk_[A-Za-z0-9_-]+|bt_[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/<REDACTED-CREDENTIAL>/g'
rc="${PIPESTATUS[0]}"

if [ "$rc" -ne 0 ]; then
  echo
  echo "--- last 30 lines of the registry log (credentials filtered) ---"
  tail -30 "$LOG" | sed -E 's/(sk_[A-Za-z0-9_-]+|bt_[A-Za-z0-9_-]+)/<REDACTED-CREDENTIAL>/g'
fi

echo
echo "runtime homes and transcripts kept at: $WORK"
exit "$rc"
