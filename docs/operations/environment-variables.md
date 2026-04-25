# Environment variables

`.env` is bind-mounted read-only into the compose stack. Source: [`.env.example`](../../.env.example).

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `APP_DOMAIN` | yes | `admin.localhost` | all | FQDN under which Caddy serves the panel. | no |
| `TLS_ISSUER` | yes | `internal` | all | `internal` (Caddy self-signed for dev) or `acme` (Let's Encrypt). | no |
| `ACME_EMAIL` | only if `TLS_ISSUER=acme` | `admin@example.com` | all | Contact email used by Let's Encrypt. | no |
| `POSTGRES_PASSWORD` | yes | — | all | Password for the `admin` Postgres role. Generate with `openssl rand -base64 32`. | yes |
| `APP_ENCRYPTION_KEY` | yes | — | all | 32-byte base64 AES-256-GCM key. Decrypts `server_credentials.*_encrypted`, `users.totp_secret_encrypted`. **Losing it is unrecoverable.** | yes |
| `SESSION_SECRET` | yes | — | all | Cookie-signing secret. Rotation invalidates existing sessions. | yes |
| `DATABASE_URL` | yes | `postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin` | all | Defaults are fine inside compose. | yes |
| `REDIS_URL` | yes | `redis://redis:6379` | all | Defaults are fine inside compose. | no |
| `BRIDGE_SOCKET` | yes | `/run/panel-host-bridge.sock` | all | Path to the bridge unix socket inside containers. | no |
| `STEAM_API_KEY` | optional | — | all | Required to enable Steam OIDC login. | yes |
| `DISCORD_CLIENT_ID` | optional | — | all | Required to enable Discord OIDC login. | no |
| `DISCORD_CLIENT_SECRET` | optional | — | all | Required to enable Discord OIDC login. | yes |
| `GLITCHTIP_DSN` | optional | — | all | Sentry-compatible error reporting. | yes |
| `GLITCHTIP_SECRET_KEY` | optional | — | all | GlitchTip server-side ingest. | yes |
| `RESTIC_REPOSITORY` | optional | — | all | Where the (post-P0) backup worker writes snapshots. | no |
| `RESTIC_PASSWORD` | optional | — | all | Restic encryption passphrase. | yes |
| `LOG_LEVEL` | no | `info` | api / workers | `pino` log level. | no |
| `NODE_ENV` | no | `production` | api / web / workers | `production` disables Swagger UI and pretty logs. | no |

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
