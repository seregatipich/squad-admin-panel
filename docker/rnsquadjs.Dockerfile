# RNSquadJS sidecar image.
# Upstream is pinned by SHA (no release tags exist on the upstream repo).
# panelBridge overlay plugin is baked in from our monorepo.

ARG RNSQUADJS_REPO=https://github.com/lACTEPUKCl/RNSquadJS.git
ARG RNSQUADJS_SHA=d76fb4a84bc64ae09b654d4dc17ab06ef308d295

FROM node:18.18-bookworm-slim AS upstream
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ARG RNSQUADJS_REPO
ARG RNSQUADJS_SHA
RUN git clone "$RNSQUADJS_REPO" . \
    && git checkout "$RNSQUADJS_SHA" \
    && git rev-parse HEAD > /UPSTREAM_SHA
RUN corepack enable && yarn install --frozen-lockfile --network-timeout 600000

FROM node:18.18-bookworm-slim AS plugin
WORKDIR /plugin
COPY docker/rnsquadjs/plugins/panelBridge/package.json docker/rnsquadjs/plugins/panelBridge/tsconfig.json docker/rnsquadjs/plugins/panelBridge/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY docker/rnsquadjs/plugins/panelBridge/src ./src
RUN npx tsc -p tsconfig.json

FROM node:18.18-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=upstream /src /app
COPY --from=upstream /UPSTREAM_SHA /UPSTREAM_SHA
COPY --from=plugin   /plugin/dist            /app/lib/plugins/panelBridge
COPY --from=plugin   /plugin/node_modules/ioredis /app/node_modules/ioredis
COPY --from=plugin   /plugin/node_modules/uuid    /app/node_modules/uuid
COPY docker/rnsquadjs/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# uid 1001 matches the squad-server container's runtime user and the host-side
# ownership the bridge sets on /var/lib/squad-panel/saved/{uuid}/ trees.
USER 1001:1001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
