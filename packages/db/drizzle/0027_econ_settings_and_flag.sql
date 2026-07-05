-- ECON-3: can_manage_economy role flag (Owner backfilled) + economy_settings singleton.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS can_manage_economy boolean NOT NULL DEFAULT false;
UPDATE roles SET can_manage_economy = true WHERE name = 'Owner';

CREATE TABLE IF NOT EXISTS economy_settings (
  id                    smallint    PRIMARY KEY DEFAULT 1,
  k_online              double precision NOT NULL DEFAULT 1,
  k_boost               double precision NOT NULL DEFAULT 2,
  k_seed                double precision NOT NULL DEFAULT 3,
  seed_threshold        integer     NOT NULL DEFAULT 40,
  economy_enabled       boolean     NOT NULL DEFAULT false,
  privilege_costs       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by_player_id  uuid        REFERENCES players(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economy_settings_singleton CHECK (id = 1),
  CONSTRAINT economy_settings_k_online_nonneg CHECK (k_online >= 0),
  CONSTRAINT economy_settings_k_boost_nonneg CHECK (k_boost >= 0),
  CONSTRAINT economy_settings_k_seed_nonneg CHECK (k_seed >= 0),
  CONSTRAINT economy_settings_seed_threshold_range CHECK (seed_threshold >= 0 AND seed_threshold <= 100)
);
INSERT INTO economy_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
