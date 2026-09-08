# SquadJS2 sidecar image for the panel.
#
# Derived from the verified release of our own SquadJS2 build pipeline: the base
# is pinned by digest (never a tag) so the running container's
# /usr/share/squadjs/build-identity.json always matches a known CI run. See
# ai_docs/squadjs2-pin-2026-08-24.md for the pin, its provenance and the
# compatibility checklist that gates every bump.
#
# Unlike the RNSquadJS image this one does NOT build upstream from source and
# applies no patches: SquadJS2 auto-discovers every *.js file in
# squad-server/plugins/, so the plugin is a plain COPY.

ARG SQUADJS2_DIGEST=sha256:8982c90899212c23a1042033bd762a7e3defcd7d9888712cea89b0554a46c48a

# Plugin runtime dependencies, resolved in isolation. They are deliberately NOT
# installed into /app/node_modules: `yarn add` there would re-resolve upstream's
# whole dependency graph and the image would no longer be the verified build.
# Node resolves them from squad-server/plugins/node_modules instead, which only
# the panel plugin sits under.
FROM node:20-alpine AS deps
WORKDIR /deps
RUN npm install --no-save --no-audit --no-fund ioredis@5.10.1 uuid@14.0.0

FROM ghcr.io/breaking-squad/squadjs@${SQUADJS2_DIGEST}
USER root
COPY --from=deps --chown=1000:1000 /deps/node_modules /app/squad-server/plugins/node_modules
# Copy the plugin file-by-file. A wildcard would also drop the package's local
# base-plugin.js test double on top of upstream's real one.
COPY --chown=1000:1000 docker/squadjs2/plugins/panel-bridge/src/panel-bridge.js /app/squad-server/plugins/panel-bridge.js
COPY --chown=1000:1000 docker/squadjs2/plugins/panel-bridge/src/panel-bridge/ /app/squad-server/plugins/panel-bridge/
COPY docker/squadjs2/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh
# The bridge runs the sidecar as 1001:1001 over image files owned by 1000; the
# panel writes nothing inside the container and the rootfs is mounted read-only.
USER 1001:1001
# Replaces upstream's docker-entrypoint.sh, which renders config/$INSTANCE_NAME.json
# with envsubst into a writable /app/config.json — impossible under --read-only
# and unnecessary: the panel mounts a fully rendered config.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
