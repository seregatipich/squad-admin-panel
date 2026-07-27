-- ISSUE-3 (#156): issue_links — структурная связь тикета трекера с сущностью
-- панели: игроком, сервером, действием модерации или медиафайлом.
-- Стратегия удаления (критерий приёмки): issue_id — ON DELETE CASCADE,
-- entity_id — полиморфный, поэтому без FK; RESTRICT на нём недостижим, и
-- разворот ссылки в GET терпимо показывает «удалённый объект».
CREATE TABLE IF NOT EXISTS issue_links (
  id           uuid        PRIMARY KEY,
  issue_id     uuid        NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  entity_type  text        NOT NULL,
  entity_id    uuid        NOT NULL,
  created_by   uuid        REFERENCES players(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issue_links_entity_type_check
    CHECK (entity_type IN ('player','server','moderation_action','media_file'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS issue_links_issue_entity_key
  ON issue_links (issue_id, entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_links_entity_idx ON issue_links (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_links_issue_idx ON issue_links (issue_id);
