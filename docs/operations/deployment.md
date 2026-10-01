# Deployment

Single-host deployment model. The entire panel stack runs via `docker compose up -d` on one Linux machine. The Go host bridge runs outside Docker as a systemd service.

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12.
- Docker Engine 24+ with Compose v2 (`docker compose version`).
- Go 1.25.13+ if building the bridge locally (binary can also be pre-built in CI).
- ~50 GB free disk for the `squad-depot` volume.
- `sudo` access on the host.

The `scripts/install-host-bridge.sh` script handles all one-time host setup. Run it before starting the stack. If `.env` already exists, the installer synchronizes `DATA_DIR` and `PANEL_GID` so compose bind mounts and bridge peer checks match the host.

## dev stand

The development stand (its origin is `vars.STAND_URL` of the `stand` environment) is not production:
every push to `dev` runs there within minutes, **without tests** — `ci` verifies
the code only once `dev` is fast-forwarded to `master` (see [`deploy.md`](../development/deploy.md)). A broken
stand is fixed forward on `dev` or rolled back (below).

[`docker/compose.stand.yml`](../../docker/compose.stand.yml) is a standalone compose file for
the host — it does not extend `docker/compose.yml`. It mirrors the same service
topology (api/web/caddy + all workers + bridge socket mount on `api`/workers that
need it), adapted to the stand host's Caddy DNS-01 Caddyfile and named-volume storage
instead of `${DATA_DIR}`-bind-mounted volumes for postgres/redis/caddy. Keep the
two files in sync by hand when the bridge-facing env/volumes on a worker change in
`docker/compose.yml`. The host's secrets live in `.env.stand` (from
`.env.example`, `chmod 600`), which additionally needs `PANEL_GID` and `DATA_DIR`
set to match the host's `panel` group and the data tree created by
`install-host-bridge.sh`.

A push builds nothing on the stand host. The panel services run the images the deploy
workflow pushed to GHCR, pinned by digest; `scripts/deploy-stand.sh`
records them in `.release.env` next to the compose file (the release before it in
`.release.prev.env`). Every compose command on the host therefore reads both env
files, which needs Compose 2.17+ (the stand host runs 2.40; the deploy refuses an older
one before changing anything):

```bash
cd ~/apps/squad-admin-panel
docker compose --env-file .env.stand --env-file .release.env -f docker/compose.stand.yml ps
```

### How a push reaches the stand host

1. **Build.** [`deploy.yml`](../../.github/workflows/deploy.yml) builds
   the `api`, `web`, `workers` and `caddy` targets of
   [`docker/docker-bake.hcl`](../../docker/docker-bake.hcl) in parallel on GitHub-hosted runners
   and pushes them as `ghcr.io/seregatipich/squad-panel-<image>:<sha>`, with a
   registry layer cache in `…:buildcache`. Pushes that only touch Markdown or
   `docs/` do not deploy.
2. **Hand-over.** The `deploy` job (environment `stand`) resolves the four
   digests and runs one SSH command with a key that can do nothing else:

   ```bash
   ssh "$STAND_SSH_TARGET" \
     "deploy <40-hex sha> api=sha256:<digest> web=sha256:<digest> workers=sha256:<digest> caddy=sha256:<digest>"
   ```

3. **Entry.** sshd runs the key's forced command, `~/bin/panel-deploy` — the
   installed copy of [`scripts/deploy-entry.sh`](../../scripts/deploy-entry.sh).
   It refuses anything but exactly that request (exit 2, before git, rsync or
   Docker run), fetches the commit from the public repository into
   `~/apps/squad-admin-panel-src` (`--depth=1`, detached), rsyncs it into
   `~/apps/squad-admin-panel` — leaving `.env*`, `.release*`, `data`, `.git`,
   `node_modules`, `.next` and `dist` alone on the host — and runs that commit's
   `scripts/deploy-stand.sh` with the images
   `ghcr.io/seregatipich/squad-panel-<image>@sha256:<digest>`.
4. **Deploy.** [`scripts/deploy-stand.sh`](../../scripts/deploy-stand.sh) compares
   the release with `.release.env` and touches only what differs:

   | Differs from the running release | What the deploy does |
   |---|---|
   | nothing — same image digests, migrations, Caddyfile, compose file and `.env.stand` | records the commit and exits before any Docker call |
   | an image digest | pulls that image, unless the host already has it |
   | `packages/db/drizzle` | `pg_dump -Fc` into `~/backups/panel-<UTC time>-<12-hex sha>.dump` (mode `0600`; the newest 5 are kept), then `compose run --rm migrator`; a failed dump or migration stops the deploy before any app container is replaced |
   | `docker/Caddyfile.stand` | recreates `caddy` (compose sees the file's hash as `CADDYFILE_SHA`) |
   | `docker/compose.stand.yml`, `.env.stand` | compose recreates the services whose configuration changed |

   It then runs `compose up -d --remove-orphans`, polls every recreated service
   each second until it is running and, where it has a healthcheck (`api`, `web`,
   `postgres`, `redis`), healthy — `HEALTH_TIMEOUT`, default 180 s — probes
   `$STAND_URL/health` through Caddy on `127.0.0.1` until it
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
comes from that commit, so the key is still a secret of the `stand`
environment, whose deployment branch policy admits `dev` alone.

### Rollback

Redeploy an earlier commit from GitHub — the usual way back:

```bash
gh workflow run deploy.yml --ref dev -f sha=<40-hex sha on dev>
```

The workflow refuses a commit that is not on `dev`, reuses its images from GHCR
(every deployed SHA stays there), and the host deploys that commit's tree and
images like any push. The deploy script comes from that commit too, so only
commits from this deploy model onward can be deployed this way: an older one
stops before touching a container, leaving its tree in the app directory until
the next deploy syncs a newer one. Migrations are never undone: when the older commit has
fewer migrations, its `packages/db/drizzle` differs from the recorded one, so the
deploy takes a backup and runs the migrator, which applies nothing because the
database is already ahead. That is why every migration must stay compatible with
the release before it (see [`deploy.md`](../development/deploy.md)).

On the host, without GitHub — the release before the running one:

```bash
cd ~/apps/squad-admin-panel && bash scripts/rollback-stand.sh
```

[`scripts/rollback-stand.sh`](../../scripts/rollback-stand.sh) hands the images
recorded in `.release.prev.env` to `deploy-stand.sh`, which pulls any the host
already pruned, recreates only what differs, and swaps the two release files —
running it twice returns to where you started. The panel's «очистить docker» (Prune Docker)
action (`POST /api/v1/host/docker-prune`) does not remove them: every release
image carries `LABEL panel.preserve=true`, which the prune filters out. The compose file, the Caddyfile
and the schema stay those of the synced tree, and the next push to `dev`
replaces the rollback.

Residual risk: a host-side `system prune -a` (the bridge `SystemPrune` RPC) also
removes the previous release's `api`/`web`/`workers` images, because only the
locally built `--pull never` images carry `panel.preserve=true`. Rollback
still works, since those images stay in GHCR and `deploy-stand.sh` re-pulls
them, but it needs registry access from the host.

Only when a migration itself destroyed data, restore the dump taken before it
(this overwrites the whole database; stop the api and workers first):

```bash
docker compose --env-file .env.stand --env-file .release.env -f docker/compose.stand.yml \
  exec -T postgres pg_restore -U admin -d admin --clean --if-exists \
  < ~/backups/panel-<UTC time>-<12-hex sha>.dump
```

### One-time setup

**On the stand host** (Docker with Compose 2.17+, `git`, `rsync`, `curl`, and
`~/apps/squad-admin-panel/.env.stand` in place — besides the secrets it names the
stand itself: `APP_DOMAIN=<host name>` and `PANEL_PUBLIC_URL=https://<host name>`,
which compose, Caddy and the deploy's health probe all read):

1. Install the forced command from the tip of `dev`. The same checkout is the
   one every deploy fetches into:

   ```bash
   git init -q ~/apps/squad-admin-panel-src
   git -C ~/apps/squad-admin-panel-src fetch -q --depth=1 \
     https://github.com/seregatipich/squad-admin-panel.git dev
   git -C ~/apps/squad-admin-panel-src checkout -q --detach FETCH_HEAD
   install -D -m 0755 ~/apps/squad-admin-panel-src/scripts/deploy-entry.sh ~/bin/panel-deploy
   ```

   A deploy never updates the installed copy: the gate changes only when someone
   reinstalls it. When a deploy warns that `~/bin/panel-deploy` differs from
   `scripts/deploy-entry.sh`, review the change and reinstall it with the
   `install` line above (the checkout then holds the deployed commit).

2. Generate the deploy key on a workstation, not on the stand host:

   ```bash
   ssh-keygen -t ed25519 -N '' -C deploy -f ./stand_deploy
   ```

   and bind its public half to the forced command with one line in the stand host's
   `~/.ssh/authorized_keys`:

   ```text
   restrict,command="$HOME/bin/panel-deploy" ssh-ed25519 AAAA… deploy
   ```

   `restrict` turns off terminal allocation, `~/.ssh/rc` and port, agent and X11
   forwarding; `command=`
   makes sshd run `panel-deploy` whatever the client asked for and pass the
   request in `SSH_ORIGINAL_COMMAND`. Remove the line of any older, unrestricted
   deploy key. A shell request must now be refused:

   ```bash
   ssh -i ./stand_deploy "$STAND_SSH_TARGET" uptime   # refused: expected 'deploy <40-hex sha> …', exit 2
   ```

**On GitHub:**

1. Create the environment `stand` (Settings → Environments) with the
   deployment branch policy *Selected branches* → `dev`, its variables:
   - `STAND_SSH_TARGET` — `user@host` the deploy logs in as;
   - `STAND_URL` — the stand's public origin, `https://<host name>`;

   and its secrets:
   - `STAND_SSH_KEY` — the private half, `./stand_deploy`; delete the local file
     afterwards.
   - `STAND_SSH_KNOWN_HOSTS` — the `known_hosts` line(s) for the stand's host (the part of `STAND_SSH_TARGET` after `@`).
     Compare the fingerprint with one read over an independent trusted channel
     (for example `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host
     console) before saving it. The workflow never scans host keys at run time and
     connects with `StrictHostKeyChecking=yes`; when the host key is rotated,
     verify the new fingerprint the same way, then replace the secret.
2. Make the four GHCR packages public once the first `build` run has pushed them:
   for each of `squad-panel-api`, `squad-panel-web`, `squad-panel-workers` and
   `squad-panel-caddy`, open the package → *Package settings* → *Change
   visibility* → *Public*. the stand host pulls anonymously and holds no registry
   credential, so the very first deploy fails at its pull until then; re-run it
   afterwards, and check with `docker logout ghcr.io` and a `docker pull` there.

**Moving a host from the image-artifact deploy:** the first new deploy finds no
`.release.env`, so it pulls all four images, backs up the database, runs the
migrator (a no-op on an up-to-date schema) and recreates every panel service.
After it is green, delete `.release`, `.release.prev` and the `PANEL_IMAGE_TAG=` /
`APP_VERSION=` lines the old deploy appended to `.env.stand` (nothing reads them;
`.release.env` wins for `APP_VERSION`), and remove the images it loaded — but
keep `squad-panel/depot-init` and `squad-panel/rnsquadjs`, which the bridge runs:

```bash
for image in api web workers caddy; do
  docker image ls -q "squad-panel/${image}" | xargs -r docker image rm
done
```

The self-hosted `stand-deploy` runner and the `production` environment are no
longer used; unregister the runner and delete the environment with its secrets.

Contracts: `scripts/deploy-stand.test.ts`, `scripts/deploy-entry.test.ts`, `scripts/rebuild.test.ts`,
`scripts/restore.test.ts` and `scripts/uninstall.test.ts` (part of `pnpm test:scripts`) and
`apps/api/test/compose-stand-*.test.ts`.

## Sign-in with Steam

The panel verifies the Steam identity itself through Steam OpenID:
`/api/v1/auth/steam/login` sends the user to steamcommunity.com, and
`/api/v1/auth/steam/callback` validates the response, creates a session and grants permissions according to the
panel's RBAC. The realm and the return URL are built from `PANEL_PUBLIC_URL`, so in
production it must be an HTTPS origin (`https://<APP_DOMAIN>`); otherwise the API
does not start. The first player to sign in becomes Owner and goes through `/setup`.

### bss.games integration removed

Until 2026-09-16, sign-in went through bss.games SSO, and the site's store granted VIP through a
signed webhook `/api/v1/integrations/vip/*` with a strict revision mode.
Migration `0115_remove_bss_integration` removes the triggers and functions of this mode,
the `vip_lifecycle_events` table, the columns `players.role_lifecycle_event_id` and
`panel_meta.vip_lifecycle_strict`, revokes the site's API token and deactivates the
`BSS VIP` tier. The roles and expiry dates of VIPs already purchased stay with the players; from then on they are removed by
`worker-role-expirer`. After the first release, delete these keys from `.env.stand`:
`BSS_*` and `VIP_LIFECYCLE_*`, and from Actions secrets, `BSS_SSO_SHARED_SECRET` and
`PANEL_READ_API_TOKEN`: nothing reads them any more.

**Rollback through 0115 is impossible (#50).** The migration dropped the columns and the table in the
same release (commit `10134844`) that removed them from the Drizzle schema, not in a release
later. Any release before `10134844` selects `players.role_lifecycle_event_id` and
`panel_meta.vip_lifecycle_strict` in every `SELECT` on these tables, so
after `rollback-stand.sh` or `deploy.yml -f sha=<old sha>` to such a release
almost every API request fails with `column … does not exist`. Do not roll back
below `10134844`. If you still need to, first restore the dump taken by the
deploy before 0115 (see "Only when a migration itself destroyed data" above):
it is also the only source of the `vip_lifecycle_events` history, which 0115
dropped without an archive.

## CI/CD runners

Everything runs on GitHub-hosted VMs; there is no self-hosted runner:

```yaml
# .github/workflows/ci.yml — every job
runs-on: ubuntu-24.04
# .github/workflows/deploy.yml — every job; the deploy job binds `environment: stand`
runs-on: ubuntu-24.04
```

- **`ci` verifies `master`.** It runs for pushes to `master` — the fast-forward
  promotion from `dev` — and explicit dispatches (`gh workflow run ci.yml --ref dev`
  checks a `dev` commit before promoting it), never for `pull_request`. Superseded
  runs are cancelled. The jobs and their gates are described in
  [`ci.yml`](../../.github/workflows/ci.yml) itself.
- **`deploy` deploys `dev`.** It runs for pushes to `dev` and dispatches
  (rollback), builds on hosted runners and reaches the stand host only through the forced
  command above. The deploy key lives only in the `stand` environment, whose
  branch policy admits `dev` alone, and a deploy already in flight is never
  cancelled. Every job is skipped outside `seregatipich/squad-admin-panel`, so a
  fork never tries to deploy, and every referenced action is SHA-pinned — this
  workflow writes the deploy key to disk (#248). Workflows from outside
  collaborators require approval (repository setting), because a fork's pull
  request can carry its own workflow file.

The repository is public on a personal account: hosted minutes are free and
runner groups do not exist. `scripts/test-ci-runner-strategy.sh` fails CI if a job
leaves the hosted image, the deploy leaves the `stand` environment, or any
workflow selects a runner group or a self-hosted runner.

## Container topology

| Service | Image | Notes |
|---|---|---|
| `caddy` | `caddy:2-alpine@sha256:…` | TLS termination + reverse proxy. Ports 80 + 443. `/metrics` and `/ready` answer 404 here. |
| `api` | `docker/api.Dockerfile` | Fastify 5, port 3000 (internal only). |
| `web` | `docker/web.Dockerfile` | Next.js 15 SSR, internal only, proxied by Caddy. |
| `migrator` | `docker/api.Dockerfile` | One-shot: runs Drizzle migrations then exits. |
| `postgres` | `postgres:16-alpine@sha256:…` | Port 5432, bound to `127.0.0.1` only. |
| `redis` | `redis:7-alpine@sha256:…` | Port 6379, bound to `127.0.0.1` only. Append-only persistence (the stand too). Password required (`REDIS_PASSWORD`); the sidecars use the restricted ACL user `rnsquadjs` (`REDIS_SIDECAR_PASSWORD`). |
| `worker-log-ingest` | `docker/worker.Dockerfile` | Tails squad container logs via bridge, writes events to Redis Streams. |
| `worker-rcon` | `docker/worker.Dockerfile` | `--network host`. RCON poller (ListPlayers every 30 s). |
| `worker-config-sync` | `docker/worker.Dockerfile` | Consumes Admins.cfg sync events and writes managed role/group segments. |
| `worker-audit-archiver` | `docker/worker.Dockerfile` | Cold-archives `audit_log` rows older than 90 days. |
| `worker-event-partition` | `docker/worker.Dockerfile` | Monthly Postgres partition rotation. |
| `worker-role-expirer` | `docker/worker.Dockerfile` | Clears expired player roles and enqueues Admins.cfg sync. |
| `worker-seed-reward` | `docker/worker.Dockerfile` | Grants or revokes the configured seed reward role from rolling 30-day presence. |
| `worker-metrics-sampler` | `docker/worker.Dockerfile` | Samples `host_metrics` via bridge every 15 s, writes to `host:metrics` stream. |
| `worker-media-publisher` | `docker/worker.Dockerfile` | Publishes queued media to YouTube/Telegram. Shares the `media_data` volume with `api`; inert until `YOUTUBE_*`/`TELEGRAM_*` are set. |
| `backup` (optional) | `docker/restic.Dockerfile` (`mazzolino/restic:1.8.2@sha256:…`) | Profile `backup`. Daily restic snapshot of logical postgres + redis dumps. Defined in both compose files. |

Every third-party image — in the compose files and in every Dockerfile `FROM` — is pinned by digest, and the stand's Caddy DuckDNS module by version (#47). Dependabot's `docker` and `docker-compose` ecosystems propose the bumps; `apps/api/test/compose-hardening.test.ts` fails on an unpinned image.

### Container hardening

Every panel container (`caddy`, `migrator`, `api`, `web`, all workers) runs with `cap_drop: [ALL]` and `no-new-privileges` (the `x-hardening` fragment of both compose files); `postgres`, `redis` and `backup` get `no-new-privileges` only, since their entrypoints start as root and drop to their own user. Capabilities come back only where a service needs one: `caddy` gets `NET_BIND_SERVICE`, `api` gets `CHOWN` (it hands the RNSquadJS sidecar config to uid 1001). The `web`, `api` and `worker` images declare `USER node`, so `web`, the migrator and every worker without a reason otherwise run unprivileged. The bridge-consuming workers run as `1000:${PANEL_GID}` — the bridge checks only the primary GID. Uid 0 (still without capabilities) is left to the `api`, which writes the root-owned `/run/squad-panel/rnsquadjs` tree and the media volume, `worker-media-publisher`, which deletes the media files the api wrote, and `worker-diag-flush`, which reads the host journal.

Every panel container also runs with `read_only: true` and an in-memory `tmpfs` at `/tmp` (the same `x-hardening` fragment); `web` adds a tmpfs at `/app/apps/web/.next/cache` owned by uid 1000 for the Next.js cache. The services only write to their volumes and bind mounts (checked with `docker diff` on the stand), so nothing else needs to be writable. `postgres`, `redis` and `backup` keep a writable root filesystem (`apps/api/test/compose-hardening.test.ts` pins this list).

Resource limits are sized from the usage measured on the stand after two days of uptime (api 88 MiB, web 120 MiB, caddy 45 MiB, redis 126 MiB, postgres 1.0 GiB, workers 20-50 MiB and `worker-diag-flush` 116 MiB, CPU 0-6 %), with generous headroom: workers `mem_limit: 512m` / `cpus: 1.0` (the `x-worker-limits` fragment), `api` and `web` `1g` / `2.0`, `caddy` `256m`, `postgres` `4g` (no CPU limit), `redis` `1g`. Redis also starts with `--maxmemory 768mb --maxmemory-policy noeviction`: a full Redis rejects writes instead of silently evicting stream entries, and requirepass, the `rnsquadjs` ACL user and the AOF are unchanged. To change a limit, edit the value in both `docker/compose.yml` and `docker/compose.stand.yml` (the contract test asserts them), then redeploy; a service that is killed with exit code 137 and `OOMKilled: true` in `docker inspect` needs a higher `mem_limit`.

### Database roles

The schema belongs to `admin`, the superuser the postgres image creates, and only the `migrator` and `worker-event-partition` (which creates and drops partitions) connect as it. With `PANEL_DB_USER` and `PANEL_DB_PASSWORD` set, the migrator provisions that login on every run ([`packages/db/src/app-role.ts`](../../packages/db/src/app-role.ts)): no SUPERUSER/CREATEDB/CREATEROLE, owns no table, DML on the application tables, only `SELECT`/`INSERT` on `audit_log` and `config_versions`, and default privileges for tables later migrations create. The `api` and the other workers then connect as it, so neither SQL injection nor code execution in them can switch the append-only triggers off, change the schema or run `COPY … TO PROGRAM`. `scripts/bootstrap.sh` sets both for new installs. On an existing install or the stand, add both to `.env` / `.env.stand` and run the migrator once **before** the services restart (`docker compose run --rm migrator`; on the stand the deploy runs it only when `packages/db/drizzle` changed). Leaving them blank keeps every service on `admin`.

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
| `backup_dump` | `${DATA_DIR}/backup-dump` | Logical dumps the backup service snapshots; `restore.sh` stages restored dumps under `restore/`. |
| `media_data` | `${DATA_DIR}/media` | Uploaded media shared by `api` and `worker-media-publisher`. |
| `squad-depot` | `${DATA_DIR}/depot` | Steam-fetched Squad game files (~45 GB). Populated once by `depot_update`. Created by `install-host-bridge.sh` and re-created with the same bind by `rebuild.sh`, never implicitly by Docker. |

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
# Generate secrets: openssl rand -base64 32 (POSTGRES_PASSWORD must be URL-safe: openssl rand -base64 24 | tr -d '/+=' | head -c 32)
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
docker compose exec api wget -qO- http://localhost:3000/ready
curl -skI https://${APP_DOMAIN}/api/docs
```

Expected results:

- `verify-bridge.sh` exits `0`: the read-only probes succeed and the path and image allowlist probes are refused with `forbidden` (it is a smoke test, not per-method coverage — that lives in the `apps/bridge` Go tests).
- `/health` returns `{"status":"ok", ...}`.
- `/ready` (operator-only: Caddy answers it with 404, so query it on the compose network) returns HTTP 200 with `status:"ok"` and `checks.postgres`, `checks.redis`, `checks.bridge` equal to `ok`.
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

The stack is defined in `docker/compose.yml`; `COMPOSE_FILE=docker/compose.yml` in
`.env` lets the plain `docker compose` commands below find it from the repository
root. An install whose `.env` predates that line needs it added once before the first
update after the move (the scripts under `scripts/` set it themselves). The compose
file pins the project name `squad-admin-panel`; an install that lives in a directory
with another name ran under that directory's name, so set
`COMPOSE_PROJECT_NAME=<that directory name>` in `.env` as well, or `up` would start a
second copy of the stack next to the running one.

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

To roll back the unified sign-in, restore the previous panel image and the previous UI, without
changing the site's shared secret. Sessions already revoked by the one-off command are
not restored; this is the only irreversible part of the transition.

## Verifying a deployment

```bash
sg panel -c 'bash scripts/verify-bridge.sh'   # bridge RPC smoke test
curl -sk https://${APP_DOMAIN}/health          # {"status":"ok"}
docker compose exec api wget -qO- http://localhost:3000/ready   # {"status":"ok","checks":{"postgres":"ok","redis":"ok","bridge":"ok"}}
curl -skI https://${APP_DOMAIN}/api/docs        # API docs UI responds
```

The `/ready` endpoint returns 503 if any dependency is unhealthy. It reports only `ok`/`fail` per check; the reason is in the api log (`readiness check failed`). It is not reachable through Caddy (#47): every request costs a Postgres query, a Redis PING and a bridge RPC.

## Backup (optional)

Enable the `backup` profile:

```bash
docker compose --profile backup up -d backup
```

Requires `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` in `.env`. Snapshots are taken daily at 03:00 UTC. Retention: 7 daily, 4 weekly, 6 monthly.

`docker/compose.yml` has no fallback for `RESTIC_PASSWORD` any more: while it is empty, every `docker compose` command against the file fails (#47) — the repository holds full database dumps. Generate one with `openssl rand -hex 32` (`scripts/bootstrap.sh` does). A repository initialised while the old `changeme` fallback was in effect still opens only with `changeme`; rotate it: set `RESTIC_PASSWORD=changeme` in `.env`, run `docker compose --profile backup run --rm --entrypoint restic backup key passwd` (it prompts for the new password), then put the new password in `.env`. The stand's `backup` service in `docker/compose.stand.yml` is the same service with the same staging tree under `${DATA_DIR}`; there an empty `RESTIC_PASSWORD` does not block deploys, and restic refuses to run with it.
| `redis` | `redis:7-alpine@sha256:…` | Port 6379, bound to `127.0.0.1` only. Append-only persistence (the stand too). Password required (`REDIS_PASSWORD`); the sidecars use the restricted ACL user `rnsquadjs` (`REDIS_SIDECAR_PASSWORD`). |

### Disaster-recovery restore (manual)

Restore is a deliberate host operation, run with [`scripts/restore.sh`](../../scripts/restore.sh) — it is **not** automated (CI only exercises the mechanism, see below). Run a dry run first; it lists the snapshots and mutates nothing:

```bash
scripts/restore.sh                        # dry run — prints the plan and `restic snapshots`
scripts/restore.sh --apply                # destructive — overwrites live Postgres + Redis (latest)
scripts/restore.sh --apply --snapshot ID  # destructive — restore a specific restic snapshot id
```

`--apply` restores the selected snapshot (default `latest`; `--snapshot` takes a restic short/long id or `latest` and is regex-validated so it cannot smuggle arguments): it waits for `postgres` to be healthy, stages the snapshot's `admin.dump` and `dump.rdb` under `${DATA_DIR}/backup-dump/restore` and stops if either is missing — before anything live changes — then stops the running `worker-*` services, runs `pg_restore --single-transaction --exit-on-error --clean --if-exists` (a failure rolls the whole restore back instead of leaving a half-dropped schema), and reloads the Redis dataset. The workers start again when the script exits, whether it succeeded or not. The api stays up: the bridge runs the restore for the api's request and cancels it if that connection drops. The reload runs inside a one-off container of the `redis` service, so it works for the bind-mounted `${DATA_DIR}/redis` and for the stand's named volume `redisdata` alike. The live Redis files are moved aside to `/data/pre-restore` inside that volume rather than deleted, put back if loading the new dataset fails, and removed once it succeeds; the one-off load and the AOF rewrite give up after `REDIS_READY_ATTEMPTS` (600) and `REDIS_REWRITE_ATTEMPTS` (2000) polls 0.3 s apart, or as soon as that `redis-server` exits. A `pre-restore` directory left in the Redis volume by an interrupted restore blocks the next one until an operator inspects and removes it. The one-off container runs as root, so `--apply` needs no host permissions on the Redis data. Redis is loaded via a one-off `redis-server` that reads the restored `dump.rdb` and rewrites it into an AOF, because the `redis` service runs with `--appendonly yes` and would otherwise ignore a bare `dump.rdb`.

### Backup/restore from the panel UI (INFRA-8-P1)

Operators with the `host:manage` permission get a **Настройки → Бэкапы** (Settings → Backups) page (`/settings/backup`) that lists the restic snapshots, triggers a manual backup, and restores a chosen snapshot behind a strong typed confirmation (the operator must type the snapshot's short id). The API container has no docker socket, so these operations go through the Go host bridge — new RPCs `backup_snapshots` (`restic snapshots --json`), `backup_run` (`docker compose --profile backup run --rm backup backup`) and `backup_restore` (wraps `scripts/restore.sh --apply --snapshot <id>`) — behind the routes `GET/POST /api/v1/host/backups` and `POST /api/v1/host/backups/:id/restore` (audited `backup.run` / `backup.restore`).

Because the bridge shells out to `docker compose` and `scripts/restore.sh` from the panel's deploy directory, its systemd unit must name that directory, the compose file and the env files, so the RPCs inherit `RESTIC_PASSWORD` and `POSTGRES_PASSWORD` from the deploy's own env files. `scripts/install-host-bridge.sh` writes all three into its drop-in (`panel-host-bridge.service.d/install.conf`); the compose file and env files default to the base install and are overridable for the stand:

```bash
# base install (defaults)
sudo ./scripts/install-host-bridge.sh
# the stand
sudo PANEL_COMPOSE_FILE=docker/compose.stand.yml PANEL_COMPOSE_ENV_FILES=.env.stand,.release.env \
  ./scripts/install-host-bridge.sh
```

```ini
# generated drop-in — [Service]
Environment=PANEL_COMPOSE_DIR=/opt/squad-admin-panel      # the checkout that ran the installer
Environment=PANEL_COMPOSE_FILE=docker/compose.yml         # relative to PANEL_COMPOSE_DIR
Environment=PANEL_COMPOSE_ENV_FILES=.env                  # comma-separated, relative
# ProtectSystem=strict also requires the deploy dir on ReadWritePaths for the restore path.
```

Unset or non-absolute `PANEL_COMPOSE_DIR`, or a compose/env file that is absolute or escapes it, makes the backup RPCs fail closed (`forbidden`), so the UI degrades to a clear error rather than running from an unexpected directory. `backup_restore` hands the same target to `scripts/restore.sh` through `COMPOSE_FILE`, `COMPOSE_ENV_FILES` and `ENV_FILE`.

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
