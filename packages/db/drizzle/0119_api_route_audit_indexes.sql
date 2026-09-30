-- #44 API-route audit, group w3-15. Additive and rollback-safe: the previous
-- release neither creates nor depends on any of these indexes, and the data
-- fix only moves active subscriptions' billing date earlier.

-- #346: chat_messages.matched_rule_id references chat_flag_rules ON DELETE SET
-- NULL, and rule delete/disable now clears is_flagged by matched_rule_id. Both
-- scanned every chat_messages partition without this index.
CREATE INDEX IF NOT EXISTS chat_messages_matched_rule_idx
  ON chat_messages (matched_rule_id)
  WHERE matched_rule_id IS NOT NULL;
--> statement-breakpoint

-- #354: the statistics by_hour query bounds sessions by "ended after the window
-- start". Closed sessions are found through this index, open ones through
-- player_sessions_open_idx, instead of reading each server's whole history.
CREATE INDEX IF NOT EXISTS player_sessions_server_disconnected_idx
  ON player_sessions (server_id, disconnected_at)
  WHERE disconnected_at IS NOT NULL;
--> statement-breakpoint

-- #376: the votes initiator filter matches nickname substrings (LIKE '%q%'),
-- which a btree index cannot serve.
CREATE INDEX IF NOT EXISTS players_canonical_name_normalized_trgm_idx
  ON players USING gin (canonical_name_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS player_name_history_name_normalized_trgm_idx
  ON player_name_history USING gin (name_normalized gin_trgm_ops);
--> statement-breakpoint

-- #364: a subscription now renews VIP_RENEWAL_LEAD before its role expires, so
-- the minute-granularity role-expiry tick can never strip the role ahead of the
-- hourly renewal tick. Bring subscriptions created under the old rule (billing
-- date equal to, or just after, the role expiry) onto the same schedule.
UPDATE vip_subscriptions AS s
SET next_renewal_at = p.role_expires_at - interval '6 hours'
FROM players AS p, vip_tiers AS t
WHERE s.status = 'active'
  AND p.id = s.player_id
  AND t.id = s.tier_id
  AND p.role_id = t.role_id
  AND p.role_expires_at IS NOT NULL
  AND s.next_renewal_at > p.role_expires_at - interval '6 hours';
