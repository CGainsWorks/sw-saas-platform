#!/usr/bin/env bash
# Run the tenant isolation suites against the API deployed in the kind cluster.
#
# Run after scripts/kind/up.sh (and `npm ci` plus the shared-types build). The HTTP and
# GraphQL suites send their requests to the in-cluster API through a port-forward
# (tests/helpers/app.ts, remote mode); the RLS suites and the fixtures talk to the
# in-cluster Postgres and Redis the same way. Tokens are signed with the key pair up.sh
# put into LocalStack, which reached the API through the ExternalSecret, so a passing
# token test also proves the secret made the whole trip.

set -euo pipefail
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/../.."
CTX="kind-${KIND_CLUSTER:-saas}"
WORK=.kind
k() { kubectl --context "$CTX" "$@"; }

[ -f "$WORK/jwt.key" ] || { echo "no $WORK/jwt.key: run scripts/kind/up.sh first" >&2; exit 1; }

API_PORT=${API_PORT:-18080}
PG_PORT=${PG_PORT:-15432}
REDIS_PORT=${REDIS_PORT:-16379}

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

k -n saas port-forward svc/saas-api "$API_PORT:80" >"$WORK/pf-api.log" 2>&1 &
pids+=($!)
k -n data port-forward svc/postgres "$PG_PORT:5432" >"$WORK/pf-pg.log" 2>&1 &
pids+=($!)
k -n data port-forward svc/redis "$REDIS_PORT:6379" >"$WORK/pf-redis.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$API_PORT/readyz" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "in-cluster API: $(curl -fsS "http://127.0.0.1:$API_PORT/readyz")"

# Issuer and audience come from the deployed ConfigMap, so the tokens the tests sign are
# checked against exactly what the pods were configured with.
export JWT_ISSUER JWT_AUDIENCE
JWT_ISSUER=$(k -n saas get configmap saas-api-config -o jsonpath='{.data.JWT_ISSUER}')
JWT_AUDIENCE=$(k -n saas get configmap saas-api-config -o jsonpath='{.data.JWT_AUDIENCE}')
export JWT_PRIVATE_KEY_B64 JWT_PUBLIC_KEY_B64
JWT_PRIVATE_KEY_B64=$(base64 <"$WORK/jwt.key" | tr -d '\n')
JWT_PUBLIC_KEY_B64=$(base64 <"$WORK/jwt.pub" | tr -d '\n')

export API_BASE_URL="http://127.0.0.1:$API_PORT"
export DATABASE_URL="postgres://app_user:app_dev_password@127.0.0.1:$PG_PORT/saas"
export DATABASE_ADMIN_URL="postgres://postgres:postgres@127.0.0.1:$PG_PORT/saas"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
export NODE_ENV=test SKIP_DOTENV=1

npm run test:isolation
