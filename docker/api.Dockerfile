FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-config/package.json packages/shared-config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/bridge-client/package.json packages/bridge-client/
COPY packages/diag/package.json packages/diag/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY packages/shared-config packages/shared-config
COPY packages/shared-types packages/shared-types
COPY packages/bridge-client packages/bridge-client
COPY packages/diag packages/diag
COPY packages/db packages/db
COPY apps/api apps/api
COPY tsconfig.base.json biome.json turbo.json ./
RUN pnpm --filter @squad/shared-config build
RUN pnpm --filter @squad/shared-types build
RUN pnpm --filter @squad/bridge-client build
RUN pnpm --filter @squad/diag build
RUN pnpm --filter @squad/db build
RUN pnpm --filter @squad/api build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app /app
RUN pnpm install --frozen-lockfile --prod
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "--enable-source-maps", "dist/index.js"]
