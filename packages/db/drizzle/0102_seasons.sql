-- LEAD-7 (#178): seasons — именованные сезоны лидербордов.
-- Сезон это произвольный именованный интервал, а не календарный год: агрегатор
-- материализует строки player_stat_periods с period_type='season' и
-- period_start = starts_at::date по явному окну [starts_at, ends_at] активного
-- сезона. Значение 'season' уже разрешено CHECK-констрейнтом
-- player_stat_periods_period_type_chk, менять ту таблицу не требуется.
--
-- seasons_one_active — частичный уникальный индекс по константному выражению:
-- он и есть ограничение «не более одного активного сезона», благодаря которому
-- агрегатор и API резолвят активный сезон простым LIMIT 1.
-- finalized замораживает сезон: агрегатор такие сезоны пропускает, поэтому
-- после финализации материализованные строки больше не меняются.
CREATE TABLE IF NOT EXISTS seasons (
  id          uuid        PRIMARY KEY,
  name        text        NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text        NOT NULL DEFAULT 'upcoming',
  finalized   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seasons_bounds_chk CHECK (ends_at > starts_at),
  CONSTRAINT seasons_status_chk CHECK (status IN ('upcoming', 'active', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS seasons_name_key ON seasons (name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS seasons_one_active ON seasons ((status)) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS seasons_status_idx ON seasons (status, starts_at);
