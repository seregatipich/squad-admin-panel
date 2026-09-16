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

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/workers apps/workers
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY tsconfig.base.json biome.json turbo.json ./
RUN pnpm --filter @squad/shared-config build
RUN pnpm --filter @squad/shared-types build
RUN pnpm --filter @squad/bridge-client build
RUN pnpm --filter @squad/diag build
RUN pnpm --filter @squad/db build
RUN pnpm --filter @squad/steam-api build
RUN pnpm --filter @squad/chat-ingest build
# Every worker is built into the one image: production pulls a single
# `workers` image and each compose service picks its worker with WORKER at
# run time, so a release carries one worker layer set instead of twenty.
RUN pnpm --workspace-concurrency=4 --filter "./apps/workers/*" build

FROM base AS runtime
ENV NODE_ENV=production
# systemd provides journalctl for worker-diag-flush's journald forwarding; it
# is installed for every worker because they share this image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends systemd && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /app /app
RUN pnpm install --frozen-lockfile --prod
# A build-arg default keeps per-worker builds (docker-compose.yml) working;
# the shared production image leaves it empty and compose sets WORKER.
ARG WORKER=
ENV WORKER=$WORKER
WORKDIR /app
CMD ["sh", "-c", "test -n \"$WORKER\" || { echo 'WORKER is not set' >&2; exit 64; }; cd \"/app/apps/workers/$WORKER\" && exec node --enable-source-maps dist/index.js"]
