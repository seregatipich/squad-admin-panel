# worker-discord — Data model

Read-only. The worker writes nothing to Postgres.

| Table | Used by | For |
|---|---|---|
| `discord_webhooks` | `sender.ts` | Which webhook receives which event type; the URL is AES-256-GCM encrypted at rest |
| `discord_message_templates` | `sender.ts` | Stored embed template per event type, falling back to the packaged default |
| `servers` | `sender.ts` | Server display name for the embed |
| `discord_integration` | `role-sync.ts` | Guild id + encrypted bot token (DISCORD-5) |
| `discord_role_mappings` | `role-sync.ts` | Panel role → Discord role, `enabled` only (DISCORD-5) |
| `player_discord_links` | `role-sync.ts` | Player → Discord user id (DISCORD-4) |
| `players` | `role-sync.ts` | The player's current `role_id` |

## Redis

| Key / stream | Direction | Meaning |
|---|---|---|
| `events:global`, `events:server:*` | read (group `discord-notify:v1`) | Event envelopes to deliver as embeds |
| `discord:role-sync` | read (group `discord-role-sync:v1`) | Role-sync requests published by the API |
| `discord:role-sync:status` | write | Last role-sync outcome, read back by `GET /api/v1/integrations/discord/role-mappings` |
| `worker:heartbeat:discord` | write | Liveness |
