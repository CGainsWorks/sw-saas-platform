# Development identity provider. Build context is the repository root.
#
# This image is for local development and CI only. It authenticates nobody — see the
# header comment in apps/dev-idp/src/server.ts.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/dev-idp/package.json apps/dev-idp/
RUN npm ci --workspace @saas/dev-idp --include-workspace-root

COPY tsconfig.base.json ./
COPY apps/dev-idp apps/dev-idp
RUN npm run build --workspace @saas/dev-idp && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/apps/dev-idp/package.json apps/dev-idp/package.json
COPY --from=build /app/apps/dev-idp/dist apps/dev-idp/dist

USER node
WORKDIR /app/apps/dev-idp
EXPOSE 4010

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
