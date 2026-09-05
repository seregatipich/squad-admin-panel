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
ARG WORKER
RUN test -n "$WORKER" && pnpm --filter @squad/worker-$WORKER build

FROM base AS runtime
ENV NODE_ENV=production
ARG WORKER
ENV WORKER=$WORKER
RUN if [ "$WORKER" = "diag-flush" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends systemd && \
      rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=builder /app /app
RUN pnpm install --frozen-lockfile --prod
WORKDIR /app/apps/workers/$WORKER
CMD ["node", "--enable-source-maps", "dist/index.js"]
