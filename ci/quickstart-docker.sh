#!/usr/bin/env bash
# The release quickstart CI gate. Runs the normative quickstart against the
# container image on a clean runner and measures the elapsed time FROM CONTAINER
# START. That — the Docker image on a clean Ubuntu x86_64 runner — is the
# ≤600-second scenario the release gate is measured against.
#
#   IMAGE=skillonomia:ci ci/quickstart-docker.sh          # build + run + time
#   IMAGE=skillonomia:ci SKIP_BUILD=1 ci/quickstart-docker.sh   # reuse a built image
#
# The image is ALWAYS built from this repository's Dockerfile: V1 publishes no
# container image, so there is nothing to pull and SKIP_BUILD only means
# "an image with that tag was built earlier in this job".
#
# Prints the full transcript and the elapsed seconds; exits non-zero if the
# receipt does not reach terminal `adopted` or the budget is exceeded.
set -euo pipefail

IMAGE="${IMAGE:-skillonomia:ci}"
PORT="${PORT:-7431}"
BUDGET_S="${BUDGET_S:-600}"
NAME="skillonomia-quickstart-$$"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "=== building $IMAGE"
  docker build -q -t "$IMAGE" "$REPO"
fi

echo "=== image digest / id"
docker image inspect "$IMAGE" --format '{{.Id}}  {{join .RepoDigests ", "}}'

# The clock starts HERE: §9.1's target is "clean machine → receipt adopted in
# ≤10 minutes", and step 1 is `docker run`.
START=$(date +%s)

# The publish is LOOPBACK-ONLY, and that is part of what this gate rehearses.
# A CI runner is a host on a network like any other, and this listener speaks
# plain HTTP: a publish naming no host address would put the §9.1 bootstrap
# token and the demo adopter's API key — both read back out of `docker logs`
# below — onto every interface the runner has, for as long as the job runs.
# `127.0.0.1:` costs nothing here (every client below is on this host) and keeps
# the gate running the same shape the documents tell an operator to run.
echo "=== 9.1.1 docker run -p 127.0.0.1:$PORT:7431 -v <data>:/data $IMAGE"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:7431" -v "$NAME-data:/data" "$IMAGE" >/dev/null

echo "=== waiting for GET /health"
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$PORT/health" || { docker logs "$NAME"; echo "FAIL: /health never answered" >&2; exit 1; }
echo

echo "=== 9.1.2/9.1.5 the two one-time credentials, from the container's stdout"
LOGS=$(docker logs "$NAME" 2>&1)
printf '%s\n' "$LOGS"
BOOTSTRAP_OWNER_TOKEN=$(printf '%s\n' "$LOGS" | sed -n 's/^BOOTSTRAP_OWNER_TOKEN=//p' | head -1)
DEMO_ADOPTER_TOKEN=$(printf '%s\n' "$LOGS" | sed -n 's/^DEMO_ADOPTER_TOKEN=//p' | head -1)
[ -n "$BOOTSTRAP_OWNER_TOKEN" ] || { echo "FAIL: no BOOTSTRAP_OWNER_TOKEN in the container log" >&2; exit 1; }
[ -n "$DEMO_ADOPTER_TOKEN" ] || { echo "FAIL: no DEMO_ADOPTER_TOKEN in the container log" >&2; exit 1; }

BASE_URL="http://localhost:$PORT" \
BOOTSTRAP_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN" \
DEMO_ADOPTER_TOKEN="$DEMO_ADOPTER_TOKEN" \
  "$REPO/ci/quickstart.sh"

ELAPSED=$(( $(date +%s) - START ))
echo
echo "=== elapsed ${ELAPSED}s from container start (budget ${BUDGET_S}s, release target 600s)"
[ "$ELAPSED" -lt "$BUDGET_S" ] || { echo "FAIL: quickstart took ${ELAPSED}s ≥ ${BUDGET_S}s" >&2; exit 1; }
echo "QUICKSTART-E2E OK in ${ELAPSED}s"
