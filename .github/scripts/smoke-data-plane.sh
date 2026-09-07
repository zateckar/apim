#!/usr/bin/env bash
#
# Start the built gateway image and check the two things that are properties of the *image* rather
# than of the code:
#
#   1. It refuses to start without a token, by name. A gateway that came up unauthenticated and
#      quietly served nothing would look identical to one that is merely waiting to converge.
#   2. With a token it starts, listens, and reports that it has activated no config — which is the
#      correct state for a gateway whose control plane it has never reached. "Listening" and "able
#      to serve something" are different answers, and `/healthz` gives the honest one.
#
# It is deliberately not a full round trip: that needs a control plane, a target, a released API
# and a subscription, and all of it is already asserted end to end in `test/` against both real
# processes. What CI cannot get from those tests is whether this Dockerfile's COPY lines and
# environment defaults produce a process that runs.
set -euo pipefail

IMAGE="${1:?usage: smoke-data-plane.sh <image>}"
NAME="apim-smoke-dp"

# Only if the container was ever created: the first check below runs before it exists, and a
# `No such container` line under the `[dp]` prefix reads like the gateway's own failure.
cleanup() {
  if docker inspect "$NAME" >/dev/null 2>&1; then
    docker logs "$NAME" 2>&1 | sed 's/^/[dp] /' || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "--- no token is a startup failure that names the variable"
# Captured rather than piped into `grep`. A refusal is a non-zero exit by design, and under
# `pipefail` that exit status is the pipeline's own — so `docker run | grep -q` reported failure
# for the very run that passed, and said the gateway had not refused while printing its refusal.
refusal=$(docker run --rm "$IMAGE" 2>&1 || true)
echo "$refusal"
if grep -q "GATEWAY_TOKEN" <<<"$refusal"; then
  echo "refused, by name"
else
  echo "expected the gateway to refuse to start and name GATEWAY_TOKEN"
  exit 1
fi

echo "--- with a token it comes up and says it has nothing to serve yet"
token_dir=$(mktemp -d)
echo "not-a-real-token-nothing-will-accept-it" > "$token_dir/token"
chmod 644 "$token_dir/token"

docker run -d --name "$NAME" \
  -p 18081:8081 \
  -e DP_NAME=smoke-1 \
  -e GATEWAY_CP_URL=http://127.0.0.1:1 \
  -e GATEWAY_TOKEN_FILE=/run/secrets/token \
  -e POLL_INTERVAL_SEC=60 \
  -v "$token_dir/token:/run/secrets/token:ro" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 45); do
  if curl -fsS http://localhost:18081/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
health=$(curl -fsS http://localhost:18081/healthz)
echo "$health"

# The control plane is unreachable on purpose (port 1), so this must report no active config and
# must still be answering. A gateway that fell over when its control plane was down would turn a
# control-plane outage into a traffic outage, which is the one thing the two-plane split exists to
# prevent.
echo "$health" | grep -q '"configDigest":null'
echo "$health" | grep -q '"ok":false'

echo "--- and it is not running as root"
test "$(docker exec "$NAME" id -u)" != "0" || { echo "the gateway is running as root"; exit 1; }

echo "OK"
