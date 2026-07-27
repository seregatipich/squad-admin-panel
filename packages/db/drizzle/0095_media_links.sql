-- VIDEO-2 (#158): media_links — канонический полиморфный стор доказательств,
-- связывающий media_files с player / moderation_action / match / issue.
-- entity_id полиморфный, поэтому без FK; существование проверяет роут.
CREATE TABLE IF NOT EXISTS media_links (
  id                   uuid        PRIMARY KEY,
  media_id             uuid        NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  entity_type          text        NOT NULL,
  entity_id            uuid        NOT NULL,
  linked_by_player_id  uuid        REFERENCES players(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_links_entity_type_check
    CHECK (entity_type IN ('player','moderation_action','match','issue'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS media_links_media_entity_key
  ON media_links (media_id, entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_links_entity_idx ON media_links (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_links_media_idx ON media_links (media_id);
