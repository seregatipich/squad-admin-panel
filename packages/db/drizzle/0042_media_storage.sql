-- VIDEO-1 (#157): media storage — media_files table + can_manage_media role flag.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS can_manage_media boolean NOT NULL DEFAULT false;
UPDATE roles SET can_manage_media = true WHERE name = 'Owner';

CREATE TABLE IF NOT EXISTS media_files (
  id                    uuid        PRIMARY KEY,
  uploader_player_id    uuid        REFERENCES players(id) ON DELETE SET NULL,
  kind                  text        NOT NULL,
  original_filename     text        NOT NULL,
  mime_type             text        NOT NULL,
  size_bytes            bigint      NOT NULL,
  sha256                text        NOT NULL,
  storage_path          text,
  external_url          text,
  title                 text,
  description           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT media_files_kind_check CHECK (kind IN ('video', 'image', 'external_link')),
  CONSTRAINT media_files_exactly_one_location_check CHECK (
    (storage_path IS NOT NULL AND external_url IS NULL) OR
    (storage_path IS NULL AND external_url IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_files_sha256_idx ON media_files (sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_files_uploader_idx ON media_files (uploader_player_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_files_created_at_idx ON media_files (created_at);
