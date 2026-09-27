#!/usr/bin/env bash
# Runs the image as a deployment would: `docker-smoke.sh <image> <version>`.
# Checks the version, that state in the /data volume outlives a container, that
# the API, /healthz and the admin UI answer on the published port, and that `docker stop`
# is graceful.
set -euo pipefail

image=$1
version=$2
name=via-smoke-$$
volume=via-smoke-$$
port=18317
admin_key=smoke-admin-key-that-is-long-enough

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--version"
docker run --rm "$image" --version | tee /dev/stderr | grep -qx "via v$version"

echo "A key created by one container..."
docker volume create "$volume" >/dev/null
key=$(docker run --rm -v "$volume:/data" "$image" keys create --name smoke | tail -n 1)

echo "...is accepted by another serving from the same volume"
docker run -d --name "$name" -p "127.0.0.1:$port:8317" -v "$volume:/data" \
  -e VIA_ADMIN_KEY="$admin_key" "$image" >/dev/null
status() {
  curl -s -o /dev/null -w '%{http_code}' "$@" "http://127.0.0.1:$port/v1/models" || true
}
for _ in $(seq 1 30); do
  [ "$(status -H "Authorization: Bearer $key")" = 200 ] && break
  sleep 1
done
test "$(status -H "Authorization: Bearer $key")" = 200
test "$(status)" = 401

echo "/healthz answers without a key"
test "$(curl -s "http://127.0.0.1:$port/healthz")" = ok

echo "/ui/ serves the admin UI under a CSP with VIA_ADMIN_KEY set"
headers=$(curl -s -D - -o /dev/null "http://127.0.0.1:$port/ui/")
grep -q "^HTTP/1.1 200" <<< "$headers"
grep -qi "^content-security-policy: default-src 'none'" <<< "$headers"

echo "docker stop shuts via down without waiting for the kill"
start=$(date +%s)
docker stop -t 10 "$name" >/dev/null
test $(($(date +%s) - start)) -lt 5
docker logs "$name" 2>&1 | tail -n 5

echo "ok"
