-- Coalesce `events_appended` NOTIFYs to one per statement (#1327).
--
-- 0116's trigger was `AFTER INSERT ... FOR EACH ROW`, so a multi-row INSERT
-- (a bulk backfill, an `INSERT ... SELECT`, a future batched writer) called
-- `pg_notify` once per row. Every transaction that calls `pg_notify` takes
-- Postgres's single global notification-queue lock at commit
-- (`PreCommit_Notify`), so those commits serialize against every other
-- commit in the database that also NOTIFYs, and the queue (capped at 8GB)
-- fills faster the more redundant notifications a burst produces.
--
-- This does not change the shape of a single-row insert (still exactly one
-- NOTIFY, matching the previous per-row behavior) — log-ingest, handleCombat
-- and worker-rcon each write one `events` row per transaction today, so their
-- commit-serialization cost is unchanged by this migration alone. What it
-- fixes is any statement that inserts many rows at once: instead of one
-- NOTIFY per row (identical (server_id, kind) payloads included), the
-- statement-level trigger reads the whole inserted set once via the
-- transition table and emits at most one NOTIFY per distinct (server_id,
-- kind) pair in it — Postgres already folds identical NOTIFY payloads raised
-- in one transaction, so this makes explicit what was previously produced
-- redundantly one row at a time.
--
-- Payload format is unchanged (`{"server_id": <uuid|null>, "kind": <text>}`),
-- so apps/api/src/plugins/events-feed.ts needs no change.
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
