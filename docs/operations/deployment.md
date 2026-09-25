# Deployment

Single-host deployment model. The entire panel stack runs via `docker compose up -d` on one Linux machine. The Go host bridge runs outside Docker as a systemd service.

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12.
- Docker Engine 24+ with Compose v2 (`docker compose version`).
- Go 1.25.13+ if building the bridge locally (binary can also be pre-built in CI).
- ~50 GB free disk for the `squad-depot` volume.
- `sudo` access on the host.

The `scripts/install-host-bridge.sh` script handles all one-time host setup. Run it before starting the stack. If `.env` already exists, the installer synchronizes `DATA_DIR` and `PANEL_GID` so compose bind mounts and bridge peer checks match the host.

## tk104 dev stand

tk104 (https://tk104.duckdns.org) is the development stand, not production:
every push to `dev` runs there within minutes, **without tests** — `ci` verifies
the code only once `dev` is fast-forwarded to `master` (see `CLAUDE.md`). A broken
stand is fixed forward on `dev` or rolled back (below).

[`compose.tk104.yml`](../../compose.tk104.yml) is a standalone compose file for
the host — it does not extend `docker-compose.yml`. It mirrors the same service
topology (api/web/caddy + all workers + bridge socket mount on `api`/workers that
need it), adapted to tk104's Caddy DNS-01 Caddyfile and named-volume storage
instead of `${DATA_DIR}`-bind-mounted volumes for postgres/redis/caddy. Keep the
two files in sync by hand when the bridge-facing env/volumes on a worker change in
`docker-compose.yml`. The host's secrets live in `.env.tk104` (from
`.env.example`, `chmod 600`), which additionally needs `PANEL_GID` and `DATA_DIR`
set to match the host's `panel` group and the data tree created by
`install-host-bridge.sh`.

A push builds nothing on tk104. The panel services run the images the deploy
workflow pushed to GHCR, pinned by digest; `scripts/deploy-tk104.sh`
records them in `.release.env` next to the compose file (the release before it in
`.release.prev.env`). Every compose command on the host therefore reads both env
files, which needs Compose 2.17+ (tk104 runs 2.40; the deploy refuses an older
one before changing anything):

```bash
cd ~/apps/squad-admin-panel
docker compose --env-file .env.tk104 --env-file .release.env -f compose.tk104.yml ps
```

### How a push reaches tk104

1. **Build.** [`deploy-tk104.yml`](../../.github/workflows/deploy-tk104.yml) builds
   the `api`, `web`, `workers` and `caddy-tk104` targets of
   [`docker-bake.hcl`](../../docker-bake.hcl) in parallel on GitHub-hosted runners
   and pushes them as `ghcr.io/seregatipich/squad-panel-<image>:<sha>`, with a
   registry layer cache in `…:buildcache`. Pushes that only touch Markdown or
   `docs/` do not deploy.
2. **Hand-over.** The `deploy` job (environment `tk104-dev`) resolves the four
   digests and runs one SSH command with a key that can do nothing else:

   ```bash
   ssh seregatipich@tk104.duckdns.org \
     "deploy <40-hex sha> api=sha256:<digest> web=sha256:<digest> workers=sha256:<digest> caddy-tk104=sha256:<digest>"
   ```

3. **Entry.** sshd runs the key's forced command, `~/bin/panel-deploy` — the
   installed copy of [`scripts/tk104-deploy-entry.sh`](../../scripts/tk104-deploy-entry.sh).
   It refuses anything but exactly that request (exit 2, before git, rsync or
   Docker run), fetches the commit from the public repository into
   `~/apps/squad-admin-panel-src` (`--depth=1`, detached), rsyncs it into
   `~/apps/squad-admin-panel` — leaving `.env*`, `.release*`, `data`, `.git`,
   `node_modules`, `.next` and `dist` alone on the host — and runs that commit's
   `scripts/deploy-tk104.sh` with the images
   `ghcr.io/seregatipich/squad-panel-<image>@sha256:<digest>`.
4. **Deploy.** [`scripts/deploy-tk104.sh`](../../scripts/deploy-tk104.sh) compares
   the release with `.release.env` and touches only what differs:

   | Differs from the running release | What the deploy does |
   |---|---|
   | nothing — same image digests, migrations, Caddyfile, compose file and `.env.tk104` | records the commit and exits before any Docker call |
   | an image digest | pulls that image, unless the host already has it |
   | `packages/db/drizzle` | `pg_dump -Fc` into `~/backups/panel-<UTC time>-<12-hex sha>.dump` (the newest 5 are kept), then `compose run --rm migrator`; a failed dump or migration stops the deploy before any app container is replaced |
   | `docker/Caddyfile.tk104` | recreates `caddy` (compose sees the file's hash as `CADDYFILE_SHA`) |
   | `compose.tk104.yml`, `.env.tk104` | compose recreates the services whose configuration changed |

   It then runs `compose up -d --remove-orphans`, polls every recreated service
   each second until it is running and, where it has a healthcheck (`api`, `web`,
   `postgres`, `redis`), healthy — `HEALTH_TIMEOUT`, default 180 s — probes
   `https://tk104.duckdns.org/health` through Caddy on `127.0.0.1` until it
   answers with the expected version, prints which services it recreated, moves
   `.release.env` to `.release.prev.env` and writes the new one, and removes panel
   images other than those of the running and the previous release. A deploy that
   fails at any step keeps `.release.env` untouched, so the next one redoes
   whatever is missing.

`/health` reports `APP_VERSION`: the commit that introduced the **running api
image**. A push that leaves the api image alone does not recreate the api just to
report a new SHA, so `/health` keeps the older commit; the workflow's external
check therefore only requires `status: "ok"`. The deploy log's last line names
both the deployed commit and the reported version.

The forced command is the only thing the deploy key can run, and it only accepts
a commit GitHub serves for the public repository and image digests from the
`ghcr.io/seregatipich/squad-panel-*` repositories. The deploy script it starts
comes from that commit, so the key is still a secret of the `tk104-dev`
environment, whose deployment branch policy admits `dev` alone.

### Rollback

Redeploy an earlier commit from GitHub — the usual way back:

```bash
gh workflow run deploy-tk104.yml --ref dev -f sha=<40-hex sha on dev>
```

The workflow refuses a commit that is not on `dev`, reuses its images from GHCR
(every deployed SHA stays there), and the host deploys that commit's tree and
images like any push. Migrations are never undone: when the older commit has
fewer migrations, its `packages/db/drizzle` differs from the recorded one, so the
deploy takes a backup and runs the migrator, which applies nothing because the
database is already ahead. That is why every migration must stay compatible with
the release before it (`CLAUDE.md`).

On the host, without GitHub — the release before the running one:

```bash
cd ~/apps/squad-admin-panel && bash scripts/rollback-tk104.sh
```

[`scripts/rollback-tk104.sh`](../../scripts/rollback-tk104.sh) hands the images
recorded in `.release.prev.env` to `deploy-tk104.sh`, which pulls any the host
already pruned, recreates only what differs, and swaps the two release files —
running it twice returns to where you started. The compose file, the Caddyfile
and the schema stay those of the synced tree, and the next push to `dev`
replaces the rollback.

Only when a migration itself destroyed data, restore the dump taken before it
(this overwrites the whole database; stop the api and workers first):

```bash
docker compose --env-file .env.tk104 --env-file .release.env -f compose.tk104.yml \
  exec -T postgres pg_restore -U admin -d admin --clean --if-exists \
  < ~/backups/panel-<UTC time>-<12-hex sha>.dump
```

### One-time setup

**On tk104** (Docker with Compose 2.17+, `git`, `rsync`, `curl`, and
`~/apps/squad-admin-panel/.env.tk104` in place):

1. Install the forced command from the tip of `dev`. The same checkout is the
   one every deploy fetches into:

   ```bash
   git init -q ~/apps/squad-admin-panel-src
   git -C ~/apps/squad-admin-panel-src fetch -q --depth=1 \
     https://github.com/seregatipich/squad-admin-panel.git dev
   git -C ~/apps/squad-admin-panel-src checkout -q --detach FETCH_HEAD
   install -D -m 0755 ~/apps/squad-admin-panel-src/scripts/tk104-deploy-entry.sh ~/bin/panel-deploy
   ```

   A deploy never updates the installed copy: the gate changes only when someone
   reinstalls it. When a deploy warns that `~/bin/panel-deploy` differs from
   `scripts/tk104-deploy-entry.sh`, review the change and reinstall it with the
   `install` line above (the checkout then holds the deployed commit).

2. Generate the deploy key on a workstation, not on tk104:

   ```bash
   ssh-keygen -t ed25519 -N '' -C deploy-tk104 -f ./tk104_deploy
   ```

   and bind its public half to the forced command with one line in tk104's
   `~/.ssh/authorized_keys`:

   ```text
   restrict,command="$HOME/bin/panel-deploy" ssh-ed25519 AAAA… deploy-tk104
   ```

   `restrict` turns off terminal allocation, `~/.ssh/rc` and port, agent and X11
   forwarding; `command=`
   makes sshd run `panel-deploy` whatever the client asked for and pass the
   request in `SSH_ORIGINAL_COMMAND`. Remove the line of any older, unrestricted
   deploy key. A shell request must now be refused:

   ```bash
   ssh -i ./tk104_deploy seregatipich@tk104.duckdns.org uptime   # refused: expected 'deploy <40-hex sha> …', exit 2
   ```

**On GitHub:**

1. Create the environment `tk104-dev` (Settings → Environments) with the
   deployment branch policy *Selected branches* → `dev`, and its secrets:
   - `TK104_SSH_KEY` — the private half, `./tk104_deploy`; delete the local file
     afterwards.
   - `TK104_SSH_KNOWN_HOSTS` — the `known_hosts` line(s) for `tk104.duckdns.org`.
     Compare the fingerprint with one read over an independent trusted channel
     (for example `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host
     console) before saving it. The workflow never scans host keys at run time and
     connects with `StrictHostKeyChecking=yes`; when the host key is rotated,
     verify the new fingerprint the same way, then replace the secret.
2. Make the four GHCR packages public once the first `build` run has pushed them:
   for each of `squad-panel-api`, `squad-panel-web`, `squad-panel-workers` and
   `squad-panel-caddy-tk104`, open the package → *Package settings* → *Change
   visibility* → *Public*. tk104 pulls anonymously and holds no registry
   credential, so the very first deploy fails at its pull until then; re-run it
   afterwards, and check with `docker logout ghcr.io` and a `docker pull` there.

**Moving a host from the image-artifact deploy:** the first new deploy finds no
`.release.env`, so it pulls all four images, backs up the database, runs the
migrator (a no-op on an up-to-date schema) and recreates every panel service.
After it is green, delete `.release`, `.release.prev` and the `PANEL_IMAGE_TAG=` /
`APP_VERSION=` lines the old deploy appended to `.env.tk104` (nothing reads them;
`.release.env` wins for `APP_VERSION`), and remove the images it loaded — but
keep `squad-panel/depot-init` and `squad-panel/rnsquadjs`, which the bridge runs:

```bash
for image in api web workers caddy-tk104; do
  docker image ls -q "squad-panel/${image}" | xargs -r docker image rm
done
```

The self-hosted `tk104-deploy` runner and the `production` environment are no
longer used; unregister the runner and delete the environment with its secrets.

### Fast developer deploy (`scripts/dev-deploy-tk104.sh`)

A push to `dev` already reaches tk104 within minutes. For work that is not even
committed yet, [`scripts/dev-deploy-tk104.sh`](../../scripts/dev-deploy-tk104.sh)
rsyncs the working tree into `~/apps/squad-admin-panel/` (the same exclusions as
the entry) over your own SSH login (`TK104_SSH_TARGET`, default
`seregatipich@tk104.duckdns.org` — not the deploy key), builds one service of the
same compose project on the host through the
[`compose.tk104.build.yml`](../../compose.tk104.build.yml) override, and restarts
only that container (`up -d --no-deps`):

```bash
scripts/dev-deploy-tk104.sh              # rebuild web only (default)
scripts/dev-deploy-tk104.sh api          # rebuild api only, no migrator
scripts/dev-deploy-tk104.sh worker-rcon  # rebuild one worker container
CONFIRM_FULL_DEPLOY=deploy scripts/dev-deploy-tk104.sh full
```

The image is tagged `ghcr.io/seregatipich/squad-panel-<image>:dev-<short sha>`
(plus `-dirty` for uncommitted changes) and never pushed; `/health` reports that
stamp only for the `api` and `full` targets, where a pushed deploy reports a
40-hex commit SHA. The preview is written into `.release.env`, so the next push
to `dev` sees the difference and replaces it. It needs a release recorded on the
host already. The `full` target runs `DEPLOY_BUILD=1 scripts/deploy-tk104.sh`:
every image is built on the host and migrations from the working tree are
applied to the tk104 database (after the same backup), so it refuses to start
without `CONFIRM_FULL_DEPLOY=deploy`. Host builds compete with the game server on
tk104 for CPU.

Contracts: `scripts/operations-scripts.test.ts` (part of `pnpm test:scripts`) and
`apps/api/test/compose-tk104-*.test.ts`.

## Вход через Steam

Панель подтверждает Steam-личность сама через Steam OpenID:
`/api/v1/auth/steam/login` отправляет пользователя на steamcommunity.com, а
`/api/v1/auth/steam/callback` проверяет ответ, создаёт сессию и выдаёт права по
RBAC панели. Realm и адрес возврата строятся из `PANEL_PUBLIC_URL`, поэтому в
production он обязан быть HTTPS-origin (`https://tk104.duckdns.org`); иначе API
не стартует. Первый вошедший игрок становится Owner и проходит `/setup`.

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

Everything runs on GitHub-hosted VMs; there is no self-hosted runner:

```yaml
# .github/workflows/ci.yml — every job
runs-on: ubuntu-24.04
# .github/workflows/deploy-tk104.yml — every job; the deploy job binds `environment: tk104-dev`
runs-on: ubuntu-24.04
```

- **`ci` verifies `master`.** It runs for pushes to `master` — the fast-forward
  promotion from `dev` — and explicit dispatches (`gh workflow run ci.yml --ref dev`
  checks a `dev` commit before promoting it), never for `pull_request`. Superseded
  runs are cancelled. The jobs and their gates are described in
  [`ci.yml`](../../.github/workflows/ci.yml) itself.
- **`deploy-tk104` deploys `dev`.** It runs for pushes to `dev` and dispatches
  (rollback), builds on hosted runners and reaches tk104 only through the forced
  command above. The deploy key lives only in the `tk104-dev` environment, whose
  branch policy admits `dev` alone, and a deploy already in flight is never
  cancelled. Every job is skipped outside `seregatipich/squad-admin-panel`, so a
  fork never tries to deploy, and every referenced action is SHA-pinned — this
  workflow writes the deploy key to disk (#248). Workflows from outside
  collaborators require approval (repository setting), because a fork's pull
  request can carry its own workflow file.

The repository is public on a personal account: hosted minutes are free and
runner groups do not exist. `scripts/test-ci-runner-strategy.sh` fails CI if a job
leaves the hosted image, the deploy leaves the `tk104-dev` environment, or any
workflow selects a runner group or a self-hosted runner.

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
