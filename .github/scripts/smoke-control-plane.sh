#!/usr/bin/env bash
#
# Start the built control-plane image and check the four things that would otherwise be found by a
# deployment rather than by CI.
#
#   1. It boots at all, with a configuration a real deployment would use — `AUTH_PROVIDERS=local`,
#      no development bypass, its own volume, its config mounted rather than baked in.
#   2. The bootstrap administrator exists and is behind the forced-password-change gate. That gate
#      is the whole reason it is safe to pass a first password through the environment.
#   3. `GET /api/meta` answers 401 without a cookie. It carries every gateway URL the playground
#      may use, and it was public until v5 `[P1-01]`. This assertion is what keeps it closed.
#   4. The container's directory holds exactly one account. A `.dockerignore` regression that
#      shipped a developer's `.data/apim.sqlite` would fail here and nowhere else `[P1-23]` — and
#      that database carries every subscription key and certificate this repository has minted.
set -euo pipefail

IMAGE="${1:?usage: smoke-control-plane.sh <image>}"
NAME="apim-smoke-cp"
PASSWORD="a-smoke-test-password"

cleanup() {
  docker logs "$NAME" 2>&1 | sed 's/^/[cp] /' || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$NAME" \
  -p 18080:8080 \
  -e AUTH_PROVIDERS=local \
  -e BOOTSTRAP_ADMIN_USERNAME=smoke \
  -e BOOTSTRAP_ADMIN_PASSWORD="$PASSWORD" \
  -e PUBLIC_URL=http://localhost:18080 \
  -v "$PWD/config:/etc/apim:ro" \
  "$IMAGE" >/dev/null

echo "--- waiting for /readyz"
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:18080/readyz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://localhost:18080/readyz | tee /dev/stderr | grep -q '"ok":true'

echo "--- the pre-session surface says what it should, and nothing else"
providers=$(curl -fsS http://localhost:18080/api/auth/providers)
echo "$providers"
echo "$providers" | grep -q '"providers":\["local"\]'
# The development bypass advertises nobody, because it is not on.
echo "$providers" | grep -q '"devUsers":\[\]'

echo "--- /api/meta needs a session"
status=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18080/api/meta)
test "$status" = "401" || { echo "expected 401 from /api/meta without a cookie, got $status"; exit 1; }

echo "--- the bootstrap administrator can sign in"
cookies=$(mktemp)
curl -fsS -c "$cookies" -X POST http://localhost:18080/api/auth/login \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:18080' \
  -d "{\"username\":\"smoke\",\"password\":\"$PASSWORD\"}" | tee /dev/stderr | grep -q '"mustChangePassword":true'

echo "--- and is gated until the password is changed"
status=$(curl -s -b "$cookies" -o /dev/null -w '%{http_code}' http://localhost:18080/api/users)
test "$status" = "403" || { echo "expected 403 before the password change, got $status"; exit 1; }

echo "--- changing it lifts the gate"
curl -fsS -b "$cookies" -X POST http://localhost:18080/api/auth/password \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:18080' \
  -d '{"newPassword":"a-different-smoke-password"}' >/dev/null
curl -fsS -b "$cookies" http://localhost:18080/api/users | tee /dev/stderr | grep -q '"username":"smoke"'

echo "--- the image shipped no database of its own"
count=$(curl -fsS -b "$cookies" http://localhost:18080/api/users | grep -o '"id":"' | wc -l)
test "$count" = "1" || { echo "expected exactly one account in a fresh image, found $count"; exit 1; }

echo "--- the SPA is served"
curl -fsS http://localhost:18080/ | grep -qi '<title>'

echo "OK"
