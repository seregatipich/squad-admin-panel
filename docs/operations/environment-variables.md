# Environment variables

`.env` is bind-mounted read-only into the compose stack. Source: [`.env.example`](../../.env.example).

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `APP_DOMAIN` | yes | `admin.localhost` | all | FQDN under which Caddy serves the panel. | no |
| `PANEL_PUBLIC_URL` | yes | — | all | Full public URL of the panel (e.g. `https://panel.example`). Used as `openid.return_to` / `openid.realm` base for Steam OpenID. | no |
| `TLS_ISSUER` | yes | `internal` | all | `internal` (Caddy self-signed for dev) or `acme` (Let's Encrypt). | no |
| `ACME_EMAIL` | only if `TLS_ISSUER=acme` | `admin@example.com` | all | Contact email used by Let's Encrypt. | no |
| `DUCKDNS_TOKEN` | only for tk104 | — | caddy (tk104) | DuckDNS API token for DNS-01 TLS (`compose.tk104.yml` / `docker/Caddyfile.tk104`) when port 80 is not forwarded. | yes |
| `POSTGRES_PASSWORD` | yes | — | all | Password for the `admin` Postgres role. Generate with `openssl rand -base64 32`. | yes |
| `APP_ENCRYPTION_KEY` | yes | — | all | 32-byte base64 AES-256-GCM key. Decrypts `server_credentials.*_encrypted`. **Losing it is unrecoverable.** | yes |
| `SESSION_SECRET` | yes | — | all | Cookie-signing secret. Rotation invalidates existing sessions. | yes |
| `VIP_LIFECYCLE_WEBHOOK_SECRET` | no | — | api | Enables the signed VIP lifecycle endpoint used by `vip-user-service` to assign, extend and revoke panel roles. Leave unset to disable the endpoint. | yes |
| `DATABASE_URL` | yes | `postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin` | all | Defaults are fine inside compose. | yes |
| `REDIS_URL` | yes | `redis://redis:6379` | all | Defaults are fine inside compose. | no |
| `BRIDGE_SOCKET` | yes | `/run/panel-host-bridge/bridge.sock` | all | Path to the bridge unix socket inside containers. | no |
| `PANEL_GID` | yes | `987` | compose / bridge clients | Primary GID used by bridge-consuming containers. Must equal the host `panel` group GID; `scripts/install-host-bridge.sh` and `scripts/bootstrap.sh` update it in `.env`. | no |
| `DATA_DIR` | yes | `./data` | compose volumes / bridge | Host data tree used by bind-mounted volumes and `PANEL_DEPOT_HOST_PATH`. The host bridge installer provisions this tree, synchronizes `.env`, and must match the `DATA_DIR` in the systemd drop-in. | no |
| `STEAM_API_KEY` | no | — | api | Steam Web API key for persona/avatar enrichment. Get from https://steamcommunity.com/dev/apikey. Without it, player names fall back to `Player <last 4 of steam_id64>`. | yes |
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
