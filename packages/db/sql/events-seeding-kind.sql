-- Partial index for the SEED-1 seeding state-machine lookups (#140, #1324).
--
-- `events_kind_occurred_idx` (0000_init.sql) is a partial index that only
-- covers 'player.connected'/'player.disconnected'/'rcon.players_polled', so
-- `accrual.ts`'s `inDaySeedingEvents`/`preDaySeedingEvents` queries, which
-- filter on `kind = ANY(SEEDING_EVENT_KINDS)`, could not use any index on
-- `kind` and fell back to scanning every `events` partition, including the
-- much larger combat/chat/rcon volume. This index gives them one to use.
--
-- Idempotent (CREATE INDEX IF NOT EXISTS) so it can be re-applied without error.
CREATE INDEX IF NOT EXISTS events_seeding_kind_occurred_idx
  ON events (kind, occurred_at DESC)
  INCLUDE (server_id)
  WHERE kind IN ('server.seeding_started', 'server.seeding_ended');
