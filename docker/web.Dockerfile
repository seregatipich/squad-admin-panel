FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS base
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

# Build toolchain: the web app's workspace closure with devDependencies, plus
# the root package for turbo.
FROM base AS deps
COPY --from=manifests /app/ ./
RUN pnpm install --frozen-lockfile --store-dir /pnpm/store \
      --filter "@squad/web..." --filter squad-admin-panel

# What the runtime ships: a clean production install, not a prune of `deps`,
# so no devDependency (Playwright, Vitest, Tailwind, TypeScript, #252) sits in
# a lower layer. It installs offline from the store `deps` already downloaded;
# the rw mount discards the store afterwards.
FROM base AS prod-deps
COPY --from=manifests /app/ ./
RUN --mount=type=bind,from=deps,source=/pnpm/store,target=/pnpm/store,rw \
    pnpm install --frozen-lockfile --prod --offline --store-dir /pnpm/store \
      --filter "@squad/web..."

# One turbo run builds the web app and its workspace packages in dependency
# order; its cache is off because it would die with this stage. /out gathers
# what `next start` serves, at the paths it serves them from: the build
# without its webpack cache, public/ with the vendored Monaco bundle, the
# config (rewrites, security headers) and the packages' dist.
FROM deps AS builder
ENV TURBO_TELEMETRY_DISABLED=1
ENV NEXT_TELEMETRY_DISABLED=1
COPY turbo.json ./
COPY packages/tsconfig.base.json packages/
COPY packages/shared-config packages/shared-config
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
RUN pnpm turbo run build --filter=@squad/web... --cache=local:,remote: && \
    rm -rf apps/web/.next/cache && \
    mkdir /out && \
    cp -a --parents packages/*/dist apps/web/.next apps/web/public apps/web/next.config.mjs /out/

FROM base AS runtime
# Spared by the panel's docker prune (--filter label!=panel.preserve=true) so the
# previous release stays loaded for scripts/rollback-stand.sh.
LABEL panel.preserve=true
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=prod-deps /app /app
COPY --from=builder /out /app
# node:22-bookworm-slim ships a non-root `node` user (uid/gid 1000); the
# publicly reachable Next.js server needs neither root nor the panel
# bridge/PANEL_GID (only api does), so it drops to it after the root-owned
# copies above.
RUN chown -R node:node /app
USER node
WORKDIR /app/apps/web
# Run as the image's unprivileged `node` user (#47). Next writes only its
# image-optimisation cache; everything else stays root-owned and read-only to
# the server. next is started directly: `pnpm start` goes through corepack,
# whose pnpm was activated into root's home at build time.
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The prod-deps install creates apps/web/node_modules/.bin/next as a symlink
# to next/dist/bin/next. Running it directly makes the Next.js server PID 1
# (correct SIGTERM handling, no extra pnpm process holding memory) instead of
# going through the pnpm CLI as an intermediate wrapper process.
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
