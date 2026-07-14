CREATE TABLE IF NOT EXISTS banlist_publication_settings (
  id                   smallint    NOT NULL DEFAULT 1,
  enabled              boolean     NOT NULL DEFAULT false,
  publish_scope        text        NOT NULL DEFAULT 'all_active',
  updated_by_player_id uuid        REFERENCES players(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banlist_publication_settings_pkey PRIMARY KEY (id),
  CONSTRAINT banlist_publication_settings_singleton CHECK (id = 1),
  CONSTRAINT banlist_publication_settings_scope_valid CHECK (publish_scope IN ('all_active', 'permanent_only'))
);
INSERT INTO banlist_publication_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
