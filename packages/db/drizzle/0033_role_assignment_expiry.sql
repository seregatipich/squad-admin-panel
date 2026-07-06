-- VIPSUB-1 (#167): expiring role assignments for urgent VIP/subscription grants
ALTER TABLE players ADD COLUMN IF NOT EXISTS role_expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN IF NOT EXISTS role_comment text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS players_role_expires_at_idx
  ON players (role_expires_at)
  WHERE role_id IS NOT NULL AND role_expires_at IS NOT NULL;
