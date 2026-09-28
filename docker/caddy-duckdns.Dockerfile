# This image holds DUCKDNS_TOKEN and the production TLS private key, so its
# base images and the duckdns module are pinned rather than left floating
# (repo policy: workflow actions are SHA-pinned for the same reason).
# Dependabot's docker ecosystem (.github/dependabot.yml) tracks these digests.
FROM caddy:2-builder@sha256:369218c81ca6d6af249981221b3a5c764d886dd5b058f51d144066de13f2418d AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
