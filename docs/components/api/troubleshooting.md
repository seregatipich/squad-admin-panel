# `api` — troubleshooting

## API container is unhealthy after `docker compose up -d`

```bash
docker compose logs api --since 2m
```

Most common causes:

- `APP_ENCRYPTION_KEY` missing or < 32 bytes (base64-decoded).
- `PANEL_PUBLIC_URL` not set — required for Steam OpenID `return_to` host-binding. The callback will fail with a host-mismatch error without it.
- `DATABASE_URL` / `REDIS_URL` unreachable. Check `docker compose ps postgres redis` first.
- `BRIDGE_SOCKET` not bind-mounted into the container (compare `compose.yml` `volumes:` for the `api` service).
- `panel` group missing inside the container (check `group_add: [panel]`).

## 429 on Steam callback after a single attempt

`@fastify/rate-limit` keys on IP. If you are behind Caddy and the panel sees `X-Forwarded-For` correctly, this is intentional after 5 wrong attempts. Otherwise check the `trustProxy` config in [`apps/api/src/server.ts`](../../../apps/api/src/server.ts).

## `/health` 200 but install WS fails immediately

Almost always a bridge / `panel`-group issue. See [`components/bridge/troubleshooting.md`](../bridge/troubleshooting.md).

## Audit chain shows a gap

See [`operations/troubleshooting.md`](../../operations/troubleshooting.md#audit-log-shows-a-gap-or-hash-mismatch).

## Useful logs / metrics

```bash
docker compose logs api --since 5m
docker compose logs api -f --tail=50
curl -sk https://${APP_DOMAIN}/metrics | grep '^http_'
```

`prom-client` ships HTTP duration buckets, route-level counters, and pool stats for Postgres and Redis under `/metrics`.
