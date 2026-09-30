-- Issue #39 (audit findings #152, #153, #1325): the event journal
-- (`GET /api/v1/events`, keyset pages and the CSV export) orders by
-- (occurred_at DESC, event_id DESC), but no `events` index started with
-- occurred_at, so every page sorted all partitions. The BANNAME-3 `ruleId`
-- filter reads `payload->>'rule_id'`, and the `playerQuery` filter runs
-- `LIKE '%q%'` over both nickname columns — neither had a usable index.
--
-- Indexes on the partitioned parent cascade to every existing partition and to
-- the ones worker-event-partition creates later.
--
-- Rollback-safe: only indexes are added; the previous release's queries are
-- unchanged and simply may use them.
CREATE INDEX IF NOT EXISTS events_occurred_at_event_id_idx ON events (occurred_at DESC, event_id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_rule_id_idx ON events ((payload ->> 'rule_id')) WHERE (payload ->> 'rule_id') IS NOT NULL;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_canonical_name_normalized_trgm_idx ON players USING gin (canonical_name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_name_history_name_normalized_trgm_idx ON player_name_history USING gin (name_normalized gin_trgm_ops);
