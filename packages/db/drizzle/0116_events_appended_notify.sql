-- Live event feed: every row inserted into `events` signals the API over
-- Postgres NOTIFY, so the panel's event list updates the moment an event is
-- stored instead of when someone reloads the page. Every writer (API routes,
-- log-ingest, worker-rcon, the scheduler, ban-sync, ...) goes through this one
-- trigger, so none of them has to remember to announce its insert.
--
-- Channel `events_appended` (EVENTS_APPENDED_PG_CHANNEL in @squad/shared-config);
-- payload `{"server_id": <uuid|null>, "kind": <text>}`. Postgres folds identical
-- payloads raised inside one transaction into a single notification.
--
-- Rollback-safe: the previous release neither listens on the channel nor
-- depends on the trigger's absence; a NOTIFY nobody listens to is dropped.
CREATE OR REPLACE FUNCTION events_notify_appended() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'events_appended',
    json_build_object('server_id', NEW.server_id, 'kind', NEW.kind)::text
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_events_notify_appended ON events;
--> statement-breakpoint
CREATE TRIGGER trg_events_notify_appended
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify_appended();
