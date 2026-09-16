-- Remove the bss.games integration: the VIP store webhook, its writer fence
-- (0110), the site VIP binding guard (0111) and the lifecycle event log (0034,
-- 0108). Triggers go first, so none of the fence functions can veto the
-- statements that follow.
DROP TRIGGER IF EXISTS trg_players_vip_lifecycle_owner_guard ON players;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_vip_tiers_writer_fence_lock ON vip_tiers;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_roles_vip_lifecycle_safety_guard ON roles;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_vip_lifecycle_events_writer_fence_lock ON vip_lifecycle_events;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_panel_meta_vip_lifecycle_fence_lock ON panel_meta;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_panel_meta_vip_lifecycle_fence_delete ON panel_meta;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_vip_tiers_site_binding_guard ON vip_tiers;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_roles_site_vip_safety_guard ON roles;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_role_squad_permissions_site_vip_guard ON role_squad_permissions;
--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_players_vip_lifecycle_owner();
--> statement-breakpoint
DROP FUNCTION IF EXISTS lock_vip_lifecycle_writer_fence();
--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_site_vip_binding_safety();
--> statement-breakpoint

-- Players whose role came from the store keep the role and its expiry; the
-- panel's role-expirer takes over once the marker column is gone.
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_role_lifecycle_event_fk;
--> statement-breakpoint
ALTER TABLE players DROP COLUMN IF EXISTS role_lifecycle_event_id;
--> statement-breakpoint
ALTER TABLE panel_meta DROP COLUMN IF EXISTS vip_lifecycle_strict;
--> statement-breakpoint
DROP TABLE IF EXISTS vip_lifecycle_events;
--> statement-breakpoint

-- The read token the site used to check panel access no longer has a caller.
UPDATE player_api_tokens
   SET revoked_at = now()
 WHERE name = 'bss.games: проверка доступа'
   AND revoked_at IS NULL;
--> statement-breakpoint

-- Subscriptions may still reference the store tier, so it is retired rather
-- than deleted.
UPDATE vip_tiers
   SET is_active = false
 WHERE name = 'BSS VIP';
