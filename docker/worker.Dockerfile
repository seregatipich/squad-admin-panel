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

# Build toolchain: every worker's workspace closure with devDependencies, plus
# the root package for turbo.
FROM base AS deps
COPY --from=manifests /app/ ./
RUN pnpm install --frozen-lockfile --store-dir /pnpm/store \
      --filter "{./apps/workers/*}..." --filter squad-admin-panel

# What the runtime ships: a clean production install, not a prune of `deps`,
# so no devDependency sits in a lower layer. It installs offline from the
# store `deps` already downloaded; the rw mount discards the store afterwards.
FROM base AS prod-deps
COPY --from=manifests /app/ ./
RUN --mount=type=bind,from=deps,source=/pnpm/store,target=/pnpm/store,rw \
    pnpm install --frozen-lockfile --prod --offline --store-dir /pnpm/store \
      --filter "{./apps/workers/*}..."

# Every worker is built into the one image: production pulls a single
# `workers` image and each compose service picks its worker with WORKER at
# run time, so a release carries one worker layer set instead of twenty. One
# turbo run builds them and their workspace packages in dependency order, in
# parallel where the graph allows; its cache is off because it would die with
# this stage. /out gathers every dist at the path the runtime runs it from.
FROM deps AS builder
ENV TURBO_TELEMETRY_DISABLED=1
COPY tsconfig.base.json turbo.json ./
COPY packages packages
COPY apps/workers apps/workers
RUN pnpm turbo run build --filter="./apps/workers/*" --cache=local:,remote: && \
    mkdir /out && \
    cp -a --parents packages/*/dist apps/workers/*/dist /out/

FROM base AS runtime
ENV NODE_ENV=production
# systemd provides journalctl for worker-diag-flush's journald forwarding; it
# is installed for every worker because they share this image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends systemd && \
    rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps /app /app
COPY --from=builder /out /app
# A build-arg default keeps per-worker builds (docker-compose.yml) working;
# the shared production image leaves it empty and compose sets WORKER.
ARG WORKER=
ENV WORKER=$WORKER
WORKDIR /app
CMD ["sh", "-c", "test -n \"$WORKER\" || { echo 'WORKER is not set' >&2; exit 64; }; cd \"/app/apps/workers/$WORKER\" && exec node --enable-source-maps dist/index.js"]
