# worker-automation — Troubleshooting

**Worker exits immediately at startup:** `REDIS_URL` (as of `INT-4`) and `DATABASE_URL` (as of AUTO-1) are both required — the process logs `<NAME> is required` and exits 1 if either is missing. Set them (see [configuration.md](./configuration.md)).

**An automation rule never fires:** confirm it is `enabled` and its `condition_type`'s trigger reaches this worker — `player_count` needs `rcon.players_polled` events, `player_flag` needs `player.connected`, `time_of_day` fires off any event but at most once per `automation:tod:<ruleId>` cooldown window. `chat_keyword` rules are **not** evaluated here — they fire in `@squad/worker-log-ingest`. Use `POST /api/v1/automation-rules/:id/dry-run` to test a rule's condition without executing its action, and check `GET /api/v1/automation-runs` for `skipped`/`failed` rows (e.g. a `kick`/`warn` with no resolvable target, or a global rule firing on an event with no `server_id`).

**A plugin doesn't seem to receive events it should be subscribed to:**

1. Check the plugin's manifest was registered without error — `loadPlugins` throws at startup on an invalid manifest or a duplicate id, which would prevent the worker from starting at all (check container logs for a `fatal` on boot).
2. Check `subscribedEventKinds` includes the exact `EventType` string (see `EVENT_TYPES` in `@squad/shared-types`), not a typo or an unrelated kind.
3. Check `requestedPermissions` includes `events:read` — without it, the dispatcher silently skips the plugin and logs `plugin lacks events:read permission; dispatch skipped`.
4. If the plugin receives calls but `envelope.payload` is always `null`, it's missing the `events:payload` permission.

**A plugin's handler threw or hung:** Look for `plugin handler threw; skipped` or `plugin handler timed out; skipped` in the worker's logs (includes `pluginId` and `eventId`). This is expected, isolated behavior — it does not crash the worker or affect other plugins' delivery for the same event.

**Container restarting / crash-looping:** Check logs with `docker compose logs worker-automation --since 5m`. The dispatch loop itself catches and logs per-entry and per-iteration failures without exiting; a crash points to something outside that loop (e.g. an unhandled rejection during startup, or the required-env check failing).

**Heartbeat absent from `/api/v1/health/workers`:** The worker calls `startHeartbeat` unconditionally now (Redis is required) — an absent heartbeat means the process isn't running or can't reach Redis, not a stub limitation.
