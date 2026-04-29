-- diagnostic_events: per-day-partitioned, 24h retention, append-mostly,
-- DELETE/UPDATE allowed (unlike audit_log). UUID v7 PK so id is sortable.

CREATE TABLE diagnostic_events (
  id                uuid NOT NULL,
  ts                timestamptz NOT NULL,
  component         text NOT NULL,
  severity          text NOT NULL,
  kind              text NOT NULL,
  server_id         uuid NULL REFERENCES servers(id) ON DELETE SET NULL,
  actor_steam_id64  bigint NULL,
  request_id        text NULL,
  message           text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT diagnostic_events_pkey PRIMARY KEY (id, ts),
  CONSTRAINT diagnostic_events_severity_chk
    CHECK (severity IN ('debug','info','warn','error','fatal'))
) PARTITION BY RANGE (ts);

CREATE INDEX diagnostic_events_ts_idx        ON diagnostic_events (ts DESC);
CREATE INDEX diagnostic_events_server_ts_idx ON diagnostic_events (server_id, ts DESC);
CREATE INDEX diagnostic_events_kind_ts_idx   ON diagnostic_events (component, severity, ts DESC);

-- Bootstrap partitions: yesterday + today + 23 future days.
DO $$
DECLARE
  d date;
  partname text;
BEGIN
  FOR i IN -1..23 LOOP
    d := (current_date + i)::date;
    partname := 'diagnostic_events_' || to_char(d, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF diagnostic_events FOR VALUES FROM (%L) TO (%L);',
      partname, d, (d + INTERVAL '1 day')::date
    );
  END LOOP;
END$$;
