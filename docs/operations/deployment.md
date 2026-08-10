# Deployment

Single-host deployment model. The entire panel stack runs via `docker compose up -d` on one Linux machine. The Go host bridge runs outside Docker as a systemd service.

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12.
- Docker Engine 24+ with Compose v2 (`docker compose version`).
- Go 1.25.11+ if building the bridge locally (binary can also be pre-built in CI).
- ~50 GB free disk for the `squad-depot` volume.
- `sudo` access on the host.

The `scripts/install-host-bridge.sh` script handles all one-time host setup. Run it before starting the stack. If `.env` already exists, the installer synchronizes `DATA_DIR` and `PANEL_GID` so compose bind mounts and bridge peer checks match the host.

## tk104 production deployment

`compose.tk104.yml` (deployed via `scripts/deploy-tk104.sh`, env file `.env.tk104`) is a
standalone compose file for the tk104 host — it does not extend `docker-compose.yml`. It
mirrors the same service topology (api/web/caddy + all workers + bridge socket mount on
`api`/workers that need it), adapted to tk104's Caddy DNS-01 Caddyfile and named-volume
storage instead of `${DATA_DIR}`-bind-mounted volumes for postgres/redis/caddy. Keep the
two files in sync by hand when the bridge-facing env/volumes on a worker change in
`docker-compose.yml`. `.env.tk104` additionally needs `PANEL_GID` and `DATA_DIR` set to
match the host's `panel` group and the data tree created by `install-host-bridge.sh`.

## CI/CD on self-hosted runners

Both GitHub Actions workflows (`ci`, `deploy-tk104`) run on **self-hosted runners**
(`runs-on: [self-hosted, linux, x64]`) — GitHub-hosted minutes are not used.

> **Runner ownership.** This org has **disabled repository-level self-hosted
> runners**, so jobs run on the **org-level** runner(s) (e.g. `selfhost-1`), not on
> tk104 itself. tk104 is therefore *not* a CI runner — the `deploy-tk104` job reaches
> it over SSH (below). An earlier setup registered two repo-level runners on tk104
> (`tk104-runner-{1,2}`); those no longer receive jobs under the org policy and have
> been disabled. To run CI on tk104 again it would have to be registered as an
> **org-level** runner (needs org-admin).

- **`ci`** runs on whatever self-hosted runner picks the job up. The `node` job's
  `postgres`/`redis` service containers publish to Docker-assigned host ports
  (`ports: [5432]` / `[6379]`) — a `Resolve service ports` step reads the assigned
  ports from the `job.services.*.ports[...]` context into
  `DATABASE_URL`/`REDIS_URL` **and** `TEST_DATABASE_URL`/`TEST_REDIS_URL` (the
  integration harness reads the `TEST_*` pair). This keeps the suite off any fixed
  ports and off a shared host's production Postgres/Redis. The `go` job runs inside a
  `golang:1.25.11` container for a clean filesystem, and the worker contract tests
  target the CI ephemeral redis rather than a fixed `6379`.
- **`deploy-tk104` deploys over SSH.** The `deploy` job (on the org runner, triggered
  by a push to `master`) writes the `TK104_SSH_KEY` secret to a deploy key, `rsync`s
  the checkout to `seregatipich@tk104.duckdns.org:~/apps/squad-admin-panel/`
  (excluding `.git`, `.env*`, `data`, build output), then runs
  `scripts/deploy-tk104.sh` on the host over SSH, and gates on the external
  `https://tk104.duckdns.org/health` probe.
- **`deploy-web-preview` redeploys only `web`, from `dev`.** Same workflow file,
  triggered by a `workflow_run` event once `ci` finishes green on `dev` (or manually
  via `workflow_dispatch` with `target: web`). It rsyncs `dev`'s checkout to the same
  `~/apps/squad-admin-panel/` directory and same `compose.tk104.yml` project as the
  `deploy` job above, then runs `scripts/deploy-tk104-web.sh`, which only rebuilds
  and restarts the `web` service (`docker compose ... build web` /
  `up -d --no-deps web`) — api/workers/postgres/redis keep running whatever `deploy`
  last shipped from `master`. Both jobs share the `deploy-tk104` concurrency group so
  they never touch the compose project at the same time, but this still means tk104
  serves **unpromoted `dev` code on the production frontend** between deploys —
  accepted tradeoff for a fast preview loop; promote `dev` → `master` as usual once a
  change is ready to actually ship. Per GitHub's `workflow_run`/`workflow_dispatch`
  semantics, this second job only activates once the workflow file itself has reached
  the default branch (`master`) — merging it into `dev` alone does not arm the
  trigger.

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
| `worker-seed-reward` | `docker/worker.Dockerfile` | Grants or revokes the configured seed reward role from rolling 30-day presence. |
| `worker-metrics-sampler` | `docker/worker.Dockerfile` | Samples `host_metrics` via bridge every 15 s, writes to `host:metrics` stream. |
| `worker-media-publisher` | `docker/worker.Dockerfile` | Publishes queued media to YouTube/Telegram. Shares the `media_data` volume with `api`; inert until `YOUTUBE_*`/`TELEGRAM_*` are set. |
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

Preferred path:

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

sudo ./scripts/bootstrap.sh
```

Manual path:

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Fill APP_DOMAIN, PANEL_PUBLIC_URL, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET
# Generate secrets: openssl rand -base64 32
# Save APP_ENCRYPTION_KEY offline — losing it makes RCON passwords unrecoverable.

sudo ./scripts/install-host-bridge.sh
# idempotent — creates panel group, systemd unit + socket, data tree, squad-depot volume,
# and updates DATA_DIR + PANEL_GID in .env when the file exists.

sudo usermod -aG panel "$USER" && newgrp panel

docker compose config --quiet
docker compose up -d --build
```

`migrator` runs before `api` starts. When `api` becomes healthy, Caddy begins routing. Open `https://${APP_DOMAIN}/login` and sign in via Steam — the first login becomes Owner. The first Owner session is then redirected through `/setup` to save the organization name.

## Staging deployment gate

Use the same single-host model for dev/staging as production. A staging host is ready only after these checks pass:

```bash
docker compose config --quiet
sg panel -c 'bash scripts/verify-bridge.sh'
docker compose ps
curl -sk https://${APP_DOMAIN}/health
curl -sk https://${APP_DOMAIN}/ready
curl -skI https://${APP_DOMAIN}/api/docs
```

Expected results:

- `verify-bridge.sh` exits `0` and covers every bridge RPC method.
- `/health` returns `{"status":"ok", ...}`.
- `/ready` returns HTTP 200 with `status:"ok"` and `checks.postgres`, `checks.redis`, `checks.bridge` equal to `ok`.
- `/api/docs` returns an HTTP 200/30x response from the API docs UI.
- A fresh panel can complete the Steam first-Owner login and organization-name setup.
- The dashboard loads and the bridge/worker health widgets do not report a persistent outage.

Dokploy can be used to build or restart the compose stack after the host has been prepared, but it is not a complete deployment boundary for this project. The host bridge, `panel` group, systemd socket/service, data tree, and `squad-depot` bind volume must be installed and verified outside Dokploy first.

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
docker compose build api web worker-rcon worker-log-ingest worker-config-sync worker-audit-archiver worker-event-partition worker-role-expirer worker-seed-reward worker-metrics-sampler
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
curl -sk https://${APP_DOMAIN}/ready           # {"status":"ok","checks":{"postgres":"ok","redis":"ok","bridge":"ok"}}
curl -skI https://${APP_DOMAIN}/api/docs        # API docs UI responds
```

The `/ready` endpoint returns 503 if any dependency is unhealthy.

## Backup (optional)

Enable the `backup` profile:

```bash
docker compose --profile backup up -d backup
```

Requires `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` in `.env`. Snapshots are taken daily at 03:00 UTC. Retention: 7 daily, 4 weekly, 6 monthly.

The `backup` service (image built from [`docker/restic.Dockerfile`](../../docker/restic.Dockerfile)) does **not** snapshot the raw data directories. Before every snapshot its `PRE_COMMANDS` produce **logical dumps** — `pg_dump -Fc` for Postgres and `redis-cli --rdb` for Redis — into the `backup_dump` volume (`${DATA_DIR}/backup-dump`), and restic snapshots that directory. Logical dumps restore cleanly into a fresh, freshly-migrated stack; a raw snapshot of live WAL/AOF files cannot guarantee that. `pg_dump`/`redis-cli` reuse `POSTGRES_PASSWORD` — no additional secret is required. The service waits for `postgres` and `redis` to be healthy (`depends_on`) before it starts.

### Disaster-recovery restore (manual)

Restore is a deliberate host operation, run with [`scripts/restore.sh`](../../scripts/restore.sh) — it is **not** automated (CI only exercises the mechanism, see below). Run a dry run first; it lists the snapshots and mutates nothing:

```bash
scripts/restore.sh                        # dry run — prints the plan and `restic snapshots`
scripts/restore.sh --apply                # destructive — overwrites live Postgres + Redis (latest)
scripts/restore.sh --apply --snapshot ID  # destructive — restore a specific restic snapshot id
```

`--apply` restores the selected snapshot (default `latest`; `--snapshot` takes a restic short/long id or `latest` and is regex-validated so it cannot smuggle arguments): it waits for `postgres` to be healthy, runs `pg_restore --clean --if-exists`, then reloads the Redis dataset. Run it with `sudo` if `${DATA_DIR}/redis` is not writable by your user — the Redis container owns those files (uid 999), and `--apply` rewrites them on the host. Redis is loaded via a one-off `redis-server` that reads the restored `dump.rdb` and rewrites it into an AOF, because the `redis` service runs with `--appendonly yes` and would otherwise ignore a bare `dump.rdb`.

### Backup/restore from the panel UI (INFRA-8-P1)

Operators with the `host:manage` permission get a **Настройки → Бэкапы** page (`/settings/backup`) that lists the restic snapshots, triggers a manual backup, and restores a chosen snapshot behind a strong typed confirmation (the operator must type the snapshot's short id). The API container has no docker socket, so these operations go through the Go host bridge — new RPCs `backup_snapshots` (`restic snapshots --json`), `backup_run` (`docker compose --profile backup run --rm backup backup`) and `backup_restore` (wraps `scripts/restore.sh --apply --snapshot <id>`) — behind the routes `GET/POST /api/v1/host/backups` and `POST /api/v1/host/backups/:id/restore` (audited `backup.run` / `backup.restore`).

Because the bridge shells out to `docker compose` and `scripts/restore.sh` from the panel's deploy directory, its systemd unit must set that directory so the RPCs inherit `.env` (`RESTIC_PASSWORD`, `POSTGRES_PASSWORD`):

```ini
# /etc/systemd/system/panel-host-bridge.service — [Service]
Environment=PANEL_COMPOSE_DIR=/opt/squad-admin-panel   # dir holding docker-compose.yml + .env + scripts/
# ProtectSystem=strict also requires the deploy dir on ReadWritePaths for the restore path.
```

Unset or non-absolute `PANEL_COMPOSE_DIR` makes the backup RPCs fail closed (`forbidden`), so the UI degrades to a clear error rather than running from an unexpected directory.

**Acceptance procedure (full `down -v` recovery).** This is the manual proof that a total-loss restore works. It destroys the live stack — run it only against a scratch host or a copy of production:

```bash
docker compose --profile backup up -d backup      # start the backup service
docker compose --profile backup run --rm backup backup   # force one snapshot now
docker compose --profile backup down -v            # stop everything, drop the volumes
rm -rf data/postgres/* data/redis/*                # bind mounts survive `down -v`; wipe them too
docker compose up -d postgres redis                # fresh, empty databases
scripts/restore.sh --apply                          # restore from the restic repository
```

Because the panel's volumes are host bind mounts (`type=none, o=bind`), `down -v` removes the volume definitions but leaves `${DATA_DIR}/{postgres,redis}` on disk; the `rm -rf` step is required to genuinely simulate data loss. The automated equivalent — build the image, dump, snapshot, `down -v`, restore, assert the seeded row and key survive — runs on every CI push via [`scripts/test-backup-restore.sh`](../../scripts/test-backup-restore.sh) in the `docker` job.

The full-stack version of this procedure is scripted in [`scripts/test-fullstack-down-v.sh`](../../scripts/test-fullstack-down-v.sh): it brings the **whole** compose stack up, seeds a canary, snapshots, runs the literal `down -v`, restores with `scripts/restore.sh --apply`, then asserts the api `/health` endpoint returns 200 (panel operational) and the seeded Postgres row + Redis key survived. It is **run-deferred** — building and running the entire stack twice plus a restic restore exceeds the self-hosted CI runner (2 vCPU / 4 GB, see #219), and it is destructive to the local stack — so it is **not** wired into CI and refuses to run unless explicitly opted in on a scratch host with Docker and ample RAM:

```bash
RUN_FULLSTACK_DOWN_V=1 bash scripts/test-fullstack-down-v.sh
```

## See also

- [`setup.md`](./setup.md) — initial host setup including first-owner claim.
- [`environment-variables.md`](./environment-variables.md) — full `.env` reference.
- [`migrations.md`](./migrations.md) — database migration workflow.
- [`monitoring.md`](./monitoring.md) — observability and diagnostics.
- [`docs/components/bridge/README.md`](../components/bridge/README.md) — bridge daemon details.
