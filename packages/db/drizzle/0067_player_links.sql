-- ALT-2 (issue #120): durable admin verdicts on player pairs, on top of the
-- ephemeral ALT-1 candidate engine. An undirected edge with no duplicates:
-- player_a_id/player_b_id are stored in canonical order (a < b) and there is
-- no DELETE — rejecting a decision is a status update, not a row removal.
-- Hand-authored (additive, fully idempotent) to mirror 0055_alt_detection.sql.

CREATE TABLE IF NOT EXISTS player_links (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  player_a_id        uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_b_id        uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  link_type          text        NOT NULL,
  status             text        NOT NULL,
  evidence_snapshot  jsonb,
  note               text,
  created_by         uuid        REFERENCES players(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_links_pkey PRIMARY KEY (id),
  CONSTRAINT player_links_pair_order_chk CHECK (player_a_id < player_b_id),
  CONSTRAINT player_links_link_type_chk CHECK (link_type IN ('alt', 'family_share', 'same_household', 'unrelated')),
  CONSTRAINT player_links_status_chk CHECK (status IN ('confirmed', 'rejected'))
);
CREATE UNIQUE INDEX IF NOT EXISTS player_links_pair_key ON player_links (player_a_id, player_b_id);
CREATE INDEX IF NOT EXISTS player_links_player_b_idx ON player_links (player_b_id);
