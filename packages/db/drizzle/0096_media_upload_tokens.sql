-- VIDEO-3 (#159): media_upload_tokens — одноразовые делегированные токены загрузки.
-- В БД хранится ТОЛЬКО sha256(raw) в hex; сырой токен показывается минтеру один раз.
-- Одноразовость обеспечивает сама БД: погашение — условный UPDATE ... WHERE
-- used_at IS NULL AND expires_at > now() RETURNING id.
CREATE TABLE IF NOT EXISTS media_upload_tokens (
  id                   uuid        PRIMARY KEY,
  token_hash           text        NOT NULL,
  issued_by_player_id  uuid        REFERENCES players(id) ON DELETE SET NULL,
  target_entity_type   text,
  target_entity_id     uuid,
  expires_at           timestamptz NOT NULL,
  used_at              timestamptz,
  max_size_bytes       bigint      NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_upload_tokens_target_type_check
    CHECK (target_entity_type IS NULL
        OR target_entity_type IN ('player','moderation_action','match','issue')),
  CONSTRAINT media_upload_tokens_target_pair_check
    CHECK ((target_entity_type IS NULL) = (target_entity_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS media_upload_tokens_token_hash_key
  ON media_upload_tokens (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_upload_tokens_expires_at_idx
  ON media_upload_tokens (expires_at);
--> statement-breakpoint
-- Провенанс анонимной загрузки: непустое значение = «загружено по ссылке, аноним»
-- (у такой строки uploader_player_id всегда NULL).
ALTER TABLE media_files
  ADD COLUMN IF NOT EXISTS upload_token_id uuid
  REFERENCES media_upload_tokens(id) ON DELETE SET NULL;
