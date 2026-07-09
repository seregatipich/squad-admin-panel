-- WL-1 (#65): whitelist quick actions + CSV — panel_meta gets a single configurable
-- "whitelist role"; assigning/removing it from a player is what puts them on/off the
-- server whitelist (reuses the existing players.role_id single-role model).
ALTER TABLE panel_meta ADD COLUMN IF NOT EXISTS whitelist_role_id uuid REFERENCES roles(id) ON DELETE SET NULL;
