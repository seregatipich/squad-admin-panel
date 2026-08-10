-- LEAD-5 (#176): server_daily_stats — материализованные дневные серверные агрегаты
-- для стат-дашборда /statistics. Одна строка на (сервер, UTC-день); единственный
-- писатель — recomputeServerDailyStats(), вызываемый воркером presence-daily.
-- Таблица маленькая (≈6 серверов × 365 дней), партиционирование не требуется.
CREATE TABLE IF NOT EXISTS server_daily_stats (
  server_id      uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  day            date        NOT NULL,
  avg_online     integer     NOT NULL DEFAULT 0,
  peak_online    integer     NOT NULL DEFAULT 0,
  avg_queue      integer     NOT NULL DEFAULT 0,
  online_seconds bigint      NOT NULL DEFAULT 0,
  matches        integer     NOT NULL DEFAULT 0,
  modes          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  maps           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  new_players    integer     NOT NULL DEFAULT 0,
  chat_messages  integer     NOT NULL DEFAULT 0,
  teamkills      integer     NOT NULL DEFAULT 0,
  punishments    integer     NOT NULL DEFAULT 0,
  avg_admins     integer     NOT NULL DEFAULT 0,
  peak_admins    integer     NOT NULL DEFAULT 0,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT server_daily_stats_pkey PRIMARY KEY (server_id, day),
  CONSTRAINT server_daily_stats_nonneg_chk CHECK (
    avg_online >= 0 AND peak_online >= 0 AND avg_queue >= 0 AND online_seconds >= 0
    AND matches >= 0 AND new_players >= 0 AND chat_messages >= 0 AND teamkills >= 0
    AND punishments >= 0 AND avg_admins >= 0 AND peak_admins >= 0
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS server_daily_stats_day_idx ON server_daily_stats (day);
