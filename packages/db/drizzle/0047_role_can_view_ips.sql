-- ALT-8 (#126): can_view_ips role flag gating player:view_ips.
-- Previously player:view_ips was auto-granted to any panel_access role; this
-- carves it out into its own opt-in flag so panel_access roles no longer see
-- player IP history by default. Existing panel_access roles are backfilled
-- to can_view_ips=true so nobody silently loses access on migration.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS can_view_ips boolean NOT NULL DEFAULT false;
UPDATE roles SET can_view_ips = true WHERE panel_access = true;
