# worker-discord — Troubleshooting

**Container restarting:** `docker compose logs worker-discord --since 5m`.

**Heartbeat absent:** `REDIS_URL` is unset — without it the worker publishes no
`worker:heartbeat:discord` key.

**Log says "idle — DATABASE_URL/APP_ENCRYPTION_KEY unset":** both loops are
disabled by design. Set both to enable webhook delivery and role sync.

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
