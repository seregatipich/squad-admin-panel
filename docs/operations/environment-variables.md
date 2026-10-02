# Environment variables

`.env` is bind-mounted read-only into the compose stack. Source: [`.env.example`](../../.env.example); every variable in that file has a row below. Tunables that a worker reads but `.env.example` does not list (for example `BAN_SYNC_INTERVAL_MS` or `CLAN_GUARD_INTERVAL_MS`) are documented in that worker's `configuration.md` under [`components/workers`](../components/workers/README.md).

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `APP_VERSION` | production release | `dev` | api | The exact SHA of the production release: the deploy workflow passes it to `scripts/deploy-stand.sh`, which writes it to `.env.stand`, and `/health` returns it for acceptance checks. | no |
| `PANEL_IMAGE_TAG` | the stand host | — | docker/compose.stand.yml | Tag of the `squad-panel/{api,web,workers,caddy}` images that `docker/compose.stand.yml` runs (usually the release SHA). The deploy workflow passes it to `scripts/deploy-stand.sh`, which, after a successful release, writes it to `.env.stand` so that ordinary `docker compose --env-file .env.stand …` commands find the images. Without a value, compose stops with `PANEL_IMAGE_TAG_is_required`. | no |
| `APP_DOMAIN` | yes | `admin.localhost` | all | FQDN under which Caddy serves the panel. | no |
| `PANEL_PUBLIC_URL` | yes | — | api | Full public URL of the panel (e.g. `https://panel.example`). Used as `openid.return_to` / `openid.realm` base for Steam OpenID; must be an HTTPS origin in production. | no |
| `TLS_ISSUER` | yes | `internal` | all | `internal` (Caddy self-signed for dev) or `acme` (Let's Encrypt). | no |
| `ACME_EMAIL` | only if `TLS_ISSUER=acme`; always on the stand host | — | all | Contact email used by Let's Encrypt. `docker/compose.stand.yml` always issues via ACME and fails fast with `ACME_EMAIL_is_required` when unset — `admin@example.com` is a reserved domain Let's Encrypt rejects, so no default is provided there. `scripts/deploy-stand.sh` checks both variables (and rejects an `example.com` address) before touching anything, so set a real `ACME_EMAIL` and `DUCKDNS_TOKEN` in the host's `.env.stand` before the first deploy of this release. | no |
| `DUCKDNS_TOKEN` | only for the stand host | — | caddy (the stand host) | DuckDNS API token for DNS-01 TLS (`docker/compose.stand.yml` / `docker/Caddyfile.stand`) when port 80 is not forwarded. `docker/compose.stand.yml` fails fast with `DUCKDNS_TOKEN_is_required` when unset. | yes |
| `POSTGRES_PASSWORD` | yes | — | all | Password for the `admin` Postgres role (the superuser that owns the schema). Both compose files refuse to start while it is empty. Generate with `openssl rand -base64 24 | tr -d '/+=' | head -c 32` (URL-safe: it is embedded unescaped in `DATABASE_URL`). | yes |
| `APP_ENCRYPTION_KEY` | yes | — | all | 32-byte base64 AES-256-GCM key. Decrypts `server_credentials.*_encrypted`. **Losing it is unrecoverable.** | yes |
| `SESSION_SECRET` | yes | — | all | Cookie-signing secret. Rotation invalidates existing sessions. | yes |
| `BALANCER_WEBHOOK_SECRET` | no | — | api | Enables the signed team-balancer endpoint the SquadJS exporter pushes dry-run proposal snapshots to. Leave unset to disable the endpoint (it then returns 503). | yes |
| `DATABASE_URL` | yes | `postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin` | all | Defaults are fine inside compose. | yes |
| `REDIS_PASSWORD` | yes | — | all | Password of the Redis default user, which every panel service authenticates as. Redis is published on the host loopback where the host-network game servers and sidecars can reach it, so compose refuses to start without it (#32). Embedded in `redis://` URLs: generate with `openssl rand -hex 32`. `scripts/bootstrap.sh` and `scripts/deploy-stand.sh` generate it when missing. | yes |
| `REDIS_SIDECAR_PASSWORD` | yes | — | redis / api | Password of the Redis ACL user `rnsquadjs`, the only credential the per-server RNSquadJS sidecar gets. That user may only `XADD`/`SET` its `events:server:*`, `rnsquadjs:status:*` and `worker:heartbeat:rnsquadjs:*` keys (plus `PING`/`INFO`/`QUIT`), never `session:*`. Generate with `openssl rand -hex 32`; generated when missing like `REDIS_PASSWORD`. A sidecar started before the password existed keeps its old unauthenticated URL: restart it (disable and re-enable RNSquadJS, or restart the server) to pick up the credentials. | yes |
| `REDIS_URL` | yes | `redis://:${REDIS_PASSWORD}@redis:6379` | all | Set by compose from `REDIS_PASSWORD`; set it yourself only for a process run outside compose. | yes |
| `SIDECAR_REDIS_URL` | no | `redis://rnsquadjs:${REDIS_SIDECAR_PASSWORD}@127.0.0.1:6379` | api | Redis URL passed to the per-server RNSquadJS sidecar as `REDIS_URL`; compose builds it from `REDIS_SIDECAR_PASSWORD`. The sidecar container runs with `--network host`, so the compose service name `redis` does not resolve there — this must be a host-reachable address. | yes |
| `BRIDGE_SOCKET` | yes | `/run/panel-host-bridge/bridge.sock` | all | Path to the bridge unix socket inside containers. | no |
| `PANEL_GID` | yes | `987` | compose / bridge clients | Primary GID used by bridge-consuming containers. Must equal the host `panel` group GID; `scripts/install-host-bridge.sh` and `scripts/bootstrap.sh` update it in `.env`. | no |
| `DATA_DIR` | yes | `./data` | compose volumes / bridge | Host data tree used by bind-mounted volumes and `PANEL_DEPOT_HOST_PATH`. The host bridge installer provisions this tree, synchronizes `.env`, and must match the `DATA_DIR` in the systemd drop-in. | no |
| `STEAM_API_KEY` | no | — | api / worker-steam-refresh | Steam Web API key for persona/avatar enrichment and background snapshots. Get from https://steamcommunity.com/dev/apikey. Without it, player names fall back to `Player <last 4 of steam_id64>` and the refresh worker remains healthy but disabled. | yes |
| `STEAM_REFRESH_INTERVAL_MS` | no | `3600000` | worker-steam-refresh | Delay between background Steam refresh sweeps. Each sweep selects at most 100 never-checked or seven-day-stale players; without `STEAM_API_KEY` the worker stays healthy and performs no requests. | no |
| `EXTERNAL_HOST_PRIVATE_ALLOWLIST` | no | blank | api, worker-rcon | Private LAN networks an external server's RCON host may be in. Blank allows every private range; `none` refuses them all; otherwise comma-separated addresses or CIDRs (`192.168.10.0/24,10.1.2.3`). The API answers `400 rcon_host_private_not_allowed` on save; worker-rcon also checks every resolved address on connect. Loopback, link-local and internal names are always refused. A malformed value stops startup. | no |
| `RCON_ROSTER_INTERVAL_MS` | no | `2000` | worker-rcon | Cadence of the roster refresh (`ListPlayers` + `ListSquads`) that feeds the live player list and player count. Joins/leaves also trigger an immediate refresh via log hints. | no |
| `RCON_INFO_INTERVAL_MS` | no | `5000` | worker-rcon | Cadence of the server-info refresh (`ShowServerInfo` + `ShowNextMap`): map, next layer, mode, public queue, tickrate. Match boundaries also trigger an immediate refresh. | no |
| `SESSION_TTL_SECONDS` | no | `21600` (6 h) | api | Sliding session lifetime in seconds. | no |
| `SESSION_TOUCH_THROTTLE_SECONDS` | no | `60` | api | Minimum interval between DB session-touch writes per session (Redis `SETNX session-touch:{id}`). | no |
| `GLITCHTIP_DSN` | optional | — | none | Reserved for Sentry-compatible error reporting; no service reads it yet. | yes |
| `GLITCHTIP_SECRET_KEY` | optional | — | none | Reserved for GlitchTip server-side ingest; no service reads it yet. | yes |
| `RESTIC_REPOSITORY` | optional | — | backup | Where the `backup` compose profile (restic image) writes snapshots, for example `s3:s3.amazonaws.com/my-admin-backups` or `/srv/backups`. | no |
| `RESTIC_PASSWORD` | yes (`docker/compose.yml`) | — | backup | Restic encryption passphrase. `docker/compose.yml` refuses to start while it is empty (there is no `changeme` fallback any more); the stand's backup service leaves it empty-able and restic then refuses to run. Generate with `openssl rand -hex 32`; `scripts/bootstrap.sh` does. | yes |
| `PANEL_DB_USER` / `PANEL_DB_PASSWORD` | recommended | — | migrator → api / workers | Least-privilege Postgres login (#47). When both are set, the migrator creates or updates the role on every run (no SUPERUSER, owns nothing, only SELECT/INSERT on `audit_log` and `config_versions`) and every service except `migrator` and `worker-event-partition` connects as it. Blank = everything connects as `admin`. Password: 16+ chars of `[A-Za-z0-9_-]` (`openssl rand -hex 32`). Run the migrator once after setting them. | yes |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | optional | — | api | Discord OAuth2 application for the account link (DISCORD-4). Blank = `/api/v1/auth/discord/login` answers 503. | yes (secret) |
| `DISCORD_PUBLIC_KEY` | optional | — | api | Ed25519 public key of the Discord application; verifies signed interactions. Blank = `/api/v1/integrations/discord/interactions` answers 503. | no |
| `COMPOSE_FILE` | no | `docker/compose.yml` | compose | Lets a plain `docker compose ...` in the repository root find the stack. | no |
| `COMPOSE_PROJECT_NAME` | no | `squad-admin-panel` | compose | Compose project name (containers, network, volumes). Set a distinct one in each checkout (worktree) that runs its own stack; `docker/compose.stand.yml` does not read it. | no |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | no | `80` / `443` | compose | Published Caddy host ports; override per checkout when several stacks run on one machine. | no |
| `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` | no | `5432` / `6379` | compose / `pnpm dev:app` | Published Postgres and Redis host ports; override per checkout. `pnpm dev:app` builds its `DATABASE_URL` and `REDIS_URL` from them. | no |
| `API_PORT` / `WEB_PORT` | no | `3001` / `3000` | `pnpm dev:app` | Host ports of the api and the web dev server (`.env.local` only); `API_URL` and `PANEL_PUBLIC_URL` are derived from them. | no |
| `DATABASE_POOL_MAX` | no | `16` | api / workers | Per-process postgres.js pool size (`createDatabaseClient`). Every service that opens a connection sums into the postgres `max_connections` (200 in `docker/compose*.yml`); a worker may set 2-4 to keep the budget small. | no |
| `HOST_ORPHAN_SWEEP_INTERVAL_MS` | no | `300000` | api | Interval of the sweep that removes per-server directories whose server row is gone. Minimum 60000; a value that is not a whole number >= 60000 stops the API at startup. The compose files do not forward it. | no |
| `HOST_DOCKER_PRUNE_INTERVAL_MS` | no | `86400000` | api | Interval of the `docker system prune -af` run through the bridge. Same validation and forwarding as the orphan sweep. | no |
| `GEOIP_DB_DIR` | no | — | worker-log-ingest | Host directory holding `GeoLite2-City.mmdb`, mounted read-only; resolves player connect IPs to country and city. | no |
| `MEDIA_STORAGE_DIR` | no | `./media` | api / worker-media-publisher | Base directory for uploaded media (`<dir>/<yyyy>/<mm>/<uuid>.<ext>`). Both compose files pin the api and the publisher to the shared `media_data` volume at `/var/lib/squad-panel/media`; it is not covered by the DB backup. | no |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` | no | — | worker-media-publisher | YouTube Data API v3 OAuth credentials; all three are required, otherwise the YouTube destination stays disabled and publications are deferred. Uploads are `unlisted`. | yes |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no | — | worker-media-publisher | Telegram bot credentials (the bot must be an admin of the chat); both are required, otherwise the destination stays disabled. Uploads are capped at 50 MiB. | yes |
| `MEDIA_PUBLISHER_INTERVAL_MS` / `MEDIA_PUBLISHER_BATCH_SIZE` | no | `60000` / `3` | worker-media-publisher | Poll interval and per-tick batch size. | no |
| `SEED_REWARD_INTERVAL_MS` | no | `86400000` | worker-seed-reward | Reward-role reconciliation interval. | no |
| `ROLE_EXPIRER_INTERVAL_MS` | no | `60000` | worker-role-expirer | Tick that clears expired role grants. | no |
| `ROLE_EXPIRY_REMINDER_INTERVAL_MS` | no | `86400000` | worker-role-expirer | Daily VIP expiry reminder pass. | no |
| `VIP_RENEWAL_INTERVAL_MS` | no | `3600000` | worker-role-expirer | Subscription renewal pass; charges every subscription whose `next_renewal_at` is due. | no |
| `CONFIG_DRIFT_INTERVAL_MS` | no | `300000` | worker-config-sync | Config-drift sweep: compares each non-managed config file's on-disk sha256 against its `config_versions` tip. | no |
| `ADMINS_CFG_RELAY_INTERVAL_MS` / `ADMINS_CFG_RELAY_XADD_TIMEOUT_MS` | no | `1000` / `5000` | worker-config-sync | Cadence of the Admins.cfg post-commit outbox relay and the upper bound of one `XADD`; a timed-out row stays pending for the next pass. | no |
| `LEADERBOARD_AGGREGATOR_INTERVAL_MS` | no | `900000` | worker-leaderboard-aggregator | Leaderboard recompute tick. | no |
| `LEADERBOARD_BACKFILL_MONTHS` | no | `0` | worker-leaderboard-aggregator | Calendar months of `player_stat_periods` month rows to recompute once at startup (`0` disables). | no |
| `COPLAY_FULL_REBUILD` | no | blank | worker-presence-daily | Set to `1` for a one-shot full co-play rebuild at startup. Administrative: run it with `docker compose run --rm -e COPLAY_FULL_REBUILD=1 worker-presence-daily`, not on the long-running service. | no |
| `LOG_LEVEL` | no | `info` | api / workers | `pino` log level. | no |
| `NODE_ENV` | no | `production` | api / web / workers | `production` disables pretty logs. Swagger UI is registered at `/api/docs` for API smoke checks. | no |

## Production hardening

- Set `TLS_ISSUER=acme` and a real `APP_DOMAIN` + `ACME_EMAIL`.
- Store `.env` outside the working tree; symlink or bind-mount.
- For multi-host or compliance-sensitive deployments, encrypt the file with SOPS+age and decrypt inside the deploy pipeline.

## Generating secrets

```bash
openssl rand -base64 24 | tr -d '/+=' | head -c 32   # POSTGRES_PASSWORD (URL-safe: used unescaped in DATABASE_URL)
openssl rand -base64 32     # SESSION_SECRET
openssl rand -base64 32     # APP_ENCRYPTION_KEY (then save offline)
```

`APP_ENCRYPTION_KEY` rotation:

1. Generate a new key.
2. Run the rotate script (P1+; in P0 this is manual SQL — see [`components/api/troubleshooting.md`](../components/api/troubleshooting.md)).
3. The new key has `key_version + 1`; old encrypted blobs are rewritten in place.
