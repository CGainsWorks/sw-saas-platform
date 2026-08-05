# Build context is the REPOSITORY ROOT, not apps/api — the workspace lockfile and the
# shared-types package both live above this directory.
#
#   docker build -f apps/api/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, as their own layer. They change far less often than source, so the
# expensive `npm ci` is cached across the majority of rebuilds.
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @saas/api --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/api apps/api

# shared-types first: the API imports its compiled output.
RUN npm run build --workspace @saas/shared-types \
 && npm run build --workspace @saas/api \
 && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Small but real: without it, an unhandled rejection inside a signal handler can leave the
# process alive but not serving.
ENV NODE_OPTIONS=--enable-source-maps

# tini reaps zombies and, more importantly, forwards SIGTERM to node. PID 1 in a container
# does not get the default signal handlers, so without an init the graceful shutdown in
# server.ts would never run and every rolling deploy would drop in-flight requests.
RUN apk add --no-cache tini

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/shared-types/package.json packages/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist

# tsc emits .js only. The migration runner resolves its directory relative to its own
# compiled location, so the .sql files have to be placed alongside it.
COPY --from=build /app/apps/api/src/db/migrations apps/api/dist/db/migrations

USER node
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
