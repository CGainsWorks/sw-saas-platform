#!/usr/bin/env bash
# Load-test the API in docker compose with k6.
#
#   RUNNER_LABEL="what machine this is" loadtest/run.sh
#
# Starts Postgres, Redis, the dev IdP and the API (migrated and seeded) with the
# overrides in loadtest/compose.loadtest.yml, mints a token for a seeded user inside the
# API container, runs loadtest/k6/api.js in the pinned grafana/k6 image on the compose
# network, then stops the stack. Results land in .loadtest/ (gitignored): summary.md and
# summary.json. Copy summary.md into loadtest/results/ only together with its label.
#
# Environment: VUS (default 20), DURATION (default 60s), KEEP_STACK=1 to leave it running.

set -euo pipefail
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
K6_IMAGE=grafana/k6:1.8.2@sha256:00fdcebafbc86cb0137d429529b1caa401a02e09025f02fc74866fa6e2b004d8
HERE=$(pwd -W 2>/dev/null || pwd) # Git Bash needs a Windows path for docker -v
OUT=.loadtest
COMPOSE=(docker compose -f docker-compose.yml -f loadtest/compose.loadtest.yml)
mkdir -p "$OUT"

: "${RUNNER_LABEL:?set RUNNER_LABEL to describe the machine, e.g. the CI runner image}"

# Throwaway signing key and OIDC client secret for this run only.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$OUT/jwt.key" 2>/dev/null
openssl pkey -in "$OUT/jwt.key" -pubout -out "$OUT/jwt.pub"
JWT_PRIVATE_KEY_B64=$(base64 <"$OUT/jwt.key" | tr -d '\n')
JWT_PUBLIC_KEY_B64=$(base64 <"$OUT/jwt.pub" | tr -d '\n')
OIDC_CLIENT_SECRET=$(openssl rand -hex 24)
export JWT_PRIVATE_KEY_B64 JWT_PUBLIC_KEY_B64 OIDC_CLIENT_SECRET

stop() { [ "${KEEP_STACK:-0}" = "1" ] || "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; }
trap stop EXIT

echo "==> Starting postgres, redis, dev-idp and api"
"${COMPOSE[@]}" up -d --build --wait postgres redis dev-idp api

echo "==> Minting a token for alice@acme.test"
TOKEN=$("${COMPOSE[@]}" exec -T api node --input-type=module - <loadtest/mint-token.mjs)
[ -n "$TOKEN" ] || { echo "no token" >&2; exit 1; }

echo "==> k6 ($K6_IMAGE): ${VUS:-20} VUs for ${DURATION:-60s}"
# shellcheck disable=SC2016 # a Go template, not shell
NETWORK="$("${COMPOSE[@]}" ps -q api | xargs docker inspect \
  --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
docker run --rm --network "$NETWORK" \
  --user "$(id -u):$(id -g)" \
  -v "$HERE/loadtest/k6:/scripts:ro" -v "$HERE/$OUT:/out" \
  -e TOKEN="$TOKEN" -e API_BASE_URL=http://api:4000 -e OUT_DIR=/out \
  -e VUS="${VUS:-20}" -e DURATION="${DURATION:-60s}" \
  -e RUNNER_LABEL="$RUNNER_LABEL" -e K6_IMAGE="$K6_IMAGE" \
  -e TARGET_LABEL="API container from docker-compose.yml (NODE_ENV=production), Postgres 16.4 and Redis 7.4 containers on the same host" \
  "$K6_IMAGE" run --quiet /scripts/api.js

echo "==> Wrote $OUT/summary.md and $OUT/summary.json"
