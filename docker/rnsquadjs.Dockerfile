# RNSquadJS sidecar image.
# Upstream is pinned by SHA (no release tags exist on the upstream repo).
# The panelBridge plugin is compiled INTO upstream at build time (deviation D6):
# its sources are dropped into src/plugins/panelBridge/ and a patch registers it
# in upstream's static plugin registry, so `yarn build` (rollup) bundles it into
# lib/index.js alongside the rest of the application.

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
# ioredis/uuid are panelBridge runtime deps absent from upstream's manifest.
# `yarn add` mutates upstream's package.json + lockfile, but that mutation is
# confined to this image layer (the lockfile is never copied back into the repo).
RUN yarn add ioredis@^5.4.1 uuid@^14 --network-timeout 600000
# panelBridge sources compile inside upstream's tree. Their relative imports are
# extensionless to match upstream's moduleResolution:node so rollup resolves them.
COPY docker/rnsquadjs/plugins/panelBridge/src/ src/plugins/panelBridge/
COPY docker/rnsquadjs/upstream.patch /tmp/upstream.patch
RUN git apply --check /tmp/upstream.patch && git apply /tmp/upstream.patch
RUN yarn build

FROM node:18.18-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The built tree already carries lib/ (rollup output incl. the bundled
# panelBridge) and node_modules (incl. ioredis/uuid), so the runtime needs
# nothing copied from a separate plugin stage.
COPY --from=upstream /src /app
COPY --from=upstream /UPSTREAM_SHA /UPSTREAM_SHA
COPY docker/rnsquadjs/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# uid 1001 matches the squad-server container's runtime user and the host-side
# ownership the bridge sets on /var/lib/squad-panel/saved/{uuid}/ trees.
USER 1001:1001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
