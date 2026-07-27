# worker-discord — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `LOG_LEVEL` | no | `info` | Pino log level | no |
| `REDIS_URL` | no | — | Without it the worker has no heartbeat and no loop | no |
| `DATABASE_URL` | no | — | Required together with `APP_ENCRYPTION_KEY`; without either the worker stays in heartbeat-only idle instead of crash-looping | yes |
| `APP_ENCRYPTION_KEY` | no | — | Base64 32-byte key used to decrypt webhook URLs and the Discord bot token | yes |
| `PANEL_PUBLIC_URL` | no | — | Used to build `{player_url}` links in embeds | no |
| `DISCORD_NOTIFY_RECLAIM_MIN_IDLE_MS` | no | `30000` | Idle time after which the notify loop reclaims an unacked entry from a dead consumer | no |
| `DISCORD_ROLE_SYNC_RECONCILE_MS` | no | `3600000` | Interval of the role-sync drift repair (DISCORD-5). `0` disables the periodic tick; the reactive stream path keeps working | no |

## Discord bot credentials

The role-sync loop needs a guild id and a bot token, both stored in the
`discord_integration` singleton row and configured through
`PUT /api/v1/integrations/discord`, not through environment variables. The bot
must hold **Manage Roles** and sit **above** every mapped role in the guild's
role hierarchy.

Until the integration row is enabled and carries both values,
`loadDiscordBotContext` returns `null` and the loop consumes requests without
touching Discord — the same degraded-idle gate `apps/api/src/lib/steam-profile.ts`
uses for a missing Steam API key. The credentials are re-read every cycle, so
finishing the setup takes effect without a restart.
