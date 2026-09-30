-- Indexes for the event journal and the seeding state machine (#39, #152,
-- #153, #1324, #1325).
--
-- `GET /api/v1/events` (keyset pages and the CSV export) orders by
-- (occurred_at DESC, event_id DESC), but no `events` index started with
-- occurred_at, so every page sorted all partitions. The BANNAME-3 `ruleId`
-- filter reads `payload->>'rule_id'`, which had no usable index. The seeding
-- lookups in `accrual.ts` filter on `kind = ANY(SEEDING_EVENT_KINDS)`; no
-- existing index covers those kinds (see packages/db/sql/events-seeding-kind.sql).
--
-- Indexes on the partitioned parent cascade to every existing partition and to
-- the ones worker-event-partition creates later.
--
-- Rollback-safe: only indexes are added; the previous release's queries are
-- unchanged and simply may use them.
CREATE INDEX IF NOT EXISTS events_occurred_at_event_id_idx
  ON events (occurred_at DESC, event_id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_rule_id_idx
  ON events ((payload ->> 'rule_id'))
  WHERE (payload ->> 'rule_id') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_seeding_kind_occurred_idx
  ON events (kind, occurred_at DESC)
  INCLUDE (server_id)
  WHERE kind IN ('server.seeding_started', 'server.seeding_ended');
