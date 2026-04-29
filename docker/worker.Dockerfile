FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
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
RUN pnpm --filter @squad/db build
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
