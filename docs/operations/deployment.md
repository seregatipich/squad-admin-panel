# Deployment

Single-host deployment model. The entire panel stack runs via `docker compose up -d` on one Linux machine. The Go host bridge runs outside Docker as a systemd service.

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12.
- Docker Engine 24+ with Compose v2 (`docker compose version`).
- Go 1.25.13+ if building the bridge locally (binary can also be pre-built in CI).
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

`scripts/deploy-tk104.sh` считается успешным только после двух обязательных
проверок: сервис `api` должен получить Compose health `healthy` не позднее 120
секунд, затем локальный HTTPS-запрос через Caddy должен вернуть успешный HTTP-код
(`curl --fail`). Таймаут API, сетевой сбой и HTTP 4xx/5xx завершают deploy
ненулевым кодом до сообщения `Deploy complete`.

## Вход через Steam и выпуск

Панель подтверждает Steam-личность сама через Steam OpenID:
`/api/v1/auth/steam/login` отправляет пользователя на steamcommunity.com, а
`/api/v1/auth/steam/callback` проверяет ответ, создаёт сессию и выдаёт права по
RBAC панели. Realm и адрес возврата строятся из `PANEL_PUBLIC_URL`, поэтому в
production он обязан быть HTTPS-origin (`https://tk104.duckdns.org`); иначе API
не стартует. Первый вошедший игрок становится Owner и проходит `/setup`.

Полный выпуск `master` передаёт в команду деплоя `APP_VERSION=<SHA master>`;
`/health.version` после выпуска обязан совпасть с этим SHA, иначе задание
падает на внешней проверке.

Автоматический полный выпуск запускается только push-событием ветки `master`.
Для ручного `target=full` выбери `master` и обязательно передай
`expected_sha=<выбранный SHA>`: несовпадение останавливает задание первым шагом,
до checkout, SSH и любых изменений production.

Оба задания `deploy-tk104` удаляют временный ключ SSH и отдельный файл доверия с
раннера в `always()`. Каждое задание принимает ключ хоста только из заранее
сверенного Actions secret `TK104_SSH_KNOWN_HOSTS`, проверяет запись для
`tk104.duckdns.org` и использует `StrictHostKeyChecking=yes`; runtime
`ssh-keyscan` и доверие при первом подключении запрещены. При плановой смене
ключа оператор сначала сверяет новый fingerprint по независимому доверенному
каналу, затем заменяет secret. Контракт закреплён в
`scripts/deploy-tk104-workflow.test.ts`.

### Интеграция bss.games удалена

До 2026-09-16 вход шёл через SSO bss.games, а магазин сайта выдавал VIP через
подписанный webhook `/api/v1/integrations/vip/*` со строгим режимом ревизий.
Миграция `0115_remove_bss_integration` удаляет триггеры и функции этого режима,
таблицу `vip_lifecycle_events`, столбцы `players.role_lifecycle_event_id` и
`panel_meta.vip_lifecycle_strict`, отзывает API-токен сайта и деактивирует тир
`BSS VIP`. Роли и сроки уже купленных VIP остаются у игроков, дальше их снимает
`worker-role-expirer`. После первого выпуска удалите из `.env.tk104` ключи
`BSS_*` и `VIP_LIFECYCLE_*`, а из Actions secrets — `BSS_SSO_SHARED_SECRET` и
`PANEL_READ_API_TOKEN`: их больше ничто не читает.

## CI/CD runners

Verification and deployment run on different machines:

```yaml
# .github/workflows/ci.yml — every job
runs-on: ubuntu-24.04
# .github/workflows/deploy-tk104.yml — every job
runs-on: [self-hosted, tk104-deploy]
environment: production
```

The repository is public on a personal account: hosted minutes are free and runner
groups do not exist. `scripts/test-ci-runner-strategy.sh` fails CI if a `ci` job leaves
the hosted image, a deploy job leaves the labelled runner or the `production`
environment, or any workflow selects a runner group.

- **`ci` runs on GitHub-hosted VMs.** The workflow runs only for trusted `dev`/`master`
  pushes and explicit dispatches — never `pull_request`. Superseded runs are cancelled.
  The JavaScript checks run in parallel (`node-lint`, the `api`/`web`/`packages` slices
  of `node-test`, `node-scripts`) behind the single `node` gate. Their PostgreSQL/Redis
  service containers publish to Docker-assigned ports; `Resolve service ports` exports
  those values through both normal and `TEST_*` variables. The `go` job installs the
  pinned Go toolchain through SHA-pinned `actions/setup-go` and runs the race detector
  natively. The `docker` job, running alongside the tests, builds
  [`docker-bake.hcl`](../../docker-bake.hcl) in parallel with a GitHub Actions layer
  cache, smoke-tests the api and workers images, executes the backup/restore round
  trip, and on a `dev` push exports `squad-panel/{api,web,workers,caddy-tk104}:<sha>`
  as the `release-images-<sha>` artifact (zstd, kept 14 days). On `master` every job
  except `branch-guard` skips: the commit already passed them on `dev`, and
  `branch-guard` fails unless that `dev` run succeeded.
- **`deploy-tk104` runs on the repository's own runner on tk104.** It is registered
  with the label `tk104-deploy`, runs as the unprivileged `gh-runner` account without
  Docker access, and reaches the deploy account over SSH. Every job binds the
  `production` environment (deploy secrets, `master` only) and is skipped outside
  `seregatipich/squad-admin-panel`, so a fork never tries to deploy. All referenced
  actions remain SHA-pinned — this workflow writes the production deploy key to disk
  (#248). Workflows from outside collaborators require approval (repository setting),
  because a fork's pull request can carry its own workflow file.
- **`deploy-tk104` loads release images; tk104 never builds.** The `deploy` job
  (a push to `master`) looks up the successful `ci` **push** run of that exact commit
  on `dev` and refuses to continue without one — a manual `ci` dispatch of the same
  commit uploads no images, so it never counts — downloads its `release-images-<sha>`
  artifact, pipes it into `docker load` on tk104 over SSH, `rsync`s the checkout to
  `seregatipich@tk104.duckdns.org:~/apps/squad-admin-panel/` (excluding `.git`,
  `.env*`, `data`, build output and the `.release` markers), and runs
  `PANEL_IMAGE_TAG=<sha> APP_VERSION=<sha> scripts/deploy-tk104.sh`. That script
  checks the four images are loaded, runs `compose up -d --remove-orphans` (the
  migrator first), waits for the api and the Caddy probe, records the tag in
  `.release` (the one before it in `.release.prev`) and in `.env.tk104`, and prunes
  release images beyond the newest three — never the running or previous tag. The
  job then gates on the external `https://tk104.duckdns.org/health` reporting that
  SHA. `compose.tk104.yml` names every panel service `squad-panel/<image>:${PANEL_IMAGE_TAG}`
  with `pull_policy: never`, so nothing is fetched from a registry.
- **`deploy-web-preview` restarts only `web`, from `dev`.** Same workflow file,
  triggered by a `workflow_run` event once `ci` finishes green on `dev` (or manually
  via `workflow_dispatch` with `target: web` and `expected_sha=<dev commit>`). It
  loads that run's images the same way, then runs `scripts/deploy-tk104-web.sh`,
  which only restarts the `web` service on the preview tag
  (`up -d --no-deps web`) — api/workers/postgres/redis keep running whatever
  `deploy` last shipped from `master`. Both jobs share the `deploy-tk104`
  concurrency group so they never touch the compose project at the same time, but
  this still means tk104 serves **unpromoted `dev` code on the production
  frontend** between deploys — accepted tradeoff for a fast preview loop; promote
  `dev` → `master` as usual once a change is ready to actually ship. Per GitHub's
  `workflow_run`/`workflow_dispatch` semantics, this second job only activates once
  the workflow file itself has reached the default branch (`master`) — merging it
  into `dev` alone does not arm the trigger.

### Rollback

On tk104, from `~/apps/squad-admin-panel`:

```bash
bash scripts/rollback-tk104.sh                 # the release recorded in .release.prev
ROLLBACK_TO=<loaded tag> bash scripts/rollback-tk104.sh
```

It reruns `deploy-tk104.sh` on the previous tag, whose images the host keeps
loaded, so it takes about as long as a container restart. It does not undo
migrations — which is why every migration must stay compatible with the release
before it (AGENTS.md). If a release artifact expired before promotion, re-run the
`docker` job of that commit's `dev` `ci` run, or build the tag on the host with
`PANEL_IMAGE_TAG=<sha> DEPLOY_BUILD=1 bash scripts/deploy-tk104.sh` (slow, and it
competes with the game server for CPU).

### Fast developer deploy (`scripts/dev-deploy-tk104.sh`)

Both jobs above wait for a full CI run. For the inner loop,
[`scripts/dev-deploy-tk104.sh`](../../scripts/dev-deploy-tk104.sh) rsyncs the
tree to `~/apps/squad-admin-panel/` and builds one service of the same
`compose.tk104.yml` project on the host, through the
[`compose.tk104.build.yml`](../../compose.tk104.build.yml) override, tagged
`dev-<short sha>` — straight from a developer workstation over SSH, with no
GitHub Actions involved. The deploy target is still tk104; only the courier
changes, and the build does run on the production host.

```bash
scripts/dev-deploy-tk104.sh              # rebuild web only (default)
scripts/dev-deploy-tk104.sh api          # rebuild api only, no migrator
scripts/dev-deploy-tk104.sh worker-rcon  # rebuild one worker container
CONFIRM_FULL_DEPLOY=deploy scripts/dev-deploy-tk104.sh full
```

It ships the **working tree**, uncommitted changes included, so what tk104
serves afterwards is not a released revision: the stamp it sets is
`dev-<short sha>` (plus `-dirty`) where a released deploy stamps a 40-hex
commit SHA. `/health` is served by the api container and reports that stamp
only for the `api` and `full` targets — a web-only deploy deliberately leaves
the api, and therefore `/health`, on the last released revision. `.env*`, `data/` and build output are excluded exactly as in the
workflow, so host secrets and state survive. The `full` target runs
`scripts/deploy-tk104.sh`, which applies migrations from unreviewed code to the
production database, and therefore refuses to start without
`CONFIRM_FULL_DEPLOY=deploy`.

This is a preview path, not a release path: land the change through
`dev` → `master` as usual, and the next `master` deploy overwrites the preview.
Contracts: `scripts/operations-scripts.test.ts` (part of `pnpm test:scripts`).

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
git clone git@github.com:seregatipich/squad-admin-panel.git
cd squad-admin-panel

sudo ./scripts/bootstrap.sh
```

Manual path:

```bash
git clone git@github.com:seregatipich/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Fill APP_DOMAIN, PANEL_PUBLIC_URL, POSTGRES_PASSWORD,
# APP_ENCRYPTION_KEY and SESSION_SECRET
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

Для отката единого входа верните предыдущий image панели и прежний UI, не
меняя общий секрет сайта. Уже отозванные одноразовой командой сессии не
восстанавливаются; это единственная необратимая часть перехода.

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

The full-stack version of this procedure is scripted in [`scripts/test-fullstack-down-v.sh`](../../scripts/test-fullstack-down-v.sh): it brings the **whole** compose stack up, seeds a canary, snapshots, runs the literal `down -v`, restores with `scripts/restore.sh --apply`, then asserts the api `/health` endpoint returns 200 (panel operational) and the seeded Postgres row + Redis key survived. It is **run-deferred** — the destructive whole-stack cycle exceeds the standard hosted runner's 2 vCPU / 8 GB / 14 GB envelope (see #219) — so it is **not** wired into CI and refuses to run unless explicitly opted in on a scratch host with Docker and ample RAM:

```bash
RUN_FULLSTACK_DOWN_V=1 bash scripts/test-fullstack-down-v.sh
```

## See also

- [`setup.md`](./setup.md) — initial host setup including first-owner claim.
- [`environment-variables.md`](./environment-variables.md) — full `.env` reference.
- [`migrations.md`](./migrations.md) — database migration workflow.
- [`monitoring.md`](./monitoring.md) — observability and diagnostics.
- [`docs/components/bridge/README.md`](../components/bridge/README.md) — bridge daemon details.
