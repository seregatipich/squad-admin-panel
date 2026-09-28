FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2-alpine
# panel.preserve=true keeps docker_prune (`docker system prune -a --filter
# label!=panel.preserve=true`) from deleting this image while it is unused.
LABEL panel.preserve=true
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
