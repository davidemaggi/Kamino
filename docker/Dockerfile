# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f docker/Dockerfile -t kamino:local .

# ---- build: install the workspace, build web + server, prune to a prod deployment ----
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
# Dependency manifests first so the install layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/plugin/package.json apps/plugin/
COPY packages/brand/package.json packages/brand/
COPY packages/protocol/package.json packages/protocol/
COPY packages/status/package.json packages/status/
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/ui-diff/package.json packages/ui-diff/
COPY packages/tsconfig/package.json packages/tsconfig/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# .git is not in the build context; the commit comes in as a build arg.
ARG KAMINO_BUILD_COMMIT=unknown
ENV KAMINO_BUILD_COMMIT=${KAMINO_BUILD_COMMIT}
RUN pnpm --filter "@kamino/server..." --filter "@kamino/web..." build
RUN pnpm --filter @kamino/server deploy --prod --config.inject-workspace-packages=true /out \
    && cp -r apps/web/dist /out/public \
    && find /out/node_modules -type f \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" \) -delete

# ---- node-slim: the official node binary, stripped of debug symbols (~18 MB smaller) ----
# Same Alpine release as the runtime stage, so the binary links against matching libs.
# strip removes debug symbols, so native crash reports are less informative.
FROM node:24-alpine3.24 AS node-slim
RUN apk add --no-cache binutils && strip /usr/local/bin/node

# ---- runtime ----
FROM alpine:3.24 AS runtime
RUN apk add --no-cache libstdc++ \
    && addgroup -g 1000 -S node && adduser -u 1000 -S -G node -h /home/node node
COPY --from=node-slim /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
COPY --from=build /out/public ./public
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
EXPOSE 8080
# No curl in the base image: probe with Node's built-in fetch.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.KAMINO_PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# No arguments: run the server (node dist/main.js). With arguments: run the CLI
# (e.g. `keys generate`, `keys verify`, `migrate`).
ENTRYPOINT ["entrypoint.sh"]
CMD []
