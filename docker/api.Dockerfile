FROM node:22-bookworm-slim AS base
ARG PNPM_VERSION=9.15.0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && \
    for attempt in 1 2 3; do \
      if corepack prepare "pnpm@${PNPM_VERSION}" --activate && \
         test "$(pnpm --version)" = "$PNPM_VERSION"; then \
        exit 0; \
      fi; \
      test "$attempt" -eq 3 || sleep "$((attempt * 5))"; \
    done; \
    exit 1
WORKDIR /app

# The lockfile and every workspace package.json, and nothing else. This step
# reruns on any context change, but its output only changes with a manifest,
# and BuildKit keys `COPY --from=manifests` on that content: a source-only
# commit reuses both install layers below.
FROM base AS manifests
RUN --mount=type=bind,target=/context \
    cd /context && \
    cp pnpm-lock.yaml pnpm-workspace.yaml /app/ && \
    find . -name node_modules -prune -o -name package.json -print0 | \
      xargs -0 cp --parents -t /app

# Build toolchain: the api's workspace closure with devDependencies, plus the
# root package for turbo.
FROM base AS deps
COPY --from=manifests /app/ ./
RUN pnpm install --frozen-lockfile --store-dir /pnpm/store \
      --filter "@squad/api..." --filter squad-admin-panel

# What the runtime ships: a clean production install, not a prune of `deps`,
# so no devDependency sits in a lower layer. It installs offline from the
# store `deps` already downloaded; the rw mount discards the store afterwards.
FROM base AS prod-deps
COPY --from=manifests /app/ ./
RUN --mount=type=bind,from=deps,source=/pnpm/store,target=/pnpm/store,rw \
    pnpm install --frozen-lockfile --prod --offline --store-dir /pnpm/store \
      --filter "@squad/api..."

# One turbo run builds the api and its workspace packages in dependency order,
# in parallel where the graph allows; its cache is off because it would die
# with this stage. /out gathers what the runtime needs at the paths it runs
# them from: every package's dist, and the migrations the migrator service
# reads from /app/packages/db/drizzle.
FROM deps AS builder
ENV TURBO_TELEMETRY_DISABLED=1
COPY tsconfig.base.json turbo.json ./
COPY packages/shared-config packages/shared-config
COPY packages/shared-types packages/shared-types
COPY packages/bridge-client packages/bridge-client
COPY packages/diag packages/diag
COPY packages/db packages/db
COPY packages/steam-api packages/steam-api
COPY apps/api apps/api
RUN pnpm turbo run build --filter=@squad/api... --cache=local:,remote: && \
    mkdir /out && \
    cp -a --parents packages/*/dist packages/db/drizzle apps/api/dist /out/

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps /app /app
COPY --from=builder /out /app
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "--enable-source-maps", "dist/index.js"]
