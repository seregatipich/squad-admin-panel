# `api` — troubleshooting

## API container is unhealthy after `docker compose up -d`

```bash
docker compose logs api --since 2m
```

Most common causes:

- `APP_ENCRYPTION_KEY` missing or < 32 bytes (base64-decoded).
- `DATABASE_URL` / `REDIS_URL` unreachable. Check `docker compose ps postgres redis` first.
- `BRIDGE_SOCKET` not bind-mounted into the container (compare `compose.yml` `volumes:` for the `api` service).
- `panel` group missing inside the container (check `group_add: [panel]`).

## "This user doesn't exist" but the row is in the DB

The email lookup is case-insensitive (`lower(email) UNIQUE`). Confirm:

```sql
SELECT id, email FROM users WHERE lower(email) = lower('USER@example.com');
```

## TOTP recovery without a backup code

Backup codes + TOTP secret are Argon2id-hashed and AES-256-GCM-encrypted respectively, so the panel cannot recover them. Recovery is a DB-level operation (Owner only):

```sql
UPDATE users
   SET totp_secret_encrypted = NULL,
       totp_backup_codes_hash = NULL,
       totp_last_used_step = NULL
 WHERE id = (SELECT id FROM users WHERE lower(email) = lower('owner@example.com'));
```

## 429 on login after a single attempt

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
