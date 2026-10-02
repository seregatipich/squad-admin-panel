# RNSquadJS sidecar image.
# Upstream is pinned by SHA (no release tags exist on the upstream repo).
# The panelBridge plugin is compiled INTO upstream at build time (deviation D6):
# its sources are dropped into src/plugins/panelBridge/ and a patch registers it
# in upstream's static plugin registry, so `yarn build` (rollup) bundles it into
# lib/index.js alongside the rest of the application.

ARG RNSQUADJS_REPO=https://github.com/lACTEPUKCl/RNSquadJS.git
ARG RNSQUADJS_SHA=aa3806477c3e827d5ac05a8118b0120089938589

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS upstream
ARG YARN_VERSION=1.22.22
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# В upstream есть lockfile Yarn v1, но нет поля packageManager. Без точной
# активации Corepack запрашивает у npm yarn/latest при каждой холодной сборке,
# а его короткий таймаут делал CI нестабильным. Повторяем только одну
# неизменяемую версию с небольшими ограниченными паузами.
RUN corepack enable \
    && prepared=false \
    && for delay in 0 2 5; do \
         [ "$delay" = 0 ] || sleep "$delay"; \
         if corepack prepare "yarn@${YARN_VERSION}" --activate; then \
           prepared=true; \
           break; \
         fi; \
       done \
    && [ "$prepared" = true ] \
    && test "$(yarn --version)" = "$YARN_VERSION"
WORKDIR /src
ARG RNSQUADJS_REPO
ARG RNSQUADJS_SHA
RUN git clone "$RNSQUADJS_REPO" . \
    && git checkout "$RNSQUADJS_SHA" \
    && git rev-parse HEAD > /UPSTREAM_SHA
RUN yarn install --frozen-lockfile --network-timeout 600000
# ioredis/uuid are panelBridge runtime deps absent from upstream's manifest.
# `yarn add` mutates upstream's package.json + lockfile, but that mutation is
# confined to this image layer (the lockfile is never copied back into the repo).
# Versions are exact so rebuilds resolve the same graph the plugin was tested with.
# Yarn already retries individual HTTP requests, but the registry may still drop
# the TLS connection after those retries. Repeat only this idempotent exact add,
# with bounded pauses, and fail the layer after the third unsuccessful attempt.
RUN deps_installed=false \
    && for delay in 0 5 10; do \
         [ "$delay" = 0 ] || sleep "$delay"; \
         if yarn add ioredis@5.10.1 uuid@14.0.0 --exact --network-timeout 600000; then \
           deps_installed=true; \
           break; \
         fi; \
       done \
    && [ "$deps_installed" = true ]
# panelBridge sources compile inside upstream's tree. Their relative imports are
# extensionless to match upstream's moduleResolution:node so rollup resolves them.
COPY docker/rnsquadjs/plugins/panelBridge/src/ src/plugins/panelBridge/
COPY docker/rnsquadjs/upstream.patch /tmp/upstream.patch
RUN git apply --check /tmp/upstream.patch && git apply /tmp/upstream.patch
RUN yarn build
# rollup/typescript and the rest of devDependencies are only needed to
# produce lib/; prune them so the runtime stage's copy of node_modules doesn't
# carry build tooling into the image that runs with --network host.
RUN yarn install --production=true --frozen-lockfile --network-timeout 600000

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS runtime
# Sidecars are launched with `--pull never` (docker/compose.yml), like
# squad-server and depot-init, so this tag must survive on the host between
# deploys. `panel.preserve=true` exempts it from SystemPrune's
# `label!=panel.preserve=true` filter (apps/bridge/internal/runner/docker.go)
# the same way squad-server.Dockerfile and depot-init.Dockerfile do.
LABEL panel.preserve=true panel.kind=rnsquadjs
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Only what upstream executes is copied (#75, audit 1039): lib/ (rollup output
# incl. the bundled panelBridge and the map JSON that `yarn build` copies next
# to it), the production-only node_modules (incl. ioredis/uuid) and
# package.json (`"type": "module"` makes node load lib/*.js as ESM). Upstream
# reads its settings from ../config.json relative to lib/ (src/utils.ts), which
# the bridge bind-mounts at /app/config.json; every other path it touches comes
# from that config. The source tree, the full .git history and build tooling
# stay in the upstream stage. scripts/test-rnsquadjs-runtime-copy.sh guards the
# copy list.
COPY --from=upstream /src/lib /app/lib
COPY --from=upstream /src/node_modules /app/node_modules
COPY --from=upstream /src/package.json /app/package.json
COPY --from=upstream /UPSTREAM_SHA /UPSTREAM_SHA
COPY docker/rnsquadjs/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# uid 1001 matches the squad-server container's runtime user and the host-side
# ownership the bridge sets on /var/lib/squad-panel/saved/{uuid}/ trees.
USER 1001:1001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
