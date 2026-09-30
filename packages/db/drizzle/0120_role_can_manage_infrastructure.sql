-- Gate the infrastructure permission keys behind their own role flag (#36).
-- panel_access used to grant every catalogue key outside a handful of gated
-- groups, so the seeded Moderator role could restart the host bridge, delete
-- and install servers and rewrite configs/Admins.cfg. rbac.ts now withholds
-- host:manage, server:install/delete/force_stop/update, config:edit/rollback,
-- admin_group:edit, api_token:create and backup:restore unless the role has
-- can_manage_infrastructure.
--
-- Existing roles that manage the server lifecycle keep their reach: the
-- seeded Admin role ("Server lifecycle + moderation") and every role that can
-- already edit roles (it could grant itself the flag anyway). Owner is
-- all-powerful in code; the row value is informational, as in 0015.
--
-- Rollback-safe: adding a defaulted column. The previous release does not
-- read it and derives permissions exactly as before.
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS can_manage_infrastructure boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE roles
   SET can_manage_infrastructure = true
 WHERE (name = 'Owner' AND is_system_role = true)
    OR (name = 'Admin' AND is_system_role = false)
    OR can_edit_roles = true;
