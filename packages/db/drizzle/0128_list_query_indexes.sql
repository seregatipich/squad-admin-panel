-- Indexes for two list queries that scanned their whole table (#68).
--
-- GET /api/v1/balancer/proposals without a server/status filter orders by
-- (generated_at DESC, id DESC) and pages by that keyset (#108); the existing
-- (server_id, generated_at) and (status, generated_at) indexes cannot serve it.
--
-- GET /api/v1/ban-sources counts each source's active (not revoked) records
-- (#107); the partial index keeps that count an index-only scan instead of a
-- GROUP BY over every external_bans row ever imported.
--
-- Rollback-safe: indexes only, nothing the previous release reads changes.
CREATE INDEX IF NOT EXISTS balancer_proposals_generated_idx
  ON balancer_proposals (generated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS external_bans_active_source_idx
  ON external_bans (source_id)
  WHERE revoked_at IS NULL;
