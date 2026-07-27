-- VIDEO-4 (#160): media_publications — очередь внешней публикации медиа
-- (YouTube/Telegram) + singleton-настройки публикации.
--
-- Очередь = сама таблица. Воркер забирает строку условным
-- UPDATE ... SET status='uploading' WHERE status='queued'
--   AND next_attempt_at <= now() RETURNING, поэтому две реплики воркера
-- физически не могут взять одну и ту же публикацию.
--
-- Три исхода ошибки различаются намеренно:
--   * временная  — attempts++, экспоненциальный next_attempt_at, снова 'queued';
--   * квота YouTube — снова 'queued', но attempts НЕ трогаем: суточный лимит
--     не наша вина и не должен сжигать бюджет ретраев и ронять задачу в 'failed';
--   * постоянная (или исчерпанный бюджет) — 'failed'.
--
-- Секреты YouTube/Telegram живут только в окружении воркера: в этой таблице
-- ничего похожего на токен не хранится.
CREATE TABLE IF NOT EXISTS media_publications (
  id                      uuid        PRIMARY KEY,
  media_id                uuid        NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  destination             text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'queued',
  external_id             text,
  external_url            text,
  error                   text,
  attempts                integer     NOT NULL DEFAULT 0,
  next_attempt_at         timestamptz,
  requested_by_player_id  uuid        REFERENCES players(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_publications_destination_check
    CHECK (destination IN ('youtube','telegram')),
  CONSTRAINT media_publications_status_check
    CHECK (status IN ('queued','uploading','published','failed')),
  CONSTRAINT media_publications_attempts_nonneg
    CHECK (attempts >= 0)
);
--> statement-breakpoint
-- Одна публикация на направление: повторная постановка в очередь — 409, не дубль.
CREATE UNIQUE INDEX IF NOT EXISTS media_publications_media_destination_key
  ON media_publications (media_id, destination);
--> statement-breakpoint
-- Выборка воркером: WHERE status = 'queued' AND next_attempt_at <= now().
CREATE INDEX IF NOT EXISTS media_publications_due_idx
  ON media_publications (status, next_attempt_at);
--> statement-breakpoint
-- Переключатель «освободить локальный файл после публикации».
-- По умолчанию ВЫКЛЮЧЕН: первичное хранение своё (VIDEO-1), деплой не должен
-- начинать выбрасывать локальные доказательства просто потому, что фича выехала.
CREATE TABLE IF NOT EXISTS media_publish_settings (
  id                     smallint    PRIMARY KEY DEFAULT 1,
  release_local_file     boolean     NOT NULL DEFAULT false,
  updated_by_player_id   uuid        REFERENCES players(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_publish_settings_singleton CHECK (id = 1)
);
--> statement-breakpoint
INSERT INTO media_publish_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
