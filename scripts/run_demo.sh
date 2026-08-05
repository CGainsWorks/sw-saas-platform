#!/usr/bin/env bash
#
# Runs the demo and then walks the isolation guarantee from the command line, so the
# central claim of this repository is something you watch happen rather than read about.

set -euo pipefail

cd "$(dirname "$0")/.."

API="${API_URL:-http://localhost:4000}"

info() { printf '\n\033[36m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

info 'Starting the stack'
docker compose up -d --build

info 'Waiting for the API to become healthy'
for _ in $(seq 1 60); do
  if curl -fsS "$API/healthz" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "$API/healthz" >/dev/null || { echo "API never became healthy"; docker compose logs api | tail -50; exit 1; }

cat <<EOF

  Everything is up.

    web         http://localhost:3000
    api         $API
    graphql     $API/graphql
    dev idp     http://localhost:4010
    prometheus  http://localhost:9090
    grafana     http://localhost:3001

  Sign in as any demo user. dave@globex.test belongs to both tenants;
  erin@newco.test has no tenant yet and gets one provisioned on first login.

EOF

info 'Demonstrating the isolation boundary directly against the database'

note 'Both tenants have rows in the same tables:'
docker compose exec -T postgres psql -U postgres -d saas -c \
  "SELECT t.name AS tenant, count(*) AS tasks
     FROM tasks k JOIN tenants t ON t.id = k.tenant_id
    GROUP BY t.name ORDER BY t.name;"

note 'As app_user with tenant context set to Acme, an UNSCOPED query returns only Acme rows:'
docker compose exec -T postgres psql -U app_user -d saas -c \
  "BEGIN;
   SELECT set_config('app.current_tenant', (SELECT id::text FROM tenants WHERE slug='acme-corp'), true);
   SELECT t.name AS tenant, count(*) AS visible_tasks
     FROM tasks k JOIN tenants t ON t.id = k.tenant_id
    GROUP BY t.name;
   COMMIT;"

note 'With NO tenant context at all, the same query returns nothing (fail closed):'
docker compose exec -T postgres psql -U app_user -d saas -c "SELECT count(*) AS visible_tasks FROM tasks;"

info 'Running the cross-tenant attack suite'
npm run test:isolation

cat <<'EOF'

  The suite passed. That on its own does not prove much, so:

    node scripts/verify-isolation.mjs

  disables row-level security on each table in turn and checks the tests go red.

  Shut down with `docker compose down`, or `docker compose down -v` to delete the data.

EOF
