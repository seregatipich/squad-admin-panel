-- Per-file versioning for server configs. Every PUT on
-- /api/v1/servers/:id/configs/:name appends one row here; the table is
-- append-only (matching audit_log semantics). Restore = new row with
-- the old content, never a destructive rollback.

CREATE TABLE IF NOT EXISTS config_versions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id         uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  filename          text        NOT NULL,
  content           text        NOT NULL,
  sha256            bytea       NOT NULL,
  parent_version_id uuid        REFERENCES config_versions(id),
  author_user_id    uuid        REFERENCES users(id),
  author_ip         inet,
  message           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS config_versions_server_file_time_idx
  ON config_versions(server_id, filename, created_at DESC);

CREATE INDEX IF NOT EXISTS config_versions_sha256_idx
  ON config_versions(sha256);

-- Append-only guard, modelled after audit_log.
CREATE OR REPLACE FUNCTION config_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'config_versions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS config_versions_reject_update ON config_versions;
CREATE TRIGGER config_versions_reject_update
  BEFORE UPDATE ON config_versions
  FOR EACH ROW EXECUTE FUNCTION config_versions_reject_mutation();

DROP TRIGGER IF EXISTS config_versions_reject_delete ON config_versions;
CREATE TRIGGER config_versions_reject_delete
  BEFORE DELETE ON config_versions
  FOR EACH ROW EXECUTE FUNCTION config_versions_reject_mutation();
