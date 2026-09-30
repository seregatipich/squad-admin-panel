-- Coalesce `events_appended` NOTIFYs to one per statement (#1089, #1327).
--
-- 0116's trigger was `AFTER INSERT ... FOR EACH ROW`, so a multi-row INSERT
-- (a bulk backfill, an `INSERT ... SELECT`, a batched writer) called
-- `pg_notify` once per row on the combat hot path. Every transaction that
-- calls `pg_notify` takes Postgres's single global notification-queue lock at
-- commit, so those commits serialize against every other NOTIFYing commit, and
-- the queue fills faster the more redundant notifications a burst produces.
--
-- The statement-level trigger reads the whole inserted set once through the
-- transition table and announces each distinct (server_id, kind) pair once. A
-- single-row insert still produces exactly one NOTIFY.
--
-- Channel and payload (`{"server_id": <uuid|null>, "kind": <text>}`) are
-- unchanged, so apps/api/src/plugins/events-feed.ts and every listener keep
-- working.
--
-- Rollback-safe: the previous release neither listens on the channel nor
-- depends on trigger granularity; a NOTIFY nobody listens to is dropped.
CREATE OR REPLACE FUNCTION events_notify_appended() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'events_appended',
    json_build_object('server_id', r.server_id, 'kind', r.kind)::text
  )
  FROM (SELECT DISTINCT server_id, kind FROM new_rows) AS r;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_events_notify_appended ON events;
--> statement-breakpoint
CREATE TRIGGER trg_events_notify_appended
  AFTER INSERT ON events
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION events_notify_appended();
