CREATE TABLE IF NOT EXISTS clan_guard_settings (
  id                   smallint    NOT NULL DEFAULT 1,
  enabled              boolean     NOT NULL DEFAULT true,
  grace_period_seconds integer     NOT NULL DEFAULT 300,
  updated_by_player_id uuid        REFERENCES players(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clan_guard_settings_pkey PRIMARY KEY (id),
  CONSTRAINT clan_guard_settings_singleton CHECK (id = 1),
  CONSTRAINT clan_guard_settings_grace_period_nonneg CHECK (grace_period_seconds >= 0)
);
INSERT INTO clan_guard_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
