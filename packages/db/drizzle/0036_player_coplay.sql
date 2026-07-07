-- ALT-3: co-play graph. Per (pair, server, UTC day) rollup of simultaneous
-- presence derived from player_sessions, plus a singleton settings row holding
-- the noise-floor thresholds applied at read time. Hand-authored (additive,
-- fully idempotent) to mirror packages/db/sql/player-coplay.sql.

CREATE TABLE IF NOT EXISTS player_coplay (
  player_a_id          uuid    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_b_id          uuid    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  server_id            uuid    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  window_start         date    NOT NULL,
  overlap_seconds      bigint  NOT NULL DEFAULT 0,
  shared_session_count integer NOT NULL DEFAULT 0,
  CONSTRAINT player_coplay_pkey
    PRIMARY KEY (player_a_id, player_b_id, server_id, window_start),
  CONSTRAINT player_coplay_order_chk CHECK (player_a_id < player_b_id),
  CONSTRAINT player_coplay_nonneg_chk
    CHECK (overlap_seconds >= 0 AND shared_session_count >= 0)
);
CREATE INDEX IF NOT EXISTS player_coplay_player_a_idx
  ON player_coplay (player_a_id, window_start);
CREATE INDEX IF NOT EXISTS player_coplay_player_b_idx
  ON player_coplay (player_b_id, window_start);

CREATE TABLE IF NOT EXISTS coplay_settings (
  id                   smallint    NOT NULL DEFAULT 1,
  min_shared_sessions  integer     NOT NULL DEFAULT 5,
  min_overlap_seconds  integer     NOT NULL DEFAULT 36000,
  updated_by_player_id uuid        REFERENCES players(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coplay_settings_pkey PRIMARY KEY (id),
  CONSTRAINT coplay_settings_singleton CHECK (id = 1),
  CONSTRAINT coplay_settings_min_shared_nonneg CHECK (min_shared_sessions >= 0),
  CONSTRAINT coplay_settings_min_overlap_nonneg CHECK (min_overlap_seconds >= 0)
);
INSERT INTO coplay_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
