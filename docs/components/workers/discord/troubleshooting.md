# worker-discord — Troubleshooting

**Container restarting:** `docker compose logs worker-discord --since 5m`.

**Heartbeat absent:** `REDIS_URL` is unset — without it the worker publishes no
`worker:heartbeat:discord` key.

**Log says "idle — DATABASE_URL/APP_ENCRYPTION_KEY unset":** all three loops
(notify, role sync, status channel) are disabled by design. Set both to enable
webhook delivery, role sync, and the status channel/slash commands.

**Roles are not being granted or revoked:**

1. Check the banner on `/settings/integrations/discord` — it renders whatever
   the worker wrote to `discord:role-sync:status`.
2. «У бота нет права Manage Roles» means Discord answered `403`. The bot needs
   the **Manage Roles** permission *and* must sit above every mapped role in the
   guild's role hierarchy — being above only some of them fails on the rest.
3. Silence with no banner usually means the integration row is not finished:
   `discord_integration` must be `enabled` and carry both `guild_id` and
   `bot_token_encrypted`, otherwise the loop consumes requests and does nothing.
4. A player with no `player_discord_links` row is a deliberate no-op, as is a
   linked player who never joined the guild (Discord answers `404`).
5. A mapping with `enabled = false` is ignored in both directions.

**A role change did not propagate:** the `XADD` is best-effort. The hourly
reconcile (`DISCORD_ROLE_SYNC_RECONCILE_MS`) repairs it; «Синхронизировать
сейчас» on the settings page runs it immediately.

**Status channel is not renaming:**

1. Confirm `discord_integration` is `enabled` and carries both `guild_id` and
   `bot_token_encrypted` — the status-channel loop shares the same
   `loadDiscordBotContext` gate as role sync (see above); without it the tick
   runs and does nothing.
2. Confirm the server has a `status_channel_id` configured — servers without
   one are skipped entirely.
3. The bot needs the **Manage Channels** permission on that channel; a missing
   permission surfaces as an `error` outcome in the worker logs
   (`discord rejected a channel rename (Missing Permissions)`).
4. Discord allows only **two renames per ten minutes per channel**. A third
   change inside the same window is deferred to the next tick rather than
   sent — check the `discord:status-channel:{channelId}` Redis key's
   `renames` timestamps if a rename seems stuck.
5. If the desired name equals the last name the worker applied, no request is
   sent at all — this is expected, not a failure.

**Slash commands do not appear in Discord:**

1. Confirm `DISCORD_APPLICATION_ID` is set — without it,
   `registerApplicationCommands` is never called.
2. Confirm the bot token still has the `applications.commands` scope; Discord
   rejects the `PUT /applications/{id}/commands` registration otherwise, logged
   as "discord slash command registration failed; will retry next tick".
3. Registration also needs the `loadDiscordBotContext` gate satisfied (guild id
   + bot token stored), since it runs inside the status-channel tick.
4. Global command registration can take Discord up to an hour to propagate to
   clients on first registration; this is a Discord-side delay, not a worker
   fault.
