ALTER TABLE servers
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by_steam_id64 bigint NULL REFERENCES players(steam_id64) ON DELETE SET NULL,
  ADD COLUMN deletion_backup_marker_id uuid NULL REFERENCES config_versions(id) ON DELETE SET NULL;

CREATE INDEX servers_deleted_at_idx ON servers(deleted_at);

DROP INDEX IF EXISTS servers_slug_key;
CREATE UNIQUE INDEX servers_slug_active_key ON servers(slug) WHERE deleted_at IS NULL;
