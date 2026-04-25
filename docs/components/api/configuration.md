# `api` — configuration

## Environment variables

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | yes | — | all | Postgres URL. | yes |
| `REDIS_URL` | yes | `redis://redis:6379` | all | Redis URL. | no |
| `BRIDGE_SOCKET` | yes | `/run/panel-host-bridge.sock` | all | Path to the bridge unix socket. | no |
| `APP_DOMAIN` | yes | `admin.localhost` | all | FQDN under which Caddy serves the panel. Used for CSRF/cookie/redirect URLs. | no |
| `PANEL_PUBLIC_URL` | yes | — | all | Full public URL of the panel (e.g. `https://panel.example`). Used as the `openid.return_to` and `openid.realm` base for Steam OpenID callbacks. | no |
| `APP_ENCRYPTION_KEY` | yes | — | all | 32-byte base64. AES-256-GCM key for `server_credentials.*_encrypted` and `users.totp_secret_encrypted`. | yes |
| `SESSION_SECRET` | yes | — | all | Cookie-signing secret. | yes |
| `STEAM_API_KEY` | no | — | all | Required to enable Steam OIDC login. | yes |
| `DISCORD_CLIENT_ID` | no | — | all | Required to enable Discord OIDC login. | no |
| `DISCORD_CLIENT_SECRET` | no | — | all | Required to enable Discord OIDC login. | yes |
| `GLITCHTIP_DSN` | no | — | all | Sentry-compatible error reporting. | yes |
| `LOG_LEVEL` | no | `info` | all | `pino` log level. | no |
| `NODE_ENV` | no | `development` | all | `production` disables Swagger UI and pretty logs. | no |

## Listening port

Inside the container the API binds `0.0.0.0:3001`. Caddy proxies `/api/*` and the WebSocket upgrade routes to that port over the internal compose network.

## Plugin tunables

These are not env-driven; change in code if needed.

- `@fastify/rate-limit`: 300 req/min per `(IP, userId)`. Login is keyed on IP at 5/15 min.
- Cookie session TTL: 8 h sliding, 30 d for "remember me".
- `status-reconciler` poll interval: 4 s. Lower means faster UI feedback, more `container_inspect` load.
- Blame cache TTL in Redis: 24 h.

## See also

- [`docs/operations/environment-variables.md`](../../operations/environment-variables.md) for the full project-wide table.
