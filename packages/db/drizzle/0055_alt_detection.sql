-- ALT-1: candidate-alt/twink detection engine. IP/CIDR exclusion list plus a
-- singleton settings row holding the scoring weights and confidence-band
-- thresholds applied by GET /api/v1/players/:playerId/alt-candidates.
-- Hand-authored (additive, fully idempotent) to mirror 0036_player_coplay.sql.

CREATE TABLE IF NOT EXISTS alt_ignored_ips (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  cidr       cidr        NOT NULL,
  note       text,
  created_by uuid        REFERENCES players(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alt_ignored_ips_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS alt_ignored_ips_cidr_key ON alt_ignored_ips (cidr);

CREATE TABLE IF NOT EXISTS alt_detection_settings (
  id                       smallint    NOT NULL DEFAULT 1,
  weight_shared_ip         integer     NOT NULL DEFAULT 50,
  weight_shared_name       integer     NOT NULL DEFAULT 25,
  weight_young_account     integer     NOT NULL DEFAULT 15,
  weight_steamid_proximity integer     NOT NULL DEFAULT 10,
  steamid_delta_threshold  bigint      NOT NULL DEFAULT 10000,
  medium_threshold         integer     NOT NULL DEFAULT 50,
  high_threshold           integer     NOT NULL DEFAULT 75,
  updated_by_player_id     uuid        REFERENCES players(id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alt_detection_settings_pkey PRIMARY KEY (id),
  CONSTRAINT alt_detection_settings_singleton CHECK (id = 1),
  CONSTRAINT alt_detection_settings_thresholds_chk CHECK (medium_threshold <= high_threshold)
);
INSERT INTO alt_detection_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Acceptance criteria for ALT-1 calls out an index on player_ip_history(ip)
-- so the shared-IP self-join doesn't seq-scan at 1M+ rows. It already exists
-- since 0000_init.sql (player_ip_history_ip_idx); kept here as a documented,
-- idempotent no-op tying this migration to the AC.
CREATE INDEX IF NOT EXISTS player_ip_history_ip_idx ON player_ip_history (ip);
