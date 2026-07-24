-- LOG-3 (#51): per-server "archive to backup" toggle on server_settings.
-- When enabled, a rotated SquadGame*.log about to be deleted by the LOG-1
-- 10-day retention sweep (apps/bridge/internal/handlers/handlers.go
-- runSquadLogRetentionSweep) is first copied into the restic backup staging
-- tree (${DATA_DIR}/backup-dump, RESTIC_BACKUP_SOURCES=/data — see INFRA-8)
-- so the next snapshot captures it under the existing 7d/4w/6m retention.
-- Default false keeps every existing server on the current delete-only path.
-- See packages/db/src/schema/server-settings.ts.
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS archive_logs_to_backup boolean NOT NULL DEFAULT false;
