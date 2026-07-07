# Deployment

Single-host deployment model. The entire panel stack runs via `docker compose up -d` on one Linux machine. The Go host bridge runs outside Docker as a systemd service.

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12.
- Docker Engine 24+ with Compose v2 (`docker compose version`).
- Go 1.25.11+ if building the bridge locally (binary can also be pre-built in CI).
- ~50 GB free disk for the `squad-depot` volume.
- `sudo` access on the host.

The `scripts/install-host-bridge.sh` script handles all one-time host setup. Run it before starting the stack.

## tk104 production deployment

`compose.tk104.yml` (deployed via `scripts/deploy-tk104.sh`, env file `.env.tk104`) is a
standalone compose file for the tk104 host — it does not extend `docker-compose.yml`. It
mirrors the same service topology (api/web/caddy + all workers + bridge socket mount on
`api`/workers that need it), adapted to tk104's Caddy DNS-01 Caddyfile and named-volume
storage instead of `${DATA_DIR}`-bind-mounted volumes for postgres/redis/caddy. Keep the
two files in sync by hand when the bridge-facing env/volumes on a worker change in
`docker-compose.yml`. `.env.tk104` additionally needs `PANEL_GID` and `DATA_DIR` set to
match the host's `panel` group and the data tree created by `install-host-bridge.sh`.

## Container topology

| Service | Image | Notes |
|---|---|---|
| `caddy` | `caddy:2-alpine` | TLS termination + reverse proxy. Ports 80 + 443. |
| `api` | `docker/api.Dockerfile` | Fastify 5, port 3000 (internal only). |
| `web` | `docker/web.Dockerfile` | Next.js 15 SSR, internal only, proxied by Caddy. |
| `migrator` | `docker/api.Dockerfile` | One-shot: runs Drizzle migrations then exits. |
| `postgres` | `postgres:16-alpine` | Port 5432, bound to `127.0.0.1` only. |
| `redis` | `redis:7-alpine` | Port 6379, bound to `127.0.0.1` only. Append-only persistence. |
| `worker-log-ingest` | `docker/worker.Dockerfile` | Tails squad container logs via bridge, writes events to Redis Streams. |
| `worker-rcon` | `docker/worker.Dockerfile` | `--network host`. RCON poller (ListPlayers every 30 s). |
| `worker-config-sync` | `docker/worker.Dockerfile` | Consumes Admins.cfg sync events and writes managed role/group segments. |
| `worker-audit-archiver` | `docker/worker.Dockerfile` | Cold-archives `audit_log` rows older than 90 days. |
| `worker-event-partition` | `docker/worker.Dockerfile` | Monthly Postgres partition rotation. |
| `worker-role-expirer` | `docker/worker.Dockerfile` | Clears expired player roles and enqueues Admins.cfg sync. |
| `worker-metrics-sampler` | `docker/worker.Dockerfile` | Samples `host_metrics` via bridge every 15 s, writes to `host:metrics` stream. |
| `backup` (optional) | `mazzolino/restic:latest` | Profile `backup`. Daily restic snapshot of postgres + redis volumes. |

### Bridge daemon (host, not Docker)

`panel-host-bridge` runs as a systemd service outside compose. It listens on `/run/panel-host-bridge/bridge.sock` (Unix socket, 0660 `root:panel`). Containers that need bridge access bind-mount the socket and run with primary GID = `panel` GID.

## Volumes

All named volumes are bind-mounted from `${DATA_DIR}` (set in `.env`). `install-host-bridge.sh` creates this directory tree automatically.

| Volume | Bind source | Contents |
|---|---|---|
| `postgres_data` | `${DATA_DIR}/postgres` | Postgres WAL + data files. |
| `redis_data` | `${DATA_DIR}/redis` | Redis AOF. |
| `caddy_data` | `${DATA_DIR}/caddy-data` | TLS certificates. |
| `caddy_config` | `${DATA_DIR}/caddy-config` | Caddy auto-config. |
| `backup_repo` | `${DATA_DIR}/backup-repo` | Restic repository (optional). |
| `squad-depot` | `${DATA_DIR}/depot` | Steam-fetched Squad game files (~45 GB). Populated once by `depot_update`. |

Per-server configs and saved state live at `/var/lib/squad-panel/` (a symlink to `${DATA_DIR}/servers/`) on the host, bind-mounted into each Squad container.

## TLS

Caddy handles TLS automatically. Set `TLS_ISSUER` in `.env`:

| Value | Behavior |
|---|---|
| `internal` (default) | Self-signed local CA. Good for dev and LAN deployments. |
| `acme` | Let's Encrypt (or other ACME CA). Requires a public DNS name in `APP_DOMAIN` and a valid `ACME_EMAIL`. |

## First deploy

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Fill APP_DOMAIN, PANEL_PUBLIC_URL, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET
# Generate secrets: openssl rand -base64 32
# Save APP_ENCRYPTION_KEY offline — losing it makes RCON passwords unrecoverable.

sudo ./scripts/install-host-bridge.sh
# idempotent — creates panel group, systemd unit + socket, data tree, squad-depot volume

sudo usermod -aG panel "$USER" && newgrp panel

docker compose up -d --build
```

`migrator` runs before `api` starts. When `api` becomes healthy, Caddy begins routing. Open `https://${APP_DOMAIN}/login` and sign in via Steam — the first login becomes Owner.

## Image rebuild flow

After changing TypeScript source:

```bash
# Rebuild only affected services — faster than a full build
docker compose build api
docker compose build web
docker compose build worker-rcon worker-log-ingest worker-metrics-sampler

# Apply and restart
docker compose up -d api web worker-rcon worker-log-ingest worker-metrics-sampler
```

After changing the Go bridge:

```bash
cd apps/bridge && make build
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
# Note: `cp` fails with "Text file busy" on a running binary — always use `install`.
```

## Panel update procedure

```bash
git pull
pnpm install
docker compose build api web worker-rcon worker-log-ingest worker-config-sync worker-audit-archiver worker-event-partition worker-role-expirer worker-metrics-sampler
docker compose up -d
```

Migrations run automatically when the `migrator` service starts as part of `docker compose up -d`. No manual migration step is needed for panel updates.

If the bridge binary changed:

```bash
cd apps/bridge && make build
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
```

## Rollback

1. `git checkout <previous-tag>`
2. `pnpm install`
3. Rebuild and restart affected services.
4. Database migrations are forward-only. If the new schema has destructive changes, refer to [`migrations.md`](./migrations.md) for the manual rollback procedure.

## Verifying a deployment

```bash
sg panel -c 'bash scripts/verify-bridge.sh'   # bridge RPC smoke test
curl -sk https://${APP_DOMAIN}/health          # {"status":"ok"}
curl -sk https://${APP_DOMAIN}/ready           # {"status":"ready","checks":{"postgres":"ok","redis":"ok","bridge":"ok"}}
```

The `/ready` endpoint returns 503 if any dependency is unhealthy.

## Backup (optional)

Enable the `backup` profile:

```bash
docker compose --profile backup up -d backup
```

Requires `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` in `.env`. Snapshots are taken daily at 03:00 UTC. Retention: 7 daily, 4 weekly, 6 monthly.

## See also

- [`setup.md`](./setup.md) — initial host setup including first-owner claim.
- [`environment-variables.md`](./environment-variables.md) — full `.env` reference.
- [`migrations.md`](./migrations.md) — database migration workflow.
- [`monitoring.md`](./monitoring.md) — observability and diagnostics.
- [`docs/components/bridge/README.md`](../components/bridge/README.md) — bridge daemon details.
