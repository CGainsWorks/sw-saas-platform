#!/usr/bin/env bash
#
# One-time setup on a clean machine.
#
# You do not need this to run the demo — `docker compose up --build` is self-contained.
# This is for running the apps directly on the host, which is nicer for development
# because of reload.

set -euo pipefail

cd "$(dirname "$0")/.."

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

info 'Checking prerequisites'

command -v node >/dev/null 2>&1 || fail 'node is not installed (need >= 22)'
command -v docker >/dev/null 2>&1 || fail 'docker is not installed'

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "node $NODE_MAJOR is too old; need >= 22"

docker info >/dev/null 2>&1 || fail 'the docker daemon is not running'

info "node $(node -v), docker present"

if [ ! -f .env ]; then
  info 'Creating .env from .env.example'
  cp .env.example .env
else
  info '.env already exists, leaving it alone'
fi

info 'Installing dependencies'
npm install

info 'Building shared-types (the API and web both import its compiled output)'
npm run build --workspace @saas/shared-types

info 'Starting Postgres and Redis'
docker compose up -d postgres redis

info 'Waiting for Postgres to accept connections'
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U postgres -d saas >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

info 'Applying migrations'
npm run migrate

info 'Seeding demo tenants'
npm run seed

cat <<'EOF'

Setup complete.

  npm run dev:api      API on http://localhost:4000
  npm run dev:web      front end on http://localhost:3000
  npm run test         full test suite
  make verify-isolation  prove the isolation tests actually fail without RLS

Or just run everything in containers:

  docker compose up --build

EOF
