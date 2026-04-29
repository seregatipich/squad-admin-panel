# Troubleshooting (operations)

For component-specific issues, see [`components/bridge/troubleshooting.md`](../components/bridge/troubleshooting.md), [`components/api/troubleshooting.md`](../components/api/troubleshooting.md). This page is the operator-level entry point.

## `docker compose up -d` starts but the panel never loads

1. `docker compose ps` — every container should be `healthy` (takes up to 2 min).
2. If `api` is unhealthy: `docker compose logs api --since 2m`. See [`components/api/troubleshooting.md`](../components/api/troubleshooting.md).
3. If `caddy` is unhealthy: it's almost always TLS — confirm `TLS_ISSUER` is reachable (`acme` requires the public DNS for `APP_DOMAIN`).
4. `curl -k https://${APP_DOMAIN}/health` should return `{"status":"ok"}`.

## "bridge: disconnected" banner

See [`components/bridge/troubleshooting.md`](../components/bridge/troubleshooting.md#bridge-disconnected-banner-in-the-dashboard).

## Squad server doesn't appear in the Steam community browser

Squad v10 does not respond to A2S queries. Visibility depends on the EOS session being reachable publicly. Things to check:

- Host has a public IPv4 (not behind CGNAT).
- `Server.cfg` has `ShouldAdvertise=true` (default).
- `IsLANMatch=false` (default).
- UFW allows game/query/beacon ports — `ufw status` on the host.
- `License.cfg` is populated. The panel does not ship a Squad license key — operators must drop it in manually after install (free, per-operator, from Offworld Industries). If empty, the server log shows `Warning: [LogEOSSessions] Session will be created, but user lacks permission to advertise presence`.
- Give it 1–3 minutes after start; first registration with EOS takes a moment.

## Audit log shows a gap or hash mismatch

`pnpm verify:audit-chain` exits non-zero with the first broken row id. Treat as an incident:

1. `SELECT * FROM audit_log WHERE id BETWEEN <broken-5> AND <broken+5>;`
2. Check the DB host for unauthorised access (pg_dump timestamps, `SELECT usename, state FROM pg_stat_activity`).
3. Restore `audit_log` from the latest backup (the restic sidecar keeps daily snapshots when `RESTIC_REPOSITORY` is set); a mismatch past the last-good commit means the chain really was tampered with.

The trigger prevents application-level tampering; only a superuser with raw DB access can modify these rows, and even then the chain breaks on verify.

## `worker-metrics-sampler` keeps logging `socket closed` / `write EPIPE`

The host bridge authorises peers via `getsockopt(SO_PEERCRED)` and checks the peer's **primary** GID against the `panel` group. Supplementary groups added inside the container via Compose `group_add` are not visible to the bridge across the host's user namespace. Confirm the worker's compose entry uses `user: "0:${PANEL_GID:-987}"` (root uid, primary gid `panel`):

```bash
docker compose config worker-metrics-sampler | grep -E "user:|group_add"
docker compose exec worker-metrics-sampler id        # gid= must equal PANEL_GID, not 0
sudo getent group panel | cut -d: -f3                 # the host gid
```

If `gid=0`, the bridge will refuse the connection. Apply `user: "0:${PANEL_GID:-987}"` to the service in `docker-compose.yml`, then `docker compose up -d worker-metrics-sampler`. The same requirement applies to any other worker that bind-mounts `/run/panel-host-bridge/bridge.sock` (`worker-log-ingest`, `api`).

## The `/logs` page is empty even though servers are running

Sources:

1. The pino multistream sink in api/workers writes lines into `panel:logs` only after `redisPlugin` has registered (api) or after the worker's pino is constructed inside `main()` after Redis (workers). If Redis itself is down the sink writes one stderr warning and silently drops every subsequent line. Check `docker compose logs api worker-rcon worker-log-ingest worker-metrics-sampler --since 2m` for an `[log-stream-sink]` warning.
2. `docker compose exec redis redis-cli XLEN panel:logs` should be ≥ a few thousand on a healthy panel within a minute of boot. If it's `0` the sink isn't reaching Redis.
3. `docker compose exec redis redis-cli XLEN host:metrics` confirms `worker-metrics-sampler` is writing too — it's the same sink wiring.
4. The `/logs` page itself filters by `lvl=info` minimum by default; switch to `≥ debug` to see the bridge heartbeat lines that fire every 5 s.

## A worker stops sending heartbeats

`/api/v1/health/workers` shows `alive: false` for the worker. Steps:

```bash
docker compose logs worker-rcon --since 5m            # or whichever worker
redis-cli -h $REDIS_HOST GET worker:heartbeat:rcon    # should be a recent JSON blob
docker compose restart worker-rcon
```

If restarts don't help, capture `docker compose logs worker-rcon` and open an issue.

## Steam login

### "Доступ запрещён" on `/no-access` after Steam login

The Steam ID has no panel role. An admin needs to assign one:

1. Owner opens `/players/<their_steam_id64>` in the panel.
2. Section "Доступ к панели" → "Назначить роль" dropdown → pick role → "Назначить".
3. The user logs in via Steam again. Their next callback now resolves to a player with non-empty permissions and they are redirected to `/`.

### `owner_role_missing` 500 on first login

The system roles weren't seeded by the DB migration. Verify `SELECT name FROM roles` returns at least `Owner`. If empty, the migration didn't run — run `pnpm db:migrate` against the live database, then retry login.

### Audit chain broken after migration 0008

Migration 0008 drops and recreates `audit_log`. The hash chain restarts from `prev_hash = NULL`. `pnpm verify:audit-chain` will be green going forward; rows from before migration 0008 are gone with the table.

## Useful commands

```bash
docker compose ps
docker compose logs <service> --since 5m
docker compose logs -f <service>
sudo systemctl status panel-host-bridge
sudo journalctl -u panel-host-bridge -f
sg panel -c 'bash scripts/verify-bridge.sh'
DATABASE_URL=... pnpm verify:audit-chain
```
