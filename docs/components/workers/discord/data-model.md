# worker-discord — Data model

Read-only. The worker writes nothing to Postgres.

| Table | Used by | For |
|---|---|---|
| `discord_webhooks` | `sender.ts` | Which webhook receives which event type; the URL is AES-256-GCM encrypted at rest |
| `discord_message_templates` | `sender.ts` | Stored embed template per event type, falling back to the packaged default |
| `servers` | `sender.ts`, `status-channel.ts` | Server display name for the embed; `status_channel_id` and `deleted_at` to find the status-channel rename targets |
| `discord_integration` | `role-sync.ts`, `status-channel-loop.ts` (via `loadDiscordBotContext`) | Guild id + encrypted bot token (DISCORD-5), shared by role sync and the status channel |
| `discord_role_mappings` | `role-sync.ts` | Panel role → Discord role, `enabled` only (DISCORD-5) |
| `player_discord_links` | `role-sync.ts` | Player → Discord user id (DISCORD-4) |
| `players` | `role-sync.ts`, `status-channel.ts` | The player's current `role_id` (role sync); `steam_id64` joined to `roles` for the `👮N` admin count (status channel) |
| `roles` | `status-channel.ts` | `panel_access` (plus the system `Owner` role) — which players count toward the status channel's admin count |

## Redis

| Key / stream | Direction | Meaning |
|---|---|---|
| `events:global`, `events:server:*` | read (group `discord-notify:v1`) | Event envelopes to deliver as embeds |
| `discord:role-sync` | read (group `discord-role-sync:v1`) | Role-sync requests published by the API |
| `discord:role-sync:status` | write | Last role-sync outcome, read back by `GET /api/v1/integrations/discord/role-mappings` |
| `rcon:status:{serverId}` | read | `worker-rcon`'s cached server status (map, player count, queue) the status channel renders into its name |
| `rcon:roster:{serverId}` | read | `worker-rcon`'s cached player roster the status channel uses to count online admins |
| `discord:status-channel:{channelId}` | read/write | Per-channel rename budget: last applied name plus the timestamps of renames inside the current ten-minute window (`STATUS_CHANNEL_RENAME_WINDOW_MS`) |
| `worker:heartbeat:discord` | write | Liveness |
