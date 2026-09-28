FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2-alpine
# Spared by the panel's docker prune (--filter label!=panel.preserve=true) so the
# previous release stays loaded for scripts/rollback-stand.sh.
LABEL panel.preserve=true
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
