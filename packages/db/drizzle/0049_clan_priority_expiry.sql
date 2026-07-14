ALTER TABLE clans ADD COLUMN IF NOT EXISTS priority_expiry_processed boolean NOT NULL DEFAULT false;
