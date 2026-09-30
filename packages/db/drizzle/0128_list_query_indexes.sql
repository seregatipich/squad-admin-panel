-- Indexes for list and maintenance queries that scanned their whole table
-- (#36, #44, #68, #107, #108, #346, #354).
--
-- * chat_messages (matched_rule_id): the column references chat_flag_rules ON
--   DELETE SET NULL, and rule delete/disable clears is_flagged by
--   matched_rule_id; both scanned every partition.
-- * chat_messages (sent_at, id): the chat-flag reindex walks the table with a
--   keyset `ORDER BY sent_at, id LIMIT 500`; with only a BRIN on sent_at every
--   page re-scanned and top-N sorted the remaining range. Created on the
--   partitioned parent, so Postgres builds it on every existing partition and
--   on each partition created later. Not CONCURRENTLY: that is unsupported on a
--   partitioned table and the migrator runs inside a transaction.
-- * player_sessions (server_id, disconnected_at): the statistics by_hour query
--   bounds sessions by "ended after the window start"; open sessions are found
--   through player_sessions_open_idx.
-- * balancer_proposals (generated_at DESC, id DESC): GET
--   /api/v1/balancer/proposals without a server/status filter pages by this
--   keyset.
-- * external_bans (source_id) WHERE revoked_at IS NULL: GET /api/v1/ban-sources
--   counts each source's active records as an index-only scan.
-- * processed_events (processed_at): the table is pruned by
--   worker-event-partition on processed_at; the (group_name, processed_at)
--   index was never used by any query and is dropped.
--
-- Rollback-safe: only indexes change. The previous release never relied on
-- processed_events_group_idx, and extra indexes are invisible to it.
CREATE INDEX IF NOT EXISTS chat_messages_matched_rule_idx
  ON chat_messages (matched_rule_id)
  WHERE matched_rule_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_messages_sent_id_idx
  ON chat_messages (sent_at, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_sessions_server_disconnected_idx
  ON player_sessions (server_id, disconnected_at)
  WHERE disconnected_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS balancer_proposals_generated_idx
  ON balancer_proposals (generated_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_bans_active_source_idx
  ON external_bans (source_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS processed_events_processed_at_idx
  ON processed_events (processed_at);
--> statement-breakpoint
DROP INDEX IF EXISTS processed_events_group_idx;
