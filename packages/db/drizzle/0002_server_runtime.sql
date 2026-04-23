-- Adds the runtime column that pins every server to Docker-container
-- management. The legacy systemd-unit path was removed in the container
-- migration, so the CHECK constraint forbids any other value.

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'container';

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS container_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'servers_runtime_enum' AND conrelid = 'servers'::regclass
  ) THEN
    ALTER TABLE servers
      ADD CONSTRAINT servers_runtime_enum CHECK (runtime IN ('container'));
  END IF;
END $$;
