# Environment variables

`.env` is bind-mounted read-only into the compose stack. Source: [`.env.example`](../../.env.example).

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `APP_VERSION` | production release | `dev` | api | Точный SHA production-выпуска: deploy-workflow передаёт его в `scripts/deploy-tk104.sh`, тот записывает его в `.env.tk104`, а `/health` возвращает для приёмки. | no |
| `PANEL_IMAGE_TAG` | tk104 | — | compose.tk104.yml | Тег образов `squad-panel/{api,web,workers,caddy-tk104}`, которые запускает `compose.tk104.yml` (обычно SHA выпуска). Deploy-workflow передаёт его в `scripts/deploy-tk104.sh`, после успешного выпуска тот записывает его в `.env.tk104`, чтобы обычные `docker compose --env-file .env.tk104 …` находили образы. Без значения compose останавливается с `PANEL_IMAGE_TAG_is_required`. | no |
| `APP_DOMAIN` | yes | `admin.localhost` | all | FQDN under which Caddy serves the panel. | no |
| `PANEL_PUBLIC_URL` | yes | — | api | Full public URL of the panel (e.g. `https://panel.example`). Used as `openid.return_to` / `openid.realm` base for Steam OpenID; must be an HTTPS origin in production. | no |
| `TLS_ISSUER` | yes | `internal` | all | `internal` (Caddy self-signed for dev) or `acme` (Let's Encrypt). | no |
| `ACME_EMAIL` | only if `TLS_ISSUER=acme` | `admin@example.com` | all | Contact email used by Let's Encrypt. | no |
| `DUCKDNS_TOKEN` | only for tk104 | — | caddy (tk104) | DuckDNS API token for DNS-01 TLS (`compose.tk104.yml` / `docker/Caddyfile.tk104`) when port 80 is not forwarded. | yes |
| `POSTGRES_PASSWORD` | yes | — | all | Password for the `admin` Postgres role. Generate with `openssl rand -base64 32`. | yes |
| `APP_ENCRYPTION_KEY` | yes | — | all | 32-byte base64 AES-256-GCM key. Decrypts `server_credentials.*_encrypted`. **Losing it is unrecoverable.** | yes |
| `SESSION_SECRET` | yes | — | all | Cookie-signing secret. Rotation invalidates existing sessions. | yes |
| `BALANCER_WEBHOOK_SECRET` | no | — | api | Enables the signed team-balancer endpoint the SquadJS exporter pushes dry-run proposal snapshots to. Leave unset to disable the endpoint (it then returns 503). | yes |
| `DATABASE_URL` | yes | `postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin` | all | Defaults are fine inside compose. | yes |
| `REDIS_URL` | yes | `redis://redis:6379` | all | Defaults are fine inside compose. | no |
| `SIDECAR_REDIS_URL` | no | `redis://127.0.0.1:6379` | api | Redis URL passed to the per-server RNSquadJS sidecar as `REDIS_URL`. The sidecar container runs with `--network host`, so the compose service name `redis` does not resolve there — this must be a host-reachable address. | no |
| `BRIDGE_SOCKET` | yes | `/run/panel-host-bridge/bridge.sock` | all | Path to the bridge unix socket inside containers. | no |
| `PANEL_GID` | yes | `987` | compose / bridge clients | Primary GID used by bridge-consuming containers. Must equal the host `panel` group GID; `scripts/install-host-bridge.sh` and `scripts/bootstrap.sh` update it in `.env`. | no |
| `DATA_DIR` | yes | `./data` | compose volumes / bridge | Host data tree used by bind-mounted volumes and `PANEL_DEPOT_HOST_PATH`. The host bridge installer provisions this tree, synchronizes `.env`, and must match the `DATA_DIR` in the systemd drop-in. | no |
| `STEAM_API_KEY` | no | — | api / worker-steam-refresh | Steam Web API key for persona/avatar enrichment and background snapshots. Get from https://steamcommunity.com/dev/apikey. Without it, player names fall back to `Player <last 4 of steam_id64>` and the refresh worker remains healthy but disabled. | yes |
| `STEAM_REFRESH_INTERVAL_MS` | no | `3600000` | worker-steam-refresh | Delay between background Steam refresh sweeps. Each sweep selects at most 100 never-checked or seven-day-stale players; without `STEAM_API_KEY` the worker stays healthy and performs no requests. | no |
| `SESSION_TTL_SECONDS` | no | `21600` (6 h) | api | Sliding session lifetime in seconds. | no |
| `SESSION_TOUCH_THROTTLE_SECONDS` | no | `60` | api | Minimum interval between DB session-touch writes per session (Redis `SETNX session-touch:{id}`). | no |
| `GLITCHTIP_DSN` | optional | — | all | Sentry-compatible error reporting. | yes |
| `GLITCHTIP_SECRET_KEY` | optional | — | all | GlitchTip server-side ingest. | yes |
| `RESTIC_REPOSITORY` | optional | — | all | Where the (post-P0) backup worker writes snapshots. | no |
| `RESTIC_PASSWORD` | optional | — | all | Restic encryption passphrase. | yes |
| `LOG_LEVEL` | no | `info` | api / workers | `pino` log level. | no |
| `NODE_ENV` | no | `production` | api / web / workers | `production` disables pretty logs. Swagger UI is registered at `/api/docs` for API smoke checks. | no |

## Production hardening

- Set `TLS_ISSUER=acme` and a real `APP_DOMAIN` + `ACME_EMAIL`.
- Store `.env` outside the working tree; symlink or bind-mount.
- For multi-host or compliance-sensitive deployments, encrypt the file with SOPS+age and decrypt inside the deploy pipeline.

## Generating secrets

```bash
openssl rand -base64 32     # POSTGRES_PASSWORD, SESSION_SECRET
openssl rand -base64 32     # APP_ENCRYPTION_KEY (then save offline)
```

`APP_ENCRYPTION_KEY` rotation:

1. Generate a new key.
2. Run the rotate script (P1+; in P0 this is manual SQL — see [`components/api/troubleshooting.md`](../components/api/troubleshooting.md)).
3. The new key has `key_version + 1`; old encrypted blobs are rewritten in place.
