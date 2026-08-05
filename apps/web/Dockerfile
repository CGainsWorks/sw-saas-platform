# Next.js front end. Build context is the repository root.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @saas/web --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, not read at
# runtime. Changing the API URL therefore requires a rebuild, which is why it is a build
# arg rather than only an environment variable.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build --workspace @saas/shared-types \
 && npm run build --workspace @saas/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache tini

# `output: 'standalone'` produces a self-contained tree with only the modules actually
# reached at runtime, so no node_modules layer is copied here at all.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
