-- Issue #50 (#1073): backfill combat_events.match_uuid for historical rows.
--
-- 0131 added match_uuid and log-ingest fills it for new events, but every event
-- stored before that kept NULL, so the matchId filter and the per-match combat
-- views missed old matches. The match of an old event is recoverable the same
-- way log-ingest resolves it (resolveMatchId): the match of that server with the
-- latest started_at at or before the event that has not ended before it.
--
-- Expand-only and idempotent: it only writes the nullable column the previous
-- release never names, only for rows still NULL that fall inside a known match,
-- so a re-run changes nothing. Rows with no covering match keep NULL. The bigint
-- match_id is never written (it cannot hold a uuid), so there is nothing to
-- carry over from it; it stays in place until no deployed release selects it.
WITH resolved AS (
  SELECT
    ce.id,
    ce.occurred_at,
    (
      SELECT m.id
        FROM matches AS m
       WHERE m.server_id = ce.server_id
         AND m.started_at <= ce.occurred_at
         AND (m.ended_at IS NULL OR m.ended_at >= ce.occurred_at)
       ORDER BY m.started_at DESC
       LIMIT 1
    ) AS match_uuid
    FROM combat_events AS ce
   WHERE ce.match_uuid IS NULL
)
UPDATE combat_events AS target
   SET match_uuid = resolved.match_uuid
  FROM resolved
 WHERE target.id = resolved.id
   AND target.occurred_at = resolved.occurred_at
   AND resolved.match_uuid IS NOT NULL;
